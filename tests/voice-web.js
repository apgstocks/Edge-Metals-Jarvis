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
function browser({ chrome = true, voices = null, pref = null, reply = null } = {}) {
    const vc = new VirtualConsole();
    // runScripts 'outside-only' is what gives the window a real eval() with
    // its own globals. Without it window.eval is Node's, and voice.js dies on
    // its first line because `window` is not defined in that scope.
    const dom = new JSDOM('<!doctype html><body></body>', {
        url: 'https://jarvis.edgemetals.com/', virtualConsole: vc, runScripts: 'outside-only' });
    const w = dom.window;
    const log = { starts: 0, stops: 0, spoken: [], spokenAs: [], cancels: 0, asked: [], paths: [], micOpenWhileSpeaking: [] };
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
        const body = JSON.parse((opts && opts.body) || '{}');
        // BOTH the path and the words. Recording only the question meant a
        // change of endpoint was invisible here and had to be caught by
        // grepping the source — and the parameter is `text` now, not
        // `question`, because the router reads the sentence to decide which
        // assistant owns it. Reading the old field silently recorded
        // `undefined` on every call.
        log.paths.push(p);
        log.asked.push(body.text || body.question);
        w.__lastAgent = body.agent || null;
        const who = body.agent === 'scout' ? 'scout' : 'jarvis';
        const base = {
            ok: true, answer: 'Acme is owed six hundred dollars.',
            agent: who, agent_name: who === 'scout' ? 'Scout' : 'Jarvis',
        };
        // `reply` lets a test drive the SHAPE of the response — a proforma
        // preview, say. A function so it can differ per call, which is what a
        // confirm-then-send exchange needs: the first call returns a document
        // to approve, the second returns none because it has been sent.
        if (typeof reply === 'function') return Object.assign(base, reply(body, log));
        if (reply) return Object.assign(base, reply);
        return base;
    };
    w.Audio = class { play() {} };
    // The server's cached acknowledgement. Present so the PREFERRED path is
    // tested — without it the suite only ever saw the fallback, and a mount
    // that threw on a missing fetch went unnoticed until the whole file
    // crashed.
    w.__ackFetches = [];
    w.fetch = async (p) => {
        w.__ackFetches.push(p);
        // The VOICE is encoded in the sample rate, so the buffer that is
        // eventually played can be traced back to which voice it came from.
        // Without something distinguishable, "fetched both, played one" is
        // indistinguishable from correct behaviour.
        const rate = /Leda/.test(p) ? 22050 : 24000;
        return { ok: true, __rate: rate, arrayBuffer: async () => ({ __rate: rate }) };
    };

    // A context that records every buffer it is asked to play, at its rate.
    w.__playedRates = [];
    w.AudioContext = class {
        constructor() { this.destination = {}; this.state = 'suspended'; }
        resume() { this.state = 'running'; return Promise.resolve(); }
        decodeAudioData(buf) {
            const rate = (buf && buf.__rate) || 24000;
            return Promise.resolve({
                duration: 0.4, sampleRate: rate,
                getChannelData: () => new Float32Array(rate === 22050 ? 8820 : 9600),
            });
        }
        createBuffer(ch, len, rate) {
            return { length: len, sampleRate: rate, getChannelData: () => new Float32Array(len) };
        }
        createBufferSource() {
            const self = this;
            const node = {
                buffer: null, onended: null, connect() {},
                start() { w.__playedRates.push(node.buffer && node.buffer.sampleRate); },
                stop() {},
            };
            return node;
        }
        createGain() { return { gain: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
        createOscillator() { return { type: '', frequency: { setValueAtTime() {} }, connect() {}, start() {}, stop() {} }; }
        get currentTime() { return 0; }
    };

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

section('Z — the files are clean text');
{
    // A NUL byte got into dashboard/voice.js, mid-string, from one of my own
    // scripted edits: `name: ' kokoro:'` became `name: '\0kokoro:'`. Node
    // parsed it happily and every test passed. What gave it away was `grep`
    // refusing to search the file because it had decided it was binary.
    //
    // These files are SERVED TO A BROWSER, and a control character inside a
    // string literal is the kind of thing that works in one parser and not
    // another. Cheap to check, and I have been editing these files with
    // scripts all day.
    for (const f of ['dashboard/voice.js', 'dashboard/voice-local.js',
                     'dashboard/voice-machine.js', 'dashboard/orb.js']) {
        const buf = fs.readFileSync(path.join(ROOT, f));
        const bad = [];
        for (let i = 0; i < buf.length; i += 1) {
            const b = buf[i];
            // Tab, LF and CR are the only control characters that belong.
            if (b < 9 || (b > 13 && b < 32)) bad.push(i);
        }
        ck(`${f} has no stray control characters`, bad.length === 0,
           bad.length + ' found, first at byte ' + bad[0]
           + ' — a NUL inside a string literal parses in Node and may not in a browser');
    }
}

section('A000 — nothing she says or hears gets cut in half');
{
    // Apsara, twice: "a chat box with text is coming but it is half cut",
    // then "the transcription is also cut into half - not wrapping."
    //
    // Two locations, one bug, and I fixed only the first. Both the ANSWER
    // and the LIVE TRANSCRIPT were being written into the status pill —
    // a single-line flex row — after being sliced to 60 and 44 characters.
    // So each was cut twice over: once by the slice, once by the pill.
    const b = browser();
    b.w.JarvisVoice.dispatch('USER_TOGGLE');

    // A sentence longer than either slice, of the kind she actually says.
    const LONG = 'record a twelve thousand dollar zelle payment against edge zero seven for the copper load that came in on tuesday';
    b.mic().hear('hey jarvis');
    b.mic().hear(LONG);

    const cardQ = b.doc.getElementById('jvCardQ');
    const pill = b.doc.getElementById('jvText');

    ck('the live transcript goes in the card', !!cardQ && cardQ.textContent.length > 60,
       'card holds ' + (cardQ ? cardQ.textContent.length : 0) + ' chars');
    ck('  IN FULL, not sliced', cardQ.textContent.indexOf('tuesday') !== -1,
       'got: ' + cardQ.textContent);
    ck('  and the pill is left as a one-word status',
       pill.textContent.length < 20,
       'pill says "' + pill.textContent + '" — long text in a one-line pill is the bug');

    // The answer, same requirement.
    b.w.JarvisVoice.finish();
    await new Promise((r) => setTimeout(r, 10));
    const cardA = b.doc.getElementById('jvCardA');
    ck('the answer goes in the card too', cardA.textContent.indexOf('six hundred') !== -1,
       'got: ' + cardA.textContent);
    ck('  and the pill did not swallow it', b.doc.getElementById('jvText').textContent.length < 20);

    // The CSS has to actually permit wrapping. Text in a container that
    // cannot wrap is still cut off, however complete the string is.
    const styles = Array.from(b.doc.querySelectorAll('style')).map((s) => s.textContent).join('');
    ck('  the card wraps rather than clipping', /#jvCardA\{[^}]*white-space:pre-wrap/.test(styles),
       'nowrap or a fixed height would reintroduce this with the string intact');
    ck('  and breaks long words instead of overflowing',
       /#jvCardA\{[^}]*word-break:break-word/.test(styles));
    ck('  and scrolls when the answer is genuinely long',
       /#jvCard\{[^}]*overflow-y:auto/.test(styles));
}

section('A00 — the desktop app answers in its own voice, and survives it failing');
{
    // Apsara: "why cant this work like siri". Part of the answer was that
    // the browser's speech engine has a ceiling in Electron — Chromium
    // matches macOS voices by NAME, so Premium and Compact "Samantha" are
    // the same voice from JavaScript and the compact one wins. The desktop
    // app therefore brings its own synthesiser (Kokoro) and the page uses
    // it when present.
    //
    // The risk this section exists for is NOT that Kokoro sounds bad. It is
    // that a second speaker, playing through an AudioContext instead of
    // speechSynthesis, breaks the one rule this feature is built on: Jarvis
    // must be silent before the microphone reopens.

    // Re-evaluating voice.js mounts a SECOND copy of every element, and
    // getElementById returns the FIRST — which belongs to the inert first
    // instance, with its own state and its own handlers. Clicks landed on a
    // card that was not the one on screen, and the interrupt tests failed
    // against working code. The previous mount is removed first.
    function remount(b) {
        ['jvStack', 'jarvisVoiceBar', 'jvVoices'].forEach(function (id) {
            const el = b.doc.getElementById(id);
            if (el && el.parentNode) el.parentNode.removeChild(el);
        });
        b.w.__jarvisVoiceLoaded = false;
        b.w.eval(VOICE);
        b.w.document.dispatchEvent(new b.w.Event('DOMContentLoaded'));
    }

    function withKokoro(opts) {
        const b = browser(opts || {});
        const played = [];
        const started = [];
        const stops = [];
        let ended = null;
        b.played = played;
        // A fake AudioContext that records what was played and lets the test
        // decide when it finishes.
        b.w.AudioContext = class {
            constructor() {
                this.destination = {};
                // Born SUSPENDED, exactly like a real one. A harness that
                // reports "running" from the start cannot tell a context
                // that was resumed from one that was never started — which
                // is the whole bug.
                this.state = 'suspended';
                b.w.__ctxState = 'suspended';
                // Was it made during the click? Anything created later can
                // never be started by any browser.
                b.w.__ctxMadeOnClick = !!b.w.__inClick;
            }
            resume() {
                // A REAL BROWSER REFUSES THIS OUTSIDE A GESTURE. My first
                // fake resumed unconditionally, which made the harness
                // useless for the exact bug it was written for: the context
                // came back "running" whether or not a gesture had ever
                // touched it, so a build that could never make a sound
                // looked identical to one that could.
                if (!b.w.__inClick) return Promise.resolve();   // stays suspended
                this.state = 'running';
                b.w.__ctxState = 'running';
                b.w.__resumedByGesture = true;
                return Promise.resolve();
            }
            decodeAudioData() {
                return Promise.resolve({
                    duration: 0.4, sampleRate: 24000,
                    getChannelData: () => new Float32Array(9600),
                });
            }
            createGain() { return { gain: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
            createOscillator() {
                return { type: '', frequency: { setValueAtTime() {} }, connect() {}, start() {}, stop() {} };
            }
            get currentTime() { return 0; }
            createBuffer(ch, len, rate) {
                return { length: len, sampleRate: rate, getChannelData: () => new Float32Array(len) };
            }
            createBufferSource() {
                const node = {
                    buffer: null, onended: null,
                    connect() {}, start() { played.push(node.buffer); ended = node; started.push(node); },
                    // COUNTED, not tracked on one node. `ended` records the
                    // last node STARTED — which is the acknowledgement's,
                    // because it plays after the answer begins. stop() is
                    // called on the node the speech path owns. Watching one
                    // and asserting about the other reported "still playing"
                    // against code that had correctly stopped.
                    stop() { node.stopped = true; stops.push(node); },
                };
                return node;
            }
        };
        b.finishAudio = () => { if (ended && ended.onended) ended.onended(); };
        // "Is anything still playing" = something was started and nothing has
        // been stopped since.
        b.playing = () => started.length > stops.length;
        b.stops = () => stops.length;
        return b;
    }

    // ── the happy path ───────────────────────────────────────────────────
    {
        const b = withKokoro();
        b.w.jarvisTTS = {
            available: true,
            speak: async (t) => ({ ok: true, sampleRate: 24000, pcm: new Float32Array(2400) }),
        };
        // Re-evaluate voice.js so it sees the bridge, exactly as a page
        // loaded inside the desktop app would.
        remount(b);

        b.w.JarvisVoice.dispatch('USER_TOGGLE');
        b.mic().hear('hey jarvis');
        b.mic().hear('what is in inventory');
        b.w.JarvisVoice.finish();
        await new Promise((r) => setTimeout(r, 10));

        ck('the local voice is used, not the browser one', b.played.length === 1,
           'Kokoro is the whole reason the desktop app can sound better than the browser ceiling');
        ck('  and the browser voice stayed out of it', b.log.spoken.length === 0);

        // THE RULE. The mic must not be open while it is talking, and must
        // come back after — and this is a DIFFERENT code path from
        // speechSynthesis, so the old test does not cover it.
        ck('  the microphone is shut while it speaks', !b.mic(),
           'a second speaker that forgets this recreates the self-triggering loop');
        b.finishAudio();
        await new Promise((r) => setTimeout(r, 5));
        ck('  and reopens only when the audio actually ended', !!b.mic(),
           'if onended never dispatches SPEAK_END the mic is shut for ever and voice silently dies');
    }

    // ── it must never leave her in silence ───────────────────────────────
    for (const [label, bridge] of [
        ['the model failed to load', { available: true, speak: async () => ({ ok: false, error: 'model missing' }) }],
        ['it returned no audio', { available: true, speak: async () => ({ ok: true, pcm: new Float32Array(0) }) }],
        ['the call threw', { available: true, speak: async () => { throw new Error('boom'); } }],
    ]) {
        const b = withKokoro();
        b.w.jarvisTTS = bridge;
        remount(b);
        b.w.JarvisVoice.dispatch('USER_TOGGLE');
        b.mic().hear('hey jarvis');
        b.mic().hear('what is in inventory');
        b.w.JarvisVoice.finish();
        await new Promise((r) => setTimeout(r, 10));

        ck(`when ${label}, it falls back to the browser voice`, b.log.spoken.length === 1,
           'a robotic voice is a complaint; silence is a broken feature');
        ck(`  and says why`, b.log.console.some((l) => /local voice/i.test(l)),
           'the silent-failure pattern that cost her the entire afternoon');
        await new Promise((r) => setTimeout(r, 5));
        ck(`  and the microphone comes back`, !!b.mic(),
           'a fallback that forgets SPEAK_END leaves the mic shut for ever');
    }

    // ── IT ANSWERS THE WAKE WORD OUT LOUD ────────────────────────────────
    // Apsara: "When i say Hey Jarvis, it should speak back HMM..
    // acknowldegeing that it is listening."
    //
    // There WAS an acknowledgement here, and it played a base64 WAV with a
    // zero-length data chunk — silence. The intent had been in the code for
    // weeks and the sound never existed, so the only feedback was three grey
    // characters changing in a pill.
    //
    // A mutation deleting playAck() survived the whole suite until this
    // existed, which is the same shape of gap: something that is supposed to
    // happen, that nothing checks happens.
    {
        const b = withKokoro();
        b.w.jarvisTTS = {
            available: true,
            speak: async () => ({ ok: true, sampleRate: 24000, pcm: new Float32Array(9600) }),
        };
        remount(b);
        await new Promise((r) => setTimeout(r, 5));      // warmAck renders it

        // Through the real button, because the fix is about WHICH moment
        // creates the context. dispatch() alone skips the click handler and
        // would prove nothing.
        b.w.__inClick = true;
        b.doc.getElementById('jvToggle').click();
        b.w.__inClick = false;
        const before = b.played.length;
        b.mic().hear('hey jarvis');                       // the wake, nothing more
        await new Promise((r) => setTimeout(r, 5));

        ck('the wake word makes a SOUND', b.played.length === before + 1,
           'the old acknowledgement was a zero-length WAV — the intent was there, the sound was not');

        // ── AND THE CONTEXT IS ACTUALLY RUNNING ──────────────────────────
        // The second reason she heard nothing. An AudioContext is born
        // SUSPENDED and only a user gesture may start it. Every context here
        // was created lazily inside playAck(), triggered by the wake word,
        // which is not a gesture — so it was suspended, and start() on a
        // suspended context throws nothing and plays nothing.
        //
        // A sound object being created is NOT evidence of a sound. This
        // asserts the clock is running.
        ck('  and the audio clock is running, not suspended',
           b.w.__ctxState === 'running',
           'state is "' + b.w.__ctxState + '" — a suspended context plays silently and reports no error');
        // WHO STARTED IT, not when it was constructed. The first version of
        // this asserted the context was created during the click, and that
        // became wrong the moment warmAck() started fetching the
        // acknowledgement at mount — which is legitimate. What a browser
        // actually requires is that a USER GESTURE resumes it; construction
        // can happen whenever.
        ck('  and a USER GESTURE is what started it',
           b.w.__resumedByGesture === true,
           'the wake word is not a gesture — only the click can start the clock');
        ck('  and the microphone stays OPEN while it plays', !!b.mic(),
           'closing the mic to say "go ahead" defeats the entire point of saying it');
        // ── WHERE THE SOUND CAME FROM ────────────────────────────────────
        // Two mutations survived without this. The acknowledgement should be
        // Jarvis's OWN VOICE, fetched once from /api/voice/phrase/ack and
        // cached — not the two-note tone, which is the last resort. Asking
        // only "did a sound play" cannot tell those apart, and the tone is
        // exactly what she complained about twice.
        ck('  it asked the server for the spoken acknowledgement',
           b.w.__ackFetches.some((p) => /\/api\/voice\/phrase\/ack/.test(p)),
           'fetched: ' + JSON.stringify(b.w.__ackFetches)
           + ' — without this it falls back to the tone, which is what she kept hearing');

        ck('  and the card tells her to go ahead',
           /go ahead/i.test(b.doc.getElementById('jvCardA').textContent),
           'got: ' + b.doc.getElementById('jvCardA').textContent);
    }

    // ── SILENCING IT MUST SILENCE *IT*, NOT JUST THE BROWSER ─────────────
    // The dangerous omission. STOP_SPEAKING is the effect that guarantees
    // Jarvis is quiet before the microphone reopens. It used to call only
    // speechSynthesis.cancel(), which does nothing to audio playing through
    // an AudioContext — so Kokoro would carry on talking into a live mic,
    // and hearing its own name in its own reply is the infinite loop
    // voice-machine.js was written to prevent.
    //
    // A mutation removing stopKokoro() survived the whole suite. This is why.
    {
        const b = withKokoro();
        b.w.jarvisTTS = {
            available: true,
            speak: async () => ({ ok: true, sampleRate: 24000, pcm: new Float32Array(24000) }),
        };
        remount(b);

        b.w.JarvisVoice.dispatch('USER_TOGGLE');
        b.mic().hear('hey jarvis');
        b.mic().hear('what is in inventory');
        b.w.JarvisVoice.finish();
        await new Promise((r) => setTimeout(r, 10));
        ck('it is speaking through the local engine', b.playing() === true);

        // She turns voice off mid-answer — or hides the tab, or says
        // something new. Every one of those runs STOP_SPEAKING.
        b.w.JarvisVoice.dispatch('USER_TOGGLE');
        await new Promise((r) => setTimeout(r, 5));
        ck('  turning voice off actually stops the local audio', b.playing() === false,
           'speechSynthesis.cancel() does nothing to an AudioContext — Kokoro would talk into an open mic');
        ck('  and the microphone is not open', !b.mic());
    }

    // USER_DISABLE is a separate branch of the reducer from USER_TOGGLE and
    // reaches the same state by a different route — it is what a permission
    // denial and a programmatic switch-off use. Tested separately because a
    // mutation that broke only this one survived a suite that tested only
    // the toggle.
    {
        const b = withKokoro();
        b.w.jarvisTTS = {
            available: true,
            speak: async () => ({ ok: true, sampleRate: 24000, pcm: new Float32Array(24000) }),
        };
        remount(b);
        b.w.JarvisVoice.dispatch('USER_TOGGLE');
        b.mic().hear('hey jarvis');
        b.mic().hear('what is in inventory');
        b.w.JarvisVoice.finish();
        await new Promise((r) => setTimeout(r, 10));
        ck('  (speaking, via the other branch)', b.playing() === true);
        b.w.JarvisVoice.dispatch('USER_DISABLE');
        await new Promise((r) => setTimeout(r, 5));
        ck('  USER_DISABLE stops it talking too', b.playing() === false,
           'the two ways of switching voice off must not disagree about whether Jarvis shuts up');
    }

    // ── exactly one SPEAK_END, ever ──────────────────────────────────────
    {
        // If BOTH engines report completion — the local one fails after
        // already dispatching, say — the mic reopens twice, and the second
        // reopen can land while audio is still playing.
        const b = withKokoro();
        b.w.jarvisTTS = { available: true, speak: async () => ({ ok: false, error: 'nope' }) };
        remount(b);
        b.w.JarvisVoice.dispatch('USER_TOGGLE');
        b.mic().hear('hey jarvis');
        b.mic().hear('what is in inventory');
        b.w.JarvisVoice.finish();
        await new Promise((r) => setTimeout(r, 15));
        ck('a failed local attempt speaks exactly once, not twice',
           b.log.spoken.length === 1,
           'saying it twice is what a naive fallback does, and it is worse than not speaking');
    }
}

section('A00b — no fetch must not break the voice bar');
{
    // The guard exists because warmAck() runs during MOUNT. An exception
    // there — no fetch, a blocked request, a CSP rule — aborts mount partway
    // and leaves the bar on screen with no click handler attached: a switch
    // that does nothing, in service of a missing sound.
    //
    // Found when this very harness had no fetch and the whole file crashed.
    const b = browser();
    b.w.fetch = undefined;
    b.w.__jarvisVoiceLoaded = false;
    let threw = null;
    try {
        b.w.eval(VOICE);
        b.w.document.dispatchEvent(new b.w.Event('DOMContentLoaded'));
    } catch (e) { threw = e; }

    ck('mounting without fetch does not throw', threw === null,
       threw && threw.message);
    ck('  the switch is still there and still wired',
       !!b.doc.getElementById('jvToggle'),
       'a bar with no handler is worse than no bar — it looks like it works');
    b.doc.getElementById('jvToggle').click();
    ck('  and it still turns voice on', b.w.JarvisVoice.state().enabled === true);
}

section('A0b — Scout has a name, a colour and a voice of its own');
{
    // Apsara, 2026-09-06: "if i call scout, will it create another bubble -
    // in different colour to enquire about yard data" and "when i call Hey
    // scout, a different voice should answer with MMm hmm."
    //
    // Two assistants have sat behind the router for weeks and only ONE had
    // a name she could say. Scout could be reached only by accident — by
    // using words that happened to score as yard vocabulary.
    const b = browser();
    b.doc.getElementById('jvToggle').click();

    b.mic().hear('hey scout');
    ck('"hey scout" wakes it', b.w.JarvisVoice.state().capturing === true,
       'Scout existed and could not be called');
    ck('  and it knows Scout was the one called',
       b.log.console.some((l) => /Scout — listening/.test(l)),
       b.log.console.join(' | '));

    b.mic().hear('how much do we owe acme');
    b.w.JarvisVoice.finish();
    await new Promise((r) => setTimeout(r, 10));
    ck('  the SERVER is told which assistant she called',
       b.log.asked.length > 0 && b.w.__lastAgent === 'scout',
       'sent agent=' + b.w.__lastAgent + ' — otherwise the router guesses from content and can pick the other one');

    // Jarvis is still the default, and naming him wins when both appear.
    const j = browser();
    j.doc.getElementById('jvToggle').click();
    j.mic().hear('hey jarvis');
    ck('"hey jarvis" still wakes Jarvis',
       j.log.console.some((l) => /Jarvis — listening/.test(l)));

    const both = browser();
    both.doc.getElementById('jvToggle').click();
    both.mic().hear('hey jarvis ask scout about the loads');
    ck('  and naming Jarvis wins when both are said',
       both.log.console.some((l) => /Jarvis — listening/.test(l)),
       'addressing one assistant and mentioning the other is not addressing both');

    // ── AND THEY DO NOT SOUND THE SAME ───────────────────────────────────
    // A mutation making both acknowledge in Jarvis's voice survived until
    // this existed — because "a sound played" is not "the RIGHT sound
    // played", and the voice is the whole signal she asked for.
    ck('each assistant fetches its OWN voice',
       b.w.__ackFetches.some((p) => /voice=Charon/.test(p))
       && b.w.__ackFetches.some((p) => /voice=Leda/.test(p)),
       'fetched: ' + JSON.stringify(b.w.__ackFetches));

    // ── WHICH ONE ACTUALLY PLAYED ────────────────────────────────────────
    // Fetching two voices and then playing the same one for both is
    // indistinguishable from correct behaviour unless the audio itself is
    // traceable. Each voice comes back at its own sample rate, so the buffer
    // that reaches the speakers can be attributed.
    const sc = browser();
    sc.doc.getElementById('jvToggle').click();
    await new Promise((r) => setTimeout(r, 10));   // both acknowledgements load
    sc.w.__playedRates = [];
    sc.mic().hear('hey scout');
    await new Promise((r) => setTimeout(r, 10));
    ck('Scout acknowledges in SCOUT\'s voice',
       sc.w.__playedRates.indexOf(22050) !== -1,
       'played at ' + JSON.stringify(sc.w.__playedRates) + ' — 24000 is Jarvis answering for Scout');

    const jv = browser();
    jv.doc.getElementById('jvToggle').click();
    await new Promise((r) => setTimeout(r, 10));
    jv.w.__playedRates = [];
    jv.mic().hear('hey jarvis');
    await new Promise((r) => setTimeout(r, 10));
    ck('  and Jarvis in his', jv.w.__playedRates.indexOf(24000) !== -1,
       'played at ' + JSON.stringify(jv.w.__playedRates));
}

section('A0c — interrupting whoever is talking');
{
    // Apsara, 2026-09-06: "if scout is answering and i want jarvis
    // intervention immediately .. how should i do that."
    //
    // She cannot say it: while either assistant speaks the MICROPHONE IS
    // SHUT, and that is the one rule voice-machine.js exists to enforce. So
    // the interruption is a tap, and what it must do is stop the audio AND
    // reopen the microphone — stopping without listening again would just
    // be a mute button.
    const b = withKokoro();
    b.w.jarvisTTS = {
        available: true,
        speak: async () => ({ ok: true, sampleRate: 24000, pcm: new Float32Array(48000) }),
    };
    remount(b);
    b.doc.getElementById('jvToggle').click();
    b.mic().hear('hey jarvis');
    b.mic().hear('what is in inventory');
    b.w.JarvisVoice.finish();
    await new Promise((r) => setTimeout(r, 10));

    ck('it is speaking', b.w.JarvisVoice.state().speaking === true);
    ck('  and the microphone is shut, as the rule requires', !b.mic(),
       'this is why she cannot simply say the other name');
    ck('  the card says how to interrupt',
       b.doc.getElementById('jvCard').className.indexOf('speaking') !== -1,
       'an escape route nobody is told about is folklore');

    const stopsBefore = b.stops();
    b.doc.getElementById('jvCard').click();
    await new Promise((r) => setTimeout(r, 10));

    // COUNTED ACROSS THE CLICK. "Is anything playing" cannot be answered by
    // watching one node: the acknowledgement starts after the answer does
    // and finishes on its own, so a naive tracker always reports something
    // outstanding. What matters is that the tap CAUSED a stop.
    ck('a tap stops the audio', b.stops() > stopsBefore,
       'stops ' + stopsBefore + ' -> ' + b.stops() + ' — still talking over her is the whole complaint');
    ck('  and the state agrees it is no longer speaking',
       b.w.JarvisVoice.state().speaking === false);
    ck('  AND reopens the microphone', !!b.mic(),
       'stopping without listening again is a mute button, not an interruption');
    ck('  ready for whoever she wants next',
       b.w.JarvisVoice.state().capturing === true,
       'she should not have to say a wake word again to finish the thought she interrupted for');

    // Escape does the same, because her hands are already on the keyboard.
    const k = withKokoro();
    k.w.jarvisTTS = { available: true, speak: async () => ({ ok: true, sampleRate: 24000, pcm: new Float32Array(48000) }) };
    remount(k);
    k.doc.getElementById('jvToggle').click();
    k.mic().hear('hey jarvis');
    k.mic().hear('what is in inventory');
    k.w.JarvisVoice.finish();
    await new Promise((r) => setTimeout(r, 10));
    const kStops = k.stops();
    const esc = new k.w.KeyboardEvent('keydown', { key: 'Escape' });
    k.w.dispatchEvent(esc);
    await new Promise((r) => setTimeout(r, 10));
    ck('Escape interrupts too',
       k.stops() > kStops && k.w.JarvisVoice.state().speaking === false && !!k.mic(),
       'stops ' + kStops + '->' + k.stops() + ' speaking=' + k.w.JarvisVoice.state().speaking
       + ' mic=' + !!k.mic());

    // ── A MISSING VOICE BORROWS THE OTHER ────────────────────────────────
    // A mutation making the fallback point at itself — so a missing
    // acknowledgement produced silence — survived until this existed. Wrong
    // voice is a far smaller problem than no sound, which reads as "it did
    // not hear me" and makes her say it again.
    {
        const f = withKokoro();
        f.w.jarvisTTS = { available: true, speak: async () => ({ ok: false }) };
        // Only Scout's acknowledgement resolves; Jarvis's fails.
        f.w.fetch = async (p) => {
            if (/Charon/.test(p)) throw new Error('500');
            f.w.__ackFetches.push(p);
            return { ok: true, arrayBuffer: async () => ({ __rate: 22050 }) };
        };
        remount(f);
        f.doc.getElementById('jvToggle').click();
        await new Promise((r) => setTimeout(r, 10));
        const before = f.played.length;
        f.mic().hear('hey jarvis');          // the one with NO acknowledgement
        await new Promise((r) => setTimeout(r, 10));
        ck('a missing acknowledgement borrows the other assistant\'s voice',
           f.played.length > before,
           'silence reads as "it did not hear me" and makes her repeat herself');
    }

    // And a tap when it is NOT speaking just dismisses — it must not open a
    // microphone she did not ask for.
    const q = withKokoro();
    remount(q);
    q.doc.getElementById('jvToggle').click();
    const before = q.w.JarvisVoice.state().capturing;
    q.doc.getElementById('jvCard').click();
    ck('a tap while silent does not open a capture',
       q.w.JarvisVoice.state().capturing === before,
       'dismissing a card must not start listening');
}

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
        // The message now NAMES the assistant, because there are two and
        // knowing which one woke is the point.
        ck('  and so is a successful one, naming who woke',
           b2.log.console.some((l) => /Jarvis — listening for your command/.test(l)),
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
    // ── UPDATED: /api/voice/ask, and the reason matters ──────────────────
    // This asserted /api/yard/ask, and the intent behind it was right —
    // spoken and typed questions must go through the same rules, not two
    // paths that drift. But it named the wrong path, and that was the bug.
    //
    // /api/yard/ask is SCOUT, one of two assistants. Scout knows the yard
    // ledger and nothing else. So every spoken question, whatever it was
    // about, reached the assistant that only knows about scrap — and asked
    // what bookings there were from Houston, it correctly said it had no
    // idea, because bookings are Jarvis's subject.
    //
    // /api/voice/ask is the ROUTER over both. It is still ONE path with one
    // set of rules; it is just the right one.
    ck('voice posts to /api/voice/ask, the router over both assistants',
       /\/api\/voice\/ask/.test(nc));
    ck('  and not straight to one of them',
       !/\/api\/yard\/ask/.test(nc),
       'calling Scout directly is what sent every spoken question to the assistant that only knows the yard');
    ck('  it still has no bespoke command path of its own',
       !/\/api\/bot\/command/.test(nc),
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
    ck('  the question reached the assistant', log.asked.length > 0 && /acme/i.test(log.asked[0]),
       'got: ' + JSON.stringify(log.asked[0]));
    // Observed, not grepped. The source check earlier reads the file; this
    // watches where the request actually went when the real flow ran.
    ck('  and it went to the ROUTER, not to one assistant',
       log.paths[0] === '/api/voice/ask',
       'posted to ' + log.paths[0]);
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

    // ── ONE ERROR IS A HICCUP, THREE IS A VERDICT ────────────────────────
    // Apsara, 2026-09-06: "when while on chrome - it shows me Voice needs
    // Google Chrome — this app cannot do speech." In Chrome that message is
    // simply wrong, and it was this latch firing on the FIRST error.
    //
    // Chrome's recogniser is a remote Google service and returns "network"
    // for ordinary transient things — a moment of bad connectivity, a tab
    // waking from sleep. A genuine absence of an engine, which is what
    // Electron has, fails every time and immediately. Repetition is the only
    // thing that separates them.
    mic().onerror({ error: 'network' });
    await new Promise((r) => setTimeout(r, 20));
    ck('ONE network error does not kill it', w.JarvisVoice.state().enabled === true,
       'this fired on the first error and told her to use the browser she was already using');
    ck('  it says it is reconnecting', /reconnect/i.test(w.document.getElementById('jvText').textContent),
       'got: ' + w.document.getElementById('jvText').textContent);
    ck('  and the microphone is reopened', !!mic(),
       'a transient failure must not end the session');

    mic().onerror({ error: 'network' });
    await new Promise((r) => setTimeout(r, 20));
    ck('  two does not either', w.JarvisVoice.state().enabled === true);

    mic().onerror({ error: 'network' });
    await new Promise((r) => setTimeout(r, 20));

    ck('but THREE in a row switches it OFF', w.JarvisVoice.state().enabled === false,
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

    // ── AND A SUCCESS RESETS THE COUNT ───────────────────────────────────
    // Without this the errors accumulate across a whole session: two
    // hiccups this morning, one this afternoon, and the feature latches off
    // hours later for no reason she could connect to anything.
    {
        const c = browser();
        c.w.JarvisVoice.dispatch('USER_TOGGLE');
        c.mic().onerror({ error: 'network' });
        await new Promise((r) => setTimeout(r, 20));
        c.mic().onerror({ error: 'network' });
        await new Promise((r) => setTimeout(r, 20));
        // The engine works again.
        c.mic().hear('hey jarvis');
        await new Promise((r) => setTimeout(r, 5));
        // Two more would latch it if the count had not been cleared.
        c.mic().onerror({ error: 'network' });
        await new Promise((r) => setTimeout(r, 20));
        c.mic().onerror({ error: 'network' });
        await new Promise((r) => setTimeout(r, 20));
        ck('a working result clears the error count',
           c.w.JarvisVoice.state().enabled === true,
           'errors accumulating across a session latch it off hours later, for nothing');
    }

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
    // Was "exposes only speech". A second capability was added deliberately —
    // Kokoro, because the browser's own voice has a hard ceiling in Electron
    // — so the assertion is updated rather than deleted. What it must keep
    // guarding is that the surface stays SMALL and stays about AUDIO: text
    // and samples in and out, and nothing that touches this Mac.
    // THREE bridges now — transcription, synthesis, endpointing — and this
    // assertion caught the third being added, which is exactly its job.
    // Widened deliberately rather than deleted.
    //
    // What it guards is the SHAPE, not a count. Every bridge is the same
    // four verbs: is it there, warm it, do the one thing, how is it doing.
    // Counting methods would creep upward with each capability and mean
    // nothing; counting DISTINCT VERBS stays flat unless something genuinely
    // new is being handed to a remote page.
    const ALLOWED = ['available', 'warm', 'status', 'transcribe', 'speak', 'analyse'];
    ck('the preload bridge exposes audio and nothing else',
       exposed.every((n) => ALLOWED.indexOf(n) !== -1),
       `exposed: ${exposed.join(', ')} — anything outside [${ALLOWED.join(', ')}] is a new door into this machine`);
    const distinct = Array.from(new Set(exposed));
    ck('  and the vocabulary has not grown', distinct.length <= ALLOWED.length,
       `${distinct.length} distinct methods (${distinct.join(', ')}); each is something a compromised server could call`);
    // Audio in, audio or a number out. Nothing here returns anything ABOUT
    // this Mac — no paths, no listings, no arbitrary reads.
    ck('  and every one of them is audio-shaped',
       distinct.every((n) => /^(available|warm|status|transcribe|speak|analyse)$/.test(n)));
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

section('FOLLOW — a question keeps the microphone open');
{
    // Apsara, 2026-09-07: "it is not waiting for follow up. i have to say hey
    // jarvis..then this loop restarts"
    //
    // Jarvis asked "What material?" and then STOPPED LISTENING. She had to
    // say the wake word again to answer a question it had just asked — which
    // is not how anyone talks, and saying "Hey Jarvis" again felt like
    // starting over. A person who asks a question does not need to be
    // addressed by name to hear the answer.
    const b = browser({ reply: (body) => (/material/i.test(body.text || '')
        ? { answer: 'Auto cast it is.', awaiting: false }
        : { answer: 'What material?', awaiting: true }) });
    b.w.eval(MACHINE); b.w.eval(VOICE);
    await new Promise((r) => setTimeout(r, 10));

    b.w.JarvisVoice.dispatch('USER_TOGGLE');
    b.w.JarvisVoice.dispatch('WAKE_HEARD');
    b.mic() && b.mic().hear('hey jarvis send a proforma for autocasting');
    b.w.JarvisVoice.finish();
    await new Promise((r) => setTimeout(r, 30));

    ck('the question was asked', /what material/i.test(b.log.spoken.join(' ')),
       JSON.stringify(b.log.spoken));
    // THE POINT. The pill says Listening again, with no second wake word.
    ck('  and it is listening again straight after',
       /listening|go ahead/i.test(b.doc.getElementById('jvText').textContent),
       'pill says "' + b.doc.getElementById('jvText').textContent + '" — she should not have to say the wake word to answer a question it just asked');
    ck('  it says so in the log',
       b.log.console.some((l) => /listening again without the wake word/i.test(l)),
       'a silent reopen is indistinguishable from a broken one');

    // And she can just answer.
    const before = b.log.asked.length;
    b.mic() && b.mic().hear('auto cast');
    b.w.JarvisVoice.finish();
    await new Promise((r) => setTimeout(r, 30));
    ck('  and her bare answer reaches the server',
       b.log.asked.length === before + 1 && /auto cast/i.test(b.log.asked[before]),
       JSON.stringify(b.log.asked.slice(before)));
    ck('  with no wake word in it',
       !/hey jarvis/i.test(b.log.asked[before] || ''), b.log.asked[before]);
}

section('FOLLOW2 — and it does not hold the microphone open for ever');
{
    // The reopen is ONCE, and silence ends it. An unanswered question that
    // kept reopening would be a microphone that never closes — the exact
    // invariant voice-machine.js exists to protect.
    const b = browser({ reply: () => ({ answer: 'What material?', awaiting: true }) });
    b.w.eval(MACHINE); b.w.eval(VOICE);
    await new Promise((r) => setTimeout(r, 10));
    b.w.JarvisVoice.dispatch('USER_TOGGLE');
    b.w.JarvisVoice.dispatch('WAKE_HEARD');
    b.mic() && b.mic().hear('hey jarvis send a proforma');
    b.w.JarvisVoice.finish();
    await new Promise((r) => setTimeout(r, 30));
    ck('it reopened once', /listening|go ahead/i.test(b.doc.getElementById('jvText').textContent));

    // She says nothing. finishCapture with an empty transcript must stop.
    b.w.JarvisVoice.finish();
    await new Promise((r) => setTimeout(r, 30));
    ck('  and silence ends it rather than looping',
       /say .hey jarvis.|hold to talk/i.test(b.doc.getElementById('jvText').textContent),
       'pill says "' + b.doc.getElementById('jvText').textContent + '"');

    // An ordinary answer with no question in it must NOT reopen.
    const b2 = browser({ reply: () => ({ answer: 'Acme is owed six hundred dollars.', awaiting: false }) });
    b2.w.eval(MACHINE); b2.w.eval(VOICE);
    await new Promise((r) => setTimeout(r, 10));
    b2.w.JarvisVoice.dispatch('USER_TOGGLE');
    b2.w.JarvisVoice.dispatch('WAKE_HEARD');
    b2.mic() && b2.mic().hear('hey jarvis how much do we owe acme');
    b2.w.JarvisVoice.finish();
    await new Promise((r) => setTimeout(r, 30));
    ck('  a plain answer does not reopen the microphone',
       !/listening|go ahead/i.test(b2.doc.getElementById('jvText').textContent),
       'pill says "' + b2.doc.getElementById('jvText').textContent + '" — an open mic after every answer is the self-trigger');
}

section('FOLLOW3 — a question is not a reason to break the invariants');
{
    // voice-machine.js exists to guarantee two things: the microphone is
    // never open while Jarvis is speaking, and NEVER while the app is not in
    // front. An outstanding question does not get to override either — a
    // background tab that starts listening because something asked a question
    // an hour ago is exactly the failure that rule was written for.
    //
    // Nothing covered this: mutating the guard to `true` left all 198
    // assertions green, because every other test in this file runs enabled
    // and in the foreground.
    const hidden = browser({ reply: () => ({ answer: 'What material?', awaiting: true }) });
    hidden.w.eval(MACHINE); hidden.w.eval(VOICE);
    await new Promise((r) => setTimeout(r, 10));
    hidden.w.JarvisVoice.dispatch('USER_TOGGLE');
    hidden.w.JarvisVoice.dispatch('WAKE_HEARD');
    hidden.mic() && hidden.mic().hear('hey jarvis send a proforma');
    hidden.w.JarvisVoice.finish();
    // The tab goes away while Jarvis is still speaking.
    hidden.w.JarvisVoice.dispatch('APP_BACKGROUND');
    await new Promise((r) => setTimeout(r, 30));
    ck('a backgrounded tab does not reopen the microphone',
       !/listening|go ahead/i.test(hidden.doc.getElementById('jvText').textContent),
       'pill says "' + hidden.doc.getElementById('jvText').textContent + '" — invariant 2, never listen unseen');

    const off = browser({ reply: () => ({ answer: 'What material?', awaiting: true }) });
    off.w.eval(MACHINE); off.w.eval(VOICE);
    await new Promise((r) => setTimeout(r, 10));
    off.w.JarvisVoice.dispatch('USER_TOGGLE');
    off.w.JarvisVoice.dispatch('WAKE_HEARD');
    off.mic() && off.mic().hear('hey jarvis send a proforma');
    off.w.JarvisVoice.finish();
    // She switches the assistant off while it is answering.
    off.w.JarvisVoice.dispatch('USER_DISABLE');
    await new Promise((r) => setTimeout(r, 30));
    ck('  nor one she has switched off',
       !/listening|go ahead/i.test(off.doc.getElementById('jvText').textContent),
       'pill says "' + off.doc.getElementById('jvText').textContent + '"');
}

section('ACK — the chime answers the wake word, nothing else');
{
    // Apsara, 2026-09-07: "everytime on follow ups i dont want mm hmm sound.
    // only on hey jarvis."
    //
    // The acknowledgement says "I heard you call me". On a follow-up she is
    // not calling anything — Jarvis asked HER a question and the microphone
    // reopened by itself. Chiming there is the assistant clearing its throat
    // before listening to an answer it asked for.
    const b = browser({ reply: (body) => (/material/i.test(body.text || '')
        ? { answer: 'Auto cast it is.', awaiting: false }
        : { answer: 'What material?', awaiting: true }) });
    b.w.eval(MACHINE); b.w.eval(VOICE);
    await new Promise((r) => setTimeout(r, 15));

    const acksAt = () => b.w.__playedRates.length;
    b.w.JarvisVoice.dispatch('USER_TOGGLE');
    b.w.JarvisVoice.dispatch('WAKE_HEARD');
    const beforeWake = acksAt();
    b.w.JarvisVoice.apply ? null : null;
    b.mic() && b.mic().hear('hey jarvis send a proforma');
    b.w.JarvisVoice.finish();
    await new Promise((r) => setTimeout(r, 40));

    // The follow-up reopen. Nothing new should have been played for it.
    const afterFollowUp = acksAt();
    ck('the follow-up reopen plays no chime', afterFollowUp === beforeWake,
       `${beforeWake} → ${afterFollowUp} — she is answering a question, not calling anyone`);
    ck('  and it is listening anyway',
       /listening|go ahead/i.test(b.doc.getElementById('jvText').textContent),
       b.doc.getElementById('jvText').textContent);

    // The source says which call sites chime.
    // BEHAVIOURAL, not a source grep. My first two assertions here matched
    // the shape of the code I happened to write, and both broke the moment I
    // moved the decision into the OPEN_CAPTURE effect — where it belongs,
    // because that is what actually opens the capture. A test that tracks my
    // implementation rather than her requirement fails on every refactor and
    // proves nothing on any of them.
    const w = browser();
    w.w.eval(MACHINE); w.w.eval(VOICE);
    await new Promise((r) => setTimeout(r, 15));
    w.w.JarvisVoice.dispatch('USER_TOGGLE');
    const beforeCall = w.w.__playedRates.length;
    w.w.JarvisVoice.dispatch('WAKE_HEARD');
    await new Promise((r) => setTimeout(r, 20));
    ck('  the WAKE WORD still chimes', w.w.__playedRates.length > beforeCall,
       `${beforeCall} → ${w.w.__playedRates.length} — the wake word is the one thing the chime exists to answer`);
}

section('CUT — it does not cut her off mid-sentence');
{
    // Apsara, 2026-09-07: "at the end of wavelegth timeout, if i start saying
    // something, it should get appended to the last spken. but it is just
    // getting cut off abruptly."
    //
    // The window was a FIXED eight seconds from the moment capture opened, so
    // a slow or considered sentence was guillotined at the same instant every
    // time whether or not she was still talking.
    ck('the window measures SILENCE, not elapsed time',
       /var SILENCE_MS = \d+/.test(VOICE) && /captureTimer = setTimeout\(finishCapture, SILENCE_MS\)/.test(VOICE),
       'a fixed window cuts a long sentence in half at the same point every time');
    // Matched on the ARMING call inside the capturing branch, not on the
    // assignment next to it — which I keyed off first and which broke the
    // moment the seed prefix changed that line. The behaviour is asserted
    // below anyway; this is the belt.
    ck('  and every word she says restarts it',
       /if \(state\.capturing\) \{[\s\S]{0,600}armCaptureTimers\(\);/.test(VOICE),
       'without this the silence timer is just the old fixed window with a new name');
    ck('  with a hard cap so a stuck recogniser cannot hold the mic open',
       /HARD_CAP_MS/.test(VOICE));
    ck('  and finishing clears BOTH timers',
       /function finishCapture\(\) \{\s*\n[\s\S]{0,400}clearCaptureTimers\(\);/.test(VOICE),
       'leaving the hard cap armed fires finishCapture again 45s later, mid-way through her next sentence');
    ck('  the old fixed CAPTURE_MS window is gone from the arming path',
       !/setTimeout\(finishCapture, CAPTURE_MS\)/.test(VOICE));

    // BEHAVIOURAL: two words a moment apart must not close the capture
    // between them.
    const b = browser();
    b.w.eval(MACHINE); b.w.eval(VOICE);
    await new Promise((r) => setTimeout(r, 15));
    b.w.JarvisVoice.dispatch('USER_TOGGLE');
    b.w.JarvisVoice.dispatch('WAKE_HEARD');
    b.mic() && b.mic().hear('hey jarvis create a proforma for');
    await new Promise((r) => setTimeout(r, 30));
    b.mic() && b.mic().hear('hey jarvis create a proforma for Daekwang, 21 MT of copper at 8450');
    await new Promise((r) => setTimeout(r, 30));
    ck('  a pause mid-sentence does not end the capture',
       b.w.JarvisVoice.state().capturing === true,
       'still capturing? ' + JSON.stringify(b.w.JarvisVoice.state()));
    b.w.JarvisVoice.finish();
    await new Promise((r) => setTimeout(r, 25));
    ck('  and the WHOLE sentence is what gets asked',
       /8450/.test(b.log.asked[b.log.asked.length - 1] || ''),
       JSON.stringify(b.log.asked));
}

section('CUT2 — a sentence she resumes is joined, not restarted');
{
    // The residual case: she pauses to think, the capture closes, and she
    // carries on a second later. What she says next is the tail of the same
    // sentence, not a new request.
    const b = browser();
    b.w.eval(MACHINE); b.w.eval(VOICE);
    await new Promise((r) => setTimeout(r, 15));
    b.w.JarvisVoice.dispatch('USER_TOGGLE');
    b.w.JarvisVoice.dispatch('WAKE_HEARD');
    b.mic() && b.mic().hear('hey jarvis create a proforma for Daekwang');
    b.w.JarvisVoice.finish();                      // the capture closes
    await new Promise((r) => setTimeout(r, 25));
    const firstAsk = b.log.asked.length;

    // She carries straight on, with no wake word.
    b.mic() && b.mic().hear('21 MT of copper at 8450');
    await new Promise((r) => setTimeout(r, 10));
    // A SECOND result after the reopen, which is what a real recogniser
    // delivers. The seed used to be destroyed by exactly this: the handler
    // does `heardDuringCapture = txt`, so the half-sentence survived only
    // while she stayed silent — i.e. never, since she had just resumed.
    b.mic() && b.mic().hear('21 MT of copper at 8450 per MT');
    await new Promise((r) => setTimeout(r, 15));
    ck('the tail reopens the capture rather than being ignored',
       b.w.JarvisVoice.state().capturing === true,
       JSON.stringify(b.w.JarvisVoice.state()));
    ck('  and no chime is played for it',
       /suppressAck = true;\s*\n\s*pendingSeed = joined;/.test(VOICE));
    b.w.JarvisVoice.finish();
    await new Promise((r) => setTimeout(r, 25));
    const joined = b.log.asked[b.log.asked.length - 1] || '';
    ck('  the two halves are asked as ONE sentence',
       /Daekwang/.test(joined) && /8450/.test(joined),
       JSON.stringify(joined) + ' — a fragment with no subject is unanswerable');
    ck('  and it is a new request, not a duplicate of the first',
       b.log.asked.length > firstAsk);

    // A WAKE WORD ALWAYS STARTS FRESH, whatever the timing. Otherwise the
    // previous question is glued to an unrelated new one.
    const c = browser();
    c.w.eval(MACHINE); c.w.eval(VOICE);
    await new Promise((r) => setTimeout(r, 15));
    c.w.JarvisVoice.dispatch('USER_TOGGLE');
    c.w.JarvisVoice.dispatch('WAKE_HEARD');
    c.mic() && c.mic().hear('hey jarvis how much do we owe acme');
    c.w.JarvisVoice.finish();
    await new Promise((r) => setTimeout(r, 25));
    // TWO hears: the first carries the wake word and opens the capture, the
    // second is what the recogniser delivers once capturing — which is how
    // section G2 drives it and how a real recogniser behaves. My first
    // version sent one and then asserted on a question that was never asked.
    c.mic() && c.mic().hear('hey jarvis any bookings from Houston');
    await new Promise((r) => setTimeout(r, 10));
    c.mic() && c.mic().hear('hey jarvis any bookings from Houston');
    await new Promise((r) => setTimeout(r, 15));
    c.w.JarvisVoice.finish();
    await new Promise((r) => setTimeout(r, 25));
    const last = c.log.asked[c.log.asked.length - 1] || '';
    ck('  a fresh "hey jarvis" does NOT inherit the last sentence',
       !/acme/i.test(last), JSON.stringify(last));
}

section('DOC — the document, on screen, before she says yes');
{
    // Apsara, 2026-09-07: "Send it to Daekwang? --> show preview. post my
    // confirmation..send"
    //
    // The server has been putting the rendered proforma in the response as
    // `proforma.html` since the flow was built, and NOTHING IN THE DASHBOARD
    // EVER READ IT. She was approving a document she could only hear
    // described — and the parts most likely to be wrong (the address, the
    // invoice number, the container line) are exactly the parts the spoken
    // sentence does not read out.
    const PAPER = '<html><body><h1>PROFORMA INVOICE</h1><p>260907_AC_26JY90</p>'
        + '<p>Daekwang · 21 MT copper @ 8450</p></body></html>';
    const preview = {
        proforma: { stage: 'preview', ready: true, html: PAPER, inv_no: '260907_AC_26JY90',
            summary: '21 MT of copper for Daekwang', fields: {}, blocked: null,
            recipient: { name: 'Daekwang', email: 'p@daekwang.co.kr' } },
    };

    const b = browser({ reply: () => preview });
    b.w.eval(MACHINE); b.w.eval(VOICE);
    await new Promise((r) => setTimeout(r, 10));
    // Driven through the real capture path, not a private hook — a hook
    // would test a function nothing calls.
    b.w.JarvisVoice.dispatch('USER_TOGGLE');
    b.w.JarvisVoice.dispatch('WAKE_HEARD');
    b.mic() && b.mic().hear('hey jarvis create a proforma for Daekwang, 21 MT of copper at 8450');
    b.w.JarvisVoice.finish();
    await new Promise((r) => setTimeout(r, 25));

    const doc = b.doc.getElementById('jvDoc');
    ck('the document panel exists at all', !!doc,
       'it never did — the server sent html and no one rendered it');
    ck('  and is visible after a preview', doc && !doc.classList.contains('hidden'),
       doc ? doc.className : 'missing');

    const frame = doc && doc.querySelector('iframe');
    ck('  the paper is an iframe', !!frame,
       'the proforma carries its own print stylesheet; inlining it restyles the app around it');
    ck('  carrying the REAL document', frame && frame.getAttribute('srcdoc') === PAPER,
       'a preview of something other than what will be sent is worse than none');
    ck('  sandboxed', frame && frame.getAttribute('sandbox') === '',
       'we generate the html, but the sandbox costs nothing and the alternative is trusting that it stays that way');
    ck('  with the invoice number in the header',
       /260907_AC_26JY90/.test(doc.innerHTML));

    // THE CONFIRMATION. Voice is the primary path and already worked; the
    // buttons exist for when her hands are on the keyboard. They must put the
    // same words through the same endpoint — a button wired to a send route
    // would be a second sender, which is the thing this whole feature was
    // built to avoid.
    const send = b.doc.getElementById('jvdSend');
    const no = b.doc.getElementById('jvdCancel');
    ck('  a Send button is offered', !!send);
    ck('  and a No', !!no);
    const before = b.log.asked.length;
    send && send.dispatchEvent(new b.w.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    ck('  Send says "yes" through the ordinary ask path',
       b.log.asked.length === before + 1 && b.log.asked[before] === 'yes',
       JSON.stringify(b.log.asked.slice(before)));
    ck('    to /api/voice/ask, not a send endpoint',
       b.log.paths[b.log.paths.length - 1] === '/api/voice/ask',
       b.log.paths[b.log.paths.length - 1]);
}

section('DOC2 — it does not offer a send it cannot make');
{
    const b = browser({ reply: () => ({
        proforma: { stage: 'preview', ready: false, blocked: 'unknown',
            html: '<html><body>x</body></html>', inv_no: null, fields: {} },
    }) });
    b.w.eval(MACHINE); b.w.eval(VOICE);
    await new Promise((r) => setTimeout(r, 10));
    b.w.JarvisVoice.dispatch('USER_TOGGLE');
    b.w.JarvisVoice.dispatch('WAKE_HEARD');
    b.mic() && b.mic().hear('hey jarvis create a proforma for Nobody Ltd, 21 MT of copper at 8450');
    b.w.JarvisVoice.finish();
    await new Promise((r) => setTimeout(r, 25));

    const doc = b.doc.getElementById('jvDoc');
    ck('the document still shows', doc && !doc.classList.contains('hidden'),
       'the work is done; only the address is missing, and she should see the document');
    ck('  but there is NO Send button', !b.doc.getElementById('jvdSend'),
       'a Send button on a proforma with no recipient is a button that lies');
    ck('  and it says why', /email address/i.test(doc.innerHTML), doc.innerHTML.slice(0, 200));

    // An "asking" stage has no document yet. Showing a half-built one invites
    // her to approve a blank.
    const b2 = browser({ reply: () => ({
        proforma: { stage: 'asking', ready: false, html: null, fields: {} } }) });
    b2.w.eval(MACHINE); b2.w.eval(VOICE);
    await new Promise((r) => setTimeout(r, 10));
    b2.w.JarvisVoice.dispatch('USER_TOGGLE');
    b2.w.JarvisVoice.dispatch('WAKE_HEARD');
    b2.mic() && b2.mic().hear('hey jarvis create a proforma for Daekwang');
    b2.w.JarvisVoice.finish();
    await new Promise((r) => setTimeout(r, 25));
    const d2 = b2.doc.getElementById('jvDoc');
    ck('  a question stage shows no document', !d2 || d2.classList.contains('hidden'));

    // And an ordinary answer with no proforma at all must clear it, which is
    // what happens the moment the send goes through.
    const seq = [];
    const b3 = browser({ reply: (body) => {
        seq.push(body.text);
        return seq.length === 1
            ? { proforma: { stage: 'preview', ready: true, html: '<html><body>p</body></html>', fields: {} } }
            : {};
    } });
    b3.w.eval(MACHINE); b3.w.eval(VOICE);
    await new Promise((r) => setTimeout(r, 10));
    b3.w.JarvisVoice.dispatch('USER_TOGGLE');
    b3.w.JarvisVoice.dispatch('WAKE_HEARD');
    b3.mic() && b3.mic().hear('hey jarvis create a proforma for Daekwang, 21 MT of copper at 8450');
    b3.w.JarvisVoice.finish();
    await new Promise((r) => setTimeout(r, 25));
    ck('  a preview is up', !b3.doc.getElementById('jvDoc').classList.contains('hidden'));
    b3.w.JarvisVoice.dispatch('WAKE_HEARD');
    b3.mic() && b3.mic().hear('hey jarvis yes');
    b3.w.JarvisVoice.finish();
    await new Promise((r) => setTimeout(r, 25));
    ck('  and it is gone once the send comes back',
       b3.doc.getElementById('jvDoc').classList.contains('hidden'),
       'a document left on screen after it was emailed reads as still waiting');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  Failed:'); failures.forEach((f) => console.log('   - ' + f)); }
process.exit(fail ? 1 : 0);
})();
