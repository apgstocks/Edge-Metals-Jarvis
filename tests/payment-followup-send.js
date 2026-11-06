// Apsara, 2026-11-07: should Jarvis email customers about payment? "Ask for my confirmation in whatsapp".
// The Follow-up Agent STAGES the customer email on WhatsApp (the same await_email_confirm every outbound email uses) and
// nothing is sent until she answers yes. Drives the REAL job.run() -> REAL actions.stagePaymentFollowupEmail -> REAL
// resolvePending (yes / no), with gmail.sendEmail and WhatsApp stubbed.
const fs = require('fs'), os = require('os'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-pfsend-')); process.env.JARVIS_TEST = '1';
delete process.env.PAYMENT_CHASE; delete process.env.PAYMENT_CHASE_SEND;
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const cfg = require(path.join(ROOT, 'config'));
const pf = require(path.join(ROOT, 'helpers/paymentFollowups'));
const chaser = require(path.join(ROOT, 'helpers/paymentChaser'));
const job = require(path.join(ROOT, 'helpers/followUpAgentJob'));
const gmail = require(path.join(ROOT, 'helpers/gmail'));
const actions = require(path.join(ROOT, 'workflow/actions'));
const pickups = require(path.join(ROOT, 'helpers/pickups')); pickups.list = () => [];

const sentMail = [], wa = [], mgr = [];
gmail.sendEmail = async (m) => { sentMail.push(m); return { threadId: 't1' }; };
actions.init({ sendMessage: async (c, t) => { wa.push(t); }, sendToManager: async (t) => { mgr.push(t); }, sendToTeam: async () => {}, pushAlert: () => {} });
const CHAT = 'CHAT@c.us';
const D = (iso) => Date.parse(iso + 'T12:00:00Z');
const rows = [
    { id: 'S1', customer: 'Daekwang', invoice_no: 'INV-1', container_no: 'AAAA1', booking_no: 'BK1', date: '2026-10-25', receivable: 6000, received: 1000, balance: 5000, terms: 'TT' },
    { id: 'S2', customer: 'Twins Metal', invoice_no: 'INV-2', container_no: 'BBBB2', booking_no: 'BK2', date: '2026-10-26', receivable: 3000, received: 0, balance: 3000, terms: 'TT' },
    { id: 'S3', customer: 'NoMail Co', invoice_no: 'INV-3', container_no: 'CCCC3', booking_no: 'BK3', date: '2026-10-26', receivable: 1000, received: 0, balance: 1000, terms: 'TT' },
    { id: 'S4', customer: 'Bank LC Ltd', invoice_no: 'INV-4', container_no: 'DDDD4', booking_no: 'BK4', date: '2026-10-26', receivable: 9000, received: 0, balance: 9000, terms: 'LC' },
];
const addr = { daekwang: 'ap@daekwang.example', 'twins metal': 'ap@twins.example', 'bank lc ltd': 'ap@lc.example' };
const resolve = (n) => addr[String(n).toLowerCase()] ? { type: 'exact', contact: { email: addr[String(n).toLowerCase()] } } : null;
const draftsAt = (iso) => pf.build({ salesRows: rows, terms: pf.loadTerms(), resolve, bookings: {}, now: D(iso) }).drafts;
const IT = require(path.join(ROOT, 'helpers/invoiceThread'));
let threadHit = null;                                       // what the "sent folder" has
IT.liveFinder = () => async (d) => threadHit && (d.lines || []).some((l) => l.invoice_no === threadHit.ref) ? threadHit : null;
const stage = (d, step) => actions.stagePaymentFollowupEmail(CHAT, d, step);
const go = async (iso, over = {}) => { wa.length = 0; mgr.length = 0; return job.run({ sendToManager: async (t) => { mgr.push(t); }, sendToTeam: async () => {}, sendEmail: async () => {}, sendWhatsapp: async () => {}, now: D(iso), paymentDrafts: draftsAt(iso), stageCustomerEmail: stage, ...over }); };

(async () => {
    section('A. staged, not sent');
    let r = await go('2026-11-07');
    ck('exactly ONE customer email is staged this run', r.payments.staged === 1 && wa.filter((t) => /Send this to the customer/.test(t)).length === 1, JSON.stringify(r.payments));
    ck('nothing has gone to any customer yet', sentMail.length === 0);
    ck('a customer with no address: one short line to HER, never staged', mgr.length === 1 && /NoMail Co/.test(mgr[0]) && /no email address on file/.test(mgr[0]) && mgr[0].split('\n').length === 1, JSON.stringify(mgr));
    const p = actions.getPending(CHAT);
    ck('a real await_email_confirm is open for her, addressed to the customer', p && p.type === 'await_email_confirm' && p.to === 'ap@daekwang.example' && p.source === 'payment_followup' && /INV-1/.test(p.body), JSON.stringify(p));
    ck('the WhatsApp preview shows who, subject and body, and asks yes/no', /Daekwang <ap@daekwang.example>/.test(wa.join('\n')) && /Subject: Payment status/.test(wa.join('\n')) && /\(yes\/no/.test(wa.join('\n')));
    ck('the confirmation expires on its own (a stray later yes lands on nothing)', new Date(p.expires_at) - Date.now() < 7 * 3600 * 1000);
    ck('LC customer never staged', !/Bank LC/.test(wa.join('\n')) && p.target_name !== 'Bank LC Ltd');

    section('B. she is busy: nothing stacks, nothing is recorded');
    r = await go('2026-11-07');
    ck('while that one is open, no second customer email is staged', r.payments.staged === 0 && !wa.some((t) => /Send this to the customer/.test(t)));
    const log = chaser.readLog();
    ck('only the customer she has SEEN is recorded as asked', log.daekwang && log.daekwang.lastStep === 'ask' && !log['twins metal'], Object.keys(log).join());

    section('C. her yes sends; the next customer follows');
    await actions.resolvePending(CHAT, actions.getPending(CHAT), 'yes');
    ck('yes: the email goes to the customer, exactly the staged text', sentMail.length === 1 && sentMail[0].to === 'ap@daekwang.example' && /INV-1/.test(sentMail[0].body) && /Payment status/.test(sentMail[0].subject), JSON.stringify(sentMail));
    r = await go('2026-11-07');
    ck('next run: the next customer (Twins) is staged', r.payments.staged === 1 && actions.getPending(CHAT).to === 'ap@twins.example');
    section('D. her no sends nothing');
    await actions.resolvePending(CHAT, actions.getPending(CHAT), 'no');
    ck('no: nothing more was sent and nothing is left open', sentMail.length === 1 && !actions.getPending(CHAT));
    ck('  and every later run does not send anything without a yes', sentMail.length === 1);

    section('E. a week on: the chase is staged too, and the switch');
    r = await go('2026-11-15');
    ck('Daekwang, a week after the note, is staged for a chase (confirm again)', r.payments.staged === 1 && /Still unpaid/.test(wa.join('\n')) && actions.getPending(CHAT).to === 'ap@daekwang.example', wa.join('\n'));
    await actions.resolvePending(CHAT, actions.getPending(CHAT), 'no');
    process.env.PAYMENT_CHASE_SEND = 'off';
    fs.rmSync(cfg.PAYMENT_CHASE_LOG_FILE, { force: true });
    r = await go('2026-11-07');
    ck('PAYMENT_CHASE_SEND=off: back to telling her only, nothing staged', r.payments.staged === 0 && !actions.getPending(CHAT) && mgr.some((t) => /Payment follow-ups ready/.test(t)));
    delete process.env.PAYMENT_CHASE_SEND;
    r = await go('2026-11-07', { stageCustomerEmail: undefined });
    ck('no stager injected (older callers): behaves as before', r.payments.staged === 0 && !actions.getPending(CHAT));

    section('E2. same thread as the invoice, and professional');
    fs.rmSync(cfg.PAYMENT_CHASE_LOG_FILE, { force: true });
    threadHit = { threadId: 'THR-77', messageId: '<abc@mail.gmail.com>', subject: 'Re: Invoice INV-1 - Edge Metals', ref: 'INV-1', source: 'sent' };
    sentMail.length = 0; r = await go('2026-11-07');
    const pp = actions.getPending(CHAT);
    ck('the pending is a REPLY in the invoice thread', pp.send_thread_id === 'THR-77' && pp.inReplyTo === '<abc@mail.gmail.com>' && pp.references === '<abc@mail.gmail.com>' && /^Re: Invoice INV-1/.test(pp.subject), JSON.stringify(pp));
    ck('the preview tells her it is the same thread', /same thread as the invoice mail/.test(wa.join('\n')));
    await actions.resolvePending(CHAT, pp, 'yes');
    ck('yes: the send carries the thread id and In-Reply-To', sentMail.length === 1 && sentMail[0].threadId === 'THR-77' && sentMail[0].inReplyTo === '<abc@mail.gmail.com>', JSON.stringify(sentMail[0]));
    threadHit = null; fs.rmSync(cfg.PAYMENT_CHASE_LOG_FILE, { force: true }); sentMail.length = 0;
    r = await go('2026-11-07');
    const np = actions.getPending(CHAT);
    ck('thread not found: a NEW email, and she is told so', !np.send_thread_id && /NEW email/.test(wa.join('\n')));
    await actions.resolvePending(CHAT, np, 'yes');
    ck('  and it is sent with no thread id', sentMail.length === 1 && !sentMail[0].threadId);
    // chase wording
    const dk = draftsAt('2026-11-15').find((d) => d.customer === 'Daekwang');
    const cb = require(path.join(ROOT, 'helpers/paymentFollowups')).chaseBodyFor(dk);
    ck('the chase refers back to the earlier note, is polite, and is not the first email again', /following up on my earlier message/.test(cb) && /Kind regards,/.test(cb) && cb !== dk.body && /INV-1/.test(cb) && /\$5,000\.00/.test(cb), cb);
    ck('no scolding / pressure words', !/overdue|immediately|failure|legal|final notice|urgent/i.test(cb + dk.body));
    ck('the first note is signed properly too', /Kind regards,\nApsara\nEdge Metals Inc/.test(dk.body));

    section('E3. the first-run wall (Apsara, 2026-11-07: a 52-line list of customers with no email)');
    const many = Array.from({ length: 52 }, (_, i) => ({ id: 'M' + i, customer: 'Cust ' + i, invoice_no: 'I' + i, container_no: 'CONT' + i, booking_no: 'B' + i, date: '2026-10-01', receivable: 1000 + i, received: 0, balance: 1000 + i, terms: 'TT' }));
    const wall = pf.build({ salesRows: many, terms: pf.loadTerms(), resolve: () => null, bookings: {}, now: D('2026-11-07') }).drafts;
    fs.rmSync(cfg.PAYMENT_CHASE_LOG_FILE, { force: true });
    r = await go('2026-11-07', { paymentDrafts: wall });
    ck('52 customers without an address: ONE short message, not 52 lines', mgr.length === 1 && mgr[0].split('\n').length === 1 && /52 customers/.test(mgr[0]) && /no email address on file/.test(mgr[0]) && /Cust 51/.test(mgr[0]), mgr.join('|').slice(0, 300));
    ck('  nothing staged, nothing recorded as asked', r.payments.staged === 0 && r.payments.asked === 0 && Object.keys(chaser.readLog()).every((k) => k[0] === '_'));
    r = await go('2026-11-08', { paymentDrafts: wall });
    ck('the next day: silent (once a week at most)', mgr.length === 0);
    r = await go('2026-11-15', { paymentDrafts: wall });
    ck('a week later: the one line again', mgr.length === 1 && /52 customers/.test(mgr[0]));
    // an address is added later: the customer starts with a fresh first note, not a chase
    const withAddr = pf.build({ salesRows: many, terms: pf.loadTerms(), resolve: (n) => n === 'Cust 51' ? { type: 'exact', contact: { email: 'c51@x.example' } } : null, bookings: {}, now: D('2026-11-16') }).drafts;
    r = await go('2026-11-16', { paymentDrafts: withAddr });
    ck('once an address is added, that customer is staged with a first note', r.payments.staged === 1 && actions.getPending(CHAT).to === 'c51@x.example' && /Payment status/.test(actions.getPending(CHAT).subject));
    await actions.resolvePending(CHAT, actions.getPending(CHAT), 'no');

    section('F. the stager guards itself');
    ck('invalid address: not staged', (await stage({ customer: 'X', to: 'nope', subject: 's', body: 'b' }, 'ask')).staged === false);
    const src = fs.readFileSync(path.join(ROOT, 'helpers/followUpAgentJob.js'), 'utf8');
    const half = src.slice(src.indexOf('async function runPayments'), src.indexOf('// ── A LINE FOR THE MORNING BRIEFING')).replace(/\/\/[^\n]*/g, '');
    ck('runPayments itself still has no send path', !/sendEmail|sendWhatsapp|gmail|sendMail/.test(half));
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
