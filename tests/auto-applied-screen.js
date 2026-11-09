// tests/auto-applied-screen.js — the "Placed by Jarvis" card on the Bank page, rendered in JSDOM against a fixture shaped
// like GET /api/bank/auto-applied. Asserts the DOM, not the source: the reasons are on screen, the hostile name is
// escaped, Undo posts the code and the chosen reason to the route the server defines, Resume posts the customer.
const fs = require('fs'), path = require('path');
const { JSDOM } = require('jsdom');
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'dashboard/bank-match.html'), 'utf8');
const MATCH = { rows: [], totals: { deposits: 0, confident: 0, needs_you: 0 }, counts: { deposits: 0, confident: 0, ambiguous: 0, no_party: 0, more_than_owed: 0, nothing_open: 0, no_combination: 0, truncated: 0 },
    open_invoices: 0, customers_with_open: 0, learned_names: 0, balance_disagreements: [], other_company: [], ledger: { rows: 0, worklist: 0, in: { count: 0, money: 0 }, out: { count: 0, money: 0 }, excluded: { count: 0, money: 0 }, pending: { count: 0, money: 0 }, drifted: 0, companies: [], no_company: 0 },
    feed: 'bank-transactions.json', modes: ['Wire', 'Zelle'], banks: ['BofA'] };
const AA = { on: true, max_age_days: 30, max_per_run: 20, asks: [{ id: 'q1', code: 'W4NB', customer: 'Lotte <b>x</b>', amount: 2000, date: '2026-11-06', why: 'not sure \u2014 the bank description says "ADVANCE" <i>z</i>', proposal: { label: 'LT-2' }, answer: null }, { id: 'q2', code: 'H9CD', customer: null, descriptor: 'WIRE IN ???', amount: 40, date: '2026-11-06', why: 'not sure', proposal: null, answer: null }], blocks: [{ customer: 'Daekwang & Co', payer: 'x', lifted: null }],
    entries: [
        { id: 'a1', code: 'K7QM', customer: 'Carlos G & C <img src=x onerror=alert(1)>', amount: 5000, date: '2026-11-05', invoice_no: 'DK-1', saleId: 'S1', reasons: ['the payer "WIRE IN CARLOS" is Carlos, a name already matched', 'one invoice, to the cent', 'confidence 100%'], undone: null, diagnosis: null },
        { id: 'a2', code: 'P3ZX', customer: 'Daekwang & Co', amount: 7000, date: '2026-11-04', invoice_no: 'DK-2', saleId: 'S2', reasons: ['one invoice, to the cent'], undone: { at: 'x', reason: 'wrong invoice' }, diagnosis: { kind: 'wrong_invoice', detail: 'she placed it on a different Daekwang invoice (S9), not DK-2' } },
        { id: 'a3', code: 'R8TT', customer: 'Aris', amount: 900, date: '2026-11-03', invoice_no: null, saleId: 'S3', reasons: ['one invoice, to the cent'], undone: { at: 'x', reason: null }, diagnosis: null } ] };
const posted = []; let AAD = AA; let status = 200; let CONFIRM = true;
function makeDom() {
    return new JSDOM(HTML, { runScripts: 'dangerously', url: 'https://localhost/bank-match', beforeParse: (window) => {
        window.confirm = () => CONFIRM;
        window.fetch = async (url, opts) => {
            const body = opts && opts.body ? JSON.parse(opts.body) : null; const u = String(url);
            posted.push({ url: u, method: (opts && opts.method) || (body ? 'POST' : 'GET'), body });
            if (u.startsWith('/api/bank/match')) return { ok: true, json: async () => MATCH };
            if (u.startsWith('/api/bank/auto-applied/undo')) return status === 200 ? { ok: true, json: async () => ({ ok: true }) } : { ok: false, status, json: async () => ({ error: 'This removes an Edge Metals receipt. Sign in with the Jarvis profile to undo it.' }) };
            if (u.startsWith('/api/bank/auto-applied/resume')) return { ok: true, json: async () => ({ ok: true, lifted: 1 }) };
            if (u.startsWith('/api/bank/auto-applied')) return { ok: true, json: async () => AAD };
            if (u.startsWith('/api/plaid/status')) return { ok: true, json: async () => ({ configured: false, items: [] }) };
            return { ok: true, json: async () => ({ rows: [], entries: [] }) };
        }; } });
}
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
(async () => {
    let dom = makeDom(); await settle(150);
    let doc = dom.window.document; const box = doc.getElementById('autoapplied');
    ck('the card exists and shows how many are live', box && /Placed by Jarvis/.test(box.textContent) && /Placed by Jarvis\s*1/.test(box.textContent.replace(/\s+/g, ' ')), box && box.textContent.slice(0, 120));
    ck('the REASON is on screen for each placement', /one invoice, to the cent/.test(box.textContent) && /a name already matched/.test(box.textContent));
    ck('the invoice and the amount are on screen', /DK-1/.test(box.textContent) && /\+\$5,000\.00/.test(box.textContent));
    ck('a hostile customer name is escaped, not executed', !box.querySelector('img') && /Carlos G & C <img/.test(box.textContent));
    ck('only the live placement has an Undo button and a reason picker', box.querySelectorAll('[data-aa-undo]').length === 1 && box.querySelector('[data-aa-undo]').dataset.aaUndo === 'K7QM' && box.querySelectorAll('select[data-aa-why]').length === 1);
    ck('an undone one says what Jarvis FOUND', /What I found:/.test(box.textContent) && /different Daekwang invoice/.test(box.textContent));
    ck('an undone one with no diagnosis yet says Jarvis is watching', /watching what you do with this deposit/.test(box.textContent));
    ck('paused customers are listed with a Resume button (and the name is escaped)', box.querySelectorAll('[data-aa-resume]').length === 1 && box.querySelector('[data-aa-resume]').dataset.aaResume === 'Daekwang & Co');

    const asks = box.querySelector('[data-aa-asks]');
    ck('open questions are listed with their reason, my guess and the code to answer with', asks && /Waiting for your answer/.test(asks.textContent) && /W4NB/.test(asks.textContent) && /LT-2/.test(asks.textContent) && /ADVANCE/.test(asks.textContent) && /yes CODE \/ no CODE/.test(asks.textContent));
    ck('  a hostile name in a question is escaped; a question with no customer falls back to the bank line', ![...asks.querySelectorAll('b')].some((b) => b.textContent === 'x') && !asks.querySelector('i') && /Lotte <b>x<\/b>/.test(asks.textContent) && /WIRE IN \?\?\?/.test(asks.textContent));
    CONFIRM = false; box.querySelector('[data-aa-undo]').click(); await settle();
    ck('if she says no to the confirmation, nothing is posted', !posted.some((p) => p.url === '/api/bank/auto-applied/undo'));
    CONFIRM = true;
    box.querySelector('select[data-aa-why]').value = 'wrong customer';
    box.querySelector('[data-aa-undo]').click(); await settle();
    const u = posted.find((p) => p.url === '/api/bank/auto-applied/undo');
    ck('Undo posts the code and the chosen reason to the route the server defines', u && u.method === 'POST' && u.body.id === 'K7QM' && u.body.reason === 'wrong customer', JSON.stringify(u));
    ck('  and the card reloads from the server afterwards', posted.filter((p) => p.url === '/api/bank/auto-applied').length >= 2);
    box.querySelector('[data-aa-resume]').click(); await settle();
    const r = posted.find((p) => p.url === '/api/bank/auto-applied/resume');
    ck('Resume posts the customer', r && r.body.customer === 'Daekwang & Co', JSON.stringify(r));

    posted.length = 0; status = 403; dom = makeDom(); await settle(150); doc = dom.window.document;
    doc.querySelector('[data-aa-undo]').click(); await settle();
    ck('when the server refuses (not the Jarvis profile) the card still stands and the message is shown', doc.querySelectorAll('[data-aa-undo]').length === 1 && /Jarvis profile/.test(doc.body.textContent));

    AAD = { on: true, entries: [], blocks: [], asks: [] }; status = 200; dom = makeDom(); await settle(150);
    ck('nothing placed and nothing paused: no card at all', dom.window.document.getElementById('autoapplied').innerHTML.trim() === '');
    AAD = { on: false, entries: AA.entries.slice(0, 1), blocks: [] }; dom = makeDom(); await settle(150);
    ck('switched off but with history: the card says so', /switched off/.test(dom.window.document.getElementById('autoapplied').textContent));
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack || e); process.exit(1); });
