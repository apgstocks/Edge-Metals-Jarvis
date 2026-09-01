// ── helpers/time.js — Date / time utilities (LA timezone) ────────────────────
// All freight dates are MM/DD/YYYY, all deadlines evaluated in America/Los_Angeles.

// ── chrono-node (MIT) — fallback natural-language date parser ────────────────
// Added 2026-08-22 with Apsara's approval. parseNaturalTime below is a
// hand-rolled set of regexes, and it has the same failure mode that keeps
// biting everywhere else in this codebase: it only understands the phrasings
// somebody thought to write a pattern for. The live "@7am" bug is the
// canonical example — every pattern recognized the WORD "at" and none
// recognized the "@" shorthand she actually types.
//
// LOADED DEFENSIVELY, ON PURPOSE. If `npm install` has not been run on the
// VM yet, require() throws, chrono stays null, and parseNaturalTime behaves
// EXACTLY as it does today. A restart before installing must never take
// Jarvis down — deploys here are a manual restart on a live ops system, and
// a hard require would turn a forgotten install step into an outage.
let chrono = null;
try {
    chrono = require('chrono-node');
} catch (e) {
    console.warn('[TIME] chrono-node not installed — falling back to built-in date patterns only. Run `npm install` to enable it.');
}

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

    // ── chrono fallback — ONLY reached when every pattern above missed ───────
    // Deliberately last, not first. The patterns above encode real decisions
    // this business has already made (bare weekday rolls to next week rather
    // than risking a time that has already passed; no time given means 9AM
    // LA), and chrono knows none of that. Running it first would silently
    // change the meaning of phrasings that work correctly today. Running it
    // last can only turn a null — a schedule that would simply have been
    // rejected — into a parsed time.
    if (!chrono) return null;
    try {
        // `lower` already has the redundant LA/PST/pacific qualifiers stripped
        // (see above), which matters here too: chrono WOULD honour a timezone
        // it recognizes and shift the result off LA time, which is never what
        // is meant in this app.
        //
        // forwardDate:true resolves ambiguity toward the future, matching the
        // deliberate "nobody schedules something for 30 minutes ago" rule the
        // bare-clock branch above already applies.
        const results = chrono.parse(lower, now, { forwardDate: true });
        const start = results && results[0] && results[0].start;
        if (!start) return null;

        const y = start.get('year'), mo = start.get('month'), d = start.get('day');
        // A time with no date attached is not enough to schedule anything —
        // bail rather than guessing which day was meant.
        if (y == null || mo == null || d == null) return null;

        // ── CERTAINTY GUARD — caught a real bug during this integration ─────
        // chrono ALWAYS returns a complete date. When it cannot actually
        // resolve a component it silently fills in the reference date's value
        // and flags it `isCertain(...) === false`. Reading the date without
        // checking those flags produces confidently wrong answers:
        //
        //   "on the 15th at 2pm"     -> Aug 22 (today) 2pm, day NOT certain
        //   "next month on the 3rd"  -> Sep 22        , day NOT certain
        //
        // Both silently drop the day-of-month she explicitly stated. For an
        // app whose whole job is freight deadlines, scheduling an email for
        // the 22nd when she said the 15th is far worse than admitting the
        // phrase could not be parsed — a null just means she gets asked.
        //
        // So a chrono result is trusted in exactly two shapes:
        //   (a) the calendar day is CERTAIN — chrono genuinely determined it
        //       ("Sept 3 at 10am", "in 3 weeks", "2 days from now").
        //   (b) it is a bare time-of-day with no date words at all — the day
        //       matched the reference and the clock time is certain ("@7am").
        //       This is the case the hand-rolled bare-clock branch above
        //       already handles for digit-leading input; it exists here to
        //       catch the "@" shorthand form that branch cannot match.
        // Anything else is rejected as unparseable, which is the honest and
        // safe outcome.
        const dayCertain  = start.isCertain('day');
        const hourCertain = start.isCertain('hour');
        const sameDayAsNow = (y === now.getFullYear() && mo - 1 === now.getMonth() && d === now.getDate());

        // Case (b) has to mean a GENUINELY bare time — "@7am" and nothing
        // else. Certainty flags alone are not enough to establish that:
        // "on the 15th at 2pm" also lands on today with a certain hour,
        // because chrono matched only the "2pm" and quietly discarded the
        // "the 15th" it could not resolve. Judging by the flags alone would
        // have let exactly the case this guard exists to stop straight
        // through — it did, on the first run of the test.
        //
        // So check what chrono actually consumed. Anything left over outside
        // the matched span, once connector words and punctuation are
        // removed, means part of what she wrote was silently ignored — and a
        // date phrase that was ignored is never safe to act on.
        const matchText = String(results[0].text || '');
        const matchIdx  = typeof results[0].index === 'number' ? results[0].index : 0;
        const outside   = (lower.slice(0, matchIdx) + ' ' + lower.slice(matchIdx + matchText.length));
        const residue   = outside.replace(/\b(at|on|by|around|about|sharp|please)\b/g, '').replace(/[^a-z0-9]/g, '');
        const bareTimeOnly = residue.length === 0;

        // TIME-DEPENDENT BUG, caught 2026-09-01 by the suite running in the
        // evening: case (b) used to also require the parsed date to be TODAY.
        // With forwardDate:true, chrono rolls a time that has already passed
        // to TOMORROW — so "@7am" resolved to tomorrow, failed the same-day
        // check, and was rejected as unparseable for most of every day. It
        // passed every morning and failed every afternoon, which is the worst
        // kind of bug to find in production.
        //
        // The same-day check was never what made case (b) safe. `bareTimeOnly`
        // is: it proves chrono consumed the WHOLE input, so there was no date
        // reference for it to silently drop. Once that holds, whichever day
        // forwardDate picked is correct by construction, and requiring "today"
        // only breaks the afternoon.
        if (!dayCertain && !(hourCertain && bareTimeOnly)) {
            console.warn(`[TIME] chrono could not confidently date "${text}" (day uncertain) — treating as unparseable rather than guessing`);
            return null;
        }

        // Interpret chrono's components as LA WALL CLOCK and convert through
        // the same helper every branch above uses. chrono itself parses
        // relative to the process timezone, which on this VM is not
        // guaranteed to be LA — routing through laWallClockToUTC is what
        // keeps "7am" meaning 7am in Los Angeles regardless of how the
        // server happens to be configured.
        const h = start.get('hour');
        const mi = start.get('minute');
        // Same 9AM default the weekday branch above uses when no clock time
        // was given, so the two paths cannot disagree.
        const hour = h == null ? 9 : h;
        const min  = h == null ? 0 : (mi || 0);

        let parsed = laWallClockToUTC(y, mo - 1, d, hour, min);
        if (!(parsed instanceof Date) || isNaN(parsed.getTime())) return null;

        // Safety net only. forwardDate:true already rolls a passed bare time
        // to tomorrow, so this normally does nothing — it exists so "@7am"
        // and "7am" cannot disagree about which day they mean if chrono ever
        // changes that behaviour.
        if (!dayCertain && sameDayAsNow && parsed.getTime() <= Date.now()) {
            const nd = new Date(now); nd.setDate(nd.getDate() + 1);
            parsed = laWallClockToUTC(nd.getFullYear(), nd.getMonth(), nd.getDate(), hour, min);
        }
        console.log(`[TIME] chrono parsed "${text}" -> ${parsed.toISOString()}`);
        return parsed;
    } catch (err) {
        console.error('[TIME] chrono parse failed, treating as unparseable:', err.message);
        return null;
    }
}

module.exports = { getLADate, getLATime, daysUntil, parseUSDate, parseNaturalTime };