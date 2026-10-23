// routes/exportRules.js — destination import rules for scrap, and who confirmed them
//
// Apsara, 2026-10-23/24: the export-import side of a US scrap exporter, then
// "Audit and build everything".
//
// ── THESE ROUTES ANSWER. THEY DO NOT REFUSE ──────────────────────────────
// Nothing here blocks a booking, a document or a send. That is deliberate and
// it is CLAUDE.md rule 1: a refusal added to /api/invoice/send or
// POST /api/bookings would land on paths with callers I have not changed —
// including the scanned-PDF booking importer, which has no form to show a
// warning on. The over-reach pattern in that file is exactly this: a rule
// that makes sense on one screen put into code other callers reach.
//
// So the check is available, and whether a screen warns or stops is a
// separate decision with her name on it.
//
// Not on STAFF_ALLOWED_PATH_PREFIXES in api.js, so a staff-role session gets
// a 403 on all of these — which is right: a trade-compliance rule is not a
// yard scale operator's business. The write is requireAdmin on top of that.
module.exports = function (app, ctx) {
    const { requireAdmin, actorOf } = ctx;
// @@chunk-start
    const X = require('./helpers/exportRules');

    // The whole register, each rule with whether it is safe to act on. Sent
    // with the status computed server-side rather than letting the client work
    // out staleness: two implementations of "is this rule still good" is how
    // one of them quietly starts saying yes.
    app.get('/api/export-rules', (req, res) => {
        const rows = X.rules().map((r) => ({ ...r, status: X.statusOf(r) }));
        res.json({
            rules: rows,
            attention: X.needsAttention({}),
            // Said out loud in the payload so a screen cannot present this
            // register as authoritative without ignoring a field.
            disclaimer: 'A rule is trustworthy because a named person confirmed it on a '
                + 'known date, never because it was researched. Anything unconfirmed, '
                + 'disputed or lapsed reads as unknown, and unknown is not clear.',
        });
    });

    // What a given destination would be told. GET because it changes nothing.
    app.get('/api/export-check', (req, res) => {
        const port = req.query.port || req.query.port_of_discharge || '';
        const out = X.check({
            port_of_discharge: port,
            origin_country: req.query.origin || 'US',
            material: req.query.material || null,
        });
        res.json(out);
    });

    // Every booking's compliance state in one call, for a banner on the
    // bookings screen. Read-only, and it reports the PORT it read so a wrong
    // country reading is visible rather than mysterious.
    app.get('/api/export-check/bookings', (req, res) => {
        const cfg = require('./config');
        const { loadJson } = require('./helpers/json');
        let all = {};
        try { all = loadJson(cfg.BOOKINGS_FILE, {}) || {}; } catch (e) { all = {}; }
        const rows = (Array.isArray(all) ? all : Object.values(all))
            .filter((b) => b && b.booking_number)
            .map((b) => {
                const r = X.check({ port_of_discharge: b.port_of_discharge, origin_country: 'US' });
                return {
                    booking_number: b.booking_number,
                    port_of_discharge: b.port_of_discharge || null,
                    outcome: r.outcome,
                    country: r.country ? r.country.name : null,
                    reasons: r.reasons,
                    actions: r.actions,
                };
            })
            // Blocked first, then unknown — clear ones are not what she opened
            // this screen for.
            .sort((a, b) => (({ blocked: 0, unknown: 1, clear: 2 })[a.outcome]
                - ({ blocked: 0, unknown: 1, clear: 2 })[b.outcome]));
        res.json({
            rows,
            blocked: rows.filter((r) => r.outcome === 'blocked').length,
            unknown: rows.filter((r) => r.outcome === 'unknown').length,
            clear: rows.filter((r) => r.outcome === 'clear').length,
        });
    });

    // A person records that they checked a rule. The ONLY write, admin only,
    // and helpers/exportRules.verify refuses a blank or system name — so a
    // forged body cannot make Jarvis the authority for a trade rule.
    app.post('/api/export-rules/:id/verify', requireAdmin, async (req, res) => {
        const b = req.body || {};
        try {
            const out = await X.verify(req.params.id, {
                // actorOf, not a name from the body, when the caller does not
                // name somebody explicitly — the signature should be whoever
                // is logged in, not whoever typed into a field.
                by: String(b.by || actorOf(req) || '').trim(),
                on: b.on || null,
                expires_on: b.expires_on || b.until || null,
                outcome: b.outcome || null,
                requirement: b.requirement || null,
                source_url: b.source_url || null,
                source_ref: b.source_ref || null,
                clear_disputed: !!b.clear_disputed,
                note: b.note || null,
            });
            res.json(out);
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });
// @@chunk-end
    return {};
};
