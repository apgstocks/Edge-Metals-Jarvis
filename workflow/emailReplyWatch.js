// ── workflow/emailReplyWatch.js — general sent-email reply poll ─────────────
// Built 2026-08-06 per Apsara: "notification bell icon in website for reply
// thread". Same pattern as workflow/quoteRequests.js's pollEmailReplies (own
// header there has the full reasoning for using getGmailSenderRead — read
// access to apsara@'s own mailbox, separate token from the send-only one),
// applied to the general email store in helpers/emailThreads.js instead of
// quote-request legs. Deliberately a separate function/module rather than
// folding this into pollEmailReplies itself — that function's whole shape
// (legs, request_id, price detection) is quote-specific; forcing this
// unrelated, simpler case through it would just be two different concerns
// wearing one function.

const qrThreads = require('../helpers/emailThreads');
const { pushAlert } = require('../alerts');

async function pollGeneralEmailReplies() {
    const threads = qrThreads.findAwaitingReplyThreads();
    if (!threads.length) return { checked: 0, replied: 0 };

    const { getGmailSenderRead, getMyEmailAddress, getEmailContent } = require('../helpers/gmail');
    const gmail = getGmailSenderRead();
    if (!gmail) {
        // Same silent-no-op-with-a-warning failure mode as
        // quoteRequests.js's pollEmailReplies when the sender-read token
        // isn't deployed yet — no point logging this twice per 5-minute
        // tick if that's already the known state; one warning is enough
        // signal that this needs the token deployed.
        console.warn('[EMAIL-REPLY-WATCH] gmail-token-sender-read.json not set up — general email replies will NOT be detected until then.');
        return { checked: threads.length, replied: 0, skipped: 'sender_read_token_missing' };
    }

    let replied = 0;
    const myAddress = (await getMyEmailAddress(gmail)).toLowerCase();

    for (const t of threads) {
        try {
            const res = await gmail.users.threads.get({ userId: 'me', id: t.thread_id, format: 'full' });
            const messages = res.data.messages || [];
            if (messages.length < 2) continue; // still just our own original send

            const last = messages[messages.length - 1];
            const headers = last.payload.headers || [];
            const from = (headers.find((h) => h.name === 'From')?.value || '').toLowerCase();
            if (from.includes(myAddress)) continue; // last message is still ours

            const { body } = getEmailContent(last.payload);
            await qrThreads.markThreadReplied(t.id, body || '(empty body)');

            // Relay routing — added 2026-08-06 alongside
            // relayQuestionToContact's email branch. A thread with relay_to
            // set came from a manager's ad-hoc question to an email-preferred
            // trucker/supplier, not a plain general email — the reply needs
            // to route back to the manager (and possibly auto-fire a
            // workflow transition on a clear yes), same as the WhatsApp
            // await_relay_reply pending already does for WhatsApp-preferred
            // contacts. relayReplyReceivedViaEmail handles all of that;
            // still push the bell alert too (below, same as any other
            // reply) so it's visible on the dashboard even though the
            // manager also gets a direct WhatsApp message from the relay.
            if (t.relay_to) {
                try {
                    const actions = require('./actions');
                    await actions.relayReplyReceivedViaEmail(t, body || '(empty body)');
                } catch (err) {
                    console.error(`[EMAIL-REPLY-WATCH] relay routing failed for thread ${t.thread_id} (${t.target_name || t.to}):`, err.message);
                }
            }

            await pushAlert({
                type: 'email_reply_received', bkgNo: t.bkg_no || null,
                message: `Reply from ${t.target_name || t.to} (re: "${t.subject || '(no subject)'}"): "${(body || '').slice(0, 120)}"`,
                severity: 'info',
            });
            replied++;
        } catch (err) {
            console.error(`[EMAIL-REPLY-WATCH] poll failed for thread ${t.thread_id} (${t.target_name || t.to}):`, err.message);
        }
    }
    return { checked: threads.length, replied };
}

module.exports = { pollGeneralEmailReplies };
