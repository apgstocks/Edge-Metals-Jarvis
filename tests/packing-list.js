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

// Her real weigh sheet, photographed on a desk: fifteen bundles, 61,530 lbs.
// Module scope rather than inside section A2, because section F needs the same
// sheet to prove the invoice cross-check produces ONE warning for it and not
// fifteen — and two copies of her figures would eventually be two different
// sets of figures.
const TALLY_WEIGHTS = [3599, 3475, 4146, 3939, 4450, 3815, 4346, 4293, 4018, 4088,
                       4228, 4210, 4369, 4076, 4478];

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
section('A2 — the document she ACTUALLY sends: a handwritten bundle tally');
// ══════════════════════════════════════════════════════════════════════════
{
    // Apsara, 2026-09-16, with a photo of two notepad sheets on a desk: "When i
    // send to scan packing list,it is not filling the gross weight at all
    // except 3599."
    //
    // ── WHY IT FOUND NOTHING ─────────────────────────────────────────────
    // The prompt asked for "one entry per CONTAINER row in the packing table"
    // with Container / Gross / Tare / Net columns. Her sheet has none of those.
    // It is a WEIGH SHEET — fifteen numbered bundles, one weight each:
    //
    //     3599 - weight
    //     #1 - 3599 lbs
    //     #2 - 3475 lbs
    //     ...
    //     #15 - 4478 lbs
    //
    // So there was nothing for the model to fill in, and the single figure that
    // did land was the "3599" in the heading. THIRD time the shape of this
    // feature has been wrong, and the first time with the real document in
    // front of me. Her actual figures are the fixture now, so this exact sheet
    // cannot quietly stop working again.
    // The single weight is the GROSS — Apsara, 2026-09-16: "a single weight is
    // gross..make calc as gross -tare is net.by default make tare as 0". My
    // first version put it in net, which was a guess and the wrong one.
    const tally = {
        container_no: null, booking_no: null, invoice_no: null, weight_unit: 'lb',
        rows: TALLY_WEIGHTS.map((w, i) => ({ gross_weight_lbs: String(w), note: `#${i + 1}` })),
    };
    const out = await pl.scan('eA==', 'image/jpeg', { ask: async () => JSON.stringify(tally) });

    ck('every bundle becomes a row', out.rows.length === 15, `${out.rows.length} of 15`);
    ck('  the first and last are right',
       out.rows[0].gross_weight_lbs === '3599' && out.rows[14].gross_weight_lbs === '4478',
       `${out.rows[0].gross_weight_lbs} … ${out.rows[14].gross_weight_lbs}`);
    ck('  and the bundle numbers are kept',
       out.rows[0].note === '#1' && out.rows[14].note === '#15',
       'a bale-by-bale packing list with no bale numbers is a column of figures');

    // The scan returns a gross and NOTHING ELSE. Tare defaulting to 0 and net
    // being gross minus tare are the FORM's job, not the model's — asking it
    // for a net would be a second answer to a question the arithmetic already
    // settles.
    ck('  the scan does not return a net at all',
       out.rows.every((r) => !r.net_weight_lbs),
       'net is derived; a scanned one could disagree with the two figures beside it');

    // ── AND THE DERIVATION ───────────────────────────────────────────────
    const built = pl.buildRecord({ rows: out.rows }, null);
    ck('  once filed, tare defaults to 0', built.rows.every((r) => r.tare_lbs === '0'),
       JSON.stringify(built.rows.slice(0, 2).map((r) => r.tare_lbs)));
    ck('  and net comes out as gross minus tare',
       built.rows[0].net_weight_lbs === '3,599' && built.rows[14].net_weight_lbs === '4,478',
       `${built.rows[0].net_weight_lbs} … ${built.rows[14].net_weight_lbs}`);
    ck('  a real tare changes it',
       pl.netOf({ gross_weight_lbs: '3,599', tare_lbs: '599' }) === 3000,
       String(pl.netOf({ gross_weight_lbs: '3,599', tare_lbs: '599' })));
    ck('  and no gross at all gives no net, not zero',
       pl.netOf({ tare_lbs: '500' }) === null,
       'a zero net would claim a bundle weighing nothing');

    // The number that matters: fifteen bundles is one container-load.
    const total = built.rows.reduce((t, r) => t + Number(String(r.net_weight_lbs).replace(/,/g, '')), 0);
    ck('  the net total is the container load', total === 61530, `${total} — 61,530 lbs across 15 bundles`);

    // The heading on her sheet reads "3599 - weight", which repeats the first
    // entry. It is a note to herself, not a row and not a container.
    ck('a heading that repeats the first weight is not a container number',
       !out.fields.container_no,
       JSON.stringify(out.fields.container_no) + ' — a made-up container is worse than a blank');

    // ── THE PROMPT HAS TO SAY ALL OF THIS ────────────────────────────────
    // The fixture above proves the plumbing handles the shape; only the prompt
    // decides whether the model produces it. Asserted at the source, because a
    // stubbed `ask` can never catch a prompt that asks for the wrong thing —
    // which is precisely the bug she reported.
    const src = fs.readFileSync(path.join(ROOT, 'helpers/packingList.js'), 'utf8');
    ck('the prompt describes a handwritten tally', /HANDWRITTEN TALLY/.test(src));
    // Newlines flattened before matching: the prompt is a template literal
    // wrapped for readability, so a phrase that reads as one sentence is
    // spread over two source lines. Matching the raw file would fail on
    // wording that is perfectly correct.
    const flat = src.replace(/\s+/g, ' ');
    ck('  and says one numbered line is one row', /line is ONE BUNDLE and becomes ONE ROW/.test(flat));
    ck('  and that the single weight is GROSS', /the bundle's GROSS weight/.test(flat),
       'her correction: "a single weight is gross"');
    ck('  and tells the model NOT to return a net',
       /leave tare and\s*net null/.test(flat) && /net is CALCULATED as gross minus tare/.test(flat),
       'a scanned net would be a second answer to a question the form already settles');
    ck('  and to read EVERY line, including a second sheet',
       /READ EVERY NUMBERED LINE/.test(flat) && /second sheet or a second photo/.test(flat),
       'her two sheets were photographed side by side in one image');
    ck('  and to use the corrected figure where a line was amended',
       /crossed out and rewritten/.test(flat),
       'three lines on her sheet are struck through and rewritten');
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

    // ── DISAGREE BY CHANGING A REAL FIGURE ───────────────────────────────
    // This used to overwrite net_weight_lbs, which stopped meaning anything
    // once net became DERIVED (gross minus tare, her rule of 2026-09-16). A
    // stored net is now a rendering of the two figures beside it, so the way
    // to make a packing list genuinely disagree with its invoice is to change
    // what was WEIGHED. 47,400 gross against the same 29,500 of tare is
    // 17,900 net — the same disagreement this check has always been about,
    // expressed in a field that still drives something.
    const differ = JSON.parse(JSON.stringify(rec));
    differ.rows[0].gross_weight_lbs = '47,400';
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
    rounded.rows[0].gross_weight_lbs = '46,301';
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

    // ── AND THEY SIT WHERE SHE PUT THEM ──────────────────────────────────
    // Apsara, 2026-09-16: "Start with date,below it-invoice number,below-
    // customer.on the right side,booking number ,container,seal no stakced
    // vertical". Left is the commercial side of the document — when, which
    // invoice, whose; right is the shipment — booking, box, seal.
    //
    // Asserted by reading the rendered columns rather than the source order,
    // because CSS can reorder a grid and leave the markup looking right.
    {
        const wrap = d.querySelector('#panelPacking [data-pkfield="date"]').parentElement.parentElement;
        const colOf = (i) => [...wrap.children[i].querySelectorAll('[data-pkfield]')].map((e) => e.dataset.pkfield);
        ck('  the left column is date, invoice, customer',
           colOf(0).join(',') === 'date,invoice_no,customer', colOf(0).join(','));
        ck('  the right column is booking, container, seal',
           colOf(1).join(',') === 'booking_no,container_no,seal_no', colOf(1).join(','));
        ck('    both stacked vertically',
           [0, 1].every((i) => /flex-direction:\s*column/.test(wrap.children[i].getAttribute('style') || '')),
           'a row of three is not a stack');
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
    // The bundle number is a row LABEL, not one of the three weight columns
    // she named — it says WHICH bale a weight belongs to.
    ck('  there is a # column for the bundle number',
       /<div>#<\/div>/.test(DOCS), 'a bale-by-bale list with no bale numbers is a column of figures');
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

    // Apsara, 2026-09-16: "Why the gross,tare,net box kength is more?" —
    // three 1fr columns stretched to fill the panel, so a six-character weight
    // got a ~330px box. Fixed widths, and the row is left-aligned so the
    // leftover width stays as white space instead of being shared out.
    {
        const headEl = d.getElementById('pkItems').firstElementChild;
        const rowEl = headEl && headEl.nextElementSibling;
        const styleOf = (el) => (el && el.getAttribute('style')) || '';
        // 52px for the bundle number, then three fixed weight columns. Fixed,
        // not 1fr — a fractional column grows to fill the panel, which is why
        // a six-character weight had a ~330px box.
        ck('  the weight boxes are a fixed width, not stretched',
           /grid-template-columns:52px 130px 130px 130px/.test(styleOf(headEl)), styleOf(headEl).slice(0, 140));
        ck('    and the row does not share out the leftover width',
           /justify-content:start/.test(styleOf(rowEl)),
           '1fr columns grow to fill the panel however wide it is');
        ck('    with the headings over the boxes they label',
           styleOf(headEl).includes('grid-template-columns:52px 130px 130px 130px')
           && styleOf(rowEl).includes('grid-template-columns:52px 130px 130px 130px'),
           'the heading row and the input rows must use the SAME track list');
    }

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

// ══════════════════════════════════════════════════════════════════════════
section('E — Generate hands her the FILE');
// ══════════════════════════════════════════════════════════════════════════
{
    // Apsara, 2026-09-16: "saved as HMMU7060866_packing.pdf. BUT ITS NOT
    // DOWNLOADED ON CLICKING GENERATE".
    //
    // The route saved the PDF into the archive and reported a filename. A
    // filename is an inventory number; she wanted the document. The BOL had
    // the identical complaint earlier the same day and was fixed then — I did
    // not carry that across when I built this panel, which is the "think
    // about its impact in other folder" instruction failing in the other
    // direction: not a change that broke something else, a fix that never
    // travelled.
    //
    // ── WHY THIS IS TWO SECTIONS AND NOT ONE ─────────────────────────────
    // E1 drives the button and asserts a download is triggered. That alone
    // would pass with the wrong query string, because the stub answers
    // anything. E2 takes the URL E1 actually built and resolves it against
    // the REAL archive, with a REAL file written by saveInvoiceCopy. A
    // packing list is filed under kind=invoice/<date>/<container>/, three
    // keys — one wrong and it is a 404, and a 404 here means "Saved as …,
    // but the download did not start" on every single generate.
    const dom = new JSDOM(DOCS, { runScripts: 'dangerously', url: 'http://localhost/documents',
        beforeParse(w) {
            w.alert = () => {}; w.confirm = () => true;
            w.URL.createObjectURL = () => 'blob:stub';   // jsdom has neither
            w.URL.revokeObjectURL = () => {};
            w.__downloads = [];
            w.__fetched = [];
            w.fetch = (url, opts) => {
                w.__fetched.push(String(url));
                if (String(url).includes('/api/packing-lists/generate')) {
                    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({
                        ok: true, saved_filename: 'HMMU7060866_packing.pdf',
                        saved_date: '2026-09-16', saved_container: 'HMMU7060866', warnings: [],
                    }) });
                }
                if (String(url).includes('/api/documents/download')) {
                    return Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve({ size: 4096 }) });
                }
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, packing_lists: [], bols: [] }) });
            };
        } });
    await new Promise((r) => setTimeout(r, 400));
    const w = dom.window, d = w.document;
    // The click that matters, recorded at the prototype: the code builds the
    // <a>, clicks it and removes it inside one function, so there is no
    // element left in the DOM to find afterwards.
    const clicked = [];
    w.HTMLAnchorElement.prototype.click = function () { clicked.push({ href: this.href, download: this.download }); };

    [...d.querySelectorAll('.subtab-btn')].find((b) => b.dataset.subtab === 'packing')
        .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));

    d.getElementById('pk_container').value = 'HMMU7060866';
    d.getElementById('pk_invoice').value = '260819_AC_26JY95';
    // Through the input event, not by poking pkRows: that is a top-level
    // `let` and therefore NOT a window property — the seventh time this
    // project has been caught by that, so this file does not test it that way.
    // data-pf, not data-pk. The first version of this line had the wrong
    // attribute and fell through to "the first input in row 0" — which is the
    // NOTE box. It passed anyway, because until hasWeight landed a row with
    // only a note (and the default tare "0") still counted as a row. A test
    // that passes by luck keeps passing when the thing under it breaks.
    const gross = d.querySelector('#pkItems input[data-pi="0"][data-pf="gross_weight_lbs"]');
    if (!gross) throw new Error('no gross box in row 0');
    gross.value = '3599';
    gross.dispatchEvent(new w.Event('input', { bubbles: true }));

    d.getElementById('btnPkGenerate').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));

    const status = d.getElementById('pkStatus').textContent;
    ck('clicking Generate downloads the PDF', clicked.length === 1,
       `${clicked.length} downloads — status said "${status}"`);
    ck('  under the name it was filed as',
       clicked.length === 1 && clicked[0].download === 'HMMU7060866_packing.pdf',
       clicked.length ? clicked[0].download : 'nothing was clicked');
    ck('  and it says so, not just "saved"', /download/i.test(status), status);

    const dl = w.__fetched.find((u) => u.includes('/api/documents/download')) || '';
    ck('  fetched back out of the archive', !!dl,
       'returning the bytes from generate would hand her a file nobody has proved the archive can read back');
    ck('    as kind=invoice', /kind=invoice/.test(dl), dl);
    ck('    with the container', /container=HMMU7060866/.test(dl), dl);
    ck('    and the date it was filed under', /date=2026-09-16/.test(dl), dl);

    // ── AND THE ARCHIVE AGREES ───────────────────────────────────────────
    // The URL the page just built, resolved against the real thing.
    const docsSaved = require(path.join(ROOT, 'helpers/documentsSaved'));
    const written = docsSaved.saveInvoiceCopy(
        Buffer.from('%PDF-1.4 stub'), 'HMMU7060866_packing.pdf', 'HMMU7060866', '2026-09-16');
    ck('  the file really is filed in the invoice archive', fs.existsSync(written), written);
    const q = Object.fromEntries([...new w.URLSearchParams(dl.split('?')[1] || '')]);
    const resolved = docsSaved.resolveSavedPath({
        kind: q.kind, filename: q.file, date: q.date, container: q.container });
    ck('  and THAT query string resolves to it', resolved === written,
       `${resolved} !== ${written} — the download 404s and every generate reports a failure`);

    // A packing list is not a BOL: the bol archive has no container level, so
    // the BOL's own two-key query would land in the wrong tree entirely.
    ck('    which the BOL\'s query would NOT have done',
       !docsSaved.resolveSavedPath({ kind: 'bol', filename: q.file, date: q.date }),
       'copying bolDownload verbatim would have looked right and 404d');

    dom.window.close();
}

// ══════════════════════════════════════════════════════════════════════════
section('F — three items in one container');
// ══════════════════════════════════════════════════════════════════════════
{
    // Apsara, 2026-09-16: "sometimes i will have 3 different items in a
    // container..for eg:alternator,starter,ac compressor.each with separate
    // gross,net,tare overall total gross,net,tare and adding those
    // gross,net,tare --->overall for the container..on the right side of
    // booking number,add a item description text box.give a check box as show
    // item in grid-next to s.no in grid,item should come".
    //
    // ── WHAT THIS ACTUALLY CHANGED ───────────────────────────────────────
    // A ROW STOPPED BEING A CONTAINER. It was already not one — her
    // handwritten tally is fifteen rows for one container — but nothing in
    // the code said so, and two things quietly assumed the old shape:
    //
    //   the TOTAL row, which printed only a net and left gross and tare
    //   blank (harmless on one row, a missing answer on three), and
    //
    //   compareToInvoice, which checked EVERY ROW against the container's
    //   invoice line and would have warned three times, all three wrong.
    //
    // Section A2's fifteen-bundle tally is the same shape, so the second of
    // those was live before she asked for any of this.
    const iv2 = require(path.join(ROOT, 'helpers/invoiceVersions'));
    await iv2.saveInvoiceVersion('HMMU7060866', {
        inv_no: 'PL-3ITEM', container_no: 'HMMU7060866', consignee: 'Eccomelt Inc',
        line_items: [{ container_no: 'HMMU7060866', weight: '6.123',
            packing: { net_weight_lbs: '13,500', net_weight_mt: '6.123' } }],
    });

    const threeItems = {
        container_no: 'HMMU7060866', invoice_no: 'PL-3ITEM', show_item_in_grid: true,
        rows: [
            { item: 'Alternator',    gross_weight_lbs: '6,000', tare_lbs: '600', net_weight_mt: '2.449' },
            { item: 'Starter',       gross_weight_lbs: '5,000', tare_lbs: '500', net_weight_mt: '2.041' },
            { item: 'AC compressor', gross_weight_lbs: '4,000', tare_lbs: '400', net_weight_mt: '1.633' },
        ],
    };

    // ── THE OVERALL FIGURE ───────────────────────────────────────────────
    const t = pl.totalsOf(threeItems.rows);
    ck('three items add up to one container', t.gross === 15000 && t.tare === 1500 && t.net === 13500,
       JSON.stringify(t));
    ck('  and the net total is the sum of the DERIVED nets',
       t.net === threeItems.rows.reduce((a, r) => a + pl.netOf(r), 0),
       'a total taken from stored strings can disagree with the column above it');
    ck('  nothing to add gives null, not 0',
       pl.totalsOf([]).gross === null && pl.totalsOf([{}]).net === null,
       'a printed 0 claims a container that weighed nothing');
    ck('  and one container can be picked out of a list covering several',
       pl.totalsOf([{ container_no: 'AAAU1', gross_weight_lbs: '10' },
                    { container_no: 'BBBU2', gross_weight_lbs: '90' }], 'bbbu 2').gross === 90,
       'spacing and case differ on every carrier document');

    // ── THE PRINTED TABLE ────────────────────────────────────────────────
    // COUNTED, not eyeballed. A TOTAL row with the wrong number of cells does
    // not error — it SHEARS, sliding every figure one column left so the nets
    // print under the wrong headings on the page a customer checks with a
    // calculator. The column count now depends on a checkbox, which is exactly
    // when that goes wrong.
    const tableOf = (html) => {
        const d = html.slice(html.indexOf('<div class="doc-packing">'));
        const tbl = d.slice(d.indexOf('<table'), d.indexOf('</table>'));
        return [...tbl.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/g)].map((m) =>
            [...m[0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)]
                .map((c) => c[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()));
    };

    let shown = null;
    await pl.generatePdf(threeItems, { renderer: async (html) => { shown = tableOf(html); return { packing: Buffer.from('x') }; } });
    ck('every row of the printed table has the same number of cells',
       new Set(shown.map((r) => r.length)).size === 1,
       shown.map((r) => r.length).join(',') + ' — a TOTAL row with the wrong count SHEARS, it does not error');
    ck('  six columns when the item is shown', shown[0].length === 6, shown[0].join(' | '));
    ck('  headed Container, Item, Gross, Tare, Net, Net',
       /Item/.test(shown[0][1]) && /Gross/.test(shown[0][2]), shown[0].join(' | '));
    ck('  each item on its own line', shown[1][1] === 'Alternator' && shown[3][1] === 'AC compressor',
       shown.slice(1, 4).map((r) => r[1]).join(' / '));

    const total = shown[shown.length - 1];
    ck('the TOTAL row carries gross, tare AND net', total[0] === 'TOTAL'
       && total[2] === '15,000' && total[3] === '1,500' && total[4] === '13,500',
       total.join(' | ') + ' — gross and tare used to print as blank cells');
    ck('  and the MT total', total[5] === '6.123', total.join(' | '));

    // ── AND WITHOUT THE CHECKBOX, NOTHING MOVED ──────────────────────────
    // An invoice generated through "Separate invoice & packing list" prints
    // the same five columns it has printed since 2026-09-09. A screen growing
    // a checkbox must not reshape a document nothing on this path asked to
    // change.
    let plain = null;
    await pl.generatePdf({ ...threeItems, show_item_in_grid: false, item_description: 'Auto parts' },
        { renderer: async (html) => { plain = { t: tableOf(html), html }; return { packing: Buffer.from('x') }; } });
    ck('unticked, the table is five columns as before',
       new Set(plain.t.map((r) => r.length)).size === 1 && plain.t[0].length === 5,
       plain.t.map((r) => r.length).join(','));
    ck('  and the totals are still right', plain.t[plain.t.length - 1].slice(1).join('|') === '15,000|1,500|13,500|6.123',
       plain.t[plain.t.length - 1].join(' | '));
    // Her answer when asked where the single description should go: "Printed
    // above the packing table".
    ck('  the one item description prints above the table', /Item: Auto parts/.test(plain.html),
       'she typed it into the form; a document that silently drops it is worse than a redundant line');
    ck('    above, not inside it',
       plain.html.indexOf('Item: Auto parts') < plain.html.indexOf('{{packing_rows}}'.replace('{{', '').replace('}}', ''))
       || plain.html.indexOf('Item: Auto parts') < plain.html.slice(plain.html.indexOf('<div class="doc-packing">')).indexOf('<table') + plain.html.indexOf('<div class="doc-packing">'),
       'a description below the weights reads as a footnote');
    ck('  and an empty one prints nothing at all',
       !/Item:\s*</.test(plain.html.replace(/Item: Auto parts/, '')),
       'a label with nothing after it looks like a field that failed to fill');

    // ── AND A BLANK ROW NEVER REACHES THE PAPER ──────────────────────────
    // The form opens with empty rows carrying tare "0". Before hasWeight they
    // printed as "- | 0 | 0 | 0.000" under her real weights.
    let withBlank = null;
    await pl.generatePdf({ ...threeItems, rows: [...threeItems.rows, { tare_lbs: '0' }, { item: 'Radiator' }] },
        { renderer: async (html) => { withBlank = tableOf(html); return { packing: Buffer.from('x') }; } });
    ck('a blank row does not print', withBlank.length === shown.length,
       `${withBlank.length} rows vs ${shown.length} — "- | 0 | 0 | 0.000" on a customer's packing list`);
    ck('  and neither does an item with no weighing behind it',
       !withBlank.some((r) => r[1] === 'Radiator'),
       withBlank.map((r) => r[1]).join(' / '));

    // ── THE WARNING IS PER CONTAINER, NOT PER ROW ────────────────────────
    ck('three items that add up to the invoice warn about NOTHING',
       pl.compareToInvoice(threeItems).length === 0,
       JSON.stringify(pl.compareToInvoice(threeItems)) + ' — row-by-row this was three warnings, every one of them wrong');

    const off = JSON.parse(JSON.stringify(threeItems));
    off.rows[1].gross_weight_lbs = '5,900';   // +900 on the container
    const w2 = pl.compareToInvoice(off);
    ck('  but a container total that is out IS flagged, once', w2.length === 1, JSON.stringify(w2));
    ck('    with the container total, not one row\'s figure',
       w2[0] && /14,400/.test(w2[0].message), w2[0] && w2[0].message);
    ck('    and says how many lines were added up',
       w2[0] && /3 lines added up/.test(w2[0].message), w2[0] && w2[0].message);

    // The fifteen-bundle tally from section A2 is the same shape, and was
    // being warned about fifteen times before this.
    const tally15 = { container_no: 'HMMU7060866', rows: TALLY_WEIGHTS.map((v) => ({ gross_weight_lbs: String(v) })) };
    const w15 = pl.compareToInvoice(tally15);
    ck('  a fifteen-bundle tally produces ONE warning, not fifteen', w15.length === 1,
       `${w15.length} — a warning list that is wrong every time is one she learns to scroll past`);
    ck('    quoting 61,530, the whole container', w15[0] && /61,530/.test(w15[0].message),
       w15[0] && w15[0].message);
}

// ══════════════════════════════════════════════════════════════════════════
section('G — the item column on the screen');
// ══════════════════════════════════════════════════════════════════════════
{
    const dom = new JSDOM(DOCS, { runScripts: 'dangerously', url: 'http://localhost/documents',
        beforeParse(w) {
            w.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, packing_lists: [], bols: [] }) });
            w.alert = () => {}; w.confirm = () => true;
        } });
    await new Promise((r) => setTimeout(r, 400));
    const w = dom.window, d = w.document;
    [...d.querySelectorAll('.subtab-btn')].find((b) => b.dataset.subtab === 'packing')
        .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));

    // "on the right side of booking number,add a item description text box"
    ck('there is an item description box', !!d.getElementById('pk_item_desc'));
    const cols = [...d.querySelector('#panelPacking [data-pkfield="date"]').parentElement.parentElement.children];
    ck('  to the RIGHT of the booking number column', cols.length === 3
       && [...cols[2].querySelectorAll('[data-pkfield]')].some((e) => e.dataset.pkfield === 'item_description'),
       `${cols.length} columns`);
    ck('there is a "show item in grid" checkbox', !!d.getElementById('pk_show_item'));
    ck('  off by default', d.getElementById('pk_show_item').checked === false,
       'one item per container is the ordinary case; a column of blanks is not');

    // ── THE HEADING AND THE ROWS COME FROM ONE CALL ──────────────────────
    // The grid is CSS columns, so a heading built from a different column
    // count than the inputs does not error — the labels simply sit over the
    // wrong boxes, and she types a tare into Gross.
    const headCells = () => [...d.querySelector('#pkItems > div').children].map((c) => c.textContent.trim());
    const gridOf = (n) => (d.querySelectorAll('#pkItems > div')[n].getAttribute('style')
        .match(/grid-template-columns:([^;]*)/) || [, ''])[1].trim().split(/\s+/);

    ck('unticked: # then the three weights', headCells().join(',') === '#,Gross,Tare,Net,',
       headCells().join(','));
    ck('  and the heading grid matches a row exactly',
       gridOf(0).join(' ') === gridOf(1).join(' '), `${gridOf(0).join(' ')} vs ${gridOf(1).join(' ')}`);

    const cb = d.getElementById('pk_show_item');
    cb.checked = true; cb.dispatchEvent(new w.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));

    // "next to s.no in grid,item should come" — between the line number and
    // the weights, not tacked on the end.
    ck('ticked: Item appears right after #', headCells().join(',') === '#,Item,Gross,Tare,Net,',
       headCells().join(','));
    ck('  the heading and the rows still agree',
       gridOf(0).join(' ') === gridOf(1).join(' '), `${gridOf(0).join(' ')} vs ${gridOf(1).join(' ')}`);
    // ── AND THE WIDE COLUMN IS THE ONE HOLDING THE NAME ──────────────────
    // The cells are laid out by CSS grid, so their ORDER in the markup and
    // their WIDTHS are two separate statements that can disagree. Adding the
    // item's width at the end of the template instead of after the line
    // number leaves the markup reading "# | Item | Gross" while the boxes are
    // sized 52 | 130 | 130 | 130 | 190 — an "Alternator" box the size of a
    // weight, and a Net box big enough for a sentence. Nothing errors and the
    // heading check above still passes, so it is asserted directly.
    ck('    and it is the SECOND column that is wide',
       gridOf(1)[1] === '190px', gridOf(1).join(' '));
    ck('  and every row got an item box',
       [...d.querySelectorAll('#pkItems input[data-pf="item"]')].length === d.querySelectorAll('#pkItems > div').length - 1,
       'one heading plus one box per row');

    // Typing goes to the row, and the payload carries both settings.
    const it = d.querySelector('#pkItems input[data-pi="0"][data-pf="item"]');
    it.value = 'Alternator'; it.dispatchEvent(new w.Event('input', { bubbles: true }));
    const g = d.querySelector('#pkItems input[data-pi="0"][data-pf="gross_weight_lbs"]');
    g.value = '6000'; g.dispatchEvent(new w.Event('input', { bubbles: true }));
    d.getElementById('pk_item_desc').value = 'Auto parts';
    const payload = w.eval('pkPayload()');
    ck('the item reaches the payload', payload.rows[0] && payload.rows[0].item === 'Alternator',
       JSON.stringify(payload.rows[0]));
    ck('  along with the checkbox', payload.show_item_in_grid === true, String(payload.show_item_in_grid));
    ck('  and the header description', payload.item_description === 'Auto parts', payload.item_description);

    // ── THE BLANK ROW THAT WAS BEING FILED ───────────────────────────────
    // THE BUG THIS SECTION FOUND. The form opens with two empty rows, and
    // since tare started defaulting to "0" this morning, "does any weight
    // column have a value" was TRUE for both of them. So a packing list with
    // one weighing on it filed two rows and PRINTED the empty one, as
    // "- | 0 | 0 | 0.000", on the document a customer receives.
    //
    // Nothing in the suite noticed: every fixture in this file builds its own
    // rows, so no test had ever been through the screen's own blank row.
    ck('an untouched blank row is NOT filed', w.eval('pkPayload()').rows.length === 1,
       JSON.stringify(w.eval('pkPayload()').rows) + ' — tare "0" made every empty row look real');

    // But a name she typed ahead of the scale ticket is hers. Kept, so nothing
    // she typed is lost; not printed, which is helpers/packingList.js's
    // hasWeight.
    const it2 = d.querySelector('#pkItems input[data-pi="1"][data-pf="item"]');
    it2.value = 'Starter'; it2.dispatchEvent(new w.Event('input', { bubbles: true }));
    ck('  but a named row with no weight yet is kept',
       w.eval('pkPayload()').rows.length === 2,
       'she names the three items, then weighs them — a save in between must not lose the names');
    ck('    and still does not print',
       pl.hasWeight({ item: 'Starter', tare_lbs: '0' }) === false,
       'an item with no weighing behind it is not a line on a packing list');

    // Untick and the weights must survive — the column is a view, not a store.
    cb.checked = false; cb.dispatchEvent(new w.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    ck('unticking keeps the weights', w.eval('pkPayload()').rows[0].gross_weight_lbs === '6000',
       JSON.stringify(w.eval('pkPayload()').rows[0]));
    ck('  and does not throw the item away either',
       w.eval('pkRows[0].item') === 'Alternator',
       'hiding a column that deletes what is under it is a data loss she cannot see');

    dom.window.close();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }

})().catch((e) => { console.error(e); process.exit(1); });
