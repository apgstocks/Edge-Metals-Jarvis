// ── tests/booking-request.js ──────────────────────────────────────────────
// Apsara, 2026-09-06: "if i say jarvis,send a mail to say yurim,asking for a
// booking -it should ask how many containers... It can learn the pattern of
// how generally i ask for booking in my mail and then mimic my behaviour-the
// tone."
//
// WHAT WAS ALREADY THERE, AND IT IS MOST OF IT
// --------------------------------------------
// draftEmailForConfirm resolves the recipient from her address book, drafts
// the body through Gemini WITH helpers/writingStyle.js applied — that IS the
// tone mimicry, and it has been wired for weeks — and sends only on "yes".
// It also carries real scar tissue from August: a hallucinated
// "mike@example.com" recipient and an invented "I miss you" body, both caught
// live, both now guarded.
//
// The gap was the ONE QUESTION. A booking request with no quantity was
// drafted and sent anyway, and a carrier reading "please book us space" with
// no number replies asking how many. That is a day gone.
//
// WHAT THIS FILE GUARDS
// ---------------------
// Three things, in order of how badly they fail:
//   1. the detection, because a false positive interrupts an ORDINARY email
//      with "how many containers?" — the kind of thing that makes someone
//      stop using an assistant
//   2. the count parsing, because a wrong number is a real commitment to a
//      shipping line
//   3. the handover, because an answer that does not reach the pending gets
//      reclassified as a brand new request — a bug this codebase has already
//      hit once, documented in brain.js as the "Schedule this mail" incident

const path = require('path');
const fs = require('fs');
let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
process.env.DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const br = require(path.join(ROOT, 'helpers/bookingRequest.js'));

console.log('\n─ asking a carrier for space ────────────────────────────────');

section('A — is she asking for a booking?');
{
    // HER SENTENCE, and the ways round it she would actually use.
    for (const t of [
        'send a mail to Yurim asking for a booking',
        'ask Yurim for a booking',
        'email Yurim asking for a booking',
        'request space from MSC for next week',
        'see if Yurim can give us a booking',
        'check with Yurim for a slot',
        'ask MSC for allocation',
    ]) ck(`"${t}"`, br.isRequest(t) === true);
}

section('B — and everything it must NOT interrupt');
{
    // A false positive here asks "how many containers?" in the middle of an
    // unrelated email. That is worse than the bug being fixed, because the
    // bug only costs a round trip with a carrier while this costs her trust
    // in the whole flow.
    for (const t of [
        // Chasing a booking she ALREADY has. Answering this with "how many
        // containers?" is nonsense — the containers exist.
        'email Yurim about booking DALA123 cutoff',
        'ask Zimex about booking MEDUX9988',
        'email Zimex checking in',
        'send Yurim the proforma',
        'reply to Yurim saying we will confirm tomorrow',
        // BOOKING VOCABULARY, NO ASKING VERB. These are why isRequest needs
        // BOTH halves — a mutation dropping the verb test left every other
        // negative in this list passing, because they were all caught by the
        // existing-booking guard instead.
        'tell Yurim we got the booking',
        'forward the booking to Sher Trucking',
        'send Yurim the booking confirmation',
        'let Yurim know there is no space this week',
        'tell Sher Trucking the container is ready',
        'email accounts about the invoice',
        '',
    ]) ck(`"${t || '(nothing)'}" is not a booking request`, br.isRequest(t) === false);
}

section('C — how many, read out of a sentence');
{
    // containersIn is the STRICT one: it reads a count out of a sentence she
    // was not asked a question about, so a bare number must not count.
    const cases = [
        ['ask Yurim for a booking, 2 containers', 2, null],
        ['ask Yurim for 2x40HC', 2, '40HC'],
        ['ask Yurim for 3 x 40HC', 3, '40HC'],
        ['request two 40 high cubes from MSC', 2, '40HC'],
        ['ask for a couple of 40HCs', 2, '40HC'],
        ['book us 4 20GP', 4, '20GP'],
        ['ask Yurim for 2 x 45HC', 2, '45HC'],
    ];
    for (const [t, n, sz] of cases) {
        const got = br.containersIn(t);
        ck(`"${t}" → ${n}${sz ? ' ' + sz : ''}`,
           got.count === n && got.size === sz, JSON.stringify(got));
    }

    // "2x40HC" is the single most compact way she writes this, and it FAILED
    // — SIZE was anchored with \b and there is no word boundary between the
    // "x" and the "4". Found by running the parser, not by reading it.
    ck('the compact form works at all', br.containersIn('2x40HC').count === 2,
       'the \\b-anchored size could never match after an "x"');

    // What must NOT be read as a count.
    for (const t of ['call me in 2 hours', 'ask Yurim for a booking', 'two', '2']) {
        ck(`"${t}" yields no count from a sentence`, br.containersIn(t).count === null,
           JSON.stringify(br.containersIn(t)) + ' — a bare number in a sentence is usually not containers');
    }
    // 40 is a SIZE, not forty containers.
    ck('"40HC" alone is a size, not a count',
       br.containersIn('ask for 40HC').count === null
       && br.containersIn('ask for 40HC').size === '40HC');
    // Absurd counts are refused rather than sent to a carrier.
    ck('a three-digit count is refused',
       br.containersIn('ask for 400 containers').count === null,
       'far more likely a misheard year than the largest booking her company has made');
    ck('  and zero', br.containersIn('ask for 0 containers').count === null);
}

section('D — how many, ANSWERING the question');
{
    // Once "How many containers?" has been asked, the whole reply is the
    // answer, and "two" is what a person says. Refusing it would be the
    // assistant not listening — so this is a SEPARATE function, and the
    // difference between the two is whether the question was asked.
    for (const [t, n, sz] of [
        ['two', 2, null], ['2', 2, null], ['Two.', 2, null],
        ['2 containers', 2, null], ['just 3', 3, null], ['only two', 2, null],
        ['2x40HC', 2, '40HC'], ['two 40 high cubes', 2, '40HC'],
        ['a couple of 40HCs', 2, '40HC'], ['4 please', 4, null],
    ]) {
        const got = br.countInAnswer(t);
        ck(`"${t}" → ${n}${sz ? ' ' + sz : ''}`, got.count === n && got.size === sz,
           JSON.stringify(got));
    }

    // AND IT STILL REFUSES. An unreadable answer re-asks; it does not default
    // to one container and commit her to a carrier.
    for (const t of ['next tuesday', 'call me in 2 hours', 'whatever they have', '', '40HC',
        // A trailing number in an unrelated reply. These are what the ^
        // anchor is for — without it "ready in 3" reads as three containers,
        // and every other reject in this list is caught by the tail pattern
        // instead, so the anchor looked untested.
        'ready in 3', 'call me at 4', 'we discussed 2']) {
        ck(`"${t || '(nothing)'}" is not a count`, br.countInAnswer(t).count === null,
           JSON.stringify(br.countInAnswer(t)));
    }
    ck('  though a size-only reply keeps the size for the re-ask',
       br.countInAnswer('40HC').size === '40HC');

    // THE BUG THIS ALMOST WAS. The resolver first used containersIn, which
    // refuses a bare "two" — so the commonest possible answer would have been
    // re-asked for ever.
    const acts = fs.readFileSync(path.join(ROOT, 'workflow/actions.js'), 'utf8');
    const seg = acts.slice(acts.indexOf("pending.type === 'await_booking_details'"));
    ck('the resolver uses countInAnswer, not containersIn',
       /br\.countInAnswer\(said\)/.test(seg.slice(0, 1200)),
       'containersIn refuses a bare "two" — the resolver would loop for ever on the commonest reply');
}

section('D2 — the question itself');
{
    const q = br.ask('Yurim');
    ck('it names the recipient', /Yurim/.test(q), q);
    ck('  asks the one thing', /how many containers/i.test(q), q);
    ck('  and offers the shape of a useful answer without demanding it',
       /40\s*high\s*cube|40HC/i.test(q) && /if it matters/i.test(q), q);
    ck('  short enough to be spoken', q.length < 140, q.length + ' chars');
    ck('  and it copes with no name', /them/.test(br.ask(null)), br.ask(null));
}

section('E — what the drafter is told');
{
    const d = br.details(2, '40HC', 'ask Yurim for a booking please');
    ck('the count is stated', /\b2\b/.test(d), d);
    ck('  and the size', /40HC/.test(d), d);
    ck('  as an instruction to state it explicitly',
       /explicit/i.test(d),
       'a booking request without a quantity gets a reply asking for one');
    ck('  with her original words kept', /ask Yurim for a booking please/.test(d), d);
    ck('  and the routing words stripped',
       !/^\s*hey jarvis/i.test(br.details(2, null, 'Hey Jarvis, send an email to Yurim asking for a booking from Houston')),
       br.details(2, null, 'Hey Jarvis, send an email to Yurim asking for a booking from Houston'));

    ck('one container is singular', /1 40HC container\b/.test(br.details(1, '40HC', '')),
       br.details(1, '40HC', ''));
    ck('  and no size still reads properly',
       /2 containers/.test(br.details(2, null, '')), br.details(2, null, ''));

    // The count and size are FACTS handed over, not prose to embellish. Tone
    // is writingStyle.js's job and must not be duplicated here.
    // COMMENTS STRIPPED. This failed against correct code because the file's
    // own comment says "whether she says 'kindly'" — I matched my own prose,
    // for the third time this session. A check that reads commentary is
    // checking the wrong thing.
    const helperCode = fs.readFileSync(path.join(ROOT, 'helpers/bookingRequest.js'), 'utf8')
        .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    ck('the helper does not write the email itself',
       !/dear|regards|kindly|best wishes/i.test(helperCode),
       'the wording is writingStyle.js\'s job — a second voice here would drift from hers');
}

section('F — the handover, in the right order');
{
    const acts = fs.readFileSync(path.join(ROOT, 'workflow/actions.js'), 'utf8')
        .split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');

    // Asked AFTER the address is resolved. Asking "how many containers?" and
    // only then discovering there is no email address for them is two
    // questions where one would do.
    const iAsk = acts.indexOf("type: 'await_booking_details'");
    const iDraft = acts.indexOf('return draftEmailWithAddress(chatId, targetName, details, bkgNo, to, toSource, scheduledFor);');
    ck('the question is staged before the draft', iAsk !== -1 && iDraft !== -1 && iAsk < iDraft);

    // AND THE QUESTION IS ACTUALLY ASKED. Deleting this one line left every
    // other assertion in the file green: the pending would be staged, she
    // would be asked nothing at all, and the blocking pending would sit there
    // swallowing her next few sentences. Silence is the worst failure shape
    // this codebase has, and I nearly shipped another one.
    const stageBlock = acts.slice(iAsk, iAsk + 900);
    ck('  and the question is actually sent',
       /_send\(chatId, br\.ask\(/.test(stageBlock),
       'staging a pending and asking nothing leaves her in silence with everything blocked');
    ck('  naming who it is for',
       /br\.ask\(targetName\)/.test(stageBlock) && /\$\{who/.test(
           fs.readFileSync(path.join(ROOT, 'helpers/bookingRequest.js'), 'utf8')),
       '"How many containers?" with two drafts in flight is ambiguous');
    ck('  and a queued pending says so rather than going quiet',
       /staged\.queued/.test(stageBlock), stageBlock.slice(0, 120));
    ck('  and the pending carries everything needed to resume',
       /target_name: targetName, details: details \|\| null, bkg_no: bkgNo \|\| null,\s*\n?\s*to, to_source: toSource/.test(acts),
       'a pending missing the address means re-resolving it later, and a different answer');

    // Resumes through the SAME drafting tail, not a second one.
    // Bounded by something that SURVIVES comment-stripping. I first ended
    // this slice at '// Proforma confirmation' — a comment, in a string I had
    // just stripped comments out of — so indexOf returned -1, the slice ran
    // to the end of the file, and "never sends directly" failed against
    // correct code because api.js's other routes send plenty of mail. Same
    // over-broad-haystack mistake as tests/proforma-send.js.
    const resFrom = acts.indexOf("pending.type === 'await_booking_details'");
    const resTo = acts.indexOf("pending.type === 'confirm_proforma'", resFrom);
    ck('  the resolver block was located', resFrom !== -1 && resTo > resFrom,
       'from ' + resFrom + ' to ' + resTo);
    const res = acts.slice(resFrom, resTo);
    ck('  it resumes into the existing drafter',
       /return draftEmailWithAddress\(/.test(res),
       'a second drafting path would not get writingStyle.js and would drift');
    ck('  never sending directly',
       !/sendEmail|sendDraftedEmail/.test(res),
       'the await_email_confirm gate stays — she still approves the actual text');

    // "no" must still cancel.
    // THE RE-ASK. A resolver that drafted anyway on an unreadable answer
    // would commit her to a carrier for a number nobody said. Asserted on the
    // source because standing the resolver up needs setPending, Gmail, Gemini
    // and Supabase — stated plainly rather than dressed up as behavioural.
    ck('  an unreadable answer re-asks instead of drafting',
       /if \(count == null\) \{[\s\S]{0,400}?didn't catch a number/.test(res)
       && /booking_details_reasked/.test(res),
       'defaulting to one container is a real commitment to a shipping line');
    ck('    and keeps the pending open',
       res.indexOf('booking_details_reasked') < res.indexOf('await clearPending'),
       'clearing it would drop the question and lose the email');

    ck('  and "no" still cancels',
       /pending\.type === 'await_booking_details' && answer !== 'no'/.test(res),
       'declining to say how many means do not send the mail');

    // A number in the FIRST sentence means no question at all.
    ck('a count given up front is not asked about again',
       /details = br\.details\(count, size, said\)/.test(acts),
       'asking for something she just said is the form-in-disguise this flow exists to avoid');

    // And the whole check must never be able to lose the email.
    const guard = acts.slice(acts.indexOf("const br = require('../helpers/bookingRequest')"), iDraft);
    ck('a failure in the check falls through to an ordinary draft',
       /catch \(err\)/.test(guard),
       'a booking request drafted without the quantity is better than an email that vanishes');
}

section('G — her answer reaches the pending, not the classifier');
{
    // THE DOCUMENTED FAILURE MODE, one pending type over. brain.js records it
    // verbatim: with an email confirm open, "Schedule this mail @7am" fell
    // through every policy rule, was reclassified from scratch as a new email
    // request, found the same pending unresolved and queued a second draft
    // behind it — going in circles.
    //
    // "two" answering "how many containers?" is the same shape: not yes, not
    // no, not a numbered option.
    const brain = fs.readFileSync(path.join(ROOT, 'workflow/brain.js'), 'utf8');
    const catchIdx = brain.indexOf("p.type === 'await_booking_details'");
    ck('brain.js catches the answer at policy level', catchIdx !== -1,
       'without this it is reclassified as a brand new request');
    ck('  passing the whole sentence as the selection',
       /selection: ctx\.text/.test(brain.slice(catchIdx, catchIdx + 400)),
       'a free-text answer has nowhere else to travel');

    // ORDER. After YES/NO so a bare "no" still cancels; before the AI
    // fallthrough so the answer never reaches it.
    const iNo = brain.indexOf('if (NO.includes(t))');
    const iOptions = brain.indexOf('if (p.options) {');
    ck('  after the yes/no check', iNo !== -1 && iNo < catchIdx,
       '"no" must still mean cancel');
    ck('  and before the list-selection fallthrough', catchIdx < iOptions);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
