#!/usr/bin/env node
// ── scripts/bank-relink.js — re-link a bank without duplicating its rows ──
//
// Apsara, 2026-10-12: "i need 2026 transactions from 01-01-2026", after
// "all the transactions from plaid is from 2026-07-14 to 2026-10-09".
//
// The window was 90 days because transactions.days_requested was never sent,
// and Plaid does not allow that to be changed on an existing Item. Getting
// back to 1 January means removing the Item and linking the bank again — and
// a re-link reissues every transaction_id, which is what this script exists
// to survive. See helpers/bankRelink.js for why it must not be a change to
// the ordinary sync path.
//
// ── RUN IT IN THIS ORDER, ON THE VM ──────────────────────────────────────
//
//   0. Deploy first. Without the days_requested fix the new link gets
//      another 90 days and you will be doing this twice.
//        git pull && pm2 restart jarvis jarvis-render --update-env
//
//   1. BACK UP THE STORE. One copy, before anything.
//        cp data/bank-transactions.json data/bank-transactions.before-relink.json
//
//   2. Unlink the bank in the Bank screen, then link it again. Plaid will
//      take a few minutes to populate the wider history — the first pull of
//      two years is slower than a daily one.
//
//   3. PREVIEW. Reads only; writes nothing.
//        node scripts/bank-relink.js
//
//   4. Read the preview. The number that matters is "pairs (she has acted
//      on)": those are rows carrying a match, a category or an exclusion
//      that are about to keep it. If anything looks wrong, stop — the
//      preview has changed nothing and the backup from step 1 is intact.
//
//   5. APPLY.
//        node scripts/bank-relink.js --apply
//
// --file lets both steps run against a copy, which is the safe way to try it.

const path = require('path');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valOf = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

if (has('--help') || has('-h')) {
    console.log(`
  node scripts/bank-relink.js                 preview, writes nothing
  node scripts/bank-relink.js --apply         re-key the paired rows
  node scripts/bank-relink.js --file <path>   use a copy of the store
  node scripts/bank-relink.js --full          list every pairing, not a sample
`);
    process.exit(0);
}

const cfg = require(path.join(__dirname, '..', 'config'));
const relink = require(path.join(__dirname, '..', 'helpers/bankRelink'));
const ledger = require(path.join(__dirname, '..', 'helpers/bankLedger'));
const plaid = require(path.join(__dirname, '..', 'helpers/plaid'));

const FILE = valOf('--file') || cfg.BANK_TX_FILE;
const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

(async () => {
    if (!plaid.configured()) {
        console.error('Plaid is not configured here — run this on the VM, where the keys are.');
        process.exit(1);
    }

    const existing = relink.read(FILE);
    console.log(`\n  store: ${FILE}`);
    console.log(`  rows already stored: ${existing.length}`);
    if (!existing.length) {
        console.log('\n  Nothing stored, so nothing can be duplicated. Just let the sync run.\n');
        process.exit(0);
    }

    // The fresh side comes from the NEW item's feed. syncItem advances the
    // cursor, so this deliberately reads what the ordinary sync has ALREADY
    // pulled rather than pulling again: running this script must not consume
    // a cursor and leave the real sync with nothing to find.
    const linked = plaid.items();
    if (!linked.length) {
        console.error('\n  No bank is linked. Link it first (step 2), let the sync run, then come back.\n');
        process.exit(1);
    }
    console.log(`  linked items: ${linked.map((i) => `${i.institution || i.item_id}`).join(', ')}`);

    // !! KNOWN LIMIT (found 2026-10-14): once the sync HAS stored the new item's
    // rows, apply() below refuses — it will not re-key an old row onto an id the
    // store already owns. That state is what actually happens (the 05:45 pull
    // beats her to it), and its fix is scripts/bank-dedupe.js, not this.
    // Rows whose id the store has never seen are, by definition, the new
    // item's. Taking them from the store means this works AFTER the sync has
    // already inserted the duplicates — which is the state she will actually
    // be in, because the 05:45 job or the webhook will have run.
    const seen = new Set();
    const dupes = [], originals = [];
    for (const r of existing) {
        if (!r || !r.id) continue;
        if (r.relinked) { originals.push(r); continue; }
        (seen.has(r.id) ? dupes : originals).push(r);
        seen.add(r.id);
    }

    // Split the store into "rows from before the re-link" and "rows the new
    // item has just inserted", by account_id: the new item's account ids are
    // the ones its own accounts list names.
    const newAccountIds = new Set();
    for (const i of linked) for (const a of (i.accounts || [])) if (a.account_id) newAccountIds.add(a.account_id);
    const fresh = existing.filter((r) => r && r.account_id && newAccountIds.has(r.account_id) && !r.relinked);
    const old = existing.filter((r) => !(r && r.account_id && newAccountIds.has(r.account_id)) && !r.relinked);

    console.log(`  rows on the CURRENT item's accounts: ${fresh.length}`);
    console.log(`  rows from before the re-link:        ${old.length}`);
    if (!old.length || !fresh.length) {
        console.log('\n  One side is empty, so there is nothing to pair. Either the re-link has not');
        console.log('  happened yet, or the sync has not run since it did, or this is already done.\n');
        process.exit(0);
    }

    const p = relink.plan(old, fresh);
    const c = p.counts;

    console.log('\n  ── WHAT WOULD HAPPEN ─────────────────────────────────────────');
    console.log(`  pairs (same transaction, new id)   ${c.pairs}`);
    console.log(`    of those, she has acted on       ${c.pairs_acted_on}   <- these keep their match/category/exclusion`);
    console.log(`  older rows the new feed re-sent    ${c.already_keyed}`);
    console.log(`  rows the new feed did NOT re-send  ${c.unmatched_existing}   (${c.unmatched_existing_acted_on} acted on)`);
    console.log(`  genuinely new rows                 ${c.unmatched_fresh}   <- the history you were missing`);

    const sample = has('--full') ? p.pairs : p.pairs.slice(0, 12);
    if (sample.length) {
        console.log('\n  ── PAIRINGS ──────────────────────────────────────────────────');
        for (const x of sample) {
            console.log(`  ${x.at}  ${x.direction === 'in' ? '+' : '-'}${money(x.amount).padStart(13)}`
                + `  ${x.acted_on ? '[acted on]' : '          '}  ${String(x.desc).slice(0, 44)}`);
        }
        if (!has('--full') && p.pairs.length > sample.length) {
            console.log(`  … and ${p.pairs.length - sample.length} more (--full to list them all)`);
        }
    }

    const keptButStale = p.unmatched_existing.filter((r) => r.acted_on);
    if (keptButStale.length) {
        console.log('\n  ── KEPT, BUT THE NEW FEED WILL NOT REFRESH THEM ──────────────');
        console.log('  Older than the new window, or the bank no longer reports them. Your work');
        console.log('  on them stays; they simply stop being updated.');
        for (const r of keptButStale.slice(0, 8)) {
            console.log(`  ${r.at}  ${r.direction === 'in' ? '+' : '-'}${money(r.amount).padStart(13)}  ${String(r.desc).slice(0, 44)}`);
        }
        if (keptButStale.length > 8) console.log(`  … and ${keptButStale.length - 8} more`);
    }

    if (dupes.length) {
        console.log(`\n  NOTE: ${dupes.length} row(s) already share an id in this file. That should be`);
        console.log('  impossible and is worth telling me about before you apply anything.');
    }

    if (!has('--apply')) {
        console.log('\n  Nothing was written. Re-run with --apply when the figures above look right.');
        console.log('  Back the store up first if you have not:');
        console.log('    cp data/bank-transactions.json data/bank-transactions.before-relink.json\n');
        process.exit(0);
    }

    console.log('\n  applying…');
    const out = await relink.apply(FILE, p);
    console.log(`  re-keyed ${out.rekeyed} row(s), ${out.acted_on} of them carrying your own work.`);
    console.log('\n  Now let the sync run once more. The paired rows will refresh in place, and the');
    console.log('  older history comes in as new rows.\n');
})().catch((e) => {
    console.error('\n  FAILED, and nothing was half-written — this store writes atomically.');
    console.error('  ' + (e && e.message ? e.message : e) + '\n');
    process.exit(1);
});
