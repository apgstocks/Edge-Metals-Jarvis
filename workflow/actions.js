// ── workflow/actions.js — Single execution gateway ───────────────────────────
// ONLY this file mutates workflow state and sends operational messages.
// brain.js decides, actions.js executes. Rules carried over from production:
//   - Supplier "load ready" → trucker directly, no manager approval.
//   - Loading photos are a side track — never block the main flow.
//   - Risky/irreversible actions go through pending confirmation (yes/no).

const { loadBookings, loadWorkflow, loadTruckers, loadSuppliers,
    mutateBrain, loadBrain, updateWorkflow, archiveBooking, addFact } = require('../helpers/json');
const { getBooking, formatBookingFull, formatBookingLine, formatBookingAvailable, formatBookingForForward,
    getUrgentBookings, getBookingsThisWeek, getAvailableBookings, stepLabel } = require('../helpers/booking');
const { getLATime, daysUntil } = require('../helpers/time');
const memory = require('../helpers/memory');
const trust = require('../helpers/trust');
const { updateSession }        = require('../helpers/context');
const truckers  = require('./truckers');
const suppliers = require('./suppliers');
const cfg       = require('../config');
const { sendCapture } = require('../helpers/wa-state');

// True when the current async context is inside a /api/bot/command request.
// Used by forwardBooking / assignSupplier to skip yes/no confirm on web.
function isWebSource() {
try { return !!sendCapture.getStore(); } catch { return false; }
}

// ── Messaging injected at boot by index.js ────────────────────────────────────
let _send, _sendToManager, _sendToTeam, _pushAlert;
function init({ sendMessage, sendToManager, sendToTeam, pushAlert }) {
_send          = sendMessage;
_sendToManager = sendToManager;
_sendToTeam    = sendToTeam;
_pushAlert     = pushAlert || (() => {});
}

// ── Pending action helpers (persist in brain.json — survive restarts) ─────────
// A chat can only have ONE unresolved pending at a time (pending_actions is
// keyed by chatId, not a list) — but several independent triggers can now
// target the SAME chat: the 8:15AM trucker wizard, the end-of-day learning
// digest, and a manager-initiated "email X about Y" confirm. Before this,
// a later setPending() would silently overwrite an earlier unresolved one —
// flagged as a real risk in dailyTruckerCheck's own comment in scheduler.js.
// The failure mode isn't just a lost prompt: if the manager then replies
// "yes" thinking they're answering the ORIGINAL question, resolvePending
// resolves it against whatever silently replaced it instead — e.g. a "yes"
// meant for the trucker wizard could instead confirm sending a drafted email.
// Fix: never overwrite an unresolved pending. Queue the new one; it goes
// live automatically the moment the current one resolves (see clearPending).
async function setPending(chatId, action) {
const existing = getPending(chatId);
if (existing) {
    await mutateBrain(b => {
        b.pending_queue[chatId] = b.pending_queue[chatId] || [];
        b.pending_queue[chatId].push(action);
    });
    console.warn(`[ACTIONS] ${chatId}: '${existing.type}' still unresolved — queued '${action.type}' behind it instead of overwriting`);
    return { queued: true, blockedBy: existing.type };
}
await mutateBrain(b => {
    b.pending_actions[chatId] = {
        ...action,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + cfg.PENDING_EXPIRY_MS).toISOString(),
    };
});
return { queued: false };
}
async function clearPending(chatId) {
await mutateBrain(b => { delete b.pending_actions[chatId]; });
// Deliberately NOT promoting a queued pending here — several flows (the
// trucker wizard's wizardAdvance) call clearPending() then immediately
// setPending() again for their OWN next step, in the same synchronous
// handling of one message. Promoting here would let a queued item jump
// in front of that continuation and silently break the wizard mid-flow.
// Promotion happens once, in promoteQueued(), called from brain.js's
// process() AFTER the whole message has finished routing — see there.
}
function getPending(chatId) {
return loadBrain().pending_actions[chatId] || null;
}

// Called once per inbound message, after it's been fully routed (brain.js's
// process()) — promotes the next queued pending for this chat, but ONLY if
// the slot is genuinely still empty at that point (i.e. nothing from this
// same message's own handling re-claimed it). Returns the promoted pending,
// or null if nothing was promoted.
async function promoteQueued(chatId) {
if (getPending(chatId)) return null;
let promoted = null;
await mutateBrain(b => {
    const queue = b.pending_queue[chatId] || [];
    if (queue.length) {
        promoted = queue.shift();
        b.pending_actions[chatId] = {
            ...promoted,
            created_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + cfg.PENDING_EXPIRY_MS).toISOString(),
        };
    }
});
if (promoted) {
    try {
        // Lazy require — brain.js requires this file at module scope, so a
        // top-level require here would be circular. Safe at call time since
        // brain.js is always fully loaded before any message is processed.
        const { pendingFullReminder } = require('./brain');
        const text = (pendingFullReminder && pendingFullReminder(promoted)) || `You also have a pending "${promoted.type}" waiting on this chat — go ahead and reply.`;
        await _send(chatId, `(Next up — this was queued behind what you just answered:)\n${text}`);
    } catch (e) { console.error('[ACTIONS] promote-queued notify failed:', e.message); }
}
return promoted;
}

// ── Menus / status ────────────────────────────────────────────────────────────
async function showMenu(chatId) {
updateSession(chatId, { menuContext: 'main' });
await _send(chatId, cfg.MAIN_MENU);
return { action_taken: 'menu' };
}

async function showBookingsMenu(chatId) {
updateSession(chatId, { menuContext: 'bookings' });
await _send(chatId, cfg.BOOKINGS_MENU);
return { action_taken: 'bookings_menu' };
}

async function showBookingStatus(chatId, bkgNo) {
const { booking, status } = getBooking(bkgNo);
if (!booking) { await _send(chatId, `No booking found for ${bkgNo}.`); return { action_taken: 'not_found' }; }
let text = formatBookingFull(booking);
if (status === 'archived') text += '\n(archived)';
updateSession(chatId, { activeBooking: booking.booking_number, currentTopic: 'booking_status' });
await _send(chatId, text);
return { action_taken: 'status_shown' };
}

async function showBookingsAll(chatId) {
const all = Object.values(loadBookings());
if (!all.length) { await _send(chatId, 'No active bookings.'); return { action_taken: 'list_empty' }; }
await _send(chatId, ['Active bookings:', '', ...all.map(formatBookingLine)].join('\n'));
return { action_taken: 'list_all' };
}

async function showBookingsUrgent(chatId) {
const urgent = getUrgentBookings();
if (!urgent.length) { await _send(chatId, `No cutoffs within ${cfg.URGENT_CUTOFF_DAYS} days.`); return { action_taken: 'list_empty' }; }
const lines = urgent.map(b => `${b.booking_number} — cutoff ${b.cutoff_date} (${daysUntil(b.cutoff_date)}d)`);
await _send(chatId, ['Urgent cutoffs:', '', ...lines].join('\n'));
return { action_taken: 'list_urgent' };
}

async function showBookingsAvailable(chatId) {
const avail = getAvailableBookings();
if (!avail.length) { await _send(chatId, 'No unassigned bookings.'); return { action_taken: 'list_empty' }; }
await _send(chatId, ['Available (no supplier):', '', ...avail.map(formatBookingAvailable)].join('\n\n'));
return { action_taken: 'list_available' };
}

async function showBookingsWeek(chatId) {
const week = getBookingsThisWeek();
if (!week.length) { await _send(chatId, 'Nothing moving this week.'); return { action_taken: 'list_empty' }; }
await _send(chatId, ["This week:", '', ...week.map(formatBookingLine)].join('\n'));
return { action_taken: 'list_week' };
}

async function showContacts(chatId) {
const t = (await loadTruckers()).map(x => `- ${x.name}${x.group_id ? '' : ' (DM)'}`);
const s = (await loadSuppliers()).map(x => `- ${x.name}${x.group_id ? '' : ' (DM)'}`);
await _send(chatId, ['Truckers:', ...(t.length ? t : ['(none)']), '', 'Suppliers:', ...(s.length ? s : ['(none)'])].join('\n'));
return { action_taken: 'contacts_shown' };
}

// ── Forward booking to trucker ────────────────────────────────────────────────
// No trucker given → numbered selection (pending). Trucker given → confirm (pending).
async function forwardBooking(chatId, bkgNo, truckerName, containerSeq) {
const { booking } = getBooking(bkgNo);
if (!booking) { await _send(chatId, `No booking found for ${bkgNo}.`); return { action_taken: 'not_found' }; }

const containers = require('../helpers/containers');
const cList = Array.isArray(booking.containers) ? booking.containers : [];

// Resolve target container:
//   - Explicit seq → validate exists.
//   - No seq + multi-container → auto-pick next unassigned (lowest seq).
//   - No seq + single container (or legacy flat) → container 1 (or synthesised).
let targetContainer;
if (containerSeq != null) {
    targetContainer = containers.getContainer(booking, containerSeq);
    if (!targetContainer) {
        await _send(chatId, `Container ${containerSeq} not found on ${bkgNo}. Available: ${cList.map(c => '#' + c.seq).join(', ') || 'none'}.`);
        return { action_taken: 'container_not_found' };
    }
} else if (cList.length > 0) {
    targetContainer = containers.nextUnassignedContainer(booking, 'trucker');
    if (!targetContainer) {
        await _send(chatId, `${bkgNo}: all ${cList.length} container${cList.length > 1 ? 's' : ''} already assigned to truckers. Nothing to forward.`);
        return { action_taken: 'max_capacity' };
    }
} else {
    targetContainer = null; // Legacy flat — no containers[] at all
}

// Supplier guard — per-container check when we have a target, else legacy any-supplier check.
if (targetContainer) {
    if (!targetContainer.supplier) {
        await _send(chatId, `Can't forward ${bkgNo}/${targetContainer.seq} — no supplier assigned to container #${targetContainer.seq}. Assign a supplier first.`);
        return { action_taken: 'no_supplier_assigned' };
    }
} else {
    if (!booking.supplier) {
        await _send(chatId, `Can't forward ${bkgNo} — no supplier assigned yet. Type "assign ${bkgNo}" first.`);
        return { action_taken: 'no_supplier_assigned' };
    }
}

if (!truckerName) {
    const sel = await truckers.buildTruckerSelectionMessage(bkgNo);
    if (!sel.list.length) { await _send(chatId, sel.text); return { action_taken: 'no_truckers' }; }
    await setPending(chatId, { type: 'select_trucker', bkg_no: bkgNo, container_seq: targetContainer?.seq || null, options: sel.list.map(t => t.name) });
    await _send(chatId, sel.text);
    return { action_taken: 'awaiting_trucker_selection' };
}

const t = await truckers.getTrucker(truckerName);
if (!t) { await _send(chatId, `Trucker "${truckerName}" not found. Type "forward ${bkgNo}" to pick from the list.`); return { action_taken: 'trucker_not_found' }; }

// Web Bot tab — skip yes/no confirm.
if (isWebSource()) {
    await clearPending(chatId);
    return executeForward(chatId, bkgNo, t.name, targetContainer?.seq || null);
}

// Graduated trust — this exact trucker has a proven streak of correct
// approvals AND bot_mode has been deliberately set to allow it. Execute
// immediately instead of blocking on yes/no; to undo, the manager uses the
// existing, already-tested "recall" command — no new reversal logic needed.
if (trust.isTrusted('forward', t.name)) {
    const label = targetContainer ? `${bkgNo}/${targetContainer.seq}` : bkgNo;
    const result = await executeForward(chatId, bkgNo, t.name, targetContainer?.seq || null);
    await _send(chatId, `(Auto — ${t.name} has a proven track record. Reply "recall ${bkgNo}" if this was wrong.)`);
    return result;
}

await setPending(chatId, { type: 'confirm_forward', bkg_no: bkgNo, trucker_name: t.name, container_seq: targetContainer?.seq || null });
const label = targetContainer ? `${bkgNo}/${targetContainer.seq}` : bkgNo;
await _send(chatId, `Forward ${label} to ${t.name}? (yes/no)`);
return { action_taken: 'awaiting_confirmation' };
}

// Executes after manager confirms.
// containerSeq (optional): write the trucker onto that specific container.
async function executeForward(chatId, bkgNo, truckerName, containerSeq) {
const { booking } = getBooking(bkgNo);
if (!booking) { await _send(chatId, `Booking ${bkgNo} disappeared — check dashboard.`); return { action_taken: 'not_found' }; }

const truckerChat = await truckers.getTruckerChatId(truckerName);
const t           = await truckers.getTrucker(truckerName);
const label       = containerSeq != null ? `${bkgNo}/${containerSeq}` : bkgNo;

await _send(truckerChat,
    [`New booking — ${label}`, '', formatBookingForForward(booking), '', 'Please confirm empty pickup and send the empty-drop photo when done.'].join('\n'));

// PDF side track — never blocks the forward
try {
    const { fetchPdfFromDrive } = require('../helpers/drive');
    const pdf = await fetchPdfFromDrive(bkgNo);
    if (pdf) await _send(truckerChat, null, pdf);
} catch (e) { console.log('[ACTIONS] PDF skip:', e.message); }

// Per-container: write trucker + stage onto the target container. ALWAYS
// runs, not gated on containerSeq being explicitly set — a real bug found
// via simulation testing: single-container bookings pass containerSeq=null
// (a DISPLAY decision, made in proceedToContainer, to keep "/seq" out of
// messages when there's only one container) — but that same null was ALSO
// disabling this write entirely, silently failing to persist the assignment
// for what's likely the majority of real bookings. containerSeq ?? 1
// defaults to the (only) container when no explicit seq was given.
{
    const { mutateJson } = require('../helpers/json');
    const { migrate } = require('../helpers/containers');
    const targetSeq = containerSeq ?? 1;
    await mutateJson(cfg.BOOKINGS_FILE, {}, all => {
        if (!all[bkgNo]) return all;
        all[bkgNo] = migrate(all[bkgNo]);
        const c = all[bkgNo].containers.find(x => x.seq === targetSeq);
        if (c) { c.trucker = truckerName; c.stage = 'forwarded'; }
        return all;
    });
}

// Booking-level workflow: bookingStage (weakest link) drives the top-level 'step'.
// Once ANY container is forwarded, top-level step advances to 'forwarded' if it was earlier.
const { bookingStage } = require('../helpers/containers');
const { loadBookings } = require('../helpers/json');
const fresh = loadBookings()[bkgNo];
const topStage = fresh ? bookingStage(fresh) : 'forwarded';

await updateWorkflow(bkgNo, {
    step            : topStage,
    trucker_name    : truckerName,                  // legacy — kept for backward compat with existing readers
    trucker_group_id: t?.group_id || truckerChat,
    forwarded_at    : new Date().toISOString(),
});

await _send(chatId, `${label} forwarded to ${truckerName}.`);
_pushAlert({ type: 'forwarded', bkgNo, message: `${label} forwarded to ${truckerName}`, severity: 'info' });
return { action_taken: 'forwarded' };
}

// ── Assign supplier ───────────────────────────────────────────────────────────
async function assignSupplier(chatId, bkgNo, supplierName, containerSeq) {
const { booking } = getBooking(bkgNo);
if (!booking) { await _send(chatId, `No booking found for ${bkgNo}.`); return { action_taken: 'not_found' }; }

const containersMod = require('../helpers/containers');
const cList = Array.isArray(booking.containers) ? booking.containers : [];

// Resolve target container: explicit seq → validate; else auto-pick next unassigned supplier.
let targetContainer;
if (containerSeq != null) {
    targetContainer = containersMod.getContainer(booking, containerSeq);
    if (!targetContainer) {
        await _send(chatId, `Container ${containerSeq} not found on ${bkgNo}. Available: ${cList.map(c => '#' + c.seq).join(', ') || 'none'}.`);
        return { action_taken: 'container_not_found' };
    }
} else if (cList.length > 0) {
    targetContainer = containersMod.nextUnassignedContainer(booking, 'supplier');
    if (!targetContainer) {
        await _send(chatId, `${bkgNo}: all ${cList.length} container${cList.length > 1 ? 's' : ''} already have suppliers. Nothing to assign.`);
        return { action_taken: 'max_capacity' };
    }
} else {
    targetContainer = null; // Legacy flat
}

if (!supplierName) {
    const sel = await suppliers.buildSupplierSelectionMessage(bkgNo);
    if (!sel.list.length) { await _send(chatId, sel.text); return { action_taken: 'no_suppliers' }; }
    await setPending(chatId, { type: 'select_supplier', bkg_no: bkgNo, container_seq: targetContainer?.seq || null, options: sel.list.map(s => s.name) });
    await _send(chatId, sel.text);
    return { action_taken: 'awaiting_supplier_selection' };
}

const s = await suppliers.getSupplier(supplierName);
if (!s) { await _send(chatId, `Supplier "${supplierName}" not found.`); return { action_taken: 'supplier_not_found' }; }

// Web Bot tab — skip yes/no confirm, fire immediately.
if (isWebSource()) {
    await clearPending(chatId);
    return executeAssign(chatId, bkgNo, s.name, targetContainer?.seq || null);
}

// Graduated trust — see forwardBooking for the full reasoning. Undo here is
// a manual re-assign to the correct supplier (no clean single "unassign"
// exists yet) — flagged in the auto message so the manager knows the path.
if (trust.isTrusted('assign', s.name)) {
    const label = targetContainer ? `${bkgNo}/${targetContainer.seq}` : bkgNo;
    const result = await executeAssign(chatId, bkgNo, s.name, targetContainer?.seq || null);
    await _send(chatId, `(Auto — ${s.name} has a proven track record. If this was wrong, reassign with "assign ${bkgNo} to <correct supplier>".)`);
    return result;
}

await setPending(chatId, { type: 'confirm_assign', bkg_no: bkgNo, supplier_name: s.name, container_seq: targetContainer?.seq || null });
const label = targetContainer ? `${bkgNo}/${targetContainer.seq}` : bkgNo;
await _send(chatId, `Assign ${label} to ${s.name}? (yes/no)`);
return { action_taken: 'awaiting_confirmation' };
}

async function executeAssign(chatId, bkgNo, supplierName, containerSeq) {
const { booking } = getBooking(bkgNo);
if (!booking) return { action_taken: 'not_found' };

const supplierChat = await suppliers.getSupplierChatId(supplierName);
const s            = await suppliers.getSupplier(supplierName);
const label        = containerSeq != null ? `${bkgNo}/${containerSeq}` : bkgNo;

await _send(supplierChat,
    [`New assignment — ${label}`, '', formatBookingForForward(booking), '', 'Please confirm material readiness and share the target load date.'].join('\n'));

// Per-container: write supplier + stage onto the target container. ALWAYS
// runs — see executeForward's identical fix above for the full reasoning.
{
    const { mutateJson } = require('../helpers/json');
    const { migrate } = require('../helpers/containers');
    const targetSeq = containerSeq ?? 1;
    await mutateJson(cfg.BOOKINGS_FILE, {}, all => {
        if (!all[bkgNo]) return all;
        all[bkgNo] = migrate(all[bkgNo]);
        const c = all[bkgNo].containers.find(x => x.seq === targetSeq);
        if (c) { c.supplier = supplierName; if (c.stage === 'not_started') c.stage = 'supplier_assigned'; }
        return all;
    });
}

// Booking-level workflow — weakest link.
const { bookingStage } = require('../helpers/containers');
const { loadBookings } = require('../helpers/json');
const fresh = loadBookings()[bkgNo];
const topStage = fresh ? bookingStage(fresh) : 'supplier_assigned';

await updateWorkflow(bkgNo, {
    step             : topStage,
    supplier         : supplierName,             // legacy — kept for existing readers
    supplier_group_id: s?.group_id || supplierChat,
    assigned_at      : new Date().toISOString(),
});

await _send(chatId, `${label} assigned to ${supplierName}.`);
_pushAlert({ type: 'assigned', bkgNo, message: `${label} assigned to ${supplierName}`, severity: 'info' });
return { action_taken: 'assigned' };
}

// ── Phase 4a: disambiguation prompts to trucker/supplier ──────────────────
// askWhichBooking: fired when a trucker/supplier's state message is ambiguous
// across 2+ bookings. Sends numbered list and stores pending awaiting_booking_selection.
async function askWhichBooking(chatId, decisionData, personName, kind /* 'trucker'|'supplier' */) {
const options = decisionData.booking_options || [];
const lines = options.map((b, i) => `${i + 1}. ${b}`);
await setPending(chatId, {
    type              : 'awaiting_booking_selection',
    intent_to_resolve : decisionData.intent_to_resolve,
    has_media         : !!decisionData.has_media,
    booking_options   : options,
    person_name       : personName,
    person_kind       : kind,
});
await _send(chatId, ['Which booking?', '', ...lines, '', 'Reply with a number or the booking number.'].join('\n'));
return { action_taken: 'awaiting_booking_selection' };
}

// askWhichContainer: fired when the booking is known but 2+ containers on it
// are assigned to this person and match the required stage. Numbered list of
// container seqs.
async function askWhichContainer(chatId, decisionData) {
const bkg     = decisionData.bkg_no;
const options = decisionData.container_options || [];
const lines = options.map(seq => `${seq}. ${bkg}/${seq}`);
await setPending(chatId, {
    type              : 'awaiting_container_selection',
    intent_to_resolve : decisionData.intent_to_resolve,
    has_media         : !!decisionData.has_media,
    bkg_no            : bkg,
    container_options : options,
});
await _send(chatId, [`Which container of ${bkg}?`, '', ...lines, '', 'Reply with the container number.'].join('\n'));
return { action_taken: 'awaiting_container_selection' };
}

// Fire the resolved state intent with fully-known bkg + container_seq.
async function fireResolvedStateIntent(intent, bkgNo, containerSeq, senderName, hasMedia) {
switch (intent) {
    case 'empty_drop_confirmed':   return emptyDropConfirmed(bkgNo, senderName, containerSeq);
    case 'load_ready_received':    return loadReadyReceived(bkgNo, senderName, containerSeq);
    case 'picked_up_confirmed':    return pickedUpConfirmed(bkgNo, hasMedia, senderName, containerSeq);
    case 'scale_ticket_received':  return scaleTicketReceived(bkgNo, containerSeq);
    case 'ingate_received':        return ingateReceived(bkgNo, senderName, containerSeq);
    default: return { action_taken: 'noop' };
}
}
// All five handlers below accept containerSeq (optional).
// If containerSeq is given, the target container's `stage` is set and the
// booking-level workflow.step becomes the weakest-link of container stages.
// If containerSeq is null (legacy / single-container), fall back to legacy
// behavior — top-level step advances directly.

async function advanceContainer(bkgNo, containerSeq, newStage) {
if (containerSeq == null) return;
const { mutateJson } = require('../helpers/json');
const { migrate } = require('../helpers/containers');
await mutateJson(cfg.BOOKINGS_FILE, {}, all => {
    if (!all[bkgNo]) return all;
    all[bkgNo] = migrate(all[bkgNo]);
    const c = all[bkgNo].containers.find(x => x.seq === containerSeq);
    if (c) c.stage = newStage;
    return all;
});
}

// Compute weakest-link booking step from post-write state.
async function syncWorkflowFromContainers(bkgNo) {
const { bookingStage } = require('../helpers/containers');
const { loadBookings } = require('../helpers/json');
const fresh = loadBookings()[bkgNo];
return fresh ? bookingStage(fresh) : null;
}

async function emptyDropConfirmed(bkgNo, byName, containerSeq) {
await advanceContainer(bkgNo, containerSeq, 'empty_dropped');
const topStep = (await syncWorkflowFromContainers(bkgNo)) || 'empty_dropped';
await updateWorkflow(bkgNo, { step: topStep, empty_dropped_at: new Date().toISOString() });
const supplierChat = await suppliers.getSupplierGroupIdForBooking(bkgNo);
const label = containerSeq != null ? `${bkgNo}/${containerSeq}` : bkgNo;
if (supplierChat) await _send(supplierChat, `${label}: empty container dropped. Please start loading and reply "load ready" when done.`);
await _sendToTeam(`${label}: empty dropped (${byName || 'trucker'}).`);
await require('../helpers/tasks').cancelMatching({ type: 'nudge_empty_drop', bkg_no: bkgNo, container_seq: containerSeq });
return { action_taken: 'empty_dropped' };
}

// Supplier → trucker DIRECTLY. No manager approval (established rule).
async function loadReadyReceived(bkgNo, byName, containerSeq) {
await advanceContainer(bkgNo, containerSeq, 'load_ready');
const topStep = (await syncWorkflowFromContainers(bkgNo)) || 'load_ready';
await updateWorkflow(bkgNo, { step: topStep, load_ready_at: new Date().toISOString() });
const truckerChat = await truckers.getTruckerGroupIdForBooking(bkgNo);
const label = containerSeq != null ? `${bkgNo}/${containerSeq}` : bkgNo;
if (truckerChat) await _send(truckerChat, `${label}: load is READY for pickup. Please confirm your pickup window and send the scale ticket after pickup.`);
await _sendToTeam(`${label}: load ready (${byName || 'supplier'}). Trucker notified.`);
await require('../helpers/tasks').cancelMatching({ type: 'nudge_load_ready', bkg_no: bkgNo, container_seq: containerSeq });
return { action_taken: 'load_ready' };
}

async function pickedUpConfirmed(bkgNo, hasScaleTicket, byName, containerSeq) {
await advanceContainer(bkgNo, containerSeq, 'picked_up');
const topStep = (await syncWorkflowFromContainers(bkgNo)) || 'picked_up';
await updateWorkflow(bkgNo, {
    step        : topStep,
    picked_up_at: new Date().toISOString(),
    ...(hasScaleTicket ? { scale_ticket: true, scale_ticket_at: new Date().toISOString() } : {}),
});
const label = containerSeq != null ? `${bkgNo}/${containerSeq}` : bkgNo;
await _sendToTeam(`${label}: picked up${hasScaleTicket ? ' — scale ticket received' : ' (scale ticket pending)'} (${byName || 'trucker'}).`);
const tasksHelper = require('../helpers/tasks');
await tasksHelper.cancelMatching({ type: 'nudge_pickup', bkg_no: bkgNo, container_seq: containerSeq });
if (hasScaleTicket) await tasksHelper.cancelMatching({ type: 'nudge_scale_ticket', bkg_no: bkgNo, container_seq: containerSeq });
return { action_taken: 'picked_up' };
}

// Scale ticket arriving late (side track). Not a stage transition — just a flag.
async function scaleTicketReceived(bkgNo, containerSeq) {
// No container stage change — scale_ticket is a workflow-level flag today.
// (Future: could be per-container. Leaving as booking-level for now to match schema.)
await updateWorkflow(bkgNo, { scale_ticket: true, scale_ticket_at: new Date().toISOString() });
const label = containerSeq != null ? `${bkgNo}/${containerSeq}` : bkgNo;
await _sendToTeam(`${label}: scale ticket received.`);
await require('../helpers/tasks').cancelMatching({ type: 'nudge_scale_ticket', bkg_no: bkgNo, container_seq: containerSeq });
return { action_taken: 'scale_ticket' };
}

async function ingateReceived(bkgNo, byName, containerSeq) {
await advanceContainer(bkgNo, containerSeq, 'ingate_received');
const topStep = (await syncWorkflowFromContainers(bkgNo)) || 'ingate_received';
await updateWorkflow(bkgNo, { step: topStep, ingate_at: new Date().toISOString() });
const label = containerSeq != null ? `${bkgNo}/${containerSeq}` : bkgNo;
await _sendToManager(`${label}: INGATED at port.`);
await _sendToTeam(`${label}: ingate received (${byName || 'trucker'}).`);
_pushAlert({ type: 'ingated', bkgNo, message: `${label} ingated`, severity: 'info' });
await require('../helpers/tasks').cancelMatching({ type: 'nudge_ingate', bkg_no: bkgNo, container_seq: containerSeq });
return { action_taken: 'ingated' };
}

// ── Recall / archive ──────────────────────────────────────────────────────────
async function recallBooking(chatId, bkgNo) {
await setPending(chatId, { type: 'confirm_recall', bkg_no: bkgNo });
await _send(chatId, `Recall ${bkgNo} from the trucker and reset to Not Started? (yes/no)`);
return { action_taken: 'awaiting_confirmation' };
}

async function executeRecall(chatId, bkgNo) {
const truckerChat = await truckers.getTruckerGroupIdForBooking(bkgNo);
if (truckerChat) await _send(truckerChat, `${bkgNo} has been RECALLED. Please stop work on this booking.`);
await updateWorkflow(bkgNo, { step: 'not_started', trucker_name: null, trucker_group_id: null, recalled_at: new Date().toISOString() });
await _send(chatId, `${bkgNo} recalled.`);
_pushAlert({ type: 'recalled', bkgNo, message: `${bkgNo} recalled from trucker`, severity: 'warning' });
return { action_taken: 'recalled' };
}

async function archiveNow(chatId, bkgNo) {
const ok = await archiveBooking(bkgNo, 'manual');
await _send(chatId, ok ? `${bkgNo} archived.` : `No active booking ${bkgNo}.`);
return { action_taken: ok ? 'archived' : 'not_found' };
}

// ── Pending resolution (called by brain when manager replies yes/no/selection) ─
// ── Guided daily trucker-assignment wizard ──────────────────────────────────
// Triggered by scheduler.js's dailyTruckerCheck(). Chains through pending
// states: wizard_start → wizard_await_port → wizard_await_booking (if 2+
// candidates) → wizard_await_supplier (if ambiguous) → wizard_await_trucker
// (if ambiguous) → wizard_confirm → execute. Each "if ambiguous" step is
// skipped automatically when resolveDefaultSupplier/Trucker can resolve it
// without asking (single registered option, or one flagged is_default).
async function wizardAdvance(chatId, pending, answer, selection) {
    const { loadBookings, loadWorkflow } = require('../helpers/json');
    const { migrate, nextUnassignedContainer } = require('../helpers/containers');

    switch (pending.type) {
        case 'wizard_start': {
            if (answer !== 'yes') { await clearPending(chatId); return { action_taken: 'wizard_declined' }; }
            const bookings = loadBookings();
            const workflow = loadWorkflow();
            const ports = new Set();
            for (const b of Object.values(bookings)) {
                const wf = workflow[b.booking_number] || {};
                if (['ingate_received', 'done', 'archived'].includes(wf.step)) continue;
                // Container-aware: a booking stays a candidate as long as ANY of its
                // containers still lacks a trucker — NOT just checking the legacy
                // booking-level trucker_name field, which gets set once the FIRST
                // container is forwarded even if 2 more still need one. This is
                // what actually supports a 3x40HC booking going to 3 different
                // truckers instead of vanishing from the list after the first.
                if (!nextUnassignedContainer(migrate(b), 'trucker')) continue;
                if (b.port_of_loading) ports.add(b.port_of_loading);
            }
            const portList = [...ports];
            if (!portList.length) {
                await clearPending(chatId);
                await _send(chatId, 'No bookings currently need a trucker. All set.');
                return { action_taken: 'wizard_no_candidates' };
            }
            await setPending(chatId, { type: 'wizard_await_port', options: portList });
            await _send(chatId, ['Which port?', '', ...portList.map((p, i) => `${i + 1}. ${p}`), '', 'Reply with a number or name.'].join('\n'));
            return { action_taken: 'wizard_await_port' };
        }

        case 'wizard_await_port': {
            const port = selection || answer;
            if (!port) { await _send(chatId, 'Which port?'); return { action_taken: 'wizard_await_port' }; }
            const bookings = loadBookings();
            const workflow = loadWorkflow();
            const candidates = Object.values(bookings).filter(b => {
                const wf = workflow[b.booking_number] || {};
                if (['ingate_received', 'done', 'archived'].includes(wf.step)) return false;
                if (!nextUnassignedContainer(migrate(b), 'trucker')) return false;
                return (b.port_of_loading || '').toLowerCase() === String(port).toLowerCase();
            });
            if (!candidates.length) {
                await clearPending(chatId);
                await _send(chatId, `No bookings at ${port} currently need a trucker.`);
                return { action_taken: 'wizard_no_candidates' };
            }
            if (candidates.length === 1) return proceedToContainer(chatId, candidates[0].booking_number, port);
            const options = candidates.map(b => b.booking_number);
            await setPending(chatId, { type: 'wizard_await_booking', port, options });
            await _send(chatId, ['Which booking?', '', ...options.map((o, i) => `${i + 1}. ${o}`), '', 'Reply with a number or the booking number.'].join('\n'));
            return { action_taken: 'wizard_await_booking' };
        }

        case 'wizard_await_booking': {
            const bkgNo = selection || answer;
            if (!bkgNo) { await _send(chatId, 'Which booking?'); return { action_taken: 'wizard_await_booking' }; }
            return proceedToContainer(chatId, bkgNo, pending.port);
        }

        case 'wizard_await_supplier': {
            const supplierName = selection || answer;
            if (!supplierName) { await _send(chatId, 'Which supplier?'); return { action_taken: 'wizard_await_supplier' }; }
            return proceedToTrucker(chatId, pending.bkg_no, pending.port, supplierName, pending.container_seq);
        }

        case 'wizard_await_trucker': {
            const truckerName = selection || answer;
            if (!truckerName) { await _send(chatId, 'Which trucker?'); return { action_taken: 'wizard_await_trucker' }; }
            // port is threaded through so a continuation container (seq 2, 3...)
            // can auto-resolve supplier/trucker the same way container 1 did —
            // a real gap found via simulation: without it, resolveDefaultSupplier
            // silently gets an undefined port and can never match, forcing an
            // unnecessary re-ask on every subsequent container even when the
            // answer is unambiguous.
            return proceedToConfirm(chatId, pending.bkg_no, pending.supplier_name, truckerName, pending.container_seq, pending.port);
        }

        case 'wizard_confirm': {
            await clearPending(chatId);
            return executeWizardAssignment(chatId, pending.bkg_no, pending.supplier_name, pending.trucker_name, pending.container_seq, pending.port);
        }
    }
}

// Entry point once a specific booking is chosen — finds WHICH container
// actually needs a trucker (lowest seq first) and starts resolving for that
// one specifically. A single-container booking behaves exactly as before;
// a 3-container booking processes one container per pass through the wizard.
async function proceedToContainer(chatId, bkgNo, port) {
    const { loadBookings } = require('../helpers/json');
    const { migrate, nextUnassignedContainer } = require('../helpers/containers');
    const booking = migrate(loadBookings()[bkgNo]);
    if (!booking) { await clearPending(chatId); await _send(chatId, `Booking ${bkgNo} not found.`); return { action_taken: 'not_found' }; }

    const target = nextUnassignedContainer(booking, 'trucker');
    if (!target) {
        await clearPending(chatId);
        await _send(chatId, `${bkgNo}: every container already has a trucker.`);
        return { action_taken: 'wizard_no_candidates' };
    }
    // Only show the /seq suffix when the booking genuinely has more than one
    // container — no point cluttering a single-container booking's messages.
    const containerSeq = booking.containers.length > 1 ? target.seq : null;
    return proceedToSupplier(chatId, bkgNo, port, containerSeq);
}

// Step: does THIS SPECIFIC CONTAINER already have a supplier? Checked at the
// container level, not the booking level — different containers on the same
// booking can have different suppliers.
async function proceedToSupplier(chatId, bkgNo, port, containerSeq) {
    const { loadBookings } = require('../helpers/json');
    const { migrate, getContainer } = require('../helpers/containers');
    const booking = migrate(loadBookings()[bkgNo]);
    const existingSupplier = containerSeq != null
        ? getContainer(booking, containerSeq)?.supplier
        : (booking?.containers?.[0]?.supplier || booking?.supplier);
    if (existingSupplier) return proceedToTrucker(chatId, bkgNo, port, existingSupplier, containerSeq);

    const defaultSupplier = await suppliers.resolveDefaultSupplier(port);
    if (defaultSupplier) return proceedToTrucker(chatId, bkgNo, port, defaultSupplier.name, containerSeq);

    const sel = await suppliers.buildSupplierSelectionMessage(bkgNo);
    if (!sel.list.length) {
        await clearPending(chatId);
        await _send(chatId, `No supplier registered at ${port} for ${bkgNo}. Add one from the dashboard first.`);
        return { action_taken: 'wizard_no_supplier' };
    }
    await setPending(chatId, { type: 'wizard_await_supplier', bkg_no: bkgNo, port, container_seq: containerSeq, options: sel.list.map(s => s.name) });
    await _send(chatId, sel.text);
    return { action_taken: 'wizard_await_supplier' };
}

// Step: resolve the trucker the same way, for the same specific container.
async function proceedToTrucker(chatId, bkgNo, port, supplierName, containerSeq) {
    const defaultTrucker = await truckers.resolveDefaultTrucker(port);
    if (defaultTrucker) return proceedToConfirm(chatId, bkgNo, supplierName, defaultTrucker.name, containerSeq, port);

    const sel = await truckers.buildTruckerSelectionMessage(bkgNo);
    if (!sel.list.length) {
        await clearPending(chatId);
        await _send(chatId, `No trucker registered at ${port} for ${bkgNo}. Add one from the dashboard first.`);
        return { action_taken: 'wizard_no_trucker' };
    }
    await setPending(chatId, { type: 'wizard_await_trucker', bkg_no: bkgNo, port, supplier_name: supplierName, container_seq: containerSeq, options: sel.list.map(t => t.name) });
    await _send(chatId, sel.text);
    return { action_taken: 'wizard_await_trucker' };
}

// Step: present ONE combined confirmation for supplier + trucker together,
// scoped to the specific container when the booking has more than one.
async function proceedToConfirm(chatId, bkgNo, supplierName, truckerName, containerSeq, port) {
    await setPending(chatId, { type: 'wizard_confirm', bkg_no: bkgNo, supplier_name: supplierName, trucker_name: truckerName, container_seq: containerSeq, port });
    const label = containerSeq != null ? `${bkgNo}/${containerSeq}` : bkgNo;
    await _send(chatId, `${label} — Supplier: ${supplierName}, Trucker: ${truckerName}. Confirm? (yes/no)`);
    return { action_taken: 'wizard_await_confirm' };
}

// Final step: execute for this one container. Checks dual-role FIRST — a
// contact acting as both supplier and trucker gets ONE combined message,
// never the normal separate assign-then-forward messaging. After executing,
// checks whether the SAME booking still has another container needing a
// trucker and, if so, loops straight back into the wizard for it — this is
// what actually lets a 3x40HC booking go to 3 different parties in one
// guided session instead of requiring 3 separate manual triggers.
async function executeWizardAssignment(chatId, bkgNo, supplierName, truckerName, containerSeq, port) {
    const dualRole = require('../helpers/dualRole');
    const supplierRecord = await suppliers.getSupplier(supplierName);
    const truckerRecord  = await truckers.getTrucker(truckerName);

    let result;
    if (dualRole.isSamePairing(supplierRecord, truckerRecord)) {
        result = await executeCombinedAssignment(chatId, bkgNo, supplierRecord, truckerRecord, containerSeq);
    } else {
        // Different parties — the wizard's own combined confirmation already
        // served as "are you sure", so call the EXECUTE functions directly
        // rather than assignSupplier/forwardBooking, which would ask yes/no again.
        await executeAssign(chatId, bkgNo, supplierName, containerSeq);
        result = await executeForward(chatId, bkgNo, truckerName, containerSeq);
    }

    // Same booking, another container still needs a trucker? Keep going.
    const { loadBookings } = require('../helpers/json');
    const { migrate, nextUnassignedContainer } = require('../helpers/containers');
    const fresh = migrate(loadBookings()[bkgNo]);
    const next = fresh ? nextUnassignedContainer(fresh, 'trucker') : null;
    if (next) {
        await _send(chatId, `${bkgNo} has another container (seq ${next.seq}) still needing a trucker — continuing.`);
        return proceedToSupplier(chatId, bkgNo, port, fresh.containers.length > 1 ? next.seq : null);
    }
    return result;
}

// Dual-role case: one party handles both ends of ONE container. One
// message, not two redundant ones. Expectation is set explicitly: they
// report back ONCE, with the scale ticket, once that container is picked up
// and heading back to port — not through each intermediate stage separately
// like a normal trucker/supplier pairing would.
async function executeCombinedAssignment(chatId, bkgNo, supplierRecord, truckerRecord, containerSeq) {
    const { booking } = getBooking(bkgNo);
    if (!booking) { await _send(chatId, `Booking ${bkgNo} disappeared — check dashboard.`); return { action_taken: 'not_found' }; }

    const digits = (v) => String(v || '').replace(/\D/g, '');
    const chat = truckerRecord.group_id || (truckerRecord.whatsapp ? digits(truckerRecord.whatsapp) + '@c.us' : null)
              || supplierRecord.group_id || (supplierRecord.whatsapp ? digits(supplierRecord.whatsapp) + '@c.us' : null);
    if (!chat) { await _send(chatId, `${truckerRecord.name} has no WhatsApp/group on file — can't send.`); return { action_taken: 'no_destination' }; }

    const label = containerSeq != null ? `${bkgNo}/${containerSeq}` : bkgNo;
    await _send(chat,
        [`New booking — ${label}`, '', formatBookingForForward(booking), '',
         `You're handling both material and trucking on this one — no separate handoff needed.`,
         `Just share the scale ticket once the container is picked up and heading back to port.`].join('\n'));

    // Per-container write when this booking actually has multiple containers —
    // mirrors the exact pattern executeAssign/executeForward already use, so
    // a dual-role assignment on container 2 doesn't clobber container 1's data.
    // ALWAYS runs — see executeForward's fix for the full reasoning.
    {
        const { mutateJson } = require('../helpers/json');
        const { migrate } = require('../helpers/containers');
        const targetSeq = containerSeq ?? 1;
        await mutateJson(cfg.BOOKINGS_FILE, {}, all => {
            if (!all[bkgNo]) return all;
            all[bkgNo] = migrate(all[bkgNo]);
            const c = all[bkgNo].containers.find(x => x.seq === targetSeq);
            if (c) { c.supplier = supplierRecord.name; c.trucker = truckerRecord.name; c.stage = 'forwarded'; }
            return all;
        });
    }

    const { bookingStage } = require('../helpers/containers');
    const { loadBookings } = require('../helpers/json');
    const fresh = loadBookings()[bkgNo];
    const topStage = fresh ? bookingStage(fresh) : 'forwarded';

    await updateWorkflow(bkgNo, {
        step             : topStage,
        supplier         : supplierRecord.name,             // legacy top-level fields — kept for existing readers
        trucker_name     : truckerRecord.name,
        trucker_group_id : truckerRecord.group_id || chat,
        dual_role        : true, // flags this booking for adapted status expectations
        assigned_at      : new Date().toISOString(),
        forwarded_at     : new Date().toISOString(),
    });

    await _send(chatId, `${label}: ${supplierRecord.name} is handling both supplier and trucker roles — one combined message sent.`);
    _pushAlert({ type: 'assigned', bkgNo, message: `${label} assigned to ${supplierRecord.name} (dual-role — supplier+trucker)`, severity: 'info' });
    return { action_taken: 'dual_role_assigned' };
}

async function resolvePending(chatId, pending, answer, selection) {
if (answer === 'no') {
    await clearPending(chatId);
    // A rejection on a forward/assign confirmation resets that specific
    // pattern's trust streak — only these two types are trust-eligible.
    if (pending.type === 'confirm_forward') await trust.recordRejection('forward', pending.trucker_name);
    if (pending.type === 'confirm_assign')  await trust.recordRejection('assign', pending.supplier_name);
    await _send(chatId, 'Cancelled.');
    return { action_taken: 'cancelled_pending' };
}

switch (pending.type) {
    case 'select_trucker':
        await clearPending(chatId);
        return forwardBooking(chatId, pending.bkg_no, selection, pending.container_seq); // → confirm step
    case 'select_supplier':
        await clearPending(chatId);
        return assignSupplier(chatId, pending.bkg_no, selection, pending.container_seq);
    case 'confirm_forward':
        await clearPending(chatId);
        await trust.recordApproval('forward', pending.trucker_name);
        return executeForward(chatId, pending.bkg_no, pending.trucker_name, pending.container_seq);
    case 'confirm_assign':
        await clearPending(chatId);
        await trust.recordApproval('assign', pending.supplier_name);
        return executeAssign(chatId, pending.bkg_no, pending.supplier_name, pending.container_seq);
    case 'confirm_recall':
        await clearPending(chatId);
        return executeRecall(chatId, pending.bkg_no);
    case 'await_email_confirm':
        await clearPending(chatId);
        return sendDraftedEmail(chatId, pending);

    // Daily guided trucker-assignment wizard — see wizardAdvance above.
    case 'wizard_start':
    case 'wizard_await_port':
    case 'wizard_await_booking':
    case 'wizard_await_supplier':
    case 'wizard_await_trucker':
    case 'wizard_confirm':
        return wizardAdvance(chatId, pending, answer, selection);

    // Phase 4a: trucker/supplier selecting which booking their state message applied to.
    // Answer is a number (1/2/…) or the booking number itself.
    case 'awaiting_booking_selection': {
        const opts = pending.booking_options || [];
        const raw = String(answer || selection || '').trim();
        let picked = null;
        const asNum = parseInt(raw, 10);
        if (!isNaN(asNum) && asNum >= 1 && asNum <= opts.length) picked = opts[asNum - 1];
        else picked = opts.find(o => o.toLowerCase() === raw.toLowerCase()) || null;
        if (!picked) {
            await _send(chatId, `Didn't recognise that. Reply with 1..${opts.length} or the booking number.`);
            return { action_taken: 'awaiting_booking_selection' };
        }
        await clearPending(chatId);
        // Now check within the picked booking how many containers of this person still need this action.
        // If just 1 → fire directly. If 2+ → ask which container.
        const containers = require('../helpers/containers');
        const { loadBookings } = require('../helpers/json');
        const b = loadBookings()[picked];
        const stagesForIntent = {
            empty_drop_confirmed  : ['forwarded'],
            picked_up_confirmed   : ['load_ready'],
            scale_ticket_received : ['picked_up'],
            ingate_received       : ['picked_up'],
            load_ready_received   : ['supplier_assigned', 'empty_dropped'],
        };
        const kind = pending.person_kind || 'trucker';
        const stageWhitelist = stagesForIntent[pending.intent_to_resolve] || [];
        const matches = (b?.containers || []).filter(c =>
            c[kind] && String(c[kind]).toLowerCase() === String(pending.person_name || '').toLowerCase() &&
            stageWhitelist.includes(c.stage || 'not_started')
        );
        if (matches.length === 0) {
            await _send(chatId, `Nothing to update on ${picked} — no containers waiting for that action.`);
            return { action_taken: 'noop' };
        }
        if (matches.length === 1) {
            return fireResolvedStateIntent(pending.intent_to_resolve, picked, matches[0].seq, pending.person_name, pending.has_media);
        }
        // 2+ containers → cascade to container selection.
        return askWhichContainer(chatId, {
            bkg_no            : picked,
            intent_to_resolve : pending.intent_to_resolve,
            has_media         : pending.has_media,
            container_options : matches.map(c => c.seq),
        });
    }

    // Phase 4a: trucker/supplier picking which container of a known booking.
    case 'awaiting_container_selection': {
        const opts = pending.container_options || [];
        const raw = String(answer || selection || '').trim();
        const seq = parseInt(raw, 10);
        if (isNaN(seq) || !opts.includes(seq)) {
            await _send(chatId, `Didn't recognise that. Reply with one of: ${opts.join(', ')}.`);
            return { action_taken: 'awaiting_container_selection' };
        }
        await clearPending(chatId);
        // person_name is derived from chatId at fire time — but we didn't stash it here.
        // We rely on the state handlers not needing it (they use byName only for team-notify text).
        return fireResolvedStateIntent(pending.intent_to_resolve, pending.bkg_no, seq, null, pending.has_media);
    }

    default:
        await clearPending(chatId);
        return { action_taken: 'unknown_pending_cleared' };
}
}

// ── Phase 3a: whitelist info queries (trucker/supplier can ask ERD / cutoff) ─
async function showErd(chatId, bkgNo) {
const b = loadBookings()[bkgNo];
if (!b) { await _send(chatId, `Booking ${bkgNo} not found.`); return { action_taken: 'replied' }; }
await _send(chatId, `ERD for ${bkgNo}: ${b.erd_date || 'not set'}`);
return { action_taken: 'replied' };
}
async function showCutoff(chatId, bkgNo) {
const b = loadBookings()[bkgNo];
if (!b) { await _send(chatId, `Booking ${bkgNo} not found.`); return { action_taken: 'replied' }; }
await _send(chatId, `Cutoff for ${bkgNo}: ${b.cutoff_date || 'not set'}`);
return { action_taken: 'replied' };
}
function getBookingField(bkgNo, field) {
return loadBookings()?.[bkgNo]?.[field] || null;
}

// ── Follow-up scheduler — "please follow up with X in N minutes" ────────────
// Resolves target name to trucker/supplier (falls back to manager if neither
// matches — e.g. "follow up with the port" isn't a contact, tell the manager
// rather than silently dropping the request). Reuses the existing persistent
// task queue (helpers/tasks.js) — same infra as nudge_* tasks, survives restart.
async function scheduleFollowup(chatId, targetName, minutes, bkgNo, requestedBy) {
const tasks = require('../helpers/tasks');
const name = String(targetName || '').trim();

let target_kind = null, resolvedName = name;
const t = await truckers.getTrucker(name);
const s = !t ? await suppliers.getSupplier(name) : null;
if (t)      { target_kind = 'trucker';  resolvedName = t.name; }
else if (s) { target_kind = 'supplier'; resolvedName = s.name; }

if (!target_kind) {
    await _send(chatId, `I don't have a contact named "${name}". Check the spelling or add them from the dashboard first.`);
    return { action_taken: 'replied' };
}

const mins = Number.isFinite(minutes) && minutes > 0 ? minutes : 30; // default 30 min if unspecified
const fireAt = new Date(Date.now() + mins * 60 * 1000).toISOString();
const label = bkgNo ? ` re ${bkgNo}` : '';
const message = bkgNo
    ? `Following up${label} — any update on status?`
    : `Following up — any update?`;

await tasks.enqueue({
    type: 'generic_message',
    target_kind,
    target_name: resolvedName,
    bkg_no: bkgNo || null,
    message,
    fire_at: fireAt,
    created_by: requestedBy || 'brain',
});

const when = mins >= 60 ? `${Math.round(mins / 60 * 10) / 10}h` : `${mins}m`;
await _send(chatId, `Scheduled — I'll follow up with ${resolvedName} in ${when}${label}.`);
return { action_taken: 'replied' };
}

// ── Escalation — trucker/supplier said something the policy layer and the
// AI fallback both couldn't classify. Per manager rule: never leave it
// silent — a real reply sitting unread looks like Jarvis ignoring people.
// Forward the raw text to the manager with sender + booking context so a
// human can decide, instead of guessing.
async function escalateUnclear(ctx) {
const who = ctx.matchedTrucker?.name || ctx.matchedSupplier?.name || ctx.senderName || ctx.senderNumber || 'Unknown sender';
const kind = ctx.isTrucker ? 'Trucker' : ctx.isSupplier ? 'Supplier' : 'Contact';
const bkgLabel = ctx.activeBooking ? ` (re ${ctx.activeBooking})` : '';
await _sendToManager(`${kind} ${who}${bkgLabel} sent something I couldn't understand: "${ctx.text}"`);
return { action_taken: 'escalated' };
}

// ── Feedback loop — "remember X" or an AI-detected correction ───────────────
// Persists to facts.json (already fed into every AI prompt, last 15 — see
// helpers/context.js formatForAI). This is how corrections and standing
// instructions survive across conversations without a code change: no
// retraining happens, this is durable prompt-context, not model weights.
async function rememberFact(chatId, text) {
const clean = String(text || '').trim();
if (!clean) { await _send(chatId, "What should I remember?"); return { action_taken: 'replied' }; }
await addFact(clean);
await _send(chatId, `Got it — I'll remember: "${clean}"`);
return { action_taken: 'fact_stored' };
}

// ── Business context — durable, non-correction situational notes. Separate
// store from facts.json (see helpers/memory.js for the distinction).
async function addBusinessContext(chatId, text) {
const clean = String(text || '').trim();
if (!clean) { await _send(chatId, "What's the context note?"); return { action_taken: 'replied' }; }
await memory.addBusinessContext(clean);
await _send(chatId, `Noted for context: "${clean}"`);
return { action_taken: 'context_stored' };
}

// ── Price list — "send price list to X" from brain.js ───────────────────────
async function sendPriceListTo(chatId, targetNameOrNumber) {
const pricelist = require('../helpers/pricelist');
const result = await pricelist.sendPriceListTo(targetNameOrNumber);
if (!result.ok && result.reason === 'not_found') {
    await _send(chatId, `Couldn't find a saved contact or valid number for "${targetNameOrNumber}". Add them via /api/pricelist/contacts first, or give me a full WhatsApp number.`);
    return { action_taken: 'not_found' };
}
await _send(chatId, result.ok ? `Price list sent to ${result.target}.` : `Send to ${result.target} failed — check WhatsApp connection.`);
return { action_taken: result.ok ? 'pricelist_sent' : 'send_failed' };
}

// ── Price list — single-city send, "send price list" asks which city first ─
async function sendPriceListCity(chatId, city, targetNameOrNumber) {
const pricelist = require('../helpers/pricelist');
const result = await pricelist.sendPriceListCityTo(targetNameOrNumber, city, chatId);
if (!result.ok && result.reason === 'not_found') {
    await _send(chatId, `Couldn't find a saved contact or valid number for "${targetNameOrNumber}". Add them via /api/pricelist/contacts first, or give me a full WhatsApp number.`);
    return { action_taken: 'not_found' };
}
await _send(chatId, result.ok ? `${city} price list sent to ${result.target}.` : `Send to ${result.target} failed — check WhatsApp connection.`);
return { action_taken: result.ok ? 'pricelist_sent' : 'send_failed' };
}

// ── Menu option 4 / "check supplier BKG123" — manager wants to know if a
// container is ready for pickup. Pings the supplier directly with a yes/no
// question and holds a pending state ON THE SUPPLIER'S CHAT (not the manager's)
// so their reply routes correctly regardless of role — see brain.js section A0.
async function checkSupplierReadiness(managerChatId, bkgNo, containerSeq) {
const b = loadBookings()[bkgNo];
if (!b) { await _send(managerChatId, `Booking ${bkgNo} not found.`); return { action_taken: 'replied' }; }
const supplierChat = await suppliers.getSupplierGroupIdForBooking(bkgNo);
if (!supplierChat) { await _send(managerChatId, `${bkgNo} has no supplier assigned yet — nothing to check.`); return { action_taken: 'replied' }; }

const label = containerSeq != null ? `${bkgNo}/${containerSeq}` : bkgNo;
await _send(supplierChat, `${label}: checking in — is the container ready for pickup? Reply yes or no.`);
await setPending(supplierChat, { type: 'await_ready_check', stage: 'yesno', bkg_no: bkgNo, container_seq: containerSeq ?? null, requested_by: managerChatId });
await _send(managerChatId, `Pinged the supplier on ${label} — I'll let you know what they say.`);
return { action_taken: 'replied' };
}

async function resolveReadyCheckYes(supplierChatId, pending) {
const { bkg_no, container_seq, requested_by } = pending;
await clearPending(supplierChatId);
const supplierName = (await suppliers.matchSupplierByChat(supplierChatId))?.name || 'Supplier';
await _send(supplierChatId, `Thanks — noted.`);
// Feed straight into the real state machine (same as the organic "load ready"
// keyword flow) so this check-in actually advances the booking, not just chat.
const result = await loadReadyReceived(bkg_no, supplierName, container_seq);
const label = container_seq != null ? `${bkg_no}/${container_seq}` : bkg_no;
const notifyTo = requested_by || (cfg.getManagerNumber() ? cfg.getManagerNumber() + '@c.us' : null);
if (notifyTo) await _send(notifyTo, `${label}: supplier confirmed READY for pickup. Trucker notified.`);
return result;
}

async function resolveReadyCheckNo(supplierChatId, pending) {
await setPending(supplierChatId, { ...pending, stage: 'date' });
await _send(supplierChatId, `Got it — when do you expect it to be ready?`);
return { action_taken: 'replied' };
}

async function resolveReadyCheckDate(supplierChatId, pending, dateText) {
const { bkg_no, container_seq, requested_by } = pending;
await clearPending(supplierChatId);
const supplierName = (await suppliers.matchSupplierByChat(supplierChatId))?.name || 'Supplier';
const label = container_seq != null ? `${bkg_no}/${container_seq}` : bkg_no;
await _send(supplierChatId, `Thanks, noted.`);
// Surface on the dashboard's existing pending/owner display (decorateBooking
// in api.js already reads wf.pending_note / wf.pending_owner when set).
await updateWorkflow(bkg_no, { pending_note: `Supplier expects ready: ${dateText}`, pending_owner: supplierName });
const notifyTo = requested_by || (cfg.getManagerNumber() ? cfg.getManagerNumber() + '@c.us' : null);
if (notifyTo) await _send(notifyTo, `${label}: NOT ready yet — supplier expects it ready ${dateText}.`);
await _pushAlert({ type: 'ready_check_delayed', bkgNo: bkg_no, message: `${label}: supplier says not ready — expected ${dateText}`, severity: 'info' });
return { action_taken: 'replied' };
}

// ── Container number capture — no fixed format for these (confirmed by
// Apsara), so the pending itself IS the validation: whatever they reply to
// the "what's the container number?" question is stored verbatim. Notifies
// the manager since this is the one thing actually needed mid-process from
// a dual-role contact.
async function recordContainerNumber(chatId, pending, containerNumber) {
const { bkg_no } = pending;
await clearPending(chatId);
const clean = String(containerNumber || '').trim();
if (!clean) { await _send(chatId, "Didn't catch that — what's the container number?"); await setPending(chatId, pending); return { action_taken: 'replied' }; }

await updateWorkflow(bkg_no, { container_number: clean });
await _send(chatId, `Got it, thanks.`);
const notifyTo = cfg.getManagerNumber() ? cfg.getManagerNumber() + '@c.us' : null;
if (notifyTo) await _send(notifyTo, `${bkg_no}: container number received — ${clean}.`);
await _pushAlert({ type: 'container_number', bkgNo: bkg_no, message: `${bkg_no}: container number ${clean}`, severity: 'info' });
return { action_taken: 'container_number_recorded' };
}

// ── Relay a question to a trucker/supplier and remember to relay their
// answer back — "ask_contact" from brain.js. Without this, a relayed
// question has no way to correctly interpret the reply when it comes back;
// it just lands as an unrelated ambiguous message (this was the actual bug
// behind "why isn't it taking yes" — the AI could send a question but had
// no built-in way to remember it was expecting an answer to it specifically).
// Maps a relayed question to a KNOWN state transition, if the question is
// clearly about one — matches the same keyword logic driving the organic
// (unprompted) trucker/supplier state-transition detection elsewhere in this
// file, just applied to what the MANAGER asked rather than what the contact
// volunteered. A clear "yes" in direct response to one of these is exactly
// as unambiguous as the contact saying it unprompted — no reason to require
// a human to manually process what the state machine already handles.
function detectExpectedIntent(question) {
    const q = String(question || '').toLowerCase();
    if (/empty.{0,15}(drop|deliver)/.test(q) || /(drop|deliver).{0,15}empty/.test(q)) return 'empty_drop_confirmed';
    if (/load.{0,10}ready/.test(q)) return 'load_ready_received';
    if (/pick(ed)?.{0,10}up/.test(q)) return 'picked_up_confirmed';
    if (/scale.{0,10}ticket/.test(q)) return 'scale_ticket_received';
    if (/ingate|in.gate/.test(q)) return 'ingate_received';
    return null; // genuinely open-ended question — always just relay, never guess
}

async function relayQuestionToContact(managerChatId, targetName, question, bkgNo) {
const clean = String(question || '').trim();
if (!targetName || !clean) {
    await _send(managerChatId, "Who should I ask, and what should I ask them?");
    return { action_taken: 'replied' };
}

const t = await truckers.getTrucker(targetName);
const s = !t ? await suppliers.getSupplier(targetName) : null;
if (!t && !s) {
    await _send(managerChatId, `I don't have a contact named "${targetName}". Check the spelling or add them from the dashboard first.`);
    return { action_taken: 'not_found' };
}
const contact = t || s;
const targetChat = t
    ? await truckers.getTruckerChatId(contact.name)
    : await suppliers.getSupplierChatId(contact.name);
if (!targetChat) {
    await _send(managerChatId, `${contact.name} has no WhatsApp number or group on file — can't reach them.`);
    return { action_taken: 'no_destination' };
}

const bkgLabel = bkgNo ? ` (re ${bkgNo})` : '';
await _send(targetChat, `${clean}${bkgLabel}`);
const expectedIntent = detectExpectedIntent(clean);
await setPending(targetChat, { type: 'await_relay_reply', relay_to: managerChatId, bkg_no: bkgNo || null, question: clean, asked_of: contact.name, expected_intent: expectedIntent });
await _send(managerChatId, `Asked ${contact.name}${bkgLabel} — I'll let you know what they say.`);
return { action_taken: 'relayed' };
}

// Their reply comes back here — relay it to whoever originally asked,
// verbatim, with enough context to be useful (who, re what booking, re what
// question). Deliberately does NOT try to guess and auto-fire a workflow
// state transition from the reply — that's a separate, more consequential
// decision than just getting an answer back to a person who asked a question.
const YES_WORDS = new Set(['yes', 'yep', 'yeah', 'yup', 'done', 'dropped', 'ok', 'okay', 'confirmed', 'correct', 'y']);
const NO_WORDS  = new Set(['no', 'nope', 'not yet', 'nah', 'n']);

async function relayReplyReceived(targetChatId, pending, replyText) {
const { relay_to, bkg_no, question, asked_of, expected_intent } = pending;
await clearPending(targetChatId);
const clean = String(replyText || '').trim();
const lower = clean.toLowerCase();
const bkgLabel = bkg_no ? ` (re ${bkg_no})` : '';

// Known transition + booking number known + a clear yes → fire it directly,
// same as if the contact had said "empty dropped" unprompted. Anything less
// certain (a "no", free text, or no mapped intent at all) falls back to
// just relaying — never guess when it's not this clear-cut.
if (expected_intent && bkg_no && YES_WORDS.has(lower)) {
    await _send(targetChatId, `Thanks — noted.`);
    const result = await fireResolvedStateIntent(expected_intent, bkg_no, null, asked_of, false);
    await _send(relay_to, `${asked_of || 'Contact'}${bkgLabel} confirmed: ${question} → Yes. Status updated.`);
    return result;
}
if (expected_intent && bkg_no && NO_WORDS.has(lower)) {
    await _send(targetChatId, `Got it, thanks.`);
    await _send(relay_to, `${asked_of || 'Contact'}${bkgLabel} replied to "${question}": ${clean}`);
    return { action_taken: 'relay_reply_forwarded' };
}

// Anything else — genuinely open-ended question, or a reply that isn't a
// clean yes/no — just relay it, don't guess.
await _send(targetChatId, `Thanks, relayed.`);
await _send(relay_to, `${asked_of || 'Contact'}${bkgLabel} replied to "${question}": ${clean}`);
return { action_taken: 'relay_reply_forwarded' };
}

// ── Knowledge-gap log — manager asked something Jarvis genuinely couldn't
// answer (not missing grammar, missing DATA/KNOWLEDGE). Flags to two places:
// (1) WhatsApp to the manager, so it's seen immediately, not just archived;
// (2) dashboard alert log ('info' severity — visible on Needs Attention rail
// without also paging via alerts.js's high-severity auto-notify path).
// This is the visibility half of "self-learning": Apsara reviews recurring
// gaps and decides whether to add a fact, a deterministic command, or new
// context — a human-in-the-loop improvement cycle, not an automatic one.
async function logKnowledgeGap(ctx, reasoning, notifyTeam = true) {
const bkgLabel = ctx.activeBooking ? ` (re ${ctx.activeBooking})` : '';
const note = reasoning || "couldn't answer from available data/knowledge";
await _pushAlert({
    type: 'knowledge_gap',
    bkgNo: ctx.activeBooking || null,
    message: `Manager asked: "${ctx.text}" — ${note}`,
    severity: 'info',
});
// Manager's own unanswered question doesn't need a separate WhatsApp ping
// back to themselves — they already got the direct reply and see the
// failure firsthand. WhatsApp escalation is reserved for trucker/supplier
// messages (see escalateUnclear), where the manager genuinely wasn't there.
if (notifyTeam) {
    try {
        await _sendToTeam(`Jarvis couldn't answer${bkgLabel}: "${ctx.text}" — ${note}. Logged for review.`);
    } catch (e) { console.error('[ACTIONS] gap notify failed:', e.message); }
}
}

async function resolveFactBatch(chatId, pending, selection) {
await clearPending(chatId);
const candidates = pending.candidates || [];
let toAdd = [];
if (selection === 'all') toAdd = candidates;
else if (Array.isArray(selection)) toAdd = selection.filter(n => n >= 1 && n <= candidates.length).map(n => candidates[n - 1]);

if (!toAdd.length) {
    await _send(chatId, 'No changes made.');
    return { action_taken: 'fact_batch_declined' };
}
for (const fact of toAdd) {
    await addFact(fact);
}
await _send(chatId, `Added ${toAdd.length} fact${toAdd.length === 1 ? '' : 's'}:\n${toAdd.map(f => `- ${f}`).join('\n')}`);
return { action_taken: 'fact_batch_confirmed' };
}

// ── Manager-initiated outbound email ("email Zimex about DALA123's cutoff") ──
// Two-step: draft here (staged as a pending confirmation, nothing sent yet),
// actual send only happens from resolvePending's 'await_email_confirm' case
// once the manager replies yes. This is the ONLY outbound-email path in the
// app — Jarvis never sends mail on its own initiative, only when explicitly
// instructed, and never without this confirm step in between. A wrong
// auto-send is visible to a third party outside our own systems (unlike a
// bad bookings.json write, which is just a dashboard field to correct), so
// this is deliberately NOT in SAFE_ACTIONS-style auto-execute territory.
// Cc/Bcc are dashboard-editable (Settings → Outbound email), applied to
// EVERY email Jarvis drafts, compose or reply — see helpers/json.js's
// loadSettings default shape. Read fresh each time (not cached) so a
// mid-day settings change takes effect on the very next draft. Shown in
// the manager-facing preview so nothing gets copied to a third party the
// manager didn't expect — same "no silent surprises" posture as the rest
// of this app.
function ccBccFromSettings() {
    const settings = cfg.getSettings ? cfg.getSettings() : {};
    return { cc: (settings.email_cc || '').trim() || null, bcc: (settings.email_bcc || '').trim() || null };
}
function ccBccPreviewLine({ cc, bcc }) {
    const lines = [];
    if (cc) lines.push(`Cc: ${cc}`);
    if (bcc) lines.push(`Bcc: ${bcc}`);
    return lines.length ? lines.join('\n') + '\n' : '';
}

// Loose but real check — catches Gemini hallucinating something that isn't
// an email address at all (garbled forward text, a phone number, "n/a",
// etc.) BEFORE it gets staged for the manager to approve. Without this, a
// bad address only surfaces as a raw Gmail API error at actual send time,
// after the manager already said yes.
function isValidEmail(addr) {
    return typeof addr === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr.trim());
}

async function draftEmailForConfirm(chatId, targetName, details, bkgNo) {
    if (!targetName) {
        await _send(chatId, 'Email who? Give me a name or company, e.g. "email Zimex about DALA123 cutoff".');
        return { action_taken: 'email_missing_target' };
    }
    const { getGmailRead, findLatestFrom } = require('../helpers/gmail');
    const { callGeminiJSON } = require('../helpers/gemini');

    let gmail;
    try {
        gmail = getGmailRead();
    } catch (err) {
        await _send(chatId, `Can't draft that — Gmail isn't configured (${err.message}).`);
        return { action_taken: 'email_gmail_unavailable' };
    }

    let to;
    try {
        to = await findLatestFrom(gmail, targetName);
    } catch (err) {
        console.error('[ACTIONS] findLatestFrom failed:', err.message);
    }
    if (to && !isValidEmail(to)) {
        console.warn(`[ACTIONS] findLatestFrom resolved a non-address for "${targetName}": "${to}" — discarding`);
        to = null;
    }
    if (!to) {
        await _send(chatId, `Couldn't find a past email from "${targetName}" to reply to — no address to send to. Give me the exact email address instead.`);
        return { action_taken: 'email_no_address' };
    }

    const bkg = bkgNo ? getBooking(bkgNo) : null;
    const bookingLine = bkg
        ? `Booking ${bkg.booking_number}: carrier ${bkg.carrier || '—'}, ERD ${bkg.erd_date || '—'}, cutoff ${bkg.cutoff_date || '—'}, POL ${bkg.port_of_loading || '—'}, POD ${bkg.port_of_discharge || '—'}.`
        : '';
    const prompt = `Draft a short, professional freight-ops email from Edge Metals Inc. to a carrier/vendor contact.
Recipient: ${targetName}
What the email needs to say: ${details || '(no further detail given — infer a reasonable, brief request from context)'}
${bookingLine ? `Relevant booking data (use only what's relevant, do not dump all of it): ${bookingLine}` : ''}
Return ONLY this JSON: { "subject": "short subject line", "body": "email body, plain text, no markdown, sign off as Edge Metals Inc." }`;

    const draft = await callGeminiJSON(prompt);
    if (!draft || !draft.subject || !draft.body) {
        await _send(chatId, "Couldn't draft that email — try rephrasing what it should say.");
        return { action_taken: 'email_draft_failed' };
    }

    const { cc, bcc } = ccBccFromSettings();
    const staged = await setPending(chatId, {
        type: 'await_email_confirm',
        to, cc, bcc, subject: draft.subject, body: draft.body,
        target_name: targetName, bkg_no: bkgNo || null,
    });
    if (staged.queued) {
        // Don't show a live "Send this? (yes/no)" prompt for something that
        // isn't actually the active pending yet — see setPending's own
        // comment for why silently overwriting the real one is worse.
        await _send(chatId,
            `Drafted the email to ${targetName} <${to}> — but you have a pending "${staged.blockedBy}" to answer first. I'll ask you to confirm sending this once that's resolved.`
        );
        return { action_taken: 'email_draft_queued' };
    }
    await _send(chatId,
        `Draft email to ${targetName} <${to}>:\n${ccBccPreviewLine({ cc, bcc })}\nSubject: ${draft.subject}\n\n${draft.body}\n\nSend this? (yes/no)`
    );
    return { action_taken: 'email_draft_staged' };
}

// Only ever called from resolvePending after an explicit "yes" — see the
// 'await_email_confirm' case below. Never called directly from brain.js.
async function sendDraftedEmail(chatId, pending) {
    const { sendEmail } = require('../helpers/gmail');
    try {
        // inReplyTo/references are only present when this pending came from
        // draftReplyForConfirm (below) — undefined for a plain
        // draftEmailForConfirm compose, and buildMimeMessage already treats
        // those as "new thread, no reply headers." sendEmail sends via
        // apsara's account regardless — no threadId is ever passed, since a
        // threadId captured from bose's mailbox (where the original lived)
        // is meaningless on a different account's send.
        await sendEmail({
            to: pending.to, cc: pending.cc, bcc: pending.bcc, subject: pending.subject, body: pending.body,
            inReplyTo: pending.inReplyTo, references: pending.references,
        });
        await _send(chatId, `Sent to ${pending.target_name} <${pending.to}>.`);
        return { action_taken: 'email_sent' };
    } catch (err) {
        console.error('[ACTIONS] sendEmail failed:', err.message);
        await _send(chatId, `Send failed: ${err.message}. Not retried automatically — try again.`);
        return { action_taken: 'email_send_failed' };
    }
}

// ── Read-only mail search ("did Zimex reply about DALA123 cutoff") ──────────
// No pending/confirmation gate — unlike draft_email, this never changes
// anything or reaches a third party. It's the same risk class as any other
// "answer a question from data we have" action, just sourced from Gmail
// instead of bookings.json. Reuses "note" (already used by ask_contact for
// free-text) for the search topic instead of adding another schema field.
async function searchMail(chatId, targetName, note, bkgNo) {
    const { getGmailRead, listMessages, getMessage, getEmailContent } = require('../helpers/gmail');
    const { callGeminiJSON } = require('../helpers/gemini');

    let gmail;
    try {
        gmail = getGmailRead();
    } catch (err) {
        await _send(chatId, `Can't search — Gmail isn't configured (${err.message}).`);
        return { action_taken: 'search_mail_gmail_unavailable' };
    }

    const terms = [];
    if (targetName) terms.push(`from:${targetName}`);
    if (bkgNo) terms.push(bkgNo);
    if (note) terms.push(note);
    const q = terms.join(' ').trim();
    if (!q) {
        await _send(chatId, 'Search for what — a name, booking number, or keyword?');
        return { action_taken: 'search_mail_missing_query' };
    }

    let messages;
    try {
        messages = await listMessages(gmail, q, 5);
    } catch (err) {
        await _send(chatId, `Mail search failed: ${err.message}`);
        return { action_taken: 'search_mail_failed' };
    }
    if (!messages.length) {
        await _send(chatId, `No matching emails found${targetName ? ` from ${targetName}` : ''}${bkgNo ? ` about ${bkgNo}` : ''}${note && !bkgNo ? ` re "${note}"` : ''}.`);
        return { action_taken: 'search_mail_no_results' };
    }

    // Pull the top few, feed to Gemini for a direct answer instead of
    // dumping raw email metadata — the manager asked a QUESTION ("did they
    // reply"), not for a mail listing.
    const found = [];
    for (const m of messages.slice(0, 3)) {
        try {
            const full = await getMessage(gmail, m.id);
            const hdrs = Object.fromEntries((full.payload.headers || []).map((h) => [h.name, h.value]));
            const { body } = getEmailContent(full.payload);
            found.push({ from: hdrs.From, date: hdrs.Date, subject: hdrs.Subject, body: (body || '').slice(0, 1500) });
        } catch (err) {
            console.error('[ACTIONS] searchMail: failed to read a matched message:', err.message);
        }
    }
    if (!found.length) {
        await _send(chatId, 'Found matching emails but could not read their contents — check Gmail directly.');
        return { action_taken: 'search_mail_read_failed' };
    }

    const askedAbout = [targetName ? `whether ${targetName} replied` : null, note, bkgNo].filter(Boolean).join(' — ');
    const prompt = `The manager asked about their mailbox: "${askedAbout || q}"
Below are up to 3 matching emails (Gmail search results, not necessarily in relevance order). Answer the manager's question directly in 2-3 sentences, citing date and the relevant detail if you find it. If none of these actually answer the question, say so plainly instead of guessing.

EMAILS:
${found.map((d, i) => `--- Email ${i + 1} ---
From: ${d.from}
Date: ${d.date}
Subject: ${d.subject}
Body: ${d.body}`).join('\n\n')}

Return ONLY this JSON: { "answer": "direct answer, 2-3 sentences max" }`;

    const result = await callGeminiJSON(prompt);
    const answer = result?.answer || `Found ${found.length} matching email(s) but couldn't summarize them — check Gmail directly.`;
    await _send(chatId, answer);
    return { action_taken: 'search_mail_answered' };
}

// ── Reply within an existing thread ("reply to Zimex about DALA123: confirmed") ──
// Finds a REAL prior email to reply to and carries over its Message-ID/
// References, so the RECIPIENT's mail client threads it correctly even
// though the reply is sent from a different account than the one that
// received the original — see helpers/gmail.js's sendEmail for why
// threadId itself can't cross accounts and isn't used here.
//
// FORWARDED MAIL — a real, common case: if bose forwards a Zimex email to
// the read/write account, the message's actual From header is bose, not
// Zimex (that's just how Gmail forwarding works — Zimex's address only
// exists as quoted TEXT inside the forward's body, e.g. "---------- 
// Forwarded message ---------\nFrom: Zimex <...>"). Two consequences:
//   1. A from:targetName search alone won't find it — broadened below to
//      also match the name anywhere in the message (subject/body), which
//      picks up the quoted header text inside a forward.
//   2. Even once found, there's no real thread to reply into — a manual
//      forward doesn't expose Zimex's original Message-ID as a usable
//      header (Gmail only shows From/Date/Subject in the quoted block, not
//      Message-ID), so In-Reply-To/References would have nothing valid to
//      point at. In that case this composes a FRESH, non-threaded email to
//      an address pulled out of the forward's body via Gemini instead of
//      faking a thread reply it can't actually back up.
// Same confirm-before-send posture either way — stages via the SAME
// 'await_email_confirm' pending type sendDraftedEmail already handles.
async function draftReplyForConfirm(chatId, targetName, details, bkgNo) {
    if (!targetName) {
        await _send(chatId, 'Reply to who? Give me a name or company, e.g. "reply to Zimex about DALA123: confirmed".');
        return { action_taken: 'reply_missing_target' };
    }
    const { getGmailRead, listMessages, getMessage, getEmailContent } = require('../helpers/gmail');
    const { callGeminiJSON } = require('../helpers/gemini');

    let gmail;
    try {
        gmail = getGmailRead();
    } catch (err) {
        await _send(chatId, `Can't reply — Gmail isn't configured (${err.message}).`);
        return { action_taken: 'reply_gmail_unavailable' };
    }

    // Two passes, direct-first: a from:X search only ever matches a REAL
    // direct email — if that finds something, use it, don't even look at
    // the broader query. Only fall back to (from:X OR X) — which also
    // matches X merely quoted inside a forward's body — when no direct
    // email exists. Without this ordering, a genuine direct thread could
    // lose to an unrelated forward just because Gmail's own relevance
    // ranking on the combined OR query happened to rank the forward first.
    const bkgTerm = bkgNo ? ` ${bkgNo}` : '';
    let messages;
    try {
        messages = await listMessages(gmail, `from:${targetName}${bkgTerm}`, 3);
        if (!messages.length) {
            messages = await listMessages(gmail, `(from:${targetName} OR ${targetName})${bkgTerm}`, 3);
        }
    } catch (err) {
        await _send(chatId, `Couldn't search mail: ${err.message}`);
        return { action_taken: 'reply_search_failed' };
    }
    if (!messages.length) {
        // Deliberately doesn't fall back to composing a fresh email on its
        // own — "reply to" is a specific instruction about an EXISTING
        // thread; silently switching to a new one changes what the manager
        // asked for. Ask instead.
        await _send(chatId, `Couldn't find an email from ${targetName}${bkgNo ? ` about ${bkgNo}` : ''} to reply to. Want me to compose a new email instead?`);
        return { action_taken: 'reply_no_thread_found' };
    }

    const full = await getMessage(gmail, messages[0].id);
    const hdrs = Object.fromEntries((full.payload.headers || []).map((h) => [h.name, h.value]));
    const fromAddr = (hdrs.From || '').match(/<([^>]+)>/)?.[1] || hdrs.From;
    const origSubject = hdrs.Subject || '';
    const { body: origBody } = getEmailContent(full.payload);
    const { cc, bcc } = ccBccFromSettings();

    const bkg = bkgNo ? getBooking(bkgNo) : null;
    const bookingLine = bkg
        ? `Booking ${bkg.booking_number}: carrier ${bkg.carrier || '—'}, ERD ${bkg.erd_date || '—'}, cutoff ${bkg.cutoff_date || '—'}.`
        : '';

    // Is the message's ACTUAL sender the target, or does the target's name
    // just appear somewhere in a forwarded/quoted body? Header match =
    // direct email, real thread to reply into. No match = treat as a
    // forward (or any other indirect mention) and compose fresh instead.
    const isDirectSender = fromAddr && fromAddr.toLowerCase().includes(targetName.toLowerCase());

    if (!isDirectSender) {
        const extractPrompt = `This email may be a FORWARD containing an earlier message from "${targetName}". Find "${targetName}"'s email address as it appears in the forwarded/quoted content (often shown as "From: Name <address>" inside a "---------- Forwarded message ---------" block).
Email body:
${(origBody || '').slice(0, 3000)}
Return ONLY this JSON: { "address": "the email address, or null if you can't find one for ${targetName} specifically" }`;
        const extracted = await callGeminiJSON(extractPrompt);
        let foundAddr = extracted && extracted.address && extracted.address !== 'null' ? extracted.address : null;
        if (foundAddr && !isValidEmail(foundAddr)) {
            console.warn(`[ACTIONS] Forward-extraction returned a non-address for "${targetName}": "${foundAddr}" — discarding`);
            foundAddr = null;
        }

        if (!foundAddr) {
            await _send(chatId, `Found an email mentioning ${targetName}, but couldn't confidently pull their address out of it (likely a forward without a clean quoted header). Give me the exact email address instead.`);
            return { action_taken: 'reply_forward_no_address' };
        }

        const prompt = `Draft a short, professional freight-ops email from Edge Metals Inc. to ${targetName}. This is NOT a direct reply-in-thread — it's a fresh email prompted by a forwarded/quoted message, so don't reference "your email below" or similar framing the recipient won't recognize.
Forwarded content for context (may include other people's messages — use only what's relevant to ${targetName}):
${(origBody || '').slice(0, 1500)}

What this email needs to say: ${details || '(no further detail given — infer a reasonable, brief message from context)'}
${bookingLine ? `Relevant booking data (use only what's relevant): ${bookingLine}` : ''}
Return ONLY this JSON: { "subject": "short subject line", "body": "email body, plain text, no markdown, sign off as Edge Metals Inc." }`;
        const draft = await callGeminiJSON(prompt);
        if (!draft || !draft.subject || !draft.body) {
            await _send(chatId, "Couldn't draft that email — try rephrasing what it should say.");
            return { action_taken: 'reply_draft_failed' };
        }

        const staged = await setPending(chatId, {
            type: 'await_email_confirm',
            to: foundAddr, cc, bcc, subject: draft.subject, body: draft.body,
            // No inReplyTo/references — a manual forward doesn't carry a
            // usable Message-ID for the ORIGINAL sender, so there's nothing
            // real to thread against. This sends as a fresh conversation.
            target_name: targetName, bkg_no: bkgNo || null,
        });
        if (staged.queued) {
            await _send(chatId, `Drafted (via a forwarded email) to ${targetName} <${foundAddr}> — but you have a pending "${staged.blockedBy}" to answer first. I'll ask you to confirm sending this once that's resolved.`);
            return { action_taken: 'reply_via_forward_queued' };
        }
        await _send(chatId,
            `Found this via a forwarded email, not a direct thread — composing a NEW email (not threaded) to ${targetName} <${foundAddr}>:\n${ccBccPreviewLine({ cc, bcc })}\nSubject: ${draft.subject}\n\n${draft.body}\n\nSend this? (yes/no)`
        );
        return { action_taken: 'reply_via_forward_staged' };
    }

    // ── Direct email from the target — real thread-reply path ────────────
    const replySubject = /^re:/i.test(origSubject) ? origSubject : `Re: ${origSubject}`;
    const messageIdHeader = hdrs['Message-ID'] || hdrs['Message-Id'];
    const references = [hdrs.References, messageIdHeader].filter(Boolean).join(' ').trim();

    const prompt = `Draft a short, professional reply from Edge Metals Inc. to this email thread.
Original email — From: ${hdrs.From}, Subject: ${origSubject}
Original body: ${(origBody || '').slice(0, 1500)}

What the reply needs to say: ${details || '(no further detail given — infer a reasonable, brief reply from context)'}
${bookingLine ? `Relevant booking data (use only what's relevant): ${bookingLine}` : ''}
Return ONLY this JSON: { "body": "reply body, plain text, no markdown, sign off as Edge Metals Inc." }`;

    const draft = await callGeminiJSON(prompt);
    if (!draft || !draft.body) {
        await _send(chatId, "Couldn't draft that reply — try rephrasing what it should say.");
        return { action_taken: 'reply_draft_failed' };
    }

    const staged = await setPending(chatId, {
        type: 'await_email_confirm',
        to: fromAddr, cc, bcc, subject: replySubject, body: draft.body,
        // No threadId — belongs to whichever mailbox this was read from,
        // invalid/meaningless when sending via a different account.
        // inReplyTo/References are plain headers and cross accounts fine —
        // that's what actually threads it for the recipient.
        inReplyTo: messageIdHeader, references,
        target_name: targetName, bkg_no: bkgNo || null,
    });
    if (staged.queued) {
        await _send(chatId, `Drafted a reply to ${targetName} <${fromAddr}> — but you have a pending "${staged.blockedBy}" to answer first. I'll ask you to confirm sending this once that's resolved.`);
        return { action_taken: 'reply_draft_queued' };
    }
    await _send(chatId,
        `Reply to ${targetName} <${fromAddr}> (thread: "${origSubject}"):\n${ccBccPreviewLine({ cc, bcc })}\n${draft.body}\n\nSend this? (yes/no)`
    );
    return { action_taken: 'reply_draft_staged' };
}

module.exports = {
init,
setPending, clearPending, getPending, resolvePending, promoteQueued,
showMenu, showBookingsMenu, showBookingStatus, showContacts,
showBookingsAll, showBookingsUrgent, showBookingsAvailable, showBookingsWeek,
forwardBooking, executeForward,
assignSupplier, executeAssign,
emptyDropConfirmed, loadReadyReceived, pickedUpConfirmed, scaleTicketReceived, ingateReceived,
askWhichBooking, askWhichContainer, fireResolvedStateIntent,
recallBooking, executeRecall, archiveNow,
showErd, showCutoff, getBookingField,
scheduleFollowup, escalateUnclear, rememberFact, addBusinessContext, logKnowledgeGap, resolveFactBatch,
    draftEmailForConfirm, sendDraftedEmail, searchMail, draftReplyForConfirm,
checkSupplierReadiness, resolveReadyCheckYes, resolveReadyCheckNo, resolveReadyCheckDate, recordContainerNumber, sendPriceListTo, sendPriceListCity, relayQuestionToContact, relayReplyReceived, detectExpectedIntent,
};