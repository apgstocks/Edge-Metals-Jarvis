// ── tests/bank-payers.js — the "Name payer" box offers the customers it can match to ───────────────────────
// Apsara, 2026-11-16: "in this it should show all my available customers in qb for matching".
// B drives the real route (CLAUDE.md rule 3). C renders the real page in jsdom and presses the real button.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-payers-'));
process.env.DATA_DIR = TMP; process.env.JARVIS_TEST = '1';
process.env.BANK_TX_FILE = path.join(TMP, 'bank-tx.json'); process.env.BANK_LEARN_FILE = path.join(TMP, 'bank-learn.json');
process.env.QB_DECISIONS_FILE = path.join(TMP, 'qb-decisions.json'); process.env.QB_SNAPSHOT_FILE = path.join(TMP, 'qb-snap.json');
process.env.APP_PASSWORD = 'user-pw-aaaaaaaaaaa'; process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb'; process.env.STAFF_PASSWORD = 'staff-pw-ccccccccccc';
const ROOT = path.join(__dirname, '..');
const sales = require(path.join(ROOT, 'helpers/sales'));

(async () => {
section('B. END TO END, through the real route');
let named = null;
{
    await sales.addSale({ customer: 'Daekwang Sanup Co', invoice_no: 'EM-1', date: '2026-10-01', item: 'Auto Cast', weight: 1000, invoice_price: 2, price_unit: 'lb', weight_unit: 'lb' });
    await sales.addSale({ customer: 'Daekwang Sanup Co', invoice_no: 'EM-2', date: '2026-10-02', item: 'Auto Cast', weight: 500, invoice_price: 2, price_unit: 'lb', weight_unit: 'lb' });
    await sales.addSale({ customer: 'Metalco', invoice_no: 'EM-3', date: '2026-10-03', item: 'Al', weight: 100, invoice_price: 1, price_unit: 'lb', weight_unit: 'lb' });
    const { createApi } = require(path.join(ROOT, 'api'));
    const server = await new Promise((r) => { const s = createApi().listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = (m, p, sid, body) => new Promise((res, rej) => { const d = body ? JSON.stringify(body) : null; const h = {}; if (sid) h.Authorization = 'Bearer ' + sid; if (d) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(d); } const q = http.request(base + p, { method: m, headers: h }, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} res({ st: r.statusCode, j }); }); }); q.on('error', rej); if (d) q.write(d); q.end(); });
    const admin = (await req('POST', '/login', null, { password: process.env.ADMIN_PASSWORD })).j.sid;
    const staff = (await req('POST', '/login', null, { password: process.env.STAFF_PASSWORD })).j.sid;

    let r = await req('GET', '/api/bank/payers', admin);
    const by = (n) => (r.j.customers || []).find((c) => c.name === n);
    ck('admin gets the list', r.st === 200 && Array.isArray(r.j.customers), JSON.stringify(r));
    ck('a customer with sales is listed, with open invoices and the amount still owed', by('Daekwang Sanup Co') && by('Daekwang Sanup Co').ledger === true && by('Daekwang Sanup Co').openCount === 2 && by('Daekwang Sanup Co').open === 3000, JSON.stringify(by('Daekwang Sanup Co')));
    ck('no snapshot yet: says so, and the ledger names still come', r.j.quickbooks.read === false && !!by('Metalco'));
    fs.writeFileSync(process.env.QB_SNAPSHOT_FILE, JSON.stringify({ at: '2026-11-16T01:00:00Z', customers: [{ name: 'DAEKWANG SANUP CO.', balance: 5 }, { name: 'Taewon Automotive Co', balance: 27099.79 }, { name: '', balance: 1 }] }));
    r = await req('GET', '/api/bank/payers', admin);
    ck('a QuickBooks customer with no sale in Jarvis is listed and marked qb-only', by('Taewon Automotive Co') && by('Taewon Automotive Co').ledger === false && by('Taewon Automotive Co').qb === true, JSON.stringify(r.j));
    ck('the same company in both (case and punctuation aside) is ONE entry, marked as in both', (r.j.customers || []).filter((c) => /daekwang/i.test(c.name)).length === 1 && by('Daekwang Sanup Co').qb === true);
    ck('a blank QuickBooks name is dropped', !(r.j.customers || []).some((c) => !c.name));
    ck('ledger customers come first, then QuickBooks-only', r.j.customers.findIndex((c) => !c.ledger) > r.j.customers.findLastIndex((c) => c.ledger));
    ck('it says when the snapshot was read and what it does not hold', r.j.quickbooks.read === true && r.j.quickbooks.as_of === '2026-11-16T01:00:00Z' && /balance/.test(r.j.quickbooks.note));
    const s = await req('GET', '/api/bank/payers', staff);
    ck('staff are refused (it carries what customers owe)', s.st === 403 || s.st === 401, String(s.st));
    const user = (await req('POST', '/login', null, { password: process.env.APP_PASSWORD })).j.sid;
    const u = await req('GET', '/api/bank/payers', user);
    ck('the ordinary login is refused too (the route gate, not only the staff allowlist)', u.st === 403 || u.st === 401, String(u.st));
    const a = await req('GET', '/api/bank/payers');
    ck('signed out is refused', a.st === 401 || a.st === 403);
    fs.writeFileSync(process.env.QB_SNAPSHOT_FILE, '{not json');
    r = await req('GET', '/api/bank/payers', admin);
    ck('a broken snapshot file does not break the list', r.st === 200 && !!by('Metalco') && r.j.quickbooks.read === false);
    server.close();
}

section('C. the REAL page: the box offers the names, and warns before remembering one that cannot match');
{
    const { JSDOM } = require('jsdom');
    const HTML = fs.readFileSync(path.join(ROOT, 'dashboard/bank-match.html'), 'utf8');
    const MATCH = { rows: [{ deposit: { id: 'TX-2', date: '2026-09-06', amount: 10000, descriptor: 'WIRE IN DAEKWANG SANUP' }, outcome: 'no_party', ambiguous: false, note: 'x', proposals: [], suggestions: [] }],
        totals: { deposits: 10000, confident: 0, needs_you: 10000 }, counts: { deposits: 1, no_party: 1 }, open_invoices: 0, customers_with_open: 0, learned_names: 0, balance_disagreements: [], other_company: [], ledger: { rows: 1, worklist: 1, in: { count: 1, money: 10000 }, out: { count: 0, money: 0 }, excluded: { count: 0, money: 0 }, pending: { count: 0, money: 0 }, drifted: 0, companies: ['Edge Metals INC'], no_company: 0 }, feed: 'x', modes: ['Wire'], banks: ['BofA'] };
    const PAYERS = [{ name: 'Daekwang Sanup Co', ledger: true, qb: true, open: 3000, openCount: 2 }, { name: 'Taewon Automotive Co', ledger: false, qb: true, open: 0, openCount: 0 }];
    const make = (payersReply) => { const posted = []; const asked = []; let answer = true;
        const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'https://localhost/bank-match', beforeParse(w) {
            w.confirm = (m) => { asked.push(m); return answer; };
            w.fetch = async (url, o) => { const body = o && o.body ? JSON.parse(o.body) : null; posted.push({ url: String(url), body }); const u = String(url);
                if (u.startsWith('/api/bank/match')) return { ok: true, json: async () => MATCH };
                if (u.startsWith('/api/bank/payers')) return payersReply === null ? { ok: false, json: async () => ({ error: 'down' }) } : { ok: true, json: async () => ({ customers: PAYERS }) };
                if (u.startsWith('/api/bank/aliases')) return { ok: true, json: async () => ({ ok: true, aliases: [] }) };
                return { ok: false, json: async () => ({ error: 'unexpected ' + u }) }; }; } });
        return { dom, posted, asked, setAnswer: (v) => { answer = v; } }; };
    const settle = () => new Promise((r) => setTimeout(r, 60));
    const press = async (ctx, typed) => { const d = ctx.dom.window.document; const input = d.querySelector('[data-name]'); input.value = typed; d.querySelector('[data-learnfree]').click(); await settle(); };
    const saved = (ctx) => ctx.posted.filter((p) => p.url.startsWith('/api/bank/aliases') && p.body && p.body.customer);

    let ctx = make(); await settle();
    const d0 = ctx.dom.window.document;
    ck('the box is wired to a name list', d0.querySelector('[data-name]').getAttribute('list') === 'payerNames');
    const opts = [...d0.querySelectorAll('#payerNames option')];
    ck('the list holds every name, and says which have no invoice in Jarvis', opts.length === 2 && /QuickBooks only/.test(opts[1].textContent) && /2 open invoice/.test(opts[0].textContent), opts.map((o) => o.value + '|' + o.textContent).join(' ; '));
    await press(ctx, 'Daekwang Sanup Co');
    ck('a known customer is remembered with NO extra question', ctx.asked.length === 0 && saved(ctx).length === 1 && saved(ctx)[0].body.customer === 'Daekwang Sanup Co', JSON.stringify(ctx.asked));
    ctx = make(); await settle(); await press(ctx, 'DAEKWANG sanup co.');
    ck('spelling case/punctuation is not "unknown"', ctx.asked.length === 0 && saved(ctx).length === 1);
    ctx = make(); await settle(); ctx.setAnswer(false); await press(ctx, 'Joe');
    ck('"Joe" (not a customer anywhere) is questioned first, and NO says nothing is saved', ctx.asked.length === 1 && /"Joe" is not a customer/.test(ctx.asked[0]) && saved(ctx).length === 0, JSON.stringify(ctx.asked));
    ctx = make(); await settle(); ctx.setAnswer(true); await press(ctx, 'Joe');
    ck('  YES still saves it: her choice, as before', saved(ctx).length === 1 && saved(ctx)[0].body.customer === 'Joe');
    ctx = make(); await settle(); ctx.setAnswer(false); await press(ctx, 'Taewon Automotive Co');
    ck('a QuickBooks-only customer warns that no invoice here can match it', ctx.asked.length === 1 && /no invoice in Jarvis/.test(ctx.asked[0]) && saved(ctx).length === 0, JSON.stringify(ctx.asked));
    ctx = make(null); await settle(); ctx.setAnswer(false); await press(ctx, 'Joe');
    ck('if the list cannot be read the box still works as it always did, with no question', ctx.asked.length === 0 && saved(ctx).length === 1);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }
process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
