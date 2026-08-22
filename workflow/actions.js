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
const quoteHelper = require('../helpers/quoteRequests');
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
        // Every container has a trucker NAME on it — but that name can get there
        // two ways: (a) a real forward, which sends the WhatsApp message + PDF
        // and advances stage to 'forwarded', or (b) a manual edit via the
        // dashboard's "Stage (manual)" override, which the dashboard itself
        // warns does NOT notify the trucker. Case (b) left the field looking
        // "assigned" while nothing was ever actually sent — a real report from
        // a booking where the trucker was typed into the dashboard directly.
        // So before giving up, check for a container stuck at a pre-forward
        // stage despite having a trucker name — that one still genuinely needs
        // the notification sent, and IS what "forward" should act on.
        const notYetNotified = cList.find(c => c.trucker && ['not_started', 'supplier_assigned'].includes(c.stage || 'not_started'));
        if (notYetNotified) {
            targetContainer = notYetNotified;
        } else {
            await _send(chatId, `${bkgNo}: all ${cList.length} container${cList.length > 1 ? 's' : ''} already assigned to truckers. Nothing to forward.`);
            return { action_taken: 'max_capacity' };
        }
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

// REAL BUG (found 2026-08-06, live — Apsara: "fix supplier/trucker mode of
// communication is email"): the fix earlier today only covered quote
// requests (helpers/quoteRequests.js's resolveTruckerChannel). The general
// booking-notification path — forward/assign — had the SAME gap: it always
// resolved a WhatsApp chatId via getTruckerChatId/getSupplierChatId and had
// no email option at all, so a trucker/supplier explicitly set to
// "Preferred: Email" still got a WhatsApp message (or nothing, if they had
// no WhatsApp on file at all).
//
// Scoped deliberately: this covers executeForward/executeAssign below —
// one-way "here's your job" notifications with no reply-tracking need.
// relayQuestionToContact (a manager's ad-hoc question that a REPLY must
// route back from) is NOT extended here — its whole mechanism is a WhatsApp
// chatId-keyed pending that fires the moment a live message arrives
// (relayReplyReceived, called from brain.js's inbound handler). An email
// reply doesn't arrive that way — it'd need the same kind of thread-polling
// this session already built for general emails (helpers/emailThreads.js),
// PLUS a way to turn a poll-detected reply into "relay this back to the
// manager," which nothing here does yet. Flagged as a separate, bigger
// piece of work rather than half-built.
//
// record: the trucker/supplier row itself (already fetched by both callers
// below) — resolveTruckerChannel is generic on the {whatsapp, group_id,
// email, preferred_mode} shape, works identically for either table.
// pdfDriveId: optional — executeForward's WhatsApp path sends the actual
// PDF as media; Gmail's send here has no attachment support at all
// (helpers/gmail.js's buildMimeMessage is plain-text only), so the email
// path links to the same Drive file instead of attaching it. Flagged, not
// silently downgraded — a real follow-up if inline PDF attachments turn
// out to matter for the email-preferred contacts in practice.
async function notifyContactRespectingChannel(record, { waChatId, text, subject, bkgNo, pdfDriveId }) {
    const ch = quoteHelper.resolveTruckerChannel(record);
    if (ch && ch.channel === 'email') {
        const { sendEmail } = require('../helpers/gmail');
        const body = pdfDriveId ? `${text}\n\nBooking PDF: https://drive.google.com/file/d/${pdfDriveId}/view` : text;
        try {
            const sent = await sendEmail({ to: ch.target, subject, body });
            require('../helpers/emailThreads').trackSentEmail({
                threadId: sent?.threadId, to: ch.target, targetName: record.name, subject, bkgNo,
            }).catch((e) => console.error('[ACTIONS] emailThreads.trackSentEmail failed (non-fatal):', e.message));
            return { channel: 'email', ok: true, target: ch.target };
        } catch (err) {
            console.error(`[ACTIONS] notifyContactRespectingChannel: email send failed for ${record.name}:`, err.message);
            return { channel: 'email', ok: false, error: err.message };
        }
    }
    // WhatsApp — either genuinely preferred, or email was preferred but
    // there's no address on file to honor it with (resolveTruckerChannel's
    // own fallback chain already handles that silently; waChatId is the
    // pre-resolved value the existing callers already had, kept as the
    // primary source so this doesn't change WhatsApp behavior for anyone
    // at all — only adds the email branch above it).
    if (!waChatId) return { channel: 'none', ok: false };
    await _send(waChatId, text);
    return { channel: 'whatsapp', ok: true, target: waChatId };
}

// Executes after manager confirms.
// containerSeq (optional): write the trucker onto that specific container.
async function executeForward(chatId, bkgNo, truckerName, containerSeq) {
const { booking } = getBooking(bkgNo);
if (!booking) { await _send(chatId, `Booking ${bkgNo} disappeared — check dashboard.`); return { action_taken: 'not_found' }; }

const truckerChat = await truckers.getTruckerChatId(truckerName);
const t           = await truckers.getTrucker(truckerName);
const label       = containerSeq != null ? `${bkgNo}/${containerSeq}` : bkgNo;

const forwardNotice = await notifyContactRespectingChannel(t, {
    waChatId: truckerChat, bkgNo,
    subject: `New booking — ${label}`,
    text: [`New booking — ${label}`, '', formatBookingForForward(booking), '', 'Please confirm empty pickup and send the empty-drop photo when done.'].join('\n'),
    pdfDriveId: booking.pdf_drive_id || null,
});

// PDF side track — never blocks the forward. WhatsApp-only: the email
// path above already linked the same Drive file inline instead (see
// notifyContactRespectingChannel's own comment — no attachment support
// in the email send path yet).
if (forwardNotice.channel === 'whatsapp') {
    try {
        const { fetchPdfFromDrive } = require('../helpers/drive');
        const pdf = await fetchPdfFromDrive(bkgNo);
        if (pdf) await _send(truckerChat, null, pdf);
    } catch (e) { console.log('[ACTIONS] PDF skip:', e.message); }
}

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

await notifyContactRespectingChannel(s, {
    waChatId: supplierChat, bkgNo,
    subject: `New assignment — ${label}`,
    text: [`New assignment — ${label}`, '', formatBookingForForward(booking), '', 'Please confirm material readiness and share the target load date.'].join('\n'),
});

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

// ── Yard scale tickets — standalone capture, independent of booking/container
// workflow. Photo comes from a yard/scale-staff WhatsApp number
// (settings.yard_staff, matched in brain.js's normalize()), gets read by
// Gemini vision (helpers/gemini.js's extractScaleTicketFields), archived to
// Drive, and stored in its own record (helpers/scaleTickets.js). Deliberately
// never touches bookings.json or workflow.json — see scaleTicketReceived()
// above for the (unrelated) per-container flag on the booking workflow.
async function yardScaleTicketReceived(chatId, senderName, imageBase64, mimeType) {
    if (!imageBase64) {
        await _send(chatId, "Couldn't read that photo — please resend the scale ticket image.");
        return { action_taken: 'yard_scale_ticket_failed' };
    }

    const { extractScaleTicketFields } = require('../helpers/gemini');
    const { addScaleTicket, updateScaleTicket } = require('../helpers/scaleTickets');

    let fields = null;
    try {
        fields = await extractScaleTicketFields(imageBase64, mimeType);
    } catch (err) {
        console.error('[YARD] Gemini extraction failed:', err.message);
    }

    const record = await addScaleTicket({
        submitted_by : senderName,
        chat_id      : chatId,
        mime_type    : mimeType || 'image/jpeg',
        fields       : fields || {},
        extraction_ok: !!fields,
    });

    // Archive the photo to Drive — fails soft, never blocks the WhatsApp
    // reply or loses the extracted fields. If this fails, the ticket record
    // still exists with drive_link: null; re-run manually later if needed.
    try {
        const { uploadScaleTicketImage } = require('../helpers/drive');
        const file = await uploadScaleTicketImage(record.id, imageBase64, mimeType);
        await updateScaleTicket(record.id, { drive_file_id: file.id, drive_link: file.webViewLink });
    } catch (err) {
        console.error(`[YARD] Drive archive failed for ${record.id} (ticket data still saved):`, err.message);
    }

    if (!fields) {
        await _send(chatId, `Got the photo (${record.id}) but couldn't read the ticket clearly — saved for manual review.`);
        return { action_taken: 'yard_scale_ticket_saved_unreadable', ticket_id: record.id };
    }

    const summary = [
        `Scale ticket saved (${record.id}).`,
        fields.ticket_number != null ? `Ticket #: ${fields.ticket_number}` : null,
        fields.gross_weight  != null ? `Gross: ${fields.gross_weight} ${fields.weight_unit || ''}`.trim() : null,
        fields.tare_weight   != null ? `Tare: ${fields.tare_weight} ${fields.weight_unit || ''}`.trim() : null,
        fields.net_weight    != null ? `Net: ${fields.net_weight} ${fields.weight_unit || ''}`.trim() : null,
    ].filter(Boolean).join('\n');
    await _send(chatId, summary);

    return { action_taken: 'yard_scale_ticket_received', ticket_id: record.id };
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
// Handled BEFORE the generic 'no' branch below — unlike every other pending
// type, "no" here does NOT mean "cancel and stop." It means "don't save the
// cc pattern, but still draft the email I originally asked for" — the cc
// suggestion is a side offer, not the actual request.
if (pending.type === 'await_cc_pattern_confirm') {
    await clearPending(chatId);
    const emailContacts = require('../helpers/emailContacts');
    if (answer === 'yes') {
        try {
            await emailContacts.setContactCc(pending.target_name, pending.detected_cc);
        } catch (err) {
            console.warn(`[ACTIONS] Failed to save cc pattern for "${pending.target_name}":`, err.message);
        }
    } else {
        // Remembers the "no" so this isn't re-asked on every future email to
        // the same contact — see declineCcSuggestion's own comment.
        emailContacts.declineCcSuggestion(pending.target_name).catch((err) =>
            console.warn(`[ACTIONS] Failed to record cc-suggestion decline for "${pending.target_name}":`, err.message));
    }
    return draftEmailWithAddress(chatId, pending.target_name, pending.details, pending.bkg_no, pending.to, pending.to_source,
        pending.scheduled_for ? new Date(pending.scheduled_for) : null);
}

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
        return pending.scheduled_for ? scheduleDraftedEmail(chatId, pending) : sendDraftedEmail(chatId, pending);
    // Payment detected in the mailbox by workflow/paymentWatcher.js. That
    // watcher never writes to the ledger itself — this yes is the only thing
    // that credits money, deliberately: a wrongly-credited payment is silent
    // (the invoice simply stops appearing in "who owes me") and would have
    // her stop chasing a customer who never paid. See that file's header.
    case 'await_payment_confirm': {
        await clearPending(chatId);
        const ar = require('../helpers/receivables');
        try {
            const payment = await ar.addPayment({
                inv_no: pending.inv_no,
                amount: pending.amount,
                paid_on: pending.paid_on || null,
                method: pending.method || null,
                note: pending.source_subject ? `auto-detected: ${pending.source_subject}` : 'auto-detected from email',
                recorded_by: 'paymentWatcher',
            });
            const { rows } = await ar.buildLedger({});
            const inv = rows.find((r) => ar.normaliseInvNo(r.inv_no) === ar.normaliseInvNo(pending.inv_no));
            const m = (n) => `$${(Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
            const tail = inv
                ? (inv.balance <= 0.01 ? ` That clears ${inv.inv_no}.` : ` ${m(inv.balance)} still open on ${inv.inv_no}.`)
                : '';
            await _send(chatId, `Recorded ${m(payment.amount)} against ${pending.inv_no}.${tail}`);
            return { action_taken: 'payment_recorded' };
        } catch (e) {
            await _send(chatId, `Couldn't record that payment: ${e.message}. Nothing was credited.`);
            return { action_taken: 'payment_failed' };
        }
    }

    // Picked one of the ambiguous address-book matches shown for the quote
    // request's origin or destination — same options/matches pattern as
    // await_contact_disambiguation above. Resumes continueQuoteFlow with
    // that field pinned to the confirmed alias (guaranteed to resolve
    // exactly next time), which may immediately hit ambiguity on the OTHER
    // field too — that's fine, it just pauses again the same way.
    case 'confirm_quote_lane': {
        await clearPending(chatId);
        const matches = pending.matches || [];
        const chosen = matches.find((e) => e.aliases[0] === selection) || (matches.length === 1 ? matches[0] : null);
        if (!chosen) {
            await _send(chatId, `Didn't catch which one — reply with the number (1-${matches.length}), or "cancel".`);
            await setPending(chatId, pending);
            return { action_taken: 'quote_lane_disambiguation_unresolved' };
        }
        const nextState = { ...pending.state, [pending.field === 'origin' ? 'originQuery' : 'destinationQuery']: chosen.aliases[0] };
        return continueQuoteFlow(chatId, nextState);
    }

    // Picked one of the ambiguous trucker-name matches — same pattern.
    // Re-runs trucker resolution with the confirmed name substituted back
    // in among whatever other names hadn't been resolved yet.
    case 'confirm_quote_trucker': {
        await clearPending(chatId);
        const matches = pending.matches || [];
        const chosen = matches.find((t) => t.name === selection) || (matches.length === 1 ? matches[0] : null);
        if (!chosen) {
            await _send(chatId, `Didn't catch which one — reply with the number (1-${matches.length}), or "cancel".`);
            await setPending(chatId, pending);
            return { action_taken: 'quote_trucker_disambiguation_unresolved' };
        }
        const nextNames = [chosen.name, ...(pending.remainingNames || [])];
        return continueQuoteFlow(chatId, { ...pending.state, names: nextNames, resolvedSoFar: pending.resolvedSoFar || [] });
    }

    // Picked one of the ambiguous-match options shown above (by number or
    // by name, via brain.js's generic p.options handling) — resume the
    // original draft-email request with the chosen contact's address.
    case 'await_contact_disambiguation': {
        await clearPending(chatId);
        const matches = pending.matches || [];
        const chosen = matches.find((c) => c.name === selection) || (matches.length === 1 ? matches[0] : null);
        if (!chosen) {
            await _send(chatId, `Didn't catch which one — reply with the number (1-${matches.length}), or "cancel".`);
            return { action_taken: 'contact_disambiguation_unresolved' };
        }
        return draftEmailWithAddress(chatId, pending.target_name, pending.details, pending.bkg_no, chosen.email, 'contact',
            pending.scheduled_for ? new Date(pending.scheduled_for) : null);
    }

    // "yes" to the domain-tree proposal shown by stageDomainLearnConfirm.
    // "no" is already handled generically above (cancel, nothing saved).
    case 'await_domain_learn_confirm': {
        await clearPending(chatId);
        const emailContacts = require('../helpers/emailContacts');
        const { term, domain, proposals, resume } = pending;
        const bareTerm = String(term).replace(/\.com$/i, '').toLowerCase();
        // Clear any pre-existing flat, non-domain entry with this exact bare
        // name first — a leftover flat alias would otherwise permanently
        // shadow the domain tier we're about to create (see addContact's own
        // shadow-guard comment for the full incident this protects against).
        const existingFlat = emailContacts.loadContacts().find((c) => c.name.toLowerCase() === bareTerm && !c.domain);
        if (existingFlat) await emailContacts.removeContact(bareTerm);
        // Cc scope changed 2026-08-04 per Apsara, explicit choice via
        // AskUserQuestion ("everyone else at that company" over "only
        // shared-role addresses"): every member of a domain group gets
        // auto-cc'd with every OTHER member, regardless of role — not just
        // whoever's marked 'shared'. 'shared' still matters for who a bare
        // domain mention resolves to (never the default primary), just not
        // for cc scope anymore.
        for (const p of proposals) {
            const others = proposals.filter((x) => x.addr !== p.addr).map((x) => x.addr);
            await emailContacts.addContact(p.name, p.addr, {
                domain, role: p.role,
                ...(others.length ? { cc: others } : {}),
                ...(p.displayName ? { displayName: p.displayName } : {}),
            });
        }
        if (!resume) {
            await _send(chatId, `Saved ${proposals.length} contact(s) under ${domain}.${existingFlat ? ` (replaced the old flat "${bareTerm}" entry.)` : ''}`);
            return { action_taken: 'domain_learn_saved' };
        }
        // Resume the original "mail X" request that triggered this — same
        // "don't lose what was originally asked" reasoning as
        // await_manual_email_address/await_cc_pattern_confirm. Re-resolving
        // via resolveContact (rather than reusing whatever findLatestFrom
        // picked before) means it now goes through the domain tree we just
        // saved, so it actually reflects the roles she just confirmed.
        const resolved = emailContacts.resolveContact(term);
        if (!resolved || resolved.type === 'ambiguous') {
            await _send(chatId, `Saved ${proposals.length} contact(s) under ${domain}, but none is marked primary — who should I actually send your original email to? Reply with their name.`);
            return { action_taken: 'domain_learn_saved_no_default' };
        }
        return draftEmailWithAddress(chatId, term, resume.details, resume.bkg_no, resolved.contact.email, 'contact',
            resume.scheduled_for ? new Date(resume.scheduled_for) : null);
    }

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
// Persists to facts.json, fed into every AI prompt (see helpers/context.js
// formatForAI). This is how corrections and standing instructions survive
// across conversations without a code change: no retraining happens, this
// is durable prompt-context, not model weights.
//
// pinned:true (2026-08-16, per Apsara: "i want infra... it remembers
// forever like a child being taught") — a "remember X" she actually typed
// is a deliberate standing instruction, not an ambient note, so it's exempt
// from the 15-item recency window from the moment it's saved. She no
// longer has to separately go pin it on the dashboard for it to actually
// stick — see helpers/json.js's addFact header for the full reasoning.
async function rememberFact(chatId, text) {
const clean = String(text || '').trim();
if (!clean) { await _send(chatId, "What should I remember?"); return { action_taken: 'replied' }; }
await addFact(clean, true);
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
const bkgLabel = bkgNo ? ` (re ${bkgNo})` : '';
const expectedIntent = detectExpectedIntent(clean);

// REAL GAP (found 2026-08-06, live — Apsara: "relay-to-email reply
// routing", the deferred half of "fix supplier/trucker mode of
// communication is email"): this always resolved a WhatsApp chatId and set
// a chatId-keyed pending (await_relay_reply) to catch the reply — an
// email-preferred contact either got nothing ("no WhatsApp number or group
// on file") or, if they happened to have a number too, got WhatsApp anyway
// regardless of their saved preference. Checked first now via the same
// resolveTruckerChannel used for quote requests/forward/assign — email
// wins when that's the saved preference and an address is on file.
const ch = quoteHelper.resolveTruckerChannel(contact);
if (ch && ch.channel === 'email') {
    const { sendEmail } = require('../helpers/gmail');
    const subject = `Question${bkgLabel}`;
    try {
        const sent = await sendEmail({ to: ch.target, subject, body: `${clean}${bkgLabel}` });
        // relayTo/askedOf/question/expectedIntent — this is what lets
        // workflow/emailReplyWatch.js's poller recognize this thread as a
        // relay (route the reply back to managerChatId) instead of treating
        // it like a plain general email (just a bell alert). See
        // relayReplyReceivedViaEmail below for that side.
        require('../helpers/emailThreads').trackSentEmail({
            threadId: sent?.threadId, to: ch.target, targetName: contact.name, subject, bkgNo: bkgNo || null,
            relayTo: managerChatId, askedOf: contact.name, question: clean, expectedIntent,
        }).catch((e) => console.error('[ACTIONS] emailThreads.trackSentEmail failed (non-fatal):', e.message));
        await _send(managerChatId, `Asked ${contact.name}${bkgLabel} by email — I'll let you know what they say.`);
        return { action_taken: 'relayed_email' };
    } catch (err) {
        console.error(`[ACTIONS] relayQuestionToContact: email send failed for ${contact.name}:`, err.message);
        await _send(managerChatId, `Couldn't email ${contact.name}: ${err.message}`);
        return { action_taken: 'relay_email_failed' };
    }
}

const targetChat = t
    ? await truckers.getTruckerChatId(contact.name)
    : await suppliers.getSupplierChatId(contact.name);
if (!targetChat) {
    await _send(managerChatId, `${contact.name} has no WhatsApp or email on file — can't reach them.`);
    return { action_taken: 'no_destination' };
}

await _send(targetChat, `${clean}${bkgLabel}`);
await setPending(targetChat, { type: 'await_relay_reply', relay_to: managerChatId, bkg_no: bkgNo || null, question: clean, asked_of: contact.name, expected_intent: expectedIntent });
await _send(managerChatId, `Asked ${contact.name}${bkgLabel} — I'll let you know what they say.`);
return { action_taken: 'relayed' };
}

// Email counterpart to relayReplyReceived — called from
// workflow/emailReplyWatch.js's poller when a reply lands on a thread that
// has relay_to set (i.e. this thread came from relayQuestionToContact's
// email branch above, not a plain general email). Mirrors
// relayReplyReceived's yes/no-detection + auto-fire-workflow-transition
// logic exactly — the only real differences are: no chatId-keyed pending to
// clear (there isn't one for an email thread), and the acknowledgment back
// to the contact is a threaded email reply instead of a WhatsApp message.
async function relayReplyReceivedViaEmail(threadEntry, replyText) {
const { relay_to, bkg_no, question, asked_of, expected_intent, thread_id, to, subject } = threadEntry;
const clean = String(replyText || '').trim();
const lower = clean.toLowerCase();
const bkgLabel = bkg_no ? ` (re ${bkg_no})` : '';

async function ack(text) {
    try {
        const { sendEmail } = require('../helpers/gmail');
        await sendEmail({ to, subject: subject ? `Re: ${subject}` : 'Re: your reply', body: text, threadId: thread_id });
    } catch (err) {
        console.error(`[ACTIONS] relayReplyReceivedViaEmail: acknowledgment send failed for ${asked_of}:`, err.message);
    }
}

if (expected_intent && bkg_no && YES_WORDS.has(lower)) {
    await ack('Thanks — noted.');
    const result = await fireResolvedStateIntent(expected_intent, bkg_no, null, asked_of, false);
    await _send(relay_to, `${asked_of || 'Contact'}${bkgLabel} confirmed by email: ${question} → Yes. Status updated.`);
    return result;
}
if (expected_intent && bkg_no && NO_WORDS.has(lower)) {
    await ack('Got it, thanks.');
    await _send(relay_to, `${asked_of || 'Contact'}${bkgLabel} replied by email to "${question}": ${clean}`);
    return { action_taken: 'relay_reply_forwarded' };
}

await ack('Thanks, relayed.');
await _send(relay_to, `${asked_of || 'Contact'}${bkgLabel} replied by email to "${question}": ${clean}`);
return { action_taken: 'relay_reply_forwarded' };
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
// pinned:true (2026-08-16, per Apsara's "remembers forever" ask) — same
// reasoning as rememberFact above: these are AI-detected corrections she's
// explicitly reviewing and confirming here, not ambient notes, so they're
// exempt from the recency window from the moment she approves them.
for (const fact of toAdd) {
    await addFact(fact, true);
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

// THIRD hallucination case, found 2026-08-03 via live pm2 logs: for "send
// mail to radmetals" (zero content given), the AI classifier's own
// reasoning invented email_details "stating I miss you" out of nothing —
// same failure pattern as the target_name address hallucination, just a
// different field. Regex-derived email_details (from policyDecide's "email
// X about Y" pattern) is ALWAYS a literal substring of the manager's raw
// message by construction, so this never flags those — it only catches
// content that shares no real vocabulary with what was actually typed,
// which is exactly what fabricated content looks like.
function detailsLookGrounded(rawText, details) {
    if (!details || !details.trim()) return true; // nothing to distrust
    if (!rawText) return true; // can't verify either way — don't block on it
    const stop = new Set(['about', 'email', 'mail', 'send', 'please', 'thanks', 'regards', 'reply']);
    const meaningful = (details.toLowerCase().match(/[a-z]{4,}/g) || []).filter((w) => !stop.has(w));
    if (!meaningful.length) return true; // too short/generic a details string to judge either way
    const rawLower = rawText.toLowerCase();
    return meaningful.some((w) => rawLower.includes(w));
}

// Combines the global Cc (Settings tab) with a contact's own standing Cc
// (see helpers/emailContacts.js's setContactCc), per Apsara's explicit
// instruction: "combine both, if there is duplicate remove one." Case-
// insensitive de-dupe — the same address typed with different casing in the
// two sources should still collapse to one.
// Variadic — each source can be a comma-string (e.g. from Settings) or an
// array (e.g. a contact's saved cc, or an original thread's Cc list). Falsy
// sources are just skipped, so callers don't need to guard every argument.
// Extended 2026-08-03 from a 2-arg version to support reply_email merging a
// THIRD source (the original thread's own Cc) on top of global + contact.
function mergeCc(...sources) {
    const combined = [];
    for (const src of sources) {
        if (!src) continue;
        if (Array.isArray(src)) combined.push(...src);
        else combined.push(...String(src).split(',').map((s) => s.trim()));
    }
    const seen = new Set();
    return combined.filter(Boolean).filter((addr) => {
        const key = addr.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).join(', ');
}

// REAL BUG (found 2026-08-04, live): "Send mail to mkmetaltrading" (one
// clean word, exactly matching the mkmetaltrading.com domain) got
// classified with target_name "mk metal trading" — the AI "helpfully"
// reformatted a compressed company name into spaced-out words. That
// silently broke resolution: the search then went looking for the literal
// PHRASE "mk metal trading" (which appears nowhere in real mail), instead
// of the single token that would have matched the domain instantly. Same
// class of problem as the mike@example.com/"I miss you" incidents — the
// model altering what was actually typed instead of preserving it — same
// fix shape: don't trust a prompt instruction alone, check the raw message.
// Shared by draftEmailForConfirm and draftReplyForConfirm so the two can't
// drift into handling this differently.
//
// If a single word in rawText, with whitespace/punctuation stripped,
// matches target_name the same way, that raw word IS what she actually
// typed — use it verbatim instead of the AI's reformatted guess. Only fires
// on an exact single-word match, so a genuinely multi-word name she really
// did type with real spaces (nothing in rawText collapses to it) is left
// untouched — that case is exactly what helpers/gmail.js's searchTermFor
// quoting exists to handle correctly.
function deReformatTargetName(targetName, rawText) {
    if (!rawText) return targetName;
    const stripped = targetName.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (!stripped) return targetName;
    const rawWord = String(rawText).split(/\s+/).find((w) => w.replace(/[^a-z0-9]/gi, '').toLowerCase() === stripped);
    if (!rawWord) return targetName;
    const cleaned = rawWord.replace(/[^a-zA-Z0-9.\-]/g, '');
    if (!cleaned || cleaned.toLowerCase() === targetName.toLowerCase()) return targetName;
    console.warn(`[ACTIONS] target_name "${targetName}" was reformatted by the AI from what looks like one literal word ("${cleaned}") in the manager's actual message ("${rawText}") — using the literal word instead.`);
    return cleaned;
}

// REAL BUG (found 2026-08-04, live): "request a delivery appointment for
// tomorrow" drafted with a literal "[Date]" placeholder instead of an actual
// date. Gemini has no way to resolve "tomorrow"/"next Monday"/etc. into a
// real calendar date unless it's actually told what today is — nothing in
// any drafting prompt ever gave it that. Shared by every draft-composing
// prompt in this file so none of them can independently forget it.
function todayDateContext() {
    const formatted = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    return `Today's date is ${formatted}. If the message references a relative date ("tomorrow", "next Monday", "in 3 days", etc.), resolve it to an ACTUAL calendar date and use that in the email — never leave a placeholder like "[Date]" or "[Insert Date]" for the manager to fill in themselves.`;
}

// Scheduled-send display — always LA time, matching helpers/time.js's
// getLATime and every other freight-deadline display in this app.
function formatScheduledFor(date) {
    return require('../helpers/time').getLATime(date) + ' LA time';
}

// Turns the raw phrase brain.js's extractScheduleClause() pulled out of the
// manager's own message (e.g. "7 am LA time", "next monday") into an actual
// Date, using helpers/time.js's parseNaturalTime — deterministic, not an AI
// guess (see that function's own comment for why). Grounded by construction:
// sendAtText, when present, IS a literal substring of rawText already (that's
// how extractScheduleClause found it), so there's no separate hallucination
// check needed here the way target_name/email_details need one. A phrase
// that fails to parse just means "don't schedule" rather than blocking the
// email entirely — same fail-open posture as every other best-effort
// enrichment in this file (recentContext, cc-pattern detection, etc.).
function resolveScheduledFor(sendAtText) {
    if (!sendAtText) return null;
    try {
        const { parseNaturalTime } = require('../helpers/time');
        const d = parseNaturalTime(sendAtText);
        if (!d || isNaN(d.getTime())) {
            console.warn(`[ACTIONS] Couldn't parse schedule phrase "${sendAtText}" — sending immediately instead of scheduling.`);
            return null;
        }
        return d;
    } catch (err) {
        console.warn(`[ACTIONS] Schedule parse failed for "${sendAtText}":`, err.message);
        return null;
    }
}

// Search apsara's own mailbox FIRST (if that token's set up — see
// helpers/gmail.js's getGmailSenderRead(), which returns null rather than
// throwing when it isn't), then fall back to bose@. Real gap found
// 2026-08-05: threads Apsara starts herself (emailing a trucker/broker
// directly from apsara@) never touch bose@'s carrier-mail-intake inbox at
// all, so a search hardcoded to bose@ is structurally blind to them — worse,
// it can match some unrelated message off a coincidental word/subject
// overlap and thread a reply onto the WRONG conversation. Returns which
// account's client actually produced the match, since getMessage() on the
// result MUST reuse that same client — message IDs aren't portable across
// Gmail accounts.
async function searchOwnThenBose(query, maxResults, gmailBose) {
    const { getGmailSenderRead, listMessages } = require('../helpers/gmail');
    let senderGmail = null;
    try {
        senderGmail = getGmailSenderRead();
    } catch (err) {
        console.warn('[ACTIONS] getGmailSenderRead() failed — falling back to bose@ only:', err.message);
    }
    if (senderGmail) {
        try {
            const messages = await listMessages(senderGmail, query, maxResults);
            if (messages.length) return { messages, gmail: senderGmail, source: 'sender' };
        } catch (err) {
            console.warn('[ACTIONS] Sender-mailbox search failed, falling back to bose@:', err.message);
        }
    }
    // `source` matters to callers, not just for logging. A thread found only
    // in bose@ has no copy in apsara@ at all, so a reply sent from apsara —
    // correctly threaded for the RECIPIENT via In-Reply-To — still shows up
    // in HER OWN mailbox as an orphan with no conversation above it. Apsara,
    // 2026-08-22: "if email is found only in bose, but not in apsara —
    // forward that to email to apsara and then in-mail reply." Callers use
    // this flag to decide whether that forward is needed.
    const messages = await listMessages(gmailBose, query, maxResults);
    return { messages, gmail: gmailBose, source: 'bose' };
}

// Forwards the original into apsara@ so her mailbox holds the conversation
// the reply belongs to.
//
// Sent FROM apsara TO apsara, carrying the ORIGINAL's Message-ID in
// In-Reply-To/References. That is what makes her Gmail thread the forward
// and the reply together instead of showing two loose messages: both
// reference the same chain. Those are ordinary RFC headers, so unlike a
// Gmail threadId they cross accounts perfectly well.
//
// Returns true only if the forward actually went out. A failure here is
// deliberately NOT fatal to the reply — the reply is the thing she asked
// for and the thing the customer is waiting on; losing it because a
// convenience copy failed would be the wrong trade. The caller says plainly
// which parts happened.
async function forwardOriginalToSelf({ subject, from, date, body, messageIdHeader, references }) {
    const { sendEmail, getMyEmailAddress, getGmailSenderRead } = require('../helpers/gmail');
    let me = null;
    try {
        const senderGmail = getGmailSenderRead();
        if (senderGmail) me = await getMyEmailAddress(senderGmail);
    } catch (e) { /* fall through */ }
    if (!me) {
        console.warn('[ACTIONS] forwardOriginalToSelf: own address unknown — skipping forward');
        return false;
    }
    const fwdBody = [
        '---------- Forwarded message ----------',
        `From: ${from || '(unknown)'}`,
        `Date: ${date || '(unknown)'}`,
        `Subject: ${subject || '(no subject)'}`,
        '',
        String(body || '').slice(0, 20000),
    ].join('\n');
    try {
        await sendEmail({
            to: me,
            subject: /^fwd:/i.test(subject || '') ? subject : `Fwd: ${subject || '(no subject)'}`,
            body: fwdBody,
            inReplyTo: messageIdHeader || undefined,
            references: references || messageIdHeader || undefined,
        });
        return true;
    } catch (err) {
        console.error('[ACTIONS] forwardOriginalToSelf failed (non-fatal):', err.message);
        return false;
    }
}

async function draftEmailForConfirm(chatId, targetName, details, bkgNo, rawText, sendAtText) {
    if (!targetName) {
        await _send(chatId, 'Email who? Give me a name or company, e.g. "email Zimex about DALA123 cutoff".');
        return { action_taken: 'email_missing_target' };
    }
    const scheduledFor = resolveScheduledFor(sendAtText);
    const { getGmailRead, findLatestFrom } = require('../helpers/gmail');

    let gmail;
    try {
        gmail = getGmailRead();
    } catch (err) {
        await _send(chatId, `Can't draft that — Gmail isn't configured (${err.message}).`);
        return { action_taken: 'email_gmail_unavailable' };
    }

    // REAL BUG (found 2026-08-03, live): "mail Mike asking..." — no email in
    // the manager's actual message — got classified by the AI with
    // target_name = "mike@example.com". A bare first name became a fully
    // fabricated, plausible-looking address (classic LLM placeholder
    // pattern — example.com is literally RFC 2606's reserved example
    // domain). resolveContact()'s isValidEmail(raw) shortcut then trusted it
    // as an "exact" match and labeled it "(saved contact)" — false
    // confidence on a completely invented destination, one "yes" away from
    // actually sending real business mail nowhere useful. The prompt now
    // explicitly forbids this (see brain.js), but a prompt instruction is
    // not a guarantee against a model hallucinating — this is the actual
    // backstop: if target_name looks like an email address but that exact
    // string never appeared in what the manager actually typed, it did NOT
    // come from the manager and must not be trusted as one.
    targetName = String(targetName).trim();
    if (isValidEmail(targetName) && rawText && !String(rawText).toLowerCase().includes(targetName.toLowerCase())) {
        console.warn(`[ACTIONS] target_name "${targetName}" looks like an email but wasn't in the manager's actual message ("${rawText}") — treating as an unverified/likely-hallucinated value, not an address.`);
        targetName = targetName.split('@')[0];
    }
    targetName = deReformatTargetName(targetName, rawText);
    // Same defense for email_details — real incident, 2026-08-03: "send
    // mail to radmetals" (zero content given) got email_details "I miss
    // you" invented by the AI classifier. Discarding it here just means it
    // falls through to draftEmailWithAddress's "no details given" path,
    // which (as of today) grounds the draft in real past correspondence
    // instead of trusting fabricated content.
    if (details && rawText && !detailsLookGrounded(rawText, details)) {
        console.warn(`[ACTIONS] email_details "${details}" shares no real vocabulary with the manager's actual message ("${rawText}") — treating as likely-hallucinated, discarding.`);
        details = null;
    }

    // Contacts directory first — a saved name→address match (or the manager
    // just typing a raw address) skips the mail search entirely. Ambiguous
    // (multiple saved names partially match) is the literal "are you
    // mentioning this?" case Apsara asked for: don't guess, ask which one.
    const emailContacts = require('../helpers/emailContacts');
    const resolvedContact = emailContacts.resolveContact(targetName);
    let to;
    let toSource = null;
    if (resolvedContact && resolvedContact.type === 'ambiguous') {
        // REAL GAP (found 2026-08-04, live): this used to just list matches
        // and tell her to "re-send with the exact name" — no pending was
        // ever staged, so a reply like "1" (or a close-but-not-exact retype,
        // e.g. "mk metals" for a saved "mkmetaltrading") went nowhere and
        // she had to retype the FULL exact saved name from scratch. Per
        // Apsara: "why should I give exact name... Jarvis should check mail
        // and show closest matches" — fixed by staging a real pending with
        // `options` set, which brain.js's section A already knows how to
        // resolve generically (numeric pick OR partial-text match against
        // the option strings) — same mechanism select_trucker/select_supplier
        // already use elsewhere in this file.
        const matches = resolvedContact.matches;
        const listText = matches.map((c, i) => `${i + 1}. ${c.name} <${c.email}>`).join('\n');
        const staged = await setPending(chatId, {
            type: 'await_contact_disambiguation',
            options: matches.map((c) => c.name),
            matches, target_name: targetName, details: details || '', bkg_no: bkgNo || null,
            scheduled_for: scheduledFor ? scheduledFor.toISOString() : null,
        });
        if (staged.queued) {
            await _send(chatId, `A few saved contacts match "${targetName}", but you have a pending "${staged.blockedBy}" to answer first. I'll ask which one once that's resolved.\n${listText}`);
            return { action_taken: 'email_contact_ambiguous_queued' };
        }
        await _send(chatId, `A few saved contacts match "${targetName}" — which one?\n${listText}\n\nReply with the number (or "cancel").`);
        return { action_taken: 'email_contact_ambiguous' };
    }
    if (resolvedContact) {
        to = resolvedContact.contact.email;
        toSource = 'contact';
    }

    if (!to) {
        try {
            to = await findLatestFrom(gmail, targetName);
        } catch (err) {
            console.error('[ACTIONS] findLatestFrom failed:', err.message);
        }
        if (to && !isValidEmail(to)) {
            console.warn(`[ACTIONS] findLatestFrom resolved a non-address for "${targetName}": "${to}" — discarding`);
            to = null;
        }
        if (to) {
            // REAL BUG (found 2026-08-04, live): a brand-new domain used to
            // get flat-saved under whatever address findLatestFrom happened
            // to pick — for mkmetaltrading that was export@mkmetaltrading.com
            // by a single-vote margin (4 vs 3) over marckang@mkmetaltrading.
            // com, a genuinely close contest, baked in with no review at
            // all. That's the exact flat-guessing problem the radmetals
            // domain-tree redesign exists to prevent — it just resurfaces
            // for every NEW domain unless checked here too. Per Apsara:
            // "it is Jarvis's responsibility, not mine" — this check runs
            // automatically on every fresh resolution, not only when she
            // remembers to say "learn X contacts" herself. One real sender
            // -> the plain flat save below is still correct and
            // proportionate. 2+ -> don't guess; stage the same propose-and-
            // confirm flow scripts/learnDomain.js and "learn X contacts" use,
            // then resume THIS exact request automatically once she's
            // confirmed it (same "don't lose the original ask" pattern as
            // await_manual_email_address/await_cc_pattern_confirm).
            const domain = to.split('@')[1];
            let handledAsDomainLearn = false;
            try {
                const { tallyAddressesForTerm } = require('../helpers/gmail');
                const { tally } = await tallyAddressesForTerm(gmail, domain, 50);
                const bareDomainTerm = domain.replace(/\.[a-z]+$/i, '');
                const proposals = emailContacts.proposeDomainRoles(tally, bareDomainTerm, domain);
                if (proposals.length > 1) {
                    handledAsDomainLearn = true;
                    return stageDomainProposal(chatId, targetName, domain, proposals,
                        { details: details || '', bkg_no: bkgNo || null, scheduled_for: scheduledFor ? scheduledFor.toISOString() : null },
                        `"${targetName}" resolved to ${domain}, which has ${proposals.length} real addresses, not just one — setting that up properly before sending anything.\n\n`);
                }
            } catch (err) {
                console.warn(`[ACTIONS] Multi-member domain check failed for "${domain}" — falling back to a plain flat save:`, err.message);
            }
            if (!handledAsDomainLearn) {
                // Learned a new address via mail search — save it so the
                // NEXT "email <name>" is an instant contacts hit instead of
                // another search. Save failure must never block the draft.
                emailContacts.addContact(targetName, to).catch((err) =>
                    console.warn(`[ACTIONS] Failed to save learned contact "${targetName}":`, err.message));
            }
        }
    }
    if (!to) {
        // REAL BUG (found 2026-08-03 via a live transcript): this used to
        // just send "give me the exact email address" and return, discarding
        // targetName/details/bkgNo entirely. The manager's very next message
        // (the address) then went through NORMAL intent classification
        // instead of being recognized as "the answer to what I just asked" —
        // it usually landed on a generic AI clarifying question ("what would
        // you like to email X about?"), silently dropping the original
        // request and forcing a full retype. Fixed the same way
        // await_container_number/await_relay_reply already solve this
        // exact class of problem elsewhere in this file: stage a pending
        // that captures the ENTIRE original request, so the next message —
        // whatever it is — is captured verbatim as the answer, not
        // re-classified from scratch. See brain.js's policyDecide() A0-tier
        // handling of 'await_manual_email_address'.
        const staged = await setPending(chatId, {
            type: 'await_manual_email_address',
            mode: 'draft', target_name: targetName, details: details || '', bkg_no: bkgNo || null,
            scheduled_for: scheduledFor ? scheduledFor.toISOString() : null,
        });
        if (staged.queued) {
            await _send(chatId, `Couldn't find a past email from "${targetName}" — no address to send to, and you already have a pending "${staged.blockedBy}" to answer first. I'll ask for ${targetName}'s address once that's resolved.`);
            return { action_taken: 'email_no_address_queued' };
        }
        await _send(chatId, `Couldn't find a past email from "${targetName}" — no address to send to. Give me the exact email address (or "cancel").`);
        return { action_taken: 'email_no_address' };
    }

    // REAL GAP (found 2026-08-04, live): "email Yurim to increase capacity
    // of booking DALA51952300" drafted as a brand-new, disconnected email
    // with an invented subject line, even though a real ongoing thread with
    // Yurim about that exact booking almost certainly already existed. Per
    // Apsara: "it should [be a] response to existing booking mail a?" — the
    // compose-fresh-vs-reply-in-thread split used to be decided purely by
    // which verb she typed ("email" vs "reply"), never by whether a thread
    // actually existed. Fix: whenever a booking number is given, check for a
    // real prior email involving THIS SPECIFIC resolved address (`to`) that
    // ALSO mentions this exact booking number — scoped to the address
    // already resolved above, so a booking number shared with multiple
    // parties (carrier, trucker, consignee, etc., each discussing the same
    // DALA number in their own separate thread) can't cross-contaminate:
    // Yurim's thread only matches if Yurim's own address is actually on it.
    // Found -> reply in that thread, same as an explicit "reply to X" would.
    // Not found (including no bkgNo at all) -> falls straight through to
    // compose-fresh below, exactly as before this fix.
    if (bkgNo) {
        try {
            const { getMessage, getEmailContent } = require('../helpers/gmail');
            // searchOwnThenBose — same reasoning as draftReplyForConfirm's
            // subject-hint search below: a thread with `to` about this
            // booking may live only in apsara's own mailbox (she emailed
            // them directly), invisible to a bose@-only search.
            const { messages: threadMsgs, gmail: threadGmail } = await searchOwnThenBose(`(from:${to} OR to:${to}) ${bkgNo}`, 1, gmail);
            if (threadMsgs.length) {
                const full = await getMessage(threadGmail, threadMsgs[0].id);
                const threadHdrs = Object.fromEntries((full.payload.headers || []).map((h) => [h.name, h.value]));
                const { body: threadBody } = getEmailContent(full.payload);
                const bkgForThread = getBooking(bkgNo);
                const threadBookingLine = bkgForThread
                    ? `Booking ${bkgForThread.booking_number}: carrier ${bkgForThread.carrier || '—'}, ERD ${bkgForThread.erd_date || '—'}, cutoff ${bkgForThread.cutoff_date || '—'}, POL ${bkgForThread.port_of_loading || '—'}, POD ${bkgForThread.port_of_discharge || '—'}.`
                    : '';
                const { cc: threadGlobalCc, bcc: threadBcc } = ccBccFromSettings();
                const threadCcForAddress = (addr) => emailContacts.loadContacts()
                    .find((c) => c.email.toLowerCase() === String(addr).toLowerCase())?.cc;
                return composeThreadReply(chatId, threadGmail, targetName, details, bkgNo, to,
                    threadHdrs.Subject || '', threadHdrs, threadBody, threadGlobalCc, threadBcc, threadCcForAddress, threadBookingLine, scheduledFor);
            }
        } catch (err) {
            console.warn(`[ACTIONS] Booking-thread lookup failed for ${to}/${bkgNo} — falling back to compose-fresh:`, err.message);
        }
    }

    // Cc-pattern detection — per Apsara: "when I mail T, there is always
    // same type of people I am cc'ing." Only runs for an ALREADY-SAVED
    // contact (toSource === 'contact') that hasn't been checked/declined
    // yet — deliberately skipped on a brand-new mail-search resolution to
    // avoid racing addContact's own fire-and-forget save above; it'll get
    // offered naturally the next time this same contact is emailed, once
    // the save has landed. Detection alone never touches anything — only a
    // "yes" (see resolvePending's await_cc_pattern_confirm case) saves it.
    if (toSource === 'contact' && !resolvedContact.contact.cc && !resolvedContact.contact.cc_declined) {
        let detectedCc = null;
        try {
            const { detectCcPattern, getMyEmailAddress } = require('../helpers/gmail');
            detectedCc = await detectCcPattern(gmail, to);
            // REAL BUG (found 2026-08-04, live): Michael Horowitz ended up
            // cc'd on an email TO Michael Horowitz — detectCcPattern read
            // this straight out of Apsara's real sent-mail history (some
            // past email apparently had his own address duplicated into
            // Cc), which is technically accurate data but never a sane
            // pattern to offer or save: nobody means to cc the person
            // they're already emailing. Strip the recipient's own address
            // (and, for the same reason, our own sending account) before
            // this is ever shown or saved — same self-exclusion draftReply-
            // ForConfirm already applies when preserving a thread's Cc list.
            if (detectedCc && detectedCc.length) {
                let myAddr = null;
                try { myAddr = await getMyEmailAddress(gmail); } catch (_) { /* best-effort */ }
                detectedCc = detectedCc.filter((addr) =>
                    addr.toLowerCase() !== String(to).toLowerCase() &&
                    (!myAddr || addr.toLowerCase() !== myAddr.toLowerCase())
                );
            }
        } catch (err) {
            console.warn(`[ACTIONS] Cc-pattern detection failed for "${targetName}":`, err.message);
        }
        if (detectedCc && detectedCc.length) {
            const staged = await setPending(chatId, {
                type: 'await_cc_pattern_confirm',
                target_name: targetName, details, bkg_no: bkgNo || null, to, to_source: toSource,
                detected_cc: detectedCc,
                scheduled_for: scheduledFor ? scheduledFor.toISOString() : null,
            });
            if (staged.queued) {
                await _send(chatId, `Noticed you always cc ${detectedCc.join(', ')} when emailing ${targetName}, but you have a pending "${staged.blockedBy}" first — I'll ask once that's resolved (and draft this email either way once it is).`);
                return { action_taken: 'cc_pattern_confirm_queued' };
            }
            await _send(chatId, `Noticed you always cc ${detectedCc.join(', ')} when emailing ${targetName} — save that as their standing cc for future emails? (yes/no — either way I'll draft this email next)`);
            return { action_taken: 'cc_pattern_confirm_staged' };
        }
    }

    return draftEmailWithAddress(chatId, targetName, details, bkgNo, to, toSource, scheduledFor);
}

// Shared drafting tail — called once an address is known, whether resolved
// via contacts, mail search, or (after the await_manual_email_address
// pending above) typed directly by the manager. Factored out 2026-08-03 so
// all three paths produce an identical draft/preview/confirm flow instead of
// three slightly-diverging copies.
async function draftEmailWithAddress(chatId, targetName, details, bkgNo, to, toSource, scheduledFor = null) {
    const { callGeminiJSON } = require('../helpers/gemini');
    const bkg = bkgNo ? getBooking(bkgNo) : null;
    const bookingLine = bkg
        ? `Booking ${bkg.booking_number}: carrier ${bkg.carrier || '—'}, ERD ${bkg.erd_date || '—'}, cutoff ${bkg.cutoff_date || '—'}, POL ${bkg.port_of_loading || '—'}, POD ${bkg.port_of_discharge || '—'}.`
        : '';

    // REAL BUG (found 2026-08-03, live: "email radmetals checking in" with
    // no further detail produced a content-free "we miss working with you,
    // hope all is well" filler). Root cause: when details is empty, the old
    // prompt told Gemini to "infer a reasonable request from context" but
    // never actually GAVE it any context — draftEmailForConfirm never
    // fetched mail history for a fresh compose (only reply_email did,
    // since it's anchored to one specific message already). Fix: when
    // details is missing/blank, pull the most recent real correspondence
    // with this address and hand Gemini something actually informed to
    // work from, instead of inventing small talk. Skipped entirely when
    // details IS specific — old mail would just be noise there, not signal.
    let recentContext = '';
    if (!details || !details.trim()) {
        try {
            const { getGmailRead, listMessages, getMessage, getEmailContent } = require('../helpers/gmail');
            const gmail = getGmailRead();
            const msgs = await listMessages(gmail, `(from:${to} OR to:${to})`, 2);
            if (msgs.length) {
                const full = await getMessage(gmail, msgs[0].id);
                const hdrs = Object.fromEntries((full.payload.headers || []).map((h) => [h.name, h.value]));
                const { body } = getEmailContent(full.payload);
                recentContext = `Subject: "${hdrs.Subject || ''}" — excerpt: "${(body || '').slice(0, 400).replace(/\s+/g, ' ').trim()}"`;
            }
        } catch (err) {
            console.warn(`[ACTIONS] Couldn't fetch recent-correspondence context for ${targetName}:`, err.message);
        }
    }

    // REAL BUG (found 2026-08-04, live): drafts greeted "Dear export" (or
    // "Dear mkmetaltrading") because targetName is only ever a short typed
    // lookup key ("export", or whatever the manager typed), never a real
    // name. Looked up by address (not name) since "manual" toSource entries
    // won't have a contact record with that exact key. displayName (the
    // actual "Marc Kang"-style name captured from the address's own mail —
    // see proposeDomainRoles/tallyAddressesForTerm) is used for the
    // greeting when known; falls back to targetName otherwise, same as
    // before this fix, so nothing regresses for a contact with no captured
    // display name yet.
    const contactRecord = require('../helpers/emailContacts').loadContacts()
        .find((c) => c.email.toLowerCase() === String(to).toLowerCase());
    const greetingName = contactRecord?.displayName || targetName;

    const prompt = `Draft a short, professional freight-ops email from Edge Metals Inc. to a carrier/vendor contact.
${todayDateContext()}
Recipient: ${greetingName}
What the email needs to say: ${details || (recentContext
        ? 'No specific ask was given — write a brief, genuinely relevant follow-up grounded in the recent correspondence below (e.g. reference what it was actually about). Do NOT write generic filler like "just checking in" or "hope all is well" with no real content.'
        : 'No specific ask was given and no past correspondence was found either — ask a brief, concrete question (e.g. current pricing/availability) rather than pure small talk.')}
${recentContext ? `Most recent past email with them, for context (use only what's actually relevant): ${recentContext}` : ''}
${bookingLine ? `Relevant booking data (use only what's relevant, do not dump all of it): ${bookingLine}` : ''}
Return ONLY this JSON: { "subject": "short subject line", "body": "email body, plain text, no markdown, sign off as Edge Metals Inc." }`;

    const draft = await callGeminiJSON(prompt);
    if (!draft || !draft.subject || !draft.body) {
        await _send(chatId, "Couldn't draft that email — try rephrasing what it should say.");
        return { action_taken: 'email_draft_failed' };
    }

    const { cc: globalCc, bcc } = ccBccFromSettings();
    // Merge the global Cc with this contact's own standing Cc (if any),
    // deduped — per Apsara's explicit instruction. Reuses the contactRecord
    // already looked up above for the greeting.
    const cc = mergeCc(globalCc, contactRecord?.cc);
    // Same reasoning as showBookingStatus/searchMail — registers this
    // booking as the active conversational context so a follow-up like
    // "any change in cutoff?" scopes to it instead of answering generically.
    if (bkgNo) updateSession(chatId, { activeBooking: bkgNo, currentTopic: 'email' });
    const staged = await setPending(chatId, {
        type: 'await_email_confirm',
        to, cc, bcc, subject: draft.subject, body: draft.body,
        target_name: targetName, bkg_no: bkgNo || null,
        scheduled_for: scheduledFor ? scheduledFor.toISOString() : null,
    });
    const whenSuffix = scheduledFor ? ` at ${formatScheduledFor(scheduledFor)}` : '';
    if (staged.queued) {
        // Don't show a live "Send this? (yes/no)" prompt for something that
        // isn't actually the active pending yet — see setPending's own
        // comment for why silently overwriting the real one is worse.
        await _send(chatId,
            `Drafted the email to ${targetName} <${to}>${toSource === 'contact' ? ' (saved contact)' : ''} — but you have a pending "${staged.blockedBy}" to answer first. I'll ask you to confirm sending this${whenSuffix ? ` (scheduled${whenSuffix})` : ''} once that's resolved.`
        );
        return { action_taken: 'email_draft_queued' };
    }
    await _send(chatId,
        `Draft email to ${targetName} <${to}>${toSource === 'contact' ? ' (saved contact — reply "no" if that\'s the wrong one)' : ''}:\n${ccBccPreviewLine({ cc, bcc })}\nSubject: ${draft.subject}\n\n${draft.body}\n\nSend this${whenSuffix}? (yes/no)`
    );
    return { action_taken: 'email_draft_staged' };
}

// Only ever called from brain.js's route() when an 'await_manual_email_address'
// pending is active — see brain.js's policyDecide() A0-tier handling for why
// this exists (fixes the real "asked for address, then lost the original
// request" bug). Whatever the manager just typed is captured VERBATIM as the
// candidate address, same pattern as recordContainerNumber/relayReplyReceived.
async function resolveManualEmailAddress(chatId, addressText) {
    const pending = getPending(chatId);
    if (!pending || pending.type !== 'await_manual_email_address') {
        // Shouldn't happen — brain.js only routes here while this exact
        // pending is active — but never silently proceed on a stale/missing
        // pending with no target to draft to.
        console.warn('[ACTIONS] resolveManualEmailAddress called with no matching pending — ignoring');
        return { action_taken: 'manual_email_address_no_pending' };
    }

    const addr = String(addressText || '').trim();
    if (/^cancel$/i.test(addr)) {
        await clearPending(chatId);
        await _send(chatId, 'Cancelled — no email drafted.');
        return { action_taken: 'manual_email_address_cancelled' };
    }
    if (!isValidEmail(addr)) {
        // Deliberately does NOT clear the pending — same "keep asking until
        // it's valid or cancelled" behavior a human assistant would use.
        await _send(chatId, `"${addr}" doesn't look like a valid email address — try again, or reply "cancel".`);
        return { action_taken: 'manual_email_address_invalid' };
    }

    await clearPending(chatId);
    // The manager just typed this address specifically for this name — the
    // highest-confidence signal of all three save points in this file, so
    // it's always worth saving. Failure must never block the actual draft.
    require('../helpers/emailContacts').addContact(pending.target_name, addr).catch((err) =>
        console.warn(`[ACTIONS] Failed to save manually-given contact "${pending.target_name}":`, err.message));

    return draftEmailWithAddress(chatId, pending.target_name, pending.details, pending.bkg_no, addr, 'manual',
        pending.scheduled_for ? new Date(pending.scheduled_for) : null);
}

// ── Domain-tree contact learning ("learn radmetals contacts") ──────────────
// Built 2026-08-03 after Apsara pushed back on a CLI-only version of this
// ("why am I running scripts?") — every other detect-then-confirm action in
// this app (cc patterns, cutoff backfill) happens through WhatsApp, so this
// should too. Scans real mail via helpers/gmail.js's tallyAddressesForTerm,
// proposes roles via helpers/emailContacts.js's proposeDomainRoles — the
// SAME function scripts/learnDomain.js's CLI version uses, so the two can
// never silently disagree — and never writes anything without a confirm,
// same posture as detectCcPattern/await_cc_pattern_confirm.
async function learnDomainForConfirm(chatId, term) {
    const { getGmailRead, tallyAddressesForTerm } = require('../helpers/gmail');
    const emailContacts = require('../helpers/emailContacts');

    let gmail;
    try {
        gmail = getGmailRead();
    } catch (err) {
        await _send(chatId, `Can't scan mail — Gmail isn't configured (${err.message}).`);
        return { action_taken: 'domain_learn_gmail_unavailable' };
    }

    const domain = emailContacts.normalizeDomain(term);
    const { messages, tally } = await tallyAddressesForTerm(gmail, term, 50);
    const proposals = emailContacts.proposeDomainRoles(tally, term, domain);

    if (!proposals.length) {
        await _send(chatId, `Couldn't find any addresses under @${domain} in the last ${messages.length} matching messages — nothing to learn.`);
        return { action_taken: 'domain_learn_empty' };
    }

    return stageDomainProposal(chatId, term, domain, proposals, null, '');
}

// resume: null for an explicit "learn X contacts" command, or
// { details, bkg_no } to automatically continue the original draft-email
// request once the domain's set up — see draftEmailForConfirm's multi-member
// check (built 2026-08-04, per Apsara: "it is Jarvis's responsibility, not
// mine") for why this exists. intro: optional extra sentence prepended to
// the first message shown, explaining WHY this fired (only used by that
// auto-triggered path — the explicit command doesn't need it).
async function stageDomainProposal(chatId, term, domain, proposals, resume, intro) {
    const needsName = proposals.filter((p) => !p.name);
    if (needsName.length) {
        const summary = proposals.map((p) =>
            `${p.name || '???'} <${p.addr}> — From=${p.counts.from} Cc=${p.counts.cc} To=${p.counts.to} -> ${p.role}`
        ).join('\n');
        const staged = await setPending(chatId, {
            type: 'await_domain_learn_name',
            term, domain, proposals, resume,
            needs_name: needsName.map((p) => p.addr),
        });
        if (staged.queued) {
            await _send(chatId, `${intro || ''}Scanned ${domain} — found ${proposals.length} address(es), but you have a pending "${staged.blockedBy}" to answer first. I'll ask for the missing name once that's resolved.`);
            return { action_taken: 'domain_learn_name_queued' };
        }
        await _send(chatId,
            `${intro || ''}Learning ${domain} contacts:\n${summary}\n\n` +
            `${needsName.map((p) => p.addr).join(', ')} needs a name — its local-part is identical to "${term}" itself, so I won't guess a label for it. What should I call ${needsName.length > 1 ? 'these (comma-separated, same order)' : 'this address'}? Or reply "cancel".`
        );
        return { action_taken: 'domain_learn_needs_name' };
    }

    return stageDomainLearnConfirm(chatId, term, domain, proposals, resume, intro);
}

// Shared by stageDomainProposal (when no names are missing) and
// resolveDomainLearnName (once the missing ones are filled in) — the final
// yes/no gate before anything actually gets written. See the
// 'await_domain_learn_confirm' case in resolvePending below for the save
// (and how `resume`, if present, continues the original email afterward).
async function stageDomainLearnConfirm(chatId, term, domain, proposals, resume, intro) {
    const summary = proposals.map((p) =>
        `${p.name}${p.displayName ? ` (${p.displayName})` : ' (no real name found in mail)'} <${p.addr}> -> ${p.role}`
    ).join('\n');
    const staged = await setPending(chatId, { type: 'await_domain_learn_confirm', term, domain, proposals, resume });
    if (staged.queued) {
        await _send(chatId, `${intro || ''}Ready to save ${domain} contacts, but you have a pending "${staged.blockedBy}" to answer first. I'll ask once that's resolved.`);
        return { action_taken: 'domain_learn_confirm_queued' };
    }
    await _send(chatId,
        `${intro || ''}Save these ${domain} contacts?\n${summary}\n\n` +
        `(Primary = who "mail ${term}" resolves to by default. Everyone here gets auto-cc'd on emails to anyone else in the group.)\n\n` +
        (resume ? 'yes/no — either way I\'ll continue your original email next' : 'yes/no')
    );
    return { action_taken: 'domain_learn_confirm_staged' };
}

// Only ever called from brain.js while 'await_domain_learn_name' is active —
// same "capture verbatim, no reclassification" pattern as
// resolveManualEmailAddress/recordContainerNumber above.
async function resolveDomainLearnName(chatId, nameText) {
    const pending = getPending(chatId);
    if (!pending || pending.type !== 'await_domain_learn_name') {
        console.warn('[ACTIONS] resolveDomainLearnName called with no matching pending — ignoring');
        return { action_taken: 'domain_learn_name_no_pending' };
    }
    const text = String(nameText || '').trim();
    if (/^cancel$/i.test(text)) {
        await clearPending(chatId);
        await _send(chatId, 'Cancelled — nothing saved.');
        return { action_taken: 'domain_learn_name_cancelled' };
    }

    const names = text.split(',').map((s) => s.trim()).filter(Boolean);
    const needs = pending.needs_name || [];
    if (names.length < needs.length) {
        await _send(chatId, `Need a name for ${needs.length} address(es) (${needs.join(', ')}) — reply with ${needs.length > 1 ? 'all of them, comma-separated, in that order' : 'one'}, or "cancel".`);
        return { action_taken: 'domain_learn_name_incomplete' };
    }

    const proposals = pending.proposals.map((p) => ({ ...p }));
    needs.forEach((addr, i) => {
        const p = proposals.find((x) => x.addr === addr);
        if (p) p.name = names[i];
    });

    await clearPending(chatId);
    return stageDomainLearnConfirm(chatId, pending.term, pending.domain, proposals, pending.resume || null, '');
}

// Only ever called from resolvePending after an explicit "yes" — see the
// 'await_email_confirm' case below. Never called directly from brain.js.
async function sendDraftedEmail(chatId, pending) {
    const { sendEmail } = require('../helpers/gmail');
    // Forward FIRST, so that by the time the reply lands in her mailbox the
    // message it is replying to is already sitting there — otherwise Gmail
    // shows a reply with nothing above it for however long the forward takes
    // to arrive. Ordering only, no dependency: the reply goes out regardless.
    let forwarded = null;
    if (pending.forward_original) {
        forwarded = await forwardOriginalToSelf(pending.forward_original);
    }
    try {
        // inReplyTo/references are only present when this pending came from
        // draftReplyForConfirm (below) — undefined for a plain
        // draftEmailForConfirm compose, and buildMimeMessage already treats
        // those as "new thread, no reply headers." sendEmail sends via
        // apsara's account regardless — no threadId is ever passed, since a
        // threadId captured from bose's mailbox (where the original lived)
        // is meaningless on a different account's send.
        const sent = await sendEmail({
            to: pending.to, cc: pending.cc, bcc: pending.bcc, subject: pending.subject, body: pending.body,
            inReplyTo: pending.inReplyTo, references: pending.references,
        });
        // REAL GAP (found 2026-08-06, live — Apsara: "notification bell icon
        // in website for reply thread"): this send's threadId used to be
        // discarded on the spot — nothing outside quote requests ever
        // tracked "did this email get a reply." Track it here (apsara's own
        // account sent it, so the SAME account's read-scoped token can poll
        // it later — see helpers/emailThreads.js's own header for why this
        // is a separate, simpler store from quote_requests.json).
        require('../helpers/emailThreads').trackSentEmail({
            threadId: sent?.threadId, to: pending.to, targetName: pending.target_name,
            subject: pending.subject, bkgNo: pending.bkg_no,
        }).catch((e) => console.error('[ACTIONS] emailThreads.trackSentEmail failed (non-fatal):', e.message));
        // Report both parts honestly. A silent partial success ("Sent.") when
        // the forward failed would leave her expecting a copy in her inbox
        // that never arrives, and quietly wondering later whether the reply
        // went at all.
        let note = '';
        if (pending.forward_original) {
            note = forwarded
                ? ' Forwarded the original to your inbox too, so the thread reads in order.'
                : " Couldn't forward the original copy to your inbox — the reply itself went fine.";
        }
        await _send(chatId, `Sent to ${pending.target_name} <${pending.to}>.${note}`);
        return { action_taken: 'email_sent', forwarded: !!forwarded };
    } catch (err) {
        console.error('[ACTIONS] sendEmail failed:', err.message);
        await _send(chatId, `Send failed: ${err.message}. Not retried automatically — try again.`);
        return { action_taken: 'email_send_failed' };
    }
}

// Scheduled-send counterpart to sendDraftedEmail — same "yes" confirm, but
// instead of sending now, hands the fully-drafted email off to
// helpers/tasks.js's existing persistent task queue (already deployed and
// running every minute via scheduler.js's taskRunner — see that function's
// 'scheduled_email' branch for the actual send at fire time). Per Apsara's
// explicit choice: confirm content now, auto-send at the scheduled time, no
// second confirmation — same UX as Gmail's own "Schedule send." The manager
// is NOT notified again until it actually fires (success or failure);
// nothing further to approve between now and then.
async function scheduleDraftedEmail(chatId, pending) {
    const tasks = require('../helpers/tasks');
    const emailPayload = {
        to: pending.to, cc: pending.cc, bcc: pending.bcc, subject: pending.subject, body: pending.body,
        inReplyTo: pending.inReplyTo, references: pending.references,
        target_name: pending.target_name,
    };
    await tasks.enqueue({
        type: 'scheduled_email',
        // When SHE approved this content. The staleness guard in
        // helpers/scheduledEmailGuard.js compares the thread against this
        // moment at fire time — anything that arrived after she said yes is
        // what she has not seen. Stored explicitly rather than relying on
        // created_at, so the meaning stays "approved at" even if the task
        // record is ever re-enqueued or migrated.
        approved_at: new Date().toISOString(),
        // 'direct_chat' — deliberately NOT 'manager': scheduler.js's
        // taskRunner overrides target_kind:'manager' with whatever the
        // globally configured manager_number setting is, which may not be
        // the exact chat she typed this in from (a team group vs a 1:1,
        // etc.). This needs to notify the SAME chat she asked from, so it
        // uses a target_kind that falls through to target_chat as-is.
        target_kind: 'direct_chat',
        target_chat: chatId,
        bkg_no: pending.bkg_no || null,
        email_payload: emailPayload,
        message: `Scheduled email to ${pending.target_name} <${pending.to}>: ${pending.subject}`,
        fire_at: pending.scheduled_for,
    });
    await _send(chatId, `Scheduled — will send to ${pending.target_name} <${pending.to}> at ${formatScheduledFor(new Date(pending.scheduled_for))}.`);
    return { action_taken: 'email_scheduled' };
}

// REAL BUG (found 2026-08-04, live): with an already-drafted "send this
// email to Mathew? yes/no" pending active, "Schedule this mail @7am LA
// time" was being reclassified as a brand-new email request from scratch —
// found the SAME still-unresolved pending and just queued a second,
// redundant draft behind it. brain.js's Section A now catches "schedule"
// phrasing while an await_email_confirm is active and routes here directly
// instead of letting it fall through to general classification. Reuses the
// ALREADY-DRAFTED to/cc/bcc/subject/body/inReplyTo/references exactly as
// they were confirmed-and-shown — this never re-resolves the recipient or
// re-drafts content, it only decides WHEN to send it.
async function reschedulePendingEmail(chatId, pending, sendAtText) {
    if (!pending || pending.type !== 'await_email_confirm') {
        console.warn('[ACTIONS] reschedulePendingEmail called with no matching pending — ignoring');
        return { action_taken: 'reschedule_no_pending' };
    }
    const scheduledFor = resolveScheduledFor(sendAtText);
    if (!scheduledFor) {
        // Deliberately does NOT clear the pending — same "keep asking until
        // it's valid or cancelled" posture as resolveManualEmailAddress.
        // The original draft is still sitting there waiting for yes/no/a
        // valid schedule time.
        await _send(chatId, `Didn't catch a time in "${sendAtText}" — try something like "schedule this at 7am LA time", or just reply yes/no.`);
        return { action_taken: 'reschedule_unparseable' };
    }
    await clearPending(chatId);
    return scheduleDraftedEmail(chatId, { ...pending, scheduled_for: scheduledFor.toISOString() });
}

// ── Read-only mail search ("did Zimex reply about DALA123 cutoff") ──────────
// No pending/confirmation gate — unlike draft_email, this never changes
// anything or reaches a third party. It's the same risk class as any other
// "answer a question from data we have" action, just sourced from Gmail
// instead of bookings.json. Reuses "note" (already used by ask_contact for
// free-text) for the search topic instead of adding another schema field.
// On-demand "what needs my reply" — the same scan workflow/replyWatch.js
// runs hourly, triggered by her asking instead of by the clock.
//
// dryRun:true so replyWatch does NOT also fire its own WhatsApp digest: she
// asked here, so the answer belongs in this conversation as a direct reply.
// Without it she would get the reply AND a duplicate digest moments later.
//
// Note this reads only what the hourly scan has not already assessed —
// replyWatch dedupes on message id, so anything flagged in an earlier digest
// today will not be repeated here. That is deliberate (a digest that repeats
// itself gets ignored), but it does mean "nothing waiting" can mean "nothing
// NEW waiting" — so the empty case says exactly that rather than implying a
// clean inbox.
// "reply to 2" / "reply to 2: confirmed for Friday" — answers one entry from
// the last digest without her retyping the sender's name.
//
// This resolves the NUMBER to a sender and then hands straight off to
// draftReplyForConfirm, the same function "reply to Zimex about X" already
// uses. No new send path: Jarvis drafts, shows the full text, and sends only
// on an explicit yes. That is the whole point — she asked for confirmed
// sending, not autonomous sending.
async function replyToDigestItem(chatId, index, details, rawText) {
    const { resolveDigestIndex } = require('./replyWatch');
    let item = null;
    try { item = resolveDigestIndex(index); }
    catch (e) { console.error('[ACTIONS] resolveDigestIndex failed:', e.message); }

    // Out of range or a stale digest — ask rather than guess. Replying to the
    // wrong customer is far worse than one extra question.
    if (!item) {
        await _send(chatId, `I don't have a #${index} from a recent digest. Ask "what needs my reply" for a fresh list, or name them directly — e.g. "reply to Zimex: confirmed for Friday".`);
        return { action_taken: 'digest_reply_unknown_index' };
    }

    // Pass the SENDER as the target and let draftReplyForConfirm find the
    // real thread itself, exactly as it does for a named reply. Deliberately
    // not short-circuiting to the stored threadId: that function already
    // handles thread lookup, address validation and the hallucinated-address
    // guards, and duplicating any of that here would mean two code paths to
    // keep correct.
    const target = item.from || item.fromName;
    return draftReplyForConfirm(chatId, target, details || null, null, rawText || `reply to ${target}`, null);
}

async function showPendingReplies(chatId) {
    try {
        const { run, buildDigest } = require('./replyWatch');
        const result = await run({ dryRun: true });
        if (result.skipped === 'no-gmail') {
            await send(chatId, "I can't check mail right now — Gmail isn't authorized on this server.");
            return { action_taken: 'pending_replies_no_gmail' };
        }
        if (result.error) {
            await send(chatId, `Couldn't read the inbox: ${result.error}`);
            return { action_taken: 'pending_replies_failed' };
        }
        if (!result.items || !result.items.length) {
            await send(chatId, `Checked ${result.checked} new email${result.checked === 1 ? '' : 's'} — nothing new waiting on a reply from you.`);
            return { action_taken: 'pending_replies_none' };
        }
        await send(chatId, buildDigest(result.items));
        return { action_taken: 'pending_replies_reported', count: result.items.length };
    } catch (err) {
        console.error('[ACTIONS] showPendingReplies failed:', err.message);
        await send(chatId, `Couldn't check the inbox: ${err.message}`);
        return { action_taken: 'pending_replies_failed' };
    }
}

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

    // (from:X OR X), not just from:X — Gmail's from: operator needs X to
    // match as its own token, and a company name is very often only part
    // of a longer domain (e.g. "zimex" inside "zimexglt.com" — NOT the
    // same as the standalone word "zimex" appearing in a signature block
    // like "Zimex GLT, Inc."). Real incident: from:zimex on its own missed
    // a genuine Zimex email entirely because of exactly this. The bare
    // term catches it via full-text match instead of relying on the
    // header operator alone.
    const terms = [];
    if (targetName) terms.push(`(from:${targetName} OR ${targetName})`);
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
    // Registers this booking as the conversation's active context — same as
    // showBookingStatus does — so a natural follow-up like "any change in
    // cutoff?" resolves against THIS booking instead of falling through to
    // a generic answer with no booking scope at all.
    if (bkgNo) updateSession(chatId, { activeBooking: bkgNo, currentTopic: 'email' });
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

// REAL BUG (found 2026-08-04, live): "...it should a reply to
// subject:Loading schedule from LA to Humble-8/4 @7am" — the manager gave
// the EXACT subject of the thread to reply to, but the search below only
// ever looked at from:targetName, completely ignoring it. Gmail's own
// relevance ranking then surfaced a DIFFERENT, unrelated message that just
// happened to mention the target's name, isDirectSender came back false,
// and the forward-extraction fallback invented a fabricated subject/
// content ("Inquiry Regarding Trucker Location - PO 12345" — no PO 12345
// anywhere in her request) out of irrelevant context. Grounded by
// construction, same as extractScheduleClause — the captured text IS a
// literal substring of what she actually typed.
function extractSubjectHint(rawText) {
    const m = String(rawText || '').match(/subj(?:ect)?\s*:\s*(.+?)\s*$/i);
    return m ? m[1].trim() : null;
}

async function draftReplyForConfirm(chatId, targetName, details, bkgNo, rawText, sendAtText) {
    if (!targetName) {
        await _send(chatId, 'Reply to who? Give me a name or company, e.g. "reply to Zimex about DALA123: confirmed".');
        return { action_taken: 'reply_missing_target' };
    }
    const scheduledFor = resolveScheduledFor(sendAtText);
    const { getGmailRead, listMessages, getMessage, getEmailContent } = require('../helpers/gmail');
    const { callGeminiJSON } = require('../helpers/gemini');

    let gmail;
    try {
        gmail = getGmailRead();
    } catch (err) {
        await _send(chatId, `Can't reply — Gmail isn't configured (${err.message}).`);
        return { action_taken: 'reply_gmail_unavailable' };
    }

    // Same hallucinated-address guard as draftEmailForConfirm — see the long
    // comment there (real bug, 2026-08-03: AI invented "mike@example.com"
    // for a bare "Mike"). If target_name looks like an email but that exact
    // string wasn't in what the manager actually typed, it's not trustworthy.
    targetName = String(targetName).trim();
    if (isValidEmail(targetName) && rawText && !String(rawText).toLowerCase().includes(targetName.toLowerCase())) {
        console.warn(`[ACTIONS] target_name "${targetName}" looks like an email but wasn't in the manager's actual message ("${rawText}") — treating as an unverified/likely-hallucinated value, not an address.`);
        targetName = targetName.split('@')[0];
    }
    // Same "AI reformatted a single word into spaced-out words" defense as
    // draftEmailForConfirm — see deReformatTargetName's own comment (real
    // incident: "mkmetaltrading" -> "mk metal trading").
    targetName = deReformatTargetName(targetName, rawText);
    // Same defense for email_details as draftEmailForConfirm — see
    // detailsLookGrounded's own comment (real incident: fabricated "I miss
    // you" content for a message that specified nothing).
    if (details && rawText && !detailsLookGrounded(rawText, details)) {
        console.warn(`[ACTIONS] email_details "${details}" shares no real vocabulary with the manager's actual message ("${rawText}") — treating as likely-hallucinated, discarding.`);
        details = null;
    }

    // Two passes, direct-first: a from:X search only ever matches a REAL
    // direct email — if that finds something, use it, don't even look at
    // the broader query. Only fall back to (from:X OR X) — which also
    // matches X merely quoted inside a forward's body — when no direct
    // email exists. Without this ordering, a genuine direct thread could
    // lose to an unrelated forward just because Gmail's own relevance
    // ranking on the combined OR query happened to rank the forward first.
    const bkgTerm = bkgNo ? ` ${bkgNo}` : '';
    const subjectHint = extractSubjectHint(rawText);
    // foundSource tracks WHICH mailbox actually answered, so the reply path
    // can tell "this thread is only in bose@" from "this thread is in
    // apsara@ too". Defaults to 'bose' because `gmail` here IS the bose
    // client — searchOwnThenBose overwrites it when apsara@ answers.
    let messages, searchGmail = gmail, foundSource = 'bose';
    try {
        if (subjectHint) {
            // REAL BUG (found 2026-08-04, live): originally scoped this to
            // (from:X OR to:X) alongside the subject, reasoning that would
            // stop an unrelated same-subject thread from matching. Per
            // Apsara, live: "Don't just check from matthew. Check for
            // subject if given" — that scoping is exactly what broke it.
            // The saved/typed name isn't always how the real thread's
            // From/To header actually reads (could be a group mailbox, a
            // CC'd colleague who actually sent it, a slightly different
            // saved spelling, etc.) — an explicit subject given BY HER is
            // already a strong, specific-enough signal on its own; AND-ing
            // in a name match can only ever eliminate matches, never help
            // find one. Search by subject alone now — exact quoted phrase
            // first, then a looser word match if she paraphrased slightly.
            //
            // REAL GAP (found 2026-08-05, live): "reply to subject: Loading
            // schedule from LA to Humble-8/4 @7am" — that thread was one
            // Apsara started herself, straight from apsara@edgemetals.com,
            // and never touched bose@'s inbox. Since this search only ever
            // checked bose@ (via getGmailRead()), it either found nothing or
            // — worse — matched some unrelated message off a coincidental
            // subject/word overlap and threaded the reply onto the WRONG
            // conversation's Message-ID chain. searchOwnThenBose() below
            // checks apsara's own mailbox first (if that token's been set
            // up — see helpers/gmail.js's getGmailSenderRead()), since a
            // thread she's asking to reply to is very likely one she's
            // personally on, before falling back to bose@ for carrier-
            // initiated booking mail that never reached her directly.
            let result = await searchOwnThenBose(`subject:"${subjectHint}"`, 3, gmail);
            if (!result.messages.length) {
                const words = subjectHint.replace(/[^a-z0-9 ]/gi, ' ').split(/\s+/).filter((w) => w.length > 2);
                if (words.length) {
                    result = await searchOwnThenBose(`subject:(${words.join(' ')})`, 3, gmail);
                }
            }
            messages = result.messages;
            searchGmail = result.gmail;
            foundSource = result.source || 'bose';
            if (!messages.length) {
                // Deliberately does NOT fall back to the generic from:name
                // search here — she gave a SPECIFIC subject because she
                // wants THAT thread, not whatever a broader search happens
                // to surface (that's exactly how the fabricated-content bug
                // above happened). Ask instead of guessing.
                await _send(chatId, `Couldn't find an email with subject "${subjectHint}" anywhere in mail — check the exact subject, or tell me to search more broadly.`);
                return { action_taken: 'reply_subject_not_found' };
            }
        } else {
            let result = await searchOwnThenBose(`from:${targetName}${bkgTerm}`, 3, gmail);
            if (!result.messages.length) {
                result = await searchOwnThenBose(`(from:${targetName} OR ${targetName})${bkgTerm}`, 3, gmail);
            }
            messages = result.messages;
            searchGmail = result.gmail;
            foundSource = result.source || 'bose';
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

    // NOT `gmail` — must be whichever account (apsara's own mailbox or
    // bose@) actually found this match. Message IDs aren't portable across
    // accounts; using the wrong client here throws or fetches nothing.
    const full = await getMessage(searchGmail, messages[0].id);
    const hdrs = Object.fromEntries((full.payload.headers || []).map((h) => [h.name, h.value]));
    let fromAddr = (hdrs.From || '').match(/<([^>]+)>/)?.[1] || hdrs.From;

    // REAL GAP (found 2026-08-05, alongside the own-mailbox search fix
    // above): searchOwnThenBose() can now return a message APSARA HERSELF
    // sent — e.g. the exact "Loading schedule" email she originally wrote
    // to Matthew, found in her own mailbox. fromAddr in that case is
    // APSARA'S OWN address, not the target's — using it as the reply-to
    // would draft a reply back to ourselves instead of to Matthew. If the
    // found message's From is our own sending account, the real recipient
    // is on the To/Cc line instead.
    try {
        const { getMyEmailAddress, parseAddressList } = require('../helpers/gmail');
        const myAddr = await getMyEmailAddress(searchGmail).catch(() => null);
        if (myAddr && fromAddr && fromAddr.toLowerCase() === myAddr.toLowerCase()) {
            const recipients = [...parseAddressList(hdrs.To), ...parseAddressList(hdrs.Cc)];
            const emailContactsForRecipient = require('../helpers/emailContacts');
            const savedForRecipient = emailContactsForRecipient.resolveContact(targetName);
            const savedRecipientAddr = savedForRecipient && savedForRecipient.type !== 'ambiguous' ? savedForRecipient.contact?.email : null;
            const picked = (savedRecipientAddr && recipients.find((r) => r.toLowerCase() === savedRecipientAddr.toLowerCase()))
                || recipients.find((r) => r.toLowerCase().includes(targetName.toLowerCase()))
                || recipients[0] || null;
            if (picked) {
                console.log(`[ACTIONS] Found message was self-sent (From: ${fromAddr}) — using recipient ${picked} from To/Cc instead`);
                fromAddr = picked;
            }
        }
    } catch (err) {
        console.warn('[ACTIONS] Self-sent-message recipient resolution failed — continuing with From header as-is:', err.message);
    }

    const origSubject = hdrs.Subject || '';
    const { body: origBody } = getEmailContent(full.payload);
    const { cc: globalCc, bcc } = ccBccFromSettings();
    const loadEmailContacts = () => require('../helpers/emailContacts').loadContacts();
    const ccForAddress = (addr) => loadEmailContacts().find((c) => c.email.toLowerCase() === String(addr).toLowerCase())?.cc;

    const bkg = bkgNo ? getBooking(bkgNo) : null;
    const bookingLine = bkg
        ? `Booking ${bkg.booking_number}: carrier ${bkg.carrier || '—'}, ERD ${bkg.erd_date || '—'}, cutoff ${bkg.cutoff_date || '—'}.`
        : '';

    // Is the message's ACTUAL sender the target, or does the target's name
    // just appear somewhere in a forwarded/quoted body? Header match =
    // direct email, real thread to reply into. No match = treat as a
    // forward (or any other indirect mention) and compose fresh instead.
    //
    // REAL BUG, TWO LAYERS (found 2026-08-04, live). Layer 1: this only
    // checked the extracted ADDRESS (fromAddr) against targetName — for
    // "Mathew <whittakerm@schneider.com>" that's "whittakerm@schneider.
    // com", which doesn't contain "mathew" (corporate convention: lastname
    // + first initial, not firstname). Fixed by ALSO checking the raw
    // header (display name included). Layer 2, found immediately after —
    // even that still failed on the exact same real case, because the
    // manager had been typing "Mathew" (one T) the whole time and the real
    // contact's name is "Matthew" (two Ts) — a one-letter typo that makes
    // ANY substring match against a name fundamentally unreliable, no
    // matter which header field it checks. Per Apsara, live: "Even then
    // your logic was wrong." Fixed properly this time: cross-check the
    // message's fromAddr against whatever address is ALREADY SAVED for
    // this name in contacts — an exact address match doesn't care how the
    // name is spelled either way, since it never compares names at all.
    // This is the primary signal now; the header-substring check stays
    // only as a fallback for a target with no saved contact yet.
    const emailContacts = require('../helpers/emailContacts');
    const savedForTarget = emailContacts.resolveContact(targetName);
    const savedAddr = savedForTarget && savedForTarget.type !== 'ambiguous' ? savedForTarget.contact?.email : null;
    const isDirectSender = (savedAddr && fromAddr && savedAddr.toLowerCase() === String(fromAddr).toLowerCase())
        || (hdrs.From && hdrs.From.toLowerCase().includes(targetName.toLowerCase()));

    if (isDirectSender) {
        // Direct, header-confirmed address for targetName — save it so a
        // future "email X" / "reply to X" resolves instantly via contacts
        // instead of a fresh search. Failure must never block the reply.
        require('../helpers/emailContacts').addContact(targetName, fromAddr).catch((err) =>
            console.warn(`[ACTIONS] Failed to save learned contact "${targetName}":`, err.message));
    }

    if (!isDirectSender) {
        const extractSlice = (origBody || '').slice(0, 3000);
        const extractPrompt = `This email may be a FORWARD containing an earlier message from "${targetName}". Find "${targetName}"'s email address as it appears in the forwarded/quoted content (often shown as "From: Name <address>" inside a "---------- Forwarded message ---------" block).
Email body:
${extractSlice}
Return ONLY this JSON: { "address": "the email address, or null if you can't find one for ${targetName} specifically" }`;
        const extracted = await callGeminiJSON(extractPrompt);
        let foundAddr = extracted && extracted.address && extracted.address !== 'null' ? extracted.address : null;
        if (foundAddr && !isValidEmail(foundAddr)) {
            console.warn(`[ACTIONS] Forward-extraction returned a non-address for "${targetName}": "${foundAddr}" — discarding`);
            foundAddr = null;
        }
        // FOURTH hallucination case (audited 2026-08-04, no live incident yet
        // — found by re-checking this path against the same failure class as
        // the other three: target_name-as-email at line ~2112, email_details
        // at line ~2123, and the original "mike@example.com" bug this whole
        // guard pattern is named after). This extraction previously only
        // checked that Gemini's answer LOOKED like a valid address — nothing
        // verified it actually came FROM the forwarded text it was given.
        // A confident guess at a plausible address for a known company
        // domain would have sailed through isValidEmail() untouched. Mirrors
        // detailsLookGrounded: if the literal address string isn't present
        // in the exact slice Gemini was shown, it wasn't "found", it was
        // invented — discard it and fall through to the saved-contacts /
        // ask-manager paths below, same as any other extraction failure.
        if (foundAddr && !extractSlice.toLowerCase().includes(foundAddr.toLowerCase())) {
            console.warn(`[ACTIONS] Forward-extraction returned "${foundAddr}" for "${targetName}" but that address never actually appears in the forwarded text it was shown — treating as likely-hallucinated, discarding.`);
            foundAddr = null;
        }

        const emailContacts = require('../helpers/emailContacts');
        if (!foundAddr) {
            // Couldn't pull it from the forward body — check the saved
            // contacts directory before giving up and asking the manager to
            // type it out again.
            const resolvedContact = emailContacts.resolveContact(targetName);
            if (resolvedContact && resolvedContact.type === 'ambiguous') {
                const options = resolvedContact.matches.map((c) => `- ${c.name} <${c.email}>`).join('\n');
                await _send(chatId, `Couldn't pull ${targetName}'s address from the forward, and a few saved contacts match "${targetName}" — which one?\n${options}\n\nRe-send with the exact name.`);
                return { action_taken: 'reply_forward_contact_ambiguous' };
            }
            if (resolvedContact) foundAddr = resolvedContact.contact.email;
        }

        if (!foundAddr) {
            // Same fix as draftEmailForConfirm's identical dead-end: don't
            // just ask and discard targetName/details/bkgNo — stage a
            // pending so the manager's next message (the address) resumes
            // THIS request instead of being reclassified from scratch.
            const staged = await setPending(chatId, {
                type: 'await_manual_email_address',
                mode: 'draft', target_name: targetName, details: details || '', bkg_no: bkgNo || null,
            });
            if (staged.queued) {
                await _send(chatId, `Found an email mentioning ${targetName}, but couldn't confidently pull their address (likely a forward without a clean quoted header), and nothing saved for them either — plus you already have a pending "${staged.blockedBy}" to answer first. I'll ask for the address once that's resolved.`);
                return { action_taken: 'reply_forward_no_address_queued' };
            }
            await _send(chatId, `Found an email mentioning ${targetName}, but couldn't confidently pull their address out of it (likely a forward without a clean quoted header), and nothing saved for them either. Give me the exact email address (or "cancel").`);
            return { action_taken: 'reply_forward_no_address' };
        }
        // Learned/confirmed this address (from the forward body, or reused
        // from contacts) — save it either way so the name resolves instantly
        // next time. Failure here must never block the actual draft.
        emailContacts.addContact(targetName, foundAddr).catch((err) =>
            console.warn(`[ACTIONS] Failed to save learned contact "${targetName}":`, err.message));

        // Same "don't greet with the short lookup key" fix as
        // draftEmailWithAddress — see its own comment. foundAddr may already
        // have a saved displayName from an earlier domain-learn even though
        // it's just now being resolved for a reply.
        const fwdContactRecord = emailContacts.loadContacts().find((c) => c.email.toLowerCase() === String(foundAddr).toLowerCase());
        const fwdGreetingName = fwdContactRecord?.displayName || targetName;

        const prompt = `Draft a short, professional freight-ops email from Edge Metals Inc. to ${fwdGreetingName}. This is NOT a direct reply-in-thread — it's a fresh email prompted by a forwarded/quoted message, so don't reference "your email below" or similar framing the recipient won't recognize.
${todayDateContext()}
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

        // Same as draftEmailWithAddress: combine the global Cc with this
        // address's own standing cc, if one's already been saved/confirmed
        // for them (see helpers/emailContacts.js's setContactCc). Deliberately
        // does NOT pull in the forward's own original Cc list the way the
        // direct-sender path below does — those people were on a DIFFERENT
        // conversation (whoever forwarded this to Apsara, and whoever THEY
        // were talking to), not this fresh, non-threaded email to targetName.
        const forwardCc = mergeCc(globalCc, ccForAddress(foundAddr));

        if (bkgNo) updateSession(chatId, { activeBooking: bkgNo, currentTopic: 'email' });
        const staged = await setPending(chatId, {
            type: 'await_email_confirm',
            to: foundAddr, cc: forwardCc, bcc, subject: draft.subject, body: draft.body,
            // No inReplyTo/references — a manual forward doesn't carry a
            // usable Message-ID for the ORIGINAL sender, so there's nothing
            // real to thread against. This sends as a fresh conversation.
            target_name: targetName, bkg_no: bkgNo || null,
            scheduled_for: scheduledFor ? scheduledFor.toISOString() : null,
        });
        const whenSuffix = scheduledFor ? ` at ${formatScheduledFor(scheduledFor)}` : '';
        if (staged.queued) {
            await _send(chatId, `Drafted (via a forwarded email) to ${targetName} <${foundAddr}> — but you have a pending "${staged.blockedBy}" to answer first. I'll ask you to confirm sending this${whenSuffix ? ` (scheduled${whenSuffix})` : ''} once that's resolved.`);
            return { action_taken: 'reply_via_forward_queued' };
        }
        await _send(chatId,
            `Found this via a forwarded email, not a direct thread — composing a NEW email (not threaded) to ${targetName} <${foundAddr}>:\n${ccBccPreviewLine({ cc: forwardCc, bcc })}\nSubject: ${draft.subject}\n\n${draft.body}\n\nSend this${whenSuffix}? (yes/no)`
        );
        return { action_taken: 'reply_via_forward_staged' };
    }

    // ── Direct email from the target — real thread-reply path ────────────
    // searchGmail, not gmail — composeThreadReply only uses this for
    // getMyEmailAddress() (cc-self-exclusion), so passing whichever account
    // actually found the thread is fine either way, and correctly reports
    // apsara@ when the match came from her own mailbox.
    return composeThreadReply(chatId, searchGmail, targetName, details, bkgNo, fromAddr, origSubject, hdrs, origBody, globalCc, bcc, ccForAddress, bookingLine, scheduledFor, foundSource);
}

// Shared "reply within an existing real thread" composer — extracted
// 2026-08-04 so it has exactly ONE implementation instead of two that could
// silently drift apart. Originally only draftReplyForConfirm's direct-sender
// branch (explicit "reply to X") used this. Now ALSO called from
// draftEmailForConfirm's own booking-thread auto-detection below — see that
// comment for why: "email X about booking Y" used to always compose a fresh,
// disconnected email even when a real thread with X about that exact booking
// already existed, purely because "email" (not "reply") was the verb typed.
// Per Apsara, live: "it should [be a] response to existing booking mail a?"
// `replyToAddr` is passed explicitly rather than derived from the found
// message's From header, because the booking-thread caller may have found
// EITHER a message FROM the target OR one Apsara herself sent TO the target
// — either way the correct reply recipient is the address Jarvis already
// resolved and trusts, not whichever header happens to be on this one
// message.
// foundSource — which mailbox the original was located in ('sender' =
// apsara@, 'bose' = bose@ only). Defaults to 'sender' so any caller that
// doesn't pass it keeps today's behaviour of not forwarding anything.
async function composeThreadReply(chatId, gmail, targetName, details, bkgNo, replyToAddr, origSubject, hdrs, origBody, globalCc, bcc, ccForAddress, bookingLine, scheduledFor = null, foundSource = 'sender') {
    const { callGeminiJSON } = require('../helpers/gemini');
    const replySubject = /^re:/i.test(origSubject) ? origSubject : `Re: ${origSubject}`;
    const messageIdHeader = hdrs['Message-ID'] || hdrs['Message-Id'];
    const references = [hdrs.References, messageIdHeader].filter(Boolean).join(' ').trim();

    // Preserve the original thread's own Cc list on the reply — real
    // "reply-all" behavior, per Apsara: "reply_email.cc'd" (2026-08-03).
    // Excludes the reply recipient's own address (already the "to") and
    // Jarvis's own sending account (never cc yourself). getMyEmailAddress
    // failing isn't fatal — worst case, if it can't be determined, this
    // just skips the self-exclusion rather than blocking the whole reply.
    const { parseAddressList, getMyEmailAddress } = require('../helpers/gmail');
    let myAddr = null;
    try {
        myAddr = await getMyEmailAddress(gmail);
    } catch (err) {
        console.warn('[ACTIONS] Could not determine own account address for cc-exclusion:', err.message);
    }
    const origCc = parseAddressList(hdrs.Cc)
        .filter((addr) => addr.toLowerCase() !== replyToAddr.toLowerCase())
        .filter((addr) => !myAddr || addr.toLowerCase() !== myAddr.toLowerCase());
    const replyCc = mergeCc(globalCc, ccForAddress(replyToAddr), origCc);

    const prompt = `Draft a short, professional reply from Edge Metals Inc. to this email thread.
${todayDateContext()}
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

    if (bkgNo) updateSession(chatId, { activeBooking: bkgNo, currentTopic: 'email' });
    const staged = await setPending(chatId, {
        type: 'await_email_confirm',
        to: replyToAddr, cc: replyCc, bcc, subject: replySubject, body: draft.body,
        // No threadId — belongs to whichever mailbox this was read from,
        // invalid/meaningless when sending via a different account.
        // inReplyTo/References are plain headers and cross accounts fine —
        // that's what actually threads it for the recipient.
        inReplyTo: messageIdHeader, references,
        target_name: targetName, bkg_no: bkgNo || null,
        scheduled_for: scheduledFor ? scheduledFor.toISOString() : null,
        // Set only when the thread was found ONLY in bose@ — apsara@ has no
        // copy, so on confirm the original is forwarded to her first and the
        // reply lands underneath it in her own mailbox. Carries the fields
        // the forward needs, captured now while the message is in hand
        // rather than re-fetched later from a mailbox the send-side token
        // cannot read.
        forward_original: (foundSource === 'bose' && messageIdHeader) ? {
            subject: origSubject, from: hdrs.From, date: hdrs.Date,
            body: String(origBody || '').slice(0, 20000),
            messageIdHeader, references,
        } : null,
    });
    const whenSuffix = scheduledFor ? ` at ${formatScheduledFor(scheduledFor)}` : '';
    if (staged.queued) {
        await _send(chatId, `Drafted a reply to ${targetName} <${replyToAddr}> — but you have a pending "${staged.blockedBy}" to answer first. I'll ask you to confirm sending this${whenSuffix ? ` (scheduled${whenSuffix})` : ''} once that's resolved.`);
        return { action_taken: 'reply_draft_queued' };
    }
    // Say up front that a forward will happen. She is confirming what leaves
    // the system, so a second email going out — even one only to herself —
    // must not be a surprise after the fact.
    const fwdNote = (foundSource === 'bose' && messageIdHeader)
        ? `\n(This thread is only in bose@ — I'll forward the original to you first so the reply sits under it in your own inbox.)`
        : '';
    await _send(chatId,
        `Reply to ${targetName} <${replyToAddr}> (thread: "${origSubject}"):\n${ccBccPreviewLine({ cc: replyCc, bcc })}\n${draft.body}${fwdNote}\n\nSend this${whenSuffix}? (yes/no)`
    );
    return { action_taken: 'reply_draft_staged' };
}

// On-demand trigger for helpers/cutoffBackfill.js — "backfill missing
// cutoffs" on WhatsApp. Auto-fills (never overwrites, only blanks), so this
// reports what changed AFTER the fact rather than asking for confirmation —
// same posture as emailWatcher.js's own silent-fill-then-notify behavior.
// The nightly cron in scheduler.js calls the same helper directly; this is
// just the manager-triggered path into it.
// Re-checks what is STORED against what the mail says — the correctness
// question backfillCutoffs cannot answer, because that one only ever fills
// blanks and never looks at a field that already has a value.
//
// Reports only; never writes. See helpers/cutoffBackfill.js's verify() header
// for why overwriting an existing value unattended is the wrong call.
async function verifyBookings(chatId, bookingNumbers) {
    const { verify, FIELD_LABELS } = require('../helpers/cutoffBackfill');
    const scope = bookingNumbers && bookingNumbers.length ? `${bookingNumbers.length} booking(s)` : 'every active booking';
    await _send(chatId, `Re-checking ${scope} against the original booking mail — this takes a moment, it reads each booking's mail separately.`);
    // Apsara, 2026-08-22: "but nothing fired yet". This used to open with that
    // line and then, if a single Gemini call hung, say nothing ever again.
    // Progress every few bookings proves it is alive; the helper's per-booking
    // timeout guarantees the loop ends; and the report below is now sent on
    // EVERY exit path, so silence is no longer a possible outcome.
    let out;
    let lastPing = Date.now();
    try {
        out = await verify(bookingNumbers, async ({ done, total }) => {
            const nearlyDone = done === total;
            if (nearlyDone) return;                       // the report itself is the last word
            if (done % 5 === 0 || Date.now() - lastPing > 60000) {
                lastPing = Date.now();
                try { await _send(chatId, `Still going — ${done}/${total} bookings checked.`); }
                catch (e) { console.error('[ACTIONS] verify progress send failed:', e.message); }
            }
        });
    } catch (err) {
        console.error('[ACTIONS] verifyBookings failed:', err.message);
        await _send(chatId, `Verification failed: ${err.message}`);
        return { action_taken: 'booking_verify_failed' };
    }
    if (out.error) {
        await _send(chatId, `Can't verify: ${out.error}.`);
        return { action_taken: 'booking_verify_failed' };
    }
    const results = out.results || [];
    const withMismatch = results.filter((r) => r.status === 'checked' && r.mismatches.length);
    const noMail = results.filter((r) => r.status === 'no_mail');
    const checked = results.filter((r) => r.status === 'checked');
    const confirmedCount = checked.reduce((n, r) => n + r.confirmed.length, 0);
    const blanks = checked.filter((r) => r.blank.length);

    const lines = [];
    if (withMismatch.length) {
        lines.push(`*${withMismatch.length} booking(s) disagree with the mail:*`);
        for (const r of withMismatch) {
            for (const m of r.mismatches) {
                lines.push(`• ${r.bkgNo} — ${FIELD_LABELS[m.field] || m.field}`);
                lines.push(`   stored: ${m.stored}`);
                lines.push(`   mail:   ${m.fromMail}`);
            }
        }
        lines.push('');
        lines.push('Nothing was changed. Tell me which to correct and I\'ll update them.');
    } else if (checked.length) {
        lines.push(`No disagreements — ${confirmedCount} field(s) across ${checked.length} booking(s) match the mail.`);
    }
    if (blanks.length) {
        lines.push('');
        lines.push(`*Blank here, but the mail has a value:*`);
        for (const r of blanks) {
            lines.push(`• ${r.bkgNo} — ${r.blank.map((x) => `${FIELD_LABELS[x.field] || x.field}: ${x.fromMail}`).join(', ')}`);
        }
        lines.push('("backfill missing fields" fills these in.)');
    }
    if (noMail.length) {
        lines.push('');
        lines.push(`*Couldn't check ${noMail.length}* — no booking mail found: ${noMail.map((r) => r.bkgNo).join(', ')}`);
    }
    // A booking that timed out or errored is NOT the same as one that matched.
    // Saying nothing about it would quietly report a clean bill of health for
    // data nobody actually looked at.
    const stalled = results.filter((r) => r.status === 'timeout' || r.status === 'error');
    if (stalled.length) {
        lines.push('');
        lines.push(`*${stalled.length} booking(s) could not be read* (mail or AI took too long): ${stalled.map((r) => r.bkgNo).join(', ')}`);
        lines.push('Ask again for just those and I\'ll retry them.');
    }
    if (!lines.length) lines.push('Nothing to check — no bookings on file.');
    await _send(chatId, lines.join('\n'));
    return { action_taken: 'booking_verify_done', mismatches: withMismatch.length, stalled: stalled.length };
}

async function backfillCutoffs(chatId) {
    const { run, FIELD_LABELS } = require('../helpers/cutoffBackfill');
    await _send(chatId, 'Checking bookings for missing cutoff/ERD/ETD/ETA/vessel/route fields against existing mail — this can take a moment.');
    let results;
    try {
        results = await run();
    } catch (err) {
        console.error('[ACTIONS] backfillCutoffs failed:', err.message);
        await _send(chatId, `Backfill failed: ${err.message}`);
        return { action_taken: 'cutoff_backfill_failed' };
    }
    // REAL GAP (2026-08-22, live): this reported "No missing fields found —
    // either nothing was blank, or nothing in mail could fill what was" while
    // the very next message listed bookings with a visibly blank Cutoff. Both
    // halves of that sentence are true and the reader cannot tell which one
    // applies, which is exactly the uncertainty that prompted her to ask
    // "Reverify all the bookings to check correctness of data".
    //
    // So say WHICH. A blank field that mail could not fill is a real gap she
    // needs to chase with the carrier — it is the useful half of this answer,
    // and it was being hidden behind an ambiguous sentence.
    const stillBlank = [];
    try {
        const { loadBookings } = require('../helpers/json');
        const FIELDS = Object.keys(FIELD_LABELS);
        for (const b of Object.values(loadBookings() || {})) {
            const missing = FIELDS.filter((f) => !b[f] || !String(b[f]).trim());
            if (missing.length) {
                stillBlank.push(`${b.booking_number} — missing ${missing.map((f) => FIELD_LABELS[f] || f).join(', ')}`);
            }
        }
    } catch (e) {
        console.warn('[ACTIONS] post-backfill blank scan failed:', e.message);
    }
    if (!results.length) {
        await _send(chatId, stillBlank.length
            ? `Nothing in mail could fill any gaps. Still blank — these need chasing with the carrier:\n${stillBlank.join('\n')}`
            : 'Nothing was blank — every booking already has cutoff, ERD, ETD, ETA, vessel and route filled in.');
        return { action_taken: 'cutoff_backfill_none' };
    }
    const lines = results.map((r) => {
        const parts = Object.entries(r.filled).map(([k, v]) => `${FIELD_LABELS[k] || k}: ${v}`);
        return `${r.bkgNo} — ${parts.join(', ')}`;
    });
    const tail = stillBlank.length ? `\n\nStill blank after the scan — mail had nothing for these:\n${stillBlank.join('\n')}` : '';
    await _send(chatId, `Backfilled from mail:\n${lines.join('\n')}${tail}`);
    return { action_taken: 'cutoff_backfill_done', count: results.length };
}

// ── Multi-trucker quote requests (2026-08-05) ────────────────────────────────
// Per Apsara: "get quote from LA to Richmond" → resolve both ends against
// the address book, resolve whichever truckers she named (or ask her which
// ones if she didn't), send the ask over whatever channel each trucker
// actually has on file, then hand off to workflow/quoteRequests.js for the
// actual send + reminder scheduling. Ambiguity anywhere (a lane query or a
// trucker name matching more than one saved entry) pauses with a
// disambiguation pending — same options/matches convention used everywhere
// else in this file (see await_contact_disambiguation above) — rather than
// ever guessing which one she meant.

function splitQuoteNames(namesText) {
    // REAL BUG (found 2026-08-06, live): "...email /Jose" — a stray leading
    // "/" (typo/autocomplete artifact) — was kept verbatim as the name,
    // so neither getTruckersByName's substring match nor the token-fallback
    // matcher recognized "/Jose" as "Jose". It sailed all the way through
    // the cargo-details question before failing at dispatch with "couldn't
    // find: /Jose" — a wasted round-trip. Stripping stray leading/trailing
    // punctuation here fixes it at the source for any pending trucker-name
    // input, not just this one call site.
    return String(namesText || '')
        .split(/,|&|\band\b/i)
        .map((s) => s.trim().replace(/^[^\w]+|[^\w]+$/g, ''))
        .filter(Boolean);
}

// state: { originQuery, destinationQuery, names: string[]|null, resolvedSoFar?: [{name,trucker}], directEmails?: string[]|null }
// directEmails is a one-off recipient given directly ("...email
// apg0596@gmail.com") — bypasses trucker-name lookup entirely, since it's
// not necessarily a saved trucker at all. Real gap found 2026-08-05: this
// didn't exist before, so an email-only request had no way to specify WHO
// to send to at all.
// The single reentrant function every quote-request pending resumes
// through — lane resolution is redone on every call (pure/idempotent, cheap)
// so a field already confirmed via a prior disambiguation pause just
// resolves 'exact' again instantly.
async function continueQuoteFlow(chatId, state) {
    const origin = quoteHelper.resolveLaneEntry(state.originQuery);
    if (!origin) {
        await _send(chatId, `"${state.originQuery}" doesn't match anything in the address book — add it first, or try a different name.`);
        return { action_taken: 'quote_lane_unresolved' };
    }
    if (origin.type === 'ambiguous') return pauseForLaneAmbiguity(chatId, 'origin', origin.matches, state);

    const destination = quoteHelper.resolveLaneEntry(state.destinationQuery);
    if (!destination) {
        await _send(chatId, `"${state.destinationQuery}" doesn't match anything in the address book — add it first, or try a different name.`);
        return { action_taken: 'quote_lane_unresolved' };
    }
    if (destination.type === 'ambiguous') return pauseForLaneAmbiguity(chatId, 'destination', destination.matches, state);

    const hasNames = state.names && state.names.length;
    const hasEmails = state.directEmails && state.directEmails.length;
    if (!hasNames && !hasEmails) {
        // Real gap found 2026-08-16, live (Apsara: "Send quote request from
        // Junk car to Eccomelt" listed TRUCKERS to ask, even though Eccomelt
        // is a saved Contacts entry, not a trucker). The natural "from X to
        // Y" phrasing always matches THIS parser (parseGetQuoteCommand in
        // brain.js) rather than the separate "to X for Y" contact-quote
        // parser, so any quote asked this way to a company/buyer saved as a
        // Contact — never a trucker — could only ever list the trucker
        // roster, which has nothing to do with the request. Fix: when no
        // trucker names/emails were given, check whether the DESTINATION
        // matches a saved Contact first. If it does, this is a contact
        // quote — route through the already-tested contact-quote flow
        // (startContactQuoteRequestFlow below), using origin as the "for"
        // details, instead of asking her to pick from an unrelated trucker
        // list. Only falls through to the trucker-roster prompt when the
        // destination doesn't match any saved contact at all, so a genuine
        // hauling-lane quote ("get quote from LA to Richmond") is completely
        // unaffected.
        const contactsHelper = require('../helpers/contacts');
        if (contactsHelper.getContactsByName(state.destinationQuery).length) {
            return startContactQuoteRequestFlow(chatId, state.destinationQuery, state.originQuery);
        }
        return askWhichTruckers(chatId, { originQuery: state.originQuery, destinationQuery: state.destinationQuery });
    }

    let allResolved = state.resolvedSoFar || [];
    let unresolved = [];
    if (hasNames) {
        const quoteFlow = require('./quoteRequests');
        const { resolved, ambiguous, unresolved: u } = await quoteFlow.resolveTruckerNames(state.names);
        allResolved = [...allResolved, ...resolved];
        unresolved = u;

        if (ambiguous.length) {
            return pauseForTruckerAmbiguity(
                chatId, ambiguous[0],
                { originQuery: state.originQuery, destinationQuery: state.destinationQuery, directEmails: state.directEmails || null },
                allResolved,
                [...ambiguous.slice(1).map((a) => a.query), ...unresolved],
            );
        }

        // REAL BUG (found 2026-08-06, live): a genuinely-unmatched name
        // (zero candidates — not ambiguous, just not found) used to sail
        // straight through the cargo-details question below and only fail
        // at the very end, at dispatch — "Couldn't send to anyone —
        // couldn't find: X" — after she'd already typed out cargo details
        // for a request that could never go anywhere. Only pauses when
        // NOBODY resolved (and there's no direct-email fallback either);
        // if at least one name/email is good, the request still has a
        // real recipient, so that partial-failure case is left to report
        // normally in the final confirmation, same as before.
        if (unresolved.length && !allResolved.length && !hasEmails) {
            return pauseForUnresolvedTrucker(chatId, unresolved, {
                originQuery: state.originQuery, destinationQuery: state.destinationQuery,
                resolvedSoFar: allResolved, directEmails: state.directEmails || null,
            });
        }
    }

    // Cargo description/value — per Apsara 2026-08-06: "I want jarvis to ask
    // about cargo description, cargo value" before the quote actually goes
    // out, not just pickup/delivery addresses. Asked LAST (recipients
    // already locked in) so it's a single extra question regardless of how
    // many disambiguation rounds it took to get here. typeof-check (not
    // truthy-check) so an explicit "skip" — stored as null by
    // resumeWithCargoDetails below — is treated as "already asked, don't
    // ask again", not "still need to ask".
    if (typeof state.cargoDetails === 'undefined') {
        return askForCargoDetails(chatId, {
            originQuery: state.originQuery, destinationQuery: state.destinationQuery,
            resolvedTruckers: allResolved, unresolvedNames: unresolved, directEmails: state.directEmails || [],
        });
    }

    return dispatchQuoteToTruckers(chatId, state.originQuery, state.destinationQuery, allResolved, unresolved, state.directEmails || [], state.cargoDetails);
}

async function pauseForLaneAmbiguity(chatId, field, matches, state) {
    const staged = await setPending(chatId, {
        type: 'confirm_quote_lane', field, matches,
        options: matches.map((e) => e.aliases[0]),
        state: { originQuery: state.originQuery, destinationQuery: state.destinationQuery, names: state.names || null, resolvedSoFar: state.resolvedSoFar || [], directEmails: state.directEmails || null },
    });
    const query = field === 'origin' ? state.originQuery : state.destinationQuery;
    const listText = matches.map((e, i) => `${i + 1}. ${e.aliases[0]} — ${String(e.raw).split('\n')[0]}`).join('\n');
    if (staged.queued) {
        await _send(chatId, `"${query}" matches more than one saved address, but you have a pending "${staged.blockedBy}" to answer first. I'll ask which one once that's resolved.\n${listText}`);
        return { action_taken: 'quote_lane_ambiguous_queued' };
    }
    await _send(chatId, `"${query}" matches more than one saved address — which one?\n${listText}\n\nReply with the number.`);
    return { action_taken: 'quote_lane_ambiguous' };
}

async function pauseForTruckerAmbiguity(chatId, ambiguousOne, state, resolvedSoFar, remainingNames) {
    const matches = ambiguousOne.matches;
    const staged = await setPending(chatId, {
        type: 'confirm_quote_trucker', matches,
        options: matches.map((t) => t.name),
        state, resolvedSoFar, remainingNames,
    });
    const listText = matches.map((t, i) => `${i + 1}. ${t.name}${t.locality ? ` (${t.locality})` : ''}`).join('\n');
    if (staged.queued) {
        await _send(chatId, `"${ambiguousOne.query}" matches more than one saved trucker, but you have a pending "${staged.blockedBy}" to answer first. I'll ask which one once that's resolved.\n${listText}`);
        return { action_taken: 'quote_trucker_ambiguous_queued' };
    }
    await _send(chatId, `"${ambiguousOne.query}" matches more than one saved trucker — which one?\n${listText}\n\nReply with the number.`);
    return { action_taken: 'quote_trucker_ambiguous' };
}

// A given name matched NO saved trucker at all (not ambiguous — genuinely
// zero candidates) and there's no direct-email fallback either, so this
// request currently has nobody to go to. Per Apsara 2026-08-06 ("rather
// than rejecting straightaway confirm whom to ask?") — pause and ask her
// to correct the name or give an email, instead of silently continuing
// to the cargo-details question and only failing at the very end.
async function pauseForUnresolvedTrucker(chatId, unresolvedNames, state) {
    const staged = await setPending(chatId, { type: 'await_quote_trucker_retry', unresolvedNames, state });
    if (staged.queued) {
        await _send(chatId, `Couldn't find a saved trucker named "${unresolvedNames.join(', ')}", but you have a pending "${staged.blockedBy}" to answer first. I'll ask again once that's resolved.`);
        return { action_taken: 'quote_trucker_unresolved_queued' };
    }
    await _send(chatId, `Couldn't find a saved trucker named "${unresolvedNames.join(', ')}" — reply with the correct name, or their email address (or "cancel").`);
    return { action_taken: 'quote_trucker_unresolved' };
}

// No trucker named at all — per Apsara's answer ("just ask"): list every
// trucker that has SOME usable contact channel and let her pick one or more.
//
// 2026-08-16, per Apsara ("list all the contacts say 1,2,3 and all") —
// Contacts (helpers/contacts.js — buyers/companies, not haulers) are now
// merged into this same numbered list, listed first (matches her stated
// tab-order preference elsewhere: Contacts before Active/Closed). A pick by
// number or name flows through unchanged either way — resolveTruckerNames
// (workflow/quoteRequests.js) now searches both rosters for the picked
// name, and resolveTruckerChannel works identically on a Contacts record
// (same {group_id, whatsapp, email, preferred_mode} shape as a trucker).
async function askWhichTruckers(chatId, state) {
    const { loadContacts } = require('../helpers/contacts');
    const allTruckers = await loadTruckers();
    const reachableTruckers = allTruckers.filter((t) => quoteHelper.resolveTruckerChannel(t));
    const reachableContacts = loadContacts().filter((c) => quoteHelper.resolveTruckerChannel(c));
    const reachable = [...reachableContacts, ...reachableTruckers];
    if (!reachable.length) {
        await _send(chatId, 'No truckers or contacts with a saved WhatsApp number, group, or email on file — add one from the dashboard first.');
        return { action_taken: 'quote_no_truckers' };
    }
    const staged = await setPending(chatId, {
        type: 'await_quote_truckers',
        options: reachable.map((t) => t.name),
        state,
    });
    const listText = reachable.map((t, i) => `${i + 1}. ${t.name}`).join('\n');
    if (staged.queued) {
        await _send(chatId, `Ready to ask about ${state.originQuery} → ${state.destinationQuery}, but you have a pending "${staged.blockedBy}" to answer first. I'll ask who once that's resolved.`);
        return { action_taken: 'quote_awaiting_truckers_queued' };
    }
    await _send(chatId, `Who should I ask for ${state.originQuery} → ${state.destinationQuery}?\n${listText}\n\nReply with names or numbers — comma-separated for more than one.`);
    return { action_taken: 'quote_awaiting_truckers' };
}

// Called directly from brain.js's route() for intent 'quote_truckers_selected'
// (the multi-select reply to askWhichTruckers above) — NOT a resolvePending
// case, since that reply needs its own comma/number-list parsing in
// policyDecide rather than the generic single-pick p.options handling.
async function resumeQuoteWithTruckerNames(chatId, pending, names) {
    await clearPending(chatId);
    return continueQuoteFlow(chatId, { originQuery: pending.state.originQuery, destinationQuery: pending.state.destinationQuery, names, resolvedSoFar: [], directEmails: pending.state.directEmails || null });
}

// Reply to pauseForUnresolvedTrucker's "couldn't find X — correct name or
// email?" question. Verbatim capture like the cargo-details/manual-email
// pendings — whatever she sends is either "cancel", a real email address
// (added as a one-off direct recipient), or a corrected/retried name,
// re-run through the normal trucker lookup via continueQuoteFlow.
async function resumeQuoteWithTruckerRetry(chatId, pending, text) {
    await clearPending(chatId);
    const clean = String(text || '').trim();
    if (/^cancel$/i.test(clean)) {
        await _send(chatId, 'Cancelled — quote request not sent.');
        return { action_taken: 'quote_cancelled' };
    }
    const { originQuery, destinationQuery, resolvedSoFar, directEmails } = pending.state;
    if (/^[\w.+-]+@[\w.-]+\.[a-z]{2,}$/i.test(clean)) {
        return continueQuoteFlow(chatId, {
            originQuery, destinationQuery, names: null, resolvedSoFar: resolvedSoFar || [],
            directEmails: [...(directEmails || []), clean],
        });
    }
    return continueQuoteFlow(chatId, {
        originQuery, destinationQuery, names: splitQuoteNames(clean), resolvedSoFar: resolvedSoFar || [],
        directEmails: directEmails || null,
    });
}

// Last question before actually sending — recipients are already fully
// resolved by this point (state carries the finished resolvedTruckers/
// unresolvedNames/directEmails, not raw names), so this does NOT re-enter
// continueQuoteFlow on resume — that would needlessly re-run the trucker-name
// DB lookup a second time. Goes straight to dispatchQuoteToTruckers instead.
async function askForCargoDetails(chatId, state) {
    const staged = await setPending(chatId, { type: 'await_quote_cargo_details', state });
    if (staged.queued) {
        await _send(chatId, `Ready to send for ${state.originQuery} → ${state.destinationQuery}, but you have a pending "${staged.blockedBy}" to answer first. I'll ask for cargo details once that's resolved.`);
        return { action_taken: 'quote_awaiting_cargo_queued' };
    }
    // Mandatory — no "skip". Per Apsara 2026-08-20: "its mandatory for every
    // quote .just ask manager", then "NO.IT DIDNT ASK FOR DESCRIPTION".
    await _send(chatId, `What's the cargo — description, weight, and value? All three are required (e.g. "Aluminum scrap, 40,000 lbs, approx $5,000").`);
    return { action_taken: 'quote_awaiting_cargo' };
}

// RESTORED 2026-08-22 (second time — the whole validation block was lost to a
// file overwrite and this reverted to accepting anything, including "skip").
//
// Description AND weight AND value are all required. Three live bugs produced
// this rule, in order:
//   1. "Al" sailed through as complete cargo details — nothing checked at all.
//   2. The first fix only looked for ANY digit, so "42000 lbs" (a weight, no
//      value) passed. Apsara: "manager typed only 42000 lbs not the cargo
//      value.but jarvis ignored that."
//   3. Requiring an explicit unit for each created an INFINITE LOOP —
//      "40000,42000" satisfied neither check and could never be answered.
//      Worse than the bug it replaced.
// Hence the current rule: units are ONE way to prove a number is a weight or
// a value, not the only way. Two DISTINCT numbers anywhere means one of each,
// because nobody types the same fact twice. Only a single bare number is
// genuinely ambiguous.
const WEIGHT_RE = /\d[\d,]*\s*(lbs?|pounds?|kgs?|kilograms?|tons?)\b/i;
const VALUE_RE  = /(\$\s?\d)|\d[\d,]*\s*(dollars?|usd)\b/i;
// Matches a thousands-separated number as ONE token, but "40000,42000" (no
// space) as TWO — a greedy [\d,]* class merged those into a single match and
// silently re-created the infinite loop.
const NUMBER_RE = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;
const UNIT_OR_CURRENCY_WORDS = new Set(['lbs', 'lb', 'pounds', 'pound', 'kgs', 'kg', 'kilograms', 'kilogram', 'tons', 'ton', 'dollars', 'dollar', 'usd']);
const FILLER_WORDS = new Set(['ok', 'okay', 'yes', 'yeah', 'yep', 'sure', 'please', 'here', 'its', 'it', 'is', 'are', 'the', 'a', 'an', 'and', 'for', 'of', 'to', 'about', 'approx', 'around']);
// A description is any real word left once numbers, units and filler are
// stripped. "ok 40000 lbs $5000" has no description; "Al combo" does not
// either (too short to be meaningful), but "Aluminum scrap" does.
function hasCargoDescription(text) {
    const stripped = String(text || '')
        .replace(/\$\s?[\d,]+(\.\d+)?/g, ' ')
        .replace(/\d[\d,]*(\.\d+)?/g, ' ');
    const words = stripped.split(/[^a-zA-Z']+/).map((w) => w.toLowerCase()).filter(Boolean);
    return words.some((w) => w.length >= 3 && !UNIT_OR_CURRENCY_WORDS.has(w) && !FILLER_WORDS.has(w));
}
function analyzeCargoNumbers(text) {
    const numCount = (String(text || '').match(NUMBER_RE) || []).length;
    const hasWeight = numCount >= 2 ? true : WEIGHT_RE.test(text);
    const hasValue  = numCount >= 2 ? true : VALUE_RE.test(text);
    return { hasWeight, hasValue, hasDescription: hasCargoDescription(text) };
}
async function resumeQuoteWithCargoDetails(chatId, pending, cargoText) {
    const clean = String(cargoText || '').trim();
    // Answers accumulate across turns, so a partial reply is never discarded.
    const combined = [pending.state.cargoSoFar, clean].filter(Boolean).join(', ');
    const { hasWeight, hasValue, hasDescription } = analyzeCargoNumbers(combined);
    if (!hasWeight || !hasValue || !hasDescription) {
        await setPending(chatId, { type: 'await_quote_cargo_details', state: { ...pending.state, cargoSoFar: combined } });
        const missing = [];
        if (!hasDescription) missing.push('a description');
        if (!hasWeight) missing.push('a weight');
        if (!hasValue) missing.push('a value');
        const list = missing.length === 1 ? missing[0]
            : missing.length === 2 ? `${missing[0]} and ${missing[1]}`
                : `${missing[0]}, ${missing[1]}, and ${missing[2]}`;
        await _send(chatId, `Still need ${list} — description, weight, and value are all required for every quote. What ${missing.length > 1 ? 'are they' : 'is it'}?`);
        return { action_taken: 'quote_cargo_details_retry' };
    }
    await clearPending(chatId);
    const { originQuery, destinationQuery, resolvedTruckers, unresolvedNames, directEmails, scaleTicketsNeeded } = pending.state;
    const scaleLine = scaleTicketsNeeded === true ? 'scale tickets needed'
        : scaleTicketsNeeded === false ? 'scale tickets not needed' : null;
    const finalCargo = [combined, scaleLine].filter(Boolean).join(' | ');
    return dispatchQuoteToTruckers(chatId, originQuery, destinationQuery, resolvedTruckers, unresolvedNames, directEmails, finalCargo);
}

// Everything's resolved — actually send. Truckers with no usable channel
// (no group/whatsapp/email on file at all) are reported, not silently
// dropped; same for names that never matched anyone. directEmails are
// one-off recipients given directly in the command ("...email
// someone@x.com") — not looked up against the truckers table at all, so
// they can never be "unresolved"/"no channel", just sent to as-is.
async function dispatchQuoteToTruckers(chatId, originQuery, destinationQuery, resolvedTruckers, unresolvedNames, directEmails = [], cargoDetails = null) {
    const legs = [];
    const noChannel = [];
    for (const { trucker } of resolvedTruckers) {
        const ch = quoteHelper.resolveTruckerChannel(trucker);
        if (!ch) { noChannel.push(trucker.name); continue; }
        legs.push({ name: trucker.name, channel: ch.channel, target: ch.target });
    }
    for (const addr of directEmails) {
        legs.push({ name: addr, channel: 'email', target: addr });
    }
    if (!legs.length) {
        const bits = [];
        if (unresolvedNames.length) bits.push(`couldn't find: ${unresolvedNames.join(', ')}`);
        if (noChannel.length) bits.push(`no contact info on file for: ${noChannel.join(', ')}`);
        await _send(chatId, `Couldn't send to anyone — ${bits.join('; ') || 'nothing resolved'}.`);
        return { action_taken: 'quote_request_failed' };
    }

    const quoteFlow = require('./quoteRequests');
    const { sentTo, failed } = await quoteFlow.startQuoteRequest({
        originQuery, destinationQuery, truckerLegs: legs, askedByChat: chatId, send: _send, cargoDetails,
    });

    const lines = [`Quote request sent to ${sentTo.join(', ') || '(nobody — all sends failed)'} for ${originQuery} → ${destinationQuery}.`];
    if (cargoDetails) lines.push(`Cargo: ${cargoDetails}`);
    if (failed.length) lines.push(`Send failed for: ${failed.join(', ')}.`);
    if (noChannel.length) lines.push(`Skipped (no WhatsApp/email on file): ${noChannel.join(', ')}.`);
    if (unresolvedNames.length) lines.push(`Couldn't find a trucker named: ${unresolvedNames.join(', ')}.`);
    if (sentTo.length) lines.push(`I'll follow up at 30/60/90 min if there's no price yet, then loop in the manager.`);
    await _send(chatId, lines.join('\n'));
    return { action_taken: sentTo.length ? 'quote_request_sent' : 'quote_request_failed' };
}

// Entry point from brain.js's 'get_quote' intent. emails is an optional
// array of one-off recipients parsed out of an "...email addr[, addr2]"
// clause — independent of (and combinable with) names/"ask ___".
async function startQuoteRequestFlow(chatId, originQuery, destinationQuery, namesText, emails) {
    // Scale tickets is asked FIRST, before recipients or cargo — per Apsara
    // 2026-08-20 ("why didnt it ask from manager whether scale ticket neede at
    // the start of convo"). It used to be folded into the cargo-details
    // sentence, where it went unenforced and got silently skipped.
    return askForScaleTickets(chatId, {
        originQuery, destinationQuery,
        names: namesText ? splitQuoteNames(namesText) : null,
        directEmails: emails && emails.length ? emails : null,
    });
}

// RESTORED 2026-08-22 (second time). This function was silently deleted by a
// file overwrite, which left resumeQuoteWithScaleTickets exported but
// UNREACHABLE — nothing staged the pending it resolves, so the question was
// simply never asked. scripts/check-action-wiring.js could not see it: the
// export existed, so its check passed. It now also checks pending types for
// exactly this shape of break.
async function askForScaleTickets(chatId, state) {
    const staged = await setPending(chatId, { type: 'await_quote_scale_tickets', state });
    if (staged.queued) {
        await _send(chatId, `Ready to start on ${state.originQuery} → ${state.destinationQuery}, but you have a pending "${staged.blockedBy}" to answer first. I'll ask about scale tickets once that's resolved.`);
        return { action_taken: 'quote_awaiting_scale_tickets_queued' };
    }
    await _send(chatId, `Do you need scale tickets for this haul? (yes/no)`);
    return { action_taken: 'quote_awaiting_scale_tickets' };
}

// Entry point from brain.js's 'quote_leg_reply_received' intent — a message
// from a chat currently awaiting a price on some open quote request.
// Deliberately silent back to the trucker (no auto-ack) — Apsara only asked
// for these events to surface as dashboard notifications, not for Jarvis to
// start chatting with the trucker on her behalf.
async function handleQuoteLegReply(chatId, text) {
    const quoteFlow = require('./quoteRequests');
    const result = await quoteFlow.handleIncomingReply(chatId, text);
    return { action_taken: result ? 'quote_leg_reply_recorded' : 'quote_leg_reply_no_match' };
}

// ── Contact quote requests — built 2026-08-16 per Apsara: "these are just
// truckers. i want to have another tab where there is quote request and have
// whatsapp/email support for quote." Mirrors the trucker quote-request flow
// above (startQuoteRequestFlow/pauseForUnresolvedTrucker/dispatchQuoteToTruckers)
// but resolves the recipient against helpers/contactQuoteRequests.js's
// resolveQuoteContact() (merges helpers/emailContacts.js + helpers/addressBook.js)
// instead of the truckers table, so it can reach ANY saved person/company, not
// just truckers. Deliberately kept as its own set of functions/pending types
// rather than folded into the trucker flow, per Apsara's own file-separation
// pattern (truckers.json vs suppliers.json vs email_contacts.json etc. are all
// separate stores even where entities overlap) — this way nothing about the
// already-working, already-fixed trucker flow needs to change.

// Entry point from brain.js's 'get_contact_quote' intent.
//
// Recipient model rebuilt 2026-08-16 (same day, later) per Apsara: "i should
// have quotes contact where i have separate group/whatsapp/email mimicking
// trucker implementation." Recipients now come from helpers/contacts.js
// (dedicated list, trucker-shaped record) instead of merging Email Contacts
// + Address Book, and resolve to exactly ONE channel via
// helpers/quoteRequests.js's resolveTruckerChannel — same as a trucker gets.
// No more separate WhatsApp verification step: a contact's group_id/
// whatsapp/email are set directly by Apsara on the dashboard, trusted the
// same way a trucker's own fields are.
// MULTI-RECIPIENT (2026-08-18, per Apsara: "comparing buyer offers
// side-by-side is something you actually need") — recipientQuery is now
// split the same way the trucker flow's names_text already is (splitQuoteNames:
// comma/"&"/"and"-separated). A single name keeps the EXACT original
// behavior below (interactive ambiguous/not-found/no-channel retry, one
// pending question at a time) — nothing changes for the common case. Two or
// more names take a simpler path: resolve each independently, dispatch to
// everyone who resolves as ONE multi-leg request (so
// workflow/contactQuoteRequests.js's maybeSendPriceComparison can rank their
// replies against each other), and report whoever didn't resolve in the
// confirmation text rather than building a full interactive retry loop for
// every name at once — real complexity for a rare case; she can just re-ask
// for one failed name by itself and get the full retry treatment.
async function startContactQuoteRequestFlow(chatId, recipientQuery, details) {
    const cqr = require('../helpers/contactQuoteRequests');
    const names = splitQuoteNames(recipientQuery);

    if (names.length <= 1) {
        const resolved = cqr.resolveQuoteContact(recipientQuery);
        if (resolved.type === 'not_found') {
            return pauseForContactQuoteRetry(chatId, recipientQuery, details, `Couldn't find "${recipientQuery}" in Contacts`);
        }
        if (resolved.type === 'ambiguous') {
            const listText = resolved.matches.map((m, i) => `${i + 1}. ${m.name}`).join('\n');
            return pauseForContactQuoteRetry(chatId, recipientQuery, details, `"${recipientQuery}" matches more than one saved contact:\n${listText}\n\nReply with the exact name, or "cancel"`, /* skipPrefix */ true);
        }
        if (resolved.type === 'resolved_no_channel') {
            return pauseForContactQuoteRetry(chatId, recipientQuery, details, `Found "${resolved.name}" but no WhatsApp group/number or email on file — add one from the dashboard (Contacts)`);
        }
        return dispatchContactQuote(chatId, [resolved], recipientQuery, details);
    }

    const resolvedList = [];
    const problems = [];
    for (const name of names) {
        const r = cqr.resolveQuoteContact(name);
        if (r.type === 'resolved') resolvedList.push(r);
        else if (r.type === 'ambiguous') problems.push(`"${name}" matches more than one saved contact (${r.matches.map((m) => m.name).join(', ')}) — ask for it by itself to pick one`);
        else if (r.type === 'resolved_no_channel') problems.push(`"${r.name}" has no WhatsApp group/number or email on file`);
        else problems.push(`couldn't find "${name}" in Contacts`);
    }
    if (!resolvedList.length) {
        await _send(chatId, `Couldn't send to anyone — ${problems.join('; ')}.`);
        return { action_taken: 'contact_quote_request_failed' };
    }
    return dispatchContactQuote(chatId, resolvedList, recipientQuery, details, problems);
}

async function pauseForContactQuoteRetry(chatId, recipientQuery, details, message, skipPrefix = false) {
    const staged = await setPending(chatId, {
        type: 'await_contact_quote_recipient_retry',
        state: { recipientQuery, details },
    });
    if (staged.queued) {
        await _send(chatId, `${message}, but you have a pending "${staged.blockedBy}" to answer first. I'll ask again once that's resolved.`);
        return { action_taken: 'contact_quote_recipient_unresolved_queued' };
    }
    await _send(chatId, skipPrefix ? message : `${message} — reply with the exact contact name (or "cancel").`);
    return { action_taken: 'contact_quote_recipient_unresolved' };
}

// Reply to pauseForContactQuoteRetry's "couldn't find X / ambiguous" question.
// Same verbatim-capture + cancel pattern as resumeQuoteWithTruckerRetry (minus
// the email-shortcut branch — a contact-quote recipient is always a saved
// Contacts entry now, never a one-off address typed straight into the reply).
async function resumeContactQuoteWithRetry(chatId, pending, text) {
    await clearPending(chatId);
    const clean = String(text || '').trim();
    if (/^cancel$/i.test(clean)) {
        await _send(chatId, 'Cancelled — quote request not sent.');
        return { action_taken: 'contact_quote_cancelled' };
    }
    const { details } = pending.state;
    return startContactQuoteRequestFlow(chatId, clean, details);
}

// Everything's resolved — actually send. resolvedList: one or more
// {name, channel, target} entries (see startContactQuoteRequestFlow above);
// each becomes its own leg on ONE request, mirroring dispatchQuoteToTruckers's
// multi-leg structure. problems: names from a multi-name ask that didn't
// resolve — reported alongside the send summary, not blocking whoever DID
// resolve.
async function dispatchContactQuote(chatId, resolvedList, recipientQuery, details, problems = []) {
    const contactFlow = require('./contactQuoteRequests');
    const legs = resolvedList.map((r) => ({ name: r.name, channel: r.channel, target: r.target, target_label: r.target }));

    const { sentTo, failed } = await contactFlow.startContactQuoteRequest({
        recipientQuery, details, legs, askedByChat: chatId, send: _send,
    });

    const lines = [`Quote request sent to ${sentTo.join(', ') || '(send failed)'} for: ${details}.`];
    if (failed.length) lines.push(`Send failed for: ${failed.join(', ')}.`);
    if (problems.length) lines.push(`Also: ${problems.join('; ')}.`);
    if (sentTo.length) {
        lines.push(`I'll follow up at 30/60/90 min if there's no price yet, then loop in the manager.${sentTo.length > 1 ? ` I'll flag which one quotes cheapest once 2+ prices are in.` : ''}`);
    }
    await _send(chatId, lines.join('\n'));
    return { action_taken: sentTo.length ? 'contact_quote_request_sent' : 'contact_quote_request_failed' };
}

// Entry point from brain.js's 'contact_quote_leg_reply_received' intent — a
// WhatsApp message from a chat currently awaiting a price on an open
// contact-quote-request leg. Mirrors handleQuoteLegReply's silent-back
// posture: reply is recorded and surfaced as a dashboard alert, but Jarvis
// doesn't auto-ack the contact on Apsara's behalf.
async function handleContactQuoteLegReply(chatId, text) {
    const contactFlow = require('./contactQuoteRequests');
    const result = await contactFlow.handleIncomingReply(chatId, text);
    return { action_taken: result ? 'contact_quote_leg_reply_recorded' : 'contact_quote_leg_reply_no_match' };
}


// ══════════════════════════════════════════════════════════════════════════
// RESTORED 2026-08-22 — receivables, reminders, address lookup, send-message,
// and the quote scale-ticket resume.
//
// These eleven actions, and the five private helpers below them, were deleted
// from this file by commit 7179955 ("Emailwatcher"). That commit added three
// genuinely new functions (showPendingReplies, replyToDigestItem,
// forwardOriginalToSelf) and, in doing so, wrote back a copy of actions.js
// that predated this block — 740 lines removed, 93 added. Nothing referenced
// them as gone: workflow/brain.js kept routing eleven intents straight at
// functions that no longer existed, so every one of them answered users with
// "Something broke while handling that: actions.X is not a function".
//
// Apsara hit it live asking "any payments today?" — show_receivables.
//
// Restored verbatim from 7179955^ rather than rewritten. Their dependencies
// (helpers/receivables, helpers/tasks, helpers/quoteRequests,
// helpers/addressBook) were all checked to still export what this code calls;
// none of them were touched by that commit.
//
// See also the boot-time wiring check added in workflow/brain.js, which now
// fails loudly if a routed action is missing, so this exact regression can
// never again be discovered by a user in a WhatsApp thread.
// ══════════════════════════════════════════════════════════════════════════

// Strips the question wording off a lookup query, leaving just the place
// name. This is NOT a command grammar — the AI still decides that a message
// IS an address lookup (see brain.js). This only cleans up the NAME once that
// decision is made, because the AI sometimes passes the whole message through
// as target_name rather than isolating the place. Without it, "Junk car
// address" reported "nothing saved" for a place that is very much saved.
// Tried only as a FALLBACK, after the verbatim query has already failed, so a
// real saved name that happens to contain one of these words still wins.
function stripAddressQueryWording(text) {
    let s = String(text || '').trim();
    s = s.replace(/^(?:what(?:'?s| is)|where(?:'?s| is)|show|give|send|get|tell)\b\s*/i, '');
    s = s.replace(/^(?:me|us)\b\s*/i, '');
    s = s.replace(/^the\s+/i, '');
    s = s.replace(/^(?:address|location|mobile|phone|number|contact)\s+(?:of|for)\s+/i, '');
    s = s.replace(/[''`]s\s+(?:address|location|mobile|phone|number|contact)\b/i, '');
    s = s.replace(/\s+(?:address|location|mobile|phone(?:\s+number)?|number|contact|details?|info)\b/i, '');
    s = s.replace(/^(?:is|of|for|at)\s+/i, '');
    return s.replace(/[?.!,]+$/, '').trim();
}

const money = (n) => `$${(Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Read-only address-book lookup. Reached ONLY via the AI classifier's
// 'lookup_address' action — there is deliberately no regex/keyword grammar in
// front of it (2026-08-22, per Apsara: "i cant hardcode everything. let jarvis
// ai handle this"). Safe to be AI-first precisely because it sends nothing and
// changes nothing; a misread costs a wrong address on screen, not a real
// dispatch. See brain.js's SAFE_ACTIONS comment.
//
// REAL INCIDENT that prompted this (2026-08-22): "Junk car address" — a place
// that IS in her address book — was answered with "I'm sorry, I can't help
// with that. My purpose is to assist with freight operations for Edge Metals
// Inc." There was no address-lookup action at all, so the classifier had
// nothing to map it onto and fell through to a canned refusal, despite the
// data being right there.
//
// Reuses quoteRequests' resolveLaneEntry rather than addressBook's
// resolveAddress directly, so a lookup understands exactly the same names the
// quote flow does — aliases, lane abbreviations ("LA"), and a raw-address text
// search — instead of a second, subtly-different matcher drifting from it.
function formatAddressEntry(entry) {
    const name = (entry.aliases && entry.aliases[0]) || '(unnamed)';
    const others = (entry.aliases || []).slice(1);
    const lines = [`*${name}*`];
    if (others.length) lines.push(`(also: ${others.join(', ')})`);
    if (entry.raw) lines.push('', String(entry.raw).trim());
    if (entry.mobile) lines.push('', `Mobile: ${entry.mobile}`);
    if (entry.tags && entry.tags.length) lines.push(`Tagged: ${entry.tags.join(', ')}`);
    return lines.join('\n');
}

// Resolves whoever/whatever the reminder should go to: a real WhatsApp group
// by name first (that's what "Edge Yard group" means), then the saved
// trucker/supplier/contact rosters, then the manager herself.
async function resolveReminderTarget(query, managerChatId) {
    const q = String(query || '').trim();
    if (!q) return { chatId: managerChatId, label: 'you' };
    const bare = q.replace(/\s*\bgroup\b\s*/gi, ' ').trim();
    if (/^(me|manager|myself)$/i.test(q)) return { chatId: managerChatId, label: 'you' };

    // 1. Live WhatsApp groups — the only path that can find "Edge Yard".
    try {
        const waState = require('../helpers/wa-state');
        const groups = await waState.findGroups(bare || q);
        if (groups && groups.length === 1) return { chatId: groups[0].id, label: groups[0].name || q };
        if (groups && groups.length > 1) {
            const exact = groups.find((g) => String(g.name || '').toLowerCase() === (bare || q).toLowerCase());
            if (exact) return { chatId: exact.id, label: exact.name };
            return { ambiguous: groups.slice(0, 8) };
        }
    } catch (e) {
        // WhatsApp not ready / lookup unavailable — fall through to the saved
        // rosters rather than failing outright.
        console.warn('[ACTIONS] reminder group lookup unavailable:', e.message);
    }

    // 2. Saved rosters. Wrapped because loadTruckers/loadSuppliers are
    // Supabase-backed and THROW outright when the DB is unreachable or
    // unconfigured — found while testing 2026-08-22. Letting that propagate
    // would turn a transient DB blip into an unhandled exception for the whole
    // send/reminder, when the WhatsApp-group path above may well have been
    // enough on its own. Degrade to "not found" instead, which the callers
    // already report honestly.
    const ql = (bare || q).toLowerCase();
    try {
        const [truckers, suppliers] = [await loadTruckers(), await loadSuppliers()];
        const roster = [...truckers, ...suppliers];
        const hit = roster.find((r) => String(r.name || '').toLowerCase() === ql)
                 || roster.find((r) => String(r.name || '').toLowerCase().includes(ql));
        if (hit) {
            const chatId = hit.group_id || (hit.whatsapp ? `${hit.whatsapp}@c.us` : null);
            if (chatId) return { chatId, label: hit.name };
        }
    } catch (e) {
        console.warn('[ACTIONS] roster lookup unavailable during target resolve:', e.message);
    }
    try {
        const { loadContacts } = require('../helpers/contacts');
        const c = loadContacts().find((x) => String(x.name || '').toLowerCase().includes(ql));
        if (c) {
            const chatId = c.group_id || (c.whatsapp ? `${c.whatsapp}@c.us` : null);
            if (chatId) return { chatId, label: c.name };
        }
    } catch { /* contacts store optional */ }
    return { notFound: true };
}

// RESTORED 2026-08-22 — lost to a file overwrite, same as the cargo
// validation and the scale-tickets question. Its absence made setReminder
// throw ReferenceError at the moment she used it, so EVERY reminder crashed.
// Caught by testing, not by boot: the constant is only touched on the code
// path that runs when a reminder is actually created.
// Same LA anchor as every other schedule in this app — freight deadlines are
// US port dates. RESTORED alongside NAMED_TIMES (both lost to the same
// overwrite; both only referenced on the create-a-reminder path, so nothing
// failed until she actually set one).
const REMINDER_TZ = 'America/Los_Angeles';
const NAMED_TIMES = { morning: '08:00', afternoon: '14:00', evening: '18:00', night: '20:00', noon: '12:00', midday: '12:00' };
function parseReminderTime(text) {
    const s = String(text || '').toLowerCase().trim();
    if (!s) return null;
    let m = /(\d{1,2})\s*:\s*(\d{2})\s*(am|pm)?/.exec(s);
    if (m) {
        let hh = +m[1]; const mm = +m[2];
        if (m[3] === 'pm' && hh < 12) hh += 12;
        if (m[3] === 'am' && hh === 12) hh = 0;
        if (hh <= 23 && mm <= 59) return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    }
    m = /(\d{1,2})\s*(am|pm)/.exec(s);
    if (m) {
        let hh = +m[1];
        if (m[2] === 'pm' && hh < 12) hh += 12;
        if (m[2] === 'am' && hh === 12) hh = 0;
        if (hh <= 23) return `${String(hh).padStart(2, '0')}:00`;
    }
    for (const [word, time] of Object.entries(NAMED_TIMES)) if (s.includes(word)) return time;
    return null;
}

function parseReminderRepeat(text) {
    const s = String(text || '').toLowerCase();
    const DAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
    for (const [name, idx] of Object.entries(DAYS)) {
        if (new RegExp(`every\\s+${name}|each\\s+${name}|${name}s\\b`).test(s)) return { kind: 'weekly', weekday: idx };
    }
    if (/weekday|working day|business day|mon(day)?\s*(-|to|–)\s*fri/.test(s)) return { kind: 'weekdays' };
    if (/every\s*day|everyday|daily|each day/.test(s)) return { kind: 'daily' };
    return null;
}

function getQueuedPendings(chatId) {
return loadBrain().pending_queue[chatId] || [];
}

// Wipes the active pending AND everything queued behind it, in one shot.
// Added 2026-08-20 for the "cancel all" escape — see resolvePending. Plain
// clearPending only drops the ACTIVE one, which left Apsara in an endless
// cancel loop against a queue several deep.
async function clearAllPending(chatId) {
    const active = getPending(chatId);
    const queued = getQueuedPendings(chatId);
    const count = (active ? 1 : 0) + queued.length;
    await mutateBrain(b => {
        delete b.pending_actions[chatId];
        delete b.pending_queue[chatId];
    });
    return { count, active, queued };
}

async function lookupAddress(chatId, query) {
    const q = String(query || '').trim();
    if (!q) {
        await _send(chatId, `Which place? Give me the name as you've saved it (e.g. "Eccomelt address").`);
        return { action_taken: 'address_no_query' };
    }
    const quoteHelper = require('../helpers/quoteRequests');
    // Verbatim first — a saved name wins even if it contains a word the
    // stripper would otherwise remove. Only fall back to the cleaned-up form.
    let hit = quoteHelper.resolveLaneEntry(q);
    if (!hit) {
        const stripped = stripAddressQueryWording(q);
        if (stripped && stripped.toLowerCase() !== q.toLowerCase()) {
            hit = quoteHelper.resolveLaneEntry(stripped);
        }
    }

    if (!hit) {
        // Honest miss — offer the closest saved names rather than a bare "not
        // found", since the usual cause is a slightly different spelling of a
        // name that IS saved.
        let suggestion = '';
        try {
            const { loadAddressBook } = require('../helpers/addressBook');
            const names = loadAddressBook().map((e) => (e.aliases && e.aliases[0]) || '').filter(Boolean);
            const ql = q.toLowerCase();
            const close = names.filter((n) => {
                const nl = n.toLowerCase();
                return nl.includes(ql) || ql.includes(nl) || nl[0] === ql[0];
            }).slice(0, 6);
            if (close.length) suggestion = `\n\nClosest saved names: ${close.join(', ')}`;
            else if (names.length) suggestion = `\n\n${names.length} places are saved — "show contacts" won't list them, but the Address Book page on the dashboard will.`;
        } catch (err) {
            console.warn('[ACTIONS] address suggestion lookup failed:', err.message);
        }
        await _send(chatId, `Nothing saved in the address book matching "${q}".${suggestion}`);
        return { action_taken: 'address_not_found' };
    }

    if (hit.type === 'ambiguous') {
        const listText = hit.matches
            .map((e, i) => `${i + 1}. ${(e.aliases && e.aliases[0]) || '(unnamed)'} — ${String(e.raw || '').split('\n')[0]}`)
            .join('\n');
        // Deliberately NOT staged as a pending: this is a read-only lookup, and
        // parking a pending here would block the queue behind a question that
        // doesn't need answering. She can just re-ask with the exact name.
        await _send(chatId, `"${q}" matches more than one saved place:\n${listText}\n\nAsk again with the exact name for the full address.`);
        return { action_taken: 'address_ambiguous' };
    }

    await _send(chatId, formatAddressEntry(hit.entry));
    return { action_taken: 'address_shown' };
}

async function showReceivables(chatId, who) {
    const ar = require('../helpers/receivables');
    let ledger;
    try {
        ledger = await ar.buildLedger({ openOnly: true, consignee: who || null });
    } catch (e) {
        await _send(chatId, `Couldn't read the invoice sheet: ${e.message}`);
        return { action_taken: 'receivables_failed' };
    }
    const { rows, totals, orphans, excluded } = ledger;
    // First live run reported $17.2M across 495 invoices — every invoice ever
    // issued, because no payments had been recorded yet. If no opening date is
    // set and the list is clearly historical, say so instead of presenting a
    // meaningless total as if it were her receivables.
    if (!excluded?.openingDate && rows.length > 40) {
        const oldest = rows[0];
        await _send(chatId,
            `That's ${rows.length} invoices totalling ${money(totals.outstanding)} — but that's every invoice on the sheet, not what you're actually owed. No payments have been recorded yet, so nothing has been marked paid.\n\n` +
            `The oldest is ${oldest.days_old}d old (${oldest.inv_no}). Tell me where to start tracking from — e.g. "track receivables from 1 July" — and I'll only count invoices from then. I won't mark the older ones paid, because I don't know that they were; they'll just sit outside the ledger, and you can pull any one back with "track <invoice no>".`);
        return { action_taken: 'receivables_needs_opening_date' };
    }
    if (!rows.length) {
        await _send(chatId, who
            ? `Nothing outstanding from "${who}" — all their invoices are paid.`
            : `Nothing outstanding. Every invoice on the sheet is paid.`);
        return { action_taken: 'receivables_none' };
    }
    // Oldest first (buildLedger already sorts that way) — that's the chase list.
    const lines = rows.slice(0, 15).map((r) => {
        const age = r.days_old === null ? 'date unknown' : `${r.days_old}d`;
        const partial = r.paid > 0 ? ` — ${money(r.paid)} paid` : '';
        return `• ${money(r.balance)} — ${r.consignee || r.customer || '(no name)'}\n   ${r.inv_no} · ${age}${partial}`;
    });
    const bucketOrder = ['90+', '61-90', '31-60', 'current', 'unknown'];
    const bucketLine = bucketOrder
        .filter((b) => totals.buckets[b])
        .map((b) => `${b === 'current' ? '0-30d' : b === 'unknown' ? 'no date' : b + 'd'}: ${money(totals.buckets[b])}`)
        .join('  ·  ');
    const more = rows.length > 15 ? `\n(+${rows.length - 15} more)` : '';
    const orphanWarn = orphans && orphans.length
        ? `\n\n⚠️ ${orphans.length} payment(s) recorded against an invoice number I can't find on the sheet — say "show orphan payments" to see them.`
        : '';
    // Never let the watermark hide money silently — say what's outside it.
    const excludedNote = excluded && excluded.count
        ? `\n\n(Not counted: ${excluded.count} invoice${excluded.count === 1 ? '' : 's'} dated before ${excluded.openingDate}, ${money(excluded.total)}. Not marked paid — just outside the ledger. "track <invoice no>" pulls one back in.)`
        : '';
    await _send(chatId,
        `Outstanding${who ? ` from ${who}` : ''}: *${money(totals.outstanding)}* across ${rows.length} invoice${rows.length === 1 ? '' : 's'}\n${bucketLine}\n\n${lines.join('\n')}${more}${orphanWarn}${excludedNote}`);
    return { action_taken: 'receivables_shown' };
}

// "track receivables from 1 July" — sets the opening watermark. See
// helpers/receivables.js's opening-date block for why this exists and why it
// does NOT mark the older invoices paid.
async function setReceivablesStart(chatId, dateText) {
    const ar = require('../helpers/receivables');
    const d = parseArDate(dateText);
    if (!d) {
        await _send(chatId, `When should I start counting from? Give me a date like "1 July", "2026-07-01" or "July 1 2026".`);
        return { action_taken: 'ar_start_no_date' };
    }
    await ar.setArOpeningDate(d);
    const { rows, totals, excluded } = await ar.buildLedger({ openOnly: true });
    await _send(chatId,
        `Tracking receivables from ${d}.\n\n` +
        `Outstanding since then: *${money(totals.outstanding)}* across ${rows.length} invoice${rows.length === 1 ? '' : 's'}.` +
        (excluded && excluded.count
            ? `\n\n${excluded.count} older invoice${excluded.count === 1 ? '' : 's'} (${money(excluded.total)}) are outside the ledger now. I have NOT marked them paid — I don't know that they were. If any is still owed, say "track <invoice no>" and I'll count it.`
            : ''));
    return { action_taken: 'ar_start_set' };
}
// Accepts "1 July", "July 1", "2026-07-01", "7/1/2026", "1 July 2026".
function parseArDate(text) {
    const s = String(text || '').trim();
    if (!s) return null;
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    if (m) return `${m[1]}-${String(+m[2]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`;
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
    if (m) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return `${y}-${String(+m[1]).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`; }
    const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    const lower = s.toLowerCase();
    for (const [name, mo] of Object.entries(MONTHS)) {
        if (!lower.includes(name)) continue;
        const day = (/\b(\d{1,2})\b(?!\d)/.exec(lower.replace(/\b(19|20)\d{2}\b/, '')) || [])[1];
        const yr = (/\b((?:19|20)\d{2})\b/.exec(lower) || [])[1] || String(new Date().getUTCFullYear());
        if (day) return `${yr}-${String(mo).padStart(2, '0')}-${String(+day).padStart(2, '0')}`;
        return `${yr}-${String(mo).padStart(2, '0')}-01`;
    }
    return null;
}
// "track 25RMT116" — pull one pre-opening-date invoice back into the ledger.
async function trackOldInvoiceCmd(chatId, invRef) {
    const ar = require('../helpers/receivables');
    if (!invRef) {
        await _send(chatId, `Which invoice should I start counting? Give me its number.`);
        return { action_taken: 'ar_track_no_ref' };
    }
    const hit = await ar.resolveInvoice(invRef, { openOnly: false });
    if (hit.candidates && hit.candidates.length) {
        await _send(chatId, `"${invRef}" matches more than one invoice:\n${hit.candidates.map((c) => `• ${c.inv_no} — ${c.consignee || c.customer}`).join('\n')}\n\nGive me the exact number.`);
        return { action_taken: 'ar_track_ambiguous' };
    }
    if (!hit.match) {
        await _send(chatId, `Couldn't find an invoice matching "${invRef}".`);
        return { action_taken: 'ar_track_not_found' };
    }
    await ar.trackOldInvoice(hit.match.inv_no);
    await _send(chatId, `Now counting ${hit.match.inv_no} (${hit.match.consignee || hit.match.customer}) — ${money(hit.match.balance)} open — even though it predates the tracking start date.`);
    return { action_taken: 'ar_track_added' };
}

async function recordPayment(chatId, { invoiceRef, amount, paidOn, method, note }, senderName) {
    const ar = require('../helpers/receivables');
    if (!invoiceRef) {
        await _send(chatId, `Payment against which invoice? Give me the invoice number or the customer name.`);
        return { action_taken: 'payment_no_invoice' };
    }
    if (ar.parseAmount(amount) === null) {
        await _send(chatId, `How much was paid against ${invoiceRef}?`);
        return { action_taken: 'payment_no_amount' };
    }
    let res;
    try {
        res = await ar.recordPaymentByRef(invoiceRef, {
            amount, paid_on: paidOn || null, method: method || null, note: note || null,
            recorded_by: senderName || null,
        });
    } catch (e) {
        await _send(chatId, `Couldn't record that: ${e.message}`);
        return { action_taken: 'payment_failed' };
    }
    if (res.candidates) {
        const list = res.candidates.map((c) => `• ${c.inv_no} — ${c.consignee || c.customer} · ${money(c.balance)} open`).join('\n');
        await _send(chatId, `"${invoiceRef}" matches more than one invoice:\n${list}\n\nTell me which invoice number and I'll record it.`);
        return { action_taken: 'payment_ambiguous' };
    }
    if (res.notFound) {
        await _send(chatId, `Couldn't find an invoice matching "${invoiceRef}". Check the invoice number — nothing has been recorded.`);
        return { action_taken: 'payment_invoice_not_found' };
    }
    const inv = res.invoice;
    const settled = inv.balance <= 0.01
        ? `That clears it — ${inv.inv_no} is fully paid.`
        : `${money(inv.balance)} still outstanding on ${inv.inv_no}.`;
    await _send(chatId, `Recorded ${money(res.payment.amount)} against ${inv.inv_no} (${inv.consignee || inv.customer}). ${settled}`);
    return { action_taken: 'payment_recorded' };
}

async function showOrphanPayments(chatId) {
    const ar = require('../helpers/receivables');
    const { orphans } = await ar.buildLedger({});
    if (!orphans.length) {
        await _send(chatId, `No orphaned payments — every recorded payment matches an invoice on the sheet.`);
        return { action_taken: 'orphans_none' };
    }
    const lines = orphans.map((p) => `• ${money(p.amount)} recorded against "${p.inv_no}" on ${p.paid_on}${p.note ? ` (${p.note})` : ''}`);
    await _send(chatId, `These payments don't match any invoice number on the sheet:\n${lines.join('\n')}\n\nEither the invoice number was mistyped, or that invoice isn't on the sheet yet.`);
    return { action_taken: 'orphans_shown' };
}

// Send a WhatsApp message to a group/trucker/supplier/contact, right now.
// Built 2026-08-22 — Apsara: "IF I SAY JARV TO SEND SOMETHING TO SOMEONE, WHY
// CANT IT DO IT". Answer: there was no action for it. `ask_contact` sends a
// QUESTION and stages a pending to relay the answer back; `draft_email` is
// email. Nothing existed for the plainest possible request — "tell X this."
// Third instance this week of the same root pattern (see
// claude/jarvis-ai-first-map.md): the AI can only choose from an exhaustive
// action list, so a missing capability reads to the user as a refusal.
//
// DELIBERATELY NOT gated behind a yes/no confirm, unlike draft_email. The
// email gate exists because the AI DRAFTS the wording there — it invents
// content that goes out over her name. Here she supplies the exact text and
// the exact recipient; the AI only routes it. The one real risk left is a
// wrong recipient, which is handled by resolving strictly (no guessing at
// numbers she didn't name), refusing to send when the name is ambiguous, and
// echoing back exactly what went where so a mistake is visible immediately
// rather than discovered later. Adding a confirm step here would reintroduce
// exactly the friction she's objecting to, for a risk that's already covered.
async function sendMessageTo(chatId, { target, message }) {
    const text = String(message || '').trim();
    if (!target || !String(target).trim()) {
        await _send(chatId, `Send it to whom? Give me a group or contact name.`);
        return { action_taken: 'send_no_target' };
    }
    if (!text) {
        await _send(chatId, `What should I send to ${target}?`);
        return { action_taken: 'send_no_message' };
    }
    const resolved = await resolveReminderTarget(target, chatId);
    if (resolved.ambiguous) {
        const list = resolved.ambiguous.map((g, i) => `${i + 1}. ${g.name}`).join('\n');
        await _send(chatId, `More than one group matches "${target}":\n${list}\n\nSay it again with the exact name and I'll send it.`);
        return { action_taken: 'send_target_ambiguous' };
    }
    if (resolved.notFound) {
        await _send(chatId, `Couldn't find "${target}" — no WhatsApp group, trucker, supplier or contact by that name. Check the exact name (I have to be a member of the group) and I'll send it.`);
        return { action_taken: 'send_target_not_found' };
    }
    const ok = await _send(resolved.chatId, text);
    if (!ok) {
        await _send(chatId, `Couldn't deliver that to ${resolved.label} — WhatsApp rejected the send. Nothing went out.`);
        return { action_taken: 'send_failed' };
    }
    await _send(chatId, `Sent to ${resolved.label}: "${text}"`);
    return { action_taken: 'message_sent' };
}

// Dates for a ONE-OFF reminder — "on 8/27", "27 Aug", "tomorrow", "Friday".
// Separate from parseArDate (which expects a settings-style date) because the
// phrasings she uses in chat are looser. Returns YYYY-MM-DD or null.
function parseOnceDate(text, now = new Date()) {
    const s = String(text || '').toLowerCase().trim();
    if (!s) return null;
    const iso = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    const todayUTC = () => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    // ISO first. "on 2020-01-01" would otherwise hit the M/D branch below,
    // which reads "20-01" out of the middle of the year and invents a date —
    // a past-date guard can't work if the date silently becomes a future one.
    let m = /\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/.exec(s);
    if (m) {
        const mo = +m[2], d = +m[3];
        if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return iso(new Date(Date.UTC(+m[1], mo - 1, d)));
    }
    m = /\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/.exec(s);
    if (m) {
        const mo = +m[1], d = +m[2];
        let y = m[3] ? +m[3] : now.getUTCFullYear();
        if (y < 100) y += 2000;
        if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
            const dt = new Date(Date.UTC(y, mo - 1, d));
            // No year given and it already passed → they mean next year.
            if (!m[3] && dt.getTime() < todayUTC().getTime()) dt.setUTCFullYear(y + 1);
            return iso(dt);
        }
    }
    if (/\btomorrow\b/.test(s)) return iso(new Date(todayUTC().getTime() + 86400000));
    if (/\btoday\b/.test(s)) return iso(todayUTC());
    const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    for (const [name, mo] of Object.entries(MONTHS)) {
        if (!s.includes(name)) continue;
        const day = (/\b(\d{1,2})\b(?!\d)/.exec(s.replace(/\b(19|20)\d{2}\b/, '')) || [])[1];
        if (!day) continue;
        const yr = +((/\b((?:19|20)\d{2})\b/.exec(s) || [])[1] || now.getUTCFullYear());
        const dt = new Date(Date.UTC(yr, mo - 1, +day));
        if (dt.getTime() < todayUTC().getTime() && !/\b(19|20)\d{2}\b/.test(s)) dt.setUTCFullYear(yr + 1);
        return iso(dt);
    }
    const WD = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
    for (const [name, idx] of Object.entries(WD)) {
        if (!new RegExp(`\\b${name}\\b`).test(s)) continue;
        let delta = (idx - now.getUTCDay() + 7) % 7;
        if (delta === 0) delta = 7;
        return iso(new Date(todayUTC().getTime() + delta * 86400000));
    }
    return null;
}

async function setReminder(chatId, { target, message, when }) {

    const tasksHelper = require('../helpers/tasks');
    let text = String(message || '').trim();
    let targetOverride = null;

    // ── "3-remind on 8/27" — a reminder ABOUT a digest item ────────────────
    // REAL BUG (2026-08-22, live). She wrote "3-remind on 8/27" meaning item 3
    // of the email digest. Two things went wrong:
    //   1. Nothing connected the "3" to the digest, so it asked what the
    //      reminder should say.
    //   2. She pasted the item text back — which names Andy Park, the SENDER —
    //      and the target resolver then hunted for a contact called "Andy
    //      Park" to MESSAGE. She wanted a note to herself about that email,
    //      not an outbound message to him.
    // So a bare digest index is resolved here, and a reminder built from a
    // digest item always goes to HER unless she named a different recipient.
    const digestRef = /(?:^|\b)(?:item\s*)?#?(\d{1,2})\b[\s,;:-]*(?:remind|reminder|follow\s*up)|(?:remind|reminder|follow\s*up)[\s,;:-]*(?:me\s*)?(?:about|on|for)?\s*(?:item\s*)?#?(\d{1,2})\b/i;
    const refSource = `${target || ''} ${when || ''} ${message || ''}`;
    const refMatch = digestRef.exec(refSource);
    if (refMatch) {
        const n = parseInt(refMatch[1] || refMatch[2], 10);
        try {
            const { resolveDigestIndex } = require('./replyWatch');
            const item = resolveDigestIndex(n);
            if (item) {
                text = `Follow up: ${item.asked_for || item.summary || item.subject} (from ${item.fromName})`;
                targetOverride = 'me';
            } else {
                await _send(chatId, `I don't have an item ${n} from the last email digest. Ask "what needs my reply" for a fresh list.`);
                return { action_taken: 'reminder_bad_digest_ref' };
            }
        } catch (e) {
            console.warn('[ACTIONS] digest ref lookup failed:', e.message);
        }
    }

    if (!text) {
        await _send(chatId, `What should the reminder say?`);
        return { action_taken: 'reminder_no_message' };
    }
    const at = parseReminderTime(when) || parseReminderTime(target) || '08:00';

    // ── One-off vs recurring ────────────────────────────────────────────────
    // REAL BUG (2026-08-22, live): "3-remind on 8/27" found no recurrence
    // words, and the old code fell back to `{ kind: 'daily' }`. A reminder for
    // ONE date would have fired every morning forever, and the only way to
    // notice would have been the second day's spam. A stated date is the
    // clearest possible signal that she means ONCE — defaulting the other way
    // was never defensible.
    //
    // So: recurrence words ("every day", "weekdays", "every Monday") make it
    // recurring. A concrete date makes it one-off. Neither makes it one-off
    // TOMORROW, not daily — the safe direction for a guess is the one that
    // stops on its own.
    const explicitRepeat = parseReminderRepeat(when) || parseReminderRepeat(target);
    const onceDate = explicitRepeat ? null : (parseArDate(when) || parseOnceDate(when) || parseOnceDate(target));
    const repeat = explicitRepeat ? { ...explicitRepeat, at, tz: REMINDER_TZ } : null;

    const resolved = await resolveReminderTarget(targetOverride || target, chatId);
    if (resolved.ambiguous) {
        const list = resolved.ambiguous.map((g, i) => `${i + 1}. ${g.name}`).join('\n');
        await _send(chatId, `More than one group matches "${target}":\n${list}\n\nAsk again with the exact group name.`);
        return { action_taken: 'reminder_target_ambiguous' };
    }
    if (resolved.notFound) {
        await _send(chatId, `Couldn't find "${target}" — no WhatsApp group, trucker, supplier or contact by that name. Check the exact group name (I have to be a member of it) and ask again.`);
        return { action_taken: 'reminder_target_not_found' };
    }

    let next;
    if (repeat) {
        next = tasksHelper.nextFireAt(repeat, new Date());
    } else if (onceDate) {
        // Fire at `at` on that date, in the same LA zone every other schedule
        // in this app uses.
        next = tasksHelper.nextFireAt({ kind: 'daily', at, tz: REMINDER_TZ }, new Date(`${onceDate}T00:00:00Z`));
        // nextFireAt returns the NEXT slot strictly after its anchor, which
        // for a midnight anchor is that same day at `at` — exactly what we
        // want. If the date has already passed, say so rather than firing
        // immediately or silently skipping to next year.
        if (next && next.getTime() < Date.now()) {
            await _send(chatId, `${onceDate} has already passed — give me a future date and I'll set it.`);
            return { action_taken: 'reminder_date_past' };
        }
    }
    if (!next) {
        await _send(chatId, `Couldn't work out when from "${when || target}". Try a date ("on 8/27", "27 Aug") or a repeat ("every day at 8am", "every Monday 9:30").`);
        return { action_taken: 'reminder_bad_schedule' };
    }
    const task = await tasksHelper.enqueue({
        type: 'generic_message',
        target_kind: 'group',
        target_name: resolved.label,
        target_chat: resolved.chatId,
        message: text,
        fire_at: next.toISOString(),
        // Omitted entirely for a one-off, so scheduler.js archives it after
        // firing instead of rescheduling — see its `if (task.repeat)` branch.
        ...(repeat ? { repeat } : {}),
        created_by: 'brain',
        max_tries: 3,
    });
    const whenText = repeat ? tasksHelper.describeRepeat(repeat) : `once, on ${onceDate}`;
    await _send(chatId, `Done — I'll message ${resolved.label} ${whenText} (LA time): "${text}"\n\nFirst one: ${next.toLocaleString('en-US', { timeZone: REMINDER_TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.\nSay "show reminders" to see them, or "cancel reminder ${task.id.slice(0, 6)}" to stop it.`);
    return { action_taken: 'reminder_set' };
}

async function showReminders(chatId) {
    const tasksHelper = require('../helpers/tasks');
    const all = tasksHelper.loadTasks().filter((t) => t.repeat && t.status !== 'cancelled');
    if (!all.length) {
        await _send(chatId, `No recurring reminders set up. Set one with something like: "remind Edge Yard group every day at 8am to update the pricelist".`);
        return { action_taken: 'reminders_none' };
    }
    const lines = all.map((t) => {
        const next = t.fire_at ? new Date(t.fire_at).toLocaleString('en-US', { timeZone: REMINDER_TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '?';
        return `• [${t.id.slice(0, 6)}] ${t.target_name || t.target_chat} — ${tasksHelper.describeRepeat(t.repeat)}\n   "${t.message}"\n   next: ${next}`;
    });
    await _send(chatId, `Recurring reminders:\n\n${lines.join('\n\n')}\n\nCancel one with "cancel reminder <id>".`);
    return { action_taken: 'reminders_shown' };
}

async function cancelReminder(chatId, idFragment) {
    const tasksHelper = require('../helpers/tasks');
    const frag = String(idFragment || '').trim().toLowerCase();
    const all = tasksHelper.loadTasks().filter((t) => t.repeat);
    if (!frag) {
        await _send(chatId, `Which one? Say "show reminders" for the list, then "cancel reminder <id>".`);
        return { action_taken: 'reminder_cancel_no_id' };
    }
    const matches = all.filter((t) => t.id.toLowerCase().startsWith(frag)
        || String(t.target_name || '').toLowerCase().includes(frag)
        || String(t.message || '').toLowerCase().includes(frag));
    if (!matches.length) {
        await _send(chatId, `No recurring reminder matching "${idFragment}". Say "show reminders" to see what's set.`);
        return { action_taken: 'reminder_cancel_not_found' };
    }
    if (matches.length > 1) {
        const list = matches.map((t) => `• [${t.id.slice(0, 6)}] ${t.target_name} — "${t.message}"`).join('\n');
        await _send(chatId, `That matches more than one:\n${list}\n\nUse the id in brackets.`);
        return { action_taken: 'reminder_cancel_ambiguous' };
    }
    await tasksHelper.cancel(matches[0].id, 'user_cancelled');
    await _send(chatId, `Cancelled — no more "${matches[0].message}" to ${matches[0].target_name}.`);
    return { action_taken: 'reminder_cancelled' };
}

// Mandatory yes/no — re-asks on anything that isn't recognizably a yes/no,
// same "don't silently let an unanswered required field through" principle
// as the cargo weight/value fix (resumeQuoteWithCargoDetails below).
async function resumeQuoteWithScaleTickets(chatId, pending, scaleText) {
    const clean = String(scaleText || '').trim().toLowerCase();
    const isYes = /^(y|yes|yeah|yep|need|needed)$/i.test(clean);
    const isNo  = /^(n|no|nope|not needed|don'?t need)$/i.test(clean);
    if (!isYes && !isNo) {
        await _send(chatId, `Just need a yes or no — do you need scale tickets for this haul?`);
        return { action_taken: 'quote_scale_tickets_retry' };
    }
    await clearPending(chatId);
    return continueQuoteFlow(chatId, { ...pending.state, scaleTicketsNeeded: isYes });
}

module.exports = {
    showPendingReplies, replyToDigestItem, forwardOriginalToSelf, sendDraftedEmail,
init,
setPending, clearPending, getPending, resolvePending, promoteQueued,
showMenu, showBookingsMenu, showBookingStatus, showContacts,
showBookingsAll, showBookingsUrgent, showBookingsAvailable, showBookingsWeek,
forwardBooking, executeForward,
assignSupplier, executeAssign,
emptyDropConfirmed, loadReadyReceived, pickedUpConfirmed, scaleTicketReceived, ingateReceived, yardScaleTicketReceived,
askWhichBooking, askWhichContainer, fireResolvedStateIntent,
recallBooking, executeRecall, archiveNow,
showErd, showCutoff, getBookingField,
scheduleFollowup, escalateUnclear, rememberFact, addBusinessContext, logKnowledgeGap, resolveFactBatch,
    draftEmailForConfirm, sendDraftedEmail, scheduleDraftedEmail, reschedulePendingEmail, searchMail, draftReplyForConfirm, backfillCutoffs,
    resolveManualEmailAddress, learnDomainForConfirm, resolveDomainLearnName,
checkSupplierReadiness, resolveReadyCheckYes, resolveReadyCheckNo, resolveReadyCheckDate, recordContainerNumber, sendPriceListTo, sendPriceListCity, relayQuestionToContact, relayReplyReceived, relayReplyReceivedViaEmail, detectExpectedIntent,
    startQuoteRequestFlow, resumeQuoteWithTruckerNames, resumeQuoteWithCargoDetails, resumeQuoteWithTruckerRetry, handleQuoteLegReply,
    startContactQuoteRequestFlow, resumeContactQuoteWithRetry, handleContactQuoteLegReply,
    // Restored 2026-08-22 — dropped by commit 7179955 while brain.js kept
    // routing to them. See the block comment above their definitions.
    // getQueuedPendings/clearAllPending have no brain.js route; they're used
    // by tests/cancel-loop.js, which has been failing to require them since.
    getQueuedPendings, clearAllPending,
    lookupAddress, sendMessageTo,
    showReceivables, recordPayment, showOrphanPayments, setReceivablesStart, trackOldInvoiceCmd,
verifyBookings,
    setReminder, showReminders, cancelReminder,
    askForScaleTickets, resumeQuoteWithScaleTickets,
};