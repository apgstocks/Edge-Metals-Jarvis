// GET /metrics (the page) and GET /api/metrics?days=30 — the daily metric lines, oldest first, plus today's live snapshot. Admin only, read-only.
function mount(app) {
    // The page is static; the numbers come from /api/metrics, which is admin only.
    app.get('/metrics', (req, res) => res.sendFile(require('path').join(require('../config').ROOT, 'dashboard', 'metrics.html')));
    app.get('/api/metrics', async (req, res) => {
        if (req.role !== 'admin') return res.status(403).json({ error: 'only an admin can see the metrics' });
        try { const m = require('./dailyMetrics'); res.json({ today: await m.snapshot(), history: m.trend({ days: req.query.days }) }); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });
}
module.exports = { mount };
