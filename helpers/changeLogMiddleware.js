// ── helpers/changeLogMiddleware.js — which requests go into the change log, and how ──
//
// See helpers/changeLog.js for why the log exists. This file is the WHERE: one Express middleware, mounted once in
// api.js, that watches every write request and records the ones on the list below. One hook instead of a line in
// each route, so a new yard route cannot be forgotten by its author — it is forgotten here, in one visible list,
// and tests/change-log.js walks the route files to catch exactly that.
//
// SCOPE IS THE LIST. Apsara: "Yard first". Every rule is a yard route; Edge Metals routes (bills, sales, bookings,
// documents, accounting, edge inventory) are not here on purpose, and are the next step once this is proven.
// NOT logged, deliberately:
//   · /api/load-drafts   — autosave as she types. A draft is not a record; the load's own save is logged.
//   · reads (GET)        — noise, and nothing changes.
//   · */preview          — item/party maintenance previews change nothing; their apply is logged.
//   · requests that never signed in (401) — anyone on the internet can produce those, except the sign-in itself.
//
// HOW AN ENTRY IS BUILT
//   1. before the route runs: if the rule names a record, snapshot it (a load with its payments, a bill, …);
//   2. the route runs unchanged — this file never alters a request, a response or a status;
//   3. after the response has gone ('finish'): snapshot again, diff, append. Nothing here can delay or fail a save.

const cfg = require('../config');

const loadJsonSafe = (file, dflt) => { try { return require('./json').loadJson(file, dflt); } catch (e) { return dflt; } };
const byId = (rows, id) => (Array.isArray(rows) ? rows.find((r) => r && String(r.id) === String(id)) : null) || null;

// Snapshots: the record as it stands. Each returns null when there is nothing (a delete's "after").
const SNAP = {
    load: (id) => {
        const load = require('./loads').getLoad(id);
        if (!load) return null;
        const payments = loadJsonSafe(cfg.PAYMENTS_FILE, []).filter((p) => p && String(p.load_id) === String(id));
        return { ...load, payments };
    },
    loadPayments: (id) => ({ payments: loadJsonSafe(cfg.PAYMENTS_FILE, []).filter((p) => p && String(p.load_id) === String(id)) }),
    payment: (id) => byId(loadJsonSafe(cfg.PAYMENTS_FILE, []), id),
    truckerBill: (id) => require('./truckerBills').getBill(id),
    expense: (id) => require('./expenses').getExpense(id),
    petty: (id) => byId(require('./pettyCash').listEntries(), id),
    settings: () => loadJsonSafe(cfg.SETTINGS_FILE, {}),
};

const S = '([^/]+)';
const R = (m, path, action, extra = {}) => ({ m, re: new RegExp(`^${path}$`), action, ...extra });
const RULES = [
    R('POST', '/login', 'Sign in', { login: true }),

    R('POST', '/api/loads', 'Load created', { created: (res) => res && res.load && res.load.id, snap: 'load' }),
    R('PUT', '/api/loads/next-number', 'Load numbering changed', { fixed: 'load-numbering', snap: 'settings' }),
    R('PUT', `/api/loads/${S}`, 'Load edited', { snap: 'load' }),
    R('DELETE', `/api/loads/${S}`, 'Load deleted', { snap: 'load' }),
    R('PUT', `/api/loads/${S}/renumber`, 'Load number changed'),
    R('POST', `/api/loads/${S}/signature`, 'Load signed'),
    R('POST', `/api/loads/${S}/send-to-seller`, 'Load sent to seller'),
    R('POST', `/api/loads/${S}/generate-pdf`, 'Load PDF made'),

    R('POST', '/api/payments', 'Payment recorded', { fromBody: 'load_id', snap: 'loadPayments' }),
    R('POST', '/api/payments/settle', 'Payment settled against a document', { fromBody: 'load_id' }),
    R('DELETE', `/api/payments/settle/${S}`, 'Settlement removed'),
    R('DELETE', `/api/payments/${S}`, 'Payment deleted', { snap: 'payment' }),
    R('POST', '/api/prepayments', 'Prepayment recorded', { fromBody: 'seller' }),
    R('POST', '/api/prepayments/apply', 'Prepayment applied', { fromBody: 'load_id' }),

    R('POST', '/api/trucker-bills', 'Trucker bill added', { created: (res) => res && res.bill && res.bill.id, snap: 'truckerBill' }),
    R('PUT', `/api/trucker-bills/${S}`, 'Trucker bill edited', { snap: 'truckerBill' }),
    R('DELETE', `/api/trucker-bills/${S}`, 'Trucker bill deleted', { snap: 'truckerBill' }),

    R('POST', '/api/expenses', 'Expense added', { created: (res) => res && ((res.expense && res.expense.id) || res.id), snap: 'expense' }),
    R('PUT', `/api/expenses/${S}`, 'Expense edited', { snap: 'expense' }),
    R('DELETE', `/api/expenses/${S}`, 'Expense deleted', { snap: 'expense' }),

    R('POST', '/api/petty-cash', 'Cash added to petty cash'),
    R('POST', '/api/petty-cash/transfer', 'Cash moved between companies'),
    R('DELETE', `/api/petty-cash/${S}`, 'Petty cash entry deleted', { snap: 'petty' }),

    R('POST', '/api/outbound-loads', 'Sale created'),
    R('PUT', `/api/outbound-loads/${S}`, 'Sale edited'),
    R('DELETE', `/api/outbound-loads/${S}`, 'Sale deleted'),
    R('POST', `/api/outbound-loads/${S}/delivered`, 'Sale marked delivered'),
    R('POST', `/api/outbound-loads/${S}/generate-pdf`, 'Sale PDF made'),

    R('POST', '/api/item-types', 'Item type added'),
    R('PUT', '/api/item-types', 'Item type changed'),
    R('DELETE', '/api/item-types', 'Item type removed'),
    R('POST', '/api/trade-catalog', 'Item description added'),
    R('PUT', '/api/trade-catalog', 'Item description changed'),
    R('DELETE', '/api/trade-catalog', 'Item description removed'),
    R('PUT', '/api/item-maintenance/metal', 'Item set ferrous / non-ferrous'),
    R('POST', '/api/item-maintenance/apply', 'Items renamed or merged'),
    R('POST', '/api/item-maintenance/undo', 'Item rename undone'),
    R('POST', `/api/party-maintenance/${S}/apply`, 'Supplier / buyer names merged'),
    R('POST', '/api/party-maintenance/undo', 'Supplier / buyer rename undone'),
    R('PUT', '/api/settings', 'Settings changed', { fixed: 'settings', snap: 'settings' }),
    R('POST', '/api/pricelist/send-city', 'Price list sent'),

    R('POST', '/api/verify-admin-password', 'Locked load unlock attempted'),
    R('POST', '/api/yard/act', 'Scout action confirmed'),
    R('POST', '/api/yard/lessons/forget', 'Scout lesson forgotten'),

    // Customer copies only (scripts/trial-users) — harmless here, where nothing answers on these paths.
    R('POST', '/api/users', 'User added'),
    R('PUT', `/api/users/${S}`, 'User changed'),
    R('DELETE', `/api/users/${S}`, 'User deleted'),
    R('POST', '/api/roles', 'Role added'),
    R('PUT', `/api/roles/${S}`, 'Role changed'),
    R('DELETE', `/api/roles/${S}`, 'Role deleted'),
    R('POST', '/api/me/password', 'Own password changed'),
    R('POST', '/api/me/language', 'Own language changed'),
];

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ruleFor = (method, path) => RULES.find((r) => r.m === method && r.re.test(path)) || null;

function middleware() {
    return function changeLog(req, res, next) {
        let rule = null;
        try { rule = WRITE.has(req.method) ? ruleFor(req.method, req.path) : null; } catch (e) { rule = null; }
        if (!rule) return next();

        let subject = null, before;
        try {
            const m = req.path.match(rule.re);
            subject = rule.fixed || (m && m[1] ? decodeURIComponent(m[1]) : null)
                || (rule.fromBody && req.body && req.body[rule.fromBody] != null ? String(req.body[rule.fromBody]) : null);
            if (rule.snap && (subject || rule.snap === 'settings')) before = SNAP[rule.snap](subject);
        } catch (e) { before = undefined; }

        let result;
        try {
            const json = res.json.bind(res);
            res.json = (body) => { result = body; return json(body); };
        } catch (e) { /* a response we cannot watch is still sent */ }

        res.on('finish', () => {
            try {
                const status = res.statusCode, ok = status < 400;
                const body = req.body || {};
                let actor, role;
                if (rule.login) {
                    role = ok && result ? (result.profile || result.role || null) : null;
                    actor = ok && result ? (result.userId || role || 'unknown')
                        : (String(body.userId || '').trim().toLowerCase() || '(owner password)');
                    subject = actor;
                } else {
                    if (!req.role && status === 401) return;              // never signed in: not her yard's business
                    role = req.isSuper ? 'jarvis' : (req.role || null);
                    actor = req.isSuper ? 'jarvis' : (req.userId || req.role || 'unknown');
                }
                const e = { actor, role, ip: req.ip || null, method: req.method, path: req.path, action: rule.action,
                    subject, status, ok };
                if (!ok) e.error = result && (result.error || result.message) ? String(result.error || result.message) : null;

                let after;
                if (ok && rule.snap) {
                    try {
                        if (rule.created && !subject) subject = e.subject = rule.created(result) || null;
                        if (subject || rule.snap === 'settings') after = SNAP[rule.snap](subject);
                    } catch (er) { after = undefined; }
                }
                const changes = ok && before !== undefined && after !== undefined
                    ? require('./changeLog').diff(before, after) : null;
                if (changes) e.changes = changes;
                if (ok && before && after === null) e.before = before;               // a delete: what was removed
                if (ok && !before && after) e.after = after;                         // a create: what was made
                if (!changes || !changes.length) {
                    if (!rule.login && Object.keys(body).length) e.request = body;   // what was asked for
                    if (!rule.login && result !== undefined && !e.after && !e.before) e.result = result;   // never a sign-in's: it carries the session id
                }
                require('./changeLog').record(e);
            } catch (er) {
                console.error('[CHANGE-LOG] could not build an entry — the request itself was unaffected:', er.message);
            }
        });
        next();
    };
}

module.exports = { middleware, RULES, ruleFor, SNAP };
