// ── helpers/bills.js — what a container of metal cost ────────────────────
// Apsara, 2026-09-09: "i want to build a bill tab which contains
// Source/Destination, Carrier, TRUCKING, Date, SUPPLIER, Invoice no, Booking
// no, Container no, Seal no, item Description, GROSS, Truck, container,
// Chassis, Boxes, Total, Net weight(lbs), Net weight(MT), supplier price,
// Supplier invoice amount, Trucking, Advance, Balance in one tab"
//
// EDGE METALS, NOT EDGE YARD — her first sentence. This is the freight side:
// a purchase bill per container, against a booking that already exists. The
// yard's own loads/inventory/petty-cash ledgers are a different business and
// share nothing with this file.
//
// ── EVERY NUMBER THAT CAN BE DERIVED, IS ─────────────────────────────────
// Her answer when asked: net comes from the tares, not from typing. So six of
// the twenty-three columns are computed here and nowhere else:
//
//   Total            = truck + container + chassis + boxes   (the tares)
//   Net weight (lbs) = gross − Total
//   Net weight (MT)  = lbs ÷ 2204.62
//   Supplier amount  = net × supplier price   (unit inferred — see below)
//   Balance          = amount − trucking − advance
//
// SERVER-SIDE, so the website, the app and anything printed agree. The same
// reasoning as helpers/payments.js's PAYMENT_MODES: three implementations of
// one sum is two chances to disagree about money.
//
// ── THE PRICE UNIT IS INFERRED, AND THAT NEEDS SAYING OUT LOUD ───────────
// Her rule, verbatim: "if price is in cents or less than 10 dollars, go with
// net lbs*price else net mt*price". Scrap is quoted either way — $0.32/lb or
// $700/MT — and the magnitude tells you which she meant.
//
// It is a good heuristic and it is still a GUESS ABOUT MONEY. Getting it
// wrong does not shade a total by a few percent; lbs and MT differ by 2204,
// so a mis-keyed price produces a figure wrong by three orders of magnitude,
// in a column she pays from.
//
// So the unit that was used is RETURNED WITH THE AMOUNT and shown on the row
// — her choice when asked, and the only thing that makes a bad inference
// visible at a glance rather than buried in a total. And `price_unit` can be
// set explicitly on the record, which overrides the inference entirely: the
// day she buys something at $8/MT, she can say so.

const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

// One short ton is 2000 lb; a METRIC ton is 2204.62262 lb. Scrap contracts in
// the US quote both, and using the wrong one is a 10% error in her favour or
// against it. Spelled out rather than left as a magic number.
const LB_PER_MT = 2204.62262;

// Below this, a price is read as dollars per POUND. Her rule.
const PER_LB_CEILING = 10;

const round2 = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : null);
// Weights keep three decimals: an MT figure rounded to two loses about a
// kilogram, and she reconciles these against a weighbridge ticket.
const round3 = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 1000) / 1000 : null);

// Null, not zero. A missing tare is NOT a zero tare — a container with no
// chassis weight recorded is a bill somebody has not finished, and treating
// the gap as 0 silently inflates the net weight and therefore the amount.
// Every caller below is written to notice the null.
function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[$,\s]/g, ''));
    return isFinite(n) ? n : null;
}

// ── THE ARITHMETIC ───────────────────────────────────────────────────────
// Pure, exported, and tested on its own. Takes the raw fields she typed and
// returns everything derived from them, plus what is missing — because a bill
// that cannot be computed has to say why rather than show a confident zero.
function compute(input) {
    const b = input || {};
    const gross = num(b.gross);
    const tare = {
        truck: num(b.truck),
        container: num(b.container),
        chassis: num(b.chassis),
        boxes: num(b.boxes),
    };

    // Present tares only. A bill with three of the four filled in is still
    // worth totalling — she enters them as the weighbridge gives them — but
    // the row must say which are missing rather than quietly treat them as 0.
    const missing = Object.keys(tare).filter((k) => tare[k] === null);
    const total = Object.keys(tare).reduce((s, k) => s + (tare[k] || 0), 0);

    const netLb = gross === null ? null : round3(gross - total);
    const netMt = netLb === null ? null : round3(netLb / LB_PER_MT);

    const price = num(b.supplier_price);
    // Explicit beats inferred, always. `price_unit` is how she overrides the
    // magnitude rule for the case it gets wrong.
    const unit = b.price_unit === 'lb' || b.price_unit === 'mt'
        ? b.price_unit
        : (price === null ? null : (price < PER_LB_CEILING ? 'lb' : 'mt'));

    let amount = null;
    if (price !== null && unit) {
        if (unit === 'lb') amount = netLb === null ? null : round2(netLb * price);
        else amount = netMt === null ? null : round2(netMt * price);
    }
    // A supplier invoice amount she typed herself WINS over the computed one.
    // The supplier's invoice is the document of record; if it disagrees with
    // our arithmetic that is a conversation to have, not a number to overwrite.
    const stated = num(b.supplier_invoice_amount);
    const amountUsed = stated !== null ? stated : amount;

    const trucking = num(b.trucking_amount);
    const advance = num(b.advance);

    // Her formula, verbatim from the answer: Amount − Trucking − Advance.
    const balance = amountUsed === null ? null
        : round2(amountUsed - (trucking || 0) - (advance || 0));

    return {
        total: gross === null && !Object.keys(tare).some((k) => tare[k] !== null) ? null : round3(total),
        net_lb: netLb,
        net_mt: netMt,
        price_unit: unit,
        // What the arithmetic says, kept even when she typed her own amount —
        // so a disagreement between our sum and the supplier's invoice is
        // visible instead of lost.
        computed_amount: amount,
        amount: amountUsed,
        amount_is_stated: stated !== null,
        amount_differs: (stated !== null && amount !== null && Math.abs(stated - amount) >= 0.01)
            ? round2(stated - amount) : null,
        balance,
        missing_tares: missing,
    };
}

const list = () => {
    const raw = loadJson(cfg.BILLS_FILE, []);
    return Array.isArray(raw) ? raw : [];
};

function newId() {
    return `BILL_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// The columns she named, in her order, so the table and the store cannot
// disagree about what a bill is. `key` is the stored field; `label` is what
// she called it; `derived` marks the six this file computes.
const COLUMNS = [
    { key: 'route',            label: 'Source/Destination' },
    { key: 'carrier',          label: 'Carrier' },
    { key: 'trucking_company', label: 'Trucking' },
    { key: 'date',             label: 'Date' },
    { key: 'supplier',         label: 'Supplier' },
    { key: 'invoice_no',       label: 'Invoice no' },
    { key: 'booking_no',       label: 'Booking no' },
    { key: 'container_no',     label: 'Container no' },
    { key: 'seal_no',          label: 'Seal no' },
    { key: 'description',      label: 'Item description' },
    { key: 'gross',            label: 'Gross' },
    { key: 'truck',            label: 'Truck' },
    { key: 'container',        label: 'Container' },
    { key: 'chassis',          label: 'Chassis' },
    { key: 'boxes',            label: 'Boxes' },
    { key: 'total',            label: 'Total',              derived: true },
    { key: 'net_lb',           label: 'Net weight (lbs)',   derived: true },
    { key: 'net_mt',           label: 'Net weight (MT)',    derived: true },
    { key: 'supplier_price',   label: 'Supplier price' },
    { key: 'amount',           label: 'Supplier invoice amount', derived: true },
    { key: 'trucking_amount',  label: 'Trucking' },
    { key: 'advance',          label: 'Advance' },
    { key: 'balance',          label: 'Balance',            derived: true },
];

// Fields a client may write. Everything else on a stored bill is derived or
// housekeeping, and accepting it from a request would let a client post a
// balance that does not follow from its own weights.
// `supplier_invoice_amount` is listed EXPLICITLY, and it has to be. Her
// "Supplier invoice amount" column is stored under the key `amount`, which is
// marked derived — so the filter below excluded it and there was no way for
// her to type the figure off the supplier's invoice at all. compute()'s
// stated-amount-wins branch, and the amount_differs warning that goes with
// it, were both unreachable through the API: dead code guarding nothing.
//
// Found 2026-09-10 by the test that checks her 23 columns are all writable
// or computed. The arithmetic had been right the whole time and one of her
// columns simply could not be filled in.
const WRITABLE = COLUMNS.filter((c) => !c.derived).map((c) => c.key)
    .concat(['supplier_invoice_amount', 'price_unit', 'note']);

function clean(input) {
    const out = {};
    for (const k of WRITABLE) {
        if (!Object.prototype.hasOwnProperty.call(input || {}, k)) continue;
        const v = input[k];
        out[k] = typeof v === 'string' ? v.trim() : v;
    }
    // Typed as a number where it is one, so the arithmetic never depends on a
    // client having sent the right JSON type.
    for (const k of ['gross', 'truck', 'container', 'chassis', 'boxes',
                     'supplier_price', 'supplier_invoice_amount', 'trucking_amount', 'advance']) {
        if (k in out) out[k] = num(out[k]);
    }
    return out;
}

// A stored row plus everything derived from it. One function, so no caller
// can render a bill without its arithmetic.
function withTotals(b) {
    return { ...b, ...compute(b) };
}

function listWithTotals() { return list().map(withTotals); }

async function addBill(input = {}) {
    const rec = clean(input);
    if (!rec.date) throw new Error('a bill needs a date');
    if (!rec.supplier) throw new Error('a bill needs a supplier');
    const row = {
        id: newId(),
        ...rec,
        created_at: new Date().toISOString(),
        created_by: input.created_by || null,
    };
    await mutateJson(cfg.BILLS_FILE, [], (all) => {
        const rows = Array.isArray(all) ? all : [];
        rows.push(row);
        return rows;
    });
    return withTotals(row);
}

async function editBill(id, input = {}) {
    const patch = clean(input);
    let found = null;
    await mutateJson(cfg.BILLS_FILE, [], (all) => {
        const rows = Array.isArray(all) ? all : [];
        const i = rows.findIndex((r) => r.id === id);
        if (i === -1) return rows;
        // PATCH, not replace. helpers/loads.js carries a comment about
        // editLoad rebuilding a record wholesale and dropping pdf_link; a bill
        // has twenty-three columns and the same mistake here would silently
        // erase a seal number nobody was editing.
        rows[i] = { ...rows[i], ...patch, updated_at: new Date().toISOString() };
        found = rows[i];
        return rows;
    });
    if (!found) throw new Error(`no bill ${id}`);
    return withTotals(found);
}

async function deleteBill(id) {
    let gone = false;
    await mutateJson(cfg.BILLS_FILE, [], (all) => {
        const rows = Array.isArray(all) ? all : [];
        const i = rows.findIndex((r) => r.id === id);
        if (i === -1) return rows;
        rows.splice(i, 1);
        gone = true;
        return rows;
    });
    if (!gone) throw new Error(`no bill ${id}`);
    return true;
}

// Column totals for the foot of the table. Only the ones that mean anything
// added up — summing a price per pound across containers is a number with no
// meaning, and putting it under a column invites someone to read it.
function summary(rows) {
    const r = (rows || []).map(withTotals);
    const sum = (k) => round2(r.reduce((s, x) => s + (num(x[k]) || 0), 0));
    return {
        count: r.length,
        net_lb: round3(r.reduce((s, x) => s + (x.net_lb || 0), 0)),
        net_mt: round3(r.reduce((s, x) => s + (x.net_mt || 0), 0)),
        amount: sum('amount'),
        trucking_amount: sum('trucking_amount'),
        advance: sum('advance'),
        balance: sum('balance'),
    };
}

module.exports = {
    COLUMNS, WRITABLE, LB_PER_MT, PER_LB_CEILING,
    compute, withTotals, list, listWithTotals, addBill, editBill, deleteBill, summary,
};
