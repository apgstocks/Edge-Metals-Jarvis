// ── helpers/pickupLearn.js — the carrier teaches Jarvis, not Apsara ──────
// Apsara, 2026-11-06, in four messages:
//   "it should learn and adapt"
//   "i cant custom train as per buyer.it should learn and adapt"
//   "reinforcement"   "learning"   "adaptiv learning"
//
// The complaint underneath is specific and fair: a settings page with a row
// per carrier is work she will never do. Zimex answers in twenty minutes on
// WhatsApp; A.LEE answers next morning by email; one of them has not
// answered at all this year. None of that should be typed in. It is all
// visible in what already happened.
//
// ── WHAT "REINFORCEMENT" HONESTLY MEANS HERE ─────────────────────────────
// Not a neural net, and this file does not pretend otherwise. Every pickup
// produces a labelled outcome on its own: Jarvis asked on these channels at
// this time, and either an answer came back — on a known channel, after a
// measurable delay — or the day ended with none. That is a reward signal,
// recorded per carrier, and the next pickup for that carrier is run
// differently because of it. The feedback loop is real even though the
// machinery is arithmetic.
//
// Arithmetic on purpose. This decides when Jarvis mails a company she buys
// from; it has to be inspectable when she asks "why did you chase them at
// half nine", and "the median of its last nine replies was 22 minutes" is an
// answer. A model's hunch is not.
//
// ── THE THREE THINGS IT LEARNS ───────────────────────────────────────────
//   1. HOW TO REACH THEM. The direct answer to "i cant custom train as per
//      buyer": she records "pickup with Zimex Friday" and the address is
//      already known, from the last mail they sent. No more unreachable
//      pickups for a carrier Jarvis has dealt with before.
//   2. WHICH CHANNEL THEY ANSWER ON. A channel that has been tried enough
//      times and NEVER worked stops being used, when the other one does.
//   3. HOW LONG THEY TAKE. The chase moves to when an answer is actually
//      overdue for THIS carrier, instead of a fixed three hours for
//      everyone.
//
// ── WHAT IT IS NOT ALLOWED TO LEARN ──────────────────────────────────────
// Her instruction was "Chase twice, then tell the team". Learning tunes the
// WHEN and the HOW; it never removes a rung, never stops the ask, never
// moves the escalation off the pickup day, and can never leave a carrier
// with no channel at all. A system that learns its way into silence is worse
// than one that never learned anything, because she would stop checking.
const path = require('path');
const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

const FILE = () => cfg.PICKUP_LEARN_FILE || path.join(cfg.DATA_DIR, 'pickup-learn.json');

const str = (v) => String(v == null ? '' : v).trim();
const key = (company) => str(company).toLowerCase().replace(/\s+/g, ' ');

// ── THE BOUNDS, IN ONE PLACE ─────────────────────────────────────────────
// Every one of these exists to stop a confident conclusion from a handful of
// events. The first pickups with a new carrier behave exactly as they do
// today, and the behaviour only moves once there is something to move it.
const MIN_FOR_TIMING = 3;    // replies before the chase hour is allowed to move
const MIN_TRIES_TO_DROP = 4; // sends on a channel with no answer before dropping it
const MIN_WINS_TO_PREFER = 2; // answers on the OTHER channel before that counts
const KEEP_SAMPLES = 20;     // a carrier that changes dispatcher should not be
                             // judged on last year — the window forgets.
// ── TOMBSTONE: THIS BOUND IS CURRENTLY UNREACHABLE (2026-11-06) ──────────
// Intent: never chase within an hour of asking. Real, and it reads as the
// guard that stops a 20-minute carrier being nagged at 08:20.
//
// It is not what stops that. pickupAgent's ladder is HOUR-GRANULAR and the
// learned hour goes through Math.ceil, so a median of 4 minutes gives
// ceil(8.1) = 9 and a median of 60 gives ceil(9.0) = 9 — identical. Setting
// this to 0 changes nothing and a mutation of it SURVIVES, which by the rule
// in this repo means it is guarding nothing.
//
// Kept rather than deleted: it documents the intent, and it becomes load
// bearing the moment the ladder gains sub-hour precision. Deliberately NOT
// registered in scripts/mutate.js — an unkillable mutation in the baseline
// is a lie about coverage.
const EARLIEST_CHASE_MIN = 60;
const LATEST_CHASE_HOUR = 13;    // and never so late it crowds the 14:00 escalation

const EMPTY = () => ({ carriers: {} });
const load = () => Object.assign(EMPTY(), loadJson(FILE(), EMPTY()));

function carrier(store, company) {
    const k = key(company);
    return (store.carriers && store.carriers[k]) || null;
}

const median = (nums) => {
    const a = (nums || []).filter((n) => typeof n === 'number' && isFinite(n) && n >= 0).sort((x, y) => x - y);
    if (!a.length) return null;
    const mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
};

// ── observe(pickup) ──────────────────────────────────────────────────────
// Called once a pickup is finished with — answered, or its day gone. This is
// the reward signal, and it is derived ENTIRELY from the record rather than
// from anything a person types.
//
// Deliberately idempotent-ish: a pickup already observed is skipped, so a
// re-run of the job cannot teach the same lesson twice and make a carrier
// look twice as reliable as it is.
async function observe(pickup) {
    const p = pickup || {};
    const company = str(p.company);
    if (!company) return null;

    const sent = Array.isArray(p.sent) ? p.sent : [];
    const asks = sent.filter((s) => s && (s.step === 'ask' || s.step === 'chase'));
    if (!asks.length) return null;           // nothing was tried; nothing to learn

    const answered = !!(str(p.eta) || str(p.confirmed_at));
    // Which channel the answer came back on. 'email reply' is what the reply
    // watch records; anything she types by hand is not a channel lesson —
    // the carrier did not choose it, she did.
    const via = str(p.confirmed_via).toLowerCase();
    const answerChannel = /email/.test(via) ? 'email'
        : /whatsapp|wa\b/.test(via) ? 'whatsapp' : null;

    // Minutes from the FIRST ask to the answer. The first, not the last:
    // what is being learned is how long this carrier takes to respond to
    // being asked, not how quickly they answer a nag.
    let minutes = null;
    if (answered && str(p.confirmed_at) && asks[0] && asks[0].at) {
        const t0 = new Date(asks[0].at).getTime();
        const t1 = new Date(p.confirmed_at).getTime();
        if (isFinite(t0) && isFinite(t1) && t1 > t0) minutes = Math.round((t1 - t0) / 60000);
    }

    // Which channels were actually tried, from what was recorded as sent.
    const tried = new Set();
    for (const s of asks) for (const c of str(s.via).split('+')) if (c) tried.add(c);

    const k = key(company);
    let out = null;
    await mutateJson(FILE(), EMPTY(), (store) => {
        const s = Object.assign(EMPTY(), store);
        s.carriers = s.carriers || {};
        const c = s.carriers[k] || { company, asks: 0, answers: 0,
            tried: {}, answered_on: {}, reply_minutes: [], seen_pickups: [] };

        // The guard against learning the same pickup twice.
        if (p.id && (c.seen_pickups || []).includes(p.id)) { out = c; s.carriers[k] = c; return s; }
        if (p.id) c.seen_pickups = (c.seen_pickups || []).concat([p.id]).slice(-KEEP_SAMPLES * 2);

        c.company = company;                 // keep her spelling, not the key
        c.asks += 1;
        for (const t of tried) c.tried[t] = (c.tried[t] || 0) + 1;
        if (answered) {
            c.answers += 1;
            if (answerChannel) c.answered_on[answerChannel] = (c.answered_on[answerChannel] || 0) + 1;
            if (minutes != null) c.reply_minutes = (c.reply_minutes || []).concat([minutes]).slice(-KEEP_SAMPLES);
        }
        // Contacts worth keeping, so she never types them again.
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
// "i cant custom train as per buyer". She records a pickup with a name and
// nothing else; this is how it still gets chased.
function contactsFor(company) {
    const c = carrier(load(), company);
    if (!c) return {};
    const out = {};
    if (str(c.email)) out.contact_email = str(c.email);
    if (str(c.whatsapp)) out.contact_whatsapp = str(c.whatsapp);
    return out;
}

// ── profileFor(company) ──────────────────────────────────────────────────
// What has been learned, and what it means for the next pickup. Every field
// comes back with the evidence behind it, because this decides when a
// company she buys from gets mailed and she is entitled to ask why.
function profileFor(company) {
    const c = carrier(load(), company);
    const base = {
        known: false, asks: 0, answers: 0, answer_rate: null,
        typical_reply_minutes: null, chase_after_minutes: null,
        drop_channels: [], never_answers: false, why: 'no history with this carrier yet',
    };
    if (!c || !c.asks) return base;

    const rate = c.asks ? c.answers / c.asks : null;
    const med = median(c.reply_minutes);

    // ── WHEN TO CHASE ────────────────────────────────────────────────────
    // Half again their usual reply time: late enough that an answer is
    // genuinely overdue, early enough to be useful. Floored at an hour so a
    // fast carrier is not nagged, and it never outgrows the escalation.
    let chaseAfter = null;
    if (med != null && (c.reply_minutes || []).length >= MIN_FOR_TIMING) {
        chaseAfter = Math.max(EARLIEST_CHASE_MIN, Math.round(med * 1.5));
    }

    // ── A CHANNEL THAT HAS NEVER WORKED ──────────────────────────────────
    // Dropped only on real evidence: tried enough times with nothing back,
    // while the other channel has actually produced answers. And never the
    // last one standing — a carrier with no channel is a pickup nobody
    // chases, which is the fault this whole feature exists to fix.
    const drop = [];
    for (const ch of ['email', 'whatsapp']) {
        const other = ch === 'email' ? 'whatsapp' : 'email';
        const tries = (c.tried && c.tried[ch]) || 0;
        const wins = (c.answered_on && c.answered_on[ch]) || 0;
        const otherWins = (c.answered_on && c.answered_on[other]) || 0;
        if (tries >= MIN_TRIES_TO_DROP && wins === 0 && otherWins >= MIN_WINS_TO_PREFER) drop.push(ch);
    }
    const dropChannels = drop.length < 2 ? drop : [];

    // ── THE ONE THAT CHANGES THE WORDS, NOT THE POLICY ───────────────────
    // A carrier that never answers is not chased less — her rule stands —
    // but the note to her team says so, because "they have answered 1 of
    // the last 8" is the sentence that makes someone pick up the phone.
    const neverAnswers = c.asks >= MIN_TRIES_TO_DROP && c.answers === 0;

    return {
        known: true,
        asks: c.asks, answers: c.answers,
        answer_rate: rate == null ? null : Math.round(rate * 100) / 100,
        typical_reply_minutes: med,
        chase_after_minutes: chaseAfter,
        drop_channels: dropChannels,
        never_answers: neverAnswers,
        why: med != null
            ? `${c.answers} of ${c.asks} answered, usually in about ${med} minutes`
            : `${c.answers} of ${c.asks} answered`,
    };
}

// ── adaptChannels(channels, profile) ─────────────────────────────────────
// Applied to what pickupAgent worked out, never instead of it. Refuses to
// return nothing: if dropping would leave no way to reach them, the drop is
// ignored and the original stands.
function adaptChannels(channels, profile) {
    const ch = Object.assign({}, channels || {});
    const prof = profile || {};
    if (!ch.reachable || !(prof.drop_channels || []).length) return ch;

    const next = Object.assign({}, ch);
    for (const dead of prof.drop_channels) next[dead] = null;
    if (!next.email && !next.whatsapp) return ch;    // never the last one
    next.reachable = true;
    next.dropped = prof.drop_channels.slice();
    return next;
}

module.exports = { observe, contactsFor, profileFor, adaptChannels, median, key, FILE,
    MIN_FOR_TIMING, MIN_TRIES_TO_DROP, MIN_WINS_TO_PREFER, EARLIEST_CHASE_MIN, LATEST_CHASE_HOUR };
