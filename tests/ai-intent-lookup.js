// tests/ai-intent-lookup.js - Apsara, 2026-11-10: "it's an AI" - the cargo answer and the
// "who is bose" lookup should not depend on a fixed pattern or on one exact list.
//   A. cargo answer read by the AI: complete / partial / mixed pieces, asks only for the gap
//   B. the AI can't invent: a weight or value that is not in her words is thrown away
//   C. AI down or garbage -> the old pattern check still decides (nothing gets worse)
//   D. Address Book fallback in sendMessageTo (verified only, ambiguous asks, others unchanged)
//   E. END TO END: real server saves + verifies the Address Book entry through its routes,
//      then the real brain.process() sends "send a message to bose ..." to that number
//   Run: node tests/ai-intent-lookup.js
const os = require('os'), path = require('path'), fs = require('fs'), http = require('http');
const R = (p) => path.join(__dirname, '..', p);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-test-'));
process.env.DATA_DIR = path.join(TMP, 'data'); process.env.JARVIS_TEST = '1'; process.env.API_TOKEN = 't';
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
const cfg = require(R('config.js'));
const MGR_NUM = '19998887777', MGR = MGR_NUM + '@c.us';
fs.writeFileSync(cfg.SETTINGS_FILE, JSON.stringify({ manager_number: MGR_NUM, manager_name: 'Apsara', internal_team: [], yard_staff: [], team_group_id: '', gemini_model: 'x' }));
const jsonH = require(R('helpers/json.js')); jsonH.loadTruckers = async () => []; jsonH.loadSuppliers = async () => [];
const actions = require(R('workflow/actions.js')), brain = require(R('workflow/brain.js'));
const book = require(R('helpers/addressBook.js'));
let sent = [], to = [];
const sendMessage = async (c, t) => { to.push(c); sent.push(String(t)); return true; };
actions.init({ sendMessage, sendToManager: sendMessage, sendToTeam: sendMessage, pushAlert: () => {} });
let P = 0, F = 0;
const ck = (d, a, e) => { const ok = JSON.stringify(a) === JSON.stringify(e); ok ? P++ : F++; console.log(`  ${ok ? 'PASS' : 'FAIL'} | ${d}${ok ? '' : `\n     got:  ${JSON.stringify(a)}\n     want: ${JSON.stringify(e)}`}`); };
const CHAT = 'ai@g.us';
const STATE = { originQuery: 'Junk car', destinationQuery: 'Mario', resolvedTruckers: [], unresolvedNames: [], directEmails: [] };
const fresh = async () => { await actions.clearAllPending(CHAT); await actions.setPending(CHAT, { type: 'await_quote_cargo_details', state: { ...STATE } }); };
const reply = async (t) => { sent = []; const r = await actions.resumeQuoteWithCargoDetails(CHAT, actions.getPending(CHAT), t); return { r, msg: sent[sent.length - 1] || '' }; };

(async () => {
    console.log('\n=== A. AI reads the cargo answer ===');
    // A stand-in for the model that behaves like a good one: reads whatever is in the text.
    actions._setCargoReader(async (t) => ({
        description: /scrap/i.test(t) ? 'Al scrap' : null,
        weight: (/(\d[\d,]*)\s*(lbs?|pounds|kg|tons?)/i.exec(t) || [])[1] || null,
        value: (/\$\s?(\d[\d,]*)|(\d[\d,]*)\s*\$/.exec(t) || [])[0] || null,
    }));
    await fresh();
    let x = await reply('Al scrap');
    ck('"Al scrap" -> asks only for weight and value', x.msg.startsWith('Still need a weight and a value'), true);
    x = await reply('70000$');
    ck('"70000$" -> only weight left', x.msg.startsWith('Still need a weight '), true);
    x = await reply('40000 lbs');
    ck('"40000 lbs" -> complete, pending cleared', [!!actions.getPending(CHAT), x.r.action_taken], [false, 'quote_request_failed']);
    await fresh();
    x = await reply('about 40,000 lbs of Al scrap worth $70,000');
    ck('everything in one sentence -> done, no question', [!!actions.getPending(CHAT), /Still need/.test(x.msg)], [false, false]);

    console.log('\n=== B. the AI cannot invent a figure ===');
    ck('weight not in her text is rejected', actions.verifyCargoFields({ description: 'Al scrap', weight: '99999 lbs', value: '$70000' }, 'Al scrap $70000'), { description: true, weight: false, value: true });
    ck('description whose words are not in her text is rejected', actions.verifyCargoFields({ description: 'copper wire' }, 'hello there').description, false);
    ck('same figure cannot be both weight and value', actions.verifyCargoFields({ weight: '70000', value: '$70000' }, '70000 lbs $70000').weight, false);
    actions._setCargoReader(async () => ({ description: 'Al scrap', weight: '50000 lbs', value: '$9000' }));
    await fresh();
    x = await reply('Al scrap');
    ck('a lying model + her bare "Al scrap" -> still asks (nothing invented gets through)', x.msg.startsWith('Still need a weight and a value'), true);

    console.log('\n=== C. AI down -> old check still decides ===');
    actions._setCargoReader(async () => { throw new Error('gemini down'); });
    await fresh();
    x = await reply('Al scrap');
    ck('throws -> pattern check asks', x.msg.startsWith('Still need a weight and a value'), true);
    actions._setCargoReader(async () => null);
    x = await reply('70000$, 40000 lbs');
    ck('null -> pattern check completes it', !!actions.getPending(CHAT), false);
    actions._setCargoReader(null);

    console.log('\n=== D. Address Book fallback ===');
    await book.addManualEntry(['Bose'], 'Bose, Houston TX', true, '+3109382525');
    const bose = book.loadAddressBook().find((e) => e.aliases.includes('Bose'));
    to = []; sent = [];
    let r = await actions.sendMessageTo(MGR, { target: 'bose', message: 'hi' });
    ck('saved but NOT verified -> not messaged (as before)', [r.action_taken, to.includes('13109382525@c.us')], ['send_target_not_found', false]);
    await book.setMobileVerified(bose.id, true);
    to = []; r = await actions.sendMessageTo(MGR, { target: 'bose', message: 'rates please' });
    ck('verified -> sent to the right WhatsApp id (10 digits get the US 1)', [r.action_taken, to[0]], ['message_sent', '13109382525@c.us']);
    await book.addManualEntry(['Bose Two'], 'Bose Two, Dallas', true, '+14155550101');
    await book.setMobileVerified(book.loadAddressBook().find((e) => e.aliases.includes('Bose Two')).id, true);
    to = []; r = await actions.sendMessageTo(MGR, { target: 'bos', message: 'x' });
    ck('two verified matches -> asks which, sends nothing', [r.action_taken, to.length], ['send_target_ambiguous', 1]);
    to = []; r = await actions.sendMessageTo(MGR, { target: 'nobody-here', message: 'x' });
    ck('unknown name still "not found"', r.action_taken, 'send_target_not_found');
    to = []; r = await actions.sendMessageTo(MGR, { target: 'me', message: 'note to self' });
    ck('"me" still goes to her, exactly as before', [r.action_taken, to[0]], ['message_sent', MGR]);

    console.log('\n=== E. end to end: real server + real brain ===');
    const { createApi } = require(R('api'));
    const server = await new Promise((res) => { const s = createApi().listen(0, '127.0.0.1', () => res(s)); });
    const port = server.address().port;
    const call = (method, p, body) => new Promise((res, rej) => {
        const d = body ? JSON.stringify(body) : null;
        const q = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'content-type': 'application/json', authorization: 'Bearer t', ...(d ? { 'content-length': Buffer.byteLength(d) } : {}) } }, (rs) => { let raw = ''; rs.on('data', (c) => raw += c); rs.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} res({ status: rs.statusCode, json: j }); }); });
        q.on('error', rej); if (d) q.write(d); q.end();
    });
    const made = await call('POST', '/api/address-book', { aliases: ['Rajesh'], raw: 'Rajesh, Newark NJ', mobile: '+12125550123' });
    ck('screen saves an entry through POST /api/address-book', made.status, 200);
    const ver = await call('PUT', `/api/address-book/${made.json && made.json.id}/verify-whatsapp`, { verified: true });
    ck('screen marks it WhatsApp-verified through its route', [ver.status, ver.json && ver.json.whatsapp_verified], [200, true]);
    to = []; sent = [];
    await brain.process({ messageId: 'e2e-1', chatId: MGR, senderNumber: MGR_NUM, senderName: 'x', text: 'send a message to rajesh saying rates to Houston: NTG 1350', hasMedia: false, isGroup: false }, sendMessage);
    ck('real brain delivered it to his number', to.includes('12125550123@c.us'), true);
    ck('and confirmed back to her', sent.some((t) => /^Sent to Rajesh/.test(t)), true);
    server.close();
    console.log(`\n${P} passed, ${F} failed`);
    process.exit(F ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
