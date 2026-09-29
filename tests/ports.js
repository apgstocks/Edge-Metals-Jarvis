// ── tests/ports.js — the ports she has actually used ──────────────────────
//
// Apsara, 2026-09-29: "In port of discharge,save when generated,for say
// Busan,South Korea.Port of loading as Los Angeles,CA.These are jsut
// examples.I want a drop down to be added as i type."
//
// ── WHAT THIS IS REALLY GUARDING ──────────────────────────────────────────
// The obvious build here is a shipped list of world seaports, and it is the
// wrong one. She writes "Busan,South Korea" and "Los Angeles,CA" — her own
// spellings, and those exact strings print on an invoice a customs broker
// reads. A canonical list would offer "Pusan, KR" instead, and she would
// either pick something that does not match her other paperwork or stop using
// the dropdown. So the suggestions ARE her history, and section A holds that
// line: no port appears that she has not typed.
//
// ── AND THE FIELD NAMES, WHICH ARE NOT THE SAME ON BOTH SIDES ─────────────
// An invoice payload calls them port_loading / port_discharge.
// A booking calls them port_of_loading / port_of_discharge.
// Two names for one thing, read by one helper — exactly the sort of detail
// that makes a hand-rolled second reader silently return nothing. Section B
// reads both and would fail if either name were wrong.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ports-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD   = process.env.APP_PASSWORD   || 'user-password-aaa';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-password-bbb';

const ROOT = path.join(__dirname, '..');
const write = (name, v) => fs.writeFileSync(path.join(TMP, name), JSON.stringify(v, null, 1));
const ports = require(path.join(ROOT, 'helpers/ports'));

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — the list is her history, and nothing else');
// ══════════════════════════════════════════════════════════════════════════
{
    write('bookings.json', [
        { booking_no: 'BK1', port_of_loading: 'Los Angeles, CA',
          port_of_discharge: 'Busan, South Korea', created_at: '2026-01-01' },
        { booking_no: 'BK2', port_of_loading: 'LOS ANGELES, CA',
          port_of_discharge: 'Busan, South Korea', created_at: '2026-02-01' },
        { booking_no: 'BK3', port_of_loading: 'Long Beach, CA',
          port_of_discharge: 'Pusan', created_at: '2026-03-01' },
    ]);
    write('invoice_versions.json', {
        HMMU1111111: [{ port_loading: 'Los Angeles, CA',
                        port_discharge: 'Busan, South Korea', saved_at: '2026-09-01' }],
        HMMU2222222: [{ port_loading: 'Houston, TX',
                        port_discharge: 'Nhava Sheva, India', saved_at: '2026-09-15' }],
    });

    const pod = ports.list('discharge').map((e) => e.value);
    const pol = ports.list('loading').map((e) => e.value);

    ck('the ports she typed are offered',
       pod.includes('Busan, South Korea') && pol.includes('Los Angeles, CA'), pod.join(' | '));

    // THE CHECK THIS FILE EXISTS FOR.
    ck('NO port she has never typed is offered',
       !pod.some((v) => /rotterdam|shanghai|singapore|hamburg|felixstowe/i.test(v))
       && !pol.some((v) => /rotterdam|shanghai|singapore|hamburg|felixstowe/i.test(v)),
       `a canonical seaport list would put these here: ${pod.concat(pol).join(' | ')}`);

    // "Pusan" and "Busan, South Korea" are the same place and NOT the same
    // string. Collapsing them would silently drop whichever she used less,
    // and a list that cannot offer what she typed last week is worse than
    // none. Case and spacing only.
    ck('  a different spelling of the same port is kept, not merged',
       pod.includes('Pusan') && pod.includes('Busan, South Korea'), pod.join(' | '));
    ck('  but case and spacing ARE one entry',
       pol.filter((v) => /los angeles/i.test(v)).length === 1,
       pol.filter((v) => /los angeles/i.test(v)).join(' | '));

    // The newest spelling wins the label: the Sept invoice says
    // "Los Angeles, CA", the Feb booking said "LOS ANGELES, CA".
    ck('  and the most recent spelling is the one offered',
       pol.find((v) => /los angeles/i.test(v)) === 'Los Angeles, CA',
       pol.find((v) => /los angeles/i.test(v)));

    // Ordered by use, so the port she ships to every week is first rather
    // than buried under a one-off by alphabet.
    ck('the one she uses most comes first', pod[0] === 'Busan, South Korea', pod.join(' | '));
    ck('  and it counted every use, both sources', ports.list('discharge')[0].uses === 3,
       String(ports.list('discharge')[0].uses));

    // The two sides must not bleed into each other — a port of LOADING
    // offered as a discharge would put Los Angeles on the wrong line of a
    // document a broker reads.
    ck('loading and discharge are separate lists',
       !pod.includes('Houston, TX') && !pol.includes('Busan, South Korea'),
       `pod=${pod.join(',')} pol=${pol.join(',')}`);
}

// ══════════════════════════════════════════════════════════════════════════
section('B — BOTH field names, because the two stores disagree');
// ══════════════════════════════════════════════════════════════════════════
// An invoice payload: port_loading / port_discharge.
// A booking:          port_of_loading / port_of_discharge.
{
    write('bookings.json', [{ booking_no: 'B', port_of_loading: 'ONLY-IN-BOOKINGS',
                              port_of_discharge: 'POD-ONLY-IN-BOOKINGS', created_at: '2026-01-01' }]);
    write('invoice_versions.json', { C: [{ port_loading: 'ONLY-IN-INVOICES',
                                           port_discharge: 'POD-ONLY-IN-INVOICES', saved_at: '2026-01-02' }] });
    const pol = ports.list('loading').map((e) => e.value);
    const pod = ports.list('discharge').map((e) => e.value);
    ck('bookings are read (port_of_loading)', pol.includes('ONLY-IN-BOOKINGS'), pol.join('|'));
    ck('generated invoices are read (port_loading)', pol.includes('ONLY-IN-INVOICES'), pol.join('|'));
    ck('  and the same on the discharge side',
       pod.includes('POD-ONLY-IN-BOOKINGS') && pod.includes('POD-ONLY-IN-INVOICES'), pod.join('|'));

    // Her words were "save when generated" — so an invoice she has generated
    // must be enough on its own, with no booking behind it.
    write('bookings.json', []);
    ck('a generated invoice alone is enough',
       ports.list('discharge').map((e) => e.value).includes('POD-ONLY-IN-INVOICES'));
}

// ══════════════════════════════════════════════════════════════════════════
section('C — typing');
// ══════════════════════════════════════════════════════════════════════════
{
    write('bookings.json', [
        { booking_no: 'BK1', port_of_loading: 'Los Angeles, CA', port_of_discharge: 'Busan, South Korea', created_at: '2026-01-01' },
        { booking_no: 'BK2', port_of_loading: 'Long Beach, CA',  port_of_discharge: 'Nhava Sheva, India', created_at: '2026-02-01' },
        { booking_no: 'BK3', port_of_loading: 'Houston, TX',     port_of_discharge: 'Kaohsiung, Taiwan',  created_at: '2026-03-01' },
    ]);
    write('invoice_versions.json', {});

    const v = (rows) => rows.map((e) => e.value);
    ck('typing the start of a port finds it',
       v(ports.search('discharge', 'bus')).includes('Busan, South Korea'));

    // Substring, not prefix. She types "korea" as readily as "busan", and a
    // prefix-only match would offer nothing for the first.
    ck('  and typing the COUNTRY finds it too',
       v(ports.search('discharge', 'korea')).includes('Busan, South Korea'),
       'a prefix-only match offers nothing for "korea"');
    ck('  case does not matter', v(ports.search('discharge', 'BUSAN')).includes('Busan, South Korea'));

    // A prefix hit is a better guess than a mid-string one and goes first.
    const beach = ports.search('loading', 'long');
    ck('  what she started typing is offered first',
       beach.length && beach[0].value === 'Long Beach, CA', v(beach).join(' | '));

    ck('an empty box offers the whole list', ports.search('loading', '').length === 3,
       String(ports.search('loading', '').length));
    ck('  something she has never typed offers nothing',
       ports.search('discharge', 'rotterdam').length === 0,
       v(ports.search('discharge', 'rotterdam')).join(' | '));

    // A blank port on a booking is not a port.
    write('bookings.json', [{ booking_no: 'X', port_of_loading: '  ', port_of_discharge: null }]);
    write('invoice_versions.json', {});
    ck('blank and null are not offered as ports', ports.list('loading').length === 0
       && ports.list('discharge').length === 0,
       JSON.stringify(ports.list('loading')));
}

// ══════════════════════════════════════════════════════════════════════════
section('D — END TO END, through the real route and the real screen');
// ══════════════════════════════════════════════════════════════════════════
// Apsara, 2026-09-17: "ALwyas test end to end when you add a new feature."
// The helper being right is not the feature working — the route may not
// forward `which`, and the box may ask for a key the route does not read.
{
    const http = require('http');
    write('bookings.json', [
        { booking_no: 'BK1', port_of_loading: 'Los Angeles, CA',
          port_of_discharge: 'Busan, South Korea', created_at: '2026-01-01' },
        { booking_no: 'BK2', port_of_loading: 'Houston, TX',
          port_of_discharge: 'Nhava Sheva, India', created_at: '2026-02-01' },
    ]);
    write('invoice_versions.json', {});

    const { createApi } = require(path.join(ROOT, 'api'));
    const app = createApi();
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = (method, pth, { body, sid } = {}) => new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r2 = http.request(base + pth, { method, headers }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
        });
        r2.on('error', reject); if (data) r2.write(data); r2.end();
    });

    const sid = ((await req('POST', '/login', { body: { password: process.env.ADMIN_PASSWORD } })).json || {}).sid;
    ck('signed in', !!sid);

    const disc = await req('GET', '/api/ports?which=discharge&q=bus', { sid });
    ck('the route answers', disc.status === 200, String(disc.status));
    ck('  with the port she typed',
       (disc.json.ports || []).some((p) => p.value === 'Busan, South Korea'),
       JSON.stringify(disc.json));

    // `which` has to be FORWARDED. If the route ignored it, both boxes would
    // offer the same list and Houston would be offered as a discharge port.
    const load = await req('GET', '/api/ports?which=loading&q=', { sid });
    const loadVals = (load.json.ports || []).map((p) => p.value);
    ck('  and `which` is honoured, not ignored',
       loadVals.includes('Houston, TX') && !loadVals.includes('Busan, South Korea'),
       loadVals.join(' | '));
    ck('  it echoes which side it answered', load.json.which === 'loading', String(load.json.which));

    // A nonsense `which` must not throw — it is a query string, and anything
    // can arrive in one.
    const junk = await req('GET', '/api/ports?which=../../etc&q=', { sid });
    ck('a junk `which` falls back rather than throwing', junk.status === 200
       && junk.json.which === 'discharge', `${junk.status} ${JSON.stringify(junk.json).slice(0, 80)}`);

    await new Promise((r) => server.close(r));
}

// ══════════════════════════════════════════════════════════════════════════
section('E — the boxes on the screen');
// ══════════════════════════════════════════════════════════════════════════
{
    const web = fs.readFileSync(path.join(ROOT, 'dashboard/documents.html'), 'utf8');

    ck('Port of Loading has a suggestion list', /id="invPolList"/.test(web));
    ck('Port of Discharge has one too', /id="invPodList"/.test(web));
    ck('  both wired to the right side',
       /wirePortBox\('inv_pol', 'invPolList', 'loading'\)/.test(web)
       && /wirePortBox\('inv_pod', 'invPodList', 'discharge'\)/.test(web),
       'crossed over, Los Angeles would be offered as a discharge port');

    // The dropdown OFFERS; it must never constrain. A port she has not used
    // before has to be typeable the first time — a <select> here would make
    // a new destination impossible to invoice.
    ck('they are still text boxes, not dropdowns she cannot type into',
       /<input id="inv_pol"/.test(web) && /<input id="inv_pod"/.test(web),
       'a select would make a new port impossible to enter');

    // The positioned parent, or an absolutely-positioned list lands against
    // the page instead of under its own box.
    ck('  each list has a positioned parent to hang from',
       (web.match(/<div class="field" style="position:relative;"><label for="inv_po/g) || []).length === 2,
       'absolute inside a static parent positions against the page');

    // mousedown, not click — the lesson already written up on the consignee
    // box in this same file: a click loses the race against the blur timer,
    // which is what "consignee not clickable" turned out to be.
    const fn = web.slice(web.indexOf('function wirePortBox'), web.indexOf('wirePortBox(\'inv_pol\''));
    ck('picking uses mousedown, not click', /addEventListener\('mousedown'/.test(fn)
       && !/addEventListener\('click'/.test(fn),
       'a click loses the race against the blur timer');
    ck('  and by index, never by parsing the text back',
       /shown\[Number\(el\.dataset\.idx\)\]/.test(fn));
    ck('  out-of-order replies cannot repaint under her cursor',
       /if \(mine !== seq\) return;/.test(fn),
       'a slow answer for "bu" arriving after "busan" would widen the list mid-type');
    ck('  and a failed lookup never blocks typing',
       /catch \(e\) \{ hide\(\); \}/.test(fn));
}

// ══════════════════════════════════════════════════════════════════════════
section('F — GENERATED INVOICES, LISTED AND EDITABLE');
// ══════════════════════════════════════════════════════════════════════════
// Apsara, 2026-09-29, same message: "Generated invoice should be editable.It
// should display below the invoice things.with edit option."
//
// Until now the only way back to a generated invoice was the banner inside
// Review and Generate, which appears ONLY once she has already loaded that
// exact container — so re-editing meant remembering which container it was
// and fetching it first. The list is the missing half.
{
    const http = require('http');
    const iv = require(path.join(ROOT, 'helpers/invoiceVersions'));

    write('invoice_versions.json', {
        // ── THE TWO VERSIONS MUST DIFFER ──────────────────────────────────
        // The first fixture here had identical buyer and inv_no on both, so
        // reading the OLDEST version instead of the newest was invisible —
        // the mutation passed. That is the exact bug worth catching: she
        // corrects a buyer name, regenerates, and the list goes on showing
        // the name she fixed.
        HMMU1111111: [
            { inv_no: 'EM-100-DRAFT', buyer: 'Eccomelt LL', container_no: 'HMMU1111111',
              port_discharge: 'Pusan', saved_at: '2026-09-01T10:00:00Z' },
            { inv_no: 'EM-100', buyer: 'Eccomelt LLC', container_no: 'HMMU1111111',
              port_discharge: 'Busan, South Korea', line_items: [{ description: 'Al combo' }],
              saved_at: '2026-09-02T10:00:00Z' },
        ],
        HMMU2222222: [
            { inv_no: 'EM-101', buyer: 'MK Trading', container_no: 'HMMU2222222',
              port_discharge: 'Nhava Sheva, India', saved_at: '2026-09-20T10:00:00Z' },
        ],
    });

    const list = iv.listGeneratedInvoices();
    ck('every generated container is listed', list.length === 2, String(list.length));
    ck('  newest first — the one she wants to correct is the last one she made',
       list[0].container === 'HMMU2222222', list.map((r) => r.container).join(','));
    ck('  with what the row needs to be recognised',
       list[0].inv_no === 'EM-101' && list[0].buyer === 'MK Trading'
       && list[0].port_discharge === 'Nhava Sheva, India', JSON.stringify(list[0]));
    ck('  and how many times it has been generated',
       (list.find((r) => r.container === 'HMMU1111111') || {}).versions === 2,
       JSON.stringify(list.find((r) => r.container === 'HMMU1111111')));

    // ── THE ROW SHOWS THE LATEST VERSION, NOT THE FIRST ───────────────────
    // She corrects a buyer name and regenerates; a row built from the oldest
    // version would keep showing the name she fixed, and she would open it
    // believing the correction never saved.
    const em = list.find((r) => r.container === 'HMMU1111111') || {};
    ck('  the row reflects the LATEST generate, not the first',
       em.inv_no === 'EM-100' && em.buyer === 'Eccomelt LLC'
       && em.port_discharge === 'Busan, South Korea', JSON.stringify(em));

    // A SUMMARY, not the payloads. Sending ten full invoice payloads to draw
    // a ten-row table would make this screen slower the more she used it.
    ck('  the list does NOT carry the line items',
       list.every((r) => !('line_items' in r)), JSON.stringify(list[0]));

    // ── THROUGH THE REAL ROUTES ───────────────────────────────────────────
    const { createApi } = require(path.join(ROOT, 'api'));
    const app = createApi();
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = (method, pth, { sid } = {}) => new Promise((resolve, reject) => {
        const headers = {};
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r2 = http.request(base + pth, { method, headers }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
        });
        r2.on('error', reject); r2.end();
    });
    const sid = ((await (() => new Promise((resolve, reject) => {
        const data = JSON.stringify({ password: process.env.ADMIN_PASSWORD });
        const r2 = http.request(base + '/login', { method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
            (res) => { let raw = ''; res.on('data', (c) => { raw += c; });
                       res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ json: j }); }); });
        r2.on('error', reject); r2.write(data); r2.end();
    }))()).json || {}).sid;

    const got = await req('GET', '/api/invoice/history', { sid });
    ck('the list route answers', got.status === 200, String(got.status));
    ck('  with both containers', (got.json.invoices || []).length === 2,
       JSON.stringify(got.json).slice(0, 160));

    // Edit fetches the FULL payload — the same shape /api/invoice/preview
    // returns, which is why the client can pour it straight into the form.
    const pay = await req('GET', '/api/invoice/history/payload?container=HMMU1111111', { sid });
    ck('the payload route answers', pay.status === 200, String(pay.status));
    ck('  with the MOST RECENT version, not the first',
       pay.json.payload && Array.isArray(pay.json.payload.line_items),
       JSON.stringify(pay.json.payload || {}).slice(0, 160));
    ck('  and strips saved_at out of the form state',
       pay.json.payload && !('saved_at' in pay.json.payload),
       'saved_at is not a form field and would be poured into the screen');
    ck('  handing the timestamp back separately', !!pay.json.saved_at, String(pay.json.saved_at));

    // ── NOTHING SAVED IS A 404, NOT A BLANK ───────────────────────────────
    // An invoice generated before this store existed is a PDF and has no form
    // state. Quietly returning an empty payload would wipe the screen she is
    // on, which is worse than saying so.
    const none = await req('GET', '/api/invoice/history/payload?container=NOPE0000000', { sid });
    ck('a container with no saved form is a 404', none.status === 404, String(none.status));
    ck('  and says why', /generated before|only the PDF/i.test((none.json || {}).error || ''),
       JSON.stringify(none.json));

    await new Promise((r) => server.close(r));
}

// ══════════════════════════════════════════════════════════════════════════
section('G — the list on the screen');
// ══════════════════════════════════════════════════════════════════════════
{
    const web = fs.readFileSync(path.join(ROOT, 'dashboard/documents.html'), 'utf8');
    ck('there is a generated-invoice list', /id="invGenList"/.test(web));
    ck('  with an Edit on each row', /class="btn btn-secondary inv-gen-edit"/.test(web));

    // ONE filler for all three ways in. A second one written for this list
    // would drift, and the symptom is a field that silently stops being
    // restored on one path only.
    const fn = web.slice(web.indexOf('async function editGeneratedInvoice'),
                         web.indexOf('if ($(\'btnInvGenRefresh\')'));
    ck('Edit reuses applyInvoiceDataToForm, the same filler as the banner',
       /applyInvoiceDataToForm\(d\.payload\)/.test(fn),
       'a second filler would drift from the one Load previous edits uses');
    ck('  and lands her on the review screen', /showInvStep\(3\)/.test(fn));
    ck('  hiding the banner, which offers what she has just been given',
       /invVersionBanner'\)\.classList\.add\('hidden'\)/.test(fn),
       'an offer to load previous edits on top of the edits just loaded reads as a failure');

    // Generating has to put the new invoice into the list, or she scrolls down
    // to the list she was told about and does not find what she just made.
    ck('a successful generate refreshes the list',
       /try \{ loadGeneratedInvoices\(\); \} catch/.test(web),
       'otherwise the only fix is reloading the page');
    ck('  and a failed refresh cannot turn a good generate into an error',
       /try \{ loadGeneratedInvoices\(\); \} catch \(e\) \{/.test(web));

    // Outside the three steps, which are shown one at a time.
    ck('the list is not inside invStep1/2/3',
       web.indexOf('id="invGenList"') > web.indexOf('id="invStep3"')
       && !/id="invStep3"[\s\S]{0,200}id="invGenList"/.test(web),
       'a list that vanishes when she changes step is hardest to find when she wants it');
}

// ══════════════════════════════════════════════════════════════════════════
section('H — no route name is a prefix of another');
// ══════════════════════════════════════════════════════════════════════════
// The list was first called /api/invoice/generated, which CONTAINS the
// existing /api/invoice/generate. tests/invoice-weight-guard.js matches the
// generator by substring, so a GET of the list was counted as a POST to the
// generator and the test reported three generate posts where there were two.
// A log filter or a proxy rule would make the same mistake.
//
// Checked across the whole API rather than for this one pair: the trap is not
// specific to invoices, and the next person adding /api/x/thing beside an
// existing /api/x/thin deserves to be told at test time.
{
    const apiSrc = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
    const routes = [...new Set(
        [...apiSrc.matchAll(/app\.(?:get|post|put|patch|delete)\('(\/api\/[^']*)'/g)]
            .map((m) => m[1])
            // A path parameter is a wildcard, not a literal prefix — /api/x/:id
            // and /api/x/list are told apart by the router, not by spelling.
            .filter((r) => !r.includes(':'))
    )];

    // ── THREE THAT ALREADY EXISTED ────────────────────────────────────────
    // Found by this check the first time it ran, and left alone. They are
    // real — a substring matcher confuses /api/sales with /api/sales-receipts
    // exactly as it confused generate with generated — but they have been
    // live for a long time, both clients call them, and renaming a working
    // route to satisfy a test I wrote today is precisely the widening this
    // repo keeps paying for. Listed BY NAME rather than by loosening the
    // rule, so anything new still fails. Flagged to Apsara; hers to call.
    const KNOWN = new Set([
        '/api/me  <  /api/metals-trucking',
        '/api/sales  <  /api/sales-receipts',
        '/api/sales  <  /api/sales-settlements',
        // The same family as the bug that prompted this check: an invoice
        // route whose name extends another invoice route. Anything matching
        // /api/invoice/preview by substring also matches preview-multi.
        '/api/invoice/preview  <  /api/invoice/preview-multi',
    ]);

    const clashes = [];
    for (const a of routes) {
        for (const b of routes) {
            // b is a strict extension of a, and NOT at a path boundary —
            // /api/invoice/generate vs /api/invoice/generated. A boundary
            // ('/') is fine: /api/bills and /api/bills/import read cleanly
            // and no substring matcher confuses them in practice.
            if (a !== b && b.startsWith(a) && b[a.length] !== '/') {
                const pair = `${a}  <  ${b}`;
                if (!KNOWN.has(pair)) clashes.push(pair);
            }
        }
    }
    ck('no NEW API route is a bare prefix of another',
       clashes.length === 0,
       clashes.join('\n        ') || '');
    // The allowlist must not quietly outlive the routes it excuses — three
    // entries that no longer match anything would hide a fourth.
    ck('  and every known exception still exists',
       [...KNOWN].every((pair) => {
           const [a, b] = pair.split('  <  ');
           return routes.includes(a) && routes.includes(b);
       }),
       'a stale entry in the allowlist silently excuses nothing, or worse, something else');
    ck('  and there are routes to check, so this is not vacuous',
       routes.length > 40, `${routes.length} routes scanned`);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }

})().catch((e) => { console.error(e); process.exit(1); });
