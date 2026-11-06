// ── helpers/pickupMail.js — the Follow-up Agent's one outbound door ──────
// Apsara, 2026-11-06: "it should follow up with the logistic company about
// the pickup eta na?"
//
// helpers/followUpAgentJob.js takes its senders as arguments and knows
// nothing about mailboxes — that is what lets a test prove it stayed quiet.
// This is the real sender it is handed by scheduler.js, and it is a separate
// file for one reason: it is the only place in this feature that can put
// text in front of a company she buys from. One door is a door that can be
// audited.
//
// ── IT DOES TWO THINGS, AND THE SECOND IS THE IMPORTANT ONE ──────────────
// 1. Send.
// 2. Put the thread on the reply watch that ALREADY EXISTS.
//
// workflow/emailReplyWatch.js has polled every five minutes since August for
// replies to threads Jarvis sent. Hooking into it means the carrier's answer
// is noticed by machinery that is already proven, instead of a second poller
// written this week. The pickup is closed by the reply, not by a guess.
//
// ── WHAT IT WILL NOT DO ──────────────────────────────────────────────────
// It does not retry. A send that fails comes back as a thrown error, the
// agent records NOTHING as sent, and the next hourly tick tries again — see
// the failure branch in followUpAgentJob. Retrying here as well would mean
// two layers each quietly having three goes, and six copies of the same
// chase landing in a carrier's inbox is worse than one that is late.
const gmail = require('./gmail');

const str = (v) => String(v == null ? '' : v).trim();

// sendTrackedEmail({ to, subject, body, threadId, pickupId })
//   → { threadId } so the agent can keep it on the pickup.
//
// `threadId` in means "reply on the thread already open with them", which is
// why the chase subject is "Re: ..." — a chase arriving as a fresh thread
// makes the reader hunt for the original, and that is how a chase gets left
// until tomorrow.
async function sendTrackedEmail({ to, subject, body, threadId, pickupId } = {}) {
    const dest = str(to);
    if (!dest) throw new Error('no address to send the follow-up to');

    const res = await gmail.sendEmail({
        to: dest,
        subject: str(subject),
        body: str(body),
        threadId: str(threadId) || undefined,
    });

    const newThread = (res && (res.threadId || res.thread_id)) || str(threadId) || '';

    // ── ON THE WATCH, OR THE REPLY IS NEVER SEEN ─────────────────────────
    // Best effort on purpose. If tracking fails the mail has still GONE, and
    // throwing here would make the agent record the rung as unsent and send
    // it again on the next tick — punishing the carrier for a bookkeeping
    // slip at our end. The cost of a lost track is that her reply closes the
    // pickup by hand instead of automatically.
    if (newThread) {
        try {
            await require('./emailThreads').trackSentEmail({
                threadId: newThread,
                to: dest,
                targetName: str(to),
                subject: str(subject),
                askedOf: 'logistics',
                question: 'pickup ETA',
                // Read by whatever closes the pickup when the reply lands, so
                // the answer can be filed against the right arrangement
                // rather than matched back by subject line.
                expectedIntent: pickupId ? `pickup_eta:${str(pickupId)}` : 'pickup_eta',
            });
        } catch (e) {
            console.warn('[FOLLOW-UP] sent but not tracked for a reply: ' + (e && e.message));
        }
    }
    return { threadId: newThread };
}

module.exports = { sendTrackedEmail };
