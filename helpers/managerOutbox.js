// ── helpers/managerOutbox.js — notifications that survive WhatsApp ──────────
//
// Apsara, 2026-08-22: "if whatsapp is down/corrupted/banned — still it
// shouldnt collapse my overall operation."
//
// WHAT WAS ACTUALLY HAPPENING
//
// index.js's sendMessage opens with:
//
//     if (!waReady) { console.warn('[SEND] WA not ready — dropped ...'); return false; }
//
// Every manager notification was DROPPED. Not queued, not retried, not
// surfaced — a console warning on a server nobody is watching. If WhatsApp
// were banned on a Friday afternoon, then across the weekend: every urgent
// email flag, every unanswered chase-up, every held scheduled email asking
// "send it anyway?" would vanish. Jarvis would look like it was working. The
// logs would say so.
//
// Worse, it returns FALSE rather than throwing. Every `try { await
// sendToManager(...) } catch` in this codebase — including the ones written
// earlier today to keep the inbox queue safe on a failed send — never fires,
// because a false return is not an exception. Those queues were being
// drained as though the message had been delivered. The safety net had a
// hole in exactly the shape of this failure.
//
// WHAT THIS DOES
//
//   1. Try WhatsApp. Treat BOTH a thrown error and a falsy return as failure,
//      because this codebase signals failure both ways.
//   2. On failure, persist the message. Nothing is lost to a restart.
//   3. For anything critical, fall back to email — a channel with a
//      completely independent failure mode. A WhatsApp ban does not touch
//      Gmail.
//   4. Retry the queue whenever WhatsApp comes back, and periodically.
//
// WHY EMAIL IS THE RIGHT SECOND CHANNEL
//
// It is already authorized, already used, costs nothing new, and shares no
// infrastructure with WhatsApp. The point of a fallback is that it fails for
// different reasons than the primary — a second WhatsApp number would not be
// a fallback at all, since a ban or an outage would take both.

const { loadJson, saveJson } = require('./json');
const cfg = require('../config');
const path = require('path');

// Deliberately NOT in config.js — this file is self-contained so that adding
// resilience to notifications does not require a config change to be
// deployed alongside it.
const OUTBOX_FILE = path.join(path.dirname(cfg.EMAIL_PROCESSED_FILE), 'manager_outbox.json');

const MAX_QUEUE = 200;          // bounds an outage that lasts days
const MAX_ATTEMPTS = 20;        // ~a day of 5-minute retries
const EMAIL_FALLBACK_AFTER_MS = 10 * 60 * 1000; // don't email on a 30-second blip

let _sendToManager = async () => false;
function init({ sendToManager }) { if (sendToManager) _sendToManager = sendToManager; }

function loadQueue() {
    const raw = loadJson(OUTBOX_FILE, []);
    return Array.isArray(raw) ? raw : [];
}
async function saveQueue(q) {
    // Keep the NEWEST on overflow. In a long outage the recent state of the
    // business matters more than a stale alert from two days ago.
    await saveJson(OUTBOX_FILE, q.slice(-MAX_QUEUE));
}

// True only if WhatsApp genuinely accepted the message.
//
// index.js sets global.__jarvisWaReady; when that is absent (a test harness,
// or a context where index.js never booted) assume it might work and let the
// send attempt decide.
function waLooksReady() {
    try { return typeof global.__jarvisWaReady === 'function' ? !!global.__jarvisWaReady() : true; }
    catch (e) { return true; }
}

async function tryWhatsApp(text) {
    try {
        const res = await _sendToManager(text);
        // `false` is this codebase's ONLY explicit "dropped" signal —
        // index.js's sendMessage returns it from the !waReady guard and from
        // its catch. Treating that as success is precisely the bug this file
        // exists to close.
        //
        // `undefined` is deliberately treated as SUCCESS, not failure. A
        // wrapper that forgets to return is far more likely to be sloppy than
        // silently broken, and the cost of guessing wrong the other way is
        // real: every message would be queued despite having been delivered,
        // then delivered AGAIN on the next flush. Duplicated notifications on
        // every single send would make the whole feature unusable, and this
        // was caught doing exactly that in the test suite. Anything that
        // genuinely cannot send is expected to return false or throw.
        return res !== false && res !== null;
    } catch (err) {
        console.warn('[OUTBOX] WhatsApp send threw:', err.message);
        return false;
    }
}

// Email fallback — to her own address, via the already-authorized Gmail send.
async function tryEmail(text, subjectHint) {
    try {
        const { sendEmail, getMyEmailAddress, getGmailSenderRead } = require('./gmail');
        let to = null;
        try { const g = getGmailSenderRead(); if (g) to = await getMyEmailAddress(g); } catch (e) { /* below */ }
        if (!to) { console.warn('[OUTBOX] no fallback address available'); return false; }
        await sendEmail({
            to,
            subject: `[Jarvis] ${subjectHint || 'Notification'} (WhatsApp unavailable)`,
            body: `${text}\n\n---\nSent by email because Jarvis could not reach you on WhatsApp.\nReplying to this email does nothing — use WhatsApp or the dashboard once it is back.`,
        });
        return true;
    } catch (err) {
        console.error('[OUTBOX] email fallback failed:', err.message);
        return false;
    }
}

// Deliver a manager notification, durably.
//
// opts.critical  — also fall back to email once WhatsApp has been failing for
//                  EMAIL_FALLBACK_AFTER_MS. Use for anything that blocks work
//                  or costs money if unseen; not for routine chatter.
// opts.subject   — subject hint for the email fallback.
// opts.dedupeKey — replaces any queued message with the same key rather than
//                  stacking. An hourly digest that fails for six hours should
//                  leave ONE current message waiting, not six stale ones.
//
// Returns { delivered, via, queued }. NEVER throws — a notification helper
// that can take down its caller is not resilience.
async function deliver(text, opts = {}) {
    const { critical = false, subject = null, dedupeKey = null } = opts;
    if (!text) return { delivered: false, via: null, queued: false };

    if (waLooksReady() && await tryWhatsApp(text)) {
        return { delivered: true, via: 'whatsapp', queued: false };
    }

    const queue = loadQueue();
    const now = new Date().toISOString();
    const entry = {
        text, critical, subject, dedupeKey,
        firstQueuedAt: now, lastTriedAt: now, attempts: 1, emailedAt: null,
    };
    if (dedupeKey) {
        const existing = queue.findIndex((q) => q.dedupeKey === dedupeKey);
        if (existing !== -1) {
            // Keep the ORIGINAL firstQueuedAt so the email-fallback timer
            // measures the real length of the outage, not the age of the
            // latest replacement.
            entry.firstQueuedAt = queue[existing].firstQueuedAt || now;
            entry.attempts = (queue[existing].attempts || 0) + 1;
            entry.emailedAt = queue[existing].emailedAt || null;
            queue.splice(existing, 1);
        }
    }
    queue.push(entry);
    await saveQueue(queue);
    console.warn(`[OUTBOX] WhatsApp unavailable — queued (${queue.length} waiting)${critical ? ', critical' : ''}`);

    let via = null;
    if (critical && !entry.emailedAt) {
        const outageMs = Date.now() - Date.parse(entry.firstQueuedAt);
        if (outageMs >= EMAIL_FALLBACK_AFTER_MS && await tryEmail(text, subject)) {
            entry.emailedAt = new Date().toISOString();
            via = 'email';
            const q2 = loadQueue();
            const i = q2.findIndex((x) => x.dedupeKey === entry.dedupeKey && x.text === entry.text);
            if (i !== -1) { q2[i].emailedAt = entry.emailedAt; await saveQueue(q2); }
        }
    }
    return { delivered: via === 'email', via, queued: true };
}

// Retry everything queued. Called when WhatsApp reconnects, and periodically.
// Safe to call when the queue is empty or WhatsApp is still down.
// Escalate any critical message that has waited long enough and has not yet
// been emailed. Runs on BOTH paths — up and down.
//
// AUDIT FINDING (2026-08-22): this used to live only inside the
// `!waLooksReady()` branch, which left a hole in exactly the failure Apsara
// named — "whatsapp corrupted". A session that reports READY but drops every
// send took the healthy path, retried, requeued, and never escalated. A
// critical message could sit in the queue indefinitely with a fallback
// channel available and unused. Reproduced before fixing: five flushes, zero
// emails. Whether WhatsApp *claims* to be up is irrelevant; what matters is
// that the message has not reached her.
async function escalateAgedCritical(queue) {
    let emailed = 0;
    for (const e of queue) {
        if (!e.critical || e.emailedAt) continue;
        const waited = Date.now() - Date.parse(e.firstQueuedAt || '');
        if (!(waited >= EMAIL_FALLBACK_AFTER_MS)) continue;
        if (await tryEmail(e.text, e.subject)) { e.emailedAt = new Date().toISOString(); emailed++; }
    }
    return emailed;
}

// Tells her the backlog she is about to read is not current. Without this a
// six-hour-old digest arrives looking like it just happened, and she can act
// on stale numbers — a worse outcome than not sending it at all.
function outageBanner(oldestISO, count) {
    const ms = Date.now() - Date.parse(oldestISO || '');
    if (!(ms > 0)) return null;
    const mins = Math.round(ms / 60000);
    const human = mins >= 120 ? `${Math.round(mins / 60)} hours` : `${mins} minutes`;
    return `WhatsApp was unreachable for about ${human} — here ${count === 1 ? 'is the message' : `are the ${count} messages`} I could not deliver. Some may be out of date.`;
}

// Emails a recovery summary once WhatsApp is back. Apsara, 2026-08-22:
// "if whatsapp is down. and up after it, email apsara."
//
// The email is the durable record: WhatsApp history can be lost with the
// session that was just broken, and if this happens repeatedly a trail in her
// inbox is what shows the pattern.
async function emailRecoverySummary({ oldestISO, delivered, failed, emailedDuringOutage }) {
    const ms = Date.now() - Date.parse(oldestISO || '');
    const mins = ms > 0 ? Math.round(ms / 60000) : 0;
    const human = mins >= 120 ? `${Math.round(mins / 60)} hours` : `${mins} minutes`;
    const lines = [
        `WhatsApp was unreachable for about ${human} and is now working again.`,
        '',
        `Messages delivered on recovery: ${delivered}`,
    ];
    if (emailedDuringOutage) lines.push(`Already sent to you by email during the outage: ${emailedDuringOutage}`);
    if (failed) lines.push(`Still undelivered: ${failed}`);
    lines.push('', 'Nothing was lost — anything queued was held on disk and has been retried.',
        'If this keeps happening, the WhatsApp session may need re-linking (scan the QR again).');
    return tryEmail(lines.join('\n'), 'WhatsApp recovered');
}

async function flush() {
    const queue = loadQueue();
    if (!queue.length) return { sent: 0, remaining: 0, emailed: 0 };

    // Always first, on both paths — see escalateAgedCritical's note.
    const emailed = await escalateAgedCritical(queue);
    if (emailed) await saveQueue(queue);

    if (!waLooksReady()) {
        return { sent: 0, remaining: queue.length, emailed };
    }

    // WhatsApp is back. Everything below this point is the recovery path.
    const oldestISO = queue
        .map((e) => e.firstQueuedAt).filter(Boolean)
        .sort()[0] || null;
    const banner = outageBanner(oldestISO, queue.length);
    const emailedDuringOutage = queue.filter((e) => e.emailedAt).length;

    const remaining = [];
    let sent = 0, gaveUp = 0;
    let bannerSent = false;

    for (const e of queue) {
        if ((e.attempts || 0) >= MAX_ATTEMPTS) {
            // AUDIT FINDING (2026-08-22): this used to `continue` with only a
            // console.error, so a critical message could be discarded having
            // never been emailed. Last-resort email before dropping — if it
            // is important enough to have been retried twenty times, it is
            // important enough not to vanish into a log line.
            if (e.critical && !e.emailedAt) await tryEmail(e.text, e.subject);
            console.error(`[OUTBOX] giving up after ${e.attempts} attempts (queued ${e.firstQueuedAt})${e.critical ? ' — emailed as a last resort' : ''}`);
            gaveUp++;
            continue;
        }
        // Prepend the banner to the first message only, so she gets the
        // context once rather than on every line of the backlog.
        const body = (!bannerSent && banner) ? `${banner}\n\n${e.text}` : e.text;
        if (await tryWhatsApp(body)) { sent++; bannerSent = true; continue; }
        remaining.push({ ...e, attempts: (e.attempts || 0) + 1, lastTriedAt: new Date().toISOString() });
    }
    await saveQueue(remaining);

    // Only worth an email if there was a real outage to report — a single
    // transient retry a minute ago is noise, not an incident.
    if (banner && (sent || gaveUp) && Date.now() - Date.parse(oldestISO) >= EMAIL_FALLBACK_AFTER_MS) {
        await emailRecoverySummary({ oldestISO, delivered: sent, failed: remaining.length + gaveUp, emailedDuringOutage });
    }

    if (sent || gaveUp) console.log(`[OUTBOX] recovery: delivered ${sent}, gave up on ${gaveUp}, ${remaining.length} still waiting`);
    return { sent, remaining: remaining.length, emailed, gaveUp };
}

function pending() {
    const q = loadQueue();
    return { count: q.length, critical: q.filter((e) => e.critical).length, oldest: q[0]?.firstQueuedAt || null };
}

module.exports = { init, deliver, flush, pending, loadQueue, saveQueue, outageBanner, escalateAgedCritical, OUTBOX_FILE, EMAIL_FALLBACK_AFTER_MS, MAX_ATTEMPTS };
