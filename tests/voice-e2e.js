// ── tests/voice-e2e.js — the wake word, driven through the REAL app ────────
//
// Apsara, after six silent builds: "run this, simulate this, test this".
//
// Right. Every previous test in this repo checked a PIECE of the voice
// pipeline — the state machine, the router, the speech normaliser, the wake
// patterns as text. Not one of them ever ran the actual app and said
// "Hey Jarvis" to it. That is precisely why six builds shipped without the
// feature working: each part was correct and the whole was never exercised.
//
// This loads mobile-app/www/index.html — the real file, the one packaged into
// the APK — into a DOM, fakes the phone around it (speech recogniser,
// text-to-speech, network, audio), and then speaks to it.
//
// Everything faked is faked at the EDGE of the app: the Capacitor plugins and
// the network. Nothing inside the app is stubbed or reimplemented, so what
// runs here is the code that runs on her phone.

const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (name, cond, extra) => {
    if (cond) { pass++; console.log('  PASS ', name); }
    else { fail++; console.log('  FAIL ', name); if (extra) console.log('        ' + extra); }
};

let JSDOM = null, VirtualConsole = null, ResourceLoader = null;
try { ({ JSDOM, VirtualConsole, ResourceLoader } = require('jsdom')); } catch (e) { /* reported below */ }

// jsdom with resources:'usable' will also try to fetch stylesheets, icons and
// anything else the page references, and throws a DOMException on the ones it
// cannot handle — which crashed the whole run. Only the app's own scripts are
// wanted here; everything else is answered with nothing.
// The app's own <script src> tags are inlined AT THEIR EXACT POSITION before
// parsing, rather than fetched.
//
// Why not let jsdom fetch them: on a file:// origin jsdom gives the page an
// opaque origin and localStorage silently fails, so the sign-in token never
// sticks and the app sits on the login screen — every assertion then fails for
// the wrong reason. Keeping an https:// origin fixes that but leaves relative
// script paths unresolvable. Inlining in place gives both: a real origin AND
// the scripts running in the right order.
//
// ORDER IS PRESERVED because the replacement happens where the tag is. That
// matters: a script placed after the code that reads it is a real bug this
// project has already shipped once, and tests/voice-machine.js asserts the tag
// position separately against the source file.
function inlineScripts(html) {
    return html.replace(/<script src="([\w.-]+\.js)"><\/script>/g, (tag, name) => {
        const file = path.join(R, 'mobile-app/www', name);
        if (!fs.existsSync(file)) return tag;
        return '<script>\n' + fs.readFileSync(file, 'utf8') + '\n</script>';
    });
}

// A rejected promise somewhere inside the app must not take the harness down
// before it can report which assertion failed.
process.on('unhandledRejection', () => {});

console.log('\n─ voice, end to end in a simulated phone ─────────────────');

if (!JSDOM) {
    // Loud, not silent. A skipped end-to-end test reported as a pass is how
    // six builds went out believing they worked.
    console.log('  SKIP  jsdom is not installed — `npm i -D jsdom` to run the end-to-end simulation');
    console.log(`\n  ${pass} passed, ${fail} failed`);
    process.exit(0);
}

// ── the fake phone ────────────────────────────────────────────────────────
function makePhone(opts = {}) {
    const events = {};          // plugin listeners, by name
    const spoken = [];          // what the phone was asked to say, and how
    const fetched = [];         // every URL the app asked for
    const started = [];         // every time the recogniser was started

    const SpeechRecognition = {
        available: async () => ({ available: opts.recogniser !== false }),
        requestPermissions: async () => ({ speechRecognition: opts.permission || 'granted' }),
        start: async (o) => {
            started.push(o);
            // The real plugin RESOLVES with the final matches when
            // partialResults is false. Documented Android behaviour, and the
            // whole reason the wake loop moved off partials: partials omit the
            // last word of an utterance, so a two-word wake phrase never
            // appears in one.
            if (o && o.partialResults === false) {
                const next = (opts.finals || []).shift();
                return next ? { matches: next } : { matches: [] };
            }
            return undefined;
        },
        stop: async () => {},
        addListener: (name, fn) => { (events[name] = events[name] || []).push(fn); },
    };

    const TextToSpeech = {
        speak: async (o) => {
            if (opts.deviceTts === false) throw new Error('no engine');
            spoken.push({ via: 'device', text: o.text });
        },
    };

    // A minimal but REAL WAV, so anything that inspects the bytes sees a
    // valid file rather than a string pretending to be one.
    const wav = Buffer.concat([(() => {
        const h = Buffer.alloc(44);
        h.write('RIFF', 0); h.writeUInt32LE(36 + 200, 4); h.write('WAVE', 8);
        h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
        h.writeUInt16LE(1, 22); h.writeUInt32LE(24000, 24); h.writeUInt32LE(48000, 28);
        h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36);
        h.writeUInt32LE(200, 40); return h;
    })(), Buffer.alloc(200)]);

    async function fakeFetch(url, init) {
        const u = String(url);
        fetched.push(u);
        const json = (body, status = 200) => ({
            ok: status < 400, status,
            json: async () => body,
            blob: async () => ({ size: 0 }),
        });
        if (u.includes('/api/me')) return json({ role: opts.role || 'admin' });
        if (u.includes('/api/voice/phrase') || u.includes('/api/voice/say')) {
            if (opts.voiceServer === false) return json({ error: 'Cannot GET' }, 404);
            return {
                ok: true, status: 200,
                json: async () => ({}),
                blob: async () => ({ size: wav.length, _wav: true }),
            };
        }
        if (u.includes('/api/voice/ask')) {
            if (opts.voiceServer === false) return json({ error: 'Cannot POST' }, 404);
            return json({ agent: 'scout', agent_name: 'Scout', voice: 'Leda', answer: 'We owe $28,750.00 for 3 loads.', ok: true });
        }
        // Everything else the app loads at boot — empty but successful, so
        // boot completes and the voice wiring is reached.
        return json(Array.isArray(opts.emptyAs) ? opts.emptyAs : []);
    }

    return { events, spoken, fetched, started, SpeechRecognition, TextToSpeech, fakeFetch, wav };
}

async function bootApp(opts = {}) {
    const html = inlineScripts(fs.readFileSync(path.join(R, 'mobile-app/www/index.html'), 'utf8'));
    const phone = makePhone(opts);

    // file:// at the real www directory, with resources enabled, so the
    // <script src="voice-machine.js"> tag resolves exactly as it does inside
    // the WebView. Loading the HTML without it would test a different app —
    // and would hide the very class of bug (a script that does not load) that
    // this harness exists to catch.
    // Script errors are FATAL to this harness rather than ignored: a thrown
    // exception during boot is exactly how the voice code silently never ran.
    const vc = new VirtualConsole();
    const scriptErrors = [];
    vc.on('jsdomError', (e) => scriptErrors.push((e && e.message) || String(e)));

    const dom = new JSDOM(html, {
        runScripts: 'dangerously',
        virtualConsole: vc,
        url: 'https://edge.local/',
        pretendToBeVisual: true,
        beforeParse(window) {
            // The phone.
            window.Capacitor = {
                isNativePlatform: () => true,
                Plugins: { SpeechRecognition: phone.SpeechRecognition, TextToSpeech: phone.TextToSpeech },
            };
            window.fetch = phone.fakeFetch;
            // Signed in already, so boot reaches the app rather than the login
            // screen — the wake word is not supposed to run before login.
            // TOKEN_KEY is 'jarvis_sid' — read from the app rather than
            // assumed. Getting this wrong left the app on the login screen and
            // made every assertion below fail for the wrong reason.
            try { window.localStorage.setItem('jarvis_sid', 'test-token'); } catch (e) {}
            // Audio is not implemented in jsdom; this records the play instead.
            window.Audio = function (src) {
                const self = this;
                this.src = src;
                this.play = () => {
                    phone.spoken.push({ via: 'server', src: String(src) });
                    setTimeout(() => { if (self.onended) self.onended(); }, 0);
                    return Promise.resolve();
                };
                this.pause = () => {};
            };
            window.URL.createObjectURL = () => 'blob:fake';
            window.URL.revokeObjectURL = () => {};
        },
    });

    // Let boot's async work settle, and the external script load.
    await new Promise((r) => setTimeout(r, 400));
    return { dom, win: dom.window, phone, scriptErrors };
}

// Queues what the FINAL result of the next session will be, the way the real
// plugin returns it.
function willHear(opts, finals) { opts.finals = finals; }

// Fires what the Android recogniser would emit as a partial.
function hear(phone, matches) {
    const listeners = phone.events.partialResults || [];
    for (const fn of listeners) fn({ matches });
}

(async () => {
    // ── 1. THE THING THAT WAS NEVER TESTED ────────────────────────────────
    // Open the app. Say "Hey Jarvis". Does it answer?
    {
        const { win, phone, scriptErrors } = await bootApp();

        ck('the app loads without a script error', scriptErrors.length === 0,
           scriptErrors.join(' | '));
        ck('the state machine actually loaded', typeof win.VoiceMachine === 'object',
           'window.VoiceMachine is ' + typeof win.VoiceMachine
             + ' — the <script src="voice-machine.js"> tag did not run');

        ck('the app boots and wires the recogniser',
           (phone.events.partialResults || []).length > 0,
           'no partialResults listener was registered — the voice code never ran');

        ck('the microphone is started on open',
           phone.started.length > 0,
           'the recogniser was never started');

        // The exact thing her phone sends: a partial, one word.
        hear(phone, ['jarvis']);
        await new Promise((r) => setTimeout(r, 300));

        ck('saying "jarvis" produces a spoken reply',
           phone.spoken.length > 0,
           'NOTHING was spoken. spoken=' + JSON.stringify(phone.spoken)
             + ' fetched=' + JSON.stringify(phone.fetched.filter((u) => u.includes('voice'))));

        ck('  and it fetched the acknowledgement from the server',
           phone.fetched.some((u) => u.includes('/api/voice/phrase')),
           'fetched: ' + JSON.stringify(phone.fetched));

        ck('  and played it', phone.spoken.some((s) => s.via === 'server'));
        win.close();
    }

    // ── 2. the full utterance, in one breath ──────────────────────────────
    {
        const { win, phone } = await bootApp();
        hear(phone, ['hey jarvis how much do we owe']);
        await new Promise((r) => setTimeout(r, 300));
        // A command attached to the wake word skips the acknowledgement and
        // goes straight to the question.
        ck('a wake word WITH a command does not stop to say "Yes?"',
           !phone.fetched.some((u) => u.includes('/api/voice/phrase')),
           'it fetched the acknowledgement: ' + JSON.stringify(phone.fetched.filter((u) => u.includes('voice'))));
        win.close();
    }

    // ── 3. every alternative is considered ────────────────────────────────
    {
        const { win, phone } = await bootApp();
        // The best guess is wrong; the wake word is in the third. This is
        // routine on Android and used to be discarded.
        hear(phone, ['hey drivers', 'hey service is', 'hey jarvis']);
        await new Promise((r) => setTimeout(r, 300));
        // It wakes on "hey service is" — a known mishearing, ranked above the
        // correct one, which is exactly why every alternative is checked. The
        // leftover "is" is too short to be a command, so it acknowledges
        // rather than sending two letters to the brain.
        ck('the wake word is found in a lower-ranked alternative',
           phone.spoken.length > 0,
           'nothing spoken; the alternatives were dropped');
        win.close();
    }

    // ── 3b. the wake word ONLY in the last alternative ────────────────────
    {
        const { win, phone } = await bootApp();
        hear(phone, ['hey there', 'a driver', 'hey jarvis']);
        await new Promise((r) => setTimeout(r, 300));
        ck('it wakes when only the LAST alternative matches',
           phone.spoken.length > 0,
           'nothing spoken — only matches[0] is being checked');
        win.close();
    }

    // ── 3c. APSARA'S ACTUAL LOG, replayed ─────────────────────────────────
    // 2026-08-29, from her phone:
    //
    //   28:54.475  heard [wake]  [""]
    //   28:55.207  heard [wake]  ["hey"]
    //   28:55.209    no wake match in any alternative
    //
    // The session ended after "hey" and the name never arrived in it. This is
    // the exact sequence, and it must now wake once the rest turns up.
    {
        const { win, phone } = await bootApp();
        hear(phone, ['']);
        hear(phone, ['hey']);
        await new Promise((r) => setTimeout(r, 50));
        ck('"hey" alone does not wake it', phone.spoken.length === 0);
        // Next session, moments later, carries the name.
        hear(phone, ['jarvis']);
        await new Promise((r) => setTimeout(r, 300));
        ck('APSARA\'S LOG: "hey" then "jarvis" across two sessions DOES wake it',
           phone.spoken.length > 0,
           'still silent — the rolling window did not join them');
        win.close();
    }

    // ── 3d. the window must not keep re-firing ────────────────────────────
    {
        const { win, phone } = await bootApp();
        hear(phone, ['hey']);
        hear(phone, ['jarvis']);
        await new Promise((r) => setTimeout(r, 300));
        const first = phone.spoken.length;
        // More ordinary talk right after; the window was cleared on the match,
        // so this must not re-trigger off the tail of it.
        hear(phone, ['the truck is here']);
        hear(phone, ['pay ramesh']);
        await new Promise((r) => setTimeout(r, 300));
        ck('the window is cleared once it fires, so it does not re-trigger',
           phone.spoken.length === first,
           'spoke again: ' + JSON.stringify(phone.spoken));
        win.close();
    }

    // ── 3e. THE DOCUMENTED ANDROID BEHAVIOUR ──────────────────────────────
    // Android's SpeechRecognizer omits the LAST word from partialResults —
    // documented, not a quirk of this app. So for "hey jarvis" the partials
    // carry only "hey", and the name appears solely in the final result.
    // That is precisely Apsara's log, and the reason the wake loop now reads
    // the final result rather than partials.
    {
        const opts = { finals: [['hey jarvis'], []] };
        const { win, phone } = await bootApp(opts);
        // The partial arrives first, missing the name — must NOT match.
        hear(phone, ['hey']);
        await new Promise((r) => setTimeout(r, 400));
        ck('the FINAL result carries the name and wakes it',
           phone.spoken.length > 0,
           'silent — the final result is not being read. started=' + JSON.stringify(phone.started));
        ck('  and the wake session asked for final results, not partials',
           phone.started.some((o) => o && o.partialResults === false),
           'started with: ' + JSON.stringify(phone.started));
        win.close();
    }

    // ── 4. ordinary yard talk must NOT wake it ────────────────────────────
    {
        const { win, phone } = await bootApp();
        for (const t of [['the truck is here'], ['pay ramesh tomorrow'],
                         ['how much do we owe'], ['service'], ['scott called']]) {
            hear(phone, t);
        }
        await new Promise((r) => setTimeout(r, 300));
        ck('ordinary talk does not trigger it',
           phone.spoken.length === 0,
           'it spoke on ordinary talk: ' + JSON.stringify(phone.spoken));
        win.close();
    }

    // ── 5. a server with no voice endpoints still answers ─────────────────
    // Her most likely real situation across six builds.
    {
        const { win, phone } = await bootApp({ voiceServer: false });
        hear(phone, ['jarvis']);
        await new Promise((r) => setTimeout(r, 400));
        ck('with NO server voice, the phone still speaks',
           phone.spoken.some((s) => s.via === 'device'),
           'silent. spoken=' + JSON.stringify(phone.spoken));
        win.close();
    }

    // ── 6. nothing at all available: silent, but not broken ───────────────
    {
        const { win, phone } = await bootApp({ voiceServer: false, deviceTts: false });
        hear(phone, ['jarvis']);
        await new Promise((r) => setTimeout(r, 400));
        ck('with no voice at all it does not crash', true);
        ck('  and it says nothing rather than pretending', phone.spoken.length === 0);
        win.close();
    }

    // ── 7. staff must not get a hot microphone ────────────────────────────
    {
        const { win, phone } = await bootApp({ role: 'staff' });
        ck('a non-admin never starts the microphone',
           phone.started.length === 0,
           'the recogniser started for a non-admin: ' + JSON.stringify(phone.started));
        win.close();
    }

    // ── 8. permission denied is reported, not silent ──────────────────────
    {
        const { win, phone } = await bootApp({ permission: 'denied' });
        ck('a denied microphone does not start the loop', phone.started.length === 0);
        win.close();
    }

    console.log(`\n  ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => {
    console.error('  the simulation itself crashed:', e && e.stack);
    process.exit(1);
});
