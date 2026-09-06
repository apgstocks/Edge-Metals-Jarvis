// ── desktop/melspec.js — Whisper's log-mel features, in JavaScript ────────
//
// Smart Turn v3 does NOT take a waveform. Its input tensor is called
// `input_features` and its shape is [batch, 80, 800]: a Whisper log-mel
// spectrogram of exactly 8 seconds at 16 kHz. The model's own README talks
// about "analysing the raw waveform" — true of the system, not of the tensor —
// and there is no JavaScript implementation of this feature extractor
// anywhere, so it is ported here from pipecat's `_whisper_features.py`.
//
// EVERY STEP MATTERS AND SEVERAL ARE COUNTERINTUITIVE
// --------------------------------------------------
// This is the kind of code that produces plausible-looking numbers while
// being subtly wrong, and a subtly wrong spectrogram gives a confident,
// meaningless probability. The four places a port usually breaks:
//
//   1. PADDING GOES AT THE START. Short audio is padded at the FRONT so the
//      speech sits at the END of the window, and long audio keeps the LAST
//      8 seconds. Padding at the end — the obvious choice — puts the speech
//      where the model expects silence.
//   2. The Hann window is PERIODIC, not symmetric: hanning(401) with the
//      last point dropped, matching torch.hann_window. numpy's hanning(400)
//      is the symmetric one and is subtly different.
//   3. The mel filterbank is SLANEY scale with SLANEY area normalisation,
//      not HTK. The two disagree by enough to matter.
//   4. The dynamic-range clamp uses a GLOBAL maximum over the whole 80×800
//      array, taken AFTER the final frame is dropped.
//
// n_fft is 400, which is not a power of two, so the FFT below is Bluestein's
// algorithm over a padded radix-2 transform rather than a plain one. A direct
// DFT would be ~64 million complex operations per utterance and would cost
// more than the model it feeds.

const N_FFT = 400;
const HOP = 160;
const N_MELS = 80;
const SAMPLE_RATE = 16000;
const N_SAMPLES = 128000;          // 8 seconds
const N_FRAMES = 800;
const VARIANCE_EPS = 1e-7;

// ── radix-2 complex FFT, iterative, in place ─────────────────────────────
function fftRadix2(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i += 1) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            let t = re[i]; re[i] = re[j]; re[j] = t;
            t = im[i]; im[i] = im[j]; im[j] = t;
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = -2 * Math.PI / len;
        const wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let cr = 1, ci = 0;
            for (let k = 0; k < len / 2; k += 1) {
                const ar = re[i + k], ai = im[i + k];
                const br = re[i + k + len / 2], bi = im[i + k + len / 2];
                const tr = br * cr - bi * ci;
                const ti = br * ci + bi * cr;
                re[i + k] = ar + tr; im[i + k] = ai + ti;
                re[i + k + len / 2] = ar - tr; im[i + k + len / 2] = ai - ti;
                const ncr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr; cr = ncr;
            }
        }
    }
}

// ── Bluestein: an FFT of arbitrary length via a power-of-two one ─────────
// Precomputed once, because it runs 800 times per utterance.
const BLUESTEIN = (() => {
    const n = N_FFT;
    let m = 1;
    while (m < 2 * n - 1) m <<= 1;              // 1024 for n=400
    const cosT = new Float64Array(n), sinT = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
        // (i*i) mod 2n keeps the angle exact for large i.
        const j = (i * i) % (2 * n);
        const a = Math.PI * j / n;
        cosT[i] = Math.cos(a); sinT[i] = Math.sin(a);
    }
    const kr = new Float64Array(m), ki = new Float64Array(m);
    kr[0] = cosT[0]; ki[0] = sinT[0];
    for (let i = 1; i < n; i += 1) {
        kr[i] = kr[m - i] = cosT[i];
        ki[i] = ki[m - i] = sinT[i];
    }
    fftRadix2(kr, ki);
    return { m, cosT, sinT, kr, ki };
})();

// Returns the first 201 bins (rfft) as power |X|^2.
function rfftPower(frame, out) {
    const n = N_FFT;
    const { m, cosT, sinT, kr, ki } = BLUESTEIN;
    const ar = new Float64Array(m), ai = new Float64Array(m);
    for (let i = 0; i < n; i += 1) {
        ar[i] = frame[i] * cosT[i];
        ai[i] = -frame[i] * sinT[i];
    }
    fftRadix2(ar, ai);
    for (let i = 0; i < m; i += 1) {
        const r = ar[i] * kr[i] - ai[i] * ki[i];
        const t = ar[i] * ki[i] + ai[i] * kr[i];
        ar[i] = r; ai[i] = t;
    }
    // Inverse transform, by conjugation.
    for (let i = 0; i < m; i += 1) ai[i] = -ai[i];
    fftRadix2(ar, ai);
    for (let i = 0; i <= n / 2; i += 1) {
        const r = (ar[i] * cosT[i] + ai[i] * sinT[i]) / m;
        const im = (-ar[i] * sinT[i] + ai[i] * cosT[i]) / m;
        // ai was conjugated for the inverse, so the sign of the imaginary
        // part is flipped back here.
        const rr = r, ii = -im;
        out[i] = rr * rr + ii * ii;
    }
}

// ── the Slaney mel filterbank ────────────────────────────────────────────
// Linear below 1 kHz, logarithmic above — NOT the HTK formula, which is
// logarithmic throughout. Using the wrong one shifts every filter.
function hzToMel(f) {
    const fSp = 200.0 / 3;
    if (f < 1000) return f / fSp;
    const logStep = Math.log(6.4) / 27.0;
    return 15.0 + Math.log(f / 1000.0) / logStep;
}
function melToHz(m) {
    const fSp = 200.0 / 3;
    if (m < 15.0) return m * fSp;
    const logStep = Math.log(6.4) / 27.0;
    return 1000.0 * Math.exp(logStep * (m - 15.0));
}

const FILTERS = (() => {
    const nBins = N_FFT / 2 + 1;                       // 201
    const fftFreqs = new Float64Array(nBins);
    for (let i = 0; i < nBins; i += 1) fftFreqs[i] = (i * SAMPLE_RATE / 2) / (nBins - 1);

    const melMin = hzToMel(0), melMax = hzToMel(SAMPLE_RATE / 2);
    const melPts = new Float64Array(N_MELS + 2);
    for (let i = 0; i < N_MELS + 2; i += 1) {
        melPts[i] = melToHz(melMin + (melMax - melMin) * i / (N_MELS + 1));
    }

    // One flat array of 80*201, so the matrix multiply below is a tight loop.
    const w = new Float64Array(N_MELS * nBins);
    for (let i = 0; i < N_MELS; i += 1) {
        const lo = melPts[i], mid = melPts[i + 1], hi = melPts[i + 2];
        // Slaney AREA normalisation: each filter integrates to the same
        // value, so wide high-frequency filters do not dominate.
        const enorm = 2.0 / (hi - lo);
        for (let k = 0; k < nBins; k += 1) {
            const f = fftFreqs[k];
            const lower = (f - lo) / (mid - lo);
            const upper = (hi - f) / (hi - mid);
            const v = Math.max(0, Math.min(lower, upper));
            w[i * nBins + k] = v * enorm;
        }
    }
    return { w, nBins };
})();

// ── the periodic Hann window ─────────────────────────────────────────────
const WINDOW = (() => {
    const w = new Float64Array(N_FFT);
    // PERIODIC: 0.5 - 0.5*cos(2*pi*i/N), i.e. hanning(N+1) without its last
    // point. The symmetric version divides by (N-1) and is a different window.
    for (let i = 0; i < N_FFT; i += 1) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N_FFT);
    return w;
})();

// Pads at the START / keeps the LAST 8 seconds. See the header — this is the
// step a port gets backwards, and getting it backwards puts the speech where
// the model expects silence.
function fitWindow(pcm) {
    const out = new Float64Array(N_SAMPLES);
    if (pcm.length >= N_SAMPLES) {
        const from = pcm.length - N_SAMPLES;
        for (let i = 0; i < N_SAMPLES; i += 1) out[i] = pcm[from + i];
    } else {
        const at = N_SAMPLES - pcm.length;
        for (let i = 0; i < pcm.length; i += 1) out[at + i] = pcm[i];
    }
    return out;
}

// pcm: Float32Array, 16kHz mono. Returns Float32Array of 80*800, laid out
// [mel][frame] — the order the ONNX tensor [1, 80, 800] expects.
function logMel(pcm) {
    const x = fitWindow(pcm || new Float32Array(0));

    // Zero-mean, unit-variance over the WHOLE buffer, leading zeros included.
    let mean = 0;
    for (let i = 0; i < N_SAMPLES; i += 1) mean += x[i];
    mean /= N_SAMPLES;
    let varc = 0;
    for (let i = 0; i < N_SAMPLES; i += 1) { const d = x[i] - mean; varc += d * d; }
    varc /= N_SAMPLES;                          // population variance, ddof=0
    const inv = 1 / Math.sqrt(varc + VARIANCE_EPS);
    for (let i = 0; i < N_SAMPLES; i += 1) x[i] = (x[i] - mean) * inv;

    // Reflect-pad by n_fft/2 at both ends, which is what centred STFT means.
    const pad = N_FFT / 2;
    const padded = new Float64Array(N_SAMPLES + 2 * pad);
    for (let i = 0; i < pad; i += 1) padded[i] = x[pad - i];
    padded.set(x, pad);
    for (let i = 0; i < pad; i += 1) padded[N_SAMPLES + pad + i] = x[N_SAMPLES - 2 - i];

    const nBins = FILTERS.nBins;
    const frame = new Float64Array(N_FFT);
    const power = new Float64Array(nBins);
    // 801 frames are produced and the LAST is dropped, per the reference.
    const nOut = N_FRAMES;
    const out = new Float32Array(N_MELS * nOut);
    let globalMax = -Infinity;

    for (let t = 0; t < nOut; t += 1) {
        const off = t * HOP;
        for (let i = 0; i < N_FFT; i += 1) frame[i] = padded[off + i] * WINDOW[i];
        rfftPower(frame, power);
        for (let m = 0; m < N_MELS; m += 1) {
            let acc = 0;
            const base = m * nBins;
            for (let k = 0; k < nBins; k += 1) acc += FILTERS.w[base + k] * power[k];
            const v = Math.log10(Math.max(1e-10, acc));
            out[m * nOut + t] = v;
            if (v > globalMax) globalMax = v;
        }
    }

    // GLOBAL clamp, then scale. Both after the frame drop.
    const floor = globalMax - 8.0;
    for (let i = 0; i < out.length; i += 1) {
        out[i] = (Math.max(out[i], floor) + 4.0) / 4.0;
    }
    return out;
}

module.exports = { logMel, N_MELS, N_FRAMES, N_SAMPLES, SAMPLE_RATE, hzToMel, melToHz };
