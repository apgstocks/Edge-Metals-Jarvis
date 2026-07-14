// ── helpers/context.js — One normalized context object for policy + AI ───────
// Replaces Redis (sessions → in-memory Map with TTL; survives nothing but a
// restart, which is fine — pending ACTIONS persist in brain.json) and
// Firestore (transcripts/facts → data/*.json via helpers/json).

const { loadBookings, loadWorkflow, loadTruckers, loadSuppliers,
    loadBrain, loadTranscripts, loadFacts } = require('./json');
const { getUrgentBookings, formatBookingFull }  = require('./booking');
const { getLATime, daysUntil }                  = require('./time');
const memory = require('./memory');
const cfg = require('../config');

// ── Sessions — in-memory Map is the hot path (unchanged sync contract for
// every existing caller), backed by memory.js for durability. On a cache
// miss (cold start, or after a restart) we restore synchronously from disk —
// loadJson is a plain sync read, so no caller anywhere needs to become async
// for this to work. Writes persist in the background (fire-and-forget) so
// updateSession's existing synchronous return value is untouched.
const SESSION_TTL_MS = 4 * 60 * 60 * 1000;
const sessions = new Map();

function getSession(chatId) {
let s = sessions.get(chatId);
if (!s) {
    // Cold cache — try restoring the live state that was persisted before
    // the last restart. summaryHistory is intentionally NOT restored into
    // the hot session object; it's read separately via getRecentSummaries.
    const persisted = memory.getSessionMemory(chatId);
    if (persisted && (persisted.currentTopic || persisted.activeBooking || persisted.lastInstruction || persisted.unansweredQuestion || persisted.menuContext)) {
        s = {
            currentTopic: persisted.currentTopic ?? null,
            activeBooking: persisted.activeBooking ?? null,
            unansweredQuestion: persisted.unansweredQuestion ?? null,
            lastInstruction: persisted.lastInstruction ?? null,
            menuContext: persisted.menuContext ?? null,
            _touched: Date.now(),
        };
        sessions.set(chatId, s);
    } else {
        return null;
    }
}
if (Date.now() - s._touched > SESSION_TTL_MS) {
    // Session idle-expired — archive a summary of it before dropping, so
    // the conversation isn't just silently lost.
    memory.archiveSessionSummary(chatId, s).catch(e => console.error('[MEMORY] archive failed:', e.message));
    memory.clearSessionMemory(chatId).catch(e => console.error('[MEMORY] clear failed:', e.message));
    sessions.delete(chatId);
    return null;
}
return s;
}

function updateSession(chatId, patch) {
const s = getSession(chatId) || {
    currentTopic: null, activeBooking: null,
    unansweredQuestion: null, lastInstruction: null, menuContext: null,
};
Object.assign(s, patch, { _touched: Date.now() });
sessions.set(chatId, s);
// Background persist — never blocks or changes this function's sync contract.
memory.saveSessionMemory(chatId, s).catch(e => console.error('[MEMORY] save failed:', e.message));
return s;
}

function clearSession(chatId) {
const s = sessions.get(chatId);
if (s) memory.archiveSessionSummary(chatId, s).catch(e => console.error('[MEMORY] archive failed:', e.message));
memory.clearSessionMemory(chatId).catch(e => console.error('[MEMORY] clear failed:', e.message));
sessions.delete(chatId);
}

// ── Slot mapping — which bookings does this trucker/supplier chat own? ────────
function findSlotsForGroup(chatId) {
const workflow = loadWorkflow();
const bookings = loadBookings();
return Object.entries(workflow)
    .filter(([bkgNo, wf]) =>
        bookings[bkgNo] &&
        !cfg.TERMINAL_STEPS.includes(wf.step) &&
        (wf.trucker_group_id === chatId || wf.supplier_group_id === chatId))
    .map(([bkgNo, wf]) => ({ bkgNo, wf }));
}

// ── Build full context ────────────────────────────────────────────────────────
function buildContext(inbound, pendingAction) {
const session = getSession(inbound.chatId) || {
    currentTopic: null, activeBooking: null,
    unansweredQuestion: null, lastInstruction: null, menuContext: null,
};

// Resolve active booking
let activeBooking = session.activeBooking || null;
let activeSlots   = [];

if (inbound.isTrucker || inbound.isSupplier) {
    activeSlots = findSlotsForGroup(inbound.chatId);
    if (activeSlots.length === 1)     activeBooking = activeSlots[0].bkgNo;
    else if (activeSlots.length > 1)  activeBooking = null; // needs disambiguation
} else if (inbound.isManagerOrTeam && !activeBooking) {
    activeBooking = pendingAction?.bkg_no || null;
}

const bookings = loadBookings();
const workflow = loadWorkflow();
const booking  = activeBooking ? (bookings[activeBooking] || null) : null;
const wf       = activeBooking ? (workflow[activeBooking] || null) : null;

return {
    ...inbound,
    session,
    pendingAction: pendingAction || null,
    activeBooking,
    activeSlots,
    booking,
    workflow: wf,
    truckers : loadTruckers(),
    suppliers: loadSuppliers(),
    allBookings: bookings,
    allWorkflow: workflow,
    urgentBookings: getUrgentBookings(),
};
}

// ── AI-facing view — session summary + last 5 messages + facts, never raw dump ─
function formatForAI(ctx) {
const transcripts = loadTranscripts(ctx.chatId, 5)
    .map(t => `[${t.senderRole}] ${t.senderName}: ${t.text}${t.hasMedia ? ' [media]' : ''}`)
    .join('\n') || '(none)';

const facts = loadFacts().slice(-15).map(f => `- ${f.text}`).join('\n') || '(none)';

// Business context — separate from facts: ongoing situations, not corrections.
const businessContext = memory.loadBusinessContext().slice(-15).map(c => `- ${c.text}`).join('\n') || '(none)';

// Recent summaries of past sessions with THIS chat — continuity across
// restarts/idle gaps, e.g. "last time: booking DALA... | left open: ...".
const recentSummaries = memory.getRecentSummaries(ctx.chatId, 3)
    .map(s => `- (${new Date(s.closed_at).toLocaleDateString()}) ${s.text}`)
    .join('\n') || '(none)';

const urgent = ctx.urgentBookings
    .map(b => `${b.booking_number} cutoff ${b.cutoff_date} (${daysUntil(b.cutoff_date)}d)`)
    .join('\n') || '(none)';

// Full operational knowledge base — every active booking + contact roster,
// compact one-line-per-record so token cost stays flat as data grows.
// This is deliberately NOT a raw JSON dump (fields, timestamps, ids) — just
// enough for the AI to answer "what/how many/who" questions about anything
// currently active. Archived/history bookings are NOT included here (kept
// out to bound token cost) — a manager asking about a closed booking gets
// told to check the dashboard → History, not silently missed.
const byPort = {};
const bookingRows = [];
for (const b of Object.values(ctx.allBookings || {})) {
    const wf = (ctx.allWorkflow || {})[b.booking_number] || {};
    const p = b.port_of_loading || '(no POL)';
    byPort[p] = byPort[p] || { total: 0, unassigned: 0 };
    byPort[p].total++;
    if (!b.supplier) byPort[p].unassigned++;
    bookingRows.push(
        `${b.booking_number} | ${p}→${b.port_of_discharge || '?'} | supplier:${b.supplier || wf.supplier || '—'} | trucker:${wf.trucker_name || '—'} | stage:${wf.step || 'not_started'} | cutoff:${b.cutoff_date || '—'}`
    );
}
const portStats = Object.entries(byPort)
    .map(([p, s]) => `${p}: ${s.total} total, ${s.unassigned} unassigned`)
    .join('\n') || '(no active bookings)';
const bookingsTable = bookingRows.join('\n') || '(no active bookings)';

const truckerRoster  = (ctx.truckers  || []).map(t => `${t.name}${t.locality ? ' (' + t.locality + ')' : ''}`).join(', ') || '(none registered)';
const supplierRoster = (ctx.suppliers || []).map(s => `${s.name}${s.locality ? ' (' + s.locality + ')' : ''}`).join(', ') || '(none registered)';

return {
    now_la        : getLATime(),
    senderName    : ctx.senderName,
    role          : ctx.role,
    hasMedia      : !!ctx.hasMedia,
    activeBooking : ctx.activeBooking || '(none)',
    currentStep   : ctx.workflow?.step || '(no workflow)',
    pendingAction : ctx.pendingAction ? JSON.stringify(ctx.pendingAction) : '(none)',
    bookingContext: ctx.booking ? formatBookingFull(ctx.booking) : '(no active booking)',
    sessionSummary: JSON.stringify({
        topic: ctx.session.currentTopic,
        lastInstruction: ctx.session.lastInstruction,
        unanswered: ctx.session.unansweredQuestion,
    }),
    transcripts,
    facts,
    businessContext,
    recentSummaries,
    urgentBookings: urgent,
    portStats,
    bookingsTable,
    truckerRoster,
    supplierRoster,
    message       : ctx.text,
    slots         : ctx.activeSlots.map(s => s.bkgNo).join(', ') || '(none)',
};
}

module.exports = {
getSession, updateSession, clearSession,
findSlotsForGroup, buildContext, formatForAI,
};