// ── helpers/itemTypes.js ─ the item-description catalog (source of truth)
//
// HISTORY, because the shape of this file changed meaningfully twice:
//
// 2026-08-15 (Apsara: "in summary, instead of showing other, description
// should be there. when something gets added in others, it should get added
// to existing list of description.") — this file was created to hold ONLY
// the descriptions typed through the dropdown's "Others…" escape hatch. The
// eleven common scrap-yard types lived in a hardcoded ITEM_DESC_OPTIONS_BASE
// array inside each client, and each client merged the two lists itself.
//
// 2026-08-20 (Apsara: "in description of item detail, keep the list in
// backend") — that split is gone. The hardcoded client array is seeded into
// this file once (see seedBaseTypes below) and from then on this JSON file is
// the ONE list. The clients now render exactly what GET /api/item-types
// returns and merge nothing.
//
// Why the merge had to go, beyond "she asked": a description that lived only
// in client source could not be renamed or deleted at all — the Settings
// list could only manage the custom half, so "Al rims(Dirty)" was permanent
// and untouchable in a way nothing in the UI explained. And the two clients
// each carried their own copy of the array, so they could (and did) drift.
//
// Still deliberately a flat array of strings, not records with ids. A load
// item stores its description AS TEXT (see helpers/loads.js) — this catalog
// is a convenience list for typing, not a foreign key. That is why deleting
// an entry here cannot orphan anything, and why renaming one does NOT
// rewrite the loads that already used the old text (see renameItemType).
const fs = require('fs');
const path = require('path');
const { loadJson, mutateJson } = require('./json');
const cfg = require('../config');

// The eleven types that used to be hardcoded in both clients as
// ITEM_DESC_OPTIONS_BASE. Kept here ONLY as first-run seed data — nothing
// reads this array at runtime, and it is deliberately not treated as
// "built in" or protected afterwards. Once seeded, these are ordinary
// entries Apsara can rename or delete like any other.
const BASE_SEED = [
    'Auto cast', 'Al rims(Dirty)', 'Mixed', 'Chrome', 'Sealed units', 'Motors',
    'Al combo', 'Steel combo', 'Alternator', 'Ac compressor', 'Starter',
];

// Seeds BASE_SEED exactly once, then drops a marker file next to the
// catalog so it never runs again.
//
// The marker is what makes this safe to call on every read. Seeding on "is
// the list empty?" would look identical on day one and then resurrect all
// eleven entries the moment someone deleted the last one — a delete button
// that silently undoes itself is worse than no delete button. Permanence is
// the whole point of the feature Apsara asked for.
//
// WRITTEN SYNCHRONOUSLY, deliberately, and this is the second attempt:
// the first version used saveJson()/saveSettings(), which await a file lock
// and therefore return BEFORE the bytes land. loadCustomItemTypes() is a
// synchronous function, so the very first GET /api/item-types came back
// empty — an operator opening the app on a fresh install would have seen a
// blank description list, with the entries appearing only on the next
// request. Caught in testing; worth remembering that "call the async writer
// and don't await it" is silently wrong in any sync code path.
//
// Marker is its own file rather than a settings.json flag on purpose:
// settings.json is a large shared object written by several other paths,
// and a synchronous unlocked write to it could clobber a concurrent one.
// A dedicated marker touches nothing else.
const SEED_MARKER = `${cfg.ITEM_TYPES_FILE}.seeded`;

// tmp + rename, same as helpers/json.js's writers — a crash mid-write
// leaves the previous file intact rather than a truncated one.
function writeSync(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.seedtmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
}

let seedChecked = false;
function seedBaseTypes() {
    if (seedChecked) return;
    try {
        if (fs.existsSync(SEED_MARKER)) { seedChecked = true; return; }
        const existing = loadJson(cfg.ITEM_TYPES_FILE, []);
        const lower = existing.map((d) => String(d).toLowerCase());
        const missing = BASE_SEED.filter((d) => !lower.includes(d.toLowerCase()));
        if (missing.length) writeSync(cfg.ITEM_TYPES_FILE, existing.concat(missing));
        // Marker written LAST: if the process dies between the two writes,
        // the next boot re-runs a seed that's already idempotent (missing
        // is computed against what's there) rather than skipping a seed
        // that never happened.
        fs.mkdirSync(path.dirname(SEED_MARKER), { recursive: true });
        fs.writeFileSync(SEED_MARKER, new Date().toISOString(), 'utf8');
        seedChecked = true;
        console.log(`[ITEM-TYPES] Seeded ${missing.length} base description(s) into the catalog.`);
    } catch (e) {
        // Left unset so a later call retries — a failed seed shouldn't
        // permanently strand the catalog empty.
        console.error('[ITEM-TYPES] Seed failed (non-fatal):', e.message);
    }
}

// Sorted A–Z on the way out, per Apsara 2026-08-19 ("rearrange the
// description list based on asc") and again 2026-08-20 ("sort the list to
// asc"). Sorting HERE rather than in each client means the order can't
// differ between the phone and the dashboard, and any future consumer
// (PDF, sheet export, WhatsApp) gets the same order for free.
//
// sensitivity:'base' so the sort ignores case and accents — otherwise an
// entry typed "battery" sorts into a separate block from "Battery" and
// reads as a duplicate to anyone scanning the list.
function loadCustomItemTypes() {
    seedBaseTypes();
    return loadJson(cfg.ITEM_TYPES_FILE, [])
        .slice()
        .sort((a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: 'base' }));
}

// Case-insensitive dedup against whatever's already stored — does NOT
// dedup against the base ITEM_DESC_OPTIONS list, since that list lives
// client-side only and this file has no way to see it; the client is
// responsible for checking both lists before deciding a description is
// genuinely new (see dashboard/index.html's save handler).
async function addCustomItemType(description) {
    const clean = String(description || '').trim();
    if (!clean) throw new Error('description is required');
    seedBaseTypes(); // so a first-ever add doesn't land in an unseeded file
    let added = false;
    await mutateJson(cfg.ITEM_TYPES_FILE, [], (list) => {
        const exists = list.some((d) => String(d).toLowerCase() === clean.toLowerCase());
        if (!exists) { list.push(clean); added = true; }
        return list;
    });
    return { description: clean, added };
}

// Removes a custom description (case-insensitive match). Only ever touches
// this file's own list — the base ITEM_DESC_OPTIONS presets aren't stored
// here, so there's nothing to accidentally delete on that side, and this
// never rewrites any load that already used the description; it just stops
// it appearing as a preset option on the NEXT load's dropdown. Per Apsara
// 2026-08-16: "if i want to delete the newly added description via others".
async function deleteCustomItemType(description) {
    const clean = String(description || '').trim();
    if (!clean) throw new Error('description is required');
    let removed = false;
    await mutateJson(cfg.ITEM_TYPES_FILE, [], (list) => {
        const next = list.filter((d) => {
            const match = String(d).toLowerCase() === clean.toLowerCase();
            if (match) removed = true;
            return !match;
        });
        return next;
    });
    return { description: clean, removed };
}

// Rename an entry in place (Apsara 2026-08-20: "give this option to
// modify/delete the list"). Case-insensitive match on the old text.
//
// IMPORTANT AND DELIBERATE: this rewrites the CATALOG ONLY. Loads that
// already used the old description keep it, and their PDFs keep it, and
// the monthly sheets keep it. That is not an oversight — a description on
// a saved load is part of a document that was already shown to a seller
// and possibly already paid against. Renaming a convenience list must not
// silently reword history. Fixing a typo therefore changes what FUTURE
// loads can pick, and old loads still read the way they were signed.
async function renameItemType(from, to) {
    const oldName = String(from || '').trim();
    const newName = String(to || '').trim();
    if (!oldName) throw new Error('the description to rename is required');
    if (!newName) throw new Error('the new description is required');
    seedBaseTypes();
    let renamed = false;
    let conflict = false;
    await mutateJson(cfg.ITEM_TYPES_FILE, [], (list) => {
        const idx = list.findIndex((d) => String(d).toLowerCase() === oldName.toLowerCase());
        if (idx === -1) return list;
        // Renaming onto a name that already exists would leave two identical
        // entries in the list. Collapse instead of duplicating: drop the old
        // row and keep the one that was already there.
        const clashIdx = list.findIndex((d, i) => i !== idx && String(d).toLowerCase() === newName.toLowerCase());
        if (clashIdx !== -1) {
            list.splice(idx, 1);
            conflict = true;
            renamed = true;
            return list;
        }
        list[idx] = newName;
        renamed = true;
        return list;
    });
    return { from: oldName, to: newName, renamed, merged: conflict };
}

module.exports = {
    loadCustomItemTypes, addCustomItemType, deleteCustomItemType, renameItemType,
    // Exported for tests/diagnostics only — nothing in the app reads this.
    BASE_SEED,
};
