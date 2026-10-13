// Invoice mail: customer printed on the invoice -> stored address, automatically.
// Apsara, 2026-10-14: "we already have that email ... why would it ask again?"
const fs = require('fs'), os = require('os'), path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-invmatch-'));
process.env.DATA_DIR = TMP; process.env.JARVIS_TEST = '1';
let pass = 0, fail = 0;
const ck = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '\n        ' + x : '')); } };
const R = (p) => path.join(__dirname, '..', p);
const put = (f, v) => fs.writeFileSync(path.join(TMP, f), JSON.stringify(v));
const sm = require(R('helpers/shipmentMail'));
const m = sm.looseCustomerMatch;

put('email_contacts.json', [{ name: 'Eccomelt', email: 'buy@eccomelt.com' }, { name: 'MK Metal Trading', email: 'mk@mk.com' }]);
put('contacts.json', [{ name: 'Rad Metals', email: 'rad@rad.com' }, { name: 'NoMail Co', email: null }]);

let r = m('Eccomelt Texas LLC');
ck('legal name containing saved short name resolves', r && r.contact.email === 'buy@eccomelt.com');
r = m('M.K. Metal-Trading, Inc.');
ck('punctuation + suffix tolerant', r && r.contact.email === 'mk@mk.com');
r = m('RAD METALS LLC');
ck('falls back to Contacts store', r && r.contact.email === 'rad@rad.com');
ck('unknown customer -> null (box still shown)', m('Acme Widgets') === null);
ck('contact without email is ignored', m('NoMail Co') === null);
ck('empty -> null', m('') === null && m('LLC') === null);
ck('partial word does not match (Ecco != Eccomelt)', m('Ecco Foods') === null);

put('email_contacts.json', [{ name: 'Eccomelt', email: 'a@eccomelt.com' }, { name: 'Eccomelt Texas', email: 'b@eccomelt.com' }]);
r = m('Eccomelt Texas LLC');
ck('two different addresses -> ambiguous, never a guess', r && r.type === 'ambiguous' && r.matches.length === 2);
put('email_contacts.json', [{ name: 'Eccomelt', email: 'a@eccomelt.com', role: 'primary' }, { name: 'Eccomelt Texas', email: 'b@eccomelt.com' }]);
r = m('Eccomelt Texas LLC');
ck('marked primary wins', r && r.contact.email === 'a@eccomelt.com');

const src = fs.readFileSync(R('helpers/shipmentMail.js'), 'utf8');
ck('draftFor tries strict resolveContact first', /resolveContact\(consignee\) \|\| looseCustomerMatch\(consignee\)/.test(src));
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
