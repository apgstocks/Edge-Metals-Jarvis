// ── reextract-cutoffs.js — ONE-TIME manual re-extraction of cutoff_date ────
// Built 2026-08-05 after fixing helpers/gemini.js's cutoff_date prompt: it
// had no guidance on WHICH cutoff to use when a document lists more than
// one, so on carriers whose booking confirmations show both a Document/SI/
// VGM cutoff and a Port/Terminal/CY/Gate cutoff, extraction could grab the
// wrong (doc) one. At least one live booking (Zimex) got the wrong value
// written before the fix.
//
// UNLIKE helpers/cutoffBackfill.js, this SCRIPT DOES overwrite an existing
// cutoff_date — that's the whole point here, since the problem was a WRONG
// value already on file, not a blank one. cutoffBackfill.js's "never
// overwrite" rule stays exactly as-is; this is a separate, deliberately
// blunter tool for a one-time correction, not a replacement for it.
//
// Deliberately NOT wired into the nightly scheduler or any WhatsApp command
// — run manually, on demand, directly on the VM:
//
//   node reextract-cutoffs.js            # dry run — reports only, writes nothing
//   node reextract-cutoffs.js --apply    # writes the corrected values
//
// Always run without --apply first and read the output. Only re-run with
// --apply once the "Changed" list looks right. Never blanks an existing
// value — only overwrites a booking when a fresh, non-null cutoff_date was
// actually found in its mail this time.

const { getGmailRead, listMessages, getMessage, getEmailContent, downloadAttachment } = require('./helpers/gmail');
const { extractBookingFieldsFromText, extractPdfFields } = require('./helpers/gemini');
const { loadBookings, mutateJson } = require('./helpers/json');
const { syncBookingToSheet } = require('./helpers/bookingTracker');
const { appendAuditLog } = require('./helpers/auditlog');
const cfg = require('./config');

const APPLY = process.argv.includes('--apply');

async function reextractOne(bkgNo, currentCutoff, gmail) {
    let messages;
    try {
        messages = await listMessages(gmail, bkgNo, 3);
    } catch (err) {
        return { bkgNo, status: 'search_failed', before: currentCutoff, after: currentCutoff, error: err.message };
    }
    if (!messages.length) return { bkgNo, status: 'no_mail_found', before: currentCutoff, after: currentCutoff };

    for (const m of messages) {
        try {
            const full = await getMessage(gmail, m.id);
            const { body, pdfParts } = getEmailContent(full.payload);

            let fields = null;
            if (body && body.trim()) {
                fields = await extractBookingFieldsFromText(body);
            }

            // Body text often has nothing usable — plenty of carriers (Zimex
            // confirmed as a real case) send the actual booking confirmation
            // as a PDF attachment with little or no cutoff info in the message
            // body itself. Same fallback workflow/emailWatcher.js already uses
            // for new bookings: download each attachment and try extractPdfFields.
            // is_booking_confirmation gates it so we don't trust a date pulled
            // from an unrelated attached PDF (an invoice, a rate sheet, etc).
            if ((!fields || !fields.cutoff_date) && pdfParts.length) {
                for (const part of pdfParts) {
                    try {
                        const att = await downloadAttachment(gmail, m.id, part);
                        const pdfFields = await extractPdfFields(att.base64);
                        if (pdfFields && pdfFields.is_booking_confirmation && pdfFields.cutoff_date) {
                            fields = pdfFields;
                            break;
                        }
                    } catch (err) {
                        console.error(`[REEXTRACT] Attachment read failed for ${bkgNo}:`, err.message);
                    }
                }
            }

            if (!fields || !fields.cutoff_date) continue;

            const before   = currentCutoff;
            const after    = fields.cutoff_date;
            const changed  = String(before || '') !== String(after || '');

            if (changed && APPLY) {
                await mutateJson(cfg.BOOKINGS_FILE, {}, (all) => {
                    const b = all[bkgNo];
                    if (b) b.cutoff_date = after;
                    return all;
                });
                await syncBookingToSheet(bkgNo);
                await appendAuditLog({
                    source: 'reextract_cutoffs', bkgNo, intent: 'booking_updated',
                    resolvedBy: 'ai', actionTaken: 'cutoff_overwritten',
                    fields: { cutoff_date: { before, after } },
                });
            }
            return { bkgNo, status: changed ? 'changed' : 'unchanged', before, after };
        } catch (err) {
            console.error(`[REEXTRACT] Failed reading a match for ${bkgNo}:`, err.message);
        }
    }
    return { bkgNo, status: 'no_cutoff_in_mail', before: currentCutoff, after: currentCutoff };
}

async function main() {
    console.log(APPLY
        ? '=== APPLY MODE — will overwrite cutoff_date where it actually changed ===\n'
        : '=== DRY RUN — reporting only, nothing will be written. Pass --apply to write. ===\n');

    let gmail;
    try {
        gmail = getGmailRead();
    } catch (err) {
        console.error('[REEXTRACT] Gmail not configured:', err.message);
        process.exit(1);
    }

    const bookings = Object.values(loadBookings());
    console.log(`Checking ${bookings.length} active booking(s)...\n`);

    const results = [];
    for (const b of bookings) {
        const result = await reextractOne(b.booking_number, b.cutoff_date || null, gmail);
        results.push(result);
        console.log(`${String(result.bkgNo).padEnd(16)} ${result.status.padEnd(16)} before=${result.before || '—'}  after=${result.after || '—'}`);
    }

    const changed   = results.filter(r => r.status === 'changed');
    const unchanged = results.filter(r => r.status === 'unchanged');
    const noData    = results.filter(r => r.status === 'no_mail_found' || r.status === 'no_cutoff_in_mail');
    const failed    = results.filter(r => r.status === 'search_failed');

    console.log('\n=== SUMMARY ===');
    console.log(`Changed:   ${changed.length}${APPLY ? ' (written)' : ' (would change — rerun with --apply to write)'}`);
    console.log(`Unchanged: ${unchanged.length}`);
    console.log(`No data:   ${noData.length}`);
    console.log(`Failed:    ${failed.length}`);
    if (changed.length) {
        console.log('\nChanged bookings:');
        changed.forEach(r => console.log(`  ${r.bkgNo}: ${r.before || '—'} -> ${r.after}`));
    }
    if (failed.length) {
        console.log('\nSearch failures (check these manually):');
        failed.forEach(r => console.log(`  ${r.bkgNo}: ${r.error}`));
    }
}

main().catch(err => { console.error('[REEXTRACT] Crashed:', err); process.exit(1); });
