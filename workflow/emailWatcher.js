// ── workflow/emailWatcher.js — Gmail booking-email watcher ───────────────────
// Polls Gmail for booking-confirmation emails with a PDF attachment, runs the
// SAME multimodal Gemini extraction the Bookings tab uses (helpers/gemini.js
// extractPdfFields — no separate text-extraction pipeline needed, unlike the
// old Python prototype this was ported from), then either creates a new
// booking or fills gaps on an existing one.
//
// DESIGN DECISIONS — confirm these match intent before trusting this in prod:
//   1. Existing bookings: only NULL/empty fields get filled. A value already
//      on the record (manager-entered OR from an earlier email) is never
//      overwritten. If two emails disagree, the first one wins silently.
//   2. New bookings: created directly into bookings.json, no pre-approval
//      gate. Manager gets a WhatsApp notice after the fact, not a confirm
//      prompt. brain.js already has a pending_confirmations mechanism for
//      handholding mode — wiring this into that (confirm before create)
//      is the natural v2 if silent auto-create turns out to be too risky.
//   3. Emails with no PDF attachment are skipped entirely (no body-only
//      queuing like the Python version had) — Gemini's PDF extraction is
//      the only trusted source of truth here, matching how the dashboard's
//      manual upload path already works.
//   4. Multiple PDFs in one email: first one that yields a booking_number
//      wins; the rest are ignored for this pass.
//   5. Drive PDF: uploaded ONCE per booking (on creation, or if the booking
//      somehow has no pdf_drive_id yet). A second email that resolves to the
//      same booking number — whether a legitimate re-issue or a Gemini
//      extraction slip — does NOT overwrite the existing PDF; it's logged
//      and surfaced in the manager notification as "flagged" for a manual
//      look instead. Caught live: two different-carrier PDFs both extracted
//      as the same booking number in one poll, and the second silently
//      clobbered the first PDF in Drive before this guard existed.

const { getGmail, getEmailContent, downloadAttachment, listMessages, getMessage } = require('../helpers/gmail');
const { extractPdfFields, extractBookingFieldsFromText } = require('../helpers/gemini');
const { appendAuditLog } = require('../helpers/auditlog');
const { uploadPdfToDrive } = require('../helpers/drive');
const { loadJson, saveJson, mutateJson, loadBookings, updateWorkflow } = require('../helpers/json');
const cfg = require('../config');
const { syncBookingToSheet } = require('../helpers/bookingTracker');
const AGENT = 'EMAIL';

let _sendToManager = async () => {};
function init({ sendToManager }) {
    if (sendToManager) _sendToManager = sendToManager;
}

function loadProcessed() {
    return new Set(loadJson(cfg.EMAIL_PROCESSED_FILE, []));
}
async function saveProcessed(set) {
    await saveJson(cfg.EMAIL_PROCESSED_FILE, [...set]);
}

async function run() {
    if (!cfg.GMAIL_WATCH_ENABLED) return;

    let gmail;
    try {
        gmail = getGmail();
    } catch (err) {
        console.error(`[${AGENT}] Gmail not configured — skipping poll:`, err.message);
        return;
    }

    const processed = loadProcessed();
    const after = new Date(Date.now() - cfg.GMAIL_POLL_DAYS_BACK * 86400000);
    const afterStr = `${after.getFullYear()}/${after.getMonth() + 1}/${after.getDate()}`;
    const query = `after:${afterStr} has:attachment filename:pdf (booking OR bkg OR cutoff OR erd OR vessel OR "booking confirmation")`;

    let messages;
    try {
        messages = await listMessages(gmail, query, 50);
    } catch (err) {
        console.error(`[${AGENT}] Gmail search failed:`, err.message);
        return;
    }

    const newMessages = messages.filter((m) => !processed.has(m.id));
    if (!newMessages.length) return;
    console.log(`[${AGENT}] ${newMessages.length} new candidate email(s)`);

    // `bookings` is kept as a LIVE in-memory mirror below (not just a one-time
    // snapshot) — if the same booking number turns up twice in one poll (seen
    // live: two different-carrier PDFs both extracted the same number), the
    // second hit must see the first hit's result, not stale pre-run data.
    const bookings = loadBookings();
    const created = [], updated = [], skipped = [], flagged = [];
    const seenThisRun = new Set();

    for (const m of newMessages) {
        try {
            const msg = await getMessage(gmail, m.id);
            const hdrs = Object.fromEntries((msg.payload.headers || []).map((h) => [h.name, h.value]));
            const subject = hdrs.Subject || '(no subject)';
            const { body, pdfParts } = getEmailContent(msg.payload);

            if (!pdfParts.length) {
                processed.add(m.id);
                await appendAuditLog({ source: 'email_watcher', intent: 'no_attachment', resolvedBy: 'ai', confidence: null, actionTaken: 'skipped', subject, messageId: m.id });
                continue;
            }

            // Try each PDF until one yields a usable booking_number — first match wins.
            let fields = null, pdfBase64 = null, filename = null;
            for (const part of pdfParts) {
                const att = await downloadAttachment(gmail, m.id, part);
                const extracted = await extractPdfFields(att.base64).catch((err) => {
                    console.error(`[${AGENT}] Extraction failed on ${att.filename}:`, err.message);
                    return null;
                });
                if (extracted && extracted.booking_number) {
                    fields = extracted;
                    pdfBase64 = att.base64;
                    filename = att.filename;
                    break;
                }
            }

            if (!fields) {
                console.log(`[${AGENT}] No extractable booking number in: ${subject.slice(0, 60)}`);
                skipped.push(subject);
                processed.add(m.id);
                await appendAuditLog({ source: 'email_watcher', intent: 'no_booking_number', resolvedBy: 'ai', confidence: null, actionTaken: 'skipped', subject, messageId: m.id });
                continue;
            }
            // Body text can carry ERD/cutoff even when the PDF doesn't, or when a
            // carrier sends a cutoff/ERD change as email text rather than a fresh
            // PDF. Body wins for these two fields only; everything else (identity:
            // booking_number, carrier, ports, vessel, containers) stays PDF-sourced —
            // that's still the more reliable structured source for those.
            if (body && body.trim()) {
                try {
                    const bodyFields = await extractBookingFieldsFromText(body);
                    if (bodyFields?.erd_date)    fields.erd_date    = bodyFields.erd_date;
                    if (bodyFields?.cutoff_date) fields.cutoff_date = bodyFields.cutoff_date;
                } catch (err) {
                    console.error(`[${AGENT}] Body extraction failed ("${subject.slice(0, 60)}"):`, err.message);
                }
            }
            const bkg = String(fields.booking_number).toUpperCase().replace(/\s+/g, '');
            const existing = bookings[bkg]; // reflects in-run creates too, see mirror updates below
            const duplicateThisRun = seenThisRun.has(bkg);
            seenThisRun.add(bkg);

            if (existing) {
                const fillable = {};
                for (const [k, v] of Object.entries(fields)) {
                    if (k === 'booking_number') continue;
                    if (v != null && v !== '' && (existing[k] == null || existing[k] === '')) fillable[k] = v;
                }
                if (Object.keys(fillable).length) {
                    await mutateJson(cfg.BOOKINGS_FILE, {}, (all) => {
                        if (all[bkg]) Object.assign(all[bkg], fillable);
                        return all;
                    });
                    Object.assign(existing, fillable); // keep in-memory mirror current
                    updated.push(bkg);
                    await syncBookingToSheet(bkg);
                    await appendAuditLog({ source: 'email_watcher', bkgNo: bkg, intent: 'booking_updated', resolvedBy: 'ai', confidence: null, actionTaken: 'updated', subject, fields: fillable });
                }
                if (duplicateThisRun) {
                    console.warn(`[${AGENT}] ${bkg} matched a SECOND email in this run ("${subject.slice(0, 60)}") — not touching its Drive PDF, flagging for review`);
                    flagged.push(bkg);
                    await appendAuditLog({ source: 'email_watcher', bkgNo: bkg, intent: 'duplicate_flagged', resolvedBy: 'ai', confidence: null, actionTaken: 'flagged', subject });
                }
            } else {
                const record = { ...fields, booking_number: bkg, created_at: new Date().toISOString(), source: 'email_watcher' };
                await mutateJson(cfg.BOOKINGS_FILE, {}, (all) => {
                    all[bkg] = record;
                    return all;
                });
                bookings[bkg] = record; // keep in-memory mirror current so a later duplicate this run is treated as "existing"
                await updateWorkflow(bkg, {});
                created.push(bkg);
                await syncBookingToSheet(bkg);
                await appendAuditLog({ source: 'email_watcher', bkgNo: bkg, intent: 'booking_created', resolvedBy: 'ai', confidence: null, actionTaken: 'created', subject, fields });
            }

            // Upload the PDF to Drive ONLY the first time we see this booking number
            // (this run or before) — never overwrite an existing confirmation PDF.
            if (bookings[bkg].pdf_drive_id) {
                console.log(`[${AGENT}] ${bkg} already has a PDF on file — skipping Drive upload from this email`);
            } else {
                try {
                    const file = await uploadPdfToDrive(bkg, pdfBase64, filename);
                    const stamp = { pdf_drive_id: file.id, pdf_uploaded_at: new Date().toISOString() };
                    await mutateJson(cfg.BOOKINGS_FILE, {}, (all) => {
                        if (all[bkg]) Object.assign(all[bkg], stamp);
                        return all;
                    });
                    Object.assign(bookings[bkg], stamp); // keep in-memory mirror current
                } catch (err) {
                    console.error(`[${AGENT}] Drive upload failed for ${bkg}:`, err.message);
                }
            }

            processed.add(m.id);
        } catch (err) {
            console.error(`[${AGENT}] Failed on message ${m.id}:`, err.message);
            // Deliberately NOT marking as processed — retried on the next poll.
        }
    }

    await saveProcessed(processed);

    if (created.length || updated.length || flagged.length) {
        const lines = ['Email watcher — auto-detected from Gmail:'];
        if (created.length) lines.push(`New: ${created.join(', ')} — verify details on the dashboard.`);
        if (updated.length) lines.push(`Filled in missing fields: ${updated.join(', ')}`);
        if (flagged.length) lines.push(`Flagged — same booking number matched a second email, verify manually: ${[...new Set(flagged)].join(', ')}`);
        await _sendToManager(lines.join('\n'));
    }
    if (skipped.length) {
        console.log(`[${AGENT}] Skipped ${skipped.length} email(s) — no booking number extracted`);
    }
}

module.exports = { init, run };