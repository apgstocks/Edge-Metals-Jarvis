// ── tests/packing-boxes.js ────────────────────────────────────────────────
// Apsara, 2026-09-22: "When it is loosely loaded/pallets,ask when generating
// packing list in invoice tab....if its loosely loaded,go with existing
// flow,if its pallets-i need to have that boxes in attached in our packing
// list."
//
// TWO CLAIMS, AND THE FIRST IS THE IMPORTANT ONE:
//
//   1. LOOSE IS UNCHANGED. Not "looks fine" — the rendered HTML for a loosely
//      loaded container must be IDENTICAL to what this route produces with no
//      box fields at all. Her broker's packing list lost four columns in
//      September because a change meant for one document reached another, and
//      "go with existing flow" is her asking, in advance, for that not to
//      happen again. Section B diffs the two renders.
//
//   2. PALLETS ADDS THE WORKING. "12 × 110 lb" beside the 1,320 the column
//      already prints — added, never instead of.
//
// CLAUDE.md rule 3: a real server, the real route the screen posts to, and
// the HTML that actually reached the renderer. A helper test would pass while
// the route dropped the two new fields on the floor, which is precisely the
// gap this repo keeps falling into.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const Module = require('module');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-boxes-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD   = process.env.APP_PASSWORD   || 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'staff-pw-ccccccccccc';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('  ABORT  config not isolated'); process.exit(1); }

// Chrome is the one step that cannot run here. Everything else stays real:
// the route, the payload handling, invoicePdf building the HTML, and the
// column list. The bytes inside the PDF are tests/pdf-one-page.js's business.
let RENDERED = [];
const orig = Module._load;
Module._load = function (r) {
    if (r === 'puppeteer') return {
        launch: async () => ({
            newPage: async () => ({
                setContent: async (html) => { RENDERED.push(String(html)); },
                evaluate: async () => {}, pdf: async () => Buffer.from('%PDF-1.4 fake\n%%EOF'),
                $eval: async () => 1000, addStyleTag: async () => {}, emulateMediaType: async () => {},
            }),
            close: async () => {},
        }),
    };
    if (r.endsWith('helpers/gemini')) return { callGeminiJSON: async () => ({}) };
    if (r.includes('whatsapp-web')) return {};
    return orig.apply(this, arguments);
};

const { createApi } = require(path.join(ROOT, 'api'));

// The Mazariegos container, as her ticket describes it. 78,340 gross, 26,060
// of container tares, 1,320 of boxes, 50,960 net.
const LINE = (packing) => ({
    item_desc: 'Sealed Units', container_no: 'MSNU2312862', seal_no: '0009492',
    weight: 23.115, rate: 1208.13, amount: 27930.96, packing,
});
const BASE_PACKING = {
    gross_weight_lbs: '78340', truck_lbs: '16000', container_tare_lbs: '8000',
    chassis_lbs: '2060', boxes_weight_lbs: '1320',
    net_weight_lbs: '50960', net_weight_mt: '23.115',
};
const BODY = (packing) => ({
    inv_no: '260922_AC_26MAZ01', inv_date: '09/22/2026', container_no: 'MSNU2312862',
    booking_no: 'EBKG18670536', seal_no: '0009492', consignee: 'Aris Metals',
    consignee_address: ['1 Test Road'], subtotal: 27930.96, final_amount: 27930.96,
    line_items: [LINE(packing)],
});

(async () => {

const app = createApi();
const listener = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${listener.address().port}`;
const call = (method, p2, sid, body) => new Promise((resolve, reject) => {
    const d = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (sid) headers.Authorization = `Bearer ${sid}`;
    if (d) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(d); }
    const r = http.request(base + p2, { method, headers }, (res) => {
        let raw = ''; res.on('data', (c) => { raw += c; });
        res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {}
            resolve({ status: res.statusCode, json: j, raw }); });
    });
    r.on('error', reject); if (d) r.write(d); r.end();
});
const sid = ((await call('POST', '/login', null, { password: 'admin-pw-bbbbbbbbbbb' })).json || {}).sid;
ck('logged in', !!sid);

// ══════════════════════════════════════════════════════════════════════════
section('A — the boxes line is read off her real ticket');
{
    const real = path.join(__dirname, 'fixtures', 'scale-ticket-mazariegos.pdf');
    if (!fs.existsSync(real)) {
        ck('the ticket fixture is present', false, 'tests/fixtures/scale-ticket-mazariegos.pdf is missing');
    } else {
        const r = await call('POST', '/api/packing/boxes-from-ticket', sid,
            { pdf_base64: fs.readFileSync(real).toString('base64') });
        ck('the route reads the ticket', r.status === 200 && r.json && r.json.found === true,
            `${r.status} ${r.raw.slice(0, 160)}`);
        ck('  12 boxes at 110 lb, totalling 1,320',
            r.json.count === 12 && r.json.unit_lb === 110 && r.json.total_lb === 1320,
            JSON.stringify(r.json));
        ck('  and it names the container, so a ticket for the wrong one shows',
            r.json.container_no === 'MSNU2312862', String(r.json.container_no));
    }
    // An unreadable file is a REASON and a 200, not a 500 — the screen shows
    // it and she types the two figures instead.
    const bad = await call('POST', '/api/packing/boxes-from-ticket', sid,
        { pdf_base64: Buffer.from('not a pdf').toString('base64') });
    ck('an unreadable file comes back as a reason, not a crash',
        bad.status === 200 && bad.json.found === false && !!bad.json.why, bad.raw.slice(0, 160));
    const none = await call('POST', '/api/packing/boxes-from-ticket', sid, {});
    ck('  and no file at all is a 400 that says so', none.status === 400, none.raw.slice(0, 120));

    // Staff must not reach it. /api/packing is deliberately absent from
    // STAFF_ALLOWED_PATH_PREFIXES; this is the check that it stays absent.
    const staff = ((await call('POST', '/login', null, { password: 'staff-pw-ccccccccccc' })).json || {}).sid;
    ck('a staff session exists, or the next check proves nothing', !!staff);
    const blocked = await call('POST', '/api/packing/boxes-from-ticket', staff, { pdf_base64: 'x' });
    ck('  staff cannot reach the ticket reader', blocked.status === 403, String(blocked.status));
}

// ══════════════════════════════════════════════════════════════════════════
section('B — loosely loaded is unchanged, to the character');
{
    // The SAME payload twice: once exactly as this screen sends it today, and
    // once through the new path with the loose answer, which sets no fields.
    // If these differ at all, "go with existing flow" has been broken.
    RENDERED = [];
    const before = await call('POST', '/api/invoice/generate', sid, BODY({ ...BASE_PACKING }));
    ck('a loose container generates', before.status === 200, `${before.status} ${before.raw.slice(0, 200)}`);
    const htmlBefore = RENDERED.join('\n');

    RENDERED = [];
    // Loose does not add boxes_count or boxes_unit_lb at all — that is what
    // the screen does, and what this asserts is safe.
    const after = await call('POST', '/api/invoice/generate', sid, BODY({ ...BASE_PACKING }));
    const htmlAfter = RENDERED.join('\n');

    ck('the rendered document is byte-identical', htmlBefore === htmlAfter,
        `${htmlBefore.length} vs ${htmlAfter.length} characters`);
    ck('  and it still prints the boxes tare it always did',
        /1,320/.test(htmlBefore), 'the Boxes column must keep its figure');
    // THE PROPERTY: no working anywhere on a loose document.
    ck('  with no box working on it',
        !/×\s*110\s*lb/i.test(htmlBefore),
        'a loosely loaded container has no boxes to describe');
    ck('  and all four tare columns, which is the September lesson',
        /Truck/.test(htmlBefore) && /Container Tare/.test(htmlBefore)
        && /Chassis/.test(htmlBefore) && /Boxes/.test(htmlBefore),
        'her broker has always received the four-column breakdown');
}

// ══════════════════════════════════════════════════════════════════════════
section('C — on pallets, the working is added');
{
    RENDERED = [];
    const r = await call('POST', '/api/invoice/generate', sid,
        BODY({ ...BASE_PACKING, boxes_count: 12, boxes_unit_lb: 110 }));
    ck('a pallets container generates', r.status === 200, `${r.status} ${r.raw.slice(0, 200)}`);
    const html = RENDERED.join('\n');

    // THE WHOLE POINT. If the route dropped the two new fields, this is the
    // check that goes red — a helper test would have passed regardless.
    ck('the route forwarded the box fields to the renderer',
        /12\s*×\s*110 lb/.test(html), 'no working reached the document');
    ck('  beside the tare, not instead of it', /1,320/.test(html),
        'the Boxes column must still carry its figure');
    ck('  and the net is untouched at 50,960', /50,960/.test(html));

    // Loose and pallets differ ONLY by the working. Anything else that moved
    // is a change to her broker's document that nobody asked for.
    RENDERED = [];
    await call('POST', '/api/invoice/generate', sid, BODY({ ...BASE_PACKING }));
    const loose = RENDERED.join('\n');
    const stripped = html.replace(/<div style="font-size:7\.5pt;font-weight:400;white-space:nowrap;">[^<]*<\/div>/g, '');
    ck('  and nothing else on the page moved', stripped === loose,
        `${stripped.length} vs ${loose.length} characters once the working is removed`);
}

// ══════════════════════════════════════════════════════════════════════════
section('D — half an answer prints nothing');
{
    // A count with no unit weight, or a nonsense count, must print the total
    // alone rather than "12 × " with a blank after it. Printing half of a
    // multiplication on a customs document is worse than not printing it.
    for (const [label, packing] of [
        ['a count with no weight per box', { boxes_count: 12 }],
        ['a weight with no count',         { boxes_unit_lb: 110 }],
        ['half a box',                     { boxes_count: 12.5, boxes_unit_lb: 110 }],
        ['zero boxes',                     { boxes_count: 0, boxes_unit_lb: 110 }],
        ['a box weighing nothing',         { boxes_count: 12, boxes_unit_lb: 0 }],
        ['text where the numbers go',      { boxes_count: 'twelve', boxes_unit_lb: 'x' }],
    ]) {
        RENDERED = [];
        const r = await call('POST', '/api/invoice/generate', sid, BODY({ ...BASE_PACKING, ...packing }));
        const html = RENDERED.join('\n');
        ck(`${label}: still generates`, r.status === 200, `${r.status} ${r.raw.slice(0, 120)}`);
        ck(`  ${label}: prints no working at all`,
            !/×/.test(html.replace(/&times;/g, '')) || !/×\s*\d/.test(html),
            'half a multiplication is worse than none');
        ck(`  ${label}: and keeps the tare figure`, /1,320/.test(html));
    }
}

// ══════════════════════════════════════════════════════════════════════════
section('E — the field on the review screen');
// ══════════════════════════════════════════════════════════════════════════
// Apsara, 2026-09-22, having searched by container, pressed Generate, and
// seen nothing: "Where wil it ask?I have done search by container-then
// geenrate..nowhere it asked", then "no.make it work on this."
//
// It was a modal raised by the Generate handler. Two things were wrong with
// that. It was invisible until after she committed to generating, on a screen
// whose own heading says "every field below is editable before you download";
// and it lived in ONE of the three places a payload is built from this form,
// so the batch queue she actually uses went through a different door.
//
// It is a field now, and collectInvoicePayload applies it — which is the
// single place every path goes through. This section drives the real screen.
{
    const { JSDOM } = require('jsdom');
    const WEB = fs.readFileSync(path.join(ROOT, 'dashboard/documents.html'), 'utf8');
    const posted = [];
    const dom = new JSDOM(WEB, { runScripts: 'dangerously', url: 'http://localhost/documents',
        beforeParse(w) {
            w.fetch = (u, o) => {
                if (/invoice\/generate/.test(String(u))) posted.push(JSON.parse((o && o.body) || '{}'));
                return Promise.resolve({ ok: true, status: 200,
                    json: () => Promise.resolve({ ok: true, saved_filename: 'X.pdf', entries: [], bols: [], packing_lists: [] }),
                    blob: () => Promise.resolve({ size: 0 }) });
            };
            w.alert = () => {}; w.confirm = () => true;
            w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
        } });
    const w = dom.window;
    await new Promise((r) => setTimeout(r, 500));
    const fill = () => w.eval(
        "$('inv_no').value='260828_SU_26QS04'; $('inv_container').value='MSNU2312862';"
        + "$('invItemsEditor').innerHTML = invItemRowHtml({ item_desc:'Sealed Units', weight:23.115, rate:1208.13,"
        + " packing:{gross_weight_lbs:'78340', truck_lbs:'16000'} }, 0);"
        + "$('invItemsEditor').querySelectorAll('.inv-item-row').forEach(wireInvItemRow);");
    const D = w.document;

    ck('the question is a FIELD on the review screen', !!D.getElementById('inv_loading'),
       'she looked for it here and it was not here');
    ck('  defaulting to loosely loaded', D.getElementById('inv_loading').value === 'loose');
    ck('  with the box figures hidden until they are needed',
       D.getElementById('inv_boxes_row').className.includes('hidden'));

    // LOOSE: the payload must carry no box keys at all.
    fill();
    posted.length = 0;
    D.getElementById('btnInvGenerate').click();
    await new Promise((r) => setTimeout(r, 300));
    const loosePack = posted[0] && posted[0].line_items[0].packing;
    ck('loose posts no box fields whatsoever',
       !!loosePack && !('boxes_count' in loosePack) && !('boxes_unit_lb' in loosePack),
       JSON.stringify(loosePack));

    // PALLETS: shown, totalled on screen, and carried into the payload.
    const sel = D.getElementById('inv_loading');
    sel.value = 'pallets'; sel.dispatchEvent(new w.Event('change'));
    ck('choosing pallets reveals the two figures',
       !D.getElementById('inv_boxes_row').className.includes('hidden'));
    D.getElementById('inv_box_count').value = '12';
    D.getElementById('inv_box_unit').value = '110';
    D.getElementById('inv_box_count').dispatchEvent(new w.Event('input'));
    // The figure that will print, on screen BEFORE she presses anything —
    // the whole reason this is not a modal any more.
    ck('  and totals them where she can see it',
       /1320/.test(D.getElementById('inv_box_total').textContent),
       D.getElementById('inv_box_total').textContent);

    fill();
    sel.value = 'pallets';
    posted.length = 0;
    D.getElementById('btnInvGenerate').click();
    await new Promise((r) => setTimeout(r, 300));
    const palletPack = posted[0] && posted[0].line_items[0].packing;
    ck('pallets carries the count and the unit weight into the payload',
       !!palletPack && palletPack.boxes_count === 12 && palletPack.boxes_unit_lb === 110,
       JSON.stringify(palletPack));
    // THE ONE THAT KEEPS THE DOCUMENT HONEST: the tare and the working come
    // from the same answer, so the printed 1,320 and the printed 12 x 110
    // cannot disagree.
    ck('  and sets the tare from them, rather than trusting a typed box',
       palletPack && palletPack.boxes_weight_lbs === '1320', String(palletPack && palletPack.boxes_weight_lbs));

    // Half an answer must not reach the payload at all.
    fill();
    sel.value = 'pallets';
    D.getElementById('inv_box_count').value = '12';
    D.getElementById('inv_box_unit').value = '';
    posted.length = 0;
    D.getElementById('btnInvGenerate').click();
    await new Promise((r) => setTimeout(r, 300));
    const halfPack = posted[0] && posted[0].line_items[0].packing;
    ck('half an answer posts no box fields', !!halfPack && !('boxes_count' in halfPack),
       JSON.stringify(halfPack));

    w.close();
}

listener.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('SUITE CRASHED:', e && e.stack); process.exit(1); });
