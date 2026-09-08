// ── helpers/banks.js — which account the money moved through ─────────────
// Apsara, 2026-09-09: "I want to create an option for zelle,wire --> options
// like BofA, Chase Bank, Others. when they select others a text box should
// appear in mobile app and website."
//
// A Zelle or a Wire leaves a named account. Until now Jarvis recorded that
// money moved and not where from, so reconciling against a statement meant
// reading every row and remembering. helpers/bankMatch.js already matches
// recorded payments against real bank rows; it had nothing to match ON.
//
// WHY THIS IS A MODULE AND NOT THREE DROPDOWNS
// --------------------------------------------
// The same list has to appear in the pay form on the website, the pay form in
// the mobile app, the trucker-bill form in both, the spend report filter, and
// the server-side validation that refuses anything else. That is six copies
// of one list, and helpers/payments.js already has a comment about exactly
// this — "exported so the API, both clients and the PDF all read the same
// list rather than three drifting copies of a dropdown". Six copies drift
// faster than three.
//
// CASH AND CHEQUE HAVE NO BANK, AND SAYING SO MATTERS
// ---------------------------------------------------
// Cash comes out of the petty cash box; a cheque is written against an
// account but she does not track which, and inventing a value for either
// would put a fact on the ledger that nobody recorded. So `bank` is REFUSED on
// those modes — not merely ignored, because a silently dropped field is how a
// form comes to look like it saved something it did not.
//
// On Zelle and Wire it is required FROM THE FORMS and optional from callers
// that cannot ask — see resolveForMode's note on `required`, which is the one
// piece of this design worth reading before changing anything.

const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

// The two she named, plus the escape hatch. Her choice, 2026-09-09: "Fixed
// three, but Others text is remembered" — so this list stays short and the
// remembered ones (below) grow on their own.
const BANKS = ['BofA', 'Chase Bank'];

// Not a bank — the label on the option that reveals the text box. Exported so
// the clients and the server agree on the exact string; a client sending
// "Other" against a server expecting "Others" is a silent 400 she would read
// as "the button is broken".
const OTHER = 'Others';

// Which payment modes actually have a bank behind them.
const MODES_WITH_BANK = ['Zelle', 'Wire'];

function needsBank(mode) {
    const m = String(mode || '').trim().toLowerCase();
    return MODES_WITH_BANK.some((x) => x.toLowerCase() === m);
}

// ── WHAT SHE TYPED UNDER "OTHERS", KEPT ──────────────────────────────────
// Her choice over a Banks screen: "Fixed three, but Others text is
// remembered". So the first Wells Fargo wire is typed once and offered ever
// after, and she never has to ask me to add a bank or wait for a deploy.
//
// Stored rather than derived from the payments themselves, deliberately. A
// derived list would silently lose a bank the day its last payment is deleted
// — and the ones she uses rarely are exactly the ones she would have to
// retype, which is the case this exists to fix.
function learned() {
    const raw = loadJson(cfg.BANKS_FILE, []);
    return Array.isArray(raw) ? raw.filter((b) => typeof b === 'string' && b.trim()) : [];
}

// Everything the forms should offer, in the order they should appear: the
// fixed two, then whatever she has typed, then Others last so the escape
// hatch stays at the bottom where escape hatches belong.
function options() {
    const seen = new Set(BANKS.map((b) => b.toLowerCase()));
    const extra = [];
    for (const b of learned()) {
        if (seen.has(b.toLowerCase())) continue;
        seen.add(b.toLowerCase());
        extra.push(b);
    }
    return BANKS.concat(extra);
}

// Case-insensitive, returning the CANONICAL spelling — so "bofa", "BOFA" and
// "BofA" are one bank in the report rather than three columns. The same
// reasoning as normalizeMethod in helpers/expenses.js.
function canonical(name) {
    const q = String(name || '').trim();
    if (!q) return null;
    return options().find((b) => b.toLowerCase() === q.toLowerCase()) || null;
}

// Records a bank she typed under Others. Returns the canonical spelling.
//
// FIRST SPELLING WINS. If she writes "wells fargo" today and "Wells Fargo"
// tomorrow, both resolve to the first — otherwise the report grows a second
// column for the same account, which is worse than either spelling.
async function remember(name) {
    const q = String(name || '').trim();
    if (!q) return null;
    const already = canonical(q);
    if (already) return already;
    // Length-capped and stripped of newlines: this string is rendered into
    // both clients and the PDF, and a pasted essay would break all three.
    const clean = q.replace(/\s+/g, ' ').slice(0, 40);
    await mutateJson(cfg.BANKS_FILE, [], (all) => {
        const list = Array.isArray(all) ? all : [];
        if (!list.some((b) => String(b).toLowerCase() === clean.toLowerCase())) list.push(clean);
        return list;
    });
    return clean;
}

// ── THE ONE VALIDATOR ────────────────────────────────────────────────────
// Called before every payment write, by both forms and by the yard assistant,
// so none of them can drift from the others and none depends on the client
// having behaved. Returns the value to store; throws with a sentence she can
// act on.
//
// ── WHO HAS TO ANSWER, AND WHO CANNOT BE ASKED ───────────────────────────
// `required` is explicit at every call site rather than defaulting either way,
// because the two callers are genuinely different and a default would hide
// that:
//
//   THE FORMS (both clients) pass required:true. She is standing in front of a
//   dropdown; refusing is the only way the gap ever gets closed, and she can
//   answer in one tap.
//
//   THE YARD ASSISTANT (helpers/tools.js) does not. It records a payment from
//   a spoken sentence that may simply not mention a bank, and making it throw
//   would break a working feature on the day this deploys — an operator would
//   confirm a payment and get an error, with no dropdown anywhere to fix it.
//   A missing bank there is the SAME gap as a payment written before today:
//   stored as null, reported under "Not recorded", visible and closable.
//
// A BOGUS value is refused in both cases. Silence is a gap; a wrong bank on a
// cash payment is a false statement, and those are not the same thing.
async function resolveForMode(mode, bank, opts) {
    const required = !!(opts && opts.required);
    if (!needsBank(mode)) {
        // REFUSED, not ignored. If a client sends a bank on a cash payment
        // something is wrong with the form, and storing it would put "paid
        // cash from Chase" on the ledger — a sentence that is not true.
        if (String(bank || '').trim()) {
            throw new Error(`${mode} has no bank behind it — leave the bank blank.`);
        }
        return null;
    }
    const given = String(bank || '').trim();
    if (!given) {
        if (required) {
            throw new Error(`Which bank did the ${mode} go out of? Pick one, or choose ${OTHER} and type it.`);
        }
        // Recorded as unknown, and the report says so. Not guessed at.
        return null;
    }
    const known = canonical(given);
    if (known) return known;
    // Not on the list: this is the Others path, and the text she typed IS the
    // bank. Remembered so it is on the list next time.
    return remember(given);
}

module.exports = {
    BANKS, OTHER, MODES_WITH_BANK,
    needsBank, options, learned, canonical, remember, resolveForMode,
};
