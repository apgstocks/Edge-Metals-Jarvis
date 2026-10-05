// ── helpers/bankLearn.js — what the matcher learns, and from where ────────
//
// Apsara, 2026-10-05: "it should able to self learn, self find… figure out why
// there is an issue and it should able to fix that".
//
// ── TWO KINDS OF LEARNING, AND ONLY ONE OF THEM NEEDS A STORE ────────────
// It is worth being precise about this, because a stored "learned fact" that
// drifts from the ledger is worse than no learning at all — it is a
// confident wrong answer.
//
//   1. HOW A CUSTOMER PAYS — do they combine invoices, do they pay in parts,
//      how many days do they take, how much does their bank take in transit.
//      This is NOT stored. It is COMPUTED from sales_receipts.json, which is
//      the record of every receipt she has ever confirmed. So it cannot go
//      stale, cannot disagree with the ledger, needs no migration, and
//      corrects itself the moment she deletes a receipt that was wrong.
//      Deriving it is also the only honest way to call it learned: it is her
//      behaviour, measured, not a setting someone typed.
//
//   2. WHAT A BANK DESCRIPTOR MEANS — that "WIRE IN CUSTOM ALLOYS LLC REF
//      88213" is Custom Alloys. This information exists NOWHERE else in the
//      business, so it is the one thing that genuinely has to be remembered.
//      One answer from her, then every future deposit from that payer
//      resolves itself.
//
// ── IT STILL DOES NOT GUESS ──────────────────────────────────────────────
// helpers/nameMatch.js argues the case against fuzzy matching: a near-miss
// resolves to the wrong company. Here the cost is higher than a misdirected
// email — it allocates real money against the wrong customer's invoice, and
// both ledgers look right until the year end.
//
// So resolution is EXACT (after normalising punctuation), against the
// aliases she has confirmed and against the customer names themselves.
// Anything else is a SUGGESTION — returned separately, shown on the screen,
// and only ever turned into an alias by her pressing something. The engine
// proposes; it never decides who paid.

const path = require('path');
const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');
const { normalizeName } = require('./nameMatch');

// Env-overridable so a test can never write her real file — the same rule
// QB_DECISIONS_FILE follows, and for the same reason.
function FILE() {
    return process.env.BANK_LEARN_FILE
        || path.join(cfg.DATA_DIR, 'bank-learn.json');
}

const round2 = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : null);
const num0 = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
const day = (d) => String(d || '').slice(0, 10);

const DEFAULT = { aliases: [] };

function store() {
    const raw = loadJson(FILE(), DEFAULT);
    // loadJson never throws and does not merge defaults, so a file that
    // somebody hand-edited into an array or a string must not take the
    // matcher down with it. A broken learning file means "nothing learned
    // yet", which degrades to asking — the safe direction.
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { aliases: [] };
    return { aliases: Array.isArray(raw.aliases) ? raw.aliases : [] };
}

function listAliases() { return store().aliases.slice(); }

// ── remember ─────────────────────────────────────────────────────────────
// Keyed on the NORMALISED descriptor, so "WIRE IN  CUSTOM-ALLOYS" and "Wire
// In Custom Alloys" are one alias rather than two.
async function learnAlias(descriptor, customer, { by = null, why = null } = {}) {
    const key = normalizeName(descriptor);
    if (!key) throw new Error('nothing to learn from an empty description');
    const name = String(customer || '').trim();
    if (!name) throw new Error('learn it as whose?');
    const row = {
        key, descriptor: String(descriptor).trim(), customer: name,
        at: new Date().toISOString(), by: by || null, why: why || null,
    };
    await mutateJson(FILE(), DEFAULT, (all) => {
        const s = (all && typeof all === 'object' && !Array.isArray(all)) ? all : { aliases: [] };
        s.aliases = (Array.isArray(s.aliases) ? s.aliases : []).filter((a) => a.key !== key);
        s.aliases.push(row);
        return s;
    });
    return row;
}

// Un-learning has to be as easy as learning. A wrong alias silently
// misallocates every future deposit from that payer, so there must be a way
// back that does not involve editing JSON on a server.
async function forgetAlias(descriptor) {
    const key = normalizeName(descriptor);
    let gone = null;
    await mutateJson(FILE(), DEFAULT, (all) => {
        const s = (all && typeof all === 'object' && !Array.isArray(all)) ? all : { aliases: [] };
        const rows = Array.isArray(s.aliases) ? s.aliases : [];
        gone = rows.find((a) => a.key === key) || null;
        s.aliases = rows.filter((a) => a.key !== key);
        return s;
    });
    return gone;
}

// ── resolve: exact only ──────────────────────────────────────────────────
// `customers` is the list of names in her ledger. Returns a name or null.
// Never a best effort.
function resolverFrom(aliases, customers) {
    const byKey = new Map((aliases || []).map((a) => [a.key, a.customer]));
    const byName = new Map();
    for (const c of (customers || [])) {
        const k = normalizeName(c);
        if (!k) continue;
        // A duplicate normalised customer name means two records that are the
        // same company spelled differently. Resolving to either would be a
        // coin flip, so it resolves to NEITHER and she gets asked — which is
        // also how she finds out she has a duplicate.
        if (byName.has(k) && byName.get(k) !== c) byName.set(k, null);
        else if (!byName.has(k)) byName.set(k, c);
    }
    return (descriptor) => {
        const k = normalizeName(descriptor);
        if (!k) return null;
        if (byKey.has(k)) return byKey.get(k);
        if (byName.has(k)) return byName.get(k) || null;
        return null;
    };
}

// ── suggest: this is where containment lives, and it is NOT resolution ────
// A bank descriptor is a customer name buried in noise, so containment is
// the only thing that could ever match one. It is also exactly what
// nameMatch.js refuses to do automatically, and it is right to refuse: "AJ"
// is inside "AJAX TRADING".
//
// So it is quarantined here as a suggestion for the screen, with three
// guards, and it resolves nothing on its own:
//   · the name must be long enough to be meaningful once normalised
//   · it must be UNIQUE — two customers inside one descriptor is a question
//   · the result is labelled a suggestion all the way to the screen
const MIN_SUGGEST = 6;

function suggestParty(descriptor, customers) {
    const d = normalizeName(descriptor);
    if (!d) return [];
    const hits = [];
    for (const c of (customers || [])) {
        const k = normalizeName(c);
        if (!k || k.length < MIN_SUGGEST) continue;
        if (d.includes(k)) hits.push({ customer: c, matched: k.length });
    }
    // Longest match first: "CUSTOM ALLOYS LLC" beats "CUSTOM" if both exist.
    hits.sort((a, b) => b.matched - a.matched || String(a.customer).localeCompare(String(b.customer)));
    // Ambiguous suggestions are still returned — the screen shows both and
    // she picks. Hiding the second one would make a coin flip look certain.
    return hits.map((h) => ({ customer: h.customer, basis: 'name found in the bank description' }));
}

// ── measure: how each customer actually pays ──────────────────────────────
// Pure. `receipts` is salesReceipts.list(), `salesById` a Map of sale id to
// { date, amount }. Returns a plain object keyed by customer.
//
// EVERY FIELD CARRIES ITS SAMPLE COUNT. A pattern derived from one receipt is
// not a pattern, and the scorer must be able to tell the difference between
// "this customer always combines" and "they did it once in March".
function patternsFromHistory(receipts = [], salesById = new Map()) {
    const out = {};
    const at = (c) => {
        if (!out[c]) {
            out[c] = {
                receipts: 0, combines: false, combinedCount: 0,
                partPays: false, partCount: 0,
                typicalDays: null, daySamples: [],
                feeAllowance: 0, feeSamples: 0,
            };
        }
        return out[c];
    };

    for (const r of (receipts || [])) {
        const c = String((r && r.customer) || '').trim();
        if (!c) continue;
        const p = at(c);
        p.receipts += 1;
        const allocs = Array.isArray(r.allocations) ? r.allocations : [];

        if (allocs.length > 1) { p.combinedCount += 1; p.combines = true; }

        for (const a of allocs) {
            const sale = salesById.get ? salesById.get(a.sale_id) : (salesById || {})[a.sale_id];
            if (sale && isFinite(Number(sale.amount))) {
                // A part payment is an allocation smaller than the invoice it
                // is against, allowing for whatever was written off on it.
                const covered = num0(a.amount) + num0(a.deduction_amount);
                if (covered + 0.005 < num0(sale.amount)) { p.partCount += 1; p.partPays = true; }
            }
            if (sale && sale.date && r.date) {
                const g = Math.round((Date.parse(day(r.date) + 'T00:00:00Z')
                    - Date.parse(day(sale.date) + 'T00:00:00Z')) / 86400000);
                if (isFinite(g) && g >= 0 && g < 1000) p.daySamples.push(g);
            }
            // ── ONLY bank_charge BECOMES AN ALLOWANCE ────────────────────
            // A 'discount' is money she AGREED to give up — a negotiation,
            // not a predictable transit fee. Rolling discounts into the
            // allowance would teach the matcher to silently close any invoice
            // this customer underpays, which is the opposite of useful: a
            // short payment she did not agree to is exactly the thing she
            // needs to see.
            if (a.deduction_reason === 'bank_charge') {
                const d = num0(a.deduction_amount);
                if (d > 0) { p.feeSamples += 1; p.feeAllowance = Math.max(p.feeAllowance, round2(d)); }
            }
        }
    }

    for (const c of Object.keys(out)) {
        const p = out[c];
        if (p.daySamples.length) {
            const s = p.daySamples.slice().sort((a, b) => a - b);
            // MEDIAN, not mean. One invoice paid nine months late drags a mean
            // far enough to make every normal payment look early.
            p.typicalDays = s.length % 2
                ? s[(s.length - 1) / 2]
                : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
        }
        delete p.daySamples;
    }
    return out;
}

module.exports = {
    FILE, listAliases, learnAlias, forgetAlias,
    resolverFrom, suggestParty, patternsFromHistory, MIN_SUGGEST,
};
