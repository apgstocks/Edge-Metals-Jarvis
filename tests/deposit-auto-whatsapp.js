// tests/deposit-auto-whatsapp.js — "undo <CODE>" and "resume auto deposits for <name>" over WhatsApp, end to end through
// the real brain.process(): policy rule -> route -> action -> depositAutoApply.undo -> receipts, balances, pause, learning log.
const fs = require('fs'), os = require('os'), path = require('path');
const R = (p) => path.join(__dirname, '..', p);
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };

const P = require(R('helpers/depositCommands.js')).parse;
ck('grammar: undo <CODE>, with and without a reason', P('undo 69DF').code === '69DF' && P('Undo deposit 69df').code === '69DF' && P('undo 69DF: wrong customer').reason === 'wrong customer' && P('undo 69DF because it was a refund').reason === 'it was a refund');
ck('grammar: resume auto deposits for <name>', P('resume auto deposits for Daekwang').customer === 'Daekwang' && P('resume auto deposit for Zimex Ltd').customer === 'Zimex Ltd');
ck('grammar: ordinary sentences are NOT commands', ['undo', 'undo the last payment', 'undo 69DF extra words here', 'please undo 69DF', 'undo O0O0', 'resume', 'resume the follow-up for Zimex'].every((t) => P(t) === null));
ck('  ("undo send" parses, but the brain only acts on a code that belongs to a real automatic deposit — tested below)', P('undo send') && P('undo send').code === 'SEND');

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
const sales = require(R('helpers/sales')), receipts = require(R('helpers/salesReceipts')), A = require(R('helpers/depositAutoApply'));
const bal = (id) => { const r = sales.listWithTotals().find((s) => s.id === id); return r ? Math.round(Number(r.balance) * 100) / 100 : null; };

(async () => {
    // Three automatic placements, written exactly as depositAutoApply.run writes them (a real receipt + an entry).
    const mkAuto = async (customer, invoice, amount, depId) => {
        const sid = (await sales.addSale({ customer, invoice_no: invoice, date: '2026-10-20', item: 'Auto Cast', weight: amount * 2, invoice_price: 0.5, price_unit: 'lb', weight_unit: 'lb' })).id;
        const rec = await receipts.addReceipt({ date: '2026-11-05', amount, mode: 'Wire', bank: 'BofA', customer, ref: depId, note: 'auto', allocations: [{ sale_id: sid, amount }], created_by: 'jarvis-auto' });
        const entry = { id: 'aa_' + depId, depositId: depId, customer, payer: 'WIRE IN ' + customer.toUpperCase(), amount, date: '2026-11-05', mode: 'Wire', bank: 'BofA', saleId: sid, invoice_no: invoice, reasons: ['one invoice, to the cent'], score: 1, appliedAt: new Date().toISOString(), receiptId: rec.id, reported: true, undone: null, diagnosis: null, code: A.codeFor('aa_' + depId) };
        const f = path.join(process.env.DATA_DIR, 'auto_applied.json'); const st = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { entries: [], blocks: [] };
        st.entries.push(entry); fs.writeFileSync(f, JSON.stringify(st));
        return { sid, rec, entry };
    };
    const a1 = await mkAuto('Daekwang', 'DK-1', 5000, 'TX1'), a2 = await mkAuto('Zimex', 'ZX-1', 3000, 'TX2'), a3 = await mkAuto('Aris', 'AR-1', 2000, 'TX3');
    const msale = (await sales.addSale({ customer: 'Aris', invoice_no: 'AR-2', date: '2026-10-21', item: 'Auto Cast', weight: 400, invoice_price: 0.5, price_unit: 'lb', weight_unit: 'lb' })).id;
    const manual = await receipts.addReceipt({ date: '2026-11-05', amount: 100, mode: 'Cash', customer: 'Aris', ref: 'TXM', allocations: [{ sale_id: msale, amount: 100 }], created_by: 'admin' });
    ck('three automatic deposits exist, balances are paid', bal(a1.sid) === 0 && bal(a2.sid) === 0 && bal(a3.sid) === 0);

    console.log('\n=== who can undo ===');
    let r = await say('undo ' + a1.entry.code, { num: SUP_NUM, from: SUP_NUM + '@c.us' });
    ck('a supplier saying "undo CODE" removes nothing', bal(a1.sid) === 0 && !/Undone/.test(r.all), r.all);
    r = await say('undo ' + a1.entry.code, { num: TEAM_NUM, from: TEAM_NUM + '@c.us' });
    ck('team saying it removes nothing either', bal(a1.sid) === 0 && !/Undone/.test(r.all), r.all);
    AI = { action: 'deposit_auto', confidence: 0.99, reply: 'x' };
    r = await say('that Daekwang deposit looks wrong, take it back');
    ck('the AI classifier cannot undo a deposit by itself', bal(a1.sid) === 0 && !/Undone/.test(r.all), r.all);
    AI = { action: 'reply', reply: 'noted', confidence: 0.9 };

    console.log('\n=== other "undo" sentences keep their old meaning ===');
    r = await say('undo send');
    ck('"undo send" is not a deposit command: it falls through to the normal reply, removes and pauses nothing', bal(a1.sid) === 0 && A.list().blocks.length === 0 && !/Undone|Not undone/.test(r.all) && /noted/.test(r.all), r.all);
    r = await say('undo ZZZZ');
    ck('a code that belongs to no automatic deposit falls through too', bal(a1.sid) === 0 && !/Undone|Not undone/.test(r.all) && /noted/.test(r.all) && A.list().blocks.length === 0, r.all);

    console.log('\n=== the manager, end to end ===');
    r = await say('undo ' + a1.entry.code);
    ck('her "undo CODE" reopens the invoice and says so', /Undone: \$5,000\.00 from Daekwang is open again on DK-1/.test(r.all) && bal(a1.sid) === 5000, r.all);
    ck('  the receipt is gone, the entry is undone, the customer is paused', !receipts.list().some((x) => x.id === a1.rec.id) && A.list().entries.find((e) => e.id === a1.entry.id).undone.by === 'manager' && A.list().blocks.some((b) => b.customer === 'Daekwang'));
    ck('  she is invited to say what was wrong', /undo \w{4}: <what>/.test(r.all) && /resume auto deposits for Daekwang/.test(r.all), r.all);
    r = await say('undo ' + a1.entry.code);
    ck('undoing the same one again says so', /already undone/.test(r.all) && bal(a1.sid) === 5000, r.all);
    r = await say('undo ' + a2.entry.code + ': that was a refund, not a payment');
    ck('"undo CODE: reason" stores her reason', bal(a2.sid) === 3000 && A.list().entries.find((e) => e.id === a2.entry.id).undone.reason === 'that was a refund, not a payment' && /Noted what was wrong/.test(r.all), r.all);
    ck('her undos are in the learning log', require(R('helpers/outcomes')).readAll().filter((x) => x.outcome === 'corrected' && /auto-apply:/.test(x.ref)).length === 2);
    ck('a receipt a person made is untouched by all of this', receipts.list().some((x) => x.id === manual.id) && bal(a3.sid) === 0);

    console.log('\n=== resume ===');
    r = await say('resume auto deposits for Daekwang');
    ck('"resume auto deposits for X" lifts the pause', /Resumed automatic deposits for Daekwang/.test(r.all) && !A.list().blocks.some((b) => b.customer === 'Daekwang' && !b.lifted), r.all);
    r = await say('resume auto deposits for Nobody');
    ck('for a customer who was not paused it says so', /was not paused/.test(r.all), r.all);
    r = await say('resume auto deposits for Zimex', { num: TEAM_NUM, from: TEAM_NUM + '@c.us' });
    ck('team cannot lift a pause', A.list().blocks.some((b) => b.customer === 'Zimex' && !b.lifted));

    console.log('\n=== "not sure" questions: yes <CODE> / no <CODE> ===');
    ck('grammar: yes/no <CODE>', P('yes K7QM').kind === 'confirm' && P('No k7qm').kind === 'decline' && P('yes') === null && P('yes please') === null && P('no thanks') === null);
    const fileP = path.join(process.env.DATA_DIR, 'auto_applied.json');
    const qsale = (await sales.addSale({ customer: 'Quill', invoice_no: 'QQ-1', date: '2026-10-20', item: 'Auto Cast', weight: 800, invoice_price: 0.5, price_unit: 'lb', weight_unit: 'lb' })).id;
    const mkAsk = (id, o) => Object.assign({ id, code: A.codeFor(id), depositId: 'TX-' + id, customer: 'Quill', amount: 400, date: '2026-11-05', descriptor: 'WIRE IN QUILL', why: 'not sure — the bank description says "ADVANCE"', askedAt: new Date().toISOString(), reported: true, answer: null,
        proposal: { docId: qsale, amount: 400, label: 'QQ-1', mode: 'Wire', bank: 'BofA', score: 0.97, reasons: ['one invoice, to the cent'] } }, o);
    const st2 = JSON.parse(fs.readFileSync(fileP, 'utf8')); st2.asks = [mkAsk('aq_yes', {}), mkAsk('aq_none', { proposal: null, depositId: 'TX-none' }), mkAsk('aq_no', { depositId: 'TX-no' })]; fs.writeFileSync(fileP, JSON.stringify(st2));
    const cY = A.codeFor('aq_yes'), cN = A.codeFor('aq_none'), cNo = A.codeFor('aq_no');
    r = await say('yes ' + cY, { num: SUP_NUM, from: SUP_NUM + '@c.us' });
    ck('a supplier saying "yes CODE" places nothing', bal(qsale) === 400 && !/Placed/.test(r.all), r.all);
    r = await say('yes ' + cY, { num: TEAM_NUM, from: TEAM_NUM + '@c.us' });
    ck('team saying it places nothing either', bal(qsale) === 400 && !/Placed/.test(r.all), r.all);
    r = await say('yes ZZZZ');
    ck('a code that is not an open question falls through to the normal reply', bal(qsale) === 400 && !/Placed|Not done/.test(r.all) && /noted/.test(r.all), r.all);
    r = await say('yes ' + cY);
    ck('her "yes CODE" places it, names it, offers undo', /Placed: \$400\.00 from Quill on QQ-1/.test(r.all) && /undo \w{4}/.test(r.all) && bal(qsale) === 0, r.all);
    const rc = receipts.list().find((x) => x.ref === 'TX-aq_yes');
    ck('  the receipt is the screen\'s shape, labelled', rc && rc.created_by === 'jarvis-auto' && rc.mode === 'Wire' && rc.bank === 'BofA' && rc.allocations[0].sale_id === qsale);
    r = await say('yes ' + cY);
    ck('answering the same question again places nothing more', receipts.list().filter((x) => x.ref === 'TX-aq_yes').length === 1 && !/Placed/.test(r.all));
    r = await say('yes ' + cN);
    ck('a question with no single-invoice guess says to use the Bank page', /Not done: I had no single invoice/.test(r.all), r.all);
    r = await say('no ' + cNo);
    ck('her "no CODE" leaves it and says it stays on the Bank page', /Left it\./.test(r.all) && /Bank page/.test(r.all) && !receipts.list().some((x) => x.ref === 'TX-aq_no') && A.list().asks.find((q) => q.id === 'aq_no').answer.kind === 'no', r.all);
    r = await say('yes ' + cNo);
    ck('a question she already declined cannot be turned into a yes by repeating it', !receipts.list().some((x) => x.ref === 'TX-aq_no'));

    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack || e); process.exit(1); });
