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
    ck('the bill form is a light sheet',
       /background:#F6F7F8/.test(sheet.getAttribute('style') || ''),
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
       inputs.filter((i) => i.name).every((i) => /20,\s*24,\s*27|#14181B/i.test(i.style.color || '')),
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

    // And her last instruction: "Swap places of route and supplier".
    const order = [...form.querySelectorAll('[name]')].map((i) => i.name);
    ck('route and supplier are swapped',
       order.indexOf('supplier') < order.indexOf('route'),
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
    ck('  naming what is still missing',
       /still needs date and supplier/.test(doc.getElementById('ledSaveState').textContent),
       'saved and unfinished are both worth knowing');

    await type('supplier', 'Eccomelt');
    const puts = saves().filter((c) => c.method === 'PUT');
    ck('every later change UPDATES the same row', puts.length >= 1, JSON.stringify(saves().map((c) => c.method)));
    ck('  by id, which is what keeps the sheet to one row',
       puts.every((c) => c.path === '/api/bills/NEW1'), JSON.stringify(puts.map((c) => c.path)));
    ck('  and never a second POST', saves().filter((c) => c.method === 'POST').length === 1,
       'a second create is a second row in her sheet');

    doc.getElementById('ledClose').click();
    ck('close removes the form', !doc.getElementById('ledgerModal'));
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
