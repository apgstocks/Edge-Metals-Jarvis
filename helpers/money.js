// ── helpers/money.js — one way to write an amount ────────────────────────────
//
// Apsara, 2026-08-24: "all the amount should rounded off to two decimal."
//
// Before this there were THREE separate money() definitions (workflow/actions.js,
// workflow/replyWatch.js, helpers/pdf.js) and a scattering of places that just
// interpolated the raw number — so the same figure could appear as "$2466" in
// the nightly yard report, "$2,466.00" in a proforma read-back, and
// "$2466.4560000000001" anywhere a float had been through an arithmetic step.
// That last one is not hypothetical: summing several loads' amounts is exactly
// how binary floating point produces a tail, and helpers/loads.js round2()s its
// stored sums precisely because it had happened.
//
// Two functions, because rates and amounts are genuinely different:
//
//   amount()  — a total. ALWAYS exactly two decimals, with thousands
//               separators. $101,640.00. This is what she asked for.
//   rate()    — a unit price. At least two decimals, but never truncates a
//               real third: a scrap rate quoted at 0.605/lb must not print as
//               0.61, because the difference over 40,000 lb is $2. Mirrors
//               helpers/pdf.js's fmtRate, which learned this the hard way.
//
// Both return a STRING and neither adds a currency symbol — callers own the
// "$", since some contexts want it and some already have one.

function round2(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return 0;
    // Scale-round-unscale rather than toFixed: toFixed(2) on 1.005 gives
    // "1.00" because the stored double is fractionally below 1.005, whereas
    // this gives "1.01". Pennies, but they are someone's pennies and they
    // appear on documents.
    return Math.round((v + Number.EPSILON) * 100) / 100;
}

function amount(n) {
    if (n == null || n === '') return null;
    const v = Number(n);
    if (!Number.isFinite(v)) return null;
    return round2(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function rate(n) {
    if (n == null || n === '') return null;
    const v = Number(n);
    if (!Number.isFinite(v)) return null;
    const s = String(n);
    const decimals = s.includes('.') ? s.split('.')[1].length : 0;
    return decimals >= 2 ? s : v.toFixed(2);
}

// Convenience for the common "$1,234.56" case. Returns '—' rather than
// "$null" for a missing figure, since these land in messages people read.
function usd(n) {
    const a = amount(n);
    return a == null ? '—' : `$${a}`;
}

module.exports = { amount, rate, usd, round2 };
