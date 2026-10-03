// ── helpers/loadingHistory.js ──────────────────────────────────────────────
// How much of a given material actually goes in one container, measured from
// her own invoices rather than assumed.
//
// Apsara, 2026-10-03, on Joey's order being blocked for a missing quantity:
//     "by default if its a single thing,its quantity is 21 MT. All these
//      would be saved in jarvis memory."
//
// SHE IS RIGHT ABOUT THE MECHANISM AND WRONG ABOUT THE CONSTANT, and the
// difference is money. 21 MT is AUTO CAST's loading -- she gave that figure on
// 2026-08-24 and her invoice sheet confirms it precisely: 21.88 MT median over
// 90 single-material containers, 22.10 over another 58, 21.85 over another 30.
//
// It is not a universal. Measured over 759 invoice rows, single-material
// containers only:
//
//     Auto cast / casting tense     21.9 - 22.1 MT   (90, 58, 30 containers)
//     Al Combo                      22.65 MT         (93 containers)
//     Cast iron scrap               23.82 MT         (20 containers)
//     CHROME WHEELS                 14.01 MT         (3 containers, 12.9-14.6)
//     Aluminium wheels clean        14.10 MT         (3 containers, 13.6-14.2)
//     Al Wheels                     14.93 MT         (6 containers, 14.0-17.1)
//
// Wheels load around 14-15 MT because they are bulky, and three separate wheel
// descriptions agree independently. Defaulting Joey's chrome wheels to 21 MT
// would overstate the quantity by 50% -- roughly 7 MT at about $925/MT, so
// about $6,500 wrong on one container, on a document going to a customer.
//
// So: remember the loading, per material, from her own history. Do not
// generalise one material's number to all of them.
//
// WHY THE SHEET NEEDS UNIT CARE: the weight column mixes tonnes and pounds
// (21.881 and 48022 both appear). No container moves 200 MT, so anything above
// that is pounds. This is the same class of error as the rate_basis per_lb bug
// fixed earlier today, and it is worth 2204.62x if got wrong.
const MT_PER_LB = 1 / 2204.62;
const CACHE_MS = 10 * 60 * 1000;
const CACHE = { at: 0, byMaterial: null };

// A default is only safe when the history is CONSISTENT. Two containers is an
// anecdote, and a material whose loads run 2.9 to 10.7 MT (Alum Scrap 356
// Wheel) has no standard loading to remember -- it must keep asking.
const MIN_CONTAINERS = 3;
const MAX_SPREAD = 1.6;          // max / min across single-material containers

const toNum = (v) => {
    const n = Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
};
const toMt = (v) => { const n = toNum(v); return n == null ? null : (n > 200 ? n * MT_PER_LB : n); };
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

async function loadLoadings() {
    if (CACHE.byMaterial && Date.now() - CACHE.at < CACHE_MS) return CACHE.byMaterial;
    const out = new Map();
    try {
        const sheet = require('./invoiceSheet');
        const { normDesc } = require('./ratePlausibility');
        const { headers, rows } = await sheet.fetchRawSheet();
        const cm = sheet.buildColumnMap(headers);
        if (cm.weight === -1 || cm.container_no === -1) return null;
        // PER CONTAINER, NOT PER ROW. One container is routinely invoiced as
        // several lines, so a per-row median answers "how big is a line",
        // which is a different question and comes out far too low.
        const cell = new Map();      // container|material -> MT
        const matsIn = new Map();    // container -> Set(material)
        const label = new Map();
        for (const r of rows) {
            const d = sheet.rowToDict(r, cm);
            const key = normDesc(d.item_desc);
            const mt = toMt(d.weight);
            const cont = String(d.container_no || '').trim();
            if (!key || !mt || !cont) continue;
            label.set(key, String(d.item_desc || '').trim());
            const ck = cont + '|' + key;
            cell.set(ck, (cell.get(ck) || 0) + mt);
            if (!matsIn.has(cont)) matsIn.set(cont, new Set());
            matsIn.get(cont).add(key);
        }
        const solo = new Map();
        for (const [ck, mt] of cell) {
            const i = ck.lastIndexOf('|');
            const cont = ck.slice(0, i), key = ck.slice(i + 1);
            // A container carrying TWO materials says nothing about what one
            // material loads to on its own -- that is the Al/steel combo pair,
            // and the hardcoded rule below still owns it.
            if ((matsIn.get(cont) || new Set()).size !== 1) continue;
            if (!solo.has(key)) solo.set(key, []);
            solo.get(key).push(mt);
        }
        for (const [key, w] of solo) {
            if (w.length < MIN_CONTAINERS) continue;
            const lo = Math.min(...w), hi = Math.max(...w);
            if (!lo || hi / lo > MAX_SPREAD) continue;
            // ── A QUOTED QUANTITY IS A WHOLE NUMBER (2026-10-03) ──────────
            // Apsara: "21.85 MT instead of that make it standard as 21 MT",
            // then "Unless it is an LC where we need to put 22 MT".
            //
            // The median is what a container ACTUALLY loaded to. A proforma is
            // issued BEFORE loading, so it carries a nominal figure, and
            // 21.85 on a document is false precision about a weight nobody has
            // weighed yet.
            //
            // DOWN by default, UP under a letter of credit, and the direction
            // is not arbitrary in either case:
            //   · On TT terms, quoting under what will load means the
            //     commercial invoice goes UP at shipment. Quoting over means
            //     it goes DOWN, which is the version a buyer disputes.
            //   · Under an LC the credit is drawn against the quantity on the
            //     document, and exceeding it is a discrepancy the bank
            //     rejects, so the nominal figure has to sit ABOVE the load.
            //
            // Auto casting tense measures 21.85 MT here, which floors to 21
            // and ceils to 22 -- exactly the two numbers she gave. Al combo
            // measures 22.65, so 22 and 23 by the same rule.
            const measured = median(w);
            out.set(key, { mt: Math.floor(measured), mtLc: Math.floor(measured) + 1,
                measured: Math.round(measured * 100) / 100, n: w.length,
                min: Math.round(lo * 100) / 100, max: Math.round(hi * 100) / 100,
                label: label.get(key) || key });
        }
    } catch (e) {
        console.warn('[LOADING-HISTORY] Could not read loading history:', e.message);
        return null;
    }
    CACHE.byMaterial = out;
    CACHE.at = Date.now();
    return out;
}

// Returns { mt, mtLc, measured, n, min, max, label } or null. `mt` is the
// nominal quantity for a normal (TT) proforma and `mtLc` the one for a letter
// of credit; `measured` is the raw median, kept so the read-back can show the
// basis rather than just the rounded answer. Never throws: a missing default
// must leave the draft asking for a quantity, exactly as it does today.
async function standardLoadFor(desc) {
    try {
        const loadings = await loadLoadings();
        if (!loadings || !loadings.size) return null;
        const { findRange } = require('./ratePlausibility');
        // findRange does the fuzzy description matching already — "Chrome
        // wheels" in an email against "CHROME WHEELS" on the sheet. Reused
        // rather than reimplemented so the two groundings always agree about
        // what counts as the same material.
        return findRange(loadings, desc) || null;
    } catch (e) { return null; }
}

function _resetCache() { CACHE.at = 0; CACHE.byMaterial = null; }

module.exports = { standardLoadFor, loadLoadings, _resetCache, MIN_CONTAINERS, MAX_SPREAD };
