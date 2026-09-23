// ── helpers/data/dataCatalog.js — what each column MEANS ───────────────────
//
// The single biggest accuracy lever in every published text-to-SQL study is
// not the model: it is whether the schema is ANNOTATED. A model handed
// `balance` guesses; a model told "balance = amount − paid − advance, so > 0
// means Edge Metals still owes the supplier" does not have to.
//
// Two more things live here for the same reason:
//   • DEFINITIONS — her words for a number ("margin", "outstanding",
//     "receivable"), so two questions asked differently get the same answer.
//   • GOTCHAS — the traps in her data that a fluent query would fall into:
//     price_unit, one row per GRADE, dates stored as text.
//
// Dates are YYYY-MM-DD TEXT in the mirror, which sorts and compares correctly
// in SQLite ('2026-09-01' < '2026-09-18'), so the model never needs a date
// function and never sees her MM/DD/YYYY.
const TABLES = [
    {
        name: 'bills',
        what: 'What Edge Metals PAID a supplier for one container of metal (the Bills screen). One row per bill; a container bought as several grades has one row per grade in bill_items.',
        columns: {
            bill_id: 'unique id',
            date: 'bill date, YYYY-MM-DD — use this one for filtering and sorting',
            date_shown: 'the same date as she types it, MM/DD/YYYY — for showing, never for comparing',
            supplier: 'who was bought from',
            carrier: 'shipping line on the booking',
            seal_no: 'container seal number',
            supplier_invoice_no: "the SUPPLIER's invoice number for this bill (not her own invoice number — that is sales.invoice_no)",
            container_no: 'container, e.g. TCLU9988776',
            booking_no: 'booking this container is under',
            route: 'origin / destination as she types it',
            item: 'grade bought, free text',
            gross_lb: 'gross weight off the weighbridge, pounds',
            tare_lb: 'total tares (truck + container + chassis + boxes), pounds',
            net_lb: 'net weight in POUNDS (gross minus tares)',
            net_mt: 'the same weight in metric tonnes (lb / 2204.62)',
            supplier_price: 'price paid; read with price_unit',
            price_unit: "'lb' or 'mt' — which unit supplier_price is in",
            amount: 'what the metal cost: net × price, in dollars',
            trucking_amount: 'trucking on this container, dollars',
            trucking_company: 'the trucker, when a trucking bill is split out',
            advance: 'advance already given to the supplier',
            paid: 'paid against this bill so far',
            balance: 'amount − paid − advance: still owed to the supplier when > 0',
            is_finished: '1 when nothing is missing on the bill, 0 when it still needs something',
            still_needs: 'what an unfinished bill is waiting for, e.g. "container no, supplier invoice"',
        },
    },
    {
        name: 'bill_items',
        what: 'One row per GRADE on a bill — a container bought as Alternator + Starter is two rows. Use this for questions about grades; use bills for questions about containers.',
        columns: { bill_id: 'joins bills.bill_id', date: 'bill date', supplier: 'supplier', container_no: 'container', grade: 'the grade, e.g. Alternator', net_lb: 'pounds', net_mt: 'tonnes', price: 'price for this grade', price_unit: "'lb' or 'mt'", amount: 'dollars for this grade' },
    },
    {
        name: 'sales',
        what: 'What Edge Metals BILLED a customer — the Invoice (Outgoing) screen. One row per grade per container; rows sharing booking_no + container_no + invoice_no + customer are ONE invoice.',
        columns: {
            sale_id: 'unique id', date: 'sale/invoice date, YYYY-MM-DD — filter and sort on this',
            date_shown: 'the same date as she types it, MM/DD/YYYY — for showing only',
            customer: 'who was billed',
            container_no: 'container', booking_no: 'booking', invoice_no: 'her invoice number, e.g. 26ARIS02',
            hbl_no: 'house bill of lading number', item: 'grade sold',
            payment_terms: 'TT, LC, etc.', shipment_terms: 'CIF, FOB, etc.',
            net_lb: 'pounds sold', net_mt: 'tonnes sold',
            price: 'selling price; read with price_unit', price_unit: "'lb' or 'mt'",
            amount: 'invoice amount in dollars', commission: 'commission on this row',
            charges_in: 'charges added to the invoice', charges_out: 'charges deducted',
            receivable: 'what the customer owes on this row before receipts',
            received: 'money received against it', deducted: 'deductions applied',
            balance: 'still owed by the customer when > 0',
        },
    },
    {
        name: 'bill_payments',
        what: 'Money PAID OUT to suppliers (Bills → payments). One row per payment allocation; an advance not yet applied has bill_id NULL and is_advance 1.',
        columns: { payment_id: 'id', date: 'payment date', supplier: 'who was paid', amount: 'dollars in this allocation', total_payment: 'the whole payment this allocation came from', method: 'cash, wire, zelle, cheque…', bank: 'bank it went from', reference: 'reference or note', bill_id: 'the bill it was applied to, joins bills.bill_id', is_advance: '1 when it is an advance rather than payment of a bill' },
    },
    {
        name: 'sales_receipts',
        what: 'Money RECEIVED from customers against invoices.',
        columns: { receipt_id: 'id', date: 'receipt date', customer: 'who paid', amount: 'dollars in this allocation', total_receipt: 'the whole receipt', method: 'wire, cash…', bank: 'bank it landed in', reference: 'reference or note', sale_id: 'the sale row it was applied to, joins sales.sale_id', deducted: 'amount deducted rather than received', deduction_reason: 'why it was short' },
    },
    {
        name: 'trucking_bills',
        what: "Edge Metals' trucking payables — what each trucking company is owed per container (Bills → Trucking). NOT the yard's trucker bills.",
        columns: { bill_id: 'the bill it belongs to', date: 'bill date, YYYY-MM-DD',
            date_shown: 'the same date as she types it', booking_no: 'booking', trucking_company: 'the trucker', supplier: 'supplier on that container', container_no: 'container', route: 'route', trucker_invoice_no: "the trucker's invoice number", verified_on: 'date she verified it', amount: 'what the trucking costs', paid: 'paid so far', balance: 'still owed when > 0', status: "'paid', 'part', 'unpaid' or 'missing' (no amount yet)" },
    },
    {
        name: 'margin',
        what: 'Bought and sold, joined per container (the Margin screen). One row per container.',
        columns: { container_no: 'container', booking_no: 'booking', supplier: 'bought from', customer: 'sold to', bill_date: 'bought on', sale_date: 'sold on', bought_weight_lb: 'pounds bought', sold_weight_lb: 'pounds sold', cost: 'what it cost, including trucking where known', trucking: 'trucking part of the cost', revenue: 'what it was sold for', commission: 'commission paid on the sale', margin: 'revenue − cost', margin_pct: 'margin as a percentage of revenue', received: 'received from the customer', receivable: 'still to come', state: "'closed' (bought and sold), 'bought' or 'sold'" },
    },
    {
        name: 'bookings',
        what: 'Shipping bookings — the vessel, the ports and the deadlines.',
        columns: { booking_no: 'booking number', carrier: 'shipping line', port_of_loading: 'load port', port_of_discharge: 'discharge port', erd: 'earliest receiving date', cutoff: 'cutoff date', etd: 'departure', eta: 'arrival', vessel_voyage: 'vessel / voyage', containers: 'how many containers on it', containers_assigned: 'how many have a supplier assigned', suppliers: 'suppliers assigned, comma separated', truckers: 'truckers assigned', archived: '1 when archived' },
    },
    {
        name: 'edge_inventory',
        what: "Metal received into Edge Metals' own storage and not yet shipped.",
        columns: { receipt_id: 'id', date: 'received on', supplier: 'from whom', grade: 'grade', weight_lb: 'pounds', storage: 'where it is', container_no: 'container if already loaded', note: 'note' },
    },
    {
        name: 'documents',
        what: 'Documents generated and filed — invoices, proformas and BOLs. Use it to answer whether a document exists, not what it says.',
        columns: { kind: "'invoice', 'proforma' or 'bol'", filename: 'file name', container_no: 'container it belongs to', date: 'the day it was filed, YYYY-MM-DD', saved_at: 'timestamp' },
    },
];

// Her words for a number, so "what do we owe", "outstanding to suppliers" and
// "supplier balance" cannot become three different sums.
const DEFINITIONS = [
    'OWED TO SUPPLIERS / payable / outstanding to a supplier = SUM(bills.balance) WHERE balance > 0.',
    'OWED TO US / receivable / outstanding from a customer = SUM(sales.balance) WHERE balance > 0.',
    'MARGIN or PROFIT on a container = margin.margin (revenue − cost). Only margin.state = \'closed\' containers have both sides; say so when the question spans open ones.',
    'REVENUE / sales / turnover for a period = SUM(sales.amount) over sales.date.',
    'SPEND / purchases for a period = SUM(bills.amount) over bills.date.',
    'TRUCKING OWED = SUM(trucking_bills.balance) WHERE balance > 0.',
    'UNFINISHED / incomplete bills = bills.is_finished = 0, and still_needs says what is missing.',
    'A CONTAINER is identified by booking_no + container_no together, never by booking alone.',
];

const GOTCHAS = [
    'Weights: net_lb is pounds and net_mt is tonnes — never mix them in one SUM. 1 MT = 2204.62 lb.',
    'price and supplier_price are per lb OR per MT — price_unit says which. Do not compare or average prices across different price_unit values.',
    'sales and bill_items hold ONE ROW PER GRADE. Count containers with COUNT(DISTINCT container_no), never COUNT(*).',
    'Dates are TEXT in YYYY-MM-DD. Compare with >= and <=; use substr(date,1,7) for a month. Some rows have NULL dates — they are real rows with no date typed yet.',
    'Names are typed by hand and drift ("Inesh" vs "Inesh Cores Chapin"). Match with LIKE and a wildcard on both sides, case-insensitively.',
    'Money is dollars. Round only in the final SELECT, never in the middle.',
    'Edge Yard (loads, yard inventory, petty cash, expenses, trucker bills) is NOT in this database. If a question is about the yard, say so instead of answering from these tables.',
];

function tableNames() { return TABLES.map((t) => t.name); }
function find(name) { return TABLES.find((t) => t.name === name) || null; }

// The compact form the planner sends when it is choosing tables — names and
// one line each, so the first call stays small.
function summaryText() {
    return TABLES.map((t) => `- ${t.name}: ${t.what}`).join('\n');
}

// The full form for the tables it chose. Everything else is left out: sending
// all ten tables' columns every time is the schema noise that column pruning
// exists to remove.
function schemaText(names) {
    const picked = (names && names.length ? names : tableNames())
        .map((n) => find(n)).filter(Boolean);
    return picked.map((t) => {
        const cols = Object.keys(t.columns).map((c) => `    ${c} — ${t.columns[c]}`).join('\n');
        return `TABLE ${t.name}\n  ${t.what}\n${cols}`;
    }).join('\n\n');
}

module.exports = { TABLES, DEFINITIONS, GOTCHAS, tableNames, find, summaryText, schemaText };
