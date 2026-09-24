// ── tests/metals-sheet-sync.js ───────────────────────────────────────────────────
// Apsara, 2026-09-24: "at everyday night,a bot should run which need to update
// my bills and invoices in website from live sheet..if anything is missing,
// enter that as well" — and, on conflicts: "1 with discrepancy should be
// notified via email report", i.e. ADD what is missing, TOUCH nothing that
// exists. First run: "Dry run first — report only, write nothing".
//
// The dangerous behaviours are all on the write side, so that is what this
// pins:
//   B. a row already in Jarvis is NEVER proposed for insert, however different
//   C. and a row Jarvis corrected is never "fixed" back to the sheet's version
//   D. a row with no booking and no container is never inserted at all —
//      unkeyable means it would be added again every single night
//
// Section C is the one that matters most. 260831_SU_26EM05 was billed $13.09
// and corrected on 2026-09-23; the sheet still holds the old figure. A sync
// that wrote it back would undo that fix at 11pm with nobody watching.

const path = require('path');
const ROOT = path.join(__dirname, '..');
const sync = require(path.join(ROOT, 'helpers/metalsSheetSync'));

let pass = 0, fail = 0; const failures = []; const runs = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const bill = (o) => Object.assign({
    booking_no: 'DALA123', container_no: 'KOCU4930737', date: '2026-09-23',
    supplier: 'Gomez', supplier_price: 0.82, supplier_invoice_amount: 39450.20,
    trucking_amount: 930, seal_no: '0617181', description: 'Auto Cast', gross: 79520,
}, o);
const sale = (o) => Object.assign({
    invoice_no: '260923_MC_26MK80', container_no: 'KOCU4930737', booking_no: 'DALA123',
    date: '2026-09-23', customer: 'MK Trading LLC', invoice_price: 610,
    freight_charges: 0, commission_per_mt: 0, seal_no: '0173877', item: 'Regular combo',
}, o);

section('A — identity is booking AND container, never booking alone');
{
    // Her rule, 2026-09-16: "UMXU637049 is a trailer that goes out again next
    // week". Keying on booking alone would call the second trip the first and
    // skip a real bill.
    ck('two containers on one booking are two different rows',
        sync.billKey(bill({ container_no: 'AAAA1111111' })) !== sync.billKey(bill({ container_no: 'BBBB2222222' })));
    ck('the same container on a NEW booking is a different row',
        sync.billKey(bill({ booking_no: 'X1' })) !== sync.billKey(bill({ booking_no: 'X2' })));
    ck('spacing and case do not make a new row',
        sync.billKey(bill({ container_no: ' kocu4930737 ' })) === sync.billKey(bill()));
    ck('a row with neither has NO key', sync.billKey({ booking_no: '', container_no: '' }) === null);
    ck('a sale is keyed by invoice AND container',
        sync.saleKey(sale({ container_no: 'ZZZZ9999999' })) !== sync.saleKey(sale()));
}

section('B — it adds what is missing, and only that');
{
    const r = sync.diff({
        sheetBills: [bill(), bill({ container_no: 'NEWC0000001' })],
        bills: [bill()],
        sheetSales: [sale(), sale({ invoice_no: '260924_XX_26MK81' })],
        sales: [sale()],
    });
    ck('the missing bill is proposed', r.newBills.length === 1 && r.newBills[0].container_no === 'NEWC0000001',
        JSON.stringify(r.newBills.map((b) => b.container_no)));
    ck('the one Jarvis already has is NOT', !r.newBills.some((b) => b.container_no === 'KOCU4930737'));
    ck('the missing invoice is proposed', r.newSales.length === 1);
    ck('and nothing is flagged as changed when they agree',
        r.changedBills.length === 0 && r.changedSales.length === 0,
        JSON.stringify(r.changedBills.concat(r.changedSales)));
}

section('C — A ROW JARVIS ALREADY HAS IS NEVER REWRITTEN');
{
    // The live case. The sheet still says $0.58/lb read as MT; Jarvis holds
    // the corrected figure. The sync must report, never replace.
    const sheetSide = sale({ invoice_price: 25.69 });     // what the sheet still says
    const jarvisSide = sale({ invoice_price: 0.58 });     // what she corrected it to
    const r = sync.diff({ sheetSales: [sheetSide], sales: [jarvisSide] });

    ck('it is NOT proposed as an insert', r.newSales.length === 0, JSON.stringify(r.newSales));
    ck('it IS reported as a disagreement', r.changedSales.length === 1);
    ck('  naming the field', r.changedSales[0].differences.some((d) => d.field === 'invoice_price'));
    ck('  and showing both sides so she can judge',
        r.changedSales[0].differences[0].sheet === 25.69 && r.changedSales[0].differences[0].jarvis === 0.58,
        JSON.stringify(r.changedSales[0].differences[0]));
    // The whole point: the report is data, not an action.
    ck('the report contains no instruction to write anything',
        !('writes' in r) && !('updates' in r) && Array.isArray(r.changedSales));
}

section('D — unkeyable rows are reported, never inserted');
{
    // A row with no booking and no container cannot be matched next time, so
    // inserting it tonight means inserting it again tomorrow, and every night
    // after that. Rows 59-61 of her Packing tab are this shape: an HS code
    // containing a comma shifts every column after it.
    const r = sync.diff({ sheetBills: [bill({ booking_no: '', container_no: '' }), bill()], bills: [bill()] });
    ck('it is not proposed for insert', r.newBills.length === 0, JSON.stringify(r.newBills));
    // Since 2026-09-24 looksLikeShipment catches this one FIRST — no container
    // and no booking is also not a shipment — so it lands in notShipments
    // rather than unkeyed. Either bucket is a report; what matters is that it
    // is never inserted, which the check above pins.
    ck('it is reported rather than written',
        (r.unkeyed.length + r.notShipments.length) === 1,
        JSON.stringify({ unkeyed: r.unkeyed.length, notShipments: r.notShipments.length }));
}

section('E — what counts as a disagreement, and what is just noise');
{
    ck('"1,250.00" and 1250 are the same money', sync.same('1,250.00', 1250));
    ck('$39,450.20 and 39450.2 are the same', sync.same('$39,450.20', 39450.2));
    ck('a cent apart IS different', !sync.same(100.00, 100.02));
    ck('case and spacing are not a difference', sync.same(' Gomez ', 'gomez'));
    // A blank on either side is the normal state of a live sheet she is still
    // filling in — emailing about it nightly would bury the real conflicts.
    ck('blank on the sheet is not a disagreement', sync.same('', 'Gomez'));
    ck('blank in Jarvis is not a disagreement', sync.same('Gomez', ''));
    ck('but two real values that differ ARE', !sync.same('Gomez', 'Freddy'));
    // Derived figures are not watched at all — sheetImport does not import
    // them because Jarvis recomputes them, so a difference is arithmetic.
    ck('no derived total is watched',
        !sync.BILL_WATCH.includes('net') && !sync.BILL_WATCH.includes('amount')
        && !sync.SALE_WATCH.includes('amount'), sync.BILL_WATCH.join(', '));
}

section('F — the one-line summary says what happened');
{
    const quiet = sync.summarise(sync.diff({ sheetBills: [bill()], bills: [bill()] }));
    ck('a quiet night says so', /Nothing new/.test(quiet), quiet);
    const busy = sync.summarise(sync.diff({
        sheetBills: [bill({ container_no: 'NEWC0000001' })], bills: [],
        sheetSales: [sale({ invoice_price: 25.69 })], sales: [sale({ invoice_price: 0.58 })],
    }));
    ck('a busy night counts both', /1 row to add/.test(busy) && /1 disagree/.test(busy), busy);
}

section('G — nothing here can write');
{
    const fs = require('fs');
    const src = fs.readFileSync(path.join(ROOT, 'helpers/metalsSheetSync.js'), 'utf8');
    // This module reads, compares and reports. The moment it grows a write of
    // its own, the batch/undo guarantee from sheetImportWrite is gone.
    for (const forbidden of ['writeFileSync', 'mutateJson', 'appendFileSync', 'saveBill', 'addBill']) {
        ck(`  it never calls ${forbidden}`, !src.includes(forbidden));
    }
    ck('  and exports no commit of its own',
        !Object.keys(sync).some((k) => /^(commit|write|save|apply)/i.test(k)),
        Object.keys(sync).join(', '));
}

section('H — wired for Edge Metals, and ONLY Edge Metals');
{
    const fs = require('fs');
    const sched = fs.readFileSync(path.join(ROOT, 'scheduler.js'), 'utf8');

    ck('a nightly cron calls it', /cron\.schedule\('15 23 \* \* \*'.*nightlyMetalsSheetSync/.test(sched),
        (sched.match(/cron\.schedule\([^\n]*MetalsSheetSync[^\n]*/) || ['(not scheduled)'])[0]);
    ck('  it runs after the 10:45pm cutoff backfill, not alongside it',
        sched.indexOf("'45 22 * * *'") < sched.indexOf("'15 23 * * *'"));

    // ── THE YARD SYNC IS A DIFFERENT JOB AND MUST STAY ONE ────────────────
    // Apsara, 2026-09-24: "Dont touch edge yard.its for edge metals".
    // helpers/sheetSync.js pushes yard loads and expenses OUT to Drive; this
    // reads her metals workbook IN. I overwrote that file once while building
    // this, which would have thrown on a missing export at 11pm.
    const yard = require(path.join(ROOT, 'helpers/sheetSync'));
    for (const fn of ['syncNow', 'runSync', 'monthKeyFor', 'scheduleSync', 'syncStatus']) {
        ck(`  the yard sync still exports ${fn}`, typeof yard[fn] === 'function');
    }
    ck('  and the two are different modules',
        require.resolve(path.join(ROOT, 'helpers/sheetSync'))
        !== require.resolve(path.join(ROOT, 'helpers/metalsSheetSync')));
    ck('  the metals job never requires the yard one',
        !fs.readFileSync(path.join(ROOT, 'helpers/metalsSheetSyncJob.js'), 'utf8').includes("require('./sheetSync')"));
}

section('I — it is a DRY RUN until she turns it on');
{
    const job = require(path.join(ROOT, 'helpers/metalsSheetSyncJob'));
    const before2 = process.env.SHEET_SYNC_WRITE;

    delete process.env.SHEET_SYNC_WRITE;
    ck('with no env flag, writing is off', job.enabled() === false);

    process.env.SHEET_SYNC_WRITE = '1';
    ck('with the flag, writing is armed', job.enabled() === true);
    // Armed is not the same as writing: the CALLER must ask too. Run it for
    // real with the flag set and write NOT requested, and read back what it
    // decided. (The workbook is nonsense on purpose — the dry-run decision is
    // made before anything is parsed, so it holds even when the fetch fails,
    // which is exactly when a job is most likely to do something rash.)
    runs.push(job.runNightly({ buffer: Buffer.from('not a workbook') }).then((r) => {
        ck('  a run that does not ask to write is DRY, flag or no flag', r.dryRun === true, JSON.stringify(r.dryRun));
        ck('  and a broken workbook is an error, not a write',
            r.ok === false && !!r.error && r.committed === null, JSON.stringify({ ok: r.ok, committed: r.committed }));
    }));

    if (before2 === undefined) delete process.env.SHEET_SYNC_WRITE; else process.env.SHEET_SYNC_WRITE = before2;
    ck('the env is left as it was found', process.env.SHEET_SYNC_WRITE === before2);
}

section('J — WHAT THE FIRST DRY RUN CAUGHT (2026-09-24)');
{
    // Run against her live workbook, the job proposed inserting her LEGEND
    // row and two notes as invoices, and listed one invoice twice. Every
    // fixture below is a real row from that run.

    // ── 1. notes and legends are not shipments ────────────────────────────
    const legend = { invoice_no: 'AL-ALUMINIUM COMBO,AP-Scrap Auto Parts,RC-Regular Combo,BT-Battery' };
    const note = { invoice_no: 'QB DONE TILL 5/8' };
    const noteInContainer = { date: '2026-06-30', invoice_no: '260630_BAT_26NT08',
                              container_no: 'Order confirmed on Text with Bose', customer: 'Next Trading' };
    const real = { date: '2026-09-21', invoice_no: '260921_BAT_26MK74',
                   container_no: 'FSCU8671703', customer: 'MK Trading', item: 'BATTERY' };

    ck('her legend row is not a shipment', sync.looksLikeShipment(legend) === false);
    ck('a note to herself is not a shipment', sync.looksLikeShipment(note) === false);
    ck('a sentence in the container cell is not a shipment', sync.looksLikeShipment(noteInContainer) === false);
    ck('a real row still is', sync.looksLikeShipment(real) === true);

    const r = sync.diff({ sheetSales: [legend, note, noteInContainer, real], sales: [] });
    ck('  only the real one is queued to insert',
        r.newSales.length === 1 && r.newSales[0].invoice_no === '260921_BAT_26MK74',
        JSON.stringify(r.newSales.map((x) => x.invoice_no)));
    ck('  and the other three are reported, not written', r.notShipments.length === 3);

    // ── 2. one invoice, several grades ────────────────────────────────────
    // 260923_MC_26MK80 appeared TWICE in the insert list because the key
    // ignored the grade. Both rows are real and both must be kept — as two
    // DIFFERENT rows, not one row inserted twice.
    const mk80 = (item) => ({ date: '2026-09-23', invoice_no: '260923_MC_26MK80',
                              container_no: 'KOCU4930737', customer: 'MK Trading', item });
    const two = sync.diff({ sheetSales: [mk80('Regular combo'), mk80('Al combo')], sales: [] });
    ck('two grades on one invoice are two rows', two.newSales.length === 2);
    ck('  and they have different keys',
        sync.saleKey(mk80('Regular combo')) !== sync.saleKey(mk80('Al combo')));
    // With one of them already stored, only the other is new.
    const one = sync.diff({ sheetSales: [mk80('Regular combo'), mk80('Al combo')],
                            sales: [mk80('Al combo')] });
    ck('  storing one leaves exactly one to add', one.newSales.length === 1
        && one.newSales[0].item === 'Regular combo', JSON.stringify(one.newSales.map((x) => x.item)));

    // ── 3. grades are no longer false disagreements ───────────────────────
    // 251203 25DHATU01 compared Alternators, Starters and Compressors against
    // ONE stored row and called two of them conflicts. Now they are simply
    // different rows.
    const dhatu = (item, price) => ({ date: '2025-12-12', invoice_no: '251203 25DHATU01',
                                      container_no: 'APZU3556287', item, invoice_price: price });
    const d = sync.diff({
        sheetSales: [dhatu('ALTERNATORS', 0.9405), dhatu('STATERS', 0.7614), dhatu('COMPRESSOR', 0.5595)],
        sales: [dhatu('COMPRESSOR', 0.5595)],
    });
    ck('the stored grade is NOT a disagreement', d.changedSales.length === 0,
        JSON.stringify(d.changedSales));
    ck('  and the two unstored grades are simply new', d.newSales.length === 2);

    // ── 4. spacing is not a change of supplier ────────────────────────────
    ck('"Edge Yard" and "EdgeYard" agree', sync.same('Edge Yard', 'EdgeYard'));

    // ── 5. but a REAL price difference is still reported ──────────────────
    // HDMU4953511: sheet 1.32 vs Jarvis 1.07, $37,408.80 vs $30,323.80. The
    // one genuine find in that run, and it must survive every fix above.
    const hd = (price, amt) => ({ date: '2026-09-01', booking_no: 'DALA9', container_no: 'HDMU4953511',
                                  supplier: 'Gomez', supplier_price: price, supplier_invoice_amount: amt });
    const real2 = sync.diff({ sheetBills: [hd(1.32, 37408.8)], bills: [hd(1.07, 30323.8)] });
    ck('a real price difference is still caught', real2.changedBills.length === 1);
    ck('  naming both figures',
        real2.changedBills[0].differences.some((x) => x.field === 'supplier_price' && x.sheet === 1.32 && x.jarvis === 1.07),
        JSON.stringify(real2.changedBills[0].differences));
}

// The async checks finish before the tally — a count printed while a promise
// is still in flight is a green run that proved less than it says.
Promise.all(runs).then(() => {
    console.log(`\n  ${pass} passed, ${fail} failed`);
    if (failures.length) console.log('  failed: ' + failures.join(' | '));
    process.exit(fail ? 1 : 0);
});
