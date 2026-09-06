// ── helpers/voiceRouter.js — who answers, Jarvis or Scout ──────────────────
//
// Per Apsara 2026-08-29: "When user asks any question to Jarvis which is
// related to Yard, already yard assistant is there na. give it a name and a
// voice. Direct those question to that yard agent."
//
// Two agents now share one microphone:
//
//   JARVIS (voice Charon) — workflow/brain.js. Freight operations. It books
//     loads, messages truckers, sends WhatsApp and email. It DOES things, to
//     real people, immediately.
//
//   SCOUT (voice Leda) — helpers/yardAsk.js. The yard's own data: loads,
//     sellers, weights, stock, what is paid and what is owed. It answers, and
//     it can propose a payment or a draft that she then confirms. It cannot
//     message anyone.
//
// ── which way the router leans, and why ───────────────────────────────────
// The two failure directions are NOT equal, so the router is deliberately
// asymmetric.
//
//   A yard question sent to Jarvis by mistake is a real risk. The brain's job
//   is to act, and it has WhatsApp and email wired up. "How much do we owe
//   Acme" arriving at something whose instinct is to do something is the
//   expensive mistake.
//
//   A freight command sent to Scout by mistake costs nothing. Scout says it
//   cannot do that, and she repeats herself. Annoying, harmless.
//
// So an explicit freight ACTION wins, and anything else that smells of the
// yard goes to Scout. This is not the router being clever; it is the router
// failing in the cheap direction on purpose.
//
// Deterministic, not a model call. Routing has to happen before anything else
// and adding a second round trip to a pipeline that already waits on speech
// recognition and then on speech synthesis would be felt on every question.
// It is also far easier to explain a wrong answer from a word list than from
// a classifier.

// Spoken directly to one of them. Explicit addressing always wins — if she
// says "Hey Scout" she means Scout, whatever the words after it.
const ADDRESSED = {
    scout: [/\bscout\b/i, /\bscout,?\b/i],
    jarvis: [/\bjarvis\b/i, /\bjervis\b/i, /\bjarvi\b/i],
};

// Things only the brain can do, and all of them reach outside the building.
// Presence of one of these is the strongest signal there is.
// ── PLURALS COUNT ────────────────────────────────────────────────────────
// Apsara, 2026-09-06: "When i ask jarvis what bookings that we have from
// houston, its saying that it doesnt have any idea about this."
//
// Half the reason was that this list did not match her words. `\bbooking\b`
// does NOT match "bookings" — the word boundary falls before the s — and the
// same held for container, port, vessel, supplier, driver, carrier and
// quote. So "what bookings do we have from houston" scored ZERO on freight,
// fell past rule 2, and landed on rule 4: "a question, and a wrong guess is
// safer with Scout". Scout then correctly said it does not know about
// bookings, because it does not.
//
// Nobody says "what booking do we have from Houston". The singular-only
// patterns were matching the way the words are written in code rather than
// the way she actually speaks, and one letter routed the whole question to
// the wrong assistant.
const FREIGHT_ACTIONS = [
    /\b(message|text|whatsapp|whats app|email|e-?mail|mail|call|ping|reply|respond|forward|send)s?\b/i,
    /\b(book|booking|dispatch|schedule|arrange|chase|follow up)s?\b/i,
    /\b(trucker|driver|carrier|supplier|quote|quotation)s?\b/i,
    /\b(pickup|pick up|drop off|delivery|deliveries|deliver|container|vessel|port|cutoff|cut-off)s?\b/i,
    /\b(inbox|unread|draft an email|proforma)s?\b/i,
];

// The yard's own vocabulary. Not exhaustive by design — anything that is not
// clearly a freight action and mentions one of these belongs to Scout.
const YARD_WORDS = [
    /\b(load|loads|ticket|tickets)\b/i,
    /\b(seller|sellers|vendor|vendors)\b/i,
    /\b(paid|pay|payment|payments|owe|owed|owing|balance|pending|outstanding|settled|instal?ment)\b/i,
    /\b(gross|tare|net|weight|weighs|weighed|scale|pounds?|lbs?)\b/i,
    /\b(stock|inventory|on hand|onhand)\b/i,
    /\b(draft|drafts)\b/i,
    /\b(copper|brass|aluminium|aluminum|steel|iron|scrap|metal|motors?|compressor|alternator|starter)\b/i,
    /\bedge[_\s-]?\d+/i,
    /\b(zelle|wire|cheque|check|cash)\b/i,
];

// A question, as opposed to an instruction. Used to break ties: a question is
// something Scout can answer; an instruction usually is not.
const QUESTION = /(^|\s)(how|what|which|who|whose|when|where|why|is|are|was|were|do|does|did|can|could|should|has|have|any)\b|\?\s*$/i;

function scoreOf(text, patterns) {
    return patterns.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);
}

// Returns { agent: 'jarvis' | 'scout', why, addressed }.
// ── A PORT IS A FREIGHT SIGNAL, AND IT COSTS NOTHING TO KEEP CURRENT ─────
// Apsara, 2026-09-06: "my user doesnt know about nouns."
//
// FREIGHT_ACTIONS is a keyword list, and widening answerCards.js to
// understand "what's going out of Houston this week" achieved nothing on its
// own: the router scored that sentence freight=0, sent it to Scout, and
// Scout is restricted to yard data and has never heard of a booking. The
// panel I had just taught it to draw was never reached.
//
// So the port is the signal, for the same reason it was enough in
// answerCards: nothing else in this system is organised by port. A yard
// question is about material, weight, suppliers and loads; none of those
// live at a port of loading.
//
// Reusing answerCards.portIn() rather than adding a fourth list here is the
// point. That vocabulary is derived from bookings.json, so a port she starts
// shipping through next month becomes a routing signal with nobody editing
// anything — and there is exactly one place to fix if it is ever wrong.
//
// A TIE-BREAKER, not a vote. A port beside real yard vocabulary ("how much
// copper came in from the Houston load", "how many loads came in from
// Houston today") is still a yard question, so the point is only added when
// the yard score is zero. See the comment at the call site: the flat +1 I
// wrote first misrouted on the second example.
function namesAPort(t) {
    try {
        return !!require('./answerCards').portIn(t);
    } catch (e) {
        // A router that throws answers nothing at all. Losing this signal
        // costs a misroute; losing the router costs every utterance.
        console.warn('[ROUTER] port lookup failed:', e.message);
        return false;
    }
}

function routeVoice(text) {
    const t = String(text || '').trim();
    if (!t) return { agent: 'jarvis', why: 'nothing was said', addressed: false };

    // 1. Explicit address wins outright.
    if (ADDRESSED.scout.some((re) => re.test(t))) {
        return { agent: 'scout', why: 'asked Scout by name', addressed: true };
    }

    const yard = scoreOf(t, YARD_WORDS);
    // The port counts ONLY when there is no yard vocabulary at all — it
    // breaks a tie in the absence of other evidence, it does not compete.
    //
    // I first wrote this as a flat +1 and it misrouted immediately: "how many
    // loads came in from Houston today" scored yard 1, freight 0+1, and the
    // `freight >= yard` test below gives ties to Jarvis, so a plain yard
    // question went to the wrong assistant. A weak signal that can outvote a
    // strong one is not a weak signal.
    const freight = scoreOf(t, FREIGHT_ACTIONS) + (yard === 0 && namesAPort(t) ? 1 : 0);

    // 2. A freight action is the one thing that pulls it back to Jarvis, and
    //    only when the yard is not obviously the subject. "Message the trucker"
    //    -> Jarvis. "Did we pay the trucker for that load" is a yard question
    //    wearing a freight word, and the yard signal outweighs it.
    if (freight > 0 && freight >= yard) {
        return { agent: 'jarvis', why: 'asks for something only Jarvis can do', addressed: false };
    }

    // 3. Anything about the yard goes to Scout.
    if (yard > 0) {
        return { agent: 'scout', why: 'about the yard', addressed: false };
    }

    // 4. A bare question with no vocabulary either way still goes to Scout —
    //    it can say "that is not in the records", which is a safe answer.
    //    Jarvis's equivalent guess could be an action.
    if (QUESTION.test(t)) {
        return { agent: 'scout', why: 'a question, and a wrong guess is safer with Scout', addressed: false };
    }

    // 5. Otherwise it is an instruction of some kind: Jarvis, as before.
    return { agent: 'jarvis', why: 'an instruction for Jarvis', addressed: false };
}

// Strips the agent's name off the front, the same way the wake word is
// stripped — neither agent should have to learn its own name as vocabulary.
function stripAgentName(text) {
    return String(text || '')
        .replace(/^\s*(hey|hi|ok|okay)?\s*(scout|jarvis|jervis|jarvi)\b[\s,:-]*/i, '')
        .trim() || String(text || '').trim();
}

const AGENTS = {
    jarvis: { name: 'Jarvis', voice: 'Charon' },
    scout: { name: 'Scout', voice: 'Leda' },
};

module.exports = { routeVoice, stripAgentName, AGENTS, FREIGHT_ACTIONS, YARD_WORDS };
