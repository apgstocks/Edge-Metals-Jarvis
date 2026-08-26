// ── helpers/outboundLoads.js — outbound loads sold/shipped TO a buyer ───────
// Built 2026-08-16 per Apsara: "loads sent to Eccomelt, what load at which
// date, at what price" — then confirmed general-purpose ("multiple regular
// buyers"), not Eccomelt-specific, capturing material/weight, price/amount,
// date sent + trucker used, and an optional link back to the Quote Requests/
// Contacts flow that led to the sale.
//
// Deliberately the MIRROR IMAGE of helpers/loads.js, and deliberately its
// OWN store (data/outbound_loads.json, config.OUTBOUND_LOADS_FILE) rather
// than a `direction` flag bolted onto loads.json — see config.js's comment
// on OUTBOUND_LOADS_FILE for why. Reuses the same gross/tare/net/amount
// item math as loads.js (computeItem/sumItems) by design — that's proven,
// tested logic, just not exported from loads.js today, so it's duplicated
// here in a small, self-contained form rather than either (a) exporting
// internals out of a live, production, already-complex file for one new
// caller, or (b) importing loads.js wholesale and risking coupling to
// internals that may change for inbound-specific reasons later.

const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

const loadOutboundLoads = () => loadJson(cfg.OUTBOUND_LOADS_FILE, []);

function round2(n) {
    return typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : null;
}
function toNum(v) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : null;
}

// draws: [{ load_id, weight }] — which inbound lots this line drew from, and
// how much from each. Added 2026-08-24; see helpers/stock.js for the model and
// for why whole-load linking wasn't enough. Optional: a sale with no draws
// still counts as shipped, it just carries no cost.
function normaliseDraws(raw) {
    return (Array.isArray(raw) ? raw : [])
        .map((d) => ({ load_id: String(d && d.load_id || '').trim(), weight: toNum(d && d.weight) }))
        .filter((d) => d.load_id && d.weight != null && d.weight > 0);
}

function computeItem(it) {
    const gross = toNum(it.gross_weight);
    const tare  = toNum(it.tare_weight);
    const net   = (gross != null && tare != null) ? round2(gross - tare) : null;
    const price = toNum(it.price);
    const amount = (net != null && price != null) ? round2(net * price) : null;
    return {
        draws: normaliseDraws(it && it.draws),
        description: it.description || '',
        gross_weight: gross, tare_weight: tare, net_weight: net,
        price, unit: it.unit || '', amount,
    };
}
function sumItems(items) {
    const sum = (key) => {
        const vals = items.map((it) => it[key]).filter((v) => v != null);
        return vals.length ? round2(vals.reduce((a, b) => a + b, 0)) : null;
    };
    return { gross_weight: sum('gross_weight'), tare_weight: sum('tare_weight'), net_weight: sum('net_weight'), amount: sum('amount') };
}

// Sequential OUT_N ids — own namespace, deliberately never colliding with
// loads.js's EDGE_N ids (two different stores, two different sequences;
// sharing a namespace would falsely imply they're the same series of
// records when they represent opposite transactions).
function nextOutboundId(loads) {
    let max = 0;
    for (const l of loads) {
        const m = /^OUT_(\d+)$/.exec(l.id || '');
        if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return `OUT_${String(max + 1).padStart(2, '0')}`;
}

// Same "no partial saves" bar as loads.js's validateLoadForSave — a real
// buyer name is mandatory (this is the whole point of the record); an item
// row only has to be complete once it has ANY data in it at all, so an
// untouched spare row never blocks saving.
function validateForSave(entry) {
    if (!entry.buyer || !String(entry.buyer).trim()) {
        throw new Error('Validation: buyer is required.');
    }
    const items = Array.isArray(entry.items) ? entry.items : [];
    items.forEach((it, i) => {
        const hasAnyData = it.description || it.gross_weight || it.price;
        if (!hasAnyData) return;
        const label = it.description ? `"${it.description}"` : `#${i + 1}`;
        if (!it.description || !String(it.description).trim()) {
            throw new Error(`Validation: item ${label} is missing a description.`);
        }
        if (it.gross_weight === null || it.gross_weight === undefined || it.gross_weight === '' || !isFinite(parseFloat(it.gross_weight))) {
            throw new Error(`Validation: item ${label} is missing a gross weight.`);
        }
    });
}

function buildRecord(entry) {
    validateForSave(entry);
    const items = Array.isArray(entry.items) ? entry.items.map(computeItem) : [];
    const totals = sumItems(items);
    return {
        date          : entry.date || null,
        buyer         : String(entry.buyer).trim(),
        buyer_address : entry.buyer_address || null,
        trucker_name  : entry.trucker_name || null,
        // Optional link back to whichever quote-request pipeline actually
        // led to this sale — 'lane' (workflow/quoteRequests.js, trucker
        // lane quotes) or 'contact' (workflow/contactQuoteRequests.js).
        // Purely informational (no FK enforcement — the source request may
        // later be archived/deleted independently), used only to show a
        // "from this quote" reference on the record, never dereferenced for
        // anything load-critical.
        quote_request_id   : entry.quote_request_id || null,
        quote_request_kind : entry.quote_request_kind || null,
        // Margin tracking (2026-08-16, per Apsara: "Edge Metals acts as an
        // intermediary — buy from one supplier and sent to another
        // customer" — confirmed she wants this linked, not tracked as two
        // independent lists). References helpers/loads.js's INBOUND
        // load ids (EDGE_N) this outbound sale's material was sourced from.
        // SIMPLIFICATION, worth knowing: this links whole inbound loads,
        // not a weight-prorated split — margin here is
        // (this outbound load's amount) minus (the FULL amount of every
        // linked inbound load), computed in getOutboundReport/getMargin
        // below. That's accurate when an inbound load's material goes to
        // ONE outbound sale, but overstates cost if the same inbound load
        // is linked from more than one outbound sale (its full cost would
        // get counted against each). Flagged rather than silently assumed
        // correct — ask if partial/weight-based allocation is needed later.
        linked_inbound_load_ids: Array.isArray(entry.linked_inbound_load_ids) ? entry.linked_inbound_load_ids.filter(Boolean) : [],
        description   : entry.description || '',
        items,
        gross_weight  : totals.gross_weight,
        tare_weight   : totals.tare_weight,
        net_weight    : totals.net_weight,
        amount        : totals.amount,
        weight_unit   : entry.weight_unit || 'lb',
        status        : 'sent',
    };
}

async function addOutboundLoad(entry) {
    const rec = buildRecord(entry);
    rec.id = null;
    rec.created_at = new Date().toISOString();
    rec.created_by = entry.created_by || 'unknown';
    await mutateJson(cfg.OUTBOUND_LOADS_FILE, [], (loads) => {
        rec.id = nextOutboundId(loads);
        loads.unshift(rec);
        if (loads.length > 5000) loads.length = 5000;
        return loads;
    });
    return rec;
}

async function editOutboundLoad(id, entry) {
    const patch = buildRecord(entry);
    // An edit invalidates the ticket. Same rule helpers/loads.js applies to a
    // purchase: the stored PDF shows the OLD figures, so leaving the link in
    // place would keep serving a document that disagrees with the record it
    // came from. Cleared here so the card offers "Generate PDF" again.
    patch.pdf_link = null; patch.pdf_drive_id = null;
    patch.receipt_pdf_link = null; patch.receipt_pdf_drive_id = null;
    let updated = null;
    await mutateJson(cfg.OUTBOUND_LOADS_FILE, [], (loads) => {
        const l = loads.find((x) => x.id === id);
        if (l) { Object.assign(l, patch, { updated_at: new Date().toISOString() }); updated = l; }
        return loads;
    });
    return updated;
}

// Writes arbitrary fields straight onto a record, bypassing buildRecord.
// Added 2026-08-24 for the sale-ticket PDF: editOutboundLoad() rebuilds the
// record from a known field list, so pdf_link/pdf_drive_id passed through it
// were silently dropped and the ticket appeared to generate while the card
// never gained a link. Caught before shipping by reading buildRecord rather
// than assuming a patch object survives it.
async function patchOutboundLoad(id, patch) {
    let updated = null;
    await mutateJson(cfg.OUTBOUND_LOADS_FILE, [], (loads) => {
        const l = loads.find((x) => x.id === id);
        if (l) { Object.assign(l, patch, { updated_at: new Date().toISOString() }); updated = l; }
        return loads;
    });
    return updated;
}

async function deleteOutboundLoad(id) {
    let existed = false;
    await mutateJson(cfg.OUTBOUND_LOADS_FILE, [], (loads) => {
        const before = loads.length;
        const next = loads.filter((l) => l.id !== id);
        existed = next.length < before;
        return next;
    });
    return existed;
}

function getOutboundLoad(id) {
    return loadOutboundLoads().find((l) => l.id === id) || null;
}

// Margin for ONE outbound load — sold amount minus the full cost of every
// linked inbound load. Reads helpers/loads.js directly rather than being
// passed inbound records, so every caller (API route, report) gets this for
// free without having to separately fetch/pass loads.json themselves.
// Returns null (not 0) for cost/margin when nothing is linked yet — an
// unlinked load has UNKNOWN margin, not zero margin; the dashboard should
// show that distinction, not a misleading "$0 profit".
function getLoadMargin(outboundLoad) {
    const ids = outboundLoad.linked_inbound_load_ids || [];
    if (!ids.length) return { cost: null, margin: null, linkedCount: 0 };
    const { loadLoads } = require('./loads');
    const inbound = loadLoads();
    let cost = 0;
    let foundCount = 0;
    for (const id of ids) {
        const l = inbound.find((x) => x.id === id);
        if (l && l.amount != null) { cost += l.amount; foundCount++; }
    }
    if (!foundCount) return { cost: null, margin: null, linkedCount: ids.length };
    cost = round2(cost);
    const margin = outboundLoad.amount != null ? round2(outboundLoad.amount - cost) : null;
    return { cost, margin, linkedCount: ids.length, missingCount: ids.length - foundCount };
}

// Item-wise + per-buyer rollup, same shape/spirit as helpers/loads.js's
// getInventoryReport (bySeller there -> byBuyer here) so the dashboard's
// existing per-seller UI pattern can be reused directly for this, not
// reinvented. from/to are optional 'YYYY-MM-DD' strings (inclusive).
function getOutboundReport(allLoads, { from, to } = {}) {
    const { groupItemsByDescription } = require('./pdf');
    const filtered = (from || to)
        ? allLoads.filter((l) => l.date && (!from || l.date >= from) && (!to || l.date <= to))
        : allLoads;

    const items = filtered.flatMap((l) => (Array.isArray(l.items) ? l.items : []));
    const byType = items.length ? groupItemsByDescription(items) : [];

    const buyerMap = new Map();
    let overallCost = 0, overallCostKnown = false;
    for (const l of filtered) {
        const key = (l.buyer && String(l.buyer).trim()) || 'Unknown buyer';
        if (!buyerMap.has(key)) buyerMap.set(key, { buyer: key, loadCount: 0, net: 0, amount: 0, cost: 0, costKnown: false, items: [] });
        const b = buyerMap.get(key);
        b.loadCount += 1;
        b.net += l.net_weight || 0;
        b.amount += l.amount || 0;
        if (Array.isArray(l.items)) b.items.push(...l.items);
        // Margin only accumulates for loads that actually have a linked
        // inbound cost — an unlinked load contributes to net/amount (real,
        // known numbers) but is left OUT of the margin sum rather than
        // silently treated as $0 cost, which would overstate margin.
        const m = getLoadMargin(l);
        if (m.cost != null) { b.cost += m.cost; b.costKnown = true; overallCost += m.cost; overallCostKnown = true; }
    }
    const byBuyer = Array.from(buyerMap.values())
        .map((b) => ({
            buyer: b.buyer,
            loadCount: b.loadCount,
            net: round2(b.net),
            amount: round2(b.amount),
            cost: b.costKnown ? round2(b.cost) : null,
            margin: b.costKnown ? round2(b.amount - b.cost) : null,
            byType: b.items.length ? groupItemsByDescription(b.items) : [],
        }))
        .sort((a, b) => (b.net || 0) - (a.net || 0));

    const totalAmount = filtered.reduce((sum, l) => sum + (l.amount || 0), 0);
    return {
        loadCount: filtered.length,
        unit: filtered.find((l) => l.weight_unit)?.weight_unit || 'lb',
        byType,
        byBuyer,
        totalAmount: round2(totalAmount),
        totalCost: overallCostKnown ? round2(overallCost) : null,
        totalMargin: overallCostKnown ? round2(totalAmount - overallCost) : null,
    };
}

module.exports = {
    normaliseDraws, patchOutboundLoad,
    loadOutboundLoads, addOutboundLoad, editOutboundLoad, deleteOutboundLoad, getOutboundLoad, getOutboundReport, getLoadMargin,
};
