// ── helpers/bankReview.js — one queue, the way she already reads one ──────
//
// Apsara, 2026-10-08, after calling the first screen "the ugliest thing i
// have seen" and then the sharper version — "no structure.nothing was
// there.how can you expect a customer to pay me from this" — said what she
// wanted instead: "i want like pending,posted transactions like qb with
// match,post", and on seeing a mock-up, "add as a carrier bill that is also
// better".
//
// So: QuickBooks' shape, her language in the buttons. She reads the
// QuickBooks banking screen fluently, so borrowing its structure costs her
// no learning; and naming the record a button will CREATE is better than
// QuickBooks' generic "Add" plus a category dropdown, because what she
// cares about is what exists afterwards.
//
// ── ONE LIST, BOTH DIRECTIONS ───────────────────────────────────────────
// The money that arrives and the money that leaves are the same morning's
// work and belong in one queue. They had entirely separate machinery:
// bankMatch.js matches deposits to invoices, bankOut.js matches withdrawals
// to recorded payments, and dashboard/bank-match.html only ever showed the
// first. A screen with the receipts on it and the payments somewhere else
// is how half the bank went unlooked-at for a month.
//
// This file does NOT re-implement either matcher. It calls both and turns
// their answers into one vocabulary — the five states below — so the screen
// has one row shape instead of two.
//
// ── IT DECIDES NOTHING AND WRITES NOTHING ───────────────────────────────
// Pure. Every row carries what it would do and why; doing it is a separate,
// logged, reversible act. The reasons travel with the row because at tax
// time the question is never "what did it think", it is "why is this
// $47,310.22 sitting against these three invoices".

const BM = require('./bankMatch');
const BO = require('./bankOut');

const CENT = 0.005;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };

// ── THE FIVE STATES, AND THE BUTTON EACH ONE EARNS ──────────────────────
// Deliberately few. QuickBooks has more and they blur; these are the only
// distinctions that change what she does next.
//
//   match    Jarvis found the record she already entered. One press, and
//            nothing is created — it only ties the two together.
//   add      Nothing matches and Jarvis knows what kind of record this is,
//            so the button names it: "Add as a carrier bill".
//   choose   Two or more records fit exactly. NEVER picked for her; see
//            bankMatch.js on why picking the first is the single most
//            expensive thing this code could do.
//   ask      Jarvis cannot tell what this is. No guess is offered.
//   done     Already matched or posted. Lives on the Posted tab, reversible.
const STATES = ['match', 'add', 'choose', 'ask', 'done'];

// What a withdrawal with no recorded payment most likely IS. Named from the
// descriptor, and ONLY where the name is unambiguous — a wrong guess here
// puts a supplier payment in the trucking account, which is a silent error
// on a statement rather than a visible one on a screen.
//
// Returns null rather than a default. "Add as an expense" as a fallback
// would be a category chosen by the absence of information, and 6300 would
// slowly fill with things nobody classified.
const KINDS = [
    { re: /\b(ntg|tql|schneider|aj\s*transport|sher|jio|garduno)/i,
      kind: 'carrier-bill', label: 'Add as a carrier bill', account: '5200' },
    { re: /\b(zimex|eagle\s*brit|pan\s*metal)/i,
      kind: 'carrier-bill', label: 'Add as a carrier bill', account: '5200' },
    { re: /\b(service charge|maintenance fee|monthly fee|wire fee|overdraft|nsf)\b/i,
      kind: 'bank-charge', label: 'Add as a bank charge', account: '6300' },
];

function guessKind(descriptor) {
    const d = String(descriptor || '');
    for (const k of KINDS) if (k.re.test(d)) return k;
    return null;
}

// ── MONEY IN ────────────────────────────────────────────────────────────
// bankMatch.js's outcomes, translated. Its vocabulary is about the SEARCH
// ("no_party", "nothing_open"); this one is about the BUTTON.
function fromDeposit(res) {
    const d = res.deposit || {};
    const base = {
        id: d.id, direction: 'in', date: d.date, amount: r2(num(d.amount)),
        descriptor: d.descriptor || '', party: res.party || null,
    };
    if (res.ambiguous) {
        return { ...base, state: 'choose', label: 'Choose',
            why: res.note || 'several combinations come to exactly this amount',
            options: res.proposals || [] };
    }
    const p = (res.proposals || [])[0];
    if (p) {
        return { ...base, state: 'match', label: 'Match',
            why: (p.reasons || [])[0] || 'matches an open invoice to the cent',
            match: p, options: res.proposals };
    }
    // no_party / nothing_open / more_than_owed all mean the same thing to
    // her: Jarvis cannot propose anything and is not going to invent one.
    return { ...base, state: 'ask', label: 'Tell Jarvis what this is',
        why: res.note || 'nothing open matches this deposit' };
}

// ── MONEY OUT ───────────────────────────────────────────────────────────
function fromWithdrawal(res) {
    const row = res.row || {};
    const base = {
        id: row.id, direction: 'out', date: row.date, amount: r2(num(row.amount)),
        descriptor: row.descriptor || '', party: null,
    };
    if (res.outcome === 'ambiguous') {
        return { ...base, state: 'choose', label: 'Choose',
            why: res.note || 'several recorded payments come to exactly this amount',
            options: res.proposals || [] };
    }
    if (res.outcome === 'matched' || res.outcome === 'combined') {
        const p = res.proposals[0];
        return { ...base, state: 'match', label: 'Match',
            why: (p.reasons || [])[0] || 'matches a payment already recorded',
            match: p, auto: !!res.auto };
    }
    // Nothing recorded. THIS is where naming the record earns its place:
    // "Post" tells her nothing, "Add as a carrier bill" tells her what will
    // exist when she presses it.
    const k = guessKind(base.descriptor);
    if (k) {
        return { ...base, state: 'add', label: k.label, kind: k.kind, account: k.account,
            why: `nothing recorded matches this, and the description names ${base.descriptor.trim()}` };
    }
    return { ...base, state: 'ask', label: 'Tell Jarvis what this is',
        why: res.note || 'nothing recorded matches this withdrawal' };
}

// ── THE QUEUE ───────────────────────────────────────────────────────────
// Newest first, because that is how she reads a bank screen — but the
// SWEEP underneath runs oldest first so claims go to the earliest row that
// can use them (bankOut.sweep's note). Those two orders are not in
// conflict; one is arithmetic and the other is reading.
function queue({ depositResults = [], withdrawalResults = [], done = [] } = {}) {
    const rows = []
        .concat((depositResults || []).map(fromDeposit))
        .concat((withdrawalResults || []).map(fromWithdrawal))
        .filter((r) => r.amount > CENT)
        .sort((a, b) => String(b.date).localeCompare(String(a.date)));

    const by = (s) => rows.filter((r) => r.state === s);
    return {
        rows,
        // The three tabs, in QuickBooks' order and her words.
        forReview: rows.length,
        posted: (done || []).length,
        counts: STATES.reduce((c, s) => { c[s] = by(s).length; return c; }, {}),
        money: {
            in: r2(rows.filter((r) => r.direction === 'in').reduce((t, r) => t + r.amount, 0)),
            out: r2(rows.filter((r) => r.direction === 'out').reduce((t, r) => t + r.amount, 0)),
        },
        // ── THE ONE-PRESS OFFER, AND ITS LIMIT ──────────────────────────
        // Her decision, 2026-10-08: auto-tick exact single matches. So the
        // screen can offer "post all N that match exactly" — but only
        // `match` rows, never `add`. Creating records in bulk from a guess
        // about what a descriptor means is a different and much worse
        // offer, however convenient it looks beside the other one.
        canPostAll: by('match').length,
    };
}

module.exports = { queue, fromDeposit, fromWithdrawal, guessKind, STATES, KINDS, CENT };
