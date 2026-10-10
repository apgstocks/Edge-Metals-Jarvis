// ── tests/bank-redesign.js ────────────────────────────────────────────────
// Apsara, 2026-10-09: "redesign the bank tab mimicking quickbook but in a
// better way", then "build everything", "put it as loan for now", and the
// date range with presets.
//
// What is new, and what each section proves:
//   A  interCompany.detect — pairs, rivals, one-sided, and what it refuses
//   B  interCompany.plan — every way a wrong loan would reach two books
//   C  postings 'inter-company-loan' — both halves or neither
//   D  plaid — update-mode link token, needs-login flag, balances
//   E  rules — guard rails, direction, set aside with the rule as reason
//   F  END TO END over a real server: transfers in and out of the queues,
//      recorded as a loan, read back out of the books, undone; rules;
//      overview cards + coming in; the claim hint; the date range
//   G  the page — renders the new parts, sends the range, calls every route

const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-bank-redesign-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.BANK_LEARN_FILE = path.join(TMP, 'bank-learn.json');
process.env.QB_DECISIONS_FILE = path.join(TMP, 'qb-decisions.json');
process.env.INTER_COMPANY_FILE = path.join(TMP, 'inter-company.json');
process.env.BANK_ACCOUNTS_FILE = path.join(TMP, 'bank-accounts.json');
process.env.APP_PASSWORD = 'user-pw-aaaaaaaaaaa';
process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = 'staff-pw-ccccccccccc';
process.env.JARVIS_PASSWORD = 'jarvis-pw-ddddddddddd';
process.env.PLAID_CLIENT_ID = 'cid-TESTCLIENT123';
process.env.PLAID_SECRET = 'sek-TESTSECRET456';
process.env.PLAID_ENV = 'sandbox';

const ACCOUNTS = [
    { id: 'edge-metals-bofa', company: 'Edge Metals INC', bank: 'Bank of America, N.A.', swift: 'BOFAUS3N', accountNumber: '0000 3301' },
    { id: 'edge-trading-chase', company: 'EDGE TRADING INC', bank: 'JPMorgan Chase Bank, N.A.', swift: 'CHASUS33', accountNumber: '0000 4410' },
];
fs.writeFileSync(process.env.BANK_ACCOUNTS_FILE, JSON.stringify({ accounts: ACCOUNTS }, null, 2));

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP) || !String(cfg.BANK_TX_FILE).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated — refusing to run against real data');
    process.exit(1);
}

const IC = require(path.join(ROOT, 'helpers/interCompany'));
const P = require(path.join(ROOT, 'helpers/postings'));
const PL = require(path.join(ROOT, 'helpers/plaid'));
const BL = require(path.join(ROOT, 'helpers/bankLearn'));
const ledger = require(path.join(ROOT, 'helpers/bankLedger'));
if (!String(PL.ITEM_FILE()).startsWith(TMP) || !String(IC.FILE()).startsWith(TMP)) {
    console.error('  ABORT  a store is outside the temp dir');
    process.exit(1);
}

const row = (id, date, dir, amount, desc, company, extra = {}) => ({
    id, date, direction: dir, spent: dir === 'out' ? amount : 0, received: dir === 'in' ? amount : 0,
    amount, desc, party: '', company, bank: company === 'EDGE TRADING INC' ? 'Chase Bank' : 'BofA',
    account_id: company === 'EDGE TRADING INC' ? 'edge-trading-chase' : 'edge-metals-bofa',
    pending: false, excluded: false, history: [], ...extra });

const ptx = (id, date, amount, name, acc) => ({ transaction_id: id, date, amount, name, account_id: acc, pending: false });
const putRows = (txs) => fs.writeFileSync(cfg.BANK_TX_FILE,
    JSON.stringify(txs.map((x) => ledger.fromPlaid(x, ACCOUNTS)).filter(Boolean), null, 1));

let server = null;

(async () => {

// ── A — DETECT ────────────────────────────────────────────────────────────
{
    section('A — finding money between her companies');
    const M = 'Edge Metals INC', Y = 'EDGE TRADING INC';
    const rows = [
        row('o1', '2026-09-10', 'out', 5000, 'ONLINE TRANSFER TO CHK 3301', Y),
        row('i1', '2026-09-11', 'in', 5000, 'ONLINE TRANSFER FROM CHK 4410', M),
        row('c1', '2026-09-11', 'in', 5000, 'WIRE IN CUSTOMER', Y),             // same company as o1: never a pair
        row('a1', '2026-09-12', 'out', 2000, 'WIRE TO AAA INVESTMENTS LLC', M),
        row('a2', '2026-09-12', 'out', 80, 'AAA ROADSIDE MEMBERSHIP', M),       // bare AAA: not her company
        row('m1', '2026-09-12', 'in', 900, 'WIRE IN BUYER EDGE METALS INC', M), // own name in own account
        row('x1', '2026-09-12', 'out', 777, 'TRANSFER TO EDGE YARD', M, { excluded: true }),
        row('u1', '2026-09-12', 'out', 5000, 'TRANSFER', null),
        row('late', '2026-09-30', 'in', 5000, 'TRANSFER IN', M),                // too far away
    ];
    const f = IC.detect(rows);
    ck('one pair: Edge Yard → Edge Metals', f.pairs.length === 1 && f.pairs[0].from === 'edge-trading'
       && f.pairs[0].to === 'edge-metals' && f.pairs[0].amount === 5000, JSON.stringify(f.pairs.map((p) => p.id)));
    ck('  both sides named, and sure', f.pairs[0].out_row.id === 'o1' && f.pairs[0].in_row.id === 'i1' && f.pairs[0].sure);
    ck('  with the reason in words', /same amount/.test(f.pairs[0].reasons.join(' ')) && /1 day apart/.test(f.pairs[0].reasons.join(' ')));
    ck('a wire naming AAA INVESTMENTS is a one-sided proposal', f.oneSided.some((p) => p.out_row && p.out_row.id === 'a1'
       && p.to === 'aaa-investment' && !p.sure), JSON.stringify(f.oneSided.map((p) => p.id)));
    ck('  bare "AAA" (the motoring club) is not', !f.oneSided.some((p) => (p.out_row || {}).id === 'a2'));
    ck('  her own name in her own account is not', !f.oneSided.some((p) => (p.in_row || {}).id === 'm1'));
    ck('  a set-aside row is not', !JSON.stringify(f).includes('"x1"'));
    ck('  a row with no company is never guessed', !JSON.stringify(f).includes('"u1"'));
    ck('  and a deposit 19 days later is not the partner', !JSON.stringify(f).includes('"late"'));

    const both = IC.detect([row('b2', '2026-09-12', 'out', 10, 'XFER EDGE YARD FOR AAA INVESTMENT', M)]);
    ck('  a line naming TWO sister companies is not guessed into either', both.oneSided.length === 0, JSON.stringify(both.oneSided));

    // Two equally good partners: proposed, but NOT sure.
    const rivals = IC.detect([
        row('o', '2026-09-10', 'out', 3000, 'XFER', Y),
        row('p', '2026-09-11', 'in', 3000, 'XFER', M),
        row('q', '2026-09-09', 'in', 3000, 'XFER', M),
    ]);
    ck('two partners one day either side: not called sure', rivals.pairs.length === 1 && !rivals.pairs[0].sure
       && /fit just as well/.test(rivals.pairs[0].reasons.join(' ')), JSON.stringify(rivals.pairs));
}

// ── B — PLAN ──────────────────────────────────────────────────────────────
{
    section('B — what a confirmation must satisfy');
    const M = 'Edge Metals INC', Y = 'EDGE TRADING INC';
    const rows = [
        row('o1', '2026-09-10', 'out', 5000, 'XFER', Y),
        row('i1', '2026-09-11', 'in', 5000, 'XFER', M),
        row('i2', '2026-09-11', 'in', 4000, 'XFER', M),
        row('mm', '2026-09-11', 'in', 5000, 'XFER', M, { matched: { keys: ['P1'] } }),
    ];
    const err = (b, ex = []) => { try { IC.plan(b, rows, ex); return null; } catch (e) { return e.message; } };
    const ok = IC.plan({ from: 'edge-trading', to: 'edge-metals', out_id: 'o1', in_id: 'i1' }, rows);
    ck('a good pair plans: Chase 1020 out, BofA 1010 in, as a loan',
       ok.from_bank === '1020' && ok.to_bank === '1010' && ok.treatment === 'loan' && ok.amount === 5000, JSON.stringify(ok));
    ck('  the same company twice is refused', /inside one company/.test(err({ from: 'edge-metals', to: 'edge-metals', in_id: 'i1' })));
    ck('  an unknown company is refused', /must be one of/.test(err({ from: 'nope', to: 'edge-metals', in_id: 'i1' })));
    ck('  a row in the wrong company\'s account is refused',
       /Edge Metals's account, not Edge Yard's/.test(err({ from: 'edge-trading', to: 'edge-metals', out_id: 'i1' }) || '')
       || /money in, not out/.test(err({ from: 'edge-trading', to: 'edge-metals', out_id: 'i1' }) || ''));
    ck('  two different amounts are refused', /different amounts/.test(err({ from: 'edge-trading', to: 'edge-metals', out_id: 'o1', in_id: 'i2' })));
    ck('  a row already matched to a payment is refused', /already matched/.test(err({ from: 'edge-trading', to: 'edge-metals', out_id: 'o1', in_id: 'mm' })));
    ck('  a row already in a transfer is refused', /already recorded/.test(err({ from: 'edge-trading', to: 'edge-metals', out_id: 'o1' }, [{ bank_rows: ['o1'] }])));
    ck('  no bank row at all is refused', /at least one bank row/.test(err({ from: 'edge-trading', to: 'edge-metals' })));
    ck('  a treatment other than loan is refused, for now', /only loan/.test(err({ from: 'edge-trading', to: 'edge-metals', out_id: 'o1', treatment: 'owner' })));
    ck('  an amount that moved since the page loaded is refused', /reload/.test(err({ from: 'edge-trading', to: 'edge-metals', out_id: 'o1', amount: 4999 })));
}

// ── B2 — A FAILED TICK TAKES THE LOAN BACK OUT ────────────────────────────
{
    section('B2 — the bank rows could not be ticked, so nothing is recorded');
    fs.writeFileSync(cfg.BANK_TX_FILE, JSON.stringify([
        row('zo', '2026-09-10', 'out', 700, 'XFER', 'EDGE TRADING INC'),
        row('zi', '2026-09-10', 'in', 700, 'XFER', 'Edge Metals INC')]));
    const real = ledger.markMatched;
    ledger.markMatched = async () => null;          // the shape of a swallowed write failure
    let why = null;
    try { await IC.record({ from: 'edge-trading', to: 'edge-metals', out_id: 'zo', in_id: 'zi' }); } catch (e) { why = e.message; }
    ledger.markMatched = real;
    ck('record() refuses when markMatched hands back nothing', /nothing was recorded/.test(why || ''), String(why));
    ck('  and the store holds no loan', IC.list().length === 0, JSON.stringify(IC.list()));
    fs.writeFileSync(cfg.BANK_TX_FILE, '[]');
}

// ── C — POSTING ───────────────────────────────────────────────────────────
{
    section('C — a loan on both sets of books, or on neither');
    const out = P.post('inter-company-loan', { entity: 'edge-trading', borrower: 'edge-metals', amount: 5000,
        fromBank: '1020', toBank: '1010', date: '2026-09-10' });
    const line = (e, a, side) => out.lines.find((l) => l.entity === e && l.account === a && l[side] === 5000);
    ck('lender: Dr 1400 Due from related companies', !!line('edge-trading', '1400', 'debit'), JSON.stringify(out));
    ck('  Cr its own bank (Chase 1020)', !!line('edge-trading', '1020', 'credit'));
    ck('borrower: Dr its own bank (BofA 1010)', !!line('edge-metals', '1010', 'debit'));
    ck('  Cr 2400 Due to related companies', !!line('edge-metals', '2400', 'credit'));
    ck('  four lines, nothing else, no problems', out.lines.length === 4 && out.problems.length === 0);
    ck('  and none of it touches income', !out.lines.some((l) => /^4/.test(l.account)));
    const bad = P.post('inter-company-loan', { entity: 'edge-trading', borrower: 'edge-metals', amount: 5000, fromBank: '1020', toBank: null });
    ck('an unknown bank on one side posts NEITHER half', bad.lines.length === 0 && bad.problems.length === 1, JSON.stringify(bad));
    const self = P.post('inter-company-loan', { entity: 'edge-metals', borrower: 'edge-metals', amount: 5, fromBank: '1010', toBank: '1010' });
    ck('  a company lending to itself posts nothing', self.lines.length === 0);
    const j = P.journal([{ kind: 'inter-company-loan', entity: 'aaa-investment', borrower: 'edge-metals', amount: 1234.56,
        fromBank: '1010', toBank: '1010', date: '2026-09-01' }]);
    ck('  the journal still balances', j.balanced === true, JSON.stringify({ b: j.balanced, p: j.problems }));
}

// ── D — PLAID ─────────────────────────────────────────────────────────────
const TOKEN = 'access-sandbox-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
{
    section('D — signing in again, and the flag that says it is needed');
    fs.writeFileSync(PL.ITEM_FILE(), JSON.stringify({ items: [{ item_id: 'item-1', access_token: TOKEN,
        institution: 'Bank of America', accounts: [{ account_id: 'pa-1', mask: '3301' }] }] }));
    const sent = [];
    const fake = (script) => async (url, opts) => {
        const body = JSON.parse(opts.body); const ep = String(url).replace(/^https?:\/\/[^/]+/, '');
        sent.push({ ep, body });
        const r = script[ep];
        if (!r) return { ok: false, status: 400, text: async () => JSON.stringify({ error_code: 'NO_STUB' }) };
        if (r.__http) return { ok: false, status: r.__http, text: async () => JSON.stringify(r.payload) };
        return { ok: true, status: 200, text: async () => JSON.stringify(r) };
    };
    const LT = { '/link/token/create': { link_token: 'link-sandbox-upd', expiration: 'x' } };

    const upd = await PL.linkToken({ fetchImpl: fake(LT), itemId: 'item-1' });
    const b = sent[sent.length - 1].body;
    ck('update mode sends the item\'s access token to Plaid', b.access_token === TOKEN);
    ck('  and leaves products out, as Plaid requires', b.products === undefined, JSON.stringify(Object.keys(b)));
    ck('  and the answer to the browser carries no token', !JSON.stringify(upd).includes(TOKEN) && upd.mode === 'update', JSON.stringify(upd));
    await PL.linkToken({ fetchImpl: fake(LT) });
    const b2 = sent[sent.length - 1].body;
    ck('a NEW link is unchanged: products, and no access token',
       JSON.stringify(b2.products) === '["transactions"]' && b2.access_token === undefined);
    let why = null; try { await PL.linkToken({ fetchImpl: fake(LT), itemId: 'nope' }); } catch (e) { why = e.message; }
    ck('  update mode for a bank that is not linked is refused', /no linked item/.test(why || ''));

    await PL.markNeedsLogin('item-1', 'ITEM_LOGIN_REQUIRED');
    const pub = PL.itemsPublic()[0];
    ck('the flag is stored on the item and visible to the screen', pub.needs_login && pub.needs_login.code === 'ITEM_LOGIN_REQUIRED');
    ck('  without the token', !JSON.stringify(PL.itemsPublic()).includes(TOKEN));

    await PL.syncItem('item-1', { fetchImpl: fake({ '/transactions/sync': { added: [], modified: [], removed: [],
        next_cursor: 'c1', has_more: false,
        accounts: [{ account_id: 'pa-1', balances: { current: 148320.55, available: 147000, iso_currency_code: 'USD' } }] } }) });
    const after = PL.itemsPublic()[0];
    ck('a good pull clears the flag', after.needs_login === null, JSON.stringify(after.needs_login));
    ck('  and keeps the balance Plaid sent with it — no billed balance call',
       after.balances && after.balances['pa-1'].current === 148320.55
       && !sent.some((s) => s.ep === '/accounts/balance/get'), JSON.stringify(after.balances));

    const outSync = await PL.syncAll({ fetchImpl: fake({ '/transactions/sync': { __http: 400,
        payload: { error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'the login details of this item have changed' } } }) });
    ck('a pull that fails with ITEM_LOGIN_REQUIRED reports it', outSync.errors.length === 1, JSON.stringify(outSync.errors));
    ck('  and sets the flag, so the screen shows Sign in again',
       (PL.itemsPublic()[0].needs_login || {}).code === 'ITEM_LOGIN_REQUIRED', JSON.stringify(PL.itemsPublic()[0].needs_login));
    await PL.clearNeedsLogin('item-1');
    ck('  and clearing it works', PL.itemsPublic()[0].needs_login === null);
    // The rest of this file has no linked bank.
    fs.writeFileSync(PL.ITEM_FILE(), JSON.stringify({ items: [] }));
}

// ── E — RULES ─────────────────────────────────────────────────────────────
{
    section('E — "lines like this are always a bank charge"');
    const err = (b) => { try { BL.cleanRule(b); return null; } catch (e) { return e.message; } };
    ck('three letters is not a rule', /four letters/.test(err({ text: 'FEE', direction: 'out', label: 'Bank charge' })));
    ck('  digits alone are not a rule', /four letters/.test(err({ text: '123456', direction: 'out', label: 'x' })));
    ck('  a rule has a direction', /money in or money out/.test(err({ text: 'WIRE FEE', label: 'x' })));
    ck('  and says what the lines are', /say what/.test(err({ text: 'WIRE FEE', direction: 'out' })));
    const r = BL.cleanRule({ text: '  wire  in fee ', direction: 'out', label: 'Bank charge' });
    ck('the text is normalised', r.text === 'WIRE IN FEE');
    const M = 'Edge Metals INC';
    const hits = BL.ruleHits(r, [
        row('f1', '2026-09-01', 'out', 15, 'WIRE IN FEE 0911', M),
        row('f2', '2026-09-01', 'in', 15, 'WIRE IN FEE REVERSAL', M),          // other direction
        row('f3', '2026-09-01', 'out', 15, 'WIRE IN FEE 0912', M, { excluded: true }),
        row('f4', '2026-09-01', 'out', 15, 'WIRE IN FEE 0913', M, { matched: { keys: ['x'] } }),
    ]);
    ck('a money-out rule hits only live money-out lines', hits.map((h) => h.id).join(',') === 'f1', hits.map((h) => h.id).join(','));
}

// ── F — END TO END ────────────────────────────────────────────────────────
const { createApi } = require(path.join(ROOT, 'api'));
const app = createApi();
server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const req = (method, p, { body, sid } = {}) => new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (sid) headers.Authorization = `Bearer ${sid}`;
    const r2 = http.request(base + p, { method, headers }, (res) => {
        let raw = ''; res.on('data', (c) => { raw += c; });
        res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j, raw }); });
    });
    r2.on('error', reject); if (data) r2.write(data); r2.end();
});
const sid = ((await req('POST', '/login', { body: { password: process.env.ADMIN_PASSWORD } })).json || {}).sid;
const userSid = ((await req('POST', '/login', { body: { password: process.env.APP_PASSWORD } })).json || {}).sid;
const BB = require(path.join(ROOT, 'helpers/booksBuild'));
const sales = require(path.join(ROOT, 'helpers/sales'));
const bal = (entity, account) => {
    const ls = BB.build({}).lines.filter((l) => l.entity === entity && l.account === account);
    return Math.round(ls.reduce((t, l) => t + l.debit - l.credit, 0) * 100) / 100;
};

{
    section('F1 — a transfer leaves both queues and waits under "Between your companies"');
    // Signed the way Plaid sends them: positive = money out.
    putRows([
        ptx('T-OUT', '2026-09-10', 5000, 'ONLINE TRANSFER TO EDGE METALS', 'edge-trading-chase'),
        ptx('T-IN', '2026-09-11', -5000, 'ONLINE TRANSFER FROM EDGE TRADING', 'edge-metals-bofa'),
        ptx('AAA-W', '2026-09-12', 2000, 'WIRE TO AAA INVESTMENTS', 'edge-metals-bofa'),
        ptx('FEE-1', '2026-09-13', 15, 'WIRE IN FEE 091301', 'edge-metals-bofa'),
        ptx('FEE-2', '2026-09-20', 15, 'WIRE IN FEE 092002', 'edge-metals-bofa'),
    ]);
    const m = await req('GET', '/api/bank/match', { sid });
    ck('the match route answers', m.status === 200, m.raw.slice(0, 200));
    ck('  the transfer deposit is NOT offered against an invoice',
       !(m.json.rows || []).some((r) => r.deposit.id === 'T-IN'), JSON.stringify((m.json.rows || []).map((r) => r.deposit.id)));
    ck('  it is named under transfer_rows instead', (m.json.transfer_rows || []).some((r) => r.id === 'T-IN'));
    const rv = await req('GET', '/api/bank/review', { sid });
    ck('the money-out queue does not ask about the transfer or the AAA wire',
       rv.status === 200 && !(rv.json.queue.rows || []).some((r) => ['T-OUT', 'AAA-W'].includes(r.id)),
       JSON.stringify((rv.json.queue.rows || []).map((r) => r.id)));
    const t = await req('GET', '/api/intercompany/transfers', { sid });
    ck('the transfers route proposes the pair', t.status === 200 && (t.json.proposed || []).length === 1
       && t.json.proposed[0].from === 'edge-trading' && t.json.proposed[0].sure, t.raw.slice(0, 300));
    ck('  and the AAA wire as one-sided', (t.json.one_sided || []).some((p) => p.out_row.id === 'AAA-W' && p.to === 'aaa-investment'));
    ck('  and says the treatment is a loan', t.json.treatment === 'loan');
}

{
    section('F2 — recorded as a loan, read back out of the books');
    const before = { y1400: bal('edge-trading', '1400'), y1020: bal('edge-trading', '1020'),
        m1010: bal('edge-metals', '1010'), m2400: bal('edge-metals', '2400'), m4000: bal('edge-metals', '4000') };
    const p = { from: 'edge-trading', to: 'edge-metals', out_id: 'T-OUT', in_id: 'T-IN', amount: 5000 };
    const denied = await req('POST', '/api/intercompany/transfers', { sid: userSid, body: p });
    ck('a non-admin cannot record one', denied.status === 403, String(denied.status));
    const r = await req('POST', '/api/intercompany/transfers', { sid, body: p });
    ck('an admin can', r.status === 200 && r.json.transfer && r.json.transfer.treatment === 'loan', r.raw.slice(0, 300));
    const tid = r.json.transfer.id;
    ck('Edge Yard is owed 5,000 by a related company (1400 +5,000)', bal('edge-trading', '1400') - before.y1400 === 5000);
    ck('  and its Chase account went down (1020 −5,000)', bal('edge-trading', '1020') - before.y1020 === -5000);
    ck('Edge Metals\' BofA went up (1010 +5,000)', bal('edge-metals', '1010') - before.m1010 === 5000);
    ck('  and it owes a related company (2400 −5,000, a credit)', bal('edge-metals', '2400') - before.m2400 === -5000);
    ck('  and its income did not move', bal('edge-metals', '4000') === before.m4000);
    const rows = ledger.list();
    ck('both bank rows are ticked as this transfer',
       ['T-OUT', 'T-IN'].every((id) => ((rows.find((x) => x.id === id) || {}).matched || {}).keys.includes('transfer:' + tid)));
    const again = await req('POST', '/api/intercompany/transfers', { sid, body: p });
    ck('pressing it twice books nothing more', again.status === 400 && bal('edge-trading', '1400') - before.y1400 === 5000, again.raw);
    const m = await req('GET', '/api/bank/match', { sid });
    ck('the recorded deposit does not come back as an unknown payer',
       !(m.json.rows || []).some((x) => x.deposit.id === 'T-IN'), JSON.stringify((m.json.rows || []).map((x) => x.deposit.id)));
    const t = await req('GET', '/api/intercompany/transfers', { sid });
    ck('it is listed as recorded and no longer proposed', (t.json.recorded || []).length === 1 && (t.json.proposed || []).length === 0);

    const u = await req('DELETE', '/api/intercompany/transfers', { sid, body: { id: tid } });
    ck('Undo works', u.status === 200, u.raw);
    ck('  the loan is off both books', bal('edge-trading', '1400') === before.y1400 && bal('edge-metals', '2400') === before.m2400);
    ck('  and the rows are back in play', !ledger.list().find((x) => x.id === 'T-IN').matched
       && ((await req('GET', '/api/intercompany/transfers', { sid })).json.proposed || []).length === 1);

    const one = await req('POST', '/api/intercompany/transfers', { sid, body: { from: 'edge-metals', to: 'aaa-investment', out_id: 'AAA-W' } });
    ck('the one-sided AAA wire records too', one.status === 200, one.raw);
    ck('  Edge Metals lent 2,000 (1400 +2,000)', bal('edge-metals', '1400') === 2000);
    ck('  AAA Investment owes it (2400 −2,000) and its bank shows the money (1010 +2,000)',
       bal('aaa-investment', '2400') === -2000 && bal('aaa-investment', '1010') === 2000);
    ck('the books still balance', BB.build({}).journal.balanced === true);
}

{
    section('F3 — a rule, from a row, set aside with the rule as the reason');
    const body = { text: 'WIRE IN FEE', direction: 'out', label: 'Bank charge' };
    ck('a non-admin cannot make one', (await req('POST', '/api/bank/rules', { sid: userSid, body })).status === 403);
    const dry = await req('POST', '/api/bank/rules', { sid, body: { ...body, dry: true } });
    ck('a dry run says how many lines and changes nothing', dry.status === 200 && dry.json.would === 2
       && !ledger.list().some((r) => r.excluded), dry.raw);
    const r = await req('POST', '/api/bank/rules', { sid, body });
    ck('saving applies it now', r.status === 200 && r.json.applied === 2, r.raw);
    const fee = ledger.list().find((x) => x.id === 'FEE-1');
    ck('  each line is set aside, with the rule as the reason', fee.excluded && /Bank charge — rule "WIRE IN FEE"/.test(fee.excluded_reason), fee.excluded_reason);
    const list = await req('GET', '/api/bank/rules', { sid });
    ck('the rule is listed with the labels', (list.json.rules || []).length === 1 && (list.json.labels || []).includes('Bank charge'));
    const d = await req('DELETE', '/api/bank/rules', { sid, body: { text: 'WIRE IN FEE', direction: 'out' } });
    ck('deleting the rule works', d.status === 200);
    ck('  and leaves what it set aside where it is', ledger.list().find((x) => x.id === 'FEE-1').excluded === true);

    // The Set aside tab lists each line, with its reason, and Put back works.
    const sa = await req('GET', '/api/bank/set-aside', { sid });
    const feeRow = (sa.json.rows || []).find((x) => x.id === 'FEE-1');
    ck('the set-aside route lists each line', sa.status === 200 && sa.json.count === 2 && !!feeRow, sa.raw.slice(0, 300));
    ck('  with the reason and the money', feeRow && /rule "WIRE IN FEE"/.test(feeRow.reason) && feeRow.amount === 15 && feeRow.direction === 'out');
    const ranged = await req('GET', '/api/bank/set-aside?from=2026-09-15&to=2026-09-30', { sid });
    ck('  and respects the dates', ranged.json.count === 1 && ranged.json.rows[0].id === 'FEE-2', JSON.stringify(ranged.json.rows));
    const back = await req('POST', '/api/bank/include', { sid, body: { id: 'FEE-1' } });
    ck('Put back returns the line to the queue', back.status === 200 && !ledger.list().find((x) => x.id === 'FEE-1').excluded
       && !((await req('GET', '/api/bank/set-aside', { sid })).json.rows || []).some((x) => x.id === 'FEE-1'));
}

{
    section('F4 — account cards, coming in, and the date range');
    await sales.addSale({ customer: 'Twins Metal LLC', invoice_no: 'EM-5001', date: '2026-09-01', item: 'Auto Cast',
        weight: 1000, invoice_price: 10, price_unit: 'lb', weight_unit: 'lb' });
    const o = await req('GET', '/api/bank/overview', { sid });
    ck('the overview route answers', o.status === 200, o.raw.slice(0, 200));
    const metals = (o.json.accounts || []).find((a) => a.key === 'edge-metals-bofa');
    const yard = (o.json.accounts || []).find((a) => a.key === 'edge-trading-chase');
    ck('one card per company account: Edge Metals BofA ••3301 and Edge Yard Chase ••4410',
       metals && metals.company === 'Edge Metals' && metals.mask === '3301' && yard && yard.company === 'Edge Yard' && yard.bank === 'Chase',
       JSON.stringify(o.json.accounts));
    ck('  AAA Investment is named as not set up rather than left out',
       (o.json.missing || []).some((x) => x.entity === 'aaa-investment'));
    ck('  Edge Metals\' card counts what moved: in 5,000 · out 2,030',
       metals.in === 5000 && metals.out === 2030, JSON.stringify({ in: metals.in, out: metals.out }));
    ck('  no balance is invented when Plaid sent none', metals.balance === null);
    ck('coming in lists the open invoice', (o.json.coming_in.invoices || []).some((x) => x.invoice_no === 'EM-5001' && x.open === 10000)
       && o.json.coming_in.total >= 10000, JSON.stringify(o.json.coming_in));
    const ranged = await req('GET', '/api/bank/overview?from=2026-09-12&to=2026-09-30', { sid });
    const m2 = (ranged.json.accounts || []).find((a) => a.key === 'edge-metals-bofa');
    ck('the date range narrows the card: in 0 · out 2,030 from the 12th', m2.in === 0 && m2.out === 2030, JSON.stringify(m2));
    const tr = await req('GET', '/api/intercompany/transfers?from=2026-09-20&to=2026-09-30', { sid });
    ck('  and the transfers list', (tr.json.recorded || []).length === 0);
}

{
    section('F5 — a short payment that looks like her customer\'s claim');
    const sale = sales.listWithTotals().find((s) => s.invoice_no === 'EM-5001');
    fs.writeFileSync(cfg.CLAIMS_FILE, JSON.stringify([{ id: 'CL-1', invoice_no: 'EM-5001', container_no: 'X',
        claim_amount: 300, status: 'verified' }]));
    putRows([...ledger.list().map((r) => r.raw),
        ptx('TW-1', '2026-09-25', -9700, 'WIRE IN TWINS METAL LLC', 'edge-metals-bofa')]);
    await req('POST', '/api/bank/aliases', { sid, body: { descriptor: 'WIRE IN TWINS METAL LLC', customer: 'Twins Metal LLC' } });
    const m = await req('GET', '/api/bank/match', { sid });
    const r = (m.json.rows || []).find((x) => x.deposit.id === 'TW-1');
    ck('the deposit is proposed against the invoice', r && (r.proposals || []).length > 0, JSON.stringify(r));
    ck('  and carries the claim hint: 300 left, claim CL-1 for 300',
       r && r.claim_hint && r.claim_hint.claim_id === 'CL-1' && r.claim_hint.gap === 300, JSON.stringify(r && r.claim_hint));
    ck('  nothing about the claim was changed', JSON.parse(fs.readFileSync(cfg.CLAIMS_FILE, 'utf8'))[0].status === 'verified');
    ck('  and the invoice is still open', sales.listWithTotals().find((s) => s.id === sale.id).balance === 10000);
}

server.close();

// ── G — THE PAGE ──────────────────────────────────────────────────────────
{
    section('G — the screen');
    const { JSDOM } = require('jsdom');
    const HTML = fs.readFileSync(path.join(ROOT, 'dashboard/bank-match.html'), 'utf8');
    const urls = [];
    const RESP = {
        '/api/bank/match': { rows: [
            { deposit: { id: 'D1', date: '2026-10-08', amount: 24850, descriptor: 'WIRE IN CUSTOMER A', bank_guess: 'BofA' }, party: 'Customer A', outcome: 'proposed', ambiguous: false,
              proposals: [{ kind: 'exact', score: 0.99, allocations: [{ doc_id: 'S1', label: 'EM-0412 (Auto Cast)', amount: 24850, shortfall: 0, clears: true }], reasons: ['one invoice, to the cent'] }] },
            { deposit: { id: 'D2', date: '2026-10-07', amount: 9700, descriptor: 'WIRE IN CUSTOMER E', bank_guess: 'BofA' }, party: 'Customer E', outcome: 'proposed', ambiguous: false,
              proposals: [{ kind: 'exact', score: 0.9, allocations: [{ doc_id: 'S2', label: 'EM-0420', amount: 9700, shortfall: 300, clears: true }], reasons: ['short'] }] },
            { deposit: { id: 'D3', date: '2026-10-05', amount: 3400, descriptor: 'DEPOSIT REF 88213' }, outcome: 'no_party', ambiguous: false, proposals: [], suggestions: [] },
            { deposit: { id: 'D4', date: '2026-10-04', amount: 10000, descriptor: 'WIRE IN C TRADING', bank_guess: 'BofA' }, party: 'Customer C', outcome: 'proposed', ambiguous: false,
              proposals: [{ kind: 'partial', score: 0.9, allocations: [{ doc_id: 'S3', label: 'EM-0388', amount: 10000, shortfall: 0, clears: false, leaves: 5200 }], reasons: ['part'] }] }],
          counts: { deposits: 4, confident: 2, no_party: 1 }, totals: { confident: 34550, needs_you: 3400 }, open_invoices: 6, customers_with_open: 5,
          ledger: { excluded: { count: 1, money: 15 }, pending: { count: 0 } }, feed: 'bank-transactions.json', modes: ['Wire'], banks: ['BofA'] },
        '/api/bank/set-aside': { count: 1, money: 15, rows: [{ id: 'F1', date: '2026-10-04', desc: 'WIRE IN FEE <i>', amount: 15, direction: 'out', reason: 'Bank charge — rule "WIRE IN FEE"' }] },
        '/api/bank/overview': { accounts: [
            { key: 'a', company: 'Edge Metals', bank: 'Bank of America', mask: '3301', linked: true, item_id: 'item-1', institution: 'Bank of America', last_sync_at: '2026-10-08T05:45:00Z', needs_login: null, balance: 148320.55, balance_as_of: '2026-10-08T05:45:00Z', in: 0, out: 0, rows: 0 },
            { key: 'b', company: 'Edge Yard', bank: 'Chase', mask: '4410', linked: true, item_id: 'item-2', institution: 'Chase', needs_login: { code: 'ITEM_LOGIN_REQUIRED' }, balance: null, in: 100, out: 50, rows: 2 }],
            missing: [{ entity: 'aaa-investment', company: 'AAA Investment' }],
            coming_in: { total: 10000, count: 1, invoices: [{ customer: 'Carlos G & C <i>', invoice_no: 'EM-1', open: 10000, days: 75 }] } },
        '/api/intercompany/transfers': { proposed: [{ id: 'pair:o|i', from: 'edge-trading', to: 'edge-metals', amount: 5000, date: '2026-09-10', sure: true,
            out_row: { id: 'o', date: '2026-09-10', desc: 'XFER <b>' }, in_row: { id: 'i', date: '2026-09-11', desc: 'XFER' }, reasons: ['r'] }], one_sided: [], recorded: [] },
        '/api/bank/review': { queue: { rows: [{ id: 'f', date: '2026-09-13', descriptor: 'WIRE IN FEE 091301', amount: 15, state: 'add', label: 'Add', why: 'x' }], counts: {} } },
        '/api/bank/reconcile': { banks: [], feed: { ok: true }, journal: { complete: true } },
        '/api/plaid/status': { configured: true, env: 'production', items: [{ item_id: 'item-2', institution: 'Chase', needs_login: { code: 'ITEM_LOGIN_REQUIRED' }, accounts: [] }] },
        '/api/bank/rules': { rules: [], labels: ['Bank charge'] },
    };
    const posted = [];
    const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'https://localhost/bank-match', beforeParse: (w) => {
        w.fetch = async (u, o) => {
            urls.push(String(u));
            if (o && o.body) posted.push({ u: String(u), method: o.method, body: JSON.parse(o.body) });
            const k = String(u).split('?')[0];
            return { ok: !!RESP[k] || (o && o.body), json: async () => RESP[k] || { ok: true } };
        };
        w.localStorage.setItem('bank.range', JSON.stringify({ preset: 'lastyear' }));
    } });
    await new Promise((r) => setTimeout(r, 60));
    const d = dom.window.document;
    const y = new Date().getFullYear() - 1;
    ck('the time frames are a dropdown, showing the remembered one',
       d.getElementById('preset').tagName === 'SELECT' && d.getElementById('preset').value === 'lastyear'
       && [...d.querySelectorAll('#preset option')].map((o) => o.value).join(',') === 'all,month,lastmonth,year,lastyear,custom');
    ck('a remembered preset is applied to the date boxes', d.getElementById('from').value === `${y}-01-01` && d.getElementById('to').value === `${y}-12-31`);
    ck('  and sent to every bank read', ['/api/bank/match', '/api/bank/review', '/api/bank/reconcile', '/api/bank/overview', '/api/intercompany/transfers']
       .every((p) => urls.some((u) => u.startsWith(p + '?') && u.includes(`from=${y}-01-01`) && u.includes(`to=${y}-12-31`))), urls.join(' '));
    ck('  but not to the feed status, which has no dates', urls.some((u) => u === '/api/plaid/status'));
    const accts = d.getElementById('accounts').textContent;
    ck('account cards: company, bank, mask, balance', /Edge Metals/.test(accts) && /••3301/.test(accts) && /\$148,320\.55/.test(accts), accts.slice(0, 200));
    ck('  the Chase card says it needs signing in', /Needs you to sign in/.test(accts));
    // A slim line under the cards since 2026-10-10, not a card of its own.
    const miss = d.getElementById('missing').textContent;
    ck('  AAA Investment is shown as not set up', /AAA Investment/.test(miss) && /Not set up/.test(miss), miss);
    ck('the repair banner offers Sign in again on THAT bank', !!d.querySelector('#repair [data-plaid="reconnect"][data-item="item-2"]'));
    ck('  and so does the feed panel', !!d.querySelector('#feed [data-plaid="reconnect"][data-item="item-2"]'));
    ck('coming in is shown, with names escaped', /\$10,000\.00/.test(d.getElementById('coming').textContent)
       && !d.querySelector('#coming i'), d.getElementById('coming').innerHTML.slice(0, 200));
    const tcard = d.querySelector('#transfers .tcard');
    ck('the transfer is shown: Edge Yard → Edge Metals', tcard && /Edge Yard → Edge Metals/.test(tcard.textContent));
    ck('  escaped', tcard && !tcard.querySelector('b'));
    ck('  with Record as a loan', !!d.querySelector('[data-transfer="pair:o|i"]'));
    ck('a money-out line that would create a record gets the rule offer', !!d.querySelector('#review [data-rule-desc]'));

    d.querySelector('[data-transfer="pair:o|i"]').click();
    await new Promise((r) => setTimeout(r, 30));
    const tp = posted.find((p) => p.u === '/api/intercompany/transfers');
    ck('pressing it posts both rows and the companies', tp && tp.body.out_id === 'o' && tp.body.in_id === 'i'
       && tp.body.from === 'edge-trading' && tp.body.treatment === 'loan', JSON.stringify(tp));

    // Picking a preset reloads with that range; a From after To is refused.
    urls.length = 0;
    d.getElementById('preset').value = 'all';
    d.getElementById('preset').dispatchEvent(new dom.window.Event('change'));
    await new Promise((r) => setTimeout(r, 30));
    ck('"All dates" sends no range', urls.some((u) => u === '/api/bank/match') && !urls.some((u) => u.includes('from=')), urls.join(' '));
    urls.length = 0;
    d.getElementById('from').value = '2026-09-30';
    d.getElementById('from').dispatchEvent(new dom.window.Event('change'));
    await new Promise((r) => setTimeout(r, 30));
    ck('choosing a From date reloads with it', urls.some((u) => u === '/api/bank/match?from=2026-09-30'), urls.join(' '));
    urls.length = 0;
    d.getElementById('to').value = '2026-09-01';
    d.getElementById('to').dispatchEvent(new dom.window.Event('change'));
    await new Promise((r) => setTimeout(r, 30));
    ck('  a To before the From is refused, not loaded', !urls.some((u) => u.startsWith('/api/bank/match'))
       && [...d.querySelectorAll('.toast')].some((t) => /after the To/.test(t.textContent)));

    // Money in / out filter hides the other block.
    d.querySelector('#dir [data-dir="in"]').click();
    ck('"Money in" hides the money-out list', d.getElementById('review').hidden === true && d.getElementById('inblock').hidden === false);
    d.querySelector('[data-tab="recon"]').click();
    ck('tabs switch panes', d.querySelector('[data-pane="recon"]').hidden === false && d.querySelector('[data-pane="review"]').hidden === true);

    // ── the round-2 layout (2026-10-10, "build everything") ──
    const r1 = d.querySelector('#list .row[data-i="0"]'), r2 = d.querySelector('#list .row[data-i="1"]'), r3 = d.querySelector('#list .row[data-i="2"]');
    ck('each deposit is one collapsed line', r1 && !r1.classList.contains('open') && !!r1.querySelector('.sum') && !!r1.querySelector('.detail'));
    ck('  the line says what Jarvis thinks and the amount', /Pays EM-0412/.test(r1.querySelector('.sum').textContent)
       && /\$24,850\.00/.test(r1.querySelector('.sum .amt').textContent), r1.querySelector('.sum').textContent);
    ck('  a clean, sure row can be confirmed from the line', !!r1.querySelector('.sum [data-confirm]'));
    ck('  a short row cannot — its line button opens it, because the fee-or-discount question comes first',
       !r2.querySelector('.sum [data-confirm]') && !!r2.querySelector('.sum [data-open]') && /short \$300\.00/.test(r2.querySelector('.sum').textContent));
    ck('  nor can a part payment', (() => { const rr = d.querySelector('#list .row[data-i="3"]'); return rr && !rr.querySelector('.sum [data-confirm]') && /leaves/.test(rr.querySelector('.sum').textContent); })());
    ck('  an unknown payer\'s line says Name payer', /Name payer/.test(r3.querySelector('.sum').textContent));
    r1.querySelector('.sum .who').click();
    ck('clicking the line opens the row', r1.classList.contains('open') && r1.querySelector('.sum').getAttribute('aria-expanded') === 'true');
    r1.querySelector('.sum .who').click();
    ck('  and again closes it', !r1.classList.contains('open'));
    r2.querySelector('[data-open]').click();
    ck('  Review opens it too', r2.classList.contains('open'));
    const chipsTxt = d.getElementById('chips').textContent;
    ck('the summary line keeps the counts but drops the repeats', /2 ready/.test(chipsTxt) && /1 excluded/.test(chipsTxt)
       && !/open invoices/.test(chipsTxt) && !/reload/i.test(chipsTxt), chipsTxt);
    ck('  and Reload moved to the header', !!d.querySelector('header [data-reload]'));
    ck('coming in is one closed line until opened', d.querySelector('#coming details.coming') && !d.querySelector('#coming details').open
       && /oldest 75 days/.test(d.getElementById('coming').textContent));
    const card0 = d.querySelector('#accounts .acct');
    ck('every account card shows in and out first, balance as a second line',
       /in\s*\$0\.00/.test(card0.querySelector('.big').textContent) && /Balance \$148,320\.55/.test(card0.querySelector('.bal').textContent));
    ck('a money-out line that would create a record shows a muted label, not a box',
       !!d.querySelector('#review .sum .needs') && !d.querySelector('#review .chip'));
    const aside = d.getElementById('asidelist');
    ck('Set aside lists each line with its reason, escaped', /rule "WIRE IN FEE"/.test(aside.textContent) && !aside.querySelector('i'));
    aside.querySelector('[data-include="F1"]').click();
    await new Promise((r) => setTimeout(r, 30));
    ck('  and Put back posts to the include route', posted.some((p) => p.u === '/api/bank/include' && p.body.id === 'F1'));

    // Every new route has a caller on this page.
    for (const u of ['/api/bank/overview', '/api/bank/rules', '/api/plaid/reconnected', '/api/intercompany/transfers', '/api/bank/set-aside', '/api/bank/include']) {
        ck(`the page calls ${u}`, HTML.includes(`'${u}'`));
    }
    ck('  including DELETE on transfers and rules',
       /api\('\/api\/intercompany\/transfers', \{ method: 'DELETE'/.test(HTML) && /api\('\/api\/bank\/rules', \{ method: 'DELETE'/.test(HTML));
    const ir = fs.readFileSync(path.join(ROOT, 'helpers/interCompanyRoutes.js'), 'utf8');
    ck('the transfers routes are mounted', /require\('\.\/helpers\/interCompanyRoutes'\)\.mount\(app\)/.test(fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8'))
       && /app\.post\('\/api\/intercompany\/transfers'/.test(ir) && /app\.delete\('\/api\/intercompany\/transfers'/.test(ir));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('threw:', e && e.stack); if (server) server.close(); process.exit(1); });
