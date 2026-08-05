// ── helpers/emailThreads.js — general sent-email reply tracking ─────────────
// Built 2026-08-06 per Apsara: "notification bell icon in website for reply
// thread". Before this, the general draftEmailForConfirm/sendDraftedEmail
// flow ("email X about Y") sent an email and then tracked NOTHING — the
// Gmail threadId returned by sendEmail was discarded on the spot. Only
// quote-request emails (helpers/quoteRequests.js's own legs) had any reply
// tracking at all, and that's a different, heavier model (per-trucker legs,
// fixed reminder schedule, price detection) that doesn't fit a one-off
// general email. This is the much simpler equivalent for those: one row per
// sent email, a threadId to poll, and a plain awaiting/replied status.
//
// Deliberately NOT reusing quote_requests.json's shape — that file's
// "leg" concept (channel, trucker_name, reminders_sent, price) has no
// meaning here; forcing this into that shape would mean a lot of null
// fields and reader confusion. Same helpers/ (pure data) vs workflow/
// (orchestration — actually polling Gmail, pushing alerts) split used
// throughout this codebase.

const crypto = require('crypto');
const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

const loadEmailThreads = () => loadJson(cfg.EMAIL_THREADS_FILE, []);

// Called right after a successful sendEmail() in sendDraftedEmail (and the
// scheduled-email branch in scheduler.js's taskRunner) — threadId is
// whatever Gmail's API returned for that send. Skips tracking silently if
// no threadId came back (defensive — sendEmail's real-world return shape
// has been solid, but a missing threadId here should never be fatal to the
// send itself, which has already succeeded by the time this is called).
//
// relay fields (relayTo/askedOf/question/expectedIntent) — added 2026-08-06
// for relayQuestionToContact's email-preferred-contact path. All optional;
// unset for a plain general email (the original use of this function).
// When relayTo IS set, workflow/emailReplyWatch.js's poller knows this
// isn't just "notify the bell" — it's a manager's ad-hoc question whose
// reply needs to route BACK to relayTo, same as the WhatsApp
// await_relay_reply pending does today. See actions.js's
// relayReplyReceivedViaEmail for that side.
async function trackSentEmail({ threadId, to, targetName, subject, bkgNo, relayTo, askedOf, question, expectedIntent }) {
    if (!threadId) return null;
    const entry = {
        id: crypto.randomUUID(),
        thread_id: threadId,
        to: to || null,
        target_name: targetName || null,
        subject: subject || null,
        bkg_no: bkgNo || null,
        status: 'awaiting_reply',
        sent_at: new Date().toISOString(),
        last_reply_at: null,
        last_reply_text: null,
        relay_to: relayTo || null,
        asked_of: askedOf || null,
        question: question || null,
        expected_intent: expectedIntent || null,
    };
    await mutateJson(cfg.EMAIL_THREADS_FILE, [], (list) => { list.push(entry); return list; });
    return entry;
}

// Every thread still worth polling — capped by MAX_AGE_DAYS so this list
// doesn't grow unbounded with genuinely-abandoned threads from months ago;
// those are still visible in the raw file/dashboard history, just no longer
// polled every 5 minutes for no benefit.
const MAX_AGE_DAYS = 14;
function findAwaitingReplyThreads() {
    const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
    return loadEmailThreads().filter((t) => t.status === 'awaiting_reply' && new Date(t.sent_at).getTime() > cutoff);
}

async function markThreadReplied(id, text) {
    await mutateJson(cfg.EMAIL_THREADS_FILE, [], (list) => {
        const t = list.find((x) => x.id === id);
        if (!t) return list;
        t.status = 'replied';
        t.last_reply_at = new Date().toISOString();
        t.last_reply_text = text || null;
        return list;
    });
}

module.exports = { loadEmailThreads, trackSentEmail, findAwaitingReplyThreads, markThreadReplied };
