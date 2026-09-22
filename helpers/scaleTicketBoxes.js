// ── helpers/scaleTicketBoxes.js — "12 Boxes x 110Lb", off a scale ticket ────
//
// Apsara, 2026-09-22: "When it is loosely loaded/pallets,ask when generating
// packing list in invoice tab....if its loosely loaded,go with existing
// flow,if its pallets-i need to have that boxes in attached in our packing
// list." Asked where the figures should come from, she chose BOTH the typed
// answer and reading it off the ticket.
//
// So this PROPOSES and never decides. It returns what it thinks it read and
// why; the screen pre-fills the two boxes with it and she confirms before
// anything prints. That ordering is the whole reason a parser is acceptable
// here: a misread box count is a wrong weight on a customs document, and the
// only safe place for a guess is in front of her, before the PDF exists.
//
// ── NOT helpers/scaleTickets.js, AND NOT helpers/visionOcr.js ──────────────
// Both of those are EDGE YARD. Her rule, repeated: "yard has no scope in
// jarvis only scout has", and CLAUDE.md rule 5 — Edge Yard and Edge Metals
// are different companies. That store holds WhatsApp ticket images against
// yard operations; this reads a PDF a supplier sent for an Edge Metals
// container and stores nothing at all.
//
// ── WHAT IT LOOKS FOR ──────────────────────────────────────────────────────
// The Mazariegos ticket for MSNU2312862 reads:
//
//     Container #   ITEM            Wheights
//     MSNU2312862   Sealed Units    Gross- 78340Lb
//     Seal#0009492                  Tare. - 26060Lb
//                                   Net.  - 52280Lb
//                   12 Boxes x 110Lb Tare. - 1320Lb
//                                   Net.  - 50960Lb
//
// Note "Wheights" — a supplier's typo in the header. Nothing here keys on
// spelling: the count and the unit weight are found by SHAPE (a number, the
// word box, a multiplier, a number) and the total is recomputed rather than
// read, so a ticket that prints 1,320 and a ticket that does not both work.

const NUM = String.raw`([\d,]+(?:\.\d+)?)`;

// "12 Boxes x 110Lb", "12 boxes @ 110 lbs", "12 BOX X 110LB", "12 boxes*110".
// The separator is optional-ish but must exist in some form, because "12
// boxes 110" is as likely to be two unrelated figures as a multiplication.
const BOXES = new RegExp(
    NUM + String.raw`\s*(?:x\s*)?box(?:es)?\s*(?:[x×*@]|at)\s*` + NUM + String.raw`\s*(?:lbs?|pounds?)?`,
    'i');

// The other direction, which some tickets use: "110 lb per box x 12".
const BOXES_REVERSED = new RegExp(
    NUM + String.raw`\s*(?:lbs?|pounds?)\s*(?:per|/|a)\s*box(?:es)?\s*(?:[x×*]\s*)?` + NUM,
    'i');

// ── NO TRAILING \b, BECAUSE THE PDF HAS NO SPACES ─────────────────────────
// pdf-parse hands back her ticket's row as one run:
//     "MSNU2312862Sealed Units Gross- 78340Lb"
// so the container is glued to the word after it and \b never fires — the
// first version of this returned null on the real file. A negative lookahead
// for another digit is what is actually meant: four letters, seven digits,
// and no eighth digit.
const CONTAINER = /([A-Z]{4}\d{7})(?!\d)/;

// ── THE SEAL IS DELIBERATELY NOT READ HERE ────────────────────────────────
// It was, and it was wrong: /seal\s*#?\s*:?\s*([A-Za-z0-9-]+)/i matched the
// "Seal" inside "SEALED UNITS" one row earlier and returned a seal number of
// "ed". A wrong seal number on a packing list is a document that disagrees
// with the container's own seal at the port.
//
// Tightening the pattern would have fixed that one ticket. Removing it fixes
// the class: the BILL already carries seal_no, it is the figure her broker
// has always received, and a second source for one fact is a second source
// to disagree. This helper reads boxes.

const num = (v) => {
    if (v === null || v === undefined) return null;
    const n = parseFloat(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
};
const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

// ── READING THE TEXT ───────────────────────────────────────────────────────
// `text` is whatever came out of the PDF. Everything is optional: a ticket
// this cannot read returns `found: false` and a reason, and the screen simply
// asks her to type the two numbers, which is the flow she would have had
// anyway. There is no path here that ends in a silent default.
function boxesFrom(text) {
    const raw = String(text || '');
    if (!raw.trim()) return { found: false, why: 'The ticket had no readable text — a scan or photo needs typing in by hand.' };

    // Lines are searched one at a time, so a count on one line cannot pair
    // with a unit weight from another. Whole-blob matching is how "12" from a
    // container number finds "110" from a tare three rows away.
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

    let count = null, unit = null, line = null;
    for (const l of lines) {
        const m = BOXES.exec(l);
        if (m) { count = num(m[1]); unit = num(m[2]); line = l; break; }
        const r = BOXES_REVERSED.exec(l);
        if (r) { unit = num(r[1]); count = num(r[2]); line = l; break; }
    }

    if (count == null || unit == null) {
        return { found: false, container_no: (CONTAINER.exec(raw) || [])[1] || null,
                 why: 'No line on this ticket reads like "12 Boxes x 110 Lb".' };
    }
    // A count is a count. A ticket reading "12.5 boxes" is a misread, not a
    // half pallet, and it is better to hand it back than to round it.
    if (!Number.isInteger(count) || count <= 0) {
        return { found: false, why: `Read a box count of ${count}, which is not a whole number of boxes.` };
    }
    if (unit <= 0) return { found: false, why: `Read ${unit} lb per box, which cannot be right.` };

    // ── THE TOTAL IS COMPUTED, NOT READ ────────────────────────────────────
    // The ticket prints 1,320 on the tare line and this could take it. It
    // does not: the packing list is going to print "12 × 110" beside a total,
    // and those two must agree BY CONSTRUCTION or the document argues with
    // itself in front of a customs officer. If the ticket's own printed total
    // disagrees, that is reported as a disagreement rather than resolved.
    const total = round2(count * unit);
    const printed = printedBoxTare(lines, total);

    return {
        found: true,
        count,
        unit_lb: round2(unit),
        total_lb: total,
        container_no: (CONTAINER.exec(raw) || [])[1] || null,
        source_line: line,
        // Stated, never silently preferred either way.
        printed_total_lb: printed,
        disagrees: printed != null && Math.abs(printed - total) > 0.5,
        why: null,
    };
}

// The tare figure that sits on the same row as the boxes line, when the
// ticket prints one. Matched loosely because "Tare. - 1320Lb" has a stray
// full stop in it and the next supplier's will have something else.
function printedBoxTare(lines, computed) {
    for (const l of lines) {
        if (!/box/i.test(l)) continue;
        const t = new RegExp(String.raw`tare\.?\s*[-:]?\s*` + NUM, 'i').exec(l);
        if (t) return round2(num(t[1]));
    }
    // Some layouts put the boxes line and its tare on separate rows; fall
    // back to a tare whose value equals what we computed, which is evidence
    // rather than a guess.
    for (const l of lines) {
        const t = new RegExp(String.raw`tare\.?\s*[-:]?\s*` + NUM, 'i').exec(l);
        const v = t ? round2(num(t[1])) : null;
        if (v != null && computed != null && Math.abs(v - computed) <= 0.5) return v;
    }
    return null;
}

// ── AND THE SAME THING, FROM A PDF ─────────────────────────────────────────
// Separated so the parsing above is testable without a PDF, and so a PDF
// that cannot be read at all is a REASON rather than a thrown error. pdf-parse
// has thrown from inside its own bundle on this repo before, which is exactly
// why this never lets an exception reach the route.
async function boxesFromPdf(buffer) {
    if (!buffer || !buffer.length) return { found: false, why: 'No file was attached.' };
    let text = '';
    try {
        const pdfParse = require('pdf-parse');
        const out = await pdfParse(buffer);
        text = (out && out.text) || '';
    } catch (e) {
        return { found: false, why: `That PDF could not be read (${e.message}). Type the two figures instead.` };
    }
    return boxesFrom(text);
}

module.exports = { boxesFrom, boxesFromPdf };
