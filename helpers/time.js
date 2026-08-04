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

// REAL GAP (found 2026-08-04, live): "email Mathew at 7am LA time whether
// they've reached pickup" needed a way to schedule the SEND itself for
// later, not just resolve a relative date mentioned inside the email's own
// content (that's todayDateContext's job, in workflow/actions.js — a
// separate, already-solved problem). This is deliberately still a
// deterministic parser, not an AI guess — same reasoning as every other
// "AI extracts the raw phrase, code does the actual math" split already
// used in this app (target_name/email_details grounding checks, etc.):
// Gemini is good at pulling "next monday at 9am" out of a longer sentence,
// but resolving that into an exact timestamp is exactly the kind of thing
// an LLM gets subtly wrong and is hard to catch after the fact. Extended
// 2026-08-04 with day-of-week and "in N days" support (previously only
// "in N min/hour", "today/tomorrow HH:MMam/pm", and a bare "5pm").
// Always resolves to a moment in the FUTURE relative to `now` — if a bare
// time/day has already passed today, it rolls to the next occurrence
// (tomorrow for a clock time, next week for a weekday), matching how a
// person means "5pm" or "Monday" when they say it in passing.
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// Converts LA WALL-CLOCK components (year, month 0-based, day, hour,
// minute) into the actual correct real-world Date for that moment, using
// Intl's real America/Los_Angeles UTC offset at that specific date (DST-
// aware — LA is UTC-7 or UTC-8 depending on time of year). Deliberately
// NOT the getLADate() "format as LA, re-parse as system-local" trick used
// elsewhere in this file: that trick only stays correct as long as its
// result is exclusively compared against OTHER getLADate()-derived values
// (which is all daysUntil/stallWatch/etc. ever do). The value returned
// here is going to be serialized (.toISOString()) and stored as a
// scheduled task's fire_at, then later compared against a REAL `new
// Date()` in helpers/tasks.js's dueTasks() — that comparison would be
// silently wrong by however many hours the deploy box's own system
// timezone differs from America/Los_Angeles if this weren't computed
// properly. Standard double-conversion technique, no new dependency.
function laWallClockToUTC(year, month0, day, hour, minute) {
    const guessUTC = Date.UTC(year, month0, day, hour, minute);
    const asLA = new Date(guessUTC).toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles', hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    const [datePart, timePart] = asLA.split(', ');
    const [mm, dd, yy] = datePart.split('/').map(Number);
    let [hh, mi] = timePart.split(':').map(Number);
    if (hh === 24) hh = 0; // some locales render midnight as "24:00"
    const asLAUTC = Date.UTC(yy, mm - 1, dd, hh, mi);
    return new Date(guessUTC + (guessUTC - asLAUTC));
}

function parseNaturalTime(text) {
    const now = getLADate(); // fine here — only used to READ today's LA calendar/weekday, never returned directly
    // Every schedule in this app already runs in America/Los_Angeles (see
    // module comment) — a manager-typed timezone qualifier is always
    // redundant, never a real "different timezone" instruction. Strip it
    // before matching so "7am LA time"/"7 pm PST"/"9am pacific" reduce to
    // plain "7am"/"7 pm"/"9am" for the patterns below, instead of silently
    // failing to match because of trailing text after am/pm.
    const lower = String(text).toLowerCase().trim()
        .replace(/\b(la|los angeles|pacific|pst|pdt)\s*time\b/g, '')
        .replace(/\b(pst|pdt)\b/g, '')
        .trim();

    // Relative-to-real-now spans are timezone-agnostic by construction —
    // "in 30 minutes" means the same real moment no matter what timezone
    // anyone involved is in, so these use the REAL clock directly rather
    // than routing through LA wall-clock conversion at all.
    const mins = lower.match(/in\s+(\d+)\s+min/);
    if (mins) return new Date(Date.now() + (+mins[1]) * 60000);

    const hrs = lower.match(/in\s+(\d+)\s+hour/);
    if (hrs) return new Date(Date.now() + (+hrs[1]) * 3600000);

    const days = lower.match(/in\s+(\d+)\s+day/);
    if (days) return new Date(Date.now() + (+days[1]) * 86400000);

    const toHour24 = (h, ampm) => {
        let hour = +h;
        if (ampm === 'pm' && hour !== 12) hour += 12;
        if (ampm === 'am' && hour === 12) hour = 0;
        return hour;
    };

    let m;
    if ((m = lower.match(/today.*?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i))) {
        return laWallClockToUTC(now.getFullYear(), now.getMonth(), now.getDate(), toHour24(m[1], m[3].toLowerCase()), +(m[2] || 0));
    }
    if ((m = lower.match(/tomorrow.*?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i))) {
        const d = new Date(now); d.setDate(d.getDate() + 1);
        return laWallClockToUTC(d.getFullYear(), d.getMonth(), d.getDate(), toHour24(m[1], m[3].toLowerCase()), +(m[2] || 0));
    }

    // Day-of-week, with or without "next"/"this", with or without a clock
    // time attached ("monday", "next monday", "monday at 9am", "this
    // friday 3:30pm"). "next X" always means the occurrence in the
    // following week (skip today even if today IS that weekday); a bare
    // "X"/"this X" means the very next occurrence, which IS today if
    // today already is that weekday and no time has passed — since that's
    // ambiguous without a time, bare day-name-only defaults treat today as
    // already "gone" and roll to next week, same as "next X", to avoid
    // silently scheduling something for a time that may have already
    // passed today.
    const dayMatch = lower.match(/\b(next\s+|this\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b(?:.*?(\d{1,2})(?::(\d{2}))?\s*(am|pm))?/i);
    if (dayMatch) {
        const wantNext = !!dayMatch[1] && /next/i.test(dayMatch[1]);
        const targetDow = WEEKDAYS.indexOf(dayMatch[2].toLowerCase());
        const todayDow = now.getDay();
        let offset = (targetDow - todayDow + 7) % 7;
        if (offset === 0 || wantNext) offset += offset === 0 ? 7 : 0;
        const d = new Date(now);
        d.setDate(d.getDate() + offset);
        const hour = dayMatch[3] ? toHour24(dayMatch[3], (dayMatch[5] || 'am').toLowerCase()) : 9; // no time given — default 9AM LA
        const min = dayMatch[3] ? +(dayMatch[4] || 0) : 0;
        return laWallClockToUTC(d.getFullYear(), d.getMonth(), d.getDate(), hour, min);
    }

    if ((m = lower.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i))) {
        const hour = toHour24(m[1], m[3].toLowerCase());
        const min = +(m[2] || 0);
        const todayCandidate = laWallClockToUTC(now.getFullYear(), now.getMonth(), now.getDate(), hour, min);
        // Bare clock time with no day context — if it's already passed
        // today, this obviously means tomorrow (nobody schedules something
        // for 30 minutes ago).
        if (todayCandidate.getTime() > Date.now()) return todayCandidate;
        const d = new Date(now); d.setDate(d.getDate() + 1);
        return laWallClockToUTC(d.getFullYear(), d.getMonth(), d.getDate(), hour, min);
    }

    return null;
}

module.exports = { getLADate, getLATime, daysUntil, parseUSDate, parseNaturalTime };