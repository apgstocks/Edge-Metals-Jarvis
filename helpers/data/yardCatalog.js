// ── helpers/data/yardCatalog.js — Edge Yard's tables, in her words ─────────
//
// Scout's half. Edge Trading (the yard) BUYS scrap from sellers — "loads" —
// and SELLS to buyers — "outbound loads". Different company, different
// ledgers, and a rule she has repeated: a rule for one is not a rule for the
// other. Nothing from Edge Metals is in this book.
const TABLES = [
    {
        name: 'yard_loads',
        what: 'A load BOUGHT from a seller at the yard — the purchase side. One row per load; its grades are in yard_load_items.',
        columns: {
            load_id: 'unique id',
            date: 'load date, YYYY-MM-DD — filter and sort on this',
            seller: 'who it was bought from',
            buyer: 'who it was marked for, when one was recorded',
            gross_lb: 'gross weight, pounds',
            tare_lb: 'tare weight, pounds',
            net_lb: 'net weight, pounds',
            amount: 'what the metal cost, dollars',
            trucking_company: 'the trucker, when one is recorded',
            trucking_amount: 'trucking on this load, dollars',
            net_payable: 'what the seller is actually owed: amount − trucking',
            paid: 'paid against this load so far',
            pending: 'still owed to the seller when > 0',
            pay_status: "'paid', 'partial', 'unpaid' or 'none' when nothing is due",
            status: 'the load\'s own status as the screen shows it',
            description: 'free-text description of the load',
        },
    },
    {
        name: 'yard_load_items',
        what: 'One row per GRADE on a purchased load — use this for questions about grades or prices per grade.',
        columns: { load_id: 'joins yard_loads.load_id', date: 'load date', seller: 'seller', grade: 'the grade, e.g. Copper, Brass', net_lb: 'pounds of this grade',
            price: "the rate paid — READ price_unit BEFORE COMPARING TWO PRICES. Most rows are per pound, but a row with price_unit='mt' is priced per metric tonne, and 0.36 and 800.00 can be the same rate. For a like-for-like per-pound figure use amount/net_lb, which is always dollars per pound.",
            price_unit: "'lb' or 'mt' — what price is per. net_lb is ALWAYS pounds either way.",
            amount: 'dollars for this grade' },
    },
    {
        name: 'yard_sales',
        // "sell" is written out alongside "sold" because schemaPick bridges
        // words by PREFIX, and sell/sold share only one letter — an irregular
        // verb the matcher cannot reach across. Caught 2026-09-26 by
        // tests/schema-pick.js when "what did we sell last month" became a
        // worked example: the pruner dropped yard_sales from the very
        // question that needs it. Harmless today (7 tables is under the
        // pruning threshold) and live the moment the catalog grows.
        what: 'A load SOLD to a buyer — what we SELL, our sales, the outbound side.',
        columns: { sale_id: 'unique id', date: 'sale date, YYYY-MM-DD', buyer: 'who it was sold to', net_lb: 'pounds sold', amount: 'what it sold for, dollars', received: 'money received against it', balance: 'still owed by the buyer when > 0', status: 'delivered or not, as the screen shows it', description: 'free text' },
    },
    {
        name: 'yard_sale_items',
        what: 'One row per grade on an outbound load — what we SELL or SOLD, by grade.',
        columns: { sale_id: 'joins yard_sales.sale_id', date: 'sale date', buyer: 'buyer', grade: 'the grade', net_lb: 'pounds',
            price: "the rate sold at — READ price_unit BEFORE COMPARING TWO PRICES, exactly as on yard_load_items. amount/net_lb is dollars per pound on every row and is the safe way to compare.",
            price_unit: "'lb' or 'mt' — what price is per. net_lb is ALWAYS pounds either way.",
            amount: 'dollars for this grade' },
    },
    {
        name: 'yard_trucker_bills',
        what: "What the yard's truckers have billed, and what is still owed to them.",
        columns: { bill_id: 'id', date: 'bill date', trucker: 'trucking company', load_ticket: 'load ticket number, when the bill names one', amount: 'billed, dollars', paid: 'paid so far', pending: 'still owed when > 0', status: "'paid', 'partial' or 'unpaid'" },
    },
    {
        name: 'yard_expenses',
        what: 'Yard running costs — fuel, repairs, wages and the rest.',
        columns: { expense_id: 'id', date: 'expense date', category: 'what kind of cost', amount: 'dollars', method: 'how it was paid (cash, bank, petty cash…)', note: 'her note', paid_to: 'who it was paid to, when recorded' },
    },
    {
        name: 'yard_petty_cash',
        what: 'The petty cash tin: top-ups in, withdrawals out. The balance is the running total of these rows.',
        columns: { entry_id: 'id', date: 'entry date', kind: 'top-up, withdrawal, reversal…', amount: 'dollars, positive in and negative out as recorded', bank: 'which account a top-up came from', note: 'her note', ref: 'what it was for (a payment or expense id)' },
    },
];

const DEFINITIONS = [
    'OWED TO A SELLER = SUM(yard_loads.pending) WHERE pending > 0. The seller is owed net_payable (cost minus trucking), not the gross amount.',
    'OWED TO A TRUCKER = SUM(yard_trucker_bills.pending) WHERE pending > 0.',
    'OWED BY A BUYER = SUM(yard_sales.balance) WHERE balance > 0.',
    'PURCHASES for a period = SUM(yard_loads.amount) over yard_loads.date.',
    'SALES for a period = SUM(yard_sales.amount) over yard_sales.date.',
    'YARD MARGIN for a period = sales minus purchases minus expenses over the same dates; say what you included, because the two sides do not line up load for load.',
    'PETTY CASH BALANCE = SUM(yard_petty_cash.amount).',
];

const GOTCHAS = [
    'Weights are POUNDS everywhere in this book — every net_lb, gross_lb and tare_lb, with no exceptions and nothing to convert.',
    "But a PRICE is not a weight. price_unit on yard_load_items AND yard_sale_items says whether that row's rate is per pound or per metric tonne, because the yard buys and sells some grades either way. Never compare two prices, rank them, or average them without it. amount/net_lb is dollars per pound on every row and is the safe way to compare.",
    'A load and a sale are different things: yard_loads is what the yard BOUGHT, yard_sales is what it SOLD. A question about "loads" without more usually means purchases.',
    'yard_load_items and yard_sale_items hold one row per grade. Count loads with COUNT(DISTINCT load_id), never COUNT(*).',
    'Dates are TEXT in YYYY-MM-DD. Compare with >= and <=; substr(date,1,7) is a month. Some rows have no date typed yet.',
    'Seller and buyer names are typed by hand and drift. Match with LIKE and a wildcard both sides, case-insensitively.',
    'Edge Metals (bills, invoices, containers, bookings) is NOT in this database. If the question is about the export side, say so instead of answering from these tables.',
];

function tableNames() { return TABLES.map((t) => t.name); }
function find(name) { return TABLES.find((t) => t.name === name) || null; }
function summaryText() { return TABLES.map((t) => `- ${t.name}: ${t.what}`).join('\n'); }
function schemaText(names) {
    const picked = (names && names.length ? names : tableNames()).map((n) => find(n)).filter(Boolean);
    return picked.map((t) => {
        const cols = Object.keys(t.columns).map((c) => `    ${c} — ${t.columns[c]}`).join('\n');
        return `TABLE ${t.name}\n  ${t.what}\n${cols}`;
    }).join('\n\n');
}

module.exports = { TABLES, DEFINITIONS, GOTCHAS, tableNames, find, summaryText, schemaText };
