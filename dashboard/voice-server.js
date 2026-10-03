/* ── dashboard/voice-server.js — speech-to-text that is not Chrome's ────────
 *
 * Apsara, 2026-10-03: "I don't want to use Chrome... I want it to work across
 * all browsers and devices", and then: "that's what productionisation of an
 * app means."
 *
 * She is right, and the gap was narrow: of the four parts of Jarvis voice,
 * three were already portable — the wake word and the end-of-turn model are
 * our own ONNX running in WebAssembly, and Jarvis's replies are WAV files the
 * server synthesises. Only TRANSCRIPTION was Chrome's: window.SpeechRecognition
 * is a Google service, absent in Firefox, half-present in Safari, and gone in
 * Electron. So voice.js turned itself off and said "Use Chrome".
 *
 * This is the fourth part, done portably: record the utterance with
 * MediaRecorder — which every current browser has — and POST it to
 * /api/bot/voice-command, the route the phone's mic button has used since
 * August. Same server, same transcriber, no new dependency.
 *
 * ── IT PRETENDS TO BE A SpeechRecognition, ON PURPOSE ──────────────────────
 * Same shape as voice-local.js's LocalRecognition: continuous, interimResults,
 * lang, start/stop/abort, onresult/onerror/onend/onstart. voice.js's state
 * machine — the wake word, the follow-up window, barge-in, the guard mic — is
 * two thousand lines of behaviour she has already corrected a dozen times.
 * Rewriting any of it for a second engine would mean two sets of bugs, so the
 * engine swaps underneath and nothing above it changes.
 *
 * ── WHAT IT DOES NOT DO, AND WHY ───────────────────────────────────────────
 * No interim results. Chrome shows words as you speak because the audio is
 * streaming to Google; here the utterance is transcribed after it ends, so the
 * sentence appears when it lands. Roughly a second slower and it cannot be
 * faked honestly, so it is not faked.
 *
 * It also never records continuously. Uploading the room all day would cost
 * money per minute and record everything said near her desk. So this engine
 * records ONE utterance at a time, started either by the wake-word model
 * (which runs locally and for free) or by her tapping the button. `continuous`
 * is accepted and then applied as "after a turn finishes, wait to be started
 * again" rather than "keep the microphone open".
 */
(function () {
    'use strict';
    if (window.JarvisServerRecognition) return;

    // Overridable through window.JARVIS_STT_TUNING, which exists for two
    // reasons: the suite can run a turn in milliseconds instead of seconds,
    // and a microphone in a noisy yard can be given a higher speech threshold
    // from the console without a rebuild.
    var T = window.JARVIS_STT_TUNING || {};
    var ENDPOINT = T.endpoint || '/api/bot/voice-command';
    var SILENCE_MS = T.silenceMs || 900;        // quiet long enough to mean "finished"
    var MIN_VOICED_MS = T.minVoicedMs || 250;   // shorter than this is a cough, not a command
    var MAX_UTTERANCE_MS = T.maxMs || 12000;    // a hard stop, so nothing records for ever
    var LEAD_IN_MS = T.leadInMs || 6000;        // no speech at all by now: close and say so
    var TICK_MS = T.tickMs || 60;
    var RMS_SPEAKING = T.rmsSpeaking || 0.012;  // tuned against a laptop mic with the browser's
    var RMS_QUIET = T.rmsQuiet || 0.006;        // own noise suppression already applied

    function pickMime() {
        // Safari produces audio/mp4, Chrome and Firefox audio/webm. Gemini
        // takes all three; the server is told which one it got.
        var want = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', ''];
        for (var i = 0; i < want.length; i += 1) {
            if (!want[i]) return '';
            try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(want[i])) return want[i]; } catch (e) {}
        }
        return '';
    }

    function supported() {
        return !!(window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    }

    function ServerRecognition() {
        this.continuous = false;
        this.interimResults = false;
        this.lang = 'en-US';
        this.maxAlternatives = 1;
        this.onresult = null;
        this.onerror = null;
        this.onend = null;
        this.onstart = null;
        this._stream = null;
        this._rec = null;
        this._chunks = [];
        this._ctx = null;
        this._timers = [];
        this._deafUntil = 0;
        this._live = false;
        this._aborted = false;
    }

    // Jarvis's own voice must not be transcribed back at it. voice.js calls
    // this for exactly the length of what it is about to say, the same way it
    // deafens the wake-word model.
    ServerRecognition.prototype.ignoreFor = function (ms) {
        this._deafUntil = Date.now() + (Number(ms) || 0);
    };

    ServerRecognition.prototype._clearTimers = function () {
        for (var i = 0; i < this._timers.length; i += 1) clearTimeout(this._timers[i]);
        this._timers = [];
    };

    ServerRecognition.prototype._teardown = function () {
        this._clearTimers();
        try { if (this._rec && this._rec.state !== 'inactive') this._rec.stop(); } catch (e) {}
        try {
            if (this._stream) this._stream.getTracks().forEach(function (t) { t.stop(); });
        } catch (e) {}
        // The microphone track is released after every turn, not held open.
        // On iOS a stream left running keeps the audio session in record mode
        // and the next reply comes out of the earpiece instead of the speaker.
        this._stream = null;
        try { if (this._ctx && this._ctx.close) this._ctx.close(); } catch (e) {}
        this._ctx = null;
        this._rec = null;
        this._live = false;
    };

    ServerRecognition.prototype._fail = function (name, message) {
        var self = this;
        this._teardown();
        if (self.onerror) self.onerror({ error: name, message: message || name });
        if (self.onend) self.onend();
    };

    ServerRecognition.prototype.start = function () {
        var self = this;
        if (self._live) return;
        if (!supported()) { self._fail('service-not-allowed', 'this browser cannot record audio'); return; }
        self._aborted = false;
        self._live = true;
        self._chunks = [];

        navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        }).then(function (stream) {
            if (self._aborted) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
            self._stream = stream;
            var mime = pickMime();
            try { self._rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
            catch (e) { self._fail('audio-capture', 'MediaRecorder refused this microphone: ' + e.message); return; }

            self._rec.ondataavailable = function (ev) { if (ev.data && ev.data.size) self._chunks.push(ev.data); };
            self._rec.onstop = function () { self._finish(); };
            self._rec.start();
            if (self.onstart) self.onstart();

            // ── WHEN HAS SHE FINISHED? ───────────────────────────────────
            // The same two-part answer voice.js already uses for Chrome: a
            // quiet gap, and — when the end-of-turn model has loaded — how the
            // sentence SOUNDS. A falling, finished sentence ends the turn
            // sooner; a dangling one waits.
            var ctxCtor = window.AudioContext || window.webkitAudioContext;
            if (!ctxCtor) { self._timers.push(setTimeout(function () { self.stop(); }, 4000)); return; }
            self._ctx = new ctxCtor();
            var src = self._ctx.createMediaStreamSource(stream);
            var an = self._ctx.createAnalyser();
            an.fftSize = 1024;
            src.connect(an);
            var buf = new Float32Array(an.fftSize);
            var voicedMs = 0, quietMs = 0, startedAt = Date.now(), lastAt = Date.now();

            var tick = function () {
                if (!self._live) return;
                var dt = Date.now() - lastAt;
                lastAt = Date.now();
                an.getFloatTimeDomainData(buf);
                var sum = 0;
                for (var i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i];
                var rms = Math.sqrt(sum / buf.length);
                var deaf = Date.now() < self._deafUntil;

                if (!deaf && rms > RMS_SPEAKING) { voicedMs += dt; quietMs = 0; }
                else if (rms < RMS_QUIET) { quietMs += dt; }

                if (voicedMs >= MIN_VOICED_MS && quietMs >= SILENCE_MS) { self.stop(); return; }
                if (voicedMs < MIN_VOICED_MS && Date.now() - startedAt > LEAD_IN_MS) {
                    // Nothing was ever said. Reported as "didn't catch that"
                    // rather than sent to be transcribed — silence costs a
                    // round trip and comes back empty anyway.
                    self._aborted = true;
                    self._fail('no-speech', 'nothing was said');
                    return;
                }
                if (Date.now() - startedAt > MAX_UTTERANCE_MS) { self.stop(); return; }
                self._timers.push(setTimeout(tick, TICK_MS));
            };
            self._timers.push(setTimeout(tick, TICK_MS));
        }).catch(function (e) {
            self._fail(e && e.name === 'NotAllowedError' ? 'not-allowed' : 'audio-capture',
                (e && e.message) || 'microphone unavailable');
        });
    };

    // Ends the recording. The transcription happens in _finish, off the back
    // of MediaRecorder's own stop event, so nothing is lost mid-flush.
    ServerRecognition.prototype.stop = function () {
        this._clearTimers();
        if (this._rec && this._rec.state !== 'inactive') { try { this._rec.stop(); return; } catch (e) {} }
        if (this._live) { this._teardown(); if (this.onend) this.onend(); }
    };

    // Thrown away, not transcribed: abort is what barge-in and "shut up" call,
    // and sending the audio anyway would answer a question she retracted.
    ServerRecognition.prototype.abort = function () {
        this._aborted = true;
        var had = this._live;
        this._teardown();
        if (had && this.onend) this.onend();
    };

    ServerRecognition.prototype._finish = function () {
        var self = this;
        var chunks = self._chunks;
        var mime = (self._rec && self._rec.mimeType) || pickMime() || 'audio/webm';
        self._teardown();
        if (self._aborted) { if (self.onend) self.onend(); return; }
        if (!chunks.length) { if (self.onerror) self.onerror({ error: 'no-speech', message: 'nothing recorded' }); if (self.onend) self.onend(); return; }

        var blob = new Blob(chunks, { type: mime });
        var reader = new FileReader();
        reader.onloadend = function () {
            var b64 = String(reader.result || '').split(',')[1] || '';
            if (!b64) { if (self.onerror) self.onerror({ error: 'audio-capture', message: 'the recording was empty' }); if (self.onend) self.onend(); return; }
            var headers = { 'Content-Type': 'application/json' };
            // The dashboard's own helper adds the session header; this file is
            // loaded beside it, so it borrows it rather than inventing a
            // second way to authenticate.
            try { if (window.jarvisAuthHeaders) Object.assign(headers, window.jarvisAuthHeaders()); } catch (e) {}
            window.fetch(ENDPOINT, {
                method: 'POST', credentials: 'same-origin', headers: headers,
                body: JSON.stringify({ audio_base64: b64, mime_type: mime.split(';')[0] }),
            }).then(function (r) {
                return r.json().then(function (j) { return { ok: r.ok, status: r.status, j: j }; });
            }).then(function (out) {
                if (self._aborted) { if (self.onend) self.onend(); return; }
                var text = out.j && (out.j.text || out.j.transcript);
                if (!out.ok || !text) {
                    // 422 is the server saying it could not make out the
                    // recording — her words for it are "didn't catch that",
                    // which is the same thing Chrome's 'no-speech' means, so
                    // it is reported the same way and handled by one branch.
                    var name = out.status === 422 ? 'no-speech' : (out.status === 401 ? 'not-allowed' : 'network');
                    if (self.onerror) self.onerror({ error: name, message: (out.j && out.j.error) || ('HTTP ' + out.status) });
                    if (self.onend) self.onend();
                    return;
                }
                if (self.onresult) {
                    self.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: true })] });
                }
                if (self.onend) self.onend();
            }).catch(function (e) {
                if (self.onerror) self.onerror({ error: 'network', message: (e && e.message) || 'could not reach the server' });
                if (self.onend) self.onend();
            });
        };
        reader.readAsDataURL(blob);
    };

    ServerRecognition.supported = supported;
    ServerRecognition.engine = 'server';
    window.JarvisServerRecognition = ServerRecognition;
    console.log('[VOICE] server transcription available — this browser needs no speech API of its own');
}());
