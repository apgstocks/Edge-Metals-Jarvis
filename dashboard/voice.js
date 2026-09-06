/* ── dashboard/voice.js — "Hey Jarvis" in the browser ──────────────────────
 *
 * Apsara, 2026-09-05: "i dont want voice on app .. only on website", and then
 * "i want hey jarvis like hey siri in my laptop."
 *
 * WHY THIS IS ONLY POSSIBLE TODAY
 * -------------------------------
 * Browsers refuse microphone access on plain HTTP. Until this morning the
 * dashboard was reachable only over a rotating *.trycloudflare.com tunnel;
 * now it is https://jarvis.edgemetals.com with a real certificate, so the
 * microphone can be asked for at all. The subdomain work was the prerequisite
 * for this feature, not a detour from it.
 *
 * THE RULE ABOUT WHEN THE MIC MAY BE OPEN IS NOT IN THIS FILE
 * -----------------------------------------------------------
 * It lives in voice-machine.js — the same pure reducer the Android app used,
 * copied unchanged, still covered by tests/voice-machine.js and its
 * exhaustive event-ordering search. That file exists because of one specific
 * failure: if the mic is open while Jarvis is speaking, it hears its own
 * reply, finds its own name in it, and re-triggers itself forever on an open
 * microphone. That bug is not browser-specific and the rule that prevents it
 * is not either, so it is reused rather than rewritten.
 *
 * This file is the BODY: it owns the recogniser, the speaker and the DOM, and
 * it does what the reducer tells it. Every decision about whether to listen
 * goes through reduce(); none is taken here.
 *
 * CHROME, WITH AN HONEST FALLBACK
 * -------------------------------
 * A wake word needs CONTINUOUS recognition, and that is where browsers
 * differ. Safari supports SpeechRecognition but its continuous mode
 * misbehaves — the microphone does not reliably stop when you stop talking,
 * and results accumulate into one ever-growing string. Rather than ship
 * something that half-works and blame the browser, this feature-detects:
 *
 *   Chrome/Edge  → wake word, hands-free, as she asked.
 *   Safari/other → the same assistant behind a press-to-talk button, and a
 *                  line saying plainly why, naming Chrome.
 *
 * Degrading is the point. A microphone that sometimes never closes is worse
 * than a button.
 *
 * PRIVACY, WHICH IS NOT NEGOTIABLE HERE
 * -------------------------------------
 * An always-listening microphone in an office needs to be visibly on. So:
 *   - it is OFF until she turns it on, every session; nothing auto-starts
 *   - while the mic is open there is a red dot she cannot miss
 *   - the tab title changes too, because the dot is invisible on a background tab
 *   - closing or hiding the tab stops the microphone (APP_BACKGROUND)
 *   - audio is never recorded, stored or uploaded — the browser's recogniser
 *     returns text, and only that text is sent to the server
 */

(function () {
    'use strict';
    if (window.__jarvisVoiceLoaded) return;
    window.__jarvisVoiceLoaded = true;

    var VM = window.VoiceMachine;
    if (!VM) { console.warn('[VOICE] voice-machine.js must load first'); return; }

    // ── what this browser can actually do ─────────────────────────────────
    // ── WHICH ENGINE ─────────────────────────────────────────────────────
    // Three possibilities, in order of preference:
    //
    //   1. LOCAL (voice-local.js) — the desktop app. Audio is captured here
    //      and transcribed by whisper.cpp inside the app's own Node process.
    //      Nothing leaves the Mac. Preferred wherever it exists, because it
    //      is both the only thing that works there AND more private than the
    //      alternative.
    //   2. Chrome's SpeechRecognition — real Chrome only. Works, but uploads
    //      the audio to Google to be transcribed.
    //   3. Nothing usable — Safari, whose continuous mode misbehaves.
    //
    // Preferring local was not the original design. It became the design
    // after the desktop app was shipped claiming "Electron bundles Chromium
    // so the wake word works", which was wrong: SpeechRecognition in Chrome
    // is a GOOGLE SERVICE reached with keys Electron does not have. Proved on
    // her machine — "SPEECH ERROR: network", instantly — rather than argued.
    var LOCAL = window.JarvisLocalRecognition || null;
    var SR = LOCAL || window.SpeechRecognition || window.webkitSpeechRecognition || null;
    // Safari reports webkitSpeechRecognition and then handles `continuous`
    // badly. Irrelevant when the local engine is present, which is why this is
    // checked second.
    var isSafari = /^((?!chrome|android|crios|edg).)*safari/i.test(navigator.userAgent);
    var canWake = !!LOCAL || (!!SR && !isSafari);

    var WAKE = /\b(hey |ok |okay )?jarvis\b/i;
    // How long a command may run before it is cut off. Long enough for
    // "record a twelve thousand dollar zelle payment against edge zero seven",
    // short enough that an open mic in a noisy office closes on its own.
    var CAPTURE_MS = 8000;

    // Set once the recogniser has told us it has no engine behind it. There
    // is no recovering from that within this window, so it latches.
    var speechUnavailable = false;

    var state = VM.initial({ enabled: false, foreground: !document.hidden });
    var rec = null, captureTimer = null, heardDuringCapture = '';
    var origTitle = document.title;

    // ── the DOM ───────────────────────────────────────────────────────────
    var bar = document.createElement('div');
    bar.id = 'jarvisVoiceBar';
    bar.innerHTML = [
        '<button id="jvToggle" type="button"></button>',
        '<span id="jvDot"></span>',
        '<span id="jvText"></span>',
    ].join('');
    var css = document.createElement('style');
    css.textContent = [
        '#jarvisVoiceBar{position:fixed;right:18px;bottom:82px;z-index:900;display:flex;align-items:center;gap:9px;',
        '  padding:8px 12px;border-radius:999px;background:#14181B;border:1px solid rgba(255,255,255,.14);',
        '  font-family:ui-monospace,monospace;font-size:11.5px;color:#8A9299;box-shadow:0 6px 18px rgba(0,0,0,.4);}',
        '#jvToggle{background:transparent;border:none;color:#B4703A;font:inherit;font-weight:700;cursor:pointer;',
        '  text-transform:uppercase;letter-spacing:.1em;padding:0;}',
        '#jvDot{width:8px;height:8px;border-radius:50%;background:#394046;flex:none;}',
        /* The dot is the honest bit. Red and pulsing means the microphone is
           genuinely open right now — not "enabled", OPEN. */
        '#jarvisVoiceBar.live #jvDot{background:#E5484D;animation:jvPulse 1.1s ease-in-out infinite;}',
        '#jarvisVoiceBar.hearing{border-color:#B4703A;}',
        '@keyframes jvPulse{0%,100%{opacity:1;}50%{opacity:.25;}}',
        '#jarvisVoiceBar.hidden{display:none;}',
    ].join('');

    function el(id) { return document.getElementById(id); }
    function say(msg) { var t = el('jvText'); if (t) t.textContent = msg; }

    function paint() {
        var open = VM.micShouldBeOpen(state);
        bar.classList.toggle('live', open);
        bar.classList.toggle('hearing', !!state.capturing);
        // ── THE LABEL IS A SWITCH, NOT AN INSTRUCTION ────────────────────
        // This read "HEY JARVIS" when off, and Apsara spent a while saying
        // "Hey Jarvis" at it and reporting that nothing happened. She was
        // doing exactly what the button appeared to ask. Labelling an OFF
        // switch with the phrase the user is supposed to SAY is a trap, and it
        // was mine — the state was "Off" in small grey text beside a large
        // amber "HEY JARVIS", so the prompt shouted and the state whispered.
        //
        // The off state now names the ACTION. The on state names what to say,
        // because at that point saying it is exactly what to do.
        el('jvToggle').textContent = speechUnavailable ? 'Use Chrome'
            : state.enabled ? 'Listening'
            : (canWake ? 'Turn on voice' : 'Hold to talk');
        // The tab title, because a dot in the corner is invisible the moment
        // she switches tabs — and "is it still listening?" must be answerable
        // without coming back to look.
        document.title = open ? '🎙 ' + origTitle : origTitle;
    }

    // ── the one place effects are carried out ─────────────────────────────
    // Order matters and is the reducer's, not ours: STOP_SPEAKING before
    // START_MIC, always. Starting the microphone before the speaker is muted
    // is the entire self-trigger bug.
    function dispatch(event) {
        var r = VM.reduce(state, event);
        state = r.state;
        (r.effects || []).forEach(function (fx) {
            if (fx === 'STOP_SPEAKING') stopSpeaking();
            else if (fx === 'STOP_MIC') stopMic();
            else if (fx === 'START_MIC') startMic();
            else if (fx === 'OPEN_CAPTURE') openCapture();
        });
        paint();
    }

    // ── speaking ──────────────────────────────────────────────────────────
    function stopSpeaking() {
        try { window.speechSynthesis.cancel(); } catch (e) {}
    }
    function speak(text) {
        if (!window.speechSynthesis) return;
        dispatch('SPEAK_START');           // closes the mic BEFORE any audio
        var u = new SpeechSynthesisUtterance(String(text).slice(0, 600));
        u.rate = 1.05;
        // Both paths end the speaking state. Without the error handler a
        // failed utterance would leave `speaking` true for ever and the
        // microphone would never reopen — the feature would simply stop
        // working with nothing on screen to explain it.
        u.onend = function () { dispatch('SPEAK_END'); };
        u.onerror = function () { dispatch('SPEAK_END'); };
        try { window.speechSynthesis.speak(u); } catch (e) { dispatch('SPEAK_END'); }
    }

    // ── the recogniser ────────────────────────────────────────────────────
    function startMic() {
        if (!SR || rec || speechUnavailable) return;
        rec = new SR();
        rec.continuous = canWake;
        rec.interimResults = true;
        rec.lang = 'en-US';

        rec.onresult = function (ev) {
            var txt = '';
            for (var i = ev.resultIndex; i < ev.results.length; i += 1) txt += ev.results[i][0].transcript;
            txt = txt.trim();
            if (!txt) return;

            if (state.capturing) {
                heardDuringCapture = txt;
                say('“' + txt.slice(0, 44) + '”');
                return;
            }
            // Not capturing: the only thing worth hearing is the wake word.
            if (WAKE.test(txt)) dispatch('WAKE_HEARD');
        };

        rec.onerror = function (ev) {
            var err = ev && ev.error;
            if (err === 'not-allowed' || err === 'service-not-allowed') {
                // Continuing to show "Listening" without permission is a lie,
                // and the reducer treats it as switching the setting off.
                dispatch('PERMISSION_DENIED');
                say('Microphone blocked — allow it in the address bar.');
                return;
            }
            // ── 'network' MEANS THE ENGINE IS NOT AVAILABLE AT ALL ────────
            // Found on Apsara's Mac, 2026-09-06, by opening devtools in the
            // desktop app rather than reasoning about it. The console said:
            //   SR exists: true / MIC STARTED / SPEECH ERROR: network / MIC ENDED
            //
            // Speech recognition in Chrome is a GOOGLE SERVICE, not a browser
            // feature. Chrome ships private API keys for it; Electron's
            // Chromium does not have them and is not permitted to. So the API
            // exists, starts, fails instantly and stops — for ever, on every
            // attempt.
            //
            // I had justified the whole desktop app with "Electron bundles
            // Chromium so the wake word works". That was wrong: Chromium is
            // not Chrome for this API. No amount of configuration fixes it.
            //
            // So this is treated as a HARD CAPABILITY FAILURE rather than a
            // transient error. Retrying would spin for ever while the pill
            // said "Listening", which is the same lie the old "HEY JARVIS"
            // label told — the UI claiming a state that is not true.
            if (err === 'engine') {
                // The LOCAL engine failed — a missing model, usually. It says
                // what is wrong; repeating "use Chrome" here would be advice
                // for a different problem.
                say('Speech engine: ' + (ev.message || 'failed'));
                console.warn('[VOICE] local engine error:', ev.message);
                dispatch('RECOGNISER_STOPPED');
                return;
            }
            if (err === 'network' && !LOCAL) {
                speechUnavailable = true;
                dispatch('USER_DISABLE');
                say('Voice needs Google Chrome — this app cannot do speech');
                console.warn('[VOICE] SpeechRecognition returned "network". This build has no speech '
                    + 'engine (Electron ships Chromium without Google\'s speech API keys). '
                    + 'Open https://jarvis.edgemetals.com in Google Chrome for the wake word.');
                return;
            }
            // 'no-speech' and 'aborted' are ordinary in a quiet room.
            dispatch('RECOGNISER_STOPPED');
        };
        // Chrome stops the recogniser on its own, constantly. RECOGNISER_STOPPED
        // changes no setting; the reducer's derived rule restarts it if it
        // should still be open.
        rec.onend = function () { rec = null; dispatch('RECOGNISER_STOPPED'); };

        try { rec.start(); say(canWake ? 'Say “Hey Jarvis”' : 'Listening…'); }
        catch (e) { rec = null; }
    }

    function stopMic() {
        if (!rec) return;
        var r = rec; rec = null;
        try { r.onend = null; r.stop(); } catch (e) {}
    }

    function openCapture() {
        heardDuringCapture = '';
        say('Yes?');
        try { new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=').play(); } catch (e) {}
        clearTimeout(captureTimer);
        captureTimer = setTimeout(finishCapture, CAPTURE_MS);
    }

    function finishCapture() {
        clearTimeout(captureTimer);
        var q = heardDuringCapture.replace(WAKE, '').trim();
        dispatch('CAPTURE_END');
        if (!q) { say(canWake ? 'Say “Hey Jarvis”' : 'Hold to talk'); return; }
        ask(q);
    }

    // ── asking ────────────────────────────────────────────────────────────
    // Goes through the SAME endpoint as the typed assistant. Voice is an input
    // method, not a second brain — so the tool registry, the propose-then-
    // confirm rule and every validation apply identically. A spoken
    // instruction can no more write to the ledger than a typed one.
    function ask(q) {
        say('Thinking…');
        // `thinking` is not in the reducer: it is about the network, not about
        // whether the microphone may be open, and putting it there would mean
        // a state that can never affect the one decision that file exists to
        // make. The orb is told directly, and cleared on BOTH outcomes below —
        // an orb left churning after a failed request is a spinner that never
        // stops.
        if (window.JarvisOrb) window.JarvisOrb.setThinking(true);
        var api = window.api;
        if (typeof api !== 'function') { say('Assistant unavailable'); return; }
        api('/api/yard/ask', { method: 'POST', body: JSON.stringify({ question: q }) })
            .then(function (r) {
                if (window.JarvisOrb) window.JarvisOrb.setThinking(false);
                var answer = (r && r.answer) || 'No answer.';
                say(answer.slice(0, 60));
                // A PROPOSAL IS NEVER SPOKEN AND CONFIRMED BY VOICE. The card
                // is shown and she taps it. Confirming a payment by saying
                // "yes" to a machine that mishears names is the one shortcut
                // this whole design refuses to take.
                if (r && r.proposal) {
                    speak('I can do that. Check the card and confirm it.');
                    if (typeof window.renderYardProposal === 'function') window.renderYardProposal(r.proposal);
                } else {
                    speak(answer);
                }
            })
            .catch(function (e) {
                if (window.JarvisOrb) window.JarvisOrb.setThinking(false);
                say('Failed: ' + (e && e.message));
            });
    }

    // ── wiring ────────────────────────────────────────────────────────────
    var mounted = false;
    function mount() {
        // IDEMPOTENT. mount() can be reached twice — the readyState check
        // registers a DOMContentLoaded listener, and anything that fires that
        // event again runs it a second time. Without this guard the second run
        // appends a duplicate bar and, worse, RESETS the status line: a
        // "Voice needs Google Chrome" message was being overwritten a
        // millisecond later by the mount-time "Click to start listening",
        // hiding the one explanation the person needed. Caught in the test
        // harness, but the same overwrite is possible in a browser.
        if (mounted) return;
        mounted = true;
        if (!SR) return;                       // no recogniser at all: show nothing
        document.head.appendChild(css);
        document.body.appendChild(bar);
        paint();

        if (!canWake) {
            say('Press and hold — Chrome for “Hey Jarvis”');
        } else {
            // Not "Off". "Off" describes a state; this has to tell her what to
            // do about it.
            say('Click to start listening');
        }

        var t = el('jvToggle');
        if (canWake) {
            // Nothing auto-starts. The first click is also what gives the
            // browser the user gesture it requires before opening a mic.
            t.addEventListener('click', function () { dispatch('USER_TOGGLE'); });
        } else {
            // Press-to-talk: hold the button, speak, release.
            var down = function (e) { e.preventDefault(); dispatch('CAPTURE_START'); startMic(); };
            var up = function () { finishCapture(); stopMic(); };
            t.addEventListener('mousedown', down);
            t.addEventListener('touchstart', down);
            window.addEventListener('mouseup', up);
            window.addEventListener('touchend', up);
        }

        // Hiding the tab stops the microphone. The SETTING survives — that is
        // the difference between "listening is off" and "not listening right
        // now", and conflating them means switching it back on every time she
        // checks her email.
        document.addEventListener('visibilitychange', function () {
            dispatch(document.hidden ? 'APP_BACKGROUND' : 'APP_FOREGROUND');
        });
        // Belt as well as braces: never leave a microphone open on unload.
        window.addEventListener('pagehide', stopMic);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();

    // Exposed for the tests, and for anyone debugging a report of "it kept
    // listening" — the state is the whole explanation.
    window.JarvisVoice = {
        state: function () { return state; },
        canWake: canWake,
        dispatch: dispatch,
        // Ends the capture and asks, exactly as the timer does. Exposed so a
        // test can drive the real path — dispatching CAPTURE_END alone skips
        // this and therefore skips speak(), which is where the microphone is
        // supposed to be closed. That gap let a broken build pass once.
        finish: finishCapture,
        WAKE: WAKE,
    };
}());
