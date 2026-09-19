// ── tests/sidebar-collapse.js ─────────────────────────────────────────────
// Apsara, 2026-09-16: "make the side bar collapsible".
//
// ── COLLAPSED IS A RAIL, NOT NOTHING ────────────────────────────────────────
// Hiding it outright reclaims the most space and costs a click before every
// single navigation. A 54px rail gives back 200px and keeps every destination
// one click away. The nav items have no icons, so the rail shows short labels
// derived from the names.
//
// ── WHICH IS WHERE THE REAL BUG WAS ─────────────────────────────────────────
// The first version took a fixed two letters and gave Board and Bookings both
// "BO" — two destinations showing one label, which is exactly the confusion
// initials were meant to avoid. Section B is about uniqueness, and it checks
// it for EVERY role, because which items are visible depends on who is looking
// and a menu that is unambiguous for an admin can collide for staff.
//
// ── AND THE PHONE MUST NOT BE TOUCHED ───────────────────────────────────────
// At phone widths the sidebar is already off-canvas behind the burger. Two
// mechanisms fighting over the same element and the same pixels is the bug
// this kind of change always has, so section D holds them apart.

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
const SCRIPT = [...HTML.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');

// A store that can be made to throw, because localStorage does exactly that in
// some webviews and a saved preference must never cost her the whole page.
function makeStore(opts = {}) {
    const mem = new Map();
    return {
        getItem: (k) => { if (opts.throwOnGet) throw new Error('storage disabled'); return mem.has(k) ? mem.get(k) : null; },
        setItem: (k, v) => { if (opts.throwOnSet) throw new Error('storage disabled'); mem.set(k, String(v)); },
        removeItem: (k) => mem.delete(k),
        _mem: mem,
    };
}

function mount({ role = 'admin', store = makeStore() } = {}) {
    const dom = new JSDOM(HTML, { runScripts: 'outside-only', url: 'http://localhost/' });
    const w = dom.window;
    // ── boot() MUST NOT OUTLIVE THE WINDOW ───────────────────────────────
    // dashboard/index.html's boot() is async. It starts during eval, awaits a
    // fetch, and RESUMES as a microtask — by which time window.close() has
    // nulled the document, so its first $() throws. That printed "37 passed,
    // 0 failed" and then exited 1, and a green suite with a non-zero exit
    // reads as a failure to anything that only checks the code.
    //
    // Held at its first await rather than swallowed: a fetch that never
    // settles means boot never reaches the DOM, and it also guarantees this
    // suite touches no network. Stubbing setTimeout was my first attempt and
    // fixed nothing — the continuation is a microtask, not a timer.
    w.fetch = () => new Promise(() => {});
    w.setInterval = () => 0;
    Object.defineProperty(w, 'localStorage', { value: store, configurable: true });
    // The boot sequence needs a live session; the render functions are defined
    // by the time it throws and are all this file needs.
    try { w.eval(SCRIPT); } catch (e) { /* see above */ }
    try { w.eval(`ROLE = ${JSON.stringify(role)}; IS_SUPER = ${role === 'admin'};`); } catch (e) {}
    return { dom, w, d: w.document };
}

const navBtns = (d) => [...d.querySelectorAll('#sideNav button[data-tab]')];

// ══════════════════════════════════════════════════════════════════════════
section('A — it collapses, and comes back');
// ══════════════════════════════════════════════════════════════════════════
{
    const { dom, w, d } = mount();
    w.renderNav();

    const btn = d.getElementById('btnNavCollapse');
    ck('there is a toggle', !!btn);
    ck('  it starts expanded', btn.getAttribute('aria-expanded') === 'true', btn.getAttribute('aria-expanded'));
    ck('  and says what it will do', /collapse/i.test(btn.getAttribute('aria-label') || ''), btn.getAttribute('aria-label'));

    const before = navBtns(d).length;
    btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    ck('clicking it collapses', d.body.classList.contains('nav-collapsed'));
    ck('  the toggle now offers to expand', /expand/i.test(btn.getAttribute('aria-label') || ''), btn.getAttribute('aria-label'));
    ck('  and reports itself collapsed to a screen reader', btn.getAttribute('aria-expanded') === 'false');

    // ── NOTHING IS LOST ──────────────────────────────────────────────────
    // A rail with fewer destinations than the menu is a rail that hides some.
    ck('every destination is still in the menu', navBtns(d).length === before,
       `${navBtns(d).length} of ${before} — collapsed must narrow the menu, never shorten it`);

    btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    ck('clicking again expands', !d.body.classList.contains('nav-collapsed'));
    ck('  with every destination still there', navBtns(d).length === before);

    dom.window.close();
}

// ══════════════════════════════════════════════════════════════════════════
section('B — the rail labels are unique, for every role');
// ══════════════════════════════════════════════════════════════════════════
{
    // THE BUG THIS SECTION EXISTS FOR: a fixed two letters gave Board and
    // Bookings both "BO". Checked per ROLE because the visible list differs —
    // a rail that is unambiguous for an admin can collide for staff, and staff
    // are the ones least likely to say so.
    for (const role of ['admin', 'user', 'staff']) {
        const { dom, w, d } = mount({ role });
        w.renderNav();
        const btns = navBtns(d);
        if (!btns.length) { dom.window.close(); continue; }

        const keys = btns.map((b) => (b.querySelector('.nav-initials') || {}).textContent || '');
        ck(`${role}: every item has a rail label`, keys.every(Boolean), JSON.stringify(keys));
        ck(`  ${role}: and no two are the same`, new Set(keys).size === keys.length,
           keys.join(',') + ' — two destinations showing one label is worse than no label');

        // The full name is always reachable: shown expanded, and on hover
        // either way.
        ck(`  ${role}: the full name is always in the DOM`,
           btns.every((b) => (b.querySelector('.nav-label') || {}).textContent),
           'CSS shows one or the other; rebuilding the nav on collapse would be a second code path that could disagree');
        ck(`  ${role}: and on hover as a title`, btns.every((b) => b.getAttribute('title')),
           'two letters are a reminder, not a name');

        dom.window.close();
    }

    // The specific pair that broke.
    const { dom, w, d } = mount();
    w.renderNav();
    const find = (label) => navBtns(d).find((b) => (b.querySelector('.nav-label') || {}).textContent === label);
    const board = find('Board'), bookings = find('Bookings');
    if (board && bookings) {
        const a = board.querySelector('.nav-initials').textContent;
        const b = bookings.querySelector('.nav-initials').textContent;
        ck('Board and Bookings do not collide', a !== b, `${a} vs ${b}`);
        ck('  and the longer one is the one that grew', b.length > a.length, `${a} / ${b}`);
    }
    dom.window.close();
}

// ══════════════════════════════════════════════════════════════════════════
section('C — the choice is remembered');
// ══════════════════════════════════════════════════════════════════════════
{
    // A way of working, not a one-off: someone who wants the room back wants
    // it back tomorrow too.
    const store = makeStore();
    const first = mount({ store });
    first.w.renderNav();
    first.d.getElementById('btnNavCollapse').dispatchEvent(new first.w.MouseEvent('click', { bubbles: true }));
    ck('collapsing writes the preference', store._mem.get('navCollapsed') === '1',
       JSON.stringify([...store._mem.entries()]));
    first.dom.window.close();

    const second = mount({ store });
    ck('  and the next visit opens collapsed', second.d.body.classList.contains('nav-collapsed'));
    second.d.getElementById('btnNavCollapse').dispatchEvent(new second.w.MouseEvent('click', { bubbles: true }));
    ck('  expanding writes it back', store._mem.get('navCollapsed') === '0', store._mem.get('navCollapsed'));
    second.dom.window.close();

    // ── STORAGE THAT THROWS ──────────────────────────────────────────────
    // localStorage throws in some webviews. A saved preference must never
    // cost her the page — the same defensive read loadKindFilter uses.
    let boom = null;
    try {
        const t = mount({ store: makeStore({ throwOnGet: true }) });
        t.w.renderNav();
        ck('a reader that throws does not take the page down', navBtns(t.d).length > 0,
           'the preference is the least important thing on the screen');
        t.dom.window.close();
    } catch (e) { boom = e; }
    ck('  and nothing escapes to the caller', !boom, boom && boom.message);

    let boom2 = null;
    try {
        const t = mount({ store: makeStore({ throwOnSet: true }) });
        t.w.renderNav();
        t.d.getElementById('btnNavCollapse').dispatchEvent(new t.w.MouseEvent('click', { bubbles: true }));
        ck('a writer that throws still collapses the menu', t.d.body.classList.contains('nav-collapsed'),
           'the collapse is the feature; remembering it is the nicety');
        t.dom.window.close();
    } catch (e) { boom2 = e; }
    ck('  and nothing escapes there either', !boom2, boom2 && boom2.message);
}

// ══════════════════════════════════════════════════════════════════════════
section('D — the phone is untouched');
// ══════════════════════════════════════════════════════════════════════════
{
    // At phone widths the sidebar is ALREADY off-canvas behind the burger.
    // Two mechanisms over one element and one set of pixels is the bug this
    // kind of change always has.
    const { dom, w, d } = mount();
    ck('the burger still exists', !!d.getElementById('hamburgerBtn'));
    ck('  and its backdrop', !!d.getElementById('sidebarBackdrop'));

    w.renderNav();
    d.getElementById('hamburgerBtn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    ck('  and still opens the off-canvas panel',
       d.getElementById('sidebar').classList.contains('mobile-open'));
    ck('    without collapsing anything', !d.body.classList.contains('nav-collapsed'),
       'the two must not touch each other');

    d.getElementById('sidebarBackdrop').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    ck('    and the backdrop still closes it',
       !d.getElementById('sidebar').classList.contains('mobile-open'));

    // Only one control is live at a time, enforced in CSS under the same
    // breakpoint that reveals the burger.
    ck('the collapse toggle is hidden at phone widths',
       /@media[^{]*\{[\s\S]*?#btnNavCollapse\s*\{\s*display:\s*none/.test(HTML),
       'otherwise a phone gets a rail button and a burger arguing over the same panel');
    ck('  and a collapsed body does not shrink the off-canvas panel',
       /body\.nav-collapsed #sidebar \{ width:min\(82vw,300px\); \}/.test(HTML),
       'a 54px off-canvas drawer would be unusable and would look like a rendering fault');

    dom.window.close();
}

// ── N. THE COLLAPSED RAIL STOPS AT THE PHONE ────────────────────────────────
// Apsara, 2026-09-19, with a screenshot: "This is not hw i want collapsible to
// work" — a sidebar nearly as wide as the phone with OL, SR, BO, BOO, TR, SU,
// DO, BI, INV, EI, BOL, BOT listed down the middle of it.
//
// body.nav-collapsed is a DESKTOP idea — the stylesheet says so three lines
// above the rule that broke it: "One mechanism at a time: the burger owns the
// sidebar on a phone." But the class is set on the BODY and it persists, so a
// window narrowed after the rail was collapsed arrives at the phone layout
// still wearing it. Only the WIDTH was neutralised there; the rules hiding the
// labels and showing the initials were not, so both halves applied at once.
section('N. nav-collapsed does not leak into the phone layout');
{
    const css = HTML.slice(HTML.indexOf('@media (max-width: 860px)'),
                          HTML.indexOf('@media (max-width: 860px)') + 2600);
    ck('the phone layout restores the sidebar width',
       /body\.nav-collapsed #sidebar \{ width:min\(82vw,300px\); \}/.test(css));
    ck('  AND brings the labels back', /body\.nav-collapsed #sidebar \.nav-label/.test(css),
       'a 300px panel showing two-letter initials is both halves at once');
    ck('  hiding the initials instead',
       /body\.nav-collapsed #sidebar \.nav-initials \{ display:none; \}/.test(css),
       'OL, SR, BO, BOO down the middle of a phone screen');
    ck('  and restores the row padding, not just the width',
       /body\.nav-collapsed #sidebar \.nav-btn \{ justify-content:flex-start/.test(css),
       'centred rows in a full-width panel read as a mistake');
    ck('  and the sign-out label', /body\.nav-collapsed #sidebar #btnSignout \{ font-size:13px/.test(css)
       && /body\.nav-collapsed #sidebar #btnSignout::after \{ content:none; \}/.test(css),
       'it was font-size:0 with an arrow glued on by ::after');
    ck('  restored by revert rather than by guessing each base display',
       /display:revert/.test(css),
       '.nav-label is a bare span with no rule of its own — block would be a guess');

    // The desktop rail is UNTOUCHED. That is the behaviour she asked for on
    // 2026-09-12 and this fix must not quietly take it away.
    const desktop = HTML.slice(0, HTML.indexOf('@media (max-width: 860px)'));
    ck('the desktop rail still collapses to 54px',
       /body\.nav-collapsed #sidebar \{ width:54px; \}/.test(desktop));
    ck('  and still shows its initials there',
       /body\.nav-collapsed #sidebar \.nav-initials \{ display:block; \}/.test(desktop));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }
