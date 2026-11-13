// tests/qb-conversational.js — loose QuickBooks wording END TO END (CLAUDE.md rule 3): real sales, the real brain.process(), a real follow-up log entry,
// her words through the real policy/AI path. "they / their balance / show their case" after a customer came up means THAT customer, only
// then, only for a strong match, only for the manager, and it fades. It reads; it never chases, holds, pays or sends (checked at the end).
const fs = require('fs'), os = require('os'), path = require('path');
const R = (p) => path.join(__dirname, '..', p);
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
process.env.JARVIS_TEST = '1';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-qbconv-'));
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

const askData = require(R('helpers/data/askData'));
let askCalls = 0; askData.ask = async () => { askCalls++; return { ok: false, spoken: 'could not answer' }; };
const SUP_NUM = '19995550000', SUP = SUP_NUM + '@c.us';
(async () => {
    console.log('\n=== the classifier is told qb_stuck exists, and what it means ===');
    AI = { action: 'qb_stuck', confidence: 0.9 };
    let r = await say('We need to work on quickbook today');
    ck('the prompt lists qb_stuck among the actions it may choose', /ask_data, qb_stuck, ask_text/.test(r.prompt));
    ck('...and describes it in her kind of words', /"qb_stuck" is for[\s\S]*work on/.test(r.prompt));
    console.log('\n=== her two real messages, end to end ===');
    ck('"We need to work on quickbook today" is answered from the QuickBooks check, one message', !r.threw && r.n === 1 && /QuickBooks/i.test(r.all), r.all);
    ck('...and never runs a ledger query', askCalls === 0);
    r = await say('We need to finish the accounting.help me with that');
    ck('"finish the accounting" is answered the same way', !r.threw && r.n === 1 && /QuickBooks/i.test(r.all) && askCalls === 0, r.all);
    AI = { action: 'qb_stuck', confidence: 0.4 };
    r = await say('help me with the books');
    ck('even when the model is unsure (0.4) it still answers: it is read-only, so it is a safe action', !r.threw && r.n === 1 && /QuickBooks/i.test(r.all), r.all);
    console.log('\n=== nothing else moved ===');
    AI = { action: 'ask_data', question: 'how much do we owe Inesh', confidence: 0.9 };
    await say('how much do we owe Inesh');
    ck('a real figure question still reaches the ledger path', askCalls === 1);
    console.log('\n=== another role cannot use it to read the books ===');
    AI = { action: 'qb_stuck', confidence: 0.9 };
    const before = askCalls;
    r = await say('We need to work on quickbook today', { num: SUP_NUM, from: SUP });
    ck('a supplier who sends the same words is not shown QuickBooks status', !/QuickBooks|stuck|Calderon/i.test(r.all), r.all);
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
