// ── helpers/cutoffBackfill.js — Fill missing schedule fields from existing mail ──
// Originally cutoff-only; generalized (2026-08-03, per Apsara: "not only cutoff
// backfill, whatever is missing in booking, but especially cutoff/ERD/ETA/ETD")
// to scan for ANY blank field in BACKFILL_FIELDS below, not just cutoff_date.
// File/function names (run(), cutoffBackfill.js) were deliberately left
// unchanged despite the broader scope — renaming would mean touching every
// require() site (actions.js, scheduler.js) purely for cosmetics, and this
// exact "file on disk doesn't match what was actually pushed" mismatch is
// what caused two real production bugs earlier this build (emailWatcher.js,
// scheduler.js). Not worth the risk for a name.
//
// Searches Gmail per booking number (precise, low-collision on its own — no
// need to also know carrier/contact name), and fills whatever's still empty
// by the time the write actually happens. Same "never overwrite, only fill
// gaps" posture as workflow/emailWatcher.js — that's what makes this safe to
// auto-apply without a manager confirmation gate.
//
// Deliberately NOT included in BACKFILL_FIELDS: carrier, shipper, consignee,
// buyer, container_number/container_size. Reasoning: those are identity
// fields, not schedule fields — a booking-number search can turn up a REPLY
// chain that mentions a different party's name in passing (a forwarded quote,
// a CC'd broker), and misfiling those from an unrelated context is a worse
// failure mode than leaving them blank for a human to fill. Cutoff/ERD/ETD/ETA
// and vessel/route fields are lower-risk: they're usually restated
// consistently across a thread, and getting one slightly wrong is far more
// visible/correctable (a wrong date jumps out; a wrong shipper name might not)
// than a genuinely wrong business-identity field silently sitting in the
// record. container_number/container_size are excluded for a structural
// reason too — they live inside the per-container containers[] array (see
// helpers/containers.js's migration), not as flat booking fields, so filling
// them safely needs container-aware logic this function doesn't have.
//
// NOTE — booking-tracker Google Sheet sync (helpers/bookingTracker.js)
// mirrors only booking_number/POL/POD/ERD/cutoff/capacity into a fixed A:F
// range today. etd/eta/vessel_voyage/port fields filled by this function are
// NOT yet reflected in that sheet — flagged, not silently swept under the rug.
// Widening the sheet's columns is a separate, deliberate change (touches a
// live spreadsheet range other people may already be looking at) — out of
// scope here.
//
// Runs two ways: nightly via scheduler.js, and on demand via
// workflow/actions.js's backfillCutoffs ("backfill missing cutoffs" / "fill
// in whatever's missing" on WhatsApp) — both call this same run().

const { getGmailRead, listMessages, getMessage, getEmailContent, downloadAttachment } = require('./gmail');
const { extractBookingFieldsFromText, extractPdfFields } = require('./gemini');
const { appendAuditLog } = require('./auditlog');
const { loadBookings, mutateJson } = require('./json');
const { syncBookingToSheet } = require('./bookingTracker');
const cfg = require('../config');

const AGENT = 'CUTOFF_BACKFILL';

// Fields this function is allowed to auto-fill. Order here also drives the
// order fields are listed in any "filled: X, Y" summary message.
const BACKFILL_FIELDS = [
    'cutoff_date', 'erd_date', 'etd', 'eta', 'vessel_voyage',
    'port_of_loading', 'port_of_discharge',
];

// Human label for each field — shared here and re-exported so actions.js /
// scheduler.js format results identically instead of maintaining two copies
// of the same mapping that can drift out of sync (exactly the kind of
// same-fix-in-one-place-not-the-other gap that bit the search_mail fix
// earlier this build).
const FIELD_LABELS = {
    cutoff_date: 'Cutoff', erd_date: 'ERD', etd: 'ETD', eta: 'ETA',
    vessel_voyage: 'Vessel/Voyage', port_of_loading: 'POL', port_of_discharge: 'POD',
};

// One booking: search mail for its number, try up to 3 matches, fill
// whatever's still genuinely blank among BACKFILL_FIELDS.
async function backfillOne(bkgNo, gmail) {
    let messages;
    try {
        messages = await listMessages(gmail, bkgNo, 3);
    } catch (err) {
        console.error(`[${AGENT}] Search failed for ${bkgNo}:`, err.message);
        return null;
    }
    if (!messages.length) return null;

    for (const m of messages) {
        try {
            const full = await getMessage(gmail, m.id);
            const { body, pdfParts } = getEmailContent(full.payload);

            let fields = null;

            // PDF attachments FIRST when present, not as a fallback. Real
            // evidence from a live run of the sibling reextract-cutoffs.js:
            // for a booking whose body text is just "please see attached",
            // extractBookingFieldsFromText still returned SOME non-null
            // field on one run — which, being non-null, would have silently
            // skipped the PDF-attachment path entirely under a body-first
            // order. A PDF is a structured, is_booking_confirmation-gated
            // document — far less prone to producing a plausible-but-wrong
            // value than freeform body text with barely any content. Same
            // download/extractPdfFields approach workflow/emailWatcher.js
            // already uses for new bookings.
            if (pdfParts && pdfParts.length) {
                for (const part of pdfParts) {
                    try {
                        const att = await downloadAttachment(gmail, m.id, part);
                        const pdfFields = await extractPdfFields(att.base64);
                        if (pdfFields && pdfFields.is_booking_confirmation && BACKFILL_FIELDS.some((f) => pdfFields[f])) {
                            fields = pdfFields;
                            break;
                        }
                    } catch (err) {
                        console.error(`[${AGENT}] Attachment read failed for ${bkgNo}:`, err.message);
                    }
                }
            }

            // Body text only as a fallback — no PDF attachment on this
            // message at all, or none of its attachments yielded a usable,
            // gated result.
            const hasAnyFromPdf = fields && BACKFILL_FIELDS.some((f) => fields[f]);
            if (!hasAnyFromPdf && body && body.trim()) {
                fields = await extractBookingFieldsFromText(body);
            }

            if (!fields) continue;
            const hasAnyBackfillable = BACKFILL_FIELDS.some((f) => fields[f]);
            if (!hasAnyBackfillable) continue;

            // Re-check against the LIVE record at write time, not the
            // snapshot the outer loop started with — something else
            // (emailWatcher's own 15-minute poll, a manual dashboard edit)
            // could have already filled this in the meantime.
            let filled = null;
            await mutateJson(cfg.BOOKINGS_FILE, {}, (all) => {
                const b = all[bkgNo];
                if (!b) return all;
                const updates = {};
                for (const f of BACKFILL_FIELDS) {
                    if (!b[f] && fields[f]) updates[f] = fields[f];
                }
                if (Object.keys(updates).length) {
                    Object.assign(b, updates);
                    filled = updates;
                }
                return all;
            });
            if (filled) {
                await syncBookingToSheet(bkgNo);
                await appendAuditLog({
                    source: 'cutoff_backfill', bkgNo, intent: 'booking_updated',
                    resolvedBy: 'ai', actionTaken: 'updated', fields: filled,
                });
                return { bkgNo, filled };
            }
        } catch (err) {
            console.error(`[${AGENT}] Failed reading a match for ${bkgNo}:`, err.message);
        }
    }
    return null;
}

// Main entry — scans every active booking missing ANY BACKFILL_FIELDS value,
// tries to fill it from existing mail. Returns an array of what actually got
// filled, for the caller (scheduler.js or actions.js) to report however fits
// its own context.
async function run() {
    let gmail;
    try {
        gmail = getGmailRead();
    } catch (err) {
        console.error(`[${AGENT}] Gmail not configured — skipping:`, err.message);
        return [];
    }

    const bookings = loadBookings();
    const candidates = Object.values(bookings).filter((b) =>
        BACKFILL_FIELDS.some((f) => !b[f])
    );
    if (!candidates.length) return [];

    const results = [];
    for (const b of candidates) {
        const result = await backfillOne(b.booking_number, gmail);
        if (result) results.push(result);
    }
    return results;
}

module.exports = { run, BACKFILL_FIELDS, FIELD_LABELS };