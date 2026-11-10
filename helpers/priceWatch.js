// ── helpers/priceWatch.js — look at each NEW price, ask her about the unusual ones, learn from her answer ──────
// Apsara, 2026-11-10: "every pattern in price needs to be learned ... it's an AI."
//
// Each day: every price that has appeared since the last run goes to the learner (helpers/learnerClient.js, kind "price-check") with its
// exact facts (helpers/priceHistory.js). Then it ASKS HER about a few, one WhatsApp line each, and her "normal CODE" / "check CODE" reply
// becomes the labelled example the learner learns from. It changes no price, no invoice and no bill. It only asks and learns.
//
// WHO DECIDES WHAT TO ASK (be honest about the one fixed number): once the learner has enough of her answers, ITS prediction decides — a
// confident "normal" is not asked about, a confident "check" is. Before that, to get her first answers, it asks about the most unusual
// prices, and "unusual" needs a cut: ASK_MIN_PCT (default 5% off the party's own typical). That cut only chooses what to ASK; it never
// decides whether a price is wrong. At most MAX_ASKS (3) questions a day, each price asked once.
//
// OFF unless JARVIS_PRICE_WATCH=1. Edge Metals only (the ledgers it reads are Edge Metals', rule 5).
const path = require('path');
const ph = require('./priceHistory');
const learner = require('./learnerClient');

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const on = () => process.env.JARVIS_PRICE_WATCH === '1';
const MAX_ASKS = () => num(process.env.JARVIS_PRICE_WATCH_MAX_ASKS, 3);
const ASK_MIN_PCT = () => num(process.env.JARVIS_PRICE_WATCH_MIN_PCT, 5);
const MAX_AGE_DAYS = () => num(process.env.JARVIS_PRICE_WATCH_MAX_AGE_DAYS, 21);
const MAX_JUDGE = 25;
const CONFIDENT = 0.8;

const file = () => process.env.JARVIS_PRICE_WATCH_FILE || path.join(require('../config').DATA_DIR, 'price_watch.json');
const EMPTY = () => ({ seen: {}, asks: [] });
const norm = (d) => ({ seen: d && d.seen && typeof d.seen === 'object' ? d.seen : {}, asks: Array.isArray(d && d.asks) ? d.asks : [] });
const read = () => norm(require('./json').loadJson(file(), EMPTY()));
const mutate = (fn) => require('./json').mutateJson(file(), EMPTY(), (d) => { const x = norm(d); d.seen = x.seen; d.asks = x.asks; return fn(d) || d; }, { strict: true });

const codeFor = (id, taken) => {
    const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let salt = 0; salt < 50; salt++) {
        let h = 0; for (const c of String(id) + (salt ? '#' + salt : '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
        let s = ''; for (let i = 0; i < 4; i++) { s += a[h % a.length]; h = Math.floor(h / a.length) + 7; }
        if (!taken.has(s)) return s;
    }
    return null;
};
const money4 = (n) => '$' + Number(n).toFixed(n < 1 ? 3 : 2);
const sentence = (c) => {
    const who = c.side === 'bill' ? `you bought from ${c.party}` : `${c.party} was invoiced`;
    const gap = c.pct_off_typical === null ? 'not enough earlier prices to say what is usual' : `their usual is about ${money4(c.typical_for_this_party)}/lb (${c.pct_off_typical > 0 ? '+' : ''}${c.pct_off_typical}%)`;
    return `${who} ${c.item === '(not stated)' ? '' : c.item + ' '}at ${money4(c.price_per_lb)}/lb on ${c.date}; ${gap}.` + (c.last_three_for_this_party ? ` Before that: ${c.last_three_for_this_party}.` : '');
};

/** Judge the new prices (shadow), choose a few to ask about, save the questions. Pure over src/now except the learner call and the store. */
async function run({ now = Date.now(), src, dryRun = false } = {}) {
    const out = { judged: 0, asked: [], skipped: 0, off: false };
    if (!dryRun && !on()) return { ...out, off: true };
    const obs = ph.observations(src ? { src } : undefined);
    const st = read();
    const cutoff = new Date(now - MAX_AGE_DAYS() * 86400000).toISOString().slice(0, 10);
    const fresh = obs.filter((o) => !st.seen[o.ref] && o.date >= cutoff);
    const cands = [];
    for (const o of fresh) {
        const c = ph.caseFor(o, obs);
        let p = null;
        if (out.judged < MAX_JUDGE) { p = await learner.judge('price-check', c, 'price:' + o.ref); out.judged++; }
        cands.push({ o, c, p });
    }
    // what to ask: the learner decides when it is confident; otherwise the most unusual, with enough history to call anything unusual
    const worth = cands.filter(({ c, p }) => {
        if (p && !p.abstained && p.confidence >= CONFIDENT) return p.decision === 'check';
        return c.pct_off_typical !== null && Math.abs(c.pct_off_typical) >= ASK_MIN_PCT();
    }).sort((a, b) => Math.abs(b.c.pct_off_typical || 0) - Math.abs(a.c.pct_off_typical || 0));
    const taken = new Set(st.asks.map((q) => q.code));
    for (const w of worth) {
        if (out.asked.length >= MAX_ASKS()) { out.skipped++; continue; }
        if (st.asks.some((q) => q.ref === w.o.ref)) continue;
        const id = 'pq_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
        const code = codeFor(id, taken); if (!code) continue; taken.add(code);
        out.asked.push({ id, code, ref: w.o.ref, case: w.c, text: sentence(w.c), predicted: w.p && !w.p.abstained ? { decision: w.p.decision, confidence: w.p.confidence } : null,
            askedAt: new Date(now).toISOString(), reported: false, answer: null });
    }
    if (!dryRun) await mutate((d) => { for (const { o } of cands) d.seen[o.ref] = new Date(now).toISOString(); for (const q of out.asked) d.asks.push(q); });
    return out;
}

/** Her "normal CODE" / "check CODE". Becomes a labelled example and the measured outcome for what the learner predicted. */
async function answer(code, label, { by = 'her', now = Date.now() } = {}) {
    if (!['normal', 'check'].includes(label)) return { ok: false, error: 'say normal or check' };
    const st = read(); const q = st.asks.find((x) => String(x.code).toUpperCase() === String(code).toUpperCase());
    if (!q) return { ok: false, error: 'no such price question' };
    if (q.answer) return { ok: false, error: `you already answered that one (${q.answer.kind})` };
    await mutate((d) => { const x = d.asks.find((y) => y.id === q.id); if (x) x.answer = { kind: label, at: new Date(now).toISOString(), by }; });
    try { learner.example('price-check', q.case, label, { ref: 'price:' + q.ref, by }); learner.actual('price:' + q.ref, label); } catch (_) { /* shadow */ }
    return { ok: true, ask: q };
}

function dailyText() {
    const q = read().asks.filter((x) => !x.reported && !x.answer);
    if (!q.length) return null;
    const L = [`Price check — ${q.length} price${q.length === 1 ? '' : 's'} I would like your eye on:`];
    for (const x of q) L.push(`• ${x.text}`, `  Reply "normal ${x.code}" if that is usual, or "check ${x.code}" if it looks wrong.`);
    L.push('', 'Each answer teaches me what is normal for them. I change nothing.');
    return L.join('\n');
}
async function markReported() { await mutate((d) => { for (const x of d.asks) if (!x.answer) x.reported = true; }); }

async function runDaily({ sendToManager, now = Date.now() } = {}) {
    if (!on()) return { off: true };
    const r = await run({ now });
    const text = dailyText();
    if (text && typeof sendToManager === 'function') { await sendToManager(text); await markReported(); }
    return { ...r, sent: !!text };
}
const list = () => read();

module.exports = { run, answer, dailyText, markReported, runDaily, list, on, MAX_ASKS, ASK_MIN_PCT };
