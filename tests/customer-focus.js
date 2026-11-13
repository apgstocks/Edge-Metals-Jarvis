// tests/customer-focus.js — customer focus END TO END (CLAUDE.md rule 3): real sales, the real brain.process(), a real follow-up log entry,
// her words through the real policy/AI path. "they / their balance / show their case" after a customer came up means THAT customer, only
// then, only for a strong match, only for the manager, and it fades. It reads; it never chases, holds, pays or sends (checked at the end).
const fs = require('fs'), os = require('os'), path = require('path');
const R = (p) => path.join(__dirname, '..', p);
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
process.env.JARVIS_TEST = '1';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-cfocus-'));
process.env.DATA_DIR = path.join(TMP, 'data'); process.env.API_TOKEN = 't';
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
delete require.cache[R('config.js')];
const cfgApp = require(R('config.js'));
const MGR_NUM = '19998887777', MGR = MGR_NUM + '@c.us', TEAM_NUM = '19990001111', TEAM = TEAM_NUM + '@c.us';
fs.writeFileSync(cfgApp.SETTINGS_FILE, JSON.stringify({ manager_number: MGR_NUM, manager_name: 'Apsara', internal_team: [{ name: 'Tim', whatsapp: TEAM_NUM }], yard_staff: [], team_group_id: '', gemini_model: 'x' }));
for (const f of [cfgApp.BOOKINGS_FILE, cfgApp.WORKFLOW_FILE, cfgApp.TRANSCRIPTS_FILE]) fs.writeFileSync(f, '{}');
fs.writeFileSync(cfgApp.FACTS_FILE, '[]');
const emb = require(R('helpers/embeddings.js')); emb.storeEmbedding = async () => {}; emb.searchSimilar = async () => []; emb.deleteEmbeddingsByText = async () => 0;
const gemini = require(R('helpers/gemini.js'));
let prompts = [], AI = { action: 'reply', reply: 'noted', confidence: 0.9 };
gemini.callGeminiJSON = async (prompt) => { prompts.push(String(prompt)); return AI; };
const jsonH = require(R('helpers/json.js')); jsonH.loadTruckers = async () => []; jsonH.loadSuppliers = async () => [];
require(R('helpers/receivables')).buildLedger = async () => ({ rows: [], totals: { outstanding: 0 }, orphans: [], excluded: {} });
const brain = require(R('workflow/brain.js')), actions = require(R('workflow/actions.js')), ctxH = require(R('helpers/context'));
const cf = require(R('helpers/customerFocus'));
let sent = [];
const sendMessage = async (c, t) => { sent.push(String(t)); };
actions.init({ sendMessage, sendToManager: sendMessage, sendToTeam: sendMessage, pushAlert: () => {} });
let seq = 0, logs = [];
const origLog = console.log; console.log = (...a) => { const s = a.join(' '); logs.push(s); if (/^\s+(PASS|FAIL)|^===|^\n===|passed,/.test(s) || process.env.V) origLog(...a); };
async function say(text, { num = MGR_NUM, from = MGR } = {}) {
    sent = []; logs = []; prompts = []; seq++; let threw = null;
    try { await brain.process({ messageId: 'cf-' + seq, chatId: from, senderNumber: num, senderName: 'x', text, hasMedia: false, isGroup: false }, sendMessage); } catch (e) { threw = e; }
    return { threw, all: sent.join('\n'), n: sent.length, rewrote: logs.some((l) => /customer in focus:/.test(l)), prompt: prompts.join('\n') };
}
const sales = require(R('helpers/sales')), chaser = require(R('helpers/paymentChaser'));
const sale = (customer, price, w = 10000) => sales.addSale({ customer, item: 'AL WHEELS DIRTY', date: '2026-10-20', invoice_no: '', weight: w, invoice_price: price, price_unit: 'lb', weight_unit: 'lb' });
const snap = () => ['sales.json', 'payment_chaser.json'].map((f) => { try { return fs.readFileSync(path.join(process.env.DATA_DIR, f), 'utf8'); } catch (e) { return ''; } }).join('|');
const NOW = Date.now(), MIN = 60000;

(async () => {
    const ago = (d) => new Date(Date.now() - d * 86400000).toISOString();
    await chaser.writeLog({ 'rad metal': { set: 'x', firstAt: ago(12), lastStep: 'escalate', lastAt: ago(2), customer: 'Rad Metal', steps: { ask: ago(12), chase: ago(7), escalate: ago(2) } } });
    await sale('Rad Metal', 1.5); await sale('Eccomelt', 1.6); await sale('Zimex', 1.5); await sale('Zimex Corp', 1.5);
    console.log('\n=== the module: strong cues only, it fades, names win ===');
    const S = (name, at) => ({ focusCustomer: { name, at } });
    ck('a known customer matches exactly, case and spacing aside', cf.match('rad  metal') === 'Rad Metal');
    ck('Inc/LLC are ignored: "Eccomelt LLC" is Eccomelt', cf.match('Eccomelt LLC') === 'Eccomelt');
    ck('two customers with the same words -> no match (a hazy memory is not used)', cf.match('zimex inc') === null && cf.match('Zimex') === 'Zimex');
    ck('an unknown name matches nothing', cf.match('Nobody Metals') === null && cf.match('') === null);
    ck('the owe questions resolve to the named question', ['what do they owe', 'How much does he owe us?', "what's their balance", 'whats their balance', 'do they still owe us anything', 'so what do they owe now']
        .every((t) => (cf.resolve(t, S('Rad Metal', NOW), NOW) || {}).text === 'what does Rad Metal owe'));
    ck('the case questions resolve to "case <name>"', ['show their case', 'how are we with them', "what's going on with them", 'their history'].every((t) => (cf.resolve(t, S('Rad Metal', NOW), NOW) || {}).text === 'case Rad Metal'));
    ck('no focus -> nothing is rewritten', cf.resolve('what do they owe', {}, NOW) === null && cf.resolve('what do they owe', null, NOW) === null);
    ck('it fades: 59 minutes yes, 61 minutes no', cf.resolve('their balance', S('Rad Metal', NOW - 59 * MIN), NOW) !== null && cf.resolve('their balance', S('Rad Metal', NOW - 61 * MIN), NOW) === null);
    ck('a sentence that names someone is never rewritten', ['what does Acme owe', 'what do they owe Acme', 'forward the booking to Inesh', 'their balance with Acme'].every((t) => cf.resolve(t, S('Rad Metal', NOW), NOW) === null));
    ck('only the exact shapes: a longer sentence that merely contains one is left alone', ['please tell me what do they owe', 'what do they owe and when is the truck', 'can you show their case file for last year'].every((t) => cf.resolve(t, S('Rad Metal', NOW), NOW) === null));
    ck('actions are NOT resolved from a focus (chase / hold / pay / send)', ['chase them', 'hold their follow-up', 'pay them', 'send them the invoice', 'email them'].every((t) => cf.resolve(t, S('Rad Metal', NOW), NOW) === null));
    ck('"case closed" parses as a shape but is not a known customer', cf.parseCaseCommand('case closed').name === 'closed' && cf.match('closed') === null && cf.parseCaseCommand('the case is closed') === null);

    console.log('\n=== end to end: the real brain ===');
    chaser.writeLog && 0;
    ctxH.updateSession(MGR, { activeBooking: 'HOU111', currentTopic: 'booking_status' });
    let r = await say('what do they owe');
    ck('BEFORE any customer came up, "what do they owe" is left exactly as she typed it', !r.rewrote && /what do they owe/i.test(r.prompt) && !/what does Rad Metal owe/.test(r.prompt), r.prompt.slice(-300));
    r = await say('case Rad Metal');
    ck('"case Rad Metal" answers by policy (no AI) with the status and what is owed', !r.threw && /Rad Metal: /.test(r.all) && /Owes \$/.test(r.all) && r.prompt === '', r.all + (r.threw ? r.threw.stack : ''));
    ck('...and a read-only reply: one message, with the latest events from the follow-up log', r.n === 1 && /Latest:/.test(r.all) && /sent a reminder/.test(r.all) && /passed to the team/.test(r.all), r.all);
    r = await say('show their case');
    ck('NOW "show their case" means Rad Metal, by policy, no AI', !r.threw && r.rewrote && /Rad Metal: /.test(r.all) && r.prompt === '', r.all);
    r = await say("what's their balance");
    ck('"what\'s their balance" reaches the classifier as "what does Rad Metal owe"', r.rewrote && /what does Rad Metal owe/.test(r.prompt) && !/their balance/.test(r.prompt.split('NEW MESSAGE')[1] || ''), (r.prompt.split('NEW MESSAGE')[1] || '').slice(0, 200));
    r = await say('what does Eccomelt owe');
    ck('a sentence that NAMES another customer is never rewritten to the one in focus', !r.rewrote && /what does Eccomelt owe/.test(r.prompt));
    AI = { action: 'show_receivables', target_name: 'Eccomelt', confidence: 0.9 };
    r = await say('who owes me from Eccomelt');
    AI = { action: 'reply', reply: 'noted', confidence: 0.9 };
    ck('naming a customer for receivables moves the focus to them', (ctxH.getSession(MGR) || {}).focusCustomer && ctxH.getSession(MGR).focusCustomer.name === 'Eccomelt', JSON.stringify((ctxH.getSession(MGR) || {}).focusCustomer));
    r = await say('show their case');
    ck('...so "their case" is now Eccomelt, not Rad Metal', /Eccomelt: /.test(r.all) && !/Rad Metal: /.test(r.all), r.all);
    ck('the BOOKING in focus is untouched by all of this', ctxH.getSession(MGR).activeBooking === 'HOU111' && ctxH.getSession(MGR).currentTopic !== undefined);

    console.log('\n=== it fades, and weak cues set nothing ===');
    ctxH.updateSession(MGR, { focusCustomer: { name: 'Rad Metal', at: Date.now() - 61 * MIN } });
    r = await say('their balance');
    ck('after an hour the focus has faded: left as typed', !r.rewrote && /their balance/.test(r.prompt));
    const before = JSON.stringify(ctxH.getSession(MGR).focusCustomer);
    r = await say('case Nobody Metals');
    ck('an unknown name is not a case command: it goes the normal way (to the classifier) and sets no focus', r.prompt !== '' && !/Nobody Metals: /.test(r.all) && JSON.stringify(ctxH.getSession(MGR).focusCustomer) === before);
    ck('an ambiguous name ("Zimex Inc") sets no focus', cf.note(MGR, 'Zimex Inc') === false && JSON.stringify(ctxH.getSession(MGR).focusCustomer) === before);
    ck('an Edge Yard-only party is not a known customer here, so it never becomes a focus', cf.note(MGR, 'Some Yard Supplier') === false);
    r = await say('case closed');
    ck('the word "case" in an ordinary sentence is untouched (goes to the classifier)', r.prompt !== '' && /case closed/.test(r.prompt), r.all);

    console.log('\n=== who may use it ===');
    ctxH.updateSession(MGR, { focusCustomer: { name: 'Rad Metal', at: Date.now() } });
    r = await say('case Rad Metal', { num: TEAM_NUM, from: TEAM });
    ck('a team member does NOT get a customer\'s balance over WhatsApp, and "case Rad Metal" is just ordinary text for them (classifier)', !/Owes \$|Rad Metal: /.test(r.all) && r.prompt !== '', r.all);
    ctxH.updateSession(TEAM, { focusCustomer: { name: 'Rad Metal', at: Date.now() } });
    r = await say('show their case', { num: TEAM_NUM, from: TEAM });
    ck('...and a team member\'s "show their case" is not rewritten either', !r.rewrote && !/Rad Metal: /.test(r.all));

    console.log('\n=== a question that is open keeps her real words ===');
    await actions.setPending(MGR, { type: 'await_manual_email_address', created_at: Date.now(), context: {} });
    ctxH.updateSession(MGR, { focusCustomer: { name: 'Rad Metal', at: Date.now() } });
    r = await say('their balance');
    ck('with a question open, her words are NOT rewritten (a verbatim answer must stay verbatim)', !r.rewrote, r.all);

    console.log('\n=== read-only ===');
    const b = snap();
    await say('show their case'); await say('case Rad Metal');
    ck('asking about a customer changed no sale and no follow-up record', snap() === b);
    console.log = origLog;
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.log = origLog; console.error(e); process.exit(1); });
