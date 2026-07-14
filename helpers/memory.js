// ── helpers/memory.js — Persistent memory, separate from facts.json ──────────
// facts.json         = corrections / standing instructions (accuracy for data answers)
// memory/sessions.json = per-chat conversational state, PERSISTED (not just in-memory)
// memory/business_context.json = durable notes about ongoing situations, not
//                                 tied to a single booking and not corrections
//
// Why this needed to exist: helpers/context.js previously held session state
// in a plain `Map()` with a TTL — commented in its own source as surviving
// "nothing" across a restart. Any mid-conversation context (what a manager was
// just asking about, what a trucker's chat was doing) was lost every deploy,
// every crash, every pm2 restart. This module makes that state outlive the
// process, and adds two things the old Map never had: a rolling summary of
// each conversation, and durable business-context notes.

const { loadJson, mutateJson } = require('./json');
const cfg = require('../config');

const MAX_SUMMARIES_PER_CHAT = 20;   // rolling window — oldest drop off
const MAX_CONTEXT_ENTRIES    = 100;  // same cap style as facts.json

// ── Session state — persisted, replaces the old in-memory-only Map ──────────
// Shape per chatId: { currentTopic, activeBooking, unansweredQuestion,
//                      lastInstruction, menuContext, updated_at }
function loadAllSessions() {
    return loadJson(cfg.MEMORY_SESSIONS_FILE, {});
}

function getSessionMemory(chatId) {
    const all = loadAllSessions();
    return all[chatId] || null;
}

async function saveSessionMemory(chatId, session) {
    await mutateJson(cfg.MEMORY_SESSIONS_FILE, {}, (all) => {
        all[chatId] = { ...session, updated_at: new Date().toISOString() };
        return all;
    });
}

async function clearSessionMemory(chatId) {
    // Clears only the LIVE working state, not summaryHistory — a session
    // closing shouldn't erase what was archived from it.
    await mutateJson(cfg.MEMORY_SESSIONS_FILE, {}, (all) => {
        if (all[chatId]) {
            const { summaryHistory } = all[chatId];
            all[chatId] = summaryHistory ? { summaryHistory } : undefined;
            if (!all[chatId]) delete all[chatId];
        }
        return all;
    });
}

// ── Conversation summaries — "what happened in this session" ────────────────
// Deliberately template-built, not Gemini-generated: this fires on every
// session close (idle timeout), and paying for an LLM call on every single
// idle conversation across every chat would be real, recurring cost for
// something a plain string covers just as usefully. If richer prose summaries
// are wanted later, this is the one function to swap — nothing else changes.
function buildSessionSummaryText(session) {
    const parts = [];
    if (session.activeBooking)      parts.push(`booking ${session.activeBooking}`);
    if (session.currentTopic)       parts.push(`topic: ${session.currentTopic}`);
    if (session.lastInstruction)    parts.push(`last action: ${session.lastInstruction}`);
    if (session.unansweredQuestion) parts.push(`left open: ${session.unansweredQuestion}`);
    return parts.length ? parts.join(' | ') : null;
}

async function archiveSessionSummary(chatId, session) {
    const text = buildSessionSummaryText(session);
    if (!text) return; // nothing worth remembering from an empty/idle session
    await mutateJson(cfg.MEMORY_SESSIONS_FILE, {}, (all) => {
        const entry = all[chatId] || {};
        const history = Array.isArray(entry.summaryHistory) ? entry.summaryHistory : [];
        history.push({ text, closed_at: new Date().toISOString() });
        while (history.length > MAX_SUMMARIES_PER_CHAT) history.shift();
        all[chatId] = { ...entry, summaryHistory: history };
        return all;
    });
}

function getRecentSummaries(chatId, n = 3) {
    const entry = getSessionMemory(chatId);
    const history = entry?.summaryHistory || [];
    return history.slice(-n);
}

// ── Business context — durable, ongoing-situation notes ─────────────────────
// Separate list from facts.json on purpose: facts are corrections ("DALA
// numbers can have a dash"); business context is standing situational
// awareness ("onboarding a new supplier in Houston this month") that isn't
// correcting anything, just background the AI should carry forward.
function loadBusinessContext() {
    return loadJson(cfg.MEMORY_CONTEXT_FILE, []);
}

async function addBusinessContext(text) {
    const clean = String(text || '').trim();
    if (!clean) return;
    await mutateJson(cfg.MEMORY_CONTEXT_FILE, [], (list) => {
        list.push({ text: clean, created_at: new Date().toISOString() });
        while (list.length > MAX_CONTEXT_ENTRIES) list.shift();
        return list;
    });
}

module.exports = {
    getSessionMemory, saveSessionMemory, clearSessionMemory,
    archiveSessionSummary, getRecentSummaries,
    loadBusinessContext, addBusinessContext,
};