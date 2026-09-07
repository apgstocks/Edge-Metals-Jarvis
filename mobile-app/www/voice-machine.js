/* ── voice-machine.js — when the microphone may be open ─────────────────────
 *
 * Apsara, 2026-08-29: "Test end to end... find the best tester to test this...
 * The part that needs care. The wake loop listens continuously. If Jarvis
 * speaks while the mic is open, it hears its own reply, matches 'Jarvis' in
 * it, and triggers itself."
 *
 * This file exists BECAUSE of that instruction. The rule about when the mic
 * may be open was previously spread across five functions inside a 7,000-line
 * index.html, tangled with the Capacitor plugin and the DOM — which meant it
 * could not be tested at all, only tried by hand on a phone. The most
 * dangerous rule in the app was the least testable thing in it.
 *
 * So the rule is pulled out here as a PURE REDUCER: (state, event) -> state.
 * No DOM, no plugin, no timers, no network. It decides nothing about HOW to
 * start the microphone; it only decides WHETHER the microphone should be open
 * right now. index.html reads that decision and obeys it.
 *
 * That shape is deliberate. It is what makes the property-based and
 * model-based tests in tests/voice-machine.js possible: a pure reducer can be
 * driven through millions of random event orderings in a second, including
 * orderings no human would think to try — which is exactly where a
 * self-triggering feedback loop hides. Published wake-word testing works the
 * same way, replaying long recorded sequences to hunt false accepts; the
 * difference is that this is the deterministic half, and it can be exhaustive.
 *
 * ── THE INVARIANTS ────────────────────────────────────────────────────────
 * These are what the tests assert against every possible event sequence:
 *
 *   1. The mic is NEVER open while Jarvis or Scout is speaking.
 *      This is the self-triggering bug. Without it the phone hears its own
 *      reply, finds its own name in it, and re-triggers forever on an open
 *      mic until the battery is flat.
 *
 *   2. The mic is NEVER open while the app is not in the foreground.
 *      Android will not reliably run a recogniser in a backgrounded WebView
 *      anyway, but relying on the OS to enforce a privacy property is not the
 *      same as enforcing it.
 *
 *   3. The mic is only ever open because the user asked for it — either the
 *      wake loop is switched on, or a one-shot capture is in progress.
 *
 *   4. Speaking never changes the SETTING, only the microphone. When Jarvis
 *      stops talking, listening resumes exactly if it was on before, and
 *      stays off exactly if it was off. A reply must not be able to switch
 *      the wake word on, and must not be able to switch it off either.
 *
 *   5. Nothing except an explicit choice by the user changes the setting.
 *      Backgrounding, speaking, capturing and mishearing all leave it alone.
 */

(function (root, factory) {
    /* eslint-disable */
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.VoiceMachine = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // `enabled` is the SETTING — what she chose, and the only thing that is
    // persisted. Everything else is a fact about right now.
    function initial(over) {
        return Object.assign({
            enabled: false,      // wake word switched on by the user
            foreground: true,    // app is visible
            speaking: false,     // Jarvis or Scout is talking
            capturing: false,    // a one-shot command capture is open
            // ── BARGE-IN, AND WHY IT IS A SEPARATE FLAG ──────────────────
            // Apsara, 2026-09-07: "mimic siri behaviour/alexa's."
            //
            // Siri and Alexa both let you talk over them. Jarvis could not:
            // invariant 1 below shuts the microphone while it speaks, and the
            // comment in voice.js said plainly that changing it was "a real
            // decision with a known failure mode behind it, not something to
            // slip in." She has now made that decision.
            //
            // It is NOT made by loosening invariant 1. That rule is what every
            // other part of this file trusts, and editing it would silently
            // reinterpret every existing assertion about it. Instead the mic
            // gets a SECOND, narrower mode that exists only while speaking —
            // see micGuardOpen() — in which the recogniser is listening for
            // the wake word and "stop" and nothing else. That is how Alexa
            // does it too: full speech recognition does not run during
            // playback, only the wake detector.
            //
            // `guard` is the kill switch. Two self-triggers in a row and it
            // latches off for the session (fail closed, her call deferred to
            // me): a feedback loop in her pocket drains the battery and she
            // cannot stop it, whereas losing barge-in just means tapping the
            // card, which still works.
            guard: true,
        }, over || {});
    }

    // The single rule. Everything else in this file just maintains the flags
    // this reads. Expressed once, so there is exactly one answer to "should
    // the mic be open" and no second copy to drift.
    function micShouldBeOpen(s) {
        if (s.speaking) return false;      // invariant 1 — never hear ourselves
        if (!s.foreground) return false;   // invariant 2 — never listen unseen
        return !!(s.capturing || s.enabled); // invariant 3 — only if asked for
    }

    // ── THE SECOND MODE. DELIBERATELY NOT PART OF THE RULE ABOVE ─────────
    // True only while speaking, and only ever means "listen for the wake word
    // or a stop word". Full recognition still obeys micShouldBeOpen()
    // unchanged, so invariant 1 holds for everything it held for yesterday
    // and every test written against it still means what it meant.
    //
    // Invariants 2 and 3 are NOT relaxed: a backgrounded app does not listen,
    // and neither does one she has switched off. Barge-in is a convenience
    // during playback, not a reason to open a microphone she did not ask for.
    function micGuardOpen(s) {
        if (!s.speaking) return false;     // only ever during playback
        if (!s.guard) return false;        // latched off after self-triggers
        if (!s.foreground) return false;   // invariant 2, unchanged
        return !!s.enabled;                // invariant 3, unchanged
    }

    var EVENTS = [
        'USER_ENABLE', 'USER_DISABLE', 'USER_TOGGLE',
        'APP_FOREGROUND', 'APP_BACKGROUND',
        'SPEAK_START', 'SPEAK_END',
        'CAPTURE_START', 'CAPTURE_END',
        'WAKE_HEARD', 'RECOGNISER_STOPPED', 'PERMISSION_DENIED',
        'BARGE_SELF_TRIGGERED',
    ];

    // (state, event) -> { state, effects }
    //
    // `effects` is what the caller should DO — start or stop the recogniser,
    // open a capture. Returning them rather than performing them is what keeps
    // this testable: a test can assert on the intent without a microphone.
    function reduce(state, event) {
        var s = Object.assign({}, state);
        var e = (event && event.type) || event;

        switch (e) {
            case 'USER_ENABLE':
                s.enabled = true;
                break;

            // ── TURNING IT OFF MEANS OFF, INCLUDING THE SPEAKER ──────────
            // Found 2026-09-06 by a test written for the new local
            // synthesiser, but the bug is older than that and was never
            // Kokoro's: switching voice off while Jarvis was mid-sentence
            // left `speaking` true and produced NO effects, so the reply
            // carried on talking over her. With the browser voice that was
            // merely rude. With audio playing through an AudioContext it is
            // worse, because `speaking` staying true also means the state
            // never returns to idle.
            //
            // Clearing `speaking` here makes the derived comparison in
            // run() emit STOP_SPEAKING, which is what actually silences
            // both engines. `capturing` goes too: a capture window left
            // open on a disabled assistant is a microphone nobody expects
            // to be listening.
            case 'USER_DISABLE':
                s.enabled = false;
                s.speaking = false;
                s.capturing = false;
                break;

            case 'USER_TOGGLE':
                s.enabled = !s.enabled;
                if (!s.enabled) { s.speaking = false; s.capturing = false; }
                break;

            case 'APP_BACKGROUND':
                // The SETTING survives. Only the microphone stops. This is the
                // difference between "listening is off" and "not listening
                // right now", and conflating them is how a user ends up having
                // to switch the wake word back on every time they check a text
                // message.
                s.foreground = false;
                break;

            case 'APP_FOREGROUND':
                s.foreground = true;
                break;

            case 'SPEAK_START':
                // Speech closes any capture that is open. The exhaustive
                // search found the mirror image of the barge-in case:
                // CAPTURE_START -> SPEAK_START left a capture running while
                // audio played, so whatever the recogniser returned next would
                // be Jarvis's own words transcribed as her command.
                //
                // Speaking always wins over listening. There is no state in
                // which both are true.
                s.capturing = false;
                s.speaking = true;
                break;

            case 'SPEAK_END':
                s.speaking = false;
                break;

            case 'CAPTURE_START':
                // BARGE-IN. Found by the exhaustive search in
                // tests/voice-machine.js, not by thinking: the sequence
                // SPEAK_START -> CAPTURE_START left the microphone open while
                // audio was still playing. That is the self-trigger arriving
                // through the front door — she taps the mic button because
                // Jarvis is saying something she does not need to hear, and
                // the phone starts listening to itself.
                //
                // Interrupting is the RIGHT behaviour for that tap; the bug
                // was only that the speech was not stopped first. So the
                // capture cancels the speech, in that order.
                s.speaking = false;
                s.capturing = true;
                break;

            case 'CAPTURE_END':
                s.capturing = false;
                break;

            case 'WAKE_HEARD':
                // Ignored outright while speaking. The mic is supposed to be
                // shut at that moment, but a partial result already queued
                // before it closed can still arrive — and that late arrival is
                // precisely the self-trigger. Belt as well as braces.
                if (s.speaking) break;
                if (!s.foreground) break;
                s.capturing = true;
                break;

            case 'RECOGNISER_STOPPED':
                // Android's recogniser stops on its own, constantly. It says
                // nothing about what the user wants, so it changes no setting;
                // the derived rule below simply restarts it if it should be on.
                break;

            // Latches barge-in off for the session. Emitted by voice.js after
            // the second time the recogniser hands back something that turned
            // out to be Jarvis's own voice. One-way on purpose: a flag that
            // could switch itself back on is a loop with a longer period.
            case 'BARGE_SELF_TRIGGERED':
                s.guard = false;
                break;

            case 'PERMISSION_DENIED':
                // The one non-user event that turns the setting off, because
                // continuing to "listen" without permission is a lie.
                s.enabled = false;
                s.capturing = false;
                break;

            default:
                break;
        }

        return { state: s, effects: effectsFor(state, s) };
    }

    // What changed, in terms the caller can act on.
    function effectsFor(before, after) {
        var was = micShouldBeOpen(before);
        var now = micShouldBeOpen(after);
        var effects = [];
        // Silencing comes FIRST. The caller performs these in order, and
        // starting the mic before the speaker is muted is the whole bug.
        var gWas = micGuardOpen(before);
        var gNow = micGuardOpen(after);
        // ── STOPS BEFORE STARTS, ALWAYS ──────────────────────────────────
        // I first appended the guard effects after the others and it broke
        // every "the microphone comes back" assertion: leaving speech emits
        // START_MIC and STOP_GUARD_MIC, and with STOP last the caller started
        // the recogniser and then immediately stopped it again. The mic never
        // came back and nothing said so.
        //
        // Grouping by stop-then-start makes the order true by construction
        // rather than by me getting a four-line sequence right, which I did
        // not. Silencing still comes first of all.
        if (before.speaking && !after.speaking) effects.push('STOP_SPEAKING');
        if (gWas && !gNow) effects.push('STOP_GUARD_MIC');
        if (was && !now) effects.push('STOP_MIC');
        if (!was && now) effects.push('START_MIC');
        if (!gWas && gNow) effects.push('START_GUARD_MIC');
        if (!before.capturing && after.capturing) effects.push('OPEN_CAPTURE');
        return effects;
    }

    // Runs a whole sequence. Used by the tests, and handy for reasoning about
    // a bug report after the fact.
    function run(state, events) {
        var s = state;
        var all = [];
        for (var i = 0; i < events.length; i += 1) {
            var r = reduce(s, events[i]);
            s = r.state;
            all.push({ event: (events[i] && events[i].type) || events[i], state: s, effects: r.effects });
        }
        return { state: s, steps: all };
    }

    return { initial: initial, reduce: reduce, run: run, micShouldBeOpen: micShouldBeOpen,
             micGuardOpen: micGuardOpen, EVENTS: EVENTS };
}));
