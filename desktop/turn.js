// ── desktop/turn.js — has she finished talking? ───────────────────────────
//
// Apsara, 2026-09-06: "use this in jarvis Waveform model reading prosody."
//
// WHAT IT REPLACES
// ----------------
// A 700-millisecond silence timer. That number is a guess and every value is
// wrong in one direction or the other: short enough not to feel laggy is
// short enough to cut her off mid-sentence, and long enough never to cut her
// off makes every command feel slow. There is no correct constant, because
// "have you finished" is not a question about duration.
//
// Smart Turn v3 answers it from PROSODY — the pitch and rhythm of how a
// sentence ends. A person trailing off before a number sounds different from
// a person who has finished, at the same length of pause. BSD-2 licensed,
// with the weights and the training data both open, which is rarer than it
// should be.
//
// TWO THINGS ABOUT THIS MODEL THAT ARE TRAPS
// ------------------------------------------
// Verified against pipecat's own inference code rather than assumed, because
// both would fail silently and plausibly:
//
//   1. IT DOES NOT TAKE A WAVEFORM. The input tensor is `input_features`,
//      shape [1, 80, 800] — a Whisper log-mel spectrogram of exactly 8
//      seconds. The model card's "analyses the raw waveform" describes the
//      system, not the tensor. See melspec.js.
//   2. THE OUTPUT IS NOT A LOGIT. It is named `logits`, and the final node
//      of the graph is a Sigmoid, so it is already a probability. Applying
//      another sigmoid would squash everything toward 0.5 — still a number
//      between 0 and 1, still "working", and wrong on every utterance.
//
// AND IT DEGRADES TO THE OLD TIMER. If onnxruntime is not installed, or the
// model file is missing, this says so and the caller keeps its silence
// timer. An endpointer that fails closed would mean a microphone that never
// decides she has finished.

const path = require('path');
const fs = require('fs');
const os = require('os');

const { logMel, N_MELS, N_FRAMES } = require('./melspec');

// v3.2-cpu: 8.7MB int8, 92.63% accuracy on the published benchmark — a clear
// step over v3.1 (90.13%) and v3.0 (88.97%). The "gpu" variants are simply
// unquantized fp32 and would also run on CPU for about one extra point of
// accuracy at 32MB; not worth it here.
const MODEL_FILE = 'smart-turn-v3.2-cpu.onnx';
const MODEL_URL = 'https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/' + MODEL_FILE;

// Above this, she has finished. Pipecat hardcodes 0.5 and publishes no ROC
// curve, so it is a starting point rather than a tuned value.
//
// Deliberately a little HIGHER than theirs. The two errors are not equal
// here: declaring the turn over too early cuts her off mid-sentence and the
// command is lost, while declaring it too late costs a few hundred
// milliseconds and nothing else. Asymmetric cost, asymmetric threshold.
const COMPLETE_AT = Number(process.env.JARVIS_TURN_THRESHOLD || 0.6);

let session = null;
let loading = null;
let lastError = null;
let ort = null;

function modelPath() {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Jarvis', 'models', MODEL_FILE);
}

async function load() {
    if (session) return session;
    if (loading) return loading;
    loading = (async () => {
        try {
            const file = modelPath();
            if (!fs.existsSync(file)) {
                throw new Error(`turn model missing: ${file}\n`
                    + `  from desktop/:  npm run model:turn`);
            }
            // Required lazily: onnxruntime-node is a native addon and a
            // top-level require would break the test suite on every machine
            // that is not this Mac.
            ort = ort || require('onnxruntime-node');
            session = await ort.InferenceSession.create(file, {
                executionProviders: ['cpu'],
                graphOptimizationLevel: 'all',
                executionMode: 'sequential',
                // Single-threaded on purpose. The model is 8M parameters and
                // runs in milliseconds; spawning threads for it would cost
                // more in scheduling than it saves, and this shares a
                // machine with Whisper and Kokoro.
                interOpNumThreads: 1,
                intraOpNumThreads: 1,
            });
            lastError = null;
            return session;
        } catch (e) {
            lastError = e && e.message ? e.message : String(e);
            throw e;
        } finally {
            loading = null;
        }
    })();
    return loading;
}

// pcm: Float32Array, 16kHz mono, the WHOLE turn so far — not just the newest
// chunk. The model reasons about how the utterance is ending, so handing it
// only the last fragment is an explicit anti-pattern in its documentation.
//
// Returns { ok, complete, probability, ms }. Never throws: the caller falls
// back to its timer, and a rejected promise across IPC says nothing useful.
async function analyse(pcm) {
    const t0 = Date.now();
    try {
        const s = await load();
        const feats = logMel(pcm);
        const input = new ort.Tensor('float32', feats, [1, N_MELS, N_FRAMES]);
        const out = await s.run({ input_features: input });
        const first = out.logits || out[Object.keys(out)[0]];
        const p = Number(first.data[0]);
        return {
            ok: true,
            // NO SIGMOID HERE. The graph already ends in one; see the header.
            probability: p,
            complete: p > COMPLETE_AT,
            ms: Date.now() - t0,
        };
    } catch (e) {
        lastError = e && e.message ? e.message : String(e);
        return { ok: false, error: lastError, ms: Date.now() - t0 };
    }
}

function status() {
    return {
        ready: !!session,
        model: MODEL_FILE,
        path: modelPath(),
        threshold: COMPLETE_AT,
        url: MODEL_URL,
        error: lastError,
    };
}

module.exports = { load, analyse, status, modelPath, MODEL_FILE, MODEL_URL, COMPLETE_AT };
