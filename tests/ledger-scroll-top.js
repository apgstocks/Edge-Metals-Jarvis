// ── tests/ledger-scroll-top.js ────────────────────────────────────────────
// Apsara, 2026-09-29: "There should be a arrow button in the bill/invoice
// when i scroll down to move to the top bill".
//
// ── WHY THIS FILE EXISTS AT ALL ───────────────────────────────────────────
// A back-to-top button is the most testable-looking thing in the world and
// the easiest to ship broken, because THIS PAGE DOES NOT SCROLL THE WINDOW.
//
//   body { ... overflow:hidden; }                        (index.html ~line 74)
//   <div id="viewRoot" style="flex:1; overflow-y:auto;">  (index.html ~line 445)
//
// The document never scrolls; #viewRoot does. So window.scrollTo(0, 0) — the
// line every example on the internet gives you — is a no-op here. The button
// would render in the right corner, hover, depress, and move the list not one
// pixel, and a test that only checked "the button exists" would be green the
// whole time.
//
// So the checks below are about BEHAVIOUR: which element gets scrolled, and
// whether the button is on screen at the moment she needs it.
//
// ── THE SECOND FAILURE, WHICH IS INVISIBLE ────────────────────────────────
// #viewRoot OUTLIVES the tab. renderLedgerTab re-runs on every filter change,
// every save, every import — so a scroll listener attached without removing
// the previous one accumulates. Twenty filter changes over a morning is
// twenty handlers, all firing on every scroll event of a long ledger. Nothing
// breaks; the page just gets slower all day and recovers on reload, which is
// the hardest kind of bug to be told about. Section C counts them.
//
// ── SCOPE ─────────────────────────────────────────────────────────────────
// renderLedgerTab is reached with 'bills' and 'sales' ONLY — every call site
// was checked before this was written. Section D holds that line: if someone
// later routes a third screen through this function, the button follows it
// there silently, and that is the shape of over-reach this repo keeps paying
// for.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-scrolltop-'));
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const bills = require(path.join(ROOT, 'helpers/bills'));
const sales = require(path.join(ROOT, 'helpers/sales'));

let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (e) { /* reported below */ }

const html = fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8');
const SCRIPT = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]).join('\n');

// ── FIXTURES ──────────────────────────────────────────────────────────────
// Enough rows that scrolling is the natural thing to do, which is the whole
// premise of the feature.
const BILL_ROWS = Array.from({ length: 24 }, (_, i) => ({
    id: `B${i + 1}`, route: 'OAKLAND / BUSAN', carrier: 'HMM',
    supplier: i % 2 ? 'Oakland Metals' : 'Calderon',
    trucking_company: 'Sher Trucking',
    date: `08/${String((i % 28) + 1).padStart(2, '0')}/2026`,
    booking_no: `DALA${1000 + i}`, container_no: `HMMU${2000000 + i}`, photos: [],
    gross: 40000, truck: 14000, container: 8000, chassis: 6000, boxes: 400,
    supplier_price: 700,
})).map(bills.withTotals);

const SALE_ROWS = Array.from({ length: 24 }, (_, i) => ({
    id: `S${i + 1}`, customer: i % 2 ? 'MK Trading' : 'SOLINE METAL',
    date: `08/${String((i % 28) + 1).padStart(2, '0')}/2026`,
    booking_no: `DALA${1000 + i}`, container_no: `HMMU${2000000 + i}`, photos: [],
    gross: 40000, truck: 14000, container: 8000, chassis: 6000, boxes: 400,
    customer_price: 900,
})).map(sales.withTotals);

const billsRoute = (q) => {
    const rows = bills.filterRows(BILL_ROWS, q);
    return { bills: rows, summary: bills.summary(rows), columns: bills.tableColumns(),
             fields: bills.COLUMNS, groups: bills.GROUPS, writable: bills.WRITABLE,
             facets: bills.facets(BILL_ROWS), filterable: bills.FILTERABLE,
             total_unfiltered: BILL_ROWS.length };
};
const salesRoute = (q) => {
    const rows = sales.filterRows(SALE_ROWS, q);
    return { sales: rows, summary: sales.summary(rows), columns: sales.tableColumns(),
             fields: sales.COLUMNS, groups: sales.GROUPS, writable: sales.WRITABLE,
             facets: sales.facets(SALE_ROWS), filterable: sales.FILTERABLE,
             duplicates: [], total_unfiltered: SALE_ROWS.length };
};

async function mount(routes) {
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
    const w = dom.window;
    try { w.eval(`${SCRIPT}\n;IS_SUPER = true;`); } catch (e) { return { w, dom, err: e }; }
    w.api = async (p) => {
        const [base, qs] = String(p).split('?');
        const q = Object.fromEntries(new w.URLSearchParams(qs || ''));
        const hit = routes[base];
        if (!hit) return {};
        return typeof hit === 'function' ? hit(q) : hit;
    };
    await new Promise((r) => setTimeout(r, 60));
    return { w, dom };
}

// jsdom has no layout, so an element's scrollTop is always 0 and never moves
// on its own. Both are given a real backing value here — otherwise every
// check below would be asserting against a constant.
function makeScrollable(w) {
    const el = w.document.getElementById('viewRoot');
    let top = 0;
    Object.defineProperty(el, 'scrollTop', {
        configurable: true,
        get: () => top,
        set: (v) => { top = Number(v) || 0; },
    });
    const calls = [];
    el.scrollTo = (opts) => { calls.push(opts); top = Number(opts && opts.top) || 0; };
    const scrollTo = (y) => { top = y; el.dispatchEvent(new w.Event('scroll')); };
    return { el, calls, scrollTo };
}

(async () => {

if (!JSDOM) {
    console.log('\n  SKIPPED — jsdom is not installed, so the page cannot be rendered.');
    console.log('  This is not a pass. Run `npm install` and re-run.');
    process.exit(1);
}

// ══════════════════════════════════════════════════════════════════════════
section('A — the button is there, on both ledgers');
// ══════════════════════════════════════════════════════════════════════════
{
    const { w, dom, err } = await mount({ '/api/bills': billsRoute });
    ck('the page script runs without throwing', !err, err && err.message);
    makeScrollable(w);
    await w.renderLedgerTab('bills');

    const btn = w.document.getElementById('ledTop');
    ck('bills has a back-to-top button', !!btn);
    ck('  it is an arrow, not a word', !!btn && !!btn.querySelector('svg'),
       btn ? btn.innerHTML.slice(0, 60) : 'no button');
    ck('  it names what it goes back to', !!btn && /bill/i.test(btn.getAttribute('title') || ''),
       btn ? btn.getAttribute('title') : '');
    ck('  and says so to a screen reader too',
       !!btn && (btn.getAttribute('aria-label') || '').length > 4,
       btn ? btn.getAttribute('aria-label') : '');

    // Inside the tab's own markup — so leaving the tab takes it with it,
    // rather than leaving a floating arrow on the Reports screen.
    ck('  it lives inside the view, not loose on the page',
       !!btn && w.document.getElementById('viewRoot').contains(btn));
    dom.window.close();
}
{
    const { w, dom } = await mount({ '/api/sales': salesRoute });
    makeScrollable(w);
    await w.renderLedgerTab('sales');
    const btn = w.document.getElementById('ledTop');
    ck('invoices has one as well', !!btn);
    ck('  and calls it an invoice, in her words',
       !!btn && /invoice/i.test(btn.getAttribute('title') || ''),
       btn ? btn.getAttribute('title') : '');
    dom.window.close();
}

// ══════════════════════════════════════════════════════════════════════════
section('B — IT SCROLLS #viewRoot, NOT THE WINDOW');
// ══════════════════════════════════════════════════════════════════════════
// The check this file was written for. window.scrollTo(0,0) on this page is
// a no-op: body is overflow:hidden and the scrolling box is #viewRoot.
{
    const { w, dom } = await mount({ '/api/bills': billsRoute });
    const S = makeScrollable(w);

    let windowScrolled = false;
    w.scrollTo = () => { windowScrolled = true; };
    w.document.documentElement.scrollTo = () => { windowScrolled = true; };

    await w.renderLedgerTab('bills');
    const btn = w.document.getElementById('ledTop');

    S.scrollTo(900);
    btn.click();

    ck('clicking it scrolls the view container', S.calls.length === 1, String(S.calls.length));
    ck('  all the way to the top', S.calls[0] && Number(S.calls[0].top) === 0,
       JSON.stringify(S.calls[0] || null));
    ck('  and #viewRoot really moved', S.el.scrollTop === 0, String(S.el.scrollTop));
    ck('  it does NOT call window.scrollTo, which does nothing on this page',
       !windowScrolled, 'a window scroll here is the dead-button bug');
    dom.window.close();
}

// ══════════════════════════════════════════════════════════════════════════
section('C — it appears only once she has scrolled, and ONE listener');
// ══════════════════════════════════════════════════════════════════════════
{
    const { w, dom } = await mount({ '/api/bills': billsRoute });
    const S = makeScrollable(w);

    // Count scroll listeners on #viewRoot across re-renders. renderLedgerTab
    // runs again on every filter change and #viewRoot survives all of them.
    let live = 0;
    const addReal = S.el.addEventListener.bind(S.el);
    const remReal = S.el.removeEventListener.bind(S.el);
    S.el.addEventListener = (t, f, o) => { if (t === 'scroll') live += 1; return addReal(t, f, o); };
    S.el.removeEventListener = (t, f, o) => { if (t === 'scroll') live -= 1; return remReal(t, f, o); };

    await w.renderLedgerTab('bills');
    let btn = w.document.getElementById('ledTop');
    ck('at the top of the list it is out of the way', btn.style.display === 'none',
       btn.style.display);

    S.scrollTo(700);
    btn = w.document.getElementById('ledTop');
    ck('  scrolled down, it is on screen', btn.style.display !== 'none', btn.style.display);
    ck('  and not left transparent', btn.style.opacity === '1', btn.style.opacity);

    S.scrollTo(0);
    ck('  back at the top it hides again', btn.style.display === 'none', btn.style.display);

    ck('one scroll listener after the first render', live === 1, String(live));

    // Six filter changes' worth of re-renders.
    for (let i = 0; i < 6; i += 1) await w.renderLedgerTab('bills');
    ck('  STILL one after six re-renders', live === 1,
       `${live} handlers — every one of them fires on every scroll event`);

    // A re-render while she is scrolled down must not lose the button: the
    // scroll position survives the render, so waiting for the next scroll
    // event would leave her stranded with no way back up.
    S.el.scrollTop = 800;
    await w.renderLedgerTab('bills');
    btn = w.document.getElementById('ledTop');
    ck('re-rendering while scrolled down keeps it visible', btn.style.display !== 'none',
       btn.style.display);
    dom.window.close();
}

// ══════════════════════════════════════════════════════════════════════════
section('D — SCOPE: the two screens she named, and no others');
// ══════════════════════════════════════════════════════════════════════════
// The rule this repo keeps relearning: a request about one screen changes
// that screen. renderLedgerTab happens to serve exactly bills and sales
// today. If a third screen is ever routed through it, this button arrives
// there without anyone deciding that — so the call sites are asserted, not
// assumed.
{
    const calls = [...html.matchAll(/renderLedgerTab\(\s*(['"])(\w+)\1\s*\)/g)].map((m) => m[2]);
    const kinds = [...new Set(calls)].sort();
    ck('renderLedgerTab is called with bills and sales only',
       kinds.join(',') === 'bills,sales',
       `called with: ${kinds.join(',')} — a new kind here inherits the button`);

    // And the button is not pasted into any other screen's markup.
    const ids = (html.match(/id="ledTop"/g) || []).length;
    ck('  and #ledTop is declared exactly once', ids === 1, String(ids));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error(e); process.exit(1); });
