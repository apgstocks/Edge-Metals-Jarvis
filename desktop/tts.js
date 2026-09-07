// ── desktop/tts.js — the voice Jarvis answers in ──────────────────────────
//
// Apsara, 2026-09-06: "the jarvis voice looks more robot", then "I dont
// understand.. why cant this work like siri", then: build it properly.
//
// WHY A VOICE PICKER COULD NOT FIX THIS
// ------------------------------------
// I first tried choosing a better voice from JavaScript. That cannot work in
// the desktop app, and the reason is worth writing down so nobody tries again:
//
//   Chromium's macOS speech bridge DISCARDS the native voice identifier and
//   matches voices BY NAME. Compact "Samantha" and Premium "Samantha" have
//   identical `name` and `lang`, so from the Web Speech API they are the same
//   voice — and the compact one, the 2005-sounding one, wins. Chrome's own
//   "Google …" voices need an API key Electron does not ship, so they are
//   absent here entirely.
//
// So the browser's speech engine has a ceiling, and she was hearing it. The
// only ways past it are the macOS system-voice setting (which Chromium does
// honour, and which the picker still offers) or bringing our own synthesiser.
// This file is the second one.
//
// WHY KOKORO
// ----------
// Kokoro-82M: Apache-2.0, weights included, 86MB at q8 — genuinely
// redistributable, unlike XTTS (non-commercial weights from a company that no
// longer exists to license them) or Piper (relicensed to GPL-3 in 2025).
//
// It is also the highest-rated OPEN model on TTS Arena, close to ElevenLabs
// Flash, and it is non-autoregressive — StyleTTS2 + iSTFTNet, no diffusion —
// so its latency is deterministic rather than a function of how much it feels
// like generating. On an M2 that means several times faster than real time on
// CPU, which is the whole reason it is viable next to Whisper.
//
// Two of its 54 voices are actually good (graded A and A-); most are not. Only
// those are offered. A long list of mediocre voices is not a feature.
//
// IT RUNS IN THE MAIN PROCESS, NOT THE PAGE
// -----------------------------------------
// The renderer shows a REMOTE page. Loading an 86MB model there would mean
// fetching it over the network on every launch, subject to the page's CSP, with
// nowhere to cache it. Here it is a local file in her application-support
// directory, loaded once, and the page receives finished audio.
//
// AND IT DEGRADES. If the model is missing, or the dependency was never
// installed, or synthesis throws, this reports that and the renderer falls
// back to speechSynthesis. A robotic voice is a complaint; silence is a
// broken feature.

const path = require('path');
const fs = require('fs');
const os = require('os');

// ── BOLDER, AND WHAT IT COSTS ────────────────────────────────────────────
// Apsara, 2026-09-07: "Chnage the voice of jarvis to bolder voice."
//
// This comment used to say af_heart and af_bella were the only two worth
// offering because they are the only A and A- in Kokoro's own voice table,
// and everything else runs down to F. That is still true, and it is the
// honest cost of what she asked for: EVERY male Kokoro voice is graded C+ or
// below. am_michael is the best of them.
//
// So this is a real trade, not a free improvement — a bolder voice here is a
// measurably lower-quality one, and she should know that rather than wonder
// why it suddenly sounds rougher. The A-grade voices stay in the list so she
// can put one back in a second, and the grade is written next to each so the
// choice is visible at the point of choosing rather than buried in a table on
// someone else's website.
//
// The GEMINI path (helpers/voice.js) is the one she hears on the web app and
// it has no such penalty: Orus is a first-class voice there. This penalty is
// specific to the local desktop model.
const VOICE_GRADES = {
    af_heart:  'A',    // female, the previous default
    af_bella:  'A-',   // female
    am_michael:'C+',   // male — the best-graded bold option
    am_fenrir: 'C+',   // male, rougher
    am_puck:   'C+',   // male, brighter
    bm_george: 'C',    // British male — closest to the films, lowest grade of the four
};
const VOICES = Object.keys(VOICE_GRADES);
const DEFAULT_VOICE = 'am_michael';

// q8 rather than fp32: 86MB against 326MB, with no audible difference at this
// model size. The download happens once.
const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const DTYPE = 'q8';

let tts = null;          // the loaded synthesiser, kept warm
let loading = null;      // in-flight load, so two callers do not load twice
let lastError = null;
let available = null;    // null = not yet determined

function cacheDir() {
    // Same place the Whisper model lives. Outside the .app bundle, which is
    // read-only once signed.
    return path.join(os.homedir(), 'Library', 'Application Support', 'Jarvis', 'tts');
}

// Loads once. The FIRST call downloads ~86MB, so the caller warms this at
// boot rather than letting it happen inside her first question — the same
// mistake that made the Whisper model look like a broken feature.
async function load() {
    if (tts) return tts;
    if (loading) return loading;
    loading = (async () => {
        try {
            const dir = cacheDir();
            fs.mkdirSync(dir, { recursive: true });
            // transformers.js keeps its model cache here rather than in a
            // temp directory that a reboot would clear.
            process.env.TRANSFORMERS_CACHE = dir;
            process.env.HF_HOME = dir;

            // Imported lazily and by dynamic import: kokoro-js is ESM, and a
            // top-level require would break every non-Mac machine that runs
            // the test suite.
            const { KokoroTTS } = await import('kokoro-js');
            tts = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: DTYPE, device: 'cpu' });
            available = true;
            lastError = null;
            return tts;
        } catch (e) {
            available = false;
            lastError = e && e.message ? e.message : String(e);
            throw e;
        } finally {
            loading = null;
        }
    })();
    return loading;
}

// Returns { ok, sampleRate, pcm } — Float32 mono, which the renderer plays
// through the AudioContext it already has. Not a WAV: encoding a header here
// and decoding it there would be two conversions for nothing.
//
// Never throws across IPC. A rejected invoke arrives in the renderer as
// "Error invoking remote method", which tells nobody anything; the whole
// point of the day's work is that failures explain themselves.
async function speak(text, voice) {
    const say = String(text == null ? '' : text).trim();
    if (!say) return { ok: false, error: 'nothing to say' };
    try {
        const model = await load();
        const chosen = VOICES.indexOf(voice) !== -1 ? voice : DEFAULT_VOICE;
        const audio = await model.generate(say, { voice: chosen });
        // kokoro-js returns a RawAudio: Float32Array + sampling_rate.
        const pcm = audio && (audio.audio || audio.data);
        if (!pcm || !pcm.length) return { ok: false, error: 'synthesiser returned no audio' };
        return {
            ok: true,
            sampleRate: (audio && audio.sampling_rate) || 24000,
            pcm: pcm instanceof Float32Array ? pcm : new Float32Array(pcm),
        };
    } catch (e) {
        lastError = e && e.message ? e.message : String(e);
        return { ok: false, error: lastError };
    }
}

function status() {
    return {
        ready: !!tts,
        available,          // null until load() has been attempted
        voices: VOICES.slice(),
        model: MODEL_ID,
        dir: cacheDir(),
        error: lastError,
    };
}

module.exports = {
    VOICE_GRADES, load, speak, status, VOICES, DEFAULT_VOICE, cacheDir };
