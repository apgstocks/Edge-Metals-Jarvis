// ── helpers/interCompanyRoutes.js — recording money between her companies ──
//
// Apsara, 2026-10-09: transfers between Edge Metals, Edge Yard and AAA
// Investment are never income — "put it as loan for now".
//
// ── WHY THESE ARE NOT IN bankMatchRoutes.js ──────────────────────────────
// tests/bank-match-e2e.js section F guards a property of that file: nothing
// it serves writes money — its writes only change which rows are OFFERED.
// Recording a loan writes into two companies' books, so it lives here, in a
// file whose whole job is that one write, and the bank screen calls it.

function mount(app) {
    // Same bar as everything else that changes her books from the bank
    // screen: admin only.
    const admin = (req, res) => {
        if (req.role !== 'admin') {
            res.status(403).json({ error: 'only an admin can record a transfer between companies' });
            return false;
        }
        return true;
    };

    // ── TRANSFERS BETWEEN HER OWN COMPANIES ──────────────────────────────
    // helpers/interCompany.js has the reasoning. GET proposes, POST records
    // one as a loan (her words: "put it as loan for now"), DELETE undoes.
    app.get('/api/intercompany/transfers', (req, res) => {
        try {
            const IC = require('./interCompany');
            const from = String(req.query.from || '').slice(0, 10) || null;
            const to = String(req.query.to || '').slice(0, 10) || null;
            const within = (d) => (!from || String(d) >= from) && (!to || String(d) <= to);
            const found = IC.detect(require('./bankLedger').list());
            res.json({
                from, to,
                proposed: found.pairs.filter((p) => within(p.date)),
                one_sided: found.oneSided.filter((p) => within(p.date)),
                recorded: IC.list().filter((t) => within(t.date)),
                treatment: 'loan',
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.post('/api/intercompany/transfers', async (req, res) => {
        if (!admin(req, res)) return;
        try {
            const rec = await require('./interCompany').record(req.body || {}, { by: req.profile || req.role || null });
            res.json({ ok: true, transfer: rec });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });
    app.delete('/api/intercompany/transfers', async (req, res) => {
        if (!admin(req, res)) return;
        const id = String(((req.body || {}).id) || req.query.id || '').trim();
        if (!id) return res.status(400).json({ error: 'which transfer?' });
        try { res.json({ ok: true, undone: await require('./interCompany').undo(id, { by: req.profile || req.role || null }) }); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });

}

module.exports = { mount };
