// ── sync-address-book.js — pull the address-book Google Doc into Jarvis ─────
// Run manually whenever the Doc's been updated (not on a schedule — this is
// something Apsara triggers after editing the Doc, not a nightly poll):
//
//   node sync-address-book.js            # dry run — reports only, writes nothing
//   node sync-address-book.js --apply    # writes data/address_book.json
//
// Doc is the source of truth: an entry already in Jarvis whose Doc content
// changed gets fully overwritten, not merged field-by-field (see
// helpers/addressBook.js's mergeEntries doc comment for why — it's free
// text, there's nothing to merge). Always run without --apply first.

const { syncFromDoc, loadAddressBook } = require('./helpers/addressBook');

const APPLY = process.argv.includes('--apply');

async function main() {
    console.log(APPLY ? '=== APPLYING — data/address_book.json will be written ===' : '=== DRY RUN — reporting only, nothing will be written. Pass --apply to write. ===\n');

    if (!APPLY) {
        // Dry run still needs to actually fetch+parse to show what WOULD
        // happen, but must not touch the stored file — reuse the same
        // merge logic against a throwaway in-memory copy of what's stored
        // now, rather than duplicating the diff logic here.
        const { exportDocAsText } = require('./helpers/drive');
        const cfg = require('./config');
        const { parseAddressBookDoc, mergeEntries } = require('./helpers/addressBook');
        const text = await exportDocAsText(cfg.ADDRESS_BOOK_DOC_ID);
        const parsed = parseAddressBookDoc(text);
        console.log(`Parsed ${parsed.length} entries from the Doc.`);
        const stored = loadAddressBook();
        const { added, updated, lockedSkipped, result } = mergeEntries(stored, parsed);
        console.log(`Would add:    ${added.length ? added.join(', ') : '(none)'}`);
        console.log(`Would update: ${updated.length ? updated.join(', ') : '(none)'}`);
        if (lockedSkipped.length) console.log(`Would SKIP (protected — edited on the website): ${lockedSkipped.join(', ')}`);
        console.log(`Total entries after sync: ${result.length} (currently ${stored.length})`);
        return;
    }

    const before = loadAddressBook().length;
    const summary = await syncFromDoc();
    console.log(`Added ${summary.added.length}: ${summary.added.join(', ') || '(none)'}`);
    console.log(`Updated ${summary.updated.length}: ${summary.updated.join(', ') || '(none)'}`);
    if (summary.lockedSkipped.length) console.log(`Skipped (protected — edited on the website, Doc had different content): ${summary.lockedSkipped.join(', ')}`);
    console.log(`Total entries: ${before} -> ${summary.total}`);
}

main().catch((err) => {
    console.error('Sync failed:', err.message);
    if (/File not found|insufficient|permission/i.test(err.message || '')) {
        console.error('This usually means the Doc isn\'t shared with the service account yet — share it (Viewer) with the client_email in data/gdrive-sa.json.');
    }
    process.exit(1);
});
