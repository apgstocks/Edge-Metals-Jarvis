// ── tests/bank-match.js ───────────────────────────────────────────────────
// Apsara, 2026-10-05: "My biggest problem is matching only."
//
// The three cases she described, and then the six ways a matcher gets money
// wrong. The happy path is the easy part of this file; everything from
// section D down is about what it must REFUSE to do.

const path = require('path');
let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const m = require(path.join(ROOT, 'helpers/bankMatch'));

// Her shapes. INV-200 already has an advance against it, which is what makes
// the balance case work at all.
const inv = (id, party, date, amount, applied = 0) => ({ id, party, date, amount, applied, label: id });
const DOCS = [
    inv('INV-101', 'Custom Alloys', '2026-08-01', 18000),
    inv('INV-102', 'Custom Alloys', '2026-08-14', 22000),
    inv('INV-103', 'Custom Alloys', '2026-08-20', 7310.22),
    inv('INV-200', 'Mazariegos', '2026-07-02', 95000, 38000),   // 38k advance paid
    inv('INV-301', 'Zimex', '2026-08-02', 18000),               // same amount as INV-101, OTHER party
];
const dep = (amount, date = '2026-09-05', extra = {}) => ({ id: 'd', date, amount, descriptor: 'x', ...extra });
const as = (party) => ({ resolveParty: () => party });
const top = (r) => (r.proposals || [])[0] || null;
const ids = (p) => (p ? p.allocations.map((a) => a.doc_id).join('+') : null);

// ── A — THE THREE CASES SHE NAMED ─────────────────────────────────────────
{
    section('A — the three cases, in her words');

    // "we just combined the invoice amount for a customer and then paid"
    const combined = m.matchDeposit(dep(47310.22), DOCS, as('Custom Alloys'));
    ck('one deposit covering three invoices is found',
       combined.outcome === 'proposed' && top(combined).kind === 'combined', combined.outcome);
    ck('  and it names all three',
       ids(top(combined)).split('+').sort().join('+') === 'INV-101+INV-102+INV-103', ids(top(combined)));
    ck('  allocating each invoice its own full balance',
       top(combined).allocations.every((a) => a.clears)
       && Math.abs(top(combined).allocations.reduce((t, a) => t + a.amount, 0) - 47310.22) < 0.005,
       JSON.stringify(top(combined).allocations.map((a) => a.amount)));
    ck('  and it is not flagged as needing her',
       !combined.ambiguous && top(combined).score >= 0.8, String(top(combined).score));

    // "we just paid advance and then balance will be paid for that container"
    const balance = m.matchDeposit(dep(57000, '2026-07-20'), DOCS, as('Mazariegos'));
    ck('the BALANCE after an advance matches the remainder, not the invoice',
       balance.outcome === 'proposed' && ids(top(balance)) === 'INV-200'
       && top(balance).allocations[0].amount === 57000, ids(top(balance)));
    ck('  and it clears the invoice',
       top(balance).allocations[0].clears === true,
       '95,000 invoice, 38,000 advance, 57,000 balance — that is settled');

    // The advance itself, arriving first against an untouched invoice.
    const fresh = [inv('INV-200', 'Mazariegos', '2026-07-02', 95000, 0)];
    const advance = m.matchDeposit(dep(38000, '2026-07-05'), fresh, as('Mazariegos'));
    ck('the ADVANCE itself is a part payment, and says what is left',
       top(advance).kind === 'partial' && top(advance).allocations[0].clears === false
       && top(advance).allocations[0].leaves === 57000,
       JSON.stringify(top(advance).allocations[0]));
    ck('  and it says so in words, not just a flag',
       top(advance).reasons.some((x) => /does not clear/.test(x))
       && top(advance).reasons.some((x) => /57000\.00 would still be owed/.test(x)),
       top(advance).reasons.join(' | '));
}

// ── B — WHAT IT MUST NEVER DO WITH THE MONEY ──────────────────────────────
// Every check here is a way to allocate real money to the wrong place.
{
    section('B — the ways this costs money');

    // A deposit must never be allocated beyond itself. If this ever fails,
    // an invoice is marked paid with money that did not arrive.
    const over = [];
    for (const amt of [1000, 7310.22, 18000, 22000, 25310.22, 40000, 47310.22, 47310.23]) {
        const r = m.matchDeposit(dep(amt), DOCS, as('Custom Alloys'));
        for (const p of (r.proposals || [])) {
            const sum = Math.round(p.allocations.reduce((t, a) => t + a.amount, 0) * 100) / 100;
            if (sum > amt + 0.005) over.push(`${amt}: ${ids(p)} = ${sum}`);
        }
    }
    ck('no proposal ever allocates more than the deposit', over.length === 0, over.join(' ; '));

    // ── ONE-SIDED CHECKS SLEEP THROUGH HALF THE BUG ──────────────────────
    // The check above only looks for OVER-allocation, and it duly passed
    // while a combined short payment allocated 39,985 of a 39,970 deposit —
    // fifteen dollars that existed in no record at all. The property is
    // EQUALITY: every cent of the deposit lands somewhere, and the invoice
    // side is accounted for by allocation + shortfall.
    const mismatched = [];
    const scenarios = [
        { amt: 22000, pats: null }, { amt: 47310.22, pats: null },
        { amt: 21970, pats: { feeAllowance: 30 } },
        { amt: 39970, pats: { feeAllowance: 30, combines: true } },
        { amt: 47280.22, pats: { feeAllowance: 30, combines: true } },
        { amt: 10000, pats: null }, { amt: 7310.22, pats: null },
    ];
    for (const sc of scenarios) {
        const r = m.matchDeposit(dep(sc.amt), DOCS, { ...as('Custom Alloys'), patternsFor: () => sc.pats });
        for (const p of (r.proposals || [])) {
            const paid = Math.round(p.allocations.reduce((t, a) => t + a.amount, 0) * 100) / 100;
            if (Math.abs(paid - sc.amt) > 0.005) mismatched.push(`${sc.amt}: ${ids(p)} paid ${paid}`);
            // And the invoice side closes: what each document was credited
            // plus what was written off equals the balance it had.
            for (const a of p.allocations) {
                if (!a.clears) continue;
                const d = DOCS.find((x) => x.id === a.doc_id);
                const bal = m.openBalance(d);
                if (Math.abs(a.amount + (a.shortfall || 0) - bal) > 0.005) {
                    mismatched.push(`${sc.amt}: ${a.doc_id} ${a.amount}+${a.shortfall} != ${bal}`);
                }
            }
        }
    }
    ck('  every cent of the deposit is allocated — not a cent more, not a cent less',
       mismatched.length === 0, mismatched.join(' ; '));

    // The shortfall must be ONE deduction, not one per invoice. She had one
    // bank charge; three charges of $10 would be a false statement about the
    // bank, and bankChargesTotal() would report three.
    const multiShort = m.matchDeposit(dep(47280.22), DOCS,
        { ...as('Custom Alloys'), patternsFor: () => ({ feeAllowance: 30, combines: true }) });
    ck('  a shortfall across several invoices is ONE deduction, not split',
       top(multiShort).allocations.filter((a) => (a.shortfall || 0) > 0).length === 1,
       JSON.stringify(top(multiShort).allocations.map((a) => a.shortfall)));
    ck('  and it is the full shortfall',
       Math.abs(top(multiShort).allocations.reduce((t, a) => t + (a.shortfall || 0), 0) - 30) < 0.005,
       JSON.stringify(top(multiShort).allocations.map((a) => a.shortfall)));

    // Aimed at the ACCEPTANCE test rather than the prune. The suffix-sum
    // prune is only a speed guard: disabling it costs time and changes no
    // answer, which is why mutating it left this file green. What actually
    // stops an overshoot being returned is |remaining| <= tolerance, so that
    // is what needs a check pointed straight at it.
    const exactlyOne = m.subsetsSummingTo(
        [inv('O-1', 'C', '2026-08-01', 22000)], 21000, { tolerance: 0, maxDocs: 6, nodeCap: 1000, maxSolutions: 8 });
    ck('  a 22,000 invoice is never returned as a solution for 21,000',
       exactlyOne.solutions.length === 0, JSON.stringify(exactlyOne.solutions));
    const cents = m.subsetsSummingTo(
        [inv('O-2', 'C', '2026-08-01', 10000), inv('O-3', 'C', '2026-08-01', 5000.01)],
        15000, { tolerance: 0, maxDocs: 6, nodeCap: 1000, maxSolutions: 8 });
    ck('  nor is a combination one cent over', cents.solutions.length === 0,
       JSON.stringify(cents.solutions.map((s) => s.map((d) => d.id))));

    // ANOTHER CUSTOMER'S INVOICE. INV-301 is Zimex and is 18,000 — exactly
    // INV-101's amount. A matcher that forgot to filter by party would pay
    // Zimex's invoice with Custom Alloys' money, and both ledgers would look
    // right until the year end.
    const leak = [];
    for (const amt of [18000, 36000, 47310.22]) {
        const r = m.matchDeposit(dep(amt), DOCS, as('Custom Alloys'));
        for (const p of (r.proposals || [])) if (ids(p).includes('INV-301')) leak.push(`${amt}: ${ids(p)}`);
    }
    ck('one customer\'s deposit never touches another\'s invoice', leak.length === 0, leak.join(' ; '));

    // TOLERANCE IS ZERO UNLESS SHE SAID OTHERWISE. Two numbers a dollar apart
    // are a discrepancy, not a match — reconcile.js makes the same argument
    // and it is the one thing a reconciliation must never blur.
    const near = m.matchDeposit(dep(21999), DOCS, as('Custom Alloys'));
    ck('22,000 owed and 21,999 paid is NOT called a match',
       !(near.proposals || []).some((p) => p.kind === 'exact' || p.kind === 'combined'),
       (near.proposals || []).map((p) => p.kind + ' ' + ids(p)).join(' ; '));
    ck('  it is offered as a part payment instead, with the shortfall stated',
       top(near) && top(near).kind === 'partial' && top(near).allocations[0].leaves === 1,
       JSON.stringify(top(near) && top(near).allocations));

    // A fee allowance is PER PARTY and only from a confirmation of hers.
    const fee = m.matchDeposit(dep(21970), DOCS, {
        ...as('Custom Alloys'), patternsFor: () => ({ feeAllowance: 30 }) });
    ck('a learned fee allowance lets 21,970 clear a 22,000 invoice',
       top(fee).kind === 'exact' && ids(top(fee)) === 'INV-102', ids(top(fee)));
    ck('  and says the shortfall out loud rather than swallowing it',
       top(fee).reasons.some((x) => /30\.00 short/.test(x) && /fee this customer deducts/.test(x)),
       top(fee).reasons.join(' | '));
    // NEGATIVE CONTROL for the above: without the pattern it must not clear.
    const noFee = m.matchDeposit(dep(21970), DOCS, as('Custom Alloys'));
    ck('  without that pattern the same deposit does NOT clear it',
       !(noFee.proposals || []).some((p) => p.kind === 'exact'),
       'the allowance has to come from her, not from the amount being close');
}

// ── C — AMBIGUITY IS A QUESTION ───────────────────────────────────────────
// The most expensive thing this file could do is pick one. Two invoices of
// the same amount, one deposit for that amount: there is no information
// anywhere that distinguishes them.
{
    section('C — when it cannot know, it must not choose');

    const twins = [
        inv('T-1', 'Custom Alloys', '2026-08-01', 12000),
        inv('T-2', 'Custom Alloys', '2026-08-09', 12000),
    ];
    const r = m.matchDeposit(dep(12000), twins, as('Custom Alloys'));
    ck('two identical invoices and one deposit is flagged ambiguous', r.ambiguous === true);
    ck('  both rivals are returned, not just the winner',
       r.proposals.length >= 2 && ids(r.proposals[0]) !== ids(r.proposals[1]),
       r.proposals.map(ids).join(' ; '));
    ck('  and EVERY proposal is capped below any auto-apply threshold',
       r.proposals.every((p) => p.score <= 0.5), JSON.stringify(r.proposals.map((p) => p.score)));
    ck('  with a reason that says why it needs her',
       r.proposals[0].reasons.some((x) => /nothing in the data says which/.test(x)),
       r.proposals[0].reasons.join(' | '));

    // The reason sentence must be TRUE of the row it sits on. My first
    // version told part payments that "N sets of invoices add up to this
    // exact amount", where nothing adds up to anything.
    const partAmbig = m.matchDeposit(dep(10000), DOCS, as('Custom Alloys'));
    const partRivals = partAmbig.proposals.filter((p) => p.kind === 'partial');
    ck('a part payment\'s ambiguity sentence talks about part payments',
       partRivals.length > 1
       && partRivals.every((p) => p.reasons.some((x) => /could each take this payment/.test(x)))
       && !partRivals.some((p) => p.reasons.some((x) => /add up to this exact amount/.test(x))),
       partRivals.map((p) => p.reasons.slice(-1)[0]).join(' ; '));
    ck('  and the sentence is not stamped on proposals it does not describe',
       partAmbig.proposals.filter((p) => p.kind === 'combined_partial')
           .every((p) => !p.reasons.some((x) => /could each take this payment/.test(x))),
       'a reason line that lies about its own row is worse than none');
}

// ── D — THE SAME INPUTS GIVE THE SAME SCREEN ──────────────────────────────
// Without a stable tiebreak, two equally-scored proposals swap places between
// runs and the list reorders under her while she is reading it.
{
    section('D — deterministic, whatever order the data arrives in');

    // ── IT HAS TO BE A CASE WITH SOMETHING TO REORDER ────────────────────
    // My first version shuffled DOCS against 47,310.22 — which has exactly
    // ONE proposal, so the sort had nothing to order and removing the id
    // tiebreak left every check green. A negative control caught it. The
    // ordering only matters where two proposals score the SAME, so the
    // fixture has to be a tie: four invoices in two equal-amount pairs.
    const tied = [
        inv('P-1', 'C', '2026-08-01', 9000),
        inv('P-2', 'C', '2026-08-01', 9000),
        inv('P-3', 'C', '2026-08-01', 6000),
        inv('P-4', 'C', '2026-08-01', 6000),
    ];
    const orders = [[0, 1, 2, 3], [3, 2, 1, 0], [2, 0, 3, 1], [1, 3, 0, 2]]
        .map((o) => o.map((i) => tied[i]));

    const sig = (list) => JSON.stringify(m.matchDeposit(dep(15000), list, as('C'))
        .proposals.map((p) => [ids(p), p.score]));
    const first = sig(orders[0]);
    ck('four different input orders produce one identical result',
       orders.every((s) => sig(s) === first), first.slice(0, 200));
    ck('  and the case really does have ties to order',
       m.matchDeposit(dep(15000), tied, as('C')).proposals.length > 1,
       'otherwise the sort is never exercised and this whole section is theatre');

    // The allocation AMOUNTS must be order-independent too, not just the
    // document ids — a stable list with different numbers in it is worse.
    const amts = (list) => JSON.stringify(m.matchDeposit(dep(15000), list, as('C'))
        .proposals.map((p) => p.allocations.map((a) => a.amount)));
    ck('  down to the amount allocated to each document',
       orders.every((s) => amts(s) === amts(orders[0])), amts(orders[0]).slice(0, 160));

    // WHERE THE DETERMINISM ACTUALLY COMES FROM. I assumed it was the final
    // proposals.sort() tiebreak and mutated that — it survived, because
    // subsetsSummingTo already sorts its items by balance THEN BY ID, so
    // solutions emerge in a fixed order whatever order they arrived in. The
    // outer tiebreak is belt-and-braces. Noting it here so the next person
    // does not delete the inner sort thinking the outer one covers it.
    const src = require('fs').readFileSync(path.join(ROOT, 'helpers/bankMatch.js'), 'utf8');
    ck('  and the search itself orders its items by id, not by arrival',
       /\.sort\(\(a, b\) => b\.bal - a\.bal \|\| String\(a\.doc\.id\)\.localeCompare\(String\(b\.doc\.id\)\)\)/.test(src),
       'this is the line the determinism rests on');
}

// ── D2 — THE FORWARD WINDOW IS NARROW ON PURPOSE ──────────────────────────
// An invoice dated AFTER the money arrived can only be a prepayment. A wide
// lookahead would let a January deposit pair with a September invoice she had
// not written yet — and because the amount would match, it would look right.
{
    section('D2 — a deposit cannot pay an invoice that does not exist yet');

    const future = [inv('F-1', 'C', '2026-09-20', 30000)];
    const longBefore = m.matchDeposit(dep(30000, '2026-01-15'), future, as('C'));
    ck('a deposit eight months before the invoice is NOT matched to it',
       longBefore.outcome === 'nothing_open', longBefore.outcome + ' ' + JSON.stringify((longBefore.proposals || []).map(ids)));

    const justBefore = m.matchDeposit(dep(30000, '2026-09-16'), future, as('C'));
    ck('  four days before it is allowed — that is a real prepayment',
       justBefore.outcome === 'proposed' && ids(top(justBefore)) === 'F-1', justBefore.outcome);
    ck('  and it is NAMED a prepayment rather than passed off as normal',
       top(justBefore).reasons.some((x) => /arrived before the invoice — a prepayment/.test(x)),
       top(justBefore).reasons.join(' | '));
    ck('  which costs it confidence, so she sees it',
       top(justBefore).score < 0.9, String(top(justBefore).score));
}

// ── E — THE SIGN CONVENTION ───────────────────────────────────────────────
// reconcile.js records that in Plaid a POSITIVE amount is money LEAVING. Get
// this backwards and every deposit reads as a withdrawal, nothing matches,
// and it looks like the matcher is broken rather than the sign.
{
    section('E — money in is the negative one');

    const rows = m.bankInflows([
        { transaction_id: 'in-1', date: '2026-09-05', amount: -47310.22, name: 'WIRE CUSTOM ALLOYS' },
        { transaction_id: 'out-1', date: '2026-09-05', amount: 12000, name: 'CHECK 1041' },
        { transaction_id: 'pend', date: '2026-09-06', amount: -5000, name: 'PENDING WIRE', pending: true },
        { transaction_id: 'zero', date: '2026-09-06', amount: 0, name: 'FEE REVERSAL' },
    ]);
    ck('a deposit is picked up', rows.length === 1 && rows[0].id === 'in-1', JSON.stringify(rows.map((r) => r.id)));
    ck('  with a positive amount for the matcher to use', rows[0].amount === 47310.22, String(rows[0].amount));
    ck('  a withdrawal is not treated as a deposit', !rows.some((r) => r.id === 'out-1'));
    ck('  a PENDING credit is ignored until it posts', !rows.some((r) => r.id === 'pend'),
       'a pending row can change amount or vanish; allocating against it would strand the allocation');
    ck('  and the descriptor survives for the party lookup',
       rows[0].descriptor === 'WIRE CUSTOM ALLOYS', rows[0].descriptor);
}

// ── F — THE OUTCOMES THAT ARE NOT MATCHES ─────────────────────────────────
// Each of these is a different action on her part, so they must be different
// outcomes rather than one "unmatched" bucket.
{
    section('F — four kinds of "no", and they are not the same no');

    const noParty = m.matchDeposit(dep(5000, '2026-09-05', { descriptor: 'ZELLE FROM WHOEVER' }), DOCS, { resolveParty: () => null });
    ck('an unrecognised descriptor is its own outcome', noParty.outcome === 'no_party', noParty.outcome);
    ck('  and it never guesses a customer', (noParty.proposals || []).length === 0,
       'nameMatch.js argues this exactly: a near-miss resolves to the wrong company');
    ck('  the note tells her the fix is one answer, once',
       /name it once/.test(noParty.note || ''), noParty.note);

    const tooMuch = m.matchDeposit(dep(60000), DOCS, as('Custom Alloys'));
    ck('a deposit bigger than everything owed says how much is unexplained',
       tooMuch.outcome === 'more_than_owed' && /12689\.78 of it belongs to something not in Jarvis/.test(tooMuch.note),
       tooMuch.note);

    const noneOpen = m.matchDeposit(dep(5000), DOCS, as('Nobody Owes Me'));
    ck('a customer with nothing open is distinguished from a failed search',
       noneOpen.outcome === 'nothing_open', noneOpen.outcome);

    const odd = [inv('X-1', 'C', '2026-08-01', 10000), inv('X-2', 'C', '2026-08-02', 20000)];
    const nope = m.matchDeposit(dep(45000), odd, as('C'));
    ck('money owed but no combination reaching it is yet another outcome',
       nope.outcome === 'more_than_owed' || nope.outcome === 'no_combination', nope.outcome);

    const mid = m.matchDeposit(dep(15000), odd, as('C'));
    ck('  and a figure between two invoices becomes a part payment, not a shrug',
       top(mid) && top(mid).kind === 'partial', mid.outcome);
}

// ── G — A SEARCH THAT GAVE UP MUST NOT LOOK LIKE ONE THAT FOUND NOTHING ───
// Those two call for completely different actions from her: one means "this
// deposit is not explained by your invoices", the other means "I stopped
// looking". Conflating them is how she ends up trusting a blank.
{
    section('G — truncation is reported, not hidden');

    const many = [];
    for (let i = 0; i < 40; i += 1) many.push(inv('M' + i, 'C', '2026-08-01', 1000 + i));
    // THE TARGET HAS TO BE REACHABLE. My first version asked for 999,999 out
    // of forty ~1,000 invoices: the suffix-sum prune kills that at the root
    // in a single node, so truncated was correctly false and the check was
    // testing the prune, not the budget. A target in the middle of the range
    // has combinatorially many near-misses and is what actually burns nodes.
    const r = m.subsetsSummingTo(many, 20_500.5, { tolerance: 0, maxDocs: 20, nodeCap: 500, maxSolutions: 8 });
    ck('a search past its node budget sets truncated', r.truncated === true, JSON.stringify(r).slice(0, 120));
    ck('  and a search that finishes does not',
       m.subsetsSummingTo(many.slice(0, 4), 2001, { tolerance: 0, maxDocs: 4, nodeCap: 500000, maxSolutions: 8 }).truncated === false);

    const stmt = m.matchStatement({
        deposits: [dep(47310.22)], openDocs: DOCS, resolveParty: () => 'Custom Alloys' });
    ck('the statement summary counts truncated rows separately',
       typeof stmt.counts.truncated === 'number', JSON.stringify(stmt.counts));
}

// ── H — THE STATEMENT SUMMARY ─────────────────────────────────────────────
// The number she looks at first. "Confident" must mean confident: not
// ambiguous, and above the threshold.
{
    section('H — what the top of the screen says');

    const stmt = m.matchStatement({
        deposits: [
            dep(22000, '2026-09-05'),            // clean single
            dep(10000, '2026-09-06'),            // ambiguous part payment
            dep(999999, '2026-09-07'),           // more than owed
        ].map((d, i) => ({ ...d, id: 'd' + i })),
        openDocs: DOCS,
        resolveParty: () => 'Custom Alloys',
    });
    ck('three deposits in, three rows out', stmt.counts.deposits === 3, JSON.stringify(stmt.counts));
    ck('  exactly one is confident', stmt.counts.confident === 1, JSON.stringify(stmt.counts));
    ck('  an ambiguous row is NEVER counted confident', stmt.counts.ambiguous === 1
       && stmt.rows.filter((r) => r.ambiguous).every((r) => r.proposals.every((p) => p.score <= 0.5)),
       JSON.stringify(stmt.counts));
    ck('  the money splits between confident and needs-you with nothing lost',
       Math.abs(stmt.totals.confident + stmt.totals.needs_you - stmt.totals.deposits) < 0.005,
       JSON.stringify(stmt.totals));
    ck('  and the confident total is the clean deposit, not the big one',
       stmt.totals.confident === 22000, String(stmt.totals.confident));
}

// ── I — IT WRITES NOTHING ─────────────────────────────────────────────────
{
    section('I — pure, and provably so');

    const before = JSON.stringify(DOCS);
    m.matchStatement({ deposits: [dep(47310.22), dep(10000)], openDocs: DOCS, resolveParty: () => 'Custom Alloys' });
    ck('matching does not touch the documents it was given', JSON.stringify(DOCS) === before);

    const src = require('fs').readFileSync(path.join(ROOT, 'helpers/bankMatch.js'), 'utf8');
    const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    ck('  it requires nothing — no store, no fs, no QuickBooks',
       !/\brequire\s*\(/.test(code), (code.match(/require\s*\([^)]*\)/g) || []).join(' '));
    ck('  and writes no file', !/writeFile|mutateJson|appendFile/.test(code));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
