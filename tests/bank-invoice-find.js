// ── tests/bank-invoice-find.js — "Find another invoice" on a deposit ─────────────────────────────────────────
// Apsara, 2026-11-16: "what if i want to search by invoice no/container". B = the real route; C = the real page, real clicks.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-invfind-'));
process.env.DATA_DIR = TMP; process.env.JARVIS_TEST = '1';
process.env.BANK_TX_FILE = path.join(TMP, 'bank-tx.json'); process.env.BANK_LEARN_FILE = path.join(TMP, 'bl.json'); process.env.QB_DECISIONS_FILE = path.join(TMP, 'd.json');
process.env.APP_PASSWORD = 'user-pw-aaaaaaaaaaa'; process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb'; process.env.STAFF_PASSWORD = 'staff-pw-ccccccccccc';
const ROOT = path.join(__dirname, '..');
const sales = require(path.join(ROOT, 'helpers/sales'));
const mk = (customer, invoice_no, container_no, date, weight, price) => sales.addSale({ customer, invoice_no, container_no, date, item: 'Auto Battery', weight, invoice_price: price, price_unit: 'lb', weight_unit: 'lb' });

(async () => {
section('B. END TO END, through the real route and the real receipt route');
{
    await mk('MK Trading', 'EM-100', 'HMMU6142846', '2026-08-10', 1000, 10);   // 10,000
    await mk('MK Trading', 'EM-101', 'KOCU5134821', '2026-09-01', 2000, 5);    // 10,000
    await mk('MK Trading', 'EM-102', 'FSCU8671703', '2026-09-21', 500, 4);     // 2,000
    await mk('Metalco', 'EM-200', 'ZZZU0000001', '2026-09-02', 100, 1);
    const { createApi } = require(path.join(ROOT, 'api'));
    const server = await new Promise((r) => { const s = createApi().listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = (m, p, sid, body) => new Promise((res, rej) => { const d = body ? JSON.stringify(body) : null; const h = {}; if (sid) h.Authorization = 'Bearer ' + sid; if (d) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(d); } const q = http.request(base + p, { method: m, headers: h }, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} res({ st: r.statusCode, j }); }); }); q.on('error', rej); if (d) q.write(d); q.end(); });
    const admin = (await req('POST', '/login', null, { password: process.env.ADMIN_PASSWORD })).j.sid;
    const user = (await req('POST', '/login', null, { password: process.env.APP_PASSWORD })).j.sid;
    let r = await req('GET', '/api/bank/open-invoices?party=mk%20trading', admin);
    ck('admin gets that customer\'s open invoices (name case does not matter)', r.st === 200 && r.j.invoices.length === 3, JSON.stringify(r));
    const inv = r.j.invoices.find((x) => x.container_no === 'KOCU5134821');
    ck('each carries invoice no, container, date, item and what is still owed', inv && inv.invoice_no === 'EM-101' && inv.item === 'Auto Battery' && inv.balance === 10000, JSON.stringify(inv));
    ck('another customer\'s invoice is NOT in the list', !r.j.invoices.some((x) => x.container_no === 'ZZZU0000001'));
    ck('oldest first', r.j.invoices[0].container_no === 'HMMU6142846');
    ck('no customer named: 400', (await req('GET', '/api/bank/open-invoices', admin)).st === 400);
    const u = await req('GET', '/api/bank/open-invoices?party=MK%20Trading', user);
    ck('the ordinary login is refused', u.st === 401 || u.st === 403, String(u.st));
    // The receipt route the page posts to: two invoices, exactly the deposit.
    const before = (await req('GET', '/api/bank/open-invoices?party=MK%20Trading', admin)).j.invoices.map((x) => [x.container_no, x.balance]);
    const rec = await req('POST', '/api/sales-receipts', admin, { date: '2026-11-04', amount: 12000, mode: 'Wire', bank: 'BofA', customer: 'MK Trading', ref: 'TX-T', allocations: [{ sale_id: inv.id, amount: 10000 }, { sale_id: r.j.invoices.find((x) => x.container_no === 'FSCU8671703').id, amount: 2000 }] });
    ck('the receipt route accepts exactly what the page will post', rec.st === 200 || rec.st === 201, JSON.stringify(rec));
    const after = (await req('GET', '/api/bank/open-invoices?party=MK%20Trading', admin)).j.invoices;
    ck('both invoices are now settled and gone from the list; the third is untouched', after.length === 1 && after[0].container_no === 'HMMU6142846' && after[0].balance === 10000, JSON.stringify([before, after.map((x) => [x.container_no, x.balance])]));
    const wrong = await req('POST', '/api/sales-receipts', admin, { date: '2026-11-04', amount: 100, mode: 'Wire', bank: 'BofA', customer: 'MK Trading', ref: 'TX-U', allocations: [{ sale_id: (await req('GET', '/api/bank/open-invoices?party=Metalco', admin)).j.invoices[0].id, amount: 100 }] });
    ck('the server itself refuses another customer\'s invoice (the screen is not the only guard)', wrong.st >= 400, JSON.stringify(wrong));
    server.close();
}

section('C. the REAL page: search, tick, amounts, record');
{
    const { JSDOM } = require('jsdom');
    const HTML = fs.readFileSync(path.join(ROOT, 'dashboard/bank-match.html'), 'utf8');
    const alloc = (id, label, bal, amt) => ({ doc_id: id, label, balance: bal, amount: amt, shortfall: 0, clears: false, leaves: bal - amt });
    const MATCH = { rows: [
        { deposit: { id: 'TX-MK', date: '2026-11-04', amount: 9467.78, descriptor: 'WIRE IN MK TRADING', bank_guess: 'BofA' }, party: 'MK Trading', outcome: 'proposed', ambiguous: true, truncated: false,
          proposals: [{ kind: 'partial', score: 0.5, tied: true, allocations: [alloc('S1', 'HMMU6142846 · 2026-08-10 · Auto Battery', 18612, 9467.78)], reasons: ['part payment'] }, { kind: 'partial', score: 0.5, tied: true, allocations: [alloc('S2', 'KOCU5134821 · 2026-09-01 · Auto Battery', 22681.8, 9467.78)], reasons: ['part payment'] }] },
        { deposit: { id: 'TX-NO', date: '2026-11-05', amount: 100, descriptor: 'ZELLE FROM SOMEBODY' }, outcome: 'no_party', ambiguous: false, note: 'x', proposals: [], suggestions: [] }],
        totals: { deposits: 1, confident: 0, needs_you: 1 }, counts: { deposits: 2, no_party: 1 }, open_invoices: 3, customers_with_open: 1, learned_names: 0, balance_disagreements: [], other_company: [],
        ledger: { rows: 2, worklist: 2, in: { count: 2, money: 9567.78 }, out: { count: 0, money: 0 }, excluded: { count: 0, money: 0 }, pending: { count: 0, money: 0 }, drifted: 0, companies: ['Edge Metals INC'], no_company: 0 }, feed: 'x', modes: ['Wire', 'Zelle'], banks: ['BofA'] };
    const INV = [
        { id: 'S1', label: 'HMMU6142846 · 2026-08-10 · Auto Battery', invoice_no: 'EM-100', container_no: 'HMMU6142846', booking_no: null, item: 'Auto Battery', date: '2026-08-10', amount: 18612, applied: 0, balance: 18612 },
        { id: 'S2', label: 'KOCU5134821 · 2026-09-01 · Auto Battery', invoice_no: 'EM-101', container_no: 'KOCU5134821', booking_no: null, item: 'Auto Battery', date: '2026-09-01', amount: 22681.8, applied: 0, balance: 22681.8 },
        { id: 'S3', label: 'FSCU8671703 · 2026-09-21 · Auto Battery', invoice_no: 'EM-102', container_no: 'FSCU8671703', booking_no: 'BK77', item: 'Auto Battery', date: '2026-09-21', amount: 5000, applied: 0, balance: 5000 }];
    const posted = [];
    const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'https://localhost/bank-match', pretendToBeVisual: true, beforeParse(w) {
        w.fetch = async (url, o) => { const body = o && o.body ? JSON.parse(o.body) : null; posted.push({ url: String(url), body }); const u = String(url);
            if (u.startsWith('/api/bank/match')) return { ok: true, json: async () => MATCH };
            if (u.startsWith('/api/bank/open-invoices')) return { ok: true, json: async () => ({ party: 'MK Trading', invoices: INV }) };
            if (u.startsWith('/api/sales-receipts')) return { ok: true, json: async () => ({ ok: true, id: 'R1' }) };
            if (u.startsWith('/api/bank/payers')) return { ok: true, json: async () => ({ customers: [] }) };
            return { ok: false, json: async () => ({ error: 'unexpected ' + u }) }; }; } });
    const w = dom.window, d = w.document;
    const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
    await settle(120);
    const card = [...d.querySelectorAll('#list .card')].find((c) => /MK TRADING/i.test(c.textContent));
    ck('the deposit card has a "Find another invoice" button', !!(card && card.querySelector('[data-invfind]')));
    const noParty = [...d.querySelectorAll('#list .card')].find((c) => /SOMEBODY/i.test(c.textContent));
    ck('a deposit with no known customer has none (name the payer first)', noParty && !noParty.querySelector('[data-invfind]'));
    card.querySelector('[data-invfind]').click(); await settle(100);
    ck('it fetched THIS customer\'s invoices', posted.some((p) => p.url.startsWith('/api/bank/open-invoices?party=MK%20Trading')));
    const rows = () => [...card.querySelectorAll('[data-invlist] .row1')];
    ck('all three open invoices are listed with what each owes', rows().length === 3 && /owes \$18,612\.00/.test(rows()[0].textContent));
    const q = card.querySelector('[data-invq]');
    const type = (v) => { q.value = v; q.dispatchEvent(new w.Event('input', { bubbles: true })); };
    type('kocu'); ck('search by container', rows().length === 1 && /KOCU5134821/.test(rows()[0].textContent));
    type('EM-102'); ck('search by invoice number', rows().length === 1 && /FSCU8671703/.test(rows()[0].textContent));
    type('bk77'); ck('search by booking number', rows().length === 1 && /FSCU8671703/.test(rows()[0].textContent));
    type('zzzz'); ck('no match says so, and clears nothing', /No open invoice/.test(card.querySelector('[data-invlist]').textContent));
    type('');
    const go = () => card.querySelector('[data-invgo]');
    const tick = (id, on) => { const c = card.querySelector(`[data-invpick][data-invid="${id}"]`); c.checked = on; c.dispatchEvent(new w.Event('change', { bubbles: true })); };
    const amt = (id, v) => { const a = card.querySelector(`[data-invamt][data-invid="${id}"]`); a.value = v; a.dispatchEvent(new w.Event('input', { bubbles: true })); };
    ck('nothing ticked: the record button is off', go().disabled === true);
    tick('S2', true);
    ck('ticking one defaults its amount to the whole deposit (it owes more)', card.querySelector('[data-invamt][data-invid="S2"]').value === '9467.78' && go().disabled === false, card.querySelector('[data-invsum]').textContent);
    amt('S2', '5000'); ck('amount short of the deposit: off, and says how much is left', go().disabled === true && /4,467\.78 still to assign/.test(card.querySelector('[data-invsum]').textContent), card.querySelector('[data-invsum]').textContent);
    tick('S3', true);
    ck('a second tick takes only what is left, capped at what that invoice owes', card.querySelector('[data-invamt][data-invid="S3"]').value === '4467.78' && go().disabled === false);
    amt('S3', '5000.01'); amt('S2', '4467.77');
    ck('adding up to the deposit exactly is not enough if one invoice is asked for more than it owes', go().disabled === true && /too high/.test(card.querySelector('[data-invsum]').textContent), card.querySelector('[data-invsum]').textContent);
    amt('S3', '4467.78'); amt('S2', '5000');
    card.querySelector('[data-mode]').value = 'Wire';
    go().click(); await settle(100);
    const rec = posted.find((p) => p.url.startsWith('/api/sales-receipts'));
    ck('it posts ONE receipt for the whole deposit, to this customer, with exactly the ticked invoices and amounts', rec && rec.body.amount === 9467.78 && rec.body.customer === 'MK Trading' && rec.body.ref === 'TX-MK' && rec.body.allocations.length === 2 && rec.body.allocations.find((a) => a.sale_id === 'S2').amount === 5000 && rec.body.allocations.find((a) => a.sale_id === 'S3').amount === 4467.78, JSON.stringify(rec));
    ck('and no shortfall or deduction is invented', rec && !rec.body.allocations.some((a) => a.deduction_amount || a.deduction_reason));
    ck('the list reloads after recording', posted.filter((p) => p.url.startsWith('/api/bank/match')).length >= 2);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }
process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
