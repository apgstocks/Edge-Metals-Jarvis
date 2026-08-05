// ── discard-drive-pdf.js — ONE-TIME manual cleanup: remove the WRONG PDF
// from Drive for specific bookings whose confirmation got silently
// overwritten by a later document (Bill of Lading, invoice, insurance cert)
// sharing the same booking/reference number. Built 2026-08-05 after
// audit-drive-pdfs.js flagged 6 real bookings whose Drive slot now holds the
// wrong document type — see helpers/drive.js's uploadPdfToDrive() for the
// fix that stops this from happening again going forward. This script only
// cleans up bookings already affected before that fix existed.
//
// IMPORTANT — this does NOT archive or delete the booking itself.
// bookings.json stays exactly as-is except for two fields:
//   - Trashes the Drive file (soft delete — Drive auto-purges after 30
//     days, same as helpers/drive.js's deletePdfByBooking elsewhere).
//   - Clears pdf_drive_id / pdf_uploaded_at on the booking record.
// That second part matters and is easy to miss: if pdf_drive_id is left
// pointing at a now-trashed file, workflow/emailWatcher.js's "only upload
// once per booking" guard (`if (bookings[bkg].pdf_drive_id) skip upload`)
// would keep thinking a PDF is already on file and silently refuse to
// accept the REAL confirmation if the carrier ever resends it. Clearing the
// stamp is what makes this booking eligible for a proper re-upload again.
//
//   node discard-drive-pdf.js GLTOEH-27365 GLTOEH-27149      # dry run
//   node discard-drive-pdf.js GLTOEH-27365 GLTOEH-27149 --apply
//
// Always run without --apply first and read the output.

const { deletePdfByBooking, findPdfByBooking } = require('./helpers/drive');
const { loadBookings, mutateJson } = require('./helpers/json');
const { appendAuditLog } = require('./helpers/auditlog');
const cfg = require('./config');

const APPLY = process.argv.includes('--apply');
const bkgNos = process.argv.slice(2).filter(a => !a.startsWith('--')).map(s => s.toUpperCase());

async function main() {
    if (!bkgNos.length) {
        console.error('Usage: node discard-drive-pdf.js BKG_NO [BKG_NO ...] [--apply]');
        process.exit(1);
    }

    console.log(APPLY ? '=== APPLYING — Drive files will be trashed, bookings.json will be updated ===' : '=== DRY RUN — reporting only, nothing will be changed. Pass --apply to write. ===');
    console.log(`Checking ${bkgNos.length} booking(s)...\n`);

    const bookings = loadBookings();

    for (const bkgNo of bkgNos) {
        const record = bookings[bkgNo];
        if (!record) {
            console.log(`${bkgNo}: NOT FOUND in bookings.json — skipping`);
            continue;
        }

        let driveFile;
        try {
            driveFile = await findPdfByBooking(bkgNo);
        } catch (err) {
            console.log(`${bkgNo}: could not check Drive — ${err.message}`);
            continue;
        }
        if (!driveFile) {
            console.log(`${bkgNo}: no PDF currently in Drive — nothing to discard` + (record.pdf_drive_id ? ' (but bookings.json still has a stale pdf_drive_id — clearing it)' : ''));
            if (!record.pdf_drive_id) continue;
        } else {
            console.log(`${bkgNo}: found ${driveFile.name} (${driveFile.id}) in Drive — will discard`);
        }

        if (!APPLY) continue;

        if (driveFile) {
            const result = await deletePdfByBooking(bkgNo);
            if (!result.deleted) {
                console.log(`  -> Drive delete did not confirm success (${result.reason || 'unknown'}) — leaving bookings.json untouched, check manually`);
                continue;
            }
            console.log(`  -> trashed ${result.name} (${result.fileId})`);
        }

        await mutateJson(cfg.BOOKINGS_FILE, {}, (all) => {
            if (all[bkgNo]) {
                delete all[bkgNo].pdf_drive_id;
                delete all[bkgNo].pdf_uploaded_at;
            }
            return all;
        });
        console.log(`  -> cleared pdf_drive_id/pdf_uploaded_at on the booking record (booking itself is untouched, still active)`);

        await appendAuditLog({
            source: 'discard_drive_pdf', bkgNo, intent: 'discard_wrong_pdf', resolvedBy: 'manual', confidence: null,
            actionTaken: 'trashed_and_cleared_stamp', note: driveFile ? `${driveFile.name} (${driveFile.id})` : 'no Drive file found, cleared stale stamp only',
        });
    }

    console.log('\nDone.' + (APPLY ? '' : ' Re-run with --apply to make these changes.'));
}

main().catch((err) => { console.error('Crashed:', err); process.exit(1); });
