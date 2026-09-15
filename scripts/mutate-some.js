#!/usr/bin/env node
// ── scripts/mutate-some.js — run PART of the catalogue, safely ───────────
// scripts/mutate.js runs all ~300 mutations and has two rough edges that bit
// three times on 2026-09-11:
//
//   1. NO WAY TO RUN A SUBSET. Checking the six mutations you just wrote means
//      waiting for every other one, and a long run gets interrupted.
//   2. AN INTERRUPTED RUN LEAVES THE TREE MUTATED. It writes the mutant to the
//      real file and restores afterwards; kill it in between and the mutation
//      stays, silently. It happened twice in one afternoon — once leaving a
//      broken guard in helpers/followUp.js, once deleting a header column from
//      dashboard/index.html — and both times the next thing to fail was
//      something unrelated, which is the expensive way to find out.
//
// So: a name filter, and the original restored from a `finally` AND from the
// exit/SIGINT/SIGTERM handlers. The tree cannot be left dirty by stopping it.
//
//   node scripts/mutate-some.js '^storage:'
//
// Each mutation runs only the suites IT names, not a suite passed in — a
// mutation checked against the wrong suite reports a meaningless survivor.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'scripts/mutate.js'), 'utf8');
const arr = src.slice(src.indexOf('const MUTATIONS = ['), src.lastIndexOf('\n];') + 3);
const ALL = eval('(' + arr.replace('const MUTATIONS =', '').replace(/;\s*$/, '') + ')');

const pattern = process.argv[2];
if (!pattern) {
    console.error('usage: node scripts/mutate-some.js <regex over mutation names>');
    process.exit(2);
}
const MUT = ALL.filter((m) => new RegExp(pattern).test(m.name));
if (!MUT.length) { console.error(`no mutation matches ${pattern}`); process.exit(2); }

// The file currently mutated, if any. Restored from three places so that
// neither an exception nor a signal can leave it behind.
let inflight = null;
const restore = () => {
    if (!inflight) return;
    fs.writeFileSync(inflight.file, inflight.original);
    console.log(`  [restored ${path.relative(ROOT, inflight.file)}]`);
    inflight = null;
};
process.on('exit', restore);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { restore(); process.exit(130); });
}

const runSuite = (suite) => {
    try {
        execFileSync('node', [path.join(ROOT, 'tests', `${suite}.js`)],
                     { stdio: 'pipe', env: { ...process.env, JARVIS_TEST: '1' } });
        return 0;
    } catch (e) { return 1; }
};

// BASELINE GREEN IS A PRECONDITION. A red suite kills every mutation for the
// wrong reason and reports a clean sheet.
for (const suite of new Set(MUT.flatMap((m) => m.suites))) {
    if (runSuite(suite) !== 0) {
        console.error(`BASELINE RED in tests/${suite}.js — fix that first`);
        process.exit(1);
    }
}
console.log(`baseline green — ${MUT.length} mutation${MUT.length === 1 ? '' : 's'}\n`);

const survivors = [];
for (const m of MUT) {
    const file = path.join(ROOT, m.file);
    const original = fs.readFileSync(file, 'utf8');
    if (!original.includes(m.find)) {
        console.log(`  ??? NOT FOUND  ${m.name}`);
        survivors.push(`${m.name} (its find string is no longer in ${m.file})`);
        continue;
    }
    try {
        inflight = { file, original };
        fs.writeFileSync(file, original.replace(m.find, m.to));
        const killed = m.suites.some((s) => runSuite(s) !== 0);
        console.log(`  ${killed ? 'killed   ' : 'SURVIVED '} ${m.name}`);
        if (!killed) survivors.push(m.name);
    } finally {
        fs.writeFileSync(file, original);
        inflight = null;
    }
}

console.log(survivors.length
    ? `\n${survivors.length} SURVIVOR(S):\n` + survivors.map((s) => '  · ' + s).join('\n')
    : '\nall killed');
process.exit(survivors.length ? 1 : 0);
