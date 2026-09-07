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
// AMENDMENTS TOO — AND I WAS WRONG TO REFUSE THEM FIRST TIME
// ----------------------------------------------------------
// Apsara, 2026-09-07: "if i say no no jarvis, trade terms should be like this
// it should update. just like jarvis in iron man."
//
// I had left corrections on the fixed CORRECTION_CUE list and told her the
// reason was that a probabilistic check there could read "yes, Sher Trucking"
// during a TRUCKER confirmation as a proforma correction. That reason was
// wrong, and it took her pushing back to go and look: the amendment branch in
// api.js is already gated on `brainPending.type === 'confirm_proforma'`, so a
// trucker confirmation never reaches it at all. The cue list was not carrying
// that safety. It was carrying nothing.
//
// What it WAS costing, measured: of ten natural corrections, five were
// silently swallowed mid-confirm — including "no no the rate is 8500" and
// "consignee is Hyundai Steel not Daekwang". handle() returned null, the
// sentence fell through to the general classifier, and the document she had
// just corrected was still sitting there confirmable in its old form.
//
// A model is in fact SAFER here than the regex, because the real hazard is
// "forward that to Sher Trucking" — which carries no cue word but does parse
// as a consignee, so an eager absorb would rewrite the buyer on an invoice.
// A word list cannot tell that from a correction. A model reading the whole
// sentence can, and is told to in as many words.
//
// TWO LOCKS STAY, and they are the ones that were doing the work:
//   1. the amendment must actually CHANGE A FIELD — absorb() has to yield
//      something, or "wait" on its own tears down a confirmation for nothing
//   2. what changed is SAID OUT LOUD before she is re-asked, so a mis-parse
//      is audible instead of silent. That is the guard that replaces the cue.
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

const LABELS = new Set(['park', 'resume', 'amend', 'none']);

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
    '  "amend"  — she is CORRECTING A FIELD on the document in front of her.',
    '              Trade terms, payment terms, the rate, the tonnage, the',
    '              consignee, the port, the material, the container count.',
    '  "none"   — anything else at all.',
    '',
    'THESE ARE NOT A PARK. Getting any of them wrong destroys her turn:',
    '1. AN ANSWER to the outstanding question. If she is asked the rate and',
    '   says "hold on, 8450" she is answering, not parking. A number, a name,',
    '   a port, an incoterm or a quantity means "none" even when it opens',
    '   with a filler like "wait", "hold on" or "one sec".',
    '2. A CORRECTION — that is "amend", never "park". She is staying on this',
    '   document, not leaving it.',
    '3. A CANCELLATION. "forget it", "drop the whole thing", "cancel that",',
    '   "we are not doing this order" mean she is ABANDONING it, not holding',
    '   it. Always "none" — a different part of the system handles that, and',
    '   parking something she killed would resurrect it two hours later.',
    '',
    '── WHAT "amend" LOOKS LIKE, and it is how people actually talk ──',
    'She does NOT always use a correction word. Naming a field and a value,',
    'while a finished document is in front of her, IS a correction:',
    '  "no no jarvis, trade terms should be CIF Busan"   → amend',
    '  "no jarvis trade terms is CIF Busan"              → amend',
    '  "trade terms CIF Busan"                           → amend',
    '  "nope, CIF Busan"                                 → amend',
    '  "payment terms 30 days from BL date"              → amend',
    '  "no no the rate is 8500"                          → amend',
    '  "consignee is Hyundai Steel not Daekwang"         → amend',
    '  "make it two containers"                          → amend',
    '',
    'AND WHAT IS NOT AN AMENDMENT, however much it looks like one. These are',
    'the ones that put the WRONG COMPANY on a financial document:',
    '  "forward that to Sher Trucking"     → none. A trucker instruction. The',
    '     words "to Sher Trucking" parse as a consignee, and reading this as',
    '     an amendment silently rewrites the buyer on an invoice.',
    '  "send it to Daekwang"               → none. That is her YES, not a',
    '     change — she is confirming the document as it stands.',
    '  "any bookings from Houston"         → none. A question, not a change.',
    '  "email Yurim about the booking"     → none. A different task.',
    '  "wait"  /  "hold on"  /  "hmm"      → none on its own. A hesitation is',
    '     not a correction, and treating it as one tears down her',
    '     confirmation for nothing.',
    '',
    'THE TEST: could you name the FIELD and the NEW VALUE she wants? If not,',
    'it is not "amend".',
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
        if (state.staged) {
            // The confirm window. This is where "no no jarvis, trade terms
            // should be CIF Busan" lands, and where a missed correction means
            // she says yes to terms she just rejected.
            lines.push('THE DOCUMENT IS FINISHED AND SHE HAS BEEN ASKED TO CONFIRM IT.');
            lines.push('So a sentence naming a field and a value is a CORRECTION to what she');
            lines.push('is looking at — "amend" — not an answer to anything.');
            lines.push('Nothing is parked, so "resume" is not available. Choose "park", "amend" or "none".');
        } else {
            // Mid-questioning the draft absorbs answers itself, so "amend" is
            // not offered — it would compete with the answer path for the
            // same sentence and only one of them can be right.
            lines.push('She is still being asked for missing fields, so "amend" is not');
            lines.push('available and neither is "resume". Choose "park" or "none".');
        }
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
        if (!LABELS.has(label)) return null;
        // It cannot park what is not open, resume what is not held, or amend a
        // document that is not finished and waiting on her. The state is a
        // fact; the label is an opinion, and where they disagree the fact wins.
        if (label === 'park' && !state.open) return null;
        if (label === 'resume' && !state.parked) return null;
        if (label === 'amend' && !state.staged) return null;
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

    // THE GATE. No proforma in flight means there is nothing to park, resume
    // or amend, so there is no question to ask and no model call to pay for.
    // This is also what stops the classifier from ever having an opinion
    // about "yes, Sher Trucking" during a trucker confirmation.
    if (!st.open && !st.parked) return 'none';

    // Fast path. Identical output to the model, no network.
    //
    // There is deliberately NO fast path for 'amend'. The offline net for
    // corrections is CORRECTION_CUE inside proformaDraft.isAmendment(), which
    // needs absorb() to confirm a field actually changed — a decision this
    // module cannot make and should not duplicate. So a 'none' from here is
    // never the last word on an amendment: isAmendment() still applies its own
    // cue test, which means this layer can only ever WIDEN what counts as a
    // correction, never narrow it. An unreachable model degrades to exactly
    // today's behaviour rather than to a document that ignores her.
    if (st.open && PARK.test(t)) return 'park';
    if (st.parked && RESUME.test(t)) return 'resume';

    const said = await askModel(t, st);
    return said || 'none';
}

module.exports = { classify, askModel, prompt, PARK, RESUME, RULES, PARK_TIMEOUT_MS };
