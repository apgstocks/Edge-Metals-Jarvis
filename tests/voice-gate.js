// ── tests/voice-gate.js ───────────────────────────────────────────────────
// Apsara: "I said hey jarvis but [nothing]."
//
// WHAT WENT WRONG, AND WHY A TEST CAN CATCH IT
// -------------------------------------------
// dashboard/voice-local.js decides, frame by frame, whether the room is
// making a speech-shaped noise. The first version compared loudness to a
// FIXED number — 0.012 — that I chose by picturing a quiet office rather than
// by measuring one. On her MacBook a whole "Hey Jarvis" never crossed it. The
// microphone was open, audio was flowing, Whisper was never called, and not
// one line was printed. Indistinguishable, from where she sat, from the
// feature being dead.
//
// The gate is now adaptive: it learns the room's noise floor and triggers on
// anything several times louder. That is a real algorithm with real failure
// modes — a floor that creeps up during a long sentence and cuts the speaker
// off, or one that collapses to zero in silence and makes every fan tick into
// speech — so it is worth testing rather than eyeballing.
//
// This runs the ACTUAL onaudioprocess handler out of voice-local.js against
// synthetic audio. No microphone, no Whisper, no browser: fake AudioContext,
// fake stream, fake bridge. What is exercised is the arithmetic that decides
// whether Apsara gets an answer.

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const SRC = fs.readFileSync(path.join(__dirname, '../dashboard/voice-local.js'), 'utf8');
const RATE = 44100;          // what her Mac actually reports
const FRAME = 4096;
const MS_PER_FRAME = (FRAME / RATE) * 1000;   // ≈ 92.9ms

// A fake browser holding just enough for voice-local.js to install itself and
// hand back its audio callback.
function harness() {
    const dom = new JSDOM('<!doctype html><body></body>', {
        url: 'https://jarvis.edgemetals.com/', runScripts: 'outside-only',
        virtualConsole: new VirtualConsole(),
    });
    const w = dom.window;
    const log = { lines: [], sent: [] };
    w.console = { log: (s) => log.lines.push(String(s)), warn: () => {}, error: () => {} };

    let onaudio = null;
    const node = {
        connect() {}, disconnect() {},
        set onaudioprocess(fn) { onaudio = fn; }, get onaudioprocess() { return onaudio; },
    };
    w.AudioContext = class {
        constructor() { this.sampleRate = RATE; this.destination = {}; }
        createMediaStreamSource() { return { connect() {} }; }
        createScriptProcessor() { return node; }
        createGain() { return { gain: { value: 1 }, connect() {} }; }
        close() {}
    };
    w.navigator.mediaDevices = {
        getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
    };
    // The bridge. transcribe() records what it was handed instead of running
    // a 77MB model.
    w.jarvisSpeech = {
        available: true,
        warm: async () => ({ ok: true }),
        // The BUFFER is kept, not just its length. Keeping only the length let
        // a mutation that removed resampling entirely — handing a 16kHz model
        // raw 44.1kHz audio — pass every test in this file, because the output
        // array is the same size either way and only its CONTENTS are wrong.
        transcribe: async (pcm) => { log.sent.push(pcm); return { ok: true, text: 'hey jarvis' }; },
    };

    w.eval(SRC);
    if (!w.JarvisLocalRecognition) throw new Error('voice-local.js did not register an engine');
    return { w, log, frame: () => onaudio };
}

// ── ONE buffer, reused, exactly like a real audio thread ─────────────────
// This harness used to allocate a fresh Float32Array per frame, and that
// made it a liar: the Web Audio API hands the SAME backing buffer to every
// onaudioprocess call and overwrites it in place. voice-local.js copies each
// frame for precisely that reason, and with a fresh-array harness, deleting
// the copy changed nothing and every test still passed.
//
// Reusing one buffer here means that if the copy is ever removed, every
// collected chunk aliases the final frame and the captured "speech" becomes
// N repetitions of the last 93ms of silence. Which is what would really
// happen, and is a genuinely horrible bug to diagnose from a bad transcript.
const SHARED = new Float32Array(FRAME);
// ── AND THE SIGNAL IS SPEECH-SHAPED, NOT A NYQUIST BUZZ ──────────────────
// This used to be `i % 2 ? rms : -rms` — alternating every sample, which is
// a 22,050 Hz tone: the highest frequency the format can represent, and one
// no human produces. It made the harness lie in a specific way. Once
// voice-local.js started LOW-PASS FILTERING before downsampling (as it must,
// or 44.1k audio aliases into gibberish at 16k), a correct filter removes a
// 22kHz tone almost entirely — so the "loud speech" fixture would have gone
// silent and the tests would have failed on the fix.
//
// A 220 Hz tone is in the range of a human voice, survives the filter as it
// should, and keeps its phase across frames so the frames join smoothly
// rather than clicking at every boundary.
const TONE_HZ = 220;
let phase = 0;
function frameAt(rms) {
    const amp = rms * Math.SQRT2;          // RMS of a sine is amplitude/√2
    for (let i = 0; i < FRAME; i += 1) {
        SHARED[i] = amp * Math.sin(2 * Math.PI * TONE_HZ * (phase + i) / RATE);
    }
    phase += FRAME;
    return { inputBuffer: { getChannelData: () => SHARED } };
}
// A tone ABOVE the 8kHz limit of 16kHz audio. Anything up here must be
// filtered out rather than folded down into the speech band.
function frameAtHigh(rms, hz) {
    const amp = rms * Math.SQRT2;
    for (let i = 0; i < FRAME; i += 1) {
        SHARED[i] = amp * Math.sin(2 * Math.PI * hz * (phase + i) / RATE);
    }
    phase += FRAME;
    return { inputBuffer: { getChannelData: () => SHARED } };
}

(async () => {
console.log('\n─ the energy gate ───────────────────────────────────────────');

async function run(levels) {
    const h = harness();
    const rec = new h.w.JarvisLocalRecognition();
    // What voice.js attaches. Recorded because "Whisper produced text" and
    // "voice.js was told about it" are different claims, and a mutation that
    // stopped delivering results entirely passed every test in this file
    // until this existed.
    h.delivered = [];
    rec.onresult = (ev) => h.delivered.push(ev.results[0][0].transcript);
    rec.onerror = (e) => h.log.lines.push('[ERR] ' + (e && e.error));
    rec.start();
    await new Promise((r) => setTimeout(r, 0));      // getUserMedia resolves
    const fn = h.frame();
    if (!fn) throw new Error('no audio callback was installed');
    for (const lv of levels) fn(frameAt(lv));
    await new Promise((r) => setTimeout(r, 0));      // transcribe resolves
    return h;
}

// Frames needed to cross SILENCE_MS (700) and MIN_MS (350).
const QUIET_TO_END = Math.ceil(700 / MS_PER_FRAME) + 1;   // 9
const rep = (n, v) => new Array(n).fill(v);

section('A — the bug she hit: normal speech over a quiet room');
{
    // A quiet room, then speech at a level the OLD fixed threshold (0.012)
    // would have rejected outright. This is the regression test for the
    // afternoon she lost.
    const h = await run([...rep(30, 0.002), ...rep(12, 0.010), ...rep(QUIET_TO_END, 0.002)]);
    ck('quiet speech still triggers, because the floor adapted',
       h.log.sent.length === 1,
       'the old fixed 0.012 threshold rejected exactly this and printed nothing');
    ck('  and it says what it heard', h.log.lines.some((l) => /heard: "hey jarvis"/.test(l)));
    // The point of the whole file: voice.js must actually RECEIVE the words.
    // Transcribing and then not handing them over is a silent failure that
    // looks, from the terminal, exactly like success.
    ck('  and voice.js is handed the transcript',
       h.delivered.length === 1 && h.delivered[0] === 'hey jarvis',
       'Whisper producing text and voice.js being told about it are different claims');
    // Both numbers, because they answer different questions: HELD is what
    // Whisper receives, VOICED is what decided it was worth sending.
    ck('  and it reports both the capture and the speech within it',
       h.log.lines.some((l) => /captured \d+ms \(\d+ms of speech\) — transcribing/.test(l)));
}

section('B — it does not fire at a quiet room on its own');
{
    const h = await run(rep(80, 0.0015));
    ck('silence alone never reaches Whisper', h.log.sent.length === 0,
       'a gate that fires on silence burns battery and transcribes nothing all day');
    ck('  but it SAYS it is listening, with numbers',
       h.log.lines.some((l) => /listening — loudest [\d.]+, needs [\d.]+/.test(l)),
       'this line is the whole point: "nothing happened" must produce a measurement');
    ck('  and names the problem when it is too quiet',
       h.log.lines.some((l) => /too quiet, nothing sent to Whisper/.test(l)));
    // THE NUMBER MUST BE THE REAL NUMBER. A report that always says 0.0000
    // is worse than no report: it would send us hunting a dead microphone
    // when the microphone is fine and the threshold is wrong. Fed 0.0015,
    // so that is what it has to say.
    const loudest = Number((( h.log.lines.find((l) => /loudest/.test(l)) || '')
        .match(/loudest ([\d.]+)/) || [])[1] || 0);
    ck('  and the level it reports is the level it was fed',
       Math.abs(loudest - 0.0015) < 0.0003,
       'reported ' + loudest + ', was given 0.0015 — a diagnostic that lies is worse than none');
}

section('C — the floor cannot collapse to zero');
{
    // Near-perfect digital silence for a long time, then a tiny tick. If the
    // floor were purely relative, the tick would be "3.5x the floor" and
    // would trigger. ABSOLUTE_FLOOR is what stops that.
    const h = await run([...rep(200, 0.00001), ...rep(12, 0.002), ...rep(QUIET_TO_END, 0.00001)]);
    ck('a faint tick after long silence is not speech', h.log.sent.length === 0,
       'without an absolute backstop, a silent room makes every fan tick a command');
}

section('D — a long sentence is not cut off by its own loudness');
{
    // THE FAILURE MODE OF ADAPTIVE GATES. If loud frames taught the floor,
    // the threshold would climb during a sentence until it exceeded the
    // speaker's voice, ending the capture mid-word. Only quiet frames adapt
    // it, and this proves that: 40 frames (~3.7s) of continuous speech must
    // arrive as ONE capture, not several.
    const h = await run([...rep(20, 0.002), ...rep(40, 0.03), ...rep(QUIET_TO_END, 0.002)]);
    ck('3.7s of speech is one capture, not several', h.log.sent.length === 1,
       'more than one here means the floor climbed into the speaker\'s own voice');
    const captured = h.log.lines.filter((l) => /captured/.test(l))[0] || '';
    const ms = Number((captured.match(/captured (\d+)ms/) || [])[1] || 0);
    // 40 frames of speech (~3.7s) + ~700ms silence tail + ~800ms pre-roll.
    ck('  and it is roughly the length actually spoken, plus the pre-roll',
       ms > 3700 && ms < 5600, 'got ' + ms + 'ms');
}

section('D2 — background noise must not deafen it');
{
    // ALSO ADDED AFTER A MUTATION SURVIVED. Making the floor adapt at the
    // same speed in both directions passed every test, and it should not:
    // it is the difference between a truck passing outside and a truck
    // ending the conversation.
    //
    // Quiet room, then sustained background noise BELOW the trigger — a
    // fan, a yard outside, a machine — and then she speaks. The floor is
    // allowed to learn that noise, but slowly. If it learned it as fast as
    // it learns quiet, the trigger would climb above her voice and the
    // command would vanish, silently, exactly as it did this afternoon.
    const h = await run([
        ...rep(20, 0.0015),        // quiet: floor settles low
        ...rep(25, 0.005),         // noise starts, still under the trigger
        ...rep(14, 0.013),         // she speaks over it, not hugely louder
        ...rep(QUIET_TO_END, 0.005),
    ]);
    ck('she is still heard over sustained background noise', h.log.sent.length === 1,
       'symmetric adaptation lets the floor chase the noise up past her voice');
}

section('D3 — the first word is not clipped off');
{
    // ADDED FROM THE RESEARCH, not from a failure — Apple's always-on
    // processor keeps a ring buffer and GLaDOS keeps 800ms, both for the
    // same reason: a capture that begins on the frame which CROSSED the
    // threshold has already lost the attack of the first word, which is
    // quiet by definition. "Hey Jarvis" reaching whisper as "ey Jarvis"
    // is a plausible share of the misses she has been living with.
    //
    // Driven by making the audio BEFORE the trigger identifiable: a quiet
    // but non-silent lead-in, then speech. If the pre-roll works, that
    // lead-in is in the buffer handed over.
    const h = await run([...rep(20, 0.0004), ...rep(14, 0.05), ...rep(QUIET_TO_END, 0.0004)]);
    ck('one capture', h.log.sent.length === 1);
    const ms = Number((( h.log.lines.find((l) => /captured/.test(l)) || '')
        .match(/captured (\d+)ms/) || [])[1] || 0);
    // 14 frames of speech is ~1300ms; +700ms tail is ~2000ms. Anything at
    // or above ~2600ms means the pre-roll frames were prepended.
    ck('  the capture starts BEFORE the trigger fired', ms > 2500,
       'got ' + ms + 'ms — without a pre-roll this would be about 2000ms');
    ck('  and the extra audio is at the FRONT, not the end',
       (() => {
           const pcm = h.log.sent[0];
           const rmsOf = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
           // First ~8% is pre-roll: quiet, but present.
           const head = Array.from(pcm.slice(0, Math.floor(pcm.length * 0.08)));
           const mid = Array.from(pcm.slice(Math.floor(pcm.length * 0.3), Math.floor(pcm.length * 0.5)));
           return rmsOf(head) < rmsOf(mid);
       })(),
       'the pre-roll must be prepended, not appended — audio in the wrong order transcribes as nonsense');
}

section('E — blips are discarded, and say so');
{
    // A slammed door: loud, brief. Must not reach Whisper, and must be
    // distinguishable in the log from "never triggered at all", because the
    // two need completely different fixes.
    const h = await run([...rep(20, 0.002), ...rep(2, 0.05), ...rep(QUIET_TO_END, 0.002)]);
    ck('a 190ms bang is not transcribed', h.log.sent.length === 0);
    ck('  and the log distinguishes it from never triggering',
       h.log.lines.some((l) => /ignored a \d+ms blip/.test(l))
       && h.log.lines.some((l) => /hearing something/.test(l)));
}

section('F — the audio handed over is resampled, not raw');
{
    const h = await run([...rep(20, 0.002), ...rep(12, 0.03), ...rep(QUIET_TO_END, 0.002)]);
    ck('exactly one buffer went to Whisper', h.log.sent.length === 1);
    const n = h.log.sent[0].length;

    // My first version of this assertion expected only the 12 LOUD frames and
    // failed. The code was right and the test was wrong: a capture also keeps
    // the ~700ms of trailing silence, which is deliberate — Whisper decodes
    // better with the tail than with a sentence chopped off at the last loud
    // frame. So the invariant to check is not a frame count I predicted, but
    // the RELATIONSHIP: however long was captured, that many samples at 16kHz.
    const ms = Number((( h.log.lines.find((l) => /captured/.test(l)) || '')
        .match(/captured (\d+)ms/) || [])[1] || 0);
    ck('  the buffer is exactly the captured duration at 16kHz',
       ms > 0 && Math.abs(n - (ms / 1000) * 16000) < 200,
       'got ' + n + ' samples for ' + ms + 'ms — expected about ' + Math.round((ms / 1000) * 16000));
    ck('  which is a third of the raw 44.1kHz size',
       n < (ms / 1000) * RATE * 0.4,
       'sending 44.1kHz over IPC would be ~2.8x the bytes for no gain');
}

section('F2 — the resampling is real, not just the right LENGTH');
{
    // ADDED AFTER A MUTATION SURVIVED. Removing the resample entirely —
    // `flat[i]` instead of `flat[i * ratio]`, handing a 16kHz model raw
    // 44.1kHz audio, which sounds like a chipmunk and transcribes as
    // nonsense — passed every test above, because the OUTPUT ARRAY IS THE
    // SAME SIZE either way. Only its contents differ.
    //
    // So: loud speech, then the silent tail every capture keeps. Resampled
    // correctly, the output spans the whole capture and ends quiet. Taken
    // raw, the output covers only the first ~36% of it — all of which is
    // loud — and ends loud.
    const h = await run([...rep(20, 0.002), ...rep(20, 0.05), ...rep(QUIET_TO_END, 0.0005)]);
    ck('one capture', h.log.sent.length === 1);
    const pcm = h.log.sent[0];
    const rmsOf = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
    const tail = Array.from(pcm.slice(Math.floor(pcm.length * 0.92)));
    const head = Array.from(pcm.slice(0, Math.floor(pcm.length * 0.5)));
    ck('  the buffer ends in the silence that ended the capture',
       rmsOf(tail) < 0.01,
       'a loud tail means the output only covers the START of the audio — i.e. it was never resampled');
    ck('  and still contains the loud speech', rmsOf(head) > 0.02);
}

section('F3 — high frequencies are filtered, not folded into the speech');
{
    // THE BUG THAT PRODUCED "Hmm. You get number up on me. Who's like this?"
    // from a clear sentence. Dropping 1 sample in 2.76 without filtering does
    // not remove the high frequencies, it ALIASES them: everything above 8kHz
    // reappears inside the speech band as noise, and Whisper transcribes the
    // noise along with the words.
    //
    // Driven with a 14kHz tone — sibilance, keyboard, fan — which cannot
    // survive honestly in 16kHz audio and must come out quiet. With the old
    // nearest-neighbour code it comes out at nearly full strength, disguised
    // as a low tone.
    const h = harness();
    const rec = new h.w.JarvisLocalRecognition();
    h.delivered = [];
    rec.onresult = () => {};
    rec.start();
    await new Promise((r) => setTimeout(r, 0));
    const fn = h.frame();
    for (let i = 0; i < 20; i += 1) fn(frameAtHigh(0.05, 14000));
    for (let i = 0; i < QUIET_TO_END; i += 1) fn(frameAt(0.0005));
    await new Promise((r) => setTimeout(r, 0));

    ck('the capture happened', h.log.sent.length === 1);
    const pcm = h.log.sent[0];
    const rmsOf = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
    const got = rmsOf(Array.from(pcm.slice(0, Math.floor(pcm.length * 0.5))));
    ck('  a 14kHz tone is attenuated, not aliased down into the voice band',
       got < 0.05 * 0.5,
       'came through at ' + got.toFixed(4) + ' of 0.05 — unfiltered decimation folds it into the speech');

    // And the speech band must NOT be attenuated, or the fix would just be
    // making everything quiet.
    const h2 = await run([...rep(20, 0.002), ...rep(20, 0.05), ...rep(QUIET_TO_END, 0.0005)]);
    const kept = rmsOf(Array.from(h2.log.sent[0].slice(0, Math.floor(h2.log.sent[0].length * 0.5))));
    ck('  but a 220Hz voice tone comes through intact', kept > 0.05 * 0.7,
       'came through at ' + kept.toFixed(4) + ' of 0.05 — a filter that eats speech is no better');
}

section('G — the ceiling still holds');
{
    // Someone leaves a radio on. MAX_MS (9000) must end the capture rather
    // than let the buffer grow without bound.
    const h = await run([...rep(20, 0.002), ...rep(140, 0.03)]);
    ck('continuous noise is cut at the ceiling, not collected forever',
       h.log.sent.length >= 1);
    const ms = Number(((h.log.lines.filter((l) => /captured/.test(l))[0] || '').match(/captured (\d+)ms/) || [])[1] || 0);
    ck('  and the first chunk is about the 9s limit', ms >= 8800 && ms <= 9300, 'got ' + ms + 'ms');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
})();
