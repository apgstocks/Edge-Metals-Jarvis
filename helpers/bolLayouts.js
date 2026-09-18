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

// ── REQUIRED, BUT NOT FIXED IN PLACE ────────────────────────────────────────
// Apsara, 2026-09-16, choosing between locking these and not: "Let me move
// them too."
//
// So they are PLACEABLE — she can move and resize them like anything else —
// and they are NOT HIDEABLE. Those are different properties and the split is
// deliberate: where the consignee sits on the page is a matter of taste, and a
// bill of lading with no consignee on it is not a bill of lading. sanitise()
// below re-adds any of these that a layout leaves out, always shown.
//
// Some are naturally full width. `min_span` is a floor, not a lock: the goods
// table has five columns of its own and stops being readable squeezed into a
// quarter of the page.
// ── THE BOL NUMBER IS NOT IN HERE ───────────────────────────────────────────
// Apsara, 2026-09-18: "Remove bol number in field box. make it appear on right
// side of header."
//
// It was printing TWICE — the black header band has carried {{bol_no}} on the
// right since the template was written, and a fact box repeated it a few
// centimetres below. The header is where it belongs: it is the document's
// identity, not one of its facts, and a driver or broker quoting it back reads
// it off the top.
//
// Removed from the catalogue rather than defaulted to hidden, so it cannot be
// switched back on from the field picker and re-create the duplicate. The
// header slot is not part of the layout at all and never was — nothing she can
// do on the Design screen can take the number off a BOL.
const REQUIRED_FIELDS = [
    { key: 'consignee', label: 'Consignee name and address', span: 12, min_span: 6 },
    { key: 'bol_date',  label: 'Date',                       span: 3,  min_span: 2 },
    { key: 'goods',     label: 'Goods — commodity, pieces, gross, tare, net', span: 12, min_span: 8 },
];
const REQUIRED_KEYS = new Set(REQUIRED_FIELDS.map((f) => f.key));
const requiredByKey = new Map(REQUIRED_FIELDS.map((f) => [f.key, f]));

// ── THE GRID ────────────────────────────────────────────────────────────────
// Twelve columns, which divides by 2, 3, 4 and 6 — so a half, a third and a
// quarter are all exact and a row always closes cleanly.
//
// A field carries a `row` and a `span`; its position WITHIN a row is its order
// in the list. That is what makes overlap impossible by construction rather
// than by validation: two boxes cannot occupy one cell if cells are never
// addressed directly. She still gets "different places and different size" —
// any row, any order, any of five widths — without a layout that can put the
// carrier on top of the seal.
//
// A row that does not add up to 12 simply leaves white space, which is how
// gaps are made.
const GRID_COLUMNS = 12;
// `fallback` is the field's NATURAL width, not the full page. Defaulting a
// missing span to 12 was the first version, and it was the bug that lost the
// goods table: three required blocks arriving without spans each claimed the
// whole row, so only the first one fitted. A field with no stated width should
// take the width it has always had.
const clampSpan = (n, min, fallback) => {
    const v = Math.round(Number(n));
    if (!isFinite(v)) return Math.max(min || 1, fallback || 3);
    return Math.max(min || 1, Math.min(GRID_COLUMNS, v));
};
const clampRow = (n) => {
    const v = Math.round(Number(n));
    // Rows are renumbered densely on the way out (see sanitise), so an absurd
    // value cannot open a hundred blank rows on the document.
    return isFinite(v) && v >= 0 ? Math.min(99, v) : 0;
};

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
// The layout that reproduces the document she has always had: consignee across
// the top, number and date beside it, the optional fields four to a row, goods
// across the bottom. Rows and spans are explicit so a fresh layout is a real
// grid she can start dragging, not a special case the renderer has to guess at.
function defaultFields() {
    const out = [
        { key: 'consignee', row: 0, span: 12 },
        { key: 'bol_date',  row: 1, span: 3 },
    ];
    // Four to a row, each a quarter of the twelve columns. The offset is (i+1)
    // and not (i+2) because the BOL number no longer takes a box — see
    // REQUIRED_FIELDS above. That lands the rows exactly as the sample she
    // approved on 2026-09-18 has them:
    //   row 1  DATE · PO NUMBER · APPOINTMENT ID · PICKUP
    //   row 2  CARRIER · DRIVER · CONTAINER · SEAL
    OPTIONAL_FIELDS.forEach((f, i) => {
        if (f.key === 'notes') return;            // its own full-width block
        out.push({ key: f.key, row: 1 + Math.floor((i + 1) / 4), span: 3 });
    });
    // 90/91 keep these last whatever the loop above produced; packRows
    // renumbers them densely, so the stored layout never carries the gap.
    out.push({ key: 'goods', row: 90, span: 12 });
    out.push({ key: 'notes', row: 91, span: 12 });
    return packRows(decorate(out.map((f) => ({ ...f, shown: true, custom: false }))));
}

// Fills in the label, min_span and required flag from the catalogue, so a
// stored layout never has to carry them and can never disagree with it. A
// label stored on a catalogue field would be the thing that goes stale when a
// field is renamed here.
function decorate(fields) {
    return fields.map((f) => {
        const req = requiredByKey.get(f.key);
        const opt = byKey.get(f.key);
        return {
            key: f.key,
            label: f.custom ? f.label : ((req || opt || {}).label || f.label || f.key),
            shown: req ? true : f.shown !== false,
            custom: !!f.custom,
            required: !!req,
            // A row that was never stated stays unstated here; sanitise gives
            // it one of its own rather than piling everything onto row 0.
            row: Number.isFinite(Number(f.row)) ? clampRow(f.row) : null,
            span: clampSpan(f.span, req ? req.min_span : 1, req ? req.span : 3),
            min_span: req ? req.min_span : 1,
        };
    });
}

// Renumbers rows densely (0,1,2…) keeping her order, so a layout cannot carry
// a gap of eighty empty rows into the PDF. Applied on the way OUT, so dragging
// a field to "row 90" while rearranging is harmless.
function packRows(fields) {
    // Anything with no row of its own gets one at the end, in order — never
    // row 0, which is how unstated fields used to collide with each other.
    let next = fields.reduce((m, f) => Math.max(m, Number(f.row) || 0), 0);
    const placed = fields.map((f) => (f.row == null ? { ...f, row: ++next } : f));
    const rows = [...new Set(placed.map((f) => f.row))].sort((a, b) => a - b);
    const at = new Map(rows.map((r, i) => [r, i]));
    return placed
        .map((f) => ({ ...f, row: at.get(f.row) }))
        .sort((a, b) => a.row - b.row);
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
            out.push({ key, label, shown: raw.shown !== false, custom: true, row: raw.row, span: raw.span });
            continue;
        }

        // A field this server knows: optional, or one of the required blocks.
        // Required blocks are ACCEPTED here now (2026-09-16, "Let me move them
        // too") — they carry a row and a span like anything else. What they do
        // not carry is `shown`: decorate() forces it true regardless of what
        // arrived, so no layout, however it was posted, can produce a bill of
        // lading with no consignee on it.
        if (!byKey.has(key) && !REQUIRED_KEYS.has(key)) continue;
        seen.add(key);
        out.push({
            key,
            // The catalogue's label wins. Letting a client rename "Carrier" to
            // something else on the printed document is not what a layout is
            // for, and a renamed field is a document that reads wrong to the
            // person receiving it.
            label: (requiredByKey.get(key) || byKey.get(key)).label,
            shown: raw.shown !== false,
            custom: false,
            row: raw.row,
            span: raw.span,
        });
    }

    // ── WHAT A CLIENT LEFT OUT ───────────────────────────────────────────
    // Optional fields come back HIDDEN: a client one version behind must not
    // silently delete a field it has never heard of, and must not silently
    // turn one on either.
    //
    // Required blocks come back SHOWN, placed after everything else. A layout
    // that omits the goods table is a layout that arrived broken, and the
    // answer is to put it back rather than to print a document without it.
    const lastRow = out.reduce((m, f) => Math.max(m, clampRow(f.row)), 0);
    for (const f of OPTIONAL_FIELDS) {
        if (!seen.has(f.key)) out.push({ key: f.key, label: f.label, shown: false, custom: false, row: lastRow + 1, span: 3 });
    }
    // EACH ON ITS OWN ROW. Putting them all on one row was the first version
    // and it silently lost the goods table: consignee + number + date + goods
    // is far more than twelve columns, and rowsFor trims what does not fit.
    // A re-added block is one that arrived missing, which is exactly when it
    // must not be quietly dropped a second time.
    let spare = lastRow + 1;
    for (const f of REQUIRED_FIELDS) {
        if (!seen.has(f.key)) out.push({ key: f.key, label: f.label, shown: true, custom: false, row: ++spare, span: f.span });
    }
    return packRows(decorate(out));
}

// Only what PRINTS, grouped into rows the renderer can lay out directly.
// [{ row: 0, fields: [...] }, …] — each row's spans are capped at 12 so a row
// can never overflow the page, however the layout was stored.
function rowsFor(fields) {
    const shown = (fields || []).filter((f) => f && f.shown !== false);
    const byRow = new Map();
    for (const f of shown) {
        if (!byRow.has(f.row)) byRow.set(f.row, []);
        byRow.get(f.row).push(f);
    }
    return [...byRow.keys()].sort((a, b) => a - b).map((r) => {
        const fields = byRow.get(r);
        // Trim, do not wrap. A row she overfilled is her arrangement to fix;
        // silently pushing the last box onto a row of its own would move a
        // field she placed deliberately and look like the drag did not take.
        //
        // BUT A REQUIRED BLOCK IS NEVER THE THING TRIMMED. She can move and
        // resize the goods table; she cannot end up with a bill of lading
        // that has no goods on it because an optional field was dropped in
        // front of it. So required blocks claim their columns first, and the
        // optional ones fit into what is left — in her order either way.
        const need = fields.filter((f) => f.required).reduce((n, f) => n + f.span, 0);
        let used = 0, reserved = need;
        const fitted = [];
        for (const f of fields) {
            const budget = f.required ? (GRID_COLUMNS - used) : (GRID_COLUMNS - used - reserved);
            const span = Math.min(f.span, budget);
            if (f.required) reserved -= f.span;
            if (span < 1) continue;          // not `break` — a later required field still gets its turn
            fitted.push({ ...f, span });
            used += span;
        }
        return { row: r, used, fields: fitted };
    }).filter((r) => r.fields.length);
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
    GRID_COLUMNS, rowsFor, decorate, packRows,
    customerKey, defaultFields, sanitise,
    layoutFor, shownFields, saveLayout, deleteLayout, listLayouts, loadLayouts,
};
