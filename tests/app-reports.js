// ── tests/app-reports.js ──────────────────────────────────────────────────
// Apsara, 2026-09-16: "There should be multiple reports in yard app na?"
//
// She was right, and the gap was not evenly spread. The app's Report tab was
// ONE view — the spend report — while the server had been producing a sales
// report the phone never showed and the website had had for weeks. Inventory's
// three sub-views existed but were buried inside the Inventory tab rather than
// being reports you go to.
//
// Asked what Report should become she chose a menu, and named the four she
// actually opens: Sales, Stock on hand, Spend, Profit. Profit existed nowhere
// on either client.
//
// Driven in jsdom rather than grepped: a menu whose buttons are rendered but
// unwired looks perfect in source and does nothing on a phone, which is a
// failure this project has shipped before.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

process.env.JARVIS_TEST = '1';

let pass = 0, fail = 0; const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'mobile-app/www/index.html'), 'utf8');

const ROUTES = {
    '/api/me': { ok: true, role: 'admin', super: false },
    '/api/loads': [], '/api/outbound-loads': [], '/api/load-drafts': [],
    '/api/item-types': { ok: true, items: ['Al combo'] },
    '/api/address-book': [],
    '/api/contacts': { ok: true, contacts: [], groups: [] },
    '/api/loads/inventory': { ok: true, unit: 'lb', onHandAvailable: true, lots: [],
        byType: [{ description: 'Al combo', count: 2, net: 1000, shipped: 700, onHand: 300, amount: 500 },
                 { description: 'Copper #2', count: 1, net: 200, shipped: 0, onHand: 200, amount: 400 }] },
    '/api/outbound-loads/report': { loadCount: 2, unit: 'lb', totalAmount: 840, totalCost: 500, totalMargin: 340,
        byBuyer: [{ buyer: 'Eccomelt', loadCount: 1, net: 600, amount: 600, cost: 500, margin: 100 },
                  { buyer: 'Daekwang', loadCount: 1, net: 200, amount: 240, cost: null, margin: null }] },
    '/api/reports/yard-profit': {
        from: null, to: null, unit: 'lb',
        margin: { revenue: 840, cost_of_material_sold: 500, margin: 340, coverage_pct: 71.4,
                  caveat: 'Covers 71.4% of sales — the rest are not linked to the loads they came from.',
                  byBuyer: [] },
        cash: { bought: 500, sold: 840, expenses: 60, trucking: 40, net: 240,
                note: 'Money in and out over this period only. NOT profit — metal bought this month is usually sold in another, so a big purchase shows as a loss it never was.' },
        counts: { purchases: 1, sales: 2 }, partial: [],
    },
    '/api/reports/spend': { total: 1400, loadTotal: 0, expenseTotal: 1400, count: 3, months: [],
        byMethod: {}, byBank: {}, columns: [], bankColumns: [], rows: [], byCategory: [],
        cash: { opening: 0, in: 0, out: 0, closing: 0 },
        received: { total: 0, count: 0, byMethod: {} }, from: null, to: null, method: null, bank: null },
};

(async () => {

const errors = [];
const dom = new JSDOM(APP, {
    runScripts: 'dangerously', url: 'http://localhost/',
    beforeParse(w) {
        w.fetch = (u) => {
            const k = String(u).split('?')[0].replace(/^https?:\/\/[^/]+/, '');
            return Promise.resolve({ ok: true, status: 200,
                json: () => Promise.resolve(k in ROUTES ? ROUTES[k] : { ok: true }) });
        };
        w.alert = () => {}; w.confirm = () => true;
        w.addEventListener('error', (e) => errors.push(e.message));
    },
});
await new Promise((r) => setTimeout(r, 700));
const w = dom.window, d = w.document;

section('A — Report is a menu, not one report');
{
    // Read from SOURCE, not off window. YARD_REPORTS is a top-level `const`,
    // which creates a script-scope binding and NOT a window property — the
    // trap this project has now hit five separate times. w.YARD_REPORTS is
    // undefined and the assertion fails for a reason with nothing to do with
    // reports.
    const declared = [...APP.slice(APP.indexOf('const YARD_REPORTS = ['),
                                   APP.indexOf('const YARD_REPORTS = [') + 900)
        .matchAll(/\{ id: '([a-z]+)'/g)].map((m) => m[1]);
    ck('the app knows about four reports', declared.length === 4, JSON.stringify(declared));
    ck('  and they are the four she named',
       JSON.stringify(declared.slice().sort()) === JSON.stringify(['profit', 'sales', 'spend', 'stock']),
       JSON.stringify(declared));

    // ── WHAT THE REPORT TAB DISPATCHES TO ────────────────────────────────
    // Asserted at the SOURCE, and stated plainly rather than dressed up.
    // Tapping the tab needs the app past its login screen with ROLE ===
    // 'admin' — the Report tab is admin-only — and ROLE is a top-level `let`
    // that cannot be set from outside. Standing up a real session inside a
    // jsdom fixture to test one dispatch line would be more fixture than
    // feature.
    //
    // It IS asserted, because a mutation pointing the tab back at the old
    // single spend report otherwise survives everything below: every check
    // here calls renderReportsMenu() directly and would keep passing while
    // the tab itself never reached it.
    const dispatch = APP.slice(APP.indexOf("if (currentMobileTab === 'report')"), APP.indexOf("if (currentMobileTab === 'report')") + 90);
    ck('the Report tab opens the MENU', /renderReportsMenu\(\)/.test(dispatch),
       dispatch.trim() + ' — pointing this at one report is how the tab silently goes back to spend-only');
    ck('  and the tab itself still exists', /tabBtn\('report', 'Report'\)/.test(APP));

    await w.renderReportsMenu();
    await new Promise((r) => setTimeout(r, 150));
    const buttons = [...d.querySelectorAll('.rep-open')];
    ck('tapping it opens the MENU, not one report', buttons.length === 4,
       `${buttons.length} buttons — a single report here means the tab still goes straight to spend`);
    ck('  each saying what it is for', buttons.every((b) => b.textContent.trim().length > 20),
       'a menu of bare words makes her open all four to find the one she wants');
    // The whole point of a menu over a stacked page.
    ck('  and nothing is fetched just to draw the menu',
       !/Loading…/.test(d.getElementById('viewRoot').textContent),
       'a stacked page loads every report to answer one question');
}

section('B — opening one, and getting back out');
{
    // Navigates the way a person does: press Back if a report is already
    // open, then pick from the menu.
    //
    // The first version just called renderReportsMenu() — which, with a
    // report still open, re-renders THAT report rather than the menu, so the
    // next button was never found and the body came back empty. The state it
    // needs to reset (reportView) is a top-level `let` and cannot be poked
    // from outside, and that is fine: pressing Back is what she does anyway,
    // and a test that navigates like a person catches things a test that
    // pokes state never will.
    const openBy = async (id) => {
        const back = d.getElementById('repBack');
        if (back) {
            back.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
            await new Promise((r) => setTimeout(r, 100));
        }
        await w.renderReportsMenu();
        await new Promise((r) => setTimeout(r, 80));
        const btn = d.querySelector(`.rep-open[data-rep="${id}"]`);
        if (!btn) return null;
        btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 220));
        return d.getElementById('viewRoot').textContent;
    };

    const sales = await openBy('sales');
    ck('Sales opens — the report the phone never had', /Eccomelt/.test(sales || ''), (sales || '').slice(0, 120));
    ck('  showing the total sold', /840/.test(sales || ''));
    ck('  and the margin where the cost IS linked', /100/.test(sales || ''));
    // The honest part: a buyer with no linked cost must not silently show a
    // margin of zero, which reads as "sold at cost".
    ck('  while a buyer with no linked cost says so',
       /cost not linked/.test(sales || ''),
       'a blank or zero margin there would read as "sold at cost"');

    const back = d.getElementById('repBack');
    ck('  and there is a way back', !!back);
    if (back) {
        back.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 120));
        ck('  which returns to the menu', d.querySelectorAll('.rep-open').length === 4);
    }

    const stock = await openBy('stock');
    ck('Stock on hand opens', /Al combo/.test(stock || ''), (stock || '').slice(0, 120));
    ck('  showing what is LEFT, not what came in', /300/.test(stock || ''),
       '1000 in, 700 out — the number that matters is 300');

    const profit = await openBy('profit');
    ck('Profit opens', /revenue/i.test(profit || ''), (profit || '').slice(0, 140));
    ck('  with margin and cost, not just a total', /500/.test(profit || '') && /340/.test(profit || ''));
    // ── THE PART THAT KEEPS IT HONEST ────────────────────────────────────
    // A margin computed on 71% of sales, shown as if it were the whole
    // business, is the most misleading number this app could produce.
    ck('  and it says how much of the sales the margin covers',
       /71\.4/.test(profit || '') && /not linked/.test(profit || ''),
       'a figure whose reliability is invisible gets trusted completely');
    // The HEADING and the note are two different claims, and asserting them
    // together let a mutation relabel the heading "PROFIT" while the note
    // below still contained the words "NOT profit" — the check passed on the
    // fine print while the big label lied.
    ck('  while the cash block is HEADED as not profit',
       /MONEY IN AND OUT — NOT PROFIT/.test(profit || ''),
       'sold-minus-bought over a month is a cash picture, and a heading that ' +
       'calls it profit is how someone stops buying in a good month');
    ck('  and says why underneath',
       /metal bought this month is usually sold in another/i.test(profit || ''),
       'the heading states the rule; this explains it');
}

section('C — the goods section she asked me to rearrange');
{
    // "make pieces and commoity next to each other in goods section of bol on
    //  app and gross,tare,net should be in same line"
    if (typeof w.renderDocumentsTab === 'function') {
        await w.renderDocumentsTab();
        await new Promise((r) => setTimeout(r, 150));
        const tab = d.querySelector('.doc-subtab-btn[data-subtab="bol"]');
        if (tab) {
            tab.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
            await new Promise((r) => setTimeout(r, 200));
        }
    }
    const row0 = [...d.querySelectorAll('#docBody input[data-bi="0"]')].map((el) => el.dataset.bf);
    ck('the goods row exists', row0.length === 5, JSON.stringify(row0));

    // Asserted on the LAYOUT, by walking the grid each field sits in — the
    // request was about what sits beside what, and a source grep for
    // "grid-template-columns" would pass on any grid at all.
    const fieldOf = (bf) => d.querySelector(`#docBody input[data-bi="0"][data-bf="${bf}"]`);
    const gridOf = (bf) => { const el = fieldOf(bf); return el && el.parentElement; };

    ck('commodity and pieces share a row',
       gridOf('description') && gridOf('description') === gridOf('pieces'),
       'she reads the line as WHAT and HOW MANY together');
    ck('  and gross, tare and net share a row',
       gridOf('gross_weight') && gridOf('gross_weight') === gridOf('tare_weight')
       && gridOf('gross_weight') === gridOf('net_weight'),
       'the order they come off the scale');
    // Sharing a PARENT is not sharing a LINE. Three inputs in a two-column
    // grid have the same parent and wrap onto two rows — which is exactly
    // what she asked me to stop doing, and a mutation halving the columns
    // survived the check above. The claim is about columns, so assert
    // columns.
    ck('  on ONE line — three columns, not three items wrapping',
       /grid-template-columns:\s*repeat\(3,\s*1fr\)/.test(
           (gridOf('gross_weight') || {}).getAttribute ? gridOf('gross_weight').getAttribute('style') || '' : ''),
       (gridOf('gross_weight') || {}).getAttribute ? gridOf('gross_weight').getAttribute('style') : '(no grid)');
    ck('  which is a DIFFERENT row from the commodity',
       gridOf('description') !== gridOf('gross_weight'),
       'all five on one line would be unreadable on a phone');
    ck('  the description box is the widest thing on its row',
       /1fr 78px/.test((gridOf('description') || {}).getAttribute
           ? gridOf('description').getAttribute('style') || '' : ''),
       'an even split leaves the commodity too narrow to read, and a piece ' +
       'count is only two or three characters');
}

ck('nothing threw', errors.length === 0, errors.slice(0, 3).join(' | '));
dom.window.close();

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('\n  THREW:', e.stack || e.message); process.exit(1); });
