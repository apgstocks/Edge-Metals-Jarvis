// Apsara, 2026-11-07: "You have Plaid as well". Money that already landed in the bank feed but is not matched yet holds the
// follow-up and tells her to match it. Real job.run(), real bank finder over supplied ledger rows; read-only.
const fs = require('fs'), os = require('os'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-bdep-')); process.env.JARVIS_TEST = '1';
delete process.env.PAYMENT_CHASE; delete process.env.PAYMENT_CHASE_SEND;
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const pf = require(path.join(ROOT, 'helpers/paymentFollowups'));
const chaser = require(path.join(ROOT, 'helpers/paymentChaser'));
const bd = require(path.join(ROOT, 'helpers/bankDepositCheck'));
const job = require(path.join(ROOT, 'helpers/followUpAgentJob'));
const pickups = require(path.join(ROOT, 'helpers/pickups')); pickups.list = () => [];
const D = (iso) => Date.parse(iso + 'T12:00:00Z');
const row = (id, date, desc, amount, over = {}) => ({ id, date, desc, amount, received: amount, direction: 'in', excluded: false, matched: null, ...over });

section('A. the matcher');
const draft = { customer: 'Daekwang Co., Ltd', total: 7500, lines: [{ balance: 5000 }, { balance: 2500 }] };
const find = (rows, d = draft, o = { sinceMs: D('2026-10-01') }) => bd.makeFinder({ rows })(d, o);
ck('their name in the bank text (any amount)', !!find([row('1', '2026-11-05', 'WIRE FROM DAEKWANG CO LTD', 123)]));
ck('an exact open balance, whatever the name says', !!find([row('2', '2026-11-05', 'INCOMING WIRE REF 8841', 2500)]));
ck('the invoice total counts too', !!find([row('3', '2026-11-05', 'INCOMING WIRE', 7500)]));
ck('an unrelated deposit does not', find([row('4', '2026-11-05', 'SOME OTHER CO', 1234.56)]) === null);
ck('money OUT, excluded, already matched, or before the first note: ignored', find([row('5', '2026-11-05', 'Daekwang', 2500, { direction: 'out' }), row('6', '2026-11-05', 'Daekwang', 2500, { excluded: true }), row('7', '2026-11-05', 'Daekwang', 2500, { matched: { kind: 'x' } }), row('8', '2026-09-01', 'Daekwang', 2500)]) === null);
ck('generic words are not a name ("Metal" matches nobody)', bd.specific('Rad Metal').join() === 'rad' && bd.specific('FMC METALS').join() === 'fmc' && bd.specific('Trading Co Inc').length === 0);
ck('the newest candidate is reported, with amount, date and text', (() => { const h = find([row('a', '2026-11-01', 'X', 2500), row('b', '2026-11-06', 'Y', 2500)]); return h && h.id === 'bank:b' && /\$2,500\.00 on 11\/06/.test(h.subject) && h.kind === 'bank'; })());

section('B. the agent');
const rows = [{ id: 'S1', customer: 'Daekwang', invoice_no: 'INV-1', container_no: 'AAAA1', booking_no: 'BK1', date: '2026-10-25', receivable: 5000, received: 0, balance: 5000, terms: 'TT' }];
const drafts = (iso) => pf.build({ salesRows: rows, terms: pf.loadTerms(), resolve: () => ({ type: 'exact', contact: { email: 'ap@daekwang.example' } }), bookings: {}, now: D(iso) }).drafts;
let ledger = [], mgr = [];
const go = async (iso, over = {}) => { mgr = []; return job.run({ sendToManager: async (t) => { mgr.push(t); }, sendToTeam: async () => {}, sendEmail: async () => {}, sendWhatsapp: async () => {}, now: D(iso), paymentDrafts: drafts(iso), findDeposit: bd.makeFinder({ rows: () => ledger }), ...over }); };
(async () => {
    let r = await go('2026-11-07');
    ck('no matching deposit: normal first note', r.payments.asked === 1 && r.payments.held === 0 && /Payment follow-ups ready/.test(mgr[0]));
    ledger = [row('p1', '2026-11-12', 'ACH CREDIT DAEKWANG', 5000)];
    r = await go('2026-11-15');
    ck('a deposit that looks theirs: the chase is HELD', r.payments.chased === 0 && r.payments.held === 1, JSON.stringify(r.payments));
    ck('  she is told the amount/date and to match it; nobody contacted', mgr.length === 1 && /the bank shows a bank deposit \$5,000\.00 on 11\/12/.test(mgr[0]) && /Match it to their invoices/.test(mgr[0]), mgr.join('|'));
    r = await go('2026-11-16');
    ck('not repeated the next day', r.payments.chased === 0 && !mgr.some((m) => /bank shows/.test(m)));
    ledger = [row('p1', '2026-11-12', 'ACH CREDIT DAEKWANG', 5000, { matched: { kind: 'receipt' } })];
    r = await go('2026-11-23');
    ck('once she has matched it (and QuickBooks/Jarvis still say open), the hold ends and the chase resumes', r.payments.held === 0 && r.payments.chased === 1, JSON.stringify(r.payments));
    r = await go('2026-11-24', { findDeposit: undefined });
    ck('no finder supplied (older callers): behaves as before', r.payments.held === 0);
    const src = fs.readFileSync(path.join(ROOT, 'helpers/bankDepositCheck.js'), 'utf8').replace(/\/\/[^\n]*/g, '');
    ck('read-only: no write, no receipt, no send', !/addReceipt|writeFile|setMatched|markMatched|sendEmail|mutate/.test(src));
    ck('wired into the live agent', /findDeposit: require\('\.\/helpers\/bankDepositCheck'\)\.liveFinder\(\)/.test(fs.readFileSync(path.join(ROOT, 'scheduler.js'), 'utf8')));
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
