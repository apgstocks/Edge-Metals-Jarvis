// ── tests/eagle-invoice.js ────────────────────────────────────────────────
// Eagle Trans (EagleBrit) Verify tab, Apsara 2026-10-07 "yes.build".
// A: the pure normaliser/credit pairing on the real 2026 invoices' figures.
// B: END TO END (CLAUDE.md §3) — real server, real route, real cross-check;
//    only Gemini and the Google sheet are stubbed. Also asserts the tab is
//    READ-ONLY: it must write to no bill, sale, or sheet.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n); if (x) console.log('        ' + x); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-eagle-'));
process.env.DATA_DIR = TMP; process.env.JARVIS_TEST = '1';
process.env.ADMIN_PASSWORD = 'admin-pw-bbb'; process.env.APP_PASSWORD = 'user-pw-aaa'; process.env.JARVIS_PASSWORD = 'jarvis-pw-ddd';
const E = require(path.join(ROOT, 'helpers/eagleInvoice'));

// The real invoices, transcribed.
const X172994 = { invoice_no: 'XSINV/172994', document_type: 'invoice', invoice_date: '09/02/2026', job_ref: 'UHSE/092987', booking_no: 'EBKG18168515', mbl: 'MEDUADA20500', hbl: 'UHSE092987', containers: ['MSBU1199292'], charges: [{ description: 'FREIGHT 1 x 980.00USD', amount: 980 }, { description: 'DOCUMENTATION FEE', amount: 50 }], total_due: 1030 };
const X170815 = { invoice_no: 'XSINV/170815', invoice_date: '07/16/2026', booking_no: 'EBKG17421250', containers: ['FCIU4595798', 'GLDU9430528', 'MSBU1973496', 'TGBU3049592'], charges: [{ description: 'FREIGHT', amount: 5970 }], total_due: 5970 };
const X171581 = { invoice_no: 'XSINV/171581', invoice_date: '08/19/2026', booking_no: 'EBKG18111501', containers: ['MSDU1990720', 'MSMU1457106'], charges: [{ description: 'FREIGHT', amount: 2180 }], total_due: 2180 };
const CRN = { invoice_no: 'XSCRN/015704', invoice_date: '08/20/2026', booking_no: 'EBKG18111501', containers: ['MSDU1990720', 'MSMU1457106'], charges: [{ description: 'FREIGHT', amount: -2180 }], total_due: -2180 };

section('A. normalise');
{
    const a = E.normalize(X172994, 'a.pdf');
    ck('invoice: amount, booking, container, kind', a.record.amount === 1030 && a.record.booking_no === 'EBKG18168515' && a.record.containers.join() === 'MSBU1199292' && a.record.kind === 'invoice');
    ck('charges reconcile to printed total', a.record.reconciled === true && a.warnings.length === 0);
    const b = E.normalize(X170815);
    ck('4 containers, ONE amount — never divided', b.record.containers.length === 4 && b.record.amount === 5970 && !('per_container' in b.record));
    const c = E.normalize(CRN);
    ck('XSCRN is a credit note, signed negative', c.record.kind === 'credit_note' && c.record.amount === -2180 && c.warnings.length === 0);
    const bad = E.normalize({ ...X172994, total_due: 1100 });
    ck('lines not adding to total => reconciled false + warning', bad.record.reconciled === false && /add to 1030 but the invoice says 1100/.test(bad.warnings[0]), JSON.stringify(bad.warnings));
    ck('lower-case/spaced containers normalised, duplicates dropped', E.normalize({ ...X172994, containers: ['msbu 1199292', 'MSBU1199292'] }).record.containers.length === 1);
    ck('odd container shape warned, not dropped', /usual 4-letters/.test(E.normalize({ ...X172994, containers: ['BOGUS1'] }).warnings[0]));
    ck('garbage in is safe', E.normalize(null).record.amount === null && E.normalize(null).warnings.length > 0);
    const p = E.pairCredits([E.normalize(X171581).record, E.normalize(CRN).record, E.normalize(X172994).record]);
    ck('credit note pairs with the invoice it cancels', p.cancelled.length === 1 && p.cancelled[0].invoice === 'XSINV/171581');
    ck('net = 1030 (the pair cancels)', p.net === 1030, String(p.net));
    ck('a credit note for a different booking pairs with nothing', E.pairCredits([E.normalize(X172994).record, E.normalize({ ...CRN, booking_no: 'EBKG1' }).record]).cancelled.length === 0);
}

section('B. end to end through /api/verify/eagle');
(async () => {
    const gemini = require(path.join(ROOT, 'helpers/gemini'));
    const queue = { PDF_A: X172994, PDF_B: X170815, PDF_C: X171581, PDF_D: CRN };
    let calls = 0;
    gemini.extractEagleInvoiceRecords = async (b64) => { calls++; if (b64 === 'PDF_BAD') throw new Error('boom'); return queue[b64]; };
    const invoiceSheet = require(path.join(ROOT, 'helpers/invoiceSheet'));
    let sheetReads = 0;
    // Real headings are lower-cased + trimmed by fetchRawSheet; 'booking  no.' has two spaces.
    invoiceSheet.fetchRawSheet = async () => { sheetReads++; return { headers: ['consignee', 'inv no.', 'inv date', 'booking  no.', 'container no.', 'customer'], rows: [
        ['X', '26X01', '09/01/2026', 'MEDUADA20500', 'MSBU1199292', 'X'],
        ['X', '26X02', '07/01/2026', 'CARRIERBK1', 'FCIU4595798', 'X'], ['X', '26X02', '07/01/2026', 'CARRIERBK1', 'GLDU9430528', 'X'],
        // MSBU1973496 and TGBU3049592 deliberately absent => partly_in_sheet
        ['X', '26X03', '08/01/2026', 'CARRIERBK2', 'MSDU1990720', 'X'], ['X', '26X03', '08/01/2026', 'CARRIERBK2', 'MSMU1457106', 'X'],
    ] }; };
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
    const sid = (await req('POST', '/login', { body: { password: 'jarvis-pw-ddd' } })).json.sid;
    const empty = await req('POST', '/api/verify/eagle', { sid, body: { pdfs: [] } });
    ck('no PDFs -> 400', empty.status === 400);
    const before = fs.readdirSync(TMP).sort().join();
    const r = await req('POST', '/api/verify/eagle', { sid, body: { pdfs: [
        { name: 'a.pdf', base64: 'PDF_A' }, { name: 'b.pdf', base64: 'PDF_B' }, { name: 'c.pdf', base64: 'PDF_C' }, { name: 'd.pdf', base64: 'PDF_D' }, { name: 'bad.pdf', base64: 'PDF_BAD' } ] } });
    ck('200', r.status === 200, JSON.stringify(r.json).slice(0, 200));
    const by = (n) => (r.json.matched || []).find((m) => m.invoice_no === n);
    ck('route forwarded every PDF to the extractor', calls === 5);
    ck('XSINV/172994: container on sheet -> verified', by('XSINV/172994') && by('XSINV/172994').status === 'verified');
    ck('XSINV/170815: 2 of 4 on sheet -> partly_in_sheet, names the missing', by('XSINV/170815').status === 'partly_in_sheet' && by('XSINV/170815').containers_missing.join() === 'MSBU1973496,TGBU3049592');
    ck('the 5970 stays whole (not divided over the containers)', by('XSINV/170815').amount === 5970);
    ck('credit note flagged, not "verified"', by('XSCRN/015704').status === 'credit_note');
    ck('credit pairing comes back through the route', r.json.credits && r.json.credits.cancelled.length === 1 && r.json.credits.cancelled[0].credit_note === 'XSCRN/015704');
    ck('net across upload = 1030 + 5970', r.json.credits.net === 7000, String(r.json.credits.net));
    ck('one unreadable PDF does not lose the batch', (r.json.matched || []).some((m) => m.status === 'extraction_failed') && r.json.matched.length === 5);
    ck('the failure is surfaced as a warning', (r.json.warnings || []).some((w) => /bad\.pdf: extraction failed/.test(w)));
    ck('sheet was actually consulted (not a stubbed-away check)', sheetReads >= 1);
    ck('READ-ONLY: no bill, sale or other store written', fs.readdirSync(TMP).sort().join() === before, fs.readdirSync(TMP).join());
    const noauth = await req('POST', '/api/verify/eagle', { body: { pdfs: [{ name: 'a', base64: 'PDF_A' }] } });
    ck('needs a login', noauth.status === 401 || noauth.status === 403);
    const html = fs.readFileSync(path.join(ROOT, 'dashboard/documents.html'), 'utf8');
    ck('page posts to the route just tested', /api\('\/api\/verify\/eagle'/.test(html));
    ck('Eagle button in the Freight group, panel wired', /data-verify-subtab="eagle"/.test(html) && /freight: \['zimex', 'eagle'\]/.test(html) && /eagle: 'verifyPanelEagle'/.test(html));
    ck('Zimex and the trucker panels untouched', ['verifyPanelZimex', 'verifyPanelAjTransport', 'verifyPanelJio', 'verifyPanelGardunos'].every((id) => html.includes(`id="${id}"`)));
    server.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
