// ── helpers/itemCode.js — the material's two letters, in one place ────────
//
// Apsara, 2026-09-07, describing the invoice number:
//   "RC — Item code, derived from the material description... keyword
//    matching against your list: REGULAR COMBO→RC, AUTO CAST→AC,
//    ALUMINIUM COMBO→AL, BATTERY→BT, and so on. It normalises first, so
//    'aluminum' and 'aluminium' both hit AW/AL."
//
// THIS EXISTED TWICE, AND THE TWO COPIES HAD ALREADY DRIFTED
// ----------------------------------------------------------
// dashboard/documents.html's ITEM_CODE_RULES and workflow/actions.js's
// itemCodeFor() were the same list typed out twice, and two keywords had
// fallen off the server copy:
//
//   'ALLOY WHEEL'  → AW on the dashboard, NOTHING from an emailed order
//   'TAINT TABOO'  → TT on the dashboard, NOTHING from an emailed order
//
// A missing item code is not a small thing: invNo falls back to the raw
// suggestion, so the same material described the same way produces a
// DIFFERENT INVOICE NUMBER depending on which screen raised the document.
// Two invoices, two numbering shapes, one customer.
//
// So the rules live here once. The browser copy stays in documents.html —
// it is a static page with no bundler — but tests/container-codes.js reads
// both and fails if a keyword exists in one and not the other, so the next
// divergence is caught the day it is typed rather than the day a customer
// queries an invoice.
//
// NORMALISED BEFORE COMPARING: everything but letters is stripped, so
// "AUTOCAST", "Auto-Cast" and "auto cast" are one thing. That is why the
// keywords below are written with spaces and matched without them.

const ITEM_CODE_RULES = [
    ['AW', ['ALUMINUM WHEEL', 'ALUMINIUM WHEEL', 'AL WHEEL', 'ALLOY WHEEL']],
    ['CW', ['CHROME WHEEL']],
    ['AL', ['ALUMINIUM COMBO', 'ALUMINUM COMBO', 'AL COMBO']],
    ['AC', ['AUTO CAST']],
    ['AP', ['SCRAP AUTO PART', 'AUTO PART']],
    ['RC', ['REGULAR COMBO']],
    ['BT', ['BATTERY', 'BATTERIES']],
    ['HW', ['HARNESS WIRE', 'HARNESS']],
    ['TT', ['TAINT TABOUR', 'TAINT TABOR', 'TOUGH TABOO', 'TAINT TABOO']],
    ['ML', ['MIXED LOAD']],
    ['SU', ['SEALED UNIT']],
    ['MM', ['MIXED MOTOR']],
    ['RD', ['ROTOR', 'DRUM']],
    ['MC', ['MIXED COMBO']],
];

const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z]/g, '');

// Returns the two-letter code, or null when nothing matches. NULL IS A REAL
// ANSWER, not a failure: an unrecognised grade means the invoice number keeps
// its plain form rather than carrying a code that describes the wrong goods.
//
// Order matters and is preserved from the original list — the first rule that
// matches wins, which is why 'ALUMINIUM COMBO' (AL) sits above the looser
// entries and why AW's wheel keywords come before it.
function itemCodeFor(desc) {
    const n = norm(desc);
    if (!n) return null;
    for (const [code, keys] of ITEM_CODE_RULES) {
        if (keys.some((k) => n.includes(norm(k)))) return code;
    }
    return null;
}

module.exports = { itemCodeFor, ITEM_CODE_RULES, norm };
