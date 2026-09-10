// ── tests/ledger-render.js ────────────────────────────────────────────────
// Apsara, 2026-09-10: "Why edit option not there in bills?"
//
// It WAS there — in the file and in the commit — and I could only tell her so
// by grepping the source, which proves a string exists and not that a button
// appears. That is the weak-assertion trap this whole suite exists to avoid,
// and I had walked into it: tests/bills-sales.js checks
// /class="btn btn-secondary ledger-edit"/ against the HTML, which would stay
// green if renderLedgerTab never ran, threw, or drew no rows at all.
//
// So this file RENDERS the page. jsdom, the real dashboard/index.html, the
// real helpers for the payload, and then it asks the DOM what is on screen.
// It is the difference between "the code says Edit" and "there is an Edit
// button on the row".
//
// The window is closed at the end. A jsdom window keeps timers alive and the
// process hangs without it — which is exactly what happened to the throwaway
// probe this file replaces.

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

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ledger-'));
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const bills = require(path.join(ROOT, 'helpers/bills'));
const sales = require(path.join(ROOT, 'helpers/sales'));

let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (e) { /* reported below */ }

const html = fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8');
const SCRIPT = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]).join('\n');

// Stands the page up and hands back the window, with api() replaced. The stub
// is installed AFTER the script runs, because the page defines its own api()
// which would otherwise overwrite it and try to reach the network — the first
// version of this got that backwards and reported zero rows, which looked
// exactly like the bug being investigated.
// ── AND THE PAGE'S OWN BOOT HAS TO SETTLE FIRST ──────────────────────────
// The script boots itself: it calls loadTab(), which writes "Loading…" into
// #viewRoot and then awaits. Rendering before that finishes means the boot
// resumes AFTERWARDS and overwrites the table with the placeholder — which
// looked exactly like "renderLedgerTab drew nothing", and cost me a wrong
// diagnosis before I printed the element instead of the assertion.
async function mount(routes) {
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
    const w = dom.window;
    try { w.eval(SCRIPT); } catch (e) { return { w, dom, err: e }; }
    w.api = async (p, opts) => {
        const [base, qs] = String(p).split('?');
        const q = Object.fromEntries(new w.URLSearchParams(qs || ''));
        const hit = routes[base];
        if (!hit) return {};
        return typeof hit === 'function' ? hit(q, opts) : hit;
    };
    // Let whatever the boot started run to completion against the stub, so
    // nothing it does lands on top of the render below.
    await new Promise((r) => setTimeout(r, 60));
    return { w, dom };
}

// jsdom normalises "#1C1B19" to "rgb(28, 27, 25)" the moment anything else
// touches the element, so styles are compared by value rather than by string.
const rgbEq = (got, hex) => {
    const h = String(hex || '').replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    const s = String(got || '').replace(/\s/g, '');
    return s === `rgb(${r},${g},${b})` || s.toLowerCase() === `#${h}`.toLowerCase();
};

const BILL_ROWS = [
    { id: 'B1', route: 'HOUSTON / BUSAN', carrier: 'MSC', supplier: 'Eccomelt',
      trucking_company: 'Bayou Haulage', date: '09/10/2026', booking_no: '272766480',
      container_no: 'MSKU1111111', seal_no: 'S1', description: 'Auto cast',
      photos: ['https://drive.example.com/a.jpg', 'https://drive.example.com/b.jpg'],
      gross: 44000, truck: 15000, container: 8000, chassis: 6000, boxes: 500,
      supplier_price: 0.32, trucking_amount: 1200 },
    { id: 'B2', route: 'OAKLAND / BUSAN', carrier: 'HMM', supplier: 'Oakland Metals',
      trucking_company: 'Sher Trucking', date: '08/02/2026', booking_no: 'DALA1',
      container_no: 'HMMU2222222', photos: [],
      gross: 40000, truck: 14000, container: 8000, chassis: 6000, boxes: 400,
      supplier_price: 700 },
].map(bills.withTotals);

const billsRoute = (q) => {
    const rows = bills.filterRows(BILL_ROWS, q);
    return { bills: rows, summary: bills.summary(rows), columns: bills.tableColumns(),
             fields: bills.COLUMNS, groups: bills.GROUPS, writable: bills.WRITABLE,
             facets: bills.facets(BILL_ROWS), filterable: bills.FILTERABLE,
             total_unfiltered: BILL_ROWS.length };
};

(async () => {

if (!JSDOM) {
    console.log('\n  SKIPPED — jsdom is not installed, so the page cannot be rendered.');
    console.log('  This is not a pass. Run `npm install` and re-run.');
    process.exit(1);
}

section('A — the table actually draws');
{
    const { w, dom, err } = await mount({ '/api/bills': billsRoute });
    ck('the page script runs without throwing', !err, err && err.message);
    ck('  and renderLedgerTab exists', typeof w.renderLedgerTab === 'function');
    await w.renderLedgerTab('bills');
    const root = w.document.getElementById('viewRoot');
    ck('  it puts something in the view', root && root.innerHTML.length > 500,
       root ? String(root.innerHTML.length) : 'no viewRoot');
    ck('every bill gets a row', root.querySelectorAll('tbody tr[data-id]').length === 2,
       String(root.querySelectorAll('tbody tr[data-id]').length));

    // ── HER QUESTION, ANSWERED BY THE DOM ────────────────────────────────
    const edits = root.querySelectorAll('.ledger-edit');
    ck('every row has an Edit button', edits.length === 2, String(edits.length));
    ck('  labelled "Edit"', edits.length && edits[0].textContent.trim() === 'Edit',
       edits.length ? edits[0].textContent.trim() : '(none)');
    ck('  carrying the row id it will edit',
       [...edits].map((b) => b.dataset.id).join(',') === 'B1,B2',
       [...edits].map((b) => b.dataset.id).join(','));
    ck('  and Delete is still there beside it',
       root.querySelectorAll('.ledger-del').length === 2);
    dom.window.close();
}

section('B — carrier is off the table and still on the form');
{
    // Apsara: "on bill after saving,i dont want carrier to be displayed.on
    // edit it can be there."
    const { w, dom } = await mount({ '/api/bills': billsRoute });
    await w.renderLedgerTab('bills');
    const root = w.document.getElementById('viewRoot');
    // The 'ƒ' marker on computed columns is part of the heading's text, so
    // it is stripped before comparing — otherwise "Net weight (lbs)" never
    // matches "Net weight (lbs) ƒ" and a correct table looks broken.
    const heads = [...root.querySelectorAll('thead th')]
        .map((t) => t.textContent.replace(/ƒ/g, '').trim());
    ck('no Carrier column in the table', !heads.includes('Carrier'), heads.join(' | '));
    ck('  but the columns she DID ask for are there',
       ['Source/Destination', 'Supplier', 'Net weight (lbs)', 'Balance'].every((h) => heads.includes(h)),
       heads.join(' | '));
    ck('  and MSC is nowhere in the rendered rows',
       !/\bMSC\b/.test(root.querySelector('tbody').textContent),
       'the value is still stored — it is the column that is gone');

    w.openLedgerForm('bills');
    const form = w.document.getElementById('ledgerForm');
    ck('the form still has Carrier, so an edit can change it',
       !!form.querySelector('[name="carrier"]'),
       [...form.querySelectorAll('[name]')].map((i) => i.name).join(','));
    dom.window.close();
}

section('C — photos paste in as links');
{
    // Apsara: "In bill,i want photos field where url can be pasted."
    const { w, dom } = await mount({ '/api/bills': billsRoute });
    await w.renderLedgerTab('bills');
    const root = w.document.getElementById('viewRoot');
    const links = root.querySelectorAll('tbody a[href^="https://drive.example.com"]');
    ck('a bill with two photos shows two links', links.length === 2, String(links.length));
    ck('  opening in a new tab, safely',
       [...links].every((a) => a.target === '_blank' && /noopener/.test(a.rel)),
       [...links].map((a) => a.rel).join('|'));
    ck('  and a bill with none shows a dash, not an empty cell',
       /—/.test(root.querySelectorAll('tbody tr')[1].textContent));

    w.openLedgerForm('bills');
    const ta = w.document.querySelector('#ledgerForm textarea[name="photos"]');
    ck('the form gives it a textarea, not a one-line box', !!ta,
       'a container gets photographed several times');
    dom.window.close();
}

section('D — filters, and several at once');
{
    const { w, dom } = await mount({ '/api/bills': billsRoute });
    await w.renderLedgerTab('bills');
    const doc = w.document;
    const rowsNow = () => doc.querySelectorAll('#viewRoot tbody tr[data-id]').length;
    ck('both rows to start with', rowsNow() === 2, String(rowsNow()));

    const setFilter = async (key, val) => {
        const el = doc.querySelector(`[data-led-filter="${key}"]`);
        if (!el) return false;
        el.value = val;
        el.dispatchEvent(new w.Event('change'));
        await new Promise((r) => setTimeout(r, 30));
        return true;
    };

    ck('there is a search box', !!doc.querySelector('[data-led-filter="q"]'));
    ck('  and a supplier dropdown built from the data',
       [...doc.querySelectorAll('[data-led-filter="supplier"] option')].map((o) => o.value).join(',')
         === ',Eccomelt,Oakland Metals',
       [...doc.querySelectorAll('[data-led-filter="supplier"] option')].map((o) => o.value).join(','));

    await setFilter('supplier', 'Eccomelt');
    ck('one filter narrows it', rowsNow() === 1, String(rowsNow()));

    // "ultiple filters can also be applied" — they AND together.
    await setFilter('from', '09/01/2026');
    ck('  a second filter narrows further, not wider', rowsNow() === 1, String(rowsNow()));
    await setFilter('supplier', 'Oakland Metals');
    ck('  and a combination matching nothing shows nothing',
       rowsNow() === 0,
       'Oakland Metals is an August bill; with a September floor there is no row');

    doc.getElementById('ledClear').click();
    await new Promise((r) => setTimeout(r, 30));
    ck('Clear puts them all back', rowsNow() === 2, String(rowsNow()));

    await setFilter('q', 'HMMU2222222');
    ck('the search box finds a container number without naming the field',
       rowsNow() === 1, String(rowsNow()));
    dom.window.close();
}

section('E — the totals describe the rows on screen');
{
    // The reason filtering is server-side. Filtering in the browser would
    // leave the summary adding up rows that are no longer visible — a balance
    // belonging to a different set of bills.
    const { w, dom } = await mount({ '/api/bills': billsRoute });
    await w.renderLedgerTab('bills');
    const doc = w.document;
    const cardText = () => doc.getElementById('viewRoot').textContent;
    const both = bills.summary(BILL_ROWS);
    ck('unfiltered, the cards show the full total',
       cardText().includes(both.balance.toLocaleString('en-US', { minimumFractionDigits: 2 })),
       String(both.balance));

    const el = doc.querySelector('[data-led-filter="supplier"]');
    el.value = 'Eccomelt';
    el.dispatchEvent(new w.Event('change'));
    await new Promise((r) => setTimeout(r, 30));
    const one = bills.summary(bills.filterRows(BILL_ROWS, { supplier: 'Eccomelt' }));
    ck('  filtered, they show only what is on screen',
       cardText().includes(one.balance.toLocaleString('en-US', { minimumFractionDigits: 2 }))
       && one.balance !== both.balance,
       `${one.balance} vs ${both.balance}`);
    dom.window.close();
}

section('F — and the sales tab renders too');
{
    const SALE_ROWS = [{ id: 'S1', customer: 'Daekwang', date: '09/10/2026', invoice_no: 'INV-1',
        hbl_no: 'HBL-9', weight: 29000, invoice_price: 0.41, freight_charges: 1500 }]
        .map(sales.withTotals);
    const { w, dom } = await mount({ '/api/sales': (q) => {
        const rows = sales.filterRows(SALE_ROWS, q);
        return { sales: rows, summary: sales.summary(rows), columns: sales.tableColumns(),
                 fields: sales.COLUMNS, groups: sales.GROUPS, writable: sales.WRITABLE,
                 facets: sales.facets(SALE_ROWS), total_unfiltered: SALE_ROWS.length };
    } });
    await w.renderLedgerTab('sales');
    const root = w.document.getElementById('viewRoot');
    ck('the sale draws a row', root.querySelectorAll('tbody tr[data-id]').length === 1);
    ck('  with an Edit button', root.querySelectorAll('.ledger-edit').length === 1);
    ck('  and a customer dropdown, not a supplier one',
       !!w.document.querySelector('[data-led-filter="customer"]')
       && !w.document.querySelector('[data-led-filter="supplier"]'),
       'a sale has a customer where a bill has a supplier');
    dom.window.close();
}

section('F2 — a bill she just added is editable, and REACHABLE');
{
    // Apsara, 2026-09-10: "addedbill doesnt have an edit option.."
    //
    // The button was there the whole time. The table is 22 columns wide and
    // scrolls horizontally, so the actions cell sat roughly 2,400px past the
    // right edge of the screen — present in the DOM, unreachable in practice.
    // "It exists" is not "you can use it", and a jsdom test cannot see layout,
    // so what is asserted here is the thing that FIXES it: the cell is pinned.
    let store = [];
    const { w, dom } = await mount({});
    w.api = async (p, o) => {
        const [base] = String(p).split('?');
        if (o && o.method === 'POST' && base === '/api/bills') {
            const b = bills.withTotals({ id: 'NEW1', ...JSON.parse(o.body) });
            store = [b]; return { ok: true, bill: b };
        }
        if (o && o.method === 'PUT') {
            const b = bills.withTotals({ id: 'NEW1', ...JSON.parse(o.body) });
            store = [b]; return { ok: true, bill: b };
        }
        if (base === '/api/bills/preview') return bills.compute(JSON.parse((o && o.body) || '{}'));
        if (base === '/api/bills') {
            return { bills: store, summary: bills.summary(store), columns: bills.tableColumns(),
                     fields: bills.COLUMNS, groups: bills.GROUPS, writable: bills.WRITABLE,
                     facets: bills.facets(store), total_unfiltered: store.length };
        }
        return {};
    };
    await w.renderLedgerTab('bills');
    const doc = w.document;
    ck('the table starts empty', doc.querySelectorAll('#viewRoot tbody tr[data-id]').length === 0);

    w.openLedgerForm('bills');
    const el = doc.querySelector('#ledgerForm [name="container_no"]');
    el.value = 'MSKU777';
    doc.getElementById('ledgerForm').dispatchEvent(new w.Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1500));
    doc.getElementById('ledClose').click();
    await new Promise((r) => setTimeout(r, 200));

    const rows = doc.querySelectorAll('#viewRoot tbody tr[data-id]');
    ck('the bill she just added is in the table', rows.length === 1, String(rows.length));
    ck('  and it has an Edit button like any other row',
       doc.querySelectorAll('#viewRoot .ledger-edit').length === 1);

    // ── THE ACTUAL FIX ───────────────────────────────────────────────────
    const cell = rows[0].lastElementChild;
    ck('  in a cell pinned to the right edge',
       /position:\s*sticky/.test(cell.getAttribute('style') || '')
       && /right:\s*0/.test(cell.getAttribute('style') || ''),
       '22 columns put it 2,400px off-screen — present in the DOM, unreachable');
    const th = doc.querySelectorAll('#viewRoot thead th');
    ck('  with its header pinned too, or the column drifts under the others',
       /position:\s*sticky/.test(th[th.length - 1].getAttribute('style') || ''));
    ck('  opaque, so the scrolling columns do not show through it',
       /background:/.test(cell.getAttribute('style') || ''));
    ck('  and the buttons come FIRST in the cell, before any warnings',
       cell.innerHTML.indexOf('ledger-edit') < cell.innerHTML.indexOf('status-warn')
       || !/status-warn/.test(cell.innerHTML),
       'a cell whose width depends on how many warnings a row has is a moving target');

    // The half-finished bill says so on the row, not only in the form.
    ck('  and an unfinished bill is marked as such on its row',
       /still needs|◦/.test(cell.textContent) || /date, supplier/.test(cell.textContent),
       cell.textContent.trim().slice(0, 80));
    dom.window.close();
}

section('F3 — the page says which build it is');
{
    // Apsara, 2026-09-10, twice: "Why edit option not there in bills?" and
    // "see no edit option". The button was in the code both times; she was
    // running an older build both times. The second time the only way I could
    // tell was by recognising the order of the markup in her screenshot as a
    // fingerprint of commit 7f16c64 — which is not a diagnostic anyone should
    // depend on.
    const { w, dom } = await mount({
        '/api/bills': billsRoute,
        '/api/health': { ok: true, version: { short: 'abc1234', subject: 'bill render',
            committed_at: '2026-09-10T02:52:35+05:30', booted_at: '2026-09-09T21:24:39Z', dirty: false } },
    });
    await w.renderLedgerTab('bills');
    await new Promise((r) => setTimeout(r, 40));
    const el = w.document.getElementById('ledBuild');
    ck('the running build is on screen', !!el && /abc1234/.test(el.textContent),
       el ? el.textContent : '(no element)');
    ck('  with the commit subject and times behind it',
       /bill render/.test(el.title) && /booted|running since/i.test(el.title), el.title);
    dom.window.close();

    // Local edits are flagged — a dirty build is why a fix can be "in" and
    // still not be what is running.
    const d = await mount({
        '/api/bills': billsRoute,
        '/api/health': { ok: true, version: { short: 'abc1234', dirty: true } },
    });
    await d.w.renderLedgerTab('bills');
    await new Promise((r) => setTimeout(r, 40));
    ck('  and uncommitted local changes are flagged',
       /\+local/.test(d.w.document.getElementById('ledBuild').textContent),
       d.w.document.getElementById('ledBuild').textContent);
    d.dom.window.close();

    // Not knowing the build must never stop the table drawing.
    const f = await mount({ '/api/bills': billsRoute });   // no /api/health at all
    await f.w.renderLedgerTab('bills');
    await new Promise((r) => setTimeout(r, 40));
    ck('  and a missing health endpoint does not break the page',
       f.w.document.querySelectorAll('#viewRoot tbody tr[data-id]').length === 2);
    f.dom.window.close();
}

section('F4 — "ugly and clumsy": the six things that were wrong');
{
    // Apsara, 2026-09-10, twice: "This is ugly and not user friendly", then
    // "still it looks ugly and clumsy and not user friendly". Six specific
    // faults, each asserted here so none of them can come back quietly.
    const { w, dom } = await mount({ '/api/bills': billsRoute, '/api/bills/preview': () => bills.compute({}) });
    await w.renderLedgerTab('bills');
    w.openLedgerForm('bills');
    const form = w.document.getElementById('ledgerForm');
    const inputs = [...form.querySelectorAll('input')];

    // 1. Spinner arrows on ten weight and money boxes at once.
    ck('no number spinners anywhere on the form',
       !inputs.some((i) => i.type === 'number'),
       inputs.filter((i) => i.type === 'number').map((i) => i.name).join(','));
    ck('  but numeric fields still get a number pad on a phone',
       inputs.filter((i) => ['gross', 'truck', 'supplier_price'].includes(i.name))
             .every((i) => i.getAttribute('inputmode') === 'decimal'),
       'inputmode is what replaces type=number without the arrows');

    // 2. The unit lived in the LABEL, so "Supplier invoice amount ($)"
    //    wrapped to two lines and pushed its input out of alignment.
    const labels = [...form.querySelectorAll('label')].map((l) => l.textContent.trim());
    ck('no unit suffixes left in the labels',
       !labels.some((l) => /\(\$\)|\(lbs\)|\(MT\)/i.test(l)), labels.join(' | '));
    ck('  the $ sits inside the money fields instead',
       form.querySelectorAll('div[style*="position:relative"] span').length >= 3,
       'as an adornment, so the label stays one line');

    // 3. Hints under fields made every row a different height.
    ck('hints moved off the layout and onto the field',
       !/leave blank to use the computed figure<\/div>/.test(form.innerHTML)
       && inputs.some((i) => /computed figure/i.test(i.getAttribute('title') || '')),
       'block hints under a box are why nothing lined up');

    // 4. Numbers left-aligned in a proportional font do not line up.
    ck('numbers are right-aligned monospace',
       inputs.filter((i) => ['gross', 'truck', 'boxes'].includes(i.name))
             .every((i) => /text-align:\s*right/.test(i.getAttribute('style') || '')
                        && /font-mono/.test(i.getAttribute('style') || '')));

    // 5. The form stretched to the whole window.
    const card = w.document.querySelector('#ledgerModal .card');
    ck('the form is capped, not full-window',
       /width:\s*min\(900px/.test(card.getAttribute('style') || ''),
       card.getAttribute('style'));
    ck('  and laid out in columns rather than one wide row',
       /repeat\(auto-fit,minmax\(330px/.test(form.getAttribute('style') || ''),
       form.getAttribute('style'));

    // 6. Totals block and button row were two things to look at for one
    //    decision.
    ck('the totals and the buttons share one bar',
       w.document.getElementById('ledPreview').parentElement
         .contains(w.document.getElementById('ledSave')));

    // ── THE LIGHT SHEET, AND THE ALIGNMENT IT FIXES ──────────────────────
    // Apsara, 2026-09-10: "alignmnet not proper and i want light colour on
    // that bill".
    const sheet = w.document.querySelector('#ledgerModal .card');
    // Read from the palette, not from a hex copied into the test. She chose
    // "B but give an option to toggle to C as well" on 2026-09-10, so a test
    // holding its own hex is a test that fails on a correct palette change.
    const T = w.ledgerTheme();
    ck('the bill form is a sheet in the chosen palette',
       (sheet.getAttribute('style') || '').includes(`background:${T.sunken}`),
       sheet.getAttribute('style'));
    // Only the NAMED fields. wireUsDateField appends a hidden native
    // <input type="date"> beside each date box purely to open the platform
    // calendar; it carries no name and is never seen, so styling it proves
    // nothing and sweeping it in fails a correct form.
    ck('  with dark text in its fields, not white on white',
       // Read off style.color, not the raw attribute. jsdom normalises
       // "#14181B" to "rgb(20, 24, 27)" the moment anything else touches the
       // element — wireUsDateField sets paddingRight on the date box — so a
       // literal hex match failed on a correctly-styled field.
       inputs.filter((i) => i.name).every((i) => rgbEq(i.style.color, T.ink)),
       inputs.filter((i) => i.name && !/20,\s*24,\s*27|#14181B/i.test(i.style.color || ''))
             .map((i) => `${i.name}=${i.style.color}`).join(',') || 'invisible form');

    // The alignment complaint itself: two of five weight labels wrapped to a
    // second line, so those inputs sat a line lower than the other three.
    const wLabels = ['gross', 'truck', 'container', 'chassis', 'boxes']
        .map((n) => form.querySelector(`[name="${n}"]`).closest('.field').querySelector('label'));
    ck('no weight label can wrap',
       wLabels.every((l) => /white-space:\s*nowrap/.test(l.getAttribute('style') || '')),
       'a label that wraps pushes its input a line below its neighbours');
    ck('  and none is long enough to need to',
       wLabels.every((l) => l.textContent.trim().length <= 9),
       wLabels.map((l) => l.textContent.trim()).join(','));

    // "$ 0.14 /lb" rendered as "0/.14" — right-aligned text running under an
    // absolutely-positioned suffix, in a field she reads a price from.
    const price = form.querySelector('[name="supplier_price"]');
    ck('the price field reserves room for its /lb suffix',
       /padding:0 34px/.test(price.getAttribute('style') || ''),
       price.getAttribute('style'));

    // The photo textarea sat mid-column and pushed everything below it out of
    // step with the column beside it.
    const photos = form.querySelector('textarea[name="photos"]');
    ck('photo links get their own full-width row',
       photos && /grid-column:1\/-1/.test(photos.closest('.field').getAttribute('style') || ''),
       'a three-line box in the middle of a column breaks the grid');

    // ── THE LIST THAT LEARNS ─────────────────────────────────────────────
    // Apsara, 2026-09-10: "Supplier should be dynamically listed in text box.
    // first time,when we type,it needs to added to the list,next time when i
    // tye,it should start showing matching case." Then: "so as Item
    // description."
    for (const f of ['supplier', 'description']) {
        const el = form.querySelector(`[name="${f}"]`);
        ck(`  ${f} offers what has been typed before`,
           !!el && el.getAttribute('list') === `ledlist-${f}`,
           el ? String(el.getAttribute('list')) : '(no field)');
        const dl = form.querySelector(`#ledlist-${f}`);
        ck(`    from a real list, not an empty one`,
           !!dl && dl.querySelectorAll('option').length > 0,
           dl ? String(dl.querySelectorAll('option').length) : '(no datalist)');
    }
    ck('  the options are the values already on her bills',
       [...form.querySelectorAll('#ledlist-supplier option')].map((o) => o.value).sort().join(',')
         === 'Eccomelt,Oakland Metals',
       [...form.querySelectorAll('#ledlist-supplier option')].map((o) => o.value).join(','));
    ck('  and typing something new is still allowed',
       form.querySelector('[name="supplier"]').tagName === 'INPUT',
       'a datalist suggests; a select would refuse a supplier she has not used before');

    // ── SUPERSEDED, DELIBERATELY ─────────────────────────────────────────
    // This asserted supplier-before-route, from "Swap places of route and
    // supplier" earlier on 2026-09-10 when both lived in one group. Her
    // regrouping later the same day put Route in Shipment and Supplier in
    // Purchase — "Date,Route,Carrier,Invoice no in one group... then
    // supplier,supplier price,bill amount in one group" — so route now comes
    // first because it is in an earlier SECTION, not because the swap was
    // undone. Rewritten rather than deleted so the reason is on the record.
    const order = [...form.querySelectorAll('[name]')].map((i) => i.name);
    ck('route sits in Shipment, supplier in Purchase',
       order.indexOf('route') < order.indexOf('supplier'),
       order.join(','));
    ck('  with the container numbers between them',
       order.indexOf('container_no') > order.indexOf('route')
       && order.indexOf('container_no') < order.indexOf('supplier'),
       order.join(','));
    ck('  and trucking after the purchase, not mixed into it',
       order.indexOf('trucking_company') > order.indexOf('supplier_price'),
       order.join(','));
    dom.window.close();
}

section('G — close, and autosave from the first value');
{
    // Apsara, 2026-09-10: "at top right close option should be there in
    // bill.Also if i start adding atleast one value in bill,it should get
    // autosaved and a entry to be put in edege metals excel under shipments
    // tab.On every modification,that row needs to e updated."
    // The live-totals strip POSTs to /api/bills/preview on every keystroke,
    // which is not a save. Counting those as saves made a correct autosave
    // look like it fired three times — the assertion was wrong, not the code.
    const calls = [];
    const saves = () => calls.filter((c) => !/\/preview$/.test(c.path));
    const { w, dom } = await mount({
        '/api/bills': billsRoute,
        '/api/bills/preview': () => bills.compute({}),
    });
    // Record what the form sends, and answer like the real route.
    const realApi = w.api;
    w.api = async (p, opts) => {
        if (opts && opts.method) {
            calls.push({ path: p, method: opts.method, body: JSON.parse(opts.body || '{}') });
            if (p === '/api/bills' && opts.method === 'POST') {
                return { ok: true, bill: bills.withTotals({ id: 'NEW1', ...JSON.parse(opts.body) }) };
            }
            return { ok: true, bill: bills.withTotals({ id: 'NEW1', ...JSON.parse(opts.body) }) };
        }
        return realApi(p, opts);
    };
    await w.renderLedgerTab('bills');
    w.openLedgerForm('bills');
    const doc = w.document;

    ck('there is a close button at the top right', !!doc.getElementById('ledClose'));
    ck('  labelled for a screen reader too',
       doc.getElementById('ledClose').getAttribute('aria-label') === 'Close');

    const type = async (name, val) => {
        const el = doc.querySelector(`#ledgerForm [name="${name}"]`);
        el.value = val;
        doc.getElementById('ledgerForm').dispatchEvent(new w.Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 1400));
    };

    ck('nothing is saved before she types anything', saves().length === 0, JSON.stringify(saves()));

    await type('container_no', 'MSKU1');
    const posts = saves().filter((c) => c.method === 'POST');
    ck('one value autosaves it', posts.length === 1, JSON.stringify(saves().map((c) => c.method + ' ' + c.path)));
    ck('  as a POST, creating the row', posts[0] && posts[0].path === '/api/bills');
    ck('  and it says so rather than saving silently',
       /Saved/.test(doc.getElementById('ledSaveState').textContent),
       doc.getElementById('ledSaveState').textContent);
    // Was "still needs date and supplier" until 2026-09-10, when the date
    // started arriving pre-filled with today in LA. One fewer thing to chase.
    ck('  naming what is still missing',
       /still needs supplier/.test(doc.getElementById('ledSaveState').textContent),
       'saved and unfinished are both worth knowing');
    ck('  and the autosaved row already carries the LA date',
       /^\d\d\/\d\d\/\d{4}$/.test(String(posts[0] && posts[0].body.date || '')),
       JSON.stringify(posts[0] && posts[0].body.date));
    ck('  which is not something she had to type',
       !doc.getElementById('ledSaveState').textContent.includes('date'),
       doc.getElementById('ledSaveState').textContent);

    await type('supplier', 'Eccomelt');
    const puts = saves().filter((c) => c.method === 'PUT');
    ck('every later change UPDATES the same row', puts.length >= 1, JSON.stringify(saves().map((c) => c.method)));
    ck('  by id, which is what keeps the sheet to one row',
       puts.every((c) => c.path === '/api/bills/NEW1'), JSON.stringify(puts.map((c) => c.path)));
    ck('  and never a second POST', saves().filter((c) => c.method === 'POST').length === 1,
       'a second create is a second row in her sheet');

    doc.getElementById('ledClose').click();
    ck('close removes the form', !doc.getElementById('ledgerModal'));
    // Closing fires renderLedgerTab() without awaiting it — correct in the
    // browser, fatal here: tearing the window down mid-flight makes that
    // promise resume against a dead document and take the whole process with
    // it. It surfaced only when a section was added AFTER this one, which is
    // why it sat here green for a day.
    await new Promise((r) => setTimeout(r, 40));
    dom.window.close();
}

section('G1 — a new bill is dated today in LA, not wherever she is sitting');
{
    // Apsara, 2026-09-10: "Bill date and invoice date should be by default
    // today in LA date".
    //
    // Frozen instant, chosen so the two answers DISAGREE: 2026-09-11T03:00Z
    // is still the 10th in Los Angeles and already the 11th in UTC and in
    // India. Anything reading the browser's clock returns the 11th and fails
    // here. (If the runner itself is in LA the two agree and this weakens to
    // a smoke test — hence the UTC cross-check on the line below.)
    const FROZEN = Date.parse('2026-09-11T03:00:00Z');
    const ROWS = [{ id: 'S1', customer: 'Daekwang', date: '09/10/2026', invoice_no: 'INV-1',
                    weight: 22, invoice_price: 300 }].map(sales.withTotals);
    const { w, dom } = await mount({ '/api/bills': billsRoute, '/api/sales': (q) => {
        const rows = sales.filterRows(ROWS, q);
        return { sales: rows, summary: sales.summary(rows), columns: sales.tableColumns(),
                 fields: sales.COLUMNS, groups: sales.GROUPS, facets: sales.facets(ROWS),
                 filterable: sales.FILTERABLE, total_unfiltered: ROWS.length };
    }, '/api/bills/preview': () => bills.compute({}), '/api/sales/preview': () => sales.compute({}) });

    const RealDate = w.Date;
    w.Date = class extends RealDate {
        constructor(...a) { super(...(a.length ? a : [FROZEN])); }
        static now() { return FROZEN; }
    };
    ck('the two clocks really do disagree at this instant',
       new RealDate(FROZEN).toISOString().slice(0, 10) === '2026-09-11',
       'if they agreed the assertions below would prove nothing');
    ck('todayYardDateStr is anchored to Los Angeles',
       w.todayYardDateStr() === '2026-09-10', w.todayYardDateStr());

    await w.renderLedgerTab('bills');
    w.openLedgerForm('bills');
    let form = w.document.getElementById('ledgerForm');
    ck('a new bill opens dated today in LA',
       form.querySelector('[name="date"]').value === '09/10/2026',
       form.querySelector('[name="date"]').value);
    ck('  and it still gets a picker, so she can change it',
       form.querySelector('[name="date"]').dataset.dpWired === '1');
    w.document.getElementById('ledClose').click();
    await new Promise((r) => setTimeout(r, 40));

    await w.renderLedgerTab('sales');
    w.openLedgerForm('sales');
    form = w.document.getElementById('ledgerForm');
    ck('a new invoice opens dated today in LA too',
       form.querySelector('[name="date"]').value === '09/10/2026',
       form.querySelector('[name="date"]').value);
    // A guessed date on someone else's document is worse than a blank box:
    // it looks filled in and nobody checks it again.
    ck('  but the proforma date is left blank',
       form.querySelector('[name="proforma_date"]').value === '',
       form.querySelector('[name="proforma_date"]').value);
    w.document.getElementById('ledClose').click();
    await new Promise((r) => setTimeout(r, 40));

    // EDITING must never re-date a bill she entered last month.
    await w.renderLedgerTab('bills');
    w.openLedgerForm('bills', BILL_ROWS[1]);          // dated 08/02/2026
    form = w.document.getElementById('ledgerForm');
    ck('editing an old bill keeps its own date',
       form.querySelector('[name="date"]').value === '08/02/2026',
       form.querySelector('[name="date"]').value);

    w.Date = RealDate;
    await new Promise((r) => setTimeout(r, 40));
    dom.window.close();
}

section('G2 — the Pay form: one transfer, several containers');
{
    // Apsara, 2026-09-10: "Pay button-->Add it".
    //
    // The thing being tested is the ARITHMETIC SHE CAN SEE. She types what
    // left the bank and divides it; if the remainder is wrong or stale she
    // finds out from a server refusal after filling the whole form. So these
    // assertions drive real keystrokes and read the remainder off the DOM.
    const PAY_ROUTE = {
        payments: [], summary: { total: 0 },
        open_bills: [
            { id: 'B1', supplier: 'Eccomelt', container_no: 'MSKU1111111', balance: 3440, amount: 3440, paid: 0 },
            { id: 'B2', supplier: 'Eccomelt', container_no: 'HMMU2222222', balance: 3440, amount: 4000, paid: 560 },
            { id: 'B3', supplier: 'Eccomelt', container_no: 'TGHU3333333', balance: 120, amount: 120, paid: 0 },
            { id: 'B9', supplier: 'Oakland Metals', container_no: 'OAKU9999999', balance: 500, amount: 500, paid: 0 },
        ],
        credit: { Eccomelt: 1680 },
        modes: require(path.join(ROOT, 'helpers/billPayments')).BILL_PAYMENT_MODES,
        banks: ['Chase', 'BofA'],
    };
    const posted = [];
    const { w, dom, err } = await mount({
        '/api/bill-payments': (q, opts) => {
            if (opts && opts.method === 'POST') { posted.push(JSON.parse(opts.body)); return { ok: true }; }
            return PAY_ROUTE;
        },
        '/api/bills': billsRoute,
        '/api/health': { build: 'test' },
    });
    ck('page evaluates', !err, err && err.message);
    const doc = w.document;

    await w.renderLedgerTab('bills');
    const payBtn = doc.getElementById('btnPay');
    ck('the Bills tab has a Pay button', !!payBtn);
    ck('  and it is wired to something that exists',
       typeof w.openBillPayForm === 'function',
       'the first version called openPayForm(), which was never written');

    // The id namespace. dashboard/index.html already carries a STATIC
    // id="payModal" for the Edge Yard load payment. getElementById returns
    // the first in document order, so a second one would make close() remove
    // the yard's modal instead of this one — permanently, for the session.
    ck('the pay form does not reuse the yard modal ids',
       (html.match(/id="payModal"/g) || []).length === 1,
       'two #payModal means close() deletes the wrong one');

    // ── IT ASKS WHO IS BEING PAID FIRST ──────────────────────────────
    // Apsara, 2026-09-10: "It must ask to select the supplier first."
    await w.openBillPayForm();
    ck('it asks for the supplier before anything else', !!doc.getElementById('bpWho'));
    ck('  and no payment form is up yet', !doc.getElementById('bpModal'),
       'the container list is meaningless until it knows whose it is');
    const who = [...doc.querySelectorAll('.bpWhoPick')];
    ck('  every supplier with something outstanding is offered', who.length === 2,
       who.map((b) => b.dataset.supplier).join(','));
    ck('  saying how much is pending against each',
       /\$7,000\.00 pending/.test(who[0].textContent) && /3 containers/.test(who[0].textContent),
       who[0].textContent.replace(/\s+/g, ' ').trim());
    ck('  biggest first, because that is the one she is here about',
       who[0].dataset.supplier === 'Eccomelt', who[0].dataset.supplier);
    ck('  and the credit she is already holding',
       /1,680/.test(who[0].textContent), 'an advance she cannot see is an advance she pays twice');
    ck('  with a box for a supplier who has no open containers',
       !!doc.getElementById('bpWhoOther'),
       'an advance is usually paid before any bill exists');

    who[0].click();
    await new Promise((r) => setTimeout(r, 40));
    const m = doc.getElementById('bpModal');
    ck('choosing one opens the payment form', !!m);
    ck('  and the picker is gone', !doc.getElementById('bpWho'));
    ck('  the supplier is filled in for her',
       doc.getElementById('bpSupplier').value === 'Eccomelt',
       doc.getElementById('bpSupplier').value);
    ck('  and not retypeable, so it cannot drift from what she picked',
       doc.getElementById('bpSupplier').readOnly === true);
    ck('  listing only that supplier\'s containers',
       doc.querySelectorAll('#bpRows tr[data-bill]').length === 3,
       [...doc.querySelectorAll('#bpRows tr[data-bill]')].map((r) => r.dataset.bill).join(','));
    ck('  another supplier\'s container is not on the list',
       !doc.querySelector('#bpRows tr[data-bill="B9"]'),
       'a wire to Eccomelt against an Oakland container is a false statement about who was paid');
    ck('  with the amount owed shown per container',
       /\$3,440\.00/.test(doc.getElementById('bpRows').textContent));
    ck('  a part-paid one says how much is already in',
       /560\.00 paid of/.test(doc.querySelector('#bpRows tr[data-bill="B2"]').textContent),
       doc.querySelector('#bpRows tr[data-bill="B2"]').textContent.replace(/\s+/g, ' ').trim());
    ck('  and the total pending is stated once',
       /\$7,000\.00 pending across 3 containers/.test(doc.getElementById('bpPending').textContent),
       doc.getElementById('bpPending').textContent);
    ck('  the date defaults to today', /^\d\d\/\d\d\/\d{4}$/.test(doc.getElementById('bpDate').value));
    ck('  and she can go back and change supplier', !!doc.getElementById('bpWhoAgain'));

    const fire = (el, ev) => el.dispatchEvent(new w.Event(ev, { bubbles: true }));

    // Cash: offered, and without a bank box. helpers/banks.js THROWS if a
    // bank is supplied on a cash payment, so leaving the dropdown up would
    // show her choosing something about to be refused.
    ck('Cash is on the method list',
       [...doc.getElementById('bpMode').options].some((o) => o.value === 'Cash'),
       [...doc.getElementById('bpMode').options].map((o) => o.value).join(','));
    ck('  the bank box is there for a wire',
       doc.getElementById('bpBankField').style.display !== 'none');
    doc.getElementById('bpMode').value = 'Cash'; fire(doc.getElementById('bpMode'), 'change');
    ck('  and gone for cash',
       doc.getElementById('bpBankField').style.display === 'none',
       doc.getElementById('bpBankField').style.display);
    doc.getElementById('bpMode').value = 'Wire'; fire(doc.getElementById('bpMode'), 'change');
    ck('  and back again if she changes her mind',
       doc.getElementById('bpBankField').style.display !== 'none');

    const amt = doc.getElementById('bpAmount');
    amt.value = '7000'; fire(amt, 'input');
    ck('typing the amount shows it all still to allocate',
       doc.getElementById('bpLeft').textContent === '$7,000.00',
       doc.getElementById('bpLeft').textContent);
    ck('  and Record payment is refused until it is divided',
       doc.getElementById('bpSave').disabled === true,
       'the server refuses this too — the button should not pretend otherwise');

    const pick = (id) => { const cb = doc.querySelector(`.bpPick[data-bill="${id}"]`); cb.checked = true; fire(cb, 'change'); };
    pick('B1');
    ck('ticking a container fills in what it owes',
       doc.querySelector('.bpAmt[data-bill="B1"]').value === '3440.00',
       doc.querySelector('.bpAmt[data-bill="B1"]').value);
    ck('  and the remainder drops by exactly that',
       doc.getElementById('bpLeft').textContent === '$3,560.00',
       doc.getElementById('bpLeft').textContent);
    pick('B2');
    pick('B3');
    ck('three containers, one wire, nothing left over',
       doc.getElementById('bpLeft').textContent === '$0.00',
       doc.getElementById('bpLeft').textContent);

    // The cap. B3 owes 120 and 120 is what remains, so the fill must not
    // reach for the full balance of a container the transfer cannot cover.
    const b3 = doc.querySelector('.bpAmt[data-bill="B3"]');
    ck('  a tick never allocates more than the transfer has left',
       Number(b3.value) <= 120.001, b3.value);

    b3.value = '120'; fire(b3, 'input');
    ck('fully allocated turns the remainder green and unlocks Save',
       doc.getElementById('bpSave').disabled === false);
    ck('  allocated reads back the full transfer',
       doc.getElementById('bpAllocated').textContent === '$7,000.00',
       doc.getElementById('bpAllocated').textContent);

    // Over-allocation has to be visible BEFORE submit.
    b3.value = '900'; fire(b3, 'input');
    ck('over-allocating locks Save again', doc.getElementById('bpSave').disabled === true);
    ck('  and says so in red',
       rgbEq(doc.getElementById('bpLeft').style.color, w.ledgerTheme().danger),
       doc.getElementById('bpLeft').style.color);
    b3.value = '120'; fire(b3, 'input');

    doc.getElementById('bpBank').value = 'Chase';
    doc.getElementById('bpSave').click();
    await new Promise((r) => setTimeout(r, 30));
    ck('saving posts one payment, not one per container', posted.length === 1, JSON.stringify(posted));
    if (posted.length) {
        const body = posted[0];
        ck('  the amount is the transfer', Number(body.amount) === 7000);
        ck('  with three allocations under it', (body.allocations || []).length === 3);
        ck('  summing to the transfer',
           Math.abs(body.allocations.reduce((s, a) => s + a.amount, 0) - 7000) < 0.005);
        ck('  and it is a payment, not an advance', body.kind === 'payment');
        ck('  carrying the bank, which Zelle and Wire require', body.bank === 'Chase');
        ck('  and the supplier she chose at the door', body.supplier === 'Eccomelt', body.supplier);
    }
    ck('a successful save closes the form', !doc.getElementById('bpModal'));
    await new Promise((r) => setTimeout(r, 40));

    // The advance path: same form, no containers ticked.
    await w.openBillPayForm({ supplier: 'Eccomelt' });
    const a2 = doc.getElementById('bpAmount');
    a2.value = '5000'; fire(a2, 'input');
    doc.getElementById('bpBank').value = 'Chase';
    ck('an unallocated amount cannot be saved as a payment',
       doc.getElementById('bpSave').disabled === true);
    ck('  but Save as advance is always available',
       !!doc.getElementById('bpAdvance') && doc.getElementById('bpAdvance').disabled !== true,
       'that is the escape hatch the server error tells her to use');
    doc.getElementById('bpAdvance').click();
    await new Promise((r) => setTimeout(r, 30));
    ck('the advance posts against the supplier',
       posted.length === 2 && posted[1].kind === 'advance' && posted[1].supplier === 'Eccomelt',
       JSON.stringify(posted[1] || null));
    ck('  with no allocations — she chooses when to apply it',
       (posted[1].allocations || []).length === 0,
       'her answer was "I choose when to apply it"');

    await w.openBillPayForm({ supplier: 'Eccomelt' });
    doc.getElementById('bpClose').click();
    await new Promise((r) => setTimeout(r, 40));
    ck('close removes the form', !doc.getElementById('bpModal'));
    // ── EDGE YARD IS NOT EDGE METALS ─────────────────────────────────────
    // Apsara, 2026-09-10: "Always remember Edge Yard is different and Edge
    // Metals is different." The Yard's load-payment modal is id="payModal"
    // with id="payErr" inside it, built into a view template. This form is
    // Edge Metals. The first draft of it reused both ids, so close() would
    // have called .remove() on whichever came first in document order — the
    // Yard's — and errors here would have been written into a hidden Yard
    // element. Asserted against the source, because the Yard modal is not in
    // the DOM while the Metals tab is the one rendered.
    const payFn = html.slice(html.indexOf('async function openBillPayForm'),
                             html.indexOf('// ── THE ADD FORM'));
    ck('  the Metals pay form touches no Edge Yard id',
       !/\bpayModal\b|\bpayErr\b|\bpay_date\b|\bpayingLoad\b/.test(payFn),
       (payFn.match(/\bpayModal\b|\bpayErr\b|\bpay_date\b|\bpayingLoad\b/g) || []).join(','));
    ck('  and the Yard keeps sole ownership of #payModal',
       (html.match(/id="payModal"/g) || []).length === 1);
    dom.window.close();
}

section('G3 — spending an advance she already paid');
{
    // Her answer: "I choose when to apply it." So credit sits until she says
    // so — which means there has to be a way to say so. An advance she can
    // create and never apply is a number that only goes up.
    const applied = [];
    const ROUTE = {
        payments: [
            { id: 'P9', kind: 'advance', supplier: 'Eccomelt', date: '09/01/2026',
              mode: 'Wire', ref: 'W-77', amount: 5000, allocations: [{ bill_id: 'B0', amount: 3320 }] },
            { id: 'P8', kind: 'advance', supplier: 'Eccomelt', date: '08/20/2026',
              mode: 'Zelle', amount: 400, allocations: [{ bill_id: 'B0', amount: 400 }] },
            { id: 'P7', kind: 'payment', supplier: 'Eccomelt', date: '08/01/2026',
              mode: 'Wire', amount: 900, allocations: [{ bill_id: 'B0', amount: 900 }] },
        ],
        summary: { total: 0 },
        open_bills: [
            { id: 'B1', supplier: 'Eccomelt', container_no: 'MSKU1111111', balance: 3440 },
            { id: 'B3', supplier: 'Oakland Metals', container_no: 'TGHU3333333', balance: 120 },
        ],
        credit: { Eccomelt: 1680 },
        modes: ['Zelle', 'Wire'], banks: ['Chase'],
    };
    const { w, dom } = await mount({
        '/api/bills': billsRoute,
        '/api/bill-payments': (q, opts) => (opts && opts.method === 'POST' ? { ok: true } : ROUTE),
        '/api/bill-payments/P9/apply': (q, opts) => { applied.push(JSON.parse(opts.body)); return { ok: true }; },
    });
    const doc = w.document;
    await w.renderLedgerTab('bills');
    await w.openBillPayForm({ supplier: 'Eccomelt' });

    const link = doc.querySelector('.bpApply[data-supplier="Eccomelt"]');
    ck('the credit she holds is a button, not just a number', !!link);
    link.click();
    await new Promise((r) => setTimeout(r, 40));

    ck('it reopens in apply mode', /Apply advance/.test(doc.getElementById('bpModal').textContent));
    const sel = doc.getElementById('bpAdvSel');
    ck('  offering the advances with credit left', !!sel && sel.options.length === 1,
       sel ? [...sel.options].map((o) => o.textContent).join(' | ') : 'no picker');
    ck('  and only the ones not already used up',
       sel && ![...sel.options].some((o) => /08\/20\/2026/.test(o.textContent)),
       'a fully-applied advance is not credit');
    ck('  a plain payment is not an advance', sel && sel.options.length === 1);
    ck('  showing what is left on it, not what was sent',
       /1,680/.test(sel.options[0].textContent), sel.options[0].textContent);

    // Nothing here moves money, so nothing here asks about banks.
    ck('the bank and method fields are gone',
       doc.getElementById('bpBank').closest('div').style.display === 'none' &&
       doc.getElementById('bpAmount').closest('div').style.display === 'none',
       'applying credit does not touch a bank account');
    ck('  and so is "Save as advance"', !doc.getElementById('bpAdvance'),
       'an advance cannot be turned into another advance');
    ck('only this supplier’s containers are listed',
       doc.querySelectorAll('#bpRows tr[data-bill]').length === 1 &&
       !!doc.querySelector('#bpRows tr[data-bill="B1"]'),
       'Eccomelt credit against an Oakland Metals container is a wrong entry waiting to happen');

    ck('nothing to apply yet, so Apply is refused',
       doc.getElementById('bpSave').disabled === true);

    const fire = (el, ev) => el.dispatchEvent(new w.Event(ev, { bubbles: true }));
    const amt = doc.querySelector('.bpAmt[data-bill="B1"]');
    amt.value = '1680'; fire(amt, 'input');
    ck('putting the whole credit on a container unlocks Apply',
       doc.getElementById('bpSave').disabled === false);

    // Partial is normal: $1,680 of credit against a $3,440 container.
    amt.value = '500'; fire(amt, 'input');
    ck('  and applying only part of it is allowed',
       doc.getElementById('bpSave').disabled === false,
       'unlike a payment, an advance may be left partly unspent');
    amt.value = '9000'; fire(amt, 'input');
    ck('  but never more than the advance has left',
       doc.getElementById('bpSave').disabled === true);

    amt.value = '1680'; fire(amt, 'input');
    doc.getElementById('bpSave').click();
    await new Promise((r) => setTimeout(r, 40));
    ck('applying posts to the advance, not to a new payment',
       applied.length === 1, JSON.stringify(applied));
    ck('  carrying just the allocation',
       applied.length === 1 && applied[0].allocations.length === 1 &&
       applied[0].allocations[0].bill_id === 'B1' && applied[0].allocations[0].amount === 1680,
       JSON.stringify(applied[0]));
    ck('  and no second ledger row is implied',
       applied.length === 1 && applied[0].amount === undefined,
       'the money left the bank on the day of the advance and was counted then');
    await new Promise((r) => setTimeout(r, 40));
    dom.window.close();
}

section('G4 — deleting a payment, and saying what that undoes');
{
    // Apsara, 2026-09-10: "Now i want to have delete option in payment."
    const deleted = [];
    let payments = [
        { id: 'P1', kind: 'payment', supplier: 'Eccomelt', date: '09/05/2026', mode: 'Wire',
          ref: 'W-11', amount: 7000, allocations: [{ bill_id: 'B1', amount: 3440 },
                                                   { bill_id: 'B2', amount: 3440 },
                                                   { bill_id: 'B3', amount: 120 }] },
        { id: 'P2', kind: 'advance', supplier: 'Eccomelt', date: '09/07/2026', mode: 'Zelle',
          amount: 5000, allocations: [] },
    ];
    const route = (q, opts) => {
        if (opts && opts.method === 'DELETE') return { ok: true };
        return { payments, summary: { total: 0 },
                 open_bills: [{ id: 'B1', supplier: 'Eccomelt', container_no: 'MSKU1', balance: 3440 }],
                 credit: {}, modes: ['Zelle', 'Wire'], banks: ['Chase'] };
    };
    const { w, dom } = await mount({ '/api/bills': billsRoute, '/api/bill-payments': route });
    // Every DELETE, whatever the path, lands here.
    const realApi = w.api;
    w.api = async (pth, opts) => {
        if (opts && opts.method === 'DELETE') { deleted.push(pth); return { ok: true }; }
        return realApi(pth, opts);
    };
    const doc = w.document;
    await w.renderLedgerTab('bills');
    await w.openBillPayForm({ supplier: 'Eccomelt' });

    ck('the payments already recorded are listed',
       doc.querySelectorAll('#bpModal div[data-payment]').length === 2,
       'a delete button for a list she cannot see is not a delete option');
    ck('  newest first', /09\/07\/2026/.test(doc.querySelector('#bpModal div[data-payment]').textContent),
       doc.querySelector('#bpModal div[data-payment]').textContent.trim());
    ck('  showing what each one covered',
       /3 containers/.test(doc.querySelector('div[data-payment="P1"]').textContent),
       doc.querySelector('div[data-payment="P1"]').textContent);
    ck('  and an advance is labelled as one',
       /Advance/.test(doc.querySelector('div[data-payment="P2"]').textContent),
       doc.querySelector('div[data-payment="P2"]').textContent);

    const del = doc.querySelector('.bpDel[data-payment="P1"]');
    del.click();
    await new Promise((r) => setTimeout(r, 10));
    ck('one click does not delete anything', deleted.length === 0, JSON.stringify(deleted));
    ck('  it says what deleting would undo',
       /reopens 3 containers/.test(del.textContent), del.textContent);

    // Arming one must disarm the other, or two buttons sit live at once and
    // the second click lands on whichever the mouse happens to be over.
    const del2 = doc.querySelector('.bpDel[data-payment="P2"]');
    del2.click();
    await new Promise((r) => setTimeout(r, 10));
    ck('arming a second one disarms the first', del.textContent === 'Delete', del.textContent);
    ck('  and an advance covering nothing just asks',
       /sure\?/i.test(del2.textContent), del2.textContent);

    del2.click();
    await new Promise((r) => setTimeout(r, 40));
    ck('the second click deletes', deleted.length === 1, JSON.stringify(deleted));
    ck('  the one that was armed, by id',
       deleted[0] === '/api/bill-payments/P2', deleted[0]);

    await new Promise((r) => setTimeout(r, 60));
    dom.window.close();
}

section('G5 — mark as paid, and the shortfall it will not let vanish');
{
    // Apsara, 2026-09-10: "In outgoing-give the option as mark as paid..
    // sometimes there might be a deduction in received amount because of wire
    // deduction by bank".
    const posted = [];
    const ROWS = [
        { id: 'S1', booking_no: 'RCPT1', container_no: 'WIRE1', customer: 'Wireco',
          date: '09/10/2026', invoice_no: 'INV-1', weight: 29000, invoice_price: 0.41,
          receivable: 11890, received: 0, deducted: 0, bank_charge: 0, discount: 0, balance: 11890 },
        { id: 'S2', booking_no: 'RCPT1', container_no: 'WIRE2', customer: 'Wireco',
          date: '09/10/2026', invoice_no: 'INV-2', weight: 29000, invoice_price: 0.41,
          receivable: 11890, received: 11865, deducted: 25, bank_charge: 25, discount: 0, balance: 0 },
    ].map((r) => ({ ...sales.withTotals(r), ...r }));

    const { w, dom } = await mount({
        '/api/sales': () => ({ sales: ROWS, summary: sales.summary(ROWS),
            columns: sales.tableColumns(), fields: sales.COLUMNS, groups: sales.GROUPS,
            facets: sales.facets(ROWS), filterable: sales.FILTERABLE,
            total_unfiltered: ROWS.length, terms: sales.TERMS }),
        '/api/sales-receipts': (q, opts) => {
            if (opts && opts.method === 'POST') { posted.push(JSON.parse(opts.body)); return { ok: true }; }
            return { receipts: [], summary: {}, open_invoices: [],
                     modes: ['Wire', 'Zelle', 'Cash', 'Cheque'],
                     deduction_reasons: ['bank_charge', 'discount'], banks: ['Chase', 'BofA'] };
        },
    });
    const doc = w.document;
    await w.renderLedgerTab('sales');

    ck('an unpaid container offers Mark paid',
       !!doc.querySelector('.ledger-paid[data-id="S1"]'));
    ck('  a settled one does not', !doc.querySelector('.ledger-paid[data-id="S2"]'),
       'offering to settle something already settled is how it gets paid twice');
    ck('  and says so, with a mark that it was not the full amount',
       /paid \*/.test(doc.querySelector('tr[data-id="S2"]').textContent),
       doc.querySelector('tr[data-id="S2"]').textContent.replace(/\s+/g, ' ').trim());

    doc.querySelector('.ledger-paid[data-id="S1"]').click();
    await new Promise((r) => setTimeout(r, 50));
    ck('the form opens', !!doc.getElementById('mpModal'));
    ck('  saying who owes what',
       /Wireco owes/.test(doc.getElementById('mpModal').textContent),
       doc.getElementById('mpModal').textContent.replace(/\s+/g, ' ').slice(0, 90));
    ck('  pre-filled with the whole balance, because that is the ordinary case',
       doc.getElementById('mpAmount').value === '11890.00',
       doc.getElementById('mpAmount').value);
    ck('  dated today in LA', /^\d\d\/\d\d\/\d{4}$/.test(doc.getElementById('mpDate').value));
    ck('  and no shortfall question is asked yet',
       doc.getElementById('mpShort').style.display === 'none',
       'it is a question asked when it becomes one');

    const fire = (el, ev) => el.dispatchEvent(new w.Event(ev, { bubbles: true }));
    const amt = doc.getElementById('mpAmount');
    amt.value = '11865'; fire(amt, 'input');
    ck('typing a smaller figure raises the question',
       doc.getElementById('mpShort').style.display === 'block');
    ck('  naming the exact gap',
       /\$25\.00/.test(doc.getElementById('mpShortAmt').textContent),
       doc.getElementById('mpShortAmt').textContent);
    ck('  defaulting to the bank taking it, which is what she described',
       doc.querySelector('input[name="mpWhy"]:checked').value === 'bank_charge');
    ck('  and saying what that will do',
       /bank charge/.test(doc.getElementById('mpAfter').textContent),
       doc.getElementById('mpAfter').textContent);

    // The third option matters: sometimes they just have not paid it.
    const stillOwed = [...doc.querySelectorAll('input[name="mpWhy"]')].find((r) => r.value === '');
    stillOwed.checked = true; fire(stillOwed, 'change');
    ck('leaving it outstanding is offered as an equal choice', !!stillOwed);
    ck('  and says the rest stays owed',
       /stays outstanding/.test(doc.getElementById('mpAfter').textContent),
       doc.getElementById('mpAfter').textContent);

    const bankCharge = [...doc.querySelectorAll('input[name="mpWhy"]')].find((r) => r.value === 'bank_charge');
    bankCharge.checked = true; fire(bankCharge, 'change');

    // Cash has not been banked, so it has no account.
    const mode = doc.getElementById('mpMode');
    ck('a wire asks which account it landed in',
       doc.getElementById('mpBankField').style.display !== 'none');
    mode.value = 'Cash'; fire(mode, 'change');
    ck('  cash does not', doc.getElementById('mpBankField').style.display === 'none');
    mode.value = 'Wire'; fire(mode, 'change');
    doc.getElementById('mpBank').value = 'Chase';

    doc.getElementById('mpSave').click();
    await new Promise((r) => setTimeout(r, 40));
    ck('recording posts a receipt, not a flag on the row', posted.length === 1, JSON.stringify(posted));
    if (posted.length) {
        const b = posted[0];
        ck('  for what actually arrived', b.amount === 11865, String(b.amount));
        ck('    which is what the bank statement will say, not the invoice',
           b.amount !== 11890, 'a receipt that disagrees with the statement cannot be reconciled');
        ck('  against that container', b.allocations[0].sale_id === 'S1');
        ck('  with the shortfall carried and classified',
           b.allocations[0].deduction_amount === 25
           && b.allocations[0].deduction_reason === 'bank_charge',
           JSON.stringify(b.allocations[0]));
        ck('  and the customer it was invoiced to', b.customer === 'Wireco');
    }
    ck('the form closes on success', !doc.getElementById('mpModal'));
    await new Promise((r) => setTimeout(r, 40));
    dom.window.close();
}

section('G6 — four tabs, two stores');
{
    // Apsara, 2026-09-10: "What if we have tabs like Outgoing(invoice data),
    // Incoming(payment data), Freight(...) Similarly a tab called commission"
    //
    // She gets the four. Freight and Commission are VIEWS of the container
    // row — what is asserted here is that they carry NO second copy of the
    // booking, container or weight, because four copies of one fact disagree.
    const posted = [];
    const SROWS = [{ id: 'S1', booking_no: 'B1', container_no: 'C1', customer: 'Daekwang',
                     date: '09/10/2026', weight: 29000, invoice_price: 0.41,
                     receivable: 11890, received: 0, balance: 11890,
                     bank_charge: 0, discount: 0 }].map((r) => ({ ...sales.withTotals(r), ...r }));
    const PAYABLES = [
        { key: 'S1|charge|CHG1', sale_id: 'S1', kind: 'charge', charge_id: 'CHG1',
          booking_no: 'B1', container_no: 'C1', hbl_no: 'HBL9', what: 'Ocean freight',
          why: 'LAX to Busan on B1', amount: 2850, paid: 1000, balance: 1850 },
        { key: 'S1|commission', sale_id: 'S1', kind: 'commission', charge_id: null,
          booking_no: 'B1', container_no: 'C1', hbl_no: 'HBL9', what: 'Commission',
          why: '6 per MT on 13.154 MT invoiced', amount: 78.92, paid: 0, balance: 78.92 },
    ];
    const { w, dom } = await mount({
        '/api/sales': () => ({ sales: SROWS, summary: sales.summary(SROWS),
            columns: sales.tableColumns(), fields: sales.COLUMNS, groups: sales.GROUPS,
            facets: sales.facets(SROWS), filterable: sales.FILTERABLE,
            total_unfiltered: 1, duplicates: [{ booking_no: 'B1', container_no: 'C1', ids: ['S1', 'S2'] }] }),
        '/api/sales-receipts': () => ({ receipts: [
            { id: 'R1', date: '09/12/2026', customer: 'Daekwang', mode: 'Wire', bank: 'Chase',
              ref: 'W-1', amount: 11865, allocations: [{ sale_id: 'S1', amount: 11865, deduction_amount: 25 }] }],
            summary: { received: 11865, bank_charges: 25, discounts: 0 },
            open_invoices: [], modes: ['Wire'], banks: ['Chase'] }),
        '/api/sales-settlements': (q, opts) => {
            if (opts && opts.method === 'POST') { posted.push(JSON.parse(opts.body)); return { ok: true }; }
            return { settlements: [], summary: {}, payables: PAYABLES,
                     open_payables: PAYABLES.filter((p) => p.balance > 0.005),
                     modes: ['Wire', 'Cash'], banks: ['Chase'], payees: ['HMM'] };
        },
        '/api/sales/sellable': () => ({ bills: [
            { id: 'B_A', booking_no: 'DALA1', container_no: 'MSKU1', supplier: 'Eccomelt',
              description: 'Auto cast', net_lb: 29000, amount: 9280, sold: false },
            { id: 'B_B', booking_no: 'DALA1', container_no: 'MSKU2', supplier: 'Eccomelt',
              description: 'Auto cast', net_lb: 28000, amount: 8960, sold: true }],
            unsold: 1 }),
        '/api/sales/from-bill/B_A': () => ({ ok: true, already_sold: null,
            suggestion: { booking_no: 'DALA1', container_no: 'MSKU1', item: 'Auto cast',
                          weight: 29000, weight_unit: 'lb' } }),
        '/api/bills': billsRoute,
    });
    const doc = w.document;
    await w.renderLedgerTab('sales');

    // ── FOUR NAV TABS, NOT ONE TAB WITH FOUR SUB-TABS ────────────────
    // Apsara, 2026-09-10, after the first build nested them: "i told that i
    // want sales to be in different tabs na". They are entries in the nav,
    // beside Bills — asserted against the rendered nav, because a strip of
    // sub-tabs inside Sales passed the previous version of this test.
    const nav = [...doc.querySelectorAll('.nav-btn')].map((b) => b.dataset.tab);
    ck('all four are tabs in their own right',
       ['sales', 'sales-incoming', 'sales-freight', 'sales-commission']
         .every((t) => nav.includes(t)), nav.join(','));
    ck('  labelled by what they hold, not by "Sales"',
       [...doc.querySelectorAll('.nav-btn')]
         .filter((b) => String(b.dataset.tab).startsWith('sales'))
         .map((b) => b.textContent).join(',') === 'Outgoing,Incoming,Freight,Commission',
       [...doc.querySelectorAll('.nav-btn')].filter((b) => String(b.dataset.tab).startsWith('sales')).map((b) => b.textContent).join(','));
    ck('  sitting next to Bills, so the grouping is still legible',
       nav.indexOf('sales') === nav.indexOf('bills') + 1, nav.join(','));
    ck('  and there is no second row of sub-tabs',
       doc.querySelectorAll('.sales-sub').length === 0,
       'two rows of tabs for one thing is chrome, not navigation');
    ck('  and the duplicate container is called out where she will see it',
       /appears 2 times under B1/.test(doc.getElementById('viewRoot').textContent),
       'a duplicate double-counts on the join to Bills');

    // ── FREIGHT ──────────────────────────────────────────────────────────
    await w.renderSalesSubTab('freight');
    await new Promise((r) => setTimeout(r, 60));
    let text = doc.getElementById('viewRoot').textContent;
    ck('Freight lists the charge she pays', /Ocean freight/.test(text));
    ck('  with the note that says why it exists',
       /LAX to Busan/.test(text), 'a charge without its reason is a column again');
    ck('  what is paid and what is left', /1,850\.00/.test(text) && /1,000\.00/.test(text), text.slice(0, 200));
    ck('  and NOT the commission, which is its own tab',
       !/Commission/.test(doc.getElementById('subBody').textContent));
    ck('  the container and booking are shown, not re-entered',
       !doc.querySelector('#subBody input[name="container_no"]'),
       'a Freight table with its own container box is a second copy that will disagree');

    // ── COMMISSION ───────────────────────────────────────────────────────
    await w.renderSalesSubTab('commission');
    await new Promise((r) => setTimeout(r, 60));
    text = doc.getElementById('subBody').textContent;
    ck('Commission shows how it was worked out, not a second weight box',
       /6 per MT on 13\.154 MT invoiced/.test(text), text.slice(0, 160));
    ck('  and not the freight charge', !/Ocean freight/.test(text));

    // Paying it.
    doc.getElementById('btnSettle').click();
    await new Promise((r) => setTimeout(r, 50));
    ck('Pay opens the settle form', !!doc.getElementById('stModal'));
    ck('  listing only what this tab is about',
       doc.querySelectorAll('#stRows tr[data-key]').length === 1,
       [...doc.querySelectorAll('#stRows tr[data-key]')].map((r) => r.dataset.key).join(','));
    const fire = (el, ev) => el.dispatchEvent(new w.Event(ev, { bubbles: true }));
    doc.getElementById('stAmount').value = '78.92'; fire(doc.getElementById('stAmount'), 'input');
    ck('  and refuses to save until it is allocated',
       doc.getElementById('stSave').disabled === true);
    const cb = doc.querySelector('.stPick');
    cb.checked = true; fire(cb, 'change');
    ck('  ticking it fills what is owed and unlocks Save',
       doc.getElementById('stSave').disabled === false,
       doc.querySelector('.stAmt').value);
    doc.getElementById('stPayee').value = 'Agent Ltd';
    doc.getElementById('stBank').value = 'Chase';
    doc.getElementById('stSave').click();
    await new Promise((r) => setTimeout(r, 40));
    ck('recording posts one settlement', posted.length === 1, JSON.stringify(posted));
    if (posted.length) {
        ck('  naming the container AND what on it',
           posted[0].allocations[0].sale_id === 'S1' && posted[0].allocations[0].kind === 'commission',
           JSON.stringify(posted[0].allocations[0]));
        ck('  and who was paid', posted[0].payee === 'Agent Ltd');
    }

    // ── INCOMING ─────────────────────────────────────────────────────────
    await w.renderSalesSubTab('incoming');
    await new Promise((r) => setTimeout(r, 60));
    text = doc.getElementById('subBody').textContent;
    ck('Incoming lists what arrived', /11,865\.00/.test(text), text.slice(0, 160));
    ck('  and says how much of the gap was a bank charge',
       /25\.00 deducted/.test(text), text.slice(0, 220));
    ck('  with the bank charge kept on its own figure',
       /Bank charges/.test(text) && /Discounts/.test(text));
    ck('  and a way to record a new one', !!doc.getElementById('btnReceipt'));

    // ── AND OUTGOING STILL RENDERS OUTGOING ──────────────────────────────
    // It did not, briefly: renderLedgerTab opened with a guard left over from
    // the sub-tab build that sent it back to whichever sales view had been
    // shown last. Clicking Outgoing would have quietly given her Incoming.
    // ── FROM THE MATCHING BILL ───────────────────────────────────────────
    await w.renderLedgerTab('sales');
    await new Promise((r) => setTimeout(r, 60));
    doc.getElementById("btnFromBill").click();
    await new Promise((r) => setTimeout(r, 50));
    ck('Outgoing renders Outgoing, whatever was open before',
       !!doc.getElementById('btnFromBill') && !doc.getElementById('subBody'),
       'a stale sub-tab guard sent it to Incoming instead');
    ck('New from bill lists the containers already bought', !!doc.getElementById('fbModal'));
    ck('  one already sold is shown and NOT offered',
       doc.querySelector('.fbPick[data-id="B_B"]').disabled === true,
       'a second sale on one container double-counts on the join');
    ck('  the unsold one is', doc.querySelector('.fbPick[data-id="B_A"]').disabled === false);
    doc.querySelector('.fbPick[data-id="B_A"]').click();
    await new Promise((r) => setTimeout(r, 60));
    const form = doc.getElementById('ledgerForm');
    ck('choosing it opens the sale form', !!form);
    ck('  with the container carried across, not typed again',
       form.querySelector('[name="container_no"]').value === 'MSKU1',
       form.querySelector('[name="container_no"]').value);
    ck('  and the booking with it, which is what makes the join work',
       form.querySelector('[name="booking_no"]').value === 'DALA1',
       'a typo here breaks margin-per-container in silence');
    ck('  the purchased weight as a starting point',
       form.querySelector('[name="weight"]').value === '29000',
       form.querySelector('[name="weight"]').value);
    ck('  still dated today in LA', /^\d\d\/\d\d\/\d{4}$/.test(form.querySelector('[name="date"]').value));
    ck('  and NOTHING was saved by opening it',
       !doc.getElementById('ledSaveState') || !/Saved/.test(doc.getElementById('ledSaveState').textContent),
       'a suggestion is not a row');

    await new Promise((r) => setTimeout(r, 60));
    dom.window.close();
}

section('G7 — a fixed list the form actually offers');
{
    // `choices` sat on the sales columns for a day and was rendered nowhere,
    // so Payment terms was a plain text box that the server then rejected on
    // save — the worst order to find out that a field has a fixed set.
    const ROWS = [{ id: 'S1', booking_no: 'B1', container_no: 'C1', customer: 'Daekwang',
                    date: '09/10/2026', terms: 'TT', shipment_terms: 'CFR',
                    weight: 29000, invoice_price: 0.41 }].map(sales.withTotals);
    const { w, dom } = await mount({
        '/api/sales': () => ({ sales: ROWS, summary: sales.summary(ROWS),
            columns: sales.tableColumns(), fields: sales.COLUMNS, groups: sales.GROUPS,
            facets: sales.facets(ROWS), filterable: sales.FILTERABLE, total_unfiltered: 1 }),
        '/api/sales/preview': () => sales.compute({}),
        '/api/bills': billsRoute,
    });
    const doc = w.document;
    await w.renderLedgerTab('sales');
    w.openLedgerForm('sales');

    ck('Payment terms offers its fixed list',
       !!doc.querySelector('#ledlist-terms option[value="LC"]')
       && !!doc.querySelector('#ledlist-terms option[value="TT"]'),
       'a closed list the form does not show is a text box that fails on save');
    ck('  and the box is wired to it',
       doc.querySelector('#ledgerForm [name="terms"]').getAttribute('list') === 'ledlist-terms');
    ck('Shipment terms offers the standard ones',
       !!doc.querySelector('#ledlist-shipment_terms option[value="FOB"]')
       && !!doc.querySelector('#ledlist-shipment_terms option[value="CIF"]'));
    ck('  with what she has already used in the list too',
       !!doc.querySelector('#ledlist-shipment_terms option[value="CFR"]'));
    ck('  and neither is a <select>, so an unlisted term can still be typed',
       doc.querySelector('#ledgerForm [name="shipment_terms"]').tagName === 'INPUT');

    const labels = [...doc.querySelectorAll('#viewRoot thead th')].map((t) => t.textContent.trim());
    ck('the table reads in her order',
       labels.indexOf('Proforma date') === labels.indexOf('Item') + 1
       && labels.indexOf('Reference') === labels.indexOf('Proforma date') + 1
       && labels.indexOf('Shipment terms') === labels.indexOf('Payment terms') + 1,
       labels.join(' | '));
    ck('  and "Terms" alone is gone from the header',
       !labels.includes('Terms'), labels.join(' | '));

    doc.getElementById('ledClose').click();
    await new Promise((r) => setTimeout(r, 40));
    dom.window.close();
}

section('G8 — the sheet has two palettes and she picks');
{
    // Apsara, 2026-09-10, shown three palettes: "B but give an option to
    // toggle to C as well."
    const { w, dom } = await mount({ '/api/bills': billsRoute,
        '/api/bills/preview': () => bills.compute({}) });
    const doc = w.document;
    await w.renderLedgerTab('bills');
    w.openLedgerForm('bills');

    const sheetOf = () => doc.querySelector('#ledgerModal .card').getAttribute('style');
    ck('it opens on the paper palette', /background:#FBFBFA/.test(sheetOf()), sheetOf().slice(0, 80));
    ck('  which is warm, not the stark white it was',
       !/#F6F7F8|#FFFFFF;/.test(sheetOf().split(';')[0]), sheetOf().slice(0, 60));
    ck('  and money reads blue, not the dark app\'s green',
       w.ledgerTheme().accent === '#185FA5', w.ledgerTheme().accent);

    ck('  and Save wears the accent, not the dark app\'s green',
       rgbEq(doc.getElementById('ledSave').style.backgroundColor, w.ledgerTheme().accent),
       doc.getElementById('ledSave').style.backgroundColor);

    const toggle = doc.getElementById('ledTheme');
    ck('every form carries the toggle', !!toggle);
    ck('  labelled with where it goes, not where it is',
       toggle.textContent === 'Dark', toggle.textContent);

    toggle.click();
    await new Promise((r) => setTimeout(r, 40));
    ck('clicking it actually repaints the form',
       /background:#14181B/.test(sheetOf()), sheetOf().slice(0, 80));
    ck('  not merely stores a preference and leave the sheet alone',
       w.ledgerTheme().ink === '#E8EDF0', w.ledgerTheme().ink);
    ck('  and the label flips',
       doc.getElementById('ledTheme').textContent === 'Paper',
       doc.getElementById('ledTheme').textContent);

    ck('the choice is remembered', w.localStorage.getItem('ledgerTheme') === 'dark',
       String(w.localStorage.getItem('ledgerTheme')));

    // Status colours must move with the sheet or the red goes unreadable on
    // dark — they were hardcoded in eleven places before this.
    ck('the status colours belong to the palette, not to the form',
       w.ledgerTheme().danger === '#F09595' && w.ledgerTheme().ok === '#5DCAA5',
       JSON.stringify([w.ledgerTheme().danger, w.ledgerTheme().ok]));
    const html = fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8');
    ck('  with no form carrying a hex of its own',
       !/#B3261E|#2F7D22|#8A6D00/.test(html),
       'eleven hardcoded status colours is eleven places to miss');

    doc.getElementById('ledTheme').click();
    await new Promise((r) => setTimeout(r, 40));
    ck('and back again', /background:#FBFBFA/.test(sheetOf()), sheetOf().slice(0, 80));

    doc.getElementById('ledClose').click();
    await new Promise((r) => setTimeout(r, 40));
    dom.window.close();
}

section('G9 — the Trucking tab');
{
    // Apsara, 2026-09-10: "Similar to sales,crate a tab called Trucking".
    const posted = [];
    const seen = [];
    const ROWS = [
        { bill_id: 'B1', date: '09/10/2026', booking_no: 'HB1',
          container_no: 'HAULU1', supplier: 'Haul Metals', trucking_company: 'Sher Trucking',
          amount: 805, paid: 0, balance: 805, status: 'unpaid', priced: true,
          trucker_invoice_no: '8727', verified_on: '2026-08-21', conflict: null,
          split: { parts: [{ key: 'line_haul', label: 'Line Haul', amount: 650 },
                           { key: 'port_fees', label: 'Port Fees', amount: 55 },
                           { key: 'chassis_rent', label: 'Chassis Rent', amount: 0 }],
                   others: [{ what: 'Prepull', amount: 100, note: 'held overnight at the terminal' }],
                   others_total: 100 } },
        { bill_id: 'B4', date: '09/09/2026', booking_no: 'HB1',
          container_no: 'HAULU4', supplier: 'Haul Metals', trucking_company: 'Sher Trucking',
          amount: null, paid: 0, balance: 0, status: 'missing', priced: false,
          missing: ['trucking amount'], split: null },
        { bill_id: 'B2', date: '09/08/2026', booking_no: 'HB1',
          container_no: 'HAULU2', supplier: 'Haul Metals', trucking_company: 'Sher Trucking',
          amount: 1200, paid: 400, balance: 800, status: 'part', priced: true, split: null },
        { bill_id: 'B3', date: '09/02/2026', booking_no: 'HB2',
          container_no: 'HAULU3', supplier: 'Haul Metals', trucking_company: 'Bayou Haulage',
          amount: 900, paid: 900, balance: 0, status: 'paid', priced: true, split: null },
    ];
    const { w, dom } = await mount({
        '/api/metals-trucking': (q, opts) => {
            if (opts && opts.method === 'POST') { posted.push(JSON.parse(opts.body)); return { ok: true }; }
            seen.push(q);
            const rows = ROWS.filter((r) => !q.trucking_company || r.trucking_company === q.trucking_company)
                             .filter((r) => !q.status || (q.status === 'unpaid' ? r.status !== 'paid' : r.status === q.status));
            return { payables: rows, open_payables: rows.filter((r) => r.balance > 0.005),
                     summary: { amount: rows.reduce((t, r) => t + r.amount, 0),
                                paid: rows.reduce((t, r) => t + r.paid, 0),
                                outstanding: rows.reduce((t, r) => t + r.balance, 0),
                                unpaid_count: rows.filter((r) => r.status === 'unpaid' || r.status === 'part').length,
                                missing_count: rows.filter((r) => r.status === 'missing').length },
                     total_unfiltered: ROWS.length,
                     facets: { trucking_company: ['Bayou Haulage', 'Sher Trucking'],
                               status: ['unpaid', 'part', 'paid'] },
                     payments: [], modes: ['Wire', 'Cash'], banks: ['Chase'] };
        },
    });
    const doc = w.document;
    await w.renderMetalsTruckingTab();

    const nav = [...doc.querySelectorAll('.nav-btn')].map((b) => b.dataset.tab);
    ck('Trucking is its own tab', nav.includes('metals-trucking'), nav.join(','));
    ck('  and the Edge YARD trucker tab is still there, separately',
       nav.includes('truckers'),
       'different company, different store, different line in the spend report');

    let text = doc.getElementById('viewRoot').textContent;
    ck('every haul from the bills is listed',
       doc.querySelectorAll('tr[data-bill]').length === 4,
       String(doc.querySelectorAll('tr[data-bill]').length));
    ck('  with what it came from', /HAULU1/.test(text) && /Haul Metals/.test(text) && /HB1/.test(text));
    ck('  its trucker', /Sher Trucking/.test(text));
    ck('  and what is outstanding', /\$1,605\.00/.test(text), text.slice(0, 200));
    ck('a part-paid haul says so', /part/.test(text));
    // ── THE FORGOTTEN ONE IS VISIBLE ─────────────────────────────────────
    ck('a haul nobody priced is on the list, not hidden',
       !!doc.querySelector('tr[data-bill="B4"]'),
       'the first version left these out and made the mistake invisible');
    ck('  reading "not entered" rather than a dash or a zero',
       /not entered/.test(doc.querySelector('tr[data-bill="B4"]').textContent),
       doc.querySelector('tr[data-bill="B4"]').textContent.replace(/\s+/g, ' ').trim());
    ck('  flagged as needing an amount',
       /no amount/.test(doc.querySelector('tr[data-bill="B4"]').textContent));
    ck('  and counted on its own card',
       /No amount yet/i.test(doc.getElementById('viewRoot').textContent));

    // ── CLICK FOR THE SPLIT ──────────────────────────────────────────────
    const detail = doc.querySelector('.trkDetail[data-for="B1"]');
    ck('a haul with a split has one folded away', !!detail);
    ck('  hidden until she asks', detail.style.display === 'none',
       'five more columns is what made the first bill form unreadable');
    doc.querySelector('tr[data-bill="B1"]').click();
    await new Promise((r) => setTimeout(r, 20));
    ck('clicking the row opens it', detail.style.display === 'table-row', detail.style.display);
    const dt = detail.textContent;
    ck('  showing the parts her sheet names',
       /Line Haul/.test(dt) && /Port Fees/.test(dt) && /Chassis Rent/.test(dt), dt.slice(0, 160));
    ck('  with their figures', /\$650\.00/.test(dt) && /\$55\.00/.test(dt));
    ck('  Others totalled', /Others/.test(dt) && /\$100\.00/.test(dt));
    ck('  and each Other explained, which is the whole point of it',
       /held overnight at the terminal/.test(dt), dt.slice(0, 220));
    ck('  the trucker\'s own invoice number', /8727/.test(dt));
    ck('  and when it was last verified', /2026-08-21/.test(dt));
    doc.querySelector('tr[data-bill="B1"]').click();
    await new Promise((r) => setTimeout(r, 20));
    ck('clicking again folds it back', detail.style.display === 'none');
    ck('a haul with no split has nothing to open',
       !doc.querySelector('.trkDetail[data-for="B2"]'),
       'an empty drawer is a click that does nothing');
    ck('  and a settled one says paid', /paid/.test(text));

    // ── HER FOUR FILTERS REACH THE SERVER ────────────────────────────────
    const co = doc.querySelector('[data-trk-filter="trucking_company"]');
    ck('there is a filter for each of the ones she kept',
       !!co && !!doc.querySelector('[data-trk-filter="status"]')
       && !!doc.querySelector('[data-trk-filter="from"]')
       && !!doc.querySelector('[data-trk-filter="to"]'));
    ck('  and no month picker beside the date range',
       !doc.querySelector('[data-trk-filter="month"]'),
       'two controls for one question can contradict each other');
    co.value = 'Sher Trucking';
    co.dispatchEvent(new w.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    ck('choosing one asks the SERVER, not the browser',
       seen.some((q) => q.trucking_company === 'Sher Trucking'),
       JSON.stringify(seen));
    ck('  and the table narrows', doc.querySelectorAll('tr[data-bill]').length === 3);
    ck('  the cards narrow with it, so they describe what is on screen',
       /\$2,005\.00/.test(doc.getElementById('viewRoot').textContent),
       'a summary over everything while the table shows a subset is what breaks a filter');

    doc.getElementById('trkClear').click();
    await new Promise((r) => setTimeout(r, 50));
    ck('Clear puts everything back', doc.querySelectorAll('tr[data-bill]').length === 4);

    // ── PAY ──────────────────────────────────────────────────────────────
    doc.getElementById('btnPayTrucking').click();
    await new Promise((r) => setTimeout(r, 50));
    ck('Pay asks which trucker first', !!doc.getElementById('trkWho'));
    const picks = [...doc.querySelectorAll('.trkWhoPick')];
    ck('  offering only those still owed money', picks.length === 1,
       picks.map((b) => b.dataset.company).join(','));
    ck('  with what they are owed', /\$1,605\.00 owing/.test(picks[0].textContent),
       picks[0].textContent.replace(/\s+/g, ' ').trim());
    picks[0].click();
    await new Promise((r) => setTimeout(r, 50));
    ck('choosing opens the payment form', !!doc.getElementById('trkModal'));
    ck('  listing only that trucker\'s hauls',
       doc.querySelectorAll('#trkRows tr[data-bill]').length === 2,
       'a wire marked Sher against a container Bayou hauled is a false statement');
    ck('  a part-paid one says how much is already in',
       /400\.00 paid of/.test(doc.querySelector('#trkRows tr[data-bill="B2"]').textContent));

    const fire = (el, ev) => el.dispatchEvent(new w.Event(ev, { bubbles: true }));
    doc.getElementById('trkAmount').value = '1605'; fire(doc.getElementById('trkAmount'), 'input');
    ck('  and refuses to save until it is allocated',
       doc.getElementById('trkSave').disabled === true);
    doc.querySelectorAll('.trkPick').forEach((cb) => { cb.checked = true; fire(cb, 'change'); });
    ck('  ticking both fills what they owe and unlocks Save',
       doc.getElementById('trkSave').disabled === false,
       [...doc.querySelectorAll('.trkAmt')].map((e) => e.value).join(','));
    doc.getElementById('trkBank').value = 'Chase';
    doc.getElementById('trkSave').click();
    await new Promise((r) => setTimeout(r, 40));
    ck('one transfer, two hauls, one record', posted.length === 1, JSON.stringify(posted));
    if (posted.length) {
        ck('  naming the trucker', posted[0].trucking_company === 'Sher Trucking');
        ck('  and both containers', posted[0].allocations.length === 2);
        ck('  summing to what was sent',
           posted[0].allocations.reduce((t, a) => t + a.amount, 0) === 1605);
    }
    await new Promise((r) => setTimeout(r, 40));
    dom.window.close();
}

section('G10 — labels beside their fields, and her five groups');
{
    // Apsara, 2026-09-10, after three rounds of "the design looks not good":
    // the difference between the form and the invoice screen she called neat
    // was that its labels sit BESIDE the field, not above it.
    const { w, dom } = await mount({ '/api/bills': billsRoute,
        '/api/bills/preview': () => bills.compute({}) });
    const doc = w.document;
    await w.renderLedgerTab('bills');
    w.openLedgerForm('bills');
    const form = doc.getElementById('ledgerForm');

    const headings = [...form.querySelectorAll('div')]
        .map((d) => d.firstChild && d.firstChild.nodeType === 3 ? d.textContent.trim() : '')
        .filter((t) => /^(SHIPMENT|CONTAINER|PURCHASE|TRUCKING|ITEMS AND WEIGHTS)/i.test(t));
    ck('her five groups are the sections',
       ['Shipment', 'Container', 'Purchase', 'Trucking', 'Items and weights']
         .every((g) => form.textContent.toLowerCase().includes(g.toLowerCase())),
       form.textContent.replace(/\s+/g, ' ').slice(0, 200));

    // The label is a sibling of the input, on one line — not stacked above.
    const supplier = form.querySelector('[name="supplier"]');
    const row = supplier.closest('.field');
    ck('a field sits on one line with its label',
       row && /display:flex/.test(row.getAttribute('style') || ''),
       row ? row.getAttribute('style') : 'no .field wrapper');
    ck('  and the label reads to its left',
       row && row.querySelector('span') && /Supplier/.test(row.querySelector('span').textContent),
       row ? row.textContent.trim().slice(0, 40) : '');
    ck('  with no stacked <label> above it any more',
       !row.querySelector('label'),
       'a label above doubles the vertical noise, which is what read as dense');

    // Everything inputFor gives a field must survive being re-wrapped: this
    // is a regex over generated markup, so the things it could quietly drop
    // are asserted one by one.
    ck('the type-ahead survives the rewrap',
       supplier.getAttribute('list') === 'ledlist-supplier',
       supplier.getAttribute('list'));
    ck('  and its options came with it',
       !!form.querySelector('#ledlist-supplier option'));
    ck('  numeric fields keep their number pad',
       form.querySelector('[name="gross"]').getAttribute('inputmode') === 'decimal');
    ck('  and no spinners came back',
       ![...form.querySelectorAll('input')].some((i) => i.type === 'number'));
    ck('  the date box still gets its picker',
       form.querySelector('[name="date"]').dataset.dpWired === '1');
    ck('  and the money adornment is still there',
       !!form.querySelector('[name="supplier_price"]')
       && !!doc.getElementById('ledPriceUnit'),
       'the /lb or /MT beside the price is how a wrong unit stays visible');

    // Weights stay a grid: five short numbers read better in a row than as
    // five label-and-field lines.
    const gross = form.querySelector('[name="gross"]').closest('.field');
    ck('the weights row is still a grid, not five stacked lines',
       gross && !/display:flex/.test(gross.getAttribute('style') || ''),
       gross ? gross.getAttribute('style') : '');

    doc.getElementById('ledClose').click();
    await new Promise((r) => setTimeout(r, 40));
    dom.window.close();
}

section('H — and the sheet write is coalesced, not one per keystroke');
{
    // The Sheets API is rate-limited per minute. "On every modification"
    // taken literally is eighteen upserts to get one correct row.
    const ship = require(path.join(ROOT, 'helpers/shipmentSheetLog'));
    const src = fs.readFileSync(path.join(ROOT, 'helpers/shipmentSheetLog.js'), 'utf8');
    ck('rapid edits to one bill collapse into one write',
       /const pending = new Map\(\)/.test(src) && /clearTimeout\(prev\.timer\)/.test(src),
       'filling eighteen fields would otherwise fire eighteen upserts');
    ck('  keyed per bill, so two different bills both still get written',
       /pending\.set\(bill\.id/.test(src) && /pending\.get\(bill\.id\)/.test(src));
    ck('  and a queued write cannot hold the process open',
       /unref/.test(src), 'a pending timer would hang every short-lived run');
    ck('  with a flush for shutdown', typeof ship.flushPending === 'function');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('SUITE CRASHED:', e); process.exit(1); });
