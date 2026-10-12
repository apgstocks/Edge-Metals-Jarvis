// ── tests/bank-pager.js ───────────────────────────────────────────────────
// Apsara, 2026-10-11: "So in banks, i will have scrollable div just like
// quickbook with pages na?"
//
// 2026-10-11, next message: "Inside all, everything should be there. not
// segmented by money in and money out. just datewise" — so deposits and
// withdrawals are ONE list, newest first, paged together.
//
// Renders the REAL dashboard/bank-match.html in JSDOM with 130 deposits and
// 60 withdrawals, and drives it the way she would. Asserts on the DOM.
//
// The rule that matters most: search and the in/out switch look at EVERY
// transaction, and pages are cut from what matched. A search must never say
// "nothing" for a row that is merely on page 3.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0; const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');
const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'dashboard/bank-match.html'), 'utf8');

const day = (i) => `2026-09-${String(1 + (i % 28)).padStart(2, '0')}`;
const MATCH = {
    rows: Array.from({ length: 130 }, (_, i) => ({
        deposit: { id: 'IN-' + i, date: day(i), amount: 1000 + i, descriptor: i === 97 ? 'WIRE IN NEEDLE HAYSTACK' : 'WIRE IN CUSTOMER ' + i },
        party: 'Customer ' + i, outcome: 'no_party', ambiguous: false, proposals: [],
    })),
    feed: 'plaid', ledger: {},
};
const REVIEW = {
    queue: {
        rows: Array.from({ length: 60 }, (_, i) => ({ id: 'OUT-' + i, direction: 'out', state: 'none',
            date: day(i), amount: 500 + i, descriptor: 'PAYMENT TO SUPPLIER ' + i, label: '' })),
        counts: {}, canPostAll: 0,
    },
};

function makeDom(store) {
    return new JSDOM(HTML, {
        runScripts: 'dangerously', url: 'https://localhost/bank-match', pretendToBeVisual: true,
        beforeParse: (w) => {
            if (store) w.localStorage.setItem('bank.pageSize', String(store));
            w.HTMLElement.prototype.scrollIntoView = function () {};
            w.fetch = async (url) => {
                const u = String(url);
                if (u.startsWith('/api/bank/match')) return { ok: true, json: async () => MATCH };
                if (u.startsWith('/api/bank/review')) return { ok: true, json: async () => REVIEW };
                return { ok: true, json: async () => ({ ok: true }) };
            };
        },
    });
}
const settle = () => new Promise((r) => setTimeout(r, 60));
const visible = (doc, sel) => [...doc.querySelectorAll(`${sel} .card[data-dir]`)].filter((c) => !c.hidden);
const pagerText = (doc, k) => (doc.getElementById('pager-' + k) || {}).textContent || '';
const click = (doc, sel) => { const b = doc.querySelector(sel); b.click(); return b; };

(async () => {
    const dom = makeDom(); await settle();
    const w = dom.window, doc = w.document;
    const all = () => [...doc.querySelectorAll('#list .card[data-dir]')];

    section('A — one list, by date, newest first');
    ck('both kinds are in the one list: 190 rows', all().length === 190, String(all().length));
    const dates = all().map((c) => c.dataset.date);
    ck('in date order, newest first', dates.every((d, i) => i === 0 || dates[i - 1] >= d), dates.slice(0, 6).join(' '));
    const top = all().slice(0, 12).map((c) => c.dataset.dir);
    ck('deposits and withdrawals are interleaved, not grouped', top.includes('in') && top.includes('out'), top.join(','));
    ck('no separate Money out list or pager', !doc.getElementById('pager-out') && !doc.querySelector('#review .card[data-dir]'));
    ck('heading counts everything: 190', doc.getElementById('n-in').textContent === '190', doc.getElementById('n-in').textContent);
    ck('the list scrolls inside its own box', doc.getElementById('list').classList.contains('scrollbox'));

    section('B — one pager over all of it');
    ck('50 of 190 shown, page 1 of 4', visible(doc, '#list').length === 50 && /1–50 of 190/.test(pagerText(doc, 'in')) && /Page 1 of 4/.test(pagerText(doc, 'in')), pagerText(doc, 'in'));
    click(doc, '[data-pg="in"][data-go="next"]');
    ck('page 2: 51–100', /51–100 of 190/.test(pagerText(doc, 'in')) && visible(doc, '#list').length === 50, pagerText(doc, 'in'));
    click(doc, '[data-pg="in"][data-go="last"]');
    ck('last page: the remaining 40', /151–190 of 190/.test(pagerText(doc, 'in')) && visible(doc, '#list').length === 40, pagerText(doc, 'in'));
    ck('Next disabled on the last page', doc.querySelector('[data-pg="in"][data-go="next"]').disabled);

    section('C — rows per page, remembered');
    let sel = doc.querySelector('#pager-in [data-pgsize]');
    sel.value = '100'; sel.dispatchEvent(new w.Event('change', { bubbles: true }));
    ck('100 per page, back to page 1', visible(doc, '#list').length === 100 && /1–100 of 190/.test(pagerText(doc, 'in')), pagerText(doc, 'in'));
    ck('saved for next time', w.localStorage.getItem('bank.pageSize') === '100');
    const dom2 = makeDom(100); await settle();
    ck('a fresh visit opens at 100 per page', visible(dom2.window.document, '#list').length === 100);
    sel = doc.querySelector('#pager-in [data-pgsize]');     // the pager redraws; the old <select> is detached
    sel.value = '50'; sel.dispatchEvent(new w.Event('change', { bubbles: true }));
    ck('back to 50 per page', visible(doc, '#list').length === 50);

    section('D — search looks at every page');
    click(doc, '[data-pg="in"][data-go="next"]');
    const q = doc.getElementById('q');
    q.value = 'needle haystack'; q.dispatchEvent(new w.Event('input', { bubbles: true }));
    let v = visible(doc, '#list');
    ck('finds a row that is not on the page being shown', v.length === 1 && /NEEDLE HAYSTACK/.test(v[0].textContent), String(v.length));
    q.value = 'supplier 59'; q.dispatchEvent(new w.Event('input', { bubbles: true }));
    v = visible(doc, '#list');
    ck('a withdrawal is found the same way', v.length === 1 && v[0].dataset.dir === 'out', String(v.length));
    q.value = ''; q.dispatchEvent(new w.Event('input', { bubbles: true }));
    ck('clearing search: page 1 of everything', /1–50 of 190/.test(pagerText(doc, 'in')), pagerText(doc, 'in'));

    section('E — Money in / Money out filter the one list');
    click(doc, '#dir [data-dir="out"]');
    ck('Money out: 60 withdrawals, still by date', /1–50 of 60/.test(pagerText(doc, 'in')) && visible(doc, '#list').every((c) => c.dataset.dir === 'out'), pagerText(doc, 'in'));
    ck('  the deposits bar is hidden', doc.getElementById('sure').hidden);
    click(doc, '#dir [data-dir="in"]');
    ck('Money in: 130 deposits', /1–50 of 130/.test(pagerText(doc, 'in')) && visible(doc, '#list').every((c) => c.dataset.dir === 'in'), pagerText(doc, 'in'));
    ck('  the withdrawals bar is hidden', doc.getElementById('review').hidden);
    click(doc, '#dir [data-dir="all"]');
    ck('All: back to 190', /1–50 of 190/.test(pagerText(doc, 'in')), pagerText(doc, 'in'));

    section('F — J past the end of a page turns it');
    for (let i = 0; i < 50; i++) doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'j', bubbles: true }));
    ck('50 presses reach the last row of page 1', /1–50 of 190/.test(pagerText(doc, 'in')) && visible(doc, '#list')[49].classList.contains('focus'));
    doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'j', bubbles: true }));
    ck('one more J opens page 2 on its first row', /51–100 of 190/.test(pagerText(doc, 'in')) && visible(doc, '#list')[0].classList.contains('focus'), pagerText(doc, 'in'));
    doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'k', bubbles: true }));
    ck('K goes back to the last row of page 1', /1–50 of 190/.test(pagerText(doc, 'in')) && visible(doc, '#list')[49].classList.contains('focus'), pagerText(doc, 'in'));

    section('G — a short list has no pager; an empty one says so');
    MATCH.rows = MATCH.rows.slice(0, 12); REVIEW.queue.rows = REVIEW.queue.rows.slice(0, 5);
    const dom3 = makeDom(); await settle();
    const d3 = dom3.window.document;
    ck('17 rows: all shown, no bar', visible(d3, '#list').length === 17 && d3.getElementById('pager-in').hidden);
    MATCH.rows = []; REVIEW.queue.rows = [];
    const dom4 = makeDom(); await settle();
    ck('nothing at all: the empty message, no bar', !!dom4.window.document.querySelector('#list .empty') && dom4.window.document.getElementById('pager-in').hidden);
    MATCH.rows = []; REVIEW.queue.rows = Array.from({ length: 3 }, (_, i) => ({ id: 'O' + i, direction: 'out', state: 'none', date: day(i), amount: 10, descriptor: 'X' + i, label: '' }));
    const dom5 = makeDom(); await settle();
    const d5 = dom5.window.document;
    ck('only withdrawals: they show, and no "no deposits" message', visible(d5, '#list').length === 3 && !d5.querySelector('#list .empty'));

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILED:\n  ' + failures.join('\n  ')); process.exit(1); }
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
