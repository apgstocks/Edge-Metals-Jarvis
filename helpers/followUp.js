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

    // ── THE SCOPE IN HER WORDS, WHEN THERE IS ONE ────────────────────────
    // The title used to be nothing but a port, so "from <place>" always read
    // correctly. Now helpers/bookingQuery.js can narrow by assignment status
    // and cutoff window too, and the description it produces already contains
    // its own "from" — "Yes — 2 bookings from unassigned from Houston."
    //
    // So a scope, when present, replaces the "from <place>" phrasing rather
    // than being poured into it. It matters beyond grammar: the scope is how
    // she can hear WHICH question was answered, which is the whole complaint
    // behind "instead of running that-its assuming something".
    const scope = cards.scope ? String(cards.scope) : '';
    const said = scope ? ' ' + scope : (place ? ' from ' + place : '');

    const parts = [];
    parts.push(n === 1
        ? `Yes — one booking${said}.`
        : `Yes — ${n} bookings${said}.`);
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

// ── NO FIXED INTENTS ─────────────────────────────────────────────────────
// Apsara, 2026-09-06: "i dont want any fixed intent."
//
// She is right, and it is the same objection she opened with — "mimicing a
// assistant behaviour not just restricted to standard template". A list of
// regexes is exactly the template: it answers the six questions I thought
// of and stares blankly at the seventh, which is the one she actually asks.
//
// WHERE THE LINE GOES, THOUGH, BECAUSE IT IS NOT "MODEL DECIDES EVERYTHING"
// -------------------------------------------------------------------------
// Two different jobs were tangled together in the patterns below:
//
//   WHICH ENTITY is meant — "the first one", "that booking". This stays
//   DETERMINISTIC, in helpers/voiceMemory.js, and it is not timidity: asking
//   a language model to count rows in prose it was handed fails silently,
//   and the sentence after this one is "forward it to Sher Trucking". A
//   miscount here is a truck at the wrong yard. The research says the same
//   (Centering: rank in a ranked list predicts the referent — so use the
//   rank, do not re-derive it).
//
//   WHAT TO SAY about it — the model's job, and it should have been from the
//   start. It can answer questions I never anticipated, in the words she
//   used, without me maintaining a phrasebook.
//
// So the rows are prepared here — with the DATES ALREADY CONVERTED to "next
// Wednesday" and "in 7 days", so the model never does calendar arithmetic —
// and then it is asked to answer from exactly those values and nothing else.
//
// The patterns below are kept ONLY as the offline fallback, for when the
// model is unreachable. An assistant that goes mute because a network call
// failed is worse than one that answers six questions well.
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

// ── the rows, with the arithmetic already done ───────────────────────────
// Handed to the model INSTEAD of raw records. Every date arrives already
// converted — "next Wednesday", "in 7 days", "already passed" — so the model
// is choosing what to say, never working out what day it is. Calendar
// arithmetic is the thing language models are worst at and the thing she
// would never catch: "cutoff is Thursday" is not obviously wrong until a
// container misses a vessel.
function forModel(referents, now) {
    if (!referents || !Array.isArray(referents.rows)) return [];
    return referents.rows.map((r) => ({
        n: r.n,
        booking: r.booking_number,
        carrier: r.carrier || null,
        from: r.from || null,
        to: r.to || null,
        vessel: r.vessel || null,
        erd: r.erd || null,
        erd_when: r.erd ? relative(r.erd, now) : null,
        cutoff: r.cutoff || null,
        cutoff_when: r.cutoff ? relative(r.cutoff, now) : null,
        cutoff_in: r.cutoff ? urgency(r.cutoff, now) : null,
        containers: (r.containers || []).map((c) => ({
            seq: c.seq, size: c.size || null,
            supplier: c.supplier || null, trucker: c.trucker || null,
        })),
    }));
}

const RULES = [
    'You are a freight manager\'s assistant. She is LISTENING, not reading —',
    'the full table is already on her screen.',
    '',
    'ANSWER IN ONE SHORT SENTENCE. Two at the very most.',
    '',
    'RULES:',
    '1. Use ONLY the values in DATA. Never calculate a date — the relative',
    '   ones are given to you as cutoff_when and cutoff_in. Use those words.',
    '2. Do NOT list fields she did not ask about. No carriers, vessels,',
    '   container counts or supplier status unless the question was about',
    '   them. Reading out the table is the thing she asked you to stop.',
    '3. If the answer is not in DATA, say so plainly in a few words. Never',
    '   invent a number, a date or a name.',
    '4. Sound like a person: "The earliest one cuts off next Wednesday, in 7',
    '   days." Not "The cutoff date for booking AAA111 is 07/15/2026."',
    '5. Offer the obvious next step only when it is genuinely the next step,',
    '   and only as a short question.',
].join('\n');

// The dynamic path. Returns null when the model is unreachable or says
// nothing usable, and the caller falls back — first to the patterns above,
// then to the assistants.
// What the model said about the LAST question: was she still talking about
// the rows on screen? null when it did not say, or was never asked.
let lastAboutRows = null;
function lastAboutTheseRows() { return lastAboutRows; }

async function askModel(question, referents, ref, now) {
    lastAboutRows = null;
    const rows = forModel(referents, now);
    if (!rows.length) return null;

    const prompt = [
        RULES, '',
        'DATA (the bookings currently on her screen):',
        JSON.stringify(rows),
        ref ? `\nSHE IS ASKING ABOUT booking ${ref.booking_number}.` : '',
        '', `SHE ASKED: ${question}`, '',
        // ── AND ASK IT THE QUESTION NOBODY WAS ASKING ────────────────────
        // Apsara, 2026-09-07: "WHy cant it handle that .. we are using ai
        // only right?"
        //
        // She is right and the answer was uncomfortable. The decision that
        // broke her conversation — is this a NEW question about bookings, or
        // a follow-up about the rows already on screen — was made by a regex
        // over nine nouns, before any model was consulted. The model was only
        // ever asked to ANSWER. When it could not, the code concluded she must
        // have changed subject and redrew the list. That is a non-sequitur:
        // "I cannot answer this" is not evidence about what she meant.
        //
        // So it is asked. In the SAME call, because the rows are already in
        // the prompt and a second round trip mid-sentence costs her real time.
        // Free, and it is the judgement a model is actually good at.
        'about_these_rows: is she still asking about the bookings in DATA?',
        'True for a follow-up like "and the vessel", "what about the container',
        'size", "who is the carrier" — a question ABOUT these rows, even when',
        'you cannot answer it. False only when she has moved to a different',
        'subject or asked for a different set of bookings.',
        '',
        'Reply as JSON: {"answer": "...", "have_data": true|false, "about_these_rows": true|false}.',
        'have_data false means the answer is genuinely not in DATA.',
    ].join('\n');

    try {
        const { callGeminiJSON } = require('./gemini');
        const res = await callGeminiJSON(prompt, 1);
        // Recorded whether or not there is an answer, because the whole point
        // is that "could not answer" and "changed subject" are different
        // things and the caller needs both. Undefined stays undefined — a
        // model that did not say is not a model that said no.
        lastAboutRows = res && typeof res.about_these_rows === 'boolean'
            ? res.about_these_rows : null;
        const said = String((res && res.answer) || '').trim();
        if (!said) return null;
        // A refusal is still an answer — "that is not in what I have" is the
        // honest reply and far better than falling through to a second
        // assistant that will say something different about the same rows.
        return said;
    } catch (e) {
        console.warn('[FOLLOWUP] model unreachable, using the offline answers:', e.message);
        return null;
    }
}

// What the endpoint calls. Model first, patterns second, null last.
async function answer(question, referents, ref, now) {
    if (!referents || !Array.isArray(referents.rows) || !referents.rows.length) return null;
    if (!String(question || '').trim()) return null;

    const dynamic = await askModel(question, referents, ref, now);
    if (dynamic) return dynamic;

    // Offline fallback. Six questions answered well beats going mute.
    return answerFollowUp(question, referents, ref, now);
}

module.exports = {
    opening, answer, askModel, forModel, RULES, lastAboutTheseRows,
    answerFollowUp, relative, urgency, parseYmd, sentence, ASKS,
};
