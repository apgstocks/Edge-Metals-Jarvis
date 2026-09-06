// ── helpers/containerCodes.js — one way to write a run of containers ──────
//
// Apsara, 2026-09-07, describing the numbering:
//   "PDF / form — one combined number naming every container:
//    260901_RC_26JY100,101 (shared prefix written once)"
//
// THE BUG THIS EXISTS TO FIX
// --------------------------
// The email/voice path never combined. workflow/actions.js built invNo from
// the FIRST container only and handed that straight to the PDF, so a
// two-container order from an email went out as
//
//     260823_AC_26JY90        instead of  260823_AC_26JY90,91
//
// and the customer's invoice number named one of the two containers they were
// being billed for. Confirmed against tests/action-invoke.js's fixture, which
// its own comment says was "copied from a REAL confirm_proforma pending
// observed in the live brain.json" — 2 containers, uncombined number. This
// has already shipped.
//
// WHY IT WENT UNNOTICED FOR SO LONG
// ---------------------------------
// proformaFilename() does its OWN combining from containerNos, so the saved
// file is called 260823_AC_26JY90,91_Taewon.pdf while the number printed
// inside the document says 26JY90. Anyone checking the filename sees the
// right answer.
//
// THREE COPIES OF ONE RULE
// ------------------------
// shortenContainerCodes() in dashboard/documents.html, the inline loop in
// proformaFilename(), and nothing at all on the path that most needed it.
// This is the one definition; the two server-side callers now use it, and
// tests/container-codes.js pins it against the browser copy so the two
// surfaces cannot drift without something failing.
//
// The client copy stays where it is: dashboard/documents.html is a static
// page with no bundler, and making it fetch this file to format a string
// would trade a drift risk for a network dependency in the middle of typing
// an invoice number.

// ["26JY90","26JY91","26JY92"] → "26JY90,91,92"
//
// The shared prefix is taken from the FIRST code and only stripped from
// codes that actually start with it. A container from a different series
// keeps its full code, because "26JY90,ABC12" is at least readable while
// "26JY90,12" would be a number that does not exist.
function shorten(codes) {
    const list = (codes || []).filter(Boolean).map(String);
    if (!list.length) return '';
    const m = /^(.*?)(\d+)$/.exec(list[0]);
    const prefix = m && m[1] ? m[1] : null;
    return list.map((c, i) => {
        if (i === 0 || !prefix) return c;
        return c.startsWith(prefix) ? c.slice(prefix.length) : c;
    }).join(',');
}

// "260823_AC_26JY90" + ["26JY90","26JY91"] → "260823_AC_26JY90,91"
//
// Only when the invoice number ACTUALLY ENDS with the first container code.
// If the numbering came from somewhere else — she typed it, or it was pasted
// from her old system — gluing container tails onto the end produces a number
// that means nothing, and this is a financial document. Same guard
// proformaFilename() already had, kept because it was right.
function combineInvNo(invNo, containerNos) {
    const base = String(invNo || '').trim();
    const list = (containerNos || []).filter(Boolean).map(String);
    if (!base || list.length < 2) return base;
    if (!base.endsWith(list[0])) return base;
    // The head is everything before the first container code; the tail is the
    // shortened run. Rebuilt rather than appended so the result is identical
    // whether or not it has been combined before.
    return base.slice(0, base.length - list[0].length) + shorten(list);
}

module.exports = { shorten, combineInvNo };
