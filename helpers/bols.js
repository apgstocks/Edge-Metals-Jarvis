// ── helpers/bols.js — the fields behind a Bill of Lading ─────────────────────
// Apsara, 2026-09-16: "Edit Bol option also needed".
//
// ── WHY THIS FILE HAD TO EXIST BEFORE EDIT COULD ────────────────────────────
// The BOL shipped saving only the PDF. helpers/documentsSaved.js files the
// rendered bytes under bol/<date>/<file>.pdf and that is the whole record, so
// there was literally nothing to reopen: a PDF is where the typing ENDED, not
// what was typed. "Add an Edit button" was therefore not a UI change — the
// data it would edit did not exist.
//
// So this stores the FORM. The PDF stays where it is, because the two answer
// different questions: this one is "what did she fill in", that one is "what
// did the driver actually get handed".
//
// ── UPSERTED BY BOL NUMBER, NOT APPENDED ────────────────────────────────────
// Correcting a typo and pressing Generate again must not leave two BOLs both
// claiming to be EM-1047. The number IS the identity of the document — it is
// what the buyer quotes back — so a save with a number already on file
// replaces that record rather than adding one beside it.
//
// A BOL with no number yet gets its own row, keyed by a minted id. Blank is
// not a number, so blanks never collide with each other: two unnumbered BOLs
// are two BOLs, and merging them would silently destroy one.
//
// ── WHAT REGENERATING DOES TO THE OLD PDF ───────────────────────────────────
// It overwrites it, because the filename is built from the BOL number. That
// is the right default for the case she described — fixing something before
// it is printed — and it is worth being plain that it is a real decision:
// once a BOL has been handed to a driver, editing it changes the office copy
// and not the paper in the cab. The stored record keeps `generated_count` and
// `last_generated_at` so a document that has been reissued is at least
// visible as such rather than looking untouched.

const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

const FILE = () => cfg.BOLS_FILE;

const loadBols = () => loadJson(FILE(), []);

// Same normalisation as the archive's filename: a BOL number differing only
// by case or a stray space is the same document, and treating it as a second
// one is how two records both end up claiming to be EM-1047.
function keyOf(bolNo) {
    return String(bolNo == null ? '' : bolNo).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function newId() {
    return `BOL_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// The fields the form owns, listed explicitly. NOT a spread of whatever the
// client posted: this record is read back into a form and re-rendered into a
// legal document, and a client that starts sending an extra key should not be
// able to grow the stored shape without someone deciding to.
function buildRecord(input, prev) {
    const i = input || {};
    const items = Array.isArray(i.items) ? i.items : [];
    return {
        id: (prev && prev.id) || newId(),
        bol_no: String(i.bol_no || '').trim(),
        bol_date: i.bol_date || null,
        consignee_name: String(i.consignee_name || '').trim(),
        consignee_address: i.consignee_address || '',
        po_number: String(i.po_number || '').trim(),
        appointment_id: String(i.appointment_id || '').trim(),
        pickup_date: i.pickup_date || null,
        pickup_time: i.pickup_time || null,
        carrier: String(i.carrier || '').trim(),
        driver: String(i.driver || '').trim(),
        container_no: String(i.container_no || '').trim(),
        seal_no: String(i.seal_no || '').trim(),
        weight_unit: String(i.weight_unit || 'lb').trim() || 'lb',
        notes: i.notes || '',
        // Weights are kept as the STRINGS she typed, not parsed to numbers.
        // The form has to show them back exactly as entered — "4,120" and a
        // trailing decimal point included — and helpers/bolPdf.js parses them
        // itself at render time. Parsing here would mean a value that looks
        // different after an edit than it did before one.
        items: items.map((it) => ({
            description: String((it && it.description) || '').trim(),
            pieces: (it && it.pieces) ?? '',
            gross_weight: (it && it.gross_weight) ?? '',
            tare_weight: (it && it.tare_weight) ?? '',
            net_weight: (it && it.net_weight) ?? '',
        })),
        created_at: (prev && prev.created_at) || new Date().toISOString(),
        created_by: (prev && prev.created_by) || i.created_by || null,
        updated_at: new Date().toISOString(),
        updated_by: i.created_by || null,
        // Provenance for a document that can be reissued. A BOL on its third
        // printing looks identical to a fresh one without these.
        generated_count: ((prev && prev.generated_count) || 0) + 1,
        last_generated_at: new Date().toISOString(),
        last_filename: i.last_filename || (prev && prev.last_filename) || null,
        last_saved_date: i.last_saved_date || (prev && prev.last_saved_date) || null,
    };
}

// Creates or replaces, under the file lock so two saves of one number cannot
// both decide they are the first.
async function saveBol(input) {
    let saved = null;
    await mutateJson(FILE(), [], (rows) => {
        const list = Array.isArray(rows) ? rows : [];
        const k = keyOf(input && input.bol_no);
        // A blank number matches nothing — see the header. Two unnumbered
        // BOLs are two BOLs.
        const idx = k ? list.findIndex((r) => keyOf(r && r.bol_no) === k)
                      : (input && input.id ? list.findIndex((r) => r && r.id === input.id) : -1);
        const prev = idx === -1 ? null : list[idx];
        saved = buildRecord(input, prev);
        if (idx === -1) list.unshift(saved); else list[idx] = saved;
        if (list.length > 2000) list.length = 2000;
        return list;
    });
    return saved;
}

function getBol(id) {
    return loadBols().find((r) => r && String(r.id) === String(id)) || null;
}

async function deleteBol(id) {
    let removed = false;
    await mutateJson(FILE(), [], (rows) => {
        const list = Array.isArray(rows) ? rows : [];
        const idx = list.findIndex((r) => r && String(r.id) === String(id));
        if (idx === -1) return list;
        list.splice(idx, 1);
        removed = true;
        return list;
    });
    return removed;
}

// Newest first, and deliberately NOT the whole record: the list is a list.
// Shipping every item line and every note to draw a few rows is the habit
// that made other endpoints in this app slow, and the full record is one
// click away through getBol.
function listBols() {
    return loadBols().map((r) => ({
        id: r.id,
        bol_no: r.bol_no || '',
        bol_date: r.bol_date || null,
        consignee_name: r.consignee_name || '',
        container_no: r.container_no || '',
        item_count: Array.isArray(r.items) ? r.items.filter((it) => it && String(it.description || '').trim()).length : 0,
        updated_at: r.updated_at || r.created_at || null,
        generated_count: r.generated_count || 0,
        last_filename: r.last_filename || null,
        last_saved_date: r.last_saved_date || null,
    })).sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
}

module.exports = { loadBols, listBols, getBol, saveBol, deleteBol, keyOf, buildRecord };
