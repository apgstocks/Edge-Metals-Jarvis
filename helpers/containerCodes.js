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

// ── SEVERAL containers merged onto ONE invoice ────────────────────────────
//
// Apsara, 2026-09-10: "When i add two containers, only one container's invoice
// number is coming, second container inv no is getting appended with a comma".
//
// combineInvNo() above only ever produced the SHORT comma form, which is
// correct exactly when every container shares the same head — same date, same
// item code:
//
//     260901_AL_26JY96 + 260901_AL_26JY97  ->  260901_AL_26JY96,97
//
// It is WRONG the moment the item codes differ. "260901_AL_26JY96,97" says
// both containers are ALUMINIUM COMBO when the second is REGULAR COMBO. That
// is a false statement of goods on a document that goes to a customs broker,
// and it is not fixable downstream because the item code is the only thing in
// the number that names the material.
//
// So: group by head, shorten WITHIN a head, and join the groups with "_".
//
//     260901_AL_26JY96 + 260901_RC_26JY97
//         -> 260901_AL_26JY96,260901_RC_26JY97
//     260901_AL_26JY96 + 260901_AL_26JY97 + 260901_RC_26JY98
//         -> 260901_AL_26JY96,97,260901_RC_26JY98
//
// Confirmed with her: mixed materials -> both full numbers, same material ->
// the short comma form, unchanged.
//
// SEPARATOR IS A COMMA, not an underscore. Apsara, 2026-09-10, correcting my
// first cut: "it should be 260901_AL_26JY96,260901_RC_26JY97". One separator
// throughout, so the number reads as one list however it is built — and an
// underscore is already the separator INSIDE a number (date_item_code), so
// using it between numbers too made the boundary invisible: in
// "260901_AL_26JY96_260901_RC_26JY97" nothing tells you where one number ends.
// The comma does, and it is the character the short form has always used.
//
// Order is sheet order, and heads keep their first-appearance position, so the
// number reads in the same sequence as the item rows underneath it.
function combineInvNos(invNos) {
    const list = [];
    for (const raw of (invNos || [])) {
        const v = String(raw || '').trim();
        if (v && !list.includes(v)) list.push(v);   // dedupe, keep order
    }
    if (!list.length) return '';
    if (list.length === 1) return list[0];

    // head = everything up to and including the last "_"; tail = the container
    // code. A number with no "_" has no head, so it can only ever group with
    // an identical-head ('') sibling — which is right: there is nothing to
    // prove the two belong to the same series.
    const groups = [];                    // [{ head, tails[] }] in first-seen order
    for (const invNo of list) {
        const i = invNo.lastIndexOf('_');
        const head = i === -1 ? '' : invNo.slice(0, i + 1);
        const tail = i === -1 ? invNo : invNo.slice(i + 1);
        const g = groups.find((x) => x.head === head);
        if (g) g.tails.push(tail);
        else groups.push({ head, tails: [tail] });
    }
    return groups.map((g) => g.head + shorten(g.tails)).join(',');
}

module.exports = { shorten, combineInvNo, combineInvNos };
