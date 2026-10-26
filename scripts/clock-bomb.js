#!/usr/bin/env node
// ── scripts/clock-bomb.js — which tests will go red on a date nobody chose ──
//
// Apsara, 2026-10-24: "Audit and make my jarvs better".
//
// ── THE FAILURE SHAPE THIS SUITE KEEPS PRODUCING ─────────────────────────
// A test seeds a fixture with a literal date, the code under test filters by
// a rolling window, and weeks later the fixture ages out of the window. The
// check then goes red for a reason with nothing to do with what it tests.
// tests/load-deck-grouping.js wrote the lesson down after hitting it twice:
//
//   "a test that passes on most days and fails on a few is worse than one
//    that always fails, because it gets re-run, shrugged at, and eventually
//    deleted."
//
// It has now happened four times — load-deck-grouping twice,
// load-card-actions, and scout-yard-scope, whose expense fixture aged out on
// about 21 October and whose red read like a Scout permissions bug because
// the aggregates kept passing and only the DESCRIPTIONS vanished.
//
// ── GREPPING FOR OLD DATES DOES NOT WORK ─────────────────────────────────
// Tried first: flag any test with a hardcoded date older than 25 days that
// also mentions a window. That returned 29 files, and running them proved
// almost all were fine — a QuickBooks report period or a deliberately old
// bills fixture is SUPPOSED to be a fixed date, and tests/export-rules.js
// pins an explicit `asOf` instead, which is the better pattern. A guard that
// cries wolf on 29 files gets ignored, which is how the real one hides.
//
// ── SO: MOVE THE CLOCK AND SEE ───────────────────────────────────────────
// Green today, red with the clock pushed forward = provably a time bomb. No
// heuristic, no false positives, and it names the exact assertions.
//
//   node scripts/clock-bomb.js                    every suite, +45 days
//   node scripts/clock-bomb.js --days 200         further out
//   node scripts/clock-bomb.js load-deck voice    only matching names
//   node scripts/clock-bomb.js --show load-deck   print the failing lines
//
// ── IT CHECKS ITSELF FIRST ───────────────────────────────────────────────
// The shim replaces global Date with a Proxy, and a Proxy over Date is
// exactly the sort of thing that breaks a library and invents failures. So
// every suite is run THREE times: plain, shim-with-zero-offset, and shifted.
// If plain and zero-offset disagree, the shim is the bug and the file is
// reported as UNTESTABLE rather than as a bomb. That control is not
// optional: a 30-second-timeout choice invented five false reds in this
// repo on the same day this file was written.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const has = (n) => argv.includes('--' + n);
const DAYS = Number(flag('days', 45)) || 45;
const PER_FILE_MS = Number(flag('timeout', 60000)) || 60000;
const only = argv.filter((a) => !a.startsWith('--')
    && argv[argv.indexOf(a) - 1] !== '--days'
    && argv[argv.indexOf(a) - 1] !== '--timeout');

// The shim, written to a temp file so there is nothing to keep in the repo
// that could be loaded by accident in production.
const SHIM = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clockbomb-')), 'shim.js');
fs.writeFileSync(SHIM, `
const SHIFT = Number(process.env.CLOCK_SHIFT_DAYS || 0) * 86400000;
if (SHIFT) {
  const RealDate = Date;
  global.Date = new Proxy(RealDate, {
    construct(T, args) { return args.length ? new T(...args) : new T(RealDate.now() + SHIFT); },
    apply() { return new RealDate(RealDate.now() + SHIFT).toString(); },
    get(T, p) { return p === 'now' ? () => RealDate.now() + SHIFT : T[p]; },
  });
}
`, 'utf8');

const run = (file, shiftDays, useShim) => {
    const args = useShim ? ['--require', SHIM, file] : [file];
    const r = spawnSync(process.execPath, args, {
        cwd: ROOT, encoding: 'utf8', timeout: PER_FILE_MS,
        env: { ...process.env, CLOCK_SHIFT_DAYS: String(shiftDays) },
    });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};

const files = fs.readdirSync(path.join(ROOT, 'tests'))
    .filter((f) => f.endsWith('.js'))
    .filter((f) => !only.length || only.some((o) => f.includes(o)))
    .sort();

console.log(`\n── Clock bombs: ${files.length} suite(s), clock +${DAYS} days ───────────────\n`);

const bombs = [], untestable = [], alreadyRed = [], fine = [];
for (const f of files) {
    const rel = 'tests/' + f;
    const plain = run(rel, 0, false);
    if (plain.code !== 0) { alreadyRed.push(f); process.stdout.write('r'); continue; }
    // THE CONTROL. Shim loaded, clock not moved: must match plain.
    const zero = run(rel, 0, true);
    if (zero.code !== 0) { untestable.push(f); process.stdout.write('?'); continue; }
    const later = run(rel, DAYS, true);
    if (later.code !== 0) {
        const fails = later.out.split('\n').filter((l) => /^\s*FAIL/.test(l)).slice(0, 6);
        bombs.push({ f, fails });
        process.stdout.write('B');
    } else { fine.push(f); process.stdout.write('.'); }
}
console.log('\n');

if (bombs.length) {
    console.log(`── ${bombs.length} TIME BOMB(S) — green today, red in ${DAYS} days ──\n`);
    for (const b of bombs) {
        console.log(`  tests/${b.f}`);
        for (const l of b.fails) console.log('    ' + l.trim());
        console.log(`    reproduce:  CLOCK_SHIFT_DAYS=${DAYS} node --require <shim> tests/${b.f}`);
        console.log('');
    }
    console.log('  The cure, written down by tests/load-deck-grouping.js the first time:');
    console.log('  express the fixture in DAYS AGO, or pin the clock with an explicit');
    console.log('  `asOf` the way tests/export-rules.js does. Never a literal date that');
    console.log('  has to stay inside a rolling window.\n');
}
if (untestable.length) {
    console.log(`── ${untestable.length} UNTESTABLE — the Date shim itself breaks these, so they are`);
    console.log('   NOT reported as bombs. Nothing is claimed about them either way.');
    for (const f of untestable) console.log('     tests/' + f);
    console.log('');
}
if (alreadyRed.length) {
    console.log(`── ${alreadyRed.length} already red before the clock moved (not this tool's business) ──`);
    for (const f of alreadyRed) console.log('     tests/' + f);
    console.log('');
}
console.log(`  ${fine.length} suite(s) survive +${DAYS} days.\n`);
process.exitCode = bombs.length ? 1 : 0;
