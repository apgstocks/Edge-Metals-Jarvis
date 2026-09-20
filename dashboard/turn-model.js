/* ── dashboard/turn-model.js — "has she finished?", in Chrome ───────────────
 *
 * Apsara, 2026-09-20, after reading how Siri works: "Endpointing: deciding
 * you've finished — work on this."
 *
 * In Chrome the end of her sentence was 1.2 seconds with no new words. Too
 * short when she pauses to think ("send a mail to… Zimex"), too long when she
 * has plainly finished. Siri decides from HOW the sentence ends — the fall of
 * the voice — not from a clock.
 *
 * The Mac app already does this (desktop/turn.js, Smart Turn v3.2, BSD-2).
 * This is the same model in the page, on the same sound: dashboard/
 * wake-model.js keeps the last few seconds of microphone audio, and this
 * reads them. Same features too — /melspec.js is desktop/melspec.js itself.
 *
 * Fails open to the old clock: no model, no WebAssembly, a slow answer →
 * voice.js ends the turn on silence exactly as before.
 */
(function () {
    'use strict';
    if (window.JarvisTurn) return;

    var MODEL_URL = 'https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-cpu.onnx';
    var COMPLETE_AT = 0.6;              // desktop/turn.js's threshold
    var api = { status: 'off', error: null, lastProbability: null, lastMs: null };
    var session = null, loading = null;

    function loadScript(url) {
        return new Promise(function (resolve, reject) {
            var s = document.createElement('script');
            s.src = url; s.async = true; s.onload = resolve;
            s.onerror = function () { reject(new Error('could not load ' + url)); };
            document.head.appendChild(s);
        });
    }

    api.load = function () {
        if (session) return Promise.resolve(session);
        if (loading) return loading;
        api.status = 'loading';
        loading = (window.JarvisMelspec ? Promise.resolve() : loadScript('/melspec.js'))
            .then(function () {
                if (!window.JarvisMelspec) throw new Error('melspec did not load');
                if (!window.JarvisWake || !window.JarvisWake.ort) throw new Error('no onnxruntime (wake model not loaded)');
                return window.JarvisWake.ort();
            })
            .then(function (ort) {
                return ort.InferenceSession.create(MODEL_URL, { executionProviders: ['wasm'] });
            })
            .then(function (s) {
                session = s; api.status = 'on'; api.error = null;
                console.log('[TURN] end-of-turn model ready — the pause length no longer decides alone');
                return s;
            })
            .catch(function (e) {
                api.status = 'failed'; api.error = e.message;
                console.warn('[TURN] unavailable (' + e.message + ') — ending turns on silence as before');
                throw e;
            })
            .then(function (s) { loading = null; return s; }, function (e) { loading = null; throw e; });
        return loading;
    };

    // pcm: Float32Array, 16 kHz, -1..1 — the sound of the turn so far.
    // Resolves { ok, probability, complete, ms }.
    api.analyse = function (pcm) {
        var t0 = Date.now();
        if (!session) return Promise.resolve({ ok: false, error: api.error || 'not loaded', ms: 0 });
        try {
            var M = window.JarvisMelspec;
            var feats = M.logMel(pcm);
            var ort = window.ort;
            var feeds = {};
            feeds[session.inputNames[0]] = new ort.Tensor('float32', feats, [1, M.N_MELS, M.N_FRAMES]);
            return session.run(feeds).then(function (out) {
                // Already a probability: the graph ends in a Sigmoid (see
                // desktop/turn.js — applying another would be a quiet bug).
                var p = Number(out[session.outputNames[0]].data[0]);
                api.lastProbability = p; api.lastMs = Date.now() - t0;
                return { ok: true, probability: p, complete: p > COMPLETE_AT, ms: api.lastMs };
            }).catch(function (e) { return { ok: false, error: e.message, ms: Date.now() - t0 }; });
        } catch (e) {
            return Promise.resolve({ ok: false, error: e.message, ms: Date.now() - t0 });
        }
    };

    window.JarvisTurn = api;
}());
