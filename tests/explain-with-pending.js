// Apsara, 2026-10-28 20:06 WhatsApp: a proforma confirmation was open; she typed "explain 2" (digest item 2) and Jarvis
// answered "Hello!" / "Which email? Give me the number from a digest". The open pending swallowed it - LIST_COMMAND, the
// list of commands that escape a pending, knew "ignore N" and "reply to N" but not "explain N" / "what is N about".
const fs = require('fs'), os = require('os'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ep-')); process.env.JARVIS_TEST = '1';
const brain = require('../workflow/brain.js');
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
const mk = (t, pending) => ({ text: t, textLower: t.toLowerCase(), isManagerOrTeam: true, isTrucker: false, isSupplier: false,
    pendingAction: pending || null, session: {}, activeBooking: null, chatId: 'x@c.us' });
const PEND = { type: 'confirm_proforma', draft: { consignee: 'Daekwang', invNo: 'EM-1' }, subject: 'PO 1', who: 'Joey' };
const intent = (t, p) => { const d = brain.policyDecide(mk(t, p)); return d && !d.needsAI ? d.intent : '(' + JSON.stringify(d && (d.needsAI ? 'needsAI' : d)).slice(0, 60) + ')'; };
for (const t of ['explain 2', 'what is 2 about', "what's 3 about?", 'details 2', 'full thread 4', 'clear older'])
    ck(`with a proforma pending, "${t}" is still a digest command`, /^(explain_digest_item|clear_older_items)$/.test(intent(t, PEND)), intent(t, PEND));
ck('"explain 2" is explain_digest_item', intent('explain 2', PEND) === 'explain_digest_item');
ck('"clear older" is clear_older_items', intent('clear older', PEND) === 'clear_older_items');
ck('"yes" still answers the pending (not hijacked)', intent('yes', PEND) !== 'explain_digest_item');
ck('"no" still answers the pending', intent('no', PEND) !== 'explain_digest_item');
ck('"ignore 1" still escapes the pending as before', intent('ignore 1', PEND) === 'ignore_digest_item');
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
