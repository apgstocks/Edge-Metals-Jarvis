// ── tests/scout-attachments.js — files (and pasted tables) given to Scout ──
//
// Apsara, 2026-11-20: she pasted 18 Metalco containers into Scout and was told three times the text was cut off,
// then that Scout could only sell ALL the stock of an item. "Add an option for attachments in scout" — to record
// sales, record purchases, and answer questions; Excel/CSV, PDF, photo; website only.
//
//   A  her real paste (tests/fixtures/metalco-paste.txt) comes apart into 18 rows and her words
//   B  files: CSV and Excel read by code; old .xls refused; PDF/photo read by the model and marked so
//   C  END TO END through the real routes: attach -> ask -> card -> confirm -> sales on file, weights from the file,
//      container already on a sale skipped, confirm single-use, attaching twice cannot double anything
//   D  purchases from a file, end to end
//   E  nothing changes for callers that do not send a file (the app, voice): no paste conversion, no file tools
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-scoutatt-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'staff-pw-ccccccccccc';
const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
const A = require(path.join(ROOT, 'helpers', 'scoutAttachments'));
const gem = require(path.join(ROOT, 'helpers', 'gemini'));

const PASTE = fs.readFileSync(path.join(__dirname, 'fixtures', 'metalco-paste.txt'), 'utf8').replace(/\n$/, '');
const MT = 2204.62;

(async () => {
    section('A — her paste');
    const pasted = A.fromPastedText(PASTE);
    ck('18 containers come out of the one-line paste', pasted && pasted.table.rows.length === 18, pasted && pasted.table.rows.length);
    ck('her words are kept apart from the table', pasted && pasted.words === 'Hey create sale ticket for customer is metalco and price is 330 /mt', pasted && pasted.words);
    const r10 = pasted.table.rows[9];
    ck('the row with chassis tare keeps every cell (72980 gross, 14820 + 4280 = 19,100 total)', r10[8] === '72980' && r10[9] === '14820' && r10[10] === '4280' && r10[11] === '19,100', r10.join('|'));
    ck('the last cell is the number only, not "31,120 customer is…"', pasted.table.rows[17][11] === '31,120', pasted.table.rows[17][11]);
    ck('the first row starts with its date, not "Hey create sale ticket for"', pasted.table.rows[0][0] === '10/13/2026');
    ck('a normal question with no table is not taken for one', A.fromPastedText('How much HMS did we sell to Metalco in October?') === null);

    section('B — files');
    const csv = 'Date,Container,Gross,Tare\n10/13/2026,SELU4264110,66660,14640\n10/22/2026,"TIIU6083007",67140,14920\n';
    const c = await A.parseFile({ name: 'x.csv', mime: 'text/csv', buffer: Buffer.from(csv) });
    ck('a CSV is read by code, header found', c.table.read_by === 'code' && c.table.columns.join('|') === 'Date|Container|Gross|Tare' && c.table.rows.length === 2);
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Containers');
    ws.addRow(['Date', 'Container', 'Gross', 'Tare']); ws.addRow([new Date(Date.UTC(2026, 9, 13)), 'SELU4264110', 66660, 14640]); ws.addRow(['10/22/2026', 'TIIU6083007', { formula: '67000+140', result: 67140 }, 14920]);
    wb.addWorksheet('Notes').addRow(['hello']);
    const x = await A.parseFile({ name: 'c.xlsx', mime: '', buffer: Buffer.from(await wb.xlsx.writeBuffer()) });
    ck('an Excel file: the biggest sheet, dates and formula results read as values', x.table.rows.length === 2 && x.table.rows[0][0] === '10/13/2026' && x.table.rows[1][2] === '67140' && x.sheet === 'Containers', JSON.stringify(x.table.rows));
    let xlsErr = ''; try { await A.parseFile({ name: 'old.xls', mime: '', buffer: Buffer.from('x') }); } catch (e) { xlsErr = e.message; }
    ck('an old .xls is refused with what to do instead', /save it as \.xlsx or \.csv/.test(xlsErr), xlsErr);
    const realClient = gem.getClient;
    gem.getClient = () => ({ getGenerativeModel: () => ({ generateContent: async () => ({ response: { text: () => JSON.stringify({ columns: ['Date', 'Ticket', 'Net'], rows: [['11/02/2026', 'T-1', '4,500']], text: 'Scale ticket' }) } }) }) });
    const pdf = await A.parseFile({ name: 'ticket.pdf', mime: 'application/pdf', buffer: Buffer.from('%PDF-1.4 fake') });
    gem.getClient = realClient;
    ck('a PDF is read by the model and MARKED as model-read', pdf.table.read_by === 'model' && pdf.table.rows[0][2] === '4,500' && /Scale ticket/.test(pdf.text));

    // ── stock and an existing sale, written the way the app writes them ──
    fs.writeFileSync(cfg.LOADS_FILE, JSON.stringify([
        { id: 'EDGE_01', date: '2026-10-01', seller: 'Randy Recycling', items: [{ description: 'HMS', gross_weight: 600100, tare_weight: 100, net_weight: 600000, price: 0.1, amount: 60000 }] },
    ]));
    fs.writeFileSync(cfg.OUTBOUND_LOADS_FILE, JSON.stringify([
        { id: 'OUT_01', date: '2026-10-13', buyer: 'Metalco, Inc.', description: 'Container SELU4264110 · Booking NAM8690025', items: [{ description: 'HMS', gross_weight: 66660, tare_weight: 14640, net_weight: 52020, price: 0.15, amount: 7803 }] },
    ]));

    const { createApi } = require(path.join(ROOT, 'api'));
    const server = await new Promise((r) => { const s = createApi().listen(0, '127.0.0.1', () => r(s)); });
    const port = server.address().port;
    const req = (method, p, body, sid) => new Promise((resolve) => {
        const data = body ? JSON.stringify(body) : null; const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = 'Bearer ' + sid;
        const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => { let raw = ''; res.on('data', (ch) => { raw += ch; }); res.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch (e) { /* */ } resolve({ status: res.statusCode, json, raw }); }); });
        r.on('error', () => resolve({ status: 0 })); if (data) r.write(data); r.end();
    });
    // The model is stubbed: it answers with whatever action this test puts in `nextAction`, and records the prompt.
    let nextAction = null, lastPrompt = '';
    const realJSON = gem.callGeminiJSON;
    gem.callGeminiJSON = async (prompt) => { lastPrompt = prompt; return { answer: nextAction ? 'Here is what I will record.' : 'Noted.', have_data: true, tool: null, action: nextAction }; };
    try {
        const sid = ((await req('POST', '/login', { password: process.env.ADMIN_PASSWORD })).json || {}).sid;
        ck('signed in as manager', !!sid);

        section('C — sales from her containers, end to end');
        const tsv = pasted.table.rows.map((r) => r.join('\t')).join('\n');
        const up = await req('POST', '/api/yard/attach', { name: 'metalco.tsv', mime: 'text/tab-separated-values', data: Buffer.from(tsv).toString('base64') }, sid);
        const att = up.json && up.json.attachment;
        ck('the file is attached and read: 18 rows', up.status === 200 && att && att.rows === 18, up.raw && up.raw.slice(0, 200));
        nextAction = { kind: 'record_sales_from_attachment', params: {
            attachment_id: att.id, buyer: 'Metalco, Inc.', price: 330, price_per: 'metric_ton', item_column: 'Column 8',
            date_column: 'Column 1', gross_column: 'Column 9', tare_columns: ['Column 12'], container_column: 'Column 6',
            booking_column: 'Column 5', seal_column: 'Column 7', reference_column: 'Column 4', company_column: 'Column 2' } };
        const asked = await req('POST', '/api/yard/ask', { question: 'Record these as sales to Metalco at 330 per MT', attachment_id: att.id, attachments_ok: true, source: 'website' }, sid);
        ck('the model was shown the file\'s rows and the file tools', /ATTACHED FILE "metalco\.tsv"/.test(lastPrompt) && /record_sales_from_attachment/.test(lastPrompt) && /SELU4264110/.test(lastPrompt));
        const card = asked.json && asked.json.proposal;
        ck('a card comes back', !!(card && card.id), asked.raw && asked.raw.slice(0, 300));
        const rowsOnCard = (card.details || []).filter((d) => /^Row \d+/.test(d[0]));
        ck('17 rows on the card — the container already on OUT_01 is left out', rowsOnCard.length === 17, rowsOnCard.length);
        ck('…and the card says why', (card.warnings || []).some((w) => /SELU4264110 is already on sale OUT_01/.test(w)), (card.warnings || []).join(' / '));
        const row10 = rowsOnCard.find((d) => /^Row 10 /.test(d[0]));
        ck('weights come from the file: row 10 is 72,980 − 19,100 = 53,880 lb', row10 && /72,980 − 19,100 = 53,880 lb/.test(row10[1]), row10 && row10[1]);
        const expectedNet = pasted.table.rows.slice(1).reduce((s, r) => s + (A.toNumber(r[8]) - A.toNumber(r[11])), 0);
        const expectedAmt = Math.round(pasted.table.rows.slice(1).reduce((s, r) => s + Math.round((A.toNumber(r[8]) - A.toNumber(r[11])) * (330 / MT) * 100) / 100, 0) * 100) / 100;
        const total = (card.details || []).find((d) => d[0] === 'Total');
        ck(`the total is 17 sales · ${expectedNet.toLocaleString('en-US')} lb`, total && total[1].startsWith(`17 sales · ${expectedNet.toLocaleString('en-US')} lb`), total && total[1]);
        ck('$330 per metric ton is shown with what it is per lb', (card.details || []).some((d) => d[0] === 'Price' && /\$330\.00 per metric ton = \$0\.1497/.test(d[1])), JSON.stringify((card.details || []).find((d) => d[0] === 'Price')));
        ck('more is being sold than is in stock, and the card says so', (card.warnings || []).some((w) => /HMS/.test(w) && /short|on hand|more than/i.test(w)), (card.warnings || []).join(' / '));
        const before = ((await req('GET', '/api/outbound-loads', null, sid)).json || []).length;
        ck('nothing is written before Confirm', before === 1, before);
        const done = await req('POST', '/api/yard/act', { id: card.id, source: 'website' }, sid);
        ck('confirm records 17 sales', done.status === 200 && done.json && done.json.result && done.json.result.created.length === 17, done.raw && done.raw.slice(0, 300));
        const sales = (await req('GET', '/api/outbound-loads', null, sid)).json || [];
        ck('18 sales on file now (OUT_01 + 17)', sales.length === 18, sales.length);
        const tcnu = sales.find((s) => /TCNU2619582/.test(s.description || ''));
        ck('the chassis container: net 53,880 lb, dated 11/02, booking and seal kept', tcnu && tcnu.net_weight === 53880 && tcnu.date === '2026-11-02' && /Booking NAM8773766/.test(tcnu.description) && /Seal 0173926/.test(tcnu.description), JSON.stringify(tcnu && { net: tcnu.net_weight, d: tcnu.date, desc: tcnu.description }));
        ck('…priced at $330/MT exactly', tcnu && Math.abs(tcnu.amount - Math.round(53880 * (330 / MT) * 100) / 100) < 0.02, tcnu && tcnu.amount);
        ck('the money adds up to the card', Math.abs(sales.filter((s) => s.id !== 'OUT_01').reduce((t, s) => t + s.amount, 0) - expectedAmt) < 0.5);
        ck('the selling company comes from the file ("Edge Yard" is the yard company)', tcnu && tcnu.seller_company === 'Edge Trading', tcnu && tcnu.seller_company);
        const again = await req('POST', '/api/yard/act', { id: card.id, source: 'website' }, sid);
        ck('the same card cannot be confirmed twice', again.status === 400);
        const twice = await req('POST', '/api/yard/ask', { question: 'Record these as sales to Metalco at 330 per MT', attachment_id: att.id, attachments_ok: true }, sid);
        ck('asking again with the same file records nothing: every container is already on a sale', !(twice.json && twice.json.proposal) && /nothing to record/.test((twice.json && twice.json.answer) || ''), twice.json && twice.json.answer);
        const inv = (await req('GET', '/api/loads/inventory', null, sid)).json || {};
        const hms = (inv.byType || []).find((g) => g.description === 'HMS') || {};
        ck('Inventory counts them: shipped = OUT_01 + the 17', hms.shipped === 52020 + expectedNet, JSON.stringify(hms));

        section('C2 — the same table pasted into the website panel');
        nextAction = null;
        const p = await req('POST', '/api/yard/ask', { question: PASTE, attachments_ok: true, source: 'website' }, sid);
        ck('the paste becomes an attachment of 18 rows', p.json && p.json.attachment && p.json.attachment.rows === 18, p.raw && p.raw.slice(0, 200));
        ck('…and the model is asked her words, with the table beside them', /QUESTION: Hey create sale ticket for customer is metalco and price is 330 \/mt/.test(lastPrompt) && /ATTACHED FILE "pasted table"/.test(lastPrompt));
        const gone = await req('POST', '/api/yard/ask', { question: 'what is in it', attachment_id: 'att_doesnotexist', attachments_ok: true }, sid);
        ck('an expired attachment says to attach it again', gone.json && gone.json.attachment_expired === true && /Attach the file again/.test(gone.json.answer));

        section('D — purchases from a file, end to end');
        const tickets = 'Date,Seller,Material,Gross,Tare\n11/18/2026,Randy Recycling,Rotors,3220,125\n11/18/2026,Fred,Rotors,1836,140\n';
        const up2 = (await req('POST', '/api/yard/attach', { name: 'tickets.csv', mime: 'text/csv', data: Buffer.from(tickets).toString('base64') }, sid)).json.attachment;
        nextAction = { kind: 'record_purchases_from_attachment', params: { attachment_id: up2.id, seller_column: 'Seller', item_column: 'Material', date_column: 'Date', gross_column: 'Gross', tare_columns: ['Tare'], price: 0.1339 } };
        const card2 = ((await req('POST', '/api/yard/ask', { question: 'record these purchases at 0.1339', attachment_id: up2.id, attachments_ok: true }, sid)).json || {}).proposal;
        ck('a card for 2 loads', card2 && (card2.details || []).filter((d) => /^Row/.test(d[0])).length === 2, JSON.stringify(card2 && card2.details));
        const ok2 = await req('POST', '/api/yard/act', { id: card2.id }, sid);
        ck('confirm records 2 loads', ok2.status === 200 && ok2.json.result.created.length === 2, ok2.raw && ok2.raw.slice(0, 200));
        const loads = (await req('GET', '/api/loads', null, sid)).json;
        const list = Array.isArray(loads) ? loads : (loads || {}).loads || [];
        const fred = list.find((l) => l.seller === 'Fred');
        ck('Fred\'s load: 1,836 − 140 = 1,696 lb on 11/18', fred && fred.date === '2026-11-18' && fred.items[0].net_weight === 1696, JSON.stringify(fred && fred.items));
        const card3 = ((await req('POST', '/api/yard/ask', { question: 'record these purchases at 0.1339', attachment_id: up2.id, attachments_ok: true }, sid)).json || {});
        ck('the same tickets again are recognised as already entered', !card3.proposal && /already entered/.test(card3.answer || ''), card3.answer);

        section('E — callers without a file are unchanged');
        nextAction = null;
        await req('POST', '/api/yard/ask', { question: PASTE, source: 'app' }, sid);
        ck('the app (no attachments_ok): a paste is NOT turned into a file', !/ATTACHED FILE/.test(lastPrompt));
        ck('…and its question is cut at 500 characters exactly as before', /QUESTION: Hey create sale ticket for 10\/13\/2026/.test(lastPrompt) && !/HDMU4792612/.test(lastPrompt.split('QUESTION:')[1] || ''));
        lastPrompt = '';
        await req('POST', '/api/yard/ask', { question: 'How much HMS is on hand?', source: 'website', attachments_ok: true }, sid);
        // the TOOL DESCRIPTIONS, not the name in passing: the brief's recent-questions log legitimately says
        // "[CONFIRMED ACTION] record_sales_from_attachment" after section C
        ck('an ordinary question is not shown the file tools', !!lastPrompt && !/FILE TOOLS \(only because|• (record_sales_from_attachment|record_purchases_from_attachment|read_attachment_rows) —/.test(lastPrompt));
        const { proposeAction } = require(path.join(ROOT, 'helpers', 'yardActions'));
        let noFile = ''; try { await proposeAction({ kind: 'record_sales_from_attachment', params: { attachment_id: 'att_x' } }, {}); } catch (e) { noFile = e.message; }
        ck('the voice path cannot reach the file tools without a file', /attach the file again/.test(noFile), noFile);
    } finally {
        gem.callGeminiJSON = realJSON;
        server.close();
        try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* runner cleans tmp */ }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILURES:'); failures.forEach((f) => console.log('  ' + f)); }
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
