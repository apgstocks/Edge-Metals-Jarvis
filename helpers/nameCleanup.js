// ── helpers/nameCleanup.js — one counterparty, one spelling ─────────────────
//
// Apsara, 2026-09-19, after importing the Shipments workbook: "There are like
// calderon CALDERON,upper case,Space issue like EDGE YARD,EDGEYARD ,MODern
// modern enterprises getting treated as diff suppliers in bills."
//
// And then, when the same thing turned up elsewhere: "Even in carrier-that
// supplier name same problem is there.dont make sepratae button for this.
// instead ,make one button give an opion for each field to correct this."
//
// So this is field-scoped. It was supplierMerge.js and did one field; a
// second copy for Carrier and a third for Trucker would be three places to
// fix the next thing she finds. FIELDS below is the whole difference between
// them — everything else is shared.
//
// ── THE RULE ALREADY EXISTED; IT HAD NEVER BEEN POINTED AT THESE ────────────
// helpers/nameMatch.js's normalizeName lowercases and strips every
// non-alphanumeric character, so "EDGE YARD" and "EDGEYARD" are one key, and
// so are "calderon" and "CALDERON". It was written on 2026-08-22 for contacts
// and address-book lookups and extended to sellers and buyers on the Yard
// side; the Edge Metals ledgers never used it. Nothing new is invented here.
//
// It also refuses the third case, correctly: "MODern" normalises to "modern"
// and "modern enterprises" to "modernenterprises". Different keys, and
// nameMatch.js is deliberately not fuzzy — "a near-miss is a wrong answer with
// a confident face", and here a near-miss means paying the wrong company. So
// that class is PROPOSED and never applied: Jarvis asks once, she answers, and
// the answer is stored as an alias. Same shape as the item aliases she
// approved on 2026-09-14 ("Ask once, using the AI, and never invent a name").
//
// ── AND IT NEVER MERGES EDGE YARD INTO EDGE METALS ─────────────────────────
// They are different companies, which is most of what this app is for. Their
// normalised keys are "edgeyard" and "edgemetals" — different letters, so no
// rule here can bring them together, and there is a test that says so. Edge
// Yard's own ledger (loads.json, keyed on `seller`) is absent from every
// field below, deliberately: it is another company's books.
//
// ── SHE CHOSE TO REWRITE THE STORED NAMES ──────────────────────────────────
// Asked whether to group on read or rewrite on disk, she chose rewrite. That
// is hundreds of live financial records edited, so two things hold for every
// merge:
//
//   EVERY CHANGED ROW KEEPS ITS ORIGINAL, per field, and the merge id beside
//   it. She did not ask for this. It is here because the day a merge is wrong
//   is the day it matters, and "the original spelling is gone" is not an
//   acceptable answer on a financial record.
//
//   THE STORES MOVE TOGETHER. A payment records WHO WAS PAID by name
//   (billPayments.js, supplierAccount.js: sameSupplier compares strings), so
//   rewriting bills alone would leave every existing payment matching nothing
//   — balances jumping to the full invoice amount on suppliers she has already
//   paid. Every store for a field is rewritten in one operation or none is.

const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');
const { normalizeName } = require('./nameMatch');
const { canonicalName } = require('./canonicalName');

// ── EVERY PLACE EACH NAME IS STORED ─────────────────────────────────────────
// Found by listing the stores and reading them, not by memory.
//
// `votes` marks the stores that get a say in WHICH SPELLING WINS: the ones
// where she names the counterparty deliberately. A payment, a booking and a
// workflow row all INHERIT whatever spelling was current when they were
// written, so letting them vote counts one decision several times.
//
// That is not theoretical. A single payment recorded against "calderon" made
// it 2-2 against "CALDERON" and the merge renamed CALDERON → calderon on every
// bill — backwards. They are all still RENAMED; they just do not choose.
const FIELDS = {
    supplier: {
        label: 'Supplier',
        where: 'bills, supplier payments, the supplier list and bookings',
        targets: [
            { key: 'bills', file: cfg.BILLS_FILE, shape: 'array', field: 'supplier', label: 'bills', votes: true },
            { key: 'payments', file: cfg.BILL_PAYMENTS_FILE, shape: 'array', field: 'supplier', label: 'supplier payments' },
            { key: 'suppliers', file: cfg.SUPPLIERS_FILE, shape: 'array', field: 'name', label: 'the supplier list', votes: true },
            { key: 'workflow', file: cfg.WORKFLOW_FILE, shape: 'object', field: 'supplier', label: 'booking workflow' },
            { key: 'bookings', file: cfg.BOOKINGS_FILE, shape: 'object', field: 'supplier', label: 'bookings' },
        ],
    },
    carrier: {
        label: 'Carrier',
        where: 'bills and bookings',
        targets: [
            { key: 'bills', file: cfg.BILLS_FILE, shape: 'array', field: 'carrier', label: 'bills', votes: true },
            { key: 'bookings', file: cfg.BOOKINGS_FILE, shape: 'object', field: 'carrier', label: 'bookings' },
        ],
    },
    trucker: {
        label: 'Trucker',
        where: 'bills, the trucker list and the booking workflow',
        targets: [
            // The column on a bill is `trucking_company`, not `trucker` — her
            // word for it on screen is Trucker, which is why the FIELD key and
            // the COLUMN name differ here and only here.
            { key: 'bills', file: cfg.BILLS_FILE, shape: 'array', field: 'trucking_company', label: 'bills', votes: true },
            { key: 'truckers', file: cfg.TRUCKERS_FILE, shape: 'array', field: 'name', label: 'the trucker list', votes: true },
            { key: 'workflow', file: cfg.WORKFLOW_FILE, shape: 'object', field: 'trucker_name', label: 'booking workflow' },
        ],
    },
    customer: {
        label: 'Customer',
        where: 'the invoice register',
        targets: [
            { key: 'sales', file: cfg.SALES_FILE, shape: 'array', field: 'customer', label: 'invoices', votes: true },
        ],
    },
};

const FIELD_KEYS = Object.keys(FIELDS);

function targetsFor(field) {
    const f = FIELDS[field];
    if (!f) throw new Error(`unknown field "${field}" — one of ${FIELD_KEYS.join(', ')}`);
    return f.targets;
}

const ALIAS_FILE = require('path').join(cfg.DATA_DIR || '.', 'name_aliases.json');
// What supplierMerge.js wrote before this became field-scoped. Read, never
// written — an alias she confirmed must not be forgotten by a refactor.
const LEGACY_SUPPLIER_ALIASES = require('path').join(cfg.DATA_DIR || '.', 'supplier_aliases.json');

const str = (v) => String(v === null || v === undefined ? '' : v).trim();

function rowsOf(t) {
    const raw = loadJson(t.file, t.shape === 'array' ? [] : {});
    if (t.shape === 'array') return Array.isArray(raw) ? raw : [];
    return raw && typeof raw === 'object' ? Object.values(raw) : [];
}

// Every spelling in use, with where it is used and how often. Newest first
// within each store, because canonicalName breaks ties by position and both
// ledgers keep newest first.
function usage(field) {
    const seen = new Map();   // spelling -> { name, total, votes, newest, by: {store: n} }
    for (const t of targetsFor(field)) {
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
function aliases(field) {
    const raw = loadJson(ALIAS_FILE, []);
    const now = (Array.isArray(raw) ? raw : []).filter((a) => a && a.from && a.to);
    // The pre-field-scope file, tagged as what it was: supplier answers.
    const old = (loadJson(LEGACY_SUPPLIER_ALIASES, []) || [])
        .filter((a) => a && a.from && a.to)
        .map((a) => ({ ...a, field: 'supplier' }))
        // A newer answer for the same name wins over the legacy one.
        .filter((a) => !now.some((n) => (n.field || 'supplier') === 'supplier'
                                        && normalizeName(n.from) === normalizeName(a.from)));
    const all = [...now, ...old];
    return field ? all.filter((a) => (a.field || 'supplier') === field) : all;
}

// from -> to, normalised on both sides so a confirmed alias keeps working when
// she later types it in a different case.
function aliasMap(field) {
    const m = new Map();
    for (const a of aliases(field)) m.set(normalizeName(a.from), str(a.to));
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
function resolveAlias(name, map, field) {
    const m = map || aliasMap(field);
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

async function addAlias(field, from, to, by) {
    targetsFor(field);                       // unknown field throws, loudly
    const f = str(from), t = str(to);
    if (!f || !t) throw new Error('an alias needs both names');
    if (normalizeName(f) === normalizeName(t)) throw new Error(`"${f}" and "${t}" are already the same name`);
    // ── A CYCLE WOULD MAKE THE ANSWER DEPEND ON WHERE YOU START ─────────
    // "A is really B" plus "B is really A" has no winner, and resolveAlias
    // would give a different one depending on which name it was handed.
    // Refused at the point it is written, with both names in the message, so
    // the fix is obvious.
    const map = aliasMap(field);
    if (normalizeName(resolveAlias(t, map, field)) === normalizeName(f)) {
        throw new Error(`"${t}" is already recorded as being "${f}" — removing that one first would leave this making sense.`);
    }
    await mutateJson(ALIAS_FILE, [], (all) => {
        const list = Array.isArray(all) ? all : [];
        const at = list.findIndex((a) => a && (a.field || 'supplier') === field
                                          && normalizeName(a.from) === normalizeName(f));
        const rec = { field, from: f, to: t, at: new Date().toISOString(), by: by || null };
        if (at >= 0) list[at] = rec; else list.push(rec);
        return list;
    }, { strict: true });
    return { field, from: f, to: t };
}

async function removeAlias(field, from) {
    const f = str(from);
    if (!f) throw new Error('which alias?');
    let gone = false;
    await mutateJson(ALIAS_FILE, [], (all) => {
        const list = Array.isArray(all) ? all : [];
        const keep = list.filter((a) => {
            const hit = a && (a.field || 'supplier') === field
                          && normalizeName(a.from) === normalizeName(f);
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
function clusters(field) {
    const map = aliasMap(field);
    const all = usage(field);
    const groups = new Map();   // key -> { key, names: [], total }

    for (const u of all) {
        const aliased = resolveAlias(u.name, map, field);
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
            && normalizeName(resolveAlias(g.names[0].name, map, field)) !== normalizeName(g.names[0].name);
        if (g.names.length < 2 && !renamed) continue;
        // The spelling SHE uses most wins. Not title-case: real company names
        // are not title-cased ("MK Metal Trading", "d.c. scrap", "JB's"), and a
        // rule that rewrites them is a rule that has to be fought. See
        // helpers/canonicalName.js.
        //
        // An alias she confirmed OVERRIDES frequency — she said which name is
        // right, and a vote does not get to disagree with her.
        const aliasedTo = g.names
            .map((n) => (normalizeName(resolveAlias(n.name, map, field)) !== normalizeName(n.name)
                ? resolveAlias(n.name, map, field) : null))
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
            field,
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
function proposals(field) {
    const map = aliasMap(field);
    const names = usage(field)
        .filter((u) => !map.has(normalizeName(u.name)))
        .map((u) => ({ ...u, k: normalizeName(u.name) }))
        .filter((u) => u.k.length >= 4);      // "AB" is inside half the alphabet
    const out = [];
    for (const a of names) {
        for (const b of names) {
            if (a.k === b.k || a.k.length >= b.k.length) continue;
            if (!b.k.startsWith(a.k)) continue;      // prefix only, not "contains"
            out.push({
                field,
                shorter: a.name, longer: b.name,
                shorter_uses: a.total, longer_uses: b.total,
                // The suggested answer is the LONGER name — a full company name
                // is more likely the real one than an abbreviation of it — but
                // it is a suggestion on a question, not a decision.
                suggest: b.name,
                question: `Is "${a.name}" (${a.total} row${a.total === 1 ? '' : 's'}) the same `
                        + `${FIELDS[field].label.toLowerCase()} as `
                        + `"${b.name}" (${b.total} row${b.total === 1 ? '' : 's'})?`,
            });
        }
    }
    return out;
}

// ── WHAT A MERGE WOULD CHANGE, BEFORE IT CHANGES ANYTHING ───────────────────
function plan(field, opts = {}) {
    const only = opts.keys ? new Set(opts.keys) : null;
    const cs = clusters(field).filter((c) => !only || only.has(c.key));
    const changes = [];
    for (const t of targetsFor(field)) {
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
    return { field, clusters: cs, changes, byStore, total: changes.length,
             merge_id: opts.merge_id || `mrg_${field}_${new Date().toISOString().replace(/[:.]/g, '-')}` };
}

// ── DO IT ───────────────────────────────────────────────────────────────────
// One strict, retried mutateJson per store. mutateJson is non-strict by
// default: a lock failure logs, returns stale data and NEVER RUNS THE MUTATOR
// — which here would mean reporting a merge that did not happen, on half the
// stores. That trade is right for a cache and catastrophic for this.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function writeStore(field, t, rename, mergeId, attempt = 0) {
    let n = 0;
    try {
        await mutateJson(t.file, t.shape === 'array' ? [] : {}, (raw) => {
            const each = (row) => {
                const name = str(row && row[t.field]);
                const to = rename.get(name);
                if (!to || to === name) return;
                // ── THE ORIGINAL IS KEPT, PER FIELD ─────────────────────
                // Keyed by FIELD, not one flat pair. A bill has a supplier AND
                // a carrier AND a trucker; merging the second would otherwise
                // overwrite the first's original and leave it unrecoverable
                // while still claiming to be undoable.
                //
                // Only the first time for that field: a second merge must not
                // overwrite the spelling the spreadsheet actually carried.
                if (!row.name_was || typeof row.name_was !== 'object') row.name_was = {};
                if (!row.name_merge || typeof row.name_merge !== 'object') row.name_merge = {};
                if (row.name_was[field] === undefined) row.name_was[field] = name;
                row.name_merge[field] = mergeId;
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
        return writeStore(field, t, rename, mergeId, attempt + 1);
    }
    return n;
}

async function apply(planned) {
    if (!planned || !planned.merge_id) throw new Error('nothing planned to merge');
    const rename = new Map();
    for (const c of planned.clusters) for (const l of c.losers) rename.set(l.name, c.winner);
    if (!rename.size) return { field: planned.field, merge_id: planned.merge_id, changed: 0, byStore: {} };

    const byStore = {};
    let changed = 0;
    for (const t of targetsFor(planned.field)) {
        const n = await writeStore(planned.field, t, rename, planned.merge_id);
        if (n) { byStore[t.key] = n; changed += n; }
    }
    return { field: planned.field, merge_id: planned.merge_id, changed, byStore,
             clusters: planned.clusters.map((c) => ({ winner: c.winner, from: c.losers.map((l) => l.name) })) };
}

// ── AND THE WAY BACK ────────────────────────────────────────────────────────
// Restores supplier_was on exactly the rows carrying this merge id. A row she
// typed herself cannot carry one, so this cannot un-rename anything else.
async function undo(mergeId) {
    if (!mergeId) throw new Error('which merge? a merge id is required');
    let restored = 0;
    // Every field's stores, because a merge id names one field but the caller
    // only has the id — and walking the wrong store is harmless (nothing
    // there carries this id) while missing the right one is not.
    const seen = new Set();
    const all = [];
    for (const k of FIELD_KEYS) {
        for (const t of targetsFor(k)) {
            const sig = `${t.file}|${t.field}`;
            if (seen.has(sig)) continue;
            seen.add(sig);
            all.push(t);
        }
    }
    for (const t of all) {
        await mutateJson(t.file, t.shape === 'array' ? [] : {}, (raw) => {
            const each = (row) => {
                if (!row) return;
                // The per-field stamps.
                const marks = (row.name_merge && typeof row.name_merge === 'object') ? row.name_merge : null;
                if (marks) {
                    for (const f of Object.keys(marks)) {
                        if (marks[f] !== mergeId) continue;
                        // Only the store that actually holds THIS field.
                        if (!targetsFor(f).some((x) => x.file === t.file && x.field === t.field)) continue;
                        const was = row.name_was && row.name_was[f];
                        if (was !== undefined) { row[t.field] = was; delete row.name_was[f]; }
                        delete row.name_merge[f];
                        restored += 1;
                    }
                    if (row.name_was && !Object.keys(row.name_was).length) delete row.name_was;
                    if (row.name_merge && !Object.keys(row.name_merge).length) delete row.name_merge;
                }
                // ── AND THE STAMPS supplierMerge.js LEFT BEHIND ──────────
                // A supplier merge run before this became field-scoped wrote a
                // flat supplier_was/supplier_merge pair. Undo has to keep
                // working for it, or shipping this refactor would strand every
                // merge she had already done.
                if (row.supplier_merge === mergeId) {
                    const isSupplierStore = targetsFor('supplier')
                        .some((x) => x.file === t.file && x.field === t.field);
                    if (isSupplierStore) {
                        if (row.supplier_was !== undefined) { row[t.field] = row.supplier_was; delete row.supplier_was; }
                        delete row.supplier_merge;
                        restored += 1;
                    }
                }
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
    const done = new Set();
    for (const k of FIELD_KEYS) {
        for (const t of targetsFor(k)) {
            const sig = `${t.file}|${t.field}`;
            if (done.has(sig)) continue;
            done.add(sig);
            for (const row of rowsOf(t)) {
                if (!row) continue;
                // ── ONLY THE STAMPS THIS STORE ACTUALLY HOLDS ────────
                // bills.json is visited once per field — supplier, carrier
                // and trucker all live in it — and every visit can see every
                // stamp on the row. Counting them all each time reported a
                // one-row merge as three.
                const mine = (f) => targetsFor(f).some((x) => x.file === t.file && x.field === t.field);
                const marks = [];
                if (row.name_merge && typeof row.name_merge === 'object') {
                    for (const f of Object.keys(row.name_merge)) {
                        if (FIELDS[f] && mine(f)) marks.push([f, row.name_merge[f]]);
                    }
                }
                if (row.supplier_merge && mine('supplier')) marks.push(['supplier', row.supplier_merge]);
                for (const [f, id] of marks) {
                    if (!id) continue;
                    const m = seen.get(id) || { merge_id: id, field: f, label: (FIELDS[f] || {}).label || f,
                                                rows: 0, stores: {} };
                    m.rows += 1;
                    m.stores[t.key] = (m.stores[t.key] || 0) + 1;
                    seen.set(id, m);
                }
            }
        }
    }
    return [...seen.values()].sort((a, b) => String(b.merge_id).localeCompare(String(a.merge_id)));
}

module.exports = { FIELDS, FIELD_KEYS, targetsFor, usage, clusters, proposals, plan, apply, undo,
                   merges, aliases, addAlias, removeAlias, aliasMap, resolveAlias, ALIAS_FILE };
