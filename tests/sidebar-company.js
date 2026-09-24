// ── tests/sidebar-company.js ──────────────────────────────────────────────
// Apsara, 2026-09-25, shown a mock of the rail: "Fix it".
//
// The sidebar was 25 items across seven groups — roughly 1,100px of rail in a
// ~700px viewport, so a third of it lived below the fold. Worse, the two
// companies were interleaved with "Both companies" wedged between them, which
// contradicts the rule she has repeated more than any other in this codebase:
// Edge Yard and Edge Metals are DIFFERENT COMPANIES.
//
// ── WHAT CHANGED, AND WHAT DID NOT ────────────────────────────────────────
// renderNav() emits EXACTLY the DOM it always emitted: the same buttons, the
// same headings, all direct children of #sideNav, one heading node per group.
// A class on the <nav> decides what is on screen.
//
// That is not a shortcut. Eight existing test files read that DOM —
// page-headings.js walks sideNav.children and resolves every <button> back to
// NAV_ITEMS, sidebar-collapse.js counts them, ledger-render.js reads their
// data-tab. Re-rendering a filtered list per company would have changed the
// shape all eight assert, and "the sidebar test broke" would have been the
// least of it: a nav that only contains one company's buttons is a nav where
// openTab('bills') has nothing to mark active.
//
// ── THE THREE THINGS THAT COULD GO WRONG ──────────────────────────────────
//
//   1. A SCREEN SHE CANNOT REACH. Hiding half the rail is only safe if the
//      switcher FOLLOWS the open tab. A deep link, a Jarvis "open the bills",
//      or a button on another page can all land on a Metals screen while the
//      rail is showing Yard — and a page that loads with its own nav row
//      hidden reads as a broken link, not as a filter. Section C.
//
//   2. A FOLDED GROUP HIDING THE ROW SHE IS ON. Same failure, one level down.
//      Section D.
//
//   3. STORAGE THROWING. The remembered company is a convenience; a rail that
//      fails to render because localStorage is unavailable is not. Section F.

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
const HTML = fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8');

// NAV_ITEMS is a top-level const, so it is not a window property — read the
// declaration out of the source, the way page-headings.js does.
const NAV_SRC = HTML.slice(HTML.indexOf('const NAV_ITEMS = ['), HTML.indexOf('\n];', HTML.indexOf('const NAV_ITEMS = [')));
const NAV_DECL = [...NAV_SRC.matchAll(/id:\s*'([^']+)'[\s\S]{0,400}?label:\s*'([^']+)'[\s\S]{0,400}?group:\s*'([^']+)'(\s*,\s*adminOnly:\s*true)?/g)]
    .map((m) => ({ id: m[1], label: m[2], group: m[3], adminOnly: !!m[4] }));

const ROUTES = {
    '/api/me': { ok: true, role: 'admin' },
    '/api/loads': [], '/api/outbound-loads': [], '/api/load-drafts': [],
    '/api/loads/inventory': { ok: true, unit: 'lb', byType: [], lots: [] },
    '/api/expenses': { ok: true, categories: [], methods: [], default_method: 'Cash', retired_methods: [],
                       expenses: [], report: { total: 0, count: 0, byCategory: [], byDay: [] } },
    '/api/petty-cash': { ok: true, balance: 0, entries: [] },
    '/api/trucker-bills': { ok: true, bills: [], report: { billed: 0, paid: 0, outstanding: 0 } },
    '/api/contacts': { ok: true, contacts: [], groups: [] },
};
const route = (k) => {
    if (k in ROUTES) return ROUTES[k];
    for (const p of Object.keys(ROUTES)) if (k.startsWith(p)) return ROUTES[p];
    return { ok: true };
};

const boot = async (role = 'admin', tweak) => {
    const dom = new JSDOM(HTML, {
        runScripts: 'dangerously', url: 'http://localhost/',
        beforeParse(w) {
            w.fetch = (u) => Promise.resolve({ ok: true, status: 200,
                json: () => Promise.resolve(String(u).split('?')[0] === '/api/me'
                    ? { ok: true, role } : route(String(u).split('?')[0])) });
            w.alert = () => {}; w.confirm = () => true;
            w.addEventListener('error', () => {});
            if (tweak) tweak(w);
        },
    });
    await new Promise((r) => setTimeout(r, 700));
    return dom;
};

// ── VISIBLE MEANS THE BROWSER WOULD NOT PAINT IT ─────────────────────────
// Read off getComputedStyle, which JSDOM resolves from the page's own
// <style> rules. The first version of this reimplemented those rules in JS —
// "if the nav has co-yard and the group is Edge Metals, return false" — and
// so it asserted my model of the CSS rather than the CSS. Breaking the real
// selector (#sideNav.co-yard [data-co-group="Edge Metals"]) left every check
// in this file green while the feature did nothing at all: the mutation that
// matters most was the one it could not see.
const shown = (w, tab) => {
    const b = w.document.querySelector(`#sideNav button[data-tab="${tab}"]`);
    if (!b) return null;
    return w.getComputedStyle(b).display !== 'none';
};

(async () => {

const dom = await boot('admin');
const w = dom.window, d = w.document;

// ══════════════════════════════════════════════════════════════════════════
section('A — the DOM every other nav test reads is unchanged');
// ══════════════════════════════════════════════════════════════════════════
{
    const nav = d.getElementById('sideNav');
    const kids = [...nav.children];
    ck('buttons and headings are still direct children of #sideNav',
       kids.length > 0 && kids.every((e) => e.tagName === 'BUTTON' || e.classList.contains('nav-section-label')),
       kids.map((e) => e.tagName).join(','));

    // Every declared, admin-visible item still has a button — hidden is not
    // absent, and this is what keeps openTab able to mark any tab active.
    const want = NAV_DECL.filter((n) => !n.adminOnly || true).map((n) => n.id);
    const got = [...nav.querySelectorAll('button[data-tab]')].map((b) => b.dataset.tab);
    ck('every nav item is still in the DOM, hidden or not',
       want.every((id) => got.includes(id)),
       'missing: ' + want.filter((id) => !got.includes(id)).join(', '));

    ck('  one heading node per group, still',
       (() => {
           const labels = [...nav.querySelectorAll('.nav-section-label')].map((e) => e.textContent);
           return labels.length === new Set(labels).size;
       })(), 'a duplicated heading is what the sort was added to prevent');

    // The switcher must NOT be inside the nav: page-headings.js pushes every
    // BUTTON it finds under sideNav and looks it up by data-tab.
    ck('the company switcher is OUTSIDE #sideNav',
       !!d.getElementById('navCompany') && !nav.contains(d.getElementById('navCompany')),
       'inside, it would be an orphan button page-headings.js cannot resolve');
    ck('  and none of its buttons carry a data-tab',
       [...d.querySelectorAll('.nav-co')].every((b) => !b.dataset.tab));
}

// ══════════════════════════════════════════════════════════════════════════
section('B — one company at a time');
// ══════════════════════════════════════════════════════════════════════════
{
    w.switchTab('loads');
    await new Promise((r) => setTimeout(r, 200));

    ck('on a yard screen the rail shows Edge Yard', shown(w, 'loads') === true);
    ck('  and Edge Metals is put away', shown(w, 'bookings') === false);

    // The shared and utility groups belong to NEITHER rule, so they are never
    // filtered out — that is the point of matching on the group name.
    ck('Spend Report stays visible on both sides', shown(w, 'spend') === true,
       'it is the one screen that is genuinely both companies');

    const yard = NAV_DECL.filter((n) => n.group === 'Edge Yard').map((n) => n.id);
    const metals = NAV_DECL.filter((n) => n.group === 'Edge Metals').map((n) => n.id);
    ck('  every yard screen is shown', yard.every((id) => shown(w, id) !== false), yard.join(','));
    ck('  and every metals screen is hidden', metals.every((id) => shown(w, id) === false), metals.join(','));

    // Clicking the switcher changes the LIST, not the open tab.
    const before = w.CURRENT_TAB;
    d.querySelector('.nav-co[data-co="Edge Metals"]').click();
    ck('switching company shows the metals list', shown(w, 'bookings') === true);
    ck('  and puts the yard list away', shown(w, 'loads') === false);
    ck('  without navigating anywhere', w.CURRENT_TAB === before, `${before} -> ${w.CURRENT_TAB}`);
    ck('  and the switcher marks which company is showing',
       d.querySelector('.nav-co[data-co="Edge Metals"]').classList.contains('active')
       && !d.querySelector('.nav-co[data-co="Edge Yard"]').classList.contains('active'));
}

// ══════════════════════════════════════════════════════════════════════════
section('C — THE SWITCHER FOLLOWS THE OPEN TAB');
// ══════════════════════════════════════════════════════════════════════════
// The one that makes hiding half the rail safe at all.
{
    d.querySelector('.nav-co[data-co="Edge Yard"]').click();
    ck('starting on the yard list', shown(w, 'bookings') === false);

    // Exactly what a deep link or a Jarvis "open the bookings" does.
    w.switchTab('bookings');
    await new Promise((r) => setTimeout(r, 200));
    ck('opening a metals screen switches the rail to metals', shown(w, 'bookings') === true,
       'the row she is standing on must never be the hidden one');
    ck('  and the switcher says Edge Metals',
       d.querySelector('.nav-co[data-co="Edge Metals"]').classList.contains('active'));
    ck('  and that screen is the active row',
       !!d.querySelector('#sideNav button[data-tab="bookings"].active'));

    w.switchTab('loads');
    await new Promise((r) => setTimeout(r, 200));
    ck('and back the other way', shown(w, 'loads') === true && shown(w, 'bookings') === false);
}

// ══════════════════════════════════════════════════════════════════════════
section('D — the utility groups fold, without hiding where she is');
// ══════════════════════════════════════════════════════════════════════════
{
    w.switchTab('loads');
    await new Promise((r) => setTimeout(r, 200));
    ck('Bot starts folded away', shown(w, 'bot') === false);
    ck('  Settings too', shown(w, 'settings') === false);
    ck('  and its heading is marked as a control',
       !!d.querySelector('#sideNav .nav-section-label.nav-fold.shut'));

    // The chevron must not leak into textContent — page-headings.js compares
    // the heading text to the group name exactly.
    const heads = [...d.querySelectorAll('#sideNav .nav-section-label')].map((e) => e.textContent.trim());
    ck('  the fold chevron is not part of the heading text',
       heads.every((h) => NAV_DECL.some((n) => n.group === h)),
       heads.join(' · '));

    const head = [...d.querySelectorAll('#sideNav .nav-fold')].find((h) => h.dataset.coGroup === 'Bot & Automation');
    head.click();
    ck('clicking the heading opens the group', shown(w, 'bot') === true);
    ck('  and every row in it, not just one', shown(w, 'tasks') === true);
    head.click();
    ck('  clicking again closes it', shown(w, 'bot') === false);

    // Landing INSIDE a folded group must open it.
    w.switchTab('settings');
    await new Promise((r) => setTimeout(r, 200));
    ck('opening Settings unfolds the group it lives in', shown(w, 'settings') === true,
       'a hidden active row reads as a broken link');
}

// ══════════════════════════════════════════════════════════════════════════
section('E — icons, and the shorter row');
// ══════════════════════════════════════════════════════════════════════════
{
    const btns = [...d.querySelectorAll('#sideNav button[data-tab]')];
    ck('every row has an icon', btns.every((b) => b.querySelector('svg.nav-ico')),
       btns.filter((b) => !b.querySelector('svg.nav-ico')).map((b) => b.dataset.tab).join(','));
    ck('  and its label is still there beside it',
       btns.every((b) => b.querySelector('.nav-label') && b.querySelector('.nav-label').textContent.trim()));
    // An id with no icon drawn must still render a shape rather than a gap.
    ck('  an unknown id falls back to a shape, not a hole',
       /NAV_ICONS\[id\] \|\| '/.test(HTML));
    ck('the row padding came down from 10px to 6px',
       /\.nav-btn \{[^}]*padding:6px 12px 6px 13px/.test(HTML),
       'this is the 275px that was below the fold');
}

// ══════════════════════════════════════════════════════════════════════════
section('F — storage, and staff');
// ══════════════════════════════════════════════════════════════════════════
{
    // ── STORAGE THAT THROWS ───────────────────────────────────────────
    // Scoped to the NAV's own reads and writes, called directly. Booting the
    // whole page with a throwing localStorage was the first attempt and it
    // failed in refreshAlertBell() — unrelated code with no guard of its own.
    // That is a real (pre-existing) fragility, but it is not this change's,
    // and a test that fails there would be asserting a fix nobody made.
    const realLS = w.localStorage;
    Object.defineProperty(w, 'localStorage', {
        configurable: true,
        get() { throw new Error('storage is disabled'); },
    });
    let threw = null;
    try {
        ck('navCompany() survives storage throwing', w.navCompany() === 'Edge Yard',
           'it must fall back, not propagate');
        w.syncNavCompany();
        ck('  and syncNavCompany() does too', true);
    } catch (e) { threw = e.message; ck('the nav survives storage throwing', false, threw); }
    Object.defineProperty(w, 'localStorage', { configurable: true, value: realLS });

    // And the rail is still whole afterwards.
    ck('  the rail is intact after the failure',
       d.querySelectorAll('#sideNav button[data-tab]').length === NAV_DECL.length,
       `${d.querySelectorAll('#sideNav button[data-tab]').length} of ${NAV_DECL.length} rows`);

    // Staff never see a Metals screen — the switcher would be two buttons,
    // one of which leads nowhere.
    const staff = await boot('staff');
    const sd = staff.window.document;
    ck('staff get no company switcher',
       sd.getElementById('navCompany').style.display === 'none',
       sd.getElementById('navCompany').style.display || '(shown)');
    ck('  and still see their three yard screens',
       sd.querySelectorAll('#sideNav button[data-tab]').length === 3,
       [...sd.querySelectorAll('#sideNav button[data-tab]')].map((b) => b.dataset.tab).join(','));
    staff.window.close();
}

dom.window.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }

})().catch((e) => { console.error(e); process.exit(1); });
