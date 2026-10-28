// ── tests/qb-duplicates.js ────────────────────────────────────────────────
// Apsara, 2026-10-28: "Check for duplicates for 2026 bills and invoices in
// quickbook", then: "it should be a rolling date..from 01-01-2026 to rolling
// date".
//
// Driven as a SUBPROCESS over fixture files, the way tests/books-readiness.js
// drives its script, because the signals live in the script and the thing that
// matters is what she reads on the terminal.
//
// Every fixture below is a shape found in her real 2026 books on the day this
// was written. The two false positives are as important as the two findings:
// a tool that cries duplicate at a trucking company billing twice in a day
// gets deleted in a week.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'qb-duplicates.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-qbdup-'));

const bill = (o) => ({
    Id: String(o.id), TxnDate: o.date, TotalAmt: o.total, Balance: o.bal == null ? o.total : o.bal,
    DocNumber: o.doc || '', VendorRef: { name: o.who },
    MetaData: { CreateTime: o.created || '2026-06-01T10:00:00-07:00' },
    PrivateNote: o.note || '',
    Line: (o.lines || [o.total]).map((a) => ({ DetailType: 'AccountBasedExpenseLineDetail', Amount: a }))
        .concat(o.subtotal ? [{ DetailType: 'SubTotalLineDetail', Amount: o.total }] : []),
    LinkedTxn: o.paidBy ? [{ TxnType: o.paidBy, TxnId: '1' }] : [],
});
const inv = (o) => { const b = bill(o); return { ...b, CustomerRef: { name: o.who }, VendorRef: undefined }; };

const write = (name, rows) => {
    const p = path.join(TMP, name);
    fs.writeFileSync(p, JSON.stringify(rows));
    return p;
};
function run(args) {
    try {
        return execFileSync(process.execPath, [SCRIPT, ...args],
            { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return String((e.stdout || '') + (e.stderr || '')); }
}

// ─────────────────────────────────────────────────────────────────────────
section('A. the two real findings, and the two shapes that are NOT duplicates');
{
    // HER DATA, 2026. Houston Junk Car Buyers ref 26MK56: the same three lines
    // to the cent, entered 13 days apart, both unpaid.
    const dup = [
        bill({ id: 1, date: '2026-05-11', total: 13506.42, doc: '26MK56', who: 'Houston Junk Car Buyers',
            lines: [745.36, 6742.58, 6018.48], created: '2026-05-20T10:21:16-07:00', note: 'TCKU6404660' }),
        bill({ id: 2, date: '2026-05-11', total: 13506.42, doc: '26MK56', who: 'Houston Junk Car Buyers',
            lines: [745.36, 6742.58, 6018.48], created: '2026-06-02T10:34:32-07:00', note: 'TCKU6404660, TCKU6404660' }),
        // ref 26ME06: the 1,387.00 bill is also a LINE inside the 21,317.04 one.
        bill({ id: 3, date: '2026-03-02', total: 21317.04, doc: '26ME06', who: 'Houston Junk Car Buyers',
            lines: [1387, 11881.92, 311.24, 3980.88, 3756], created: '2026-03-02T08:00:00-07:00' }),
        bill({ id: 4, date: '2026-03-02', total: 1387, doc: '26ME06', who: 'Houston Junk Car Buyers',
            lines: [1387], created: '2026-03-03T04:00:00-07:00' }),
        // NOT A DUPLICATE. Two real freight loads at one rate, 89 seconds
        // apart, DIFFERENT references and different containers. Each bill is a
        // single lump line equal to its total, so a "same lines" rule that
        // ignores the reference matches on the total and calls these a
        // duplicate — which is exactly what my first version did.
        bill({ id: 5, date: '2026-04-02', total: 8370, doc: 'Inv 174,175,176,177',
            who: "GARDUNO'S LOGISTICS INC.", created: '2026-05-07T13:56:09-07:00', note: 'BEAU6319965 SMCU1304159' }),
        bill({ id: 6, date: '2026-04-02', total: 8370, doc: 'Inv 170,171',
            who: "GARDUNO'S LOGISTICS INC.", created: '2026-05-07T13:54:40-07:00', note: 'SMCU1096878 HMMU4492700' }),
    ];
    const out = run(['--bills', write('b.json', dup), '--from', '2026-01-01', '--to', '2026-12-31']);

    ck('the identical-lines bill is called out', /SAME LINES/.test(out) && /26MK56/.test(out), out.slice(0, 300));
    ck('  and flagged as the one to look at', /26MK56[\s\S]{0,80}/.test(out)
       && /LOOK AT THIS ONE[^\n]*Houston/.test(out), out);
    ck('  with the 13-day gap, which is what says two saves not one',
       /13 days apart/.test(out), out);
    ck('  and that nothing is applied, so it can simply be deleted',
       /nothing applied/.test(out), out);

    ck('the subset is reported as a subset, not as a whole duplicate bill',
       /ONE IS A LINE OF THE OTHER/.test(out), out);
    ck('  and names the SMALL figure as the overstatement',
       /\$1,387\.00 bill is also a LINE inside the \$21,317\.04 one/.test(out), out);

    // The arithmetic she acts on: 13,506.42 + 1,387.00.
    ck('the total overstatement is the duplicate plus the subset, nothing else',
       /Overstated by \$14,893\.42/.test(out), (out.match(/Overstated by [^\n]*/) || [''])[0]);

    ck("Garduno's two loads are NOT called a duplicate",
       !/LOOK AT THIS ONE[^\n]*GARDUNO/.test(out), out);
    ck('  they are reported as same-amount-only, and said to be usually fine',
       /SAME TOTAL ONLY[^\n]*GARDUNO/.test(out) && /two real loads at one rate/.test(out), out);
}

// ─────────────────────────────────────────────────────────────────────────
section('A2. the same charge under two transaction dates');
{
    // HER LIVE RUN, 2026-10-28, immediately after this tool told her "Nothing
    // with identical lines twice". EAGLE TRANS SHIPPING ref UCSE/010480:
    // $3,440.00 dated 2026-03-18 and PAID, and $3,440.00 dated 2026-05-05
    // still OWING, both for the same two containers, created five days apart.
    // One freight charge entered twice. Signal 1 keyed on TxnDate, so it saw
    // two different bills and this landed in SAME NUMBER, unflagged and
    // counted as nothing overstated.
    const two = [
        bill({ id: 30, date: '2026-03-18', total: 3440, doc: 'UCSE/010480', who: 'EAGLE TRANS SHIPPING',
            bal: 0, paidBy: 'BillPaymentCheck', created: '2026-05-07T13:47:38-07:00',
            note: 'SEGU5270538 ECMU2613694', lines: [3440] }),
        bill({ id: 31, date: '2026-05-05', total: 3440, doc: 'UCSE/010480', who: 'EAGLE TRANS SHIPPING',
            created: '2026-05-12T11:23:38-07:00', lines: [3440] }),
        // NOT this one: same reference and same day, but DIFFERENT containers.
        // Two real charges under one reference, one paid and one not.
        bill({ id: 32, date: '2026-05-05', total: 15745, doc: 'UCSE/010732', who: 'EAGLE TRANS SHIPPING',
            bal: 0, paidBy: 'BillPaymentCheck', lines: [15745] }),
        bill({ id: 33, date: '2026-05-05', total: 8735, doc: 'UCSE/010732', who: 'EAGLE TRANS SHIPPING',
            lines: [8735] }),
    ];
    // The container text is what makes it certain, so it goes on the lines.
    two[0].Line[0].Description = 'SEGU5270538\nECMU2613694';
    two[1].Line[0].Description = 'SEGU5270538\nECMU2613694';
    two[2].Line[0].Description = 'SEGU2695755\nMSBU2008410\nFYCU702086';
    two[3].Line[0].Description = 'CAIU2774482 MEDU6303901 TCLU207765';

    const out = run(['--bills', write('eagle.json', two), '--from', '2026-01-01', '--to', '2026-12-31']);
    ck('one charge entered under two dates is caught',
       /SAME CHARGE, DIFFERENT DATES/.test(out), out.slice(0, 500));
    ck('  and flagged, not buried with the reference reuses',
       /LOOK AT THIS ONE[^\n]*EAGLE/.test(out), out);
    ck('  it names the UNPAID one as the one to remove',
       /the one still owing is id 31 \(\$3,440\.00\)/.test(out), out);
    ck('  and counts it in the overstatement',
       /Overstated by \$3,440\.00/.test(out), (out.match(/Overstated[^\n]*|Nothing with[^\n]*/) || [''])[0]);
    // The discrimination that keeps it usable: same reference, same day, but
    // different containers is TWO charges, not one entered twice.
    ck('  two charges under one reference with different containers are NOT merged',
       !/LOOK AT THIS ONE[^\n]*UCSE\/010732/.test(out)
       && /SAME NUMBER[^\n]*UCSE\/010732/.test(out), out);
    // ── THE TEXT IS WHAT DISCRIMINATES, AND THIS PROVES IT ──────────────
    // Same party, same reference, SAME amount, different dates — but
    // different containers. A flat rate per container makes this ordinary in
    // her trade, and it is two real charges, not one entered twice.
    //
    // Without this fixture a mutation that drops the container text from the
    // key survived everything: the UCSE/010732 pair above differs by AMOUNT,
    // so the amount alone still told them apart. The check has to turn on the
    // only field that actually separates these two.
    const flat = [
        bill({ id: 50, date: '2026-02-10', total: 2500, doc: 'FLAT1', who: 'HAULER',
            bal: 0, paidBy: 'BillPaymentCheck', lines: [2500] }),
        bill({ id: 51, date: '2026-04-10', total: 2500, doc: 'FLAT1', who: 'HAULER', lines: [2500] }),
    ];
    flat[0].Line[0].Description = 'ABCU1111111';
    flat[1].Line[0].Description = 'ZZZU9999999';
    const outF = run(['--bills', write('flat.json', flat), '--from', '2026-01-01', '--to', '2026-12-31']);
    ck('  same reference and amount but DIFFERENT containers is two charges, not one',
       !/SAME CHARGE, DIFFERENT DATES/.test(outF) && /SAME NUMBER[^\n]*HAULER/.test(outF), outF);
    ck('    and nothing is claimed overstated for it',
       /Nothing with identical lines twice/.test(outF),
       (outF.match(/Overstated[^\n]*|Nothing with[^\n]*/) || [''])[0]);

    // A blank description carries no information, so it must never be the
    // thing two bills are matched on — that is the Garduno's lump-line shape.
    const blank = [
        bill({ id: 40, date: '2026-01-05', total: 500, doc: 'R1', who: 'X' }),
        bill({ id: 41, date: '2026-02-05', total: 500, doc: 'R1', who: 'X' }),
    ];
    const outB = run(['--bills', write('blank.json', blank), '--from', '2026-01-01', '--to', '2026-12-31']);
    ck('  blank line text is never matched on',
       !/SAME CHARGE, DIFFERENT DATES/.test(outB), outB);
}

// ─────────────────────────────────────────────────────────────────────────
section("B. QuickBooks' own subtotal row must not double every document");
{
    // Her real invoices carry a SubTotalLineDetail that repeats the total. The
    // first run of this tool reported EVERY invoice as doubled because of it.
    const rows = [
        inv({ id: 10, date: '2026-07-17', total: 49135.13, doc: 'Edge 3173', who: 'OUTLAST',
            bal: 0, paidBy: 'Payment', subtotal: true, created: '2026-08-17T12:26:12-07:00' }),
        inv({ id: 11, date: '2026-07-17', total: 42370.90, doc: 'Edge 3173', who: 'OUTLAST',
            bal: 0, paidBy: 'Payment', subtotal: true, created: '2026-08-17T12:13:53-07:00' }),
    ];
    const out = run(['--invoices', write('i.json', rows), '--from', '2026-01-01', '--to', '2026-12-31']);
    ck('one invoice number used twice is reported', /SAME NUMBER[^\n]*OUTLAST/.test(out), out);
    ck('  but NOT as identical lines — the amounts differ, only the number repeats',
       !/SAME LINES/.test(out), out);
    ck('  and not as overstated revenue, because neither is a copy of the other',
       /Nothing with identical lines twice/.test(out), (out.match(/Nothing with[^\n]*|Overstated[^\n]*/) || [''])[0]);
    ck('  both show their payment, so she knows it cannot just be deleted',
       (out.match(/PAYMENT APPLIED/g) || []).length === 2, out);
    // ── THE SUBTOTAL ROW ITSELF ─────────────────────────────────────────
    // The checks above pass either way, because these two invoices have
    // different totals — so a mutation that counts QuickBooks' SubTotalLine
    // as a charge survived them all. The symptom of that bug was never a false
    // DUPLICATE here, it was every document's breakdown printed twice. So
    // assert the breakdown: one charge line, not the same figure repeated.
    ck('  and each breakdown shows ONE charge line, not the subtotal repeated',
       /lines \$49,135\.13\s*$/m.test(out) && !/lines \$49,135\.13 \/ \$49,135\.13/.test(out),
       (out.match(/lines [^\n]*/g) || []).join('   |   '));
}

// ─────────────────────────────────────────────────────────────────────────
section('C. the window is ROLLING, 2026-01-01 to today');
{
    const rows = [
        bill({ id: 20, date: '2025-12-31', total: 100, doc: 'OLD', who: 'A' }),
        bill({ id: 21, date: '2025-12-31', total: 100, doc: 'OLD', who: 'A' }),
        bill({ id: 22, date: '2026-02-02', total: 200, doc: 'IN', who: 'B' }),
        bill({ id: 23, date: '2026-02-02', total: 200, doc: 'IN', who: 'B' }),
    ];
    const f = write('w.json', rows);
    const today = new Date().toISOString().slice(0, 10);
    const out = run(['--bills', f]);
    ck('the default window starts 2026-01-01 and ends TODAY, not a calendar year',
       out.includes(`2026-01-01 to ${today}`), (out.split('\n')[0] || ''));
    ck('  a 2025 pair is outside it and is not reported',
       !/OLD/.test(out), out);
    ck('  the 2026 pair inside it is', /SAME LINES[^\n]*B/.test(out), out);

    const narrow = run(['--bills', f, '--from', '2026-03-01', '--to', '2026-12-31']);
    ck('--from and --to override the rolling default',
       /2026-03-01 to 2026-12-31/.test(narrow) && !/SAME LINES/.test(narrow), narrow);
}

// ─────────────────────────────────────────────────────────────────────────
section('D. it says when the data is short, instead of reporting a clean year');
{
    // THE FAILURE THIS TOOL EXISTS TO AVOID. The files in data/ on 2026-10-28
    // held exactly 1000 rows and stopped weeks before they were written.
    const many = [];
    for (let i = 0; i < 1000; i += 1) {
        many.push(bill({ id: 1000 + i, date: '2026-02-02', total: 10 + i, doc: 'D' + i, who: 'V' + i }));
    }
    const out = run(['--bills', write('trunc.json', many), '--from', '2026-01-01', '--to', '2026-12-31']);
    ck('exactly 1000 rows is called out as one unpaginated page',
       /EXACTLY 1000 rows/.test(out) && /NOT the whole window/.test(out), out.slice(0, 400));
    ck('  and nothing is claimed clean without that warning beside it',
       out.indexOf('INCOMPLETE DATA') < out.indexOf('═══'), 'the warning must come first');
}

// ─────────────────────────────────────────────────────────────────────────
section('E. it never writes to QuickBooks, and says so');
{
    const src = fs.readFileSync(SCRIPT, 'utf8');
    ck('no write verb anywhere in the script',
       !/client\.request\(\s*['"](POST|DELETE|PUT|PATCH)/i.test(src) && !/assertWriteAllowed/.test(src),
       'a duplicate finder that can delete is the worst thing in this repo');
    ck('  it only ever queries', /client\.query\(/.test(src));
    // client.query ALREADY unwraps QueryResponse. Reading r.QueryResponse[table]
    // returns undefined for every page, so a live run finds nothing and reports
    // a clean year — a false all-clear from the tool written to prevent one.
    // It shipped that way for ten minutes on 2026-10-28.
    // ── TEST THE CODE, NOT THE PROSE ────────────────────────────────────
    // Comments are stripped first. This is the THIRD check I have written
    // today that went red on my own comment — the others forbade the words
    // 'confirm_gap' and 'bankEntries' in files that explain why those are
    // wrong. A check that forbids writing about a mistake stops the next
    // person recording one, which is the opposite of what this repo wants.
    const code = src.replace(/^\s*\/\/.*$/gm, '');
    ck('  and reads the page the way client.query actually returns it',
       /\(r \|\| \{\}\)\[table\]/.test(code) && !/QueryResponse/.test(code),
       'client.query ends `return d.QueryResponse || {}` — do not unwrap it twice');
    ck('  the output tells her nothing was changed', /Nothing was changed/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:\n  ' + failures.join('\n  ')); process.exit(1); }
