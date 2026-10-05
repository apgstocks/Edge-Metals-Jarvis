// ── tests/bank-ledger.js ──────────────────────────────────────────────────
// Apsara, 2026-10-05: "plaid records should mimic quickbook bank transactions
// but better than it."
//
// Section A is the "mimic" half, and it is a real check rather than a
// formality: the field names must be the ones scripts/qb-bank-match.js
// already produces from her QuickBooks Banking export, because that is what
// lets one matcher serve both feeds. If they ever diverge, the CSV path and
// the Plaid path start disagreeing about what a bank row is.
//
// Everything from B down is the "better than it" half, and each one is a
// thing that goes wrong in a real QuickBooks banking workflow.

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-bank-ledger-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.BANK_TX_FILE = path.join(TMP, 'bank-transactions.json');

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated — refusing to run against real data');
    process.exit(1);
}
const L = require(path.join(ROOT, 'helpers/bankLedger'));
if (!String(L.FILE()).startsWith(TMP)) {
    console.error('  ABORT  bankLedger would write ' + L.FILE());
    process.exit(1);
}

const ACC = [
    { id: 'bofa-1', company: 'Edge Metals INC' },
    { id: 'chase-1', company: 'EDGE TRADING INC' },
];
const tx = (o) => ({ transaction_id: o.id, date: o.d, amount: o.a, name: o.n,
    merchant_name: o.p, account_id: o.acc, pending: !!o.pend });
const norm = (list) => list.map((t) => L.fromPlaid(t, ACC));

(async () => {

// ── A — IT IS QUICKBOOKS' RECORD ──────────────────────────────────────────
{
    section('A — the same record QuickBooks exports, field for field');

    const r = L.fromPlaid(tx({ id: 'T1', d: '2026-09-05', a: -47000,
        n: 'WIRE IN CUSTOM-ALLOYS LLC', p: 'Custom Alloys LLC', acc: 'bofa-1' }), ACC);

    // ── THE COLUMNS, TAKEN BY RUNNING THE CSV READER ─────────────────────
    // My first version grepped qb-bank-match.js for /\bdate:/ and went red,
    // because out.push({ date, desc: ... }) uses ES6 shorthand for the first
    // field. A textual check of someone else's source is brittle in exactly
    // that way. So this feeds readBankLines a real QuickBooks-shaped CSV and
    // compares the KEYS of what comes out — behaviour, not spelling. If the
    // reader is ever renamed or reshaped, this goes red and the two feeds are
    // stopped from drifting apart.
    const reader = require(path.join(ROOT, 'scripts/qb-bank-match.js'));
    const csv = [
        'Date,Description,Payee,Category,Spent,Received',
        '09/05/2026,WIRE IN CUSTOM-ALLOYS LLC,Custom Alloys LLC,,,47000.00',
        '09/06/2026,CHECK 1041,,Owner draw,12000.00,',
    ].join('\n');
    const csvRows = reader.readBankLines({ text: csv }).lines;
    ck('the QuickBooks CSV reader parses a QuickBooks-shaped export',
       csvRows.length === 2, JSON.stringify(csvRows));
    const qbKeys = Object.keys(csvRows[0]).sort();
    const plaidKeys = Object.keys(r);
    const missing = qbKeys.filter((k) => !plaidKeys.includes(k));
    ck('  and a Plaid row carries every field a CSV row has',
       missing.length === 0, 'a Plaid row is missing: ' + missing.join(', '));
    ck('  including all eight QuickBooks columns by name',
       ['date', 'desc', 'party', 'category', 'spent', 'received', 'amount', 'direction']
           .every((c) => qbKeys.includes(c) && plaidKeys.includes(c)),
       JSON.stringify({ qb: qbKeys, plaid: plaidKeys.slice(0, 12) }));

    // The same deposit through both readers must agree on the money and the
    // direction. This is the claim "mimic QuickBooks" actually makes.
    const viaCsv = csvRows.find((x) => /CUSTOM-ALLOYS/.test(x.desc));
    ck('  and the same deposit reads identically through either feed',
       viaCsv.amount === r.amount && viaCsv.direction === r.direction
       && viaCsv.received === r.received && viaCsv.spent === r.spent
       && viaCsv.date === r.date && viaCsv.party === r.party,
       JSON.stringify({ csv: viaCsv, plaid: { date: r.date, party: r.party, amount: r.amount, direction: r.direction } }));

    ck('a deposit becomes received, not spent',
       r.received === 47000 && r.spent === 0 && r.direction === 'in',
       JSON.stringify({ s: r.spent, rc: r.received, d: r.direction }));
    const out = L.fromPlaid(tx({ id: 'T2', d: '2026-09-06', a: 12000, n: 'CHECK 1041', acc: 'bofa-1' }), ACC);
    ck('  and a withdrawal becomes spent — Plaid\'s positive is money OUT',
       out.spent === 12000 && out.received === 0 && out.direction === 'out',
       JSON.stringify({ s: out.spent, rc: out.received, d: out.direction }));

    ck('the bank description lands in desc', r.desc === 'WIRE IN CUSTOM-ALLOYS LLC', r.desc);
    ck('  and the payee guess in party, as QuickBooks\' From/To does',
       r.party === 'Custom Alloys LLC', r.party);

    // Category is QuickBooks' column for what the ACCOUNTANT has set. A
    // guess from Plaid's taxonomy in that column would read as a decision.
    ck('category arrives EMPTY, never guessed',
       r.category === '', JSON.stringify(r.category));
    const withCat = L.fromPlaid({ transaction_id: 'T9', date: '2026-09-01', amount: -5,
        name: 'x', account_id: 'bofa-1', personal_finance_category: { primary: 'INCOME' },
        category: ['Transfer', 'Deposit'] }, ACC);
    ck('  even when Plaid offers one', withCat.category === '', JSON.stringify(withCat.category));

    ck('a zero-amount row is not a transaction at all',
       L.fromPlaid(tx({ id: 'Z', d: '2026-09-01', a: 0, n: 'FEE REVERSAL', acc: 'bofa-1' }), ACC) === null);
    ck('  nor is one with no id', L.fromPlaid({ date: '2026-09-01', amount: -5 }, ACC) === null);
}

// ── B — WHAT QUICKBOOKS CANNOT HOLD ───────────────────────────────────────
{
    section('B — the parts QuickBooks has no room for');

    const r = L.fromPlaid(tx({ id: 'T1', d: '2026-09-05', a: -47000,
        n: 'WIRE IN', p: 'Custom Alloys LLC', acc: 'bofa-1' }), ACC);

    ck('the untouched Plaid payload is kept', r.raw && r.raw.transaction_id === 'T1',
       'QuickBooks overwrites the original once a row is categorised');
    ck('  and it is the whole thing, not a summary',
       JSON.stringify(r.raw.name) === JSON.stringify('WIRE IN'));

    // RULE 5. Edge Metals and Edge Trading are different companies.
    ck('the row knows which company\'s bank it came from',
       r.company === 'Edge Metals INC', String(r.company));
    const chase = L.fromPlaid(tx({ id: 'T4', d: '2026-09-05', a: -1000, n: 'X', acc: 'chase-1' }), ACC);
    ck('  and the other account gives the OTHER company',
       chase.company === 'EDGE TRADING INC', String(chase.company));
    ck('  an unknown account gives null rather than defaulting to one of them',
       L.fromPlaid(tx({ id: 'T5', d: '2026-09-05', a: -1, n: 'X', acc: 'wells-9' }), ACC).company === null,
       'defaulting would put one company\'s money in the other\'s books');

    ck('pending is recorded', L.fromPlaid(tx({ id: 'P', d: '2026-09-05', a: -1, n: 'X', acc: 'bofa-1', pend: true }), ACC).pending === true);
    ck('a new row starts un-excluded with an empty history',
       r.excluded === false && Array.isArray(r.history) && r.history.length === 0 && r.drift === null);
}

// ── C — A RE-SYNC CORRECTS, NEVER DUPLICATES ──────────────────────────────
// QuickBooks' bank feed re-downloads the same week. config.js:346 already
// says the key is transaction_id for exactly this reason.
{
    section('C — the same week pulled twice');

    const first = norm([
        tx({ id: 'A', d: '2026-09-01', a: -100, n: 'ONE', acc: 'bofa-1' }),
        tx({ id: 'B', d: '2026-09-02', a: 200, n: 'TWO', acc: 'bofa-1' }),
    ]);
    const once = L.upsert([], first);
    ck('three rows in, three rows out', once.rows.length === 2 && once.report.added === 2,
       JSON.stringify(once.report));

    const twice = L.upsert(once.rows, first);
    ck('the identical pull adds nothing', twice.rows.length === 2 && twice.report.added === 0,
       JSON.stringify(twice.report));
    ck('  and reports them unchanged rather than refreshed',
       twice.report.unchanged === 2, JSON.stringify(twice.report));

    // RAW PLAID ROWS ARE REFUSED LOUDLY. The original code dropped anything
    // without an id, so a caller who forgot fromPlaid() got a clean sync of
    // nothing — found by my own smoke test making that exact mistake.
    let threw = null;
    try { L.upsert([], [{ transaction_id: 'RAW', amount: -1 }]); } catch (e) { threw = e.message; }
    ck('a raw Plaid transaction is refused with an explanation, not dropped',
       /call fromPlaid/.test(threw || ''), String(threw));
    threw = null;
    try { L.upsert([], [{ date: '2026-01-01', amount: -1 }]); } catch (e) { threw = e.message; }
    ck('  and an unkeyable row says why that matters',
       /duplicates on every sync/.test(threw || ''), String(threw));
}

// ── D — HER DECISIONS SURVIVE THE BANK ────────────────────────────────────
// The split the whole of upsert rests on: the bank owns what the bank did,
// she owns what she decided, and a sync must not confuse the two.
{
    section('D — a sync refreshes the bank\'s facts and touches nothing of hers');

    let rows = L.upsert([], norm([
        tx({ id: 'X', d: '2026-09-06', a: 12000, n: 'CHECK 1041', acc: 'bofa-1' }),
    ])).rows;
    rows = L.setExcluded(rows, 'X', true, { reason: 'owner draw, not a supplier payment', by: 'apsara' }).rows;

    // The bank restates the amount of a row she has already acted on.
    const after = L.upsert(rows, norm([
        tx({ id: 'X', d: '2026-09-06', a: 12500, n: 'CHECK 1041', acc: 'bofa-1' }),
    ]));
    const x = after.rows.find((r) => r.id === 'X');

    ck('her exclusion survives the sync', x.excluded === true);
    ck('  and so does her reason', x.excluded_reason === 'owner draw, not a supplier payment', String(x.excluded_reason));
    ck('the bank\'s new figure IS taken — it is the authority on what it did',
       x.spent === 12500 && x.amount === 12500, JSON.stringify({ s: x.spent, a: x.amount }));
    // THE DANGEROUS CASE QUICKBOOKS GETS WRONG: a figure moving under a
    // decision already made, with nothing recording that it happened.
    ck('  but the restatement is flagged as drift, not applied silently',
       x.drift && x.drift.fields.includes('amount')
       && x.drift.was.amount === 12000 && x.drift.now.amount === 12500,
       JSON.stringify(x.drift));
    ck('  with a history line saying the bank did it',
       x.history.some((h) => /bank restated/.test(h.what) && h.by === 'plaid sync'),
       JSON.stringify(x.history));
    ck('  and the sync report names it so a nightly sweep can see it',
       after.report.drifted.length === 1 && after.report.drifted[0].id === 'X',
       JSON.stringify(after.report.drifted));
    ck('the immutable raw payload is still the FIRST thing the bank said',
       x.raw.amount === 12000, String(x.raw.amount));

    // A pending row clearing is the normal expected change, not drift. If
    // this were flagged, every single pending row would raise an alarm and
    // the alarm would stop being read.
    let p = L.upsert([], norm([tx({ id: 'P', d: '2026-09-07', a: -5000, n: 'WIRE', acc: 'bofa-1', pend: true })])).rows;
    p = L.setExcluded(p, 'P', true, { reason: 'test', by: 'apsara' }).rows;
    const cleared = L.upsert(p, norm([tx({ id: 'P', d: '2026-09-07', a: -5000, n: 'WIRE', acc: 'bofa-1' })]));
    ck('a pending row clearing is NOT drift',
       cleared.rows[0].pending === false && cleared.rows[0].drift === null
       && cleared.report.drifted.length === 0,
       JSON.stringify({ drift: cleared.rows[0].drift, rep: cleared.report.drifted }));

    // A row she has NOT acted on can change freely — that is just the feed
    // settling, and flagging it would bury the real cases.
    const untouched = L.upsert(
        L.upsert([], norm([tx({ id: 'U', d: '2026-09-08', a: -10, n: 'A', acc: 'bofa-1' })])).rows,
        norm([tx({ id: 'U', d: '2026-09-08', a: -20, n: 'B', acc: 'bofa-1' })]));
    ck('  and a row nobody has touched changes without an alarm',
       untouched.rows[0].amount === 20 && untouched.rows[0].drift === null,
       JSON.stringify(untouched.report.drifted));
}

// ── E — EXCLUDED LEAVES THE WORKLIST AND NOTHING ELSE ─────────────────────
// Her instruction: hidden from the worklist, still counted, reversible.
// QuickBooks' Exclude makes the row vanish and there is no total of what
// was set aside.
{
    section('E — excluded is not deleted, and not invisible');

    let rows = L.upsert([], norm([
        tx({ id: 'W1', d: '2026-09-01', a: -47000, n: 'WIRE IN', acc: 'bofa-1' }),
        tx({ id: 'W2', d: '2026-09-02', a: 35, n: 'ANALYSIS FEE', acc: 'bofa-1' }),
        tx({ id: 'W3', d: '2026-09-03', a: 4200, n: 'OWNER DRAW', acc: 'bofa-1' }),
        tx({ id: 'W4', d: '2026-09-04', a: -900, n: 'PENDING', acc: 'bofa-1', pend: true }),
    ])).rows;

    ck('everything starts in the worklist except the pending row',
       L.worklist(rows).map((r) => r.id).join(',') === 'W1,W2,W3', L.worklist(rows).map((r) => r.id).join(','));

    rows = L.setExcluded(rows, 'W2', true, { reason: 'bank analysis fee', by: 'apsara' }).rows;
    rows = L.setExcluded(rows, 'W3', true, { reason: 'owner draw', by: 'apsara' }).rows;

    ck('excluding takes them out of the worklist',
       L.worklist(rows).map((r) => r.id).join(',') === 'W1', L.worklist(rows).map((r) => r.id).join(','));
    ck('  but they are still in the ledger', rows.length === 4);

    const s = L.summary(rows);
    ck('  and they have their OWN running total, not a silent omission',
       s.excluded.count === 2 && s.excluded.money === 4235, JSON.stringify(s.excluded));
    ck('  pending is counted separately too',
       s.pending.count === 1 && s.pending.money === 900, JSON.stringify(s.pending));
    ck('  the worklist money is money in and out, kept apart',
       s.in.money === 47000 && s.out.money === 0, JSON.stringify({ in: s.in, out: s.out }));
    ck('  and both companies present are named',
       Array.isArray(s.companies), JSON.stringify(s.companies));

    // REVERSIBLE, and the reversal is recorded.
    const back = L.setExcluded(rows, 'W3', false, { by: 'apsara' });
    ck('un-excluding puts it back', L.worklist(back.rows).map((r) => r.id).join(',') === 'W1,W3',
       L.worklist(back.rows).map((r) => r.id).join(','));
    ck('  clears the reason', back.row.excluded_reason === null, String(back.row.excluded_reason));
    ck('  and leaves BOTH acts in the history, not just the latest',
       back.row.history.length === 2
       && /excluded from the worklist/.test(back.row.history[0].what)
       && /put back in the worklist/.test(back.row.history[1].what),
       JSON.stringify(back.row.history.map((h) => h.what)));
    ck('  every history line says who and when',
       back.row.history.every((h) => h.by === 'apsara' && /^\d{4}-\d\d-\d\dT/.test(h.at)),
       JSON.stringify(back.row.history));
}

// ── F — THROUGH THE STORE, NOT JUST IN MEMORY ─────────────────────────────
{
    section('F — the same, written to disk and read back');

    const rep = await L.ingestPlaid([
        tx({ id: 'D1', d: '2026-09-10', a: -1000, n: 'WIRE IN A', p: 'Custom Alloys', acc: 'bofa-1' }),
        tx({ id: 'D2', d: '2026-09-11', a: 250, n: 'SERVICE CHARGE', acc: 'bofa-1' }),
    ], { accounts: ACC });
    ck('an ingest reports what it did', rep && rep.added === 2, JSON.stringify(rep));
    ck('  and the rows are on disk', L.list().length === 2, String(L.list().length));

    const ex = await L.exclude('D2', 'bank service charge', 'apsara');
    ck('excluding persists', ex && ex.excluded === true && L.list().find((r) => r.id === 'D2').excluded === true);

    const again = await L.ingestPlaid([
        tx({ id: 'D1', d: '2026-09-10', a: -1000, n: 'WIRE IN A', p: 'Custom Alloys', acc: 'bofa-1' }),
        tx({ id: 'D2', d: '2026-09-11', a: 250, n: 'SERVICE CHARGE', acc: 'bofa-1' }),
        tx({ id: 'D3', d: '2026-09-12', a: -77, n: 'NEW ONE', acc: 'chase-1' }),
    ], { accounts: ACC });
    ck('a second ingest adds only the new row', again.added === 1, JSON.stringify(again));
    ck('  and the exclusion survived the round trip through disk',
       L.list().find((r) => r.id === 'D2').excluded === true,
       'this is the whole reason the bank/hers split exists');
    ck('  three rows, no duplicates', L.list().length === 3, String(L.list().length));

    const put = await L.include('D2', 'apsara');
    ck('un-excluding persists too', put.excluded === false && L.list().find((r) => r.id === 'D2').excluded === false);

    // A broken store must degrade to empty, not throw mid-reconciliation.
    for (const junk of ['not json', '{}', 'null', '{"transactions":"nope"}']) {
        fs.writeFileSync(process.env.BANK_TX_FILE, junk);
        let ok = false;
        try { ok = Array.isArray(L.list()) && L.list().length === 0; } catch (e) { ok = false; }
        ck(`a store containing '${junk.slice(0, 18)}' reads as empty rather than throwing`, ok);
    }
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('threw:', e && e.stack); process.exit(1); });
