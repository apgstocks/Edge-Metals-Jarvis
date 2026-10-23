// ── tests/mutation-audit.js — a ratchet on checks that prove nothing ──────
//
// Apsara, 2026-10-24: "Audit and make my jarvs better".
//
// ── WHY A RATCHET AND NOT A ZERO ─────────────────────────────────────────
// scripts/mutation-audit.js found 225 of 1,106 mutations NOT APPLIED — a
// fifth of the catalogue testing nothing. 125 were a mechanical re-point
// after the api.js and dashboard/index.html splits (#208/#209) and were
// fixed. 100 remain: 46 whose string now lives in both the website and the
// app so which one the check meant is a reading job, and 54 whose string is
// gone from the tree entirely because the code changed.
//
// Asserting zero today would make this file permanently red, and CLAUDE.md is
// explicit about what happens to a test that is always red: it "gets
// re-run, shrugged at, and eventually deleted". So the assertion is that the
// number DOES NOT GROW. It can only be lowered, and lowering it means editing
// the number below, which is a deliberate act with a diff attached.
//
// The second assertion is the one that actually protects the future: a
// mutation targeting a file that has been split is how 192 of the 225 died.
// Any NEW dead mutation means somebody moved code and left a check behind,
// which is exactly the mistake #209 was written about and did not catch.

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ma-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');

// ── THE BASELINES ────────────────────────────────────────────────────────
// Recorded 2026-10-24, after re-pointing 125. Lower them when you fix some;
// never raise one. Raising is the thing this file exists to prevent.
//
// The first draft of this file asserted ZERO for the last three and went red
// immediately — the same "always red, therefore eventually deleted" mistake
// the ratchet above was written to avoid, made two sections further down the
// same file. Measure first, then ratchet.
const BASELINE_DEAD = 100;
// Matching MORE than once is the same disease: scripts/mutate.js refuses an
// ambiguous find string, so those checks never run either. 7 of them, which
// makes the real count of checks proving nothing 107, not 100.
const BASELINE_AMBIGUOUS = 7;
// The two split files (#208/#209). 58 and 9 of the surviving dead still name
// them; those are the ones whose code now exists in BOTH the website and the
// app, or has gone entirely.
const BASELINE_BY_FILE = { 'dashboard/index.html': 58, 'api.js': 9 };

section('A. the audit runs at all, and runs nothing');
let data = null;
{
    let out = '';
    try {
        out = execFileSync(process.execPath,
            [path.join(ROOT, 'scripts/mutation-audit.js'), '--json'],
            { encoding: 'utf8', timeout: 90000 });
    } catch (e) {
        // exitCode is 1 whenever anything is dead, which is the normal state
        // today — so stdout is what matters, not the status.
        out = (e.stdout || '').toString();
    }
    try { data = JSON.parse(out.trim().split('\n').pop()); } catch (e) { data = null; }
    ck('the audit emits parseable JSON', !!data && typeof data.total === 'number',
       out.slice(0, 300));
    // If requiring scripts/mutate.js ever creeps back in, this file would
    // take minutes and mutate the tree. The first version of the audit did
    // exactly that.
    ck('  and it did not leave a mutation on disk',
       !fs.existsSync(path.join(ROOT, '.mutate-sidecar.json')),
       'a sidecar means code is mutated right now');
}

if (!data) {
    console.log('\n  ABORT  the audit produced nothing readable');
    process.exit(1);
}

section('B. the ratchet');
{
    ck(`NOT APPLIED (${data.dead}) is not above the recorded baseline (${BASELINE_DEAD})`,
       data.dead <= BASELINE_DEAD,
       `${data.dead} dead. If you moved code, re-point the checks that followed it. `
       + 'If you fixed some, lower BASELINE_DEAD in this file.');

    // Worth saying out loud when it happens, because the baseline is a
    // liability and nobody goes looking for one to reduce.
    if (data.dead < BASELINE_DEAD) {
        console.log(`  NOTE  ${BASELINE_DEAD - data.dead} fewer than the baseline — `
            + `lower BASELINE_DEAD to ${data.dead} in this file.`);
    }

    ck(`ambiguous (${data.ambiguous}) is not above its baseline (${BASELINE_AMBIGUOUS})`,
       data.ambiguous <= BASELINE_AMBIGUOUS,
       JSON.stringify(data.ambiguous_list || []).slice(0, 400));

    ck('  and the catalogue has not shrunk below 1000 mutations',
       data.total >= 1000, String(data.total));
}

section('C. the two split files, which caused 192 of the original 225');
{
    // 113 dead pointed at dashboard/index.html and 79 at api.js once those
    // were split into parts. Re-pointing took them to 58 and 9; the rest are
    // the website-or-app ambiguous ones and the ones whose code has gone.
    // A rise here means code moved again and its checks were left behind —
    // the #209 mistake repeating.
    const byFile = data.dead_by_file || {};
    for (const [f, allowed] of Object.entries(BASELINE_BY_FILE)) {
        const n = byFile[f] || 0;
        ck(`dead mutations naming the split-away ${f} (${n}) is not above ${allowed}`,
           n <= allowed,
           `${n} do. Code moved out of this file and its checks did not follow.`);
    }
}

section('D. the dead ones are grouped so they can be worked through');
{
    const accounted = (data.one_candidate || 0) + (data.several_candidates || 0)
        + (data.no_candidate || 0);
    ck('every dead mutation is classified', accounted === data.dead,
       `${accounted} classified vs ${data.dead} dead`);
    ck('  none is a straightforward one-candidate re-point any more',
       (data.one_candidate || 0) === 0,
       `${data.one_candidate} are mechanically fixable and should have been fixed`);
    console.log(`  (${data.several_candidates} need a website-or-app decision; `
        + `${data.no_candidate} have no matching code left at all)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:\n  ' + failures.join('\n  ')); process.exit(1); }
