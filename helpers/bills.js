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

    // ── BALANCE IS WHAT IS STILL OWED ────────────────────────────────────
    // Her formula on 2026-09-09 was "Amount − Trucking − Advance". She then
    // removed Advance as a column, and on 2026-09-10, asked what Balance
    // should mean once payments exist, chose "Amount − Trucking − Paid".
    //
    // So the column changed question: it used to answer "what did this
    // container come to", it now answers "what do I still owe on it". Worth
    // being explicit about, because a column that quietly changes meaning is
    // one she reads the old way for a month.
    //
    // `paid` is passed IN rather than looked up here — helpers/billPayments.js
    // requires helpers/bills.js to validate allocations, so reaching back the
    // other way would be a require cycle. listWithTotals resolves it once for
    // the whole table instead of once per row.
    const paid = num(b.paid) || 0;
    const balance = amountUsed === null ? null
        : round2(amountUsed - (trucking || 0) - paid);

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
        paid: round2(paid),
        missing_tares: missing,
        // ── INCOMPLETE IS A STATE, NOT AN ERROR ──────────────────────────
        // Apsara, 2026-09-10: "if i start adding atleast one value in bill,it
        // should get autosaved."
        //
        // That settles a question I had answered wrongly. addBill used to
        // THROW without a date and a supplier — my rule, never hers — and an
        // hour earlier I extended it so an edit could not blank either. Both
        // are incompatible with how she actually works: a bill is filled in as
        // the information arrives, and the weighbridge ticket, the supplier
        // invoice and the trucker's number turn up on different days.
        //
        // So the store stopped refusing and started REPORTING, which is the
        // rule this file already followed for tares: a bill that cannot be
        // computed says why rather than showing a confident zero, and a bill
        // that is not finished says so rather than being impossible to keep.
        incomplete: ['date', 'supplier'].filter((k) => !String(b[k] || '').trim()),
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
// ── AND WHAT THE FORM NEEDS, WHICH IS NOT THE SAME THING ─────────────────
// Apsara, 2026-09-10, on the first version of the add form: "This is ugly and
// not user friendly." She was right, and one line of the screenshot was worse
// than cosmetic: TRUCKING appeared TWICE, on two identical empty boxes.
//
// That is not a mistake in her list — she has two of them, and in the TABLE
// their position tells you which is which (one sits beside Carrier, the other
// beside Advance). Stacked in a form grid, position says nothing.
//
// So a column carries three extra things, and the table keeps using `label`:
//   formLabel — what the field is called when it stands alone, out of order
//   unit      — lbs, $ — the thing that makes a number checkable
//   group     — so 23 fields arrive as four short sections instead of a wall
//
// Kept HERE rather than in the client for the same reason COLUMNS is here at
// all: the store defines what a bill is, and a second list in the dashboard
// is a copy that drifts.
const COLUMNS = [
    { key: 'supplier',         label: 'Supplier',           group: 'shipment' },
    { key: 'carrier',          label: 'Carrier',            group: 'shipment', placeholder: 'MSC, Maersk…' },
    { key: 'booking_no',       label: 'Booking no',         group: 'shipment' },
    { key: 'container_no',     label: 'Container no',       group: 'shipment', placeholder: 'MSKU1234567' },
    { key: 'seal_no',          label: 'Seal no',            group: 'shipment' },

    // Apsara, 2026-09-10: "In bill,i want photos field where url can be
    // pasted." One per line — a container gets photographed several times and
    // one box for one link would have her keeping the rest somewhere else.
    { key: 'photos',           label: 'Photos',             group: 'shipment',
      formLabel: 'Photo links', textarea: true,
      placeholder: 'paste one link per line', hint: 'http/https links only' },

    { key: 'date',             label: 'Date',               group: 'purchase', date: true },
    // Apsara, 2026-09-10: "Swap places of route and supplier". Route sits
    // where Supplier was and Supplier where Route was — her reading order,
    // not mine. The group each belongs to went with it.
    { key: 'route',            label: 'Source/Destination', group: 'purchase',
      formLabel: 'Route', placeholder: 'HOUSTON / BUSAN' },
    { key: 'invoice_no',       label: 'Invoice no',         group: 'purchase' },
    { key: 'description',      label: 'Item description',   group: 'purchase', placeholder: 'Auto cast, shredded…' },

    { key: 'gross',            label: 'Gross',              group: 'weights', unit: 'lbs', num: true },
    { key: 'truck',            label: 'Truck',              group: 'weights', unit: 'lbs', num: true, formLabel: 'Truck tare' },
    { key: 'container',        label: 'Container',          group: 'weights', unit: 'lbs', num: true, formLabel: 'Container tare' },
    { key: 'chassis',          label: 'Chassis',            group: 'weights', unit: 'lbs', num: true, formLabel: 'Chassis tare' },
    { key: 'boxes',            label: 'Boxes',              group: 'weights', unit: 'lbs', num: true, formLabel: 'Boxes tare' },
    { key: 'total',            label: 'Total',              group: 'weights', unit: 'lbs', derived: true, formLabel: 'Total tare' },
    { key: 'net_lb',           label: 'Net weight (lbs)',   group: 'weights', unit: 'lbs', derived: true },
    { key: 'net_mt',           label: 'Net weight (MT)',    group: 'weights', unit: 'MT',  derived: true },

    { key: 'supplier_price',   label: 'Supplier price',     group: 'money', unit: '$', num: true,
      formLabel: 'Supplier price', hint: 'under $10 is read as per lb, $10+ as per MT' },
    // Stored under `amount`, but the field she TYPES is
    // supplier_invoice_amount — compute() prefers hers over the computed one.
    // `writeKey` is what the form must post; without it this column had no
    // input at all and the stated-amount branch was unreachable.
    { key: 'amount',           label: 'Supplier invoice amount', group: 'money', unit: '$', derived: true,
      writeKey: 'supplier_invoice_amount', num: true,
      hint: 'leave blank to use the computed figure' },
    // ── THE TRUCKER SITS WITH WHAT THE TRUCKING COST ─────────────────────
    // Apsara, 2026-09-10: "Trucker needs to there next to Trucking Amount in
    // bill." It used to live up beside Carrier, which is where her original
    // column list put it — who hauled it and what the haul cost were at
    // opposite ends of a 22-column table.
    //
    // AND IT IS CALLED "Trucker" NOW. Her word, and it retires the workaround
    // underneath the original complaint: two different columns were both
    // headed "Trucking", so the form needed a separate formLabel to tell them
    // apart. One of them having its own name fixes that at the source instead.
    { key: 'trucking_company', label: 'Trucker',            group: 'money',
      placeholder: 'who hauled it' },
    { key: 'trucking_amount',  label: 'Trucking',           group: 'money', unit: '$', num: true,
      formLabel: 'Trucking cost' },
    // ── ADVANCE REMOVED ──────────────────────────────────────────────────
    // Apsara, 2026-09-10: "Remove advance on this". It was in her original
    // 23 and it is out, which also drops it from her balance formula — that
    // was "Amount − Trucking − Advance" and is now "Amount − Trucking".
    //
    // Safe to remove outright rather than hide: bills.json has never existed
    // in production (nothing imported helpers/bills.js until today), so there
    // is no stored advance to strand. If there had been, this would need a
    // migration instead — a column dropped from a form is still a number
    // sitting in a record affecting a balance.
    { key: 'balance',          label: 'Balance',            group: 'money', unit: '$', derived: true },
];

// The order she READS them in, which is the order she gave and not the order
// the form groups them. The table walks this; the form walks GROUPS.
// ── CARRIER IS ON THE FORM BUT NOT IN THE TABLE ──────────────────────────
// Apsara, 2026-09-10: "on bill after saving,i dont want carrier to be
// displayed.on edit it can be there."
//
// So it is absent from TABLE_ORDER and still present in COLUMNS — the form
// walks COLUMNS, the table walks this. It is still STORED and still comes off
// the booking on pre-fill; it just is not one of the columns she reads across.
// Nothing about the record changed, which is why it is still there to edit.
const TABLE_ORDER = ['route', 'date', 'supplier', 'invoice_no',
    'photos',
    'booking_no', 'container_no', 'seal_no', 'description', 'gross', 'truck', 'container',
    'chassis', 'boxes', 'total', 'net_lb', 'net_mt', 'supplier_price', 'amount',
    'trucking_company', 'trucking_amount', 'balance'];

// ── FILTERS, AND SEVERAL AT ONCE ─────────────────────────────────────────
// Apsara, 2026-09-10: "also i want filter.ultiple filters can also be
// applied."
//
// SERVER-SIDE, like everything else here, and for a reason beyond consistency:
// summary() has to agree with what she is looking at. Filtering in the browser
// would leave the totals row summing rows that are no longer on screen, which
// is a worse bug than having no filter at all — she would read a balance that
// belongs to a different set of bills.
//
// EVERY FILTER IS AN "AND". That is what "multiple filters can also be
// applied" means: supplier Eccomelt AND booking 272766480 AND this month
// narrows; it does not accumulate matches. Any field left blank is not a
// filter at all rather than a filter matching nothing.
//
// `q` is a free-text sweep across the text columns — the one box that finds a
// container number without her having to know which field it lives in.
const FILTERABLE = ['supplier', 'carrier', 'booking_no', 'container_no',
    'trucking_company', 'invoice_no', 'seal_no', 'route', 'description'];

// MM/DD/YYYY (how she types and how bookings.json stores) to a sortable
// YYYY-MM-DD, so a range comparison is a string comparison. Anything it
// cannot read returns null and is simply not range-filtered — a date it does
// not understand must not silently drop the row.
function sortableDate(v) {
    const s = String(v || '').trim();
    let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    return null;
}

// `fields` lets another store reuse this with its OWN columns. Sales has
// customer, HBL and reference where a bill has supplier and container — and
// passing bills' list would have made the Sales search box find nothing,
// silently. Defaults to a bill's fields so existing callers are unchanged.
function filterRows(rows, q = {}, fields = FILTERABLE) {
    const FILTERABLE = fields;
    const has = (v) => v !== undefined && v !== null && String(v).trim() !== '';
    const norm = (v) => String(v === null || v === undefined ? '' : v).toLowerCase();
    const text = has(q.q) ? norm(q.q).trim() : null;
    const from = has(q.from) ? sortableDate(q.from) : null;
    const to = has(q.to) ? sortableDate(q.to) : null;

    return (rows || []).filter((r) => {
        for (const f of FILTERABLE) {
            if (!has(q[f])) continue;
            if (!norm(r[f]).includes(norm(q[f]).trim())) return false;
        }
        if (text && !FILTERABLE.some((f) => norm(r[f]).includes(text))) return false;
        if (from || to) {
            const d = sortableDate(r.date);
            // A row with an unreadable date is kept, not dropped. Dropping it
            // would hide a bill from a date range it might well belong to,
            // and a hidden bill is one she stops chasing.
            if (d) {
                if (from && d < from) return false;
                if (to && d > to) return false;
            }
        }
        return true;
    });
}

// The values actually present, so the dropdowns can only offer something that
// will match. A filter list built from a hardcoded set offers choices that
// return nothing, which reads as broken.
function facets(rows) {
    const out = {};
    for (const f of ['supplier', 'carrier', 'trucking_company']) {
        out[f] = [...new Set((rows || []).map((r) => String(r[f] || '').trim()).filter(Boolean))].sort();
    }
    return out;
}

const GROUPS = [
    { id: 'shipment', label: 'Shipment' },
    { id: 'purchase', label: 'Purchase' },
    // ── ALL FIVE WEIGHTS ON ONE LINE ─────────────────────────────────────
    // Apsara, 2026-09-10: "weights should be in single line". The auto-fit
    // grid wrapped them 4 + 1, which puts Boxes on a row of its own and makes
    // it read like a different kind of thing. They are one measurement taken
    // five ways and they belong on one line.
    { id: 'weights',  label: 'Weights', cols: 5 },
    { id: 'money',    label: 'Money' },
];

// Her 23, in her order, for the table.
const tableColumns = () => TABLE_ORDER.map((k) => COLUMNS.find((c) => c.key === k));

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

// ── A PASTED LINK IS RENDERED, SO IT IS CHECKED ──────────────────────────
// These come back out into the table as clickable links. A "javascript:..."
// URL pasted into that field would run when clicked, so ONLY http and https
// survive — anything else is dropped rather than stored and rendered.
//
// Split on newlines, commas and whitespace, because "paste one per line" is
// what the box says and not necessarily what a paste from Drive or WhatsApp
// produces. De-duplicated, order kept.
function cleanPhotos(v) {
    if (v === null || v === undefined || v === '') return [];
    const parts = Array.isArray(v) ? v : String(v).split(/[\s,]+/);
    const out = [];
    for (const raw of parts) {
        const u = String(raw || '').trim().replace(/[),.]+$/, '');
        if (!u) continue;
        let ok = false;
        try { ok = /^https?:$/.test(new URL(u).protocol); } catch (e) { ok = false; }
        if (ok && !out.includes(u)) out.push(u);
    }
    return out;
}

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
                     'supplier_price', 'supplier_invoice_amount', 'trucking_amount']) {
        if (k in out) out[k] = num(out[k]);
    }
    if ('photos' in out) out.photos = cleanPhotos(out.photos);
    return out;
}

// A stored row plus everything derived from it. One function, so no caller
// can render a bill without its arithmetic.
function withTotals(b) {
    return { ...b, ...compute(b) };
}

function listWithTotals() {
    // One pass over the payments for the whole table, not one per row.
    let paid = {};
    try { paid = require('./billPayments').paidByBill(); }
    catch (e) { console.warn('[BILLS] could not read payments:', e.message); }
    return list().map((b) => withTotals({ ...b, paid: paid[b.id] || 0 }));
}

async function addBill(input = {}) {
    const rec = clean(input);
    // Deliberately NOT refused for a missing date or supplier — see the
    // `incomplete` note in compute(). What IS refused is a bill with nothing
    // in it at all: "at least one value" is her own threshold, and a row
    // created by opening a form and closing it again is litter.
    if (!Object.values(rec).some((v) => v !== null && v !== undefined && String(v).trim() !== ''
                                        && !(Array.isArray(v) && !v.length))) {
        throw new Error('a bill needs at least one value');
    }
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
    let problem = null;
    await mutateJson(cfg.BILLS_FILE, [], (all) => {
        const rows = Array.isArray(all) ? all : [];
        const i = rows.findIndex((r) => r.id === id);
        if (i === -1) return rows;
        // PATCH, not replace. helpers/loads.js carries a comment about
        // editLoad rebuilding a record wholesale and dropping pdf_link; a bill
        // has twenty-three columns and the same mistake here would silently
        // erase a seal number nobody was editing.
        const merged = { ...rows[i], ...patch, updated_at: new Date().toISOString() };
        // The date/supplier guard that used to live here is GONE, on
        // purpose — see compute()'s `incomplete` note. Autosave writes a bill
        // the moment she types one value, so a rule requiring two specific
        // fields would make her own workflow unsaveable. What is missing is
        // reported on the row instead.
        rows[i] = merged;
        found = rows[i];
        return rows;
    });
    if (problem) throw new Error(problem);
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
        balance: sum('balance'),
    };
}

module.exports = {
    COLUMNS, GROUPS, TABLE_ORDER, tableColumns, WRITABLE, LB_PER_MT, PER_LB_CEILING,
    FILTERABLE, filterRows, facets, sortableDate, cleanPhotos,
    compute, withTotals, list, listWithTotals, addBill, editBill, deleteBill, summary,
};
