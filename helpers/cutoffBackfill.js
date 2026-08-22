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

// ── VERIFY: does what we stored still match what the mail says? ─────────────
// Apsara, 2026-08-22: "Reverify all the bookings to check correctness of
// data", then "what if i want to reverify all data against these bookings?"
//
// This is a DIFFERENT job from run() above, and the difference matters:
//   run()    fills fields that are BLANK. It never looks at a field that
//            already has a value, so a wrong cutoff stays wrong forever.
//   verify() reads the same mail and COMPARES it to what is stored, to find
//            values that disagree. That is the actual correctness question.
//
// ── It never writes ─────────────────────────────────────────────────────────
// Backfilling a blank is safe — there was nothing there to lose, and Apsara
// explicitly approved it running unattended ("I don't want any human to do
// that"). OVERWRITING an existing value is not the same thing: that value may
// have been typed deliberately, corrected by hand, or updated by a later
// amendment the mail search did not pick up. Silently replacing it with
// whatever an older email says would destroy the correction and look like the
// system "fixing" itself. So verify reports, and she decides.
//
// ── Date comparison is the whole game ───────────────────────────────────────
// "08/21/2026", "2026-08-21" and "21 Aug 2026" are the same date written three
// ways, and the booking store, the PDFs and Gemini's extraction do not agree
// on a format. A naive string compare would report a mismatch on essentially
// every booking — a report that is wrong everywhere is worse than no report,
// because the real mismatches drown in it. So date-ish fields are normalised
// to YYYY-MM-DD before comparing, and only compared as strings when neither
// side parses as a date.
const DATE_FIELDS = new Set(['cutoff_date', 'erd_date', 'etd', 'eta']);

function normaliseDate(v) {
    const raw = String(v == null ? '' : v).trim();
    if (!raw) return '';
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw);
    if (m) return `${m[1]}-${String(+m[2]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`;
    // US M/D/Y — the format the dashboard and most carrier PDFs use.
    m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/.exec(raw);
    if (m) {
        let y = +m[3]; if (y < 100) y += 2000;
        return `${y}-${String(+m[1]).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`;
    }
    const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    const lower = raw.toLowerCase();
    for (const [name, mo] of Object.entries(MONTHS)) {
        if (!lower.includes(name)) continue;
        const day = (/\b(\d{1,2})\b(?!\d)/.exec(lower.replace(/\b(19|20)\d{2}\b/, '')) || [])[1];
        const yr = (/\b((?:19|20)\d{2})\b/.exec(lower) || [])[1];
        if (day && yr) return `${yr}-${String(mo).padStart(2, '0')}-${String(+day).padStart(2, '0')}`;
    }
    return '';   // not a date we recognise — caller falls back to text compare
}
// Text fields (vessel, ports) vary in punctuation and case far more than they
// vary in meaning: "MSC ISABELLA / 328W" vs "MSC Isabella 328W" is the same
// vessel. Compared on alphanumerics only, for the same reason the invoice
// matcher does — otherwise the report cries wolf.
function looseEqual(a, b) {
    const strip = (v) => String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]/g, '');
    return strip(a) === strip(b);
}
function fieldsAgree(field, stored, fromMail) {
    if (DATE_FIELDS.has(field)) {
        const ns = normaliseDate(stored), nm = normaliseDate(fromMail);
        if (ns && nm) return ns === nm;
        // One or both unparseable — fall through to a loose text compare
        // rather than declaring a mismatch on a formatting quirk.
    }
    return looseEqual(stored, fromMail);
}

// Pulls the schedule fields for one booking out of its mail, using the SAME
// PDF-first-then-body order as backfillOne — see that function's comment for
// why the order matters. Returns the extracted fields, or null.
async function extractFieldsFromMail(bkgNo, gmail) {
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
            if (pdfParts && pdfParts.length) {
                for (const part of pdfParts) {
                    try {
                        const att = await downloadAttachment(gmail, m.id, part);
                        const pdfFields = await extractPdfFields(att.base64);
                        if (pdfFields && pdfFields.is_booking_confirmation && BACKFILL_FIELDS.some((f) => pdfFields[f])) {
                            fields = pdfFields; break;
                        }
                    } catch (err) {
                        console.error(`[${AGENT}] Attachment read failed for ${bkgNo}:`, err.message);
                    }
                }
            }
            const hasAnyFromPdf = fields && BACKFILL_FIELDS.some((f) => fields[f]);
            if (!hasAnyFromPdf && body && body.trim()) {
                fields = await extractBookingFieldsFromText(body);
            }
            if (fields && BACKFILL_FIELDS.some((f) => fields[f])) return fields;
        } catch (err) {
            console.error(`[${AGENT}] Verify read failed for ${bkgNo}:`, err.message);
        }
    }
    return null;
}

// One booking. Returns:
//   { bkgNo, status: 'no_mail' }                      nothing to compare against
//   { bkgNo, status: 'checked', mismatches, confirmed, blank }
async function verifyOne(bkgNo, gmail) {
    const bookings = loadBookings();
    const b = bookings[bkgNo];
    if (!b) return { bkgNo, status: 'not_found' };
    const fields = await extractFieldsFromMail(bkgNo, gmail);
    if (!fields) return { bkgNo, status: 'no_mail' };

    const mismatches = [], confirmed = [], blank = [];
    for (const f of BACKFILL_FIELDS) {
        const stored = b[f], fromMail = fields[f];
        if (!fromMail) continue;                       // mail says nothing — no opinion
        if (!stored || !String(stored).trim()) { blank.push({ field: f, fromMail }); continue; }
        if (fieldsAgree(f, stored, fromMail)) confirmed.push({ field: f, value: stored });
        else mismatches.push({ field: f, stored, fromMail });
    }
    return { bkgNo, status: 'checked', mismatches, confirmed, blank };
}

// Every active booking. Deliberately sequential, like run() — each booking
// costs a Gmail search plus a Gemini extraction, and firing dozens in parallel
// is how you hit a rate limit halfway through and get a half-finished report.
//
// Apsara, 2026-08-22: "but nothing fired yet". The first version of this had
// no timeout, no progress, and no guaranteed end. One hung Gemini call stalled
// the whole run silently and forever. Now:
//   - every booking is raced against VERIFY_BOOKING_TIMEOUT_MS, so one hang
//     costs one booking, not the run;
//   - onProgress fires as it goes, so the caller can show life;
//   - the loop cannot throw out — every booking yields a result object, even
//     if that result is { status: 'timeout' } or { status: 'error' }.
const VERIFY_BOOKING_TIMEOUT_MS = 45000;

function withTimeout(promise, ms, onTimeoutValue) {
    let timer;
    return Promise.race([
        Promise.resolve(promise).then((v) => { clearTimeout(timer); return v; },
            (e) => { clearTimeout(timer); throw e; }),
        new Promise((resolve) => { timer = setTimeout(() => resolve(onTimeoutValue), ms); }),
    ]);
}

async function verify(bookingNumbers = null, onProgress = null) {
    let gmail;
    try {
        gmail = getGmailRead();
    } catch (err) {
        console.error(`[${AGENT}] Gmail not configured — skipping verify:`, err.message);
        return { error: 'Gmail not configured', results: [] };
    }
    const bookings = loadBookings();
    const list = bookingNumbers && bookingNumbers.length
        ? bookingNumbers.filter((n) => bookings[n])
        : Object.keys(bookings);
    const results = [];
    const started = Date.now();
    console.log(`[${AGENT}] verify start: ${list.length} booking(s)`);
    for (let i = 0; i < list.length; i++) {
        const bkgNo = list[i];
        const t0 = Date.now();
        let r;
        try {
            r = await withTimeout(verifyOne(bkgNo, gmail), VERIFY_BOOKING_TIMEOUT_MS,
                { bkgNo, status: 'timeout' });
        } catch (err) {
            console.error(`[${AGENT}] verify ${bkgNo} threw:`, err.message);
            r = { bkgNo, status: 'error', error: err.message };
        }
        console.log(`[${AGENT}] verify ${i + 1}/${list.length} ${bkgNo} -> ${r.status} (${Date.now() - t0}ms)`);
        results.push(r);
        if (typeof onProgress === 'function') {
            try { await onProgress({ done: i + 1, total: list.length, bkgNo, result: r }); }
            catch (e) { console.error(`[${AGENT}] verify progress hook failed:`, e.message); }
        }
    }
    console.log(`[${AGENT}] verify done: ${results.length} booking(s) in ${Date.now() - started}ms`);
    return { results, total: list.length };
}

module.exports = { run, verify, verifyOne, withTimeout, VERIFY_BOOKING_TIMEOUT_MS, extractFieldsFromMail, fieldsAgree, normaliseDate, looseEqual, BACKFILL_FIELDS, FIELD_LABELS, DATE_FIELDS };
