// ── helpers/invoiceWeights.js — does the quantity agree with the weights? ───
//
// Apsara, 2026-09-19, sending me 260918_AP_26ARIS02.pdf. It states:
//
//     Quantity 15,642.000 MT · Rate $0.548 US$/MT · Amount $8,571.82
//
// Those are POUNDS in the MT column. Her own packing list for the same
// container, generated the same day, says 7.095 MT. The two documents
// disagree by exactly 2204.62 — and on the container as a whole, 52,233 MT
// against 23.693 MT. A twenty-foot container holds something like 20-25 MT.
//
// The money is right: $0.548/lb is $1,208/MT, so the amount is the amount she
// meant either way. Only the two printed figures are wrong, and they are wrong
// on a customs document. She confirmed it has gone to the buyer.
//
// ── WHY NOTHING CAUGHT IT ───────────────────────────────────────────────────
// The invoice row carries its own gross and tare. Net is gross minus tare,
// and MT is net over 2204.62 — the chain dashboard/documents.html already
// computes when she EDITS a weight box. It fires on edit and only on edit, so
// a quantity that arrived any other way is never checked against the weights
// sitting beside it in the same row. Every figure needed to catch this was on
// the row; nothing ever compared them.
//
// ── WHAT THIS DOES AND DELIBERATELY DOES NOT DO ─────────────────────────────
// It REPORTS. It never rewrites her figure. A quantity that disagrees with the
// weights is not automatically the wrong one — a contract weight, an agreed
// deduction, a buyer's own scale all produce a legitimate difference, and
// silently "correcting" her number would be the software deciding what she is
// billing. The route refuses and asks; she can say generate anyway.
//
// ── AND IT ONLY SPEAKS UP WHEN IT IS SURE ───────────────────────────────────
// A check that fires on ordinary variance gets clicked through, and then it is
// not there for the day it matters. So there are exactly two findings, both
// large enough to be mistakes rather than disagreements:
//
//   POUNDS_IN_MT — the stated quantity is the NET WEIGHT IN POUNDS. That is
//     this exact error, and it is nameable: it says what she did and what the
//     figure should have been.
//   FAR_OFF — the quantity and the weights differ by more than fivefold in
//     either direction. Not nameable, but not a rounding argument either.
//
// Anything smaller passes without comment.

const LB_PER_MT = 2204.62;

const num = (v) => {
    if (v === null || v === undefined) return null;
    const n = parseFloat(String(v).replace(/,/g, '').trim());
    return isFinite(n) ? n : null;
};

// The row's net weight in pounds, from its own packing figures. Null when the
// row does not carry enough to say — which is a real answer, not a zero: an
// invoice row with no weights on it cannot be checked, and pretending it
// checked out is worse than saying nothing.
//
// tareOf is helpers/packingList.js's, not a second copy. That function is the
// ONE place that decides what a tare is (her own figure when she typed one,
// otherwise the four components added up), and two answers to "what is the
// tare" would eventually differ on a document a customer is holding.
function netLbsOf(item) {
    const p = (item && item.packing) || {};
    const stated = num(p.net_weight_lbs);
    if (stated) return stated;
    const gross = num(p.gross_weight_lbs);
    if (gross == null) return null;
    const tare = require('./packingList').tareOf(p);
    return gross - (tare == null ? 0 : tare);
}

// One row's verdict, or null when there is nothing to say.
// ── A CONTAINER'S TONNAGE IS A SMALL NUMBER ───────────────────────────────
// Apsara, 2026-09-22, having told me once already: "normally mt will be
// within 100."
//
// She is right and it closes a hole the rest of this file cannot. Everything
// below compares the quantity against the row's OWN weights — which means a
// row carrying no packing weights is not judged at all (see the two early
// returns). A blank-weights row stating 49,760 in a column headed MT went
// straight through, silently, and that is the exact shape of the document
// that went to a buyer on 2026-09-18.
//
// This needs nothing to compare against. A 40ft container holds somewhere
// around 25-28 MT of scrap; 100 is far above anything she will ever ship, so
// a quantity over it is not a tight tolerance being tripped — it is pounds in
// the MT box, or a typo, and either way it cannot be printed. Deliberately
// generous: the point is to be impossible to argue with, not to be precise.
const MAX_PLAUSIBLE_MT = 100;

// ── AND IN POUNDS, EVERYTHING BELOW INVERTS ───────────────────────────────
// Apsara, 2026-09-23: "If i want to generate inv in lbs?" — after an invoice
// billed $13.09 for a container worth $28,860.80, because the Quantity column
// was headed MT while the Rate box still held her per-pound price.
//
// A pounds invoice states 49,760 against a net of 49,760. That is this file's
// flagship error — POUNDS_IN_MT — and on a pounds invoice it is CORRECT. A
// check that refuses every valid document is worse than no check: she learns
// to click through it, and then it is not there on the day it matters. That
// is stated in this file's own header about crying wolf.
//
// So the unit is a parameter, and 'mt' is the default: the Sale-row callers
// (api.js twice, helpers/saleInvoiceFlow) always produce MT because
// saleInvoice converts for them, and they pass nothing. Only the Documents
// tab, where every field is typed, sends its own.
function isLb(units) {
    const u = String(units || '').trim().toLowerCase();
    return u === 'lb' || u === 'lbs' || u === 'pound' || u === 'pounds';
}

// One row's verdict, or null when there is nothing to say.
function problemFor(item, i, units) {
    const stated = num(item && item.weight);
    const netLbs = netLbsOf(item);
    if (!stated || stated <= 0) return null;     // no quantity to check

    // ── THE POUNDS INVOICE ───────────────────────────────────────────────
    // The quantity IS the net pounds. The mirror error is the interesting
    // one: tonnes left in a column headed lbs, which under-bills by 2204x
    // exactly as the original over-stated by it.
    if (isLb(units)) {
        if (!netLbs || netLbs <= 0) return null;   // nothing to compare against
        const desc1 = String((item && (item.item_desc || item.item)) || '').trim();
        const base1 = { row: i + 1, item: desc1, stated_mt: stated,
                        net_lbs: Math.round(netLbs), implied_mt: Number((netLbs / LB_PER_MT).toFixed(3)) };
        if (Math.abs(stated - netLbs) / netLbs <= 0.02) return null;   // agrees
        if (Math.abs(stated - netLbs / LB_PER_MT) / (netLbs / LB_PER_MT) <= 0.02) {
            return { ...base1, kind: 'TONNES_IN_LB',
                     why: `Quantity reads ${stated.toLocaleString('en-US')}, which is this row's weight in TONNES, `
                        + `in a column headed lbs. In pounds it is ${Math.round(netLbs).toLocaleString('en-US')}.` };
        }
        const r1 = stated / netLbs;
        if (r1 > 5 || r1 < 0.2) {
            return { ...base1, kind: 'FAR_OFF',
                     why: `Quantity reads ${stated.toLocaleString('en-US')} lbs, but this row's weights give `
                        + `${Math.round(netLbs).toLocaleString('en-US')} lbs — `
                        + `${r1 > 1 ? Math.round(r1) : Math.round(1 / r1)} times apart.` };
        }
        return null;
    }

    // ── THE CEILING RUNS SECOND, NOT FIRST ───────────────────────────────
    // It was first, and that was wrong: her 49,760 came back as "this is not
    // a tonnage" when the row's own weights could say the far more useful
    // "this is the net weight in POUNDS, and in MT it is 22.571". Same
    // reasoning the nameable/ratio ordering below already follows — the
    // narrower finding produces the sentence worth reading. It would also
    // have turned the 15,642 case in tests/invoice-weight-guard.js from
    // POUNDS_IN_MT into the vaguer one.
    //
    // So: when the row HAS weights, fall through and let them speak. The
    // ceiling is what catches the row that has none.
    if (!netLbs || netLbs <= 0) {
        if (stated > MAX_PLAUSIBLE_MT) {
            const desc0 = String((item && (item.item_desc || item.item)) || '').trim();
            return { row: i + 1, item: desc0, stated_mt: stated, net_lbs: null, implied_mt: null,
                     kind: 'IMPOSSIBLE_MT',
                     why: `Quantity reads ${stated.toLocaleString('en-US')} MT. A container holds around 25 MT — `
                        + `anything over ${MAX_PLAUSIBLE_MT} is not a tonnage. `
                        + `If that figure is POUNDS, in MT it is ${(stated / LB_PER_MT).toFixed(3)}.` };
        }
        return null;                             // no weights to check it against
    }
    const impliedMt = netLbs / LB_PER_MT;
    const desc = String((item && (item.item_desc || item.item)) || '').trim();
    const base = { row: i + 1, item: desc, stated_mt: stated,
                   net_lbs: Math.round(netLbs), implied_mt: Number(impliedMt.toFixed(3)) };

    // ── THE NAMEABLE ONE ─────────────────────────────────────────────────
    // Tested BEFORE the ratio test, because it is a strictly narrower case
    // and the sentence it produces is the one worth reading. 2% of tolerance
    // so a rounded net (15,642 typed against a computed 15,641.7) still
    // reads as pounds rather than falling through to the vaguer finding.
    if (Math.abs(stated - netLbs) / netLbs <= 0.02) {
        return { ...base, kind: 'POUNDS_IN_MT',
                 why: `Quantity reads ${stated.toLocaleString('en-US')}, which is this row's net weight in POUNDS. `
                    + `In MT that is ${impliedMt.toFixed(3)}.` };
    }

    const ratio = stated / impliedMt;
    if (ratio > 5 || ratio < 0.2) {
        return { ...base, kind: 'FAR_OFF',
                 why: `Quantity reads ${stated.toLocaleString('en-US')} MT, but this row's weights give `
                    + `${impliedMt.toFixed(3)} MT (${Math.round(netLbs).toLocaleString('en-US')} lbs net) — `
                    + `${ratio > 1 ? Math.round(ratio) : Math.round(1 / ratio)} times apart.` };
    }
    return null;
}

// Every row that disagrees. An empty array means either that everything
// agrees or that there was nothing to compare — the caller cannot tell those
// apart from here, and deliberately: "no problems found" is the only thing
// this function is entitled to claim.
function weightProblems(lineItems, units) {
    // NOT `.map(problemFor)` — that passes the array as a third argument, and
    // the third argument is now the unit. It would have read the whole
    // line_items array as a unit string, isLb() would have said no, and every
    // pounds invoice would have been judged as MT. Explicit arguments.
    return (lineItems || []).map((it, i) => problemFor(it, i, units)).filter(Boolean);
}

// The sentence the route refuses with. Built here so the two screens and any
// later caller all say the same thing about the same document.
function refusalMessage(problems) {
    const tonnes = problems.filter((p) => p.kind === 'TONNES_IN_LB');
    if (tonnes.length && tonnes.length === problems.length) {
        return `${problems.length === 1 ? 'A row states' : `${problems.length} rows state`} a quantity in TONNES `
             + `in a column headed lbs. This invoice would bill about 2,200 times too little. `
             + `Check the Quantity column against the packing weights, or generate it anyway if the figures are deliberate.`;
    }
    const pounds = problems.filter((p) => p.kind === 'POUNDS_IN_MT');
    const head = pounds.length === problems.length && pounds.length
        ? `${problems.length === 1 ? 'A row states' : `${problems.length} rows state`} a quantity in POUNDS in the MT column.`
        : `${problems.length === 1 ? 'A row\'s' : `${problems.length} rows'`} quantity disagrees with the weights on the same row.`;
    return `${head} This invoice would go out declaring the wrong tonnage. `
         + `Check the Quantity column against the packing weights, or generate it anyway if the figures are deliberate.`;
}

module.exports = { weightProblems, problemFor, netLbsOf, refusalMessage, LB_PER_MT };
