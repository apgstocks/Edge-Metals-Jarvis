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

    var bridge = window.jarvisSpeech;
    if (!bridge || !bridge.available) return;      // not the desktop app

    var TARGET_HZ = 16000;
    // Loudness above which we start collecting. RMS on a normalised buffer, so
    // this is not decibels — it is a level found by listening to a quiet room
    // rather than derived. Deliberately generous: a missed command is worse
    // than an occasional wasted transcription of a cough.
    var SPEECH_LEVEL = 0.012;
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
        this._stopped = false;
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

                if (rms > SPEECH_LEVEL) {
                    if (!self._collecting) { self._collecting = true; self._chunks = []; self._heldMs = 0; }
                    self._quietFor = 0;
                } else if (self._collecting) {
                    self._quietFor += msPerBuf;
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
                        var chunks = self._chunks;
                        self._collecting = false; self._chunks = []; self._quietFor = 0; self._heldMs = 0;
                        if (held >= MIN_MS) self._flush(chunks, ctx.sampleRate);
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
            if (!text || /^[\[\(].*[\]\)]$/.test(text) || text === '.') return;
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
