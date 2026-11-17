// ── tests/taught-recall.js — what she TAUGHT reaches the prompt Jarvis answers from ──────────────
// Apsara, 2026-11-15: yes to "recall in decisions". CLAUDE.md rule 3: end to end. So section C teaches a rule through
// the real teach runner, types a message through workflow/brain.js process() (what index.js hands every WhatsApp
// message to), and reads the rule out of the exact prompt string handed to the model.
// Temp DATA_DIR. No network: the model call is stubbed, the embedder is the stub (JARVIS_TEST=1).
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = (p) => path.join(__dirname, '..', p);

let pass = 0, fail = 0;
const failures = [];
function ck(name, cond, detail) {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

process.env.JARVIS_TEST = '1';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-taught-'));
process.env.DATA_DIR = scratch;
process.env.API_TOKEN = 'taught-token';
delete require.cache[require.resolve(R('config.js'))];
const cfg = require(R('config.js'));
const MGR_NUM = '19998887777', MGR = MGR_NUM + '@c.us';
fs.writeFileSync(cfg.SETTINGS_FILE, JSON.stringify({ manager_number: MGR_NUM, manager_name: 'Apsara', internal_team: [], yard_staff: [], team_group_id: '', gemini_model: 'x', bot_mode: 'handholding', gmail_watch_enabled: false }, null, 2));
for (const f of [cfg.BOOKINGS_FILE, cfg.WORKFLOW_FILE, cfg.TRANSCRIPTS_FILE]) fs.writeFileSync(f, '{}');
fs.writeFileSync(cfg.FACTS_FILE, '[]');

const embeddings = require(R('helpers/embeddings.js'));
embeddings.storeEmbedding = async () => {};
embeddings.searchSimilar = async () => [];
const gemini = require(R('helpers/gemini.js'));
const PROMPTS = [];
gemini.callGeminiJSON = async (prompt) => { PROMPTS.push(String(prompt)); return { intent: 'reply', reply: 'ok', confidence: 0.9 }; };
const jsonH = require(R('helpers/json.js'));
jsonH.loadTruckers = async () => [];
jsonH.loadSuppliers = async () => [];

const embedders = require(R('helpers/disk/embedder.js'));
const stub = embedders.stub();
const recall = require(R('helpers/taughtRecall.js'));
recall._setEmbedder(stub);
const { getDisk } = require(R('helpers/diskStore.js'));
const { createRunner } = require(R('agents/teach'));
const context = require(R('helpers/context.js'));
const brain = require(R('workflow/brain.js'));
const actions = require(R('workflow/actions.js'));

const sent = [];
const sendMessage = async (c, t) => { sent.push(String(t)); };
actions.init({ sendMessage, sendToManager: (t) => sendMessage(MGR, t), sendToTeam: (t) => sendMessage(MGR, t), pushAlert: () => {} });

const RULE = 'Rad Metal always pays on the 15th of the month so never chase before the 20th';
const ASK = 'Rad Metal payment on the 15th, should I chase them today?';
const base = { text: ASK, senderName: 'x', chatId: MGR, session: {}, pendingAction: null, activeBooking: null, activeSlots: [], truckers: [], suppliers: [], allBookings: {}, allWorkflow: {}, urgentBookings: [] };
const view = (o) => context.formatForAI({ ...base, ...o });
const BLOCK = 'WHAT SHE HAS TAUGHT YOU';

(async () => {
    const disk = getDisk();
    const runner = createRunner({ disk, company: 'edge_metals', embedder: stub, notify: async () => {} });
    const yardRunner = createRunner({ disk, company: 'edge_yard', embedder: stub, notify: async () => {} });

    section('A. nothing taught, or switched off: nothing changes');
    {
        let calls = 0;
        recall._setEmbedder({ model: stub.model, embed: async (t) => { calls++; return stub.embed(t); } });
        process.env.JARVIS_TAUGHT_RECALL = '1';
        ck('A1. no notes: no block', (await recall.recallFor({ text: ASK, role: 'manager' })) === null);
        ck('A2. no notes: the embedding API is not even called', calls === 0, `${calls} calls`);
        const t = await runner.start({ text: RULE, by: 'apsara', role: 'manager' });
        ck('A3. the rule is taught through the real runner', t.status === 'saved' || t.status === 'added' || !!t.id, JSON.stringify(t));
        delete process.env.JARVIS_TAUGHT_RECALL;
        ck('A4. flag OFF (default): null even though a note exists', (await recall.recallFor({ text: ASK, role: 'manager' })) === null);
        ck('A5. flag OFF: formatForAI.taughtRules is null', (await view({ role: 'manager' })).taughtRules === null);
        process.env.JARVIS_TAUGHT_RECALL = '0';
        ck('A6. only the exact value 1 turns it on', (await recall.recallFor({ text: ASK, role: 'manager' })) === null);
        delete process.env.JARVIS_TAUGHT_RECALL;
        recall._setEmbedder(stub);
    }

    process.env.JARVIS_TAUGHT_RECALL = '1';

    section('B. who may be reminded, which company, how it fails');
    {
        const mgr = await recall.recallFor({ text: ASK, role: 'manager' });
        ck('B1. manager gets the rule, in her own words', !!mgr && mgr.includes('never chase before the 20th'), String(mgr));
        ck('B2. team gets it too', !!(await recall.recallFor({ text: ASK, role: 'team' })));
        for (const role of ['trucker', 'supplier', 'customer', 'yard', undefined, '']) {
            ck(`B3. role ${JSON.stringify(role)} gets nothing`, (await recall.recallFor({ text: ASK, role })) === null);
        }
        const v = await view({ role: 'trucker', isTrucker: true });
        ck('B4. a trucker\'s prompt view carries no taught rules', v.taughtRules === null);
        ck('B5. an unrelated message gets nothing', (await recall.recallFor({ text: 'which port is the Savannah vessel calling at', role: 'manager' })) === null);

        await yardRunner.start({ text: 'Metalco pays cash on pickup so never invoice them first', by: 'apsara', role: 'manager' });
        const y = await recall.recallFor({ text: 'should I invoice Metalco first before pickup?', role: 'manager' });
        ck('B6. a rule taught for Edge Yard is NOT recalled for Edge Metals', y === null, String(y));

        recall._setEmbedder({ model: stub.model, embed: () => Promise.reject(new Error('quota')) });
        const kw = await recall.recallFor({ text: ASK, role: 'manager' });
        ck('B7. embedder down: falls back to keywords, still finds it', !!kw && kw.includes('15th'), String(kw));
        recall._setEmbedder({ model: stub.model, embed: () => new Promise(() => {}) });
        const t0 = Date.now();
        const slow = await recall.recallFor({ text: ASK, role: 'manager' });
        const took = Date.now() - t0;
        ck('B8. embedder that never answers: keywords after the timeout, reply not held up', !!slow && took < 4000, `${took}ms`);
        recall._setEmbedder(stub);
        ck('B9. empty text: null, no throw', (await recall.recallFor({ text: '   ', role: 'manager' })) === null);
        ck('B10. a note that is forgotten is no longer recalled', (() => { const p = disk.for('edge_metals'); const id = p.notes.list()[0].id; p.notes.forget(id, { by: 'apsara', role: 'manager' }); return true; })()
            && (await recall.recallFor({ text: ASK, role: 'manager' })) === null);
    }

    section('C. END TO END: taught -> typed into brain.process -> the prompt the model is given');
    {
        await runner.start({ text: RULE + ' (second wording)', by: 'apsara', role: 'manager' });
        PROMPTS.length = 0; sent.length = 0;
        let threw = null;
        try { await brain.process({ messageId: 'tr-1', chatId: MGR, senderNumber: MGR_NUM, senderName: 'Apsara', text: ASK, hasMedia: false, isGroup: false }, sendMessage); } catch (e) { threw = e; }
        const main = PROMPTS.filter((p) => p.includes('═══ URGENT ═══'));
        ck('C1. the message was handled without throwing', !threw, threw && threw.stack);
        ck('C2. a model prompt was built', main.length >= 1, `${PROMPTS.length} prompts`);
        ck('C3. the taught rule is IN that prompt', main.some((p) => p.includes('never chase before the 20th')));
        ck('C4. it sits under the advisory heading, not as a fact', main.some((p) => p.includes(BLOCK) && p.indexOf(BLOCK) < p.indexOf('never chase before the 20th')));
        ck('C5. the block says it is guidance and a FACT beats it', main.some((p) => /NEVER act on one of these alone/.test(p)));

        PROMPTS.length = 0;
        try { await brain.process({ messageId: 'tr-2', chatId: MGR, senderNumber: MGR_NUM, senderName: 'Apsara', text: 'which port is the Savannah vessel calling at', hasMedia: false, isGroup: false }, sendMessage); } catch (e) { /* asserted below */ }
        const other = PROMPTS.filter((p) => p.includes('═══ URGENT ═══'));
        ck('C6. an unrelated message: prompt has NO taught block (prompt unchanged)', other.length >= 1 && other.every((p) => !p.includes(BLOCK)));

        process.env.JARVIS_TAUGHT_RECALL = '0';
        PROMPTS.length = 0;
        try { await brain.process({ messageId: 'tr-3', chatId: MGR, senderNumber: MGR_NUM, senderName: 'Apsara', text: ASK + ' again', hasMedia: false, isGroup: false }, sendMessage); } catch (e) { /* asserted below */ }
        ck('C7. flag off: same message, no taught block', PROMPTS.filter((p) => p.includes('═══ URGENT ═══')).every((p) => !p.includes(BLOCK)));
        process.env.JARVIS_TAUGHT_RECALL = '1';
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILED:\n  ' + failures.join('\n  ')); process.exit(1); }
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
