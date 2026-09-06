// ── tests/voice-memory.js ─────────────────────────────────────────────────
// Apsara, 2026-09-06: "I want jarvis to remember every command and its
// response as short term memory.. So that i can do follow up questions."
//
// And the flow she described, which is what this file is really testing:
//
//   "any bookings from Houston?"        → three on screen
//   "when is the next cutoff"           → about those three
//   "what is the ERD"                   → of the one just discussed
//   "forward that to the trucker"       → the same one, still
//
// Not one of those follow-ups means anything on its own.
//
// TWO KINDS OF MEMORY, AND THE SECOND IS THE ONE THAT MATTERS HERE
// ----------------------------------------------------------------
// The transcript is easy and the model is good at it. The REFERENT SET is
// the hard part: "the first one" is a position in a LIST, and asking a
// language model to count rows in prose it was handed is exactly the kind
// of thing that fails silently. At the end of this flow a container is
// forwarded to a real trucker, so a miscount is a truck at the wrong yard.
//
// So the ordinal is resolved deterministically, here, against the rows that
// were actually rendered — and when it cannot be resolved, NOTHING is
// guessed.

const path = require('path');
let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
process.env.DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const mem = require(path.join(ROOT, 'helpers/voiceMemory.js'));
const { cardsFor } = require(path.join(ROOT, 'helpers/answerCards.js'));

// Three rows, the shape answerCards really produces.
const THREE = {
    kind: 'bookings', title: 'Bookings — HOUSTON',
    rows: [
        { n: 1, booking_number: 'AAA111', erd: '07/07/2026', cutoff: '07/13/2026' },
        { n: 2, booking_number: 'BBB222', erd: '07/10/2026', cutoff: '07/20/2026' },
        { n: 3, booking_number: 'CCC333', erd: '07/15/2026', cutoff: '07/28/2026' },
    ],
};

console.log('\n─ short-term memory ─────────────────────────────────────────');

section('A — HER FLOW, turn by turn');
{
    mem.reset();
    mem.remember('user', 'any bookings from houston');
    mem.setReferents(THREE);
    mem.remember('bot', 'Three bookings from Houston. Earliest cutoff is 13 July.');

    // "when is the next cutoff" — no reference to resolve, but the model
    // needs the previous turns to know what "next" is counting from.
    const h = mem.history();
    ck('the question is remembered', h.some((t) => t.role === 'user' && /houston/i.test(t.text)));
    ck('  and so is the ANSWER', h.some((t) => t.role === 'bot' && /Three bookings/.test(t.text)),
       'recording only her side gives the model a list of questions with no answers');

    // "forward the first one to Sher Trucking"
    const r = mem.resolve('forward the first one to Sher Trucking');
    ck('"the first one" becomes a booking number', /AAA111/.test(r.text), r.text);
    ck('  and the rest of the sentence survives', /Sher Trucking/.test(r.text), r.text);
    ck('  with the resolution recorded for the reply to echo',
       r.resolved && r.resolved.to === 'AAA111' && r.resolved.n === 1,
       JSON.stringify(r.resolved));

    ck('"the second booking" → the second row',
       /BBB222/.test(mem.resolve('send the second booking to the trucker').text));
    ck('  "the third one" → the third', /CCC333/.test(mem.resolve('what about the third one').text));
    ck('  "the last one" → the last', /CCC333/.test(mem.resolve('forward the last one').text));
}

section('B — IT DOES NOT GUESS');
{
    // The most important section in the file. Every case here ends with a
    // WhatsApp to a real driver if it resolves wrongly.
    mem.reset();
    mem.setReferents(THREE);

    // "that booking" with three on screen is genuinely ambiguous.
    const amb = mem.resolve('forward that booking to Sher');
    ck('"that booking" with three on screen refuses', amb.resolved === null,
       'resolved to ' + JSON.stringify(amb.resolved));
    ck('  and says how many it could mean', amb.ambiguous === 3, String(amb.ambiguous));

    // ...but is unambiguous when there is only one.
    mem.reset();
    mem.setReferents({ kind: 'bookings', title: 'x', rows: [THREE.rows[0]] });
    ck('  and resolves when there is only one', /AAA111/.test(mem.resolve('forward that booking').text));

    // An ordinal past the end of the list.
    mem.reset();
    mem.setReferents(THREE);
    const past = mem.resolve('forward the fifth one');
    ck('an ordinal past the end resolves to nothing', past.resolved === null,
       'a wrong row here is a container sent to the wrong trucker');
    ck('  and leaves the sentence untouched', past.text === 'forward the fifth one');

    // No list at all.
    mem.reset();
    const none = mem.resolve('forward the first one to Sher');
    ck('with no list on screen, nothing is resolved', none.resolved === null);
}

section('B2 — "forward that to trucker", which is what she actually says');
{
    // HER EXACT WORDS, and they did not work. The deictic pattern required a
    // NOUN after "that" — "that booking", "that one" — so the sentence she
    // would really say was not recognised as a reference at all and the
    // booking number never reached the brain.
    mem.reset();
    mem.setReferents({ kind: 'bookings', title: 'x', rows: [THREE.rows[0]] });

    const r = mem.resolve('forward that to the trucker');
    ck('"forward that" points at the booking on screen',
       /AAA111/.test(r.text), r.text);
    ck('  and the rest of the sentence survives', /to the trucker/.test(r.text), r.text);
    ck('  "send it to Sher" too', /AAA111/.test(mem.resolve('send it to Sher').text));
    ck('  and "assign that"', /AAA111/.test(mem.resolve('assign that').text));

    // A bare "that" is far too common to treat as a pointer on its own. It
    // counts only DIRECTLY after an action verb.
    for (const q of [
        'i thought that was fine',
        'that is the one we discussed',
        'was that the cutoff',
    ]) {
        ck(`"${q}" is left alone`, mem.resolve(q).resolved === null, mem.resolve(q).text);
    }

    // And with three on screen it still refuses rather than picking one.
    mem.reset();
    mem.setReferents(THREE);
    const amb = mem.resolve('forward that to the trucker');
    ck('with three on screen it refuses', amb.resolved === null);
    ck('  and says how many it could mean', amb.ambiguous === 3, String(amb.ambiguous));
}

section('C — WHEN TO FORGET');
{
    // workflow/brain.js carries a comment about menuContext never expiring,
    // so a bare "1" days later still selects from a menu she saw last week.
    // That bug, already found and named there, is this one.
    mem.reset();
    mem.setReferents(THREE);
    ck('a fresh list is available', !!mem.currentReferents());

    // Age it past the TTL by hand.
    const set = mem.currentReferents();
    set.ts = Date.now() - (mem.REFERENT_TTL_MS + 1000);
    ck('  a stale list is dropped', mem.currentReferents() === null,
       'ten minutes on, "the first one" means a booking that left the screen');
    ck('  and an ordinal against it resolves to nothing',
       mem.resolve('forward the first one').resolved === null);

    // A new list replaces the old one wholesale.
    mem.reset();
    mem.setReferents(THREE);
    mem.setReferents({ kind: 'bookings', title: 'y', rows: [{ n: 1, booking_number: 'ZZZ999' }] });
    ck('a new list replaces the old one', /ZZZ999/.test(mem.resolve('forward the first one').text),
       'otherwise she acts on the previous question\'s results');

    // AND AN INSTRUCTION MUST NOT MINT A NEW LIST — that is what would
    // renumber the rows between her looking and her speaking.
    ck('an instruction produces no new list',
       cardsFor('forward the first booking to Sher Trucking') === null,
       'redrawing here is how "the first one" comes to mean something else');
}

section('D — the window stays bounded');
{
    mem.reset();
    for (let i = 0; i < 30; i += 1) {
        mem.remember('user', 'question number ' + i);
        mem.remember('bot', 'answer number ' + i);
    }
    const h = mem.history();
    ck('only the recent turns are kept', h.length === mem.TURN_CAP,
       h.length + ' turns — an unbounded transcript is a slow, expensive prompt');
    ck('  and they are the MOST recent', /29/.test(h[h.length - 1].text), h[h.length - 1].text);
    // Longer is not better: Laban et al. measured a 39% average drop from
    // single-turn to multi-turn, and the mechanism is early commitment to a
    // wrong assumption — which more context feeds rather than starves.
    ck('  each turn is capped in length',
       mem.history().every((t) => t.text.length <= 300));
    const long = 'x'.repeat(5000);
    mem.remember('user', long);
    ck('  including a very long one', mem.history().pop().text.length === 300);
}

section('E — an ordinary sentence is left alone');
{
    // Over-resolution is the quiet failure: rewriting something that was
    // never a reference. "What was the first one about" IS a reference;
    // "first thing tomorrow" is not.
    mem.reset();
    mem.setReferents(THREE);
    for (const q of [
        'what is in inventory',
        'send it first thing tomorrow',
        'how much do we owe acme',
    ]) {
        ck(`"${q}" is untouched`, mem.resolve(q).text === q, mem.resolve(q).text);
    }
}

section('F — the prompt puts history where the model will read it');
{
    // Liu et al. (TACL 2024), "Lost in the Middle": a fact at the start or
    // end of the context is used reliably, one in the middle is not. The
    // conversation used to sit after a large DATA blob and a tool dump —
    // the middle — and it is exactly what "what is the ERD" depends on.
    const src = require('fs').readFileSync(path.join(ROOT, 'helpers/yardAsk.js'), 'utf8');
    const iHistory = src.indexOf('historyText,');
    const iQuestion = src.indexOf('`QUESTION: ${asked}`');
    const iData = src.indexOf("'DATA (a summary");
    ck('history comes after the data', iHistory > iData && iData !== -1);
    ck('  and immediately before the question', iQuestion > iHistory && (iQuestion - iHistory) < 200,
       'gap of ' + (iQuestion - iHistory) + ' chars — anything large between them puts it back in the middle');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
