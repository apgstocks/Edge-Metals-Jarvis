// tests/quickbooks-receivables.js — chasing what she is owed.
// Apsara, 2026-10-02: "Beat Intuit's AI in all aspects." Their Payments agent
// chases late payers. The thing it cannot do is know she already has the
// money: $131,763.84 of customer receipts on her books sit on no invoice, and
// TAEWON's sits on one record while the debt sits on the other, because they
// are the same company under two names.
//
// A reminder sent into that is not a dunning letter. It is an apology.
const fs = require('fs'), path = require('path');
process.env.QB_ENV = 'sandbox';
let pass = 0, fail = 0; const failures = [];
const ck = (n, ok, extra) => { if (ok) { pass++; console.log('  PASS ', n); } else { fail++; failures.push(n); console.log('  FAIL ', n, extra === undefined ? '' : String(JSON.stringify(extra)).slice(0, 240)); } };

const ar = require('../helpers/quickbooks/receivables');

// ── two records, one company ──────────────────────────────────────────────
const map = ar.aliases();
ck('the same-customer list is read', Object.keys(map).length > 0, Object.keys(map));
ck('TAEWON AUTOMOTIVE resolves to TAEWON PRECEISION', ar.sameAs('TAEWON AUTOMOTIVE CO', map) === 'TAEWON PRECEISION');
ck('...and every FMC spelling resolves to one', ['FMC', 'FMC Metal', 'FMC metals'].every((n) => ar.sameAs(n, map) === 'FMC METALS'));
ck('a customer with no alias is left exactly as it is', ar.sameAs('Rad Metals', map) === 'Rad Metals');

// ── the draft, and what it refuses to send ────────────────────────────────
const customer = (o) => ({ customer: 'Daekwang Co,Ltd', open: 50000, received: 0, invoices: [], aging: { current: 0, d30: 0, d60: 0, d90: 0 }, ...o });
{
    const covered = customer({ open: 88.91, received: 27099.79, verdict: 'do-not-chase',
        why: '27099.79 already received from them and applied to nothing — that covers everything open.',
        invoices: [{ id: '1', doc: 'A', date: '2026-01-01', balance: 88.91, late: 200, containers: [] }] });
    const d = ar.draft(covered);
    ck('a customer whose debt is already covered is NEVER written to', d.skip === true, d);
    ck('...and the reason says the money is already in the bank', /already received/.test(d.why || ''));
}
{
    const partly = customer({ open: 460759.83, received: 27099.79, verdict: 'apply-first',
        invoices: [{ id: '2', doc: '260819_AC_26JY94', date: '2026-07-01', balance: 45020, late: 60, containers: ['HMMU4929318'] },
            { id: '3', doc: '260819_AC_26JY93', date: '2026-08-01', balance: 56087.5, late: 30, containers: ['TCNU5059310'] }] });
    const d = ar.draft(partly);
    ck('a customer who is genuinely late does get a draft', d.skip === false && d.total > 0, d.total);
    ck('...and it names the container, not just an invoice id', /HMMU4929318/.test(d.body), d.body.slice(0, 200));
    ck('...and says how many days past due', /60 days past due/.test(d.body));
    ck('...and declares the money of theirs she is already holding',
       /\$27,099.79 from you that we have not yet matched/.test(d.body), d.body.slice(-300));
    ck('...and never apologises or threatens', !/sorry|apolog|legal|immediately/i.test(d.body));
    ck('the subject carries the money, so it is answerable from a phone', /\$101,107\.50/.test(d.subject), d.subject);
}
{
    // nothing overdue: the draft falls back to what is open, not to silence
    const soon = customer({ open: 1000, received: 0, verdict: 'nudge',
        invoices: [{ id: '4', doc: 'B', date: '2026-09-28', balance: 1000, late: 2, containers: [] }] });
    ck('a just-past-due customer gets a note, not a chase', ar.draft(soon).skip === false);
}

// ── it drafts, it does not send ───────────────────────────────────────────
const src = fs.readFileSync(path.join(__dirname, '..', 'helpers', 'quickbooks', 'receivables.js'), 'utf8');
ck('nothing in here sends an email', !/sendEmail|sendMail|transport|smtp/i.test(src));
ck('nothing in here writes to QuickBooks', !/request\('POST'/.test(src));
ck('the draft carries no recipient — she addresses it', /to: null/.test(src));

// ── the agent treats it as its own invariant ──────────────────────────────
const agent = require('../helpers/quickbooks/agent');
ck('"every receipt sits on an invoice" is an invariant the agent owns',
   (agent.INVARIANTS.find((i) => i.id === 'receiptsUnapplied') || {}).who === 'agent');
const q = agent.queue({ invariants: { receiptsUnapplied: { number: 131763.84, count: 5, doNotChase: [{ customer: 'TAEWON', received: 27099.79 }] },
    unallocated: { number: 0 }, duplicates: { number: 0 }, miscoded: { number: 0 }, payableAccounts: { number: 1 }, bankGap: {} } });
const item = q.find((x) => x.id === 'receiptsUnapplied') || {};
ck('...and places it before any reminder goes out', item.verdict === 'do' && /BEFORE any reminder/.test(item.note || ''), item);

console.log(`\nquickbooks-receivables: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
