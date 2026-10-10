// ── tests/sidebar-pages.js ────────────────────────────────────────────────
// Apsara, 2026-10-08: "also i want the sidebar to appear in all pages".
//
// Ten sidebar rows are separate pages, and leaving the app for one of them
// took the menu away. She chose a shared file (dashboard/sidebar.js) over
// loading the pages in a frame, and chose to leave the Bank page for later
// because bank-match.html had uncommitted work on it at the time.
//
// ── WHAT THIS FILE GUARDS ─────────────────────────────────────────────────
//   A. sidebar.js carries a COPY of index.html's nav lists (moving them would
//      have broken nine test files that cut NAV_ITEMS out of index.html's
//      source). The copy is only safe while this section fails on any drift.
//   B. Every page that should have the rail loads it, once, before its OWN
//      </body> — documents.html also has a "</body>" inside the script that
//      builds the printed wire instructions, and the rail must never land in
//      a printout a customer receives.
//   C. The rail draws the same rows with the same role rules as the app:
//      admin sees everything, staff three rows, a standard login no admin
//      rows; the current page is marked; tab rows link to /#tab=<id>.
//   D. index.html opens /#tab=<id> — but only a tab that role may see.
//   E. END TO END: a real server, a real login, every page route served with
//      the rail, /sidebar.js served, /api/me answering what the rail reads.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const DASH = path.join(ROOT, 'dashboard');
const INDEX = fs.readFileSync(path.join(DASH, 'index.html'), 'utf8');
const SIDEBAR = fs.readFileSync(path.join(DASH, 'sidebar.js'), 'utf8');

const evalLit = (txt) => { try { return eval('(' + txt + ')'); } catch (e) { return undefined; } };

// The lists sidebar.js exposes for tests, by running it in a bare window.
function sidebarLists() {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only', url: 'http://localhost/x' });
    dom.window.fetch = () => new Promise(() => {});
    dom.window.eval(SIDEBAR);
    return dom.window.__jvSidebar;
}

// Mount sidebar.js on a page the way a browser would: a real <script> element
// carrying data-page, so document.currentScript works.
async function mountRail({ role = 'admin', superUser = false, page = 'documents', withAppRail = false, storage } = {}) {
    const dom = new JSDOM(`<!doctype html><html><head></head><body>${withAppRail ? '<aside id="sidebar"></aside>' : ''}<main><a href="/">&larr; Back to dashboard</a><h1>Page</h1></main></body></html>`,
        { runScripts: 'dangerously', url: 'http://localhost/' + page });
    const w = dom.window;
    if (storage) for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);
    w.fetch = (url) => String(url).includes('/api/me')
        ? Promise.resolve({ ok: true, json: () => Promise.resolve({ role, super: superUser }) })
        : new Promise(() => {});
    const sc = w.document.createElement('script');
    sc.setAttribute('data-page', page);
    sc.textContent = SIDEBAR;
    w.document.body.appendChild(sc);
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    return w;
}

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — sidebar.js agrees with index.html, row for row');
// ══════════════════════════════════════════════════════════════════════════
const L = sidebarLists();
ck('sidebar.js exposes its lists', !!L && Array.isArray(L.NAV_ITEMS));

const navSrc = INDEX.slice(INDEX.indexOf('const NAV_ITEMS = [') + 'const NAV_ITEMS = '.length,
    INDEX.indexOf('\n];', INDEX.indexOf('const NAV_ITEMS = [')) + 2);
const APP_NAV = evalLit(navSrc);
ck('index.html NAV_ITEMS readable', Array.isArray(APP_NAV) && APP_NAV.length > 20, String(APP_NAV && APP_NAV.length));
const strip = (list) => JSON.stringify((list || []).map((n) => ({ id: n.id, label: n.label, group: n.group, adminOnly: !!n.adminOnly })));
ck('the same rows, labels, groups and admin flags, in the same order', strip(APP_NAV) === strip(L.NAV_ITEMS),
   'index.html and dashboard/sidebar.js disagree — change both');

const iconsSrc = INDEX.slice(INDEX.indexOf('const NAV_ICONS = {') + 'const NAV_ICONS = '.length, INDEX.indexOf('\n};', INDEX.indexOf('const NAV_ICONS = {')) + 2);
ck('the same icons', JSON.stringify(evalLit(iconsSrc)) === JSON.stringify(L.NAV_ICONS));
const foldSrc = (INDEX.match(/const FOLD_GROUPS = (\[[^\]]*\]);/) || [])[1];
ck('the same groups start folded', JSON.stringify(evalLit(foldSrc)) === JSON.stringify(L.FOLD_GROUPS), foldSrc);
const orderSrc = (INDEX.match(/const GROUP_ORDER = (\[[\s\S]*?\]);/) || [])[1];
ck('the same group order', JSON.stringify(evalLit(orderSrc)) === JSON.stringify(L.GROUP_ORDER), orderSrc);

// Which rows are pages, and where they go — read from renderNav's handler.
const APP_HREF = {};
for (const m of INDEX.matchAll(/if \(b\.dataset\.tab === '([a-z-]+)'\) \{ window\.location\.href = '([^']+)'; return; \}/g)) APP_HREF[m[1]] = m[2];
ck('index.html has its ten standalone pages', Object.keys(APP_HREF).length === 10, JSON.stringify(APP_HREF));
ck('the same pages, to the same addresses', JSON.stringify(Object.entries(APP_HREF).sort()) === JSON.stringify(Object.entries(L.PAGE_HREF).sort()),
   JSON.stringify(L.PAGE_HREF));
const staffSrc = (INDEX.match(/ROLE !== 'staff' \|\| n\.id === 'loads' \|\| n\.id === 'petty' \|\| n\.id === 'trucker-bills'/) || [])[0];
ck('the same staff rows (loads, petty, trucker-bills)', !!staffSrc && JSON.stringify(L.STAFF_TABS) === JSON.stringify(['loads', 'petty', 'trucker-bills']));

// ══════════════════════════════════════════════════════════════════════════
section('B — every page loads the rail, once, in the right place');
// ══════════════════════════════════════════════════════════════════════════
// Bank joined on 2026-10-10 — held back on 10-08 only while it had unsaved work.
const WITH_RAIL = { 'bank-match': 'bank', documents: 'documents', quickbooks: 'quickbooks', books: 'books', claims: 'claims',
    'edge-inventory': 'edge-inventory', 'outbound-loads': 'outbound-loads', 'address-book': 'address-book',
    'quote-requests': 'quote-requests', 'design-bol': 'design-bol' };
for (const [file, id] of Object.entries(WITH_RAIL)) {
    const src = fs.readFileSync(path.join(DASH, file + '.html'), 'utf8');
    const tags = src.match(/<script src="\/sidebar\.js" data-page="([a-z-]+)" defer><\/script>/g) || [];
    ck(`${file}.html loads it once`, tags.length === 1, String(tags.length));
    ck(`  as data-page="${id}"`, tags[0] === `<script src="/sidebar.js" data-page="${id}" defer></script>`, tags[0]);
    ck(`  and ${id} is a real nav row`, L.NAV_ITEMS.some((n) => n.id === id));
    const at = src.indexOf('/sidebar.js'), close = src.search(/^<\/body>/m);
    ck(`  just before the page's own </body>`, at > -1 && close > at && src.slice(at, close).split('\n').length <= 3);
}
const docs = fs.readFileSync(path.join(DASH, 'documents.html'), 'utf8');
const printWin = docs.slice(docs.lastIndexOf("+ '</body></html>')") - 4000, docs.lastIndexOf("+ '</body></html>')"));
ck('the printed wire instructions do not load the rail', !/sidebar\.js/.test(printWin));
ck('index.html does not load sidebar.js (it has its own rail)', !/<script[^>]*src="[^"]*sidebar\.js/.test(INDEX));

// ══════════════════════════════════════════════════════════════════════════
section('C — the rail on a page: rows, roles, links, behaviour');
// ══════════════════════════════════════════════════════════════════════════
{
    const w = await mountRail({ role: 'admin', page: 'documents' });
    const d = w.document;
    const rows = [...d.querySelectorAll('#jvNav a.jv-row')];
    ck('admin: every row', rows.length === APP_NAV.length, `${rows.length}`);
    const active = d.querySelector('#jvNav a.jv-row.active');
    ck('the page she is on is marked', active && active.dataset.tab === 'documents' && active.getAttribute('aria-current') === 'page');
    const href = (id) => (d.querySelector(`#jvNav a.jv-row[data-tab="${id}"]`) || {}).getAttribute && d.querySelector(`#jvNav a.jv-row[data-tab="${id}"]`).getAttribute('href');
    ck('a page row goes to that page', href('quickbooks') === '/quickbooks' && href('bank') === '/bank-match' && href('design-bol') === '/design/bol');
    ck('a tab row goes back into the app on that tab', href('bookings') === '/#tab=bookings' && href('loads') === '/#tab=loads');
    ck('Documents is a Metals screen, so the rail shows Metals', d.getElementById('jvNav').classList.contains('co-metals'));
    ck('  and remembers it like the app does', w.localStorage.getItem('jarvisNavCompany') === 'Edge Metals');
    ck('body makes room for it', d.documentElement.classList.contains('jv-has-nav'));
    ck('it is not an <aside> (claims/quickbooks style every aside)', d.getElementById('jvSidebar').tagName === 'DIV');
    ck('the page itself is untouched', !!d.querySelector('main h1') && /Back to dashboard/.test(d.querySelector('main').textContent));
    ck('it says Admin access', /Admin access/.test(d.querySelector('#jvSidebar .jv-role').textContent));

    // Company switcher
    d.querySelector('#jvCompany button[data-co="Edge Yard"]').click();
    ck('switching company changes the list, not the page', d.getElementById('jvNav').classList.contains('co-yard') && w.location.pathname === '/documents');
    // Folding
    const head = d.querySelector('#jvNav .jv-head.jv-fold');
    ck('utility groups start folded', head && head.classList.contains('shut'));
    const grp = head.dataset.coGroup;
    head.click();
    ck('tapping the heading opens that group', [...d.querySelectorAll(`#jvNav a.jv-row[data-co-group="${grp}"]`)].every((a) => !a.classList.contains('jv-folded')));
    // Collapsing works on the page, but is NOT written to the app's setting
    // (Apsara 2026-10-10: "Why sidebar coming on top").
    d.getElementById('jvCollapse').click();
    ck('collapsing works on the page', d.documentElement.classList.contains('jv-collapsed'));
    ck('  and does not touch the app\'s own collapsed setting', w.localStorage.getItem('navCollapsed') === null);
    // Burger
    d.getElementById('jvBurger').click();
    ck('the burger opens it', d.getElementById('jvSidebar').classList.contains('open') && d.getElementById('jvBurger').getAttribute('aria-expanded') === 'true');
    d.getElementById('jvBackdrop').click();
    ck('tapping outside closes it', !d.getElementById('jvSidebar').classList.contains('open'));
}
{
    const w = await mountRail({ role: 'admin', page: 'books', storage: { navCollapsed: '1' } });
    ck('a page opens with the menu OPEN even if the app\'s menu is collapsed', !w.document.documentElement.classList.contains('jv-collapsed'));
}
{
    const w = await mountRail({ role: 'staff', page: 'documents' });
    const ids = [...w.document.querySelectorAll('#jvNav a.jv-row')].map((a) => a.dataset.tab).sort();
    ck('staff: Loads, Petty Cash and Trucker Bills only', JSON.stringify(ids) === JSON.stringify(['loads', 'petty', 'trucker-bills']), JSON.stringify(ids));
    ck('  and no company switcher', w.document.getElementById('jvCompany').style.display === 'none');
}
{
    const w = await mountRail({ role: 'user', page: 'books' });
    const ids = [...w.document.querySelectorAll('#jvNav a.jv-row')].map((a) => a.dataset.tab);
    ck('standard login: no admin-only rows', ids.length && ids.every((id) => !APP_NAV.find((n) => n.id === id).adminOnly));
    ck('  and says Standard access', /Standard access/.test(w.document.querySelector('#jvSidebar .jv-role').textContent));
}
{
    const w = await mountRail({ role: 'admin', superUser: true, page: 'claims' });
    ck('the Jarvis profile says Jarvis access', /Jarvis access/.test(w.document.querySelector('#jvSidebar .jv-role').textContent));
}
{
    const w = await mountRail({ role: 'admin', page: 'books', withAppRail: true });
    ck('on a page that already has the app rail, it draws nothing', !w.document.getElementById('jvSidebar'));
}
{
    const css = (SIDEBAR.match(/@media print \{([\s\S]*?)\n\}/) || [])[1] || '';
    ck('printing hides the rail and gives the width back', /#jvSidebar[^{]*\{\s*display:none !important/.test(css) && /padding-left:0 !important/.test(css));
}

// ══════════════════════════════════════════════════════════════════════════
section('D — index.html opens /#tab=<id>, only for a tab that role may see');
// ══════════════════════════════════════════════════════════════════════════
async function bootApp(hash, role) {
    const SCRIPT = [...INDEX.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    const dom = new JSDOM(INDEX, { runScripts: 'outside-only', url: 'http://localhost/' + hash });
    const w = dom.window;
    w.fetch = (url) => String(url).includes('/api/me')
        ? Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({ role }) })
        : new Promise(() => {});
    w.setInterval = () => 0;
    // CURRENT_TAB is a top-level `let`: scoped to the eval, not the window.
    // A probe appended to the same eval reads it from inside.
    try { w.eval(SCRIPT + '\n;window.__tab = () => CURRENT_TAB;'); } catch (e) { /* later wiring may need markup; boot has run */ }
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    const active = w.document.querySelector('#sideNav .nav-btn.active');
    return { tab: w.__tab ? w.__tab() : null, active: active && active.dataset.tab, hash: w.location.hash };
}
{
    const r = await bootApp('#tab=bookings', 'admin');
    ck('admin, #tab=bookings → Bookings', r.tab === 'bookings' && r.active === 'bookings', JSON.stringify(r));
    ck('  and the hash is cleared, so a reload behaves as before', r.hash === '', r.hash);
    const r2 = await bootApp('', 'admin');
    ck('no hash → Board, as always', r2.tab === 'board', JSON.stringify(r2));
    const r3 = await bootApp('#tab=bookings', 'staff');
    ck('staff, #tab=bookings → still Loads', r3.tab === 'loads', JSON.stringify(r3));
    const r4 = await bootApp('#tab=petty', 'staff');
    ck('staff, #tab=petty → Petty Cash', r4.tab === 'petty', JSON.stringify(r4));
    const r5 = await bootApp('#tab=settings', 'user');
    ck('standard login, #tab=settings (admin only) → Board', r5.tab === 'board', JSON.stringify(r5));
    const r6 = await bootApp('#tab=nonsense', 'admin');
    ck('an unknown tab → Board', r6.tab === 'board', JSON.stringify(r6));
}

// ══════════════════════════════════════════════════════════════════════════
section('E — end to end: real server, real login, every page served with it');
// ══════════════════════════════════════════════════════════════════════════
{
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-sidebar-'));
    process.env.DATA_DIR = TMP;
    process.env.JARVIS_TEST = '1';
    process.env.APP_PASSWORD   = process.env.APP_PASSWORD   || 'user-pw-aaaaaaaaaaaa';
    process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pw-bbbbbbbbbbb';
    process.env.STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'staff-pw-ccccccccccc';
    const cfg = require(path.join(ROOT, 'config'));
    if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('  ABORT  config not isolated'); process.exit(1); }
    const { createApi } = require(path.join(ROOT, 'api'));
    const server = await new Promise((r) => { const s = createApi().listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = (method, p, { body, sid } = {}) => new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r2 = http.request(base + p, { method, headers }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, raw, json: j, type: res.headers['content-type'] || '' }); });
        });
        r2.on('error', reject); if (data) r2.write(data); r2.end();
    });
    try {
        const sid = ((await req('POST', '/login', { body: { password: process.env.ADMIN_PASSWORD } })).json || {}).sid;
        ck('signed in', !!sid);
        const me = await req('GET', '/api/me', { sid });
        ck('/api/me answers the role the rail reads', me.status === 200 && me.json && me.json.role === 'admin', me.raw.slice(0, 120));
        const js = await req('GET', '/sidebar.js', { sid });
        ck('/sidebar.js is served as JavaScript', js.status === 200 && /javascript/.test(js.type) && js.raw.includes('jvSidebar'), `${js.status} ${js.type}`);
        for (const [id, href] of Object.entries(L.PAGE_HREF)) {
            const pg = await req('GET', href, { sid });
            ck(`${href} is served with the rail`, pg.status === 200 && pg.raw.includes(`<script src="/sidebar.js" data-page="${id}" defer></script>`), `${pg.status}`);
        }
    } finally { server.close(); }
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }
process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
