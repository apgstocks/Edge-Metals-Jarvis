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

// ── verify's mail reader ────────────────────────────────────────────────
// USED BY verifyOne() ONLY. run()/backfillOne have their own reader — this
// file's blast radius for anything below is the verify path alone, so the
// nightly backfill cron is untouched by all of it.
//
// Apsara, 2026-08-22, on a live verify report:
//     "what the hell   DALA20928700 — POL
//        stored: LOS ANGELES
//        mail:   MARTINEZ"
//
// She is right that this is garbage, and it was three of my bugs compounding:
//
//  1. listMessages(gmail, bkgNo, 3) returns Gmail's order — NEWEST FIRST. So
//     this read the three most RECENT mails mentioning the booking number,
//     which is almost never the original booking confirmation. The message
//     verifyBookings sends ("against the original booking mail") was a lie.
//  2. First message that yielded any field won. No preference for a document
//     that actually IS a booking confirmation.
//  3. The PDF path checks `is_booking_confirmation`. The BODY-TEXT path
//     checked nothing at all — so a casual reply in the thread ("truck is at
//     Martinez") was treated as authoritative, and Gemini, asked to fill a
//     port_of_loading field, dutifully filled it.
//
// Backfill survived all three because it only ever fills BLANKS — a stray
// value lands only where there was nothing. Verify CONTRADICTS a stored
// value, so the same sloppiness turns into a false accusation against
// correct data. This file's own header already excluded carrier/shipper/
// consignee from BACKFILL_FIELDS for exactly this reason and judged the port
// fields "lower-risk". That judgement was made for backfill and is wrong for
// verify.
//
// The rule now: EVIDENCE IS GRADED, and identity-ish fields need the strong
// grade before verify is allowed to call a stored value wrong.
//   'confirmation' — a real booking-confirmation document (PDF, or body text
//                    that both restates this booking number and reads as a
//                    confirmation). Trusted for every field.
//   'mention'      — the booking number appeared in some thread mail. Trusted
//                    for dates only; dates get restated consistently across a
//                    thread, place and vessel names get mentioned in passing.
// A mail that names a DIFFERENT booking number is rejected outright.

// Fields verify will only contradict on 'confirmation'-grade evidence.
// Deliberately NOT a change to BACKFILL_FIELDS — backfill's behaviour must
// not move.
const STRONG_EVIDENCE_ONLY = new Set(['port_of_loading', 'port_of_discharge', 'vessel_voyage']);

// How many thread mails verify is willing to read per booking. Was 3, and
// they were the newest 3; now we read a few more and CHOOSE, rather than
// taking whichever answered first.
const VERIFY_MAIL_CANDIDATES = 5;

function headerValue(headers, name) {
    const h = (headers || []).find((x) => (x.name || '').toLowerCase() === name.toLowerCase());
    return h ? h.value : '';
}

// Does this mail actually restate the booking number we asked about? Gmail
// matched it somewhere, but that could be a quoted signature or an unrelated
// digit run.
function restatesBooking(text, bkgNo) {
    if (!text || !bkgNo) return false;
    const norm = (x) => String(x).toUpperCase().replace(/[^A-Z0-9]/g, '');
    return norm(text).includes(norm(bkgNo));
}

// Returns { fields, grade, source } or null.
//   grade: 'confirmation' | 'mention'
//   source: { date, subject, kind } — shown in the report so a bad line is
//           traceable to the mail that produced it instead of just being wrong.
async function readOneMailForVerify(bkgNo, gmail, m) {
    const full = await getMessage(gmail, m.id);
    const headers = full.payload && full.payload.headers;
    const source = {
        subject: headerValue(headers, 'Subject') || '(no subject)',
        date: headerValue(headers, 'Date') || '',
        kind: 'body',
    };
    const { body, pdfParts } = getEmailContent(full.payload);

    // PDF first — a booking confirmation attachment is the strongest evidence
    // there is, and it self-identifies via is_booking_confirmation.
    if (pdfParts && pdfParts.length) {
        for (const part of pdfParts) {
            try {
                const att = await downloadAttachment(gmail, m.id, part);
                const pdfFields = await extractPdfFields(att.base64);
                if (!pdfFields || !pdfFields.is_booking_confirmation) continue;
                // A confirmation for a DIFFERENT booking is worse than no
                // evidence — it is confidently wrong. Reject it.
                if (pdfFields.booking_number && !restatesBooking(pdfFields.booking_number, bkgNo)) {
                    console.warn(`[${AGENT}] ${bkgNo}: ignoring PDF for a different booking (${pdfFields.booking_number})`);
                    continue;
                }
                if (BACKFILL_FIELDS.some((f) => pdfFields[f])) {
                    return { fields: pdfFields, grade: 'confirmation', source: { ...source, kind: 'PDF booking confirmation' } };
                }
            } catch (err) {
                console.error(`[${AGENT}] Attachment read failed for ${bkgNo}:`, err.message);
            }
        }
    }

    if (!body || !body.trim()) return null;
    const fields = await extractBookingFieldsFromText(body);
    if (!fields || !BACKFILL_FIELDS.some((f) => fields[f])) return null;
    if (fields.booking_number && !restatesBooking(fields.booking_number, bkgNo)) {
        console.warn(`[${AGENT}] ${bkgNo}: ignoring mail about a different booking (${fields.booking_number})`);
        return null;
    }
    // The text extractor does not report is_booking_confirmation (see the
    // note in helpers/gemini.js). Best available proxy: the mail restates
    // this booking number in its own text AND the subject reads like a
    // confirmation rather than a reply.
    const subj = source.subject;
    const looksConfirming = /\b(booking\s*(confirmation|confirmed)|shipping\s*instruction)\b/i.test(subj)
        && !/^\s*(re|fwd|fw)\s*:/i.test(subj);
    const grade = (looksConfirming && restatesBooking(body, bkgNo)) ? 'confirmation' : 'mention';
    return { fields, grade, source };
}

// Reads several candidate mails and returns the BEST evidence, not the first.
// Returns { fields, grade, source } or null.
async function extractFieldsFromMail(bkgNo, gmail) {
    let messages;
    try {
        messages = await listMessages(gmail, bkgNo, VERIFY_MAIL_CANDIDATES);
    } catch (err) {
        console.error(`[${AGENT}] Search failed for ${bkgNo}:`, err.message);
        return null;
    }
    if (!messages.length) return null;

    let best = null;
    for (const m of messages) {
        let got = null;
        try { got = await readOneMailForVerify(bkgNo, gmail, m); }
        catch (err) { console.error(`[${AGENT}] Verify read failed for ${bkgNo}:`, err.message); }
        if (!got) continue;
        // A confirmation ends the search; nothing outranks it.
        if (got.grade === 'confirmation') return got;
        if (!best) best = got;
    }
    return best;
}

// One booking. Returns:
//   { bkgNo, status: 'no_mail' }                      nothing to compare against
//   { bkgNo, status: 'checked', mismatches, confirmed, blank, weak, grade, source }
// `weak` holds disagreements that were NOT reported as mismatches because the
// evidence was only a passing mention. Surfaced, never silently dropped —
// hiding them would be the same mistake in the other direction.
async function verifyOne(bkgNo, gmail) {
    const bookings = loadBookings();
    const b = bookings[bkgNo];
    if (!b) return { bkgNo, status: 'not_found' };
    const got = await extractFieldsFromMail(bkgNo, gmail);
    if (!got) return { bkgNo, status: 'no_mail' };
    const { fields, grade, source } = got;

    const mismatches = [], confirmed = [], blank = [], weak = [], skippedFields = [];
    for (const f of BACKFILL_FIELDS) {
        const stored = b[f];
        const { value: fromMail, skipped } = mailValueFor(f, fields);
        if (skipped) { skippedFields.push({ field: f, why: skipped }); continue; }
        if (!fromMail) continue;                       // mail says nothing — no opinion
        if (!stored || !String(stored).trim()) {
            // Filling a blank from a passing mention is what backfill already
            // does safely, so a blank is still worth reporting at any grade.
            blank.push({ field: f, fromMail, grade });
            continue;
        }
        if (fieldsAgree(f, stored, fromMail)) { confirmed.push({ field: f, value: stored }); continue; }
        if (grade !== 'confirmation' && STRONG_EVIDENCE_ONLY.has(f)) {
            weak.push({ field: f, stored, fromMail, source });
            continue;
        }
        mismatches.push({ field: f, stored, fromMail, source });
    }
    return { bkgNo, status: 'checked', mismatches, confirmed, blank, weak, skippedFields, grade, source };
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
// env-overridable so the simulation suite can drive real timeouts in ms
// instead of pretending, and so this is tunable live without a code change.
const VERIFY_BOOKING_TIMEOUT_MS = Number(process.env.JARVIS_VERIFY_TIMEOUT_MS) || 45000;

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

// ── APPLY: correct a booking from the latest confirmation PDF ───────────
// Apsara, 2026-08-22: "Check everythig erd,cuttoff,eta,etd reverify all
// these..if there is a discrepancy,last mail about the booking with pdf-
// modify the bookings in dashboard with updated pdf in drive"
//
// This is the first thing in this file that WRITES to a booking on the
// strength of a mail, and the header above spends a paragraph explaining why
// that was deliberately never done. She is the manager and has overruled it,
// so it is built — but narrowly, because an unattended overwrite of a
// hand-corrected value is the one failure here nobody would notice:
//
//   * SCHEDULE DATES ONLY. cutoff/ERD/ETD/ETA — the four she named. Ports,
//     vessel, carrier, shipper, consignee are NOT touched by this, at any
//     confidence. Those are the fields the MARTINEZ bug came from.
//   * PDF BOOKING CONFIRMATIONS ONLY, never body text, never a "mention".
//     "last mail about the booking with pdf" — her words, and the strongest
//     evidence that exists.
//   * The PDF must restate THIS booking number.
//   * Newest wins, by the mail's own internalDate — not Gmail's result order.
//   * If Drive already holds a PDF uploaded AFTER that mail arrived, the
//     write is skipped. A newer document already superseded this one, and
//     reverting to an older confirmation would be worse than doing nothing.
//   * Every change is audit-logged old -> new and reported old -> new, so
//     any wrong call is visible and reversible rather than silent.
const SCHEDULE_FIELDS = ['cutoff_date', 'erd_date', 'etd', 'eta'];

// Apsara, 2026-08-22, asked directly: "cutoff date means-port_cutoff_date".
//
// The pipeline already honours that: helpers/gemini.js runs
// resolveCutoffDate() = port_cutoff_date || cutoff_date over BOTH extractors
// before anything here sees the fields, so a booking's cutoff_date is
// already the PORT cutoff. Nothing needed changing for that.
//
// What her answer DID expose is the fallback half of that OR. When a
// document has no Port row, resolveCutoffDate falls back to the model's own
// generic cutoff_date — which that prompt itself calls a "best single guess",
// and there is a recorded incident of Gemini returning the DOC cutoff there
// despite an explicit instruction not to.
//
// That was survivable while this file only ever filled blanks. It is not
// survivable now that verify FLAGS and apply OVERWRITES: a doc cutoff
// mistaken for a port cutoff would accuse a correct gate date of being
// wrong, then replace it with a paperwork deadline that is typically days
// EARLIER. The visible symptom would be a container sent to the terminal on
// the wrong day — the exact class of error verify exists to prevent.
//
// So verify and apply do not accept the fallback when the document plainly
// broke its cutoffs out by label and simply had no Port row:
//   port_cutoff_date present                  -> trust it
//   neither port_ nor doc_ present            -> trust the generic (a
//                                                single-cutoff document; no
//                                                competing label to confuse)
//   doc_cutoff_date present, port_ missing    -> NO OPINION on cutoff. The
//                                                generic is probably the doc
//                                                date. Skip the field.
// Backfill's own run() is deliberately left alone — filling a blank is a
// different risk from overwriting a value, and changing the nightly cron is
// not what she asked for. Flagged in the project notes instead.
function portCutoffFromFields(fields) {
    if (!fields) return { value: null, skipped: null };
    if (fields.port_cutoff_date) return { value: fields.port_cutoff_date, skipped: null };
    if (fields.doc_cutoff_date) {
        return { value: null, skipped: 'the document lists a Doc cutoff but no Port cutoff' };
    }
    return { value: fields.cutoff_date || null, skipped: null };
}

// The value verify/apply should compare or write for a given field.
function mailValueFor(field, fields) {
    if (field !== 'cutoff_date') return { value: fields[field] || null, skipped: null };
    return portCutoffFromFields(fields);
}

// The newest mail carrying a booking-confirmation PDF for this booking.
// Returns { fields, pdfBase64, filename, source, when } or null.
async function latestConfirmationPdf(bkgNo, gmail) {
    let messages;
    try { messages = await listMessages(gmail, bkgNo, VERIFY_MAIL_CANDIDATES); }
    catch (err) {
        console.error(`[${AGENT}] Search failed for ${bkgNo}:`, err.message);
        return null;
    }
    const found = [];
    for (const m of messages) {
        try {
            const full = await getMessage(gmail, m.id);
            const headers = full.payload && full.payload.headers;
            const { pdfParts } = getEmailContent(full.payload);
            if (!pdfParts || !pdfParts.length) continue;
            for (const part of pdfParts) {
                const att = await downloadAttachment(gmail, m.id, part);
                const pdfFields = await extractPdfFields(att.base64);
                if (!pdfFields || !pdfFields.is_booking_confirmation) continue;
                if (pdfFields.booking_number && !restatesBooking(pdfFields.booking_number, bkgNo)) continue;
                if (!SCHEDULE_FIELDS.some((f) => pdfFields[f])) continue;
                found.push({
                    fields: pdfFields,
                    pdfBase64: att.base64,
                    filename: part.filename || `${bkgNo}.pdf`,
                    when: Number(full.internalDate) || 0,
                    source: {
                        subject: headerValue(headers, 'Subject') || '(no subject)',
                        date: headerValue(headers, 'Date') || '',
                        kind: 'PDF booking confirmation',
                    },
                });
                break;                                  // one confirmation per mail is enough
            }
        } catch (err) {
            console.error(`[${AGENT}] PDF read failed for ${bkgNo}:`, err.message);
        }
    }
    if (!found.length) return null;
    // Newest by the mail's own timestamp. Gmail's result ORDER is not a
    // contract, and "last mail" is the whole basis of her instruction.
    found.sort((a, b) => b.when - a.when);
    return found[0];
}

// Applies the latest confirmation PDF to one booking. Returns a record of
// what happened — it never throws for a per-booking problem, so one bad
// booking cannot abort an apply pass mid-way and leave half the fleet done.
async function applyScheduleFromPdf(bkgNo, gmail) {
    let doc;
    try { doc = await latestConfirmationPdf(bkgNo, gmail); }
    catch (err) { return { bkgNo, status: 'error', error: err.message }; }
    if (!doc) return { bkgNo, status: 'no_pdf' };

    const before = loadBookings()[bkgNo];
    if (!before) return { bkgNo, status: 'not_found' };

    // Drive already has something newer than this mail — do not go backwards.
    const driveAt = before.pdf_uploaded_at ? Date.parse(before.pdf_uploaded_at) : 0;
    if (driveAt && doc.when && driveAt > doc.when) {
        return { bkgNo, status: 'superseded', source: doc.source };
    }

    let changed = null;
    const skippedWrites = [];
    await mutateJson(cfg.BOOKINGS_FILE, {}, (all) => {
        const b = all[bkgNo];
        if (!b) return all;
        const updates = {};
        for (const f of SCHEDULE_FIELDS) {
            const { value: fromPdf, skipped } = mailValueFor(f, doc.fields);
            if (skipped) { skippedWrites.push({ field: f, why: skipped }); continue; }
            if (!fromPdf) continue;                     // PDF silent on it — no opinion
            if (b[f] && fieldsAgree(f, b[f], fromPdf)) continue;   // already right
            updates[f] = { from: b[f] || '(blank)', to: fromPdf };
        }
        if (Object.keys(updates).length) {
            for (const f of Object.keys(updates)) b[f] = updates[f].to;
            b.schedule_verified_at = new Date().toISOString();
            changed = updates;
        }
        return all;
    });

    let drive = 'unchanged';
    if (changed) {
        try {
            await syncBookingToSheet(bkgNo);
        } catch (err) {
            console.error(`[${AGENT}] Sheet sync failed for ${bkgNo}:`, err.message);
            drive = 'sheet_sync_failed';
        }
        try {
            const { uploadPdfToDrive } = require('./drive');
            const up = await uploadPdfToDrive(bkgNo, doc.pdfBase64, doc.filename);
            const fileId = up && (up.id || up.fileId);
            if (fileId) {
                await mutateJson(cfg.BOOKINGS_FILE, {}, (all) => {
                    if (all[bkgNo]) {
                        all[bkgNo].pdf_drive_id = fileId;
                        all[bkgNo].pdf_uploaded_at = new Date().toISOString();
                    }
                    return all;
                });
            }
            drive = 'updated';
        } catch (err) {
            // uploadPdfToDrive refuses to overwrite with anything that does not
            // classify as a booking confirmation. That refusal is a feature —
            // report it, keep the field corrections, do not unwind them.
            console.error(`[${AGENT}] Drive update failed for ${bkgNo}:`, err.message);
            drive = `drive_failed: ${err.message}`;
        }
        try {
            await appendAuditLog({
                source: 'verify_apply', bkgNo, intent: 'booking_corrected',
                resolvedBy: 'manager', actionTaken: 'updated_from_confirmation_pdf',
                fields: changed, mail: doc.source,
            });
        } catch (err) { console.error(`[${AGENT}] Audit log failed:`, err.message); }
    }
    return { bkgNo, status: changed ? 'updated' : 'already_correct', changed, skippedWrites, drive, source: doc.source };
}

// Apply pass over many bookings. Same resilience contract as verify():
// per-booking timeout, per-booking isolation, always returns.
async function applySchedules(bookingNumbers, onProgress = null) {
    let gmail;
    try { gmail = getGmailRead(); }
    catch (err) { return { error: 'Gmail not configured', results: [] }; }
    const list = bookingNumbers || [];
    const results = [];
    for (let i = 0; i < list.length; i++) {
        const bkgNo = list[i];
        let r;
        try {
            r = await withTimeout(applyScheduleFromPdf(bkgNo, gmail),
                VERIFY_BOOKING_TIMEOUT_MS, { bkgNo, status: 'timeout' });
        } catch (err) { r = { bkgNo, status: 'error', error: err.message }; }
        console.log(`[${AGENT}] apply ${i + 1}/${list.length} ${bkgNo} -> ${r.status}`);
        results.push(r);
        if (typeof onProgress === 'function') {
            try { await onProgress({ done: i + 1, total: list.length, result: r }); }
            catch (e) { }
        }
    }
    return { results };
}

module.exports = { run, verify, verifyOne, applySchedules, portCutoffFromFields, mailValueFor, applyScheduleFromPdf, latestConfirmationPdf, SCHEDULE_FIELDS, withTimeout, VERIFY_BOOKING_TIMEOUT_MS, extractFieldsFromMail, readOneMailForVerify, restatesBooking, STRONG_EVIDENCE_ONLY, VERIFY_MAIL_CANDIDATES, fieldsAgree, normaliseDate, looseEqual, BACKFILL_FIELDS, FIELD_LABELS, DATE_FIELDS };
