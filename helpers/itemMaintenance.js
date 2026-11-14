// ── helpers/itemMaintenance.js — Edge Yard item clean-up ────────────────────
//
// Apsara, 2026-11-14: "reg edge yard, there should be a item maintenance, like
// clean items. i want to filter by items and then if i want to change names,
// like rotor and rotors."  Asked how far it reaches, she chose: rewrite the OLD
// Edge Yard loads too, Edge Yard only.
//
// WHAT IT CHANGES — the item NAME on each line, nothing else.
//   Never touches weights, prices, status, seller signature or issued PDFs'
//   links. That is why this does NOT go through editLoad(): editLoad resets the
//   PDF links, the signature and the status to 'open' (it is built for an edit
//   that changes the numbers). A rename changes no number, so those must stay.
//   Already-issued PDFs keep the wording they were issued with.
//
// WHERE — inbound loads AND outbound loads AND open load drafts, together.
//   helpers/stock.js nets inbound against outbound by item name. Renaming only
//   one side would leave "rotor" shipped with nothing purchased: stock goes
//   negative and stockGuard starts refusing sales. So the sides move as one.
//
// WHAT IT DOES NOT TOUCH — Edge Metals (bills, sales, proformas), the selling
//   catalogue (tradeCatalog), and item aliases (those pairs are her recorded
//   decisions; a rename does not rewrite them).
//
// SAFETY — nothing is merged by resemblance: the caller names the exact old and
//   new text. Every apply writes a journal entry first-hand (before text per
//   line), and undo restores a line only if it still reads the new text, so a
//   later edit by her is never overwritten.
const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

const STORES = [
    { key: 'inbound',  label: 'loads bought',  file: () => cfg.LOADS_FILE },
    { key: 'outbound', label: 'loads shipped', file: () => cfg.OUTBOUND_LOADS_FILE },
    { key: 'drafts',   label: 'open drafts',   file: () => cfg.LOAD_DRAFTS_FILE },
];

const keyOf = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toLowerCase();
const clean = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ');
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : parseFloat(v) || 0);

function rowsOf(store) {
    const data = loadJson(store.file(), []);
    return Array.isArray(data) ? data : [];
}

// Every item name in use, with how much of it each side holds. Filter by `q`
// (case-insensitive substring over any spelling).
function summary({ q } = {}) {
    const want = keyOf(q);
    const groups = new Map();
    for (const store of STORES) {
        for (const load of rowsOf(store)) {
            const seen = new Set();
            for (const it of (Array.isArray(load && load.items) ? load.items : [])) {
                const raw = clean(it && it.description);
                if (!raw) continue;
                const k = keyOf(raw);
                if (want && !k.includes(want)) continue;
                if (!groups.has(k)) groups.set(k, { key: k, spellings: new Map(), inbound: { loads: 0, lines: 0, weight: 0 }, outbound: { loads: 0, lines: 0, weight: 0 }, drafts: { loads: 0, lines: 0, weight: 0 } });
                const g = groups.get(k);
                g.spellings.set(raw, (g.spellings.get(raw) || 0) + 1);
                const side = g[store.key];
                side.lines += 1;
                side.weight += num(it.net_weight);
                if (!seen.has(k)) { seen.add(k); side.loads += 1; }
            }
        }
    }
    return [...groups.values()].map((g) => {
        const sp = [...g.spellings.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
        return { name: sp[0], spellings: sp, inbound: g.inbound, outbound: g.outbound, drafts: g.drafts };
    }).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

// `from` may be one name or a list (several items chosen at once, all becoming
// `to` — 2026-11-14: "what if i want to choose multiple items and rename").
function check(from, to) {
    const list = (Array.isArray(from) ? from : [from]).map(clean).filter(Boolean);
    const t = clean(to);
    if (!list.length) throw new Error('the item to rename is required');
    if (!t) throw new Error('the new item name is required');
    if (t.length > 80) throw new Error('the new item name is too long (80 characters at most)');
    if (list.length > 50) throw new Error('too many items at once (50 at most)');
    const keys = new Set(list.map(keyOf));
    // Choosing only the name it already has changes nothing. Several items where
    // one already reads exactly `t` is fine: the others become it.
    if (list.length === 1 && list[0] === t) throw new Error('the new name is the same as the old one');
    return { list: [...new Set(list)], t, keys };
}

// What a rename WOULD do. Writes nothing.
function preview(from, to) {
    const { list, t, keys } = check(from, to);
    const tk = keyOf(t);
    const out = { from: list.length === 1 ? list[0] : list, froms: list, to: t, merges_into_existing: false, stores: {}, total_lines: 0 };
    for (const store of STORES) {
        let loads = 0, lines = 0, weight = 0; const ids = [];
        for (const load of rowsOf(store)) {
            let hit = false;
            for (const it of (Array.isArray(load && load.items) ? load.items : [])) {
                const k = keyOf(it && it.description);
                if (!keys.has(k)) continue;
                if (clean(it.description) === t && it.description === t) continue;   // already exactly the target
                lines += 1; weight += num(it.net_weight); hit = true;
            }
            if (hit) { loads += 1; if (ids.length < 12) ids.push(load.id); }
        }
        out.stores[store.key] = { label: store.label, loads, lines, weight, sample_ids: ids };
        out.total_lines += lines;
    }
    // "Becomes one item" when several are chosen, or the new name already exists
    // as an item that was not chosen.
    const existing = summary({}).some((x) => keyOf(x.name) === tk && !keys.has(tk));
    out.merges_into_existing = existing || keys.size > 1;
    return out;
}

// Do it. Item name only. The journal is written in the same pass as each file
// change, per file; undo() reads it.
async function apply(from, to, { by = null, catalog = true } = {}) {
    const { list, t, keys } = check(from, to);
    const entry = { id: `REN_${Date.now().toString(36)}`, at: new Date().toISOString(), by, from: list.length === 1 ? list[0] : list, to: t, undone: false, changes: [] };
    const months = new Set();   // YYYY-MM of every load changed, so the Drive sheets can be rebuilt for them
    for (const store of STORES) {
        await mutateJson(store.file(), [], (data) => {
            if (!Array.isArray(data)) return data;
            for (const load of data) {
                if (!load || !Array.isArray(load.items)) continue;
                load.items.forEach((it, i) => {
                    if (it && keys.has(keyOf(it.description)) && it.description !== t) {
                        entry.changes.push({ store: store.key, load_id: load.id, line: i, before: it.description });
                        months.add(String(load.date || '').slice(0, 7));
                        it.description = t;
                    }
                });
            }
            return data;
        }, { strict: true });
    }
    // The yard's own pick-list (item_types.json), so the old spellings are not
    // offered again. Only entries that match; absent is fine.
    let catalogRenamed = false;
    if (catalog && entry.changes.length) {
        for (const f of list) {
            if (f === t) continue;
            try { const r = await require('./itemTypes').renameItemType(f, t); catalogRenamed = catalogRenamed || !!r.renamed; }
            catch (_) { /* the list is a convenience; the loads are what matter */ }
        }
    }
    entry.catalog_renamed = catalogRenamed;
    await mutateJson(cfg.ITEM_RENAMES_FILE, [], (l) => { l.push(entry); return l; }, { strict: true });
    return { id: entry.id, from: entry.from, to: t, lines: entry.changes.length, catalog_renamed: catalogRenamed, months: [...months].filter(Boolean) };
}

// Put a rename back. A line is restored only if it still reads the new text.
async function undo(id) {
    const journal = loadJson(cfg.ITEM_RENAMES_FILE, []);
    const entry = (Array.isArray(journal) ? journal : []).find((e) => e.id === id);
    if (!entry) throw new Error('rename not found');
    if (entry.undone) throw new Error('that rename was already undone');
    let restored = 0, skipped = 0;
    const months = new Set();
    for (const store of STORES) {
        const mine = entry.changes.filter((c) => c.store === store.key);
        if (!mine.length) continue;
        await mutateJson(store.file(), [], (data) => {
            if (!Array.isArray(data)) return data;
            for (const c of mine) {
                const load = data.find((l) => l && l.id === c.load_id);
                const it = load && Array.isArray(load.items) ? load.items[c.line] : null;
                if (it && keyOf(it.description) === keyOf(entry.to) && it.description === entry.to) { it.description = c.before; restored += 1; months.add(String(load.date || '').slice(0, 7)); }
                else skipped += 1;
            }
            return data;
        }, { strict: true });
    }
    await mutateJson(cfg.ITEM_RENAMES_FILE, [], (list) => {
        const e = list.find((x) => x.id === id);
        if (e) { e.undone = true; e.undone_at = new Date().toISOString(); }
        return list;
    }, { strict: true });
    return { id, restored, skipped, months: [...months].filter(Boolean) };
}

function history() {
    const j = loadJson(cfg.ITEM_RENAMES_FILE, []);
    return (Array.isArray(j) ? j : []).slice().reverse().slice(0, 30)
        .map((e) => ({ id: e.id, at: e.at, from: Array.isArray(e.from) ? e.from.join(' + ') : e.from, to: e.to, lines: e.changes.length, undone: !!e.undone }));
}

module.exports = { summary, preview, apply, undo, history, keyOf };
