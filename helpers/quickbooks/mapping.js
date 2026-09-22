// ── helpers/quickbooks/mapping.js — which QuickBooks name is this party? ────
// Apsara, 2026-09-21: "pull from qb against suppliers for bills and customers
// for invoice. check then enter".
//
// Before Jarvis enters a bill it must know which QuickBooks VENDOR the
// supplier is, and for an invoice which CUSTOMER. Her QuickBooks already has
// 347 vendors and 188 customers typed by her and her accountant, and the same
// company is not always spelt the Jarvis way ("TAEWON PRECEISION").
//
// ── ONLY AN EXACT MATCH IS AUTOMATIC ──────────────────────────────────────
// helpers/nameMatch.js is DELIBERATELY NOT FUZZY, and the reason holds here
// with money attached: a near-miss resolves to the wrong company, and a bill
// entered against the wrong vendor puts one supplier's balance on another.
// So there are four answers, and only the first links anything:
//
//   exact      spelling identical once spaces/punctuation go (nameMatch's
//              own rule). Linked automatically.
//   suggest    one plausible candidate — legal suffix dropped, one name
//              contained in the other, or a close spelling. SHOWN to her with
//              the candidate; nothing is linked until she confirms.
//   ambiguous  several plausible candidates. Shown with all of them.
//   none       nothing close. Jarvis does NOT create a vendor/customer on its
//              own; she decides whether it is new.
//
// Her confirmations are stored (data/qb-party-map.json) and win over every
// rule above, including "exact", so a correction she makes once stays made.

const fs = require('fs');
const path = require('path');
const { normalizeName } = require('../nameMatch');
const { DATA_DIR } = require('../../config');

const MAP_FILE = () => process.env.QB_PARTY_MAP_FILE || path.join(DATA_DIR, 'qb-party-map.json');
// 'item' = her grade (Auto Cast, AL Combo…) against a QuickBooks Item. Same
// rules as parties: a grade on the wrong item misstates what was sold, and
// that is the figure her P&L-by-product and her ISRI reporting are read from.
// 'bank' = the account money moved through (Jarvis: BofA, Chase Bank…) against
// a QuickBooks Bank account (Checking (3301)…). Same rule: never guessed — a
// payment from the wrong account is a reconciliation that never balances.
const KINDS = ['vendor', 'customer', 'item', 'bank'];

// Words that say what kind of company it is, not which one. Dropped only for
// the SUGGEST tier, never for exact.
const LEGAL = new Set(['llc', 'inc', 'incorporated', 'co', 'company', 'corp', 'corporation', 'ltd', 'limited', 'coltd', 'pvt', 'plc', 'lp', 'the', 'customer', 'vendor']);

function tokens(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((t) => t && !LEGAL.has(t));
}
function core(s) { return tokens(s).join(''); }

// Classic edit distance, bounded use: only ever to RANK suggestions.
function editDistance(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m || !n) return m || n;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
        const cur = [i];
        for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = cur;
    }
    return prev[n];
}
function similarity(a, b) {
    const L = Math.max(a.length, b.length);
    return L ? 1 - editDistance(a, b) / L : 0;
}

function loadMap() {
    try { const m = JSON.parse(fs.readFileSync(MAP_FILE(), 'utf8')); KINDS.forEach((k) => { m[k] = m[k] || {}; }); return m; }
    catch { return { vendor: {}, customer: {}, item: {}, bank: {} }; }
}
function saveMap(m) {
    const f = MAP_FILE(), tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
    fs.renameSync(tmp, f);
}

// qbList: [{ Id, DisplayName, Active }] as QuickBooks returns them.
function matchParty(jarvisName, qbList, kind, map = loadMap()) {
    const key = normalizeName(jarvisName);
    if (!key) return { status: 'none', jarvisName, candidates: [] };
    if (!KINDS.includes(kind)) throw new Error(`kind must be vendor|customer|item|bank, got ${kind}`);

    const confirmed = map[kind][key];
    if (confirmed) {
        if (confirmed.qbId === null) return { status: 'new', jarvisName, candidates: [], note: 'she marked this as not in QuickBooks' };
        // Not a party at all in this role. Apsara, 2026-09-21, on "Junk Car"
        // in the Customer column of 17 local deliveries: "we will keep it in
        // their inventory. When customer is loaded, we will mix them." The
        // yard is where the stock waits, not who bought it, so nothing may
        // ever be invoiced to it; the sale happens later, to the real buyer.
        if (confirmed.qbId === 'SKIP') return { status: 'skip', jarvisName, candidates: [], note: confirmed.reason || 'not a party in this role' };
        return { status: 'confirmed', jarvisName, qb: { Id: confirmed.qbId, DisplayName: confirmed.qbName }, candidates: [] };
    }

    // Inactive (QuickBooks shows them as "(deleted)") only count when there
    // is no active record at all: her live "Mazariegos Recycling" must not be
    // made ambiguous by a deleted "MAZARIEGOS RECYCLING LLC" from 2024.
    const all = (qbList || []).filter((q) => q && q.DisplayName);
    const active = all.filter((q) => q.Active !== false);
    const exactOf = (L) => L.filter((q) => normalizeName(q.DisplayName) === key);
    let exact = exactOf(active);
    if (!exact.length) exact = exactOf(all);
    if (exact.length === 1) return { status: 'exact', jarvisName, qb: pick(exact[0]), candidates: [] };
    if (exact.length > 1) return { status: 'ambiguous', jarvisName, candidates: exact.map((q) => ({ ...pick(q), why: 'same name twice in QuickBooks' })), note: 'duplicate in QuickBooks' };

    const fuzzy = rankSuggestions(jarvisName, active);
    return fuzzy.status !== 'none' ? fuzzy : rankSuggestions(jarvisName, all);
}

function rankSuggestions(jarvisName, list) {

    const jc = core(jarvisName), jt = tokens(jarvisName);
    const scored = [];
    for (const q of list) {
        const qc = core(q.DisplayName), qt = tokens(q.DisplayName);
        if (!jc || !qc) continue;
        let score = 0, why = '';
        if (qc === jc) { score = 0.99; why = 'same apart from LLC/Inc/Co'; }
        else if (jt.length && qt.length && (jt.every((t) => qt.includes(t)) || qt.every((t) => jt.includes(t))) && Math.min(jc.length, qc.length) >= 3) {
            score = 0.9; why = 'one name contains the other';
        } else {
            const s = similarity(jc, qc);
            if (s >= 0.8 && Math.min(jc.length, qc.length) >= 5) { score = s; why = `close spelling (${Math.round(s * 100)}%)`; }
        }
        if (score) scored.push({ ...pick(q), score, why });
    }
    scored.sort((a, b) => b.score - a.score);
    if (!scored.length) return { status: 'none', jarvisName, candidates: [] };
    const top = scored[0];
    const rivals = scored.filter((s) => s.score >= top.score - 0.05);
    if (rivals.length > 1) return { status: 'ambiguous', jarvisName, candidates: scored.slice(0, 5) };
    return { status: 'suggest', jarvisName, candidates: scored.slice(0, 3) };
}

function pick(q) { return { Id: String(q.Id), DisplayName: q.DisplayName, Active: q.Active !== false }; }

// Her decision. qbId=null means "not in QuickBooks — a new party".
// qbId='SKIP' means "never a vendor/customer in this role" (reason kept).
function confirm(kind, jarvisName, qbId, qbName, by = 'apsara', reason = null) {
    if (!KINDS.includes(kind)) throw new Error(`kind must be vendor|customer|item|bank, got ${kind}`);
    const key = normalizeName(jarvisName);
    if (!key) throw new Error('empty Jarvis name');
    const m = loadMap();
    m[kind][key] = { jarvisName, qbId: qbId === null ? null : String(qbId), qbName: qbName || null, by, at: new Date().toISOString(), ...(reason ? { reason } : {}) };
    saveMap(m);
    return m[kind][key];
}

// Pulls the full active+inactive list (reads only). Paged: QuickBooks caps a
// query at 1000 rows.
async function fetchParties(kind, client, opts) {
    if (kind === 'bank') {
        const r = await client.query("select Id, Name, Active, AccountType from Account where AccountType = 'Bank' maxresults 1000", opts);
        return (r.Account || []).map((a) => ({ Id: a.Id, DisplayName: a.Name, Active: a.Active }));
    }
    if (kind === 'item') {
        // Items have Name, not DisplayName; shaped the same so matchParty
        // treats a grade exactly as it treats a company.
        const out = [];
        for (let start = 1; ; start += 1000) {
            const r = await client.query(`select Id, Name, Active, Type from Item where Active in (true, false) startposition ${start} maxresults 1000`, opts);
            const rows = r.Item || [];
            // A Category is a folder in her item list; QuickBooks refuses a
            // bill or invoice line on one, so it can never be an answer.
            out.push(...rows.filter((i) => i.Type !== 'Category').map((i) => ({ Id: i.Id, DisplayName: i.Name, Active: i.Active, Type: i.Type })));
            if (rows.length < 1000) break;
        }
        return out;
    }
    const table = kind === 'vendor' ? 'Vendor' : 'Customer';
    const out = [];
    for (let start = 1; ; start += 1000) {
        const r = await client.query(`select Id, DisplayName, Active from ${table} where Active in (true, false) startposition ${start} maxresults 1000`, opts);
        const rows = r[table] || [];
        out.push(...rows);
        if (rows.length < 1000) break;
    }
    return out;
}

module.exports = { matchParty, confirm, loadMap, fetchParties, tokens, core, similarity, MAP_FILE };
