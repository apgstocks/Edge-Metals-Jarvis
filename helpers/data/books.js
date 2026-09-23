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
