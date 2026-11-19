// routes/users.js — user and role management for a Y.A.R.D. trial/product copy (copy-only, see helpers/userAccounts.js).
//
// Every route here is manager-only (requireAdmin: a Manager-role user or the owner password), EXCEPT changing your own
// password, which any signed-in user may do. The page itself (GET /users) is manager-only too, so a role that was
// never given it gets a plain 403 rather than a page that fails to load.
const path = require('path');
const UA = require('../helpers/userAccounts');
const cfg = require('../config');

module.exports = function (app, ctx) {
    const { requireAdmin } = ctx;
    const fail = (res, e) => res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong. Try again.' });
    const by = (req) => req.userId || 'owner';

    app.get('/users', requireAdmin, (req, res) => res.sendFile(path.join(cfg.ROOT, 'dashboard', 'users.html')));

    app.get('/api/users', requireAdmin, (req, res) => {
        res.json({
            users: UA.listUsers(),
            roles: UA.allRoles().map((r) => ({ id: r.id, name: r.name, builtin: !!r.builtin, manager: !!r.manager, pages: r.pages })),
            pages: UA.PAGES.map((p) => ({ id: p.id, label: p.label, note: p.note })),
            me: req.userId || null,
        });
    });
    app.post('/api/users', requireAdmin, async (req, res) => {
        try { res.json({ ok: true, user: await UA.createUser(req.body || {}, by(req)) }); } catch (e) { fail(res, e); }
    });
    app.put('/api/users/:id', requireAdmin, async (req, res) => {
        try { res.json({ ok: true, user: await UA.updateUser(req.params.id, req.body || {}, req.userId) }); } catch (e) { fail(res, e); }
    });
    app.delete('/api/users/:id', requireAdmin, (req, res) => {
        try { UA.deleteUser(req.params.id, req.userId); res.json({ ok: true }); } catch (e) { fail(res, e); }
    });

    app.post('/api/roles', requireAdmin, (req, res) => {
        try { res.json({ ok: true, role: UA.createRole(req.body || {}, by(req)) }); } catch (e) { fail(res, e); }
    });
    app.put('/api/roles/:id', requireAdmin, (req, res) => {
        try { res.json({ ok: true, role: UA.updateRole(req.params.id, req.body || {}) }); } catch (e) { fail(res, e); }
    });
    app.delete('/api/roles/:id', requireAdmin, (req, res) => {
        try { UA.deleteRole(req.params.id); res.json({ ok: true }); } catch (e) { fail(res, e); }
    });

    // Any signed-in USER (not the owner password, which has no account to change) may change their own password.
    // Under /api/me so it is inside the always-allowed paths of every role.
    app.post('/api/me/password', async (req, res) => {
        if (!req.userId) return res.status(400).json({ error: 'This sign-in is the owner password. Change it in the server settings.' });
        try { await UA.changeOwnPassword(req.userId, (req.body || {}).current, (req.body || {}).next); res.json({ ok: true }); } catch (e) { fail(res, e); }
    });
    // A person's own screen language. Owner-password sign-ins have no account, so theirs stays a per-browser choice.
    app.post('/api/me/language', (req, res) => {
        if (!req.userId) return res.status(400).json({ error: 'This sign-in has no account of its own; the language is remembered in this browser.' });
        try { UA.setLanguage(req.userId, (req.body || {}).language); res.json({ ok: true }); } catch (e) { fail(res, e); }
    });
    return {};
};
