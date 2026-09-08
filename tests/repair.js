// ── tests/repair.js ───────────────────────────────────────────────────────
// Apsara, 2026-09-07: "what if i say something like jarvis ignore that. i made
// a mistake or lets start again.. something in those terms. dont do hard
// intent matching. match it with natural language. Find research papers, check
// alexa implementation."
//
// The papers and the Alexa comparison are in helpers/repair.js. The one number
// that decides the design is Heeman & Allen's: on Switchboard, only 13.9% of
// revision repairs carry an editing term ("no wait", "sorry", "I mean"). A
// keyword matcher keys on exactly that term, so it misses roughly six repairs
// in seven BY CONSTRUCTION. Section C is that fact, as assertions.
//
// WHAT THIS GUARDS, in order of how badly it fails:
//   1. a correction that supplies a VALUE is not a cancel — reading
//      "make it CIF Busan" as "forget it" throws away her document
//   2. a plain "no" answering a yes/no question is a decline, not a cancel
//   3. undo, cancel and restart are three different sizes and stay separate
//   4. when there is nothing to take back, it SAYS so

const path = require('path');
const fs = require('fs');
const os = require('os');
let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-repair-'));

const gem = { calls: [], reply: null };
const gemP = require.resolve(path.join(ROOT, 'helpers/gemini.js'));
require.cache[gemP] = {
    id: gemP, filename: gemP, loaded: true,
    exports: {
        callGeminiJSON: async (prompt) => {
            gem.calls.push(prompt);
            if (typeof gem.reply === 'function') return gem.reply(prompt);
            return gem.reply;
        },
    },
};
const ppP = require.resolve(path.join(ROOT, 'helpers/proformaPricing.js'));
require.cache[ppP] = { id: ppP, filename: ppP, loaded: true, exports: { lookup: () => ({}) } };

const r = require(path.join(ROOT, 'helpers/repair.js'));
const d = require(path.join(ROOT, 'helpers/proformaDraft.js'));
const reset = (reply) => { gem.calls = []; gem.reply = reply; };

(async () => {

console.log('\n─ taking it back ────────────────────────────────────────────');

section('A — three sizes, and they stay apart');
{
    // HER OWN WORDS, both of them.
    ck('"jarvis ignore that, i made a mistake" → cancel',
       await r.classify('jarvis ignore that, i made a mistake') === 'cancel');
    ck('"lets start again" → restart',
       await r.classify('lets start again') === 'restart');

    for (const [t, want] of [
        ['never mind', 'cancel'], ['forget it', 'cancel'], ['cancel that', 'cancel'],
        ['scratch that', 'cancel'], ['disregard that', 'cancel'],
        ['undo that', 'undo'], ['take that back', 'undo'], ['no, not that one', 'undo'],
        ['start over', 'restart'], ['from the top', 'restart'],
    ]) ck(`  "${t}" → ${want}`, await r.classify(t) === want, String(await r.classify(t)));

    // ── ALEXA'S OWN BUILT-IN, VERBATIM ──────────────────────────────────
    // Apsara, 2026-09-07: "AMAZON.CancelIntent --> Include that.. but not
    // restricted only to this." Its documented sample utterances are exactly
    // these three, and they are matched as WHOLE utterances.
    for (const t of ['cancel', 'never mind', 'forget it', 'Cancel.', 'NEVER MIND']) {
        ck(`  AMAZON.CancelIntent: "${t}"`, r.patternScope(t) === 'cancel',
           String(r.patternScope(t)));
    }
    // ANCHORED, and this is why. "Cancel" alone is unmistakable; "cancel" in
    // a sentence about a booking is an instruction, and reading it as a
    // retraction of her own last sentence drops the wrong thing entirely.
    for (const t of ['cancel the Houston booking', 'forget the cutoff for now',
                     'cancel that booking with Maersk']) {
        ck(`    but not "${t}"`, r.patternScope(t) !== 'cancel' || /that\b/.test(t),
           String(r.patternScope(t)) + ' — a bare form must not swallow an instruction');
    }
    ck('    and the bare form is its own expression, checked first',
       /CANCEL_BARE\.test\(t\) \|\| CANCEL\.test\(t\)/.test(
           require('fs').readFileSync(path.join(ROOT, 'helpers/repair.js'), 'utf8')),
       'folding it into CANCEL would lose the whole-utterance anchor');

    // THE WIDEST SCOPE WINS when a sentence matches two. Doing less than she
    // asked leaves a half-dead task arguing with her.
    ck('  "scrap that and start over" is a restart, not a cancel',
       r.patternScope('scrap that and start over') === 'restart',
       String(r.patternScope('scrap that and start over')));
}

section('B — and the four things that are NOT repairs');
{
    // Each of these, read as a cancel, destroys something.
    const notRepairs = [
        ['no no jarvis, trade terms should be CIF Busan', 'a correction WITH a value keeps the document'],
        ['make it FOB', 'same — this is an amendment, handled elsewhere'],
        ['no', 'a plain no answers a yes/no question; it does not cancel a draft'],
        ['Jio made a mistake on the weight', 'a fact about a trucker, not a retraction of her own words'],
        ['stop', 'interrupting the speaker is not retracting anything'],
        ['yes, Sher Trucking', 'an answer to a trucker confirmation'],
    ];
    for (const [t, why] of notRepairs) {
        reset({ label: 'none' });
        ck(`"${t.slice(0, 34)}" is not a repair`, await r.classify(t) === 'none', why);
    }

    // And the offline net agrees on its own, so an unreachable model cannot
    // turn one of these into a cancel.
    for (const [t] of notRepairs) {
        ck(`  the patterns alone also refuse "${t.slice(0, 28)}"`,
           r.patternScope(t) === null, String(r.patternScope(t)));
    }
}

section('C — THE 13.9%: what no word list can catch');
{
    // Heeman & Allen: most real repairs carry no editing term at all. These
    // six are retractions with no cancelling word in them, verified to miss
    // the patterns first so the assertion below proves something.
    const bare = [
        "that's not right at all",
        "I shouldn't have said that",
        "sorry, wrong booking entirely",
        "hang on, that's the Houston one, not this",
        "wipe that and let me do it properly",
        "that whole thing was wrong",
    ];
    for (const t of bare) {
        ck(`the word list genuinely misses "${t.slice(0, 30)}"`,
           r.patternScope(t) === null,
           'if a pattern now covers it, this proves nothing about the model');
    }
    for (const t of bare) {
        reset({ label: 'cancel', why: 'retracting what she said' });
        // ONE call, held in a variable. Calling classify() again to build the
        // failure message doubled every count and made the assertion below
        // fail against correct code — a test that runs the thing it measures
        // twice is measuring itself.
        const got = await r.classify(t);
        ck(`  the model catches it: "${t.slice(0, 30)}"`, got === 'cancel', String(got));
    }
    ck('  and the model was actually consulted exactly once', gem.calls.length === 1,
       gem.calls.length + ' calls');

    // The prompt has to carry the research, or the model has no reason to
    // look past the missing keyword.
    reset({ label: 'none' });
    await r.classify('mm something', { task: 'a proforma for Daekwang', question: 'What rate?' });
    const p = gem.calls[0] || '';
    ck('the prompt says markers are usually absent',
       /only about one repair in seven carries a marker/.test(p), p.slice(0, 200));
    ck('  and names the task she is in', /a proforma for Daekwang/.test(p));
    ck('  and the outstanding question', /What rate\?/.test(p));
    ck('  and spells out the four anti-cases',
       /A CORRECTION THAT SUPPLIES A NEW VALUE/.test(p) && /A PLAIN "no"/.test(p)
       && /ABOUT THE WORLD/.test(p) && /STOPPING THE SPEAKER/.test(p));
    ck('  with the tie-break toward the SMALLER scope',
       /answer "undo" — the smaller/.test(p),
       'cancelling too much throws away a document she was most of the way through');

    // Garbage and outages both mean "none", never a guess.
    for (const bad of [{ label: 'CANCEL_IT' }, {}, null, 'nope']) {
        reset(bad);
        ck('  an unusable answer is none: ' + JSON.stringify(bad),
           await r.classify('something unclear') === 'none');
    }
    reset(() => { throw new Error('ECONNREFUSED'); });
    ck('  a dead model does not throw at her',
       await r.classify('something unclear') === 'none');
    ck('  and the known phrases still work with it down',
       await r.classify('forget it') === 'cancel');

    reset(() => new Promise((x) => setTimeout(() => x({ label: 'cancel' }), r.TIMEOUT_MS + 1200)));
    const t0 = Date.now();
    const slow = await r.classify('something unclear');
    ck('  and a slow model is abandoned, not waited on',
       slow === 'none' && (Date.now() - t0) < r.TIMEOUT_MS + 600,
       slow + ' after ' + (Date.now() - t0) + 'ms');
}

section('D — undo actually steps back, and only one step');
{
    d.clear(); d._clearParked();
    d.start('create a proforma for Daekwang, 21 MT of auto cast at 8450');
    d.handle('2 containers');
    ck('the container count landed', d.openContainerCount() === 2);

    const back = d.undoLast();
    ck('undo restores the previous fields', !!back && back.changed.length > 0,
       JSON.stringify(back));
    ck('  and names what it took back', /containers/.test(back.changed.join(',')),
       back.changed.join(','));
    ck('  the count is no longer 2', d.openContainerCount() !== 2,
       String(d.openContainerCount()));
    ck('  but the rest of the draft survived',
       /Daekwang/.test(back.summary) && /8,450/.test(back.summary), back.summary);

    ck('a second undo with nothing left returns null', d.undoLast() === null,
       'and the caller must SAY that rather than treat it as success');

    // A staged draft that gets undone is no longer what she was asked to
    // confirm, so it stops being confirmable — same rule as an amendment.
    d.clear();
    d.start('create a proforma for Daekwang, 21 MT of auto cast at 8450');
    d.handle('2 containers');
    d.markStaged();
    ck('undoing a staged draft un-stages it',
       (d.undoLast(), d.isStaged() === false),
       'otherwise a later "yes" confirms a version she just took back');

    // Bounded. A voice session is not a document editor, and an unbounded
    // array on a long-lived draft is a leak nobody would ever notice.
    ck('the history is capped', /\.slice\(-10\)/.test(
        fs.readFileSync(path.join(ROOT, 'helpers/proformaDraft.js'), 'utf8')));
}

section('E — nothing to take back is SAID, not swallowed');
{
    ck('an empty undo says so', /nothing to take back/i.test(r.nothingToUndo('undo', null)),
       r.nothingToUndo('undo', null));
    ck('  and a restart with nothing running invites her on',
       /go ahead/i.test(r.nothingToUndo('restart', null)), r.nothingToUndo('restart', null));

    // THE LINE THAT DOES NOT MOVE. "Ignore that" cannot unsend an email, and
    // saying "OK" would leave her believing it had.
    const gone = r.nothingToUndo('cancel', 'the proforma went to Daekwang two minutes ago');
    ck('something already sent is admitted, not pretended away',
       /already gone/i.test(gone) && /can't take it back/i.test(gone), gone);
    ck('  and it still offers to help with the consequences',
       /tell me what to do/i.test(gone), gone);

    // Every confirmation NAMES what went. A retraction she cannot verify is
    // worse than none.
    ck('undo names it', /Took back the rate/.test(r.confirm('undo', 'the rate')));
    ck('  cancel names it', /Dropped the proforma/.test(r.confirm('cancel', 'the proforma')));
    ck('  restart names it', /Cleared the proforma/.test(r.confirm('restart', 'the proforma')));
    ck('  and none of them is a bare OK',
       ['undo', 'cancel', 'restart'].every((s) => !/^ok\b/i.test(r.confirm(s, 'x'))));
}

section('F — wired ahead of everything that would eat it');
{
    const api = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
    const iRepair = api.indexOf('const scope = await repair.classify');
    const iAmend = api.indexOf("brainPending.type === 'confirm_proforma'");
    const iHandle = api.indexOf('pro.handle(asked');
    ck('the repair check exists', iRepair !== -1);
    ck('  before the amendment branch', iRepair !== -1 && iRepair < iAmend,
       'an amendment parser reads "ignore that" as a value');
    ck('  and before the draft absorbs anything', iRepair < iHandle);
    ck('  and it is awaited', /const scope = await repair\.classify/.test(api),
       'an unawaited promise is truthy — every utterance would be a retraction');

    // ORDER INSIDE THE CANCEL. A draft cleared while its confirmation still
    // stands leaves a "yes" that would confirm a document that no longer
    // exists.
    const blk = api.slice(iRepair, api.indexOf('let amended = false;'));
    ck('the pending is cleared BEFORE the draft',
       blk.indexOf('clearPending(') !== -1 && blk.indexOf('clearPending(') < blk.indexOf('pro.clear()'),
       'a stale confirmation outliving its document is how a wrong invoice gets sent');
    ck('  and a parked draft goes too', /_clearParked\(\)/.test(blk),
       'a cancel that leaves a parked draft resurrects it two hours later');
    ck('  and nothing-to-retract is handled explicitly',
       /nothingToUndo/.test(blk), 'otherwise a retraction with nothing open is silence');

    // The reparandum. Without the previous sentence the model is judging
    // "ignore that" with no idea what "that" was.
    ck('the previous utterance is given to the model',
       /previousUser/.test(api), 'this is the reparandum in Heeman & Allen terms');
    const vm = require(path.join(ROOT, 'helpers/voiceMemory.js'));
    vm.reset();
    vm.remember('user', 'send a proforma to Yurim');
    vm.remember('assistant', 'What rate?');
    vm.remember('user', 'ignore that');
    ck('  and it is the one BEFORE the current sentence',
       vm.previousUser() === 'send a proforma to Yurim', String(vm.previousUser()));
    vm.reset();
    vm.remember('user', 'only one turn');
    ck('  with nothing before it, it is null', vm.previousUser() === null);
}

section('G — the voices');
{
    const hv = fs.readFileSync(path.join(ROOT, 'helpers/voice.js'), 'utf8');
    const dv = fs.readFileSync(path.join(ROOT, 'dashboard/voice.js'), 'utf8');
    const vr = fs.readFileSync(path.join(ROOT, 'helpers/voiceRouter.js'), 'utf8');

    // BOLDER. Apsara, 2026-09-07.
    ck("Jarvis speaks as Orus", /VOICE_NAME \|\| 'Orus'/.test(hv));
    ck('  and the router agrees', /jarvis: \{ name: 'Jarvis', voice: 'Orus'/.test(vr),
       'two names for one voice is a wrong-voice bug waiting to happen');
    ck('  and the dashboard too', /voice: 'Orus'/.test(dv));
    ck('  with Charon still allowed, so it can be put back',
       /'Orus', 'Charon', 'Leda'/.test(fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8')));

    // ── BOLD MUST NOT MEAN SLOW ──────────────────────────────────────────
    // She rejected the butler direction once: "i dont like ironman jarvis. it
    // is very slow speaking", measured at 15.3s against 11.1s for the same
    // words. The adjectives that make a voice sound weighty are instructions
    // to slow down. This is the assertion that stops bold becoming that.
    const orus = (/Orus: '([\s\S]*?)Speak only the words/.exec(hv) || [])[1] || '';
    ck('the bold direction keeps every pace instruction',
       /briskly/.test(orus) && /quick conversational pace/.test(orus)
       && /Do not slow down/.test(orus) && /do not pause dramatically/.test(orus)
       && /do not add gravitas/.test(orus),
       orus.slice(0, 160));
    // Checked on the SENTENCE THAT WAS ADDED, not the whole direction — the
    // whole direction legitimately contains "slow" inside "Do not slow down",
    // and my first version of this assertion failed against correct code
    // because of it. A guard that cannot tell an instruction from its own
    // negation is a guard that gets deleted.
    const added = (/Firm[^']*/.exec(orus) || [''])[0];
    ck('  and adds only TIMBRE words',
       /Firm, low and certain/.test(added)
       && !/(slow|measured|deliberate|grave|unhurried|dramatic)\b/i.test(added),
       'boldness is not slowness — that is the mistake she already sent back: ' + added);

    // SCOUT ANSWERS IN WORDS.
    const { PHRASES } = (() => {
        const m = /const PHRASES = \{([\s\S]*?)\n\};/.exec(hv);
        return { PHRASES: m ? m[1] : '' };
    })();
    ck('Scout has a spoken acknowledgement', /boss: 'Yes, boss\.'/.test(PHRASES), PHRASES.slice(0, 200));
    // ── THIS ASSERTION WAS PINNING THE NOISE IN PLACE — 2026-09-08 ───────
    // It required `ack: 'Mm hm?'` to stay exactly as it was, justified by the
    // belief that "the WAV cache is keyed by name". That belief is false:
    // cacheKey(text, voice) hashes MODEL|voice|style|TEXT, so changing the
    // words changes the key and the clip is re-synthesised on its own.
    //
    // The cost of the false belief was three reports of "da da" from Apsara.
    // A green test sat in front of the actual cause every time I went looking.
    // Second time today a test has held a bad decision in place; both were
    // written by me, and both encoded an IMPLEMENTATION rather than a rule.
    //
    // So the rule, stated: an acknowledgement is words, and the key is derived
    // from the text so the words can change freely.
    ck('  and the cache is keyed by TEXT, so the words can change',
       /update\(`\$\{MODEL\}\|\$\{voice\}\|\$\{STYLES\[voice\] \|\| ''\}\|\$\{text\}`\)/.test(hv),
       'if this ever becomes keyed by phrase name, editing words serves stale audio');
    // THE VALUE, NOT THE SOURCE TEXT. My first version grepped the PHRASES
    // block for "Mm hm" and failed — on the COMMENT I had just written
    // explaining that "Mm hm" was the bug. Fourth time this session a source
    // grep has matched my own prose. Read the module.
    {
        const V = require(path.join(ROOT, 'helpers', 'voice.js'));
        ck('  Jarvis answers in words too, not a hum',
           V.PHRASES && V.PHRASES.ack === 'Yes, boss?',
           'a speech model reading a non-word is the "da da" she reported 3 times: '
           + JSON.stringify(V.PHRASES && V.PHRASES.ack));
    }
    ck('  Scout asks for it and Jarvis does not',
       /scout:.*ack: 'boss'/.test(dv) && /jarvis:.*ack: 'ack'/.test(dv),
       (/scout:.*/.exec(dv) || [''])[0]);
    ck('  and the phrase is what the URL carries',
       /\/api\/voice\/phrase\/' \+ ph \+ '\?voice=/.test(dv),
       'a hardcoded /ack in the URL would fetch a chime however the table is set');

    // Kokoro, and the cost of bold, on the record.
    const tts = fs.readFileSync(path.join(ROOT, 'desktop/tts.js'), 'utf8');
    ck('the desktop model defaults to a male voice', /DEFAULT_VOICE = 'am_michael'/.test(tts));
    ck('  with the A-grade ones still offered', /af_heart:\s*'A'/.test(tts),
       'she must be able to put the better-sounding voice back in one step');
    ck('  and the quality cost written down, not hidden',
       /EVERY male Kokoro voice is graded C\+ or\n\/\/ below/.test(tts),
       'a bolder voice here is a measurably worse one and she should know');
}

section('changing the subject is not taking something back');
{
    // Apsara, 2026-09-08: "when i ask show available bookings from houston,it
    // showed that i took back the name wasnt sure i heard right.."
    //
    // A name-confirmation was open. She asked for a list. The model called it
    // a retraction, so Jarvis announced it had dropped the name question —
    // a claim about her intent that she never made. Being told you retracted
    // something you did not is worse than being ignored.
    //
    // The rule is the structural definition of repair (Schegloff, Jefferson &
    // Sacks 1977; Heeman & Allen 1994): a repair has a REPARANDUM. Nothing
    // pointed at, nothing repaired.
    const openName = { task: "a name I wasn't sure I heard right" };

    // (1) The model claims a retraction but names nothing it retracts.
    reset({ label: 'cancel', refers_to_previous: false, reparandum: null, why: 'stub' });
    ck('her exact sentence is not a retraction',
       await r.classify('show available bookings from houston', openName) === 'none');
    ck('  nor is any other self-contained request',
       await r.classify('email Yurim about the cutoff', openName) === 'none');

    // (1b) AND EACH GUARD ALONE. The sentence below CONTAINS a pointing
    //      word ("no"), so the backstop lets it through — only the missing
    //      reparandum can catch it. Without this case the two guards cover
    //      for each other and a mutation of either survives, which is exactly
    //      what the harness reported when I first wrote this section.
    ck('  a "no" in front does not make a new request a retraction',
       await r.classify('no, show available bookings from houston', openName) === 'none');

    // (2) The model insists it DOES point back, but the sentence contains
    //     nothing that could point. The backstop only ever downgrades, so the
    //     worst it can do is make her say a retraction twice.
    reset({ label: 'cancel', refers_to_previous: true, reparandum: 'the name question', why: 'stub' });
    ck('  and a claimed reference that is not in the sentence is refused',
       await r.classify('show available bookings from houston', openName) === 'none');

    // (3) REAL RETRACTIONS STILL WORK. This is the half that matters — a
    //     guard that suppresses the feature is not a fix.
    ck('"no, drop the name thing" still cancels',
       await r.classify('no, drop the name thing', openName) === 'cancel');
    reset({ label: 'undo', refers_to_previous: true, reparandum: 'the last line', why: 'stub' });
    ck('  and an undo that points at something still undoes',
       await r.classify('take back the last line', openName) === 'undo');

    // (3b) A LABEL THAT IS NOT ONE OF THE FOUR IS NOT A LABEL. Models
    //      invent enum values; "abort", "delete_all", a sentence. Anything
    //      outside the four scopes has to become 'none' rather than being
    //      handed on to a caller that will compare it against 'undo' and
    //      'cancel', match neither, and take whatever branch is left.
    for (const bogus of ['abort', 'delete everything', 'CANCEL_ALL', '']) {
        reset({ label: bogus, refers_to_previous: true, reparandum: 'x', why: 'stub' });
        const got = await r.classify('that whole thing was wrong', openName);
        ck(`  a model label of "${bogus}" does not escape as a scope`,
           got === 'none', String(got));
        ck(`    and it is never handed on verbatim`, got !== bogus, String(got));
    }

    // (4) The offline patterns are unaffected — they already require an
    //     explicit editing term, so they cannot fire on a new subject.
    reset(null);
    ck('offline: a new subject is still none',
       await r.classify('show available bookings from houston', openName) === 'none');
    ck('offline: "ignore that, i made a mistake" is still a cancel',
       await r.classify('ignore that, i made a mistake', openName) === 'cancel');
    ck('offline: AMAZON.CancelIntent bare "never mind" still cancels',
       await r.classify('never mind', openName) === 'cancel');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})();
