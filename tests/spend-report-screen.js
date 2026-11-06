// ── tests/spend-report-screen.js ──────────────────────────────────────────
// Apsara, 2026-11-07, on the Spend report: "Ugly".
//
// It was, and the styling was the smaller half. The heading printed
//
//     out $2,153,593.65    loads $857,196.72    expenses $111,925.00
//
// which invites the obvious subtraction, and the obvious subtraction leaves
// $1,184,471.93 with no name on it — 55% of her money out, in categories the
// screen never mentioned: trucking, suppliers, cost of sales, Edge Metals
// haulage. The engine has had every one of them for months and
// tests/spend-report.js already asserts they sum to the total. Only the
// SCREEN was picking two to show.
//
// ── THESE CHECKS RENDER. THEY DO NOT GREP. ───────────────────────────────
// #243: dashboard/claims.html was dead for six days behind 139 green regex
// checks, because every one of them read the file as text and none of them
// ever executed it. So this file pulls the real template out of
// 06-expenses-trucker.js and EVALUATES it, and every assertion below is made
// against rendered DOM.
const path = require('path');
const fs = require('fs');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'dashboard/app/06-expenses-trucker.js'), 'utf8');

// ── PULLING THE RENDER OUT ────────────────────────────────────────────────
// renderSpendReportTab() fetches before it renders, so calling it whole would
// be a network test. The part under examination is the helpers plus the
// template, and both are taken from the REAL file at the REAL offsets — if
// either marker moves, this throws rather than silently testing nothing.
const MARK_HELPERS = '  // ── THE LOOK, 2026-11-07';
const MARK_TPL = "$('viewRoot').innerHTML = `";
const MARK_WIRE = '  // ── TAKE THE DATES OFF THE SCREEN BEFORE EVERY RE-RUN';
function extract() {
    const h0 = SRC.indexOf(MARK_HELPERS);
    if (h0 < 0) throw new Error('the Spend report helpers block has moved — this test is now testing nothing');
    const t0 = SRC.indexOf(MARK_TPL, h0);
    if (t0 < 0) throw new Error('the Spend report template has moved');
    const open = t0 + MARK_TPL.length - 1;
    // The markup is full of nested template literals, so a backtick counter
    // gets this wrong. The render ends at the section close, once.
    const end = SRC.indexOf('</section>`;', open);
    if (end < 0) throw new Error('could not find the end of the Spend report template');
    // The handlers, from the same real file. The template alone cannot show
    // that a click does the right thing, and both the date-wipe and the
    // auto-apply live entirely in here.
    const w0 = SRC.indexOf(MARK_WIRE, end);
    if (w0 < 0) throw new Error('the Spend report handlers have moved — the click checks test nothing');
    const w1 = SRC.indexOf('\n}', SRC.indexOf('.btn-spend-sold', w0));
    if (w1 < 0) throw new Error('could not find the end of the Spend report handlers');
    return { helpers: SRC.slice(h0, t0), tpl: SRC.slice(open, end + '</section>`'.length),
             wiring: SRC.slice(w0, w1) };
}

const REAL = {
    total: 2153593.65, loadTotal: 857196.72, expenseTotal: 111925.00,
    truckerTotal: 731508.41, supplierTotal: 302963.52, saleCostTotal: 95000.00,
    metalsTruckingTotal: 55000.00, count: 244,
    columns: ['Cash', 'Zelle', 'Wire', 'Cheque', 'Card', 'Other', 'Unclassified'],
    bankColumns: ['BofA', 'Chase Bank', 'Not recorded'],
    paidViaColumns: ['Edge Metals', 'Edge Yard', 'Not recorded'],
    byBank: { 'BofA': 1301951.93, 'Not recorded': 834163.32, 'Chase Bank': 17478.40 },
    byPaidVia: { 'Not recorded': 2049070.70, 'Edge Metals': 87044.55, 'Edge Yard': 17478.40 },
    // Apsara 2026-11-07: "TWO FILTERS,WHOM WE BUY,WHOM WE SELL".
    boughtFromColumns: ['Eccomelt', 'Ramesh', 'Zimex', 'Not recorded'],
    soldToColumns: ['Hynos', 'Eccomelt'],
    byBoughtFrom: { 'Eccomelt': 1200000, 'Ramesh': 700000, 'Zimex': 153593.65, 'Not recorded': 100000 },
    bySoldTo: { 'Hynos': 300000, 'Eccomelt': 100000 },
    byMethod: {}, months: [], rows: [],
    cash: { opening: 0, in: 0, out: 0, closing: 0 },
    // received.total is the sum of bySoldTo, because the engine builds the
    // second FROM the first. A fixture where they disagree is a shape the
    // code cannot produce, and a test built on one proves nothing.
    received: { total: 400000, count: 2, rows: [] },
};

function render(rep, { method = '', bank = '', via = '', bought = '', sold = '', company = 'edge-trading' } = {}) {
    const { helpers, tpl } = extract();
    // runScripts: 'dangerously' so w.eval runs in PAGE scope, where `document`
// and `window` are real globals. Without it the evals run in a bare Node
// scope and the page's own `$(id)` helper cannot see `document`.
const dom = new JSDOM('<div id="viewRoot"></div>',
    { url: 'http://localhost/', runScripts: 'dangerously' });
    const w = dom.window;
    w.eval(`
      var esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      var money=n=>'$'+Number(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
      var toUsDate=s=>s||''; var cell=v=>v?money(v):'-';
      var statRowHtml=st=>st.map(x=>'<div class="stat" data-label="'+x[0]+'">'+x[1]+'</div>').join('');
      function pageHead(t,o){o=o||{};return '<h2>'+esc(t)+'</h2>'+(o.note?'<div class="note">'+o.note+'</div>':'')
        +'<div id="headStats">'+statRowHtml(o.stats||[])+'</div>';}
      var presets=[['This month',0],['Last month',0],['This year',0],['All time',0]];
      var spendFrom='',spendTo='';
    `);
    w.eval(`var rep=${JSON.stringify(rep)}; var cols=rep.columns;`);
    w.eval(`var spendMethod=${JSON.stringify(method)},spendBank=${JSON.stringify(bank)},spendPaidVia=${JSON.stringify(via)};`);
    w.eval(`var spendBought=${JSON.stringify(bought)},spendSold=${JSON.stringify(sold)};`);
    w.eval(`var spendCompany=${JSON.stringify(company)};`);
    // ── ONE eval, NOT TWO ────────────────────────────────────────────────
    // The helpers are `const`, which is block-scoped to its own eval and
    // therefore invisible to a second one — the first version of this test
    // died on "chipCss is not defined". Same scope, so the template sees
    // them exactly as it does in the browser.
    const html = w.eval(helpers + '\n;(' + tpl + ')');
    w.document.getElementById('viewRoot').innerHTML = html;
    return { w, d: w.document, text: w.document.getElementById('viewRoot').textContent };
}

// ── CLICKING, NOT JUST RENDERING ─────────────────────────────────────────
// Render the real template, then attach the REAL handlers with
// renderSpendReportTab stubbed, so a click records the state it would have
// re-run with instead of fetching. Both the auto-apply and the date-wipe
// live entirely in the handlers; a template-only check cannot see either.
function mount(rep, sel = {}) {
    const { w, d } = render(rep, sel);
    const { wiring } = extract();
    w.eval(`
      // The wiring uses $() to reach the date boxes; the template never did,
      // so render() had no reason to define it.
      var $ = function(id){ return document.getElementById(id); };
      var __runs = [];
      function renderSpendReportTab(){ __runs.push({ from: spendFrom, to: spendTo,
        method: spendMethod, bank: spendBank, via: spendPaidVia,
        bought: spendBought, sold: spendSold, company: spendCompany }); }
      var presets = [
        ['This month', function(){ return ['2026-11-01','2026-11-30']; }],
        ['Last month', function(){ return ['2026-10-01','2026-10-31']; }],
        ['This year',  function(){ return ['2026-01-01','2026-12-31']; }],
        ['All time',   function(){ return ['','']; }],
      ];
      var toIsoDate = function(v){
        var m = String(v||'').match(/^(\\d{2})\\/(\\d{2})\\/(\\d{4})$/);
        return m ? m[3]+'-'+m[1]+'-'+m[2] : (v || '');
      };
    `);
    w.eval(wiring);
    return {
        w, d,
        // type() fires `change`, which is how a date picker and a committed
        // keystroke both behave. put() only sets the value — the "typed but
        // not committed" case that used to be thrown away.
        type: (id, v) => {
            const el = d.getElementById(id); el.value = v;
            el.dispatchEvent(new w.Event('change', { bubbles: true }));
        },
        put: (id, v) => { d.getElementById(id).value = v; },
        click: (q) => d.querySelector(q).dispatchEvent(new w.Event('click', { bubbles: true })),
        runs: () => w.__runs,
    };
}

(() => {

// ══════════════════════════════════════════════════════════════════════════
section('A — the heading no longer prints a subtraction that leaves 55% unnamed');
// ══════════════════════════════════════════════════════════════════════════
{
    const { d } = render(REAL);
    const labels = [...d.querySelectorAll('#headStats .stat')].map((n) => n.dataset.label);
    ck('the heading carries the total and the count', labels.join(',') === 'out,entries', labels.join(','));
    ck('  and no longer offers "loads" and "expenses" beside "out"',
       !labels.includes('loads') && !labels.includes('expenses'),
       'out minus those two left $1,184,471.93 with no name on it');
}

// ══════════════════════════════════════════════════════════════════════════
section('B — every part of the total is named, and they reconcile');
// ══════════════════════════════════════════════════════════════════════════
{
    const { d, text } = render(REAL);
    ck('there is a "Where it went" card', /Where it went/.test(text));
    for (const [label, amount] of [
        ['Paid to sellers', '$857,196.72'], ['Trucking', '$731,508.41'],
        ['Suppliers', '$302,963.52'], ['Cost of sales', '$95,000.00'],
        ['Edge Metals haulage', '$55,000.00'], ['Expenses', '$111,925.00'],
    ]) {
        ck(`  ${label} is named, with its money`,
           text.includes(label) && text.includes(amount), `${label} / ${amount}`);
    }

    // THE PROPERTY, not the six labels: the percentages shown must account
    // for the whole total. A card that names five of six parts would pass
    // every check above and still hide money.
    const pcts = (text.match(/([\d.]+)% of out/g) || []).map((s) => parseFloat(s));
    ck('the shares shown add up to the whole total',
       pcts.length === 6 && Math.abs(pcts.reduce((a, b) => a + b, 0) - 100) < 0.2,
       `${pcts.length} parts, ${pcts.reduce((a, b) => a + b, 0).toFixed(1)}%`);

    // A part worth nothing in this window is left out rather than printed as
    // $0.00 — six zero rows is the clutter she objected to in the first place.
    const noSuppliers = render({ ...REAL, supplierTotal: 0,
        total: REAL.total - REAL.supplierTotal });
    ck('a part with no money in the window is omitted, not printed as zero',
       !noSuppliers.text.includes('Suppliers'), 'zero rows are clutter');
}

// ══════════════════════════════════════════════════════════════════════════
section('C — if the parts ever stop reconciling, it SAYS SO');
// ══════════════════════════════════════════════════════════════════════════
// The whole point of the card is that the figures account for the total. A
// card that silently draws a short bar would be the original fault wearing a
// nicer coat.
{
    const short = render({ ...REAL, total: REAL.total + 50000 });
    ck('a total the parts do not reach is called out',
       /do not reach|short of/.test(short.text), short.text.slice(0, 200));
    ck('  with both figures, so she can see which to chase',
       short.text.includes('$50,000.00'), 'the size of the hole');
    ck('  and it says not to file from the screen until it is found',
       /do not file from this screen/i.test(short.text));
    ck('a report that DOES reconcile shows no such warning',
       !/do not file from this screen/i.test(render(REAL).text));
}

// ══════════════════════════════════════════════════════════════════════════
section('D — "Not recorded" is drawn as a gap, not as a third bank');
// ══════════════════════════════════════════════════════════════════════════
// It sat between BofA and Chase in plain white, reading like an account.
// $2,049,070.70 of her spend has no paying company on it — 95% — and Edge
// Yard and Edge Metals are different companies, so that money sits on
// neither return.
{
    const { d, text } = render(REAL);
    const amber = [...d.querySelectorAll('span')]
        .filter((n) => /status-warning/.test(n.getAttribute('style') || ''))
        .map((n) => n.textContent.trim());
    // Counted as a PROPERTY, not as a magic number: every breakdown that has
    // a gap draws it amber. The first version asserted "=== 2" and went red
    // the day a third breakdown was added, which is a check measuring the
    // layout instead of the rule.
    const cards = (text.match(/Out of each account|Whose money it was|Whom we buy from/g) || []).length;
    ck('every breakdown with a gap draws it amber',
       amber.filter((t) => t === 'Not recorded').length === cards,
       JSON.stringify({ amber: amber.filter((t) => t === 'Not recorded').length, cards }));
    ck('  and the real accounts are not',
       !amber.includes('BofA') && !amber.includes('Edge Metals'), JSON.stringify(amber));

    ck('every figure carries its share of the total',
       /95%/.test(text) && /60%/.test(text), 'the number and the proportion are the same fact');
    ck('the paid-via gap explains why it matters',
       /different companies/.test(text), 'an unattributed payment sits on neither return');
    ck('the account gap says how to fix it',
       /Not recorded.*to find and fix|filter/i.test(text));

    // No gap, no warning sentence — otherwise it is noise that trains her to
    // skip the card.
    const clean = render({ ...REAL,
        byBank: { 'BofA': 2153593.65 },
        byPaidVia: { 'Edge Yard': 2153593.65 } });
    ck('a period with nothing unrecorded prints no warning at all',
       !/different companies/.test(clean.text) && !/find and fix/.test(clean.text));
}

// ══════════════════════════════════════════════════════════════════════════
section('E — the chips are quieter, and still wired to the same handlers');
// ══════════════════════════════════════════════════════════════════════════
// This half is paint. Paint that breaks a filter is not paint, so the
// classes and data- attributes the click handlers match on are asserted
// here, not assumed.
{
    const { d } = render(REAL, { method: 'Wire', bank: 'BofA', via: 'Edge Yard' });

    for (const [cls, attr, values] of [
        ['btn-spend-method', 'method', ['', ...REAL.columns]],
        ['btn-spend-bank', 'bank', ['', ...REAL.bankColumns]],
        ['btn-spend-via', 'via', ['', ...REAL.paidViaColumns]],
    ]) {
        const got = [...d.querySelectorAll('.' + cls)].map((n) => n.getAttribute('data-' + attr));
        ck(`every ${attr} still renders a chip the handler can match`,
           got.length === values.length && values.every((v) => got.includes(v)),
           JSON.stringify(got));
    }
    ck('the presets still carry their index', [...d.querySelectorAll('.btn-spend-preset')]
        .map((n) => n.dataset.i).join(',') === '0,1,2,3');

    // Exactly one chip per row is highlighted — the selected one.
    const accented = (cls) => [...d.querySelectorAll('.' + cls)]
        .filter((n) => /background:var\(--accent\)/.test(n.getAttribute('style') || ''));
    ck('exactly one method chip is highlighted', accented('btn-spend-method').length === 1);
    ck('  and it is the selected one',
       accented('btn-spend-method')[0].dataset.method === 'Wire');
    ck('exactly one bank chip and one company chip likewise',
       accented('btn-spend-bank').length === 1 && accented('btn-spend-via').length === 1);

    // And the unselected ones are quiet rather than solid blocks — the
    // complaint itself.
    const quiet = [...d.querySelectorAll('.btn-spend-method')]
        .filter((n) => n.dataset.method !== 'Wire');
    ck('every unselected chip is transparent, not a filled block',
       quiet.length > 0 && quiet.every((n) => /background:transparent/.test(n.getAttribute('style') || '')),
       'fifteen solid grey chips were shouting louder than the money');
    ck('  and still has a border, so it is visibly a control',
       quiet.every((n) => /border:1px solid/.test(n.getAttribute('style') || '')));
}

// ══════════════════════════════════════════════════════════════════════════
section('F — nothing else on the screen was lost in the restyle');
// ══════════════════════════════════════════════════════════════════════════
// A redesign that drops a section is a behaviour change, and she asked for
// paint.
{
    const full = render({ ...REAL,
        months: [{ month: '2026-10', Cash: 1000, total: 1000 }],
        cash: { opening: 500, in: 200, out: 100, closing: 600 },
        received: { total: 40000, count: 3, rows: [] } });
    const text = full.text;
    const bare2 = () => full.d;
    ck('the petty cash reconciliation is still there', /Petty cash over this period/.test(text));
    ck('money received is still shown, and still kept apart',
       /Received from buyers/.test(text) && /not.*counted in the figures above/i.test(text));
    ck('the month table is still there', /All months/.test(text));
    // SUPERSEDED 2026-11-07. This required an Apply button. Apsara: "if i
    // select it should auto app;y" — the button is gone and changing either
    // date box re-runs the report. The property worth keeping is that the
    // RANGE is still settable, which section I now proves by clicking.
    ck('the date range is still there', !!bare2().getElementById('spend_from')
       && !!bare2().getElementById('spend_to'));
    // "Sorry we ca have apply" — it is back, and it coexists with
    // auto-apply rather than being the only way to commit a date.
    ck('  and Apply is there too', !!bare2().getElementById('btnSpendApply'));
}

// ══════════════════════════════════════════════════════════════════════════
section('G — whom we buy from, whom we sell to: TWO rows, not one');
// ══════════════════════════════════════════════════════════════════════════
// Apsara, 2026-11-07: "What if i want supplier wise filter in edge yard" →
// "TWO FILTERS,WHOM WE BUY,WHOM WE SELL".
{
    const { d, text } = render(REAL, { bought: 'Ramesh', sold: 'Hynos' });

    const boughtChips = [...d.querySelectorAll('.btn-spend-bought')].map((n) => n.dataset.bought);
    const soldChips = [...d.querySelectorAll('.btn-spend-sold')].map((n) => n.dataset.sold);
    ck('there is a Bought-from chip for every counterparty, plus All',
       boughtChips.length === 5 && boughtChips.includes('') && boughtChips.includes('Eccomelt'),
       JSON.stringify(boughtChips));
    ck('and a SEPARATE Sold-to row', soldChips.length === 3 && soldChips.includes('Hynos'),
       JSON.stringify(soldChips));
    ck('  the two rows are not the same control',
       boughtChips.join() !== soldChips.join(), 'one filter cannot answer both questions');

    const lit = (cls, attr) => [...d.querySelectorAll('.' + cls)]
        .filter((n) => /background:var\(--accent\)/.test(n.getAttribute('style') || ''))
        .map((n) => n.dataset[attr]);
    ck('exactly one Bought-from chip is lit, and it is the chosen one',
       lit('btn-spend-bought', 'bought').join() === 'Ramesh');
    ck('exactly one Sold-to chip is lit, independently',
       lit('btn-spend-sold', 'sold').join() === 'Hynos');

    ck('both breakdowns are drawn', /Whom we buy from/.test(text) && /Whom we sell to/.test(text));
    // ── THE LABEL IS NOT THE PROPERTY ────────────────────────────────────
    // First written as a check that the words "of money received" appear.
    // The mutation that swaps the denominator to rep.total left those words
    // untouched and SURVIVED — the check was reading the caption, not the
    // arithmetic. Hynos is 300,000 of 400,000 received = 75%. Against money
    // out it would read 14%, which is a figure that looks computed and is
    // about the wrong total.
    ck('  the sold-to side says "of money received"', /of money received/.test(text));
    ck('  and its percentages ARE of money received, not of money out',
       /75%/.test(text) && !/14%/.test(text),
       'Hynos 300,000 of 400,000 received = 75%; of total out it would be 14%');
    ck('  "Not recorded" is amber on the buy side too',
       [...d.querySelectorAll('span')].filter((n) => /status-warning/.test(n.getAttribute('style') || ''))
           .filter((n) => n.textContent.trim() === 'Not recorded').length === 3,
       'bank, paid-via, and now bought-from');
}

// ══════════════════════════════════════════════════════════════════════════
section('H — a one-name list renders NO row, rather than a dead control');
// ══════════════════════════════════════════════════════════════════════════
// Until counterparties are recorded these lists are one entry long. Same
// rule the bank and company rows have always followed: a row of chips with
// one option is a control that cannot change anything.
{
    const bare = render({ ...REAL,
        boughtFromColumns: ['Not recorded'], soldToColumns: ['Not recorded'],
        byBoughtFrom: { 'Not recorded': 2153593.65 }, bySoldTo: {} });
    ck('no Bought-from row when there is only one name',
       bare.d.querySelectorAll('.btn-spend-bought').length === 0);
    ck('no Sold-to row either', bare.d.querySelectorAll('.btn-spend-sold').length === 0);
    ck('  but the breakdown still shows where the money went',
       /Whom we buy from/.test(bare.text), 'the gap is still worth seeing');
    ck('  and with nothing received, no sell-side card is drawn',
       !/Whom we sell to/.test(bare.text), 'an empty card is clutter');
}

// ══════════════════════════════════════════════════════════════════════════
section('I — dates auto-apply, and a filter never throws them away');
// ══════════════════════════════════════════════════════════════════════════
// Apsara, 2026-11-07, twice: "What if i want from this date to this date in
// this filter", then "if i select it should auto app;y".
//
// Two faults, one cause. Only Apply read the two boxes. So (a) picking a
// date did nothing until you found the button, and (b) typing a range and
// then clicking a filter re-ran with the OLD window and wiped what you
// typed, because the re-render repaints the boxes from the stored values.
// Nothing errored — the figures were real and answered a different question
// than the one on screen, which is the worst shape a date bug can take.
{
    const m = mount(REAL);
    m.type('spend_from', '03/01/2026');
    ck('changing a date box re-runs the report on its own', m.runs().length === 1,
       'no button needed');
    ck('  with the date that was picked', m.runs()[0].from === '2026-03-01',
       JSON.stringify(m.runs()[0]));

    // Typed but NOT committed, then a filter clicked — the original fault.
    for (const [sel, field, want] of [
        ['.btn-spend-method[data-method="Wire"]', 'method', 'Wire'],
        ['.btn-spend-bank[data-bank="BofA"]', 'bank', 'BofA'],
        ['.btn-spend-via[data-via="Edge Yard"]', 'via', 'Edge Yard'],
        ['.btn-spend-bought[data-bought="Ramesh"]', 'bought', 'Ramesh'],
        ['.btn-spend-sold[data-sold="Hynos"]', 'sold', 'Hynos'],
        ['.btn-spend-company[data-company="edge-metals"]', 'company', 'edge-metals'],
    ]) {
        const k = mount(REAL);
        k.put('spend_from', '03/01/2026'); k.put('spend_to', '03/31/2026');  // typed, no event
        k.click(sel);
        const got = k.runs()[0];
        ck(`${field} keeps dates typed but not yet committed`,
           got && got.from === '2026-03-01' && got.to === '2026-03-31' && got[field] === want,
           JSON.stringify(got));
    }

    // ── A PRESET MUST STILL OVERWRITE ────────────────────────────────────
    // The obvious way to get this fix wrong is to have the presets read the
    // boxes they exist to replace, which would silently turn them into
    // no-ops — a worse bug than the one being fixed.
    const p = mount(REAL);
    p.put('spend_from', '03/01/2026'); p.put('spend_to', '03/31/2026');
    p.click('.btn-spend-preset[data-i="1"]');
    ck('a preset still OVERWRITES whatever is in the boxes',
       p.runs()[0].from === '2026-10-01' && p.runs()[0].to === '2026-10-31',
       JSON.stringify(p.runs()[0]) + ' — replacing the range is the point of a preset');

    // Apply still works, and does exactly what a committed box does.
    const a = mount(REAL);
    a.put('spend_from', '01/15/2026'); a.put('spend_to', '02/15/2026');
    a.click('#btnSpendApply');
    ck('Apply still commits a typed range', a.runs().length === 1
       && a.runs()[0].from === '2026-01-15' && a.runs()[0].to === '2026-02-15',
       JSON.stringify(a.runs()[0]));

    const c = mount(REAL);
    c.put('spend_from', '03/01/2026'); c.type('spend_to', '');
    ck('an emptied box means open-ended, not the previous value',
       c.runs()[0].from === '2026-03-01' && c.runs()[0].to === '');
}

// ══════════════════════════════════════════════════════════════════════════
section('J — one company at a time, and it says so when it is not');
// ══════════════════════════════════════════════════════════════════════════
// Apsara: this "should be the one stop thing for the edge yard", defaulting
// to Edge Yard. CLAUDE.md rule 5: Edge Yard and Edge Metals are different
// companies. The headline used to add them together.
{
    const { d } = render(REAL);          // render() defaults to edge-trading
    const chips = [...d.querySelectorAll('.btn-spend-company')].map((n) => n.dataset.company);
    ck('all three choices are offered', chips.join() === 'edge-trading,edge-metals,',
       JSON.stringify(chips));
    const lit = [...d.querySelectorAll('.btn-spend-company')]
        .filter((n) => /font-weight:700/.test(n.getAttribute('style') || ''))
        .map((n) => n.dataset.company);
    ck('Edge Yard is the one selected by default', lit.join() === 'edge-trading',
       JSON.stringify(lit));

    // The warning belongs ONLY on the combined view.
    ck('scoped to one company there is no two-company warning',
       !/Two companies in one figure/.test(render(REAL).text));
    ck('  and choosing Both says plainly what the figure now is',
       /Two companies in one figure/.test(render(REAL, { company: '' }).text),
       'never for a return');
    ck('  Edge Metals alone is also unwarned',
       !/Two companies in one figure/.test(render(REAL, { company: 'edge-metals' }).text));

    // Switching company must not silently keep another company's filter on
    // screen as though it still applied — it re-runs, which is what matters.
    const k = mount(REAL, { method: 'Wire' });
    k.click('.btn-spend-company[data-company=""]');
    ck('switching company re-runs the whole report',
       k.runs().length === 1 && k.runs()[0].company === '', JSON.stringify(k.runs()[0]));
    ck('  and keeps the other filters she had set', k.runs()[0].method === 'Wire');
}

// ══════════════════════════════════════════════════════════════════════════
section('K — a long counterparty list becomes a picker, not a wall of chips');
// ══════════════════════════════════════════════════════════════════════════
// Apsara, 2026-11-07, on a screenshot of 45 Bought-from chips filling the
// page: "What the hell bro". The chip row was designed against three banks
// and never looked at with her real supplier list.
{
    const many = Array.from({ length: 45 }, (_, i) => `Seller ${String(i + 1).padStart(2, '0')}`);
    const big = render({ ...REAL, boughtFromColumns: many });
    ck('45 names render NO chips', big.d.querySelectorAll('.btn-spend-bought').length === 0,
       'sixty controls is not a filter');
    const sel = big.d.getElementById('spend_bought');
    ck('  a select appears instead', !!sel);
    ck('  carrying every name plus All', sel.options.length === 46, String(sel.options.length));
    ck('  and All is what it starts on', sel.value === '');

    // The SHORT lists must stay chips — one click is right for Cash/Zelle/Wire.
    ck('a short list is still chips', render(REAL).d.querySelectorAll('.btn-spend-bought').length > 0,
       'REAL has 4 names, under the threshold');
    ck('  and the method row is untouched by any of this',
       render(REAL).d.querySelectorAll('.btn-spend-method').length === 8);

    // Selected state has to survive the re-render, or she cannot tell what
    // she is looking at.
    const picked = render({ ...REAL, boughtFromColumns: many }, { bought: 'Seller 07' });
    ck('the chosen name is selected when the page comes back',
       picked.d.getElementById('spend_bought').value === 'Seller 07');
    ck('  and it says so in words beside the control',
       /showing Seller 07 only/.test(picked.text));

    // ── AND THE CLICK STILL FILTERS ──────────────────────────────────────
    // A control that looks right and files nothing is worse than the wall.
    const m = mount({ ...REAL, boughtFromColumns: many });
    m.put('spend_from', '03/01/2026');
    const sl = m.d.getElementById('spend_bought');
    sl.value = 'Seller 12';
    sl.dispatchEvent(new m.w.Event('change', { bubbles: true }));
    const r = m.runs()[0];
    ck('choosing a name re-runs the report with it', r && r.bought === 'Seller 12', JSON.stringify(r));
    ck('  and keeps the dates she had typed', r && r.from === '2026-03-01', JSON.stringify(r));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})();
