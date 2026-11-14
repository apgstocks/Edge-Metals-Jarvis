// ── tests/inventory-lines.js ───────────────────────────────────────────────
// Apsara, 2026-09-02: "in inventory say if i select sealed units, i want the
// matching loads that contain sealed units to be displayed .. matching sealed
// units from every load in rows with gross tare net price amount. on clicking
// that row, that load ticket should open."
//
// Two things here:
//   A–D  getItemLines — the detail behind an Inventory row
//   E    ROUTE ORDER, because writing the new endpoint exposed a live bug:
//        /api/loads/:id was registered before /api/loads/lookup and
//        /api/loads/stock, so Express matched ':id' first and both returned
//        404. dashboard/outbound-loads.html calls lookup to search loads while
//        building a sale — that search has been broken in production.
//        tests/yard-stock.js stayed green throughout because it asserts the
//        staff ALLOWLIST contains the path, not that the route resolves.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-invlines-'));
process.env.JARVIS_TEST = '1';
const ROOT = path.join(__dirname, '..');
const { getItemLines, getInventoryReport } = require(path.join(ROOT, 'helpers/loads'));

// Two loads, three of them sealed units at different rates, plus a decoy that
// only differs by case and spacing — the grouping matches that way, so the
// drill-down has to as well.
const LOADS = [
    { id: 'EDGE_01', date: '2026-08-10', seller: 'Acme', weight_unit: 'lb', pdf_link: 'https://d/1',
      items: [
        { description: 'Sealed Units', gross_weight: 1000, tare_weight: 100, net_weight: 900, price: 0.5, amount: 450 },
        { description: 'Copper',       gross_weight: 500,  tare_weight: 50,  net_weight: 450, price: 2,   amount: 900 },
      ] },
    { id: 'EDGE_02', date: '2026-09-01', seller: 'Vega', weight_unit: 'lb', pdf_link: null,
      items: [
        { description: ' sealed units ', gross_weight: 2000, tare_weight: 200, net_weight: 1800, price: 0.55, amount: 990 },
        { description: 'SEALED UNITS',   gross_weight: 300,  tare_weight: 0,   net_weight: 300,  price: 0.6,  amount: 180 },
      ] },
    { id: 'EDGE_03', date: '2026-09-02', seller: 'Acme', weight_unit: 'lb', pdf_link: 'https://d/3',
      items: [{ description: 'Brass', gross_weight: 10, tare_weight: 0, net_weight: 10, price: 1, amount: 10 }] },
];

section('A — every matching line, from every load');
{
    const r = getItemLines(LOADS, { description: 'Sealed Units' });
    ck('all three lines are found', r.count === 3);
    ck('  across both loads', new Set(r.lines.map(l => l.load_id)).size === 2);
    ck('  and nothing else came with them', r.lines.every(l => /sealed units/i.test(l.description)));

    // The grouping is case- and space-insensitive; if the drill-down were
    // stricter, a group would show a total with rows that do not add up to it.
    ck('matching ignores case and surrounding space', r.count === 3,
       'the heading and its rows must agree, or the total has no explanation');

    const l = r.lines.find(x => x.load_id === 'EDGE_01');
    ck('each row carries gross', l.gross_weight === 1000);
    ck('  tare', l.tare_weight === 100);
    ck('  net', l.net_weight === 900);
    ck('  price', l.price === 0.5);
    ck('  amount', l.amount === 450);
    ck('  and which load it came from', l.load_id === 'EDGE_01' && l.date === '2026-08-10' && l.seller === 'Acme');
}

section('B — the row can open its ticket');
{
    const r = getItemLines(LOADS, { description: 'Sealed Units' });
    const withPdf = r.lines.find(x => x.load_id === 'EDGE_01');
    const without = r.lines.find(x => x.load_id === 'EDGE_02');
    ck('a generated ticket comes through as a link', withPdf.pdf_link === 'https://d/1');
    // Null rather than omitted, so the client can show "no PDF yet" instead of
    // a dead row — "not generated" and "nothing here" must look different.
    ck('a load with no ticket yet reports null, not a missing field',
       'pdf_link' in without && without.pdf_link === null);
}

section('C — the totals under the column are the sum of the column');
{
    const r = getItemLines(LOADS, { description: 'Sealed Units' });
    ck('gross totals', r.totals.gross === 3300);
    ck('tare totals', r.totals.tare === 300);
    ck('net totals', r.totals.net === 3000);
    ck('amount totals', r.totals.amount === 1620);
    ck('and they equal the rows above them',
       r.totals.net === r.lines.reduce((a, x) => a + x.net_weight, 0));

    // The whole point of the drill-down: it has to reconcile with the summary
    // it was opened from. If these disagree, one of them is lying about stock.
    const summary = getInventoryReport(LOADS, {}).byType.find(g => /sealed units/i.test(g.description));
    ck('the detail reconciles with the Inventory row it came from',
       Math.abs(summary.net - r.totals.net) < 0.005,
       'a group whose rows do not add up to its heading is worse than no drill-down');
}

section('D — filters and edges');
{
    const sep = getItemLines(LOADS, { description: 'Sealed Units', from: '2026-09-01', to: '2026-09-30' });
    ck('the date filter narrows it', sep.count === 2 && sep.totals.net === 2100);
    ck('  inclusive at the start', getItemLines(LOADS, { description: 'Sealed Units', from: '2026-08-10' }).count === 3);
    ck('  inclusive at the end', getItemLines(LOADS, { description: 'Sealed Units', to: '2026-08-10' }).count === 1);

    ck('a material with no lines is empty, not broken',
       getItemLines(LOADS, { description: 'Titanium' }).count === 0);
    ck('no description asks nothing and returns nothing',
       getItemLines(LOADS, {}).count === 0 && getItemLines(LOADS, { description: '  ' }).count === 0);
    ck('no loads at all is handled', getItemLines([], { description: 'Sealed Units' }).count === 0);
    ck('a load with no items array does not throw',
       getItemLines([{ id: 'X', date: '2026-01-01' }], { description: 'Sealed Units' }).count === 0);

    ck('newest first', (() => {
        const l = getItemLines(LOADS, { description: 'Sealed Units' }).lines;
        return l[0].date >= l[l.length - 1].date;
    })());
}

// ── E. the bug found while writing this ───────────────────────────────────
section('E — /api/loads/<word> routes are not swallowed by /api/loads/:id');
{
    const src = require('../helpers/sourceParts').apiSource();
    const at = (p) => src.indexOf(`app.get('${p}'`);
    const byId = at('/api/loads/:id');
    ck('/api/loads/:id is registered', byId > 0);

    // Express matches in registration order and ':id' matches ANY single
    // segment, so every literal path under /api/loads has to come first.
    for (const p of ['/api/loads/lookup', '/api/loads/stock', '/api/loads/stock/suggest',
                     '/api/loads/inventory', '/api/loads/inventory/items', '/api/loads/next-number']) {
        ck(`${p} is registered BEFORE :id`, at(p) > 0 && at(p) < byId,
           'registered after, it is unreachable — the :id handler answers 404 for a load with that name');
    }

    // And prove the rule rather than just the line order, so this keeps
    // meaning something if the file is reorganised.
    const express = require('express');
    const mk = (order) => {
        const app = express();
        for (const r of order) app.get(r, (q, res) => res.json({ matched: r, id: q.params.id }));
        return app;
    };
    const hit = (app, url) => new Promise((resolve) => {
        const srv = app.listen(0, async () => {
            const res = await fetch(`http://127.0.0.1:${srv.address().port}${url}`);
            const body = await res.json();
            srv.close(); resolve(body);
        });
    });
    Promise.all([
        hit(mk(['/api/loads/:id', '/api/loads/lookup']), '/api/loads/lookup'),
        hit(mk(['/api/loads/lookup', '/api/loads/:id']), '/api/loads/lookup'),
    ]).then(([wrong, right]) => {
        ck('  :id first really does swallow it', wrong.matched === '/api/loads/:id' && wrong.id === 'lookup',
           'this is what production was doing — the sales page load search got 404');
        ck('  the literal first really does win', right.matched === '/api/loads/lookup');
        clientChecks().then(rangeChecks).then(done);
    });
}

// ── F. the clients, driven for real ───────────────────────────────────────
// jsdom, the shipped HTML, a faked network. Source-matching would not catch
// the thing most likely to break here: the toggles are re-bound after every
// repaint, and a missed re-bind leaves a row that looks clickable and is not.
function clientChecks() {
    let JSDOM, VirtualConsole;
    try { ({ JSDOM, VirtualConsole } = require('jsdom')); }
    catch (e) {
        console.log('  SKIP  jsdom is not installed — `npm i -D jsdom` to run the client checks');
        return Promise.resolve();
    }
    const INV = { loadCount: 2, unit: 'lb', onHandAvailable: true, byDay: [], bySeller: [],
        byType: [{ description: 'Sealed Units', count: 3, gross: 3300, tare: 300, net: 3000, amount: 1620, shipped: 0, onHand: 3000 },
                 { description: 'Copper', count: 1, gross: 500, tare: 50, net: 450, amount: 900, shipped: 0, onHand: 450 }] };
    const LINES = { description: 'Sealed Units', count: 2,
        totals: { gross: 3300, tare: 300, net: 3000, amount: 1620, unit: 'lb' },
        lines: [
            { load_id: 'EDGE_02', date: '2026-09-01', seller: 'Vega', pdf_link: null, description: 'Sealed Units', gross_weight: 2000, tare_weight: 200, net_weight: 1800, price: 0.55, amount: 990, unit: 'lb' },
            { load_id: 'EDGE_01', date: '2026-08-10', seller: 'Acme', pdf_link: 'https://d/1', description: 'Sealed Units', gross_weight: 1000, tare_weight: 100, net_weight: 900, price: 0.5, amount: 450, unit: 'lb' },
        ] };

    const html = require('../helpers/sourceParts').indexHtml();
    const errs = []; const vc = new VirtualConsole(); vc.on('jsdomError', (e) => errs.push(e.message));
    let opened = null;
    const dom = new JSDOM(html, { runScripts: 'dangerously', virtualConsole: vc, url: 'https://edge.local/', pretendToBeVisual: true,
        beforeParse(w) {
            w.fetch = async (u) => ({ ok: true, status: 200,
                json: async () => (String(u).includes('inventory/items') ? LINES : (String(u).includes('/api/loads/inventory') ? INV : {})),
                text: async () => '{}' });
            w.open = (u) => { opened = u; };
        } });

    return new Promise((resolve) => setTimeout(async () => {
        const w = dom.window, d = w.document;
        w.eval('ROLE="admin"');
        await w.renderInventory(INV);
        ck('client: the page renders without error', errs.length === 0, errs[0]);

        const toggles = d.querySelectorAll('[data-inv-toggle]');
        ck('client: every item type is a toggle', toggles.length === 2);
        ck('client: the panels start closed',
           Array.from(d.querySelectorAll('[data-inv-lines]')).every((e) => e.style.display === 'none'));

        Array.from(toggles).find((t) => t.getAttribute('data-inv-toggle') === 'Sealed Units')
            .dispatchEvent(new w.Event('click'));
        await new Promise((r) => setTimeout(r, 120));

        const panel = d.querySelector('[data-inv-lines="Sealed Units"]');
        const txt = panel.textContent;
        ck('client: selecting a type opens its lines', panel.style.display === 'block');
        ck('client: one row per matching line', d.querySelectorAll('.inv-line-row').length === 2);
        ck('client: gross, tare and net are shown', /2,?000/.test(txt) && /200/.test(txt) && /1,?800/.test(txt));
        ck('client: price and amount are shown', /0\.55/.test(txt) && /\$990\.00/.test(txt));
        ck('client: the totals row sums the column', /3,?000/.test(txt) && /\$1,620\.00/.test(txt));
        ck('client: a load with no ticket says so', /no ticket/.test(txt),
           '"not generated yet" and "nothing here" have to look different');

        const rows = d.querySelectorAll('.inv-line-row');
        Array.from(rows).find((r) => r.dataset.load === 'EDGE_01').dispatchEvent(new w.Event('click'));
        ck('client: clicking a row opens that load ticket', opened === 'https://d/1',
           'this is the whole point of the drill-down');
        opened = null;
        Array.from(rows).find((r) => r.dataset.load === 'EDGE_02').dispatchEvent(new w.Event('click'));
        ck('client: a row with no ticket does nothing rather than opening a dead tab', opened === null);

        // Only the other type left closed — one open panel at a time, so the
        // screen does not fill up after a few clicks.
        ck('client: the other type stayed closed',
           d.querySelector('[data-inv-lines="Copper"]').style.display === 'none');

        w.close();
        resolve();
    }, 900));
}

// ── G. the wiring, on EVERY path that paints those rows ───────────────────
// Apsara, 2026-09-02: "in inventory when i click item type sealed units, it is
// not displaying anything."
//
// My bug, and a specific kind: the toggles were wired only on the sub-tab
// SWITCH path, not on the initial render. The website's initial render happens
// to be the same function, so it worked there — I verified it there, and
// shipped both clients. One tested, two shipped.
//
// The wiring now lives in wireInvLineToggles and every paint path calls it.
// These assertions are about the CALL SITES, because the function being
// correct was never the problem.
section('G — a paint path without wiring is a dead feature');
for (const [name, file] of [['app', 'mobile-app/www/index.html'], ['website', 'dashboard/index.html']]) {
    const src = file === 'dashboard/index.html' ? require('../helpers/sourceParts').indexHtml()
        : file === 'mobile-app/www/index.html' ? require('../helpers/sourceParts').mobileHtml() : fs.readFileSync(path.join(ROOT, file), 'utf8');

    ck(`${name}: the wiring is one shared function`, /function wireInvLineToggles\(from, to\)/.test(src),
       'inline copies are how one path keeps it and another quietly does not');

    // Count the paints against the wirings. Every place that writes those rows
    // into the DOM has to be followed by a call.
    const paints = (src.match(/INV_SUBTAB_RENDER\[[a-zA-Z]*[sS]ubTab\]/g) || []).length;
    const wirings = (src.match(/wireInvLineToggles\(/g) || []).length - 1;   // minus the definition
    ck(`${name}: every render of the rows is wired`, wirings >= 2 && wirings >= paints - 1,
       `${paints} paint sites, ${wirings} wiring calls — a paint without a wiring is a type you can tap that does nothing`);
}
{
    // The app specifically: the initial render is paintInventory, NOT the
    // sub-tab switch. That is the path that was broken, so it gets named.
    const app = require("../helpers/sourceParts").mobileHtml();
    // Brace-matched. The first version sliced from paintInventory to
    // renderInventoryTab — which sits EARLIER in the file, so the slice was
    // empty and the assertion failed against a correct fix.
    const bodyOf = (src, name) => {
        const i = src.indexOf('function ' + name + '(');
        if (i < 0) return '';
        let d = 0, k = src.indexOf('{', i);
        for (; k < src.length; k++) {
            if (src[k] === '{') d++;
            else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
        }
        return src.slice(i);
    };
    const paint = bodyOf(app, 'paintInventory');
    ck('app: the FIRST render wires the toggles', /wireInvLineToggles\(mobInvFrom, mobInvTo\)/.test(paint),
       'this exact omission is what made tapping an item type do nothing on a freshly opened tab');
    ck('app: and so does the sub-tab switch',
       /wireInvLineToggles\(mobInvFrom, mobInvTo\)/.test(bodyOf(app, 'paintInvSubtab')));
}

function done() {

// ── EVERY DATALIST IS ACTUALLY WIRED TO AN INPUT ─────────────────────────
// Apsara's #218: the Supplier field on this screen has never offered a
// dropdown. `<datalist id="suplist">` was there from the day it was written
// and $('suplist').innerHTML was filled on every load — but no input carried
// list="suplist", so the browser never connected them. Her staff typed
// supplier names from memory into a field that had the answers sitting
// beside it. Nine lines below, yardlist was wired correctly all along.
//
// A filled datalist nobody points at is the same defect class as a route
// with no caller: everything looks present, nothing happens. Checked across
// EVERY dashboard screen rather than this one, because the next person adding
// a datalist deserves to be told at test time — suplist was the only dead one
// in the whole dashboard and it stayed dead for months.
{
    section('datalists are wired to an input');
    const files = fs.readdirSync(path.join(ROOT, 'dashboard'))
        .filter((f) => f.endsWith('.html'));
    const dead = [];
    for (const f of files) {
        const html = fs.readFileSync(path.join(ROOT, 'dashboard', f), 'utf8');
        const ids = [...html.matchAll(/<datalist id="([^"]+)"/g)].map((m) => m[1]);
        const used = new Set([...html.matchAll(/\blist="([^"]+)"/g)].map((m) => m[1]));
        for (const id of ids) if (!used.has(id)) dead.push(`${f}#${id}`);
    }
    ck('every datalist in dashboard/ is referenced by an input list=',
       dead.length === 0, dead.join(', ') + ' — filled on load and connected to nothing');
    // The control: if the scan finds no datalists at all it proves nothing.
    const total = files.reduce((n, f) => n
        + [...fs.readFileSync(path.join(ROOT, 'dashboard', f), 'utf8')
            .matchAll(/<datalist id="/g)].length, 0);
    ck('  and there are datalists to check, so this is not vacuous',
       total >= 2, `${total} found across ${files.length} screens`);
    // The one she reported, by name, so a future edit that drops the
    // attribute again fails with her words rather than a generic count.
    const inv = fs.readFileSync(path.join(ROOT, 'dashboard', 'edge-inventory.html'), 'utf8');
    ck('  Supplier on Edge Inventory offers the supplier list (#218)',
       /id="rm_supplier"[^>]*\blist="suplist"/.test(inv),
       'the datalist is filled every load; without list= the dropdown never appears');
}

    console.log(`\n  ${pass} passed, ${fail} failed`);
    if (failures.length) { console.log('\n  Failed:'); failures.forEach((f) => console.log('   - ' + f)); }
    try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch (e) {}
    process.exit(fail ? 1 : 0);
}

// ── G ──
async function rangeChecks() {
    // ── G. Apsara 2026-11-15: range 11/13-11/13 listed Rotors lines dated 11/09-11/11 ──
    // The lines are fetched per range but were cached by item name alone and never emptied, so the
    // lines fetched under an earlier range were shown under the new one. Runs the real client code.
    section('G. the item lines follow the date range, on both clients');
    {
        const vm = require('vm');
        for (const [label, files] of [['website', ['dashboard/app/05-load-pricing.js']], ['phone', ['mobile-app/www/app/11-reports.js', 'mobile-app/www/app/13-inventory.js']]]) {
            const src = files.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
            const grab = (re) => { const m = src.match(re); return m ? m[0] : ''; };
            const code = [
                grab(/const invLinesCache = \{\}[^\n]*\n/), grab(/let invLinesOpen = null;[^\n]*\n/), grab(/let invLinesRange = null;[^\n]*\n/),
                grab(/async function toggleInvLines[\s\S]*?\n\}\n/), grab(/function wireInvLineToggles[\s\S]*?\n\}\n/),
            ].join('\n');
            const urls = [];
            const ctx = { document: { querySelectorAll: () => [] }, renderInvLines: () => {}, esc: (x) => x,
                api: async (u) => { urls.push(u); return { count: 1, lines: [], totals: {}, u }; } };
            vm.createContext(ctx);
            vm.runInContext(code + '\n;this.api2 = { toggleInvLines, wireInvLineToggles, cache: invLinesCache, open: () => invLinesOpen };', ctx);
            const A = ctx.api2;
            ck(label + ': the code under test was found', code.includes('wireInvLineToggles') && code.includes('toggleInvLines'));
            A.wireInvLineToggles('', '');                       // Inventory opened with no dates
            await A.toggleInvLines('Rotors', '', '');           // she opens Rotors: every line
            ck(label + ': opening Rotors fetched them with no range', urls.length === 1 && !/from=/.test(urls[0]), urls.join(' '));
            A.wireInvLineToggles('2026-11-13', '2026-11-13');   // she applies 11/13 - 11/13
            ck(label + ': a new range empties what was fetched for the old one', Object.keys(A.cache).length === 0 && A.open() === null);
            await A.toggleInvLines('Rotors', '2026-11-13', '2026-11-13');
            ck(label + ': opening Rotors again fetches for the new range', urls.length === 2 && /from=2026-11-13/.test(urls[1]) && /to=2026-11-13/.test(urls[1]), urls.join(' '));
            A.wireInvLineToggles('2026-11-13', '2026-11-13');   // a repaint with the SAME range
            ck(label + ': a repaint with the same range keeps it (no refetch on every redraw)', Object.keys(A.cache).length === 1 && A.open() === 'Rotors');
        }
    }


    // ── I. the headline "on hand" summed NET IN ──
    section('I. the Inventory headline says what it is (website)');
    {
        const vm = require('vm');
        const src = fs.readFileSync(path.join(ROOT, 'dashboard/app/02-dashboard-bookings.js'), 'utf8');
        const fn = src.slice(src.indexOf('function invHeadlineStat'), src.indexOf('async function renderInventory'));
        const ctx = { esc: (x) => String(x) }; vm.createContext(ctx); vm.runInContext(fn + '\n;this.f = invHeadlineStat;', ctx);
        const rows = [{ description: 'Rotors', net: 293511, shipped: 277515, onHand: 15996 }, { description: 'HMS', net: 1000, shipped: 0, onHand: 1000 }];
        const whole = ctx.f({ unit: 'lb', onHandAvailable: true, byType: rows });
        ck('whole history: "on hand" is the sum of on hand, so it falls after a sale', whole[0] === 'on hand' && whole[1] === '16,996 lb', JSON.stringify(whole));
        const afterSale = ctx.f({ unit: 'lb', onHandAvailable: true, byType: [{ ...rows[0], shipped: 277515 + 1000, onHand: 14996 }, rows[1]] });
        ck('  a further sale of 1,000 lb lowers it by 1,000', afterSale[1] === '15,996 lb', JSON.stringify(afterSale));
        const ranged = ctx.f({ unit: 'lb', onHandAvailable: false, byType: rows });
        ck('date range: it says "came in", not "on hand"', ranged[0] === 'came in' && ranged[1] === '294,511 lb', JSON.stringify(ranged));
    }

    // ── H. Apsara 2026-11-15: "it should get refreshed auto" - the open Inventory tab follows the data ──
    section('H. the open Inventory tab refreshes itself when the figures change');
    {
        const vm = require('vm');
        const mk = (extra) => {
            const calls = { api: 0, render: 0 }; const timers = []; const listeners = [];
            const doc = { visibilityState: 'visible', activeElement: null, addEventListener: (ev, fn) => listeners.push([ev, fn]) };
            const ctx = { document: doc, calls, timers, listeners, URLSearchParams,
                setInterval: (fn, ms) => { timers.push([fn, ms]); return 1; },
                $: (id) => (ctx.present && id === 'btnInvApply' ? {} : null), present: true,
                Promise, JSON, ...extra };
            vm.createContext(ctx); return ctx;
        };
        // website
        {
            const src = fs.readFileSync(path.join(ROOT, 'dashboard/app/02-dashboard-bookings.js'), 'utf8');
            const blk = src.slice(src.indexOf('const INV_REFRESH_MS'));
            const ctx = mk({});
            let server = { n: 1 };
            ctx.api = async () => { ctx.calls.api++; return { ...server }; };
            ctx.renderInventory = () => { ctx.calls.render++; };
            vm.runInContext("let invData = { n: 1 }; let invFrom = ''; let invTo = '';\n" + blk + "\n;this.run = inventoryAutoRefresh;", ctx);
            ck('website: it is scheduled (every 30s) and re-checks when the tab is brought back', ctx.timers.length === 1 && ctx.timers[0][1] === 30000 && ctx.listeners.some(([e]) => e === 'visibilitychange'));
            await ctx.run();
            ck('website: figures unchanged -> no repaint', ctx.calls.api === 1 && ctx.calls.render === 0);
            server = { n: 2 }; await ctx.run();
            ck('website: figures changed (a sale was saved) -> repaints', ctx.calls.render === 1, JSON.stringify(ctx.calls));
            ctx.document.activeElement = { id: 'inv_from' }; const n0 = ctx.calls.api; await ctx.run();
            ck('website: not while a date box is being typed in', ctx.calls.api === n0);
            ctx.document.activeElement = null; ctx.document.visibilityState = 'hidden'; await ctx.run();
            ck('website: not while the page is hidden', ctx.calls.api === n0);
            ctx.document.visibilityState = 'visible'; ctx.present = false; await ctx.run();
            ck('website: not when another tab is showing', ctx.calls.api === n0);
        }
        // phone
        {
            const src = fs.readFileSync(path.join(ROOT, 'mobile-app/www/app/13-inventory.js'), 'utf8');
            const blk = src.slice(src.indexOf('const MOB_INV_REFRESH_MS'));
            const ctx = mk({}); ctx.renders = 0;
            ctx.renderInventoryTab = async () => { ctx.renders++; };
            vm.runInContext("let currentMobileTab = 'inventory';\n" + blk + "\n;this.run = mobInventoryAutoRefresh; this.setTab = (t) => { currentMobileTab = t; };", ctx);
            ck('phone: scheduled every 30s, and on coming back to the front', ctx.timers.length === 1 && ctx.timers[0][1] === 30000 && ctx.listeners.some(([e]) => e === 'visibilitychange'));
            ctx.run(); ck('phone: refreshes when Inventory is the open tab', ctx.renders === 1);
            ctx.setTab('loads'); ctx.run(); ck('phone: not when another tab is open', ctx.renders === 1);
            ctx.setTab('inventory'); ctx.document.activeElement = { id: 'inv_to' }; ctx.run(); ck('phone: not while typing a date', ctx.renders === 1);
            ctx.document.activeElement = null; ctx.document.visibilityState = 'hidden'; ctx.run(); ck('phone: not while hidden', ctx.renders === 1);
        }
    }
}
