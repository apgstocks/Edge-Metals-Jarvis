// ── tests/load-item-units.js ──────────────────────────────────────────────
// Apsara, 2026-09-24: "IN EDGE YARD LOAD APP,IT SHOYKD HAVE A PROVISION TO
// CALCULATE AMOUNT BY USING MT OR LBS ROWISE.BY DEFAULT LBS SHOULD BE ENABLED"
//
// ── WHAT THIS IS ABOUT ─────────────────────────────────────────────────────
// A yard load is several grades weighed separately. Some are bought by the
// pound and some are quoted by the tonne, and until today the form could only
// do one of those. The unit is PER ROW, and the default is lb.
//
// ── THE TWO THINGS THAT COULD GO WRONG, AND WHY EACH IS PINNED ─────────────
//
//   1. EVERY LOAD ALREADY ON FILE. computeItem in helpers/loads.js is the
//      server's source of truth — it recomputes over whatever the client
//      sends rather than trusting it. Those loads carry no unit, or a unit
//      typed into the free-text box that used to be there before 1ca3d5e.
//      If 'lb', '', and anything unrecognised do not all take the pound
//      branch, the arithmetic on years of signed tickets changes underneath
//      her. Section A is mostly this.
//
//   2. THE PRICE RECALL. The description type-ahead fills in the last price
//      paid for that grade. If it recalls $800/MT into a box the row is
//      treating as per-pound, nobody typed a wrong number and the row is
//      still wrong — by a factor of 2,204. Section C.
//
// ── AND WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────
// helpers/outboundLoads.js has its OWN computeItem, for the SALE side. She
// said "load app", which is the purchase screen. Section E asserts the sale
// side is UNCHANGED, so this file fails if someone later decides consistency
// is worth more than her paperwork working.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-units-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));

const DASH = fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8');
const APP  = fs.readFileSync(path.join(ROOT, 'mobile-app/www/index.html'), 'utf8');

// 30,000 lb is a real load size. At $0.36/lb it is $10,800; the same metal at
// $800/MT is $10,886.23. Close enough that a wrong unit does NOT look wrong,
// which is exactly why this needs a test rather than an eyeball.
const NET = 30000;
const PER_LB = 0.36;
const PER_MT = 800;
const EXPECT_LB = 10800;
const EXPECT_MT = Math.round(NET / 2204.62 * PER_MT * 100) / 100;

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — the server arithmetic, and every load already on file');
// ══════════════════════════════════════════════════════════════════════════
{
    const { addLoad, getLoad } = require(path.join(ROOT, 'helpers/loads'));

    const saved = await addLoad({
        date: '2026-09-24', seller: 'Ramesh', weight_unit: 'lb',
        items: [
            { description: 'Copper',  gross_weight: 50000, tare_weight: 20000, price: PER_LB, unit: 'lb' },
            { description: 'Brass',   gross_weight: 50000, tare_weight: 20000, price: PER_MT, unit: 'mt' },
            { description: 'Radiator',gross_weight: 50000, tare_weight: 20000, price: PER_LB },
            { description: 'Alum',    gross_weight: 50000, tare_weight: 20000, price: PER_MT, unit: 'MT ' },
        ],
    });
    const it = saved.items;

    ck('a per-lb row is net x price', it[0].amount === EXPECT_LB, String(it[0].amount));
    ck('a per-MT row divides by 2204.62 first', it[1].amount === EXPECT_MT, String(it[1].amount));
    ck('  and they are close enough that only a test would catch a swap',
       Math.abs(EXPECT_MT - EXPECT_LB) < 100, `${EXPECT_LB} vs ${EXPECT_MT}`);

    // THE ONE THAT MATTERS MOST. Every load saved before today has no unit.
    ck('a row with NO unit is priced per pound, exactly as it always was',
       it[2].amount === EXPECT_LB, String(it[2].amount));
    ck('  MT is recognised however it is cased or spaced', it[3].amount === EXPECT_MT, String(it[3].amount));

    // The weight is what the weighbridge said. It is not converted, ever.
    ck('the net stays in pounds on a per-MT row', it[1].net_weight === NET, String(it[1].net_weight));
    ck('  gross and tare too', it[1].gross_weight === 50000 && it[1].tare_weight === 20000);

    // Stored shape, so a later read knows which it was.
    ck('the unit is stored, normalised', it[1].unit === 'mt' && it[3].unit === 'mt',
       `${it[1].unit} / ${it[3].unit}`);
    ck('  and a pound row is left exactly as it came', it[2].unit === '');

    // The load total is the sum of the item amounts, whatever their units.
    ck('the load total sums both kinds of row',
       saved.amount === Math.round((EXPECT_LB * 2 + EXPECT_MT * 2) * 100) / 100, String(saved.amount));

    const back = getLoad(saved.id);
    ck('and it survives a round trip to disk', back.items[1].amount === EXPECT_MT && back.items[1].unit === 'mt');
}

// ══════════════════════════════════════════════════════════════════════════
section('B — both screens: a select, defaulting to lb');
// ══════════════════════════════════════════════════════════════════════════
{
    for (const [name, src] of [['website', DASH], ['app', APP]]) {
        ck(`${name}: the row has a unit control`, /class="ld-item-unit"/.test(src));
        const sel = (src.match(/<select class="ld-item-unit"[\s\S]*?<\/select>/) || [''])[0];
        ck(`${name}:   offering lb and MT, and nothing else`,
           (sel.match(/<option value="/g) || []).length === 2
           && /value="lb"/.test(sel) && /value="mt"/.test(sel), sel.slice(0, 120));
        ck(`${name}: the client converts the same way the server does`,
           /net \/ 2204\.62/.test(src));
        ck(`${name}: the posted item carries the unit`,
           /unit : row\.querySelector\('\.ld-item-unit'\)\?\.value \|\| 'lb'/.test(src));
        // A <select> is not an <input>. Without its own listener the amount
        // sits at the previous unit's figure and looks settled.
        ck(`${name}: changing the unit recomputes the row`,
           /select\.ld-item-unit'\)\.forEach\(sel => sel\.addEventListener\('change'/.test(src));
    }

    // DEFAULT lb — her words, and the thing that keeps old loads safe. Proved
    // by rendering, not by reading the source: the selected attribute is
    // built by a ternary and a ternary is exactly what gets inverted.
    const dom = new JSDOM(`<select class="ld-item-unit">
        <option value="lb" selected>/lb</option><option value="mt">/MT</option></select>`);
    ck('a fresh row is lb', dom.window.document.querySelector('.ld-item-unit').value === 'lb');

    for (const [name, src] of [['website', DASH], ['app', APP]]) {
        // The rendered markup, pulled out of the template and evaluated for
        // the three cases: no unit, 'lb', 'mt'.
        const m = src.match(/<select class="ld-item-unit"[\s\S]*?<\/select>/);
        ck(`${name}: the select template is there to render`, !!m);
        if (!m) continue;
        const tpl = m[0];
        const render = (unit) => {
            const it = { unit };
            // eslint-disable-next-line no-new-func
            return new Function('it', 'return `' + tpl.replace(/`/g, '\\`') + '`;')(it);
        };
        const selectedValue = (html) => {
            const d = new JSDOM(`<form>${html}</form>`);
            return d.window.document.querySelector('.ld-item-unit').value;
        };
        ck(`${name}: an item with no unit renders as lb`, selectedValue(render(undefined)) === 'lb',
           selectedValue(render(undefined)));
        ck(`${name}:   an empty unit renders as lb`, selectedValue(render('')) === 'lb');
        ck(`${name}:   'lb' renders as lb`, selectedValue(render('lb')) === 'lb');
        ck(`${name}:   'mt' renders as MT`, selectedValue(render('mt')) === 'mt');
        ck(`${name}:   'MT' renders as MT too`, selectedValue(render('MT')) === 'mt');
    }
}

// ══════════════════════════════════════════════════════════════════════════
section('C — the price recall carries its unit');
// ══════════════════════════════════════════════════════════════════════════
// The type-ahead fills the last price paid for a grade. Recalling $800/MT
// into a row left on the pound default is a $24,000,000 load that nobody
// typed. Recalling one half of a pair is worse than recalling neither.
{
    for (const [name, src] of [['website', DASH], ['app', APP]]) {
        ck(`${name}: lastPriceForDescription returns the unit with the price`,
           /return \{ price: it\.price, unit:/.test(src));
        ck(`${name}: applying it sets the select too`,
           /if \(unitSel\) unitSel\.value = last \? last\.unit : 'lb';/.test(src));
        ck(`${name}:   and a grade with no history falls back to lb, not to whatever was there`,
           /last \? last\.unit : 'lb'/.test(src));
    }

    // The function itself, lifted out and run: an MT row must come back as MT.
    const m = DASH.match(/function lastPriceForDescription\(desc\)[\s\S]*?\n\}/);
    ck('lastPriceForDescription is liftable', !!m);
    if (m) {
        const loadsCache = [{ items: [
            { description: 'Brass',  price: PER_MT, unit: 'mt' },
            { description: 'Copper', price: PER_LB },
        ] }];
        // eslint-disable-next-line no-new-func
        const fn = new Function('loadsCache', m[0] + '; return lastPriceForDescription;')(loadsCache);
        const brass = fn('brass');
        ck('  an MT grade recalls as MT', brass && brass.unit === 'mt' && brass.price === PER_MT,
           JSON.stringify(brass));
        const copper = fn('copper');
        ck('  a grade with no unit recalls as lb', copper && copper.unit === 'lb', JSON.stringify(copper));
        ck('  an unknown grade recalls nothing', fn('titanium') === null);
    }
}

// ══════════════════════════════════════════════════════════════════════════
section('D — the ticket the seller signs says what the price is PER');
// ══════════════════════════════════════════════════════════════════════════
// "Net 30,000 lb · Price $800 · Amount $10,886.23" is three true figures
// arranged into a lie, on the one document he takes away.
{
    const pdfSrc = fs.readFileSync(path.join(ROOT, 'helpers/pdf.js'), 'utf8');
    ck('the ticket qualifies the rate', /Price \$\$\{fmtRate\(it\.price\) \?\? '—'\}\/\$\{rateUnit\}/.test(pdfSrc));
    ck('  rateUnit is the ITEM\'s unit, falling back to the load\'s',
       /const rateUnit = String\(it\.unit \|\| ''\)\.trim\(\)\.toLowerCase\(\) === 'mt' \? 'MT' : unit;/.test(pdfSrc));
    ck('  and the WEIGHTS still print in the load\'s unit, unconverted',
       /Net \$\{it\.net_weight \?\? '—'\} \$\{unit\}/.test(pdfSrc));
}

// ══════════════════════════════════════════════════════════════════════════
section('E — the SALE side is untouched');
// ══════════════════════════════════════════════════════════════════════════
// She said "load app" — the purchase screen. outboundLoads.js has its own
// computeItem. This section exists so that a later tidy-up that "makes them
// consistent" fails here instead of on her paperwork.
{
    const ob = fs.readFileSync(path.join(ROOT, 'helpers/outboundLoads.js'), 'utf8');
    ck('outbound still has its own computeItem', /function computeItem\(it\)/.test(ob));
    ck('  and it does NOT convert by tonne', !/2204\.62/.test(ob));
    const { loadOutboundLoads } = require(path.join(ROOT, 'helpers/outboundLoads'));
    ck('  outbound loads still load', Array.isArray(loadOutboundLoads()));
}

// ══════════════════════════════════════════════════════════════════════════
section('F — what Jarvis is told about a price');
// ══════════════════════════════════════════════════════════════════════════
// The catalog used to say price was "price per pound paid", flat. Ask "what
// did we pay per pound for brass" against an MT row and the model answers 800
// with complete confidence. A column it can SEE is the only honest fix.
{
    const cat = require(path.join(ROOT, 'helpers/data/yardCatalog'));
    const items = (cat.TABLES || cat.tables || []).find((t) => t.name === 'yard_load_items');
    ck('yard_load_items is in the catalog', !!items);
    if (items) {
        ck('  it has a price_unit column', !!items.columns.price_unit);
        ck('  and price no longer claims to be per pound',
           !/price per pound paid/.test(items.columns.price || ''), items.columns.price);
        ck('  it points at amount/net_lb for a like-for-like rate',
           /amount\/net_lb/.test(items.columns.price || ''));
    }
    // The mirror's row builder, run against the store section A wrote to.
    const mirror = require(path.join(ROOT, 'helpers/data/yardMirror'));
    const rows = mirror.TABLES.yard_load_items();
    const mt = rows.find((r) => r.price_unit === 'mt');
    const lb = rows.find((r) => r.price_unit === 'lb');
    ck('the mirror carries price_unit for an MT row', !!mt, JSON.stringify(rows[0]));
    ck('  and marks an untagged row lb', !!lb, JSON.stringify(rows.map((r) => r.price_unit)));
    ck('  while net_lb stays pounds on both', !!mt && mt.net_lb === NET, mt && String(mt.net_lb));
    // And the column actually reaches SQLite — the mirror only creates the
    // columns the CATALOG declares, so a row field the catalog doesn't name
    // is silently dropped on the way in.
    const declared = Object.keys(cat.find('yard_load_items').columns);
    ck('  and SQLite will have the column, because the catalog declares it',
       declared.includes('price_unit'), declared.join(','));
}

// ══════════════════════════════════════════════════════════════════════════
section('G — END TO END, through the route the screen actually posts to');
// ══════════════════════════════════════════════════════════════════════════
// CLAUDE.md rule 3. Sections A-F can all be green while the ROUTE drops the
// field: api.js could whitelist item keys, the client could send `price_unit`
// where the server reads `unit`. This posts the body the form builds and
// reads the figure back out of GET /api/loads/:id.
//
// A DELTA, not an absolute — section A has already written four items to this
// same store.
{
    const http = require('http');
    process.env.APP_PASSWORD   = process.env.APP_PASSWORD   || 'user-pw-aaaaaaaaaaaa';
    process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pw-bbbbbbbbbbb';
    process.env.STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'staff-pw-ccccccccccc';

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

    const sid = ((await req('POST', '/login', { body: { password: process.env.ADMIN_PASSWORD } })).json || {}).sid;
    ck('signed in', !!sid);

    // Exactly what syncItemsFromDom builds: strings, because they came out of
    // form inputs, and the unit from the select.
    const posted = await req('POST', '/api/loads', { sid, body: {
        date: '2026-09-24', seller: 'E2E Seller', weight_unit: 'lb',
        items: [
            { description: 'Copper', gross_weight: '50000', tare_weight: '20000', price: '0.36', unit: 'lb' },
            { description: 'Brass',  gross_weight: '50000', tare_weight: '20000', price: '800',  unit: 'mt' },
        ],
        client_request_id: 'e2e-units-1',
    } });
    ck('the route accepted the load', posted.status === 200, `${posted.status} ${JSON.stringify(posted.json)}`);

    // The route answers { ok, load, trucker_bill }, not the load bare.
    const id = posted.json && posted.json.load && posted.json.load.id;
    ck('  and gave back an id', !!id);

    const read = await req('GET', `/api/loads/${id}`, { sid });
    ck('the load reads back', read.status === 200);
    const got = (read.json && read.json.items) || [];
    ck('  the pound row is $10,800 through the route', got[0] && got[0].amount === EXPECT_LB,
       got[0] && String(got[0].amount));
    ck('  the tonne row is $10,886.23 through the route', got[1] && got[1].amount === EXPECT_MT,
       got[1] && String(got[1].amount));
    ck('  the unit survived the round trip', got[1] && got[1].unit === 'mt', got[1] && got[1].unit);
    ck('  and the net is still pounds', got[1] && got[1].net_weight === NET);

    // The figure she is shown and the figure she is paying: the load total.
    ck('  the load total is the sum of both rows',
       read.json && read.json.amount === Math.round((EXPECT_LB + EXPECT_MT) * 100) / 100,
       read.json && String(read.json.amount));

    // AND the thing that costs money: what the seller is owed.
    const { payableOf } = require(path.join(ROOT, 'helpers/loads'));
    ck('  what the seller is owed follows the same total',
       payableOf(read.json) === Math.round((EXPECT_LB + EXPECT_MT) * 100) / 100,
       String(payableOf(read.json)));

    // An EDIT must not silently flip a row back to pounds.
    const edited = await req('PUT', `/api/loads/${id}`, { sid, body: {
        date: '2026-09-24', seller: 'E2E Seller', weight_unit: 'lb',
        items: [
            { description: 'Copper', gross_weight: '50000', tare_weight: '20000', price: '0.36', unit: 'lb' },
            { description: 'Brass',  gross_weight: '50000', tare_weight: '22000', price: '800',  unit: 'mt' },
        ],
    } });
    if (edited.status === 200) {
        const after = ((await req('GET', `/api/loads/${id}`, { sid })).json || {}).items || [];
        ck('an edit keeps the row on MT', after[1] && after[1].unit === 'mt', after[1] && after[1].unit);
        ck('  and reprices the new weight by tonne',
           after[1] && after[1].amount === Math.round(28000 / 2204.62 * 800 * 100) / 100,
           after[1] && String(after[1].amount));
    } else {
        ck('the edit route accepted the change', false, `${edited.status} ${JSON.stringify(edited.json)}`);
    }

    server.close();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }

})().catch((e) => { console.error(e); process.exit(1); });
