// ── helpers/visionOcr.js — Google Cloud Vision OCR for the weight-display crop ─
// Why this exists: Gemini (a general multimodal LLM reasoning about an image
// in language) was measurably unreliable reading digits off the yard's
// weighbridge display — even fed the exact same clean, correctly-cropped
// image with no ghost cell and no cutoff, it flipped between right and wrong
// answers call to call (verified live: 71920 / 37920 / 39920 / 77920 across
// repeated calls on an identical crop). Cloud Vision's TEXT_DETECTION is a
// different technology — a purpose-built character recognition model, not an
// LLM guessing at a digit shape — and it read the same crop correctly on the
// first try and every retry after that (deterministic, not sampled).
//
// This is a SEPARATE Google Cloud product from the Gemini API key the rest of
// this app uses — it needs the Cloud Vision API enabled (billing-gated,
// small free monthly quota) on a real GCP project. It reuses the exact same
// service account already sitting in GDRIVE_KEYFILE for Drive uploads, on
// the same project (vigilant-armor-490615-s1-cbd55) — no new credential file,
// just one more API enabled on it.
//
// Fails soft everywhere: if the API isn't enabled, the keyfile's missing, or
// the call errors for any reason, this returns null and the caller falls
// back to the existing Gemini-only pipeline — this can only ever add a
// chance of a better reading, never break weight-reading if Vision access
// changes or lapses.

const fs = require('fs');
const https = require('https');
const cfg = require('../config');

let authClientPromise = null;
function getAuthClient() {
    if (!authClientPromise) {
        authClientPromise = (async () => {
            const { GoogleAuth } = require('google-auth-library');
            if (!fs.existsSync(cfg.GDRIVE_KEYFILE)) throw new Error(`Vision OCR: keyfile missing (${cfg.GDRIVE_KEYFILE})`);
            const auth = new GoogleAuth({ keyFile: cfg.GDRIVE_KEYFILE, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
            return auth.getClient();
        })();
    }
    return authClientPromise;
}

function postJson(hostname, path, body, headers) {
    return new Promise((resolve, reject) => {
        const req = https.request({ hostname, path, method: 'POST', headers }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                try { resolve({ status: res.statusCode, json: JSON.parse(data) }); }
                catch (e) { reject(new Error(`Vision OCR: bad response (${res.statusCode}): ${data.slice(0, 300)}`)); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// Returns the raw detected text (string) or null. Deliberately dumb — no
// digit parsing here, that's the caller's job (this file only knows how to
// talk to the API, not what a plausible weight looks like).
async function detectText(imageBase64) {
    try {
        const client = await getAuthClient();
        const { token } = await client.getAccessToken();
        const body = JSON.stringify({
            requests: [{ image: { content: imageBase64 }, features: [{ type: 'TEXT_DETECTION' }] }],
        });
        const { status, json } = await postJson('vision.googleapis.com', '/v1/images:annotate', body, {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
        });
        if (status !== 200) {
            console.warn('[VISION-OCR] Non-200 response:', status, JSON.stringify(json).slice(0, 300));
            return null;
        }
        const resp = json.responses && json.responses[0];
        if (!resp || resp.error) {
            if (resp && resp.error) console.warn('[VISION-OCR] API error:', resp.error.message);
            return null;
        }
        const text = resp.textAnnotations && resp.textAnnotations[0] && resp.textAnnotations[0].description;
        return text ? text.trim() : null;
    } catch (err) {
        console.warn('[VISION-OCR] detectText failed, caller will fall back:', err.message);
        return null;
    }
}

// Pulls the longest run of digits (with an optional single decimal point)
// out of whatever Vision returned — on a crop that's already been tightly
// trimmed to just the lit digits this should just be the whole string, but
// staying defensive in case Vision picks up a stray character at an edge.
function extractWeightNumber(rawText) {
    if (!rawText) return null;
    const matches = rawText.match(/\d+(\.\d+)?/g);
    if (!matches || matches.length === 0) return null;
    const longest = matches.reduce((a, b) => (b.length > a.length ? b : a));
    const n = parseFloat(longest);
    return Number.isFinite(n) ? n : null;
}

// Plausible weight bounds for a scrap-metal truck LOAD (not a single item)
// — matches the domain knowledge already baked into the Gemini weight-
// reading prompt in helpers/gemini.js ("a scrap-metal truck load is
// realistically in the thousands to tens of thousands of lb/kg, not double
// or triple digits"). Used ONLY when reading a WHOLE, uncropped yard photo,
// where the frame can legitimately contain other numbers that aren't the
// load weight at all: a compact bench/platform scale reading for a single
// item, a date/timestamp, a truck ID, a phone number on a sign. A naive
// "grab the longest digit run in the whole photo" pick (extractWeightNumber
// below) can silently latch onto one of those instead of the actual
// weighbridge display — on a tightly cropped display image that's not a
// risk (nothing else is in frame), which is why extractWeightNumber is left
// untouched and still used for the crop path.
const PLAUSIBLE_LOAD_WEIGHT_MIN = 200;
const PLAUSIBLE_LOAD_WEIGHT_MAX = 200000;

// Returns { weight, ambiguous, candidates } instead of a bare number so the
// caller can decide how much to trust it. `ambiguous: true` means more than
// one number in the photo fell inside the plausible load-weight range (e.g.
// a bench-scale item reading alongside the real weighbridge reading) — in
// that case `weight` is just the largest candidate (a full vehicle load is
// virtually always heavier than a bench-scale item weight), and the caller
// should surface that uncertainty to a human rather than trust it silently.
function extractPlausibleWeightFromFullImage(rawText) {
    if (!rawText) return { weight: null, ambiguous: false, candidates: [] };
    const matches = rawText.match(/\d+(\.\d+)?/g) || [];
    const numeric = matches.map((m) => parseFloat(m)).filter((n) => Number.isFinite(n));
    const inRange = numeric.filter((n) => n >= PLAUSIBLE_LOAD_WEIGHT_MIN && n <= PLAUSIBLE_LOAD_WEIGHT_MAX);
    if (inRange.length === 0) return { weight: null, ambiguous: false, candidates: numeric };
    const uniqueInRange = [...new Set(inRange)];
    if (uniqueInRange.length === 1) return { weight: uniqueInRange[0], ambiguous: false, candidates: numeric };
    return { weight: Math.max(...uniqueInRange), ambiguous: true, candidates: numeric };
}

// Root cause found 2026-08-10, confirmed by actually re-running
// locateRedDisplayByPixels + cropToDisplay against a real production photo
// that had just produced a wrong "4771920" read: the crop DOES sometimes
// still contain a faint ghost/dead LED cell right next to the real digits
// (visually confirmed — a dim, out-of-focus cell sits to the left of the
// bright "71920" on that display). It survives trimDeadDigitZones on
// purpose — that trim's 50%-of-peak keep threshold has to be generous or it
// wrongly discards a real second digit group (see the comment on
// trimDeadDigitZones in helpers/gemini.js, a real bug that threshold fixed).
// Vision read the whole crop as ONE unbroken digit string, with no space
// between the ghost cell's misread characters and the real number ("47" +
// "71920" = "4771920", confirmed against the real crop) — so
// extractWeightNumber's plain "longest digit run" can't be trusted blind on
// the crop path either, the same way it never could on the whole image.
//
// The fix leans on a pattern that's held across every single misread in
// this whole debugging session, this one included: the TRAILING digits are
// always correct, the corruption is always extra/wrong digits on the LEFT
// (that's consistent with the physical cause — the dead/ghost cell is
// always the leading, leftmost cell on these displays, never a trailing
// one). So: prefer any single already-plausible token first (the normal,
// clean-crop case — most crops hit this and it's a no-op). Only if nothing
// is plausible on its own, and the longest run is implausibly large, strip
// leading digits (never trailing) one at a time until what's left falls in
// range. Capped at 2 stripped digits — every real ghost-cell contamination
// actually observed across this whole session has been 1 or 2 stray
// leading digits, never more, so allowing exactly that much and no further
// keeps this from rescuing a genuinely garbage read. Past the cap this
// returns null (a missing reading a human re-checks) rather than keep
// guessing into a wrong number.
// Every trim is logged loudly so a repeat of this is visible, not silently
// "corrected" and forgotten.
function extractWeightNumberFromCrop(rawText) {
    if (!rawText) return null;
    const matches = rawText.match(/\d+(\.\d+)?/g);
    if (!matches || matches.length === 0) return null;

    const inRange = matches.filter((m) => {
        const v = parseFloat(m);
        return Number.isFinite(v) && v >= PLAUSIBLE_LOAD_WEIGHT_MIN && v <= PLAUSIBLE_LOAD_WEIGHT_MAX;
    });
    if (inRange.length === 1) return parseFloat(inRange[0]);

    const longest = matches.reduce((a, b) => (b.length > a.length ? b : a));
    const n = parseFloat(longest);

    if (inRange.length === 0 && Number.isFinite(n)) {
        for (let strip = 1; strip <= 2 && strip < longest.length; strip++) {
            const suffix = longest.slice(strip);
            const val = parseFloat(suffix);
            if (Number.isFinite(val) && val >= PLAUSIBLE_LOAD_WEIGHT_MIN && val <= PLAUSIBLE_LOAD_WEIGHT_MAX) {
                console.warn(`[VISION-OCR] Crop read "${longest}" isn't a plausible weight, but stripping ${strip} leading digit(s) gives "${suffix}" — using that (dead/ghost LED cell contamination has been on the left edge in every case seen so far, never the right)`);
                return val;
            }
        }
        console.warn(`[VISION-OCR] Crop read "${longest}" isn't a plausible weight (${PLAUSIBLE_LOAD_WEIGHT_MIN}-${PLAUSIBLE_LOAD_WEIGHT_MAX}) and no leading-digit trim fixes it — returning null rather than a very likely wrong number`);
        return null;
    }

    // Multiple in-range candidates (rare on an isolated crop), or the
    // straightforward already-plausible single-match case — same fallback
    // behavior extractWeightNumber always had.
    return Number.isFinite(n) ? n : null;
}

module.exports = { detectText, extractWeightNumber, extractWeightNumberFromCrop, extractPlausibleWeightFromFullImage };
