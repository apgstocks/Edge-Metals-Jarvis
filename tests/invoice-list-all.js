// ── tests/invoice-list-all.js ─────────────────────────────────────────────
// invoiceSheet.listAllInvoices was deleted by commit 8dc3495 ("INV BY INV
// NO"), which wrote the file back from an older copy. helpers/receivables.js
// never stopped calling it, so every receivables question has thrown since —
// and on 2026-10-03 Apsara hit it twice over WhatsApp while trying to record
// a SUPPLIER PAYMENT:
//
//     Couldn't record that: invoiceSheet.listAllInvoices is not a function
//
// An error about a feature she was not using, for a function nobody had
// noticed was gone. That deletion is the one scripts/check-action-wiring.js
// was written for; it has sat broken because the wiring check sees intents
// routed at actions, and cannot see a helper calling a helper.
//
// ── THE TWO PROPERTIES THAT MATTER ────────────────────────────────────────
//
//   1. ONE ROW PER INVOICE. The sheet is per container and an invoice can
//      span several. receivables subtracts an invoice's payments from the row
//      it is handed, so one row per container would subtract the whole
//      payment from EACH and report the invoice as wildly overpaid.
//
//   2. THE SAME ARITHMETIC AS THE DOCUMENTS. amount = round2(weight * rate)
//      PER LINE, summed, minus freight once. Rounding per line is deliberate
//      (Apsara, 2026-08-28): the printed total must equal what is beside each
//      row when someone adds it up by hand. That exact call was lost once
//      before, to commit 37b3513, and the Excel invoice quietly began
//      disagreeing with the PDF of the same invoice.
//
//      So this file checks listAllInvoices against the arithmetic SPELLED OUT
//      here from her rule, not against whatever the function happens to
//      return. A test that reads the implementation back to itself proves
//      nothing.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-invlist-'));
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const sheet = require(path.join(ROOT, 'helpers/invoiceSheet'));

// The sheet, as CSV, served to fetchRawSheet by stubbing global fetch. Real
// column headings, because buildColumnMap matches on them and a test with
// invented headings would pass while the live sheet returned nothing.
const CSV = [
    'Consignee,Inv No.,Inv Date,Container No.,Item Description,Weight,Inv Price,Freight Charge',
    // ONE invoice, TWO containers — the merged case that breaks if rows are
    // returned per container.
    'Aris Enterprises,260918_AC_26Aris02,09/18/2026,MSDU2726332,Alternator,13.5,1.15,500',
    'Aris Enterprises,260918_AC_26Aris02,09/18/2026,KOCU4401728,Starter,13.5,1.15,',
    // A second, single-container invoice with no freight.
    'HYNOS,260920_AC_26HY01,09/20/2026,TGCU0053611,Compressor,20,2.00,',
    // A row with no invoice number is not an invoice.
    'Somebody,,09/21/2026,XXXU1111111,Scrap,5,1.00,',
].join('\n');

global.fetch = async () => ({ ok: true, status: 200, text: async () => CSV });

const round2 = (n) => Math.round(n * 100) / 100;

(async () => {

// ── A — ONE ROW PER INVOICE ───────────────────────────────────────────────
{
    section('A — the shape receivables needs');

    const list = await sheet.listAllInvoices(true);
    ck('it returns a list', Array.isArray(list), typeof list);
    ck('  one row per INVOICE, not per container', list.length === 2,
       `${list.length} rows from 2 invoices across 3 container lines — per-container `
       + 'rows would make receivables subtract the whole payment from each');

    const aris = list.find((i) => i.inv_no === '260918_AC_26Aris02');
    ck('the merged invoice is one row', !!aris);
    ck('  carrying both containers', !!aris
        && aris.containers.includes('MSDU2726332') && aris.containers.includes('KOCU4401728'),
       JSON.stringify(aris && aris.containers));

    // receivables reads these three by name. Missing any of them is a crash
    // or a silent null, not a wrong number.
    for (const f of ['inv_no', 'inv_date', 'final_amount']) {
        ck(`  every row has ${f}`, list.every((i) => i[f] !== undefined && i[f] !== null),
           JSON.stringify(list.map((i) => i[f])));
    }

    ck('a row with no invoice number is skipped',
       !list.some((i) => !String(i.inv_no || '').trim()),
       'a sheet line with no invoice is not an invoice');
}

// ── B — THE ARITHMETIC, FROM HER RULE ─────────────────────────────────────
// Computed here from the fixture by hand, so a change to how the function
// sums cannot quietly redefine what is correct.
{
    section('B — the same figures the documents print');

    const list = await sheet.listAllInvoices(true);
    const aris = list.find((i) => i.inv_no === '260918_AC_26Aris02');
    const hynos = list.find((i) => i.inv_no === '260920_AC_26HY01');

    // PER LINE rounding, her rule: 13.5 * 1.15 is 15.524999999999999 raw.
    const line1 = round2(13.5 * 1.15);          // 15.52
    const line2 = round2(13.5 * 1.15);          // 15.52 — same line twice, on purpose
    const subtotal = round2(line1 + line2);     // 31.04 per line
    const expected = round2(subtotal - 500);    // freight SUBTRACTED, once

    ck(`  line 1 rounds to ${line1}`, line1 === 15.52, String(line1));
    ck('the merged invoice subtotals per line, then sums',
       aris.subtotal === subtotal, `${aris.subtotal} vs ${subtotal}`);
    ck('  freight counted ONCE for the invoice, not per line',
       aris.freight === 500, String(aris.freight));
    ck('  and SUBTRACTED, as both document builders do',
       aris.final_amount === expected, `${aris.final_amount} vs ${expected}`);

    ck('an invoice with no freight is just its subtotal',
       hynos.final_amount === round2(20 * 2.00) && hynos.freight === 0,
       `${hynos.final_amount} / freight ${hynos.freight}`);

    // ── THE TRAP THE PER-LINE RULE EXISTS FOR ────────────────────────────
    // Summing raw and rounding once gives a different answer, and it is the
    // answer that does not match the printed document.
    // 15.524999... + 15.524999... = 31.049999... which rounds to 31.05.
    // Per line it is 31.04. The two disagree by a cent, and the cent that
    // matters is the one printed on the document.
    const naive = round2(13.5 * 1.15 + 13.5 * 1.15);
    if (naive !== subtotal) {
        ck('  per-line rounding differs from rounding at the end, and we use per-line',
           aris.subtotal === subtotal && aris.subtotal !== naive,
           `per-line ${subtotal} vs naive ${naive}`);
    } else {
        ck('  (this fixture does not separate the two roundings)', true);
    }
}

// ── C — RECEIVABLES CAN ACTUALLY USE IT ───────────────────────────────────
// The point of restoring it. A function that exists but does not satisfy its
// one caller has fixed nothing.
{
    section('C — the caller that has been throwing since 8dc3495');

    const receivables = require(path.join(ROOT, 'helpers/receivables'));
    let err = null; let ledger = null;
    try { ledger = await receivables.buildLedger({ includeHistory: true }); }
    catch (e) { err = e; }

    ck('buildLedger no longer throws', !err, err && err.message);
    ck('  and returns rows', !!ledger && Array.isArray(ledger.rows || ledger),
       ledger ? Object.keys(ledger).join(',') : 'null');

    const rows = (ledger && (ledger.rows || ledger)) || [];
    ck('  one row per invoice, with a balance',
       rows.length === 2 && rows.every((r) => r.balance !== undefined),
       `${rows.length} rows`);
}

// ── D — IT IS EXPORTED ────────────────────────────────────────────────────
// How it broke last time: the function was gone from the exports and nothing
// noticed, because no INTENT routes at it — check-action-wiring sees
// brain -> actions, not helper -> helper.
{
    section('D — the export itself');

    ck('listAllInvoices is exported', typeof sheet.listAllInvoices === 'function');

    const src = fs.readFileSync(path.join(ROOT, 'helpers/receivables.js'), 'utf8');
    const calls = [...src.matchAll(/invoiceSheet\.([a-zA-Z0-9_]+)\s*\(/g)].map((m) => m[1]);
    const missing = [...new Set(calls)].filter((n) => typeof sheet[n] !== 'function');
    ck('every invoiceSheet function receivables calls exists',
       missing.length === 0,
       missing.join(', ') + ' — this is the exact shape of the 8dc3495 break');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('threw:', e.message); process.exit(1); });
