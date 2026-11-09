// ── helpers/playbookRoutes.js — the Playbook screen's routes ──────────────────
// Apsara, 2026-11-09 (ownership plan step 7): "the playbook screen, which shows every rule you've given so you
// can edit it."
//
// WHAT THIS DOES: list the rules, change the words of one, forget one. That is all.
// WHAT IT DOES NOT DO: change any decision. Nothing in the app reads the Playbook yet (tests/playbook.js guards that
// with ALLOWED_CALLERS), so editing a rule here changes what Jarvis would RECALL, not what it DOES. Wiring a rule
// into follow-ups, chasers or the truth check is a separate step that needs her yes.
//
// Edge METALS only, on purpose (CLAUDE.md rule 5): the partition is fixed here, the client cannot pick another.
// Admin only, like every other screen that shows her books. Who edited is the session's profile, never a client field.
const playbook = require('./playbook');
const COMPANY = 'edge_metals';
const MAX_WORDS = 1000;

function mount(app, cfg) {
    app.get('/playbook', (req, res) => {
        res.sendFile(require('path').join(cfg.ROOT, 'dashboard', 'playbook.html'));
    });

    const admin = (req, res) => {
        if (req.role !== 'admin') { res.status(403).json({ error: 'only an admin can see or change the Playbook' }); return false; }
        return true;
    };
    const part = () => require('./diskStore').getDisk().for(COMPANY);
    const who = (req) => ({ by: String(req.profile || req.role || 'admin'), role: 'manager' });
    const shape = (f) => ({ id: f.id, scope: f.scope, scopeType: f.scopeType, scopeId: f.scopeId, name: f.name,
        value: f.value, editable: typeof f.value === 'string', taughtBy: f.taughtBy, at: f.at, said: f.sourceMsg || null });

    // GET /api/playbook — every live rule, oldest first.
    app.get('/api/playbook', (req, res) => {
        if (!admin(req, res)) return;
        try {
            const rules = playbook.list(part()).map(shape);
            res.json({ company: COMPANY, count: rules.length, rules });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // POST /api/playbook/edit { id, value } — new words for one rule. Same scope and name, so it REPLACES the rule
    // (the old words stay in the disk's log). A rule whose value is not plain words cannot be edited here.
    app.post('/api/playbook/edit', (req, res) => {
        if (!admin(req, res)) return;
        try {
            const id = Number((req.body || {}).id);
            const value = String((req.body || {}).value == null ? '' : req.body.value).trim();
            if (!Number.isInteger(id)) return res.status(400).json({ error: 'which rule?' });
            if (!value) return res.status(400).json({ error: 'a rule needs words. To remove one, use Forget.' });
            if (value.length > MAX_WORDS) return res.status(400).json({ error: `keep a rule under ${MAX_WORDS} characters` });
            const p = part();
            const cur = playbook.list(p).find((f) => f.id === id);
            if (!cur) return res.status(404).json({ error: 'that rule is not in the Playbook any more' });
            if (typeof cur.value !== 'string') return res.status(400).json({ error: 'this rule is not plain words, so it cannot be edited here' });
            if (cur.value === value) return res.json({ ok: true, unchanged: true, rule: shape(cur) });
            const r = p.facts.put({ scopeType: cur.scopeType, scopeId: cur.scopeId, name: cur.name, value, ...who(req),
                sourceMsg: 'edited on the Playbook screen' });
            if (!r.ok) return res.status(400).json({ error: r.reason });
            p.snapshot();
            res.json({ ok: true, rule: shape(playbook.list(p).find((f) => f.id === r.id)) });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // POST /api/playbook/forget { id } — delete one rule. seed will not bring it back.
    app.post('/api/playbook/forget', (req, res) => {
        if (!admin(req, res)) return;
        try {
            const id = Number((req.body || {}).id);
            if (!Number.isInteger(id)) return res.status(400).json({ error: 'which rule?' });
            const p = part();
            if (!playbook.forget(p, id)) return res.status(404).json({ error: 'that rule is not in the Playbook any more' });
            p.snapshot();
            res.json({ ok: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
}

module.exports = { mount, COMPANY };
