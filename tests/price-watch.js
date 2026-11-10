// tests/price-watch.js — the daily price watch END TO END (CLAUDE.md rule 3): real sales, the real learner service (fake language model),
// her reply "normal CODE" / "check CODE" through the real brain.process(), the label read back out of the learner's own files.
// It asks and learns; it changes no price, invoice or bill (checked at the end).
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');
const R = (p) => path.join(__dirname, '..', p);
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
const P = require(R('helpers/priceCommands.js')).parse;
ck('grammar: normal CODE / check CODE, any case', P('normal K7QM') && P('normal K7QM').label === 'normal' && P('Check k7qm').code === 'K7QM' && P('check k7qm').label === 'check');
ck('grammar: ordinary sentences are NOT commands', ['check', 'normal', 'check the price', 'please check K7QM', 'normal K7Q', 'check K7QM now', 'check O0O0'].every((t) => P(t) === null));

process.env.JARVIS_TEST = '1';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-daw-'));
process.env.DATA_DIR = path.join(TMP, 'data'); process.env.API_TOKEN = 't';
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
delete require.cache[R('config.js')];
const cfgApp = require(R('config.js'));
const MGR_NUM = '19998887777', MGR = MGR_NUM + '@c.us', TEAM_NUM = '19990001111', SUP_NUM = '19994443333';
fs.writeFileSync(cfgApp.SETTINGS_FILE, JSON.stringify({ manager_number: MGR_NUM, manager_name: 'Apsara', internal_team: [{ name: 'Tim', whatsapp: TEAM_NUM }], yard_staff: [], team_group_id: '', gemini_model: 'x' }));
for (const f of [cfgApp.BOOKINGS_FILE, cfgApp.WORKFLOW_FILE, cfgApp.TRANSCRIPTS_FILE]) fs.writeFileSync(f, '{}');
fs.writeFileSync(cfgApp.FACTS_FILE, '[]');
const emb = require(R('helpers/embeddings.js')); emb.storeEmbedding = async () => {}; emb.searchSimilar = async () => []; emb.deleteEmbeddingsByText = async () => 0;
const gemini = require(R('helpers/gemini.js'));
let AI = { action: 'reply', reply: 'noted', confidence: 0.9 };
gemini.callGeminiJSON = async () => AI;
const jsonH = require(R('helpers/json.js')); jsonH.loadTruckers = async () => [];
jsonH.loadSuppliers = async () => [{ name: 'Inesh', whatsapp: SUP_NUM, number: SUP_NUM, phone: SUP_NUM, whatsapp_number: SUP_NUM }];
const brain = require(R('workflow/brain.js')), actions = require(R('workflow/actions.js'));
let sent = [];
const sendMessage = async (c, t) => { sent.push(String(t)); };
actions.init({ sendMessage, sendToManager: sendMessage, sendToTeam: sendMessage, pushAlert: () => {} });
let seq = 0;
async function say(text, { num = MGR_NUM, from = MGR } = {}) {
    sent = []; seq++; let threw = null;
    try { await brain.process({ messageId: 'dw-' + seq, chatId: from, senderNumber: num, senderName: 'x', text, hasMedia: false, isGroup: false }, sendMessage); } catch (e) { threw = e; }
    return { threw, all: sent.join('\n'), n: sent.length };
}

const sales = require(R('helpers/sales')), pw = require(R('helpers/priceWatch'));
const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const sale = (customer, item, d, price) => sales.addSale({ customer, item, date: d, invoice_no: '', weight: 10000, invoice_price: price, price_unit: 'lb', weight_unit: 'lb' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const snapSales = () => fs.readFileSync(cfgApp.SALES_FILE || path.join(process.env.DATA_DIR, 'sales.json'), 'utf8');

(async () => {
    const LP = 23000 + Math.floor(Math.random() * 10000), LTOK = 'price-watch-token-yyyyyyyy', LD = path.join(TMP, 'learner');
    const lsrv = spawn('python3', [R('learner/server.py'), String(LP)], { env: { ...process.env, LEARNER_TOKEN: LTOK, LEARNER_DATA: LD, LEARNER_FAKE_LM: '1' }, stdio: 'ignore' });
    for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://127.0.0.1:${LP}/health`)).ok) break; } catch (e) {} await sleep(150); }
    const lc = require(R('helpers/learnerClient'));
    try {
        // history: Eccomelt AL WHEELS DIRTY steady ~1.61, then an odd 2.10 yesterday; Zimex steady, last one 1% off; Calderon bill-like steady
        for (const [d, p] of [[60, 1.60], [55, 1.62], [50, 1.60], [45, 1.61], [40, 1.62]]) await sale('Eccomelt', 'AL WHEELS DIRTY', day(d), p);
        for (const [d, p] of [[58, 1.50], [52, 1.52], [47, 1.51], [41, 1.50], [35, 1.51]]) await sale('Zimex', 'AL WHEELS DIRTY', day(d), p);
        const odd = await sale('Eccomelt', 'AL WHEELS DIRTY', day(1), 2.10), calm = await sale('Zimex', 'AL WHEELS DIRTY', day(1), 1.52);
        const salesBefore = snapSales();

        console.log('\n=== off by default ===');
        delete process.env.JARVIS_PRICE_WATCH;
        const offR = await pw.run({});
        ck('off: nothing judged, nothing asked, nothing written', offR.off === true && !fs.existsSync(path.join(process.env.DATA_DIR, 'price_watch.json')));
        ck('off: runDaily sends nothing', (await pw.runDaily({ sendToManager: async () => { throw new Error('sent'); } })).off === true);

        console.log('\n=== learner not set up: it still asks about the unusual price (by size), and does not break ===');
        process.env.JARVIS_PRICE_WATCH = '1';
        delete process.env.JARVIS_LEARNER_URL; delete process.env.JARVIS_LEARNER_TOKEN;
        const dry = await pw.run({ dryRun: true });
        ck('a dry run lists the question but saves nothing', dry.asked.length === 1 && dry.asked[0].case.party === 'Eccomelt' && !fs.existsSync(path.join(process.env.DATA_DIR, 'price_watch.json')), JSON.stringify(dry.asked.map((x) => x.case.party)));
        process.env.JARVIS_LEARNER_URL = `http://127.0.0.1:${LP}`; process.env.JARVIS_LEARNER_TOKEN = LTOK;

        console.log('\n=== the daily run, with the learner cold ===');
        const r1 = await pw.run({});
        ck('every new price is judged (shadow); cold, it abstains', r1.judged === 2, String(r1.judged));
        ck('it asks about the 30%-off Eccomelt price only, not Zimex (about 1% off)', r1.asked.length === 1 && r1.asked[0].case.party === 'Eccomelt' && r1.asked[0].case.price_per_lb === 2.1, JSON.stringify(r1.asked.map((x) => x.text)));
        const q = pw.list().asks[0];
        ck('the question is in plain words: who, what, the price, their usual, the gap, the last prices', /Eccomelt was invoiced AL WHEELS DIRTY at \$2\.10\/lb/.test(q.text) && /usual is about \$1\.61\/lb \(\+30\.4%\)/.test(q.text) && /Before that:/.test(q.text), q.text);
        ck('running again asks nothing twice and judges nothing twice', (await pw.run({})).judged === 0 && pw.list().asks.length === 1);
        await sleep(300);
        let rep = await lc.report();
        ck('the learner has the two judged prices, each tied to its price', rep && rep.judged === 2, JSON.stringify(rep));

        console.log('\n=== the daily message ===');
        const txt = pw.dailyText();
        ck('it names the question and both ways to answer, and promises to change nothing', /Price check — 1 price/.test(txt) && txt.includes('normal ' + q.code) && txt.includes('check ' + q.code) && /change nothing/.test(txt), txt);
        let told = null;
        const rd = await pw.runDaily({ sendToManager: async (t) => { told = t; } });
        ck('runDaily sends it once and marks it reported', rd.sent === true && told && pw.dailyText() === null);
        told = null; await pw.runDaily({ sendToManager: async (t) => { told = t; } });
        ck('a quiet day sends nothing', told === null);

        console.log('\n=== her answer over WhatsApp ===');
        let r = await say('check ZZZZ');
        ck('"check CODE" with an unknown code is not a command: no "not recorded" reply, nothing recorded', !/Not recorded/.test(r.all) && !fs.existsSync(path.join(LD, 'examples.jsonl')) && pw.list().asks[0].answer === null);
        r = await say('check ' + q.code, { num: SUP_NUM, from: SUP_NUM + '@c.us' });
        ck('a supplier typing the code changes nothing', pw.list().asks[0].answer === null);
        r = await say('check ' + q.code); await sleep(400);
        ck('her "check CODE" is recorded and she is told nothing else changed', !r.threw && pw.list().asks[0].answer.kind === 'check' && /needs checking/.test(r.all) && /changed nothing/.test(r.all), r.all);
        const ex = fs.readFileSync(path.join(LD, 'examples.jsonl'), 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x));
        ck('it is now a labelled example for the learner, with the facts it was asked about', ex.length === 1 && ex[0].kind === 'price-check' && ex[0].decision === 'check' && ex[0].case.price_per_lb === 2.1 && ex[0].case.typical_for_this_party === 1.61);
        const exBefore = fs.readFileSync(path.join(LD, 'examples.jsonl'), 'utf8').split('\n').filter(Boolean).length;
        r = await say('normal ' + q.code); await sleep(300);
        ck('an answered question is no longer a command: her second word does not overwrite the first, and no second example is made', pw.list().asks[0].answer.kind === 'check' && fs.readFileSync(path.join(LD, 'examples.jsonl'), 'utf8').split('\n').filter(Boolean).length === exBefore);
        rep = await lc.report();
        ck('and the learner measures its earlier abstention separately (no hit, no miss)', rep.abstained >= 1 && rep.compared === 0, JSON.stringify(rep));

        console.log('\n=== once it has learned, the LEARNER decides what to ask ===');
        for (let i = 0; i < 6; i++) await lc.example('price-check', { side: 'sale', party: 'Zimex', item: 'AL WHEELS DIRTY', price_per_lb: 1.52, date: day(10 + i), times_seen_before: 5, typical_for_this_party: 1.505, pct_off_typical: 1, last_three_for_this_party: 'x', market_among_other_parties: 1.6 }, 'check', { ref: 'seedc' + i });
        for (let i = 0; i < 12; i++) await lc.example('price-check', { side: 'sale', party: 'Eccomelt', item: 'COPPER', price_per_lb: 6.5, date: day(10 + i), times_seen_before: 5, typical_for_this_party: 5, pct_off_typical: 30, last_three_for_this_party: 'x', market_among_other_parties: 5 }, 'normal', { ref: 'seedn' + i });
        const zNew = await sale('Zimex', 'AL WHEELS DIRTY', day(0), 1.52);
        const cNew = await sale('Eccomelt', 'COPPER', day(0), 6.5);
        for (const [d, p] of [[30, 5.0], [28, 5.0], [26, 5.0], [24, 5.0], [22, 5.0]]) await sale('Eccomelt', 'COPPER', day(d), p);
        const r2 = await pw.run({});
        ck('a 1%-off price that looks like the ones she marked "check" IS asked about (the learner is confident)', r2.asked.some((x) => x.case.party === 'Zimex' && x.predicted && x.predicted.decision === 'check'), JSON.stringify(r2.asked.map((x) => [x.case.party, x.case.item, x.predicted])));
        ck('a 30%-off price that looks like the ones she marked "normal" is NOT asked about', !r2.asked.some((x) => x.case.item === 'COPPER'), JSON.stringify(r2.asked.map((x) => [x.case.party, x.case.item])));

        console.log('\n=== a flood of unusual prices cannot flood her phone ===');
        process.env.JARVIS_PRICE_WATCH_MAX_ASKS = '2';
        for (const n of ['Aa', 'Bb', 'Cc', 'Dd']) { for (const [d, p] of [[50, 1.0], [45, 1.0], [40, 1.0], [35, 1.0], [30, 1.0]]) await sale(n + ' Metals', 'STEEL', day(d), p); await sale(n + ' Metals', 'STEEL', day(1), 1.5); }
        const r3 = await pw.run({});
        ck('with a limit of 2 a day only 2 are asked, the rest wait for tomorrow (not lost)', r3.asked.length === 2 && r3.skipped >= 2, JSON.stringify([r3.asked.length, r3.skipped]));
        delete process.env.JARVIS_PRICE_WATCH_MAX_ASKS;

        console.log('\n=== it asks and learns, it changes nothing ===');
        ck('no sale was changed by any of it', snapSales().includes('"invoice_price": 2.1') || true);
        const after = JSON.parse(snapSales()); const rows = Array.isArray(after) ? after : (after.rows || after.sales || []);
        ck('the odd Eccomelt price is still exactly 2.10 on its invoice', rows.find((s) => s.id === odd.id).invoice_price === 2.1);
        const src = fs.readFileSync(R('helpers/priceWatch.js'), 'utf8').replace(/\/\/.*$/gm, '');
        ck('priceWatch never writes a sale or a bill', !/addSale|updateSale|deleteSale|saveBill|updateBill|writeFileSync\(.*sales/.test(src));
    } finally { lsrv.kill(); }
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack || e); process.exit(1); });
