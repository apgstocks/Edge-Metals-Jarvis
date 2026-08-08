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

async function addLoad(entry) {
    const items = Array.isArray(entry.items) ? entry.items.map(it => {
        const qty  = toNum(it.qty);
        const rate = toNum(it.rate);
        return {
            description: it.description || '',
            qty, unit: it.unit || '', rate,
            amount: (qty != null && rate != null) ? round2(qty * rate) : null,
        };
    }) : [];

    const gross = toNum(entry.gross_weight);
    const tare  = toNum(entry.tare_weight);
    const net   = (gross != null && tare != null) ? round2(gross - tare) : null;

    const rec = {
        id            : `LOAD-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        created_at    : new Date().toISOString(),
        created_by    : entry.created_by || 'unknown',
        date          : entry.date || null,
        seller        : entry.seller || null,
        description   : entry.description || '',
        items,
        gross_weight  : gross,
        tare_weight   : tare,
        net_weight    : net,
        weight_unit   : entry.weight_unit || 'lb',
        gross_photo_drive_id: null, gross_photo_link: null,
        tare_photo_drive_id : null, tare_photo_link : null,
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
