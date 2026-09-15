// ── helpers/bolLayouts.js — which fields a customer's BOL carries ───────────
//
// Apsara, 2026-09-16: "For different customer, i can have different field in
// bol .. make the fields drag and drop in website as Design menu then under it
// BOL like canvas website. easy for user to handle it."
//
// EDGE METALS. The BOL is an Edge Metals document (her correction on
// 2026-09-15, "No. its for edge metals"), and nothing here touches the yard.
//
// ── WHAT SHE ASKED FOR AND WHAT THIS IS ─────────────────────────────────────
// She asked for a canvas — drag a field anywhere on the page. She was offered
// that and chose the field picker instead, and the reason it was recommended
// is worth keeping next to the code:
//
//   A BOL is a legal shipping document. Free positioning means abandoning the
//   fixed template, and with it assertNoUnfilledPlaceholders — the guard that
//   is the reason no BOL has ever gone out with an empty carrier line. It also
//   means a field can be dragged OFF the page, and the place that gets
//   discovered is a gate, with a driver waiting.
//
// So: the ORDER of fields and WHETHER they appear is hers. The frame they sit
// in is not.
//
// ── REQUIRED FIELDS ARE NOT NEGOTIABLE FROM THE UI ──────────────────────────
// Consignee and the goods table cannot be reordered or hidden by any layout.
// They are not in the optional list at all rather than being marked "locked" in
// it — a flag can be flipped by a client that posts its own JSON, a field that
// was never optional cannot. sanitise() below drops anything it does not
// recognise for the same reason: the server does not trust a layout it is
// handed just because it arrived over an authenticated session.
//
// ── ONE LAYOUT, BOTH CLIENTS ────────────────────────────────────────────────
// Stored on the server, not in the website's localStorage, because she chose
// "one layout, both places". A layout the phone cannot read means the same
// customer gets two different documents under one BOL number depending on
// which device was nearest — the worst outcome available here.

const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

// ── THE CLOSED LIST ─────────────────────────────────────────────────────────
// Every field that MAY be turned on or off, in the order a fresh layout gets
// them. `pickup` is one row covering date and time, and `container`/`seal` are
// separate because she uses seal without container on domestic loads.
//
// `keys` are the form fields each row draws from. A row with more than one is
// rendered as one box — that is how "Container and seal" reads on the picker
// and how it prints.
const OPTIONAL_FIELDS = [
    { key: 'po_number',      label: 'PO number',        keys: ['po_number'] },
    { key: 'appointment_id', label: 'Appointment ID',   keys: ['appointment_id'] },
    { key: 'pickup',         label: 'Pickup date and time', keys: ['pickup_date', 'pickup_time'] },
    { key: 'carrier',        label: 'Carrier',          keys: ['carrier'] },
    { key: 'driver',         label: 'Driver',           keys: ['driver'] },
    { key: 'container_no',   label: 'Container',        keys: ['container_no'] },
    { key: 'seal_no',        label: 'Seal',             keys: ['seal_no'] },
    { key: 'notes',          label: 'Notes',            keys: ['notes'] },
];

// Never optional. Listed here so a screen can SHOW that they are fixed rather
// than leaving her wondering why Consignee has no handle — but they are not
// part of any stored layout and sanitise() will not accept them.
const REQUIRED_FIELDS = [
    { key: 'consignee', label: 'Consignee name and address' },
    { key: 'bol_no',    label: 'BOL number' },
    { key: 'bol_date',  label: 'Date' },
    { key: 'goods',     label: 'Goods — commodity, pieces, gross, tare, net' },
];

const OPTIONAL_KEYS = OPTIONAL_FIELDS.map((f) => f.key);
const byKey = new Map(OPTIONAL_FIELDS.map((f) => [f.key, f]));

// Custom fields she names herself. Prefixed so they can never collide with a
// catalogue key, now or after someone adds one.
const CUSTOM_PREFIX = 'custom:';
const isCustom = (k) => String(k || '').startsWith(CUSTOM_PREFIX);

// ── WHO A LAYOUT BELONGS TO ─────────────────────────────────────────────────
// Case- and space-insensitive, through the same canonicalName rules the seller
// and buyer reports use, so "Eccomelt", "eccomelt " and "ECCOMELT" are one
// customer. Without this she would design a layout for Eccomelt and it would
// not apply to the BOL she typed as "eccomelt" ten minutes later — the exact
// bug canonicalName.js was written for.
//
// '' is the DEFAULT layout: every customer she has not designed one for.
function customerKey(name) {
    return String(name == null ? '' : name).trim().toLowerCase().replace(/\s+/g, ' ');
}

// The layout a brand-new customer gets: every catalogue field, shown, in
// catalogue order. Deliberately everything-on — a BOL with too many boxes is
// a document she can tidy, while one missing the field her buyer needs is a
// rejected delivery. Erring toward more is the cheap direction.
function defaultFields() {
    return OPTIONAL_FIELDS.map((f) => ({ key: f.key, label: f.label, shown: true, custom: false }));
}

// ── SANITISE ────────────────────────────────────────────────────────────────
// Takes whatever a client sent and returns a layout this module is willing to
// store. Unknown keys are DROPPED, not rejected: a client one version ahead
// (the app, mid-rollout) may know a field this server does not, and refusing
// its whole layout would lose the seven fields it got right along with the one
// it did not.
//
// Catalogue fields missing from the input are APPENDED as hidden rather than
// silently vanishing — otherwise a client one version BEHIND would quietly
// delete a field it had never heard of the first time she saved.
function sanitise(fields) {
    const out = [];
    const seen = new Set();
    for (const raw of (Array.isArray(fields) ? fields : [])) {
        if (!raw || typeof raw !== 'object') continue;
        const key = String(raw.key || '').trim();
        if (!key || seen.has(key)) continue;

        if (isCustom(key)) {
            // Her own field. The label IS the data — a custom field with no
            // label is an unnamed box on a legal document, so it is dropped.
            const label = String(raw.label || '').trim().slice(0, 60);
            if (!label) continue;
            seen.add(key);
            out.push({ key, label, shown: raw.shown !== false, custom: true });
            continue;
        }

        if (!byKey.has(key)) continue;   // not a field this server knows
        seen.add(key);
        out.push({
            key,
            // The catalogue's label wins. Letting a client rename "Carrier" to
            // something else on the printed document is not what a layout is
            // for, and a renamed required-ish field is a document that reads
            // wrong to the person receiving it.
            label: byKey.get(key).label,
            shown: raw.shown !== false,
            custom: false,
        });
    }
    for (const f of OPTIONAL_FIELDS) {
        if (!seen.has(f.key)) out.push({ key: f.key, label: f.label, shown: false, custom: false });
    }
    return out;
}

function loadLayouts() {
    const rows = loadJson(cfg.BOL_LAYOUTS_FILE, []);
    return Array.isArray(rows) ? rows : [];
}

// ── RESOLVING A CUSTOMER TO A LAYOUT ────────────────────────────────────────
// Her layout if she made one, otherwise the default layout if she edited that,
// otherwise the built-in. Three steps rather than two so that editing the
// default changes every customer she has not customised — which is what
// "Default — every other customer" promises on the screen.
function layoutFor(customerName) {
    const rows = loadLayouts();
    const key = customerKey(customerName);
    const mine = key ? rows.find((r) => r && customerKey(r.customer) === key) : null;
    if (mine && Array.isArray(mine.fields) && mine.fields.length) {
        return { customer: mine.customer || '', source: 'customer', fields: sanitise(mine.fields) };
    }
    const dflt = rows.find((r) => r && customerKey(r.customer) === '');
    if (dflt && Array.isArray(dflt.fields) && dflt.fields.length) {
        return { customer: '', source: 'default', fields: sanitise(dflt.fields) };
    }
    return { customer: '', source: 'built-in', fields: defaultFields() };
}

// Only the fields that print, in her order. What the PDF builder and both
// forms iterate.
function shownFields(customerName) {
    return layoutFor(customerName).fields.filter((f) => f.shown);
}

async function saveLayout(customerName, fields) {
    const clean = sanitise(fields);
    const key = customerKey(customerName);
    let saved = null;
    await mutateJson(cfg.BOL_LAYOUTS_FILE, [], (rows) => {
        const list = Array.isArray(rows) ? rows : [];
        // Matched on the CANONICAL key inside the mutator, not outside it:
        // deciding which row to replace before taking the lock is how two
        // saves a second apart end up as two rows for one customer.
        const idx = list.findIndex((r) => r && customerKey(r.customer) === key);
        saved = {
            customer: key ? String(customerName).trim() : '',
            fields: clean,
            updated_at: new Date().toISOString(),
        };
        if (idx >= 0) list[idx] = { ...list[idx], ...saved };
        else list.push(saved);
        return list;
    });
    return saved;
}

async function deleteLayout(customerName) {
    const key = customerKey(customerName);
    let removed = false;
    await mutateJson(cfg.BOL_LAYOUTS_FILE, [], (rows) => {
        const list = Array.isArray(rows) ? rows : [];
        const idx = list.findIndex((r) => r && customerKey(r.customer) === key);
        if (idx < 0) return list;
        list.splice(idx, 1);
        removed = true;
        return list;
    });
    return removed;
}

// Which customers have a layout of their own — what the Design screen's
// picker lists alongside the default.
function listLayouts() {
    return loadLayouts()
        .filter((r) => r && customerKey(r.customer))
        .map((r) => ({ customer: r.customer, updated_at: r.updated_at || null,
                       hidden_count: (r.fields || []).filter((f) => f && f.shown === false).length }));
}

module.exports = {
    OPTIONAL_FIELDS, REQUIRED_FIELDS, OPTIONAL_KEYS, CUSTOM_PREFIX,
    customerKey, defaultFields, sanitise,
    layoutFor, shownFields, saveLayout, deleteLayout, listLayouts, loadLayouts,
};
