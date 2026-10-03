// ── tests/gardunos-invoice.js ─────────────────────────────────────────────
// Apsara, 2026-10-04, uploading "Invoice 169 REVISED.pdf": "I want to upload
// all these invoices in Edge metals trucking under gardunos like AJ
// Transport".
//
// ── THE FIXTURE IS HER INVOICE, LINE FOR LINE ────────────────────────────
// Not an invented one. Garduno's Logistics Inc., invoice 169 REVISED,
// 02/13/2026, billed to Edge Metals:
//
//   1. BKNG#PHX6A1731600   SMCU1176865, SMCU1033036            qty 2  $850  $1,700
//   2. BKNG#PHX6A2335700   CAIU9924305, CAIU9899394,
//                          FFAU8016428, FFAU7806670            qty 4  $850  $3,400
//   3. SCALE TICKETS                                           qty 6   $80    $480
//                                                              Total        $5,580
//
// Six containers at $850, plus six scale tickets at $80. Her decision on
// where the scale money lands: $80 onto each container's extra_scale, and
// FLAG rather than divide when the quantity and the container count disagree.
//
// ── WHY THE ARITHMETIC IS TESTED AND THE PROMPT IS NOT ───────────────────
// gemini.js's AJ Transport extractor asks the model to do the attribution,
// which cannot be tested without calling Gemini. Here the model only reads
// the lines; expandInvoice() does the expanding and the splitting, so every
// figure below is checked by running the real code rather than by hoping a
// prompt held. The expected numbers are written out by hand from the PDF, not
// computed the way the implementation computes them.

const path = require('path');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const g = require(path.join(__dirname, '..', 'helpers/gardunosInvoice'));

// Exactly what the extraction prompt is asked to return: the lines, verbatim.
const INVOICE_169 = {
    invoice_no: '169 REVISED',
    invoice_date: '02/13/2026',
    total: 5580.00,
    lines: [
        { product: 'BKNG#PHX6A1731600',
          description: 'BKNG#PHX6A1731600\nSMCU1176865\nSMCU1033036',
          qty: 2, rate: 850.00, amount: 1700.00 },
        { product: 'BKNG#PHX6A2335700',
          description: 'BKNG#PHX6A2335700\nCAIU9924305\nCAIU9899394\nFFAU8016428\nFFAU7806670',
          qty: 4, rate: 850.00, amount: 3400.00 },
        { product: 'SCALE TICKETS', description: 'SCALE TICKETS', qty: 6, rate: 80.00, amount: 480.00 },
    ],
};

// ── A — HER INVOICE, EXPANDED ─────────────────────────────────────────────
{
    section('A — invoice 169 REVISED becomes six containers');

    const out = g.expandInvoice(INVOICE_169);

    ck('six containers, one per number listed', out.records.length === 6, String(out.records.length));
    ck('  in the order they appear',
       out.records.map((r) => r.container_no).join(',')
       === 'SMCU1176865,SMCU1033036,CAIU9924305,CAIU9899394,FFAU8016428,FFAU7806670',
       out.records.map((r) => r.container_no).join(','));

    // ── THE BOOKING FOLLOWS ITS CONTAINERS ───────────────────────────────
    // The thing a per-container row is useless without: which booking it
    // belongs to. PHX6A1731600 is not 4-letters-then-7-digits, so it cannot
    // be mistaken for a container — that is the whole reason one regex is
    // safe on this invoice.
    const bookings = out.records.map((r) => r.booking_no);
    ck('  the first two carry booking PHX6A1731600',
       bookings.slice(0, 2).every((b) => b === 'PHX6A1731600'), JSON.stringify(bookings.slice(0, 2)));
    ck('  the other four carry PHX6A2335700',
       bookings.slice(2).every((b) => b === 'PHX6A2335700'), JSON.stringify(bookings.slice(2)));
    ck('  and no booking was read as a container',
       !out.records.some((r) => /^PHX/.test(r.container_no)),
       out.records.map((r) => r.container_no).join(','));

    ck('line haul is $850 on every one', out.records.every((r) => r.line_haul === 850),
       JSON.stringify(out.records.map((r) => r.line_haul)));
    ck('  scale tickets land as $80 each', out.records.every((r) => r.extra_scale_charge === 80),
       JSON.stringify(out.records.map((r) => r.extra_scale_charge)));
    ck('  so each container costs $930', out.records.every((r) => r.amount === 930),
       JSON.stringify(out.records.map((r) => r.amount)));

    // 6 × 930 = 5580, which is the invoice. Written out rather than derived.
    ck('and it reconciles to the printed total of $5,580',
       out.records_total === 5580 && out.invoice_total === 5580 && out.reconciled === true,
       `records ${out.records_total} / invoice ${out.invoice_total} / reconciled ${out.reconciled}`);
    ck('  with the scale money fully attributed',
       out.scale_total === 480 && out.scale_applied === 480,
       `${out.scale_applied} of ${out.scale_total}`);
}

// ── B — REVISED IS FLAGGED AND NOT ACTED ON ───────────────────────────────
{
    section('B — "169 REVISED"');

    const out = g.expandInvoice(INVOICE_169);
    ck('it is recognised as a revision', out.revised === true);
    ck('  and says which invoice it probably replaces',
       out.warnings.some((w) => /REVISED/.test(w) && /\b169\b/.test(w)),
       JSON.stringify(out.warnings));
    ck('  while still importing normally', out.records.length === 6,
       'a flag is not a refusal — the six containers are real either way');

    const plain = g.expandInvoice({ ...INVOICE_169, invoice_no: '170' });
    ck('an ordinary invoice is not flagged',
       plain.revised === false && !plain.warnings.some((w) => /REVISED/.test(w)),
       JSON.stringify(plain.warnings));
}

// ── C — WHERE IT REFUSES TO GUESS ─────────────────────────────────────────
// Her instruction was to flag rather than divide when the scale quantity and
// the container count disagree. This is that, and the money staying visible
// is the point.
{
    section('C — scale tickets that do not line up');

    const odd = g.expandInvoice({
        ...INVOICE_169,
        total: 5580,
        lines: [INVOICE_169.lines[0], INVOICE_169.lines[1],
                { product: 'SCALE TICKETS', description: 'SCALE TICKETS', qty: 4, rate: 80, amount: 320 }],
    });
    ck('nothing is attributed', odd.records.every((r) => r.extra_scale_charge === 0),
       JSON.stringify(odd.records.map((r) => r.extra_scale_charge)));
    ck('  the containers keep their line haul', odd.records.every((r) => r.amount === 850));
    ck('  and it says so, with the figure',
       odd.warnings.some((w) => /qty 4 but 6 containers/i.test(w) && /320/.test(w)),
       JSON.stringify(odd.warnings));
    ck('  the unsplit money still counts against the invoice total',
       odd.accounted === 5420, String(odd.accounted));

    // Scale tickets and no containers at all.
    const orphan = g.expandInvoice({ invoice_no: '171', lines: [INVOICE_169.lines[2]], total: 480 });
    ck('scale tickets with no containers are reported, not dropped',
       orphan.records.length === 0 && orphan.warnings.some((w) => /no containers/i.test(w)),
       JSON.stringify(orphan.warnings));
}

// ── D — THE LINE THAT DISAGREES WITH ITSELF ───────────────────────────────
// qty × rate ≠ amount. The amount is the money she is billed, so that wins —
// and it is said out loud, because a rate quietly ignored is how a wrong
// per-container cost gets into the ledger and stays there.
{
    section('D — qty × rate does not equal the amount');

    const out = g.expandInvoice({
        invoice_no: '172', total: 1700,
        lines: [{ product: 'BKNG#PHX6A1731600', description: 'BKNG#PHX6A1731600\nSMCU1176865\nSMCU1033036',
                  qty: 2, rate: 800, amount: 1700 }],
    });
    ck('the AMOUNT decides, not the rate', out.records.every((r) => r.line_haul === 850),
       JSON.stringify(out.records.map((r) => r.line_haul)));
    ck('  and the disagreement is reported',
       out.warnings.some((w) => /850/.test(w) && /1700/.test(w) && /800/.test(w)),
       JSON.stringify(out.warnings));

    // qty that disagrees with how many containers are actually listed.
    const mismatch = g.expandInvoice({
        invoice_no: '173', total: 2550,
        lines: [{ product: 'BKNG#X', description: 'BKNG#PHX6A9999999\nSMCU1176865\nSMCU1033036\nCAIU9924305',
                  qty: 2, rate: 850, amount: 2550 }],
    });
    ck('a qty that disagrees with the containers listed is flagged',
       mismatch.warnings.some((w) => /qty is 2 but 3 container/i.test(w)),
       JSON.stringify(mismatch.warnings));
    ck('  and all three containers are still imported', mismatch.records.length === 3);
}

// ── E — THE CHECK THAT CATCHES A MISSED CONTAINER ─────────────────────────
// The failure nothing else would see: the model reads five of six containers,
// every individual figure looks ordinary, and the import is quietly short.
{
    section('E — lines that do not add up to the invoice');

    const short = g.expandInvoice({
        invoice_no: '174', total: 5580,
        lines: [{ product: 'BKNG#PHX6A1731600', description: 'BKNG#PHX6A1731600\nSMCU1176865',
                  qty: 1, rate: 850, amount: 850 }],
    });
    ck('it does not reconcile', short.reconciled === false, String(short.reconciled));
    ck('  and names the gap',
       short.warnings.some((w) => /unaccounted/i.test(w) && /4730/.test(w)),
       JSON.stringify(short.warnings));

    // No stated total — cannot reconcile, must not claim to.
    const noTotal = g.expandInvoice({ invoice_no: '175', lines: [INVOICE_169.lines[0]] });
    ck('with no printed total it reports null rather than true',
       noTotal.reconciled === null, String(noTotal.reconciled));
}

// ── F — AN UNRECOGNISED CHARGE IS SURFACED, NOT ABSORBED ──────────────────
{
    section('F — a charge line that is neither a container nor scale');

    const out = g.expandInvoice({
        invoice_no: '176', total: 2130,
        lines: [INVOICE_169.lines[0],
                { product: 'CHASSIS RENT', description: 'CHASSIS RENT 3 DAYS', qty: 3, rate: 50, amount: 150 },
                { product: 'SCALE TICKETS', description: 'SCALE TICKETS', qty: 2, rate: 80, amount: 160 }],
    });
    ck('it is not silently treated as scale', out.scale_total === 160, String(out.scale_total));
    ck('  nor folded into a container',
       out.records.every((r) => r.line_haul === 850 && r.other_charge === 0),
       JSON.stringify(out.records.map((r) => [r.line_haul, r.other_charge])));
    ck('  and it is reported by name and amount',
       out.warnings.some((w) => /Unrecognised charge/i.test(w) && /CHASSIS RENT/i.test(w) && /150/.test(w)),
       JSON.stringify(out.warnings));
    ck('  while the scale tickets that DO line up still split',
       out.records.every((r) => r.extra_scale_charge === 80), 'qty 2, two containers');
}

// ── G — RUBBISH IN ─────────────────────────────────────────────────────────
// A trucking invoice that does not fit the shape is a thing to look at, not a
// crash. A throw here loses the other invoices in the same upload.
{
    section('G — it does not throw');

    for (const [label, input] of [
        ['null', null], ['a string', 'nonsense'], ['no lines', { invoice_no: '1' }],
        ['lines not an array', { invoice_no: '1', lines: 'x' }],
        ['an empty line', { invoice_no: '1', lines: [{}] }],
        ['a line with no numbers', { invoice_no: '1', lines: [{ product: 'SMCU1176865', description: 'SMCU1176865' }] }],
    ]) {
        let err = null; let out = null;
        try { out = g.expandInvoice(input); } catch (e) { err = e; }
        ck(`  ${label}`, !err && !!out && Array.isArray(out.records), err && err.message);
    }

    // The last one is worth its own assertion: a container with no money
    // still becomes a record, so she sees it was on the invoice.
    const noMoney = g.expandInvoice({ invoice_no: '1', lines: [{ product: 'SMCU1176865', description: 'SMCU1176865' }] });
    ck('a container with no amount is still a row', noMoney.records.length === 1
        && noMoney.records[0].container_no === 'SMCU1176865', JSON.stringify(noMoney.records));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
