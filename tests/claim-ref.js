// ── tests/claim-ref.js ───────────────────────────────────────────────────
// Apsara, 2026-10-14, forwarding a real claim mail: "If there is a claim,if
// i ask jarvis to read it,it has everything with it right?like bills and
// invoice,it should auto fill everything right" — and, asked where PO10554
// lives: "It wll be in reference of order details in my sheet".
//
// The answer was no, and not subtly: her mail names PO10554 and no
// container, so claimParse.js's gate returned hit:false ("no container
// number") and no model was ever called. Nothing reached the Claims page.
//
//   A  her real mail, through the real gate — the bug, measured
//   B  an order is found by the REFERENCE she actually has
//   C  membership, not pattern: it cannot invent an order
//   D  the auto-fill, and the UNIT that travels with the weight
//   E  one reference, several containers
//   F  the index is cached, and notices a new order
//
// The design decision these pin: resolution is a LOOKUP IN HER OWN DATA,
// not a /PO\s?\d+/ regex. A pattern would pass any mail containing "PO" and
// digits straight to the model — and the gate exists precisely to keep model
// calls off mail that is not a claim.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-claimref-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('  ABORT  config not isolated'); process.exit(1); }

const claimRef = require(path.join(ROOT, 'helpers/claimRef'));
const claimParse = require(path.join(ROOT, 'helpers/claimParse'));

// Her order, as the sheet's Order Details tab carries it: the PO in
// `reference`, and the weight in POUNDS, which is what sales.js stores.
const SALES = [
    { id: 's1', reference: 'PO10554', invoice_no: '26JY05', container_no: 'MSCU7654321',
      booking_no: 'BK88812', customer: 'Alternator Buyers Ltd', item: 'Alternator/Starter/Compressor',
      weight: 48500, invoice_price: 2400, date: '2026-08-02' },
    { id: 's2', reference: 'PO10555', invoice_no: '26JY06', container_no: 'TGHU1112223',
      customer: 'Someone Else', item: 'MS Scrap', weight: 44000, invoice_price: 2200, date: '2026-08-09' },
    // The junk a real sheet carries, which must never match.
    { id: 's3', reference: 'NA', invoice_no: '', container_no: '', customer: 'Blank Row' },
    { id: 's4', reference: 'TBD', invoice_no: '', container_no: '', customer: 'Another Blank' },
];
const writeSales = (rows) => fs.writeFileSync(cfg.SALES_FILE, JSON.stringify(rows, null, 2));
writeSales(SALES);
claimRef._reset();

// Her mail, verbatim apart from the bullet glyphs.
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
Total Claim Amount: USD 5,090
We have attached all supporting evidence in the link provided below for your review.
https://drive.google.com/drive/folders/1WokvHI5jKFF5QPzYQ4742oWlTaI1Zbad?usp=sharing`;
const MAIL = { subject: 'Claim against PO10554', body: BODY, from: 'buyer@example.com' };

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — her real mail, through the real gate');

{
    const g = claimParse.gate(MAIL);
    // THE BUG, stated as a measurement rather than a description. If this
    // ever starts passing on its own, the gate changed and the rest of this
    // file is testing something that no longer happens.
    ck('TODAY the gate drops it', g.hit === false, JSON.stringify(g.why));
    ck('  and says why: no container number',
       (g.why || []).some((w) => /no container number/.test(w)), JSON.stringify(g.why));
    // It is NOT a language problem — the mail is unmistakably a claim. Only
    // the identifier was unrecognised, which is what makes this fixable
    // without touching the shortage vocabulary.
    ck('  while agreeing it IS claim language', g.language === true,
       'the words were never the problem');
    ck('  and finds no ISO 6346 container, correctly',
       claimParse.containersIn(BODY).length === 0, JSON.stringify(claimParse.containersIn(BODY)));
}

// ══════════════════════════════════════════════════════════════════════════
section('B — the order is found by the reference she has');

{
    const hits = claimRef.resolve(BODY);
    ck('PO10554 resolves to exactly one order', hits.length === 1, JSON.stringify(hits.map((h) => h.sale_id)));
    const h = hits[0];
    ck('  the right one', h.sale_id === 's1', h.sale_id);
    ck('  found by the reference column', h.matched_field === 'reference', h.matched_field);
    ck('  and it records what it matched on', h.matched === 'PO10554', h.matched);

    // The same order, named three other ways a buyer might write it.
    for (const [label, text] of [
        ['with a space, "PO 10554"', 'our claim relates to PO 10554 please advise'],
        ['hyphenated, "PO-10554"', 'ref PO-10554 shortage'],
        ['lower case', 'regarding po10554 we claim'],
        ['by invoice number instead', 'claim against invoice 26JY05'],
        ['by container number instead', 'container MSCU7654321 arrived short'],
    ]) {
        const r = claimRef.resolve(text);
        ck(`  and ${label}`, r.length === 1 && r[0].sale_id === 's1',
           JSON.stringify(r.map((x) => `${x.sale_id}/${x.matched_field}`)));
    }
}

// ══════════════════════════════════════════════════════════════════════════
section('C — membership, not a pattern');
// The whole reason this is a lookup. A regex for /PO\s?\d+/ would pass any
// mail containing "PO" and digits to the model, and the gate's own header
// explains that five watchers poll these mailboxes every 5–15 minutes.

{
    ck('a PO she does not have resolves to nothing',
       claimRef.resolve('regarding PO99999, shortage claim').length === 0,
       'a pattern would have matched this');
    ck('  so would an invented invoice number',
       claimRef.resolve('claim against invoice 99ZZ99').length === 0);
    ck('ordinary mail with numbers in it resolves to nothing',
       claimRef.resolve('Our 2026 rate sheet is attached, order 12345 pending').length === 0);
    // ── THE JUNK THAT IS LONG ENOUGH TO BE DANGEROUS ────────────────────
    // "NA" and "TBD" are already refused by the four-character floor below,
    // so testing only those proved nothing about the JUNK list — a mutation
    // deleting the list entirely SURVIVED until this was rewritten. The
    // entries that earn their keep are the ones the floor lets through, and
    // one comes straight out of her own data: sheetImport.js records that
    // her local deliveries to Eccomelt "carry a PO reference and 'Local
    // Transit' instead of a container and an HBL". With that phrase in the
    // reference column, every mail mentioning local transit would become a
    // claim against it.
    writeSales([
        { id: 'j1', reference: 'Local Transit', customer: 'Eccomelt', weight: 40000 },
        { id: 'j2', reference: 'NONE', customer: 'Blank', weight: 1 },
        { id: 'j3', reference: 'TEST', customer: 'Test Row', weight: 1 },
    ]);
    claimRef._reset();
    ck('"Local Transit" in the reference column never matches',
       claimRef.resolve('the shipment moved by local transit and arrived short').length === 0,
       'her own sheet carries this phrase as a reference');
    ck('  nor "NONE"', claimRef.resolve('none of the goods were short').length === 0);
    ck('  nor "TEST"', claimRef.resolve('this is a test message about a claim').length === 0);
    writeSales(SALES);
    claimRef._reset();
    ck('usable() refuses each of those by name, not by length',
       !claimRef.usable('NONE') && !claimRef.usable('TEST')
       && !claimRef.usable('LOCAL') && !claimRef.usable('Local Transit'),
       'all four are four characters or more, so the floor does NOT catch them');
    ck('  and the short ones are refused too', !claimRef.usable('NA')
       && !claimRef.usable('TBD') && !claimRef.usable('') && !claimRef.usable('000'));
    // Short references are refused for the same reason: "1" or "AB" would
    // hit on almost any text.
    ck('  and anything under four characters', !claimRef.usable('1') && !claimRef.usable('ABC'),
       'too plain to be distinctive');
    ck('  while a real one is accepted', claimRef.usable('PO10554') && claimRef.usable('26JY05'));

    // An empty store is "no", not a crash — the state before a sheet sync
    // has ever run.
    writeSales([]);
    claimRef._reset();
    ck('with no orders at all it resolves nothing and does not throw',
       claimRef.resolve(BODY).length === 0);
    writeSales(SALES);
    claimRef._reset();
}

// ══════════════════════════════════════════════════════════════════════════
section('D — the auto-fill, and the unit that travels with it');
// Her question: "it has everything with it right?like bills and invoice,it
// should auto fill everything right".

{
    const h = claimRef.resolve(BODY)[0];
    ck('it carries the invoice number', h.invoice_no === '26JY05', h.invoice_no);
    ck('  the container', h.container_no === 'MSCU7654321', h.container_no);
    ck('  the booking', h.booking_no === 'BK88812', h.booking_no);
    ck('  the customer', h.customer === 'Alternator Buyers Ltd', h.customer);
    ck('  the material', /Alternator/.test(h.item || ''), h.item);
    ck('  the invoiced weight', h.invoice_weight === 48500, String(h.invoice_weight));
    ck('  and the invoiced rate', h.invoice_price === 2400, String(h.invoice_price));

    // ── THE 2204x TRAP ──────────────────────────────────────────────────
    // sales.js:309 stores weight in POUNDS. Her mail quotes MT. A bare
    // 48500 handed to anything holding 1.114 MT is exactly the error
    // claimParse.js leaves weight_unit null to avoid.
    ck('THE UNIT TRAVELS WITH THE WEIGHT', h.invoice_weight_unit === 'lb',
       `${h.invoice_weight_unit} — a bare number beside an MT figure is a 2204x error`);
    // And it is absent when the number is, rather than claiming pounds of
    // nothing.
    writeSales([{ id: 'n1', reference: 'PO77777', customer: 'No Weight Co' }]);
    claimRef._reset();
    const bare = claimRef.resolve('about PO77777')[0];
    ck('  and is null when there is no weight', bare.invoice_weight === null
       && bare.invoice_weight_unit === null, JSON.stringify(bare.invoice_weight_unit));
    writeSales(SALES);
    claimRef._reset();

    // NOT the supplier: a sale has none (sales.js:190 — the purchase side
    // lives on the Bill). claimPrice.js does that lookup properly.
    ck('it does NOT invent a supplier', !('supplier' in h),
       'a claim naming the wrong supplier is a recovery argued at the wrong party');
    // The rate's unit is ambiguous by her own convention, so it is passed
    // through with the convention named and no conclusion drawn.
    ck('  and it does not assert the rate\'s unit', /per lb|per MT/.test(h.invoice_price_basis || ''),
       h.invoice_price_basis);
}

// ══════════════════════════════════════════════════════════════════════════
section('E — one reference, several containers');
// A PO shipped as three containers is three sales. Picking one silently is
// how a claim gets attached to the wrong box.

{
    writeSales([
        { id: 'm1', reference: 'PO20001', invoice_no: '26AA01', container_no: 'AAAU1111111', customer: 'Buyer', weight: 44000 },
        { id: 'm2', reference: 'PO20001', invoice_no: '26AA02', container_no: 'BBBU2222222', customer: 'Buyer', weight: 45000 },
        { id: 'm3', reference: 'PO20001', invoice_no: '26AA03', container_no: 'CCCU3333333', customer: 'Buyer', weight: 46000 },
    ]);
    claimRef._reset();
    const hits = claimRef.resolve('shortage claim on PO20001');
    ck('all three are returned', hits.length === 3, String(hits.length));
    ck('  each with its own container',
       new Set(hits.map((h) => h.container_no)).size === 3,
       JSON.stringify(hits.map((h) => h.container_no)));
    ck('  and its own invoice', new Set(hits.map((h) => h.invoice_no)).size === 3);

    // ── THE MOST SPECIFIC IDENTIFIER WINS ───────────────────────────────
    // Caught by this check failing on the first version, which returned all
    // three: the buyer named a box, and answering with three is how a claim
    // gets attached to the wrong one.
    const one = claimRef.resolve('PO20001 container BBBU2222222');
    ck('naming a container as well narrows to that container', one.length === 1,
       JSON.stringify(one.map((h) => h.container_no)));
    ck('  and it is the container named', one[0].container_no === 'BBBU2222222', one[0].container_no);
    ck('  matched on the container, not the PO', one[0].matched_field === 'container_no', one[0].matched_field);
    // An invoice number is narrower than a PO too.
    const byInv = claimRef.resolve('PO20001 invoice 26AA03');
    ck('an invoice number narrows the same way', byInv.length === 1 && byInv[0].invoice_no === '26AA03',
       JSON.stringify(byInv.map((h) => h.invoice_no)));
    // TWO containers named is GENUINE ambiguity and both are kept — picking
    // the first would be inventing a decision the mail did not make.
    const two = claimRef.resolve('shortage on AAAU1111111 and CCCU3333333');
    ck('but two containers named stay two', two.length === 2,
       JSON.stringify(two.map((h) => h.container_no)));
    ck('  and the tier order is container, invoice, hbl, booking, reference',
       JSON.stringify(claimRef.TIERS) === JSON.stringify(
           ['container_no', 'invoice_no', 'hbl_no', 'booking_no', 'reference']),
       JSON.stringify(claimRef.TIERS));
    writeSales(SALES);
    claimRef._reset();
}

// ══════════════════════════════════════════════════════════════════════════
section('F — cached, but not stale');
// gate() does no I/O today and runs on every message in five mailboxes. The
// index must not re-read and re-index the store per mail — and must still
// see an order a sheet sync added a second ago.

{
    claimRef._reset();
    const a = claimRef.index();
    const b = claimRef.index();
    ck('two calls share one index', a === b, 'the second call rebuilt it');

    // A sheet sync adds the order. Keyed on mtime, not a timer, because a
    // new order has to be visible to the NEXT mail.
    const grown = SALES.concat([{ id: 's9', reference: 'PO30009', invoice_no: '26ZZ99',
        container_no: 'ZZZU9999999', customer: 'New Buyer', weight: 40000 }]);
    // mtime has millisecond resolution; the size changes too, and the cache
    // key uses both, so this is observable without a sleep.
    writeSales(grown);
    const found = claimRef.resolve('claim on PO30009');
    ck('an order added since is found without a restart', found.length === 1
       && found[0].invoice_no === '26ZZ99', JSON.stringify(found.map((h) => h.sale_id)));
    writeSales(SALES);
}

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log('  - ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('ABORT', e); process.exit(1); });
