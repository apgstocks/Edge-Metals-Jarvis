// ── tests/forward-flow.js ─────────────────────────────────────────────────
// Apsara, 2026-09-06: "finally when i say okay forward that to trucker, It
// should do that if it has knowledge about who to forward, else ask me."
//
// WHAT ALREADY EXISTED
// --------------------
// All of it. workflow/actions.js's forwardBooking has done exactly this for
// weeks: refuse without a supplier, ask WHICH TRUCKER when none was named,
// then ask "Forward AAA111 to Sher Trucking? (yes/no)" and send only on yes.
//
// WHAT BROKE IT BY VOICE, AND IT IS SUBTLE
// ----------------------------------------
// Her ANSWER to that question is "yes", or "Sher Trucking", or "the second
// one". Sentences with no freight vocabulary in them at all. The router
// scores them as ordinary talk and hands them to Scout — so the
// confirmation for a real WhatsApp to a real driver vanishes into the
// assistant that cannot act on it, and the question stays open for ever.
//
// The rule this file guards: WHILE THERE IS AN OPEN QUESTION, EVERYTHING
// GOES TO WHOEVER ASKED IT. Not the router, not the follow-up shortcut, not
// the proforma draft.
//
// The endpoint is not stood up — that needs Gmail, WhatsApp, Supabase and a
// Gemini key. What is checked is the ORDER and the GUARDS in the handler,
// plus the one thing that is pure logic and was nearly a runtime crash: the
// declaration reaching its uses.

const path = require('path');
let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const all = require('fs').readFileSync(path.join(ROOT, 'api.js'), 'utf8');
const from = all.indexOf("app.post('/api/voice/ask'");
const nextRoute = all.indexOf('\n    app.', from + 10);
const segRaw = all.slice(from, nextRoute === -1 ? all.length : nextRoute);
// COMMENTS STRIPPED. Three assertions failed against correct code because
// they matched words in my own comments — "the question Jarvis just asked",
// "forwardBooking refuses without a supplier". A source check that reads
// prose is checking the wrong thing, and the failures it produces teach
// people to ignore it.
const seg = segRaw
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');

console.log('\n─ forwarding a booking by voice ─────────────────────────────');

section('A — an open question outranks everything');
{
    ck('the handler was found', from !== -1 && seg.length > 500);

    const iPending = seg.indexOf('brainPending = require');
    const iRoute = seg.indexOf('const route =');
    // fu.answer, not fu.answerFollowUp — the endpoint now calls the DYNAMIC
    // one ("i dont want any fixed intent"), which asks the model and keeps
    // the patterns only as the offline net. Searching for the old name
    // returned -1 and the ordering check silently compared against it.
    const iFollow = seg.indexOf('fu.answer(');
    // 'pro.handle(asked' without the closing paren — handle now takes the
    // dynamic transition as a second argument, and matching the old exact
    // call returned -1, which made `iPending < iProforma` compare against a
    // sentinel and pass for the wrong reason. Third time a source grep in
    // this file has silently measured a name that no longer exists.
    const iProforma = seg.indexOf('pro.handle(asked');
    ck('  the proforma handler is still called', iProforma !== -1,
       'pro.handle was renamed or dropped — the ordering checks below mean nothing without it');
    const iScout = seg.indexOf("require('./helpers/yardAsk')");

    ck('the open question is looked up FIRST', iPending !== -1 && iPending < iRoute,
       'the router must not decide before we know a question is outstanding');
    ck('  before the follow-up shortcut', iFollow !== -1 && iPending < iFollow,
       '"when is the next cutoff" is a follow-up; "yes" is an ANSWER, and they are not the same');
    ck('  before the proforma draft', iPending < iProforma);
    ck('  and before Scout', iPending < iScout);
}

section('B — the guards actually short-circuit');
{
    // Each of the three paths that could swallow her answer must be
    // explicitly disabled while a question is open. Present-and-in-the-right-
    // order is not the same as USED.
    ck('the router is overridden when a question is open',
       /const route = answeringBrain\s*\n\s*\?\s*\{ agent: 'jarvis'/.test(seg),
       'a bare "yes" scores as nothing and would land on Scout');
    ck('  the follow-up shortcut stands down',
       /const quick = answeringBrain\s*\n\s*\?\s*null/.test(seg),
       'answering from the booking list would drop the confirmation on the floor');
    ck('  and the proforma draft stands down',
       /const step = \(answeringBrain && !amended && !parking\)\s*\n?\s*\? null : pro\.handle\(asked, \{ transition \}\)/.test(seg),
       'a proforma in progress must not swallow a trucker confirmation');

    // ── THE SECOND EXCEPTION, AND WHY IT NEEDS NO THIRD LOCK ─────────────
    // "hold this" also has to reach the draft while a pending is open, or the
    // brain reads it as an answer to "Send it to Daekwang?". Unlike the
    // amendment exception this one is NOT gated on the pending being a
    // proforma — and it does not need to be, which is worth stating rather
    // than leaving as an apparent inconsistency.
    //
    // isPark() only fires when a draft is actually open, and isResume() only
    // when one is actually parked. With a TRUCKER confirmation outstanding
    // and no proforma anywhere, handle() returns null and the sentence falls
    // through to the brain exactly as before. The narrowing is in the
    // functions, not in the condition.
    ck('  parking reaches the draft too',
       /const parking = transition === 'park' \|\| transition === 'resume';/.test(seg));
    // AND THE TRANSITION IS THE DYNAMIC ONE. Apsara, 2026-09-07: "it has to
    // work dynamically." A regression that swapped classify() back for the
    // two regexes would leave every assertion in this section green while
    // quietly restoring the fixed vocabulary she asked me to remove.
    ck('    decided by the model, not a word list',
       /require\('\.\/helpers\/draftIntent'\)\s*\n?\s*\.classify\(asked, pro\.transitionState\(\)\)/.test(seg),
       'classify() is what makes park/resume dynamic; the regexes are its offline net');
    ck('    and awaited, because it is a network call',
       /const transition = await require\('\.\/helpers\/draftIntent'\)/.test(seg),
       'an unawaited promise is truthy, so EVERY utterance would count as parking');
    const pd = require(path.join(ROOT, 'helpers/proformaDraft.js'));
    const di = require(path.join(ROOT, 'helpers/draftIntent.js'));
    pd.clear(); pd._clearParked();
    ck('    but with no proforma anywhere it decides nothing',
       pd.handle('lets hold this and work on email') === null,
       'a trucker confirmation must still own the conversation');
    ck('    and nor does "back to the proforma"',
       pd.handle('back to the proforma') === null);

    // ── THE ONE EXCEPTION, AND HOW NARROW IT HAS TO BE ───────────────────
    // Apsara, 2026-09-07: "what if i want change in cif and payment terms."
    // An amendment to a staged proforma now outranks its own confirmation,
    // which is a hole in "an open question owns the conversation" — the rule
    // this whole file exists to guard.
    //
    // ── AND WHICH LOCK IS ACTUALLY LOAD-BEARING ─────────────────────────
    // 2026-09-07. This comment used to say the cue-word test was what kept
    // "yes, Sher Trucking" out of the proforma path. That was WRONG, and it
    // took Apsara pushing back — "it has to work dynamically... just like
    // jarvis in iron man" — to go and check rather than repeat it.
    //
    // A trucker confirmation is `confirm_forward`. The FIRST lock already
    // requires `confirm_proforma`, so a trucker confirm never reaches this
    // branch at all. The cue list was not carrying that safety; it was
    // carrying nothing, while silently dropping five of ten real corrections.
    //
    // The locks that ARE load-bearing, and what each one stops:
    //   1. confirm_proforma  — keeps every other confirmation out entirely
    //   2. isStaged()        — a draft still being asked about absorbs
    //                          answers itself; this is the confirm window
    //   3. a real field change — inside isAmendment(), and asserted by
    //                          RUNNING it below, not by reading the call
    const lock = /answeringBrain && brainPending && brainPending\.type === 'confirm_proforma'\s*\n\s*&& pro\.isStaged\(\) && pro\.isAmendment\(asked, \{ intent: transition \}\)/;
    ck('  the amendment exception is locked to all three conditions at once',
       lock.test(seg),
       'proforma pending AND staged AND a real field change — the FIRST is what '
       + 'keeps a trucker confirmation out, and it is the one that must not move');
    ck('    and the correction test is the dynamic one',
       /pro\.isAmendment\(asked, \{ intent: transition \}\)/.test(seg),
       '"trade terms CIF Busan" carries no cue word and was being dropped');

    // RUN, not grepped. The field-change lock is the only one of the three
    // that lives inside a function, and it is the one that stops a bare
    // "wait" tearing down a confirmation she had not finished thinking about.
    pd.clear(); pd._clearParked();
    pd.start('create a proforma for Daekwang, 2 containers, 21 MT of auto cast at 8450, CIF Long Beach');
    pd.markStaged();
    ck('    a hesitation is not an amendment, even when the model says amend',
       pd.isAmendment('wait', { intent: 'amend' }) === false,
       'nothing changed, so tearing down her confirmation would be for nothing');
    ck('    nor is a question about something else',
       pd.isAmendment('any bookings from Houston', { intent: 'amend' }) === false);
    ck('    but a real field change is, with no cue word at all',
       pd.isAmendment('trade terms CIF Busan', { intent: 'amend' }) === true,
       'this is the phrasing that was being swallowed');
    // A PHRASE THAT COLLIDES, chosen deliberately. My first version used
    // "lets hold this and work on email", which carries no correction cue at
    // all — so deleting the park guard left it returning false anyway and the
    // mutation SURVIVED. This one fires the park pattern AND the cue list AND
    // yields a real field, so the guard is the only thing separating them.
    const collide = 'actually hold this, trade terms CIF Busan can wait';
    ck('    the collision phrase really does look like both',
       di.PARK.test(collide) && pd.CORRECTION_CUE.test(collide),
       'if either stops matching, the assertion below proves nothing');
    ck('    and a decided park is never an amendment',
       pd.isAmendment(collide, { intent: 'park' }) === false,
       'the two branches read the same classification and must not both fire — '
       + 'parking and amending the same sentence loses the draft AND rewrites it');
    ck('    with the pending torn down before the draft reopens',
       seg.indexOf('clearPending(') !== -1
       && seg.indexOf('clearPending(') < seg.indexOf('const step ='),
       'a later "yes" would otherwise confirm the version she just changed');
}

section('C — the declaration reaches its uses');
{
    // NEARLY A RUNTIME CRASH. `const` is not hoisted: using it above its
    // declaration throws a ReferenceError on the first real request, and
    // `node --check` cannot see it because it is not a syntax error. I had
    // exactly that, from moving a block.
    const decl = seg.indexOf('const answeringBrain');
    const uses = [...seg.matchAll(/answeringBrain/g)].map((m) => m.index);
    ck('answeringBrain is declared', decl !== -1);
    ck('  and never used above its declaration',
       uses.every((i) => i >= decl),
       'used at ' + uses.filter((i) => i < decl).join(',')
       + ' — a temporal dead zone throw on the first request, invisible to a syntax check');

    // `mem` and `ref` are the other two the handler leans on. `asked` and
    // `agent` are deliberately NOT swept: both appear as ordinary English and
    // as object KEYS ("agent: 'jarvis'"), so a word-boundary search over them
    // reports failures that are not failures. A check that cries wolf gets
    // switched off, and then the real one goes with it.
    for (const name of ['mem', 'ref']) {
        const d = seg.indexOf(`const ${name} =`);
        if (d === -1) continue;
        const u = [...seg.matchAll(new RegExp('\\b' + name + '\\.', 'g'))].map((m) => m.index);
        ck(`  and so is ${name}`, u.every((i) => i >= d),
           name + ' used at ' + u.filter((i) => i < d).join(','));
    }
}

section('D — the flow it hands off to is the REAL one');
{
    // Not a second implementation. forwardBooking already refuses without a
    // supplier, asks which trucker, and confirms — a parallel path by voice
    // would be a second set of rules to keep in step, and the one that
    // drifts is the one that sends a truck to the wrong yard.
    const actions = require('fs').readFileSync(path.join(ROOT, 'workflow/actions.js'), 'utf8');
    ck('forwardBooking refuses without a supplier',
       /no supplier assigned to container/.test(actions),
       'a container with nobody to collect from cannot be forwarded');
    ck('  asks WHICH trucker when none was named',
       /buildTruckerSelectionMessage/.test(actions) && /select_trucker/.test(actions),
       'this is her "if multiple truckers, ask me specifically"');
    ck('  and confirms before sending',
       /confirm_forward/.test(actions) && /\(yes\/no\)/.test(actions));

    // And the voice path does not reimplement any of it.
    ck('the voice endpoint does not forward on its own',
       !/forwardBooking|executeForward/.test(seg),
       'a second forwarding path is a second set of rules to keep in step');
}

section('E — the referent still resolves before the brain sees it');
{
    // "forward the first one to Sher" only means something if the ordinal
    // was turned into a booking number BEFORE the brain's regex layer, which
    // cannot resolve a reference itself.
    // resolveSmart, not resolve — the SECOND time this check has silently
    // compared against a name that no longer exists (fu.answerFollowUp was
    // the first). indexOf returning -1 is caught explicitly now, so a rename
    // fails loudly instead of passing against nothing.
    const iResolve = seg.indexOf('mem.resolveSmart(stripped)');
    const iBrain = seg.indexOf("require('./workflow/brain')");
    ck('the reference is resolved before the brain sees it',
       iResolve !== -1 && iBrain !== -1 && iResolve < iBrain,
       iResolve === -1
           ? 'mem.resolveSmart(stripped) is not in the handler — renamed again?'
           : '"the Maersk one" reaching a regex layer is just a phrase it cannot match');
    ck('  and the RESOLVED text is what the brain is given',
       /text: asked,/.test(seg),
       'passing the raw utterance would undo the resolution entirely');
}

section('F — and it still refuses to guess which booking');
{
    process.env.DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
    const mem = require(path.join(ROOT, 'helpers/voiceMemory.js'));
    mem.reset();
    mem.setReferents({ kind: 'bookings', title: 'x', rows: [
        { n: 1, booking_number: 'AAA111' },
        { n: 2, booking_number: 'BBB222' },
        { n: 3, booking_number: 'CCC333' },
    ] });

    ck('"forward the first one" resolves',
       /AAA111/.test(mem.resolve('forward the first one to Sher Trucking').text));
    const amb = mem.resolve('forward that to the trucker');
    ck('  but "that" with three on screen refuses', amb.resolved === null,
       'a wrong resolution here sends a truck to the wrong yard');
    ck('  and says how many it could have meant', amb.ambiguous === 3);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
