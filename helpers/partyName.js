// ── helpers/partyName.js — is this bank line about this company? ──────────
//
// Lifted VERBATIM out of scripts/qb-bank-match.js on 2026-10-05 so the Plaid
// matcher and the QuickBooks CSV path answer this question the same way. Not
// rewritten, not improved, not re-tuned: the behaviour here was paid for with
// real money and the extraction is required to change nothing.
//
// ── WHY IT IS THIS AND NOT AN EDIT DISTANCE ──────────────────────────────
// Half of her suppliers share the same words. CORES, METALS, RECYCLING,
// TRADING, AUTO, SCRAP — a similarity score sees "Inesh Cores Chapin" and
// "Calderon Cores" as close relatives, and on 2026-09-23 that kind of
// reasoning matched a $60,000 wire to the wrong supplier on the real bank
// export. So a name only counts when a word that is THEIRS ALONE appears.
//
// And when nothing distinctive is left — "5 Core Trading Inc" is four
// generic words and a digit — the only thing that counts is an outright
// containment of the whole squashed name. Never a shared trade word.
//
// ── THIS REPLACES A WORSE GUARD OF MINE ──────────────────────────────────
// helpers/bankLearn.js had its own protection against "AJ" matching "AJAX
// TRADING LLC": a minimum name length. That is a guess, and it fails exactly
// where it matters — "Edge Scrap" is ten characters and both of its words
// are near-generic, so a length threshold would have waved it through
// anything. This file gets the same case right for the right reason, and has
// the scars to prove it.

// Words every scrap company shares, so a hit on one of them means nothing.
const GENERIC = new Set(['CORE', 'CORES', 'METAL', 'METALS', 'RECYCLING', 'RECYCLERS', 'TRADING', 'TRADE', 'AUTO', 'AUTOS', 'SCRAP', 'JUNK',
    'TRANSPORT', 'TRUCKING', 'LOGISTICS', 'EXPORT', 'IMPORT', 'COMPANY', 'GROUP', 'ENTERPRISE', 'ENTERPRISES', 'INDUSTRIES', 'INDUSTRIAL',
    'INC', 'LLC', 'LTD', 'CORP', 'THE', 'AND', 'YARD', 'SALES', 'SERVICES', 'SOLUTIONS', 'WIRE', 'TYPE', 'TRANSFER', 'BANK', 'AMERICA']);

// 3 letters, not 4: "FMC Metal" is FMC plus a word every supplier shares.
const words = (v) => String(v || '').toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !GENERIC.has(w));
const squash = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const nameHit = (desc, party) => {
    const d = ' ' + String(desc || '').toUpperCase().replace(/[^A-Z ]/g, ' ') + ' ';
    const own = words(party);
    if (own.length) return own.some((w) => d.includes(' ' + w) || d.includes(w + ' '));
    // nothing distinctive left ("5 Core Trading Inc") — only an outright
    // containment of the whole name counts, never a shared trade word.
    const a = squash(party), b = squash(desc);
    return a.length > 4 && b.includes(a);
};

// Symmetric form. A bank descriptor may contain the party, or a terse
// descriptor may itself be contained in a longer recorded name, and
// qb-bank-match.js calls it both ways round at every site. Named here so no
// caller has to remember to.
const eitherWay = (a, b) => nameHit(a, b) || nameHit(b, a);

module.exports = { GENERIC, words, squash, nameHit, eitherWay };
