// ── helpers/aiUsage.js — what the AI is being asked, and what it costs ──────
// Apsara, 2026-10-12: "observability should be there ... what actions does that
// agent perform, constantly monitoring cost so that I can keep track of it."
//
// MEASURED FIRST: nothing in the repo recorded a token count or a spend. The
// agents run unattended every night, so a bug that loops or re-reads a large
// PDF would only show up on Google's bill.
//
// ── ONE POINT OF CAPTURE ──────────────────────────────────────────────────
// Every call site in helpers/gemini.js (and claimScan.js, packingList.js)
// gets its model from gemini.getClient().getGenerativeModel(...). So the
// client is wrapped ONCE (instrumentClient) and every generateContent result
// is recorded from its own usageMetadata. 17 call sites are not edited.
//
// ── IT MUST NEVER BE THE REASON A CALL FAILS ──────────────────────────────
// Same rule as helpers/heartbeat.js. Every recording step is inside try/catch,
// the model's answer is returned untouched, and a failed call is re-thrown
// exactly as it was. The only behaviour added to a call is one appended line.
//
// ── WHAT IS RECORDED, AND WHAT IS NOT ─────────────────────────────────────
// Tokens in/out/thinking, model, which job or function asked, how long it
// took, whether it failed. NOT the prompt or the answer: prompts here carry
// customer names, prices and PDFs, and a usage log is no place for them.
//
// ── COST IS COMPUTED WHEN READ, NOT WHEN WRITTEN ──────────────────────────
// The log keeps tokens only. Price is applied at read time from the table
// below (plus data/ai-prices.json), so correcting a price re-prices history
// instead of leaving old lines wrong.
//
// ── THE PRICES ARE ESTIMATES, AND SAY SO ──────────────────────────────────
// Looked up 2026-10-12. Two public price pages DISAGREED on gemini-3.6-flash
// ($0.75/$3.75 vs $1.50/$7.50 per 1M tokens) and neither listed
// gemini-3.8-flash. Rather than pick one quietly, the HIGHER figure is used
// (a budget alert should err towards early) and every figure here carries
// est: true. Put the real rates from the Google Cloud billing page into
// data/ai-prices.json and they replace these, est: false. Google also notes
// 3.6-flash pricing doubles on 2027-01-01. Thinking tokens are billed as
// output here; that is the conservative reading, not a confirmed one.
//
// DAYS ARE PACIFIC TIME, because that is the zone scheduler.js runs in and the
// one Google bills by.

const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const cfg = require('../config');

const als = new AsyncLocalStorage();
const TZ = 'America/Los_Angeles';

const FILE = () => process.env.AI_USAGE_FILE || path.join(cfg.DATA_DIR, 'ai-usage.jsonl');
const PRICES_FILE = () => process.env.AI_PRICES_FILE || path.join(cfg.DATA_DIR, 'ai-prices.json');

// USD per 1,000,000 tokens.
const DEFAULT_PRICES = {
    'gemini-2.5-flash-lite': { in: 0.10, out: 0.40, est: true },
    'gemini-2.5-flash':      { in: 0.30, out: 2.50, est: true },
    'gemini-3.5-flash-lite': { in: 0.30, out: 2.50, est: true },
    'gemini-3.6-flash':      { in: 1.50, out: 7.50, est: true },   // higher of two disagreeing sources
    'gemini-3.8-flash':      { in: 1.50, out: 7.50, est: true },   // not listed anywhere: assumed = 3.6-flash
};

// ── RECORDING ──────────────────────────────────────────────────────────────
// Under JARVIS_TEST nothing is written unless AI_USAGE_IN_TEST=1: most test
// files run against the REAL data directory, and a test must not add lines to
// the live usage log.
function enabled() {
    return !(process.env.JARVIS_TEST && process.env.AI_USAGE_IN_TEST !== '1');
}

function pacificDay(ms = Date.now()) {
    return new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ });
}

// Which part of Jarvis asked: the scheduled job if there is one, otherwise the
// gemini.js function on the stack ("interactive" when neither).
function callerLabel() {
    const job = (als.getStore() || {}).job || null;
    let fn = null;
    try {
        const frames = String(new Error().stack || '').split('\n').slice(2);
        for (const f of frames) {
            if (/aiUsage\.js/.test(f)) continue;
            const m = /at (?:async )?([A-Za-z0-9_$.]+) \(.*[\\/](?:gemini|claimScan|packingList|voice)\.js/.exec(f);
            if (m) { fn = m[1].split('.').pop(); break; }
        }
    } catch (e) { /* a label is a nicety */ }
    return { job, fn };
}

function appendLine(obj) {
    const f = FILE();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify(obj) + '\n');
}

// `usage` is Gemini's usageMetadata (SDK or REST shape).
function record({ model, usage, ms = null, ok = true, error = null, label = null }) {
    try {
        if (!enabled()) return null;
        const u = usage || {};
        const who = callerLabel();
        const line = {
            t: new Date().toISOString(), day: pacificDay(), model: String(model || 'unknown').replace(/^models\//, ''),
            job: who.job, fn: label || who.fn,
            inTok: Number(u.promptTokenCount) || 0,
            outTok: Number(u.candidatesTokenCount) || 0,
            thinkTok: Number(u.thoughtsTokenCount) || 0,
            cachedTok: Number(u.cachedContentTokenCount) || 0,
            ms, ok: !!ok,
        };
        if (error) line.err = String(error).slice(0, 160);
        appendLine(line);
        return line;
    } catch (e) { return null; }       // never the reason a call fails
}

// Run `fn` with a job name attached, so every AI call inside it is attributed.
// Used by helpers/heartbeat.js. Any failure to set the context just runs fn.
function runAs(job, fn) {
    try { return als.run({ job }, fn); } catch (e) { return fn(); }
}

// ── WRAPPING THE CLIENT ────────────────────────────────────────────────────
function wrapModel(model, modelName) {
    return new Proxy(model, {
        get(target, prop) {
            const v = Reflect.get(target, prop);
            if (prop !== 'generateContent' || typeof v !== 'function') return typeof v === 'function' ? v.bind(target) : v;
            return async (...args) => {
                const t0 = Date.now();
                let result;
                try { result = await v.apply(target, args); }
                catch (err) { record({ model: modelName, ms: Date.now() - t0, ok: false, error: err && err.message }); throw err; }
                try { record({ model: modelName, usage: result && result.response && result.response.usageMetadata, ms: Date.now() - t0 }); }
                catch (e) { /* see header */ }
                return result;
            };
        },
    });
}
function instrumentClient(client) {
    if (!client || client.__aiUsage) return client;
    return new Proxy(client, {
        get(target, prop) {
            if (prop === '__aiUsage') return true;
            const v = Reflect.get(target, prop);
            if (prop === 'getGenerativeModel' && typeof v === 'function') {
                return (...args) => {
                    const m = v.apply(target, args);
                    const name = (args[0] && args[0].model) || 'unknown';
                    return wrapModel(m, name);
                };
            }
            return typeof v === 'function' ? v.bind(target) : v;
        },
    });
}

// ── READING ────────────────────────────────────────────────────────────────
function readAll() {
    let raw = '';
    try { raw = fs.readFileSync(FILE(), 'utf8'); } catch (e) { return []; }
    const out = [];
    for (const l of raw.split('\n')) {
        if (!l.trim()) continue;
        try { out.push(JSON.parse(l)); } catch (e) { /* a torn last line is skipped */ }
    }
    return out;
}

function prices() {
    let over = {};
    try { over = JSON.parse(fs.readFileSync(PRICES_FILE(), 'utf8')) || {}; } catch (e) { /* none set */ }
    const merged = { ...DEFAULT_PRICES };
    for (const [k, v] of Object.entries(over)) {
        if (v && Number.isFinite(Number(v.in)) && Number.isFinite(Number(v.out))) merged[k] = { in: Number(v.in), out: Number(v.out), est: v.est === true };
    }
    return merged;
}

// cost of one line: { usd, est, known }
function costOf(line, table = prices()) {
    const p = table[line.model];
    if (!p) return { usd: 0, est: true, known: false };
    const usd = ((line.inTok || 0) * p.in + ((line.outTok || 0) + (line.thinkTok || 0)) * p.out) / 1e6;
    return { usd, est: p.est !== false, known: true };
}

const r4 = (n) => Math.round(n * 10000) / 10000;

// Totals by day, model and caller for the last `days` Pacific days.
function summarise({ days = 30, now = Date.now(), lines = null } = {}) {
    const table = prices();
    const all = lines || readAll();
    const cutoff = pacificDay(now - (days - 1) * 86400000);
    const rows = all.filter((l) => l.day >= cutoff);
    const out = { days, since: cutoff, today: pacificDay(now), total: blank(), byDay: {}, byModel: {}, byCaller: {}, unpriced: new Set(), calls: rows.length };
    for (const l of rows) {
        const c = costOf(l, table);
        if (!c.known) out.unpriced.add(l.model);
        const callerKey = l.job || (l.fn ? `app: ${l.fn}` : 'app: interactive');
        for (const [bucket, key] of [[out.byDay, l.day], [out.byModel, l.model], [out.byCaller, callerKey]]) {
            const b = bucket[key] || (bucket[key] = blank());
            add(b, l, c);
        }
        add(out.total, l, c);
    }
    out.unpriced = [...out.unpriced];
    out.estimated = Object.keys(out.byModel).some((m) => (table[m] || { est: true }).est !== false);
    for (const b of [out.total, ...Object.values(out.byDay), ...Object.values(out.byModel), ...Object.values(out.byCaller)]) b.usd = r4(b.usd);
    out.todayUsd = (out.byDay[out.today] || blank()).usd;
    return out;
}
function blank() { return { calls: 0, failed: 0, inTok: 0, outTok: 0, thinkTok: 0, usd: 0 }; }
function add(b, l, c) {
    b.calls++; if (!l.ok) b.failed++;
    b.inTok += l.inTok || 0; b.outTok += l.outTok || 0; b.thinkTok += l.thinkTok || 0; b.usd += c.usd;
}

module.exports = { record, runAs, instrumentClient, wrapModel, summarise, costOf, prices, readAll, pacificDay, DEFAULT_PRICES, FILE, enabled };
