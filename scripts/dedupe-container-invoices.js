#!/usr/bin/env node
// ── scripts/dedupe-container-invoices.js — keep the latest, delete true repeats ─
//   node scripts/dedupe-container-invoices.js --container TLLU2110739 --ids ID1,ID2,ID3
//   node scripts/dedupe-container-invoices.js ... --write
//
// Apsara, 2026-11-13: TLLU2110739 on NAM8234010 is a combo load (alternator /
// aluminium starter / AC compressors) with 3 invoices — "if this is the case,
// keep only the latest invoice, delete the rest".
//
// "IF THIS IS THE CASE" is the part this script checks. sales.json holds one
// ROW PER ITEM, and rows saved in one operation share the id timestamp (see
// scripts/duplicate-invoices.js). Three ids with the SAME timestamp, each a
// different item, are ONE invoice with three lines — deleting two of them
// deletes real revenue. So it only deletes rows that are repeats of a kept
// row: same container, invoice number, item, weight and amount. Anything else
// is reported and left alone.
//
// Deletion goes through helpers/ledgerBulkDelete (archive first, refuses rows
// with payments or live claims, restorable). Dry run unless --write.
const path = require('path');
const ROOT = path.join(__dirname, '..');
const arg = (n) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : ''; };
const write = process.argv.includes('--write');
const container = String(arg('container') || '').toUpperCase();
const ids = String(arg('ids') || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!container || ids.length < 2) { console.error('usage: --container CODE --ids ID1,ID2[,...] [--write]'); process.exit(2); }

(async () => {
  const sales = require(path.join(ROOT, 'helpers/sales'));
  const bd = require(path.join(ROOT, 'helpers/ledgerBulkDelete'));
  const all = sales.list();
  const rows = ids.map((id) => all.find((r) => r.id === id) || null);
  const missing = ids.filter((id, i) => !rows[i]);
  if (missing.length) { console.log('Not found (already deleted?):', missing.join(', ')); }
  const have = rows.filter(Boolean);
  const wrong = have.filter((r) => String(r.container_no || '').toUpperCase() !== container);
  if (wrong.length) { console.log('STOP — these are not on', container + ':', wrong.map((r) => r.id + ' (' + r.container_no + ')').join(', ')); process.exit(1); }
  const stamp = (r) => String(r.id).split('_')[1];
  const key = (r) => [r.invoice_no, r.item, r.weight, r.invoice_price, r.invoice_amount || r.amount, r.customer].map((v) => String(v ?? '').trim().toLowerCase()).join('|');
  const when = (r) => r.updated_at || r.created_at || '';
  have.forEach((r) => console.log(`  ${r.id}  inv ${r.invoice_no || '—'}  ${r.item || '—'}  wt ${r.weight ?? '—'}  price ${r.invoice_price ?? '—'}  cust ${r.customer || '—'}  saved ${when(r) || 'unknown'}`));
  const distinctItems = new Set(have.map(key));
  const sameStamp = new Set(have.map(stamp)).size === 1;
  if (distinctItems.size === have.length) {
    console.log(`\nNOT DUPLICATES. ${have.length} rows, each a different line${sameStamp ? ', all saved in the SAME operation' : ''} — this is one invoice with several items (a combo load), not repeated invoices.`);
    console.log('Nothing deleted. If one of these lines is genuinely wrong, tell me which and I will remove just that.');
    return;
  }
  // true repeats: newest of each identical group stays
  const groups = new Map();
  have.forEach((r) => { const k = key(r); (groups.get(k) || groups.set(k, []).get(k)).push(r); });
  const drop = [];
  for (const g of groups.values()) {
    g.sort((a, b) => String(when(b)).localeCompare(String(when(a))) || String(b.id).localeCompare(String(a.id)));
    drop.push(...g.slice(1));
  }
  const planned = bd.plan('sales', drop.map((r) => r.id), { reason: `repeat invoice on ${container} — keep latest (2026-11-13)` });
  console.log(`\nKeeping ${have.length - drop.length}, deleting ${planned.going.length}, refused ${planned.refused.length}.`);
  planned.refused.forEach((x) => console.log('  refused', x.id, '-', x.why));
  if (!write) { console.log('Dry run. Add --write to delete (archived; restorable).'); return; }
  const res = await bd.commit(planned);
  console.log('Removed', res.removed, '— batch', res.batch, '(restorable from the archive).');
})().catch((e) => { console.error(e.message); process.exit(1); });
