// tests/ticket-packing-list.js - Apsara, 2026-11-10: scale-ticket packing list as an OPTION on
// Documents -> Invoice. Tick it + "Separate invoice & packing list" and it REPLACES the packing
// list PDF. Unticked, nothing changes.
//   A. the document: her real ticket numbers, orange from the template, mm/dd/yyyy
//   B. arithmetic is ours, not the model's; bad weights are refused
//   C. generator: separate+ticket replaces ONLY the packing half; every other mode untouched
//   D. END TO END through the real server: scan route, generate route, saved files
//   Run: node tests/ticket-packing-list.js
const os = require('os'), path = require('path'), fs = require('fs'), http = require('http');
const R = (p) => path.join(__dirname, '..', p);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-test-'));
process.env.DATA_DIR = path.join(TMP, 'data'); process.env.JARVIS_TEST = '1'; process.env.API_TOKEN = 't';
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
const tpl = require(R('helpers/ticketPackingList.js'));
const pdf = require(R('helpers/invoicePdf.js'));
let P = 0, F = 0;
const ck = (d, a, e) => { const ok = JSON.stringify(a) === JSON.stringify(e); ok ? P++ : F++; console.log(`  ${ok ? 'PASS' : 'FAIL'} | ${d}${ok ? '' : `\n     got:  ${JSON.stringify(a)}\n     want: ${JSON.stringify(e)}`}`); };
const HER = { invoice_no: '260204_BT_26EMI06', date: '2026-11-06', container_no: 'MSMU1987338', seal_no: '0009296',
    consignee_lines: ['Eswari Global Metal Industries Ltd.', 'Plot no.101-A & B, 96 & 97, Industrial Area,', 'Baikampady, Mangalore, Karnataka, India.', 'Pincode : 575011'],
    groups: [{ item: 'Steel Cased Batteries', gross: '55,600', tare: '25,960', pallets: 10 }, { item: 'Auto Batteries', gross: 72900, tare: 55600, pallets: 5 }] };

(async () => {
    console.log('\n=== A. the document ===');
    const b = tpl.buildTicketPackingHtml(HER);
    ck('no problems with her real ticket', b.problems, []);
    ck('title, orange, light orange', [/Packing List/.test(b.html), /#B5531A/.test(b.html), /#FAE8D8/.test(b.html), /blue/i.test(b.html)], [true, true, true, false]);
    ck('date as mm/dd/yyyy', /11\/06\/2026/.test(b.html), true);
    ck('invoice no, container, seal', ['260204_BT_26EMI06', 'MSMU1987338', '0009296'].map((x) => b.html.includes(x)), [true, true, true]);
    ck('Consignee sits right of Exporter (same row, Exporter first)', b.html.indexOf('>Exporter<') < b.html.indexOf('>Consignee<') && b.html.indexOf('>Consignee<') < b.html.indexOf('Eswari'), true);
    ck('"&" in her address is escaped', b.html.includes('101-A &amp; B'), true);
    ck('Edge Metals exporter block (not the supplier)', [b.html.includes('EDGE METALS INC'), /mazariegos/i.test(b.html)], [true, false]);

    console.log('\n=== B. arithmetic ===');
    ck('nets match the PDF she approved', b.rows.map((r) => [r.net, r.palletsTotal, r.net2]), [[29640, 600, 29040], [17300, 300, 17000]]);
    ck('printed figures', ['29,640', '29,040', '17,300', '17,000'].map((x) => b.html.includes(x)), [true, true, true, true]);
    ck('tare > gross is refused', tpl.computeGroups([{ item: 'x', gross: 100, tare: 200 }]).problems.length, 1);
    ck('missing tare is refused', tpl.computeGroups([{ item: 'x', gross: 100 }]).problems.length, 1);
    ck('no pallets = no pallet lines', tpl.computeGroups([{ item: 'x', gross: 100, tare: 40 }]).rows[0].net2, null);
    ck('date shapes', [tpl.mdy('2026-11-06'), tpl.mdy('11/6/2026'), tpl.mdy('11.06.26')], ['11/06/2026', '11/06/2026', '11/06/2026']);

    console.log('\n=== C. generator: only the packing half changes ===');
    const calls = [];
    const render = async (html, modes) => { calls.push({ modes, html }); const o = {}; for (const m of modes) o[m] = Buffer.from(`PDF:${m}`); return o; };
    const body = { inv_no: 'X1', container_no: 'C1', line_items: [] };
    let out = await pdf.generateInvoiceClassicPdf(body, { separate: true, ticketPacking: HER, render });
    ck('separate + ticket: invoice rendered alone, ticket doc rendered', [calls[0].modes, calls[1].modes, /Eswari/.test(calls[1].html)], [['invoice'], ['both'], true]);
    ck('  returns the pair', [String(out.invoice), String(out.packing)], ['PDF:invoice', 'PDF:both']);
    calls.length = 0;
    out = await pdf.generateInvoiceClassicPdf(body, { separate: true, render });
    ck('separate WITHOUT ticket: exactly as before (invoice+packing in one pass)', [calls.length, calls[0].modes], [1, ['invoice', 'packing']]);
    calls.length = 0;
    out = await pdf.generateInvoiceClassicPdf(body, { ticketPacking: HER, render });
    ck('combined with a stray ticket: ignored, still one combined PDF', [calls.length, calls[0].modes], [1, ['both']]);
    calls.length = 0;
    out = await pdf.generateInvoiceClassicPdf(body, { invoiceOnly: true, separate: true, ticketPacking: HER, render });
    ck('invoice-only wins: no packing list at all', [calls.length, calls[0].modes], [1, ['invoice']]);
    calls.length = 0;
    let err = null;
    try { await pdf.generateInvoiceClassicPdf(body, { separate: true, ticketPacking: { ...HER, groups: [{ item: 'x', gross: 1, tare: 2 }] }, render }); } catch (e) { err = e; }
    ck('bad weights: refused BEFORE any render', [err && err.code, calls.length], ['TICKET_PACKING_INVALID', 0]);

    console.log('\n=== D. end to end: real server ===');
    // Chromium cannot launch here: the render hop is replaced, everything above it is real.
    const jobs = [];
    require(R('helpers/renderClient.js')).render = async (job) => { jobs.push(job); const o = {}; for (const m of job.modes) o[m] = Buffer.from(`%PDF-stub-${m}`); return o; };
    tpl._setReader(async () => ({ ticket_no: '9', date: '2026-11-06', container_no: 'MSMU1987338', seal_no: '0009296', unit: 'lb',
        groups: [{ item: 'Steel Cased Batteries', gross: '55,600', tare: '25,960', pallets: 10, net: 99999 }, { item: 'Auto Batteries', gross: 72900, tare: 55600 }] }));
    const { createApi } = require(R('api'));
    const server = await new Promise((res) => { const s = createApi().listen(0, '127.0.0.1', () => res(s)); });
    const port = server.address().port;
    const call = (method, p, bodyObj) => new Promise((res, rej) => {
        const d = bodyObj ? JSON.stringify(bodyObj) : null;
        const q = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'content-type': 'application/json', authorization: 'Bearer t', ...(d ? { 'content-length': Buffer.byteLength(d) } : {}) } }, (rs) => { let raw = ''; rs.on('data', (c) => raw += c); rs.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} res({ status: rs.statusCode, json: j }); }); });
        q.on('error', rej); if (d) q.write(d); q.end();
    });
    const scan = await call('POST', '/api/invoice/scan-ticket-packing', { base64: 'AAAA', mime: 'application/pdf' });
    ck('scan route fills the boxes', [scan.status, scan.json.fields.container_no, scan.json.fields.date, scan.json.fields.groups.length], [200, 'MSMU1987338', '11/06/2026', 2]);
    ck('  a "net" the model volunteered is NOT passed on', 'net' in scan.json.fields.groups[0], false);
    ck('  gross/tare come back as numbers', [scan.json.fields.groups[0].gross, scan.json.fields.groups[0].tare], [55600, 25960]);
    const noFile = await call('POST', '/api/invoice/scan-ticket-packing', {});
    ck('scan with no file -> 400, not a crash', noFile.status, 400);

    const payload = { inv_no: '260204_BT_26EMI06', container_no: 'MSMU1987338', line_items: [], units: 'lbs', weights_ok: true };
    jobs.length = 0;
    let g = await call('POST', '/api/invoice/generate', { ...payload, separate: true, ticket_packing: HER });
    ck('generate separate + ticket -> 200 with both files', [g.status, (g.json.saved_filenames || []).length], [200, 2]);
    ck('  the invoice pass and the ticket pass, nothing else', jobs.map((j) => j.modes.join('+')), ['invoice', 'both']);
    const dir = []; (function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); fs.statSync(p).isDirectory() ? walk(p) : dir.push(p); } })(process.env.DATA_DIR);
    const pk = dir.find((f) => /260204_BT_26EMI06_PACKING_LIST\.pdf$/.test(f));
    ck('  the saved PACKING_LIST file is the ticket document', pk && fs.readFileSync(pk, 'utf8'), '%PDF-stub-both');
    jobs.length = 0;
    g = await call('POST', '/api/invoice/generate', { ...payload, separate: true });
    ck('generate separate WITHOUT ticket: the standard single pass, as always', jobs.map((j) => j.modes.join('+')), ['invoice+packing']);
    jobs.length = 0;
    g = await call('POST', '/api/invoice/generate', { ...payload, ticket_packing: HER });
    ck('ticket sent without separate: ignored, combined PDF', [g.status, jobs.map((j) => j.modes.join('+'))], [200, ['both']]);
    jobs.length = 0;
    g = await call('POST', '/api/invoice/generate', { ...payload, separate: true, ticket_packing: { ...HER, groups: [{ item: 'x', gross: 10, tare: 20 }] } });
    ck('bad weights -> 400 with the reason, nothing rendered', [g.status, g.json.code, jobs.length], [400, 'TICKET_PACKING_INVALID', 0]);
    server.close();
    console.log(`\n${P} passed, ${F} failed`);
    process.exit(F ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
