// ── helpers/pickupLearn.js — the carrier teaches Jarvis, not Apsara ──────
// Apsara, 2026-11-06:
//   "it should learn and adapt"
//   "i cant custom train as per buyer.it should learn and adapt"
//   "reinforcement"  "learning"  "adaptiv learning"
//   "use renorcement and adaptive learning concepts"
//
// ══════════════════════════════════════════════════════════════════════════
//  WHY THE FIRST VERSION OF THIS FILE WAS NOT REINFORCEMENT LEARNING
// ══════════════════════════════════════════════════════════════════════════
// It counted successes and applied thresholds: four failures and a channel
// was dropped. That is a statistic with an if-statement, and it had the
// defect that gives the game away — A CHANNEL ONCE DROPPED WAS DROPPED
// FOREVER. If Zimex fixed their mail server Jarvis would never find out,
// because it had stopped generating the evidence that would change its mind.
// Pure exploitation, zero exploration, and it would have cost her a working
// channel permanently.
//
// ══════════════════════════════════════════════════════════════════════════
//  THE CONCEPTS NOW USED, AND WHY EACH EARNS ITS PLACE
// ══════════════════════════════════════════════════════════════════════════
// 1. AN EXPLICIT REWARD. Every finished pickup scores in [0,1]: answered on
//    the first ask is 1.0, answered after a chase is worth less, never
//    answered is 0. Written down (`rewardFor`) rather than implied, because
//    a reward function you cannot read is a policy nobody can argue with.
//
// 2. A BETA POSTERIOR PER (CARRIER, CHANNEL), not a hit count. Beta(a,b) is
//    the conjugate prior for "does asking on this channel work", and it
//    carries its own uncertainty: 0 of 2 and 0 of 40 are both zero, and only
//    the second is evidence. Starting at Beta(1,1) — uniform — is exactly
//    why a new carrier behaves as it did before any of this existed.
//
// 3. EXPLORATION THAT NEVER REACHES ZERO. A channel is set aside only when
//    its 95% upper bound is genuinely poor AND the other channel is working
//    — and even then it is retried with probability e, which decays with
//    evidence but never hits 0. This is the fix for the defect above:
//    Jarvis keeps a door open to being proved wrong.
//
// 4. RECENCY DISCOUNTING (gamma), because this world is NON-STATIONARY. A
//    carrier changes dispatcher and last year stops being evidence. Both
//    posteriors and reply times decay on every update, so old observations
//    fade smoothly instead of falling off a fixed window.
//
// 5. AN ONLINE VALUE ESTIMATE for reply time — the standard incremental
//    update V <- V + alpha(x - V). No list to re-sort, recent behaviour
//    dominates, and it is one number she can be shown.
//
// ── WHAT THIS IS NOT ─────────────────────────────────────────────────────
// Not a neural net, and not pretending to be. The state is a handful of
// numbers per carrier and the action is "which channels, how long to wait" —
// a contextual bandit, not a control problem, and fitting a network to it
// would be less accurate and far harder to defend. This decides when Jarvis
// mails a company she buys from. When she asks "why did you chase them at
// half nine", the answer has to be a sentence, and "Beta(2,9) on email,
// upper bound 0.41, expected reply 22 minutes" is one. A hunch is not.
//
// ── WHAT THE POLICY MAY NEVER DO ─────────────────────────────────────────
// "Chase twice, then tell the team" is hers. Learning tunes WHEN and HOW; it
// never removes a rung, never skips the ask, never moves the escalation off
// the pickup day, and can never leave a carrier with no channel at all. A
// system that learns its way into silence is worse than one that never
// learned anything, because she would stop checking.
const path = require('path');
const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

const FILE = () => cfg.PICKUP_LEARN_FILE || path.join(cfg.DATA_DIR, 'pickup-learn.json');

const str = (v) => String(v == null ? '' : v).trim();
const key = (company) => str(company).toLowerCase().replace(/\s+/g, ' ');

// ── THE HYPERPARAMETERS, IN ONE PLACE ────────────────────────────────────
const GAMMA = 0.92;          // recency discount per observation: ~8 effective
                             // observations of memory
const PRIOR = 1;             // Beta(1,1), uniform. Knows nothing, assumes
                             // nothing, and is why cold start is unchanged.
const ALPHA_LR = 0.35;       // learning rate for the reply-time estimate
const MIN_EVIDENCE = 4.0;    // effective observations before ANY adaptation
// ── CALIBRATED AGAINST THE ACTUAL POSTERIOR, NOT GUESSED ─────────────────
// First set to 0.25, which the simulation showed is UNREACHABLE: with
// partial negative credit (0.5) and gamma decay, a channel that never once
// produces the answer converges to mean ~0.12 and an upper bound of ~0.35
// and stops falling. A threshold below the asymptote is dead code, and a
// check on dead code is a check that cannot go red.
//
// 0.40 is crossed after roughly fifteen consistent observations — which is
// deliberately slow for an action that stops mailing a channel at all, and
// is recoverable at any time by the exploration below.
const DEAD_UPPER = 0.40;     // set aside when even the optimistic bound is poor
const ALIVE_MEAN = 0.35;     // ...and only if the other channel really works
const EXPLORE_FLOOR = 0.08;  // e never decays below this. The door that stays
                             // open, and the whole fix for the old defect.
const EARLIEST_CHASE_MIN = 60;
const LATEST_CHASE_HOUR = 13;

const CHANNELS = ['email', 'whatsapp'];

const EMPTY = () => ({ carriers: {} });
const load = () => Object.assign(EMPTY(), loadJson(FILE(), EMPTY()));
const blankArm = () => ({ a: PRIOR, b: PRIOR });
const blank = (company) => ({ company, asks: 0, answers: 0, reward_sum: 0,
    arms: { email: blankArm(), whatsapp: blankArm() },
    reply_value: null, reply_n: 0, seen_pickups: [] });

function carrier(store, company) {
    const k = key(company);
    return (store.carriers && store.carriers[k]) || null;
}

// ── 1. THE REWARD ────────────────────────────────────────────────────────
// What "good" means, written down. Answered at all is most of it; answered
// without needing a chase is the rest. A pickup is NOT scored on whether the
// truck came — that is the yard's fact, not the carrier's responsiveness,
// and conflating them would punish a carrier for weather.
function rewardFor(pickup) {
    const p = pickup || {};
    const answered = !!(str(p.eta) || str(p.confirmed_at));
    if (!answered) return 0;
    const chases = (Array.isArray(p.sent) ? p.sent : []).filter((s) => s && s.step === 'chase').length;
    return Math.max(0.5, 1 - 0.3 * chases);
}

// Beta helpers. The upper bound is a normal approximation (mean + 2 sd),
// which is plenty at these sample sizes and is something she could check on
// paper if she ever wanted to.
const armMean = (arm) => arm.a / (arm.a + arm.b);
function armUpper(arm) {
    const n = arm.a + arm.b;
    const m = armMean(arm);
    const sd = Math.sqrt((m * (1 - m)) / (n + 1));
    return Math.min(1, m + 2 * sd);
}
const armEvidence = (arm) => (arm.a + arm.b) - 2 * PRIOR;

// ── observe(pickup) ──────────────────────────────────────────────────────
// The update step, derived entirely from the record.
//
// CREDIT ASSIGNMENT, which is the honest part: the channel the answer came
// back on takes the reward. Other channels tried on the same pickup take a
// PARTIAL negative (0.5), not a full one — the carrier may well have seen
// the WhatsApp and chosen to reply by mail, so calling WhatsApp a failure
// would be wrong. If nobody answered, every channel tried takes the full
// negative, because in that case none of them worked.
async function observe(pickup, opts = {}) {
    const p = pickup || {};
    const company = str(p.company);
    if (!company) return null;

    const sent = Array.isArray(p.sent) ? p.sent : [];
    const asks = sent.filter((s) => s && (s.step === 'ask' || s.step === 'chase'));
    if (!asks.length) return null;

    const reward = rewardFor(p);
    const answered = reward > 0;
    const via = str(p.confirmed_via).toLowerCase();
    const answerChannel = /email/.test(via) ? 'email'
        : /whatsapp|wa\b/.test(via) ? 'whatsapp' : null;

    const tried = new Set();
    for (const s of asks) for (const c of str(s.via).split('+')) if (CHANNELS.includes(c)) tried.add(c);

    let minutes = null;
    if (answered && str(p.confirmed_at) && asks[0] && asks[0].at) {
        const t0 = new Date(asks[0].at).getTime();
        const t1 = new Date(p.confirmed_at).getTime();
        if (isFinite(t0) && isFinite(t1) && t1 > t0) minutes = Math.round((t1 - t0) / 60000);
    }

    const k = key(company);
    let out = null;
    await mutateJson(FILE(), EMPTY(), (store) => {
        const s = Object.assign(EMPTY(), store);
        s.carriers = s.carriers || {};
        const c = Object.assign(blank(company), s.carriers[k] || {});
        c.arms = Object.assign({ email: blankArm(), whatsapp: blankArm() }, c.arms || {});

        // Idempotence. The job re-runs hourly and the reply watch polls every
        // five minutes; without this, one reliable reply would look like ten.
        if (p.id && (c.seen_pickups || []).includes(p.id)) { out = c; s.carriers[k] = c; return s; }
        if (p.id) c.seen_pickups = (c.seen_pickups || []).concat([p.id]).slice(-60);

        c.company = company;
        c.asks += 1;
        if (answered) c.answers += 1;
        c.reward_sum = Math.round(((c.reward_sum || 0) + reward) * 1000) / 1000;

        // ── 4. DISCOUNT FIRST, THEN UPDATE ───────────────────────────────
        // Every arm decays toward the prior on every observation, including
        // arms not tried this time. That is what makes the estimate TRACK a
        // carrier who changes, rather than average their whole history.
        for (const ch of CHANNELS) {
            const arm = c.arms[ch];
            arm.a = PRIOR + (arm.a - PRIOR) * GAMMA;
            arm.b = PRIOR + (arm.b - PRIOR) * GAMMA;
        }
        for (const ch of tried) {
            const arm = c.arms[ch];
            if (answerChannel === ch) arm.a += reward;
            else if (answered) arm.b += 0.5;
            else arm.b += 1;
        }

        // ── 5. ONLINE VALUE ESTIMATE for the reply time ──────────────────
        if (minutes != null) {
            c.reply_value = (c.reply_value == null)
                ? minutes
                : Math.round(c.reply_value + ALPHA_LR * (minutes - c.reply_value));
            c.reply_n = Math.min(50, (c.reply_n || 0) * GAMMA + 1);
        }

        if (str(p.contact_email)) c.email = str(p.contact_email);
        if (str(p.contact_whatsapp)) c.whatsapp = str(p.contact_whatsapp);
        c.last_seen = new Date().toISOString();

        s.carriers[k] = c;
        out = c;
        return s;
    }, { strict: true });
    return out;
}

// ── contactsFor(company) ─────────────────────────────────────────────────
// "i cant custom train as per buyer": she records a pickup with a name and
// nothing else, and it is still chaseable.
function contactsFor(company) {
    const c = carrier(load(), company);
    if (!c) return {};
    const out = {};
    if (str(c.email)) out.contact_email = str(c.email);
    if (str(c.whatsapp)) out.contact_whatsapp = str(c.whatsapp);
    return out;
}

// ── profileFor(company) ──────────────────────────────────────────────────
// The policy's view, with the evidence attached — this decides when a
// company she buys from gets mailed, and she is entitled to ask why.
function profileFor(company) {
    const c = carrier(load(), company);
    const base = {
        known: false, asks: 0, answers: 0, answer_rate: null, avg_reward: null,
        typical_reply_minutes: null, chase_after_minutes: null,
        arms: {}, set_aside: [], never_answers: false,
        why: 'no history with this carrier yet',
    };
    if (!c || !c.asks) return base;

    const arms = {};
    for (const ch of CHANNELS) {
        const arm = Object.assign(blankArm(), (c.arms || {})[ch] || {});
        arms[ch] = {
            mean: Math.round(armMean(arm) * 100) / 100,
            upper: Math.round(armUpper(arm) * 100) / 100,
            evidence: Math.round(armEvidence(arm) * 10) / 10,
        };
    }

    // ── 3. SET ASIDE, NEVER CLOSED ───────────────────────────────────────
    // "set_aside" rather than "dropped" is the honest word: adaptChannels
    // still explores it.
    const setAside = [];
    for (const ch of CHANNELS) {
        const other = ch === 'email' ? 'whatsapp' : 'email';
        const arm = Object.assign(blankArm(), (c.arms || {})[ch] || {});
        const otherArm = Object.assign(blankArm(), (c.arms || {})[other] || {});
        // TOMBSTONE: the MIN_EVIDENCE clause is belt-and-braces and a
        // mutation of it SURVIVES. Below the floor the lowest reachable
        // upper bound is 0.48, already above DEAD_UPPER (0.40), so the
        // evidence requirement is logically implied by the bound test. Kept
        // because it states the intent and stays correct if either constant
        // moves; deliberately NOT registered as a mutation.
        if (armEvidence(arm) >= MIN_EVIDENCE
            && armUpper(arm) < DEAD_UPPER
            && armMean(otherArm) >= ALIVE_MEAN) setAside.push(ch);
    }
    // TOMBSTONE: also unkillable, also kept. For BOTH channels to qualify,
    // each needs the other's mean >= 0.35 while its own upper is < 0.40 —
    // and since upper always exceeds mean, that needs ~364 observations of
    // one carrier. adaptChannels has the real last-channel guard, which IS
    // killable and is registered.
    const aside = setAside.length < CHANNELS.length ? setAside : [];

    const reply = (c.reply_n || 0) >= MIN_EVIDENCE ? c.reply_value : null;
    const chaseAfter = reply == null ? null
        : Math.max(EARLIEST_CHASE_MIN, Math.round(reply * 1.5));

    const rate = c.asks ? c.answers / c.asks : null;
    return {
        known: true,
        asks: c.asks, answers: c.answers,
        answer_rate: rate == null ? null : Math.round(rate * 100) / 100,
        avg_reward: Math.round(((c.reward_sum || 0) / c.asks) * 100) / 100,
        typical_reply_minutes: reply,
        chase_after_minutes: chaseAfter,
        arms, set_aside: aside,
        never_answers: c.asks >= 4 && c.answers === 0,
        why: reply != null
            ? `${c.answers} of ${c.asks} answered, usually in about ${reply} minutes`
            : `${c.answers} of ${c.asks} answered`,
    };
}

// ── 3. e-GREEDY EXPLORATION ──────────────────────────────────────────────
// How often a set-aside channel is retried anyway. Decays as evidence
// accumulates, but never reaches zero, so a channel that starts working
// again is always found.
//
// `rng` is injectable so a test can stand on both sides of the coin. Without
// that, exploration is the one part of the policy nobody could check.
function exploreRate(profile, channel) {
    const arm = (profile && profile.arms && profile.arms[channel]) || null;
    const evidence = arm ? Math.max(0, arm.evidence) : 0;
    return Math.max(EXPLORE_FLOOR, 1 / (1 + evidence));
}

// ── adaptChannels(channels, profile, opts) ───────────────────────────────
// Applied to what pickupAgent worked out, never instead of it. Refuses to
// return nothing: if setting a channel aside would leave no way to reach
// them, the original stands.
function adaptChannels(channels, profile, opts = {}) {
    const ch = Object.assign({}, channels || {});
    const prof = profile || {};
    const aside = prof.set_aside || [];
    if (!ch.reachable || !aside.length) return ch;

    const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
    const next = Object.assign({}, ch);
    const explored = [];
    const quieted = [];

    for (const dead of aside) {
        if (rng() < exploreRate(prof, dead)) { explored.push(dead); continue; }
        next[dead] = null;
        quieted.push(dead);
    }
    if (!next.email && !next.whatsapp) return ch;   // never the last one

    next.reachable = true;
    if (quieted.length) next.set_aside = quieted;
    // Surfaced, because an exploration nobody can see is a cost with no
    // visible benefit.
    if (explored.length) next.exploring = explored;
    return next;
}

module.exports = {
    observe, contactsFor, profileFor, adaptChannels, rewardFor, exploreRate,
    armMean, armUpper, armEvidence, key, FILE,
    GAMMA, PRIOR, ALPHA_LR, MIN_EVIDENCE, DEAD_UPPER, ALIVE_MEAN, EXPLORE_FLOOR,
    EARLIEST_CHASE_MIN, LATEST_CHASE_HOUR, CHANNELS,
};
