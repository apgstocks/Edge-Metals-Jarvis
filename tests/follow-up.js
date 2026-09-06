// ── tests/follow-up.js ────────────────────────────────────────────────────
// Apsara, 2026-09-06, twice over:
//
//   "It should not read out anything extra like unassigned supplier etc. I
//    want how a human assistant will handle it. They will say yes boss, we
//    have 3 bookings available, earliest cutoff is next wednesday. You want
//    me to forward that? Then wait for followup question."
//
//   "Everytime when i say hey jarvis, it is like restarting all over again
//    without any idea about context memory."
//
// TWO COMPLAINTS, ONE CAUSE
// -------------------------
// Every question went to a language model with a fresh prompt. A model
// handed a table answers by describing the table — hence the recital of
// container counts and unassigned suppliers nobody asked for. And the
// brain's transcript records what she SAYS, never what it REPLIED, so a
// follow-up arrived with nothing to attach to.
//
// So these answers are composed here, from the list already on screen. No
// model, no round trip, and no way to invent a date — which matters because
// the sentence after these is usually "forward that".
//
// The two things under test are exactly her two sentences: what gets SAID,
// and whether the next question is understood.

const path = require('path');
let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
process.env.DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const fu = require(path.join(ROOT, 'helpers/followUp.js'));

// A fixed "today" so the relative dates are deterministic. Cutoffs land on
// a Wednesday and a Monday, which is what she used in her own example.
const NOW = new Date(2026, 6, 8);       // Wed 8 July 2026
const THREE = {
    title: 'Bookings — HOUSTON',
    rows: [
        { n: 1, booking_number: 'AAA111', carrier: 'MAERSK LINES, INC.', from: 'HOUSTON', to: 'BUSAN',
          vessel: 'SAN FERNANDO 629W', erd: '07/07/2026', cutoff: '07/15/2026',
          containers: [{ seq: 1, supplier: null, trucker: null }], container_count: 1, unassigned: 1 },
        { n: 2, booking_number: 'BBB222', carrier: 'HYUNDAI', from: 'HOUSTON', to: 'BUSAN',
          vessel: 'YM MILESTONE', erd: '07/10/2026', cutoff: '07/20/2026',
          containers: [{ seq: 1, supplier: 'APS', trucker: null }], container_count: 1, unassigned: 0 },
        { n: 3, booking_number: 'CCC333', carrier: 'ONE', from: 'HOUSTON', to: 'BUSAN',
          vessel: 'ONE OLYMPUS', erd: '07/12/2026', cutoff: '07/28/2026',
          containers: [{ seq: 1, supplier: null, trucker: null }], container_count: 1, unassigned: 1 },
    ],
};

console.log('\n─ answering like someone who was listening ──────────────────');

section('A — HER SENTENCE, almost word for word');
{
    const said = fu.opening(THREE, NOW);
    // "yes boss, we have 3 bookings available, earliest cutoff is next
    // wednesday. You want me to forward that?"
    ck('it opens with yes and a count', /^Yes — 3 bookings/.test(said), said);
    ck('  names the port', /Houston/.test(said), said);
    ck('  gives the earliest cutoff IN WORDS', /next Wednesday/.test(said),
       said + ' — 07/15 from Wed 8 July is next Wednesday');
    ck('  and OFFERS the next step', /Want me to forward/.test(said),
       'the offer is what makes it an assistant rather than a search box');
}

section('B — AND NOTHING ELSE');
{
    // The actual complaint. Every one of these is on the screen and none of
    // them was asked for.
    const said = fu.opening(THREE, NOW);
    for (const noise of ['unassigned', 'supplier', 'container', 'MAERSK', 'HYUNDAI',
                         'vessel', 'SAN FERNANDO', 'BUSAN', 'ERD', 'AAA111', '07/15']) {
        ck(`it does not read out "${noise}"`, said.indexOf(noise) === -1,
           said);
    }
    ck('and it is short enough to listen to', said.length < 140,
       said.length + ' chars — a paragraph read aloud is a paragraph nobody hears');
}

section('C — THE FOLLOW-UP SHE NAMED');
{
    const set = { rows: THREE.rows };
    const a = fu.answerFollowUp('when is the next cutoff', set, null, NOW);
    ck('"when is the next cutoff" is answered', !!a, String(a));
    ck('  in words, with the urgency', /next Wednesday/.test(a) && /in 7 days/.test(a), a);
    ck('  and nothing else is recited',
       a.indexOf('supplier') === -1 && a.indexOf('MAERSK') === -1, a);
}

section('D — the rest of the conversation');
{
    const set = { rows: THREE.rows };
    const ask = (q, ref) => fu.answerFollowUp(q, set, ref || null, NOW);

    ck('"what is the ERD" answers about the same booking',
       /yesterday/.test(ask('what is the erd')), String(ask('what is the erd')));
    ck('"which carrier" answers', /MAERSK/.test(ask('which carrier')), String(ask('which carrier')));
    ck('  without a doubled full stop', !/\.\./.test(ask('which carrier')),
       ask('which carrier') + ' — "INC.." is an audible extra beat when read aloud');
    ck('"which vessel"', /SAN FERNANDO/.test(ask('which vessel')), String(ask('which vessel')));
    ck('"which port"', /HOUSTON to BUSAN/.test(ask('which port')), String(ask('which port')));
    ck('"how many containers"', /3 bookings/.test(ask('how many containers are there')),
       String(ask('how many containers are there')));

    // "and the one after that" — walking the list, which is what a person
    // does with three of anything.
    const nxt = ask('what about the one after that');
    ck('"the one after that" moves down the list', /BBB222/.test(nxt), String(nxt));
    ck('  and from a NAMED row it moves from THERE',
       /CCC333/.test(ask('and the one after that', THREE.rows[1])),
       String(ask('and the one after that', THREE.rows[1])));
    ck('  and says so when there is no next one',
       /last one/i.test(ask('the one after that', THREE.rows[2])),
       String(ask('the one after that', THREE.rows[2])));
}

section('E — the supplier, when she ASKS for it');
{
    // She objected to it being volunteered, not to it existing.
    const set = { rows: THREE.rows };
    ck('asked directly, it answers',
       /No supplier on AAA111/.test(fu.answerFollowUp('who is the supplier', set, null, NOW)),
       String(fu.answerFollowUp('who is the supplier', set, null, NOW)));
    ck('  and names one when there is one',
       /APS/.test(fu.answerFollowUp('what supplier', set, THREE.rows[1], NOW)),
       String(fu.answerFollowUp('what supplier', set, THREE.rows[1], NOW)));
}

section('F — IT DOES NOT GUESS');
{
    const set = { rows: THREE.rows };
    for (const q of [
        'what is the weather',
        'how much do we owe acme',
        'send an email to yurim',
        'what is in inventory',
    ]) {
        ck(`"${q}" falls through to the assistants`,
           fu.answerFollowUp(q, set, null, NOW) === null,
           'answering this from a booking list would be confidently wrong');
    }
    ck('and with no list, nothing is answered',
       fu.answerFollowUp('when is the next cutoff', null, null, NOW) === null,
       'a follow-up with nothing to follow is not a follow-up');
    ck('  nor with an empty one',
       fu.answerFollowUp('when is the next cutoff', { rows: [] }, null, NOW) === null);
}

section('G — dates, the way a person says them');
{
    const at = (s) => fu.relative(s, NOW);          // NOW = Wed 8 July 2026
    ck('today', at('07/08/2026') === 'today', at('07/08/2026'));
    ck('tomorrow', at('07/09/2026') === 'tomorrow', at('07/09/2026'));
    ck('yesterday', at('07/07/2026') === 'yesterday', at('07/07/2026'));
    ck('this Friday', at('07/10/2026') === 'this Friday', at('07/10/2026'));
    ck('next Wednesday', at('07/15/2026') === 'next Wednesday', at('07/15/2026'));
    ck('last Friday', at('07/03/2026') === 'last Friday', at('07/03/2026'));
    ck('further out is a count', /^in \d+ days$/.test(at('07/28/2026')), at('07/28/2026'));

    // Urgency is the number she acts on.
    ck('a cutoff today says today', fu.urgency('07/08/2026', NOW) === 'today');
    ck('  tomorrow says tomorrow', fu.urgency('07/09/2026', NOW) === 'tomorrow');
    ck('  and a passed one says so', fu.urgency('07/01/2026', NOW) === 'already passed',
       'a booking past its cutoff must never sound like an option');

    // An unparseable date must come back as itself, never as a wrong day.
    ck('a date it cannot read is passed through unchanged',
       fu.relative('sometime next month', NOW) === 'sometime next month');
}

section('H — one booking reads differently from three');
{
    const one = { title: 'Bookings — HOUSTON', rows: [THREE.rows[0]] };
    const said = fu.opening(one, NOW);
    ck('singular', /one booking/.test(said) && !/1 bookings/.test(said), said);
    ck('  and the offer is singular too', /forward it\?/.test(said), said);
    ck('  with no "earliest" when there is nothing to be earliest than',
       !/[Ee]arliest/.test(said), said);
}

section('I — NO FIXED INTENTS: the model answers, the patterns are the net');
{
    // Apsara: "i dont want any fixed intent."
    //
    // The regex list answers the six questions I happened to think of and
    // stares blankly at the seventh — which is the one she actually asks.
    // So the model answers, and the patterns are only the offline net.
    //
    // Gemini is replaced in the require cache. What is under test is the
    // WIRING and the DATA HANDED OVER, not the model's judgement.
    const gp = require.resolve(path.join(ROOT, 'helpers/gemini.js'));
    let seen = null;
    require.cache[gp] = {
        id: gp, filename: gp, loaded: true,
        exports: { callGeminiJSON: async (prompt) => { seen = prompt; return { answer: 'Three of them, soonest next Wednesday.', have_data: true }; } },
    };
    delete require.cache[require.resolve(path.join(ROOT, 'helpers/followUp.js'))];
    const fu2 = require(path.join(ROOT, 'helpers/followUp.js'));

    return (async () => {
        const set = { rows: THREE.rows };

        // A question NO pattern covers. This is the whole point.
        const novel = await fu2.answer('which of these could still make it if we move tomorrow', set, null, NOW);
        ck('a question no pattern covers is still answered', !!novel, String(novel));
        ck('  by the model, not a regex', /Three of them/.test(novel), String(novel));

        // ── WHAT IT IS HANDED ────────────────────────────────────────────
        ck('the model gets the rows on her screen', /AAA111/.test(seen));
        // ASSERTED ON THE DATA, NOT THE RULES. My first version matched
        // /next Wednesday/ anywhere in the prompt — and the RULES contain
        // that phrase as an EXAMPLE, so a mutation stripping the converted
        // dates out of the data survived. The check now reads the JSON.
        const dataJson = seen.slice(seen.indexOf('DATA ('));
        // No stripping. JSON.stringify emits no spaces between tokens, and
        // removing whitespace turned "next Wednesday" into "nextWednesday"
        // so the needle no longer matched the haystack — a test that failed
        // on correct code, which is as bad as one that passes on broken code.
        ck('  with the dates ALREADY converted, in the DATA',
           /"cutoff_when":"next Wednesday"/.test(dataJson)
           && /"cutoff_in":"in 7 days"/.test(dataJson),
           'calendar arithmetic is what models are worst at and she would never catch');
        ck('  and is told not to calculate one', /Never calculate a date/.test(seen));
        // The WHOLE rule, not a fragment of its justification. A mutation
        // replacing the instruction with "Be thorough." left the trailing
        // explanation behind and survived a looser match.
        ck('  nor to recite the table',
           /Do NOT list fields she did not ask about/.test(seen),
           'this is the complaint the whole file exists for');
        ck('  nor to invent anything', /Never\s*\n?\s*invent a number/.test(seen) || /never invent/i.test(seen));
        ck('  and to keep it to one sentence', /ONE SHORT SENTENCE/.test(seen));

        // ── THE OFFLINE NET ──────────────────────────────────────────────
        // An assistant that goes mute because a network call failed is worse
        // than one that answers six questions well.
        require.cache[gp].exports.callGeminiJSON = async () => { throw new Error('offline'); };
        const netted = await fu2.answer('when is the next cutoff', set, null, NOW);
        ck('with the model unreachable it still answers the common ones',
           /next Wednesday/.test(String(netted)), String(netted));
        const gone = await fu2.answer('which of these could still make it', set, null, NOW);
        ck('  and falls through honestly on the rest', gone === null,
           'inventing an answer offline is worse than handing it to the assistants');

        // And an empty model reply must not become an empty spoken answer.
        // Asked on a question the PATTERNS cover, so the two outcomes are
        // distinguishable: correct code falls through to the pattern and
        // answers; broken code returns the blank. My first version asked a
        // question nothing covered, where both paths end in null.
        require.cache[gp].exports.callGeminiJSON = async () => ({ answer: '   ' });
        const blank = await fu2.answer('when is the next cutoff', set, null, NOW);
        ck('  a blank model reply falls through rather than being spoken',
           /next Wednesday/.test(String(blank)),
           JSON.stringify(blank) + ' — an empty answer read aloud is silence with a pause in it');

        console.log(`\n  ${pass} passed, ${fail} failed`);
        if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
        process.exit(fail ? 1 : 0);
    })();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
