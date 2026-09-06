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
    const iFollow = seg.indexOf('fu.answerFollowUp');
    const iProforma = seg.indexOf('pro.handle(asked)');
    const iScout = seg.indexOf("require('./helpers/yardAsk')");

    ck('the open question is looked up FIRST', iPending !== -1 && iPending < iRoute,
       'the router must not decide before we know a question is outstanding');
    ck('  before the follow-up shortcut', iPending < iFollow,
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
       /const step = answeringBrain \? null : pro\.handle\(asked\)/.test(seg),
       'a proforma in progress must not swallow a trucker confirmation');
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
    const iResolve = seg.indexOf('mem.resolve(stripped)');
    const iBrain = seg.indexOf("require('./workflow/brain')");
    ck('the ordinal is resolved first', iResolve !== -1 && iResolve < iBrain,
       '"the first one" reaching a regex layer is just a phrase it cannot match');
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
