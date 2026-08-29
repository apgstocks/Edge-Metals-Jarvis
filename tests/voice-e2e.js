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
            // HER PHONE'S ACTUAL BEHAVIOUR. In v3.5 the wake loop awaited this
            // promise before arming its watchdog; on her device it never
            // resolved, so the loop hung on its very first cycle and the wake
            // word was dead from the moment it started. Her log shows "wake
            // loop STARTED" and then not one result line, ever.
            if (opts.startHangs && o && o.partialResults !== false) {
                return new Promise(() => {});   // never settles
            }
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
            // Record WHAT was asked to be spoken, not just that something was.
            // Without this the harness could see that audio played but not
            // whether it was the right words — and "read the instruction back"
            // is a claim about the words.
            if (u.includes('/api/voice/say') && init && init.body) {
                try { spoken.push({ via: 'server', text: JSON.parse(init.body).text }); } catch (e) {}
            }
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
                    phone.spoken.push({ via: 'played', src: String(src) });
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
    // The app keeps its own log (vlog). Surfacing it on a failure turns "it
    // did not speak" into "here is every step it took", which is the whole
    // reason that log exists on her phone too.
    const logs = () => (dom.window.vlogLines || []).slice(-14).join('\n        ');
    return { dom, win: dom.window, phone, scriptErrors, logs };
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

        ck('  and played it', phone.spoken.some((s) => s.via === 'played'),
           JSON.stringify(phone.spoken));
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
        // The partial arrives missing the name, then the name follows.
        hear(phone, ['hey']);
        await new Promise((r) => setTimeout(r, 50));
        hear(phone, ['hey jarvis']);
        await new Promise((r) => setTimeout(r, 400));
        ck('the full phrase in a later partial wakes it',
           phone.spoken.length > 0,
           'silent — the final result is not being read. started=' + JSON.stringify(phone.started));
        // REVERSED from v3.5. Asking for final results was correct on paper
        // and produced nothing at all on her phone, because start() does not
        // resolve there. Her logs show partials DO carry the whole phrase in
        // practice, so partials it is, with the rolling window covering the
        // case where Android splits them.
        ck('  the wake session uses partials, which her phone actually delivers',
           phone.started.some((o) => o && o.partialResults === true),
           'started with: ' + JSON.stringify(phone.started));
        win.close();
    }

    // ── 3f. A RECOGNISER THAT NEVER RESOLVES ──────────────────────────────
    // The v3.5 hang, from Apsara's log. Nothing downstream of start() may be
    // load-bearing, because on her phone nothing downstream of it ever runs.
    {
        const { win, phone } = await bootApp({ startHangs: true });
        ck('the loop still starts when start() hangs', phone.started.length > 0);
        // Partial events still arrive from the plugin even while the promise
        // is pending — that is how the real one behaves.
        hear(phone, ['jarvis']);
        await new Promise((r) => setTimeout(r, 300));
        ck('HANGING start(): the wake word still works',
           phone.spoken.length > 0,
           'silent — something downstream of start() is load-bearing again');
        win.close();
    }

    // ── 3g. the watchdog is armed BEFORE anything can block ───────────────
    {
        const { win } = await bootApp({ startHangs: true });
        const src = fs.readFileSync(path.join(R, 'mobile-app/www/index.html'), 'utf8');
        // Comments stripped first: the explanation above the code mentions
        // SR.start() by name, and matching that instead of the call made this
        // assertion fail against correct code.
        const fn = /async function wakeCycle\(\)[\s\S]*?\n\}/.exec(src)[0]
            .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
        const armAt = fn.indexOf('armWatchdog()');
        const startAt = fn.indexOf('SR.start(');
        ck('the watchdog is armed before the recogniser is started',
           armAt !== -1 && startAt !== -1 && armAt < startAt,
           'the watchdog sits downstream of the thing it is watching');
        ck('  and start() is not awaited', !/await SR\.start\(/.test(fn));
        win.close();
    }

    // ── 3h. IT ANSWERS WITHOUT BEING TOLD TWICE ───────────────────────────
    // Apsara: '44:53.992 heard [command] ["hey scout",...] --> when i said hey
    // scout, why didnt it talk back?'
    //
    // Because it was waiting for a tap on Send. Correct when every spoken
    // command reached workflow/brain.js, which messages real people. Wrong now
    // that questions reach Scout, which can only read.
    {
        const { win, phone } = await bootApp();
        hear(phone, ['hey scout how much do we owe']);
        await new Promise((r) => setTimeout(r, 500));
        ck('a spoken QUESTION is asked without tapping Send',
           phone.fetched.some((u) => u.includes('/api/voice/ask')),
           'never asked. fetched=' + JSON.stringify(phone.fetched.filter((u) => u.includes('voice'))));
        ck('  and the answer is spoken back',
           phone.spoken.length > 0,
           'nothing spoken: ' + JSON.stringify(phone.spoken));
        win.close();
    }

    // ── 3i-a. AN INSTRUCTION IS READ BACK AND CONFIRMED BY VOICE ──────────
    // Apsara: "just get voice confirmation".
    //
    // Auto-sending everything is fast and hands-free, and lets a mistranscribed
    // "message the trucker" reach a real person. A TAP removes the risk and the
    // point both. Spoken confirmation keeps her hands free AND puts the exact
    // words in front of her before anything happens.
    {
        const { win, phone, logs, scriptErrors } = await bootApp();
        hear(phone, ['hey jarvis message the trucker we are running late']);
        await new Promise((r) => setTimeout(r, 500));
        ck('an instruction is NOT sent immediately',
           !phone.fetched.some((u) => u.includes('/api/voice/ask')),
           'it sent without confirming: ' + JSON.stringify(phone.fetched.filter((u) => u.includes('voice'))));
        ck('  it is read back out loud instead',
           phone.spoken.some((x) => /Shall I/i.test(x.text || '')),
           'nothing read back: ' + JSON.stringify(phone.spoken)
             + '\n        errors: ' + JSON.stringify(scriptErrors)
             + '\n        ' + logs());

        // She says yes.
        hear(phone, ['yes']);
        await new Promise((r) => setTimeout(r, 500));
        ck('  saying YES sends it',
           phone.fetched.some((u) => u.includes('/api/voice/ask')),
           'still not sent: ' + JSON.stringify(phone.fetched.filter((u) => u.includes('voice')))
             + '\n        ' + logs());
        win.close();
    }

    // ── 3i-b. saying no cancels it ────────────────────────────────────────
    {
        const { win, phone } = await bootApp();
        hear(phone, ['hey jarvis message the trucker we are running late']);
        await new Promise((r) => setTimeout(r, 400));
        hear(phone, ['no']);
        await new Promise((r) => setTimeout(r, 400));
        ck('saying NO cancels the instruction',
           !phone.fetched.some((u) => u.includes('/api/voice/ask')),
           'it sent anyway: ' + JSON.stringify(phone.fetched.filter((u) => u.includes('voice'))));
        ck('  and says so', phone.spoken.some((x) => /Cancelled/i.test(x.text || '')));
        win.close();
    }

    // ── 3i-c. anything unclear is treated as NO ───────────────────────────
    // The asymmetry that matters: a misheard "yes" sends a real message to a
    // real person; a misheard "no" costs her saying it again.
    {
        for (const reply of ['what', 'hmm', 'the truck is here', 'yesterday']) {
            const { win, phone } = await bootApp();
            hear(phone, ['hey jarvis email joey about the container']);
            await new Promise((r) => setTimeout(r, 400));
            hear(phone, [reply]);
            await new Promise((r) => setTimeout(r, 400));
            ck(`"${reply}" is not a yes, so nothing is sent`,
               !phone.fetched.some((u) => u.includes('/api/voice/ask')),
               'it sent on an unclear reply');
            win.close();
        }
    }

    // ── 3i-d. a QUESTION is never made to confirm ─────────────────────────
    {
        const { win, phone } = await bootApp();
        hear(phone, ['hey scout how much do we owe']);
        await new Promise((r) => setTimeout(r, 450));
        ck('a question is answered without a "Shall I?"',
           phone.fetched.some((u) => u.includes('/api/voice/ask'))
             && !phone.spoken.some((x) => /Shall I/i.test(x.text || '')),
           'spoken=' + JSON.stringify(phone.spoken));
        win.close();
    }

    // ── 3i. an INSTRUCTION is sent too, and answered aloud ────────────────
    // REVERSED from the previous commit at Apsara's explicit instruction:
    // asked whether to auto-send questions only or everything, she chose
    // "Auto-send everything, no exceptions", and then "why cant message be
    // heard and talk back by jarvis/scout".
    //
    // The trade-off was stated before she chose it: an instruction reaches
    // workflow/brain.js, which messages real people, so a mistranscription can
    // send a real message with no moment to catch it. Her call, made knowingly,
    // for someone working with their hands full.
    {
        const { win, phone } = await bootApp();
        hear(phone, ['hey jarvis message the trucker we are running late']);
        await new Promise((r) => setTimeout(r, 400));
        hear(phone, ['yes']);
        await new Promise((r) => setTimeout(r, 400));
        ck('a spoken INSTRUCTION is sent once confirmed, with no tap anywhere',
           phone.fetched.some((u) => u.includes('/api/voice/ask')),
           'not sent: ' + JSON.stringify(phone.fetched.filter((u) => u.includes('voice'))));
        ck('  and its reply is spoken back too',
           phone.spoken.length > 0,
           'nothing spoken: ' + JSON.stringify(phone.spoken));
        win.close();
    }

    // ── 3j. EVERYTHING is heard and answered aloud ────────────────────────
    // Her question, verbatim: "why cant message be heard and talk back by
    // jarvis/scout". Whatever she says, whoever answers, she hears it.
    {
        for (const said of [
            'hey scout how much do we owe',
            'hey jarvis check my inbox',
            'hey scout is edge 3 paid',
            'hey jarvis book a pickup for tomorrow',
        ]) {
            const { win, phone } = await bootApp();
            hear(phone, [said]);
            await new Promise((r) => setTimeout(r, 400));
            // Instructions are read back first; a yes carries them through.
            if (!/how much|is edge/.test(said)) { hear(phone, ['yes']); await new Promise((r) => setTimeout(r, 400)); }
            ck(`"${said}" is sent AND spoken back`,
               phone.fetched.some((u) => u.includes('/api/voice/ask')) && phone.spoken.length > 0,
               'sent=' + phone.fetched.some((u) => u.includes('/api/voice/ask'))
                 + ' spoken=' + JSON.stringify(phone.spoken));
            win.close();
        }
    }

    // ── 3k. HER PHONE NEVER FIRES listeningState ──────────────────────────
    // Log, 2026-08-29:
    //
    //   18:17.396  heard [command]  ["hey"]
    //   18:17.399  heard [command]  ["hey","he","hey scout","hey SCO"]
    //   ...and nothing.
    //
    // It heard her perfectly. What never came was the listeningState 'stopped'
    // event that the whole command path hung off — and her logs have never once
    // shown that event on this device. Completion now falls out of the partials
    // themselves. The fake below emits partials and NOTHING else, which is what
    // her phone does.
    {
        const { win, phone, logs } = await bootApp();
        // Tap the mic, then speak. No listeningState is ever fired.
        win.document.getElementById('btnVoice').dispatchEvent(new win.Event('click'));
        await new Promise((r) => setTimeout(r, 150));
        hear(phone, ['hey']);
        hear(phone, ['hey scout how much do we owe', 'he scout how much do we owe']);
        // Longer than the 1.2s debounce.
        await new Promise((r) => setTimeout(r, 1800));
        ck('a command completes with NO listeningState event',
           phone.fetched.some((u) => u.includes('/api/voice/ask')),
           'never sent: ' + JSON.stringify(phone.fetched.filter((u) => u.includes('voice')))
             + '\n        ' + logs());
        ck('  and the answer is spoken', phone.spoken.length > 0);
        win.close();
    }

    // ── 3l. it does not fire twice ────────────────────────────────────────
    // The debounce and the listeningState event both complete a command. Only
    // the first may act, or a question is asked — and an instruction sent —
    // twice.
    {
        const { win, phone } = await bootApp();
        win.document.getElementById('btnVoice').dispatchEvent(new win.Event('click'));
        await new Promise((r) => setTimeout(r, 150));
        hear(phone, ['how much do we owe']);
        await new Promise((r) => setTimeout(r, 1500));
        // Now the event arrives late, as it might on another device.
        (phone.events.listeningState || []).forEach((f) => f({ status: 'stopped' }));
        await new Promise((r) => setTimeout(r, 400));
        const asks = phone.fetched.filter((u) => u.includes('/api/voice/ask')).length;
        ck('a command is sent exactly once, not twice', asks === 1,
           'sent ' + asks + ' times');
        win.close();
    }

    // ── 3m. "ONLY HEY DETECTED MOST OF THE TIMES" ─────────────────────────
    // Her log, v4.0:
    //
    //   28:33.417  heard [command]  ["hey"]
    //   28:33.639  command finished (recogniser stopped)  hey
    //   28:33.748  heard [command]  ["hey scout","he scout", ...]
    //
    // listeningState fires 222ms after the first partial and the real words
    // arrive 109ms AFTER that. Finishing on the event finishes with "hey",
    // every time, and throws the name away.
    {
        const { win, phone, logs } = await bootApp();
        win.document.getElementById('btnVoice').dispatchEvent(new win.Event('click'));
        await new Promise((r) => setTimeout(r, 150));

        hear(phone, ['hey']);
        // The event says "stopped" while the recogniser is still transcribing.
        (phone.events.listeningState || []).forEach((f) => f({ status: 'stopped' }));
        await new Promise((r) => setTimeout(r, 110));
        // ...and THEN the actual words land, exactly as on her phone.
        hear(phone, ['hey scout how much do we owe', 'he scout how much do we owe']);
        await new Promise((r) => setTimeout(r, 1400));

        const asked = phone.fetched.some((u) => u.includes('/api/voice/ask'));
        ck('a late transcript is NOT thrown away as just "hey"', asked,
           'nothing asked\n        ' + logs());
        // And what was sent must be the WHOLE thing, not the fragment.
        const said = phone.spoken.map((x) => x.text || '').join(' ');
        ck('  and it did not ask "hey. Shall I?"', !/^hey\. Shall I/.test(said),
           'spoken: ' + JSON.stringify(phone.spoken));
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
