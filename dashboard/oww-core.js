// ── dashboard/oww-core.js — "Hey Jarvis" as a keyword model, not a transcript
//
// Apsara, 2026-09-20: "openWakeWord -> we need it. Why can't we do Hey Jarvis
// on a low model?" We can. This is openWakeWord's streaming pipeline (Apache
// 2.0, github.com/dscripka/openWakeWord, openwakeword/utils.py
// AudioFeatures + model.py Model.predict) ported line for line, so the SAME
// three ONNX files give the SAME scores in Chrome, in the Mac app and in the
// Python reference. tests/oww-parity.js holds that: it replays her own
// recording through this file and through the Python package and compares.
//
// THE PIPELINE, per 80 ms of 16 kHz audio (1280 samples)
//   1. melspectrogram.onnx over the newest 1280 samples plus 480 of context
//      → a few 32-bin mel frames, transformed x/10 + 2 (openWakeWord's
//      correction toward Google's TF implementation), appended to a buffer
//      that starts as 76 rows of ones.
//   2. embedding_model.onnx (Google's speech_embedding) over the newest 76
//      mel frames → one 96-number feature vector.
//   3. the wake-word model over the newest 16 feature vectors → a score 0..1.
// The first 5 scores are forced to 0, as upstream does, because the buffers
// are still mostly start-up filler.
//
// This file does no I/O and knows no runtime: the caller passes `run(name,
// Float32Array, dims) → Promise<Float32Array>`, so onnxruntime-web (browser)
// and onnxruntime-node (desktop, tests) both drive it.
//
// LICENCE NOTE, the one that matters: the CODE here is Apache 2.0. The
// PRE-TRAINED hey_jarvis model is CC BY-NC-SA 4.0 — non-commercial. Fine for
// Edge Metals trying it; replace it with a model trained with openWakeWord's
// own (Apache) trainer before Jarvis is sold. See docs/voice-wake-word.md.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.OwwCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    var CHUNK = 1280;            // 80 ms at 16 kHz
    var CONTEXT = 160 * 3;       // upstream: raw[-n_samples - 160*3:]
    var MEL_BINS = 32;
    var EMB_WINDOW = 76;
    var EMB_DIM = 96;
    var MEL_MAX = 10 * 97;
    var FEAT_MAX = 120;
    var WW_FRAMES = 16;

    function Core(opts) {
        var o = opts || {};
        if (typeof o.run !== 'function') throw new Error('OwwCore needs run(name, data, dims)');
        this.run = o.run;
        this.threshold = o.threshold == null ? 0.5 : o.threshold;
        this.debounceMs = o.debounceMs == null ? 3000 : o.debounceMs;   // one phrase scores high for ~1.5 s
        this.wwName = o.wakeModel || 'wake';
        this.reset();
    }

    Core.prototype.reset = function () {
        this.raw = new Float32Array(0);
        this.pending = [];                     // samples waiting to make a whole chunk
        this.mel = [];                         // array of Float32Array(32)
        for (var i = 0; i < EMB_WINDOW; i++) { var r = new Float32Array(MEL_BINS); r.fill(1); this.mel.push(r); }
        this.feat = [];                        // array of Float32Array(96)
        this.nPred = 0;
        this.lastFire = -Infinity;
        this.clock = 0;                        // ms of audio consumed
        this.ready = false;
    };

    // Upstream seeds the feature buffer with the embeddings of 4 s of random
    // int16 noise rather than zeros; the model was trained against that
    // start-up state, so it is reproduced rather than "tidied".
    Core.prototype.warm = async function () {
        var n = 16000 * 4, noise = new Float32Array(n);
        for (var i = 0; i < n; i++) noise[i] = Math.floor(Math.random() * 2000) - 1000;
        var spec = await this._melspec(noise);
        for (var s = 0; s + EMB_WINDOW <= spec.length; s += 8) {
            this.feat.push(await this._embed(spec.slice(s, s + EMB_WINDOW)));
        }
        this.ready = true;
    };

    Core.prototype._melspec = async function (samples) {
        var out = await this.run('melspectrogram', samples, [1, samples.length]);
        var frames = out.length / MEL_BINS, rows = [];
        for (var f = 0; f < frames; f++) {
            var r = new Float32Array(MEL_BINS);
            for (var b = 0; b < MEL_BINS; b++) r[b] = out[f * MEL_BINS + b] / 10 + 2;
            rows.push(r);
        }
        return rows;
    };

    Core.prototype._embed = async function (rows) {
        var x = new Float32Array(EMB_WINDOW * MEL_BINS);
        for (var i = 0; i < EMB_WINDOW; i++) x.set(rows[i], i * MEL_BINS);
        var out = await this.run('embedding', x, [1, EMB_WINDOW, MEL_BINS, 1]);
        return Float32Array.from(out.subarray ? out.subarray(0, EMB_DIM) : out.slice(0, EMB_DIM));
    };

    // Feed any number of samples (int16 values as floats, i.e. -32768..32767).
    // Resolves to { score, fired } for the last whole chunk processed, or null
    // if no whole chunk was completed.
    Core.prototype.push = async function (samples) {
        if (!this.ready) await this.warm();
        for (var i = 0; i < samples.length; i++) this.pending.push(samples[i]);
        var last = null;
        while (this.pending.length >= CHUNK) {
            var chunk = this.pending.splice(0, CHUNK);
            last = await this._step(Float32Array.from(chunk));
        }
        return last;
    };

    Core.prototype._step = async function (chunk) {
        var keep = CHUNK + CONTEXT;
        var joined = new Float32Array(Math.min(this.raw.length + chunk.length, 16000 * 10));
        var src = this.raw.length + chunk.length > joined.length ? this.raw.subarray(this.raw.length + chunk.length - joined.length) : this.raw;
        joined.set(src, 0); joined.set(chunk, src.length);
        this.raw = joined;
        this.clock += 80;

        var tail = this.raw.subarray(Math.max(0, this.raw.length - keep));
        var rows = await this._melspec(Float32Array.from(tail));
        for (var r = 0; r < rows.length; r++) this.mel.push(rows[r]);
        if (this.mel.length > MEL_MAX) this.mel.splice(0, this.mel.length - MEL_MAX);

        if (this.mel.length >= EMB_WINDOW) {
            this.feat.push(await this._embed(this.mel.slice(this.mel.length - EMB_WINDOW)));
            if (this.feat.length > FEAT_MAX) this.feat.splice(0, this.feat.length - FEAT_MAX);
        }

        var x = new Float32Array(WW_FRAMES * EMB_DIM);
        var from = this.feat.length - WW_FRAMES;
        for (var k = 0; k < WW_FRAMES; k++) x.set(this.feat[from + k], k * EMB_DIM);
        var out = await this.run(this.wwName, x, [1, WW_FRAMES, EMB_DIM]);
        var score = out[0];
        this.nPred += 1;
        if (this.nPred <= 5) score = 0;       // upstream: first 5 frames are start-up

        var fired = false;
        if (score >= this.threshold && (this.clock - this.lastFire) >= this.debounceMs) {
            fired = true; this.lastFire = this.clock;
        }
        return { score: score, fired: fired, atMs: this.clock };
    };

    // Float32 -1..1 at any rate → int16-scaled 16 kHz, by linear
    // interpolation. Browsers hand over 44.1/48 kHz; the model wants 16.
    function toModelRate(input, fromRate) {
        if (fromRate === 16000) {
            var same = new Float32Array(input.length);
            for (var j = 0; j < input.length; j++) same[j] = Math.max(-1, Math.min(1, input[j])) * 32767;
            return same;
        }
        var ratio = fromRate / 16000, n = Math.floor(input.length / ratio), out = new Float32Array(n);
        for (var i = 0; i < n; i++) {
            var p = i * ratio, a = Math.floor(p), f = p - a;
            var v = input[a] * (1 - f) + (input[Math.min(a + 1, input.length - 1)] || 0) * f;
            out[i] = Math.max(-1, Math.min(1, v)) * 32767;
        }
        return out;
    }

    return { Core: Core, toModelRate: toModelRate, CHUNK: CHUNK };
}));
