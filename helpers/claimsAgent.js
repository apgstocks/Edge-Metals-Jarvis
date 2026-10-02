// ── helpers/claimsAgent.js — the claim that nobody chased ──────────────────
// Apsara, 2026-10-02: "Also for handling claims-I want to have an advanced
// agent because thats where we are losing money."
//
// Asked which of four leaks it was, she said ALL FOUR, and gave the agent two
// powers: chase, and draft the recovery email for her to approve. It writes
// no money figures.
//
// ── THE DIAGNOSIS WAS ALREADY IN THE CODE ─────────────────────────────────
// helpers/claims.js, above raiseRecovery():
//
//   "This is the half of a claim that is actually actionable, and the half
//    that keeps not happening: most of what Edge has absorbed is a recovery
//    nobody raised."
//
// And stats() already counts it: awaiting_recovery. So the leak was named and
// measured. What was missing is that NOTHING EVER LOOKED. claimWatch parses
// the mail, creates the record, pings the team once — and from that moment no
// scheduled job, report or reminder touches an Edge Metals claim again. The
// 8PM yard report covers EDGE YARD claims, a different company and a
// different store.
//
// A register nobody reads is a list of money being given away politely.
//
// ── THE FOUR LEAKS, AS STAGES ─────────────────────────────────────────────
//   1. unverified, ageing      nobody confirmed the weights, so it is never
//                              claimed from anyone and it quietly dies.
//   2. verified, no recovery    THE BIG ONE. The customer has deducted from
//                              us and we have not asked the supplier for it.
//                              Every day this sits, we are absorbing it.
//   3. recovery_raised, no      asked and forgotten. Nothing chases a
//      settlement               supplier who simply did not reply.
//   4. the window closing       carriers, insurers and suppliers all have
//                              time limits.
//
// ── WHAT IT WILL NOT DO ───────────────────────────────────────────────────
// It never writes claim_amount, our_claim, or a status. helpers/claims.js
// keeps claim_amount null until a human confirms the weights AND the unit,
// deliberately — her own sheet holds "1,305.9KG" beside "58.901" beside
// "23,718" in a column headed MT, and a parser that guesses is wrong by a
// factor of 1000 in the figure she shows her uncle. That line is not moved
// here. The agent finds, totals what is ALREADY quantified, chases, and
// drafts. A person still verifies.
//
// ── AND IT NEVER INVENTS A FIGURE TO MAKE A TOTAL LOOK COMPLETE ───────────
// An unverified claim has no claim_amount, so its money is UNKNOWN, and the
// report says so rather than reaching for the shortage weight times a price
// nobody confirmed. "We are absorbing $41,200 across 6 claims, and 9 more are
// not yet quantified" is a true sentence. "$41,200" alone is not.

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(/[$,\s]/g, ''));
    return isFinite(n) ? n : null;
};
const str = (v) => String(v == null ? '' : v).trim();

// ── HOW LONG IS TOO LONG ──────────────────────────────────────────────────
// Days in a stage before the agent speaks up. These are STARTING POINTS and
// the report says so: the real windows depend on her contracts, and a number
// invented here that is quietly wrong is worse than one she corrects once.
// Overridable per run so she can tune them without a release.
//
// Chosen to be asymmetric on purpose: an unverified claim has not cost
// anything yet, while a verified one with no recovery raised is money leaving
// every day, so it is chased hardest and soonest.
const DEFAULT_WINDOWS = {
    unverified_days: 7,          // a week to confirm weights off the paperwork
    awaiting_recovery_days: 3,   // THE expensive one. Three days is already generous.
    unsettled_days: 21,          // a supplier has had three weeks to answer
    deadline_warn_days: 14,      // start warning two weeks out
};

// The stage a claim is in, from its status and its figures. One function, so
// the report and the chase cannot disagree about what state something is in.
const STAGE = {
    UNVERIFIED: 'unverified',
    AWAITING_RECOVERY: 'awaiting_recovery',
    UNSETTLED: 'unsettled',
    CLOSED: 'closed',
};

function stageOf(c) {
    const s = str(c && c.status);
    if (s === 'settled' || s === 'rejected' || s === 'withdrawn') return STAGE.CLOSED;
    if (s === 'recovery_raised') return STAGE.UNSETTLED;
    // The definition stats() already uses: verified, with nothing recovered.
    if (s === 'verified') {
        return num(c.our_claim) ? STAGE.UNSETTLED : STAGE.AWAITING_RECOVERY;
    }
    return STAGE.UNVERIFIED;
}

// ── WHEN DID THIS STAGE START ─────────────────────────────────────────────
// updated_at moves on ANY edit — a typo fix would reset the clock and hide a
// claim that has been stalled for a month. So the stage's start comes from
// the HISTORY entry that put it there, and falls back to created_at.
//
// helpers/claims.js stamps history via update(..., by, note) with notes
// 'verified' and 'recovery raised on supplier'.
function stageSince(c) {
    const hist = Array.isArray(c && c.history) ? c.history : [];
    const stage = stageOf(c);
    const noteFor = {
        [STAGE.UNSETTLED]: /recovery raised/i,
        [STAGE.AWAITING_RECOVERY]: /verified/i,
    }[stage];
    if (noteFor) {
        // Last matching entry, not the first: a recovery re-raised after a
        // rejection is a new clock.
        for (let i = hist.length - 1; i >= 0; i -= 1) {
            const h = hist[i];
            const when = h && (h.at || h.when || h.date);
            if (h && noteFor.test(str(h.note)) && when) return when;
        }
    }
    return (c && (c.created_at || c.updated_at)) || null;
}

const daysBetween = (iso, now) => {
    const t = Date.parse(str(iso));
    if (!isFinite(t)) return null;
    return Math.max(0, Math.floor((now - t) / 86400000));
};

// ── THE MONEY, AND ONLY WHERE IT IS REAL ──────────────────────────────────
// awaiting_recovery: claim_amount is what the customer has taken off us, and
//   nothing has been asked of the supplier, so that is what we are absorbing.
// unsettled: our_claim is what we asked for and have not received.
// unverified: UNKNOWN. Returns null, and the caller counts it separately.
function atRisk(c) {
    const stage = stageOf(c);
    if (stage === STAGE.AWAITING_RECOVERY) return num(c.claim_amount);
    if (stage === STAGE.UNSETTLED) return num(c.our_claim) ?? num(c.claim_amount);
    return null;
}

// ── ONE CLAIM, ASSESSED ───────────────────────────────────────────────────
// Pure. Returns what is true about the claim, never a decision to write.
function assess(c, { now = Date.now(), windows = {} } = {}) {
    const W = { ...DEFAULT_WINDOWS, ...windows };
    const stage = stageOf(c);
    const since = stageSince(c);
    const ageDays = daysBetween(since, now);
    const money = atRisk(c);

    // The deadline is OPTIONAL and usually absent — there is no such field on
    // the record today (see #158). Read from whatever she has set so the
    // check works the day the field exists, and stays silent until then
    // rather than inventing a date.
    const deadline = str(c && (c.claim_deadline || c.deadline)) || null;
    const deadlineDays = deadline ? -daysBetween(deadline, now) || daysLeft(deadline, now) : null;

    const overdue = {
        [STAGE.UNVERIFIED]: ageDays !== null && ageDays >= W.unverified_days,
        [STAGE.AWAITING_RECOVERY]: ageDays !== null && ageDays >= W.awaiting_recovery_days,
        [STAGE.UNSETTLED]: ageDays !== null && ageDays >= W.unsettled_days,
        [STAGE.CLOSED]: false,
    }[stage];

    const closing = deadlineDays !== null && deadlineDays <= W.deadline_warn_days;

    return {
        id: c && c.id,
        key: c && c.key,
        customer: str(c && c.customer),
        supplier: str(c && c.supplier),
        container_no: str(c && c.container_no),
        invoice_no: str(c && c.invoice_no),
        stage,
        ageDays,
        since,
        money,
        // Said out loud rather than folded into a total — see the header.
        moneyKnown: money !== null,
        deadline,
        daysToDeadline: deadlineDays,
        closing: !!closing,
        overdue: !!overdue,
        // Why it is being raised, in the words the report will use.
        why: reasonFor(stage, ageDays, money, deadlineDays, closing),
        // What a person does next. Never performed here.
        next: nextStepFor(stage),
    };
}

function daysLeft(iso, now) {
    const t = Date.parse(str(iso));
    if (!isFinite(t)) return null;
    return Math.floor((t - now) / 86400000);
}

function reasonFor(stage, ageDays, money, deadlineDays, closing) {
    const age = ageDays === null ? 'for an unknown time' : `for ${ageDays} day${ageDays === 1 ? '' : 's'}`;
    if (closing) {
        return deadlineDays < 0
            ? `the claim window closed ${Math.abs(deadlineDays)} day${Math.abs(deadlineDays) === 1 ? '' : 's'} ago`
            : `the claim window closes in ${deadlineDays} day${deadlineDays === 1 ? '' : 's'}`;
    }
    if (stage === STAGE.AWAITING_RECOVERY) {
        return `verified ${age} and nothing has been asked of the supplier`
            + (money !== null ? ` — we are absorbing this` : '');
    }
    if (stage === STAGE.UNSETTLED) return `raised on the supplier ${age} with no settlement`;
    if (stage === STAGE.UNVERIFIED) return `sitting unverified ${age}, so it has not been claimed from anyone`;
    return 'closed';
}

function nextStepFor(stage) {
    if (stage === STAGE.UNVERIFIED) return 'confirm the weights and the unit, then verify it';
    if (stage === STAGE.AWAITING_RECOVERY) return 'raise the recovery on the supplier';
    if (stage === STAGE.UNSETTLED) return 'chase the supplier for settlement';
    return null;
}

// ── A WHOLE REGISTER, TRIAGED ─────────────────────────────────────────────
// Grouped by leak, worst money first within each group, and the two totals
// kept apart: what is quantified, and how many are not yet quantified.
function triage(claims, { now = Date.now(), windows = {} } = {}) {
    const rows = (Array.isArray(claims) ? claims : [])
        .filter(Boolean)
        .map((c) => assess(c, { now, windows }))
        .filter((a) => a.stage !== STAGE.CLOSED);

    const flagged = rows.filter((a) => a.overdue || a.closing);
    const byMoney = (a, b) => (b.money || 0) - (a.money || 0);

    const group = (stage) => flagged.filter((a) => a.stage === stage).sort(byMoney);

    const absorbing = group(STAGE.AWAITING_RECOVERY);
    const unsettled = group(STAGE.UNSETTLED);
    const unverified = group(STAGE.UNVERIFIED);
    const closing = flagged.filter((a) => a.closing).sort((a, b) => (a.daysToDeadline || 0) - (b.daysToDeadline || 0));

    const total = (list) => round2(list.reduce((t, a) => t + (a.money || 0), 0));

    return {
        absorbing, unsettled, unverified, closing,
        counts: {
            flagged: flagged.length,
            live: rows.length,
            absorbing: absorbing.length,
            unsettled: unsettled.length,
            unverified: unverified.length,
            closing: closing.length,
            // How many carry no figure at all. Reported, never guessed at.
            unquantified: rows.filter((a) => !a.moneyKnown).length,
        },
        money: {
            absorbing: total(absorbing),
            unsettled: total(unsettled),
            // Deliberately NOT a single grand total. Money we are absorbing
            // and money a supplier owes us are different kinds of bad, and
            // adding them produces a number that means nothing.
        },
    };
}

module.exports = {
    STAGE, DEFAULT_WINDOWS,
    stageOf, stageSince, atRisk, assess, triage,
};
