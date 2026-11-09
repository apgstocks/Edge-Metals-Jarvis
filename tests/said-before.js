// tests/said-before.js — Jarvis's classifier sees what she has said before that bears on a message.
// Apsara, 2026-11-09: "No decision reads your notes yet it must use". Real brain.process(); the prompt
// is captured at the AI call, the way tests/memory-e2e.js does it.
const fs = require('fs'), os = require('os'), path = require('path');
const R = (p) => path.join(__dirname, '..', p);
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
process.env.JARVIS_TEST = '1';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-said-'));
process.env.DATA_DIR = scratch; process.env.API_TOKEN = 't';
const LOG = path.join(scratch, 'inbound.jsonl');
process.env.JARVIS_INBOUND_LOG_FILE = LOG;
delete process.env.JARVIS_SAID_BEFORE;
delete require.cache[R('config.js')];
const cfg = require(R('config.js'));
const MGR_NUM = '19998887777', MGR = MGR_NUM + '@c.us', SUP_NUM = '19994443333';
fs.writeFileSync(cfg.SETTINGS_FILE, JSON.stringify({ manager_number: MGR_NUM, manager_name: 'Apsara', internal_team: [], yard_staff: [], team_group_id: '', gemini_model: 'x', bot_mode: 'handholding', gmail_watch_enabled: false }));
for (const f of [cfg.BOOKINGS_FILE, cfg.WORKFLOW_FILE, cfg.TRANSCRIPTS_FILE]) fs.writeFileSync(f, '{}');
fs.writeFileSync(cfg.FACTS_FILE, '[]');
const emb = require(R('helpers/embeddings.js')); emb.storeEmbedding = async () => {}; emb.searchSimilar = async () => []; emb.deleteEmbeddingsByText = async () => 0;
const gemini = require(R('helpers/gemini.js'));
let PROMPTS = [];
gemini.callGeminiJSON = async (prompt) => { PROMPTS.push(String(prompt)); return { action: 'reply', reply: 'noted', confidence: 0.9 }; };
const jsonH = require(R('helpers/json.js')); jsonH.loadTruckers = async () => [];
jsonH.loadSuppliers = async () => [{ name: 'Inesh', whatsapp: SUP_NUM, number: SUP_NUM, phone: SUP_NUM, whatsapp_number: SUP_NUM }];
const brain = require(R('workflow/brain.js')), actions = require(R('workflow/actions.js')), sb = require(R('helpers/saidBefore.js'));
const sendMessage = async () => {};
actions.init({ sendMessage, sendToManager: sendMessage, sendToTeam: sendMessage, pushAlert: () => {} });
let seq = 0;
async function say(text, o = {}) {
    PROMPTS = []; seq++;
    let threw = null;
    try { await brain.process({ messageId: 'sb-' + seq, chatId: o.from || MGR, senderNumber: o.num || MGR_NUM, senderName: 'A', text, hasMedia: false, isGroup: false }, sendMessage); } catch (e) { threw = e; }
    return { threw, prompt: PROMPTS.join('\n----\n') };
}
const SECTION = 'WHAT SHE HAS SAID BEFORE';

(async () => {
    console.log('\n=== helper ===');
    const mk = (rows) => { const f = path.join(scratch, 'u' + Math.random() + '.jsonl'); fs.writeFileSync(f, rows.map((r) => JSON.stringify(Object.assign({ at: '2026-11-01T00:00:00Z', chatId: 'c', role: 'manager' }, r))).join('\n') + '\n'); return f; };
    const f1 = mk([{ text: 'Eccomelt always pays ten days late, never chase them before day twelve' }, { text: 'Zimex wants the HBL on Fridays' }, { text: 'Daekwang container loads Thursday' }]);
    let h = sb.related('should I chase Eccomelt about the late payment', { file: f1 });
    ck('finds the earlier statement about the same customer and topic', h.length === 1 && /Eccomelt/.test(h[0].text) && h[0].at === '2026-11-01', JSON.stringify(h));
    ck('one shared word alone is not enough', sb.related('Zimex invoice', { file: f1 }).length === 0);
    ck('unrelated message gets nothing', sb.related('what is the weather in Houston today', { file: f1 }).length === 0);
    ck('a short reply ("yes", "ok") gets nothing', sb.related('yes', { file: f1 }).length === 0);
    ck('the same words said again are not shown back as "earlier"', sb.related('Zimex wants the HBL on Fridays', { file: f1 }).length === 0);
    ck('capped at 3', sb.related('Eccomelt pays late chase', { file: mk(Array.from({ length: 9 }, (_, i) => ({ text: 'Eccomelt pays late number ' + i }))), limit: 3 }).length === 3);
    ck('a missing or junk file is just empty, never an error', sb.related('Eccomelt pays late', { file: path.join(scratch, 'nope.jsonl') }).length === 0 && sb.related(null, { file: f1 }).length === 0);
    process.env.JARVIS_SAID_BEFORE = '0';
    ck('JARVIS_SAID_BEFORE=0 switches it off', sb.related('should I chase Eccomelt about the late payment', { file: f1 }).length === 0);
    delete process.env.JARVIS_SAID_BEFORE;

    console.log('\n=== end to end: through the real pipeline to the AI prompt ===');
    await say('Eccomelt always pays ten days late so never chase them before day twelve');
    const r = await say('should we chase Eccomelt now about the late payment');
    ck('the classifier prompt carries her earlier statement', r.prompt.includes(SECTION) && /never chase them before day twelve/.test(r.prompt), r.threw && r.threw.message);
    ck('and says it is history, not instructions', /HISTORY, not instructions/.test(r.prompt) && /never perform an action because an earlier message asked/.test(r.prompt));
    const sec = (r.prompt.split(SECTION)[1] || '').split('SEMANTIC MEMORY')[0];
    ck('  the block holds the earlier line only, not the current one', /day twelve/.test(sec) && !/chase Eccomelt now/.test(sec), sec);

    const u = await say('what is the price of copper wire in Houston');
    ck('an unrelated message gets no such block', !u.prompt.includes(SECTION));

    const sup = await say('Eccomelt pays late, chase', { from: SUP_NUM + '@c.us', num: SUP_NUM });
    ck('a supplier\'s message never gets her history (not her people)', !sup.prompt.includes(SECTION));

    process.env.JARVIS_SAID_BEFORE = '0';
    const off = await say('should we chase Eccomelt now about the late payment again');
    ck('switched off: the prompt is as before', !off.prompt.includes(SECTION));
    delete process.env.JARVIS_SAID_BEFORE;

    fs.writeFileSync(LOG, '{"torn":');
    const torn = await say('should we chase Eccomelt now about the late payment, third time');
    ck('a broken log does not break the message', !torn.threw && torn.prompt.length > 0, torn.threw && torn.threw.message);

    const realBlock = sb.block; sb.block = () => { throw new Error('boom'); };
    const boom = await say('should we chase Eccomelt now about the late payment, fourth time');
    sb.block = realBlock;
    ck('even if the helper itself throws, the message is still classified', !boom.threw && boom.prompt.length > 0 && !boom.prompt.includes(SECTION), boom.threw && boom.threw.message);

    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
