const { mutateJson, loadJson, loadSettings } = require('./json');
const cfg = require('../config');

function loadLoads() {
    return loadJson(cfg.LOADS_FILE, []);
}

function round2(n) {
    return typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : null;
}
function toNum(v) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : null;
}

// REAL BUG, found 2026-08-17 from production logs: "[SEND] Failed ->
// 8056944193@c.us: No LID for user". That looked at first like purely the
// unresolved upstream whatsapp-web.js "LID" bug (see api.js's send-to-seller
// route comment) — but 8056944193 is the SAME number already on file
// elsewhere in this app as 918056944193 (data/truckers.json,
// data/suppliers.json, the manager number placeholder — every working
// WhatsApp number in this codebase carries India's "91" country code
// prefix). The old normalization here only stripped non-digits; a seller
// phone typed the natural local way ("8056944193", no country code) was
// stored exactly like that — 10 raw digits isn't a real WhatsApp ID at
// all, so of course WhatsApp can't resolve a LID for it. That's on us,
// not (only) the upstream bug. Assumes India (91) for a bare 10-digit
// number, matching the one country code convention already used
// everywhere else in this app; anything already carrying a country code
// (11+ digits) is left alone. Not a perfect general solution (a genuine
// non-Indian 10-digit number would get mis-prefixed), but it matches every
// other number already in this system and fixes the actual failure mode
// seen in production.
function normalizeSellerPhone(raw) {
    const digits = String(raw || '').replace(/\D/g, '');
    if (!digits) return null;
    if (digits.length === 10) return `91${digits}`;
    return digits;
}

// Gross/tare/net/price/amount are captured PER ITEM now (a load is often
// several items, each weighed separately, not one shared load-level
// weight) — this is the one place that's the source of truth for those
// numbers; the client sends its own live-computed net/amount too, but they
// get recomputed here from gross/tare/price rather than trusted as-is, same
// as it always has been for the whole-load version of this math.
function computeItem(it) {
    const gross = toNum(it.gross_weight);
    const tare  = toNum(it.tare_weight);
    const net   = (gross != null && tare != null) ? round2(gross - tare) : null;
    const price = toNum(it.price);
    const amount = (net != null && price != null) ? round2(net * price) : null;
    return {
        description: it.description || '',
        gross_weight: gross, tare_weight: tare, net_weight: net,
        price, unit: it.unit || '', amount,
        // Carried forward from the incoming item if present — matters for
        // EDITS, where the client sends back photo links an item already
        // has so they aren't lost just because that item wasn't
        // re-photographed this time. Defaults to null for a brand-new item,
        // same as before. api.js overwrites these after upload when a NEW
        // photo (gross_photo_base64/tare_photo_base64) came in for this item.
        gross_photo_drive_id: it.gross_photo_drive_id || null, gross_photo_link: it.gross_photo_link || null,
        tare_photo_drive_id : it.tare_photo_drive_id  || null, tare_photo_link : it.tare_photo_link  || null,
    };
}

// Load-level gross/tare/net/amount are SUMS across items — kept on the
// record too so the card deck and PDF summary don't have to re-derive them
// every time they're displayed.
function sumItems(items) {
    const sum = (key) => {
        const vals = items.map(it => it[key]).filter(v => v != null);
        return vals.length ? round2(vals.reduce((a, b) => a + b, 0)) : null;
    };
    return { gross_weight: sum('gross_weight'), tare_weight: sum('tare_weight'), net_weight: sum('net_weight'), amount: sum('amount') };
}

// Sequential, human-readable load IDs (EDGE_01, EDGE_02, ...) instead of the
// old LOAD-<timestamp>-<random> — per Apsara, easier to read off a ticket or
// say out loud on the yard floor than a random string. Computed from the
// current MAX existing EDGE_N suffix (ignores old LOAD-... records, which
// just means numbering starts fresh at EDGE_01 the first time this runs — no
// migration needed, old records keep their old ids). This MUST run inside
// the mutateJson callback below (i.e. under the file lock), not before it —
// computing it earlier would let two concurrent saves both read the same
// "current max" and mint the same ID.
// next_load_number (Settings > Yard, dashboard-editable — see helpers/json.js's
// loadSettings) is a FLOOR, not a one-shot override: added per Apsara
// 2026-08-15 ("add that admin setting under yard... so next time it will
// start from this, unless explicitly mentioned it should run in sequence").
// Whichever is higher — the scanned max+1 above, or this floor — wins, so
// setting it once (e.g. to skip ahead to EDGE_500 for a new ticket book)
// naturally keeps sequencing from there on every SUBSEQUENT call without
// needing to be cleared or re-applied: once a load using the floor exists,
// the scan above finds IT as the new max and takes over. No extra state to
// go stale. "Unless explicitly mentioned" = renumberLoad (see below) lets
// any single load jump anywhere regardless of this floor.
function nextLoadId(loads) {
    let max = 0;
    for (const l of loads) {
        const m = /^EDGE_(\d+)$/.exec(l.id || '');
        if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    const floor = parseInt(loadSettings().next_load_number, 10);
    if (isFinite(floor) && floor > max + 1) max = floor - 1;
    return `EDGE_${String(max + 1).padStart(2, '0')}`;
}

// Enforced at save time for BOTH create and edit — per Apsara, once an item
// row has any data in it at all, description + gross weight + tare weight
// are all mandatory before the load can be saved. This is a hard block, not
// a warning: she explicitly confirmed a load should NOT be saveable with an
// item that's only gross-weighed and waiting on tare (e.g. truck hasn't
// returned yet) — that item must be completed (or removed) before Save
// works at all, no partial saves.
//
// FIELD MAPPING (corrected 2026-08-15 per Apsara, "no. buyer should be edge
// trading"): `seller`/`seller_address` are the free-text, EDITABLE fields —
// the outside company Edge Trading is buying scrap FROM, entered by
// dashboard/mobile-app staff (with Address Book autocomplete). `buyer`/
// `buyer_address` are the FIXED constant, always "Edge Trading" — Edge
// Trading is the one buying the material, so it's the buyer. Required here
// is `entry.seller`, not `entry.buyer`: a load must have a real counterparty
// name, while the buyer side is always the same and never blank anyway.
// This is a real, non-bypassable gate rather than trusted from the request
// body — this function is the single choke point both POST /api/loads and
// PUT /api/loads/:id run through (via addLoad/editLoad below), so any
// current or future client hitting the API directly is covered too, not
// just the two UIs that already validate this client-side first.
// A row with NOTHING filled in at all is treated as an unused spare row
// (e.g. "+ Add item" clicked by mistake) and silently skipped, same as the
// existing filter that drops fully-blank items before they're saved — it's
// not "an item" yet, so it isn't held to the same completeness bar.
function validateLoadForSave(entry) {
    if (!entry.seller || !String(entry.seller).trim()) {
        throw new Error('Validation: seller is required.');
    }
    const items = Array.isArray(entry.items) ? entry.items : [];
    items.forEach((it, i) => {
        // Tare EXCLUDED from this check, per Apsara 2026-08-15 ("by default
        // tare should be zero, unless user overrides") — the dashboard/mobile
        // forms now pre-fill every new item row's tare with "0" rather than
        // leaving it blank, which would otherwise make hasAnyData true for
        // an untouched spare row (a non-empty "0" is truthy) and wrongly
        // force it through full validation just for existing. A row only
        // counts as "an item" once description, gross weight, or price is
        // actually entered.
        const hasAnyData = it.description || it.gross_weight || it.price;
        if (!hasAnyData) return;
        const label = it.description ? `"${it.description}"` : `#${i + 1}`;
        if (!it.description || !String(it.description).trim()) {
            throw new Error(`Validation: item ${label} is missing a description.`);
        }
        if (it.gross_weight === null || it.gross_weight === undefined || it.gross_weight === '' || !isFinite(parseFloat(it.gross_weight))) {
            throw new Error(`Validation: item ${label} is missing a gross weight.`);
        }
        if (it.tare_weight === null || it.tare_weight === undefined || it.tare_weight === '' || !isFinite(parseFloat(it.tare_weight))) {
            throw new Error(`Validation: item ${label} is missing a tare weight.`);
        }
    });
}

async function addLoad(entry) {
    validateLoadForSave(entry);
    const items = Array.isArray(entry.items) ? entry.items.map(computeItem) : [];
    const totals = sumItems(items);

    const rec = {
        id            : null, // assigned below, under the lock — see nextLoadId
        created_at    : new Date().toISOString(),
        created_by    : entry.created_by || 'unknown',
        date          : entry.date || null,
        seller        : entry.seller || null,
        seller_address: entry.seller_address || null,
        // Optional — per Apsara 2026-08-17 ("add phone number option in
        // application for seller"). Not run through validateLoadForSave;
        // unlike seller (a hard-required counterparty name), a load should
        // still save fine without a phone on file. Digits only, same
        // normalization as helpers/pricelist.js's contact numbers — kept
        // raw here (not @c.us-suffixed) since this is a data field, not a
        // chat id; the send-to-seller route builds the chat id from it.
        seller_phone  : normalizeSellerPhone(entry.seller_phone),
        buyer         : entry.buyer || null,
        buyer_address : entry.buyer_address || null,
        description   : entry.description || '',
        items,
        gross_weight  : totals.gross_weight,
        tare_weight   : totals.tare_weight,
        net_weight    : totals.net_weight,
        amount        : totals.amount,
        weight_unit   : entry.weight_unit || 'lb',
        pdf_drive_id  : null, pdf_link: null,
        weights_pdf_drive_id: null, weights_pdf_link: null,
        status        : 'open',
    };

    await mutateJson(cfg.LOADS_FILE, [], (loads) => {
        rec.id = nextLoadId(loads);
        loads.unshift(rec);
        if (loads.length > 5000) loads.length = 5000;
        return loads;
    });

    return rec;
}

async function updateLoad(id, patch) {
    return mutateJson(cfg.LOADS_FILE, [], (loads) => {
        const l = loads.find(x => x.id === id);
        if (l) Object.assign(l, patch, { updated_at: new Date().toISOString() });
        return loads;
    });
}

// Edits an EXISTING load's core fields + items — used by the dashboard's
// Edit button, distinct from the generic patch-only updateLoad above (which
// is for narrower things like stamping pdf_link after generation and
// shouldn't run the full item recompute). Items go through the SAME
// computeItem/sumItems math as addLoad so gross/tare/net/price/amount stay
// internally consistent after an edit rather than trusting whatever the
// client sent. Deliberately clears any previously generated PDF links and
// resets status to 'open': a PDF generated before this edit no longer
// reflects the edited numbers, so leaving "View PDF" showing as if it's
// still current would be actively misleading — the card falls back to a
// fresh "Generate PDF" button until it's regenerated.
async function editLoad(id, entry) {
    validateLoadForSave(entry);
    const items = Array.isArray(entry.items) ? entry.items.map(computeItem) : [];
    const totals = sumItems(items);

    const patch = {
        date          : entry.date || null,
        seller        : entry.seller || null,
        seller_address: entry.seller_address || null,
        seller_phone  : normalizeSellerPhone(entry.seller_phone),
        buyer         : entry.buyer || null,
        buyer_address : entry.buyer_address || null,
        description   : entry.description || '',
        items,
        gross_weight  : totals.gross_weight,
        tare_weight   : totals.tare_weight,
        net_weight    : totals.net_weight,
        amount        : totals.amount,
        weight_unit   : entry.weight_unit || 'lb',
        pdf_drive_id  : null, pdf_link: null,
        weights_pdf_drive_id: null, weights_pdf_link: null,
        status        : 'open',
    };

    const loads = await mutateJson(cfg.LOADS_FILE, [], (loads) => {
        const l = loads.find(x => x.id === id);
        if (l) Object.assign(l, patch, { updated_at: new Date().toISOString() });
        return loads;
    });
    return loads.find(l => l.id === id) || null;
}

// Removes a load record entirely. Deliberately does NOT touch anything in
// Drive (item photos, previously generated PDFs) — those stay put as an
// audit trail rather than silently vanishing just because the dashboard
// entry was deleted; only the loads.json record itself goes away.
async function deleteLoad(id) {
    let found = false;
    await mutateJson(cfg.LOADS_FILE, [], (loads) => {
        const idx = loads.findIndex(x => x.id === id);
        if (idx === -1) return loads;
        found = true;
        loads.splice(idx, 1);
        return loads;
    });
    return found;
}

function getLoad(id) {
    return loadLoads().find(l => l.id === id) || null;
}

// Changes an existing load's id (e.g. "EDGE_07" -> "EDGE_12") — added per
// Apsara 2026-08-15 ("there should be a way to adjust the load number").
// Validation runs BEFORE mutateJson, not by throwing inside its mutator —
// mutateJson's own catch block swallows any error a mutator throws and
// silently falls back to returning the unmodified data (see helpers/json.js),
// so a thrown "not found"/"already exists" in there would look like success
// to the caller instead of surfacing as an error. Same reasoning as
// deleteLoad's `found` flag below: real errors have to be detected with a
// pre-check + a captured result, not an exception crossing that boundary.
// Does NOT touch Drive — the caller (api.js's PUT /:id/renumber route) is
// responsible for renaming the load's Drive subfolder to match, since this
// file has no Drive dependency and shouldn't grow one just for this.
async function renumberLoad(oldId, newId) {
    newId = String(newId || '').trim();
    if (!newId) throw new Error('New load number is required.');
    if (newId === oldId) throw new Error('That\'s already this load\'s number.');

    const existing = loadLoads();
    if (!existing.some(x => x.id === oldId)) throw new Error(`Load ${oldId} not found.`);
    if (existing.some(x => x.id === newId)) throw new Error(`Load ${newId} already exists — choose a different number.`);

    let renamed = null;
    await mutateJson(cfg.LOADS_FILE, [], (loads) => {
        const l = loads.find(x => x.id === oldId);
        if (!l) return loads;
        if (loads.some(x => x.id === newId)) return loads; // race guard, belt & suspenders
        l.id = newId;
        l.updated_at = new Date().toISOString();
        renamed = l;
        return loads;
    });
    if (!renamed) throw new Error(`Could not renumber ${oldId} — it may have just changed. Try again.`);
    return renamed;
}

// Item-type inventory + per-day load rollup across a set of loads —
// computed FRESH from whatever's currently in loads.json every call, never
// a separately maintained running counter. Per Apsara 2026-08-15 ("it keeps
// on adding inventory as per the load creation. if a load gets deleted it
// should also get modified"): the only way a deleted load automatically
// disappears from the inventory with zero extra bookkeeping is if nothing
// was ever incrementally accumulated in the first place — this just
// re-scans current loads every time it's called (same approach already
// used for the yard report's all-time section), so a delete is reflected on
// the very next read, no separate cleanup step needed anywhere.
// `from`/`to` are optional 'YYYY-MM-DD' strings (inclusive) — a load with no
// date is excluded whenever a filter is active (can't place it in range),
// but included when no filter is applied at all.
function getInventoryReport(allLoads, { from, to } = {}) {
    const { groupItemsByDescription } = require('./pdf');
    const filtered = (from || to)
        ? allLoads.filter(l => l.date && (!from || l.date >= from) && (!to || l.date <= to))
        : allLoads;

    const items = filtered.flatMap(l => Array.isArray(l.items) ? l.items : []);
    const byType = items.length ? groupItemsByDescription(items) : [];

    const dayMap = new Map();
    for (const l of filtered) {
        const key = l.date || 'Unknown date';
        if (!dayMap.has(key)) dayMap.set(key, { date: key, loadCount: 0, net: 0, amount: 0 });
        const d = dayMap.get(key);
        d.loadCount += 1;
        d.net += l.net_weight || 0;
        d.amount += l.amount || 0;
    }
    // round2 here — per Apsara 2026-08-15 ("in per day, round off the amount
    // to 2 decimal"). The running sums above can pick up float noise summing
    // several loads' amounts (e.g. 250 + 40 + 60 -> 350.00000000000006), and
    // unlike byType/bySeller (built via groupItemsByDescription, which
    // already round2()s) this map was never rounded on the way out.
    const byDay = Array.from(dayMap.values())
        .map(d => ({ ...d, net: round2(d.net), amount: round2(d.amount) }))
        .sort((a, b) => (a.date < b.date ? 1 : -1));

    // Grouped by SELLER — per Apsara 2026-08-15 ("group by seller as well so
    // that we will know how much we bought overall from that seller").
    // l.seller/l.seller_address hold the outside party's name+address —
    // l.buyer is the fixed "Edge Trading" constant (see helpers/loads.js's
    // top-of-file note and pdf.js's comment on the 2026-08-15 field swap).
    const sellerMap = new Map();
    for (const l of filtered) {
        const key = (l.seller && String(l.seller).trim()) || 'Unknown seller';
        if (!sellerMap.has(key)) sellerMap.set(key, { seller: key, loadCount: 0, net: 0, amount: 0, items: [] });
        const s = sellerMap.get(key);
        s.loadCount += 1;
        s.net += l.net_weight || 0;
        s.amount += l.amount || 0;
        if (Array.isArray(l.items)) s.items.push(...l.items);
    }
    const bySeller = Array.from(sellerMap.values())
        .map(s => ({
            seller: s.seller,
            loadCount: s.loadCount,
            net: round2(s.net),
            amount: round2(s.amount),
            byType: s.items.length ? groupItemsByDescription(s.items) : [],
        }))
        .sort((a, b) => (b.net || 0) - (a.net || 0));

    return {
        loadCount: filtered.length,
        unit: filtered.find(l => l.weight_unit)?.weight_unit || 'lb',
        byType,
        byDay,
        bySeller,
    };
}

module.exports = { loadLoads, addLoad, updateLoad, editLoad, deleteLoad, getLoad, renumberLoad, getInventoryReport };
