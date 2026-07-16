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
const { booking, status } = getBooking(bkgNo);
if (!booking) { await _send(chatId, `No booking found for ${bkgNo}.`); return { action_taken: 'not_found' }; }
// FIX (2026-07-16): getBooking() intentionally also returns archived records
// (needed for read-only status checks like showBookingStatus), but every
// mutation path must reject them explicitly — otherwise a closed booking
// gets forwarded, a real WhatsApp message goes to the trucker about a dead
// load, and updateWorkflow() auto-creates a phantom workflow.json entry for
// a booking that archiveBooking() already deleted from it.
if (status === 'archived') { await _send(chatId, `${bkgNo} is archived — can't forward. If this was closed by mistake, restore it from the dashboard first.`); return { action_taken: 'archived_blocked' }; }

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
const { booking, status } = getBooking(bkgNo);
if (!booking) { await _send(chatId, `Booking ${bkgNo} disappeared — check dashboard.`); return { action_taken: 'not_found' }; }
// FIX (2026-07-16): see forwardBooking() above — same guard needed here since
// this is also reached directly from resolvePending('confirm_forward') and
// the smart-assign path, both of which bypass forwardBooking()'s own check.
if (status === 'archived') { await _send(chatId, `${bkgNo} is archived — can't forward. Not notifying the trucker.`); return { action_taken: 'archived_blocked' }; }

const truckerChat = truckers.getTruckerChatId(truckerName);
const t           = truckers.getTrucker(truckerName);
const label       = containerSeq != null ? `${bkgNo}/${containerSeq}` : bkgNo;

const forwardMsg = [`New booking — ${label}`, '', formatBookingForForward(booking), '', 'Please confirm empty pickup and send the empty-drop photo when done.'].join('\n');
// FIX (2026-07-16): this send's result used to be discarded — if WhatsApp
// wasn't ready (still booting, reconnecting), the trucker silently never got
// notified while the manager saw a clean "forwarded to X" confirmation with
// no indication anything went wrong. Now captured and surfaced + auto-retried.
const truckerNotified = await _send(truckerChat, forwardMsg);

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

if (truckerNotified) {
    await _send(chatId, `${label} forwarded to ${truckerName}.`);
} else {
    await _send(chatId, `${label} forwarded to ${truckerName} in the system, but the WhatsApp notification to ${truckerName} did NOT go through (WhatsApp not connected). Queued for automatic retry — will notify them once reconnected.`);
    try {
        const tasks = require('../helpers/tasks');
        await tasks.enqueue({
            type: 'generic_message', target_kind: 'trucker', target_name: truckerName,
            bkg_no: bkgNo, container_seq: containerSeq, message: forwardMsg,
            fire_at: new Date(Date.now() + 60 * 1000).toISOString(),
            created_by: 'system_retry_forward',
        });
    } catch (e) { console.error('[ACTIONS] Failed to enqueue forward retry:', e.message); }
}
_pushAlert({ type: 'forwarded', bkgNo, message: `${label} forwarded to ${truckerName}${truckerNotified ? '' : ' (notification pending retry)'}`, severity: 'info' });
// FIX (2026-07-16): activeBooking used to only get set by showBookingStatus(),
// so "this"/"it" pronoun resolution (e.g. "assign this to Rudy") almost never
// had anything to resolve against right after a real action. Every
// booking-scoped action should refresh it.
updateSession(chatId, { activeBooking: bkgNo, currentTopic: 'forward' });
return { action_taken: 'forwarded' };
}

// ── Assign supplier ───────────────────────────────────────────────────────────
async function assignSupplier(chatId, bkgNo, supplierName, containerSeq) {
const { booking, status } = getBooking(bkgNo);
if (!booking) { await _send(chatId, `No booking found for ${bkgNo}.`); return { action_taken: 'not_found' }; }
if (status === 'archived') { await _send(chatId, `${bkgNo} is archived — can't assign a supplier. If this was closed by mistake, restore it from the dashboard first.`); return { action_taken: 'archived_blocked' }; }

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
const { booking, status } = getBooking(bkgNo);
if (!booking) { await _send(chatId, `Booking ${bkgNo} disappeared — check dashboard.`); return { action_taken: 'not_found' }; }
// FIX (2026-07-16): same archived guard as executeForward — reached directly
// from resolvePending('confirm_assign') and the smart-assign path, both of
// which bypass assignSupplier()'s own check. (Also fixed the previous silent
// return-with-no-message on a vanished booking while touching this block —
// executeForward already messaged the manager in that case, this didn't.)
if (status === 'archived') { await _send(chatId, `${bkgNo} is archived — can't assign a supplier. Not notifying anyone.`); return { action_taken: 'archived_blocked' }; }

const supplierChat = suppliers.getSupplierChatId(supplierName);
const s            = suppliers.getSupplier(supplierName);
const label        = containerSeq != null ? `${bkgNo}/${containerSeq}` : bkgNo;

const assignMsg = [`New assignment — ${label}`, '', formatBookingForForward(booking), '', 'Please confirm material readiness and share the target load date.'].join('\n');
// FIX (2026-07-16): same issue as executeForward above — the send result was
// discarded, so "WA not ready" silently dropped the supplier notification
// while the manager still saw a clean "assigned" confirmation. See the live
// example: 2026-07-16 boot log — assign fired 4.3s into startup, before the
// WhatsApp client was ready, and Rudy was never actually notified.
const supplierNotified = await _send(supplierChat, assignMsg);

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

if (supplierNotified) {
    await _send(chatId, `${label} assigned to ${supplierName}.`);
} else {
    await _send(chatId, `${label} assigned to ${supplierName} in the system, but the WhatsApp notification to ${supplierName} did NOT go through (WhatsApp not connected). Queued for automatic retry — will notify them once reconnected.`);
    try {
        const tasks = require('../helpers/tasks');
        await tasks.enqueue({
            type: 'generic_message', target_kind: 'supplier', target_name: supplierName,
            bkg_no: bkgNo, container_seq: containerSeq, message: assignMsg,
            fire_at: new Date(Date.now() + 60 * 1000).toISOString(),
            created_by: 'system_retry_assign',
        });
    } catch (e) { console.error('[ACTIONS] Failed to enqueue assign retry:', e.message); }
}
_pushAlert({ type: 'assigned', bkgNo, message: `${label} assigned to ${supplierName}${supplierNotified ? '' : ' (notification pending retry)'}`, severity: 'info' });
updateSession(chatId, { activeBooking: bkgNo, currentTopic: 'assign' });
return { action_taken: 'assigned' };
}

// ── Smart assign — "assign this/it to NAME" (2026-07-16) ──────────────────
// Spec from Apsara: resolve NAME against BOTH the trucker and supplier
// rosters, narrow multi-city name collisions by the booking's own port of
// loading, and — if NAME hits both rosters — use which role still has an
// open (unassigned) container on THIS booking to break the tie. Only ask the
// manager outright when that still doesn't resolve it. If the resolved
// role's containers are ALL already assigned (nothing pending), don't
// silently overwrite — confirm first, and show the current stage so a
// mid-flight reassignment (trucker already picked up, etc.) isn't invisible.
// Decisions locked in 2026-07-16: plain yes/no confirm regardless of stage
// (just surface the stage in the prompt, don't block); do NOT notify the
// outgoing trucker/supplier that they were replaced.
async function smartAssign(chatId, bkgNo, name) {
const { booking, status } = getBooking(bkgNo);
if (!booking) { await _send(chatId, `No booking found for ${bkgNo}.`); return { action_taken: 'not_found' }; }
if (status === 'archived') { await _send(chatId, `${bkgNo} is archived — can't assign. If this was closed by mistake, restore it from the dashboard first.`); return { action_taken: 'archived_blocked' }; }
if (!name) { await _send(chatId, 'Assign to whom? e.g. "assign this to Rudy".'); return { action_taken: 'no_name' }; }

const pol = booking.port_of_loading || '';
const narrowByLocality = (list) => {
    if (list.length <= 1) return list;
    const local = list.filter(x => suppliers.localityMatchesPort(x.locality, pol));
    return local.length ? local : list; // locality narrowed to nobody — better to ask than to silently drop every candidate
};

const supplierCandidates = narrowByLocality(suppliers.getSuppliersByName(name));
const truckerCandidates  = narrowByLocality(truckers.getTruckersByName(name));

if (!supplierCandidates.length && !truckerCandidates.length) {
    await _send(chatId, `No trucker or supplier named "${name}" found. Check the Truckers/Suppliers tab.`);
    return { action_taken: 'name_not_found' };
}

const containersMod = require('../helpers/containers');
const supplierPending = !!containersMod.nextUnassignedContainer(booking, 'supplier');
const truckerPending  = !!containersMod.nextUnassignedContainer(booking, 'trucker');

let role;
if (supplierCandidates.length && truckerCandidates.length) {
    // Name hits both rosters. Use this booking's own pending state to break
    // the tie — if only one role still has an open slot, that's almost
    // certainly what was meant. Only ask when it's genuinely ambiguous
    // (both pending, or both already fully assigned).
    if (supplierPending && !truckerPending)      role = 'supplier';
    else if (truckerPending && !supplierPending) role = 'trucker';
    else {
        await setPending(chatId, { type: 'await_role_choice', bkg_no: bkgNo, name, options: ['trucker', 'supplier'] });
        await _send(chatId, `"${name}" is both a trucker and a supplier. Assign as trucker or supplier for ${bkgNo}? Reply "trucker" or "supplier".`);
        return { action_taken: 'awaiting_role_choice' };
    }
} else {
    role = supplierCandidates.length ? 'supplier' : 'trucker';
}

return resolveSmartAssignRole(chatId, bkgNo, role, role === 'supplier' ? supplierCandidates : truckerCandidates);
}

// Shared tail for smartAssign() and the await_role_choice / await_candidate_choice
// pending resolutions below — once we have exactly one role and a candidate
// list, this decides fresh-assign vs reassign-confirm vs name-collision ask.
async function resolveSmartAssignRole(chatId, bkgNo, role, candidates) {
const { booking, status } = getBooking(bkgNo);
if (!booking) { await _send(chatId, `No booking found for ${bkgNo}.`); return { action_taken: 'not_found' }; }
// FIX (2026-07-16): this is also reached after a round-trip through
// await_role_choice / await_candidate_choice — the booking could have been
// archived (manually, or by the 11pm auto-archive job) in the gap between
// the manager being asked "trucker or supplier?" and them replying. Re-check
// here, don't just trust smartAssign()'s earlier check.
if (status === 'archived') { await _send(chatId, `${bkgNo} is archived — can't assign. If this was closed by mistake, restore it from the dashboard first.`); return { action_taken: 'archived_blocked' }; }
if (!candidates.length) { await _send(chatId, `No ${role} found for that name.`); return { action_taken: 'name_not_found' }; }

if (candidates.length > 1) {
    // Same name, multiple contacts, locality didn't narrow it to one.
    await setPending(chatId, { type: 'await_candidate_choice', bkg_no: bkgNo, role, options: candidates.map(c => c.name) });
    await _send(chatId, [`Multiple ${role}s match:`, '', ...candidates.map((c, i) => `${i + 1}. ${c.name}${c.locality ? ' · ' + c.locality : ''}`), '', 'Reply with a number or name.'].join('\n'));
    return { action_taken: 'awaiting_' + role + '_selection' };
}

const resolvedName = candidates[0].name;
const containersMod = require('../helpers/containers');
const pendingContainer = containersMod.nextUnassignedContainer(booking, role);

if (pendingContainer) {
    // Open slot for this role — just fill it. No confirmation needed
    // (matches existing forward/assign behavior for a fresh assignment).
    return role === 'supplier'
        ? executeAssign(chatId, bkgNo, resolvedName, null)
        : executeForward(chatId, bkgNo, resolvedName, null);
}

// Every container already has this role filled — this is a REASSIGNMENT,
// not a fresh assignment. Confirm before overwriting.
const assignedContainers = (booking.containers || []).filter(c => c[role]);
if (!assignedContainers.length) {
    // Defensive: nextUnassignedContainer said full but nothing is actually
    // assigned (shouldn't happen) — fall back to a fresh assign on #1.
    return role === 'supplier'
        ? executeAssign(chatId, bkgNo, resolvedName, booking.containers?.[0]?.seq ?? null)
        : executeForward(chatId, bkgNo, resolvedName, booking.containers?.[0]?.seq ?? null);
}

if (assignedContainers.length === 1) {
    const c = assignedContainers[0];
    const current = c[role];
    const label = booking.containers.length > 1 ? `${bkgNo}/${c.seq}` : bkgNo;
    if (String(current).toLowerCase() === resolvedName.toLowerCase()) {
        await _send(chatId, `${label} is already assigned to ${resolvedName} as ${role}. Nothing to do.`);
        return { action_taken: 'already_assigned_same' };
    }
    const stageNote = (c.stage && c.stage !== 'not_started') ? ` — currently at "${stepLabel(c.stage)}"` : '';
    await setPending(chatId, { type: 'await_reassign_confirm', bkg_no: bkgNo, role, new_name: resolvedName, container_seq: c.seq });
    await _send(chatId, `${label} is already assigned to ${current} as ${role}${stageNote}. Reassign to ${resolvedName}? (yes/no)`);
    return { action_taken: 'awaiting_reassign_confirm' };
}

// Multiple containers already have this role filled — ask which one.
await setPending(chatId, { type: 'await_reassign_confirm', bkg_no: bkgNo, role, new_name: resolvedName, options: assignedContainers.map(c => String(c.seq)) });
const list = assignedContainers.map(c => `#${c.seq} → ${c[role]}${c.stage && c.stage !== 'not_started' ? ` (${stepLabel(c.stage)})` : ''}`).join(', ');
await _send(chatId, `${bkgNo} has multiple containers already assigned as ${role}: ${list}. Reply with a container number to reassign to ${resolvedName}, or "no" to cancel.`);
return { action_taken: 'awaiting_reassign_confirm' };
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
await require('../helpers/tasks').cancelMatching({ type: 'nudge_empty_drop', bkg_no: bkgNo, container_seq: containerSeq });
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
// FIX (2026-07-16): recallBooking/executeRecall had ZERO existence check —
// worse than the archived-booking gap above, because there wasn't even a
// check for "does this booking exist at all". Any typo'd or fabricated
// booking number would still go through confirm → executeRecall, and
// getTruckerGroupIdForBooking('') for a booking with no workflow entry falls
// through to cfg.GROUP_TRUCKER (the default fallback group) — so a bogus
// recall sent a real "BKGXXX has been RECALLED" message to the whole default
// trucker group, plus created a phantom workflow.json entry via
// updateWorkflow's auto-create. Recall only makes sense on an active
// booking — an archived one is already closed, so treat that the same as
// "not found" (no separate archived-specific message needed here).
async function recallBooking(chatId, bkgNo) {
const { booking, status } = getBooking(bkgNo);
if (!booking || status === 'archived') { await _send(chatId, `No active booking found for ${bkgNo}. Check the booking number — it may not exist, or may already be archived.`); return { action_taken: 'not_found' }; }
await setPending(chatId, { type: 'confirm_recall', bkg_no: bkgNo });
await _send(chatId, `Recall ${bkgNo} from the trucker and reset to Not Started? (yes/no)`);
return { action_taken: 'awaiting_confirmation' };
}

async function executeRecall(chatId, bkgNo) {
// Re-check at execute time too (same reasoning as resolveSmartAssignRole) —
// the booking could have been archived in the gap between the yes/no ask
// and the manager's reply (e.g. the 11pm auto-archive job, or a manual
// archive from the dashboard in another tab).
const { booking, status } = getBooking(bkgNo);
if (!booking || status === 'archived') { await _send(chatId, `${bkgNo} is no longer an active booking — nothing to recall. Not notifying anyone.`); return { action_taken: 'not_found' }; }

const truckerChat = truckers.getTruckerGroupIdForBooking(bkgNo);
if (truckerChat) await _send(truckerChat, `${bkgNo} has been RECALLED. Please stop work on this booking.`);
await updateWorkflow(bkgNo, { step: 'not_started', trucker_name: null, trucker_group_id: null, recalled_at: new Date().toISOString() });
await _send(chatId, `${bkgNo} recalled.`);
_pushAlert({ type: 'recalled', bkgNo, message: `${bkgNo} recalled from trucker`, severity: 'warning' });
updateSession(chatId, { activeBooking: bkgNo, currentTopic: 'recall' });
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

    // ── Smart-assign follow-ups (2026-07-16) ────────────────────────────────
    // Manager told us WHICH role ("trucker" or "supplier") when a name hit
    // both rosters and the booking's pending state didn't break the tie.
    case 'await_role_choice': {
        await clearPending(chatId);
        const role = String(selection || '').toLowerCase();
        if (role !== 'trucker' && role !== 'supplier') {
            await _send(chatId, 'Reply "trucker" or "supplier".');
            return { action_taken: 'awaiting_role_choice' };
        }
        const { booking, status } = getBooking(pending.bkg_no);
        if (!booking) { await _send(chatId, `No booking found for ${pending.bkg_no}.`); return { action_taken: 'not_found' }; }
        if (status === 'archived') { await _send(chatId, `${pending.bkg_no} is archived — can't assign. If this was closed by mistake, restore it from the dashboard first.`); return { action_taken: 'archived_blocked' }; }
        const pol = booking.port_of_loading || '';
        const raw = role === 'supplier' ? suppliers.getSuppliersByName(pending.name) : truckers.getTruckersByName(pending.name);
        const local = raw.length > 1 ? raw.filter(x => suppliers.localityMatchesPort(x.locality, pol)) : raw;
        return resolveSmartAssignRole(chatId, pending.bkg_no, role, local.length ? local : raw);
    }
    // Manager picked which of several same-named contacts (name collision
    // within one role, e.g. two "Rudy"s and locality didn't narrow it).
    case 'await_candidate_choice':
        await clearPending(chatId);
        return resolveSmartAssignRole(chatId, pending.bkg_no, pending.role, [{ name: selection }]);
    // Manager confirmed (or picked a container for) a reassignment onto a
    // role that was already fully assigned on this booking.
    case 'await_reassign_confirm': {
        await clearPending(chatId);
        let seq = pending.container_seq ?? null;
        if (pending.options && selection) {
            const asNum = parseInt(selection, 10);
            if (!isNaN(asNum)) seq = asNum;
        }
        return pending.role === 'supplier'
            ? executeAssign(chatId, pending.bkg_no, pending.new_name, seq)
            : executeForward(chatId, pending.bkg_no, pending.new_name, seq);
    }

    // Manager answering "how long before I follow up?" (2026-07-16). Reply
    // could be a preset (5/15/30/60), any other plain number, or a phrase
    // like "2 hours". If it doesn't parse, re-prompt WITHOUT clearing the
    // pending — same pattern as await_role_choice's invalid-reply branch —
    // so a stray reply doesn't silently drop the follow-up request.
    case 'await_followup_minutes': {
        const raw = String(selection || answer || '').trim();
        const mins = parseMinutesReply(raw);
        if (!mins) {
            await _send(chatId, `Didn't catch a time frame — reply with a number of minutes (e.g. 15) or something like "2 hours". Reply "no" to cancel.`);
            return { action_taken: 'awaiting_followup_minutes' };
        }
        await clearPending(chatId);
        return fireFollowup(chatId, pending.target_kind, pending.resolved_name, pending.bkg_no, mins, pending.requested_by);
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
//
// Parses a manager's reply to "how long?" into minutes. Accepts a bare
// number (interpreted as minutes — matches the 5/15/30/60 presets we offer,
// but any positive integer works too, e.g. "20"), or "N min(s)"/"N hr(s)"/
// "N hour(s)". Returns null if it doesn't parse — caller re-prompts rather
// than guessing.
function parseMinutesReply(raw) {
const s = String(raw || '').trim().toLowerCase();
if (/^\d+$/.test(s)) { const n = parseInt(s, 10); return n > 0 ? n : null; }
const m = s.match(/^(\d+)\s*(min|mins|minute|minutes|hr|hrs|hour|hours)$/);
if (m) { const n = parseInt(m[1], 10); return n > 0 ? (m[2].startsWith('h') ? n * 60 : n) : null; }
return null;
}

async function scheduleFollowup(chatId, targetName, minutes, bkgNo, requestedBy) {
const name = String(targetName || '').trim();

let target_kind = null, resolvedName = name;
const t = truckers.getTrucker(name);
const s = !t ? suppliers.getSupplier(name) : null;
if (t)      { target_kind = 'trucker';  resolvedName = t.name; }
else if (s) { target_kind = 'supplier'; resolvedName = s.name; }

if (!target_kind) {
    await _send(chatId, `I don't have a contact named "${name}". Check the spelling or add them from the dashboard first.`);
    return { action_taken: 'replied' };
}

// FIX (2026-07-16): this used to silently default to 30 minutes whenever no
// explicit time was given (e.g. "Remind AP to share the scale ticket" has
// no "in N minutes"). Per Apsara: never auto-assume a timeframe on her
// behalf — ask, same principle as smart_assign asking instead of guessing
// trucker-vs-supplier. Only skip the ask when minutes came through already
// resolved (e.g. "follow up with X in 20 minutes" — policy regex parsed it).
if (!Number.isFinite(minutes) || minutes <= 0) {
    await setPending(chatId, {
        type: 'await_followup_minutes', target_kind, resolved_name: resolvedName,
        bkg_no: bkgNo || null, requested_by: requestedBy || null,
    });
    await _send(chatId, `How long before I follow up with ${resolvedName}${bkgNo ? ' re ' + bkgNo : ''}? Reply 5, 15, 30, or 60 (minutes) — or tell me a specific time, e.g. "2 hours".`);
    return { action_taken: 'awaiting_followup_minutes' };
}

return fireFollowup(chatId, target_kind, resolvedName, bkgNo, minutes, requestedBy);
}

// Shared tail for scheduleFollowup() (explicit minutes given up front) and
// resolvePending's 'await_followup_minutes' case (minutes given on the ask).
async function fireFollowup(chatId, target_kind, resolvedName, bkgNo, minutes, requestedBy) {
const tasks = require('../helpers/tasks');
const mins = minutes;
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

// ── Menu option 4 / "check supplier BKG123" — manager wants to know if a
// container is ready for pickup. Pings the supplier directly with a yes/no
// question and holds a pending state ON THE SUPPLIER'S CHAT (not the manager's)
// so their reply routes correctly regardless of role — see brain.js section A0.
async function checkSupplierReadiness(managerChatId, bkgNo, containerSeq) {
const b = loadBookings()[bkgNo];
if (!b) { await _send(managerChatId, `Booking ${bkgNo} not found.`); return { action_taken: 'replied' }; }
const supplierChat = suppliers.getSupplierGroupIdForBooking(bkgNo);
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
const supplierName = suppliers.matchSupplierByChat(supplierChatId)?.name || 'Supplier';
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
const supplierName = suppliers.matchSupplierByChat(supplierChatId)?.name || 'Supplier';
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

module.exports = {
init,
setPending, clearPending, getPending, resolvePending,
showMenu, showBookingsMenu, showBookingStatus, showContacts,
showBookingsAll, showBookingsUrgent, showBookingsAvailable, showBookingsWeek,
forwardBooking, executeForward,
assignSupplier, executeAssign,
smartAssign,
emptyDropConfirmed, loadReadyReceived, pickedUpConfirmed, scaleTicketReceived, ingateReceived,
askWhichBooking, askWhichContainer, fireResolvedStateIntent,
recallBooking, executeRecall, archiveNow,
showErd, showCutoff, getBookingField,
scheduleFollowup, escalateUnclear, rememberFact, addBusinessContext, logKnowledgeGap,
checkSupplierReadiness, resolveReadyCheckYes, resolveReadyCheckNo, resolveReadyCheckDate,
};
// ── Paste this block into workflow/actions.js — anywhere alongside the other
// action handlers (e.g. right after checkSupplierReadiness/resolveReadyCheckDate).
// Standalone: only depends on _send (already defined/injected at the top of
// the file via init()) and helpers/pricelist.js. Doesn't touch or call
// anything else in actions.js, so it's safe to append without needing the
// rest of the file's content.

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

// ── Then find the module.exports block at the very bottom of the file.
// I verified its exact tail via GitHub — it currently ends with:
//
//   checkSupplierReadiness, resolveReadyCheckYes, resolveReadyCheckNo, resolveReadyCheckDate,
//   };
//
// Change those two lines to:
//
//   checkSupplierReadiness, resolveReadyCheckYes, resolveReadyCheckNo, resolveReadyCheckDate,
//   sendPriceListTo,
//   };
// ── Price list — "send price list to X" from brain.js (appended safely) ────
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
module.exports.sendPriceListTo = sendPriceListTo;

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
module.exports.sendPriceListCity = sendPriceListCity;
