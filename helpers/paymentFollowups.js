// ── helpers/paymentFollowups.js — drafts chasing customers who owe Edge Metals ──────────────
// Apsara, 2026-10-26: "it should be able to draft a response asking for payment. For all the invoices
// except who I mentioned, it should ask for remittance status." — "who I mentioned" being the customers
// whose payment terms are ETA-based ("ETA-10, ETA+7 …"). Her answers: the terms are recorded PER CUSTOMER;
// every customer NOT on ETA terms gets one remittance-status draft for their open invoices; a customer ON ETA
// terms is drafted only from 11 days before each invoice's ETA (2026-10-27: "we need to start sending email from
// ETA-11 days"), as a payment request; drafts live in a "Payment follow-ups" list in Jarvis and NOTHING IS SENT
// (sending is a later step, her call).
//
// READ-ONLY OVER THE LEDGER. This reads sales (helpers/sales.js listWithTotals: the balance is already
// receivable − received − deducted), the address book and the per-customer terms below. It writes ONLY
// the terms store. It sends nothing, posts nothing, and changes no sale.
//
// Edge METALS only: the sales store is Edge Metals' (Edge Yard has its own loads). Nothing here reads the yard.
//
// ONE DRAFT PER CUSTOMER, listing every open invoice, because three emails to one buyer on one morning is
// worse than one. A line she has partly been paid on shows what is outstanding and what has arrived.
const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const txt = (v) => String(v == null ? '' : v).trim();
const keyOf = (name) => txt(name).toLowerCase().replace(/\s+/g, ' ');
const money = (n) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ── ETA TERMS ───────────────────────────────────────────────────────────────
// "ETA-10" = due 10 days before the vessel's ETA, "ETA+7" = 7 days after. Stored normalised, per customer.
// The ETA itself comes from the booking (see bookingEta below), not from here.
function parseEtaTerms(v) {
    const s = txt(v);
    if (!s) return null;
    const m = s.match(/^ETA\s*([+-])\s*(\d{1,3})$/i);
    if (!m) throw new Error('ETA terms look like ETA-10 or ETA+7 (leave blank for normal terms)');
    return `ETA${m[1]}${Number(m[2])}`;
}

const loadTerms = () => { const r = loadJson(cfg.CUSTOMER_PAY_TERMS_FILE, {}); return r && typeof r === 'object' && !Array.isArray(r) ? r : {}; };
const termsFor = (customer, terms = loadTerms()) => (terms[keyOf(customer)] || {}).eta_terms || null;

async function setEtaTerms(customer, value, { actor = null } = {}) {
    const name = txt(customer);
    if (!name) throw new Error('which customer?');
    const eta = parseEtaTerms(value);
    await mutateJson(cfg.CUSTOMER_PAY_TERMS_FILE, {}, (cur) => {
        const m = cur && typeof cur === 'object' && !Array.isArray(cur) ? { ...cur } : {};
        if (eta) m[keyOf(name)] = { customer: name, eta_terms: eta, set_by: actor, set_at: new Date().toISOString() };
        else delete m[keyOf(name)];
        return m;
    }, { strict: true });
    return { customer: name, eta_terms: eta };
}

// ── DATES: THE VESSEL'S ETA COMES FROM THE BOOKING CONFIRMATION ───────────────
// Apsara, 2026-10-27: "eta will be there in booking confirmation" — it is on the booking (bookings.json, field
// `eta`, MM/DD/YYYY, read from the carrier's confirmation), joined to the sale by booking number. And: "for the
// selected customers, we need to start sending email from ETA-11 days." So a customer on ETA terms is drafted
// ONLY once today is within LEAD_DAYS of that invoice's ETA, and the draft is a PAYMENT request (their terms
// give a due date: ETA-10 -> ten days before the ETA, ETA+7 -> seven days after). Before that they wait; an
// invoice whose booking has no ETA cannot be placed in time, so it is listed as such and never guessed.
// Every other customer gets the REMITTANCE-STATUS draft, with the ETA shown where it is known.
const LEAD_DAYS = 11;
const DAY = 86400000;
function parseDate(v) {
    const s = txt(v); if (!s) return null;
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/), y, mo, d;
    if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else if ((m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/))) { mo = +m[1]; d = +m[2]; y = +m[3]; }   // MM/DD/YYYY, her format
    else return null;
    const t = Date.UTC(y, mo - 1, d);
    const dt = new Date(t);
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? t : null;
}
const fmt = (t) => { const d = new Date(t); return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`; };
const todayUtc = (now = Date.now()) => { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
// "ETA-10" -> -10, "ETA+7" -> +7
const offsetOf = (eta) => { const m = txt(eta).match(/^ETA([+-])(\d+)$/); return m ? (m[1] === '-' ? -1 : 1) * Number(m[2]) : null; };
const normBk = (v) => txt(v).toUpperCase().replace(/\s+/g, '');
function bookingEta(bookingNo, bookings) {
    const k = normBk(bookingNo); if (!k || !bookings) return null;
    let b = bookings[k] || bookings[bookingNo];
    if (!b) b = Object.values(bookings).find((x) => x && normBk(x.booking_no) === k);
    return b && b.eta ? parseDate(b.eta) : null;
}

// ── THE DRAFT ───────────────────────────────────────────────────────────────
// kind 'remittance': ask for payment status + remittance details (every customer not on ETA terms).
// kind 'payment'   : terms-based, for ETA-term customers — payment falls due on the dates shown.
function draftFor(customer, lines, { to = null, cc = null, kind = 'remittance', etaTerms = null } = {}) {
    const total = round2(lines.reduce((t, l) => t + l.balance, 0));
    const many = lines.length > 1;
    const what = (l) => [l.invoice_no ? `Invoice ${l.invoice_no}` : 'Invoice', l.container_no ? `container ${l.container_no}` : null, l.booking_no ? `booking ${l.booking_no}` : null].filter(Boolean).join(', ');
    const recd = (l) => (l.received > 0.005 ? `, ${money(l.received)} received so far` : '');
    const rows = lines.map((l) => (kind === 'payment'
        ? `  - ${what(l)} (vessel ETA ${l.eta}): ${money(l.balance)}${recd(l)} — due ${l.due}`
        : `  - ${what(l)}${l.date ? ` (dated ${l.date})` : ''}${l.eta ? `, vessel ETA ${l.eta}` : ''}: ${money(l.balance)} outstanding${recd(l)}`));
    const body = (kind === 'payment' ? [
        `Dear ${customer},`,
        '',
        `As per our agreed payment terms (${etaTerms}), payment for ${many ? 'the following invoices falls' : 'the following invoice falls'} due on the date${many ? 's' : ''} shown:`,
        '',
        ...rows,
        '',
        `Total: ${money(total)}`,
        '',
        `Please arrange payment and send us the remittance details (bank transfer / SWIFT confirmation) once it is done, so we can match it on our side. If it has already been sent, please share the remittance copy.`,
        '',
        'Thank you,',
        'Apsara',
        'Edge Metals Inc',
    ] : [
        `Dear ${customer},`,
        '',
        `I hope you are well. Our records show ${many ? 'the following invoices are' : 'the following invoice is'} still open:`,
        '',
        ...rows,
        '',
        `Total outstanding: ${money(total)}`,
        '',
        `Could you please confirm the payment status ${many ? 'of each' : 'of this invoice'}? If payment has already been sent, please share the remittance details (bank transfer / SWIFT confirmation) so we can match it on our side. If it has not been sent yet, please let us know when we can expect it.`,
        '',
        'Thank you,',
        'Apsara',
        'Edge Metals Inc',
    ]).join('\n');
    return {
        customer, kind, eta_terms: etaTerms, to, cc, total, count: lines.length, lines,
        subject: kind === 'payment' ? `Payment due — ${lines.length} invoice${many ? 's' : ''} — Edge Metals`
            : `Payment status — ${lines.length} outstanding invoice${many ? 's' : ''} — Edge Metals`,
        body,
        // NOTHING is sent from here. 'to' is empty when the address book has no single address for this customer.
        to_missing: !to,
    };
}

// salesRows: sales.listWithTotals() output. resolve: emailContacts.resolveContact. Both injectable.
function build({ salesRows = null, terms = null, resolve = null, bookings = null, now = Date.now() } = {}) {
    const rows = salesRows || require('./sales').listWithTotals();
    const t = terms || loadTerms();
    const res = resolve || ((n) => require('./emailContacts').resolveContact(n));
    let bk = bookings; if (!bk) { try { bk = require('./json').loadBookings(); } catch (e) { bk = {}; } }
    const today = todayUtc(now);
    const open = rows.filter((r) => r.balance !== null && r.balance !== undefined && Number(r.balance) > 0.005 && txt(r.customer));
    const byCustomer = new Map();
    for (const r of open) {
        const k = keyOf(r.customer);
        if (!byCustomer.has(k)) byCustomer.set(k, { customer: txt(r.customer), rows: [] });
        byCustomer.get(k).rows.push(r);
    }
    const drafts = [], waiting_eta = [];
    for (const { customer, rows: rs } of byCustomer.values()) {
        const lines = rs.map((r) => {
            const e = bookingEta(r.booking_no, bk);
            return { id: r.id, invoice_no: r.invoice_no || null, container_no: r.container_no || null, booking_no: r.booking_no || null,
                date: r.date || null, terms: r.terms || null, receivable: r.receivable, received: Number(r.received) || 0, balance: round2(r.balance),
                eta: e == null ? null : fmt(e), _eta: e };
        }).sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
        const strip = (l) => { const { _eta, ...rest } = l; return rest; };
        const etaTerms = termsFor(customer, t);
        let to = null, cc = null;
        try { const c = res(customer); if (c && c.type === 'exact' && c.contact && c.contact.email) { to = c.contact.email; cc = (c.contact.cc && c.contact.cc.length) ? c.contact.cc : null; } } catch (e) { /* no address: the draft says so */ }
        if (!etaTerms) { drafts.push(draftFor(customer, lines.map(strip), { to, cc, kind: 'remittance' })); continue; }
        // ETA-term customer: only the invoices whose booking ETA is known AND within LEAD_DAYS of today.
        const off = offsetOf(etaTerms);
        const ready = [], later = [], unknown = [];
        for (const l of lines) {
            if (l._eta == null) { unknown.push(l); continue; }
            const startAt = l._eta - LEAD_DAYS * DAY;
            if (today >= startAt) ready.push({ ...l, due: fmt(l._eta + off * DAY) }); else later.push({ ...l, starts: startAt });
        }
        if (ready.length) drafts.push(draftFor(customer, ready.map(strip), { to, cc, kind: 'payment', etaTerms }));
        if (later.length || unknown.length) {
            const rest = [...later, ...unknown];
            waiting_eta.push({ customer, eta_terms: etaTerms, count: rest.length, total: round2(rest.reduce((s, l) => s + l.balance, 0)),
                next_draft: later.length ? fmt(Math.min(...later.map((l) => l.starts))) : null, eta_unknown: unknown.map((l) => l.invoice_no || l.container_no || l.booking_no || l.id) });
        }
    }
    drafts.sort((a, b) => b.total - a.total);
    waiting_eta.sort((a, b) => b.total - a.total);
    return { drafts, waiting_eta, lead_days: LEAD_DAYS, open_invoices: open.length, total_outstanding: round2(open.reduce((s, r) => s + Number(r.balance), 0)),
        drafted_total: round2(drafts.reduce((s, d) => s + d.total, 0)), customers_with_terms: Object.values(t).map((x) => ({ customer: x.customer, eta_terms: x.eta_terms })) };
}

module.exports = { build, draftFor, parseEtaTerms, setEtaTerms, termsFor, loadTerms, keyOf, parseDate, bookingEta, LEAD_DAYS };
