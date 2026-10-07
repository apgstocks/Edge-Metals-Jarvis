#!/usr/bin/env node
// ── scripts/party-invoices-import.js ───────────────────────────────────────
// The sweep's export -> Jarvis's invoice register (helpers/partyInvoices.js).
//   1. node scripts/freight-2026-email-sweep.js --export-json     (report-only sweep; needs Gmail + Gemini)
//   2. node scripts/party-invoices-import.js                      (PREVIEW — writes nothing)
//   3. node scripts/party-invoices-import.js --write              (save to party_invoices.json)
// Safe to re-run: upserts by party + invoice no. + container/booking/HBL; hand-edited rows are kept.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const PI = require(path.join(ROOT, 'helpers/partyInvoices'));
const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const fi = argv.indexOf('--file');
const FILE = fi !== -1 ? path.resolve(argv[fi + 1]) : path.join(ROOT, 'data/party-invoices-2026.json');
const $ = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

if (!fs.existsSync(FILE)) { console.error(`No export at ${FILE}.\nRun first:  node scripts/freight-2026-email-sweep.js --export-json`); process.exit(1); }
const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const rows = new Map(), skipped = {};
for (const rec of data.records || []) {
    const n = PI.normalize(rec);
    if (n.skip) { const k = `${rec.party}: ${n.skip}`; skipped[k] = (skipped[k] || 0) + 1; continue; }
    rows.set(n.row.key, n.row);   // same invoice line seen twice -> last wins
}
const have = new Set(PI.list().map((r) => r.key));
console.log(`\nParty invoice register — from ${path.basename(FILE)} (exported ${data.exported_at || '?'}).  ${WRITE ? 'WRITING' : 'PREVIEW, nothing written'}\n`);
for (const [p, label] of Object.entries(PI.PARTIES)) {
    const r = [...rows.values()].filter((x) => x.party === p);
    const nos = (st) => r.filter((x) => st.includes(x.check_status)).length;
    console.log(`${label.padEnd(15)} ${String(r.length).padStart(4)} lines  ${$(r.reduce((a, x) => a + x.amount, 0)).padStart(13)}   on sheet ${nos(['verified', 'match'])}, NOT on sheet ${nos(['not_in_sheet'])}, other ${r.length - nos(['verified', 'match']) - nos(['not_in_sheet'])}   (${r.filter((x) => !have.has(x.key)).length} new)`);
}
const sk = Object.entries(skipped);
if (sk.length) { console.log('\nLeft out:'); sk.forEach(([k, n]) => console.log(`   ${n} × ${k}`)); }
(async () => {
    if (!WRITE) return console.log('\nAdd --write to save these.\n');
    const res = await PI.upsertMany([...rows.values()]);
    console.log(`\nWrote: ${res.added} added, ${res.updated} updated${res.kept_locked ? `, ${res.kept_locked} hand-edited kept` : ''}.\n`);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
