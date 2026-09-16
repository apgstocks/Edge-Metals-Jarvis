// ── tests/packing-list.js ─────────────────────────────────────────────────
// Apsara, 2026-09-16: "in edge metals,i want to create a sub tab under invoice
// -documents as packing list.it should allow to upload photo/pdf ,it scan and
// fill fields and then create fields like container nuber,booking no,invoice
// number,rows and columns of items."
//
// EDGE METALS. A packing list belongs to a container going out under an
// invoice, and she said in the same message that Edge Metals has nothing to do
// with the yard.
//
// ── THE TWO WAYS A SCANNER LIKE THIS GOES WRONG ─────────────────────────────
//
//   IT SAVES WHAT IT READ. Then there is a drawer of documents nobody has
//   checked, and the first wrong container number is found by a customer. The
//   scan route writes NOTHING; section C holds that, against a real server.
//
//   IT INVENTS. A packing list genuinely missing a booking number must come
//   back null, not with a plausible one. A blank she can see is recoverable; a
//   confident wrong value is not. Section B holds that.
//
// THE MODEL IS INJECTED throughout — `ask` is a parameter for exactly this
// reason. No test here reaches real Gemini or her live data, which is the
// standing rule for every AI path in this project.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-packing-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD   = 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = 'staff-pw-ccccccccccc';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('  ABORT  config not isolated'); process.exit(1); }

const pl = require(path.join(ROOT, 'helpers/packingList'));
const DOCS = fs.readFileSync(path.join(ROOT, 'dashboard/documents.html'), 'utf8');

// What a real packing list for one of her containers looks like coming back.
//
// A WEIGHT BREAKDOWN PER CONTAINER — gross, then the four tare components
// (truck, container, chassis, boxes), then net in lbs and mt. That is the
// document Edge Metals has been issuing since 2026-09-09 through the invoice's
// "Separate invoice & packing list" flag.
//
// The first version of this fixture used marks/description/pieces, because the
// first version of the helper invented those columns without checking what her
// packing list actually has. A scanner reading fields her document does not
// carry, feeding a PDF in a shape her customers have never seen, would have
// been worse than no feature.
const GOOD = {
    container_no: 'TCLU 123 456 7', booking_no: 'BK-2602', invoice_no: '260819_AC_26JY95',
    seal_no: '40217', date: '09/16/2026', customer: 'Eccomelt', weight_unit: 'LBS',
    rows: [
        { container_no: 'TCLU1234567', gross_weight_lbs: '46,300', truck_lbs: '15,000',
          container_tare_lbs: '8,000', chassis_lbs: '6,000', boxes_weight_lbs: '500',
          net_weight_lbs: '16,800', net_weight_mt: '7.620' },
        { container_no: 'MSKU7654321', gross_weight_lbs: '44,120', truck_lbs: '14,800',
          container_tare_lbs: '8,000', chassis_lbs: '6,000', boxes_weight_lbs: '420',
          net_weight_lbs: '14,900', net_weight_mt: '6.758' },
    ],
};

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — what comes back off a document');
// ══════════════════════════════════════════════════════════════════════════
{
    const out = await pl.scan('ZmFrZQ==', 'image/jpeg', { ask: async () => JSON.stringify(GOOD) });
    ck('a packing list is read', out.ok === true, JSON.stringify(out.error));
    ck('  container number', out.fields.container_no === 'TCLU 123 456 7', out.fields.container_no);
    ck('  booking number', out.fields.booking_no === 'BK-2602');
    ck('  invoice number', out.fields.invoice_no === '260819_AC_26JY95');
    ck('  and the container rows', out.rows.length === 2, JSON.stringify(out.rows.map((r) => r.container_no)));
    // The columns her document actually has. Asserted by name, because the
    // whole point of this rewrite was that the first set was invented.
    for (const col of ['gross_weight_lbs', 'truck_lbs', 'container_tare_lbs',
                       'chassis_lbs', 'boxes_weight_lbs', 'net_weight_lbs', 'net_weight_mt']) {
        ck(`    ${col} is read`, !!out.rows[0][col], JSON.stringify(out.rows[0]));
    }
    // ── AND THEN SHE ASKED FOR THREE ─────────────────────────────────────
    // "in packing list,i juxt want gross,tare ,net", and on whether the
    // printed document follows: "Yes". So the FORM is four columns — the
    // container plus those three — while the STORE still accepts the four
    // tare components, because a scanned page prints them separately and
    // discarding them would make the record disagree with the paper.
    ck('    the item grid shows the three she asked for',
       pl.FORM_FIELDS.join(',') === 'gross_weight_lbs,tare_lbs,net_weight_lbs',
       pl.FORM_FIELDS.join(','));
    ck('    and the container is not one of them',
       !pl.FORM_FIELDS.includes('container_no'),
       'it is a field at the top of the form, and the key this store matches on');
    ck('    while the store still keeps the tare components',
       ['truck_lbs', 'container_tare_lbs', 'chassis_lbs', 'boxes_weight_lbs']
           .every((k) => pl.ROW_FIELDS.includes(k)),
       pl.ROW_FIELDS.join(','));

    // ── ONE ANSWER TO "WHAT IS THE TARE" ─────────────────────────────────
    // Her typed figure wins; otherwise the components are summed. Both the
    // form and helpers/invoicePdf.js call this one function, because two
    // answers would eventually differ — on a document a customer is holding.
    ck('  a typed tare wins', pl.tareOf({ tare_lbs: '24,000', truck_lbs: '15,000' }) === 24000);
    ck('  four components are summed',
       pl.tareOf({ truck_lbs: '15,000', container_tare_lbs: '8,000', chassis_lbs: '6,000', boxes_weight_lbs: '500' }) === 29500);
    ck('  and nothing at all stays NULL, not zero',
       pl.tareOf({}) === null,
       'a zero tare claims the container weighed nothing; a blank is an absence, and on a weight document those differ');

    // ── WEIGHTS STAY AS PRINTED ──────────────────────────────────────────
    // The same rule as the BOL's: "46,300" must read back as "46,300". A
    // figure quietly reformatted cannot be compared to the paper it came off,
    // which is the one check she can actually make.
    ck('  weights are kept exactly as printed', out.rows[0].gross_weight_lbs === '46,300',
       out.rows[0].gross_weight_lbs + ' — 46300 means it was parsed, and a parsed figure cannot be checked against the paper');

    // A unit this system understands, not whatever the model typed.
    ck('  "LBS" becomes lb', out.fields.weight_unit === 'lb', out.fields.weight_unit);

    // Which boxes to mark on screen. Only fields that came back with a VALUE:
    // flagging a null as "read from the document" says the scan looked and
    // found nothing, which is not the same as the scan failing to read it.
    ck('  it reports which fields it filled', out.scanned_fields.includes('container_no'));
    ck('    and counts the rows as one of them', out.scanned_fields.includes('rows'));
}

// ══════════════════════════════════════════════════════════════════════════
section('B — it does not invent, and it does not crash');
// ══════════════════════════════════════════════════════════════════════════
{
    const sparse = await pl.scan('eA==', 'image/jpeg', { ask: async () => JSON.stringify({
        container_no: 'MSKU7654321', booking_no: null, invoice_no: null,
        rows: [{ container_no: 'MSKU7654321', net_weight_lbs: '3,000' }, {}, { container_no: null }],
    }) });
    ck('a missing booking number stays empty', sparse.fields.booking_no === '', JSON.stringify(sparse.fields.booking_no));
    ck('  and is NOT reported as read', !sparse.scanned_fields.includes('booking_no'),
       JSON.stringify(sparse.scanned_fields) + ' — marking a blank as read tells her it was checked');
    ck('  blank rows are dropped', sparse.rows.length === 1, JSON.stringify(sparse.rows));

    // FAIL SOFT. She is left with an empty form she can type into, which is
    // exactly where she was before this feature existed. Throwing would turn a
    // helper into a blocker.
    const boom = await pl.scan('eA==', 'image/jpeg', { ask: async () => { throw new Error('model unavailable'); } });
    ck('a failed scan does not throw', boom.ok === false && !!boom.error, JSON.stringify(boom));
    ck('  and says what to do instead', /by hand/i.test(boom.error), boom.error);

    const junk = await pl.scan('eA==', 'image/jpeg', { ask: async () => 'not json at all' });
    ck('unparseable output is handled', junk.ok === false, JSON.stringify(junk));

    const wrong = await pl.scan('eA==', 'application/pdf', { ask: async () => JSON.stringify({ not_a_packing_list: true }) });
    ck('a document that is not a packing list is refused', wrong.ok === false, JSON.stringify(wrong));
    ck('  in words she can act on', /packing list/i.test(wrong.error), wrong.error);

    let threw = null;
    try { await pl.scan('', 'image/jpeg', { ask: async () => '{}' }); } catch (e) { threw = e; }
    ck('no file at all is a plain error', !!threw, 'sending nothing should not reach the model');
}

// ══════════════════════════════════════════════════════════════════════════
section('C — the scan route saves NOTHING');
// ══════════════════════════════════════════════════════════════════════════
{
    const { createApi } = require(path.join(ROOT, 'api'));
    const app = createApi();
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = (method, p, { body, sid } = {}) => new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r2 = http.request(base + p, { method, headers }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
        });
        r2.on('error', reject); if (data) r2.write(data); r2.end();
    });

    const admin = ((await req('POST', '/login', { body: { password: 'admin-pw-bbbbbbbbbbb' } })).json || {}).sid;
    const staff = ((await req('POST', '/login', { body: { password: 'staff-pw-ccccccccccc' } })).json || {}).sid;

    // Edge Metals is not staff's. Checked against a live server rather than by
    // reading the allowlist.
    for (const [label, p] of [['list', '/api/packing-lists'], ['scan', '/api/packing-lists/scan']]) {
        const r = await req(p.endsWith('scan') ? 'POST' : 'GET', p, { sid: staff, body: { file_base64: 'eA==' } });
        ck(`staff cannot reach ${label}`, [401, 403].includes(r.status), `${r.status}`);
    }

    const before = pl.list().length;
    // ── THIS DOES NOT CALL THE REAL MODEL ────────────────────────────────
    // The route has no `ask` to inject, and the first version of this check
    // therefore reached LIVE GEMINI — a key is configured in this
    // environment. It fail-softed and the test passed, which is the worst
    // shape of that mistake: a suite quietly billing a real API and depending
    // on a network, while looking green.
    //
    // helpers/packingList.js now refuses to reach the model under JARVIS_TEST
    // unless an `ask` is injected, so this exercises the fail-soft path
    // deliberately rather than by accident. What is being asserted either way
    // is that a scan — working or failing — writes nothing.
    const scanned = await req('POST', '/api/packing-lists/scan', { sid: admin, body: { file_base64: 'eA==', mime_type: 'image/jpeg' } });
    ck('the scan route answers rather than erroring out', scanned.status === 200, JSON.stringify(scanned));
    ck('  without reaching the real model under JARVIS_TEST', scanned.json && scanned.json.ok === false,
       JSON.stringify(scanned.json) + ' — a green suite that bills a live API is worse than a red one');
    ck('  and NOTHING was saved by scanning', pl.list().length === before,
       `${before} -> ${pl.list().length} — a scanner that files its own guesses builds a drawer nobody has read`);

    // A file too large is refused with a sentence, not a timeout.
    const huge = await req('POST', '/api/packing-lists/scan', { sid: admin, body: { file_base64: 'A'.repeat(29 * 1024 * 1024) } });
    ck('an oversized file is refused in words', huge.status === 413 && /too big/i.test(huge.json.error), JSON.stringify(huge.status));

    // ── SAVING IS A SEPARATE, EXPLICIT REQUEST ───────────────────────────
    const saved = await req('POST', '/api/packing-lists', { sid: admin, body: {
        container_no: 'TCLU1234567', booking_no: 'BK-2602', invoice_no: 'INV-1',
        customer: 'Eccomelt', weight_unit: 'lb',
        rows: [{ container_no: 'TCLU1234567', gross_weight_lbs: '46,300', net_weight_lbs: '16,800', net_weight_mt: '7.620' }],
        scanned_fields: ['container_no', 'rows'],
    } });
    ck('saving is its own request', saved.status === 200 && !!saved.json.packing_list, JSON.stringify(saved.json));
    ck('  and the weights survive as typed',
       saved.json.packing_list.rows[0].gross_weight_lbs === '46,300',
       saved.json.packing_list.rows[0].gross_weight_lbs);
    ck('  with a record of which fields were read off the document',
       (saved.json.packing_list.scanned_fields || []).includes('container_no'),
       'six weeks later, "was this typed or read?" is a question with money behind it');

    // An empty form saved by accident makes the real ones harder to find.
    const empty = await req('POST', '/api/packing-lists', { sid: admin, body: { rows: [] } });
    ck('an empty packing list is refused', empty.status === 400, JSON.stringify(empty.json));

    // ── ONE CONTAINER, ONE LIST ──────────────────────────────────────────
    // Re-scanning a document she has already filed corrects it rather than
    // leaving two lists both claiming to describe TCLU1234567. Matched on the
    // normalised container, because carriers space them differently on every
    // document.
    const again = await req('POST', '/api/packing-lists', { sid: admin, body: {
        container_no: 'tclu 123 456 7', booking_no: 'BK-9999',
        rows: [{ container_no: 'TCLU1234567', net_weight_lbs: '16,900' }],
    } });
    ck('the same container spelled differently REPLACES the list',
       again.json.packing_list.id === saved.json.packing_list.id,
       'two lists for one container is the bug this keying exists to prevent');
    ck('  and the correction took', again.json.packing_list.booking_no === 'BK-9999');
    ck('  with still only one on file', pl.list().length === 1, `${pl.list().length}`);

    // A list with NO container can only ever be new. Blank keys must never
    // match each other — the trap helpers/oncePerSave.js documents.
    await req('POST', '/api/packing-lists', { sid: admin, body: { rows: [{ net_weight_lbs: '1' }] } });
    await req('POST', '/api/packing-lists', { sid: admin, body: { rows: [{ net_weight_lbs: '2' }] } });
    ck('two lists with no container stay two lists', pl.list().length === 3, `${pl.list().length}`);

    // ── DELETE IS AUDITED ────────────────────────────────────────────────
    const audit = require(path.join(ROOT, 'helpers/audit'));
    const n = audit.listEntries().length;
    const gone = await req('DELETE', `/api/packing-lists/${encodeURIComponent(saved.json.packing_list.id)}`, { sid: admin });
    ck('deleting works', gone.status === 200, JSON.stringify(gone.json));
    const row = audit.listEntries().pop();
    ck('  and is logged under its own action',
       audit.listEntries().length > n && row.action === 'delete-packing-list',
       row && `${row.action} / ${row.requested_action}`);
    ck('    naming the container that went', row && row.detail && row.detail.container_no === 'tclu 123 456 7',
       JSON.stringify(row && row.detail));

    server.close();
}

// ══════════════════════════════════════════════════════════════════════════
section('C2 — generating the PDF, and checking it against the invoice');
// ══════════════════════════════════════════════════════════════════════════
{
    // Apsara, 2026-09-16, on what the tab should do: "Scan ,fill data auto and
    // generate pdf", and on cross-checking: "Yes — warn me when they disagree."
    const iv = require(path.join(ROOT, 'helpers/invoiceVersions'));
    await iv.saveInvoiceVersion('TCLU1234567', {
        inv_no: '260819_AC_26JY95', container_no: 'TCLU1234567', consignee: 'Eccomelt Inc',
        line_items: [{ container_no: 'TCLU1234567', weight: '7.620',
            packing: { gross_weight_lbs: '46,300', net_weight_lbs: '16,800', net_weight_mt: '7.620' } }],
    });

    const rec = {
        container_no: 'TCLU1234567', invoice_no: '260819_AC_26JY95',
        rows: [{ container_no: 'TCLU1234567', gross_weight_lbs: '46,300', truck_lbs: '15,000',
                 container_tare_lbs: '8,000', chassis_lbs: '6,000', boxes_weight_lbs: '500',
                 net_weight_lbs: '16,800', net_weight_mt: '7.620' }],
    };

    // ── THE SAME DOCUMENT, NOT A SECOND DESIGN ───────────────────────────
    // Rendered through assets/invoice-classic/template.html's standalone
    // packing mode — the one the invoice's "Separate" flag has produced since
    // 2026-09-09. Two designs would mean her customers receiving two
    // different-looking papers from one company.
    //
    // The renderer is INJECTED: Chromium cannot launch in this sandbox, and
    // what is under test is the data handed to it, not the pixels.
    let handed = null;
    const pdf = await pl.generatePdf(rec, { renderer: async (html, modes) => { handed = { html, modes }; return { packing: Buffer.from('%PDF stub') }; } });
    ck('a PDF comes out', !!pdf && pdf.length > 0);
    ck('  in the template\'s standalone packing mode', handed.modes.join(',') === 'packing', JSON.stringify(handed.modes));

    // ── THE HEADER COMES FROM THE INVOICE ────────────────────────────────
    // That template's standalone packing list carries the full invoice header
    // — exporter, buyer, terms, vessel, four ports. This form holds none of
    // it and should not: she typed it once already on the invoice for the same
    // container.
    ck('  the header is taken from the invoice', /Eccomelt Inc/.test(handed.html),
       'retyping an exporter block and four ports she has already entered is not a feature');
    ck('  and HER weight rows are on it',
       /46,300/.test(handed.html) && /16,800/.test(handed.html),
       'the whole packing table, not just the header');

    // ── THE PRINTED TABLE IS THREE WEIGHT COLUMNS NOW ────────────────────
    // Counted rather than eyeballed. A TOTAL row with the wrong number of
    // cells does not error — it SHEARS, sliding the net figures one column
    // left so they print under the wrong headings, on the page a customer
    // receives. Nothing else in this suite would catch that.
    {
        const start = handed.html.indexOf('class="doc-packing"');
        const tbl = handed.html.slice(handed.html.indexOf('<table', start), handed.html.indexOf('</table>', start));
        const cellsIn = (x) => (x.match(/<t[hd][ >]/g) || []).length;
        const thead = tbl.slice(tbl.indexOf('<thead>'), tbl.indexOf('</thead>'));
        const body = tbl.slice(tbl.indexOf('<tbody>'), tbl.indexOf('</tbody>'));
        const counts = [cellsIn(thead), ...body.split('<tr').slice(1).map(cellsIn)];
        ck('  every row of the printed table has the same number of cells',
           new Set(counts).size === 1, counts.join(',') + ' — header, data rows and TOTAL');
        ck('    and that number is five', counts[0] === 5, String(counts[0]));
        ck('  the four old tare headings are gone',
           !/Truck<br>/.test(handed.html) && !/Chassis<br>/.test(handed.html) && !/Boxes<br>/.test(handed.html));
        ck('    replaced by one Tare', /Tare<br>/.test(handed.html));
    }

    // ── AND NOTHING ON FILE NEEDS MIGRATING ──────────────────────────────
    // An invoice saved before today still carries the tare broken into four.
    // It must regenerate with the SAME total it always had, in one column.
    {
        const { buildInvoiceClassicHtml } = require(path.join(ROOT, 'helpers/invoicePdf'));
        const { html } = buildInvoiceClassicHtml({
            inv_no: 'OLD-1', container_no: 'TCLU1234567', consignee: 'Eccomelt Inc',
            line_items: [{ container_no: 'TCLU1234567', weight: '7.620', packing: {
                gross_weight_lbs: '46,300', truck_lbs: '15,000', container_tare_lbs: '8,000',
                chassis_lbs: '6,000', boxes_weight_lbs: '500', net_weight_lbs: '16,800', net_weight_mt: '7.620' } }],
        });
        ck('an invoice saved BEFORE today still prints its tare', /29,500/.test(html),
           '15,000 + 8,000 + 6,000 + 500 — summed on read, so no stored payload needs changing');
        ck('  with its gross and net untouched', /46,300/.test(html) && /16,800/.test(html));
    }

    // A packing list with a blank exporter block looks finished and is useless
    // to a broker. Refusing is the right answer, and it says what to do.
    let err = null;
    try {
        await pl.generatePdf({ container_no: 'NOPE1234567', rows: [{ net_weight_lbs: '1' }] },
                             { renderer: async () => ({ packing: Buffer.from('x') }) });
    } catch (e) { err = e; }
    ck('no invoice for that container means it REFUSES', err && err.code === 'NO_INVOICE', String(err && err.code));
    ck('  saying what to do about it', err && /Make the invoice first/i.test(err.message), err && err.message);

    let err2 = null;
    try { await pl.generatePdf({ rows: [{ net_weight_lbs: '1' }] }, { renderer: async () => ({}) }); } catch (e) { err2 = e; }
    ck('  and no container at all is its own refusal', err2 && err2.code === 'NO_CONTAINER', String(err2 && err2.code));

    // ── THE CROSS-CHECK ──────────────────────────────────────────────────
    ck('a packing list that agrees with its invoice warns about nothing',
       pl.compareToInvoice(rec).length === 0, JSON.stringify(pl.compareToInvoice(rec)));

    const differ = JSON.parse(JSON.stringify(rec));
    differ.rows[0].net_weight_lbs = '17,900';
    const warn = pl.compareToInvoice(differ);
    ck('a net weight that disagrees IS flagged', warn.length === 1, JSON.stringify(warn));
    ck('  naming the container and both figures',
       warn[0] && /TCLU1234567/.test(warn[0].message) && /17,900/.test(warn[0].message) && /16,800/.test(warn[0].message),
       warn[0] && warn[0].message);
    ck('  and it is a warning, not a refusal',
       !!(await pl.generatePdf(differ, { renderer: async () => ({ packing: Buffer.from('x') }) })),
       'the packing list may be right and the invoice wrong — only she knows which');

    // Rounding must not become noise. Both documents are typed by hand from
    // the same scale tickets; flagging a 1 lb difference teaches her to ignore
    // the warning, and then the real one goes past too.
    const rounded = JSON.parse(JSON.stringify(rec));
    rounded.rows[0].net_weight_lbs = '16,801';
    ck('  a 1 lb rounding is NOT flagged', pl.compareToInvoice(rounded).length === 0,
       JSON.stringify(pl.compareToInvoice(rounded)));

    // "No invoice yet" is not a disagreement.
    ck('nothing to compare against says nothing',
       pl.compareToInvoice({ container_no: 'XXXU0000000', rows: [{ net_weight_lbs: '1' }] }).length === 0,
       'reporting a missing invoice as a mismatch teaches her to stop reading these');
}

// ══════════════════════════════════════════════════════════════════════════
section('D — the screen');
// ══════════════════════════════════════════════════════════════════════════
{
    // Driven, not grepped: a sub-tab whose button renders but never shows its
    // panel looks perfect in source.
    const dom = new JSDOM(DOCS, { runScripts: 'dangerously', url: 'http://localhost/documents',
        beforeParse(w) {
            w.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, packing_lists: [], bols: [] }) });
            w.alert = () => {}; w.confirm = () => true;
        } });
    await new Promise((r) => setTimeout(r, 400));
    const w = dom.window, d = w.document;

    const btn = [...d.querySelectorAll('.subtab-btn')].find((b) => b.dataset.subtab === 'packing');
    ck('there is a Packing list sub-tab', !!btn, [...d.querySelectorAll('.subtab-btn')].map((b) => b.dataset.subtab).join(','));
    ck('  labelled in her words', btn && /packing list/i.test(btn.textContent), btn && btn.textContent);

    btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    ck('  clicking it shows the panel', !d.getElementById('panelPacking').classList.contains('hidden'));
    ck('  and hides the BOL panel', d.getElementById('panelBol').classList.contains('hidden'),
       'two panels at once is how a form gets filled in on the wrong document');

    // The four fields she named, by name.
    for (const [label, id] of [['container number', 'pk_container'], ['booking number', 'pk_booking'],
                               ['invoice number', 'pk_invoice']]) {
        ck(`  there is a ${label} box`, !!d.getElementById(id));
    }
    ck('  and an upload that takes a photo OR a pdf',
       /accept="image\/\*,application\/pdf"/.test(DOCS),
       'she said "upload photo/pdf" — a picker that only takes PDFs makes her scan it first');

    // Rows and columns.
    const headers = d.getElementById('pkItems').textContent;
    // Apsara: "remove container in item grid". It is already a field at the
    // top of the form and this store keys a packing list on it — one
    // container, one list. Repeating it per row asked her to type the same
    // number twice and gave it two places to disagree.
    ck('  the item grid has no Container column',
       !/\['container_no', 'Container'/.test(DOCS),
       'the container lives once, at the top of the form');
    for (const col of ['Gross', 'Tare', 'Net']) {
        ck(`  the items table has a ${col} column`, headers.includes(col), headers.slice(0, 120));
    }
    // "keep the heading on top of the box" — sticky, so the column names stay
    // put once the list is long enough to scroll. A weights table whose
    // headings have scrolled away is one where the next number goes in the
    // wrong column.
    ck('  the heading stays on top of the box',
       /position:sticky; top:0/.test(DOCS.slice(DOCS.indexOf('const head = '), DOCS.indexOf('const head = ') + 400)),
       'headings that scroll away are headings that stop being read');

    const rows0 = d.querySelectorAll('#pkItems input[data-pi]').length;
    ck('  and starts with blank lines to type into', rows0 > 0, `${rows0} inputs`);

    // She asked for a PDF out of this tab, not just storage.
    ck('  there is a Generate button', !!d.getElementById('btnPkGenerate'));
    ck('  and a Preview', !!d.getElementById('btnPkPreview'));
    ck('  with somewhere to show a disagreement', !!d.getElementById('pkWarnings'));
    // The preview tab is claimed BEFORE the fetch, or the popup blocker eats
    // it — documented on the BOL preview, and the same trap here.
    ck('  the preview opens its tab before the await',
       /const tab = window\.open\('', '_blank'\);[\s\S]{0,200}await fetch/.test(DOCS),
       'window.open after an await is swallowed by the popup blocker, silently');

    // Adding a line must actually add one.
    d.getElementById('btnPkAddRow').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    ck('  + Add line adds a line',
       d.querySelectorAll('#pkItems input[data-pi]').length > rows0,
       'a button that renders and does nothing is the failure this whole suite is arranged around');

    // The date default must be the yard's day, not UTC — after 7pm in Frisco
    // toISOString() is already tomorrow. Fixed on the BOL; not repeated here.
    ck('  the date defaults through the LA timezone, not UTC',
       /timeZone: 'America\/Los_Angeles'/.test((w.pkTodayStr || (() => '')).toString()),
       'toISOString() rolls over at 5pm local and dates the document tomorrow');

    dom.window.close();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }

})().catch((e) => { console.error(e); process.exit(1); });
