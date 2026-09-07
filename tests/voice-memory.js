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

// ── THE PART THAT DOES NOT NEED HER TO KNOW THE WORDS ────────────────────
// Apsara, 2026-09-06: "my user doesnt know about nouns. you can try to
// understand what he says like any ai does."
//
// Sections A–F above test a PHRASEBOOK: "the first one", "that booking",
// "forward that". Every one of those is a phrase I chose. A yard manager
// says "the Maersk one", "the one going to Korea", "the urgent one", or just
// "send it" — and every one of those returned resolved:null, which meant the
// booking number never reached the brain and the forward never happened.
//
// The model now decides WHICH ROW. What must survive that change is the one
// guarantee the determinism was there for: the model returns an INDEX into a
// list it was handed, and the booking number is read out of our own row. It
// never writes an identifier. These sections attack that boundary.
//
// gemini is stubbed through require.cache — voiceMemory requires it lazily
// inside pickRow(), so the stub is in place by the time it looks.
const geminiPath = require.resolve(path.join(ROOT, 'helpers/gemini.js'));
let lastPrompt = null;
function stubModel(reply) {
    lastPrompt = null;
    require.cache[geminiPath] = {
        id: geminiPath, filename: geminiPath, loaded: true,
        exports: {
            callGeminiJSON: async (prompt) => {
                lastPrompt = prompt;
                if (reply instanceof Error) throw reply;
                return typeof reply === 'function' ? reply(prompt) : reply;
            },
        },
    };
}
function threeOnScreen() {
    mem.reset();
    mem.setReferents({ kind: 'bookings', title: 'x', rows: [
        { n: 1, booking_number: 'AAA111', carrier: 'Maersk', from: 'Houston', to: 'Busan', vessel: 'MV ONE', cutoff: '09/10/2026' },
        { n: 2, booking_number: 'BBB222', carrier: 'MSC', from: 'Houston', to: 'Nhava Sheva', vessel: 'MV TWO', cutoff: '09/14/2026' },
        { n: 3, booking_number: 'CCC333', carrier: 'CMA', from: 'Houston', to: 'Qingdao', vessel: 'MV THREE', cutoff: '09/20/2026' },
    ] });
}

(async () => {

section('G — she can say it however she likes');
{
    // The four phrasings that used to fall straight through. None of them
    // contains a word from any pattern in the file.
    for (const [said, n, id] of [
        ['forward the Maersk one to Sher', 1, 'AAA111'],
        ['send the Korea one', 1, 'AAA111'],
        ['the one going to China', 3, 'CCC333'],
        ['do the MSC booking', 2, 'BBB222'],
    ]) {
        threeOnScreen();
        stubModel({ n, why: 'matched' });
        const r = await mem.resolveSmart(said);
        ck(`"${said}" → ${id}`, r.resolved && r.resolved.to === id,
           'got ' + JSON.stringify(r.resolved));
    }

    threeOnScreen();
    stubModel({ n: 2 });
    const r = await mem.resolveSmart('send it');
    ck('  and a bare "send it" reaches the model at all', r.resolved && r.resolved.to === 'BBB222',
       'BARE_DEICTIC_RE refused this with three on screen — correctly, on its own terms, '
       + 'but refusing is only right when nothing CAN work it out');
}

section('H — the model picks a row, it never writes a booking number');
{
    // THE WHOLE GUARANTEE. If a model can emit an identifier, a hallucinated
    // one forwards a container that does not exist — and the failure is
    // silent, because a plausible-looking booking number looks like a
    // resolution. Everything below is that boundary under attack.

    threeOnScreen();
    // A number outside the list. The nearest row must NOT be substituted.
    stubModel({ n: 7, why: 'confident nonsense' });
    const off = await mem.resolveSmart('the seventh one');
    ck('a row number off the end resolves to nothing', off.resolved === null,
       'clamping to the last row is the silent wrong answer — it forwards a real container');

    threeOnScreen();
    stubModel({ n: 0 });
    ck('  and so does row 0', (await mem.resolveSmart('that')).resolved === null);

    threeOnScreen();
    // The attack that matters: the model returns an identifier of its own.
    //
    // "the MSC one", NOT "the second one from the list" — which is what I
    // wrote first, and it made this whole check vacuous. An ordinal is
    // resolved by counting BEFORE the model is consulted (section J), so the
    // stub reply was never read and the assertion passed against code that
    // happily used the model's invented number. Caught by mutation, not by
    // reading it.
    stubModel({ n: 2, booking_number: 'ZZZ999', booking: 'ZZZ999', why: 'x' });
    const inv = await mem.resolveSmart('do the MSC one');
    ck('  a booking number IN the reply is ignored',
       inv.resolved && inv.resolved.to === 'BBB222',
       'got ' + (inv.resolved && inv.resolved.to) + ' — the id must come from OUR row, by index');
    ck('  and the invented one appears nowhere in the rewritten text',
       !/ZZZ999/.test(inv.text), inv.text);

    threeOnScreen();
    stubModel({ n: '2' });
    const numStr = await mem.resolveSmart('the MSC one');
    ck('  a numeric string still resolves by index',
       !!numStr.resolved && numStr.resolved.to === 'BBB222');

    threeOnScreen();
    stubModel({ n: 'BBB222' });
    ck('  but a non-numeric n resolves to nothing',
       (await mem.resolveSmart('the MSC one')).resolved === null,
       'accepting a string here is accepting an identifier from the model');
}

section('I — it declines, and it survives the model being gone');
{
    threeOnScreen();
    stubModel({ n: null });
    const dec = await mem.resolveSmart('what time do we close');
    ck('null means nothing was referred to', dec.resolved === null);

    threeOnScreen();
    stubModel(new Error('ECONNRESET'));
    const dead = await mem.resolveSmart('the Maersk one');
    ck('a dead model resolves to nothing rather than throwing', dead.resolved === null);

    // ...but the phrasebook still works when the network is down. An
    // assistant that cannot resolve "the first one" because of a blip is
    // worse than one that only knew six phrasings.
    threeOnScreen();
    stubModel(new Error('ECONNRESET'));
    const fb = await mem.resolveSmart('forward the first one to Sher');
    ck('  while "the first one" still resolves offline',
       fb.resolved && fb.resolved.to === 'AAA111',
       'the patterns are the net under the model, not a thing the model replaced');

    threeOnScreen();
    stubModel(null);
    ck('  and a null reply resolves to nothing',
       (await mem.resolveSmart('the Maersk one')).resolved === null);

    // No list on screen: no round trip at all. Asking a model to pick from
    // an empty list is latency spent to be told nothing.
    mem.reset();
    stubModel({ n: 1 });
    const none = await mem.resolveSmart('forward the Maersk one');
    ck('  with nothing on screen the model is not even called',
       none.resolved === null && lastPrompt === null);

    // pickRow's own guard, exercised DIRECTLY. Through resolveSmart it is
    // unreachable — the early return above gets there first — so deleting it
    // changed nothing and the mutation survived. A guard no test can reach
    // is a guard nobody is maintaining.
    stubModel({ n: 1 });
    // Caught, because the honest report is "this guard is gone", not a
    // stack trace that ends the run and prints no totals at all.
    const safe = async (s) => { try { return await mem.pickRow('x', s); } catch (e) { return 'THREW: ' + e.message; } };
    const mal = [await safe({ rows: [] }), await safe({}), await safe(null)];
    ck('  and pickRow refuses a malformed set on its own',
       mal.every((v) => v === null) && lastPrompt === null, JSON.stringify(mal));
    ck('  and refuses an empty utterance',
       (await mem.pickRow('   ', { rows: [{ n: 1, booking_number: 'A' }] })) === null
       && lastPrompt === null,
       'silence must not pick a container');
}

section('J — an exact ordinal does not spend a round trip');
{
    threeOnScreen();
    stubModel({ n: 3, why: 'the model disagrees' });
    const r = await mem.resolveSmart('forward the second one');
    // `!!r.resolved &&` matters: without it a regression here throws instead
    // of failing, node exits on the unhandled rejection, and the run prints
    // NOTHING — which reads as a broken suite rather than a caught bug.
    ck('"the second one" is counted, not asked about',
       !!r.resolved && r.resolved.to === 'BBB222',
       'got ' + JSON.stringify(r.resolved));
    ck('  and the model was never consulted', lastPrompt === null,
       'a counted index is not a judgement call; the round trip is latency for nothing');
}

section('K — the model only sees what she can see');
{
    threeOnScreen();
    stubModel({ n: 1 });
    await mem.resolveSmart('the Maersk one');
    ck('the rows are in the prompt', /Maersk/.test(lastPrompt) && /BBB222/.test(lastPrompt));
    ck('  her words are in the prompt', /the Maersk one/.test(lastPrompt));
    ck('  and it is told to refuse rather than guess',
       /null/i.test(mem.PICK_RULES) && /guess/i.test(mem.PICK_RULES));

    // A field that is not on screen must not be sent — a pick made on data
    // she cannot see is a pick she could not have meant.
    mem.reset();
    mem.setReferents({ kind: 'bookings', title: 'x', rows: [
        { n: 1, booking_number: 'AAA111', carrier: 'Maersk', supplier_secret: 'DO-NOT-SEND' },
        { n: 2, booking_number: 'BBB222', carrier: 'MSC' },
    ] });
    stubModel({ n: 1 });
    await mem.resolveSmart('the Maersk one');
    ck('  and nothing else is', !/DO-NOT-SEND/.test(lastPrompt));
}

section('L — when it asks back, it asks in her words');
{
    threeOnScreen();
    const d = mem.distinguishers();
    ck('three bookings are told apart by carrier', /Maersk/.test(d) && /MSC/.test(d) && /CMA/.test(d), d);
    ck('  phrased as she would say it', /the Maersk one/.test(d), d);
    ck('  and NOT as "say the first one"', !/first/i.test(d),
       'naming the phrase I happen to parse is the thing she objected to');

    // Same carrier on every row: the carrier tells her nothing, so fall
    // through to a field that does.
    mem.reset();
    mem.setReferents({ kind: 'bookings', title: 'x', rows: [
        { n: 1, booking_number: 'A', carrier: 'Maersk', vessel: '', from: 'Houston', to: 'Busan' },
        { n: 2, booking_number: 'B', carrier: 'Maersk', vessel: '', from: 'Houston', to: 'Qingdao' },
    ] });
    const same = mem.distinguishers();
    ck('a repeated field is skipped', !/Maersk/.test(same), same);
    ck('  in favour of one that differs', /Busan/.test(same) && /Qingdao/.test(same), same);
    ck('  and "from" is skipped too, being identical', !/Houston/.test(same), same);

    // A field present on one row and MISSING on the other. The values are
    // technically distinct, so the duplicate check waves it through — and
    // without a separate blank check she is offered "the Maersk one or the
    // one", which is not a question anybody can answer. This case is why the
    // blank check exists, and until mutation killed nothing I did not have
    // a fixture that reached it: my "nothing to go on" rows were blank AND
    // identical, so the duplicate check caught them first.
    mem.reset();
    mem.setReferents({ kind: 'bookings', title: 'x', rows: [
        { n: 1, booking_number: 'A', carrier: 'Maersk', vessel: '', from: 'Houston', to: 'Busan' },
        { n: 2, booking_number: 'B', carrier: '', vessel: '', from: 'Savannah', to: 'Qingdao' },
    ] });
    const half = mem.distinguishers();
    ck('a field missing on one row is skipped', !/Maersk/.test(half), half);
    // Destination, not origin — DISTINGUISH_BY tries carrier, vessel, `to`,
    // `from` in that order, and `to` is the first that both rows have and
    // that differs. I asserted Houston/Savannah here and it failed: I was
    // testing the order I imagined rather than the one in the file.
    ck('  in favour of the first one both rows have',
       /Busan/.test(half) && /Qingdao/.test(half), half);
    ck('  and no empty slot is offered', !/the\s+one\b|going to\s+one/.test(half), half);

    // Nothing distinguishes them: say so by returning null, so the caller
    // falls back to asking for the number. Offering "the  one or the  one"
    // would be worse than useless.
    mem.reset();
    mem.setReferents({ kind: 'bookings', title: 'x', rows: [
        { n: 1, booking_number: 'A', carrier: '', vessel: '', from: '', to: '' },
        { n: 2, booking_number: 'B', carrier: '', vessel: '', from: '', to: '' },
    ] });
    ck('with nothing to go on it returns null', mem.distinguishers() === null);

    mem.reset();
    ck('  and with no list at all, null', mem.distinguishers() === null);

    mem.reset();
    mem.setReferents({ kind: 'bookings', title: 'x', rows: [{ n: 1, booking_number: 'A', carrier: 'Maersk' }] });
    ck('  one row needs no distinguishing', mem.distinguishers() === null);
}

section('M — the endpoint uses the understanding version');
{
    // resolveSmart is async. Wiring it in without awaiting yields a Promise,
    // and `ref.text` on a Promise is undefined — which reaches the brain as
    // the literal string "undefined". Every test above would still pass.
    const api = require('fs').readFileSync(path.join(ROOT, 'api.js'), 'utf8')
        .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    ck('api.js calls resolveSmart', /mem\.resolveSmart\(/.test(api));
    ck('  and awaits it', /await mem\.resolveSmart\(stripped\)/.test(api),
       'an unawaited Promise makes ref.text undefined and the brain sees "undefined"');
    ck('  the old sync call is gone', !/=\s*mem\.resolve\(stripped\)/.test(api));
    ck('  and the ambiguity reply offers real distinguishers',
       /mem\.distinguishers\(\)/.test(api));
}

section('CENTER — "the erd of that booking" with ten on screen');
{
    // Apsara, 2026-09-07: "On follow up, if i ask when is the erd of that
    // booking. Instead of linking the context, it just says there are 10
    // bookings on screen. which one you want me to check?"
    //
    // Grosz, Joshi & Weinstein (1995). An utterance has a set of FORWARD-
    // looking centers — everything it mentions — and one BACKWARD-looking
    // center: the entity it is actually about. Centering's Rule 1 says that
    // if anything in the next utterance is pronominalised, the Cb is.
    //
    // Only the Cf was ever recorded here. The list went in, the row the
    // ANSWER was about did not, so resolve() counted ten and refused.
    const ten = [];
    for (let i = 1; i <= 10; i += 1) ten.push({ n: i, booking_number: 'BK' + i });

    mem.reset();
    mem.setReferents({ kind: 'bookings', title: 'Bookings — HOUSTON', rows: ten });

    // BEFORE the answer, refusing is still right: nothing has singled one out.
    const cold = mem.resolve('when is the erd of that booking');
    ck('with nothing discussed yet, ten on screen is still ambiguous',
       cold.resolved === null && cold.ambiguous === 10,
       'asking is correct here — no sentence has been about any one of them');

    // "Earliest cutoff is next Wednesday" is a statement about rows[0].
    mem.setCenter(ten[0]);
    const warm = mem.resolve('when is the erd of that booking');
    ck('once one has been discussed, "that booking" means that one',
       !!warm.resolved && warm.resolved.to === 'BK1', JSON.stringify(warm));
    ck('  and the pronoun is replaced, not left alongside the number',
       warm.text === 'when is the erd of booking BK1', warm.text);

    // AN EXPLICIT ORDINAL STILL WINS. She said "the third one"; obeying the
    // center there would answer about a different booking than the one she
    // just named, which is worse than refusing.
    ck('an explicit ordinal beats the center',
       (mem.resolve('forward the third one').resolved || {}).to === 'BK3');

    // A NEW LIST CLEARS IT. Carrying the center across is worse than having
    // none: it would resolve confidently to a booking not even on screen.
    mem.setReferents({ kind: 'bookings', title: 'Bookings — OAKLAND', rows: [
        { n: 1, booking_number: 'OAK1' }, { n: 2, booking_number: 'OAK2' },
    ] });
    const after = mem.resolve('when is the erd of that booking');
    ck('a new list clears the center', after.resolved === null && after.ambiguous === 2,
       JSON.stringify(after) + ' — BK1 is not on screen any more');
    // ASSERTED DIRECTLY, not just through resolve(). There are two guards
    // here — setReferents clears the center, and resolve() checks the center
    // is still in the set — and they overlap, so a mutation deleting the
    // FIRST one survived: the second caught it and every assertion stayed
    // green. Belt and braces are only worth having if each is checked on its
    // own, or one of them gets removed as dead code by someone who is right
    // that no test needs it.
    ck('  the center itself is gone, not merely unusable',
       mem.currentCenter() === null,
       'a stale center surviving a new list is a resolution waiting to happen');

    // AND A CENTER THAT IS NO LONGER IN THE SET IS IGNORED, even if something
    // sets it directly. The set is the fact; the center is a hint.
    mem.setCenter({ n: 1, booking_number: 'NOT_ON_SCREEN' });
    const gone = mem.resolve('when is the erd of that booking');
    ck('  and a center missing from the current list resolves to nothing',
       gone.resolved === null && gone.ambiguous === 2, JSON.stringify(gone));

    // reset() clears it too, or a center leaks between sessions.
    mem.reset();
    ck('reset clears the center', mem.currentCenter() === null);

    // ── AND WHERE IT IS SET FROM ─────────────────────────────────────────
    // Gated on the spoken sentence having actually named a cutoff. A bare
    // "Yes — 10 bookings from Houston." singles nothing out, and centring on
    // rows[0] regardless would make "that booking" a guess in a resolution's
    // clothing.
    const api = require('fs').readFileSync(path.join(ROOT, 'api.js'), 'utf8');
    ck('the list answer sets the center only when it named a cutoff',
       /if \(\/cutoff\/i\.test\(said\)\) mem\.setCenter\(cards\.rows\[0\]\);/.test(api),
       'centring on a sentence that singled nothing out is a guess');
    ck('  and a follow-up answer moves it only when it names ONE booking',
       /if \(named\.length === 1\) mem\.setCenter\(named\[0\]\);/.test(api),
       'two names or none, and it stays where it was rather than picking');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})();
