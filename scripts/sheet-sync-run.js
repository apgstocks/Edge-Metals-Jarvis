#!/usr/bin/env node
// ── scripts/sheet-sync-run.js — run the nightly sheet sync, on purpose ─────
//
// Apsara, 2026-09-29: "Run nightly run".
//
// The job already exists (helpers/metalsSheetSyncJob.js) and the scheduler
// fires it at 23:15. This is the way to run it by hand without typing a
// `node -e` with two requires in it — which I got wrong once already today,
// calling `.run()` on a module whose function is `runNightly()`, and the
// error read like the feature was broken rather than the command.
//
//   node scripts/sheet-sync-run.js              dry run: read, compare, print
//   node scripts/sheet-sync-run.js --write      live: writes, needs SHEET_SYNC_WRITE=1
//   node scripts/sheet-sync-run.js --email      also send the report
//
// ── WHY IT CHECKS THE LEDGER BEFORE IT STARTS ─────────────────────────────
// The sync compares a LIVE SHEET against a LOCAL LEDGER and proposes adding
// whatever the ledger is missing. That is only meaningful if the ledger is
// the real one.
//
// Run in a development checkout it is worse than useless. The Mac checkout
// on 2026-09-29 had NO bills.json at all and a sales.json of 7 rows whose
// newest entry was five weeks old. Against her live sheet that reads as
// "hundreds of rows missing" — a report that looks like a finding and is an
// artefact of the machine it ran on. With --write it would have duplicated
// the entire ledger.
//
// So: count what is there first, and refuse a ledger that looks like a
// fragment unless told otherwise. A dry run on a stale checkout is still a
// misleading report, so the guard applies to both modes.

const path = require('path');
const ROOT = path.join(__dirname, '..');

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const EMAIL = argv.includes('--email');
const FORCE = argv.includes('--force');

// A ledger this small is a checkout, not a business. Deliberately generous:
// the point is to catch an empty or near-empty store, not to police a real
// one having a quiet month.
const MIN_BILLS = 5;
const MIN_SALES = 5;

(async () => {
    const cfg = require(path.join(ROOT, 'config'));
    const bills = require(path.join(ROOT, 'helpers/bills'));
    const sales = require(path.join(ROOT, 'helpers/sales'));

    const B = bills.list() || [];
    const S = sales.list() || [];
    const newest = (rows) => rows.map((r) => r.date).filter(Boolean).sort().pop() || 'never';

    console.log(`\n  SHEET SYNC — ${WRITE ? 'LIVE (would write)' : 'DRY RUN (writes nothing)'}`);
    console.log(`  ${'─'.repeat(68)}`);
    console.log(`  data dir : ${cfg.DATA_DIR || '(default)'}`);
    console.log(`  bills    : ${B.length} rows, newest ${newest(B)}`);
    console.log(`  invoices : ${S.length} rows, newest ${newest(S)}`);
    console.log(`  writing  : SHEET_SYNC_WRITE=${process.env.SHEET_SYNC_WRITE || '(unset)'}`);

    if (!FORCE && (B.length < MIN_BILLS || S.length < MIN_SALES)) {
        console.error(
`
  REFUSING — this ledger looks like a fragment, not the live books.

  The sync proposes adding whatever the ledger is missing compared to the
  sheet. Against a near-empty ledger that is every row on the sheet, which
  reads like a finding and is an artefact of which machine you ran it on.

  Run it on the VM, where the real data dir and .env are:

      cd ~/Jarvis && node scripts/sheet-sync-run.js

  If you genuinely mean to run it against this store, add --force.
`);
        process.exit(2);
    }

    // ── THE JOB DECIDES WHETHER IT IS ALLOWED TO WRITE, NOT THIS SCRIPT ───
    // runNightly gates on opts.write AND SHEET_SYNC_WRITE=1. Passing
    // write:true here is a REQUEST; the job still refuses unless the
    // environment says so, which is the arrangement that keeps "write" one
    // typo away from nothing rather than from a night nobody asked for.
    const job = require(path.join(ROOT, 'helpers/metalsSheetSyncJob'));
    const result = await job.runNightly({ write: WRITE, email: EMAIL });

    console.log(`\n  ${'─'.repeat(68)}`);
    if (result.error) {
        // The scheduler learned this the hard way on 2026-09-25: a failure
        // printed where a summary belongs reads like a quiet successful
        // night. It says FAILED here, and says nothing was written.
        console.error(`  FAILED — NOTHING WAS WRITTEN: ${result.error}\n`);
        process.exit(1);
    }

    try {
        console.log(job.reportText(result.report, {
            dryRun: result.dryRun, committed: result.committed,
        }));
    } catch (e) {
        const sync = require(path.join(ROOT, 'helpers/metalsSheetSync'));
        console.log('  ' + sync.summarise(result.report));
    }

    if (result.dryRun && WRITE) {
        console.log(`\n  Asked to write, but stayed a dry run — SHEET_SYNC_WRITE is not 1`);
        console.log(`  in this environment, so nothing was committed.`);
    }
    if (result.committed) {
        console.log(`\n  WROTE ${result.committed.bills} bill(s) and ${result.committed.sales} invoice(s)`
            + ` as batch ${result.committed.batch}.`);
        console.log(`  To undo: node -e "require('./helpers/sheetImportWrite').undo('${result.committed.batch}')"`);
    }
    if ((result.refused || []).length) {
        console.log(`\n  REFUSED ${result.refused.length}:`);
        for (const r of result.refused) console.log(`    · ${r.why || JSON.stringify(r)}`);
    }
    console.log('');
})().catch((e) => { console.error('\n  ' + (e.stack || e.message) + '\n'); process.exit(1); });
