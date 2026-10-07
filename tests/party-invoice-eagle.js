// tests/party-invoice-eagle.js — Eagle Trans (sweep key "eaglebrit") in the invoice register.
// Eagle bills a BOOKING in one total across several containers, and issues credit notes.
// A: normalisation rules. B: END TO END — a sweep-style export -> the real importer -> the real
// server -> the list route, with the credit note netting against the invoice it cancelled.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-eagle-reg-'));
process.env.DATA_DIR = TMP; process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD = 'user-pw-aaa'; process.env.ADMIN_PASSWORD = 'admin-pw-bbb'; process.env.JARVIS_PASSWORD = 'jarvis-pw-ddd'; process.env.STAFF_PASSWORD = 'staff-pw-ccc';
let pass = 0, fail = 0;
const ck = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n); if (x) console.log('        ' + x); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const PI = require(path.join(ROOT, 'helpers/partyInvoices'));
const rej = async (p) => { try { await p; return null; } catch (e) { return e.message; } };
// What helpers/eagleInvoice.normalize().record + the sweep's tagging produce, from the real invoices.
const X170815 = { party: 'eaglebrit', invoice_no: 'XSINV/170815', kind: 'invoice', invoice_date: '07/16/2026', booking_no: 'EBKG17421250', containers: ['FCIU4595798', 'GLDU9430528', 'MSBU1973496', 'TGBU3049592'], amount: 5970, status: 'partly_in_sheet', source_file: 'x.pdf' };
const X171581 = { party: 'eaglebrit', invoice_no: 'XSINV/171581', kind: 'invoice', invoice_date: '08/19/2026', booking_no: 'EBKG18111501', containers: ['MSDU1990720', 'MSMU1457106'], amount: 2180, status: 'not_in_sheet' };
const CRN = { party: 'eaglebrit', invoice_no: 'XSCRN/015704', kind: 'credit_note', invoice_date: '08/20/2026', booking_no: 'EBKG18111501', containers: ['MSDU1990720', 'MSMU1457106'], amount: -2180, status: 'credit_note' };
const X172994 = { party: 'eaglebrit', invoice_no: 'XSINV/172994', kind: 'invoice', invoice_date: '09/02/2026', booking_no: 'EBKG18168515', containers: ['MSBU1199292'], amount: 1030, status: 'verified' };

(async () => {
    section('A. normalise');
    const n = (r) => PI.normalize(r);
    const a = n(X170815);
    ck('"eaglebrit" files under the Eagle Trans party', a.row && a.row.party === 'eagle' && PI.PARTIES.eagle === 'Eagle Trans');
    ck('ONE line for the invoice, all four containers kept, $5,970 NOT divided', a.row.containers.length === 4 && a.row.amount === 5970 && /FCIU4595798,GLDU9430528/.test(a.row.container_no));
    ck('key = party:invoice:booking (stable, not tied to container order)', a.row.key === 'eagle:XSINV/170815:EBKG17421250');
    ck('the check status the cross-check gave is kept', a.row.check_status === 'partly_in_sheet');
    const c = n(CRN);
    ck('a credit note keeps its NEGATIVE amount and is marked', c.row.amount === -2180 && c.row.kind === 'credit_note');
    ck('a negative on ANY party is kept as a credit (Zimex has 133 in 2026 — dropping them was a regression)', n({ party: 'zimex', invoice_no: 'ZC', hbl_no: 'H', amount: -5 }).row.kind === 'credit_note' && n({ party: 'jio', invoice_no: 'J', container_no: 'AAAA1111111', net_amount: -50 }).row.amount === -50);
    ck('and a positive line is never marked a credit', n({ party: 'zimex', invoice_no: 'Z', hbl_no: 'H', amount: 5 }).row.kind === undefined);
    ck('Eagle is NOT subject to the trucker $3,000 cap', !!n({ ...X170815, amount: 20000 }).row);
    ck('an Eagle record with no total is skipped', !!n({ ...X170815, amount: null }).skip);

    section('B. end to end');
    const exp = path.join(TMP, 'export.json');
    fs.writeFileSync(exp, JSON.stringify({ exported_at: 'now', records: [X170815, X171581, CRN, X172994,
        { party: 'eaglebrit', invoice_no: null, containers: [], amount: null, extraction_failed: true } ] }));
    const run = (...x) => execFileSync('node', [path.join(ROOT, 'scripts/party-invoices-import.js'), '--file', exp, ...x], { env: process.env, encoding: 'utf8' });
    const prev = run();
    ck('preview names Eagle Trans, writes nothing', /Eagle Trans/.test(prev) && /PREVIEW/.test(prev) && !fs.existsSync(path.join(TMP, 'party_invoices.json')));
    const only = run('--party', 'eaglebrit');
    ck('--party scopes the preview (Eagle Trans only; no other party listed)', /Eagle Trans/.test(only) && !/Zimex|Jio|Sher/.test(only.split('Left out')[0]));
    ck('--write: 4 lines (3 invoices + the credit note); the unreadable one is left out', /Wrote: 4 added/.test(run('--write')));
    ck('idempotent', /Wrote: 0 added, 4 updated/.test(run('--write')));
    const sm = PI.summary().eagle;
    ck('OUTSTANDING nets the credit note: 5970 + 2180 − 2180 + 1030 = 7000', sm.outstanding === 7000 && sm.count === 4, JSON.stringify(sm));
    ck('the cancelled invoice and its credit note cancel to nothing in the total', sm.total === 7000);

    const { createApi } = require(path.join(ROOT, 'api'));
    const server = await new Promise((r) => { const s = createApi().listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = (method, p, { sid, body } = {}) => new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body); const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r = http.request(base + p, { method, headers }, (res) => { let raw = ''; res.on('data', (c2) => { raw += c2; }); res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j }); }); });
        r.on('error', reject); if (data) r.write(data); r.end();
    });
    const sid = (await req('POST', '/login', { body: { password: 'admin-pw-bbb' } })).json.sid;
    const d = (await req('GET', '/api/party-invoices?party=eagle', { sid })).json;
    ck('the list route returns the Eagle lines, with the party in its list', d.rows.length === 4 && d.parties.eagle === 'Eagle Trans');
    ck('search by container finds the invoice that carries it', (await req('GET', '/api/party-invoices?q=tgbu3049592', { sid })).json.rows.length === 1);
    const credit = d.rows.find((r) => r.invoice_no === 'XSCRN/015704');
    const inv = d.rows.find((r) => r.invoice_no === 'XSINV/170815');
    const payBad = await req('POST', '/api/party-invoice-payments', { sid, body: { amount: 10, paid_on: '2026-10-07', mode: 'Wire', allocations: [{ row_id: credit.id, amount: 10 }] } });
    ck('a credit note cannot be PAID', payBad.status === 400);
    const pay = await req('POST', '/api/party-invoice-payments', { sid, body: { amount: 5970, paid_on: '2026-08-11', mode: 'Wire', ref: 'ACH 626873162', allocations: [{ row_id: inv.id, amount: 5970 }] } });
    ck('an Eagle invoice can be paid (the $5,970 ACH of 11 Aug)', pay.status === 200 && (await req('GET', '/api/party-invoices?party=eagle', { sid })).json.rows.find((r) => r.id === inv.id).pay_status === 'paid');
    ck('outstanding after that = 1030', PI.summary().eagle.outstanding === 1030);
    // credit-note edit sign rule
    const err = await rej(PI.editRow(credit.id, { amount: 2180 }));
    ck('a credit note cannot be edited to a positive amount', /less than 0/.test(err), err);
    ck('...but a negative correction is fine', (await PI.editRow(credit.id, { amount: -2100 })).amount === -2100);
    ck('an ordinary invoice still cannot go negative', /greater than 0/.test(await rej(PI.editRow(inv.id, { amount: -5 }))));
    ck('a re-import of the original export does not undo the edited credit note (marked edited)', (await PI.upsertMany([PI.normalize(CRN).row])).kept_locked === 1 && PI.list().find((r) => r.id === credit.id).amount === -2100);

    section('the sweep entry and the screen');
    const sweep = fs.readFileSync(path.join(ROOT, 'scripts/freight-2026-email-sweep.js'), 'utf8');
    ck('sweep: eaglebrit now uses the Eagle extractor and the Eagle cross-check', /extractEagleInvoiceRecords/.test(sweep) && /crossCheckEagleRecords/.test(sweep));
    ck('sweep: asks for XSINV/XSCRN mail only, and only PDFs named like invoices (not bank screenshots)', /\(XSINV OR XSCRN\)/.test(sweep) && /pdfName: \/xs\(inv\|crn\)\|invoice\/i/.test(sweep) && /party\.pdfName && !party\.pdfName\.test/.test(sweep));
    ck('sweep: no OTHER party got a pdfName filter', (sweep.match(/pdfName:/g) || []).length === 1);
    const html = fs.readFileSync(path.join(ROOT, 'dashboard/documents.html'), 'utf8');
    ck('Eagle Trans tab lists its invoices too (Freight group, like Zimex)', /eagle: 'eagle'/.test(html) && /credit_note: 'credit note'/.test(html));
    server.close();
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
