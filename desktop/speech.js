// ── desktop/speech.js — transcription, inside the app, on this Mac ────────
//
// Apsara, after being told the desktop app could not do voice: "i want voice
// in desktop app."
//
// WHAT WAS ACTUALLY BROKEN
// -----------------------
// Not the microphone. Proved on her machine before writing a line of this:
//
//   navigator.mediaDevices.getUserMedia({audio:true})
//   → MIC OK  Default — MacBook Pro Microphone (Built-in)  live  44100
//
// Electron captures audio perfectly. What it cannot do is TRANSCRIBE, because
// Chrome's SpeechRecognition is a Google service reached with private API
// keys that Chrome ships and Electron may not. The renderer proved that too:
// "SPEECH ERROR: network", instantly, every time.
//
// So the split is: the window keeps the microphone, and this process does the
// listening-comprehension. whisper.cpp runs the model locally, on the CPU/GPU
// of this Mac, and nothing leaves the machine.
//
// WHY THIS IS BETTER THAN WHAT CHROME DOES, not just a workaround
// --------------------------------------------------------------
// The Chrome path uploads her audio to Google to be transcribed. This does
// not. For a yard where people say supplier names, prices and payment
// details out loud near a laptop, that is a real difference rather than a
// technicality.
//
// WHY NOT A WAKE-WORD ENGINE YET
// ------------------------------
// openWakeWord is the right long-term answer for the "always listening" half
// and it is genuinely free and MIT-licensed. It also needs a trained model,
// ONNX runtime, and a tuning pass to stop it firing at the radio. This
// version gets voice WORKING first with one dependency, using a cheap energy
// gate in the renderer so Whisper only ever sees audio that might be speech.
// If the false-accept rate is annoying in practice, that is when the wake
// engine earns its complexity — measured, rather than assumed.

const path = require('path');
const fs = require('fs');
const os = require('os');

// ── WHICH MODEL ──────────────────────────────────────────────────────────
// Best available wins, biggest first, because Apsara asked for a better one
// and the failure mode of naming a fixed default is that a downloaded model
// sits on disk unused. An explicit JARVIS_WHISPER_MODEL still overrides.
//
// Sizes and the trade-off, on an M2 with Metal, for a 2-3 second command:
//   tiny.en    77MB   fastest, guesses at proper nouns — where we started
//   base.en   148MB   noticeably better, still well under a second
//   small.en  488MB   better again; about 1-2s, which is still fine here
//   medium.en 1.5GB   diminishing returns for short yard commands
//
// Accuracy is not only size. The initial_prompt below is worth more than a
// step up this list for the specific problem of hearing "Jarvis" correctly.
const MODEL_PREFERENCE = ['medium.en', 'small.en', 'base.en', 'tiny.en'];

function pickModel() {
    if (process.env.JARVIS_WHISPER_MODEL) return process.env.JARVIS_WHISPER_MODEL;
    try {
        const dir = modelDir();
        for (const m of MODEL_PREFERENCE) {
            if (fs.existsSync(path.join(dir, `ggml-${m}.bin`))) return m;
        }
    } catch (e) { /* fall through to the default */ }
    return 'tiny.en';
}

let whisper = null;      // the loaded model, kept warm between utterances
let chosen = null;       // which model load() actually settled on
let loading = null;      // in-flight load, so two calls do not load twice
let lastError = null;

function modelDir() {
    // Under the user's data dir, not inside the .app bundle: the bundle is
    // read-only once installed and code-signed, and a model downloaded into
    // it would break the signature.
    return path.join(os.homedir(), 'Library', 'Application Support', 'Jarvis', 'models');
}

// Loads the model once and keeps it. THE FIRST CALL IS SLOW — it may download
// ~75MB — and every call after it is not, which is why this is separated from
// transcribe() and why the caller is told to warm it at startup rather than
// on the first thing she says.
async function load() {
    if (whisper) return whisper;
    if (loading) return loading;
    loading = (async () => {
        try {
            const { Whisper } = require('smart-whisper');
            const dir = modelDir();
            fs.mkdirSync(dir, { recursive: true });
            chosen = pickModel();
            const file = path.join(dir, `ggml-${chosen}.bin`);
            if (!fs.existsSync(file)) {
                throw new Error(`model missing: ${file}\n`
                    + `Download it once with:\n`
                    + `  curl -L -o "${file}" \\\n`
                    + `    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${chosen}.bin\n`
                    + `or, from desktop/:  npm run model -- ${chosen}`);
            }
            whisper = new Whisper(file, { gpu: true });   // Metal on Apple Silicon
            lastError = null;
            return whisper;
        } catch (e) {
            // Recorded rather than thrown away: the renderer asks for this to
            // explain itself on screen instead of silently not listening,
            // which is the failure mode this whole day has been about.
            lastError = e.message;
            throw e;
        } finally {
            loading = null;
        }
    })();
    return loading;
}

// ── turning whatever came back into a sentence ────────────────────────────
// This used to be `(result || []).map(s => s.text).join(' ')`, written from
// smart-whisper's TYPINGS, which declare `task.result` as
// `Promise<TranscribeResult[]>`. On her M2 it threw:
//
//     [VOICE] local engine error: (result || []).map is not a function
//
// So the shipped .d.ts and the native binding disagree, and the .d.ts is a
// hand-written description of a C++ addon rather than anything the compiler
// checked. Believing it was the mistake.
//
// Rather than guess a second time, this accepts every shape the addon
// plausibly returns and LOGS the one it actually saw, once. The alternative —
// another round of me picking a shape and her running it — is how the last
// hour went.
let shapeLogged = false;
function sentence(raw) {
    if (raw == null) return '';
    if (typeof raw === 'string') return raw.trim();

    if (!shapeLogged) {
        shapeLogged = true;
        const keys = (raw && typeof raw === 'object' && !Array.isArray(raw))
            ? Object.keys(raw).join(',') : '';
        console.log(`[SPEECH] result shape: ${Array.isArray(raw) ? 'array' : typeof raw}`
            + (keys ? ` {${keys}}` : '')
            + ` — sample ${JSON.stringify(raw).slice(0, 200)}`);
    }

    // Segments, the documented shape.
    if (Array.isArray(raw)) {
        return raw.map((s) => (s && typeof s === 'object' ? (s.text || '') : String(s || '')))
            .join(' ').replace(/\s+/g, ' ').trim();
    }
    if (typeof raw === 'object') {
        // A single segment, or a wrapper around the real list. Checked in that
        // order because a wrapper that ALSO has .text would otherwise be
        // reduced to its own summary field.
        for (const k of ['segments', 'results', 'result', 'transcription']) {
            if (Array.isArray(raw[k])) return sentence(raw[k]);
        }
        if (typeof raw.text === 'string') return raw.text.trim();
    }
    return '';
}

// pcm is Float32 mono at 16 kHz — resampled in the renderer, because the
// AudioContext there already has the machinery and shipping 44.1 kHz over IPC
// would be nearly three times the bytes for no gain.
// ── whisper.cpp will not look at less than a second ──────────────────────
// Its own words, from her terminal:
//
//   whisper_full_with_state: input is too short - 920 ms < 1000 ms.
//   consider padding the input audio with silence
//
// and then an empty result. A short "Hey Jarvis" is EXACTLY the case this
// application is built around, so this is not an edge case, it is the normal
// one. Padded with silence, as the model itself suggests.
//
// Padding is safe: whisper pads internally to a 30-second window regardless,
// so trailing silence changes nothing about the decode except that it is
// allowed to happen at all. Done HERE rather than in the renderer because it
// is whisper's constraint, not the microphone's — anything that ever calls
// this gets the same protection.
const MIN_SAMPLES = 16000 * 1.2;      // 1.2s at 16kHz, comfortably over the 1s floor

function padded(pcm) {
    if (!pcm || pcm.length >= MIN_SAMPLES) return pcm;
    const out = new Float32Array(MIN_SAMPLES);   // zero-filled: silence
    out.set(pcm, 0);
    return out;
}

// ── TELLING THE MODEL WHAT IT IS ABOUT TO HEAR ───────────────────────────
// Whisper accepts an initial_prompt: text it treats as the preceding
// context, which biases decoding toward those words. This is the single
// cheapest accuracy win available, and it is aimed at the exact failure
// Apsara hit — a clear "Hey Jarvis" coming back as "I'll see you later".
//
// "Jarvis" is a rare token; the model reaches for common words that sound
// like it. Naming it here, alongside the rest of the vocabulary this yard
// actually uses, makes those words cheap for the decoder to choose.
//
// Kept SHORT and factual on purpose. A long or narrative prompt makes
// whisper hallucinate its style into silence — it will happily invent a
// sentence in the register you gave it when it hears nothing at all.
const PROMPT = 'Jarvis. Edge Metals yard. Loads, trucker bills, suppliers, '
    + 'inventory, petty cash, invoices. Payments by Zelle, wire, cash, card. '
    + 'Copper, brass, aluminium, steel, radiators.';

async function transcribe(pcm) {
    const model = await load();
    const audio = padded(pcm);
    const task = await model.transcribe(audio, {
        language: 'en',
        suppress_non_speech_tokens: true,
        initial_prompt: PROMPT,
        // Each utterance is decoded ALONE. Without this, whisper carries
        // context between calls and will continue an earlier sentence into
        // a new one — which, on short independent commands, produces
        // confident nonsense rather than a blank.
        no_context: true,
        // Greedy decoding takes the first plausible word; beam search keeps
        // several candidates and picks the best whole sentence. On a 2-3
        // second clip with a tiny model that difference is worth far more
        // than the few hundred milliseconds it costs.
        beam_size: 5,
        temperature: 0,
    });
    return sentence(await task.result);
}

function status() {
    return {
        ready: !!whisper,
        model: chosen,
        dir: modelDir(),
        error: lastError,
    };
}

module.exports = { load, transcribe, status, modelDir, pickModel, MODEL_PREFERENCE,
    get MODEL() { return chosen; } };
