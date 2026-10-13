#!/usr/bin/env node
// ── scripts/bank-dedupe.js — remove the duplicates a bank re-link left ────
//
// Apsara, 2026-10-14: every deposit on the Bank screen from 11 Aug to 6 Oct
// appeared twice. The bank had been re-linked (to widen the 90-day window),
// Plaid reissued every id, and the sync stored the new copies beside the old.
// scripts/bank-relink.js cannot fix that state: its apply() refuses to re-key
// an old row onto an id the store already owns. See helpers/bankRelink.js
// (dedupe) for the rules.
//
// ── RUN IT ON THE VM ─────────────────────────────────────────────────────
//   node scripts/bank-dedupe.js            preview — writes NOTHING
//   node scripts/bank-dedupe.js --apply    backs the store up, then removes
//   node scripts/bank-dedupe.js --full     list every removal, not a sample
//   node scripts/bank-dedupe.js --file <p> work on a copy of the store
//
// Removed rows are archived, one JSON line each, in
// data/bank-duplicates-removed.jsonl, with the id of the copy that stayed.
//
// A row you have acted on, or that another record points at, is never removed.
// Two identical rows on the SAME account are never touched: that is two real
// transactions, not a duplicate.

const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valOf = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const root = path.join(__dirname, '..');
const cfg = require(path.join(root, 'config'));
const R = require(path.join(root, 'helpers/bankRelink'));
const plaid = require(path.join(root, 'helpers/plaid'));
const FILE = valOf('--file') || cfg.BANK_TX_FILE;
const ARCHIVE = path.join(path.dirname(FILE), 'bank-duplicates-removed.jsonl');
const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

(async () => {
    const items = plaid.items();
    if (!items.length) { console.error('\n  No bank is linked here — run this on the VM.\n'); process.exit(1); }

    // Two items for one institution = the feed is STILL doubled. Removing rows
    // would be undone by the next sync, so say so before anything else.
    const byInst = {};
    for (const i of items) byInst[i.institution || '?'] = (byInst[i.institution || '?'] || 0) + 1;
    const doubled = Object.entries(byInst).filter(([, n]) => n > 1);
    if (doubled.length) {
        console.log('\n  !! MORE THAN ONE LINKED ITEM FOR: ' + doubled.map(([k, n]) => `${k} (${n})`).join(', '));
        console.log('  If both cover the same accounts, every sync will bring the duplicates back.');
        console.log('  Unlink the extra item in the Bank screen first, then run this.');
        if (has('--apply')) { console.log('  Not applying.\n'); process.exit(1); }
    }

    const live = [];
    for (const i of items) for (const a of (i.accounts || [])) if (a.account_id) live.push(a.account_id);

    // Everything else that points at a bank row's id.
    const refs = new Set();
    try { for (const e of require(path.join(root, 'helpers/bankEntries')).list()) if (e && e.bank_row_id) refs.add(e.bank_row_id); } catch (e) { console.error('  (could not read bank entries: ' + e.message + ')'); process.exit(1); }
    try { for (const t of (require(path.join(root, 'helpers/interCompany')).list() || [])) for (const id of (t.bank_rows || [])) refs.add(id); } catch (e) { console.error('  (could not read inter-company transfers: ' + e.message + ')'); process.exit(1); }

    const rows = R.read(FILE);
    const plan = R.dedupe(rows, { liveAccountIds: live, refs });
    console.log(`\n  store: ${FILE}\n  rows: ${rows.length}   referenced elsewhere: ${refs.size}`);
    if (!plan.ok) { console.log('  ' + plan.why + '\n'); process.exit(1); }

    console.log('\n  ── WHAT WOULD HAPPEN ─────────────────────────────────────────');
    console.log(`  duplicate copies to remove   ${plan.counts.remove}`);
    console.log(`  pairs kept as they are       ${plan.counts.kept_both}   <- both copies carry work; you decide`);
    const sample = has('--full') ? plan.remove : plan.remove.slice(0, 12);
    for (const x of sample) {
        console.log(`  ${x.date}  ${x.direction === 'in' ? '+' : '-'}${money(x.amount).padStart(13)}  remove ${x.which.padEnd(17)} ${String(x.desc).slice(0, 36)}`);
    }
    if (!has('--full') && plan.remove.length > sample.length) console.log(`  … and ${plan.remove.length - sample.length} more (--full to list them all)`);
    for (const k of plan.kept_both.slice(0, 8)) console.log(`  KEPT BOTH  ${k.old_id}  /  ${k.fresh_id}  — ${k.why}`);

    if (!plan.remove.length) { console.log('\n  Nothing to remove.\n'); process.exit(0); }
    if (!has('--apply')) { console.log('\n  Nothing was written. Re-run with --apply when this looks right.\n'); process.exit(0); }

    const backup = FILE.replace(/\.json$/, '') + `.before-dedupe-${Date.now()}.json`;
    fs.copyFileSync(FILE, backup);
    console.log(`\n  backed up to ${backup}`);
    const out = await R.applyDedupe(FILE, plan, { archiveFile: ARCHIVE, by: 'bank-dedupe script' });
    console.log(`  removed ${out.removed} duplicate row(s); archived in ${ARCHIVE}`);
    console.log('  Reload the Bank page.\n');
})().catch((e) => { console.error('\n  FAILED, nothing half-written: ' + (e && e.message ? e.message : e) + '\n'); process.exit(1); });
