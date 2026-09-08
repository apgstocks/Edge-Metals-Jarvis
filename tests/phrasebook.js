// ── tests/phrasebook.js ───────────────────────────────────────────────────
// Apsara, 2026-09-07: "Why cant you simulate test cases like this when i ask
// you test"
//
// Because everything in tests/ is REGRESSION-shaped and she is right that
// this is the gap. Every assertion in this repo was written after SHE found
// the bug. The suite proves the things I already know about still work; it
// does not go looking. She said one ordinary sentence — "forward booking to
// trucker" — and three bugs fell out inside two minutes.
//
// This file goes looking. It takes the things she does every day and says
// each one the MANY WAYS a person says it, through the real endpoint, and
// flags any reply that is a symptom rather than an answer:
//
//   · her own category word quoted back as an unknown name
//     ("Trucker \"trucker\" not found", "No booking found for BOOKING")
//   · an internal identifier leaking (await_something, snake_case)
//   · a crash, a 500, an empty answer
//   · "I couldn't pin that down" for a sentence that is plainly an
//     instruction she gives every day
//
// IT IS NOT AN ASSERTION PER PHRASING. Fixing the exact words is how a
// phrasebook turns into the fixed intent list she has spent all day telling
// me not to build. What is asserted is that no phrasing produces a SYMPTOM.
// The particular reply can change freely.
//
// WHAT IT CANNOT DO, said plainly: the model is stubbed, so this measures the
// plumbing and the deterministic layers, not Gemini's judgement. A phrasing
// that only a real model would classify correctly will look "unhandled" here.
// That is why unhandled phrasings are REPORTED and only a curated few are
// FAILED — see MUST_WORK.

const path = require('path');
const { boot } = require('./helpers/e2e');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');
const A = (r) => (r && r.json && r.json.answer) || '';

// ── WHAT COUNTS AS A SYMPTOM ─────────────────────────────────────────────
// Each of these is a shape of reply that is wrong regardless of what she
// asked. They are the things she has actually reported today, generalised.
const SYMPTOMS = [
    { name: 'her category word quoted back as an unknown name',
      re: /(?:Trucker|Supplier|Contact) "(?:trucker|tracker|truckers|driver|supplier|booking|bookings)" not found/i },
    { name: 'a generic word treated as a booking number',
      re: /No booking found for (?:BOOKING|BOOKINGS|LOAD|THE BOOKING|TRUCKER)\b/i },
    { name: 'an internal identifier leaking',
      re: /\b(?:await|confirm|select|wizard)_[a-z_]+\b/ },
    { name: 'a raw error surfacing',
      re: /is not a function|undefined is not|Cannot read propert|ECONNREFUSED|\[object Object\]/i },
    { name: 'a stack frame or file path',
      re: /at [A-Za-z]+ \(|\/helpers\/|\/workflow\//i },
];

function symptomsIn(answer) {
    return SYMPTOMS.filter((s) => s.re.test(answer)).map((s) => s.name);
}

// ── THE PHRASEBOOK ───────────────────────────────────────────────────────
// Her daily jobs, each said several ways. Grouped by what she is trying to
// do, NOT by what the code calls it — the point is to cross the gap between
// how she talks and what the parser expects.
const BOOK = [
    { job: 'see what is booked from a port', setup: [], say: [
        'show me the bookings from houston',
        'what bookings are there from houston',
        'anything from houston',
        'what have we got going out of houston',
        'houston bookings please',
    ] },
    { job: 'ask about the one on screen', setup: ['show me the bookings from houston'], say: [
        'when is the erd of that booking',
        'and the vessel',
        'who is the carrier',
        'what about the cutoff',
        'and that one',
    ] },
    { job: 'forward a booking to a haulier', setup: ['show me the bookings from houston'], say: [
        'forward HOU111 to Sher Trucking',
        'forward booking to trucker',
        'forward the booking to tracker',
        'forward HOU111 to trucker',
        'send HOU111 to the driver',
        'forward that one to Sher Trucking',
        // The noun in front of the number — and the shape the reference
        // resolver itself produces. See section D.
        'forward booking HOU111 to Sher Trucking',
        'forward the booking HOU111 to Sher Trucking',
        'assign booking HOU111 to Eccomelt',
        'forward that to Sher Trucking',
        // SHE DOES NOT SAY "FORWARD". Apsara, 2026-09-08: "still it shows i
        // cannot share booking to tracker." I fixed the sentence shape
        // yesterday and tested it with the single verb that happened to be in
        // my head, so she had to report the same job failing twice.
        'share booking to tracker',
        'share the booking to trucker',
        'share HOU111 to Sher Trucking',
        'share booking with trucker',
        'send booking to trucker',
        'give booking to trucker',
        'pass HOU111 to Sher Trucking',
        'shoot HOU111 to Sher Trucking',
        'share the load to trucker',
    ] },
    { job: 'raise a proforma', setup: [], say: [
        'create a proforma for Daekwang, 21 MT of auto cast at 8450',
        'make a proforma for Daekwang',
        'raise a PI for Daekwang',
        'send a proforma for autocasting to Daekwang',
    ] },
    { job: 'take something back', setup: ['create a proforma for Daekwang, 21 MT of auto cast at 8450'], say: [
        'ignore that, i made a mistake',
        'never mind',
        'forget it',
        'lets start again',
        'no, not that one',
    ] },
    { job: 'send an email', setup: [], say: [
        'send a mail to jeyshree about the Houston cutoff',
        'email Yurim about the cutoff',
        'write to Yurim',
        'send a mail to the supplier',
    ] },
    { job: 'nonsense the recogniser produces', setup: [], say: [
        '...', 'uh', 'mm', 'okay so', 'the the the', '🚢',
    ] },
];

// ── THE FEW THAT MUST WORK, MODEL OR NO MODEL ────────────────────────────
// Everything else is reported. These are failed, because they are
// deterministic paths she uses constantly and a stub cannot excuse them.
const MUST_WORK = [
    ['forward booking to trucker', /which booking|no trucker registered|pick|which one/i],
    ['forward HOU111 to trucker', /no trucker registered|which|pick from the list|forwarded/i],
    ['forward the booking to tracker', /which booking|no trucker registered|pick|which one/i],
    ['show me the bookings from houston', /2 bookings/i],
    ['anything from houston', /2 bookings|booking/i],
    // Added after this file found them, 2026-09-08 — see section D.
    ['forward booking HOU111 to Sher Trucking', /forwarded/i],
    ['forward the booking HOU111 to Sher Trucking', /forwarded/i],
    ['assign booking HOU111 to Eccomelt', /assign|supplier/i],
    // Her verbs, 2026-09-08. Offline, because when the model is up it would
    // classify any of these and the net would never be exercised.
    ['share booking to tracker', /no trucker registered|which|pick/i],
    ['share the booking to trucker', /no trucker registered|which|pick/i],
    ['share HOU111 to Sher Trucking', /forwarded/i],
    ['share booking with trucker', /no trucker registered|which|pick/i],
    ['send booking to trucker', /no trucker registered|which|pick/i],
    ['give booking to trucker', /no trucker registered|which|pick/i],
    ['pass HOU111 to Sher Trucking', /forwarded/i],
    ['shoot HOU111 to Sher Trucking', /forwarded/i],
];

// ── AND WHAT THE SEND-ONWARD VERBS MUST NOT SWALLOW ──────────────────────
// "send" is the dangerous one: "send a mail to jeyshree" must never be read
// as forwarding a booking called "mail". The gate in brain.js is what keeps
// these apart, so both sides are asserted — a guard tested only in the
// direction it was written for is half a guard.
const MUST_NOT_FORWARD = [
    ['send a mail to jeyshree about the Houston cutoff', /jeyshree|jayashree|draft/i],
    ['send mail to jeyshree', /jeyshree|jayashree|draft/i],
    ['email Yurim about the cutoff', /yurim|draft/i],
];

(async () => {

console.log('\n─ the same job, said the many ways she says it ──────────────');

section('A — no phrasing produces a SYMPTOM');
{
    let checked = 0;
    const found = [];
    const unhandled = [];

    for (const group of BOOK) {
        for (const phrase of group.say) {
            const j = await boot({});
            for (const s of group.setup) await j.say(s);
            let r;
            try { r = await j.say(phrase); } catch (e) { r = { status: 0, json: null, raw: e.message }; }
            await j.stop();
            checked += 1;

            const answer = A(r);
            const bad = symptomsIn(answer);
            if (r.status !== 200) bad.push('HTTP ' + r.status);
            if (!answer.trim()) bad.push('an empty answer');
            if (bad.length) found.push({ job: group.job, phrase, answer, bad });
            // Reported, not failed: with the model stubbed, "I couldn't pin
            // that down" is often the stub's fault rather than the code's.
            else if (/couldn.t pin that down/i.test(answer)) unhandled.push({ job: group.job, phrase });
        }
    }

    ck(`${checked} phrasings produced no symptom`, found.length === 0,
       found.map((f) => `\n        "${f.phrase}" [${f.bad.join(', ')}]\n          -> ${f.answer.slice(0, 110)}`).join(''));

    if (unhandled.length) {
        console.log(`\n        ${unhandled.length} phrasing(s) unhandled with the model stubbed —`);
        console.log('        reported, not failed, because a stub is not the classifier:');
        unhandled.forEach((u) => console.log(`          · [${u.job}] "${u.phrase}"`));
    }
}

section('B — and the ones that must work without a model at all');
{
    for (const [phrase, want] of MUST_WORK) {
        const j = await boot({ gemini: 'down' });
        await j.say('show me the bookings from houston');
        const r = await j.say(phrase);
        await j.stop();
        ck(`offline: "${phrase}"`, want.test(A(r)), A(r).slice(0, 130));
    }
}

section('B2 — and what those verbs must NOT swallow');
{
    for (const [phrase, want] of MUST_NOT_FORWARD) {
        const j = await boot({});
        const r = await j.say(phrase);
        await j.stop();
        const a = A(r);
        ck(`"${phrase}" is still an email`,
           want.test(a) && !/No booking found|forwarded/i.test(a), a.slice(0, 120));
    }
}

section('C — the three she found by talking, pinned');
{
    // Kept as their own section because these are the exact sentences, and a
    // report from her deserves an assertion that names her.
    const j = await boot({});
    await j.say('show me the bookings from houston');
    await j.say('when is the erd of that booking');

    const fwd = await j.say('forward booking to trucker');
    ck('"forward booking to trucker" does not report BOOKING as unknown',
       !/No booking found for BOOKING/i.test(A(fwd)), A(fwd));
    ck('  and does not report "trucker" as an unknown haulier',
       !/Trucker "trucker" not found/i.test(A(fwd)), A(fwd));
    ck('  it uses the booking she was just discussing',
       !/which booking/i.test(A(fwd)), A(fwd) + ' — HOU111 was in focus');

    const misheard = await j.say('forward HOU111 to tracker');
    ck('"tracker" is understood as the category, not a company',
       !/Trucker "tracker" not found/i.test(A(misheard)), A(misheard));

    await j.stop();
}

section('C2 — an order is never answered out of the table');
{
    // Apsara, 2026-09-08: "when i ask it to forward the booking, instead of
    // getting into forwarding process, it just shows cut off for the booking
    // is in 7 days."
    //
    // fu.answer() was consulted BEFORE anyone checked whether she had given an
    // order. Asked to answer "forward the booking" from a table of bookings, a
    // model reads out a field — the most helpful thing available to it. It was
    // asked the wrong question.
    const j = await boot({});
    await j.say('show me the bookings from houston');
    await j.say('when is the cutoff');

    const r = await j.say('forward the booking');
    ck('"forward the booking" starts forwarding, it does not read the cutoff',
       /trucker|forward|which/i.test(A(r)) && !/cuts? off|cutoff is/i.test(A(r)), A(r));

    const done = await j.say('forward that booking to Sher Trucking');
    ck('  and a named trucker forwards it', /forwarded/i.test(A(done)), A(done));

    // THE OTHER HALF. A guard that swallows real questions is not a fix.
    const q = await j.say('and the vessel');
    ck('  while a real question is still answered from the rows',
       /MSC ANNA/.test(A(q)), A(q));
    await j.stop();

    // MOVED BELOW j.stop() ON PURPOSE. helpers/voiceMemory.js is module
    // state, shared by every boot in this process, so two sessions open at
    // once step on each other's referents — the second boot's list became
    // the first boot's, and "and the vessel" answered from the wrong rows.
    // Caught by the mutation harness's baseline check, which refuses to
    // measure anything against a red suite; without it I would have recorded
    // a mutation as killed by a test that was broken.
    // ── AND AGAINST A MODEL THAT ANSWERS ANYTHING ───────────────────────
    // The default stub declines when it has no matching field, so it cannot
    // reproduce what she saw — the mutation of this fix survived the whole
    // suite until the harness learned to behave like a real model, which
    // answers with the most useful field it can find rather than refusing.
    {
        const eager = await boot({ followUpEager: true });
        await eager.say('show me the bookings from houston');
        const e = await eager.say('forward the booking');
        ck('  even a model that would answer anything is not asked',
           !/cuts? off/i.test(A(e)), A(e));
        // The same stub must still answer a real question, or this proves
        // only that the eager mode is broken.
        const eq = await eager.say('when is the cutoff');
        ck('    while it still answers a genuine question',
           /cuts? off/i.test(A(eq)), A(eq));
        await eager.stop();
    }
}

section('C3 — a blocker is not an answer');
{
    // Apsara, 2026-09-08: "when i ask it to foraward,it just says no supplier
    // assigned. when i ask it to asssign the supplier, it just treating that
    // as a new request not a follow up"
    //
    // Three faults in one sentence, and one of them was mine twice over: the
    // category-word guard went into forwardBooking yesterday and not into
    // assignSupplier beside it, so the identical failure was waiting under a
    // different verb.
    const j = await boot({});
    await j.say('show me the bookings from oakland');

    const blocked = await j.say('forward it');
    ck('a missing supplier is reported WITH the way past it',
       /which one|add one from the dashboard/i.test(A(blocked)), A(blocked));
    ck('  and it no longer just tells her to go and do it herself',
       !/Assign a supplier first\.$/.test(A(blocked).trim()), A(blocked));

    // Her answer to Jarvis's question must reach the question. "Oakland
    // Metals" contains a port word, so the booking-query path claimed it and
    // redrew the list while the pending sat there unanswered.
    const picked = await j.say('Oakland Metals');
    ck('  her answer reaches the question that asked it',
       /assigned to Oakland Metals/i.test(A(picked)), A(picked));
    ck('  and the forward she originally asked for carries on by itself',
       /trucker/i.test(A(picked)), A(picked) + ' — she should not have to say "forward" twice');
    await j.stop();

    // ── AND IT ONLY CARRIES ON IF THE ASSIGN ACTUALLY LANDED ────────────
    // Resuming a step whose prerequisite did not complete is how two
    // half-finished actions end up arguing. Staged rather than talked into
    // existence: a select_supplier pending carrying then_forward, on a
    // booking whose container ALREADY has a supplier. assignSupplier answers
    // "nothing to assign", and the forward must not run on top of that.
    //
    // Written after the mutation harness reported this guard as unkillable
    // through conversation alone — every natural route to it either resolved
    // the pending or refused before reaching assignSupplier.
    {
        const k = await boot({});
        const fsx = require('fs');
        const px = require('path');
        const brainFile = px.join(k.dir, 'brain.json');
        const chat = '918056944193@c.us';
        const store = JSON.parse(fsx.readFileSync(brainFile, 'utf8'));
        store.pending_actions = store.pending_actions || {};
        store.pending_actions[chat] = {
            // container_seq NULL, so assignSupplier auto-picks the next
            // container WITHOUT a supplier — and HOU111 has none left, which
            // is the "nothing to assign" outcome this needs. With an explicit
            // seq it happily overwrites the supplier already there and
            // succeeds, which staged the wrong scenario entirely.
            type: 'select_supplier', bkg_no: 'HOU111', container_seq: null,
            // created_at, not `at` — loadBrain() expires anything whose
            // created_at is missing, treating it as epoch 0. My first version
            // wrote `at` and the pending vanished before the request reached
            // it, which looked exactly like the guard failing.
            options: ['Eccomelt'], then_forward: true,
            created_at: new Date().toISOString(),
        };
        fsx.writeFileSync(brainFile, JSON.stringify(store, null, 2));

        const r = await k.say('Eccomelt');
        ck('  a failed assign does not trigger the forward underneath it',
           /already have suppliers|nothing to assign/i.test(A(r))
           && !/forwarded|no trucker registered/i.test(A(r)), A(r));
        await k.stop();
    }
}

section('C5 — it asks "want me to forward it?", so "yes" must mean something');
{
    // Apsara, 2026-09-08: "it asks me do you want me to forward it. when i say
    // Yes, it just shows that earliest cut off is and does nothing."
    //
    // The offer is MY sentence — she asked for that shape on 2026-09-06 and I
    // wrote the words and never wired the answer. Jarvis spent two days asking
    // a question with nowhere to put the reply, so "yes" fell through to the
    // follow-up answerer, which looked for a field called "yes".
    //
    // An assistant that asks a question it cannot receive an answer to is
    // worse than one that never asks: it invites her to speak, then discards
    // what she says.
    {
        const j = await boot({});
        const opened = await j.say('show me the bookings from oakland');
        ck('the summary does offer', /want me to forward/i.test(A(opened)), A(opened));
        const yes = await j.say('yes');
        ck('  and "yes" starts the forward instead of re-reading the cutoff',
           /supplier|trucker|which one|forwarded/i.test(A(yes))
           && !/earliest cutoff|cuts? off/i.test(A(yes)), A(yes));
        await j.stop();
    }

    // AND AGAINST A MODEL THAT WOULD ANSWER "yes" WITH A FIELD. This is
    // literally what she saw — "it just shows that earliest cut off is" —
    // and the polite default stub cannot produce it, so the mutation of the
    // guard survived until the eager stub was used here.
    {
        const j = await boot({ followUpEager: true });
        await j.say('show me the bookings from oakland');
        const yes = await j.say('yes');
        ck('  a model that would answer "yes" from the table is not asked',
           !/cuts? off/i.test(A(yes)), A(yes));
        await j.stop();
    }

    // WITH SEVERAL ON SCREEN, "yes" says she wants a forward — not WHICH.
    // Picking for her is the guess this whole area exists to avoid, and there
    // is a real truck at the end of it.
    {
        const j = await boot({});
        await j.say('show me the bookings from houston');
        const yes = await j.say('yes');
        ck('  with two on screen it asks which, rather than choosing',
           /which one/i.test(A(yes)) && /HOU111/.test(A(yes)) && /HOU222/.test(A(yes)), A(yes));
        // And the answer to THAT question must land too — the same bug one
        // question deeper is exactly how this kind of thing survives a fix.
        const one = await j.say('1');
        ck('    and "1" then picks the first one',
           /trucker|supplier|forwarded/i.test(A(one)) && !/which one/i.test(A(one)), A(one));
        await j.stop();
    }

    // "No" must be heard as well, or the offer is a trap rather than a choice.
    {
        const j = await boot({});
        await j.say('show me the bookings from oakland');
        const no = await j.say('no');
        ck('  and "no" is taken as an answer, not as a retraction',
           /leaving it|right/i.test(A(no)) && !/dropped|took back/i.test(A(no)), A(no));
        await j.stop();
    }

    // AND AN OFFER SHE IGNORES LAPSES. An offer that outlives its turn is a
    // trap: a "yes" to something else later would send a real message.
    {
        const j = await boot({});
        await j.say('show me the bookings from oakland');
        await j.say('when is the erd');
        const late = await j.say('yes');
        ck('  an offer she talked past does not fire later',
           !/supplier|trucker|forwarded/i.test(A(late)), A(late));
        await j.stop();
    }
}

section('C4 — "assign the supplier" is about the booking in focus');
{
    const j = await boot({});
    await j.say('show me the bookings from oakland');
    const r = await j.say('assign the supplier');
    ck('"assign the supplier" does not report SUPPLIER as an unknown booking',
       !/No booking found for SUPPLIER/i.test(A(r)), A(r));
    ck('  it uses the booking on screen and offers the list',
       /which one|add one from the dashboard/i.test(A(r)), A(r));
    await j.stop();
}

section('D — and the two this file found on its first run');
{
    // Neither of these came from a bug report. Both came from saying an
    // ordinary thing a slightly different way, which is the entire argument
    // for this file existing.

    // D1. The noun in front of the number. "forward booking HOU111 to X" did
    // not match the policy pattern — it read "booking" as the identifier and
    // then wanted "to" where the number stood.
    {
        const j = await boot({ gemini: 'down' });
        await j.say('show me the bookings from houston');
        const r = await j.say('forward booking HOU111 to Sher Trucking');
        ck('a noun before the number does not break the forward pattern',
           /forwarded/i.test(A(r)), A(r));
        await j.stop();
    }

    // D2. The resolver rewriting a sentence its own parser cannot read. This
    // is the one that mattered: the expansion produced "booking HOU111 HOU111"
    // and it was JARVIS, not her, that wrote the sentence.
    {
        const vm = require(path.join('..', 'helpers', 'voiceMemory.js'));
        vm.setReferents({ kind: 'bookings', title: 'HOUSTON', rows: [
            { n: 1, booking_number: 'HOU111' }, { n: 2, booking_number: 'HOU222' },
        ] });
        vm.setCenter({ booking_number: 'HOU111' });

        const already = vm.resolve('forward the booking HOU111 to Sher Trucking');
        ck('a sentence that already names the booking is left alone',
           already.text === 'forward the booking HOU111 to Sher Trucking' && !already.resolved,
           already.text);
        ck('  no identifier is duplicated into it',
           !/HOU111\s+HOU111/i.test(already.text), already.text);

        // The guard must not silence the resolver generally — a real pronoun
        // with no number in the sentence still has to resolve, or the fix for
        // D2 would have quietly undone the whole centering feature.
        const pronoun = vm.resolve('forward that to Sher Trucking');
        ck('  a real pronoun still resolves', /HOU111/.test(pronoun.text), pronoun.text);

        // And a token that merely LOOKS like a booking number must not count
        // as naming one. A container number is the case that matters — she
        // says them constantly, and "TCLU1234567" has exactly the shape a
        // lazy booking-number pattern would claim. If a lookalike could
        // silence the resolver, "that booking" would stop resolving in every
        // sentence that happens to mention a container.
        const lookalike = vm.resolve('forward that booking, container TCLU1234567, to Sher Trucking');
        ck('  a container number does not silence it', /HOU111/.test(lookalike.text), lookalike.text);
        const sizeToken = vm.resolve('forward that booking, the 40HC one, to Sher Trucking');
        ck('  nor does a container size', /HOU111/.test(sizeToken.text), sizeToken.text);
    }

    // D2b. THE CONTRACT OF genericTerm ITSELF.
    // Through the endpoint these assertions are hollow: brain.js runs
    // fuzzyCorrectKeywords first, "trucker" is already a command keyword, and
    // "tracker" is one edit away — so the mis-hearing is repaired before this
    // helper is ever consulted. Two mutations of genericTerm.js survived the
    // whole e2e suite for exactly that reason.
    //
    // But that correction only happens on the POLICY route. When the AI
    // classifies the sentence, trucker_name comes off the raw text with no
    // correction at all, and then this helper IS the only thing standing
    // between her and 'Trucker "tracker" not found'. So the contract is
    // asserted directly, where it is load-bearing.
    {
        const gt = require(path.join('..', 'helpers', 'genericTerm.js'));
        ck('the mis-heard spelling is recognised without the keyword corrector',
           gt.isGeneric('tracker', 'trucker') === true);
        // WHAT IT DOES NOT CATCH, stated rather than wished for.
        // I first wrote this line as `isGeneric('truker')  === true` and it
        // failed: phonetic() folds "ck" to a single distinct symbol, so
        // "trucker" keys as trKr and "truker" as trkr. That is deliberate in
        // nameSuggest — it is matching PEOPLE, where ck and k really are
        // different names — and changing the shared function to please this
        // one caller would reach into email-contact matching for no good
        // reason. So the limit is asserted, not papered over.
        ck('  a dropped "c" is out of reach of the phonetic key, and that is known',
           gt.isGeneric('truker', 'trucker') === false);
        ck('  a real company name is not swallowed', gt.isGeneric('Sher Trucking', 'trucker') === false);
        ck('  nor is a carrier — MSC and Maersk are carriers, not hauliers',
           gt.isGeneric('carrier', 'trucker') === false);
        // "LD" keys to exactly the same skeleton as "load" — the vowel strip
        // leaves nothing to tell them apart. Without the length guard a
        // two-letter token would be read as the word "load" and her booking
        // reference would evaporate. Picked deliberately: my first attempt
        // used "trk", which the guard does not even need since it keys to
        // trk and the category is trKr, so it proved nothing.
        ck('  a two-letter fragment cannot collide into a category',
           gt.isGeneric('ld', 'booking') === false);
        ck('  even though its skeleton is identical to a real one',
           require(path.join('..', 'helpers', 'nameSuggest.js')).phonetic('ld')
           === require(path.join('..', 'helpers', 'nameSuggest.js')).phonetic('load'));
        ck('  the kinds do not leak into each other',
           gt.isGeneric('booking', 'trucker') === false && gt.isGeneric('trucker', 'booking') === false);
        ck('  an empty name is the caller\'s own path, not this one',
           gt.isGeneric('', 'trucker') === false && gt.isGeneric(null, 'trucker') === false);
    }

    // D3. The harness itself was lying. `gemini: 'down'` used to THROW;
    // helpers/gemini.js never throws. Pinned so it cannot drift back.
    {
        // BEHAVIOURAL, not a source grep. My first version tested the source
        // for the old `throw` and the mutation harness walked straight past
        // it — the mutation reintroduced a throw with different surrounding
        // text, and the pattern did not match. Same mistake I have made
        // before: a test that reads the code instead of running it only ever
        // catches the exact edit I imagined.
        const gem = require(path.join('..', 'helpers', 'gemini.js'));
        const { installGemini } = require(path.join(__dirname, 'helpers', 'e2e.js'));

        // Install the offline stub over the real module and CALL it. If it
        // throws, the harness is modelling a failure the real client cannot
        // produce, and every offline test in this repo is measuring fiction.
        installGemini('down', [], {});
        let threw = null, got = 'not called';
        try { got = await gem.callGeminiJSON('anything'); }
        catch (e) { threw = e.message; }
        ck('the offline stub returns rather than throwing', threw === null,
           'it threw: ' + threw);
        ck('  and what it returns is null, like the real one', got === null,
           JSON.stringify(got));
        ck('  with the failure kind recorded for the caller to explain itself',
           gem.lastGeminiFailure() === 'unreachable', String(gem.lastGeminiFailure()));
    }
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('\n  HARNESS FAILED:', e && e.stack); process.exit(1); });
