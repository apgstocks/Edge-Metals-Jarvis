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

    // ── THE OVERRIDE, THROUGH THE REAL ROUTE ─────────────────────────────
    // Apsara, 2026-09-17: "ALwyas test end to end when you add a new feature."
    //
    // The helper checks above prove generatePdf honours allowWithoutInvoice.
    // They cannot prove the ROUTE forwards it, or that the refusal reaches the
    // browser as something it can offer a choice about — which is the whole
    // gap CLAUDE.md rule 3 is about. So this posts to the route the screen
    // actually posts to.
    {
        const noInvBody = { container_no: 'ZZZU9990001', rows: [{ gross_weight_lbs: '1000', tare_lbs: '100' }] };

        const refused = await req('POST', '/api/packing-lists/generate', { sid: admin, body: noInvBody });
        ck('the route refuses a packing list with no invoice', refused.status === 400, String(refused.status));
        ck('  with a code the screen can act on', (refused.json || {}).code === 'NO_INVOICE',
           JSON.stringify(refused.json));
        ck('  AND can_override, which is what turns it into a question',
           (refused.json || {}).can_override === true,
           'the browser cannot tell this apart from a dead end, so it can only show an error');
        ck('  and the sentence names what will be missing',
           /BUYER box empty/i.test((refused.json || {}).error || ''), (refused.json || {}).error);

        // Now with her override. The PDF itself cannot render here — this
        // sandbox has no Chromium — so the proof is that it gets PAST the
        // invoice guard and fails somewhere else entirely. If the route did
        // not forward the flag, this would still be NO_INVOICE.
        const allowed = await req('POST', '/api/packing-lists/generate',
                                  { sid: admin, body: { ...noInvBody, allow_without_invoice: true } });
        ck('the route FORWARDS her override to the helper',
           (allowed.json || {}).code !== 'NO_INVOICE',
           `still NO_INVOICE — the flag never reached generatePdf: ${JSON.stringify(allowed.json)}`);
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
        // On THIS document — the packing list tab's. The invoice's keeps all
        // four; see the block below.
        ck('  the four tare headings are not on the bundle list',
           !/Truck<br>/.test(handed.html) && !/Chassis<br>/.test(handed.html) && !/Boxes<br>/.test(handed.html),
           'a bundle on a scale has one tare and nothing to break out');
        ck('    one Tare instead', /Tare<br>/.test(handed.html));
    }

    // ── AND THE INVOICE'S OWN PACKING LIST IS A DIFFERENT DOCUMENT ───────
    // Apsara, 2026-09-17: "my separate packing list tab needs to have only
    // that while my invoice tab's packing list need to have gross,tare,
    // container,boxes like last time".
    //
    // This check used to assert that an invoice saved before 2026-09-16
    // regenerated with its four tare components SUMMED into one column —
    // which was me applying a message about this screen to her invoice, and
    // is the thing she is correcting. The invoice keeps the four.
    {
        const { buildInvoiceClassicHtml } = require(path.join(ROOT, 'helpers/invoicePdf'));
        const { html } = buildInvoiceClassicHtml({
            inv_no: 'OLD-1', container_no: 'TCLU1234567', consignee: 'Eccomelt Inc',
            line_items: [{ container_no: 'TCLU1234567', weight: '7.620', packing: {
                gross_weight_lbs: '46,300', truck_lbs: '15,000', container_tare_lbs: '8,000',
                chassis_lbs: '6,000', boxes_weight_lbs: '500', net_weight_lbs: '16,800', net_weight_mt: '7.620' } }],
        });
        ck('an invoice prints the tare BROKEN OUT, as it always did',
           /Truck<br>/.test(html) && /Chassis<br>/.test(html) && /Boxes<br>/.test(html),
           'the four components are the working that justifies the net');
        ck('  each component in its own column',
           /15,000/.test(html) && /8,000/.test(html) && /6,000/.test(html) && /500/.test(html));
        ck('  with its gross and net untouched', /46,300/.test(html) && /16,800/.test(html));
        ck('  and no single Tare column on it',
           !/>Tare<br>/.test(html.slice(html.indexOf('<div class="doc-packing">'))),
           'one Tare is the PACKING LIST TAB\'s shape, not the invoice\'s');
    }

    // ── NO INVOICE: A QUESTION, NOT A WALL ───────────────────────────────
    // Apsara, 2026-09-17: "it should not restrict me from generating packing
    // list without invoice. just show warning and ask to override. on accept,
    // proceed with packing list generation".
    //
    // The DEFAULT is unchanged and still refuses — the override has to be
    // asked for, so the warning cannot be skipped by accident. The old check
    // here required the words "Make the invoice first"; that sentence is gone
    // on purpose, because making the invoice is no longer the only way out.
    let err = null;
    try {
        await pl.generatePdf({ container_no: 'NOPE1234567', rows: [{ net_weight_lbs: '1' }] },
                             { renderer: async () => ({ packing: Buffer.from('x') }) });
    } catch (e) { err = e; }
    ck('no invoice for that container still refuses BY DEFAULT', err && err.code === 'NO_INVOICE', String(err && err.code));
    ck('  and offers the override rather than only refusing',
       err && err.canOverride === true && /Generate it anyway\?/.test(err.message), err && err.message);
    ck('  naming what the document will be missing',
       err && /BUYER box empty/i.test(err.message), err && err.message);

    // With a customer typed on the form, the warning says her name will be
    // used — a different sentence, because it is a different document.
    let errNamed = null;
    try {
        await pl.generatePdf({ container_no: 'NOPE1234567', customer: 'Daekwang', rows: [{ net_weight_lbs: '1' }] },
                             { renderer: async () => ({ packing: Buffer.from('x') }) });
    } catch (e) { errNamed = e; }
    ck('  and says whose name it WILL use when she typed one',
       errNamed && /Daekwang as the buyer/.test(errNamed.message), errNamed && errNamed.message);

    // ── ON ACCEPT, IT PROCEEDS ───────────────────────────────────────────
    let overridden = null;
    const overridePdf = await pl.generatePdf(
        { container_no: 'NOPE1234567', customer: 'Daekwang', rows: [{ gross_weight_lbs: '1000', tare_lbs: '100' }] },
        { allowWithoutInvoice: true,
          renderer: async (html) => { overridden = html; return { packing: Buffer.from('%PDF override') }; } });
    ck('the override generates a real document', !!overridePdf && overridePdf.length > 0);
    ck('  and the BUYER box carries the customer off the form, not a blank',
       /Daekwang/.test(overridden || ''),
       'the buyer box printed empty — a packing list to a broker with no buyer on it');
    ck('  and her weights are still on it',
       /1,000/.test(overridden || '') && /900/.test(overridden || ''),
       'the rows did not reach the document');
    ck('  and no template placeholder leaked onto the page',
       !/\{\{/.test(overridden || ''),
       'an unsubstituted {{buyer_name}} printed on a customer document');

    // ── THE ADDRESS COMES FROM THE ADDRESS BOOK ──────────────────────────
    // Apsara, 2026-09-18: "customer address not fetching from address book in
    // packing list". The override shipped a day earlier printed the name and
    // an empty address block — and its warning said so, which was describing
    // the gap rather than closing it.
    {
        const { mutateJson } = require(path.join(ROOT, 'helpers/json'));
        await mutateJson(cfg.ADDRESS_BOOK_FILE, [], () => ([
            { id: 'ab1', aliases: ['Daekwang'], raw: 'DAEKWANG METAL CO LTD\n124 SANDAN-RO, GIMPO-SI\nGYEONGGI-DO, KOREA' },
            // Her real shape: searched by a person's name, printed as the company.
            { id: 'ab2', aliases: ['Joey', 'Taewon'], raw: 'TAEWON METAL\n55 HARBOUR WAY, BUSAN' },
            { id: 'ab3', aliases: ['Metal One'], raw: 'METAL ONE A\n1 A ST' },
            { id: 'ab4', aliases: ['Metal Two'], raw: 'METAL TWO B\n2 B ST' },
        ]));

        const buyerBox = async (customer) => {
            let html = '';
            await pl.generatePdf(
                { container_no: 'ADDRU000001', customer, rows: [{ gross_weight_lbs: '6000', tare_lbs: '500' }] },
                { allowWithoutInvoice: true,
                  renderer: async (h) => { html = h; return { packing: Buffer.from('x') }; } });
            const i = html.indexOf('BUYER');
            return html.slice(i, i + 340).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
        };

        const exact = await buyerBox('Daekwang');
        ck('THE ADDRESS IS FETCHED FROM THE ADDRESS BOOK',
           /124 SANDAN-RO/.test(exact) && /GYEONGGI-DO/.test(exact), exact);
        ck('  and the company name off the entry is the buyer line',
           /DAEKWANG METAL CO LTD/.test(exact), exact);

        // She searches by the person, the document names the company.
        const byAlias = await buyerBox('Taewon');
        ck('  an alias match fetches it too', /55 HARBOUR WAY/.test(byAlias), byAlias);

        // The box is never blank — but NOT because this lookup pads it. The
        // name survives via headerSource.consignee, which invoicePdf falls
        // back to when there are no address lines. Worth stating: a mutation
        // emptying the lookup's fallback changed nothing, which is what
        // showed the padding was redundant.
        const unknown = await buyerBox('Some New Buyer');
        ck('  a buyer not in the book still prints the name she typed',
           /Some New Buyer/.test(unknown), unknown);
        ck('    and that name comes from the consignee, not a padded address',
           /consignee: str\(rec\.customer\)/.test(
               fs.readFileSync(path.join(ROOT, 'helpers/packingList.js'), 'utf8')),
           'the BUYER name now depends on the address lookup padding itself');

        // ── AND IT NEVER GUESSES ─────────────────────────────────────────
        // "Metal" matches two entries. Putting one company's address on
        // another's shipping document is worse than printing no address, and
        // the missing address is visible where a wrong one is not.
        const ambiguous = await buyerBox('Metal');
        ck('  an AMBIGUOUS name gets no address rather than the wrong one',
           !/1 A ST/.test(ambiguous) && !/2 B ST/.test(ambiguous),
           `picked one of two matching buyers: ${ambiguous}`);
        ck('    but still prints what she typed', /Metal/.test(ambiguous), ambiguous);

        // The warning has to describe the document that will actually print.
        let addrErr = null;
        try {
            await pl.generatePdf({ container_no: 'ADDRU000002', customer: 'Daekwang', rows: [{ gross_weight_lbs: '1' }] },
                                 { renderer: async () => ({ packing: Buffer.from('x') }) });
        } catch (e) { addrErr = e; }
        ck('  the warning says the address WILL be carried when it will be',
           addrErr && /address book address/.test(addrErr.message), addrErr && addrErr.message);
        ck('    and does not still promise "no address"',
           addrErr && !/with no address/.test(addrErr.message), addrErr && addrErr.message);

        let noAddrErr = null;
        try {
            await pl.generatePdf({ container_no: 'ADDRU000003', customer: 'Some New Buyer', rows: [{ gross_weight_lbs: '1' }] },
                                 { renderer: async () => ({ packing: Buffer.from('x') }) });
        } catch (e) { noAddrErr = e; }
        ck('  and says they are NOT in the book when they are not',
           noAddrErr && /not in the address book/.test(noAddrErr.message), noAddrErr && noAddrErr.message);
    }

    // A container with no number is still a flat refusal — that one cannot be
    // overridden, because a packing list with no container cannot be filed or
    // found again afterwards.
    let errNoC = null;
    try {
        await pl.generatePdf({ rows: [{ net_weight_lbs: '1' }] },
                             { allowWithoutInvoice: true, renderer: async () => ({ packing: Buffer.from('x') }) });
    } catch (e) { errNoC = e; }
    ck('  the override does NOT excuse a missing container number',
       errNoC && errNoC.code === 'NO_CONTAINER' && errNoC.canOverride !== true,
       String(errNoC && errNoC.code));

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

    // ── LOOK COLUMNS UP BY NAME, NOT BY POSITION ─────────────────────────
    // The Container column is dropped when every row is the same container
    // (Apsara, 2026-09-16: "Why would i need to repeat container number?"), so
    // a table is five columns or six depending on the DATA as well as the
    // checkbox. Every assertion below that counted from the left broke the
    // moment that landed — which is a test-design fault, not a regression:
    // "the Gross column" is what these checks mean, and that is what they
    // should ask for.
    const at = (rows, row, name) => {
        const i = rows[0].findIndex((h) => h.replace(/\s+/g, ' ').startsWith(name));
        return i < 0 ? undefined : rows[row][i];
    };

    let shown = null;
    await pl.generatePdf(threeItems, { renderer: async (html) => { shown = tableOf(html); return { packing: Buffer.from('x') }; } });
    ck('every row of the printed table has the same number of cells',
       new Set(shown.map((r) => r.length)).size === 1,
       shown.map((r) => r.length).join(',') + ' — a TOTAL row with the wrong count SHEARS, it does not error');
    // ── AND THE REPEATED CONTAINER IS GONE ───────────────────────────────
    // Three items in ONE container: the column would have printed
    // HMMU7060866 three times. It is stated once, above the table.
    ck('  no Container column when every row is the same container',
       !shown[0].some((h) => /Container/.test(h)), shown[0].join(' | '));
    // The line number takes the place the container had — Apsara's weigh
    // sheet numbers every bundle and those numbers were not printed at all.
    ck('  a line-number column instead', shown[0][0] === '#', shown[0].join(' | '));
    ck('  six columns: #, Item, Gross, Tare, Net, Net', shown[0].length === 6, shown[0].join(' | '));
    ck('  each item on its own line',
       at(shown, 1, 'Item') === 'Alternator' && at(shown, 3, 'Item') === 'AC compressor',
       shown.slice(1, 4).map((r) => r[0]).join(' / '));

    const last = shown.length - 1;
    ck('the TOTAL row carries gross, tare AND net',
       /TOTAL/.test(shown[last][0])
       && at(shown, last, 'Gross') === '15,000' && at(shown, last, 'Tare') === '1,500'
       && at(shown, last, 'Net Weight (lbs)') === '13,500',
       shown[last].join(' | ') + ' — gross and tare used to print as blank cells');
    ck('  and the MT total', at(shown, last, 'Net Weight (MT)') === '6.123', shown[last].join(' | '));
    // WITH BOTH a line-number column and an Item column, exactly ONE of them
    // may carry the word. The first version printed "TOTAL | TOTAL".
    ck('  and exactly one cell says TOTAL',
       shown[last].filter((c) => /TOTAL/.test(c)).length === 1,
       shown[last].join(' | '));

    // ── AND WITHOUT THE CHECKBOX, NOTHING MOVED ──────────────────────────
    // An invoice generated through "Separate invoice & packing list" prints
    // the same five columns it has printed since 2026-09-09. A screen growing
    // a checkbox must not reshape a document nothing on this path asked to
    // change.
    let plain = null;
    await pl.generatePdf({ ...threeItems, show_item_in_grid: false, item_description: 'Auto parts' },
        { renderer: async (html) => { plain = { t: tableOf(html), html }; return { packing: Buffer.from('x') }; } });
    // Five columns when NOTHING names an item — the fixture's rows carry no
    // item, and the checkbox is off.
    const bare = threeItems.rows.map(({ item, ...r }) => r);
    let plainBare = null;
    await pl.generatePdf({ ...threeItems, show_item_in_grid: false, rows: bare },
        { renderer: async (html) => { plainBare = tableOf(html); return { packing: Buffer.from('x') }; } });
    ck('unticked and unnamed, every row still has the same cell count',
       new Set(plainBare.map((r) => r.length)).size === 1,
       plainBare.map((r) => r.length).join(','));
    ck('  five columns: a line number and the four weights, no repeated Container',
       plainBare[0].length === 5 && plainBare[0][0] === '#'
       && !plainBare[0].some((h) => /Container|Item/.test(h)),
       plainBare[0].join(' | '));
    // ── BUT NAMED ROWS SHOW THE COLUMN WITHOUT THE CHECKBOX ──────────────
    // Apsara, 2026-09-16: "why item description missing in packing list of
    // invoice tab in docs?" — because the column waited for a checkbox that
    // only the packing-list screen has, and an invoice's line items have
    // carried item_desc all along. The column now follows the DATA as well as
    // the box, which is what makes the invoice's own packing list name what is
    // in the container.
    ck('  but rows that name an item show the column anyway',
       plain.t[0].some((h) => /Item/.test(h)),
       plain.t[0].join(' | ') + ' — a packing list that names nothing is the bug she reported');
    ck('  and the totals are still right',
       plainBare[plainBare.length - 1].join('|') === 'TOTAL|15,000|1,500|13,500|6.123',
       plainBare[plainBare.length - 1].join(' | '));
    ck('    with exactly one cell saying TOTAL',
       plainBare[plainBare.length - 1].filter((c) => /TOTAL/.test(c)).length === 1,
       plainBare[plainBare.length - 1].join(' | ') + ' — my first version printed it in two');
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

    // ── EVERY WEIGHT FORMATTED THE SAME WAY ──────────────────────────────
    // A packing list went out with "1111" in Gross beside "1,046" in Net,
    // because gross is copied through as the string she typed while net is
    // derived and formatted. On the same four-figure numbers, one column with
    // separators and one without reads as carelessness.
    let mixed = null;
    await pl.generatePdf({ container_no: 'HMMU7060866', invoice_no: 'PL-3ITEM',
        rows: [{ gross_weight_lbs: '1111', tare_lbs: '65', note: '#1' },
               { gross_weight_lbs: '1228', tare_lbs: '65', note: '#2' }] },
        { renderer: async (html) => { mixed = tableOf(html); return { packing: Buffer.from('x') }; } });
    ck('a gross typed without commas still prints with them',
       at(mixed, 1, 'Gross') === '1,111' && at(mixed, 2, 'Gross') === '1,228',
       `${at(mixed, 1, 'Gross')} beside a net of ${at(mixed, 1, 'Net Weight (lbs)')}`);
    ck('  and her bundle numbers reach the paper',
       mixed[1][0] === '#1' && mixed[2][0] === '#2',
       `${mixed[1][0]} / ${mixed[2][0]} — she numbers every bundle on the weigh sheet`);
    ck('  a row she did not number is numbered by position',
       (await (async () => {
           let t2 = null;
           await pl.generatePdf({ container_no: 'HMMU7060866', invoice_no: 'PL-3ITEM',
               rows: [{ gross_weight_lbs: '1111' }, { gross_weight_lbs: '1228' }] },
               { renderer: async (html) => { t2 = tableOf(html); return { packing: Buffer.from('x') }; } });
           return t2[1][0] === '1' && t2[2][0] === '2';
       })()), 'a position index is presentation, not a claim about anything');

    // ── A NET OF ZERO IS A CLAIM ─────────────────────────────────────────
    // A row with a gross and a tare but no stored net printed "0" beside a
    // gross of 6,000 on the same line.
    ck('a row with weights never prints a net of 0',
       !mixed.slice(1, -1).some((r) => at([mixed[0], r], 1, 'Net Weight (lbs)') === '0'),
       mixed.slice(1, -1).map((r) => r[3]).join(', '));

    // ── AND A BLANK ROW NEVER REACHES THE PAPER ──────────────────────────
    // The form opens with empty rows carrying tare "0". Before hasWeight they
    // printed as "- | 0 | 0 | 0.000" under her real weights.
    let withBlank = null;
    await pl.generatePdf({ ...threeItems, rows: [...threeItems.rows, { tare_lbs: '0' }, { item: 'Radiator' }] },
        { renderer: async (html) => { withBlank = tableOf(html); return { packing: Buffer.from('x') }; } });
    ck('a blank row does not print', withBlank.length === shown.length,
       `${withBlank.length} rows vs ${shown.length} — "- | 0 | 0 | 0.000" on a customer's packing list`);
    ck('  and neither does an item with no weighing behind it',
       !withBlank.some((r) => r[0] === 'Radiator'),
       withBlank.map((r) => r[0]).join(' / '));

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

    // ── A LONG LIST SAYS SO ──────────────────────────────────────────────
    // Apsara, 2026-09-16: "in packing list tab,what if my packing list keep on
    // going to 3 page?" It prints on three pages — forty bundles is forty
    // bundles — and the screen says so before the PDF does.
    ck('a short list says nothing about pages',
       !/several pages/.test(d.getElementById('pkTotals').textContent),
       d.getElementById('pkTotals').textContent);
    w.eval('pkRows = Array.from({length: 20}, (_, i) => ({ note: "#" + (i+1), gross_weight_lbs: "3500", tare_lbs: "0", net_weight_lbs: "3,500" })); pkPaintItems();');
    ck('  a long one warns before the PDF does',
       /several pages/.test(d.getElementById('pkTotals').textContent),
       d.getElementById('pkTotals').textContent);
    ck('    and promises the thing that matters, not a page count',
       /headings repeated/.test(d.getElementById('pkTotals').textContent)
       && !/\b3 pages\b/.test(d.getElementById('pkTotals').textContent),
       'the first page carries the invoice header and later ones do not, so any figure would be wrong half the time');

    dom.window.close();
}

// ══════════════════════════════════════════════════════════════════════════
section('H — "Generate it anyway?" on the screen');
// ══════════════════════════════════════════════════════════════════════════
{
    // Apsara, 2026-09-17: "In packing list generation separate tab-it should
    // not restrict me from generating packing list without invoice. just show
    // warning and ask to override. on accept, proceed with packing list
    // generation".
    //
    // The route returning can_override is worth nothing if the screen shows it
    // as a plain error and stops. This drives the real button.
    let answer = true;          // what she clicks in the dialog
    const asked = [];           // what she was actually shown
    const posts = [];           // every body that reached the route

    const dom = new JSDOM(DOCS, { runScripts: 'dangerously', url: 'http://localhost/documents',
        beforeParse(w) {
            w.alert = () => {};
            w.confirm = (msg) => { asked.push(String(msg)); return answer; };
            w.URL.createObjectURL = () => 'blob:stub';
            w.URL.revokeObjectURL = () => {};
            w.fetch = (url, opts) => {
                const u = String(url);
                if (u.includes('/api/packing-lists/generate')) {
                    const body = JSON.parse((opts && opts.body) || '{}');
                    posts.push(body);
                    // The server's real answer for a container with no invoice
                    // — refused, but with the override on offer.
                    if (!body.allow_without_invoice) {
                        return Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({
                            error: 'No invoice on file for ZZZU9990001. The packing list will print with the BUYER box empty, and no invoice number or date. Generate it anyway?',
                            code: 'NO_INVOICE', can_override: true,
                        }) });
                    }
                    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({
                        ok: true, saved_filename: 'ZZZU9990001_packing.pdf', saved_date: '2026-09-17',
                        saved_container: 'ZZZU9990001',
                        // The shape the route really sends: an OBJECT with a
                        // message, like every other warning. A plain string
                        // here rendered as nothing, which is how that bug was
                        // found.
                        warnings: [{ kind: 'no_invoice', message: 'ZZZU9990001 has no invoice on file, so the buyer details and invoice number come from this form only.' }],
                    }) });
                }
                if (u.includes('/api/documents/download')) {
                    return Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve({ size: 2048 }) });
                }
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, packing_lists: [], bols: [] }) });
            };
        } });
    await new Promise((r) => setTimeout(r, 400));
    const w = dom.window, d = w.document;
    w.HTMLAnchorElement.prototype.click = function () {};

    [...d.querySelectorAll('.subtab-btn')].find((b) => b.dataset.subtab === 'packing')
        .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));

    d.getElementById('pk_container').value = 'ZZZU9990001';
    w.eval('pkRows = [{ note: "#1", gross_weight_lbs: "6000", tare_lbs: "500", net_weight_lbs: "5,500" }]; pkPaintItems();');

    d.getElementById('btnPkGenerate').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));

    ck('she is ASKED rather than just told no', asked.length === 1, `asked ${asked.length} times`);
    ck('  and the question is the server\'s sentence, not one invented here',
       /Generate it anyway\?/.test(asked[0] || '') && /BUYER box empty/i.test(asked[0] || ''),
       asked[0]);
    ck('  it retried after she accepted', posts.length === 2, `${posts.length} posts`);
    ck('  THE RETRY CARRIES THE OVERRIDE',
       posts[1] && posts[1].allow_without_invoice === true,
       'the second attempt was identical to the first, so it was refused again');
    ck('  and the first attempt did NOT carry it',
       posts[0] && !posts[0].allow_without_invoice,
       'the warning was skipped — she never got asked');
    ck('  her rows survived the retry',
       posts[1] && posts[1].rows && posts[1].rows.length === 1
       && posts[1].rows[0].gross_weight_lbs === '6000',
       JSON.stringify(posts[1] && posts[1].rows));
    const pkw = () => d.getElementById('pkWarnings').textContent || '';
    ck('  and the result says it went out without an invoice behind it',
       /without an invoice/i.test(pkw()), pkw());
    ck('  the notice itself is rendered, not an empty warning box',
       /no invoice on file/i.test(pkw()),
       'the message did not render — the route sent a shape the screen does not read');
    ck('  and it does NOT claim a mismatch with an invoice that does not exist',
       !/does not match the invoice/i.test(pkw()),
       pkw());

    // ── AND "NO" MEANS NO ────────────────────────────────────────────────
    answer = false; posts.length = 0; asked.length = 0;
    d.getElementById('btnPkGenerate').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    ck('declining generates nothing', posts.length === 1, `${posts.length} posts — it generated anyway`);
    ck('  and the refusal is left on screen',
       /No invoice on file/i.test(d.getElementById('pkStatus').textContent || ''),
       d.getElementById('pkStatus').textContent);

    dom.window.close();
}

// ══════════════════════════════════════════════════════════════════════════
section('I — the Customer field matches the address book');
// ══════════════════════════════════════════════════════════════════════════
{
    // Apsara, 2026-09-18: "customer address not fetching from address book in
    // packing list".
    //
    // The server looks the address up from whatever name lands in this field,
    // so a name that matches an entry IS the mechanism. It was a plain text
    // box while the proforma and the BOL both matched as she typed — a name
    // that did not happen to match exactly produced a document with no
    // address and nothing on screen said why.
    const dom = new JSDOM(DOCS, { runScripts: 'dangerously', url: 'http://localhost/documents',
        beforeParse(w) {
            w.alert = () => {}; w.confirm = () => true;
            w.URL.createObjectURL = () => 'blob:stub'; w.URL.revokeObjectURL = () => {};
            w.__bookFetches = 0;
            w.fetch = (url) => {
                if (String(url).includes('/api/address-book')) {
                    w.__bookFetches += 1;
                    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([
                        { id: 'ab1', aliases: ['Daekwang'], raw: 'DAEKWANG METAL CO LTD\n124 SANDAN-RO' },
                        { id: 'ab2', aliases: ['Joey', 'Taewon'], raw: 'TAEWON METAL\n55 HARBOUR WAY' },
                        // No id — 27 of her 98 real entries are like this, and
                        // id-matching failed silently for every one of them.
                        { aliases: ['Eccomelt'], raw: 'ECCOMELT 360 INC\n7 ROCHESTER RD' },
                    ]) });
                }
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, packing_lists: [], bols: [] }) });
            };
        } });
    await new Promise((r) => setTimeout(r, 400));
    const w = dom.window, d = w.document;

    // Counted, not inspected. Asserting addressBook.length passed for the
    // wrong reason: the book is loaded once at page load anyway, so removing
    // 'packing' from the refresh list left the check green. The PROPERTY is
    // that entering this tab fetches it AGAIN — that is what stops a contact
    // added on the Address Book page from being invisible here.
    const before = w.__bookFetches;
    [...d.querySelectorAll('.subtab-btn')].find((b) => b.dataset.subtab === 'packing')
        .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));

    ck('opening the packing tab RE-FETCHES the address book',
       w.__bookFetches > before,
       `${before} -> ${w.__bookFetches}: a contact added in the Address Book page stays invisible here`);
    ck('  and it is loaded', w.eval('addressBook.length') === 3);

    const inp = d.getElementById('pk_customer');
    const box = d.getElementById('pkCustomerList');
    ck('the Customer field has a match list at all', !!box,
       'it is still a plain text box — nothing tells her the name has to match');

    inp.value = 'daek';
    inp.dispatchEvent(new w.Event('input', { bubbles: true }));
    ck('typing part of a name offers the match', !box.classList.contains('hidden')
       && /DAEKWANG/i.test(box.textContent), box.textContent);

    // mousedown, not click: the click loses a race with the blur-hide, which
    // is what "consignee not clickable" turned out to be.
    box.querySelector('.autocomplete-item').dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    ck('  picking one fills the field', inp.value === 'Daekwang', inp.value);
    ck('  and closes the list', box.classList.contains('hidden'));

    // Searched by the person, printed as the company.
    inp.value = 'joey';
    inp.dispatchEvent(new w.Event('input', { bubbles: true }));
    box.querySelector('.autocomplete-item').dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    ck('  "Joey/Taewon" fills in the COMPANY, not the person', inp.value === 'Taewon', inp.value);

    // The entry with no id at all.
    inp.value = 'eccom';
    inp.dispatchEvent(new w.Event('input', { bubbles: true }));
    box.querySelector('.autocomplete-item').dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    ck('  an entry with NO id is still selectable', inp.value === 'Eccomelt', inp.value);

    // And it reaches the payload the route reads.
    ck('  and the picked name is what gets sent',
       w.eval('pkPayload().customer') === 'Eccomelt', w.eval('pkPayload().customer'));

    dom.window.close();
}

// ── S. A SUBTOTAL PER ITEM ──────────────────────────────────────────────────
// Apsara, 2026-09-19, after having to ask me what the per-item totals were on
// MSDU2726332: "ADD PER ITEM SUBTOTAL IN PACKING LIST IF DIFFERENT ITEMS
// FOUND".
//
// The fixture IS that document — sixteen bundles, four items, a flat 120lb
// tare each — because a fixture invented to suit the code is the one that
// passes while the real one breaks.
section('S. per-item subtotals on the packing list');
{
    const sTableOf = (html) => {
        const d = html.slice(html.indexOf('<div class="doc-packing">'));
        const tbl = d.slice(d.indexOf('<table'), d.indexOf('</table>'));
        return [...tbl.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/g)].map((m) =>
            [...m[0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)]
                .map((c) => c[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()));
    };
    const col = (rows, name) => rows[0].findIndex((h) => h.replace(/\s+/g, ' ').startsWith(name));
    const render = async (rec) => {
        let t = null;
        await pl.generatePdf(rec, { allowWithoutInvoice: true,
            renderer: async (html) => { t = sTableOf(html); return { packing: Buffer.from('x') }; } });
        return t;
    };
    const REAL = [
        ['Sealed units', 3798], ['Sealed units', 4468], ['Sealed units', 4183], ['Sealed units', 3673],
        ['Alternator', 3933], ['Alternator', 3618], ['Alternator', 3686], ['Alternator', 2700],
        ['starter', 4084], ['starter', 2978],
        ['Electric motor', 3180], ['Electric motor', 3148], ['Electric motor', 3304],
        ['Electric motor', 2261], ['Electric motor', 2297], ['Electric motor', 2842],
    ];
    const recOf = (pairs) => ({
        container_no: 'MSDU2726332', customer: 'Aris Enterprises USA LLC',
        invoice_no: '260918_AP_26Aris02', date: '09/18/2026', item_description: 'Scrap Auto Parts',
        rows: pairs.map(([item, gross], i) => ({
            note: String(i + 1), item, gross_weight_lbs: String(gross), tare_lbs: '120' })),
    });

    const t = await render(recOf(REAL));
    const subs = t.filter((r) => r[0] === 'Subtotal');
    ck('four items give four subtotal rows', subs.length === 4, subs.length + '');
    ck('  each is labelled with its own item, not "Subtotal" alone',
       subs.map((r) => r[col(t, 'Item')]).join('|') === 'Sealed units|Alternator|starter|Electric motor',
       subs.map((r) => r[col(t, 'Item')]).join('|'));

    // ── EVERY FIGURE, AGAINST THE ARITHMETIC AND NOT AGAINST ITSELF ──────
    // Computed here from the fixture rather than pasted from a run, so a
    // change to how the subtotal is built cannot quietly redefine what is
    // correct.
    const groups = [];
    for (const [item, gross] of REAL) {
        const g = groups[groups.length - 1];
        if (g && g.item === item) { g.gross += gross; g.n += 1; }
        else groups.push({ item, gross, n: 1 });
    }
    const fmt = (n) => n.toLocaleString('en-US');
    const wrong = [];
    groups.forEach((g, i) => {
        const r = subs[i];
        const net = g.gross - 120 * g.n;
        const want = { gross: fmt(g.gross), tare: fmt(120 * g.n), net: fmt(net),
                       mt: (net / 2204.62).toFixed(3) };
        const got = { gross: r[col(t, 'Gross')], tare: r[col(t, 'Tare')],
                      net: r[col(t, 'Net Weight (lbs)')], mt: r[col(t, 'Net Weight (MT)')] };
        for (const k of Object.keys(want)) if (want[k] !== got[k]) wrong.push(`${g.item}.${k}: ${got[k]} ≠ ${want[k]}`);
    });
    ck('  and every subtotal figure is gross, tare, net and MT for its own rows',
       wrong.length === 0, wrong.join('; '));

    // The subtotals must reconcile to the TOTAL, or the document contradicts
    // itself in front of a customs broker.
    const totalRow = t.find((r) => r[0] === 'TOTAL');
    const unFmt = (v) => Number(String(v).replace(/,/g, ''));
    ck('  the subtotals add up to the TOTAL row, in lbs',
       subs.reduce((a, r) => a + unFmt(r[col(t, 'Net Weight (lbs)')]), 0) === unFmt(totalRow[col(t, 'Net Weight (lbs)')]),
       'a document that disagrees with itself is worse than one with no subtotals');
    ck('  and in gross', subs.reduce((a, r) => a + unFmt(r[col(t, 'Gross')]), 0) === unFmt(totalRow[col(t, 'Gross')]));

    // A sheared row does not error, it just prints a column short — and the
    // TOTAL row has already done that once on this document.
    ck('  every row still has the same number of cells',
       new Set(t.map((r) => r.length)).size === 1, t.map((r) => r.length).join(','));

    // ── "IF DIFFERENT ITEMS FOUND" — HER CONDITION, LITERALLY ────────────
    const oneItem = await render(recOf(REAL.map(([, g]) => ['Sealed units', g])));
    ck('ONE item gets NO subtotals', !oneItem.some((r) => r[0] === 'Subtotal'),
       'the subtotal and the TOTAL would be the same figures twice, inviting a hunt for the difference');
    ck('  but still gets its TOTAL', !!oneItem.find((r) => r[0] === 'TOTAL'));

    // A run of one is the row restated. Two items, one of which appears once.
    const lone = await render(recOf([['Sealed units', 3798], ['Sealed units', 4468], ['Alternator', 3933]]));
    const loneSubs = lone.filter((r) => r[0] === 'Subtotal');
    ck('an item appearing once gets no subtotal of its own',
       loneSubs.length === 1 && loneSubs[0][col(lone, 'Item')] === 'Sealed units',
       loneSubs.map((r) => r[col(lone, 'Item')]).join('|'));

    // ── AND THE ROWS THEMSELVES ARE UNTOUCHED ───────────────────────────
    // The whole risk of inserting rows into a table is that the existing ones
    // move or change. Sixteen bundles in, sixteen bundles out.
    ck('all sixteen bundle rows are still there, in order',
       t.filter((r) => /^\d+$/.test(r[0])).map((r) => r[0]).join(',')
       === Array.from({ length: 16 }, (_, i) => i + 1).join(','));
}

// ── S2. THE INVOICE'S PACKING LIST IS NOT TOUCHED ───────────────────────────
// The reason this section exists is CLAUDE.md's first entry: "in packing list
// i juxt want gross,tare,net" was about the packing list TAB, was applied to
// the shared template, and her invoice's packing list lost four columns.
//
// Subtotals are gated on `compact`, which ONLY helpers/packingList.js sets.
// The invoice's packing list is one row per CONTAINER — grouping those by
// whatever their item happens to be called would insert rows into the document
// her broker has received for years. Asserted by rendering an invoice whose
// containers DO repeat an item, which is the case that would fire if the gate
// were wrong.
section('S2. the invoice packing list keeps its shape');
{
    const inv = require(path.join(ROOT, 'helpers/invoicePdf'));
    const line = (c, desc, gross) => ({
        container_no: c, seal_no: 'S1', item_desc: desc, weight: 10, rate: 100,
        packing: { gross_weight_lbs: String(gross), truck_lbs: '15000',
                   container_tare_lbs: '8000', chassis_lbs: '6000', boxes_weight_lbs: '500' },
    });
    const invData = {
        inv_no: 'X1', inv_date: '09/18/2026', consignee: 'Aris', booking_no: 'B1',
        line_items: [line('AAAU1111111', 'Sealed units', 44000),
                     line('BBBU2222222', 'Sealed units', 45000),
                     line('CCCU3333333', 'Alternator', 46000)],
    };
    // The HTML builder directly — renderModes launches Chromium, which cannot
    // run in this sandbox (x86 binaries, ARM host), and the markup is what is
    // being asserted about anyway.
    // ── .html, NOT THE RETURN VALUE ─────────────────────────────────────
    // buildInvoiceClassicHtml returns { html, ... }. Testing the object
    // itself, every regex ran against "[object Object]" — so the subtotal
    // check PASSED while asserting nothing at all, sitting right next to a
    // real failure. A check that cannot fail is worse than no check.
    const built = inv.buildInvoiceClassicHtml(invData);
    const html = typeof built === 'string' ? built : (built && built.html);
    ck('the invoice HTML was actually built', typeof html === 'string' && html.length > 1000,
       'every regex below would have run against "[object Object]" and passed');
    ck('an invoice with a repeated item gets NO subtotal rows',
       !!html && !/Subtotal/.test(html),
       'the gate leaked: rows have been inserted into the document her broker checks');
    ck('  and it still breaks the tare into four columns',
       /Truck/.test(html) && /Container Tare/.test(html) && /Chassis/.test(html) && /Boxes/.test(html),
       'this is the exact regression CLAUDE.md opens with');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }

})().catch((e) => { console.error(e); process.exit(1); });
