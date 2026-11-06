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
    return { helpers: SRC.slice(h0, t0), tpl: SRC.slice(open, end + '</section>`'.length) };
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
    byMethod: {}, months: [], rows: [],
    cash: { opening: 0, in: 0, out: 0, closing: 0 }, received: { total: 0, count: 0, rows: [] },
};

function render(rep, { method = '', bank = '', via = '' } = {}) {
    const { helpers, tpl } = extract();
    const dom = new JSDOM('<div id="viewRoot"></div>', { url: 'http://localhost/' });
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
    // ── ONE eval, NOT TWO ────────────────────────────────────────────────
    // The helpers are `const`, which is block-scoped to its own eval and
    // therefore invisible to a second one — the first version of this test
    // died on "chipCss is not defined". Same scope, so the template sees
    // them exactly as it does in the browser.
    const html = w.eval(helpers + '\n;(' + tpl + ')');
    w.document.getElementById('viewRoot').innerHTML = html;
    return { w, d: w.document, text: w.document.getElementById('viewRoot').textContent };
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
    ck('"Not recorded" is amber in both breakdowns',
       amber.filter((t) => t === 'Not recorded').length === 2, JSON.stringify(amber));
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
    const { text } = render({ ...REAL,
        months: [{ month: '2026-10', Cash: 1000, total: 1000 }],
        cash: { opening: 500, in: 200, out: 100, closing: 600 },
        received: { total: 40000, count: 3, rows: [] } });
    ck('the petty cash reconciliation is still there', /Petty cash over this period/.test(text));
    ck('money received is still shown, and still kept apart',
       /Received from buyers/.test(text) && /not.*counted in the figures above/i.test(text));
    ck('the month table is still there', /All months/.test(text));
    ck('the date range and Apply are still there', /Apply/.test(text));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})();
