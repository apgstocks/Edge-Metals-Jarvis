// ── tests/claims-lenses.js ────────────────────────────────────────────────
// Apsara, 2026-11-05: "rebuild the claim tab to have provision o see open
// claims,settled,supplier wise claim,datewise etc.."
//
// Her 2026-09-26 decision — claims grouped per CONTAINER — is not undone by
// this and stays the default. Supplier and month are additional LENSES, and
// Open/Settled are tabs beside the ones that were already there.
//
// ── EVERY CHECK BELOW RENDERS THE REAL PAGE ──────────────────────────────
// claims.html was DEAD FOR SIX DAYS behind 139 green checks because all of
// them read it as source text. These load it in JSDOM, click the real
// controls, and read the real DOM back. A regex over this file would prove
// the words exist, which is exactly what did not help last time.
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
const HTML = fs.readFileSync(path.join(ROOT, 'dashboard/claims.html'), 'utf8');

// Four claims chosen to separate every lens: two suppliers, two months, two
// containers, one settled and one still open.
const CLAIMS = [
    { id: 'c1', container_no: 'AAAA1111111', supplier: 'Inesh', customer: 'Cust A',
      claim_date: '2026-09-10', status: 'recovery_raised', claim_type: 'quality',
      claim_amount: 100, our_claim: 100 },
    { id: 'c2', container_no: 'AAAA1111111', supplier: 'Inesh', customer: 'Cust A',
      claim_date: '2026-09-11', status: 'settled', claim_type: 'weight_shortage',
      claim_amount: 50, our_claim: 50 },
    { id: 'c3', container_no: 'BBBB2222222', supplier: 'Taewon', customer: 'Cust B',
      claim_date: '2026-10-05', status: 'settled', claim_type: 'quality',
      claim_amount: 70, our_claim: 70 },
    { id: 'c4', container_no: 'CCCC3333333', supplier: 'Taewon', customer: 'Cust C',
      claim_date: '2026-11-02', status: 'unverified', claim_type: '', claim_amount: null },
];

// The page declares `const STATE` and its render functions at the top level
// of a classic <script>. Evaluated this way they are GLOBAL LEXICAL bindings
// — reachable by name from w.eval(), and NOT properties of window. My first
// version read w.STATE, got undefined, and crashed before the first check:
// the harness has to speak the page's own scope, not a convenient one.
function boot() {
    const SCRIPT = [...HTML.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)]
        .map((m) => m[1]).join('\n');
    const dom = new JSDOM(HTML, { runScripts: 'outside-only', url: 'http://localhost/claims' });
    const w = dom.window;
    // Held at its first await, and no network: load() is async and resumes
    // as a microtask after the window is gone, and its first $() throws.
    w.fetch = () => new Promise(() => {});
    w.setInterval = () => 0;
    w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
    // A second w.eval('STATE') cannot see it either: `const` in eval code
    // lives in that eval's own declarative scope and is gone when it
    // returns — only function declarations reach global. So the handle is
    // taken from INSIDE the same evaluation, which is the only place the
    // binding exists. Nothing is added to the page itself.
    w.eval(SCRIPT + '\n;window.__probe = { STATE, containers, reportMenu };');
    return w;
}
const S = (w) => w.__probe.STATE;
function paint(w, patch) {
    Object.assign(S(w), { claims: CLAIMS, kinds: [], stats: {}, landing: false }, patch || {});
    w.renderGroupBy(); w.renderTabs(); w.renderRows();
    return w;
}
const groupsOf = (w) => w.__probe.containers();
const rowKeys = (w) => [...w.document.querySelectorAll('#rows .prow')].map((b) => b.dataset.k);
const rowText = (w) => [...w.document.querySelectorAll('#rows .prow')].map((b) => b.textContent);
const tabIds = (w) => [...w.document.querySelectorAll('#tabs button')].map((b) => b.dataset.t);

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — the screen she knows still opens first');
// ══════════════════════════════════════════════════════════════════════════
{
    const w = boot();
    ck('container is the default lens', S(w).group === 'container', S(w).group);
    ck('  and no date range is set', !S(w).from && !S(w).to);
    paint(w, { tab: 'all' });
    ck('rows are CONTAINERS, one per container',
       JSON.stringify(rowKeys(w).sort()) === JSON.stringify(['AAAA1111111', 'BBBB2222222', 'CCCC3333333']),
       JSON.stringify(rowKeys(w)));
    ck('  and a container row still leads with the customer',
       rowText(w).some((t) => t.includes('Cust A')), rowText(w).join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
section('B — supplier wise');
// ══════════════════════════════════════════════════════════════════════════
{
    const w = boot();
    paint(w, { group: 'supplier', tab: 'all' });
    ck('rows are SUPPLIERS',
       JSON.stringify(rowKeys(w).sort()) === JSON.stringify(['Inesh', 'Taewon']), JSON.stringify(rowKeys(w)));
    ck('  Inesh carries both of his claims',
       groupsOf(w).find((g) => g.key === 'Inesh').claims.length === 2);
    ck('  and the row leads with the supplier, not the customer',
       rowText(w).some((t) => t.includes('Inesh')) && !rowText(w).some((t) => t.includes('Cust A')),
       rowText(w).join(' | '));
    // A supplier demand built with container=<supplier name> comes back
    // empty with nothing on screen saying why.
    const g = groupsOf(w).find((x) => x.key === 'Taewon');
    const menu = w.__probe.reportMenu(g);
    ck('  the claim report asks by SUPPLIER, never by container',
       menu.includes('supplier=Taewon') && !menu.includes('container='),
       (menu.match(/\/api\/claims\/report\?[^"]*/) || [''])[0]);
}

// ══════════════════════════════════════════════════════════════════════════
section('C — date wise');
// ══════════════════════════════════════════════════════════════════════════
{
    const w = boot();
    paint(w, { group: 'month', tab: 'all' });
    ck('rows are MONTHS',
       JSON.stringify(rowKeys(w).sort()) === JSON.stringify(['2026-09', '2026-10', '2026-11']),
       JSON.stringify(rowKeys(w)));
    ck('  September holds the two claims raised then',
       groupsOf(w).find((g) => g.key === '2026-09').claims.length === 2);
    // A demand addressed to "November" is not a document.
    const g = groupsOf(w).find((x) => x.key === '2026-11');
    ck('  a month row offers no supplier demand', g.groupKind === 'month');
}

// ══════════════════════════════════════════════════════════════════════════
section('D — the date range filters CLAIMS, so the totals match the list');
// ══════════════════════════════════════════════════════════════════════════
{
    const w = boot();
    paint(w, { group: 'container', tab: 'all', from: '2026-10-01', to: '2026-10-31' });
    ck('only October claims survive the range',
       JSON.stringify(rowKeys(w)) === JSON.stringify(['BBBB2222222']), JSON.stringify(rowKeys(w)));
    // The point of filtering before grouping: a row's figure is the figure
    // of what is under it, not of everything that supplier ever claimed.
    paint(w, { group: 'supplier', tab: 'all', from: '2026-09-01', to: '2026-09-30' });
    const inesh = groupsOf(w).find((g) => g.key === 'Inesh');
    ck('a supplier row totals only what is in range',
       inesh && inesh.claims.length === 2 && inesh.claimed === 150,
       inesh ? `${inesh.claims.length} claims, ${inesh.claimed}` : 'no Inesh row');
    ck('  and a supplier with nothing in range is not listed',
       !rowKeys(w).includes('Taewon'), JSON.stringify(rowKeys(w)));
}

// ══════════════════════════════════════════════════════════════════════════
section('E — open and settled');
// ══════════════════════════════════════════════════════════════════════════
{
    const w = boot();
    ck('Settled is offered beside Open', tabIds(paint(w, { tab: 'all' })).includes('settled'),
       JSON.stringify(tabIds(w)));

    paint(w, { group: 'container', tab: 'open' });
    ck('Open keeps a container with ANY claim still live',
       rowKeys(w).includes('AAAA1111111') && rowKeys(w).includes('CCCC3333333'), JSON.stringify(rowKeys(w)));
    ck('  and drops the one where everything is finished',
       !rowKeys(w).includes('BBBB2222222'), JSON.stringify(rowKeys(w)));

    paint(w, { group: 'container', tab: 'settled' });
    // EVERY claim, not ANY: a container with one settled claim and one being
    // argued is not settled.
    ck('Settled means every claim on it is finished',
       JSON.stringify(rowKeys(w)) === JSON.stringify(['BBBB2222222']), JSON.stringify(rowKeys(w)));
    ck('  so a half-settled container is NOT called settled',
       !rowKeys(w).includes('AAAA1111111'), JSON.stringify(rowKeys(w)));
}

// ══════════════════════════════════════════════════════════════════════════
section('F — what switching the lens must not do');
// ══════════════════════════════════════════════════════════════════════════
{
    const w = boot();
    paint(w, { group: 'container', tab: 'all', sel: 'AAAA1111111' });
    // A container id is not a supplier name. Carried across, the detail
    // panel keeps showing a group the list no longer has.
    w.document.querySelector('#groupBy button[data-g="supplier"]').click();
    ck('the selected row is dropped when the lens changes', S(w).sel === null, String(S(w).sel));
    ck('  and the lens actually changed', S(w).group === 'supplier', S(w).group);

    // '2+ claims' counts claims on one CONTAINER and means nothing else.
    ck('"2+ claims" is hidden under the supplier lens', !tabIds(w).includes('multi'),
       JSON.stringify(tabIds(w)));
    const w2 = boot();
    paint(w2, { group: 'container', tab: 'multi' });
    ck('  and is offered under the container lens', tabIds(w2).includes('multi'),
       JSON.stringify(tabIds(w2)));
    w2.document.querySelector('#groupBy button[data-g="month"]').click();
    ck('  standing on it when she switches lands somewhere that still means something',
       S(w2).tab !== 'multi' && rowKeys(w2).length > 0, `${S(w2).tab} / ${JSON.stringify(rowKeys(w2))}`);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.log('CRASHED: ' + (e && e.stack || e)); process.exit(1); });
