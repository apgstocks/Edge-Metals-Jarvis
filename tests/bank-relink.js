// ── tests/bank-relink.js ─────────────────────────────────────────────────
// Apsara, 2026-10-12: "i need 2026 transactions from 01-01-2026", after
// "all the transactions from plaid is from 2026-07-14 to 2026-10-09" and
// "I have already pulled the transaction but".
//
// Plaid granted 90 days because days_requested was never sent, and it cannot
// be changed on an existing Item — so reaching 1 January means unlinking and
// linking again. A re-link reissues every transaction_id AND every
// account_id, and helpers/bankLedger.js keys on transaction_id, so the naive
// version of this duplicates her whole ledger.
//
//   A  the key survives a re-link — and what it deliberately ignores
//   B  pairing is ONE-TO-ONE: two identical rows stay two
//   C  her own work survives the re-key; the bank's fields refresh
//   D  a stale plan is REFUSED rather than half-applied
//   E  the routine sync path is UNCHANGED — this is the whole safety case
//   F  END TO END: 90-day store, re-link, wider feed, one clean ledger

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-relink-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.BANK_TX_FILE = path.join(TMP, 'bank-transactions.json');
process.env.BANK_ACCOUNTS_FILE = path.join(TMP, 'bank-accounts.json');

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('  ABORT  config not isolated'); process.exit(1); }

const relink = require(path.join(ROOT, 'helpers/bankRelink'));
const ledger = require(path.join(ROOT, 'helpers/bankLedger'));

const FILE = process.env.BANK_TX_FILE;
fs.writeFileSync(process.env.BANK_ACCOUNTS_FILE, JSON.stringify({ accounts: [
    { id: 'edge-metals-bofa', company: 'Edge Metals INC', bank: 'Bank of America',
      accountNumber: '0000 3301', plaid_account_id: 'OLD-acc-1' },
] }, null, 2));

// A Plaid transaction as the OLD item saw it, and the SAME transaction as a
// re-linked item sees it: new transaction_id, new account_id, and Plaid's
// merchant enrichment recomputed — which is why `party` is not in the key.
const asPlaid = (id, acc, date, amount, name, extra = {}) =>
    ({ transaction_id: id, account_id: acc, date, amount, name, pending: false, ...extra });

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — the key that survives a re-link');

{
    const old = ledger.fromPlaid(asPlaid('OLD-1', 'OLD-acc-1', '2026-08-03', -4200, 'ACME METALS WIRE IN',
        { merchant_name: 'Acme Metals' }), null);
    // Same real transaction, after a re-link: both ids reissued, and Plaid's
    // enrichment came back different.
    const nu = ledger.fromPlaid(asPlaid('NEW-1', 'NEW-acc-9', '2026-08-03', -4200, 'ACME  METALS, WIRE IN',
        { merchant_name: 'ACME Metals Inc' }), null);

    ck('the same transaction keys the same under a new item',
       relink.keyOf(old) === relink.keyOf(nu), `${relink.keyOf(old)}\n        ${relink.keyOf(nu)}`);
    // Each of these is a field that CHANGES on re-link, so including it in
    // the key would have meant nothing ever paired.
    ck('  despite a new account_id', old.account_id !== nu.account_id);
    ck('  and despite re-run merchant enrichment', old.party !== nu.party, `${old.party} vs ${nu.party}`);
    ck('  punctuation and double spaces are not significant',
       relink.normDesc('ACME  METALS, WIRE IN') === relink.normDesc('ACME METALS WIRE-IN'));

    // And the things that MUST keep rows apart.
    const other = ledger.fromPlaid(asPlaid('NEW-2', 'NEW-acc-9', '2026-08-04', -4200, 'ACME METALS WIRE IN'), null);
    ck('a different DATE is a different transaction', relink.keyOf(old) !== relink.keyOf(other));
    const amt = ledger.fromPlaid(asPlaid('NEW-3', 'NEW-acc-9', '2026-08-03', -4201, 'ACME METALS WIRE IN'), null);
    ck('  a different AMOUNT is too', relink.keyOf(old) !== relink.keyOf(amt));
    const dir = ledger.fromPlaid(asPlaid('NEW-4', 'NEW-acc-9', '2026-08-03', 4200, 'ACME METALS WIRE IN'), null);
    ck('  and money OUT is never the same row as money IN',
       relink.keyOf(old) !== relink.keyOf(dir),
       'a $4,200 payment and a $4,200 receipt on one day must not pair');
}

// ══════════════════════════════════════════════════════════════════════════
section('B — two identical deposits stay two');
// THE expensive mistake. Two genuine $500 cash deposits on the same day are
// a real thing. A many-to-one merge folds them into one row and she is
// short $500 with nothing saying so.

{
    const old = [
        ledger.fromPlaid(asPlaid('OLD-a', 'OLD-acc-1', '2026-09-01', -500, 'CASH DEPOSIT'), null),
        ledger.fromPlaid(asPlaid('OLD-b', 'OLD-acc-1', '2026-09-01', -500, 'CASH DEPOSIT'), null),
    ];
    const fresh = [
        ledger.fromPlaid(asPlaid('NEW-a', 'NEW-acc-9', '2026-09-01', -500, 'CASH DEPOSIT'), null),
        ledger.fromPlaid(asPlaid('NEW-b', 'NEW-acc-9', '2026-09-01', -500, 'CASH DEPOSIT'), null),
    ];
    const p = relink.plan(old, fresh);
    ck('two identical rows pair with two, not one', p.counts.pairs === 2, String(p.counts.pairs));
    ck('  each old row is claimed exactly once',
       new Set(p.pairs.map((x) => x.old_id)).size === 2, JSON.stringify(p.pairs.map((x) => x.old_id)));
    ck('  and nothing is left stranded',
       p.counts.unmatched_existing === 0 && p.counts.unmatched_fresh === 0,
       JSON.stringify(p.counts));

    // THREE fresh against TWO existing: the third is genuinely new and must
    // be reported, not forced onto an already-claimed row.
    const p3 = relink.plan(old, fresh.concat([
        ledger.fromPlaid(asPlaid('NEW-c', 'NEW-acc-9', '2026-09-01', -500, 'CASH DEPOSIT'), null)]));
    ck('a third identical deposit is reported as new, not merged',
       p3.counts.pairs === 2 && p3.counts.unmatched_fresh === 1, JSON.stringify(p3.counts));
    // TWO fresh against THREE existing: the extra existing row keeps its
    // work and is reported as no longer refreshed.
    const p2 = relink.plan(old.concat([
        ledger.fromPlaid(asPlaid('OLD-c', 'OLD-acc-1', '2026-09-01', -500, 'CASH DEPOSIT'), null)]), fresh);
    ck('an extra old row is reported as unmatched, not dropped',
       p2.counts.pairs === 2 && p2.counts.unmatched_existing === 1, JSON.stringify(p2.counts));
}

// ══════════════════════════════════════════════════════════════════════════
section('C — her work survives, the bank\'s fields refresh');

{
    fs.writeFileSync(FILE, '[]');
    const old = ledger.fromPlaid(asPlaid('OLD-m', 'OLD-acc-1', '2026-08-15', -9000, 'ZIMEX WIRE'), null);
    // The state a row is in once she has worked it: matched, categorised,
    // with history. Exactly the thing a duplicate would strand.
    old.matched = { kind: 'invoice', ref: 'EM-2026-0188', at: '2026-08-16T10:00:00.000Z' };
    old.category = 'Customer receipt';
    old.excluded = false;
    old.history = [{ at: '2026-08-16T10:00:00.000Z', what: 'matched to invoice EM-2026-0188', by: 'apsara' }];
    fs.writeFileSync(FILE, JSON.stringify([old], null, 2));

    const fresh = ledger.fromPlaid(asPlaid('NEW-m', 'NEW-acc-9', '2026-08-15', -9000, 'ZIMEX  WIRE'), null);
    const p = relink.plan([old], [fresh]);
    ck('it pairs', p.counts.pairs === 1);
    ck('  and flags that she has acted on it', p.counts.pairs_acted_on === 1,
       'the review has to start with the rows that cost something');

    const out = await relink.apply(FILE, p);
    ck('applying re-keys one row', out.rekeyed === 1, JSON.stringify(out));

    const after = relink.read(FILE);
    ck('the store still holds ONE row, not two', after.length === 1, String(after.length));
    const r = after[0];
    ck('  under the new id', r.id === 'NEW-m', r.id);
    ck('  with the match intact', r.matched && r.matched.ref === 'EM-2026-0188', JSON.stringify(r.matched));
    ck('  and the category', r.category === 'Customer receipt', r.category);
    ck('  and the money unchanged', Number(r.amount) === 9000 && r.direction === 'in',
       `${r.amount} ${r.direction}`);
    // The stale join is the easy thing to forget: bank/company are derived
    // from account_id, so a re-key that left the old one would leave every
    // paired row attributed to an account that no longer exists.
    ck('  pointing at the NEW account', r.account_id === 'NEW-acc-9', r.account_id);
    // Provenance, because "why is this id different from my statement" gets
    // asked months later.
    ck('  and it records where the id came from',
       r.relinked && r.relinked.from === 'OLD-m' && r.relinked.to === 'NEW-m', JSON.stringify(r.relinked));
    ck('  saying so in the history she reads', (r.history || []).some((h) => /re-linked/.test(h.what)),
       JSON.stringify(r.history));
    ck('  without losing the history already there',
       (r.history || []).some((h) => /EM-2026-0188/.test(h.what)), JSON.stringify(r.history));

    // And a later ordinary sync must now land on it by the normal path.
    const report = await ledger.ingestPlaid([asPlaid('NEW-m', 'NEW-acc-9', '2026-08-15', -9000, 'ZIMEX WIRE')]);
    ck('a later sync refreshes it instead of adding a duplicate',
       report.added === 0, JSON.stringify(report));
    ck('  and the store is still one row', relink.read(FILE).length === 1);
    ck('  with her match still on it',
       (relink.read(FILE)[0].matched || {}).ref === 'EM-2026-0188');
}

// ══════════════════════════════════════════════════════════════════════════
section('D — a stale plan is refused, not half-applied');
// Between previewing and applying, the 05:45 job or a webhook may have run
// and inserted the new ids as fresh rows. Re-keying onto an id that now
// exists would put two rows under one id — the single thing this store's
// design rests on never happening.

{
    fs.writeFileSync(FILE, '[]');
    const a = ledger.fromPlaid(asPlaid('OLD-x', 'OLD-acc-1', '2026-07-20', -100, 'ROW A'), null);
    const b = ledger.fromPlaid(asPlaid('OLD-y', 'OLD-acc-1', '2026-07-21', -200, 'ROW B'), null);
    fs.writeFileSync(FILE, JSON.stringify([a, b], null, 2));

    const freshA = ledger.fromPlaid(asPlaid('NEW-x', 'NEW-acc-9', '2026-07-20', -100, 'ROW A'), null);
    const freshB = ledger.fromPlaid(asPlaid('NEW-y', 'NEW-acc-9', '2026-07-21', -200, 'ROW B'), null);
    const p = relink.plan([a, b], [freshA, freshB]);
    ck('the plan pairs both', p.counts.pairs === 2);

    // A sync lands in between, inserting ONE of the new ids.
    await ledger.ingestPlaid([asPlaid('NEW-y', 'NEW-acc-9', '2026-07-21', -200, 'ROW B')]);
    ck('a sync inserted one of them meanwhile', relink.read(FILE).length === 3);

    let threw = null;
    try { await relink.apply(FILE, p); } catch (e) { threw = e; }
    ck('applying the stale plan is REFUSED', !!threw, 'it would have created two rows with one id');
    ck('  naming the id that clashed', /NEW-y/.test((threw || {}).message || ''), (threw || {}).message);
    ck('  and telling her to make a fresh plan', /fresh plan/.test((threw || {}).message || ''));
    // Nothing half-written: the check runs over every pairing BEFORE the
    // first field is touched, inside one mutateJson.
    const after = relink.read(FILE);
    ck('  with NOTHING applied', after.some((r) => r.id === 'OLD-x') && after.some((r) => r.id === 'OLD-y'),
       JSON.stringify(after.map((r) => r.id)));
    ck('  and no row re-keyed', !after.some((r) => r.relinked));

    // A plan referring to a row that has since gone is refused the same way.
    fs.writeFileSync(FILE, JSON.stringify([b], null, 2));
    let threw2 = null;
    try { await relink.apply(FILE, relink.plan([a], [freshA])); } catch (e) { threw2 = e; }
    ck('a plan about a row no longer in the store is refused too', !!threw2, (threw2 || {}).message);
}

// ══════════════════════════════════════════════════════════════════════════
section('E — the ORDINARY sync path is unchanged');
// This is the safety case for the whole design. The tempting fix was to
// teach upsert() to match on date+amount+desc whenever an id is unknown.
// That silently swallows a real second transaction, so routine syncs must
// keep failing closed on the id.

{
    fs.writeFileSync(FILE, '[]');
    await ledger.ingestPlaid([asPlaid('T-1', 'acc-1', '2026-09-10', -500, 'CASH DEPOSIT')]);
    // The SAME day, the SAME amount, the SAME description — a second genuine
    // deposit, arriving in a later sync with its own id.
    const r2 = await ledger.ingestPlaid([asPlaid('T-2', 'acc-1', '2026-09-10', -500, 'CASH DEPOSIT')]);
    ck('a second identical deposit is ADDED, not merged away', r2.added === 1, JSON.stringify(r2));
    ck('  so the store holds both', relink.read(FILE).length === 2);
    const total = relink.read(FILE).reduce((n, r) => n + Number(r.amount || 0), 0);
    ck('  and the money adds up to $1,000', total === 1000, String(total));

    // Re-sending the same id still corrects rather than duplicates.
    const r3 = await ledger.ingestPlaid([asPlaid('T-1', 'acc-1', '2026-09-10', -500, 'CASH DEPOSIT')]);
    ck('re-sending one id refreshes it', r3.added === 0 && relink.read(FILE).length === 2,
       JSON.stringify(r3));

    // And the source says so: nothing in bankLedger consults the natural key.
    const src = fs.readFileSync(path.join(ROOT, 'helpers/bankLedger.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ck('bankLedger does not reach for bankRelink', !/bankRelink/.test(src),
       'the migration must not be wired into every sync');
}

// ══════════════════════════════════════════════════════════════════════════
section('F — END TO END: 90 days, re-link, back to January');
// Her actual situation: a store holding one 90-day window, then a re-link
// that returns 2026 from 1 January with every id reissued.

{
    fs.writeFileSync(FILE, '[]');

    // What she has: the 90-day window, three rows, two of them worked.
    const ninety = [
        asPlaid('OLD-1', 'OLD-acc-1', '2026-07-20', -12000, 'ZIMEX LOGISTICS'),
        asPlaid('OLD-2', 'OLD-acc-1', '2026-08-14', -4500, 'ACME METALS'),
        asPlaid('OLD-3', 'OLD-acc-1', '2026-09-30', 2300, 'TRUCKING LLC'),
    ];
    await ledger.ingestPlaid(ninety);
    await ledger.markMatched('OLD-2', { kind: 'invoice', ref: 'EM-0188' }, { by: 'apsara' });
    await ledger.exclude('OLD-3', 'personal', 'apsara');
    const before = relink.read(FILE);
    ck('she starts with the 90-day window', before.length === 3, String(before.length));
    ck('  one matched, one excluded',
       before.filter((r) => r.matched).length === 1 && before.filter((r) => r.excluded).length === 1);

    // The re-link: the same three transactions with new ids on a new
    // account, PLUS January to July, which is what she asked for.
    const wider = [
        asPlaid('NEW-1', 'NEW-acc-9', '2026-07-20', -12000, 'ZIMEX LOGISTICS'),
        asPlaid('NEW-2', 'NEW-acc-9', '2026-08-14', -4500, 'ACME METALS'),
        asPlaid('NEW-3', 'NEW-acc-9', '2026-09-30', 2300, 'TRUCKING LLC'),
        asPlaid('NEW-J1', 'NEW-acc-9', '2026-01-08', -8800, 'JANUARY WIRE'),
        asPlaid('NEW-J2', 'NEW-acc-9', '2026-03-22', -15500, 'MARCH WIRE'),
    ];
    // The sync runs before she gets to the script — which is the real order,
    // because the 05:45 job or the webhook will have fired.
    const dup = await ledger.ingestPlaid(wider);
    ck('WITHOUT the fix the sync duplicates everything', dup.added === 5, JSON.stringify(dup));
    ck('  leaving 8 rows for 5 transactions', relink.read(FILE).length === 8,
       String(relink.read(FILE).length));

    // Now the migration, over the real store, split the way the script does.
    const all = relink.read(FILE);
    const newIds = new Set(['NEW-acc-9']);
    const freshRows = all.filter((r) => newIds.has(r.account_id) && !r.relinked);
    const oldRows = all.filter((r) => !newIds.has(r.account_id) && !r.relinked);
    const p = relink.plan(oldRows, freshRows);
    ck('the plan pairs the three overlapping rows', p.counts.pairs === 3, JSON.stringify(p.counts));
    ck('  and sees January and March as genuinely new', p.counts.unmatched_fresh === 2);
    ck('  with two of the pairs carrying her work', p.counts.pairs_acted_on === 2);

    // The duplicates are the fresh rows; re-keying the old ones onto their
    // ids would clash, which is exactly what section D refuses. So the
    // script's real sequence is: drop the duplicate fresh rows, THEN re-key.
    // Proving that here is the point of an end-to-end section — the helper
    // being right is not the same as the procedure being right.
    const freshIds = new Set(p.pairs.map((x) => x.new_id));
    await require(path.join(ROOT, 'helpers/json')).mutateJson(FILE, [], (rows) =>
        (Array.isArray(rows) ? rows : []).filter((r) => !freshIds.has(r.id)));
    ck('the duplicate copies are removed first', relink.read(FILE).length === 5,
       String(relink.read(FILE).length));

    const out = await relink.apply(FILE, p);
    ck('then the old rows take the new ids', out.rekeyed === 3, JSON.stringify(out));

    const end = relink.read(FILE);
    ck('ONE row per transaction', end.length === 5, String(end.length));
    ck('  ids all from the new item', end.every((r) => /^NEW-/.test(r.id)),
       JSON.stringify(end.map((r) => r.id)));
    ck('  the match survived the re-link',
       (end.find((r) => r.id === 'NEW-2') || {}).matched !== undefined
       && !!(end.find((r) => r.id === 'NEW-2') || {}).matched);
    ck('  the exclusion survived too', (end.find((r) => r.id === 'NEW-3') || {}).excluded === true);
    ck('  and January is there, which is what she asked for',
       end.some((r) => r.date === '2026-01-08'), JSON.stringify(end.map((r) => r.date).sort()));
    // The figure that would have been wrong. 12000+4500+2300+8800+15500.
    const sum = end.reduce((n, r) => n + Number(r.amount || 0), 0);
    ck('  with the total counted ONCE', sum === 43100, `${sum} (doubling would read 56600+)`);

    // Idempotent: running it twice must not pair the already-relinked rows
    // back onto themselves.
    const again = relink.plan(relink.read(FILE).filter((r) => !r.relinked), []);
    ck('running it again finds nothing left to do', again.counts.pairs === 0, JSON.stringify(again.counts));
}

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log('  - ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('ABORT', e); process.exit(1); });
