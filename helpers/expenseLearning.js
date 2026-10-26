// ── helpers/expenseLearning.js — what she has always done with this vendor ─
//
// Apsara, 2026-10-26: make the product need "very less human intervention".
//
// ── THE EVIDENCE, FROM HER OWN EXPENSES TAB ──────────────────────────────
// Santiago filed under Labour five times. Rigo twice. Fede three times. Every
// one of those was a decision she made by hand, and nothing in Jarvis
// remembered the first one. helpers/vendorFromText.js asks the MODEL on every
// single entry — which is right for "is a person named in this sentence" and
// wasteful for "which category does Santiago go in", a question her own
// history has already answered five times.
//
// ── NO LEARNING FILE. THE HISTORY IS THE MEMORY. ─────────────────────────
// The obvious build is a learned-rules store that accumulates vendor →
// category. It is the wrong one, for exactly the reason helpers/ports.js
// gives for not shipping a list of world ports: "the suggestions ARE her
// history. Nothing to maintain, nothing to go stale." A rules file can
// disagree with the expenses it was derived from — after an edit, after a
// delete, after a category is renamed — and then Jarvis is confidently
// wrong about her own data.
//
// So this derives, every time, from expenses.json. It writes nothing.
//
// ── IT ANSWERS, IT DOES NOT DECIDE ───────────────────────────────────────
// Returns a verdict with its evidence attached: how many times, how
// consistently, and over what period. Whether a caller pre-fills a field,
// asks, or stays quiet is the caller's business — the same split as
// truckingProposal and freightProposal, which propose and never pick.
//
// Follows vendorFromText.js's stated division of labour: the model decides
// what was MEANT, deterministic code decides what is TRUE. "Santiago is
// usually Labour" is not a judgement call, it is arithmetic over her rows,
// so a model should never be asked it.
const nameMatch = require('./nameMatch');

// Enough history to be a pattern rather than a coincidence. Two is a pair;
// three is a habit. Deliberately low, because her vendor list is small and a
// threshold she never reaches is a feature that never fires.
const MIN_SEEN = 3;
// Below this, she is not consistent and Jarvis must not pretend she is.
// 0.8 means one disagreement in five is still a pattern; two in five is not.
const CONFIDENT_AT = 0.8;

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');

// The vendor on a row, wherever she put it. Her data carries the person in
// the vendor field OR in the description — vendorFromText.js exists because
// of exactly that split — so a reader that only checks `vendor` sees about
// half her history and draws confident conclusions from it.
function vendorOf(row) {
    if (!row || typeof row !== 'object') return '';
    return norm(row.vendor || row.party || row.payee || '');
}

// ── WHAT SHE HAS DONE WITH THIS VENDOR ───────────────────────────────────
// Counts every category this vendor's rows have carried, newest first so a
// recent change of mind is visible rather than drowned by history.
function historyFor(vendor, expenses = []) {
    const want = norm(vendor);
    if (!want) return { vendor: '', seen: 0, byCategory: [], rows: [] };

    const rows = (Array.isArray(expenses) ? expenses : []).filter((e) => {
        const v = vendorOf(e);
        if (!v) return false;
        // Exact after normalisation, never fuzzy — nameMatch.js's own rule,
        // and the reason is the same here as there: a near miss files money
        // against the wrong person. "Rigo" and "Rego" are two people until
        // she says otherwise, and her yard has both.
        //
        // normalizeName, NOT a `same()` helper. The first draft of this line
        // called nameMatch.same() — which does not exist — behind a `?:`
        // fallback, so it ran on the fallback and looked right. A defensive
        // default that hides a wrong call is worse than a crash.
        return nameMatch.normalizeName(v) === nameMatch.normalizeName(want);
    });

    const counts = new Map();
    for (const r of rows) {
        const c = String((r && r.category) || '').trim();
        if (!c) continue;
        const cur = counts.get(c) || { category: c, count: 0, last: null };
        cur.count += 1;
        const d = String(r.date || '');
        if (d && (!cur.last || d > cur.last)) cur.last = d;
        counts.set(c, cur);
    }
    const byCategory = [...counts.values()]
        .sort((a, b) => (b.count - a.count) || String(b.last || '').localeCompare(String(a.last || '')));
    return { vendor: want, seen: rows.filter((r) => r && r.category).length, byCategory, rows };
}

// ── THE VERDICT ──────────────────────────────────────────────────────────
// { category, confident, seen, share, why } — and `confident` is the only
// thing a caller should act on without asking. Everything else is there so
// the caller can SHOW the reason: "Labour, as on the last 5" is a sentence
// she can disagree with; a silently pre-filled field is not.
function categoryFor(vendor, expenses = [], { catchAll = 'Other' } = {}) {
    const h = historyFor(vendor, expenses);
    const top = h.byCategory[0];
    if (!top) {
        return { category: null, confident: false, seen: h.seen, share: 0,
            why: 'nothing on file for this vendor yet' };
    }
    const share = h.seen ? top.count / h.seen : 0;

    // ── A LEARNED CATCH-ALL IS A FLAG, NOT AN ANSWER ─────────────────────
    // Caught by running this on her real rows: Fede came back "Other", and
    // CONFIDENT — three times out of three. Acting on that would have had
    // Jarvis pre-filling "Other" for every future copper purchase, turning a
    // $99,243 mis-categorisation into a permanent habit with Jarvis's help.
    //
    // Learning from history means learning her mistakes too. The guard is
    // narrow and specific: a vendor's most common category being the
    // catch-all NEVER counts as confident, however consistent it is.
    // catchAllVendors() below is the other half — it reports the same vendor
    // as something to fix, by value.
    const isCatchAll = norm(top.category) === norm(catchAll);
    const confident = !isCatchAll && h.seen >= MIN_SEEN && share >= CONFIDENT_AT;
    return {
        category: top.category,
        confident,
        seen: h.seen,
        share: Math.round(share * 100) / 100,
        alternatives: h.byCategory.slice(1, 4).map((c) => ({ category: c.category, count: c.count })),
        why: confident
            ? `filed under ${top.category} on ${top.count} of her last ${h.seen}`
            : isCatchAll
                ? `always filed under ${top.category} (${top.count} of ${h.seen}) — that is the `
                    + 'catch-all, so it is something to fix rather than something to repeat'
                : h.seen < MIN_SEEN
                    ? `only ${h.seen} on file — not a pattern yet`
                    : `she has used ${h.byCategory.length} different categories for this vendor`,
    };
}

// Same question for how it was paid. Her yard runs on cash and the method is
// the field that, left blank, sends an expense to 2090 Unallocated payments
// (helpers/postings.js, 2026-10-26). A vendor always paid in cash is the
// cheapest possible answer to that.
function methodFor(vendor, expenses = []) {
    const h = historyFor(vendor, expenses);
    const counts = new Map();
    let seen = 0;
    for (const r of h.rows) {
        const m = String((r && r.method) || '').trim();
        if (!m) continue;
        seen += 1;
        counts.set(m, (counts.get(m) || 0) + 1);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    if (!ranked.length) return { method: null, confident: false, seen: 0, why: 'never recorded a method for this vendor' };
    const [method, count] = ranked[0];
    const share = count / seen;
    return {
        method, seen, share: Math.round(share * 100) / 100,
        confident: seen >= MIN_SEEN && share >= CONFIDENT_AT,
        why: `paid by ${method} on ${count} of her last ${seen}`,
    };
}

// ── THE ONE THAT FOUND THE COPPER ────────────────────────────────────────
// A vendor whose rows keep landing in a catch-all is not a tidiness problem.
// On 2026-10-26 her yard's expenses held $99,243 of copper bought from Fede,
// filed three times under "Other" — 90% of the yard's entire expense total,
// sitting in 6900 when it is material, not an operating cost.
//
// The chart already says to watch for this; 6900's own note reads "A row
// landing here is not an error, but a LOT of them is a sign the chart is
// missing an account she needs." Nothing was counting. This counts.
//
// Reported by VALUE as well as by count, because three rows worth $99k and
// three rows worth $9 are not the same finding.
function catchAllVendors(expenses = [], { catchAll = 'Other', minRows = 2 } = {}) {
    const want = norm(catchAll);
    const by = new Map();
    for (const e of (Array.isArray(expenses) ? expenses : [])) {
        if (!e || norm(e.category) !== want) continue;
        const v = vendorOf(e) || '(no vendor)';
        const cur = by.get(v) || { vendor: e.vendor || '(no vendor)', rows: 0, amount: 0, examples: [] };
        cur.rows += 1;
        cur.amount = Math.round((cur.amount + (Number(e.amount) || 0)) * 100) / 100;
        if (cur.examples.length < 3) cur.examples.push(e.description || e.id || '');
        by.set(v, cur);
    }
    return [...by.values()]
        .filter((v) => v.rows >= minRows)
        .sort((a, b) => b.amount - a.amount);
}

module.exports = { categoryFor, methodFor, historyFor, catchAllVendors, vendorOf, MIN_SEEN, CONFIDENT_AT };
