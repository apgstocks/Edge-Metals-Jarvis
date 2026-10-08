// ── helpers/carrierRemittance.js — what NTG, TQL and Schneider tell us by EMAIL ──
//
// Apsara, 2026-10-07, on NTG / TQL / Schneider: "there is no pdf, in mail there
// will be payment remittance". She is right, and it is why the three Verify
// tabs in documents.html sat inert: every working carrier tab there reads a PDF
// laid out the way that carrier prints it. These three do not send one that
// matters. They send TEXT:
//
//   TQL        "Thank you for your payment to TQL"  — amount, the TQL PO(s) it
//              paid, a confirmation number. "TQL Invoices for Edge Metals Inc" —
//              a table of what is still owed (TQL PO, invoice date, lane, amount).
//   NTG        Billtrust "Payment Scheduled / Payment Processed" — amount, date,
//              and a per-invoice table (NTG-96xxxxx, amount, confirmation #);
//              "Acct No. …: Payment Confirmation" — amount and date only;
//              "Open Balance Statement / Past Due Statement" — every open
//              invoice with its amount, dates and days past due.
//   Schneider  "Pay by Link" — an order id, an amount and the Schneider load
//              numbers it settles. (Matthew Whittaker's other mail is delivery
//              coordination and rate quotes, not billing — deliberately ignored.)
//
// ── PURE, AND IT WRITES NOTHING ──────────────────────────────────────────
// Text in, plain objects out. No sheet, no bills.json, no ledger. WHERE a
// remittance should be recorded is a decision for Apsara — these are domestic
// loads (CA→TX, Oakland→Eccomelt), not containers, so none of the container-
// keyed Verify tabs fits and the Edge Metals / Edge Yard line has to be drawn
// by her, not by a parser. scripts/carrier-remittance-report.js reads the
// emails scripts/freight-2026-email-sweep.js --save-emails saved and prints
// what these functions found.
//
// ── EVERY PARSER RETURNS null FOR "NOT MY EMAIL" ─────────────────────────
// Never a half-filled record: a remittance with a guessed amount is worse than
// one that is missing, because it looks reconciled.

const money = (s) => {
    const n = parseFloat(String(s == null ? '' : s).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};
const squash = (t) => String(t || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ');
const flat = (t) => squash(t).replace(/\s+/g, ' ').trim();

// A saved email (scripts/freight-2026-email-sweep.js --save-emails) is
// "Header: value" lines, a blank line, then the body.
function splitSaved(text) {
    const raw = String(text || '').replace(/\r/g, '');
    const i = raw.indexOf('\n\n');
    const head = i === -1 ? raw : raw.slice(0, i);
    const body = i === -1 ? '' : raw.slice(i + 2);
    const h = {};
    for (const line of head.split('\n')) {
        const m = line.match(/^([A-Za-z-]+):\s*(.*)$/);
        if (m) h[m[1].toLowerCase()] = m[2];
    }
    return { headers: h, body };
}

function isoDate(headerDate) {
    const d = new Date(headerDate || '');
    return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}
function usToIso(s) {
    const m = String(s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    return m ? `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}` : null;
}

// ── TQL: "Thank you for your payment to TQL" ──────────────────────────────
function parseTqlPayment({ headers, body }) {
    if (!/thank you for your payment to tql/i.test(headers.subject || '')) return null;
    const t = squash(body);
    const amt = t.match(/payment for \$([\d,]+(?:\.\d+)?)/i);
    if (!amt) return null;
    // The PO block sits between "have been paid:" and the confirmation number.
    const block = (t.match(/have been paid:([\s\S]*?)Your Payment Confirmation/i) || [])[1] || '';
    const pos = block.split('\n').map((l) => l.trim()).filter((l) => /^\d{6,10}$/.test(l));
    const conf = (t.match(/Confirmation Number:\s*(\S+)/i) || [])[1] || null;
    return {
        party: 'tql', kind: 'payment', date: isoDate(headers.date),
        amount: money(amt[1]), refs: pos, confirmation: conf,
        from: (t.match(/processed from:\s*([^\n]+)/i) || [])[1]?.trim() || null,
    };
}

// ── TQL: "TQL Invoices for Edge Metals Inc" — the outstanding table ───────
// One cell per line in the raw mail, and an EMPTY cell simply vanishes, so the
// row is matched on its shape rather than on column positions: an 8-digit TQL
// PO, an optional free-text customer PO, two dates, a "XX TO YY" lane, two
// money figures, days old and a load date.
function parseTqlInvoices({ headers, body }) {
    if (!/tql invoices for edge metals/i.test(headers.subject || '')) return null;
    const t = flat(body);
    const re = /(\d{8})\s+(.*?)\s*(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+([A-Z]{2}\s+TO\s+[A-Z]{2})\s+\$([\d,]+\.\d\d)\s+\$([\d,]+\.\d\d)\s+(\d+)\s+(\d{1,2}\/\d{1,2}\/\d{4})/g;
    const rows = [];
    let m;
    while ((m = re.exec(t))) {
        rows.push({
            ref: m[1], customer_po: m[2].trim() || null, delivery_date: usToIso(m[3]), invoice_date: usToIso(m[4]),
            lane: m[5].replace(/\s+/g, ' '), amount: money(m[6]), outstanding: money(m[7]), days_old: Number(m[8]), load_date: usToIso(m[9]),
        });
    }
    return { party: 'tql', kind: 'open_invoices', date: isoDate(headers.date), rows };
}

// ── NTG: Billtrust payment mails ──────────────────────────────────────────
// "Payment Scheduled" and "Payment Processed" carry the per-invoice table;
// "Acct No. …: Payment Confirmation" carries only amount + date. The same
// payment arrives as all three, so callers group on (date, amount).
function parseNtgPayment({ headers, body }) {
    const subj = headers.subject || '';
    const kind = /payment scheduled/i.test(subj) ? 'scheduled'
        : /payment processed/i.test(subj) ? 'processed'
        : /payment confirmation/i.test(subj) ? 'confirmation' : null;
    if (!kind || !/ntgfreight|nolan/i.test(`${headers.from || ''} ${subj} ${body}`)) return null;
    const t = flat(body);
    const total = money((t.match(/(?:Total Amount|Payment Amount):\s*\$([\d,]+\.\d\d)/i) || [])[1]
        || (t.match(/payment in the amount of \$([\d,]+\.\d\d)/i) || [])[1]);
    if (total == null) return null;
    const payDate = usToIso((t.match(/Payment Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i) || [])[1]) || isoDate(headers.date);
    const fee = money((t.match(/Convenience Fee:\s*\$([\d,]+\.\d\d)/i) || [])[1]);
    const method = ((t.match(/Payment Method:\s*(.*?)\s*Payment Date/i) || [])[1] || '').trim() || null;
    // account  NTG-invoice  PO (free text)  one or two dates  $amount  confirmation
    const re = /(\d{6,8})\s+NTG-(\d{6,8})\s+(.*?)\s*(\d{1,2}\/\d{1,2}\/\d{4})(?:\s+(\d{1,2}\/\d{1,2}\/\d{4}))?\s+\$([\d,]+\.\d\d)\s+(\d{6,})/g;
    const invoices = [];
    let m;
    while ((m = re.exec(t))) {
        invoices.push({ invoice: m[2], po: m[3].trim() || null, date: usToIso(m[5] || m[4]), amount: money(m[6]), confirmation: m[7] });
    }
    return { party: 'ntg', kind: `payment_${kind}`, date: payDate, amount: total, fee, method, invoices };
}

// ── NTG: Open Balance / Past Due statements ───────────────────────────────
// "POD 9621418 EDGEMETAL(8/25/2026 8/31/2026 9/10/2026 $4,900.00 $0.00 $0.00
//  $4,900.00 25". The PO column is free text and sometimes swallows a date, so
// the row is anchored from the right: the LAST TWO dates before the four money
// figures are invoice date and due date, and whatever sits before them is PO.
function parseNtgStatement({ headers, body }) {
    if (!/(open balance|past due) statement/i.test(headers.subject || '')) return null;
    if (!/ntgfreight|nolan/i.test(`${headers.from || ''} ${body}`)) return null;
    const t = flat(body);
    const re = /POD\s+(\d{6,8})\s+(.*?)\s*(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+\$([\d,]+\.\d\d)\s+\$([\d,]+\.\d\d)\s+\$([\d,]+\.\d\d)\s+\$([\d,]+\.\d\d)\s+(\(?-?\d+\)?)/g;
    const rows = [];
    let m;
    while ((m = re.exec(t))) {
        rows.push({
            invoice: m[1], po: m[2].trim() || null, invoice_date: usToIso(m[3]), due_date: usToIso(m[4]),
            amount: money(m[5]), paid: money(m[6]), adjustments: money(m[7]), open: money(m[8]),
            days_past_due: /^\(/.test(m[9]) ? -Number(m[9].replace(/\D/g, '')) : Number(m[9].replace(/[^\d-]/g, '')),
        });
    }
    const full = money((t.match(/FULL OPEN BALANCE\s*\$([\d,]+\.\d\d)/i) || [])[1]);
    // An Open Balance statement lists EVERY open invoice; a Past Due statement lists
    // only the overdue ones. Comparing against a Past Due one makes every invoice
    // that is not yet due look as if it had vanished, so the type travels with it.
    return { party: 'ntg', kind: 'statement', statement_type: /past due/i.test(headers.subject || '') ? 'past_due' : 'open', date: isoDate(headers.date), full_open_balance: full, rows };
}

// ── NTG: "Invoice 9703547 From NOLAN TRANSPORTATION GROUP, LLC" ───────────
// The notice carries the invoice NUMBER only; the amount is in an attachment or
// behind a link. It is still evidence an invoice exists, which is what lets the
// report catch one that was billed and never reached a statement or a payment.
function parseNtgInvoiceNotice({ headers, body }) {
    const m = (headers.subject || '').match(/invoice\s+(\d{6,8})\s+from\s+nolan/i);
    if (!m) return null;
    return { party: 'ntg', kind: 'invoice_notice', invoice: m[1], date: isoDate(headers.date), forwarded: /^\s*fwd?:/i.test(headers.subject || '') };
}

// ── Schneider: "Pay by Link" ──────────────────────────────────────────────
// Schneider's billing system mails an order id, an amount and the load numbers
// it settles; Bose forwards it on with "PAID $9700" in the subject once done.
// Both forms contain the block, so the order id is the key and "paid" is read
// off the subject. Anything else from schneider.com is coordination, not money.
function parseSchneiderPayByLink({ headers, body }) {
    const t = flat(body);
    if (!/pay by link/i.test(t)) return null;
    const order = (t.match(/Order ID:\*?\s*(\d{10,})/i) || [])[1];
    const amount = money((t.match(/Amount:\*?\s*\*?USD\*?\s*([\d,]+(?:\.\d+)?)/i) || [])[1]);
    if (!order || amount == null) return null;
    const loads = ((t.match(/Order Description:\*?\s*([\d,\s]+)/i) || [])[1] || '').split(/[,\s]+/).filter((x) => /^\d{6,}$/.test(x));
    return { party: 'schneider', kind: 'pay_by_link', date: isoDate(headers.date), order, amount, loads, paid: /\bPAID\b/.test(headers.subject || '') };
}

// ── NTG sends ONE payment as up to three mails ─────────────────────────────
// "Payment Scheduled" (invoice table), "Payment Processed" (invoice table) and
// "Payment Confirmation" (amount only), often a day apart — 16 Apr scheduled,
// 17 Apr confirmed, the same $3,550. Keyed on (date, amount) alone, the
// confirmation counted as a SECOND payment and overstated NTG by $3,550. So:
// the mails that carry an invoice table define the payments, and a confirmation
// joins one with the same amount within 5 days; only a confirmation with nothing
// to join stands on its own.
function groupNtgPayments(records) {
    const pays = (records || []).filter((r) => r && r.party === 'ntg' && String(r.kind).startsWith('payment_'));
    const byDate = (a, b) => String(a.date).localeCompare(String(b.date));
    const day = (d) => Date.parse(`${d}T00:00:00Z`);
    const rich = new Map();
    for (const p of pays.filter((x) => x.kind !== 'payment_confirmation').sort(byDate)) {
        const k = `${p.date}|${p.amount}`;
        const cur = rich.get(k);
        if (!cur || p.invoices.length > cur.invoices.length) rich.set(k, { ...p });
    }
    const list = [...rich.values()];
    for (const c of pays.filter((x) => x.kind === 'payment_confirmation').sort(byDate)) {
        const home = list.find((p) => p.amount === c.amount && !p.confirmed && Math.abs(day(p.date) - day(c.date)) <= 5 * 86400000);
        if (home) home.confirmed = c.date; else list.push({ ...c, invoices: [], confirmed: c.date });
    }
    return list.sort(byDate);
}

// ── Parsed records -> carrier-invoice rows (helpers/carrierInvoices.js shape) ──
// `recs` = parseSavedEmail() results for ONE mailbox set. Pure; writes nothing.
// Returns { rows, skipped }. `skipped` is what could not become a row, with why —
// a paid TQL PO that never appeared in a reminder has no invoice amount, and an
// invented amount would look reconciled, so it is reported instead.
function buildCarrierRows(recs) {
    const rows = [], skipped = [];
    const by = (k, p) => (recs || []).filter((r) => r && r.party === p && r.kind === k);
    // TQL: latest reminder per PO; paid if a payment mail names the PO.
    const pays = by('payment', 'tql');
    const latest = new Map();
    for (const r of by('open_invoices', 'tql').sort((a, b) => String(a.date).localeCompare(String(b.date))))
        for (const row of r.rows) latest.set(row.ref, { ...row, seen: r.date });
    for (const row of latest.values()) {
        const hit = pays.filter((p) => p.refs.includes(row.ref));
        const paid = hit.length ? (hit.length === 1 && hit[0].refs.length === 1 ? hit[0].amount : row.amount) : 0;
        const note = hit.length && paid > row.amount ? `paid ${paid} against an invoice of ${row.amount} — check with TQL` : null;
        rows.push({ carrier: 'tql', ref: row.ref, amount: row.amount, paid, invoice_date: row.invoice_date, lane: row.lane,
            paid_dates: hit.map((p) => p.date), evidence: note || (hit.length ? 'TQL payment mail' : `TQL reminder ${row.seen}`) });
    }
    for (const p of pays) for (const po of p.refs) if (!latest.has(po) && !skipped.some((x) => x.carrier === 'tql' && x.ref === po)) skipped.push({ carrier: 'tql', ref: po, why: 'paid, but never on a TQL reminder — no invoice amount' });
    // NTG: invoices from statements; amounts from payment tables for any not on a statement.
    const paidBy = new Map(), paidOn = new Map();
    for (const p of groupNtgPayments(recs)) for (const i of p.invoices) {
        paidBy.set(i.invoice, (paidBy.get(i.invoice) || 0) + (i.amount || 0));
        paidOn.set(i.invoice, [...(paidOn.get(i.invoice) || []), p.date]);
    }
    const inv = new Map();
    for (const s of by('statement', 'ntg').sort((a, b) => String(a.date).localeCompare(String(b.date))))
        for (const r of s.rows) inv.set(r.invoice, { amount: r.amount, invoice_date: r.invoice_date, seen: s.date });
    for (const [n, i] of inv) rows.push({ carrier: 'ntg', ref: n, amount: i.amount, paid: Math.min(paidBy.get(n) || 0, i.amount), invoice_date: i.invoice_date,
        paid_dates: paidOn.get(n) || [], evidence: paidBy.has(n) ? 'NTG payment mail' : `NTG statement ${i.seen}` });
    for (const [n, amt] of paidBy) if (!inv.has(n)) rows.push({ carrier: 'ntg', ref: n, amount: amt, paid: amt, invoice_date: null, paid_dates: paidOn.get(n), evidence: 'NTG payment mail (not on any saved statement)' });
    // Schneider: one row per Pay-by-Link order; paid only if a PAID mail exists.
    const ord = new Map();
    for (const r of by('pay_by_link', 'schneider')) { const c = ord.get(r.order) || { ...r, paid: false }; c.paid = c.paid || r.paid; ord.set(r.order, c); }
    // `loads` travels as an ARRAY as well as in the prose `lane`. It was parsed
    // and then flattened into "loads 3010354116, 3010355035" and thrown away,
    // so the screen had a sentence where it needed a list — Apsara, 2026-10-08,
    // wanting a row she can open to see "what is what". Splitting the AMOUNT
    // across them is not possible and not attempted: Pay-by-Link bills one
    // figure for the whole order and the email carries no per-load number.
    for (const o of ord.values()) rows.push({ carrier: 'schneider', ref: o.order, amount: o.amount, paid: o.paid ? o.amount : 0, invoice_date: o.date,
        loads: o.loads.slice(),
        lane: o.loads.length ? `loads ${o.loads.join(', ')}` : null, paid_dates: o.paid ? [o.date] : [], evidence: o.paid ? 'Schneider PAID mail' : 'Schneider Pay by Link' });
    return { rows, skipped };
}

// One entry point: give it a saved email's text, get back the first record any
// parser recognises, or null.
function parseSavedEmail(text) {
    const e = splitSaved(text);
    for (const fn of [parseTqlPayment, parseTqlInvoices, parseNtgPayment, parseNtgStatement, parseNtgInvoiceNotice, parseSchneiderPayByLink]) {
        let r = null;
        try { r = fn(e); } catch (err) { r = null; }
        if (r) return { ...r, subject: e.headers.subject || '', messageDate: e.headers.date || '' };
    }
    return null;
}

module.exports = { splitSaved, parseSavedEmail, parseTqlPayment, parseTqlInvoices, parseNtgPayment, parseNtgStatement, parseNtgInvoiceNotice, parseSchneiderPayByLink, groupNtgPayments, buildCarrierRows, money, usToIso };
