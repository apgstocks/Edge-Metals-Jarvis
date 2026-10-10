// ── tests/bank-pager.js ───────────────────────────────────────────────────
// Apsara, 2026-10-11: "So in banks, i will have scrollable div just like
// quickbook with pages na?"
//
// Renders the REAL dashboard/bank-match.html in JSDOM with 130 deposits and
// 60 withdrawals, and drives it the way she would: page through, change rows
// per page, search, switch Money in / Money out, press J past the end of a
// page. Asserts on the DOM, not the source.
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

    section('A — first page, 50 rows, scrolling box');
    ck('money in: 50 of 130 shown', visible(doc, '#list').length === 50, String(visible(doc, '#list').length));
    ck('pager says 1–50 of 130, page 1 of 3', /1–50 of 130/.test(pagerText(doc, 'in')) && /Page 1 of 3/.test(pagerText(doc, 'in')), pagerText(doc, 'in'));
    ck('money out: 50 of 60', visible(doc, '#review').length === 50 && /1–50 of 60/.test(pagerText(doc, 'out')), pagerText(doc, 'out'));
    ck('money-in list scrolls inside its own box', doc.getElementById('list').classList.contains('scrollbox'));
    ck('money-out ROWS scroll, the heading does not', !!doc.querySelector('#review > h2.sec') && !!doc.querySelector('#review #reviewrows.scrollbox')
        && !doc.getElementById('review').classList.contains('scrollbox'));
    ck('Previous and First disabled on page 1', doc.querySelector('[data-pg="in"][data-go="prev"]').disabled && doc.querySelector('[data-pg="in"][data-go="first"]').disabled);

    section('B — paging');
    click(doc, '[data-pg="in"][data-go="next"]');
    let v = visible(doc, '#list');
    ck('page 2 shows rows 51–100', v.length === 50 && v[0].dataset.i === '50' && /51–100 of 130/.test(pagerText(doc, 'in')), `${v[0] && v[0].dataset.i} | ${pagerText(doc, 'in')}`);
    click(doc, '[data-pg="in"][data-go="last"]');
    v = visible(doc, '#list');
    ck('last page shows the remaining 30', v.length === 30 && /101–130 of 130/.test(pagerText(doc, 'in')), pagerText(doc, 'in'));
    ck('Next disabled on the last page', doc.querySelector('[data-pg="in"][data-go="next"]').disabled);
    ck('paging money in did not move money out', /1–50 of 60/.test(pagerText(doc, 'out')), pagerText(doc, 'out'));

    section('C — rows per page, remembered');
    const sel = doc.querySelector('#pager-in [data-pgsize]');
    sel.value = '100'; sel.dispatchEvent(new w.Event('change', { bubbles: true }));
    ck('100 per page, back to page 1', visible(doc, '#list').length === 100 && /1–100 of 130/.test(pagerText(doc, 'in')), pagerText(doc, 'in'));
    ck('both lists use the same size', visible(doc, '#review').length === 60);
    ck('saved for next time', w.localStorage.getItem('bank.pageSize') === '100');
    const dom2 = makeDom(100); await settle();
    ck('a fresh visit opens at 100 per page', visible(dom2.window.document, '#list').length === 100);
    // The pager redraws on every change, so the old <select> is detached now.
    const sel50 = doc.querySelector('#pager-in [data-pgsize]');
    sel50.value = '50'; sel50.dispatchEvent(new w.Event('change', { bubbles: true }));
    ck('back to 50 per page', visible(doc, '#list').length === 50, String(visible(doc, '#list').length));

    section('D — search looks at every page');
    click(doc, '[data-pg="in"][data-go="next"]');
    const q = doc.getElementById('q');
    q.value = 'needle haystack'; q.dispatchEvent(new w.Event('input', { bubbles: true }));
    v = visible(doc, '#list');
    ck('finds the row that lives on page 2', v.length === 1 && /NEEDLE HAYSTACK/.test(v[0].textContent), String(v.length));
    ck('one result: no pager bar', doc.getElementById('pager-in').hidden);
    q.value = ''; q.dispatchEvent(new w.Event('input', { bubbles: true }));
    ck('clearing search returns to page 1 of everything', /1–50 of 130/.test(pagerText(doc, 'in')), pagerText(doc, 'in'));

    section('E — Money in / Money out switch');
    click(doc, '#dir [data-dir="out"]');
    ck('money in hidden, money out paged', doc.getElementById('inblock').hidden && /1–50 of 60/.test(pagerText(doc, 'out')));
    click(doc, '#dir [data-dir="in"]');
    ck('money out and its pager hidden', doc.getElementById('review').hidden && doc.getElementById('pager-out').hidden);
    click(doc, '#dir [data-dir="all"]');

    section('F — J past the end of a page turns it');
    click(doc, '#dir [data-dir="out"]');
    for (let i = 0; i < 50; i++) doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'j', bubbles: true }));
    ck('50 presses reach the last row of page 1', /1–50 of 60/.test(pagerText(doc, 'out')) && visible(doc, '#review')[49].classList.contains('focus'));
    doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'j', bubbles: true }));
    v = visible(doc, '#review');
    ck('one more J opens page 2 on its first row', /51–60 of 60/.test(pagerText(doc, 'out')) && v[0].classList.contains('focus'), pagerText(doc, 'out'));
    doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'k', bubbles: true }));
    ck('K goes back to the last row of page 1', /1–50 of 60/.test(pagerText(doc, 'out')) && visible(doc, '#review')[49].classList.contains('focus'), pagerText(doc, 'out'));

    section('G — a short list has no pager');
    MATCH.rows = MATCH.rows.slice(0, 12); REVIEW.queue.rows = REVIEW.queue.rows.slice(0, 5);
    const dom3 = makeDom(); await settle();
    const d3 = dom3.window.document;
    ck('12 deposits: all shown, no bar', visible(d3, '#list').length === 12 && d3.getElementById('pager-in').hidden);
    ck('5 withdrawals: all shown, no bar', visible(d3, '#review').length === 5 && d3.getElementById('pager-out').hidden);

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILED:\n  ' + failures.join('\n  ')); process.exit(1); }
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
