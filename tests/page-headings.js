// ── tests/page-headings.js ────────────────────────────────────────────────
// Apsara, 2026-09-15: "it looks too much headers", after two attempts of mine
// that missed, and then: "okay..not just expenses..Load,Invventory,petty
// cash,truckr bills,expenses,spend report,price list,outbound loans".
//
// THE COUNT WAS THE DIAGNOSIS. The Expenses page stacked SIX heading-ish
// things before one expense appeared:
//
//   YARD · // EXPENSES · EXPENSE TRACKER · the description line ·
//   TODAY / ALL-TIME / ENTRIES · 2026-09-12
//
// all in the same small uppercase mono, so none of them won and the eye had
// nowhere to rest. My first fix merged three of the six and kept the rest,
// which is exactly why it still read the same to her.
//
// THE RULE THIS FILE GUARDS: on these eight pages, exactly one thing looks
// like a heading. Everything else is data, or a quiet word beneath data.
//
// Rendered, not grepped. A page can mention pageHead and still throw on the
// way to using it — and five of these pages fetch different shapes, so the
// only honest check is to render each one and read what came out.
//
// ── REWRITTEN 2026-09-15, BECAUSE I TRUNCATED IT ─────────────────────────
// A python one-liner did `open(p,'w').write(...)` and then, on the next line,
// `open(p).read()` — 'w' truncates on open, so the read returned nothing and
// the file was written empty. It was untracked, so git had nothing to give
// back. Second time this project has lost uncommitted test work to a careless
// shell line (the first was `git checkout --`). The lesson is the same one
// both times: commit test files when they go green, not when the feature is
// finished.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8');

// NAV_ITEMS is a top-level `const`, so it is NOT a property of window and
// cannot be read off the rendered page — it has to come from the source.
// Bounded at the array's real closing bracket rather than a guessed character
// count: the entries carry long comments, and a fixed slice silently dropped
// everything past Suppliers, which is precisely the half this file now checks.
const NAV_START = HTML.indexOf('const NAV_ITEMS = [');
const NAV_SRC = HTML.slice(NAV_START, HTML.indexOf('\n];', NAV_START));
const NAV_DECL = [...NAV_SRC.matchAll(/\{ id: '([^']+)',\s*label: '([^']+)',\s*group: '([^']+)'(,\s*adminOnly: true)?/g)]
    .map((m) => ({ id: m[1], label: m[2], group: m[3], adminOnly: !!m[4] }));

const ROUTES = {
    '/api/me': { ok: true, role: 'admin' },
    '/api/loads': [{ id: 'EDGE_1', date: '2026-09-12', seller: 'Ramesh', net_weight: 15800, amount: 6478,
                     items: [{ description: 'Al combo', net_weight: 15800, amount: 6478 }] }],
    '/api/outbound-loads': [{ id: 'OUT_1', date: '2026-09-10', buyer: 'Daekwang', net_weight: 8000, amount: 6800, items: [] }],
    '/api/load-drafts': [],
    '/api/loads/inventory': { ok: true, unit: 'lb', byType: [{ description: 'Al combo', count: 1, net: 15800, amount: 6478 }], lots: [] },
    '/api/expenses': { ok: true, categories: ['Fuel', 'Labour', 'Other'], methods: ['Cash', 'Card'],
        default_method: 'Cash', retired_methods: [],
        expenses: [{ id: 'EXP_1', date: '2026-09-12', category: 'Labour', description: 'Salary',
                     vendor: null, payment_method: 'Cash', amount: 200 }],
        report: { total: 105375, count: 13, byCategory: [], byDay: [] } },
    '/api/petty-cash': { ok: true, balance: 1200, entries: [] },
    '/api/trucker-bills': { ok: true, bills: [], report: { billed: 900, paid: 400, outstanding: 500 } },
    '/api/reports/spend': { total: 1400, loadTotal: 0, expenseTotal: 1400, count: 3, months: [],
        byMethod: {}, byBank: {}, columns: [], bankColumns: [], rows: [], byCategory: [],
        cash: { opening: 0, in: 0, out: 0, closing: 0 },
        received: { total: 0, count: 0, byMethod: {} }, from: null, to: null, method: null, bank: null },
    '/api/contacts': { ok: true, contacts: [], groups: [] },
};
const route = (k) => {
    if (k in ROUTES) return ROUTES[k];
    for (const p of Object.keys(ROUTES)) if (k.startsWith(p)) return ROUTES[p];
    return { ok: true };
};

// The eight she named. 'contacts' is the Price Lists tab; Outbound Loads is
// its own page and is checked separately below.
const PAGES = [
    ['loads', 'Loads'], ['inventory', 'Inventory'], ['petty', 'Petty cash'],
    ['trucker-bills', 'Trucker bills'], ['expenses', 'Expenses'],
    ['spend', 'Spend report'], ['contacts', 'Price lists'],
];

(async () => {

const errors = [];
const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: 'http://localhost/',
    beforeParse(w) {
        w.fetch = (u) => Promise.resolve({ ok: true, status: 200,
            json: () => Promise.resolve(route(String(u).split('?')[0])) });
        w.alert = () => {}; w.confirm = () => true;
        w.addEventListener('error', (e) => errors.push(e.message));
    },
});
await new Promise((r) => setTimeout(r, 700));
const w = dom.window, d = w.document;

section('A — one heading per page, and it is the nav word');
for (const [tab, expect] of PAGES) {
    w.switchTab(tab);
    await new Promise((r) => setTimeout(r, 260));
    const root = d.getElementById('viewRoot');
    const h2s = [...root.querySelectorAll('h2')];

    ck(`${expect}: exactly one heading`, h2s.length === 1,
       `${h2s.length} found: ${h2s.map((h) => JSON.stringify(h.textContent.trim())).join(', ') || '(none)'}`);

    const head = h2s[0];
    ck(`  it is the word from the sidebar, in sentence case`,
       !!head && head.textContent.trim() === expect,
       head ? JSON.stringify(head.textContent.trim()) + ' ≠ ' + JSON.stringify(expect) : '(no heading rendered)');

    // The eyebrow was the "YARD ·" line above every title — one of the six.
    ck(`  and the eyebrow above it is gone`,
       root.querySelectorAll('.eyebrow').length === 0,
       root.querySelectorAll('.eyebrow').length + ' eyebrow(s) still on the page');

    // Not a style question. Small ALL-CAPS mono was what made six different
    // things look like the same rank, which is why none of them read as the
    // heading. A heading that shouts is a heading that competes.
    ck(`  and nothing SHOUTING in caps`,
       !!head && !/uppercase/.test(head.getAttribute('style') || ''),
       head ? (head.getAttribute('style') || '') : '(no heading rendered)');

    // ── THE SENTENCE UNDER THE TITLE STAYS ───────────────────────────────
    // Her correction, in as many words: "let the descripton of header be
    // there..i am just telling you to group the side bar headings". My first
    // pass deleted it along with the eyebrow, because I read "too much
    // headers" as "less text" when she meant "fewer things competing to be
    // THE heading". The description is not a heading — it is the one line
    // saying what the page is for, and on Petty Cash it is the line telling
    // staff they are read-only.
    //
    // A mutation blanking it survived this file until this assertion existed:
    // seven pages each passed a note and nothing checked that any of them
    // reached the screen.
    const desc = head && head.nextElementSibling;
    ck(`  and the description under it is still there`,
       !!desc && /font-size:12.5px/.test(desc.getAttribute('style') || '')
       && desc.textContent.trim().length > 10,
       desc ? JSON.stringify(desc.textContent.trim().slice(0, 60)) : '(nothing follows the title)');
}

section('B — the figures got BIGGER, not smaller');
{
    // The summary CARD was removed along with the heading it sat under, so
    // the three expense figures had to end up MORE prominent, not less —
    // otherwise this "revamp" quietly cost her the numbers she opens the tab
    // for. 20px vs the 11.5px label beneath it.
    w.switchTab('expenses');
    await new Promise((r) => setTimeout(r, 300));
    const root = d.getElementById('viewRoot');
    const figures = [...root.querySelectorAll('div')]
        .filter((e) => /font-size:20px/.test(e.getAttribute('style') || ''));
    ck('the expense totals are still 20px', figures.length >= 3,
       figures.length + ' figures at 20px, expected all-time / today / entries');
    ck('  and the all-time figure is one of them',
       figures.some((e) => /105,375|105375/.test(e.textContent)),
       figures.map((e) => e.textContent.trim()).join(' · '));
    ck('  with a quiet lower-case label beneath, not a caps one above',
       figures.every((e) => {
           const lbl = e.nextElementSibling;
           return lbl && !/uppercase/.test(lbl.getAttribute('style') || '')
               && lbl.textContent.trim() === lbl.textContent.trim().toLowerCase();
       }),
       'a caps label above the number is the pattern this replaced');
}

section('C — the sidebar stopped wrapping');
{
    // ~300px of brand block was why Board and Bookings sat below the fold.
    ck('the brand block no longer shouts EDGE METALS · OPS in caps',
       !/\/\/ Edge Metals · Ops/.test(HTML),
       'it wrapped onto two lines in a 252px column');
    ck('  the name and the line under it cannot wrap',
       /white-space:nowrap[^"]*">Edge Metals ops/.test(HTML));
    ck('  and the live state is a dot with the words on hover',
       /id="waStatusDot" title=/.test(HTML)
       && /d\.title = 'Live · synced from WhatsApp'/.test(HTML),
       'the sentence in caps was the second thing that wrapped');
    // The node that the status code writes to still has to exist, or setting
    // its textContent throws rather than quietly doing nothing.
    ck('  while the element the status code writes to still exists',
       /id="waStatusLine"[^>]*display:none[^>]*><span id="waStatusText">/.test(HTML));
}

section('E — the sidebar is grouped by company');
{
    // Apsara, 2026-09-15: "let the descripton of header be there..i am just
    // telling you to group the side bar headings", then the correction that
    // set the top-level split: "dont mix yard and edge metals".
    //
    // Walked in DOM order, because the heading a button sits under is a fact
    // about the rendered list, not about the array: renderNav emits a heading
    // only when the group CHANGES, so a group whose items are not contiguous
    // prints its heading twice and half its items land under the wrong one.
    // That is not hypothetical — Spend Report sits between Expenses and Price
    // Lists in NAV_ITEMS, so before the sort was added "Edge Yard" appeared
    // twice and Price Lists rendered under the second copy.
    const walk = (root) => {
        const out = []; let head = null;
        for (const el of root.children) {
            if (el.classList.contains('nav-section-label')) { head = el.textContent; continue; }
            if (el.tagName === 'BUTTON') out.push({ tab: el.dataset.tab, label: el.textContent, head });
        }
        return out;
    };
    const rows = walk(d.getElementById('sideNav'));
    const heads = rows.map((r) => r.head).filter((h, i, a) => h !== a[i - 1]);

    ck('every nav button sits under a heading', rows.length > 0 && rows.every((r) => r.head),
       'buttons before the first heading render as orphans');

    // COUNTED OFF THE DOM, not off `heads`. `heads` collapses CONSECUTIVE
    // repeats to build the group sequence — which means it cannot see the
    // failure where a heading is emitted before EVERY button and "Edge Yard"
    // is printed seven times down the sidebar. A mutation flipping
    // `n.group !== lastGroup` to `true` survived this file until the node
    // count was asserted directly. The collapsed list is the right tool for
    // order and the wrong one for counting.
    const labelNodes = [...d.querySelectorAll('#sideNav .nav-section-label')].map((e) => e.textContent);
    const groupCount = new Set(rows.map((r) => r.head)).size;
    ck('  one heading node per group, and no more',
       labelNodes.length === new Set(labelNodes).size && labelNodes.length === groupCount,
       `${labelNodes.length} heading nodes for ${groupCount} groups: ${labelNodes.join(' · ')}`);
    ck('  no heading is printed twice', heads.length === new Set(heads).size,
       'printed: ' + heads.join(' · '));
    ck('  and the heading each button sits under is the group it declares',
       rows.every((r) => {
           const x = NAV_DECL.find((n) => n.id === r.tab);
           return x && x.group === r.head;
       }),
       rows.filter((r) => { const x = NAV_DECL.find((n) => n.id === r.tab); return !x || x.group !== r.head; })
           .map((r) => `${r.tab} under "${r.head}"`).join(', '));

    // THE RULE SHE ASKED FOR, asserted as a rule. Not "Loads is 4th" — that
    // breaks the moment she adds a tab and tells me nothing. This says: these
    // pages read Edge Yard's books, those read Edge Metals', and a page may
    // never be filed under the other company's name.
    const YARD = ['loads', 'inventory', 'petty', 'trucker-bills', 'expenses', 'contacts', 'outbound-loads'];
    // 'truckers' and 'suppliers' merged into 'partners' on 2026-09-24 —
    // Apsara: "can we combine truckers and suppliers into single heading".
    // One nav entry, two sub-tabs; still Edge Metals, which is what this
    // check is about.
    const METALS = ['board', 'bookings', 'partners', 'documents', 'bills', 'sales', 'edge-inventory'];
    const groupOf = (id) => (NAV_DECL.find((x) => x.id === id) || {}).group;
    ck('  the yard pages are all under Edge Yard',
       YARD.every((id) => groupOf(id) === 'Edge Yard'),
       YARD.filter((id) => groupOf(id) !== 'Edge Yard').map((id) => `${id} → ${groupOf(id)}`).join(', '));
    ck('  the Edge Metals pages are all under Edge Metals',
       METALS.every((id) => groupOf(id) === 'Edge Metals'),
       METALS.filter((id) => groupOf(id) !== 'Edge Metals').map((id) => `${id} → ${groupOf(id)}`).join(', '));
    ck('  and neither company appears inside the other\'s block',
       heads.indexOf('Edge Yard') !== -1 && heads.indexOf('Edge Metals') !== -1
       && heads.indexOf('Edge Yard') < heads.indexOf('Edge Metals'),
       'printed: ' + heads.join(' · '));

    // Spend Report is the one page that is not either company's. It totals
    // loadTotal/expenseTotal/truckerTotal (yard) alongside supplierTotal/
    // saleCostTotal/metalsTruckingTotal (Edge Metals) — see helpers/spendReport.js.
    // Filing it under one company's heading would be a false claim about the
    // number on screen, so it gets its own heading between the two.
    ck('  Spend Report is filed under neither, because it totals both',
       groupOf('spend') === 'Both companies'
       && heads.indexOf('Both companies') > heads.indexOf('Edge Yard')
       && heads.indexOf('Both companies') < heads.indexOf('Edge Metals'),
       'helpers/spendReport.js sums yard AND Edge Metals into one total');

    // ── AND WHAT STAFF SEE ───────────────────────────────────────────────
    // The staff filter keeps three ids, all Edge Yard, so staff should get
    // ONE heading over three buttons — not a bare list, and not a leftover
    // "Edge Metals" with nothing beneath it. Nobody looks at the staff nav
    // until a yard hand asks where the rest of the menu went.
    //
    // Rendered in a SECOND DOM whose /api/me says staff, rather than poking
    // the role on the live one. ROLE is declared `let` at the top level of a
    // classic script, and top-level let/const are not properties of window —
    // `w.ROLE = 'staff'` creates a stray the page never reads, and the nav
    // re-renders with all 24 items while the assertion claims it tested
    // staff. That exact trap has now cost this project three debugging
    // sessions (window.NAV_ITEMS twice). Driving it through the fetch the app
    // actually calls tests the real path anyway: server says staff, nav obeys.
    const staffDom = new JSDOM(HTML, {
        runScripts: 'dangerously', url: 'http://localhost/',
        beforeParse(sw) {
            sw.fetch = (u) => {
                const k = String(u).split('?')[0];
                return Promise.resolve({ ok: true, status: 200,
                    json: () => Promise.resolve(k === '/api/me' ? { ok: true, role: 'staff' } : route(k)) });
            };
            sw.alert = () => {}; sw.confirm = () => true;
            sw.addEventListener('error', () => {});
        },
    });
    await new Promise((r) => setTimeout(r, 700));
    const staffRows = walk(staffDom.window.document.getElementById('sideNav'));
    const staffHeads = [...new Set(staffRows.map((r) => r.head))];
    const staffLabels = staffDom.window.document.querySelectorAll('#sideNav .nav-section-label').length;
    ck('  staff see only Edge Yard pages, under one Edge Yard heading',
       staffRows.length === 3 && staffHeads.length === 1 && staffHeads[0] === 'Edge Yard',
       staffRows.map((r) => `${r.label} under "${r.head}"`).join(', ') || '(nav rendered empty)');
    ck('  and no heading is left standing over nothing',
       staffHeads.every((h) => h && staffRows.some((r) => r.head === h)) && staffLabels === staffHeads.length,
       `${staffLabels} heading nodes for ${staffHeads.length} group(s)`);
    staffDom.window.close();
}

ck('no page threw while rendering', errors.length === 0, errors.join(' | '));
dom.window.close();

section('D — Outbound loads, on its own page');
{
    const OB = fs.readFileSync(path.join(ROOT, 'dashboard/outbound-loads.html'), 'utf8');
    ck('the eyebrow is gone', !/class="eyebrow">\/\/ Outbound/.test(OB));
    ck('  the heading is sentence case', /id="obHead"[^>]*text-transform:none[^>]*>Outbound loads</.test(OB));
    ck('  and the figures render above the list', /id="obStats"/.test(OB) && /\$\('obStats'\)\.innerHTML/.test(OB));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('\n  THREW:', e.stack || e.message); process.exit(1); });
