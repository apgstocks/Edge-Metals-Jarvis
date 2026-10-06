// ── tests/postings.js ─────────────────────────────────────────────────────
// Apsara, 2026-10-06: the year-end pack for her CPA. Trial balance, general
// ledger, P&L and balance sheet are four views over ONE list of journal
// lines, and helpers/postings.js is the thing that produces it.
//
// Bookkeeping fails in a particular way: the statement prints, the columns
// line up, the trial balance is zero, and the figures are wrong. Debit an
// income account instead of crediting it and everything still balances.
// Post one side of an inter-company transfer and TWO companies are wrong at
// once. Treat an unapplied advance as an expense and $1.18M comes off
// profit for money she has not consumed.
//
// So most of these checks are about errors that balance.

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-post-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated — refusing to run against real data');
    process.exit(1);
}

const P = require(path.join(ROOT, 'helpers/postings'));
const C = require(path.join(ROOT, 'helpers/chartOfAccounts'));

const sum = (lines, side) => Math.round(lines.reduce((s, l) => s + l[side], 0) * 100) / 100;
const on = (lines, account) => lines.filter((l) => l.account === account);
const dr = (lines, account) => sum(on(lines, account), 'debit');
const cr = (lines, account) => sum(on(lines, account), 'credit');

// ── A — NOTHING IS WRITTEN, EVER ──────────────────────────────────────────
// The whole design. A posting layer that stored its own copy would be a
// second place her money lives, and the two would disagree the first time a
// bill was edited.
{
    section('A — derived, never stored');

    const src = fs.readFileSync(path.join(ROOT, 'helpers/postings.js'), 'utf8');
    ck('it writes to no store', !/mutateJson|writeFile|appendFile|saveJson/.test(src),
       'a stored journal is a second place her money lives');
    ck('  and it reads no store either',
       !/loadJson|require\('\.\/bills'\)|require\('\.\/sales'\)/.test(src),
       'rows are passed in, already carrying their own arithmetic');
    ck('  which is why sales.js computing its own amount cannot bite again',
       /sales\.json has NO amount field/.test(src),
       'reading a raw row and calling the result money printed $0.00 for seven real invoices');
}

// ── B — EVERY TRANSACTION BALANCES, OR IT IS NOT POSTED ───────────────────
{
    section('B — half a transaction is worse than none');

    const r = P.post('metals-purchase', { entity: 'edge-metals', amount: 10000, trucking: 800 });
    ck('a bill posts', r.lines.length === 3 && r.problems.length === 0, JSON.stringify(r));
    ck('  debits equal credits', sum(r.lines, 'debit') === sum(r.lines, 'credit'), JSON.stringify(r.lines));
    // ── THE COST IS GROSS; THE DEBT IS SPLIT ─────────────────────────────
    // bills.js:402-408 names the chain: `amount` is what the metal came to,
    // `net_payable` is what the SUPPLIER is owed after the haulage she pays
    // on their behalf. So the metal cost 10,000 — the haulage is not an
    // extra cost, it is part of that figure, recovered by paying the
    // supplier 800 less.
    //
    // This is a PRESENTATION CHOICE and it is hers to overturn: freight no
    // longer appears as its own cost-of-sales line on a purchase. Recording
    // it as one would either double-count the 10,000 or contradict her own
    // naming of `amount`.
    ck('  the metal is costed at the gross invoice figure',
       dr(r.lines, '5000') === 10000, 'amount is "what the metal came to"');
    ck('  the supplier is owed the NET', cr(r.lines, '2010') === 9200,
       'net_payable is "what the supplier is owed"');
    ck('  and the haulage she covers is owed to the hauler',
       cr(r.lines, '2050') === 800,
       'a liability, not a second cost — the cost was recognised once, at gross');

    // ── THE BALANCE GUARD, TESTED DIRECTLY ───────────────────────────────
    // Every rule in the file balances by construction, so deleting the
    // guard entirely left all 78 checks green — it was never exercised. A
    // mutation that turns nothing red means the check is not testing what
    // its name says (CLAUDE.md). So a deliberately broken rule is installed
    // here: 100 in, 90 out, which is what a real rule looks like the day
    // someone forgets a line.
    P.RULES['__unbalanced-on-purpose'] = (tx) => ({
        debits: [['5000', 100]], credits: [['2010', 90]],
    });
    const unbal = P.post('__unbalanced-on-purpose', { entity: 'edge-metals', amount: 100 });
    ck('a rule whose debits and credits differ is REFUSED',
       unbal.lines.length === 0 && unbal.problems.length === 1, JSON.stringify(unbal));
    ck('  and the problem names both sides',
       /debits 100 vs credits 90/.test(unbal.problems[0]), unbal.problems[0]);
    ck('  and says why half a transaction is worse than none',
       /trial balance/.test(unbal.problems[0]), unbal.problems[0]);
    // It must not leak into the whole-journal view either.
    const jBad = P.journal([{ kind: '__unbalanced-on-purpose', entity: 'edge-metals', amount: 100 }]);
    ck('  an unbalanced rule puts no lines in the journal at all',
       jBad.lines.length === 0 && jBad.complete === false, JSON.stringify(jBad.problems));
    delete P.RULES['__unbalanced-on-purpose'];
    ck('  and the test cleans up after itself',
       P.post('__unbalanced-on-purpose', { entity: 'edge-metals', amount: 100 }).problems[0]
         .includes('no posting rule'),
       'a rule left behind would be a posting kind nobody declared');

    // A rule that cannot balance must emit NOTHING.
    const bad = P.post('customer-receipt', { entity: 'edge-metals', amount: 100, bank: 'nowhere' });
    ck('an unpostable transaction contributes no lines at all',
       bad.lines.length === 0 && bad.problems.length === 1, JSON.stringify(bad));
    ck('  because half of one breaks the whole year\'s trial balance',
       /nowhere to land|cannot tell which bank/.test(bad.problems[0]), bad.problems[0]);
}

// ── C — THE ERRORS THAT STILL BALANCE ─────────────────────────────────────
{
    section('C — the mistakes a balanced trial balance cannot show you');

    // ── AN UNAPPLIED ADVANCE IS AN ASSET ─────────────────────────────────
    // Her Payments tab: $1,184,471.93 sent, the SAME figure unapplied. As an
    // expense that is the entire sum off profit for money not yet consumed.
    const p = P.post('supplier-payment', { entity: 'edge-metals', amount: 5000, applied: 2000, bank: 'BofA' });
    ck('an applied payment settles what she owes', dr(p.lines, '2010') === 2000, JSON.stringify(p.lines));
    ck('  the unapplied part is an ASSET, not a cost',
       dr(p.lines, '1350') === 3000, 'as an expense, $1.18M would come off profit');
    ck('  and nothing lands on a cost account at all',
       on(p.lines, '5000').length === 0 && dr(p.lines, '6900') === 0, JSON.stringify(p.lines));
    ck('  while the bank goes down by the full amount', cr(p.lines, '1010') === 5000);

    // Applying it later must NOT touch the bank again.
    const ap = P.post('advance-applied', { entity: 'edge-metals', amount: 3000 });
    ck('applying an advance moves asset to payable', dr(ap.lines, '2010') === 3000 && cr(ap.lines, '1350') === 3000);
    ck('  and touches no bank — the money already left',
       !ap.lines.some((l) => ['1010', '1020', '1050'].includes(l.account)),
       'a second bank line would double-count the payment');

    // ── A SHORT PAYMENT IS NOT A SMALLER INVOICE ─────────────────────────
    const s = P.post('customer-receipt', { entity: 'edge-metals', amount: 9800, shortfall: 200, bank: 'BofA' });
    ck('a short payment clears the WHOLE receivable', cr(s.lines, '1200') === 10000, JSON.stringify(s.lines));
    ck('  with the difference booked as a deduction', dr(s.lines, '5400') === 200);
    ck('  and only the cash actually received hitting the bank', dr(s.lines, '1010') === 9800,
       'burying the shortfall leaves the invoice looking unpaid for ever');

    // ── COMMISSION IS A COST OF THE SALE, NOT A SMALLER SALE ─────────────
    const sale = P.post('metals-sale', { entity: 'edge-metals', amount: 50000, commission: 1200 });
    ck('the customer owes the full invoice', dr(sale.lines, '1200') === 50000, JSON.stringify(sale.lines));
    ck('  income is the full invoice too', cr(sale.lines, '4000') === 50000,
       'netting commission off income understates turnover');
    ck('  commission is a cost', dr(sale.lines, '5300') === 1200);
    ck('  and becomes owed to the agent', cr(sale.lines, '2100') === 1200);
}

// ── D — INTER-COMPANY, BOTH SIDES OR NEITHER ──────────────────────────────
// She confirmed AAA Investment is a third company with its own return. A
// one-sided entry unbalances two companies at once and is close to
// impossible to find later.
{
    section('D — one company paying another\'s bill');

    const r = P.post('supplier-payment', {
        entity: 'edge-trading', amount: 3000, applied: 3000, bank: 'BofA', paidBy: 'edge-metals' });
    ck('it is flagged inter-company', r.interCompany === true, JSON.stringify(r));
    ck('  the yard\'s payable is settled', dr(r.lines, '2010') === 3000, JSON.stringify(r.lines));
    ck('  but the yard did NOT pay from a bank it does not own',
       !r.lines.some((l) => l.entity === 'edge-trading' && ['1010', '1020'].includes(l.account)),
       'crediting Edge Metals\' bank on the yard\'s books is money appearing from nowhere');
    ck('  the yard now owes Edge Metals', cr(r.lines, '2400') === 3000);
    ck('  Edge Metals is owed by the yard', dr(r.lines, '1400') === 3000);
    ck('  and Edge Metals\' bank went down', cr(r.lines, '1010') === 3000);

    // The property that makes three returns possible.
    const j = P.journal([{ kind: 'supplier-payment', entity: 'edge-trading', amount: 3000,
        applied: 3000, bank: 'BofA', paidBy: 'edge-metals' }]);
    ck('each company balances on its own, not merely in total',
       j.everyEntityBalanced === true && j.entities.length === 2, JSON.stringify(j.entities));
    ck('  and 1400 and 2400 are equal and opposite',
       dr(j.lines, '1400') === cr(j.lines, '2400'),
       'if these ever differ, an inter-company item was recorded once instead of twice');

    // ── THE SILENT DROP ──────────────────────────────────────────────────
    // If the rule moves no bank money there is nothing to redirect. The
    // first version posted it as though funded in-house, losing the
    // inter-company fact on BOTH sets of books with everything balancing.
    const noBank = P.post('yard-purchase', { entity: 'edge-trading', amount: 3000, paidBy: 'edge-metals' });
    ck('a rule with no bank line REFUSES rather than dropping the fact',
       noBank.lines.length === 0 && noBank.problems.length === 1, JSON.stringify(noBank));
    ck('  and says where the paidBy probably belongs',
       /belongs on the PAYMENT/.test(noBank.problems[0]), noBank.problems[0]);
}

// ── E — IT NEVER GUESSES ──────────────────────────────────────────────────
{
    section('E — a guess here lands on a tax return');

    const unknownCat = P.post('expense', { entity: 'edge-trading', amount: 100, category: 'Diesel', bank: 'Chase' });
    ck('an unknown category is refused, not swept into Other',
       unknownCat.lines.length === 0, JSON.stringify(unknownCat));
    ck('  and says to add an account instead',
       /add one to the chart/.test(unknownCat.problems[0]), unknownCat.problems[0]);

    const known = P.post('expense', { entity: 'edge-trading', amount: 100, category: 'Fuel', bank: 'Chase' });
    ck('a known category posts to its own account', dr(known.lines, '6100') === 100, JSON.stringify(known.lines));

    const unknownBank = P.post('expense', { entity: 'edge-trading', amount: 100, category: 'Fuel', bank: 'Wells Fargo' });
    ck('an unrecognised bank is refused', unknownBank.lines.length === 0, JSON.stringify(unknownBank));

    ck('cash goes to petty cash, not a bank',
       P.bankAccount({ mode: 'Cash' }) === '1050', String(P.bankAccount({ mode: 'Cash' })));
    ck('  Chase and BofA are told apart',
       P.bankAccount({ bank: 'Chase Bank' }) === '1020' && P.bankAccount({ bank: 'BofA' }) === '1010');
    ck('  and an unknown bank is null rather than a default',
       P.bankAccount({ bank: 'Santander' }) === null,
       'crediting the wrong bank makes two balances wrong, and it balances');

    const noEntity = P.post('metals-sale', { amount: 100 });
    ck('a transaction with no company is refused',
       noEntity.lines.length === 0 && /no company against it/.test(noEntity.problems[0]),
       JSON.stringify(noEntity));
    const noRule = P.post('something-else', { entity: 'edge-metals', amount: 100 });
    ck('  and so is a kind with no rule', noRule.lines.length === 0, JSON.stringify(noRule));
}

// ── F — EVERY ACCOUNT USED REALLY EXISTS ──────────────────────────────────
// A line against a code not in the chart lands nowhere on a statement and
// silently shrinks a total.
{
    section('F — no line against an account that is not in the chart');

    const kinds = [
        ['metals-purchase', { entity: 'edge-metals', amount: 1000, trucking: 100 }],
        ['metals-sale', { entity: 'edge-metals', amount: 1000, commission: 50 }],
        ['supplier-payment', { entity: 'edge-metals', amount: 1000, applied: 400, bank: 'BofA' }],
        ['advance-applied', { entity: 'edge-metals', amount: 400 }],
        ['customer-receipt', { entity: 'edge-metals', amount: 900, shortfall: 100, bank: 'BofA' }],
        ['yard-purchase', { entity: 'edge-trading', amount: 500 }],
        ['yard-sale', { entity: 'edge-trading', amount: 700 }],
        ['trucker-bill', { entity: 'edge-trading', amount: 200 }],
        ['expense', { entity: 'edge-trading', amount: 60, category: 'Rent', bank: 'Chase' }],
        ['bank-charge', { entity: 'edge-metals', amount: 15, bank: 'BofA' }],
    ];
    for (const [kind, tx] of kinds) {
        const r = P.post(kind, tx);
        ck(`${kind} posts cleanly`, r.problems.length === 0 && r.lines.length >= 2, JSON.stringify(r.problems));
        ck(`  ${kind}: every account is in the chart`,
           r.lines.every((l) => !!C.get(l.account)),
           JSON.stringify(r.lines.filter((l) => !C.get(l.account)).map((l) => l.account)));
        ck(`  ${kind}: it balances`,
           sum(r.lines, 'debit') === sum(r.lines, 'credit'),
           `${sum(r.lines, 'debit')} vs ${sum(r.lines, 'credit')}`);
    }
}

// ── G — THE WHOLE JOURNAL ─────────────────────────────────────────────────
{
    section('G — a journal you can build a trial balance on');

    const j = P.journal([
        { kind: 'metals-purchase', entity: 'edge-metals', amount: 10000, trucking: 800 },
        { kind: 'metals-sale', entity: 'edge-metals', amount: 50000, commission: 1200 },
        { kind: 'supplier-payment', entity: 'edge-metals', amount: 5000, applied: 2000, bank: 'BofA' },
        { kind: 'expense', entity: 'edge-trading', amount: 250, category: 'Fuel', bank: 'Chase' },
        { kind: 'yard-sale', entity: 'edge-trading', amount: 4000 },
    ]);
    ck('the journal balances', j.balanced === true, `${j.debit} vs ${j.credit}`);
    ck('  and every company balances on its own',
       j.everyEntityBalanced === true, JSON.stringify(j.entities));
    ck('  with nothing unposted', j.complete === true, JSON.stringify(j.problems));

    // complete must mean something.
    const withBad = P.journal([
        { kind: 'metals-sale', entity: 'edge-metals', amount: 100 },
        { kind: 'expense', entity: 'edge-trading', amount: 50, category: 'Diesel', bank: 'Chase' },
    ]);
    ck('one unpostable row makes the journal incomplete',
       withBad.complete === false && withBad.problems.length === 1, JSON.stringify(withBad.problems));
    ck('  but the rows that DID post are still there and still balance',
       withBad.lines.length === 2 && withBad.balanced === true, JSON.stringify(withBad.lines));

    // Empty and rubbish must not throw — this runs over a year of rows.
    let threw = null;
    try {
        P.journal(); P.journal(null); P.journal([null, undefined, 0, 'x', []]);
        P.post(null, null); P.post('metals-sale', null);
    } catch (e) { threw = e.message; }
    ck('nothing throws on rubbish', threw === null, String(threw));
    ck('  an empty journal balances trivially',
       P.journal([]).balanced === true && P.journal([]).lines.length === 0);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
