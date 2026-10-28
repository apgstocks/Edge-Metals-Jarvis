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

// ─────────────────────────────────────────────────────────────────────────
section('A. silent when there is nothing to do');
{
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
