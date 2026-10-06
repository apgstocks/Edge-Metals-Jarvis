// ── tests/statements.js ───────────────────────────────────────────────────
// Apsara, 2026-10-06: the year-end pack for her CPA — trial balance, general
// ledger, P&L, balance sheet, PER COMPANY.
//
// The value of these four is not that each prints. It is that they AGREE.
// A P&L whose profit does not appear on the balance sheet is the kind of
// thing an accountant finds and a business owner does not, and it is why
// they live in one file rather than four.
//
// Three ties, and everything here is ultimately about them:
//   1. a trial balance's debits equal its credits
//   2. a general ledger for one account sums to its trial balance figure
//   3. assets = liabilities + equity + the profit on the P&L

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-stmt-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated — refusing to run against real data');
    process.exit(1);
}

const P = require(path.join(ROOT, 'helpers/postings'));
const S = require(path.join(ROOT, 'helpers/statements'));
const E = require(path.join(ROOT, 'helpers/entities'));

// A year with something of everything in it, including an inter-company
// payment so both companies are exercised at once.
const YEAR = [
    { kind: 'metals-purchase', entity: 'edge-metals', amount: 10000, trucking: 800, date: '2026-03-01' },
    { kind: 'metals-sale', entity: 'edge-metals', amount: 50000, commission: 1200, date: '2026-03-15' },
    { kind: 'supplier-payment', entity: 'edge-metals', amount: 5000, applied: 2000, bank: 'BofA', date: '2026-04-01' },
    { kind: 'customer-receipt', entity: 'edge-metals', amount: 49000, shortfall: 1000, bank: 'BofA', date: '2026-04-10' },
    { kind: 'bank-charge', entity: 'edge-metals', amount: 35, bank: 'BofA', date: '2026-04-10' },
    { kind: 'yard-purchase', entity: 'edge-trading', amount: 4000, date: '2026-05-02' },
    { kind: 'yard-sale', entity: 'edge-trading', amount: 7000, date: '2026-05-20' },
    { kind: 'expense', entity: 'edge-trading', amount: 250, category: 'Fuel', bank: 'Chase', date: '2026-05-21' },
    // Edge Metals settles one of the yard's bills.
    { kind: 'supplier-payment', entity: 'edge-trading', amount: 4000, applied: 4000,
      bank: 'BofA', paidBy: 'edge-metals', date: '2026-06-01' },
];
const J = P.journal(YEAR);
const METALS = { entity: 'edge-metals' };
const YARD = { entity: 'edge-trading' };

// ── A — THE JOURNAL IT ALL RESTS ON ───────────────────────────────────────
{
    section('A — the journal underneath');
    ck('the fixture posts cleanly', J.complete === true, JSON.stringify(J.problems));
    ck('  and balances', J.balanced === true, `${J.debit} vs ${J.credit}`);
    ck('  with every company balancing on its own',
       J.everyEntityBalanced === true, JSON.stringify(J.entities));
}

// ── B — TIE ONE: THE TRIAL BALANCE ────────────────────────────────────────
{
    section('B — debits equal credits');

    const tb = S.trialBalance(J.lines, METALS);
    ck('Edge Metals balances', tb.balanced === true, `${tb.debit} vs ${tb.credit}`);
    ck('  with no account outside the chart', tb.unknown.length === 0, JSON.stringify(tb.unknown));
    ck('  and it says it is ok', tb.ok === true);

    const ty = S.trialBalance(J.lines, YARD);
    ck('the yard balances too, separately', ty.balanced === true, `${ty.debit} vs ${ty.credit}`);

    // Balance shown on the account's own normal side.
    const payable = tb.accounts.find((a) => a.code === '2010');
    ck('a payable shows its balance on the credit side',
       payable.normal === 'credit' && payable.balance === 8000,
       JSON.stringify(payable));
    // 49,000 received, less the 5,000 supplier payment, the 35 bank charge
    // and the 4,000 Edge Metals put up for the yard. That last one is the
    // point: it is money that left Edge Metals' bank for someone else's
    // bill, and an earlier version of this expectation omitted it — the
    // figure was stale, not the code.
    const bank = tb.accounts.find((a) => a.code === '1010');
    ck('  and a bank on the debit side', bank.normal === 'debit' && bank.balance === 39965,
       JSON.stringify(bank));
    ck('  with the inter-company funding really taken out of it',
       bank.credit === 9035, `${bank.credit} — 5000 paid + 35 charge + 4000 funded for the yard`);

    // ── AN ACCOUNT NOT IN THE CHART IS SURFACED ──────────────────────────
    // It would land on no statement, making the P&L and balance sheet
    // silently disagree with the trial balance.
    const strays = S.trialBalance([{ entity: 'edge-metals', account: '9999', debit: 5, credit: 0, date: '2026-01-01' },
        { entity: 'edge-metals', account: '1010', debit: 0, credit: 5, date: '2026-01-01' }], METALS);
    ck('an account outside the chart is reported, not ignored',
       strays.unknown.length === 1 && strays.unknown[0].code === '9999', JSON.stringify(strays.unknown));
    ck('  and the trial balance is NOT called ok even though it balances',
       strays.balanced === true && strays.ok === false,
       'balancing is not the same as being right');
}

// ── C — TIE TWO: THE LEDGER SUMS TO THE TRIAL BALANCE ─────────────────────
{
    section('C — every account opens to its own movements');

    const tb = S.trialBalance(J.lines, METALS);
    for (const a of tb.accounts) {
        const gl = S.generalLedger(J.lines, { ...METALS, account: a.code });
        ck(`  ${a.code} ${a.name}: the ledger closes where the trial balance says`,
           gl.closing === a.balance, `ledger ${gl.closing} vs trial balance ${a.balance}`);
    }

    const gl = S.generalLedger(J.lines, { ...METALS, account: '1010' });
    ck('the ledger is in date order',
       gl.entries.every((e, i) => i === 0 || String(gl.entries[i - 1].date) <= String(e.date)),
       JSON.stringify(gl.entries.map((e) => e.date)));
    ck('  and carries a running balance', gl.entries[gl.entries.length - 1].balance === gl.closing);
    ck('  with the kind of transaction on every line',
       gl.entries.every((e) => !!e.kind), JSON.stringify(gl.entries.map((e) => e.kind)));
    ck('  so a figure can be followed to what caused it',
       gl.entries.length >= 2, String(gl.entries.length));

    let threw = null;
    try { S.generalLedger(J.lines, METALS); } catch (e) { threw = e.message; }
    ck('a ledger with no account named is refused', /needs an account/.test(String(threw)), String(threw));
}

// ── D — TIE THREE: THE BALANCE SHEET BALANCES ─────────────────────────────
{
    section('D — assets = liabilities + equity + profit');

    for (const [label, o] of [['Edge Metals', METALS], ['the yard', YARD]]) {
        const bs = S.balanceSheet(J.lines, o);
        ck(`${label}'s balance sheet balances`, bs.balances === true,
           `assets ${bs.assetTotal} vs ${bs.rightSide}, out by ${bs.difference}`);
        const pl = S.profitAndLoss(J.lines, o);
        ck(`  and the profit on it is the P&L's own figure`,
           bs.netIncome === pl.netIncome, `${bs.netIncome} vs ${pl.netIncome}`);
    }

    const pl = S.profitAndLoss(J.lines, METALS);
    ck('gross profit is income less cost of sales',
       pl.grossProfit === Math.round((pl.incomeTotal - pl.cogsTotal) * 100) / 100,
       JSON.stringify({ i: pl.incomeTotal, c: pl.cogsTotal, g: pl.grossProfit }));
    ck('  and net is gross less overheads',
       pl.netIncome === Math.round((pl.grossProfit - pl.expenseTotal) * 100) / 100,
       JSON.stringify({ g: pl.grossProfit, e: pl.expenseTotal, n: pl.netIncome }));

    // ── COMMISSION IS A COST, SO IT IS BELOW INCOME, NOT NETTED OFF ──────
    ck('income is the full invoice, with commission as a cost beneath it',
       pl.incomeTotal === 50000 && pl.cogs.some((a) => a.code === '5300'),
       JSON.stringify({ income: pl.incomeTotal, cogs: pl.cogs.map((a) => a.code) }));

    // ── AN ADVANCE SITS ON THE BALANCE SHEET, NOT THE P&L ───────────────
    const bs = S.balanceSheet(J.lines, METALS);
    ck('the unapplied advance is an asset on the balance sheet',
       bs.assets.some((a) => a.code === '1350' && a.balance === 3000), JSON.stringify(bs.assets));
    ck('  and appears nowhere on the P&L',
       ![...pl.income, ...pl.cogs, ...pl.expense].some((a) => a.code === '1350'),
       'as a cost it would take money off profit that she has not spent');
}

// ── E — NEVER ACROSS COMPANIES ────────────────────────────────────────────
// CLAUDE.md rule 5. A combined figure belongs on no return.
{
    section('E — three taxpayers, never one total');

    const m = S.trialBalance(J.lines, METALS);
    const y = S.trialBalance(J.lines, YARD);
    ck('the two trial balances are different', m.debit !== y.debit, `${m.debit} vs ${y.debit}`);
    ck('  and neither includes the other\'s yard sales account',
       !m.accounts.some((a) => a.code === '4100') && y.accounts.some((a) => a.code === '4100'),
       JSON.stringify({ metals: m.accounts.map((a) => a.code), yard: y.accounts.map((a) => a.code) }));

    let threw = null;
    try { S.trialBalance(J.lines, {}); } catch (e) { threw = e.message; }
    ck('a statement with no company is REFUSED',
       /no combined taxpayer/.test(String(threw)), String(threw));

    // The inter-company payment must show on both, as mirror images.
    const mTb = S.trialBalance(J.lines, METALS);
    const yTb = S.trialBalance(J.lines, YARD);
    const due = mTb.accounts.find((a) => a.code === '1400');
    const owed = yTb.accounts.find((a) => a.code === '2400');
    ck('Edge Metals is owed by the yard', !!due && due.balance === 4000, JSON.stringify(due));
    ck('  and the yard owes Edge Metals the same', !!owed && owed.balance === 4000, JSON.stringify(owed));
    ck('  equal and opposite, or it was recorded once instead of twice',
       due.balance === owed.balance);
}

// ── F — DATES ─────────────────────────────────────────────────────────────
{
    section('F — a period, not everything');

    const q1 = S.trialBalance(J.lines, { ...METALS, from: '2026-03-01', to: '2026-03-31' });
    ck('a quarter sees only its own rows', q1.debit < S.trialBalance(J.lines, METALS).debit,
       `${q1.debit} vs ${S.trialBalance(J.lines, METALS).debit}`);
    ck('  and still balances', q1.balanced === true, `${q1.debit} vs ${q1.credit}`);

    // Compared as strings on purpose: parsing into Date drags in a timezone,
    // and a container invoiced on the 31st must not slide into next month
    // because the server is somewhere else.
    ck('the last day of the range is INCLUDED',
       S.inRange('2026-03-31', '2026-03-01', '2026-03-31') === true,
       'an exclusive end date silently drops every transaction on the 31st');
    ck('  and the first', S.inRange('2026-03-01', '2026-03-01', '2026-03-31') === true);
    ck('  while the day after is not', S.inRange('2026-04-01', '2026-03-01', '2026-03-31') === false);
    ck('  and no range means everything', S.inRange('2026-04-01') === true);
}

// ── G — THE PACK REFUSES RATHER THAN PRINTS ───────────────────────────────
{
    section('G — a pack that does not tie is not a pack');

    const good = S.pack(J.lines, METALS);
    ck('a sound pack says so', good.ok === true, JSON.stringify(good.problems));
    ck('  and carries all four statements',
       !!good.trialBalance && !!good.profitAndLoss && !!good.balanceSheet, Object.keys(good).join(','));
    ck('  and names the company', good.company && good.company.legalName === 'Edge Metals INC',
       JSON.stringify(good.company && good.company.legalName));

    // A deliberately one-sided journal: the exact shape of a posting rule
    // that forgot a line.
    const broken = [{ entity: 'edge-metals', account: '5000', debit: 100, credit: 0, date: '2026-01-01', kind: 'x' }];
    const bad = S.pack(broken, METALS);
    ck('an unbalanced journal makes the pack refuse', bad.ok === false, JSON.stringify(bad.problems));
    ck('  and says by how much',
       /does not balance: debits 100 vs credits 0/.test(bad.problems.join(' ')), JSON.stringify(bad.problems));

    // ── FILABLE IS A SEPARATE QUESTION FROM CORRECT ──────────────────────
    // Edge Trading has no tax ID; AAA has neither tax ID nor address.
    ck('Edge Metals can be filed', good.filable === true, JSON.stringify(good.filingBlockers));
    const yardPack = S.pack(J.lines, YARD);
    ck('  the yard ties but canNOT be filed',
       yardPack.ok === true && yardPack.filable === false, JSON.stringify(yardPack.filingBlockers));
    ck('  and it names the tax ID as the blocker',
       yardPack.filingBlockers.includes('tax ID'), JSON.stringify(yardPack.filingBlockers));
    ck('  which is a different thing from the arithmetic being wrong',
       yardPack.problems.length === 0, JSON.stringify(yardPack.problems));
}

// ── H — IT DOES NOT FALL OVER ─────────────────────────────────────────────
{
    section('H — a year of rows, some of them rubbish');

    let threw = null;
    try {
        S.trialBalance([], METALS);
        S.trialBalance(null, METALS);
        S.trialBalance([null, undefined, 0, 'x'], METALS);
        S.profitAndLoss([], METALS);
        S.balanceSheet([], METALS);
        S.pack([], METALS);
        S.generalLedger([], { ...METALS, account: '1010' });
    } catch (e) { threw = e.message; }
    ck('nothing throws on empty or rubbish', threw === null, String(threw));
    ck('  an empty trial balance balances trivially',
       S.trialBalance([], METALS).balanced === true);
    ck('  and an empty pack is ok', S.pack([], METALS).ok === true);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
