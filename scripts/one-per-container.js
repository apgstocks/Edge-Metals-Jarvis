#!/usr/bin/env node
// ── scripts/one-per-container.js — one container, one invoice, one packing list ─
//   node scripts/one-per-container.js            # dry run: what would go
//   node scripts/one-per-container.js --write    # do it
//
// Apsara, 2026-11-13: "For one container one invoice should be there ... so as
// one packing list", and, asked how: "if its more than one invoice, just keep
// the latest one only". One invoice = one INVOICE NUMBER; a combo load has
// several item rows under that number and they all stay.
//
// INVOICES. Rows are grouped by container + booking (a container number is
// reused months later on a different booking — that is a different shipment,
// not a repeat). Within a group, if there is more than one invoice number the
// newest invoice stays and the older invoices' rows go. Deleting goes through
// helpers/ledgerBulkDelete: archived first, restorable, and a row with
// payments or a live claim is REFUSED and reported — never force-deleted.
// A group where any row has no invoice number is reported, not touched: with
// no number there is no telling which rows belong together.
//
// PACKING LISTS. save() already replaces by container, so duplicates only
// exist from older saves. Newest by updated_at stays; the rest are copied to
// data/deleted_packing_lists.json before removal.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const write = process.argv.includes('--write');
const U = (v) => String(v == null ? '' : v).trim().toUpperCase();
const ckey = (v) => U(v).replace(/[^A-Z0-9]/g, '');
const stampOf = (r) => String(r.updated_at || r.created_at || '') || new Date(Number(String(r.id).split('_')[1]) || 0).toISOString();

(async () => {
  const sales = require(path.join(ROOT, 'helpers/sales'));
  const bd = require(path.join(ROOT, 'helpers/ledgerBulkDelete'));
  const cfg = require(path.join(ROOT, 'config'));

  // ── invoices ──
  const groups = new Map();
  for (const r of sales.list()) {
    const c = ckey(r.container_no); if (!c) continue;
    const k = c + '|' + U(r.booking_no);
    (groups.get(k) || groups.set(k, []).get(k)).push(r);
  }
  const drop = [], skipped = [];
  for (const [k, rows] of groups) {
    const byInv = new Map();
    for (const r of rows) (byInv.get(U(r.invoice_no)) || byInv.set(U(r.invoice_no), []).get(U(r.invoice_no))).push(r);
    if (byInv.size < 2) continue;
    if (byInv.has('')) { skipped.push(`${rows[0].container_no}: some rows have no invoice number — left alone`); continue; }
    const newest = (rs) => rs.map(stampOf).sort().pop();
    const ranked = [...byInv.entries()].sort((a, b) => newest(b[1]).localeCompare(newest(a[1])));
    console.log(`\n${rows[0].container_no} (${rows[0].booking_no || 'no booking'}): ${byInv.size} invoices — keeping ${ranked[0][0]}`);
    for (const [inv, rs] of ranked.slice(1)) {
      console.log(`   drop ${inv}: ${rs.length} row(s) ${rs.map((r) => r.item || '—').join(', ')}`);
      drop.push(...rs);
    }
  }
  skipped.forEach((s) => console.log('\nSKIPPED ' + s));
  let planned = null;
  if (drop.length) {
    planned = bd.plan('sales', drop.map((r) => r.id), { reason: 'one invoice per container — keep latest (2026-11-13)' });
    console.log(`\nInvoices: ${planned.going.length} row(s) to delete, ${planned.refused.length} refused.`);
    planned.refused.forEach((x) => console.log(`   refused ${x.id} (${x.what}) — ${x.why}`));
  } else console.log('\nInvoices: every container has a single invoice.');

  // ── packing lists ──
  const pl = require(path.join(ROOT, 'helpers/packingList'));
  const pg = new Map();
  for (const r of pl.list()) { const c = ckey(r.container_no); if (!c) continue; (pg.get(c) || pg.set(c, []).get(c)).push(r); }
  const plDrop = [];
  for (const rows of pg.values()) {
    if (rows.length < 2) continue;
    rows.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    console.log(`\nPacking list ${rows[0].container_no}: ${rows.length} lists — keeping the one updated ${rows[0].updated_at || '?'}`);
    plDrop.push(...rows.slice(1));
  }
  console.log(plDrop.length ? `Packing lists: ${plDrop.length} to delete.` : 'Packing lists: every container has a single list.');

  if (!write) { console.log('\nDry run. Add --write to apply.'); return; }
  if (planned && planned.going.length) {
    const res = await bd.commit(planned);
    console.log(`\nInvoices removed: ${res.removed} (batch ${res.batch}, restorable).`);
  }
  if (plDrop.length) {
    const arch = path.join(path.dirname(cfg.PACKING_LISTS_FILE), 'deleted_packing_lists.json');
    let old = []; try { old = JSON.parse(fs.readFileSync(arch, 'utf8')); } catch (e) { /* none yet */ }
    fs.writeFileSync(arch, JSON.stringify(old.concat(plDrop.map((r) => ({ ...r, _deleted_at: new Date().toISOString() }))), null, 2));
    for (const r of plDrop) await pl.remove(r.id);
    console.log(`Packing lists removed: ${plDrop.length} (copies kept in deleted_packing_lists.json).`);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
