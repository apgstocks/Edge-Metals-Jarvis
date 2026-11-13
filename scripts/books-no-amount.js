#!/usr/bin/env node
// ── scripts/books-no-amount.js — which rows "could not be posted" ───────────
//   node scripts/books-no-amount.js
// The accounts email says "5× metals-purchase has no amount", "2× yard-purchase",
// "2× yard-sale" but not WHICH rows. This lists them: the store, the row id, the
// date, who, and what the row holds, so each can be fixed (or deleted) on its
// own screen. READ-ONLY. It builds the journal and writes nothing.
const path = require('path');
const ROOT = path.join(__dirname, '..');
const P = require(path.join(ROOT, 'helpers/postings'));
let captured = [];
const orig = P.journal;
P.journal = (txs) => { captured = txs; return orig.call(P, txs); };
const out = require(path.join(ROOT, 'helpers/booksBuild')).build({});
const num = (v) => Number(v) || 0;
const bad = captured.filter((t) => Math.abs(num(t.amount)) < 0.005 && t.kind !== 'advance-applied');
const stores = { bills: 'bills', sales: 'sales', loads: 'loads', outbound_loads: 'outbound_loads' };
console.log(`${bad.length} entr${bad.length === 1 ? 'y' : 'ies'} with no amount (of ${captured.length}); journal problems: ${out.problems.length}\n`);
for (const t of bad) {
  const s = t.source || {};
  let raw = null;
  try {
    if (s.store === 'bills') raw = require(path.join(ROOT, 'helpers/bills')).listWithTotals().find((r) => r.id === s.id);
    else if (s.store === 'loads') raw = require(path.join(ROOT, 'helpers/loads')).loadLoads().find((r) => r.id === s.id);
    else if (s.store === 'outbound_loads') raw = require(path.join(ROOT, 'helpers/outboundLoads')).loadOutboundLoads().find((r) => r.id === s.id);
  } catch (e) { /* the row may simply be gone */ }
  console.log(`${t.kind}  ${t.date || 'no date'}  ${t.party || 'no party'}  ${t.memo || ''}`);
  console.log(`    store ${s.store || '?'}  id ${s.id || '?'}  entity ${t.entity}`);
  if (raw) console.log('    row: ' + ['container_no', 'invoice_no', 'item', 'weight', 'price', 'amount', 'net_payable', 'seller', 'buyer', 'note']
    .filter((k) => raw[k] != null && raw[k] !== '').map((k) => `${k}=${raw[k]}`).join('  '));
}
const other = out.problems.map(String).filter((p) => !/has no amount/.test(p));
if (other.length) { console.log('\nOther journal problems:'); other.forEach((p) => console.log('  ' + p)); }
