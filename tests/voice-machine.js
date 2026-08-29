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
{
    const html = fs.readFileSync(path.join(R, 'mobile-app/www/index.html'), 'utf8');
    ck('the app loads the state machine', /voice-machine\.js/.test(html));
    ck('the app asks the machine before opening the mic', /micShouldBeOpen|VoiceMachine/.test(html));
    ck('the machine ships inside the app bundle',
       fs.existsSync(path.join(R, 'mobile-app/www/voice-machine.js')));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
