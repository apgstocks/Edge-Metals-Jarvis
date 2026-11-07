// Apsara, 2026-11-07: the morning sweep said "25 × a payment whose source was never named: \"this payment\"" - which 25? "this payment" was only the
// fallback label. Now the line names examples (date, amount, who) and the total, and says where to fix them. Real expenses store, real books build.
const fs = require('fs'), os = require('os'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-unnamed-')); process.env.JARVIS_TEST = '1';
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
const cfg = require(path.join(ROOT, 'config'));
const W = (f, v) => { const p = path.join(process.env.DATA_DIR, f); fs.writeFileSync(p, JSON.stringify(v, null, 2)); return p; };
cfg.EXPENSES_FILE = W('expenses.json', [
    { id: 'E1', date: '2026-09-02', amount: 35000, category: 'Other', description: 'copper advance' },
    { id: 'E2', date: '2026-09-03', amount: 120.5, category: 'Fuel', payee: 'Shell' },
    { id: 'E3', date: '2026-09-04', amount: 80, category: 'Fuel', payee: 'Shell' },
    { id: 'E4', date: '2026-09-05', amount: 60, category: 'Fuel', payee: 'Shell' },
    { id: 'E5', date: '2026-09-06', amount: 40, category: 'Fuel', method: 'Cash' },          // fine
]);
const sweep = require(path.join(ROOT, 'helpers/integritySweep'));
const res = sweep.run({});
const f = res.findings.find((x) => x.id === 'posted-but-not-settled');
ck('still ONE grouped line for the cause (her earlier design)', f && f.items.length >= 1 && /^4 × a payment whose source was never named/.test(f.items[0].what), JSON.stringify(f && f.items));
ck('it now names examples with date, amount and who', /2026-09-02 \$35,000\.00 copper advance/.test(f.items[0].detail) && /Shell/.test(f.items[0].detail), f.items[0].detail);
ck('  gives the total and says where to fix them', /total \$35,260\.50/.test(f.items[0].detail) && /set the payment method on each in Expenses/.test(f.items[0].detail), f.items[0].detail);
ck('  and no longer just says "this payment"', !/this payment/.test(JSON.stringify(f.items)));
ck('the expense WITH a payment method raises nothing', !/2026-09-06/.test(JSON.stringify(f.items)));
const built = require(path.join(ROOT, 'helpers/booksBuild')).build({});
ck('the note text still STARTS the way it did (nothing matching the old text breaks)', built.needs.some((n) => /^expense: no bank or drawer identified for "this payment" — recorded against 2090/.test(n)) && built.needs.every((n) => /\[[^\]]+\]$/.test(n)), JSON.stringify(built.needs.slice(0, 2)));
ck('the books still post it (figure unchanged: needs, not problems)', built.problems.length === 0);
const R = require(path.join(ROOT, 'helpers/sweepReport'));
const mail = R.compactText({ ...res, total: res.findings.reduce((a, x) => a + x.count, 0), checks: 9, broken: [] }, null, {});
ck('and the morning email keeps the whole line (examples, total, where to fix)', /total \$35,260\.50/.test(mail) && /set the payment method on each in Expenses/.test(mail), mail);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
