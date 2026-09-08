// ── tests/name-suggest.js ─────────────────────────────────────────────────
// Apsara, 2026-09-07: "If i say send mail to jeyshree.. It got transcripted as
// jayashree. I want it to check email for any matching thing auto adjusting
// spelling. then ask."
//
// TWO LAYERS, AND THE ORDER MATTERS
//   PREVENTION — helpers/voiceVocab.js biases Whisper with her own roster, so
//                the name is heard right in the first place. This is what the
//                contextual-biasing literature says to do, and what Siri and
//                Alexa actually do.
//   RECOVERY   — helpers/nameSuggest.js repairs a mis-hearing that got
//                through, and ASKS before using it.
//
// THE INVARIANT THIS FILE EXISTS TO PROTECT, above everything else:
// helpers/nameMatch.js refuses fuzzy matching because "a near-miss resolves
// to the wrong company and a real quote request or email goes to them". That
// rule is not being relaxed. Fuzzy may SUGGEST; only her yes may RESOLVE.
// Section D is that, and it is the section that matters.

const path = require('path');
const fs = require('fs');
let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const ns = require(path.join(ROOT, 'helpers/nameSuggest.js'));
const vv = require(path.join(ROOT, 'helpers/voiceVocab.js'));

console.log('\n─ hearing a name wrong, and recovering ──────────────────────');

section('A — HER CASE');
{
    const roster = [
        { name: 'Jayashree Menon', email: 'jayashree@example.com' },
        { name: 'Yurim Kim', email: 'yurim@example.com' },
        { name: 'Daekwang Metals', email: 'daekwang@example.com' },
        { name: 'Sher Trucking', email: 'sher@example.com' },
    ];
    const got = ns.suggest('jeyshree', roster);
    ck('"jeyshree" reaches Jayashree', got.length > 0 && got[0].name === 'Jayashree Menon',
       JSON.stringify(got.map((g) => g.name)));
    ck('  because it SOUNDS the same, not because it looks it',
       got[0] && got[0].why === 'sounds the same', got[0] && got[0].why);

    // The skeletons, which are the whole mechanism.
    ck('the phonetic key ignores the vowels romanisation moves around',
       ns.phonetic('Jeyshree') === ns.phonetic('Jayashree')
       && ns.phonetic('Jeyshree') === ns.phonetic('Jayshri'),
       [ns.phonetic('Jeyshree'), ns.phonetic('Jayashree'), ns.phonetic('Jayshri')].join(' / '));

    // SHE SAYS A FIRST NAME. The contact is a full name. The first version of
    // suggest() compared whole strings and matched nothing at all — the exact
    // case it was written for.
    ck('a first name matches a full-name record',
       ns.suggest('yoorim', roster).map((x) => x.name)[0] === 'Yurim Kim',
       JSON.stringify(ns.suggest('yoorim', roster)));
    ck('  and a company heard loosely still lands',
       ns.suggest('dakwang', roster).map((x) => x.name)[0] === 'Daekwang Metals');
}

section('B — and it refuses far more than it offers');
{
    const roster = [
        { name: 'Jayashree Menon', email: 'j@x.com' },
        { name: 'Ashree Exports', email: 'a@x.com' },
        { name: 'Cher Logistics', email: 'c@x.com' },
        { name: 'Sher Trucking', email: 's@x.com' },
        { name: 'Zimex', email: 'z@x.com' },
        // FIXTURES CHOSEN TO ISOLATE ONE GUARD EACH. My first pair could not:
        // "jeyshree" misses "Ashree" on similarity anyway, and "raj" misses
        // everything on the parts filter — so deleting the guards changed
        // nothing and two mutations survived while looking covered.
        //
        // "Cherry" is 0.83 similar to "sherry", over the spelling threshold,
        // and differs ONLY in the initial. "Raja" shares a phonetic skeleton
        // with "raj" and is 0.75 similar, over the phonetic threshold, and is
        // stopped ONLY by the query being three characters.
        { name: 'Cherry Exports', email: 'ch@x.com' },
        { name: 'Raja Metals', email: 'ra@x.com' },
        // AND ONE FOR THE PHONETIC REQUIREMENT ITSELF. "Sherpa" is 0.67
        // similar to "sherry" — over MIN_SIMILARITY — shares its initial, and
        // sounds nothing like it (Sr vs Srp). It is refused ONLY because
        // phonetic agreement is required alongside that similarity.
        //
        // Found by scripts/mutate.js: dropping the sameSound requirement
        // survived every assertion in this file, because nothing here was
        // 0.62-similar to anything without also rhyming with it.
        { name: 'Sherpa Lines', email: 'sp@x.com' },
    ];
    // FIRST LETTER AGREEMENT. The initial is the sound a listener almost
    // never mishears, and without this guard "Jeyshree" reaches "Ashree" and
    // "Sher" reaches "Cher" — both entirely plausible on edit distance.
    ck('"jeyshree" does NOT reach Ashree',
       !ns.suggest('jeyshree', roster).some((x) => /Ashree/.test(x.name)),
       JSON.stringify(ns.suggest('jeyshree', roster).map((x) => x.name)));
    ck('"sher" does NOT reach Cher',
       !ns.suggest('sher', roster).some((x) => /Cher/.test(x.name)),
       JSON.stringify(ns.suggest('sher', roster).map((x) => x.name)));
    // The isolating one: over the spelling threshold, differing only in the
    // first letter. Without the guard this matches.
    ck('  and "sherry" does NOT reach Cherry, though the spelling is 0.83 close',
       !ns.suggest('sherry', roster).some((x) => /Cherry/.test(x.name)),
       JSON.stringify(ns.suggest('sherry', roster).map((x) => x.name))
       + ' — the initial is the sound a listener does not mishear');

    // SIMILARITY ALONE IS NOT ENOUGH. Over MIN_SIMILARITY, same initial, and
    // it still must not be offered — a name that merely looks close is what
    // nameMatch.js refuses to act on, and a mis-HEARING is the only thing
    // this file exists to repair.
    ck('"sherry" does NOT reach Sherpa, though it is 0.67 similar',
       !ns.suggest('sherry', roster).some((x) => /Sherpa/.test(x.name)),
       JSON.stringify(ns.suggest('sherry', roster).map((x) => x.name))
       + ' — over the similarity floor, but it does not sound the same');
    ck('  and the two really are far apart phonetically',
       ns.phonetic('sherry') !== ns.phonetic('Sherpa'),
       ns.phonetic('sherry') + ' vs ' + ns.phonetic('Sherpa')
       + ' — if these ever converge the assertion above proves nothing');

    // Nothing at all is a normal answer, and the caller falls back to asking
    // outright. A matcher that always produces a best guess is the thing
    // nameMatch.js warns about.
    for (const q of ['xyzzy', 'qqqq', 'northwind', 'gupta']) {
        ck(`"${q}" suggests nothing`, ns.suggest(q, roster).length === 0,
           JSON.stringify(ns.suggest(q, roster).map((x) => x.name)));
    }

    // TOO SHORT TO GUESS FROM. "Raj" is three characters and half her address
    // book is within two edits of it.
    // "Raja" shares raj's phonetic skeleton and is 0.75 similar — over the
    // phonetic threshold. The ONLY thing refusing it is the length floor, and
    // it has to be, because half an address book sits within two edits of a
    // three-letter name.
    ck('a very short name is not guessed at', ns.suggest('raj', roster).length === 0,
       JSON.stringify(ns.suggest('raj', roster).map((x) => x.name))
       + ' — "Raja" is phonetically identical; three letters is not evidence');
    ck('  nor an empty one', ns.suggest('', roster).length === 0 && ns.suggest(null, roster).length === 0);

    // An EXACT match is nameMatch.js's decision, not a suggestion. Returning
    // it here would have the caller ask her about something already certain.
    ck('an exact name is not offered as a suggestion',
       !ns.suggest('Zimex', roster).some((x) => x.name === 'Zimex'));
}

section('C — the vocabulary that stops it happening at all');
{
    const p = vv.buildPrompt({
        ports: ['HOUSTON', 'BUSAN'],
        truckers: [{ name: 'Sher Trucking' }],
        suppliers: [{ name: 'Eccomelt' }],
        contacts: [{ name: 'Jayashree Menon' }],
        consignees: ['Daekwang'],
    });
    ck('her people are in the prompt', /Jayashree Menon/.test(p), p);
    ck('  and her ports', /HOUSTON/.test(p) && /BUSAN/.test(p));
    ck('  alongside the wording that already earned its place',
       p.startsWith(vv.BASE), p.slice(0, 60));

    // ATTENTION FAVOURS THE END OF THE PROMPT — the Whisper biasing paper is
    // explicit about it. So the names heard worst, people's, go last.
    ck('people are in the high-attention tail, not the head',
       p.indexOf('Jayashree') > p.indexOf('HOUSTON'),
       'ports before people: ' + p.slice(-80));

    // THE 224-TOKEN CAP. Past it Whisper truncates silently, so an unbounded
    // roster would drop names with nothing to show for it.
    const many = Array.from({ length: 400 }, (_, i) => ({ name: 'Contact Number ' + i }));
    const big = vv.buildPrompt({ contacts: many });
    ck('a huge roster is capped', big.length <= vv.BUDGET, big.length + ' > ' + vv.BUDGET);
    ck('  by dropping from the FRONT, so the tail survives',
       /Contact Number 29\b/.test(big) && !/Contact Number 0,/.test(big),
       big.slice(-70));

    // No data at all still returns the sentence that fixed "Hey Jarvis"
    // being heard as "I'll see you later".
    ck('with no roster it falls back to the base prompt', vv.buildPrompt({}) === vv.BASE);
    ck('  and so does undefined', vv.buildPrompt() === vv.BASE);

    // Bare names, comma separated. A narrative prompt makes Whisper
    // hallucinate its own style into silence — speech.js already records that.
    ck('the names are a plain list, not prose',
       !/\b(the|and|please|is|are)\b/i.test(p.slice(vv.BASE.length)), p.slice(vv.BASE.length));
}

section('D — SUGGESTION IS NOT RESOLUTION');
{
    // The invariant. helpers/nameMatch.js is untouched and stays exact.
    const nm = fs.readFileSync(path.join(ROOT, 'helpers/nameMatch.js'), 'utf8');
    ck('nameMatch.js is still exact-only',
       /DELIBERATELY NOT FUZZY/.test(nm) && !/levenshtein|editDistance/i.test(
           nm.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')),
       'the decision layer must not learn to guess');

    // And the caller ASKS. Nothing in the suggestion path assigns an address.
    const acts = fs.readFileSync(path.join(ROOT, 'workflow/actions.js'), 'utf8');
    const blk = acts.slice(acts.indexOf("const { suggest } = require('../helpers/nameSuggest')"),
                           acts.indexOf('if (!to) {', acts.indexOf('nameSuggest')));
    ck('the suggestion block never sets the recipient',
       !/\bto\s*=/.test(blk),
       'assigning `to` here is exactly the near-miss nameMatch.js warns about');
    ck('  it raises a pending instead', /type: 'await_name_confirm'/.test(blk));
    ck('  quoting back what it HEARD',
       /I don.t have anyone called "\$\{targetName\}"/.test(blk),
       'without the heard spelling she cannot tell a mis-hearing from an invention');
    ck('  and a failure there falls through rather than breaking the send',
       /name suggestion failed, carrying on/.test(blk));

    // ── AND IT LEARNS, or she is asked the same question for ever ────────
    // The recogniser will mishear that name every single time; confirming
    // once does not change the acoustics.
    // ── LOCATED BY WHAT IT IS, NOT WHERE IT WAS ─────────────────────────
    // This block started life inside resolvePending's switch and moved out to
    // an early `if`, ahead of the generic 'no' branch, because "no" here
    // means "wrong person" rather than "cancel everything". The slice was
    // still hunting for `case 'await_name_confirm'`, found nothing, and
    // sliced from -1 — so five assertions failed against correct code and,
    // worse, failed identically under every mutation, which made a whole
    // mutation run look meaningful when it was measuring the same broken
    // slice six times.
    const resStart = acts.indexOf("if (pending.type === 'await_name_confirm')");
    ck('the confirmation branch was found', resStart !== -1,
       'renamed or moved — every assertion below would be comparing nothing');
    const res = acts.slice(resStart, acts.indexOf("if (pending.type === 'await_cc_pattern_confirm')"));
    ck('  and it sits BEFORE the generic no', resStart !== -1
       && resStart < acts.indexOf("if (pending.type === 'await_cc_pattern_confirm')"),
       'a no here means "wrong person", not "throw the request away"');
    ck('a confirmed suggestion is remembered',
       /addContact\(pending\.heard, chosen\.email/.test(res),
       'without this she answers the same question every time she says the name');
    ck('  and says so, so she knows it will not ask again',
       /I'll remember/.test(res), res.slice(0, 200));
    ck('  a decline does NOT learn anything',
       res.indexOf("action_taken: 'name_suggestion_declined'") !== -1
       && res.indexOf("action_taken: 'name_suggestion_declined'") < res.indexOf('addContact('),
       'the refusal path must return before the write');
    ck('  and asks for the address instead of giving up',
       /type: 'await_manual_email_address'/.test(res));
    ck('  while a failed write never loses the email in progress',
       /could not remember/.test(res) && /\}\s*catch\s*\(\w+\)\s*\{/.test(res),
       'the variable name is not the point — the catch is');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
