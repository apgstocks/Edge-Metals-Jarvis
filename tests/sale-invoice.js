// ── tests/sale-invoice.js ───────────────────────────────────────────────────
// Apsara, 2026-09-19:
//
//   "if all important details of bills is entered,if i say create invoice(it
//    needs to ask-separate invoice and packing list/normal) -upon my
//    confirmation-it needs to create automatically (get verfiication from me
//    by showing that on screen)andupon confirm- mail it to the customer with
//    loading photos"
//
//   "weights_ok it should generate and then ask for my conf to mail showing
//    draft mail on screen.first need to show the generated invoice then draft
//    mail"
//
//   "Instead of create invoice->Have it as generate"
//
// ── THE ONE THAT MATTERS ────────────────────────────────────────────────────
// Section A. 260918_AP_26ARIS02 reached a buyer and a broker saying
//
//     Quantity 15,642.000 MT      where her packing list says 7.095
//
// because the POUNDS were typed into a column headed "Quantity MT" and the
// per-pound rate into one headed "Rate US$/MT". The dollars came out right,
// so nothing on the document contradicted itself.
//
// Every other section here is plumbing. This one is the reason the feature is
// worth building rather than clicking through Documents: the sale already
// knows the weight is in pounds and the price is per pound, so the conversion
// is arithmetic and arithmetic does not get tired at eleven at night.
//
// ── AND SECTION G, WHICH IS THE CLAUDE.md RULE ──────────────────────────────
// This added a requirement to shared code twice over — helpers/shipmentMail.js
// was lifted out of workflow/actions.js, and saveGeneratedInvoice out of the
// /api/invoice/generate route. Both have an existing caller that nobody was
// looking at. G asserts those callers still behave EXACTLY as before, because
// that is the mistake this repo has recorded three times.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const Module = require('module');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-saleinv-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.ADMIN_PASSWORD = 'admin-pw-ssssssssssss';

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const R = (m) => path.join(__dirname, '..', m);
const cfg = require(R('config'));
if (!String(cfg.DATA_DIR).startsWith(os.tmpdir())) {
    console.error('REFUSING TO RUN: DATA_DIR is not a temp directory — this test writes.');
    process.exit(1);
}

// ── Stub only what would leave the building ─────────────────────────────────
// Same shape as tests/shipment-docs-send.js. helpers/gmail is the one thing
// that must not be real, because the whole point of this feature is that it
// ends in an email to a customer.
let SENT = [];
const orig = Module._load;
Module._load = function (r) {
    if (r.endsWith('helpers/gmail') || r === '../helpers/gmail' || r === './helpers/gmail') return {
        getGmailRead: () => ({}), getGmailSenderRead: () => ({}), getGmailWrite: () => ({}),
        getMyEmailAddress: async () => 'apsara@edgemetals.com',
        listMessages: async () => [], getMessage: async () => ({}), getEmailContent: () => ({ body: '' }),
        parseAddressList: () => [], parseEmailDate: (d) => d,
        sendEmail: async (p) => { SENT.push(p); return { id: 'msg_1', threadId: 'th_1' }; },
    };
    if (r.endsWith('helpers/gemini')) return { callGeminiJSON: async () => ({}) };
    if (r.endsWith('helpers/emailThreads')) return { trackSentEmail: async () => {} };
    if (r.includes('whatsapp-web')) return {};
    // ── AND CHROME, WHICH IS THE ONE STEP THAT CANNOT RUN HERE ──────────
    // tests/pdf-one-page.js says the same thing for its own reason: the
    // render is not exercisable in the test environment. So this fakes
    // puppeteer and NOTHING ELSE about the chain.
    //
    // Which means everything this feature added is still real: the route,
    // helpers/saleInvoice's arithmetic, invoicePdf building the HTML and
    // choosing its modes, the separate/combined split, documentsSaved
    // filing it under the right day and container, shipmentDocs finding it
    // again, shipmentMail addressing it, and the send. The bytes inside the
    // PDF are helpers/invoicePdf's business and are covered by
    // tests/pdf-one-page.js and tests/packing-list.js.
    //
    // It records the HTML it was given, so section H can assert that the
    // figures reached the document rather than only the JSON response — a
    // route that returns the right numbers and renders the wrong ones is
    // exactly the gap CLAUDE.md rule 3 is about.
    if (r === 'puppeteer') return {
        launch: async () => ({
            newPage: async () => ({
                setContent: async (html) => { RENDERED.push(String(html)); },
                evaluate: async () => {},
                pdf: async () => Buffer.from('%PDF-1.4 fake\n%%EOF'),
                // pdfFit measures the rendered page before deciding a scale.
                $eval: async () => 1000,
                addStyleTag: async () => {},
                emulateMediaType: async () => {},
            }),
            close: async () => {},
        }),
    };
    return orig.apply(this, arguments);
};
let RENDERED = [];

const bills = require(R('helpers/bills'));
const sales = require(R('helpers/sales'));
const saleInvoice = require(R('helpers/saleInvoice'));
const shipmentMail = require(R('helpers/shipmentMail'));

const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
function put(container, filename, body) {
    const dir = path.join(cfg.DOCUMENTS_SAVED_DIR, 'invoice', TODAY, container);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), body || `%PDF-1.4 ${filename}\n%%EOF`);
}

(async () => {

// ── THE ARIS CONTAINER, AS IT REALLY WAS ────────────────────────────────────
// 15,642 lb of scrap auto parts at $0.548 a pound. Both figures exactly as
// they sat on the row; the invoice that went out is what happened to them.
await bills.addBill({
    date: '09/10/2026', supplier: 'Gomez', booking_no: 'DALA89635900', container_no: 'MSDU2726332',
    // gross 29,250 - 14,350 of tares = 14,900 lb net = 6.758 MT, against an
    // invoiced 15,642 lb = 7.095 MT. About 5% apart, which is the realistic
    // shape of a reweigh at destination and is what section D is about.
    seal_no: 'SL9981', gross: 29250, truck: 8700, container: 4400, chassis: 1250, boxes: 0,
    supplier_price: 0.32, price_unit: 'lb',
    photos: 'https://drive.example/load-1.jpg\nhttps://drive.example/load-2.jpg',
});
const ARIS = await sales.addSale({
    booking_no: 'DALA89635900', container_no: 'MSDU2726332', customer: 'Aris Metals',
    date: '09/18/2026', invoice_no: '26ARIS02', item: 'scrap auto parts',
    weight: 15642, invoice_price: 0.548, terms: 'TT',
});

// ── A. THE UNITS ────────────────────────────────────────────────────────────
section('A. pounds do not walk into a column headed MT');
{
    const built = saleInvoice.buildFrom(ARIS);
    const li = built.body.line_items[0];

    // 15,642 lb / 2204.62262 = 7.0951…
    ck('Quantity is the TONNAGE, not the poundage',
       Math.abs(li.weight - 7.095) < 0.002,
       `${li.weight} — the Aris invoice said 15642.000 here`);
    ck('  and it is emphatically not 15,642', li.weight < 100, String(li.weight));

    // $0.548/lb x 2204.62262 = $1,208.13/MT
    ck('Rate is US$ per MT, converted from her per-pound price',
       Math.abs(li.rate - 1208.13) < 0.5,
       `${li.rate} — the Aris invoice printed 0.548 under a column headed US$/MT`);

    // ── AND THE MONEY IS UNCHANGED ──────────────────────────────────────
    // The whole reason nobody caught it: the dollars were right. Converting
    // both figures must leave the total exactly where the ledger has it, or
    // this fix would trade a label error for a money error, which is worse.
    const ledger = sales.compute(ARIS);
    ck('the amount still matches the Sales ledger to the cent',
       Math.abs(li.amount - ledger.amount) < 0.005,
       `invoice ${li.amount} vs ledger ${ledger.amount}`);
    console.log(`        15,642 lb @ $0.548/lb  ->  ${li.weight} MT @ $${li.rate}/MT  =  $${li.amount}`);

    // ── AND THE GUARD FINDS NOTHING, BECAUSE THERE IS NOTHING ───────────
    const invoiceWeights = require(R('helpers/invoiceWeights'));
    ck('helpers/invoiceWeights has no complaint about it',
       invoiceWeights.weightProblems(built.body.line_items).length === 0,
       JSON.stringify(invoiceWeights.weightProblems(built.body.line_items)));

    // The same guard, against the row as she actually typed it, must still
    // fire — otherwise this check proves the guard is broken, not that the
    // conversion works.
    const asTyped = [{ ...li, weight: 15642, rate: 0.548 }];
    ck('  while the row as it was really typed still trips it',
       invoiceWeights.weightProblems(asTyped).length > 0,
       'if this passes, the guard stopped working and A proves nothing');
}

// ── B. A PRICE ALREADY PER MT IS NOT MULTIPLIED TWICE ───────────────────────
// The mirror-image bug, and the one a careless fix creates.
section('B. a per-MT price is left alone');
{
    const perMt = await sales.addSale({
        booking_no: 'DALA00000001', container_no: 'TCLU9988776', customer: 'Daekwang',
        date: '09/18/2026', invoice_no: 'EM2001', item: 'shredded scrap',
        weight: 22046.2262, invoice_price: 430,
    });
    const li = saleInvoice.buildFrom(perMt).body.line_items[0];
    ck('$430/MT stays $430/MT', Math.abs(li.rate - 430) < 0.01, String(li.rate));
    ck('  and 22,046 lb is 10 MT', Math.abs(li.weight - 10) < 0.002, String(li.weight));
    ck('  so the invoice reads $4,300', Math.abs(li.amount - 4300) < 1, String(li.amount));

    // An explicit price_unit overrides the magnitude rule, exactly as it does
    // on the ledger — she can sell at $8/MT and say so.
    const cheap = await sales.addSale({
        booking_no: 'DALA00000002', container_no: 'TCLU1111111', customer: 'Daekwang',
        date: '09/18/2026', invoice_no: 'EM2002', item: 'offcuts',
        weight: 22046.2262, invoice_price: 8, price_unit: 'mt',
    });
    ck('an explicit price_unit of mt is honoured, not overruled by magnitude',
       Math.abs(saleInvoice.buildFrom(cheap).body.line_items[0].rate - 8) < 0.01,
       String(saleInvoice.buildFrom(cheap).body.line_items[0].rate));
}

// ── C. WHAT "ALL IMPORTANT DETAILS ENTERED" MEANS ───────────────────────────
// Her words. Deliberately NOT bills.missingFor — that answers "is this
// purchase finished", and a finished purchase is not the same thing as a
// printable document.
section('C. readiness');
{
    // A date and a customer is the least addSale will accept — it refuses
    // "a sale needs a date" outright, which is its own business and not this
    // file's to argue with.
    const bare = await sales.addSale({ customer: 'Someone', date: '09/18/2026' });
    const m = saleInvoice.readiness(bare).missing;
    ck('a barely-started sale lists everything it needs',
       m.includes('invoice number') && m.includes('container no') && m.includes('weight')
       && m.includes('price') && m.includes('item description'),
       m.join(', '));
    ck('  and does not claim to be ready', saleInvoice.readiness(bare).ok === false);
    ck('the Aris sale is ready', saleInvoice.readiness(ARIS).ok === true,
       saleInvoice.readiness(ARIS).missing.join(', '));

    // A flat agreed amount with no per-unit price is a real way she sells.
    const flat = await sales.addSale({
        booking_no: 'DALA00000003', container_no: 'TCLU2222222', customer: 'Daekwang',
        date: '09/18/2026', invoice_no: 'EM2003', item: 'mixed',
        weight: 22046.2262, invoice_amount: 5000,
    });
    ck('a flat invoice amount counts as priced', saleInvoice.readiness(flat).ok === true,
       saleInvoice.readiness(flat).missing.join(', '));
    ck('  and the line carries that amount, not a recomputed one',
       Math.abs(saleInvoice.buildFrom(flat).body.line_items[0].amount - 5000) < 0.01,
       String(saleInvoice.buildFrom(flat).body.line_items[0].amount));
}

// ── C2. ONLY WHAT SHE REBILLS GOES ON THE CUSTOMER'S INVOICE ───────────────
// sales.compute splits charges by direction: 'in' is money she RECOVERS from
// the customer, 'out' is Edge Metals' own cost. Putting an 'out' charge on
// the customer's invoice bills them for her commission and her freight.
//
// Written because a mutation deleting the direction filter left every other
// check in this file green — the totals still added up, they were just adding
// up the wrong things, which is the exact shape of an error a customer finds
// before she does.
section('C2. charges, by direction');
{
    const withCharges = await sales.addSale({
        booking_no: 'DALA00000009', container_no: 'TCLU9999999', customer: 'Daekwang',
        date: '09/18/2026', invoice_no: 'EM5001', item: 'scrap',
        weight: 22046.2262, invoice_price: 400,
        charges: [
            { what: 'Ocean freight', amount: 1800, direction: 'in',
              why: 'CFR sale — recovered from the buyer on the invoice.' },
            { what: 'Agent commission', amount: 250, direction: 'out',
              why: 'Edge Metals pays this; it is not the buyer\'s to see.' },
        ],
    });
    const body = saleInvoice.buildFrom(withCharges).body;
    const labels = (body.notes || []).map((n) => n.label);
    ck('what she recovers appears as a line', labels.includes('Ocean freight'), JSON.stringify(labels));
    ck('  and what SHE pays does not', !labels.includes('Agent commission'),
       'the buyer would be looking at her commission');
    ck('  exactly one note line', (body.notes || []).length === 1, JSON.stringify(body.notes));
    ck('  and the total adds only that one',
       Math.abs(body.final_amount - (body.subtotal + 1800)) < 0.01,
       `subtotal ${body.subtotal}, final ${body.final_amount}`);
}

// ── D. THE TWO LEDGERS DISAGREEING IS A WARNING, NEVER A SILENCE ────────────
// The bill's weighbridge net and the sale's invoiced weight are allowed to
// differ — she said so: the invoiced weight "can differ after reweighing at
// destination". What is not allowed is the document going out with its two
// halves quietly disagreeing, which nothing else catches: invoiceWeights
// compares a row against its OWN gross and tares, so a 12% gap between the
// two ledgers sits well inside its 2% test and nowhere near its 5x one.
section('D. the bill and the sale, side by side');
{
    const built = saleInvoice.buildFrom(ARIS);
    const billMt = bills.compute(saleInvoice.billFor(ARIS)).net_mt;
    ck('the matching bill is found on booking + container', !!saleInvoice.billFor(ARIS));
    ck('  and the two weights really do differ here', Math.abs(billMt - 7.095) > 0.05,
       `bill ${billMt} MT vs invoice 7.095 MT`);
    ck('so the gap is said out loud',
       built.warnings.some((w) => /weighbridge net/.test(w)),
       built.warnings.join(' | '));

    // A sale whose weight agrees with the bill must NOT produce the warning —
    // one she sees every time is one she stops reading.
    await bills.addBill({ date: '09/10/2026', supplier: 'Gomez', booking_no: 'DALA55555555',
        container_no: 'MSKU5555555', gross: 30000, truck: 8700, container: 4400, chassis: 1250, boxes: 0 });
    const agrees = await sales.addSale({ booking_no: 'DALA55555555', container_no: 'MSKU5555555',
        customer: 'Aris Metals', date: '09/18/2026', invoice_no: 'EM3001', item: 'scrap',
        weight: 15650, invoice_price: 0.5 });
    ck('  and stays quiet when they agree',
       !saleInvoice.buildFrom(agrees).warnings.some((w) => /weighbridge net/.test(w)),
       saleInvoice.buildFrom(agrees).warnings.join(' | '));

    // No bill at all is a real situation — the purchase side may not be
    // entered yet — and it does not stop an invoice.
    const orphan = await sales.addSale({ booking_no: 'DALA99999999', container_no: 'ZZZU9999999',
        customer: 'Aris Metals', date: '09/18/2026', invoice_no: 'EM4001', item: 'scrap',
        weight: 15000, invoice_price: 0.5 });
    const ob = saleInvoice.buildFrom(orphan);
    ck('a sale with no matching bill still builds', ob.readiness.ok === true);
    ck('  and says the packing weights and photos are blank',
       ob.warnings.some((w) => /No matching bill/.test(w)), ob.warnings.join(' | '));
    ck('  with an empty packing block rather than zeros',
       ob.body.line_items[0].packing.gross_weight_lbs === ''
       && ob.body.line_items[0].packing.truck_lbs === '',
       JSON.stringify(ob.body.line_items[0].packing));
}

// ── E. THE PHOTOS COME OFF THE BILL ─────────────────────────────────────────
section('E. loading photos');
{
    ck('the bill\'s photo links are picked up',
       saleInvoice.buildFrom(ARIS).photos.length === 2,
       JSON.stringify(saleInvoice.buildFrom(ARIS).photos));

    // bills.cleanPhotos already drops anything that is not http(s). Asserted
    // here because these strings go into an email body.
    await bills.addBill({ date: '09/10/2026', supplier: 'X', booking_no: 'DALA77777777',
        container_no: 'MSKU7777777', gross: 30000, truck: 8700, container: 4400, chassis: 1250,
        photos: 'https://ok.example/a.jpg javascript:alert(1) file:///etc/passwd' });
    const b = bills.listWithTotals().find((x) => x.container_no === 'MSKU7777777');
    ck('  and only http(s) links survive',
       JSON.stringify(saleInvoice.photosFor(b)) === '["https://ok.example/a.jpg"]',
       JSON.stringify(saleInvoice.photosFor(b)));
}

// ── F. THE DRAFT EMAIL ──────────────────────────────────────────────────────
section('F. who it goes to and what it says');
{
    const { mutateJson } = require(R('helpers/json'));
    await mutateJson(cfg.EMAIL_CONTACTS_FILE, [], (all) => {
        all.push({ id: 'C1', name: 'Aris Metals', email: 'buyer@aris.example', cc: ['broker@aris.example'] });
        return all;
    });
    put('MSDU2726332', '26ARIS02_INVOICE.pdf');
    put('MSDU2726332', '26ARIS02_PACKING_LIST.pdf');
    // The consignee is read off the invoice's own version history, not off
    // the sale — so the name used is the one PRINTED on the document being
    // sent. Generate writes that record; this section skips generate, so it
    // writes it by hand to stand where generate would have.
    await require(R('helpers/invoiceVersions'))
        .saveInvoiceVersion('MSDU2726332', { consignee: 'Aris Metals', inv_no: '26ARIS02' });

    const d = shipmentMail.draftFor('MSDU2726332', { photos: ['https://drive.example/load-1.jpg'] });
    ck('a draft is produced', d.ok === true, d.message);
    ck('  addressed to the contact on file', d.to === 'buyer@aris.example', String(d.to));
    ck('  with their standing Cc', JSON.stringify(d.contact_cc) === '["broker@aris.example"]',
       JSON.stringify(d.contact_cc));
    ck('  both documents attached', d.attachments.length === 2, JSON.stringify(d.attachments));
    ck('  and the photo link is IN THE BODY, not attached',
       d.body.includes('https://drive.example/load-1.jpg')
       && !d.attachments.some((a) => /load-1/.test(a)),
       d.body);
    ck('  under a heading that says what they are', /Loading photo:/.test(d.body), d.body);
    ck('  and "photos" plural when there are several',
       /Loading photos:/.test(shipmentMail.draftFor('MSDU2726332',
           { photos: ['https://a.example/1.jpg', 'https://a.example/2.jpg'] }).body));

    // ── WITH NO PHOTOS, ONE BODY FOR BOTH PATHS ─────────────────────────
    // The WhatsApp path passes no photos, so its message must come out of
    // this file byte for byte the same as the screen's — that is the whole
    // reason the words were extracted into one place.
    //
    // ── AND THE SIGN-OFF IS NOT cfg.COMPANY_NAME ────────────────────────
    // Apsara, 2026-09-19: "in kind regards,i dont want Edge Trading.It should
    // be Jarvis,Edge Metals Inc."
    //
    // The obvious fix was config.js, and it would have been wrong:
    // COMPANY_NAME is also the caption on every EDGE YARD load ticket and the
    // yard app's BUYER_FIXED_NAME. Edge Yard and Edge Metals are different
    // companies. Spelled out here rather than read from config, so a future
    // edit to one cannot move the other.
    const bare = shipmentMail.draftFor('MSDU2726332');
    const expected = [
        'Dear Aris Metals,', '',
        'Please find attached the invoice and packing list for container MSDU2726332.',
        'Invoice no: 26ARIS02',
        '', 'Kind regards,', 'Jarvis', 'Edge Metals Inc',
    ].join('\n');
    ck('with no photos the body is exactly the shared one', bare.body === expected,
       JSON.stringify(bare.body));
    ck('  signed for Edge Metals, not Edge Trading',
       /Jarvis\nEdge Metals Inc$/.test(bare.body) && !/Edge Trading/.test(bare.body),
       JSON.stringify(bare.body.slice(-40)));
    ck('  and config.js still says Edge Trading, because the YARD uses it',
       cfg.COMPANY_NAME === 'Edge Trading',
       'changing it would rename the buyer on every yard load ticket');
    ck('  and carries no photo heading at all', !/Loading photo/.test(bare.body));

    // ── NO LINE OVER 78 CHARACTERS ──────────────────────────────────────
    // Apsara, 2026-09-19, with a screenshot of a sentence broken after
    // "(Invoice": "why the line is getting wrapped..please find the attached
    // ->That line".
    //
    // Arithmetic. The sentence was one line carrying the container AND the
    // invoice number — 87 characters with just the invoice, 104 with the
    // packing list. This goes out as text/plain, RFC 5322 says a line SHOULD
    // be at most 78, so Gmail wrapped it at 78 wherever 78 happened to fall.
    // That landed mid-parenthetical, which is why it read as broken rather
    // than merely long.
    //
    // Asserted as the PROPERTY, not as the sentence: the wording will change
    // again, and what must not change is that it fits. A check pinned to the
    // string would go green on a rewrite that overflows by one word.
    for (const [label, b] of [['with photos', d], ['without', bare]]) {
        const over = b.body.split('\n').filter((l) => l.length > 78);
        ck(`  every line fits in 78 characters (${label})`, over.length === 0,
           over.map((l) => `${l.length}: ${l}`).join(' | '));
    }
    ck('  and the invoice number is on its own line, where it can be copied',
       /\nInvoice no: 26ARIS02\n/.test(bare.body + '\n'), JSON.stringify(bare.body));
    ck('  not doubled up as "Invoice X no: X"',
       !/Invoice \S+ no:/.test(bare.body), JSON.stringify(bare.body));

    // The longest form this can take — packing list present, so the sentence
    // is at its longest — is the one that was 104. Named so the margin is
    // visible rather than assumed.
    const longest = Math.max(...bare.body.split('\n').map((l) => l.length));
    console.log(`        longest line: ${longest} of 78`);
}

// ── G. THE CALLERS THAT WERE ALREADY THERE ──────────────────────────────────
// CLAUDE.md, three incidents: "a rule that makes sense on one screen lands in
// code that other callers reach, and the caller that cannot satisfy it is the
// one nobody was looking at." Two extractions happened here. Both had exactly
// one existing caller. Both are checked.
section('G. nothing that already worked changed');
{
    const api = fs.readFileSync(R('api.js'), 'utf8');
    const actionsSrc = fs.readFileSync(R('workflow/actions.js'), 'utf8');

    // 1. /api/invoice/generate still REFUSES on a weight mismatch. The new
    //    route reports instead, and that difference is deliberate and hers —
    //    but the Documents screen must behave today as it did yesterday.
    ck('/api/invoice/generate still 409s on WEIGHT_MISMATCH',
       /if \(weightProblems\.length && body\.weights_ok !== true[\s\S]{0,200}WEIGHT_MISMATCH/.test(api),
       'the Documents screen was not part of this request');

    // 2. workflow/actions.js no longer carries its own copy of the message.
    ck('the WhatsApp path has no second copy of the body',
       !/Please find attached the \$\{found\.packing \? 'invoice and packing list'/.test(actionsSrc),
       'two copies of the words is how the email she read stops being the email that went');
    ck('  and asks helpers/shipmentMail for it',
       /shipmentMail\.draftFor\(containerNo\)/.test(actionsSrc));
    ck('  passing NO photos, so its message is unchanged',
       !/draftFor\(containerNo,\s*\{[^}]*photos/.test(actionsSrc),
       'a flag must mark the NEW shape, never the old one');

    // 3. Every reason the old code had still exists, and still maps to the
    //    same action_taken string — brain.js and the tests read those.
    for (const reason of shipmentMail.REASONS) {
        ck(`  reason "${reason}" survives the move`, shipmentMail.REASONS.includes(reason));
    }
    ck('  and actions.js builds action_taken from it',
       /shipment_docs_\$\{draft\.reason\}/.test(actionsSrc));

    // 4. saveGeneratedInvoice is ONE function with two callers, not two
    //    copies of the filing convention.
    ck('the filing convention exists once',
       (api.match(/_PACKING_LIST\.pdf`;/g) || []).length === 1,
       'a second copy is two folders of differently-named invoices');
    ck('  and both routes call it',
       (api.match(/saveGeneratedInvoice\(/g) || []).length === 3,
       'one definition plus two call sites');
}

// ── H. END TO END, THROUGH THE ROUTES THE SCREEN USES ───────────────────────
// CLAUDE.md rule 3. Helper tests and screen tests can both be green while the
// feature does not work; the gaps live between them. This starts a real
// server, logs in, and walks her three stops in her order.
section('H. end to end: generate, draft, send');
{
    const { createApi } = require(R('api'));
    const app = createApi();
    const listener = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${listener.address().port}`;

    const call = (method, p2, sid, body) => new Promise((resolve, reject) => {
        const d = body === undefined ? null : JSON.stringify(body);
        const headers = {};
        if (sid) headers.Authorization = `Bearer ${sid}`;
        if (d) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(d); }
        const r = http.request(base + p2, { method, headers }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {}
                resolve({ status: res.statusCode, json: j, raw }); });
        });
        r.on('error', reject); if (d) r.write(d); r.end();
    });

    const sid = ((await call('POST', '/login', null, { password: 'admin-pw-ssssssssssss' })).json || {}).sid;
    ck('logged in', !!sid);

    // ── STOP ONE: GENERATE ──────────────────────────────────────────────
    // separate: true — "separate invoice and packing list", the first of the
    // two she wants to be asked about.
    const gen = await call('POST', `/api/sales/${ARIS.id}/invoice/generate`, sid, { separate: true });
    ck('generate answers 200', gen.status === 200, `${gen.status} ${gen.raw.slice(0, 200)}`);
    if (gen.json) {
        ck('  two files, because she asked for them separately',
           gen.json.separate === true && (gen.json.saved_filenames || []).length === 2,
           JSON.stringify(gen.json.saved_filenames));
        // `.every` on an EMPTY array is true. Both of these passed happily
        // while generate was returning a 500 and saved_filenames was
        // undefined — a check that is vacuous on the failure case is not a
        // check. The length is asserted first, every time.
        const names = gen.json.saved_filenames || [];
        ck('  named for the invoice, not the container',
           names.length === 2 && names.every((f) => f.startsWith('26ARIS02_')),
           JSON.stringify(names));
        ck('  and they are really on disk',
           names.length === 2 && names.every((f) => fs.existsSync(
               path.join(cfg.DOCUMENTS_SAVED_DIR, 'invoice', TODAY, 'MSDU2726332', f))),
           'the screen shows her a file that has to exist to be shown');

        // ── AND THE FIGURES REACHED THE DOCUMENT ────────────────────────
        // The gap CLAUDE.md rule 3 names: a route can return the right
        // numbers in JSON and render the wrong ones onto the PDF. This reads
        // the HTML invoicePdf actually handed to Chromium.
        const html = RENDERED.join('\n');
        ck('  the printed Quantity column says 7.095, not 15,642',
           /7\.095/.test(html) && !/15,?642\.000/.test(html),
           html.length ? 'rendered HTML did not contain 7.095' : 'nothing was rendered at all');
        ck('  and the printed Rate column is the per-MT figure',
           /1,?208\.13/.test(html) && !/>\s*0\.548\s*</.test(html),
           'the Aris invoice printed 0.548 under a column headed US$/MT');
        ck('  with the container and invoice number on it',
           /MSDU2726332/.test(html) && /26ARIS02/.test(html));

        // What the verification screen puts in front of her.
        ck('  the line items come back for the screen to show',
           (gen.json.line_items || []).length === 1
           && Math.abs(gen.json.line_items[0].weight - 7.095) < 0.002,
           JSON.stringify((gen.json.line_items || [])[0]));
        ck('  so do the photos', (gen.json.photos || []).length === 2);
        ck('  and the two-ledger warning', (gen.json.warnings || []).some((w) => /weighbridge/.test(w)));

        // Her instruction: generate does NOT refuse on weights.
        ck('  generate did not refuse', gen.json.ok === true);
        ck('  and reported no weight problem, because there is none',
           (gen.json.weight_problems || []).length === 0,
           JSON.stringify(gen.json.weight_problems));
    }

    // An unfinished sale is 422 with what it needs, not a 500.
    const bare2 = await sales.addSale({ customer: 'Nobody', date: '09/18/2026' });
    const inc = await call('POST', `/api/sales/${bare2.id}/invoice/generate`, sid, {});
    ck('an unfinished sale is refused with its list', inc.status === 422
       && (inc.json || {}).code === 'SALE_INCOMPLETE'
       && ((inc.json || {}).missing || []).includes('weight'),
       `${inc.status} ${inc.raw.slice(0, 160)}`);

    // ── STOP TWO: THE DRAFT ─────────────────────────────────────────────
    const draft = await call('GET', `/api/sales/${ARIS.id}/invoice/draft-mail`, sid);
    ck('the draft comes back', draft.status === 200 && (draft.json || {}).ok === true,
       `${draft.status} ${draft.raw.slice(0, 200)}`);
    if (draft.json && draft.json.ok) {
        ck('  to the real address, for her to read before she sends',
           draft.json.to === 'buyer@aris.example', String(draft.json.to));
        ck('  attaching the two files generated a moment ago',
           (draft.json.attachments || []).length === 2, JSON.stringify(draft.json.attachments));
        ck('  with both photo links in the body',
           (draft.json.photos || []).length === 2
           && draft.json.body.includes('https://drive.example/load-2.jpg'));
    }

    // ── STOP THREE: SEND ────────────────────────────────────────────────
    // Nothing goes without confirm, whatever else is right.
    SENT = [];
    const noConf = await call('POST', `/api/sales/${ARIS.id}/invoice/send`, sid, {});
    ck('send refuses without an explicit confirm',
       noConf.status === 400 && (noConf.json || {}).code === 'NOT_CONFIRMED',
       `${noConf.status} ${noConf.raw.slice(0, 120)}`);
    ck('  and nothing left the building', SENT.length === 0, `${SENT.length} sent`);

    const sent = await call('POST', `/api/sales/${ARIS.id}/invoice/send`, sid, { confirm: true });
    ck('send goes on confirm', sent.status === 200 && (sent.json || {}).ok === true,
       `${sent.status} ${sent.raw.slice(0, 200)}`);
    ck('  exactly one email', SENT.length === 1, `${SENT.length}`);
    if (SENT.length === 1) {
        ck('  to the buyer', SENT[0].to === 'buyer@aris.example', String(SENT[0].to));
        ck('  copying the broker', JSON.stringify(SENT[0].cc) === '["broker@aris.example"]',
           JSON.stringify(SENT[0].cc));
        ck('  subject names the invoice and the container',
           SENT[0].subject === 'Invoice 26ARIS02 — MSDU2726332', SENT[0].subject);
        ck('  with the two PDFs attached as bytes',
           (SENT[0].attachments || []).length === 2
           && SENT[0].attachments.every((a) => Buffer.isBuffer(a.content) && a.content.length > 0),
           JSON.stringify((SENT[0].attachments || []).map((a) => a.filename)));
        ck('  and the photos as links, not as attachments',
           SENT[0].body.includes('https://drive.example/load-1.jpg')
           && !(SENT[0].attachments || []).some((a) => /\.jpg$/i.test(a.filename)),
           SENT[0].body);
        ck('  the body she was shown is the body that went',
           draft.json && SENT[0].body === draft.json.body,
           'a draft that differs from the send is worse than no draft');
    }

    // ── AND THE WEIGHT GUARD, ON SEND ───────────────────────────────────
    // Her call: generate, then ask at the mail step. So a sale that really is
    // wrong must sail through generate and be stopped here.
    await bills.addBill({ date: '09/10/2026', supplier: 'Gomez', booking_no: 'DALA66666666',
        container_no: 'MSKU6666666', gross: 30000, truck: 8700, container: 4400, chassis: 1250, boxes: 0 });
    const badSale = await sales.addSale({ booking_no: 'DALA66666666', container_no: 'MSKU6666666',
        customer: 'Aris Metals', date: '09/18/2026', invoice_no: 'EM9001', item: 'scrap',
        // Pounds in the weight field with the unit forced to MT: the sale now
        // claims 15,650 METRIC TONS in one container.
        weight: 15650, weight_unit: 'mt', invoice_price: 430 });
    const badGen = await call('POST', `/api/sales/${badSale.id}/invoice/generate`, sid, {});
    ck('a wrong tonnage still GENERATES, as she asked', badGen.status === 200,
       `${badGen.status} ${badGen.raw.slice(0, 160)}`);
    ck('  and comes back flagged, for the screen to show',
       ((badGen.json || {}).weight_problems || []).length > 0
       && !!(badGen.json || {}).weight_message,
       JSON.stringify((badGen.json || {}).weight_problems));

    SENT = [];
    const badSend = await call('POST', `/api/sales/${badSale.id}/invoice/send`, sid, { confirm: true });
    ck('  but SENDING it is refused', badSend.status === 409
       && (badSend.json || {}).code === 'WEIGHT_MISMATCH',
       `${badSend.status} ${badSend.raw.slice(0, 160)}`);
    ck('  and nothing went', SENT.length === 0, `${SENT.length} sent`);

    // ── AND weights_ok IS NOT A THING THE BROWSER CAN LIE ABOUT ─────────
    // The send route rebuilds the invoice from the SALE rather than trusting
    // line items posted back to it. weights_ok says "I have read this and the
    // figures are deliberate" — it does not say "there is no problem".
    const apiSrc = fs.readFileSync(R('api.js'), 'utf8');
    ck('  the send route recomputes from the sale, not from the request body',
       /const built = saleInvoice\.buildFrom\(sale\);[\s\S]{0,300}weightProblems\(built\.body\.line_items\)/
           .test(apiSrc.slice(apiSrc.indexOf("invoice/send"))),
       'a figure the browser sends back is a figure the browser could have changed');

    SENT = [];
    const okd = await call('POST', `/api/sales/${badSale.id}/invoice/send`, sid,
                           { confirm: true, weights_ok: true });
    ck('  and her acknowledgement lets it through', okd.status === 200 && SENT.length === 1,
       `${okd.status} ${okd.raw.slice(0, 160)}`);

    // ── STAFF CANNOT REACH ANY OF IT ────────────────────────────────────
    // /api/sales is deliberately absent from STAFF_ALLOWED_PATH_PREFIXES —
    // these are customer invoices and her margins. The new routes sit under
    // the same prefix and must inherit that, not quietly widen it.
    const staffBlocked = await call('POST', `/api/sales/${ARIS.id}/invoice/send`, null, { confirm: true });
    ck('an unauthenticated caller cannot send an invoice',
       staffBlocked.status === 401 || staffBlocked.status === 403,
       String(staffBlocked.status));

    listener.close();
}

// ── J. A CUSTOMER WHO IS NOT IN THE ADDRESS BOOK ────────────────────────────
// Apsara, 2026-09-19, reading the refusal she got:
//
//   "if its in email contacts,it can take ..else it can ask for email
//    recipients separated by comma ... then it should get stored in email
//    contacts tab"
//
// Being sent to a different tab, told to add the contact and start the whole
// thing again, is the worst available answer to a question the screen could
// just ask. The typed list goes back through the SAME draft route, so what
// she reads before pressing Send is the real message with the real addresses
// on it — typing them is not a shortcut past the read-before-send step.
section('J. typed recipients, then kept');
{
    const { createApi } = require(R('api'));
    const app = createApi();
    const listener = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${listener.address().port}`;
    const call = (method, p2, sid2, body) => new Promise((resolve, reject) => {
        const d = body === undefined ? null : JSON.stringify(body);
        const headers = {};
        if (sid2) headers.Authorization = `Bearer ${sid2}`;
        if (d) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(d); }
        const r = http.request(base + p2, { method, headers }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {}
                resolve({ status: res.statusCode, json: j, raw }); });
        });
        r.on('error', reject); if (d) r.write(d); r.end();
    });
    const sid2 = ((await call('POST', '/login', null, { password: 'admin-pw-ssssssssssss' })).json || {}).sid;

    // A container whose consignee is nowhere in Email Contacts — her exact
    // case, "Edge Metals Recycling isn't in Email Contacts".
    await bills.addBill({ date: '09/10/2026', supplier: 'Gomez', booking_no: 'DALA31313131',
        container_no: 'TCNU2798153', gross: 29250, truck: 8700, container: 4400, chassis: 1250, boxes: 0,
        photos: 'https://drive.example/emr-1.jpg' });
    const emr = await sales.addSale({ booking_no: 'DALA31313131', container_no: 'TCNU2798153',
        customer: 'Edge Metals Recycling', date: '09/18/2026', invoice_no: 'EM7001',
        item: 'Al Wheels', weight: 15000, invoice_price: 1.45 });
    await call('POST', `/api/sales/${emr.id}/invoice/generate`, sid2, {});

    // ── IT ASKS, IT DOES NOT JUST REFUSE ────────────────────────────────
    const asked = await call('GET', `/api/sales/${emr.id}/invoice/draft-mail`, sid2);
    ck('with no contact on file the draft says so', (asked.json || {}).ok === false,
       asked.raw.slice(0, 120));
    ck('  and asks for addresses rather than ending there',
       (asked.json || {}).ask_recipients === true, JSON.stringify(asked.json));
    ck('  naming who it needs them for',
       (asked.json || {}).consignee === 'Edge Metals Recycling', String((asked.json || {}).consignee));

    // ── WHAT SHE TYPES IS PARSED, NOT TRUSTED ───────────────────────────
    const bad = await call('GET',
        `/api/sales/${emr.id}/invoice/draft-mail?recipients=${encodeURIComponent('good@emr.example, not-an-address')}`, sid2);
    ck('a typo in the list is named, not silently dropped',
       (bad.json || {}).reason === 'bad_recipients'
       && ((bad.json || {}).bad || []).includes('not-an-address'),
       JSON.stringify(bad.json));
    ck('  because one address quietly removed from four is an invoice three people get',
       (bad.json || {}).ok === false);

    // Commas, semicolons, spaces and a display name — a list pasted out of
    // somebody else's mail client arrives in every one of these shapes.
    const messy = 'ops@emr.example; accounts@emr.example , "Ray" <ray@emr.example>';
    const drafted = await call('GET',
        `/api/sales/${emr.id}/invoice/draft-mail?recipients=${encodeURIComponent(messy)}`, sid2);
    ck('a messy pasted list still resolves', (drafted.json || {}).ok === true,
       drafted.raw.slice(0, 160));
    ck('  first address is the addressee', (drafted.json || {}).to === 'ops@emr.example',
       String((drafted.json || {}).to));
    ck('  the rest are copied',
       JSON.stringify((drafted.json || {}).contact_cc) === '["accounts@emr.example","ray@emr.example"]',
       JSON.stringify((drafted.json || {}).contact_cc));
    ck('  the display name is stripped, the address kept',
       !String((drafted.json || {}).contact_cc || '').includes('Ray'));
    ck('  and she is shown the real body before any of it goes',
       /Dear Edge Metals Recycling/.test((drafted.json || {}).body || ''),
       ((drafted.json || {}).body || '').slice(0, 80));

    // ── NOTHING IS SAVED UNTIL THE SEND SUCCEEDS ────────────────────────
    // A contact written for a message that then failed is a contact she never
    // asked for, sitting there looking like it worked.
    const { resolveContact } = require(R('helpers/emailContacts'));
    ck('drafting alone stores nothing in Email Contacts',
       !resolveContact('Edge Metals Recycling'),
       'the draft is a read; it must not write');

    SENT = [];
    const went = await call('POST', `/api/sales/${emr.id}/invoice/send`, sid2,
                            { confirm: true, recipients: messy });
    ck('the send goes to the typed addresses', went.status === 200 && SENT.length === 1,
       `${went.status} ${went.raw.slice(0, 160)}`);
    if (SENT.length === 1) {
        ck('  to the first', SENT[0].to === 'ops@emr.example', String(SENT[0].to));
        ck('  copying the others',
           JSON.stringify(SENT[0].cc) === '["accounts@emr.example","ray@emr.example"]',
           JSON.stringify(SENT[0].cc));
        ck('  with the documents attached', (SENT[0].attachments || []).length >= 1);
        ck('  and the loading photo as a link',
           SENT[0].body.includes('https://drive.example/emr-1.jpg'), SENT[0].body);
    }

    // ── AN EDIT REACHES THE WIRE, NOT JUST THE REQUEST ──────────────────
    // "also make the email editable." The screen test asserts that the boxes
    // are POSTED; this asserts the server USES them. A mutation that made the
    // route ignore body0.subject left the screen test perfectly green — the
    // browser was sending the edit and the server was quietly discarding it,
    // which is the worst shape of this bug: she watches her own words go.
    SENT = [];
    await call('POST', `/api/sales/${emr.id}/invoice/send`, sid2, {
        confirm: true, recipients: messy,
        subject: 'Invoice EM7001 — revised', body: 'Dear Ops,\n\nRevised as agreed.\n\nJarvis' });
    ck('the subject SHE typed is the one that goes',
       SENT.length === 1 && SENT[0].subject === 'Invoice EM7001 — revised',
       JSON.stringify(SENT[0] && SENT[0].subject));
    ck('  and the body she rewrote', SENT.length === 1 && /Revised as agreed/.test(SENT[0].body),
       JSON.stringify(SENT[0] && SENT[0].body));

    // Clearing a box is far more likely to be an accident than an
    // instruction, so an empty one falls back rather than sending a blank
    // subject to a customer.
    SENT = [];
    await call('POST', `/api/sales/${emr.id}/invoice/send`, sid2,
               { confirm: true, recipients: messy, subject: '   ', body: '' });
    ck('an emptied box falls back to the generated text',
       SENT.length === 1 && /Invoice EM7001/.test(SENT[0].subject)
       && /Please find attached/.test(SENT[0].body),
       JSON.stringify(SENT[0] && SENT[0].subject));

    // ── AND NOW IT IS IN THE TAB ────────────────────────────────────────
    const saved = resolveContact('Edge Metals Recycling');
    ck('the customer is now in Email Contacts', !!saved && saved.type !== 'ambiguous',
       JSON.stringify(saved));
    ck('  with the address she typed',
       saved && saved.contact && saved.contact.email === 'ops@emr.example',
       JSON.stringify(saved && saved.contact));
    ck('  and the others as their standing Cc',
       saved && JSON.stringify(saved.contact.cc) === '["accounts@emr.example","ray@emr.example"]',
       JSON.stringify(saved && saved.contact.cc));
    ck('  the route says so, so the screen can tell her',
       (went.json || {}).saved_contact === 'Edge Metals Recycling',
       JSON.stringify((went.json || {}).saved_contact));

    // ── SO THE NEXT ONE NEEDS NO TYPING ─────────────────────────────────
    const second = await call('GET', `/api/sales/${emr.id}/invoice/draft-mail`, sid2);
    ck('next time it fills itself in', (second.json || {}).ok === true
       && second.json.to === 'ops@emr.example',
       JSON.stringify((second.json || {}).to || second.json));
    ck('  and does not offer to save it again',
       !(second.json || {}).save_as, JSON.stringify((second.json || {}).save_as));

    // ── THE WHATSAPP PATH IS UNTOUCHED ──────────────────────────────────
    // It passes no recipients, so it still gets the refusal it always got —
    // there is no box on a WhatsApp message to put an address in.
    const src = fs.readFileSync(R('workflow/actions.js'), 'utf8');
    ck('the assistant path passes no recipients',
       !/draftFor\(containerNo,\s*\{[^}]*recipients/.test(src),
       'a flag must mark the NEW shape, never the old one');

    listener.close();
}

// ── K. THE MESSAGE REALLY ENCODES ───────────────────────────────────────────
// Apsara, 2026-09-19, pressing Send on an invoice to Daekwang:
//
//     "Cannot read properties of undefined (reading 'replace')"
//
// helpers/gmail.js's buildMimeMessage read `att.base64.replace(...)`, and
// nothing in the codebase has ever set `base64` — every caller passes a
// Buffer under `content`. So EVERY email with an attachment threw, on every
// path: this one, the WhatsApp "send the documents for X", and the proforma
// send at workflow/actions.js:7385.
//
// ── WHY FOUR GREEN TEST FILES DID NOT NOTICE ────────────────────────────────
// They stub sendEmail, which is correct — nothing may leave the building —
// but a stub accepts any object. The attachments were handed to something
// that would take anything, so the only property that mattered about them was
// the only one never exercised. Green all the way to the customer.
//
// So this section takes the attachments the ROUTE produced and puts them
// through the REAL encoder. No stub sits in the middle of it.
section('K. the attachments survive a real MIME encode');
{
    const shipmentDocs = require(R('helpers/shipmentDocs'));
    // Deliberately NOT the stubbed module: Module._load only intercepts
    // 'helpers/gmail', so the encoder is reached by its own path.
    const { buildMimeMessage } = orig.call(Module, R('helpers/gmail'), module, false);

    const found = shipmentDocs.findForContainer('MSDU2726332');
    const attachments = shipmentDocs.attachmentsFor(found);
    ck('the route really has documents to attach', attachments.length >= 1,
       String(attachments.length));

    // ── THE SHAPE, NAMED ────────────────────────────────────────────────
    ck('  and they carry their bytes under `content`, as every caller does',
       attachments.every((a) => Buffer.isBuffer(a.content)),
       JSON.stringify(attachments.map((a) => Object.keys(a))));
    ck('  and nothing sets `base64`, which is what the encoder used to demand',
       attachments.every((a) => a.base64 === undefined),
       'if this ever changes, the encoder is being fed a shape nothing produces');

    let raw = null, err = null;
    try {
        raw = buildMimeMessage({
            to: 'buyer@aris.example', cc: null, bcc: null,
            subject: 'Invoice 26ARIS02 — MSDU2726332',
            body: 'Dear Aris Metals,\n\nPlease find attached…',
            attachments,
        });
    } catch (e) { err = e; }
    ck('the real encoder accepts them', !err, err && err.message);
    ck('  and produces a message', !!raw && raw.length > 100, raw ? String(raw.length) : 'nothing');

    if (raw) {
        // base64url, per the Gmail API — decode it back and look inside.
        const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        ck('  the filename is in the message', /26ARIS02_INVOICE\.pdf/.test(decoded));
        ck('  declared as a PDF attachment',
           /Content-Type: application\/pdf/.test(decoded)
           && /Content-Disposition: attachment/.test(decoded));
        ck('  with the PDF actually in it, not an empty part',
           /Content-Transfer-Encoding: base64/.test(decoded)
           && decoded.includes(attachments[0].content.toString('base64').slice(0, 40)),
           'a header saying "attachment" over nothing is worse than no attachment');
        ck('  and the body is still there beside it',
           /Please find attached/.test(decoded));
    }

    // ══ HTML, ON EVERY MAIL JARVIS SENDS ════════════════════════════════
    //
    // Apsara, 2026-09-19. Offered the narrow version — invoice emails only —
    // she said: "HTML for all the mail that jarvis sends."
    //
    // So it is derived in sendEmail from the plain body, in one place, rather
    // than asked of twelve call sites. Asking each of them to remember a new
    // argument is asking one of them to forget, and the one that forgets is
    // the one nobody is looking at.
    {
        const { textToHtml } = orig.call(Module, R('helpers/gmail'), module, false);

        // ── THE PLAIN HALF STILL GOES ───────────────────────────────────
        // This is what made it safe to do everywhere. getEmailContent prefers
        // text/plain when reading a message back, so reply threading, the
        // mail watcher and everything that re-reads sent mail sees exactly
        // what it saw yesterday.
        const both = buildMimeMessage({
            to: 'buyer@aris.example', subject: 'Invoice 26ARIS02 — MSDU2726332',
            body: 'Dear Aris Metals,\n\nSee https://x.example/a?u=1&v=2.\n\nJarvis',
            bodyHtml: textToHtml('Dear Aris Metals,\n\nSee https://x.example/a?u=1&v=2.\n\nJarvis'),
        });
        const decodedBoth = Buffer.from(both.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        ck('an html message is multipart/alternative',
           /Content-Type: multipart\/alternative/.test(decodedBoth),
           decodedBoth.split('\n')[2]);
        ck('  carrying the plain text half', /Content-Type: text\/plain/.test(decodedBoth)
           && /Dear Aris Metals,/.test(decodedBoth));
        ck('  AND the html half', /Content-Type: text\/html/.test(decodedBoth));
        ck('  with the url made clickable',
           /<a href="https:\/\/x\.example\/a\?u=1&amp;v=2">/.test(decodedBoth),
           'links in a plain-text body are clickable; in html they have to be made so');

        // ── ESCAPING, WHICH IS THE ONE THAT COULD GO WRONG QUIETLY ──────
        // A customer name carrying & or < would otherwise break the markup —
        // or be interpreted as it.
        const risky = textToHtml('Dear A & B <Ltd>,\nsee https://x.example/a.');
        ck('an ampersand in a customer name is escaped', /A &amp; B/.test(risky), risky);
        ck('  and angle brackets are not markup', /&lt;Ltd&gt;/.test(risky)
           && !/<Ltd>/.test(risky), risky);
        ck('  a trailing full stop stays OUT of the link',
           /<a href="https:\/\/x\.example\/a">https:\/\/x\.example\/a<\/a>\./.test(risky),
           'a link ending in a full stop 404s');
        ck('  and her line breaks survive',
           /white-space:pre-wrap/.test(risky),
           'pre-wrap keeps blank lines and indentation while still reflowing long ones');

        // ── A CALLER THAT PASSES NOTHING IS UNCHANGED ───────────────────
        // buildMimeMessage's own default. sendEmail is what derives the html;
        // the encoder still produces yesterday's bytes when handed none.
        const plain = buildMimeMessage({
            to: 'x@y.example', subject: 's', body: 'just text' });
        const decodedPlain = Buffer.from(plain.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        ck('no bodyHtml means a plain text/plain message, exactly as before',
           /Content-Type: text\/plain; charset="UTF-8"/.test(decodedPlain)
           && !/multipart/.test(decodedPlain),
           decodedPlain.split('\n').slice(0, 4).join(' | '));

        // ── AND WITH ATTACHMENTS, THE NESTING IS THE RIGHT ONE ──────────
        // multipart/mixed > multipart/alternative > the two bodies, then the
        // files. Getting this wrong produces a message that some clients show
        // as an empty body with three attachments.
        const full = buildMimeMessage({
            to: 'buyer@aris.example', subject: 'Invoice 26ARIS02 — MSDU2726332',
            body: 'Dear Aris Metals,\n\nPlease find attached…',
            bodyHtml: textToHtml('Dear Aris Metals,\n\nPlease find attached…'),
            attachments,
        });
        const decodedFull = Buffer.from(full.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        ck('with attachments the outer type is multipart/mixed',
           /Content-Type: multipart\/mixed/.test(decodedFull.slice(0, 400)),
           decodedFull.slice(0, 200));
        ck('  with multipart/alternative nested inside it',
           decodedFull.indexOf('multipart/alternative') > decodedFull.indexOf('multipart/mixed'),
           'the two bodies belong together, inside the envelope that holds the files');
        ck('  both bodies present', /Content-Type: text\/plain/.test(decodedFull)
           && /Content-Type: text\/html/.test(decodedFull));
        ck('  and the PDF still attached beside them',
           /Content-Type: application\/pdf/.test(decodedFull)
           && /26ARIS02_INVOICE\.pdf/.test(decodedFull));
        // ── EVERY BOUNDARY IS CLOSED ────────────────────────────────────
        // A multipart block whose terminating --boundary-- is missing is not
        // a syntax error anywhere in our code — it encodes, it sends, and
        // then some clients render the message as an empty body with the
        // parts shown as attachments. Nothing else here noticed: a mutation
        // deleting both closing lines left every other check green.
        const closed = (raw3, label) => {
            const dec3 = Buffer.from(raw3.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
            const bounds = [...new Set((dec3.match(/boundary="([^"]+)"/g) || [])
                .map((b) => b.slice('boundary="'.length, -1)))];
            const unclosed = bounds.filter((b) => !dec3.includes(`--${b}--`));
            ck(`  every boundary is terminated (${label})`, bounds.length > 0 && unclosed.length === 0,
               bounds.length ? `unclosed: ${unclosed.join(', ')}` : 'no boundaries found at all');
        };
        closed(both, 'html, no attachments');
        closed(full, 'html with attachments');

        ck('  the two boundaries are different strings',
           (() => { const m = decodedFull.match(/boundary="([^"]+)"/g) || [];
                    return m.length === 2 && m[0] !== m[1]; })(),
           (decodedFull.match(/boundary="([^"]+)"/g) || []).join(' | '));

        // ── AND THE DERIVATION ITSELF, WHICH IS THE ACTUAL PROMISE ─────
        // Everything above hands buildMimeMessage an html body. Her
        // instruction was "HTML for all the mail that jarvis sends" — twelve
        // call sites that pass NOTHING. What makes that true is sendEmail
        // deriving it, and none of the above would notice if that line went.
        //
        // getGmailWrite is stubbed ON THE MODULE OBJECT, the seam seven other
        // suites already use, so the real sendEmail runs and the message it
        // would have handed Gmail is captured instead of sent.
        {
            const realGmail = orig.call(Module, R('helpers/gmail'), module, false);
            const savedWrite = realGmail.getGmailWrite;
            let raw = null;
            realGmail.getGmailWrite = () => ({ users: { messages: {
                send: async ({ requestBody }) => { raw = requestBody.raw; return { data: { id: 'm' } }; },
            } } });
            try {
                await realGmail.sendEmail({
                    to: 'someone@example.com', subject: 'Digest',
                    body: 'Line one\n\nSee https://x.example/a & note the ampersand.',
                });
            } finally { realGmail.getGmailWrite = savedWrite; }

            const dec = raw
                ? Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
                : '';
            ck('a caller passing NO html still sends both halves',
               /multipart\/alternative/.test(dec) && /Content-Type: text\/html/.test(dec),
               dec.slice(0, 200) || 'nothing was captured');
            ck('  the plain half is her exact words, untouched',
               /Line one\n\nSee https:\/\/x\.example\/a & note the ampersand\./.test(dec),
               'the text part must not be escaped — it is not markup');
            ck('  and the html half is escaped and linked',
               /&amp; note the ampersand/.test(dec)
               && /<a href="https:\/\/x\.example\/a">/.test(dec),
               dec.slice(dec.indexOf('text/html'), dec.indexOf('text/html') + 300));

            // A caller that supplies its own html must still win.
            let raw2 = null;
            realGmail.getGmailWrite = () => ({ users: { messages: {
                send: async ({ requestBody }) => { raw2 = requestBody.raw; return { data: { id: 'm' } }; },
            } } });
            try {
                await realGmail.sendEmail({ to: 'x@y.example', subject: 's', body: 'plain',
                                            bodyHtml: '<div>MINE</div>' });
            } finally { realGmail.getGmailWrite = savedWrite; }
            const dec2 = raw2
                ? Buffer.from(raw2.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
                : '';
            ck('  a caller with its own html keeps it', /<div>MINE<\/div>/.test(dec2), dec2.slice(-200));
        }

        // An empty body must not produce an empty <div> half.
        ck('an empty body produces no html half at all',
           !/multipart/.test(Buffer.from(
               buildMimeMessage({ to: 'x@y.example', subject: 's', body: '' })
                 .replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')));
    }

    // ── AND A GENUINELY EMPTY ATTACHMENT SAYS WHICH ONE ─────────────────
    // "undefined is not a function" is not something she can act on; a
    // filename is.
    let named = null;
    try {
        buildMimeMessage({ to: 'x@y.example', subject: 's', body: 'b',
                           attachments: [{ filename: 'BROKEN.pdf', mimeType: 'application/pdf' }] });
    } catch (e) { named = e; }
    ck('an attachment with no bytes throws by NAME', !!named && /BROKEN\.pdf/.test(named.message),
       String(named && named.message));

    // ── THE OTHER TWO CALLERS ARE THE SAME SHAPE ────────────────────────
    // This was never only about the invoice screen. Asserted as source,
    // because driving a proforma send from here would be a different suite.
    const actionsSrc = fs.readFileSync(R('workflow/actions.js'), 'utf8');
    ck('the proforma send passes `content` too, so it was broken the same way',
       /attachments: \[\{ filename, content: pdf, mimeType: 'application\/pdf' \}\]/.test(actionsSrc),
       'if this drifts, one of the two paths is fixed and the other is not');
    const gmailSrc = fs.readFileSync(R('helpers/gmail.js'), 'utf8');
    ck('  and the encoder now takes either shape',
       /function base64Of\(att\)/.test(gmailSrc) && /base64Of\(att\)\.replace/.test(gmailSrc),
       'one fix at the boundary rather than three edits at three callers');
}

// ── I. THE SCREEN ───────────────────────────────────────────────────────────
// CLAUDE.md rule 3 again, from the other end: the routes above can all be
// right while the button that calls them is not wired, or calls them in the
// wrong order, or sends `paid_via` where the route reads `paid-via`.
//
// jsdom, the real dashboard/index.html, its real script. The three steps are
// driven the way she drives them: press Generate, look, press Next, look,
// press Send.
section('I. the three screens');
{
    let JSDOM = null;
    try { ({ JSDOM } = require('jsdom')); } catch (e) {}
    if (!JSDOM) {
        ck('jsdom is installed so the screen can be rendered', false,
           'this is NOT a pass — run npm install');
    } else {
        const pageHtml = fs.readFileSync(R('dashboard/index.html'), 'utf8');
        const SCRIPT = (pageHtml.match(/<script>([\s\S]*?)<\/script>/g) || [])
            .map((b) => b.replace(/^<script>/, '').replace(/<\/script>$/, '')).join('\n');

        const dom = new JSDOM(pageHtml, { runScripts: 'outside-only', url: 'http://localhost/' });
        const w = dom.window;
        let bootErr = null;
        // A `boot()` that resumes after the window is gone throws on its first
        // $() — the failure shape CLAUDE.md names. Held at its first await.
        w.fetch = () => new Promise(() => {});
        try { w.eval(SCRIPT); } catch (e) { bootErr = e; }
        ck('the page script still parses and runs', !bootErr, bootErr && bootErr.message);

        if (!bootErr) {
            // What the browser asked for, in order — the thing being tested.
            const CALLS = [];
            w.api = async (p2, opts) => {
                CALLS.push({ path: String(p2).split('?')[0], method: (opts || {}).method || 'GET',
                             body: (opts || {}).body ? JSON.parse(opts.body) : null });
                if (/\/invoice\/generate$/.test(p2)) return {
                    ok: true, separate: true, container_no: 'MSDU2726332', inv_no: '26ARIS02',
                    saved_filenames: ['26ARIS02_INVOICE.pdf', '26ARIS02_PACKING_LIST.pdf'],
                    line_items: [{ item_desc: 'scrap auto parts', weight: 7.095, rate: 1208.13, amount: 8571.82 }],
                    photos: ['https://drive.example/load-1.jpg'],
                    warnings: ['The invoice charges 7.095 MT; the bill\'s weighbridge net is 6.758 MT.'],
                    weight_problems: [], weight_message: null,
                };
                if (/\/invoice\/draft-mail$/.test(p2)) return {
                    ok: true, to: 'buyer@aris.example', name: 'Aris Metals',
                    contact_cc: ['broker@aris.example'],
                    subject: 'Invoice 26ARIS02 — MSDU2726332',
                    body: 'Dear Aris Metals,\n\nPlease find attached…\n\nLoading photos:\nhttps://drive.example/load-1.jpg',
                    attachments: ['26ARIS02_INVOICE.pdf', '26ARIS02_PACKING_LIST.pdf'],
                    photos: ['https://drive.example/load-1.jpg'], warnings: [],
                };
                if (/\/invoice\/send$/.test(p2)) return {
                    ok: true, to: 'buyer@aris.example', subject: 'Invoice 26ARIS02 — MSDU2726332',
                    attached: ['26ARIS02_INVOICE.pdf', '26ARIS02_PACKING_LIST.pdf'],
                };
                return {};
            };
            await new Promise((r) => setTimeout(r, 40));

            ck('  openGenerateInvoice is reachable from the page',
               typeof w.openGenerateInvoice === 'function');

            if (typeof w.openGenerateInvoice === 'function') {
                const D = w.document;
                await w.openGenerateInvoice({ id: 'S1', container_no: 'MSDU2726332',
                                              invoice_no: '26ARIS02', customer: 'Aris Metals' });

                // ── STEP 1 ──────────────────────────────────────────────
                ck('step 1 asks the one question she asked to be asked',
                   !!D.getElementById('genModal')
                   && D.querySelectorAll('input[name=genMode]').length === 3,
                   String(D.querySelectorAll('input[name=genMode]').length));
                const modes = Array.from(D.querySelectorAll('input[name=genMode]')).map((e2) => e2.value);
                ck('  normal, separate and invoice only',
                   modes.join(',') === 'normal,separate,invoice_only', modes.join(','));
                ck('  with normal chosen by default, the shape she has always had',
                   D.querySelector('input[name=genMode]:checked').value === 'normal');
                ck('  and the button says Generate, not Create',
                   /^Generate$/.test(D.getElementById('genGo').textContent.trim())
                   && !/Create invoice/i.test(D.getElementById('genCard').innerHTML),
                   D.getElementById('genGo').textContent);

                // Pick separate, then generate.
                const sep = D.querySelector('input[value=separate]');
                sep.checked = true;
                sep.dispatchEvent(new w.Event('change'));
                ck('  choosing separate sticks',
                   D.querySelector('input[name=genMode]:checked').value === 'separate');

                // dispatchEvent, not .click(): a disabled button still fires
                // listeners under dispatchEvent, which would hide exactly the
                // double-press guard being asserted below.
                D.getElementById('genGo').click();
                await new Promise((r) => setTimeout(r, 40));

                ck('generate posted to the sale\'s route',
                   CALLS.some((c) => c.method === 'POST' && /\/api\/sales\/S1\/invoice\/generate$/.test(c.path)),
                   JSON.stringify(CALLS));
                ck('  carrying separate:true and invoice_only:false',
                   (CALLS.find((c) => /generate$/.test(c.path)) || {}).body
                   && CALLS.find((c) => /generate$/.test(c.path)).body.separate === true
                   && CALLS.find((c) => /generate$/.test(c.path)).body.invoice_only === false,
                   JSON.stringify((CALLS.find((c) => /generate$/.test(c.path)) || {}).body));

                // ── STEP 2: THE DOCUMENT ────────────────────────────────
                const card = D.getElementById('genCard');
                ck('step 2 shows the PDF itself, not a summary of it',
                   !!card.querySelector('iframe')
                   && /documents\/download/.test(card.querySelector('iframe').getAttribute('src')),
                   card.querySelector('iframe') ? card.querySelector('iframe').getAttribute('src') : 'no iframe');
                ck('  the quantity is printed in MT', /7\.095 MT/.test(card.textContent), '');
                ck('  and the rate per MT', /1,208\.13 \/MT/.test(card.textContent), '');
                ck('  the two-ledger warning is above the buttons, not below',
                   card.innerHTML.indexOf('weighbridge net') > -1
                   && card.innerHTML.indexOf('weighbridge net') < card.innerHTML.indexOf('id="genNext"'),
                   'a caution under the thing you press is one you read afterwards');
                ck('  both filenames are named', /26ARIS02_PACKING_LIST\.pdf/.test(card.textContent));
                ck('  and she can stop here without emailing anyone',
                   !!D.getElementById('genDone'), 'no way out but Send is not a way out');

                // NOTHING was emailed by getting this far.
                ck('  nothing has been sent yet',
                   !CALLS.some((c) => /\/send$/.test(c.path)), JSON.stringify(CALLS.map((c) => c.path)));

                D.getElementById('genNext').click();
                await new Promise((r) => setTimeout(r, 40));

                // ── STEP 3: THE EMAIL ───────────────────────────────────
                const card3 = D.getElementById('genCard');
                ck('step 3 shows the real address before it goes',
                   /buyer@aris\.example/.test(card3.textContent), '');
                ck('  the Cc too', /broker@aris\.example/.test(card3.textContent), '');
                // Subject and body are INPUTS now — "also make the email
                // editable" — and an input's value is not in textContent.
                // Reading the element is the point: a check that passed on
                // textContent would keep passing if the boxes rendered empty.
                ck('  the subject, in a box she can rewrite',
                   D.getElementById('genSubject')
                   && D.getElementById('genSubject').value === 'Invoice 26ARIS02 — MSDU2726332',
                   D.getElementById('genSubject') ? D.getElementById('genSubject').value : 'no subject box');
                ck('  the body she will actually send, also editable',
                   D.getElementById('genBody')
                   && /Please find attached/.test(D.getElementById('genBody').value),
                   D.getElementById('genBody') ? D.getElementById('genBody').value.slice(0, 60) : 'no body box');
                ck('  and what is attached', /26ARIS02_INVOICE\.pdf/.test(card3.textContent), '');
                ck('  the photos are named as LINKS, not attachments',
                   /links in the message, not as attachments/.test(card3.textContent), '');
                ck('  still nothing sent',
                   !CALLS.some((c) => /\/send$/.test(c.path)), '');
                ck('  and there is a way out that is not Send',
                   !!D.getElementById('genDone3') && !!D.getElementById('genBack3'));

                // ── AN EDIT REACHES THE SEND ────────────────────────────
                D.getElementById('genSubject').value = 'Invoice 26ARIS02 — corrected';
                D.getElementById('genBody').value = 'Dear Aris,\n\nRevised as discussed.\n\nJarvis';
                D.getElementById('genSend').click();
                await new Promise((r) => setTimeout(r, 40));

                const send = CALLS.find((c) => /\/send$/.test(c.path));
                ck('Send posts to the send route', !!send && send.method === 'POST',
                   JSON.stringify(CALLS.map((c) => c.method + ' ' + c.path)));
                ck('  with confirm true, which the route requires',
                   !!send && send.body && send.body.confirm === true,
                   JSON.stringify(send && send.body));
                ck('  and NOT with weights_ok, which she never answered',
                   !!send && send.body && send.body.weights_ok === undefined,
                   'weights_ok means she read the figures, not that there was no question');
                // "also make the email editable" — and editable means the
                // edit is what goes, not that the box accepts typing.
                ck('  carrying the subject SHE typed, not the generated one',
                   !!send && send.body.subject === 'Invoice 26ARIS02 — corrected',
                   JSON.stringify(send && send.body.subject));
                ck('  and the body she rewrote',
                   !!send && /Revised as discussed/.test(send.body.body || ''),
                   JSON.stringify(send && send.body.body));
                ck('  exactly one send, not one per press',
                   CALLS.filter((c) => /\/send$/.test(c.path)).length === 1,
                   String(CALLS.filter((c) => /\/send$/.test(c.path)).length));

                ck('step 4 says it went, and to whom',
                   /Emailed to buyer@aris\.example/.test(D.getElementById('genCard').textContent),
                   D.getElementById('genCard').textContent.slice(0, 120));

                // ── THE ORDER IS HERS ───────────────────────────────────
                // "first need to show the generated invoice then draft mail".
                const order = CALLS.filter((c) => /invoice\/(generate|draft-mail|send)$/.test(c.path))
                    .map((c) => c.path.split('/').pop());
                ck('generate, then draft-mail, then send — in that order',
                   order.join(' -> ') === 'generate -> draft-mail -> send', order.join(' -> '));

                // ── AND THE BOX, WHEN THERE IS NO CONTACT ───────────────
                // Her "else it can ask for email recipients separated by
                // comma". Driven the way she drives it: the draft comes back
                // refusing, she types a list, presses Use these, and the NEXT
                // thing on screen is the real message with those addresses on
                // it — not a send.
                CALLS.length = 0;
                let askedOnce = false;
                w.api = async (p2, opts) => {
                    CALLS.push({ path: String(p2).split('?')[0], query: String(p2).split('?')[1] || '',
                                 method: (opts || {}).method || 'GET',
                                 body: (opts || {}).body ? JSON.parse(opts.body) : null });
                    if (/\/invoice\/generate$/.test(p2)) return {
                        ok: true, container_no: 'TCNU2798153', inv_no: 'EM7001',
                        saved_filenames: ['EM7001.pdf'],
                        line_items: [{ item_desc: 'Al Wheels', weight: 6.8, rate: 3196.7, amount: 21737.56 }],
                        photos: [], warnings: [], weight_problems: [], weight_message: null };
                    if (/\/invoice\/draft-mail/.test(p2)) {
                        if (!askedOnce) { askedOnce = true; return {
                            ok: false, reason: 'no_contact', ask_recipients: true,
                            consignee: 'Edge Metals Recycling',
                            message: "Edge Metals Recycling isn't in Email Contacts…" }; }
                        return { ok: true, to: 'ops@emr.example', name: 'Edge Metals Recycling',
                                 contact_cc: ['accounts@emr.example'],
                                 subject: 'Invoice EM7001 — TCNU2798153',
                                 body: 'Dear Edge Metals Recycling,\n\nPlease find attached…',
                                 attachments: ['EM7001.pdf'], photos: [], warnings: [] };
                    }
                    if (/\/invoice\/send$/.test(p2)) return {
                        ok: true, to: 'ops@emr.example', subject: 'Invoice EM7001 — TCNU2798153',
                        attached: ['EM7001.pdf'], saved_contact: 'Edge Metals Recycling' };
                    return {};
                };

                await w.openGenerateInvoice({ id: 'S2', container_no: 'TCNU2798153',
                                              invoice_no: 'EM7001', customer: 'Edge Metals Recycling' });
                D.getElementById('genGo').click();
                await new Promise((r) => setTimeout(r, 40));
                D.getElementById('genNext').click();
                await new Promise((r) => setTimeout(r, 40));

                ck('no contact on file puts a box on screen, not a dead end',
                   !!D.getElementById('genRecipients'),
                   D.getElementById('genCard').textContent.slice(0, 120));
                ck('  naming the customer it needs addresses for',
                   /Edge Metals Recycling/.test(D.getElementById('genCard').textContent));
                ck('  and saying the first one is the addressee',
                   /first one is the addressee/.test(D.getElementById('genCard').textContent));
                ck('  with no Send button anywhere near it',
                   !D.getElementById('genSend'), 'nothing to press that would send to nobody');

                D.getElementById('genRecipients').value = 'ops@emr.example, accounts@emr.example';
                D.getElementById('genUseTo').click();
                await new Promise((r) => setTimeout(r, 40));

                const asked = CALLS.filter((c) => /draft-mail$/.test(c.path));
                ck('the typed list goes back through the SAME draft route',
                   asked.length === 2 && /recipients=/.test(asked[1].query),
                   JSON.stringify(asked.map((c) => c.query)));
                ck('  so she reads the real message before anything is sent',
                   /ops@emr\.example/.test(D.getElementById('genCard').textContent)
                   && /Please find attached/.test(D.getElementById('genCard').textContent),
                   D.getElementById('genCard').textContent.slice(0, 160));
                ck('  and still nothing has been sent',
                   !CALLS.some((c) => /\/send$/.test(c.path)), '');

                D.getElementById('genSend').click();
                await new Promise((r) => setTimeout(r, 40));
                const s2 = CALLS.find((c) => /\/send$/.test(c.path));
                ck('Send carries the typed addresses, not just the confirm',
                   !!s2 && s2.body.confirm === true
                   && s2.body.recipients === 'ops@emr.example, accounts@emr.example',
                   JSON.stringify(s2 && s2.body));
                ck('  and she is told it is in Email Contacts now',
                   /now in Email Contacts/.test(D.getElementById('genCard').textContent),
                   D.getElementById('genCard').textContent.slice(0, 200));

            }
        }
        w.close();
    }
}


// ══════════════════════════════════════════════════════════════════════════
section('EVERY GRADE OF THE CONTAINER, NOT JUST THE ROW SHE CLICKED');
// ══════════════════════════════════════════════════════════════════════════
// Apsara, 2026-09-21, having noticed that a bill carries all seven of its
// grades and asked why an invoice does not.
//
// Her Invoice ledger is ONE ROW PER GRADE. buildFrom read `items[]` off the
// single row it was handed, and a flat row has none — so Generate on the
// Alternator row of MSDU2726332 produced a commercial invoice with ONE line,
// $16,794.34, for a container worth $44,016.10, and reported readiness ok.
// She generates multi-grade invoices from the spreadsheet, so nothing short
// was ever sent; this was latent.
{
    const ARIS = (item, weight, price, over = {}) => ({
        id: 'S_' + item.replace(/\W/g, ''), date: '2026-09-18', customer: 'Aris Enterprises',
        booking_no: 'EBKG18670536', container_no: 'MSDU2726332', invoice_no: '260918_AP_26Aris02',
        item, weight, invoice_price: price, price_unit: 'lb', weight_unit: 'lb', ...over,
    });
    const FOUR = [ARIS('Sealed units', 15642, 0.548), ARIS('Alternator', 13457, 1.248),
                  ARIS('Starter', 6822, 0.973), ARIS('Electric motors', 16312, 0.738)];

    const descs = (inv) => inv.body.line_items.map((l) => l.item_desc).join(' | ');
    // allSales is injected so this never reads her real ledger.
    const build = (row, all) => saleInvoice.buildFrom(row, { bill: null, allSales: all });

    const fromAlt = build(FOUR[1], FOUR);
    ck('every grade is on the invoice, not just the row clicked',
       fromAlt.body.line_items.length === 4, descs(fromAlt));
    ck('  and the total is the container, not the grade',
       Math.abs(fromAlt.body.subtotal - 44042.23) < 0.02, String(fromAlt.body.subtotal));

    // THE PROPERTY: which row she clicks must not change the document.
    const fromSealed = build(FOUR[0], FOUR);
    ck('  the same invoice whichever row she clicks',
       descs(fromSealed) === descs(fromAlt) && fromSealed.body.subtotal === fromAlt.body.subtotal,
       `${descs(fromSealed)} vs ${descs(fromAlt)}`);

    // ── AND WHAT IT MUST NEVER MERGE ──────────────────────────────────────
    // Two rows on one container with DIFFERENT invoice numbers are two
    // invoices — a split billing — and putting one's metal on the other is
    // the worse failure of the two this fix exists between.
    const other = ARIS('Copper', 1000, 3.2, { id: 'S_OTHER', invoice_no: '260918_AP_26Aris99' });
    const guarded = build(FOUR[1], FOUR.concat([other]));
    ck('a different invoice number on the same container is NOT merged in',
       guarded.body.line_items.length === 4 && !/Copper/.test(descs(guarded)), descs(guarded));

    const otherCust = ARIS('Brass', 900, 2.1, { id: 'S_CUST', customer: 'Someone Else' });
    const guarded2 = build(FOUR[1], FOUR.concat([otherCust]));
    ck('and nor is another customer', !/Brass/.test(descs(guarded2)), descs(guarded2));

    const otherCont = ARIS('Zinc', 800, 1.1, { id: 'S_CONT', container_no: 'TCLU7654321' });
    const guarded3 = build(FOUR[1], FOUR.concat([otherCont]));
    ck('nor another container', !/Zinc/.test(descs(guarded3)), descs(guarded3));

    // A single-grade container is one line, exactly as before.
    const alone = ARIS('HMS', 40000, 0.31, { id: 'S_ALONE', container_no: 'MSKU0001111' });
    ck('a container with one grade is still one line',
       build(alone, [alone]).body.line_items.length === 1);

    // The path that ALREADY worked — a row carrying its own items[] — must be
    // untouched, or this fix would double-count a nested sale.
    const nested = ARIS('', 0, 0, { id: 'S_NEST', container_no: 'MSKU0002222',
        items: [{ description: 'Al combo', weight: 9000, price: 0.9 },
                { description: 'Shred', weight: 4000, price: 0.5 }] });
    const nestedInv = build(nested, [nested]);
    ck('a row with its own items still uses them', nestedInv.body.line_items.length === 2,
       descs(nestedInv));

    // The weighbridge figures describe the WHOLE container. Repeating them on
    // four lines would read as four containers to a customs officer.
    const withPacking = saleInvoice.buildFrom(FOUR[1], { allSales: FOUR,
        bill: { booking_no: 'EBKG18670536', container_no: 'MSDU2726332', gross: 44000, truck: 15000,
                container: 8500, chassis: 6600, boxes: 0, seal_no: '0173873' } });
    const packed = withPacking.body.line_items.filter((l) => l.packing && l.packing.gross_weight_lbs);
    ck('the container weighbridge figures appear ONCE, on the first line',
       packed.length === 1, `${packed.length} line(s) carry a gross weight`);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('SUITE CRASHED:', e && e.stack); process.exit(1); });
