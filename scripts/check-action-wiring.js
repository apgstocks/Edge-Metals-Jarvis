#!/usr/bin/env node
// ── scripts/check-action-wiring.js ────────────────────────────────────────
// Fails if workflow/brain.js routes an intent to an action that
// workflow/actions.js does not export.
//
// Written 2026-08-22, the day this happened twice. Commit 7179955
// ("Emailwatcher") wrote workflow/actions.js back from an older copy and
// silently deleted eleven functions; commit 8dc3495 ("INV BY INV NO") did the
// same to helpers/invoiceSheet.js and deleted listAllInvoices. Nothing failed
// at boot. Nothing failed in a test. The first sign was Apsara asking Jarvis
// "any payments today?" and getting
// "Something broke while handling that: actions.showReceivables is not a
// function" — in a live WhatsApp thread, hours after the break.
//
// This is deliberately a plain string scan rather than anything clever: it
// has to work without loading a WhatsApp client or any config, so it can run
// in CI, in a pre-commit hook, or as `npm run check` on a laptop.
//
// Exit 0 = every routed action exists. Exit 1 = at least one is missing.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const brainSrc = fs.readFileSync(path.join(ROOT, 'workflow/brain.js'), 'utf8');
const actions = require(path.join(ROOT, 'workflow/actions.js'));

// Every `actions.someName(` in brain.js. Excludes 'js' so the literal string
// "actions.js" in a comment doesn't register as a call.
const routed = [...new Set(
    (brainSrc.match(/actions\.([a-zA-Z0-9_]+)\s*\(/g) || []).map((m) => m.slice(8, -1).trim()),
)].filter((n) => n !== 'js').sort();

const missing = routed.filter((n) => typeof actions[n] !== 'function');

// Line number for each missing one, so the report points at the route rather
// than making someone grep for it.
const lineOf = (name) => {
    const i = brainSrc.split('\n').findIndex((l) => l.includes(`actions.${name}(`));
    return i === -1 ? '?' : i + 1;
};

if (missing.length) {
    console.error(`\n✗ ${missing.length} intent(s) route to actions that do not exist:\n`);
    for (const n of missing) console.error(`    workflow/brain.js:${lineOf(n)}  ->  actions.${n}()  MISSING`);
    console.error(`\n  workflow/actions.js exports ${Object.keys(actions).length} function(s), none of them these.`);
    console.error('  A user hitting any of these intents gets an error instead of an answer.');
    console.error('  Usual cause: actions.js was written back from an older copy and lost code.\n');
    process.exit(1);
}

console.log(`✓ action wiring: all ${routed.length} routed actions exist`);
