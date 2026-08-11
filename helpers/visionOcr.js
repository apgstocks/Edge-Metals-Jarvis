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
// Confirmed directly by Apsara 2026-08-10: gross and tare can NEVER exceed
// 90,000 lb per item at this yard — a real, hard business ceiling, not a
// guess. This matters beyond just "tighter is safer": a ghost/dead LED cell
// misread as a leading digit glued onto a real "71920" can produce
// "171920", and with a too-generous ceiling (this was 200000, then loosely
// tightened to 99999 as an interim guess) that collision number can itself
// look "plausible" and pass through BEFORE the leading-digit-strip fallback
// below ever gets a chance to run — confirmed live on a real photo
// 2026-08-10. Every real reading confirmed anywhere in this whole
// debugging session (71920, 81460, 81528, ~87520) is comfortably under
// 90,000. If this ceiling ever needs to change, it should be because the
// real business limit changed, not because a reading is failing to pass —
// raising it without a real reason reopens exactly this class of bug.
const PLAUSIBLE_LOAD_WEIGHT_MAX = 90000;

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
// Return shape changed 2026-08-11 from a bare number to { weight,
// viaLeadingStrip } — see the long comment at the leading-digit-strip
// fallback below for the real-photo bug this was added to catch. A caller
// that only needs the number can still do `extractWeightNumberFromCrop(t)
// ?.weight`; callers that care whether this required the strip fallback
// (a materially less certain path than a clean single in-range match) can
// check `.viaLeadingStrip` and flag the result for review instead of
// treating it as equal-confidence to a direct read.
function extractWeightNumberFromCrop(rawText) {
    if (!rawText) return null;
    const matches = rawText.match(/\d+(\.\d+)?/g);
    if (!matches || matches.length === 0) return null;

    // Added 2026-08-11 after a real "Fairbanks IQ plus 710" crop returned
    // the wrong number (710, a model-number fragment) instead of the true
    // 80720. Root cause: Vision's OCR on this display repeatedly (4+
    // separate real crops, not a one-off) misreads the "lb" unit suffix as
    // "1b" with no space before it — "80720 lb" comes back as "807201b",
    // which the digit-run regex above captures whole as "807201": the real
    // weight with a spurious extra "1" glued on from the misread unit
    // label. That pushes it out of the plausible range and excludes it,
    // leaving only the wrong "710" behind. This un-glues that specific,
    // repeatable pattern into an additional candidate BEFORE range-checking
    // (a trailing artifact — distinct from the leading ghost-cell strip
    // below, which handles a different, unrelated contamination pattern).
    const unglued = [];
    const lbSuffixRe = /(\d+)1b\b/gi;
    let lbMatch;
    while ((lbMatch = lbSuffixRe.exec(rawText))) unglued.push(lbMatch[1]);

    // Added 2026-08-11 after a real "ZOSI" weighbridge crop (a photo already
    // documented above as a genuinely hard, dim/angled case) came back from
    // Vision as "8 1960" — a SPACE between the leading digit and the rest of
    // the number, splitting one true 5-digit reading (81960) into two
    // separate regex matches ("8" and "1960"). "8" alone fails the
    // plausible-range filter (too small) and "1960" alone PASSES it (it's a
    // real 4-digit number in range) — so without this, the split silently
    // wins as a single valid in-range candidate and returns the wrong,
    // truncated 1960 instead of ever being flagged as wrong. This is the
    // opposite failure of the "lb"->"1b" glue case above (there, Vision
    // wrongly JOINS two things; here it wrongly SPLITS one number) — same
    // root cause class (OCR whitespace handling on a dot-matrix display,
    // not a systematic error), opposite direction, so it needs its own
    // targeted un-split alongside the existing un-glue. Deliberately narrow:
    // only a 1-2 digit token immediately followed by a single space/tab and
    // a 3-6 digit token, matching the exact shape seen live (a lone leading
    // digit separated from the rest) — not a general "remove all spaces
    // from numbers" rule, which would risk merging unrelated numbers
    // elsewhere in the crop text (e.g. two different labels' worth of
    // digits that happen to sit near each other).
    const splitMerged = [];
    const splitRe = /\b(\d{1,2})[ \t]+(\d{3,6})\b/g;
    let splitMatch;
    while ((splitMatch = splitRe.exec(rawText))) splitMerged.push(splitMatch[1] + splitMatch[2]);

    const allCandidates = matches.concat(unglued, splitMerged);

    const inRange = allCandidates.filter((m) => {
        const v = parseFloat(m);
        return Number.isFinite(v) && v >= PLAUSIBLE_LOAD_WEIGHT_MIN && v <= PLAUSIBLE_LOAD_WEIGHT_MAX;
    });
    if (inRange.length === 1) return { weight: parseFloat(inRange[0]), viaLeadingStrip: false };

    if (inRange.length > 1) {
        // Bug found + fixed 2026-08-11 via a real live crop from a
        // "Fairbanks IQ plus 710" indicator: this branch used to fall
        // through to the code below, which picks the longest-STRING match
        // across ALL digit fragments regardless of whether it was even
        // in-range — completely bypassing the plausibility filter this
        // function exists to enforce. Reproduced live: the crop's label
        // text contained the scale's capacity rating "100000.1" (out of
        // range, > 90000) right next to the true reading "80720" (in
        // range) — "100000.1" is a longer STRING, so it silently won and
        // was returned as a confident, unflagged primary weight. Now picks
        // the longest among the IN-RANGE candidates only, so an
        // implausible number can never win purely by being a longer string.
        const longestInRange = inRange.reduce((a, b) => (b.length > a.length ? b : a));
        return { weight: parseFloat(longestInRange), viaLeadingStrip: false };
    }

    const longest = allCandidates.reduce((a, b) => (b.length > a.length ? b : a));
    const n = parseFloat(longest);

    // inRange.length === 0 here — nothing at all fell in the plausible
    // range, so try stripping leading digit(s) (dead/ghost LED
    // contamination, seen on the left edge in every case so far) before
    // giving up and returning null rather than guessing.
    //
    // CAVEAT found live 2026-08-11 (a fresh photo of what looks like the
    // same physical reading confirmed elsewhere in this session as 81528):
    // Vision read this crop as "817520" — six digits. Stripping the leading
    // "8" gives "17520", which IS in the plausible range and is what this
    // function used to return, silently, as if it were a clean match. But
    // Gemini's independent parallel read of the SAME crop said "87520", and
    // the actual display (checked directly, zoomed in) shows a pattern
    // consistent with 8-?-5-2-0, not 1-7-5-2-0 at all — the spurious digit
    // here was NOT a prepended ghost cell on the far left like every prior
    // case, it was inserted in the MIDDLE (or the "8"/"1" boundary is
    // genuinely ambiguous), and blindly stripping the first character
    // produced a wrong, confident, unflagged number that happens to still
    // pass the range check. This function still doesn't know which case
    // it's in (a real fix would need to disambiguate 8-vs-1 at the pixel
    // level, out of scope here), so it now marks this path viaLeadingStrip
    // so the caller can flag it for review instead of trusting it as fully
    // as a clean single in-range match.
    if (Number.isFinite(n)) {
        for (let strip = 1; strip <= 2 && strip < longest.length; strip++) {
            const suffix = longest.slice(strip);
            const val = parseFloat(suffix);
            if (Number.isFinite(val) && val >= PLAUSIBLE_LOAD_WEIGHT_MIN && val <= PLAUSIBLE_LOAD_WEIGHT_MAX) {
                console.warn(`[VISION-OCR] Crop read "${longest}" isn't a plausible weight, but stripping ${strip} leading digit(s) gives "${suffix}" — using that, flagged as lower-confidence (dead/ghost LED cell contamination has been on the left edge in every case seen so far, but is not guaranteed to be — see caveat above)`);
                return { weight: val, viaLeadingStrip: true };
            }
        }
    }
    console.warn(`[VISION-OCR] Crop read "${longest}" isn't a plausible weight (${PLAUSIBLE_LOAD_WEIGHT_MIN}-${PLAUSIBLE_LOAD_WEIGHT_MAX}) and no leading-digit trim fixes it — returning null rather than a very likely wrong number`);
    return null;
}

module.exports = { detectText, extractWeightNumber, extractWeightNumberFromCrop, extractPlausibleWeightFromFullImage };
