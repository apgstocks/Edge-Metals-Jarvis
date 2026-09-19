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
section('B — collapsed means GONE, not narrower');
// ══════════════════════════════════════════════════════════════════════════
// Apsara, 2026-09-19, twice, the second time with a screenshot of OL, SR, BO,
// BOO, TR, SU, DO, BI, INV, EI, BOL, BOT down the middle of a panel: "This is
// not hw i want collapsible to work." Asked what it should do instead: hide it
// completely, hamburger brings it back.
//
// This section used to test the two-letter rail — that every item had a label
// and no two collided, because a fixed two letters once gave Board and
// Bookings both "BO". Careful checks for a feature that should not have
// existed. They are replaced rather than deleted, because the property that
// actually mattered inside them survives: NOTHING MAY BE LOST when the menu
// collapses.
{
    for (const role of ['admin', 'user', 'staff']) {
        const { dom, w, d } = mount({ role });
        w.renderNav();
        const btns = navBtns(d);
        if (!btns.length) { dom.window.close(); continue; }

        // ── THE ONE THAT SURVIVED THE REDESIGN ──────────────────────────
        // A collapsed menu that quietly drops destinations is the failure
        // this checked for under the old design and still checks for now.
        ck(`${role}: every destination carries its full name`,
           btns.every((b) => ((b.querySelector('.nav-label') || {}).textContent || '').trim()),
           'the menu comes back in full, so the names must be in the DOM to come back to');
        ck(`  ${role}: and a title for hover`, btns.every((b) => b.getAttribute('title')));

        // And nothing abbreviates anything any more.
        ck(`  ${role}: no two-letter stubs anywhere`,
           !d.querySelector('.nav-initials'),
           'navInitialsFor is gone; a stub element left behind is one someone re-wires');

        dom.window.close();
    }

    // ── THE MECHANISM IS THE PHONE'S, NOT A THIRD STATE ─────────────────
    // Collapsing on a desktop and opening the drawer on a phone are the same
    // intent, so they are the same code. A separate desktop treatment is what
    // leaked into the phone layout and produced her screenshot.
    ck('collapsed puts the sidebar off-canvas',
       /body\.nav-collapsed #sidebar \{ position:fixed;[^}]*transform:translateX\(-100%\)/.test(HTML),
       'a 54px rail still eats width and still cannot be read');
    ck('  and shows the hamburger', /body\.nav-collapsed #hamburgerBtn \{ display:flex; \}/.test(HTML));
    ck('  which slides the FULL menu back over the page',
       /body\.nav-collapsed #sidebar\.mobile-open \{ transform:translateX\(0\); \}/.test(HTML));
    ck('  with a backdrop', /body\.nav-collapsed #sidebarBackdrop\.mobile-open \{ display:block; \}/.test(HTML));
    ck('  and room made for the button', /body\.nav-collapsed main \{ padding-top:58px; \}/.test(HTML));

    ck('no rail rules are left behind',
       !/body\.nav-collapsed #sidebar \{ width:54px/.test(HTML)
       && !/\.nav-initials/.test(HTML),
       'the old treatment half-removed is what produced a 300px panel of stubs');

    // ── AND THE HANDLERS ARE NO LONGER CALLED NO-OPS ────────────────────
    // Their comment said "phone widths only ... harmless no-ops on desktop".
    // They now open and close the menu at every width, and a comment calling
    // load-bearing code a no-op is how it gets deleted by someone tidying.
    // Matched on the HEADING, not on the words "phone widths only" — the
    // replacement comment QUOTES the old claim while correcting it, so a
    // negative match on the phrase fails against the very fix it is checking.
    ck('the off-canvas handlers no longer claim to be phone-only',
       /NOT phone-only any more/.test(HTML)
       && !/^\/\/ ── Mobile off-canvas sidebar \(phone widths only/m.test(HTML));

    // Expanding from inside the open drawer must not leave the backdrop up.
    ck('expanding closes the drawer behind it',
       /if \(!on && typeof closeMobileSidebar === 'function'\) closeMobileSidebar\(\);/.test(HTML),
       'the sidebar returns to the flow and the backdrop is left covering the page');
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
    ck('  and a collapsed body no longer shrinks anything',
       !/body\.nav-collapsed #sidebar \{ width:54px/.test(HTML),
       'this used to check the phone undid a 54px rail; there is no rail to undo');
}

// ── N. THERE IS NOTHING LEFT TO LEAK ────────────────────────────────────────
// This section tested a fix made hours earlier the same day: body.nav-collapsed
// is set on the BODY and persists, so a window narrowed after collapsing on a
// desktop arrived at the phone layout still wearing it — and only the WIDTH was
// being undone there, giving a 300px panel of two-letter stubs.
//
// That fix is gone because the thing it fixed is gone. Collapsing IS the
// off-canvas panel now, at every width, so there is no desktop-only treatment
// left to leak. The checks are replaced by the one that makes the whole class
// of bug impossible rather than caught.
section('N. one mechanism, so nothing can leak between them');
{
    ck('there is no desktop-only collapsed treatment',
       !/body\.nav-collapsed #sidebar \{ width:54px/.test(HTML)
       && !/body\.nav-collapsed #sidebar \.nav-initials/.test(HTML),
       'two treatments for one intent is what produced her screenshot');

    // The phone block should no longer need to undo anything.
    const phone = HTML.slice(HTML.indexOf('@media (max-width: 860px)'),
                             HTML.indexOf('@media (max-width: 860px)') + 1600);
    ck('  and the phone block has nothing to undo',
       !/display:revert/.test(phone) && !/nav-initials/.test(phone),
       phone.slice(0, 200));
    ck('  which is said out loud, not left as an absence',
       /AND NOTHING TO UNDO HERE ANY MORE/.test(HTML),
       'a block that silently stopped doing something reads as an accident');

    // The burger still owns the phone: one control at a time.
    ck('the collapse toggle is still hidden at phone widths',
       /@media[^{]*\{[\s\S]*?#btnNavCollapse\s*\{\s*display:\s*none/.test(HTML));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }
