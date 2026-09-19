// ── tests/margin-damage.js ──────────────────────────────────────────────────
// scripts/margin-damage.js answers "how much did the container-key bug cost",
// and she will act on the figure it prints — chasing money in her ledger, or
// deciding the month's margins were close enough to leave alone.
//
// So its arithmetic is tested like anything else that puts a dollar figure in
// front of her. A diagnostic that is merely APPROXIMATELY right sends her
// looking for money that was never missing, which is worse than no diagnostic.
//
// ── IT RE-IMPLEMENTS THE OLD BEHAVIOUR, WHICH IS THE RISKY PART ─────────────
// To say what the report USED to show, the script reproduces the rule that
// was removed: one line per container, the rest discarded. Nothing else in
// the codebase does that any more, so nothing else would notice if this copy
// drifted. Section B pins it to a figure taken from her own invoice register.
//
// Run as a CHILD PROCESS, deliberately: the script reads DATA_DIR at require
// time through config.js, and it prints rather than returning. Requiring it
// in-process would test a different thing than the one she runs.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-dmg-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(os.tmpdir())) {
    console.error('REFUSING TO RUN: DATA_DIR is not a temp directory.');
    process.exit(1);
}
const bills = require(path.join(ROOT, 'helpers/bills'));
const sales = require(path.join(ROOT, 'helpers/sales'));

const run = (...args) => spawnSync(process.execPath,
    [path.join(ROOT, 'scripts/margin-damage.js'), ...args],
    { encoding: 'utf8', env: { ...process.env, DATA_DIR: TMP, JARVIS_TEST: '1' } });

(async () => {

// ── HER OWN CONTAINER ───────────────────────────────────────────────────────
// 266116225 / TEMU7944250, four grades, straight off the invoice register she
// was looking at on 2026-09-19.
const GRADES = [['Alu Breakage', 29897, 0.49], ['Alternator', 11409, 1.13],
                ['Starter/bose load', 1634, 0.85], ['Wheel Weight/bose load', 6975, 0.24]];
await bills.addBill({ date: '03/02/2026', supplier: 'Gomez', booking_no: '266116225',
    container_no: 'TEMU7944250', gross: 70000, truck: 15000, container: 8500,
    chassis: 6600, boxes: 0, supplier_price: 0.30 });
for (const [item, weight, invoice_price] of GRADES) {
    await sales.addSale({ date: '03/02/2026', customer: 'Modern Enterprises/Hardeep Puri',
        booking_no: '266116225', container_no: 'TEMU7944250', item, weight, invoice_price });
}

// An ordinary one-grade container, which must NOT be counted as damage.
await bills.addBill({ date: '03/05/2026', supplier: 'Aussins', booking_no: '265003305',
    container_no: 'MRKU6160553', gross: 40000, truck: 12000, container: 8500,
    chassis: 6600, boxes: 0, supplier_price: 0.40 });
await sales.addSale({ date: '03/05/2026', customer: 'MK Trading', booking_no: '265003305',
    container_no: 'MRKU6160553', item: 'AL COMBO', weight: 12900, invoice_price: 0.94 });

// ── A. IT RUNS, READ-ONLY ───────────────────────────────────────────────────
section('A. it runs and changes nothing');
{
    const before = fs.readFileSync(cfg.SALES_FILE, 'utf8');
    const r = run();
    ck('the script exits cleanly', r.status === 0, `${r.status} ${(r.stderr || '').slice(0, 200)}`);
    ck('  and prints a report', /WHAT THE CONTAINER-KEY BUG WAS HIDING/.test(r.stdout || ''),
       (r.stdout || '').slice(0, 120));
    ck('  READ-ONLY: the sales store is untouched',
       fs.readFileSync(cfg.SALES_FILE, 'utf8') === before,
       'it is meant to be safe to run on the live VM while she works');
    ck('  and it says so, so nobody has to guess',
       /Read-only — nothing was changed/.test(r.stdout || ''));
}

// ── B. THE FIGURE, AGAINST HER OWN NUMBERS ──────────────────────────────────
// $30,604.60 across the four lines; $14,649.53 was what the report showed.
// These are the numbers in the commit message and in margin.js's comment — if
// this ever disagrees, one of the three is lying.
section('B. the arithmetic, against her invoice register');
{
    const out = run('--list').stdout || '';
    const real = GRADES.reduce((t, [, w, p]) => t + w * p, 0);

    ck('the four-grade container is reported', /TEMU7944250/.test(out), out.slice(0, 200));
    ck('  showing what it used to say', /\$14,649\.53/.test(out),
       'the first grade alone — that is what the report showed all month');
    ck('  and what it should have said',
       new RegExp(`\\$${real.toFixed(2).replace('.', '\\.').replace(/(\d)(?=(\d{3})+\\)/g, '$1,')}`).test(out)
       || /\$30,604\.60/.test(out),
       `expected ${real.toFixed(2)} somewhere in the output`);
    ck('  and names the gap',
       /missing \$15,955\.07/.test(out) || /MISSING\s+\$15,955\.07/.test(out),
       out.split('\n').filter((l) => /missing|MISSING/i.test(l)).join(' | '));

    // ── THE ORDINARY CONTAINER IS NOT DAMAGE ────────────────────────────
    // A report that lists every container is a report she cannot use.
    ck('a one-grade container is NOT listed as affected',
       !/MRKU6160553/.test(out), 'listing clean containers makes the list useless');
    ck('  and the count says 1 of 2', /carrying more than one line\s+1\b/.test(out),
       out.split('\n').find((l) => /carrying more than one/.test(l)));
}

// ── C. A DOUBLE-COUNT IS THE OPPOSITE PROBLEM, AND IS MARKED ────────────────
// Summing a container's grades is right. Summing the SAME grade twice invents
// revenue — and on this list the two look identical unless one is marked, with
// the one that needs DELETING reading as the best news on the page.
section('C. a repeated grade is flagged, not celebrated');
{
    await sales.addSale({ date: '03/06/2026', customer: 'MK Trading', booking_no: '265003305',
        container_no: 'MRKU6160553', item: 'AL COMBO', weight: 12900, invoice_price: 0.94 });
    const out = run('--list').stdout || '';

    ck('the repeated grade gets its own section',
       /SAME GRADE CLAIMED TWICE/.test(out), out.slice(0, 200));
    ck('  naming the container and the grade',
       /265003305 \/ MRKU6160553/.test(out) && /AL COMBO/.test(out),
       out.split('\n').filter((l) => /MRKU6160553/.test(l)).join(' | '));
    ck('  and the row in the list is marked as suspect',
       /MRKU6160553\s+⚠ has a repeated grade/.test(out),
       out.split('\n').filter((l) => /MRKU6160553/.test(l)).join(' | '));
    ck('  while the genuine grade split is NOT marked',
       !/TEMU7944250\s+⚠/.test(out),
       'marking everything is the same as marking nothing');
}

// ── D. AN EMPTY LEDGER SAYS SO RATHER THAN CRASHING ─────────────────────────
// It will be run on a fresh checkout, and a stack trace there reads as "the
// fix is broken" rather than "there is nothing here yet".
section('D. nothing to report is an answer');
{
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-dmg-empty-'));
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/margin-damage.js')],
        { encoding: 'utf8', env: { ...process.env, DATA_DIR: empty, JARVIS_TEST: '1' } });
    ck('an empty ledger exits 0', r.status === 0, String(r.status));
    ck('  and says there is nothing to report',
       /Nothing to report/.test(r.stdout || ''), (r.stdout || '').slice(-200));
    ck('  without dividing by zero anywhere', !/NaN|Infinity/.test(r.stdout || ''),
       (r.stdout || '').slice(0, 300));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('SUITE CRASHED:', e && e.stack); process.exit(1); });
