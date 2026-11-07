// Ownership plan slice 3 (Apsara, 2026-11-07): a customer who WRITES when they will pay is believed: the date is recorded, the
// follow-up waits for it, she is told in one line, and when the date passes unpaid the follow-up resumes.
// Real job.run() + real remittance finder with a stubbed mailbox and stubbed model.
const fs = require('fs'), os = require('os'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-prom-')); process.env.JARVIS_TEST = '1';
delete process.env.PAYMENT_CHASE; delete process.env.PAYMENT_CHASE_SEND;
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
const pf = require(path.join(ROOT, 'helpers/paymentFollowups'));
const chaser = require(path.join(ROOT, 'helpers/paymentChaser'));
const rm = require(path.join(ROOT, 'helpers/remittanceMail'));
const job = require(path.join(ROOT, 'helpers/followUpAgentJob'));
const pickups = require(path.join(ROOT, 'helpers/pickups')); pickups.list = () => [];
const D = (iso) => Date.parse(iso + 'T12:00:00Z');
const rows = [{ id: 'S1', customer: 'Daekwang', invoice_no: 'INV-1', container_no: 'AAAA1', booking_no: 'BK1', date: '2026-10-25', receivable: 5000, received: 0, balance: 5000, terms: 'TT' }];
const drafts = (iso) => pf.build({ salesRows: rows, terms: pf.loadTerms(), resolve: () => ({ type: 'exact', contact: { email: 'ap@daekwang.example' } }), bookings: {}, now: D(iso) }).drafts;
let inbox = [], verdict = null, mgr = [];
const finder = rm.makeFinder({ list: async () => inbox.map((m) => ({ id: m.id })), get: async (id) => inbox.find((m) => m.id === id), classify: async () => verdict });
const go = async (iso) => { mgr = []; return job.run({ sendToManager: async (t) => { mgr.push(t); }, sendToTeam: async () => {}, sendEmail: async () => {}, sendWhatsapp: async () => {}, now: D(iso), paymentDrafts: drafts(iso), findRemittance: finder }); };
const mail = (id, date, subject) => ({ id, subject, from: 'ap@daekwang.example', dateMs: D(date), snippet: 'x', files: [] });

(async () => {
    await go('2026-11-07');
    inbox = [mail('m1', '2026-11-14', 'Re: payment')];
    verdict = { payment_related: true, why: 'says date', promised_on: '2026-11-25' };
    let r = await go('2026-11-15');
    ck('a stated pay date: the chase is held and she is told the date (not asked)', r.payments.held === 1 && r.payments.chased === 0 && mgr.length === 1 && /will pay by 11\/25/.test(mgr[0]) && /hold their follow-up until then/.test(mgr[0]), mgr.join('|'));
    const h = chaser.readLog().daekwang.held;
    ck('  recorded as a promise with its date', h.promisedOn === '2026-11-25' && h.promisedUntil === Date.parse('2026-11-25T23:59:59Z'));
    r = await go('2026-11-22');
    ck('a week later (beyond the usual 7-day lapse), still waiting for the promised date', r.payments.chased === 0 && !mgr.some((m) => /will pay by/.test(m)), JSON.stringify(r.payments));
    r = await go('2026-11-26');
    ck('the promised date passes unpaid: the follow-up RESUMES (that same mail no longer holds)', r.payments.held === 0 && (r.payments.chased + r.payments.escalated) >= 1, JSON.stringify(r.payments));

    // rejected dates
    require('fs').rmSync(require(path.join(ROOT, 'config')).PAYMENT_CHASE_LOG_FILE, { force: true });
    await go('2026-11-07');
    verdict = { payment_related: true, why: 'x', promised_on: '2026-11-10' };         // before the mail was written (11/14)
    inbox = [mail('m2', '2026-11-14', 'Re: payment')];
    r = await go('2026-11-15');
    ck('a "promise" dated BEFORE the mail is ignored: handled as an ordinary possible payment (no promise recorded)', !chaser.readLog().daekwang.held.promisedOn, JSON.stringify(chaser.readLog().daekwang));
    require('fs').rmSync(require(path.join(ROOT, 'config')).PAYMENT_CHASE_LOG_FILE, { force: true });
    await go('2026-11-07');
    verdict = { payment_related: true, why: 'x', promised_on: '2027-09-01' };         // a year out
    inbox = [mail('m3', '2026-11-14', 'Re: later')];
    r = await go('2026-11-15');
    ck('a date more than 120 days out is not trusted', !chaser.readLog().daekwang.held.promisedOn);
    verdict = { payment_related: true, why: 'x', promised_on: 'next friday' };
    require('fs').rmSync(require(path.join(ROOT, 'config')).PAYMENT_CHASE_LOG_FILE, { force: true });
    await go('2026-11-07'); inbox = [mail('m4', '2026-11-14', 'x')];
    r = await go('2026-11-15');
    ck('a non-ISO answer from the model is not a date', !chaser.readLog().daekwang.held.promisedOn);
    const prompt = rm.promptFor({ customer: 'Daekwang', count: 1, lines: [] }, mail('m5', '2026-11-14', 's'));
    ck('the model is told the mail date and not to invent one', /Email date: 2026-11-14/.test(prompt) && /Never invent a date/.test(prompt) && /promised_on/.test(prompt));
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
