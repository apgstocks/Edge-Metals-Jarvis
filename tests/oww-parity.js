// ── tests/oww-parity.js ───────────────────────────────────────────────────
// The wake model, proved on HER voice (2026-09-20).
//
// tests/fixtures/wake-her-voice.wav is 44 seconds cut from her screen
// recording of 2026-09-20 06:54 IST: 20 s of her talking to Jarvis with
// Jarvis answering OUT LOUD (the negatives — no "Hey Jarvis" in it, but her
// voice, the room and Jarvis's own voice saying "Jarvis"), then 24 s in which
// she says "Hey Jarvis" repeatedly.
//
// wake-her-voice.ref.json holds the per-frame scores the PYTHON openWakeWord
// package produced for the same file with the same three models. So this
// test proves two different things:
//   1. the port is FAITHFUL — dashboard/oww-core.js gives the Python scores;
//   2. the model WORKS for her — it fires on her "Hey Jarvis" and never on
//      the rest.
//
// Needs onnxruntime-node (installed with the desktop app). Without it, it
// says SKIPPED rather than failing — the browser runs onnxruntime-web.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const ROOT = path.join(__dirname, '..');

let ort = null;
for (const where of ['onnxruntime-node', path.join(ROOT, 'desktop/node_modules/onnxruntime-node')]) {
    try { ort = require(where); break; } catch (e) { /* next */ }
}

(async () => {
    if (!ort) {
        console.log('  SKIPPED  no onnxruntime-node here (cd desktop && npm install) — nothing asserted');
        process.exit(0);
    }
    const { Core } = require(path.join(ROOT, 'dashboard/oww-core.js'));
    const M = path.join(ROOT, 'dashboard/models/oww');
    const s = {
        melspectrogram: await ort.InferenceSession.create(path.join(M, 'melspectrogram.onnx')),
        embedding: await ort.InferenceSession.create(path.join(M, 'embedding_model.onnx')),
        wake: await ort.InferenceSession.create(path.join(M, 'hey_jarvis_v0.1.onnx')),
    };
    const run = async (name, data, dims) => {
        const sess = s[name];
        const r = await sess.run({ [sess.inputNames[0]]: new ort.Tensor('float32', data, dims) });
        return r[sess.outputNames[0]].data;
    };

    const buf = fs.readFileSync(path.join(__dirname, 'fixtures/wake-her-voice.wav'));
    // Read the data chunk by its declared length: a WAV may carry other
    // chunks before or AFTER it (ffmpeg writes LIST, other tools append).
    const dPos = buf.indexOf('data');
    const dLen = buf.readUInt32LE(dPos + 4);
    const di = dPos + 8;
    const pcm = new Int16Array(buf.buffer.slice(buf.byteOffset + di, buf.byteOffset + di + (Math.min(dLen, buf.length - di) & ~1)));
    const ref = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/wake-her-voice.ref.json'), 'utf8')).scores;

    const core = new Core({ run });
    const scores = [], fires = [];
    const t0 = Date.now();
    for (let i = 0; i + 1280 <= pcm.length; i += 1280) {
        const r = await core.push(Float32Array.from(pcm.subarray(i, i + 1280)));
        scores.push(r.score);
        if (r.fired) fires.push(r.atMs / 1000);
    }
    const perFrame = (Date.now() - t0) / scores.length;

    console.log('\n=== A — the port gives the reference scores ===');
    // The first ~25 frames sit on start-up filler (random noise, as upstream)
    // and may differ run to run; everything after must match.
    let maxDiff = 0;
    for (let k = 25; k < Math.min(ref.length, scores.length); k++) maxDiff = Math.max(maxDiff, Math.abs(ref[k] - scores[k]));
    ck('same number of frames as the Python run', scores.length === ref.length, `${scores.length} vs ${ref.length}`);
    ck('every score within 0.01 of openWakeWord\'s own', maxDiff < 0.01, 'max diff ' + maxDiff.toFixed(4));

    console.log('\n=== B — on her voice ===');
    const negatives = fires.filter((t) => t < 20);
    const positives = fires.filter((t) => t >= 20);
    ck('NO wake in the 20 s of her talking and Jarvis answering', negatives.length === 0, JSON.stringify(negatives));
    ck('her "Hey Jarvis" is heard, again and again (5 distinct times)', positives.length === 5, JSON.stringify(positives));
    ck('cheap enough to run always-on (< 20 ms per 80 ms of audio)', perFrame < 20, perFrame.toFixed(2) + ' ms');

    console.log(`\n  ${pass} passed, ${fail} failed`);
    if (fail) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  HARNESS FAILED:', e); process.exit(1); });
