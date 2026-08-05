// ── import-sheet-addresses.js — one-time import from the Shipments 2026 Sheet ──
// Companion to sync-address-book.js, but NOT a repeatable sync. The Sheet
// (https://docs.google.com/spreadsheets/d/1QsCeuqeRKODuouzO2PfKbxG9qJpN8yAbIurSzhI--6s,
// "Address"/"Addresses"/"Addresses_2026" tabs) is a free-form, multi-column
// scratchpad with no consistent layout and real bank wire/SWIFT/routing
// numbers mixed into the same cells as addresses — too irregular to safely
// auto-parse (the Doc-sync's mergeEntries already had one real near-miss
// this session; blind-parsing something messier than the Doc wasn't worth
// the risk). Entries below were read and transcribed by hand from the
// Sheet on 2026-08-05 — see _sheet_addresses_curated.js's own header for
// exactly what was included/excluded and why (skipped: Edge Metals' own
// bank/wire info, ambiguous name-only fragments, and anything that
// duplicates an address already synced from the Doc).
//
//   node import-sheet-addresses.js            # dry run — reports only
//   node import-sheet-addresses.js --apply    # writes data/address_book.json
//
// Safe to re-run: goes through the SAME tested mergeEntries() the Doc sync
// uses, so re-running this against an unchanged curated list is a no-op
// (won't create duplicates or re-touch entries that already match).

const { loadAddressBook, mergeEntries } = require('./helpers/addressBook');
const { mutateJson } = require('./helpers/json');
const cfg = require('./config');
// Both hand-curated batches, run together — batch 2 includes one deliberate
// UPDATE to a batch-1 entry (Pan Metal Korea (Hwaseong) gaining phone/fax),
// which relies on batch 1 having already added that entry first. Order here
// matters for that reason; mergeEntries processes the combined list in
// order, so batch 1's add happens before batch 2's update is evaluated.
const curated = [
    ...require('./_sheet_addresses_curated'),
    ...require('./_sheet_addresses_curated_batch2'),
];

const APPLY = process.argv.includes('--apply');

function sameAliasSet(a, b) {
    if (a.length !== b.length) return false;
    const setA = new Set(a.map((x) => x.toLowerCase()));
    for (const x of b) if (!setA.has(x.toLowerCase())) return false;
    return setA.size === b.length;
}

async function main() {
    console.log(APPLY ? '=== APPLYING — data/address_book.json will be written ===\n' : '=== DRY RUN — reporting only. Pass --apply to write. ===\n');
    console.log(`${curated.length} hand-curated entries from the Sheet.\n`);

    const stored = loadAddressBook();
    const { result, added, updated, lockedSkipped } = mergeEntries(stored, curated);

    // Tag source on entries this import actually added/updated — NOT on
    // locked ones (mergeEntries left those untouched on purpose; relabeling
    // a manually-edited entry's source here would misrepresent where its
    // current content actually came from).
    const touched = new Set([...added, ...updated]);
    for (const entry of curated) {
        if (!touched.has(entry.aliases[0])) continue;
        const match = result.find((e) => sameAliasSet(e.aliases, entry.aliases));
        if (match && !match.manually_edited) match.source = 'google_sheet_2026-08-05';
    }

    console.log(`Would add:    ${added.length ? added.join(', ') : '(none)'}`);
    console.log(`Would update: ${updated.length ? updated.join(', ') : '(none)'}`);
    if (lockedSkipped.length) console.log(`Would SKIP (protected — edited on the website): ${lockedSkipped.join(', ')}`);
    console.log(`Total entries after import: ${result.length} (currently ${stored.length})`);

    if (!added.length && !updated.length) {
        console.log('\nNothing to do — every curated entry already matches what\'s stored (safe to re-run).');
        return;
    }

    if (!APPLY) {
        console.log('\nRe-run with --apply to write these to data/address_book.json.');
        return;
    }

    // mutateJson (helpers/json.js) fails SOFT on a lock error: it logs
    // "[JSON] Mutate failed" and returns the pre-mutation data instead of
    // throwing, so a caller that doesn't check the return value can print
    // "success" after a write that never actually happened. Real near-miss,
    // caught while running this exact script (2026-08-05) — a stale lock
    // directory left over from a prior process on this fuse-mounted folder
    // made the very next mutateJson call fail silently. Verify by reading
    // the file back and comparing count, not by trusting the promise resolved.
    const written = await mutateJson(cfg.ADDRESS_BOOK_FILE, [], () => result);
    const reread = loadAddressBook();
    if (reread.length !== result.length) {
        console.error(`\nWRITE DID NOT ACTUALLY HAPPEN — expected ${result.length} entries on disk, found ${reread.length}. Check the [JSON] Mutate failed log above (often a stale .lock directory next to the file — safe to delete if no other process is running, then re-run --apply).`);
        process.exit(1);
    }
    console.log(`\nWrote ${written.length} total entries to ${cfg.ADDRESS_BOOK_FILE} (verified by re-reading the file).`);
}

main().catch((err) => {
    console.error('Import failed:', err.message);
    process.exit(1);
});
