// ── helpers/pickupAgent.js — did the truck actually turn up? ─────────────
// Apsara, 2026-11-06:
//   "if i book a shipment pickup with a logistics company,say pickup arranged
//    @11/05 say on that particular day,it should follow up with the logistic
//    company about the pickup eta na? if no response,it needs to follow up and
//    communicate the same to my team"
//
// ── WHY THIS DID NOT ALREADY HAPPEN ──────────────────────────────────────
// It is not that Jarvis ignored the pickup. It never had one. Before today
// `pickup_date` existed in exactly two places: a box typed onto a BOL, and a
// column in the AJ Transport invoice log. Neither is a live record of an
// arrangement — both are a field on a document, written once and read by a
// printer. There was no date for a job to wake up on and no thread to chase.
//
// The chasing machinery, by contrast, has existed for months:
// workflow/quoteRequests.js already emails truckers and chases the ones who
// go quiet; workflow/emailReplyWatch.js already notices a reply landing.
// What was missing was the thing in the middle.
//
// ── WHAT THIS FILE IS, AND WHAT IT IS NOT ────────────────────────────────
// This is the DECISION only: given a pickup and the time now, what — if
// anything — is due. It sends nothing, reads no store, and requires nothing
// but the date helpers.
//
// That is deliberate and it is the helpers/bankMatch.js rule again: the file
// that decides is kept free of the machinery that acts, so the decision can
// be tested exhaustively without a network, a mailbox or a WhatsApp session.
// Sending lives in helpers/pickupAgentJob.js, which injects its senders.
//
// ── THE LADDER SHE ASKED FOR ─────────────────────────────────────────────
// Asked when her team should hear about silence, she chose: "Chase twice,
// then tell the team."  So, on the pickup day and in LA time, which is the
// timezone every freight deadline in this app is evaluated in:
//
//     08:00   ASK       "what time is the truck coming?"
//     11:00   CHASE     only if nobody has answered
//     14:00   ESCALATE  the team is told it is unconfirmed
//
// Then it STOPS. A pickup that was never confirmed is escalated ONCE. An
// agent that keeps shouting is an agent she turns off, and the escalation
// has already done its job — a person now knows.
//
// ── THE THINGS IT REFUSES TO DO ──────────────────────────────────────────
//   * It never chases before the pickup day. A truck booked for the 11th is
//     not late on the 10th, and asking makes Jarvis look like it cannot read
//     a calendar.
//   * It never chases a pickup that is cancelled, done, or already has an
//     ETA. An answered question asked again is how a supplier learns to
//     ignore the sender.
//   * It never invents a contact. A pickup with nothing to send to is
//     reported to her as unreachable, not quietly skipped — the silent skip
//     is what made this whole feature necessary in the first place.
const { getLADate } = require('./time');

// ── THE LADDER, IN ONE PLACE ─────────────────────────────────────────────
// Hours are LA local on the pickup day. Named rather than inlined because
// the next conversation about this will be "make the first ask earlier", and
// that should be one edit in a place she can be shown.
const LADDER = [
    { step: 'ask',      hour: 8,  what: 'first ask: what time is the truck coming' },
    { step: 'chase',    hour: 11, what: 'chase: nobody has answered' },
    { step: 'escalate', hour: 14, what: 'tell the team: the pickup is unconfirmed' },
];

// A pickup in one of these is finished with. Nothing is sent about it.
const CLOSED = ['done', 'collected', 'cancelled'];

const str = (v) => String(v == null ? '' : v).trim();

// ── DATES ────────────────────────────────────────────────────────────────
// Bookings in this app store MM/DD/YYYY; everything computed stores
// YYYY-MM-DD. Both are accepted because the two entry points she asked for
// — Jarvis arranging it, and a person recording it — will not agree, and a
// pickup silently dropped for a date format is the failure mode this whole
// feature exists to stop.
function isoDay(v) {
    const s = str(v);
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    return null;
}

// "now" as { day: 'YYYY-MM-DD', hour: 0-23 } in LA. `now` is injectable so
// the tests can stand at 10:59 and at 11:00 without waiting three hours.
function laNow(now) {
    const d = now ? new Date(now) : getLADate();
    if (isNaN(d.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit',
        day: '2-digit', hour: '2-digit', hour12: false,
    }).formatToParts(d).reduce((o, p) => (o[p.type] = p.value, o), {});
    // Intl returns hour '24' for midnight in some ICU builds.
    const hour = Number(parts.hour) % 24;
    return { day: `${parts.year}-${parts.month}-${parts.day}`, hour };
}

// Which rungs are due by this hour, latest first.
const rungsDueAt = (hour) => LADDER.filter((r) => hour >= r.hour).reverse();

// ── nextAction(pickup, now) ──────────────────────────────────────────────
// The whole decision. Returns:
//   { step: null, why }                       nothing is due
//   { step: 'ask'|'chase'|'escalate', why, … } this is due now
//
// `pickup.sent` is the record of what has already gone out: an array of
// { step, at }. The job appends to it. Re-running the job an hour later must
// not send the same rung twice, and that is checked HERE rather than at the
// send site, so a second caller (a manual "chase now" button, a retry after
// a crash) cannot bypass it.
function nextAction(pickup, now) {
    const p = pickup || {};
    const t = laNow(now);
    if (!t) return { step: null, why: 'the time could not be read' };

    const day = isoDay(p.pickup_date);
    if (!day) return { step: null, why: 'this pickup has no readable date' };

    const status = str(p.status).toLowerCase();
    if (CLOSED.includes(status)) return { step: null, why: `pickup is ${status}` };

    // ── ALREADY ANSWERED ─────────────────────────────────────────────────
    // An ETA is the answer to the question. Asking again after it arrives is
    // how a logistics company learns to ignore Jarvis's mail, which costs
    // her the next pickup as well as this one.
    if (str(p.eta) || str(p.confirmed_at)) {
        return { step: null, why: 'the company has already given an ETA' };
    }

    if (day > t.day) return { step: null, why: `pickup is on ${day}, not today` };

    // ── AFTER THE DAY ────────────────────────────────────────────────────
    // A pickup whose day has passed with no ETA is the worst case, not a
    // closed one. It escalates ONCE — if the team was never told, tell them
    // now; if they were, stop. A job that re-escalates every morning is a
    // job she mutes, and a muted job is the same as no job.
    const done = new Set((Array.isArray(p.sent) ? p.sent : []).map((s) => str(s && s.step)));
    if (day < t.day) {
        if (done.has('escalate')) return { step: null, why: 'the team has already been told' };
        return { step: 'escalate', why: `the pickup day (${day}) has passed with no ETA`, overdue: true };
    }

    // ── ON THE DAY ───────────────────────────────────────────────────────
    for (const rung of rungsDueAt(t.hour)) {
        if (done.has(rung.step)) continue;
        // The rungs are ordered, so a later one being due does not let an
        // earlier one be skipped: if the job was down all morning and wakes
        // at 14:00, it asks FIRST. Escalating to her team about a company
        // Jarvis never actually asked would be indefensible.
        const earlierMissing = LADDER
            .slice(0, LADDER.findIndex((r) => r.step === rung.step))
            .find((r) => !done.has(r.step));
        const use = earlierMissing || rung;
        return { step: use.step, why: use.what, day, hour: t.hour,
            caughtUp: !!earlierMissing };
    }
    return { step: null, why: `nothing is due yet (it is ${t.hour}:00 in LA)` };
}

// ── WHO TO SEND IT TO ────────────────────────────────────────────────────
// She chose BOTH email and WhatsApp. Both are attempted; the job reports
// what it could not reach rather than deciding one is enough.
//
// A pickup with neither is NOT silently skipped. It comes back as
// reachable:false with the reason, and the job tells her — being quietly
// dropped for a missing field is exactly the behaviour she is complaining
// about.
function channelsFor(pickup) {
    const p = pickup || {};
    const email = str(p.contact_email);
    const wa = str(p.contact_whatsapp);
    const out = { email: email || null, whatsapp: wa || null, reachable: !!(email || wa) };
    if (!out.reachable) {
        out.why = `no email and no WhatsApp number on file for ${str(p.company) || 'this logistics company'}`;
    }
    return out;
}

// ── WHAT IT SAYS ─────────────────────────────────────────────────────────
// Plain, short, and it always names the container and the date — a chaser
// that says "any update?" makes the reader go and look up which job it is,
// which is how a chase gets left for later.
//
// It never states a time it has not been told, and never says "urgent" on
// the first ask. The escalation is the only one that raises its voice, and
// it is addressed to her team, not to the company.
function messageFor(pickup, step) {
    const p = pickup || {};
    const who = str(p.company) || 'the carrier';
    const ref = [str(p.container_no), str(p.booking_no)].filter(Boolean).join(' / ') || 'the load';
    const where = str(p.location);
    const day = isoDay(p.pickup_date) || str(p.pickup_date);
    const at = where ? ` from ${where}` : '';

    if (step === 'ask') {
        return { subject: `Pickup today — ${ref}`,
            body: `Good morning,\n\nPickup for ${ref}${at} is booked with you for today, ${day}.\n\n`
                + `Could you confirm the ETA for the truck?\n\nThank you.` };
    }
    if (step === 'chase') {
        return { subject: `Re: Pickup today — ${ref}`,
            body: `Following up on this morning's note.\n\n`
                + `We still do not have an ETA for the pickup of ${ref}${at}, booked for today, ${day}.\n\n`
                + `Could you let us know what time the truck is coming?` };
    }
    // ── ESCALATION: TO THE TEAM, ABOUT THE COMPANY ───────────────────────
    // It says what was asked and when, so nobody has to go and read the
    // thread to find out whether Jarvis actually chased before shouting.
    const asks = (Array.isArray(p.sent) ? p.sent : [])
        .filter((s) => s && (s.step === 'ask' || s.step === 'chase')).length;
    return { subject: `Pickup unconfirmed — ${ref} (${who})`,
        body: `${who} has not confirmed an ETA for the pickup of ${ref}${at}, booked for ${day}.\n\n`
            + `Jarvis asked ${asks === 1 ? 'once' : `${asks} times`} today and has had no reply.\n\n`
            + `Someone needs to call them.` };
}

module.exports = { nextAction, channelsFor, messageFor, isoDay, laNow, LADDER, CLOSED };
