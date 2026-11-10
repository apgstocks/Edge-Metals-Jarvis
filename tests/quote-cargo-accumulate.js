// REGRESSION: cargo answers given in pieces were never accumulated.
// Apsara, 2026-11-10 01:26 — "Al scrap", then "70000$", then "Al scrap" again, and
// Jarvis asked for something already given every single time.
//
// Cause: resumeQuoteWithCargoDetails saves the partial answer with setPending() while
// the SAME pending is still active, and setPending's duplicate guard (added 2026-08-20
// for the cancel loop) treats "same type, same lane" as a repeat question and DROPS it.
// So cargoSoFar was never written. Every reply was judged alone.
// Second, smaller: "70000$" (dollar sign AFTER the number) was not read as a value.
//
//   Run: node tests/quote-cargo-accumulate.js
const os = require('os'), _p = require('path'), _fs = require('fs');
process.env.DATA_DIR = _fs.mkdtempSync(_p.join(os.tmpdir(), 'jarvis-test-'));
process.env.JARVIS_TEST = '1';

const actions = require('../workflow/actions.js');
const CHAT = 'cargo-acc@g.us';
const sent = [];
actions.init({ sendMessage: async (_id, t) => { sent.push(t); },
               sendToManager: async () => {}, sendToTeam: async () => {}, pushAlert: async () => {} });

let P = 0, F = 0;
const ck = (d, a, e) => { const ok = JSON.stringify(a) === JSON.stringify(e); ok ? P++ : F++; console.log(`  ${ok ? 'PASS' : 'FAIL'} | ${d}${ok ? '' : `\n          got:  ${JSON.stringify(a)}\n          want: ${JSON.stringify(e)}`}`); };
const STATE = { originQuery: 'Junk car', destinationQuery: 'Mario', resolvedTruckers: [], unresolvedNames: [], directEmails: [] };
// What brain does: read the live pending back, hand it to the handler with the text.
const reply = async (text) => { sent.length = 0; const r = await actions.resumeQuoteWithCargoDetails(CHAT, actions.getPending(CHAT), text); return { r, msg: sent[sent.length - 1] || '' }; };
const fresh = async () => { await actions.clearAllPending(CHAT); sent.length = 0; await actions.setPending(CHAT, { type: 'await_quote_cargo_details', state: { ...STATE } }); };

(async () => {
    console.log('\n=== A. her transcript, replayed ===');
    await fresh();
    let x = await reply('Al scrap');
    ck('1. "Al scrap" -> asks for weight and value only', x.msg, 'Still need a weight and a value — description, weight, and value are all required for every quote. What are they?');
    ck('   and the partial answer was actually SAVED', (actions.getPending(CHAT).state || {}).cargoSoFar, 'Al scrap');
    x = await reply('70000$');
    ck('2. "70000$" -> description is remembered, "$" after the number is a value, only weight is missing', x.msg, 'Still need a weight — description, weight, and value are all required for every quote. What is it?');
    ck('   saved answer grew, not replaced', (actions.getPending(CHAT).state || {}).cargoSoFar, 'Al scrap, 70000$');
    x = await reply('40000 lbs');
    ck('3. "40000 lbs" completes it: the pending is cleared and the flow moves on', [!!actions.getPending(CHAT), x.r.action_taken], [false, 'quote_request_failed']);
    ck('   (no recipients in this fixture, so it says so rather than asking about cargo again)', /Couldn't send to anyone/.test(x.msg), true);

    console.log('\n=== B. nothing that worked before changed ===');
    await fresh();
    x = await reply('Aluminum scrap, 40,000 lbs, approx $5,000');
    ck('all three in one message still completes at once', [!!actions.getPending(CHAT), /Couldn't send to anyone/.test(x.msg)], [false, true]);
    await fresh();
    x = await reply('70000');
    ck('one bare number is still ambiguous and still asked about', /Still need/.test(x.msg) && !!actions.getPending(CHAT), true);
    await fresh();
    x = await reply('ok 40000 lbs $5000');
    ck('numbers with no description still asked for a description', x.msg, 'Still need a description — description, weight, and value are all required for every quote. What is it?');
    await fresh();
    x = await reply('40000,42000');
    ck('two distinct numbers still count as weight AND value (the loop it once caused stays fixed)', /Still need a description/.test(x.msg) && !/weight|value/.test(x.msg.replace('description, weight, and value', '')), true);

    console.log(`\n${P} passed, ${F} failed`);
    process.exit(F ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
