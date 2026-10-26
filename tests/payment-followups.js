// tests/payment-followups.js — drafts chasing customers who owe Edge Metals (Apsara, 2026-10-26).
// Her rule: customers on ETA-based terms (ETA-10, ETA+7 …) get NO draft; every other customer with an open
// invoice gets ONE draft asking for payment status + remittance details; terms are recorded per customer; the
// drafts sit in a list in Jarvis and NOTHING IS SENT.
// A: the helper. B: END TO END (CLAUDE.md §3) — real sales + a real receipt, real address book, the real server,
// the routes the Sales screen calls, and a check that no mail left and no sale/receipt changed.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-followups-'));
process.env.DATA_DIR = TMP; process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD = 'user-pw-aaa'; process.env.ADMIN_PASSWORD = 'admin-pw-bbb'; process.env.STAFF_PASSWORD = 'staff-pw-ccc';
let pass = 0, fail = 0;
const ck = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n); if (x) console.log('        ' + x); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const rej = async (p) => { try { await p; return null; } catch (e) { return e.message; } };
const sales = require(path.join(ROOT, 'helpers/sales'));
const receipts = require(path.join(ROOT, 'helpers/salesReceipts'));
const contacts = require(path.join(ROOT, 'helpers/emailContacts'));
const PF = require(path.join(ROOT, 'helpers/paymentFollowups'));
const gmail = require(path.join(ROOT, 'helpers/gmail'));
const mk = async (customer, invoice_no, date, weight, price, extra = {}) =>
    (await sales.addSale({ customer, invoice_no, date, item: 'Auto Cast', weight, invoice_price: price, price_unit: 'lb', weight_unit: 'lb', ...extra })).id;

(async () => {
    // Nothing may be mailed from here, ever. Fail loudly if anything tries.
    let mailed = 0; gmail.sendEmail = async () => { mailed++; };
    const real = { getGmailWrite: gmail.getGmailWrite }; gmail.getGmailWrite = () => { mailed++; throw new Error('mail attempted'); };

    // Daekwang: two open invoices (one part-paid). Twins: one open, on ETA terms. Kim: paid in full. Park: one open, no address.
    const d1 = await mk('Daekwang', 'EM-1', '2026-09-01', 10000, 1.00, { container_no: 'AAAA1111111', booking_no: 'BK1', terms: 'TT' });   // $10,000
    const d2 = await mk('Daekwang', 'EM-2', '2026-09-05', 5000, 0.50, { container_no: 'BBBB2222222', booking_no: 'BK2', terms: 'TT' });    // $2,500
    const tw = await mk('Twins Metal LLC', 'EM-3', '2026-09-02', 20000, 0.50, { container_no: 'CCCC3333333', terms: 'TT' });                // $10,000
    const kim = await mk('Kim Metals', 'EM-4', '2026-09-03', 1000, 1.00, { container_no: 'DDDD4444444', terms: 'TT' });                     // $1,000
    const park = await mk('Park Trading', 'EM-5', '2026-09-04', 3000, 1.00, { container_no: 'EEEE5555555', terms: 'LC' });                  // $3,000
    await receipts.addReceipt({ amount: 4000, mode: 'Cash', date: '2026-09-20', customer: 'Daekwang', allocations: [{ sale_id: d1, amount: 4000 }] });   // part-pays EM-1
    await receipts.addReceipt({ amount: 1000, mode: 'Cash', date: '2026-09-21', customer: 'Kim Metals', allocations: [{ sale_id: kim, amount: 1000 }] }); // pays EM-4 in full
    await contacts.addContact('Daekwang', 'ap@daekwang.example');
    await contacts.addContact('Twins Metal LLC', 'ap@twins.example');

    section('A. the rule');
    const b0 = PF.build();
    ck('customers with an open invoice get ONE draft each: Daekwang, Twins, Park (Kim is paid up)', b0.drafts.map((d) => d.customer).sort().join() === 'Daekwang,Park Trading,Twins Metal LLC', b0.drafts.map((d) => d.customer).join());
    const dk = b0.drafts.find((d) => d.customer === 'Daekwang');
    ck('Daekwang\'s draft lists BOTH open invoices in one email, total = what is still owed ($6,000 + $2,500)', dk.count === 2 && dk.total === 8500, JSON.stringify(dk.lines.map((l) => [l.invoice_no, l.balance])));
    ck('a part-paid invoice shows what is OUTSTANDING and what arrived', /EM-1[^\n]*\$6,000\.00 outstanding, \$4,000\.00 received so far/.test(dk.body) && /EM-2[^\n]*\$2,500\.00 outstanding/.test(dk.body), dk.body);
    ck('it asks for payment status AND the remittance details, and says when to expect payment', /confirm the payment status/.test(dk.body) && /remittance details/.test(dk.body) && /when we can expect it/.test(dk.body));
    ck('a paid-up customer gets nothing', !b0.drafts.some((d) => d.customer === 'Kim Metals'));
    ck('address from the address book; none on file is said, not invented', dk.to === 'ap@daekwang.example' && b0.drafts.find((d) => d.customer === 'Park Trading').to_missing === true && b0.drafts.find((d) => d.customer === 'Park Trading').to === null);
    ck('totals add up: open invoices and outstanding', b0.open_invoices === 4 && b0.total_outstanding === 21500, JSON.stringify([b0.open_invoices, b0.total_outstanding]));

    section('B. ETA terms: per customer, and those customers get NO draft');
    ck('ETA-10 / ETA+7 / "eta - 3" are accepted and normalised', PF.parseEtaTerms('eta-10') === 'ETA-10' && PF.parseEtaTerms('ETA+7') === 'ETA+7' && PF.parseEtaTerms(' ETA - 3 ') === 'ETA-3' && PF.parseEtaTerms('') === null);
    ck('anything else is refused with the format', /ETA-10 or ETA\+7/.test(await rej(PF.setEtaTerms('Twins Metal LLC', '30 days'))) && /which customer/.test(await rej(PF.setEtaTerms('', 'ETA-10'))));
    ck('refused terms saved nothing', Object.keys(PF.loadTerms()).length === 0);
    await PF.setEtaTerms('  twins   METAL llc ', 'ETA-10');
    const b1 = PF.build();
    ck('Twins (matched however it is spelled/spaced) is now skipped — no draft', !b1.drafts.some((d) => d.customer === 'Twins Metal LLC') && b1.skipped_eta.length === 1 && b1.skipped_eta[0].eta_terms === 'ETA-10' && b1.skipped_eta[0].total === 10000, JSON.stringify(b1.skipped_eta));
    ck('everyone else is unchanged by that', b1.drafts.map((d) => d.customer).sort().join() === 'Daekwang,Park Trading', b1.drafts.map((d) => d.customer).join());
    await PF.setEtaTerms('Twins Metal LLC', '');
    ck('clearing the terms brings the draft back', PF.build().drafts.some((d) => d.customer === 'Twins Metal LLC') && PF.build().skipped_eta.length === 0);

    section('C. END TO END through the routes the Sales screen calls');
    const { createApi } = require(path.join(ROOT, 'api'));
    const server = await new Promise((r) => { const s = createApi().listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = (method, p, { sid, body } = {}) => new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body); const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r = http.request(base + p, { method, headers }, (res) => { let raw = ''; res.on('data', (c) => { raw += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j }); }); });
        r.on('error', reject); if (data) r.write(data); r.end();
    });
    ck('the route needs a login', [401, 403].includes((await req('GET', '/api/payment-followups')).status));
    const sid = (await req('POST', '/login', { body: { password: process.env.ADMIN_PASSWORD } })).json.sid;
    const staff = (await req('POST', '/login', { body: { password: process.env.STAFF_PASSWORD } })).json.sid;
    ck('staff (yard) cannot read customers\' balances — same as /api/sales', staff && [401, 403].includes((await req('GET', '/api/payment-followups', { sid: staff })).status) && [401, 403].includes((await req('GET', '/api/sales', { sid: staff })).status));
    const before = JSON.stringify([sales.listWithTotals().map((s) => [s.id, s.balance]), receipts.list().length]);
    const g0 = (await req('GET', '/api/payment-followups', { sid })).json;
    ck('the list route returns the same drafts the helper builds', g0.drafts.length === 3 && g0.drafts.find((d) => d.customer === 'Daekwang').total === 8500, JSON.stringify(g0.drafts.map((d) => d.customer)));
    const put = await req('PUT', '/api/payment-followups/terms', { sid, body: { customer: 'Twins Metal LLC', eta_terms: 'ETA+7' } });
    ck('the screen\'s save-terms call works', put.status === 200 && put.json.eta_terms === 'ETA+7', JSON.stringify(put.json));
    const g1 = (await req('GET', '/api/payment-followups', { sid })).json;
    ck('read back through the list route: Twins moved to "no draft", with its terms', !g1.drafts.some((d) => d.customer === 'Twins Metal LLC') && g1.skipped_eta[0].customer === 'Twins Metal LLC' && g1.skipped_eta[0].eta_terms === 'ETA+7');
    ck('a bad value is refused by the route with the reason', (await req('PUT', '/api/payment-followups/terms', { sid, body: { customer: 'Twins Metal LLC', eta_terms: 'net 30' } })).status === 400);
    ck('removing the terms through the route restores the draft', (await req('PUT', '/api/payment-followups/terms', { sid, body: { customer: 'Twins Metal LLC', eta_terms: '' } })).status === 200 && (await req('GET', '/api/payment-followups', { sid })).json.drafts.length === 3);
    ck('NOTHING WAS SENT, and no sale or receipt moved', mailed === 0 && JSON.stringify([sales.listWithTotals().map((s) => [s.id, s.balance]), receipts.list().length]) === before);
    ck('the existing sales route is unchanged by the new ones', (await req('GET', '/api/sales', { sid })).json.sales.length === 5);
    server.close();

    section('D. the screen');
    const js = fs.readFileSync(path.join(ROOT, 'dashboard/app/07-bills-sales.js'), 'utf8');
    ck('a button on the SALES ledger only (not Bills)', /kind === 'sales' \? '<button id="btnFollowups"/.test(js) && /\$\('btnFollowups'\)\.onclick = \(\) => openFollowups\(\)/.test(js));
    ck('the screen reads the route tested above and saves terms through the PUT tested above', /api\('\/api\/payment-followups'\)/.test(js) && /api\('\/api\/payment-followups\/terms', \{ method: 'PUT'/.test(js));
    ck('it only offers Copy and Open in mail — there is no send call', /pfCopy/.test(js) && /pfMail/.test(js) && !/payment-followups[^\n]*send/i.test(js) && /nothing is sent from here/.test(js));
    ck('copy / mail use what is in the box, so her edits are not lost', /bodyOf\(b\.dataset\.i\)/.test(js));
    gmail.getGmailWrite = real.getGmailWrite;
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
