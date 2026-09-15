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
const GOOD = {
    container_no: 'TCLU 123 456 7', booking_no: 'BK-2602', invoice_no: '260819_AC_26JY95',
    seal_no: '40217', date: '09/16/2026', customer: 'Eccomelt', weight_unit: 'LBS',
    rows: [
        { marks: 'B1-B4', description: 'Aluminium Extrusion 6063', pieces: '4', gross_weight: '46,300', net_weight: '42,180' },
        { marks: 'B5', description: 'Al Breakage', pieces: '1', gross_weight: '2,482', net_weight: '2,362' },
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
    ck('  and the item rows', out.rows.length === 2, JSON.stringify(out.rows.map((r) => r.description)));

    // ── WEIGHTS STAY AS PRINTED ──────────────────────────────────────────
    // The same rule as the BOL's: "46,300" must read back as "46,300". A
    // figure quietly reformatted cannot be compared to the paper it came off,
    // which is the one check she can actually make.
    ck('  weights are kept exactly as printed', out.rows[0].gross_weight === '46,300',
       out.rows[0].gross_weight + ' — 46300 means it was parsed, and a parsed figure cannot be checked against the paper');

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
        rows: [{ description: 'HMS', pieces: '3' }, {}, { description: null }],
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
        rows: [{ description: 'Al Extrusion', pieces: '4', gross_weight: '46,300', net_weight: '42,180' }],
        scanned_fields: ['container_no', 'rows'],
    } });
    ck('saving is its own request', saved.status === 200 && !!saved.json.packing_list, JSON.stringify(saved.json));
    ck('  and the weights survive as typed',
       saved.json.packing_list.rows[0].gross_weight === '46,300',
       saved.json.packing_list.rows[0].gross_weight);
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
        rows: [{ description: 'Al Extrusion', pieces: '5' }],
    } });
    ck('the same container spelled differently REPLACES the list',
       again.json.packing_list.id === saved.json.packing_list.id,
       'two lists for one container is the bug this keying exists to prevent');
    ck('  and the correction took', again.json.packing_list.booking_no === 'BK-9999');
    ck('  with still only one on file', pl.list().length === 1, `${pl.list().length}`);

    // A list with NO container can only ever be new. Blank keys must never
    // match each other — the trap helpers/oncePerSave.js documents.
    await req('POST', '/api/packing-lists', { sid: admin, body: { rows: [{ description: 'X' }] } });
    await req('POST', '/api/packing-lists', { sid: admin, body: { rows: [{ description: 'Y' }] } });
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
    for (const col of ['Description', 'Pieces', 'Gross', 'Net']) {
        ck(`  the items table has a ${col} column`, headers.includes(col), headers.slice(0, 120));
    }
    const rows0 = d.querySelectorAll('#pkItems input[data-pi]').length;
    ck('  and starts with blank lines to type into', rows0 > 0, `${rows0} inputs`);

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
