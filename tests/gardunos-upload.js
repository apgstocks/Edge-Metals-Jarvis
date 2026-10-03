// ── tests/gardunos-upload.js ──────────────────────────────────────────────
// The END TO END half of the Garduno's import (CLAUDE.md rule 3). The
// arithmetic is covered in tests/gardunos-invoice.js; this one proves the
// wiring between the pieces, which is where the last three features broke:
//
//   · the route forwards the PDF to the extractor
//   · the expansion runs, so one booking line becomes its containers
//   · the cross-check runs against the Invoice sheet
//   · bill_proposals comes back, so the "put these on the bill" step the
//     other trucker tabs have is actually offered here too
//   · and the warnings survive the trip to the screen
//
// ── THE ONLY STUB IS GEMINI ──────────────────────────────────────────────
// The real server, the real route, the real expansion, the real proposal
// builder. extractGardunosInvoiceRecords is replaced in the module cache
// BEFORE the route requires it, because a test that calls Gemini is a test
// that costs money, needs a key, and fails when Google is busy — and because
// the prompt is the one part of this that cannot be asserted anyway.
//
// What is stubbed returns exactly what the prompt asks for: her invoice 169,
// transcribed.

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-gardunos-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.ADMIN_PASSWORD = 'admin-pw-bbb';
process.env.APP_PASSWORD = 'user-pw-aaa';
process.env.JARVIS_PASSWORD = 'jarvis-pw-ddd';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.BILLS_FILE).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated — refusing to run against real data');
    process.exit(1);
}

const { mutateJson } = require(path.join(ROOT, 'helpers/json'));

// ── STUB GEMINI, AND THE SHEET IT CHECKS AGAINST ─────────────────────────
// require() first so the real module is in the cache, then replace the one
// export. Replacing the whole module would also silence the twenty other
// functions in it, and a stub broader than the thing being stubbed is how a
// test stops testing.
const gemini = require(path.join(ROOT, 'helpers/gemini'));
const INVOICE_169 = {
    invoice_no: '169 REVISED', invoice_date: '02/13/2026', due_date: '03/15/2026',
    total: 5580.00, balance_due: 0,
    lines: [
        { product: 'BKNG#PHX6A1731600', description: 'BKNG#PHX6A1731600\nSMCU1176865\nSMCU1033036',
          qty: 2, rate: 850, amount: 1700 },
        { product: 'BKNG#PHX6A2335700',
          description: 'BKNG#PHX6A2335700\nCAIU9924305\nCAIU9899394\nFFAU8016428\nFFAU7806670',
          qty: 4, rate: 850, amount: 3400 },
        { product: 'SCALE TICKETS', description: 'SCALE TICKETS', qty: 6, rate: 80, amount: 480 },
    ],
};
let extractCalls = 0;
let nextExtraction = INVOICE_169;
gemini.extractGardunosInvoiceRecords = async (base64) => {
    extractCalls += 1;
    if (!base64) throw new Error('pdfBase64 required');
    if (nextExtraction instanceof Error) throw nextExtraction;
    return nextExtraction;
};

// ── THE INVOICE SHEET, STUBBED AT THE RIGHT SEAM ─────────────────────────
// My first attempt replaced invoiceVerify.buildSheetContainerIndex on the
// exports object. That did NOTHING: crossCheckGardunosRecords calls it as a
// module-local function, not through module.exports, so the real one ran —
// against her LIVE Google sheet. Three checks failed and all six containers
// came back 'verified', which is also how I know they are genuinely on it.
//
// A test that silently reaches live data is worse than a failing test, so
// this stubs one level down: buildSheetContainerIndex calls
// invoiceSheet.fetchRawSheet(), a PROPERTY access on the required module,
// which patching does reach. Column headings are the real ones buildColumnMap
// matches on ('Booking  No.' has two spaces); invented headings would map to
// -1 and every row would read blank.
const invoiceSheet = require(path.join(ROOT, 'helpers/invoiceSheet'));
// LOWERCASED AND TRIMMED, because that is what the real fetchRawSheet
// returns — it does .trim().toLowerCase() on every heading before anyone
// sees them. Title-case here made every findCol() miss and every container
// read as not_in_sheet, which looked exactly like a broken cross-check.
const SHEET_HEADERS = ['consignee', 'inv no.', 'inv date', 'booking  no.', 'container no.', 'customer'];
const SHEET_ROWS = [
    ['Aris Enterprises', '26Aris02', '02/01/2026', 'PHX6A1731600', 'SMCU1176865', 'Aris'],
    ['Aris Enterprises', '26Aris02', '02/01/2026', 'PHX6A1731600', 'SMCU1033036', 'Aris'],
    ['HYNOS', '26HY01', '02/02/2026', 'PHX6A2335700', 'CAIU9924305', 'HYNOS'],
    ['HYNOS', '26HY01', '02/02/2026', 'PHX6A2335700', 'CAIU9899394', 'HYNOS'],
    // FFAU8016428 deliberately absent        -> not_in_sheet
    // FFAU7806670 present under a DIFFERENT booking -> booking_mismatch
    ['HYNOS', '26HY02', '02/03/2026', 'WRONGBOOKING', 'FFAU7806670', 'HYNOS'],
];
invoiceSheet.fetchRawSheet = async () => ({ headers: SHEET_HEADERS, rows: SHEET_ROWS });

const { createApi } = require(path.join(ROOT, 'api'));
let server, base;
function req(method, urlPath, { sid, body } = {}) {
    return new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r = http.request(base + urlPath, { method, headers }, (res) => {
            let raw = '';
            res.on('data', (c) => { raw += c; });
            res.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json, raw }); });
        });
        r.on('error', reject);
        if (data) r.write(data);
        r.end();
    });
}

(async () => {

const app = createApi();
await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
base = `http://127.0.0.1:${server.address().port}`;
const sid = (await req('POST', '/login', { body: { password: 'jarvis-pw-ddd' } })).json.sid;

// A bill for one of the containers, so the proposal has something to join to.
await mutateJson(cfg.BILLS_FILE, [], (all) => {
    const rows = Array.isArray(all) ? all : [];
    rows.push({ id: 'B_SMCU', date: '02/10/2026', supplier: 'Eccomelt', booking_no: 'PHX6A1731600',
                container_no: 'SMCU1176865', trucking_company: "Garduno's Logistics",
                gross: 44000, truck: 15000, container: 8000, chassis: 6000, boxes: 400, supplier_price: 0.30 });
    return rows;
});

// ── A — THE ROUTE, FROM PDF TO CONTAINER ROWS ─────────────────────────────
let result = null;
{
    section('A — one PDF in, six containers out');

    const before = extractCalls;
    const r = await req('POST', '/api/verify/gardunos', { sid, body: {
        pdfs: [{ name: 'Invoice 169 REVISED.pdf', base64: 'ZmFrZQ==' }],
    } });
    ck('the route answers', r.status === 200, r.status + ' ' + r.raw.slice(0, 200));
    result = r.json;

    ck('  it called the extractor', extractCalls === before + 1, String(extractCalls - before));
    ck('  and expanded the two booking lines into six containers',
       (result.matched || []).length === 6, String((result.matched || []).length));
    ck('  in the order printed',
       result.matched.map((m) => m.container_no).join(',')
       === 'SMCU1176865,SMCU1033036,CAIU9924305,CAIU9899394,FFAU8016428,FFAU7806670',
       result.matched.map((m) => m.container_no).join(','));

    ck('  each carries $850 line haul and $80 scale',
       result.matched.every((m) => m.line_haul === 850 && m.extra_scale_charge === 80),
       JSON.stringify(result.matched.map((m) => [m.line_haul, m.extra_scale_charge])));
    ck('  so the total per container is $930',
       result.matched.every((m) => m.total_amount === 930),
       JSON.stringify(result.matched.map((m) => m.total_amount)));
    ck('  and six of them come to the invoice total',
       result.matched.reduce((t, m) => t + m.total_amount, 0) === 5580);

    ck('  the file it came from rides along',
       result.matched.every((m) => m.source_file === 'Invoice 169 REVISED.pdf'));
    ck('  and so do the invoice number and date',
       result.matched.every((m) => m.invoice_no === '169 REVISED' && m.invoice_date === '02/13/2026'));
}

// ── B — THE CROSS-CHECK ACTUALLY RAN ──────────────────────────────────────
// The three outcomes that matter, on one invoice: on the sheet and agreeing,
// on the sheet under a DIFFERENT booking, and not on the sheet at all.
{
    section('B — checked against the Invoice sheet');

    const by = Object.fromEntries(result.matched.map((m) => [m.container_no, m.status]));
    ck('a container that agrees is verified', by.SMCU1176865 === 'verified', by.SMCU1176865);
    ck('  one the sheet does not have is flagged', by.FFAU8016428 === 'not_in_sheet', by.FFAU8016428);
    ck('  and one under a different booking is a mismatch, not a pass',
       by.FFAU7806670 === 'booking_mismatch', by.FFAU7806670);
    ck('  four of the six verified', result.matched.filter((m) => m.status === 'verified').length === 4,
       JSON.stringify(by));

    ck('the reverse list is present', Array.isArray(result.sheet_only), typeof result.sheet_only);
}

// ── C — THE OFFER TO PUT IT ON THE BILL ───────────────────────────────────
// renderBillProposals() in the client is generic over the hauler prefix, so
// this field existing is the whole difference between a tab that reports and
// a tab that gets the money into Trucking.
{
    section('C — bill proposals');

    ck('the response carries bill_proposals', Array.isArray(result.bill_proposals),
       JSON.stringify(result.bill_proposals_error || typeof result.bill_proposals));
    ck('  with no error', !result.bill_proposals_error, result.bill_proposals_error);

    const p = (result.bill_proposals || []).find((x) => x.container_no === 'SMCU1176865');
    ck('  the container that has a bill got an offer', !!p,
       JSON.stringify((result.bill_proposals || []).map((x) => [x.container_no, x.status])));
    ck('  naming the hauler', !!p && p.hauler === "Garduno's Logistics", p && p.hauler);
    ck('  joined by container, not booking', !!p && p.join_by === 'container', p && p.join_by);
    ck('  with the split Garduno\'s actually bills',
       !!p && p.split && p.split.line_haul === 850 && p.split.extra_scale === 80,
       JSON.stringify(p && p.split));
    ck('  and no dry run, which they do not charge',
       !!p && p.split && p.split.dry_run == null, JSON.stringify(p && p.split));
}

// ── D — THE WARNINGS REACH THE SCREEN ─────────────────────────────────────
{
    section('D — what the expansion would not decide');

    ck('the per-invoice summary comes back', Array.isArray(result.invoices) && result.invoices.length === 1,
       JSON.stringify((result.invoices || []).length));
    const inv = result.invoices[0];
    ck('  it reconciles to the printed total', inv.reconciled === true, String(inv.reconciled));
    ck('  and reports the balance due, so "Paid in Full" is visible',
       inv.balance_due === 0, String(inv.balance_due));
    ck('  REVISED is flagged', inv.revised === true, String(inv.revised));
    ck('  and said in words, with the file name',
       (result.warnings || []).some((w) => /Invoice 169 REVISED\.pdf/.test(w) && /REVISED/.test(w)),
       JSON.stringify(result.warnings));

    // ── AND NO PAYMENT WAS WRITTEN ───────────────────────────────────────
    // Her decision: the import creates what is OWED. This invoice says Paid
    // in Full and the route must still not post money.
    const payments = (() => {
        try { return require(path.join(ROOT, 'helpers/payments')).listPayments(); } catch (e) { return []; }
    })();
    ck('no payment was recorded, despite "Paid in Full"', payments.length === 0,
       `${payments.length} payment(s) — a PDF must not decide that money left her account`);
    const mt = require(path.join(ROOT, 'helpers/metalsTrucking'));
    ck('  and no trucking payment either', mt.list().length === 0, String(mt.list().length));
}

// ── E — A BAD PDF DOES NOT LOSE THE BATCH ─────────────────────────────────
{
    section('E — one unreadable invoice among several');

    let n = 0;
    nextExtraction = null;
    gemini.extractGardunosInvoiceRecords = async () => {
        n += 1;
        if (n === 1) throw new Error('Gemini said no');
        return INVOICE_169;
    };

    const r = await req('POST', '/api/verify/gardunos', { sid, body: {
        pdfs: [{ name: 'bad.pdf', base64: 'eA==' }, { name: 'good.pdf', base64: 'eA==' }],
    } });
    ck('the run still succeeds', r.status === 200, r.status + ' ' + r.raw.slice(0, 160));
    const rows = r.json.matched || [];
    ck('  the good invoice still produced its six containers',
       rows.filter((x) => x.source_file === 'good.pdf').length === 6,
       String(rows.filter((x) => x.source_file === 'good.pdf').length));
    ck('  and the bad one is a row saying so, not a silence',
       rows.some((x) => x.source_file === 'bad.pdf' && x.extraction_failed),
       JSON.stringify(rows.filter((x) => x.source_file === 'bad.pdf')));
    ck('  with the reason on the warnings',
       (r.json.warnings || []).some((w) => /bad\.pdf/.test(w) && /Gemini said no/.test(w)),
       JSON.stringify(r.json.warnings));
}

// ── F — IT REFUSES AN EMPTY UPLOAD ────────────────────────────────────────
{
    section('F — nothing to do');
    const r = await req('POST', '/api/verify/gardunos', { sid, body: { pdfs: [] } });
    ck('an empty upload is a 400, not a crash', r.status === 400, String(r.status));
}

// ── G — THE TAB'S WIRING ──────────────────────────────────────────────────
// STATIC, and said so. It does not render the page; it checks that every id
// the Garduno's JS reaches for actually exists in the HTML, and that every
// shared helper it calls is declared somewhere.
//
// Worth having because that is the exact mistake I made writing it: I called
// a status renderer named verifyStatusCell that does not exist anywhere in
// this codebase. It parsed, it would have thrown on the first run, and no
// test here would have noticed — the panel would simply have done nothing
// when she pressed the button.
{
    section("G — the tab reaches for things that exist");

    const html = fs.readFileSync(path.join(ROOT, 'dashboard/documents.html'), 'utf8');

    const ids = [...new Set([...html.matchAll(/\$\('(gard[A-Za-z]+)'\)/g)].map((m) => m[1]))];
    ck(`the Garduno's JS reaches ${ids.length} element id(s)`, ids.length >= 8, ids.join(', '));
    const missing = ids.filter((id) => !new RegExp(`id="${id}"`).test(html));
    ck('  every one of them exists in the panel', missing.length === 0, missing.join(', '));

    // Shared helpers, by the same rule.
    const used = ['verifyAllChip', 'verifyStatusChips', 'verifyApply', 'verifyFilterNote',
                  'verifyActive', 'propMoney', 'ajBadge', 'setButtonLoading', 'renderBillProposals'];
    const undeclared = used.filter((fn) => !new RegExp(`(function|const|let)\\s+${fn}\\b`).test(html));
    ck('  and every shared helper it calls is declared', undeclared.length === 0, undeclared.join(', '));

    // The sub-tab has to be registered in BOTH maps or the button shows a
    // blank panel — two places, which is two chances to do one of them.
    ck("the sub-tab is registered in the group list",
       /transport: \[[^\]]*'gardunos'/.test(html));
    ck('  and mapped to its panel',
       /gardunos: 'verifyPanelGardunos'/.test(html) && /id="verifyPanelGardunos"/.test(html));

    // Every status crossCheckGardunosRecords can return must have a badge, or
    // the cell renders the raw key.
    for (const st of ['verified', 'booking_mismatch', 'not_in_sheet', 'no_container_on_pdf', 'sheet_booking_blank']) {
        ck(`  the badge map covers ${st}`, new RegExp(`\\b${st}:`).test(html));
    }
}

server.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { try { server.close(); } catch (x) {} console.error('threw:', e && e.stack); process.exit(1); });
