// ── tests/retained-earnings.js ────────────────────────────────────────────
// A balance sheet that rolls over a year-end.
//
// Apsara, 2026-10-23: "from next year-no qb", "so accounts should be
// perfectly handled". From January there is no QuickBooks to cross-check
// against, so the first balance sheet that spans a year boundary has to be
// right on its own, the first time, with nothing to compare it to.
//
// ── WHAT THIS FILE IS REALLY GUARDING ────────────────────────────────────
// helpers/statements.balanceSheet used to filter EVERY account by the period,
// `from` included — so a 2027 sheet reported 2027's MOVEMENT in cash, not the
// cash the company held. And it balanced anyway, because every journal entry
// balances and therefore any complete subset of them does:
//
//     debits = credits  =>  Δassets = Δliabilities + Δequity + period profit
//
// which is exactly what the old rightSide computed. The tie this whole stack
// treats as its proof of correctness was an identity that holds for ANY date
// range. Section E is the one that matters: it proves the tie can now fail.
// A check that cannot go red is not a check.

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-re-'));
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

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const METALS = 'edge-metals';

// Two years, so there is genuinely a prior period to carry. Kept small and
// hand-checkable on purpose: every figure below can be verified with a
// calculator, which is the only way to catch a formula that is internally
// consistent and wrong.
const TX = [
    { kind: 'metals-purchase', entity: METALS, amount: 10000, trucking: 800, date: '2026-03-01' },
    { kind: 'metals-sale', entity: METALS, amount: 50000, commission: 1200, date: '2026-03-15' },
    { kind: 'customer-receipt', entity: METALS, amount: 49000, shortfall: 1000, bank: 'BofA', date: '2026-04-10' },
    // ── year two ──
    { kind: 'metals-purchase', entity: METALS, amount: 20000, trucking: 900, date: '2027-02-01' },
    { kind: 'metals-sale', entity: METALS, amount: 31000, commission: 500, date: '2027-02-20' },
];
const J = P.journal(TX);

// The old formula, kept here as the thing to compare against rather than
// described in a comment. If a later change quietly reverts to it, D fails.
const oldRightSide = (b) => r2(b.liabilityTotal + b.equityTotal + b.netIncome);

// ─────────────────────────────────────────────────────────────────────────
section('A. no prior period — every figure identical to before the change');
// This is the whole of her 2026 year-to-date pack, so it is the case that
// must not have moved by a cent.
{
    const all = S.balanceSheet(J.lines, { entity: METALS });
    ck('from unset: retained earnings is 0',
       all.retainedEarnings === 0, String(all.retainedEarnings));
    ck('  and the old formula still gives the same right-hand side',
       oldRightSide(all) === all.rightSide, `${oldRightSide(all)} vs ${all.rightSide}`);
    ck('  and it balances', all.balances === true, `out by ${all.difference}`);

    const y1 = S.balanceSheet(J.lines, { entity: METALS, from: '2026-01-01', to: '2026-12-31' });
    ck('year one, whose journal has nothing before it: retained earnings is 0',
       y1.retainedEarnings === 0, String(y1.retainedEarnings));
    ck('  and the old formula agrees here too',
       oldRightSide(y1) === y1.rightSide, `${oldRightSide(y1)} vs ${y1.rightSide}`);
    ck('  and it balances', y1.balances === true, `out by ${y1.difference}`);
}

// ─────────────────────────────────────────────────────────────────────────
section('B. year two carries year one, and the positions are positions');
{
    const y1 = S.balanceSheet(J.lines, { entity: METALS, from: '2026-01-01', to: '2026-12-31' });
    const y2 = S.balanceSheet(J.lines, { entity: METALS, from: '2027-01-01', to: '2027-12-31' });
    const all = S.balanceSheet(J.lines, { entity: METALS });

    ck('year two balances', y2.balances === true, `out by ${y2.difference}`);
    ck('  retained earnings equals year one\'s profit, to the cent',
       y2.retainedEarnings === y1.netIncome, `${y2.retainedEarnings} vs ${y1.netIncome}`);

    // THE DEFECT, stated as a figure. Assets as at the end of 2027 are the
    // company's assets, not 2027's movement in them.
    ck('  assets are the as-at balance, not the period movement',
       y2.assetTotal === all.assetTotal,
       `year-two sheet says ${y2.assetTotal}, the company holds ${all.assetTotal}`);
    ck('  liabilities likewise',
       y2.liabilityTotal === all.liabilityTotal,
       `${y2.liabilityTotal} vs ${all.liabilityTotal}`);

    // And the half that makes retained earnings load-bearing rather than
    // decorative: without it, these correct positions do NOT tie.
    ck('  WITHOUT retained earnings the sheet would be out by year one\'s profit',
       r2(y2.assetTotal - oldRightSide(y2)) === y1.netIncome,
       `gap ${r2(y2.assetTotal - oldRightSide(y2))} vs year-one profit ${y1.netIncome}`);

    // Profit is still the period's, not cumulative — the easiest way to get
    // this wrong is to make everything as-at and double-count the profit.
    ck('  profit for the period is year two\'s alone',
       y2.netIncome === r2(all.netIncome - y1.netIncome),
       `${y2.netIncome} vs ${r2(all.netIncome - y1.netIncome)}`);
    ck('  and retained + period profit comes to all-time profit',
       r2(y2.retainedEarnings + y2.netIncome) === all.netIncome,
       `${r2(y2.retainedEarnings + y2.netIncome)} vs ${all.netIncome}`);
}

// ─────────────────────────────────────────────────────────────────────────
section('C. a period opening mid-year, which is the quarterly case');
{
    // from 2026-04-01: the March purchase and sale are behind it.
    const q = S.balanceSheet(J.lines, { entity: METALS, from: '2026-04-01', to: '2026-12-31' });
    const beforeApril = S.profitAndLoss(
        J.lines.filter((l) => l.entity === METALS && l.date < '2026-04-01'), { entity: METALS });

    ck('a mid-year sheet balances', q.balances === true, `out by ${q.difference}`);
    ck('  and carries exactly the profit made before it opened',
       q.retainedEarnings === beforeApril.netIncome,
       `${q.retainedEarnings} vs ${beforeApril.netIncome}`);
    ck('  which is not zero, or this section is testing nothing',
       q.retainedEarnings !== 0, String(q.retainedEarnings));
}

// ─────────────────────────────────────────────────────────────────────────
section('D. priorLines is exclusive on `from`, and per company');
{
    const prior = S.priorLines(J.lines, { entity: METALS, from: '2027-01-01' });
    ck('every prior line is strictly before `from`',
       prior.length > 0 && prior.every((l) => l.date < '2027-01-01'),
       `${prior.length} lines`);
    ck('  a line dated exactly `from` is NOT prior',
       S.priorLines(J.lines, { entity: METALS, from: '2026-03-01' })
           .every((l) => l.date !== '2026-03-01'),
       'boundary is exclusive');
    ck('  no `from` means no prior period at all',
       S.priorLines(J.lines, { entity: METALS }).length === 0, 'empty');
    ck('  and it refuses to work without a company (CLAUDE.md rule 5)',
       (() => { try { S.priorLines(J.lines, { from: '2027-01-01' }); return false; }
                catch (e) { return /company/i.test(e.message); } })(), 'should throw');
    // Another company's lines must never land in this one's retained earnings.
    const mixed = P.journal(TX.concat([
        { kind: 'yard-purchase', entity: 'edge-trading', amount: 999999, date: '2026-05-02' },
    ]));
    const y2 = S.balanceSheet(mixed.lines, { entity: METALS, from: '2027-01-01', to: '2027-12-31' });
    const y2clean = S.balanceSheet(J.lines, { entity: METALS, from: '2027-01-01', to: '2027-12-31' });
    ck('  the other company\'s prior year does not leak in',
       y2.retainedEarnings === y2clean.retainedEarnings,
       `${y2.retainedEarnings} vs ${y2clean.retainedEarnings}`);
}

// ─────────────────────────────────────────────────────────────────────────
section('E. THE TIE CAN NOW FAIL — the old one could not');
// The old balanceSheet balanced for every date range by construction. If this
// section passes while the arithmetic is broken, the whole file is decoration.
{
    // One unbalanced line, injected directly: a debit to an asset with no
    // credit anywhere. No real posting rule can produce this, which is the
    // point — it is the shape of a bug in helpers/postings.js.
    const asset = J.lines.find((l) => l.debit && l.account);
    const broken = J.lines.concat([{
        entity: METALS, date: '2027-03-01', account: asset.account,
        debit: 5000, credit: 0, memo: 'deliberately unbalanced',
    }]);
    const b = S.balanceSheet(broken, { entity: METALS, from: '2027-01-01', to: '2027-12-31' });
    ck('an unbalanced journal makes the sheet NOT balance',
       b.balances === false, `balances=${b.balances}, out by ${b.difference}`);
    ck('  and the gap reported is the gap injected',
       Math.abs(b.difference) === 5000, String(b.difference));

    // Same injection, dated BEFORE the period: it must still surface, because
    // the positions are cumulative. Under the old code this was invisible —
    // the line was filtered out by `from` and the sheet balanced happily.
    const earlier = J.lines.concat([{
        entity: METALS, date: '2026-07-01', account: asset.account,
        debit: 5000, credit: 0, memo: 'deliberately unbalanced, prior year',
    }]);
    const e = S.balanceSheet(earlier, { entity: METALS, from: '2027-01-01', to: '2027-12-31' });
    ck('a prior-year imbalance is visible on a current-year sheet',
       e.balances === false, `balances=${e.balances}, out by ${e.difference}`);
}

// ─────────────────────────────────────────────────────────────────────────
section('F. pack() names retained earnings only when there is some');
{
    const y2 = S.pack(J.lines, { entity: METALS, from: '2027-01-01', to: '2027-12-31' });
    ck('the second-year pack has no problems', y2.ok === true, y2.problems.join(' | '));

    // Force a problem so the wording can be read.
    const broken = J.lines.concat([{
        entity: METALS, date: '2027-03-01', account: J.lines[0].account,
        debit: 5000, credit: 0, memo: 'unbalanced',
    }]);
    const bad = S.pack(broken, { entity: METALS, from: '2027-01-01', to: '2027-12-31' });
    const msg = bad.problems.find((p) => /balance sheet is out by/.test(p)) || '';
    ck('with retained earnings, the sentence names them',
       /retained earnings/.test(msg), msg || '(no balance-sheet problem raised)');

    const brokenY1 = J.lines.concat([{
        entity: METALS, date: '2026-07-01', account: J.lines[0].account,
        debit: 5000, credit: 0, memo: 'unbalanced',
    }]);
    const badY1 = S.pack(brokenY1, { entity: METALS, from: '2026-01-01', to: '2026-12-31' });
    const msgY1 = badY1.problems.find((p) => /balance sheet is out by/.test(p)) || '';
    ck('  without them, the sentence reads exactly as it did before',
       msgY1 !== '' && !/retained earnings/.test(msgY1), msgY1 || '(none raised)');
}

// ─────────────────────────────────────────────────────────────────────────
section('G. the CPA pack PRINTS it — the figure is inside rightSide');
// If it is in the total but not on the sheet, a CPA adding up the printed
// rows lands short by the prior years' profit and the pack looks wrong.
//
// ── THIS SECTION'S FIRST DRAFT WAS DECORATION ────────────────────────────
// It rebuilt the row-adding logic inside the test, from the same figures, and
// asserted against its own copy — so suppressing the row in booksPack.js
// changed nothing here and the mutation SURVIVED. It even carried a comment
// claiming it was "not a mock of the helper". It was. Now it drives the real
// toWorkbook and reads the rows back out of a written workbook, the way Excel
// would, which is how tests/books-pack.js already does it.
(async () => {
    let ExcelJS = null;
    try { ExcelJS = require(path.join(ROOT, 'node_modules/exceljs')); }
    catch (e) { ExcelJS = null; }

    if (!ExcelJS) {
        console.log('  SKIP  exceljs not resolvable here — booksPack not exercised');
        ck('exceljs is resolvable so the CPA pack can be checked', false,
           'the pack is the deliverable; a skip here is a gap, not a pass');
    } else {
        const BP = require(path.join(ROOT, 'helpers/booksPack'));

        // The shape booksBuild.build returns, carrying OUR two-year journal
        // rather than whatever is in the data dir — so the figures asserted
        // below are the hand-checkable ones from the top of this file.
        const builtFrom = (opts) => ({
            from: opts.from || null, to: opts.to || null,
            transactions: TX.length, journal: J, lines: J.lines,
            unplaced: [], notes: [], complete: true, problems: [],
        });

        const sheetText = async (opts) => {
            const { workbook } = await BP.toWorkbook(builtFrom(opts),
                { entity: METALS, from: opts.from, to: opts.to, when: 'TEST-STAMP' });
            const wb = new ExcelJS.Workbook();
            await wb.xlsx.load(await workbook.xlsx.writeBuffer());
            const ws = wb.getWorksheet('Balance Sheet');
            const out = [];
            for (let i = 1; i <= ws.rowCount; i += 1) {
                ws.getRow(i).eachCell({ includeEmpty: false }, (c) => out.push(String(c.value)));
            }
            return out.join('\n');
        };

        const y2opts = { entity: METALS, from: '2027-01-01', to: '2027-12-31' };
        const b2 = S.balanceSheet(J.lines, y2opts);
        const t2 = await sheetText(y2opts);
        ck('a second-year Balance Sheet prints the retained earnings row',
           /Retained earnings/.test(t2), t2);
        ck('  naming the date it is everything before',
           t2.includes('before 2027-01-01'), t2);
        ck('  with the figure on it, not a label alone',
           t2.includes(String(b2.retainedEarnings)), `looking for ${b2.retainedEarnings}`);
        ck('  and the printed rows sum to the printed total',
           r2(b2.liabilityTotal + b2.equityTotal + b2.retainedEarnings + b2.netIncome)
               === b2.rightSide, String(b2.rightSide));

        const y1opts = { entity: METALS, from: '2026-01-01', to: '2026-12-31' };
        const t1 = await sheetText(y1opts);
        ck('a first-year Balance Sheet does NOT gain a 0.00 row',
           !/Retained earnings/.test(t1), t1);
        ck('  and its total still reads "Liabilities, equity and profit"',
           /Liabilities, equity and profit/.test(t1), t1);
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILURES:\n  ' + failures.join('\n  ')); process.exit(1); }
})().catch((e) => { console.error('\nCRASHED: ' + (e && e.stack || e)); process.exit(1); });
