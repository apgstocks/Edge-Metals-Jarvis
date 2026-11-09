// ── helpers/bookingDates.js — which active bookings still lack ERD / cutoff ──
// Apsara, 2026-11-09: "if a date as ERD/cutoff is missing in jarvis, enforce a
// rule to monitor unless these are filled." One definition, used by the daily
// watch (scheduler.js datesWatch) and the 06:30 sweep, so they cannot
// disagree. Read-only. Edge Metals bookings only (the yard has none).
const { loadBookings, loadWorkflow } = require('./json');

const blank = (v) => !String(v == null ? '' : v).trim();

function missing() {
    const wfAll = loadWorkflow() || {};
    return Object.values(loadBookings() || {})
        .filter((b) => b && b.booking_number)
        .map((b) => ({ b, miss: [blank(b.erd_date) && 'ERD', blank(b.cutoff_date) && 'cutoff'].filter(Boolean) }))
        .filter((x) => x.miss.length)
        .map(({ b, miss }) => {
            const wf = wfAll[b.booking_number] || {};
            const who = [b.supplier || wf.supplier, wf.trucker_name && `trucker ${wf.trucker_name}`,
                         b.port_of_loading && `from ${b.port_of_loading}`].filter(Boolean).join(', ');
            return { booking: b.booking_number, miss, who,
                     detail: `no ${miss.join(' or ')}` + (who ? ` (${who})` : '') };
        });
}

// One short line for the morning digest: numbers only, capped. '' when none.
function digestLine(list = missing(), cap = 6) {
    if (!list.length) return '';
    const shown = list.slice(0, cap).map((x) => x.booking).join(', ');
    const more = list.length > cap ? ` +${list.length - cap} more` : '';
    return `NO ERD/CUTOFF (${list.length}): ${shown}${more}`;
}

module.exports = { missing, digestLine };
