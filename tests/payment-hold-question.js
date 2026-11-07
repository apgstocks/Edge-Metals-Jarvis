// Apsara, 2026-11-07: "if it has any question, ask". When the Follow-up Agent finds a bank deposit or mail that MAY be a customer's
// payment, it ASKS her on WhatsApp (yes = hold 30 days, no = carry on) instead of only reporting. Real job.run(), real
// actions.resolvePending and real brain.policyDecide for her "yes"/"no".
const fs = require('fs'), os = require('os'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-hq-')); process.env.JARVIS_TEST = '1';
delete process.env.PAYMENT_CHASE; delete process.env.PAYMENT_CHASE_SEND;
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
const pf = require(path.join(ROOT, 'helpers/paymentFollowups'));
const chaser = require(path.join(ROOT, 'helpers/paymentChaser'));
const bd = require(path.join(ROOT, 'helpers/bankDepositCheck'));
const job = require(path.join(ROOT, 'helpers/followUpAgentJob'));
const actions = require(path.join(ROOT, 'workflow/actions'));
const brain = require(path.join(ROOT, 'workflow/brain'));
const pickups = require(path.join(ROOT, 'helpers/pickups')); pickups.list = () => [];
const wa = []; actions.init({ sendMessage: async (c, t) => { wa.push(t); }, sendToManager: async () => {}, sendToTeam: async () => {}, pushAlert: () => {} });
const CHAT = 'CHAT@c.us';
const D = (iso) => Date.parse(iso + 'T12:00:00Z');
const rows = [{ id: 'S1', customer: 'Daekwang', invoice_no: 'INV-1', container_no: 'AAAA1', booking_no: 'BK1', date: '2026-10-25', receivable: 5000, received: 0, balance: 5000, terms: 'TT' }];
const drafts = (iso) => pf.build({ salesRows: rows, terms: pf.loadTerms(), resolve: () => ({ type: 'exact', contact: { email: 'ap@daekwang.example' } }), bookings: {}, now: D(iso) }).drafts;
let ledger = [], mgr = [];
const dep = (id, date, desc, amount) => ({ id, date, desc, amount, received: amount, direction: 'in', excluded: false, matched: null });
const go = async (iso) => { mgr = []; wa.length = 0; return job.run({ sendToManager: async (t) => { mgr.push(t); }, sendToTeam: async () => {}, sendEmail: async () => {}, sendWhatsapp: async () => {}, now: D(iso), paymentDrafts: drafts(iso),
    findDeposit: bd.makeFinder({ rows: () => ledger }), askAboutHold: (i) => actions.stagePaymentHeldQuestion(CHAT, i) }); };
const say = (text) => brain.policyDecide({ isManagerOrTeam: true, pendingAction: actions.getPending(CHAT), text, textLower: text.toLowerCase(), chatId: CHAT, session: {} });
(async () => {
    await go('2026-11-07');
    ledger = [dep('p1', '2026-11-12', 'ACH CREDIT DAEKWANG', 5000)];
    let r = await go('2026-11-15');
    ck('it ASKS her (a real pending), not just a report', r.payments.held === 1 && actions.getPending(CHAT) && actions.getPending(CHAT).type === 'await_payment_held_answer' && /Is that their payment\?/.test(wa.join('\n')) && /\$5,000\.00/.test(wa.join('\n')), wa.join('|'));
    ck('  and does not also send the plain note', mgr.length === 0);
    ck('  her bare "yes" / "no" reach it through the normal brain', say('yes').intent === 'resolve_pending' && say('no').intent === 'resolve_pending');
    await actions.resolvePending(CHAT, actions.getPending(CHAT), 'yes');
    ck('yes: hold confirmed for 30 days, she is told what to do', /30 days/.test(wa.join('\n')) && chaser.readLog().daekwang.held.confirmed === true);
    r = await go('2026-12-10');
    ck('26 days on: still on hold (the old 7-day lapse does not apply once she confirmed)', r.payments.chased === 0 && actions.getPending(CHAT) === null, JSON.stringify([r.payments, chaser.readLog().daekwang]));
    r = await go('2026-12-20');
    ck('after the 30 days the follow-up resumes', r.payments.chased === 1 || r.payments.asked === 1, JSON.stringify(r.payments));

    // "no": it is not theirs
    require('fs').rmSync(require(path.join(ROOT, 'config')).PAYMENT_CHASE_LOG_FILE, { force: true });
    ledger = []; if (actions.getPending(CHAT)) await actions.resolvePending(CHAT, actions.getPending(CHAT), 'no');
    await go('2026-11-07');
    ledger = [dep('p2', '2026-11-12', 'ACH CREDIT DAEKWANG', 5000)];
    await go('2026-11-15');
    await actions.resolvePending(CHAT, actions.getPending(CHAT), 'no');
    ck('no: told it is not theirs, the follow-up carries on', /carry on/.test(wa.join('\n')) && chaser.readLog().daekwang.held.dismissed === true, wa.join('|') + JSON.stringify(chaser.readLog()));
    r = await go('2026-11-16');
    ck('  the same deposit never asks again and the chase is not held by it', r.payments.held === 0 && !actions.getPending(CHAT));
    ledger = [dep('p2', '2026-11-12', 'ACH CREDIT DAEKWANG', 5000), dep('p3', '2026-11-18', 'WIRE DAEKWANG', 5000)];
    r = await go('2026-11-30');
    ck('a DIFFERENT new deposit asks afresh', r.payments.held === 1 && actions.getPending(CHAT) && /Is that their payment/.test(wa.join('\n')), JSON.stringify(r.payments));
    await actions.resolvePending(CHAT, actions.getPending(CHAT), 'no');

    // busy: falls back to the plain note
    ledger = [dep('p4', '2026-12-01', 'WIRE DAEKWANG', 5000)];
    await actions.setPending(CHAT, { type: 'await_verify_apply', bookings: [] });
    r = await go('2026-12-05');
    ck('she is busy with another question: the agent says it as a plain note instead, and asks nothing', r.payments.held === 1 && mgr.some((m) => /bank shows/.test(m)) && actions.getPending(CHAT).type === 'await_verify_apply');
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
