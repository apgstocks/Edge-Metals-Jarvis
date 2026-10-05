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
        name: 'sales_settlements',
        what: "Money Edge Metals PAID OUT on a sale — ocean freight, port charges, commission (Invoice → Freight and Invoice → Commission). "
            + 'The outgoing twin of sales_receipts: a receipt is money in from a customer, a settlement is money out on the shipment. '
            + "NOT supplier payments (bill_payments) and NOT the yard's costs.",
        columns: {
            settlement_id: 'id of the payment',
            date: 'paid on, YYYY-MM-DD',
            date_shown: 'the same date as she types it',
            payee: 'who was paid — a forwarder, a broker, an agent. Free text, not checked against a list',
            kind: "'charge' for a cost on the shipment, 'commission' for commission on the sale",
            amount: 'dollars in THIS allocation — one row per thing the payment covered',
            total_settlement: 'the whole payment, repeated on each of its rows. SUM(amount) per settlement_id equals it; do not SUM this column',
            method: 'wire, Zelle, cash, cheque',
            bank: 'bank it was paid from, when wire or Zelle',
            reference: 'reference or note',
            note: 'free note',
            sale_id: 'the sale row it was paid against, joins sales.sale_id',
            charge_id: "which charge on that sale, when kind is 'charge'",
            container_no: 'container it relates to, null if the charge was changed or removed since',
            booking_no: 'booking, same caveat',
            customer: 'customer on that sale, same caveat',
            what: "what the charge was for — 'Ocean freight', 'Commission' — same caveat",
        },
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

    // ── QUICKBOOKS: THE SAME MONEY, THE OTHER BOOK ────────────────────────
    // The tables above are JARVIS's ledgers — what she typed. The five below
    // are QUICKBOOKS — the accountant's book, which is the system of record
    // for anything owed or owing. They disagree on purpose: QuickBooks holds
    // entries her accountant made by hand that Jarvis never saw, and Jarvis
    // holds containers QuickBooks has not been given yet. Answer "what do I
    // owe" from QuickBooks; answer "what did we load" from Jarvis.
    {
        name: 'qb_suppliers',
        what: 'What QUICKBOOKS says each supplier is owed. THE right source for "how much do we owe X" — this is the figure her accountant and QuickBooks itself report.',
        columns: {
            name: 'supplier name AS IT IS IN QUICKBOOKS, which can differ from bills.supplier in Jarvis',
            balance: 'what QuickBooks says is owed to them, dollars, AFTER netting off any credit or prepayment. This is the answer to "what do we owe". Positive means Edge Metals owes them.',
            unapplied_paid: 'money already PAID to them that is not matched to any bill. It is out of the bank but every bill it paid still reads open, so bill-level figures overstate the debt by this much.',
            active: '1 if the supplier is active in QuickBooks',
            as_of: 'the day the snapshot was taken, YYYY-MM-DD',
        },
    },
    {
        name: 'qb_customers',
        what: 'What QUICKBOOKS says each customer owes Edge Metals. THE right source for "who owes us" and "has X paid".',
        columns: {
            name: 'customer name as it is in QuickBooks',
            balance: 'what they still owe, dollars, after netting off credits. Positive means they owe Edge Metals.',
            unapplied_received: 'money ALREADY RECEIVED from them that is not matched to any invoice. Their invoices still read open even though the cash arrived — NEVER chase a customer whose unapplied_received covers what they appear to owe.',
            active: '1 if the customer is active in QuickBooks',
            as_of: 'the day the snapshot was taken',
        },
    },
    {
        name: 'qb_bills',
        what: 'The individual supplier bills in QuickBooks for 2026. Use it for WHICH bills, not for how much is owed in total (use qb_suppliers for that).',
        columns: {
            qb_id: "the bill's id in QuickBooks",
            doc_no: "the supplier's invoice number on the bill",
            date: 'bill date, YYYY-MM-DD',
            supplier: 'supplier name in QuickBooks',
            container_no: 'the container, read from the bill LINES. NULL on a bill with no container (a fee, a period summary, a truck)',
            containers: 'how many distinct containers this one bill covers — more than 1 means it is a grouped or period bill',
            total: 'the full amount of the bill',
            balance: 'how much of it is still unpaid. 0 means settled. balance = total means nothing has been applied',
            payable_account: 'which payable account it sits on. She runs more than one, so two bills can be owed on different accounts',
            paid_by: 'how many payments or credits are linked to it. 0 means untouched',
            as_of: 'the day the snapshot was taken',
        },
    },
    {
        name: 'qb_invoices',
        what: 'The individual sales invoices in QuickBooks for 2026. Use it for WHICH invoices; use qb_customers for how much a customer owes.',
        columns: {
            qb_id: "the invoice's id in QuickBooks",
            doc_no: 'her invoice number',
            date: 'invoice date, YYYY-MM-DD',
            customer: 'customer name in QuickBooks',
            container_no: 'the container, read from the invoice LINES. NULL where there is none',
            containers: 'how many distinct containers this invoice covers',
            total: 'the invoiced amount',
            balance: 'how much is still unpaid. 0 means paid',
            due: 'due date, YYYY-MM-DD, where QuickBooks has one',
            as_of: 'the day the snapshot was taken',
        },
    },
    {
        name: 'qb_books',
        what: 'ONE ROW: the totals QuickBooks reports, and how old the snapshot is. Query it to say "as of last night" honestly, or to tell her the books have not been read yet.',
        columns: {
            as_of: 'the day the snapshot was taken, or NULL if QuickBooks has never been snapshotted',
            minutes_old: 'how stale the figures are. NULL means there is no snapshot at all — say that rather than answering 0',
            environment: "'production' or 'sandbox'",
            owe: 'total owed to all suppliers, per QuickBooks',
            owed: 'total owed to Edge Metals by all customers, per QuickBooks',
            unapplied_paid: 'money paid to suppliers that is matched to no bill',
            unapplied_received: 'money received from customers that is matched to no invoice',
            bills: 'how many bills are in the snapshot',
            invoices: 'how many invoices are in the snapshot',
            over_applied: 'documents with more applied to them than their own value — an anomaly worth naming, not a figure to add up',
        },
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
    'WHAT DO WE OWE / what is owed to a supplier, as the ACCOUNTANT would answer it = qb_suppliers.balance. Jarvis\'s own bills.balance answers "what have I typed in", which is a different question.',
    'WHAT ARE WE OWED, as the accountant would answer it = qb_customers.balance, and qb_customers.unapplied_received must be mentioned whenever it is above zero.',
    'HAS X PAID = qb_customers.balance for X, together with unapplied_received: a zero balance means paid, and a balance covered by unapplied_received means the money arrived but was never matched.',
    'COST AND REVENUE FOR ONE CONTAINER, per QuickBooks = qb_bills.total against qb_invoices.total joined on container_no.',
    'HOW OLD / up to date / as of / when QuickBooks was last read = qb_books.minutes_old and qb_books.as_of.',
    'MONEY PAID BUT NOT MATCHED to a bill = qb_suppliers.unapplied_paid; money RECEIVED but not matched to an invoice = qb_customers.unapplied_received.',
];

const GOTCHAS = [
    'Weights: net_lb is pounds and net_mt is tonnes — never mix them in one SUM. 1 MT = 2204.62 lb.',
    'price and supplier_price are per lb OR per MT — price_unit says which. Do not compare or average prices across different price_unit values.',
    'sales and bill_items hold ONE ROW PER GRADE. Count containers with COUNT(DISTINCT container_no), never COUNT(*).',
    'Dates are TEXT in YYYY-MM-DD. Compare with >= and <=; use substr(date,1,7) for a month. Some rows have NULL dates — they are real rows with no date typed yet.',
    'Names are typed by hand and drift ("Inesh" vs "Inesh Cores Chapin"). Match with LIKE and a wildcard on both sides, case-insensitively.',
    'Money is dollars. Round only in the final SELECT, never in the middle.',
    'Edge Yard (loads, yard inventory, petty cash, expenses, trucker bills) is NOT in this database. If a question is about the yard, say so instead of answering from these tables.',
    'NEVER answer "what do we owe" by adding up qb_bills.balance. Doing that gave $10.7M when the real figure was $5.3M, because $4.98M of payments are recorded against no bill, so the bills they paid still read open. The answer is qb_suppliers.balance. The same trap exists on the customer side.',
    'The qb_ tables are a SNAPSHOT, not live. Check qb_books.minutes_old and say how old the figures are. If qb_books.as_of is NULL, QuickBooks has never been read — say exactly that; do not report zero.',
    'A supplier or customer name in the qb_ tables can differ from the same party in bills/sales ("TAEWON AUTOMOTIVE CO" and "TAEWON PRECEISION" are one company on two records). Match with LIKE on both sides, and never join the qb_ tables to bills/sales on name expecting a clean match.',
    'Join qb_bills to qb_invoices on container_no for a per-container question, never on party or amount. container_no is NULL on fee and period-summary bills, so exclude NULLs in that join.',
    'A container number only identifies one shipment within about 120 days — shipping lines reuse boxes. Do not treat the same container_no a year apart as the same load.',
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
