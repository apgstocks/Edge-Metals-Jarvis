// ── tests/migrate-bofa.js ─────────────────────────────────────────────────
// scripts/migrate-bofa-to-edge-metals.js rewrites rows in her real petty cash
// file. Apsara, 2026-09-22: "By default BofA is edge metals" / "for previous
// cash", choosing the migration over a relabelling when asked which she meant.
//
// A migration gets its own suite because the failure mode is not an exception
// — it is money that quietly ends up in the wrong company's column, on a file
// whose backup nobody checks until a figure looks wrong weeks later.
//
// Run as a CHILD PROCESS against a temp DATA_DIR, never by requiring it: the
// script calls main() at import time and writes on sight.
//
// The four things worth failing on:
//   1. --dry-run writes NOTHING. If this breaks, "let me just preview it"
//      silently becomes "I have migrated production".
//   2. transfer_to moves too. Miss it and helpers/pettyCash.borrowings reads
//      the direction of a debt off a bucket that no longer takes part.
//   3. Cash in hand is identical afterwards. Renaming a bucket must never
//      move a cent in or out of the box.
//   4. Running it twice changes nothing the second time.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'migrate-bofa-to-edge-metals.js');

const ROWS = [
    { id: 'a', date: '2026-08-01', kind: 'topup', cash_source: 'BofA', amount: 10000 },
    { id: 'b', date: '2026-08-02', kind: 'topup', cash_source: 'Chase Bank', amount: 3000 },
    { id: 'c', date: '2026-08-03', kind: 'topup', amount: 22441.03 },
    { id: 'd', date: '2026-08-04', kind: 'transfer', transfer_reason: 'borrow', transfer_id: 't1',
      cash_source: 'BofA', transfer_to: 'Chase Bank', amount: -4000 },
    { id: 'e', date: '2026-08-04', kind: 'transfer', transfer_reason: 'borrow', transfer_id: 't1',
      cash_source: 'Chase Bank', transfer_to: 'BofA', amount: 4000 },
    { id: 'f', date: '2026-08-05', kind: 'topup', cash_source: 'AAA Investment', amount: 500 },
];

function fresh() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-mig-'));
    fs.writeFileSync(path.join(dir, 'petty_cash.json'), JSON.stringify(ROWS, null, 2));
    return dir;
}
const read = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'petty_cash.json'), 'utf8'));
const run = (dir, args = []) => execFileSync(process.execPath, [SCRIPT, ...args],
    { env: { ...process.env, DATA_DIR: dir, JARVIS_TEST: '1' }, encoding: 'utf8' });
const total = (rows) => Math.round(rows.reduce((a, r) => a + (Number(r.amount) || 0), 0) * 100) / 100;
const sourced = (rows, name) => rows.filter((r) => String(r.cash_source || '') === name).length;

section('A — --dry-run touches nothing');
{
    const dir = fresh();
    const beforeRaw = fs.readFileSync(path.join(dir, 'petty_cash.json'), 'utf8');
    const out = run(dir, ['--dry-run']);
    const afterRaw = fs.readFileSync(path.join(dir, 'petty_cash.json'), 'utf8');
    ck('the file is byte-identical after a dry run', beforeRaw === afterRaw,
        'a preview that writes is not a preview');
    ck('  and it still says what it WOULD do', /Would rewrite cash_source "BofA" -> "Edge Metals": 2/.test(out),
        out.slice(0, 300));
    ck('  including the transfer_to row', /Would rewrite transfer_to "BofA" -> "Edge Metals": 1/.test(out));
    ck('  and no backup was written either',
        fs.readdirSync(dir).filter((f) => f.includes('.bak-')).length === 0,
        fs.readdirSync(dir).join(', '));
}

section('B — the real run');
{
    const dir = fresh();
    const before = read(dir);
    const out = run(dir);
    const after = read(dir);

    ck('every BofA row now says Edge Metals',
        sourced(after, 'BofA') === 0 && sourced(after, 'Edge Metals') === 2,
        JSON.stringify(after.map((r) => r.cash_source)));
    // The one that is easy to miss, and the one that silently reverses the
    // direction of a debt on the Borrowing tab if it is missed.
    ck('  and so does transfer_to on the other half of the pair',
        after.find((r) => r.id === 'e').transfer_to === 'Edge Metals',
        JSON.stringify(after.find((r) => r.id === 'e')));
    ck('  the borrow pair still shares its transfer_id',
        after.find((r) => r.id === 'd').transfer_id === after.find((r) => r.id === 'e').transfer_id);

    // THE PROPERTY. This is a rename, not a movement.
    ck('cash in hand is unchanged', total(after) === total(before),
        `${total(before)} -> ${total(after)}`);
    ck('  and it says so out loud', /Cash in hand unchanged/.test(out), out.slice(-200));

    // Untouched by name, each for its own reason.
    ck('Chase Bank is untouched', sourced(after, 'Chase Bank') === 2);
    ck('AAA Investment is untouched', sourced(after, 'AAA Investment') === 1);
    // Unassigned is her opening float and cash taken in on sales. It never
    // came out of a bank, and she has never said whose it is.
    ck('  and the unbanked row is NOT swept into Edge Metals',
        after.find((r) => r.id === 'c').cash_source === undefined,
        JSON.stringify(after.find((r) => r.id === 'c')));

    ck('a timestamped backup was written first',
        fs.readdirSync(dir).some((f) => f.includes('.bak-')), fs.readdirSync(dir).join(', '));
    const bak = fs.readdirSync(dir).find((f) => f.includes('.bak-'));
    ck('  and the backup is the ORIGINAL, not the result',
        JSON.parse(fs.readFileSync(path.join(dir, bak), 'utf8')).some((r) => r.cash_source === 'BofA'),
        'a backup taken after the write restores nothing');

    ck('nothing was added or dropped', after.length === before.length,
        `${before.length} -> ${after.length}`);
}

section('C — running it twice');
{
    const dir = fresh();
    run(dir);
    const once = fs.readFileSync(path.join(dir, 'petty_cash.json'), 'utf8');
    const out = run(dir);
    const twice = fs.readFileSync(path.join(dir, 'petty_cash.json'), 'utf8');
    ck('the second run changes nothing', once === twice);
    ck('  and says so rather than pretending it worked', /already migrated/.test(out), out.slice(-200));
    ck('  and does not take a second backup',
        fs.readdirSync(dir).filter((f) => f.includes('.bak-')).length === 1,
        fs.readdirSync(dir).join(', '));
}

section('D — it refuses rather than guessing');
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-mig-'));
    fs.writeFileSync(path.join(dir, 'petty_cash.json'), '{ not an array }');
    let threw = null;
    try { run(dir); } catch (e) { threw = e; }
    ck('a file that is not valid JSON aborts, touching nothing', !!threw,
        'a migration that shrugs at a broken file is how a broken file gets written back');
    ck('  and the file is left exactly as it was',
        fs.readFileSync(path.join(dir, 'petty_cash.json'), 'utf8') === '{ not an array }');

    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-mig-'));
    fs.writeFileSync(path.join(dir2, 'petty_cash.json'), '{"rows":[]}');
    let threw2 = null;
    try { run(dir2); } catch (e) { threw2 = e; }
    ck('valid JSON that is not an array aborts too', !!threw2);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
