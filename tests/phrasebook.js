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
// NOTE on the shapes below, after the fixture gained a Houston trucker on
// 2026-09-09: several of these used to read `no trucker registered`, which was
// never the point — it was the fixture running out of road. What is being
// asserted is that the sentence REACHES the trucker step, whether that step
// then offers a list, forwards, or reports that there is nobody at that port.
// An assertion that encodes the absence of test data breaks the day the data
// gets better, which is the wrong way round.
const MUST_WORK = [
    ['forward booking to trucker', /which trucker|which booking|no trucker registered|pick|which one/i],
    ['forward HOU111 to trucker', /no trucker registered|which|pick from the list|forwarded/i],
    ['forward the booking to tracker', /which trucker|which booking|no trucker registered|pick|which one/i],
    ['show me the bookings from houston', /2 bookings/i],
    ['anything from houston', /2 bookings|booking/i],
    // Added after this file found them, 2026-09-08 — see section D.
    ['forward booking HOU111 to Sher Trucking', /forwarded/i],
    ['forward the booking HOU111 to Sher Trucking', /forwarded/i],
    ['assign booking HOU111 to Eccomelt', /assign|supplier/i],
    // Her verbs, 2026-09-08. Offline, because when the model is up it would
    // classify any of these and the net would never be exercised.
    ['share booking to tracker', /which trucker|no trucker registered|which|pick/i],
    ['share the booking to trucker', /which trucker|no trucker registered|which|pick/i],
    ['share HOU111 to Sher Trucking', /forwarded/i],
    ['share booking with trucker', /which trucker|no trucker registered|which|pick/i],
    ['send booking to trucker', /which trucker|no trucker registered|which|pick/i],
    ['give booking to trucker', /which trucker|no trucker registered|which|pick/i],
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
        await eager.stop();
    }

    // The same stub must still answer a real question, or the assertion above
    // proves only that the eager mode is broken.
    //
    // A FRESH SESSION, and the reason is worth writing down. "forward the
    // booking" now reaches the trucker list and leaves a select_trucker
    // pending open, so asking a question in that same breath gets read as an
    // answer to it and comes back "I couldn't pin that down". That is the
    // pending-swallows-a-question family Apsara has already reported twice
    // (the await_fact_batch screenshot, and the name-confirm one). It is not
    // what this assertion is about, so it is not tested here — but it is real,
    // it is reachable from the flow above, and it is written down rather than
    // worked around silently.
    {
        const eager = await boot({ followUpEager: true });
        await eager.say('show me the bookings from houston');
        const eq = await eager.say('when is the cutoff');
        ck('    while it still answers a genuine question',
           /cuts? off/i.test(A(eq)), A(eq));
        await eager.stop();
    }
}

section('C2b — the whole forward, spoken, all the way to a sent message');
{
    // Apsara, 2026-09-09: "now coming back to voice, how does forward works
    // now?" — and demonstrating it is what found this gap.
    //
    // Every voice test until now stopped one gate short. The fixture had no
    // trucker at HOUSTON, so "forward booking to trucker" always ended at "No
    // trucker registered at HOUSTON" and the SELECTION path — Jarvis listing
    // the truckers, her picking one, a message actually going out — had never
    // been walked by voice at all. A fixture that stops before the end is how
    // a flow gets called tested without ever having worked.
    const j = await boot({});
    await j.say('show me the bookings from houston');

    const asked = await j.say('forward booking to trucker');
    ck('saying the category gets the list of truckers at that port',
       /which trucker/i.test(A(asked)) && /Bayou Haulage/.test(A(asked)), A(asked));
    ck('  for the booking she was already discussing, not a fresh one',
       /HOU111/.test(A(asked)), A(asked));

    const done = await j.say('1');
    ck('  and picking a number forwards it', /forwarded to Bayou Haulage/i.test(A(done)), A(done));

    // THE ASSERTION THAT MATTERS. "Forwarded" is a claim about the outside
    // world. The worst bug found this week was notifyContactRespectingChannel
    // returning ok:true with nothing sent — a booking marked forwarded and a
    // driver who never heard. So the test is not that Jarvis SAID it.
    const sent = (j.sent || []).map((m) => String(m.text || m.body || ''));
    ck('  and a real message went out, not just a sentence on screen',
       sent.some((t) => /HOU111/.test(t)), JSON.stringify(sent).slice(0, 160));
}

section('C2c — naming a booking by where it loads');
{
    // Apsara, 2026-09-09: "if i say foward the houston booking...it should
    // forward that booking to trucker na?"
    //
    // Yes. It is a referring expression — naming the booking by where it loads
    // instead of by its number, which is how anybody talks about a booking
    // whose paperwork is not in front of them. Every variant answered "I
    // couldn't pin that down", including with the Houston list already on
    // screen.
    //
    // THE DIVISION THAT KEEPS IT SAFE: the sentence supplies the PLACE, the
    // store supplies the BOOKING. One at that port is an answer; several is a
    // question. There is a truck at the end of this, so picking would be a
    // guess wearing a resolution's clothes.

    // ONE booking at that port — resolved, no question asked.
    {
        const j = await boot({});
        const r = await j.say('forward the oakland booking');
        // Checks it did not ask which BOOKING. It may well go on to ask which
        // SUPPLIER — OAK333 has none — and my first version of this assertion
        // failed on that, because "which one?" appears in both questions.
        // An assertion that cannot tell two questions apart is not testing
        // the thing it names.
        ck('one booking at that port is simply the one she means',
           /OAK333/.test(A(r)) && !/bookings at .* which one/is.test(A(r)), A(r));
        await j.stop();
    }

    // SEVERAL — asked, not guessed, and her answer lands.
    {
        const j = await boot({});
        const asked = await j.say('forward the houston booking');
        ck('two at that port is a question, not a guess',
           /which one/i.test(A(asked)) && /HOU111/.test(A(asked)) && /HOU222/.test(A(asked)), A(asked));
        const picked = await j.say('1');
        ck('  and a number picks from that list', /HOU111/.test(A(picked)), A(picked));
        const done = await j.say('1');
        ck('  and it forwards for real', /forwarded to Bayou Haulage/i.test(A(done)), A(done));
        ck('    with a message actually sent',
           (j.sent || []).some((m) => /HOU111/.test(String(m.text || m.body || ''))));
        await j.stop();
    }

    // She may just say the booking number instead of a position.
    {
        const j = await boot({});
        await j.say('forward the houston booking');
        const r = await j.say('HOU222');
        ck('  or she says the booking number and that works too',
           /HOU222/.test(A(r)) && /which trucker/i.test(A(r)), A(r));
        await j.stop();
    }

    // THE HALF OF HER SENTENCE SHE ALREADY SAID.
    // "forward the houston booking to Bayou Haulage" names the trucker.
    // Asking which BOOKING must not cost her that — the same fault as the
    // blocked forward on 2026-09-08, where picking a supplier lost the
    // forward. An interruption is not permission to forget the request.
    {
        const j = await boot({});
        await j.say('forward the houston booking to Bayou Haulage');
        const done = await j.say('1');
        ck('  a trucker she already named survives the "which booking?" question',
           /forwarded to Bayou Haulage/i.test(A(done)) && !/which trucker/i.test(A(done)), A(done));
        await j.stop();
    }

    // AND THE SAME SHAPE UNDER "ASSIGN" — fixing the fault, not the report.
    {
        const j = await boot({});
        const r = await j.say('assign the oakland booking');
        ck('  "assign the oakland booking" resolves the same way',
           /OAK333/.test(A(r)) && /which one/i.test(A(r)), A(r));
        await j.stop();
    }

    // A REAL BOOKING NUMBER ALWAYS WINS over any place reading.
    {
        const j = await boot({});
        const r = await j.say('forward HOU111 to Bayou Haulage');
        ck('  and naming the booking outright still goes straight through',
           /forwarded to Bayou Haulage/i.test(A(r)), A(r));
        await j.stop();
    }
}

section('C2d — nothing available, so ask a forwarder');
{
    // Apsara, 2026-09-09: "when i ask show me available bookings from houston
    // and all are assigned,it should say no bookings available.and then ask
    // whether it can email [freightforwarder] for that booking? when say user
    // say zimex,it should email. on my confirmation,it should send" — plus
    // "before sending mail,show me a draft".
    //
    // The offer routes into helpers/bookingRequest.js, which has done this
    // since 2026-09-06: it asks the one question that changes (how many
    // containers), drafts in her own writing style, shows the draft, and sends
    // only on "yes". Nothing here re-implements any of that.
    const fsx = require('fs');
    const px = require('path');
    const j = await boot({});
    // Every Houston booking assigned, so "available" is genuinely empty.
    fsx.writeFileSync(px.join(j.dir, 'workflow.json'),
        JSON.stringify({ HOU111: { supplier: 'Eccomelt' }, HOU222: { supplier: 'Eccomelt' } }, null, 2));

    const empty = await j.say('show me available bookings from houston');
    ck('an empty "available" search says so plainly',
       /no bookings available/i.test(A(empty)), A(empty));
    ck('  and offers to ask a forwarder',
       /forwarder/i.test(A(empty)), A(empty));

    const named = await j.say('zimex');
    ck('  naming one starts the booking request, not a new search',
       /how many containers/i.test(A(named)), A(named));
    ck('    addressed to zimex, not to a name that ran into the next word',
       /for zimex\b/i.test(A(named)),
       '"to zimex asking for space" made the recipient "zimex asking", with an address invented to match');

    // ── THEN THE CUT OFF, AND NOTHING ELSE ───────────────────────────────
    // Apsara, 2026-09-09: "I want jarvis to communicate in similar terms like
    // need bookings from Houston to Busan 1x40HC with cut off as [date].
    // [Optional:ERD]" — she STATES the cutoff when she asks for space. Asked
    // how the missing pieces should be gathered she said "Both 1 and 3": one
    // question at a time for what is missing, everything else in the draft.
    //
    // So exactly two questions, in this order, and no third one. A test that
    // only checked the cutoff was asked would pass just as happily on a form
    // read aloud, which is the thing she has rejected twice in writing.
    const cut = await j.say('2');
    ck('  then it asks the cut off — the other thing that changes every time',
       /cut ?off/i.test(A(cut)), A(cut));
    ck('    and still nothing has been sent',
       (j.mails || []).length === 0, 'a question is not a send');

    const draft = await j.say('the 20th');
    // ── WHAT WAS INFERRED IS SAID ────────────────────────────────────────
    // Her instruction was "Both 1 and 3.." — ask for what is missing AND put
    // it in the draft for her to correct. The second half only works if she
    // can SEE which fields were filled in for her. A discharge port that
    // appears silently is a discharge port nobody thinks to check.
    //
    // WRITTEN AFTER A MUTATION SURVIVED: deleting the whole announcement left
    // every other assertion green. The point of the inference is that it is
    // audible, and nothing was testing the audible part.
    ck('  it says which fields it filled in for her',
       /busan/i.test(A(draft)) && /(your last|usual|that'?s what)/i.test(A(draft)),
       A(draft).slice(0, 400));
    ck('    and invites the correction',
       /say so|if it'?s different|different this time/i.test(A(draft)),
       'a guess she is not invited to challenge is a guess she will not challenge');
    ck('  and that is the LAST question — no port, no commodity, no ready date',
       !/\?/.test(A(draft).split('Send this')[0].replace(/\(yes\/no\)/i, '')) || /draft email/i.test(A(draft)),
       'a form read aloud is what she rejected: "I want how a human asissyant will handle it"');
    ck('  the draft is SHOWN before anything is sent',
       /draft email to zimex/i.test(A(draft)) && /subject:/i.test(A(draft)), A(draft));
    ck('    and it asks before sending', /yes\/no|send this/i.test(A(draft)), A(draft));
    ck('    and NOTHING has been sent yet',
       (j.mails || []).length === 0,
       'a draft that has already gone is not a draft');

    const sent = await j.say('yes');
    ck('  and only then does it send', /sent to zimex/i.test(A(sent)), A(sent));
    ck('    to the address it showed her',
       (j.mails || []).length === 1 && /zimex/.test(String((j.mails || [])[0].to || '')),
       JSON.stringify(j.mails));

    // ── THE SENTENCE THAT ACTUALLY LEAVES THE BUILDING ───────────────────
    // The whole point of the change. Checked on the mail that was SENT, not
    // on the brief handed to the drafter — a prompt saying "must contain this
    // line" proves nothing about whether the line survived the model.
    //
    // POL from the offer she accepted, POD and box size off her own bookings,
    // count and cutoff from the two questions. Every one of them is a
    // commitment to a carrier, so every one of them is asserted.
    const body = String((j.mails || [])[0]?.body || '');
    ck('  and the mail says it the way she says it',
       /need bookings/i.test(body), body.slice(0, 300));
    ck('    naming the load port she was asking about',
       /houston/i.test(body), body.slice(0, 300));
    ck('    the discharge port her own bookings all use',
       /busan/i.test(body),
       'inferred rather than asked — usualRoute reads it off bookings.json, and it is stated so she can correct it');
    ck('    the count and box size as one figure',
       /2\s*x\s*40HC/i.test(body), body.slice(0, 300));
    ck('    and the cut off she gave, unambiguously',
       /cut ?off/i.test(body) && /20 Sep 2026/.test(body),
       '"09/20/2026" reads as 9 December to half the world, and a cutoff a month out misses a vessel');
    await j.stop();
}

section('C2d2 — both answers in one breath, and one question fewer');
{
    // "two 40s, cut off the 20th" is ONE answer, not two. A flow that asked
    // for the cutoff anyway would be the assistant not listening — the exact
    // complaint behind the count question in the first place.
    const fsx = require('fs');
    const px = require('path');
    const j = await boot({});
    fsx.writeFileSync(px.join(j.dir, 'workflow.json'),
        JSON.stringify({ HOU111: { supplier: 'Eccomelt' }, HOU222: { supplier: 'Eccomelt' } }, null, 2));

    await j.say('show me available bookings from houston');
    await j.say('zimex');
    const draft = await j.say('2 x 40HC, cut off the 20th');
    ck('answering both at once skips the second question',
       /draft email to zimex/i.test(A(draft)) && !/what cut ?off/i.test(A(draft)), A(draft));
    ck('  and the cutoff she volunteered is the one that goes',
       /20 Sep 2026/.test(String((j.mails || [])[0]?.body || A(draft))), A(draft).slice(0, 400));
    await j.stop();
}

section('C2d4 — correcting the draft, instead of binning it');
{
    // The other half of "Both 1 and 3..". Everything inferred goes into the
    // draft, and the draft has to be CORRECTABLE — otherwise her only move
    // against a wrong discharge port is "no", which throws away the mail and
    // the two answers she just gave with it.
    const fsx = require('fs');
    const px = require('path');
    const j = await boot({});
    fsx.writeFileSync(px.join(j.dir, 'workflow.json'),
        JSON.stringify({ HOU111: { supplier: 'Eccomelt' }, HOU222: { supplier: 'Eccomelt' } }, null, 2));

    await j.say('show me available bookings from houston');
    await j.say('zimex');
    await j.say('2');
    const first = await j.say('the 20th');
    ck('the first draft carries the inferred port', /busan/i.test(A(first)), A(first).slice(0, 300));

    const fixed = await j.say('no, Qingdao not Busan');
    ck('  a correction re-drafts instead of cancelling',
       /draft email to zimex/i.test(A(fixed)), A(fixed).slice(0, 400));
    ck('    saying what it changed, so a mis-read is audible',
       /Right — to QINGDAO\. Redrafting\./.test(A(fixed)), A(fixed).slice(0, 200));
    ck('      and reading like a sentence',
       !/\bto to\b/i.test(A(fixed)),
       'describeCorrection supplies the preposition; a lead-in that adds another says "changing it to to QINGDAO"');
    ck('    the corrected port is in the mail',
       /qingdao/i.test(A(fixed)) && !/to BUSAN/i.test(A(fixed)), A(fixed).slice(0, 400));
    ck('    the answers she already gave survive it',
       /2\s*x\s*40HC/i.test(A(fixed)) && /20 Sep 2026/.test(A(fixed)),
       'a correction that re-asks how many is the assistant not listening');
    ck('    and still nothing has been sent',
       (j.mails || []).length === 0, 'a re-draft is still a draft');

    const sent = await j.say('yes');
    ck('  and yes sends the CORRECTED one',
       /qingdao/i.test(String((j.mails || [])[0]?.body || '')), JSON.stringify(j.mails));
    await j.stop();

    // ── AND WHAT MUST NOT BE READ AS A CORRECTION ────────────────────────
    // "send it to Zimex" parses as a discharge port every bit as well as
    // "to Qingdao" does. helpers/draftIntent.js records that exact shape
    // putting the wrong company on a financial document. Here it is her YES.
    const j2 = await boot({});
    fsx.writeFileSync(px.join(j2.dir, 'workflow.json'),
        JSON.stringify({ HOU111: { supplier: 'Eccomelt' }, HOU222: { supplier: 'Eccomelt' } }, null, 2));
    await j2.say('show me available bookings from houston');
    await j2.say('zimex');
    await j2.say('2');
    await j2.say('the 20th');
    const notACorrection = await j2.say('send it to Zimex');
    // ASSERTED ON THE ABSENCE OF THE CORRECTION, not on the absence of the
    // word "zimex". My first version was `!/to ZIMEX/i` and it failed against
    // correct code: the "(Still waiting: send this email to zimex ...)"
    // reminder tail is part of the answer, so the pattern matched Jarvis's own
    // output. Fourth time this session a check has read my own text back —
    // the fix each time is to assert the thing that would actually be wrong.
    ck('"send it to Zimex" is not read as a discharge port',
       !/changing it to/i.test(A(notACorrection))
       && !/to QINGDAO|to ZIMEX 2x|Need bookings from HOUSTON to ZIMEX/i.test(A(notACorrection)),
       A(notACorrection).slice(0, 300));
    ck('  and the draft it already showed her is untouched',
       /Need bookings from HOUSTON to BUSAN 2x40HC/.test(A(notACorrection)),
       'a sentence that is not a correction must leave the request exactly as it was');
    // KNOWN GAP, stated rather than hidden. helpers/draftIntent.js's own rules
    // say "send it to Daekwang" during a confirm is her YES, not a change —
    // but that judgement lives in the proforma flow, and an email confirm
    // still drops this to "I couldn't pin that down". Nothing is lost (the
    // pending survives, as the reminder tail below proves, so "yes" still
    // works) and fixing it touches every email path in the app, so it is
    // carried as its own piece of work rather than bolted on here.
    ck('  and the pending survives, so nothing she said is lost',
       /Still waiting/i.test(A(notACorrection)),
       'the email must still be there to say yes to');
    await j2.stop();
}

section('C2d3 — "not sure" is an answer, not a dead end');
{
    // She will not always know. Re-asking for ever is worse than sending
    // without one, and the draft is on screen for her to type it into.
    const fsx = require('fs');
    const px = require('path');
    const j = await boot({});
    fsx.writeFileSync(px.join(j.dir, 'workflow.json'),
        JSON.stringify({ HOU111: { supplier: 'Eccomelt' }, HOU222: { supplier: 'Eccomelt' } }, null, 2));

    await j.say('show me available bookings from houston');
    await j.say('zimex');
    await j.say('2');
    const draft = await j.say('not sure');
    ck('"not sure" still produces a sendable request',
       /draft email to zimex/i.test(A(draft)), A(draft));
    ck('  it just goes without a cut off, and says so',
       !/cut ?off as/i.test(String((j.mails || [])[0]?.body || A(draft))), A(draft).slice(0, 400));
    ck('  and the email is still a real request',
       /need bookings/i.test(A(draft)) || /2\s*x\s*40HC/i.test(A(draft)), A(draft).slice(0, 400));

    // AND AN UNREADABLE ANSWER IS NOT SILENTLY TREATED AS "SKIP".
    // "soon" is not a date and not a refusal; drafting a request with no
    // cutoff because a word did not parse would be a silent failure, which is
    // the shape this codebase keeps having to be taught out of.
    const j2 = await boot({});
    fsx.writeFileSync(px.join(j2.dir, 'workflow.json'),
        JSON.stringify({ HOU111: { supplier: 'Eccomelt' }, HOU222: { supplier: 'Eccomelt' } }, null, 2));
    await j2.say('show me available bookings from houston');
    await j2.say('zimex');
    await j2.say('2');
    const huh = await j2.say('soon');
    ck('an unreadable date re-asks instead of quietly dropping it',
       /didn't catch a date/i.test(A(huh)) && (j2.mails || []).length === 0, A(huh));
    await j2.stop();
    await j.stop();
}

section('C2e2 — but an ordinary empty result does NOT offer');
{
    // Her choice when asked: only when nothing is AVAILABLE. An empty result
    // for a plain search is just an empty result, and offering to email a
    // forwarder there would make Jarvis chatty about nothing.
    //
    // "Assigned bookings from Oakland" is genuinely empty — OAK333 has no
    // supplier — with a location set and a status that is NOT "unassigned".
    //
    // My first version of this used "cutting off tomorrow", which the offline
    // net does not read as a cutoff window at all, so the search came back
    // with two rows and the assertion could not fail. Caught by the mutation
    // harness: removing the status check survived it. An assertion that cannot
    // fail is the thing this whole file was built to stop me writing.
    const j = await boot({});
    const r = await j.say('show me assigned bookings from oakland');
    ck('an empty plain search does not offer to email anyone',
       !/forwarder/i.test(A(r)), A(r));
    // And "zimex" after it must not be read as an answer to a question nobody
    // asked — the offer is what makes a bare name meaningful.
    const after = await j.say('zimex');
    ck('  so a name afterwards drafts nothing',
       !/how many containers/i.test(A(after)) && (j.mails || []).length === 0, A(after));
    await j.stop();
}

section('C2e — and "no" sends nothing');
{
    const fsx = require('fs');
    const px = require('path');
    const j = await boot({});
    fsx.writeFileSync(px.join(j.dir, 'workflow.json'),
        JSON.stringify({ HOU111: { supplier: 'Eccomelt' }, HOU222: { supplier: 'Eccomelt' } }, null, 2));
    await j.say('show me available bookings from houston');
    const no = await j.say('no');
    ck('declining the forwarder offer is taken as an answer',
       /leaving it|right/i.test(A(no)), A(no));
    ck('  and nothing is drafted or sent', (j.mails || []).length === 0);
    await j.stop();
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
