// ── tests/pick-from-list.js ───────────────────────────────────────────────
// Apsara, 2026-09-09: "when i hav multiple trucers,it asking to tell name or
// choose from number. when i say one -its not detected. when i again say 1,
// getting detected as 11. also When i say trucker name as Jey, it is
// transcribing as J or Jai or JJ. as a ai,is it that difficult to map like
// chatgpt or claude does?"
//
// Three complaints, three causes, and only one of them was about speech:
//   1. "one" — the resolver read DIGITS only
//   2. "11"  — the client glued two separate answers together (voice-web.js)
//   3. "Jai" — nothing ever compared her word to the list on her screen
//
// WHAT THIS FILE GUARDS, in order of how badly it fails:
//   · a WRONG pick from an ambiguous word. The old code returned the first
//     option containing her text, so with two J-named hauliers "J" silently
//     chose one — and a truck goes to whoever it chose.
//   · a position she said in words being ignored, so she repeats herself
//   · a mis-heard short name being unrecoverable when the answer was one of
//     three things on screen

const path = require('path');
let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const { pick, positionOf, why } = require(path.join(ROOT, 'helpers/pickFromList.js'));

console.log('\n─ choosing one of a few, out loud ───────────────────────────');

// Her real roster shape: a short name that the recogniser mangles, and two
// others that must not be collateral damage.
const TRUCKERS = ['Jey Transport', 'Sher Trucking', 'Bayou Haulage'];

section('A — she says a position');
{
    // THE ONE SHE REPORTED FIRST. "one" is the commonest way to answer a
    // numbered list out loud, and it did nothing at all.
    ck('"one" picks the first', pick('one', TRUCKERS) === 'Jey Transport');
    ck('  and so does "1"', pick('1', TRUCKERS) === 'Jey Transport');
    for (const [said, want] of [
        ['two', 'Sher Trucking'], ['three', 'Bayou Haulage'],
        ['first', 'Jey Transport'], ['second', 'Sher Trucking'], ['third', 'Bayou Haulage'],
        ['the first one', 'Jey Transport'], ['the second one', 'Sher Trucking'],
        ['number 2', 'Sher Trucking'], ['no. 3', 'Bayou Haulage'],
        ['option 1', 'Jey Transport'], ['2nd', 'Sher Trucking'], ['3rd', 'Bayou Haulage'],
        ['last', 'Bayou Haulage'], ['1.', 'Jey Transport'], ['  2  ', 'Sher Trucking'],
    ]) ck(`  "${said}" → ${want}`, pick(said, TRUCKERS) === want, String(pick(said, TRUCKERS)));

    // What the recogniser actually returns for "one" and "two" often enough
    // to matter. Not guesses — these are homophones, and reading them as
    // words instead of positions is what made her say it twice.
    ck('  the recogniser\'s "won" is still one', pick('won', TRUCKERS) === 'Jey Transport');
    ck('  and "too" is still two', pick('too', TRUCKERS) === 'Sher Trucking');

    // OUT OF RANGE IS NOT ROUNDED IN. She said 5 of 3; answering with the
    // third would be inventing a choice she did not make.
    ck('5 of 3 picks nothing', pick('5', TRUCKERS) === null);
    ck('  and so does 11 — the number she never said', pick('11', TRUCKERS) === null);
    ck('  and 0', pick('0', TRUCKERS) === null);
}

section('B — she says a name, and the recogniser mangles it');
{
    ck('the full name works', pick('Jey Transport', TRUCKERS) === 'Jey Transport');
    ck('  and the first word alone', pick('Jey', TRUCKERS) === 'Jey Transport');
    ck('  case does not matter', pick('jey transport', TRUCKERS) === 'Jey Transport');
    ck('  nor does the second word', pick('haulage', TRUCKERS) === 'Bayou Haulage');

    // THE THREE SHE NAMED. "Jey" comes back as one of these because a
    // one-syllable proper noun carries almost no acoustic information — no
    // recogniser reliably recovers it from audio alone. What recovers it is
    // knowing the answer is one of three things.
    for (const heard of ['J', 'Jai', 'JJ', 'jay', 'je']) {
        ck(`  "${heard}" still reaches Jey Transport`,
           pick(heard, TRUCKERS) === 'Jey Transport', String(pick(heard, TRUCKERS)));
    }
    // And the others survive their own manglings.
    ck('  "shar" reaches Sher Trucking', pick('shar', TRUCKERS) === 'Sher Trucking');
    ck('  "bio" reaches Bayou Haulage', pick('bio', TRUCKERS) === 'Bayou Haulage');
}

section('C — ambiguity is a question, never a guess');
{
    // THE BUG SHE HAD NOT HIT YET, and the reason this file exists as much as
    // the ones she did hit. The old resolver was
    //     options.find(o => o.toLowerCase().includes(t))
    // which returns the FIRST match. With these two on screen, "J" chose one
    // of them silently, and a real driver gets a real message.
    const TWO_J = ['Jey Transport', 'Jio Logistics', 'Sher Trucking'];
    ck('"J" against two J companies picks NOTHING', pick('J', TWO_J) === null,
       'silently choosing one of them sends a booking to the wrong yard');
    ck('  and says why, so the caller can ask properly', why('J', TWO_J) === 'ambiguous');
    // But once she is specific it resolves, so the guard is not just refusal.
    ck('  "jey" is unambiguous and works', pick('jey', TWO_J) === 'Jey Transport');
    ck('  "jio" too', pick('jio', TWO_J) === 'Jio Logistics');

    ck('a word matching nothing picks nothing', pick('xyz', TRUCKERS) === null);
    ck('  and is reported as unrecognised, not ambiguous', why('xyz', TRUCKERS) === 'none');

    // Empty and rubbish inputs must not throw — this runs on transcripts.
    for (const junk of ['', '   ', null, undefined, '...', '🚚']) {
        let threw = null;
        try { pick(junk, TRUCKERS); } catch (e) { threw = e.message; }
        ck(`  ${JSON.stringify(junk)} is handled without throwing`, !threw, String(threw));
    }
    ck('  an empty list picks nothing', pick('one', []) === null);
    ck('  and a missing list does not throw',
       (() => { try { return pick('one', null) === null; } catch (e) { return false; } })());
}

section('D — booking numbers, the other thing she is asked to choose');
{
    // The same picker now serves the "which booking?" question, so a mis-heard
    // booking number behaves like a mis-heard trucker rather than like a
    // second hand-rolled implementation.
    const BOOKINGS = ['HOU111', 'HOU222'];
    ck('a booking number picks itself', pick('HOU222', BOOKINGS) === 'HOU222');
    ck('  said in lower case', pick('hou222', BOOKINGS) === 'HOU222');
    ck('  and a position still works', pick('one', BOOKINGS) === 'HOU111');
    // Two numbers that differ by one character must NOT be fuzzy-matched into
    // each other — a booking id is an identity, and "close" is not a match.
    ck('  HOU111 and HOU222 do not bleed into each other',
       pick('HOU111', BOOKINGS) === 'HOU111' && pick('HOU222', BOOKINGS) === 'HOU222');
    ck('  and something near BOTH picks neither', pick('HOU', BOOKINGS) === null,
       'a prefix shared by two bookings is a question, not a choice');

    // ── THE ONE THAT WOULD ACTUALLY SEND THE WRONG CONTAINER ─────────────
    // A booking number she got slightly wrong must not be rounded to the
    // nearest one. With ['HOU111','LGB444'] and a heard "HOU112", the sound
    // tier finds exactly ONE plausible match — HOU111 — and every guard above
    // it passes cleanly. It looks like a confident resolution and it is a
    // different container on a different truck.
    //
    // This is why identifiers stop at exact matching. A name half-heard is a
    // name; a number half-heard is a different number.
    const MIXED = ['HOU111', 'LGB444'];
    ck('  a booking number one digit out picks NOTHING',
       pick('HOU112', MIXED) === null,
       'rounding to the nearest booking sends the wrong container to a real truck');
    ck('  and one that is right still picks itself',
       pick('HOU111', MIXED) === 'HOU111',
       'the guard must refuse near misses without refusing correct answers');
}

section('E — positionOf on its own');
{
    ck('positions are 1-based, as spoken', positionOf('1', 3) === 1 && positionOf('three', 3) === 3);
    ck('  "last" needs to know how many there are', positionOf('last', 4) === 4);
    ck('  and a name is not a position', positionOf('Jey', 3) === null);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
