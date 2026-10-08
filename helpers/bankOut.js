// ── helpers/bankOut.js — the money that LEFT, matched to what it paid ─────
//
// Apsara, 2026-10-08: "...whether payment received or sent ever again."
//
// bankMatch.js has bankInflows() and nothing else, and dashboard/bank-match
// .html says "Confirm — record this receipt". So until today only money
// ARRIVING was ever matched. Everything she pays — suppliers, the local
// carriers, truckers, expenses, bank fees — reached the bank feed and sat
// there with nothing to compare it to.
//
// ── WHY THIS IS NOT A COPY OF bankMatch.js WITH THE SIGN FLIPPED ─────────
// The two jobs look symmetric and are not, and getting that wrong would
// produce a plausible, wrong screen:
//
//   A DEPOSIT is unallocated money. Matching it DECIDES something — which
//   invoices it pays, and therefore what a customer still owes. That is why
//   bankMatch.js refuses to guess a party, caps confidence on ambiguity, and
//   leaves applying as a separate act.
//
//   A WITHDRAWAL is already recorded. She told Jarvis she paid Inesh, so
//   there is a journal line crediting the bank. Matching the bank row to it
//   DECIDES NOTHING about any balance — it only confirms the money really
//   left. Nothing is allocated, no payable moves.
//
// That difference is the whole licence for auto-ticking (her decision
// below): an auto-tick here cannot misallocate money, because there is no
// allocation. The worst a wrong tick can do is hide a row from the worklist,
// which is reversible and logged. A wrong auto-allocation on the inflow side
// would change what a customer owes, which is why nothing here is reused
// there.
//
// ── WHAT "WHAT JARVIS SAYS IT PAID" MEANS, EXACTLY ──────────────────────
// The journal, not the stores. helpers/booksBuild.js already enumerates
// every store that moves money — bill payments, carrier invoice payments,
// trucker bills, expenses, yard loads — and postings.js turns each into a
// line crediting 1010 or 1020. Reading the journal instead of six stores
// means a store added later is matched the day it is posted, with no second
// enumeration to keep in step. The first draft of this file read the stores
// directly and would have silently ignored carrier payments, which had only
// reached the journal that morning.
//
// Nothing here writes. Pure functions; the tick itself is bankTicks.js.

const BM = require('./bankMatch');

const CENT = 0.005;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
const day = (d) => String(d || '').slice(0, 10);

const DEFAULTS = {
    // Both directions, and NARROWER than the inflow matcher's 120 days.
    // A recorded payment and its bank row are days apart, not months: a
    // cheque takes a week to clear, a wire the same day. The inflow side
    // needs 120 days because an INVOICE can be old; a payment cannot be,
    // because she records it when she makes it. A wide window here would
    // pair this month's wire with last quarter's identical one.
    daysEither: 10,
    tolerance: 0,            // see bankMatch.js: a tolerance is a licence to
                             // call two different numbers the same
    maxDocs: 6,
    nodeCap: 200000,
    maxSolutions: 8,
};

// ── money OUT, normalised ────────────────────────────────────────────────
// Takes bankLedger rows (QuickBooks' shape: spent/received/direction), NOT
// raw Plaid. bankMatchRoutes.js has the note on why: an earlier version
// handed raw JSON to bankInflows(), which expects Plaid's signed amount, and
// the shapes silently disagree.
function withdrawals(rows = []) {
    return (rows || [])
        // ── AND NOT ALREADY TICKED OFF ──────────────────────────────────
        // `matched` is set by bankLedger.markMatched when she presses Match
        // or the overnight auto-tick does. Without this the row comes
        // straight back next time the queue is built, the button looks
        // broken, and she presses it again — which is how a feature gets
        // abandoned on its first morning.
        //
        // Same shape as `excluded` above and for the same reason: a row she
        // has dealt with must leave the worklist, while still being
        // COUNTED and reversible. Silenced is never hidden.
        .filter((r) => r && !r.pending && !r.excluded && !r.matched && num(r.spent) > CENT)
        .map((r) => ({
            id: r.id,
            date: day(r.date),
            amount: r2(num(r.spent)),
            descriptor: r.party || r.desc || '',
            bank: r.bank || null,
            company: r.company || null,
        }))
        .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

// ── WHAT JARVIS SAYS LEFT THIS BANK ──────────────────────────────────────
// Journal lines CREDITING the bank account. A credit to a bank asset is
// money leaving; see bankReconcile.js on the one place that sign is flipped.
//
// `key` has to survive a rebuild, because the journal is derived and is
// rebuilt on every request — so a tick recorded against an array index would
// point at a different payment tomorrow. The key is therefore made of what
// the payment IS: store, row id, account, date, amount.
//
// Two payments of the same amount, on the same day, against the same source
// row collide. That is not a bug being hidden: they are genuinely
// indistinguishable in the data, and `ambiguousKey` says so out loud rather
// than letting a tick land on whichever one came first.
function keyOf(l) {
    const s = l.source || {};
    return [s.store || l.kind || '?', s.id || '?', l.account, day(l.date), r2(num(l.credit)).toFixed(2)].join('|');
}

function payments(lines = [], { code, from, to } = {}) {
    const mine = (Array.isArray(lines) ? lines : []).filter((l) => l
        && l.account === code
        && num(l.credit) > CENT
        && (!from || day(l.date) >= day(from))
        && (!to || day(l.date) <= day(to)));

    const seen = new Map();
    const out = mine.map((l) => {
        const key = keyOf(l);
        seen.set(key, (seen.get(key) || 0) + 1);
        return {
            key,
            // bankMatch.subsetsSummingTo reads `amount` and `applied` through
            // openBalance(), so the shape has to be a "doc". applied is 0:
            // a payment is paid in full or it is not this payment.
            id: key, amount: r2(num(l.credit)), applied: 0,
            date: day(l.date),
            party: l.party || null,
            kind: l.kind, entity: l.entity,
            memo: l.memo || null,
            source: l.source || null,
            label: [l.kind, l.party].filter(Boolean).join(' · ') || l.kind,
        };
    });
    for (const p of out) if (seen.get(p.key) > 1) p.ambiguousKey = true;
    return out;
}

// ── one withdrawal ───────────────────────────────────────────────────────
// Outcomes, and what each one means for her:
//
//   matched           exactly one recorded payment, same cent, in the window
//                     → nothing to do. Eligible for the auto-tick.
//   combined          one bank row covering several recorded payments
//                     → almost certainly right, but she presses it
//   ambiguous         several different combinations hit the same total
//                     → a QUESTION, never a match
//   not_recorded      the bank paid something Jarvis has no record of
//                     → the half that actually costs her: a payment made
//                       outside Jarvis, or a fee nobody booked
//   more_than_recorded the row is bigger than everything recorded nearby
//
// bankMatch.js's rule on ambiguity is kept verbatim in spirit: picking the
// first of several equal-summing combinations would be the single most
// expensive thing this file could do, so every rival is returned.
function matchWithdrawal(row, recorded, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const amount = r2(num(row && row.amount)) || 0;
    const base = { row: { ...row, amount }, proposals: [], ambiguous: false, truncated: false };

    if (amount <= CENT) return { ...base, outcome: 'not_a_withdrawal', note: 'no money left in this row' };

    const candidates = (recorded || []).filter((p) => {
        if (!p || p.amount <= CENT) return false;
        const gap = BM.daysBetween(p.date, row.date);
        return isFinite(gap) && Math.abs(gap) <= o.daysEither;
    });

    if (!candidates.length) {
        return { ...base, outcome: 'not_recorded',
            note: `${amount.toFixed(2)} left the bank on ${row.date} and Jarvis has no payment `
                + `recorded within ${o.daysEither} days — either it was paid outside Jarvis, or it `
                + 'is a fee nobody has booked' };
    }

    const found = BM.subsetsSummingTo(candidates, amount, o);
    if (!found.solutions.length) {
        const near = candidates.reduce((t, p) => t + p.amount, 0);
        return { ...base, outcome: near + CENT < amount ? 'more_than_recorded' : 'no_combination',
            truncated: !!found.truncated,
            note: found.truncated
                ? 'the search gave up before finding a combination — too many payments of similar '
                  + 'size in the window to explain this row automatically'
                : `nothing recorded nearby adds up to ${amount.toFixed(2)}`,
            nearby: candidates.length };
    }

    // ── AMBIGUITY IS A QUESTION ──────────────────────────────────────────
    // Several DIFFERENT sets summing to the same figure. Only a single
    // one-payment solution is allowed to be called matched, and that is also
    // the only shape the auto-tick accepts.
    const sets = found.solutions;
    const ambiguous = sets.length > 1;
    const proposals = sets.map((docs) => ({
        payments: docs.map((d) => ({ key: d.key, amount: d.amount, date: d.date,
            kind: d.kind, party: d.party, entity: d.entity, source: d.source,
            ambiguousKey: !!d.ambiguousKey })),
        total: r2(docs.reduce((t, d) => t + d.amount, 0)),
        reasons: [
            docs.length === 1 ? 'one recorded payment, to the cent'
                              : `${docs.length} recorded payments adding up to the cent`,
            `${Math.abs(BM.daysBetween(docs[0].date, row.date))} day(s) between the record and the bank`,
        ].concat(docs.some((d) => d.ambiguousKey)
            ? ['one of these is indistinguishable from another payment of the same amount on the same day']
            : []),
    }));

    const single = !ambiguous && sets[0].length === 1;
    return {
        ...base,
        outcome: ambiguous ? 'ambiguous' : (single ? 'matched' : 'combined'),
        ambiguous,
        truncated: !!found.truncated,
        proposals,
        note: ambiguous
            ? `${sets.length} different combinations each come to ${amount.toFixed(2)} — Jarvis will not `
              + 'pick one, because picking wrong hides a payment that never happened'
            : null,
    };
}

// ── THE AUTO-TICK GATE ───────────────────────────────────────────────────
// Apsara, 2026-10-08, asked whether Jarvis should tick off certain matches
// itself or wait for her: "Auto-tick exact single matches". Her words bound
// this function, and every clause below is one of them:
//
//   exact      the amounts agree to the cent — no tolerance, ever, even a
//              per-party one she confirmed for the inflow side
//   single     ONE recorded payment, not a combination. A combined match is
//              almost certainly right and still waits for her, because the
//              combination is an inference and this is not
//   match      inside the window, and not ambiguous
//
// Plus two refusals that are mine, and said so: a payment whose key is
// indistinguishable from another is not auto-ticked, because the tick would
// land on an arbitrary one of them; and a truncated search is not a match at
// all — bankMatch.js's note applies, a search that gave up must never look
// like a search that found one thing.
//
// Kept as a named function with its own checks so loosening it cannot happen
// quietly in a diff that reads like a tidy-up.
function autoTickable(result) {
    if (!result || result.outcome !== 'matched') return false;
    if (result.ambiguous || result.truncated) return false;
    const p = (result.proposals || [])[0];
    if (!p || p.payments.length !== 1) return false;
    if (p.payments[0].ambiguousKey) return false;
    return Math.abs(r2(p.total - result.row.amount)) < CENT;
}

// ── every withdrawal on one bank, in one pass ───────────────────────────
// Claims are CONSUMED across the sweep. Two identical wires on consecutive
// days and one recorded payment: the first is matched, the second is
// not_recorded. Without that, both would report matched and the unrecorded
// one would appear on no screen — the same bug bankReconcile.js's consumed
// claims exist to stop, and the reason both files do it rather than one.
function sweep({ rows = [], lines = [], code, from = null, to = null, ...opts } = {}) {
    const pool = payments(lines, { code, from, to });
    // Rows for THIS bank only. 1010 is Bank of America and 1020 is Chase;
    // offering a Chase withdrawal against a payment the books say left BofA
    // would be the same class of error as matching a deposit against the
    // other company's invoices, which bankLedger.js carries `company` to
    // prevent. The bank's own name comes off the chart, so a rename in one
    // place cannot leave the two disagreeing.
    const wantBank = ((require('./bankReconcile').bankAccounts()
        .find((a) => a.code === code)) || {}).bank || null;
    const mineRows = (Array.isArray(rows) ? rows : []).filter((r) => r
        && (!wantBank || String(r.bank || '').toLowerCase() === String(wantBank).toLowerCase())
        && (!from || day(r.date) >= day(from))
        && (!to || day(r.date) <= day(to)));

    const taken = new Set();
    const out = [];
    for (const row of withdrawals(mineRows).reverse()) {
        const free = pool.filter((p) => !taken.has(p.key));
        const res = matchWithdrawal(row, free, opts);
        if (res.outcome === 'matched' || res.outcome === 'combined') {
            for (const p of res.proposals[0].payments) taken.add(p.key);
        }
        out.push({ ...res, auto: autoTickable(res) });
    }
    // Oldest first inside the sweep so claims go to the earliest row that
    // can use them; newest first on the way out, which is how she reads.
    out.reverse();
    return {
        code: code || null,
        results: out,
        recorded: pool.length,
        unclaimed: pool.filter((p) => !taken.has(p.key)).map((p) => ({
            key: p.key, date: p.date, amount: p.amount, kind: p.kind,
            party: p.party, entity: p.entity, source: p.source,
        })),
        counts: out.reduce((c, r) => { c[r.outcome] = (c[r.outcome] || 0) + 1; return c; }, {}),
        autoCount: out.filter((r) => r.auto).length,
    };
}

module.exports = { withdrawals, payments, keyOf, matchWithdrawal, autoTickable, sweep, DEFAULTS, CENT };
