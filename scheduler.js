// ── scheduler.js — node-cron jobs (replaces Cloud Scheduler + Pub/Sub) ───────
// All schedules run in America/Los_Angeles because every freight deadline
// (ERD/cutoff) is a US port date. Dedup via brain.proactive_sent so a restart
// mid-day never double-sends.

const cron = require('node-cron');
const { loadBookings, loadWorkflow, mutateBrain, loadBrain,
        mutateJson, loadHistory } = require('./helpers/json');
const { daysUntil, getLADate }    = require('./helpers/time');
const { getUrgentBookings }       = require('./helpers/booking');
const { stepLabel }               = require('./helpers/booking');
const { pushAlert }               = require('./alerts');
const cfg = require('./config');
const emailWatcher = require('./workflow/emailWatcher');
const { pickVariant } = require('./helpers/phrasing');
const actions = require('./workflow/actions');

let _sendToManager = async () => {}, _sendToTeam = async () => {}, _sendMessage = async () => {};
function init({ sendToManager, sendToTeam, sendMessage }) {
    _sendToManager = sendToManager;
    _sendToTeam    = sendToTeam;
    if (sendMessage) _sendMessage = sendMessage;
    emailWatcher.init({ sendToManager });
}

const TZ = { timezone: 'America/Los_Angeles' };
const todayKey = () => getLADate().toDateString();

async function markSent(key) { await mutateBrain(b => { b.proactive_sent[key] = new Date().toISOString(); }); }
const alreadySent = (key) => !!loadBrain().proactive_sent[key];

// ── 9AM — daily trucker-assignment wizard trigger ───────────────────────────
// Kicks off the guided flow: "need to send any bookings to a trucker today?"
// The rest of the conversation (port → booking → supplier → trucker →
// confirm) is handled by workflow/actions.js's wizardAdvance, driven by the
// normal pending-resolution path — this function only sends the opener.
async function dailyTruckerCheck() {
    const key = `trucker_wizard_${todayKey()}`;
    if (alreadySent(key)) return;

    const settings = cfg.getSettings ? cfg.getSettings() : {};
    const managerChat = (settings.manager_number || cfg.MANAGER_NUMBER || '') + '@c.us';
    const teamChat = settings.team_group_id || managerChat;
    if (!teamChat || teamChat === '@c.us') return; // nothing configured to send to

    // Mark BEFORE sending, not after — if the process restarts between the
    // send and the mark (a real risk on a day with many restarts), the guard
    // never persists and the next cron tick or restart fires the whole
    // sequence again: duplicate message, AND a fresh setPending overwriting
    // whatever pending was already there. Marking first means a crash after
    // this point just costs one skipped morning prompt, not a duplicate.
    await markSent(key);
    const staged = await actions.setPending(teamChat, { type: 'wizard_start' });
    if (staged.queued) {
        // Something on this chat is already unresolved (e.g. last night's
        // learning digest never got answered) — don't show a live yes/no
        // prompt for a wizard that isn't actually the active pending yet.
        await _sendToTeam(`(Morning trucker check queued — you have a pending "${staged.blockedBy}" to answer first. I'll ask once that's resolved.)`);
        return;
    }
    await _sendToTeam('Morning — any bookings need to go out to a trucker today? (yes/no)');
}

// ── 8AM — morning digest ──────────────────────────────────────────────────────
async function morningDigest() {
    const key = `daily_digest_${todayKey()}`;
    if (alreadySent(key)) return;

    const bookings = loadBookings();
    const workflow = loadWorkflow();
    const active   = Object.values(bookings);
    if (!active.length) return;

    const { laggingContainers, allContainersTerminal } = require('./helpers/containers');

    const urgent = getUrgentBookings();
    const stuck  = Object.entries(workflow).filter(([bkgNo, wf]) => {
        if (!bookings[bkgNo] || allContainersTerminal(bookings[bkgNo])) return false;
        if (cfg.TERMINAL_STEPS.includes(wf.step) && !Array.isArray(bookings[bkgNo]?.containers)) return false;
        const last = new Date(wf.updated_at || wf.created_at || 0).getTime();
        return Date.now() - last > 2 * 86400000; // no movement in 48h
    });

    // Per-booking urgent line: if multi-container, list lagging containers explicitly.
    const urgentLine = (b) => {
        const wf   = workflow[b.booking_number] || {};
        const lag  = laggingContainers(b);
        const dLeft = daysUntil(b.cutoff_date);
        if (Array.isArray(b.containers) && b.containers.length > 1 && lag.length > 0 && lag.length < b.containers.length) {
            const lagList = lag.map(c => `${b.booking_number}/${c.seq} (${stepLabel(c.stage)})`).join(', ');
            return `- ${b.booking_number} cutoff ${b.cutoff_date} (${dLeft}d) — lagging: ${lagList}`;
        }
        return `- ${b.booking_number} cutoff ${b.cutoff_date} (${dLeft}d) — ${stepLabel(wf.step)}`;
    };

    const lines = [
        `Morning digest — ${active.length} active booking(s)`,
        '',
        urgent.length ? 'URGENT CUTOFFS:' : 'No urgent cutoffs.',
        ...urgent.map(urgentLine),
    ];
    if (stuck.length) {
        lines.push('', 'STUCK (48h+ no movement):');
        lines.push(...stuck.map(([bkgNo, wf]) => `- ${bkgNo} at ${stepLabel(wf.step)}`));
    }

    await _sendToManager(lines.join('\n'));
    await markSent(key);
    console.log('[SCHED] Morning digest sent');
}

// ── Hourly 9–17 — urgent cutoff watch ─────────────────────────────────────────
// Alerts fire per lagging container on multi-container bookings, or per-booking
// on single-container bookings. Booking is considered done when ALL containers
// reach a terminal stage (per user rule: cutoff is booking-level).
async function urgentWatch() {
    const workflow = loadWorkflow();
    const { laggingContainers, allContainersTerminal } = require('./helpers/containers');

    for (const b of getUrgentBookings()) {
        const wf = workflow[b.booking_number] || {};
        if (allContainersTerminal(b)) continue;
        // Legacy flat: fall back to top-level step
        if (!Array.isArray(b.containers) && cfg.TERMINAL_STEPS.includes(wf.step)) continue;

        const d   = daysUntil(b.cutoff_date);
        const key = `urgent_${b.booking_number}_${todayKey()}`;
        if (alreadySent(key)) continue;

        const lag = laggingContainers(b);
        let message;
        if (lag.length > 0 && Array.isArray(b.containers) && b.containers.length > 1) {
            const lagList = lag.map(c => `${b.booking_number}/${c.seq} at ${stepLabel(c.stage)}`).join(', ');
            message = `${b.booking_number}: cutoff in ${d}d — lagging: ${lagList}`;
        } else {
            message = `${b.booking_number}: cutoff in ${d}d, still at "${stepLabel(wf.step)}"`;
        }

        await pushAlert({
            type    : 'cutoff_risk',
            bkgNo   : b.booking_number,
            message,
            severity: d <= 1 ? 'high' : 'warning',
        });
        if (d <= 1) await _sendToTeam(`${b.booking_number}: cutoff TOMORROW — ${lag.length && Array.isArray(b.containers) && b.containers.length > 1 ? `${lag.length} of ${b.containers.length} containers still lagging` : `still at "${stepLabel(wf.step)}"`}. Escalate now.`);
        await markSent(key);
    }
}

// ── Hourly — stall detection + proactive outreach ──────────────────────────
// Piggybacks on the same cron slot as urgentWatch (9-17 LA time). Different
// concern though: urgentWatch is cutoff-deadline-driven; this is STAGE-STALL
// driven — a booking that's been sitting in the same step too long, regardless
// of how far away the cutoff is. Two of the seven steps (not_started,
// supplier_assigned) are MANAGER-side stalls — nobody else can act, so the
// "check-in" is a direct reminder to the manager, not outreach to a contact.
// The rest ping the trucker/supplier who actually owns the next action, using
// a plain nudge message — NOT a new pending/state-machine, so whatever they
// reply naturally flows through the EXISTING trucker/supplier keyword
// handling in workflow/brain.js. Two-tier: check-in first, escalate to
// manager only if that goes unanswered past stall_escalation_hours.
const STALL_PARTY = {
    not_started       : 'manager',
    supplier_assigned : 'manager',
    forwarded         : 'trucker',
    empty_dropped     : 'supplier',
    load_ready        : 'trucker',
    picked_up         : 'trucker',
};
const STALL_NUDGE = {
    forwarded         : [
        (bkg) => `Checking in on ${bkg} — any update on the empty pickup?`,
        (bkg) => `Hey — where are we on the empty pickup for ${bkg}?`,
        (bkg) => `${bkg}: has the empty been picked up yet?`,
    ],
    empty_dropped     : [
        (bkg) => `Checking in on ${bkg} — is the load ready yet?`,
        (bkg) => `${bkg} — how's loading coming along?`,
        (bkg) => `Any word on load-ready for ${bkg}?`,
    ],
    load_ready        : [
        (bkg) => `Checking in on ${bkg} — has pickup happened yet?`,
        (bkg) => `${bkg} — did the trucker pick up yet?`,
        (bkg) => `Any update on pickup for ${bkg}?`,
    ],
    picked_up         : [
        (bkg) => `Checking in on ${bkg} — scale ticket ready?`,
        (bkg) => `${bkg} — got the scale ticket yet?`,
        (bkg) => `Any word on the scale ticket for ${bkg}?`,
    ],
};
const STALL_MANAGER_REMINDER = {
    not_started       : [
        (bkg, hrs) => `${bkg} has had no supplier assigned for ${hrs}h — needs attention.`,
        (bkg, hrs) => `Heads up — ${bkg} is still unassigned after ${hrs}h.`,
        (bkg, hrs) => `${bkg}: no supplier yet, ${hrs}h and counting.`,
    ],
    supplier_assigned : [
        (bkg, hrs) => `${bkg} has a supplier but hasn't been forwarded to a trucker in ${hrs}h.`,
        (bkg, hrs) => `${bkg} is assigned but sitting unforwarded — ${hrs}h now.`,
        (bkg, hrs) => `Heads up — ${bkg} still needs to go to a trucker, ${hrs}h since assignment.`,
    ],
};

async function stallWatch() {
    const settings   = cfg.getSettings ? cfg.getSettings() : {};
    const thresholds = settings.stall_thresholds_hours || {};
    const escalateAfterHrs = settings.stall_escalation_hours ?? 24;
    const bookings = loadBookings();
    const workflow = loadWorkflow();
    const { allContainersTerminal } = require('./helpers/containers');

    for (const b of Object.values(bookings)) {
        if (allContainersTerminal(b)) continue;
        const wf = workflow[b.booking_number] || {};
        const step = wf.step || 'not_started';
        if (cfg.TERMINAL_STEPS.includes(step)) continue;

        // Dual-role contact (supplier = trucker, same entity) — doesn't get
        // the normal stage-by-stage nudges (empty pickup / load ready / scale
        // ticket), since they only report back once at the end with the
        // scale ticket. Instead: periodic cutoff/ERD reminder, and once the
        // ERD window has actually started, ask for the container number
        // specifically — that's the one thing actually needed from them
        // mid-process.
        if (wf.dual_role) {
            const truckers = require('./workflow/truckers');
            const chatId = await truckers.getTruckerGroupIdForBooking(b.booking_number);
            const erdStarted = b.erd_date && new Date() >= new Date(b.erd_date);
            const hasContainerNumber = !!(wf.container_number || b.container_number);

            if (step === 'forwarded' && erdStarted && !hasContainerNumber) {
                const key = `dualrole_container_${b.booking_number}`;
                if (!alreadySent(key) && chatId) {
                    await actions.setPending(chatId, { type: 'await_container_number', bkg_no: b.booking_number });
                    await _sendMessage(chatId, `${b.booking_number}: ERD has started — what's the container number?`);
                    await markSent(key);
                }
            } else {
                const key = `dualrole_reminder_${b.booking_number}_${todayKey()}`;
                if (!alreadySent(key) && chatId) {
                    const d = b.cutoff_date ? daysUntil(b.cutoff_date) : null;
                    const msg = `${b.booking_number}: reminder — ERD ${b.erd_date || '—'}, cutoff ${b.cutoff_date || '—'}${d != null ? ` (${d}d)` : ''}.`;
                    await _sendMessage(chatId, msg);
                    await markSent(key);
                }
            }
            continue;
        }

        const threshold = thresholds[step];
        if (!threshold) continue; // no threshold configured for this step — skip silently
        const enteredAt = wf.stage_entered_at || wf.created_at;
        if (!enteredAt) continue;
        const hoursInStage = (Date.now() - new Date(enteredAt).getTime()) / (1000 * 60 * 60);
        if (hoursInStage < threshold) continue;

        const stageKey = `${b.booking_number}_${step}_${enteredAt}`;
        const checkinKey   = `stall_checkin_${stageKey}`;
        const escalateKey  = `stall_escalate_${stageKey}`;
        const party = STALL_PARTY[step];
        const hrsRounded = Math.round(hoursInStage);

        if (!alreadySent(checkinKey)) {
            // First touch — check in.
            if (party === 'manager') {
                const msg = STALL_MANAGER_REMINDER[step]
                    ? pickVariant(STALL_MANAGER_REMINDER[step], b.booking_number, hrsRounded)
                    : `${b.booking_number} stalled at "${stepLabel(step)}" for ${hrsRounded}h.`;
                await pushAlert({ type: 'stall', bkgNo: b.booking_number, message: msg, severity: 'warning' });
                await _sendToTeam(msg);
            } else {
                const truckers  = require('./workflow/truckers');
                const suppliers = require('./workflow/suppliers');
                const chatId = party === 'trucker'
                    ? await truckers.getTruckerGroupIdForBooking(b.booking_number)
                    : await suppliers.getSupplierGroupIdForBooking(b.booking_number);
                const nudge = STALL_NUDGE[step]
                    ? pickVariant(STALL_NUDGE[step], b.booking_number)
                    : `Checking in on ${b.booking_number} — any update?`;
                if (chatId) await _sendMessage(chatId, nudge);
                await pushAlert({ type: 'stall', bkgNo: b.booking_number, message: `${b.booking_number} stalled at "${stepLabel(step)}" for ${hrsRounded}h — pinged ${party}.`, severity: 'info' });
            }
            await markSent(checkinKey);
        } else if (hoursInStage >= threshold + escalateAfterHrs && !alreadySent(escalateKey)) {
            // Checked in already, still no movement after the escalation window — tell the manager.
            const msg = party === 'manager'
                ? `${b.booking_number} STILL stalled at "${stepLabel(step)}" — ${hrsRounded}h now, needs direct attention.`
                : `${b.booking_number}: no response from ${party} after check-in — stalled at "${stepLabel(step)}" for ${hrsRounded}h. Might need a call.`;
            await pushAlert({ type: 'stall_escalated', bkgNo: b.booking_number, message: msg, severity: 'high' });
            await _sendToTeam(msg);
            await markSent(escalateKey);
        }
    }
}

// ── 11PM — auto-archive (cutoff passed yesterday, no ingate, not kept) ────────
// Multi-container rule: archive only if ALL containers are in a terminal stage.
// If /1 is ingated but /2 is still forwarded, the booking stays active so ops
// can decide (recall /2, escalate, etc).
async function autoArchive() {
    const bookings = loadBookings();
    const workflow = loadWorkflow();
    const { allContainersTerminal } = require('./helpers/containers');
    const archived = [];

    for (const [bkgNo, b] of Object.entries(bookings)) {
        if (!b.cutoff_date) continue;
        const d  = daysUntil(b.cutoff_date);
        const wf = workflow[bkgNo] || {};
        if (d > -1) continue;                                  // archive anything 1+ days past cutoff
        if (wf.keep_active) continue;

        // Cutoff passed = strict archive regardless of container completion —
        // if any further movement happens, it happens under a NEW booking
        // (Apsara's correction, 2026-08-01): a container still shown as
        // not_started/empty_dropped on an expired booking isn't "still in
        // progress," it's just stale data. The record isn't lost — it moves
        // to history.json with its actual final container states intact, so
        // an incomplete booking is still visible there, just off the active
        // dashboard. Previously this required allContainersTerminal() to be
        // true first; that gate is removed.

        await mutateJson(cfg.HISTORY_FILE, {}, (h) => {
            h[bkgNo] = { ...b, archived_at: new Date().toISOString(), archive_reason: 'cutoff_passed_auto', final_step: wf.step || 'not_started' };
            return h;
        });
        await mutateJson(cfg.BOOKINGS_FILE, {}, (x) => { delete x[bkgNo]; return x; });
        await mutateJson(cfg.WORKFLOW_FILE, {}, (x) => { delete x[bkgNo]; return x; });
        archived.push(bkgNo);
    }

    if (!archived.length) return;
    const msg = [`Auto-archived ${archived.length} booking(s):`, ...archived, '', 'Cutoff passed with no ingate. See dashboard → history.'].join('\n');
    await _sendToTeam(msg);
    await _sendToManager(msg);
    await pushAlert({ type: 'auto_archived', bkgNo: null, message: `Auto-archived: ${archived.join(', ')}`, severity: 'info' });
}

// ── 10:45PM — nightly field backfill ────────────────────────────────────────
// Scans every active booking missing ANY of cutoff/ERD/ETD/ETA/vessel/route
// (see BACKFILL_FIELDS in helpers/cutoffBackfill.js) and tries to fill it
// from existing mail. Runs before autoArchive (11PM) on purpose: a booking
// that's ACTUALLY past cutoff but just never had the field populated
// shouldn't dodge archiving forever purely because cutoff_date was empty —
// this gives it one more chance to get filled in first, same night, before
// the archive check runs.
async function nightlyCutoffBackfill() {
    let results;
    let FIELD_LABELS;
    try {
        const mod = require('./helpers/cutoffBackfill');
        FIELD_LABELS = mod.FIELD_LABELS;
        results = await mod.run();
    } catch (err) {
        console.error('[SCHED] cutoff-backfill:', err.message);
        return;
    }
    if (!results.length) return;
    const lines = results.map((r) => {
        const parts = Object.entries(r.filled).map(([k, v]) => `${FIELD_LABELS[k] || k}: ${v}`);
        return `${r.bkgNo} — ${parts.join(', ')}`;
    });
    await _sendToManager(`Nightly backfill — filled missing fields from existing mail:\n${lines.join('\n')}`);
}

// ── 6AM — price list fallback reconciliation ──────────────────────────────
// Safety net for the real-time Apps Script webhook (helpers/pricelist.js +
// POST /api/pricelist/webhook): if the webhook never fires — VM down, trigger
// misconfigured on the Sheet side, token mismatch, transient network failure —
// this catches any missed price change within 24h instead of drifting
// silently forever. One Sheets read/day, negligible cost either way.
async function pricelistFallback() {
    try {
        const pricelist = require('./helpers/pricelist');
        const result = await pricelist.checkForChangesAndNotify();
        if (result.changed) console.log('[SCHED] Price list fallback caught a missed change:', result.changes);
    } catch (err) {
        console.error('[SCHED] pricelist fallback failed:', err.message);
    }
}

// ── Task runner — fires persistent tasks whose fire_at has passed ─────────
// Called every minute. For each due task:
//   1. Evaluate its condition (if any). If condition says 'skip', archive as done_condition_met.
//   2. Resolve target chatId by looking up trucker/supplier by name (name is the durable key,
//      whatsapp/group_id can drift). Falls back to task.target_chat if lookup fails.
//   3. Send the message. On success, archive as done_fired.
//      On failure, increment tries; if tries >= max_tries, archive as failed.
async function taskRunner() {
    const tasks = require('./helpers/tasks');
    const { loadTruckers, loadSuppliers } = require('./helpers/json');
    const settings = cfg.getSettings ? cfg.getSettings() : {};
    const managerChat = (settings.manager_number || cfg.MANAGER_NUMBER || '') + '@c.us';

    const due = tasks.dueTasks();
    if (!due.length) return;

    for (const task of due) {
        try {
            // 1. Condition check — has the reason for this task already resolved?
            const gate = tasks.evaluateCondition(task);
            if (gate === 'skip') {
                await tasks.archive(task.id, { status: 'done', result_note: 'condition_met_before_fire' });
                continue;
            }

            // ── Quote-request reminder / escalation (2026-08-05) ────────────
            // Both delegate entirely to workflow/quoteRequests.js, which
            // resolves its OWN destination per leg (handleQuoteReminderTask
            // picks sendEmailReminder vs send(leg.target) off leg.channel;
            // handleQuoteEscalationTask resolves managerChatId() itself), so
            // neither needs the outer chatId resolved below at all.
            //
            // REAL BUG (found 2026-08-06, live — Apsara: "if a reminder of
            // quote goes idle, saying that chat id is missing"): this block
            // used to sit BELOW the chatId resolution + `if (!chatId)` gate.
            // workflow/quoteRequests.js deliberately sets target_chat:null
            // for EMAIL legs (see scheduleFirstReminder — "leg.channel !==
            // 'email' ? leg.target : null"), expecting this delegation to
            // handle delivery. But for an email-only trucker (no group_id,
            // no whatsapp) the name lookup below couldn't fill chatId either,
            // so the task hit that gate, burned all 3 tries, and archived as
            // 'no_chatid_resolved' — the reminder chain silently dying
            // without one reminder ever being sent, exactly as reported.
            //
            // SECOND BUG, introduced by me EARLIER TODAY in the
            // preferred_mode work below and caught here: that new branch
            // fires on any targetRecord with preferred_mode==='email', which
            // includes quote_reminder tasks — it would have intercepted them
            // and sent task.message as a plain generic email, bypassing
            // handleQuoteReminderTask entirely. That skips recordReminderSent,
            // the dashboard alert, AND the scheduling of the next reminder
            // stage/escalation — so the 30/60/90 chain would fire stage 1 and
            // then stop dead. Hoisting this block above both is what makes
            // that impossible rather than merely unlikely.
            if (task.type === 'quote_reminder' || task.type === 'quote_escalation') {
                await tasks.updateTask(task.id, { status: 'firing' });
                const quoteRequests = require('./workflow/quoteRequests');
                try {
                    const result = task.type === 'quote_reminder'
                        ? await quoteRequests.handleQuoteReminderTask(task, { send: _sendMessage })
                        : await quoteRequests.handleQuoteEscalationTask(task, { send: _sendMessage });
                    await tasks.archive(task.id, { status: 'done', result_note: result.fired ? 'fired' : (result.reason || 'send_failed') });
                } catch (err) {
                    console.error(`[TASK] quote task ${task.id} failed:`, err.message);
                    await tasks.archive(task.id, { status: 'failed', result_note: 'runner_exception: ' + err.message });
                }
                continue;
            }

            // 2. Resolve target chatId. Look up by name; fall back to explicit chat if not found.
            let chatId = task.target_chat || null;
            let targetRecord = null;
            if (task.target_kind === 'trucker' && task.target_name) {
                const truckers = await loadTruckers();
                targetRecord = truckers.find(x => x.name === task.target_name);
                if (targetRecord?.group_id)      chatId = targetRecord.group_id;
                else if (targetRecord?.whatsapp) chatId = targetRecord.whatsapp + '@c.us';
            } else if (task.target_kind === 'supplier' && task.target_name) {
                const suppliers = await loadSuppliers();
                targetRecord = suppliers.find(x => x.name === task.target_name);
                if (targetRecord?.group_id)      chatId = targetRecord.group_id;
                else if (targetRecord?.whatsapp) chatId = targetRecord.whatsapp + '@c.us';
            } else if (task.target_kind === 'manager') {
                chatId = managerChat;
            }

            // REAL BUG (found 2026-08-06, live — Apsara: "fix supplier/trucker
            // mode of communication is email"), same class as the fix in
            // workflow/actions.js's notifyContactRespectingChannel: this
            // generic nudge/reminder firing loop had no email option at all —
            // an email-preferred trucker/supplier either got a WhatsApp
            // message anyway (if they happened to have a number on file too)
            // or, worse, got marked "no_chatid_resolved" and silently failed
            // after 3 tries if they didn't. Checked BEFORE the no-chatId
            // failure below so an email-only contact doesn't get wrongly
            // failed for lacking a WhatsApp chatId it was never going to use.
            if (targetRecord && targetRecord.preferred_mode === 'email' && targetRecord.email) {
                await tasks.updateTask(task.id, { status: 'firing' });
                let msg = task.message;
                if (task.bkg_no && !msg.includes(task.bkg_no)) {
                    const label = task.container_seq != null ? `${task.bkg_no}/${task.container_seq}` : task.bkg_no;
                    msg = `${label}: ${msg}`;
                }
                const subject = task.bkg_no ? `${task.bkg_no} — update` : 'Update';
                try {
                    const { sendEmail } = require('./helpers/gmail');
                    const sent = await sendEmail({ to: targetRecord.email, subject, body: msg });
                    require('./helpers/emailThreads').trackSentEmail({
                        threadId: sent?.threadId, to: targetRecord.email, targetName: targetRecord.name, subject, bkgNo: task.bkg_no || null,
                    }).catch((e) => console.error('[SCHED] emailThreads.trackSentEmail failed (non-fatal):', e.message));
                    await tasks.archive(task.id, { status: 'done', result_note: 'fired_email' });
                    console.log(`[TASK] Fired ${task.id} → ${targetRecord.email} (email): "${task.message.slice(0, 60)}"`);
                } catch (err) {
                    const nextTries = (task.tries || 0) + 1;
                    if (nextTries >= (task.max_tries || 3)) {
                        await tasks.archive(task.id, { status: 'failed', result_note: 'email_send_failed: ' + err.message });
                    } else {
                        await tasks.updateTask(task.id, {
                            status: 'pending', tries: nextTries,
                            fire_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
                        });
                    }
                }
                continue;
            }

            if (!chatId) {
                await tasks.updateTask(task.id, { tries: (task.tries || 0) + 1 });
                if ((task.tries || 0) + 1 >= (task.max_tries || 3)) {
                    await tasks.archive(task.id, { status: 'failed', result_note: 'no_chatid_resolved' });
                }
                continue;
            }

            // ── Scheduled email — "email X at 7am" (2026-08-04) ────────────
            // Fires a real Gmail send instead of a WhatsApp message. Reuses
            // this SAME due/condition/retry/archive machinery rather than a
            // parallel scheduler, per the same "single execution gateway"
            // reasoning actions.js states at its own top — one place that
            // fires things, not two. chatId here is always the manager's own
            // WhatsApp (target_kind: 'manager', set by
            // actions.js's scheduleDraftedEmail), used only to notify her the
            // email went out — never the email's own To/Cc/Bcc, which live
            // in task.email_payload and were fully resolved and confirmed by
            // her at drafting time, long before this ever fires.
            if (task.type === 'scheduled_email') {
                await tasks.updateTask(task.id, { status: 'firing' });
                try {
                    const { sendEmail } = require('./helpers/gmail');
                    const sent = await sendEmail(task.email_payload);
                    // Same reply-tracking as the immediate-send path in
                    // actions.js's sendDraftedEmail — a scheduled email is
                    // still a general sent email that can get a reply worth
                    // surfacing in the bell (2026-08-06).
                    require('./helpers/emailThreads').trackSentEmail({
                        threadId: sent?.threadId, to: task.email_payload.to, targetName: task.email_payload.target_name,
                        subject: task.email_payload.subject, bkgNo: task.bkg_no,
                    }).catch((e) => console.error('[SCHED] emailThreads.trackSentEmail failed (non-fatal):', e.message));
                    await tasks.archive(task.id, { status: 'done', result_note: 'fired' });
                    await _sendMessage(chatId, `Scheduled email sent to ${task.email_payload.target_name || ''} <${task.email_payload.to}>: ${task.email_payload.subject}`);
                    console.log(`[TASK] Scheduled email fired ${task.id} → ${task.email_payload.to}`);
                } catch (err) {
                    const nextTries = (task.tries || 0) + 1;
                    if (nextTries >= (task.max_tries || 3)) {
                        await tasks.archive(task.id, { status: 'failed', result_note: 'send_failed: ' + err.message });
                        await _sendMessage(chatId, `Scheduled email to ${task.email_payload.to} FAILED after ${nextTries} tries: ${err.message}. Not retried further — you'll need to resend manually.`);
                    } else {
                        await tasks.updateTask(task.id, {
                            status: 'pending', tries: nextTries,
                            fire_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
                        });
                    }
                }
                continue;
            }

            // 3. Send. Auto-prefix booking/container label so the recipient has context.
            //    Skips prefix if the message already mentions the booking number.
            await tasks.updateTask(task.id, { status: 'firing' });
            let msg = task.message;
            if (task.bkg_no && !msg.includes(task.bkg_no)) {
                const label = task.container_seq != null ? `${task.bkg_no}/${task.container_seq}` : task.bkg_no;
                msg = `${label}: ${msg}`;
            }
            const ok = await _sendMessage(chatId, msg);
            if (ok) {
                await tasks.archive(task.id, { status: 'done', result_note: 'fired' });
                console.log(`[TASK] Fired ${task.id} → ${chatId}: "${task.message.slice(0, 60)}"`);
            } else {
                const nextTries = (task.tries || 0) + 1;
                if (nextTries >= (task.max_tries || 3)) {
                    await tasks.archive(task.id, { status: 'failed', result_note: 'send_failed_max_tries' });
                } else {
                    // Reschedule 5 minutes out for a retry
                    await tasks.updateTask(task.id, {
                        status: 'pending', tries: nextTries,
                        fire_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
                    });
                }
            }
        } catch (err) {
            console.error(`[TASK] runner error on ${task.id}:`, err.message);
            const nextTries = (task.tries || 0) + 1;
            if (nextTries >= (task.max_tries || 3)) {
                await tasks.archive(task.id, { status: 'failed', result_note: 'runner_exception: ' + err.message });
            } else {
                await tasks.updateTask(task.id, { status: 'pending', tries: nextTries });
            }
        }
    }
}

// ── Quote-request email-leg reply poll (2026-08-05) ─────────────────────────
// No inbound-email watcher exists anywhere for trucker-style correspondence
// (emailWatcher.js's poll is scoped to bose@'s carrier-booking intake, a
// different mailbox/purpose) — reminders/escalation timers don't need this
// (they're pure timers), but detecting "did the email-channel trucker
// actually reply with a price" does. Runs every 5 minutes — frequent enough
// that a price via email doesn't sit unnoticed for long, infrequent enough
// not to hammer the Gmail API for what's normally a handful of open legs.
async function quoteEmailReplyWatch() {
    try {
        const quoteRequests = require('./workflow/quoteRequests');
        const result = await quoteRequests.pollEmailReplies();
        if (result.replied) console.log(`[SCHED] quote email poll: ${result.replied}/${result.checked} legs had a new reply`);
    } catch (err) {
        console.error('[SCHED] quote-email-poll:', err.message);
    }
}

// ── General sent-email reply poll (2026-08-06) ──────────────────────────────
// Same cadence/reasoning as quoteEmailReplyWatch just above, for the general
// draftEmailForConfirm/sendDraftedEmail flow instead of quote-request legs —
// see workflow/emailReplyWatch.js's own header. Kept as its own function/cron
// entry (not folded into quoteEmailReplyWatch) so a failure or slowdown in
// one poll can't affect the other.
async function generalEmailReplyWatch() {
    try {
        const { pollGeneralEmailReplies } = require('./workflow/emailReplyWatch');
        const result = await pollGeneralEmailReplies();
        if (result.replied) console.log(`[SCHED] general email poll: ${result.replied}/${result.checked} thread(s) had a new reply`);
    } catch (err) {
        console.error('[SCHED] general-email-poll:', err.message);
    }
}

function start() {
    cron.schedule('0 8 * * *',    () => morningDigest().catch(e => console.error('[SCHED] digest:', e)), TZ);
    cron.schedule('15 8 * * *',   () => dailyTruckerCheck().catch(e => console.error('[SCHED] trucker-check:', e)), TZ);
    cron.schedule('0 9-17 * * *', () => urgentWatch().catch(e => console.error('[SCHED] urgent:', e)),   TZ);
    cron.schedule('0 9-17 * * *', () => stallWatch().catch(e => console.error('[SCHED] stall:', e)),     TZ);
    cron.schedule('0 6 * * *',    () => pricelistFallback().catch(e => console.error('[SCHED] pricelist:', e)), TZ);
    cron.schedule('0 23 * * *',   () => autoArchive().catch(e => console.error('[SCHED] archive:', e)),  TZ);
    cron.schedule('45 22 * * *',  () => nightlyCutoffBackfill().catch(e => console.error('[SCHED] cutoff-backfill:', e)), TZ);
    cron.schedule('* * * * *',    () => taskRunner().catch(e => console.error('[SCHED] tasks:',  e)),    TZ);
    cron.schedule('*/5 * * * *',  () => quoteEmailReplyWatch().catch(e => console.error('[SCHED] quote-email-poll:', e)), TZ);
    cron.schedule('*/5 * * * *',  () => generalEmailReplyWatch().catch(e => console.error('[SCHED] general-email-poll:', e)), TZ);
    cron.schedule('*/15 * * * *', () => emailWatcher.run().catch(e => console.error('[SCHED] email:', e)), TZ);
    cron.schedule('45 23 * * *', () => {
        const settings = cfg.getSettings ? cfg.getSettings() : {};
        const managerChatId = (settings.manager_number || cfg.MANAGER_NUMBER || '') + '@c.us';
        require('./helpers/dailyLearning').run({ sendToManager: _sendToManager, setPending: actions.setPending, managerChatId }).catch(e => console.error('[SCHED] learning:', e));
    }, TZ);
    console.log('[SCHED] Jobs registered (8AM digest, 8:15AM trucker-check, hourly urgent+stall 9-17, 6AM pricelist, 11PM archive, 15-min email watcher, minute task-runner — LA time)');
}

module.exports = { init, start, morningDigest, urgentWatch, autoArchive, taskRunner, pricelistFallback };