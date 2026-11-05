// ── tests/accounting-portal.js ────────────────────────────────────────────
// Apsara, 2026-10-31: "keep bank,book,workspace,quickbook in one portal..",
// "It should mimic qb.all accounting under one wing", and on the four old
// rail rows: "Replace them immediately".
//
// ── THIS FILE RENDERS THE STRIP, IT DOES NOT GREP FOR IT ─────────────────
// dashboard/claims.html was DEAD FOR SIX DAYS behind 139 green checks,
// because every one of them read the page as source text and none of them
// ever executed it. accounting.js is the same shape of risk — one small
// script included by four pages — so every check below mounts it in JSDOM
// and asks the DOM what happened.
//
// It caught its own bug immediately: the first version keyed off
// document.readyState === 'loading' and waited for DOMContentLoaded, which
// in a settled document never fires. The stylesheet appeared and the strip
// did not, which in a browser would have looked like "the CSS didn't load".
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const DASH = path.join(ROOT, 'dashboard');
const SRC = fs.readFileSync(path.join(DASH, 'accounting.js'), 'utf8');

// Mount the real file over a minimal page, with /api/me answered however the
// caller wants. Returns the window once the role fetch has settled.
function mount({ role = 'admin', tab = '', body = '<h1>Page</h1>' } = {}) {
    const dom = new JSDOM(`<!doctype html><html><head></head><body>${body}</body></html>`,
        { runScripts: 'dangerously' });
    const w = dom.window;
    w.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ role }) });
    // data-tab normally arrives on the <script> tag; currentScript is null
    // under eval, so the file falls back to querySelector. Give it one.
    if (tab) {
        const s = w.document.createElement('script');
        s.setAttribute('src', '/accounting.js');
        s.dataset.tab = tab;
        w.document.head.appendChild(s);
    }
    w.eval(SRC);
    return new Promise((res) => setTimeout(() => res(w), 25));
}
const labels = (w) => [...w.document.querySelectorAll('#jvAcctTabs a')].map((a) => a.textContent);
const hrefs = (w) => [...w.document.querySelectorAll('#jvAcctTabs a')].map((a) => a.getAttribute('href'));

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — the strip actually renders');
// ══════════════════════════════════════════════════════════════════════════
{
    const w = await mount({ role: 'admin' });
    const bar = w.document.getElementById('jvAcctTabs');
    ck('the strip is in the DOM', !!bar, 'not a regex over the source — the real element');
    ck('  it is the FIRST thing in the body', w.document.body.firstChild === bar,
       'these pages end with their own scripts; appended, it lands under the footer');
    ck('  and its stylesheet went in too', !!w.document.getElementById('jvAcctCss'));
    // The bug this file was written to catch: CSS present, strip absent.
    ck('  CSS without a strip is the boot bug, and is not what happens',
       !!w.document.getElementById('jvAcctCss') && !!bar);
}

// ══════════════════════════════════════════════════════════════════════════
section('B — all four pages are reachable, under QuickBooks\' own order');
// ══════════════════════════════════════════════════════════════════════════
{
    const w = await mount({ role: 'admin' });
    ck('every one of the four pages has a tab',
       JSON.stringify(hrefs(w)) === JSON.stringify(['/workspace', '/bank-match', '/books', '/quickbooks']),
       JSON.stringify(hrefs(w)));
    ck('  Banking is first, as it is in QuickBooks', labels(w)[0] === 'Banking', labels(w).join(' '));
    ck('  Reports comes before the QuickBooks tab', labels(w).indexOf('Reports') < labels(w).indexOf('QuickBooks'),
       labels(w).join(' '));
    // Not "QuickBooks". It is the one tab with an end date (#176 is about
    // proving parity so QuickBooks can LEAVE), and naming it QuickBooks
    // would make it look permanent.
    // RENAMED 2026-11-05. 'Migration' named only the half with an end
    // date; the same page carries the Ask box and the nightly agent, which
    // is the half she wants kept. Apsara: "what happens to our assistant
    // which mimicked intuit intelligence".
    ck('  the tab is named QuickBooks, for everything on that page',
       labels(w).includes('QuickBooks') && !labels(w).includes('Migration'), labels(w).join(' '));
    ck('  and the hover says which half has an end date',
       /migration tools go when QuickBooks does, the assistant does not/.test(
           w.document.querySelector('#jvAcctTabs a[data-acct="migration"]').getAttribute('title')));
}

// ══════════════════════════════════════════════════════════════════════════
section('C — the tab you are on is marked');
// ══════════════════════════════════════════════════════════════════════════
for (const [tab, href] of [['banking', '/workspace'], ['reconcile', '/bank-match'],
                           ['reports', '/books'], ['migration', '/quickbooks']]) {
    const w = await mount({ role: 'admin', tab });
    const on = w.document.querySelector('#jvAcctTabs a.on');
    ck(`${tab}: exactly one tab is marked current`,
       w.document.querySelectorAll('#jvAcctTabs a.on').length === 1
       && on && on.getAttribute('href') === href
       && on.getAttribute('aria-current') === 'page',
       on ? on.getAttribute('href') : 'none marked');
}

// ══════════════════════════════════════════════════════════════════════════
section('D — the four rows disagreed about who could see them');
// ══════════════════════════════════════════════════════════════════════════
// QuickBooks and Books were open to everyone — 01-core.js says in so many
// words that she asked for everyone with a Jarvis login to see QuickBooks.
// Bank and Workspace were adminOnly because they list raw bank lines. One
// rail row cannot hold both answers, so the tabs hold it instead.
{
    const admin = await mount({ role: 'admin' });
    ck('an admin sees all four', labels(admin).length === 4, labels(admin).join(' '));

    const staff = await mount({ role: 'staff' });
    ck('a non-admin does NOT get the raw bank tabs',
       !labels(staff).includes('Banking') && !labels(staff).includes('Reconcile'),
       labels(staff).join(' '));
    ck('  but keeps Reports and QuickBooks, which were open to everyone',
       labels(staff).includes('Reports') && labels(staff).includes('QuickBooks'),
       labels(staff).join(' '));
    ck('  and still gets a usable strip, not an empty bar', labels(staff).length === 2,
       labels(staff).join(' '));
}

// ══════════════════════════════════════════════════════════════════════════
section('E — what it must NOT do');
// ══════════════════════════════════════════════════════════════════════════
{
    const w = await mount({ role: 'admin' });
    // books.html has a Print button and a CPA pack; bank-match and
    // quickbooks open modals. A frame would have broken printing, which is
    // the reason sidebar.js is a shared file and not a frame in the first
    // place.
    // Matched on the SOURCE first, which hit the comment block that explains
    // why there is no frame. A check that reads prose is not reading code.
    // The property is: nothing this file renders is a frame.
    const code = SRC.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    ck('it never puts a page in a frame',
       !/iframe/i.test(code) && w.document.querySelectorAll('#jvAcctTabs iframe').length === 0,
       'printing from a frame is why she rejected frames for the rail');
    ck('  and the strip is hidden when printing', /@media print/.test(SRC) && /jvAcctTabs/.test(SRC));

    // Included by four pages; twice on one page would stack two strips.
    w.eval(SRC);
    ck('loading it twice does not draw two strips',
       w.document.querySelectorAll('#jvAcctTabs').length === 1,
       String(w.document.querySelectorAll('#jvAcctTabs').length));

    // The server gates are the real boundary. If /api/me cannot be reached
    // the strip must still exist — degraded, not missing.
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'dangerously' });
    dom.window.fetch = () => Promise.reject(new Error('offline'));
    dom.window.eval(SRC);
    await new Promise((r) => setTimeout(r, 25));
    ck('a failed /api/me leaves the strip standing', !!dom.window.document.getElementById('jvAcctTabs'),
       'the server still refuses what a non-admin may not do');
}

// ══════════════════════════════════════════════════════════════════════════
section('F — the four pages include it, and claim the right tab');
// ══════════════════════════════════════════════════════════════════════════
{
    const WANT = { workspace: 'banking', 'bank-match': 'reconcile', books: 'reports', quickbooks: 'migration' };
    for (const [file, tab] of Object.entries(WANT)) {
        const src = fs.readFileSync(path.join(DASH, file + '.html'), 'utf8');
        const tags = src.match(/<script src="\/accounting\.js" data-tab="([a-z]+)" defer><\/script>/g) || [];
        ck(`${file}.html loads the strip once, as ${tab}`,
           tags.length === 1 && tags[0].includes(`data-tab="${tab}"`), tags.join(' '));
        // It must tell the RAIL it is the portal row, or the sidebar marks
        // nothing active — the four old rows no longer exist.
        ck(`  and tells the rail it is the accounting row`,
           /<script src="\/sidebar\.js" data-page="accounting" defer><\/script>/.test(src));
    }
}

// ══════════════════════════════════════════════════════════════════════════
section('G — the rail has one accounting row, not four');
// ══════════════════════════════════════════════════════════════════════════
{
    const sb = fs.readFileSync(path.join(DASH, 'sidebar.js'), 'utf8');
    const core = fs.readFileSync(path.join(DASH, 'app', '01-core.js'), 'utf8');
    for (const [name, src] of [['sidebar.js', sb], ['01-core.js', core]]) {
        ck(`${name}: the four old rows are gone`,
           !/\{ id: '(quickbooks|books|bank|workspace)', label:/.test(src),
           (src.match(/\{ id: '(quickbooks|books|bank|workspace)', label:[^\n]*/) || [''])[0]);
        ck(`  replaced by one 'accounting' row`, /\{ id: 'accounting', label: 'Accounting'/.test(src));
    }
    // The pages themselves must stay reachable — the strip links to them and
    // her bookmarks point at them. Retiring the rail rows must not retire
    // the routes.
    const pages = fs.readFileSync(path.join(ROOT, 'routes', 'pages.js'), 'utf8');
    ck('/books is still served', /app\.get\('\/books'/.test(pages));
    const api = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8') + pages;
    for (const url of ['/workspace', '/bank-match', '/quickbooks']) {
        ck(`${url} is still reachable somewhere`,
           api.includes(`'${url}'`) || api.includes(`"${url}"`)
           || fs.existsSync(path.join(DASH, url.slice(1) + '.html')),
           'the strip links straight to it');
    }
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.log('CRASHED: ' + (e && e.stack || e)); process.exit(1); });
