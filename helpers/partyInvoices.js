// ── helpers/partyInvoices.js — what Zimex, Jio, Sher, Pan Metal, AJ Transport and Garduno's invoiced ──
// Apsara, 2026-10-07: "similar for zimex, jio, sher, pan metal, AJ, Gardunos" — an invoice
// LIST per party, read from email, in Jarvis ("Jarvis is the ultimate record"). Chosen over
// copying the sheet tabs into bills (that is scripts/trucker-tabs-to-bills.js).
//
// A REGISTER, NOT A LEDGER. Own store (party_invoices.json). Nothing reads it except the
// register tab: it is not a bill, a sale or a book entry, so it changes no supplier balance
// and no statement. It records WHAT EACH PARTY BILLED and whether the line was found on the
// Invoice sheet.
//
// ── PAYING (added 2026-10-07: "edit, delete, pay ... a single payment against multiple") ──
// Payments live in their OWN store (party_invoice_payments.json), one payment allocated
// across one or more invoice lines of ONE party. Paid / balance / status of a line are
// DERIVED from those allocations — never typed onto the row, so there is no second figure
// to disagree with. This is a register-only record of what was paid; it posts nothing to
// bills, the books, bank matching or QuickBooks.
//
// Rules that protect the figures: allocations must add up to the payment exactly; a line
// can never be paid more than it is owed; a payment never spans two parties; an edit may
// not take a line's amount below what has been paid against it; a line with money paid
// against it cannot be deleted until that payment is.
//
// One row per invoice LINE (a container, a booking or an HBL), keyed
// party + invoice_no + line key, so a re-import updates in place. A row with `locked`
// (hand-edited) is never overwritten. Writes are strict: a lost write must throw.
const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

const PARTIES = { zimex: 'Zimex', jio: 'Jio', sher: 'Sher Trucking', ajtransport: 'AJ Transport', panmetal: 'Pan Metal', gardunos: "Garduno's" };
// Same ceiling the sweep uses for its trucker tab logging: a drayage line is hundreds of
// dollars; above this on a trucker is almost certainly Edge's own outbound invoice.
const TRUCKING_CAP = 3000;
const TRUCKERS = ['jio', 'sher', 'ajtransport', 'gardunos'];

const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = parseFloat(String(v).replace(/[$,\s]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };
const txt = (v) => String(v == null ? '' : v).trim();
const up = (v) => txt(v).toUpperCase().replace(/\s+/g, '');

// "166 REVISED" replaces "166". The line's identity is the BASE number, so a revised
// invoice and the original it replaces are the same line, not two (Apsara, 2026-10-07,
// pasting Garduno's 166 listed twice: "166 revised" and "166", six containers each at $930).
const REVISED_RE = /\s*\b(REV(ISED|ISION)?|CORRECTED|AMENDED)\b.*$/i;
const baseInvoice = (no) => txt(no).replace(REVISED_RE, '').trim();
const isRevised = (no) => REVISED_RE.test(txt(no)) && baseInvoice(no) !== '';

// What this line is worth, by party — the same field order the sweep itself reads.
function amountOf(party, r) {
    if (party === 'panmetal') return num(r.commission != null ? r.commission : r.amount);
    return num(r.net_amount != null ? r.net_amount : (r.total_amount != null ? r.total_amount : r.amount));
}

// One export record -> a register row, or { skip: reason }.
function normalize(rec) {
    const party = txt(rec && rec.party).toLowerCase();
    if (!PARTIES[party]) return { skip: 'unknown party' };
    if (rec.extraction_failed) return { skip: 'extraction failed' };
    const amount = amountOf(party, rec);
    if (amount === null || amount === 0) return { skip: 'no amount (booking confirmation / certificate, not an invoice)' };
    // Per load, for sher: the invoice amount covers `quantity` loads.
    const perLoad = TRUCKERS.includes(party) ? amount / (Number(rec.quantity) > 0 ? Number(rec.quantity) : 1) : 0;
    if (TRUCKERS.includes(party) && perLoad > TRUCKING_CAP) return { skip: `over $${TRUCKING_CAP} per load — probably not a ${PARTIES[party]} invoice` };
    const line = up(rec.container_no) || up(rec.booking_no) || up(rec.hbl_no) || up(rec.order_no);
    const invoiceNo = txt(rec.invoice_no);
    if (!line && !invoiceNo) return { skip: 'no invoice number and no container/booking/HBL to key it on' };
    return {
        row: {
            party, key: `${party}:${baseInvoice(invoiceNo) || '(none)'}:${line || '(none)'}`,
            invoice_no: invoiceNo || null, revised: isRevised(invoiceNo), invoice_date: txt(rec.invoice_date) || null,
            container_no: up(rec.container_no) || null, booking_no: up(rec.booking_no) || null, hbl_no: up(rec.hbl_no) || null,
            amount, quantity: num(rec.quantity),
            check_status: txt(rec.status) || null,            // verified / match / not_in_sheet / booking_mismatch / …
            source_file: txt(rec.source_file) || null, source_subject: txt(rec.source_subject) || null,
            source_date: txt(rec.source_date) || null, source_mailbox: txt(rec.source_mailbox) || null,
        },
    };
}

const list = () => { const r = loadJson(cfg.PARTY_INVOICES_FILE, []); return Array.isArray(r) ? r : []; };

// rows: normalize().row[]. Returns { added, updated, kept_locked }.
async function upsertMany(rows) {
    let added = 0, updated = 0, keptLocked = 0;
    const paidNow = paidByRow();
    await mutateJson(cfg.PARTY_INVOICES_FILE, [], (cur) => {
        const arr = Array.isArray(cur) ? cur : [];
        const at = new Map(arr.map((r, i) => [r.key, i]));
        for (const row of rows) {
            const now = new Date().toISOString();
            if (!at.has(row.key)) { arr.push({ id: `PI_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, ...row, createdAt: now, updatedAt: now }); at.set(row.key, arr.length - 1); added++; }
            else if (arr[at.get(row.key)].locked) keptLocked++;
            // The ORIGINAL never overwrites a REVISED line that is already here, whatever order they arrive in.
            else if (isRevised(arr[at.get(row.key)].invoice_no) && !row.revised) keptLocked++;
            // A re-import must not lower a line below what has already been paid against it.
            else if (row.amount + 0.005 < (paidNow[arr[at.get(row.key)].id] || 0)) keptLocked++;
            else { const i = at.get(row.key); arr[i] = { ...arr[i], ...row, updatedAt: now }; updated++; }
        }
        return arr;
    }, { strict: true });
    return { added, updated, kept_locked: keptLocked };
}


// ── DERIVED PAYMENT FIGURES ───────────────────────────────────────────────
const MODES = ['Wire', 'Zelle', 'Cash', 'Cheque'];
const round2 = (n) => Math.round(n * 100) / 100;
const payments = () => { const r = loadJson(cfg.PARTY_INVOICE_PAYMENTS_FILE, []); return Array.isArray(r) ? r : []; };
function paidByRow(pays = payments(), { excluding = null } = {}) {
    const out = {};
    for (const p of pays) { if (excluding && p.id === excluding) continue; for (const a of p.allocations || []) out[a.row_id] = round2((out[a.row_id] || 0) + a.amount); }
    return out;
}
function withPaid(rows = list(), pays = payments()) {
    const paid = paidByRow(pays);
    return rows.map((r) => {
        const p = paid[r.id] || 0, balance = round2(r.amount - p);
        return { ...r, paid: p, balance, pay_status: p <= 0 ? 'unpaid' : (balance > 0.005 ? 'part' : 'paid') };
    });
}

const EDITABLE = ['invoice_no', 'invoice_date', 'container_no', 'booking_no', 'hbl_no', 'amount', 'note'];
const UPPER = ['container_no', 'booking_no', 'hbl_no'];

// Edit one line. Marks it `locked` so a later import/sync never overwrites a hand edit, and keeps
// what it was before. The row's key never changes, so a re-import cannot re-add the original.
async function editRow(id, patch = {}, { actor = null } = {}) {
    const clean = {};
    for (const k of EDITABLE) if (k in patch) {
        if (k === 'amount') { const n = num(patch.amount); if (n === null || n <= 0) throw new Error('amount must be greater than 0'); clean.amount = n; }
        else clean[k] = UPPER.includes(k) ? (up(patch[k]) || null) : (txt(patch[k]) || null);
    }
    if (!Object.keys(clean).length) throw new Error('nothing to change');
    let saved = null, problem = null;
    const paid = paidByRow();
    await mutateJson(cfg.PARTY_INVOICES_FILE, [], (cur) => {
        const arr = Array.isArray(cur) ? cur : [];
        const i = arr.findIndex((r) => r.id === id);
        if (i === -1) { problem = `no invoice line ${id}`; return arr; }
        if ('amount' in clean && clean.amount + 0.005 < (paid[id] || 0)) { problem = `${(paid[id] || 0).toFixed(2)} has already been paid against this line — the amount cannot go below that`; return arr; }
        const before = {}; for (const k of Object.keys(clean)) before[k] = arr[i][k] === undefined ? null : arr[i][k];
        arr[i] = { ...arr[i], ...clean, locked: true, updatedAt: new Date().toISOString(),
            edit_history: [...(arr[i].edit_history || []), { at: new Date().toISOString(), by: actor, before }] };
        saved = arr[i];
        return arr;
    }, { strict: true });
    if (problem) throw new Error(problem);
    return withPaid([saved])[0];
}

async function deleteRow(id) {
    if ((paidByRow()[id] || 0) > 0) throw new Error('money has been paid against this line — delete that payment first');
    let found = false;
    await mutateJson(cfg.PARTY_INVOICES_FILE, [], (cur) => { const arr = Array.isArray(cur) ? cur : []; const n = arr.filter((r) => r.id !== id); found = n.length !== arr.length; return n; }, { strict: true });
    if (!found) throw new Error(`no invoice line ${id}`);
    return { ok: true };
}

// ONE payment, MANY invoice lines (of one party). allocations: [{ row_id, amount }].
function validatePayment(input = {}) {
    const rows = new Map(list().map((r) => [r.id, r]));
    const amount = num(input.amount);
    if (amount === null || amount <= 0) throw new Error('payment amount must be greater than 0');
    const mode = MODES.find((m) => m.toLowerCase() === txt(input.mode).toLowerCase());
    if (!mode) throw new Error(`payment mode must be one of: ${MODES.join(', ')}`);
    const paidOn = txt(input.paid_on);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn) || Number.isNaN(Date.parse(paidOn))) throw new Error('paid_on must be a date, YYYY-MM-DD');
    const allocs = Array.isArray(input.allocations) ? input.allocations : [];
    if (!allocs.length) throw new Error('pick at least one invoice line to pay');
    const seen = new Set(), clean = [];
    const already = paidByRow();
    for (const a of allocs) {
        const row = rows.get(a && a.row_id);
        if (!row) throw new Error(`no invoice line ${a && a.row_id}`);
        if (seen.has(row.id)) throw new Error('the same invoice line is listed twice');
        seen.add(row.id);
        const amt = num(a.amount);
        if (amt === null || amt <= 0) throw new Error(`allocation for ${row.invoice_no || row.container_no || row.id} must be greater than 0`);
        const owed = round2(row.amount - (already[row.id] || 0));
        if (amt > owed + 0.005) throw new Error(`${row.invoice_no || row.container_no || row.id} owes only ${owed.toFixed(2)}, cannot allocate ${amt.toFixed(2)}`);
        clean.push({ row_id: row.id, amount: amt });
    }
    const parties = new Set(clean.map((a) => rows.get(a.row_id).party));
    if (parties.size > 1) throw new Error('one payment goes to one party — these lines belong to different parties');
    const sum = round2(clean.reduce((t, a) => t + a.amount, 0));
    if (Math.abs(sum - amount) > 0.005) throw new Error(`allocations come to ${sum.toFixed(2)} but the payment is ${amount.toFixed(2)}`);
    return { party: [...parties][0], amount, mode, paid_on: paidOn, ref: txt(input.ref) || null, note: txt(input.note) || null, allocations: clean };
}

async function addPayment(input = {}, { actor = null } = {}) {
    const rec = { id: `PIP_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, ...validatePayment(input), created_by: actor, createdAt: new Date().toISOString() };
    await mutateJson(cfg.PARTY_INVOICE_PAYMENTS_FILE, [], (cur) => [...(Array.isArray(cur) ? cur : []), rec], { strict: true });
    return rec;
}
async function deletePayment(id) {
    let found = false;
    await mutateJson(cfg.PARTY_INVOICE_PAYMENTS_FILE, [], (cur) => { const arr = Array.isArray(cur) ? cur : []; const n = arr.filter((p) => p.id !== id); found = n.length !== arr.length; return n; }, { strict: true });
    if (!found) throw new Error(`no payment ${id}`);
    return { ok: true };
}


// ── REVISED INVOICES SUPERSEDE THEIR ORIGINAL ──────────────────────────────
// Report first. supersedePlan() is pure; supersedeApply() writes. It removes the ORIGINAL
// line only when a REVISED line for the same party + base invoice + container/booking/HBL
// exists, and it never removes one that has money paid against it or that she edited by
// hand — those are reported for her to decide. A line that is on the original but NOT on
// the revision is kept and flagged: the revision may have dropped it, or the read may have
// missed it, and only she knows which.
function supersedePlan(rows = list(), pays = payments()) {
    const paid = paidByRow(pays);
    const lineOf = (r) => r.container_no || r.booking_no || r.hbl_no || '';
    const groups = new Map();
    for (const r of rows) { const k = `${r.party}|${baseInvoice(r.invoice_no)}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    const out = { remove: [], blocked: [], only_on_original: [], ambiguous: [], keep: [] };
    for (const g of groups.values()) {
        // Derived from the printed invoice number, NOT the stored `revised` flag: rows imported
        // before that flag existed have none, and those are exactly the duplicates to clean up.
        const rev = g.filter((r) => isRevised(r.invoice_no)), orig = g.filter((r) => !isRevised(r.invoice_no));
        if (!rev.length || !orig.length) continue;
        const revNos = [...new Set(rev.map((r) => r.invoice_no))];
        if (revNos.length > 1) { out.ambiguous.push({ base: baseInvoice(rev[0].invoice_no), revisions: revNos }); continue; }
        const revLines = new Set(rev.map(lineOf));
        for (const o of orig) {
            if (!revLines.has(lineOf(o))) { out.only_on_original.push(o); continue; }
            if ((paid[o.id] || 0) > 0) out.blocked.push({ row: o, why: `${paid[o.id]} already paid against the original` });
            else if (o.locked) out.blocked.push({ row: o, why: 'edited by hand' });
            else out.remove.push(o);
        }
        out.keep.push(...rev);
    }
    return out;
}

async function supersedeApply() {
    const plan = supersedePlan();
    const doomed = new Set(plan.remove.map((r) => r.id));
    if (doomed.size) {
        await mutateJson(cfg.PARTY_INVOICES_FILE, [], (cur) => {
            const arr = (Array.isArray(cur) ? cur : []).filter((r) => !doomed.has(r.id));
            // A revised line keeps one key (the base), so a later re-import of the original cannot re-add it.
            for (const r of arr) if (isRevised(r.invoice_no)) { r.revised = true; r.key = `${r.party}:${baseInvoice(r.invoice_no)}:${r.container_no || r.booking_no || r.hbl_no || '(none)'}`; }
            return arr;
        }, { strict: true });
    }
    return { removed: doomed.size, plan };
}

function summary(rows = list()) {
    const out = {};
    for (const p of Object.keys(PARTIES)) {
        const r = rows.filter((x) => x.party === p);
        const paidMap = paidByRow();
        out[p] = { label: PARTIES[p], count: r.length, total: Math.round(r.reduce((a, x) => a + x.amount, 0) * 100) / 100,
            outstanding: round2(r.reduce((a, x) => a + Math.max(0, x.amount - (paidMap[x.id] || 0)), 0)),
            not_on_sheet: r.filter((x) => x.check_status === 'not_in_sheet').length,
            verified: r.filter((x) => x.check_status === 'verified' || x.check_status === 'match').length };
    }
    return out;
}

module.exports = { PARTIES, TRUCKING_CAP, MODES, normalize, amountOf, list, upsertMany, summary,
    payments, paidByRow, withPaid, editRow, deleteRow, addPayment, deletePayment, validatePayment, EDITABLE,
    baseInvoice, isRevised, supersedePlan, supersedeApply };
