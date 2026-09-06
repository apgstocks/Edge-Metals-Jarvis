// ── helpers/draftIntent.js ───────────────────────────────────────────────
// Apsara, 2026-09-07: "As per my command, it has to work dynamically."
//
// The command being referred to is "i dont want any fixed intent", and she is
// right that park/resume broke it. I shipped two regexes:
//
//   PARK   = hold|park|pause|shelve|stash + this|that|it ...
//   RESUME = back to|resume|carry on with|continue with|finish|pick up ...
//
// which is a vocabulary list wearing a regex costume. It covers the six ways
// I happened to think of and nothing else. "leave the invoice, Yurim needs an
// answer", "forget the PI a minute", "one sec, Daekwang is calling" — all of
// them mean put this down, none of them match, and every one of them gets
// absorbed as an answer to whatever question was outstanding. That is the
// exact failure she reported: it swallowed the sentence and asked "What rate
// per metric ton?" again.
//
// WHY A MODEL IS THE RIGHT ANSWER HERE AND NOT EVERYWHERE
// ------------------------------------------------------
// The line I have held all through this build is: the model decides what to
// SAY, deterministic code decides which ENTITY is meant and whether an
// IRREVERSIBLE action proceeds. Parking is neither of those. Nothing is sent,
// nothing is lost, the draft is held whole with a 2h TTL, and the decision is
// announced out loud ("Held it — 21 MT of copper..."). A wrong park costs her
// one sentence to undo. So this is a safe place to let a model judge, and the
// judgement it is being asked for — did she mean to set this down — is
// genuinely a language question that no word list answers.
//
// WHAT IS DELIBERATELY NOT MOVED TO THE MODEL, and it is not an oversight:
// the amendment lock in api.js. That one is triple-locked (pending is a
// proforma AND the draft is staged AND the sentence carries a real field
// change) because it is the one exception to "an open question owns the
// conversation". Loosen it and "yes, Sher Trucking" during a trucker
// confirmation can be read as a proforma correction — and then the WhatsApp
// to the driver never goes. A confirmation with a truck behind it is not a
// place for a probabilistic classifier. Told her so rather than quietly
// doing it.
//
// PATTERNS FIRST, MODEL SECOND — THE INVERSE OF followUp.js, ON PURPOSE
// --------------------------------------------------------------------
// followUp asks the model FIRST because there the patterns produce a WORSE
// answer: robotic phrasing of the same fact. Here the output is one of three
// labels. A pattern hit and a model hit produce a byte-identical result, so
// consulting the model about a sentence the pattern already answered buys
// nothing and costs a network round trip in the middle of her talking. The
// patterns become a fast path, and the model covers everything they miss —
// which is the part she actually asked for.
//
// COST, STATED PLAINLY: this adds ZERO model calls to the common case. It is
// gated on a draft being open or parked, so on any utterance with no proforma
// in flight it returns 'none' without touching the network.

const PARK_TIMEOUT_MS = 2500;

// The offline net. Same two expressions that used to BE the feature; they are
// now the thing that keeps it working when Gemini is unreachable, which for
// her is a real condition and not a theoretical one.
const PARK = /\b(?:hold|park|pause|shelve|stash)\s+(?:this|that|it|the\s+(?:proforma|pi|invoice))\b|\b(?:set|put)\s+(?:this|that|it)\s+aside\b|\bleave\s+(?:this|that|it)\s+(?:for\s+now|aside)\b|\bcome\s+back\s+to\s+(?:this|that|it)\b|\b(?:hold|park)\s+on\s+to\s+(?:this|that|it)\b/i;
const RESUME = /\b(?:back\s+to|resume|carry\s+on\s+with|continue\s+with|finish|pick\s+up)\s+(?:the\s+)?(?:proforma|pi|invoice|that|it)\b|\bwhere\s+(?:were|was)\s+we\b|\b(?:unpark|unhold)\b/i;

// ── THE PROMPT ───────────────────────────────────────────────────────────
// The anti-cases carry more weight than the positive ones. A classifier that
// is eager to see a park will eat her answers, and an eaten answer looks
// exactly like the bug she reported — so the three things that are NOT a park
// are spelled out with examples, and the tie-break is written down rather
// than left to the model's temperament.
const RULES = [
    'You are deciding ONE thing about a freight manager\'s sentence: what she',
    'wants to do with the proforma invoice being drafted right now.',
    '',
    'Answer with exactly one label:',
    '  "park"   — she wants to SET THE DRAFT DOWN and do something else for a',
    '              while. She intends to come back. The draft is kept.',
    '  "resume" — she wants to PICK BACK UP the draft she set down earlier.',
    '  "none"   — anything else at all.',
    '',
    'THESE ARE NOT A PARK. Getting any of them wrong destroys her turn:',
    '1. AN ANSWER to the outstanding question. If she is asked the rate and',
    '   says "hold on, 8450" she is answering, not parking. A number, a name,',
    '   a port, an incoterm or a quantity means "none" even when it opens',
    '   with a filler like "wait", "hold on" or "one sec".',
    '2. A CORRECTION. "wait, make it FOB", "actually change it to CIF Busan",',
    '   "no, 21 tons not 12" are amendments to the draft. Always "none".',
    '3. A CANCELLATION. "forget it", "drop the whole thing", "cancel that",',
    '   "we are not doing this order" mean she is ABANDONING it, not holding',
    '   it. Always "none" — a different part of the system handles that, and',
    '   parking something she killed would resurrect it two hours later.',
    '',
    'A PARK usually names, or clearly implies, SOMETHING ELSE she is turning',
    'to: an email, a call, a person, another booking. Examples, all "park":',
    '  "lets hold this and work on email"',
    '  "leave the invoice a minute, Yurim needs an answer"',
    '  "one sec, Daekwang is on the phone"',
    '  "put the PI down, I need to check the cutoff on that Houston booking"',
    '  "pause, I will come back to this"',
    '',
    'Examples of "resume":',
    '  "ok back to the proforma"  /  "where were we"  /  "lets finish the PI"',
    '  "right, carry on with Daekwang"',
    '',
    'WHEN IN DOUBT, ANSWER "none". A missed park costs her one repeated',
    'sentence. A wrong park drops the document she was in the middle of.',
].join('\n');

function prompt(text, state) {
    const lines = [RULES, ''];
    if (state.open) {
        lines.push('A PROFORMA IS OPEN RIGHT NOW: ' + (state.summary || '(barely started)'));
        if (state.question) {
            lines.push('THE QUESTION SHE WAS JUST ASKED: ' + state.question);
            lines.push('If her sentence is a plausible answer to that question, the label is "none".');
        }
        lines.push('Nothing is parked, so "resume" is not available. Choose "park" or "none".');
    } else if (state.parked) {
        lines.push('NOTHING IS OPEN. A proforma is PARKED: ' + (state.summary || '(a draft)'));
        lines.push('So "park" is not available. Choose "resume" or "none".');
    }
    lines.push('', 'SHE SAID: ' + text, '');
    lines.push('Reply as JSON: {"label": "park"|"resume"|"none", "why": "a few words"}.');
    return lines.join('\n');
}

// A live voice turn cannot wait on a slow model — she is standing there. Two
// and a half seconds, then fall through to the patterns and carry on. Same
// reasoning as the 2s guard in llm-intent.js.
function withTimeout(p, ms) {
    return Promise.race([
        p,
        new Promise((resolve) => setTimeout(() => resolve('__timeout__'), ms)),
    ]);
}

async function askModel(text, state) {
    try {
        const { callGeminiJSON } = require('./gemini');
        // retries 0: a retry doubles the wait she is standing through, and the
        // fallback below is already correct for the phrases that matter most.
        const res = await withTimeout(callGeminiJSON(prompt(text, state), 0), PARK_TIMEOUT_MS);
        if (res === '__timeout__') {
            console.warn('[DRAFT-INTENT] model too slow, using the offline patterns');
            return null;
        }
        const label = String((res && res.label) || '').trim().toLowerCase();
        if (label !== 'park' && label !== 'resume' && label !== 'none') return null;
        // It cannot park what is not open, or resume what is not held, however
        // confident it sounds. The state is a fact; the label is an opinion.
        if (label === 'park' && !state.open) return null;
        if (label === 'resume' && !state.parked) return null;
        if (label !== 'none') {
            console.log(`[DRAFT-INTENT] model says ${label}: "${text}" — ${(res && res.why) || ''}`);
        }
        return label;
    } catch (e) {
        console.warn('[DRAFT-INTENT] model unreachable, using the offline patterns:', e.message);
        return null;
    }
}

// ── WHAT api.js CALLS ────────────────────────────────────────────────────
// Returns 'park' | 'resume' | 'none'. Never throws, never returns undefined —
// the caller uses this to decide whether to hand the sentence to the draft at
// all, and an undefined there would silently route her mid-proforma answers
// to the yard assistant.
async function classify(text, state) {
    const t = String(text || '').trim();
    const st = state || {};
    if (!t) return 'none';

    // THE GATE. No proforma in flight means there is nothing to park and
    // nothing to resume, so there is no question to ask and no model call to
    // pay for. This is also what stops the classifier from ever having an
    // opinion about "yes, Sher Trucking" during a trucker confirmation.
    if (!st.open && !st.parked) return 'none';

    // Fast path. Identical output to the model, no network.
    if (st.open && PARK.test(t)) return 'park';
    if (st.parked && RESUME.test(t)) return 'resume';

    const said = await askModel(t, st);
    return said || 'none';
}

module.exports = { classify, askModel, prompt, PARK, RESUME, RULES, PARK_TIMEOUT_MS };
