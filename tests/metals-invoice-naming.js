// ── tests/metals-invoice-naming.js ────────────────────────────────────────
// Apsara, 2026-09-16: "change the sales in edge metals as invoice."
//
// ── WHY A RENAME GETS ITS OWN FILE ──────────────────────────────────────────
// Because the dangerous version of this change is indistinguishable from the
// safe one at a glance, and nothing in the suite noticed either way: 56
// page-heading checks, 461 bills-and-sales checks and 354 render checks all
// stayed green through it. Not one of them asserts what that tab is CALLED.
//
// The safe change renames what she reads. The dangerous one renames the wire
// with it — the route, the stored keys, the payment kinds — and it would look
// tidier. It would also:
//
//   - orphan every sale already on file, keyed 'sale' / 'sale_cost'
//   - break helpers/spendReport.js, which splits on exactly those kinds
//   - and, worst, quietly UNBLOCK STAFF. /api/sales is deliberately absent
//     from STAFF_ALLOWED_PATH_PREFIXES; a route renamed to /api/invoices is
//     not on that list either, and "not on the list" is how the allowlist
//     says ALLOWED for a prefix nobody thought to add. A rename would have
//     opened Edge Metals to staff and looked like a cosmetic commit.
//
// So section B is the real subject of this file, and section A is the part she
// asked for.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-invnaming-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD   = 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = 'staff-pw-ccccccccccc';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('  ABORT  config not isolated'); process.exit(1); }

const { JSDOM } = require('jsdom');
const sales = require(path.join(ROOT, 'helpers/sales'));
const html = fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'mobile-app/www/index.html'), 'utf8');
const SCRIPT = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — what she reads says Invoice');
// ══════════════════════════════════════════════════════════════════════════
{
    // RENDERED, not grepped. A label in a config object proves a string
    // exists, not that it reaches a screen — the trap tests/ledger-render.js
    // was written to close, and renaming a heading is exactly the change that
    // would sail through a source check while the page still drew the old one
    // from somewhere else.
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
    const w = dom.window;
    w.eval(SCRIPT);
    w.api = async (p) => {
        if (String(p).split('?')[0] !== '/api/sales') return {};
        const rows = [];
        return { sales: rows, summary: sales.summary(rows), columns: sales.tableColumns(),
                 fields: sales.COLUMNS, groups: sales.GROUPS, writable: sales.WRITABLE,
                 facets: sales.facets(rows), total_unfiltered: 0 };
    };
    await new Promise((r) => setTimeout(r, 60));
    await w.renderLedgerTab('sales');
    const root = w.document.getElementById('viewRoot');
    const text = root.textContent;

    ck('the register is headed Invoice', /Invoice register/.test(text),
       (text.match(/\S.{0,40}register/) || [''])[0]);
    ck('  and not Sales register', !/Sales register/.test(text));
    ck('the add button says invoice', /Add invoice/i.test(text), text.slice(0, 200));
    ck('  and no button still offers to add a sale', !/Add sale/i.test(text));

    // ── THE SIDEBAR ENTRY, READ OFF THE SIDEBAR ──────────────────────────
    // renderNav() and then the DOM, NOT w.NAV_ITEMS. That array is a
    // top-level `const`, which is a script-scope binding and NOT a window
    // property — so w.NAV_ITEMS is undefined and the first version of these
    // two checks failed for a reason with nothing to do with the rename.
    // Seventh time this project has hit that; writing it down again because
    // the sixth note clearly was not enough.
    //
    // Reading the rendered button is the better assertion anyway: it is the
    // thing she actually clicks.
    w.renderNav();
    const buttons = [...w.document.querySelectorAll('#sideNav button[data-tab]')];
    // Read off .nav-label, NOT the whole button. When the sidebar collapsed to
    // a rail (2026-09-16 to 2026-09-19) each button also carried a
    // .nav-initials span, so textContent was "INVInvoice" — this failed on
    // correct code, the same shape of mistake as reading a heading's
    // textContent when the count sits beside it in its own span.
    //
    // The rail is gone and the span with it, so the two now agree. Kept
    // reading .nav-label anyway: it is the element that holds the NAME, and
    // the next thing added beside it would break this again.
    const nameOf = (b) => ((b.querySelector('.nav-label') || b).textContent || '').trim();
    const salesBtn = buttons.find((b) => b.dataset.tab === 'sales');
    ck('the sidebar entry reads Invoice', salesBtn && nameOf(salesBtn) === 'Invoice',
       salesBtn ? nameOf(salesBtn) : `no button — ${buttons.length} rendered`);
    ck('  and no sidebar entry still reads Sales',
       !buttons.some((b) => nameOf(b) === 'Sales'),
       buttons.map(nameOf).join(', '));

    // Filed under Edge Metals still — the heading above it is what says whose
    // books this is, and that is the distinction the whole sidebar is
    // arranged around.
    const headings = [...w.document.querySelectorAll('#sideNav .nav-section-label')].map((d) => d.textContent.trim());
    ck('  still under the Edge Metals heading', headings.includes('Edge Metals'), headings.join(' | '));

    dom.window.close();
}

// ══════════════════════════════════════════════════════════════════════════
section('B — the wire did NOT move');
// ══════════════════════════════════════════════════════════════════════════
{
    // ── THE SECURITY PROPERTY, FIRST ─────────────────────────────────────
    // Staff must not reach Edge Metals. This holds because /api/sales is
    // absent from STAFF_ALLOWED_PATH_PREFIXES — and an allowlist says nothing
    // about a path that no longer exists, so renaming the route to match the
    // label would have removed the block without removing a line of code.
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

    const admin = ((await req('POST', '/login', { body: { password: 'admin-pw-bbbbbbbbbbb' } })).json || {}).sid;
    const staff = ((await req('POST', '/login', { body: { password: 'staff-pw-ccccccccccc' } })).json || {}).sid;

    const blocked = await req('GET', '/api/sales', { sid: staff });
    ck('staff still cannot reach the Edge Metals register',
       [401, 403].includes(blocked.status),
       `${blocked.status} — a renamed route would not be on the staff allowlist either, and "not listed" means ALLOWED`);

    ck('  and the route is still /api/sales', (await req('GET', '/api/sales', { sid: admin })).status === 200,
       'renaming the path to match the label is the change this file exists to stop');

    // ── AND THE STORED SHAPE ─────────────────────────────────────────────
    // Records already on file are keyed this way. Renaming them to match a
    // screen would mean rewriting her data to change a word.
    const src = fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8');
    const K = src.slice(src.indexOf('  sales: {'), src.indexOf('  sales: {') + 400);
    ck("the ledger key is still 'sales'", /path: '\/api\/sales'/.test(K), K.slice(0, 160));
    ck("  listKey still 'sales', itemKey still 'sale'",
       /listKey: 'sales'/.test(K) && /itemKey: 'sale'/.test(K), K.slice(0, 200));

    // The payment kinds the spend report splits on.
    const payments = require(path.join(ROOT, 'helpers/payments'));
    const spendSrc = fs.readFileSync(path.join(ROOT, 'helpers/spendReport.js'), 'utf8');
    ck("'sale_cost' is still the Edge Metals settlement kind", /load_kind === 'sale_cost'/.test(spendSrc));
    ck("  and 'sale' is still the yard's", /load_kind === 'sale'/.test(spendSrc));
    ck('  both still refused as unknown if removed',
       typeof payments.addPayment === 'function');

    server.close();
}

// ══════════════════════════════════════════════════════════════════════════
section('C — Edge Yard still says Sales');
// ══════════════════════════════════════════════════════════════════════════
{
    // She said Edge METALS. The yard sells too, and its sales are outbound
    // loads — a different company whose wording she did not ask to change.
    // Renaming both is the easy over-reach here, because the same word appears
    // in both halves of one file.
    ck('the Loads deck still offers a Sales filter',
       /\['sale', 'Sales'\]/.test(html), 'Edge Yard, not Edge Metals');
    ck("the app's yard report is still called Sales",
       /id: 'sales',\s*title: 'Sales'/.test(APP),
       'the app has no Edge Metals screens at all — nothing there should have moved');
    ck('  and the app was not touched by this rename',
       !/Invoice register/.test(APP));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }

})().catch((e) => { console.error(e); process.exit(1); });
