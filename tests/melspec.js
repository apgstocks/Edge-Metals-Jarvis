// ── tests/melspec.js ──────────────────────────────────────────────────────
// Apsara, 2026-09-06: "use this in jarvis Waveform model reading prosody".
//
// Smart Turn v3 decides whether she has finished speaking. Its input is a
// Whisper log-mel spectrogram — [1, 80, 800] — and desktop/melspec.js is a
// hand port of that feature extractor, because no JavaScript implementation
// of it exists.
//
// WHY THIS FILE IS NOT OPTIONAL
// -----------------------------
// A wrong spectrogram does not crash. It produces a confident, meaningless
// probability, and the symptom is "Jarvis interrupts me sometimes" — which
// is indistinguishable from the model simply being imperfect, and would send
// the next person tuning a threshold instead of fixing arithmetic.
//
// So the parts that can be checked against mathematics are checked against
// mathematics, not against my own implementation. A Bluestein FFT verified
// against a naive DFT is a real check; one verified against itself is not.
//
// Four things a port of this usually gets wrong, all asserted below:
//   · padding goes at the START, so speech sits at the END of the window
//   · the Hann window is PERIODIC, not symmetric
//   · the mel scale is SLANEY, not HTK
//   · the dynamic-range clamp uses a GLOBAL max, taken after a frame is dropped

const path = require('path');
let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const mel = require('../desktop/melspec.js');
const SRC = require('fs').readFileSync(path.join(__dirname, '../desktop/melspec.js'), 'utf8');

console.log('\n─ Whisper log-mel features ──────────────────────────────────');

section('A — the FFT, against a naive DFT');
{
    // The Bluestein transform is the least obvious code in the file: an FFT
    // of length 400, which is not a power of two, built out of a padded
    // radix-2 one. Checked against a direct O(n²) DFT — slow, obviously
    // correct, and INDEPENDENT. Verifying it against itself would prove
    // nothing at all.
    const N = 400;
    const frame = new Float64Array(N);
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
    for (let i = 0; i < N; i += 1) frame[i] = rnd();

    // Reach the internal function the same way the module does.
    const m = require('module');
    const fn = eval(m.wrap(SRC + '\n;module.exports.__rfftPower = rfftPower;'));
    const mod = { exports: {} };
    fn(mod.exports, require, mod, path.join(__dirname, '../desktop/melspec.js'), path.join(__dirname, '../desktop'));
    const rfftPower = mod.exports.__rfftPower;

    const got = new Float64Array(N / 2 + 1);
    rfftPower(frame, got);

    let worst = 0;
    for (let k = 0; k <= N / 2; k += 1) {
        let re = 0, im = 0;
        for (let n = 0; n < N; n += 1) {
            const a = -2 * Math.PI * k * n / N;
            re += frame[n] * Math.cos(a);
            im += frame[n] * Math.sin(a);
        }
        const want = re * re + im * im;
        worst = Math.max(worst, Math.abs(got[k] - want) / (Math.abs(want) + 1e-9));
    }
    ck('Bluestein matches a direct DFT on random noise', worst < 1e-9,
       'worst relative error ' + worst.toExponential(2));

    // A pure tone must land in exactly one bin. 16000/400 = 40Hz per bin, so
    // 800Hz is bin 20 exactly, with no leakage to worry about.
    const tone = new Float64Array(N);
    for (let i = 0; i < N; i += 1) tone[i] = Math.sin(2 * Math.PI * 800 * i / 16000);
    rfftPower(tone, got);
    let peak = 0, peakAt = -1;
    for (let k = 0; k <= N / 2; k += 1) if (got[k] > peak) { peak = got[k]; peakAt = k; }
    ck('  an 800Hz tone peaks in bin 20', peakAt === 20, 'peaked at ' + peakAt);
    ck('  and the rest is negligible',
       got.reduce((s, v, i) => s + (i === 20 ? 0 : v), 0) < peak * 1e-12);
}

section('B — the mel filterbank is Slaney, not HTK');
{
    // The two scales agree nowhere except zero. HTK is logarithmic
    // throughout; Slaney is LINEAR below 1kHz. Getting this wrong shifts
    // every filter and quietly ruins the spectrogram.
    ck('the scale is linear below 1kHz',
       Math.abs(mel.hzToMel(500) - 500 / (200 / 3)) < 1e-9,
       'HTK would give ' + (2595 * Math.log10(1 + 500 / 700)).toFixed(3)
       + ', Slaney gives ' + mel.hzToMel(500).toFixed(3));
    ck('  1000Hz sits exactly on the knee at mel 15', Math.abs(mel.hzToMel(1000) - 15) < 1e-9);
    ck('  and it goes logarithmic above it',
       mel.hzToMel(2000) > 15 && mel.hzToMel(2000) < 2 * 15,
       'a linear scale would give 30 at 2kHz');
    ck('  hz→mel→hz round-trips', Math.abs(mel.melToHz(mel.hzToMel(3456)) - 3456) < 1e-6);
    // It must NOT be HTK. Asserted explicitly because "it is a mel scale"
    // is exactly the kind of thing that looks right and is wrong.
    ck('  and it is definitely not the HTK formula',
       Math.abs(mel.hzToMel(4000) - 2595 * Math.log10(1 + 4000 / 700)) > 1,
       'these two must disagree, or the wrong one is implemented');
}

section('B2 — and the filters carry Slaney AREA normalisation');
{
    // ADDED AFTER A MUTATION SURVIVED. Removing the `2/(hi-lo)` scaling —
    // leaving every triangle at unit height — changed nothing that any test
    // in this file could see, and it is not a small difference: mel filters
    // get wider with frequency, so without area normalisation the top of
    // the spectrum drowns out the bottom, which is where speech lives.
    const m = require('module');
    const fn = eval(m.wrap(SRC + '\n;module.exports.__FILTERS = FILTERS;'));
    const mod = { exports: {} };
    fn(mod.exports, require, mod, path.join(__dirname, '../desktop/melspec.js'), path.join(__dirname, '../desktop'));
    const { w, nBins } = mod.exports.__FILTERS;

    const peakOf = (i) => {
        let p = 0;
        for (let k = 0; k < nBins; k += 1) p = Math.max(p, w[i * nBins + k]);
        return p;
    };
    const areaOf = (i) => {
        let a = 0;
        for (let k = 0; k < nBins; k += 1) a += w[i * nBins + k];
        return a;
    };

    // Unnormalised triangles all peak at exactly 1. Normalised ones do not,
    // and the high ones — the widest — peak lowest.
    ck('the filters are not unit-height triangles',
       Math.abs(peakOf(70) - 1.0) > 0.01,
       'peak of filter 70 is ' + peakOf(70).toFixed(4) + '; exactly 1.0 means no normalisation');
    ck('  wide high-frequency filters peak lower than narrow low ones',
       peakOf(70) < peakOf(5),
       'this is what stops the top of the spectrum drowning out speech');
    // The point of area normalisation: equal area, not equal height.
    const areas = [10, 30, 50, 70].map(areaOf);
    const spread = Math.max(...areas) / Math.min(...areas);
    ck('  and their areas are comparable, which is the whole point',
       spread < 2.0,
       'area ratio across the bank is ' + spread.toFixed(2) + '; unnormalised it runs to 20x or worse');
}

section('C — the fixture that can be derived by hand');
{
    // Silence is the one input whose features can be worked out on paper:
    // variance 0 → normalised to 0 → power 0 → log10(1e-10) = -10 for every
    // cell → the global max is also -10 → the clamp does nothing →
    // (-10 + 4) / 4 = -1.5. Exactly, everywhere. No tolerance needed.
    const f = mel.logMel(new Float32Array(mel.N_SAMPLES));
    ck('the tensor is 80 x 800', f.length === mel.N_MELS * mel.N_FRAMES);
    let min = Infinity, max = -Infinity;
    for (const v of f) { if (v < min) min = v; if (v > max) max = v; }
    ck('  silence is exactly -1.5 in every cell', min === -1.5 && max === -1.5,
       'got ' + min + ' … ' + max);
}

section('D — THE PADDING GOES AT THE FRONT');
{
    // The single most likely thing to get backwards, and the reference is
    // explicit: pad at the beginning so the audio ends at the END of the
    // window. Padding at the end would put the speech where the model
    // expects silence — and this decides whether she gets interrupted.
    const short = new Float32Array(16000);           // 1 second
    for (let i = 0; i < short.length; i += 1) short[i] = Math.sin(2 * Math.PI * 440 * i / 16000);
    const f = mel.logMel(short);

    const frameEnergy = (t) => {
        let s = 0;
        for (let m = 0; m < mel.N_MELS; m += 1) s += f[m * mel.N_FRAMES + t];
        return s;
    };
    const early = frameEnergy(50);                    // 0.5s in — should be padding
    const late = frameEnergy(mel.N_FRAMES - 50);      // near the end — should be speech
    ck('one second of tone lands at the END of the window', late > early,
       'early ' + early.toFixed(1) + ' vs late ' + late.toFixed(1)
       + ' — if early is larger, the padding is on the wrong side');

    // And more than 8 seconds keeps the LAST 8, not the first.
    const long = new Float32Array(16000 * 12);        // 12 seconds
    // Silent for the first 10 seconds, tone in the final 2.
    for (let i = 16000 * 10; i < long.length; i += 1) long[i] = Math.sin(2 * Math.PI * 440 * i / 16000);
    const g = mel.logMel(long);
    const gEnergy = (t) => {
        let s = 0;
        for (let m = 0; m < mel.N_MELS; m += 1) s += g[m * mel.N_FRAMES + t];
        return s;
    };
    ck('  and long audio keeps the LAST 8 seconds', gEnergy(mel.N_FRAMES - 50) > gEnergy(50),
       'keeping the first 8 seconds would hand the model the part she already finished saying');
}

section('E — the window is periodic, and the clamp is global');
{
    // Periodic Hann starts at exactly 0 and its midpoint is exactly 1. The
    // symmetric version (numpy hanning(400)) divides by N-1 and never quite
    // reaches those values — a small difference that shifts every frame.
    ck('the Hann window is periodic, not symmetric',
       /0\.5 - 0\.5 \* Math\.cos\(2 \* Math\.PI \* i \/ N_FFT\)/.test(SRC),
       'dividing by N-1 gives the symmetric window, which is a different transform');

    // The clamp is 8 decades below the LOUDEST cell in the whole array. A
    // per-frame clamp would let quiet frames keep detail the model was never
    // trained to see.
    const tone = new Float32Array(mel.N_SAMPLES);
    for (let i = 0; i < tone.length; i += 1) tone[i] = Math.sin(2 * Math.PI * 440 * i / 16000);
    const f = mel.logMel(tone);
    let min = Infinity, max = -Infinity;
    for (const v of f) { if (v < min) min = v; if (v > max) max = v; }
    // After the clamp the range is exactly 8 decades, scaled by /4 → 2.0.
    // 1e-6, not 1e-9: the features are float32, so ~7 decimal digits is all
    // the precision there is. Demanding more was my error, and a test that
    // fails on the last bit of float32 is a test that will be ignored.
    ck('  the dynamic range is clamped to exactly 8 decades',
       Math.abs((max - min) - 2.0) < 1e-6,
       'range ' + (max - min).toFixed(9) + ' — a per-frame clamp would not give a clean 2.0');
}

section('F — it is fast enough to run on every pause');
{
    const noise = new Float32Array(mel.N_SAMPLES);
    let seed = 7;
    for (let i = 0; i < noise.length; i += 1) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        noise[i] = seed / 0x7fffffff - 0.5;
    }
    const t0 = Date.now();
    for (let i = 0; i < 5; i += 1) mel.logMel(noise);
    const each = (Date.now() - t0) / 5;
    // The model itself is ~12ms. Features an order of magnitude slower than
    // that would make the endpointer the bottleneck it was meant to remove.
    ck('features take well under 200ms', each < 200, each.toFixed(0) + 'ms per call');
    console.log('        (' + each.toFixed(0) + 'ms per 8-second window)');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
