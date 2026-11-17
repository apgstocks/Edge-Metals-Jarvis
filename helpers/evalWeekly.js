// ── helpers/evalWeekly.js — one line a week: how many of Jarvis's calls she marked right ──────────
// Apsara, 2026-11-15: "ok" to a weekly READ-ONLY score of scripts/evalset.js (stage 4 of
// claude/jarvis-learning-plan-for-approval.md).
//
// READ-ONLY ON PURPOSE. scripts/evalset.js in BUILD mode overwrites data/evalset.txt, which is where her ok/wrong
// marks live, so this never runs build mode. It runs `--score`, which only reads. No model calls, no cost.
// SPEAKS ONLY WHEN SOMETHING CHANGED: the numbers differ from the last one sent, and at least one example is marked.
// A blank file, or the same marks as last week, produces silence rather than a nag.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const cfg = require('../config');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'evalset.js');
const file = () => path.join(cfg.DATA_DIR, 'evalset.txt');
const stateFile = () => path.join(cfg.DATA_DIR, 'evalweekly.json');

function parse(out) {
    const m = /EVAL SET — (\d+) examples, (\d+) adjudicated, (\d+) still blank/.exec(out);
    if (!m) return null;
    const ok = Number((/CORRECT\s+(\d+)/.exec(out) || [])[1] || 0);
    const bad = Number((/WRONG\s+(\d+)/.exec(out) || [])[1] || 0);
    return { examples: +m[1], scored: +m[2], blank: +m[3], ok, bad };
}

function runScore() {
    return new Promise((resolve) => {
        if (!fs.existsSync(file())) return resolve(null);
        execFile(process.execPath, [SCRIPT, '--score', '--out', file()], { timeout: 30000 }, (err, stdout) => resolve(err ? null : parse(String(stdout))));
    });
}

/** @returns {Promise<string|null>} the one line to send, or null for silence */
async function weeklyLine() {
    const r = await runScore();
    if (!r || !r.scored) return null;
    const pct = Math.round((r.ok / r.scored) * 100);
    const line = `Jarvis self-check: ${r.ok} of ${r.scored} marked right (${pct}%)` + (r.blank ? `, ${r.blank} still unmarked` : '')
        + (r.scored < 30 ? '. Under 30 marked, so treat it as a smoke test.' : '.');
    let last = null;
    try { last = JSON.parse(fs.readFileSync(stateFile(), 'utf8')).line; } catch (e) { /* first time */ }
    if (last === line) return null;
    try { fs.writeFileSync(stateFile(), JSON.stringify({ line, at: new Date().toISOString() })); } catch (e) { console.error('[EVALWEEKLY] state not saved:', e.message); }
    return line;
}

module.exports = { weeklyLine, parse };
