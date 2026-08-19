// ── helpers/sevenSegment.js — local seven-segment LED reader ────────────────
//
// ⚠ STATUS 2026-08-19: EXPERIMENTAL. DELIBERATELY NOT WIRED INTO THE
// PRODUCTION PIPELINE. Nothing imports this yet, and it must not be
// imported until the accuracy problem below is resolved.
//
// Speed goal: MET. Reads in 25-65ms with no network call at all, against a
// 2s target — the existing Vision+Gemini path takes ~10s on this display.
//
// Accuracy: NOT YET GOOD ENOUGH TO TRUST. On Apsara's real Socome photo
// (true value 4210) it returns 4218 — the final "0" misreads as "8"
// because that digit is so bloomed (8,293 lit pixels vs ~3,100 for its
// neighbours) that the dark hole in the middle of the zero fills in, and
// the middle-segment fill reads 0.67 where a zero needs it near zero.
// Critically this is a CONFIDENT wrong answer, not an ambiguous one, so
// the ON/OFF ambiguity guard below does not catch it.
//
// A seven-segment misread is never a small error — it's a different number
// entirely. Shipping this as-is would silently put wrong weights on
// tickets, which is strictly worse than being slow.
//
// TO FINISH THIS, the two viable routes are:
//   1. AGREEMENT GATE (recommended): run this reader AND one Cloud Vision
//      call on the same crop in parallel, and only accept the result when
//      both independently produce the same number. Vision on a small crop
//      measures 190-500ms, so the combined path still lands around
//      500-600ms — comfortably inside 2s — while two independent methods
//      agreeing is far stronger evidence than either alone. This is the
//      same corroboration principle helpers/gemini.js already uses to skip
//      its Gemini cross-check. Disagreement falls back to the existing
//      pipeline.
//   2. Better de-blooming before thresholding (local adaptive threshold
//      rather than the global percentile used here). Needs a corpus of
//      real photos to tune against — tuning against the single available
//      photo would just overfit to it.
//
// Both need more sample photos across the yard's actual displays and
// lighting before any threshold in this file should be considered settled.
// Per Apsara 2026-08-19: "i just need to read it in 2s. use opencv if thats
// what you want. just use ocr. focus only on lit digits not ghost."
//
// This is a fully LOCAL, deterministic reader for seven-segment LED weight
// displays. No Cloud Vision call, no Gemini call, no network at all — which
// is the only way to reliably hit a 2s budget, since the existing pipeline's
// floor is set by a Vision round trip (190-500ms) plus, on hard displays, a
// deliberate ~10s Gemini second opinion.
//
// WHY NOT OPENCV: everything needed here is thresholding, connected
// components and sampling fixed sub-rectangles. sharp (already a dependency,
// already used throughout this file's neighbours) gives raw pixel buffers,
// and the rest is plain arithmetic. Adding opencv4nodejs would mean a heavy
// native build on the VM for operations that are a few dozen lines here.
//
// "FOCUS ONLY ON LIT DIGITS NOT GHOST" is the core of the approach, not a
// detail: an unlit/ghost seven-segment cell still reflects ambient light and
// is faintly visible, which is exactly what made the general-purpose OCR
// read phantom leading digits (the "2?4210" Gemini reported on the Socome
// photo). Here a pixel only counts if it is BOTH bright and strongly
// coloured relative to its surroundings, so a dim ghost cell contributes
// nothing at all and simply isn't part of any digit.

const sharp = require('sharp');

// Segment layout, as fractions of a digit's bounding box:
//      AAAA
//     F    B
//     F    B
//      GGGG
//     E    C
//     E    C
//      DDDD
// Each entry is [x0, y0, x1, y1] — the region sampled to decide if that
// segment is lit. Deliberately inset from the true segment extents so a
// slightly skewed or blurred digit doesn't bleed one segment into another.
const SEGMENTS = {
    A: [0.20, 0.02, 0.80, 0.18],
    B: [0.72, 0.12, 0.98, 0.44],
    C: [0.72, 0.56, 0.98, 0.88],
    D: [0.20, 0.82, 0.80, 0.98],
    E: [0.02, 0.56, 0.28, 0.88],
    F: [0.02, 0.12, 0.28, 0.44],
    G: [0.20, 0.42, 0.80, 0.58],
};

// Standard seven-segment truth table, keyed A,B,C,D,E,F,G.
const PATTERNS = {
    '1111110': '0',
    '0110000': '1',
    '1101101': '2',
    '1111001': '3',
    '0110011': '4',
    '1011011': '5',
    '1011111': '6',
    '1110000': '7',
    '1111111': '8',
    '1111011': '9',
    // Common real-world variants worth accepting rather than failing on:
    '1110001': '7', // 7 drawn with the extra top-left stroke on some panels
    '0111011': '4', // 4 with the top bar lit (rare, but seen on some indicators)
};

// Decide which pixels are "lit". Two independent conditions, both required:
//   1. bright, relative to the image's own brightness distribution
//   2. strongly saturated, i.e. one channel clearly dominates
// Condition 2 is what actually kills ghost cells: an unlit cell reflecting
// ambient light is greyish (all channels similar) even when it isn't dark,
// while a genuinely lit LED is overwhelmingly one colour. A brightness cut
// alone was tested and let ghosts through under a bright yard light.
function buildLitMask(data, width, height, channels) {
    const n = width * height;
    const lum = new Uint8Array(n);
    const sat = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        const o = i * channels;
        const r = data[o], g = data[o + 1], b = data[o + 2];
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        lum[i] = max;                       // value, not average — an LED's own channel
        sat[i] = max === 0 ? 0 : Math.round(((max - min) / max) * 255);
    }

    // Adaptive brightness threshold: take a high percentile of the value
    // channel. A fixed cutoff fails across a dim shed and a sunlit yard;
    // a percentile adapts to whatever this particular photo looks like.
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) hist[lum[i]]++;
    const LIT_FRACTION = 0.10; // lit segments occupy a small part of a display crop
    let target = Math.floor(n * LIT_FRACTION), acc = 0, lumCut = 255;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= target) { lumCut = v; break; } }
    lumCut = Math.max(lumCut, 60); // never accept near-black as "lit"

    const SAT_CUT = 60; // below this a pixel is effectively grey -> ghost/reflection
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = (lum[i] >= lumCut && sat[i] >= SAT_CUT) ? 1 : 0;
    return mask;
}

// 4-connected component labelling, iterative (an explicit stack, not
// recursion — a large lit region on a high-res crop would blow the call
// stack). Returns bounding boxes with pixel counts.
function connectedComponents(mask, width, height) {
    const seen = new Uint8Array(width * height);
    const boxes = [];
    const stack = new Int32Array(width * height);
    for (let start = 0; start < mask.length; start++) {
        if (!mask[start] || seen[start]) continue;
        let sp = 0;
        stack[sp++] = start;
        seen[start] = 1;
        let minX = width, minY = height, maxX = -1, maxY = -1, count = 0;
        while (sp > 0) {
            const p = stack[--sp];
            const x = p % width, y = (p / width) | 0;
            count++;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
            if (x < width - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
            if (y > 0 && mask[p - width] && !seen[p - width]) { seen[p - width] = 1; stack[sp++] = p - width; }
            if (y < height - 1 && mask[p + width] && !seen[p + width]) { seen[p + width] = 1; stack[sp++] = p + width; }
        }
        boxes.push({ minX, minY, maxX, maxY, count, w: maxX - minX + 1, h: maxY - minY + 1 });
    }
    return boxes;
}

// Split the lit mask into digits by COLUMN PROJECTION rather than by
// connected components. This is the crux of reading a seven-segment
// display: the segments of a single digit are physically separate strips
// with unlit gaps between them, so connected-component labelling returns
// one blob PER SEGMENT (measured: 14 blobs for a 4-digit display), never
// one per digit. Projecting lit-pixel counts onto the x axis instead gives
// one contiguous run per digit — the horizontal bars (A, G, D) bridge the
// digit's full width, so a digit is horizontally continuous even though it
// isn't connected — and the unlit space between digits shows up as a clean
// valley. Also naturally robust to the "1" case, which is a single bar.
function segmentDigitsByColumn(mask, width, height, band) {
    const { y0, y1 } = band;
    const colCounts = new Int32Array(width);
    for (let y = y0; y <= y1; y++) {
        const row = y * width;
        for (let x = 0; x < width; x++) if (mask[row + x]) colCounts[x]++;
    }
    // A column counts as part of a digit if it has any meaningful lit
    // content. Scaled to the band height so it adapts to crop size, with a
    // floor so a 1-2px speck never starts a digit.
    const bandH = y1 - y0 + 1;
    const colCut = Math.max(2, Math.round(bandH * 0.04));

    const runs = [];
    let start = -1;
    for (let x = 0; x < width; x++) {
        const on = colCounts[x] >= colCut;
        if (on && start === -1) start = x;
        if ((!on || x === width - 1) && start !== -1) {
            const end = on ? x : x - 1;
            runs.push({ x0: start, x1: end });
            start = -1;
        }
    }
    // Merge runs separated by a only a hairline gap — a badly blurred digit
    // can briefly dip below the column threshold in its middle (e.g. a "0"
    // whose bars are faint), which would otherwise split one digit into two
    // unreadable halves.
    // The threshold is deliberately TINY. An earlier version scaled it to
    // the band height (0.08x) and, once the band became the whole image,
    // that worked out to 22px — wider than the real ~16px gaps BETWEEN
    // digits, so all four digits merged into a single run and nothing could
    // be decoded. Inter-digit gaps are the thing that must never be bridged,
    // so this stays far below them.
    const gapCut = Math.max(2, Math.round(bandH * 0.015));
    const merged = [];
    for (const r of runs) {
        const prev = merged[merged.length - 1];
        if (prev && (r.x0 - prev.x1) <= gapCut) prev.x1 = r.x1;
        else merged.push({ ...r });
    }
    // Turn each column run into a tight box. Taking the run's full row
    // extent is NOT enough: on a real Socome panel the indicator lamps sit
    // directly BELOW the digits, in the same columns, so a run's raw extent
    // spans digit + gap + lamp (measured: h194 where the digit itself is
    // ~h130). So within each run, split the rows into vertical sub-runs and
    // keep the tallest — that's the digit, with the lamp discarded.
    const boxes = [];
    for (const r of merged) {
        const rowHits = new Int32Array(y1 - y0 + 1);
        for (let y = y0; y <= y1; y++) {
            const row = y * width;
            let c = 0;
            for (let x = r.x0; x <= r.x1; x++) if (mask[row + x]) c++;
            rowHits[y - y0] = c;
        }
        // Sub-runs of consecutive rows containing any lit pixel.
        const subs = [];
        let s = -1;
        for (let i = 0; i < rowHits.length; i++) {
            const on = rowHits[i] > 0;
            if (on && s === -1) s = i;
            if ((!on || i === rowHits.length - 1) && s !== -1) {
                const e = on ? i : i - 1;
                let count = 0;
                for (let k = s; k <= e; k++) count += rowHits[k];
                subs.push({ minY: y0 + s, maxY: y0 + e, h: e - s + 1, count });
                s = -1;
            }
        }
        if (!subs.length) continue;
        const best = subs.reduce((a, b) => (b.h > a.h ? b : a), subs[0]);
        boxes.push({
            minX: r.x0, maxX: r.x1, minY: best.minY, maxY: best.maxY,
            w: r.x1 - r.x0 + 1, h: best.h, count: best.count,
        });
    }
    return boxes;
}

// Find the horizontal band containing the digits. A display crop routinely
// also catches status LEDs (NET/ZERO) above and a strip of indicator lamps
// below — both measured on a real Socome photo.
//
// Picking the row-projection PEAK was tried first and is wrong: that photo's
// bottom indicator strip is a solid bright bar, so a single row of it
// contains more lit pixels (207) than any row crossing the digits, and the
// reader locked onto the lamps and read nothing. Digits are distinguished by
// being TALL, not by being dense — so this splits the image into contiguous
// lit bands and picks the tallest one, which is the digit row by a wide
// margin (measured: ~170px for the digits vs ~64px for the lamp strip).
function findDigitBand(mask, width, height) {
    const rowCounts = new Int32Array(height);
    let maxRow = 0;
    for (let y = 0; y < height; y++) {
        const row = y * width;
        let c = 0;
        for (let x = 0; x < width; x++) if (mask[row + x]) c++;
        rowCounts[y] = c;
        if (c > maxRow) maxRow = c;
    }
    if (!maxRow) return null;

    const cut = Math.max(1, Math.round(maxRow * 0.06));
    const bands = [];
    let y0 = -1;
    for (let y = 0; y < height; y++) {
        const on = rowCounts[y] >= cut;
        if (on && y0 === -1) y0 = y;
        if ((!on || y === height - 1) && y0 !== -1) {
            const y1 = on ? y : y - 1;
            let total = 0;
            for (let yy = y0; yy <= y1; yy++) total += rowCounts[yy];
            bands.push({ y0, y1, h: y1 - y0 + 1, total });
            y0 = -1;
        }
    }
    if (!bands.length) return null;
    bands.sort((a, b) => b.h - a.h); // tallest band = the digit row
    return bands[0];
}

function fillRatio(mask, width, box, seg) {
    const [fx0, fy0, fx1, fy1] = seg;
    const x0 = Math.round(box.minX + fx0 * box.w), x1 = Math.round(box.minX + fx1 * box.w);
    const y0 = Math.round(box.minY + fy0 * box.h), y1 = Math.round(box.minY + fy1 * box.h);
    let lit = 0, total = 0;
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            total++;
            if (mask[y * width + x]) lit++;
        }
    }
    return total ? lit / total : 0;
}

// A "1" is a special case: it's a narrow bar, so a normal segment grid over
// its own tight bounding box would light up F/E (the left verticals) as well
// as B/C and misread. Detected geometrically by aspect ratio against the
// other digits on the display rather than by pattern.
// Segment fills inside this band around the threshold are treated as
// undecidable. This is the single most important safety property of this
// reader: a seven-segment misread is not a small error, it is a completely
// different number (a bloomed "0" reads as "8" — measured on a real Socome
// photo, where the middle-segment fill came out 0.67 because glare filled
// the hole). A wrong weight printed confidently on a ticket is far worse
// than no weight at all, so any digit whose segments aren't cleanly on or
// off makes the whole read fail and hand back to the slower, cross-checked
// Vision/Gemini pipeline.
const ON_CUT = 0.42;
const OFF_CUT = 0.28;

function decodeDigit(mask, width, box, medianDigitWidth, medianCount) {
    // Narrow OR sparse => "1". Either signal alone is unreliable (see the
    // note at the call site on glow bloom widening a "1"), so both are
    // accepted independently.
    const narrow = medianDigitWidth && box.w < medianDigitWidth * 0.5;
    const sparse = medianCount && box.count < medianCount * 0.45;
    if (narrow || sparse) return '1';

    const keys = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    const bits = [];
    for (const k of keys) {
        const f = fillRatio(mask, width, box, SEGMENTS[k]);
        if (f >= ON_CUT) bits.push('1');
        else if (f <= OFF_CUT) bits.push('0');
        else return null; // ambiguous — refuse rather than guess
    }
    return PATTERNS[bits.join('')] || null;
}

// Reads a seven-segment display from an image buffer/base64.
// Returns { weight, digits, confidence, ms, reason } — weight is null when
// the display could not be read confidently, and the caller is expected to
// fall back to the existing Vision/Gemini pipeline in that case rather than
// treating null as zero.
async function readSevenSegment(input, opts = {}) {
    const t0 = Date.now();
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'base64');

    // Upscale small crops before analysis — segment sampling needs enough
    // pixels per digit to be stable. Cheap (a few ms) and materially
    // improves the fill ratios on a tight scanner crop.
    let img = sharp(buf).rotate();
    const meta = await img.metadata();
    const targetW = 900;
    if ((meta.width || 0) < targetW) img = img.resize({ width: targetW });

    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;

    const mask = buildLitMask(data, width, height, channels);

    // Column-segment the WHOLE image, then isolate the digits by vertical
    // alignment rather than by first finding a horizontal band. Band-finding
    // was tried twice and failed on a real Socome photo both ways: the
    // row-projection peak lands on the bottom indicator strip (a solid bar
    // has more lit pixels per row than any digit row), and thresholding rows
    // into bands merges the digits and that strip into one region because
    // display glow bridges them. Vertical alignment is the property that
    // actually separates them — every digit on a display shares a top and
    // bottom edge, while lamps, status LEDs and reflections sit elsewhere.
    const boxes = segmentDigitsByColumn(mask, width, height, { y0: 0, y1: height - 1 });
    if (!boxes.length) return { weight: null, digits: '', ms: Date.now() - t0, reason: 'no lit pixels found' };

    // Reference = the tallest run, which on a weight display is always a
    // digit (nothing else on the panel is that tall).
    const ref = boxes.reduce((a, b) => (b.h > a.h ? b : a), boxes[0]);
    const tol = Math.max(4, ref.h * 0.35);
    const candidates = boxes.filter(b =>
        b.h >= ref.h * 0.55 &&                       // comparable height
        Math.abs(b.minY - ref.minY) <= tol &&        // shares a top edge
        Math.abs(b.maxY - ref.maxY) <= tol &&        // shares a bottom edge
        b.count >= 15                                // not a speck
    );
    if (!candidates.length) return { weight: null, digits: '', ms: Date.now() - t0, reason: 'no digit-shaped lit regions' };

    candidates.sort((a, b) => a.minX - b.minX); // left to right

    // Force a COMMON vertical extent across all digits before decoding.
    // Every digit on a physical display shares one top and one bottom edge,
    // but each one's measured extent drifts with glare and bloom — on the
    // Socome test photo the per-digit heights came out 104, 127, 104 and
    // 167 for digits that are physically identical in height. Decoding each
    // against its own box therefore misaligns the segment grid: the "0"
    // scored 0.65 on the middle segment (which must be OFF for a zero) purely
    // because its box was ~60% taller than its neighbours, dragging the
    // middle sample band down into the lower bar. Using the median top and
    // bottom fixes the grid to the real digit row.
    const med = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
    const commonMinY = med(candidates.map(c => c.minY));
    const commonMaxY = med(candidates.map(c => c.maxY));
    const aligned = candidates.map(c => ({
        ...c, minY: commonMinY, maxY: commonMaxY, h: commonMaxY - commonMinY + 1,
    }));

    // "1" detection by LIT AREA rather than box width. A "1" lights two
    // segments where a "0" lights six, so its pixel count is a fraction of
    // its neighbours' — a far more reliable signal than width, because glow
    // bloom around a bright bar can widen a "1"'s column run until it's
    // nearly as wide as a full digit (measured: w66 vs a w74 "4" on the
    // Socome photo, which defeated the width test entirely).
    const medianCount = med(aligned.map(c => c.count));
    const medianW = med(aligned.map(c => c.w));

    const chars = aligned.map(c => decodeDigit(mask, width, c, medianW, medianCount));

    const unreadable = chars.filter(c => c === null).length;
    const digits = chars.map(c => (c === null ? '?' : c)).join('');
    if (unreadable) {
        return { weight: null, digits, ms: Date.now() - t0, reason: `${unreadable} of ${chars.length} digit(s) did not match a seven-segment pattern` };
    }
    if (!digits.length) return { weight: null, digits, ms: Date.now() - t0, reason: 'no digits decoded' };

    const weight = parseInt(digits, 10);
    if (!isFinite(weight)) return { weight: null, digits, ms: Date.now() - t0, reason: 'decoded digits are not a number' };

    // Plausibility bounds, matching the existing pipeline's own ceiling —
    // a decode outside these is a misread, not a real weight, and must not
    // be published as one.
    const MIN = opts.min != null ? opts.min : 1;
    const MAX = opts.max != null ? opts.max : 200000;
    if (weight < MIN || weight > MAX) {
        return { weight: null, digits, ms: Date.now() - t0, reason: `decoded ${weight}, outside the plausible range ${MIN}-${MAX}` };
    }

    return { weight, digits, digitCount: chars.length, ms: Date.now() - t0, reason: 'ok' };
}

module.exports = { readSevenSegment, buildLitMask, connectedComponents, SEGMENTS, PATTERNS };
