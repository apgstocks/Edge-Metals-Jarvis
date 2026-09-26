// ── helpers/data/books.js — two companies, two books ──────────────────────
//
// "Edge Yard and Edge Metals are different companies" — CLAUDE.md rule 5, and
// the thing she has said more often than any other. So the question engine
// takes a BOOK: which mirror, which annotated schema, which worked examples,
// and what to say when a question belongs to the other company.
//
// Jarvis asks the metals book; Scout asks the yard book. Neither is given the
// other's file, so the separation is not a filter anyone can forget.
const METALS_EXAMPLES = [
    { q: 'how much do we owe Inesh', sql: "SELECT supplier, ROUND(SUM(balance), 2) AS owed, COUNT(*) AS bills FROM bills WHERE balance > 0 AND lower(supplier) LIKE '%inesh%' GROUP BY supplier",
      shape: 'single', headline: 'We owe {supplier} {owed} across {bills} bills.', formats: { owed: 'money', bills: 'number' } },
    { q: 'which customers owe us money', sql: 'SELECT customer, ROUND(SUM(balance), 2) AS owed FROM sales WHERE balance > 0 GROUP BY customer ORDER BY owed DESC',
      shape: 'list', headline: '{count} customers owe us money.', title: 'Outstanding by customer' },
    { q: 'how many containers did we load this month', sql: "SELECT COUNT(DISTINCT container_no) AS containers FROM bills WHERE substr(date, 1, 7) = strftime('%Y-%m', 'now', 'localtime')",
      shape: 'single', headline: '{containers} containers this month.', formats: { containers: 'number' } },
    { q: 'what was our margin in August', sql: "SELECT ROUND(SUM(margin), 2) AS margin, ROUND(SUM(revenue), 2) AS revenue, COUNT(*) AS containers FROM margin WHERE state = 'closed' AND substr(sale_date, 1, 7) = '2026-08'",
      shape: 'single', headline: 'Margin was {margin} on {revenue} of sales, across {containers} closed containers.', formats: { margin: 'money', revenue: 'money', containers: 'number' } },
    { q: 'which bills are not finished', sql: 'SELECT date, supplier, container_no, still_needs FROM bills WHERE is_finished = 0 ORDER BY date DESC',
      shape: 'list', headline: '{count} bills still need something.', title: 'Unfinished bills' },
    { q: 'what did we pay Sher Trucking last month', sql: "SELECT ROUND(SUM(paid), 2) AS paid, COUNT(DISTINCT container_no) AS containers FROM trucking_bills WHERE lower(trucking_company) LIKE '%sher%' AND substr(date, 1, 7) = strftime('%Y-%m', 'now', 'localtime', '-1 month')",
      shape: 'single', headline: 'We paid {paid} to Sher Trucking on {containers} containers.', formats: { paid: 'money', containers: 'number' } },

    // ── THE SHAPES THE SIX ABOVE DID NOT COVER (2026-09-26) ───────────────
    // Same reason as the yard book below: six examples is the tuning dial
    // barely turned, and every shape the model has not been shown is a shape
    // it has to invent. These are the questions she actually asks about the
    // export side — one container, one booking, one customer, a period.

    // A CONTAINER, BY NAME. The commonest question on this side of the
    // business, and there was no example of looking one up.
    { q: 'what is the margin on KOCU4930737', sql: "SELECT container_no, supplier, customer, ROUND(cost, 2) AS cost, ROUND(revenue, 2) AS revenue, ROUND(margin, 2) AS margin, ROUND(margin_pct, 1) AS margin_pct, state FROM margin WHERE upper(container_no) = 'KOCU4930737'",
      shape: 'single', headline: '{container_no}: cost {cost}, revenue {revenue}, margin {margin} ({margin_pct}%).', formats: { cost: 'money', revenue: 'money', margin: 'money', margin_pct: 'percent' } },
    { q: 'what did we bill on KOCU4930737', sql: "SELECT container_no, supplier, date, ROUND(net_lb, 0) AS pounds, ROUND(net_mt, 3) AS tonnes, ROUND(amount, 2) AS amount, ROUND(balance, 2) AS still_owed FROM bills WHERE upper(container_no) = 'KOCU4930737'",
      shape: 'single', headline: '{container_no} from {supplier}: {pounds} lb, {amount}, {still_owed} still owed.', formats: { pounds: 'weight_lb', tonnes: 'weight_mt', amount: 'money', still_owed: 'money' } },

    // A BOOKING, which groups containers — the unit she plans by.
    { q: 'which containers are on booking DALA25048200', sql: "SELECT container_no, supplier, date, ROUND(net_lb, 0) AS pounds, ROUND(amount, 2) AS amount FROM bills WHERE upper(booking_no) = 'DALA25048200' ORDER BY container_no",
      shape: 'list', headline: '{count} containers on that booking.', title: 'Containers on the booking' },

    // COUNTS AND PERIODS, beyond the one container count.
    { q: 'how many containers did we ship this year', sql: "SELECT COUNT(DISTINCT container_no) AS containers, ROUND(SUM(net_mt), 3) AS tonnes, ROUND(SUM(amount), 2) AS billed FROM bills WHERE substr(date, 1, 4) = strftime('%Y', 'now', 'localtime')",
      shape: 'single', headline: '{containers} containers this year, {tonnes} MT, {billed} billed.', formats: { containers: 'number', tonnes: 'weight_mt', billed: 'money' } },
    { q: 'what did we invoice last month', sql: "SELECT COUNT(*) AS invoices, ROUND(SUM(amount), 2) AS invoiced, ROUND(SUM(received), 2) AS received FROM sales WHERE substr(date, 1, 7) = strftime('%Y-%m', 'now', 'localtime', '-1 month')",
      shape: 'single', headline: '{invoices} invoices last month, {invoiced}, {received} received.', formats: { invoices: 'number', invoiced: 'money', received: 'money' } },
    // A WEEK, not only a month. Containers move on a monthly rhythm here, so
    // the week shape was missing entirely — and a model that has only been
    // shown substr(date,1,7) will reach for a month when she says "this week".
    // Caught by tests/book-examples.js rather than by noticing.
    { q: 'which containers did we bill this week', sql: "SELECT container_no, supplier, date, ROUND(amount, 2) AS amount FROM bills WHERE date >= date('now', 'localtime', 'weekday 0', '-6 days') ORDER BY date DESC",
      shape: 'list', headline: '{count} containers billed this week.', title: 'Billed this week' },
    { q: 'how much do we owe our suppliers', sql: 'SELECT supplier, ROUND(SUM(balance), 2) AS owed, COUNT(*) AS bills FROM bills WHERE balance > 0 GROUP BY supplier ORDER BY owed DESC',
      shape: 'list', headline: '{count} suppliers are owed money.', title: 'Owed to suppliers' },

    // OLDEST / AGEING — the question that follows a total.
    { q: 'what is the oldest unpaid bill', sql: "SELECT bill_id, date, supplier, container_no, ROUND(balance, 2) AS still_owed, CAST(julianday('now', 'localtime') - julianday(date) AS INTEGER) AS days_old FROM bills WHERE balance > 0 AND date IS NOT NULL AND date != '' ORDER BY date ASC LIMIT 1",
      shape: 'single', headline: '{container_no} from {date} — {supplier}, {still_owed} owed, {days_old} days old.', formats: { still_owed: 'money', days_old: 'number' } },
    { q: 'which invoices are overdue', sql: "SELECT invoice_no, date, customer, ROUND(balance, 2) AS still_owed, CAST(julianday('now', 'localtime') - julianday(date) AS INTEGER) AS days_old FROM sales WHERE balance > 0 AND date IS NOT NULL AND date != '' ORDER BY date ASC",
      shape: 'list', headline: '{count} invoices still have a balance.', title: 'Unpaid invoices' },

    // A RATE — same trap as the yard book. price_unit means two `price`
    // values are not comparable; amount/net_lb always is.
    { q: 'what are we paying per pound for aluminium combo', sql: "SELECT ROUND(SUM(amount) / NULLIF(SUM(net_lb), 0), 4) AS per_lb, ROUND(SUM(net_lb), 0) AS pounds, COUNT(*) AS rows_seen FROM bill_items WHERE lower(grade) LIKE '%alum%' AND net_lb > 0",
      shape: 'single', headline: 'Aluminium combo is averaging {per_lb} a pound over {pounds} lb.', formats: { per_lb: 'money', pounds: 'weight_lb', rows_seen: 'number' } },

    // MARGIN, COMPARED — the analytical question, not just the total.
    { q: 'which containers lost money', sql: "SELECT container_no, supplier, customer, ROUND(margin, 2) AS margin FROM margin WHERE margin < 0 ORDER BY margin ASC",
      shape: 'list', headline: '{count} containers came in below cost.', title: 'Loss-making containers' },
    { q: 'which customer is the most profitable', sql: "SELECT customer, ROUND(SUM(margin), 2) AS margin, COUNT(*) AS containers FROM margin WHERE customer IS NOT NULL AND customer != '' GROUP BY customer ORDER BY margin DESC",
      shape: 'list', headline: '{count} customers by margin.', title: 'Margin by customer' },

    // MONEY MOVED, as opposed to money owed.
    { q: 'what did we pay out this month', sql: "SELECT ROUND(SUM(amount), 2) AS paid, COUNT(*) AS payments FROM bill_payments WHERE substr(date, 1, 7) = strftime('%Y-%m', 'now', 'localtime')",
      shape: 'single', headline: '{paid} paid out over {payments} payments this month.', formats: { paid: 'money', payments: 'number' } },
    { q: 'what came in this month', sql: "SELECT ROUND(SUM(amount), 2) AS received, COUNT(*) AS receipts FROM sales_receipts WHERE substr(date, 1, 7) = strftime('%Y-%m', 'now', 'localtime')",
      shape: 'single', headline: '{received} received over {receipts} receipts this month.', formats: { received: 'money', receipts: 'number' } },

    // BOOKINGS AND DOCUMENTS — the operational side, previously unexampled.
    { q: 'which bookings are still open', sql: 'SELECT booking_no, carrier, etd, containers, containers_assigned FROM bookings WHERE archived = 0 ORDER BY etd',
      shape: 'list', headline: '{count} bookings are still open.', title: 'Open bookings' },
    { q: 'what documents do we have for KOCU4930737', sql: "SELECT kind, filename, date FROM documents WHERE upper(container_no) = 'KOCU4930737' ORDER BY saved_at DESC",
      shape: 'list', headline: '{count} documents on file for that container.', title: 'Documents' },

    // WHAT IS SITTING IN STOCK.
    { q: 'what is in edge inventory', sql: 'SELECT grade, ROUND(SUM(weight_lb), 0) AS pounds, COUNT(*) AS receipts FROM edge_inventory GROUP BY grade ORDER BY pounds DESC',
      shape: 'list', headline: '{count} grades in Edge inventory.', title: 'Edge inventory' },
];

const YARD_EXAMPLES = [
    { q: 'how much do we owe Junk Car', sql: "SELECT seller, ROUND(SUM(pending), 2) AS owed, COUNT(*) AS loads FROM yard_loads WHERE pending > 0 AND lower(seller) LIKE '%junk car%' GROUP BY seller",
      shape: 'single', headline: 'We owe {seller} {owed} across {loads} loads.', formats: { owed: 'money', loads: 'number' } },
    { q: 'what did we buy last month', sql: "SELECT ROUND(SUM(amount), 2) AS spent, COUNT(*) AS loads, ROUND(SUM(net_lb), 0) AS pounds FROM yard_loads WHERE substr(date, 1, 7) = strftime('%Y-%m', 'now', 'localtime', '-1 month')",
      shape: 'single', headline: 'We bought {pounds} for {spent} across {loads} loads.', formats: { spent: 'money', loads: 'number', pounds: 'weight_lb' } },
    { q: 'which seller did we buy the most copper from this year', sql: "SELECT seller, ROUND(SUM(net_lb), 0) AS pounds, ROUND(SUM(amount), 2) AS spent FROM yard_load_items WHERE lower(grade) LIKE '%copper%' AND substr(date, 1, 4) = strftime('%Y', 'now', 'localtime') GROUP BY seller ORDER BY pounds DESC",
      shape: 'list', headline: '{count} sellers sold us copper this year.', title: 'Copper by seller' },
    { q: 'how much is still owed to truckers', sql: "SELECT trucker, ROUND(SUM(pending), 2) AS owed FROM yard_trucker_bills WHERE pending > 0 GROUP BY trucker ORDER BY owed DESC",
      shape: 'list', headline: '{count} truckers are owed money.', title: 'Owed to truckers' },
    { q: 'what did we spend on fuel this month', sql: "SELECT ROUND(SUM(amount), 2) AS spent, COUNT(*) AS entries FROM yard_expenses WHERE lower(category) LIKE '%fuel%' AND substr(date, 1, 7) = strftime('%Y-%m', 'now', 'localtime')",
      shape: 'single', headline: 'Fuel came to {spent} across {entries} entries.', formats: { spent: 'money', entries: 'number' } },
    { q: 'what is in the petty cash tin', sql: 'SELECT ROUND(SUM(amount), 2) AS balance, COUNT(*) AS entries FROM yard_petty_cash',
      shape: 'single', headline: 'Petty cash is {balance}, over {entries} entries.', formats: { balance: 'money', entries: 'number' } },

    // ── COUNTING, WHICH THIS BOOK COULD NOT DO ────────────────────────────
    // Apsara, 2026-09-26: Jarvis "is dumb most of the times". The six
    // examples above are ALL money questions — not one of them counts
    // anything. "How many loads this week" was in her ask log as
    // could_not_answer, and it had nothing whatsoever to generalise from: a
    // model shown six SUM(...) queries and asked for a COUNT is being asked
    // to invent a shape. These are the missing shapes, not more of the same.
    //
    // 'now','localtime','weekday 0','-6 days' is the start of the current
    // week (Monday) in SQLite. Written out rather than a BETWEEN with typed
    // dates, because the model copies the pattern and typed dates go stale.
    { q: 'how many loads this week', sql: "SELECT COUNT(*) AS loads, ROUND(SUM(net_lb), 0) AS pounds, ROUND(SUM(amount), 2) AS spent FROM yard_loads WHERE date >= date('now', 'localtime', 'weekday 0', '-6 days')",
      shape: 'single', headline: '{loads} loads this week, {pounds} lb, {spent}.', formats: { loads: 'number', pounds: 'weight_lb', spent: 'money' } },
    { q: 'how many loads did we take in August', sql: "SELECT COUNT(*) AS loads, ROUND(SUM(net_lb), 0) AS pounds, ROUND(SUM(amount), 2) AS spent FROM yard_loads WHERE substr(date, 6, 2) = '08' AND substr(date, 1, 4) = strftime('%Y', 'now', 'localtime')",
      shape: 'single', headline: '{loads} loads in August, {pounds} lb, {spent}.', formats: { loads: 'number', pounds: 'weight_lb', spent: 'money' } },
    { q: 'how many loads today', sql: "SELECT COUNT(*) AS loads, ROUND(SUM(amount), 2) AS spent FROM yard_loads WHERE date = date('now', 'localtime')",
      shape: 'single', headline: '{loads} loads today, {spent}.', formats: { loads: 'number', spent: 'money' } },
    { q: 'how many sellers did we buy from this month', sql: "SELECT COUNT(DISTINCT seller) AS sellers, COUNT(*) AS loads FROM yard_loads WHERE substr(date, 1, 7) = strftime('%Y-%m', 'now', 'localtime') AND seller IS NOT NULL AND seller != ''",
      shape: 'single', headline: '{sellers} sellers, {loads} loads this month.', formats: { sellers: 'number', loads: 'number' } },

    // ── WEIGHT, WHICH IS NOT MONEY ────────────────────────────────────────
    // Her business is weighed before it is priced, and "how much" about a
    // grade means pounds, not dollars.
    { q: 'how much copper did we buy this month', sql: "SELECT ROUND(SUM(net_lb), 0) AS pounds, ROUND(SUM(amount), 2) AS spent, COUNT(DISTINCT load_id) AS loads FROM yard_load_items WHERE lower(grade) LIKE '%copper%' AND substr(date, 1, 7) = strftime('%Y-%m', 'now', 'localtime')",
      shape: 'single', headline: '{pounds} lb of copper across {loads} loads, {spent}.', formats: { pounds: 'weight_lb', spent: 'money', loads: 'number' } },
    { q: 'what grades did we buy this month', sql: "SELECT grade, ROUND(SUM(net_lb), 0) AS pounds, ROUND(SUM(amount), 2) AS spent FROM yard_load_items WHERE substr(date, 1, 7) = strftime('%Y-%m', 'now', 'localtime') GROUP BY grade ORDER BY pounds DESC",
      shape: 'list', headline: '{count} grades bought this month.', title: 'Grades this month' },

    // ── A RATE, WHICH MUST NOT BE READ OFF `price` ────────────────────────
    // price_unit was added 2026-09-24: a row may be quoted per tonne, so two
    // `price` values are not comparable. amount/net_lb is dollars per pound
    // on every row. This example exists to teach that, because the model
    // will otherwise average a column that cannot be averaged.
    { q: 'what are we paying per pound for brass', sql: "SELECT ROUND(SUM(amount) / NULLIF(SUM(net_lb), 0), 4) AS per_lb, ROUND(SUM(net_lb), 0) AS pounds, COUNT(*) AS rows_seen FROM yard_load_items WHERE lower(grade) LIKE '%brass%' AND net_lb > 0",
      shape: 'single', headline: 'Brass is averaging {per_lb} a pound over {pounds} lb.', formats: { per_lb: 'money', pounds: 'weight_lb', rows_seen: 'number' } },

    // ── THE SALE SIDE, WHICH HAD NO EXAMPLE AT ALL ────────────────────────
    { q: 'what did we sell last month', sql: "SELECT COUNT(*) AS sales, ROUND(SUM(net_lb), 0) AS pounds, ROUND(SUM(amount), 2) AS revenue FROM yard_sales WHERE substr(date, 1, 7) = strftime('%Y-%m', 'now', 'localtime', '-1 month')",
      shape: 'single', headline: '{sales} sales last month, {pounds} lb, {revenue}.', formats: { sales: 'number', pounds: 'weight_lb', revenue: 'money' } },
    { q: 'who owes us money', sql: "SELECT buyer, ROUND(SUM(balance), 2) AS owed, COUNT(*) AS sales FROM yard_sales WHERE balance > 0 GROUP BY buyer ORDER BY owed DESC",
      shape: 'list', headline: '{count} buyers still owe us.', title: 'Owed by buyers' },

    // ── ONE ROW, NAMED ────────────────────────────────────────────────────
    // "What is EDGE_12" is the commonest question about a specific thing and
    // there was no example of looking one up by id.
    { q: 'show me load EDGE_12', sql: "SELECT load_id, date, seller, ROUND(net_lb, 0) AS pounds, ROUND(amount, 2) AS amount, ROUND(pending, 2) AS still_owed, pay_status FROM yard_loads WHERE upper(load_id) = 'EDGE_12'",
      shape: 'single', headline: '{load_id}: {seller}, {pounds} lb, {amount}, {still_owed} still owed.', formats: { pounds: 'weight_lb', amount: 'money', still_owed: 'money' } },

    // ── OLDEST / UNPAID, the question after a total ───────────────────────
    { q: 'what is the oldest unpaid load', sql: "SELECT load_id, date, seller, ROUND(pending, 2) AS still_owed, CAST(julianday('now', 'localtime') - julianday(date) AS INTEGER) AS days_old FROM yard_loads WHERE pending > 0 AND date IS NOT NULL AND date != '' ORDER BY date ASC LIMIT 1",
      shape: 'single', headline: '{load_id} from {date} — {seller}, {still_owed} still owed, {days_old} days old.', formats: { still_owed: 'money', days_old: 'number' } },
    { q: 'which loads are still unpaid', sql: "SELECT load_id, date, seller, ROUND(pending, 2) AS still_owed FROM yard_loads WHERE pending > 0 ORDER BY date ASC",
      shape: 'list', headline: '{count} loads are still unpaid.', title: 'Unpaid loads' },

    // ── A DATE RANGE SPELLED OUT ──────────────────────────────────────────
    { q: 'what did we spend between 1 August and 15 August', sql: "SELECT COUNT(*) AS loads, ROUND(SUM(amount), 2) AS spent FROM yard_loads WHERE date BETWEEN '2026-08-01' AND '2026-08-15'",
      shape: 'single', headline: '{loads} loads, {spent}.', formats: { loads: 'number', spent: 'money' } },

    // ── SUPERLATIVES ──────────────────────────────────────────────────────
    { q: 'what was our biggest load', sql: "SELECT load_id, date, seller, ROUND(net_lb, 0) AS pounds, ROUND(amount, 2) AS amount FROM yard_loads WHERE net_lb IS NOT NULL ORDER BY net_lb DESC LIMIT 1",
      shape: 'single', headline: '{load_id} — {seller}, {pounds} lb, {amount}.', formats: { pounds: 'weight_lb', amount: 'money' } },
    { q: 'who did we spend the most with this year', sql: "SELECT seller, ROUND(SUM(amount), 2) AS spent, COUNT(*) AS loads FROM yard_loads WHERE substr(date, 1, 4) = strftime('%Y', 'now', 'localtime') AND seller IS NOT NULL AND seller != '' GROUP BY seller ORDER BY spent DESC",
      shape: 'list', headline: '{count} sellers this year.', title: 'Spend by seller' },

    // ── EXPENSES AND CASH, BEYOND THE ONE CATEGORY ────────────────────────
    { q: 'what did we spend on expenses this month', sql: "SELECT category, ROUND(SUM(amount), 2) AS spent, COUNT(*) AS entries FROM yard_expenses WHERE substr(date, 1, 7) = strftime('%Y-%m', 'now', 'localtime') GROUP BY category ORDER BY spent DESC",
      shape: 'list', headline: '{count} expense categories this month.', title: 'Expenses this month' },
    { q: 'how much cash went out last week', sql: "SELECT ROUND(SUM(amount), 2) AS net_change, COUNT(*) AS entries FROM yard_petty_cash WHERE date >= date('now', 'localtime', 'weekday 0', '-13 days') AND date < date('now', 'localtime', 'weekday 0', '-6 days')",
      shape: 'single', headline: 'Petty cash moved {net_change} over {entries} entries last week.', formats: { net_change: 'money', entries: 'number' } },

    // ── TRUCKING, THE OTHER SIDE OF A LOAD ────────────────────────────────
    { q: 'what did we pay in trucking this month', sql: "SELECT ROUND(SUM(amount), 2) AS billed, ROUND(SUM(paid), 2) AS paid, COUNT(*) AS bills FROM yard_trucker_bills WHERE substr(date, 1, 7) = strftime('%Y-%m', 'now', 'localtime')",
      shape: 'single', headline: 'Truckers billed {billed} this month, {paid} paid across {bills} bills.', formats: { billed: 'money', paid: 'money', bills: 'number' } },
];

const BOOKS = {
    metals: {
        key: 'metals',
        label: 'EDGE METALS',
        mirror: () => require('./dataMirror'),
        catalog: () => require('./dataCatalog'),
        examples: METALS_EXAMPLES,
        other: 'yard',
        otherWords: 'Edge Yard (loads, yard inventory, petty cash, expenses, trucker bills)',
        redirect: "That's Edge Yard — ask Scout. I only have the Edge Metals ledgers.",
    },
    yard: {
        key: 'yard',
        label: 'EDGE YARD (Edge Trading — buys scrap from sellers as "loads", sells to buyers as "outbound loads")',
        mirror: () => require('./yardMirror'),
        catalog: () => require('./yardCatalog'),
        examples: YARD_EXAMPLES,
        other: 'metals',
        otherWords: 'Edge Metals (container bills, export invoices, bookings, shipping documents)',
        redirect: "That's Edge Metals — ask Jarvis. I only have the yard's books.",
    },
};

function book(name) { return BOOKS[name] || BOOKS.metals; }

module.exports = { BOOKS, book };
