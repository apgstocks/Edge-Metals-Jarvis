// ── helpers/saleInvoiceFlow.js — "generate invoice for the Inesh container" ─
//
// Apsara, 2026-09-21: "If i say jarvis, generate invoice for the inesh
// container..start from latest date in bill.. if some data is missing while
// generating invoice, it can show invoice tab to user, ask what is missing -
// based on user input - fill it, then generate". Asked where the invoice
// number comes from, she chose "ask me" — Jarvis suggests one from the
// Invoice sheet and she confirms or changes it, every time. Channels: voice
// AND WhatsApp.
//
// This file is the pure part: finding the bill, finding (or preparing) the
// sale, working out what is missing, reading her answers, and generating.
// The conversation — what is asked, in what order — lives in
// workflow/actions.js (startSaleInvoice / saleInvoiceAnswer).
//
// ── NOTHING HERE IS A SECOND INVOICE BUILDER ────────────────────────────────
// The document is built by helpers/saleInvoice.buildFrom, the same function
// behind Generate on a Sale row, so the pounds-into-MT protection that file
// exists for applies here unchanged. What is duplicated is the ~20 lines that
// FILE the PDFs (api.js saveGeneratedInvoice): that function is a closure
// inside createApi and cannot be called from an action. Same folder, same
// names, same version history — if one changes, change both.

const fs = require('fs');
const path = require('path');
const bills = require('./bills');
const sales = require('./sales');
const saleInvoice = require('./saleInvoice');
const { keyOf } = require('./margin');

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const cont = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();

// Loose, either direction — the same rule nextInvoiceNo uses for consignees,
// for the same reason: "Inesh" and "Inesh Cores Chapin" are one supplier.
function supplierMatches(billSupplier, query) {
    const a = norm(billSupplier), q = norm(query);
    if (!a || !q) return false;
    return a.includes(q) || q.includes(a);
}

// "start from latest date in bill". The supplier's bills, newest date first;
// everything on that newest date comes back, one entry per CONTAINER (a
// container with two grades is two bill rows and still one invoice question).
function latestBillsFor(query) {
    const all = bills.listWithTotals();
    const mine = all.filter((b) => supplierMatches(b.supplier, query) && cont(b.container_no));
    if (!mine.length) {
        const known = [...new Set(all.map((b) => String(b.supplier || '').trim()).filter(Boolean))];
        return { bills: [], date: null, known };
    }
    const dated = mine.map((b) => ({ b, d: bills.sortableDate(b.date) })).filter((x) => x.d);
    const pool = dated.length ? dated : mine.map((b) => ({ b, d: null }));
    const top = pool.reduce((m, x) => (x.d && (!m || x.d > m) ? x.d : m), null);
    const onTop = pool.filter((x) => x.d === top).map((x) => x.b);
    const seen = new Set();
    const one = onTop.filter((b) => { const k = keyOf(b.booking_no, b.container_no); if (seen.has(k)) return false; seen.add(k); return true; });
    return { bills: one, date: top ? onTop[0].date : null, known: [] };
}

function billByContainer(containerNo) {
    const c = cont(containerNo);
    if (!c) return null;
    return bills.listWithTotals().find((b) => cont(b.container_no) === c) || null;
}
function billById(id) { return bills.listWithTotals().find((b) => b.id === id) || null; }

// Every sale row for the container the bill is for. Usually one; a container
// sold as two grades has two, and that is her question to answer, not ours.
function salesForBill(bill) {
    if (!bill) return [];
    const k = keyOf(bill.booking_no, bill.container_no);
    return sales.list().filter((s) => keyOf(s.booking_no, s.container_no) === k);
}
function salesForContainer(containerNo) {
    const c = cont(containerNo);
    return c ? sales.list().filter((s) => cont(s.container_no) === c) : [];
}

function todayMDY() {
    const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
}

// NEW sale rows prefilled from the bill — what /api/sales/from-bill/:billId
// suggests on the screen. ONE ROW PER GRADE, because that is how her Invoice
// ledger holds a container (helpers/saleInvoice.siblingRows): a bill with
// items becomes one row per item, a flat bill one row. The fields every row
// shares (booking, container, today's date — a sale needs one) are returned
// separately so they are written to every row alike.
function rowsFromBill(bill) {
    const items = Array.isArray(bill.items) ? bill.items.filter((it) => it && it.description) : [];
    const rows = items.length
        ? items.map((it) => ({ sale_id: null, label: it.description,
            patch: { item: it.description, weight: it.weight === null || it.weight === undefined ? '' : it.weight, weight_unit: 'lb' } }))
        : [{ sale_id: null, label: bill.description || '',
            patch: { item: bill.description || '', weight: bill.net_lb === null || bill.net_lb === undefined ? '' : bill.net_lb, weight_unit: 'lb' } }];
    return { rows, shared: { booking_no: bill.booking_no || '', container_no: bill.container_no || '', date: todayMDY() } };
}

// A container's sale rows, split into INVOICES the way saleInvoice.siblingRows
// gathers them: same invoice number and same customer. One group is one
// invoice however many grades it has; two groups is a split billing, and
// which one she means is her call.
function groupSales(rows) {
    const n = (v) => String(v == null ? '' : v).trim().toUpperCase();
    const groups = [];
    for (const r of rows || []) {
        const k = `${n(r.invoice_no)}|${n(r.customer)}`;
        let g = groups.find((x) => x.key === k);
        if (!g) { g = { key: k, invoice_no: r.invoice_no || '', customer: r.customer || '', rows: [] }; groups.push(g); }
        g.rows.push(r);
    }
    return groups;
}

// saleInvoice.readiness speaks labels; the conversation needs field keys.
// invoice_no is left out on purpose — it is always asked for at the end
// (her "ask me"), whether or not the row already has one.
const LABEL_TO_FIELD = {
    'customer': 'customer',
    'container no': 'container_no',
    'item description': 'item',
    'weight': 'weight',
    'price': 'invoice_price',
};
const ORDER = ['customer', 'container_no', 'item', 'weight', 'invoice_price'];
const SHARED = ['customer', 'container_no'];
function missingFields(rec) {
    const r = saleInvoice.readiness({ ...rec, invoice_no: 'x' });
    const keys = r.missing.map((l) => LABEL_TO_FIELD[l]).filter(Boolean);
    return ORDER.filter((k) => keys.includes(k));
}

const QUESTION = {
    customer: 'Who is the customer?',
    container_no: "What's the container number?",
    item: "What's the item description?",
    weight: "What's the weight — in lbs or MT?",
    invoice_price: "What's the selling price — per lb or per MT?",
};
const LABEL = { customer: 'Customer', container_no: 'Container', item: 'Item', weight: 'Weight',
    invoice_price: 'Price', invoice_no: 'Invoice number', date: 'Sale date' };

function numberIn(text) {
    const m = String(text || '').replace(/(\d),(\d{3})/g, '$1$2').match(/-?\d+(?:\.\d+)?|\.\d+/);
    return m ? Number(m[0]) : null;
}
const YESNO = /^\s*(yes|yeah|yep|no|nope|ok|okay)\s*[.!]?\s*$/i;

// Her answer to ONE question. Deterministic on purpose — each question asks
// for one thing, so the whole answer is that thing; no model guesses a price.
function parseAnswer(field, text) {
    const raw = String(text || '').trim();
    const said = raw.replace(/^\s*(it'?s|it is|that'?s|the|um+|uh+)\s+/i, '').trim();
    if (!said || YESNO.test(said)) return { ok: false, ask: QUESTION[field] };
    if (field === 'customer') {
        const v = said.replace(/^(customer|buyer|consignee)(\s+name)?\s*(is|:|-)?\s*/i, '').replace(/[.!?]+$/, '').trim();
        return v ? { ok: true, patch: { customer: v } } : { ok: false, ask: QUESTION.customer };
    }
    if (field === 'container_no') {
        const m = said.match(/\b([A-Z]{4})\s?(\d{7})\b/i);
        return m ? { ok: true, patch: { container_no: (m[1] + m[2]).toUpperCase() } }
            : { ok: false, ask: "That doesn't look like a container number — four letters and seven digits, like HMMU7060866?" };
    }
    if (field === 'item') {
        const v = said.replace(/^(item|description|item description)\s*(is|:|-)?\s*/i, '').replace(/[.!?]+$/, '').trim();
        return v ? { ok: true, patch: { item: v } } : { ok: false, ask: QUESTION.item };
    }
    if (field === 'weight') {
        const n = numberIn(said);
        if (n === null || n <= 0) return { ok: false, ask: QUESTION.weight };
        const unit = /\b(mt|m\.t\.|metric|tons?|tonnes?)\b/i.test(said) ? 'mt'
            : /\b(lb|lbs|pounds?)\b/i.test(said) ? 'lb' : (n >= 1000 ? 'lb' : 'mt');
        return { ok: true, patch: { weight: n, weight_unit: unit }, inferred: !/\b(mt|metric|tons?|tonnes?|lb|lbs|pounds?)\b/i.test(said) };
    }
    if (field === 'invoice_price') {
        let n = numberIn(said);
        if (n === null || n <= 0) return { ok: false, ask: QUESTION.invoice_price };
        const cents = /\bcents?\b/i.test(said);
        if (cents) n = Math.round(n * 1000) / 100000;
        const unit = cents || /\b(lb|lbs|pounds?|per pound)\b/i.test(said) ? 'lb'
            : /\b(mt|metric|tons?|tonnes?)\b/i.test(said) ? 'mt'
            : (n < bills.PER_LB_CEILING ? 'lb' : 'mt');
        return { ok: true, patch: { invoice_price: n, price_unit: unit },
            inferred: !cents && !/\b(lb|lbs|pounds?|mt|metric|tons?|tonnes?)\b/i.test(said) };
    }
    return { ok: false, ask: 'Say that again?' };
}

function money(n) { return typeof n === 'number' ? n.toLocaleString('en-US', { maximumFractionDigits: 3 }) : String(n); }
function describe(field, rec) {
    if (field === 'weight') return `${money(Number(rec.weight))} ${rec.weight_unit === 'mt' ? 'MT' : 'lb'}`;
    if (field === 'invoice_price') {
        const unit = rec.price_unit === 'mt' ? 'MT' : 'lb';
        const perMt = saleInvoice.ratePerMt(rec);
        return `$${money(Number(rec.invoice_price))}/${unit}${unit === 'lb' && perMt ? ` ($${money(perMt)}/MT)` : ''}`;
    }
    return String(rec[field] || '');
}

// Invoice-number answer. "yes" takes the suggestion; anything with a digit is
// her number, verbatim (the trailing container letter is hers to type).
function parseInvNo(text, suggestion) {
    const t = String(text || '').trim();
    if (/^\s*(yes|yeah|yep|ok|okay|sure|use it|go ahead|that'?s fine|fine|correct|keep it)\b/i.test(t)) {
        return suggestion ? { ok: true, inv_no: suggestion } : { ok: false };
    }
    const v = t.replace(/^(invoice\s*(number|no\.?|#)?|number|inv\s*(no\.?)?)\s*(is|:|-)?\s*/i, '').replace(/[.!?]+$/, '').trim();
    return /\d/.test(v) && v.length <= 40 ? { ok: true, inv_no: v.replace(/\s+/g, ' ').toUpperCase() } : { ok: false };
}

function parseLayout(text) {
    const t = String(text || '').toLowerCase();
    if (/\bseparate|separately|two files|split\b/.test(t)) return { separate: true, invoiceOnly: false, label: 'separate invoice and packing list' };
    if (/\b(only|just)\b.*\binvoice\b|\binvoice only\b|\bwithout (the )?packing\b|\bno packing\b/.test(t)) return { separate: false, invoiceOnly: true, label: 'invoice only' };
    if (/\b(normal|standard|usual|combined|together|one file|single|regular|default|same file)\b/.test(t)) return { separate: false, invoiceOnly: false, label: 'normal' };
    return null;
}

// Build + render + file, exactly as POST /api/sales/:id/invoice/generate
// does. Returns the saved paths as well as names, so WhatsApp can attach.
async function generate(sale, { separate = false, invoiceOnly = false } = {}) {
    const built = saleInvoice.buildFrom(sale);
    if (!built.readiness.ok) return { ok: false, missing: built.readiness.missing };
    const documentsSaved = require('./documentsSaved');
    const invoiceVersions = require('./invoiceVersions');
    const { generateInvoiceClassicPdf } = require('./invoicePdf');
    const body = built.body;
    const out = await generateInvoiceClassicPdf(body, { separate, invoiceOnly });
    const safeInv = documentsSaved.safeName(body.inv_no || body.container_no || 'INVOICE').replace(/_+/g, '_');
    const where = body.container_no || 'UNKNOWN';
    let paths;
    if (separate) {
        paths = [documentsSaved.saveInvoiceCopy(out.invoice, `${safeInv}_INVOICE.pdf`, where),
                 documentsSaved.saveInvoiceCopy(out.packing, `${safeInv}_PACKING_LIST.pdf`, where)];
    } else {
        paths = [documentsSaved.saveInvoiceCopy(out, invoiceOnly ? `${safeInv}_INVOICE.pdf` : `${safeInv}.pdf`, where)];
    }
    try { await invoiceVersions.saveInvoiceVersion(body.container_no, body); }
    catch (e) { console.error('[sale-invoice-flow] saving version history failed (non-fatal):', e.message); }
    const invoiceWeights = require('./invoiceWeights');
    const problems = invoiceWeights.weightProblems(body.line_items);
    return {
        ok: true, paths, saved_filenames: paths.map((p) => path.basename(p)),
        container_no: body.container_no, inv_no: body.inv_no, consignee: body.consignee,
        line_items: body.line_items, photos: built.photos || [], warnings: built.warnings || [],
        weight_message: problems.length ? invoiceWeights.refusalMessage(problems) : null,
    };
}


// ── IS THIS SENTENCE ASKING FOR ONE? ────────────────────────────────────────
// Shared by the WhatsApp brain (policyDecide) and the voice route, so the two
// cannot disagree about what "generate invoice for X" means.
//
// Apsara, 2026-09-21: "invoice should not create proforma". So a making verb
// plus the word invoice IS this — for a supplier ("the Inesh container"), a
// container number, or a customer ("invoice for Daekwang"). A proforma is
// asked for by name: "proforma", "pro forma" or "PI", which this refuses and
// helpers/proformaDraft still takes.
const MAKE = /\b(generate|create|make|raise|prepare|build)\b/i;
const ASKING = /^\s*(?:(?:hey\s+)?jarvis[,\s]+)?(did|do|does|have|has|was|were|is|are|who|when|where|why|how|what|which|can you tell)\b/i;
const OTHER_INVOICE_WORK = /\b(proforma|pro forma|pi\b|quote|quotation|payment|paid|unpaid|receivable|old invoice|track|record|send|sent|email|mail)\b/i;
function targetIn(text) {
    const f = String(text || '').match(/\b(?:for|from|of)\s+(?:the\s+)?(.+?)(?:\s+(?:container|containers|load|bill|bills))?(?:\s*(?:,|\.|$|\bstart|\bfrom latest|\busing|\bwith\b))/i);
    if (!f) return null;
    return f[1].replace(/^(latest|last|new|newest)\s+/i, '').replace(/\s+(latest|last|newest|new)$/i, '')
        .replace(/['’]s$/i, '').trim() || null;
}
function saleInvoiceRequest(text) {
    const t = String(text || '');
    if (!MAKE.test(t) || !/\binvoices?\b/i.test(t)) return null;
    if (ASKING.test(t) || OTHER_INVOICE_WORK.test(t)) return null;
    const cm = t.match(/\b([A-Z]{4})\s?(\d{7})\b/i);
    if (cm) return { container: (cm[1] + cm[2]).toUpperCase(), target: null };
    return { container: null, target: targetIn(t) };
}

// "invoice for Daekwang" — a CUSTOMER, so the sale side. Her newest sale
// date for that customer, one entry per invoice on it (booking + container +
// invoice number, the same gathering as saleInvoice.siblingRows).
function latestSalesFor(query) {
    const mine = sales.list().filter((x) => supplierMatches(x.customer, query));
    if (!mine.length) return { groups: [], date: null };
    const top = mine.reduce((m, x) => { const d = bills.sortableDate(x.date); return d && (!m || d > m) ? d : m; }, null);
    const onTop = top ? mine.filter((x) => bills.sortableDate(x.date) === top) : mine;
    const n = (v) => String(v == null ? '' : v).trim().toUpperCase();
    const groups = [];
    for (const r of onTop) {
        const k = `${n(r.booking_no)}|${n(r.container_no)}|${n(r.invoice_no)}|${n(r.customer)}`;
        let g = groups.find((x) => x.key === k);
        if (!g) { g = { key: k, container_no: r.container_no || '', invoice_no: r.invoice_no || '', customer: r.customer || '', rows: [] }; groups.push(g); }
        g.rows.push(r);
    }
    return { groups, date: onTop[0] ? onTop[0].date : null };
}

function pdfMedia(p) {
    try { return { mimetype: 'application/pdf', base64: fs.readFileSync(p).toString('base64'), filename: path.basename(p) }; }
    catch (e) { return null; }
}

module.exports = {
    supplierMatches, latestBillsFor, billByContainer, billById, salesForBill, salesForContainer,
    rowsFromBill, groupSales, missingFields, saleInvoiceRequest, targetIn, latestSalesFor, parseAnswer, parseInvNo, parseLayout, describe, generate, pdfMedia,
    QUESTION, LABEL, ORDER, SHARED, todayMDY,
};
