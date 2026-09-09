// ── helpers/sales.js — what a container sold for ─────────────────────────
// Apsara, 2026-09-09: "In sales tab-i want customer name,date,invoice number,
// HBL number,Proforma date,Reference,weight,invoice price,invoice amount,
// Freight charges to be there"
//
// EDGE METALS, NOT EDGE YARD. Her first sentence in that message was "This is
// for edge metals not for edge yard", and it decides where this file lives.
//
// ── WHY THIS IS NOT THE SALES THAT ALREADY EXIST ─────────────────────────
// The app already has "sales": loads with kind:'sale' (helpers/loadDrafts.js,
// helpers/pdf.js, helpers/spendReport.js all branch on it). Those are scrap
// sold OUT OF THE YARD — a buyer, a weighbridge ticket, a load sheet.
//
// Her columns are not those columns. An HBL number is a House Bill of Lading;
// a proforma date and freight charges belong to an export shipment. This is
// the freight side selling a container that went on a vessel, and bolting
// these fields onto the yard's load record would have put ocean paperwork on
// a scrap ticket and quietly changed what a yard "sale" means.
//
// So: a register of its own, and the pair to helpers/bills.js. A bill is what
// a container COST her; a sale is what it SOLD for. Same shape, same
// discipline, same arithmetic rules — deliberately, so the two tabs cannot
// disagree about what a ton is.
//
// ── THE PRICE UNIT IS bills.js's DECISION, NOT A SECOND COPY ─────────────
// Her rule, given for the bill side: "if price is in cents or less than 10
// dollars,go with net lbs*price else net mt*price". Scrap is quoted the same
// way whichever direction it is moving, so the same rule applies here — and
// it is IMPORTED rather than restated. Two implementations of one $10
// threshold is two chances to drift, and the drift would be a factor of 2204
// on an invoice. helpers/payments.js's PAYMENT_MODES comment makes the same
// argument about money constants.

const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');
const bills = require('./bills');

const round2 = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : null);
const round3 = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 1000) / 1000 : null);

// Null, not zero — same reasoning as bills.js. A missing weight is a sale
// nobody has finished, and treating it as 0 shows a confident $0 invoice.
function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[$,\s]/g, ''));
    return isFinite(n) ? n : null;
}

// ── THE ARITHMETIC ───────────────────────────────────────────────────────
// Pure and exported on its own, like bills.compute.
//
// ONE WEIGHT, NOT SIX. The bill side derives its net from gross minus four
// tares because that is what a weighbridge gives her. By the time a container
// is sold the weight is settled and she gives it directly — so this takes the
// number she typed and does not invent a tare structure she did not ask for.
// `weight_unit` says which scale that number is on.
function compute(input) {
    const s = input || {};
    const weight = num(s.weight);

    // Which scale her weight is on. Explicit wins; otherwise pounds, because
    // that is what the yard scale and the bill side both produce and a
    // five-figure number is not metric tons.
    const wUnit = s.weight_unit === 'mt' || s.weight_unit === 'lb'
        ? s.weight_unit
        : (weight === null ? null : (weight >= 1000 ? 'lb' : 'mt'));

    const lb = weight === null ? null : (wUnit === 'mt' ? round3(weight * bills.LB_PER_MT) : round3(weight));
    const mt = weight === null ? null : (wUnit === 'mt' ? round3(weight) : round3(weight / bills.LB_PER_MT));

    const price = num(s.invoice_price);
    // bills.js's threshold, imported. See the header for why this is not
    // written out again.
    const unit = s.price_unit === 'lb' || s.price_unit === 'mt'
        ? s.price_unit
        : (price === null ? null : (price < bills.PER_LB_CEILING ? 'lb' : 'mt'));

    let amount = null;
    if (price !== null && unit) {
        amount = unit === 'lb'
            ? (lb === null ? null : round2(lb * price))
            : (mt === null ? null : round2(mt * price));
    }

    // An invoice amount she typed WINS. The invoice is the document of
    // record; if our arithmetic disagrees that is a conversation to have, not
    // a number to overwrite. Identical rule to bills.js, and the difference is
    // reported rather than hidden.
    const stated = num(s.invoice_amount);
    const amountUsed = stated !== null ? stated : amount;

    const freight = num(s.freight_charges);

    // ── NET IS AFTER FREIGHT, AND IT IS NOT A GUESS ──────────────────────
    // Not one of her ten columns, so it is returned but NOT added to COLUMNS
    // below — the table shows what she asked for. It is here because the
    // totals row needs it: an invoice total that ignores freight overstates
    // what the shipment actually earned, and she asked for freight to be on
    // the row precisely because it comes off the top.
    const net = amountUsed === null ? null : round2(amountUsed - (freight || 0));

    return {
        weight_unit: wUnit,
        weight_lb: lb,
        weight_mt: mt,
        price_unit: unit,
        computed_amount: amount,
        amount: amountUsed,
        amount_is_stated: stated !== null,
        amount_differs: (stated !== null && amount !== null && Math.abs(stated - amount) >= 0.01)
            ? round2(stated - amount) : null,
        net_of_freight: net,
    };
}

// Her ten columns, in her order. `derived: true` marks the two this file
// computes, so the client renders them read-only and cannot post a total that
// does not follow from its own weight and price.
const COLUMNS = [
    { key: 'customer',       label: 'Customer name',  group: 'customer', suggest: true },
    { key: 'date',           label: 'Date',           group: 'customer', date: true },
    { key: 'reference',      label: 'Reference',      group: 'customer' },

    { key: 'invoice_no',     label: 'Invoice number', group: 'documents' },
    { key: 'hbl_no',         label: 'HBL number',     group: 'documents', placeholder: 'House B/L' },
    { key: 'proforma_date',  label: 'Proforma date',  group: 'documents', date: true },

    { key: 'weight',         label: 'Weight',         group: 'money', num: true, unit: 'lbs',
      hint: 'pounds unless you say otherwise' },
    { key: 'invoice_price',  label: 'Invoice price',  group: 'money', num: true, unit: '$',
      hint: 'under $10 is read as per lb, $10+ as per MT' },
    // Same split as bills: stored under `amount`, typed as `invoice_amount`,
    // and hers wins over the computed figure.
    { key: 'amount',         label: 'Invoice amount', group: 'money', derived: true, unit: '$',
      writeKey: 'invoice_amount', num: true, hint: 'leave blank to use the computed figure' },
    { key: 'freight_charges', label: 'Freight charges', group: 'money', num: true, unit: '$' },
];

// Her ten, in the order she listed them, for the table. The form uses GROUPS.
const TABLE_ORDER = ['customer', 'date', 'invoice_no', 'hbl_no', 'proforma_date',
    'reference', 'weight', 'invoice_price', 'amount', 'freight_charges'];

const GROUPS = [
    { id: 'customer',  label: 'Customer' },
    { id: 'documents', label: 'Documents' },
    { id: 'money',     label: 'Weight & money' },
];

const tableColumns = () => TABLE_ORDER.map((k) => COLUMNS.find((c) => c.key === k));

// A sale's own filterable columns. NOT bills' — a sale has a customer and an
// HBL number where a bill has a supplier and a container number, and reusing
// the wrong list would leave the search box quietly matching nothing.
const FILTERABLE = ['customer', 'invoice_no', 'hbl_no', 'reference'];
const filterRows = (rows, q) => bills.filterRows(rows, q, FILTERABLE);
// Same self-learning list as bills — the customers she has invoiced are the
// customers offered. See helpers/bills.js:facets.
function facets(rows) {
    const of = (f) => [...new Set((rows || []).map((r) => String(r[f] || '').trim()).filter(Boolean))].sort();
    return { customer: of('customer'), reference: of('reference') };
}

// `amount` is derived but ALSO writable — she can type the figure off the
// customer's invoice, and compute() prefers it when she does. That is why it
// is listed here explicitly instead of being taken from !derived.
const WRITABLE = COLUMNS.filter((c) => !c.derived).map((c) => c.key)
    .concat(['invoice_amount', 'price_unit', 'weight_unit', 'booking_no', 'note']);

const list = () => {
    const raw = loadJson(cfg.SALES_FILE, []);
    return Array.isArray(raw) ? raw : [];
};

function newId() {
    return `SALE_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function clean(input) {
    const out = {};
    for (const k of WRITABLE) {
        if (!Object.prototype.hasOwnProperty.call(input || {}, k)) continue;
        const v = input[k];
        out[k] = typeof v === 'string' ? v.trim() : v;
    }
    for (const k of ['weight', 'invoice_price', 'invoice_amount', 'freight_charges']) {
        if (k in out) out[k] = num(out[k]);
    }
    return out;
}

// A stored row plus its arithmetic. One function, so no caller can render a
// sale without it.
function withTotals(s) { return { ...s, ...compute(s) }; }
function listWithTotals() { return list().map(withTotals); }

function getSale(id) { return list().find((s) => s.id === id) || null; }

async function addSale(input = {}) {
    const rec = clean(input);
    if (!rec.date) throw new Error('a sale needs a date');
    if (!rec.customer) throw new Error('a sale needs a customer');
    const row = {
        id: newId(),
        ...rec,
        created_at: new Date().toISOString(),
        created_by: input.created_by || null,
    };
    await mutateJson(cfg.SALES_FILE, [], (all) => {
        const rows = Array.isArray(all) ? all : [];
        rows.push(row);
        return rows;
    });
    return withTotals(row);
}

async function editSale(id, input = {}) {
    const patch = clean(input);
    let found = null;
    let problem = null;
    await mutateJson(cfg.SALES_FILE, [], (all) => {
        const rows = Array.isArray(all) ? all : [];
        const i = rows.findIndex((r) => r.id === id);
        if (i === -1) return rows;
        // PATCH, not replace — the editLoad lesson, recorded in helpers/
        // loads.js: rebuilding a record wholesale dropped pdf_link. Ten
        // columns here and the same mistake would silently erase an HBL
        // number nobody was editing.
        const merged = { ...rows[i], ...patch, updated_at: new Date().toISOString() };
        // ── AN EDIT MUST NOT BLANK WHAT AN ADD INSISTS ON ────────────────
        // addBill/addSale refuse a row with no date or no customer, and an edit
        // that could clear either would leave a record the create path would
        // never have allowed. The client sends empty strings on edit (that is
        // how a field gets CLEARED), so this is reachable by simply deleting
        // the text and pressing Save.
        if (!merged.date) { problem = 'a sale needs a date'; return rows; }
        if (!merged.customer) { problem = 'a sale needs a customer'; return rows; }
        rows[i] = merged;
        found = rows[i];
        return rows;
    });
    if (problem) throw new Error(problem);
    if (!found) throw new Error(`no sale ${id}`);
    return withTotals(found);
}

async function deleteSale(id) {
    let gone = false;
    await mutateJson(cfg.SALES_FILE, [], (all) => {
        const rows = Array.isArray(all) ? all : [];
        const i = rows.findIndex((r) => r.id === id);
        if (i === -1) return rows;
        rows.splice(i, 1);
        gone = true;
        return rows;
    });
    if (!gone) throw new Error(`no sale ${id}`);
    return true;
}

// Column totals for the foot of the table. Only the ones that mean anything
// added up — a price per pound summed across shipments is a number with no
// meaning, and putting it under a column invites someone to read it.
function summary(rows) {
    const r = (rows || []).map(withTotals);
    const sum = (k) => round2(r.reduce((s, x) => s + (num(x[k]) || 0), 0));
    return {
        count: r.length,
        weight_lb: round3(r.reduce((s, x) => s + (x.weight_lb || 0), 0)),
        weight_mt: round3(r.reduce((s, x) => s + (x.weight_mt || 0), 0)),
        amount: sum('amount'),
        freight_charges: sum('freight_charges'),
        net_of_freight: sum('net_of_freight'),
    };
}

module.exports = {
    COLUMNS, GROUPS, TABLE_ORDER, tableColumns, WRITABLE, FILTERABLE, filterRows, facets,
    compute, withTotals, list, listWithTotals, getSale,
    addSale, editSale, deleteSale, summary,
};
