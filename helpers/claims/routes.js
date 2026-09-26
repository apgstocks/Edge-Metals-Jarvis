// ── helpers/claims/routes.js — the claims page and its API ───────────────────
//
// Mounted from api.js with one line, the same shape as
// helpers/quickbooks/routes.js and helpers/bankDocs.js, so api.js keeps its
// shape and nothing else in it moves.
//
// ACCESS. The session gate at api.js:605 already covers everything here: no
// cookie, no page. /api/claims is deliberately NOT added to
// STAFF_ALLOWED_PATH_PREFIXES — a shortage claim carries the customer's
// complaint, Edge's margin and the supplier it will be recovered from, and
// staff access is scoped to Loads. Staff therefore get the existing 403.
const path = require('path');
// NOTE ON THE PATH: `../claims` resolves to helpers/claims.js (the store), not
// to this directory. Node tries `claims.js` before `claims/index.js`, so the
// file wins over the folder. If anyone ever adds helpers/claims/index.js this
// require silently changes meaning — don't.
const claims = require('../claims');
const claimWatch = require('../../workflow/claimWatch');

const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

function mount(app, cfg) {
    // The page.
    app.get('/claims', (req, res) => res.sendFile(path.join(cfg.ROOT, 'dashboard', 'claims.html')));

    // Everything the page needs in one call — rows plus the totals, so the
    // header cannot disagree with the table below it.
    app.get('/api/claims', (req, res) => {
        try {
            const rows = claims.list();
            // typeLabels travels with the rows so the page never spells a kind
            // differently from the server. containers is the count the header
            // leads with — Apsara, 2026-09-26: "put it into website per
            // container basis", and one container can carry several claims of
            // different kinds.
            const keyOf = (c) => String(c.container_no || c.invoice_no || '—').toUpperCase();
            res.json({
                claims: rows,
                stats: { ...claims.stats(rows), containers: new Set(rows.map(keyOf)).size },
                statuses: claims.STATUSES, types: claims.TYPES,
                typeLabels: claims.TYPE_LABEL, units: claims.UNITS,
            });
        } catch (e) { bad(res, e.message, 500); }
    });

    app.get('/api/claims/:id', (req, res) => {
        const c = claims.get(req.params.id);
        return c ? res.json(c) : bad(res, 'no such claim', 404);
    });

    // Manual entry, for a claim that arrives by phone or WhatsApp rather than
    // mail. Same record, created_by says which.
    app.post('/api/claims', async (req, res) => {
        try {
            const b = req.body || {};
            if (!String(b.container_no || '').trim() && !String(b.invoice_no || '').trim()) {
                return bad(res, 'a claim needs at least a container number or an invoice number');
            }
            const rec = await claims.create(b, b.created_by || 'manual');
            await claimWatch.raiseVerifyTodo(rec);
            res.json(rec);
        } catch (e) { bad(res, e.message, 500); }
    });

    // ── VERIFY — the only route that turns a claim into a figure ────────────
    // The unit is required, by claims.verify(), and the error says so in words
    // rather than failing a validator. Confirming the weights is what cancels
    // the chase and raises the recovery to-do.
    app.post('/api/claims/:id/verify', async (req, res) => {
        try {
            const b = req.body || {};
            const rec = await claims.verify(req.params.id, {
                invoice_weight: b.invoice_weight,
                claimed_weight: b.claimed_weight,
                weight_unit: b.weight_unit,
                sell_price: b.sell_price,
                sell_price_unit: b.sell_price_unit,
            }, b.by || 'manager');
            await claimWatch.closeTodos(rec.container_no || rec.invoice_no, 'claim_verify');
            if (!rec.our_claim) await claimWatch.raiseRecoveryTodo(rec);
            res.json(rec);
        } catch (e) { bad(res, e.message); }
    });

    app.post('/api/claims/:id/recovery', async (req, res) => {
        try {
            const b = req.body || {};
            const rec = await claims.raiseRecovery(req.params.id, { our_claim: b.our_claim, note: b.note }, b.by || 'manager');
            await claimWatch.closeTodos(rec.container_no || rec.invoice_no, 'claim_recovery');
            res.json(rec);
        } catch (e) { bad(res, e.message); }
    });

    app.post('/api/claims/:id/status', async (req, res) => {
        try {
            const b = req.body || {};
            const rec = await claims.setStatus(req.params.id, b.status, b.by || 'manager', b.note);
            if (['settled', 'rejected', 'withdrawn'].includes(b.status)) {
                await claimWatch.closeTodos(rec.container_no || rec.invoice_no, 'claim_verify');
                await claimWatch.closeTodos(rec.container_no || rec.invoice_no, 'claim_recovery');
            }
            res.json(rec);
        } catch (e) { bad(res, e.message); }
    });

    app.post('/api/claims/:id/edit', async (req, res) => {
        try {
            const b = req.body || {};
            const allowed = ['customer', 'supplier', 'invoice_no', 'container_no', 'note', 'claim_type',
                'sell_price', 'sell_price_unit', 'our_claim', 'evidence', 'stated_claim_amount'];
            const patch = {};
            for (const k of allowed) if (b[k] !== undefined) patch[k] = b[k];
            if (!Object.keys(patch).length) return bad(res, 'nothing to change');
            const rec = await claims.update(req.params.id, patch, b.by || 'manager', 'edited on the claims page');
            res.json(rec);
        } catch (e) { bad(res, e.message); }
    });

    console.log('[CLAIMS] routes mounted — /claims, /api/claims');
}

module.exports = { mount };
