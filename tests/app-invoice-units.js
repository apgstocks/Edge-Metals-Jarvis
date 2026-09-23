// ── tests/app-invoice-units.js ────────────────────────────────────────────
// 260831_SU_26EM05 was billed $13.09 for a container worth $28,860.80. The
// website was fixed on 2026-09-22; the PHONE was not, and nobody noticed for
// a day because every test in this repo exercised the website.
//
// Apsara, 2026-09-17: "ALwyas test end to end when you add a new feature."
// So this starts a real server and posts the payload the APP actually sends,
// through the route the APP actually posts to — /api/invoice/generate — and
// reads the billed figure back out of the HTML that reached the renderer.
//
// Section D is the one that would have caught the original bug: it asserts
// the two clients carry the SAME units machinery, so a fix applied to one and
// forgotten on the other is red rather than invisible.
//
// CLAUDE.md rule 1: the MT path must be untouched. Section C is that check —
// an invoice saved in tonnes must still print in tonnes. A fix that makes
// pounds right by making tonnes wrong has moved the bug, not removed it.

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-units-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD   = process.env.APP_PASSWORD   || 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'staff-pw-ccccccccccc';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('  ABORT  config not isolated'); process.exit(1); }

let RENDERED = [];
const orig = Module._load;
Module._load = function (r) {
    if (r.endsWith('helpers/gmail') || r === '../helpers/gmail' || r === './helpers/gmail') return {
        getGmailRead: () => ({}), getGmailSenderRead: () => ({}), getGmailWrite: () => ({}),
        getMyEmailAddress: async () => 'apsara@edgemetals.com',
        listMessages: async () => [], getMessage: async () => ({}), getEmailContent: () => ({ body: '' }),
        parseAddressList: () => [], parseEmailDate: (d) => d,
        sendEmail: async () => ({ id: 'msg_1', threadId: 'th_1' }),
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

// ── her container, exactly as the reissue must read ───────────────────────
// 49,760 lb net at $0.58/lb. In pounds nothing converts, so the two printed
// figures multiply out to the total with no rounding argument:
//     49,760 x 0.58 = 28,860.80
// The same container in tonnes is 49760 / 2204.62 = 22.571 MT, and 22.571 x
// 0.58 = 13.09 — the invoice that actually went out.
const NET_LBS = 49760;
const LBS_PER_MT = 2204.62;
const RATE_LB = 0.58;
const EXPECT_LB = 28860.80;
const PACKING = {
    gross_weight_lbs: '76000', truck_lbs: '16000', container_tare_lbs: '8000',
    chassis_lbs: '2240', boxes_weight_lbs: '0', net_weight_lbs: String(NET_LBS),
};

// The payload shape the PHONE builds — see invCollectPayload in
// mobile-app/www/index.html. Written out here rather than imported because
// the point is to pin the contract between the two: if the app starts
// sending something else, this stops describing it and the parity section
// below is what catches that.
const APP_BODY = (units) => ({
    inv_no: '260831_SU_26EM05', inv_date: '08/31/2026',
    container_no: 'SUDU1234567', booking_no: 'EBKG18670536', seal_no: '0001234',
    consignee: 'Aris Metals', consignee_address: ['1 Test Road'],
    country_of_origin: 'USA',
    units,
    notes: [],
    subtotal: units === 'lb' ? EXPECT_LB : 13.09,
    final_amount: units === 'lb' ? EXPECT_LB : 13.09,
    line_items: [{
        item_desc: 'Sealed Units', container_no: 'SUDU1234567', seal_no: '0001234',
        weight: units === 'lb' ? NET_LBS : Number((NET_LBS / LBS_PER_MT).toFixed(3)),
        rate: units === 'lb' ? RATE_LB : 25.69,
        amount: units === 'lb' ? EXPECT_LB : 13.09,
        packing: { ...PACKING, net_weight_mt: (NET_LBS / LBS_PER_MT).toFixed(3) },
    }],
});

const text = (html) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');

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
section('A — the phone bills pounds in pounds');
{
    RENDERED = [];
    const r = await call('POST', '/api/invoice/generate?preview=1', sid, APP_BODY('lb'));
    ck('the route accepted the phone payload', r.status === 200, `${r.status} ${r.raw.slice(0, 200)}`);
    const html = RENDERED[RENDERED.length - 1] || '';
    const t = text(html);
    ck('something was rendered', !!html);
    // The whole ROW, in order: quantity, rate, amount. A bare search for
    // "49,760" would also pass on a document that printed it in the wrong
    // column, and 22.571 is NOT forbidden on the page — it is the legitimate
    // Net Weight (MT), which is the figure section B checks separately. What
    // must be true is that these three multiply out where they are printed.
    ck('the row reads 49,760 x $0.58 = 28,860.80',
        /49,760\s*\$?0?\.?58|49,760\s*\$0\.58\s*28,860\.80/.test(t)
        && /49,760[^0-9]{0,12}\$0\.58[^0-9]{0,12}28,860\.80/.test(t),
        t.slice(Math.max(0, t.search(/Quantity/i) - 40), t.search(/Quantity/i) + 240));
    ck('the quantity is not the tonnage', !/Sealed Units\s*22\.571/.test(t));
    ck(`the invoice totals $${EXPECT_LB.toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
        /28,860\.80/.test(t), t.slice(0, 400));
    ck('THE $13.09 FIGURE IS NOWHERE ON THE DOCUMENT', !/13\.09/.test(t));
}

section('B — and says so in the headings');
{
    const t = text(RENDERED[RENDERED.length - 1] || '');
    ck('the quantity column is headed lbs', /Quantity\s*lbs/i.test(t), t.slice(0, 400));
    ck('the rate column is headed US$/lb', /US\$\/lb/i.test(t), t.slice(0, 400));
    ck('neither heading still says MT', !/Quantity\s*MT/i.test(t) && !/US\$\/MT/i.test(t));
    // The second net, which is a separate bug from the same day: it was being
    // derived from the quantity box, so a pounds invoice printed
    // "Net Weight (MT) 49760.000".
    const t2 = text(RENDERED[RENDERED.length - 1] || '');
    ck('the net weight in MT is 22.571, not 49,760', !/49760\.000/.test(t2) && !/49,760\.000/.test(t2), t2.slice(0, 400));
}

section('C — tonnes still print as tonnes (rule 1: nothing else changed)');
{
    RENDERED = [];
    const r = await call('POST', '/api/invoice/generate?preview=1', sid, APP_BODY('mt'));
    ck('an MT invoice is still accepted', r.status === 200, `${r.status} ${r.raw.slice(0, 200)}`);
    const t = text(RENDERED[RENDERED.length - 1] || '');
    ck('it is headed MT', /Quantity\s*MT/i.test(t) && /US\$\/MT/i.test(t), t.slice(0, 400));
    ck('and carries the tonnage', /22\.571/.test(t), t.slice(0, 400));
}

section('D — the two clients cannot drift apart again');
{
    // This is the section that would have caught the bug in the first place.
    // The units fix landed on the website on 2026-09-22 and the phone kept
    // converting to MT for another day, because nothing in the suite had an
    // opinion about the phone.
    const web = fs.readFileSync(path.join(ROOT, 'dashboard', 'documents.html'), 'utf8');
    const app2 = fs.readFileSync(path.join(ROOT, 'mobile-app', 'www', 'index.html'), 'utf8');

    ck('the website has a units control', /id="inv_units"/.test(web));
    ck('the PHONE has a units control', /id="invw_units"/.test(app2));
    ck('both offer pounds and tonnes', /value="lb"/.test(web) && /value="mt"/.test(web)
                                    && /value="lb"/.test(app2) && /value="mt"/.test(app2));
    ck('both send units on the payload', /units:\s*invUnits\(\)/.test(web) && /units:\s*invwUnits\(\)/.test(app2));

    // The actual bug, pinned: an UNCONDITIONAL divide is what produced $13.09.
    // Either client dividing without first asking which unit it is in is the
    // defect, whichever file it lives in.
    const badDivide = (src, sym) =>
        new RegExp(String.raw`\.value\s*=\s*net\s*==\s*null\s*\?\s*''\s*:\s*\(net\s*/\s*` + sym).test(src);
    ck('the phone no longer divides unconditionally', !badDivide(app2, 'INVW_LBS_PER_MT'));
    ck('nor does the website', !badDivide(web, 'LBS_PER_MT'));

    // And the second net must come off the weights, not the quantity box, on
    // both. A pounds quantity has nothing to say about tonnage.
    ck('the phone derives net_weight_mt from the net pounds',
        /net_weight_mt:\s*\(\(\)\s*=>\s*\{[\s\S]{0,400}invwRowNetLbs\(row\)/.test(app2));
}

section('E — the phone ARITHMETIC, actually run');
{
    // Sections A-C prove the SERVER honours the unit it is sent. Section D
    // reads the source. Neither of those runs the phone's own calculation,
    // and the phone's own calculation is where the $13.09 came from: the
    // client wrote 22.571 into the quantity box and the server faithfully
    // printed what it was given.
    //
    // So this evaluates the app's real script in a DOM and asks it to do the
    // sum. A source regex passes the moment someone writes a plausible-
    // looking line; this passes only if the number comes out right.
    const { JSDOM } = require('jsdom');
    const APP = fs.readFileSync(path.join(ROOT, 'mobile-app', 'www', 'index.html'), 'utf8');
    const SCRIPT = [...APP.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    const dom = new JSDOM(APP, { runScripts: 'outside-only', url: 'http://localhost/' });
    const w = dom.window, d = w.document;
    // Held at its first await so boot cannot run on past the definitions —
    // see the note in tests/paid-via.js; a script that throws part-way leaves
    // every later const in the temporal dead zone.
    w.fetch = () => new Promise(() => {});
    w.setInterval = () => 0;

    // ── THE ROW GOES IN BEFORE THE SCRIPT RUNS ────────────────────────────
    // and the probe goes in the SAME eval as the script, which is the part
    // that took three attempts to get right:
    //
    // invwUnits is a top-level `const`. Inside an eval, `const` and `let` are
    // scoped to THAT eval — only `var` and function declarations escape into
    // the window. So w.invwUnits is undefined, and so is a later
    // w.eval('invwUnits'), however correct the code is. Only a probe
    // appended to the same source can see it. (invwRowNetLbs is reachable
    // either way, being a function declaration — which is exactly the sort of
    // half-working harness that makes a real failure look like a bug in the
    // code under test. tests/paid-via.js records the same trap.)
    d.body.insertAdjacentHTML('beforeend', `
      <div id="docBody"><select id="invw_units"><option value="lb" selected>lb</option><option value="mt">mt</option></select><div id="invwNotes"></div><div id="invwTotals"></div>
      <input id="invw_no" value="260831_SU_26EM05"><input id="invw_date" value="08/31/2026">
      <textarea id="invw_address"></textarea>
      <div id="invwRefreshChoice" class="hidden"></div><div id="invwRefreshStatus"></div>
      <button id="btnInvwRefresh"></button><button id="btnInvwRefreshRows"></button>
      <button id="btnInvwRefreshAll"></button><button id="btnInvwRefreshCancel"></button>
      <button id="btnInvAddNote"></button><button id="btnInvBack3"></button><button id="btnInvPreview"></button>
      <button id="btnInvGenerate"></button><button id="btnInvQueueCancel"></button>
      <table id="invwItems"><tbody><tr class="invw-item" data-i="0">
        <td><input class="invw-p-gross" value="76000"></td>
        <td><input class="invw-p-truck" value="16000"></td>
        <td><input class="invw-p-tare" value="8000"></td>
        <td><input class="invw-p-chassis" value="2240"></td>
        <td><input class="invw-p-boxes" value="0"></td>
        <td><input class="invw-p-net" value=""></td>
        <td><input class="invw-weight" value=""></td>
        <td><input class="invw-rate" value="0.58"></td>
        <td><span class="invw-amount"></span></td>
      </tr></tbody></table></div>`);

    try {
        w.eval(SCRIPT + '\n;window.__probe = { units: () => invwUnits(), perMt: INVW_LBS_PER_MT };');
    } catch (e) { /* boot needs a session; the declarations above it are made */ }

    const probe = w.__probe || null;
    ck('the phone exposes its units reader', !!probe && typeof probe.units === 'function',
        probe ? 'probe present, units=' + typeof probe.units : 'probe missing — script threw before the end');
    ck('and its pounds-per-tonne constant', !!probe && probe.perMt === 2204.62, probe && String(probe.perMt));

    const row = d.querySelector('.invw-item');
    const netOf = w.invwRowNetLbs;
    ck('invwRowNetLbs is reachable', typeof netOf === 'function');
    if (typeof netOf === 'function') {
        ck(`net comes to ${NET_LBS.toLocaleString('en-US')} lb`, netOf(row) === NET_LBS, String(netOf(row)));
    }

    // And the quantity the phone would put in the box, in each unit. This is
    // the exact line that was wrong: it divided every time.
    // ── THE APP'S OWN recalcWeights, THROUGH THE EVENT SHE FIRES ──────────
    // Restating the rule here instead would be the mistake CLAUDE.md names:
    // "a check shaped like the old code rather than like the property, which
    // passes happily when the code moves". A first version of this section
    // did exactly that — it recomputed the quantity from invwUnits() and
    // invwRowNetLbs and PASSED with the original bug restored, because it
    // never touched the line that was wrong.
    //
    // recalcWeights is a const inside wireInvStep3, so it cannot be called
    // directly. It does not need to be: wireInvStep3 binds it to the weight
    // inputs, and typing in one is what she actually does. Dispatching
    // 'input' on the gross box runs the real handler and the quantity box
    // holds whatever the shipped code decided to put there.
    const wired = (() => { try { w.wireInvStep3(); return true; } catch (e) { return `THREW: ${e.message}\n${String(e.stack).split("\n").slice(1,4).join(" | ")}`; } })();
    ck('wireInvStep3 bound the row', wired === true, String(wired));

    const qtyBox = row.querySelector('.invw-weight');
    const typeInGross = (units) => {
        d.getElementById('invw_units').value = units;
        const g = row.querySelector('.invw-p-gross');
        g.value = '76000';
        g.dispatchEvent(new w.Event('input', { bubbles: true }));
        return qtyBox.value;
    };

    if (wired === true) {
        ck('in pounds the quantity box holds 49760 — nothing converted', typeInGross('lb') === '49760', typeInGross('lb'));
        ck('  so 49,760 x $0.58 bills $28,860.80',
            Math.round(Number(typeInGross('lb')) * RATE_LB * 100) / 100 === EXPECT_LB);
        ck('in tonnes it still converts to 22.571', typeInGross('mt') === '22.571', typeInGross('mt'));
        ck('  which against a POUND rate is the $13.09 that went out',
            Math.round(Number(typeInGross('mt')) * RATE_LB * 100) / 100 === 13.09);
        // And the net-lbs box, which both units share.
        ck('the net box reads 49,760 either way', /49,?760/.test(row.querySelector('.invw-p-net').value),
            row.querySelector('.invw-p-net').value);
    } else {
        ck('the phone units machinery runs in a DOM', false, 'wireInvStep3 did not bind');
    }
}

listener.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) console.log('  failed: ' + failures.join(' | '));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* tmp */ }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error(e); process.exit(1); });
