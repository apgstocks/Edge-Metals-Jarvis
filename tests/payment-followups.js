// tests/payment-followups.js — drafts chasing customers who owe Edge Metals (Apsara, 2026-10-26).
// Her rule: every customer NOT on ETA terms gets ONE remittance-status draft for their open invoices; a customer ON ETA
// terms (ETA-10, ETA+7 …, recorded per customer) is drafted only from ETA-11 days of each invoice's booking ETA, as a
// payment request; drafts sit in a list in Jarvis and NOTHING IS SENT.
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
    const tw = await mk('Twins Metal LLC', 'EM-3', '2026-09-02', 20000, 0.50, { container_no: 'CCCC3333333', booking_no: 'BKT1', terms: 'TT' });                // $10,000
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

    section('B. ETA terms: per customer, drafted only from ETA-11 days, as a PAYMENT request');
    ck('ETA-10 / ETA+7 / "eta - 3" are accepted and normalised', PF.parseEtaTerms('eta-10') === 'ETA-10' && PF.parseEtaTerms('ETA+7') === 'ETA+7' && PF.parseEtaTerms(' ETA - 3 ') === 'ETA-3' && PF.parseEtaTerms('') === null);
    ck('anything else is refused with the format', /ETA-10 or ETA\+7/.test(await rej(PF.setEtaTerms('Twins Metal LLC', '30 days'))) && /which customer/.test(await rej(PF.setEtaTerms('', 'ETA-10'))));
    ck('refused terms saved nothing', Object.keys(PF.loadTerms()).length === 0);
    ck('dates: MM/DD/YYYY (her format) and ISO both read; nonsense and impossible dates do not', PF.parseDate('11/15/2026') === Date.UTC(2026, 10, 15) && PF.parseDate('2026-11-15') === Date.UTC(2026, 10, 15) && PF.parseDate('13/45/2026') === null && PF.parseDate('soon') === null && PF.parseDate('') === null);
    ck('the lead time is 11 days (her words: "start sending email from ETA-11 days")', PF.LEAD_DAYS === 11);
    ck('the ETA is read off the booking, by booking number however it is typed', PF.bookingEta(' bkt 1 ', { BKT1: { booking_no: 'BKT1', eta: '11/20/2026' } }) === Date.UTC(2026, 10, 20) && PF.bookingEta('NOPE', { BKT1: { eta: '11/20/2026' } }) === null && PF.bookingEta('BKT1', { BKT1: { eta: null } }) === null);
    await PF.setEtaTerms('  twins   METAL llc ', 'ETA-10');
    const NOW = Date.UTC(2026, 10, 1, 15, 0);                                                                  // 1 Nov 2026
    const eta = (m, d) => `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/2026`;
    const bk = (e) => ({ BKT1: { booking_no: 'BKT1', eta: e } });
    const twinsBuild = (e) => PF.build({ now: NOW, bookings: e === undefined ? {} : bk(e) });
    const b11 = twinsBuild(eta(11, 12));                                                                       // ETA 12 Nov = 11 days away: today IS ETA-11
    ck('exactly ETA-11 days out: Twins is drafted — as a PAYMENT request, not a status query', b11.drafts.find((d) => d.customer === 'Twins Metal LLC') && b11.drafts.find((d) => d.customer === 'Twins Metal LLC').kind === 'payment');
    const tw0 = b11.drafts.find((d) => d.customer === 'Twins Metal LLC');
    ck('...and says the terms, the ETA and the due date (ETA-10 -> 12 Nov less 10 days = 11/02/2026)', /agreed payment terms \(ETA-10\)/.test(tw0.body) && /vessel ETA 11\/12\/2026/.test(tw0.body) && /due 11\/02\/2026/.test(tw0.body) && /\$10,000\.00/.test(tw0.body), tw0.body);
    ck('...asking for payment and the remittance details, and the subject says payment due', /arrange payment/.test(tw0.body) && /remittance details/.test(tw0.body) && /^Payment due/.test(tw0.subject));
    const b12 = twinsBuild(eta(11, 13));                                                                       // one day too early
    ck('ETA-12 days out: NOT yet — no draft, and the screen is told when it starts', !b12.drafts.some((d) => d.customer === 'Twins Metal LLC') && b12.waiting_eta[0].customer === 'Twins Metal LLC' && b12.waiting_eta[0].next_draft === '11/02/2026', JSON.stringify(b12.waiting_eta));
    ck('a booking with NO ETA is never guessed: no draft, and it is named as having no ETA', (() => { const b = twinsBuild(null); return !b.drafts.some((d) => d.customer === 'Twins Metal LLC') && b.waiting_eta[0].eta_unknown.includes('EM-3'); })());
    ck('a sale whose booking is not on file at all is treated the same', twinsBuild(undefined).waiting_eta[0].eta_unknown.length === 1);
    ck('an ETA already in the past is drafted too (overdue is still a payment request)', twinsBuild(eta(10, 20)).drafts.some((d) => d.customer === 'Twins Metal LLC' && d.kind === 'payment'));
    await PF.setEtaTerms('Twins Metal LLC', 'ETA+7');
    ck('ETA+7: due date is AFTER the ETA (12 Nov + 7 = 11/19/2026), still drafted from ETA-11', /due 11\/19\/2026/.test(twinsBuild(eta(11, 12)).drafts.find((d) => d.customer === 'Twins Metal LLC').body));
    ck('everyone NOT on ETA terms keeps the remittance-status draft and is unaffected by any of this', ['Daekwang', 'Park Trading'].every((n) => { const d = twinsBuild(eta(11, 12)).drafts.find((x) => x.customer === n); return d && d.kind === 'remittance' && /confirm the payment status/.test(d.body); }));
    ck('a non-ETA customer\'s draft shows the vessel ETA where the booking has one', (() => { const b = PF.build({ now: NOW, bookings: { BK1: { booking_no: 'BK1', eta: '11/25/2026' } } }); return /EM-1[^\n]*vessel ETA 11\/25\/2026/.test(b.drafts.find((d) => d.customer === 'Daekwang').body); })());
    await PF.setEtaTerms('Twins Metal LLC', '');
    ck('clearing the terms makes Twins an ordinary remittance-status draft again', (() => { const d = PF.build({ now: NOW, bookings: {} }).drafts.find((x) => x.customer === 'Twins Metal LLC'); return d && d.kind === 'remittance'; })());

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
    ck('the list route returns the drafts', g0.drafts.length === 3 && g0.drafts.find((d) => d.customer === 'Daekwang').total === 8500 && g0.lead_days === 11, JSON.stringify(g0.drafts.map((d) => d.customer)));
    // The booking confirmation's ETA, written where the booking pipeline writes it. A date 30 days away from the real clock.
    const far = new Date(Date.now() + 30 * 86400000), near = new Date(Date.now() + 5 * 86400000);
    const mmdd = (d) => `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`;
    const { mutateJson } = require(path.join(ROOT, 'helpers/json'));
    const cfg = require(path.join(ROOT, 'config'));
    await mutateJson(cfg.BOOKINGS_FILE, {}, (all) => ({ ...all, BKT1: { booking_no: 'BKT1', eta: mmdd(far), containers: [{ container_no: 'CCCC3333333' }] } }));
    const put = await req('PUT', '/api/payment-followups/terms', { sid, body: { customer: 'Twins Metal LLC', eta_terms: 'ETA-10' } });
    ck('the screen\'s save-terms call works', put.status === 200 && put.json.eta_terms === 'ETA-10', JSON.stringify(put.json));
    const g1 = (await req('GET', '/api/payment-followups', { sid })).json;
    ck('ETA 30 days away (read from bookings.json): Twins waits, with the date its draft starts', !g1.drafts.some((d) => d.customer === 'Twins Metal LLC') && g1.waiting_eta[0].customer === 'Twins Metal LLC' && g1.waiting_eta[0].eta_terms === 'ETA-10' && /^\d\d\/\d\d\/\d{4}$/.test(g1.waiting_eta[0].next_draft), JSON.stringify(g1.waiting_eta));
    await mutateJson(cfg.BOOKINGS_FILE, {}, (all) => ({ ...all, BKT1: { ...all.BKT1, eta: mmdd(near) } }));
    const g2 = (await req('GET', '/api/payment-followups', { sid })).json;
    const tw2 = g2.drafts.find((d) => d.customer === 'Twins Metal LLC');
    ck('ETA 5 days away: the payment-request draft appears through the route, with its due date', tw2 && tw2.kind === 'payment' && /due \d\d\/\d\d\/\d{4}/.test(tw2.body) && g2.waiting_eta.length === 0, JSON.stringify(g2.waiting_eta));
    ck('a bad value is refused by the route with the reason', (await req('PUT', '/api/payment-followups/terms', { sid, body: { customer: 'Twins Metal LLC', eta_terms: 'net 30' } })).status === 400);
    ck('removing the terms through the route makes it an ordinary draft', (await req('PUT', '/api/payment-followups/terms', { sid, body: { customer: 'Twins Metal LLC', eta_terms: '' } })).status === 200 && (await req('GET', '/api/payment-followups', { sid })).json.drafts.find((d) => d.customer === 'Twins Metal LLC').kind === 'remittance');
    ck('NOTHING WAS SENT, and no sale or receipt moved', mailed === 0 && JSON.stringify([sales.listWithTotals().map((s) => [s.id, s.balance]), receipts.list().length]) === before);
    ck('the existing sales route is unchanged by the new ones', (await req('GET', '/api/sales', { sid })).json.sales.length === 5);
    server.close();

    section('D. the screen');
    const js = fs.readFileSync(path.join(ROOT, 'dashboard/app/07-bills-sales.js'), 'utf8');
    ck('a button on the SALES ledger only (not Bills)', /kind === 'sales' \? '<button id="btnFollowups"/.test(js) && /\$\('btnFollowups'\)\.onclick = \(\) => openFollowups\(\)/.test(js));
    ck('the screen reads the route tested above and saves terms through the PUT tested above', /api\('\/api\/payment-followups'\)/.test(js) && /api\('\/api\/payment-followups\/terms', \{ method: 'PUT'/.test(js));
    ck('it shows which kind of draft it is, and when the ETA customers\' drafts start', /payment due ·/.test(js) && /remittance status/.test(js) && /draft from/.test(js) && /no ETA on the booking/.test(js));
    ck('it only offers Copy and Open in mail — there is no send call', /pfCopy/.test(js) && /pfMail/.test(js) && !/payment-followups[^\n]*send/i.test(js) && /nothing is sent from here/.test(js));
    ck('copy / mail use what is in the box, so her edits are not lost', /bodyOf\(b\.dataset\.i\)/.test(js));
    gmail.getGmailWrite = real.getGmailWrite;
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
