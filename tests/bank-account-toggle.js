// "Make it like a toggle between banks ... when I click one bank that
// particular bank's details should come." — Apsara, 2026-10-14.
// jsdom over the real page with stubbed reads: two banks, rows in each.
const fs = require('fs'), path = require('path');
const { JSDOM } = require('jsdom');
let pass = 0, fail = 0;
const ck = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '\n        ' + x : '')); } };
const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'dashboard/bank-match.html'), 'utf8');

const dep = (id, acct, amt) => ({ deposit: { id, date: '2026-10-08', amount: amt, descriptor: 'WIRE ' + id, bank_guess: 'BofA', account_id: acct }, party: 'Cust ' + id, outcome: 'proposed', ambiguous: false,
    proposals: [{ kind: 'exact', score: 0.99, allocations: [{ doc_id: 'S' + id, label: 'INV-' + id, amount: amt, shortfall: 0, clears: true }], reasons: ['to the cent'] }] });
const wd = (id, acct, st) => ({ id, date: '2026-10-07', descriptor: 'PAID ' + id, amount: 50, state: st, label: st, why: 'x', account_id: acct });
const RESP = (opts = {}) => ({
    '/api/bank/match': { rows: [dep('D1', 'acc-x', 1000), dep('D2', 'acc-y', 2000), dep('D3', 'acc-x', 3000)], counts: {}, totals: {}, ledger: { excluded: { count: 0, money: 0 }, pending: { count: 0 } }, feed: 'f', modes: ['Wire'], banks: ['BofA'] },
    '/api/bank/set-aside': { count: 2, money: 20, rows: [{ id: 'A1', date: '2026-10-01', desc: 'FEE X', amount: 10, direction: 'out', account_id: 'acc-x' }, { id: 'A2', date: '2026-10-01', desc: 'FEE Y', amount: 10, direction: 'out', account_id: 'acc-y' }] },
    '/api/bank/overview': { accounts: opts.one ? [{ key: 'ax', ids: ['acc-x'], company: 'Edge Metals', bank: 'Bank of America', mask: '3301', linked: true, in: 1, out: 1, rows: 2, waiting: 2 }]
        : [{ key: 'ax', ids: ['acc-x', 'local-x'], company: 'Edge Metals', bank: 'Bank of America', mask: '3301', linked: true, in: 4000, out: 50, rows: 4, waiting: 3 },
           { key: 'ay', ids: ['acc-y'], company: 'Edge Trading', bank: 'Chase', mask: '4410', linked: true, in: 2000, out: 50, rows: 2, waiting: 2 }], missing: [], coming_in: { total: 0, count: 0, invoices: [] } },
    '/api/intercompany/transfers': { proposed: [{ id: 'p1', from: 'edge-trading', to: 'edge-metals', amount: 5000, date: '2026-09-10', sure: true, out_row: { id: 'o', desc: 'XFER', account_id: 'acc-y' }, in_row: { id: 'i', desc: 'XFER', account_id: 'acc-x' }, reasons: ['r'] }], one_sided: [], recorded: [] },
    '/api/bank/review': { queue: { rows: [wd('W1', 'acc-x', 'match'), wd('W2', 'acc-y', 'match'), wd('W3', 'acc-y', 'match')], counts: {}, canPostAll: 3 } },
    '/api/bank/review/categorised': { entries: [{ bank_row_id: 'B1', amount: 5, date: '2026-10-02', account: '6200', account_name: 'Bank charges', descriptor: 'CAT X', account_id: 'acc-x' }, { bank_row_id: 'B2', amount: 6, date: '2026-10-02', account: '6200', account_name: 'Bank charges', descriptor: 'CAT Y', account_id: 'acc-y' }] },
    '/api/bank/review/categories': { accounts: [], entities: [] },
    '/api/bank/reconcile': { banks: [{ code: '1010', bank: 'BofA', name: 'BofA acct', reconcile: { ok: true, name: 'BofA acct', agrees: true, inGap: 0, outGap: 0, feed: { in: 1, out: 1, rows: [{ id: 'r', account_id: 'acc-x' }], excluded: { count: 0, in: 0, out: 0 } }, books: { in: 1, out: 1, byEntity: [] }, compares: 'c', anchorNeeded: 'a' }, unexplained: { clean: true } }, { code: '1010', bank: 'Chase', name: 'Chase acct', reconcile: { ok: true, name: 'Chase acct', agrees: false, inGap: 0, outGap: 0, feed: { in: 1, out: 1, rows: [{ id: 'r', account_id: 'acc-y' }], excluded: { count: 0, in: 0, out: 0 } }, books: { in: 1, out: 1, byEntity: [] }, compares: 'c', anchorNeeded: 'a' }, unexplained: { clean: false } }], feed: { ok: true }, journal: { complete: true }, nothingNeedsYou: false },
    '/api/plaid/status': { configured: true, env: 'production', items: [] },
    '/api/bank/rules': { rules: [], labels: [] },
});
async function boot(opts = {}, store = {}) {
    const posted = [];
    const R = RESP(opts);
    const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'https://localhost/bank-match', beforeParse: (w) => {
        w.fetch = async (u, o) => { const k = String(u).split('?')[0]; if (o && o.body) posted.push({ u: k, body: JSON.parse(o.body) }); return { ok: true, json: async () => R[k] || { ok: true } }; };
        w.confirm = () => true;
        for (const [k, v] of Object.entries(store)) w.localStorage.setItem(k, v);
    } });
    await new Promise((r) => setTimeout(r, 80));
    return { dom, d: dom.window.document, posted, w: dom.window };
}
const vis = (d, sel) => [...d.querySelectorAll(sel)].filter((c) => !c.hidden);
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

(async () => {
    console.log('\n=== bank toggle ===');
    let { d, dom, posted } = await boot();
    const pills = [...d.querySelectorAll('#acctbar [data-acctpick]')];
    ck('a pill for All banks and one per account', pills.length === 3 && /All banks/.test(pills[0].textContent) && /Bank of America ••3301/.test(pills[1].textContent) && /Chase ••4410/.test(pills[2].textContent), pills.map((p) => p.textContent.trim()).join('|'));
    ck('All banks is selected to begin with and every row shows', pills[0].classList.contains('on') && vis(d, '#list .card[data-dir="in"]').length === 3 && d.querySelectorAll('#accounts .acct').length === 2);
    ck('an in-row carries its account', d.querySelector('#list .card[data-acct="acc-y"]') !== null);

    pills[2].click(); await tick();
    ck('clicking Chase shows only its deposits', vis(d, '#list .card[data-dir="in"]').length === 1 && vis(d, '#list .card[data-dir="in"]')[0].dataset.acct === 'acc-y');
    ck('  only its card of figures', d.querySelectorAll('#accounts .acct').length === 1 && /Chase/.test(d.getElementById('accounts').textContent));
    const outs = [...d.querySelectorAll('.card[data-dir="out"]')].filter((c) => !c.hidden);
    ck('  only its withdrawals', outs.length === 2 && outs.every((c) => c.dataset.acct === 'acc-y'), String(outs.length));
    ck('  the For review count follows: 1 deposit + 2 withdrawals + the transfer touching it = 4', d.getElementById('n-review').textContent === '4', d.getElementById('n-review').textContent);
    ck('  "Match all" counts only this bank (2, not 3)', /Match all 2/.test(d.getElementById('review').textContent), d.getElementById('review').textContent.slice(0, 200));
    ck('  set aside shows only its line', /FEE Y/.test(d.getElementById('asidelist').textContent) && !/FEE X/.test(d.getElementById('asidelist').textContent));
    ck('  booked shows only its entry', /CAT Y/.test(d.getElementById('booked').textContent) && !/CAT X/.test(d.getElementById('booked').textContent));
    ck('  the pill is marked selected', d.querySelector('#acctbar [data-acctpick="ay"]').classList.contains('on'));

    // A bulk action must act only on what is shown.
    d.querySelector('[data-reviewall]').click(); await tick(120);
    const matched = posted.filter((p) => /review\/match/.test(p.u)).map((p) => p.body.id).sort();
    ck('"Match all" posted only this bank\'s rows', matched.join(',') === 'W2,W3', matched.join(','));

    d.querySelector('[data-tab="recon"]').click(); await tick();
    ck('Bank vs books follows the bank: only Chase, and it says they do not agree', /Chase acct/.test(d.getElementById('recon').textContent) && !/BofA acct/.test(d.getElementById('recon').textContent) && /do not agree yet/.test(d.getElementById('recon').textContent), d.getElementById('recon').textContent.slice(0, 200));
    d.querySelector('#acctbar [data-acctpick="ax"]').click(); await tick();
    ck('  switching to Bank of America shows only it, and the heading reflects THAT bank (agrees)', /BofA acct/.test(d.getElementById('recon').textContent) && !/Chase acct/.test(d.getElementById('recon').textContent) && /Nothing needs you/.test(d.getElementById('recon').textContent), d.getElementById('recon').textContent.slice(0, 200));
    d.querySelector('#acctbar [data-acctpick=""]').click(); await tick();
    ck('  All banks shows both again', /BofA acct/.test(d.getElementById('recon').textContent) && /Chase acct/.test(d.getElementById('recon').textContent));
    d.querySelector('#acctbar [data-acctpick="ay"]').click(); await tick();

    d.querySelector('#acctbar [data-acctpick="ax"]').click(); await tick();
    ck('switching to Bank of America swaps everything', vis(d, '#list .card[data-dir="in"]').length === 2 && /Bank of America/.test(d.getElementById('accounts').textContent) && !/Chase/.test(d.getElementById('accounts').textContent));
    ck('  and Confirm-all counts only its sure deposits', !/Confirm all 3/.test(d.getElementById('sure').textContent));

    d.querySelector('#acctbar [data-acctpick=""]').click(); await tick();
    ck('All banks brings everything back', vis(d, '#list .card[data-dir="in"]').length === 3 && d.querySelectorAll('#accounts .acct').length === 2 && d.getElementById('n-review').textContent === '7', d.getElementById('n-review').textContent);

    d.querySelector('#acctbar [data-acctpick="ay"]').click(); await tick();
    ck('the choice is remembered', dom.window.localStorage.getItem('bank.acct') === 'ay');
    const again = await boot({}, { 'bank.acct': 'ay' });
    ck('  and applied on the next visit', vis(again.d, '#list .card[data-dir="in"]').length === 1 && again.d.querySelector('#acctbar [data-acctpick="ay"]').classList.contains('on'));
    const gone = await boot({}, { 'bank.acct': 'no-such-bank' });
    ck('a remembered bank that no longer exists is forgotten, not shown empty', vis(gone.d, '#list .card[data-dir="in"]').length === 3 && gone.dom.window.localStorage.getItem('bank.acct') === null);

    const single = await boot({ one: true });
    ck('with one bank there is nothing to toggle', single.d.querySelectorAll('#acctbar [data-acctpick]').length === 0);

    console.log(`\n  ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
