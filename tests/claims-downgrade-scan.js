// ── tests/claims-downgrade-scan.js — a DOWNGRADE, read off the paper ─────
//
// Apsara, 2026-10-30, with Taewon Automotive's claim report for 26JY73:
// "this is one such claim type".
//
// ── WHAT THAT DOCUMENT IS, AND WHY IT DID NOT FIT ────────────────────────
// 77 combos invoiced as AL Combo at $1,000/MT. 46 of them arrived as Steel
// Combo, worth $645/MT. All 20,775 kg arrived — nothing is missing. The
// claim is the price gap on the weight affected:
//
//     12.972 MT x ($1,000 - $645) = $4,605.06
//
// helpers/claims.js already computes that exactly, under the 'grade'
// assessment. The gap was upstream: claimScan's schema described a
// SHORTAGE — invoice_weight against claimed_weight — and had nowhere to put
// two prices, two grade names or a piece count. Scanned as it was, 12.972
// would land in claimed_weight, which means "the weight received", and
// Jarvis would work out a 7.8 MT shortage that never happened.
//
// ── WHAT IS ASSERTED ─────────────────────────────────────────────────────
// Not the model. The model is stubbed, because what is being protected is
// the CONTRACT around it: the fields exist, a downgrade's numbers survive
// the trip into a claim, they arrive as PREFILL rather than as an assessed
// figure, and the page opens on the right form. claimScan's own header
// states the rule this file holds it to — a scan "does not create a
// confirmed claim or a money figure".

const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-dg-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated — refusing to run against her claims');
    process.exit(1);
}
const claims = require(path.join(ROOT, 'helpers/claims'));
const claimScan = require(path.join(ROOT, 'helpers/claimScan'));

// Taewon's figures, exactly as printed on the report.
const TAEWON = {
    doc_type: 'claim report',
    customer: 'TAEWON AUTOMOTIVE CO., LTD.',
    invoice_no: '26JY73',
    container_no: 'MSKU0601389',
    invoice_weight: 20775, weight_unit: 'KG',
    claimed_weight: null,
    stated_claim_amount: 4605.06, currency: 'USD',
    date: 'Oct-29th-2026',
    what_is_claimed: 'Steel Combo 46 pcs were received against AL Combo invoiced',
    grade_sold: 'AL Combo', grade_received: 'Steel Combo',
    price_sold: 1000, price_received: 645, price_unit: 'MT',
    affected_weight: 12.972,
    pieces_total: 77, pieces_affected: 46,
};

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — the arithmetic was never the problem');
// Stated first so the rest of the file is honestly scoped: the engine
// already handled this claim type to the cent.
{
    const c = await claims.create({ customer: 'Taewon Automotive', invoice_no: '26JY73',
        container_no: 'MSKU0601389', weight_unit: 'MT' }, 'test');
    const r = await claims.assess(c.id, { assessment: 'grade', weight_unit: 'MT',
        grade_sold: 'AL Combo', grade_received: 'Steel Combo',
        grade_weight: 12.972, grade_price_sold: 1000, grade_price_received: 645 }, 'test');
    ck('Jarvis works out Taewon\'s own total', r.claim_amount === 4605.06,
       `got ${r.claim_amount}, their report says 4605.06`);
}

// ══════════════════════════════════════════════════════════════════════════
section('B — the scanner now has somewhere to put a downgrade');
{
    const src = fs.readFileSync(path.join(ROOT, 'helpers/claimScan.js'), 'utf8');
    for (const f of ['grade_sold', 'grade_received', 'price_sold', 'price_received',
        'price_unit', 'affected_weight', 'pieces_total', 'pieces_affected']) {
        ck(`  it is asked for ${f}`, new RegExp(`"${f}"`).test(src), 'not in the schema');
    }
    // The two rules that stop the model turning this back into a shortage.
    ck('  it is told a downgrade is NOT a shortage', /A downgrade is NOT a shortage/.test(src));
    ck('    and to leave claimed_weight null when the full weight arrived',
       /leave claimed_weight null/.test(src));
    ck('  and that a printed DIFFERENCE is not one of the two prices',
       /that is NOT a price/.test(src),
       'their report prints "Price Difference: $355/MT" — read as price_sold it '
       + 'would produce a claim of 12.972 x 355 x ... nonsense');
}

// ══════════════════════════════════════════════════════════════════════════
section('C — Taewon\'s numbers survive the trip into a claim');
{
    const rec = await claims.create({
        customer: TAEWON.customer, invoice_no: TAEWON.invoice_no,
        container_no: TAEWON.container_no,
        stated_claim_amount: TAEWON.stated_claim_amount,
        stated_grade_sold: TAEWON.grade_sold,
        stated_grade_received: TAEWON.grade_received,
        stated_price_sold: TAEWON.price_sold,
        stated_price_received: TAEWON.price_received,
        stated_price_unit: TAEWON.price_unit,
        stated_affected_weight: TAEWON.affected_weight,
        stated_pieces_total: TAEWON.pieces_total,
        stated_pieces_affected: TAEWON.pieces_affected,
    }, 'scan');

    ck('the two grades are kept', rec.stated_grade_sold === 'AL Combo'
       && rec.stated_grade_received === 'Steel Combo',
       JSON.stringify({ s: rec.stated_grade_sold, r: rec.stated_grade_received }));
    ck('  both prices, and the unit they are per', rec.stated_price_sold === 1000
       && rec.stated_price_received === 645 && rec.stated_price_unit === 'MT',
       JSON.stringify({ s: rec.stated_price_sold, r: rec.stated_price_received, u: rec.stated_price_unit }));
    ck('  the weight affected', rec.stated_affected_weight === 12.972, String(rec.stated_affected_weight));
    ck('  and the piece count, which is the evidence',
       rec.stated_pieces_affected === 46 && rec.stated_pieces_total === 77,
       JSON.stringify({ a: rec.stated_pieces_affected, t: rec.stated_pieces_total }));

    // ── THE RULE THE WHOLE SCAN PATH RESTS ON ────────────────────────────
    // claimScan's header: a scan "does not create a confirmed claim or a
    // money figure". Reading a figure off a photograph and booking it is the
    // one thing that would make every claim in the system unauditable.
    ck('creating it books NO money', rec.claim_amount === null, String(rec.claim_amount));
    ck('  and sets no ASSESSED grade field', rec.grade_price_sold === null
       && rec.grade_price_received === null && rec.grade_weight === null,
       JSON.stringify({ ps: rec.grade_price_sold, pr: rec.grade_price_received, w: rec.grade_weight }));
    ck('  it is unverified until she says otherwise', rec.status === 'unverified', rec.status);

    // ── AND THE PAGE HAS TO SEND IT THAT WAY (2026-10-30) ────────────────
    // The three checks above call claims.create() directly with stated_*
    // fields, so they prove the ENGINE keeps the split. They say nothing
    // about what the scan modal actually posts — and a mutation swapping
    // stated_price_sold for grade_price_sold in that POST SURVIVED all of
    // them. The scan would then book a figure read off a photograph, which
    // is the one thing claimScan's header forbids.
    //
    // Scoped to the scan's own create call, with the scope asserted, for the
    // reason tests/claims-sorted.js records: a check that a sibling block can
    // satisfy is not testing this block.
    {
        const page = fs.readFileSync(path.join(ROOT, 'dashboard/claims.html'), 'utf8');
        const at = page.indexOf("created_by: 'scan',");
        const from = page.lastIndexOf("api('/api/claims'", at);
        const body = at > 0 && from > 0 ? page.slice(from, at) : '';
        ck('  the scan\'s create call is found', !!body && body.length < 1600,
           `scope is ${body.length} chars — the checks below need it isolated`);
        ck('    it posts the prices as STATED, not as assessed',
           /stated_price_sold:/.test(body) && /stated_price_received:/.test(body), body.slice(0, 200));
        ck('    and posts no grade_* figure at all',
           !/grade_price_sold:|grade_price_received:|grade_weight:/.test(body),
           'a scan that books an assessed figure makes every claim unauditable');
    }

    // And confirming it on the pane produces Taewon's figure.
    const done = await claims.assess(rec.id, { assessment: 'grade', weight_unit: 'MT',
        grade_sold: rec.stated_grade_sold, grade_received: rec.stated_grade_received,
        grade_weight: rec.stated_affected_weight,
        grade_price_sold: rec.stated_price_sold,
        grade_price_received: rec.stated_price_received }, 'apsara');
    ck('confirming the prefilled pane gives their total', done.claim_amount === 4605.06,
       `got ${done.claim_amount}`);
}

// ══════════════════════════════════════════════════════════════════════════
section('D — a backwards price pair is dropped, not offered');
// helpers/claims.js refuses a received grade priced ABOVE the grade sold.
// Letting the model's reading through anyway would hand her a form she can
// fill in and then be refused on, which is a worse experience than no
// prefill at all.
{
    const same = { ...TAEWON, price_sold: 645, price_received: 1000 };
    // The drop happens inside scan(); exercised here through the same helper
    // it lives in, by reading the rule back out of the source.
    const src = fs.readFileSync(path.join(ROOT, 'helpers/claimScan.js'), 'utf8');
    ck('the scanner drops a pair where the received grade is worth more',
       /fields\.price_received > fields\.price_sold/.test(src)
       && /fields\.price_sold = null/.test(src), 'no such guard in claimScan');

    // And the engine still refuses it, so the guard is belt and braces.
    const c = await claims.create({ customer: 'Backwards Co', invoice_no: 'BK1',
        container_no: 'BKWD1234567' }, 'test');
    let threw = null;
    try {
        await claims.assess(c.id, { assessment: 'grade', weight_unit: 'MT',
            grade_weight: 10, grade_price_sold: same.price_sold,
            grade_price_received: same.price_received }, 'test');
    } catch (e) { threw = e; }
    ck('  and the engine refuses it too', !!threw && /priced above/.test(threw.message),
       threw && threw.message);
}

// ══════════════════════════════════════════════════════════════════════════
section('E — the SCREEN opens on the downgrade form, not the shortage one');
// assessOf() decides which pane is shown. Its default is 'weight'. A scanned
// downgrade that opens on the shortage form asks her for an invoiced and a
// received weight that this claim does not have.
{
    const html = fs.readFileSync(path.join(ROOT, 'dashboard/claims.html'), 'utf8');
    const SCRIPT = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)]
        .map((m) => m[1]).join('\n');
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
    dom.window.fetch = () => new Promise(() => {});
    dom.window.setInterval = () => 0;
    let evalError = null;
    try { dom.window.eval(SCRIPT); } catch (e) { evalError = e; }
    ck('the claims page still runs', evalError === null,
       evalError && `${evalError.constructor.name}: ${evalError.message}`);

    const w = dom.window;
    const scanned = { id: 'S1', status: 'unverified', container_no: 'MSKU0601389',
        customer: TAEWON.customer, invoice_no: '26JY73',
        stated_price_sold: 1000, stated_price_received: 645,
        stated_grade_sold: 'AL Combo', stated_grade_received: 'Steel Combo',
        stated_affected_weight: 12.972, stated_pieces_total: 77, stated_pieces_affected: 46 };
    ck('  a scanned downgrade opens on the downgrade pane',
       typeof w.assessOf === 'function' && w.assessOf(scanned) === 'grade',
       typeof w.assessOf === 'function' ? w.assessOf(scanned) : 'assessOf is not reachable');

    // Nothing else moves. A weight claim still opens on the weight form.
    ck('  a shortage still opens on the weight form',
       w.assessOf({ id: 'S2', invoice_weight: 20, claimed_weight: 18 }) === 'weight',
       w.assessOf({ id: 'S2', invoice_weight: 20, claimed_weight: 18 }));
    ck('  and a stated-quantity claim still opens on quality',
       w.assessOf({ id: 'S3', stated_qty: 5 }) === 'quality',
       w.assessOf({ id: 'S3', stated_qty: 5 }));

    // The pane itself carries the document's figures and the piece count.
    let card = null, threw = null;
    try { card = w.claimCard(scanned, 0, {}); } catch (e) { threw = e; }
    ck('  the card renders', !threw && typeof card === 'string',
       threw && `${threw.constructor.name}: ${threw.message}`);
    ck('    prefilled with both prices from the document',
       /value="1000"/.test(card || '') && /value="645"/.test(card || ''),
       'the pane opened empty — she would retype what the scan already read');
    ck('    and the weight affected', /value="12.972"/.test(card || ''));
    ck('    showing 46 of 77 as the evidence behind it',
       /46<\/b> of 77 pieces/.test(card || '') || /46<\/b> of 77/.test(card || ''),
       'the piece count is the fact their photographs show');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }

})().catch((e) => { console.error('\nCRASHED: ' + (e && e.stack || e)); process.exit(1); });
