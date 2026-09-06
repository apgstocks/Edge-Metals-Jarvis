// ── tests/voice-web.js ────────────────────────────────────────────────────
// Apsara, 2026-09-05: "i want hey jarvis like hey siri in my laptop."
//
// tests/voice-machine.js already proves the RULE — the pure reducer, driven
// through exhaustive event orderings. This file tests the BODY: the browser
// layer that owns the recogniser, the speaker and the DOM, and is supposed to
// do only what the reducer decides.
//
// That split is where this kind of feature actually breaks. The reducer can
// be perfect and the microphone still be left open, because the code holding
// it ignored an effect, or handled onend without telling the reducer, or —
// the one that bit the Android build — started the mic before the speaker was
// muted. So this file runs voice.js in a fake browser and watches what happens
// to a fake microphone.
//
// THE FAILURE IT EXISTS FOR: Jarvis speaks, the open mic hears "Jarvis" in its
// own reply, and it triggers itself, forever, on a live microphone until the
// laptop battery is flat. Section C is that, driven as a sequence.

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const MACHINE = fs.readFileSync(path.join(ROOT, 'dashboard/voice-machine.js'), 'utf8');
const VOICE = fs.readFileSync(path.join(ROOT, 'dashboard/voice.js'), 'utf8');

// A fake browser with a fake microphone and a fake voice, so every open and
// close is observable.
function browser({ chrome = true, voices = null, pref = null } = {}) {
    const vc = new VirtualConsole();
    // runScripts 'outside-only' is what gives the window a real eval() with
    // its own globals. Without it window.eval is Node's, and voice.js dies on
    // its first line because `window` is not defined in that scope.
    const dom = new JSDOM('<!doctype html><body></body>', {
        url: 'https://jarvis.edgemetals.com/', virtualConsole: vc, runScripts: 'outside-only' });
    const w = dom.window;
    const log = { starts: 0, stops: 0, spoken: [], spokenAs: [], cancels: 0, asked: [], micOpenWhileSpeaking: [] };
    let live = null;

    class FakeRecognition {
        constructor() { this.continuous = false; this.interimResults = false; }
        start() { log.starts++; live = this; }
        stop() { log.stops++; if (live === this) live = null; if (this.onend) this.onend(); }
        // Test helpers — what the browser would deliver.
        hear(text, final = true) {
            if (!this.onresult) return;
            this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: final })] });
        }
    }
    // jsdom reports document.hidden=true / visibilityState='prerender', so
    // voice.js starts with foreground:false and correctly refuses to open the
    // microphone — the app behaving right, not a bug. A real visible tab says
    // hidden=false, so the harness has to as well, and it must be set BEFORE
    // eval because VoiceMachine.initial reads it once at startup.
    Object.defineProperty(w.document, 'hidden', { value: false, configurable: true });
    Object.defineProperty(w.document, 'visibilityState', { value: 'visible', configurable: true });

    // The page's own console, captured. Needed because several of voice.js's
    // decisions are now REPORTED rather than silent — and "it says which way
    // it went" is a behaviour worth testing, not a comment. A mutation that
    // deleted the no-wake-word line survived the whole suite until this
    // existed.
    log.console = [];
    w.console = {
        log: (...a) => log.console.push(a.join(' ')),
        warn: (...a) => log.console.push(a.join(' ')),
        error: (...a) => log.console.push(a.join(' ')),
    };

    w.SpeechRecognition = FakeRecognition;
    if (chrome) w.chrome = {};                       // what canWake keys off
    else Object.defineProperty(w.navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15', configurable: true });

    w.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
    // The voice list a real macOS Chrome offers, novelty voices and all.
    // Included verbatim because the bug being fixed is that voice.js took
    // whatever came first, and what comes first on macOS is one of these
    // old compact voices — which is what Apsara heard as "more robot".
    const VOICES = voices !== null ? voices : [
        { name: 'Albert', lang: 'en-US' },
        { name: 'Bad News', lang: 'en-US' },
        { name: 'Fred', lang: 'en-US' },
        { name: 'Zarvox', lang: 'en-US' },
        { name: 'Samantha', lang: 'en-US' },
        { name: 'Alex', lang: 'en-US' },
        { name: 'Google US English', lang: 'en-US' },
        { name: 'Yuna', lang: 'ko-KR' },
    ];
    w.speechSynthesis = {
        getVoices: () => VOICES,
        onvoiceschanged: null,
        speak(u) {
            log.spoken.push(u.text);
            log.spokenAs.push(u.voice ? u.voice.name : null);
            // THE OBSERVATION THAT MATTERS: was the microphone open at the
            // instant audio began? Dispatching SPEAK_START by hand in a test
            // proves the reducer; only this proves that the code which
            // actually speaks remembers to tell it.
            log.micOpenWhileSpeaking.push(!!live);
            setTimeout(() => u.onend && u.onend(), 0);
        },
        cancel() { log.cancels++; },
    };
    w.api = async (p, opts) => {
        log.asked.push(JSON.parse((opts && opts.body) || '{}').question);
        return { ok: true, answer: 'Acme is owed six hundred dollars.' };
    };
    w.Audio = class { play() {} };

    // voice-machine.js is UMD: it prefers module.exports when it sees one.
    // Inside window.eval that check can still find Node's `module`, so the
    // reducer would attach itself there and window.VoiceMachine would be
    // undefined — voice.js then bails out with a warning and mounts nothing.
    // Attached explicitly so the harness tests the browser path.
    // Seeded BEFORE voice.js runs, because that is what a reload looks like:
    // the preference is already on disk when the page starts. Setting it
    // afterwards tests nothing — voice.js reads and caches its choice during
    // load, so a post-hoc write would only prove the setter works.
    if (pref !== null) {
        try { w.localStorage.setItem('jarvisVoiceName', pref); } catch (e) {}
    }

    w.eval(MACHINE);
    if (!w.VoiceMachine) w.VoiceMachine = require(path.join(ROOT, 'dashboard/voice-machine.js'));
    w.eval(VOICE);
    // jsdom in this mode leaves document.readyState at 'loading' for ever, so
    // voice.js's DOMContentLoaded handler would never fire and nothing would
    // mount. A real browser fires it; the harness has to.
    w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
    if (!w.JarvisVoice) throw new Error('voice.js did not initialise — check window.VoiceMachine');
    if (!w.document.getElementById('jarvisVoiceBar')) throw new Error('voice.js did not mount its bar');
    return { w, log, mic: () => live, doc: w.document };
}

(async () => {
console.log('\n─ "Hey Jarvis" in the browser ───────────────────────────────');

section('A0 — it does not answer in the 1990s robot voice');
{
    // Apsara, 2026-09-06: "the jarvis voice looks more robot."
    //
    // She was right and nothing was choosing. speechSynthesis.speak() with no
    // `voice` set takes the platform default, and on macOS the list starts
    // with Albert, Bad News, Fred and Zarvox — novelty and legacy voices from
    // the era the impression comes from. Samantha and Google US English were
    // installed the whole time, further down the same array.
    const b = browser();
    b.w.JarvisVoice.dispatch('USER_TOGGLE');
    b.mic().hear('hey jarvis');
    b.mic().hear('what is in inventory');
    b.w.JarvisVoice.finish();          // the capture timer, driven by hand
    await new Promise((r) => setTimeout(r, 5));

    ck('it spoke at all', b.log.spokenAs.length > 0);
    // `!== null` would PASS on undefined, which is what an unset u.voice
    // actually produces — the assertion has to demand a real name.
    ck('  and it CHOSE a voice rather than taking the default',
       typeof b.log.spokenAs[0] === 'string' && b.log.spokenAs[0].length > 0,
       'leaving u.voice unset is what produced the robot — the good voices were installed all along');
    ck('  not Albert, Fred or Zarvox',
       !/albert|fred|zarvox|bad news/i.test(String(b.log.spokenAs[0])),
       'these are the first entries in macOS\'s list, which is exactly why the default sounded like that');
    ck('  it took the best on offer',
       b.log.spokenAs[0] === 'Google US English',
       'picked ' + b.log.spokenAs[0] + ' — Chrome\'s own voice is the most natural available');

    // Apple's downloadable voices beat everything on the wishlist and must
    // win even though "Premium" appears nowhere in it.
    const prem = browser({ voices: [
        { name: 'Fred', lang: 'en-US' },
        { name: 'Google US English', lang: 'en-US' },
        { name: 'Ava (Premium)', lang: 'en-US' },
    ] });
    prem.w.JarvisVoice.dispatch('USER_TOGGLE');
    prem.mic().hear('hey jarvis');
    prem.mic().hear('what is in inventory');
    prem.w.JarvisVoice.finish();
    await new Promise((r) => setTimeout(r, 5));
    ck('  and a Premium voice outranks even that', prem.log.spokenAs[0] === 'Ava (Premium)',
       'picked ' + prem.log.spokenAs[0]);

    // A machine with nothing but novelty voices must still speak. Silence
    // would be a worse outcome than Zarvox.
    const bare = browser({ voices: [{ name: 'Zarvox', lang: 'en-US' }] });
    bare.w.JarvisVoice.dispatch('USER_TOGGLE');
    bare.mic().hear('hey jarvis');
    bare.mic().hear('what is in inventory');
    bare.w.JarvisVoice.finish();
    await new Promise((r) => setTimeout(r, 5));
    ck('  but it still speaks when there is nothing good', bare.log.spoken.length > 0,
       'refusing to answer because the voice is ugly would be a worse bug than the ugly voice');

    // Voices load ASYNCHRONOUSLY. An empty list at startup is the normal
    // case in a real browser, and must not permanently latch the default.
    const empty = browser({ voices: [] });
    empty.w.speechSynthesis.getVoices = () => [{ name: 'Samantha', lang: 'en-US' }];
    empty.w.JarvisVoice.dispatch('USER_TOGGLE');
    empty.mic().hear('hey jarvis');
    empty.mic().hear('what is in inventory');
    empty.w.JarvisVoice.finish();
    await new Promise((r) => setTimeout(r, 5));
    ck('  and an empty list at startup does not latch the default for ever',
       empty.log.spokenAs[0] === 'Samantha',
       'getVoices() is routinely empty on first call; caching that answer is the classic bug here');

    // ── AND A BAD EARLY ANSWER IS NOT KEPT EITHER ────────────────────────
    // The harder case, and the one the voiceschanged handler is actually
    // for. getVoices() can return a SHORT list first — often just the
    // built-in compact voices — and fill in the good ones a moment later.
    // Caching the first non-empty answer is not obviously wrong and leaves
    // her permanently on Fred, which is precisely the complaint.
    const late = browser({ voices: [{ name: 'Fred', lang: 'en-US' }] });
    late.w.speechSynthesis.getVoices = () => [
        { name: 'Fred', lang: 'en-US' },
        { name: 'Samantha', lang: 'en-US' },
    ];
    if (typeof late.w.speechSynthesis.onvoiceschanged === 'function') {
        late.w.speechSynthesis.onvoiceschanged();     // the browser telling us
    }
    late.w.JarvisVoice.dispatch('USER_TOGGLE');
    late.mic().hear('hey jarvis');
    late.mic().hear('what is in inventory');
    late.w.JarvisVoice.finish();
    await new Promise((r) => setTimeout(r, 5));
    ck('  and a better voice arriving later replaces the early poor one',
       late.log.spokenAs[0] === 'Samantha',
       'picked ' + late.log.spokenAs[0] + ' — without re-picking on voiceschanged she is stuck on Fred');
}

section('A1 — she can choose the voice, and the choice sticks');
{
    // Apsara, 2026-09-06: "set different voice."
    //
    // The wishlist in voice.js is my OPINION about which macOS voices sound
    // human. It should lose to hers every time, and it should lose across
    // reloads, or she has to re-pick it every morning.
    const b = browser();
    ck('there is a way in', !!b.doc.getElementById('jvVoiceBtn'),
       'a preference with no control is not a preference');

    b.doc.getElementById('jvVoiceBtn').click();
    const sheet = b.doc.getElementById('jvVoices');
    ck('  the picker opens', sheet && !sheet.classList.contains('hidden'));

    const rows = Array.from(b.doc.querySelectorAll('.jvvRow'));
    ck('  it lists the installed voices', rows.length > 1);
    // "System default" must be FIRST and must be a real option: passing no
    // voice at all is the only way Chromium will use a Premium voice set in
    // System Settings. Selecting one by name gets the compact version.
    ck('  with System default at the top',
       /system default/i.test(rows[0].textContent),
       'this entry is not cosmetic — it is the only route to a macOS Premium voice');
    ck('  and it only offers English voices',
       !rows.some((r) => /ko-KR/.test(r.textContent)),
       'the list had a Korean voice in it; offering it would be a trap');

    // Pick Alex — deliberately NOT what my ranking would choose, so this
    // proves her choice overrides my opinion rather than coinciding with it.
    const alex = rows.filter((r) => /^\s*Alex\b/.test(r.children[1].textContent))[0];
    ck('  a non-default voice is offered', !!alex);
    alex.click();

    b.w.JarvisVoice.dispatch('USER_TOGGLE');
    b.mic().hear('hey jarvis');
    b.mic().hear('what is in inventory');
    b.w.JarvisVoice.finish();
    await new Promise((r) => setTimeout(r, 5));
    // spokenAs[0] is the sample played on selection; the last is the answer.
    ck('  and Jarvis then answers in it',
       b.log.spokenAs[b.log.spokenAs.length - 1] === 'Alex',
       'answered as ' + b.log.spokenAs[b.log.spokenAs.length - 1] + ' — my ranking prefers Google US English, and it must lose to her');
    ck('  she hears a sample the moment she picks', b.log.spoken.length > 1,
       'choosing a voice you cannot hear is choosing blind');

    // Stored by NAME, not by index: getVoices() order is not stable across
    // launches, so an index would quietly become a different voice.
    ck('  the choice is remembered by name, not position',
       b.w.localStorage.getItem('jarvisVoiceName') === 'Alex');

    // ── AND IT SURVIVES A RELOAD ─────────────────────────────────────────
    // A fresh page, same storage. This is the actual requirement: "set
    // different voice" means set it ONCE.
    const again = browser({ pref: 'Alex' });
    again.w.JarvisVoice.dispatch('USER_TOGGLE');
    again.mic().hear('hey jarvis');
    again.mic().hear('what is in inventory');
    again.w.JarvisVoice.finish();
    await new Promise((r) => setTimeout(r, 5));
    ck('  and a reload keeps it', again.log.spokenAs[0] === 'Alex');

    // A voice chosen on another machine, or one she has since removed. It
    // must fall back to the ranking rather than going silent.
    const gone = browser({ pref: 'A Voice That Is Not Installed' });
    gone.w.JarvisVoice.dispatch('USER_TOGGLE');
    gone.mic().hear('hey jarvis');
    gone.mic().hear('what is in inventory');
    gone.w.JarvisVoice.finish();
    await new Promise((r) => setTimeout(r, 5));
    ck('  a missing saved voice falls back instead of going silent',
       gone.log.spoken.length > 0 && gone.log.spokenAs[0] === 'Google US English',
       'a stale preference must not be able to mute the assistant');

    // Choosing "System default" means passing NO voice — see above.
    // Started WITH a preference set, or clearing and not-clearing look the
    // same and the assertion proves nothing. (It did, and a mutation that
    // removed the clear survived until this line changed.)
    const dflt = browser({ pref: 'Alex' });
    ck('  (a preference is set to begin with)',
       dflt.w.localStorage.getItem('jarvisVoiceName') === 'Alex');
    dflt.doc.getElementById('jvVoiceBtn').click();
    Array.from(dflt.doc.querySelectorAll('.jvvRow'))[0].click();
    dflt.w.JarvisVoice.dispatch('USER_TOGGLE');
    dflt.mic().hear('hey jarvis');
    dflt.mic().hear('what is in inventory');
    dflt.w.JarvisVoice.finish();
    await new Promise((r) => setTimeout(r, 5));
    ck('  and "System default" clears the preference',
       !dflt.w.localStorage.getItem('jarvisVoiceName'));
}

section('A — nothing listens until she says so');
{
    const { w, log, mic } = browser();
    ck('the bar is mounted', !!w.document.getElementById('jarvisVoiceBar'));
    ck('the microphone is NOT open on load', log.starts === 0 && !mic(),
       'a page that starts listening because it loaded is not a feature, it is a bug with a microphone');
    ck('  and the setting is off', w.JarvisVoice.state().enabled === false);
    ck('  the dot is not live', !w.document.getElementById('jarvisVoiceBar').classList.contains('live'));

    // ── THE LABEL, WHICH COST HER AN AFTERNOON ────────────────────────────
    // The off state used to read "HEY JARVIS" — the phrase she is meant to
    // SAY — so she said it, repeatedly, at a switch that was off. An off
    // switch must name the action, not the incantation.
    ck('the OFF label tells her what to DO', /turn on/i.test(w.document.getElementById('jvToggle').textContent),
       'labelling an off switch "HEY JARVIS" invites exactly the thing that does not work');
    ck('  and it does not just say the wake phrase',
       !/^hey jarvis$/i.test(w.document.getElementById('jvToggle').textContent.trim()));

    w.JarvisVoice.dispatch('USER_TOGGLE');
    ck('turning it on opens the microphone', log.starts === 1 && !!mic());
    ck('  and NOW it says what to say', /listening/i.test(w.document.getElementById('jvToggle').textContent),
       'once it is on, naming the phrase is exactly right');
    ck('  and the dot goes live', w.document.getElementById('jarvisVoiceBar').classList.contains('live'),
       'an always-listening mic in an office has to be visibly on');
    ck('  and the tab title says so', /🎙/.test(w.document.title),
       'the dot is invisible the moment she switches tabs');

    w.JarvisVoice.dispatch('USER_TOGGLE');
    ck('turning it off closes the microphone', !mic());
    ck('  and the title goes back', !/🎙/.test(w.document.title));
}

section('B — the wake word, and only the wake word');
{
    const { w, log, mic } = browser();
    w.JarvisVoice.dispatch('USER_TOGGLE');

    mic().hear('the weather is quite nice today');
    ck('ordinary talk does not wake it', w.JarvisVoice.state().capturing === false,
       'a room where people talk must not trigger this constantly');

    mic().hear('hey jarvis');
    ck('"hey jarvis" wakes it', w.JarvisVoice.state().capturing === true);

    for (const phrase of ['jarvis', 'ok jarvis', 'okay Jarvis', 'HEY JARVIS']) {
        const b = browser();
        b.w.JarvisVoice.dispatch('USER_TOGGLE');
        b.mic().hear(phrase);
        ck(`  "${phrase}" also wakes it`, b.w.JarvisVoice.state().capturing === true);
    }
    const near = browser();
    near.w.JarvisVoice.dispatch('USER_TOGGLE');
    near.mic().hear('travis brought the load in');
    ck('  but "travis" does not', near.w.JarvisVoice.state().capturing === false,
       'a name that merely rhymes must not open a microphone');

    // ── WHAT tiny.en ACTUALLY WRITES ─────────────────────────────────────
    // The local model is 77MB and "Jarvis" is not a common word in its
    // training data, so it guesses. On her Mac a clear "Hey Jarvis" came
    // back as "I'll see you later" — and with a matcher that admitted only
    // the correct spelling, every mis-hearing became silence, which looked
    // exactly like the microphone being dead.
    //
    // The near-misses now count, but ONLY after an address. That is what
    // keeps the case above passing: "hey travis" is someone talking to a
    // laptop, "travis brought the load in" is someone talking about a
    // driver, and only grammar separates them.
    for (const phrase of ['hey travis', 'hey jervis', 'ok jarvez', 'hey service', 'jervis']) {
        const b = browser();
        b.w.JarvisVoice.dispatch('USER_TOGGLE');
        b.mic().hear(phrase);
        ck(`  "${phrase}" wakes it too`, b.w.JarvisVoice.state().capturing === true,
           'a miss costs her the whole feature; a false wake costs one visible 8s window');
    }
    // And the bare near-misses must still be inert, because these are words
    // a freight office says all day.
    for (const phrase of ['travis is outside', 'the service was late', 'javis called']) {
        const b = browser();
        b.w.JarvisVoice.dispatch('USER_TOGGLE');
        b.mic().hear(phrase);
        ck(`  but "${phrase}" stays quiet`, b.w.JarvisVoice.state().capturing === false,
           'without the "hey", these are ordinary yard talk');
    }
    // The name must not match INSIDE another word either. Without a leading
    // word boundary this passes everything above and still wakes on any
    // string that happens to end in the name.
    for (const phrase of ['open myjarvis account', 'the nonjarvis path']) {
        const b = browser();
        b.w.JarvisVoice.dispatch('USER_TOGGLE');
        b.mic().hear(phrase);
        ck(`  and "${phrase}" does not wake it`, b.w.JarvisVoice.state().capturing === false,
           'a pattern with no leading boundary matches inside longer words');
    }

    // ── IT MUST SAY WHICH WAY THE DECISION WENT ──────────────────────────
    // The failure this is written for: she says "Hey Jarvis", the model
    // writes down "I'll see you later", the wake does not fire, and NOTHING
    // is printed. A mis-transcription and a dead microphone then look
    // identical, and they need completely different fixes.
    {
        const b = browser();
        b.w.JarvisVoice.dispatch('USER_TOGGLE');
        b.mic().hear("I'll see you later");
        ck('a mis-heard wake word is reported, not swallowed',
           b.log.console.some((l) => /no wake word in "I'll see you later"/.test(l)),
           'this exact transcript is what her Mac produced from a clear "Hey Jarvis"');

        const b2 = browser();
        b2.w.JarvisVoice.dispatch('USER_TOGGLE');
        b2.mic().hear('hey jarvis');
        ck('  and so is a successful one',
           b2.log.console.some((l) => /wake word matched/.test(l)),
           'silence on success is just as unreadable as silence on failure');
    }

    // A LOOSE PATTERN passes the test above and is still wrong. /jarvis/i
    // with no word boundaries matches inside other words, so these exist to
    // catch that specifically — mutation testing showed the "travis" case
    // alone did not.
    for (const phrase of ['jarvisburg trucking called', 'the jarvises are here']) {
        const b = browser();
        b.w.JarvisVoice.dispatch('USER_TOGGLE');
        b.mic().hear(phrase);
        ck(`  "${phrase}" does not wake it`, b.w.JarvisVoice.state().capturing === false,
           'the wake word needs word boundaries, not a substring match');
    }
}

section('C — THE SELF-TRIGGER, which is why any of this is careful');
{
    // Jarvis answers out loud. Its own reply contains its own name. If the
    // microphone is open while that plays, it hears itself, matches the wake
    // word and triggers again — forever, on a live mic.
    const { w, log, mic } = browser();
    w.JarvisVoice.dispatch('USER_TOGGLE');
    ck('mic is open before speaking', !!mic());

    w.JarvisVoice.dispatch('SPEAK_START');
    ck('the microphone CLOSES before a word is spoken', !mic(),
       'this single assertion is the reason voice-machine.js exists');
    ck('  and the dot stops being live', !w.document.getElementById('jarvisVoiceBar').classList.contains('live'));

    // A partial result queued before the mic shut can still arrive late. It
    // must be ignored, not acted on.
    w.JarvisVoice.dispatch({ type: 'WAKE_HEARD' });
    ck('a late wake heard WHILE speaking is ignored', w.JarvisVoice.state().capturing === false,
       'that late arrival is precisely the self-trigger, arriving after the door was shut');

    w.JarvisVoice.dispatch('SPEAK_END');
    ck('the microphone reopens once it has finished', !!mic());
}

section('D — speaking and listening are never both true');
{
    // Driven as sequences rather than reasoned about, because the orderings
    // that break this are the ones nobody thinks to try by hand.
    const seqs = [
        ['USER_ENABLE', 'SPEAK_START', 'WAKE_HEARD', 'SPEAK_END'],
        ['USER_ENABLE', 'WAKE_HEARD', 'SPEAK_START', 'CAPTURE_END', 'SPEAK_END'],
        ['USER_ENABLE', 'SPEAK_START', 'CAPTURE_START', 'SPEAK_END'],
        ['USER_ENABLE', 'APP_BACKGROUND', 'WAKE_HEARD', 'APP_FOREGROUND'],
        ['USER_ENABLE', 'SPEAK_START', 'APP_BACKGROUND', 'SPEAK_END', 'APP_FOREGROUND'],
        ['USER_ENABLE', 'RECOGNISER_STOPPED', 'RECOGNISER_STOPPED', 'SPEAK_START', 'SPEAK_END'],
    ];
    for (const seq of seqs) {
        const b = browser();
        let bad = null;
        for (const e of seq) {
            b.w.JarvisVoice.dispatch(e);
            const s = b.w.JarvisVoice.state();
            if (s.speaking && !!b.mic()) bad = e;
        }
        ck(`[${seq.join(' → ')}] never has the mic open while speaking`, !bad,
           `broke at ${bad}`);
    }
}

section('E — hiding the tab stops the microphone, keeps the setting');
{
    const { w, mic } = browser();
    w.JarvisVoice.dispatch('USER_TOGGLE');
    ck('listening', !!mic());

    w.JarvisVoice.dispatch('APP_BACKGROUND');
    ck('switching away closes the microphone', !mic(),
       'a page must not listen while she cannot see that it is listening');
    ck('  but the setting survives', w.JarvisVoice.state().enabled === true,
       'otherwise she re-enables it every time she checks her email');

    w.JarvisVoice.dispatch('APP_FOREGROUND');
    ck('coming back reopens it', !!mic());
}

section('F — a refused microphone does not pretend');
{
    const { w, mic } = browser();
    w.JarvisVoice.dispatch('USER_TOGGLE');
    w.JarvisVoice.dispatch('PERMISSION_DENIED');
    ck('permission denied turns the setting OFF', w.JarvisVoice.state().enabled === false,
       'showing "Listening" without permission is a lie');
    ck('  and the microphone is not open', !mic());
}

section('G — a spoken instruction is still only a proposal');
{
    // Voice is an INPUT METHOD, not a second brain. It goes through the same
    // endpoint as the typed assistant, so the tool registry and the
    // propose-then-confirm rule apply identically.
    const { w, log, mic } = browser();
    w.JarvisVoice.dispatch('USER_TOGGLE');
    mic().hear('hey jarvis how much do we owe acme');
    // finishCapture runs on the timer; drive it directly.
    w.JarvisVoice.dispatch('CAPTURE_END');

    ck('the question goes to the same assistant endpoint', true,
       'asserted by the source check below — the fake api records the path');

    const src = fs.readFileSync(path.join(ROOT, 'dashboard/voice.js'), 'utf8');
    const nc = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    ck('voice posts to /api/yard/ask like the typed bot', /\/api\/yard\/ask/.test(nc));
    ck('  it has no endpoint of its own', !/\/api\/voice\//.test(nc),
       'a second path for spoken commands would be a second set of rules to keep in step');

    // THE LINE THAT MATTERS. A proposal is shown and tapped, never confirmed
    // by voice — "yes" to a machine that mishears names is the shortcut this
    // whole design refuses.
    ck('a proposal is never confirmed by voice',
       !/\/api\/yard\/confirm/.test(nc) && !/confirmAction/.test(nc),
       'confirming a payment by saying yes, to a recogniser that hears Rose as Bose');
    ck('  it asks her to check the card instead', /Check the card and confirm it/.test(src));
}

section('G2 — the code that SPEAKS closes the mic itself');
{
    // Sections C and D dispatch SPEAK_START by hand, which proves the reducer
    // and nothing about the caller. Removing dispatch('SPEAK_START') from
    // speak() left every one of those passing — the mic would have stayed
    // open through the entire spoken reply, which is the self-trigger. So
    // this drives the REAL path: ask, answer, speak.
    const { w, log, mic } = browser();
    w.JarvisVoice.dispatch('USER_TOGGLE');
    w.JarvisVoice.dispatch('WAKE_HEARD');
    mic() && mic().hear('hey jarvis how much do we owe acme');
    w.JarvisVoice.finish();          // the real path: ends capture AND asks
    await new Promise((r) => setTimeout(r, 20));

    ck('the answer was spoken', log.spoken.length > 0, 'the whole path did not run');
    ck('  and the microphone was SHUT the instant audio began',
       log.micOpenWhileSpeaking.every((open) => open === false),
       'this is the self-trigger: an open mic hears the reply, finds "Jarvis" in it, and fires again');
    ck('  the question reached the assistant', log.asked.length > 0 && /acme/i.test(log.asked[0]));
}

section('G3 — no speech engine is admitted, not papered over');
{
    // ── FOUND ON HER MACHINE, NOT IN A TEST ───────────────────────────────
    // The desktop app showed "LISTENING" with a red dot and heard nothing,
    // twice, while I theorised. Opening devtools in it took seconds:
    //   SR exists: true / MIC STARTED / SPEECH ERROR: network / MIC ENDED
    //
    // Speech recognition in Chrome is a GOOGLE SERVICE. Chrome ships private
    // API keys; Electron's Chromium does not have them. The API exists and
    // fails instantly, every time. My justification for the desktop app —
    // "Electron bundles Chromium so the wake word works" — was simply wrong.
    //
    // The failure that matters is not that speech is missing. It is that the
    // UI claimed to be listening while it was not, which is the same lie the
    // old "HEY JARVIS" label told.
    const { w, log, mic } = browser();
    w.JarvisVoice.dispatch('USER_TOGGLE');
    ck('it starts out listening', !!mic());

    mic().onerror({ error: 'network' });
    await new Promise((r) => setTimeout(r, 20));

    ck('a network error switches it OFF', w.JarvisVoice.state().enabled === false,
       'showing "Listening" against an engine that cannot answer is a lie');
    ck('  the microphone is closed', !mic());
    ck('  the dot is not live', !w.document.getElementById('jarvisVoiceBar').classList.contains('live'));
    ck('  and the button names the way out', /chrome/i.test(w.document.getElementById('jvToggle').textContent),
       '"it does not work" without a way forward is not an explanation');
    ck('  as does the status line', /Chrome/.test(w.document.getElementById('jvText').textContent));

    // It must NOT retry. Retrying spins for ever while the pill says
    // Listening — which is exactly the state this fix exists to prevent.
    const before = log.starts;
    w.JarvisVoice.dispatch('USER_TOGGLE');
    ck('and it refuses to reopen the microphone', log.starts === before,
       'there is no recovering from a missing engine; retrying just lies faster');

    // An ordinary quiet-room error is NOT treated this way.
    const ok = browser();
    ok.w.JarvisVoice.dispatch('USER_TOGGLE');
    ok.mic().onerror({ error: 'no-speech' });
    ck('a no-speech error leaves it listening', ok.w.JarvisVoice.state().enabled === true,
       'silence in a yard is normal and must not switch the feature off');
}

section('G4 — the desktop app uses the LOCAL engine, and prefers it');
{
    // The desktop app has no browser speech engine at all. It now ships its
    // own: audio captured in the window, transcribed by whisper.cpp inside
    // the app's Node process, nothing leaving the Mac.
    //
    // voice.js must PREFER it wherever it exists — not merely fall back to it
    // — because it is both the only thing that works there and more private
    // than Chrome's, which uploads the audio to Google.
    const src = fs.readFileSync(path.join(ROOT, 'dashboard/voice.js'), 'utf8');
    const nc = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

    ck('the local engine is checked FIRST', /var SR = LOCAL \|\| window\.SpeechRecognition/.test(nc),
       'falling back to it would mean Chrome wins on a machine where local is more private');
    ck('  and it enables the wake word by itself', /var canWake = !!LOCAL \|\|/.test(nc),
       'the Safari check is irrelevant when we own the engine');

    // The Chrome-specific "network" diagnosis must not fire against the local
    // engine — "use Chrome" is advice for a different problem.
    ck('the "use Chrome" advice is Chrome-path only', /err === 'network' && !LOCAL/.test(nc));
    ck('  and the local engine reports its own failures', /err === 'engine'/.test(nc));

    // The bridge is deliberately one function. Every API exposed to a remote
    // page is one that page could call.
    const pre = fs.readFileSync(path.join(ROOT, 'desktop/preload.js'), 'utf8');
    const exposed = (pre.match(/^\s{4}(\w+):/gm) || []).map((m) => m.trim().replace(':', ''));
    ck('the preload bridge exposes only speech', exposed.every((n) => /available|warm|transcribe|status/.test(n)),
       `exposed: ${exposed.join(', ')}`);
    // Comments stripped first. The preload's own comment says the bridge
    // cannot "read a file, spawn a process" — and the regex matched that
    // prose rather than any code. The fifth time this trap has caught me in
    // this repo; a comment describing the thing being asserted is not
    // evidence about the code.
    const preCode = pre.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    ck('  and no filesystem or process access', !/readFile|writeFile|spawn|exec|shell/.test(preCode),
       'the window shows a remote site; giving it those would hand the server this Mac');

    // The local recogniser must present the SAME shape voice.js already uses,
    // or the flow file would need to know which engine it has.
    const loc = fs.readFileSync(path.join(ROOT, 'dashboard/voice-local.js'), 'utf8');
    for (const m of ['start', 'stop', 'onresult', 'onerror', 'onend']) {
        ck(`  it implements ${m}, like the browser API`, new RegExp(m).test(loc));
    }
    ck('  and it announces itself under its own name',
       /window\.JarvisLocalRecognition = LocalRecognition/.test(loc),
       'masquerading as SpeechRecognition would make the choice invisible');

    // ── THE ENERGY GATE IS TESTED IN tests/voice-gate.js, NOT HERE ───────
    // What used to sit here were four grep-the-source assertions: does the
    // file contain the string "SPEECH_LEVEL", does it contain "held >=
    // MIN_MS". They tested SPELLING, not conduct — and they proved it by
    // breaking the moment the gate was rewritten to adapt to the room, even
    // though the new gate does the same job better. A test that fails on a
    // rename and passes on a broken threshold is worse than no test: it
    // costs attention and buys nothing.
    //
    // tests/voice-gate.js now runs the real onaudioprocess handler against
    // synthetic audio and checks what it DOES — that silence never reaches
    // Whisper, that a 190ms bang is discarded, that a 9s ceiling holds, that
    // frames are copied rather than aliased. All four of those were verified
    // by mutation; these greps were not.
    ck('the gate has its own behavioural suite',
       fs.existsSync(path.join(ROOT, 'tests/voice-gate.js')),
       'if this file is gone, the energy gate is untested — the greps that used to live here were not a substitute');

    // And the processor must not be audible.
    ck('the capture node is routed at zero gain', /mute\.gain\.value = 0/.test(loc),
       'connecting it to the speakers at full volume plays the room back at itself');
}

section('H — Safari degrades to a button instead of half-working');
{
    // Safari supports SpeechRecognition and then handles `continuous` badly:
    // the microphone does not reliably stop, and results pile into one
    // ever-growing string. A mic that sometimes never closes is worse than a
    // button, so the wake word is not offered there at all.
    const { w, log } = browser({ chrome: false });
    ck('the wake word is not offered on Safari', w.JarvisVoice.canWake === false);
    ck('  nothing is listening', log.starts === 0);
    ck('  and it says why, naming Chrome',
       /Chrome/.test(w.document.getElementById('jvText').textContent),
       '"it does not work" without a way forward is not an explanation');
    ck('  the button offers press-to-talk',
       /hold/i.test(w.document.getElementById('jvToggle').textContent));

    // And Chrome gets the real thing.
    const c = browser({ chrome: true });
    ck('Chrome gets the wake word', c.w.JarvisVoice.canWake === true);
    ck('  with continuous recognition', (c.w.JarvisVoice.dispatch('USER_TOGGLE'), c.mic().continuous === true),
       'a wake word without continuous mode is just a button with extra steps');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  Failed:'); failures.forEach((f) => console.log('   - ' + f)); }
process.exit(fail ? 1 : 0);
})();
