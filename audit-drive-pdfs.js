// ── audit-drive-pdfs.js — ONE-TIME, READ-ONLY check: which PDFs stored in
// the Drive booking folder are NOT actually booking confirmations?
//
// Real report: invoices that merely mention a booking/container number were
// getting is_booking_confirmation:true from the (now-fixed) extraction
// pipeline and getting uploaded/associated as if they were real booking
// PDFs. This script does NOT touch Drive or bookings.json in any way — it
// only lists every PDF in the configured Drive folder, runs the same
// independent classifyDocument() check workflow/emailWatcher.js now
// requires, and reports which ones are NOT booking confirmations so you can
// decide what to do with each one by hand.
//
//   node audit-drive-pdfs.js
//
// Naming convention (see helpers/drive.js's uploadPdfToDrive) is
// <BOOKING_NUMBER>.pdf, so the filename (minus extension) is also checked
// against bookings.json to show whether a booking RECORD exists for it —
// helpful for telling "phantom booking created from an invoice" apart from
// "a real booking's PDF just happens to also look like it might not
// classify as a confirmation" (e.g. a scan quality issue).

const { listAllPdfs, downloadPdfById } = require('./helpers/drive');
const { classifyDocument } = require('./helpers/gemini');
const { loadBookings, loadWorkflow } = require('./helpers/json');

async function main() {
    console.log('=== Drive PDF audit — read-only, changes nothing ===\n');

    let files;
    try {
        files = await listAllPdfs();
    } catch (err) {
        console.error('Could not list Drive files:', err.message);
        process.exit(1);
    }
    if (!files.length) {
        console.log('No PDFs found in the configured Drive folder.');
        return;
    }
    // Duplicate filenames — a real bug found via a live audit (DALA79158000.pdf
    // and DALA62677900.pdf each existed twice): uploadPdfToDrive()'s "does this
    // already exist" check and its "create new" call aren't atomic, so two
    // overlapping uploads for the same booking number (e.g. two overlapping
    // emailWatcher.run() cron ticks — now fixed separately) could each create
    // their own file before either one was visible to the other's existence
    // check. Unlike a normal filesystem, Drive allows two files with the same
    // name in the same folder, so this doesn't error — it silently doubles up.
    // Reported here, not auto-resolved: deleting the wrong copy would be worse
    // than leaving both, so this just surfaces file IDs + modified times so you
    // can open each in Drive and decide which one to keep.
    const byName = new Map();
    for (const f of files) {
        if (!byName.has(f.name)) byName.set(f.name, []);
        byName.get(f.name).push(f);
    }
    const duplicateGroups = [...byName.entries()].filter(([, group]) => group.length > 1);
    if (duplicateGroups.length) {
        console.log(`\n=== DUPLICATE FILENAMES — ${duplicateGroups.length} booking(s) have more than one Drive file ===`);
        duplicateGroups.forEach(([name, group]) => {
            console.log(`  ${name}:`);
            group
                .slice()
                .sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime))
                .forEach((f, i) => console.log(`    ${i === 0 ? '(newest)' : '        '} id=${f.id}  modified=${f.modifiedTime}`));
        });
        console.log('  Nothing was changed. Open each file ID in Drive, confirm which one is the real/current confirmation, then trash the other(s) by hand.\n');
    }

    console.log(`Found ${files.length} PDF(s). Checking each against classifyDocument()...\n`);

    const bookings = loadBookings();
    const workflow = loadWorkflow();
    const results = [];

    for (const f of files) {
        const bkgGuess = f.name.replace(/\.pdf$/i, '');
        const trackedBooking = bookings[bkgGuess] || null;
        const wfStep = workflow[bkgGuess]?.step || (trackedBooking ? 'not_started' : null);

        let classification = null;
        try {
            const base64 = await downloadPdfById(f.id);
            classification = await classifyDocument(base64);
        } catch (err) {
            console.error(`  Failed to check ${f.name}:`, err.message);
        }

        const flaggedNotBooking = !!classification && (!classification.is_booking_confirmation || classification.is_invoice_or_other);
        results.push({ file: f.name, fileId: f.id, bkgGuess, trackedInBookingsJson: !!trackedBooking, wfStep, trackedBooking, classification, flaggedNotBooking });

        const label = classification
            ? `${classification.is_booking_confirmation ? 'BOOKING' : 'NOT-BOOKING'} (${classification.document_type || '?'})`
            : 'CHECK FAILED';
        console.log(`${f.name.padEnd(28)} tracked=${String(!!trackedBooking).padEnd(5)} stage=${(wfStep || '-').padEnd(18)} -> ${label}`);
    }

    const flagged     = results.filter(r => r.flaggedNotBooking);
    const checkFailed = results.filter(r => !r.classification);

    console.log('\n=== SUMMARY ===');
    console.log(`Total PDFs checked: ${results.length}`);
    console.log(`Flagged as NOT a booking confirmation: ${flagged.length}`);
    console.log(`Could not be checked (API error): ${checkFailed.length}`);

    if (flagged.length) {
        console.log('\nFlagged files — review manually, nothing was changed:');
        // Workflow stage turned out NOT to be a usable signal in practice — real
        // production data showed every booking checked sitting at "not_started"
        // regardless of whether it had actually shipped, so a stage-based
        // "late stage = safe to archive" rule would silently mislabel almost
        // everything. Dropped that. Using booking DATA COMPLETENESS instead:
        // a real booking (confirmation just got overwritten by a later doc like
        // a B/L) still has real carrier/vessel fields from when it was first
        // created. A phantom booking created FROM the flagged document itself
        // (the invoice-auto-create bug, pre-dating the classification gate fix)
        // tends to have thin/placeholder fields, because there was never a real
        // confirmation to extract them from. This is still a HINT, not a
        // verdict — the actual field values are printed so you can judge it
        // yourself; don't archive anything without looking.
        const looksReal = (b) => !!b && !!b.carrier && b.carrier !== '?' && !!b.vessel_voyage;
        flagged.forEach(r => {
            const b = r.trackedBooking;
            let suggestion;
            if (!b) {
                suggestion = 'no bookings.json record — nothing "active" to remove; stray Drive file only';
            } else if (looksReal(b)) {
                suggestion = `booking record has real freight data — looks like a genuine booking whose PDF got replaced by a ${r.classification.document_type || 'later document'}. Verify it actually shipped/matches, then archive from the dashboard if so.`;
            } else {
                suggestion = `booking record looks thin (carrier="${b.carrier || 'null'}", vessel="${b.vessel_voyage || 'null'}") — may be a PHANTOM booking created from this very document rather than a real booking that got overwritten. Look closer before archiving.`;
            }
            console.log(
                `  ${r.file}  [${r.classification.document_type || 'unknown'}]  ` +
                `bookings.json record: ${b ? `YES — ${r.bkgGuess}` : 'no'}` +
                (b ? `  (carrier="${b.carrier || 'null'}", pol="${b.port_of_loading || 'null'}", pod="${b.port_of_discharge || 'null'}", vessel="${b.vessel_voyage || 'null'}", cutoff="${b.cutoff_date || 'null'}", created="${b.created_at || 'null'}")` : '') +
                `\n    -> ${suggestion}`
            );
        });
    }
    if (checkFailed.length) {
        console.log('\nCould not classify (transient API errors — rerun to retry):');
        checkFailed.forEach(r => console.log(`  ${r.file}`));
    }
}

main().catch((err) => { console.error('Crashed:', err); process.exit(1); });
