// ── tests/books-pack.js ───────────────────────────────────────────────────
// Apsara chose what the books are FOR, 2026-10-06: "The year-end pack for
// your CPA", read by "You, then your CPA."
//
// Everything in the books stack rendered in a browser and stopped there, so
// the stated purpose of ~1,500 lines was one step out of reach.
//
// ── WHAT THIS FILE IS REALLY GUARDING ────────────────────────────────────
// Not the formatting. The dangerous case: a pack built from an INCOMPLETE
// journal. Rows that could not be placed on a company are on no statement, so
// the profit is smaller than the truth and the workbook looks perfectly
// correct. A CPA cannot tell by looking, and a file gets forwarded without the
// email that explained it — so the warning has to be inside the workbook AND
// in its filename. Section B is that case, and it is the reason for the rest.
//
// The workbook is read back with ExcelJS rather than asserted on the builder's
// return value: "it would have written this" is not the same as "this is what
// is in the file she sends".

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-pack-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD = 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb';
process.env.JARVIS_PASSWORD = 'jarvis-pw-ddddddddddd';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated — refusing to run against real data');
    process.exit(1);
}

const BILL = {
    id: 'B1', container_no: 'C1', date: '2026-03-01', supplier: 'DRM',
    supplier_invoice_amount: 40000, trucking_amount: 3000, trucking_company: 'AJ',
};
const SALE = {
    id: 'S1', customer: 'ACME', date: '2026-03-05', container_no: 'C1',
    item: 'Cu', weight: 20000, weight_unit: 'lb', invoice_price: 2.5, price_unit: 'lb',
};
const writeStores = (bills, sales) => {
    fs.writeFileSync(cfg.BILLS_FILE, JSON.stringify(bills, null, 2));
    fs.writeFileSync(cfg.SALES_FILE, JSON.stringify(sales, null, 2));
};
writeStores([BILL], [SALE]);

const ExcelJS = require('exceljs');
const B = require(path.join(ROOT, 'helpers/booksBuild'));
const P = require(path.join(ROOT, 'helpers/booksPack'));

// Read a workbook the way Excel would, not the way the builder remembers it.
const openBuffer = async (buf) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    return wb;
};
const textOf = (ws) => {
    const out = [];
    for (let i = 1; i <= ws.rowCount; i += 1) {
        ws.getRow(i).eachCell({ includeEmpty: false }, (c) => out.push(String(c.value)));
    }
    return out.join('\n');
};
const cellsOf = (ws) => {
    const rows = [];
    for (let i = 1; i <= ws.rowCount; i += 1) {
        const r = [];
        ws.getRow(i).eachCell({ includeEmpty: true }, (c) => r.push(c.value));
        rows.push(r);
    }
    return rows;
};

(async () => {

// ── A — A CLEAN PACK ──────────────────────────────────────────────────────
{
    section('A — a pack from books that add up');

    const built = B.build({ from: '2026-01-01', to: '2026-12-31' });
    const { workbook, filename, sheets, verdict } = await P.toWorkbook(built,
        { entity: 'edge-metals', from: '2026-01-01', to: '2026-12-31', when: 'TEST-STAMP' });
    const wb = await openBuffer(await workbook.xlsx.writeBuffer());

    ck('the five statement sheets are there',
       ['Read first', 'Profit and Loss', 'Balance Sheet', 'Trial Balance', 'General Ledger']
           .every((n) => sheets.includes(n)), sheets.join(', '));
    ck('  and "Read first" is FIRST, before any figure',
       wb.worksheets[0].name === 'Read first',
       'a CPA must see what is missing before they see a profit');
    ck('  with no empty "Unplaced rows" sheet on a clean pack',
       !sheets.includes('Unplaced rows'),
       'an empty sheet called Unplaced invites a question it cannot answer');

    const first = textOf(wb.getWorksheet('Read first'));
    ck('page one says the books balance', /The books balance and nothing is unplaced/.test(first));
    ck('  and carries the LEGAL name, not the short one',
       /Edge Metals INC/.test(first), 'a filing in the short name would be wrong');
    ck('  and the tax id', /26-326-9514/.test(first));
    ck('  and says the figures are derived, not stored',
       /derived from source records, not stored/.test(first));
    ck('  and lists no findings', /Nothing found/.test(first));

    // The arithmetic, read out of the file.
    const pl = cellsOf(wb.getWorksheet('Profit and Loss')).map((r) => r.map(String).join('|')).join('\n');
    ck('income 50,000 is in the workbook', /Material sales\|50000/.test(pl), pl.split('\n').slice(4, 8).join(' / '));
    ck('  net income 50,000 - 40,000 = 10,000', /NET INCOME\|10000/.test(pl), pl);

    const tb = cellsOf(wb.getWorksheet('Trial Balance'));
    const tbText = tb.map((r) => r.map(String).join('|')).join('\n');
    ck('the trial balance splits the bill into payable and accrued trucking',
       /Accounts payable\|liability\|0\|37000/.test(tbText)
       && /Accrued trucking and freight\|liability\|0\|3000/.test(tbText),
       'the GROSS 40,000 is the material cost; 3,000 of it is owed to the trucker');
    // Read the CELLS, not a joined string. A first version matched
    // /Total\|\|50000\|50000/ against the rows pasted together with pipes and
    // failed on its own separator count — which says nothing about the
    // workbook and everything about the glue.
    const totRow = tb.find((r) => String(r[2] || r[1] || '').trim() === 'Total');
    // 90,000 each side, not 50,000 — which is what I first asserted. Debits are
    // receivable 50,000 plus material 40,000; credits are payable 37,000,
    // accrued trucking 3,000 and sales 50,000. Both the equality AND the figure
    // are checked: equality alone would pass if both sides were wrong together.
    ck('  and the totals row has debits equal to credits, at 90,000 each',
       !!totRow && Number(totRow[3]) === 90000 && Number(totRow[4]) === 90000,
       JSON.stringify(totRow));

    const gl = textOf(wb.getWorksheet('General Ledger'));
    ck('the general ledger names the party and the container',
       /DRM/.test(gl) && /ACME/.test(gl) && /C1/.test(gl));
    ck('  and is one flat filterable list, not a tab per account',
       !sheets.some((n) => /^\d{4}/.test(n)), sheets.join(','));
    ck('  with a filter set on it', !!wb.getWorksheet('General Ledger').autoFilter);

    ck('the filename says the company and the dates',
       filename === 'Books-Edge-Metals-2026-01-01_to_2026-12-31.xlsx', filename);
    ck('  and does NOT say draft, because this one is complete',
       !/DRAFT/.test(filename), filename);
    ck('the verdict travels with the pack', verdict && verdict.trustworthy === true);
}

// ── B — THE DANGEROUS PACK ────────────────────────────────────────────────
// A row that cannot be placed on a company is on no statement, so the profit
// is SMALLER than the truth and the workbook looks correct. This is the case
// the whole file exists for.
{
    section('B — a pack whose figures are incomplete must say so, twice');

    // ── A CRAFTED BUILD, AND WHY THAT IS THE RIGHT UNIT HERE ─────────────
    // The first version of this tried to make booksBuild produce an unplaced
    // row by writing a sale with no customer. It placed fine — entities.js
    // places a sale by its STORE, not by its customer — so the pack came out
    // clean and this whole section passed against the wrong thing, while
    // quietly adding $3,000 of income to the fixture.
    //
    // Which rows are unplaceable is helpers/entities.js's contract and
    // tests/entities.js's business (96 assertions on exactly that). The PACK's
    // contract is narrower and is what matters here: GIVEN an incomplete
    // journal, warn loudly, in the filename and on page one. So the build is
    // handed over directly rather than coaxed out of a fixture that may stop
    // producing it the day a loader changes.
    const built = B.build({});
    built.unplaced = [{
        store: 'sales',
        row: { id: 'S9', container_no: 'C9', amount: 3000 },
        why: 'payments.json row with no load_kind — cannot tell which company this belongs to',
    }];
    built.complete = false;

    ck('the crafted build reports itself incomplete', built.complete === false);
    ck('  with a row that names its store', built.unplaced[0].store === 'sales');

    const { workbook, filename, sheets } = await P.toWorkbook(built, { entity: 'edge-metals' });
    const wb = await openBuffer(await workbook.xlsx.writeBuffer());

    // 1. IN THE FILENAME, because a file gets forwarded without the email.
    ck('the FILENAME warns it is a draft', /DRAFT-INCOMPLETE/.test(filename), filename);

    // 2. ON PAGE ONE, in the first words.
    const first = textOf(wb.getWorksheet('Read first'));
    ck('page one says NOT READY TO FILE', /NOT READY TO FILE/.test(first),
       first.split('\n').slice(0, 3).join(' / '));
    ck('  and names the unplaced rows as a finding',
       /could not be put on any company/.test(first), first.slice(0, 400));
    ck('  with somewhere to go about it', /entity-audit/.test(first), first.slice(0, 400));
    ck('  and does NOT claim the books are fine',
       !/The books balance and nothing is unplaced/.test(first));

    // 3. AND THE ROWS THEMSELVES, so she can fix them.
    ck('the unplaced rows get their own sheet', sheets.includes('Unplaced rows'), sheets.join(','));
    const un = textOf(wb.getWorksheet('Unplaced rows'));
    ck('  naming the store and the row id', /sales/.test(un) && /S9/.test(un), un.slice(0, 300));
    ck('  and why it could not be placed', /load_kind/.test(un), un.slice(0, 300));

    // ── AN ACCOUNT THE CHART HAS NEVER HEARD OF MUST STILL APPEAR ────────
    // The trial balance BALANCES with it in, so leaving it out of the pack is
    // how the money disappears quietly. Mutating the loop that writes these
    // rows survived until this check existed — the fixture had no such
    // account, so dropping them changed nothing anywhere.
    const odd = B.build({});
    odd.lines.push({ date: '2026-03-01', entity: 'edge-metals', account: '9999', debit: 1234.5, credit: 0 });
    odd.lines.push({ date: '2026-03-01', entity: 'edge-metals', account: '9999', debit: 0, credit: 1234.5 });
    const oddPack = await P.toWorkbook(odd, { entity: 'edge-metals' });
    const oddWb = await openBuffer(await oddPack.workbook.xlsx.writeBuffer());
    const oddTb = textOf(oddWb.getWorksheet('Trial Balance'));
    ck('an account missing from the chart is listed on the Trial Balance sheet',
       /9999/.test(oddTb) && /NOT IN THE CHART OF ACCOUNTS/.test(oddTb),
       oddTb.slice(-320));
    ck('  and page one calls it out as a finding',
       /not in the chart of accounts/i.test(textOf(oddWb.getWorksheet('Read first'))),
       'the trial balance still balances, so nothing else shows this');
    ck('  and the pack is marked a draft because of it',
       /DRAFT-INCOMPLETE/.test(oddPack.filename), oddPack.filename);

    // The money is NOT totalled on that sheet, deliberately: booksBuild's
    // unplaced entries have no amount field and it differs per store, which is
    // how an earlier entity-audit.js printed $0.00 against seven real invoices.
    ck('  and does not print a made-up total', !/\$0\.00/.test(un),
       'a zero reads as "no money involved"');
    writeStores([BILL], [SALE]);
    for (const k of Object.keys(require.cache)) if (k.startsWith(ROOT)) delete require.cache[k];
}

// ── C — ONE COMPANY PER WORKBOOK ──────────────────────────────────────────
{
    section('C — one taxpayer per pack');

    const B3 = require(path.join(ROOT, 'helpers/booksBuild'));
    const P3 = require(path.join(ROOT, 'helpers/booksPack'));
    const built = B3.build({});

    let err = null;
    try { await P3.toWorkbook(built, { entity: 'nope' }); } catch (e) { err = e.message; }
    ck('an unknown company is refused', /no company nope/.test(String(err)), String(err));

    let none = null;
    try { await P3.toWorkbook(built, {}); } catch (e) { none = e.message; }
    ck('and so is no company at all — "there is no combined taxpayer"',
       !!none, String(none));

    // Edge Trading trades as "Edge Yard": the pack must carry the FILING name.
    const t = await P3.toWorkbook(built, { entity: 'edge-trading' });
    const wb = await openBuffer(await t.workbook.xlsx.writeBuffer());
    ck('Edge Trading\'s pack is headed EDGE TRADING INC, not "Edge Yard"',
       /EDGE TRADING INC/.test(textOf(wb.getWorksheet('Read first'))),
       textOf(wb.getWorksheet('Read first')).split('\n')[0]);
    ck('  and its filename uses the short name she recognises',
       /Books-Edge-Yard-/.test(t.filename), t.filename);
    // #178 is open: Edge Trading and AAA Investment have no tax id on file.
    ck('  and it SAYS the tax id is missing rather than printing a blank',
       /no tax ID on file/.test(textOf(wb.getWorksheet('Read first'))),
       'a heading with a blank EIN is a filing document with a hole in it');
}

// ── D — OVER HTTP, THE WAY THE BUTTON DOES IT ─────────────────────────────
{
    section('D — the download');

    const { createApi } = require(path.join(ROOT, 'api'));
    const app = createApi();
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;

    const post = (p, body) => new Promise((resolve, reject) => {
        const d = JSON.stringify(body);
        const r = http.request(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
            (x) => { let o = ''; x.on('data', (c) => { o += c; }); x.on('end', () => { let j = null; try { j = JSON.parse(o); } catch (e) {} resolve(j); }); });
        r.on('error', reject); r.write(d); r.end();
    });
    const dl = (p, sid) => new Promise((resolve, reject) => {
        const r = http.request(base + p, { headers: sid ? { Authorization: `Bearer ${sid}` } : {} },
            (x) => { const c = []; x.on('data', (b) => c.push(b)); x.on('end', () => resolve({ code: x.statusCode, h: x.headers, buf: Buffer.concat(c) })); });
        r.on('error', reject); r.end();
    });

    const lg = await post('/login', { password: process.env.JARVIS_PASSWORD });
    const sid = (lg && (lg.sid || lg.session_id)) || null;
    ck('signed in', !!sid);

    const anon = await dl('/api/books/pack?entity=edge-metals');
    ck('the pack needs a session', anon.code === 401, String(anon.code));

    const r = await dl('/api/books/pack?entity=edge-metals&from=2026-01-01&to=2026-12-31', sid);
    ck('the route returns a workbook', r.code === 200
       && /spreadsheetml\.sheet/.test(String(r.h['content-type'])),
       `${r.code} ${r.h['content-type']}`);
    ck('  as an attachment with the filename on it',
       /attachment; filename="Books-Edge-Metals-2026-01-01_to_2026-12-31\.xlsx"/
           .test(String(r.h['content-disposition'])),
       String(r.h['content-disposition']));
    ck('  and it really opens', !!(await openBuffer(r.buf)).getWorksheet('Trial Balance'),
       `${r.buf.length} bytes`);

    // ── THE PACK MUST AGREE WITH THE SCREEN ──────────────────────────────
    // Both are built from her stores on demand. If the pack route built its own
    // journal from different dates, she would send her CPA figures that differ
    // from the ones she just read and approved — and nothing would look broken.
    // Mutating the route to build a second journal survived until this existed.
    const onScreen = await new Promise((resolve, reject) => {
        const r = http.request(base + '/api/books?entity=edge-metals&from=2026-01-01&to=2026-12-31',
            { headers: { Authorization: `Bearer ${sid}` } },
            (x) => { let o = ''; x.on('data', (c) => { o += c; }); x.on('end', () => resolve(JSON.parse(o))); });
        r.on('error', reject); r.end();
    });
    const packWb = await openBuffer(r.buf);
    const packPl = cellsOf(packWb.getWorksheet('Profit and Loss'))
        .find((row) => String(row[1] || '').trim() === 'NET INCOME');
    ck('the workbook\'s net income is the one the screen showed',
       !!packPl && Number(packPl[2]) === Number(onScreen.profitAndLoss.netIncome),
       `workbook ${packPl && packPl[2]} vs screen ${onScreen.profitAndLoss.netIncome}`);
    const packTb = cellsOf(packWb.getWorksheet('Trial Balance'))
        .find((row) => String(row[1] || '').trim() === 'Total');
    ck('  and so are its trial balance totals',
       !!packTb && Number(packTb[3]) === Number(onScreen.trialBalance.debit),
       `workbook ${packTb && packTb[3]} vs screen ${onScreen.trialBalance.debit}`);

    const bad = await dl('/api/books/pack?entity=nope', sid);
    ck('an unknown company is a 400, not a corrupt download', bad.code === 400, String(bad.code));

    // The page must actually call it — the dead-screen rule again.
    const page = fs.readFileSync(path.join(ROOT, 'dashboard/books.html'), 'utf8');
    ck('the portal has a button that calls the pack route',
       /id="pack"/.test(page) && /\/api\/books\/pack\?/.test(page));
    ck('  and lets the BROWSER name the file',
       !/Books-.*\.xlsx/.test(page),
       'rebuilding the filename in the page is a second place for the '
       + 'DRAFT-INCOMPLETE warning to be wrong, and that copy is the one on her disk');

    // Nothing here writes.
    const before = fs.readFileSync(cfg.BILLS_FILE, 'utf8');
    await dl('/api/books/pack?entity=edge-metals', sid);
    ck('exporting writes NOTHING',
       fs.readFileSync(cfg.BILLS_FILE, 'utf8') === before);

    server.close();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('threw:', e && e.stack); process.exit(1); });
