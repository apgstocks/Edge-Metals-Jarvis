// ── helpers/tasks.js — persistent task queue for delayed follow-ups ─────────
// Tasks survive process restarts (stored in tasks.json). The scheduler runs
// dueTasks() every minute; each task either fires (sends WhatsApp message)
// or auto-cancels if its condition already resolved (e.g. state flag flipped).
// Completed / cancelled tasks move to tasks_history.json — this keeps the
// live queue small and gives you an audit trail.

const cfg = require('../config');
const { mutateJson, loadJson } = require('./json');

// Task shape:
// {
//   id           : string  (uuid-ish, generated on enqueue)
//   type         : 'nudge_scale_ticket' | 'nudge_load_ready' | 'nudge_empty_drop' | 'nudge_ingate' | 'generic_message'
//   target_kind  : 'trucker' | 'supplier' | 'manager'
//   target_name  : string   (name used to look up chatId at fire time — resilient to number changes)
//   target_chat  : string   (fallback direct chatId if target_name lookup fails)
//   bkg_no       : string?  (attached booking, used for state-check + display)
//   container_seq: number?  (Phase 3b hook; unused today)
//   message      : string   (what to send when the task fires)
//   fire_at      : ISO string
//   condition    : { type: 'workflow_flag_true' | 'workflow_step_at_or_past' | null,
//                    flag?: string, step?: string, bkg_no?: string }
//   status       : 'pending' | 'firing' | 'done' | 'cancelled' | 'failed'
//   tries        : number   (send retry count on failure)
//   max_tries    : number
//   created_by   : string   ('web' | 'brain' | manager name)
//   created_at   : ISO string
//   completed_at : ISO string?  (set on done/cancelled/failed)
//   result_note  : string?   (why it completed / cancelled — 'fired' | 'condition_met' | 'user_cancelled' | error msg)
// }

const NEW_TASK_DEFAULTS = {
    container_seq: null,
    condition    : null,
    status       : 'pending',
    tries        : 0,
    max_tries    : 3,
    created_by   : 'web',
};

function newId() {
    return 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// ── Read/write ────────────────────────────────────────────────────────────
const loadTasks   = () => loadJson(cfg.TASKS_FILE, []);
const loadHistory = () => loadJson(cfg.TASKS_HISTORY_FILE, []);

async function enqueue(taskInput) {
    const now = new Date().toISOString();
    const task = {
        ...NEW_TASK_DEFAULTS,
        ...taskInput,
        id           : taskInput.id || newId(),
        created_at   : now,
    };
    if (!task.message)      throw new Error('message required');
    if (!task.target_kind)  throw new Error('target_kind required');
    if (!task.target_name && !task.target_chat) throw new Error('target_name or target_chat required');
    if (!task.fire_at)      throw new Error('fire_at required');
    // Normalise fire_at to ISO (accept unix ms or ISO)
    if (typeof task.fire_at === 'number') task.fire_at = new Date(task.fire_at).toISOString();
    await mutateJson(cfg.TASKS_FILE, [], list => { list.push(task); return list; });
    return task;
}

// Tasks whose fire_at is in the past AND status is still 'pending'
function dueTasks(now = new Date()) {
    return loadTasks().filter(t => t.status === 'pending' && new Date(t.fire_at) <= now);
}

// Move a task to history and remove from active queue.
async function archive(taskId, patch) {
    let removed = null;
    await mutateJson(cfg.TASKS_FILE, [], list => {
        const i = list.findIndex(t => t.id === taskId);
        if (i >= 0) { removed = { ...list[i], ...patch, completed_at: new Date().toISOString() }; list.splice(i, 1); }
        return list;
    });
    if (removed) {
        await mutateJson(cfg.TASKS_HISTORY_FILE, [], hist => { hist.push(removed); return hist; });
    }
    return removed;
}

// Update an in-flight task (used for tries counter + status transitions).
async function updateTask(taskId, patch) {
    await mutateJson(cfg.TASKS_FILE, [], list => {
        const i = list.findIndex(t => t.id === taskId);
        if (i >= 0) list[i] = { ...list[i], ...patch };
        return list;
    });
}

// User-initiated cancel from the dashboard.
async function cancel(taskId, reason = 'user_cancelled') {
    return archive(taskId, { status: 'cancelled', result_note: reason });
}

// Called by brain when a state change makes pending tasks moot.
// Example: trucker sends scale ticket → cancel all pending 'nudge_scale_ticket' tasks
// tied to that booking. Prevents Jarvis nagging after the answer arrived.
//
// container_seq semantics:
//   - Call specifies container_seq: cancel tasks that either have NO container_seq
//     (booking-level tasks) OR match the same container_seq.
//   - Call omits container_seq: cancel only tasks that ALSO have no container_seq
//     (avoid killing container-specific tasks from a booking-level state change).
async function cancelMatching({ type, bkg_no, target_name, container_seq }) {
    const list = loadTasks();
    const toCancel = list.filter(t => {
        if (t.status !== 'pending') return false;
        if (type         && t.type        !== type)        return false;
        if (bkg_no       && t.bkg_no      !== bkg_no)      return false;
        if (target_name  && t.target_name !== target_name) return false;
        // Container-seq matching:
        if (container_seq != null) {
            // caller advanced a specific container — cancel tasks for that container
            // AND tasks with no container_seq (booking-level tasks that resolve too)
            if (t.container_seq != null && t.container_seq !== container_seq) return false;
        } else {
            // caller advanced booking-level — do NOT cancel container-specific tasks
            if (t.container_seq != null) return false;
        }
        return true;
    });
    for (const t of toCancel) {
        await archive(t.id, { status: 'cancelled', result_note: 'auto_cancelled_state_resolved' });
    }
    return toCancel.length;
}

// Evaluate a task's condition against current state. Returns 'skip' | 'fire'.
// 'skip' means the reason for the task no longer applies — auto-archive as done.
function evaluateCondition(task) {
    if (!task.condition || !task.condition.type) return 'fire';
    const bkgNo = task.condition.bkg_no || task.bkg_no;
    if (task.condition.type === 'workflow_flag_true') {
        const { loadWorkflow } = require('./json');
        const wf = loadWorkflow()[bkgNo] || {};
        return wf[task.condition.flag] ? 'skip' : 'fire';
    }
    if (task.condition.type === 'workflow_step_at_or_past') {
        const { loadWorkflow } = require('./json');
        const wf = loadWorkflow()[bkgNo] || {};
        const cfg2 = require('../config');
        const order = cfg2.WORKFLOW_STAGES || [];
        const current = order.indexOf(wf.step);
        const target  = order.indexOf(task.condition.step);
        return (current >= 0 && target >= 0 && current >= target) ? 'skip' : 'fire';
    }
    // Quote-request reminder/escalation gate (2026-08-05) — 'skip' the moment
    // a trucker's reply resolves the leg (price_received/no_response_escalated),
    // so a reminder that's already due when the price finally comes in doesn't
    // fire a stale "any price yet?" a few seconds later. Backed by
    // data/quote_requests.json, NOT workflow.json — a wholly separate store,
    // hence its own condition type rather than reusing workflow_flag_true.
    if (task.condition.type === 'quote_leg_awaiting_reply') {
        const { loadQuoteRequests } = require('./quoteRequests');
        const request = loadQuoteRequests().find((r) => r.id === task.condition.request_id);
        const leg = request && request.legs.find((l) => l.trucker_name === task.condition.trucker_name);
        if (!leg) return 'skip'; // request/leg no longer exists — nothing to remind about
        return leg.status === 'awaiting_reply' ? 'fire' : 'skip';
    }
    // Same gate as quote_leg_awaiting_reply above, for the contact/vendor
    // pipeline's own store (data/contact_quote_requests.json). REAL GAP
    // (found 2026-08-18 while re-keying contact-quote legs from `channel`
    // to `recipient_name` for multi-recipient support): this condition type
    // was referenced by workflow/contactQuoteRequests.js's enqueue() calls
    // since that file was built, but no branch here ever checked it —
    // falling through to this function's unconditional 'fire' default meant
    // a contact-quote reminder/escalation task never actually skipped on
    // its own, EVEN IF the leg had already resolved (priced or escalated).
    // Not a live incident: cancelPendingTasksForLeg already explicitly
    // cancels the pending task the moment a price lands (the same fix
    // shipped earlier this session for the reminder-spam bug), so this gate
    // was always a redundant second line of defense, not the only thing
    // standing between a resolved leg and a stale reminder — but it should
    // still actually work, not silently no-op.
    if (task.condition.type === 'contact_quote_leg_awaiting_reply') {
        const { loadContactQuoteRequests } = require('./contactQuoteRequests');
        const request = loadContactQuoteRequests().find((r) => r.id === task.condition.request_id);
        const leg = request && request.legs.find((l) => l.recipient_name === task.condition.recipient_name);
        if (!leg) return 'skip';
        return leg.status === 'awaiting_reply' ? 'fire' : 'skip';
    }

    // Per-container stage check — used when task is tied to a specific container.
    // Skips (auto-completes) if the target container's stage has reached or passed
    // the condition's step.
    if (task.condition.type === 'container_stage_at_or_past') {
        const { loadBookings } = require('./json');
        const cfg2 = require('../config');
        const seq = task.condition.container_seq != null ? task.condition.container_seq : task.container_seq;
        const booking = loadBookings()[bkgNo];
        if (!booking || !Array.isArray(booking.containers) || seq == null) return 'fire';
        const c = booking.containers.find(x => x.seq === seq);
        if (!c) return 'fire';
        const order = cfg2.WORKFLOW_STAGES || [];
        const current = order.indexOf(c.stage);
        const target  = order.indexOf(task.condition.step);
        return (current >= 0 && target >= 0 && current >= target) ? 'skip' : 'fire';
    }
    return 'fire';
}

// ── Recurring tasks (2026-08-22) ────────────────────────────────────────────
// Added after a real refusal: Apsara asked "Send a reminder to Edge Yard group
// everyday morning to update pricelist" and got "I cannot set daily reminders.
// Please set this up in your calendar." — wrong on the merits, since this
// process already runs a full cron scheduler AND a minute-resolution task
// queue. Her response: "it is my assistant. it should do whatever i want. i am
// the manager." Correct on both counts.
//
// Recurrence is deliberately a property of an EXISTING task rather than a new
// parallel system: a recurring task is an ordinary task that, instead of being
// archived after a successful fire, has its fire_at advanced to the next
// occurrence. Everything else — the condition gate, retry/backoff, target
// resolution, history — is inherited unchanged.
//
//   repeat: {
//     kind    : 'daily' | 'weekdays' | 'weekly',
//     at      : 'HH:MM'  (24h, in tz)
//     weekday : 0-6      (Sunday=0; only for kind==='weekly')
//     tz      : IANA zone, defaults to America/Los_Angeles (same default as
//               every other schedule in scheduler.js — every freight deadline
//               is a US port date)
//   }
//
// A task with no `repeat` behaves EXACTLY as before — this is purely additive.
const DEFAULT_TZ = 'America/Los_Angeles';

// Wall-clock parts for an instant in a given zone. Uses Intl rather than
// hand-rolled offset math so DST is handled by the platform, not by us — the
// LA-vs-ET split already causes enough confusion in scheduler.js.
function zonedParts(date, tz) {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', weekday: 'short',
    });
    const p = {};
    for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
    const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
        year: +p.year, month: +p.month, day: +p.day,
        hour: +p.hour % 24, minute: +p.minute, weekday: WD[p.weekday],
    };
}
// The UTC instant at which the given zone's wall clock reads y-m-d hh:mm.
// Solved by probing rather than by offset tables: guess as if UTC, measure how
// far off the zone actually renders, correct, then re-check once (the second
// pass catches the rare case where the correction itself crosses a DST edge).
function instantForZonedWallClock(y, m, d, hh, mm, tz) {
    let ts = Date.UTC(y, m - 1, d, hh, mm, 0, 0);
    for (let i = 0; i < 2; i++) {
        const p = zonedParts(new Date(ts), tz);
        const rendered = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0, 0);
        const target = Date.UTC(y, m - 1, d, hh, mm, 0, 0);
        const drift = target - rendered;
        if (drift === 0) break;
        ts += drift;
    }
    return new Date(ts);
}
function parseAtTime(at) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(at || '').trim());
    if (!m) return null;
    const hh = +m[1], mm = +m[2];
    if (hh > 23 || mm > 59) return null;
    return { hh, mm };
}
// Next occurrence STRICTLY after `from`. Returns null for an unusable repeat
// spec, so callers can fall back to archiving instead of looping forever on a
// task that can never advance.
function nextFireAt(repeat, from = new Date()) {
    if (!repeat || !repeat.kind) return null;
    const t = parseAtTime(repeat.at);
    if (!t) return null;
    const tz = repeat.tz || DEFAULT_TZ;
    const base = zonedParts(from, tz);
    // Walk forward day by day (14 covers daily/weekdays/weekly incl. any DST
    // shift) until we find the first slot that is genuinely later than `from`.
    for (let addDays = 0; addDays <= 14; addDays++) {
        const probe = new Date(Date.UTC(base.year, base.month - 1, base.day + addDays, 12, 0, 0));
        const p = zonedParts(probe, tz);
        if (repeat.kind === 'weekdays' && (p.weekday === 0 || p.weekday === 6)) continue;
        if (repeat.kind === 'weekly' && p.weekday !== (repeat.weekday ?? 1)) continue;
        const cand = instantForZonedWallClock(p.year, p.month, p.day, t.hh, t.mm, tz);
        if (cand.getTime() > from.getTime()) return cand;
    }
    return null;
}
// Human-readable, for confirmations and listings.
function describeRepeat(repeat) {
    if (!repeat || !repeat.kind) return 'one time';
    const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const at = repeat.at || '?';
    if (repeat.kind === 'daily')    return `every day at ${at}`;
    if (repeat.kind === 'weekdays') return `every weekday at ${at}`;
    if (repeat.kind === 'weekly')   return `every ${DAYS[repeat.weekday ?? 1]} at ${at}`;
    return `repeating (${repeat.kind}) at ${at}`;
}
// Advance a recurring task to its next slot instead of archiving it. Returns
// the new fire_at, or null if it can't recur (caller should archive instead).
async function rescheduleRecurring(taskId, repeat, from = new Date()) {
    const next = nextFireAt(repeat, from);
    if (!next) return null;
    await updateTask(taskId, {
        status: 'pending',
        tries: 0,
        fire_at: next.toISOString(),
        last_fired_at: new Date().toISOString(),
    });
    return next;
}

module.exports = {
    loadTasks, loadHistory,
    enqueue, dueTasks, archive, updateTask, cancel, cancelMatching, evaluateCondition,
    newId,
    nextFireAt, describeRepeat, rescheduleRecurring, parseAtTime, DEFAULT_TZ,
};