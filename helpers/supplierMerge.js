// ── helpers/supplierMerge.js — one supplier, one spelling ───────────────────
//
// Apsara, 2026-09-19, after importing the Shipments workbook: "There are like
// calderon CALDERON,upper case,Space issue like EDGE YARD,EDGEYARD ,MODern
// modern enterprises getting treated as diff suppliers in bills. make jarvis
// work on that and fix this."
//
// ── THE RULE ALREADY EXISTED; IT HAD NEVER BEEN POINTED AT BILLS ────────────
// helpers/nameMatch.js's normalizeName lowercases and strips every
// non-alphanumeric character, so "EDGE YARD" and "EDGEYARD" are one key, and
// so are "calderon" and "CALDERON". It was written on 2026-08-22 for contacts
// and address-book lookups and extended to sellers and buyers on the Yard
// side; the Edge Metals bills ledger never used it. Nothing new is invented
// here — this is that rule, applied where she has just found it missing.
//
// It also refuses the third case, correctly: "MODern" normalises to "modern"
// and "modern enterprises" to "modernenterprises". Those are different keys,
// and nameMatch.js is deliberately not fuzzy — "a near-miss is a wrong answer
// with a confident face", and here a near-miss means paying the wrong company.
// So that class is PROPOSED and never applied: Jarvis asks once, she answers,
// and the answer is stored as an alias. The same shape as the item aliases she
// approved on 2026-09-14 ("Ask once, using the AI, and never invent a name").
//
// ── AND IT NEVER MERGES EDGE YARD INTO EDGE METALS ─────────────────────────
// They are different companies, which is most of what this app is for. Their
// normalised keys are "edgeyard" and "edgemetals" — different letters, so no
// rule here can bring them together, and there is a test that says so.
//
// ── SHE CHOSE TO REWRITE THE STORED NAMES ──────────────────────────────────
// Asked whether to group on read or rewrite on disk, she chose rewrite. That
// is 492 live financial records edited, so two things are true of every merge:
//
//   EVERY CHANGED ROW KEEPS ITS ORIGINAL in supplier_was, and the merge id in
//   supplier_merge. She did not ask for this. It is here because the day a
//   merge is wrong is the day it matters, and "the original spelling is gone"
//   is not an acceptable answer on a financial record.
//
//   THE STORES MOVE TOGETHER. A payment records WHO WAS PAID by name
//   (helpers/billPayments.js, helpers/supplierAccount.js: sameSupplier
//   compares strings), so rewriting bills.json alone would leave every
//   existing payment matching nothing — balances would jump to the full
//   invoice amount on suppliers she has already paid. Bills, payments, the
//   supplier list and the booking workflow are rewritten in one operation or
//   none of them is.

const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');
const { normalizeName } = require('./nameMatch');
const { canonicalName } = require('./canonicalName');

// ── EVERY PLACE A SUPPLIER NAME IS STORED ───────────────────────────────────
// Found by listing the stores and reading them, not by memory. Edge Yard's
// loads.json is deliberately absent: it keys on `seller`, it is a different
// company's ledger, and nothing here should touch it.
//
// `votes` marks the stores that get a say in WHICH SPELLING WINS. Only the
// two where she names a supplier deliberately: the bills she types and the
// supplier list she keeps. A payment, a booking and a workflow row all
// INHERIT whatever spelling happened to be current when they were written, so
// letting them vote counts the same decision several times.
//
// That is not theoretical. A single payment recorded against "calderon" made
// it 2-2 against "CALDERON" and the merge renamed CALDERON → calderon — the
// wrong way round, on every bill. They are all still RENAMED; they just do
// not get to choose the name.
const TARGETS = [
    { key: 'bills', file: cfg.BILLS_FILE, shape: 'array', field: 'supplier', label: 'bills', votes: true },
    { key: 'payments', file: cfg.BILL_PAYMENTS_FILE, shape: 'array', field: 'supplier', label: 'supplier payments' },
    { key: 'suppliers', file: cfg.SUPPLIERS_FILE, shape: 'array', field: 'name', label: 'the supplier list', votes: true },
    { key: 'workflow', file: cfg.WORKFLOW_FILE, shape: 'object', field: 'supplier', label: 'booking workflow' },
    { key: 'bookings', file: cfg.BOOKINGS_FILE, shape: 'object', field: 'supplier', label: 'bookings' },
];

const ALIAS_FILE = require('path').join(cfg.DATA_DIR || '.', 'supplier_aliases.json');

const str = (v) => String(v === null || v === undefined ? '' : v).trim();

function rowsOf(t) {
    const raw = loadJson(t.file, t.shape === 'array' ? [] : {});
    if (t.shape === 'array') return Array.isArray(raw) ? raw : [];
    return raw && typeof raw === 'object' ? Object.values(raw) : [];
}

// Every spelling in use, with where it is used and how often. Newest first
// within each store, because canonicalName breaks ties by position and both
// ledgers keep newest first.
function usage() {
    const seen = new Map();   // spelling -> { name, total, votes, newest, by: {store: n} }
    for (const t of TARGETS) {
        for (const row of rowsOf(t)) {
            const name = str(row && row[t.field]);
            if (!name) continue;
            const e = seen.get(name) || { name, total: 0, votes: 0, newest: '', by: {} };
            e.total += 1;
            if (t.votes) e.votes += 1;
            // ── NEWEST FIRST IS THE TIE-BREAK, SO IT HAS TO BE REAL ──────
            // canonicalName breaks a tie by POSITION IN THE ARRAY, its
            // contract being that callers pass newest first. The first
            // version of this passed names in file order — which for an
            // append-only ledger is OLDEST first, the exact opposite — so a
            // tie went to whichever spelling was typed longest ago. Sorted on
            // the row's own created_at instead of relying on file order.
            const at = str(row && (row.created_at || row.updated_at));
            if (t.votes && at > e.newest) e.newest = at;
            e.by[t.key] = (e.by[t.key] || 0) + 1;
            seen.set(name, e);
        }
    }
    return [...seen.values()];
}

// ── THE ALIASES SHE HAS CONFIRMED ───────────────────────────────────────────
// Only ever written in answer to a direct question. Never inferred.
function aliases() {
    const raw = loadJson(ALIAS_FILE, []);
    return Array.isArray(raw) ? raw.filter((a) => a && a.from && a.to) : [];
}

// from -> to, normalised on both sides so a confirmed alias keeps working when
// she later types it in a different case.
function aliasMap() {
    const m = new Map();
    for (const a of aliases()) m.set(normalizeName(a.from), str(a.to));
    return m;
}

// ── ALIASES CHAIN ───────────────────────────────────────────────────────────
// She says "g&c" is "carlos g&c" today; in March someone says "carlos g&c" is
// "Carlos G&C Metals". Following one hop would leave the first pair pointing
// at a name that has itself moved on, and the cluster would split in two —
// the exact problem this whole file exists to fix, reintroduced by its own
// mechanism.
//
// Bounded, and it stops the moment a step does not move: a cycle written by
// hand into the alias file must not hang the preview screen.
function resolveAlias(name, map) {
    const m = map || aliasMap();
    let out = str(name);
    const seen = new Set();
    for (let i = 0; i < 10; i++) {
        const k = normalizeName(out);
        if (!k || seen.has(k)) break;
        seen.add(k);
        const next = m.get(k);
        if (!next || normalizeName(next) === k) break;
        out = next;
    }
    return out;
}

async function addAlias(from, to, by) {
    const f = str(from), t = str(to);
    if (!f || !t) throw new Error('an alias needs both names');
    if (normalizeName(f) === normalizeName(t)) throw new Error(`"${f}" and "${t}" are already the same name`);
    // ── A CYCLE WOULD MAKE THE ANSWER DEPEND ON WHERE YOU START ─────────
    // "A is really B" plus "B is really A" has no winner, and resolveAlias
    // would give a different one depending on which name it was handed.
    // Refused at the point it is written, with both names in the message, so
    // the fix is obvious.
    const map = aliasMap();
    if (normalizeName(resolveAlias(t, map)) === normalizeName(f)) {
        throw new Error(`"${t}" is already recorded as being "${f}" — removing that one first would leave this making sense.`);
    }
    await mutateJson(ALIAS_FILE, [], (all) => {
        const list = Array.isArray(all) ? all : [];
        const at = list.findIndex((a) => a && normalizeName(a.from) === normalizeName(f));
        const rec = { from: f, to: t, at: new Date().toISOString(), by: by || null };
        if (at >= 0) list[at] = rec; else list.push(rec);
        return list;
    }, { strict: true });
    return { from: f, to: t };
}

async function removeAlias(from) {
    const f = str(from);
    if (!f) throw new Error('which alias?');
    let gone = false;
    await mutateJson(ALIAS_FILE, [], (all) => {
        const list = Array.isArray(all) ? all : [];
        const keep = list.filter((a) => {
            const hit = a && normalizeName(a.from) === normalizeName(f);
            if (hit) gone = true;
            return !hit;
        });
        return keep;
    }, { strict: true });
    return gone;
}

// ── WHICH SPELLINGS ARE ONE SUPPLIER ────────────────────────────────────────
// Two names cluster when normalizeName agrees, or when she has confirmed an
// alias between them. Nothing else. Returns only clusters with something to
// fix.
function clusters() {
    const map = aliasMap();
    const all = usage();
    const groups = new Map();   // key -> { key, names: [], total }

    for (const u of all) {
        const aliased = resolveAlias(u.name, map);
        const key = normalizeName(aliased === u.name ? u.name : aliased);
        if (!key) continue;
        const g = groups.get(key) || { key, names: [], total: 0 };
        g.names.push(u);
        g.total += u.total;
        groups.set(key, g);
    }

    const out = [];
    for (const g of groups.values()) {
        // ── ONE SPELLING IS USUALLY NOTHING TO FIX ──────────────────────
        // Usually. The exception is a plain RENAME: she typed an alias whose
        // target is a name not yet in use anywhere ("g&c" is really "Carlos
        // G&C Metals", and that longer form has never been typed on a bill).
        // Skipping it would silently ignore an instruction she gave.
        const renamed = g.names.length === 1
            && normalizeName(resolveAlias(g.names[0].name, map)) !== normalizeName(g.names[0].name);
        if (g.names.length < 2 && !renamed) continue;
        // The spelling SHE uses most wins. Not title-case: real company names
        // are not title-cased ("MK Metal Trading", "d.c. scrap", "JB's"), and a
        // rule that rewrites them is a rule that has to be fought. See
        // helpers/canonicalName.js.
        //
        // An alias she confirmed OVERRIDES frequency — she said which name is
        // right, and a vote does not get to disagree with her.
        const aliasedTo = g.names
            .map((n) => (normalizeName(resolveAlias(n.name, map)) !== normalizeName(n.name)
                ? resolveAlias(n.name, map) : null))
            .find(Boolean);
        // Only the voting stores, newest first — canonicalName's own contract.
        // A spelling used ONLY by inherited rows (a payment, a booking) has no
        // votes and cannot win, which is right: she never chose it there.
        // ── AND THE ORDER IS FULLY DETERMINISTIC ────────────────────────
        // Two spellings can tie on votes AND on timestamp — two bills saved in
        // the same millisecond by the import is the normal case, not the
        // exotic one. With only recency to sort on, the winner came out
        // differently between runs, which on a screen means the preview
        // naming "EDGE YARD" one minute and "EDGEYARD" the next.
        //
        // So the order continues: newest, then the LONGEST spelling, then
        // alphabetically. Longest is not arbitrary — "EDGE YARD" keeps the
        // separator and "EDGEYARD" has lost it, and a name typed with its
        // spaces is the more deliberate of the two. Alphabetical is the last
        // resort and exists only so there is never no answer.
        const voters = g.names.filter((n) => n.votes > 0).sort((a, b) =>
            String(b.newest).localeCompare(String(a.newest))
            || b.name.length - a.name.length
            || a.name.localeCompare(b.name));
        const flat = [];
        voters.forEach((n) => { for (let i = 0; i < n.votes; i++) flat.push(n.name); });
        const winner = aliasedTo
            || (flat.length ? canonicalName(flat, flat[0]) : g.names[0].name);
        out.push({
            key: g.key,
            winner,
            total: g.total,
            confirmed: !!aliasedTo,
            losers: g.names.filter((n) => n.name !== winner),
            names: g.names.sort((a, b) => b.total - a.total),
        });
    }
    return out.sort((a, b) => b.total - a.total);
}

// ── WHAT JARVIS SHOULD ASK ABOUT ────────────────────────────────────────────
// Names no rule can join, but that look related enough to be worth ONE
// question: one normalised name is a prefix of, or contained in, another.
// "MODern" inside "modernenterprises" is the case she named.
//
// Proposed. Never applied. The whole reason nameMatch.js refuses fuzzy
// matching is that a near-miss here means paying the wrong company — so this
// function's output is a question, and only her answer turns it into an alias.
function proposals() {
    const map = aliasMap();
    const names = usage()
        .filter((u) => !map.has(normalizeName(u.name)))
        .map((u) => ({ ...u, k: normalizeName(u.name) }))
        .filter((u) => u.k.length >= 4);      // "AB" is inside half the alphabet
    const out = [];
    for (const a of names) {
        for (const b of names) {
            if (a.k === b.k || a.k.length >= b.k.length) continue;
            if (!b.k.startsWith(a.k)) continue;      // prefix only, not "contains"
            out.push({
                shorter: a.name, longer: b.name,
                shorter_uses: a.total, longer_uses: b.total,
                // The suggested answer is the LONGER name — a full company name
                // is more likely the real one than an abbreviation of it — but
                // it is a suggestion on a question, not a decision.
                suggest: b.name,
                question: `Is "${a.name}" (${a.total} row${a.total === 1 ? '' : 's'}) the same supplier as `
                        + `"${b.name}" (${b.total} row${b.total === 1 ? '' : 's'})?`,
            });
        }
    }
    return out;
}

// ── WHAT A MERGE WOULD CHANGE, BEFORE IT CHANGES ANYTHING ───────────────────
function plan(opts = {}) {
    const only = opts.keys ? new Set(opts.keys) : null;
    const cs = clusters().filter((c) => !only || only.has(c.key));
    const changes = [];
    for (const t of TARGETS) {
        for (const row of rowsOf(t)) {
            const name = str(row && row[t.field]);
            if (!name) continue;
            const c = cs.find((x) => x.losers.some((l) => l.name === name));
            if (!c) continue;
            changes.push({ store: t.key, label: t.label, from: name, to: c.winner, id: row.id || null });
        }
    }
    const byStore = {};
    for (const ch of changes) byStore[ch.store] = (byStore[ch.store] || 0) + 1;
    return { clusters: cs, changes, byStore, total: changes.length,
             merge_id: opts.merge_id || `mrg_${new Date().toISOString().replace(/[:.]/g, '-')}` };
}

// ── DO IT ───────────────────────────────────────────────────────────────────
// One strict, retried mutateJson per store. mutateJson is non-strict by
// default: a lock failure logs, returns stale data and NEVER RUNS THE MUTATOR
// — which here would mean reporting a merge that did not happen, on half the
// stores. That trade is right for a cache and catastrophic for this.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function writeStore(t, rename, mergeId, attempt = 0) {
    let n = 0;
    try {
        await mutateJson(t.file, t.shape === 'array' ? [] : {}, (raw) => {
            const each = (row) => {
                const name = str(row && row[t.field]);
                const to = rename.get(name);
                if (!to || to === name) return;
                // ── THE ORIGINAL IS KEPT ────────────────────────────────
                // Only the FIRST time. A second merge must not overwrite the
                // spelling the spreadsheet actually carried — that is the one
                // worth being able to get back to.
                if (row.supplier_was === undefined) row.supplier_was = name;
                row.supplier_merge = mergeId;
                row[t.field] = to;
                n += 1;
            };
            if (t.shape === 'array') {
                const list = Array.isArray(raw) ? raw : [];
                list.forEach(each);
                return list;
            }
            const obj = raw && typeof raw === 'object' ? raw : {};
            Object.values(obj).forEach(each);
            return obj;
        }, { strict: true });
    } catch (e) {
        if (attempt >= 5) throw e;
        await sleep(50 * (attempt + 1));
        return writeStore(t, rename, mergeId, attempt + 1);
    }
    return n;
}

async function apply(planned) {
    if (!planned || !planned.merge_id) throw new Error('nothing planned to merge');
    const rename = new Map();
    for (const c of planned.clusters) for (const l of c.losers) rename.set(l.name, c.winner);
    if (!rename.size) return { merge_id: planned.merge_id, changed: 0, byStore: {} };

    const byStore = {};
    let changed = 0;
    for (const t of TARGETS) {
        const n = await writeStore(t, rename, planned.merge_id);
        if (n) { byStore[t.key] = n; changed += n; }
    }
    return { merge_id: planned.merge_id, changed, byStore,
             clusters: planned.clusters.map((c) => ({ winner: c.winner, from: c.losers.map((l) => l.name) })) };
}

// ── AND THE WAY BACK ────────────────────────────────────────────────────────
// Restores supplier_was on exactly the rows carrying this merge id. A row she
// typed herself cannot carry one, so this cannot un-rename anything else.
async function undo(mergeId) {
    if (!mergeId) throw new Error('which merge? a merge id is required');
    let restored = 0;
    for (const t of TARGETS) {
        await mutateJson(t.file, t.shape === 'array' ? [] : {}, (raw) => {
            const each = (row) => {
                if (!row || row.supplier_merge !== mergeId) return;
                if (row.supplier_was !== undefined) { row[t.field] = row.supplier_was; delete row.supplier_was; }
                delete row.supplier_merge;
                restored += 1;
            };
            if (t.shape === 'array') { const l = Array.isArray(raw) ? raw : []; l.forEach(each); return l; }
            const o = raw && typeof raw === 'object' ? raw : {};
            Object.values(o).forEach(each);
            return o;
        }, { strict: true });
    }
    return restored;
}

function merges() {
    const seen = new Map();
    for (const t of TARGETS) {
        for (const row of rowsOf(t)) {
            if (!row || !row.supplier_merge) continue;
            const m = seen.get(row.supplier_merge) || { merge_id: row.supplier_merge, rows: 0, stores: {} };
            m.rows += 1;
            m.stores[t.key] = (m.stores[t.key] || 0) + 1;
            seen.set(row.supplier_merge, m);
        }
    }
    return [...seen.values()].sort((a, b) => String(b.merge_id).localeCompare(String(a.merge_id)));
}

module.exports = { TARGETS, usage, clusters, proposals, plan, apply, undo, merges,
                   aliases, addAlias, removeAlias, aliasMap, resolveAlias, ALIAS_FILE };
