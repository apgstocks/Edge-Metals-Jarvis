// ── tests/scale-ticket-boxes.js ───────────────────────────────────────────
// Apsara, 2026-09-22, on where "12 boxes × 110 lb" should come from: both the
// typed answer AND read off the ticket. This covers the reading half.
//
// A parser gets its own suite because its failure mode is not an exception —
// it is a plausible wrong number, pre-filled into a field, printed onto a
// packing list, and handed to a customs officer. Every check below is either
// "it read her real ticket" or "it refused rather than guessing".
//
// The real ticket is reproduced as TEXT exactly as pdf-parse returns it,
// glued words and all, so the suite does not need the PDF on disk.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const { boxesFrom, boxesFromPdf } = require(path.join(__dirname, '..', 'helpers/scaleTicketBoxes'));

// Mazariegos Recycling, MSNU2312862, 2026-09-21 — byte for byte what
// pdf-parse hands back. Note "Wheights" (their typo) and the glued runs:
// nothing in the parser may key on either.
const REAL = [
    '',
    '',
    'Mazariegos Recycling ',
    'Scale Ticket',
    'Date: September, 21 2026.',
    'Container #ITEMWheights',
    'MSNU2312862Sealed Units Gross- 78340Lb',
    'Seal#0009492Tare. - 26060Lb',
    'Net.   - 52280Lb',
    '12 Boxes x 110LbTare. - 1320Lb',
    'Net.   - 50960Lb',
    ' ',
].join('\n');

section('A — her actual ticket');
{
    const r = boxesFrom(REAL);
    ck('it finds the boxes line', r.found === true, JSON.stringify(r));
    ck('  12 boxes', r.count === 12, String(r.count));
    ck('  at 110 lb each', r.unit_lb === 110, String(r.unit_lb));
    // COMPUTED, not read. The printed 1,320 is evidence, not the source.
    ck('  1,320 lb of boxes, computed from the two', r.total_lb === 1320, String(r.total_lb));
    ck('  and the ticket\'s own printed total agrees',
        r.printed_total_lb === 1320 && r.disagrees === false, JSON.stringify(r));

    // The container is glued to the word after it — "MSNU2312862Sealed" — so
    // a trailing \b never fires. The first version of this returned null on
    // the real file, which is how the check came to exist.
    ck('  the container is read even though it is glued to the next word',
        r.container_no === 'MSNU2312862', String(r.container_no));

    // ── AND THE SEAL IS NOT READ AT ALL ───────────────────────────────────
    // It was, and /seal.../i matched the "Seal" inside "Sealed Units" one row
    // earlier, returning a seal number of "ed". A wrong seal on a packing
    // list disagrees with the seal on the container at the port. The bill
    // carries seal_no and is the single source for it.
    ck('  and no seal number is invented from "Sealed Units"',
        !('seal_no' in r), JSON.stringify(Object.keys(r)));
}

section('B — the shapes another supplier might print');
{
    const ok = (t, c, u) => {
        const r = boxesFrom(t);
        ck(`"${t}" reads as ${c} x ${u}`, r.found && r.count === c && r.unit_lb === u,
            JSON.stringify(r));
    };
    ok('12 boxes @ 110 lbs', 12, 110);
    ok('12 BOX X 110LB', 12, 110);
    ok('20 Boxes × 95Lb', 20, 95);          // unicode multiplication sign
    ok('8 boxes*45', 8, 45);
    ok('110 lb per box x 12', 12, 110);          // stated the other way round
}

section('C — it refuses rather than guessing');
{
    const no = (label, t, expect) => {
        const r = boxesFrom(t);
        ck(label, r.found === false && (!expect || expect.test(r.why || '')),
            JSON.stringify(r));
    };
    no('a ticket with no boxes line', 'Gross- 78340Lb\nTare - 26060Lb\nNet - 52280Lb', /reads like/);
    // THE ONE THAT MATTERS MOST. Two numbers on one line are not a
    // multiplication, and reading them as one would invent a tare.
    no('two unrelated numbers on a line', 'Container 12 ... 110 lb', /reads like/);
    no('half a box', '12.5 Boxes x 110Lb', /whole number/);
    no('zero boxes', '0 Boxes x 110Lb', /whole number/);
    no('a box weighing nothing', '12 Boxes x 0Lb', /cannot be right/);
    no('an empty ticket', '', /no readable text/);
    no('a scan with no text layer', '   \n  \n ', /no readable text/);

    // A count on one row and a weight on another are not a pair. Whole-blob
    // matching is how a container number finds a tare three rows away.
    no('figures on separate lines do not pair',
        '12 Boxes\nsomething else\n110 Lb', /reads like/);

    // ── THE ONE A MUTATION FOUND, AND THE WORST FAILURE HERE ─────────────
    // The separator between the count and the unit weight is REQUIRED — x, ×,
    // *, @ or "at". Drop that requirement and the pattern becomes "a number,
    // the word box, anything, a number", which on her own ticket's layout
    // reads the TARE as the unit weight:
    //
    //     "12 Boxes Tare. - 1320Lb"  ->  12 x 1320  =  15,840 lb of boxes
    //
    // That is a wrong tare, a wrong net, and a wrong weight on a customs
    // document, arrived at from a line that genuinely does say 12 and does
    // say boxes. Nothing in the suite noticed until a mutation loosened the
    // separator, because every other refusal case had no "box" in it at all.
    no('a boxes line with a tare but no multiplier',
        '12 Boxes Tare. - 1320Lb', /reads like/);
    no('  nor one with the count and the tare only',
        '12 Boxes   1320', /reads like/);
    // And the one that must still work, so the check above cannot be
    // satisfied by simply refusing everything.
    const still = boxesFrom('12 Boxes x 110Lb Tare. - 1320Lb');
    ck('  while the real line, which has both, still reads',
        still.found && still.count === 12 && still.unit_lb === 110, JSON.stringify(still));
}

section('D — when the ticket argues with itself');
{
    // Her packing list is going to print "12 × 110" NEXT TO a total. If the
    // ticket's own printed tare says something else, that is reported, never
    // silently resolved — whichever way it were resolved, one of the two
    // figures on the document would be a lie.
    const r = boxesFrom('12 Boxes x 110Lb Tare. - 1400Lb');
    ck('the computed total still wins', r.found && r.total_lb === 1320, JSON.stringify(r));
    ck('  and the disagreement is reported, not hidden',
        r.disagrees === true && r.printed_total_lb === 1400, JSON.stringify(r));
}

section('E — a PDF that cannot be read is a reason, not a crash');
(async () => {
    const notPdf = await boxesFromPdf(Buffer.from('this is not a pdf at all'));
    ck('a file that is not a PDF comes back as a reason',
        notPdf.found === false && /could not be read|no readable text/i.test(notPdf.why || ''),
        JSON.stringify(notPdf));
    const empty = await boxesFromPdf(null);
    ck('  and so does no file at all',
        empty.found === false && /No file/i.test(empty.why || ''), JSON.stringify(empty));

    // pdf-parse has thrown from inside its own bundle in this repo before.
    // Nothing above may reach the route as an exception.
    ck('  neither of those threw', true);

    // And the real PDF, when it is there — skipped rather than failed when it
    // is not, because the text fixture above already covers the parsing.
    const real = path.join(__dirname, 'fixtures', 'scale-ticket-mazariegos.pdf');
    if (fs.existsSync(real)) {
        const r = await boxesFromPdf(fs.readFileSync(real));
        ck('the real PDF reads 12 x 110', r.found && r.count === 12 && r.unit_lb === 110,
            JSON.stringify(r));
    } else {
        console.log('  ....  real PDF fixture absent — text fixture covers the parsing');
    }

    console.log(`\n  ${pass} passed, ${fail} failed`);
    if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
    process.exit(fail ? 1 : 0);
})();
