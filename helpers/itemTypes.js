// ── helpers/itemTypes.js — self-growing list of custom item-type descriptions
// Per Apsara 2026-08-15: "in summary, instead of showing other, description
// should be there. when something gets added in others, it should get added
// to existing list of description." The dashboard/mobile load form's item
// description field is a dropdown of common scrap-yard item types
// (ITEM_DESC_OPTIONS, hardcoded client-side) plus an "Others…" escape hatch
// that reveals a free-text box. Typing something new into that box already
// stores the real text as the item's description (never the literal word
// "Others" — see dashboard/index.html's syncItemsFromDom) — but that custom
// text was never added back to the dropdown, so reusing the same
// description on a later load meant retyping it via "Others…" every time.
// This file is the small persisted list that closes that loop: a flat array
// of strings in data/item_types.json, same "small dataset, let the client
// merge/filter" shape as helpers/addressBook.js's loadAddressBook().
const { loadJson, mutateJson } = require('./json');
const cfg = require('../config');

function loadCustomItemTypes() {
    return loadJson(cfg.ITEM_TYPES_FILE, []);
}

// Case-insensitive dedup against whatever's already stored — does NOT
// dedup against the base ITEM_DESC_OPTIONS list, since that list lives
// client-side only and this file has no way to see it; the client is
// responsible for checking both lists before deciding a description is
// genuinely new (see dashboard/index.html's save handler).
async function addCustomItemType(description) {
    const clean = String(description || '').trim();
    if (!clean) throw new Error('description is required');
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

module.exports = { loadCustomItemTypes, addCustomItemType, deleteCustomItemType };
