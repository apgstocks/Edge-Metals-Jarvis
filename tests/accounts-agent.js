// ── tests/accounts-agent.js ───────────────────────────────────────────────
// Apsara, 2026-10-28: "MAKE IT VERY EASY.ASSIGN A AI TO THIS TO DO ALL THE
// JOBS", then "AN AGENT ONLY FOR QB,BOOKS,BANK".
//
// What is asserted is the ONE message she reads, and the two properties that
// decide whether she keeps reading it: it is silent when there is nothing to
// do, and it never claims a figure it cannot stand behind.
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-acct-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated — refusing to run against her books');
    process.exit(1);
}
const A = require(path.join(ROOT, 'helpers/accountsAgent'));
const W = (f, v) => fs.writeFileSync(path.join(TMP, f), JSON.stringify(v));

(async () => {

const snap = (over = {}) => ({
    at: new Date().toISOString(), env: 'production', since: '2026-01-01',
    suppliers: [], customers: [], totals: { owe: 0, owed: 0 }, ...over,
});
const billRow = (o) => ({
    Id: String(o.id), TxnDate: o.date || '2026-05-11', TotalAmt: o.total,
    Balance: o.bal == null ? o.total : o.bal, DocNumber: o.doc || '',
    VendorRef: { name: o.who }, MetaData: { CreateTime: o.created || '2026-05-20T10:00:00-07:00' },
    Line: (o.lines || [o.total]).map((a) => ({ DetailType: 'AccountBasedExpenseLineDetail', Amount: a })),
    LinkedTxn: [],
});

// ── A MORNING WHERE THE YEAR CAN ALSO BE ASSESSED (2026-10-29) ──────────
// The CLOSING section reads the bank feed and the Jarvis stores. Before it
// existed, "a clean morning" needed only a sound snapshot; now a morning
// where those files cannot even be READ is not a clean morning, and the
// agent says so. That is the intended behaviour, so the fixture grew rather
// than the assertion shrinking: present, empty and readable means a year
// with nothing outstanding in it.
const closableClean = () => {
    W('bank-transactions.json', []);
    W('bills.json', []);
    W('sales.json', []);
};

// ─────────────────────────────────────────────────────────────────────────
section('A. silent when there is nothing to do');
{
    closableClean();
    W('qb-books-snapshot.json', snap());
    W('qb-snapshot-bills.json', { at: new Date().toISOString(), env: 'production',
        since: '2026-01-01', until: '2026-10-28', count: 0, rows: [] });
    W('qb-snapshot-invoices.json', { at: new Date().toISOString(), env: 'production',
        since: '2026-01-01', until: '2026-10-28', count: 0, rows: [] });
    const r = A.review();
    ck('a clean morning produces nothing to do', r.clean === true, JSON.stringify(r.todo));
    ck('  and says so in one line', /nothing needs you/i.test(A.text(r)), A.text(r));
    // The rule integritySweepJob states: a daily "all fine" is one she stops
    // opening, and then the morning it matters she does not open that either.
    ck('  the subject does not look like a problem', /nothing needs you/i.test(A.subject(r)), A.subject(r));
}

// ─────────────────────────────────────────────────────────────────────────
section('B. a stale or sandbox snapshot stops every QuickBooks figure');
{
    const old = new Date(Date.now() - 23 * 86400000).toISOString();
    W('qb-books-snapshot.json', snap({ at: old }));
    // A duplicate IS present, and must NOT be reported, because reporting
    // one off a stale pull is exactly what happened on 2026-10-28: two
    // duplicates named that had already been deleted weeks earlier.
    const dupRows = [
        billRow({ id: 1, total: 13506.42, doc: '26MK56', who: 'Houston', lines: [745.36, 6742.58, 6018.48] }),
        billRow({ id: 2, total: 13506.42, doc: '26MK56', who: 'Houston', lines: [745.36, 6742.58, 6018.48],
            created: '2026-06-02T10:00:00-07:00' }),
    ];
    W('qb-snapshot-bills.json', { at: old, env: 'production', since: '2026-01-01',
        until: '2026-09-05', count: 2, rows: dupRows });
    const r = A.review();
    const t = A.text(r);
    ck('the staleness is reported', /cannot be trusted this morning/.test(t) && /23 day/.test(t), t);
    ck('  and NO duplicate is named off a stale pull',
       !/entered twice/.test(t), 'a duplicate from a 23-day-old snapshot may already be deleted');
    ck('  it says plainly that comparisons are meaningless until fixed',
       /nothing comparing Jarvis to QuickBooks is meaningful/.test(t), t);

    W('qb-books-snapshot.json', snap({ env: 'sandbox' }));
    ck('a sandbox snapshot is refused the same way',
       /not her live books/.test(A.text(A.review())), A.text(A.review()));
}

// ─────────────────────────────────────────────────────────────────────────
section('C. on a FRESH snapshot it names the duplicate and the row to delete');
{
    const now = new Date().toISOString();
    W('qb-books-snapshot.json', snap({ at: now }));
    W('qb-snapshot-bills.json', { at: now, env: 'production', since: '2026-01-01',
        until: '2026-10-28', count: 2, rows: [
            billRow({ id: 38324, total: 13506.42, doc: '26MK56', who: 'Houston Junk Car Buyers',
                lines: [745.36, 6742.58, 6018.48], created: '2026-05-20T10:21:16-07:00' }),
            billRow({ id: 38553, total: 13506.42, doc: '26MK56', who: 'Houston Junk Car Buyers',
                lines: [745.36, 6742.58, 6018.48], created: '2026-06-02T10:34:32-07:00' }),
        ] });
    const r = A.review();
    const t = A.text(r);
    ck('the duplicate is reported with the money', /entered twice/.test(t) && /\$13,506\.42/.test(t), t);
    // Both are unpaid, so either can simply be deleted — and the LATER one is
    // the re-entry. The first version of removable() returned nothing here and
    // told her it needed unwinding, which is the hardest answer given for the
    // easiest case.
    ck('  and names the later-created row as the one to delete',
       /delete bill id 38553/.test(t), t);
    ck('  it does NOT send her to unwind a payment that does not exist',
       !/unwound/.test(t), t);
    ck('  the subject names the area so she can see it at a glance',
       /QUICKBOOKS/.test(A.subject(r)), A.subject(r));
}

// ─────────────────────────────────────────────────────────────────────────
section('D. one broken area does not cost her the others');
{
    // The morning QuickBooks times out she still needs the bank and books.
    // And a section that fails must SAY so: a shorter email that looks like
    // good news is the failure mode this whole file exists to prevent.
    const S = require(path.join(ROOT, 'helpers/quickbooks/snapshot'));
    const realRead = S.read;
    S.read = () => { throw new Error('intuit timed out'); };
    const r = A.review();
    S.read = realRead;
    ck('the failure is reported, not swallowed',
       r.todo.some((t) => t.area === 'FAILED' && /intuit timed out/.test(t.items.join(' '))),
       JSON.stringify(r.todo));
    ck('  and the run is NOT called clean', r.clean === false);
}

// ─────────────────────────────────────────────────────────────────────────
section('D2. send() is silent when clean — the promise she judges it by');
{
    // NOTHING tested send() at first, so the single property that decides
    // whether she keeps reading these mornings was unverified: a mutation
    // removing the clean check survived every assertion above.
    const gmail = require(path.join(ROOT, 'helpers/gmail'));
    const realSend = gmail.sendEmail;
    const realAddr = gmail.getMyEmailAddress;
    const sentTo = [];
    gmail.sendEmail = async (m) => { sentTo.push(m); return { id: 'x' }; };
    gmail.getMyEmailAddress = async () => 'apsara@example.com';

    const now = new Date().toISOString();
    const fresh = { at: now, env: 'production', since: '2026-01-01', until: '2026-10-28' };
    closableClean();
    W('qb-books-snapshot.json', snap({ at: now }));
    W('qb-snapshot-bills.json', { ...fresh, count: 0, rows: [] });
    W('qb-snapshot-invoices.json', { ...fresh, count: 0, rows: [] });

    let r = await A.send();
    ck('a clean morning sends NOTHING', r.sent === false && r.why === 'clean',
       JSON.stringify({ sent: r.sent, why: r.why }));
    ck('  and no mail was handed to gmail at all', sentTo.length === 0, JSON.stringify(sentTo.length));

    // Now give it something real to say.
    W('qb-snapshot-bills.json', { ...fresh, count: 2, rows: [
        billRow({ id: 38324, total: 13506.42, doc: '26MK56', who: 'Houston Junk Car Buyers',
            lines: [745.36, 6742.58, 6018.48], created: '2026-05-20T10:21:16-07:00' }),
        billRow({ id: 38553, total: 13506.42, doc: '26MK56', who: 'Houston Junk Car Buyers',
            lines: [745.36, 6742.58, 6018.48], created: '2026-06-02T10:34:32-07:00' }),
    ] });
    r = await A.send();
    ck('a morning with something to do DOES send', r.sent === true && sentTo.length === 1,
       JSON.stringify({ sent: r.sent, n: sentTo.length }));
    ck('  carrying the figure and the row to delete',
       /\$13,506\.42/.test(sentTo[0].body) && /delete bill id 38553/.test(sentTo[0].body),
       String(sentTo[0] && sentTo[0].body).slice(0, 200));
    ck('  in monospace, because the meaning is in the alignment',
       /font-family:ui-monospace/.test(sentTo[0].bodyHtml || ''), 'bodyHtml must be preformatted');

    gmail.sendEmail = realSend;
    gmail.getMyEmailAddress = realAddr;
}

// ─────────────────────────────────────────────────────────────────────────
section('D3. CLOSING — the year behind her, in one line');
// Apsara, 2026-10-29: "fix accounting first till october" / "This is the
// biggest headache for us". The other sections are about today; this one
// decides whether QuickBooks can go in January.
{
    const now = new Date().toISOString();
    const fresh = { at: now, env: 'production', since: '2026-01-01', until: '2026-12-31' };
    W('qb-books-snapshot.json', snap({ at: now }));
    W('qb-snapshot-bills.json', { ...fresh, count: 0, rows: [] });
    W('qb-snapshot-invoices.json', { ...fresh, count: 0, rows: [] });
    W('bills.json', []);
    W('sales.json', []);

    // Two months with one unexplained row each. The point of the assertion
    // is WHICH one she is pointed at.
    W('bank-transactions.json', [
        { id: 'X1', date: '2026-03-04', desc: 'EAGLE TRANS', spent: 3440, received: 0,
          amount: -3440, direction: 'out', bank: 'Chase', category: '', matched: null, history: [] },
        { id: 'X2', date: '2026-07-19', desc: 'BIG WIRE OUT', spent: 41000, received: 0,
          amount: -41000, direction: 'out', bank: 'Chase', category: '', matched: null, history: [] },
    ]);

    const r = A.review();
    const close = r.todo.filter((t) => t.area === 'CLOSING');
    ck('the agent reports the year as well as the morning', close.length === 1,
       JSON.stringify(r.todo.map((t) => t.area)));
    // ── EVERY READ BELOW IS GUARDED (2026-10-29) ─────────────────────────
    // Third time today I have written `thing[0].field` straight after
    // asserting the array is non-empty. When a mutation empties it, the
    // named failure above fires and is then THROWN AWAY by the TypeError:
    // the file dies, the harness logs "CRASHED", and a crash counts as zero
    // failures — the weakest possible kill for a real finding. So the
    // fixture is read through accessors that cannot throw.
    const c0 = close[0] || { what: '(no CLOSING section was produced)', items: [] };
    ck('  it counts the open months', /2 of \d+ month\(s\) not closed/.test(c0.what),
       c0.what);

    // ── THE OLDEST, NOT THE BIGGEST ──────────────────────────────────────
    // July's row is twelve times the money. March is still the one to start
    // with: a later month very often disagrees only because an earlier one
    // does, and fixing July first means doing March twice.
    ck('  and sends her to the OLDEST open month, not the largest sum',
       /start with 2026-03/.test(c0.what),
       `${c0.what} — July holds $41,000 against March's $3,440, and is still second`);
    ck('  naming the row, so she has somewhere to go',
       c0.items.some((i) => /EAGLE TRANS/.test(i)), JSON.stringify(c0.items));
    ck('  and how to see the rest of that month',
       c0.items.some((i) => /books-close\.js --month 2026-03/.test(i)),
       JSON.stringify(c0.items));

    // ── IT DOES NOT SAY THE SAME THING TWICE ─────────────────────────────
    // A stale snapshot is already the QUICKBOOKS section's finding. Repeating
    // it under CLOSING every morning is how she learns to skim the whole
    // message, which costs her the morning that matters.
    // ── THE FIXTURE HAS TO MAKE BOTH SECTIONS SPEAK (2026-10-29) ─────────
    // My first version only aged the snapshot. That makes the QUICKBOOKS
    // section complain about staleness, but booksClose does not check AGE at
    // all — it checks provenance, the 1000-row page cap and the period
    // covered — so it produced no snapshot blocker, there was nothing for the
    // filter to suppress, and the mutation that deletes the filter SURVIVED.
    // The check was asserting an absence that was free.
    //
    // So the snapshot here is stale AND truncated: QUICKBOOKS objects to its
    // age, booksClose objects to the page cap, and only the filter stops her
    // reading about the same file twice.
    const old = new Date(Date.now() - 40 * 86400000).toISOString();
    W('qb-books-snapshot.json', snap({ at: old }));
    W('qb-snapshot-bills.json', { at: old, env: 'production', since: '2026-01-01',
        until: '2026-12-31', count: 1000, rows: [] });
    W('qb-snapshot-invoices.json', { at: old, env: 'production', since: '2026-01-01',
        until: '2026-12-31', count: 1000, rows: [] });
    const r2 = A.review();
    const qbSaid = r2.todo.filter((t) => t.area === 'QUICKBOOKS')
        .some((t) => /cannot be trusted/.test(t.what));
    const closeSaid = r2.todo.filter((t) => t.area === 'CLOSING')
        .flatMap((t) => t.items).filter((i) => /snapshot/i.test(i));
    ck('a stale snapshot is reported by QUICKBOOKS', qbSaid === true,
       JSON.stringify(r2.todo.map((t) => t.what)));
    ck('  and CLOSING does not repeat it', closeSaid.length === 0,
       JSON.stringify(closeSaid));

    // ── A CLEAN YEAR IS SILENT ───────────────────────────────────────────
    W('qb-books-snapshot.json', snap({ at: now }));
    W('qb-snapshot-bills.json', { ...fresh, count: 0, rows: [] });
    W('qb-snapshot-invoices.json', { ...fresh, count: 0, rows: [] });
    W('bank-transactions.json', [
        { id: 'Y1', date: '2026-03-04', desc: 'EAGLE TRANS', spent: 3440, received: 0,
          amount: -3440, direction: 'out', bank: 'Chase', category: '5100', matched: null, history: [] },
    ]);
    const r3 = A.review();
    ck('explaining every row closes the year and the section goes quiet',
       r3.todo.filter((t) => t.area === 'CLOSING').length === 0 && r3.clean === true,
       JSON.stringify(r3.todo));

    // ── ONE DEFINITION OF THE PERIOD ─────────────────────────────────────
    // The script and the agent must not be able to disagree about which
    // months are even closable, so both read lastClosableWindow(). Asserted
    // on the behaviour: the window never includes the month she is in.
    const C = require(path.join(ROOT, 'helpers/booksClose'));
    const w = C.lastClosableWindow('2026-10-29');
    ck('the closable period stops at the end of LAST month', w.to === '2026-09-30',
       JSON.stringify(w) + ' — the month she is standing in is still receiving rows');
    ck('  and it handles January, which is the one that wraps a year',
       C.lastClosableWindow('2027-01-14').to === '2026-12-31',
       JSON.stringify(C.lastClosableWindow('2027-01-14')));
    ck('  and February in a leap year, which Date.UTC is trusted for',
       C.lastClosableWindow('2028-03-02').to === '2028-02-29',
       JSON.stringify(C.lastClosableWindow('2028-03-02')));
    ck('  the script reads that same helper, not a copy of the arithmetic',
       /lastClosableWindow\(\)/.test(fs.readFileSync(path.join(ROOT, 'scripts/books-close.js'), 'utf8')),
       'a second copy of "which months are closable" is a second answer');
}

// ─────────────────────────────────────────────────────────────────────────
section('E. it adds no check of its own, and writes nothing');
{
    const src = fs.readFileSync(path.join(ROOT, 'helpers/accountsAgent.js'), 'utf8');
    const code = src.replace(/^\s*\/\/.*$/gm, '');
    ck('it writes nothing anywhere', !/writeFile|mutateJson|markMatched|addBill/.test(code),
       'the jobs allowed to write already did their writing; this one reports');
    // The point of the file: it composes the existing agents rather than
    // carrying a second opinion about the same money.
    ck('  bank comes from bankAutoTick', /require\('\.\/bankAutoTick'\)/.test(code));
    ck('  books from booksAgent, which had no scheduled caller before today',
       /require\('\.\/booksAgent'\)/.test(code));
    ck('  duplicates from the ONE implementation, not a copy',
       /require\('\.\/qbDuplicates'\)/.test(code)
       && !/SAME CHARGE, DIFFERENT DATES/.test(code),
       'the signals must stay in helpers/qbDuplicates.js');
    ck('  and it is actually scheduled — the defect it exists to fix',
       /accountsAgent/.test(fs.readFileSync(path.join(ROOT, 'scheduler.js'), 'utf8')));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:\n  ' + failures.join('\n  ')); process.exit(1); }

})().catch((e) => { console.error('\nCRASHED: ' + (e && e.stack || e)); process.exit(1); });
