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

  // ── invoices ── (detection lives in helpers/onePerContainer.js, shared with Fix-it)
  const opc = require(path.join(ROOT, 'helpers/onePerContainer'));
  const inv = opc.invoices(sales.list());
  const drop = [];
  for (const g of inv.found) {
    console.log(`\n${g.container} (${g.booking || 'no booking'}): ${g.drop.length + 1} invoices — keeping ${g.keep.invoice_no}`);
    for (const d of g.drop) {
      console.log(`   drop ${d.invoice_no}: ${d.rows.length} row(s) ${d.rows.map((r) => r.item || '—').join(', ')}`);
      drop.push(...d.rows);
    }
  }
  inv.skipped.forEach((s2) => console.log(`\nSKIPPED ${s2.container}: ${s2.why} — left alone`));
  let planned = null;
  if (drop.length) {
    planned = bd.plan('sales', drop.map((r) => r.id), { reason: 'one invoice per container — keep latest (2026-11-13)' });
    console.log(`\nInvoices: ${planned.going.length} row(s) to delete, ${planned.refused.length} refused.`);
    planned.refused.forEach((x) => console.log(`   refused ${x.id} (${x.what}) — ${x.why}`));
  } else console.log('\nInvoices: every container has a single invoice.');

  // ── packing lists ──
  const pl = require(path.join(ROOT, 'helpers/packingList'));
  const plDrop = [];
  for (const g of opc.packingLists(pl.list()).found) {
    console.log(`\nPacking list ${g.container}: ${g.drop.length + 1} lists — keeping the one updated ${g.keep.updated_at || '?'}`);
    plDrop.push(...g.drop);
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
