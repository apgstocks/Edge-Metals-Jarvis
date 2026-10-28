#!/usr/bin/env node
// ── scripts/qb-snapshot.js — refresh the rolling QuickBooks snapshot ─────
//
//     node scripts/qb-snapshot.js
//     node scripts/qb-snapshot.js --since 2026-01-01
//
// Apsara, 2026-10-28: "it should be a rolling date..from 01-01-2026 to rolling
// date".
//
// READ-ONLY against QuickBooks — query calls only, no writes. What it writes is
// three files in data/: the flattened index (qb-books-snapshot.json) and the
// full Bill and Invoice documents.
//
// ── WHY THIS SCRIPT HAS TO EXIST ────────────────────────────────────────
// helpers/quickbooks/snapshot.js has had write() since it was built, pages
// correctly, and defaults to since 2026-01-01 with no upper bound — so it was
// ALREADY rolling. helpers/qbDocNumbers.js calls its output "the nightly
// snapshot rows". It was never nightly: nothing in scheduler.js called it, the
// 07:25 QuickBooks agent does not call it, and nothing else in the repo does
// either. The index on disk was 23 days old and the row files 37 days old,
// which is how a duplicate check came to be run against two thirds of a year
// and could have reported it clean.
//
// So: an entry point that can be run by hand, and a cron line that runs it at
// 05:55 — ahead of the integrity sweep at 06:30, the bank auto-tick at 06:50
// and the QuickBooks agent at 07:25, so all three read today's QuickBooks
// rather than last month's.
require('dotenv').config();

const snapshot = require('../helpers/quickbooks/snapshot');
const auth = require('../helpers/quickbooks/auth');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
const SINCE = String(flag('--since', '2026-01-01'));

(async () => {
    const env = auth.qbEnv();
    console.log(`QuickBooks snapshot · ${SINCE} -> today · env ${env}`);
    if (env !== 'production') {
        // Said loudly rather than refused: a sandbox refresh is useful while
        // testing. What must never happen is her acting on sandbox figures
        // believing they are her books, which is why every file carries env.
        console.log('  NOTE: this is NOT her live books. The files will say so.');
    }
    const snap = await snapshot.write({ env, since: SINCE });
    console.log(`  index    : ${snap.bills.length} bills, ${snap.invoices.length} invoices`);
    for (const kind of ['bills', 'invoices']) {
        const r = snapshot.rows(kind);
        if (!r) { console.log(`  ${kind.padEnd(9)}: NOT WRITTEN`); continue; }
        const last = r.rows.map((x) => x.TxnDate).filter(Boolean).sort().pop() || '(none)';
        // The count being an exact multiple of 1000 is the shape that fooled
        // everyone last time, so it is called out even when it is legitimate.
        const suspicious = r.count > 0 && r.count % 1000 === 0;
        console.log(`  ${kind.padEnd(9)}: ${r.count} rows, latest ${last}, env ${r.env}`
            + (suspicious ? '   <-- exactly a multiple of 1000: CHECK that paging finished' : ''));
    }
    console.log(`  owed to her ${snap.totals.owed}   she owes ${snap.totals.owe}`);
})().catch((e) => {
    console.error('\ncould not refresh: ' + (e && e.message || e));
    console.error('QuickBooks tokens live on the VM — run it there, or reconnect in Settings.');
    process.exit(1);
});
