// ── helpers/claimKinds.js — the vocabulary of claim kinds, learned not fixed ──
//
// Apsara, 2026-09-26: "Thats why i said let ai decide dynamically."
//
// The first version had seven kinds hardcoded in a list and a pile of regexes
// deciding between them. That is the treadmill she rejected outright on
// 2026-08-20 — "I don't want to hardcode anything. Let AI decide. both are same
// meaning" — and it failed in exactly the predicted way: the keyword list read
// the commodity heading "ROTORS AND DRUMS" as contamination and mislabelled
// eleven containers that were ordinary weight shortages.
//
// So there is no list of kinds in the code. The model names the kind in its own
// words; this file is where those names accumulate, and the model is also what
// decides whether a new name MEANS THE SAME as one already in use — because
// "both are same meaning" is a judgement about meaning, which belongs to the
// model and not to a synonym table.
//
// The register still needs stable kinds to group and total by, so what is kept
// is a slug per kind, its label in her words, and how it was first described.
// Drift is made visible (the import prints every new kind it discovers) and
// fixable (kinds can be merged), rather than prevented by a fixed enum.
const cfg = require('../config');
const path = require('path');
const { loadJson, mutateJson } = require('./json');

const FILE = () => cfg.CLAIM_KINDS_FILE || path.join(cfg.DATA_DIR, 'claim_kinds.json');

// A slug is derived from the label, never chosen from a list.
function slugify(label) {
    return String(label == null ? '' : label).toLowerCase().trim()
        .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'unnamed';
}

function list() { return loadJson(FILE(), []) || []; }
function get(slug) { return list().find((k) => k && k.slug === slug) || null; }
function label(slug) {
    if (!slug) return 'not classified yet';
    const k = get(slug);
    return k ? k.label : String(slug).replace(/_/g, ' ');
}

// What the classifier is shown: the kinds already in use, so it can say "this is
// one of those" instead of inventing a near-duplicate.
function known() {
    return list().map((k) => ({ slug: k.slug, label: k.label, description: k.description || '' }));
}

// Record a kind the model has named. Returns { slug, created }.
async function ensure(labelText, description, by = 'ai') {
    const slug = slugify(labelText);
    const existing = get(slug);
    if (existing) {
        await mutateJson(FILE(), [], (all) => {
            const i = all.findIndex((k) => k && k.slug === slug);
            if (i >= 0) {
                all[i].count = (all[i].count || 0) + 1;
                all[i].last_seen = new Date().toISOString();
                if (!all[i].description && description) all[i].description = String(description).slice(0, 240);
            }
            return all;
        }, { strict: true });
        return { slug, created: false };
    }
    const rec = {
        slug,
        label: String(labelText || '').trim().slice(0, 60) || slug.replace(/_/g, ' '),
        description: String(description || '').slice(0, 240),
        named_by: by,
        count: 1,
        first_seen: new Date().toISOString(),
        last_seen: new Date().toISOString(),
    };
    await mutateJson(FILE(), [], (all) => { all.push(rec); return all; }, { strict: true });
    return { slug, created: true };
}

// Two names she considers the same thing. The losing slug is kept as an alias so
// nothing that already points at it becomes unreadable.
async function merge(fromSlug, intoSlug, by = 'manager') {
    if (fromSlug === intoSlug) throw new Error('those are the same kind');
    const into = get(intoSlug);
    if (!into) throw new Error(`there is no kind "${intoSlug}"`);
    const from = get(fromSlug);
    if (!from) throw new Error(`there is no kind "${fromSlug}"`);
    await mutateJson(FILE(), [], (all) => {
        const i = all.findIndex((k) => k && k.slug === intoSlug);
        if (i >= 0) {
            all[i].count = (all[i].count || 0) + (from.count || 0);
            all[i].aliases = [...new Set([...(all[i].aliases || []), fromSlug, ...(from.aliases || [])])];
            all[i].merged_by = by;
        }
        return all.filter((k) => k.slug !== fromSlug);
    }, { strict: true });
    return get(intoSlug);
}

async function rename(slug, newLabel, by = 'manager') {
    await mutateJson(FILE(), [], (all) => {
        const i = all.findIndex((k) => k && k.slug === slug);
        if (i >= 0) { all[i].label = String(newLabel || '').trim().slice(0, 60) || all[i].label; all[i].renamed_by = by; }
        return all;
    }, { strict: true });
    return get(slug);
}

// Colour is derived from the slug, not assigned per kind — a new kind gets a
// readable colour on the page the moment the model names it, with no CSS to add.
function hue(slug) {
    let h = 0;
    const s = String(slug || '');
    for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
}

// Not a cap on WHICH kinds exist — a drift alarm. Twenty-five different names
// for the same handful of arguments means the vocabulary needs merging, and the
// import says so rather than quietly growing forever.
const DRIFT_WARN_AT = Number(process.env.CLAIM_KINDS_DRIFT_WARN || 25);

module.exports = { list, get, label, known, ensure, merge, rename, slugify, hue, FILE, DRIFT_WARN_AT };
