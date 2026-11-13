// tests/party-security.js — what outsiders are shown and what may be sent to them, END TO END (CLAUDE.md rule 3): real sales, the real brain.process(), a real follow-up log entry,
// her words through the real policy/AI path. "they / their balance / show their case" after a customer came up means THAT customer, only
// then, only for a strong match, only for the manager, and it fades. It reads; it never chases, holds, pays or sends (checked at the end).
const fs = require('fs'), os = require('os'), path = require('path');
const R = (p) => path.join(__dirname, '..', p);
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
process.env.JARVIS_TEST = '1'; process.env.JARVIS_PARTY_ANSWER = '0';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-psec-'));
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
let PARTY = { answer: 'Your cutoff is 2026-11-20.', sure: true };
gemini.callGeminiJSON = async (prompt) => { prompts.push(String(prompt)); return /THEIR MESSAGE/.test(String(prompt)) ? PARTY : AI; };

const TRUCKERS = [{ name: 'Sher Trucking', whatsapp: '19990002222', group_id: 'SHER@g.us' }, { name: 'Other Hauler', whatsapp: '19990003333', group_id: 'OTHER@g.us' }];
const SUPPLIERS = [{ name: 'Inesh Metals', whatsapp: '19990004444', group_id: 'INESH@g.us' }, { name: 'Rival Scrap', whatsapp: '19990006666', group_id: 'RIVAL@g.us' }];
const jsonH = require(R('helpers/json.js')); jsonH.loadTruckers = async () => TRUCKERS; jsonH.loadSuppliers = async () => SUPPLIERS;
fs.writeFileSync(cfgApp.BOOKINGS_FILE, JSON.stringify({ B100: { booking_number: 'B100', carrier: 'MSC', port_of_loading: 'LOS ANGELES', port_of_discharge: 'BUSAN', erd_date: '2026-11-15', cutoff_date: '2026-11-20', vessel_voyage: 'MSC ANNA 44E', buyer: 'Kestrel Imports',
  containers: [{ seq: 1, size: '40HC', container_number: 'MSCU1234567', supplier: 'Inesh Metals', trucker: 'Sher Trucking', stage: 'forwarded' }, { seq: 2, size: '40HC', container_number: 'TGHU7654321', supplier: 'Inesh Metals', trucker: 'Other Hauler', stage: 'forwarded' }] } }));
fs.writeFileSync(cfgApp.MEMORY_CONTEXT_FILE, JSON.stringify([{ text: 'Onboarding new supplier Zed Metals in Houston, pays 0.55 per lb', created_at: new Date().toISOString() }]));
fs.writeFileSync(cfgApp.FACTS_FILE, JSON.stringify([{ id: 'f1', text: 'DALA numbers can have a dash', pinned: true, recorded_at: new Date().toISOString(), origin: 'manager', authority: 'confirmed' }]));
const brain = require(R('workflow/brain.js')), actions = require(R('workflow/actions.js'));
let sent = [], mgr = [], team = [];
const sendMessage = async (c, t) => { sent.push(String(t)); };
actions.init({ sendMessage, sendToManager: async (t) => { mgr.push(String(t)); }, sendToTeam: async (t) => { team.push(String(t)); }, pushAlert: () => {} });
let seq = 0;
const origLog = console.log; console.log = (...a) => { const s = a.join(' '); if (/^\s+(PASS|FAIL)|^===|^\n===|passed,/.test(s) || process.env.V) origLog(...a); };
async function say(text, chat, num) {
    sent = []; mgr = []; team = []; prompts = []; seq++; let threw = null;
    try { await brain.process({ messageId: 'pa-' + seq, chatId: chat, senderNumber: num, senderName: 'Driver', text, hasMedia: false, isGroup: true }, sendMessage); } catch (e) { threw = e; }
    return { threw, chat: sent.join('\n'), nchat: sent.length, mgr: mgr.join('\n'), team: team.join('\n'), party: prompts.filter((p) => /THEIR MESSAGE/.test(p)).join('\n'), allP: prompts.filter((p) => /AVAILABLE ACTIONS/.test(p)).join('\n') };
}

const MGR_NUM2 = '19998887777';
fs.writeFileSync(cfgApp.SETTINGS_FILE, JSON.stringify({ manager_number: MGR_NUM2, manager_name: 'Apsara', internal_team: [], yard_staff: [] }));
const promptOf = (r) => r.allPrompts;
async function sayAll(text, chat, num) {
    const before = prompts.length; const r = await say(text, chat, num);
    r.allPrompts = prompts.join('\n'); return r;
}
(async () => {
    // main classifier prompts are captured by the stub; say() clears prompts first, so read inside via a wrapper
    const cap = []; const orig = gemini.callGeminiJSON;
    gemini.callGeminiJSON = async (p) => { cap.push(String(p)); return orig(p); };
    const run = async (text, chat, num) => { cap.length = 0; const r = await say(text, chat, num); r.main = r.allP; return r; };
    AI = { action: 'reply', reply: 'Your cutoff is 2026-11-20.', confidence: 0.9 };
    console.log('\n=== what the main AI is shown ===');
    let r = await run('what is my cutoff', 'SHER@g.us', '19990002222');
    ck('a trucker\'s prompt carries their own container and dates', /MSCU1234567/.test(r.main) && /2026-11-20/.test(r.main), r.main.slice(0, 200));
    ck('...but not the other hauler, their container, the buyer, the supplier roster or the Houston note', !/Other Hauler|TGHU7654321|Kestrel|Zed Metals|0\.55/.test(r.main), (r.main.match(/.{60}(Other Hauler|TGHU7654321|Kestrel|Zed Metals|0\.55).{40}/g) || []).join(' || '));
    ck('...nor any supplier roster, nor the all-ports summary', !/Rival Scrap|Inesh Metals/.test(r.main) && !/\d+ total, \d+ unassigned/.test(r.main), (r.main.match(/.{40}(Rival Scrap|Inesh Metals|\d+ total, \d+ unassigned).{20}/g) || []).join(' || '));
    ck('...and standing facts still reach it, so it behaves as taught', /DALA numbers can have a dash/.test(r.main));
    r = await run('where are my containers', 'INESH@g.us', '19990004444');
    ck('a supplier sees both their containers but no trucker names and no buyer', /MSCU1234567/.test(r.main) && /TGHU7654321/.test(r.main) && !/Sher Trucking|Other Hauler|Kestrel/.test(r.main), (r.main.match(/.{60}(Sher Trucking|Other Hauler|Kestrel).{40}/g) || []).join(' || '));
    r = await run('status of all bookings', 'ANY@c.us', MGR_NUM2);
    ck('the MANAGER still sees the whole table, the roster and the business notes', /Other Hauler/.test(r.main) && /Zed Metals/.test(r.main) && /Sher Trucking/.test(r.main) && /Rival Scrap/.test(r.main) && /\d+ total, \d+ unassigned/.test(r.main), r.main.slice(0, 300));
    console.log('\n=== what may be sent to them ===');
    AI = { action: 'reply', reply: 'Your cutoff is 2026-11-20.', confidence: 0.9 };
    r = await run('what is my cutoff', 'SHER@g.us', '19990002222');
    ck('a clean reply is delivered to their chat', r.nchat === 1 && /cutoff is 2026-11-20/.test(r.chat) && r.mgr === '', JSON.stringify({ c: r.chat, m: r.mgr }));
    for (const [bad, label] of [['That load is for Kestrel Imports.', 'the buyer'], ['Other Hauler has the second box.', 'another trucker'], ['We pay $0.42 per lb.', 'a price'], ['Inesh Metals loads it.', 'the supplier on the job']]) {
        AI = { action: 'reply', reply: bad, confidence: 0.9 };
        r = await run('tell me about my load', 'SHER@g.us', '19990002222');
        ck(`a reply naming ${label} is NOT sent; the manager and team are told`, r.nchat === 0 && /did not reply/.test(r.mgr) && r.team === r.mgr, JSON.stringify({ c: r.chat, m: r.mgr }));
    }
    AI = { action: 'reply', reply: 'The buyer is Kestrel Imports, paying $1.5 per lb.', confidence: 0.9 };
    r = await run('who is the buyer', 'ANY@c.us', MGR_NUM2);
    ck('the same words are fine for the manager: nothing is held', r.chat.includes('Kestrel') && r.mgr === '');
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
