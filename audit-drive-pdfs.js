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
const { loadBookings } = require('./helpers/json');

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
    console.log(`Found ${files.length} PDF(s). Checking each against classifyDocument()...\n`);

    const bookings = loadBookings();
    const results = [];

    for (const f of files) {
        const bkgGuess = f.name.replace(/\.pdf$/i, '');
        const trackedBooking = bookings[bkgGuess] || null;

        let classification = null;
        try {
            const base64 = await downloadPdfById(f.id);
            classification = await classifyDocument(base64);
        } catch (err) {
            console.error(`  Failed to check ${f.name}:`, err.message);
        }

        const flaggedNotBooking = !!classification && (!classification.is_booking_confirmation || classification.is_invoice_or_other);
        results.push({ file: f.name, fileId: f.id, bkgGuess, trackedInBookingsJson: !!trackedBooking, classification, flaggedNotBooking });

        const label = classification
            ? `${classification.is_booking_confirmation ? 'BOOKING' : 'NOT-BOOKING'} (${classification.document_type || '?'})`
            : 'CHECK FAILED';
        console.log(`${f.name.padEnd(28)} tracked=${String(!!trackedBooking).padEnd(5)} -> ${label}`);
    }

    const flagged     = results.filter(r => r.flaggedNotBooking);
    const checkFailed = results.filter(r => !r.classification);

    console.log('\n=== SUMMARY ===');
    console.log(`Total PDFs checked: ${results.length}`);
    console.log(`Flagged as NOT a booking confirmation: ${flagged.length}`);
    console.log(`Could not be checked (API error): ${checkFailed.length}`);

    if (flagged.length) {
        console.log('\nFlagged files — review manually, nothing was changed:');
        flagged.forEach(r => console.log(
            `  ${r.file}  [${r.classification.document_type || 'unknown'}]  ` +
            `bookings.json record: ${r.trackedInBookingsJson ? `YES — a real booking exists for ${r.bkgGuess}, check its fields` : 'no'}`
        ));
    }
    if (checkFailed.length) {
        console.log('\nCould not classify (transient API errors — rerun to retry):');
        checkFailed.forEach(r => console.log(`  ${r.file}`));
    }
}

main().catch((err) => { console.error('Crashed:', err); process.exit(1); });
