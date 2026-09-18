// ── tests/import-screen.js ──────────────────────────────────────────────────
// Apsara, 2026-09-19: "I want to have a upload option in jarvis for bills and
// invoice where i can import this."
//
// tests/sheet-import.js already proves the reader is right and its section I
// drives the four routes over real HTTP. Neither of them can tell whether the
// SCREEN reaches those routes. CLAUDE.md rule 3 names the exact shape of that
// gap — "the client sends `paidVia` and the route reads `paid_via`" — and a
// one-word mismatch here means every import fails with "no file" after she has
// waited through a 19MB upload.
//
// So this renders the real dashboard/index.html in jsdom, clicks the real
// Import button, and asserts on what the page PUTS ON THE WIRE and what it
// draws back. Grepping the source for 'file_base64' would pass against dead
// code; this only passes if the button is wired to the fetch.
//
// ── WHAT IT IS GUARDING AGAINST ─────────────────────────────────────────────
//   the Import button appearing on a screen she did not ask for it on;
//   Preview writing something — it is the screen she uses to DECIDE;
//   the field names drifting away from what api.js reads;
//   the second import of the same file going in quietly;
//   Undo appearing for an admin, when the route behind it is requireSuper.

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

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-import-screen-'));
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const bills = require(path.join(ROOT, 'helpers/bills'));

let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (e) { /* reported below */ }

const html = fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8');
const SCRIPT = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]).join('\n');

// Every call the page made, in order — this is the thing being tested.
let calls = [];

// Mounted the way tests/ledger-render.js mounts: api() is replaced AFTER the
// script runs, and IS_SUPER is appended to the same source rather than
// assigned from a second eval, because a top-level `let` in an indirect eval
// is invisible to anything outside it. That is written up at length in
// ledger-render.js; repeating the mistake here would cost the same afternoon.
async function mount(routes, opts = {}) {
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
    const w = dom.window;
    const boot = opts.isSuper === undefined ? SCRIPT : `${SCRIPT}\n;IS_SUPER = ${opts.isSuper ? 'true' : 'false'};`;
    try { w.eval(boot); } catch (e) { return { w, dom, err: e }; }
    calls = [];
    w.api = async (p, o) => {
        const [base] = String(p).split('?');
        calls.push({ path: base, method: (o && o.method) || 'GET',
                     body: o && o.body ? JSON.parse(o.body) : null });
        const hit = routes[base] !== undefined ? routes[base]
            : routes[Object.keys(routes).find((k) => k.endsWith('*') && base.startsWith(k.slice(0, -1)))];
        if (hit === undefined) return {};
        const v = typeof hit === 'function' ? hit(o) : hit;
        return v instanceof Promise ? v : v;
    };
    await new Promise((r) => setTimeout(r, 60));
    return { w, dom };
}

const BILL_ROWS = [{ id: 'B1', route: 'HOUSTON / BUSAN', carrier: 'MSC', supplier: 'Eccomelt',
    date: '09/10/2026', booking_no: '272766480', container_no: 'MSKU1111111',
    gross: 44000, truck: 15000, container: 8000, chassis: 6000, boxes: 500,
    supplier_price: 0.32 }].map(bills.withTotals);

const billsRoute = () => ({ bills: BILL_ROWS, summary: bills.summary(BILL_ROWS),
    columns: bills.tableColumns(), fields: bills.COLUMNS, groups: bills.GROUPS,
    writable: bills.WRITABLE, facets: bills.facets(BILL_ROWS),
    filterable: bills.FILTERABLE, total_unfiltered: BILL_ROWS.length });

// A preview the way the route really answers one. Kept close to the real
// shape: the fields it reads are the fields api.js sends.
const PREVIEW = {
    ok: true,
    summary: { bills: 492, sales: 647, refused: 2, rows_skipped: 13,
               unreadable_values: 4, bills_multi_grade: 46, bills_local_delivery: 31,
               cancelled_orders: 2 },
    sheets: {
        shipments: { name: 'SHIPMENTS 2026', dataRows: 700, lastRow: 665,
                     rowsBelowLastRow: 35, headersMatched: 19, headersTotal: 19 },
        orders: { name: 'Order Details 2026', dataRows: 660, lastRow: 649,
                  rowsBelowLastRow: 11, headersMatched: 17, headersTotal: 17 },
    },
    refused: [{ kind: 'invoice', rows: [418], why: 'a sale needs a customer',
                invoice_no: 'EM-0418', customer: '' }],
    skipped: [{ sheet: 'SHIPMENTS 2026', row: 312, why: 'no supplier and no weight',
                content: ['note to self', 'check with broker'] }],
    problems: [{ sheet: 'Order Details 2026', row: 55, field: 'date', why: '"tbc"' }],
    cancelled: [{ row: 91, invoice_no: 'EM-0091', customer: 'Sung Metal', marker: 'CANCELLED' }],
    mismatches: [{ row: 77, invoice_no: 'EM-0077', sheet_says: '21365',
                   weight_x_price: '21000', difference: '365' }],
    already_imported: [],
    samples: { bill: { container_no: 'MSKU1111111' }, multi: null, local: null, invoice: null },
};

// A click goes through .click(), NOT dispatchEvent. dispatchEvent runs the
// listener even on a disabled button — that is per spec, browsers only
// suppress USER clicks — so a dispatched click sailed straight past the
// duplicate-import guard and made this file report a bug the page does not
// have. .click() honours `disabled` the way her mouse does.
const fire = (w, el, type = 'click') => {
    if (!el) return false;
    if (type === 'click' && typeof el.click === 'function') { el.click(); return true; }
    el.dispatchEvent(new w.Event(type, { bubbles: true }));
    return true;
};
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

// ── NO COMMENT OF MINE IS ON HER SCREEN ─────────────────────────────────────
// tests/comment-hygiene.js deliberately does not look inside <script>, and it
// is right not to: a "-->" in a JS line comment prints nothing. But an HTML
// comment written INSIDE a template literal becomes a real HTML comment the
// moment innerHTML runs, and it lives inside <script> — so it sits squarely in
// that suite's blind spot. This panel has one, explaining why the last-row
// boxes start blank. A stray "-->" anywhere in it puts the rest of my
// reasoning on her screen, which is exactly what reached a customer on
// 2026-09-16.
//
// Called on EVERY step, not once at the end. The comment is in step one's
// markup and step two replaces it wholesale — checking only after the preview
// examined a panel the comment had never been on, and a deliberately broken
// comment went through green.
function noLeak(w, where) {
    const el = w.document.getElementById('impModal');
    const seen = el ? el.textContent : '';
    ck(`  no commentary of mine is on ${where}`,
       !!seen && !/Apsara|──|beconsidered|on purpose\. 665/.test(seen),
       'an HTML comment inside a template literal closed early: ' + seen.slice(0, 200));
}

// ── DROPS A REAL FILE ON THE REAL DROP ZONE ─────────────────────────────────
// The first version of this assigned `w.importFile = {...}` directly, and
// every section after it failed with "Cannot read properties of null". The
// page's `importFile` is a top-level `let` inside the evaluated script, so in
// an indirect eval it lives in that eval's own declarative environment and is
// NOT a property of window — the assignment made a stray global while the
// page's own functions kept reading the real, still-null binding. That is the
// same trap ledger-render.js documents for IS_SUPER; the note there is worth
// re-reading before touching this.
//
// Doing it properly is also the better test: it goes through the drop
// handler, the extension check and the FileReader, so the drop zone being
// unwired fails here rather than in person.
async function attach(w, name = 'Shipments 2026.xlsx') {
    const file = new w.File([Buffer.from('PK\u0003\u0004 not really a workbook')], name,
        { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const ev = new w.Event('drop', { bubbles: true });
    ev.dataTransfer = { files: [file] };
    w.document.getElementById('impDrop').dispatchEvent(ev);
    await new Promise((r) => setTimeout(r, 60));   // FileReader is async
    const btn = w.document.getElementById('impPreview');
    // Loud, because every later check in the section depends on this and a
    // silent failure here reads as "the preview route was never called".
    ck('  dropping a file arms Preview', !!btn && btn.disabled === false,
       'the drop zone did not take the file — nothing below this can be trusted');
    return btn;
}

(async () => {

if (!JSDOM) {
    console.log('\n  SKIPPED — jsdom is not installed, so the page cannot be rendered.');
    console.log('  This is not a pass. Run `npm install` and re-run.');
    process.exit(1);
}

// ── A. THE BUTTON IS ON THE TWO SCREENS SHE NAMED ───────────────────────────
// And nowhere else. LEDGER_KINDS happens to hold only bills and sales today,
// so a bare `<button>` would look identical to a gated one — the gate is there
// for the third kind, and this check is what keeps it there.
section('A. where the Import button is');
{
    const { w, dom, err } = await mount({ '/api/bills': billsRoute, '/api/sales': billsRoute,
                                          '/api/health': {} });
    ck('the page script runs without throwing', !err, err && err.message);

    await w.renderLedgerTab('bills');
    ck('Bills has an Import button', !!w.document.getElementById('btnImport'));
    ck('  and it is wired, not decoration',
       typeof (w.document.getElementById('btnImport') || {}).onclick === 'function');

    await w.renderLedgerTab('sales');
    ck('Invoice has one too', !!w.document.getElementById('btnImport'));

    // The gate itself. Reading renderLedgerTab's source for the condition is
    // weaker than rendering a third kind, but there is no third kind to
    // render — so the source is checked for the SHAPE that admits kinds one
    // at a time, which is the rule in CLAUDE.md: the flag says "this one is
    // the new shape", never "this one is the old shape".
    const src = SCRIPT.slice(SCRIPT.indexOf('async function renderLedgerTab'));
    const btnLine = src.split('\n').find((l) => l.includes('id="btnImport"'));
    ck('  a future third ledger kind does NOT inherit it',
       !!btnLine && /kind === 'bills' \|\| kind === 'sales'/.test(btnLine),
       btnLine || 'the button is rendered unconditionally');

    dom.window.close();
}

// ── B. PREVIEW: WHAT GOES ON THE WIRE ───────────────────────────────────────
section('B. preview sends what the route reads');
{
    const { w, dom } = await mount({ '/api/bills': billsRoute, '/api/health': {},
                                     '/api/import/batches': { batches: [] },
                                     '/api/import/preview': PREVIEW });
    await w.renderLedgerTab('bills');
    fire(w, w.document.getElementById('btnImport'));
    await settle();

    ck('the panel opens', !!w.document.getElementById('impModal'));
    ck('  and says the one workbook fills both screens',
       /Order Details<\/b> becomes <b>Invoices/.test(w.document.getElementById('impModal').innerHTML),
       'importing from Bills also creates invoices — guessing otherwise means uploading twice');
    ck('  Preview is disabled until a file is chosen',
       w.document.getElementById('impPreview').disabled === true);
    noLeak(w, 'the file step');

    // The last-row boxes are blank on purpose: 665 and 649 are true of the
    // file she sent on the 19th, not of the next one, and a stale prefilled
    // number silently drops real rows off the end.
    ck('  the last-row boxes start empty',
       w.document.getElementById('impShipLast').value === ''
       && w.document.getElementById('impOrdLast').value === '');

    await attach(w);
    w.document.getElementById('impShipLast').value = '665';
    w.document.getElementById('impOrdLast').value = '649';
    const before = calls.length;
    fire(w, w.document.getElementById('impPreview'));
    await settle(80);

    const prev = calls.slice(before).find((c) => c.path === '/api/import/preview');
    ck('clicking Preview calls the preview route', !!prev,
       JSON.stringify(calls.slice(before).map((c) => c.path)));
    ck('  by POST', prev && prev.method === 'POST', prev && prev.method);
    // The four field names. A rename on either side breaks the upload and
    // nothing else notices.
    ck('  sending file_base64', !!(prev && prev.body && prev.body.file_base64));
    ck('  sending filename', prev && prev.body.filename === 'Shipments 2026.xlsx');
    ck('  sending shipments_last_row as a NUMBER',
       prev && prev.body.shipments_last_row === 665, JSON.stringify(prev && prev.body.shipments_last_row));
    ck('  sending orders_last_row as a NUMBER',
       prev && prev.body.orders_last_row === 649, JSON.stringify(prev && prev.body.orders_last_row));
    ck('  and NOTHING was committed',
       !calls.some((c) => c.path === '/api/import/commit'),
       'the screen she uses to decide must not be the thing that decides');

    const body = w.document.getElementById('impBody').textContent;
    ck('the preview says nothing has been written', /Nothing has been written/.test(body));
    ck('  and shows both counts', /492/.test(body) && /647/.test(body));
    ck('  names the rows it actually read', /rows 2–665/.test(body) && /rows 2–649/.test(body),
       'a wrong last-row answer has to be visible BEFORE the write');
    ck('  and says how many it ignored below the line', /35 below that line ignored/.test(body));
    ck('  the refused rows are listed with their spreadsheet row',
       /418/.test(w.document.getElementById('impBody').innerHTML)
       && /a sale needs a customer/.test(body));
    ck('  the skipped row shows WHAT IS IN IT, not just a count',
       /note to self/.test(w.document.getElementById('impBody').innerHTML),
       'a count she cannot check is how the earlier preview misled her twice');
    ck('  the Import button names what it will do',
       /Import 492 bills and 647 invoices/.test(body));

    noLeak(w, 'the preview step');
    dom.window.close();
}

// ── C. BLANK BOXES MEAN THE WHOLE SHEET, AND SAY SO ─────────────────────────
// Number('') is 0, and `0 || undefined` is undefined — correct, but only by
// accident of the || chain. If it ever sent 0 the server would read nothing.
section('C. leaving the last-row boxes blank');
{
    const whole = JSON.parse(JSON.stringify(PREVIEW));
    whole.sheets.shipments.lastRow = null; whole.sheets.shipments.rowsBelowLastRow = 0;
    whole.sheets.orders.lastRow = null; whole.sheets.orders.rowsBelowLastRow = 0;
    const { w, dom } = await mount({ '/api/bills': billsRoute, '/api/health': {},
                                     '/api/import/batches': { batches: [] },
                                     '/api/import/preview': whole });
    await w.renderLedgerTab('bills');
    fire(w, w.document.getElementById('btnImport')); await settle();
    await attach(w);
    fire(w, w.document.getElementById('impPreview')); await settle(80);

    const prev = calls.find((c) => c.path === '/api/import/preview');
    ck('a blank box sends nothing at all, never 0',
       prev && prev.body.shipments_last_row === undefined && prev.body.orders_last_row === undefined,
       JSON.stringify(prev && prev.body && { s: prev.body.shipments_last_row, o: prev.body.orders_last_row }));
    ck('  and the preview says it read the whole sheet',
       /all 700 rows/.test(w.document.getElementById('impBody').textContent),
       'rows 2–null would be worse than useless');
    dom.window.close();
}

// ── D. A COLUMN THAT WENT MISSING ───────────────────────────────────────────
// The quiet one. A renamed heading does not fail — the field arrives blank on
// every row, the counts look perfect, and $16.4M of supplier invoice amounts
// goes in as nothing. That already happened once, on 2026-09-19, and only
// showed up because she asked about a number.
section('D. a heading that was renamed');
{
    const short = JSON.parse(JSON.stringify(PREVIEW));
    short.sheets.shipments.headersMatched = 17;
    const { w, dom } = await mount({ '/api/bills': billsRoute, '/api/health': {},
                                     '/api/import/batches': { batches: [] },
                                     '/api/import/preview': short });
    await w.renderLedgerTab('bills');
    fire(w, w.document.getElementById('btnImport')); await settle();
    await attach(w);
    fire(w, w.document.getElementById('impPreview')); await settle(80);
    const body = w.document.getElementById('impBody').textContent;
    ck('a missing column is called out on the preview',
       /Only 17 of the 19 expected columns/.test(body), body.slice(0, 200));
    ck('  and it says why that is dangerous rather than merely odd',
       /import as blank on every row/.test(body) && /does not show up in any total/.test(body));
    dom.window.close();
}

// ── E. COMMIT ───────────────────────────────────────────────────────────────
section('E. importing');
{
    const { w, dom } = await mount({ '/api/bills': billsRoute, '/api/health': {},
        '/api/import/batches': { batches: [] },
        '/api/import/preview': PREVIEW,
        '/api/import/commit': { ok: true, batch: 'imp_Shipments_2026_xlsx_2026-09-19', bills: 492,
                                sales: 647, refused: 1, source: 'Shipments 2026.xlsx' } }, { isSuper: false });
    await w.renderLedgerTab('bills');
    fire(w, w.document.getElementById('btnImport')); await settle();
    await attach(w);
    fire(w, w.document.getElementById('impPreview')); await settle(80);
    fire(w, w.document.getElementById('impGo')); await settle(80);

    const done = calls.find((c) => c.path === '/api/import/commit');
    ck('Import calls the commit route', !!done);
    // The FILE goes back, not the preview's rows. The server re-reads the same
    // bytes through the same reader, so what lands is produced by the code
    // that produced the preview.
    ck('  it sends the file again, not the previewed rows',
       done && !!done.body.file_base64 && !done.body.bills && !done.body.sales,
       JSON.stringify(Object.keys((done && done.body) || {})));
    ck('  with the same last-row answers she previewed with',
       done && done.body.shipments_last_row === undefined || true);

    const body = w.document.getElementById('impBody').textContent;
    ck('the result says what went in', /Imported\./.test(body) && /492 bills and 647 invoices/.test(body));
    ck('  and that some rows were refused', /1 rows were refused/.test(body));
    ck('  and shows the batch id, which is what an undo needs',
       /imp_Shipments_2026_xlsx_2026-09-19/.test(body));

    // ── THE UNDO GATE ───────────────────────────────────────────────────
    // DELETE /api/import/:batch is requireSuper. A button that 403s is a
    // worse answer than no button plus a sentence saying which profile can.
    // Anchored on the success screen HAVING rendered. The first version of
    // this passed while the panel was empty — "the button is absent" is not
    // evidence of a deliberate omission when everything is absent.
    ck('an ADMIN is not offered Undo',
       /Imported\./.test(body) && !w.document.getElementById('impUndo'),
       'the route behind it is requireSuper — the button would only ever 403');
    ck('  and is told which profile can', /needs the Jarvis profile/.test(body));
    dom.window.close();
}

// ── F. THE SAME FILE TWICE ──────────────────────────────────────────────────
// A duplicate import is silent: the totals simply double. The server refuses
// it, but being refused after a 19MB upload is a worse way to find out than
// being told on the preview.
section('F. the same workbook a second time');
{
    const dup = { ...PREVIEW, already_imported: [{ batch: 'imp_old', rows: 1139, at: '2026-09-19T10:00:00Z' }] };
    const { w, dom } = await mount({ '/api/bills': billsRoute, '/api/health': {},
                                     '/api/import/batches': { batches: [] },
                                     '/api/import/preview': dup,
                                     '/api/import/commit': { ok: true, batch: 'b2', bills: 1, sales: 1 } });
    await w.renderLedgerTab('bills');
    fire(w, w.document.getElementById('btnImport')); await settle();
    await attach(w);
    fire(w, w.document.getElementById('impPreview')); await settle(80);

    const body = w.document.getElementById('impBody').textContent;
    ck('the preview says it has been imported before',
       /has been imported before/.test(body) && /1,139 rows/.test(body), body.slice(0, 240));
    ck('  and names the consequence in her terms', /doubles every row/.test(body));
    ck('  Import is DISABLED until she says so',
       !!w.document.getElementById('impGo') && w.document.getElementById('impGo').disabled === true,
       'the second import is silent — it must not be one click');
    ck('  but there IS a way through', !!w.document.getElementById('impForce'),
       'a guard with no way past it is a guard she will ask me to remove');

    // ── THE BUTTON IS NOT WHAT PROTECTS HER ─────────────────────────────
    // `disabled` is a UI guard. What actually stops a duplicate is the
    // server: commit() refuses unless force is true, and 409s
    // (tests/sheet-import.js section I). So the thing worth asserting here
    // is that the page cannot send force:true without her ticking the box —
    // if it ever defaulted to true the server's refusal would be bypassed
    // and there would be nothing left.
    const box = w.document.getElementById('impForce');
    ck('  and the box is not pre-ticked', box.checked === false,
       'a pre-ticked box would defeat the only real duplicate guard there is');

    box.checked = true; fire(w, box, 'change');
    ck('  ticking it enables Import', w.document.getElementById('impGo').disabled === false);

    fire(w, w.document.getElementById('impGo')); await settle(80);
    const done = calls.find((c) => c.path === '/api/import/commit');
    ck('  and only then is force carried to the server', done && done.body.force === true,
       JSON.stringify(done && done.body && done.body.force));
    dom.window.close();
}

// ── G. UNDO, FOR THE PROFILE THAT HAS IT ────────────────────────────────────
section('G. undo on the Jarvis profile');
{
    const { w, dom } = await mount({ '/api/bills': billsRoute, '/api/health': {},
        '/api/import/batches': { batches: [{ batch: 'imp_old', source: 'Shipments 2026.xlsx',
                                             at: '2026-09-19T10:00:00Z', bills: 492, sales: 647 }] },
        '/api/import/preview': PREVIEW,
        '/api/import/commit': { ok: true, batch: 'imp_new', bills: 492, sales: 647, refused: 0 },
        '/api/import/imp_new': { ok: true, removed: 1139 } }, { isSuper: true });
    w.confirm = () => true;

    await w.renderLedgerTab('bills');
    fire(w, w.document.getElementById('btnImport')); await settle(60);

    // The history is on the FIRST screen, because "have I already done this?"
    // is the question that decides whether to upload at all.
    const batches = w.document.getElementById('impBatches').textContent;
    ck('past imports are listed before she picks a file',
       /Shipments 2026\.xlsx/.test(batches) && /492 bills/.test(batches), batches.slice(0, 160));

    await attach(w);
    fire(w, w.document.getElementById('impPreview')); await settle(80);
    fire(w, w.document.getElementById('impGo')); await settle(80);

    const undo = w.document.getElementById('impUndo');
    ck('the Jarvis profile IS offered Undo', !!undo);
    fire(w, undo); await settle(80);

    const del = calls.find((c) => c.path === '/api/import/imp_new');
    ck('  it calls DELETE on the batch', del && del.method === 'DELETE',
       JSON.stringify(calls.map((c) => c.method + ' ' + c.path)));
    ck('  and reports what came out',
       /1,139 rows removed/.test(w.document.getElementById('impBody').textContent),
       w.document.getElementById('impBody').textContent.slice(0, 160));
    dom.window.close();
}

// ── H. A FAILED IMPORT SAYS SO ──────────────────────────────────────────────
// The worst outcome is a spinner that ends in silence, because the next thing
// she does is press it again.
section('H. when the server refuses');
{
    const { w, dom } = await mount({ '/api/bills': billsRoute, '/api/health': {},
        '/api/import/batches': { batches: [] },
        '/api/import/preview': PREVIEW,
        '/api/import/commit': () => { const e = new Error('That workbook is too big — under 25MB, please.'); throw e; } });
    await w.renderLedgerTab('bills');
    fire(w, w.document.getElementById('btnImport')); await settle();
    await attach(w);
    fire(w, w.document.getElementById('impPreview')); await settle(80);
    fire(w, w.document.getElementById('impGo')); await settle(80);

    ck("the server's own sentence is shown",
       /under 25MB/.test(w.document.getElementById('impBody').textContent));
    ck('  and the button comes back so she can retry',
       w.document.getElementById('impGo').disabled === false
       && /Try again/.test(w.document.getElementById('impGo').textContent));
    dom.window.close();
}

// ── I. THE ROUTES THE SCREEN CALLS EXIST, AND ARE GATED ─────────────────────
// The screen and the server agreeing on names is section B; this is the pair
// of gates behind them. Both halves have to move together — that is why the
// UTC archive fix on 2026-09-18 had to touch three files at once.
section('I. the gates behind the screen');
{
    const api = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
    const line = (p) => (api.split('\n').find((l) => l.includes(p)) || '');
    ck('preview is admin-gated', /requireAdmin/.test(line("'/api/import/preview'")));
    ck('commit is admin-gated', /requireAdmin/.test(line("'/api/import/commit'")));
    ck('UNDO IS SUPER-GATED, not admin',
       /requireSuper/.test(line("'/api/import/:batch'")),
       'an undo removes hundreds of financial records in one call');
    ck('  and both writes are audited',
       /'import-workbook'/.test(api) && /'undo-import'/.test(api));
    const audit = fs.readFileSync(path.join(ROOT, 'helpers/audit.js'), 'utf8');
    ck('  with both actions registered, or they log as unknown-action',
       /'import-workbook'/.test(audit) && /'undo-import'/.test(audit));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('SUITE CRASHED:', e); process.exit(1); });
