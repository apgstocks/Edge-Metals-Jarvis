// ── helpers/bankMatch.js — one deposit, many invoices ─────────────────────
//
// Apsara, 2026-10-05: "There are times where we just combined the invoice
// amount for a customer and then paid… We have added two container amounts to
// supplier the amount sometimes. So we just paid advance and then balance will
// be paid for that container. My biggest problem is matching only."
//
// ── WHY helpers/reconcile.js DOES NOT ALREADY DO THIS ─────────────────────
// It matches one booked row to one bank row, cent-exact, inside four days.
// Every case she just described is outside that:
//
//   · one deposit paying several invoices      → one bank row, many documents
//   · one cheque covering two containers       → same shape, other direction
//   · advance now, balance later               → many bank rows, one document
//
// reconcile.js also excludes `load_kind === 'sale'` outright, so money coming
// IN was never matched at all. That file stays as it is — it answers a
// different and still-useful question ("what did Jarvis claim that the bank
// never saw") and its 41 checks are about that. This is the N:M engine beside
// it, not a replacement.
//
// ── IT IS SUBSET-SUM, NOT MACHINE LEARNING ───────────────────────────────
// She offered research papers and Python. The honest answer is that this is a
// bounded subset-sum followed by a scoring pass — deterministic, and that is
// the POINT rather than a limitation. At tax time the question is never "what
// did the model think", it is "why is this $47,310.22 deposit sitting against
// these three invoices", and an engine that cannot answer that in a sentence
// is useless in an audit. So every proposal carries its own `reasons`.
//
// The learning lives in two places, neither of them in the search: the
// per-party patterns that bias the SCORE, and the descriptor aliases that
// resolve a bank blob to a customer. Both are her confirmations, stored.
//
// ── NOTHING HERE WRITES, AND AMBIGUITY IS NOT A MATCH ────────────────────
// Pure functions, no I/O, no store, no QuickBooks. Two rules it must never
// break, both of which cost money if broken:
//
//   1. A wrong automatic match makes two records agree that never did, and
//      she finds out in April. So this RETURNS an opinion and a confidence;
//      applying it is a separate, logged, reversible act.
//   2. If several different combinations hit the same total, that is a
//      QUESTION, not a match. Picking the first one would be the single most
//      expensive thing this file could do. `ambiguous` is set, every rival is
//      returned, and confidence is capped below any auto-apply threshold.

const CENT = 0.005;
const round2 = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : null);
const num0 = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
const day = (d) => String(d || '').slice(0, 10);

const daysBetween = (a, b) => {
    const x = Date.parse(day(a) + 'T00:00:00Z');
    const y = Date.parse(day(b) + 'T00:00:00Z');
    if (!isFinite(x) || !isFinite(y)) return Infinity;
    return Math.round((y - x) / 86400000);
};

// ── DEFAULTS, AND WHY EACH NUMBER IS THAT NUMBER ─────────────────────────
// A customer pays an invoice up to a quarter after it is issued, so the
// backward window is wide. Forward is NARROW and separate: an invoice dated
// after the money arrived can only be a prepayment, which is rare and worth
// saying out loud rather than quietly allowing a 90-day lookahead to pair a
// deposit with an invoice she had not written yet.
const DEFAULTS = {
    daysBefore: 120,        // invoice this long before the deposit still counts
    daysAfter: 7,           // deposit arriving before the invoice: prepayment
    // Zero by default. A tolerance is a licence to call two different numbers
    // the same, and the default must be "no". It is raised ONLY per party,
    // from a confirmation she made — see patterns.feeAllowance.
    tolerance: 0,
    maxDocs: 6,             // beyond this, "combined" stops being explainable
    nodeCap: 200000,        // search budget; exceeding it is REPORTED, not hidden
    maxSolutions: 8,
};

// ── money IN, normalised ─────────────────────────────────────────────────
// reconcile.js records the convention: in Plaid a POSITIVE amount is money
// leaving the account. Inflows are therefore the negative rows, and the sign
// is flipped exactly once, here, so that no caller has to remember it. Get
// this backwards and every deposit looks like a withdrawal and nothing
// matches — which would read as "the matcher is broken" rather than as a
// sign error.
function bankInflows(txs = []) {
    return (txs || [])
        .filter((t) => t && !t.pending && num0(t.amount) < -CENT)
        .map((t) => ({
            id: t.transaction_id || t.id,
            date: day(t.date),
            amount: round2(-num0(t.amount)),
            descriptor: t.merchant_name || t.name || '',
            account_id: t.account_id || null,
        }))
        .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

// What is still owed on a document. `applied` is everything already allocated
// to it, which is what makes advance-then-balance work: the first payment
// reduces the balance and the second one matches the remainder instead of
// having to match the whole invoice again.
function openBalance(doc) {
    return round2(num0(doc && doc.amount) - num0(doc && doc.applied)) || 0;
}

// ── the bounded search ───────────────────────────────────────────────────
// Depth-first over amounts sorted descending, with three prunes. Without
// them this is 2^n and n is however many invoices a customer has open; with
// them the branch dies the moment it cannot reach the target.
//
// Returns { solutions, truncated }. `truncated` is surfaced all the way to
// the screen: a search that gave up must not look like a search that found
// nothing, because those two call for completely different actions.
function subsetsSummingTo(docs, target, { tolerance, maxDocs, nodeCap, maxSolutions }) {
    const items = docs
        .map((d) => ({ doc: d, bal: openBalance(d) }))
        .filter((x) => x.bal > CENT)
        .sort((a, b) => b.bal - a.bal || String(a.doc.id).localeCompare(String(b.doc.id)));

    // Suffix sums: the most that can still be added from position i onward.
    const suffix = new Array(items.length + 1).fill(0);
    for (let i = items.length - 1; i >= 0; i -= 1) suffix[i] = suffix[i + 1] + items[i].bal;

    const solutions = [];
    let nodes = 0;
    let truncated = false;

    const walk = (i, remaining, chosen) => {
        if (truncated || solutions.length >= maxSolutions) return;
        nodes += 1;
        if (nodes > nodeCap) { truncated = true; return; }

        if (Math.abs(remaining) <= tolerance + CENT && chosen.length) {
            solutions.push(chosen.slice());
            return;
        }
        if (i >= items.length) return;
        if (chosen.length >= maxDocs) return;
        // Cannot overshoot: every balance is positive, so once we are past the
        // target by more than tolerance there is no way back.
        if (remaining < -tolerance - CENT) return;
        // Cannot reach: everything left over is still not enough.
        if (remaining > suffix[i] + tolerance + CENT) return;

        chosen.push(items[i].doc);
        walk(i + 1, round2(remaining - items[i].bal), chosen);
        chosen.pop();
        walk(i + 1, remaining, chosen);
    };

    walk(0, round2(target), []);
    return { solutions, truncated, considered: items.length };
}

// ── scoring ──────────────────────────────────────────────────────────────
// Deliberately legible rather than clever. Each deduction has a sentence
// attached, and the sentence is what she reads — the number only decides the
// sort order and whether an auto-apply threshold is met.
function scoreProposal({ docs, deposit, used, patterns, partialDoc }) {
    const reasons = [];
    let score = 1;

    if (docs.length === 1 && !partialDoc) {
        reasons.push('one invoice, to the cent');
    } else if (!partialDoc) {
        reasons.push(`${docs.length} invoices add up to this deposit exactly`);
        // Combining is normal for some customers and unheard-of for others.
        // Learned, not assumed: an unknown party gets the penalty, and loses
        // it the first time she confirms one.
        const seen = patterns && patterns.combines;
        if (seen) reasons.push('this customer has paid combined before');
        else score -= 0.12;
        score -= Math.max(0, docs.length - 2) * 0.04;
    } else {
        reasons.push(docs.length > 1
            ? `${docs.length - 1} invoices in full, plus part of one more`
            : 'part payment — this does not clear the invoice');
        score -= docs.length > 1 ? 0.25 : 0.1;
        if (patterns && patterns.partPays) {
            reasons.push('this customer pays in parts');
            score += 0.08;
        }
    }

    if (used > CENT) {
        reasons.push(`${used.toFixed(2)} short of the invoice total`
            + (patterns && patterns.feeAllowance ? ' — within the fee this customer deducts' : ''));
        score -= patterns && patterns.feeAllowance ? 0.03 : 0.2;
    }

    // Date spread. An invoice from February and one from September paid
    // together is possible but unusual, and the gap is worth her eye.
    const gaps = docs.map((d) => daysBetween(d.date, deposit.date)).filter((g) => isFinite(g));
    if (gaps.length) {
        const oldest = Math.max(...gaps);
        const spread = oldest - Math.min(...gaps);
        if (oldest < 0) { reasons.push('the deposit arrived before the invoice — a prepayment'); score -= 0.15; }
        else reasons.push(`paid ${oldest} day${oldest === 1 ? '' : 's'} after the ${docs.length > 1 ? 'oldest ' : ''}invoice`);
        if (spread > 60) { reasons.push(`these invoices are ${spread} days apart`); score -= 0.08; }
        if (patterns && isFinite(patterns.typicalDays) && Math.abs(oldest - patterns.typicalDays) <= 7) {
            reasons.push(`about when this customer usually pays (~${patterns.typicalDays} days)`);
            score += 0.06;
        }
    }

    return { score: Math.max(0, Math.min(1, round2(score))), reasons };
}

// ── one deposit ──────────────────────────────────────────────────────────
// `resolveParty` is INJECTED rather than imported. The alias store is I/O and
// this file does none, but more importantly it means the test drives the
// resolution it wants without a store on disk, and the live caller can grow a
// better resolver later without touching the search.
function matchDeposit(deposit, openDocs, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const resolveParty = opts.resolveParty || (() => null);
    const patternsFor = opts.patternsFor || (() => null);

    const amount = round2(num0(deposit && deposit.amount)) || 0;
    const base = { deposit: { ...deposit, amount }, proposals: [], ambiguous: false, truncated: false };

    if (amount <= CENT) return { ...base, outcome: 'not_a_deposit', note: 'no money in this row' };

    const party = resolveParty(deposit.descriptor, deposit);
    if (!party) {
        // NEVER GUESSED. nameMatch.js argues this case explicitly: a near-miss
        // resolves to the wrong company, and here that would allocate real
        // money to the wrong customer's invoice. One question, answered once,
        // becomes an alias that matches exactly forever after.
        return { ...base, outcome: 'no_party',
            note: `nothing in the ledger is named "${String(deposit.descriptor || '').trim() || '(no description)'}" — name it once and every future deposit from them matches itself` };
    }

    const patterns = patternsFor(party) || null;
    const tolerance = Math.max(num0(o.tolerance), num0(patterns && patterns.feeAllowance));

    const candidates = (openDocs || []).filter((d) => {
        if (!d || d.party !== party) return false;
        if (openBalance(d) <= CENT) return false;
        const gap = daysBetween(d.date, deposit.date);   // + means invoice first
        if (!isFinite(gap)) return false;
        return gap <= o.daysBefore && gap >= -o.daysAfter;
    });

    if (!candidates.length) {
        return { ...base, party, outcome: 'nothing_open',
            note: `${party} has no unpaid invoice in the window — this may be a prepayment, a refund, or an invoice not in Jarvis yet` };
    }

    const totalOpen = round2(candidates.reduce((t, d) => t + openBalance(d), 0));
    if (amount > totalOpen + tolerance + CENT) {
        return { ...base, party, outcome: 'more_than_owed',
            note: `${party} owes ${totalOpen.toFixed(2)} and this deposit is ${amount.toFixed(2)} — ${round2(amount - totalOpen).toFixed(2)} of it belongs to something not in Jarvis`,
            open_total: totalOpen };
    }

    // ── TIER 1: exact, in full, one or many ──────────────────────────────
    // `tolerance` is the PER-PARTY one computed above, not o.tolerance. My
    // first version passed `o` straight through, so a fee allowance she had
    // confirmed was worked out here and then never reached the search — the
    // same "computed and never forwarded" shape as a route that drops a new
    // field. Caught by the negative control in tests/bank-match.js B.
    const search = { ...o, tolerance };
    const exact = subsetsSummingTo(candidates, amount, search);
    const proposals = [];
    for (const docs of exact.solutions) {
        const sum = round2(docs.reduce((t, d) => t + openBalance(d), 0));
        const { score, reasons } = scoreProposal({
            docs, deposit, used: Math.abs(round2(amount - sum)), patterns, partialDoc: null });
        proposals.push({
            kind: docs.length === 1 ? 'exact' : 'combined',
            allocations: docs.map((d) => ({ doc_id: d.id, label: d.label || d.id, amount: openBalance(d), clears: true })),
            leftover: 0, score, reasons,
        });
    }

    // ── TIER 2: a part payment ───────────────────────────────────────────
    // Only reached when nothing adds up in full, because an exact explanation
    // always beats a partial one. This is the advance-then-balance case: the
    // deposit is smaller than what is owed, so it clears zero or more
    // invoices and leaves one standing with a reduced balance.
    if (!proposals.length) {
        for (const d of candidates) {
            const bal = openBalance(d);
            if (amount >= bal - tolerance - CENT) continue;      // would clear it; tier 1's job
            const { score, reasons } = scoreProposal({
                docs: [d], deposit, used: 0, patterns, partialDoc: d });
            proposals.push({
                kind: 'partial',
                allocations: [{ doc_id: d.id, label: d.label || d.id, amount, clears: false,
                    leaves: round2(bal - amount) }],
                leftover: 0, score, reasons: reasons.concat(
                    `${round2(bal - amount).toFixed(2)} would still be owed on it`),
            });
        }

        // Full on some, part of one more. Real — two containers cleared and a
        // third part-paid — but it multiplies the ways to be wrong, so it is
        // scored below everything above and never reached when a clean
        // explanation exists.
        for (const tail of candidates) {
            const rest = candidates.filter((d) => d.id !== tail.id);
            if (!rest.length) continue;
            const tailBal = openBalance(tail);
            const found = subsetsSummingTo(rest, amount, { ...search, tolerance: tailBal, maxSolutions: 3 });
            for (const docs of found.solutions) {
                const full = round2(docs.reduce((t, d) => t + openBalance(d), 0));
                const part = round2(amount - full);
                if (part <= CENT || part >= tailBal - CENT) continue;
                const { score, reasons } = scoreProposal({
                    docs: docs.concat([tail]), deposit, used: 0, patterns, partialDoc: tail });
                proposals.push({
                    kind: 'combined_partial',
                    allocations: docs.map((d) => ({ doc_id: d.id, label: d.label || d.id, amount: openBalance(d), clears: true }))
                        .concat([{ doc_id: tail.id, label: tail.label || tail.id, amount: part, clears: false,
                            leaves: round2(tailBal - part) }]),
                    leftover: 0, score: round2(score - 0.1), reasons,
                });
            }
            if (found.truncated) base.truncated = true;
        }
    }

    // Stable order: best score, then fewest documents, then the document ids,
    // so the same inputs always render the same list. Without the id tiebreak
    // two equally-scored proposals swap places between runs and the screen
    // changes under her while she is reading it.
    const key = (p) => p.allocations.map((a) => a.doc_id).join(',');
    proposals.sort((a, b) => b.score - a.score
        || a.allocations.length - b.allocations.length
        || key(a).localeCompare(key(b)));

    // ── AMBIGUITY ────────────────────────────────────────────────────────
    // Two different sets of invoices that both add up to the deposit. There
    // is no information anywhere in the data that distinguishes them, so the
    // only correct behaviour is to ask. Capping the confidence is what stops
    // an auto-apply threshold from choosing for her.
    const rivals = proposals.filter((p) => p.kind === (proposals[0] || {}).kind
        && Math.abs(p.score - (proposals[0] || {}).score) < 0.001);
    const ambiguous = rivals.length > 1;
    if (ambiguous) {
        // ── THE SENTENCE HAS TO BE TRUE OF THE PROPOSAL IT IS ON ─────────
        // My first version said "N different sets of invoices add up to this
        // exact amount" on every proposal, including the part payments —
        // where nothing adds up to anything, that is the whole point. A
        // reason line that is wrong about the row it sits under is worse than
        // no reason line: it is the thing she reads to decide, and once she
        // catches it lying she stops reading all of them.
        const partish = (rivals[0] || {}).kind === 'partial' || (rivals[0] || {}).kind === 'combined_partial';
        const sentence = partish
            ? `${rivals.length} of her open invoices could each take this payment — nothing in the data says which, so this one needs you`
            : `${rivals.length} different sets of invoices add up to this exact amount — nothing in the data says which, so this one needs you`;
        const rival = new Set(rivals);
        for (const p of proposals) {
            // Capped on ALL of them: if the best explanation is a coin flip,
            // no WORSE explanation should slip past an auto-apply threshold
            // either. But the sentence goes only on the ones it describes.
            p.score = Math.min(p.score, 0.5);
            if (rival.has(p)) p.reasons = p.reasons.concat(sentence);
        }
    }

    return {
        ...base,
        party,
        outcome: proposals.length ? 'proposed' : 'no_combination',
        proposals,
        ambiguous,
        truncated: base.truncated || exact.truncated,
        open_total: totalOpen,
        considered: candidates.length,
        note: proposals.length ? null
            : `${party} owes ${totalOpen.toFixed(2)} across ${candidates.length} invoices and no combination of them makes ${amount.toFixed(2)}`,
    };
}

// ── the whole statement ──────────────────────────────────────────────────
// Deposits are processed newest first, and a document consumed by an ACCEPTED
// proposal is not offered again. Nothing is accepted here — this only reports
// — so `openDocs` is never mutated; the caller re-runs after each
// confirmation, which keeps the engine stateless and means an undo is just
// another re-run.
function matchStatement({ deposits = [], openDocs = [], ...opts } = {}) {
    const rows = deposits.map((d) => matchDeposit(d, openDocs, opts));
    const count = (f) => rows.filter(f).length;
    const sum = (f) => round2(rows.filter(f).reduce((t, r) => t + num0(r.deposit.amount), 0)) || 0;
    const confident = (r) => r.outcome === 'proposed' && !r.ambiguous
        && r.proposals.length && r.proposals[0].score >= 0.8;
    return {
        rows,
        totals: {
            deposits: round2(rows.reduce((t, r) => t + num0(r.deposit.amount), 0)) || 0,
            confident: sum(confident),
            needs_you: sum((r) => !confident(r)),
        },
        counts: {
            deposits: rows.length,
            confident: count(confident),
            ambiguous: count((r) => r.ambiguous),
            no_party: count((r) => r.outcome === 'no_party'),
            more_than_owed: count((r) => r.outcome === 'more_than_owed'),
            nothing_open: count((r) => r.outcome === 'nothing_open'),
            no_combination: count((r) => r.outcome === 'no_combination'),
            truncated: count((r) => r.truncated),
        },
    };
}

module.exports = {
    bankInflows, openBalance, subsetsSummingTo, matchDeposit, matchStatement,
    DEFAULTS, daysBetween,
};
