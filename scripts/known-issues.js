#!/usr/bin/env node
// ── scripts/known-issues.js — has this happened before? ─────────────────────
// Apsara, 2026-10-12: resolved issues should be remembered so nobody repeats
// the investigation. Searches Bugzilla's resolved items (with a fix note) for
// ones that look like the text given. Read-only.
//
//   node scripts/known-issues.js "invoice shows blank container number"
//   node scripts/known-issues.js "..." --file /path/to/bugs.json
//
// Runs where data/bugs.json lives (the VM). Elsewhere it finds nothing, and
// says so rather than implying the problem is new.
const fs = require('fs');
const args = process.argv.slice(2);
const fi = args.indexOf('--file');
if (fi >= 0) { process.env.DATA_DIR = require('path').dirname(require('path').resolve(args[fi + 1])); args.splice(fi, 2); }
const text = args.join(' ').trim();
if (!text) { console.error('usage: node scripts/known-issues.js "what went wrong" [--file bugs.json]'); process.exit(2); }
const cfg = require('../config');
if (!fs.existsSync(cfg.BUGS_FILE)) {
    console.log(`No bug list at ${cfg.BUGS_FILE} — this machine has no history, so "nothing found" would mean nothing. Run it on the VM.`);
    process.exit(0);
}
const m = require('../helpers/bugs').findSimilar(text, { limit: 5 });
if (!m.length) { console.log('Nothing resolved looks like this. Treat it as new.'); process.exit(0); }
for (const k of m) {
    console.log(`${k.id}  [${k.status}${k.verified ? ', checked by Apsara' : ', not yet checked'}]  match ${k.score}`);
    console.log(`  ${k.title}`);
    if (k.cause) console.log(`  cause: ${k.cause}`);
    console.log(`  fix:   ${k.fix_note}`);
    if (k.commit) console.log(`  commit: ${k.commit}`);
    console.log('');
}
