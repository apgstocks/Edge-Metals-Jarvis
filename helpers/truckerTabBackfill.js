// ── helpers/truckerTabBackfill.js — the Jio / Sher / AJ Transport sheet tabs, into Jarvis bills ──
// Apsara, 2026-10-07: "replicate whatever is there from sheet to jarvis. Jarvis is
// the ultimate mode of record", then: "w.r.t trucking bills", for "Jio, Sher, AJ
// Transport ... all truckers", and "keep both in step".
//
// Each of those tabs holds rows the Verify tabs logged after a PDF passed the
// cross-check. Jarvis keeps the same figures on the BILL (trucking_split). This
// turns tab rows back into the records helpers/truckingProposal.js already knows
// how to map, and reuses its proposals() — so nothing about WHICH bill or WHICH
// figures is decided here. Garduno's has no tab (it never logged to the sheet), so
// it is not part of this.
//
// ── PURE: plan() takes the tab rows and the bills and writes nothing ────────
// ── AND IT NEVER PICKS, NEVER OVERWRITES ────────────────────────────────────
// Same two rules as the live accept flow (truckingProposal.js header):
//   · a container that is several bills (one per grade) is SEVERAL, not guessed;
//   · a bill that already carries a trucking figure is never changed — if the
//     sheet disagrees it is REPORTED, because overwriting is how a typed figure
//     she trusts gets replaced by a stale one.
// Only an unambiguous match to a bill with NO trucking figure is "to_add".
const tp = require('./truckingProposal');

const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = parseFloat(String(v).replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : null; };
const txt = (v) => String(v == null ? '' : v).trim();
const col = (head, ...names) => { const h = head.map((x) => txt(x).toLowerCase()); for (const n of names) { const i = h.indexOf(n.toLowerCase()); if (i !== -1) return i; } return -1; };

// header + rows (arrays of cells) -> records in the shape each extractor returns.
function recordsFromTab(kind, values) {
    if (!['jio', 'sher', 'aj'].includes(kind)) throw new Error(`unknown tab kind ${kind}`);
    const [head = [], ...rows] = values || [];
    const c = (n, ...alts) => col(head, n, ...alts);
    const out = [];
    for (const r of rows) {
        const g = (i) => (i === -1 ? '' : r[i]);
        let rec = null;
        if (kind === 'jio') {
            const o = num(g(c('Others')));
            rec = { invoice_date: txt(g(c('Date'))), invoice_no: txt(g(c('Invoice No.'))), container_no: txt(g(c('Container'))),
                line_haul: num(g(c('Line Haul'))), port_fees: num(g(c('Port Fees'))), chassis_rent: num(g(c('Chassis Rent'))),
                other_charges: o ? [{ description: 'Other charge', amount: o }] : [] };
        } else if (kind === 'sher') {
            rec = { invoice_date: txt(g(c('Date'))), booking_no: txt(g(c('Booking No.'))), quantity: num(g(c('Quantity'))),
                chassis: num(g(c('Chassis'))), other_charges: num(g(c('Others'))), amount: num(g(c('Amount', 'Line Haul'))) };
        } else if (kind === 'aj') {
            rec = { invoice_date: txt(g(c('Invoice Date'))), invoice_no: txt(g(c('Invoice No.'))), container_no: txt(g(c('Container No.'))),
                booking_no: txt(g(c('Booking No.'))), amount: num(g(c('Line Haul', 'Amount'))), other_charge: num(g(c('Others'))),
                dry_run_charge: num(g(c('Dry Run'))), extra_scale_charge: num(g(c('Extra Scale'))) };
        } else throw new Error(`unknown tab kind ${kind}`);
        // Every row on these tabs was logged only after the cross-check passed.
        out.push({ ...rec, status: 'verified' });
    }
    return out;
}

// One key can appear twice on a tab (a re-run). Last occurrence wins, matching upsertRowsByKey.
function dedupe(kind, recs) {
    const keyOf = (r) => (kind === 'sher' ? r.booking_no : r.container_no).toUpperCase().replace(/\s+/g, '');
    const m = new Map(); let blank = 0;
    for (const r of recs) { const k = keyOf(r); if (!k) { blank++; m.set(`__blank${blank}`, r); } else m.set(k, r); }
    return [...m.values()];
}

const hasTrucking = (cur) => ['line_haul', 'port_fees', 'chassis_rent', 'dry_run', 'extra_scale'].some((k) => cur[k] != null)
    || (cur.others_total || 0) > 0 || cur.typed_amount != null;

// tabs: { jio: values[][], sher: values[][], aj: values[][] } (any may be missing)
function plan(tabs, allBills) {
    const out = { to_add: [], already_there: [], differs: [], several: [], no_bill: [], no_key: [], counts: {} };
    const label = { jio: 'Jio', sher: 'Sher Trucking', aj: 'AJ Transport' };
    for (const kind of ['jio', 'sher', 'aj']) {
        if (!tabs || !tabs[kind]) continue;
        const recs = dedupe(kind, recordsFromTab(kind, tabs[kind]));
        out.counts[kind] = recs.length;
        for (const p of tp.proposals(recs, kind, { allBills })) {
            const item = { ...p, tab: label[kind], kind };
            if (p.status === 'no_key') out.no_key.push(item);
            else if (p.status === 'no_bill') out.no_bill.push(item);
            else if (p.status === 'several_bills') out.several.push(item);
            else if (p.status === 'one_bill') {
                const cand = p.candidates[0];
                if (!p.proposed_total) out.no_key.push({ ...item, why: 'the tab row carries no charge amounts' });
                else if (cand.disagreements.length) out.differs.push(item);
                else if (hasTrucking(cand.current)) out.already_there.push(item);
                else out.to_add.push(item);
            }
        }
    }
    return out;
}

module.exports = { plan, recordsFromTab, dedupe, hasTrucking };
