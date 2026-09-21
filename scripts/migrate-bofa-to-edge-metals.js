// ── scripts/migrate-bofa-to-edge-metals.js ──────────────────────────────────
// ONE-OFF maintenance script — NOT run automatically by the app. Run it once,
// on the VM, after deploying the petty cash account split.
//
// WHY THIS EXISTS, and why it did not exist yesterday.
//
// When BofA became two accounts — Edge Metals' and AAA Investment's — I asked
// Apsara what the existing rows meant, offering three answers, and she chose
// "Keep 'BofA' as-is, reassign as you go". So every old row kept the name
// 'BofA' and the screens called that bucket "not yet split".
//
// On 2026-09-22 she changed that decision, and said it in her own words:
// "By default BofA is edge metals" / "for previous cash". Asked which of
// three things that meant, she picked the migration explicitly — not a
// relabelling, not a dropdown default: rewrite the previous cash to the Edge
// Metals account.
//
// THAT IS HERS TO DECIDE AND ONLY HERS. It asserts that none of the money in
// the old BofA bucket was AAA Investment's, which is a claim about two
// companies' funds that nobody but her can make. It is recorded here because
// she made it, with the date and the words.
//
// WHAT IT DOES, per petty cash row:
//   cash_source 'BofA'  ->  'Edge Metals'
//   transfer_to 'BofA'  ->  'Edge Metals'
//
// transfer_to matters as much as cash_source and is the easy one to miss: a
// borrow or a reassign is TWO rows sharing a transfer_id, and the direction
// of the debt is read off `transfer_to` by helpers/pettyCash.borrowings. Leave
// it behind and a settled loan starts pointing at a bucket that no longer
// takes part, so "what does Chase owe" quietly changes answer.
//
// WHAT IT DOES NOT TOUCH: any row naming 'Edge Metals', 'AAA Investment',
// 'Chase Bank' or 'Unassigned'. Unassigned in particular is NOT swept in —
// it is her opening float and cash taken in on sales, which never came out
// of a bank at all, and she has never said whose it is.
//
// IDEMPOTENT: a second run finds nothing left called 'BofA' and writes
// nothing. Safe after a partial run, and safe if rows were added between the
// deploy and running it.
//
// SAFE BY DEFAULT: --dry-run prints what would change and writes nothing; a
// real run takes a timestamped backup of the whole file first.
//
// CHECK THE ARITHMETIC AFTERWARDS: the script prints the bucket totals before
// and after. Cash in hand must be identical — this moves money between
// buckets' NAMES, never in or out of the box.
//
// Usage, from the repo root on the VM:
//   node scripts/migrate-bofa-to-edge-metals.js --dry-run
//   node scripts/migrate-bofa-to-edge-metals.js

const fs = require('fs');
const cfg = require('../config');

const FROM = 'BofA';
const TO = 'Edge Metals';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (n) => `$${round2(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Deliberately NOT require('../helpers/pettyCash') — that module reads the
// live file through its own cache and would report figures from before this
// script's write. Totals here are computed from the array in hand.
function totals(rows) {
    const out = {};
    for (const r of rows) {
        const k = String((r && r.cash_source) || '').trim() || 'Unassigned';
        out[k] = round2((out[k] || 0) + (Number(r && r.amount) || 0));
    }
    return out;
}

function show(label, t) {
    console.log(`\n${label}`);
    const keys = Object.keys(t).sort();
    if (!keys.length) { console.log('  (no rows)'); return; }
    for (const k of keys) console.log(`  ${k.padEnd(20)} ${money(t[k]).padStart(14)}`);
    console.log(`  ${'TOTAL'.padEnd(20)} ${money(keys.reduce((a, k) => a + t[k], 0)).padStart(14)}`);
}

function main() {
    const dryRun = process.argv.includes('--dry-run');
    const file = cfg.PETTY_CASH_FILE;

    if (!fs.existsSync(file)) {
        console.error(`No petty cash file at ${file} — nothing to migrate.`);
        process.exit(1);
    }

    const raw = fs.readFileSync(file, 'utf8');
    let rows;
    try { rows = JSON.parse(raw); } catch (e) {
        console.error(`${file} is not valid JSON (${e.message}) — aborting, nothing touched.`);
        process.exit(1);
    }
    if (!Array.isArray(rows)) {
        console.error(`${file} did not parse to an array — aborting, nothing touched.`);
        process.exit(1);
    }

    const before = totals(rows);
    show('Buckets BEFORE:', before);

    let sources = 0, tos = 0;
    const preview = [];
    for (const r of rows) {
        if (!r) continue;
        const isSrc = String(r.cash_source || '').trim() === FROM;
        const isTo = String(r.transfer_to || '').trim() === FROM;
        if (!isSrc && !isTo) continue;
        if (isSrc) sources += 1;
        if (isTo) tos += 1;
        preview.push({ id: r.id || '(no id)', date: r.date || '', amount: r.amount,
                       what: isSrc && isTo ? 'cash_source + transfer_to' : (isSrc ? 'cash_source' : 'transfer_to') });
        if (!dryRun) {
            if (isSrc) r.cash_source = TO;
            if (isTo) r.transfer_to = TO;
        }
    }

    console.log(`\nRows in file: ${rows.length}`);
    console.log(`${dryRun ? 'Would rewrite' : 'Rewrote'} cash_source "${FROM}" -> "${TO}": ${sources}`);
    console.log(`${dryRun ? 'Would rewrite' : 'Rewrote'} transfer_to "${FROM}" -> "${TO}": ${tos}`);

    if (!preview.length) {
        console.log(`\nNothing named "${FROM}" is left — already migrated. No file written.`);
        return;
    }

    if (dryRun) {
        console.log('\n--dry-run: no file was written. First rows that would change:');
        preview.slice(0, 10).forEach((p) => console.log(`  ${String(p.date).padEnd(12)} ${money(p.amount).padStart(14)}  ${p.what}`));
        if (preview.length > 10) console.log(`  ...and ${preview.length - 10} more`);
        const after = totals(rows.map((r) => (String(r && r.cash_source || '').trim() === FROM
            ? { ...r, cash_source: TO } : r)));
        show('Buckets AFTER (simulated):', after);
        return;
    }

    const backupPath = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.writeFileSync(backupPath, raw);
    console.log(`\nBackup written: ${backupPath}`);

    fs.writeFileSync(file, JSON.stringify(rows, null, 2));
    console.log(`Wrote migrated data back to ${file}`);

    const after = totals(rows);
    show('Buckets AFTER:', after);

    // The one check worth failing loudly on. Renaming a bucket must not move
    // a cent in or out of the box; if this ever differs, the backup above is
    // the file to restore.
    const sum = (t) => round2(Object.values(t).reduce((a, b) => a + b, 0));
    if (Math.abs(sum(before) - sum(after)) > 0.005) {
        console.error(`\nCASH IN HAND CHANGED: ${money(sum(before))} -> ${money(sum(after))}.`);
        console.error(`That must never happen. Restore ${backupPath} and do not use this data.`);
        process.exit(1);
    }
    console.log(`\nCash in hand unchanged at ${money(sum(after))}, as it must be.`);
}

main();
