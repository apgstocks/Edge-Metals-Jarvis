#!/usr/bin/env node
// ── scripts/gemini-model-report.js ────────────────────────────────────────
// #159: "the workhorse model is legacy — move the other 39 calls off
// gemini-2.5-flash-lite."
//
// Run this ON THE VM before changing anything, because the obvious fix is
// very likely a no-op there:
//
//   node scripts/gemini-model-report.js
//
// ── WHY THE OBVIOUS FIX DOES NOTHING ─────────────────────────────────────
// helpers/gemini.js's getModelName() is
//
//     loadSettings().gemini_model || cfg.GEMINI_MODEL
//
// and loadSettings() is loadJson(SETTINGS_FILE, {...defaults}) — which
// returns the FILE AS IT IS. It does not merge the defaults in. So far so
// good; a settings file with no gemini_model key would fall through to the
// config.
//
// But PUT /api/settings saves `{ ...loadSettings(), ...req.body }`. The first
// time anyone saved ANY setting — a team group id, an email bcc, the yard
// report addresses — the entire default object went to disk with it, and
// 'gemini-2.5-flash-lite' was frozen into data/settings.json. Every edit to
// config.js or to the GEMINI_MODEL env var since then has been ignored.
//
// On the repo's own data directory the key IS present, so this is not a
// theory about what might happen.
//
// ── WHAT IT DOES AND DOES NOT DO ─────────────────────────────────────────
// Read-only. It reports and exits; it does not write the settings file, and
// it does not change a model. Removing the pin is a one-line edit to a live
// data file on a production box, and whether to make it is Apsara's call —
// and so is whether the workhorse should move at all, since 38 callers across
// 25 files share it and several of them are unattended watchers.
//
// --json for the raw shape.

const path = require('path');
const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
const gemini = require(path.join(ROOT, 'helpers/gemini'));

const e = gemini.effectiveModels();

if (process.argv.includes('--json')) {
    console.log(JSON.stringify(e, null, 2));
    process.exit(0);
}

const row = (k, v, note) => console.log(`  ${k.padEnd(16)} ${String(v).padEnd(24)}${note || ''}`);

console.log('\nGEMINI MODELS, AS THIS SERVER WILL ACTUALLY USE THEM\n');
row('workhorse', e.workhorse, `from ${e.workhorseFrom}`);
row('smart', e.smart, 'config / GEMINI_MODEL_SMART');
row('vision', e.vision, 'GEMINI_VISION_MODEL');
row('vision fallback', e.visionFallback, 'used when the vision model 404s');

console.log(`\n  settings file: ${cfg.SETTINGS_FILE}`);

for (const line of gemini.modelReportLines().slice(1)) {
    console.log('\n  ' + line.replace(/^\[GEMINI\] /, ''));
}

if (e.workhorseFrom === 'settings') {
    console.log('\n  TO MAKE config.js THE AUTHORITY AGAIN, remove the gemini_model key from');
    console.log('  that file. It is a live data file on a production box — back it up first,');
    console.log('  and nothing here will do it for you.');
}

// ── WHAT SHARES THE WORKHORSE ────────────────────────────────────────────
// So the size of the decision is on screen next to it, rather than being
// something someone has to go and grep for.
console.log('\n  The workhorse is shared by every callGeminiJSON() caller — 38 calls across');
console.log('  25 files, including unattended ones: the claim-mail watcher, the inbox scan,');
console.log('  the nightly log digest. Moving it is a behaviour change everywhere at once.');
console.log('  The paths where being wrong costs money already run on the smart tier');
console.log('  (claims, QuickBooks, chat, payments) — see config.js.\n');
