// tests/party-invoice-revised.js — a REVISED invoice replaces its original (Apsara, 2026-10-07).
// She pasted Garduno's 166 listed twice: "166 revised" x6 and "166" x7, $930 each — 13 lines
// where there were 6 or 7. A: identity + import order. B: the supersede step, report-first,
// through the real script. Mirrors her real rows.
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-rev-'));
process.env.DATA_DIR = TMP; process.env.JARVIS_TEST = '1';
let pass = 0, fail = 0;
const ck = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n); if (x) console.log('        ' + x); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const PI = require(path.join(ROOT, 'helpers/partyInvoices'));
const rec = (inv, c) => ({ party: 'gardunos', invoice_no: inv, container_no: c, total_amount: 930, invoice_date: '01/19/2026', status: 'verified' });
const ROW = (inv, c) => PI.normalize(rec(inv, c)).row;
const REV = ['GCXU5019927', 'KOCU4821211', 'KOCU4901908', 'HMMU6483272', 'KOCU4504963', 'KOCU4079822'];
const ORIG = ['HMMU4357974', ...REV];

(async () => {
    section('A. identity');
    ck('"166 revised" and "166" are the SAME line (one key)', ROW('166 revised', 'GCXU5019927').key === ROW('166', 'GCXU5019927').key);
    ck('the printed invoice number is kept as printed', ROW('166 revised', 'GCXU5019927').invoice_no === '166 revised');
    ck('flagged revised / not revised', ROW('166 REVISED', 'A').revised === true && ROW('166', 'A').revised === false);
    ck('other spellings: REV, CORRECTED, AMENDED', ['166 REV', '166 Corrected', '166 amended'].every((n) => PI.isRevised(n) && PI.baseInvoice(n) === '166'));
    ck('an invoice number that merely starts with "rev" is not revised', !PI.isRevised('REV123') && PI.baseInvoice('REV123') === 'REV123');
    ck('"6405" / "J1" unaffected', !PI.isRevised('6405') && PI.baseInvoice('J1') === 'J1');

    section('import order cannot create duplicates');
    await PI.upsertMany(REV.map((c) => ROW('166 revised', c)));
    await PI.upsertMany(ORIG.map((c) => ROW('166', c)));          // the original arrives AFTER the revision
    let rows = PI.list();
    ck('original after revised: still ONE line per container (6) + the extra one (7)', rows.length === 7, String(rows.length));
    ck('the revised row was not overwritten by the original', rows.filter((r) => r.revised).length === 6 && rows.filter((r) => r.container_no === 'GCXU5019927')[0].invoice_no === '166 revised');
    ck('HMMU4357974 (only on the original) is kept, as the original', rows.find((r) => r.container_no === 'HMMU4357974').revised === false);

    section('B. her existing duplicate data, cleaned up (report first)');
    // Reproduce what is already in her store: both versions keyed by the FULL printed number (the old key).
    fs.writeFileSync(path.join(TMP, 'party_invoices.json'), JSON.stringify([
        ...REV.map((c, i) => ({ id: `R${i}`, party: 'gardunos', key: `gardunos:166 revised:${c}`, invoice_no: '166 revised', container_no: c, amount: 930, check_status: 'verified' })),   // NO `revised` field: imported before it existed
        ...ORIG.map((c, i) => ({ id: `O${i}`, party: 'gardunos', key: `gardunos:166:${c}`, invoice_no: '166', container_no: c, amount: 930, check_status: 'verified' })),
    ]));
    ck('before: 13 lines, $12,090 (the double count)', PI.list().length === 13 && PI.summary().gardunos.total === 12090);
    const plan = PI.supersedePlan();
    ck('plan: 6 originals replaced (legacy rows with no stored flag)', plan.remove.length === 6 && plan.remove.every((r) => r.invoice_no === '166'));
    ck('plan: HMMU4357974 flagged "only on the original", NOT removed', plan.only_on_original.length === 1 && plan.only_on_original[0].container_no === 'HMMU4357974');
    const prev = execFileSync('node', [path.join(ROOT, 'scripts/party-invoices-import.js'), '--supersede'], { env: process.env, encoding: 'utf8' });
    ck('the script preview writes nothing', /PREVIEW/.test(prev) && PI.list().length === 13);
    ck('and names the orphan for her to check', /HMMU4357974/.test(prev) && /missing from the revision/.test(prev));
    const done = execFileSync('node', [path.join(ROOT, 'scripts/party-invoices-import.js'), '--supersede', '--write'], { env: process.env, encoding: 'utf8' });
    rows = PI.list();
    ck('--write removes the 6 replaced originals', /Removed 6/.test(done) && rows.length === 7);
    ck('total is now $6,510 (6 revised + the one only on the original)', PI.summary().gardunos.total === 6510, String(PI.summary().gardunos.total));
    ck('revised rows were re-keyed to the base and flagged, so a re-import cannot re-add the original', rows.filter((r) => r.revised).length === 6 && rows.filter((r) => r.revised).every((r) => r.key.startsWith('gardunos:166:')));
    const re = await PI.upsertMany(ORIG.map((c) => ROW('166', c)));
    ck('a later re-import of the ORIGINAL changes nothing', PI.list().length === 7 && re.added === 0, JSON.stringify(re));
    ck('idempotent: a second --supersede finds nothing to remove', PI.supersedePlan().remove.length === 0);

    section('never destroys paid or hand-edited lines');
    fs.writeFileSync(path.join(TMP, 'party_invoices.json'), JSON.stringify([
        { id: 'R1', party: 'gardunos', key: 'gardunos:200 revised:AAAA1111111', invoice_no: '200 revised', revised: true, container_no: 'AAAA1111111', amount: 500 },
        { id: 'O1', party: 'gardunos', key: 'gardunos:200:AAAA1111111', invoice_no: '200', revised: false, container_no: 'AAAA1111111', amount: 450 },   // has a payment
        { id: 'R2', party: 'gardunos', key: 'gardunos:200 revised:BBBB2222222', invoice_no: '200 revised', revised: true, container_no: 'BBBB2222222', amount: 500 },
        { id: 'O2', party: 'gardunos', key: 'gardunos:200:BBBB2222222', invoice_no: '200', revised: false, container_no: 'BBBB2222222', amount: 480, locked: true },  // hand-edited
    ]));
    fs.writeFileSync(path.join(TMP, 'party_invoice_payments.json'), JSON.stringify([{ id: 'P1', party: 'gardunos', amount: 450, mode: 'Wire', paid_on: '2026-02-01', allocations: [{ row_id: 'O1', amount: 450 }] }]));
    const p2 = PI.supersedePlan();
    ck('a paid original is BLOCKED with the reason', p2.blocked.some((b) => b.row.id === 'O1' && /450 already paid/.test(b.why)));
    ck('a hand-edited original is BLOCKED', p2.blocked.some((b) => b.row.id === 'O2' && /edited by hand/.test(b.why)));
    ck('nothing removed', p2.remove.length === 0);
    await PI.supersedeApply();
    ck('apply leaves both blocked lines in place', PI.list().length === 4);

    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
