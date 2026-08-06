// ── workflow/quoteRequests.js — multi-trucker quote-request orchestration ───
// Built 2026-08-05 per Apsara's spec (see helpers/quoteRequests.js's header
// for the full design). This file is the ORCHESTRATION layer — actually
// sending messages/emails, scheduling reminder tasks, pushing dashboard
// alerts — on top of the pure data/logic functions in helpers/quoteRequests.js.
// Same helpers/ vs workflow/ split used throughout this codebase (compare
// workflow/truckers.js sitting on top of helpers/json's loadTruckers).
//
// Entry points other files call:
//   startQuoteRequest()        — workflow/actions.js, from brain.js's 'get_quote' intent
//   handleIncomingReply()      — workflow/actions.js / brain.js, for WhatsApp leg replies
//   handleQuoteReminderTask()  — scheduler.js's taskRunner, task.type === 'quote_reminder'
//   handleQuoteEscalationTask()— scheduler.js's taskRunner, task.type === 'quote_escalation'
//   pollEmailReplies()         — scheduler.js cron, for email-channel legs

const cfg = require('../config');
const tasks = require('../helpers/tasks');
const { pushAlert } = require('../alerts');
const { loadSettings, loadTruckers } = require('../helpers/json');
const { getTruckersByName } = require('./truckers');
const qr = require('../helpers/quoteRequests');

function managerChatId() {
    const settings = loadSettings();
    return (settings.manager_number || cfg.MANAGER_NUMBER || '') + '@c.us';
}

// REAL BUG (found 2026-08-05, live): Apsara typed "ask Jey Oakland" for a
// trucker actually saved as name "Jey" with locality "Oakland" — got
// "couldn't find: Jey Oakland" back. getTruckersByName's exact/substring
// check only looks at the `name` field, and only in ONE direction (does the
// SAVED name contain the typed query) — a query that's MORE specific than
// the saved name (adding a location to disambiguate, exactly the way a
// person naturally qualifies a common first name) can never match that way.
// This fallback — tried only when getTruckersByName finds nothing at all —
// requires every WORD the user typed to appear somewhere across name +
// locality combined, in any order. Deliberately NOT changed inside
// workflow/truckers.js's getTruckersByName itself: that function is shared
// with forwardBooking/assignSupplier elsewhere in the app, and loosening it
// there would change matching behavior for flows this fix was never tested
// against. Scoped to quote-request trucker resolution only.
function matchTruckersByTokens(query, allTruckers) {
    const tokens = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return [];
    return allTruckers.filter((t) => {
        const haystack = `${t.name || ''} ${t.locality || ''}`.toLowerCase();
        return tokens.every((tok) => haystack.includes(tok));
    });
}

// ── Trucker name resolution (wraps workflow/truckers.js with the same
// "ambiguous → ask, don't guess" rule Apsara asked for on lane resolution) ──
// Returns { resolved: [{name, trucker}], ambiguous: [{query, matches}], unresolved: [query] }
async function resolveTruckerNames(names) {
    const resolved = [];
    const ambiguous = [];
    const unresolved = [];
    let allTruckersCache = null;
    for (const query of names) {
        let matches = await getTruckersByName(query);
        if (!matches.length) {
            if (!allTruckersCache) allTruckersCache = await loadTruckers();
            matches = matchTruckersByTokens(query, allTruckersCache);
        }
        if (matches.length === 1) resolved.push({ name: query, trucker: matches[0] });
        else if (matches.length > 1) ambiguous.push({ query, matches });
        else unresolved.push(query);
    }
    return { resolved, ambiguous, unresolved };
}

// ── Sending the initial ask to one leg ───────────────────────────────────────
// send: injected WhatsApp sender (index.js's sendMessage). Returns true/false.
async function dispatchLeg(request, leg, send) {
    const message = qr.buildQuoteMessage(request);
    try {
        if (leg.channel === 'whatsapp_group' || leg.channel === 'whatsapp_individual') {
            const ok = await send(leg.target, message);
            if (!ok) return false;
            await qr.markLegSent(request.id, leg.trucker_name);
        } else if (leg.channel === 'email') {
            const { sendEmail } = require('../helpers/gmail');
            const sent = await sendEmail({
                to: leg.target,
                subject: `Quote request: ${request.origin_query} to ${request.destination_query}`,
                body: message,
            });
            await qr.markLegSent(request.id, leg.trucker_name, { email_thread_id: sent.threadId || null });
        } else {
            return false;
        }
        return true;
    } catch (err) {
        console.error(`[QUOTE] dispatchLeg failed for ${leg.trucker_name} (${leg.channel}):`, err.message);
        return false;
    }
}

// Schedules the FIRST reminder (stage 1, +30min from now — the moment the
// ask was actually sent) for one leg. Later stages are chained by
// handleQuoteReminderTask itself once each fires, not scheduled up front —
// keeps this simple and lets a leg that resolves early just skip the rest
// via the condition gate instead of needing 3 tasks cancelled at once.
async function scheduleFirstReminder(request, leg) {
    await tasks.enqueue({
        type: 'quote_reminder',
        target_kind: 'trucker',
        target_name: leg.trucker_name,
        target_chat: leg.channel !== 'email' ? leg.target : null,
        message: qr.buildReminderMessage(request, 1), // display-only fallback; actual text rebuilt at fire time
        fire_at: new Date(Date.now() + cfg.QUOTE_REMINDER_SCHEDULE_MIN[0] * 60000).toISOString(),
        condition: { type: 'quote_leg_awaiting_reply', request_id: request.id, trucker_name: leg.trucker_name },
        created_by: 'quote_request',
        quote_request_id: request.id,
        quote_stage: 1,
    });
}

// ── Main entry point: "get quote from LA to Richmond, ask Joey and Daekwang" ─
// truckerLegs: already-resolved [{ name, channel, target }] — ambiguity/
// no-match handling happens one layer up (workflow/actions.js), since THAT
// layer is the one talking to Apsara via pending confirmations; this
// function assumes everything handed to it is ready to actually send.
async function startQuoteRequest({ originQuery, destinationQuery, truckerLegs, askedByChat, send, cargoDetails }) {
    const request = await qr.createQuoteRequest({ originQuery, destinationQuery, truckerLegs, askedByChat, cargoDetails });

    const sentTo = [];
    const failed = [];
    for (const leg of request.legs) {
        const ok = await dispatchLeg(request, leg, send);
        if (ok) {
            sentTo.push(leg.trucker_name);
            await scheduleFirstReminder(request, request.legs.find((l) => l.trucker_name === leg.trucker_name));
        } else {
            failed.push(leg.trucker_name);
            // Per Apsara 2026-08-06: a leg whose send actually failed must
            // NOT stay 'awaiting_reply' — see markLegFailed's own comment
            // for the real incident (stuck-forever leg, no reminder, never
            // auto-closes) this closes off.
            await qr.markLegFailed(request.id, leg.trucker_name, `dispatch_failed_channel_${leg.channel}`);
            // Own alert, not just folded into the "nobody — all sends
            // failed" text below — that summary line only fires once per
            // whole request and gets buried when other legs DID send. A
            // failed leg needs to surface on its own in the bell (2026-08-06:
            // "there should be a notification bell... which works exactly
            // for this"), same as reminders/prices/escalations already do.
            await pushAlert({
                type: 'quote_leg_failed',
                bkgNo: null,
                message: `Couldn't send quote request to ${leg.trucker_name} (${request.origin_query} → ${request.destination_query}) — ${leg.channel} send failed.`,
                severity: 'warning',
            });
        }
    }
    // A request whose every leg failed to send has nothing left awaiting a
    // reply — close it immediately rather than leaving it 'active' with zero
    // live legs (maybeCloseRequest's own check already covers this the
    // moment every leg is non-awaiting, this just doesn't wait for a later
    // trigger to notice).
    if (!sentTo.length) await qr.maybeCloseRequest(request.id);

    await pushAlert({
        type: 'quote_request_sent',
        bkgNo: null,
        message: `Quote request sent to ${sentTo.join(', ') || '(nobody — all sends failed)'} for ${request.origin_query} → ${request.destination_query}`,
        severity: 'info',
    });

    return { request, sentTo, failed };
}

// ── Reminder firing (scheduler.js taskRunner → task.type === 'quote_reminder') ─
// The condition gate (helpers/tasks.js) already guarantees this only fires
// when the leg is STILL awaiting_reply, so no re-check needed here.
async function handleQuoteReminderTask(task, { send }) {
    const request = qr.getRequestById(task.quote_request_id);
    if (!request) return { fired: false, reason: 'request_gone' };
    const leg = request.legs.find((l) => l.trucker_name === task.condition.trucker_name);
    if (!leg) return { fired: false, reason: 'leg_gone' };

    const stage = task.quote_stage;
    const message = qr.buildReminderMessage(request, stage);
    const ok = leg.channel === 'email'
        ? await sendEmailReminder(request, leg, message)
        : await send(leg.target, message);

    if (ok) {
        await qr.recordReminderSent(request.id, leg.trucker_name, stage);
        await pushAlert({
            type: 'quote_reminder_sent', bkgNo: null,
            message: `Reminder ${stage} sent to ${leg.trucker_name} (${request.origin_query} → ${request.destination_query})`,
            severity: 'info',
        });
    }

    if (stage < cfg.QUOTE_REMINDER_SCHEDULE_MIN.length) {
        // More reminders left in the fixed schedule — schedule the next one,
        // timed off the leg's ORIGINAL sent_at (not "now"), so a late-firing
        // cron tick doesn't push every later stage back too.
        const sentAtMs = new Date(leg.sent_at).getTime();
        await tasks.enqueue({
            type: 'quote_reminder',
            target_kind: 'trucker', target_name: leg.trucker_name,
            target_chat: leg.channel !== 'email' ? leg.target : null,
            message: qr.buildReminderMessage(request, stage + 1),
            fire_at: new Date(sentAtMs + cfg.QUOTE_REMINDER_SCHEDULE_MIN[stage] * 60000).toISOString(),
            condition: { type: 'quote_leg_awaiting_reply', request_id: request.id, trucker_name: leg.trucker_name },
            created_by: 'quote_request',
            quote_request_id: request.id,
            quote_stage: stage + 1,
        });
    } else {
        // Fixed reminder schedule exhausted (30/60/90 all sent, still no
        // price) — per Apsara: "then ask manager to send reminder." One more
        // wait of the same 30-minute cadence before pinging the manager,
        // rather than escalating the instant the 3rd reminder goes out
        // (that would give the trucker zero time to answer stage 3 at all).
        // This interval is our own reasonable default, not something Apsara
        // specified a number for — flagged as such, easy to retune via
        // QUOTE_REMINDER_SCHEDULE_MIN + this one constant if 30 min feels
        // wrong in practice.
        const sentAtMs = new Date(leg.sent_at).getTime();
        const lastStageMin = cfg.QUOTE_REMINDER_SCHEDULE_MIN[cfg.QUOTE_REMINDER_SCHEDULE_MIN.length - 1];
        await tasks.enqueue({
            type: 'quote_escalation',
            target_kind: 'manager',
            // REAL BUG (found 2026-08-06 by cross-feature testing, PRE-EXISTING
            // since this feature was built 2026-08-05): helpers/tasks.js's
            // enqueue() hard-validates `target_name || target_chat` and THROWS
            // otherwise. This was the only enqueue call site in the codebase
            // supplying neither — target_kind:'manager' alone isn't enough for
            // that check, even though taskRunner and handleQuoteEscalationTask
            // both resolve the manager's chat themselves and never actually
            // read this field.
            //
            // Why it stayed hidden: this line only runs after a leg has gone
            // through ALL THREE reminders (90+ minutes) with no reply — never
            // reached in any same-session test. When it did run, the throw
            // propagated out of handleQuoteReminderTask into scheduler.js's
            // catch, which archived the stage-3 task as
            // 'runner_exception' — so the 3rd reminder was really sent, but
            // the escalation was NEVER scheduled and the manager was never
            // told "no price after 3 reminders." Silent death at the exact
            // point the chain is supposed to hand back to a human.
            target_chat: managerChatId(),
            message: `No price yet from ${leg.trucker_name} for ${request.origin_query} → ${request.destination_query} after 3 reminders — can you follow up?`,
            fire_at: new Date(sentAtMs + (lastStageMin + 30) * 60000).toISOString(),
            condition: { type: 'quote_leg_awaiting_reply', request_id: request.id, trucker_name: leg.trucker_name },
            created_by: 'quote_request',
            quote_request_id: request.id,
        });
    }
    return { fired: ok, stage };
}

async function sendEmailReminder(request, leg, message) {
    try {
        const { sendEmail } = require('../helpers/gmail');
        await sendEmail({
            to: leg.target,
            subject: `Re: Quote request: ${request.origin_query} to ${request.destination_query}`,
            body: message,
        });
        return true;
    } catch (err) {
        console.error(`[QUOTE] email reminder failed for ${leg.trucker_name}:`, err.message);
        return false;
    }
}

// ── Escalation firing (scheduler.js taskRunner → task.type === 'quote_escalation') ─
async function handleQuoteEscalationTask(task, { send }) {
    const request = qr.getRequestById(task.quote_request_id);
    if (!request) return { fired: false, reason: 'request_gone' };
    const leg = request.legs.find((l) => l.trucker_name === task.condition.trucker_name);
    if (!leg) return { fired: false, reason: 'leg_gone' };

    const ok = await send(managerChatId(), task.message);
    if (ok) {
        await qr.markLegEscalated(request.id, leg.trucker_name);
        await qr.maybeCloseRequest(request.id);
        await pushAlert({
            type: 'quote_escalated', bkgNo: null,
            message: `No response from ${leg.trucker_name} for ${request.origin_query} → ${request.destination_query} — escalated to manager`,
            severity: 'warning',
        });
    }
    return { fired: ok };
}

// ── Incoming WhatsApp reply from an active leg's chat ────────────────────────
// Called from brain.js (before normal intent classification — see its own
// A(-1) check) once findActiveLegByTarget confirms this chatId is genuinely
// waiting on a price. Cancels the pending reminder/escalation chain the
// moment a price lands, per Apsara: "until you get price."
async function handleIncomingReply(chatId, text) {
    const matches = qr.findActiveLegByTarget(chatId);
    if (!matches.length) return null;
    // Same "one live ask per chat at a time in practice" assumption as
    // findActiveLegByTarget's own comment — take the first, but this is the
    // spot to revisit if that assumption ever breaks in real use.
    const { request, leg } = matches[0];

    const { classification } = await qr.recordLegReply(request.id, leg.trucker_name, text);

    if (classification.isPrice) {
        const cancelled = await cancelPendingTasksForLeg(request.id, leg.trucker_name);
        await qr.maybeCloseRequest(request.id);
        await pushAlert({
            type: 'quote_price_received', bkgNo: null,
            message: `Price received from ${leg.trucker_name}: ${classification.matchedText} (${request.origin_query} → ${request.destination_query})`,
            severity: 'info',
        });
        console.log(`[QUOTE] ${leg.trucker_name} priced ${classification.matchedText} — cancelled ${cancelled} pending reminder task(s)`);
    } else {
        // Still worth surfacing — Apsara asked for ALL these events
        // (sent/reminder/escalation/price) as dashboard notifications, and a
        // non-price reply ("call me", "not today") is real signal even
        // though the reminder schedule keeps running unchanged.
        await pushAlert({
            type: 'quote_reply_received', bkgNo: null,
            message: `Reply from ${leg.trucker_name} (no price detected): "${text.slice(0, 120)}"`,
            severity: 'info',
        });
    }
    return { request, leg, classification };
}

// Cancels every still-pending quote_reminder/quote_escalation task tied to
// this (request, trucker) pair. tasks.js's own cancelMatching() filters by
// bkg_no/container_seq, which these tasks don't have — a small local filter
// here instead of stretching that helper to fit a shape it wasn't built for.
async function cancelPendingTasksForLeg(requestId, truckerName) {
    const pending = tasks.loadTasks().filter((t) =>
        t.status === 'pending' &&
        (t.type === 'quote_reminder' || t.type === 'quote_escalation') &&
        t.quote_request_id === requestId &&
        t.condition?.trucker_name === truckerName
    );
    for (const t of pending) await tasks.cancel(t.id, 'price_received');
    return pending.length;
}

// ── Email reply polling (scheduler.js cron) ──────────────────────────────────
// No inbound-email watcher exists anywhere else in this codebase for
// trucker-style correspondence (emailWatcher.js's poll is scoped to
// bose@edgemetals.com's carrier booking intake, a different mailbox/purpose
// entirely) — this is a new, narrow poll: for every active email leg, check
// whether its own Gmail thread (captured at send time via sendEmail's
// returned threadId) has grown past 1 message, meaning a reply arrived.
//
// REAL BUG (found 2026-08-05, caught by Apsara asking "will it check
// apsara's inbox?" before this had ever actually run against a live reply):
// this originally called getGmailWrite() to read the thread — but per
// helpers/gmail.js's own header, that client is deliberately scoped to
// gmail.send ONLY ("structurally cannot list or read anything"), precisely
// so a bug in the send path can never accidentally read anyone's inbox. A
// read call against a send-only token fails with an insufficient-scope
// error from Gmail's API every single time — this poll would have silently
// errored on every tick and never once detected a real reply. The correct
// client is getGmailSenderRead() — READ access to apsara@'s own mailbox,
// same account, separate token (gmail-token-sender-read.json). That token
// does not exist yet (confirmed: only gmail-token-read.json and
// gmail-token-write.json are present) — getGmailSenderRead() returns null
// (not a throw) until scripts/gmail-auth.js --role=sender-read is run once,
// signed into apsara@edgemetals.com, and the resulting token file is
// deployed to the VM's DATA_DIR. Until then this poll no-ops loudly (one
// warning per tick) rather than silently doing nothing.
async function pollEmailReplies() {
    const legs = qr.findActiveEmailLegs();
    if (!legs.length) return { checked: 0, replied: 0 };

    const { getGmailSenderRead } = require('../helpers/gmail');
    const gmail = getGmailSenderRead();
    if (!gmail) {
        console.warn('[QUOTE] pollEmailReplies: gmail-token-sender-read.json not set up yet — run scripts/gmail-auth.js --role=sender-read (signed into apsara@edgemetals.com) and deploy the token file. Email-leg replies will NOT be detected until then.');
        return { checked: legs.length, replied: 0, skipped: 'sender_read_token_missing' };
    }
    let replied = 0;

    for (const { request, leg } of legs) {
        try {
            const res = await gmail.users.threads.get({ userId: 'me', id: leg.email_thread_id, format: 'full' });
            const messages = res.data.messages || [];
            if (messages.length < 2) continue; // still just our own original send

            // Last message in the thread — if it's not from us, it's the reply.
            const last = messages[messages.length - 1];
            const headers = last.payload.headers || [];
            const from = (headers.find((h) => h.name === 'From')?.value || '').toLowerCase();
            const { getMyEmailAddress } = require('../helpers/gmail');
            const myAddress = (await getMyEmailAddress(gmail)).toLowerCase();
            if (from.includes(myAddress)) continue; // last message is still ours (e.g. our own reminder)

            const { getEmailContent } = require('../helpers/gmail');
            const { body } = getEmailContent(last.payload);
            await handleEmailLegReply(request, leg, body || '(empty body)');
            replied++;
        } catch (err) {
            console.error(`[QUOTE] pollEmailReplies failed for ${leg.trucker_name}'s thread:`, err.message);
        }
    }
    return { checked: legs.length, replied };
}

// Same logic as handleIncomingReply, but keyed by (requestId, truckerName)
// directly since there's no chatId for an email leg — kept as a separate
// small function rather than overloading handleIncomingReply's chatId-based
// lookup with an alternate identity path.
async function handleEmailLegReply(request, leg, text) {
    const { classification } = await qr.recordLegReply(request.id, leg.trucker_name, text);
    if (classification.isPrice) {
        const cancelled = await cancelPendingTasksForLeg(request.id, leg.trucker_name);
        await qr.maybeCloseRequest(request.id);
        await pushAlert({
            type: 'quote_price_received', bkgNo: null,
            message: `Price received from ${leg.trucker_name} (email): ${classification.matchedText} (${request.origin_query} → ${request.destination_query})`,
            severity: 'info',
        });
        console.log(`[QUOTE] ${leg.trucker_name} (email) priced ${classification.matchedText} — cancelled ${cancelled} pending task(s)`);
    } else {
        await pushAlert({
            type: 'quote_reply_received', bkgNo: null,
            message: `Email reply from ${leg.trucker_name} (no price detected): "${text.slice(0, 120)}"`,
            severity: 'info',
        });
    }
}

module.exports = {
    resolveTruckerNames,
    startQuoteRequest,
    handleQuoteReminderTask,
    handleQuoteEscalationTask,
    handleIncomingReply,
    pollEmailReplies,
};
