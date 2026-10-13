// ── tests/workspace.js ────────────────────────────────────────────────────
// Apsara, 2026-10-14: "a separate page for quickbook exclusively mimicing
// quickbook but better ... where i can post/match transactions, take report".
//
// The page is a second VIEW over the Bank and Books routes — it owns no data
// and no rules. So the checks that matter are:
//   · it sends every action to the route the Bank page uses, with the body
//     that route expects (a Post that skips the preview books blind)
//   · it can only ever call the routes it was built on (never QuickBooks)
//   · what it shows is escaped (descriptions are her bank's words)
//   · a refusal stops a bulk action instead of ploughing on
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0; const failures = [];
const ck = (l, ok, d) => { if (ok) { pass += 1; console.log('  PASS  ' + l); } else { fail += 1; failures.push(l); console.log('  FAIL  ' + l); if (d) console.log('        ' + d); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const ROOT = path.join(__dirname, '..');
const { JSDOM } = require('jsdom');
const HTML = fs.readFileSync(path.join(ROOT, 'dashboard/workspace.html'), 'utf8');
const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));

const LONG = 'FMC MetalWIRE TYPE:WIRE IN DATE: 261009 PMT DET:3119 47 INV 260905-ME-SC';
const RESP = () => ({
    '/api/bank/review': { queue: { rows: [
        { id: 'W1', direction: 'out', date: '2026-10-06', amount: 1200, descriptor: 'Hugo <b>Metals</b>', state: 'match', label: 'Match', why: 'matches a recorded payment to the cent', bank_text: 'ACH HUGO METALS INV 12 REF 77' },
        { id: 'W2', direction: 'out', date: '2026-10-05', amount: 5, descriptor: 'External transfer fee', state: 'add', label: 'Bank fee', why: 'nothing recorded matches this', categorise: { suggested: '6200' }, bank_text: 'External transfer fee - Next Day' },
        { id: 'W3', direction: 'out', date: '2026-10-03', amount: 300, descriptor: 'Unknown', state: 'ask', label: 'Tell Jarvis what this is', why: 'nothing matches', categorise: { suggested: '' } },
        { id: 'W4', direction: 'out', date: '2026-10-02', amount: 80, descriptor: 'Another sure one', state: 'match', label: 'Match', why: 'to the cent' }], counts: {} }, banks: [] },
    '/api/bank/match': { rows: [
        { deposit: { id: 'D1', date: '2026-10-09', amount: 18000, descriptor: 'FMC Metal', desc: LONG, memo: LONG }, party: 'FMC Metal', ambiguous: false,
          proposals: [{ allocations: [], reasons: ['one invoice, to the cent'] }] }] },
    '/api/bank/review/categorised': { entries: [{ id: 'BE1', bank_row_id: 'P1', date: '2026-10-01', amount: 40, account: '6200', account_name: 'Bank charges', entity: 'edge-metals', descriptor: 'Wire fee', note: null }] },
    '/api/bank/set-aside': { count: 1, money: 15, rows: [{ id: 'X1', date: '2026-10-04', desc: 'OWNER <i>draw</i>', amount: 15, direction: 'out', reason: 'owner draw', company: 'edge-metals' }] },
    '/api/bank/review/categories': { categories: [{ code: '6200', name: 'Bank charges', type: 'expense' }, { code: '6900', name: 'Other', type: 'expense' }], companies: [{ id: 'edge-metals', name: 'Edge Metals' }] },
    '/api/books': { companies: [{ id: 'edge-metals', uiName: 'Edge Metals' }, { id: 'edge-trading', uiName: 'Edge Yard' }], needs_entity: true, accounts: [{ code: '4000', name: 'Sales' }, { code: '6200', name: 'Bank charges' }] },
    '/api/books/account/6200': { ledger: { entity: 'edge-metals', account: '6200', name: 'Bank charges', type: 'expense', debit: 45, credit: 0, closing: 45,
        entries: [{ date: '2026-10-01', kind: 'bank-entry', party: 'Wire fee', memo: 'm1', debit: 40, credit: 0, balance: 40 }, { date: '2026-10-05', kind: 'bank-entry', party: 'Ext fee <i>x</i>', memo: '', debit: 5, credit: 0, balance: 45 }] } },
});

async function boot(over = {}) {
    const resp = Object.assign(RESP(), over.resp || {});
    const calls = [], posts = [];
    let confirmAnswer = true;
    const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'https://localhost/workspace', beforeParse: (w) => {
        w.fetch = async (u, o) => {
            const url = String(u), k = url.split('?')[0];
            calls.push({ url, method: (o && o.method) || 'GET' });
            if (o && o.body) {
                const body = JSON.parse(o.body); posts.push({ url: k, body });
                if (over.post) { const r = over.post(k, body); if (r) return r; }
                if (k === '/api/bank/review/categorise' && body.preview) return { ok: true, json: async () => ({ ok: true, effect: 'Dr 6200 Bank charges 5.00 / Cr 1010 bank 5.00', problems: [] }) };
                return { ok: true, json: async () => ({ ok: true, matched: 1 }) };
            }
            return { ok: !!resp[k], status: resp[k] ? 200 : 404, json: async () => resp[k] || { error: 'no such route ' + k } };
        };
        w.confirm = () => confirmAnswer;
        w.scrollTo = () => {};
    } });
    await wait(80);
    return { dom, d: dom.window.document, w: dom.window, calls, posts, setConfirm: (v) => { confirmAnswer = v; } };
}
const sel = (d, s) => [...d.querySelectorAll(s)];

(async () => {
{
    section('A — For review: one grid, both directions');
    const { d } = await boot();
    const rows = sel(d, '#banking .rowwrap');
    ck('every withdrawal AND deposit is a line', rows.length === 5, String(rows.length));
    ck('  newest first', rows[0].dataset.id === 'D1' && rows[rows.length - 1].dataset.id === 'W4', rows.map((r) => r.dataset.id).join());
    ck('  the tab shows the count', d.getElementById('n-review').textContent === '5');
    ck('  collapsed by default', rows.every((r) => !r.classList.contains('open')));
    const w1 = d.querySelector('[data-id="W1"]');
    ck('a sure withdrawal has a Match button', !!w1.querySelector('[data-match="W1"]'));
    ck('  a deposit has NO Match button (receipts are confirmed on the Bank page)', !d.querySelector('[data-id="D1"] [data-match]'));
    const dl = d.querySelector('[data-id="D1"] a.btn');
    ck('  but links to the Bank page for Confirm', !!dl && dl.getAttribute('href') === '/bank-match');
    ck('bank text the description does not already show is in the opened row, in full',
       /47 INV 260905-ME-SC/.test(d.querySelector('[data-id="D1"] .bank-says').textContent));
    ck('her bank\'s words are escaped', !w1.querySelector('.desc b') && /<b>Metals<\/b>/.test(w1.querySelector('.desc').textContent), w1.querySelector('.desc').innerHTML);
    ck('a row that needs a category carries the dropdown, suggestion preselected',
       d.querySelector('[data-id="W2"] [data-cat-sel]').value === '6200' && d.querySelector('[data-id="W3"] [data-cat-sel]').value === '');
    ck('  a sure match does not (nothing to categorise)', !d.querySelector('[data-id="W1"] [data-cat]'));
    d.querySelector('[data-id="W3"] .line').click();
    ck('clicking the line opens it', d.querySelector('[data-id="W3"]').classList.contains('open'));
}
{
    section('B — Post goes through the preview, then the route the Bank page uses');
    const { d, posts, setConfirm } = await boot();
    const box = d.querySelector('[data-id="W2"] [data-cat]');
    box.querySelector('[data-cat-sel]').dispatchEvent(new (d.defaultView.Event)('change', { bubbles: true }));
    await wait();
    ck('choosing a category asks the server what Post would book (preview)',
       posts.some((p) => p.url === '/api/bank/review/categorise' && p.body.preview === true && p.body.id === 'W2' && p.body.account === '6200'), JSON.stringify(posts));
    ck('  and shows the effect, and says nothing goes to QuickBooks', /Dr 6200/.test(box.querySelector('[data-cat-effect]').textContent) && /nothing goes to QuickBooks/.test(box.querySelector('[data-cat-effect]').textContent));
    posts.length = 0;
    setConfirm(false);
    box.querySelector('[data-cat-post]').click(); await wait();
    ck('declining the confirm books nothing', !posts.some((p) => p.url === '/api/bank/review/categorise' && !p.body.preview));
    setConfirm(true);
    box.querySelector('[data-cat-post]').click(); await wait();
    const real = posts.find((p) => p.url === '/api/bank/review/categorise' && !p.body.preview);
    ck('confirming posts the real thing once', !!real && real.body.id === 'W2' && real.body.account === '6200', JSON.stringify(posts));
}
{
    section('C — Match, Exclude, Put back, Undo');
    const { d, posts } = await boot();
    d.querySelector('[data-match="W1"]').click(); await wait();
    ck('Match posts the row id to /api/bank/review/match', posts.some((p) => p.url === '/api/bank/review/match' && p.body.id === 'W1'));
    posts.length = 0;
    const ex = d.querySelector('[data-id="W3"] [data-excl-go]');
    ex.click(); await wait();
    ck('Exclude with no reason is refused on the page (nothing sent)', posts.length === 0);
    ck('  and says why', !!d.querySelector('.toast.bad') && /why/i.test(d.querySelector('.toast.bad').textContent));
    d.querySelector('[data-id="W3"] [data-excl-why]').value = 'card fee';
    ex.click(); await wait();
    ck('Exclude with a reason posts id and reason', posts.some((p) => p.url === '/api/bank/exclude' && p.body.id === 'W3' && p.body.reason === 'card fee'), JSON.stringify(posts));
    posts.length = 0;
    d.querySelector('[data-sub="aside"]').click();
    ck('Excluded tab lists what was set aside, escaped', /OWNER/.test(d.getElementById('banking').textContent) && !d.querySelector('#banking i'));
    d.querySelector('[data-include="X1"]').click(); await wait();
    ck('Put back posts to /api/bank/include', posts.some((p) => p.url === '/api/bank/include' && p.body.id === 'X1'));
    d.querySelector('[data-sub="posted"]').click();
    ck('Categorised tab shows what was booked and where', /6200/.test(d.getElementById('banking').textContent) && /Bank charges/.test(d.getElementById('banking').textContent));
    posts.length = 0;
    d.querySelector('[data-uncat="P1"]').click(); await wait();
    ck('Undo posts the BANK ROW id to the undo route', posts.some((p) => p.url === '/api/bank/review/categorise/undo' && p.body.id === 'P1'), JSON.stringify(posts));
}
{
    section('D — selecting several, and a refusal stops the batch');
    let n = 0;
    const { d, posts } = await boot({ post: (k) => { if (k === '/api/bank/review/match') { n += 1; if (n === 2) return { ok: false, status: 409, json: async () => ({ error: 'the row moved on' }) }; } return null; } });
    d.querySelector('#pickSure').click();
    ck('"select all that match exactly" ticks only withdrawals that match', sel(d, '[data-pick]:checked').length === 2 && !d.querySelector('[data-id="D1"] [data-pick]'));
    d.getElementById('matchSel').click(); await wait(80);
    const matches = posts.filter((p) => p.url === '/api/bank/review/match');
    ck('it matches one at a time and STOPS at the first refusal', matches.length === 2, String(matches.length));
    ck('  and says how far it got', /Stopped after 1 of 2/.test((d.querySelector('.toast.bad') || {}).textContent || ''), (d.querySelector('.toast.bad') || {}).textContent);
}
{
    section('E — search and direction');
    const { d } = await boot();
    d.getElementById('q').value = 'hugo'; d.getElementById('q').dispatchEvent(new (d.defaultView.Event)('input'));
    ck('search narrows the grid', sel(d, '#banking .rowwrap').length === 1 && d.querySelector('[data-id="W1"]'));
    d.getElementById('q').value = ''; d.getElementById('q').dispatchEvent(new (d.defaultView.Event)('input'));
    d.querySelector('.seg [data-dir="in"]').click();
    ck('Money in shows only deposits', sel(d, '#banking .rowwrap').length === 1 && !!d.querySelector('[data-id="D1"]'));
    d.querySelector('.seg [data-dir="out"]').click();
    ck('Money out shows only withdrawals', sel(d, '#banking .rowwrap').length === 4 && !d.querySelector('[data-id="D1"]'));
}
{
    section('F — the date range reaches the reads and never a write');
    const { d, calls, posts, w } = await boot();
    d.getElementById('preset').value = 'month'; d.getElementById('preset').dispatchEvent(new w.Event('change')); await wait(80);
    const rd = calls.filter((c) => /^\/api\/bank\/(review|match|set-aside)(\?|$)/.test(c.url) && /from=/.test(c.url));
    ck('the bank reads carry from/to', ['/api/bank/review', '/api/bank/match', '/api/bank/set-aside'].every((p) => rd.some((c) => c.url.startsWith(p + '?'))), calls.map((c) => c.url).join(' '));
    d.querySelector('[data-match="W1"]').click(); await wait();
    ck('a write never has dates glued onto it', posts.every((p) => !/\?/.test(p.url)));
}
{
    section('G — Transactions: an account register');
    const { d, calls, w } = await boot();
    d.querySelector('[data-top="register"]').click(); await wait(60);
    ck('companies and the chart of accounts load', d.getElementById('regCo').options.length === 2 && d.getElementById('regAcct').options.length === 3);
    d.getElementById('regCo').value = 'edge-metals'; d.getElementById('regAcct').value = '6200';
    d.getElementById('regAcct').dispatchEvent(new w.Event('change')); await wait(60);
    ck('it asks for THAT company\'s account', calls.some((c) => /^\/api\/books\/account\/6200\?entity=edge-metals/.test(c.url)), calls.map((c) => c.url).join(' '));
    const t = d.getElementById('register').textContent;
    ck('it shows the postings with a running balance and the closing figure', /Wire fee/.test(t) && /\$45\.00/.test(t) && /Closing balance/.test(t));
    ck('  escaping names', !d.querySelector('#register i'));
    d.getElementById('regQ').value = 'wire'; d.getElementById('regQ').dispatchEvent(new w.Event('input'));
    ck('searching narrows the lines and says it is filtered', d.querySelectorAll('#register tbody tr').length === 1 && /filtered/.test(d.getElementById('register').textContent));
    let csv = null;
    w.URL.createObjectURL = (b) => { csv = b; return 'blob:x'; };
    w.HTMLAnchorElement.prototype.click = function () { this.__clicked = true; };
    d.getElementById('regCsv').click();
    ck('Download CSV builds a file from what is on screen', !!csv && csv.size > 20);
}
{
    section('H — it can only talk to the routes it was built on');
    const { d, calls, posts, w } = await boot();
    d.querySelector('[data-match="W1"]').click(); await wait();
    d.querySelector('[data-top="register"]').click(); await wait(60);
    const ALLOWED = /^\/api\/(bank\/(review|match|set-aside|exclude|include)(\/(match|categorise|categorised|categories)(\/undo)?)?|books(\/account\/[^/?]+)?)(\?|$)/;
    const all = calls.map((c) => c.url);
    ck('every request is one of the Bank or Books routes', all.every((u) => ALLOWED.test(u)), all.filter((u) => !ALLOWED.test(u)).join(' '));
    ck('  nothing that touches QuickBooks', !all.some((u) => /quickbooks|\/api\/qb/i.test(u)));
    const src = fs.readFileSync(path.join(ROOT, 'dashboard/workspace.html'), 'utf8');
    ck('  and the page source names no QuickBooks route', !/\/api\/(quickbooks|qb)/i.test(src));
}
{
    section('I — back to top, and the rail');
    const { d, w } = await boot();
    const up = d.getElementById('toTop'); let to = null;
    w.scrollTo = (a) => { to = a; };
    ck('a back-to-top button, hidden at the top', !!up && up.hidden === true);
    Object.defineProperty(w, 'pageYOffset', { configurable: true, get: () => 900 });
    w.dispatchEvent(new w.Event('scroll'));
    ck('  appears after scrolling', up.hidden === false);
    up.click();
    ck('  jumps to the top instantly', !!to && to.top === 0 && to.behavior === 'instant', JSON.stringify(to));
    ck('the shared sidebar is loaded once, as workspace', (HTML.match(/<script src="\/sidebar\.js" data-page="workspace" defer><\/script>/g) || []).length === 1);
}
{
    section('J — failure is shown, not blank');
    const { d } = await boot({ resp: { '/api/bank/review': undefined } });
    ck('when the review queue cannot load it says so, and shows no half-list', /no such route \/api\/bank\/review/.test(d.getElementById('banking').textContent) && sel(d, '#banking .rowwrap').length === 0, d.getElementById('banking').textContent.slice(0, 120));
}
console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) failures.forEach((f) => console.log('    · ' + f));
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('threw:', e && e.stack); process.exit(1); });
