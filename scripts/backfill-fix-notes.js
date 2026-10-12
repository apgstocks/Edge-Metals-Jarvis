#!/usr/bin/env node
// ── scripts/backfill-fix-notes.js — make old fixes rememberable ─────────────
// Apsara, 2026-10-12: Bugzilla is now Jarvis's memory of what worked, but only
// items with a fix note count. Items filed by scripts/file-bugs-*.js were
// created as "fixed" with the fix written inside `detail` ("FIXED ad4c44d: ...")
// and fix_note empty, so none of them are remembered.
//
// This lifts that text into fix_note (and the commit hash into commit). It
// invents nothing: it copies the sentence(s) after the word FIXED, up to the
// next blank line, and leaves every item it cannot read for her to write.
//
//   node scripts/backfill-fix-notes.js           # show what it would do
//   node scripts/backfill-fix-notes.js --write   # do it
// Runs where data/bugs.json lives (the VM). Safe to run twice.
const fs = require('fs');
const WRITE = process.argv.includes('--write');
const cfg = require('../config');
const { mutateJson, loadJson } = require('../helpers/json');
const MIN = 15;

function lift(detail) {
    const m = /\bFIXED\b(?:\s+([0-9a-f]{7,40}))?\s*[:\-–—]?\s*([\s\S]*?)(?:\n\s*\n|$)/.exec(String(detail || ''));
    if (!m) return null;
    const note = m[2].replace(/\s+/g, ' ').trim();
    return note.length >= MIN ? { note: note.slice(0, 400), commit: m[1] || null } : null;
}
module.exports = { lift };
if (require.main !== module) return;

(async () => {
    if (!fs.existsSync(cfg.BUGS_FILE)) { console.log(`No bug list at ${cfg.BUGS_FILE} — run this on the VM.`); return; }
    const rows = loadJson(cfg.BUGS_FILE, []);
    const todo = rows.filter((b) => b && (b.status === 'fixed' || b.status === 'verified') && !String(b.fix_note || '').trim());
    const plan = todo.map((b) => ({ b, got: lift(b.detail) }));
    console.log(`${todo.length} fixed/verified item(s) have no fix note.\n`);
    for (const { b, got } of plan) {
        console.log(got ? `  can fill  ${b.id}  ${b.title.slice(0, 70)}\n            -> ${got.note.slice(0, 110)}${got.commit ? `  (commit ${got.commit})` : ''}`
                        : `  YOU write ${b.id}  ${b.title.slice(0, 70)}`);
    }
    if (!WRITE) { console.log('\nDry run. Re-run with --write to fill the "can fill" ones.'); return; }
    let n = 0;
    await mutateJson(cfg.BUGS_FILE, [], (all) => {
        for (const x of all) {
            const hit = plan.find((p) => p.b.id === x.id && p.got);
            if (!hit || String(x.fix_note || '').trim()) continue;
            x.fix_note = hit.got.note; if (hit.got.commit && !x.commit) x.commit = hit.got.commit;
            x.history = Array.isArray(x.history) ? x.history : [];
            x.history.push({ at: new Date().toISOString(), by: 'backfill', what: 'fix note copied from the description', note: hit.got.note });
            n++;
        }
        return all;
    }, { strict: true });
    console.log(`\nFilled ${n}. The rest need a note from you (Bugzilla tab, or PATCH /api/bugs/:id).`);
})().catch((e) => { console.error(e.message); process.exit(1); });
