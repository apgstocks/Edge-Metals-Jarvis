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
// 2026-10-05: the verdict now depends on whether there is anything the agent
// is actually ALLOWED to place. It may place a receipt that matches an open
// invoice to the cent and nothing else, so 'do' is earned, not assumed — a
// 'do' on work with no code behind it is what this invariant said for a
// fortnight while run() skipped it entirely.
const ask = (ru) => agent.queue({ invariants: { receiptsUnapplied: ru,
    unallocated: { number: 0 }, duplicates: { number: 0 }, miscoded: { number: 0 }, payableAccounts: { number: 1 }, bankGap: {} } })
    .find((x) => x.id === 'receiptsUnapplied') || {};

const base = { number: 131763.84, count: 5, doNotChase: [{ customer: 'TAEWON', received: 27099.79 }] };
const item = ask({ ...base, certain: 2, certainMoney: 4100, stuck: [] });
ck('...and places it before any reminder goes out', item.verdict === 'do' && /BEFORE any reminder/.test(item.note || ''), item);
ck('...saying how much of it it may place itself, and how much it may not',
   /2 match an invoice to the cent/.test(item.detail || ''), item.detail);
ck('with nothing matching to the cent it asks instead of claiming it will act',
   ask({ ...base, certain: 0, certainMoney: 0, stuck: [] }).verdict === 'ask');
ck('...and if the books could not be read at all, it still asks rather than promising',
   ask({ ...base }).verdict === 'ask');
ck('money on the wrong customer record is called out as hers to move',
   /another customer/.test(ask({ ...base, certain: 1, certainMoney: 10, stuck: [{ customer: 'TAEWON AUTOMOTIVE CO', loose: 27099.79, twin: 'TAEWON PRECEISION' }] }).note || ''));

console.log(`\nquickbooks-receivables: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
