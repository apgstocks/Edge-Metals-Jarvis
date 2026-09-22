#!/usr/bin/env node
// ── scripts/qb-sync.js — catch QuickBooks up with Jarvis ────────────────────
//   node scripts/qb-sync.js            dry run: what WOULD be entered, nothing written
//   node scripts/qb-sync.js --really   enter everything since the cutover that is
//                                      not in QuickBooks yet (idempotent; linked
//                                      records are skipped; every step journalled)
// Run on the VM, where the live ledgers are. Writes to the live books still
// need QB_ENV=production and QB_PROD_WRITES=on.
require('dotenv').config();
const sync = require('../helpers/quickbooks/sync');
const env = require('../helpers/quickbooks/auth').qbEnv();
(async () => {
    const dryRun = !process.argv.includes('--really');
    console.log(`QuickBooks ${env.toUpperCase()} · ${dryRun ? 'DRY RUN — nothing is written' : 'ENTERING'}`);
    console.log(await sync.sweep({ env, dryRun }));
})().catch((e) => { console.error('qb-sync failed:', e.message); process.exit(1); });
