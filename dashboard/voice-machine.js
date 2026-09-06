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

    var EVENTS = [
        'USER_ENABLE', 'USER_DISABLE', 'USER_TOGGLE',
        'APP_FOREGROUND', 'APP_BACKGROUND',
        'SPEAK_START', 'SPEAK_END',
        'CAPTURE_START', 'CAPTURE_END',
        'WAKE_HEARD', 'RECOGNISER_STOPPED', 'PERMISSION_DENIED',
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

            case 'USER_DISABLE':
                s.enabled = false;
                break;

            case 'USER_TOGGLE':
                s.enabled = !s.enabled;
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
        if (before.speaking && !after.speaking) effects.push('STOP_SPEAKING');
        if (was && !now) effects.push('STOP_MIC');
        if (!was && now) effects.push('START_MIC');
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

    return { initial: initial, reduce: reduce, run: run, micShouldBeOpen: micShouldBeOpen, EVENTS: EVENTS };
}));
