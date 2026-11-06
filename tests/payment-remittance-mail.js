// Apsara, 2026-11-07: customers "would have shared a remittance copy ... in mail" - so before the Follow-up Agent
// chases a customer it reads the mailbox for payment mail FROM them, holds the chase and tells her. Read-only: nothing is
// marked paid and nothing goes to a customer. Drives the REAL job.run() with the REAL finder over a stubbed mailbox.
const fs = require('fs'), os = require('os'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-remit-')); process.env.JARVIS_TEST = '1';
delete process.env.PAYMENT_CHASE;
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const cfg = require(path.join(ROOT, 'config'));
const pf = require(path.join(ROOT, 'helpers/paymentFollowups'));
const chaser = require(path.join(ROOT, 'helpers/paymentChaser'));
const rm = require(path.join(ROOT, 'helpers/remittanceMail'));
const job = require(path.join(ROOT, 'helpers/followUpAgentJob'));
const pickups = require(path.join(ROOT, 'helpers/pickups')); pickups.list = () => [];
const D = (iso) => Date.parse(iso + 'T12:00:00Z');

section('A. the query');
ck('company domain: from the whole domain', rm.queryFor({ to: 'ap@daekwang.example' }, D('2026-11-01')).startsWith('from:(@daekwang.example) after:2026/11/1 ('));
ck('gmail.com: exact address only, never the whole of gmail', rm.queryFor({ to: 'bob@gmail.com' }, D('2026-11-01')).startsWith('from:(bob@gmail.com)'));
ck('no address on file: no search (cannot guess)', rm.queryFor({ to: null }, 1) === null && rm.queryFor({ to_missing: true }, 1) === null);
ck('asks about remittance / proof of payment', /remittance/.test(rm.queryFor({ to: 'a@b.example' }, 1)) && /proof of payment/.test(rm.queryFor({ to: 'a@b.example' }, 1)));

section('B. the Follow-up Agent with the real finder over a stub mailbox');
const rows = [{ id: 'S2', customer: 'Daekwang', invoice_no: 'INV-2', container_no: 'KOCU2', booking_no: 'BKT2', date: '2026-10-25', receivable: 6000, received: 1000, balance: 5000 }];
const draftsAt = (iso) => pf.build({ salesRows: rows, terms: pf.loadTerms(), resolve: () => ({ type: 'exact', contact: { email: 'ap@daekwang.example' } }), bookings: {}, now: D(iso) }).drafts;
let inbox = [], queries = [], boom = false;
const finder = rm.makeFinder({
    list: async (q) => { queries.push(q); if (boom) throw new Error('gmail down'); return inbox.map((m) => ({ id: m.id })); },
    get: async (id) => inbox.find((m) => m.id === id),
});
const calls = { manager: [], team: [], email: [] };
const go = async (iso, over = {}) => { for (const k of Object.keys(calls)) calls[k].length = 0; queries = [];
    return job.run({ sendToManager: async (t) => { calls.manager.push(t); }, sendToTeam: async (t) => { calls.team.push(t); }, sendEmail: async (m) => { calls.email.push(m); }, sendWhatsapp: async () => {},
        now: D(iso), paymentDrafts: draftsAt(iso), findRemittance: finder, ...over }); };
(async () => {
    let r = await go('2026-11-07');
    ck('no payment mail: the normal first note goes', r.payments.asked === 1 && r.payments.held === 0 && /Payment follow-ups ready/.test(calls.manager[0]));
    r = await go('2026-11-15');
    ck('no payment mail: a week on, the normal chase goes', r.payments.chased === 1 && /Still unpaid/.test(calls.manager[0]), JSON.stringify(r.payments));
    ck('  the search only looked at mail since the first note', queries.length === 1 && /after:2026\/11\/7/.test(queries[0]), queries[0]);

    // They email a remittance copy on 11/16. Chase would be due 11/22 (next rung).
    fs.rmSync(cfg.PAYMENT_CHASE_LOG_FILE, { force: true });
    await go('2026-11-07');
    inbox = [{ id: 'm1', subject: 'Wire confirmation INV-2', from: 'ap@daekwang.example', dateMs: D('2026-11-15') }];
    r = await go('2026-11-15');
    ck('payment mail found: the chase is HELD', r.payments.chased === 0 && r.payments.held === 1, JSON.stringify(r.payments));
    ck('  she is told to check it and record the receipt', calls.manager.length === 1 && /Possible payment received/.test(calls.manager[0]) && /Daekwang/.test(calls.manager[0]) && /Wire confirmation INV-2/.test(calls.manager[0]) && /record the receipt/.test(calls.manager[0]), calls.manager[0]);
    ck('  nothing went to any customer', calls.email.length === 0 && calls.team.length === 0);
    r = await go('2026-11-16');
    ck('the next run does not tell her again about the same mail', r.payments.chased === 0 && !calls.manager.some((m) => /Possible payment/.test(m)), JSON.stringify(calls.manager));
    const st = chaser.statusFor(draftsAt('2026-11-16')[0], chaser.readLog());
    ck('the screen status carries the hold date', st.held === '11/15' && st.asked === '11/07', JSON.stringify(st));

    r = await go('2026-11-23');
    ck('a week with no receipt recorded: the same mail stops holding, the chase resumes', r.payments.chased === 1 && r.payments.held === 0, JSON.stringify(r.payments));
    inbox.push({ id: 'm2', subject: 'RE: payment sent', from: 'ap@daekwang.example', dateMs: D('2026-11-23') });
    fs.rmSync(cfg.PAYMENT_CHASE_LOG_FILE, { force: true });
    r = await go('2026-11-23');

    section('C. failure and the switch');
    fs.rmSync(cfg.PAYMENT_CHASE_LOG_FILE, { force: true }); inbox = []; boom = true;
    r = await go('2026-11-07');
    ck('mailbox error: the finder never throws; the follow-up still goes', r.payments.asked === 1);
    const live = rm.liveFinder(); ck('liveFinder with no Gmail token returns null, not a crash', (await live({ to: 'a@b.example' }, { sinceMs: 1 })) === null);
    boom = false;
    fs.rmSync(cfg.PAYMENT_CHASE_LOG_FILE, { force: true });
    r = await go('2026-11-07', { findRemittance: undefined });
    ck('no finder injected (every older caller): behaves exactly as before', r.payments.asked === 1 && r.payments.held === 0);
    const src = fs.readFileSync(path.join(ROOT, 'helpers/remittanceMail.js'), 'utf8').replace(/\/\/[^\n]*/g, '');
    ck('the finder only reads: no send, no receipt, no sale write', !/sendEmail|addReceipt|addSale|updateSale|\.send\(/.test(src));
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
