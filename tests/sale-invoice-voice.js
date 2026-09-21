// ── tests/sale-invoice-voice.js ─────────────────────────────────────────────
// Apsara, 2026-09-21: "If i say jarvis, generate invoice for the inesh
// container..start from latest date in bill.. if some data is missing ...
// show invoice tab to user, ask what is missing - based on user input - fill
// it, then generate". Invoice number: "ask me". Channels: voice + WhatsApp.
//
// A. the pure parts (helpers/saleInvoiceFlow) and the routing
// B. END TO END by voice: a real server, /api/voice/ask, one sentence at a
//    time — no sale yet, two fields missing, the invoice number, yes, the
//    layout, the PDFs on disk, the email staged and sent.
// C. a multi-grade container: the invoice number lands on EVERY grade row,
//    or the invoice prints one line of two
// D. END TO END on WhatsApp (/api/bot/command): two containers on the
//    latest date, a pick, a complete sale, the PDF attached to the reply
// E. cancel / no / nothing found / another question already open
const path = require('path');
const fs = require('fs');
const http = require('http');
const Module = require('module');
const R = (p) => path.join(__dirname, '..', p);

// Chrome is the one step that cannot run here (see tests/sale-invoice.js).
const RENDERED = [];
const origLoad = Module._load;
Module._load = function (r) {
    if (r === 'puppeteer') return {
        launch: async () => ({
            newPage: async () => ({
                setContent: async (html) => { RENDERED.push(String(html)); },
                evaluate: async () => {}, pdf: async () => Buffer.from('%PDF-1.4 fake\n%%EOF'),
                $eval: async () => 1000, addStyleTag: async () => {}, emulateMediaType: async () => {},
            }),
            close: async () => {},
        }),
    };
    return origLoad.apply(this, arguments);
};
const { boot } = require('./helpers/e2e');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');
const A = (r) => (r && r.json && r.json.answer) || '';
const S = (r) => (r && r.json && (r.json.spoken || r.json.answer)) || '';

function bot(port, text) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ text });
        const req = http.request({ host: '127.0.0.1', port, path: '/api/bot/command', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
                Authorization: `Bearer ${process.env.API_TOKEN}` } }, (res) => {
            let raw = ''; res.on('data', (d) => { raw += d; });
            res.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json, raw }); });
        });
        req.on('error', reject); req.write(body); req.end();
    });
}
const T = (r) => ((r.json && r.json.replies) || []).map((x) => x.text).filter(Boolean).join('\n');

(async () => {

section('A. the pure parts, and the routing');
{
    const j = await boot({});
    const flow = require(R('helpers/saleInvoiceFlow'));
    const brain = require(R('workflow/brain'));
    const P = (text, pendingAction = null) => brain.policyDecide({ isManagerOrTeam: true, isManager: true,
        pendingAction, text, textLower: text.toLowerCase(), chatId: 't@c.us', session: {} });

    // Her sentence, verbatim.
    let d = P('jarvis,generate invoice for the inesh container..start from latest date in bill');
    ck('her sentence routes to generate_sale_invoice', d.intent === 'generate_sale_invoice', JSON.stringify(d));
    ck('  naming Inesh as the supplier', d.data && d.data.target_name && /^inesh$/i.test(d.data.target_name), JSON.stringify(d.data));
    d = P('create invoice for HMMU7060866');
    ck('a container number is taken as the container', d.intent === 'generate_sale_invoice' && d.data.container_no === 'HMMU7060866', JSON.stringify(d));
    d = P("make the invoice for Inesh's latest container");
    ck("\"Inesh's latest container\" is still Inesh", d.intent === 'generate_sale_invoice' && /^inesh$/i.test(d.data.target_name || ''), JSON.stringify(d.data));
    ck('a proforma is NOT this', P('create a proforma for Daekwang').intent !== 'generate_sale_invoice');
    ck('sending documents is NOT this', P('send the invoice for HMMU7060866').intent === 'send_shipment_docs');
    ck('a question about an invoice is NOT this', P('did we create the invoice for inesh').intent !== 'generate_sale_invoice');
    ck('unpaid invoices is NOT this', P('show unpaid invoices').intent !== 'generate_sale_invoice');
    ck('an open pending gets her answer', P('Daekwang', { type: 'await_sale_invoice', stage: 'field', field: 'customer', arbitrate: true }).intent === 'sale_invoice_answer');
    ck('  and "cancel" still cancels it', P('cancel', { type: 'await_sale_invoice', stage: 'field' }).intent === 'resolve_pending');

    // Answers.
    let a = flow.parseAnswer('invoice_price', '0.55 per pound');
    ck('"0.55 per pound" is 0.55/lb', a.ok && a.patch.invoice_price === 0.55 && a.patch.price_unit === 'lb' && !a.inferred, JSON.stringify(a));
    a = flow.parseAnswer('invoice_price', '1,210 per MT');
    ck('"1,210 per MT" is 1210/MT', a.ok && a.patch.invoice_price === 1210 && a.patch.price_unit === 'mt');
    a = flow.parseAnswer('invoice_price', '55 cents');
    ck('"55 cents" is 0.55/lb', a.ok && Math.abs(a.patch.invoice_price - 0.55) < 1e-9 && a.patch.price_unit === 'lb', JSON.stringify(a));
    a = flow.parseAnswer('invoice_price', '0.55');
    ck('a bare 0.55 is per lb AND flagged as inferred', a.ok && a.patch.price_unit === 'lb' && a.inferred === true);
    ck('"yes" is not a price', !flow.parseAnswer('invoice_price', 'yes').ok);
    ck('"customer is Daekwang" is Daekwang', flow.parseAnswer('customer', 'customer is Daekwang').patch.customer === 'Daekwang');
    a = flow.parseAnswer('weight', '7.1 MT');
    ck('"7.1 MT" is 7.1 MT', a.ok && a.patch.weight === 7.1 && a.patch.weight_unit === 'mt');
    ck('a container answer needs the shape', !flow.parseAnswer('container_no', 'the blue one').ok && flow.parseAnswer('container_no', 'hmmu 7060866').patch.container_no === 'HMMU7060866');
    ck('invoice number "yes" takes the suggestion', flow.parseInvNo('yes', '260921_AP_26DK15').inv_no === '260921_AP_26DK15');
    ck('  "yes" with nothing suggested is not a number', flow.parseInvNo('yes', null).ok === false);
    ck('  her own number is kept verbatim', flow.parseInvNo('invoice number is 26dk15a', 'x').inv_no === '26DK15A');
    ck('layout: separate', flow.parseLayout('separate please').separate === true);
    ck('layout: invoice only', flow.parseLayout('just the invoice').invoiceOnly === true);
    ck('layout: normal', flow.parseLayout('normal').separate === false && flow.parseLayout('normal').invoiceOnly === false);
    ck('layout: nonsense is asked again', flow.parseLayout('hmm') === null);

    // Latest date.
    const bills = require(R('helpers/bills'));
    await bills.addBill({ date: '09/01/2026', supplier: 'Inesh Cores Chapin', booking_no: 'BK1', container_no: 'OLDU1111111', gross: 30000, truck: 9000, container: 4000, chassis: 1000, boxes: 0 });
    await bills.addBill({ date: '09/18/2026', supplier: 'Inesh', booking_no: 'BK2', container_no: 'NEWU2222222', gross: 30000, truck: 9000, container: 4000, chassis: 1000, boxes: 0, description: 'Electric motors' });
    await bills.addBill({ date: '09/20/2026', supplier: 'Gomez', booking_no: 'BK3', container_no: 'GOMU3333333' });
    let f = flow.latestBillsFor('inesh');
    ck('the latest Inesh bill is the 09/18 one', f.bills.length === 1 && f.bills[0].container_no === 'NEWU2222222', JSON.stringify(f.bills.map((b) => b.container_no)));
    ck('  across spellings of the supplier', flow.supplierMatches('Inesh Cores Chapin', 'inesh'));
    ck('  and Gomez is not Inesh', !flow.supplierMatches('Gomez', 'inesh'));
    ck('nobody by that name comes back empty, with who IS on file', flow.latestBillsFor('zzz').bills.length === 0 && flow.latestBillsFor('zzz').known.includes('Gomez'));

    const g = flow.groupSales([
        { id: 1, invoice_no: '', customer: 'Aris' }, { id: 2, invoice_no: '', customer: 'aris' },
        { id: 3, invoice_no: '26X1', customer: 'Aris' }]);
    ck('grade rows gather by invoice number + customer', g.length === 2 && g[0].rows.length === 2);
    await j.stop();
}

section('B. end to end by voice — no sale yet, two things missing');
{
    const j = await boot({});
    const bills = require(R('helpers/bills'));
    const sales = require(R('helpers/sales'));
    const cfg = require(R('config'));
    const { mutateJson } = require(R('helpers/json'));
    require(R('helpers/nextInvoiceNo')).suggestNextInvNo = async (c) => (/daekwang/i.test(c)
        ? { inv_no: '260921_AP_26DK15', highest_existing: '26DK14' } : null);
    await mutateJson(cfg.EMAIL_CONTACTS_FILE, [], (all) => { all.push({ id: 'C9', name: 'Daekwang', email: 'buy@daekwang.example' }); return all; });
    await bills.addBill({ date: '09/10/2026', supplier: 'Inesh', booking_no: 'BKA', container_no: 'OLDU1111111', gross: 30000, truck: 9000, container: 4000, chassis: 1000, boxes: 0, description: 'Cores' });
    await bills.addBill({ date: '09/18/2026', supplier: 'Inesh', booking_no: 'BKB', container_no: 'TCLU9988776', seal_no: 'S1',
        gross: 31250, truck: 9000, container: 4400, chassis: 1250, boxes: 0, description: 'Electric motors',
        photos: 'https://drive.example/inesh-1.jpg' });
    const salesBefore = sales.list().length;

    const one = await j.say('generate invoice for the inesh container, start from latest date in bill');
    ck('the server answers', one.status === 200, one.raw.slice(0, 200));
    ck('  it picked the LATEST bill (09/18), not the older one', /TCLU9988776/.test(A(one)) && !/OLDU1111111/.test(A(one)), A(one));
    ck('  says there is no sale row yet and it will make one', /no sale row yet/i.test(A(one)), A(one));
    ck('  names what is missing: customer and price', /still need: customer/i.test(A(one)), A(one));
    ck('  and asks for the first one', /who is the customer\?/i.test(A(one)), A(one));
    ck('  the outgoing-invoice tab opens', one.json.open && one.json.open.key === 'invoice', JSON.stringify(one.json.open));
    ck('  the mic stays open for her answer', one.json.awaiting === true);
    ck('  and the container number is NOT read aloud', !/TCLU/.test(S(one)), S(one));

    const two = await j.say('Daekwang');
    ck('customer heard', /customer Daekwang/i.test(A(two)), A(two));
    ck('  and the price is asked next', /selling price/i.test(A(two)), A(two));

    const three = await j.say('0.55 per pound');
    ck('price heard, with the per-MT figure beside it', /\$0\.55\/lb \(\$1,212\.54\/MT\)/.test(A(three)), A(three));
    ck('  the invoice number is ASKED, with the sheet\'s suggestion', /260921_AP_26DK15/.test(A(three)) && /last was 26DK14/.test(A(three)), A(three));
    ck('  nothing written to the ledger yet', sales.list().length === salesBefore);

    const four = await j.say('yes');
    ck('the full list of what will be saved is shown', /Customer: Daekwang/.test(A(four)) && /Invoice number: 260921_AP_26DK15/.test(A(four)) && /Weight: 16,600 lb/.test(A(four)), A(four));
    ck('  and it asks before saving', /\(yes\/no\)/.test(A(four)));
    ck('  still nothing written', sales.list().length === salesBefore);

    const five = await j.say('yes');
    ck('saved, then asked the layout', /Normal invoice, separate invoice and packing list, or invoice only\?/.test(A(five)), A(five));
    const row = sales.list().find((s) => s.container_no === 'TCLU9988776');
    ck('  ONE sale row was added', sales.list().length === salesBefore + 1 && !!row);
    ck('  with what she said', row && row.customer === 'Daekwang' && Number(row.invoice_price) === 0.55 && row.price_unit === 'lb' && row.invoice_no === '260921_AP_26DK15', JSON.stringify(row));
    ck('  and what the bill said', row && Number(row.weight) === 16600 && row.booking_no === 'BKB' && row.item === 'Electric motors', JSON.stringify(row));

    RENDERED.length = 0;
    const six = await j.say('separate');
    ck('generated', /Generated 260921_AP_26DK15 for TCLU9988776 — separate invoice and packing list/.test(A(six)), A(six));
    const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const dir = path.join(cfg.DOCUMENTS_SAVED_DIR, 'invoice', TODAY, 'TCLU9988776');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    ck('  two PDFs really on disk', files.length === 2 && files.some((f) => /_INVOICE\.pdf$/.test(f)) && files.some((f) => /_PACKING_LIST\.pdf$/.test(f)), JSON.stringify(files));
    ck('  the printed quantity is MT (16,600 lb = 7.530 MT), not pounds', /7\.530/.test(RENDERED.join('\n')) && !/16,?600\.000/.test(RENDERED.join('\n')));
    ck('  the Documents screen opens', six.json.open && six.json.open.key === 'doc-invoice', JSON.stringify(six.json.open));
    ck('  and it asks before emailing, with the address', /Email it to Daekwang <buy@daekwang\.example>\?/.test(A(six)) && /Send this\? \(yes\/no\)/.test(A(six)), A(six));
    ck('  the loading photo goes as a link', /Loading photos: 1 linked/.test(A(six)), A(six));
    ck('  nothing emailed yet', j.mails.length === 0);

    const seven = await j.say('yes');
    ck('sent', j.mails.length === 1, A(seven));
    const m = j.mails[0] || {};
    ck('  to Daekwang', /buy@daekwang\.example/.test(String(m.to)), String(m.to));
    ck('  with both documents attached', (m.attachments || []).length === 2, JSON.stringify((m.attachments || []).map((x) => x.filename)));
    ck('  and the photo link in the body', /https:\/\/drive\.example\/inesh-1\.jpg/.test(String(m.body)));
    await j.stop();
}

section('C. a multi-grade container: the invoice number lands on every grade');
{
    const j = await boot({});
    const bills = require(R('helpers/bills'));
    const sales = require(R('helpers/sales'));
    require(R('helpers/nextInvoiceNo')).suggestNextInvNo = async () => ({ inv_no: '26AR07', highest_existing: '26AR06' });
    await bills.addBill({ date: '09/19/2026', supplier: 'Inesh', booking_no: 'BKM', container_no: 'MSDU2726332', gross: 30000, truck: 9000, container: 4000, chassis: 1000, boxes: 0 });
    const a = await sales.addSale({ booking_no: 'BKM', container_no: 'MSDU2726332', customer: 'Aris Metals', date: '09/20/2026', item: 'Alternator', weight: 8000, invoice_price: 0.5 });
    const b = await sales.addSale({ booking_no: 'BKM', container_no: 'MSDU2726332', customer: 'Aris Metals', date: '09/20/2026', item: 'Starter', weight: 7000, invoice_price: 0.45 });

    const one = await j.say('make the invoice for inesh');
    ck('nothing missing, so it goes straight to the invoice number', /26AR07/.test(A(one)) && !/still need/i.test(A(one)), A(one));
    const two = await j.say('yes');
    ck('the change is listed for BOTH grades', /\*Alternator\*/.test(A(two)) && /\*Starter\*/.test(A(two)), A(two));
    await j.say('yes');
    ck('  both rows carry the invoice number', sales.getSale(a.id).invoice_no === '26AR07' && sales.getSale(b.id).invoice_no === '26AR07',
       `${sales.getSale(a.id).invoice_no} / ${sales.getSale(b.id).invoice_no}`);
    RENDERED.length = 0;
    const four = await j.say('normal');
    ck('generated with BOTH grades on it', /Alternator/.test(A(four)) && /Starter/.test(A(four)), A(four));
    ck('  and it says why it cannot email yet (no contact on file)', /only the email is waiting/i.test(A(four)), A(four));
    ck('  without leaving a question open', !require(R('workflow/actions')).getPending(`${require(R('config')).getSettings().manager_number || require(R('config')).MANAGER_NUMBER}@c.us`));
    await j.stop();
}

section('D. end to end on WhatsApp — two containers on the latest date');
{
    const j = await boot({});
    const bills = require(R('helpers/bills'));
    const sales = require(R('helpers/sales'));
    await bills.addBill({ date: '09/20/2026', supplier: 'Inesh', booking_no: 'BKW', container_no: 'AAAU1000001', description: 'Motors', gross: 30000, truck: 9000, container: 4000, chassis: 1000, boxes: 0 });
    await bills.addBill({ date: '09/20/2026', supplier: 'Inesh', booking_no: 'BKW', container_no: 'BBBU2000002', description: 'Cores', gross: 30000, truck: 9000, container: 4000, chassis: 1000, boxes: 0 });
    await sales.addSale({ booking_no: 'BKW', container_no: 'BBBU2000002', customer: 'Zimex', date: '09/21/2026', item: 'Cores', weight: 16000, invoice_price: 0.6, invoice_no: '26ZX03' });

    const one = await bot(j.port, 'generate invoice for inesh');
    ck('WhatsApp answers', one.status === 200, one.raw.slice(0, 200));
    ck('  lists both containers on the latest date and asks which', /1\. AAAU1000001/.test(T(one)) && /2\. BBBU2000002/.test(T(one)) && /Which one/.test(T(one)), T(one));
    const two = await bot(j.port, '2');
    ck('the pick lands; the sale already has an invoice number, so it asks to keep it', /already has invoice number 26ZX03/.test(T(two)), T(two));
    const three = await bot(j.port, 'yes');
    ck('nothing changed, so straight to the layout', /Normal invoice/.test(T(three)) && !/\(yes\/no\)/.test(T(three)), T(three));
    const four = await bot(j.port, 'normal');
    ck('generated', /Generated 26ZX03 for BBBU2000002 — normal/.test(T(four)), T(four));
    const media = ((four.json && four.json.replies) || []).map((r) => r.media).filter(Boolean);
    ck('  the PDF is ATTACHED to the WhatsApp reply', media.length === 1 && media[0].mimetype === 'application/pdf' && /26ZX03\.pdf$/.test(media[0].filename), JSON.stringify(media.map((m) => m.filename)));
    await j.stop();
}

section('E. cancel, no, nothing found, and another question already open');
{
    const j = await boot({});
    const bills = require(R('helpers/bills'));
    const sales = require(R('helpers/sales'));
    const actions = require(R('workflow/actions'));
    const cfg = require(R('config'));
    const chat = `${cfg.getSettings().manager_number || cfg.MANAGER_NUMBER}@c.us`;
    require(R('helpers/nextInvoiceNo')).suggestNextInvNo = async () => null;
    await bills.addBill({ date: '09/20/2026', supplier: 'Inesh', booking_no: 'BKE', container_no: 'EEEU1000001', description: 'Motors', gross: 30000, truck: 9000, container: 4000, chassis: 1000, boxes: 0 });

    const none = await j.say('generate invoice for the zorro container');
    ck('no bills from them — says so, and who does have bills', /No bills from "zorro"/i.test(A(none)) && /Inesh/.test(A(none)), A(none));

    // THE COLLISION. "prepare an invoice for Daekwang" has started a PROFORMA
    // by voice since 2026-09-07. Daekwang is a customer with no bills, so it
    // must still do exactly that.
    const pf = await j.say('prepare an invoice for Daekwang');
    ck('"prepare an invoice for Daekwang" still starts a proforma', !!(pf.json && pf.json.proforma && pf.json.proforma.stage) && !actions.getPending(chat), A(pf));
    await j.say('cancel');
    require(R('helpers/proformaDraft')).clear();

    await j.say('generate invoice for inesh');
    const c = await j.say('cancel');
    ck('cancel closes it', !actions.getPending(chat), A(c));
    ck('  and wrote nothing', sales.list().length === 0);

    await j.say('generate invoice for inesh');
    await j.say('Zimex');
    const noSuggest = await j.say('0.6 per lb');
    ck('with no suggestion, it asks for the number plainly', /couldn't find Zimex in the invoice sheet/i.test(A(noSuggest)), A(noSuggest));
    const bad = await j.say('yes');
    ck('  "yes" with nothing to accept is asked again', /invoice number/i.test(A(bad)) && sales.list().length === 0, A(bad));
    await j.say('26ZX09');
    const no = await j.say('no');
    ck('"no" at the save question saves nothing', /Not saved/.test(A(no)) && sales.list().length === 0 && !actions.getPending(chat), A(no));

    await actions.setPending(chat, { type: 'await_email_confirm', to: 'a@b.example', subject: 's', body: 'b', target_name: 'A' });
    const blocked = await j.say('generate invoice for inesh');
    ck('another open question is not trampled', actions.getPending(chat).type === 'await_email_confirm' && /answer first/.test(A(blocked)), A(blocked));
    await j.stop();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILED:\n  - ' + failures.join('\n  - ')); }
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
