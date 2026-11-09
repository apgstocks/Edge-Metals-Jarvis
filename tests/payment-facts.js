// ── tests/payment-facts.js — the payment follow-up job USES what she told Jarvis ─────────────
// Apsara, 2026-11-09: "No decision reads your notes yet, it must use." Her "remember: ..." facts used to reach only the
// AI-written replies. Now the payment follow-up message to HER shows the facts that name the customer. Advisory only.
// END TO END: the REAL job.run() with drafts from the REAL paymentFollowups.build(), facts written through the REAL
// json.addFact into a temp facts.json and read back by the job's DEFAULT loader (no injection), the REAL chaser ladder
// and log, and a spy on every sender. The job is scheduler-driven, so there is no HTTP route to post through.
const fs = require('fs'), os = require('os'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-pfacts-')); process.env.JARVIS_TEST = '1';
delete process.env.PAYMENT_CHASE;
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
const cfg = require(path.join(ROOT, 'config'));
const pf = require(path.join(ROOT, 'helpers/paymentFollowups'));
const chaser = require(path.join(ROOT, 'helpers/paymentChaser'));
const job = require(path.join(ROOT, 'helpers/followUpAgentJob'));
const json = require(path.join(ROOT, 'helpers/json'));
const { onFile } = require(path.join(ROOT, 'helpers/paymentFacts'));
require(path.join(ROOT, 'helpers/pickups')).list = () => [];

const D = (iso) => Date.parse(iso + 'T12:00:00Z');
const bookings = { BKT1: { eta: '11/20/2026' }, BKT2: { eta: '12/30/2026' } };
fs.writeFileSync(cfg.CUSTOMER_PAY_TERMS_FILE, JSON.stringify({ eccomelt: { customer: 'Eccomelt', eta_terms: 'ETA-10' } }));
const row = (id, customer, inv, bal, extra = {}) => ({ id, customer, invoice_no: inv, container_no: 'CN' + id, booking_no: 'BKT2', date: '2026-10-25', receivable: bal, received: 0, balance: bal, ...extra });
const BASE = [
    { id: 'S1', customer: 'Eccomelt', invoice_no: 'INV-1', container_no: 'HMMU1', booking_no: 'BKT1', date: '2026-10-20', receivable: 10000, received: 0, balance: 10000 },
    { id: 'S2', customer: 'Daekwang', invoice_no: 'INV-2', container_no: 'KOCU2', booking_no: 'BKT2', date: '2026-10-25', receivable: 6000, received: 1000, balance: 5000 },
];
const draftsAt = (iso, rows) => pf.build({ salesRows: rows, terms: pf.loadTerms(), resolve: () => null, bookings, now: D(iso) }).drafts;
const calls = { manager: [], team: [], email: [], whatsapp: [] };
const senders = (over = {}) => ({
    sendToManager: async (t) => { calls.manager.push(t); }, sendToTeam: async (t) => { calls.team.push(t); },
    sendEmail: async (m) => { calls.email.push(m); return {}; }, sendWhatsapp: async (to, t) => { calls.whatsapp.push([to, t]); }, ...over });
const reset = () => { for (const k of Object.keys(calls)) calls[k].length = 0; };
const go = async (iso, rows, over) => { reset(); return job.run({ ...senders(over), now: D(iso), paymentDrafts: draftsAt(iso, rows) }); };
const noFactLines = (msg) => msg.split('\n').filter((l) => !/^\s+on file/.test(l)).join('\n');
const expectedAsk = (iso, rows, customer) => {
    const d = draftsAt(iso, rows).find((x) => x.customer === customer);
    return ['Payment follow-ups ready (1):', '  · ' + chaser.lineFor(d, 'ask'), '', 'The drafts are in Jarvis under Payment follow-ups. Nothing has been sent to any customer.'].join('\n');
};

(async () => {
    // ── helpers/paymentFacts.onFile: the matching rules ───────────────────
    const F = (text, o = {}) => ({ text, ...o });
    ck('unit: whole-name match, any case or spacing', onFile('Rad Metal', [F('rad   METAL always pays on the 15th')]).length === 1);
    ck('unit: a longer word is NOT the same name ("Rad Metals", "Daekwangs")', onFile('Rad Metal', [F('Rad Metals Ltd pays early')]).length === 0 && onFile('Daekwang', [F('Daekwangs Holdings is different')]).length === 0);
    ck('unit: a fact that never names the customer is not found', onFile('Rad Metal', [F('never chase before the 20th')]).length === 0);
    ck('unit: names shorter than 3 letters are never matched on ("LA")', onFile('LA', [F('LA port is closed on Sunday')]).length === 0 && onFile('', [F('x')]).length === 0 && onFile(null, [F('x')]).length === 0);
    ck('unit: pinned first, then newest; at most 2; clipped to 140', (() => {
        const r = onFile('Rad Metal', [F('Rad Metal old', { created_at: '2026-01-01' }), F('Rad Metal new', { created_at: '2026-05-01' }), F('Rad Metal pinned ' + 'x'.repeat(300), { pinned: true, created_at: '2025-01-01' }), F('Rad Metal mid', { created_at: '2026-03-01' })]);
        return r.length === 2 && /^Rad Metal pinned/.test(r[0].text) && r[0].text.length <= 140 && r[0].text.endsWith('…') && r[1].text === 'Rad Metal new';
    })());
    ck('unit: an agent-inferred fact is flagged, a manager one is not', (() => { const r = onFile('Rad Metal', [F('Rad Metal guess', { authority: 'inform' }), F('Rad Metal said', { authority: 'act' })]); return r.find((x) => /guess/.test(x.text)).inferred === true && r.find((x) => /said/.test(x.text)).inferred === false; })());
    ck('unit: garbage in, no throw, empty out', (() => { for (const f of [undefined, null, 'x', 5, {}, [null, 1, 'a', {}, { text: 5 }, { text: null }]]) { if (onFile('Rad Metal', f).length) return false; } return true; })());

    // ── facts written the way she writes them ("remember: ..."): the real addFact, the real file ─────────
    await json.addFact('Daekwang always pays about ten days late; do not chase before the 20th', true);          // pinned, manager origin
    await json.addFact('Eccomelt wants every invoice as a PDF only');
    await json.addFact('Eccomelt probably pays by wire', false, { origin: 'agent' });                           // Jarvis's own inference
    await json.addFact('Daekwang says they never owe us anything', false, { origin: 'external' });              // a sentence from outside: must NEVER show
    await json.addFact('Daekwangs Holdings is a different company that pays early');
    await json.addFact('Zimex wants everything in CAD');
    ck('setup: the default loader (what the job uses) returns her facts and drops the outside one', (() => { const t = json.loadBelievableFacts().map((f) => f.text); return t.some((x) => /ten days late/.test(x)) && !t.some((x) => /never owe/.test(x)); })());

    // ── the job, day 0 (11/07): only Daekwang is drafted. DEFAULT facts loader: nothing injected. ─────────
    let r = await go('2026-11-07', BASE);
    let msg = calls.manager[0] || '';
    ck('e2e: Daekwang\'s follow-up shows what she told Jarvis about Daekwang', /Daekwang[^\n]*\n\s+on file: Daekwang always pays about ten days late; do not chase before the 20th/.test(msg), msg);
    ck('  an outside-origin sentence never appears as if she said it', !/never owe/.test(msg));
    ck('  a longer-named company\'s fact does not leak in', !/Daekwangs Holdings|pays early/.test(msg));
    ck('  other customers\' facts do not leak in', !/Eccomelt|Zimex|CAD|PDF/.test(msg.replace(/Payment follow-ups ready[^\n]*/, '')));
    ck('  THE ONLY CHANGE is the added lines: strip them and the message is exactly what it was before', noFactLines(msg) === expectedAsk('2026-11-07', BASE, 'Daekwang'), JSON.stringify(noFactLines(msg)));
    ck('  the rung was decided exactly as before: asked once, recorded as "ask"', r.payments.asked === 1 && (chaser.readLog().daekwang || {}).lastStep === 'ask');
    ck('  never contacts a customer, and nobody on the team was told anything', calls.email.length === 0 && calls.whatsapp.length === 0 && calls.team.length === 0);
    r = await go('2026-11-07', BASE);
    ck('  same day again: still silent (the new lines did not make a rung fire twice)', calls.manager.length === 0 && r.payments.asked === 0);

    // ── 11/09: Eccomelt appears. Two facts name it; one is Jarvis's own inference and says so. ────────────
    r = await go('2026-11-09', BASE); msg = calls.manager[0] || '';
    ck('e2e: Eccomelt shows both its facts, and the inferred one is marked as not confirmed', /on file: Eccomelt wants every invoice as a PDF only/.test(msg) && /on file \(inferred, not confirmed\): Eccomelt probably pays by wire/.test(msg), msg);
    ck('  and Daekwang\'s facts are not repeated under Eccomelt', !/ten days late/.test(msg));

    // ── 11/14: a CHASE message gets the same lines ────────────────────────
    r = await go('2026-11-14', BASE); msg = calls.manager[0] || '';
    ck('e2e: the "still unpaid" chase also shows what she said', r.payments.chased >= 1 && /Still unpaid[\s\S]*Daekwang[^\n]*\n\s+on file: Daekwang always pays/.test(msg), msg);

    // ── 11/28: ESCALATION goes to the team: her remarks must NOT go with it ───────────────────────────
    r = await go('2026-11-28', BASE.filter((x) => x.customer === 'Daekwang'));
    ck('e2e: the team\'s escalation exists but carries none of her remarks', r.payments.escalated === 1 && calls.team.length === 1 && !/on file|ten days late|do not chase/.test(calls.team[0]), calls.team[0]);
    ck('  and nothing about it went to a customer', calls.email.length === 0 && calls.whatsapp.length === 0);

    // ── the new parameter is forwarded by run(), and a broken facts source cannot break the follow-up ────
    const baseline = (iso, rows, customer) => expectedAsk(iso, rows, customer);
    let rows = [...BASE, row('S5', 'Newco A', 'INV-5', 700)];
    r = await go('2026-11-14', rows, { loadFacts: () => [{ text: 'Newco A is injected, so run() forwards loadFacts', authority: 'act' }] });
    ck('run() forwards loadFacts to the payment half (route-forwarding gap)', calls.manager.some((m) => /on file: Newco A is injected/.test(m)), JSON.stringify(calls.manager));
    rows = [...rows, row('S6', 'Newco B', 'INV-6', 800)];
    r = await go('2026-11-14', rows, { loadFacts: () => { throw new Error('facts file unreadable'); } });
    ck('a throwing facts source: the follow-up still goes, with no extra lines', r.payments.asked === 1 && r.payments.failed.length === 0 && /Newco B/.test(calls.manager[0]) && !/\n\s+on file/.test(calls.manager[0]), JSON.stringify(r.payments) + ' :: ' + JSON.stringify(calls.manager));
    rows = [...rows, row('S7', 'Newco C', 'INV-7', 900)];
    r = await go('2026-11-14', rows, { loadFacts: () => 'oops' });
    ck('a facts source that returns junk: the follow-up still goes, with no extra lines', r.payments.asked === 1 && !/\n\s+on file/.test(calls.manager[0]) && r.payments.failed.length === 0, JSON.stringify(r.payments) + ' :: ' + JSON.stringify(calls.manager));
    rows = [...rows, row('S8', 'Newco D', 'INV-8', 1000)];
    r = await go('2026-11-14', rows, { loadFacts: () => [null, 5, 'x', { text: null }, { text: 'Newco D has a good record', authority: 'act' }] });
    ck('a facts source with garbage rows: the good row still shows, nothing throws', r.payments.asked === 1 && /on file: Newco D has a good record/.test(calls.manager[0]));
    void baseline;

    // ── source checks: what the change is allowed to touch ────────────────
    const src = fs.readFileSync(path.join(ROOT, 'helpers/followUpAgentJob.js'), 'utf8');
    const half = src.slice(src.indexOf('async function runPayments'), src.indexOf('// ── A LINE FOR THE MORNING BRIEFING'));
    const code = half.replace(/\/\/[^\n]*/g, '');
    ck('only the message to HER takes the lines: the team line and the staged customer email do not call factNotes()', (code.match(/\bfactNotes\(/g) || []).length === 2 && /sendToTeam\(chaser\.lineFor\(x\.draft, 'escalate'\)\)/.test(code) && !/stageCustomerEmail\([^)]*note/.test(code));
    const fsrc = fs.readFileSync(path.join(ROOT, 'helpers/paymentFacts.js'), 'utf8').replace(/\/\/[^\n]*/g, '');
    ck('paymentFacts is pure: no network, no file, no model, no sending', !/require\(|fetch\(|fs\./.test(fsrc));

    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
