// ── helpers/context.js — One normalized context object for policy + AI ───────
// Replaces Redis (sessions → in-memory Map with TTL; survives nothing but a
// restart, which is fine — pending ACTIONS persist in brain.json) and
// Firestore (transcripts/facts → data/*.json via helpers/json).

const { loadBookings, loadWorkflow, loadTruckers, loadSuppliers,
    loadBrain, loadTranscripts, loadFacts, loadActiveFacts, loadBelievableFacts } = require('./json');
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
async function buildContext(inbound, pendingAction) {
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
    truckers : await loadTruckers(),
    suppliers: await loadSuppliers(),
    allBookings: bookings,
    allWorkflow: workflow,
    urgentBookings: getUrgentBookings(),
};
}

// ── AI-facing view — session summary + last 5 messages + facts, never raw dump ─
async function formatForAI(ctx) {
const transcripts = loadTranscripts(ctx.chatId, 5)
    .map(t => `[${t.senderRole}] ${t.senderName}: ${t.text}${t.hasMedia ? ' [media]' : ''}`)
    .join('\n') || '(none)';

// Pinned facts (2026-08-16, per Apsara — see helpers/json.js's addFact
// header) always ride along, regardless of how many newer facts have been
// added since; only the unpinned pool is windowed to the most recent 15.
// ── ACTIVE ONLY (2026-08-25, phase 2) ──────────────────────────────────────
// Phase 3: also excludes authority 'none' — external-origin facts, and
// anything derived from them. Those are recorded and auditable but are never
// stated to the model as beliefs, because a sentence a supplier typed into
// an email must not be indistinguishable from a rule Apsara set.
// Was loadFacts(), which now also returns superseded and retracted records.
// If this ever goes back to loadFacts(), a fact Apsara explicitly corrected
// or retracted silently starts shaping answers again — alongside the fact
// that replaced it, with nothing saying which is current. That is precisely
// the bug phase 2 exists to close.
const allFacts = loadBelievableFacts();

// ── PHASE 4: select, don't truncate ────────────────────────────────────────
// The old rule was "every pinned fact, plus the last 15 unpinned". Recency
// did all the work, and the pinned pool is deliberately uncapped, so the
// prompt grew without bound while the facts that mattered got buried.
// selectForPrompt ranks by relevance + importance + recency + confirmation
// strength under a token budget, holds back long-unused low-importance facts
// as dormant (retained and searchable, just not injected), and REPORTS what
// it had to cut. See helpers/factRetrieval.js.
//
// Relevance is filled in below from the semantic search when it is
// available. When it isn't — outage, no key, no vectors yet — this still
// ranks sensibly on importance/recency/strength instead of collapsing to
// insertion order.
const factRetrieval = require('./factRetrieval');
// Roughly 1.2k tokens of standing memory. Sized against the Zep/Mem0 finding
// that a well-selected ~1.6k-token memory context beat a 115k full-context
// dump on LongMemEval — more memory in the prompt is not more recall, past
// the point where the relevant part stops standing out.
const FACT_BUDGET_TOKENS = Number(process.env.JARVIS_FACT_BUDGET_TOKENS) || 1200;
let factRelevance = null;   // set by the semantic-search block below

// Business context — separate from facts: ongoing situations, not corrections.
const businessContext = memory.loadBusinessContext().slice(-15).map(c => `- ${c.text}`).join('\n') || '(none)';

// Recent summaries of past sessions with THIS chat — continuity across
// restarts/idle gaps, e.g. "last time: booking DALA... | left open: ...".
const recentSummaries = memory.getRecentSummaries(ctx.chatId, 3)
    .map(s => `- (${new Date(s.closed_at).toLocaleDateString()}) ${s.text}`)
    .join('\n') || '(none)';

// Semantic memory — genuine RAG, not recency. One embedding search covers
// TWO recall needs, split apart by the `type` tag each row was stored with
// (search itself isn't type-filtered at the DB level — see
// helpers/embeddings.js/searchSimilar — so overfetch topK and split
// client-side rather than adding a second embedding API call, which is real
// per-message cost, not free):
//   - session_summary rows -> "what did we decide about the Houston delay"
//     even if that conversation was days ago and isn't in the recent window.
//   - fact rows (2026-08-16, per Apsara's "remembers forever like a child
//     being taught" ask, researched against mem0/Letta's "archival memory"
//     pattern) -> an UNPINNED fact that's aged out of the last-15 window
//     above can still surface here if it's actually relevant to what's
//     being asked right now, instead of just silently going unread forever.
//     Deduped against pinnedFacts/recentUnpinned by text so nothing repeats.
let semanticMemory = '(none)';
let semanticFactMatches = [];
let semanticFactCandidates = [];
try {
    const embeddings = require('./embeddings');
    const matches = await embeddings.searchSimilar(ctx.text, { topK: 10, minSimilarity: 0.55 });
    const summaryMatches = matches.filter(m => m.type === 'session_summary').slice(0, 3);
    if (summaryMatches.length) {
        semanticMemory = summaryMatches
            .map(m => `- (${new Date(m.created_at).toLocaleDateString()}, ${Math.round(m.similarity * 100)}% match) ${m.text}`)
            .join('\n');
    }
    // ── READ-TIME TOMBSTONE FILTER (2026-08-25) ────────────────────────────
    // THE fix for the worst bug in the memory layer. A fact deleted from
    // facts.json left its vector row behind in Supabase, and this very
    // block pulled it straight back into the prompt as "[recalled from
    // memory, N% relevant]". Apsara could delete a wrong fact, see it
    // disappear from the dashboard, and have Jarvis keep applying it
    // indefinitely — with the recall label making it look MORE credible,
    // not less.
    //
    // helpers/json.js's deleteFactById now also deletes the vector row, so
    // in the normal case nothing reaches here to filter. This exists for
    // the abnormal case, which this codebase has a real track record of:
    // that delete is a network call, and every Supabase call in this file
    // is wrapped in a "(non-fatal)" catch. One outage during one delete
    // would otherwise resurrect a retracted fact permanently.
    //
    // So: the LOCAL facts file is the authority on what Jarvis currently
    // believes. A semantic hit that no longer corresponds to a live fact is
    // not memory, it is a leak — drop it, whatever the similarity score.
    // allFacts is ACTIVE-only as of phase 2, so this same filter now also
    // drops semantic hits for superseded and retracted facts — a corrected
    // rate can't be recalled alongside the rate that replaced it.
    const liveFactTexts = new Set(allFacts.map(f => f.text));
    // Feed the similarity scores into phase 4's ranking. Every fact hit gets
    // recorded here, not just the ones surfaced as "recalled from memory"
    // below — a fact that IS already in the prompt should still have its
    // relevance counted when deciding what stays in the budget.
    factRelevance = new Map();
    for (const m of matches || []) {
        if (m.type === 'fact' && Number.isFinite(m.similarity)) factRelevance.set(m.text, m.similarity);
    }

    // Deduping against what the prompt already carries has to wait until
    // AFTER selection below — selection needs factRelevance from this block,
    // so it cannot run first. Keep the live-fact filtering here (it only
    // needs allFacts) and finish the dedup once the selection exists.
    semanticFactCandidates = matches
        .filter(m => m.type === 'fact')
        .filter((m) => {
            if (liveFactTexts.has(m.text)) return true;
            console.warn(`[CONTEXT] dropped a semantic hit with no live fact behind it (stale vector row): "${String(m.text).slice(0, 60)}"`);
            return false;
        });
} catch (e) {
    console.error('[CONTEXT] semantic search failed (non-fatal):', e.message);
}

// An `inform` fact (Jarvis's own inference) is labelled so the model can
// weigh it differently from something Apsara actually said. Unlabelled, a
// guess Jarvis made about itself reads with exactly the same weight as a
// standing instruction — which is how an inference quietly becomes policy.
const factLine = (f) => (f.authority === 'inform' ? `- [Jarvis inferred this, not confirmed] ${f.text}` : `- ${f.text}`);
const selection = factRetrieval.selectForPrompt(allFacts, {
    budgetTokens: FACT_BUDGET_TOKENS,
    relevanceByText: factRelevance,
});
const pinnedFacts = selection.pinned;
const recentUnpinned = selection.unpinned;
// A PINNED fact that did not fit is a standing rule Apsara explicitly marked
// "always apply" that is NOT being applied right now. Silently dropping it is
// the same silent-degradation shape as the semantic search returning [] on
// failure — say so, in the prompt, so the model can hedge rather than answer
// confidently from a partial rulebook.
// Now that the selection exists, drop any semantic hit already carried in
// the prompt — otherwise the same fact appears twice, once plainly and once
// dressed up as a memory recall, which reads as two independent sources
// agreeing when it is one fact repeated.
{
    const alreadyShown = new Set([...pinnedFacts, ...recentUnpinned].map(f => f.text));
    semanticFactMatches = semanticFactCandidates.filter(m => !alreadyShown.has(m.text)).slice(0, 5);
}
const truncationNote = selection.truncated > 0
    ? `\n- [NOTE: ${selection.truncated} further pinned instruction(s) did not fit this prompt's memory budget. If the answer might depend on a standing rule you cannot see here, say so rather than guessing.]`
    : '';

const facts = [
    ...pinnedFacts.map(f => f.authority === 'inform'
        ? `- [PINNED — Jarvis inferred this, not confirmed] ${f.text}`
        : `- [PINNED — always apply] ${f.text}`),
    ...recentUnpinned.map(factLine),
    ...semanticFactMatches.map(m => `- [recalled from memory, ${Math.round(m.similarity * 100)}% relevant] ${m.text}`),
].join('\n') + truncationNote || '(none)';

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
    semanticMemory,
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