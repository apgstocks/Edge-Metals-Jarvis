// Apsara, 2026-11-07: "lets work on the followup agent" -> "Add customer payment follow-ups". The drafts already existed
// (helpers/paymentFollowups.js) but nothing remembered what she had been told. The Follow-up Agent now walks a ladder per
// customer - ask / chase / escalate - and tells HER (and her team when well past due). It NEVER contacts a customer: on
// 2026-10-21 she chose "drafts only, sending is scope 2". This drives the REAL job.run() with drafts built by the REAL
// paymentFollowups.build() from sales rows, and a spy on every sender.
const fs = require('fs'), os = require('os'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-fpay-')); process.env.JARVIS_TEST = '1';
delete process.env.PAYMENT_CHASE;
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
const cfg = require(path.join(ROOT, 'config'));
const pf = require(path.join(ROOT, 'helpers/paymentFollowups'));
const chaser = require(path.join(ROOT, 'helpers/paymentChaser'));
const job = require(path.join(ROOT, 'helpers/followUpAgentJob'));
const pickups = require(path.join(ROOT, 'helpers/pickups'));
pickups.list = () => [];                     // no pickups in this file: payments only

const D = (iso) => Date.parse(iso + 'T12:00:00Z');
const bookings = { BKT1: { eta: '11/20/2026' }, BKT2: { eta: '12/30/2026' } };
// Eccomelt is on ETA-10 terms (so due 11/10 for a 11/20 ETA), Daekwang has no terms.
fs.writeFileSync(cfg.CUSTOMER_PAY_TERMS_FILE, JSON.stringify({ eccomelt: { customer: 'Eccomelt', eta_terms: 'ETA-10' } }));
const rowsFor = (extra = []) => [
    { id: 'S1', customer: 'Eccomelt', invoice_no: 'INV-1', container_no: 'HMMU1', booking_no: 'BKT1', date: '2026-10-20', receivable: 10000, received: 0, balance: 10000 },
    { id: 'S2', customer: 'Daekwang', invoice_no: 'INV-2', container_no: 'KOCU2', booking_no: 'BKT2', date: '2026-10-25', receivable: 6000, received: 1000, balance: 5000 },
    ...extra];
const draftsAt = (iso, rows = rowsFor()) => pf.build({ salesRows: rows, terms: pf.loadTerms(), resolve: () => null, bookings, now: D(iso) }).drafts;

const calls = { manager: [], team: [], email: [], whatsapp: [] };
const senders = (over = {}) => ({
    sendToManager: async (t) => { calls.manager.push(t); }, sendToTeam: async (t) => { calls.team.push(t); },
    sendEmail: async (m) => { calls.email.push(m); return {}; }, sendWhatsapp: async (to, t) => { calls.whatsapp.push([to, t]); }, ...over });
const reset = () => { for (const k of Object.keys(calls)) calls[k].length = 0; };
const go = async (iso, rows, over) => { reset(); return job.run({ ...senders(over), now: D(iso), paymentDrafts: draftsAt(iso, rows) }); };

(async () => {
    // ── DAY 0: 11/07. Eccomelt's ETA is 11/20, so ETA-11 = 11/09: NOT yet. Daekwang (no terms) is drafted now.
    let r = await go('2026-11-07');
    ck('day 0: only the no-terms customer is drafted yet (Eccomelt starts at ETA-11 = 11/09)', r.payments.asked === 1 && /Daekwang/.test(calls.manager[0]) && !/Eccomelt/.test(calls.manager[0]), calls.manager[0]);
    ck('  ONE batched message to her, saying nothing has gone to a customer', calls.manager.length === 1 && /Nothing has been sent to any customer/.test(calls.manager[0]));
    ck('NEVER contacts a customer: no email, no WhatsApp from the payment half', calls.email.length === 0 && calls.whatsapp.length === 0);
    r = await go('2026-11-07');
    ck('same day again: silent (a rung fires once)', calls.manager.length === 0 && r.payments.asked === 0);

    // ── 11/09: Eccomelt's draft appears (ETA-11): asked once.
    r = await go('2026-11-09');
    ck('11/09: Eccomelt (ETA-11) is asked about; Daekwang is not repeated', r.payments.asked === 1 && /Eccomelt/.test(calls.manager[0]) && !/Daekwang/.test(calls.manager[0]), calls.manager[0]);
    ck('  and its draft figure and due date are in the line', /\$10,000\.00/.test(calls.manager[0]) && /due 11\/10/.test(calls.manager[0]), calls.manager[0]);

    // ── 11/11: Eccomelt due 11/10 -> a day past due: chase. Daekwang (asked 11/07) is 4 days: not yet.
    r = await go('2026-11-11');
    ck('11/11: Eccomelt is chased once past its due date; Daekwang waits (only 4 days)', r.payments.chased === 1 && /Still unpaid/.test(calls.manager[0]) && /Eccomelt/.test(calls.manager[0]) && !/Daekwang/.test(calls.manager[0]), calls.manager[0]);

    // ── 11/14: Daekwang is 7 days after its ask -> chase.
    r = await go('2026-11-14');
    ck('11/14: Daekwang is chased a week after the first note', r.payments.chased === 1 && /Daekwang/.test(calls.manager[0]));

    // ── 11/18: Eccomelt 8 days past due 11/10 -> escalate to the TEAM, not to her batch and not to the customer.
    r = await go('2026-11-18');
    ck('11/18: Eccomelt, 8 days past due after a chase, goes to the TEAM', r.payments.escalated === 1 && calls.team.length === 1 && /Eccomelt/.test(calls.team[0]) && /call them/.test(calls.team[0]), JSON.stringify(calls.team));
    ck('  and still nothing to a customer', calls.email.length === 0 && calls.whatsapp.length === 0);
    r = await go('2026-11-19');
    ck('11/19: an escalated customer is not nagged again', r.payments.escalated === 0 && calls.team.length === 0 && !calls.manager.some((m) => /Eccomelt/.test(m)));

    // ── A NEW invoice for Eccomelt restarts its ladder.
    const more = rowsFor([{ id: 'S3', customer: 'Eccomelt', invoice_no: 'INV-3', container_no: 'HMMU3', booking_no: 'BKT1', date: '2026-11-01', receivable: 2000, received: 0, balance: 2000 }]);
    r = await go('2026-11-19', more);
    ck('a new invoice for the same customer starts the ladder again (asked)', r.payments.asked >= 1 && calls.manager.some((m) => /Eccomelt/.test(m) && /\$12,000\.00/.test(m)), JSON.stringify(calls.manager));

    // ── Paid: no draft -> the memory forgets them, so a future invoice is fresh.
    r = await go('2026-11-20', rowsFor().filter((x) => x.customer === 'Daekwang'));
    const log = JSON.parse(fs.readFileSync(cfg.PAYMENT_CHASE_LOG_FILE, 'utf8'));
    ck('a customer who has paid drops out of the memory', !log.eccomelt && !!log.daekwang, Object.keys(log).join());

    // ── 11/28: Daekwang 21 days after the first note, already chased -> escalate.
    r = await go('2026-11-28', rowsFor().filter((x) => x.customer === 'Daekwang'));
    ck('11/28: Daekwang, 21 days on, goes to the team', r.payments.escalated === 1 && /Daekwang/.test(calls.team[0] || ''), JSON.stringify(calls.team));

    // ── Failure handling: a send that fails is NOT recorded, so the next run retries.
    fs.rmSync(cfg.PAYMENT_CHASE_LOG_FILE, { force: true });
    r = await go('2026-11-07', undefined, { sendToManager: async () => { throw new Error('whatsapp down'); } });
    ck('a failed send is reported, not swallowed', r.payments.failed.length === 1 && /whatsapp down/.test(r.payments.failed[0].why) && r.payments.asked === 0, JSON.stringify(r.payments));
    ck('  and NOT recorded: nothing in the memory', !fs.existsSync(cfg.PAYMENT_CHASE_LOG_FILE) || Object.keys(JSON.parse(fs.readFileSync(cfg.PAYMENT_CHASE_LOG_FILE, 'utf8'))).length === 0);
    r = await go('2026-11-07');
    ck('  so the next run sends it', r.payments.asked === 1 && calls.manager.length === 1);
    fs.rmSync(cfg.PAYMENT_CHASE_LOG_FILE, { force: true });
    r = await go('2026-11-07', undefined, { sendToManager: null });
    ck('no way to tell her: said out loud, not silent', r.payments.failed.some((f) => /nothing to tell her/.test(f.why)));

    // ── Switch and summary.
    fs.rmSync(cfg.PAYMENT_CHASE_LOG_FILE, { force: true });
    process.env.PAYMENT_CHASE = 'off';
    r = await go('2026-11-07');
    ck('PAYMENT_CHASE=off: the payment half does nothing', r.payments.off === true && calls.manager.length === 0);
    delete process.env.PAYMENT_CHASE;
    ck('the morning line mentions payments', /Payments: 2 payment follow-ups drafted/.test(job.summarise({ payments: { asked: 2, chased: 0, escalated: 0, failed: [] } })));
    ck('  and says nothing when there is nothing', job.summarise({ payments: { asked: 0, chased: 0, escalated: 0, failed: [] } }) === '');

    // ── The structural guarantee: the payment half has no customer path in its code.
    const src = fs.readFileSync(path.join(ROOT, 'helpers/followUpAgentJob.js'), 'utf8');
    const half = src.slice(src.indexOf('async function runPayments'), src.indexOf('// ── A LINE FOR THE MORNING BRIEFING'));
    const code = half.replace(/\/\/[^\n]*/g, '');
    ck('runPayments never references sendEmail / sendWhatsapp / a customer address', !/sendEmail|sendWhatsapp|\.to\b|\.cc\b/.test(code), code.match(/sendEmail|sendWhatsapp|\.to\b|\.cc\b/g) + '');
    const chSrc = fs.readFileSync(path.join(ROOT, 'helpers/paymentChaser.js'), 'utf8').replace(/\/\/[^\n]*/g, '');
    ck('paymentChaser has no send function at all', !/sendEmail|sendMail|require\('\.\/gmail'\)|whatsapp/i.test(chSrc));
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
