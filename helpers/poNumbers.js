// ── helpers/poNumbers.js — PO-YYMMDD-001, counted per issuing company ───────
// Apsara, 2026-11-17: number auto-suggested as PO-YYMMDD-001, and each issuing
// company (Edge Metals, Edge Trading, Edge Yard) counts its own POs.
//
// The count is per COMPANY and per DAY: PO-261117-001, -002 ... then the next
// day starts at 001 again, which is what the format says. suggest() reserves
// nothing; reserve() is called when a PDF is actually produced, under the
// counter file's lock and strict, for the reason helpers/bolNumbers.js gives
// (a lock that fails quietly would hand back no number at all).
//
// The company key is the NORMALISED name, so 'EDGE TRADING INC' and
// 'Edge Trading' are one series and 'Edge Metals INC' is another. Edge Yard
// is the same legal entity as Edge Trading (helpers/entities.js), so it shares
// that series — her three names, two real counters. If she wants Edge Yard
// counted apart, that is one line in keyOf.
const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

function keyOf(company) {
    const k = String(company || '').toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim()
        .replace(/\s(inc|llc)$/, '');
    if (k === 'edge yard') return 'edge trading';
    return k || 'unknown';
}
function ymd(dateStr) {
    const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return m[1].slice(2) + m[2] + m[3];
    const d = new Date();
    return String(d.getFullYear()).slice(2) + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
}
function format(day, seq) { return `PO-${day}-${String(seq).padStart(3, '0')}`; }
function counters() {
    const c = loadJson(cfg.PO_COUNTERS_FILE, {});
    return (c && typeof c === 'object' && !Array.isArray(c)) ? c : {};
}
const slot = (company, day) => `${keyOf(company)}|${day}`;

function suggest(company, dateStr) {
    const day = ymd(dateStr);
    return format(day, (Number(counters()[slot(company, day)]) || 0) + 1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function reserve(company, dateStr, attempt = 0) {
    const day = ymd(dateStr);
    const key = slot(company, day);
    let out = null;
    try {
        await mutateJson(cfg.PO_COUNTERS_FILE, {}, (raw) => {
            const c = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
            const seq = (Number(c[key]) || 0) + 1;
            c[key] = seq;
            out = format(day, seq);
            return c;
        }, { strict: true });
    } catch (e) {
        if (attempt >= 5) throw e;
        await sleep(25 * (attempt + 1));
        return reserve(company, dateStr, attempt + 1);
    }
    return out;
}

// A number she typed herself wins and is never rewritten; if it is in this
// company's series for that day and ahead of the counter, the counter catches
// up so the next suggestion cannot repeat it.
async function noteUsed(company, number) {
    const m = String(number || '').trim().match(/^PO-(\d{6})-(\d{3,})$/i);
    if (!m) return false;
    const key = slot(company, m[1]);
    const seq = Number(m[2]);
    let moved = false;
    await mutateJson(cfg.PO_COUNTERS_FILE, {}, (raw) => {
        const c = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
        if ((Number(c[key]) || 0) < seq) { c[key] = seq; moved = true; }
        return c;
    }, { strict: true });
    return moved;
}

module.exports = { keyOf, ymd, format, suggest, reserve, noteUsed };
