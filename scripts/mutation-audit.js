#!/usr/bin/env node
// ── scripts/mutation-audit.js — which checks prove nothing ─────────────────
//
// Apsara, 2026-10-24: "Audit and make my jarvs better".
//
// ── WHAT THIS FOUND, AND WHY IT HAD TO EXIST ─────────────────────────────
// Task #204 recorded "Three mutations are NOT APPLIED". The real number was
// 225 of 1,106 — a fifth of the mutation catalogue was decoration. 113 of
// them still pointed at dashboard/index.html and 79 at api.js, both of which
// were SPLIT into parts (#208/#209). The re-pointing then was incomplete, and
// nothing noticed, because NOT APPLIED is reported at the end of a long run
// and does not make anything red.
//
// A mutation whose `find` string no longer exists in its file changes nothing
// when applied, so the suite it names "passes" without being exercised at
// all. That is worse than a missing test: it is a missing test with a green
// tick next to it. The concentration was in the voice/assistant path
// (follow-up, forward, veto, retract, offer, order) — which CLAUDE.md names
// twice as the caller that always breaks.
//
// ── IT RUNS NO SUITES AND MUTATES NOTHING ────────────────────────────────
// Pure text. It reads scripts/mutate.js, pulls out every { name, file, find }
// and asks one question of each: does that string still appear, exactly once,
// in that file? Seconds, not the half hour a real mutation pass takes — so
// there is no excuse for not knowing.
//
//   node scripts/mutation-audit.js            the counts, and the dead list
//   node scripts/mutation-audit.js --json     for tests/mutation-audit.js
//   node scripts/mutation-audit.js --suggest  where a dead one should move to
//
// DELIBERATELY DOES NOT EDIT scripts/mutate.js. Re-pointing a mutation is a
// claim that the check still tests what its name says, and that is a reading
// job. An auto-fixer would quietly re-point a check at code that merely looks
// similar, which is how a check ends up shaped like the code instead of like
// the property.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CATALOGUE = path.join(ROOT, 'scripts', 'mutate.js');

// Files a mutation could legitimately target. scripts/mutate.js is excluded
// because it contains every find string as DATA — include it and every
// mutation looks alive. The android assets tree is excluded because it is a
// build copy of mobile-app/www; a find string there is the same code twice,
// and pointing a mutation at a build artefact is pointing it at something
// `ship.sh` regenerates.
const SKIP = /^(scripts\/mutate\.js$|mobile-app\/android\/|node_modules\/)/;
const SKIP_DIR = /^(node_modules|\.git|data|builds|seeds|Claude outputs)$/;

function sourceFiles() {
    const out = [];
    (function walk(dir, rel) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (SKIP_DIR.test(e.name)) continue;
            const abs = path.join(dir, e.name);
            const r = rel ? rel + '/' + e.name : e.name;
            if (e.isDirectory()) { if (!SKIP.test(r + '/')) walk(abs, r); }
            else if (/\.(js|html)$/.test(e.name) && !SKIP.test(r)) out.push(r);
        }
    })(ROOT, '');
    return out;
}

// Parsed rather than required: requiring scripts/mutate.js RUNS the harness.
// Found the hard way — the first version of this audit hung for two minutes
// because `require` started mutating files and executing suites.
function catalogue() {
    const src = fs.readFileSync(CATALOGUE, 'utf8');
    const re = /name:\s*'((?:[^'\\]|\\.)*)'[\s\S]{0,400}?file:\s*'([^']+)'[\s\S]{0,400}?find:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;
    const out = [];
    let m;
    while ((m = re.exec(src))) {
        let find;
        // eslint-disable-next-line no-eval
        try { find = eval(m[3]); } catch (e) { continue; }
        if (typeof find !== 'string' || !find.length) continue;
        out.push({ name: m[1].replace(/\\'/g, "'"), file: m[2], find });
    }
    return out;
}

function audit() {
    const mutations = catalogue();
    const files = sourceFiles();
    const body = {};
    for (const f of files) { try { body[f] = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (e) { /* */ } }

    const dead = [], ambiguous = [], live = [];
    for (const m of mutations) {
        const b = body[m.file];
        const n = b === undefined ? 0 : b.split(m.find).length - 1;
        if (n === 1) live.push(m);
        else if (n === 0) dead.push(m);
        else ambiguous.push({ ...m, times: n });
    }
    return { mutations, files, body, dead, ambiguous, live };
}

// Where a dead mutation's string lives NOW. A single candidate is a probable
// move from one of the splits; several means the code exists in the website
// and the app both, and which one the check was about is a reading job.
function suggest(a) {
    return a.dead.map((m) => {
        const hits = a.files.filter((f) => a.body[f].split(m.find).length - 1 === 1);
        return { ...m, candidates: hits };
    });
}

const a = audit();
const argv = process.argv.slice(2);

if (argv.includes('--json')) {
    const s = suggest(a);
    console.log(JSON.stringify({
        total: a.mutations.length,
        live: a.live.length,
        dead: a.dead.length,
        ambiguous: a.ambiguous.length,
        dead_by_file: a.dead.reduce((o, m) => { o[m.file] = (o[m.file] || 0) + 1; return o; }, {}),
        one_candidate: s.filter((x) => x.candidates.length === 1).length,
        several_candidates: s.filter((x) => x.candidates.length > 1).length,
        no_candidate: s.filter((x) => x.candidates.length === 0).length,
        dead_list: a.dead.map((m) => ({ name: m.name, file: m.file })),
        ambiguous_list: a.ambiguous.map((m) => ({ name: m.name, file: m.file, times: m.times })),
    }));
    process.exit(0);
}

const pct = (n) => (a.mutations.length ? (100 * n / a.mutations.length).toFixed(1) : '0') + '%';
console.log('\n── Mutation catalogue audit ─────────────────────────────────────');
console.log(`\n  ${a.mutations.length} mutations`);
console.log(`  ${a.live.length} apply cleanly            (${pct(a.live.length)})`);
console.log(`  ${a.dead.length} NOT APPLIED              (${pct(a.dead.length)})  <- these prove NOTHING`);
console.log(`  ${a.ambiguous.length} match more than once      (${pct(a.ambiguous.length)})  <- the harness refuses these`);

if (a.dead.length) {
    const byFile = a.dead.reduce((o, m) => { o[m.file] = (o[m.file] || 0) + 1; return o; }, {});
    console.log('\n  Dead mutations by the file they still point at:');
    for (const [f, n] of Object.entries(byFile).sort((x, y) => y[1] - x[1])) {
        console.log(`    ${String(n).padStart(4)}  ${f}`);
    }
}

if (argv.includes('--suggest') && a.dead.length) {
    const s = suggest(a);
    const one = s.filter((x) => x.candidates.length === 1);
    const many = s.filter((x) => x.candidates.length > 1);
    const none = s.filter((x) => x.candidates.length === 0);
    console.log(`\n  ── ${one.length} with ONE candidate home (probably a split) ──`);
    for (const m of one) console.log(`    ${m.name}\n        ${m.file}  ->  ${m.candidates[0]}`);
    console.log(`\n  ── ${many.length} with SEVERAL (website and app both — read it) ──`);
    for (const m of many) console.log(`    ${m.name}\n        -> ${m.candidates.join(' , ')}`);
    console.log(`\n  ── ${none.length} whose string is GONE from the tree ──`);
    console.log('     The code changed. Rewrite the check against the property, or delete it.');
    for (const m of none) console.log(`    [${m.file}] ${m.name}`);
}

if (a.ambiguous.length) {
    console.log('\n  ── matches more than once ──');
    for (const m of a.ambiguous) console.log(`    [${m.file}] ${m.name}  (${m.times}x)`);
}

console.log('\n  A mutation whose find string is gone changes nothing when applied, so');
console.log('  the suite it names passes WITHOUT BEING EXERCISED. That is a missing');
console.log('  test with a green tick next to it.\n');

process.exitCode = (a.dead.length || a.ambiguous.length) ? 1 : 0;
