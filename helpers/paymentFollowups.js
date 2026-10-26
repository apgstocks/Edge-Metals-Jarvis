// ── helpers/paymentFollowups.js — drafts chasing customers who owe Edge Metals ──────────────
// Apsara, 2026-10-26: "it should be able to draft a response asking for payment. For all the invoices
// except who I mentioned, it should ask for remittance status." — "who I mentioned" being the customers
// whose payment terms are ETA-based ("ETA-10, ETA+7 …"). Her answers: customers on ETA terms get NO draft;
// everyone else with an open invoice gets one; the terms are recorded PER CUSTOMER; drafts live in a
// "Payment follow-ups" list in Jarvis and NOTHING IS SENT (sending is a later step, her call).
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
// "ETA-10" = due 10 days before the vessel's ETA, "ETA+7" = 7 days after. Stored as typed, normalised, because
// it is only a LABEL here: the follow-up skips the customer. The ETA date is not in the sales store, so
// this does not (and cannot) work out whether anything is due yet.
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

// ── THE DRAFT ───────────────────────────────────────────────────────────────
function draftFor(customer, lines, { to = null, cc = null } = {}) {
    const total = round2(lines.reduce((t, l) => t + l.balance, 0));
    const many = lines.length > 1;
    const what = (l) => [l.invoice_no ? `Invoice ${l.invoice_no}` : 'Invoice', l.container_no ? `container ${l.container_no}` : null, l.booking_no ? `booking ${l.booking_no}` : null].filter(Boolean).join(', ');
    const rows = lines.map((l) => `  - ${what(l)}${l.date ? ` (dated ${l.date})` : ''}: ${money(l.balance)} outstanding${l.received > 0.005 ? `, ${money(l.received)} received so far` : ''}`);
    const body = [
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
    ].join('\n');
    return {
        customer, to, cc, total, count: lines.length, lines,
        subject: `Payment status — ${lines.length} outstanding invoice${many ? 's' : ''} — Edge Metals`,
        body,
        // NOTHING is sent from here. 'to' is empty when the address book has no single address for this customer.
        to_missing: !to,
    };
}

// salesRows: sales.listWithTotals() output. resolve: emailContacts.resolveContact. Both injectable.
function build({ salesRows = null, terms = null, resolve = null } = {}) {
    const rows = salesRows || require('./sales').listWithTotals();
    const t = terms || loadTerms();
    const res = resolve || ((n) => require('./emailContacts').resolveContact(n));
    const open = rows.filter((r) => r.balance !== null && r.balance !== undefined && Number(r.balance) > 0.005 && txt(r.customer));
    const byCustomer = new Map();
    for (const r of open) {
        const k = keyOf(r.customer);
        if (!byCustomer.has(k)) byCustomer.set(k, { customer: txt(r.customer), rows: [] });
        byCustomer.get(k).rows.push(r);
    }
    const drafts = [], skipped_eta = [];
    for (const { customer, rows: rs } of byCustomer.values()) {
        const lines = rs.map((r) => ({ id: r.id, invoice_no: r.invoice_no || null, container_no: r.container_no || null, booking_no: r.booking_no || null,
            date: r.date || null, terms: r.terms || null, receivable: r.receivable, received: Number(r.received) || 0, balance: round2(r.balance) }))
            .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
        const eta = termsFor(customer, t);
        if (eta) { skipped_eta.push({ customer, eta_terms: eta, count: lines.length, total: round2(lines.reduce((s, l) => s + l.balance, 0)) }); continue; }
        let to = null, cc = null;
        try { const c = res(customer); if (c && c.type === 'exact' && c.contact && c.contact.email) { to = c.contact.email; cc = (c.contact.cc && c.contact.cc.length) ? c.contact.cc : null; } } catch (e) { /* no address: the draft says so */ }
        drafts.push(draftFor(customer, lines, { to, cc }));
    }
    drafts.sort((a, b) => b.total - a.total);
    skipped_eta.sort((a, b) => b.total - a.total);
    return { drafts, skipped_eta, open_invoices: open.length, total_outstanding: round2(open.reduce((s, r) => s + Number(r.balance), 0)),
        drafted_total: round2(drafts.reduce((s, d) => s + d.total, 0)), customers_with_terms: Object.values(t).map((x) => ({ customer: x.customer, eta_terms: x.eta_terms })) };
}

module.exports = { build, draftFor, parseEtaTerms, setEtaTerms, termsFor, loadTerms, keyOf };
