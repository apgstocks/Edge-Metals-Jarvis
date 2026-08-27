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

// Added 2026-08-12 — same request as detectText but asking for
// DOCUMENT_TEXT_DETECTION, whose response carries a per-symbol confidence
// score that TEXT_DETECTION omits. Those scores were being thrown away
// entirely, and they are the only signal we have that tells us Vision itself
// is unsure BEFORE any second model is consulted — which is what lets the
// caller skip a slow cross-check when the read is demonstrably solid, rather
// than waiting on a clock.
//
// Kept as a SEPARATE function rather than changing detectText: four other
// call sites depend on detectText's existing behaviour, and while both
// feature types were measured to return identical text on these crops, there
// is no reason to put that to the test on paths this change does not need to
// touch.
//
// Confidence is reported over DIGIT symbols only. The crops routinely contain
// fixed panel text ("ZOSI", "LB", "KG", "GR", "NT") whose recognition
// confidence says nothing about whether the weight was read correctly, and
// averaging it in would dilute exactly the signal we want.
async function detectTextWithConfidence(imageBase64) {
    try {
        const client = await getAuthClient();
        const { token } = await client.getAccessToken();
        const body = JSON.stringify({
            requests: [{ image: { content: imageBase64 }, features: [{ type: 'DOCUMENT_TEXT_DETECTION' }] }],
        });
        const { status, json } = await postJson('vision.googleapis.com', '/v1/images:annotate', body, {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
        });
        if (status !== 200) {
            console.warn('[VISION-OCR] Non-200 response (with-confidence):', status, JSON.stringify(json).slice(0, 300));
            return null;
        }
        const resp = json.responses && json.responses[0];
        if (!resp || resp.error) {
            if (resp && resp.error) console.warn('[VISION-OCR] API error (with-confidence):', resp.error.message);
            return null;
        }
        const text = resp.textAnnotations && resp.textAnnotations[0] && resp.textAnnotations[0].description;
        // Confidence is tracked PER CONTIGUOUS DIGIT RUN, not pooled across
        // the whole crop. Corrected 2026-08-12 after the pooled version was
        // measured useless: these crops contain printed panel text with its
        // own digits — a model number "710", a capacity rating "100000.1",
        // "FB1150", "EST 1830" — which Vision reads at confidences as low as
        // 0.31. Taking a minimum across all of them reported 0.32 for a crop
        // whose actual weight digits ("80720") were read cleanly, making the
        // number meaningless for judging the reading we care about. Grouping
        // into runs lets the caller ask specifically about the run it chose
        // as the weight.
        const runs = [];
        let current = null;
        const fta = resp.fullTextAnnotation;
        if (fta && fta.pages) {
            for (const page of fta.pages) for (const block of (page.blocks || [])) for (const para of (block.paragraphs || [])) for (const word of (para.words || [])) for (const sym of (word.symbols || [])) {
                const t = sym.text || '';
                if (/^\d$/.test(t)) {
                    if (!current) current = { text: '', confs: [] };
                    current.text += t;
                    current.confs.push(sym.confidence != null ? sym.confidence : 1);
                } else if (current) {
                    runs.push(current);
                    current = null;
                }
            }
        }
        if (current) runs.push(current);
        return {
            text: text ? text.trim() : null,
            runs,
            // Confidence of a specific number, by value — the caller passes
            // the weight it settled on and gets back how sure Vision was
            // about those exact digits.
            //
            // Prefix matching matters as much as exact matching, and was
            // added after the exact-only version was measured to return null
            // on the ordinary case: Vision reliably misreads the "lb" unit
            // suffix on these indicators as "1b" and glues it to the number,
            // so the true 80720 arrives as a single run "807201" and is
            // recovered by the un-glue repair further down this file. The
            // weight's own digits were read confidently; only the phantom
            // trailing "1" is junk. Scoring the first N symbols of a run that
            // STARTS with the number answers the question actually being
            // asked -- how sure was Vision about these digits -- instead of
            // discarding the evidence because a unit label got attached.
            //
            // Still null when the number cannot be traced to a contiguous run
            // at all, which correctly reads as "no confidence evidence"
            // rather than a falsely reassuring score.
            confidenceFor(value) {
                if (value == null) return null;
                const wanted = String(value);
                for (const r of runs) {
                    if (r.text === wanted) return Math.min(...r.confs);
                    if (r.text.startsWith(wanted)) return Math.min(...r.confs.slice(0, wanted.length));
                }
                return null;
            },
        };
    } catch (err) {
        console.warn('[VISION-OCR] detectTextWithConfidence failed, caller will fall back:', err.message);
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

// Expected number of digits on the yard's weight display, per Apsara
// 2026-08-19 ("its never 146") — her scale always shows a 4-digit weight.
//
// This exists because the range check alone is not a strong enough
// constraint on THIS display. The Socome indicator keeps two leading cells
// permanently lit as "8.8.", so Vision returns e.g. "883475" for a true
// 3475. The leading-strip loop below then removes ONE digit, gets 83475,
// finds that inside 200-90000, and stops — returning a confidently wrong
// number that passes every check. Knowing the real reading is 4 digits
// makes 83475 impossible and 3475 the only candidate.
//
// Deliberately opt-in and env-configurable rather than hardcoded to 4: a
// yard with a 5-digit weighbridge must not have correct readings rejected.
// Unset (the default) preserves the previous behaviour exactly.
// Read at CALL time, not module-load time. A module-level const captures
// whatever the environment looked like the instant this file was first
// required, which makes behaviour depend on require order — and it silently
// evaluated to null in the integrated pipeline while working correctly in a
// standalone test, which is exactly the kind of discrepancy that wastes an
// afternoon. A function has no such ordering hazard.
function expectedWeightDigits() {
    return Number(process.env.EXPECTED_WEIGHT_DIGITS) || null;
}

// ⚠ WHY EXPECTED_WEIGHT_DIGITS IS STILL OFF BY DEFAULT (measured 2026-08-27).
// It is tempting to just set it to 4 and be done: on the 10-photo Socome
// corpus that alone moves the scanner from 6/10 to 8/10. Do NOT do that
// globally. This function is shared by BOTH capture paths, and the yard has
// two displays with different digit counts — the 4-digit Socome indicator
// (3475, 4210, ...) and the 5-digit weighbridge, whose real confirmed
// readings are recorded at the top of this file (71920, 81460, 81528,
// ~87520). With expDigits=4 the rightmost-N rule turns a true 81460 into
// 1460, silently and unflagged, which is the single worst failure this file
// can produce. The env var stays opt-in for a single-scale yard.
//
// Instead, the ghost prefix is resolved by CORROBORATION: the scanner gate
// already runs Gemini over the identical crop in parallel, and on exactly
// the photos where Vision keeps a ghost digit, Gemini reads the true value
// (measured: Vision 83475 / Gemini 3475, Vision 83939 / Gemini 3939). So
// this function now also reports the alternative readings a ghost strip
// would produce, and the caller accepts one only when the second engine
// independently landed on it. That needs no configuration and cannot
// truncate a genuine 5-digit weighbridge reading, because 81460 is only
// ever replaced by 1460 if Gemini also said 1460.
const GHOST_PREFIX_CHARS = /^[890.]+$/;

// The readings a leading-ghost strip would yield, with a note on whether the
// removed prefix actually looks like ghost contamination. The Socome
// indicator holds two cells permanently lit as "8.8.", and every ghost case
// observed here has been a leading 8, 9 or 0 — so a prefix of "88", "98" or
// "8." is corroboration-eligible, while stripping a "4" off a real 4896 is
// not. Purely additive: callers that only read .weight are unaffected.
function ghostStripCandidates(longest) {
    const out = [];
    if (!longest) return out;
    for (let strip = 1; strip <= 3 && strip < longest.length; strip++) {
        const prefix = longest.slice(0, strip);
        const suffix = longest.slice(strip);
        const val = parseFloat(suffix);
        if (!Number.isFinite(val)) continue;
        if (val < PLAUSIBLE_LOAD_WEIGHT_MIN || val > PLAUSIBLE_LOAD_WEIGHT_MAX) continue;
        out.push({ value: val, prefix, ghostLike: GHOST_PREFIX_CHARS.test(prefix) });
    }
    return out;
}

// ── The confidence cliff ────────────────────────────────────────────────────
// Added 2026-08-27. This is the deterministic fix for the ghost cell, and it
// removes the need to ask a second engine about it at all.
//
// Vision has been reporting which digits are fake all along and this file was
// throwing the information away. Measured per-symbol on the Socome corpus:
//
//   true 3475  read "883475"  confidences  0.50 0.73 | 0.97 0.98 0.99 0.98
//   true 3939  read "983939"  confidences  0.35 0.70 | 0.96 0.99 0.99 0.99
//   true 3599  read "8.3599"  confidences  0.74 0.52 | 0.96 0.95 0.98 0.98
//   true 4210  read "4210"    confidences       0.99 1.00 0.99 0.97
//   true 4223  read "4223"    confidences       0.99 0.99 0.99 0.99
//
// The permanently-lit placeholder cells score 0.35-0.74. The real digits
// score 0.95+. The boundary is not subtle.
//
// ⚠ THIS IS NOT THE CONFIDENCE GATE THAT WAS TRIED AND ABANDONED. That one
// (see the note in gemini.js) used a single pooled score for the whole read,
// and the measurement that killed it is still correct: correct reads scored
// anywhere from 0.46 to 0.95 while a known-wrong read scored 0.83, so no
// absolute cutoff can separate them. Confirmed again here — 3815's real
// digits read 0.82/0.86/0.93/0.89, below 3475's ghost cells in absolute
// terms. An absolute threshold would mangle it.
//
// What works is RELATIVE and POSITIONAL: strip a LEADING symbol only when its
// own confidence is far below the median of everything after it. A cliff at
// the start of the run, not a level. On 3815 there is no cliff (0.82 against
// a median of 0.89) so nothing is stripped; on 883475 there is a chasm (0.50
// against a median of 0.98) so the placeholder goes.
//
// This is also why it is safe for the 5-digit weighbridge, which the
// digit-count approach could never be: the leading "8" of a genuine 81460 is
// a real glyph and reads at 0.97, so there is no cliff and nothing is
// stripped. The old note records a correct 71920 read pooling at 0.56 — flat
// across its digits, no cliff, untouched by this rule.
//
// ⚠ The constants below are fitted to ten photos of ONE display. The
// mechanism generalises (a placeholder that is not a real glyph matches
// poorly); the exact numbers may not. They are deliberately conservative:
// GHOST_CONF_MAX is low enough that a merely-blurry leading digit survives,
// and CLIFF_CONF_MIN is high enough that stripping only happens when what
// remains is genuinely crisp. Revisit with more photos before loosening.
const GHOST_CONF_MAX = 0.80;   // a leading symbol this unsure may be a placeholder
const CLIFF_CONF_MIN = 0.95;   // ...but only if what follows is this certain
// Above this, a reading is trustworthy enough to publish without a second
// opinion. Below it the caller should corroborate before showing a number.
const TRUSTWORTHY_CONF = 0.90;

function medianOf(a) {
    if (!a || !a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
}

// Strips leading placeholder symbols off ONE contiguous digit run.
function stripGhostByConfidence(text, confs) {
    let t = text;
    let c = (confs || []).slice();
    let stripped = '';
    // Never strip below 3 digits: the plausible floor is 200, so a 3-digit
    // reading is legitimate and must not be eaten.
    while (t.length > 3 && c.length === t.length) {
        const rest = c.slice(1);
        if (!(c[0] < GHOST_CONF_MAX && medianOf(rest) >= CLIFF_CONF_MIN)) break;
        const v = parseFloat(t.slice(1));
        if (!Number.isFinite(v) || v < PLAUSIBLE_LOAD_WEIGHT_MIN || v > PLAUSIBLE_LOAD_WEIGHT_MAX) break;
        stripped += t[0];
        t = t.slice(1);
        c = rest;
    }
    return { text: t, confs: c, stripped };
}

// Picks the weight out of the confidence-carrying runs returned by
// detectTextWithConfidence. Returns null when nothing plausible is present.
//
// `minConf` is the weakest symbol in the digits actually being returned —
// which is the number the caller wants, and is NOT what the abandoned pooled
// gate measured. Panel text elsewhere in the crop (a model number, a capacity
// rating) cannot drag it down, because runs are scored separately.
function extractWeightFromRuns(runs) {
    if (!Array.isArray(runs) || !runs.length) return null;
    let best = null;
    for (const run of runs) {
        if (!run || !run.text) continue;
        const s = stripGhostByConfidence(run.text, run.confs);
        const v = parseFloat(s.text);
        if (!Number.isFinite(v) || v < PLAUSIBLE_LOAD_WEIGHT_MIN || v > PLAUSIBLE_LOAD_WEIGHT_MAX) continue;
        // Longest IN-RANGE run wins, matching extractWeightNumberFromCrop —
        // an implausible number must never win by being a longer string.
        if (!best || s.text.length > best.digits) {
            best = {
                weight: v,
                digits: s.text.length,
                minConf: s.confs.length ? Math.min(...s.confs) : 0,
                strippedGhost: s.stripped || null,
                rawRun: run.text,
            };
        }
    }
    if (!best) return null;
    best.trustworthy = best.minConf >= TRUSTWORTHY_CONF;
    return best;
}

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

    // REAL BUG, found 2026-08-19 while testing a 10-photo Socome corpus
    // Apsara supplied. Vision splits a seven-segment reading across a gap in
    // the display, returning "42 10" for a true 4210 and "38 15" for a true
    // 3815 — the digit-run regex below then sees "42" and "10" as two
    // separate numbers, both implausible as weights, so the whole read was
    // discarded and the photo declined. That is two clean, correct readings
    // in ten thrown away purely on formatting.
    // Space-joined digit runs are added as EXTRA candidates rather than
    // replacing anything: the individual runs are still considered, so this
    // can only ever recover a reading that was previously lost, never
    // override one that already worked. Only joins runs separated by a
    // single space, and only when the join yields 3-6 digits (a real weight)
    // — deliberately narrow so it can't glue a weight to an unrelated
    // number elsewhere in the panel text.
    const spaceJoined = [];
    const joinRe = /\b(\d{1,5})[ \t](\d{1,5})\b/g;
    let jm;
    while ((jm = joinRe.exec(rawText)) !== null) {
        const joined = jm[1] + jm[2];
        if (joined.length >= 3 && joined.length <= 6) spaceJoined.push(joined);
    }

    const matches = [...(rawText.match(/\d+(\.\d+)?/g) || []), ...spaceJoined];
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
    // candidates is attached even on a CLEAN in-range read, because a ghost
    // digit does not always push the number out of range: "83475" is a
    // perfectly plausible weight on its face, so it is returned here as a
    // confident match and the true 3475 never gets considered. Reporting the
    // alternatives lets the caller notice when the second engine read the
    // shorter one. Nothing changes unless that corroboration exists.
    if (inRange.length === 1) {
        return { weight: parseFloat(inRange[0]), viaLeadingStrip: false, candidates: ghostStripCandidates(inRange[0]) };
    }

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
        return { weight: parseFloat(longestInRange), viaLeadingStrip: false, candidates: ghostStripCandidates(longestInRange) };
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
        // When the display's digit count is known, take the RIGHTMOST that
        // many digits directly instead of stripping one at a time and
        // stopping at the first in-range result. Stripping stops too early
        // on this display (883475 -> 83475, which is in range but wrong);
        // the rightmost-N reading is the only one consistent with what the
        // hardware can actually show.
        const expDigits = expectedWeightDigits();
        if (expDigits && longest.replace(/\D/g, '').length > expDigits) {
            const digitsOnly = longest.replace(/\D/g, '');
            const tail = digitsOnly.slice(-expDigits);
            const tailVal = parseFloat(tail);
            if (Number.isFinite(tailVal) && tailVal >= PLAUSIBLE_LOAD_WEIGHT_MIN && tailVal <= PLAUSIBLE_LOAD_WEIGHT_MAX) {
                console.warn(`[VISION-OCR] Crop read "${longest}" — taking the rightmost ${expDigits} digits ("${tail}") since this display always shows ${expDigits}; the leading cells are the permanently-lit placeholder`);
                return { weight: tailVal, viaLeadingStrip: true };
            }
        }
        for (let strip = 1; strip <= 2 && strip < longest.length; strip++) {
            const suffix = longest.slice(strip);
            const val = parseFloat(suffix);
            if (Number.isFinite(val) && val >= PLAUSIBLE_LOAD_WEIGHT_MIN && val <= PLAUSIBLE_LOAD_WEIGHT_MAX) {
                console.warn(`[VISION-OCR] Crop read "${longest}" isn't a plausible weight, but stripping ${strip} leading digit(s) gives "${suffix}" — using that, flagged as lower-confidence (dead/ghost LED cell contamination has been on the left edge in every case seen so far, but is not guaranteed to be — see caveat above)`);
                return { weight: val, viaLeadingStrip: true, candidates: ghostStripCandidates(longest) };
            }
        }
    }
    console.warn(`[VISION-OCR] Crop read "${longest}" isn't a plausible weight (${PLAUSIBLE_LOAD_WEIGHT_MIN}-${PLAUSIBLE_LOAD_WEIGHT_MAX}) and no leading-digit trim fixes it — returning null rather than a very likely wrong number`);
    return null;
}

// Added 2026-08-12 after a real production miss: the pipeline returned
// 173720 as a final, primary weight — above the hard 90,000 lb business
// ceiling this file has enforced on Vision's own reads since 2026-08-10, and
// therefore a number that cannot be a real load here. Root cause: that value
// came from GEMINI (adopted because Vision had only managed a truncated
// "720" on the same crop), and Gemini's answers were being taken at face
// value, never passed through the plausibility bounds or the ghost-cell
// leading-digit strip that every Vision read goes through. The display in
// that photo actually read 73720 — Gemini had simply included the dim
// leading ghost cell as a "1", exactly the contamination pattern
// extractWeightNumberFromCrop already knows how to undo.
//
// Exported so the Gemini side can apply the SAME rules to its own numbers
// instead of each caller reinventing them. Same 1-2 digit strip cap and same
// leading-only direction as the crop parser above, for the same reason: the
// corruption on these displays is always extra leading cells, never trailing
// ones. Returns null rather than guessing when nothing in range can be
// recovered, so a caller can fall back instead of publishing a number that
// is definitionally impossible.
function plausibleWeightOrStripped(weight) {
    if (weight == null || !Number.isFinite(weight)) return null;
    if (weight >= PLAUSIBLE_LOAD_WEIGHT_MIN && weight <= PLAUSIBLE_LOAD_WEIGHT_MAX) {
        return { weight, viaLeadingStrip: false };
    }
    const asText = String(weight);
    const digitsOnly = /^\d+$/.test(asText) ? asText : (asText.match(/\d+/) || [''])[0];
    for (let strip = 1; strip <= 2 && strip < digitsOnly.length; strip++) {
        const candidate = parseFloat(digitsOnly.slice(strip));
        if (Number.isFinite(candidate) && candidate >= PLAUSIBLE_LOAD_WEIGHT_MIN && candidate <= PLAUSIBLE_LOAD_WEIGHT_MAX) {
            console.warn(`[VISION-OCR] A cross-check reading of ${weight} isn't a plausible load weight, but stripping ${strip} leading digit(s) gives ${candidate} — using that, flagged as lower-confidence`);
            return { weight: candidate, viaLeadingStrip: true };
        }
    }
    console.warn(`[VISION-OCR] A cross-check reading of ${weight} isn't a plausible load weight (${PLAUSIBLE_LOAD_WEIGHT_MIN}-${PLAUSIBLE_LOAD_WEIGHT_MAX}) and no leading-digit trim fixes it — discarding it rather than returning an impossible number`);
    return null;
}

module.exports = { detectText, detectTextWithConfidence, extractWeightNumber, extractWeightNumberFromCrop, extractPlausibleWeightFromFullImage, plausibleWeightOrStripped, extractWeightFromRuns, stripGhostByConfidence, TRUSTWORTHY_CONF };
