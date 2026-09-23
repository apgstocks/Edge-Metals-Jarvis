// ── helpers/data/textIndex.js — everything Jarvis has in WORDS ─────────────
//
// Phase 2 of "give all data access to Jarvis" (2026-09-23). The ledgers
// answer how much; this answers what was said: "what did Zimex say about the
// HBL", "which invoice had 7.095 MT on it", "what did we promise Joey".
//
// ── WHAT IS INDEXED, AND WHAT IS DELIBERATELY NOT ───────────────────────────
// Only what is already on this server: the mail Jarvis has assessed (sender,
// subject, its summary, what was asked for, the figures it pulled out), the
// emails Jarvis itself sent, the invoices it printed, the documents on disk,
// the quote replies truckers sent back, and the facts she has taught it.
//
// It does NOT mirror her mailbox. Gmail holds years of mail, most of it
// nothing to do with this business, and copying it onto this VM would be a
// second place her customers' mail lives — a real liability for a search box.
// So the index holds the ASSESSMENTS, which are small and already here, and
// helpers/data/askText.js fetches the full body of the handful of emails a
// question actually lands on, live, at the moment it is asked.
const cfg = require('../../config');
const fs = require('fs');
const { loadJson } = require('../json');

const clean = (v) => String(v === null || v === undefined ? '' : v).replace(/\s+/g, ' ').trim();
const day = (v) => {
    const s = clean(v);
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    return m ? m[0] : (require('../bills').sortableDate(s) || '');
};

function signature() {
    const files = [cfg.REPLY_WATCH_FILE, cfg.EMAIL_THREADS_FILE, cfg.FACTS_FILE,
        cfg.INVOICE_VERSIONS_FILE, cfg.QUOTE_REQUESTS_FILE, cfg.MEMORY_CONTEXT_FILE];
    return files.map((f) => {
        try { const s = fs.statSync(f); return `${s.mtimeMs}:${s.size}`; } catch (e) { return '0'; }
    }).join('|');
}

// One indexed passage. `ref` is how the answer cites it and how askText finds
// the real thing again — an email id, an invoice number, a fact id.
const row = (kind, ref, title, who, when_at, body) => ({ kind, ref, title, who, when_at, body: clean(body) });

function mailRows() {
    const store = loadJson(cfg.REPLY_WATCH_FILE, {}) || {};
    const seen = new Set();
    const out = [];
    for (const item of [...(store.tracked || []), ...(store.lastDigest || [])]) {
        if (!item || seen.has(item.id || item.threadId)) continue;
        seen.add(item.id || item.threadId);
        const figures = Array.isArray(item.key_figures) ? item.key_figures.join('; ') : '';
        out.push(row('email', item.id || item.threadId || '', item.subject || '(no subject)',
            item.fromName || item.from || '', day(item.receivedAt || item.firstFlaggedAt),
            [item.subject, item.summary, item.asked_for, item.action_needed, figures,
                item.importance_because, item.fromName, item.from].filter(Boolean).join(' · ')));
    }
    return out;
}

function sentRows() {
    const threads = loadJson(cfg.EMAIL_THREADS_FILE, []) || [];
    return (Array.isArray(threads) ? threads : []).map((t) => row(
        'sent_email', t.threadId || t.id || '', t.subject || '(no subject)',
        t.targetName || t.to || '', day(t.sentAt || t.at),
        [t.subject, t.question, t.askedOf, t.bkgNo, t.to, t.targetName].filter(Boolean).join(' · ')));
}

function invoiceRows() {
    const versions = loadJson(cfg.INVOICE_VERSIONS_FILE, {}) || {};
    const out = [];
    for (const container of Object.keys(versions)) {
        const list = Array.isArray(versions[container]) ? versions[container] : [versions[container]];
        const latest = list[list.length - 1];
        const p = (latest && (latest.payload || latest.body || latest)) || {};
        const lines = (Array.isArray(p.line_items) ? p.line_items : [])
            .map((l) => [l.item_desc || l.description, l.weight && `${l.weight} MT`, l.rate && `$${l.rate}/MT`, l.amount && `$${l.amount}`].filter(Boolean).join(' '))
            .join(' | ');
        out.push(row('invoice', p.inv_no || container, `Invoice ${p.inv_no || ''} — ${container}`.trim(),
            p.consignee || '', day(latest && (latest.at || latest.saved_at)),
            [p.inv_no, container, p.consignee, p.notify, p.vessel, p.port_of_loading, p.port_of_discharge, lines].filter(Boolean).join(' · ')));
    }
    return out;
}

function documentRows() {
    try {
        const ds = require('../documentsSaved');
        const out = [];
        for (const [kind, fn] of [['invoice', 'listSavedInvoices'], ['proforma', 'listSavedProformas'], ['bol', 'listSavedBols']]) {
            for (const d of (typeof ds[fn] === 'function' ? ds[fn]() : []) || []) {
                const name = d.filename || d.name || '';
                out.push(row('document', name, `${kind} — ${name}`, d.container || d.container_no || '', day(d.date),
                    [kind, name, d.container || d.container_no, d.date].filter(Boolean).join(' · ')));
            }
        }
        return out;
    } catch (e) { return []; }
}

function quoteRows() {
    const qs = loadJson(cfg.QUOTE_REQUESTS_FILE, []) || [];
    const out = [];
    for (const q of (Array.isArray(qs) ? qs : [])) {
        for (const leg of (Array.isArray(q.legs) ? q.legs : [])) {
            if (!leg || !leg.last_reply_text) continue;
            out.push(row('quote_reply', `${q.id || ''}:${leg.trucker_name || ''}`,
                `Quote reply — ${leg.trucker_name || 'trucker'}`, leg.trucker_name || '',
                day(leg.last_reply_at || q.created_at),
                [q.origin_name || q.origin, q.destination_name || q.destination, leg.trucker_name, leg.last_reply_text].filter(Boolean).join(' · ')));
        }
    }
    return out;
}

function factRows() {
    const facts = loadJson(cfg.FACTS_FILE, []) || [];
    const list = Array.isArray(facts) ? facts : Object.values(facts || {});
    const out = list.filter(Boolean).map((f) => row('fact', f.id || '', 'Something you taught me',
        f.source || f.learned_from || '', day(f.created_at || f.at), f.text || f.fact || ''));
    try {
        const ctx = require('../memory').loadBusinessContext();
        for (const c of (Array.isArray(ctx) ? ctx : [])) {
            out.push(row('context', c.id || '', 'Business context', c.source || '', day(c.at || c.created_at), c.text || c.note || String(c)));
        }
    } catch (e) { /* context is optional */ }
    return out.filter((r) => r.body);
}

const SOURCES = { email: mailRows, sent_email: sentRows, invoice: invoiceRows, document: documentRows, quote_reply: quoteRows, fact: factRows };

let cache = null;
function ensure({ force = false } = {}) {
    const sig = signature();
    if (!force && cache && cache.signature === sig) return cache;
    const rows = [];
    const counts = {};
    for (const kind of Object.keys(SOURCES)) {
        let got = [];
        try { got = SOURCES[kind]() || []; }
        catch (e) { console.error(`[TEXTINDEX] ${kind} failed: ${e.message}`); }
        counts[kind] = got.length;
        rows.push(...got);
    }
    const engine = require('./sqlEngine');
    const file = engine.buildFts(rows, sig);
    cache = { file, signature: sig, counts, total: rows.length, engine: engine.engineName() };
    return cache;
}
function invalidate() { cache = null; }

// ── HER QUESTION, AS A SEARCH ───────────────────────────────────────────────
// FTS5's query language is not free text: an apostrophe or a bare "AND" is a
// syntax error, so every term is quoted. Identifiers (container numbers,
// invoice numbers, amounts) are kept exactly; ordinary words get a prefix
// match so "invoicing" finds "invoice". Question words are dropped — every
// document would match "what".
const STOP = new Set(['what', 'when', 'where', 'which', 'who', 'whom', 'whose', 'why', 'how', 'did', 'do', 'does',
    'is', 'are', 'was', 'were', 'the', 'a', 'an', 'of', 'to', 'for', 'about', 'on', 'in', 'at', 'and', 'or',
    'me', 'my', 'we', 'our', 'us', 'i', 'it', 'that', 'this', 'they', 'them', 'he', 'she', 'his', 'her',
    'say', 'said', 'says', 'tell', 'told', 'find', 'show', 'mail', 'email', 'emails', 'any', 'from', 'with',
    'jarvis', 'scout', 'please', 'can', 'you', 'be', 'been', 'have', 'has', 'had', 'their', 'there']);

function toMatch(question) {
    const words = String(question || '').toLowerCase().match(/[a-z0-9][a-z0-9._/-]*/g) || [];
    const terms = [];
    for (const w of words) {
        if (w.length < 2 || STOP.has(w)) continue;
        const exact = /\d/.test(w);
        const term = `"${w.replace(/"/g, '')}"${exact ? '' : '*'}`;
        if (!terms.includes(term)) terms.push(term);
    }
    return terms.slice(0, 12).join(' OR ');
}

// Top passages for a question. BM25 is negative-better in SQLite, hence ASC.
function search(question, { limit = 12, kinds = null } = {}) {
    const info = ensure();
    const match = toMatch(question);
    if (!match) return { hits: [], match: '', info };
    const engine = require('./sqlEngine');
    const where = kinds && kinds.length
        ? ` AND kind IN (${kinds.map((k) => `'${String(k).replace(/'/g, '')}'`).join(', ')})` : '';
    const sql = `SELECT kind, ref, title, who, when_at, body, bm25(text_index) AS score
                 FROM text_index WHERE text_index MATCH '${match.replace(/'/g, "''")}'${where}
                 ORDER BY score ASC LIMIT ${Number(limit) || 12}`;
    try {
        const out = engine.query(info.file, sql, { limit });
        return { hits: out.rows || [], match, info };
    } catch (e) {
        console.error('[TEXTINDEX] search failed:', e.message);
        return { hits: [], match, info, error: e.message };
    }
}

module.exports = { ensure, invalidate, search, toMatch, signature, SOURCES };
