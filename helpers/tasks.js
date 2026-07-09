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

module.exports = {
    loadTasks, loadHistory,
    enqueue, dueTasks, archive, updateTask, cancel, cancelMatching, evaluateCondition,
    newId,
};