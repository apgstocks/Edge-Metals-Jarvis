// ── workflow/contactQuoteRequests.js — quote-to-any-contact orchestration ───
// Built 2026-08-16 per Apsara: "these are just truckers. i want to have
// another tab where there is quote request and have whatsapp/email support
// for quote." Orchestration layer on top of helpers/contactQuoteRequests.js's
// pure data/logic (same helpers/ vs workflow/ split as workflow/quoteRequests.js
// sitting on helpers/quoteRequests.js — see that file's own header).
//
// Entry points other files call:
//   startContactQuoteRequest()   — workflow/actions.js, from brain.js's 'get_contact_quote' intent
//   handleIncomingReply()        — workflow/actions.js / brain.js, for WhatsApp leg replies
//   handleReminderTask()         — scheduler.js's taskRunner, task.type === 'contact_quote_reminder'
//   handleEscalationTask()       — scheduler.js's taskRunner, task.type === 'contact_quote_escalation'
//   pollEmailReplies()           — scheduler.js cron, for email-channel legs
//
// DELIBERATELY NOT layered into workflow/quoteRequests.js's existing
// reminder/escalation handlers — those are keyed by trucker_name and
// task.type 'quote_reminder'/'quote_escalation'; this uses its own task
// types ('contact_quote_reminder'/'contact_quote_escalation') registered
// separately in scheduler.js, so nothing about the already-working trucker
// flow has to change to support this.

const cfg = require('../config');
const tasks = require('../helpers/tasks');
const { pushAlert } = require('../alerts');
const { loadSettings } = require('../helpers/json');
const cqr = require('../helpers/contactQuoteRequests');

function managerChatId() {
    const settings = loadSettings();
    return (settings.manager_number || cfg.MANAGER_NUMBER || '') + '@c.us';
}

// REBUILT 2026-08-16 (same day, later) per Apsara: "i should have quotes
// contact where i have separate group/whatsapp/email mimicking trucker
// implementation" — recipients now resolve to ONE channel via
// helpers/quoteRequests.js's resolveTruckerChannel (group_id → whatsapp →
// email, or preferred_mode:'email' outright), exactly like a trucker gets,
// not a dual email+WhatsApp candidate needing separate verification. This
// mirrors workflow/quoteRequests.js's dispatchLeg almost exactly — same
// channel values (whatsapp_group/whatsapp_individual/email), same shape —
// just building the message/subject from request.details instead of an
// origin→destination lane.
async function dispatchLeg(request, leg, send) {
    const message = cqr.buildContactQuoteMessage(request);
    try {
        if (leg.channel === 'whatsapp_group' || leg.channel === 'whatsapp_individual') {
            const ok = await send(leg.target, message);
            if (!ok) return false;
            await cqr.markLegSent(request.id, leg.channel);
        } else if (leg.channel === 'email') {
            const { sendEmail } = require('../helpers/gmail');
            const sent = await sendEmail({
                to: leg.target,
                subject: `Quote request: ${request.details}`,
                body: message,
            });
            await cqr.markLegSent(request.id, leg.channel, { email_thread_id: sent.threadId || null });
        } else {
            return false;
        }
        return true;
    } catch (err) {
        console.error(`[CONTACT QUOTE] dispatchLeg failed (${leg.channel}) for ${request.recipient_name}:`, err.message);
        return false;
    }
}

async function scheduleFirstReminder(request, leg) {
    await tasks.enqueue({
        type: 'contact_quote_reminder',
        target_kind: 'contact',
        target_name: request.recipient_name,
        target_chat: leg.channel !== 'email' ? leg.target : null,
        message: cqr.buildReminderMessage(request, 1),
        fire_at: new Date(Date.now() + cfg.QUOTE_REMINDER_SCHEDULE_MIN[0] * 60000).toISOString(),
        condition: { type: 'contact_quote_leg_awaiting_reply', request_id: request.id, channel: leg.channel },
        created_by: 'contact_quote_request',
        contact_quote_request_id: request.id,
        contact_quote_channel: leg.channel,
        contact_quote_stage: 1,
    });
}

// ── Main entry point ─────────────────────────────────────────────────────────
// legs: already-built [{channel, target, target_label}] — actions.js builds
// this directly from helpers/contactQuoteRequests.js's resolveQuoteContact
// result now (single resolved channel, trucker-style), one-element array.
async function startContactQuoteRequest({ recipientQuery, recipientName, details, legs, askedByChat, send }) {
    const request = await cqr.createContactQuoteRequest({ recipientQuery, recipientName, details, legs, askedByChat });

    const sentTo = [];
    const failed = [];
    for (const leg of request.legs) {
        const ok = await dispatchLeg(request, leg, send);
        if (ok) {
            sentTo.push(leg.channel);
            await scheduleFirstReminder(request, leg);
        } else {
            failed.push(leg.channel);
            await cqr.markLegFailed(request.id, leg.channel, `dispatch_failed_channel_${leg.channel}`);
            await pushAlert({
                type: 'contact_quote_leg_failed',
                bkgNo: null,
                message: `Couldn't send quote request to ${request.recipient_name} (${leg.channel}) — ${request.details}.`,
                severity: 'warning',
            });
        }
    }
    if (!sentTo.length) await cqr.maybeCloseRequest(request.id);

    await pushAlert({
        type: 'contact_quote_request_sent',
        bkgNo: null,
        message: `Quote request sent to ${request.recipient_name} (${sentTo.join(', ') || 'nobody — all sends failed'}) — ${request.details}`,
        severity: 'info',
    });

    return { request, sentTo, failed };
}

async function handleReminderTask(task, { send }) {
    const request = cqr.getRequestById(task.contact_quote_request_id);
    if (!request) return { fired: false, reason: 'request_gone' };
    const leg = request.legs.find((l) => l.channel === task.contact_quote_channel);
    if (!leg) return { fired: false, reason: 'leg_gone' };

    const stage = task.contact_quote_stage;
    const message = cqr.buildReminderMessage(request, stage);
    const ok = leg.channel === 'email'
        ? await sendEmailReminder(request, leg, message)
        : await send(leg.target, message);

    if (ok) {
        await cqr.recordReminderSent(request.id, leg.channel, stage);
        await pushAlert({
            type: 'contact_quote_reminder_sent', bkgNo: null,
            message: `Reminder ${stage} sent to ${request.recipient_name} (${leg.channel}) — ${request.details}`,
            severity: 'info',
        });
    }

    if (stage < cfg.QUOTE_REMINDER_SCHEDULE_MIN.length) {
        const sentAtMs = new Date(leg.sent_at).getTime();
        await tasks.enqueue({
            type: 'contact_quote_reminder',
            target_kind: 'contact', target_name: request.recipient_name,
            target_chat: leg.channel !== 'email' ? leg.target : null,
            message: cqr.buildReminderMessage(request, stage + 1),
            fire_at: new Date(sentAtMs + cfg.QUOTE_REMINDER_SCHEDULE_MIN[stage] * 60000).toISOString(),
            condition: { type: 'contact_quote_leg_awaiting_reply', request_id: request.id, channel: leg.channel },
            created_by: 'contact_quote_request',
            contact_quote_request_id: request.id,
            contact_quote_channel: leg.channel,
            contact_quote_stage: stage + 1,
        });
    } else {
        const sentAtMs = new Date(leg.sent_at).getTime();
        const lastStageMin = cfg.QUOTE_REMINDER_SCHEDULE_MIN[cfg.QUOTE_REMINDER_SCHEDULE_MIN.length - 1];
        await tasks.enqueue({
            type: 'contact_quote_escalation',
            target_kind: 'manager',
            target_chat: managerChatId(),
            message: `No price yet from ${request.recipient_name} (${leg.channel}) for "${request.details}" after 3 reminders — can you follow up?`,
            fire_at: new Date(sentAtMs + (lastStageMin + 30) * 60000).toISOString(),
            condition: { type: 'contact_quote_leg_awaiting_reply', request_id: request.id, channel: leg.channel },
            created_by: 'contact_quote_request',
            contact_quote_request_id: request.id,
            contact_quote_channel: leg.channel,
        });
    }
    return { fired: ok, stage };
}

async function sendEmailReminder(request, leg, message) {
    try {
        const { sendEmail } = require('../helpers/gmail');
        await sendEmail({
            to: leg.target,
            subject: `Re: Quote request: ${request.details}`,
            body: message,
            threadId: leg.email_thread_id || undefined,
        });
        return true;
    } catch (err) {
        console.error(`[CONTACT QUOTE] email reminder failed for ${request.recipient_name}:`, err.message);
        return false;
    }
}

async function handleEscalationTask(task, { send }) {
    const request = cqr.getRequestById(task.contact_quote_request_id);
    if (!request) return { fired: false, reason: 'request_gone' };
    const leg = request.legs.find((l) => l.channel === task.contact_quote_channel);
    if (!leg) return { fired: false, reason: 'leg_gone' };

    const ok = await send(managerChatId(), task.message);
    if (ok) {
        await cqr.markLegEscalated(request.id, leg.channel);
        await cqr.maybeCloseRequest(request.id);
        await pushAlert({
            type: 'contact_quote_escalated', bkgNo: null,
            message: `No response from ${request.recipient_name} (${leg.channel}) — "${request.details}" — escalated to manager`,
            severity: 'warning',
        });
    }
    return { fired: ok };
}

async function handleIncomingReply(chatId, text) {
    const matches = cqr.findActiveLegByTarget(chatId);
    if (!matches.length) return null;
    const { request, leg } = matches[0];

    const { classification } = await cqr.recordLegReply(request.id, leg.channel, text);

    if (classification.isPrice) {
        const cancelled = await cancelPendingTasksForLeg(request.id, leg.channel);
        await cqr.maybeCloseRequest(request.id);
        await pushAlert({
            type: 'contact_quote_price_received', bkgNo: null,
            message: `Price received from ${request.recipient_name}: ${classification.matchedText} — ${request.details}`,
            severity: 'info',
        });
        console.log(`[CONTACT QUOTE] ${request.recipient_name} priced ${classification.matchedText} — cancelled ${cancelled} pending task(s)`);
    } else {
        // REAL BUG (found 2026-08-17, live — Eccomelt replied "Checking" /
        // "Need scale tickets?" on 2026-08-16 and Jarvis kept firing
        // 30/60/90-min "any price yet?" reminders regardless, per Apsara:
        // "why jarvis cant listen to the whatsapp of vendor for quote
        // request"). This branch only ever pushed a dashboard alert and left
        // the OLD reminder schedule running untouched — any reply, priced or
        // not, means a human is actively engaged, so re-pinging them minutes
        // later reads as Jarvis not listening. Cancel whatever's queued and
        // restart the 30/60/90 clock from NOW — still nudges them if they go
        // quiet again after "Checking", but stops the immediate re-ping.
        const cancelled = await cancelPendingTasksForLeg(request.id, leg.channel);
        await scheduleFirstReminder(request, leg);
        await pushAlert({
            type: 'contact_quote_reply_received', bkgNo: null,
            message: `Reply from ${request.recipient_name} (no price detected): "${text.slice(0, 120)}"`,
            severity: 'info',
        });
        console.log(`[CONTACT QUOTE] ${request.recipient_name} replied without a price — cancelled ${cancelled} pending task(s), restarted follow-up clock`);
    }
    return { request, leg, classification };
}

async function cancelPendingTasksForLeg(requestId, channel) {
    const pending = tasks.loadTasks().filter((t) =>
        t.status === 'pending' &&
        (t.type === 'contact_quote_reminder' || t.type === 'contact_quote_escalation') &&
        t.contact_quote_request_id === requestId &&
        t.contact_quote_channel === channel
    );
    for (const t of pending) await tasks.cancel(t.id, 'price_received');
    return pending.length;
}

// ── Email reply polling — same approach/caveats as workflow/quoteRequests.js's
// pollEmailReplies (requires gmail-token-sender-read.json — see that file's
// own comment for the real incident behind this requirement). Reused via the
// same getGmailSenderRead() client, not a second one.
async function pollEmailReplies() {
    const legs = cqr.findActiveEmailLegs();
    if (!legs.length) return { checked: 0, replied: 0 };

    const { getGmailSenderRead, getMyEmailAddress, getEmailContent } = require('../helpers/gmail');
    const gmail = getGmailSenderRead();
    if (!gmail) {
        console.warn('[CONTACT QUOTE] pollEmailReplies: gmail-token-sender-read.json not set up yet — same requirement as workflow/quoteRequests.js. Email-leg replies will NOT be detected until then.');
        return { checked: legs.length, replied: 0, skipped: 'sender_read_token_missing' };
    }
    let replied = 0;

    for (const { request, leg } of legs) {
        try {
            const res = await gmail.users.threads.get({ userId: 'me', id: leg.email_thread_id, format: 'full' });
            const messages = res.data.messages || [];
            if (messages.length < 2) continue;

            const last = messages[messages.length - 1];
            const headers = last.payload.headers || [];
            const from = (headers.find((h) => h.name === 'From')?.value || '').toLowerCase();
            const myAddress = (await getMyEmailAddress(gmail)).toLowerCase();
            if (from.includes(myAddress)) continue;

            const { body } = getEmailContent(last.payload);
            await handleEmailLegReply(request, leg, body || '(empty body)');
            replied++;
        } catch (err) {
            console.error(`[CONTACT QUOTE] pollEmailReplies failed for ${request.recipient_name}'s thread:`, err.message);
        }
    }
    return { checked: legs.length, replied };
}

async function handleEmailLegReply(request, leg, text) {
    const { classification } = await cqr.recordLegReply(request.id, leg.channel, text);
    if (classification.isPrice) {
        const cancelled = await cancelPendingTasksForLeg(request.id, leg.channel);
        await cqr.maybeCloseRequest(request.id);
        await pushAlert({
            type: 'contact_quote_price_received', bkgNo: null,
            message: `Price received from ${request.recipient_name} (email): ${classification.matchedText} — ${request.details}`,
            severity: 'info',
        });
    } else {
        // Same fix as handleIncomingReply above.
        const cancelled = await cancelPendingTasksForLeg(request.id, leg.channel);
        await scheduleFirstReminder(request, leg);
        await pushAlert({
            type: 'contact_quote_reply_received', bkgNo: null,
            message: `Email reply from ${request.recipient_name} (no price detected): "${text.slice(0, 120)}"`,
            severity: 'info',
        });
        console.log(`[CONTACT QUOTE] ${request.recipient_name} (email) replied without a price — cancelled ${cancelled} pending task(s), restarted follow-up clock`);
    }
}

module.exports = {
    startContactQuoteRequest,
    handleReminderTask,
    handleEscalationTask,
    handleIncomingReply,
    pollEmailReplies,
};
