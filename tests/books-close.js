// ── tests/books-close.js — the report that says a month is closed ────────
//
// What is being protected is not arithmetic. It is the WORD "closed".
//
// Apsara is going to use this to decide whether she can let QuickBooks go in
// January. Every honesty guard in helpers/booksClose.js exists because the
// same class of mistake has already been made in this codebase: a missing
// bills.json summed to $0.00 and qb-parity announced "they agree to the
// cent" with zero parties reconciled. The figure was right and the claim was
// a lie. So the checks below spend most of their effort on the cases where
// the report has LESS information than it needs, and assert that it says so
// rather than producing a comfortable number.

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bclose-'));

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
const C = require(path.join(ROOT, 'helpers/booksClose'));

// Every store this report reads, pointed at the sandbox. The QB snapshots
// live beside BANK_TX_FILE's directory via snapshot.FILE(), so the whole set
// moves together.
cfg.BANK_TX_FILE = path.join(TMP, 'bank-transactions.json');
cfg.BILLS_FILE = path.join(TMP, 'bills.json');
cfg.SALES_FILE = path.join(TMP, 'sales.json');
// The per-kind snapshots are siblings of snapshot.FILE(), which honours
// QB_SNAPSHOT_FILE over config.DATA_DIR — so this is the one knob that moves
// them into the sandbox. Setting DATA_DIR would not: snapshot.js destructures
// it at require time, so a later reassignment is ignored. My first version of
// this file set the cfg keys and then read the REAL data/ snapshots, which is
// how section E came to be comparing production QuickBooks to a fixture.
process.env.QB_SNAPSHOT_FILE = path.join(TMP, 'qb-books-snapshot.json');
const snapPath = (kind) => path.join(TMP, `qb-snapshot-${kind}.json`);

const writeBank = (rows) => fs.writeFileSync(cfg.BANK_TX_FILE, JSON.stringify(rows));
const writeSnap = (kind, obj) => fs.writeFileSync(snapPath(kind), JSON.stringify(obj));
const wrap = (rows, extra = {}) => ({ at: '2026-11-01T06:00:00.000Z', env: 'production',
    since: '2026-01-01', until: '2026-10-31', count: rows.length, rows, ...extra });

const bankRow = (o) => ({ id: o.id, date: o.date, desc: o.desc || 'A PAYMENT',
    party: o.party || null, bank: o.bank || 'Chase',
    spent: o.out || 0, received: o.in || 0,
    amount: o.out ? -o.out : (o.in || 0), direction: o.out ? 'out' : 'in',
    pending: !!o.pending, excluded: !!o.excluded, category: o.category || '',
    matched: o.matched || null, history: o.history || [] });

// ══════════════════════════════════════════════════════════════════════════
section('A — the month key, from either date shape she actually has');
// Her documents are MM/DD/YYYY (helpers/time.js:2). Plaid and QuickBooks are
// YYYY-MM-DD. Guessing between them is how a January row lands in December.
{
    ck('a Plaid date buckets by its own month', C.ym('2026-03-14') === '2026-03');
    ck('one of her document dates does too', C.ym('3/14/2026') === '2026-03');
    ck('  and a single-digit month is not truncated', C.ym('1/5/2026') === '2026-01');
    ck('  the DAY is never read as the month', C.ym('12/01/2026') === '2026-12',
       `got ${C.ym('12/01/2026')} — US order is month first, and getting this wrong `
       + 'moves money between months without changing any total');
    ck('nonsense returns null rather than a month', C.ym('next tuesday') === null
       && C.ym('') === null && C.ym(null) === null,
       'coercing an unparseable date into a month files real money under a guess');
    ck('the period walks every month, inclusive both ends',
       C.monthsBetween('2026-01-01', '2026-10-31').join(',')
       === '2026-01,2026-02,2026-03,2026-04,2026-05,2026-06,2026-07,2026-08,2026-09,2026-10');
    ck('  and across a year boundary', C.monthsBetween('2026-11-01', '2027-02-28').join(',')
       === '2026-11,2026-12,2027-01,2027-02');
}

// ══════════════════════════════════════════════════════════════════════════
section('B — what counts as EXPLAINED');
// The three ways she settles a row, and the one that looks like a fourth.
{
    ck('a matched row is explained', C.explainedBy(bankRow({ matched: { at: 'x' } })) === 'matched');
    ck('a categorised row is explained', C.explainedBy(bankRow({ category: '6200' })) === 'categorised');
    ck('a set-aside row is explained', C.explainedBy(bankRow({ excluded: true })) === 'set aside');
    ck('an untouched row is NOT', C.explainedBy(bankRow({ out: 100 })) === null);

    // ── THE ONE THAT WOULD HAVE INFLATED THE WHOLE REPORT ────────────────
    // bankLedger.actedOn() counts `history` as well, and its own comment
    // says why: it is there to decide whether a RESTATED amount is a
    // problem. History means the bank changed its mind about a row. Reusing
    // actedOn here would have reported rows as explained because Plaid
    // revised them, which is not a decision she made about anything.
    ck('a row the BANK merely restated is not explained',
       C.explainedBy(bankRow({ out: 4000, history: [{ at: 'x', was: 3900 }] })) === null,
       'history is the bank changing its mind, not her classifying anything — '
       + 'counting it would inflate coverage with rows nobody has looked at');
}

// ══════════════════════════════════════════════════════════════════════════
section('C — a missing store is NO DATA, never agreement');
// The qb-parity mistake, verbatim: an absent bills.json summed to $0.00, an
// empty QuickBooks side summed to $0.00, and the report said they agreed.
{
    // Nothing written yet — every store absent.
    const r = C.close({ from: '2026-01-01', to: '2026-10-31' });
    ck('with no stores at all, nothing is called closed', r.closed === false);
    ck('  and it says so as blockers, not as figures', r.blockers.length >= 2,
       JSON.stringify(r.blockers));
    ck('  the bank half reports nodata', !!r.bank.nodata, JSON.stringify(r.bank.nodata));
    ck('  no month carries a $0.00 agreement',
       r.perMonth.every((m) => m.qb.nodata || Object.values(m.qb).every((v) => v.nodata)),
       'a zero on both sides of a comparison that never happened is the lie this exists to stop');
    ck('  and the summary leads with the blockers', /cannot be assessed/.test(r.summary), r.summary);
}

// ══════════════════════════════════════════════════════════════════════════
section('D — a truncated snapshot is refused, not used');
// QuickBooks caps a query page at 1000 rows and says nothing about it. An
// unpaginated pull of a busy year returns exactly 1000 and looks complete.
{
    const thousand = Array.from({ length: 1000 }, (_, i) => ({ TxnDate: '2026-05-04', TotalAmt: 10, Id: String(i) }));
    ck('exactly 1000 rows is refused as a page cap',
       /1000-row page cap/.test(C.snapshotUsable(wrap(thousand), '2026-10-31', 'bills') || ''),
       String(C.snapshotUsable(wrap(thousand), '2026-10-31', 'bills')));
    ck('  and so is 2000, which is two unpaginated pages',
       /page cap/.test(C.snapshotUsable(wrap([]).constructor === Object
         ? { ...wrap([]), count: 2000, rows: [] } : null, '2026-10-31', 'bills') || ''));
    ck('999 is not refused for that reason',
       !/page cap/.test(C.snapshotUsable({ ...wrap([]), count: 999 }, '2026-10-31', 'bills') || ''));
    ck('a bare array is refused for having no provenance',
       /no provenance/.test(C.snapshotUsable({ legacy: true, count: 40, rows: [] }, '2026-10-31', 'bills') || ''),
       'a snapshot that cannot say when it was taken cannot be trusted to cover a period');
    ck('a snapshot that stops before the period does cannot speak for it',
       /before 2026-10-31/.test(C.snapshotUsable({ ...wrap([]), until: '2026-06-30' }, '2026-10-31', 'bills') || ''),
       'a June pull says nothing about September');
    ck('a sound snapshot is accepted',
       C.snapshotUsable(wrap([{ TxnDate: '2026-02-02', TotalAmt: 5 }]), '2026-10-31', 'bills') === null);
}

// ══════════════════════════════════════════════════════════════════════════
section('E — END TO END: a month opens on one row and closes when she explains it');
{
    // One real month. Two bank rows: one matched, one untouched.
    writeBank([
        bankRow({ id: 'B1', date: '2026-02-03', out: 12000, desc: 'WIRE SANTIAGO', matched: { at: 'x' } }),
        bankRow({ id: 'B2', date: '2026-02-11', out: 3440, desc: 'EAGLE TRANS' }),
        bankRow({ id: 'B3', date: '2026-02-12', in: 90, desc: 'PENDING THING', pending: true }),
    ]);
    // Jarvis and QuickBooks agree for February.
    fs.writeFileSync(cfg.BILLS_FILE, JSON.stringify([]));
    fs.writeFileSync(cfg.SALES_FILE, JSON.stringify([]));
    writeSnap('bills', wrap([]));
    writeSnap('invoices', wrap([]));

    const snapshot = require(path.join(ROOT, 'helpers/quickbooks/snapshot'));
    ck('the sandbox snapshots are the ones being read',
       (snapshot.rows('bills') || {}).file === snapPath('bills'),
       `read ${(snapshot.rows('bills') || {}).file}, wanted ${snapPath('bills')}`);

    const r = C.close({ from: '2026-02-01', to: '2026-02-28' });
    const feb = r.perMonth[0];
    ck('nothing is refused now', r.blockers.length === 0, JSON.stringify(r.blockers));
    ck('february counts two settled rows, not the pending one', feb.bank.settled === 2,
       `settled ${feb.bank.settled}, pending ${feb.bank.pending}`);
    ck('  one explained, one open', feb.bank.explained === 1 && feb.bank.open === 1);
    ck('  and the open money is the UNEXPLAINED row only', feb.bank.money === 3440,
       `got ${feb.bank.money} — the matched 12,000 is not outstanding work`);
    ck('  the row is named so she can go and look at it',
       feb.bank.items.length === 1 && /EAGLE TRANS/.test(feb.bank.items[0].desc),
       JSON.stringify(feb.bank.items));
    ck('february is NOT closed while that row is open', feb.closed === false);
    ck('  and it says which row and how much', feb.why_open.some((w) => /1 bank row unexplained/.test(w)),
       JSON.stringify(feb.why_open));

    // She categorises it. Nothing else changes.
    const rows = JSON.parse(fs.readFileSync(cfg.BANK_TX_FILE, 'utf8'));
    rows.find((x) => x.id === 'B2').category = '5100';
    writeBank(rows);
    const after = C.close({ from: '2026-02-01', to: '2026-02-28' }).perMonth[0];
    ck('explaining the row closes the month', after.closed === true,
       JSON.stringify(after.why_open));
    ck('  with nothing left open', after.bank.open === 0 && after.bank.money === 0);
}

// ══════════════════════════════════════════════════════════════════════════
section('F — the QuickBooks half disagrees, and the month stays open');
{
    writeBank([bankRow({ id: 'C1', date: '2026-03-02', out: 500, category: '5100' })]);
    // Jarvis says it invoiced 10,000 in March; QuickBooks says 9,000.
    fs.writeFileSync(cfg.SALES_FILE, JSON.stringify([
        { id: 'S1', date: '03/10/2026', customer: 'Rigo', invoice_price: 1, weight: 10000,
          amount: 10000, weight_unit: 'lb', price_unit: 'lb' },
    ]));
    fs.writeFileSync(cfg.BILLS_FILE, JSON.stringify([]));
    writeSnap('bills', wrap([]));
    writeSnap('invoices', wrap([{ TxnDate: '2026-03-10', TotalAmt: 9000, Id: '1' }]));

    const mar = C.close({ from: '2026-03-01', to: '2026-03-31' }).perMonth[0];
    ck('the bank half is clean', mar.bank.open === 0);
    ck('but the month is NOT closed', mar.closed === false,
       'a month QuickBooks contradicts is a month she cannot defend to the owner');
    ck('  and it says which side and by how much',
       mar.why_open.some((w) => /invoices differ by 1000/.test(w)),
       JSON.stringify(mar.why_open));
    // Guarded, not assumed — the same mistake I fixed in tests/bills-sales.js
    // this morning: dereferencing a figure that the mutation under test is
    // capable of removing turns a named failure into a TypeError, and a
    // crashed file reports NOTHING rather than the thing it found.
    ck('  showing BOTH figures, not just the gap',
       !!(mar.qb.invoices) && mar.qb.invoices.jarvis === 10000 && mar.qb.invoices.qb === 9000,
       JSON.stringify(mar.qb.invoices));
}

// ══════════════════════════════════════════════════════════════════════════
section('G — THE CLAIM: "closed" cannot be true while anything was refused');
// This is the property the whole file exists for. Every figure can look
// perfect; if a store was unreadable or a snapshot was refused, the period
// is not closed and the word is not used.
{
    // A period that is genuinely clean on the evidence present...
    writeBank([bankRow({ id: 'D1', date: '2026-04-02', out: 100, category: '5100' })]);
    fs.writeFileSync(cfg.BILLS_FILE, JSON.stringify([]));
    fs.writeFileSync(cfg.SALES_FILE, JSON.stringify([]));
    writeSnap('bills', wrap([]));
    writeSnap('invoices', wrap([]));
    const good = C.close({ from: '2026-04-01', to: '2026-04-30' });
    ck('a clean month with everything readable IS closed', good.closed === true,
       JSON.stringify(good.blockers.concat(good.perMonth[0].why_open)));

    // ...and now ONE snapshot is truncated. Nothing else changes.
    writeSnap('invoices', { ...wrap([]), count: 1000 });
    const bad = C.close({ from: '2026-04-01', to: '2026-04-30' });
    ck('one refused snapshot un-closes the period', bad.closed === false,
       'the figures did not change — only how much of QuickBooks we can see');
    ck('  and the refusal is stated, not implied', bad.blockers.some((b) => /page cap/.test(b)),
       JSON.stringify(bad.blockers));
    ck('  the summary refuses to give a count of closed months',
       /cannot be assessed/.test(bad.summary), bad.summary);

    // ...and the same for an unreadable Jarvis store.
    writeSnap('invoices', wrap([]));
    writeSnap('bills', wrap([{ TxnDate: '2026-04-09', TotalAmt: 7500, Id: '9' }]));
    fs.unlinkSync(cfg.BILLS_FILE);
    const noStore = C.close({ from: '2026-04-01', to: '2026-04-30' });
    ck('an unreadable Jarvis store un-closes it too', noStore.closed === false);
    ck('  naming the file that is missing',
       noStore.blockers.some((b) => /bills\.json is not on this machine/.test(b)),
       JSON.stringify(noStore.blockers));

    // ── THE SURVIVOR THAT EXPOSED THIS CHECK'S OWN HOLE (2026-10-29) ─────
    // Dropping `!st.ok` from the early return in qbHalf left the BLOCKER in
    // place, so the two checks above still passed and the mutation SURVIVED.
    // What it changed is the month's own line: an unreadable bills.json gets
    // summed as $0.00 and reported as "bills differ by -7500", which reads
    // as "Jarvis is missing 7,500 of bills — go and enter them" when the
    // truth is "that file is not here". Those are different instructions,
    // and the wrong one sends her looking for documents that exist.
    //
    // QuickBooks deliberately HAS a figure for April here, so a fabricated
    // zero on the Jarvis side cannot hide as an agreement.
    const april = noStore.perMonth[0];
    ck('  and the MONTH says unreadable, not "differs by"',
       !!(april.qb.bills) && april.qb.bills.nodata === true,
       `month reported ${JSON.stringify(april.qb.bills)} — a zero standing in for a `
       + 'file that is absent is the qb-parity lie, told one month at a time');
    ck('    so nothing claims Jarvis recorded $0.00 of bills',
       !april.why_open.some((w) => /bills differ by/.test(w)),
       JSON.stringify(april.why_open));
}

// ══════════════════════════════════════════════════════════════════════════
section('H — it writes nothing');
// A report that changes things while reporting cannot be run twice, and this
// one will be run every day by an agent.
{
    writeBank([bankRow({ id: 'E1', date: '2026-05-02', out: 700 })]);
    fs.writeFileSync(cfg.BILLS_FILE, JSON.stringify([]));
    const before = ['bank-transactions.json', 'bills.json', 'sales.json',
        'qb-snapshot-bills.json', 'qb-snapshot-invoices.json']
        .map((f) => { try { return fs.readFileSync(path.join(TMP, f), 'utf8'); } catch { return null; } });
    C.close({ from: '2026-01-01', to: '2026-10-31' });
    C.close({ from: '2026-05-01', to: '2026-05-31' });
    const after = ['bank-transactions.json', 'bills.json', 'sales.json',
        'qb-snapshot-bills.json', 'qb-snapshot-invoices.json']
        .map((f) => { try { return fs.readFileSync(path.join(TMP, f), 'utf8'); } catch { return null; } });
    ck('two runs leave every store byte-identical',
       JSON.stringify(before) === JSON.stringify(after),
       'read-only is a promise the agent depends on');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }
