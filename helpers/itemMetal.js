// ── helpers/itemMetal.js ─ ferrous / non-ferrous, learned per item name ─────
//
// Apsara, 2026-11-17: "edge yard should able to segregate ferrous and non
// ferrous" and "when you type an item, as soon as they move to next box, ask
// them whether it is ferrous or non-ferrous". Chosen with her: asked on the
// website and the phone app, loads and sales; once per item NAME, then
// remembered; the person typing must pick one.
//
// WHERE "must pick one" IS ENFORCED, and where it is not. The two apps
// enforce it on the form. This module does NOT make the server refuse an item
// with no type, on purpose: items also arrive through paths with no form to
// put a question on — Scout and Jarvis recording a load by voice or chat,
// loads already on file, an older phone app that has not updated. Rejecting
// those would repeat the 2026-09-17 break where a rule added to shared code
// stopped "record a wire payment" working for the one caller with no box for
// the answer (CLAUDE.md rule 1). Instead, an item that arrives without a type
// is given the one already learned for its name, if there is one; otherwise it
// is stored untyped and shows as "Unsorted" until someone sets it.
//
// The learned map is keyed by the description with case, spaces and
// punctuation removed, so "Al rims (Dirty)" and "al rims(dirty)" are the same
// item. It is NOT the alias feature (helpers/itemAliases.js): two different
// names are never merged here. Edge Yard only; Edge Metals items are untouched.
const { loadJson, mutateJson } = require('./json');
const path = require('path');
const cfg = require('../config');

const FERROUS = 'ferrous';
const NON_FERROUS = 'non-ferrous';
const TYPES = [FERROUS, NON_FERROUS];

const FILE = () => cfg.ITEM_METAL_FILE || path.join(cfg.DATA_DIR || path.join(__dirname, '..', 'data'), 'item-metal-types.json');

// 'Ferrous', 'non ferrous', 'NonFerrous', 'nf' ... -> one of the two codes, else null.
// Anything else is null, never a guess: an unrecognised value is stored as
// "no type", not as ferrous.
function normType(v) {
    const s = String(v == null ? '' : v).trim().toLowerCase().replace(/[^a-z]/g, '');
    if (s === 'ferrous' || s === 'f') return FERROUS;
    if (s === 'nonferrous' || s === 'nf' || s === 'nonferous') return NON_FERROUS;
    return null;
}

const keyOf = (desc) => String(desc == null ? '' : desc).toLowerCase().replace(/[^a-z0-9]/g, '');

function all() {
    const m = loadJson(FILE(), {});
    return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {};
}

function typeOf(desc) {
    const k = keyOf(desc);
    return k ? (normType(all()[k]) || null) : null;
}

// Gives each item the type it was sent with, else the learned one, else null.
// Pure apart from reading the map; never throws (a missing or corrupt map
// means "no learned types", which only costs an extra question).
function fill(items) {
    if (!Array.isArray(items)) return items;
    let map = {};
    try { map = all(); } catch (e) { map = {}; }
    return items.map((it) => {
        if (!it || typeof it !== 'object') return it;
        const own = normType(it.metal_type);
        const learned = own ? null : normType(map[keyOf(it.description)]);
        return { ...it, metal_type: own || learned || null };
    });
}

async function remember(desc, type) {
    const t = normType(type);
    const k = keyOf(desc);
    if (!t || !k) return false;
    await mutateJson(FILE(), {}, (m) => { const o = (m && typeof m === 'object' && !Array.isArray(m)) ? m : {}; o[k] = t; return o; });
    return true;
}

// Learns from saved items. Best effort: a failure here must never fail a save.
async function learnFromItems(items) {
    try {
        for (const it of (Array.isArray(items) ? items : [])) {
            if (it && normType(it.metal_type) && keyOf(it.description)) await remember(it.description, it.metal_type);
        }
    } catch (e) { console.error('[itemMetal] could not remember item types:', e.message); }
}

module.exports = { TYPES, FERROUS, NON_FERROUS, normType, keyOf, all, typeOf, fill, remember, learnFromItems };
