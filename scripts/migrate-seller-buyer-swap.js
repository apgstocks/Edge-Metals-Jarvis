// ── scripts/migrate-seller-buyer-swap.js ────────────────────────────────────
// ONE-OFF maintenance script — NOT run automatically by the app. Run this
// manually, ONCE, on the production VM after deploying the 2026-08-15
// buyer/seller field swap (per Apsara: "no. buyer should be edge trading").
//
// WHY THIS EXISTS: before the swap, every load record had `seller` fixed to
// "Edge Metals Inc." and `buyer`/`buyer_address` holding the real
// counterparty's name/address. After the swap, the CODE reads it backwards —
// `seller`/`seller_address` for the counterparty, `buyer` fixed to
// "Edge Trading". Without migrating existing records, every load saved
// BEFORE today would suddenly display wrong: the counterparty's real name
// sitting under `buyer` (now supposed to be the fixed constant) and
// "Edge Metals Inc." showing up under `seller` (now supposed to be the real
// counterparty) on every old load's card, PDF, and inventory grouping.
//
// WHAT IT DOES, per record:
//   new seller         = old buyer            (the real counterparty's name)
//   new seller_address = old buyer_address
//   new buyer          = "Edge Trading"        (the corrected fixed constant)
//   new buyer_address  = null                  (unused/undisplayed — old
//                                                seller_address was almost
//                                                certainly always blank
//                                                anyway since the disabled
//                                                Seller field never had an
//                                                address input)
//
// IDEMPOTENT: a record whose `buyer` is ALREADY "Edge Trading" is left
// untouched and counted as "already migrated" — safe to run this more than
// once (e.g. if new loads were saved under the new code between deploy and
// running this script, they're already correct and get skipped, not
// double-swapped).
//
// SAFE BY DEFAULT: writes a timestamped backup of the whole file before
// touching anything, and supports --dry-run to preview the change count
// with zero writes.
//
// Usage (from the repo root on the VM):
//   node scripts/migrate-seller-buyer-swap.js --dry-run
//   node scripts/migrate-seller-buyer-swap.js

const fs = require('fs');
const path = require('path');
const cfg = require('../config');

function main() {
    const dryRun = process.argv.includes('--dry-run');
    const file = cfg.LOADS_FILE;

    if (!fs.existsSync(file)) {
        console.error(`No loads file found at ${file} — nothing to migrate.`);
        process.exit(1);
    }

    const raw = fs.readFileSync(file, 'utf8');
    const loads = JSON.parse(raw);
    if (!Array.isArray(loads)) {
        console.error(`${file} did not parse to an array — aborting, nothing touched.`);
        process.exit(1);
    }

    let migrated = 0, alreadyDone = 0;
    const preview = [];

    for (const l of loads) {
        if (l.buyer === 'Edge Trading') {
            alreadyDone += 1;
            continue;
        }
        const oldBuyer = l.buyer, oldBuyerAddr = l.buyer_address;
        if (dryRun) {
            preview.push({ id: l.id, oldSeller: l.seller, newSeller: oldBuyer, oldBuyer: l.buyer, newBuyer: 'Edge Trading' });
        } else {
            l.seller = oldBuyer;
            l.seller_address = oldBuyerAddr;
            l.buyer = 'Edge Trading';
            l.buyer_address = null;
        }
        migrated += 1;
    }

    console.log(`Total records: ${loads.length}`);
    console.log(`Already in new format (buyer === "Edge Trading"): ${alreadyDone}`);
    console.log(`${dryRun ? 'Would migrate' : 'Migrated'}: ${migrated}`);

    if (dryRun) {
        console.log('\n--dry-run: no files were written. Sample of what would change:');
        preview.slice(0, 10).forEach(p => console.log(`  ${p.id}: seller "${p.oldSeller}" -> "${p.newSeller}", buyer "${p.oldBuyer}" -> "${p.newBuyer}"`));
        if (preview.length > 10) console.log(`  ...and ${preview.length - 10} more`);
        return;
    }

    if (migrated === 0) {
        console.log('Nothing to write — every record was already in the new format.');
        return;
    }

    const backupPath = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.writeFileSync(backupPath, raw);
    console.log(`Backup written: ${backupPath}`);

    fs.writeFileSync(file, JSON.stringify(loads, null, 2));
    console.log(`Wrote migrated data back to ${file}`);
}

main();
