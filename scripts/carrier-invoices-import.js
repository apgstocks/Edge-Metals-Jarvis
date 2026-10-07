#!/usr/bin/env node
// ── scripts/carrier-invoices-import.js ─────────────────────────────────────
// Saved NTG/TQL/Schneider emails -> Edge Metals carrier-invoices store.
// DRY RUN by default: shows what it would add/update and writes NOTHING.
//   node scripts/carrier-invoices-import.js           # preview
//   node scripts/carrier-invoices-import.js --write   # write to carrier_invoices.json (run where DATA_DIR is)
// Safe to re-run: upserts by carrier+ref; hand-edited (locked) rows are left alone.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const R = require(path.join(ROOT, 'helpers/carrierRemittance'));
const CI = require(path.join(ROOT, 'helpers/carrierInvoices'));
const DIR = process.env.CARRIER_EMAIL_DIR || path.join(ROOT, 'data/sample-invoices');
const WRITE = process.argv.includes('--write');
const $ = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

const recs = [];
for (const party of ['tql', 'ntg', 'schneider']) {
    const d = path.join(DIR, party, 'emails');
    if (!fs.existsSync(d)) { console.log(`(no saved emails for ${party})`); continue; }
    for (const f of fs.readdirSync(d)) { const r = R.parseSavedEmail(fs.readFileSync(path.join(d, f), 'utf8')); if (r) recs.push(r); }
}
const { rows, skipped } = R.buildCarrierRows(recs);
const have = new Set(CI.list().map((r) => r.key));
console.log(`\nEdge Metals carrier invoices — ${rows.length} row(s) from email. ${WRITE ? 'WRITING' : 'DRY RUN, nothing written'}\n`);
for (const c of CI.CARRIERS) {
    const r = rows.filter((x) => x.carrier === c);
    const open = r.reduce((a, x) => a + Math.max(0, x.amount - x.paid), 0);
    console.log(`${c.toUpperCase().padEnd(10)} ${String(r.length).padStart(3)} rows  billed ${$(r.reduce((a, x) => a + x.amount, 0))}  outstanding ${$(open)}  (${r.filter((x) => !have.has(`${c}:${x.ref}`)).length} new)`);
}
if (skipped.length) { console.log(`\nNot imported (${skipped.length}):`); skipped.forEach((s) => console.log(`   ${s.carrier} ${s.ref} — ${s.why}`)); }
(async () => {
    if (!WRITE) return console.log('\nAdd --write to save.\n');
    const res = await CI.upsertMany(rows);
    console.log(`\nWrote: ${res.added} added, ${res.updated} updated.\n`);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
