// ── helpers/chartOfAccounts.js — the accounts her books are kept in ──────
//
// Apsara, 2026-10-06, on what "the best QuickBooks" means first: the
// year-end pack for her CPA — P&L, balance sheet, general ledger, trial
// balance, per company. All four are VIEWS OVER ACCOUNTS, and Jarvis owns
// none. Today the chart of accounts is read live from QuickBooks
// (helpers/quickbooks/books.js:163, 377 accounts) and exactly three of them
// are mapped to anything (qb-settings/qb-party-map.json).
//
// ── WHAT THIS IS, AND WHAT IT IS NOT ─────────────────────────────────────
// It is a STARTING chart, chosen to fit what her business actually does:
// buying scrap at a yard, shipping containers for export, three companies,
// advances to suppliers, commission to agents. It is NOT a copy of her
// QuickBooks chart, because her QuickBooks chart is not in this repo and
// inventing a match would be the worst kind of wrong — a statement whose
// line names look familiar to her CPA but mean something else.
//
// scripts/coa-reconcile.js is the other half: run on the VM it compares
// this chart against her live QuickBooks one and reports what has no
// counterpart in either direction. Until that has been run, every statement
// built on this should be read as "Jarvis's view", not "the same numbers
// QuickBooks would give".
//
// ── WHY CODES AND NOT JUST NAMES ─────────────────────────────────────────
// A statement is ordered by code, and a code survives a rename. Her CPA
// reads "6100 Fuel" in the same place every year even if the label changes.
// Names drift; this file's own history shows how fast — "Edge Yard" and
// "EDGE TRADING INC" are one company under two names, and reconciling that
// took a whole file (helpers/entities.js).
//
//   1000-1999  assets
//   2000-2999  liabilities
//   3000-3999  equity
//   4000-4999  income
//   5000-5999  cost of goods sold
//   6000-6999  operating expenses
//
// ── THE INTER-COMPANY ACCOUNTS ARE NOT OPTIONAL ──────────────────────────
// She confirmed on 2026-10-06 that AAA Investment is a third company with
// its own return. helpers/entities.js already detects one company's money
// paying another's transaction. That has to LAND somewhere: a receivable on
// one balance sheet and a payable on the other. Without 1400/2400 those
// amounts would vanish from both sets of books, which is the single easiest
// way to make three returns quietly wrong.

const TYPES = ['asset', 'liability', 'equity', 'income', 'cogs', 'expense'];

// Which side increases an account. Needed by every posting: a debit to an
// asset increases it, a debit to income decreases it, and getting this
// backwards produces a trial balance that still balances while every figure
// has the wrong sign.
const NORMAL = {
    asset: 'debit',
    liability: 'credit',
    equity: 'credit',
    income: 'credit',
    cogs: 'debit',
    expense: 'debit',
};

// `why` is not decoration. An account nobody can explain is one that gets
// used for the wrong thing, and a chart grows until it is unreadable unless
// each line justifies itself.
const ACCOUNTS = [
    // ── ASSETS ───────────────────────────────────────────────────────────
    { code: '1010', name: 'Bank — Bank of America', type: 'asset', bank: 'BofA',
      why: 'Edge Metals INC\'s account, and the one AAA Investment also draws on '
         + '(pettyCash.js BANK_OF). qb-settings/bank-accounts.json holds its details.' },
    { code: '1020', name: 'Bank — Chase', type: 'asset', bank: 'Chase Bank',
      why: 'EDGE TRADING INC\'s account. payments.js maps a Chase wire to exactly one owner.' },
    { code: '1050', name: 'Petty cash', type: 'asset',
      why: 'The yard\'s drawer, helpers/pettyCash.js. An Edge Trading ledger even when '
         + 'another company funded it — cash_source says who funded, not whose it is.' },
    { code: '1200', name: 'Accounts receivable', type: 'asset',
      why: 'What customers owe on invoices. sales.js computes receivable per row; it is '
         + 'not a stored field, which is a trap this file does not repeat.' },
    { code: '1300', name: 'Inventory — material', type: 'asset',
      why: 'Metal bought and not yet sold. helpers/edgeInventory.js and yard stock are '
         + 'the quantity side; this is the money side.' },
    { code: '1350', name: 'Advances to suppliers', type: 'asset',
      why: 'Money already sent that no bill has absorbed yet. Her Payments tab showed '
         + '$1,184,471.93 sent and the same amount unapplied — every dollar of it lives here '
         + 'until it is applied, and it is an ASSET, not an expense.' },
    { code: '1400', name: 'Due from related companies', type: 'asset', interCompany: true,
      why: 'One company paid another\'s bill. entities.js flags it; this is where it lands '
         + 'on the paying company\'s books. Must mirror 2400 on the other side.' },

    // ── LIABILITIES ──────────────────────────────────────────────────────
    { code: '2010', name: 'Accounts payable', type: 'liability',
      why: 'What she owes suppliers on bills recorded and not yet paid.' },
    { code: '2050', name: 'Accrued trucking and freight', type: 'liability',
      why: 'Hauliers and carriers billed but unpaid — trucker_bills, metals_trucking, '
         + 'sales_settlements all feed this.' },
    { code: '2100', name: 'Commission payable', type: 'liability',
      why: 'Owed to agents — Joey, Pan Metal, Nik. She confirmed 2026-10-06 these are '
         + 'three different people, and the sale row carries ONE commission field, so this '
         + 'account cannot be broken down by agent until that is fixed (#181).' },
    { code: '2400', name: 'Due to related companies', type: 'liability', interCompany: true,
      why: 'The other half of 1400. If these two do not net to zero across the three '
         + 'companies, an inter-company item has been recorded once instead of twice.' },

    // ── EQUITY ───────────────────────────────────────────────────────────
    { code: '3000', name: 'Owner capital', type: 'equity',
      why: 'Money put in. Separated from drawings so a return does not read them as one.' },
    { code: '3100', name: 'Owner drawings', type: 'equity',
      why: 'Money taken out. A draw is NOT an expense and must never reduce profit.' },
    { code: '3900', name: 'Retained earnings', type: 'equity',
      why: 'Prior years\' profit. The balancing figure that makes a balance sheet balance; '
         + 'if it has to be forced, something above it is wrong.' },

    // ── INCOME ───────────────────────────────────────────────────────────
    { code: '4000', name: 'Material sales', type: 'income',
      why: 'Export container sales — sales.js, the Edge Metals side.' },
    { code: '4100', name: 'Yard sales', type: 'income',
      why: 'Outbound loads from the yard — outbound_loads.js, Edge Trading\'s side. '
         + 'Kept apart from 4000 because they are different companies (CLAUDE.md rule 5) '
         + 'and summing them would be the error that rule exists to prevent.' },
    { code: '4900', name: 'Other income', type: 'income',
      why: 'Claims recovered, rebates, anything that is money in and not a sale.' },

    // ── COST OF GOODS SOLD ───────────────────────────────────────────────
    { code: '5000', name: 'Material purchases', type: 'cogs',
      why: 'What the metal cost. bills.js on the Metals side, loads.js at the yard.' },
    { code: '5100', name: 'Freight and shipping', type: 'cogs',
      why: 'Ocean freight and charges Edge pays rather than bills on. pushInvoice.js:12 '
         + 'records that these are costs, not invoice lines.' },
    { code: '5200', name: 'Trucking', type: 'cogs',
      why: 'Moving material to and from the yard. Already a mapped QuickBooks role '
         + '(qb-party-map.json, account #374).' },
    { code: '5300', name: 'Commission', type: 'cogs',
      why: 'Agent commission on a sale. sales.js folds it into sale_side_cost, so it is '
         + 'already treated as a cost of the sale rather than an overhead.' },
    { code: '5400', name: 'Claims and deductions', type: 'cogs',
      why: 'Short payments and quality claims that reduce what a container earned. '
         + 'bankMatch.js classifies a shortfall rather than hiding it.' },

    // ── OPERATING EXPENSES ───────────────────────────────────────────────
    // These mirror helpers/expenses.js's EXPENSE_CATEGORIES, which are the
    // words she already types. Matching them is deliberate: a chart whose
    // names differ from the screen's is a translation step she has to do in
    // her head every time.
    { code: '6100', name: 'Fuel', type: 'expense', category: 'Fuel' },
    { code: '6110', name: 'Freight (operating)', type: 'expense', category: 'Freight',
      why: 'Her Freight category is an operating cost at the yard. Deliberately NOT 5100 — '
         + 'that is freight on a container being sold. Same word, two different lines.' },
    { code: '6120', name: 'Equipment', type: 'expense', category: 'Equipment' },
    { code: '6130', name: 'Repairs and maintenance', type: 'expense', category: 'Repairs & maintenance' },
    { code: '6140', name: 'Labour', type: 'expense', category: 'Labour' },
    { code: '6150', name: 'Rent', type: 'expense', category: 'Rent' },
    { code: '6160', name: 'Utilities', type: 'expense', category: 'Utilities' },
    { code: '6170', name: 'Supplies', type: 'expense', category: 'Supplies' },
    { code: '6180', name: 'Permits and fees', type: 'expense', category: 'Permits & fees' },
    { code: '6190', name: 'Insurance', type: 'expense', category: 'Insurance' },
    { code: '6200', name: 'Bank charges', type: 'expense',
      why: 'Wire fees and the like. Already a mapped QuickBooks role (account #9), and '
         + 'bankLearn.js teaches a per-party fee allowance from them.' },
    { code: '6900', name: 'Other expenses', type: 'expense', category: 'Other',
      why: 'Her own catch-all. A row landing here is not an error, but a LOT of them is '
         + 'a sign the chart is missing an account she needs.' },
];

const BY_CODE = new Map(ACCOUNTS.map((a) => [a.code, a]));

// Her category strings are FREE TEXT (expenses.js:20-24 — the list is
// quick-picks, not an enum, and blank defaults to 'Other'). So the map is
// built from whatever the accounts declare, matched loosely on case and
// punctuation, and ANYTHING UNRECOGNISED IS REPORTED RATHER THAN SWEPT INTO
// 6900. Silently burying a category she invented is how a chart stops
// describing the business.
const normaliseCategory = (s) => String(s == null ? '' : s)
    .trim().toLowerCase().replace(/[&+]/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();

const BY_CATEGORY = new Map(
    ACCOUNTS.filter((a) => a.category).map((a) => [normaliseCategory(a.category), a.code]),
);

function get(code) { return BY_CODE.get(String(code || '')) || null; }

function normalOf(type) { return NORMAL[String(type || '')] || null; }

// Which statement an account belongs on. Income and costs make the P&L;
// everything else makes the balance sheet. Nothing may be on both, and
// nothing may be on neither — checked by tests rather than assumed.
function statementOf(code) {
    const a = get(code);
    if (!a) return null;
    return ['income', 'cogs', 'expense'].includes(a.type) ? 'profit-and-loss' : 'balance-sheet';
}

// A category to an account code, or null. NEVER a default.
function accountForCategory(category) {
    const n = normaliseCategory(category);
    if (!n) return null;
    return BY_CATEGORY.get(n) || null;
}

// Given the categories actually present in her data, which have nowhere to
// go. The answer is a list she can act on, not a count.
function unmappedCategories(categories = []) {
    const seen = new Map();
    for (const c of (Array.isArray(categories) ? categories : [])) {
        const n = normaliseCategory(c);
        if (!n) continue;
        if (!BY_CATEGORY.has(n)) seen.set(n, (seen.get(n) || 0) + 1);
    }
    return [...seen.entries()]
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count);
}

// ── THE CHART'S OWN INTEGRITY ────────────────────────────────────────────
// Run by the tests and by scripts/coa-reconcile.js. A chart with a repeated
// code or an unknown type produces statements that look fine and add up
// wrongly, which is the failure that is hardest to notice.
function problems() {
    const out = [];
    const codes = new Set();
    for (const a of ACCOUNTS) {
        if (codes.has(a.code)) out.push(`duplicate code ${a.code} (${a.name})`);
        codes.add(a.code);
        if (!TYPES.includes(a.type)) out.push(`${a.code} ${a.name}: unknown type '${a.type}'`);
        if (!/^[1-6]\d{3}$/.test(a.code)) out.push(`${a.code} ${a.name}: code outside 1000-6999`);
        // The range must agree with the type, or a statement ordered by code
        // puts a liability in the middle of the assets.
        const band = { 1: 'asset', 2: 'liability', 3: 'equity', 4: 'income', 5: 'cogs', 6: 'expense' }[a.code[0]];
        if (band !== a.type) out.push(`${a.code} ${a.name}: a ${a.type} in the ${band} range`);
        if (!a.why && !a.category) out.push(`${a.code} ${a.name}: no reason given`);
    }
    const inter = ACCOUNTS.filter((a) => a.interCompany);
    if (inter.length !== 2) out.push(`inter-company accounts must come in a pair, found ${inter.length}`);
    return out;
}

module.exports = {
    ACCOUNTS, TYPES, NORMAL,
    get, normalOf, statementOf, accountForCategory, unmappedCategories,
    normaliseCategory, problems,
};
