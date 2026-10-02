// tests/quickbooks-decisions.js — what she has already answered.
// The difference between an agent and a cron job that nags is that the agent
// asks once. Over one week she answered the same classes of question again
// and again, and each answer was turned into code by hand, by me — which does
// not scale past the ones I was present for.
const fs = require('fs'), os = require('os'), path = require('path');
process.env.QB_DECISIONS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qbdec-')), 'decisions.json');
let pass = 0, fail = 0; const failures = [];
const ck = (n, ok, extra) => { if (ok) { pass++; console.log('  PASS ', n); } else { fail++; failures.push(n); console.log('  FAIL ', n, extra === undefined ? '' : String(JSON.stringify(extra)).slice(0, 220)); } };

const d = require('../helpers/quickbooks/decisions');

// ── a standing rule, which is the one that matters ────────────────────────
const garduno = d.remember({ about: 'duplicate', party: "GARDUNO'S LOGISTICS INC.", pattern: 'same-total-same-day',
    verdict: 'not-a-duplicate', reason: 'trucking is a flat rate per container, so two hauls on one day cost the same' });
ck('a standing rule is stored against the party and the pattern', garduno.standing === true && /party:GARDUNOSLOGISTICSINC/.test(garduno.key), garduno.key);
ck('...and is recalled for that party', !!d.recall({ about: 'duplicate', party: "Garduno's Logistics Inc", pattern: 'same-total-same-day' }));
ck('...whatever the spelling and punctuation', !!d.recall({ about: 'duplicate', party: 'GARDUNOS LOGISTICS, INC.', pattern: 'same-total-same-day' }));
ck('...and NOT for a different party', d.recall({ about: 'duplicate', party: 'Midland', pattern: 'same-total-same-day' }) === null);
ck('...and NOT for a different pattern', d.recall({ about: 'duplicate', party: "GARDUNO'S LOGISTICS INC.", pattern: 'same-container-twice' }) === null);

// ── a specific answer about two documents ─────────────────────────────────
const pair = d.remember({ about: 'duplicate', subjects: ['38553', '38324'], verdict: 'is-a-duplicate', reason: 'the same three lines on TCKU6404660, twice' });
ck('a specific decision keys on the documents in a stable order', pair.key === 'duplicate|38324+38553', pair.key);
ck('...and is found whichever order they come back in',
   !!d.recall({ about: 'duplicate', subjects: ['38324', '38553'] }) && !!d.recall({ about: 'duplicate', subjects: ['38553', '38324'] }));

// ── what it refuses to store ──────────────────────────────────────────────
const refuses = (fn) => { try { fn(); return false; } catch { return true; } };
ck('a decision about nothing in particular is refused',
   refuses(() => d.remember({ about: 'duplicate', verdict: 'fine', reason: 'because' })));
ck('a decision with no reason is refused — the reason is what makes it readable in a year',
   refuses(() => d.remember({ about: 'duplicate', subjects: ['1'], verdict: 'fine' })));
ck('a decision about something the agent cannot act on is refused',
   refuses(() => d.remember({ about: 'the weather', subjects: ['1'], verdict: 'fine', reason: 'sunny' })));

// ── answering the same thing twice updates, never duplicates ──────────────
const again = d.remember({ about: 'duplicate', party: "GARDUNO'S LOGISTICS INC.", pattern: 'same-total-same-day',
    verdict: 'not-a-duplicate', reason: 'said again, with a better reason: each haul is its own set of containers' });
ck('answering again keeps one decision, not two', again.id === garduno.id && d.list({ about: 'duplicate' }).filter((x) => x.standing).length === 1);
ck('...and the newer reason wins', /its own set of containers/.test(d.recall({ about: 'duplicate', party: "GARDUNO'S LOGISTICS INC.", pattern: 'same-total-same-day' }).reason));

// ── a wrong rule must be as easy to take back as a wrong entry ────────────
ck('a decision can be forgotten', !!d.forget(garduno.id));
ck('...and then the question comes back', d.recall({ about: 'duplicate', party: "GARDUNO'S LOGISTICS INC.", pattern: 'same-total-same-day' }) === null);
ck('forgetting something that is not there says so', d.forget('D_nope') === null);

// ── silencing a finding, without hiding it ────────────────────────────────
const checks = require('../helpers/quickbooks/checks');
const bill = (id, vendor, amt) => ({ Id: id, TxnDate: '2026-03-05', DocNumber: '', TotalAmt: amt, Balance: 0, VendorRef: { name: vendor },
    Line: [{ DetailType: 'AccountBasedExpenseLineDetail', Description: 'x', Amount: amt, AccountBasedExpenseLineDetail: { AccountRef: { name: 'Trucking' } } }] });
const ctx = () => ({ since: '2026-01-01', purchases: [], vendors: [], customers: [], bills: [bill('7', 'Garduno', 9300)], invoices: [] });
const before = checks.run(ctx()).find((c) => c.id === 'no-reference');
ck('an unanswered finding is raised', before.count === 1 && before.silenced === 0);
d.remember({ about: 'duplicate', subjects: ['7'], verdict: 'fine', reason: 'she looked at this one and it is correct' });
const after = checks.run(ctx()).find((c) => c.id === 'no-reference');
ck('an answered finding stops being raised', after.count === 0);
ck('...but is still counted, so a rule cannot quietly hide a growing pile', after.silenced === 1);
ck('...and carries when she answered it and why', /she looked at this one/.test((after.silencedRows[0] || {}).answeredWhy || ''));
const off = checks.run({ ...ctx(), decisions: false }).find((c) => c.id === 'no-reference');
ck('the decisions can be switched off entirely for a clean look', off.count === 1 && off.silenced === 0);

// ── where they live ───────────────────────────────────────────────────────
const src = fs.readFileSync(path.join(__dirname, '..', 'helpers', 'quickbooks', 'decisions.js'), 'utf8');
ck('they live in qb-settings, in git — not in a folder one machine has',
   /qb-settings', 'qb-decisions\.json'/.test(src));

console.log(`\nquickbooks-decisions: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
