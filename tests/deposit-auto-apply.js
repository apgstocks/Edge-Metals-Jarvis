// tests/deposit-auto-apply.js — certain deposits placed by Jarvis, with a reason, an undo, and learning from the undo.
// Apsara, 2026-11-09. END TO END (CLAUDE.md rule 3): a real server, deposits written the way the Plaid sync writes them,
// the proposals read through the same function the screen's route uses, the undo pressed through the route the
// Bank page posts to, and the figures read back out of the Sales balances. DELTAS, not absolutes.
const fs = require('fs'), os = require('os'), http = require('http'), path = require('path');
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-autoapply-'));
process.env.DATA_DIR = TMP; process.env.JARVIS_TEST = '1';
process.env.BANK_LEARN_FILE = path.join(TMP, 'bank-learn.json'); process.env.QB_DECISIONS_FILE = path.join(TMP, 'qb-decisions.json');
process.env.APP_PASSWORD = 'user-pw-aaaaaaaaaaa'; process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = 'staff-pw-ccccccccccc'; process.env.JARVIS_PASSWORD = 'jarvis-pw-ddddddddddd';
delete process.env.JARVIS_AUTO_APPLY;
const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP) || !String(cfg.BANK_TX_FILE).startsWith(TMP)) { console.error('ABORT config is not isolated'); process.exit(1); }
let server = null;
(async () => {
const { createApi } = require(path.join(ROOT, 'api'));
server = await new Promise((r) => { const s = createApi().listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const req = (method, p, { body, sid } = {}) => new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body); const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (sid) headers.Authorization = `Bearer ${sid}`;
    const r2 = http.request(base + p, { method, headers }, (res) => { let raw = ''; res.on('data', (c) => { raw += c; });
        res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j, raw }); }); });
    r2.on('error', reject); if (data) r2.write(data); r2.end(); });
const login = async (pw) => ((await req('POST', '/login', { body: { password: pw } })).json || {}).sid;
const adminSid = await login(process.env.ADMIN_PASSWORD), superSid = await login(process.env.JARVIS_PASSWORD), userSid = await login(process.env.APP_PASSWORD);
const sales = require(path.join(ROOT, 'helpers/sales')), receipts = require(path.join(ROOT, 'helpers/salesReceipts'));
const ledger = require(path.join(ROOT, 'helpers/bankLedger'));
const A = require(path.join(ROOT, 'helpers/depositAutoApply'));
const NOW = Date.parse('2026-11-08T12:00:00Z');
const mk = async (customer, invoice_no, date, weight, price) => (await sales.addSale({ customer, invoice_no, date, item: 'Auto Cast', weight, invoice_price: price, price_unit: 'lb', weight_unit: 'lb' })).id;
const bal = (id) => { const r = sales.listWithTotals().find((s) => s.id === id); return r ? Math.round(Number(r.balance) * 100) / 100 : null; };
const ACCOUNTS = [
    { id: 'bofa-1', company: 'Edge Metals INC', bank: 'Bank of America, N.A.', swift: 'BOFAUS3N' },
    { id: 'chase-1', company: 'EDGE TRADING INC', bank: 'JPMorgan Chase Bank, N.A.', swift: 'CHASUS33' } ];
const put = (rows) => fs.writeFileSync(cfg.BANK_TX_FILE, JSON.stringify(rows.map((x) => ledger.fromPlaid(x, ACCOUNTS)).filter(Boolean), null, 1));
const teach = (descriptor, customer) => req('POST', '/api/bank/aliases', { sid: adminSid, body: { descriptor, customer, why: 'test' } });

section('SETUP — invoices and deposits as the Sales form and the Plaid sync would make them');
const D1 = await mk('Daekwang', 'DK-1', '2026-10-20', 10000, 0.5);        // 5,000
const D2 = await mk('Daekwang', 'DK-2', '2026-10-22', 10000, 0.7);        // 7,000
const Z1 = await mk('Zimex', 'ZX-1', '2026-10-20', 6000, 0.5);            // 3,000
const Z2 = await mk('Zimex', 'ZX-2', '2026-10-21', 4000, 0.5);            // 2,000
const AR = await mk('Aris', 'AR-1', '2026-10-20', 8000, 0.5);             // 4,000
const HY = await mk('Hyundai', 'HY-1', '2026-10-20', 9000, 0.5);          // 4,500
const OLD = await mk('Oldco', 'OL-1', '2026-08-01', 2000, 0.5);           // 1,000
const ET = await mk('Edge Rival', 'ER-1', '2026-10-20', 2222, 0.5);       // 1,111
ck('invoices exist with the balances the Sales screen computes', bal(D1) === 5000 && bal(D2) === 7000 && bal(Z1) === 3000 && bal(AR) === 4000, [bal(D1), bal(D2), bal(Z1), bal(AR)].join('/'));
const dep = (id, amount, name, date = '2026-11-05', account_id = 'bofa-1') => ({ transaction_id: id, date, amount: -amount, name, account_id });
const NAMES = { dk: 'WIRE IN DAEKWANG CO REF 1', zx: 'WIRE IN ZIMEX LTD REF 2', ar: 'WIRE IN ARIS CO REF 3', hy: 'ACH CREDIT HYUNDAI MOTOR', ol: 'WIRE IN OLDCO REF 5', er: 'WIRE IN EDGE RIVAL REF 6' };
put([dep('TX-DK', 5000, NAMES.dk), dep('TX-ZX', 5000, NAMES.zx), dep('TX-AR', 3990, NAMES.ar), dep('TX-HY', 4500, NAMES.hy),
     dep('TX-OL', 1000, NAMES.ol, '2026-09-01'), dep('TX-ER', 1111, NAMES.er, '2026-11-05', 'chase-1'), dep('TX-UNK', 777, 'WIRE IN NOBODY KNOWN REF 9')]);
for (const [k, c] of [['dk', 'Daekwang'], ['zx', 'Zimex'], ['ar', 'Aris'], ['hy', 'Hyundai'], ['ol', 'Oldco'], ['er', 'Edge Rival']]) await teach(NAMES[k], c);

section('A — OFF BY DEFAULT, and a dry run writes nothing');
let off = await A.run({ now: NOW });
ck('with the flag off nothing is placed', off.off === true && off.applied.length === 0 && receipts.list().length === 0);
const dry = await A.run({ dryRun: true, now: NOW });
ck('a dry run names exactly the one certain deposit', dry.applied.length === 1 && dry.applied[0].depositId === 'TX-DK', JSON.stringify(dry.applied.map((x) => x.depositId)) + ' skipped ' + JSON.stringify(dry.skipped));
ck('  and writes no receipt and no record', receipts.list().length === 0 && A.list().entries.length === 0 && bal(D1) === 5000);
const why = (id) => (dry.skipped.find((s) => s.deposit === id) || {}).why || '';
ck('several invoices (combined) is hers, however sure', /more than one invoice/.test(why('TX-ZX')), why('TX-ZX'));
ck('a short payment is hers', /(in full|confidence)/.test(why('TX-AR')) || /no clear proposal/.test(why('TX-AR')), why('TX-AR'));
ck('a bank line that does not say WIRE or ZELLE is hers', /WIRE or ZELLE/.test(why('TX-HY')), why('TX-HY'));
ck('a deposit older than the window is left for her screen', /older than 30 days/.test(why('TX-OL')), why('TX-OL'));
ck('an unknown payer is hers', !dry.applied.some((x) => x.depositId === 'TX-UNK'));
ck('another company\'s account is never offered against these invoices (rule 5)', !dry.applied.some((x) => x.depositId === 'TX-ER') && bal(ET) === 1111);

section('B — ON: it places the certain one, with the reasons, and only once');
process.env.JARVIS_AUTO_APPLY = '1';
const before = bal(D1);
const r1 = await A.run({ now: NOW });
ck('exactly one deposit placed', r1.applied.length === 1 && r1.failed.length === 0, JSON.stringify(r1.failed));
const e1 = A.list().entries[0];
const rec1 = receipts.list().find((r) => r.id === e1.receiptId);
ck('the invoice balance fell by the deposit (a delta)', before - bal(D1) === 5000, before + ' -> ' + bal(D1));
ck('the receipt is the one the screen would post, labelled as automatic', rec1 && rec1.ref === 'TX-DK' && rec1.created_by === 'jarvis-auto' && rec1.mode === 'Wire' && rec1.bank === 'BofA' && rec1.allocations.length === 1 && rec1.allocations[0].sale_id === D1, JSON.stringify(rec1));
ck('the entry says WHY, against WHAT', e1.reasons.some((x) => /one invoice, to the cent/.test(x)) && e1.reasons.some((x) => /Daekwang/.test(x)) && e1.invoice_no === 'DK-1' && /^[A-Z2-9]{4}$/.test(e1.code), JSON.stringify(e1.reasons));
ck('the audit log has it', require(path.join(ROOT, 'helpers/audit')).listEntries().some((a) => a.action === 'auto-apply-deposit'));
const askedIds = A.list().asks.map((q) => q.depositId);
ck('questions are asked only about real proposals: not an unknown payer, not a deposit too old, not another company\'s', !askedIds.includes('TX-UNK') && !askedIds.includes('TX-OL') && !askedIds.includes('TX-ER') && !askedIds.includes('TX-DK'), JSON.stringify(askedIds));
ck('  the combined deposit and the short payment ARE asked about, with the reason', ['TX-ZX', 'TX-AR'].every((id) => askedIds.includes(id)) && A.list().asks.find((q) => q.depositId === 'TX-ZX').proposal === null, JSON.stringify(askedIds));
const r2 = await A.run({ now: NOW });
ck('a second run places nothing (the deposit is handled)', r2.applied.length === 0 && bal(D1) === 0);
ck('the combined / short / unknown ones are still untouched', bal(Z1) === 3000 && bal(Z2) === 2000 && bal(AR) === 4000 && bal(HY) === 4500);

section('C — THE SCREEN\'S ROUTES');
let g = await req('GET', '/api/bank/auto-applied', { sid: adminSid });
ck('the list route shows it, with its reasons', g.status === 200 && g.json.on === true && g.json.entries.length === 1 && g.json.entries[0].reasons.length >= 3, g.raw.slice(0, 200));
ck('  a non-admin cannot see it', (await req('GET', '/api/bank/auto-applied', { sid: userSid })).status === 403);
ck('  and signing in is required', (await req('GET', '/api/bank/auto-applied')).status === 401);

section('D — UNDO: the lock, the reversal, the pause');
const noSuper = await req('POST', '/api/bank/auto-applied/undo', { sid: adminSid, body: { id: e1.code } });
ck('an admin who is not the Jarvis profile cannot undo (same lock as deleting a receipt)', noSuper.status === 403 && noSuper.json.code === 'JARVIS_PROFILE_REQUIRED' && bal(D1) === 0);
const undone = await req('POST', '/api/bank/auto-applied/undo', { sid: superSid, body: { id: e1.code, reason: 'wrong invoice' } });
ck('the Jarvis profile can undo it, by the short code', undone.status === 200 && undone.json.ok, undone.raw.slice(0, 200));
ck('the receipt is gone and the invoice is open again', !receipts.list().some((r) => r.id === e1.receiptId) && bal(D1) === 5000);
const after = A.list();
ck('the entry records who, when and her reason', after.entries[0].undone && after.entries[0].undone.reason === 'wrong invoice');
ck('the undo is audited', require(path.join(ROOT, 'helpers/audit')).listEntries().some((a) => a.action === 'undo-auto-apply-deposit'));
ck('undoing twice is refused, not repeated', (await req('POST', '/api/bank/auto-applied/undo', { sid: superSid, body: { id: e1.code } })).status === 409);
ck('Daekwang is PAUSED', after.blocks.length === 1 && after.blocks[0].customer === 'Daekwang');
ck('the undone deposit is not applied again, and a new certain Daekwang one waits (paused)', await (async () => {
    put([dep('TX-DK', 5000, NAMES.dk), dep('TX-DK2', 7000, NAMES.dk, '2026-11-06')]);
    const r = await A.run({ now: NOW });
    return r.applied.length === 0 && bal(D1) === 5000 && bal(D2) === 7000 && r.skipped.some((s) => s.deposit === 'TX-DK2' && /paused/.test(s.why)) && r.skipped.some((s) => s.deposit === 'TX-DK' && /already handled/.test(s.why));
})());
const oc = require(path.join(ROOT, 'helpers/outcomes')).readAll();
ck('her undo is in the learning log as a correction', oc.some((x) => x.kind === 'outcome' && x.outcome === 'corrected' && /auto-apply:/.test(x.ref)));

section('E — LEARNING FROM THE UNDO: what was wrong, from what she does next');
const first1 = await A.diagnose({ now: NOW + 864e5, receipts: receipts.list(), bankRows: [] });
ck('no evidence yet: it keeps her own words as a PROVISIONAL reason, and no more', first1.length === 1 && first1[0].kind === 'her_reason' && (await A.diagnose({ now: NOW + 864e5, receipts: receipts.list(), bankRows: [] })).length === 0);
// the real route she uses: she places the SAME deposit on the OTHER Daekwang invoice. Her reason ("wrong invoice") is
// stored, but evidence beats a stated reason, so check the evidence path with a receipt she posts.
const post = await req('POST', '/api/sales-receipts', { sid: adminSid, body: { date: '2026-11-05', amount: 5000, mode: 'Wire', bank: 'Bank of America, N.A.', customer: 'Daekwang', ref: 'TX-DK', note: 'by hand', allocations: [{ sale_id: D2, amount: 5000 }] } });
ck('she places the deposit on the other invoice, through the receipts route', post.status === 200, post.raw.slice(0, 160));
const dg = await A.diagnose({ now: NOW + 2 * 864e5 });
ck('Jarvis finds out: WRONG INVOICE — evidence replaces her provisional reason', dg.length === 1 && dg[0].kind === 'wrong_invoice' && /DK-1|different Daekwang invoice/.test(dg[0].detail), JSON.stringify(dg));
ck('  and it is stored on the entry, once', A.list().entries[0].diagnosis.kind === 'wrong_invoice' && (await A.diagnose({ now: NOW + 3 * 864e5 })).length === 0);
const U = (o) => Object.assign({ depositId: 'TX-Q', receiptId: 'r0', customer: 'Aris', payer: 'WIRE IN ARIS', saleId: 'S-A', invoice_no: 'AR-1', mode: 'Wire', bank: 'Bank of America, N.A.', undone: { at: '2026-11-07T00:00:00.000Z', reason: null } }, o);
const rc = (o) => Object.assign({ id: 'rx', ref: 'TX-Q', created_at: '2026-11-07T05:00:00.000Z', customer: 'Aris', mode: 'Wire', bank: 'Bank of America, N.A.', allocations: [{ sale_id: 'S-A' }] }, o);
const dx = (e, receipts, bankRows = [], nowMs = NOW) => A.diagnoseOne(e, { receipts, bankRows, now: nowMs });
ck('a different CUSTOMER = wrong customer, and the payer name is blamed', (dx(U(), [rc({ customer: 'Zimex' })]) || {}).kind === 'wrong_customer' && /payer name/.test(dx(U(), [rc({ customer: 'Zimex' })]).detail));
ck('same invoice, different bank or mode = wrong bank/mode', (dx(U(), [rc({ mode: 'Zelle' })]) || {}).kind === 'wrong_bank_or_mode' && (dx(U(), [rc({ bank: 'Wells Fargo' })]) || {}).kind === 'wrong_bank_or_mode');
ck('set aside = not our money', (dx(U(), [], [{ id: 'TX-Q', excluded: true }]) || {}).kind === 'not_ours');
ck('placed exactly the same again = same_again, not blamed on anything', (dx(U(), [rc()]) || {}).kind === 'same_again');
ck('a receipt made BEFORE the undo is not evidence', dx(U(), [rc({ created_at: '2026-11-06T05:00:00.000Z' })]) === null);
ck('no evidence and no reason = not concluded yet, then "unknown" after 14 days', dx(U(), []) === null && (dx(U(), [], [], NOW + 20 * 864e5) || {}).kind === 'unknown');
ck('her own words are used when there is no evidence', (dx(U({ undone: { at: '2026-11-07T00:00:00.000Z', reason: 'duplicate' } }), []) || {}).kind === 'her_reason');

section('F — THE DAILY REPORT');
const first = A.dailyText({ now: NOW });
ck('it reports what was applied and what was learned', /Deposits I applied by myself/.test(first) && /What I learned from your undos/.test(first) && /different Daekwang invoice/.test(first), first);
ck('  with the invoice, the reason and the undo instruction', /DK-1/.test(first) && /Why: .*one invoice, to the cent/.test(first) && new RegExp('undo ' + e1.code).test(first) && /Paused \(I ask instead\): Daekwang/.test(first));
const sent = [];
const day1 = await A.runDaily({ sendToManager: async (t) => sent.push(t), now: NOW, proposals: { rows: [] } });
ck('the daily job sends it once', day1.sent && sent.length === 1);
const day2 = await A.runDaily({ sendToManager: async (t) => sent.push(t), now: NOW, proposals: { rows: [] } });
ck('and nothing the next day if nothing happened (no noise)', !day2.sent && sent.length === 1 && A.dailyText({ now: NOW }) === null);
delete process.env.JARVIS_AUTO_APPLY;
ck('with the flag off the daily job does nothing', (await A.runDaily({ sendToManager: async (t) => sent.push(t), now: NOW })).off === true && sent.length === 1);
process.env.JARVIS_AUTO_APPLY = '1';
const boom = await A.runDaily({ sendToManager: async () => { throw new Error('whatsapp down'); }, now: NOW, proposals: { rows: [] } });
ck('a failing send never throws', boom && typeof boom === 'object');

section('G — RESUME, and the guard on what undo may delete');
const res = await req('POST', '/api/bank/auto-applied/resume', { sid: adminSid, body: { customer: 'Daekwang' } });
ck('she lifts the pause through the route', res.status === 200 && res.json.lifted === 1 && A.list().blocks.filter((b) => !b.lifted).length === 0);
ck('  and a new certain Daekwang deposit is placed again; a second one for the SAME invoice is left for her', await (async () => {
    put([dep('TX-DK', 5000, NAMES.dk), dep('TX-DK2', 7000, NAMES.dk, '2026-11-06'), dep('TX-DK3', 5000, NAMES.dk, '2026-11-06'), dep('TX-DK4', 5000, NAMES.dk, '2026-11-07')]);
    const b1 = bal(D1); const r = await A.run({ now: NOW });
    const placed = r.applied.filter((x) => x.saleId === D1);
    return placed.length === 1 && b1 - bal(D1) === 5000 && r.skipped.filter((s) => /another deposit in this run already paid that invoice/.test(s.why) && (s.deposit === 'TX-DK3' || s.deposit === 'TX-DK4')).length === 1;
})());
const manual = await receipts.addReceipt({ date: '2026-11-05', amount: 1000, mode: 'Cash', customer: 'Oldco', ref: 'TX-OL', allocations: [{ sale_id: OL_ID(), amount: 1000 }], created_by: 'admin' });
function OL_ID() { return OLD; }
const fileP = path.join(TMP, 'auto_applied.json'); const st = JSON.parse(fs.readFileSync(fileP, 'utf8'));
st.entries.push({ id: 'aa_forged', code: 'FRGD', depositId: 'TX-OL', receiptId: manual.id, customer: 'Oldco', amount: 1000, reasons: [], undone: null });
fs.writeFileSync(fileP, JSON.stringify(st));
const forged = await A.undo('FRGD', { by: 'her' });
ck('undo will NOT delete a receipt a person made, even if pointed at it', forged.ok === false && receipts.list().some((r) => r.id === manual.id), JSON.stringify(forged));

section('H — EVERY GUARD, ONE AT A TIME (synthetic row; each change alone must refuse)');
const row0 = () => ({ outcome: 'proposed', ambiguous: false, truncated: false, party: 'Zed', claim_hint: null,
    deposit: { id: 'D-H', amount: 1000, date: '2026-11-06', descriptor: 'WIRE IN ZED', bank_guess: 'BofA' },
    proposals: [{ score: 0.97, reasons: ['one invoice, to the cent'], allocations: [{ doc_id: 'S-H', amount: 1000, clears: true, label: 'ZED-1 (x)' }] }] });
const ctx = (o = {}) => Object.assign({ state: { entries: [], blocks: [] }, receipts: [], modes: ['Wire', 'Zelle', 'Cash'], now: NOW }, o);
const ok0 = A.eligible(row0(), ctx());
ck('the synthetic baseline IS eligible (so each refusal below is the one change)', ok0.ok === true && ok0.mode === 'Wire', JSON.stringify(ok0));
const refuse = (name, mut, c, re) => { const r = row0(); mut(r); const e = A.eligible(r, ctx(c)); ck('refused: ' + name, e.ok === false && re.test(e.why), JSON.stringify(e)); };
refuse('not a proposal', (r) => { r.outcome = 'no_party'; }, {}, /no clear proposal/);
refuse('ambiguous', (r) => { r.ambiguous = true; }, {}, /more than one fits/);
refuse('search cut short', (r) => { r.truncated = true; }, {}, /cut short/);
refuse('confidence 0.94', (r) => { r.proposals[0].score = 0.94; }, {}, /under 0\.95/);
refuse('two invoices', (r) => { r.proposals[0].allocations.push({ doc_id: 'S2', amount: 1, clears: true }); }, {}, /more than one invoice/);
refuse('a shortfall', (r) => { r.proposals[0].allocations[0].shortfall = 5; }, {}, /in full/);
refuse('does not clear the invoice', (r) => { r.proposals[0].allocations[0].clears = false; }, {}, /in full/);
refuse('allocation is a cent off the deposit', (r) => { r.proposals[0].allocations[0].amount = 999.98; }, {}, /to the cent/);
refuse('no party', (r) => { r.party = null; }, {}, /not matched to a customer/);
refuse('claim hint', (r) => { r.claim_hint = { claim_id: 1 }; }, {}, /claim/);
refuse('no bank account', (r) => { r.deposit.bank_guess = null; }, {}, /bank account unknown/);
refuse('no WIRE/ZELLE in the line', (r) => { r.deposit.descriptor = 'ACH CREDIT ZED'; }, {}, /WIRE or ZELLE/);
refuse('mode not in the receipt list', (r) => {}, { modes: ['Cash'] }, /WIRE or ZELLE/);
refuse('dated in the future', (r) => { r.deposit.date = '2026-11-12'; }, {}, /future/);
refuse('29 days is fine but 31 is not', (r) => { r.deposit.date = '2026-10-07'; }, {}, /older than 30/);
ck('  (and exactly 29 days old IS allowed)', (() => { const r = row0(); r.deposit.date = '2026-10-10'; return A.eligible(r, ctx()).ok; })());
refuse('already handled', () => {}, { state: { entries: [{ depositId: 'D-H' }], blocks: [] } }, /already handled/);
refuse('a receipt already carries this deposit id', () => {}, { receipts: [{ ref: 'D-H' }] }, /receipt already exists/);
refuse('paused customer', () => {}, { state: { entries: [], blocks: [{ customer: ' zed ', payer: 'x', lifted: null }] } }, /paused/);
refuse('paused payer even under another customer name', (r) => { r.party = 'Zed 2'; }, { state: { entries: [], blocks: [{ customer: 'other', payer: 'WIRE IN ZED', lifted: null }] } }, /paused/);
ck('a LIFTED pause no longer blocks', A.eligible(row0(), ctx({ state: { entries: [], blocks: [{ customer: 'Zed', payer: 'WIRE IN ZED', lifted: { at: 'x' } }] } })).ok);
ck('the short code is stable and typeable', A.codeFor('aa_x') === A.codeFor('aa_x') && /^[A-Z2-9]{4}$/.test(A.codeFor('aa_y')));

section('I — A RUNAWAY CANNOT PLACE EVERYTHING IN ONE NIGHT');
const K1 = await mk('Kia', 'KI-1', '2026-10-25', 2000, 0.5), S1 = await mk('Samsung', 'SA-1', '2026-10-25', 3000, 0.5);
put([dep('TX-K', 1000, 'WIRE IN KIA MOTORS REF 7', '2026-11-06'), dep('TX-S', 1500, 'WIRE IN SAMSUNG REF 8', '2026-11-06')]);
await teach('WIRE IN KIA MOTORS REF 7', 'Kia'); await teach('WIRE IN SAMSUNG REF 8', 'Samsung');
process.env.JARVIS_AUTO_APPLY_MAX_PER_RUN = '1';
const cap = await A.run({ now: NOW });
ck('with a cap of 1, exactly one of two certain deposits is placed; the other waits and says why', cap.applied.length === 1 && cap.skipped.some((x) => /more than 1 in one run/.test(x.why)) && ((bal(K1) === 0) !== (bal(S1) === 0)), JSON.stringify([cap.applied.length, cap.skipped]));
delete process.env.JARVIS_AUTO_APPLY_MAX_PER_RUN;
const cap2 = await A.run({ now: NOW });
ck('the next run places the other one', cap2.applied.length === 1 && bal(K1) === 0 && bal(S1) === 0);

section('J — THE DESCRIPTION: "if unsure, always ask"');
const LT1 = await mk('Lotte', 'LT-1', '2026-10-25', 2000, 0.5), LT2 = await mk('Lotte', 'LT-2', '2026-10-26', 4000, 0.5);
const PO1 = await mk('Posco', 'PO-1', '2026-10-25', 3000, 0.5), HW1 = await mk('Hanwha', 'HW-1', '2026-10-25', 1600, 0.5), NX1 = await mk('Nexen', 'NX-1', '2026-10-25', 1200, 0.5);
const NJ = { refund: 'WIRE IN LOTTE REFUND REF 11', other: 'WIRE IN LOTTE LT-1 PAYMENT', adv: 'WIRE IN POSCO ADVANCE ORDER', ok: 'WIRE IN HANWHA HW-1', two: 'WIRE IN NEXEN FOR HANWHA SHIPMENT' };
put([dep('TX-J1', 1000, NJ.refund, '2026-11-06'), dep('TX-J2', 2000, NJ.other, '2026-11-06'), dep('TX-J3', 1500, NJ.adv, '2026-11-06'), dep('TX-J4', 800, NJ.ok, '2026-11-06'), dep('TX-J5', 600, NJ.two, '2026-11-06')]);
for (const [k, c] of [['refund', 'Lotte'], ['other', 'Lotte'], ['adv', 'Posco'], ['ok', 'Hanwha'], ['two', 'Nexen']]) await teach(NJ[k], c);
const dryJ = await A.run({ dryRun: true, now: NOW });
ck('dry run: only the clean one would be placed', dryJ.applied.length === 1 && dryJ.applied[0].depositId === 'TX-J4', JSON.stringify([dryJ.applied.map((x) => x.depositId), dryJ.skipped.filter((x) => /^TX-J/.test(x.deposit))]));
ck('  a dry run saves no question (it only lists them)', dryJ.asked.length >= 4 && A.list().asks.every((q) => !/^TX-J/.test(q.depositId)));
const balsJ = () => [bal(LT1), bal(LT2), bal(PO1), bal(HW1), bal(NX1)].join('/');
const J = await A.run({ now: NOW });
ck('live: exactly the clean one (the bank line names its own invoice) is placed', J.applied.length === 1 && J.applied[0].depositId === 'TX-J4' && bal(HW1) === 0 && J.applied[0].reasons.some((x) => /names HW-1/.test(x)) && J.applied[0].reasons.some((x) => /nothing in the bank description argues against it/.test(x)), balsJ() + JSON.stringify(J.applied.map((x) => x.reasons)));
const askJ = (id) => A.list().asks.find((q) => q.depositId === id);
ck('the others are NOT placed; each became a question that says why', bal(LT1) === 1000 && bal(LT2) === 2000 && bal(PO1) === 1500 && bal(NX1) === 600 && ['TX-J1', 'TX-J2', 'TX-J3', 'TX-J5'].every((id) => askJ(id) && /^not sure — /.test(askJ(id).why)), balsJ());
ck('  refund / advance words are named', /"REFUND"/.test(askJ('TX-J1').why) && /"ADVANCE"/.test(askJ('TX-J3').why));
ck('  a DIFFERENT invoice named in the line is named', /LT-1, which is a different invoice/.test(askJ('TX-J2').why), askJ('TX-J2').why);
ck('  ANOTHER customer named in the line is named', /also names hanwha/.test(askJ('TX-J5').why), askJ('TX-J5').why);
ck('  each question carries my best guess when there is exactly one invoice', askJ('TX-J2').proposal && askJ('TX-J2').proposal.label === 'LT-2' && askJ('TX-J2').proposal.amount === 2000 && askJ('TX-J2').proposal.mode === 'Wire');
const Jn = A.list().asks.length;
await A.run({ now: NOW });
ck('running again asks NOTHING twice', A.list().asks.length === Jn);
const dt = A.dailyText({ now: NOW });
ck('the daily message lists the questions with codes, and the guess', /Not sure about \d+ deposit/.test(dt) && new RegExp('yes ' + askJ('TX-J2').code).test(dt) && new RegExp('no ' + askJ('TX-J2').code).test(dt) && /My best guess: pay LT-2 in full/.test(dt), dt);

section('K — HER ANSWER: yes places it (and re-checks the world), no leaves it');
const q2 = askJ('TX-J2'); const b2 = bal(LT2);
const yes = await A.confirmAsk(q2.code);
ck('"yes" places exactly what I guessed, a delta', yes.ok && b2 - bal(LT2) === 2000 && bal(LT1) === 1000, JSON.stringify(yes).slice(0, 200));
const ye = A.list().entries.find((e) => e.id === yes.entry.id);
ck('  the entry says she confirmed and why I had asked, and it is undoable', ye.placedBy === 'her' && /you said yes when I asked/.test(ye.reasons[0]) && ye.reported === true && ye.receiptId);
ck('  answering twice is refused', (await A.confirmAsk(q2.code)).ok === false && /already answered/.test((await A.confirmAsk(q2.code)).error));
const no = await A.declineAsk(askJ('TX-J1').code);
ck('"no" leaves it for the Bank page and places nothing', no.ok && bal(LT1) === 1000 && askJ('TX-J1').answer.kind === 'no');
const ocJ = require(path.join(ROOT, 'helpers/outcomes')).readAll().filter((x) => /auto-ask:/.test(x.ref) && x.kind === 'outcome');
ck('both answers are in the learning log (approved / declined)', ocJ.some((x) => x.outcome === 'approved') && ocJ.some((x) => x.outcome === 'declined'));
await receipts.addReceipt({ date: '2026-11-06', amount: 3000, mode: 'Cash', customer: 'Posco', ref: 'by-hand', allocations: [{ sale_id: PO1, amount: 3000 }], created_by: 'admin' });
const stale = await A.confirmAsk(askJ('TX-J3').code);
ck('if the invoice changed since I asked, "yes" is refused, nothing placed', stale.ok === false && /changed since I asked/.test(stale.error) && !receipts.list().some((r) => r.ref === 'TX-J3'), JSON.stringify(stale));
const noProp = A.list().asks.find((q) => !q.proposal);
ck('a question with no single-invoice guess cannot be confirmed by "yes"', !noProp || (await A.confirmAsk(noProp.code)).ok === false);

section('L — THE DESCRIPTION RULES, ONE AT A TIME (pure)');
const sl = [{ id: 'S-A', customer: 'Alpha Metals', invoice_no: 'AL-100', container_no: 'MSKU1234567', booking_no: 'BK-77' }, { id: 'S-B', customer: 'Beta Trading', invoice_no: 'BE-200', container_no: 'TCLU7654321', booking_no: 'BK-88' }];
const dr = (text, party = 'Alpha Metals') => A.descriptionDoubts({ party, deposit: { descriptor: text }, proposals: [{ allocations: [{ doc_id: 'S-A' }] }] }, sl);
ck('a plain wire line has no doubts', dr('WIRE IN ALPHA METALS REF 99').doubts.length === 0);
for (const w of ['refund', 'returned', 'reversal', 'chargeback', 'advance', 'prepayment', 'down payment', 'partial', 'part payment', 'on account', 'balance of', 'deduction', 'claim', 'loan', 'interest', 'own account', 'intercompany', 'duplicate', 'NSF'])
    ck('doubt word: ' + w, dr('WIRE IN ALPHA METALS ' + w.toUpperCase()).doubts.some((x) => /bank description says/.test(x)), JSON.stringify(dr('WIRE IN ALPHA METALS ' + w.toUpperCase())));
ck('a word that merely CONTAINS a doubt word does not trigger (advanced, returnable)', dr('WIRE IN ALPHA METALS ADVANCED ALLOYS').doubts.length === 0 && dr('WIRE IN ALPHA RETURNABLE PALLETS').doubts.length === 0);
ck('the other invoice\'s number, container or booking in the line is a doubt', ['BE-200', 'TCLU7654321', 'BK-88'].every((r) => dr('WIRE IN ALPHA METALS ' + r).doubts.some((x) => /different invoice/.test(x))));
ck('its OWN invoice, container or booking in the line is a confirmation, not a doubt', ['AL-100', 'MSKU1234567', 'BK-77'].every((r) => { const x = dr('WIRE IN ALPHA METALS ' + r); return x.doubts.length === 0 && x.confirms.some((c) => c.includes(r)); }));
ck('another customer named in the line is a doubt', dr('WIRE IN ALPHA METALS FOR BETA TRADING').doubts.some((x) => /also names beta trading/.test(x)));
ck('the matched customer\'s own name is not "another customer"', dr('WIRE IN ALPHA METALS').doubts.length === 0 && dr('WIRE IN ALPHA').doubts.length === 0);
ck('the memo and the bank_text are read too, not only the descriptor', A.descriptionDoubts({ party: 'Alpha Metals', deposit: { descriptor: 'WIRE IN ALPHA', memo: 'refund of overpayment' }, proposals: [] }, sl).doubts.length === 1 && A.descriptionDoubts({ party: 'Alpha Metals', deposit: { descriptor: 'WIRE IN ALPHA' }, bank_text: 'ADVANCE', proposals: [] }, sl).doubts.length === 1);

section('M — A FLOOD OF DOUBTS CANNOT FLOOD HER PHONE');
const I1 = await mk('Ilji', 'IL-1', '2026-10-25', 1000, 0.5), I2 = await mk('Jeil', 'JE-1', '2026-10-25', 1000, 0.5);
put([dep('TX-M1', 500, 'WIRE IN ILJI REFUND', '2026-11-06'), dep('TX-M2', 500, 'WIRE IN JEIL REFUND', '2026-11-06')]);
await teach('WIRE IN ILJI REFUND', 'Ilji'); await teach('WIRE IN JEIL REFUND', 'Jeil');
process.env.JARVIS_AUTO_APPLY_MAX_ASKS = '1';
const before2 = A.list().asks.length;
const M = await A.run({ now: NOW });
ck('with a limit of 1 question a day, one is asked and the other says it is on the Bank page', M.asked.length === 1 && A.list().asks.length === before2 + 1 && M.skipped.some((x) => /more questions than I send in one day/.test(x.why)), JSON.stringify([M.asked.length, M.skipped]));
delete process.env.JARVIS_AUTO_APPLY_MAX_ASKS;

section('N — THE LEARNER, IN SHADOW: it predicts and measures, and cannot change a decision or break a run');
{
    const { spawn } = require('child_process');
    const LP = 21000 + Math.floor(Math.random() * 15000), LTOK = 'learner-test-token-yyyyyyyy', LD = path.join(TMP, 'learner');
    const lsrv = spawn('python3', [path.join(ROOT, 'learner', 'server.py'), String(LP)], { env: { ...process.env, LEARNER_TOKEN: LTOK, LEARNER_DATA: LD, LEARNER_FAKE_LM: '1' }, stdio: 'ignore' });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://127.0.0.1:${LP}/health`)).ok) break; } catch (e) {} await sleep(150); }
    process.env.JARVIS_LEARNER_URL = `http://127.0.0.1:${LP}`; process.env.JARVIS_LEARNER_TOKEN = LTOK;
    const lc = require(path.join(ROOT, 'helpers/learnerClient'));
    for (let i = 0; i < 6; i++) await lc.example('deposit', { customer: 'Kolon', amount: 500, descriptor: 'WIRE IN KOLON KO-1', mode: 'Wire', bank: 'BofA', note: 'certain: names the invoice' }, 'apply');
    const KO = await mk('Kolon', 'KO-1', '2026-10-25', 1000, 0.5), S1 = await mk('Skc One', 'SK-1', '2026-10-25', 1000, 0.5), S2 = await mk('Skc Two', 'SK-2', '2026-10-25', 1000, 0.5);
    put([dep('TX-N1', 500, 'WIRE IN KOLON KO-1', '2026-11-06'), dep('TX-N2', 500, 'WIRE IN SKC ONE REFUND', '2026-11-06'), dep('TX-N3', 500, 'WIRE IN SKC TWO REFUND', '2026-11-06')]);
    await teach('WIRE IN KOLON KO-1', 'Kolon'); await teach('WIRE IN SKC ONE REFUND', 'Skc One'); await teach('WIRE IN SKC TWO REFUND', 'Skc Two');
    const bK = bal(KO);
    const N = await A.run({ now: NOW }); await sleep(500);
    ck('the rules decided exactly as they would have: the certain one placed, the refunds asked', bK - bal(KO) === 500 && N.applied.some((x) => x.depositId === 'TX-N1') && ['TX-N2', 'TX-N3'].every((id) => A.list().asks.some((q) => q.depositId === id)), JSON.stringify(N.applied.map((x) => x.depositId)));
    let rep = await lc.report();
    ck('the learner judged all three, each tied to its deposit', rep && rep.judged === 3, JSON.stringify(rep));
    const shadow = fs.readFileSync(path.join(LD, 'shadow.jsonl'), 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x));
    ck('  the logged cases carry what the screen shows (customer, amount, bank line), not internal ids', shadow.filter((x) => x.t === 'predicted').every((x) => x.case.customer && x.case.amount === 500 && /WIRE IN/.test(x.case.descriptor) && !('depositId' in x.case)));
    const q2n = A.list().asks.find((q) => q.depositId === 'TX-N2'), q3n = A.list().asks.find((q) => q.depositId === 'TX-N3');
    await A.confirmAsk(q2n.code); await A.declineAsk(q3n.code);
    const entN1 = A.list().entries.find((e) => e.depositId === 'TX-N1');
    await A.undo(entN1.code, { by: 'her', reason: 'wrong' }); await sleep(500);
    const ex = fs.readFileSync(path.join(LD, 'examples.jsonl'), 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x));
    ck('her yes, her no and her undo each became an example, labelled apply / leave / leave', ex.filter((x) => x.ref === 'dep:TX-N2')[0].decision === 'apply' && ex.filter((x) => x.ref === 'dep:TX-N3')[0].decision === 'leave' && ex.filter((x) => x.ref === 'dep:TX-N1')[0].decision === 'leave');
    rep = await lc.report();
    ck('and each is measured against what the learner predicted (3 compared)', rep.compared === 3, JSON.stringify(rep));
    ck('a placement she did NOT undo gets no label (silence is not approval yet)', !ex.some((x) => x.ref === 'dep:TX-HW'));
    lsrv.kill(); await sleep(300);
    const K2 = await mk('Kumho', 'KU-1', '2026-10-25', 1000, 0.5);
    put([dep('TX-N4', 500, 'WIRE IN KUMHO KU-1', '2026-11-06')]); await teach('WIRE IN KUMHO KU-1', 'Kumho');
    const t0 = Date.now(); const N4 = await A.run({ now: NOW }); const took = Date.now() - t0;
    ck('with the learner DOWN the run still places the deposit, and is not held up by it', bal(K2) === 0 && N4.applied.some((x) => x.depositId === 'TX-N4') && took < 2000, took + 'ms');
    delete process.env.JARVIS_LEARNER_URL; delete process.env.JARVIS_LEARNER_TOKEN;
}

console.log(`\n${pass} passed, ${fail} failed`);
server.close(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack || e); try { server && server.close(); } catch (x) {} process.exit(1); });
