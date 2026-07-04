// ── helpers/time.js — Date / time utilities (LA timezone) ────────────────────
// All freight dates are MM/DD/YYYY, all deadlines evaluated in America/Los_Angeles.

function getLADate() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
}

function getLATime(date = new Date()) {
    return date.toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles',
        month: '2-digit', day: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: true,
    });
}

// Days until MM/DD/YYYY date. 0 = today, negative = past, 999 = unparseable.
function daysUntil(dateStr) {
    try {
        const [m, d, y] = String(dateStr).split('/');
        const target = new Date(y, m - 1, d);
        if (isNaN(target)) return 999;
        const today = getLADate(); today.setHours(0, 0, 0, 0);
        return Math.ceil((target - today) / 86400000);
    } catch { return 999; }
}

// Parse MM/DD/YYYY → Date (midnight local), or null
function parseUSDate(dateStr) {
    try {
        const [m, d, y] = String(dateStr).split('/');
        const dt = new Date(y, m - 1, d);
        return isNaN(dt) ? null : dt;
    } catch { return null; }
}

// "in 30 min", "today 3pm", "tomorrow 9:30am", "5pm" → Date (LA), or null
function parseNaturalTime(text) {
    const now   = getLADate();
    const lower = String(text).toLowerCase().trim();

    const mins = lower.match(/in\s+(\d+)\s+min/);
    if (mins) { const d = new Date(now); d.setMinutes(d.getMinutes() + +mins[1]); return d; }

    const hrs = lower.match(/in\s+(\d+)\s+hour/);
    if (hrs) { const d = new Date(now); d.setHours(d.getHours() + +hrs[1]); return d; }

    const clock = (m, dayOffset) => {
        const d = new Date(now);
        d.setDate(d.getDate() + dayOffset);
        let hour = +m[1];
        const min = +(m[2] || 0);
        const ampm = m[3].toLowerCase();
        if (ampm === 'pm' && hour !== 12) hour += 12;
        if (ampm === 'am' && hour === 12) hour = 0;
        d.setHours(hour, min, 0, 0);
        return d;
    };

    let m;
    if ((m = lower.match(/today.*?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i)))    return clock(m, 0);
    if ((m = lower.match(/tomorrow.*?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i))) return clock(m, 1);
    if ((m = lower.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i)))          return clock(m, 0);

    return null;
}

module.exports = { getLADate, getLATime, daysUntil, parseUSDate, parseNaturalTime };
