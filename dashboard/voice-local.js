/* ── dashboard/voice-local.js — the microphone, when there is no browser engine
 *
 * Apsara: "i want voice in desktop app."
 *
 * WHAT THIS IS AND WHERE IT SITS
 * ------------------------------
 * dashboard/voice.js owns the FLOW — wake, capture, ask, speak — and
 * voice-machine.js owns the RULE about when the mic may be open. Neither
 * changes here. This file is only a second RECOGNISER, used when the page is
 * running inside the desktop app, where Chrome's SpeechRecognition does not
 * exist in any working form.
 *
 * It presents the same three things voice.js already uses — start, stop, and
 * an onresult callback that hands over text — so voice.js does not need to
 * know which engine is behind it. That was the point of keeping the flow and
 * the rule in separate files.
 *
 * WHY AN ENERGY GATE, AND WHY IT MATTERS
 * --------------------------------------
 * Whisper is not free to run. Transcribing continuously would keep a fan on
 * and a battery draining for a room that is silent most of the day.
 *
 * So the microphone is always open (cheap) and Whisper is not (expensive).
 * An AnalyserNode measures loudness every frame — arithmetic on a buffer, no
 * model, no allocation. Only when the level crosses a threshold does audio
 * start being collected, and only when it falls back to quiet for long enough
 * is that collected audio handed to Whisper. A quiet yard costs nothing.
 *
 * This is the same shape as a wake-word engine, with a much dumber trigger:
 * openWakeWord would replace the level check with a real model and would fire
 * far less often on a slammed door. That is the upgrade path, and it is worth
 * taking only if the false triggers actually annoy her — measured, not
 * assumed.
 *
 * 16 kHz MONO, RESAMPLED HERE
 * --------------------------
 * Whisper wants 16 kHz. The microphone gives 44.1 kHz (proved on her Mac).
 * Resampling in the renderer, where an AudioContext already exists, means the
 * IPC message is a third of the size and the main process gets exactly what
 * the model wants.
 */

(function () {
    'use strict';
    if (window.__jarvisLocalSpeechLoaded) return;
    window.__jarvisLocalSpeechLoaded = true;

    // ── say which path this is, even when the answer is "not here" ───────
    // This used to be a bare `return`. In the desktop app, where the bridge
    // was expected and absent, that produced a page which was silent, a
    // terminal which was silent, and a microphone which did nothing — three
    // symptoms and no cause. Announcing the branch costs one console line and
    // removes an entire class of debugging session.
    //
    // In an ordinary browser this line is INFORMATIONAL, not a warning: no
    // bridge is the correct and expected state there, and dressing it up as a
    // problem would train the reader to ignore it.
    var bridge = window.jarvisSpeech;
    if (!bridge || !bridge.available) {
        console.log('[VOICE] no desktop bridge — using the browser\'s own speech engine');
        return;
    }
    console.log('[VOICE] desktop bridge found — speech will run locally');

    var TARGET_HZ = 16000;
    // ── WHEN IS IT SPEECH? ────────────────────────────────────────────────
    // This was a fixed number, 0.012, which I arrived at by imagining a quiet
    // room. On her MacBook it silently swallowed a whole "Hey Jarvis": the
    // microphone was open, the audio was flowing, and nothing ever crossed
    // the line, so Whisper was never called and NOTHING WAS PRINTED. She had
    // no way to tell that from the feature being broken.
    //
    // A fixed threshold cannot be right anyway. macOS applies automatic gain,
    // built-in and external mics differ by an order of magnitude, and a yard
    // office at 7am and at noon are different rooms. So the gate now measures
    // the room instead of assuming it: a slow average of the quiet gives a
    // NOISE FLOOR, and speech is anything a few times louder than that.
    //
    // The absolute floor below it is a backstop, not the decision — without
    // one, a perfectly silent room drives the floor toward zero and every
    // fan tick becomes speech.
    var TRIGGER_OVER_FLOOR = 3.5;   // times the measured floor
    var ABSOLUTE_FLOOR = 0.004;     // below this it is not speech, whatever the room
    // ASYMMETRIC, and the tests are why. A single adaptation rate of 0.02 was
    // still rejecting normal speech: the floor starts at ABSOLUTE_FLOOR and
    // crawls down so slowly that for the first several seconds the trigger
    // sat at 0.014 — HIGHER than the fixed 0.012 that failed her in the first
    // place. So the room getting quieter is believed quickly, and the room
    // getting louder is believed slowly. That asymmetry is also what stops a
    // passing truck from deafening the gate for the next minute.
    var FLOOR_DOWN = 0.15;          // quiet is learned fast
    var FLOOR_UP = 0.02;            // noise is learned slowly
    // How often to say what it is hearing when nothing is triggering. This
    // exists so "I said Hey Jarvis and nothing happened" produces a NUMBER
    // rather than another round of guessing.
    var REPORT_MS = 4000;
    // How long it must stay quiet before we decide the sentence ended. Shorter
    // than this and it cuts people off mid-pause; longer and every command
    // feels laggy.
    var SILENCE_MS = 700;
    // Hard ceiling on one utterance, so a noisy room cannot grow the buffer
    // without bound and then hand Whisper a minute of audio.
    var MAX_MS = 9000;
    var MIN_MS = 350;      // shorter than this is a door, not a sentence

    function LocalRecognition() {
        this.continuous = true;
        this.interimResults = false;
        this.onresult = null;
        this.onerror = null;
        this.onend = null;
        this.onstart = null;
        this._ctx = null; this._stream = null; this._node = null;
        this._chunks = []; this._collecting = false; this._quietFor = 0; this._heldMs = 0;
        this._voicedMs = 0;
        this._stopped = false;
        // Starts at the absolute floor and adapts downward to a quiet room or
        // upward to a noisy one.
        this._floor = ABSOLUTE_FLOOR;
        this._peak = 0; this._lastReport = 0;
    }

    LocalRecognition.prototype.start = function () {
        var self = this;
        this._stopped = false;
        navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        }).then(function (stream) {
            if (self._stopped) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
            self._stream = stream;
            var ctx = new (window.AudioContext || window.webkitAudioContext)();
            self._ctx = ctx;
            var src = ctx.createMediaStreamSource(stream);

            // ScriptProcessor rather than an AudioWorklet: a worklet needs its
            // own module file fetched over HTTP, and this page is loaded from
            // a remote origin inside a sandboxed window. Deprecated but
            // universally present, and the work per callback here is a loop
            // over 4096 floats.
            var proc = ctx.createScriptProcessor(4096, 1, 1);
            self._node = proc;
            var msPerBuf = (4096 / ctx.sampleRate) * 1000;

            proc.onaudioprocess = function (ev) {
                var buf = ev.inputBuffer.getChannelData(0);
                var sum = 0;
                for (var i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i];
                var rms = Math.sqrt(sum / buf.length);

                // The trigger, measured against this room rather than an
                // imagined one.
                var trigger = Math.max(self._floor * TRIGGER_OVER_FLOOR, ABSOLUTE_FLOOR);
                if (rms > self._peak) self._peak = rms;

                if (rms > trigger) {
                    if (!self._collecting) {
                        self._collecting = true; self._chunks = []; self._heldMs = 0;
                        self._voicedMs = 0;
                        console.log('[VOICE] hearing something — level '
                            + rms.toFixed(4) + ', trigger ' + trigger.toFixed(4));
                    }
                    // ── VOICED time, kept apart from HELD time ───────────
                    // The MIN_MS check used to run on _heldMs, which counts
                    // the 700ms of silence that ENDS every capture. So the
                    // shortest possible capture was ~800ms and the "ignore
                    // short blips" rule could literally never fire — a
                    // slammed door went to Whisper like anything else. Found
                    // by tests/voice-gate.js, not by reading it back.
                    self._voicedMs += msPerBuf;
                    self._quietFor = 0;
                } else {
                    // Only quiet audio teaches the floor, or a long sentence
                    // would drag the threshold up above the speaker's own
                    // voice and cut them off.
                    self._floor += (rms - self._floor)
                        * (rms < self._floor ? FLOOR_DOWN : FLOOR_UP);
                    if (self._collecting) self._quietFor += msPerBuf;
                }

                // ── the "nothing happened" report ────────────────────────
                // Printed only while idle, so it never interleaves with a
                // capture. Four seconds apart: often enough to answer "is it
                // hearing me at all", rare enough not to be noise itself.
                if (!self._collecting) {
                    self._lastReport += msPerBuf;
                    if (self._lastReport >= REPORT_MS) {
                        self._lastReport = 0;
                        console.log('[VOICE] listening — loudest ' + self._peak.toFixed(4)
                            + ', needs ' + trigger.toFixed(4)
                            + (self._peak < trigger ? '  ← too quiet, nothing sent to Whisper' : ''));
                        self._peak = 0;
                    }
                }

                if (self._collecting) {
                    // Copied, not referenced: the same underlying buffer is
                    // reused by the audio thread on the next callback, so
                    // keeping the reference would give Whisper the last frame
                    // repeated N times. A genuinely nasty bug to find later.
                    self._chunks.push(new Float32Array(buf));
                    self._heldMs += msPerBuf;

                    if (self._quietFor >= SILENCE_MS || self._heldMs >= MAX_MS) {
                        var held = self._heldMs;
                        var voiced = self._voicedMs;
                        var chunks = self._chunks;
                        self._collecting = false; self._chunks = []; self._quietFor = 0; self._heldMs = 0;
                        self._voicedMs = 0;
                        self._lastReport = 0; self._peak = 0;
                        if (voiced >= MIN_MS) {
                            console.log('[VOICE] captured ' + Math.round(held) + 'ms ('
                                + Math.round(voiced) + 'ms of speech) — transcribing');
                            self._flush(chunks, ctx.sampleRate);
                        } else {
                            // A door, a cough, a chair. Said out loud because
                            // "it triggered but discarded it" and "it never
                            // triggered" need different fixes.
                            console.log('[VOICE] ignored a ' + Math.round(voiced) + 'ms blip (under '
                                + MIN_MS + 'ms)');
                        }
                    }
                }
            };

            src.connect(proc);
            // Connected to the destination with ZERO gain. ScriptProcessor
            // does not fire unless it is in a live graph, and routing it to
            // the speakers at full volume would play the room back at itself —
            // which is the feedback loop this project has already fought once.
            var mute = ctx.createGain();
            mute.gain.value = 0;
            proc.connect(mute);
            mute.connect(ctx.destination);

            if (self.onstart) self.onstart();
        }).catch(function (e) {
            if (self.onerror) self.onerror({ error: e && e.name === 'NotAllowedError' ? 'not-allowed' : 'audio-capture', message: e && e.message });
            if (self.onend) self.onend();
        });
    };

    LocalRecognition.prototype._flush = function (chunks, rate) {
        var self = this;
        var total = 0, i;
        for (i = 0; i < chunks.length; i += 1) total += chunks[i].length;
        var flat = new Float32Array(total);
        var at = 0;
        for (i = 0; i < chunks.length; i += 1) { flat.set(chunks[i], at); at += chunks[i].length; }

        // Linear resample to 16 kHz. Crude, and correct enough: Whisper is
        // trained on speech at this rate and the artefacts of linear
        // interpolation sit far above the band that carries words.
        var ratio = rate / TARGET_HZ;
        var out = new Float32Array(Math.floor(flat.length / ratio));
        for (i = 0; i < out.length; i += 1) out[i] = flat[Math.floor(i * ratio)] || 0;

        bridge.transcribe(out).then(function (r) {
            if (!r || !r.ok) {
                if (self.onerror) self.onerror({ error: 'engine', message: (r && r.error) || 'transcription failed' });
                return;
            }
            var text = String(r.text || '').trim();
            // Whisper emits these for silence and noise. Passing them on would
            // have the wake matcher chewing on "[BLANK_AUDIO]" all day.
            if (!text || /^[\[\(].*[\]\)]$/.test(text) || text === '.') {
                console.log('[VOICE] Whisper heard nothing usable' + (text ? ' (' + text + ')' : ''));
                return;
            }
            // The single most useful line in this file: what it ACTUALLY
            // heard, which is what the wake matcher then has to match.
            console.log('[VOICE] heard: "' + text + '"');
            if (self.onresult) {
                self.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: true })] });
            }
        }).catch(function (e) {
            if (self.onerror) self.onerror({ error: 'engine', message: e && e.message });
        });
    };

    LocalRecognition.prototype.stop = function () {
        this._stopped = true;
        try { if (this._node) { this._node.onaudioprocess = null; this._node.disconnect(); } } catch (e) {}
        try { if (this._stream) this._stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
        try { if (this._ctx) this._ctx.close(); } catch (e) {}
        this._node = null; this._stream = null; this._ctx = null;
        this._collecting = false; this._chunks = [];
        if (this.onend) this.onend();
    };
    LocalRecognition.prototype.abort = LocalRecognition.prototype.stop;

    // Announced on window so voice.js can prefer it over the browser engine.
    // Named differently from SpeechRecognition on purpose: voice.js should
    // CHOOSE it, not be tricked into thinking the browser grew an engine.
    window.JarvisLocalRecognition = LocalRecognition;

    // Warm the model as soon as the app opens, not when she first speaks.
    // The first load may download ~75MB, and having that happen during her
    // first "Hey Jarvis" would look exactly like the feature not working.
    if (bridge.warm) {
        bridge.warm().then(function (r) {
            if (r && !r.ok) console.warn('[VOICE] local speech engine not ready:', r.error);
            else console.log('[VOICE] local speech engine ready — nothing leaves this Mac');
        });
    }
}());
