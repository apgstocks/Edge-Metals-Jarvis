// ── helpers/followUp.js — answering like someone who was listening ────────
//
// Apsara, 2026-09-06:
//   "It should not read out anything extra like unassigned supplier etc.
//    I want how a human assistant will handle it. They will say yes boss, we
//    have 3 bookings available, earliest cutoff is next wednesday. You want
//    me to forward that? Then wait for followup question."
//   "Everytime when i say hey jarvis, it is like restarting all over again
//    without any idea about context memory."
//
// TWO COMPLAINTS, ONE CAUSE
// -------------------------
// Every question was going to a language model with a fresh prompt, and a
// model handed a table answers by describing the table. Hence the recital of
// container counts and unassigned suppliers nobody asked about, and hence
// the amnesia — the brain's transcript records what she SAYS and never what
// it REPLIED, so "when is the next cutoff" arrives with nothing to attach to.
//
// So these questions do not go to a model at all. A human assistant who just
// read out three bookings does not re-derive them to answer "and the ERD?" —
// they look at the same list. helpers/voiceMemory.js already keeps that
// list, ranked and numbered. This reads answers straight off it.
//
// Deterministic, instant, and incapable of inventing a date — which matters,
// because the next sentence after these is usually "forward that".
//
// WHAT IT DELIBERATELY DOES NOT DO
// --------------------------------
// It never guesses. A question it does not recognise returns null and falls
// through to the assistants, which is the honest outcome — a wrong confident
// answer about a cutoff is worse than a slower correct one.

// ── dates, the way a person says them ────────────────────────────────────
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// "MAERSK LINES, INC." already ends in a full stop. Adding another gives
// "INC..", which is the kind of small wrongness that makes a spoken reply
// sound machine-made — and it is read aloud, where a doubled stop becomes an
// audible extra beat.
function sentence(s) {
    const t = String(s || '').trim();
    if (!t) return t;
    return /[.!?]$/.test(t) ? t : t + '.';
}

function parseYmd(s) {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || '').trim());
    if (!m) return null;
    const d = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
    return Number.isNaN(d.getTime()) ? null : d;
}

function midnight(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

// "next Wednesday", "in 2 days", "last Friday", "today".
//
// She asked for exactly this — "earliest cutoff is next wednesday" — and it
// is not decoration. A date said as 07/13/2026 has to be converted in the
// listener's head before it means anything; a date said as "Wednesday" is
// already a decision about the rest of the week.
function relative(dateStr, now) {
    const d = parseYmd(dateStr);
    if (!d) return String(dateStr || '');
    const today = midnight(now || new Date());
    const days = Math.round((midnight(d) - today) / 86400000);

    if (days === 0) return 'today';
    if (days === 1) return 'tomorrow';
    if (days === -1) return 'yesterday';
    if (days > 1 && days <= 6) return `this ${DAYS[d.getDay()]}`;
    if (days === 7) return `next ${DAYS[d.getDay()]}`;
    if (days > 7 && days <= 13) return `next ${DAYS[d.getDay()]}`;
    if (days < -1 && days >= -6) return `last ${DAYS[d.getDay()]}`;
    if (days < 0) return `${Math.abs(days)} days ago`;
    return `in ${days} days`;
}

// How urgent, said plainly. "in 2 days" is the thing she actually needs to
// hear about a cutoff; the calendar date is on the screen.
function urgency(dateStr, now) {
    const d = parseYmd(dateStr);
    if (!d) return '';
    const days = Math.round((midnight(d) - midnight(now || new Date())) / 86400000);
    if (days < 0) return 'already passed';
    if (days === 0) return 'today';
    if (days === 1) return 'tomorrow';
    return `in ${days} days`;
}

// ── the opening answer ───────────────────────────────────────────────────
// Short, and it OFFERS THE NEXT STEP, because that is what makes it feel
// like an assistant rather than a search result. She wrote the shape of it
// herself: "we have 3 bookings available, earliest cutoff is next wednesday.
// You want me to forward that?"
//
// Everything else — carriers, vessels, container counts, which containers
// lack a supplier — is ON THE SCREEN. Reading it aloud is what she asked me
// to stop doing.
function opening(cards, now) {
    if (!cards || !Array.isArray(cards.rows) || !cards.rows.length) return null;
    const rows = cards.rows;
    const n = rows.length;
    const where = /—\s*(.+)$/.exec(cards.title || '');
    const place = where ? where[1].replace(/\b\w+/g, (w) => w[0] + w.slice(1).toLowerCase()) : '';

    const first = rows[0];
    const cut = first.cutoff ? relative(first.cutoff, now) : '';
    const how = first.cutoff ? urgency(first.cutoff, now) : '';

    const parts = [];
    parts.push(n === 1
        ? `Yes — one booking${place ? ' from ' + place : ''}.`
        : `Yes — ${n} bookings${place ? ' from ' + place : ''}.`);
    if (cut) {
        // "next Wednesday, in 6 days" reads as one thought; "in 6 days, in 6
        // days" does not, so the second half is dropped when it repeats.
        parts.push(n === 1
            ? `Cutoff is ${cut}${how && how !== cut ? `, ${how}` : ''}.`
            : `Earliest cutoff is ${cut}${how && how !== cut ? `, ${how}` : ''}.`);
    }
    parts.push(n === 1 ? 'Want me to forward it?' : 'Want me to forward one?');
    return parts.join(' ');
}

// ── follow-ups ───────────────────────────────────────────────────────────
// Each is a question a person would ask after hearing the opening, and each
// is answerable from the rows already on screen.
const ASKS = [
    {
        // "when is the next cutoff", "what's the cutoff", "when does it cut off"
        re: /\b(?:when|what)(?:'s| is| are)?\s+(?:the\s+)?(?:next\s+)?cut[\s-]?off/i,
        answer: (rows, ref, now) => {
            const row = ref || rows[0];
            if (!row || !row.cutoff) return null;
            const label = ref ? `Booking ${row.booking_number}` : (rows.length > 1 ? 'The earliest one' : 'It');
            return `${label} cuts off ${relative(row.cutoff, now)}, ${urgency(row.cutoff, now)}.`;
        },
    },
    {
        // "and the one after that", "what about the next one"
        re: /\b(?:the\s+)?(?:one\s+)?after\s+that\b|\bnext\s+one\b/i,
        answer: (rows, ref, now) => {
            const idx = ref ? rows.indexOf(ref) : 0;
            const nxt = rows[idx + 1];
            if (!nxt) return rows.length === 1
                ? 'That is the only one.'
                : 'That was the last one.';
            return `${nxt.booking_number} — cutoff ${relative(nxt.cutoff, now)}, ${urgency(nxt.cutoff, now)}.`;
        },
    },
    {
        re: /\b(?:what(?:'s| is)?\s+(?:the\s+)?)?erd\b/i,
        answer: (rows, ref, now) => {
            const row = ref || rows[0];
            if (!row || !row.erd) return null;
            return `ERD is ${relative(row.erd, now)}.`;
        },
    },
    {
        re: /\b(?:which|what)\s+(?:carrier|line|shipping line)\b|\bwho(?:'s| is)\s+(?:the\s+)?carrier\b/i,
        answer: (rows, ref) => {
            const row = ref || rows[0];
            return row && row.carrier ? sentence(row.carrier) : null;
        },
    },
    {
        re: /\b(?:which|what)\s+vessel\b|\bvessel\s+(?:name|is)\b/i,
        answer: (rows, ref) => {
            const row = ref || rows[0];
            return row && row.vessel ? sentence(row.vessel) : null;
        },
    },
    {
        re: /\bhow many\b.*\b(?:booking|container)/i,
        answer: (rows) => {
            const cans = rows.reduce((n, r) => n + (r.container_count || 0), 0);
            return `${rows.length} booking${rows.length === 1 ? '' : 's'}`
                + (cans ? `, ${cans} container${cans === 1 ? '' : 's'} between them.` : '.');
        },
    },
    {
        // The one place the supplier IS the question — asked for, not
        // volunteered. She objected to it being recited unprompted, not to
        // it existing.
        re: /\bsupplier\b/i,
        answer: (rows, ref) => {
            const row = ref || rows[0];
            if (!row) return null;
            const named = (row.containers || []).filter((c) => c.supplier);
            if (!named.length) return `No supplier on ${row.booking_number} yet.`;
            const names = Array.from(new Set(named.map((c) => c.supplier)));
            return sentence(`${names.join(' and ')} on ${row.booking_number}`);
        },
    },
    {
        re: /\b(?:which|what)\s+(?:port|ports)\b|\bwhere\s+(?:from|to)\b/i,
        answer: (rows, ref) => {
            const row = ref || rows[0];
            if (!row) return null;
            return sentence(`${row.from} to ${row.to}`);
        },
    },
];

// Returns a sentence, or null when this is not a follow-up it can answer —
// in which case it must fall through to the assistants rather than guess.
function answerFollowUp(text, referents, ref, now) {
    if (!referents || !Array.isArray(referents.rows) || !referents.rows.length) return null;
    const q = String(text || '');
    if (!q.trim()) return null;
    for (const a of ASKS) {
        if (!a.re.test(q)) continue;
        const said = a.answer(referents.rows, ref || null, now);
        if (said) return said;
    }
    return null;
}

module.exports = { opening, answerFollowUp, relative, urgency, parseYmd, sentence, ASKS };
