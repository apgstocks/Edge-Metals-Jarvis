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
const claimKinds = require('../claimKinds');
const importSheet = require('./importSheet');
const claimScan = require('../claimScan');
const report = require('./report');
const claimPrice = require('../claimPrice');

const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

function mount(app, cfg) {
    // The page.
    app.get('/claims', (req, res) => res.sendFile(path.join(cfg.ROOT, 'dashboard', 'claims.html')));

    // Everything the page needs in one call — rows plus the totals, so the
    // header cannot disagree with the table below it.
    app.get('/api/claims', (req, res) => {
        try {
            const rows = claims.list();
            // `kinds` is the vocabulary as it actually stands — whatever the
            // model has named so far, with a hue per slug so a kind the model
            // invents tonight is legible on the page with no CSS to add. There is
            // no fixed list to send, by design.
            const keyOf = (c) => String(c.container_no || c.invoice_no || '—').toUpperCase();
            res.json({
                claims: rows,
                stats: { ...claims.stats(rows), containers: new Set(rows.map(keyOf)).size },
                statuses: claims.STATUSES,
                kinds: vocabulary(),
                units: claims.UNITS,
            });
        } catch (e) { bad(res, e.message, 500); }
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
            const allowed = ['customer', 'supplier', 'invoice_no', 'container_no', 'note', 'claim_type', 'claim_date', 'supplier_price', 'supplier_price_unit', 'supplier_price_source',
                'sell_price', 'sell_price_unit', 'our_claim', 'evidence', 'stated_claim_amount'];
            const patch = {};
            for (const k of allowed) if (b[k] !== undefined) patch[k] = b[k];
            if (!Object.keys(patch).length) return bad(res, 'nothing to change');
            const rec = await claims.update(req.params.id, patch, b.by || 'manager', 'edited on the claims page');
            res.json(rec);
        } catch (e) { bad(res, e.message); }
    });

    // ── THE VOCABULARY ─────────────────────────────────────────────────────
    // She can rename a kind into her own words and merge two the model named
    // separately. This is the correction path for a dynamic vocabulary — the
    // alternative was a fixed list in the code, which is what she rejected.
    app.get('/api/claim-kinds', (req, res) => {
        res.json({ kinds: vocabulary() });
    });

    app.post('/api/claim-kinds/rename', async (req, res) => {
        try {
            const b = req.body || {};
            if (!b.slug || !b.label) return bad(res, 'which kind, and what should it be called');
            res.json(await claimKinds.rename(b.slug, b.label, b.by || 'manager'));
        } catch (e) { bad(res, e.message); }
    });

    app.post('/api/claim-kinds/merge', async (req, res) => {
        try {
            const b = req.body || {};
            if (!b.from || !b.into) return bad(res, 'merging needs the kind to fold in and the kind to keep');
            const moved = claims.list().filter((c) => c && c.claim_type === b.from);
            // Either side may be a kind that only exists on claims — an older
            // import's slug the registry never recorded. Adopt it first so the
            // merge has something to work with.
            for (const slug of [b.from, b.into]) {
                if (!claimKinds.get(slug)) await claimKinds.ensure(claimKinds.label(slug), '', 'adopted from an earlier import');
            }
            await claimKinds.merge(b.from, b.into, b.by || 'manager');
            for (const c of moved) {
                await claims.update(c.id, { claim_type: b.into }, b.by || 'manager',
                    `kind merged: ${b.from} → ${b.into}`);
            }
            res.json({ into: claimKinds.get(b.into), moved: moved.length });
        } catch (e) { bad(res, e.message); }
    });

    // ── SCANNING A DOCUMENT ────────────────────────────────────────────────
    // Apsara, 2026-10-02: "Add a scan page in claim sheet. When i scan pass it
    // across the model, and fill all the details by itself."
    //
    // It fills the form and stops. Nothing is created here — the figures on the
    // page are the model's reading of a photograph, and the mail path has source
    // text to check a quote against where this has none. So the human IS the
    // verification step, and the response says so in those words.
    app.post('/api/claims/scan', async (req, res) => {
        try {
            const b = req.body || {};
            const base64 = String(b.base64 || '').replace(/^data:[^,]+,/, '');
            if (!base64) return bad(res, 'no file was sent — pick a photo or a pdf first');
            if (base64.length > 28 * 1024 * 1024) return bad(res, 'that file is too big — photograph the page rather than the whole report');
            const d = await claimScan.scan({ base64, mimeType: b.mimeType || 'image/jpeg' });
            // Not a claim document is an ANSWER, not a server fault: 422 so the
            // page can say what it was instead of showing a red failure.
            if (!d.ok) return res.status(422).json(d);
            res.json(d);
        } catch (e) {
            console.error('[CLAIMS] scan failed:', e && e.stack || e);
            bad(res, e.message, 500);
        }
    });

    // ── THE STATEMENT THAT GOES TO A SUPPLIER ──────────────────────────────
    // Apsara, 2026-10-02: "create claim report option where i can download the
    // report and share it with supplier".
    //
    // ROUTE ORDER MATTERS AND THIS IS WHY. /api/claims/:id used to be declared
    // above this, so Express matched "report" as a claim id and answered 404.
    // Any new /api/claims/<word> route belongs HERE, above the wildcard at the
    // bottom of this file.
    const FORMATS = ['json', 'html', 'pdf', 'xlsx'];

    // The picker: who is owed what, so she chooses a supplier rather than typing
    // one. Ordered by what is recoverable, because that is the order she chases in.
    app.get('/api/claims/report/suppliers', (req, res) => {
        try {
            const out = new Map();
            for (const c of claims.list()) {
                if (!c) continue;
                const name = String(c.supplier || '').trim();
                if (!name) continue;
                if (['rejected', 'withdrawn'].includes(c.status)) continue;
                if (!out.has(name)) out.set(name, { supplier: name, claims: 0, recoverable: 0, unverified: 0, settled: 0 });
                const r = out.get(name);
                if (c.status === 'settled') { r.settled += 1; continue; }
                if (!report.SENDABLE.includes(c.status)) { r.unverified += 1; continue; }
                r.claims += 1;
                r.recoverable += Number(c.our_claim) || 0;
            }
            const suppliers = [...out.values()]
                .map((r) => ({ ...r, recoverable: Math.round(r.recoverable * 100) / 100 }))
                .sort((a, b2) => b2.recoverable - a.recoverable);
            res.json({ suppliers });
        } catch (e) { bad(res, e.message, 500); }
    });

    app.get('/api/claims/report', async (req, res) => {
        try {
            const q = req.query || {};
            const format = String(q.format || 'json').toLowerCase();
            if (!FORMATS.includes(format)) return bad(res, 'that format is not one I can make — json, html, pdf or xlsx');

            const built = report.build({
                supplier: q.supplier, container: q.container, claimId: q.claimId,
                from: q.from, to: q.to,
                // Both default to OFF. An unverified claim is a reading, not a
                // demand, and a settled one is closed — neither belongs in a
                // document a supplier is asked to pay against unless she says so.
                includeUnverified: q.includeUnverified === '1' || q.includeUnverified === 'true',
                includeSettled: q.includeSettled === '1' || q.includeSettled === 'true',
            });

            if (format === 'json') return res.json(built);
            if (format === 'html') {
                res.type('html');
                return res.send(report.toHtml(built));
            }
            if (format === 'xlsx') {
                const buf = await report.toWorkbook(built);
                res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
                res.setHeader('Content-Disposition', `attachment; filename="${report.filenameFor(built, 'xlsx')}"`);
                return res.send(buf);
            }
            const buf = await report.toPdf(built);
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${report.filenameFor(built, 'pdf')}"`);
            return res.send(buf);
        } catch (e) {
            console.error('[CLAIMS] report failed:', e && e.stack || e);
            bad(res, e.message, 500);
        }
    });

    // ── IMPORTING A SHEET FROM THE PAGE ────────────────────────────────────
    // Apsara, 2026-09-26: "if i upload the weight shortage sheet and ai to
    // classify them properly and put it into website, it should do that."
    //
    // Two steps, and the plan stays HERE between them. The page gets a summary
    // and an id; committing sends back only that id. It is not a round trip of
    // convenience — a plan posted back from a browser is a plan a browser could
    // edit, and these rows are money. What she confirms is what was computed.
    const plans = new Map();
    const PLAN_TTL = 15 * 60 * 1000;
    const sweepPlans = () => {
        const cut = Date.now() - PLAN_TTL;
        for (const [id, v] of plans) if (v.at < cut) plans.delete(id);
        // A cap as well as a TTL: a big workbook held per preview would otherwise
        // grow this process's memory for as long as she keeps pressing the button.
        while (plans.size > 8) plans.delete(plans.keys().next().value);
    };

    // What the page is allowed to see: everything except the internal row objects.
    // Kinds actually in use on claims, plus the registry. Claims imported before
    // the registry existed carry a slug it has never heard of, which is why the
    // header read "0 kinds" while every row on screen showed one. A kind she can
    // see has to be a kind she can rename and merge.
    const vocabulary = () => {
        const reg = claimKinds.list();
        const known = new Set(reg.map((k) => k.slug));
        const extra = new Map();
        for (const c of claims.list()) {
            const s = c && c.claim_type;
            if (!s || known.has(s)) continue;
            if (!extra.has(s)) extra.set(s, { slug: s, label: claimKinds.label(s), description: '', count: 0, named_by: 'imported before the vocabulary existed' });
            extra.get(s).count += 1;
        }
        return [...reg, ...extra.values()].map((k) => ({ ...k, hue: claimKinds.hue(k.slug) }));
    };

    const forPage = (p, id) => ({
        planId: id,
        source: p.source, tab: p.tab, tabs: p.tabs, sheetRows: p.sheetRows,
        start: p.start,
        blocks: p.blocks,
        count: p.claims.length,
        totals: p.totals, byStatus: p.byStatus,
        byKind: Object.entries(p.byKind).map(([slug, k]) => ({ slug, ...k, hue: slug ? claimKinds.hue(slug) : null })),
        vocabulary: { named: p.vocabulary.named, settled: p.vocabulary.settled, kinds: p.vocabulary.kinds, folds: p.vocabulary.folds, why: p.vocabulary.why },
        merged: p.merged, split: p.split, manual: p.manual, noUnit: p.noUnit, misaligned: p.misaligned,
        unresolved: p.unresolved, already: p.already.length,
        skipped: p.skipped.length,
        preview: p.claims.slice(0, 200).map((r) => ({
            rows: r.fromRows, customer: r.customer, supplier: r.supplier,
            invoice_no: r.invoice_no, container_no: r.container_no,
            claim_type: r.claim_type, kind: r.kind ? r.kind.label : null,
            why: r.type_why || r.type_unresolved || '', quote: r.type_quote || '',
            claim_amount: r.claim_amount, our_claim: r.our_claim, status: r.status,
            weight_unit: r.weight_unit,
        })),
    });

    app.post('/api/claims/import/preview', async (req, res) => {
        try {
            const b = req.body || {};
            if (b.xlsxBase64 && String(b.xlsxBase64).length > 40 * 1024 * 1024) return bad(res, 'that file is too big to read in one go');
            const p = await importSheet.plan({
                csv: b.csv || undefined,
                xlsxBase64: b.xlsxBase64 || undefined,
                name: b.name || undefined,
                tab: b.tab || undefined,
                fromRow: Number(b.fromRow) || undefined,
                useAi: b.useAi !== false,
            });
            sweepPlans();
            const id = 'plan_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
            plans.set(id, { plan: p, at: Date.now() });
            res.json(forPage(p, id));
        } catch (e) {
            console.error('[CLAIMS] import preview failed:', e && e.stack || e);
            bad(res, e.message);
        }
    });

    app.post('/api/claims/import/commit', async (req, res) => {
        try {
            const held = plans.get(String((req.body || {}).planId || ''));
            if (!held) return bad(res, 'that preview has expired — read the sheet again before importing');
            const w = await importSheet.commit(held.plan, 'sheet-import');
            plans.delete(String(req.body.planId));
            res.json({ created: w.created, stats: claims.stats() });
        } catch (e) { bad(res, e.message, 500); }
    });

    app.post('/api/claims/import/reclassify', async (req, res) => {
        try {
            const b = req.body || {};
            const held = plans.get(String(b.planId || ''));
            if (!held) return bad(res, 'that preview has expired — read the sheet again first');
            const r = await importSheet.reclassify(held.plan, { write: b.really === true });
            res.json({ ...r, wrote: b.really === true });
        } catch (e) { bad(res, e.message, 500); }
    });

    // ── WHAT THE SUPPLIER'S OWN PRICE WAS ──────────────────────────────────
    // Apsara, 2026-10-03: "You didnt mention supplier price in claim?"
    //
    // Read-only, and it writes nothing. It reports the rate off that
    // container's purchase bill and what the shortage comes to at it; the page
    // offers that figure and a person accepts it, because what is actually
    // recovered is settled by negotiation. Where the bill cannot decide — no
    // bill, no price on it, or several grades at several rates with nothing
    // saying which was short — it answers with no rate and the reason, which
    // is worth more on a document asking for money than a confident average.
    app.get('/api/claims/:id/price', (req, res) => {
        try {
            const c = claims.get(req.params.id);
            if (!c) return bad(res, 'no such claim', 404);
            res.json(claimPrice.recoverableFor(c));
        } catch (e) { bad(res, e.message, 500); }
    });

    // ── THE WILDCARD, LAST, AND IT MUST STAY LAST ──────────────────────────
    // /api/claims/:id matches /api/claims/report, /api/claims/scan and anything
    // else with one segment. Declared above them it swallows them and answers
    // 404 — which is exactly what happened on 2026-10-02 and cost an hour.
    // ADD NEW /api/claims/<word> ROUTES ABOVE THIS LINE, NOT BELOW IT.
    app.get('/api/claims/:id', (req, res) => {
        const c = claims.get(req.params.id);
        return c ? res.json(c) : bad(res, 'no such claim', 404);
    });

    console.log('[CLAIMS] routes mounted — /claims, /api/claims, /api/claim-kinds, /api/claims/import, /api/claims/scan, /api/claims/report');
}

module.exports = { mount };
