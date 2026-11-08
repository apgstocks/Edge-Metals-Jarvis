// ── helpers/scoutActions.js ───────────────────────────────────────────────
// WHAT SCOUT IS ALLOWED TO DO TO THE SCREEN.
//
// Apsara, 2026-11-08: "If i say show spend report for last three days.it
// should do that from any screen in edge yard."
//
// Scout already exists — helpers/voiceRouter.js has named her since before
// this file, and the brain behind her drives 17 read tools and 4 write
// tools. What she has never been able to do is POINT. Every tool returns
// words, so "show me the spend report" could only ever be answered by
// reading numbers out. This file is the missing half: a small, explicit
// vocabulary of things Scout may ask the screen to do.
//
// ── THE LIST IS A SEATBELT, NOT A PARSER (corrected 2026-11-08) ──────────
// The first version of this file matched her words with hand-written
// patterns. She pushed back: "i dont want to restrict only to pedefined
// actions.let ai resolve that". She is right, and the first version was
// wrong in a way worth naming: a pattern list only understands the
// phrasings I happened to think of, so "whats my spending looking like
// these past few days" got nothing, and the only fix would have been me
// guessing more phrasings for ever.
//
// So the AI resolves what she means — screen, dates, filters, however she
// says it. What stays here is the CHECK: does that screen exist, are those
// real filter fields, is that a real company. The model gets the whole of
// the language; the list only stops it naming a screen that is not there.
//
// That distinction matters because the two failures are not the same size.
// A model that misreads a question gives a wrong answer she can see. A
// model that can navigate anywhere puts her on Edge Metals' books while she
// believes she is reading the yard's, and rule 5 is that those are
// different companies.
//
// actionFromWords below is kept as a FALLBACK, not as the main path: when
// the model is slow, rate-limited or down, "show me the spend report for
// the last three days" should still land her on the right screen with the
// right dates. That half of this feature must not depend on a model being
// reachable.
//
// ── AND WHY DATES ARE RESOLVED HERE ──────────────────────────────────────
// "last three days" has to become two real dates exactly once. Resolved on
// the client it would be re-implemented per screen and drift — which is the
// failure that cost a day this morning, where helpers/payments.js knew
// Chase was Edge Yard's and helpers/pettyCash.js did not. One place states
// it; every caller reads it from here.

// The screens Scout may open, by the name loadTab() already answers to. A
// name not in this map is not a screen, however confidently it was asked
// for. tests/scout-actions.js asserts every one of these is a tab the
// client really handles, so the two cannot drift apart.
const SCREENS = {
    spend:         { tab: 'spend',         label: 'Spend report' },
    loads:         { tab: 'loads',         label: 'Loads' },
    petty:         { tab: 'petty',         label: 'Petty cash' },
    expenses:      { tab: 'expenses',      label: 'Expenses' },
    'trucker-bills': { tab: 'trucker-bills', label: 'Trucker bills' },
};

// The filters a screen will accept from Scout. Deliberately the same keys
// the spend report's own query string uses, so there is no translation
// layer to get wrong.
const FILTER_KEYS = ['from', 'to', 'company', 'method', 'bank', 'paid_via',
                     'bought_from', 'sold_to'];

const COMPANIES = { 'edge-trading': 'Edge Yard', 'edge-metals': 'Edge Metals' };

const ymd = (d) => {
    const z = new Date(d);
    if (!isFinite(z.getTime())) return null;
    return `${z.getFullYear()}-${String(z.getMonth() + 1).padStart(2, '0')}-${String(z.getDate()).padStart(2, '0')}`;
};

// ── THE DATE PHRASES SHE ACTUALLY SAYS ───────────────────────────────────
// Written from her own words, not from a general date library: "last three
// days", "this month", "yesterday". A phrase that is not recognised returns
// null and the window is left alone — Scout opening the right screen on the
// wrong dates is worse than opening it on the dates already showing, because
// the second is obviously hers and the first looks like an answer.
//
// `today` is injected so the tests are not a time bomb. A suite that passes
// until the first of a month is a suite that fails on a morning nobody
// changed anything, and gets believed about the wrong thing.
function resolveWindow(text, today = new Date()) {
    const t = String(text || '').toLowerCase();
    const day = 86400000;
    const end = ymd(today);
    const back = (n) => ymd(new Date(today.getTime() - (n * day)));

    // "last 3 days" / "last three days" / "past 7 days"
    const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
                    ten: 10, fourteen: 14, thirty: 30 };
    const m = t.match(/\b(?:last|past)\s+(\d+|one|two|three|four|five|six|seven|ten|fourteen|thirty)\s+days?\b/);
    if (m) {
        const n = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : words[m[1]];
        // THREE DAYS MEANS TODAY AND THE TWO BEFORE IT, which is what she
        // means standing in the yard on a Friday asking about the week so
        // far. n days back from today would be four days of rows.
        if (n > 0 && n <= 400) return { from: back(n - 1), to: end };
    }
    if (/\byesterday\b/.test(t)) return { from: back(1), to: back(1) };
    if (/\btoday\b/.test(t)) return { from: end, to: end };
    if (/\bthis week\b/.test(t)) return { from: back(6), to: end };
    if (/\bthis month\b/.test(t)) {
        return { from: ymd(new Date(today.getFullYear(), today.getMonth(), 1)), to: end };
    }
    if (/\blast month\b/.test(t)) {
        const first = new Date(today.getFullYear(), today.getMonth() - 1, 1);
        const last = new Date(today.getFullYear(), today.getMonth(), 0);
        return { from: ymd(first), to: ymd(last) };
    }
    if (/\bthis year\b/.test(t)) return { from: `${today.getFullYear()}-01-01`, to: end };
    if (/\ball time\b|\beverything\b/.test(t)) return { from: '', to: '' };
    return null;
}

// Which screen, if any, she is asking for. Matched on the words she uses
// for them rather than on the internal tab names.
function resolveScreen(text) {
    const t = String(text || '').toLowerCase();
    if (/\bspend(ing)?\b|\bpaid out\b|\bmoney out\b|\boutgoing\b/.test(t)) return 'spend';
    if (/\bpetty\b|\bcash box\b|\bcash in hand\b/.test(t)) return 'petty';
    if (/\btrucker bills?\b|\bhaulage bills?\b/.test(t)) return 'trucker-bills';
    if (/\bexpenses?\b/.test(t)) return 'expenses';
    if (/\bloads?\b|\bpurchases?\b/.test(t)) return 'loads';
    return null;
}

function resolveCompany(text) {
    const t = String(text || '').toLowerCase();
    if (/\bedge metals\b|\bmetals\b/.test(t)) return 'edge-metals';
    if (/\bedge yard\b|\byard\b/.test(t)) return 'edge-trading';
    return null;
}

// ── THE ONE ENTRY POINT ──────────────────────────────────────────────────
// Returns an action, or null when she was not asking to be shown anything.
// Null is a real answer: most of what she says to Scout is a question, and
// a question must not move her off the screen she is working on.
function actionFromWords(text, { today = new Date(), company = null } = {}) {
    const t = String(text || '').trim();
    if (!t) return null;

    // SHOWING IS AN INSTRUCTION, and only an instruction moves the screen.
    // "how much did we spend last week" is a question — Scout answers it in
    // the panel and leaves her where she is. Yanking the screen out from
    // under someone who asked for a number is the behaviour that makes an
    // assistant something you switch off.
    if (!/\b(show|open|go to|take me to|pull up|bring up|display)\b/i.test(t)) return null;

    const screen = resolveScreen(t);
    if (!screen || !SCREENS[screen]) return null;

    const filters = {};
    const win = resolveWindow(t, today);
    if (win) { filters.from = win.from; filters.to = win.to; }
    // The company she names wins; otherwise the one she is already looking
    // at carries over, because changing companies is never implied.
    const named = resolveCompany(t);
    if (named) filters.company = named;
    else if (company) filters.company = company;

    return {
        open: SCREENS[screen].tab,
        label: SCREENS[screen].label,
        filters,
        // Said back to her in words, so a wrong read is obvious BEFORE she
        // reads a number off the screen and believes it.
        said: describe(SCREENS[screen].label, filters),
    };
}

function describe(label, filters) {
    const bits = [];
    if (filters.from && filters.to) {
        bits.push(filters.from === filters.to ? `on ${filters.from}` : `${filters.from} to ${filters.to}`);
    } else if (filters.from === '' && filters.to === '') bits.push('all time');
    if (filters.company) bits.push(`for ${COMPANIES[filters.company] || filters.company}`);
    return `${label}${bits.length ? ', ' + bits.join(', ') : ''}`;
}

// Anything the client is handed goes through this first. A filter key that
// is not in the list is dropped rather than passed on, so a change at the
// model end cannot reach the screen as an instruction nobody wrote.
function sanitise(action) {
    if (!action || typeof action !== 'object') return null;
    const screen = Object.values(SCREENS).find((s) => s.tab === action.open);
    if (!screen) return null;
    const filters = {};
    for (const k of FILTER_KEYS) {
        if (Object.prototype.hasOwnProperty.call(action.filters || {}, k)) {
            filters[k] = String(action.filters[k] == null ? '' : action.filters[k]);
        }
    }
    if (filters.company && !COMPANIES[filters.company]) delete filters.company;
    return { open: screen.tab, label: screen.label, filters,
             said: describe(screen.label, filters) };
}

// ── WHAT THE MODEL IS TOLD IT MAY ASK FOR ────────────────────────────────
// Generated from the same two constants the seatbelt checks, so the model
// can never be told about a screen the validator will reject, nor left
// ignorant of one it would accept. Two hand-maintained lists is the drift
// this whole file exists to prevent.
function promptFor() {
    const screens = Object.entries(SCREENS)
        .map(([k, v]) => `"${v.tab}" (${v.label})`).join(', ');
    return [
        'If — and only if — she is asking to BE SHOWN a screen, add a `show` field:',
        '  {"show": {"open": "<screen>", "filters": {...}}}',
        `  screens: ${screens}`,
        `  filters: ${FILTER_KEYS.join(', ')} (dates as YYYY-MM-DD; '' means all time)`,
        `  company: ${Object.keys(COMPANIES).join(' or ')}`,
        'A QUESTION IS NOT A REQUEST TO BE SHOWN. "how much cash did I pay in the',
        'last three days" is answered with a figure and the rows behind it — do NOT',
        'move her off the screen she is working on. Only an instruction to show,',
        'open or go to a screen sets `show`.',
    ].join('\n');
}

module.exports = { SCREENS, FILTER_KEYS, COMPANIES, promptFor,
                   actionFromWords, sanitise, resolveWindow, resolveScreen, resolveCompany, describe };
