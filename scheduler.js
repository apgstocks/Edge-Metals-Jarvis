// ── scheduler.js — node-cron jobs (replaces Cloud Scheduler + Pub/Sub) ───────
// All schedules run in America/Los_Angeles because every freight deadline
// (ERD/cutoff) is a US port date. Dedup via brain.proactive_sent so a restart
// mid-day never double-sends.

const cron = require('node-cron');
const { usd } = require('./helpers/money');
const { loadBookings, loadWorkflow, mutateBrain, loadBrain,
        mutateJson, loadHistory } = require('./helpers/json');
const { daysUntil, getLADate }    = require('./helpers/time');
const { getUrgentBookings }       = require('./helpers/booking');
const { stepLabel }               = require('./helpers/booking');
const { pushAlert }               = require('./alerts');
const cfg = require('./config');
const emailWatcher = require('./workflow/emailWatcher');
const paymentWatcher = require('./workflow/paymentWatcher');
const { pickVariant } = require('./helpers/phrasing');
const actions = require('./workflow/actions');

let _sendToManager = async () => {}, _sendToTeam = async () => {}, _sendMessage = async () => {};
function init({ sendToManager, sendToTeam, sendMessage }) {
    _sendToManager = sendToManager;
    _sendToTeam    = sendToTeam;
    if (sendMessage) _sendMessage = sendMessage;
    emailWatcher.init({ sendToManager });
    // setPending is passed so a single clean payment match can stage a real
    // yes/no confirm rather than only being described in a message.
    paymentWatcher.init({ sendToManager, setPending: (action) => {
        const settings = cfg.getSettings ? cfg.getSettings() : {};
        const managerChatId = (settings.manager_number || cfg.MANAGER_NUMBER || '') + '@c.us';
        return actions.setPending(managerChatId, action);
    } });
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
        await _sendToTeam(`(Trucker check queued — you have a pending "${staged.blockedBy}" to answer first. I'll ask once that's resolved.)`);
        return;
    }
    // TIME-OF-DAY WORDING (2026-08-22): these schedules are anchored to
    // America/Los_Angeles because every freight deadline is a US port date —
    // that is correct and stays. But Apsara reads them in IST, where 8:15 AM
    // LA lands at 8:45 PM. A message opening with "Morning" at a quarter to
    // nine in the evening reads as a bug even though the timing is right. The
    // schedule is not the problem, the greeting is — so the greeting goes and
    // the message says what it is about instead of what time it thinks it is.
    await _sendToTeam('Trucker check for today — any bookings need to go out to a trucker? (yes/no)');
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
        // See the time-of-day note in dailyTruckerCheck above.
        `Daily digest — ${active.length} active booking(s)`,
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

        // notify:false when d<=1 — the explicit _sendToTeam escalation just
        // below is the message that actually goes out for that case; without
        // this, pushAlert's own severity:'high' handling ALSO pings the
        // manager with a near-duplicate "ALERT: ... cutoff in 1d" message in
        // the same breath, which is the double-cutoff-message bug reported
        // 2026-08-18. Still logged to alert history/dashboard regardless.
        await pushAlert({
            type    : 'cutoff_risk',
            bkgNo   : b.booking_number,
            message,
            severity: d <= 1 ? 'high' : 'warning',
            notify  : d > 1,
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
            // notify:false — same duplicate-message issue as urgentWatch's
            // cutoff alert above: pushAlert(severity:'high') would otherwise
            // ALSO ping the manager with this exact same `msg` text via its
            // own notify, right alongside the explicit _sendToTeam(msg) call
            // below. Logged to alert history either way.
            await pushAlert({ type: 'stall_escalated', bkgNo: b.booking_number, message: msg, severity: 'high', notify: false });
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

            // ── Contact-quote-request reminder / escalation (2026-08-16) ────
            // Same delegation pattern as the trucker quote_reminder/
            // quote_escalation block just above (own module resolves its own
            // destination per leg — email vs whatsapp — and needs nothing
            // from the chatId-resolution code below), but routed to
            // workflow/contactQuoteRequests.js instead, and gated on its own
            // task types so this can't collide with or change behavior of
            // the trucker block above it.
            if (task.type === 'contact_quote_reminder' || task.type === 'contact_quote_escalation') {
                await tasks.updateTask(task.id, { status: 'firing' });
                const contactQuoteRequests = require('./workflow/contactQuoteRequests');
                try {
                    const result = task.type === 'contact_quote_reminder'
                        ? await contactQuoteRequests.handleReminderTask(task, { send: _sendMessage })
                        : await contactQuoteRequests.handleEscalationTask(task, { send: _sendMessage });
                    await tasks.archive(task.id, { status: 'done', result_note: result.fired ? 'fired' : (result.reason || 'send_failed') });
                } catch (err) {
                    console.error(`[TASK] contact-quote task ${task.id} failed:`, err.message);
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

                    // STALENESS GUARD — Apsara, 2026-08-22: "if there is
                    // to-and-fro messages in email, if one of the to and fro
                    // already addressed what i have scheduled — how does this
                    // work?" It used to fire regardless. Now, if this is a
                    // reply into a thread and that thread moved after she
                    // approved the draft, it is HELD and she is asked rather
                    // than sent blind. See helpers/scheduledEmailGuard.js.
                    //
                    // Fails open by design: a fresh compose, an unreachable
                    // Gmail, or a Gemini outage all return proceed:true, so a
                    // broken guard can never silently stop her mail.
                    const guard = require('./helpers/scheduledEmailGuard');
                    const check = await guard.checkBeforeSend(task.email_payload, task.approved_at || task.created_at);
                    if (!check.proceed) {
                        // Stage the same await_email_confirm pending the
                        // normal draft flow uses, so answering "yes" here
                        // goes through exactly one send path — no parallel
                        // machinery, and the scheduled email keeps its
                        // already-resolved to/cc/bcc/subject/body untouched.
                        const held = { ...task.email_payload, bkg_no: task.bkg_no || null, scheduled_for: null };
                        const staged = await actions.setPending(chatId, { type: 'await_email_confirm', ...held });
                        await tasks.archive(task.id, { status: 'done', result_note: 'held_thread_moved' });
                        const note = guard.buildHoldMessage(task.email_payload, check);
                        // Critical: this asks whether an email she already
                        // approved should still go out. If it is dropped she
                        // never learns the send was held, and the email
                        // simply never happens.
                        const heldMsg = staged.queued
                            ? `${note}\n\n(You have a pending "${staged.blockedBy}" to answer first — I'll ask about this right after.)`
                            : note;
                        // Delivered ONLY through the outbox — a second direct
                        // _sendMessage here would double-send whenever
                        // WhatsApp is up, which is exactly what the first
                        // version of this patch did.
                        try {
                            const outbox = require('./helpers/managerOutbox');
                            outbox.init({ sendToManager: (t) => _sendMessage(chatId, t) });
                            await outbox.deliver(heldMsg, { critical: true, subject: 'Scheduled email held' });
                        } catch (e) {
                            console.error('[TASK] outbox deliver failed, sending directly:', e.message);
                            await _sendMessage(chatId, heldMsg);
                        }
                        console.log(`[TASK] Scheduled email ${task.id} HELD — thread moved (${check.newMessages.length} new, superseded=${check.superseded})`);
                        continue;
                    }

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

// ── Contact-quote-request email-leg reply poll (2026-08-16) ────────────────
// Same reasoning/cadence as quoteEmailReplyWatch just above, for the new
// contact-quote-request feature's email legs instead of trucker legs — see
// workflow/contactQuoteRequests.js's pollEmailReplies for the actual polling
// logic (reuses the same gmail-token-sender-read.json client as the trucker
// poll, so if that token isn't set up, BOTH polls no-op with a warning until
// it is — not a new dependency).
async function contactQuoteEmailReplyWatch() {
    try {
        const contactQuoteRequests = require('./workflow/contactQuoteRequests');
        const result = await contactQuoteRequests.pollEmailReplies();
        if (result.replied) console.log(`[SCHED] contact-quote email poll: ${result.replied}/${result.checked} legs had a new reply`);
    } catch (err) {
        console.error('[SCHED] contact-quote-email-poll:', err.message);
    }
}

// ── General sent-email reply poll (2026-08-06) ──────────────────────────────
// Same cadence/reasoning as quoteEmailReplyWatch just above, for the general
// draftEmailForConfirm/sendDraftedEmail flow instead of quote-request legs —
// see workflow/emailReplyWatch.js's own header. Kept as its own function/cron
// entry (not folded into quoteEmailReplyWatch) so a failure or slowdown in
// one poll can't affect the other.
// Scans the inbox for mail that is waiting on HER — see
// workflow/replyWatch.js. Distinct from the three *EmailReplyWatch functions
// above: those follow up on threads Jarvis itself started, this one watches
// inbound mail nobody asked for. Read-only; it only ever flags.
async function replyWatch() {
    try {
        const { run } = require('./workflow/replyWatch');
        // sendMessage is passed so deadline reminders can go to the internal
        // team group rather than only to the manager — see replyWatch's
        // deadline block.
        const result = await run({ sendToManager: _sendToManager, sendMessage: _sendMessage });
        if (result.flagged) console.log(`[SCHED] reply-watch: ${result.flagged}/${result.checked} email(s) need a reply`);
    } catch (err) {
        console.error('[SCHED] reply-watch:', err.message);
    }
}

async function generalEmailReplyWatch() {
    try {
        const { pollGeneralEmailReplies } = require('./workflow/emailReplyWatch');
        const result = await pollGeneralEmailReplies();
        if (result.replied) console.log(`[SCHED] general email poll: ${result.replied}/${result.checked} thread(s) had a new reply`);
    } catch (err) {
        console.error('[SCHED] general-email-poll:', err.message);
    }
}

// 'YYYY-MM-DD' in America/New_York — used ONLY by eodYardReport below, kept
// separate from todayKey()/getLADate() above since every other job in this
// file deliberately runs on LA time and this one deliberately doesn't (see
// eodYardReport's comment). Intl.formatToParts (not toLocaleDateString's
// plain string output) so the field order is unambiguous regardless of
// runtime locale.
function getEasternDateKey() {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const get = (t) => parts.find(p => p.type === t).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
}

// Builds the full text summary — used as BOTH the email body and the
// WhatsApp message, same text, two channels — for a given day's yard
// report. Pulled out as its own pure function, separate from eodYardReport's
// Drive/email/WhatsApp side effects below, specifically so the TEXT can be
// tested on its own against plain in-memory load arrays without a live
// Drive/Gmail/WhatsApp connection.
//
// The two "Inventory by item type" sections were added 2026-08-15 per
// Apsara ("I want inventory report to be sent... item type summary of all
// the loads so far... per day, how many loads"). Her direct answer on scope
// was "Two categories. per day load data and then in another, overall load
// inventory" — so this is deliberately TWO separate sections (today's
// breakdown, then an all-time cumulative one across every load ever
// recorded), both folded into this one existing report rather than a
// second send, per her preference on structure. Reuses helpers/pdf.js's
// groupItemsByDescription — the exact same grouping the PDF's own "Summary
// by Item Type" table already uses — so "how items roll up by type" has one
// definition, not two that could drift apart.
function buildYardReportText(dateKey, todays, allLoads) {
    const unit = todays.find(l => l.weight_unit)?.weight_unit || 'lb';
    const totals = todays.reduce((acc, l) => ({
        gross : acc.gross  + (l.gross_weight || 0),
        tare  : acc.tare   + (l.tare_weight  || 0),
        net   : acc.net    + (l.net_weight   || 0),
        amount: acc.amount + (l.amount       || 0),
    }), { gross: 0, tare: 0, net: 0, amount: 0 });

    // Uses l.seller — the outside counterparty's name. (Briefly used
    // l.buyer earlier today after finding this WAS reading the wrong field —
    // that diagnosis was correct at the time, but Apsara then corrected the
    // field mapping itself: seller/seller_address are now the free-text
    // counterparty fields and buyer is the fixed company constant — see
    // helpers/loads.js's validateLoadForSave comment. l.seller is right
    // again under the new mapping.)
    const lines = todays.map(l =>
        `• ${l.id} — ${l.seller || 'Unnamed seller'} — Net ${l.net_weight ?? '—'} ${unit}${l.amount != null ? ` — ${usd(l.amount)}` : ''}`
    );

    // Reformatted 2026-08-16 per Apsara ("this looks ugly and unorganised" /
    // "show this in pdf"): the two "Inventory by item type" sections that
    // used to live here (today's breakdown + an ever-growing all-time list)
    // are gone. UPDATED 2026-08-19: that content moved again — the daily
    // inventory PDF this used to point at is no longer produced at all, and
    // the item-type breakdown now lives in the live "Inventory-Overall"
    // Google Sheet, whose link the email carries. This text is WhatsApp's job: a quick
    // same-night read, not the full record — see the "WhatsApp gets the
    // text summary only" comment further down for the email-vs-WhatsApp
    // split this follows. `*text*` renders bold on WhatsApp; email clients
    // just show the literal asterisks, which is an acceptable tradeoff for
    // one shared body string across both channels (per Apsara's original
    // "same text, two channels" design — see this function's header
    // comment) rather than maintaining two separately-formatted bodies.
    // A ZERO-LOAD DAY IS TWO LINES. Apsara, 2026-08-24: "if zero loads, dont
    // sent any url. Just send as *Loads today (0)* / No loads recorded today."
    // Nothing happened; a wall of spreadsheet links underneath that is noise,
    // and noise on a report that arrives every single night is how the report
    // stops being read at all.
    if (!todays.length) {
        return [
            `*${cfg.COMPANY_NAME} — Yard Report — ${dateKey}*`,
            '',
            `*Loads today (0)*`,
            'No loads recorded today.',
        ].join('\n');
    }

    // The line that used to sit here — "Full inventory breakdown (by item
    // type, today + all-time) is in the attached PDF" — was removed
    // 2026-08-24 because it had been untrue since 2026-08-19, when this
    // report stopped attaching anything and switched to links only (see the
    // "LINKS ONLY, no attachments" comment in eodYardReport). Every report
    // since has told her to look at an attachment that wasn't there. It
    // reads as a bug in the send, and would have been chased as one.
    return [
        `*${cfg.COMPANY_NAME} — Yard Report — ${dateKey}*`,
        '',
        `*Loads today (${todays.length})*`,
        ...lines,
        '', '*Totals*',
        `Gross ${totals.gross} ${unit} · Tare ${totals.tare} ${unit} · Net ${totals.net} ${unit} · ${usd(totals.amount)}`,
    ].join('\n');
}

// ── 8PM Eastern — end-of-day yard report ────────────────────────────────────
// Apsara asked for a daily wrap-up of that day's scrap-yard "Loads" activity
// (dashboard/index.html's Loads tab, backed by helpers/loads.js): the priced
// ticket + weights PDF for every load dated today, emailed to whoever's
// configured under dashboard Settings > Yard, plus a text summary posted to
// the yard WhatsApp group/contacts configured there too. Registered with its
// OWN timezone option in start() below (America/New_York), not the shared
// LA `TZ` constant every other job in this file uses.
async function eodYardReport() {
    const dateKey = getEasternDateKey();
    const key = `eod_yard_report_${dateKey}`;
    if (alreadySent(key)) return;

    const { loadSettings } = require('./helpers/json');
    const settings = loadSettings();

    // Master on/off switch — Settings > Yard, dashboard-editable. Added
    // 2026-08-15 per Apsara ("there should be an option to enable the daily
    // report sending in dashboard admin access"). Checked BEFORE the
    // recipients check below and does NOT markSent — same reasoning as the
    // "no recipients configured" case: flipping this on later should send
    // on the very next 8PM run, not stay skipped because today already
    // "ran" while it was off.
    if (!settings.yard_report_enabled) {
        console.log(`[SCHED] eod-yard-report: disabled in Settings > Yard for ${dateKey} — skipping`);
        return;
    }

    const emails = (settings.yard_report_emails || '').split(',').map(s => s.trim()).filter(Boolean);
    const waTargets = [];
    if (settings.yard_whatsapp_group_id) waTargets.push(settings.yard_whatsapp_group_id.trim());
    (settings.yard_whatsapp_contacts || '').split(',').map(s => s.trim()).filter(Boolean)
        .forEach(num => waTargets.push(num.replace(/\D/g, '') + '@c.us'));

    if (!emails.length && !waTargets.length) {
        // Nothing configured yet under Settings > Yard — log once per day
        // rather than mark-and-skip silently forever, and deliberately do
        // NOT markSent here: once Apsara fills in the settings, the very
        // next 8PM run should actually send instead of staying skipped for
        // a day it technically already "ran."
        console.log(`[SCHED] eod-yard-report: no recipients configured (Settings > Yard) for ${dateKey} — skipping`);
        return;
    }

    const { loadLoads } = require('./helpers/loads');
    const allLoads = loadLoads();
    const todays = allLoads.filter(l => l.date === dateKey);

    // Mark BEFORE sending — see dailyTruckerCheck's comment above for why
    // (a crash mid-send costs one skipped day, not a duplicate report).
    await markSent(key);

    const summaryText = buildYardReportText(dateKey, todays, allLoads);

    // Excel backup + daily inventory PDF — per Apsara 2026-08-15 ("as a
    // backup, an excel should be created to track this inventory... everyday
    // a pdf should be created for inventory for that day and it should
    // stored in drive as report folder"). Piggybacks on this SAME nightly
    // job/toggle rather than a separate cron entry — it's the same "daily
    // inventory reporting" feature bundle Apsara is turning on/off with one
    // switch (Settings > Yard > yard_report_enabled), just two more output
    // formats of the exact same data. Best-effort: a Drive hiccup here must
    // never block the email/WhatsApp send below, which is the part someone's
    // actually waiting to read tonight.
    // Hoisted so the email block below can attach it — see that block's
    // comment. Stays null if generation/upload fails; email send still
    // proceeds without it (best-effort, same as the try/catch already did).
    // Rebuild the live Google Sheet + this month's per-day workbook, and keep
    // their links for the email below. Changed 2026-08-19 per Apsara: the
    // daily report no longer sends a PDF — "instead of pdf sending, i want
    // you to create a google sheet for overall inventory maintenance and
    // update on daily basis". The sheet is already kept current by the live
    // sync on every load change (helpers/sheetSync.js); this nightly call is
    // the belt-and-braces rebuild, and the thing that produces the links the
    // email needs. syncNow never throws — it returns null on failure, and the
    // email then simply goes out without links rather than not going at all.
    let sheetLinks = null;
    try {
        const { syncNow, monthKeyFor } = require('./helpers/sheetSync');
        sheetLinks = await syncNow([monthKeyFor(dateKey)]);
        if (sheetLinks) console.log(`[SCHED] eod-yard-report: Google Sheet + monthly workbook updated for ${dateKey}`);
    } catch (e) {
        console.error('[SCHED] eod-yard-report: sheet sync failed (email/WhatsApp send still proceeds):', e.message);
    }

    // The legacy Inventory-Backup.xlsx is still written — it's a different
    // artefact from the new per-month workbook (rolling "last 5 days +
    // Overall" item-type rollup vs a chronological per-day record), nothing
    // asked for its removal, and anyone with its link keeps working.
    // The daily inventory PDF is NO LONGER generated or uploaded: it existed
    // only to be attached to this email, and the email no longer carries
    // attachments.
    try {
        const { inventoryWorkbookBuffer } = require('./helpers/inventoryExcel');
        const { uploadInventoryBackupXlsx } = require('./helpers/drive');
        await uploadInventoryBackupXlsx(await inventoryWorkbookBuffer(allLoads));
        console.log(`[SCHED] eod-yard-report: inventory backup (xlsx) uploaded for ${dateKey}`);
    } catch (e) {
        console.error('[SCHED] eod-yard-report: inventory Excel backup failed (email/WhatsApp send still proceeds):', e.message);
    }

    // Make sure every one of today's loads actually HAS its PDFs before
    // trying to attach/link them — a load only gets PDFs once someone hits
    // "Generate PDF" on the card, so this generates on the fly for any load
    // still sitting at status:'open' rather than silently omitting it.
    const { generateAndStoreLoadPdfs } = require('./helpers/loadsPdf');
    const withPdfs = [];
    for (const l of todays) {
        if (l.pdf_link && l.weights_pdf_link) { withPdfs.push(l); continue; }
        try {
            const updated = await generateAndStoreLoadPdfs(l);
            withPdfs.push(updated || l);
        } catch (e) {
            console.error(`[SCHED] eod-yard-report: PDF generation failed for ${l.id}, reporting it without a PDF:`, e.message);
            withPdfs.push(l);
        }
    }

    // Email gets the actual PDF files as attachments — downloaded back from
    // Drive by ID via the same helper the rest of the app already uses to
    // re-read stored PDF bytes.
    // LINKS ONLY, no attachments — per Apsara 2026-08-19. Previously this
    // downloaded every load's ticket + weights PDF back out of Drive and
    // attached them all, plus the inventory PDF; a busy day could produce a
    // 20+ MB email. Now the email carries the summary text and links to the
    // live Google Sheet, the month's per-day workbook, and each load's PDFs
    // (which still exist in Drive exactly as before — only the attaching
    // stopped, nothing was deleted).
    if (emails.length) {
        try {
            const linkLines = [];
            if (sheetLinks && sheetLinks.sheet && sheetLinks.sheet.webViewLink) {
                linkLines.push(`Overall inventory (live Google Sheet): ${sheetLinks.sheet.webViewLink}`);
            }
            if (sheetLinks && sheetLinks.months) {
                for (const m of sheetLinks.months) {
                    if (m.file && m.file.webViewLink) linkLines.push(`Daily loads — ${m.monthKey}: ${m.file.webViewLink}`);
                }
            }
            // Expense links only appear once expenses actually exist — see
            // runSync in helpers/sheetSync.js, which skips building them
            // entirely for a yard that doesn't use the tracker.
            if (sheetLinks && sheetLinks.expenseSheet && sheetLinks.expenseSheet.webViewLink) {
                linkLines.push(`Expenses (live Google Sheet): ${sheetLinks.expenseSheet.webViewLink}`);
            }
            if (sheetLinks && sheetLinks.expenseMonths) {
                for (const m of sheetLinks.expenseMonths) {
                    if (m.file && m.file.webViewLink) linkLines.push(`Daily expenses — ${m.monthKey}: ${m.file.webViewLink}`);
                }
            }
            const pdfLines = [];
            for (const l of withPdfs) {
                if (l.pdf_link) pdfLines.push(`  ${l.id}: ${l.pdf_link}`);
                if (l.weights_pdf_link) pdfLines.push(`  ${l.id} (weights): ${l.weights_pdf_link}`);
            }
            // Links suppressed on a zero-load day for the same reason the
            // summary is two lines — see buildYardReportText. The sheets haven't
            // changed if nothing was weighed.
            const quiet = !todays.length;
            const body = [
                summaryText,
                ...(!quiet && linkLines.length ? ['', ...linkLines] : []),
                ...(!quiet && pdfLines.length ? ['', "Today's load tickets:", ...pdfLines] : []),
            ].join('\n');
            const { sendEmail } = require('./helpers/gmail');
            await sendEmail({ to: emails.join(', '), subject: `${cfg.COMPANY_NAME} — Yard Report — ${dateKey}`, body });
        } catch (e) {
            console.error('[SCHED] eod-yard-report: email send failed:', e.message);
        }
    }

    // WhatsApp gets the text summary only — not the PDFs too (that'd be up
    // to N x 2 file messages landing in the group every night). Email is the
    // channel for the actual documents; WhatsApp is for a quick same-night read.
    for (const chatId of waTargets) {
        try { await _sendMessage(chatId, summaryText); }
        catch (e) { console.error(`[SCHED] eod-yard-report: WhatsApp send to ${chatId} failed:`, e.message); }
    }

    console.log(`[SCHED] eod-yard-report: sent for ${dateKey} — ${todays.length} loads, ${emails.length} email recipient(s), ${waTargets.length} WhatsApp target(s)`);
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
    cron.schedule('*/5 * * * *',  () => contactQuoteEmailReplyWatch().catch(e => console.error('[SCHED] contact-quote-email-poll:', e)), TZ);
    cron.schedule('*/5 * * * *',  () => generalEmailReplyWatch().catch(e => console.error('[SCHED] general-email-poll:', e)), TZ);
    cron.schedule('*/15 * * * *', () => emailWatcher.run().catch(e => console.error('[SCHED] email:', e)), TZ);
    // Payment detection (2026-08-22). Every 30 min rather than 15: payment
    // notices are far rarer than booking mail, and each candidate costs a
    // Gemini classification call. Its own in-process lock stops a slow run
    // overlapping the next tick.
    cron.schedule('*/30 * * * *', () => paymentWatcher.run().catch(e => console.error('[SCHED] payment-watch:', e)), TZ);
    // Needs-a-reply inbox scan — every 5 minutes, around the clock. Apsara,
    // 2026-08-22: "i want email to be monitored all the time."
    //
    // Affordable at this frequency because every email is assessed by Gemini
    // exactly ONCE (deduped by message id), so cost tracks how much mail
    // arrives, not how often we look. The previous hourly schedule was not
    // saving anything; it was just adding up to an hour of delay.
    //
    // Notification rationing lives inside workflow/replyWatch.js, NOT here:
    // urgent mail is sent as soon as it is found, everything else is batched
    // to at most one digest an hour, and anything found overnight is held
    // rather than dropped. Detection is continuous; only delivery is paced.
    cron.schedule('*/5 * * * *', () => replyWatch().catch(e => console.error('[SCHED] reply-watch:', e)), TZ);
    // Retry manager notifications queued while WhatsApp was unavailable.
    // index.js flushes on reconnect; this covers the case where WhatsApp
    // never fires a 'ready' event at all — banned, or stuck in a bad session —
    // and is also what escalates a long outage to email.
    cron.schedule('*/5 * * * *', () => {
        // init() here too, not just in index.js's 'ready' handler. AUDIT
        // FINDING (2026-08-22): this cron relied on init having already
        // happened elsewhere in the process. If WhatsApp never becomes ready
        // — banned, or stuck on a bad session — that handler never fires, and
        // the outbox would hold the default no-op sender. Cheap to set every
        // tick and removes the ordering dependency entirely.
        const outbox = require('./helpers/managerOutbox');
        outbox.init({ sendToManager: _sendToManager });
        outbox.flush().catch(e => console.error('[SCHED] outbox-flush:', e.message));
    }, TZ);
    cron.schedule('45 23 * * *', () => {
        const settings = cfg.getSettings ? cfg.getSettings() : {};
        const managerChatId = (settings.manager_number || cfg.MANAGER_NUMBER || '') + '@c.us';
        require('./helpers/dailyLearning').run({ sendToManager: _sendToManager, setPending: actions.setPending, managerChatId }).catch(e => console.error('[SCHED] learning:', e));
    }, TZ);
    // Nightly full replication of facts.json to Supabase.
    //
    // The per-write replicate() calls in helpers/json.js are fire-and-forget
    // and CAN fail — during a Supabase blip, a network drop, or a restart
    // mid-write. This pass is what makes that acceptable: it re-pushes every
    // fact, so any single dropped replication is repaired within a day.
    // Cheap (an upsert of a few hundred rows, keyed on the fact's own id, so
    // re-pushing an unchanged fact is a no-op).
    //
    // 03:30 — after the 23:45 learning review, so any facts she approved that
    // evening are included in the same night's backup.
    cron.schedule('30 3 * * *', () => {
        require('./helpers/factReplica').syncAll()
            .catch(e => console.error('[SCHED] fact-replica sync:', e.message));
    }, TZ);

    // Own timezone — America/New_York, not the shared LA `TZ` — see
    // eodYardReport's comment for why.
    cron.schedule('0 20 * * *', () => eodYardReport().catch(e => console.error('[SCHED] eod-yard-report:', e)), { timezone: 'America/New_York' });
    console.log('[SCHED] Jobs registered (8AM digest, 8:15AM trucker-check, hourly urgent+stall 9-17, 6AM pricelist, 11PM archive, 3:30AM fact backup, 15-min email watcher, minute task-runner, 8PM ET yard report — LA time unless noted)');
}

module.exports = { init, start, morningDigest, urgentWatch, autoArchive, taskRunner, pricelistFallback, eodYardReport, buildYardReportText };