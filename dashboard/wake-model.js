/* ── dashboard/wake-model.js — "Hey Jarvis" heard by a model, in the page ────
 *
 * Apsara, 2026-09-20: "openWakeWord -> we need it. Why can't we do Hey Jarvis
 * on a low model?"
 *
 * Until now the wake word was found by TRANSCRIBING everything and looking for
 * "Jarvis" in the text. On her recording Chrome wrote it as "Jairus"; the
 * desktop app's energy gate woke on doors. A keyword model answers one
 * question — "was that 'Hey Jarvis'?" — from the sound itself, on this
 * machine, every 80 ms, in about 4% of one core.
 *
 * Measured before shipping, on her own recording (tests/oww-parity.js):
 * 5 of 5 "Hey Jarvis" caught, 0 false wakes across the other ~90 seconds of
 * talk — including Jarvis's own voice saying "Jarvis" — and scores identical
 * to the Python reference implementation.
 *
 * WHAT IT DOES AND DOES NOT CHANGE
 * It is an ADDITIONAL way in. voice.js still has its transcript wake word
 * (and "Hey Scout", which this model does not know); a fire here dispatches
 * the same WAKE_HEARD the transcript path does. If anything here fails — no
 * WebAssembly, the CDN blocked, the mic refused — it says so once and the
 * page behaves exactly as it did before.
 *
 * Runs in Chrome AND in the Mac app, because the Mac app loads this page.
 *
 * LICENCE: code Apache 2.0 (openWakeWord). The hey_jarvis MODEL is CC
 * BY-NC-SA 4.0, non-commercial — replace it with our own trained model before
 * Jarvis is sold. docs/voice-wake-word.md.
 */
(function () {
    'use strict';
    if (window.JarvisWake) return;

    var ORT_VERSION = '1.20.1';
    var ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@' + ORT_VERSION + '/dist/';
    var MODEL_BASE = '/models/oww/';
    var MODELS = {
        melspectrogram: 'melspectrogram.onnx',
        embedding: 'embedding_model.onnx',
        wake: 'hey_jarvis_v0.1.onnx',
    };
    var RING_SECONDS = 10;

    var threshold = 0.5;
    try {
        var saved = parseFloat(localStorage.getItem('jvWakeThreshold'));
        if (saved > 0 && saved < 1) threshold = saved;
    } catch (e) {}

    var api = {
        status: 'off',            // off | loading | on | failed
        error: null,
        onwake: null,             // function (score)
        lastScore: 0,
        peak: 0,                  // highest score since start — for tuning
        fires: 0,
    };

    var sessions = null, core = null, ort = null;
    var stream = null, ctx = null, node = null, srcNode = null;
    var queue = Promise.resolve(), backlog = 0;
    var deafUntil = 0;
    var ring = new Float32Array(16000 * RING_SECONDS), ringPos = 0, ringFill = 0;

    function loadScript(url) {
        return new Promise(function (resolve, reject) {
            var s = document.createElement('script');
            s.src = url; s.async = true;
            s.onload = resolve;
            s.onerror = function () { reject(new Error('could not load ' + url)); };
            document.head.appendChild(s);
        });
    }

    function loadModels() {
        if (sessions) return Promise.resolve(sessions);
        // Threads need cross-origin isolation this page does not have; one
        // thread is plenty for three tiny models every 80 ms (see api.ort).
        return api.ort().then(function () {
            var names = Object.keys(MODELS);
            return Promise.all(names.map(function (n) {
                return ort.InferenceSession.create(MODEL_BASE + MODELS[n], { executionProviders: ['wasm'] });
            })).then(function (list) {
                sessions = {};
                names.forEach(function (n, i) { sessions[n] = list[i]; });
                return sessions;
            });
        });
    }

    function run(name, data, dims) {
        var s = sessions[name], feeds = {};
        feeds[s.inputNames[0]] = new ort.Tensor('float32', data, dims);
        return s.run(feeds).then(function (r) { return r[s.outputNames[0]].data; });
    }

    function remember(samples16k) {
        for (var i = 0; i < samples16k.length; i++) {
            ring[ringPos] = samples16k[i] / 32767;
            ringPos = (ringPos + 1) % ring.length;
        }
        ringFill = Math.min(ring.length, ringFill + samples16k.length);
    }

    // The last `ms` of microphone audio, 16 kHz, -1..1. For the end-of-turn
    // model (turn-model.js), which needs the sound of her sentence ending.
    api.recent = function (ms) {
        var n = Math.min(ringFill, Math.round(16000 * (ms || 8000) / 1000));
        var out = new Float32Array(n);
        for (var i = 0; i < n; i++) out[i] = ring[(ringPos - n + i + ring.length) % ring.length];
        return out;
    };

    // Jarvis's own acknowledgement must not be heard as her.
    api.deafFor = function (ms) { deafUntil = Math.max(deafUntil, Date.now() + (ms || 0)); };

    api.start = function () {
        if (api.status === 'on' || api.status === 'loading') return Promise.resolve(api.status);
        if (!window.WebAssembly || !navigator.mediaDevices || !window.OwwCore) {
            api.status = 'failed'; api.error = 'this browser cannot run the wake model';
            console.log('[WAKE] not available here — the transcript wake word still works');
            return Promise.resolve(api.status);
        }
        api.status = 'loading';
        return loadModels().then(function () {
            core = core || new window.OwwCore.Core({ run: run, threshold: threshold });
            return navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
            });
        }).then(function (s) {
            if (api.status !== 'loading') { s.getTracks().forEach(function (t) { t.stop(); }); return api.status; }
            stream = s;
            var Ctor = window.AudioContext || window.webkitAudioContext;
            ctx = ctx || new Ctor();
            if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(function () {});
            srcNode = ctx.createMediaStreamSource(stream);
            node = ctx.createScriptProcessor(4096, 1, 1);
            var rate = ctx.sampleRate;
            node.onaudioprocess = function (ev) {
                var pcm = window.OwwCore.toModelRate(ev.inputBuffer.getChannelData(0), rate);
                remember(pcm);
                if (Date.now() < deafUntil) return;
                // Never let inference fall behind real time: if the machine
                // is busy, a stale second of audio is dropped, not queued.
                if (backlog > 4) return;
                backlog += 1;
                queue = queue.then(function () { return core.push(pcm); }).then(function (r) {
                    backlog -= 1;
                    if (!r) return;
                    api.lastScore = r.score;
                    if (r.score > api.peak) api.peak = r.score;
                    if (r.fired && Date.now() >= deafUntil) {
                        api.fires += 1;
                        console.log('[WAKE] "Hey Jarvis" — score ' + r.score.toFixed(2));
                        if (typeof api.onwake === 'function') {
                            try { api.onwake(r.score); } catch (e) { console.warn('[WAKE] handler failed:', e.message); }
                        }
                    }
                }).catch(function (e) {
                    backlog = Math.max(0, backlog - 1);
                    console.warn('[WAKE] inference failed:', e.message);
                });
            };
            srcNode.connect(node);
            node.connect(ctx.destination);   // ScriptProcessor only runs when connected; it outputs silence
            api.status = 'on'; api.error = null;
            console.log('[WAKE] listening for "Hey Jarvis" on the device (threshold ' + threshold + ')');
            return api.status;
        }).catch(function (e) {
            api.status = 'failed'; api.error = e.message;
            console.warn('[WAKE] could not start (' + e.message + ') — the transcript wake word still works');
            api.stop(true);
            return api.status;
        });
    };

    api.stop = function (keepStatus) {
        try { if (node) { node.onaudioprocess = null; node.disconnect(); } } catch (e) {}
        try { if (srcNode) srcNode.disconnect(); } catch (e) {}
        try { if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
        node = null; srcNode = null; stream = null;
        if (core) core.reset();
        if (!keepStatus) api.status = 'off';
    };

    // The runtime, shared with dashboard/turn-model.js — one copy of
    // onnxruntime-web per page, loaded once.
    api.ort = function () {
        if (ort) return Promise.resolve(ort);
        var p = window.ort ? Promise.resolve() : loadScript(ORT_BASE + 'ort.min.js');
        return p.then(function () {
            ort = window.ort;
            if (!ort) throw new Error('onnxruntime-web did not load');
            ort.env.wasm.wasmPaths = ORT_BASE;
            ort.env.wasm.numThreads = 1;
            return ort;
        });
    };

    api.threshold = function (v) {
        if (typeof v === 'number' && v > 0 && v < 1) {
            threshold = v;
            if (core) core.threshold = v;
            try { localStorage.setItem('jvWakeThreshold', String(v)); } catch (e) {}
        }
        return threshold;
    };

    window.JarvisWake = api;
}());
