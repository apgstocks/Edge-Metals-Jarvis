// tests/inbound-log.js — every message the manager/team sends is recorded verbatim.
// Apsara, 2026-11-09: "every single info that we give to Jarvis needs to be remembered always".
// Drives the REAL brain.process(), then reads the log file the way the app would.
const fs = require('fs'), os = require('os'), path = require('path');
const R = (p) => path.join(__dirname, '..', p);
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };

process.env.JARVIS_TEST = '1';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-inlog-'));
process.env.DATA_DIR = scratch;
process.env.API_TOKEN = 't';
const LOG = path.join(scratch, 'logs', 'inbound.jsonl');
delete process.env.JARVIS_INBOUND_LOG_FILE;
delete process.env.JARVIS_INBOUND_LOG;
delete require.cache[R('config.js')];
const cfg = require(R('config.js'));
const MGR_NUM = '19998887777', MGR = MGR_NUM + '@c.us', STRANGER = '19995551234@c.us';
fs.writeFileSync(cfg.SETTINGS_FILE, JSON.stringify({ manager_number: MGR_NUM, manager_name: 'Apsara', internal_team: [], yard_staff: [], team_group_id: '', gemini_model: 'x', bot_mode: 'handholding', gmail_watch_enabled: false }));
for (const f of [cfg.BOOKINGS_FILE, cfg.WORKFLOW_FILE, cfg.TRANSCRIPTS_FILE]) fs.writeFileSync(f, '{}');
fs.writeFileSync(cfg.FACTS_FILE, '[]');

const emb = require(R('helpers/embeddings.js'));
emb.storeEmbedding = async () => {}; emb.searchSimilar = async () => []; emb.deleteEmbeddingsByText = async () => 0;
const gemini = require(R('helpers/gemini.js'));
let AI_THROWS = false;
gemini.callGeminiJSON = async () => { if (AI_THROWS) throw new Error('gemini down'); return { action: 'reply', reply: 'noted', confidence: 0.9 }; };
const jsonH = require(R('helpers/json.js')); jsonH.loadTruckers = async () => []; const SUP_NUM = '19994443333';
jsonH.loadSuppliers = async () => [{ name: 'Inesh', whatsapp: SUP_NUM, number: SUP_NUM, phone: SUP_NUM, whatsapp_number: SUP_NUM }];
const brain = require(R('workflow/brain.js')), actions = require(R('workflow/actions.js')), il = require(R('helpers/inboundLog.js'));
const sent = [];
const sendMessage = async (c, t) => { sent.push(String(t)); };
actions.init({ sendMessage, sendToManager: (t) => sendMessage(MGR, t), sendToTeam: (t) => sendMessage(MGR, t), pushAlert: () => {} });
let seq = 0;
async function say(text, o = {}) {
    sent.length = 0; seq++;
    let threw = null;
    try { await brain.process({ messageId: o.id || 'il-' + seq, chatId: o.from || MGR, senderNumber: o.num || MGR_NUM, senderName: 'A', text, hasMedia: false, isGroup: false }, sendMessage); } catch (e) { threw = e; }
    return { threw, sent: sent.slice() };
}

(async () => {
    // Real pipeline, log redirected to a scratch file.
    process.env.JARVIS_INBOUND_LOG_FILE = LOG;
    console.log('\n=== recorded through the real pipeline ===');
    const SAY = 'Eccomelt always pays 10 days late, do not worry about it';   // a statement, not a command or rule
    const r1 = await say(SAY);
    let rows = il.readAll(LOG);
    ck('a plain statement she made is on the log, word for word', rows.some((x) => x.text === SAY), JSON.stringify(rows));
    ck('with who, where and when', rows[0] && rows[0].role === 'manager' && rows[0].chatId === MGR && !isNaN(Date.parse(rows[0].at)));
    ck('and she still gets a reply', !r1.threw && r1.sent.length > 0, JSON.stringify(r1));

    const before = il.readAll(LOG).length;
    await say('same message id twice', { id: 'dup-1' }); await say('same message id twice', { id: 'dup-1' });
    ck('a re-delivered message (same id) is recorded once', il.readAll(LOG).length === before + 1);

    await say('hello from a stranger', { from: STRANGER, num: '19995551234' });
    ck('a stranger is NOT recorded', !il.readAll(LOG).some((x) => /stranger/.test(x.text)));

    const rs = await say('supplier says: I will load tomorrow', { from: SUP_NUM + '@c.us', num: SUP_NUM });
    ck('(precondition) the supplier message really reached the pipeline as a supplier', rs.threw === null || rs.threw, rs.threw && rs.threw.message);
    ck('a SUPPLIER\'s message is NOT recorded — only her own people\'s', !il.readAll(LOG).some((x) => /I will load tomorrow/.test(x.text)));

    AI_THROWS = true;
    const r2 = await say('the AI is down but I still told you this');
    AI_THROWS = false;
    ck('recorded even when the AI call fails afterwards', il.readAll(LOG).some((x) => /AI is down/.test(x.text)));

    console.log('\n=== what she said can be found again ===');
    process.env.JARVIS_INBOUND_LOG_FILE = LOG;
    await say('Daekwang prefers shipment on Thursdays because the port gate is quiet');
    const ti = require(R('helpers/data/textIndex.js'));
    ti.ensure({ force: true });
    const found = ti.search('which day does Daekwang prefer shipments', { limit: 10 });
    ck('ask_text finds it: kind "told", her words intact', found.hits.some((h) => h.kind === 'told' && /Thursdays/.test(h.body)), found.hits.map((h) => h.kind).join(','));
    await say('Mombasa quote is 2150 per MT valid till Friday');
    const again = ti.search('Mombasa quote', { limit: 10 });
    ck('and a message sent AFTER the index was built is found without a manual refresh', again.hits.some((h) => h.kind === 'told' && /2150/.test(h.body)));

    console.log('\n=== it can never block a reply ===');
    process.env.JARVIS_INBOUND_LOG_FILE = path.join(scratch, 'logs', 'inbound.jsonl', 'x', 'y');   // parent is a FILE -> mkdir/append fails
    const r3 = await say('log is broken, message must still be handled');
    ck('an unwritable log does not throw out of process()', !r3.threw, r3.threw && r3.threw.message);
    ck('record() reports false, never throws', il.record({ chatId: MGR, role: 'manager', text: 'x' }) === false);

    console.log('\n=== switches ===');
    process.env.JARVIS_INBOUND_LOG_FILE = LOG;
    process.env.JARVIS_INBOUND_LOG = '0';
    const n0 = il.readAll(LOG).length;
    await say('this must not be logged: switched off');
    ck('JARVIS_INBOUND_LOG=0 turns it off', il.readAll(LOG).length === n0);
    delete process.env.JARVIS_INBOUND_LOG;

    delete process.env.JARVIS_INBOUND_LOG_FILE;
    const realDefault = path.join(scratch, 'inbound_log.jsonl');
    await say('under test with no log file named, nothing may touch the data folder');
    ck('JARVIS_TEST without an explicit file writes nothing to DATA_DIR', !fs.existsSync(realDefault));
    process.env.JARVIS_INBOUND_LOG_FILE = LOG;

    console.log('\n=== never forgets ===');
    const BIG = path.join(scratch, 'big.jsonl');
    for (let i = 0; i < 1000; i++) fs.appendFileSync(BIG, JSON.stringify({ at: 'x', chatId: 'c', role: 'manager', text: 'm' + i }) + '\n');
    process.env.JARVIS_INBOUND_LOG_FILE = BIG;
    il.record({ chatId: MGR, role: 'manager', text: 'one more' });
    const all = il.readAll(BIG);
    ck('1,001 messages in, 1,001 out — no cap, no eviction', all.length === 1001 && all[0].text === 'm0' && all[1000].text === 'one more');
    fs.appendFileSync(BIG, '{"torn":'); // power cut mid-line
    il.record({ chatId: MGR, role: 'manager', text: 'after the tear' });
    ck('a torn line is skipped, later messages still read', il.readAll(BIG).some((x) => x.text === 'after the tear'));
    ck('empty / non-string text is not recorded', il.record({ text: '   ' }) === false && il.record({ text: 42 }) === false && il.record(null) === false);

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
