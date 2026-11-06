// Apsara, 2026-11-07: Rad Metal showed 96 sales, 0 receipts, "$4.78M open" - a customer who always pays. Jarvis's ledger has no
// payments in it; QuickBooks does. So the Follow-up Agent follows up only what QuickBooks confirms is open, and FAILS CLOSED.
// Drives the REAL job.run() -> REAL reconcile -> REAL staging, with a stubbed QuickBooks survey.
const fs = require('fs'), os = require('os'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ptruth-')); process.env.JARVIS_TEST = '1';
delete process.env.PAYMENT_CHASE; delete process.env.PAYMENT_CHASE_SEND;
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const cfg = require(path.join(ROOT, 'config'));
const pf = require(path.join(ROOT, 'helpers/paymentFollowups'));
const chaser = require(path.join(ROOT, 'helpers/paymentChaser'));
const truth = require(path.join(ROOT, 'helpers/paymentTruth'));
const job = require(path.join(ROOT, 'helpers/followUpAgentJob'));
const gmail = require(path.join(ROOT, 'helpers/gmail'));
const actions = require(path.join(ROOT, 'workflow/actions'));
const IT = require(path.join(ROOT, 'helpers/invoiceThread')); IT.liveFinder = () => async () => null;
const pickups = require(path.join(ROOT, 'helpers/pickups')); pickups.list = () => [];
const sentMail = []; gmail.sendEmail = async (m) => { sentMail.push(m); return { threadId: 't' }; };
const wa = [], mgr = [];
actions.init({ sendMessage: async (c, t) => { wa.push(t); }, sendToManager: async (t) => { mgr.push(t); }, sendToTeam: async () => {}, pushAlert: () => {} });
const CHAT = 'CHAT@c.us';
const D = (iso) => Date.parse(iso + 'T12:00:00Z');
const sale = (id, customer, inv, cont, bal) => ({ id, customer, invoice_no: inv, container_no: cont, booking_no: 'BK' + id, date: '2026-10-01', receivable: bal, received: 0, balance: bal, terms: 'TT' });
const rows = [
    sale('1', 'Rad Metal', 'R-1', 'RRRR1', 50000), sale('2', 'Rad Metal', 'R-2', 'RRRR2', 60000),         // always pays: QuickBooks shows nothing open
    sale('3', 'Daekwang', 'INV-1', 'AAAA1', 5000), sale('4', 'Daekwang', 'INV-2', 'AAAA2', 2500),          // INV-2 paid in QuickBooks, INV-1 part-paid
    sale('5', 'Twins', 'T-1', 'TTTT1', 3000),                                                               // has money received, unapplied
    sale('6', 'Ghost Co', 'G-1', 'GGGG1', 900),                                                             // QuickBooks has never heard of them
    sale('7', 'Hardeep Puri', 'H-1', 'HHHH1', 1200),                                                        // known to QuickBooks under another name
];
const addr = { 'rad metal': 'ap@rad.example', daekwang: 'ap@daekwang.example', twins: 'ap@twins.example', 'ghost co': 'ap@ghost.example', 'hardeep puri': 'ap@hp.example' };
const resolve = (n) => addr[String(n).toLowerCase()] ? { type: 'exact', contact: { email: addr[String(n).toLowerCase()] } } : null;
const drafts = (iso = '2026-11-07') => pf.build({ salesRows: rows, terms: pf.loadTerms(), resolve, bookings: {}, now: D(iso) }).drafts;
const inv = (doc, containers, total, balance) => ({ id: doc, doc, date: '2026-10-01', total, balance, late: 20, containers });
const survey = () => ({ customers: [
    { customer: 'Daekwang', alsoKnownAs: [], open: 4000, received: 0, verdict: 'nudge', invoices: [inv('INV-1', ['AAAA1'], 5000, 4000)] },
    { customer: 'TWINS', alsoKnownAs: [], open: 3000, received: 3000, verdict: 'do-not-chase', invoices: [inv('T-1', ['TTTT1'], 3000, 3000)] },
    { customer: 'Modern Enterprises/Hardeep Puri', alsoKnownAs: ['Hardeep Puri'], open: 1200, received: 0, verdict: 'chase', invoices: [inv('H-1', ['HHHH1'], 1200, 1200)] },
] });

section('A. reconcile (pure)');
const rc = truth.reconcile(drafts(), survey());
const by = (n) => rc.drafts.find((d) => d.customer === n);
ck('Rad Metal (nothing open in QuickBooks) is NOT followed up', !by('Rad Metal') && rc.skipped.some((s) => s.customer === 'Rad Metal' && s.why === 'not-in-quickbooks'));
ck('a customer QuickBooks never heard of is skipped', rc.skipped.some((s) => s.customer === 'Ghost Co'));
ck('unapplied money received: skipped, "apply first"', rc.skipped.some((s) => s.customer === 'Twins' && s.why === 'apply-receipts-first'));
ck('Daekwang: the paid invoice is dropped and QuickBooks\' balance wins ($4,000, not $5,000)', by('Daekwang') && by('Daekwang').count === 1 && by('Daekwang').total === 4000 && /INV-1/.test(by('Daekwang').body) && !/INV-2/.test(by('Daekwang').body), by('Daekwang') && by('Daekwang').body);
ck('  the part-payment shows as received', /\$1,000\.00 received so far/.test(by('Daekwang').body));
ck('a customer matched through QuickBooks\' other name is kept', !!by('Hardeep Puri'));
ck('address and kind survive the rebuild', by('Daekwang').to === 'ap@daekwang.example' && by('Daekwang').kind === 'remittance');
ck('a one-line summary names the reasons', /left out 3 customers/.test(truth.skippedLine(rc.skipped)) && /not in QuickBooks/.test(truth.skippedLine(rc.skipped)));

(async () => {
section('B. the agent: staged emails come from QuickBooks only');
const go = async (iso, over = {}) => { wa.length = 0; mgr.length = 0; return job.run({ sendToManager: async (t) => { mgr.push(t); }, sendToTeam: async () => {}, sendEmail: async () => {}, sendWhatsapp: async () => {}, now: D(iso), paymentDrafts: drafts(iso), stageCustomerEmail: (d, s) => actions.stagePaymentFollowupEmail(CHAT, d, s), qbSurvey: async () => survey(), ...over }); };

    let r = await go('2026-11-07');
    const pend = actions.getPending(CHAT);
    ck('exactly one email is staged, and it is for a customer QuickBooks confirms', r.payments.staged === 1 && pend && /^ap@(daekwang|hp)\.example$/.test(pend.to), JSON.stringify(r.payments));
    ck('  Rad Metal / Twins / Ghost Co were never staged or mentioned as owing', !/Rad Metal|Twins|Ghost/.test(wa.join('\n')) && sentMail.length === 0);
    ck('  one short line tells her who was left out and why (nobody contacted)', mgr.length === 1 && /left out 3 customers/.test(mgr[0]) && /Nobody was contacted/.test(mgr[0]), mgr.join('|'));
    if (pend.to === 'ap@daekwang.example') ck('  the staged email says $4,000 and only INV-1', /\$4,000\.00/.test(pend.body) && /INV-1/.test(pend.body) && !/INV-2/.test(pend.body));
    await actions.resolvePending(CHAT, pend, 'no');
    r = await go('2026-11-08');
    ck('next day: the left-out line is not repeated', !mgr.some((m) => /left out/.test(m)));
    r = await go('2026-11-15');
    ck('a week later it is said once more', mgr.some((m) => /left out 3 customers/.test(m)));
    const lg = chaser.readLog();
    ck('left-out customers leave no trace in the follow-up log', !lg['rad metal'] && !lg['ghost co'] && !lg.twins);

    if (actions.getPending(CHAT)) await actions.resolvePending(CHAT, actions.getPending(CHAT), 'no');
    section('C. fails closed');
    fs.rmSync(cfg.PAYMENT_CHASE_LOG_FILE, { force: true });
    r = await go('2026-11-07', { qbSurvey: async () => { throw new Error('QuickBooks production is not connected'); } });
    ck('QuickBooks unreadable: NOTHING staged, nothing sent, paused', r.payments.paused === true && r.payments.staged === 0 && !actions.getPending(CHAT) && sentMail.length === 0, JSON.stringify(r.payments));
    ck('  she is told once, plainly', mgr.length === 1 && /paused/.test(mgr[0]) && /not connected/.test(mgr[0]) && /Nobody was contacted/.test(mgr[0]), mgr.join('|'));
    r = await go('2026-11-08', { qbSurvey: async () => { throw new Error('down'); } });
    ck('  and not again tomorrow', mgr.length === 0 && r.payments.staged === 0);
    r = await go('2026-11-08', { qbSurvey: async () => null });
    ck('an empty answer is also treated as unreadable', r.payments.paused === true && r.payments.staged === 0);
    r = await go('2026-11-09', { qbSurvey: undefined, stageCustomerEmail: undefined });
    ck('no survey supplied (older callers/tests): behaves as before', !r.payments.paused);
    const src = fs.readFileSync(path.join(ROOT, 'scheduler.js'), 'utf8');
    ck('the live agent is wired to the QuickBooks survey', /qbSurvey: require\('\.\/helpers\/paymentTruth'\)\.liveSurvey\(\)/.test(src));
    ck('liveSurvey with no QuickBooks connection throws (so the agent pauses)', await (async () => { try { await truth.liveSurvey()(); return false; } catch (e) { return true; } })());
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
