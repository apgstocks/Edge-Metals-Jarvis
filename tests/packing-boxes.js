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
// ── THE MAILBOX IS THE ONE THING THAT MUST NOT BE REAL ───────────────────
// Section G exercises "Send by email", and this suite must never be able to
// put a message in a customer's inbox. Every send lands here instead, where
// the checks can read exactly what would have gone.
let SENT = [];
const orig = Module._load;
Module._load = function (r) {
    if (r.endsWith('helpers/gmail') || r === '../helpers/gmail' || r === './helpers/gmail') return {
        getGmailRead: () => ({}), getGmailSenderRead: () => ({}), getGmailWrite: () => ({}),
        getMyEmailAddress: async () => 'apsara@edgemetals.com',
        listMessages: async () => [], getMessage: async () => ({}), getEmailContent: () => ({ body: '' }),
        parseAddressList: () => [], parseEmailDate: (d) => d,
        sendEmail: async (p) => { SENT.push(p); return { id: 'msg_1', threadId: 'th_1' }; },
    };
    if (r.endsWith('helpers/emailThreads')) return { trackSentEmail: async () => {} };
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
    // Strips the working WHEREVER it renders, rather than matching one
    // hard-coded style string — it moved from the Boxes cell to the Item cell
    // on 2026-09-23 ("that 12*120 boxes looks ugly") and this check went red
    // for a change that is purely cosmetic. Anchored on the CONTENT, which is
    // what the check is actually about.
    const stripped = html.replace(/<div style="font-size:7[^"]*">\s*\d[\d,]*\s*\u00d7[^<]*<\/div>/g, '');
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

// ══════════════════════════════════════════════════════════════════════════
section('F — 260831_SU_26EM05, the invoice that billed $13.09');
// ══════════════════════════════════════════════════════════════════════════
// A signed commercial invoice for MSNU1157057 went out reading:
//
//     Quantity 22.571 MT   Rate $0.58   Amount $13.09
//
// for a container worth $28,860.80. Every figure on it was correct — 49,760
// lb net, $0.58 a pound — and the money was wrong by a factor of 2,204
// because the Quantity column was headed MT while the Rate box still held her
// PER POUND price. documents.html created that mismatch itself, silently,
// when she typed the boxes weight: recalcWeights rewrote Quantity into tonnes
// and never touched the rate.
//
// Apsara, 2026-09-23: "If i want to generate inv in lbs?"
//
// So: one unit per invoice, and in pounds nothing converts at all — which is
// also why the printed figures multiply out EXACTLY. 22.571 x any rounded
// per-MT rate is 29 cents off; 49,760 x 0.58 is not.
{
    const EM05 = (units, qty, rate) => ({
        inv_no: '260831_SU_26EM05', inv_date: '09/23/2026', container_no: 'MSNU1157057',
        booking_no: 'EBKG18570295', seal_no: 'UL-8667128', consignee: 'EDGE METALS RECYCLING',
        consignee_address: ['5120 36TH AVE S TAMPA,', 'FL 33619'],
        units,
        line_items: [{ item_desc: 'Sealed Units', container_no: 'MSNU1157057', seal_no: 'UL-8667128',
            weight: qty, rate, amount: qty * rate,
            packing: { gross_weight_lbs: '79100', truck_lbs: '27900',
                       boxes_weight_lbs: '1440', boxes_count: 12, boxes_unit_lb: 120,
                       net_weight_lbs: '49760', net_weight_mt: '22.571' } }],
        subtotal: qty * rate, final_amount: qty * rate,
    });

    // ── IN POUNDS: THE DOCUMENT SHE SHOULD HAVE HAD ──────────────────────
    RENDERED = [];
    const lb = await call('POST', '/api/invoice/generate', sid, EM05('lb', 49760, 0.58));
    ck('a pounds invoice generates', lb.status === 200, `${lb.status} ${lb.raw.slice(0, 200)}`);
    const lbHtml = RENDERED.join('\n');
    ck('  the columns are headed lbs and US$/lb',
       /Quantity<br>lbs/.test(lbHtml) && /Rate<br>US\$\/lb/.test(lbHtml),
       'a heading that disagrees with its figure is the whole bug');
    ck('  the quantity prints as 49,760, not 49760.000',
       /49,760/.test(lbHtml) && !/49760\.000/.test(lbHtml));
    // THE NUMBER THAT MATTERS.
    ck('  and the amount is $28,860.80', /28,860\.80/.test(lbHtml),
       'the container is worth this; the sent invoice said $13.09');
    ck('  with $13.09 nowhere on the page', !/13\.09/.test(lbHtml));
    // The guard must NOT refuse this — quantity equalling net pounds is
    // correct here, and it is the exact shape of this file's flagship error.
    ck('  the weight guard stays quiet on a correct pounds invoice',
       lb.status === 200 && (lb.json.weight_problems || []).length === 0,
       JSON.stringify(lb.json && lb.json.weight_problems));

    // ── AND THE MIRROR MISTAKE IS CAUGHT ─────────────────────────────────
    // Tonnes left in a pounds column under-bills by the same 2204x.
    const wrongWay = await call('POST', '/api/invoice/generate', sid, EM05('lb', 22.571, 0.58));
    ck('tonnes in a pounds column is refused', wrongWay.status === 409,
       `${wrongWay.status} — that invoice would bill $13.09 again`);
    ck('  and named as such',
       ((wrongWay.json || {}).problems || [{}])[0].kind === 'TONNES_IN_LB',
       JSON.stringify((wrongWay.json || {}).problems));

    // ── MT STILL WORKS EXACTLY AS IT DID ─────────────────────────────────
    RENDERED = [];
    const mt = await call('POST', '/api/invoice/generate', sid, EM05('mt', 22.571, 1278.67));
    ck('an MT invoice still generates', mt.status === 200, `${mt.status} ${mt.raw.slice(0, 160)}`);
    const mtHtml = RENDERED.join('\n');
    ck('  headed MT and US$/MT', /Quantity<br>MT/.test(mtHtml) && /Rate<br>US\$\/MT/.test(mtHtml));
    ck('  with three decimals, as it always has', /22\.571/.test(mtHtml));

    // ── AND AN INVOICE MADE BEFORE ANY OF THIS ───────────────────────────
    // No `units` at all. Every document generated before 2026-09-23 is like
    // this, and every one of them is in MT. Falling back to pounds would
    // re-head an old document's tonnes — restating a figure a customer holds.
    RENDERED = [];
    const old = await call('POST', '/api/invoice/generate', sid, (() => {
        const b = EM05('mt', 22.571, 1278.67); delete b.units; return b;
    })());
    ck('an invoice with no unit field still prints MT', old.status === 200
       && /Quantity<br>MT/.test(RENDERED.join('\n')),
       'absent must mean what it has always meant');
}

// ══════════════════════════════════════════════════════════════════════════
section('G — Send by email, from the Documents tab');
// ══════════════════════════════════════════════════════════════════════════
// Apsara, 2026-09-23: "ADD SEND MAIL BUTTON IN INVOICE POST GENERATION".
//
// TWO STOPS. The draft is read first and nothing leaves until she presses
// Send — the shape she chose for the Sale row on 2026-09-19, and it matters
// more here because this is the screen that produced the $13.09 invoice.
//
// The thing this section is really for: SENDING IS THE ONE ACTION THAT
// CANNOT BE TAKEN BACK. Every check below is either "it did not send" or
// "it sent exactly what she read".
{
    // A generated invoice has to be on disk for that container first — the
    // route attaches what it FINDS, never what a browser names.
    RENDERED = [];
    const gen = await call('POST', '/api/invoice/generate', sid, {
        inv_no: '260923_SU_26MAIL1', inv_date: '09/23/2026', container_no: 'MSNU1157057',
        booking_no: 'EBKG18570295', seal_no: 'UL-8667128', consignee: 'Aris Metals',
        consignee_address: ['1 Test Road'], units: 'lb',
        line_items: [{ item_desc: 'Sealed Units', container_no: 'MSNU1157057', weight: 49760, rate: 0.58,
                       amount: 28860.80, packing: { ...BASE_PACKING } }],
        subtotal: 28860.80, final_amount: 28860.80,
    });
    ck('an invoice is generated and filed', gen.status === 200, `${gen.status} ${gen.raw.slice(0, 160)}`);

    // ── STOP ONE: THE DRAFT, WHICH SENDS NOTHING ─────────────────────────
    SENT = [];
    const draft = await call('GET',
        `/api/invoice/draft-mail?container=MSNU1157057&consignee=${encodeURIComponent('Aris Metals')}`, sid);
    ck('the draft route answers', draft.status === 200, `${draft.status} ${draft.raw.slice(0, 200)}`);
    ck('  and it sent NOTHING', SENT.length === 0, `${SENT.length} email(s) left the building`);
    if (draft.json && draft.json.ok) {
        ck('  naming the files it would attach',
           (draft.json.attachments || []).some((n) => /26MAIL1/.test(n)),
           JSON.stringify(draft.json.attachments));
        ck('  with a subject and a body to read',
           !!draft.json.subject && !!draft.json.body, JSON.stringify(draft.json).slice(0, 160));
    } else {
        // No contact on file is a legitimate answer — it must ASK rather than
        // fail, the same way the Sale-row flow does.
        ck('  or it asks for recipients rather than dead-ending',
           draft.json && draft.json.ask_recipients === true, JSON.stringify(draft.json).slice(0, 200));
    }

    // ── AND SENDING WITHOUT CONFIRM IS REFUSED ───────────────────────────
    // The single most important check here. A POST that reaches this route
    // by any route other than her pressing Send must not send.
    SENT = [];
    const noConfirm = await call('POST', '/api/invoice/send', sid, { container: 'MSNU1157057' });
    ck('a send without confirm is refused', noConfirm.status === 400
       && (noConfirm.json || {}).code === 'NOT_CONFIRMED', `${noConfirm.status} ${noConfirm.raw.slice(0, 140)}`);
    ck('  and nothing went', SENT.length === 0, `${SENT.length} sent`);

    const confirmString = await call('POST', '/api/invoice/send', sid,
        { container: 'MSNU1157057', confirm: 'yes please' });
    ck('  nor does a truthy-looking confirm count', confirmString.status === 400,
       'only true or "true" is her saying yes');

    // A container with nothing on disk cannot be sent, and says so.
    SENT = [];
    const nothing = await call('POST', '/api/invoice/send', sid,
        { container: 'ZZZZ0000000', confirm: true });
    ck('a container with no documents is a 409, not a silent success',
       nothing.status === 409, `${nothing.status} ${nothing.raw.slice(0, 140)}`);
    ck('  and still nothing went', SENT.length === 0, `${SENT.length} sent`);

    // ── STOP TWO: WHAT SHE READ IS WHAT GOES ─────────────────────────────
    SENT = [];
    const sent = await call('POST', '/api/invoice/send', sid, {
        container: 'MSNU1157057', consignee: 'Aris Metals', confirm: true,
        recipients: 'buyer@aris.example, accounts@aris.example',
        subject: 'ZZ-EDITED-SUBJECT',
        body: 'Dear Aris Metals,\n\nZZ-EDITED-BODY',
    });
    ck('it sends on her confirmation', sent.status === 200 && SENT.length === 1,
       `${sent.status} ${sent.raw.slice(0, 200)}`);
    if (SENT.length === 1) {
        const m = SENT[0];
        ck('  to the addresses she typed', /buyer@aris\.example/.test(String(m.to)), String(m.to));
        // HER text, not the generated one. "also make the email editable",
        // 2026-09-19 — an edit that is silently discarded is worse than no
        // edit box at all.
        // A string the generated draft could never contain, or this check
        // passes on the draft's own subject and proves nothing — which is
        // exactly what a mutation showed when it discarded her edit.
        ck('  with the subject she edited', /ZZ-EDITED-SUBJECT/.test(m.subject), m.subject);
        ck('  and the body she edited', /ZZ-EDITED-BODY/.test(m.body), String(m.body).slice(0, 90));
        ck('  carrying the generated PDF itself, not just its name',
           (m.attachments || []).length > 0 && (m.attachments || []).every((a) => a.content),
           JSON.stringify((m.attachments || []).map((a) => a.filename)));
    }

    // ── ONLY AN ADMIN MAY EMAIL A CUSTOMER ───────────────────────────────
    // Staff alone is not enough of a check: /api/invoice is absent from
    // STAFF_ALLOWED_PATH_PREFIXES, so staff are refused by the path
    // middleware whether or not the route guards itself. A mutation removing
    // requireAdmin survived against a staff-only test. The ORDINARY user role
    // is what actually exercises the route's own guard.
    const staffSid = ((await call('POST', '/login', null, { password: 'staff-pw-ccccccccccc' })).json || {}).sid;
    const userSid  = ((await call('POST', '/login', null, { password: 'user-pw-aaaaaaaaaaaa' })).json || {}).sid;
    ck('a staff and a plain user session exist, or the next checks prove nothing',
       !!staffSid && !!userSid);
    for (const [who, who_sid] of [['staff', staffSid], ['a plain user', userSid]]) {
        SENT = [];
        const t = await call('POST', '/api/invoice/send', who_sid, { container: 'MSNU1157057', confirm: true });
        ck(`${who} cannot send an invoice to a customer`, t.status === 403, String(t.status));
        ck(`  and nothing went`, SENT.length === 0, `${SENT.length} sent`);
        // The draft leaks the buyer's address and the message; it is admin-only too.
        const d2 = await call('GET', '/api/invoice/draft-mail?container=MSNU1157057', who_sid);
        ck(`  ${who} cannot read the draft either`, d2.status === 403, String(d2.status));
    }
}

listener.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('SUITE CRASHED:', e && e.stack); process.exit(1); });
