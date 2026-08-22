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

// ── Pending-type wiring ──────────────────────────────────────────────────
// The check above only catches "brain routes to a missing export". It cannot
// see the OTHER shape of the same break, which happened on 2026-08-22:
// askForScaleTickets was deleted by an overwrite, so nothing ever created the
// 'await_quote_scale_tickets' pending — leaving resumeQuoteWithScaleTickets
// exported, routed, and permanently unreachable. Every check passed. Jarvis
// simply stopped asking about scale tickets, silently.
//
// A pending type is a contract between the two files:
//   actions.js  CREATES it via setPending({ type: '...' })
//   brain.js    RECOGNISES it and routes the answer somewhere
// If only one side knows about it, something is dead.
// Scanned repo-wide, NOT just actions.js: pendings are legitimately created
// from brain.js (await_bkg_no), scheduler.js (await_container_number),
// helpers/dailyLearning.js (await_fact_batch) and workflow/paymentWatcher.js
// (await_payment_confirm). A narrower scan reports all of those as orphans,
// and a check that cries wolf gets ignored — which is worse than no check.
function collectJs(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === 'tests') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) collectJs(full, out);
        else if (e.name.endsWith('.js')) out.push(full);
    }
    return out;
}
const created = new Set();
for (const file of collectJs(ROOT)) {
    const txt = fs.readFileSync(file, 'utf8');
    for (const m of txt.match(/type:\s*'(await_[a-z0-9_]+)'/g) || []) {
        created.add(m.replace(/.*'(await_[a-z0-9_]+)'.*/, '$1'));
    }
}
const recognised = new Set((brainSrc.match(/'(await_[a-z0-9_]+)'/g) || [])
    .map((m) => m.slice(1, -1)));

// Known-dead leftovers. Listed rather than silently filtered, so the finding
// is recorded instead of swept away — and so anything NEW showing up here
// still fails loudly.
//   await_followup_minutes — orphaned by commit 7179955 ("Emailwatcher"), the
//     same overwrite that deleted eleven functions. It now survives only as a
//     string inside pendingHint(), i.e. a hint for a pending nothing creates.
//     Cosmetic dead code, not a broken flow — unlike await_quote_scale_tickets
//     which was silently breaking a real question until 2026-08-22.
const KNOWN_DEAD = new Set(['await_followup_minutes']);
const orphanedResolvers = [...recognised].filter((t) => !created.has(t) && !KNOWN_DEAD.has(t)).sort();
const unhandledPendings = [...created].filter((t) => !recognised.has(t)).sort();

let pendingProblem = false;
if (orphanedResolvers.length) {
    pendingProblem = true;
    console.error(`\n✗ ${orphanedResolvers.length} pending type(s) that brain.js handles but nothing ever creates:\n`);
    for (const t of orphanedResolvers) console.error(`    ${t}  — the question is never asked, so this code is unreachable`);
    console.error('  Usual cause: the function that called setPending for it was deleted.');
}
if (unhandledPendings.length) {
    pendingProblem = true;
    console.error(`\n✗ ${unhandledPendings.length} pending type(s) created but never handled by brain.js:\n`);
    for (const t of unhandledPendings) console.error(`    ${t}  — a user answering this gets nowhere; the pending never resolves`);
}
if (pendingProblem) {
    console.error('');
    process.exit(1);
}

console.log(`✓ action wiring: all ${routed.length} routed actions exist`);
console.log(`✓ pending wiring: ${created.size} pending type(s) created, all handled`);
