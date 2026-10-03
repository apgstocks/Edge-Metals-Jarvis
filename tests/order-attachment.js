// ── tests/order-attachment.js ──────────────────────────────────────────────
// The last unread input. Every remaining is_order miss and 3 of 10 confidence
// caps were an attachment nothing opened: her P.O.s say "Please see the
// attached file for the additional P.O." and the figures live in the PDF.
//
// EVERY FIXTURE IS A REAL PDF, as helpers/gemini.extractOrderPdfFields
// actually read it (scripts/probe-order-pdf.js, 2026-10-03).
const path = require('path');
const R = (p) => path.join(__dirname, '..', p);

// Stubbed BEFORE anything loads them. gmail first, because the dead-path test
// below needs findLatestFrom to return what it really returns -- an ADDRESS.
const gmail = require(R('helpers/gmail.js'));
let MESSAGES = [];
let DOWNLOADS = 0;
gmail.findLatestFrom = async () => 'joey@hynos.co.kr';
gmail.listMessages = async () => MESSAGES.map((m, i) => ({ id: 'msg' + i }));
gmail.getMessage = async (_g, id) => MESSAGES[Number(String(id).replace('msg', '')) || 0];
gmail.getGmailRead = () => ({ stub: true });
gmail.downloadAttachment = async () => { DOWNLOADS++; return { filename: 'EMI-01.pdf', base64: 'JVBERi0x' }; };

const gem = require(R('helpers/gemini.js'));
let PDF_FIELDS = null;
let PDF_CALLS = 0;
gem.extractOrderPdfFields = async () => { PDF_CALLS++; return PDF_FIELDS; };
let BODY_ORDER = null;
gem.callGeminiJSON = async (_p, _n, schema) => (schema && schema.parse ? schema.parse(BODY_ORDER) : BODY_ORDER);

const pfe = require(R('helpers/proformaFromEmail.js'));
const { qtyToMt, mergePdfOrder, extractOrderFromEmail, toProformaDraft, groundRates } = pfe;

let pass = 0, fail = 0;
const failures = [];
const ck = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
};
const section = (t) => console.log(`\n=== ${t} ===`);

// Metalco's EMI-01, exactly as the reader returned it.
const EMI01 = {
    is_order_document: true, po_number: 'MTC-100126-EMI-01', buyer: 'Metalco, Inc.',
    trade_terms: 'FAS', port_discharge: null, payment_term: '100% T/T after container return',
    container_count: 2, container_size: '40HC',
    items: [{ desc: 'Steel Scrap for Smelting, HMS', qty: 40, qty_unit: 'mt', rate: 330, rate_basis: 'per_mt', rate_confidence: 1 }],
    note: 'Weight ticket and 5 pictures per container required for payment.',
};
// Eccomelt's PO 4302994 — one real line, three "1 LB" PRICE TIERS.
const ECCOMELT = {
    is_order_document: true, po_number: '4302994', buyer: 'Eccomelt LLC', payment_term: 'NET 15',
    container_count: null,
    items: [
        { desc: '356 ALUMINUM WHEELS - LOOSE', qty: 40000, qty_unit: 'LB', rate: 1.65, rate_basis: 'per_lb', rate_confidence: 0.95 },
        { desc: '356 ALUMINUM WHEELS - DIRTY', qty: 1, qty_unit: 'LB', rate: 1.61, rate_basis: 'per_lb', rate_confidence: 0.95 },
        { desc: '356 CHROME WHEELS', qty: 1, qty_unit: 'LB', rate: 1.15, rate_basis: 'per_lb', rate_confidence: 0.95 },
        { desc: 'CLAD WHEELS', qty: 1, qty_unit: 'LB', rate: 1.05, rate_basis: 'per_lb', rate_confidence: 0.95 },
    ],
    note: '1 LB lines are placeholder pricing tiers for downgrades.',
};

(async () => {
    section('OA — units are converted in CODE, never by the model');
    ck('OA1 metric tonnes pass through', qtyToMt(40, 'mt').mt === 40);
    ck('OA2 "tonnes" too', qtyToMt(21, 'tonnes').mt === 21);
    ck('OA3 pounds convert exactly', Math.abs(qtyToMt(40000, 'LB').mt - 18.144) < 0.01,
        String(qtyToMt(40000, 'LB').mt));
    ck('OA4 kilos convert', qtyToMt(21000, 'kg').mt === 21);
    // A SHORT TON IS 0.907 MT AND A LONG TON 1.016 -- a 12% spread on every
    // line. Refused rather than guessed.
    ck('OA5 a bare "tons" is REFUSED, not guessed',
        qtyToMt(40, 'tons').mt === null && qtyToMt(40, 'tons').why === 'ambiguous-ton',
        JSON.stringify(qtyToMt(40, 'tons')));
    ck('OA6 a "1 LB" tier row is flagged as a placeholder',
        qtyToMt(1, 'LB').mt === null && qtyToMt(1, 'LB').why === 'placeholder');
    ck('OA7 "containers" is a count, not a weight', qtyToMt(2, 'containers').mt === null);

    section('OB — the attachment fills blanks and never overwrites');
    const merged = mergePdfOrder({ is_order: false, consignee: null, items: [], container_count: null },
        EMI01, { filename: 'EMI-01.pdf' });
    ck('OB1 the buyer comes off the document', merged.consignee === 'Metalco, Inc.');
    ck('OB2 and the terms', merged.trade_terms === 'FAS' && /T\/T/.test(merged.payment_term));
    ck('OB3 and the container count', merged.container_count === 2);
    ck('OB4 and the PO number', merged.po_number === 'MTC-100126-EMI-01');
    ck('OB5 it becomes an order', merged.is_order === true);
    ck('OB6 the read-back says where it came from',
        /Read from the attached EMI-01\.pdf/.test(merged.note || ''), merged.note);
    // THE RULE THAT PREVENTS THE MOST DAMAGE. A revised price in the covering
    // mail is deliberate; the PDF may be the superseded version.
    const stated = mergePdfOrder({ is_order: true, consignee: 'Daekwang', container_count: 5,
        items: [{ desc: 'Auto casting tense', qty: 21, rate: 2520, rate_basis: 'per_mt' }] }, EMI01, {});
    ck('OB7 what the EMAIL said is never overwritten', stated.consignee === 'Daekwang'
        && stated.container_count === 5 && stated.items[0].rate === 2520
        && stated.items.length === 1, JSON.stringify(stated.items));
    ck('OB8 nor are its items replaced by the document\'s',
        stated.items[0].desc === 'Auto casting tense', stated.items[0].desc);

    section('OC — a tonnage across containers is divided, and SAID');
    ck('OC1 40 MT over 2 containers is 20 MT per container', merged.items[0].qty === 20,
        String(merged.items[0].qty));
    ck('OC2 and it records what it divided', merged.items[0].qty_per_container_of === 2);
    const d = toProformaDraft(await groundRates(merged), {});
    ck('OC3 the division is raised as an unconfirmed doubt, not done quietly',
        (d.unconfirmed || []).some((u) => /40 MT across 2 containers, so 20 MT per container/.test(u)),
        JSON.stringify(d.unconfirmed));
    ck('OC4 a figure read off a PDF is shown as read, never as grounded',
        (d.assumed || []).some((a) => /\$330 read off the attached order/.test(a))
        && !(d.grounded || []).some((g) => /330/.test(g)),
        `${JSON.stringify(d.assumed)} / ${JSON.stringify(d.grounded)}`);
    ck('OC5 the document\'s own caveat reaches her',
        (d.unconfirmed || []).some((u) => /5 pictures per container/.test(u)), JSON.stringify(d.unconfirmed));

    section('OD — placeholder tier rows never become priced lines');
    const ec = mergePdfOrder({ is_order: false, consignee: null, items: [] }, ECCOMELT, { filename: 'PO4302994.PDF' });
    ck('OD1 only the real line survives', ec.items.length === 1, JSON.stringify(ec.items.map((i) => i.desc)));
    ck('OD2 and it is the 40,000 lb one, converted', Math.abs(ec.items[0].qty - 18.144) < 0.01,
        String(ec.items[0].qty));
    ck('OD3 the conversion is shown with its arithmetic',
        /40000 lb from the attached order = 18\.144 MT/.test(ec.items[0].qty_note || ''), ec.items[0].qty_note);
    ck('OD4 the dropped rows are counted in the note',
        /3 placeholder line\(s\) ignored/.test(ec.note || ''), ec.note);
    ck('OD5 the per-lb basis survives for the rate layer', ec.items[0].rate_basis === 'per_lb');

    section('OE — a non-order document changes nothing');
    const before = { is_order: false, consignee: null, items: [] };
    const after = mergePdfOrder(before, { is_order_document: false, buyer: 'Someone', items: [{ desc: 'x', qty: 9, qty_unit: 'mt' }] }, {});
    ck('OE1 an invoice or packing list is ignored outright',
        after.consignee === null && (after.items || []).length === 0, JSON.stringify(after));
    ck('OE2 and a null read is ignored', mergePdfOrder(before, null, {}).consignee === null);

    section('OF — the PDF is read only when the body left a hole');
    PDF_CALLS = 0;
    PDF_FIELDS = EMI01;
    BODY_ORDER = { is_order: true, confidence: 0.9, consignee: 'Metalco', container_count: 2,
        items: [{ desc: 'Steel scrap', qty: 20, rate: 330, rate_confidence: 0.9, rate_basis: 'per_mt' }], missing: [], note: null };
    await extractOrderFromEmail({ from: 'a@b.com', subject: 'PO', body: 'see below', date: null,
        pdfs: [{ filename: 'EMI-01.pdf', base64: 'JVBERi0x' }] });
    ck('OF1 an email that states its own figures costs NO model call on the PDF',
        PDF_CALLS === 0, `calls = ${PDF_CALLS}`);
    BODY_ORDER = { is_order: true, confidence: 0.9, consignee: null, container_count: null,
        items: [], missing: ['quantity'], note: null };
    const filled = await extractOrderFromEmail({ from: 'a@b.com', subject: 'PO', body: 'Please see the attached file.',
        date: null, pdfs: [{ filename: 'EMI-01.pdf', base64: 'JVBERi0x' }] });
    ck('OF2 "please see the attached file" DOES read it', PDF_CALLS === 1, `calls = ${PDF_CALLS}`);
    ck('OF3 and the order comes back filled', filled.consignee === 'Metalco, Inc.'
        && filled.items.length === 1 && filled.items[0].rate === 330, JSON.stringify(filled.items));
    ck('OF4 no attachment, no call', (await (async () => {
        const c = PDF_CALLS;
        await extractOrderFromEmail({ from: 'a@b.com', subject: 'PO', body: 'nothing here', date: null });
        return PDF_CALLS === c;
    })()));

    section('OG — "send proforma to Joey" was DEAD, and no test saw it');
    // findLatestFrom returns an ADDRESS (actions.js:3130 uses it that way).
    // That string was passed into getEmailContent, the MIME-payload walker:
    //     getEmailContent('joey@hynos.co.kr') -> { body: '', pdfParts: [] }
    // so every real invocation answered "couldn't read anything in it". All 64
    // assertions in tests/proforma-send.js stub findLatestFrom to NULL, which
    // takes the "No recent email" branch and never reaches this code.
    ck('OG1 the payload walker really does return nothing for an address',
        gmail.getEmailContent('joey@hynos.co.kr').body === '',
        JSON.stringify(gmail.getEmailContent('joey@hynos.co.kr')));
    MESSAGES = [{ id: 'msg0', payload: { headers: [
        { name: 'From', value: 'Joey <joey@hynos.co.kr>' },
        { name: 'Subject', value: 'Confirmation of one container of Chrome wheels' },
        { name: 'Date', value: 'Sat, 3 Oct 2026 12:15:08 +0900' }],
        mimeType: 'text/plain', body: { data: Buffer.from('We confirm on container of clean Chrome wheels at $3,200 CIF incheon. Buyer: Jaemulpo').toString('base64') } } }];
    const actions = require(R('workflow/actions.js'));
    let replies = [];
    actions.init({ sendMessage: async (_c, t) => { replies.push(t); return true; },
        sendToManager: async (t) => { replies.push(t); return true; },
        sendToTeam: async (t) => { replies.push(t); return true; }, pushAlert: () => {} });
    BODY_ORDER = { is_order: true, confidence: 0.9, consignee: 'Jaemulpo', container_count: 1,
        items: [{ desc: 'Chrome wheels', qty: null, rate: 3200, rate_confidence: 0.9, rate_basis: 'per_mt' }],
        missing: [], note: null };
    replies = [];
    await actions.startProformaFromEmail('test@c.us', 'Joey').catch((e) => { replies.push('THREW: ' + e.message); });
    const all = replies.join('\n');
    ck('OG2 it no longer answers "couldn\'t read anything in it"',
        !/couldn't read anything in it/.test(all), all.slice(0, 200));
    ck('OG3 it reads the real message and gets to the figures',
        /Chrome wheels/.test(all) && /3,?200/.test(all), all.slice(0, 300));
    ck('OG4 it did not throw', !/THREW/.test(all), all.slice(0, 200));

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILED: ' + failures.join(', ')); process.exit(1); }
})();
