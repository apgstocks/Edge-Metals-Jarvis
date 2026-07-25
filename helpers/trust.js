// ── helpers/trust.js — Graduated trust ledger ────────────────────────────────
// Tracks, per specific recurring pattern (a trucker name for forward, a
// supplier name for assign), how many times in a row the manager has
// approved that exact pattern without correction. Once a pattern crosses the
// threshold AND bot_mode is 'trusted' or 'autonomous', that specific pattern
// can skip the blocking yes/no confirmation — everything else still confirms
// normally. Deliberately narrow: trust is earned per-pattern, never as a
// blanket "the AI is more trusted now" statement.
//
// Scope, by explicit decision: forward + assign only. Archive/recall are
// harder to reverse and are NEVER eligible for reduced confirmation.

const { loadJson, mutateJson } = require('./json');
const cfg = require('../config');

const TRUST_THRESHOLD = 20; // consecutive correct approvals required

function ledgerKey(actionType, targetName) {
    return `${actionType}_${String(targetName || '').toLowerCase().trim()}`;
}

function loadLedger() {
    return loadJson(cfg.TRUST_LEDGER_FILE, {});
}

// Call when the manager approves a confirm_forward/confirm_assign as-is (said
// "yes", no correction). Increments the streak for that specific pattern.
async function recordApproval(actionType, targetName) {
    const key = ledgerKey(actionType, targetName);
    await mutateJson(cfg.TRUST_LEDGER_FILE, {}, (ledger) => {
        const entry = ledger[key] || { consecutive_correct: 0, total_approved: 0, total_rejected: 0 };
        entry.consecutive_correct += 1;
        entry.total_approved += 1;
        entry.last_outcome_at = new Date().toISOString();
        ledger[key] = entry;
        return ledger;
    });
}

// Call when the manager rejects a confirm_forward/confirm_assign ("no"). Any
// rejection resets the streak to zero — one mistake means the pattern hasn't
// actually earned trust yet, same as how a trainee's error resets probation.
async function recordRejection(actionType, targetName) {
    const key = ledgerKey(actionType, targetName);
    await mutateJson(cfg.TRUST_LEDGER_FILE, {}, (ledger) => {
        const entry = ledger[key] || { consecutive_correct: 0, total_approved: 0, total_rejected: 0 };
        entry.consecutive_correct = 0;
        entry.total_rejected += 1;
        entry.last_outcome_at = new Date().toISOString();
        ledger[key] = entry;
        return ledger;
    });
}

// Is this specific pattern eligible for reduced confirmation right now?
// Requires BOTH: bot_mode set to trusted/autonomous (manager's conscious
// choice to allow this behavior at all) AND this pattern's own track record
// crossing the threshold. A perfect streak means nothing if bot_mode is still
// 'handholding' — the manager has to deliberately turn this on.
function isTrusted(actionType, targetName) {
    const settings = cfg.getSettings ? cfg.getSettings() : {};
    if (settings.bot_mode !== 'trusted' && settings.bot_mode !== 'autonomous') return false;
    const ledger = loadLedger();
    const entry = ledger[ledgerKey(actionType, targetName)];
    return !!entry && entry.consecutive_correct >= TRUST_THRESHOLD;
}

function getStreak(actionType, targetName) {
    const ledger = loadLedger();
    return ledger[ledgerKey(actionType, targetName)]?.consecutive_correct || 0;
}

module.exports = { recordApproval, recordRejection, isTrusted, getStreak, loadLedger, TRUST_THRESHOLD };