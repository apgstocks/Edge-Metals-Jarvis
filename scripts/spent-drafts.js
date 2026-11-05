#!/usr/bin/env node
// ── scripts/spent-drafts.js ───────────────────────────────────────────────
//
// Apsara, 2026-11-05: "as soon as it is created,it is appearing in purchase".
//
// The cause is fixed (e8710dc — both create routes now delete the draft once
// the load is committed), but every draft ALREADY spent is still sitting in
// load_drafts.json on the VM. Until they go, the strip above the deck keeps
// showing loads she saved weeks ago as "Unfinished — not saved as loads yet",
// and the symptom she reported looks unfixed.
//
// ── WHY THIS REPORTS BEFORE IT REMOVES ────────────────────────────────────
// Her drafts live on the VM, not in this checkout, so there is no way to see
// what is actually in there from here. And a draft is the ONLY copy of work
// she has not finished: deleting a live one loses a load she was part way
// through typing, with no undo. So the default is a report, --apply is
// opt-in, and the rule for what may go is deliberately narrow.
//
// ── THE RULE: A DRAFT IS SPENT ONLY IF ITS LOAD EXISTS ────────────────────
// Not "is old". Not "looks finished". A draft goes only when some load —
// purchase or sale — carries that draft's id in its own draft_id field. That
// is the same link oncePerSave uses to refuse a second load from one draft,
// so this script and that guard agree by construction rather than by
// coincidence.
//
// Anything else is LEFT ALONE and counted: a draft with no load is work in
// progress, which is the thing this file must never eat.
const path = require('path');
const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const fileArg = (() => {
    const i = args.indexOf('--file');
    return i >= 0 ? args[i + 1] : null;
})();
if (fileArg) cfg.LOAD_DRAFTS_FILE = path.resolve(fileArg);

const { listDrafts, deleteDraft } = require(path.join(ROOT, 'helpers/loadDrafts'));
const { loadLoads } = require(path.join(ROOT, 'helpers/loads'));
const { loadOutboundLoads } = require(path.join(ROOT, 'helpers/outboundLoads'));

function main() {
    const drafts = listDrafts() || [];
    if (!drafts.length) {
        console.log('No drafts at all. Nothing to do.');
        return;
    }

    // Every draft_id any load claims. normDraftId is what wrote them, so read
    // them raw and compare as strings — a mismatch here would make a spent
    // draft look live, which errs the safe way round.
    const claimed = new Map();
    const note = (l, kind) => {
        const id = l && l.draft_id ? String(l.draft_id) : '';
        if (id) claimed.set(id, { load: l.id, kind, who: l.seller || l.buyer || '', date: l.date || '' });
    };
    (loadLoads() || []).forEach((l) => note(l, 'purchase'));
    (loadOutboundLoads() || []).forEach((l) => note(l, 'sale'));

    const spent = [];
    const live = [];
    for (const d of drafts) {
        const hit = claimed.get(String(d.id));
        (hit ? spent : live).push({ d, hit });
    }

    const when = (d) => (d.updated_at ? String(d.updated_at).slice(0, 16).replace('T', ' ') : '—');
    const name = (d) => String(d.seller || '(unnamed)').slice(0, 24).padEnd(24);

    console.log(`\nload_drafts.json: ${drafts.length} draft(s)\n`);

    console.log(`SPENT — the load exists, so these are not unfinished (${spent.length}):`);
    if (!spent.length) console.log('  (none)');
    for (const { d, hit } of spent) {
        console.log(`  ${name(d)} ${String(d.kind || 'purchase').padEnd(8)} ${when(d)}  ->  ${hit.kind} ${hit.load}`);
    }

    console.log(`\nLIVE — no load carries these, so they are real unfinished work (${live.length}):`);
    if (!live.length) console.log('  (none)');
    for (const { d } of live) {
        const items = Array.isArray(d.items) ? d.items.length : 0;
        console.log(`  ${name(d)} ${String(d.kind || 'purchase').padEnd(8)} ${when(d)}  ${items} item(s)  KEPT`);
    }

    if (!APPLY) {
        console.log(`\nNothing was changed. Re-run with --apply to delete the ${spent.length} spent draft(s).`);
        console.log('The LIVE ones are never touched, with or without --apply.');
        return;
    }
    if (!spent.length) {
        console.log('\n--apply given, but there is nothing spent to remove.');
        return;
    }

    // Serial, not Promise.all: deleteDraft rewrites the whole file under a
    // lock each time, and firing them together is how two writers race.
    (async () => {
        let gone = 0;
        for (const { d } of spent) {
            try { if (await deleteDraft(d.id)) gone += 1; }
            catch (e) { console.log(`  ! ${d.id}: ${e.message}`); }
        }
        console.log(`\nRemoved ${gone} spent draft(s). ${live.length} unfinished draft(s) left alone.`);
    })();
}

main();
