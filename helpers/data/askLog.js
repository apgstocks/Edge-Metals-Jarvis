// ── helpers/data/askLog.js — what she asked, and whether it worked ─────────
//
// The recommendation from the AI-first review (2026-08-22, item 3) that was
// never built: "log every refusal with its text — it turns invisible
// capability gaps into a reviewable list, instead of discovering them live."
//
// Now there is something worth logging. A question answered from the ledgers
// either worked or did not, and the ones that did not are the entire tuning
// list: add the question to EXAMPLES in helpers/data/askData.js and a whole
// family of phrasings starts working. Without this file those failures happen
// once, in a conversation, and are gone.
//
// ── IT IS A LOG, NOT A TRANSCRIPT ───────────────────────────────────────────
// The question, the query, the outcome and the timing. NOT the answer text
// and NOT the rows: a copy of every figure Jarvis has ever read out, sitting
// in a file forever, is a liability that buys nothing — the rows are still in
// the ledgers, and the query says how to get them back.
const cfg = require('../../config');
const { loadJson, mutateJson } = require('../json');

const KEEP = 2000;

function list() {
    const raw = loadJson(cfg.ASK_LOG_FILE, []);
    return Array.isArray(raw) ? raw : [];
}

// Never throws and never blocks the answer: a log that can break the feature
// it is logging is worse than no log.
async function record(entry) {
    try {
        const row = {
            at: new Date().toISOString(),
            kind: entry.kind === 'text' ? 'text' : 'data',
            source: entry.source || null,
            question: String(entry.question || '').slice(0, 400),
            outcome: entry.outcome || 'unknown',
            tables: Array.isArray(entry.tables) ? entry.tables : [],
            sql: entry.sql ? String(entry.sql).slice(0, 1000) : null,
            rows: Number.isFinite(entry.rows) ? entry.rows : null,
            repaired: !!entry.repaired,
            calls: Number.isFinite(entry.calls) ? entry.calls : (entry.repaired ? 2 : 1),
            ms: Number.isFinite(entry.ms) ? entry.ms : null,
            error: entry.error ? String(entry.error).slice(0, 300) : null,
        };
        await mutateJson(cfg.ASK_LOG_FILE, [], (all) => {
            const rows = Array.isArray(all) ? all : [];
            rows.push(row);
            // Capped, because this file is written on every question and
            // nobody will ever prune it by hand.
            return rows.length > KEEP ? rows.slice(rows.length - KEEP) : rows;
        });
        return row;
    } catch (e) {
        console.warn('[ASKLOG] could not record a question (non-fatal):', e.message);
        return null;
    }
}

const OUTCOMES = ['answered', 'nothing_matched', 'could_not_answer', 'yard', 'unclear', 'failed'];

// What to read after a week of use. `since` is an ISO date string.
function summary({ since = null } = {}) {
    const rows = list().filter((r) => r && (!since || String(r.at) >= since));
    const by = {};
    for (const o of OUTCOMES) by[o] = 0;
    let calls = 0, repaired = 0, msTotal = 0, timed = 0;
    const failing = new Map();
    const tables = new Map();
    for (const r of rows) {
        by[r.outcome] = (by[r.outcome] || 0) + 1;
        calls += r.calls || 0;
        if (r.repaired) repaired += 1;
        if (Number.isFinite(r.ms)) { msTotal += r.ms; timed += 1; }
        if (r.outcome !== 'answered' && r.outcome !== 'yard') {
            const k = r.question.toLowerCase();
            failing.set(k, (failing.get(k) || 0) + 1);
        }
        for (const t of r.tables || []) tables.set(t, (tables.get(t) || 0) + 1);
    }
    const sortDesc = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ what: k, times: n }));
    return {
        questions: rows.length,
        by,
        model_calls: calls,
        repaired,
        avg_ms: timed ? Math.round(msTotal / timed) : null,
        // The list that is the whole point of the file.
        needs_work: sortDesc(failing).slice(0, 25),
        tables_used: sortDesc(tables).slice(0, 15),
        first_at: rows.length ? rows[0].at : null,
        last_at: rows.length ? rows[rows.length - 1].at : null,
    };
}

function recent(n = 50) { return list().slice(-Math.max(1, n)).reverse(); }

module.exports = { record, list, recent, summary, OUTCOMES, KEEP };
