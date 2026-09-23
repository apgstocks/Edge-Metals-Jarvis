// tests/qb-bank-match.js — the pending-bank-list matcher, no network
process.env.QB_ENV = 'sandbox';
const M = require('../scripts/qb-bank-match');
const fs = require('fs'), os = require('os'), path = require('path');
let pass = 0, fail = 0; const failures = [];
const ck = (name, ok, extra) => { if (ok) { pass++; console.log('  PASS ', name); } else { fail++; failures.push(name); console.log('  FAIL ', name, extra || ''); } };

const bill = (id, date, party, partyId, balance, doc, containers = []) => ({ type: 'Bill', id, doc, date, party, partyId, balance, total: balance, containers });
const inv = (id, date, party, partyId, balance, doc, containers = []) => ({ type: 'Invoice', id, doc, date, party, partyId, balance, total: balance, containers });
const docs = {
    out: [bill('39773', '2026-09-14', 'FMC Metal', '571', 23848.8, '260831_SU_26EM07', ['TRHU1969614']),
         bill('39717', '2026-09-08', 'Mazariegos', '540', 50668.8, 'M-101', ['HMMU6075809']),
         bill('39718', '2026-09-09', 'Edge Yard', '590', 50668.8, 'EY-9', ['HDMU4953511'])],
    in: [inv('39778', '2026-09-14', 'Edge Metals Recycling', '568', 24267.2, '260831_SU_26EM07'),
         inv('39779', '2026-09-14', 'Edge Metals Recycling', '568', 28002.4, '260831_SU_26EM08'),
         inv('39780', '2026-09-14', 'Edge Metals Recycling', '568', 28570.8, '260831_SU_26EM09'),
         inv('39781', '2026-09-14', 'Edge Metals Recycling', '568', 29661.2, '260831_SU_26EM10'),
         inv('39745', '2026-09-10', 'TAEWON PRECEISION', '561', 23480, 'T-1')],
};
const line = (o) => ({ date: '2026-09-15', desc: '', spent: 0, received: 0, ...o, amount: o.spent || o.received, direction: o.spent ? 'out' : 'in' });

const one = M.matchLine(line({ spent: 23848.8 }), docs);
ck('one open bill, same amount -> exact', one.how === 'exact' && one.docs[0].id === '39773', one.why);

const two = M.matchLine(line({ spent: 50668.8 }), docs);
ck('two bills share the amount -> near, not exact', two.how === 'near' && two.docs.length === 2, two.why);
const named = M.matchLine(line({ spent: 50668.8, desc: 'WIRE OUT MAZARIEGOS RECYCLING' }), docs);
ck('...unless the bank line names one of them -> exact', named.how === 'exact' && named.docs[0].party === 'Mazariegos', named.why);

const group = M.matchLine(line({ received: 110501.6 }), docs);
ck('4 invoices of one customer add up -> group', group.how === 'group' && group.docs.length === 4, group.why);

const near = M.matchLine(line({ received: 110525.28 }), docs);
ck('the real 15 Sep wire, $23.68 over -> near, never exact', near.how === 'near', near.why);

ck('a receipt is never matched to a bill', M.matchLine(line({ received: 23848.8 }), docs).how !== 'exact');
ck('old money, nothing open -> none', M.matchLine(line({ spent: 999999 }), docs).how === 'none');
ck('outside the 45-day window -> none', M.matchLine(line({ spent: 23848.8, date: '2026-12-31' }), docs).how === 'none');

const f = path.join(os.tmpdir(), 'qbbank-test.csv');
fs.writeFileSync(f, 'Edge Metals Inc\nChecking (3301)\n\nDate,Bank description,Spent,Received\n09/15/2026,"Wire Type",,"110,525.28"\n09/15/2026,"Online Transfer Chk","9,000.00",\n,,,\n');
const read = M.readBankLines(f);
ck('CSV: skips the title rows, finds the header', read.lines.length === 2, JSON.stringify(read.columns));
ck('CSV: US date and thousands separators', read.lines[0].date === '2026-09-15' && read.lines[0].amount === 110525.28 && read.lines[0].direction === 'in');
ck('CSV: a spent line is money out', read.lines[1].direction === 'out' && read.lines[1].amount === 9000);
ck('CSV: blank rows dropped', !read.lines.some((l) => !l.amount));
ck('containers are picked out of the line text', JSON.stringify(M.containersIn({ Line: [{ Description: 'AUTO CAST TRHU1969614' }], PrivateNote: '' })) === '["TRHU1969614"]');
ck('a short word in a name does not match by accident', M.nameHit('ZELLE ROLL OFF', 'MK Trading') === false);

ck('a bank fee line is set aside, not left as a puzzle', M.matchLine(line({ spent: 5, desc: 'External Transfer Fee', category: 'Bank Charges' }), docs).how === 'not-trade');
ck('the phone bill is set aside', M.matchLine(line({ spent: 510.73, desc: 'Verizon Wireless', category: 'Verizon Phone' }), docs).how === 'not-trade');
ck('a trade wire is NOT set aside', M.matchLine(line({ spent: 23848.8, desc: 'Wire Type', category: 'Vendor Payable' }), docs).how === 'exact');
const fee = M.matchLine(line({ received: 23460, desc: 'Wire Type Intl', party: 'TAEWON PRECEISION' }), docs);
ck('customer wire $20 short of one invoice -> fee, names the credit note', fee.how === 'fee' && /Bank charges/.test(fee.why), fee.how + ' ' + fee.why);
const lump = M.matchLine(line({ spent: 60000, desc: 'Wire Type', party: 'Mazariegos Recycling' }), docs);
ck('round lump to a supplier -> lump, shows what it would clear and the leftover', lump.how === 'lump' && /left over/.test(lump.why), lump.why);
ck('lump only when the payee is known', M.matchLine(line({ spent: 60000, desc: 'Wire Type' }), docs).how === 'none');

ck('"Inesh Cores Chapin" is not "Calderon Cores" — trade words do not count', M.nameHit('Inesh Cores Chapin', 'Calderon Cores') === false);
ck('a real name still matches', M.nameHit('Transfer Edge Metals MAZARIEGOS RECYCLING', 'Mazariegos Recycling') === true);
ck('the payee narrows the field: a wire from one party is never another party\'s invoice',
   M.matchLine(line({ received: 24000, party: 'TAEWON PRECEISION' }), docs).docs.every((d) => d.party === 'TAEWON PRECEISION'));

const wrong = M.matchLine(line({ received: 110501.6, party: '5 Core Trading Inc' }), docs);
ck('amounts add up but the payee is someone else -> downgraded and said plainly', wrong.how === 'near' && /BUT the bank says 5 Core Trading Inc/.test(wrong.why), wrong.how + ' ' + wrong.why);
ck('right payee keeps its verdict', M.matchLine(line({ received: 110501.6, party: 'Edge Metals Recycling' }), docs).how === 'group');

console.log(`\nqb-bank-match: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
