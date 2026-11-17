// ── helpers/partyMaintenance.js — Edge Yard supplier and buyer name clean-up ──────────────────────
// Apsara, 2026-11-14: "What if i want to clean the supplier/buyer names in similar way" (as Item maintenance),
// then "yes" to: Edge Yard only, suppliers and buyers together on one screen, with preview, multi-select, undo
// and a Drive-sheet refresh.
//
// IT IS A THIN LAYER OVER helpers/nameCleanup.js, ON PURPOSE. That engine already rewrites a name across every
// store that carries it in one operation, keeps each row's original spelling (name_was), stamps a merge id, and
// undoes by that id. Two kinds here, each one engine field:
//     supplier -> 'seller'  (yard loads, load drafts, prepayments, which move TOGETHER so an advance is not orphaned)
//     buyer    -> 'buyer'   (yard sales; a payment received points at the sale by id, so nothing else follows)
//
// WHAT IS DIFFERENT FROM THE LEDGER SCREEN'S CLEAN-UP: she names the exact spellings and the exact new name.
// Nothing is merged by resemblance, and no alias is written (an alias would quietly change what the Edge Metals
// screens propose later). The engine's own winner-by-votes is bypassed: the name she typed wins.
//
// WHAT IT DOES NOT TOUCH: Edge Metals (bills, sales, bookings), issued PDFs, the address book. Edge Yard and Edge
// Metals are different companies; the two engine fields used here list only Edge Yard stores (tested).
const nc = require('./nameCleanup');
const { normalizeName } = require('./nameMatch');

const KINDS = { supplier: 'seller', buyer: 'buyer' };
const clean = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ');
const fieldOf = (kind) => {
    const f = KINDS[kind];
    if (!f) throw new Error(`kind must be one of ${Object.keys(KINDS).join(', ')}`);
    return f;
};

function rowsOf(t) {
    const { loadJson } = require('./json');
    const raw = loadJson(t.file, t.shape === 'array' ? [] : {});
    return t.shape === 'array' ? (Array.isArray(raw) ? raw : []) : (raw && typeof raw === 'object' ? Object.values(raw) : []);
}

/** Every spelling in use for a kind, newest-first friendly, optionally filtered by a substring. */
function summary(kind, { q } = {}) {
    const field = fieldOf(kind);
    const needle = clean(q).toLowerCase();
    const list = nc.usage(field)
        .filter((u) => !needle || u.name.toLowerCase().includes(needle) || normalizeName(u.name).includes(normalizeName(needle)))
        .map((u) => ({ name: u.name, rows: u.total, by: u.by, newest: u.newest || null }))
        .sort((a, b) => a.name.localeCompare(b.name));
    return list;
}

function checked(kind, from, to) {
    const field = fieldOf(kind);
    const names = (Array.isArray(from) ? from : [from]).map(clean).filter(Boolean);
    const target = clean(to);
    if (!names.length) throw new Error('say which names to change');
    if (!target) throw new Error('say what the new name should be');
    const inUse = new Map(nc.usage(field).map((u) => [u.name, u]));
    const unknown = names.filter((n) => !inUse.has(n));
    if (unknown.length) throw new Error(`not found in the saved records: ${unknown.join(', ')}`);
    const moving = [...new Set(names)].filter((n) => n !== target);
    return { field, moving, target, inUse };
}

/** What a rename would change, before it changes anything. */
function preview(kind, from, to) {
    const { field, moving, target, inUse } = checked(kind, from, to);
    const byStore = {};
    let total = 0;
    for (const n of moving) for (const [k, c] of Object.entries(inUse.get(n).by)) { byStore[k] = (byStore[k] || 0) + c; total += c; }
    const targetInUse = inUse.has(target) || [...inUse.keys()].some((n) => normalizeName(n) === normalizeName(target));
    return { kind, field, to: target, from: moving, total, byStore, merges_into_existing: targetInUse,
             labels: Object.fromEntries(nc.targetsFor(field).map((t) => [t.key, t.label])) };
}

/** Do it: one operation across every store for the kind, undoable by merge_id. Returns the months touched too. */
async function apply(kind, from, to, { by } = {}) {
    const { field, moving, target } = checked(kind, from, to);
    if (!moving.length) return { kind, field, changed: 0, byStore: {}, merge_id: null, months: [] };
    const set = new Set(moving);
    const months = new Set();
    for (const t of nc.targetsFor(field)) {
        for (const row of rowsOf(t)) {
            if (!row || !set.has(String(row[t.field] == null ? '' : row[t.field]).trim())) continue;
            const d = String(row.date || row.paid_on || '').slice(0, 7);
            if (/^\d{4}-\d{2}$/.test(d)) months.add(d);
        }
    }
    const merge_id = `mrg_${field}_${new Date().toISOString().replace(/[:.]/g, '-')}`;
    // The engine's apply() renames every loser spelling to the winner across all stores for the field.
    const out = await nc.apply({ field, merge_id, clusters: [{ winner: target, losers: moving.map((name) => ({ name })) }] });
    return { kind, ...out, to: target, by: by || null, months: [...months] };
}

async function undo(mergeId) {
    // Months first: after the undo the rows no longer say which merge they were in.
    const months = new Set();
    for (const f of Object.values(KINDS)) {
        for (const t of nc.targetsFor(f)) {
            for (const row of rowsOf(t)) {
                if (!row || !row.name_merge || row.name_merge[f] !== mergeId) continue;
                const d = String(row.date || row.paid_on || '').slice(0, 7);
                if (/^\d{4}-\d{2}$/.test(d)) months.add(d);
            }
        }
    }
    // Only the Edge Yard fields' stores are walked: an Edge Yard undo must not touch an Edge Metals ledger file.
    const restored = await nc.undo(mergeId, { fields: Object.values(KINDS) });
    return { restored, months: [...months] };
}

/** Recent merges for these two fields only (the engine lists every field's). */
function history(kind) {
    const fields = kind ? [fieldOf(kind)] : Object.values(KINDS);
    return nc.merges().filter((m) => fields.includes(m.field));
}

// ── "DID YOU MEAN ...?" WHILE A LOAD OR SALE IS BEING ENTERED ─────────────────
// Apsara, 2026-11-15: "Spelling variants as they type ask while creating load/sales that whether they mean this?"
// The same lookup the clean-up screen is built on, asked at the moment a name is typed. It only ever SUGGESTS: the
// caller shows the question and a Yes is the only thing that changes what she typed. nameMatch.js is deliberately not
// fuzzy ("a near-miss is a wrong answer with a confident face"), so nothing here picks a name for her.
//
// kind: 'purchase' (the seller) or 'sale' (the buyer); 'supplier' and 'buyer' are accepted too.
// known: true when the typed name already exists once spacing, case and punctuation are ignored: nothing to ask.
const SIMILAR_KINDS = { purchase: 'supplier', supplier: 'supplier', sale: 'buyer', buyer: 'buyer' };
const MAX_NAME = 120;
const wordsKey = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).sort().join(' ');

function lev(a, b) {
    if (a === b) return 0;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = cur;
    }
    return prev[b.length];
}

function similar(kind, name) {
    const k = SIMILAR_KINDS[kind];
    if (!k) throw new Error(`kind must be one of ${Object.keys(SIMILAR_KINDS).join(', ')}`);
    const typed = clean(name).slice(0, MAX_NAME);
    const tk = normalizeName(typed);
    if (!tk) return { known: true, suggestions: [] };
    const all = nc.usage(fieldOf(k));
    if (all.some((u) => normalizeName(u.name) === tk)) return { known: true, suggestions: [] };
    const tw = wordsKey(typed);
    const RANK = { order: 0, start: 1, spelling: 2 };
    const out = [];
    for (const u of all) {
        const uk = normalizeName(u.name);
        if (!uk) continue;
        const shortest = Math.min(tk.length, uk.length), longest = Math.max(tk.length, uk.length);
        const d = lev(tk, uk);
        let why = null;
        if (tw && wordsKey(u.name) === tw) why = 'order';
        else if (shortest >= 4 && (uk.startsWith(tk) || tk.startsWith(uk))) why = 'start';
        else if (shortest >= 5 && d <= (longest >= 9 ? 2 : 1)) why = 'spelling';
        if (why) out.push({ name: u.name, rows: u.total, why, d });
    }
    out.sort((a, b) => RANK[a.why] - RANK[b.why] || b.rows - a.rows || a.d - b.d || a.name.localeCompare(b.name));
    return { known: false, suggestions: out.slice(0, 3).map(({ name: n, rows, why }) => ({ name: n, rows, why })) };
}

module.exports = { KINDS, summary, preview, apply, undo, history, similar };
