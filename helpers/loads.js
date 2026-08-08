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
        gross_photo_drive_id: null, gross_photo_link: null,
        tare_photo_drive_id : null, tare_photo_link : null,
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

async function addLoad(entry) {
    const items = Array.isArray(entry.items) ? entry.items.map(computeItem) : [];
    const totals = sumItems(items);

    const rec = {
        id            : `LOAD-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        created_at    : new Date().toISOString(),
        created_by    : entry.created_by || 'unknown',
        date          : entry.date || null,
        seller        : entry.seller || null,
        description   : entry.description || '',
        items,
        gross_weight  : totals.gross_weight,
        tare_weight   : totals.tare_weight,
        net_weight    : totals.net_weight,
        amount        : totals.amount,
        weight_unit   : entry.weight_unit || 'lb',
        pdf_drive_id  : null, pdf_link: null,
        status        : 'open',
    };

    await mutateJson(cfg.LOADS_FILE, [], (loads) => {
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

function getLoad(id) {
    return loadLoads().find(l => l.id === id) || null;
}

module.exports = { loadLoads, addLoad, updateLoad, getLoad };
