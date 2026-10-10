// ── helpers/priceUnits.js — what a price is per, in one place ─────────────
//
// Apsara, 2026-10-10: "in edge yard app,in addition to lbs-MT-Item can be
// /piece as well. and gross ton and net ton as well."
//
// ── WHY THIS IS ITS OWN FILE ────────────────────────────────────────────
// The arithmetic it replaces existed FOUR times:
//
//   helpers/loads.js        computeItem — purchases, and the source of truth
//   helpers/outboundLoads.js computeItem — sales, a deliberate copy whose own
//                           header argues against importing loads.js
//   mobile-app/www/index.html  twice: recomputeRowTotals and renderItemRows
//   dashboard/index.html       twice, the same two
//
// Two units in four copies was survivable. Five units in four copies is a
// drift waiting to happen, and the drift is money: the $15m figure on
// 2026-10-09 was renderItemRows multiplying pounds by a per-tonne price
// because it was the one copy that had never learned about units.
//
// So the table lives here and the servers require it. The two clients cannot
// require anything, so they carry the same table inline — and
// tests/price-units.js reads their HTML and asserts the numbers match this
// file, because "same constant, deliberately" in a comment is not a check.
//
// ── THE NET IS NEVER CONVERTED ──────────────────────────────────────────
// It stays in pounds, as the weighbridge read it and as the ticket the
// seller signs prints it. Only the QUANTITY the price multiplies changes.
// That is what makes a pound row arithmetically untouched, and it is why
// every load already on file is safe: '' and 'lb' take the same branch and
// divide by 1.
//
// ── AND ONE OF THEM IS NOT A WEIGHT ─────────────────────────────────────
// /piece has nothing to divide. Every other unit is a divisor applied to the
// net weight; a piece price needs a COUNT, which is a field a yard load item
// did not have until today. The danger is not that pieces is hard — it is
// that an unknown unit falling through to the pound branch prices 46,560 lb
// at $5/piece as $232,800, silently, which is the shape of the bug this
// file exists to stop happening a third time.
//
// So UNKNOWN IS AN ERROR, never a default. A function that quietly treats
// what it does not understand as pounds is the most expensive kind of
// forgiving.

// Pounds per unit. `null` means the unit is not a weight at all.
//
// ── 2204.62, AND NOT THE LONGER ONE ─────────────────────────────────────
// I reached for 2204.62262 first, which is the figure helpers/bills.js uses.
// That would have been wrong here and quietly so: bills.js is the EDGE
// METALS invoice side, a different company, and the four yard copies this
// file replaces — loads.js, outboundLoads.js and both clients — all already
// agree on 2204.62.
//
// Changing it would have moved every /MT amount on every yard load by a few
// cents on its next recompute. Nobody asked for that, it would have shown up
// as the nightly sheet sync reporting disagreements she did not cause, and
// it is the kind of edit that is indistinguishable from a rounding bug six
// months later. Edge Metals keeps its own constant; this one matches the
// yard as it has always computed.
const LB_PER = {
    lb: 1,
    nt: 2000,          // net ton, a.k.a. short ton — the US one
    gt: 2240,          // gross ton, a.k.a. long ton — the UK one
    mt: 2204.62,       // metric tonne, as the yard has always computed it
    piece: null,       // counted, not weighed
};

// What she sees beside the price. Kept here so the two clients and any
// report print the same words.
const LABEL = {
    lb: '/lb', nt: '/net ton', gt: '/gross ton', mt: '/MT', piece: '/piece',
};

// The order the dropdown offers them: pounds first, because that is the
// default and the overwhelming majority of her rows, then the three tons
// heaviest-last, then the one that is not a weight.
const ORDER = ['lb', 'nt', 'gt', 'mt', 'piece'];

const COUNTED = new Set(['piece']);

const r2 = (n) => Math.round(Number(n) * 100) / 100;
const num = (v) => {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return isFinite(n) ? n : null;
};

// ── NORMALISING WHAT A ROW SAYS IT IS ───────────────────────────────────
// An empty unit means pounds and always has: every row entered before
// 2026-09-24 has no unit on it, and they are all pound rows. That is a
// FACT ABOUT HER DATA, not a convenience — which is why '' maps to 'lb'
// here and an unrecognised string does not.
function normalise(unit) {
    const u = String(unit === null || unit === undefined ? '' : unit).trim().toLowerCase();
    if (u === '') return 'lb';
    // The spellings a human or an older client might send. Deliberately
    // short: this is a tolerance list, not a parser, and anything outside it
    // is refused rather than guessed at.
    if (u === 'lbs' || u === 'pound' || u === 'pounds') return 'lb';
    if (u === 'net ton' || u === 'netton' || u === 'net-ton' || u === 'short ton' || u === 'st') return 'nt';
    if (u === 'gross ton' || u === 'grosston' || u === 'gross-ton' || u === 'long ton' || u === 'lt') return 'gt';
    if (u === 'tonne' || u === 'tonnes' || u === 'metric ton' || u === 'metric tonne') return 'mt';
    if (u === 'pc' || u === 'pcs' || u === 'pieces' || u === 'each' || u === 'ea') return 'piece';
    return Object.prototype.hasOwnProperty.call(LB_PER, u) ? u : null;
}

function isKnown(unit) { return normalise(unit) !== null; }
function isCounted(unit) { return COUNTED.has(normalise(unit)); }
function labelOf(unit) { const u = normalise(unit); return u ? LABEL[u] : ''; }

// ── THE ONE PIECE OF ARITHMETIC ─────────────────────────────────────────
// Returns the quantity the price multiplies, or null when it cannot be
// known. Throws for an unrecognised unit — see the header.
//
// `net` is pounds. `pieces` is a count and is read ONLY for a counted unit,
// so a stray pieces value on a weight row changes nothing.
function qtyFor({ unit, net, pieces } = {}) {
    const u = normalise(unit);
    if (u === null) {
        throw new Error(`"${unit}" is not a unit Jarvis prices in — it takes `
            + ORDER.map((k) => LABEL[k]).join(', '));
    }
    if (COUNTED.has(u)) {
        const c = num(pieces);
        // A count of zero is a real answer (nothing was delivered) and must
        // not be confused with "she has not typed it yet", which is null.
        // A negative count is neither.
        if (c === null || c < 0) return null;
        return c;
    }
    const n = num(net);
    if (n === null) return null;
    return n / LB_PER[u];
}

// The amount, rounded the way every other money figure in this repo is.
// Separated from qtyFor so a screen can show the quantity on its own.
function amountFor({ unit, net, pieces, price } = {}) {
    const qty = qtyFor({ unit, net, pieces });
    const p = num(price);
    if (qty === null || p === null) return null;
    return r2(qty * p);
}

module.exports = { LB_PER, LABEL, ORDER, normalise, isKnown, isCounted, labelOf,
    qtyFor, amountFor };
