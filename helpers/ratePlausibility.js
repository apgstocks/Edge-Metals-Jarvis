// ── helpers/ratePlausibility.js — is this figure a per-MT rate? ──────────────
//
// Written 2026-08-24 after getting this exactly backwards.
//
// A real email said "2 containers of auto casting tense at 2,450 ... Your price
// is $2,420 CIF Busan". Gemini flagged 2,420 as probably a lot total rather
// than a per-tonne rate, my code refused it, and I told Apsara that using it
// would have produced a $101,640 invoice from a $2,420 order. She said the
// figure was right. Her own invoice sheet settled it: Auto Casting Tense has
// 202 rows, median $2,195, range $1,150-$2,710, with rows showing $1,980
// against a weight of 21.000. $2,420/MT is an ordinary price. $101,640 for two
// containers is the CORRECT total.
//
// The mistake underneath is worth naming, because it will recur: I reasoned
// from "scrap is a few hundred dollars a tonne", which is true of steel and
// false of aluminium castings. The model had the same gap. Neither of us knew
// the domain — but the business has 663 priced rows that do.
//
// So basis is no longer decided by a model's intuition. A figure is checked
// against what THAT MATERIAL has actually sold for. If it sits inside the
// historical band, it is a per-MT rate, whatever anyone guessed. If it sits
// far outside, that is worth stopping for regardless of how confident the
// model was.
//
// Falls back to the model's judgement when there is no history for a material
// — a new product line shouldn't be blocked because it has never been sold.

const RANGE_CACHE = { at: 0, byMaterial: null };
const CACHE_MS = 30 * 60 * 1000;

const normDesc = (d) => String(d || '').toUpperCase().replace(/[^A-Z]/g, '');
const toNum = (v) => {
    const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
};

// Builds { normalisedMaterial -> {min, max, median, n} } from the invoice
// sheet's real history. Cached: this is a network read and the answer moves
// over months, not minutes.
async function loadRateRanges() {
    if (RANGE_CACHE.byMaterial && Date.now() - RANGE_CACHE.at < CACHE_MS) return RANGE_CACHE.byMaterial;
    const byMaterial = new Map();
    try {
        const sheet = require('./invoiceSheet');
        const { headers, rows } = await sheet.fetchRawSheet();
        const cm = sheet.buildColumnMap(headers);
        for (const r of rows) {
            const d = sheet.rowToDict(r, cm);
            const price = toNum(d.inv_price);
            const key = normDesc(d.item_desc);
            if (!price || !key) continue;
            // ── THE BAND WAS BUILT FROM TWO DIFFERENT UNITS (2026-10-03) ───
            // Her sheet carries BOTH shapes, row by row, in the same columns:
            //
            //   Joey/Wooshin   Aluminium Wheels Clean   $3,095.00   14.243
            //   G&C Recycling  Al Wheels Dirty          $1.72       44,640
            //
            // The first is an EXPORT SALE priced per metric tonne with the
            // weight in MT. The second is a DOMESTIC PURCHASE priced per pound
            // with the weight in pounds. Pooling them gave Chrome Wheels a
            // "range" of $1.31 to $3,220, and gave Al Wheels Dirty a median of
            // $1.65 across 36 rows that are all per-pound.
            //
            // MEASURED CONSEQUENCE, and it is the worst kind -- the safety
            // layer certifying the error it exists to catch:
            //     judgeRate('Al Wheels Dirty', 1.72, 'per_mt')
            //       -> per_mt, "in line with the 36 past invoice(s)"
            // A $1.72 figure confirmed as a per-TONNE rate puts $36 on a
            // container she sells for about $61,000. And the converse:
            //     judgeRate('Al Wheels Dirty', 2900, 'per_mt')  -> unknown
            // a real export price, blocked.
            //
            // The unit is not a guess. It is derivable per row from the pair
            // (price, weight), because no container moves 200 MT: a weight
            // above 200 is pounds, so that row's price is per pound. Same rule
            // as helpers/loadingHistory.js uses, for the same reason.
            const w = toNum(d.weight);
            const unit = w == null ? (price > 100 ? 'mt' : null) : (w > 200 ? 'lb' : 'mt');
            if (!unit) continue;
            if (!byMaterial.has(key)) byMaterial.set(key, { mt: [], lb: [] });
            byMaterial.get(key)[unit].push(price);
        }
    } catch (e) {
        console.warn('[RATE-PLAUSIBILITY] Could not read price history:', e.message);
        return null;
    }
    const out = new Map();
    for (const [key, buckets] of byMaterial) {
        const bands = {};
        for (const unit of ['mt', 'lb']) {
            const prices = buckets[unit];
            if (!prices || !prices.length) { bands[unit] = null; continue; }
        // Drop the bottom and top 5% before taking a range. The sheet has
        // genuine junk in it — a 1.15 and a 276021601570 both appear — and one
        // fat-fingered row must not widen the band enough to wave a wrong
        // figure through.
            const sorted = prices.slice().sort((a, b) => a - b);
            const lo = sorted[Math.floor(sorted.length * 0.05)];
            const hi = sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1];
            bands[unit] = { min: lo, max: hi, median: sorted[Math.floor(sorted.length / 2)], n: sorted.length, unit };
        }
        if (!bands.mt && !bands.lb) continue;
        out.set(key, bands);
    }
    RANGE_CACHE.byMaterial = out;
    RANGE_CACHE.at = Date.now();
    return out;
}

// Matches loosely — "auto casting tense" against "Auto Cast", "AUTO CASTING
// TENSE" — because the sheet's wording and a customer's wording rarely agree
// exactly. Prefers the most specific match with enough rows to be meaningful.
function findRange(ranges, desc) {
    if (!ranges) return null;
    const key = normDesc(desc);
    if (!key) return null;
    if (ranges.has(key)) return ranges.get(key);
    let best = null;
    for (const [k, v] of ranges) {
        if (v.n < 3) continue; // too few rows to call a range
        if (k.includes(key) || key.includes(k)) {
            if (!best || k.length > best.k.length) best = { k, v };
        }
    }
    return best ? best.v : null;
}

// Returns { basis, reason, range } — basis is 'per_mt', 'per_lot' or
// 'unknown'. Only overrides the model when history actually says something.
async function judgeRate(desc, rate, modelBasis) {
    if (rate == null) return { basis: modelBasis || 'unknown', reason: null, range: null, confirmed: false };
    const ranges = await loadRateRanges().catch(() => null);
    const bands = findRange(ranges, desc);
    // COMPARE LIKE WITH LIKE. A per-MT figure is only ever checked against the
    // per-MT rows. With no per-MT history for the material there is nothing to
    // confirm it against, and saying so is the honest answer -- the old code
    // would have confirmed it against per-pound purchase prices.
    const unit = modelBasis === 'per_lb' ? 'lb' : 'mt';
    const r = bands && bands[unit];
    if (!r) {
        const other = bands && bands[unit === 'mt' ? 'lb' : 'mt'];
        return { basis: modelBasis || 'unknown', confirmed: false,
            reason: other ? `no past ${unit === 'mt' ? 'per-MT' : 'per-lb'} invoice for ${desc} to check $${rate} against (the ${other.n} on record are ${other.unit === 'lb' ? 'per-pound purchases' : 'per-tonne sales'})` : null,
            range: null };
    }

    // Band derived from the MEDIAN, not from min/max. Trimming the outer 5%
    // wasn't enough: "Auto Cast" still came out $1–$2,680, because the sheet
    // carries more than a handful of junk rows (a 1.15 and a 276021601570 both
    // appear in it), and a floor of $1 would wave through any figure at all.
    // A median can't be dragged by bad rows the way an extreme can.
    //
    // 0.3x to 3x is deliberately wide — this separates "an ordinary rate for
    // this material" from "off by a factor of ten", and is not a price
    // control. Scrap moves, and a genuinely good deal must not be blocked.
    const lo = r.median * 0.3, hi = r.median * 3;
    if (rate >= lo && rate <= hi) {
        return {
            // CONFIRMED means history actually AGREED. Without this flag the
            // "no past per-MT invoice to check this against" line was about to
            // be printed in the draft's GROUNDED section -- i.e. an absence of
            // evidence rendered to her as evidence. toProformaDraft routes on
            // it: confirmed -> grounded, everything else -> unconfirmed.
            confirmed: true,
            basis: unit === 'lb' ? 'per_lb' : 'per_mt',
            reason: unit === 'lb'
                ? `$${rate}/lb is in line with the ${r.n} past ${desc} purchase(s) (typically around $${r.median}/lb)`
                : `$${rate}/MT is in line with the ${r.n} past ${desc} invoice(s) (typically around $${Math.round(r.median)}/MT)`,
            range: r,
        };
    }
    return {
        confirmed: false,
        basis: 'unknown',
        reason: unit === 'lb'
            ? `$${rate}/lb is well outside the usual range for ${desc} — ${r.n} past purchase(s) sit around $${r.median}/lb`
            : `$${rate} is well outside the usual range for ${desc} — ${r.n} past invoice(s) sit around $${Math.round(r.median)}/MT`,
        range: r,
    };
}

module.exports = { judgeRate, loadRateRanges, findRange, normDesc };
