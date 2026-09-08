#!/usr/bin/env node
// ── scripts/run-tests.js ──────────────────────────────────────────────────
// WHY THIS EXISTS, and it is not tidying.
//
// `npm test` was one long `&&` chain naming each suite by hand. Two things
// followed from that, both discovered on 2026-09-07 and both bad:
//
// 1. THE CHAIN STOPPED AT THE FIRST RED SUITE. tests/integration.js — the
//    second link — has been failing since 2026-08-26, when the prompt-
//    injection fence became a per-request nonce and two assertions were left
//    matching the old static delimiter. So for twelve days `npm test` ran
//    exactly two suites and then quit. Everything after it was unrun, and
//    nothing said so: the output ended with a failure that looked like ONE
//    problem rather than a curtain drawn over sixty others.
//
// 2. THE HAND-WRITTEN LIST DRIFTED. 23 suites — roughly 1,200 assertions,
//    including every proforma and voice suite written in the last week —
//    existed on disk and were named nowhere. They passed. Nobody ran them.
//
// So: no list, and no early exit. Every file in tests/ runs, each in its own
// process, each with a timeout, and the summary comes at the END where it can
// be read. A red suite is reported and the run continues, because "what else
// is broken" is the question you actually have when something breaks.
//
// EXIT CODE IS STILL NON-ZERO IF ANYTHING FAILED. This makes the output
// honest, not lenient.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'tests');

// ── AUDITS, NOT ASSERTION SUITES ─────────────────────────────────────────
// These two print a REPORT and exit 0; they have no "N passed, M failed"
// line. The runner treated a missing totals line as a crash, so they were
// excluded and labelled "slow" — which was not the real reason, since they
// take under a second each. The effect was that I told her "run test:full for
// those" all day and never ran them myself.
//
// They are in the normal run now, judged on their EXIT CODE, which is what
// they actually communicate with. Worth it immediately: trap-audit reports a
// real hole — await_relay_reply swallowing new questions as answers — that
// nothing else in the suite knows about.
const REPORT_ONLY = new Set(['arbiter-live.js', 'trap-audit.js']);

const PER_SUITE_MS = Number(process.env.TEST_TIMEOUT_MS || 180000);
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));

const files = fs.readdirSync(DIR)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => !only.length || only.some((o) => f.includes(o)))
    .sort();

const results = [];
let totalPass = 0, totalFail = 0;

for (const f of files) {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [path.join(DIR, f)], {
        cwd: ROOT,
        timeout: PER_SUITE_MS,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: Object.assign({}, process.env, { JARVIS_TEST: '1' }),
    });
    const out = (r.stdout || '') + (r.stderr || '');
    const secs = ((Date.now() - t0) / 1000).toFixed(1);

    // The totals line every suite prints. Taken from the END, because several
    // suites print per-section counts on the way through.
    const m = [...out.matchAll(/(\d+) passed, (\d+) failed/g)].pop();
    const pass = m ? Number(m[1]) : 0;
    const failed = m ? Number(m[2]) : 0;

    // NO TOTALS is its own failure, not a pass. A suite that crashes before
    // printing looks identical to one that was never written, and several of
    // my own mutations this week died by crashing — which would have read as
    // green under a runner that only looked for the word "FAIL".
    // An audit has no totals by design; only its exit code means anything.
    const crashed = !m && !REPORT_ONLY.has(f);
    const timedOut = r.error && r.error.code === 'ETIMEDOUT';
    const bad = crashed || failed > 0 || (r.status !== 0 && !failed);
    if (REPORT_ONLY.has(f) && !bad && !m) {
        // Its findings are the point, and a clean exit does not mean it found
        // nothing worth reading.
        const note = out.split('\n').filter((l) => /swallows:|DANGEROUS|opportunity/.test(l))[0];
        if (note) console.log(`${' '.repeat(34)}${note.trim().slice(0, 88)}`);
    }

    totalPass += pass; totalFail += failed;
    results.push({ f, pass, failed, secs, crashed, timedOut, bad, out });

    const state = timedOut ? `TIMED OUT after ${PER_SUITE_MS / 1000}s`
        : crashed ? 'CRASHED — no totals printed'
        : failed ? `${pass} passed, ${failed} FAILED`
        : (REPORT_ONLY.has(f) && !m) ? 'audit clean (report only)'
        : `${pass} passed`;
    console.log(`${bad ? '✗' : '·'} ${f.padEnd(30)} ${state.padEnd(32)} ${secs}s`);
}

const broken = results.filter((r) => r.bad);
if (broken.length) {
    console.log('\n' + '─'.repeat(72));
    for (const b of broken) {
        console.log(`\n── ${b.f} ──`);
        if (b.crashed) {
            // The tail, not the head: a crash message is at the bottom.
            console.log(b.out.split('\n').slice(-25).join('\n'));
        } else {
            const lines = b.out.split('\n');
            lines.forEach((l, i) => {
                if (/^\s*FAIL\s/.test(l) || /^\s+FAIL\s/.test(l)) {
                    console.log(l);
                    // The `extra` line the ck() helpers print underneath is
                    // where the reason lives, and it is the only part worth
                    // reading when sixty suites just ran.
                    for (let k = 1; k <= 2; k++) {
                        const nx = lines[i + k];
                        if (nx && /^\s{6,}\S/.test(nx) && !/PASS|FAIL/.test(nx)) console.log(nx);
                    }
                }
            });
        }
    }
}

console.log('\n' + '─'.repeat(72));
console.log(`${files.length} suites · ${totalPass} assertions passed · ${totalFail} failed`
    + (broken.length ? ` · ${broken.length} suite(s) red` : ' · all green'));
process.exit(broken.length ? 1 : 0);
