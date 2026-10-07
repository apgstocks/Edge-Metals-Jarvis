#!/usr/bin/env node
// ── scripts/trucker-tabs-to-bills.js ───────────────────────────────────────
// The Jio / Sher / AJ Transport tabs of the Google "Edge Metals" sheet -> the
// trucking split on Jarvis's own bills. Apsara, 2026-10-07: Jarvis is the
// record, keep both in step. Logic: helpers/truckerTabBackfill.js.
//
//   node scripts/trucker-tabs-to-bills.js            # REPORT ONLY, writes nothing
//   node scripts/trucker-tabs-to-bills.js --write    # apply the unambiguous ones
//   node scripts/trucker-tabs-to-bills.js --detail   # list every row, not just counts
//
// RUN IT ON THE VM: the bills are in DATA_DIR there. Elsewhere it compares the
// sheet against an empty ledger and says so.
//
// --write does exactly what the "accept" button does for one bill
// (POST /api/bills/:id/accept-trucking): editBill, then QuickBooks sync, then the
// Shipment sheet row — so the sheet stays in step, and each applied bill is
// pushed to QuickBooks as if she had typed it. It touches ONLY bills with no
// trucking figure and exactly one match. It never overwrites, never picks among
// several grades, and writes no company name over one that is there.
const path = require('path');
const ROOT = path.join(__dirname, '..');
const B = require(path.join(ROOT, 'helpers/truckerTabBackfill'));
const tp = require(path.join(ROOT, 'helpers/truckingProposal'));
const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const DETAIL = argv.includes('--detail');
const $ = (n) => (n == null ? '—' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);

// Mirrors the accept-trucking route, line for line.
async function applyOne(item, { quiet = false } = {}) {
    const bills = require(path.join(ROOT, 'helpers/bills'));
    const cand = item.candidates[0];
    const bill = bills.listWithTotals().find((x) => x.id === cand.bill_id);
    if (!bill) throw new Error(`no bill ${cand.bill_id}`);
    const patch = { trucking_split: tp.splitToSave(item.split, tp.currentOf(bill)) };
    if (item.hauler && !String(bill.trucking_company || '').trim()) patch.trucking_company = item.hauler;
    const saved = await bills.editBill(bill.id, patch);
    if (!quiet) {
        try { require(path.join(ROOT, 'helpers/quickbooks/sync')).after('bill', saved && saved.id); } catch (e) { console.warn('  (QuickBooks sync skipped:', e.message + ')'); }
        try { require(path.join(ROOT, 'helpers/shipmentSheetLog')).logBillSafely(saved, 'edited'); } catch (e) { console.warn('  (Shipment sheet log skipped:', e.message + ')'); }
    }
    return saved;
}

async function readTabs() {
    const { getSheets, getOrCreateSpreadsheetId } = require(path.join(ROOT, 'helpers/proformaSheetLog'));
    const sheets = getSheets(), id = await getOrCreateSpreadsheetId();
    const tabs = {};
    for (const [kind, tab] of [['jio', 'Jio'], ['sher', 'Sher'], ['aj', 'AJ Transport']]) {
        try { tabs[kind] = ((await sheets.spreadsheets.values.get({ spreadsheetId: id, range: `'${tab}'!A1:Z5000` })).data.values) || []; }
        catch (e) { console.log(`(tab "${tab}": ${e.message})`); }
    }
    return tabs;
}

async function main() {
    const bills = require(path.join(ROOT, 'helpers/bills'));
    const all = bills.listWithTotals();
    console.log(`\nSheet trucker tabs -> Jarvis bills   (${all.length} bills in this ledger)  ${WRITE ? 'WRITING' : 'REPORT ONLY, nothing written'}\n`);
    if (!all.length) console.log('  !! this ledger has NO bills — you are probably not on the VM. Everything below will read "no bill".\n');
    const p = B.plan(await readTabs(), all);
    console.log('Rows read from tabs:', Object.entries(p.counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none');
    const line = (i) => `   ${i.tab.padEnd(14)} ${(i.join_by === 'booking' ? i.booking_no : i.container_no || '').padEnd(14)} ${$(i.proposed_total).padStart(11)}  inv ${i.invoice_no || '—'}`;
    const section = (title, rows, why) => {
        console.log(`\n${title}: ${rows.length}${rows.length ? '' : ''}`);
        if (why && rows.length) console.log(`   (${why})`);
        if (DETAIL || rows.length <= 8) rows.forEach((r) => console.log(line(r) + (r.disagreements ? '' : '') + (r.candidates && r.candidates[0] && r.candidates[0].disagreements.length ? '  differs: ' + r.candidates[0].disagreements.map((d) => `${d.field} sheet ${$(d.invoice)} vs bill ${$(d.bill)}`).join('; ') : '') + (r.status === 'several_bills' ? `  (${r.candidates.length} bills)` : '')));
    };
    section('WOULD ADD to a bill with no trucking figure', p.to_add, 'one bill matches; --write applies these');
    section('Already on the bill, same figures', p.already_there);
    section('SHEET AND BILL DISAGREE — left alone, you decide', p.differs, 'never overwritten');
    section('Container is several bills (one per grade) — you pick the row', p.several, 'one haul is charged once; I will not guess which grade');
    section('No bill carries this container/booking', p.no_bill, 'bill not entered yet, or a typo in the tab');
    section('Could not be matched at all', p.no_key);
    const addTotal = p.to_add.reduce((a, i) => a + i.proposed_total, 0);
    console.log(`\nWould add ${p.to_add.length} bill(s), ${$(addTotal)} of haulage in total.`);
    if (!WRITE) return console.log('Add --write to apply those, and only those.\n');
    let ok = 0, bad = 0;
    for (const item of p.to_add) { try { await applyOne(item); ok++; } catch (e) { bad++; console.log(`  FAILED ${item.container_no || item.booking_no}: ${e.message}`); } }
    console.log(`\nApplied ${ok}${bad ? `, ${bad} failed` : ''}. Nothing else was touched.\n`);
}

if (require.main === module) main().catch((e) => { console.error('failed:', e.message); process.exit(1); });
module.exports = { applyOne };
