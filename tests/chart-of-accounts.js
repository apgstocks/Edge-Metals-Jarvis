// ── tests/chart-of-accounts.js ────────────────────────────────────────────
// Apsara, 2026-10-06, on what "the best QuickBooks" means first: the year-end
// pack for her CPA. P&L, balance sheet, general ledger and trial balance are
// all VIEWS OVER ACCOUNTS, and Jarvis owned none — the chart was read live
// from QuickBooks and exactly three accounts were mapped to anything.
//
// A chart gets things wrong in a particular way: the statement still prints,
// the columns still line up, and the figures are wrong. A repeated code, a
// liability sitting in the asset range, a category quietly swept into
// "Other" — none of those throw. They just produce a return that does not
// match the business.
//
// So these checks are mostly about arithmetic that cannot be seen.

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-coa-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated — refusing to run against real data');
    process.exit(1);
}

const C = require(path.join(ROOT, 'helpers/chartOfAccounts'));

// ── A — THE CHART HOLDS TOGETHER ──────────────────────────────────────────
{
    section('A — a chart that adds up wrongly still prints');

    ck('the chart reports no problems with itself',
       C.problems().length === 0, JSON.stringify(C.problems()));

    // problems() must actually bite, or "no problems" means nothing.
    const codes = C.ACCOUNTS.map((a) => a.code);
    ck('  every code is unique', new Set(codes).size === codes.length,
       JSON.stringify(codes.filter((c, i) => codes.indexOf(c) !== i)));
    ck('  and every code sits in the band its type belongs to',
       C.ACCOUNTS.every((a) => ({ 1: 'asset', 2: 'liability', 3: 'equity',
           4: 'income', 5: 'cogs', 6: 'expense' })[a.code[0]] === a.type),
       'a liability in the asset range puts it in the wrong half of the balance sheet');
    ck('  and every account justifies itself',
       C.ACCOUNTS.every((a) => a.why || a.category),
       'an account nobody can explain gets used for the wrong thing');
}

// ── B — THE SIGNS ─────────────────────────────────────────────────────────
// The error that balances. Debit an income account instead of crediting it
// and the trial balance is still zero while profit has the wrong sign.
{
    section('B — which side increases an account');

    ck('an asset increases on the debit side', C.normalOf('asset') === 'debit');
    ck('  an expense too', C.normalOf('expense') === 'debit');
    ck('  and a cost of goods sold', C.normalOf('cogs') === 'debit');
    ck('a liability increases on the credit side', C.normalOf('liability') === 'credit');
    ck('  so does equity', C.normalOf('equity') === 'credit');
    ck('  and income', C.normalOf('income') === 'credit',
       'debiting income still balances — and reports a loss as a profit');
    ck('an unknown type has no normal side', C.normalOf('nonsense') === null);
    ck('  and neither does a blank one', C.normalOf('') === null && C.normalOf(null) === null);
}

// ── C — EVERY ACCOUNT IS ON EXACTLY ONE STATEMENT ─────────────────────────
// On both, and it is counted twice. On neither, and money disappears from
// the books without anything being out of balance.
{
    section('C — on exactly one statement, never both, never neither');

    const placed = C.ACCOUNTS.map((a) => ({ code: a.code, where: C.statementOf(a.code) }));
    ck('every account lands somewhere',
       placed.every((p) => p.where === 'profit-and-loss' || p.where === 'balance-sheet'),
       JSON.stringify(placed.filter((p) => !p.where)));

    const pl = placed.filter((p) => p.where === 'profit-and-loss').length;
    const bs = placed.filter((p) => p.where === 'balance-sheet').length;
    ck('  and the two add back to the whole chart',
       pl + bs === C.ACCOUNTS.length, `${pl} + ${bs} vs ${C.ACCOUNTS.length}`);

    // The specific placements a CPA would check first.
    ck('income is on the P&L', C.statementOf('4000') === 'profit-and-loss');
    ck('  and so is a cost of sale', C.statementOf('5000') === 'profit-and-loss');
    ck('  and an operating expense', C.statementOf('6100') === 'profit-and-loss');
    ck('a bank account is on the balance sheet', C.statementOf('1010') === 'balance-sheet');
    ck('  and so is what she owes', C.statementOf('2010') === 'balance-sheet');
    ck('  and retained earnings', C.statementOf('3900') === 'balance-sheet');

    // ── OWNER DRAWINGS ARE NOT AN EXPENSE ────────────────────────────────
    // Money taken out of the business must never reduce profit. Putting it
    // on the P&L understates tax and is one of the first things an
    // accountant looks for.
    ck('owner drawings are equity, NOT an expense',
       C.get('3100').type === 'equity' && C.statementOf('3100') === 'balance-sheet',
       'a draw on the P&L understates profit and therefore tax');

    // ── AN ADVANCE IS AN ASSET ───────────────────────────────────────────
    // Her Payments tab showed $1,184,471.93 sent and the SAME amount
    // unapplied. If an unapplied advance were booked as an expense, that
    // whole figure would come off profit for money she has not yet consumed.
    ck('an advance to a supplier is an asset, not an expense',
       C.get('1350').type === 'asset',
       '$1.18M sitting unapplied would otherwise come straight off profit');
}

// ── D — HER CATEGORIES, WHICH ARE FREE TEXT ───────────────────────────────
// expenses.js:20-24 is explicit that the category list is quick-picks, not
// an enum — anything can be typed. So the mapping is checked against the
// real list rather than a copy, and an unknown category must be REPORTED.
{
    section('D — the words she actually types');

    const E = require(path.join(ROOT, 'helpers/expenses'));
    const cats = E.EXPENSE_CATEGORIES || [];
    ck('her category list is readable from expenses.js', cats.length > 0, String(cats.length));

    for (const c of cats) {
        ck(`  "${c}" has an account`, !!C.accountForCategory(c),
           'a category with nowhere to go ends up in Other, where nobody looks for it');
    }

    // Matching has to survive how she really types.
    ck('matching ignores case', C.accountForCategory('fuel') === C.accountForCategory('Fuel'));
    ck('  and "&" versus "and"',
       C.accountForCategory('Repairs & maintenance') === C.accountForCategory('Repairs and maintenance'));
    ck('  and stray spacing', C.accountForCategory('  Permits & fees  ') === '6180');

    // ── AND IT NEVER DEFAULTS ────────────────────────────────────────────
    // Sweeping an unknown category into 6900 would hide the fact that the
    // chart is missing an account she needs.
    ck('an unknown category gets NO account rather than Other',
       C.accountForCategory('Diesel') === null, String(C.accountForCategory('Diesel')));
    ck('  blank gets none either',
       C.accountForCategory('') === null && C.accountForCategory(null) === null);

    const un = C.unmappedCategories(['Fuel', 'Diesel', 'diesel', 'Tools', '', null, 'Rent']);
    ck('unmapped categories are reported, with counts',
       un.length === 2, JSON.stringify(un));
    ck('  the commonest first, so she fixes what matters',
       un[0].category === 'diesel' && un[0].count === 2, JSON.stringify(un));
    ck('  and the ones that DO map are not listed',
       !un.some((u) => /fuel|rent/.test(u.category)), JSON.stringify(un));
}

// ── E — THE TWO COMPANIES STAY APART ──────────────────────────────────────
// CLAUDE.md rule 5. One sales account for both would make the single figure
// that rule exists to prevent.
{
    section('E — Edge Metals and the yard do not share a line');

    ck('export sales and yard sales are different accounts',
       C.get('4000').code !== C.get('4100').code
       && C.get('4000').type === 'income' && C.get('4100').type === 'income',
       'one combined sales line is exactly what rule 5 forbids');

    // ── THE TWO FREIGHTS ─────────────────────────────────────────────────
    // "Freight" is both a cost of a container being sold AND one of her yard
    // expense categories. Same word, two lines, on purpose.
    ck('freight on a sale and freight as an expense are separate',
       C.get('5100').type === 'cogs' && C.get('6110').type === 'expense',
       'collapsing them moves cost between gross margin and overhead');
    ck('  and her "Freight" category maps to the operating one',
       C.accountForCategory('Freight') === '6110',
       'her Expenses tab is the yard\'s, so its Freight is an operating cost');
}

// ── F — INTER-COMPANY, OR THE MONEY VANISHES ──────────────────────────────
// She confirmed 2026-10-06 that AAA Investment is a third company with its
// own return. entities.js detects one company's money paying another's
// transaction; it has to LAND somewhere on both sets of books.
{
    section('F — three companies, so money moves between them');

    const inter = C.ACCOUNTS.filter((a) => a.interCompany);
    ck('there is an inter-company pair', inter.length === 2, JSON.stringify(inter.map((a) => a.code)));
    ck('  one an asset, one a liability',
       inter.some((a) => a.type === 'asset') && inter.some((a) => a.type === 'liability'),
       'a receivable on one company and a payable on the other, or it is counted once');
    ck('  and they say they must mirror each other',
       /mirror|other half|net to zero/i.test(C.get('1400').why + C.get('2400').why),
       JSON.stringify([C.get('1400').why, C.get('2400').why]));

    // entities.js is the thing that finds them. If it stops flagging
    // inter-company rows these accounts never receive anything.
    const Ent = require(path.join(ROOT, 'helpers/entities'));
    const r = Ent.of('payments', { load_kind: 'purchase', paid_via: 'Edge Metals', amount: 1 });
    ck('entities.js still flags the case these accounts exist for',
       r.interCompany === true, JSON.stringify(r));
    ck('  and there are three companies to move money between',
       Ent.ENTITIES.length === 3, String(Ent.ENTITIES.length));
}

// ── G — IT IS A STARTING CHART, AND SAYS SO ───────────────────────────────
// Her real QuickBooks chart has 377 accounts and is not in this repo.
// Pretending this matches it would produce statements whose line names look
// familiar to her CPA and mean something else.
{
    section('G — honest about not being her QuickBooks chart');

    // Comment markers and line breaks flattened first — the sentence wraps
    // across two lines, and a source check that cannot read wrapped prose
    // fails on perfectly good documentation.
    const src = fs.readFileSync(path.join(ROOT, 'helpers/chartOfAccounts.js'), 'utf8')
        .replace(/^\s*\/\/ ?/gm, '').replace(/\s+/g, ' ');
    ck('the file says it is a starting chart, not a copy',
       /NOT a copy of her QuickBooks chart/.test(src),
       'a chart that claims to match hers, and does not, is worse than one that admits it');
    ck('  and names the script that will check',
       /coa-reconcile/.test(src), 'the claim has to be testable against her real books');

    // ── AND THAT SCRIPT HAS TO EXIST AND BE HONEST ───────────────────────
    // helpers/reconcile.js went dead without anyone noticing and
    // scripts/check-dead-helpers.js exists because of it. A script named in
    // a comment and never written is the same failure with extra confidence.
    const sp = path.join(ROOT, 'scripts/coa-reconcile.js');
    ck('the reconcile script exists', fs.existsSync(sp));
    const ssrc = fs.readFileSync(sp, 'utf8');
    ck('  and uses this chart rather than its own copy',
       /helpers\/chartOfAccounts/.test(ssrc), 'two charts would drift');
    ck('  reads her real QuickBooks chart',
       /quickbooks\/books/.test(ssrc) && /accounts\(\)/.test(ssrc));
    ck('  and writes nothing on either side',
       !/mutateJson|writeFile|appendFile|\.create\(|\.update\(/.test(ssrc),
       'a reconciliation that can change her books is not a reconciliation');

    // The list that matters is QuickBooks accounts holding money that Jarvis
    // has no line for — those are the ones that would silently go missing
    // from a statement.
    ck('  it surfaces QuickBooks accounts WITH A BALANCE that Jarvis lacks',
       /THIS IS THE LIST THAT MATTERS/.test(ssrc),
       'an empty account missing is noise; a funded one missing is a wrong statement');
    ck('  and it refuses to guess an unknown QuickBooks account type',
       /does not recognise/.test(ssrc),
       'a misfiled type puts an account on the wrong statement, and that error balances');
    ck('  exiting non-zero while the two disagree about money',
       /process\.exit\(bad \? 1 : 0\)/.test(ssrc));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
