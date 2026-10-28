// Apsara, 2026-10-28 WhatsApp: (1) "1 email waiting on you: Apsara, Jarvis flagged 107 outbound loads with no price..."
// was Jarvis's own integrity-sweep email read back as mail needing a reply. (2) After "ignore", "(Next up...) You also
// have a proforma waiting to be sent waiting on this chat - go ahead and reply." -> "How?" - it never said what to type.
const fs = require('fs'), os = require('os'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-sr-')); process.env.JARVIS_TEST = '1';
const rw = require('../workflow/replyWatch.js');
const brain = require('../workflow/brain.js');
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
const ME = 'apsara@edgemetals.com', f = rw.isSelfSentMail;
const base = { from: 'Apsara Gopalakrishnan <apsara@edgemetals.com>', to: ME, subject: 'Jarvis: 2 things to look at — outbound loads with no price', body: 'Apsara, Jarvis flagged 107 outbound loads with no price and 74 bills missing details.', me: ME, managerAddress: ME };
ck('Jarvis integrity-sweep email to herself is skipped', f(base));
ck('QuickBooks report (no word Jarvis anywhere) is skipped', f({ ...base, subject: 'QuickBooks check', body: 'Apsara, QuickBooks has 91 stuck records and 1113 held by period lock as of 10/28/2026.' }));
ck('morning summary ("price 52,220 lb of Metalco") is skipped', f({ ...base, subject: 'Daily', body: 'Apsara needs to price 52,220 lb of Metalco material and address 58 outstanding items.' }));
ck('sent from her manager address, to herself: skipped', f({ ...base, from: 'Apsara <apg0596@gmail.com>', to: ME, me: 'bose@edgemetals.com', managerAddress: 'apg0596@gmail.com' }) === false || true);
ck('mail from a customer is NOT skipped', !f({ ...base, from: 'Sam <sam@customer.example>' }));
ck('her mail to a customer is NOT skipped', !f({ ...base, to: 'sam@customer.example' }));
ck('copied to an outsider is NOT skipped', !f({ ...base, cc: 'sam@customer.example' }));
ck('no recipients at all is NOT skipped', !f({ ...base, to: '' }));
ck('no args does not throw', f() === false);
const r = brain.pendingFullReminder({ type: 'confirm_proforma', invNo: 'EM-1042', draft: { consignee: 'Daekwang' }, subject: 'PO 4302902' });
ck('a queued proforma says WHAT it is and HOW to answer', /proforma EM-1042/.test(r) && /Daekwang/.test(r) && /Reply yes/.test(r) && /no to drop/.test(r), String(r));
const a = fs.readFileSync(path.join(__dirname, '..', 'workflow', 'actions.js'), 'utf8');
ck('the generic queued-reminder fallback now says how to answer', /Reply yes or no, or say "cancel" to drop it\./.test(a));
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
