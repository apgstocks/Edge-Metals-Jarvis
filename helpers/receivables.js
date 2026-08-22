// ── helpers/receivables.js — accounts receivable ledger ─────────────────────
// Built 2026-08-22. The gap it fills, found while comparing Jarvis against
// ReMatter: Jarvis could GENERATE invoices (proforma → commercial invoice →
// PDF → logged to the Edge Metals sheet) but nothing anywhere recorded
// whether one had been PAID. No balance, no ageing, no "who owes me". Apsara
// confirmed it as the priority.
//
// ── Design: payments live here, invoices stay on the sheet ──────────────────
// The Invoice Google Sheet remains the single source of truth for what was
// INVOICED — it already is, and helpers/invoiceSheet.js reads it by header
// name. This file adds only the other half: what was PAID.
//
// Payments are kept in their own JSON store rather than as new columns on
// that sheet, deliberately:
//   - Adding columns to a live financial sheet that other tools (her old
//     PythonAnywhere invoice_gen.py, the Zimex/Pan Metal verification tabs)
//     also read is a real risk of breaking something unseen. Appending rows
//     is safe and already done by proformaSheetLog; restructuring is not.
//   - One invoice can be paid in several instalments. That's a list per
//     invoice, which a spreadsheet column models badly.
//   - A payment record is append-only history. Losing it to an accidental
//     sheet edit would be unrecoverable.
// The two halves are joined by invoice number, which the sheet already keys
// on and which appears on the PDF the customer holds.
//
// ── What this file will NOT do ──────────────────────────────────────────────
// It does not compute invoice totals. That rule (sum of weight × inv price,
// minus freight once per invoice) lives in helpers/invoiceSheet.js's
// listAllInvoices, alongside the two existing builders it has to agree with.
// A second copy here would be a place for an AR balance to silently diverge
// from the invoice the customer is looking at.

const cfg = require('../config');
const { mutateJson, loadJson } = require('./json');
const invoiceSheet = require('./invoiceSheet');

// Payment shape:
// {
//   id          : string
//   inv_no      : string   (joins to the Invoice sheet's "Inv No." column)
//   amount      : number   (positive; a refund/credit is negative)
//   paid_on     : 'YYYY-MM-DD'
//   method      : string?  ('wire' | 'check' | 'cash' | free text)
//   note        : string?
//   recorded_by : string?  (who told Jarvis)
//   created_at  : ISO string
// }
const PAYMENTS_FILE = cfg.PAYMENTS_FILE || require('path').join(cfg.DATA_DIR, 'payments.json');

function loadPayments() {
    return loadJson(PAYMENTS_FILE, []);
}
function newPaymentId() {
    return 'pay_' + Math.random().toString(36).slice(2, 9);
}
function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
}
// Accepts "5000", "$5,000", "5000.50", "5k" — she types money casually.
function parseAmount(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    let s = String(v == null ? '' : v).trim().toLowerCase();
    if (!s) return null;
    s = s.replace(/[$,\s]/g, '');
    const k = /^(-?\d+(?:\.\d+)?)k$/.exec(s);
    if (k) return parseFloat(k[1]) * 1000;
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
}
// Invoice numbers get typed loosely ("260819_AC_26JY52" vs "26jy52").
// Compared on alphanumerics only so separators and case never cause a miss.
function normaliseInvNo(v) {
    return String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function addPayment({ inv_no, amount, paid_on, method, note, recorded_by }) {
    const amt = parseAmount(amount);
    if (!inv_no || !String(inv_no).trim()) throw new Error('invoice number required');
    if (amt === null) throw new Error('amount required');
    if (amt === 0) throw new Error('amount cannot be zero');
    const payment = {
        id: newPaymentId(),
        inv_no: String(inv_no).trim(),
        amount: round2(amt),
        paid_on: paid_on || new Date().toISOString().slice(0, 10),
        method: method || null,
        note: note || null,
        recorded_by: recorded_by || null,
        created_at: new Date().toISOString(),
    };
    await mutateJson(PAYMENTS_FILE, [], (list) => { list.push(payment); return list; });
    return payment;
}
async function deletePayment(id) {
    let removed = null;
    await mutateJson(PAYMENTS_FILE, [], (list) => {
        const i = list.findIndex((p) => p.id === id);
        if (i >= 0) removed = list.splice(i, 1)[0];
        return list;
    });
    return removed;
}
function paymentsFor(invNo) {
    const key = normaliseInvNo(invNo);
    return loadPayments().filter((p) => normaliseInvNo(p.inv_no) === key);
}

// Days between an invoice date and now. Returns null when the sheet's date
// can't be parsed, so ageing shows "unknown" rather than a wrong bucket —
// silently treating an unparseable date as "today" would hide an old debt.
function daysOld(invDate, now = new Date()) {
    if (!invDate) return null;
    const s = String(invDate).trim();
    let d = null;
    // YYMMDD (her invoice-number date format) and YYYY-MM-DD both appear.
    let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (m) d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (!d) {
        m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
        if (m) {
            const yr = +m[3] < 100 ? 2000 + +m[3] : +m[3];
            d = new Date(Date.UTC(yr, +m[1] - 1, +m[2])); // US M/D/Y
        }
    }
    if (!d) {
        const parsed = new Date(s);
        if (!isNaN(parsed.getTime())) d = parsed;
    }
    if (!d || isNaN(d.getTime())) return null;
    return Math.floor((now.getTime() - d.getTime()) / 86400000);
}
function ageBucket(days) {
    if (days === null) return 'unknown';
    if (days <= 30) return 'current';
    if (days <= 60) return '31-60';
    if (days <= 90) return '61-90';
    return '90+';
}

// ── The opening date ────────────────────────────────────────────────────────
// REAL PROBLEM, first live run 2026-08-22: the ledger reported $17,247,478.52
// outstanding across 495 invoices, the oldest 594 days old. All correct
// arithmetic, and completely useless — payments start empty, so every invoice
// ever issued looked unpaid. That number is her entire invoicing history, not
// her receivables.
//
// The obvious fix — bulk-mark the old ones paid — is the WRONG one, and worth
// saying why: it would write hundreds of payment records for amounts and dates
// nobody actually knows. That is inventing financial history, and once written
// it is indistinguishable from a real payment. A ledger that quietly contains
// fabricated entries is worse than no ledger.
//
// So instead there's a watermark: invoices dated before `ar_opening_date` are
// OUT OF SCOPE, not "paid". They're excluded from the open list and reported
// separately as a count and total, so nothing is hidden — the ledger just says
// plainly "I don't track these" rather than asserting something untrue about
// them. Anything genuinely still owed from before that date can be pulled back
// in individually via ar_tracked_invoices.
function getArSettings() {
    try {
        const { loadSettings } = require('./json');
        const s = loadSettings() || {};
        return {
            openingDate: s.ar_opening_date || null,
            tracked: Array.isArray(s.ar_tracked_invoices) ? s.ar_tracked_invoices : [],
        };
    } catch { return { openingDate: null, tracked: [] }; }
}
async function setArOpeningDate(dateStr) {
    const { loadSettings, saveSettings } = require('./json');
    const s = loadSettings() || {};
    s.ar_opening_date = dateStr || null;
    await saveSettings(s);
    return s.ar_opening_date;
}
// Bring one pre-opening-date invoice back into scope — for a genuinely old
// debt that IS still being chased.
async function trackOldInvoice(invNo) {
    const { loadSettings, saveSettings } = require('./json');
    const s = loadSettings() || {};
    const list = Array.isArray(s.ar_tracked_invoices) ? s.ar_tracked_invoices : [];
    if (!list.some((x) => normaliseInvNo(x) === normaliseInvNo(invNo))) list.push(invNo);
    s.ar_tracked_invoices = list;
    await saveSettings(s);
    return list;
}
// Is this invoice inside the tracked window?
function inScope(inv, openingDate, tracked, now) {
    if (!openingDate) return true;
    if (tracked.some((t) => normaliseInvNo(t) === normaliseInvNo(inv.inv_no))) return true;
    const days = daysOld(inv.inv_date, now);
    const openDays = daysOld(openingDate, now);
    // An unparseable invoice date can't be judged against the watermark.
    // Kept IN scope on purpose: dropping a debt because its date didn't parse
    // is the failure that loses money quietly.
    if (days === null || openDays === null) return true;
    return days <= openDays;
}

// The ledger: every invoice on the sheet, with what's been paid against it.
// `openOnly` filters to invoices still owing something.
// `includeHistory` ignores the opening-date watermark and returns everything.
async function buildLedger({ openOnly = false, consignee = null, now = new Date(), forceRefresh = false, includeHistory = false } = {}) {
    const invoices = await invoiceSheet.listAllInvoices(forceRefresh);
    const payments = loadPayments();
    const byInv = new Map();
    for (const p of payments) {
        const k = normaliseInvNo(p.inv_no);
        if (!byInv.has(k)) byInv.set(k, []);
        byInv.get(k).push(p);
    }

    let rows = invoices.map((inv) => {
        const paidList = byInv.get(normaliseInvNo(inv.inv_no)) || [];
        const paid = round2(paidList.reduce((s, p) => s + p.amount, 0));
        const balance = round2(inv.final_amount - paid);
        const days = daysOld(inv.inv_date, now);
        return {
            ...inv,
            paid,
            balance,
            payments: paidList,
            days_old: days,
            age_bucket: ageBucket(days),
            // Tolerance of one cent absorbs float noise from weight × rate;
            // without it an invoice can sit "open" for $0.004 forever.
            status: balance <= 0.01 ? (paid > 0 ? 'paid' : 'zero') : (paid > 0 ? 'partial' : 'open'),
        };
    });

    // ORPHANS — payments whose invoice number matches nothing on the sheet.
    // Money must never silently disappear. This is a real failure mode found
    // in testing 2026-08-22: a payment recorded against the short container
    // code ("26JY52") does not join to the full invoice number
    // ("260819_AC_26JY52"), because the join is deliberately EXACT — a fuzzy
    // join would risk crediting the wrong customer, which is worse. Callers
    // resolve the reference to a canonical invoice number BEFORE recording
    // (see resolveInvoice + actions.recordPayment), so this should stay
    // empty; if anything ever lands here it's surfaced rather than lost.
    const knownKeys = new Set(invoices.map((i) => normaliseInvNo(i.inv_no)));
    const orphans = payments.filter((p) => !knownKeys.has(normaliseInvNo(p.inv_no)));

    // Apply the opening-date watermark BEFORE any other filter, and report
    // what it removed rather than silently shrinking the number.
    const { openingDate, tracked } = getArSettings();
    let excluded = { count: 0, total: 0, openingDate: openingDate || null };
    if (openingDate && !includeHistory) {
        const kept = [];
        for (const r of rows) {
            if (inScope(r, openingDate, tracked, now)) { kept.push(r); continue; }
            if (r.balance > 0.01) { excluded.count += 1; excluded.total = round2(excluded.total + r.balance); }
        }
        rows = kept;
    }

    if (consignee) {
        const q = String(consignee).toLowerCase();
        rows = rows.filter((r) => String(r.consignee || '').toLowerCase().includes(q)
                               || String(r.customer || '').toLowerCase().includes(q));
    }
    if (openOnly) rows = rows.filter((r) => r.balance > 0.01);

    // Oldest debt first — that's the one to chase.
    rows.sort((a, b) => (b.days_old ?? -1) - (a.days_old ?? -1));

    const totals = rows.reduce((t, r) => {
        t.invoiced = round2(t.invoiced + r.final_amount);
        t.paid = round2(t.paid + r.paid);
        t.outstanding = round2(t.outstanding + Math.max(0, r.balance));
        if (r.balance > 0.01) t.buckets[r.age_bucket] = round2((t.buckets[r.age_bucket] || 0) + r.balance);
        return t;
    }, { invoiced: 0, paid: 0, outstanding: 0, buckets: {} });

    return { rows, totals, orphans, excluded };
}

// Records a payment against a loosely-typed invoice reference, resolving it to
// a real invoice FIRST. This is the entry point callers should use — plain
// addPayment() stores whatever string it's given, which is right for a
// low-level store but wrong for a chat command, where "26JY52" must become
// "260819_AC_26JY52" or the payment joins to nothing.
// Returns { payment, invoice } on success, or { candidates } / { notFound }
// so the caller can ask instead of guessing — crediting the wrong customer's
// invoice is worse than asking one extra question.
async function recordPaymentByRef(ref, details = {}) {
    const hit = await resolveInvoice(ref, { openOnly: false });
    if (hit.candidates && hit.candidates.length) return { candidates: hit.candidates };
    if (!hit.match) return { notFound: true };
    const payment = await addPayment({ ...details, inv_no: hit.match.inv_no });
    const after = await buildLedger({ consignee: null });
    const invoice = after.rows.find((r) => normaliseInvNo(r.inv_no) === normaliseInvNo(hit.match.inv_no));
    return { payment, invoice: invoice || hit.match };
}

// Finds the invoice a loosely-typed reference means. Exact-ish match on the
// invoice number first, then a unique suffix match ("26JY52" for
// "260819_AC_26JY52"), then consignee name. Returns { match } or
// { candidates } so callers can ask rather than guess — never picks one when
// the reference is genuinely ambiguous, because the cost is a payment
// recorded against the wrong customer's invoice.
async function resolveInvoice(ref, { openOnly = true } = {}) {
    const q = normaliseInvNo(ref);
    if (!q) return { candidates: [] };
    const { rows } = await buildLedger({ openOnly });
    const exact = rows.filter((r) => normaliseInvNo(r.inv_no) === q);
    if (exact.length === 1) return { match: exact[0] };
    const suffix = rows.filter((r) => normaliseInvNo(r.inv_no).endsWith(q) || normaliseInvNo(r.inv_no).includes(q));
    if (suffix.length === 1) return { match: suffix[0] };
    if (suffix.length > 1) return { candidates: suffix.slice(0, 8) };
    const raw = String(ref).toLowerCase();
    const byName = rows.filter((r) => String(r.consignee || '').toLowerCase().includes(raw)
                                   || String(r.customer || '').toLowerCase().includes(raw));
    if (byName.length === 1) return { match: byName[0] };
    if (byName.length > 1) return { candidates: byName.slice(0, 8) };
    return { candidates: [] };
}

module.exports = {
    loadPayments, addPayment, deletePayment, paymentsFor,
    buildLedger, resolveInvoice, recordPaymentByRef,
    getArSettings, setArOpeningDate, trackOldInvoice, inScope,
    parseAmount, normaliseInvNo, daysOld, ageBucket, round2,
    PAYMENTS_FILE,
};
