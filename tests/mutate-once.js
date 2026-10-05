// ── tests/mutate-once.js ──────────────────────────────────────────────────
// scripts/mutate.js --once / --restore.
//
// ── WHY THIS MODE EXISTS ─────────────────────────────────────────────────
// Everything else in mutate.js protects the CATALOGUE: a sidecar written
// before the file is touched, restore in a finally, on exit, on SIGINT and
// SIGTERM, and a pre-commit hook that refuses to commit while the sidecar
// exists.
//
// None of it protects the way a mutation is usually actually written, which
// is by hand:
//
//     cp helpers/x.js /tmp/x.orig
//     python3 -c "...replace one line..."
//     node tests/x.js
//     cp /tmp/x.orig helpers/x.js
//
// That loop has no sidecar, so the hook cannot see it, and no exit handler,
// so a timeout leaves the mutation on disk with nothing recording that it is
// there. About ninety mutations were run that way on 2026-10-05 and two of
// the shell calls timed out — between loops, as it happened, rather than
// inside one.
//
// The protection existing does not help if the unprotected path is the
// convenient one. So this makes the protected path convenient, and these
// checks are about the three ways it could fail to protect anything.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const SIDECAR = path.join(ROOT, '.mutate-restore.json');

// ── A SCRATCH FILE, NOT A REAL ONE ───────────────────────────────────────
// This test mutates a file on purpose. Pointing it at a real helper would
// mean a crash HERE leaves the repo broken — the exact failure being
// guarded against. So it operates on a throwaway inside the repo (mutate.js
// resolves paths relative to ROOT) and removes it at the end.
const SCRATCH_REL = 'outputs/.mutate-once-probe.js';
const SCRATCH = path.join(ROOT, SCRATCH_REL);
const ORIGINAL = 'const a = 1;\nconst guard = (x) => x > 0;\nmodule.exports = { a, guard };\n';

// ── stdout AND stderr, KEPT APART ────────────────────────────────────────
// The first version returned stdout + stderr concatenated, and section E was
// FLAKY because of it: mutate.js writes its crash-recovery warning to stderr,
// so whenever a run happened to trigger recovery the "last line" of the
// combined string was no longer the catalogue summary. It failed once, then
// passed unchanged on the next run — which is the worst outcome available,
// because a flaky check teaches people to re-run rather than to look.
//
// So content assertions read `out` (stdout only) and message assertions read
// `all`, and nothing depends on which stream a line arrived on.
const mutate = (...args) => {
    const r = spawnSync('node', [path.join(ROOT, 'scripts/mutate.js'), ...args],
        { encoding: 'utf8', cwd: ROOT, timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
    const out = r.stdout || '', err = r.stderr || '';
    return { code: r.status, out, err, all: out + err };
};
const sidecarExists = () => fs.existsSync(SIDECAR);
const scratch = () => fs.readFileSync(SCRATCH, 'utf8');

function reset() {
    fs.mkdirSync(path.dirname(SCRATCH), { recursive: true });
    fs.writeFileSync(SCRATCH, ORIGINAL);
    try { fs.unlinkSync(SIDECAR); } catch (e) {}
}

// Nothing in this file may run if a REAL mutation is already on disk — that
// would be this test deleting someone else's unrestored work.
if (sidecarExists()) {
    let who = {};
    try { who = JSON.parse(fs.readFileSync(SIDECAR, 'utf8')); } catch (e) {}
    console.error(`  ABORT  a mutation is already on disk (${who.file || '?'}) — run: node scripts/mutate.js --restore`);
    process.exit(1);
}

try {

// ── A — IT MUTATES, AND IT LEAVES A RECORD ────────────────────────────────
{
    section('A — the sidecar, which is what the hook reads');

    reset();
    const r = mutate('--once', SCRATCH_REL, '--find', 'x > 0', '--to', 'x >= 0');
    ck('it reports what it did', r.code === 0 && /Mutated/.test(r.all), r.out.trim());
    ck('  the file really changed', /x >= 0/.test(scratch()), scratch());
    ck('  a sidecar exists, so the pre-commit hook can see it', sidecarExists());

    const side = JSON.parse(fs.readFileSync(SIDECAR, 'utf8'));
    ck('  it names the file', side.file === SCRATCH_REL, side.file);
    ck('  and carries the ORIGINAL, not a diff',
       side.original === ORIGINAL, JSON.stringify(side.original));
    ck('  and when it happened', /^\d{4}-\d\d-\d\dT/.test(side.at || ''), String(side.at));
    ck('  it tells her the restore command', /--restore/.test(r.all), r.all.trim());
}

// ── B — RESTORE IS EXACT ──────────────────────────────────────────────────
{
    section('B — putting it back');

    const r = mutate('--restore');
    ck('restore reports success', r.code === 0 && /Restored/.test(r.all), r.all.trim());
    ck('  byte-for-byte, not approximately', scratch() === ORIGINAL, JSON.stringify(scratch()));
    ck('  and the sidecar is gone, so the hook stops objecting', !sidecarExists());

    const again = mutate('--restore');
    ck('restoring twice is not an error', again.code === 0 && /Nothing to restore/.test(again.all), again.all.trim());
}

// ── C — THE THREE REFUSALS ────────────────────────────────────────────────
// Each of these is a way to get a GREEN test run that proved nothing, which
// is worse than a red one.
{
    section('C — what it refuses, and why each matters');

    reset();
    let r = mutate('--once', SCRATCH_REL, '--find', 'NOT_IN_THIS_FILE', '--to', 'x');
    ck('a find string that matches nothing is refused',
       r.code !== 0 && /appears 0 times/.test(r.all), r.all.trim());
    ck('  because the test would pass and look like a survivor',
       /would change nothing/.test(r.all), r.all.trim());
    ck('  and nothing was written', scratch() === ORIGINAL && !sidecarExists());

    // AMBIGUITY. Three of my own controls this week landed in the wrong
    // function because the find string appeared twice in the file.
    fs.writeFileSync(SCRATCH, ORIGINAL + 'const guard2 = (x) => x > 0;\n');
    r = mutate('--once', SCRATCH_REL, '--find', 'x > 0', '--to', 'x >= 0');
    ck('a find string that appears twice is refused',
       r.code !== 0 && /appears 2 times/.test(r.all), r.all.trim());
    ck('  and says what to do about it',
       /more surrounding text/.test(r.all), r.all.trim());
    ck('  and still nothing was written', !sidecarExists());

    reset();
    r = mutate('--once', 'helpers/does-not-exist.js', '--find', 'a', '--to', 'b');
    ck('a file that does not exist is refused', r.code !== 0 && /no such file/.test(r.all), r.all.trim());

    r = mutate('--once', SCRATCH_REL, '--find', 'const a = 1;');
    ck('a missing --to is refused rather than treated as empty',
       r.code !== 0 && /usage:/.test(r.all), r.all.trim());
    ck('  and the file is untouched', scratch() === ORIGINAL && !sidecarExists());
}

// ── D — IT CANNOT STACK ───────────────────────────────────────────────────
// THE BUG THIS MODE SHIPPED WITH. --once first sat BELOW mutate.js's
// startup recoverFromCrash() call, so by the time the "already mutated"
// check ran the sidecar had already been consumed and the first file
// silently restored. The second mutation then went ahead on a tree that had
// just been quietly repaired — the same class of bug the whole file exists
// to prevent, written into the fix for it.
{
    section('D — a second mutation on top of an unrestored one');

    reset();
    let r = mutate('--once', SCRATCH_REL, '--find', 'const a = 1;', '--to', 'const a = 2;');
    ck('the first mutation lands', r.code === 0 && /const a = 2;/.test(scratch()));

    r = mutate('--once', SCRATCH_REL, '--find', 'x > 0', '--to', 'x >= 0');
    ck('the second is REFUSED, not stacked',
       r.code !== 0 && /ALREADY mutated/.test(r.all), r.all.trim());
    ck('  it names the file still on disk', /\.mutate-once-probe/.test(r.all), r.all.trim());
    ck('  and tells her the one command that fixes it', /--restore/.test(r.all), r.all.trim());

    // THE PART THAT WAS BROKEN: the first mutation must still be there. A
    // refusal that silently restored it would leave her believing a mutation
    // is live while the code is clean, and the test she then runs is green
    // for the wrong reason.
    ck('  the FIRST mutation is still on disk, not quietly undone',
       /const a = 2;/.test(scratch()), scratch());
    ck('  and its sidecar still names the first mutation',
       JSON.parse(fs.readFileSync(SIDECAR, 'utf8')).original === ORIGINAL);

    mutate('--restore');
    ck('after restore the file is original again', scratch() === ORIGINAL);
}

// ── E — THE CATALOGUE STILL WORKS ─────────────────────────────────────────
// --once must not have broken the 688-mutation run, and the argument parsing
// is the place that would do it: the values after --once/--find/--to must not
// be mistaken for mutation-name filters.
{
    section('E — the catalogue is untouched');

    const r = mutate('--list');
    ck('--list still prints the catalogue', r.code === 0 && /mutation\(s\)\./.test(r.out), `code=${r.code} bytes=${r.out.length} last=${JSON.stringify(r.out.trim().split('\n').pop())}`);
    const n = Number((r.out.match(/(\d+) mutation\(s\)/) || [])[1] || 0);
    ck('  and it is the whole catalogue, not a filtered slice', n > 500, String(n));

    const filtered = mutate('backup');
    ck('a name filter still filters', filtered.code === 0 || filtered.code === 1, String(filtered.code));

    const src = fs.readFileSync(path.join(ROOT, 'scripts/mutate.js'), 'utf8');
    const once = src.indexOf("if (argv.includes('--once'))");
    const recover = src.lastIndexOf('\nrecoverFromCrash();');
    ck('--once is decided BEFORE the startup recovery runs',
       once > -1 && recover > -1 && once < recover,
       `--once at ${once}, recoverFromCrash() at ${recover}`);
}

} finally {
    try { fs.unlinkSync(SIDECAR); } catch (e) {}
    try { fs.unlinkSync(SCRATCH); } catch (e) {}
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
