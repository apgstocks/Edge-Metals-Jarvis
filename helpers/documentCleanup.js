// ── helpers/documentCleanup.js — "I don't want to store old invoices" ──────
// Apsara, 2026-10-12: "i want clean up option in documents.i dont want to
// store old invoices", then "so as packing list so as proforma", and, asked
// what counts as old: "Both" — older than N days AND regenerated copies.
// Asked what goes on the Invoice and Packing tabs: "The saved forms in those
// lists". On Proforma: age rule only.
//
// NEW CODE, NEW ROUTES, NEW BUTTONS. Nothing here changes what the existing
// per-file Delete does (routes/admin.js) or what any list shows by default.
//
// ── WHAT EACH TAB'S CLEAN-UP REMOVES ──────────────────────────────────────
//   invoice   the saved FORM in invoice_versions.json (the rows with an Edit
//             button). Two rules, each optional:
//               · olderThanDays — the whole container entry, when its newest
//                 version is older than the cutoff;
//               · keepLatestOnly — "regenerated copies": every version of a
//                 container except the newest.
//             Archived PDFs in documents_saved/ are NOT touched.
//   packing   the saved packing list RECORD, when updated_at is older than
//             the cutoff. A packing list is one record per container, so
//             there is no "regenerated copy" rule for it.
//   proforma  the archived PDF (that tab has nothing but files) and its
//             stored form state, by file age. Regenerating a proforma
//             overwrites the same filename, so there is no copy rule either.
//             Only files positively classed as proformas: the old invoices
//             misfiled under proforma/ belong to the Invoice tab and are left.
//
// ── ONE DEPENDENCY, SO ONE GUARD ──────────────────────────────────────────
// helpers/packingList.js borrows its header (exporter, buyer, invoice no and
// date, ports) from the container's latest saved invoice form. Removing that
// form while the packing list stays would leave a packing list that prints
// with an empty buyer box. So an invoice form is SKIPPED, with the reason
// reported, whenever a packing list for the same container will remain
// afterwards. Clean both tabs in one go and the pair goes together.
//
// Nothing here is a judgement about which documents matter: the cutoff is
// hers, typed on the screen, and nothing runs without a preview and a yes.

const fs = require('fs');
const path = require('path');
const cfg = require('../config');
const { mutateJson, loadJson } = require('./json');

const KINDS = ['invoice', 'packing', 'proforma'];
// A floor, so a stray "0" or "1" cannot empty the lists. This is my choice,
// not hers — raise or lower it here if she wants.
const MIN_DAYS = 7;
const DAY = 86400000;

const keyFor = (c) => String(c || '').trim().toUpperCase();
const ts = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : null; };

function normalise(opts = {}) {
    const kinds = (Array.isArray(opts.kinds) ? opts.kinds : []).filter((k) => KINDS.includes(k));
    if (!kinds.length) throw new Error('choose at least one of: invoice, packing, proforma');
    let days = null;
    if (opts.olderThanDays !== undefined && opts.olderThanDays !== null && opts.olderThanDays !== '') {
        days = Math.floor(Number(opts.olderThanDays));
        if (!Number.isFinite(days) || days < MIN_DAYS) throw new Error(`"older than" must be at least ${MIN_DAYS} days`);
    }
    const keepLatestOnly = opts.keepLatestOnly === true;
    if (days === null && !keepLatestOnly) throw new Error('choose a rule: older than N days, and/or keep only the latest version');
    if (keepLatestOnly && !kinds.includes('invoice')) {
        // Harmless to accept, but say it rather than silently ignoring it.
    }
    if (days === null && !kinds.some((k) => k === 'invoice')) {
        throw new Error('packing lists and proformas are cleaned by age — set "older than N days"');
    }
    return { kinds, days, keepLatestOnly, now: opts.now || Date.now() };
}

// Pure read: what WOULD go, and what was left alone and why.
function plan(opts = {}) {
    const o = normalise(opts);
    const cutoff = o.days === null ? null : o.now - o.days * DAY;
    const out = { params: { kinds: o.kinds, olderThanDays: o.days, keepLatestOnly: o.keepLatestOnly },
                  packing: [], invoice: [], proforma: [], skipped: [] };

    // Packing first: the invoice guard needs to know which records remain.
    const packAll = require('./packingList').loadAll();
    const packGoing = new Set();
    if (o.kinds.includes('packing') && cutoff !== null) {
        for (const r of packAll) {
            const t = ts(r.updated_at) ?? ts(r.created_at);
            if (t !== null && t < cutoff) {
                packGoing.add(r.id);
                out.packing.push({ id: r.id, label: r.container_no || '(no container)',
                                   detail: `${r.customer || '—'} · ${r.invoice_no || '—'}`, at: r.updated_at || r.created_at });
            }
        }
    }
    const packRemaining = new Set(packAll.filter((r) => !packGoing.has(r.id)).map((r) => keyFor(r.container_no)));

    if (o.kinds.includes('invoice')) {
        const all = loadJson(cfg.INVOICE_VERSIONS_FILE, {}) || {};
        for (const [container, versions] of Object.entries(all)) {
            const list = Array.isArray(versions) ? versions : [];
            if (!list.length) continue;
            const last = list[list.length - 1] || {};
            const lastAt = ts(last.saved_at);
            const label = container;
            const detail = `${last.inv_no || last.invoice_no || '—'} · ${last.buyer || '—'}`;
            const tooOld = cutoff !== null && lastAt !== null && lastAt < cutoff;
            if (tooOld) {
                if (packRemaining.has(keyFor(container))) {
                    out.skipped.push({ kind: 'invoice', label,
                        reason: 'its packing list is staying, and the packing list reads its header from this form' });
                    continue;
                }
                out.invoice.push({ container, label, detail, mode: 'all', versions: list.length, at: last.saved_at });
            } else if (o.keepLatestOnly && list.length > 1) {
                out.invoice.push({ container, label, detail, mode: 'older-versions', versions: list.length,
                                   dropping: list.length - 1, at: last.saved_at });
            }
        }
    }

    if (o.kinds.includes('proforma') && cutoff !== null) {
        const docs = require('./documentsSaved');
        const dir = path.join(cfg.DOCUMENTS_SAVED_DIR, 'proforma');
        for (const f of docs.splitSavedProformas().proformas) {
            let st; try { st = fs.statSync(path.join(dir, f)); } catch (e) { continue; }
            if (st.mtimeMs < cutoff) out.proforma.push({ file: f, label: f, at: new Date(st.mtimeMs).toISOString() });
        }
    }
    out.count = out.packing.length + out.invoice.length + out.proforma.length;
    return out;
}

// Does what plan() said, recomputed now so a form regenerated between Preview
// and Delete is not removed on stale information.
async function apply(opts = {}) {
    const p = plan(opts);
    const done = { packing: 0, invoice_forms: 0, invoice_versions: 0, proforma: 0, failed: [] };

    if (p.packing.length) {
        const ids = new Set(p.packing.map((r) => r.id));
        await mutateJson(cfg.PACKING_LISTS_FILE, [], (all) => {
            const rows = Array.isArray(all) ? all : [];
            const next = rows.filter((r) => !(r && ids.has(r.id)));
            done.packing = rows.length - next.length;
            return next;
        }, { strict: true });
    }
    if (p.invoice.length) {
        const byKey = new Map(p.invoice.map((r) => [r.container, r]));
        await mutateJson(cfg.INVOICE_VERSIONS_FILE, {}, (all) => {
            const obj = (all && typeof all === 'object' && !Array.isArray(all)) ? all : {};
            for (const [container, r] of byKey) {
                const list = obj[container];
                if (!Array.isArray(list) || !list.length) continue;
                if (r.mode === 'all') { delete obj[container]; done.invoice_forms++; }
                else if (list.length > 1) { done.invoice_versions += list.length - 1; obj[container] = list.slice(-1); }
            }
            return obj;
        }, { strict: true });
    }
    for (const r of p.proforma) {
        try {
            if (require('./documentsSaved').deleteSaved({ kind: 'proforma', filename: r.file })) {
                done.proforma++;
                try { await require('./proformaVersions').forgetProformaPayload(r.file); } catch (e) { /* file is gone; record is a leftover only */ }
            }
        } catch (e) { done.failed.push({ file: r.file, error: e.message }); }
    }
    return { plan: p, done };
}

module.exports = { plan, apply, KINDS, MIN_DAYS };
