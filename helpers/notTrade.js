// ── helpers/notTrade.js — this bank line is not a customer or a supplier ──
//
// Lifted VERBATIM out of scripts/qb-bank-match.js on 2026-10-07, for the same
// reason helpers/partyName.js was lifted out of it on 2026-10-05: the Plaid
// matcher and the QuickBooks CSV path must answer this question the same way.
// Not rewritten, not improved, not re-tuned — the patterns below were tuned
// against her real bank export and tests/bank-notTrade.js section A proves the
// extraction changed nothing for 437 lines of it.
//
// ── WHY THE PLAID MATCHER NEEDED THIS, AND URGENTLY ──────────────────────
// helpers/bankMatch.js has one outcome for a line it cannot name:
//
//     no_party — "nothing in the ledger is named "VERIZON WIRELESS" — name it
//     once and every future deposit from them matches itself"
//
// For a customer whose descriptor Jarvis has not learned yet, that sentence is
// exactly right and is the whole design (nameMatch.js argues it at length: one
// question, answered once, becomes an alias that matches forever).
//
// For a bank charge it is an invitation to alias a bank fee to a customer. And
// most of the feed is this: on the CSV path, most of 661 pending lines were
// never trade at all — bank fees, the phone bill, the IRS, loan repayments,
// transfers between her own accounts. Asking her to name each one is not a
// small annoyance; it is a review queue made mostly of questions with no right
// answer, which is how a queue stops being read.
//
// ── IT SETS ASIDE, IT NEVER CATEGORISES ──────────────────────────────────
// A line this file claims is "already categorized as bank charge" is removed
// from the matching problem and nothing else. It does not post, book, or
// decide an account — the accountant's work stays the accountant's. The reason
// travels with the verdict so the screen can say WHY a line was set aside
// rather than leaving it as a silent absence.
//
// ── WHY TWO PATTERNS AND NOT ONE ─────────────────────────────────────────
// CATEGORY is what QuickBooks or Plaid already decided about the line, which
// is strong evidence. DESC is her own vendors, matched on the raw text, which
// is weaker and deliberately short: every name on it earns its place by having
// appeared in her feed. A long speculative list here would set aside a real
// customer payment one day, and a set-aside line is one nobody looks at.

const NOT_TRADE_CATEGORY = /(bank charge|loan|tax|office|travel|phone|insurance|payroll|meals|fuel|rent|utilit|interest|owner|equit)/i;
const NOT_TRADE_DESC = /(transfer fee|analysis fee|service charge|verizon|arco|internal revenue|ondeck|acura|payroll|interest)/i;

// Returns a REASON string when the line is not trade, or null when it is.
// Null-means-trade rather than a boolean, because the caller has to be able to
// tell her which rule set a line aside; "false" tells her nothing.
//
// ── THE FIELD NAMES DIFFER BETWEEN THE TWO CALLERS ───────────────────────
// The CSV path calls them `category` and `desc`; a Plaid transaction carries
// `merchant_name` / `name` and an array of categories. Accepting both here is
// what keeps ONE list of patterns — the alternative is each caller mapping its
// own shape and the two slowly disagreeing about what "not trade" means, which
// is the drift this extraction exists to prevent.
function notTrade(line) {
    if (!line || typeof line !== 'object') return null;

    // Plaid sends `personal_finance_category.primary` and a legacy `category`
    // ARRAY; the CSV path sends a single string. Flattened rather than
    // branched, so a shape nobody anticipated still gets looked at instead of
    // silently skipping the category test.
    const cats = []
        .concat(line.category || [])
        .concat(line.personal_finance_category
            ? [line.personal_finance_category.primary, line.personal_finance_category.detailed]
            : [])
        .filter(Boolean)
        .join(' ');
    if (cats && NOT_TRADE_CATEGORY.test(cats)) {
        // The whole category, not a truncation. A first version sliced this to
        // four words to keep Plaid's two-part category readable, which meant a
        // five-word QuickBooks category came back with a DIFFERENT sentence
        // than the CSV path used to produce — a silent wording change hiding
        // inside an extraction that promised to change nothing.
        return `already categorized as ${cats}`;
    }

    const desc = [line.desc, line.descriptor, line.merchant_name, line.name]
        .filter(Boolean).join(' ');
    if (desc && NOT_TRADE_DESC.test(desc)) return 'not a supplier or customer payment';

    return null;
}

module.exports = { notTrade, NOT_TRADE_CATEGORY, NOT_TRADE_DESC };
