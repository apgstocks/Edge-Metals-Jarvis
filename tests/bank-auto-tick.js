// ── tests/bank-auto-tick.js ───────────────────────────────────────────────
// Apsara, 2026-10-08: "when Jarvis is certain a bank row matches a payment
// already recorded, it should tick it off by itself (exact single matches
// only) rather than wait for her." Task #187.
//
// ── THE ONLY REASON THIS IS SAFE TO AUTOMATE ─────────────────────────────
// helpers/bankLedger.js says it and this file holds it to it: "A MATCH
// CREATES NOTHING. It ties a bank row to a record that already exists, so no
// money moves and no figure changes." Section C is the one that matters —
// the books must be byte-identical before and after a run. The moment an
// auto-tick can change a figure, it stops being safe to do overnight.

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-at-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated — refusing to run against her bank data');
    process.exit(1);
}

const W = (f, v) => fs.writeFileSync(path.join(TMP, f), JSON.stringify(v, null, 2));
const AT = require(path.join(ROOT, 'helpers/bankAutoTick'));
const ledger = require(path.join(ROOT, 'helpers/bankLedger'));
const BB = require(path.join(ROOT, 'helpers/booksBuild'));

// A supplier payment she HAS recorded, and the bank row for the same money.
// The amounts must agree to the cent or autoTickable refuses, which is the
// point of it.
const PAID = 12000;
const bankRow = (over = {}) => ({
    id: 'B1', date: '2026-09-20', desc: 'WIRE OUT MAZAREIGOS', party: 'MAZAREIGOS',
    spent: PAID, received: 0, amount: PAID, direction: 'out', pending: false,
    // `bank` is what bankOut.sweep filters on — it compares r.bank to the
    // chart's name for the account code. Without it the row is in no
    // bank's sweep at all and is never even considered, which is how the
    // first version of this fixture produced zero candidates while
    // looking complete.
    bank: 'BofA', account_id: 'acct-1', ...over,
});

// ── WRITE TO THE FILES THE CODE ACTUALLY READS ──────────────────────────
// The first version of this wrote 'bank_ledger.json'. The real store is
// cfg.BANK_TX_FILE — 'bank-transactions.json'. So the ledger was EMPTY for
// every assertion below, and all of them passed: the refusals refused an
// empty list, and "the journal is unchanged" compared nothing to nothing.
// Sixteen green checks proving nothing.
//
// Named from cfg rather than typed again, and seed() now REFUSES to return
// until the rows it wrote are readable through the real loader. A fixture
// that silently fails to load is the most expensive kind of green there is.
const seed = (rows, payments) => {
    fs.writeFileSync(cfg.BANK_TX_FILE, JSON.stringify(rows, null, 2));
    fs.writeFileSync(cfg.BILL_PAYMENTS_FILE, JSON.stringify(payments, null, 2));
    const back = ledger.list();
    const wanted = (rows || []).filter((r) => r && typeof r === 'object').length;
    if (back.length !== wanted) {
        throw new Error(`fixture did not load: wrote ${wanted} bank row(s), read back ${back.length}`);
    }
};

const RECORDED = [{ id: 'BP1', supplier: 'Mazareigos', date: '2026-09-20',
    amount: PAID, mode: 'Wire', bank: 'BofA', allocations: [] }];

(async () => {

// ─────────────────────────────────────────────────────────────────────────
section('A. it ticks the certain one');
{
    seed([bankRow()], RECORDED);
    // THE GUARD THAT STOPS AN EMPTY STORE FAKING A PASS. Everything below
    // asserts what the job does NOT do; with no rows loaded, all of it is
    // vacuous. This is the only assertion here that proves the others mean
    // something.
    ck('the fixture is actually loaded — one bank row, one recorded payment',
       ledger.list().length === 1
       && require(path.join(ROOT, 'helpers/billPayments')).list().length === 1,
       `${ledger.list().length} bank row(s)`);

    const dry = await AT.run({ dryRun: true });
    ck('the dry run says what it would do', dry.ok === true, JSON.stringify(dry.error || ''));
    ck('  and changes nothing', (ledger.list()[0] || {}).matched == null,
       JSON.stringify((ledger.list()[0] || {}).matched));

    const res = await AT.run({});
    ck('a run completes', res.ok === true, JSON.stringify(res.error || ''));
    // NOTE: whether this fixture produces a tickable row depends on bankOut's
    // own matching, which is not this module's to assert. What IS asserted
    // everywhere below is that the GUARDS hold — and those are what make an
    // overnight job safe. A fixture that happens not to match still proves
    // the refusals.
    const dryCount = dry.ticked.length;
    ck('  and the dry run and the real run agree on the count',
       res.ticked.length === dryCount, `${dryCount} vs ${res.ticked.length}`);
    if (res.ticked.length) {
        const r = ledger.list().find((x) => x.id === 'B1');
        ck('  the row is ticked and says Jarvis did it',
           r.matched && r.matched.how === 'auto', JSON.stringify(r.matched));
        ck('  with a history line, so it can be found again',
           (r.history || []).some((h) => /matched to a recorded payment \(auto\)/.test(h.what)),
           JSON.stringify(r.history));
        ck('  and it carries the key of the record it was tied to',
           ((r.matched || {}).keys || []).length === 1, JSON.stringify(r.matched));
    } else {
        console.log('  NOTE  this fixture produced no tickable row; the guards below still apply');
    }
}

// ─────────────────────────────────────────────────────────────────────────
section('B. everything it must refuse');
{
    // ── ISOLATED, which the first version was not ───────────────────────
    // This fixture is the EXACT one that ticks in section A, changed in one
    // way only: already matched. If the `live.matched` guard is removed, this
    // row ticks again — so the check now proves the guard rather than the
    // fixture failing for some other reason. A mutation deleting that guard
    // survived until this was isolated.
    seed([bankRow()], RECORDED);
    const wouldTick = (await AT.run({ dryRun: true })).ticked.length;
    ck('the control: this exact fixture IS tickable', wouldTick === 1, String(wouldTick));

    seed([{ ...bankRow(), matched: { at: '2026-09-21T00:00:00Z', by: null, how: 'her', keys: ['k'] } }], RECORDED);
    const again = await AT.run({});
    ck('  but once ticked, a second pass leaves it alone',
       again.ticked.length === 0, JSON.stringify(again.ticked));

    // A DEPOSIT. bankReview.fromDeposit sets no `auto` at all, deliberately:
    // matching a deposit applies money to an invoice.
    seed([{ ...bankRow({ id: 'B2', direction: 'in', spent: 0, received: PAID }) }], RECORDED);
    const dep = await AT.run({});
    ck('a deposit is never auto-ticked, whatever it looks like',
       dep.ticked.every((t) => t.id !== 'B2'), JSON.stringify(dep.ticked));

    // Nothing recorded at all — there is nothing to tie it to.
    seed([bankRow()], []);
    const none = await AT.run({});
    ck('with no recorded payment, nothing is ticked',
       none.ticked.length === 0, JSON.stringify(none.ticked));

    // TWO identical recorded payments: indistinguishable, so a tick would
    // land on an arbitrary one. bankOut.autoTickable refuses; so must this.
    seed([bankRow()], [
        { id: 'BP1', supplier: 'Mazareigos', date: '2026-09-20', amount: PAID, mode: 'Wire', bank: 'BofA', allocations: [] },
        { id: 'BP2', supplier: 'Mazareigos', date: '2026-09-20', amount: PAID, mode: 'Wire', bank: 'BofA', allocations: [] },
    ]);
    const twins = await AT.run({});
    ck('two identical recorded payments are ambiguous, so neither is picked',
       twins.ticked.length === 0, JSON.stringify(twins.ticked));
}

// ─────────────────────────────────────────────────────────────────────────
section('C. A MATCH CREATES NOTHING — the licence for doing this overnight');
{
    seed([bankRow()], RECORDED);
    const before = BB.build({});
    const beforeJson = JSON.stringify(before.lines);
    await AT.run({});
    const after = BB.build({});

    ck('the journal is byte-identical after a run',
       JSON.stringify(after.lines) === beforeJson,
       `${before.lines.length} lines before, ${after.lines.length} after`);
    ck('  not one line was added or removed',
       after.lines.length === before.lines.length, `${before.lines.length} -> ${after.lines.length}`);
    ck('  and it still balances',
       after.journal.balanced === true && after.journal.everyEntityBalanced === true,
       JSON.stringify(after.journal.entities));

    // ── AND NOT ONE BANK ENTRY, 2026-10-28 ──────────────────────────────
    // This section's claim used to be safe for free, because nothing on the
    // match path could create anything. That changed today: POST
    // /api/bank/review/match can now post a RESOLVING ENTRY for a difference
    // she has named an account for (QuickBooks' resolve difference, which she
    // asked for by name). So "a match creates nothing" is no longer a
    // property of the code's shape — it has to be asserted of THIS job.
    //
    // Two independent reasons it holds, and both are checked rather than
    // argued: the job never goes through that route at all (it calls
    // bankLedger.markMatched directly), and it only ever ticks rows the
    // engine made EXACT, which have no difference to resolve.
    const BEaudit = require(path.join(ROOT, 'helpers/bankEntries'));
    ck('the overnight job creates no bank entry — a match still creates NOTHING',
       BEaudit.list().length === 0, JSON.stringify(BEaudit.list()));

    // What matters is what it CALLS, not what it mentions. My first version
    // looked for the words 'bankEntries' and 'review/match' anywhere in the
    // file, and went red on a COMMENT that says the job rebuilds its queue
    // "exactly as POST /api/bank/review/match does" — a comment that is both
    // true and useful. Twice today I have written a check that forbids
    // writing about a thing instead of testing the thing.
    const src = fs.readFileSync(path.join(ROOT, 'helpers/bankAutoTick.js'), 'utf8');
    ck('  and it cannot: the job never requires the module that posts',
       !/require\(['"]\.\/bankEntries['"]\)/.test(src),
       'bankAutoTick must not be able to write a bank entry');
    ck('  nor name an account for a difference',
       !/resolve\s*:/.test(src) && !/account\s*:/.test(src),
       'nothing in the overnight job may name an account');
    // The real guarantee, stated as behaviour rather than as source: it goes
    // through markMatched and nothing else, so there is no code path from the
    // 06:50 run to a journal entry.
    ck('  the only write it makes is the tick itself',
       (src.match(/await\s+bankLedger\.(\w+)/g) || []).every((c) => /markMatched/.test(c)),
       JSON.stringify(src.match(/await\s+bankLedger\.(\w+)/g)));
}

// ─────────────────────────────────────────────────────────────────────────
section('D. it survives a bad day without taking the night with it');
{
    // A store that is not a list, and a row that is not a row. The job runs
    // nightly with nobody watching; throwing is the one thing it must not do.
    fs.writeFileSync(cfg.BANK_TX_FILE, JSON.stringify([null, bankRow()], null, 2));
    fs.writeFileSync(cfg.BILL_PAYMENTS_FILE, JSON.stringify(RECORDED, null, 2));
    let threw = null;
    let res = null;
    try { res = await AT.run({}); } catch (e) { threw = e; }
    ck('junk in the bank ledger does not throw', threw === null, threw && threw.message);
    ck('  and it still reports a result', !!res && typeof res.ok === 'boolean', JSON.stringify(res));

    fs.writeFileSync(cfg.BANK_TX_FILE, JSON.stringify({ not: 'a list' }, null, 2));
    threw = null;
    try { res = await AT.run({}); } catch (e) { threw = e; }
    ck('a store that is not a list does not throw either', threw === null, threw && threw.message);

    // The sentence is for a log line nobody reads until something is wrong.
    ck('summary() never returns empty', typeof AT.summary(res) === 'string' && AT.summary(res).length > 10,
       AT.summary(res));
    ck('  and it names a failure rather than claiming success',
       /could not run|nothing was certain|auto-tick:/.test(AT.summary({ ok: false, error: 'boom' })),
       AT.summary({ ok: false, error: 'boom' }));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:\n  ' + failures.join('\n  ')); process.exit(1); }

})().catch((e) => { console.error('\nCRASHED: ' + (e && e.stack || e)); process.exit(1); });
