const { mutateJson, loadJson } = require('./json');
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
function nextLoadId(loads) {
    let max = 0;
    for (const l of loads) {
        const m = /^EDGE_(\d+)$/.exec(l.id || '');
        if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return `EDGE_${String(max + 1).padStart(2, '0')}`;
}

// Enforced at save time for BOTH create and edit — per Apsara, once an item
// row has any data in it at all, description + gross weight + tare weight
// are all mandatory before the load can be saved. This is a hard block, not
// a warning: she explicitly confirmed a load should NOT be saveable with an
// item that's only gross-weighed and waiting on tare (e.g. truck hasn't
// returned yet) — that item must be completed (or removed) before Save
// works at all, no partial saves. Seller is always the fixed constant sent
// by both dashboard and mobile-app clients, but is checked here too as a
// real, non-bypassable gate rather than trusted from the request body —
// this function is the single choke point both POST /api/loads and
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
        const hasAnyData = it.description || it.gross_weight || it.tare_weight || it.price;
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

module.exports = { loadLoads, addLoad, updateLoad, editLoad, deleteLoad, getLoad };
