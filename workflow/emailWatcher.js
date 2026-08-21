// ── workflow/emailWatcher.js — Gmail booking-email watcher ───────────────────
// Polls Gmail for booking-confirmation emails with a PDF attachment, runs the
// SAME multimodal Gemini extraction the Bookings tab uses (helpers/gemini.js
// extractPdfFields — no separate text-extraction pipeline needed, unlike the
// old Python prototype this was ported from), then either creates a new
// booking or fills gaps on an existing one.
//
// DESIGN DECISIONS — confirm these match intent before trusting this in prod:
//   1. Existing bookings: split into two buckets.
//      - STABLE fields (booking_number, carrier, ports, shipper, consignee,
//        buyer, container_size, container_number) only fill in if currently
//        empty — never overwritten once set.
//      - DATE fields (cutoff_date, erd_date, etd) auto-update to whatever the
//        email says, forward OR backward — no manual-review gate (per Apsara
//        2026-08-20: "I don't want any human to do that"). The trust gate is
//        classifyDocument's is_booking_confirmation check earlier in this
//        same run, not date direction. A backward move still gets called out
//        by name in the WhatsApp notice so it's visible, it just never blocks
//        the write (see DATE_FIELDS below for the full history).
//      - vessel_voyage always takes the newest value (not a date, "later"
//        doesn't apply — a reassignment is a reassignment).
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

const { getGmailRead, getEmailContent, downloadAttachment, listMessages, getMessage } = require('../helpers/gmail');
const { extractPdfFields, extractBookingFieldsFromText, classifyDocument } = require('../helpers/gemini');
const { appendAuditLog } = require('../helpers/auditlog');
const { uploadPdfToDrive } = require('../helpers/drive');
const { loadJson, saveJson, mutateJson, loadBookings, updateWorkflow } = require('../helpers/json');
const { parseUSDate } = require('../helpers/time');
const cfg = require('../config');
const { syncBookingToSheet } = require('../helpers/bookingTracker');
const { pushAlert } = require('../alerts');
const AGENT = 'EMAIL';

// REAL BUG #1 (found 2026-08-20, live — Apsara: "cut off and erd are not
// proper ... still jarvis booking hold old data"): the existing-booking merge
// below only ever filled a field if it was CURRENTLY EMPTY. That's correct
// for identity fields (booking_number, carrier, ports) but wrong for
// cutoff/ERD/ETD/vessel — carriers amend those constantly (vessel rolls, port
// congestion), so a real amendment email was being silently ignored because
// the booking already had a (now-stale) value on file. Fixed by always taking
// the new value for DATE_FIELDS/VOLATILE_NON_DATE_FIELDS below.
//
// REAL BUG #2, same day: the first fix only auto-applied a FORWARD date move
// and flagged anything else for manual review — reasonable-sounding (carriers
// push dates back, rarely pull them earlier), but Apsara's explicit call was
// "I don't want any human to do that." Manual-review-for-backward-moves is
// removed; every date change now applies automatically regardless of
// direction. A backward move still gets called out by name in the WhatsApp
// notice as an FYI, it just never blocks the write.
const DATE_FIELDS = new Set(['cutoff_date', 'erd_date', 'etd']);
// vessel_voyage also changes over a booking's life (reassignment) but isn't a
// date — "later" doesn't apply, so it always takes the newest value.
const VOLATILE_NON_DATE_FIELDS = new Set(['vessel_voyage']);

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

// Root cause of real duplicate Drive uploads (DALA79158000.pdf, DALA62677900.pdf
// each showing up twice): scheduler.js fires run() every 15 minutes with no
// overlap protection, and saveProcessed() only persists once at the very end
// of the whole loop (errors mid-loop deliberately skip marking-processed too,
// so a slow run leaves messages looking "unprocessed" to anyone else who
// checks). If one run is still mid-loop — stuck on a slow Gemini call, or
// working through a backlog — when the next cron tick fires, the second run
// re-reads the same not-yet-marked messages and independently uploads the
// same booking's PDF a second time before the first run's Drive file exists
// to be found by findPdfByBooking(). Same-run duplicates were already guarded
// (see seenThisRun below); cross-run duplicates were not. This flag closes
// that gap the simple way: since scheduler.js and this module run in the same
// Node process, an in-memory lock is enough — no cross-process locking needed.
let _running = false;

async function run() {
    // Dynamic (dashboard-editable) setting, not the static cfg.GMAIL_WATCH_ENABLED
    // env read — per Apsara 2026-08-21, this needs to be flippable live from
    // Settings without a restart. getSettings() falls back to the env var if
    // nobody's touched the toggle yet, so existing deployments are unaffected.
    if (!cfg.getSettings().gmail_watch_enabled) return;
    if (_running) {
        console.log(`[${AGENT}] Previous run still in progress — skipping this tick to avoid duplicate processing`);
        return;
    }
    _running = true;
    try {
        // Stamped here — reaching this point means a real poll is actually
        // starting (enabled, not already running), which is what "last active"
        // should mean. mutateJson (already imported below) for the same
        // locking/atomicity reason every other settings.json write in this
        // codebase uses it, not a plain read-then-write.
        await mutateJson(cfg.SETTINGS_FILE, {}, (s) => {
            s.gmail_watcher_last_run = new Date().toISOString();
            return s;
        });
        await _runOnce();
    } finally {
        _running = false;
    }
}

async function _runOnce() {

    let gmail;
    try {
        gmail = getGmailRead();
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
    const created = [], updated = [], skipped = [], flagged = [], rescheduled = [];
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
                if (!extracted || !extracted.is_booking_confirmation || !extracted.booking_number) continue;

                // Second, independent opinion before trusting this enough to
                // auto-create a booking record. Real report: invoices that
                // merely mention a booking/container number were getting
                // is_booking_confirmation:true from the bundled extraction
                // call above and silently creating phantom bookings. Only
                // proceed if a SEPARATE, narrowly-scoped classification call
                // also agrees. Fails safe: a classification error or
                // disagreement skips this PDF rather than trusting extraction
                // alone.
                const classification = await classifyDocument(att.base64).catch((err) => {
                    console.error(`[${AGENT}] Classification failed on ${att.filename}:`, err.message);
                    return null;
                });
                if (!classification || !classification.is_booking_confirmation || classification.is_invoice_or_other) {
                    console.warn(`[${AGENT}] Extraction called it a booking confirmation but classification disagreed (type=${classification?.document_type || 'unknown/failed'}) — skipping ${att.filename}`);
                    await appendAuditLog({
                        source: 'email_watcher', intent: 'classification_mismatch', resolvedBy: 'ai', confidence: null,
                        actionTaken: 'skipped', subject, messageId: m.id,
                        note: `extraction said booking_number=${extracted.booking_number}, classification said ${classification?.document_type || 'unknown/failed'}`,
                    });
                    continue;
                }

                fields = extracted;
                pdfBase64 = att.base64;
                filename = att.filename;
                break;
            }

            if (!fields) {
                console.log(`[${AGENT}] No extractable booking number in: ${subject.slice(0, 60)}`);
                skipped.push(subject);
                processed.add(m.id);
                await appendAuditLog({ source: 'email_watcher', intent: 'no_booking_number', resolvedBy: 'ai', confidence: null, actionTaken: 'skipped', subject, messageId: m.id });
                continue;
            }
            // Body text can carry ERD/cutoff even when the PDF doesn't. Originally
            // this OVERRODE the PDF's value unconditionally, which caused a real
            // bug (found 2026-08-20, live — DALA62677900): a "Fwd:" email's body
            // includes the quoted original thread below the new content, and body
            // extraction picked up a STALE cutoff mention from that quoted history
            // instead of the fresh line the sender actually added. That stale
            // value happened to match what was already on file, so it silently
            // no-opped — nothing for the forward-only date guard to even catch,
            // since there was no difference to compare. Fix: body is now a
            // FALLBACK only — it fills a field the PDF left null, it never
            // overwrites a value the PDF (the more reliable, structured source)
            // already found. Everything else stays PDF-sourced as before.
            if (body && body.trim()) {
                try {
                    const bodyFields = await extractBookingFieldsFromText(body);
                    if (bodyFields?.erd_date    && !fields.erd_date)    fields.erd_date    = bodyFields.erd_date;
                    if (bodyFields?.cutoff_date && !fields.cutoff_date) fields.cutoff_date = bodyFields.cutoff_date;
                } catch (err) {
                    console.error(`[${AGENT}] Body extraction failed ("${subject.slice(0, 60)}"):`, err.message);
                }
            }
            const bkg = String(fields.booking_number).toUpperCase().replace(/\s+/g, '');
            const existing = bookings[bkg]; // in-run snapshot — good enough to DECIDE update-vs-create, not safe to trust for the actual write (see below)
            const duplicateThisRun = seenThisRun.has(bkg);
            seenThisRun.add(bkg);

            // The `existing` check above is only ever as fresh as `bookings`,
            // loaded once at the top of this run — it can go stale if
            // anything else (a manual dashboard save, an API call) touches
            // this exact booking number while this run is still going.
            // helpers/json.js's mutateJson() already takes a real file lock
            // and re-reads the CURRENT on-disk state before applying its
            // mutator, so the fix is to make the actual create/merge decision
            // INSIDE that mutator, against the fresh state — never blind-
            // write a pre-built record and never blind Object.assign a
            // pre-computed field list. This is what "never allow duplicate
            // bookings" actually requires: not just serializing this run
            // against itself (the _running lock above handles that), but
            // making sure no write here can ever clobber or fork a booking
            // that was created/changed by someone else in the meantime.
            let actuallyCreated = false;
            let appliedFields = null;
            let dateChanges = [];    // [{field, from, to, note}] — all applied date/vessel moves
            const finalAll = await mutateJson(cfg.BOOKINGS_FILE, {}, (all) => {
                if (all[bkg]) {
                    const fillable = {};
                    const changed = {};
                    const changes = [];
                    const cur = all[bkg];
                    for (const [k, v] of Object.entries(fields)) {
                        if (k === 'booking_number') continue;
                        if (v == null || v === '') continue;

                        if (DATE_FIELDS.has(k)) {
                            if (cur[k] == null || cur[k] === '') { fillable[k] = v; continue; }
                            if (cur[k] === v) continue; // identical, nothing to do
                            // Per Apsara 2026-08-20 ("I don't want any human to do
                            // that"): removed the forward-only block that used to
                            // reject a backward-moving date and wait for manual
                            // review. This PDF already passed classifyDocument's
                            // is_booking_confirmation check earlier in this same
                            // function — that's the trust gate now, not date
                            // direction. Every date change applies automatically;
                            // a backward move still gets called out by name in the
                            // WhatsApp notice (see "note" below) so it's visible,
                            // it just never blocks the write anymore.
                            const oldDate = parseUSDate(cur[k]);
                            const newDate = parseUSDate(v);
                            const backward = oldDate && newDate && newDate.getTime() < oldDate.getTime();
                            changes.push({ field: k, from: cur[k], to: v, note: backward ? 'moved EARLIER — double-check this one' : null });
                            changed[k] = v;
                            continue;
                        }

                        if (VOLATILE_NON_DATE_FIELDS.has(k)) {
                            if (cur[k] !== v) {
                                changes.push({ field: k, from: cur[k] ?? '—', to: v });
                                changed[k] = v;
                            }
                            continue;
                        }

                        if (cur[k] == null || cur[k] === '') fillable[k] = v;
                    }
                    const patch = { ...fillable, ...changed };
                    if (Object.keys(patch).length) Object.assign(all[bkg], patch);
                    appliedFields = fillable;
                    dateChanges = changes;
                } else {
                    actuallyCreated = true;
                    all[bkg] = { ...fields, booking_number: bkg, created_at: new Date().toISOString(), source: 'email_watcher' };
                }
                return all;
            });
            bookings[bkg] = finalAll[bkg]; // keep in-memory mirror current — reflects what ACTUALLY landed, not what we guessed

            if (actuallyCreated) {
                await updateWorkflow(bkg, {});
                created.push(bkg);
                await syncBookingToSheet(bkg);
                await appendAuditLog({ source: 'email_watcher', bkgNo: bkg, intent: 'booking_created', resolvedBy: 'ai', confidence: null, actionTaken: 'created', subject, fields });
                // REAL GAP (found 2026-08-06, live — Apsara: "notification bell
                // icon in website for reply thread/new booking receibed in
                // mail"): this whole module only ever notified via a WhatsApp
                // text at the very end of the run (see the aggregate summary
                // below) — nothing landed in alerts.js, so nothing ever showed
                // in the bell. Pushed per-booking here, same granularity as
                // the quote-request events already in the bell, rather than
                // only the one bundled end-of-run WhatsApp message.
                await pushAlert({
                    type: 'booking_created_email', bkgNo: bkg,
                    message: `New booking ${bkg} auto-created from an email — verify details on the dashboard.`,
                    severity: 'info',
                });
            } else {
                if (appliedFields && Object.keys(appliedFields).length) {
                    updated.push(bkg);
                    await syncBookingToSheet(bkg);
                    await appendAuditLog({ source: 'email_watcher', bkgNo: bkg, intent: 'booking_updated', resolvedBy: 'ai', confidence: null, actionTaken: 'updated', subject, fields: appliedFields });
                    await pushAlert({
                        type: 'booking_updated_email', bkgNo: bkg,
                        message: `Booking ${bkg} — filled in from email: ${Object.keys(appliedFields).join(', ')}`,
                        severity: 'info',
                    });
                }
                if (dateChanges.length) {
                    const summary = dateChanges.map(c => `${c.field} ${c.from} → ${c.to}${c.note ? ` (${c.note})` : ''}`).join(', ');
                    const anyBackward = dateChanges.some(c => c.note);
                    console.log(`[${AGENT}] ${bkg} rescheduled: ${summary} (from "${subject.slice(0, 60)}")`);
                    rescheduled.push(`${bkg}: ${summary}`);
                    await syncBookingToSheet(bkg);
                    await appendAuditLog({ source: 'email_watcher', bkgNo: bkg, intent: 'booking_rescheduled', resolvedBy: 'ai', confidence: null, actionTaken: 'updated', subject, fields: Object.fromEntries(dateChanges.map(c => [c.field, c.to])) });
                    await pushAlert({
                        type: 'booking_rescheduled_email', bkgNo: bkg,
                        message: `Booking ${bkg} rescheduled by carrier: ${summary}`,
                        severity: anyBackward ? 'warning' : 'info',
                    });
                }
                if (duplicateThisRun) {
                    console.warn(`[${AGENT}] ${bkg} matched a SECOND email in this run ("${subject.slice(0, 60)}") — not touching its Drive PDF, flagging for review`);
                    flagged.push(`${bkg}: same booking number matched a second email — verify manually`);
                    await appendAuditLog({ source: 'email_watcher', bkgNo: bkg, intent: 'duplicate_flagged', resolvedBy: 'ai', confidence: null, actionTaken: 'flagged', subject });
                    await pushAlert({
                        type: 'booking_flagged_email', bkgNo: bkg,
                        message: `Booking ${bkg} matched a second email this run — PDF not overwritten, verify manually.`,
                        severity: 'warning',
                    });
                }
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

    if (created.length || updated.length || rescheduled.length || flagged.length) {
        const lines = ['Email watcher — auto-detected from Gmail:'];
        if (created.length)     lines.push(`New: ${created.join(', ')} — verify details on the dashboard.`);
        if (updated.length)     lines.push(`Filled in missing fields: ${updated.join(', ')}`);
        if (rescheduled.length) lines.push(`Rescheduled by carrier:\n${rescheduled.map(r => `  ${r}`).join('\n')}`);
        if (flagged.length)     lines.push(`Flagged for manual review:\n${[...new Set(flagged)].map(f => `  ${f}`).join('\n')}`);
        await _sendToManager(lines.join('\n'));
    }
    if (skipped.length) {
        console.log(`[${AGENT}] Skipped ${skipped.length} email(s) — no booking number extracted`);
    }
}

module.exports = { init, run, isRunning: () => _running };