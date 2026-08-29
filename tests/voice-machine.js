// ── tests/voice-machine.js — the microphone rule, tested exhaustively ──────
//
// Apsara, 2026-08-29: "Test end to end. find some proper testing research
// paper and tools. find the best tester to test this. act like that tester."
//
// ── the method, and why this one ──────────────────────────────────────────
// The thing under test is a STATEFUL system whose bug only appears in certain
// ORDERINGS of events: speak while listening, background mid-sentence, wake
// word arriving a beat after the mic was told to close. Example-based tests
// are close to useless here, because the dangerous orderings are exactly the
// ones nobody thinks to write down.
//
// The established technique for this is stateful property-based testing, also
// called model-based testing: describe the system as a finite state machine,
// generate random sequences of events, and after EVERY step assert properties
// that must hold in every reachable state. That is the approach in the
// property-based testing literature (Hughes' QuickCheck state machines, and
// the more recent work fusing property-oriented and model-based testing over
// symbolic finite state machines), and it is what fast-check implements for
// JavaScript.
//
// This file does three things, in increasing strength:
//
//   1. EXHAUSTIVE search over every event sequence up to length 7. The state
//      space is small enough that "every possible ordering" is literally
//      checkable rather than sampled — the strongest guarantee available.
//   2. PROPERTY-BASED search with fast-check over long random sequences, to
//      reach deeper interleavings than exhaustion can afford.
//   3. TARGETED scenarios for the specific failures that motivated the work,
//      written out by hand so they are readable as requirements.
//
// The invariants are stated once, in INVARIANTS below, and enforced by all
// three. They are the actual specification of this feature.

const path = require('path');
const fs = require('fs');

const R = path.join(__dirname, '..');
const VM = require(path.join(R, 'mobile-app', 'www', 'voice-machine.js'));

let pass = 0, fail = 0;
const ck = (name, cond) => { if (cond) { pass++; console.log('  PASS ', name); } else { fail++; console.log('  FAIL ', name); } };

console.log('\n─ the microphone rule ────────────────────────────────────');

// ── THE SPECIFICATION ─────────────────────────────────────────────────────
// Each returns null when it holds, or a sentence describing the violation.
const INVARIANTS = [
    {
        name: 'the mic is never open while Jarvis or Scout is speaking',
        why: 'this is the self-trigger: the phone hears its own reply, finds its own name in it, and re-fires forever',
        check: (s) => (VM.micShouldBeOpen(s) && s.speaking) ? 'mic open while speaking' : null,
    },
    {
        name: 'the mic is never open while the app is in the background',
        why: 'a microphone that runs unseen is a privacy problem, not a feature',
        check: (s) => (VM.micShouldBeOpen(s) && !s.foreground) ? 'mic open in the background' : null,
    },
    {
        name: 'the mic is only ever open because the user asked for it',
        why: 'either the wake loop is switched on, or a capture is in progress. There is no third reason',
        check: (s) => (VM.micShouldBeOpen(s) && !s.enabled && !s.capturing) ? 'mic open with nothing asking for it' : null,
    },
    {
        name: 'a capture never starts while speaking',
        why: 'a partial result queued before the mic closed can still land; if it opened a capture, that IS the loop',
        check: (s) => (s.capturing && s.speaking) ? 'capture running while speaking' : null,
    },
];

function violations(state) {
    return INVARIANTS.map((i) => (i.check(state) ? `${i.name} — ${i.check(state)}` : null)).filter(Boolean);
}

// ── 1. EXHAUSTIVE: every event sequence up to length 7 ────────────────────
{
    const EV = VM.EVENTS;
    let checked = 0;
    let firstFailure = null;

    function walk(state, depth, trail) {
        if (firstFailure) return;
        const v = violations(state);
        if (v.length) { firstFailure = { trail, v }; return; }
        checked += 1;
        if (depth === 0) return;
        for (const e of EV) {
            const r = VM.reduce(state, e);
            walk(r.state, depth - 1, trail.concat(e));
        }
    }

    // From BOTH plausible starting points — freshly installed, and with the
    // wake word already switched on from a previous session.
    for (const start of [VM.initial(), VM.initial({ enabled: true })]) {
        walk(start, 7, []);
    }

    ck(`every event sequence up to length 7 holds the invariants (${checked.toLocaleString()} states)`, !firstFailure);
    if (firstFailure) {
        console.log('        counterexample: ' + firstFailure.trail.join(' -> '));
        firstFailure.v.forEach((x) => console.log('        ' + x));
    }
}

// ── 2. PROPERTY-BASED: long random sequences ──────────────────────────────
{
    let fc = null;
    try { fc = require('fast-check'); } catch (e) { /* optional */ }

    if (!fc) {
        // Not a silent skip. If the tool is missing the suite says so, rather
        // than quietly reporting a green run with a third of it not executed.
        console.log('  SKIP  fast-check is not installed — run `npm i -D fast-check` for the deep random search');
    } else {
        const anyEvent = fc.constantFrom(...VM.EVENTS);

        // 2a. The invariants hold after every step of any sequence.
        let counter = null;
        try {
            fc.assert(fc.property(fc.array(anyEvent, { minLength: 1, maxLength: 120 }), fc.boolean(), (events, startEnabled) => {
                let s = VM.initial({ enabled: startEnabled });
                for (const e of events) {
                    s = VM.reduce(s, e).state;
                    const v = violations(s);
                    if (v.length) { counter = { events, v }; return false; }
                }
                return true;
            }), { numRuns: 5000 });
        } catch (e) { /* fast-check throws with the shrunk counterexample */ }
        ck('120-event random sequences hold the invariants (5,000 runs)', !counter);
        if (counter) console.log('        counterexample: ' + counter.events.join(' -> '));

        // 2b. Speaking is TRANSPARENT to the setting. This is the property
        //     that the "remember what it was and put it back" logic exists to
        //     provide, and the one most likely to rot in a later edit.
        let broke = null;
        try {
            fc.assert(fc.property(fc.array(anyEvent, { maxLength: 40 }), fc.boolean(), (events, startEnabled) => {
                let s = VM.initial({ enabled: startEnabled });
                for (const e of events) s = VM.reduce(s, e).state;
                const before = s.enabled;
                // A whole speech cycle, start to finish.
                let t = VM.reduce(s, 'SPEAK_START').state;
                t = VM.reduce(t, 'SPEAK_END').state;
                if (t.enabled !== before) { broke = { events, before, after: t.enabled }; return false; }
                return true;
            }), { numRuns: 3000 });
        } catch (e) { /* counterexample captured above */ }
        ck('speaking never changes whether the wake word is on', !broke);
        if (broke) console.log(`        was ${broke.before}, became ${broke.after} after: ${broke.events.join(' -> ')}`);

        // 2c. Once she switches it OFF, nothing turns it back on by itself.
        //     A reply, a background, a mishearing — none of them may re-enable
        //     listening. Only she can.
        let resurrected = null;
        const noUserOn = VM.EVENTS.filter((e) => e !== 'USER_ENABLE' && e !== 'USER_TOGGLE');
        try {
            fc.assert(fc.property(fc.array(fc.constantFrom(...noUserOn), { maxLength: 80 }), (events) => {
                let s = VM.reduce(VM.initial({ enabled: true }), 'USER_DISABLE').state;
                for (const e of events) {
                    s = VM.reduce(s, e).state;
                    // A capture she explicitly starts is allowed to open the
                    // mic; the WAKE LOOP staying off is what matters.
                    if (s.enabled) { resurrected = { events }; return false; }
                }
                return true;
            }), { numRuns: 3000 });
        } catch (e) { /* captured */ }
        ck('switching the wake word off stays off unless she turns it back on', !resurrected);
        if (resurrected) console.log('        counterexample: ' + resurrected.events.join(' -> '));

        // 2d. Backgrounding must not lose the setting. Her question, verbatim:
        //     "App backgrounds is also fine. unless i clear the cache, it
        //     should listen right?"
        let lost = null;
        try {
            fc.assert(fc.property(fc.integer({ min: 1, max: 30 }), (cycles) => {
                let s = VM.initial({ enabled: true });
                for (let i = 0; i < cycles; i += 1) {
                    s = VM.reduce(s, 'APP_BACKGROUND').state;
                    if (VM.micShouldBeOpen(s)) { lost = 'mic stayed open in the background'; return false; }
                    s = VM.reduce(s, 'APP_FOREGROUND').state;
                    if (!s.enabled) { lost = 'the setting was lost on backgrounding'; return false; }
                    if (!VM.micShouldBeOpen(s)) { lost = 'listening did not resume on reopening'; return false; }
                }
                return true;
            }), { numRuns: 500 });
        } catch (e) { /* captured */ }
        ck('30 background/foreground cycles keep the setting and resume listening', !lost);
        if (lost) console.log('        ' + lost);
    }
}

// ── 3. THE SPECIFIC FAILURES THIS WORK EXISTS TO PREVENT ──────────────────
// Written out longhand so they read as requirements rather than as generated
// noise. Each one is a thing that would actually happen to her.
{
    // "Hey Jarvis" -> "Yes?" -> she speaks the command. The mic must be shut
    // for the whole of "Yes?" and open again straight after.
    {
        const r = VM.run(VM.initial({ enabled: true }), [
            'WAKE_HEARD', 'SPEAK_START', 'SPEAK_END', 'CAPTURE_END',
        ]);
        const duringSpeech = r.steps[1];
        ck('during the "Yes?" the mic is shut', !VM.micShouldBeOpen(duringSpeech.state));
        ck('  and it is explicitly told to stop', duringSpeech.effects.includes('STOP_MIC'));
        ck('after speaking, listening resumes', VM.micShouldBeOpen(r.state));
    }

    // THE self-trigger. Jarvis answers with a sentence containing its own
    // name; a stale partial result arrives while the audio is still playing.
    {
        let s = VM.initial({ enabled: true });
        s = VM.reduce(s, 'SPEAK_START').state;
        const r = VM.reduce(s, 'WAKE_HEARD');
        ck('a wake word heard DURING speech is ignored', !r.state.capturing);
        ck('  and starts no capture', !r.effects.includes('OPEN_CAPTURE'));
        // Ten in a row — an answer saying "Jarvis" repeatedly.
        let t = s;
        for (let i = 0; i < 10; i += 1) t = VM.reduce(t, 'WAKE_HEARD').state;
        ck('  ten of them in a row still start nothing', !t.capturing && !VM.micShouldBeOpen(t));
    }

    // She switched the wake word OFF, then uses the mic button once. The
    // capture may open the mic; it must not leave the loop running after.
    {
        let s = VM.initial({ enabled: false });
        s = VM.reduce(s, 'CAPTURE_START').state;
        ck('the mic button works with the wake word off', VM.micShouldBeOpen(s));
        s = VM.reduce(s, 'CAPTURE_END').state;
        ck('  and the mic closes again afterwards', !VM.micShouldBeOpen(s));
        ck('  without switching the wake word on', s.enabled === false);
    }

    // Backgrounded mid-sentence — she gets a phone call while Scout is
    // answering. Nothing may be left running.
    {
        let s = VM.initial({ enabled: true });
        s = VM.reduce(s, 'SPEAK_START').state;
        s = VM.reduce(s, 'APP_BACKGROUND').state;
        ck('backgrounded mid-sentence, the mic stays shut', !VM.micShouldBeOpen(s));
        s = VM.reduce(s, 'SPEAK_END').state;
        ck('  and speech ending in the background does NOT open it', !VM.micShouldBeOpen(s));
        s = VM.reduce(s, 'APP_FOREGROUND').state;
        ck('  it comes back only when she reopens the app', VM.micShouldBeOpen(s));
    }

    // Permission revoked in Android settings while the app is running.
    {
        let s = VM.initial({ enabled: true });
        s = VM.reduce(s, 'PERMISSION_DENIED').state;
        ck('losing mic permission switches listening off honestly', !s.enabled && !VM.micShouldBeOpen(s));
    }

    // Android's recogniser stopping by itself — which it does constantly —
    // must restart the loop, and must not be mistaken for the user stopping it.
    {
        let s = VM.initial({ enabled: true });
        const r = VM.reduce(s, 'RECOGNISER_STOPPED');
        ck('the recogniser stopping on its own does not switch listening off', r.state.enabled);
        ck('  and the mic should still be open, so the loop restarts', VM.micShouldBeOpen(r.state));
    }
}

// ── 4. THE APP ACTUALLY USES THIS ─────────────────────────────────────────
// A perfect state machine nothing calls is worth nothing. The reason this is
// asserted: the machine was extracted FROM index.html, and the failure mode is
// that the old inline logic is left behind and quietly keeps running.
// ── 4. THE APP ACTUALLY USES THIS ─────────────────────────────────────────
// REWRITTEN after Apsara reported "after opening app, when i say hey jarvis,
// it is not doing anything". The previous version of this section asserted
// only that index.html MENTIONED voice-machine.js — and it passed, green,
// while the feature was completely dead. Three separate bugs hid behind that
// weak assertion:
//
//   1. the <script src="voice-machine.js"> tag sat at the END of <body>,
//      AFTER the inline app script that reads window.VoiceMachine at parse
//      time. VoiceMachine was undefined, VM was null, and every call into the
//      machine silently did nothing. Nothing threw.
//   2. nothing ever dispatched an event, so the START_MIC effect never fired
//      and the recogniser was never started.
//   3. the wake word defaulted to OFF, so even once wired it needed a
//      long-press before "Hey Jarvis" would do anything.
//
// A test that cannot fail is worse than no test, because it is believed. Each
// assertion below fails against the broken arrangement.
{
    const html = fs.readFileSync(path.join(R, 'mobile-app/www/index.html'), 'utf8');

    ck('the machine ships inside the app bundle',
       fs.existsSync(path.join(R, 'mobile-app/www/voice-machine.js')));

    // BUG 1 — load order. The tag must come before the inline script that
    // consumes it, or the whole feature is inert.
    const tagAt = html.indexOf('<script src="voice-machine.js">');
    const inlineAt = html.search(/<script(?![^>]*src=)[^>]*>/);
    ck('the machine is loaded by the app', tagAt !== -1);
    ck('  and BEFORE the inline script that reads it', tagAt !== -1 && inlineAt !== -1 && tagAt < inlineAt);

    // BUG 2 — something must actually dispatch, or the mic never opens.
    ck('the app dispatches a foreground event once it is up', /vmSend\('APP_FOREGROUND'\)/.test(html));
    ck('  and it does so after the listeners are wired',
       html.indexOf('wireVoiceListeners();') !== -1
       && html.indexOf("vmSend('APP_FOREGROUND')") > html.lastIndexOf('wireVoiceListeners();'));
    ck('the app stops listening when it goes to the background', /APP_BACKGROUND/.test(html));
    ck('  from the Android lifecycle', /appStateChange/.test(html));
    ck('  and from the WebView being hidden', /visibilitychange/.test(html));

    // BUG 3 — opening the app IS the switch. Her words: "after opening the
    // app, if i call hey jarvis..make it talk back".
    ck('the wake word is ON by default', /saved === null \? true/.test(html));
    ck('  but an explicit choice to turn it off is respected', /saved === '1'/.test(html));

    // And the machine is genuinely what decides — not a second copy of the
    // rule left behind in the app.
    ck('the app carries out the machine\'s effects', /START_MIC|STOP_MIC/.test(html));

    // BUG 4 — the one no amount of string-matching would have caught. With
    // foreground initialised to TRUE, the boot dispatch of APP_FOREGROUND
    // changed nothing, so no effect fired, so the recogniser never started.
    // Every assertion above passed and the mic stayed shut. So this asserts
    // the BEHAVIOUR: replay the app's real boot sequence through the real
    // machine and require that the microphone is actually asked to start.
    ck('the app starts the machine with foreground FALSE', /foreground: false/.test(html));
    {
        const bootState = VM.initial({ foreground: false, enabled: true });
        const r = VM.reduce(bootState, 'APP_FOREGROUND');
        ck('BOOT: opening the app really does start the microphone',
           r.effects.includes('START_MIC'));
        ck('  and the machine agrees the mic should be open', VM.micShouldBeOpen(r.state));

        // The same sequence with the wake word explicitly switched off must
        // NOT start it. Default-on must not become always-on.
        const off = VM.reduce(VM.initial({ foreground: false, enabled: false }), 'APP_FOREGROUND');
        ck('  but not when she has switched it off', !off.effects.includes('START_MIC'));
    }
    ck('speaking goes through the machine', /vmSend\('SPEAK_START'\)/.test(html));

    // ── AUDIO FIRST, MIC SECOND ───────────────────────────────────────────
    // Apsara: "listening is switching on and off at recurrent interval. also
    // when i say hey jarvis/scout, no talkback." Both symptoms, one cause: the
    // mic was stopped BEFORE the audio was fetched, so a fetch that failed
    // produced a stop/start cycle on every wake word and never a word spoken.
    // The churn was the failure made visible.
    {
        const fn = /async function speak\(what\)[\s\S]*?\n\}/.exec(html);
        ck('speak() is findable', !!fn);
        if (fn) {
            const body = fn[0];
            const fetchAt = Math.min(
                ...[/api\('\/api\/voice\/phrase/, /api\('\/api\/voice\/say/]
                    .map((re) => { const m = re.exec(body); return m ? m.index : Infinity; }),
            );
            const stopAt = body.indexOf("vmSend('SPEAK_START')");
            ck('the audio is fetched BEFORE the mic is closed', fetchAt < stopAt);
            ck('  and the mic is only closed once there is something to play',
               /Audio in hand\. NOW close the mic/.test(body));
            // REVISED once the device-voice fallback landed. The original
            // property was "a failed fetch must not touch the mic", which was
            // right when a failed fetch meant silence. Now a failed fetch
            // still SPEAKS, on the phone's own voice, so touching the mic is
            // correct — provided the same rule governs it.
            //
            // The property that survives: the mic is only ever touched when
            // something is actually going to be said.
            ck('a failed fetch falls back to the phone rather than going silent',
               /reportVoiceUnavailable\(\);[\s\S]{0,200}speakWithMicClosed\(/.test(body));
            ck('the mic is still reopened after a successful play',
               /vmSend\('SPEAK_END'\)/.test(body));
        }
    }
    ck('an unavailable voice is reported once, not on every wake word',
       /if \(voiceServerOk === false\) return;/.test(html));
    ck('the "listening" toast fires once per session, not on every restart',
       /__saidListening/.test(html));

    // ── the one-shot capture goes through the machine too ─────────────────
    // captureCommand() opens the recogniser directly. Until now it did so
    // WITHOUT telling the machine, which left the single most important rule
    // in the app — when a microphone may be open — with a bypass around it
    // that the exhaustive tests could not see, because they only ever tested
    // the machine.
    ck('starting a capture tells the machine', /vmSend\('CAPTURE_START'\)/.test(html));
    ck('ending a capture tells it too', /vmSend\('CAPTURE_END'\)/.test(html));
    ck('closing the sheet ends the capture', /endCapture\(\);/.test(html));

    // ── the wake word acknowledges BEFORE it starts listening ─────────────
    // Firing speak() and captureCommand() together reopened the mic while
    // "Yes?" was still playing: the acknowledgement was cut off and the
    // speaker and mic were live at the same moment.
    ck('the acknowledgement completes before the capture opens',
       /speak\(\{ phrase: 'wake' \}\)\.then\(\(\) => captureCommand\(''\)/.test(html));
    ck('  and a wake word WITH a command attached skips the acknowledgement',
       /if \(rest\) \{ captureCommand\(rest\); return; \}/.test(html));

    // ── the self-test ─────────────────────────────────────────────────────
    // Three rounds of "it is not talking back" were answered by guessing.
    // This walks the chain and reports what each step actually did.
    ck('the app can diagnose its own voice', /runVoiceDiagnostic/.test(html));

    // ── never silent ──────────────────────────────────────────────────────
    // Four rounds of "no talkback" all had the same shape: the good voice was
    // unavailable, so NOTHING was said. A robotic voice that answers beats a
    // human voice that does not.
    ck('the phone\'s own voice is wired as a fallback', /deviceTtsPlugin/.test(html));
    ck('  it is used when the phrase fetch fails',
       /reportVoiceUnavailable\(\);[\s\S]{0,180}speakWithMicClosed\(LOCAL_PHRASES/.test(html));
    ck('  and when an answer cannot be synthesised',
       /reportVoiceUnavailable\(\);[\s\S]{0,120}speakWithMicClosed\(what\.text\)/.test(html));
    // THE important one. A fallback that bypassed the machine would quietly
    // reintroduce the self-trigger the whole design exists to prevent.
    ck('  the fallback obeys the SAME microphone rule',
       /async function speakWithMicClosed[\s\S]{0,400}vmSend\('SPEAK_START'\)[\s\S]{0,400}vmSend\('SPEAK_END'\)/.test(html));
    ck('  and it never calls the plugin outside that wrapper',
       (html.match(/speakOnDevice\(/g) || []).length <= 3);   // definition, wrapper, self-test
    // With NO fallback available either, nothing is said — and then the mic
    // must be left exactly as it was. This is the old property, kept.
    ck('  with no fallback at all, the mic is not touched',
       /const TTS = deviceTtsPlugin\(\);\s*\n\s*if \(!TTS\) return false;\s*\n\s*speaking = true;/.test(html));
    ck('the self-test checks the fallback too', /phone's own voice/.test(html));
    ck('  it checks the plugin, permission, server, fetch and playback',
       /speech plugin/.test(html) && /microphone permission/.test(html)
       && /server reachable/.test(html) && /audio playback/.test(html));

    // ── ADMIN ONLY ────────────────────────────────────────────────────────
    // Apsara 2026-08-29: "for admin user only as of now". The wake word feeds
    // workflow/brain.js, which messages truckers and suppliers for real, so an
    // always-on microphone is not a default capability.
    ck('there is a single voiceAllowed() gate', /function voiceAllowed\(\)/.test(html));
    ck('  and it is admin-only', /function voiceAllowed\(\)\s*\{\s*return ROLE === 'admin'/.test(html));
    ck('the wake loop itself refuses for non-admins',
       /async function startWakeLoop\(\)[\s\S]{0,400}if \(!voiceAllowed\(\)\) return;/.test(html));
    ck('the button is hidden rather than shown-and-broken',
       /if \(!voiceAllowed\(\)\) \{ b\.classList\.add\('hidden'\)/.test(html));
    ck('the gate is consulted in more than one place', (html.match(/voiceAllowed\(\)/g) || []).length >= 3);

    // ── NO SILENT FAILURES ────────────────────────────────────────────────
    // Three of the four ways startWakeLoop could fail used to `return` with no
    // message at all, which is why a dead feature looked exactly like a
    // feature that had not heard her.
    {
        const fn = /async function startWakeLoop\(\)[\s\S]*?\n\}/.exec(html);
        ck('startWakeLoop is findable', !!fn);
        if (fn) {
            const body = fn[0];
            // Named precisely rather than counted. Counting bare `return`s was
            // too blunt — the admin gate and the already-listening case are
            // both legitimately silent, and a threshold would just drift.
            // These are the four paths that MUST speak:
            ck('  a missing plugin is reported', /voiceToast\([\s\S]{0,200}installed app|no speech recogniser/i.test(body));
            ck('  a device with no recogniser is reported', /No speech recogniser available/i.test(body));
            ck('  a denied permission is reported, with where to fix it',
               /permission is denied[\s\S]{0,120}Permissions/i.test(body));
            ck('  an unexpected error is reported, not swallowed',
               /catch \(e\) \{[\s\S]{0,200}voiceToast/.test(body));
            ck('  and it confirms out loud when it DOES start', /Listening for/.test(body));
            // The two silent returns that are CORRECT, so a future edit that
            // makes them noisy is also caught.
            ck('  the admin gate is silent (the button is simply not there)',
               /if \(!voiceAllowed\(\)\) return;/.test(body));
            ck('  already-listening is silent (it is not a failure)',
               /if \(voiceOn\) return;/.test(body));
        }
    }
    ck('  and so does the end of speaking', /vmSend\('SPEAK_END'\)/.test(html));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
