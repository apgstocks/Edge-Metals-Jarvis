// ── tests/claim-po-gate.js ───────────────────────────────────────────────
// Apsara, 2026-10-14: her real claim mail names PO10554 and no container, so
// claimParse's gate answered hit:false and nothing ever read it.
//
//   A  the same mail now gets through — the fix, measured against the bug
//   B  the key is FILLED from her order, not weakened
//   C  what the buyer wrote always wins over her records
//   D  an ambiguous reference fills NOTHING
//   E  a mail quoting a container is untouched (the regression that matters)
//   F  the gate stays TWO conditions, and survives a missing sales store
//   G  the weight only fills when the units agree
//
// The design decision under test: a claim is still keyed on
// (invoice_no, container_no) exactly as before. Resolving the order fills
// those in rather than introducing a second key shape — because claims
// dedupe on that key, and two key shapes means two claims for one container
// the first time a buyer quotes the container instead of the PO.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-claimgate-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const R = (p) => path.join(ROOT, p);
const cfg = require(R('config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('  ABORT  config not isolated'); process.exit(1); }

// claimParse destructures callGeminiJSON at load, so the patch goes on the
// module object before claimParse is required — same approach as
// tests/claims-intake.js.
const gemini = require(R('helpers/gemini.js'));
let REPLY = null;
gemini.callGeminiJSON = async () => (typeof REPLY === 'function' ? REPLY() : REPLY);

const claimParse = require(R('helpers/claimParse'));
const claimRef = require(R('helpers/claimRef'));

const SALES = [
    { id: 's1', reference: 'PO10554', invoice_no: '26JY05', container_no: 'MSCU7654321',
      booking_no: 'BK88812', customer: 'Alternator Buyers Ltd',
      item: 'Alternator/Starter/Compressor', weight: 48500, invoice_price: 2400 },
    // A PO shipped as three containers — ambiguous on purpose.
    { id: 'm1', reference: 'PO20001', invoice_no: '26AA01', container_no: 'AAAU1111111', customer: 'Buyer', weight: 44000 },
    { id: 'm2', reference: 'PO20001', invoice_no: '26AA02', container_no: 'BBBU2222222', customer: 'Buyer', weight: 45000 },
    { id: 'm3', reference: 'PO20001', invoice_no: '26AA03', container_no: 'CCCU3333333', customer: 'Buyer', weight: 46000 },
];
const writeSales = (rows) => { fs.writeFileSync(cfg.SALES_FILE, JSON.stringify(rows, null, 2)); claimRef._reset(); };
writeSales(SALES);

const BODY = `Good afternoon,
This email is regarding PO10554, under which Alternator/Starter/Compressor materials were loaded.
Upon arrival at the destination, our buyer raised a quality claim as well as a weight shortage claim. The details are as follows:
1. Quality Claim - MS Scrap
* Quantity: 1.005 MT
* Rate: USD 2,318/MT
* Total Claim: USD 2,329
2. Weight Shortage Claim
* Shortage: 1.114 MT
* Rate: USD 2,479/MT
* Total Claim: USD 2,761
Total Claim Amount: USD 5,090`;
const MAIL = { subject: 'Claim against PO10554', body: BODY, from: 'buyer@example.com' };

// What the model would plausibly return for her mail: the shortage figures,
// the unit stated in words, and NO container or invoice, because the mail
// contains neither. Quotes are real spans so keepGroundedQuotes keeps them.
const MODEL_SAW = () => ({
    // is_claim is the first thing extract() checks (claimParse.js:218) — a
    // reply without it is "not a claim" and returns null before any of this
    // file's behaviour is reached.
    is_claim: true,
    fields: { customer: '', supplier: '', invoice_no: '', container_no: '',
        invoice_weight: null, claimed_weight: null, weight_unit: 'MT',
        stated_claim_amount: 5090 },
    quotes: { weight_unit: '1.114 MT', stated_claim_amount: 'Total Claim Amount: USD 5,090' },
    confidence: 0.9, reason: 'buyer raised a quality claim as well as a weight shortage claim',
});

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — the same mail now gets through');

{
    const g = claimParse.gate(MAIL);
    ck('the gate passes it', g.hit === true, JSON.stringify(g.why));
    ck('  because it names one of her orders', (g.orders || []).includes('PO10554'),
       JSON.stringify(g.orders));
    ck('  and says so in why', (g.why || []).some((w) => /order PO10554/.test(w)), JSON.stringify(g.why));
    // It still finds no container, and that is fine — the point is that the
    // absence is no longer fatal.
    ck('  while still finding no container number', g.containers.length === 0);

    // THE BUG, as it was. A mail with the same words and a PO she does NOT
    // have must still be dropped, or the gate has simply been opened.
    const unknown = claimParse.gate({ ...MAIL, subject: 'Claim against PO99999',
        body: BODY.replace(/PO10554/g, 'PO99999') });
    ck('a PO she does not have is still dropped', unknown.hit === false, JSON.stringify(unknown.why));
    ck('  saying neither a container nor an order of hers was named',
       (unknown.why || []).some((w) => /no order of hers named/.test(w)), JSON.stringify(unknown.why));
}

// ══════════════════════════════════════════════════════════════════════════
section('B — the key is filled from her order, not weakened');

{
    REPLY = MODEL_SAW;
    const got = await claimParse.extract(MAIL);
    ck('extraction no longer refuses', !!got, 'it returned null, so the claim is still dropped');
    const f = got.fields;
    // THE WHOLE POINT: the claim is keyed exactly as a container-quoting mail
    // would key it.
    ck('  the container is filled from her order', f.container_no === 'MSCU7654321', f.container_no);
    ck('  and the invoice number', f.invoice_no === '26JY05', f.invoice_no);
    ck('  the customer too', f.customer === 'Alternator Buyers Ltd', f.customer);
    ck('  and the order it came from is recorded', f.order_ref === 'PO10554', f.order_ref);
    // Provenance. "Why did this claim attach to that container" has to be
    // answerable from the claim itself, not from a log.
    ck('  with a quote naming where it came from',
       /her own order details: reference PO10554/.test(got.quotes.container_no || ''),
       got.quotes.container_no);
    ck('  and the resolved order is handed back', got.order && got.order.sale_id === 's1',
       JSON.stringify(got.order && got.order.sale_id));
    // What the model DID read is untouched.
    ck('the stated amount survives', f.stated_claim_amount === 5090, String(f.stated_claim_amount));
    ck('  and the unit it read in words', f.weight_unit === 'MT', f.weight_unit);
}

// ══════════════════════════════════════════════════════════════════════════
section('C — what the buyer wrote wins');
// This fills blanks. It does not correct him: if he quotes a container, that
// is the container, even when her order says another.

{
    REPLY = () => ({
        is_claim: true,
        fields: { ...MODEL_SAW().fields, invoice_no: '26ZZ99', container_no: 'ZZZU0000000' },
        quotes: { invoice_no: 'PO10554', container_no: 'PO10554' },   // grounded spans
        confidence: 0.9, reason: 'x',
    });
    const got = await claimParse.extract({ ...MAIL,
        body: `${BODY}\nOur records show container ZZZU0000000 under invoice 26ZZ99.` });
    ck('a container the mail states is kept', got.fields.container_no === 'ZZZU0000000',
       got.fields.container_no);
    ck('  and so is its invoice number', got.fields.invoice_no === '26ZZ99', got.fields.invoice_no);
    ck('  her order does not overwrite either',
       got.fields.container_no !== 'MSCU7654321' && got.fields.invoice_no !== '26JY05');

    // ── THE CASE THAT ACTUALLY EXERCISES THE GUARD ──────────────────────
    // Above, the model returned BOTH fields, so `if (!container || !invoice)`
    // short-circuits and no resolution happens at all — which means a
    // mutation removing the inner `!fields.container_no` check SURVIVED.
    // The guard only matters when resolution DOES run: one field blank, and
    // a container quoted that is NOT the one on her order.
    REPLY = () => ({
        is_claim: true,
        fields: { ...MODEL_SAW().fields, invoice_no: '', container_no: 'QQQU5555555' },
        quotes: { container_no: 'PO10554' },
        confidence: 0.9, reason: 'x',
    });
    const mixed = await claimParse.extract({ ...MAIL,
        body: `${BODY}\nThe box in question is QQQU5555555.` });
    ck('with a blank invoice, her order IS consulted', mixed.fields.invoice_no === '26JY05',
       mixed.fields.invoice_no);
    ck('  and STILL does not overwrite the container he quoted',
       mixed.fields.container_no === 'QQQU5555555',
       `${mixed.fields.container_no} — her order says MSCU7654321, and his word wins`);
}

// ══════════════════════════════════════════════════════════════════════════
section('D — an ambiguous reference fills nothing');
// PO20001 is three containers. Picking the first would attach the claim to
// the wrong box, which is worse than leaving it for a person.

{
    REPLY = MODEL_SAW;
    const body = BODY.replace(/PO10554/g, 'PO20001');
    const g = claimParse.gate({ subject: 'Claim PO20001', body });
    ck('the gate still passes it', g.hit === true, JSON.stringify(g.why));
    const got = await claimParse.extract({ subject: 'Claim PO20001', body, from: 'b@x.com' });
    // With nothing to key on and no single order, it is dropped — the SAME
    // as before, deliberately. A person sees the mail; Jarvis does not guess.
    ck('but extraction fills no container', !got || !got.fields.container_no,
       got && got.fields.container_no);
    ck('  and does not invent a claim against one of the three',
       got === null, 'a wrong container is worse than no claim');
}

// ══════════════════════════════════════════════════════════════════════════
section('E — a mail quoting a container is untouched');
// The regression that matters. Every claim mail that worked before must
// behave identically, resolver or no resolver.

{
    const body = 'Weight shortage claim on container MSCU7654321, we received 21.582 MT against 22.696 MT invoiced.';
    const g = claimParse.gate({ subject: 'shortage', body });
    ck('it passes on the container, as it always did', g.hit === true, JSON.stringify(g.why));
    ck('  and why names the container, not the order',
       (g.why || []).some((w) => /container MSCU7654321/.test(w)), JSON.stringify(g.why));

    REPLY = () => ({
        is_claim: true,
        fields: { customer: '', supplier: '', invoice_no: '', container_no: 'MSCU7654321',
            invoice_weight: 22.696, claimed_weight: 21.582, weight_unit: 'MT', stated_claim_amount: null },
        quotes: { container_no: 'MSCU7654321', invoice_weight: '22.696 MT',
            claimed_weight: '21.582 MT', weight_unit: '21.582 MT' },
        confidence: 0.95, reason: 'weight shortage claim',
    });
    const got = await claimParse.extract({ subject: 'shortage', body, from: 'b@x.com' });
    ck('the container the mail quoted is the key', got.fields.container_no === 'MSCU7654321');
    ck('  the weights it read are unchanged',
       got.fields.invoice_weight === 22.696 && got.fields.claimed_weight === 21.582,
       `${got.fields.invoice_weight} / ${got.fields.claimed_weight}`);
    // The invoice number WAS blank and her order has one, so filling it is
    // the new, wanted behaviour even here.
    ck('  and the blank invoice number is filled from her order',
       got.fields.invoice_no === '26JY05', got.fields.invoice_no);
}

// ══════════════════════════════════════════════════════════════════════════
section('F — two conditions, and a missing store is survivable');

{
    // Language alone must NEVER be enough. A mail about a weight that names
    // no order and no container would otherwise cost a model call each time
    // five watchers see it.
    const noId = claimParse.gate({ subject: 'rates', body: 'our net weight tolerance is 0.5% on any shortage claim' });
    ck('shortage language with no identifier is refused', noId.hit === false, JSON.stringify(noId.why));
    // And an order named in a mail that is NOT a claim is refused too.
    const notClaim = claimParse.gate({ subject: 'PO10554 shipped',
        body: 'PO10554 has sailed, documents to follow.' });
    ck('an order named in a non-claim mail is refused', notClaim.hit === false, JSON.stringify(notClaim.why));
    ck('  for the right reason', (notClaim.why || []).some((w) => /no shortage language/.test(w)),
       JSON.stringify(notClaim.why));

    // An unreadable sales store must not break the path that already worked.
    // replyWatch's loop must not be disturbed by it.
    fs.writeFileSync(cfg.SALES_FILE, '{ this is not json');
    claimRef._reset();
    const stillWorks = claimParse.gate({ subject: 'shortage',
        body: 'weight shortage on container MSCU7654321' });
    ck('with a torn sales file, a container mail still passes', stillWorks.hit === true,
       JSON.stringify(stillWorks.why));
    ck('  and a PO mail degrades to refused rather than throwing',
       claimParse.gate(MAIL).hit === false);
    writeSales(SALES);

    // Injectable, so the gate is testable without a store at all.
    const injected = claimParse.gate({ ...MAIL, refs: () => ['PO10554'] });
    ck('refs can be injected', injected.hit === true, JSON.stringify(injected.why));
}

// ══════════════════════════════════════════════════════════════════════════
section('G — the invoiced weight only fills when the units agree');
// sales.js stores weight in POUNDS. Her mails quote MT. Filling 48500 beside
// a 1.114 MT shortage is the 2204x error this file leaves weight_unit null
// to avoid, so the fill is refused unless the mail's own unit matches.

{
    REPLY = MODEL_SAW;                                  // weight_unit: 'MT'
    const inMt = await claimParse.extract(MAIL);
    ck('an MT mail does NOT take her pounds figure', inMt.fields.invoice_weight === null,
       `${inMt.fields.invoice_weight} lb would be compared against MT`);

    // The same mail with the unit read as LB — now the figures are
    // comparable and the fill is right.
    REPLY = () => ({ ...MODEL_SAW(), fields: { ...MODEL_SAW().fields, weight_unit: 'LB' },
        quotes: { weight_unit: '1.114 MT' } });
    const inLb = await claimParse.extract(MAIL);
    ck('a mail in pounds does take it', inLb.fields.invoice_weight === 48500,
       String(inLb.fields.invoice_weight));

    // And when the mail stated NO unit at all, nothing is filled — the
    // existing rule that a unitless claim waits for a person.
    REPLY = () => ({ ...MODEL_SAW(), fields: { ...MODEL_SAW().fields, weight_unit: null }, quotes: {} });
    const noUnit = await claimParse.extract(MAIL);
    ck('a unitless mail fills no weight', noUnit.fields.invoice_weight === null);
    ck('  but still keys onto the right container', noUnit.fields.container_no === 'MSCU7654321',
       'the key does not depend on the unit');
}

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log('  - ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('ABORT', e); process.exit(1); });
