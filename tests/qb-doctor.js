// tests/qb-doctor.js — the pre-flight.
// Eight commits of QuickBooks work went in before any of it ran anywhere, and
// twice in one afternoon a check answered from the wrong file and told her
// something untrue. The doctor exists so that question — "which stores is
// this machine actually reading, and is anything switched on" — is answered
// out loud before a single number is believed.
const fs = require('fs'), path = require('path');
let pass = 0, fail = 0; const failures = [];
const ck = (n, ok, extra) => { if (ok) { pass++; console.log('  PASS ', n); } else { fail++; failures.push(n); console.log('  FAIL ', n, extra === undefined ? '' : String(extra).slice(0, 200)); } };

const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'qb-doctor.js'), 'utf8');

ck('it writes nothing — no POST anywhere in it', !/request\('POST'|operation=(void|delete)|saveMap|confirm\(/.test(src));
ck('it names which name map this machine reads', /mapping\.MAP_FILE\(\)/.test(src));
ck('...and which journal, links and decisions', /JOURNAL_FILE\(\)/.test(src) && /LINKS_FILE\(\)/.test(src) && /decisions\.FILE\(\)/.test(src));
ck('it counts the ledgers, and says plainly when there are none',
   /THIS MACHINE HAS NO LEDGER DATA/.test(src), 'that is the trap that cost two wrong answers');
ck('it reports all three switches, not just the first', /QB_PROD_WRITES/.test(src) && /QB_SYNC/.test(src) && /QB_AGENT/.test(src));
ck('it reports the cutover AND where it comes from', /cutoverFor/.test(src) && /cutoverSource/.test(src));
ck('it checks every account role, not only prepayment', /ACCOUNT_ROLES/.test(src));
ck('it checks the three nightly jobs exist', /15 23/.test(src) && /0 0 /.test(src) && /30 0 /.test(src));
ck('it proves it can read her books, rather than assuming', /companyInfo/.test(src));
ck('it exits non-zero when something is wrong, so a deploy script can stop',
   /process\.exit\(problems\.length \? 1 : 0\)/.test(src));
// 2026-10-02: unset is now the HEALTHY state — it used to mean "nothing will be
// entered". What is worth a warning is the opposite: a lock, and above all a
// rolling one, which blocks every back-dated row.
ck('no lock is reported as the normal state, not as a fault', /this is the normal state/.test(src));
ck('a rolling lock is called out for what it costs', /nothing back-dated can ever be entered/.test(src));
ck('...and the doctor fails on one, because she almost certainly did not mean it', /say\(!rolling/.test(src));
ck('an unmapped role is called out as a write that will block', /a write that needs it will block/.test(src));
ck('it counts rows dated ahead of today, because those are newly refused',
   /dated after today/.test(src) && /now REFUSED as typos/.test(src));

ck('it reports what the boundary is HOLDING BACK, not just the date',
   /what the boundary holds back/.test(src), 'a cutover that is set is not a cutover that is right');
ck('...and fails when recent work is behind it', /TONIGHT'S WORK IS BEING SKIPPED/.test(src));
ck('...while old rows behind it read as the accountant\'s period, not an alarm',
   /accountant\\'s period/.test(src) || /accountant/.test(src));
ck('...and it only counts rows that are not already in QuickBooks', /loadLinks\(\)/.test(src));

console.log(`\nqb-doctor: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
