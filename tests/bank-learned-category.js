// ── tests/bank-learned-category.js — the Post dropdown opens on what she filed the same kind of line under ───
// Apsara, 2026-11-16: "Enable self learn in accounting". Learned from the entries she already posts: nothing new to drift,
// and Undo un-teaches it. A SUGGESTION ONLY: nothing is ever posted for her.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-learncat-'));
process.env.DATA_DIR = TMP; process.env.JARVIS_TEST = '1';
process.env.BANK_TX_FILE = path.join(TMP, 'bank-tx.json'); process.env.BANK_LEARN_FILE = path.join(TMP, 'bl.json'); process.env.QB_DECISIONS_FILE = path.join(TMP, 'd.json');
process.env.APP_PASSWORD = 'user-pw-aaaaaaaaaaa'; process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb';
const ROOT = path.join(__dirname, '..');
const row = (o) => ({ id: 'r1', date: '2026-10-07', desc: 'x', party: '', spent: 40, received: 0, amount: 40, direction: 'out', bank: 'BofA', company: 'Edge Metals INC', pending: false, excluded: false, matched: null, history: [], ...o });
const D = (n) => `Wire handling charge Chicago - 10/0${n}/2026 Ref: XXXXX55${n}${n}`;   // same kind of line, different date and mask
fs.writeFileSync(process.env.BANK_TX_FILE, JSON.stringify([
    row({ id: 'h1', desc: D(1), amount: 41, spent: 41 }), row({ id: 'h2', desc: D(2), amount: 42, spent: 42, date: '2026-10-08' }),
    row({ id: 'h3', desc: D(3), amount: 43, spent: 43, date: '2026-10-09' }), row({ id: 'h4', desc: D(4), amount: 44, spent: 44, date: '2026-10-10' }),
    row({ id: 'o1', desc: 'ACME TOOLING INVOICE 5521', amount: 75, spent: 75 }), row({ id: 'o2', desc: 'ACME TOOLING INVOICE 6630', amount: 76, spent: 76, date: '2026-10-08' }),
    row({ id: 's1', desc: 'POS 7788', amount: 12, spent: 12 }), row({ id: 's2', desc: 'POS 9911', amount: 13, spent: 13, date: '2026-10-08' }),
    row({ id: 'f1', desc: 'External transfer fee - Next Day - 10/06/2026 Confirmation: XXXXX6844', amount: 5, spent: 5 }),
]));

(async () => {
section('A. what counts as "the same kind of line"');
{
    const BE = require(path.join(ROOT, 'helpers/bankEntries'));
    ck('the date and the masked confirmation number do not make it a new kind', BE.kindOf(D(1)) === BE.kindOf(D(2)) && BE.kindOf(D(1)) === 'wire handling charge chicago ref');
    ck('a different payee is a different kind', BE.kindOf('ACME TOOLING INVOICE 5521') !== BE.kindOf(D(1)));
    ck('a description too short to identify anything is never learned', BE.kindOf('POS 7788') === null && BE.kindOf('Deposit') === null && BE.kindOf('') === null && BE.kindOf(null) === null);
}

section('B. END TO END: post through the real route, read the suggestion off the real review route');
{
    const { createApi } = require(path.join(ROOT, 'api'));
    const server = await new Promise((r) => { const s = createApi().listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = (m, p, sid, body) => new Promise((res, rej) => { const d = body ? JSON.stringify(body) : null; const h = {}; if (sid) h.Authorization = 'Bearer ' + sid; if (d) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(d); } const q = http.request(base + p, { method: m, headers: h }, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} res({ st: r.statusCode, j }); }); }); q.on('error', rej); if (d) q.write(d); q.end(); });
    const admin = (await req('POST', '/login', null, { password: process.env.ADMIN_PASSWORD })).j.sid;
    const cat = async (id) => ((await req('GET', '/api/bank/review', admin)).j.queue.rows.find((r) => r.id === id) || {}).categorise;
    const post = (id, account) => req('POST', '/api/bank/review/categorise', admin, { id, account });

    let c = await cat('h2');
    ck('before she has taught it anything: no suggestion for an unusual line', c && !c.suggested && !c.learned, JSON.stringify(c));
    ck('the fixed wording rule still works as before (a transfer fee is Bank charges)', (await cat('f1')).suggested === '6200' && !(await cat('f1')).learned);
    const p1 = await post('h1', '6900');
    ck('she posts it as 6900', p1.st === 200 && p1.j.ok, JSON.stringify(p1.j));
    c = await cat('h2');
    ck('the next line of that kind opens on 6900, and says it was learned from her once', c.suggested === '6900' && c.learned && c.learned.times === 1, JSON.stringify(c));
    ck('it only SUGGESTS: that row is still waiting, nothing was posted for her', ((await req('GET', '/api/bank/review/categorised', admin)).j.entries || []).length === 1);
    await post('h2', '6900');
    c = await cat('h3');
    ck('twice the same way: "2 times"', c.suggested === '6900' && c.learned.times === 2);
    ck('a different payee is NOT given her wire-charge answer', !(await cat('o1')).suggested);
    ck('a line too short to identify anything is not suggested', !(await cat('s1')).suggested);
    const odd = await post('h3', '6180');
    ck('she files one the OTHER way', odd.st === 200);
    c = await cat('h4');
    ck('now she has filed this kind two ways: it asks, it does not guess', !c.suggested && !c.learned, JSON.stringify(c));
    const un = await req('POST', '/api/bank/review/categorise/undo', admin, { id: 'h3' });
    ck('undo of the odd one', un.st === 200);
    c = await cat('h4');
    ck('after the undo the lesson is the consistent one again, with no extra bookkeeping', c.suggested === '6900' && c.learned.times === 2, JSON.stringify(c));
    await req('POST', '/api/bank/review/categorise/undo', admin, { id: 'h1' });
    await req('POST', '/api/bank/review/categorise/undo', admin, { id: 'h2' });
    c = await cat('h4');
    ck('undo everything: it has forgotten', !c.suggested && !c.learned);
    server.close();
}

section('C. the screen says why it suggested');
{
    const { JSDOM } = require('jsdom');
    const HTML = fs.readFileSync(path.join(ROOT, 'dashboard/bank-match.html'), 'utf8');
    const REVIEW = { queue: { rows: [{ id: 'h4', state: 'ask', label: 'Not recorded', date: '2026-10-10', amount: 44, descriptor: D(4), why: 'x', account_id: '', categorise: { suggested: '6900', learned: { times: 2 } } },
        { id: 'f1', state: 'ask', label: 'Not recorded', date: '2026-10-06', amount: 5, descriptor: 'External transfer fee', why: 'x', account_id: '', categorise: { suggested: '6200' } }], counts: {} }, banks: [], journal: { complete: true, problems: 0 }, note: null };
    const MATCH = { rows: [], totals: { deposits: 0, confident: 0, needs_you: 0 }, counts: { deposits: 0 }, open_invoices: 0, customers_with_open: 0, learned_names: 0, balance_disagreements: [], other_company: [], ledger: { rows: 2, worklist: 2, in: { count: 0, money: 0 }, out: { count: 2, money: 49 }, excluded: { count: 0, money: 0 }, pending: { count: 0, money: 0 }, drifted: 0, companies: ['Edge Metals INC'], no_company: 0 }, feed: 'x', modes: ['Wire'], banks: ['BofA'] };
    const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'https://localhost/bank-match', pretendToBeVisual: true, beforeParse(w) {
        w.fetch = async (url) => { const u = String(url);
            if (u.startsWith('/api/bank/match')) return { ok: true, json: async () => MATCH };
            if (u.startsWith('/api/bank/review/categories')) return { ok: true, json: async () => ({ categories: [{ code: '6200', name: 'Bank charges' }, { code: '6900', name: 'Other expenses' }], companies: [{ id: 'e', name: 'Edge Metals' }] }) };
            if (u.startsWith('/api/bank/review')) return { ok: true, json: async () => REVIEW };
            if (u.startsWith('/api/me') || u.startsWith('/api/whoami')) return { ok: true, json: async () => ({ role: 'admin' }) };
            return { ok: false, json: async () => ({ error: 'unexpected ' + u }) }; }; } });
    await new Promise((r) => setTimeout(r, 200));
    const d = dom.window.document;
    const cardOf = (t) => [...d.querySelectorAll('#list .card')].find((c) => c.textContent.includes(t));
    const a = cardOf('Wire handling'), b = cardOf('External transfer fee');
    ck('a learned suggestion says "You filed this kind of line here 2 times before"', a && /filed this kind of line here 2 times before/.test(a.querySelector('[data-cat-effect]').textContent), a && a.querySelector('[data-cat-effect]').textContent);
    ck('a learned suggestion preselects 6900', a && a.querySelector('[data-cat-sel]').value === '6900');
    ck('a rule-based one still says "Suggested from the description"', b && /Suggested from the description/.test(b.querySelector('[data-cat-effect]').textContent));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }
process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
