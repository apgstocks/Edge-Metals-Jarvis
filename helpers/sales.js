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

    // ── CHARGES ──────────────────────────────────────────────────────────
    // freight_charges predates the charge list and is still written by rows
    // entered before 2026-09-10. Rather than leave that money uncounted, a
    // legacy value with no charge list becomes one — so nothing disappears
    // and nothing is counted twice. net_of_freight keeps its old meaning
    // exactly, because three tests and the totals strip read it.
    let charges = [];
    try { charges = cleanCharges(s.charges); } catch (e) { charges = []; }
    if (!charges.length && freight) {
        charges = [{ id: 'CHG_LEGACY_FREIGHT', what: 'Freight', amount: round2(freight),
                     direction: 'out',
                     why: 'Entered as the Freight charges column before charges had notes.' }];
    }
    const sumWhere = (d) => round2(charges.filter((c) => c.direction === d)
        .reduce((t, c) => t + c.amount, 0)) || 0;
    const chargesIn = sumWhere('in');    // the customer pays these on top
    const chargesOut = sumWhere('out');  // Edge Metals pays these

    // ── COMMISSION ───────────────────────────────────────────────────────
    // Apsara, 2026-09-10, asked which weight it runs on: "The invoiced weight
    // (sale)". So it follows the document the customer holds and moves if the
    // invoice is revised — deliberately NOT the bill's net weight, which can
    // differ after reweighing at destination.
    const perMt = num(s.commission_per_mt);
    const commissionComputed = (perMt === null || mt === null) ? null : round2(mt * perMt);
    const commissionStated = num(s.commission_amount);
    const commission = commissionStated !== null ? round2(commissionStated) : commissionComputed;

    // What the customer owes: the invoice plus anything rebilled to them.
    const receivable = amountUsed === null ? null : round2(amountUsed + chargesIn);

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

        charges,
        charges_in_total: chargesIn,
        charges_out_total: chargesOut,
        receivable,
        commission_computed: commissionComputed,
        commission_amount: commission,
        commission_is_stated: commissionStated !== null,
        // Everything this container costs Edge Metals on the sale side. The
        // purchase side (supplier + trucking) lives on the matching Bill, and
        // the two join on booking + container.
        sale_side_cost: round2(chargesOut + (commission || 0)),
    };
}

// ── OTHER CHARGES, EACH WITH A REASON ────────────────────────────────────
// Apsara, 2026-09-10, asked which direction freight money flows: "i want to
// have other charges,with a note symbol,so that it will have detailed
// description of what charged and sample why?"
//
// A better answer than the question. A fixed Freight column can state that
// $450 exists and can never state that it is three days' detention at Busan
// caused by the customer's late clearance — which is the only form in which
// that number can be defended when they query the invoice three months on.
// So: a list, and the note is REQUIRED. A charge nobody can explain is a
// charge that gets written off.
//
// DIRECTION IS PER CHARGE, NOT PER COMPANY. Ocean freight paid to the carrier
// and detention rebilled to the customer sit on the same container and move
// opposite ways. One flag on the store could not have said that, and the
// money would have been added where it should have been subtracted.
const CHARGE_DIRECTIONS = ['in', 'out'];   // in = customer pays me, out = I pay

function cleanCharges(input) {
    const out = [];
    for (const c of (Array.isArray(input) ? input : [])) {
        if (!c) continue;
        const what = String(c.what || '').trim();
        const amount = round2(num(c.amount));
        const why = String(c.why || c.note || '').trim();
        // A blank line in the form is not an error, it is a blank line.
        if (!what && amount === null && !why) continue;
        if (!what) throw new Error('a charge needs a name — what is it for?');
        if (amount === null || amount <= 0) throw new Error(`"${what}" needs an amount greater than zero`);
        if (!why) throw new Error(`"${what}" needs a note saying why — that is the whole point of it being a charge and not a column`);
        const direction = CHARGE_DIRECTIONS.includes(String(c.direction || '').trim())
            ? String(c.direction).trim()
            : null;
        if (!direction) {
            throw new Error(`"${what}" needs to say whether you pay it or the customer does`);
        }
        // ── A STABLE ID PER CHARGE ───────────────────────────────────────
        // helpers/salesSettlements.js pays these off one at a time, so an
        // allocation has to name WHICH charge. By array index it would follow
        // the wrong charge the first time one is deleted from the middle —
        // and it would follow it silently, moving a settled freight payment
        // onto an unrelated detention line. An id she never sees, minted once
        // and preserved on every later save.
        const id = String((c && c.id) || '').trim()
            || `CHG_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
        out.push({ id, what, amount, direction, why });
    }
    return out;
}

// Her ten columns, in her order. `derived: true` marks the two this file
// computes, so the client renders them read-only and cannot post a total that
// does not follow from its own weight and price.
// How she gets paid. A closed list: LC and TT are the two, and anything else
// in this box is a typo rather than a third arrangement.
const TERMS = ['LC', 'TT'];

// ── AND HOW IT SHIPS, WHICH IS A DIFFERENT QUESTION ──────────────────────
// Apsara, 2026-09-10: "rename terms with payment terms and next to it should
// be shipment terms."
//
// Two things were living under one word. LC/TT says when the money moves;
// FOB/CIF says where her responsibility for the container ends — and that
// second one decides whether ocean freight is her cost or the customer's,
// which is exactly the charge-direction question the charge list asks per
// line. Suggested rather than enforced: Incoterms have editions and she
// trades on terms this file has no business refusing.
const SHIPMENT_TERMS = ['FOB', 'CFR', 'CIF', 'EXW', 'FAS', 'DAP', 'DDP'];

const COLUMNS = [
    // ── BOOKING FIRST, THEN CONTAINER ────────────────────────────────────
    // Apsara, 2026-09-10: "bookng first then container no", correcting the
    // mockup. It is also the correct order for a reason worth writing down:
    // a container number is NOT unique — MSKU1111111 sails again next year
    // with different metal in it. The booking is what makes it unique, so the
    // booking is the key and the container is the label under it. Reading
    // booking-first groups the containers under their shipment, which is how
    // the business thinks about them, and it matches helpers/bills.js so the
    // two tables join on the same pair.
    { key: 'booking_no',     label: 'Booking no',     group: 'shipment' },
    { key: 'container_no',   label: 'Container no',   group: 'shipment' },
    { key: 'terms',           label: 'Payment terms',  group: 'shipment', choices: TERMS,
      hint: 'LC or TT — when the money moves' },
    { key: 'shipment_terms',  label: 'Shipment terms', group: 'shipment', choices: SHIPMENT_TERMS,
      suggest: true, hint: 'FOB, CFR, CIF … — where your responsibility ends' },
    { key: 'item',            label: 'Item',           group: 'shipment', suggest: true },

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
    // Commission runs off the INVOICED weight — her answer when asked, over
    // the purchased weight on the bill. commission_amount is derived and also
    // writable, same rule as the invoice amount: an agent's own figure wins.
    { key: 'commission_per_mt', label: 'Commission / MT', group: 'money', num: true, unit: '$',
      hint: 'per metric ton of the invoiced weight' },
    { key: 'commission_amount', label: 'Commission amount', group: 'money', derived: true,
      unit: '$', writeKey: 'commission_amount', num: true,
      hint: 'leave blank to use weight x rate' },

    // Filled from helpers/salesReceipts.js in listWithTotals, never typed.
    // "Payment received amount" from her list — as a figure that follows from
    // the receipts, so it cannot say settled while the bank says otherwise.
    { key: 'received',       label: 'Received',       group: 'money', derived: true, unit: '$' },
    { key: 'balance',        label: 'Balance',        group: 'money', derived: true, unit: '$' },
];

// `freight_charges` is GONE from the columns and deliberately still writable:
// rows entered before 2026-09-10 carry it, compute() folds it into the charge
// list so the money is not lost, and the totals strip still reads
// net_of_freight. New charges go in `charges`, where they can carry a note.
const LEGACY_WRITABLE = ['freight_charges'];

// Her ten, in the order she listed them, for the table. The form uses GROUPS.
// Her order, 2026-09-10: "i wnt proforma date on right of item .next to it
// should be reference .rename terms with payment terms and next to it should
// be shipment terms."
const TABLE_ORDER = ['booking_no', 'container_no', 'date', 'hbl_no', 'invoice_no',
    'customer', 'terms', 'shipment_terms', 'item', 'proforma_date', 'reference',
    'weight', 'invoice_price', 'amount', 'received', 'balance'];

const GROUPS = [
    { id: 'shipment',  label: 'Shipment' },
    { id: 'customer',  label: 'Customer' },
    { id: 'documents', label: 'Documents' },
    { id: 'money',     label: 'Weight & money' },
];

const tableColumns = () => TABLE_ORDER.map((k) => COLUMNS.find((c) => c.key === k));

// A sale's own filterable columns. NOT bills' — a sale has a customer and an
// HBL number where a bill has a supplier and a container number, and reusing
// the wrong list would leave the search box quietly matching nothing.
const FILTERABLE = ['customer', 'invoice_no', 'hbl_no', 'reference',
    'booking_no', 'container_no', 'item', 'terms', 'shipment_terms'];
const filterRows = (rows, q) => bills.filterRows(rows, q, FILTERABLE);
// Same self-learning list as bills — the customers she has invoiced are the
// customers offered. See helpers/bills.js:facets.
function facets(rows) {
    const of = (f) => [...new Set((rows || []).map((r) => String(r[f] || '').trim()).filter(Boolean))].sort();
    return { customer: of('customer'), reference: of('reference'),
             item: of('item'), terms: of('terms'),
             // Her own past values first, then the standard ones, so a term
             // she actually uses is at the top and an unused Incoterm is
             // still one keystroke away.
             shipment_terms: [...new Set([...of('shipment_terms'), ...SHIPMENT_TERMS])],
             booking_no: of('booking_no'), container_no: of('container_no') };
}

// `amount` is derived but ALSO writable — she can type the figure off the
// customer's invoice, and compute() prefers it when she does. That is why it
// is listed here explicitly instead of being taken from !derived.
const WRITABLE = COLUMNS.filter((c) => !c.derived).map((c) => c.key)
    .concat(['invoice_amount', 'commission_amount', 'price_unit', 'weight_unit',
             'charges', 'note'])
    .concat(LEGACY_WRITABLE);

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
    for (const k of ['weight', 'invoice_price', 'invoice_amount', 'freight_charges',
                     'commission_per_mt', 'commission_amount']) {
        if (k in out) out[k] = num(out[k]);
    }
    // Charges are validated on the way IN, not on the way out: a charge with
    // no note must fail at the point she saves it, where she still remembers
    // why she typed it, rather than being quietly dropped from a total later.
    if ('charges' in out) out.charges = cleanCharges(out.charges);
    // Uppercased, not refused: "cfr" and "CFR" are the same term, and a list
    // this file only suggests is not a list it may reject.
    if ('shipment_terms' in out && out.shipment_terms) {
        out.shipment_terms = String(out.shipment_terms).trim().toUpperCase();
    }
    if ('terms' in out && out.terms) {
        const t = TERMS.find((x) => x.toLowerCase() === String(out.terms).toLowerCase());
        if (!t) throw new Error(`terms must be ${TERMS.join(' or ')}`);
        out.terms = t;
    }
    return out;
}

// A stored row plus its arithmetic. One function, so no caller can render a
// sale without it.
function withTotals(s) { return { ...s, ...compute(s) }; }

// ── BOOKING, THEN CONTAINER WITHIN IT ────────────────────────────────────
// The order she asked for, applied where the table is built rather than in
// the client, so the website, the phone and anything reading the route all
// agree. Blank bookings sort last: a row with no booking is unfinished, not
// first in the alphabet.
function sortRows(rows) {
    const key = (r) => [String(r.booking_no || '').trim().toUpperCase(),
                        String(r.container_no || '').trim().toUpperCase()];
    return [...(rows || [])].sort((a, b) => {
        const [ab, ac] = key(a); const [bb, bc] = key(b);
        if (!ab !== !bb) return ab ? -1 : 1;
        if (ab !== bb) return ab < bb ? -1 : 1;
        if (ac !== bc) return ac < bc ? -1 : 1;
        return 0;
    });
}

// ── THE SAME CONTAINER TWICE UNDER ONE BOOKING ───────────────────────────
// Reported, never refused. A duplicate is usually a typo and occasionally
// real (a container split across two invoices), and this file is not in a
// position to tell the difference — but silence would let the margin join
// against helpers/bills.js double-count, which is the failure nobody finds
// until a month is closed.
function duplicates(rows) {
    const seen = new Map();
    for (const r of (rows || [])) {
        const bk = String(r.booking_no || '').trim().toUpperCase();
        const cn = String(r.container_no || '').trim().toUpperCase();
        if (!bk || !cn) continue;
        const k = `${bk}|${cn}`;
        if (!seen.has(k)) seen.set(k, { booking_no: r.booking_no, container_no: r.container_no, ids: [] });
        seen.get(k).ids.push(r.id);
    }
    return [...seen.values()].filter((d) => d.ids.length > 1);
}

// ── WHAT IS STILL OWED ───────────────────────────────────────────────────
// Read from helpers/salesReceipts.js in ONE pass, the same way bills reads
// its payments. A container is settled when what arrived plus what was
// deducted (bank charge or discount) covers the receivable — so a $12,340
// invoice closed by $12,315 landing and $25 of wire charge shows a zero
// balance AND still says where the $25 went.
//
// Non-fatal if the receipts file cannot be read: a sales table that refuses
// to render because the money store is unavailable is worse than one that
// renders without balances and says so in the log.
function listWithTotals() {
    let received = {}; let deducted = {};
    try {
        const r = require('./salesReceipts');
        received = r.receivedBySale();
        deducted = r.deductedBySale();
    } catch (e) { console.warn('[SALES] could not read receipts:', e.message); }

    return sortRows(list()).map((row) => {
        const t = withTotals(row);
        const got = received[row.id] || 0;
        const ded = deducted[row.id] || { total: 0, bank_charge: 0, discount: 0 };
        return {
            ...t,
            received: got,
            deducted: ded.total || 0,
            bank_charge: ded.bank_charge || 0,
            discount: ded.discount || 0,
            // Null, not zero, when there is nothing to measure against: an
            // invoice with no amount yet is not a paid one.
            balance: t.receivable === null ? null
                : round2(t.receivable - got - (ded.total || 0)),
        };
    });
}

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
        // The four figures the four tabs are about. Kept here rather than
        // computed per tab in the client, so Outgoing and Freight cannot
        // disagree about the same containers.
        charges_in_total: sum('charges_in_total'),
        charges_out_total: sum('charges_out_total'),
        commission_amount: sum('commission_amount'),
        receivable: sum('receivable'),
        sale_side_cost: sum('sale_side_cost'),
    };
}

module.exports = {
    COLUMNS, GROUPS, TABLE_ORDER, tableColumns, WRITABLE, FILTERABLE, filterRows, facets,
    compute, withTotals, list, listWithTotals, getSale,
    addSale, editSale, deleteSale, summary,
    sortRows, duplicates, cleanCharges, CHARGE_DIRECTIONS, TERMS, SHIPMENT_TERMS,
};
