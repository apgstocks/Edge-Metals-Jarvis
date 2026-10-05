// ── tests/qb-report-truth.js ──────────────────────────────────────────────
// Two defects in the morning QuickBooks mail, both found by reading the one
// Apsara forwarded on 2026-10-04 rather than by any check in this suite.
//
// ── 1. THE SAME MONEY, REPORTED AS DONE AND AS OUTSTANDING ───────────────
// That email said, eight lines apart:
//
//     Placed $312,640.87 across 10 payments.
//     Payments sitting on no bill: $312,640.87 — 10 payments
//
// Identical to the cent, and the subject line carried it too. Nothing was
// wrong in her books: agent.run() calls survey() ONCE, above the action loop,
// and reportText() read that pre-action survey straight. So the agent placed
// the payments and then reported the state from before it had.
//
// The cost is trust. That section's stated job, in its own comment, is "the
// one number that says whether this is getting better" — and it was the one
// number that could not move within a run.
//
// ── 2. THREE HUNDRED AND FIFTY LINES SAYING ONE THING ────────────────────
// The same mail listed 1,273 locked-period records as one line PER DATE:
//
//     4 — bill dated 2026-01-05 is before the locked period — she closed …
//     2 — bill dated 2026-01-06 is before the locked period — she closed …
//     … ~350 more
//
// because push.js builds that sentence with the date inside it and the digest
// grouped by the whole sentence. The 24 STUCK rows — the only part of the
// mail she can act on — were underneath all of it.
//
// Both fixes are display-only. No money logic, no API calls, no change to
// what the agent does.

const path = require('path');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const agent = require(path.join(ROOT, 'helpers/quickbooks/agent'));

(async () => {

// The 4 October run, as `out` — her real figures.
const OCT4 = () => ({
    at: '2026-10-04T07:30:00Z', year: 2026, env: 'production', dryRun: false,
    did: [{ id: 'allocate', placed: 312640.87, payments: 10, skipped: 0 }],
    asked: [],
    survey: {
        owe: { total: 5170483.28 }, owedToYou: { total: 3447940.34 },
        invariants: {
            // The PRE-RUN figure. The agent then placed exactly this.
            unallocated: { number: 312640.87, count: 10, worst: [
                { party: 'Mazariegos Recycling', amount: 139167.30 },
                { party: 'Calderon Cores', amount: 53177.80 },
                { party: 'Midland', amount: 44961.00 },
            ] },
            duplicates: { number: 194857.29, count: 10 },
            miscoded: { number: 411276.27, count: 16, noPayee: { count: 9, money: 265518.34 } },
            // All THREE, as printed in her mail — the zero-balance Zimex
            // account is the one that would otherwise read '$0.00 owed'.
            payableAccounts: { number: 3, accounts: [
                { name: 'Accounts Payable', balance: -57224.15 },
                { name: 'Accounts Payable - Zimex', balance: 0 },
                { name: 'Vendor Payable', balance: -5113259.13 },
            ] },
        },
    },
});

// ── A — THE RUN THAT CLEARED EVERYTHING IT FOUND ──────────────────────────
{
    section('A — placed it all');

    const text = agent.reportText(OCT4());

    ck('it still says what it placed', /Placed \$312,640\.87 across 10 payments/.test(text),
       text.split('\n').slice(0, 2).join(' | '));

    // THE BUG, stated as the check: that figure must not also appear as
    // money still sitting on no bill.
    const loose = /Payments sitting on no bill: \$([\d,]+\.\d\d)/.exec(text);
    ck('  and does NOT also report the same money as outstanding',
       !loose, loose && loose[0]);
    ck('  it says there is none left, naming what cleared it',
       /Payments sitting on no bill: none left — this run placed all \$312,640\.87 of it\./.test(text),
       (text.split('\n').find((l) => /sitting on no bill/.test(l)) || '(line missing)'));

    // The other invariants are untouched by this change and must still print.
    ck('  the other findings are unaffected',
       /Documents doubled: \$194,857\.29/.test(text)
       && /Supplier money in cost of goods: \$411,276\.27/.test(text)
       && /Payable accounts in use: 3/.test(text),
       'only the unallocated line was in question');
}

// ── B — A PARTIAL RUN SHOWS WHAT IS LEFT ──────────────────────────────────
// The ordinary case, and the one that proves the fix is arithmetic rather
// than a special case for "it placed everything".
{
    section('B — placed some of it');

    const out = OCT4();
    out.did = [{ id: 'allocate', placed: 100000, payments: 3, skipped: 0 }];
    const text = agent.reportText(out);

    ck('it reports the REMAINDER, not the starting figure',
       /Payments sitting on no bill: \$212,640\.87/.test(text),
       (text.split('\n').find((l) => /sitting on no bill/.test(l)) || '(missing)'));
    ck('  with the remaining count', /7 payments/.test(text),
       'ten found, three placed');
    ck('  and says the run is why it shrank',
       /after the \$100,000\.00 this run placed/.test(text),
       'a smaller number with no explanation looks like the problem went away on its own');
}

// ── C — A RUN THAT PLACED NOTHING IS UNCHANGED ────────────────────────────
// The regression risk in the fix: subtracting from a run with no `did` entry
// must not turn the figure into NaN or hide a real problem.
{
    section('C — nothing placed');

    const out = OCT4();
    out.did = [];
    const text = agent.reportText(out);

    ck('it says nothing was placed', /Nothing to place today\./.test(text));
    ck('  and the full amount is still reported',
       /Payments sitting on no bill: \$312,640\.87/.test(text),
       (text.split('\n').find((l) => /sitting on no bill/.test(l)) || '(missing)'));
    ck('  with no NaN anywhere', !/NaN/.test(text),
       (text.split('\n').find((l) => /NaN/.test(l)) || ''));
    ck('  and no stray "after the ... placed"', !/after the/.test(text));
}

// ── D — THE SUBJECT LINE, WHICH IS THE PART SHE SEES FIRST ────────────────
// Called for real, with the mailer stubbed, rather than grepped. My first
// version of this section matched the source for "did && did.placed" near
// "stillLoose" — and the subject TEMPLATE contains that same expression, so
// the check passed with the fix reverted. A regex that matches the thing it
// is meant to be distinguishing from is not a check.
{
    section('D — the subject');

    const gmail = require(path.join(ROOT, 'helpers/gmail'));
    const realSend = gmail.sendEmail;
    let sent = null;
    gmail.sendEmail = async (msg) => { sent = msg; return { ok: true, stubbed: true }; };

    try {
        // Placed everything it found: the subject must not also say that
        // same amount is loose.
        await agent.emailReport(OCT4(), { to: 'nobody@example.invalid' });
        ck('it says what was placed', /\$312,640\.87 placed/.test(sent.subject), sent.subject);
        ck('  and does NOT say the same money is still loose',
           !/still loose/.test(sent.subject), sent.subject);

        // Placed part of it: the remainder, not the starting figure.
        const partial = OCT4();
        partial.did = [{ id: 'allocate', placed: 100000, payments: 3, skipped: 0 }];
        await agent.emailReport(partial, { to: 'nobody@example.invalid' });
        ck('a partial run reports the remainder in the subject',
           /\$100,000\.00 placed, \$212,640\.87 still loose/.test(sent.subject), sent.subject);

        // Placed nothing: the full figure, unchanged.
        const none = OCT4();
        none.did = [];
        await agent.emailReport(none, { to: 'nobody@example.invalid' });
        ck('  and a run that placed nothing still shows the whole amount',
           /nothing placed, \$312,640\.87 still loose/.test(sent.subject), sent.subject);

        ck('  the body went with it', typeof sent.body === 'string' && sent.body.length > 100);
    } finally {
        gmail.sendEmail = realSend;
    }
}

// ── F — THE PAYABLE LINE THAT CAUSED AN ALARM IT COULD HAVE ANSWERED ──────
// Her 4 October mail printed QuickBooks' raw signed balances:
//
//   Payable accounts in use: 3 — Accounts Payable $-57,224.15 ·
//   Accounts Payable - Zimex $0.00 · Vendor Payable $-5,113,259.13
//
// Minus five million against a payable reads like a hole. It is not: those
// are credit balances — what she owes — and 57,224.15 + 0 + 5,113,259.13 =
// 5,170,483.28, the "You owe" figure at the top of the SAME email, to the
// cent. I told her those two numbers were "almost certainly the same money
// seen twice", meaning double-counted. They are a total and its components,
// and they agree. The line held the answer to the alarm it was causing.
{
    section('F — payable accounts, in her real figures');

    const text = agent.reportText(OCT4());

    ck('each balance is shown as what it means',
       /Accounts Payable \$57,224\.15 owed/.test(text) && /Vendor Payable \$5,113,259\.13 owed/.test(text),
       (text.split('\n').find((l) => /Payable accounts/.test(l)) || '(missing)'));
    ck('  a zero balance says so rather than printing $0.00 owed',
       /Zimex nothing owed/.test(text),
       (text.split('\n').find((l) => /Payable accounts/.test(l)) || ''));
    ck('  and the minus sign is explained',
       /means owed, not overdrawn/.test(text),
       'the reader must not have to know QuickBooks sign conventions');
    ck('  with the reconciliation stated',
       /come to \$5,170,483\.28, which is the "You owe" figure above/.test(text),
       (text.split('\n').find((l) => /come to/.test(l)) || '(missing)'));

    // ── AND WHEN THEY DO NOT AGREE, WHICH IS THE POINT ───────────────────
    // A line that always says "these add up" is decoration. The version that
    // earns its place is the one that notices when they stop adding up.
    const off = OCT4();
    off.survey.owe.total = 4000000;
    const t2 = agent.reportText(off);
    ck('a mismatch is reported, with the gap',
       /WORTH A LOOK/.test(t2) && /\$1,170,483\.28/.test(t2),
       (t2.split('\n').find((l) => /WORTH A LOOK/.test(l)) || '(missing)'));
    ck('  and it does not claim they reconcile',
       !/which is the "You owe" figure/.test(t2));
    ck('  nor does it assert the sign convention it could not verify',
       /QuickBooks says -\$5,113,259\.13|QuickBooks says \$-5,113,259\.13/.test(t2),
       (t2.split('\n').find((l) => /Payable accounts/.test(l)) || ''));

    // One payable account is the ordinary case and must not grow a paragraph.
    const one = OCT4();
    one.survey.invariants.payableAccounts = { number: 1, accounts: [{ name: 'Accounts Payable', balance: -100 }] };
    ck('a single payable account says nothing at all',
       !/Payable accounts in use/.test(agent.reportText(one)),
       'the line exists because THREE of them is the oddity');
}

// ── E — ONE LINE PER REASON, NOT PER DATE ─────────────────────────────────
// Driven through the REAL reportText rather than grepped, because the first
// version of this section asserted the source code contained a Map — which
// would stay green if the grouping were right and the printing wrong.
{
    section('E — the locked-period summary, rendered');

    const nightly = require(path.join(ROOT, 'helpers/quickbooksNightly'));

    // Built the way helpers/quickbooks/sync.js builds it: keyed by the whole
    // sentence, which push.js writes with the DATE inside. 180 dates, two
    // kinds, one actual reason.
    const why = {};
    let total = 0;
    for (let d = 1; d <= 28; d++) {
        for (const kind of ['bill', 'invoice']) {
            const day = `2026-01-${String(d).padStart(2, '0')}`;
            why[`${kind} dated ${day} is before the locked period (2026-09-06) — she closed that period deliberately`] = d;
            total += d;
        }
    }
    const out = {
        at: new Date().toISOString(), env: 'production',
        entered: 0, stuck: [], blocked: [], asked: [],
        result: { leftAlone: { bill: 406, sale: 378, from: '2026-01-01', to: '2026-01-28', why } },
    };

    let text = null; let err = null;
    try { text = nightly.reportText(out); } catch (e) { err = e; }
    ck('the digest renders', !err && typeof text === 'string', err && err.message);

    if (text) {
        const lines = text.split('\n').filter((l) => /before the locked period/.test(l));
        ck('  56 distinct sentences become a handful of lines',
           lines.length > 0 && lines.length <= 4,
           `${lines.length} line(s): ` + lines.slice(0, 3).join(' | '));
        ck('  the counts are summed, not lost',
           lines.reduce((t, l) => t + (parseInt((/^\s*(\d+)/.exec(l) || [])[1], 10) || 0), 0) === total,
           `expected ${total}`);
        ck('  and the span is named instead of every date',
           /from 2026-01-01 to 2026-01-28/.test(text),
           lines.join(' | '));
        ck('  no single date is printed as its own line',
           !/\bdated 2026-01-05 is before/.test(text),
           (lines.find((l) => /dated 2026-01-05/.test(l)) || ''));
    }

    // A reason that is NOT date-shaped must survive untouched — the grouping
    // must not swallow a different kind of problem into the lock bucket.
    {
        const mixed = {
            at: new Date().toISOString(), env: 'production', entered: 0, stuck: [], blocked: [], asked: [],
            result: { leftAlone: { bill: 3, from: '2026-01-01', to: '2026-01-02', why: {
                'bill dated 2026-01-01 is before the locked period (2026-09-06) — she closed that period deliberately': 2,
                'the supplier has no QuickBooks match': 1,
            } } },
        };
        const t2 = nightly.reportText(mixed);
        ck('  an unrelated reason is still its own line',
           /1 — the supplier has no QuickBooks match/.test(t2),
           (t2.split('\n').find((l) => /QuickBooks match/.test(l)) || '(missing)'));
    }
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('threw:', e && e.stack); process.exit(1); });
