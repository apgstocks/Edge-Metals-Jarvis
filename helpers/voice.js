// ── helpers/voice.js — Jarvis speaks ───────────────────────────────────────
//
// Per Apsara 2026-08-29: "give voice to the app. after opening the app, if i
// call hey jarvis.. make it talk back", then "i want to give human voice to
// jarvis", then "voice charon".
//
// ── why Gemini and not the phone's own voice ──────────────────────────────
// Android ships a text-to-speech engine and there is a Capacitor plugin for
// it. It is instant and works offline, and it sounds like a machine reading a
// list. She asked for a human voice, so that is the fallback, not the plan.
//
// Three routes were actually tested against her real credentials:
//   • Google Cloud Text-to-Speech — 403, the API is not enabled on the
//     project. Enabling it is an account/billing change and not mine to make.
//   • The Gemini API key already in .env, against Cloud TTS — 401, that API
//     does not accept API keys at all.
//   • Gemini's own TTS model with that same key — WORKS. No new API to
//     enable, no second bill, and the voices are genuinely human.
// So: gemini-2.5-flash-preview-tts, voice Charon, her pick from six samples.
//
// ── the format gotcha ─────────────────────────────────────────────────────
// It returns audio/L16 — raw signed 16-bit PCM at 24kHz, with NO container.
// Handing those bytes to an <audio> tag plays nothing at all, silently. They
// have to be wrapped in a 44-byte WAV header first, which is what wavHeader()
// below is for.
//
// ── why there is a cache ──────────────────────────────────────────────────
// Synthesis is ~3s at best and ~8-10s for a sentence, measured. That is
// tolerable for an answer and completely
// unacceptable for the "Yes?" that comes back when she says Hey Jarvis — a
// two-second pause before an acknowledgement reads as "it didn't hear me",
// and she says it again. So the handful of fixed phrases are synthesised once
// and kept on disk, and afterwards come back instantly in the same voice.
// Answers are cached too, keyed by their text: "how much do we owe Acme" gets
// asked more than once.

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const cfg = require('../config');

const MODEL = process.env.VOICE_MODEL || 'gemini-2.5-flash-preview-tts';
const VOICE = process.env.VOICE_NAME || 'Charon';
const SAMPLE_RATE = 24000;

// A spoken reply is not a written one. Past a couple of sentences nobody is
// listening any more, they are reading the screen — where the full text
// already is. This caps what is SPOKEN, never what is shown.
const MAX_SPEAK_CHARS = 600;

const CACHE_DIR = path.join(cfg.DATA_DIR, 'voice-cache');

// ── the persona ───────────────────────────────────────────────────────────
// Per Apsara 2026-08-29: "Make it like ironman. design the voice like that."
//
// Gemini's TTS takes natural-language DIRECTION alongside the words, the way
// a voice director would. Verified rather than assumed: the two takes below
// were synthesised and then transcribed back through Gemini, and the
// instruction does not appear in the transcript — it changes the delivery
// only. The directed take also ran 15.3s against 11.1s undirected, and came
// back punctuated into shorter clauses, which is the measured, unhurried
// register being asked for.
//
// STYLE IS DELIVERY AND FIXED PHRASES ONLY. It never touches an answer's
// words. It would be easy to run each reply through a model to make it sound
// more like the films, and it would be a serious mistake: these sentences
// carry weights and amounts of money, and a rewrite for tone is a rewrite
// that can move a decimal point. The figures are spoken exactly as computed.
// REVISED after Apsara heard it: "i dont like ironman jarvis. it is very slow
// speaking." She is right, and it was measurable — the butler direction ran
// 15.3s against 11.1s undirected for identical words, 38% slower, because
// "unhurried" and "calm" are instructions to slow down and the model obeyed
// them literally.
//
// The lesson is that style direction controls PACE as much as tone, so pace
// has to be directed explicitly rather than left as a side effect of the
// adjectives. Both voices are now told to be brisk. In a yard nobody is
// waiting through a dramatic pause to hear a weight.
const STYLES = {
    Charon: 'Read this briskly and naturally, at a quick conversational pace, as if giving a colleague a fast update. '
        + 'Clear and efficient. Do not slow down, do not pause dramatically, do not add gravitas. '
        + 'Speak only the words after the colon: ',
    Leda: 'Read this briskly and naturally, at a quick conversational pace, plain and matter-of-fact. '
        + 'Clear and efficient. Do not slow down or add drama. Speak only the words after the colon: ',
};

// The fixed phrases, warmed at boot so the wake word never waits on the
// network. Keys are what the app asks for by name.
//
// SHORT. These are the lines she hears twenty times a day, and their whole job
// is to signal that it heard her. "At your service." was tried and was three
// words too many.
const PHRASES = {
    wake: 'Yes?',
    working: 'On it.',
    done: 'Done.',
    unheard: "Didn't catch that.",
    offline: "Can't reach the server.",
};

// ── PCM -> WAV ────────────────────────────────────────────────────────────
// 44 bytes of header. Without it the audio element fails silently, which is
// the single most confusing way for this feature to break.
function wavHeader(pcmLength, rate = SAMPLE_RATE) {
    const h = Buffer.alloc(44);
    h.write('RIFF', 0);
    h.writeUInt32LE(36 + pcmLength, 4);
    h.write('WAVE', 8);
    h.write('fmt ', 12);
    h.writeUInt32LE(16, 16);          // PCM chunk size
    h.writeUInt16LE(1, 20);           // format 1 = PCM
    h.writeUInt16LE(1, 22);           // mono
    h.writeUInt32LE(rate, 24);
    h.writeUInt32LE(rate * 2, 28);    // byte rate (mono, 16-bit)
    h.writeUInt16LE(2, 32);           // block align
    h.writeUInt16LE(16, 34);          // bits per sample
    h.write('data', 36);
    h.writeUInt32LE(pcmLength, 40);
    return h;
}

// ── make text speakable ───────────────────────────────────────────────────
// The same string that reads well on screen reads badly aloud. "EDGE_4" comes
// out as "edge underscore four"; "5,919 lb" as "five thousand nine hundred and
// nineteen ell bee". These are the substitutions that matter in this app.
function speakable(text) {
    let t = String(text || '');
    return t
        // IDS FIRST, before the markdown strip. Learned the hard way: the
        // markdown rule turns "_" into a space, so running it first left
        // "EDGE 7" and this rule then had nothing to match — the load id was
        // read out as "EE DEE GEE EE seven". Order matters here.
        .replace(/\bEDGE[_\- ](\d+)/gi, 'Edge $1')     // load ids
        // "Draft DRAFT_9f2 saved" must not become "Draft a draft saved" —
        // swallow the word in front of the id when there is one.
        .replace(/\bdrafts?\s+DRAFT[_-]\w+/gi, 'the draft')
        .replace(/\bDRAFT[_-]\w+/gi, 'the draft')
        .replace(/\*\*|__|[*_`#>]/g, ' ')              // markdown the model sometimes emits
        .replace(/\$\s?([\d,]+)\.00\b/g, '$1 dollars') // a round amount needs no cents
        .replace(/\$\s?([\d,]+)\.(\d\d)\b/g, '$1 dollars $2 cents')
        .replace(/\$\s?([\d,]+)\b/g, '$1 dollars')
        .replace(/\blbs?\b/gi, 'pounds')
        .replace(/\bMT\b/g, 'metric tons')
        .replace(/\s*—\s*/g, ', ')                     // em dash reads as a pause
        .replace(/\s+/g, ' ')
        .trim();
}

// Trims to a sentence boundary rather than mid-word, so a long answer ends
// like a sentence instead of stopping dead.
function trimForSpeech(text, max = MAX_SPEAK_CHARS) {
    const t = speakable(text);
    if (t.length <= max) return t;
    const cut = t.slice(0, max);
    const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
    return (stop > max * 0.5 ? cut.slice(0, stop + 1) : cut) + ' See the screen for the rest.';
}

function cacheKey(text, voice) {
    // The STYLE is part of the key. Without it, changing the persona would
    // keep serving the old, differently-delivered audio out of the cache
    // forever — the feature would look like it simply had not worked.
    return crypto.createHash('sha1').update(`${MODEL}|${voice}|${STYLES[voice] || ''}|${text}`).digest('hex').slice(0, 20);
}

function cachePath(key) { return path.join(CACHE_DIR, `${key}.wav`); }

// ── the call ──────────────────────────────────────────────────────────────
function synthesise(text, voice) {
    return new Promise((resolve, reject) => {
        const key = cfg.GEMINI_API_KEY;
        if (!key) return reject(new Error('no GEMINI_API_KEY — cannot synthesise speech'));
        // The style prefix is DIRECTION, not content — verified by
        // transcribing the output back: it shapes delivery and is never
        // spoken. Falls back to the plain text if a voice has no style.
        const directed = (STYLES[voice] || '') + text;
        const body = JSON.stringify({
            contents: [{ parts: [{ text: directed }] }],
            generationConfig: {
                responseModalities: ['AUDIO'],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
            },
        });
        const req = https.request({
            hostname: 'generativelanguage.googleapis.com',
            path: `/v1beta/models/${MODEL}:generateContent?key=${key}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            timeout: 20000,
        }, (res) => {
            let d = '';
            res.on('data', (c) => { d += c; });
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    return reject(new Error(`TTS ${res.statusCode}: ${String(d).replace(/\s+/g, ' ').slice(0, 200)}`));
                }
                try {
                    const j = JSON.parse(d);
                    const cand = (j.candidates || [])[0];
                    // A 200 with no audio is a real outcome, not a parse bug:
                    // the model can stop for its own reasons (quota, a safety
                    // filter, a recitation check) and still answer 200. Say
                    // WHICH, or this is undebuggable from a log line.
                    if (!cand || !cand.content || !cand.content.parts) {
                        const why = (cand && (cand.finishReason || cand.finish_reason))
                            || (j.promptFeedback && j.promptFeedback.blockReason)
                            || 'no candidate returned';
                        throw new Error(`model returned no audio (${why})`);
                    }
                    const part = cand.content.parts[0].inlineData;
                    if (!part || !part.data) throw new Error('response carried no inline audio data');
                    const pcm = Buffer.from(part.data, 'base64');
                    // Honour the rate the response declares rather than
                    // assuming 24kHz — a wrong rate in the header plays back
                    // at the wrong pitch, which is a bizarre thing to debug.
                    const rate = parseInt((String(part.mimeType).match(/rate=(\d+)/) || [])[1] || SAMPLE_RATE, 10);
                    resolve(Buffer.concat([wavHeader(pcm.length, rate), pcm]));
                } catch (e) {
                    reject(new Error(`TTS returned no audio: ${e.message}`));
                }
            });
        });
        req.on('timeout', () => { req.destroy(new Error('TTS timed out')); });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ── the public call ───────────────────────────────────────────────────────
// Returns a WAV buffer. Cached on disk by text, so a repeated question is
// instant and costs nothing.
async function say(text, opts = {}) {
    const voice = opts.voice || VOICE;
    const spoken = opts.raw ? String(text) : trimForSpeech(text);
    if (!spoken) throw new Error('nothing to say');

    const key = cacheKey(spoken, voice);
    const file = cachePath(key);
    try {
        if (fs.existsSync(file)) return fs.readFileSync(file);
    } catch (e) { /* fall through and synthesise */ }

    // RETRY. The preview TTS model intermittently answers 200 with
    // finishReason "OTHER" and no audio at all — observed live, on text it
    // had just synthesised successfully, and the immediate retry worked. It
    // is not the text and it is not the voice; it is the model. Without this
    // the feature would appear to work and then randomly go mute, which is
    // worse than not having it.
    let wav = null, lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        try { wav = await synthesise(spoken, voice); break; } catch (err) {
            lastErr = err;
            // A quota or auth failure will not fix itself; only retry the
            // empty-response case and transient network errors.
            if (/\b(401|403|400)\b/.test(err.message)) break;
            if (attempt < 3) await new Promise((r) => setTimeout(r, 400 * attempt));
        }
    }
    if (!wav) throw lastErr || new Error('speech synthesis failed');
    try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(file, wav);
    } catch (e) {
        // A cache that cannot be written is a slow feature, not a broken one.
        console.warn('[VOICE] could not cache audio:', e.message);
    }
    return wav;
}

// One of the fixed phrases, by name. Same cache, so after the first warm-up
// these come back off disk in a millisecond.
async function phrase(name, opts = {}) {
    const text = PHRASES[name];
    if (!text) throw new Error(`unknown phrase: ${name}`);
    return say(text, { ...opts, raw: true });
}

// Synthesises the fixed phrases if they are not already on disk. Called once
// at boot, deliberately NOT awaited by the caller: a slow or failing warm-up
// must not hold up the server starting. Worst case the first "Yes?" waits a
// second, which is the behaviour without a cache at all.
async function warmUp() {
    if (!cfg.GEMINI_API_KEY) return { warmed: 0, skipped: 'no API key' };
    let warmed = 0;
    for (const name of Object.keys(PHRASES)) {
        try {
            const before = fs.existsSync(cachePath(cacheKey(PHRASES[name], VOICE)));
            await phrase(name);
            if (!before) warmed += 1;
        } catch (e) {
            console.warn(`[VOICE] could not warm "${name}":`, e.message);
        }
    }
    if (warmed) console.log(`[VOICE] warmed ${warmed} spoken phrase(s) in the ${VOICE} voice.`);
    return { warmed };
}

module.exports = { say, phrase, warmUp, speakable, trimForSpeech, wavHeader, cacheKey, PHRASES, VOICE, MODEL, MAX_SPEAK_CHARS, CACHE_DIR };
