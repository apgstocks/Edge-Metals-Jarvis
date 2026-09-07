// ── helpers/repair.js ────────────────────────────────────────────────────
// Apsara, 2026-09-07: "when i have said something to jarvis mistakenly, jarvis
// will record that.. what if i say something like jarvis ignore that. i made a
// mistake or lets start again.. something in those terms. dont do hard intent
// matching. match it with natural language. Find research papers, check alexa
// implementation."
//
// THE RESEARCH, AND IT SETTLES THE ARGUMENT
// -----------------------------------------
// Schegloff, Jefferson & Sacks, "The preference for self-correction in the
// organization of repair in conversation" (Language 53(2), 1977). Repair is
// not an error path bolted onto conversation; it is one of conversation's own
// organised systems, and it has a strong structural PREFERENCE for the
// speaker repairing herself. An assistant with no repair channel is not
// missing a feature — it is failing to hold up its side of a conversation.
//
// Heeman & Allen, "Detecting and Correcting Speech Repairs" (ACL 1994) and
// "Speech repairs, intonational phrases and discourse markers" (1999), give
// the structure this file is built on. A repair has three parts:
//
//     REPARANDUM        INTERREGNUM        ALTERATION
//     what she retracts  the editing term   what replaces it
//     "send it to Yurim  — no, sorry —      send it to Daekwang"
//
// AND HERE IS THE NUMBER THAT DECIDES THE DESIGN. On the Switchboard corpus,
// only 13.9% of revision repairs carry an interregnum at all. The editing
// term — "no wait", "sorry", "I mean", "scratch that" — is the thing a
// keyword matcher keys on, and it is ABSENT from roughly six repairs in seven.
// A word list is therefore not a slightly worse solution than a model here.
// It is one that misses most of the cases by construction, which is precisely
// what she has been telling me all day.
//
// WHAT ALEXA ACTUALLY DOES, since she asked
// -----------------------------------------
// AMAZON.CancelIntent is a built-in intent whose documented sample utterances
// are "cancel", "never mind" and "forget it" — a fixed list, which skill
// authors are told to EXTEND with their own sample utterances. So Alexa's
// shipped answer is exactly the hard intent matching she does not want.
//
// Amazon knows this. Ponnusamy et al., "Feedback-Based Self-Learning in
// Large-Scale Conversational AI Agents" (AAAI 2020) — the first self-learning
// system in production Alexa — exists because manual annotation of utterances
// "becomes prohibitively costly and time consuming" as coverage grows. It
// mines what customers say when they REPHRASE after a failure, using an
// absorbing Markov chain, and rewrites future queries from it. The follow-up,
// "Self-Aware Feedback-Based Self-Learning" (2022), refines the same idea.
//
// The lesson to take is not "copy the Markov chain" — she has one user, not a
// hundred million, so there is no rephrase corpus to mine. It is that the
// company with the largest sample-utterance list on earth concluded the list
// was the wrong shape. So: model first, patterns as the offline net, same as
// helpers/draftIntent.js and helpers/followUp.js.
//
// THREE SCOPES, AND CONFLATING THEM IS THE DANGEROUS PART
// ------------------------------------------------------
//   undo    — "no, not that one" — take back the LAST thing, keep the task
//   cancel  — "ignore that, forget it" — drop the task she is in
//   restart — "let's start again" — drop it and begin from nothing
//
// Treating an undo as a cancel throws away a document she was most of the way
// through. Treating a cancel as an undo leaves her arguing with a task she
// already abandoned. They are asked for differently and they are answered
// differently.
//
// AND THE LINE THAT DOES NOT MOVE: repair applies to what has NOT HAPPENED
// YET. A draft, a pending, an unanswered question. An email that has gone is
// gone, and "ignore that" cannot unsend it — so when there is nothing
// retractable, this says so plainly rather than accepting the instruction and
// quietly doing nothing, which is the silent-failure shape this whole build
// has been about.

const TIMEOUT_MS = 2500;

const SCOPES = new Set(['undo', 'cancel', 'restart', 'none']);

// ── THE OFFLINE NET ──────────────────────────────────────────────────────
// These are, deliberately, close to Alexa's documented sample utterances plus
// the editing terms Heeman & Allen list. They are kept for exactly two jobs:
// a free fast path, and something that still works when Gemini is unreachable.
// They are NOT the feature. Per the 13.9% figure above, they are expected to
// miss most of what she actually says, and the model is what covers the rest.
const RESTART = /\b(?:start (?:again|over|fresh)|start from (?:the )?(?:top|beginning|scratch)|from the top|do (?:it|this) again from|scrap (?:it|that|the whole thing) and start|begin again)\b/i;
// AMAZON.CancelIntent's own documented sample utterances are "cancel", "never
// mind" and "forget it". Apsara, 2026-09-07: "AMAZON.CancelIntent --> Include
// that.. but not restricted only to this." So they are in, verbatim, and the
// rest of the expression is everything Alexa's list does not cover.
//
// The three bare forms are anchored to the WHOLE utterance. "Cancel" on its
// own is unmistakable; "cancel" inside "cancel the Houston booking" is an
// instruction about a booking, and treating that as a retraction of her own
// last sentence would drop the wrong thing entirely.
const CANCEL_BARE = /^\s*(?:cancel|never ?mind|forget it|forget that)\s*[.!]?\s*$/i;
const CANCEL = /\b(?:ignore (?:that|this|it|what i said|the last)|forget (?:that|it|this|what i said)|never ?mind|cancel (?:that|this|it)|scratch that|disregard (?:that|this)|drop (?:it|that)|abandon (?:that|this|it)|i made a mistake|that was (?:a )?mistake|wrong,? ignore)\b/i;
const UNDO = /\b(?:undo(?: that| the last)?|take (?:that|it) back|not that one|no,? not that|remove the last|delete the last|back (?:that|it) out|strike that)\b/i;

function patternScope(t) {
    // Order matters: "scrap that and start over" is a RESTART, and the cancel
    // pattern also matches part of it. The widest scope wins, because doing
    // less than she asked leaves her repeating herself while a half-dead task
    // argues with her.
    if (RESTART.test(t)) return 'restart';
    if (CANCEL_BARE.test(t) || CANCEL.test(t)) return 'cancel';
    if (UNDO.test(t)) return 'undo';
    return null;
}

const RULES = [
    'A freight manager is talking to her assistant. Decide whether this',
    'sentence is her TAKING SOMETHING BACK, and if so how much.',
    '',
    'Answer with exactly one label:',
    '  "undo"    — take back only the LAST thing she said. The task carries on.',
    '              "no, not that one"  /  "take that back"  /  "not Yurim"',
    '  "cancel"  — drop the whole thing she is in the middle of.',
    '              "ignore that, I made a mistake"  /  "forget it"',
    '              "never mind"  /  "that was wrong, drop it"',
    '  "restart" — drop it AND begin again from nothing.',
    '              "let\'s start again"  /  "scrap that, from the top"',
    '  "none"    — anything else at all.',
    '',
    'SHE OFTEN USES NO SPECIAL WORDS FOR THIS. Research on speech repair',
    '(Heeman & Allen) found only about one repair in seven carries a marker',
    'like "no wait" or "sorry". Judge the MEANING of the sentence in context,',
    'not whether it contains a cancelling word. "That is not right at all" and',
    '"I shouldn\'t have said that" are cancels with no cancel word in them.',
    '',
    'THESE ARE NOT REPAIRS, and getting them wrong destroys her work:',
    '1. A CORRECTION THAT SUPPLIES A NEW VALUE is not a cancel. "no no, trade',
    '   terms should be CIF Busan" changes one field and keeps the document —',
    '   that is handled elsewhere. Answer "none" so it gets there.',
    '   But "no, not that one" with NO replacement value IS an undo.',
    '2. A PLAIN "no" answering a yes/no question. If she was asked "Send it to',
    '   Daekwang?" then "no" declines the send. It does not cancel the draft.',
    '3. SAYING THE WORD "mistake" ABOUT THE WORLD. "Jio made a mistake on the',
    '   weight" is a fact about a trucker, not a retraction of her own words.',
    '4. STOPPING THE SPEAKER. "stop" or "wait" while Jarvis is talking is an',
    '   interruption, not a retraction of anything she said.',
    '',
    'THE TEST: is she taking back WORDS SHE HERSELF JUST SAID? If not, "none".',
    'When genuinely torn between undo and cancel, answer "undo" — the smaller',
    'one. Undoing too little costs her one more sentence; cancelling too much',
    'throws away a document she was most of the way through.',
].join('\n');

function prompt(text, ctx) {
    const lines = [RULES, ''];
    const c = ctx || {};
    if (c.task) lines.push('WHAT SHE IS IN THE MIDDLE OF: ' + c.task);
    if (c.question) lines.push('THE QUESTION SHE WAS JUST ASKED: ' + c.question);
    if (c.lastValue) lines.push('THE LAST THING SHE TOLD IT: ' + c.lastValue);
    if (!c.task && !c.question) {
        lines.push('SHE IS NOT IN THE MIDDLE OF ANYTHING. Only a very clear');
        lines.push('retraction should be anything other than "none" here.');
    }
    lines.push('', 'SHE SAID: ' + text, '');
    lines.push('Reply as JSON: {"label": "undo"|"cancel"|"restart"|"none", "why": "a few words"}.');
    return lines.join('\n');
}

function withTimeout(p, ms) {
    return Promise.race([p, new Promise((r) => setTimeout(() => r('__timeout__'), ms))]);
}

async function askModel(text, ctx) {
    try {
        const { callGeminiJSON } = require('./gemini');
        const res = await withTimeout(callGeminiJSON(prompt(text, ctx), 0), TIMEOUT_MS);
        if (res === '__timeout__') {
            console.warn('[REPAIR] model too slow, using the offline patterns');
            return null;
        }
        const label = String((res && res.label) || '').trim().toLowerCase();
        if (!SCOPES.has(label)) return null;
        if (label !== 'none') {
            console.log(`[REPAIR] model says ${label}: "${text}" — ${(res && res.why) || ''}`);
        }
        return label;
    } catch (e) {
        console.warn('[REPAIR] model unreachable, using the offline patterns:', e.message);
        return null;
    }
}

// ── WHAT THE ENDPOINT CALLS ──────────────────────────────────────────────
// Returns 'undo' | 'cancel' | 'restart' | 'none'. Never throws.
//
// Unlike draftIntent.classify() this is NOT gated on something being open,
// because "ignore that, I made a mistake" is exactly what she says a beat
// after Jarvis acted on something — and at that moment there may be nothing
// open at all. What protects her instead is that the CALLER decides whether
// anything is actually retractable, and says so when nothing is.
async function classify(text, ctx) {
    const t = String(text || '').trim();
    if (!t) return 'none';

    // Fast path: a phrase the net already knows. Same output as the model,
    // no network, no wait in the middle of her talking.
    const quick = patternScope(t);
    if (quick) return quick;

    const said = await askModel(t, ctx || {});
    return said || 'none';
}

// ── SAYING WHAT WAS UNDONE ───────────────────────────────────────────────
// Never a bare "OK". A retraction she cannot verify is worse than none: she
// says "ignore that", hears "OK", and has no idea whether the thing she meant
// is gone or something else is. Every branch names what went.
function confirm(scope, what) {
    const it = what ? String(what).trim() : '';
    if (scope === 'undo') return it ? `Took back ${it}.` : 'Took back the last one.';
    if (scope === 'cancel') return it ? `Dropped ${it}.` : 'Dropped it.';
    if (scope === 'restart') return it ? `Cleared ${it} — starting fresh.` : 'Starting fresh.';
    return '';
}

// What to say when she retracts and there is nothing to retract. Plainly,
// because the alternative is accepting the instruction and doing nothing,
// which reads to her as done.
function nothingToUndo(scope, done) {
    if (done) {
        // ALREADY OUT THE DOOR. This is the one case where honesty costs
        // something and is still right: she needs to know an email was sent,
        // not be told "OK" while it sits in someone's inbox.
        return `That's already gone — ${done}. I can't take it back, but tell me what to do about it.`;
    }
    return scope === 'restart'
        ? 'Nothing in progress — go ahead.'
        : 'Nothing to take back — I hadn\'t started anything.';
}

module.exports = {
    classify, askModel, prompt, confirm, nothingToUndo,
    patternScope, RESTART, CANCEL, CANCEL_BARE, UNDO, RULES, TIMEOUT_MS, SCOPES,
};
