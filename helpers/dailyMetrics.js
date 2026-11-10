// ── helpers/dailyMetrics.js — one line a day: is Jarvis getting better, or just busier? ─────────────────────────
// Apsara, 2026-11-10: "daily metric". The CALL log and cost already exist (helpers/aiUsage.js, data/ai-usage.jsonl); this adds the part
// that was missing: QUALITY, measured against what SHE decided, not against a second model's opinion.
//   learner   agreement with her (cumulative), abstain rate           <- the learner service's own /report
//   deposits  questions asked / answered yes / no / waiting; auto-placed and how many she undid (the undo rate is the trust signal)
//   prices    questions asked / normal / check / waiting
//   ai        yesterday's model calls, failures, estimated cost       <- aiUsage.summarise
// READ-ONLY over every store; its own output is data/metrics.jsonl, one line per Pacific day, append-only, never rewritten.
// Nothing here decides anything, and a failure here must never reach a caller (record() returns {ok:false}, never throws).
const fs = require('fs'), path = require('path');
const FILE = () => process.env.JARVIS_METRICS_FILE || path.join(require('../config').DATA_DIR, 'metrics.jsonl');
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
const safe = (fn, dflt) => { try { return fn(); } catch (_) { return dflt; } };

function deposits() {
    const st = safe(() => require('./depositAutoApply').list(), null) || {};
    const asks = Array.isArray(st.asks) ? st.asks : [], entries = Array.isArray(st.entries) ? st.entries : [];
    const yes = asks.filter((q) => q.answer && q.answer.kind === 'yes').length, no = asks.filter((q) => q.answer && q.answer.kind === 'no').length;
    const auto = entries.filter((e) => e.placedBy !== 'her'), undone = auto.filter((e) => e.undone).length;
    return { asked: asks.length, yes, no, waiting: asks.length - yes - no, auto_placed: auto.length, undone, undo_pct: pct(undone, auto.length) };
}
function prices() {
    const st = safe(() => require('./priceWatch').list(), null) || {};
    const asks = Array.isArray(st.asks) ? st.asks : [];
    const normal = asks.filter((q) => q.answer && q.answer.kind === 'normal').length, check = asks.filter((q) => q.answer && q.answer.kind === 'check').length;
    return { asked: asks.length, normal, check, waiting: asks.length - normal - check, check_pct: pct(check, normal + check) };
}
function ai(now) {
    const u = require('./aiUsage'); const day = u.pacificDay(now - 86400000);
    const b = (safe(() => u.summarise({ days: 3, now }), { byDay: {} }).byDay || {})[day] || { calls: 0, failed: 0, usd: 0 };
    return { day, calls: b.calls, failed: b.failed, fail_pct: pct(b.failed, b.calls), usd_est: b.usd };
}
function learnerPart(r) {
    if (!r) return null;                       // learner off or unreachable: say nothing rather than 0
    const judged = Number(r.judged) || 0, abstained = Number(r.abstained) || 0;
    return { judged, abstained, abstain_pct: pct(abstained, judged), compared: Number(r.compared) || 0, agree: Number(r.agree) || 0,
        agreement_pct: r.agreement == null ? null : Math.round(Number(r.agreement) * 1000) / 10 };
}

/** The numbers as of `now`. `learnerReport` may be passed (tests); otherwise the learner service is asked (null when it is off). */
async function snapshot({ now = Date.now(), learnerReport } = {}) {
    const rep = learnerReport !== undefined ? learnerReport : await require('./learnerClient').report();
    return { day: require('./aiUsage').pacificDay(now), at: new Date(now).toISOString(),
        learner: learnerPart(rep), deposits: deposits(), prices: prices(), ai: ai(now) };
}

function readAll() {
    let raw = ''; try { raw = fs.readFileSync(FILE(), 'utf8'); } catch (_) { return []; }
    return raw.split('\n').filter(Boolean).map((l) => safe(() => JSON.parse(l), null)).filter(Boolean);
}
/** One line per day. A second call the same day does nothing (the line is the day's record, not a running figure). */
async function record(opts = {}) {
    try {
        const s = await snapshot(opts);
        if (readAll().some((l) => l.day === s.day)) return { ok: true, skipped: 'already recorded for ' + s.day, snapshot: s };
        fs.mkdirSync(path.dirname(FILE()), { recursive: true });
        fs.appendFileSync(FILE(), JSON.stringify(s) + '\n');
        return { ok: true, snapshot: s };
    } catch (e) { return { ok: false, error: e.message }; }
}
/** The last `days` lines, oldest first, each with the change in agreement since the line before it. */
function trend({ days = 30 } = {}) {
    const rows = readAll().slice(-Math.max(1, Math.min(365, Number(days) || 30)));
    return rows.map((r, i) => {
        const a = r.learner && r.learner.agreement_pct, p = i > 0 && rows[i - 1].learner ? rows[i - 1].learner.agreement_pct : null;
        return { ...r, agreement_change: a != null && p != null ? Math.round((a - p) * 10) / 10 : null };
    });
}
const f = (v, s = '') => (v == null ? 'n/a' : v + s);
function text(s) {
    const L = [`Jarvis metrics, ${s.day}`];
    L.push(s.learner ? `Learner: agrees with you ${f(s.learner.agreement_pct, '%')} (${s.learner.agree}/${s.learner.compared} compared), abstains ${f(s.learner.abstain_pct, '%')} of ${s.learner.judged}`
        : 'Learner: off or not reachable');
    L.push(`Deposits: ${s.deposits.asked} asked (${s.deposits.yes} yes, ${s.deposits.no} no, ${s.deposits.waiting} waiting); auto-placed ${s.deposits.auto_placed}, undone ${s.deposits.undone} (${f(s.deposits.undo_pct, '%')})`);
    L.push(`Prices: ${s.prices.asked} asked (${s.prices.normal} normal, ${s.prices.check} check, ${s.prices.waiting} waiting)`);
    L.push(`Model calls ${s.ai.day}: ${s.ai.calls}, failed ${s.ai.failed} (${f(s.ai.fail_pct, '%')}), about $${s.ai.usd_est}`);
    return L.join('\n');
}
module.exports = { snapshot, record, trend, text, readAll, FILE };
