// ── helpers/ports.js — the ports she has actually used ────────────────────
//
// Apsara, 2026-09-29: "In port of discharge,save when generated,for say
// Busan,South Korea.Port of loading as Los Angeles,CA.These are jsut
// examples.I want a drop down to be added as i type."
//
// ── NO CURATED LIST OF WORLD PORTS ────────────────────────────────────────
// The obvious build is a shipped list of seaports. It is the wrong one. She
// writes "Busan,South Korea" and "Los Angeles,CA" — her own spellings, with
// her own punctuation, and those exact strings are what print on the invoice
// a customs broker reads. A canonical list would offer "Busan" or "Pusan, KR"
// and she would either pick something that does not match her other paperwork
// or ignore the dropdown entirely.
//
// So the suggestions ARE her history. Nothing to maintain, nothing to go
// stale, and every entry is a string that has already been on a document.
//
// ── TWO SOURCES, BECAUSE ONE WOULD START EMPTY ────────────────────────────
// She said "save when generated", so generated invoices are the first source.
// On their own they would leave the dropdown empty until she had generated a
// few — and she already has a POL/POD on every BOOKING (bookings.json,
// port_of_loading / port_of_discharge), which is the same information typed
// on a different screen. Both are read, so the list is useful immediately.
//
// READ ONLY. This file records nothing; it reads what other stores already
// keep. There is no ports.json to drift from the documents it describes.

const cfg = require('../config');
const { loadJson } = require('./json');

// ── WHAT COUNTS AS THE SAME PORT ──────────────────────────────────────────
// Case and spacing only. "BUSAN, SOUTH KOREA" and "Busan,South Korea" are one
// entry; "Busan" and "Busan, South Korea" are NOT — the second carries the
// country and she may want either on a given document. Collapsing them would
// silently drop the shorter one, and a suggestion list that cannot offer what
// she typed last week is worse than no suggestions.
const key = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().toLowerCase();

function bump(map, raw, when) {
    const k = key(raw);
    if (!k) return;
    const label = String(raw).replace(/\s+/g, ' ').trim();
    const cur = map.get(k);
    if (!cur) { map.set(k, { value: label, uses: 1, last: when || null }); return; }
    cur.uses += 1;
    // The most recent SPELLING wins the label: if she has started writing
    // "Los Angeles, CA" where she used to write "LOS ANGELES CA", the list
    // should offer the newer one.
    if (when && (!cur.last || String(when) > String(cur.last))) {
        cur.last = when; cur.value = label;
    }
}

// Every generated invoice's saved form state, newest per container last.
// helpers/invoiceVersions.js stores { [container]: [payload, ...] } and the
// payload's keys are the invoice form's — port_loading / port_discharge, NOT
// the booking's port_of_loading / port_of_discharge. Two different names for
// the same thing, which is exactly the sort of detail that makes a hand-rolled
// second reader wrong.
function fromInvoices(map, which) {
    const field = which === 'loading' ? 'port_loading' : 'port_discharge';
    let store = {};
    try { store = loadJson(cfg.INVOICE_VERSIONS_FILE, {}) || {}; } catch (e) { return; }
    for (const list of Object.values(store)) {
        for (const v of (Array.isArray(list) ? list : [])) {
            if (v) bump(map, v[field], v.saved_at);
        }
    }
}

// The bookings she has already typed a POL/POD on.
function fromBookings(map, which) {
    const field = which === 'loading' ? 'port_of_loading' : 'port_of_discharge';
    let rows = [];
    try { rows = loadJson(cfg.BOOKINGS_FILE, []) || []; } catch (e) { return; }
    if (!Array.isArray(rows)) rows = Object.values(rows || {});
    for (const b of rows) {
        if (b) bump(map, b[field], b.created_at || b.updated_at);
    }
}

// ── THE LIST ──────────────────────────────────────────────────────────────
// Ordered by how often she has used it, then most recent. A port she ships to
// every week should be the first thing offered; alphabetical would bury Busan
// under a one-off.
function list(which = 'discharge') {
    const side = which === 'loading' ? 'loading' : 'discharge';
    const map = new Map();
    fromInvoices(map, side);
    fromBookings(map, side);
    return [...map.values()].sort((a, b) =>
        (b.uses - a.uses) || String(b.last || '').localeCompare(String(a.last || ''))
        || a.value.localeCompare(b.value));
}

// Type-ahead. Substring rather than prefix — she types "korea" as readily as
// "busan", and a prefix match would offer nothing for the first.
function search(which, q, limit = 8) {
    const needle = key(q);
    const all = list(which);
    if (!needle) return all.slice(0, limit);
    const starts = [], contains = [];
    for (const e of all) {
        const k = key(e.value);
        if (k.startsWith(needle)) starts.push(e);
        else if (k.includes(needle)) contains.push(e);
    }
    return [...starts, ...contains].slice(0, limit);
}

module.exports = { list, search, key };
