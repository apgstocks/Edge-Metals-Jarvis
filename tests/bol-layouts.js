// ── tests/bol-layouts.js ──────────────────────────────────────────────────
// Apsara, 2026-09-16: "For different customer,i can have different field in
// bol .. make the fields drag and drop in website as Design menu then under it
// BOL like canvas website. easy for user to handle it."
//
// EDGE METALS. The BOL is an Edge Metals document; nothing here touches the
// yard, and no figure from one company reaches the other.
//
// ── WHAT THIS FILE IS ACTUALLY GUARDING ─────────────────────────────────────
// Not "can a field be hidden" — that is the easy half and it would pass on a
// build that is dangerous. The three things worth failing over:
//
//   1. A LAYOUT CANNOT PRODUCE AN INVALID BOL. Consignee, BOL number, date and
//      the goods table are not in the optional list at all, and a client that
//      posts them as hidden must get nowhere. She asked for a free canvas and
//      was talked out of it on exactly this ground; if a crafted layout can
//      strip the date off a bill of lading, that argument was wrong.
//
//   2. A MISSING LAYOUT MEANS EVERY FIELD, NEVER NONE. The failure mode of
//      "resolve the layout, render what it says" is a request that fails and a
//      form showing three boxes. She fills them in, generates, and the BOL has
//      no carrier. Every fallback in this feature points at MORE fields.
//
//   3. THE TWO CLIENTS CANNOT DISAGREE. She chose one layout for the website
//      and the app. The server resolves the layout again at generate time from
//      the consignee name, so a phone running an old build cannot print a
//      different document — and that is asserted here rather than assumed.

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-bollayout-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD   = 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = 'staff-pw-ccccccccccc';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('  ABORT  config not isolated'); process.exit(1); }

const L = require(path.join(ROOT, 'helpers/bolLayouts'));
const { buildBolHtml, assertNoUnfilledPlaceholders } = require(path.join(ROOT, 'helpers/bolPdf'));

const DOCS = fs.readFileSync(path.join(ROOT, 'dashboard/documents.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'mobile-app/www/index.html'), 'utf8');
const DESIGN = fs.readFileSync(path.join(ROOT, 'dashboard/design-bol.html'), 'utf8');
// Strips LINE comments and HTML comments only, NOT /* */ blocks.
//
// It used to strip those too, and on 2026-09-16 that silently deleted most of
// dashboard/documents.html: the packing-list upload carries
// accept="image/*,application/pdf", whose /* opens a block comment that the
// next unrelated */ closes, taking everything between them with it. Two
// assertions failed on code that was correct, and they failed by claiming a
// function had vanished.
//
// Safe to drop, because the documentation comments in this project are // and
// <!-- -->; there is no /* */ prose for an assertion to match against.
const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const BOL = {
    bol_no: 'EM-1047', bol_date: '2026-09-16',
    consignee_name: 'Eccomelt', consignee_address: '1 Mill Rd\nRemington, IN',
    po_number: 'PO-55410', appointment_id: 'APT-77213',
    pickup_date: '2026-09-16', pickup_time: '09:30',
    carrier: 'Sher Trucking', driver: 'Miguel Ortiz',
    container_no: 'TCLU1234567', seal_no: '40217',
    weight_unit: 'lb', notes: 'Tarp the load',
    items: [{ description: 'Al combo', pieces: '12', gross_weight: '46300', tare_weight: '4120', net_weight: '42180' }],
};
const labels = (html) => (html.match(/class="lbl">([^<]+)</g) || []).map((s) => s.replace(/.*>/, '').replace('<', ''));

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — a layout cannot make an invalid bill of lading');
// ══════════════════════════════════════════════════════════════════════════
{
    // The whole reason the canvas was argued against. If a crafted layout can
    // strip the date or the consignee off a legal shipping document, then
    // "the frame is not hers to change" is a comment, not a rule.
    const attack = L.sanitise([
        { key: 'consignee', shown: false },
        { key: 'bol_date',  shown: false },
        { key: 'bol_no',    shown: false },
        { key: 'goods',     shown: false },
        { key: 'po_number', shown: true },
    ]);
    const keys = attack.map((f) => f.key);
    // ── THE RULE CHANGED ON 2026-09-16 ───────────────────────────────────
    // Asked whether the required blocks should stay locked in place, she said
    // "Let me move them too." So they are no longer REFUSED by sanitise — they
    // are accepted, placed and resized like anything else. What cannot be done
    // is turn one OFF, and that is now the thing asserted: a layout claiming
    // to hide the consignee gets it back, shown.
    //
    // Placeable and hideable are different properties. Where the consignee
    // sits is a matter of taste; a bill of lading with no consignee on it is
    // not a bill of lading.
    // bol_no left this list on 2026-09-18 — Apsara: "Remove bol number in
    // field box. make it appear on right side of header." It is no longer a
    // layout field at all, which is a STRONGER guarantee than being required:
    // a field that is not in the catalogue cannot be hidden, moved, resized or
    // switched back on, and the header slot that prints it is not part of any
    // layout. The two checks below replace it.
    for (const locked of ['consignee', 'bol_date', 'goods']) {
        const f = attack.find((x) => x.key === locked);
        ck(`a layout claiming to hide ${locked} gets it back`, !!f && f.shown === true,
           JSON.stringify(f));
        ck(`  and ${locked} is flagged required`, !!f && f.required === true);
    }
    ck('the BOL number is not a layout field at all',
       !keys.includes('bol_no'),
       'it is back in the catalogue, so it prints twice — header and box');
    ck('  and nothing in the catalogue offers it',
       !L.OPTIONAL_KEYS.includes('bol_no')
       && !L.REQUIRED_FIELDS.some((f) => f.key === 'bol_no'),
       'the field picker would offer it and re-create the duplicate');

    ck('  while the legitimate part of the same layout is kept',
       attack.find((f) => f.key === 'po_number') && attack.find((f) => f.key === 'po_number').shown === true,
       'rejecting the whole layout over one bad row would lose the seven good ones');

    // Each re-added block lands on a row of ITS OWN. Putting them all on one
    // row was the first version of this and it silently lost the goods table —
    // consignee plus number plus date plus goods is four times twelve columns,
    // and rowsFor trims what does not fit. A block that arrived missing is
    // exactly the one that must not be dropped a second time.
    const reqRows = attack.filter((f) => f.required).map((f) => f.row);
    ck('  and each sits on its own row', new Set(reqRows).size === reqRows.length,
       JSON.stringify(attack.filter((f) => f.required).map((f) => `${f.key}@${f.row}`)));

    // And it must not merely be in the LIST — it must still print.
    const html = buildBolHtml({ ...BOL, layout: attack }).html;
    ck('  and the document still carries its date', labels(html).includes('DATE'), labels(html).join(','));
    ck('  and its consignee', /Eccomelt/.test(html));
    ck('  and its goods', /DESCRIPTION OF GOODS/.test(html) && /42,180/.test(html),
       'the goods table is not a labelled box, so it is checked by its own heading');
    assertNoUnfilledPlaceholders(html);
    ck('  with no placeholder left unfilled', true);
}

// ══════════════════════════════════════════════════════════════════════════
section('B — a missing layout means EVERY field, never none');
// ══════════════════════════════════════════════════════════════════════════
{
    const none = labels(buildBolHtml(BOL).html);
    // PICKUP is ONE box again since 2026-09-18 — Apsara: "pickupdate should
    // be in one ine", reversing the two-box split of 09-16. One layout field
    // throughout, which is why neither change moved anything stored.
    for (const lbl of ['DATE', 'PO NUMBER', 'APPOINTMENT ID', 'PICKUP',
                       'CARRIER', 'DRIVER', 'CONTAINER', 'SEAL']) {
        ck(`no layout still prints ${lbl}`, none.includes(lbl), none.join(','));
    }
    ck('  and an EMPTY layout list does not strip the document either',
       labels(buildBolHtml({ ...BOL, layout: [] }).html).includes('CARRIER'),
       'an empty list is the shape a failed lookup produces');

    // The clients follow the same rule, and it is worth pinning in source
    // because it is a comment-shaped decision that a refactor would quietly
    // reverse: the catch must fall back to showing everything.
    ck('website: an unreachable layout shows every field',
       /bolApplyLayout\(null\)/.test(stripComments(DOCS)),
       'a form that drops Carrier on a timeout produces a BOL nobody notices is wrong');
    ck('app: an unreachable layout shows every field',
       /bolwLayout = null/.test(stripComments(APP)) && /BOLW_FALLBACK = \[/.test(stripComments(APP)));
}

// ══════════════════════════════════════════════════════════════════════════
section('C — what she actually asked for: different customers, different fields');
// ══════════════════════════════════════════════════════════════════════════
{
    await L.saveLayout('Eccomelt', [
        { key: 'po_number', shown: true },
        { key: 'appointment_id', shown: true },
        { key: 'carrier', shown: false },
        { key: 'driver', shown: false },
        { key: 'container_no', shown: false },
        { key: 'seal_no', shown: false },
        { key: 'pickup', shown: false },
        { key: 'notes', shown: false },
    ]);

    const ecco = buildBolHtml({ ...BOL, layout: L.shownFields('Eccomelt') }).html;
    ck("Eccomelt's BOL carries PO and appointment", labels(ecco).includes('PO NUMBER') && labels(ecco).includes('APPOINTMENT ID'));
    ck('  and not the fields she switched off',
       !labels(ecco).includes('CARRIER') && !labels(ecco).includes('SEAL'), labels(ecco).join(','));
    ck('  including Notes, which lives in its own block and is easy to forget',
       !/Tarp the load/.test(ecco),
       'a switch that hides the box but still prints the text is a switch that lies');

    // Another customer, untouched. The point of the whole feature.
    const other = buildBolHtml({ ...BOL, consignee_name: 'Daekwang', layout: L.shownFields('Daekwang') }).html;
    ck('a customer with no layout of their own is unaffected',
       labels(other).includes('CARRIER') && labels(other).includes('SEAL'), labels(other).join(','));

    // ── CASE INSENSITIVITY ───────────────────────────────────────────────
    // Her standing rule, applied here for the same reason as the seller and
    // buyer reports: she types "eccomelt" as often as "Eccomelt", and a
    // layout that silently does not apply is worse than no layout.
    ck('the layout applies however she capitalised the name',
       !labels(buildBolHtml({ ...BOL, layout: L.shownFields('  ECCOMELT ') }).html).includes('CARRIER'),
       'design it for Eccomelt, type eccomelt, get the wrong document');
}

// ══════════════════════════════════════════════════════════════════════════
section('D — fields she names herself');
// ══════════════════════════════════════════════════════════════════════════
{
    await L.saveLayout('Alton', [
        { key: 'custom:gate-code', label: 'Gate code', shown: true, custom: true },
        { key: 'po_number', shown: true },
    ]);
    const html = buildBolHtml({
        ...BOL, consignee_name: 'Alton',
        layout: L.shownFields('Alton'),
        custom_fields: { 'custom:gate-code': '4417' },
    }).html;
    ck('a field she invented prints with her label', labels(html).includes('GATE CODE'), labels(html).join(','));
    ck('  and its value', /4417/.test(html));
    ck('  in the order she put it', labels(html).indexOf('GATE CODE') < labels(html).indexOf('PO NUMBER'),
       labels(html).join(','));

    // An unnamed box on a legal document is not something to print.
    ck('a custom field with no label is dropped',
       !L.sanitise([{ key: 'custom:x', label: '   ', shown: true }]).some((f) => f.key === 'custom:x'));
    // A key the server has never heard of is not guessed at.
    ck('an unknown non-custom key is dropped',
       !L.sanitise([{ key: 'secret_discount', shown: true }]).some((f) => f.key === 'secret_discount'));
    // …and a client one version BEHIND must not delete what it never knew.
    const partial = L.sanitise([{ key: 'po_number', shown: true }]);
    ck('a client that sends only the fields it knows does not delete the rest',
       partial.length === L.OPTIONAL_FIELDS.length + L.REQUIRED_FIELDS.length,
       `${partial.length} vs ${L.OPTIONAL_FIELDS.length} optional + ${L.REQUIRED_FIELDS.length} required — an old client saving would otherwise wipe a field it never knew about`);
    // Optional fields it left out come back HIDDEN — silently turning one on
    // would be its own surprise. REQUIRED blocks come back SHOWN, because a
    // layout that omits the goods table arrived broken and the answer is to
    // put it back, not to print a document without it.
    ck('  optional ones it omitted come back HIDDEN',
       partial.filter((f) => f.key !== 'po_number' && !f.required).every((f) => f.shown === false),
       JSON.stringify(partial.filter((f) => !f.required).map((f) => `${f.key}:${f.shown}`)));
    ck('  and required ones come back SHOWN',
       partial.filter((f) => f.required).every((f) => f.shown === true),
       JSON.stringify(partial.filter((f) => f.required).map((f) => `${f.key}:${f.shown}`)));
}

// ══════════════════════════════════════════════════════════════════════════
section('E — against a real server');
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

    ck('staff cannot read the layouts', [401, 403].includes((await req('GET', '/api/bol-layouts', { sid: staff })).status));
    ck('staff cannot write one',
       [401, 403].includes((await req('PUT', '/api/bol-layouts', { sid: staff, body: { customer: 'X', fields: [] } })).status));

    const cat = (await req('GET', '/api/bol-layouts', { sid: admin })).json || {};
    ck('the catalogue is served to the Design screen',
       (cat.optional || []).length === L.OPTIONAL_FIELDS.length && (cat.required || []).length > 0,
       JSON.stringify((cat.optional || []).map((f) => f.key)));
    // One list of fields, not two. A page with its own hand-typed copy drifts
    // the first time a field is added, and the drift shows up as a switch that
    // does nothing.
    ck('  and the Design page does not keep its own copy of it',
       !/po_number/.test(stripComments(DESIGN)),
       'a second list of fields in a page is a list that will disagree');

    const resolved = (await req('GET', '/api/bol-layouts/resolve?customer=Eccomelt', { sid: admin })).json || {};
    ck('resolve says where the layout came from', resolved.source === 'customer', JSON.stringify(resolved.source));
    const unknown = (await req('GET', '/api/bol-layouts/resolve?customer=Nobody', { sid: admin })).json || {};
    ck('  and says plainly when a customer has none of their own',
       unknown.source !== 'customer' && (unknown.fields || []).length > 0, JSON.stringify(unknown.source));

    // ── THE POINT OF STORING IT SERVER-SIDE ──────────────────────────────
    // She chose one layout for both clients. The proof is that a client which
    // sends NO layout — an old phone — still gets the customer's document,
    // because the server resolves it from the consignee name.
    //
    // The PDF RENDERER is stubbed, not the resolution. Chromium cannot launch
    // in this sandbox (wrong architecture, known since 2026-08), and rendering
    // is not what is under test here: what matters is which layout the route
    // hands the renderer. Capturing that argument is a sharper assertion than
    // reading the finished PDF would be anyway.
    const pdfMod = require(path.join(ROOT, 'helpers/bolPdf'));
    const realGenerate = pdfMod.generateBolPdf;
    let handed = null;
    pdfMod.generateBolPdf = async (data) => { handed = data; return Buffer.from('%PDF-1.4 stub'); };

    const gen = await req('POST', '/api/bol/generate?preview=0', { sid: admin, body: BOL });
    ck('generate succeeds for a customer with a layout', gen.status === 200, JSON.stringify(gen.json));
    ck('  and the SERVER resolved the layout, not the caller',
       handed && Array.isArray(handed.layout) && handed.layout.length > 0,
       JSON.stringify(handed && handed.layout));
    ck('  to the one she designed for this customer',
       handed && !handed.layout.some((f) => f.key === 'carrier' && f.shown !== false),
       JSON.stringify(handed && handed.layout.filter((f) => f.shown !== false).map((f) => f.key)));

    // A client asserting its own layout must get nowhere. The layout is hers
    // to set on the Design screen, not a caller's to send per document —
    // otherwise anything holding a session prints a BOL with whatever fields
    // it likes, which is the hole the whole "server resolves it" design closes.
    handed = null;
    const forced = await req('POST', '/api/bol/generate?preview=0', {
        sid: admin,
        body: { ...BOL, bol_no: 'EM-1048', layout: [{ key: 'seal_no', shown: true }] },
    });
    ck('a layout sent BY the client is ignored', forced.status === 200, JSON.stringify(forced.json));
    // Her two optional fields, plus the required blocks that always print.
    ck('  the document still follows HER layout',
       handed && handed.layout.filter((f) => f.shown !== false && !f.required)
           .map((f) => f.key).join(',') === 'po_number,appointment_id',
       JSON.stringify(handed && handed.layout.filter((f) => f.shown !== false).map((f) => f.key)));
    ck('    with the required blocks alongside, not instead',
       handed && handed.layout.filter((f) => f.required && f.shown !== false).length === L.REQUIRED_FIELDS.length,
       JSON.stringify(handed && handed.layout.filter((f) => f.required).map((f) => f.key)));

    const stored = require(path.join(ROOT, 'helpers/bols')).listBols().find((b) => b.bol_no === 'EM-1048');
    ck('  and the stored record keeps no client-sent layout',
       stored && stored.layout === undefined,
       'a layout riding along on the record is one that would be replayed on edit');

    pdfMod.generateBolPdf = realGenerate;

    server.close();
}

// ══════════════════════════════════════════════════════════════════════════
section('F — the Design screen, driven');
// ══════════════════════════════════════════════════════════════════════════
{
    // Driven rather than grepped: a reorder handler that renders but never
    // mutates the list looks right in source and loses every drag.
    let put = null;
    const dom = new JSDOM(DESIGN, {
        runScripts: 'dangerously', url: 'http://localhost/design/bol',
        beforeParse(w) {
            w.fetch = (u, o) => {
                const k = String(u).split('?')[0];
                if (o && o.method === 'PUT') { put = JSON.parse(o.body); return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) }); }
                if (k === '/api/bol-layouts') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({
                    ok: true, optional: L.OPTIONAL_FIELDS.map((f) => ({ key: f.key, label: f.label })),
                    required: L.REQUIRED_FIELDS, custom_prefix: 'custom:', layouts: [{ customer: 'Eccomelt' }] }) });
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({
                    ok: true, customer: '', source: 'built-in', fields: L.defaultFields() }) });
            };
            w.confirm = () => true; w.alert = () => {};
        },
    });
    await new Promise((r) => setTimeout(r, 400));
    const w = dom.window;
    const d = w.document;

    // ── THE CANVAS ───────────────────────────────────────────────────────
    // Apsara, 2026-09-16: "what if i want them in different places.change the
    // position and size" — so the field LIST became a twelve-column canvas,
    // and the required blocks became placeable ("Let me move them too").
    const cells = () => [...d.querySelectorAll('.db-cell')];
    const spanOf = (el) => Number((el.getAttribute('style').match(/grid-column:span (\d+)/) || [])[1]);
    const keyOf = (el) => el.dataset.key;

    ck('every field is a box on the canvas',
       cells().length === L.OPTIONAL_FIELDS.length + L.REQUIRED_FIELDS.length,
       `${cells().length} boxes`);
    ck('  laid out in rows', d.querySelectorAll('.db-row-strip').length >= 3,
       `${d.querySelectorAll('.db-row-strip').length} rows`);

    // Required blocks are ON the canvas and DRAGGABLE — that is the change she
    // asked for. What they do not get is a way to be switched off.
    const goods = cells().find((c) => keyOf(c) === 'goods');
    ck('  the goods table is on the canvas', !!goods);
    ck('    and can be dragged like anything else', goods && goods.getAttribute('draggable') === 'true',
       '"Let me move them too" — locking it in place is the thing she overruled');
    ck('    but has no way to be hidden',
       !d.querySelector('.db-cell[data-key="goods"] .db-toggle'),
       'a bill of lading with no goods on it is not a bill of lading');

    // ── SIZE ─────────────────────────────────────────────────────────────
    const consignee = cells().find((c) => keyOf(c) === 'consignee');
    ck('a field starts at the width the document has always used', spanOf(consignee) === 12,
       String(spanOf(consignee)));
    consignee.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
    const widthBtn = (label) => [...d.querySelectorAll('.db-w')].find((b) => b.textContent === label);
    widthBtn('½').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    ck('  and resizing it works',
       spanOf(cells().find((c) => keyOf(c) === 'consignee')) === 6,
       String(spanOf(cells().find((c) => keyOf(c) === 'consignee'))));

    // A floor, not a lock. The consignee block holds a name and three lines of
    // address; a quarter of the page is not a width it can be read at.
    ck('  but it cannot be shrunk past readable', widthBtn('¼').disabled,
       'min_span is a floor — she can resize it, she cannot make it useless');

    // WIDTH BUTTONS AS WELL AS EDGE-DRAGGING, for the same reason the old list
    // had arrows as well as drag: edge-drag does not fire on touch, and she
    // uses an iPad.
    ck('  every box has a resize edge for the mouse',
       cells().every((c) => !!c.querySelector('.db-resize')));
    ck('  and there are width buttons for touch',
       [...d.querySelectorAll('.db-w')].length === 5,
       'five exact divisions of twelve');

    // ── POSITION ─────────────────────────────────────────────────────────
    // Dropping onto a row moves the field there. Driven through the real drop
    // handler rather than by poking the model, because a canvas that renders
    // beautifully and ignores the drop is the failure this is for.
    const zone = [...d.querySelectorAll('.db-cells')][0];
    const seal = cells().find((c) => keyOf(c) === 'seal_no');
    const rowOfSeal = () => [...d.querySelectorAll('.db-cells')]
        .findIndex((z) => [...z.querySelectorAll('.db-cell')].some((c) => keyOf(c) === 'seal_no'));
    const before = rowOfSeal();
    // A real dataTransfer on BOTH events. The first version omitted it on
    // dragstart, so setData threw — and the drag still "worked" only because
    // dragKey is assigned on the line before the throw. A test that passes by
    // luck is one that will keep passing when the handler stops working.
    const dt = () => ({ setData() {}, getData: () => 'seal_no', dropEffect: 'move', effectAllowed: 'move' });
    const start = new w.MouseEvent('dragstart', { bubbles: true });
    start.dataTransfer = dt();
    seal.dispatchEvent(start);
    const drop = new w.MouseEvent('drop', { bubbles: true, cancelable: true });
    drop.dataTransfer = dt();
    zone.dispatchEvent(drop);
    ck('dragging a field to another row moves it', rowOfSeal() === 0 && before !== 0,
       `row ${before} -> ${rowOfSeal()}`);

    // Nothing saves until she says so — unchanged from the field-picker, and
    // more important now that a stray drag can move a box on a legal document.
    ck('nothing has been saved yet', put === null,
       'auto-saving each drag means a stray drag permanently changes a customer document');
    d.getElementById('dbSave').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));
    ck('Save sends the layout', !!put && Array.isArray(put.fields), JSON.stringify(put && Object.keys(put)));
    ck('  carrying row and span for every field',
       put && put.fields.every((f) => Number.isFinite(f.row) && Number.isFinite(f.span)),
       JSON.stringify(put && put.fields.slice(0, 3)));
    ck('  including the resize she made',
       put && put.fields.find((f) => f.key === 'consignee').span === 6,
       JSON.stringify(put && put.fields.find((f) => f.key === 'consignee')));

    dom.window.close();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }

})().catch((e) => { console.error(e); process.exit(1); });
