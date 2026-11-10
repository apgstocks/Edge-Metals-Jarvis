// ── helpers/caseFileRoutes.js — read-only routes over helpers/caseFile.js ──────────────────────
// GET /api/case-files          one status per customer
// GET /api/case-files/one?customer=NAME   the full timeline
// Admin only. Nothing here writes. Edge Metals only (the ledgers it reads are Edge Metals').
function mount(app) {
    const admin = (req, res) => { if (req.role !== 'admin') { res.status(403).json({ error: 'only an admin can see case files' }); return false; } return true; };
    app.get('/api/case-files', (req, res) => {
        if (!admin(req, res)) return;
        try {
            const cases = require('./caseFile').buildAll().map(({ events, ...c }) => ({ ...c, event_count: events.length }));
            res.json({ count: cases.length, cases });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.get('/api/case-files/one', (req, res) => {
        if (!admin(req, res)) return;
        const customer = String(req.query.customer || '').trim();
        if (!customer) return res.status(400).json({ error: 'which customer?' });
        try { res.json(require('./caseFile').buildOne(customer)); } catch (e) { res.status(500).json({ error: e.message }); }
    });
}
module.exports = { mount };
