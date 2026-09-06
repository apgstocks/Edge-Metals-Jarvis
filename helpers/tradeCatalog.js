// ── helpers/tradeCatalog.js — what Edge Metals SELLS, in selling words ────
//
// Apsara, 2026-09-07: "maintain a separate catalogue for edge metals. keep on
// appending to that new catalogue as i generate proforma and keep the
// existing workflow catalogue for yard."
//
// TWO CATALOGUES, BECAUSE THEY ARE TWO VOCABULARIES
// -------------------------------------------------
// data/item_types.json is the YARD's list — "Auto cast", "Al rims(Dirty)",
// "Sealed units". It is what gets typed on a load ticket when a truck is
// weighed in, and it is deliberately terse because someone is standing at a
// scale with a phone.
//
// A proforma is read by a buyer's accounts department in Busan, and it says
// "Aluminium Auto Casting Scrap". Same metal, different document, different
// audience. Merging the two lists would mean either the yard picking from a
// dropdown full of export phrasing, or the export documents carrying yard
// shorthand — and I had already caused the second half of that by printing
// her catalog spelling on a customer's document.
//
// So this file is a SECOND, APPEND-ONLY list, filled from the descriptions
// that have actually gone out on proformas. Nothing here touches
// helpers/itemTypes.js, GET /api/item-types, or the load form.
//
// WHY APPEND-ONLY, AND WHY FROM GENERATION
// ----------------------------------------
// She said "keep on appending as i generate proforma", and the important word
// is GENERATE. A description that was typed into a draft and abandoned is not
// vocabulary; one that went on a document a customer received is. So the hook
// sits in proformaPricing.recordFromGeneration, which is called from BOTH
// generation paths — the Documents page and the WhatsApp/voice flow — and
// from nowhere else. One hook, two callers, nothing to keep in step.
//
// Entries are never removed automatically. remove() and rename() exist for
// when she wants to tidy a typo, and are hers to call; nothing in the
// automatic path deletes anything, because a description that has been sent
// to a customer is a fact about a document that exists.
const { loadJson, mutateJson } = require('./json');
const cfg = require('../config');

// Deliberately NO seed list. itemTypes.js carries eleven hardcoded yard types
// as first-run seed data; this one starts genuinely empty and fills from her
// real documents. Seeding it with my guesses at export phrasing would be the
// hardcoded-vocabulary mistake this whole week has been about — and unlike
// the yard list, there is no legacy client array to migrate.
function list() {
    return loadJson(cfg.TRADE_CATALOG_FILE, [])
        .slice()
        .sort((a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: 'base' }));
}

// Case-insensitive, whitespace-normalised dedup. "Aluminium Auto Casting
// Scrap" and "aluminium  auto casting scrap" are the same entry; the FIRST
// spelling wins, because that is the one already on a document somewhere.
const key = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

async function add(description) {
    const clean = String(description || '').trim().replace(/\s+/g, ' ');
    // A blank, a bare number, or a lone unit is not a description. These do
    // reach here — a proforma line can carry an empty desc — and an entry of
    // "21" in the catalogue would poison every later match.
    if (!clean || clean.length < 2) return { description: clean, added: false, why: 'too short' };
    if (/^[\d.,]+$/.test(clean)) return { description: clean, added: false, why: 'numeric' };
    if (clean.length > 120) return { description: clean, added: false, why: 'too long' };

    let added = false;
    await mutateJson(cfg.TRADE_CATALOG_FILE, [], (arr) => {
        const seen = new Set(arr.map(key));
        if (!seen.has(key(clean))) { arr.push(clean); added = true; }
        return arr;
    });
    if (added) console.log(`[TRADE-CATALOG] learned "${clean}"`);
    return { description: clean, added };
}

// One write, not one per item. A proforma with four line items used to mean
// four sequential lock-acquire-write cycles on the same file, which is both
// slow and a way to lose an entry to a lost update.
async function addMany(descriptions) {
    const cleaned = (descriptions || [])
        .map((d) => String(d || '').trim().replace(/\s+/g, ' '))
        .filter((d) => d && d.length >= 2 && d.length <= 120 && !/^[\d.,]+$/.test(d));
    if (!cleaned.length) return { added: [] };

    const added = [];
    await mutateJson(cfg.TRADE_CATALOG_FILE, [], (arr) => {
        const seen = new Set(arr.map(key));
        for (const d of cleaned) {
            if (seen.has(key(d))) continue;
            // Added to `seen` as well as to `arr`, so two spellings of the
            // SAME new description inside ONE proforma collapse to one entry.
            // Checking only against what was already on file would let a
            // single document add "Zorba 95/5" and "zorba 95/5" together.
            seen.add(key(d));
            arr.push(d);
            added.push(d);
        }
        return arr;
    });
    if (added.length) console.log(`[TRADE-CATALOG] learned ${added.length}: ${added.join(', ')}`);
    return { added };
}

// Hers to call when a typo goes in. Never called from the generation path —
// see the header.
async function remove(description) {
    const k = key(description);
    let removed = false;
    await mutateJson(cfg.TRADE_CATALOG_FILE, [], (arr) => {
        const out = arr.filter((d) => {
            const hit = key(d) === k;
            if (hit) removed = true;
            return !hit;
        });
        return out;
    });
    return { description, removed };
}

async function rename(from, to) {
    const k = key(from);
    const clean = String(to || '').trim().replace(/\s+/g, ' ');
    if (!clean) throw new Error('the new description is required');
    let renamed = false;
    await mutateJson(cfg.TRADE_CATALOG_FILE, [], (arr) => arr.map((d) => {
        if (key(d) !== k) return d;
        renamed = true;
        return clean;
    }));
    // Renaming here does NOT rewrite the proformas that already used the old
    // text — same contract as itemTypes.renameItemType. This list is a
    // convenience for recognition, not a foreign key, and a document that has
    // been sent says what it said.
    return { from, to: clean, renamed };
}

module.exports = { list, add, addMany, remove, rename, key };
