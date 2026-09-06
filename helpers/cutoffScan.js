// ── helpers/cutoffScan.js — which bookings are past their cutoff ──────────
//
// Apsara, 2026-09-06: "If i say jarvis-run a scan for booking that are past
// cut off date, it shuld run a test and archive those bookings automaticlaly."
//
// WHAT ALREADY EXISTED
// --------------------
// scheduler.js:autoArchive() — the nightly 11PM job. It has scanned, archived
// and notified for weeks, and its rule is the product of a real correction
// from her (2026-08-01: a container still showing not_started on an expired
// booking is stale data, not work in progress, so container state does NOT
// hold a past-cutoff booking open).
//
// It is exported and called from NOWHERE except its own cron registration.
// There is no intent, no route, no way to ask for it. That is the gap.
//
// WHY THE RULE MOVED HERE
// -----------------------
// The obvious implementation is a second scan in actions.js that finds
// past-cutoff bookings and archives them. That is two definitions of "past
// cutoff", and the failure is specific and nasty: the on-demand preview shows
// her one set of bookings and the nightly job archives a different set. She
// would have no way to tell which was right.
//
// So the RULE lives here, once, and both callers use it. scheduler.js keeps
// the schedule and the notifications; this file only answers "which ones".
//
// It reads and returns; it archives nothing. Every caller decides for itself
// whether a human confirms first — the nightly job does not (nobody is
// awake), the on-demand scan does (she is right there, and a batch archive
// she did not expect is a bad surprise).
const { loadBookings, loadWorkflow } = require('./json');
const { daysUntil } = require('./time');

// A booking is past cutoff when the date has been gone for a full day.
//
// `> -1`, copied EXACTLY from scheduler.js rather than rewritten as `>= 0` or
// `> 0`. They are not the same, and the difference is a booking archived on
// the afternoon of its own cutoff — while the container is still gateable.
// Recorded as a constant so the two callers cannot drift apart by one day.
const PAST_BY_DAYS = -1;

// Returns [{ bkgNo, booking, wf, days, cutoff }], soonest-expired first.
//
// `days` is negative — -3 means the cutoff passed three days ago — which is
// what daysUntil returns and what the scheduler compares against. Converting
// it to a positive "days ago" here would be tidier to read and would be a
// third representation of the same fact.
function pastCutoff() {
    const bookings = loadBookings() || {};
    const workflow = loadWorkflow() || {};
    const out = [];

    for (const [bkgNo, b] of Object.entries(bookings)) {
        // No cutoff date, no judgement. The nightly backfill job runs at
        // 10:45PM specifically to fill these in from mail BEFORE the archive
        // check at 11PM, so a booking with no cutoff is one that could not be
        // determined — not one that has expired.
        if (!b || !b.cutoff_date) continue;
        const days = daysUntil(b.cutoff_date);
        // Character-for-character the scheduler's `if (d > -1) continue;`.
        // I first wrote this as a two-clause condition that was both harder
        // to read and not obviously equivalent — and "not obviously
        // equivalent" is exactly the property that must not appear in the one
        // rule two archive paths share.
        if (days > PAST_BY_DAYS) continue;
        const wf = workflow[bkgNo] || {};
        // Her explicit hold. Anything flagged keep_active stays, and it stays
        // on BOTH paths — an on-demand scan that ignored the flag would undo
        // a decision she made on purpose.
        if (wf.keep_active) continue;
        out.push({ bkgNo, booking: b, wf, days, cutoff: b.cutoff_date });
    }

    // Longest expired first: that is the order she would work through them,
    // and it makes the list stable between the preview and the archive.
    out.sort((a, b) => a.days - b.days);
    return out;
}

// Kept separate so a caller can say "3 bookings, oldest 12 days past" without
// building the sentence itself, and so the spoken and written versions agree.
function describe(rows) {
    if (!rows || !rows.length) return 'Nothing is past its cutoff.';
    const oldest = rows[0];
    const n = rows.length;
    return `${n} booking${n === 1 ? '' : 's'} past cutoff`
        + `, oldest ${Math.abs(oldest.days)} day${Math.abs(oldest.days) === 1 ? '' : 's'} ago.`;
}

module.exports = { pastCutoff, describe, PAST_BY_DAYS };
