// ── workflow/actions.js — Single execution gateway ───────────────────────────
// ONLY this file mutates workflow state and sends operational messages.
// brain.js decides, actions.js executes. Rules carried over from production:
//   - Supplier "load ready" → trucker directly, no manager approval.
//   - Loading photos are a side track — never block the main flow.
//   - Risky/irreversible actions go through pending confirmation (yes/no).

const { loadBookings, loadWorkflow, loadTruckers, loadSuppliers,
    mutateBrain, loadBrain, updateWorkflow, archiveBooking } = require('../helpers/json');
const { getBooking, formatBookingFull, formatBookingLine, formatBookingAvailable, formatBookingForForward,
    getUrgentBookings, getBookingsThisWeek, getAvailableBookings, stepLabel } = require('../helpers/booking');
const { getLATime, daysUntil } = require('../helpers/time');
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
async function setPending(chatId, action) {
await mutateBrain(b => {
    b.pending_actions[chatId] = {
        ...action,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + cfg.PENDING_EXPIRY_MS).toISOString(),
    };
});
}
async function clearPending(chatId) {
await mutateBrain(b => { delete b.pending_actions[chatId]; });
}
function getPending(chatId) {
return loadBrain().pending_actions[chatId] || null;
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
const t = loadTruckers().map(x => `- ${x.name}${x.group_id ? '' : ' (DM)'}`);
const s = loadSuppliers().map(x => `- ${x.name}${x.group_id ? '' : ' (DM)'}`);
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
    const sel = truckers.buildTruckerSelectionMessage(bkgNo);
    if (!sel.list.length) { await _send(chatId, sel.text); return { action_taken: 'no_truckers' }; }
    await setPending(chatId, { type: 'select_trucker', bkg_no: bkgNo, container_seq: targetContainer?.seq || null, options: sel.list.map(t => t.name) });
    await _send(chatId, sel.text);
    return { action_taken: 'awaiting_trucker_selection' };
}

const t = truckers.getTrucker(truckerName);
if (!t) { await _send(chatId, `Trucker "${truckerName}" not found. Type "forward ${bkgNo}" to pick from the list.`); return { action_taken: 'trucker_not_found' }; }

// Web Bot tab — skip yes/no confirm.
if (isWebSource()) {
    await clearPending(chatId);
    return executeForward(chatId, bkgNo, t.name, targetContainer?.seq || null);
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

const truckerChat = truckers.getTruckerChatId(truckerName);
const t           = truckers.getTrucker(truckerName);
const label       = containerSeq != null ? `${bkgNo}/${containerSeq}` : bkgNo;

await _send(truckerChat,
    [`New booking — ${label}`, '', formatBookingForForward(booking), '', 'Please confirm empty pickup and send the empty-drop photo when done.'].join('\n'));

// PDF side track — never blocks the forward
try {
    const { fetchPdfFromDrive } = require('../helpers/drive');
    const pdf = await fetchPdfFromDrive(bkgNo);
    if (pdf) await _send(truckerChat, null, pdf);
} catch (e) { console.log('[ACTIONS] PDF skip:', e.message); }

// Per-container: write trucker + stage onto the target container.
if (containerSeq != null) {
    const { mutateJson } = require('../helpers/json');
    const { migrate } = require('../helpers/containers');
    await mutateJson(cfg.BOOKINGS_FILE, {}, all => {
        if (!all[bkgNo]) return all;
        all[bkgNo] = migrate(all[bkgNo]);
        const c = all[bkgNo].containers.find(x => x.seq === containerSeq);
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
    const sel = suppliers.buildSupplierSelectionMessage(bkgNo);
    if (!sel.list.length) { await _send(chatId, sel.text); return { action_taken: 'no_suppliers' }; }
    await setPending(chatId, { type: 'select_supplier', bkg_no: bkgNo, container_seq: targetContainer?.seq || null, options: sel.list.map(s => s.name) });
    await _send(chatId, sel.text);
    return { action_taken: 'awaiting_supplier_selection' };
}

const s = suppliers.getSupplier(supplierName);
if (!s) { await _send(chatId, `Supplier "${supplierName}" not found.`); return { action_taken: 'supplier_not_found' }; }

// Web Bot tab — skip yes/no confirm, fire immediately.
if (isWebSource()) {
    await clearPending(chatId);
    return executeAssign(chatId, bkgNo, s.name, targetContainer?.seq || null);
}

await setPending(chatId, { type: 'confirm_assign', bkg_no: bkgNo, supplier_name: s.name, container_seq: targetContainer?.seq || null });
const label = targetContainer ? `${bkgNo}/${targetContainer.seq}` : bkgNo;
await _send(chatId, `Assign ${label} to ${s.name}? (yes/no)`);
return { action_taken: 'awaiting_confirmation' };
}

async function executeAssign(chatId, bkgNo, supplierName, containerSeq) {
const { booking } = getBooking(bkgNo);
if (!booking) return { action_taken: 'not_found' };

const supplierChat = suppliers.getSupplierChatId(supplierName);
const s            = suppliers.getSupplier(supplierName);
const label        = containerSeq != null ? `${bkgNo}/${containerSeq}` : bkgNo;

await _send(supplierChat,
    [`New assignment — ${label}`, '', formatBookingForForward(booking), '', 'Please confirm material readiness and share the target load date.'].join('\n'));

// Per-container: write supplier + stage onto the target container.
if (containerSeq != null) {
    const { mutateJson } = require('../helpers/json');
    const { migrate } = require('../helpers/containers');
    await mutateJson(cfg.BOOKINGS_FILE, {}, all => {
        if (!all[bkgNo]) return all;
        all[bkgNo] = migrate(all[bkgNo]);
        const c = all[bkgNo].containers.find(x => x.seq === containerSeq);
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
const supplierChat = suppliers.getSupplierGroupIdForBooking(bkgNo);
const label = containerSeq != null ? `${bkgNo}/${containerSeq}` : bkgNo;
if (supplierChat) await _send(supplierChat, `${label}: empty container dropped. Please start loading and reply "load ready" when done.`);
await _sendToTeam(`${label}: empty dropped (${byName || 'trucker'}).`);
await require('../helpers/tasks').cancelMatching({ type: 'nudge_empty_drop', bkg_no: bkgNo });
return { action_taken: 'empty_dropped' };
}

// Supplier → trucker DIRECTLY. No manager approval (established rule).
async function loadReadyReceived(bkgNo, byName, containerSeq) {
await advanceContainer(bkgNo, containerSeq, 'load_ready');
const topStep = (await syncWorkflowFromContainers(bkgNo)) || 'load_ready';
await updateWorkflow(bkgNo, { step: topStep, load_ready_at: new Date().toISOString() });
const truckerChat = truckers.getTruckerGroupIdForBooking(bkgNo);
const label = containerSeq != null ? `${bkgNo}/${containerSeq}` : bkgNo;
if (truckerChat) await _send(truckerChat, `${label}: load is READY for pickup. Please confirm your pickup window and send the scale ticket after pickup.`);
await _sendToTeam(`${label}: load ready (${byName || 'supplier'}). Trucker notified.`);
await require('../helpers/tasks').cancelMatching({ type: 'nudge_load_ready', bkg_no: bkgNo });
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
await tasksHelper.cancelMatching({ type: 'nudge_pickup', bkg_no: bkgNo });
if (hasScaleTicket) await tasksHelper.cancelMatching({ type: 'nudge_scale_ticket', bkg_no: bkgNo });
return { action_taken: 'picked_up' };
}

// Scale ticket arriving late (side track). Not a stage transition — just a flag.
async function scaleTicketReceived(bkgNo, containerSeq) {
// No container stage change — scale_ticket is a workflow-level flag today.
// (Future: could be per-container. Leaving as booking-level for now to match schema.)
await updateWorkflow(bkgNo, { scale_ticket: true, scale_ticket_at: new Date().toISOString() });
const label = containerSeq != null ? `${bkgNo}/${containerSeq}` : bkgNo;
await _sendToTeam(`${label}: scale ticket received.`);
await require('../helpers/tasks').cancelMatching({ type: 'nudge_scale_ticket', bkg_no: bkgNo });
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
await require('../helpers/tasks').cancelMatching({ type: 'nudge_ingate', bkg_no: bkgNo });
return { action_taken: 'ingated' };
}

// ── Recall / archive ──────────────────────────────────────────────────────────
async function recallBooking(chatId, bkgNo) {
await setPending(chatId, { type: 'confirm_recall', bkg_no: bkgNo });
await _send(chatId, `Recall ${bkgNo} from the trucker and reset to Not Started? (yes/no)`);
return { action_taken: 'awaiting_confirmation' };
}

async function executeRecall(chatId, bkgNo) {
const truckerChat = truckers.getTruckerGroupIdForBooking(bkgNo);
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
async function resolvePending(chatId, pending, answer, selection) {
if (answer === 'no') {
    await clearPending(chatId);
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
        return executeForward(chatId, pending.bkg_no, pending.trucker_name, pending.container_seq);
    case 'confirm_assign':
        await clearPending(chatId);
        return executeAssign(chatId, pending.bkg_no, pending.supplier_name, pending.container_seq);
    case 'confirm_recall':
        await clearPending(chatId);
        return executeRecall(chatId, pending.bkg_no);

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

module.exports = {
init,
setPending, clearPending, getPending, resolvePending,
showMenu, showBookingsMenu, showBookingStatus, showContacts,
showBookingsAll, showBookingsUrgent, showBookingsAvailable, showBookingsWeek,
forwardBooking, executeForward,
assignSupplier, executeAssign,
emptyDropConfirmed, loadReadyReceived, pickedUpConfirmed, scaleTicketReceived, ingateReceived,
askWhichBooking, askWhichContainer, fireResolvedStateIntent,
recallBooking, executeRecall, archiveNow,
showErd, showCutoff, getBookingField,
};