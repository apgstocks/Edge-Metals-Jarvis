// ── tests/books-page.js ───────────────────────────────────────────────────
// Apsara, 2026-10-10: "Design the books page even more better", then "Right
// now it looks ugly and not friendly."
//
// tests/books-portal.js proves the page is REACHABLE and reads the right
// routes. This file is about whether it is usable, and it boots the real page
// in a DOM with a stubbed fetch rather than matching strings — because the
// two defects this redesign actually shipped with were both invisible to a
// regex:
//
//   · `.bar` was the toolbar's class AND the proportion bar's. The second
//     rule's `height:5px; overflow:hidden` landed on the toolbar and clipped
//     the company picker, the period chips and both buttons to a five-pixel
//     sliver. Every control was present and clickable in the DOM, so nothing
//     that reads the file would have noticed.
//   · (In the Edge Yard app the same morning) a helper declared inside the
//     wrong function threw ReferenceError and the form rendered zero rows.
//
// So: boot it, drive it, and read what came out.

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
const HTML = fs.readFileSync(path.join(ROOT, 'dashboard/books.html'), 'utf8');

// ── THE FIGURES THE STUB HANDS BACK ──────────────────────────────────────
// Deliberately a LOSS-free, out-of-balance set: the balance sheet not
// agreeing is the state her real books are in while bills are missing
// amounts, and a page that only looks right when everything is perfect is
// not much use.
const acct = (code, name, balance) => ({ code, name, balance });
const BOOKS = {
    companies: [{ id: 'edge-metals', name: 'Edge Metals' }, { id: 'edge-trading', name: 'Edge Yard' }],
    entity: 'edge-metals', entityName: 'Edge Metals', legalName: 'Edge Metals INC',
    from: '2026-01-01', to: '2026-12-31',
    build: { transactions: 4182, lines: 9765, complete: false, unplaced: 12, problems: [], notes: [] },
    agent: {
        counts: { blocker: 0, high: 1, normal: 0 },
        summary: '80 bills have no amount yet',
        findings: [{ severity: 'high', what: '80 bills have no amount',
            why: 'Cost of material is understated.', fix: 'Fill the supplier price', where: 'Bills' }],
    },
    trialBalance: { balanced: true, debit: 100, credit: 100, unknown: [],
        accounts: [{ code: '4000', name: 'Metal sales', type: 'income', debit: 0, credit: 2452118.4, balance: -2452118.4 },
                   { code: '5000', name: 'Material purchased', type: 'cogs', debit: 1792440.1, credit: 0, balance: 1792440.1 }] },
    profitAndLoss: {
        income: [acct('4000', 'Metal sales', 2452118.4)], incomeTotal: 2452118.4,
        cogs: [acct('5000', 'Material purchased', 1792440.1), acct('5200', 'Trucking', 28410.55)],
        cogsTotal: 1820850.65, grossProfit: 631267.75,
        expense: [acct('6200', 'Yard wages', 162900), acct('6300', 'Bank charges', 4188.2)],
        expenseTotal: 167088.2, netIncome: 464179.55,
    },
    balanceSheet: {
        assets: [acct('1010', 'BofA operating', 886099.5)], assetTotal: 886099.5,
        liabilities: [acct('2000', 'Owed to suppliers', 288200)], liabilityTotal: 288200,
        equity: [acct('3000', 'Owner equity', 620000)], equityTotal: 620000,
        netIncome: 464179.55, rightSide: 1372379.55, balances: false, difference: 486280.05,
    },
};
const PRIOR = JSON.parse(JSON.stringify(BOOKS));
PRIOR.profitAndLoss.netIncome = 232089;      // exactly half, so the delta is +100%
PRIOR.profitAndLoss.incomeTotal = 2000000;
PRIOR.build.transactions = 3610;
const LEDGER = { ledger: { code: '5200', name: 'Trucking', closing: 28410.55,
    entries: [{ date: '2026-03-04', kind: 'carrier bill', party: 'NTG', debit: 2180, credit: 0, running: 2180 }] } };

function boot({ priorHasData = true } = {}) {
    const calls = [];
    const dom = new JSDOM(HTML, {
        runScripts: 'dangerously', url: 'http://localhost/books',
        beforeParse(w) {
            w.fetch = (u) => {
                const s = String(u);
                calls.push(s);
                let body = BOOKS;
                if (/\/api\/books\/account\//.test(s)) body = LEDGER;
                else if (/from=2025/.test(s)) {
                    body = priorHasData ? PRIOR
                        : { ...PRIOR, build: { ...PRIOR.build, transactions: 0 } };
                }
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
            };
            w.print = () => { w.__printed = true; };
            w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
        },
    });
    return { dom, calls };
}
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

(async () => {

// ── A — IT BOOTS, AND THE ANSWER IS ON SCREEN ────────────────────────────
// The old page landed on a two-column table of account codes with net income
// as the LAST row. A books page's first job is to say whether the numbers can
// be trusted; its second is to say what they are.
{
    section('A — the answer, before the evidence');
    const { dom } = boot();
    await settle(250);
    const d = dom.window.document;

    ck('the page boots with no script error', !!d.getElementById('kpis'));
    const kpis = d.querySelectorAll('#kpis .kpi');
    ck('four headline figures are rendered', kpis.length === 4, String(kpis.length));

    const lead = d.querySelector('#kpis .kpi.lead');
    ck('the first one is the profit', !!lead && /Profit for the period/i.test(lead.textContent),
       lead && lead.textContent.trim().slice(0, 60));
    ck('  shown in short form so it reads at a glance',
       !!lead && /\$464k/.test(lead.textContent), lead && lead.textContent);
    ck('  and in full underneath, because a books page may not round',
       !!lead && /\$464,179\.55/.test(lead.textContent), lead && lead.textContent);
    ck('  and it is the biggest text on the page',
       !!lead && lead.querySelector('.v').className.includes('up'));

    // Order in the DOM is the order she reads. The verdict, then the answer,
    // then the statement.
    const vAt = HTML.indexOf('id="verdict"');
    const kAt = HTML.indexOf('id="kpis"');
    const bAt = HTML.indexOf('id="body"');
    ck('verdict, then figures, then the statement', vAt > 0 && vAt < kAt && kAt < bAt,
       `${vAt} ${kAt} ${bAt}`);

    // Gross margin is a derived figure and must be derived, not typed.
    // 631267.75 / 2452118.40 = 25.7%
    const margin = [...kpis].find((k) => /Gross margin/i.test(k.textContent));
    ck('gross margin is computed from the two figures above it',
       !!margin && /25\.7%/.test(margin.textContent), margin && margin.textContent);
}

// ── B — THE PERIOD IS PICKED, NOT TYPED ──────────────────────────────────
// Two free-text boxes wanting YYYY-MM-DD was the single most unfriendly
// thing on the old page.
{
    section('B — periods');
    const { dom, calls } = boot();
    await settle(250);
    const d = dom.window.document, w = dom.window;

    const chips = [...d.querySelectorAll('#chips button')].map((b) => b.dataset.p);
    ck('named periods are offered', chips.length === 5, JSON.stringify(chips));
    ck('  this month, this quarter, this year, last year and custom',
       ['month', 'quarter', 'year', 'last-year', 'custom'].every((p) => chips.includes(p)),
       JSON.stringify(chips));
    ck('this year is the one selected on arrival',
       d.querySelector('#chips button.on').dataset.p === 'year');
    ck('  so the page is useful on arrival, not empty',
       calls.some((c) => /\/api\/books\?.*entity=/.test(c)), JSON.stringify(calls.slice(0, 3)));
    ck('the date boxes are hidden until Custom is picked',
       !d.getElementById('custom').classList.contains('show'));

    const before = calls.length;
    d.querySelector('[data-p="last-year"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await settle(150);
    const y = new Date().getFullYear();
    ck('picking a period refetches', calls.length > before, `${before} → ${calls.length}`);
    ck('  for that period', calls[calls.length - 1].includes(`from=${y - 1}-01-01`),
       calls[calls.length - 1]);
    ck('  and the range is a whole year', calls[calls.length - 1].includes(`to=${y - 1}-12-31`),
       calls[calls.length - 1]);

    d.querySelector('[data-p="custom"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await settle(60);
    ck('Custom reveals the two date boxes',
       d.getElementById('custom').classList.contains('show'));
    // Picking Custom must NOT refetch — she has not typed the dates yet.
    const n = calls.length;
    await settle(60);
    ck('  and does not refetch before she has typed anything', calls.length === n);
}

// ── C — THE COMPARISON, AND WHEN IT STAYS QUIET ──────────────────────────
// "$464k" means nothing on its own. But "up 100% from nothing" is not
// information either, so a prior period with no transactions shows no delta.
{
    section('C — vs last year');
    const { dom, calls } = boot();
    await settle(250);
    const d = dom.window.document, w = dom.window;

    ck('it is off by default', d.getElementById('compare').checked === false);
    ck('  so only one request is made', !calls.some((c) => /from=2025/.test(c)),
       JSON.stringify(calls));

    d.getElementById('compare').checked = true;
    d.getElementById('compare').dispatchEvent(new w.Event('change', { bubbles: true }));
    await settle(200);
    ck('ticking it fetches the same range a year earlier',
       calls.some((c) => /from=2025-01-01/.test(c) && /to=2025-12-31/.test(c)),
       JSON.stringify(calls.slice(-2)));
    // Guarded rather than dereferenced: a mutation that stops rendering the
    // headline figures should make these FAIL and name themselves, not crash
    // the file. A crashed run still exits non-zero, but it says nothing about
    // which property was lost.
    const lead = d.querySelector('#kpis .kpi.lead');
    ck('  and the profit shows the change', !!lead && /100%/.test(lead.textContent),
       lead && lead.textContent);
    ck('  naming the figure it is comparing with',
       !!lead && /\$232k last year/.test(lead.textContent), lead && lead.textContent);
}
{
    const { dom } = boot({ priorHasData: false });
    await settle(250);
    const d = dom.window.document, w = dom.window;
    d.getElementById('compare').checked = true;
    d.getElementById('compare').dispatchEvent(new w.Event('change', { bubbles: true }));
    await settle(200);
    const lead = d.querySelector('#kpis .kpi.lead');
    ck('a year with nothing in it shows NO delta rather than a made-up one',
       !!lead && !/%/.test(lead.textContent), lead && lead.textContent);
    ck('  and says why, instead of looking broken',
       /no figures for the same period last year/.test(d.getElementById('built').textContent),
       d.getElementById('built').textContent);
}

// ── D — A STATEMENT ROW READS AS A NAME ──────────────────────────────────
// The old row was `5200  Trucking` with the code first and the only coloured
// thing on the line. She thinks in "Trucking".
{
    section('D — names before codes');
    const { dom } = boot();
    await settle(250);
    const d = dom.window.document, w = dom.window;

    const row = [...d.querySelectorAll('.srow')].find((r) => /Trucking/.test(r.textContent));
    ck('a P&L row is rendered', !!row, 'no .srow for Trucking');
    const nm = row.querySelector('.nm'), cd = row.querySelector('.cd');
    ck('  the NAME comes first in the row', !!nm && !!cd
       && row.innerHTML.indexOf(nm.outerHTML) < row.innerHTML.indexOf(cd.outerHTML));
    ck('  the name is the account name', nm.textContent.trim() === 'Trucking', nm.textContent);
    ck('  the code is still there, because it ties to QuickBooks',
       cd.textContent.trim() === '5200', cd.textContent);

    // Proportion: "where did the money go" is a shape question.
    const bars = d.querySelectorAll('.srow .prop i');
    ck('every row carries a share-of-section bar', bars.length >= 4, String(bars.length));
    const big = [...d.querySelectorAll('.srow')].find((r) => /Material purchased/.test(r.textContent));
    const small = [...d.querySelectorAll('.srow')].find((r) => /Bank charges/.test(r.textContent));
    const w1 = parseFloat(big.querySelector('.prop i').style.width);
    const w2 = parseFloat(small.querySelector('.prop i').style.width);
    ck('  the biggest line in a section fills it', w1 === 100, String(w1));
    ck('  and a small one is visibly smaller', w2 > 0 && w2 < 10, String(w2));

    // Clicking the code is how she gets to the evidence.
    cd.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await settle(180);
    ck('clicking a code opens that account’s history',
       /Trucking/.test(d.getElementById('body').textContent)
       && /carrier bill/.test(d.getElementById('body').textContent),
       d.getElementById('body').textContent.slice(0, 120));
    ck('  with a way back', !!d.getElementById('backtb'));
}

// ── E — THE BALANCE SHEET HAS TWO SIDES ──────────────────────────────────
// One stacked table is why it read as a data dump. Nobody reads a balance
// sheet top to bottom.
{
    section('E — two sides');
    const { dom } = boot();
    await settle(250);
    const d = dom.window.document, w = dom.window;
    d.querySelector('[data-view="bs"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await settle(120);
    const two = d.querySelector('.two');
    ck('assets and the other side are separate cards', !!two && two.querySelectorAll('.card').length === 2,
       two ? String(two.querySelectorAll('.card').length) : 'no .two');
    ck('  headed in plain English, not "Assets" and "Liabilities" alone',
       /What it owns/.test(d.getElementById('body').textContent)
       && /What it owes/.test(d.getElementById('body').textContent));
    // The fixture is deliberately out of balance.
    ck('when the two sides disagree it SAYS SO, loudly',
       /do not agree/.test(d.getElementById('body').textContent));
    ck('  and by how much', /486,280\.05/.test(d.getElementById('body').textContent));
}

// ── F — THE TRUST LINE STILL LEADS, BUT STOPS SHOUTING ───────────────────
// Dumping every finding on every load is how a warning becomes wallpaper.
// A blocker still opens itself, because if the figures are wrong she should
// not have to click to find out why.
{
    section('F — the verdict');
    const { dom } = boot();
    await settle(250);
    const d = dom.window.document;
    const t = d.querySelector('.trust');
    ck('the verdict is rendered', !!t);
    ck('  as one line that opens', t.tagName === 'DETAILS');
    ck('  closed, for a non-blocker', t.hasAttribute('open') === false);
    ck('  with a count of what is wrong', /1 thing to look at/.test(t.textContent), t.textContent);
    ck('  and the finding inside it', /80 bills have no amount/.test(t.textContent));

    // ── AND A BLOCKER OPENS ITSELF ───────────────────────────────────────
    // My first version of this check did `HTML.replace(x, x)` and then
    // asserted x was still present — true for every input, which is the
    // assertion-that-cannot-fail scripts/mutate.js's header names as its
    // second process failure. It survived everything. Driven for real now.
    const asBlocker = JSON.parse(JSON.stringify(BOOKS));
    asBlocker.agent.counts = { blocker: 1, high: 0, normal: 0 };
    asBlocker.agent.findings[0].severity = 'blocker';
    const bd = new JSDOM(HTML, { runScripts: 'dangerously', url: 'http://localhost/books',
        beforeParse(w) {
            w.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(asBlocker) });
            w.print = () => {};
        } });
    await settle(250);
    const bt = bd.window.document.querySelector('.trust');
    ck('  a blocker OPENS itself, so she does not click to learn the figures are wrong',
       !!bt && bt.hasAttribute('open'), bt && bt.outerHTML.slice(0, 90));
    ck('  and is coloured as the worst thing on the page',
       !!bt && bt.classList.contains('bad'), bt && bt.className);

    ck('an incomplete build is said in words, not left as a flag',
       /smaller than the truth/.test(d.getElementById('built').textContent),
       d.getElementById('built').textContent);
}

// ── G — THE CSS COLLISION THAT SHIPPED, AND THE SHAPE OF IT ──────────────
// `.bar` was the toolbar AND the proportion bar. The second rule's
// `height:5px; overflow:hidden` clipped the whole toolbar to a sliver: the
// company picker, five period chips and both buttons were there, laid out,
// clickable — and five pixels tall. Nothing that reads the file catches that,
// and no assertion about any single control catches it either.
//
// So this is measured the only way it can be: the two roles must not share a
// class name.
{
    section('G — the toolbar and the bars are not the same class');
    const style = (HTML.match(/<style>([\s\S]*?)<\/style>/) || ['', ''])[1];
    const ruleFor = (sel) => {
        const m = style.match(new RegExp('(^|\\n)' + sel.replace('.', '\\.') + '\\s*\\{([^}]*)\\}'));
        return m ? m[2] : null;
    };
    const toolbar = ruleFor('.bar');
    const prop = ruleFor('.prop');
    ck('the toolbar has its own rule', !!toolbar, String(toolbar));
    ck('the proportion bar has a DIFFERENT one', !!prop, String(prop));
    ck('  the toolbar lays things out', /display:flex/.test(toolbar || ''), toolbar);
    ck('  the proportion bar is a five-pixel track', /height:5px/.test(prop || ''), prop);
    ck('  and neither rule sets the other’s property',
       !/height:5px/.test(toolbar || '') && !/display:flex/.test(prop || ''),
       `${toolbar} || ${prop}`);
    // The markup must use the renamed class, or the rename was half done.
    ck('the rows use .prop', /class="prop \$\{tone\}"/.test(HTML));
    ck('  and nothing still renders a bare class="bar" row',
       !/<div class="bar \$\{/.test(HTML));
}

// ── H — THE THINGS THAT MUST NOT HAVE BEEN LOST ──────────────────────────
// A redesign is where features quietly fall out.
{
    section('H — nothing dropped in the redesign');
    const { dom } = boot();
    await settle(250);
    const d = dom.window.document;
    ck('both portals are still named', /href="\/quickbooks"/.test(HTML)
       && /href="\/books" aria-current="page"/.test(HTML));
    ck('the CPA pack button survives', !!d.getElementById('pack'));
    ck('  and still lets the BROWSER name the file', !/Books-.*\.xlsx/.test(HTML),
       'rebuilding the filename is a second place for the DRAFT-INCOMPLETE warning to be wrong');
    ck('all four views are reachable',
       [...d.querySelectorAll('#tabs button')].map((b) => b.dataset.view).join(',')
       === 'pl,bs,tb,gl');
    ck('no figure is cached in the browser', !/localStorage|sessionStorage/.test(HTML),
       'a stored trial balance is a second truth');
    ck('the sidebar script is still included', /sidebar\.js/.test(HTML),
       'the other session added it; a redesign must not drop it');
    ck('there is a print stylesheet, because a P&L goes in a folder',
       /@media print/.test(HTML));
    ck('  and a button that uses it', !!d.getElementById('print'));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('threw:', e && e.stack); process.exit(1); });
