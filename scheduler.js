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
    await actions.setPending(teamChat, { type: 'wizard_start' });
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
        if (d !== -1) continue;                                  // exactly one day past — older ones handled in earlier runs
        if (wf.keep_active) continue;

        // Multi-container: skip if any container still active. Legacy flat: use wf.step.
        if (Array.isArray(b.containers) && b.containers.length > 0) {
            if (!allContainersTerminal(b)) continue;
        } else {
            if (cfg.TERMINAL_STEPS.includes(wf.step)) continue;
        }

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

            // 2. Resolve target chatId. Look up by name; fall back to explicit chat if not found.
            let chatId = task.target_chat || null;
            if (task.target_kind === 'trucker' && task.target_name) {
                const truckers = await loadTruckers();
                const t = truckers.find(x => x.name === task.target_name);
                if (t?.group_id)      chatId = t.group_id;
                else if (t?.whatsapp) chatId = t.whatsapp + '@c.us';
            } else if (task.target_kind === 'supplier' && task.target_name) {
                const suppliers = await loadSuppliers();
                const s = suppliers.find(x => x.name === task.target_name);
                if (s?.group_id)      chatId = s.group_id;
                else if (s?.whatsapp) chatId = s.whatsapp + '@c.us';
            } else if (task.target_kind === 'manager') {
                chatId = managerChat;
            }
            if (!chatId) {
                await tasks.updateTask(task.id, { tries: (task.tries || 0) + 1 });
                if ((task.tries || 0) + 1 >= (task.max_tries || 3)) {
                    await tasks.archive(task.id, { status: 'failed', result_note: 'no_chatid_resolved' });
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

function start() {
    cron.schedule('0 8 * * *',    () => morningDigest().catch(e => console.error('[SCHED] digest:', e)), TZ);
    cron.schedule('15 8 * * *',   () => dailyTruckerCheck().catch(e => console.error('[SCHED] trucker-check:', e)), TZ);
    cron.schedule('0 9-17 * * *', () => urgentWatch().catch(e => console.error('[SCHED] urgent:', e)),   TZ);
    cron.schedule('0 9-17 * * *', () => stallWatch().catch(e => console.error('[SCHED] stall:', e)),     TZ);
    cron.schedule('0 6 * * *',    () => pricelistFallback().catch(e => console.error('[SCHED] pricelist:', e)), TZ);
    cron.schedule('0 23 * * *',   () => autoArchive().catch(e => console.error('[SCHED] archive:', e)),  TZ);
    cron.schedule('* * * * *',    () => taskRunner().catch(e => console.error('[SCHED] tasks:',  e)),    TZ);
    cron.schedule('*/15 * * * *', () => emailWatcher.run().catch(e => console.error('[SCHED] email:', e)), TZ);
    console.log('[SCHED] Jobs registered (8AM digest, 8:15AM trucker-check, hourly urgent+stall 9-17, 6AM pricelist, 11PM archive, 15-min email watcher, minute task-runner — LA time)');
}

module.exports = { init, start, morningDigest, urgentWatch, autoArchive, taskRunner, pricelistFallback };