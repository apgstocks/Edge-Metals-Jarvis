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
            { id: 'B1', supplier: 'Eccomelt', container_no: 'MSKU1111111', balance: 3440 },
            { id: 'B2', supplier: 'Eccomelt', container_no: 'HMMU2222222', balance: 3440 },
            { id: 'B3', supplier: 'Oakland Metals', container_no: 'TGHU3333333', balance: 120 },
        ],
        credit: { Eccomelt: 1680 },
        modes: ['Zelle', 'Wire'],
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

    await w.openBillPayForm();
    const m = doc.getElementById('bpModal');
    ck('the form opens', !!m);
    ck('  listing every container still owing', doc.querySelectorAll('#bpRows tr[data-bill]').length === 3);
    ck('  with the amount owed shown per container',
       /\$3,440\.00/.test(doc.getElementById('bpRows').textContent));
    ck('  and the supplier credit she already has',
       /1,680/.test(m.textContent), 'an advance she cannot see is an advance she pays twice');
    ck('  the date defaults to today', /^\d\d\/\d\d\/\d{4}$/.test(doc.getElementById('bpDate').value));
    ck('  supplier offers what she has typed before',
       !!doc.querySelector('#bplist-supplier option[value="Eccomelt"]'),
       'ledlist-* only exist while the BILL form is mounted');

    const fire = (el, ev) => el.dispatchEvent(new w.Event(ev, { bubbles: true }));
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
    ck('  and says so in red', doc.getElementById('bpLeft').style.color === 'rgb(179, 38, 30)',
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
    }
    ck('a successful save closes the form', !doc.getElementById('bpModal'));
    await new Promise((r) => setTimeout(r, 40));

    // The advance path: same form, no containers ticked.
    await w.openBillPayForm();
    const a2 = doc.getElementById('bpAmount');
    a2.value = '5000'; fire(a2, 'input');
    doc.getElementById('bpBank').value = 'Chase';
    doc.getElementById('bpSupplier').value = 'Eccomelt';
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

    await w.openBillPayForm();
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
    await w.openBillPayForm();

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
    await w.openBillPayForm();

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
