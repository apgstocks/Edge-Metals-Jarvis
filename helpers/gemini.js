// ── helpers/gemini.js — Gemini JSON-only wrapper ─────────────────────────────
// One job: send prompt, get back parsed JSON or null. Never free text upstream.
// Model name comes from settings.json (hot-swappable) with env fallback.

const { GoogleGenerativeAI } = require('@google/generative-ai');
const cfg = require('../config');
const fs = require('fs');
const visionOcr = require('./visionOcr');
let sharp = null;
try { sharp = require('sharp'); } catch (err) {
    // Was a silent catch with no logging — every sharp-dependent function
    // below (locateRedDisplayByPixels, shrinkForLocate, cropToDisplay,
    // normalizeOrientation, trimDeadDigitZones) degrades to an immediate
    // no-op if sharp didn't load, and NONE of them logged that fact. That
    // means a broken/missing sharp install would look EXACTLY like every
    // symptom chased across this whole conversation: pixel locate always
    // "finding nothing confident" (returns null before ever reaching its own
    // diagnostic log), crop always taking ~0-1ms regardless of the box
    // (immediate bail before touching any pixels), and the EXIF-orientation
    // fix having zero effect (same immediate bail) -- all silently, with
    // nothing distinguishing "sharp is broken" from "this photo is
    // genuinely hard." This is now a loud, unmissable boot-time error
    // instead, specifically so that possibility can be ruled in or out in
    // seconds instead of another round of photo-by-photo guessing.
    console.error('[GEMINI] *** sharp failed to load - EVERY locate/crop function below will silently no-op:', err.message, '***');
}

let genAI = null;
function getClient() {
    if (!genAI) {
        if (!cfg.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY missing');
        genAI = new GoogleGenerativeAI(cfg.GEMINI_API_KEY);
    }
    return genAI;
}

function getModelName() {
    try {
        const { loadSettings } = require('./json');
        return loadSettings().gemini_model || cfg.GEMINI_MODEL;
    } catch { return cfg.GEMINI_MODEL; }
}

// Strip ```json fences and grab the outermost JSON object
function extractJson(text) {
    if (!text) return null;
    const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = cleaned.indexOf('{');
    const end   = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

// Decide the final cutoff_date IN CODE, not by trusting the model to have
// resolved "which of several cutoffs" correctly on its own — a real Zimex
// booking confirmation still came back with the doc cutoff despite an
// explicit prompt instruction telling it not to. port_cutoff_date and
// doc_cutoff_date are extracted as separate, label-scoped fields specifically
// so this can be a plain, deterministic, testable function instead of prose
// the model may or may not follow. Exported so it can be unit-tested without
// needing a live Gemini call.
function resolveCutoffDate(fields) {
    if (!fields) return null;
    return fields.port_cutoff_date || fields.cutoff_date || null;
}

async function callGeminiJSON(prompt, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const model  = getClient().getGenerativeModel({
                model: getModelName(),
                generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
            });
            const result = await model.generateContent(prompt);
            const parsed = extractJson(result.response.text());
            if (parsed) return parsed;
            console.warn(`[GEMINI] Unparseable response (attempt ${attempt + 1})`);
        } catch (err) {
            console.error(`[GEMINI] Call failed (attempt ${attempt + 1}):`, err.message);
            // Back off on rate limits
            if (attempt < retries) await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
        }
    }
    return null;
}
async function extractBookingFieldsFromText(emailBodyText, retries = 2) {
    if (!emailBodyText || !emailBodyText.trim()) return null;
    const prompt = `You are a freight operations expert. Extract booking fields from this email body (a carrier booking confirmation or update). Return ONLY raw JSON — no markdown, no prose.

Schema (every field can be null if not present):
{
  "booking_number": null, "carrier": null, "port_of_loading": null, "port_of_discharge": null,
  "cutoff_date": null, "port_cutoff_date": null, "doc_cutoff_date": null,
  "erd_date": null, "etd": null, "eta": null, "vessel_voyage": null,
  "container_size": null, "container_number": null, "shipper": null, "consignee": null, "buyer": null
}

etd = Estimated Time of Departure, eta = Estimated Time of Arrival — these are
two DIFFERENT dates, do not confuse them or copy one into the other; leave
either null if the email doesn't actually state it.

Cutoff dates — carriers often list SEVERAL under one heading (e.g. a table
with rows like "Port Open", "Port", "Rail", "Warehouse", "Doc", "VGM"). Fill
these two SEPARATELY, by label, and do not guess:
- port_cutoff_date: the date next to a label containing "Port" (Port, Port
  Cutoff, CY Cutoff, Terminal Cutoff, Gate Cutoff) — the deadline the
  container must physically be at the terminal. If the document only has ONE
  cutoff and doesn't break it out by label at all, put that single value here.
- doc_cutoff_date: the date next to a label containing "Doc" (Doc, Document
  Cutoff, SI Cutoff, VGM Cutoff) — a paperwork deadline, usually earlier than
  port_cutoff_date. Leave null if the document doesn't separately call this out.
- cutoff_date: leave this at your best single guess too, as a fallback — but
  port_cutoff_date/doc_cutoff_date are what actually get used, so get THOSE
  right even if you're unsure about this one.

Convert all dates to MM/DD/YYYY. Port fields must be city names only. Return the JSON object and nothing else.

Email body:
"""
${emailBodyText.slice(0, 6000)}
"""`;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const model  = getClient().getGenerativeModel({
                model: getModelName(),
                generationConfig: { temperature: 0, responseMimeType: 'application/json' },
            });
            const result = await model.generateContent(prompt);
            const fields = extractJson(result.response.text());
            if (fields) {
                fields.cutoff_date = resolveCutoffDate(fields);
                return fields;
            }
            console.warn(`[GEMINI] Body extraction returned unparseable JSON (attempt ${attempt + 1})`);
        } catch (err) {
            console.error(`[GEMINI] Body extraction failed (attempt ${attempt + 1}):`, err.message);
            if (attempt < retries) await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
        }
    }
    return null;
}

// ── Multimodal: dedicated document classification (separate from extraction) ──
// A narrow, single-job call: "is this a booking confirmation, yes or no."
// Deliberately separate from extractPdfFields, where is_booking_confirmation
// is just one field among 13 others — the same failure class as the port/doc
// cutoff bug: a judgment buried inside a big compound schema doesn't get the
// model's full attention and isn't reliable enough on its own. Used as a
// SECOND, INDEPENDENT opinion before trusting extractPdfFields's own flag for
// anything as consequential as auto-creating a new booking record. Real
// report: invoices that merely mention a booking/container number were
// getting is_booking_confirmation:true from the bundled extraction call and
// silently creating phantom bookings.
async function classifyDocument(pdfBase64, retries = 2) {
    if (!pdfBase64) throw new Error('pdfBase64 required');

    const prompt = `You are a freight operations expert. Look at this PDF and classify ONLY what kind of document it is — do not extract any fields. Return ONLY raw JSON, no markdown, no prose.

{
  "is_booking_confirmation": false, // true ONLY if this document itself IS a carrier booking confirmation or shipping instruction establishing a specific shipment booking — the kind of document a carrier (Maersk, MSC, Zimex, HMM, ONE, etc.) issues to confirm a container booking, typically titled "BOOKING CONFIRMATION" or similar, showing vessel/voyage, port of loading/discharge, and cutoff dates.
  "is_invoice_or_other": false,     // true if this is an invoice, rate quote, bill, receipt, container release notice, arrival notice, demurrage/detention notice, customs document, or any other freight-adjacent document that is NOT itself a booking confirmation — even if it mentions a booking number, container number, vessel, or words like "booking"/"cutoff" somewhere in it. An invoice that references a booking number is still an invoice, not a booking confirmation.
  "document_type": null            // your best short label, e.g. "booking confirmation", "invoice", "rate quote", "arrival notice", "customs form"
}

Judge by what the document actually IS and what its title/purpose is — not by whether booking-shaped keywords or numbers appear somewhere in it. Return the JSON object and nothing else.`;

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const model = getClient().getGenerativeModel({
                model: getModelName(),
                generationConfig: { temperature: 0, responseMimeType: 'application/json' },
            });
            const result = await model.generateContent([
                { text: prompt },
                { inlineData: { mimeType: 'application/pdf', data: pdfBase64 } },
            ]);
            const parsed = extractJson(result.response.text());
            if (parsed) return parsed;
            console.warn(`[GEMINI] Classification returned unparseable JSON (attempt ${attempt + 1})`);
        } catch (err) {
            const transient = /503|429|overloaded|unavailable|high demand/i.test(err.message);
            console.error(`[GEMINI] Classification failed (attempt ${attempt + 1}${transient ? ', transient' : ''}):`, err.message);
            if (attempt < retries && transient) {
                await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
                continue;
            }
            // Classification is a safety CHECK, not the primary extraction — a
            // hard failure here shouldn't crash the whole pipeline. Caller
            // treats null as "couldn't confirm" and fails safe (skip, don't create).
            if (attempt >= retries) return null;
        }
    }
    return null;
}

// ── Multimodal: extract booking fields from a PDF ─────────────────────────────
// Sends the PDF bytes directly to Gemini. Used by the Bookings tab.
// Fields extracted match the shape used by POST /api/bookings.
// Retries on transient failures (503 overload, network hiccups) — same pattern
// as callGeminiJSON so behavior is consistent across all Gemini paths.
async function extractPdfFields(pdfBase64, retries = 2) {
    if (!pdfBase64) throw new Error('pdfBase64 required');

    const prompt = `You are a freight operations expert. Extract booking fields from this freight document (carrier confirmation, booking confirmation, or shipping instructions). Return ONLY raw JSON — no markdown, no prose.

    Schema (every field can be null if not present):
    {
      "is_booking_confirmation": false, // true ONLY if this document itself IS a carrier booking confirmation or shipping instruction establishing a specific shipment booking. false for invoices, rate quotes, container release notices, arrival notices, demurrage/detention notices, or any other freight document — even ones that mention a booking number in passing, or use words like "booking"/"cutoff" somewhere in the text. Judge by what the document actually IS, not by whether booking-shaped text appears in it.
      "booking_number": null,   // e.g. "BK-2602" or "HMMU6269419" — leave null if is_booking_confirmation is false, even if some reference number is visible
  "carrier": null,          // e.g. "MSC", "Maersk", "COSCO"
  "port_of_loading": null,  // city only, e.g. "Houston"
  "port_of_discharge": null,// city only, e.g. "Busan"
  "cutoff_date": null,      // MM/DD/YYYY — your best single guess, kept as a fallback only. port_cutoff_date/doc_cutoff_date below are what actually get used — get those right even if unsure about this one.
  "port_cutoff_date": null, // MM/DD/YYYY — the date next to a label CONTAINING "Port" (e.g. "Port", "Port Cutoff", "CY Cutoff", "Terminal Cutoff", "Gate Cutoff") — when the container must physically be at the terminal. Many carrier documents show a CUT-OFF DATE table with several rows: "Port Open", "Port", "Rail", "Warehouse", "Doc", "VGM" — use ONLY the "Port" row's value, never "Port Open", "Doc", or "VGM". If the document has just ONE cutoff with no such table, put that single value here instead.
  "doc_cutoff_date": null,  // MM/DD/YYYY — the date next to a label CONTAINING "Doc" (e.g. "Doc", "Document Cutoff", "SI Cutoff", "VGM Cutoff") — a paperwork deadline, usually earlier than port_cutoff_date. Leave null if the document doesn't separately call this out. Never copy this value into port_cutoff_date.
  "erd_date": null,         // MM/DD/YYYY format — Earliest Return Date
  "etd": null,              // MM/DD/YYYY — Estimated Time of Departure
  "eta": null,              // MM/DD/YYYY — Estimated Time of Arrival (different date than etd — don't conflate)
  "vessel_voyage": null,    // e.g. "MSC AURORA 226E"
  "container_size": null,   // format "40HC" (single) or "40HC X 3" (three containers of 40HC). Multiple containers common in metals bookings.
  "container_number": null, // e.g. "TCLU8841207". If multiple, use first only; others assigned later per-container.
  "shipper": null,
  "consignee": null,
  "buyer": null             // often same as consignee
}

Convert all dates to MM/DD/YYYY. If the document uses DD/MM/YYYY, still output MM/DD/YYYY. Port fields must be city names only, no country or code. Return the JSON object and nothing else.`;

    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const model = getClient().getGenerativeModel({
                model: getModelName(),
                generationConfig: { temperature: 0, responseMimeType: 'application/json' },
            });
            const result = await model.generateContent([
                { text: prompt },
                { inlineData: { mimeType: 'application/pdf', data: pdfBase64 } },
            ]);
            const fields = extractJson(result.response.text());
            if (fields) {
                fields.cutoff_date = resolveCutoffDate(fields);
                console.log(`[GEMINI] PDF extraction: bkg=${fields.booking_number || '?'} carrier=${fields.carrier || '?'} cutoff=${fields.cutoff_date || '?'}`);
                return fields;
            }
            console.warn(`[GEMINI] PDF extraction returned unparseable JSON (attempt ${attempt + 1})`);
        } catch (err) {
            lastErr = err;
            // 503 (overload) and 429 (rate limit) are transient — worth retrying
            const transient = /503|429|overloaded|unavailable|high demand/i.test(err.message);
            console.error(`[GEMINI] PDF extraction failed (attempt ${attempt + 1}${transient ? ', transient' : ''}):`, err.message);
            if (attempt < retries && transient) {
                await new Promise(r => setTimeout(r, 1200 * (attempt + 1)));
                continue;
            }
            if (attempt >= retries) throw err;
            // Non-transient error — don't waste retries
            if (!transient) throw err;
        }
    }
    if (lastErr) throw lastErr;
    return null;
}
// NOTE: callGeminiText() was removed here (2026-07-16 cleanup). It had been
// declared TWICE in this file — once above returning a trimmed string, once
// down here returning raw JSON text with its own separate GoogleGenerativeAI
// client and a hardcoded 'gemini-1.5-flash' fallback instead of cfg.GEMINI_MODEL
// (the second declaration silently won at runtime; the first was dead). Its
// only caller was helpers/llm-intent.js's extractManagerIntent(), which was
// itself dead code — never invoked from workflow/brain.js's actual process()
// pipeline (brain.js has its own handleManagerLLMFallback() that called it,
// but that function was never called either). Both were removed together.
// The live regex→Gemini fallback for manager/booking messages is
// workflow/brain.js: policyDecide() → aiDecide() → callGeminiJSON(), which
// already includes full chat context (session, last 5 messages, facts,
// business context). If a lighter-weight text-only Gemini call is needed
// again later, re-add it deliberately — don't restore this dead pair as-is.

// ── Multimodal: extract fields from a yard scale-ticket photo ────────────────
// Same pattern as extractPdfFields but for an image (JPEG/PNG) of a digital
// truck scale / weighbridge ticket. Deliberately its own function, not a
// branch inside extractPdfFields — different schema, different failure mode
// (a photographed screen/printed slip is far more likely to be blurry,
// glared, or at an angle than a clean PDF, so this always returns best-effort
// JSON with nulls rather than throwing on partial legibility).
async function extractScaleTicketFields(imageBase64, mimeType = 'image/jpeg', retries = 2) {
    if (!imageBase64) throw new Error('imageBase64 required');

    const prompt = `You are reading a photo of a digital truck scale (weighbridge) ticket — typically a scale readout screen or a printed slip. Extract the following fields. Return ONLY raw JSON — no markdown, no prose.

Schema (every field can be null if not legible or not present):
{
  "ticket_number": null,     // ticket/transaction ID printed on the ticket
  "gross_weight": null,      // number, in the unit shown (do not convert units)
  "tare_weight": null,       // number
  "net_weight": null,        // number — if not printed but gross and tare are both present, compute gross - tare
  "weight_unit": null,       // e.g. "lb", "kg", "ton"
  "date": null,               // MM/DD/YYYY as printed
  "time": null,               // as printed, e.g. "14:32"
  "truck_number": null,      // truck/license plate if shown
  "container_number": null,  // if shown
  "commodity": null,         // material description if shown, e.g. "scrap steel"
  "scale_location": null     // yard/facility name if shown on the ticket
}

If the image is blurry, cut off, glared, or not actually a scale ticket, still return your best-effort JSON with nulls for anything unreadable — never refuse, never return prose. Return the JSON object and nothing else.`;

    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const model = getClient().getGenerativeModel({
                model: getModelName(),
                generationConfig: { temperature: 0, responseMimeType: 'application/json' },
            });
            const result = await model.generateContent([
                { text: prompt },
                { inlineData: { mimeType: mimeType || 'image/jpeg', data: imageBase64 } },
            ]);
            const fields = extractJson(result.response.text());
            if (fields) {
                console.log(`[GEMINI] Scale ticket extraction: ticket=${fields.ticket_number || '?'} net=${fields.net_weight ?? '?'}`);
                return fields;
            }
            console.warn(`[GEMINI] Scale ticket extraction returned unparseable JSON (attempt ${attempt + 1})`);
        } catch (err) {
            lastErr = err;
            const transient = /503|429|overloaded|unavailable|high demand/i.test(err.message);
            console.error(`[GEMINI] Scale ticket extraction failed (attempt ${attempt + 1}${transient ? ', transient' : ''}):`, err.message);
            if (attempt < retries && transient) {
                await new Promise(r => setTimeout(r, 1200 * (attempt + 1)));
                continue;
            }
            if (attempt >= retries) throw err;
            if (!transient) throw err;
        }
    }
    if (lastErr) throw lastErr;
    return null;
}


// ── Multimodal: read a single weight number off a digital scale display ──────
// Used by the dashboard's Add New Load form — the gross/tare camera capture
// buttons snapshot the scale readout and POST here (via /api/vision/read-weight
// in api.js) for a fast, narrow extraction. Deliberately a separate, smaller
// prompt from extractScaleTicketFields: that one is for a full printed ticket
// with many fields; this is a live in-browser snapshot of just the number on
// the display, so the schema is minimal and the prompt is tuned for reading a
// single number off a 7-segment/LCD readout rather than a printed slip.
// Model choice for this specific digit-reading task, benchmarked live against
// the actual yard photo with a confirmed in-person ground-truth reading
// (71920 lb) after switching to the crop-zoom pipeline below:
//   gemini-3.1-flash-lite : wrong every run (37920 / 87920 / 881920 variants)
//   gemini-3.1-pro-preview: wrong (77920), and slow (~37s/request) — pro-tier
//                            reasoning didn't help on this specific dim/blurry
//                            digit pair, not worth the latency
//   gemini-3.6-flash      : correct (71920) on 4 of 5 runs at temperature 0 —
//                            clearly the best of what's available on this
//                            account, though not perfectly deterministic even
//                            at temp 0 on this hard a photo (~12-16s/request)
// Not 100% reliable — this is still a genuinely dim, angled, blurry photo —
// which is why the dashboard keeps a "check it matches the scale before
// saving" step regardless of model. Verified live via
// https://generativelanguage.googleapis.com/v1beta/models against this
// account's actual key to confirm gemini-3.6-flash is really available here
// before defaulting to it (gemini-2.5-pro showing up in that same list is why
// its earlier 404 was account/quota related, not that the model doesn't
// exist).
// FALLBACK_VISION_MODEL is the one CONFIRMED working on this account already
// (extractPdfFields/classifyDocument use it successfully) — used automatically
// if the primary 404s as unavailable, so a model getting deprecated out from
// under this account doesn't silently break weight-reading again without at
// least degrading gracefully instead of hard-failing.
function getVisionModelName() {
    return process.env.GEMINI_VISION_MODEL || 'gemini-3.6-flash';
}
const FALLBACK_VISION_MODEL = 'gemini-2.5-flash';
function isModelUnavailableError(err) {
    return /404|not found|no longer available|not supported/i.test(err.message || '');
}

// Locate only needs a coarse bounding box (4 fractions + a one-line reason)
// — a categorically easier task than the precise digit-legibility reading
// getVisionModelName() (gemini-3.6-flash) was specifically benchmarked and
// chosen for (~12-16s/request — see the comment above readWeightSinglePass).
// Running that same slow model for locate was the real reason "under 10s"
// was never achievable: locate sat fully synchronous on the critical path
// BEFORE Vision (the actual primary source of the weight number) ever got a
// crop to read. Locate uses the lighter, already-confirmed-working
// FALLBACK_VISION_MODEL instead — finding a large, visually distinct
// display region doesn't need the heaviest available model; only reading
// its exact digits does, and Cloud Vision OCR (not Gemini) does that job
// now. Overridable via env in case live testing shows this model missing
// boxes it used to find.
const LOCATE_MODEL = process.env.GEMINI_LOCATE_MODEL || FALLBACK_VISION_MODEL;

// Generic timeout wrapper so one slow leg of the pipeline can never hold the
// whole response hostage. Doesn't cancel the underlying call (the Gemini/
// Vision SDK calls here don't expose an abort signal) — it just stops US
// waiting on it past `ms`. If it resolves late, that late result is simply
// never used for this request; a warning is logged so a pattern of frequent
// timeouts is visible instead of silently eating latency budget forever.
function withTimeout(promise, ms, label) {
    let timedOut = false;
    const timeout = new Promise((resolve) => {
        setTimeout(() => { timedOut = true; resolve(null); }, ms);
    });
    return Promise.race([promise, timeout]).then((result) => {
        if (timedOut) console.warn(`[GEMINI] ${label} exceeded its ${ms}ms budget, moving on without it`);
        return result;
    });
}

// Added 2026-08-11 — classifies display type from Vision's own crop OCR
// text instead of a second Gemini call, so routing costs zero extra
// latency (see full reasoning at the call site in extractWeightFromImage).
// Deliberately keyword-based rather than fuzzy: false negatives just fall
// through to the existing, well-tested Vision-default path, so being
// conservative here is safe; false positives would wrongly route a real
// weighbridge photo to Gemini, which is the failure mode to avoid.
function looksLikeCompactIndicatorFromVisionText(visionText) {
    const t = (visionText || '').toLowerCase();
    return /\bindicat/.test(t) || /\bon\/?off\b/.test(t) || /\bfunc\b/.test(t)
        || (/\bstable\b/.test(t) && /\btare\b/.test(t));
}

// Locate-only shrink — per Apsara, the whole read was taking too long
// (>10s). The client already downscales to 1600px before upload, but that's
// sized for actually READING digits; locateDisplayBox only needs to find a
// bounding box, which doesn't need anywhere near that much resolution. This
// produces a small (~900px) copy for JUST the locate call — the box it
// returns is fractions (0-1) of image width/height, so it applies identically
// to the full-resolution original regardless of what size image found it,
// meaning digit-read accuracy is completely unaffected; only the locate
// call's upload+processing time drops. Falls back to the original image
// (same behavior as before this existed) if sharp is missing or the resize
// fails for any reason — can only make locate faster, never break it.
async function shrinkForLocate(imageBase64, mimeType) {
    if (!sharp) return imageBase64;
    try {
        const buf = Buffer.from(imageBase64, 'base64');
        const meta = await sharp(buf).metadata();
        if (!meta.width || meta.width <= 900) return imageBase64; // already small enough
        const outBuf = await sharp(buf).resize({ width: 900 }).jpeg({ quality: 80 }).toBuffer();
        return outBuf.toString('base64');
    } catch (err) {
        console.warn('[GEMINI] Locate-shrink failed, using original image for locate:', err.message);
        return imageBase64;
    }
}

// Bakes EXIF orientation into the actual pixels once, up front — see the
// detailed comment on extractWeightFromImage's call to this for the full
// root-cause story. Cheap no-op (one metadata() call, no re-encode) for the
// common case where there's no orientation tag or it's already "normal"
// (both real yard photos tested directly in this conversation came back
// this way) — only re-encodes when there's actually something to fix.
async function normalizeOrientation(imageBase64) {
    if (!sharp) return imageBase64;
    try {
        const buf = Buffer.from(imageBase64, 'base64');
        const meta = await sharp(buf).metadata();
        if (!meta.orientation || meta.orientation === 1) return imageBase64;
        const outBuf = await sharp(buf).rotate().jpeg({ quality: 95 }).toBuffer();
        console.log(`[GEMINI] Normalized EXIF orientation ${meta.orientation} (was ${meta.width}x${meta.height} stored) before locate/crop`);
        return outBuf.toString('base64');
    } catch (err) {
        console.warn('[GEMINI] EXIF orientation normalize failed, using original image as-is:', err.message);
        return imageBase64;
    }
}

// Stage 1, attempt #1 — a fast, deterministic, non-AI display locator. Every
// real yard photo seen so far (this account, this hardware) shows the
// vehicle weighbridge display as a bright, saturated RED LED/dot-matrix
// readout, while the compact bench/platform scale next to it is a backlit
// grey LCD — not red. That's a real, physical, color-based difference, not a
// guess: the exact same red threshold (r>140, r-g>60, r-b>60) is already
// proven in trimDeadDigitZones below, measured directly off a real photo of
// this display. A plain color-cluster search tells the two displays apart
// without needing to understand what either one IS, runs in tens of
// milliseconds fully locally (no network call, no model variance, no API
// cost), and is tried BEFORE ever calling the slower, occasionally-timing-out
// AI-based locateDisplayBox below. Returns null (caller falls back to the AI
// locate) if there's no confidently-sized, confidently-shaped red cluster —
// e.g. a non-red display, washed-out lighting, or a genuinely cluttered
// frame with no dominant red region.
// NOTE on method: an earlier version of this function found the bounding box
// by taking the longest lit run independently on each axis (row-sum profile,
// column-sum profile). Tested live against a real photo before shipping and
// it FAILED — the display's 4 small LB/KG/GR/NT arrow icons sit at the far
// left of the housing, and the independent per-axis projection let the box's
// x-range lock onto those tiny icons while the y-range came from the actual
// digits, producing a box that pointed at neither. Fixed by doing real
// connected-component labeling on the red-pixel mask (with a dilation pass
// first, since a dot-matrix digit's individual lit dots aren't literally
// touching pixel-to-pixel) and picking the component with the most total lit
// pixels — the digit block lights up far more pixels than the small arrow
// icons even though both are "red". Verified against the actual photo from
// this conversation: correctly boxes the full weighbridge housing and
// excludes the Fairbanks bench scale below it, in ~150-180ms.
// Refactored 2026-08-11 to take a color predicate instead of hardcoding red,
// after a real batch of 12 live photos showed a THIRD display type at this
// yard — a "Fairbanks IQ plus 710" indicator with a cyan/teal LCD readout,
// not red. Sampled real pixel data directly off two of those photos before
// writing this (not guessed): the digit cluster's actual average color came
// back RGB≈(40,165,195) — low red, high green+blue — cleanly separable from
// background noise (~0.2-0.3% of frame, same order of magnitude as the red
// display). All the core logic (dilation, connected-component labeling,
// picking the largest component) is unchanged from the original red-only
// version, which stays exactly as before via the thin wrapper below —
// only the color test and the minimum-lit-fraction threshold are now
// parameters, so the well-tested red path can't regress.
async function findDisplayBoxByColor(imageBase64, colorTest, minLitFraction, colorLabel) {
    if (!sharp) return null;
    try {
        const buf = Buffer.from(imageBase64, 'base64');
        const targetWidth = 500; // resolution is irrelevant here, only the region matters — keep this cheap
        const { data, info } = await sharp(buf)
            .resize({ width: targetWidth, withoutEnlargement: true })
            .removeAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
        const { width: w, height: h, channels } = info;
        if (!w || !h) { console.warn('[GEMINI] Pixel locate: image had no dimensions'); return null; }

        const mask = new Uint8Array(w * h);
        let totalLit = 0;
        for (let y = 0; y < h; y++) {
            const rowBase = y * w * channels;
            for (let x = 0; x < w; x++) {
                const i = rowBase + x * channels;
                const r = data[i], g = data[i + 1], b = data[i + 2];
                if (colorTest(r, g, b)) { mask[y * w + x] = 1; totalLit++; }
            }
        }
        // Always-on (not gated behind DEBUG_WEIGHT_RAW) for the same reason
        // the locate-step logging below is always-on: this is exactly the
        // kind of "why did it fall back" question that was previously
        // unanswerable from the logs. Low-volume (once per photo).
        console.log(`[GEMINI] Pixel locate (${colorLabel}): ${totalLit} lit px of ${w * h} (${(totalLit / (w * h) * 100).toFixed(2)}%), need >=${(minLitFraction * 100).toFixed(2)}%`);
        if (totalLit < w * h * minLitFraction) return null; // essentially nothing this color in frame at all

        // Dilate by R pixels so a dot-matrix digit's individually-lit dots
        // (and the gaps between adjacent digit cells) merge into one
        // connected blob instead of being scattered specks. R=25 (at this
        // 500px-wide working resolution) is wide enough to bridge inter-digit
        // gaps and the dead/ghost-cell gap, verified against a real photo,
        // while still leaving a real gap between the digit block and the
        // separate LB/KG/GR/NT arrow-icon column so they don't merge into one
        // component.
        const R = 25;
        const dilated = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                if (!mask[y * w + x]) continue;
                const yStart = Math.max(0, y - R), yEnd = Math.min(h - 1, y + R);
                const xStart = Math.max(0, x - R), xEnd = Math.min(w - 1, x + R);
                for (let ny = yStart; ny <= yEnd; ny++) {
                    const base = ny * w;
                    for (let nx = xStart; nx <= xEnd; nx++) dilated[base + nx] = 1;
                }
            }
        }

        // Connected components (4-connectivity) over the dilated mask,
        // iterative flood fill (no recursion) — picks the component with the
        // most ORIGINAL (non-dilated) lit pixels, since the real digit block
        // lights far more pixels than a small icon even after both get
        // dilated the same amount.
        const labels = new Int32Array(w * h).fill(-1);
        let nextLabel = 0;
        const comps = [];
        const stack = [];
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const idx = y * w + x;
                if (!dilated[idx] || labels[idx] !== -1) continue;
                const label = nextLabel++;
                let minX = x, maxX = x, minY = y, maxY = y, litCount = 0;
                // origMinX/etc track bounds of the ORIGINAL (undilated) lit
                // pixels only — added 2026-08-11 alongside the edge-touch
                // check below. minX/maxX/minY/maxY above are bounds of the
                // DILATED component (correct for finding the crop box — the
                // dilation is what bridges gaps between digit segments) but
                // are NOT safe to use for "does this touch the frame edge":
                // dilation (R=25 at this ~500px analysis width, 5% of frame)
                // pads the box outward on every side regardless of where the
                // real content is, so a fully-in-frame display positioned
                // anywhere near the outer 5% would show dilated bounds
                // touching 0/w or 0/h even with real margin around it.
                // Verified directly: a photo that reads correctly (81528)
                // showed dilated minX=0 while genuinely having margin.
                let origMinX = Infinity, origMaxX = -Infinity, origMinY = Infinity, origMaxY = -Infinity;
                stack.push(idx); labels[idx] = label;
                while (stack.length) {
                    const cur = stack.pop();
                    const cy = (cur / w) | 0, cx = cur % w;
                    if (mask[cur]) {
                        litCount++;
                        if (cx < origMinX) origMinX = cx; if (cx > origMaxX) origMaxX = cx;
                        if (cy < origMinY) origMinY = cy; if (cy > origMaxY) origMaxY = cy;
                    }
                    if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
                    if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
                    if (cx > 0 && dilated[cur - 1] && labels[cur - 1] === -1) { labels[cur - 1] = label; stack.push(cur - 1); }
                    if (cx < w - 1 && dilated[cur + 1] && labels[cur + 1] === -1) { labels[cur + 1] = label; stack.push(cur + 1); }
                    if (cy > 0 && dilated[cur - w] && labels[cur - w] === -1) { labels[cur - w] = label; stack.push(cur - w); }
                    if (cy < h - 1 && dilated[cur + w] && labels[cur + w] === -1) { labels[cur + w] = label; stack.push(cur + w); }
                }
                comps.push({ litCount, minX, maxX, minY, maxY, origMinX, origMaxX, origMinY, origMaxY });
            }
        }
        if (!comps.length) { console.warn(`[GEMINI] Pixel locate (${colorLabel}): pixels found but no connected component formed`); return null; }
        comps.sort((a, b) => b.litCount - a.litCount);

        // Changed 2026-08-11: this used to commit to ONLY the single
        // largest component and either use it or give up. A real false
        // positive proved that's not safe — on one photo, a blurry window
        // reflection (323px) narrowly out-scored the actual display digits
        // (298px) and was the only candidate ever tried. A saturation-based
        // filter to reject the reflection was tried and reverted (too thin
        // a margin against a different genuine case at 0.40 vs the false
        // positive's 0.34 — see git history). This is the safer fix: return
        // the top few candidates (still each passing the same sanity-bounds
        // check as before) so the caller can actually TRY reading each one
        // and use whichever produces a real result, instead of a threshold
        // pre-judging which one is "real" before ever attempting to read it.
        //
        // Bug found in the SAME live test 2026-08-11: an unrestricted top-3
        // list let genuinely tiny, unrelated red specks (a wire glint, a
        // tail-light — a few dozen pixels) qualify as "candidates" just for
        // individually passing the same absolute sanity-bounds check the
        // single dominant component used to need. On one photo this caused
        // a 232px noise blob to get tried and accepted (a wrong, if flagged,
        // answer) INSTEAD of ever falling through to cyan, where the real
        // 11026px display cluster was waiting. Fix: only include a
        // secondary component if it's within 50% of the TOP component's
        // pixel count — close enough to plausibly be a genuine alternate
        // (like the 323-vs-298 reflection/display case this was built for),
        // not noise that merely cleared an absolute floor built for judging
        // a single dominant cluster.
        const candidates = [];
        const topLitCount = comps[0].litCount;
        for (const comp of comps) {
            if (candidates.length >= 3) break;
            if (comp.litCount < topLitCount * 0.5) break; // comps is sorted descending, so nothing after this qualifies either
            const boxW = (comp.maxX - comp.minX) / w, boxH = (comp.maxY - comp.minY) / h;
            if (boxW < 0.06 || boxH < 0.02 || boxW > 0.9 || boxH > 0.6) continue;
            const padX = boxW * 0.08, padY = boxH * 0.25;
            // Added 2026-08-11, corrected same day after a measured false
            // positive: whether the ORIGINAL (undilated) lit pixels run up
            // to the photo's LEFT/RIGHT edge — using origMinX/origMaxX, not
            // the dilated minX/maxX (see the connected-component loop above
            // for why the dilated bounds can't be used here). Digits read
            // left-to-right, so a display cut off by the frame loses digits
            // specifically off the left or right edge — every real case
            // this session (736 vs 73600, "truncated on right edge of image
            // frame", "cut off by the left edge") was horizontal. TOP/BOTTOM
            // edge-touching is deliberately NOT checked: a display sitting
            // high or low in an otherwise normal photo is just composition,
            // not missing data, and checking it produced false positives
            // with no corresponding evidence of an actual truncated read.
            const edgeMargin = w * 0.015;
            const touchesEdge = comp.origMinX <= edgeMargin || comp.origMaxX >= (w - edgeMargin);
            candidates.push({
                x_min: Math.max(0, comp.minX / w - padX),
                y_min: Math.max(0, comp.minY / h - padY),
                x_max: Math.min(1, comp.maxX / w + padX),
                y_max: Math.min(1, comp.maxY / h + padY),
                reason: `${colorLabel} cluster found by pixel color analysis (no AI call)`,
                litCount: comp.litCount,
                touchesEdge,
            });
        }
        console.log(`[GEMINI] Pixel locate (${colorLabel}): ${candidates.length} candidate box(es) passed sanity bounds (${comps.map(c => c.litCount).slice(0, 5).join(', ')} px, largest first)`);
        return candidates.length ? candidates : null;
    } catch (err) {
        console.warn(`[GEMINI] Pixel-based ${colorLabel} locate failed:`, err.message);
        return null;
    }
}

// Thin wrapper preserving the exact original red-only behavior/thresholds —
// nothing about the well-tested red path changed in the refactor above.
async function locateRedDisplayByPixels(imageBase64) {
    return findDisplayBoxByColor(
        imageBase64,
        (r, g, b) => r > 140 && (r - g) > 60 && (r - b) > 60,
        0.003,
        'red',
    );
}

// Added 2026-08-11 for the "Fairbanks IQ plus 710" cyan/teal LCD indicator
// (see the long comment above findDisplayBoxByColor for how this threshold
// was derived from real sampled pixel data, not guessed). Tried as a second
// fast attempt, after red and before the slow AI locate call — AI locate
// alone was measured taking 5.6-9.9s on these specific photos, which by
// itself ate the entire 9000ms accurate-path budget and threw away an
// otherwise-correct crop+read that finished just after the deadline. This
// avoids that slow call entirely for the common case.
async function locateCyanDisplayByPixels(imageBase64) {
    return findDisplayBoxByColor(
        imageBase64,
        (r, g, b) => g > 120 && b > 120 && (g - r) > 40 && (b - r) > 30,
        0.0015,
        'cyan',
    );
}

// Stage 1, attempt #2 (fallback) — find WHERE the vehicle weighbridge display
// is in the frame using Gemini, for photos the pixel-based locate above
// couldn't confidently handle. Root cause of a real misread on a real yard
// photo (confirmed ground-truth 71920, model read first 37920 then
// 87920): the display occupied a small fraction of a large overhead photo, so
// its leading digits were only a few pixels tall by the time the model saw
// them, and a genuinely dim/blank leading cell's residual dot-matrix glow got
// hallucinated as an extra digit, while the thin "1" digit next to it got
// dropped. Both misreads still nailed the last 3 digits every time (9,2,0) —
// consistent with a resolution/legibility problem concentrated exactly on the
// smallest, dimmest part of the crop, not a random OCR failure. Cropping
// tight to the display and upscaling before the digit-read pass gives the
// model far more effective pixels on exactly the part that was failing.
async function locateDisplayBox(imageBase64, mimeType) {
    // Prompt fixed 2026-08-11 after a real batch of 12 live photos showed
    // this rejecting an entire real display type outright. The OLD version
    // told the model to ignore "a compact bench/platform indicator with
    // physical buttons... and a brand name (Fairbanks...)" as "almost
    // always a separate, smaller scale for individual items" — that rule
    // was reverse-engineered from ONE yard's small companion Fairbanks
    // FB1150 platform scale (real readings: 312/352 lb, clearly individual
    // items) and wrongly generalized. This same yard also has a SEPARATE,
    // legitimate vehicle-weight indicator — a "Fairbanks IQ plus 710" — which
    // has physical buttons, a brand name, AND displays real truck-scale
    // gross weights (confirmed live: 28500, 80720, 28180, 79080 lb, all with
    // an explicit "Gross" mode label on screen). The old prompt rejected
    // every single one of these ("not a large remote vehicle weighbridge
    // display... a compact indicator with numerous physical buttons"),
    // forcing all of them down the much less reliable whole-image fallback,
    // which then picked garbage (the "710" model number, the "100000 lb"
    // capacity rating, digits merged with a nearby "lb" into "790801").
    // Form factor (buttons vs no buttons, branded vs unbranded) is NOT a
    // reliable signal for which display is the real vehicle weight — an
    // explicit Gross/Net/Tare mode label and a truck-scale magnitude are.
    const prompt = `Find the display in this yard photo that shows the WEIGHT OF THE ENTIRE VEHICLE/TRUCK (a load's gross or tare weight), not a small bench/platform scale weighing an individual item.
- Judge by what's actually shown, not the display's physical form factor. A vehicle-weight display can be a large remote/overhead red LED repeater OR a compact indicator unit with physical buttons and a brand name (Fairbanks, Rice Lake, Avery Weigh-Tronix, Mettler Toledo, Cardinal, etc) mounted near the scale — both are legitimate vehicle-weight displays if the number shown is truck-scale.
- Strong signals this IS the vehicle display: an explicit "Gross", "Net", or "Tare" mode label on screen, or a large number (thousands to tens of thousands, e.g. 20000-90000) consistent with a loaded truck.
- Strong signals this is NOT the vehicle display (a small companion item scale instead): a small number (tens to low hundreds, e.g. under 1000) with no Gross/Net/Tare mode label, or a list of several small per-item weights together.
- If more than one display is visible, pick the one whose displayed number and/or mode label indicates a full vehicle/load weight, regardless of which one looks more "official."

Return ONLY raw JSON, no markdown:
{
  "found": false,     // true only if you can confidently locate a vehicle/load weight display
  "x_min": null,       // left edge of a bounding box around the ENTIRE display housing (not just the digits), as a fraction 0-1 of image width
  "y_min": null,       // top edge, fraction 0-1 of image height
  "x_max": null,       // right edge, fraction 0-1 of image width
  "y_max": null,       // bottom edge, fraction 0-1 of image height
  "reason": null        // one short phrase on what you found/why
}
Give the box some margin around the housing rather than cropping tight to the digits themselves. If no vehicle/load weight display is visible at all, return found:false and null for the box fields.`;

    try {
        const model = getClient().getGenerativeModel({
            model: LOCATE_MODEL,
            generationConfig: { temperature: 0, responseMimeType: 'application/json' },
        });
        const result = await model.generateContent([
            { text: prompt },
            { inlineData: { mimeType: mimeType || 'image/jpeg', data: imageBase64 } },
        ]);
        if (process.env.DEBUG_WEIGHT_RAW) console.log('[DEBUG locate raw]', result.response.text());
        const fields = extractJson(result.response.text());
        // Always-on (not gated behind DEBUG_WEIGHT_RAW) — per Apsara, every
        // real read was silently skipping the Vision OCR pipeline entirely
        // and falling back to the old whole-image Gemini single-pass read
        // (the exact unreliable behavior Vision OCR was built to replace),
        // and there was no way to tell WHY locate kept saying "not found"
        // without this. This is a warning-level, low-volume line (once per
        // photo, not per digit), worth always having visible in normal logs.
        if (!fields) { console.warn('[GEMINI] Locate step: model response was not valid JSON, falling back to whole image'); return null; }
        if (!fields.found) {
            // Added 2026-08-11 after a real batch-test image turned out to be
            // a screenshot of the dashboard's own "Add New Load" form (not a
            // yard photo at all) — locate correctly said found:false with
            // reason "not a photo of a physical yard or scale display," but
            // the caller still fell through to the whole-image Vision OCR
            // fallback, which grabbed "456" out of unrelated placeholder
            // text ("e.g. 456 Scrap Ave, Dallas, TX") and returned it as a
            // confident, unambiguous weight. Distinguish "this genuinely
            // isn't a scale photo at all" from "it's a real photo but I
            // couldn't confidently place a box" — only the latter should
            // fall through to the noisier whole-image guess; the former
            // should return no reading rather than mine irrelevant text for
            // a plausible-looking number. Deliberately conservative keyword
            // match (screenshot/app/form/UI/not a photo) — a false negative
            // here just falls through to the existing whole-image behavior
            // (no worse than today), a false positive would wrongly refuse a
            // real hard photo, which this narrow phrase set is built to avoid.
            const notAPhoto = /screenshot|not a photo|mobile app|application form|user interface|\bUI\b/i.test(fields.reason || '');
            console.warn(`[GEMINI] Locate step: model reported no display found (reason: "${fields.reason || 'none given'}"), ${notAPhoto ? 'and this does not look like a real yard photo at all — will not guess from whole-image text' : 'falling back to whole image'}`);
            return notAPhoto ? { found: false, notAPhoto: true, reason: fields.reason } : null;
        }
        // Be forgiving of the model returning fractions as strings ("0.155")
        // instead of numbers — same class of issue as the weight field itself.
        const toNum = (v) => typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' && !isNaN(v) ? parseFloat(v) : NaN);
        const x_min = toNum(fields.x_min), y_min = toNum(fields.y_min);
        const x_max = toNum(fields.x_max), y_max = toNum(fields.y_max);
        const nums = [x_min, y_min, x_max, y_max];
        if (nums.some(n => Number.isNaN(n) || n < 0 || n > 1)) {
            console.warn('[GEMINI] Locate step: model returned an out-of-range box, falling back to whole image:', JSON.stringify(fields));
            return null;
        }
        if (x_max <= x_min || y_max <= y_min) {
            console.warn('[GEMINI] Locate step: model returned an inverted/zero-size box, falling back to whole image:', JSON.stringify(fields));
            return null;
        }
        // Added after a real production log showed "Crop step took 1ms" with
        // no explanation — the model had returned a box that passed the
        // checks above (in-range, non-inverted) but was so thin it produced
        // a crop under cropToDisplay's own 20px minimum, which just returns
        // null silently. A degenerate near-zero-size box is functionally the
        // same failure as "no display found" and should be caught here, with
        // a reason logged, instead of failing several steps later with
        // nothing to explain why.
        if ((x_max - x_min) < 0.03 || (y_max - y_min) < 0.01) {
            console.warn(`[GEMINI] Locate step: model returned a degenerate near-zero-size box (${(x_max - x_min).toFixed(4)} x ${(y_max - y_min).toFixed(4)} of frame), falling back to whole image:`, JSON.stringify(fields));
            return null;
        }
        return { x_min, y_min, x_max, y_max, reason: fields.reason || null };
    } catch (err) {
        console.warn('[GEMINI] Display locate step failed, will read whole image instead:', err.message);
        return null;
    }
}

// Measured directly off a real failing photo (pixel brightness, not a guess):
// a dead/unlit LED cell showing only residual dot-matrix "ghost" glow peaked
// at a strict-bright-red column score of 40; genuine lit digit cells in the
// same photo peaked at 158 — 4x brighter. The model kept transcribing that
// ghost glow as a phantom leading digit (37920/87920/371920 instead of
// 71920) no matter how the prompt asked it to judge "is this really lit."
// Fixed at the pixel level instead of the prompt level: scan the located
// display crop column-by-column for genuine bright-red LED pixels, find
// where sustained brightness first reaches a healthy fraction of this
// image's own peak (adaptive per-photo, not a hardcoded absolute value —
// exposure varies shot to shot), and hard-crop everything before that point
// off so the model physically never sees the dead zone it kept
// hallucinating a digit from. Falls back to the untrimmed crop if the signal
// isn't clean enough to trust (never makes the crop worse than not trimming).
async function trimDeadDigitZones(sharpImg, cropW, cropH) {
    try {
        const { data } = await sharpImg
            .clone()
            .removeAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
        const channels = 3;
        const colScore = new Float64Array(cropW);
        for (let x = 0; x < cropW; x++) {
            let count = 0;
            for (let y = 0; y < cropH; y++) {
                const i = (y * cropW + x) * channels;
                const r = data[i], g = data[i + 1], b = data[i + 2];
                if (r > 140 && (r - g) > 60 && (r - b) > 60) count++;
            }
            colScore[x] = count;
        }
        const peak = Math.max(...colScore);
        if (peak < 5) return null; // too dim overall to trust this analysis at all

        const threshold = peak * 0.35;
        const win = Math.max(15, Math.round(cropW * 0.03));
        const prefix = new Float64Array(cropW + 1);
        for (let x = 0; x < cropW; x++) prefix[x + 1] = prefix[x] + colScore[x];
        const rollAvg = (start) => (prefix[Math.min(cropW, start + win)] - prefix[start]) / win;

        // Find every contiguous above-threshold run, merging runs that are
        // close together (small gaps are just the dark space between
        // adjacent digit cells — still one "number").
        const runs = [];
        let inRun = false, runStart = 0;
        for (let x = 0; x <= cropW - win; x++) {
            const above = rollAvg(x) >= threshold;
            if (above && !inRun) { inRun = true; runStart = x; }
            if (!above && inRun) { inRun = false; runs.push([runStart, x + win]); }
        }
        if (inRun) runs.push([runStart, cropW]);
        if (runs.length === 0) return null;

        const mergeGap = win * 3;
        const merged = [runs[0].slice()];
        for (let i = 1; i < runs.length; i++) {
            const last = merged[merged.length - 1];
            if (runs[i][0] - last[1] <= mergeGap) last[1] = runs[i][1];
            else merged.push(runs[i].slice());
        }

        // UNION every merged run that's genuinely bright (not just the single
        // widest one). Ghost/residual-glow cells measured on a real photo
        // peaked at ~25% of that photo's brightest column (40 vs 158 — see
        // the comment above this function) — clearly separable from a real
        // lit digit, so a 50% floor safely excludes ghosts while keeping
        // every real digit group. This replaced a "keep only the longest
        // merged run" rule after it silently discarded an entire second
        // digit group on a real 2026-08-10 test photo: a fully bright "8"
        // (peak 312, 100% of that crop's max) sat far enough from the rest of
        // the number that it fell outside the merge distance, and picking
        // "longest" alone threw it away, cropping to a wrong-but-confident
        // number instead of the real one. Union broadly is safe on the
        // non-digit-label front (LB/KG/GR/NT can't pollute a digit-only
        // regex match) but NOT fully safe against a ghost cell that's
        // bright enough to survive this 50% floor — confirmed on a
        // different real photo the same day: extractWeightNumberFromCrop in
        // helpers/visionOcr.js is the actual guard against that now (plain
        // "longest digit run" alone isn't trustworthy on the crop path,
        // exactly like it never was on the whole image).
        const brightEnough = merged.filter((run) => {
            let peakInRun = 0;
            for (let x = run[0]; x < run[1]; x++) if (colScore[x] > peakInRun) peakInRun = colScore[x];
            return peakInRun >= peak * 0.5;
        });
        if (brightEnough.length === 0) return null;
        const runStart2 = Math.min(...brightEnough.map((r) => r[0]));
        const runEnd2 = Math.max(...brightEnough.map((r) => r[1]));

        // Generous margin back toward the edges so we don't shave a real
        // digit's edge off. The rolling window only crosses threshold once a
        // stroke's CORE is under it, so the run boundary sits inside the true
        // digit shape, not at its actual edge — a small margin wasn't enough
        // and a live test came back with the model reporting "leftmost digit
        // is cut off by the left image border." A full window's worth of
        // margin (not half) fixes that without reintroducing the ghost cell,
        // which sits much further away than one window width.
        const margin = win;
        const trimLeft = Math.max(0, runStart2 - margin);
        const trimRight = Math.min(cropW, runEnd2 + margin);
        if ((trimRight - trimLeft) < cropW * 0.25) return null;
        if (trimLeft === 0 && trimRight === cropW) return null; // nothing to trim

        return { left: trimLeft, width: trimRight - trimLeft };
    } catch (err) {
        console.warn('[GEMINI] Dead-zone trim analysis failed, skipping:', err.message);
        return null;
    }
}

// Stage 1.5 — crop to the located box (with padding), trim any dead/ghost
// LED zone off the left or right edge, and upscale, so stage 2 gets a
// zoomed-in, higher-effective-resolution view of ONLY the genuinely lit
// digits instead of it being a small part of a big yard photo plus a dim
// ghost cell it kept misreading. Degrades to null (caller falls back to
// reading the original image) if sharp isn't installed or the crop fails for
// any reason — never blocks a reading.
// opts.boost added 2026-08-11 — see the long comment at its call site in
// extractWeightFromImage for the real-photo evidence behind this. Applies a
// linear contrast stretch + sharpen AFTER the exact same crop/pad/trim
// geometry as the normal path, so it's strictly an additional rescue
// attempt on the identical pixels, never a different crop region — verified
// live against a real hard photo (47.jpeg) where Vision found NOTHING on
// the plain crop but returned a legible (if not perfect) reading on the
// boosted one, three separate contrast strengths tested directly against
// the raw Vision API before this was wired in.
async function cropToDisplay(imageBase64, mimeType, box, opts = {}) {
    if (!sharp || !box) return null;
    try {
        const buf = Buffer.from(imageBase64, 'base64');
        const img = sharp(buf);
        const meta = await img.metadata();
        const w = meta.width, h = meta.height;
        if (!w || !h) return null;

        // Padding around the model's box on each side, clamped to image bounds —
        // the box is around the housing already; a bit more margin protects
        // against a slightly-too-tight box cutting off a digit. Widened
        // specifically for AI-locate boxes 2026-08-11: reproduced live on a
        // real photo where the AI locate path (non-deterministic — a repeat
        // run on the identical photo produced a DIFFERENT, tighter box than
        // the first attempt) cropped off the leading "28" of "28460",
        // leaving just "460" — still numerically plausible on its own, so it
        // slipped through the range check as a confident, wrong, unflagged
        // answer. Pixel-locate boxes (red/cyan) already get their own
        // internal 8%/25% pad before reaching here and have shown no
        // truncation issue, so only the less-precise AI-locate path (no
        // "pixel color analysis" in its reason string) gets the wider margin.
        const isAiLocate = !(box.reason || '').includes('pixel color analysis');
        const padFrac = isAiLocate ? 0.22 : 0.12;
        const padX = (box.x_max - box.x_min) * padFrac;
        const padY = (box.y_max - box.y_min) * padFrac;
        let left = Math.max(0, Math.round((box.x_min - padX) * w));
        let top = Math.max(0, Math.round((box.y_min - padY) * h));
        let right = Math.min(w, Math.round((box.x_max + padX) * w));
        let bottom = Math.min(h, Math.round((box.y_max + padY) * h));
        let cropW = right - left, cropH = bottom - top;
        // Was a silent `return null` — a real production log showed "Crop
        // step took 1ms" with zero explanation for why the accurate path
        // failed. Now it says exactly what box produced the too-small crop,
        // so a degenerate box (from either locate method) is traceable
        // instead of just vanishing into "not ready in time."
        if (cropW < 20 || cropH < 20) {
            console.warn(`[GEMINI] Crop-to-display: box produced a too-small crop (${cropW}x${cropH}px) from box ${JSON.stringify(box)} on a ${w}x${h} image, skipping`);
            return null;
        }

        let finalExtract = { left, top, width: cropW, height: cropH };
        // opts.skipTrim added 2026-08-11 — see the long comment at its call
        // site in extractWeightFromImage for the real-photo evidence. Root
        // cause found by directly comparing the trimmed vs. untrimmed crop
        // bytes on a real hard photo (47.jpeg): the UNTRIMMED crop (2619px)
        // read fine on Vision ("81960"); the SAME crop after
        // trimDeadDigitZones cut it to 1585px and Vision then found ZERO
        // text on it, repeatably, at multiple resolutions/contrast levels.
        // trimDeadDigitZones is real and necessary for the bug it was built
        // for (a dim ghost cell hallucinated as a phantom leading digit —
        // see that function's own comments), so it stays on by default; this
        // is only an opt-out for the specific rescue path that already knows
        // the default crop failed Vision entirely.
        if (!opts.skipTrim) {
            const boxCrop = img.clone().extract({ left, top, width: cropW, height: cropH });
            const trim = await trimDeadDigitZones(boxCrop, cropW, cropH);
            if (trim) {
                finalExtract = { left: left + trim.left, top, width: trim.width, height: cropH };
                console.log(`[GEMINI] Trimmed dead/ghost LED zone off crop edge (${cropW}px -> ${trim.width}px wide)`);
            }
        }

        // Upscale so the crop has real detail to work with — target a
        // ~2000px-wide result (raised from 1400px per Apsara: "send it in
        // high resolution to OCR"), capped at 4x to avoid manufacturing fake
        // detail out of a tiny crop (that cap is unchanged — this only gives
        // MEDIUM-sized crops, roughly 500-2000px wide, more effective
        // resolution than before; a crop already bigger than 2000px, or one
        // small enough to already hit the 4x cap, is unaffected). Quality
        // raised 92 -> 97 too: this crop is what Vision actually reads the
        // digits off of, so minimizing JPEG compression artifacts on the
        // sharp red-LED digit edges matters more here than file size.
        const scale = Math.min(4, Math.max(1, 2000 / finalExtract.width));
        let pipeline = img
            .extract(finalExtract)
            .resize({ width: Math.round(finalExtract.width * scale), kernel: 'lanczos3' });
        if (opts.boost) {
            // Values verified live (2026-08-11) against the raw Vision API on
            // a real crop that otherwise returned zero text: linear(1.6,-40)
            // + a light sharpen pulled Vision from "no text detected" to a
            // legible (if imperfect) digit string. Kept moderate rather than
            // the even-stronger (2.0,-60) variant also tested — that one
            // pushed the dim ghost/leading-zero cell bright enough to read as
            // a spurious extra "8", trading one error for another.
            pipeline = pipeline.linear(1.6, -40).sharpen({ sigma: 1.2 });
        }
        const outBuf = await pipeline.jpeg({ quality: 97 }).toBuffer();
        if (process.env.DEBUG_SAVE_CROP) fs.writeFileSync(process.env.DEBUG_SAVE_CROP, outBuf);
        return outBuf.toString('base64');
    } catch (err) {
        console.warn('[GEMINI] Crop-to-display step failed, will read whole image instead:', err.message);
        return null;
    }
}

async function readWeightSinglePass(imageBase64, mimeType = 'image/jpeg', retries = 2, opts = {}) {
    if (!imageBase64) throw new Error('imageBase64 required');
    const isCrop = !!opts.isCrop;

    const cropPreamble = isCrop ? `This image has ALREADY been cropped and zoomed tightly to a single vehicle weighbridge display — you don't need to search for it or compare it against another display, just read it. Because it's zoomed in, expect the digit cells to fill most of the frame.

7-vs-8/9 disambiguation on a zoomed dot-matrix cell: a "7" is an OPEN shape — a top bar plus one diagonal stroke down to the bottom, with genuinely empty (dark) space on the left side of the cell below the top bar. An "8" or "9" is CLOSED or partly closed — there's a second lit stroke on the left side too (forming a loop or partial loop), not just empty dark space. Before calling a digit "8", specifically check whether the lower-left of that cell is truly dark/empty (→ it's a "7") or has its own lit stroke (→ it's an 8/9).

` : '';

    const prompt = `${cropPreamble}You are an expert at reading digital scale (weighbridge) displays from photos — 7-segment LED, LCD, or similar digital readouts. Read the weight value shown as carefully as you would proofread a number you're about to bet money on.

IMPORTANT — this reading is for a LOAD: the weight of an entire vehicle/truck at a weighbridge, not a small item. Yard photos routinely show MORE THAN ONE digital display in frame, serving DIFFERENT purposes, and picking the wrong one is a real, common mistake:
- The VEHICLE WEIGHBRIDGE DISPLAY is what you want for a load reading: often a large remote/overhead signage-style display (commonly red LED digits, mounted high so a truck driver can read it from the cab, sometimes with unit indicator lights like LB/KG/GR/NT down one side, typically no physical buttons on it since it's just a repeater screen). For a whole-vehicle load, THIS is normally the correct number, even though it can be dimmer, angled, or harder to read than a closer compact box — don't downgrade it just because it's harder to read; read it carefully instead.
- A COMPACT BENCH/PLATFORM SCALE INDICATOR — a small desk/wall-mounted box with physical buttons (ZERO, TARE, GROSS/NET, PRINT, UNITS) and a brand name on the bezel (e.g. Fairbanks, Rice Lake, Avery Weigh-Tronix, Mettler Toledo, Cardinal) — is very often a DIFFERENT, smaller scale used for individual items (pallets, samples, small parts), not the vehicle itself. Look for context clues confirming this: a nearby posted list/sign of individual item weights (e.g. "Pallet Weight," a handwritten list of two/three-digit numbers), a small platform under the indicator rather than a vehicle-sized weighing area, or a reading far too small to plausibly be a loaded truck (a scrap-metal truck load is realistically in the thousands to tens of thousands of lb/kg, not double or triple digits).
- If you see BOTH a large remote/overhead vehicle-style display AND a small bench indicator, and they show DIFFERENT numbers, read the large vehicle display for the load weight — the small indicator is almost always for something else entirely, not a more-trustworthy repeat of the same number.
- If only one display is visible, read that one.

Once you've identified the correct display to read:
1. First, count the fixed digit CELLS (character positions) in the display housing, left to right, before reading any values — most weighbridge displays have a fixed number of cells (commonly 5 or 6) even when leading cells show no number. Then assign exactly one character (a digit, or blank) to each cell. Do not merge two adjacent cells into one digit, and do not drop a cell just because its digit looks visually simple (a lone vertical stroke, i.e. "1", is a full digit occupying its own cell — never absorb it into the neighboring digit).
2. Many of these displays are DOT-MATRIX LED (a grid of individual round LEDs per cell), not classic 7-segment bars. On a dot-matrix display, camera sensors very commonly pick up a faint residual glow from the UNLIT dots in a cell (the whole dot grid looks dimly visible even when that cell is truly off) — this is a common false-positive artifact, not a real digit. Leading cells on a weighbridge display are frequently blank (suppressed leading zeros/unused cells), showing only this faint all-dots glow. Do NOT read a dim, low-contrast, evenly-fuzzy glow as a digit shape (people mistake this ambient glow for an "8" or "3" since all dots being faintly on resembles a dense digit) — only assign a digit to a cell when its lit dots are CLEARLY, distinctly brighter than the ambient off-dot glow elsewhere in the same display and form an unambiguous number shape. If a leading cell is genuinely just dim ambient glow with no distinct bright numeral, treat that cell as blank, not as a digit.
3. For 7-segment displays specifically, watch for confusion between: 8 and 0, 5 and 6, 1 and 7, 3 and 9 — look at which segments are actually lit before deciding, don't guess from overall shape alone.
4. After your first pass, re-count: does the number of digits you read match the number of cells you counted in step 1 (minus any blank leading cells)? If you counted 6 cells and only produced 4 digits, you likely merged or dropped one — go back and check each cell individually, especially thin digits like "1" next to a wider neighbor like "7".
5. Note the decimal point position exactly as shown, and any thousands separator.
6. Note the unit label if printed near the number (lb, kg, kgs, ton, tonnes, etc.) — units are often small text or indicator lights near a corner of the display.
7. If glare, blur, a bad angle, or partial occlusion makes any digit genuinely ambiguous, do not guess — return null for the whole weight rather than a half-confident wrong number. A missing reading that gets manually entered is far cheaper than a wrong one that goes uncaught.

Return ONLY raw JSON — no markdown, no prose:
{
  "weight": null,        // number only, decimal point preserved, no thousands separators, e.g. 42350 or 42350.5 — null if not confidently legible
  "weight_unit": null,   // e.g. "lb", "kg", "ton" — null if no unit is visible
  "displays_seen": null, // brief note on what display(s) you found and which you chose, e.g. "large overhead weighbridge display (read) + compact Fairbanks bench indicator, ignored — nearby sign lists individual pallet weights" — helps confirm you scanned for multiple displays and picked correctly
  "raw_text": null       // exactly what you read off the display you chose, as plain text before parsing, e.g. "0 lb (Fairbanks indicator)" — helps a human verify against the photo later. Still fill this in even if weight ends up null, describing what you saw and why it wasn't confident.
}

Never refuse, never return prose outside the JSON.`;

    let lastErr = null;
    let modelName = getVisionModelName();
    let fellBack = false;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const model = getClient().getGenerativeModel({
                model: modelName,
                generationConfig: { temperature: 0, responseMimeType: 'application/json' },
            });
            const result = await model.generateContent([
                { text: prompt },
                { inlineData: { mimeType: mimeType || 'image/jpeg', data: imageBase64 } },
            ]);
            if (process.env.DEBUG_WEIGHT_RAW) console.log('[DEBUG RAW]', result.response.text());
            const fields = extractJson(result.response.text());
            if (fields) {
                // Be forgiving of a model that ignores the "no thousands separator"
                // instruction — strip commas/spaces before treating it as a number.
                if (typeof fields.weight === 'string') {
                    const cleaned = fields.weight.replace(/[,\s]/g, '');
                    fields.weight = cleaned && !isNaN(cleaned) ? parseFloat(cleaned) : null;
                }
                console.log(`[GEMINI] Weight read (${modelName}): ${fields.weight ?? 'null'} ${fields.weight_unit || ''} (raw: "${fields.raw_text || ''}")`);
                return fields;
            }
            console.warn(`[GEMINI] Weight read returned unparseable JSON (attempt ${attempt + 1}, model ${modelName})`);
        } catch (err) {
            lastErr = err;
            // Model itself unavailable (deprecated/restricted on this account) —
            // switch to the confirmed-working fallback and retry immediately,
            // don't burn a transient-style backoff delay on a non-transient cause.
            if (isModelUnavailableError(err) && !fellBack && modelName !== FALLBACK_VISION_MODEL) {
                console.warn(`[GEMINI] ${modelName} unavailable on this account, falling back to ${FALLBACK_VISION_MODEL}:`, err.message);
                modelName = FALLBACK_VISION_MODEL;
                fellBack = true;
                continue;
            }
            const transient = /503|429|overloaded|unavailable|high demand/i.test(err.message);
            console.error(`[GEMINI] Weight read failed (attempt ${attempt + 1}, model ${modelName}${transient ? ', transient' : ''}):`, err.message);
            if (attempt < retries && transient) { await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); continue; }
            if (attempt >= retries) throw err;
            if (!transient) throw err;
        }
    }
    if (lastErr) throw lastErr;
    return { weight: null, weight_unit: null, raw_text: null };
}

// NOTE: no longer called from extractWeightFromImage's main chain (removed
// when the fallback order was simplified for speed — see the comment above
// extractWeightFromImage). Left in place, unexported, in case a slow-but-
// thorough vote fallback is wanted again later; currently dead code.
// Self-consistency vote: on a genuinely hard photo (dim, angled, blurry),
// even a clean, correctly-cropped image with nothing but the right digits in
// frame still gets misread by the model on some fraction of calls — verified
// live on a real photo: the SAME clean crop came back correct on some calls
// and wrong on others, not because the crop was bad (confirmed by eye each
// time) but because the model's digit-level precision on this exact font/blur
// isn't perfectly reliable call to call, even at temperature 0. Reading it 3x
// and taking whatever at least 2 of 3 agree on is a standard fix for that
// kind of independent, non-repeating error — it doesn't help at all with a
// systematic mistake (which is why the dead-zone trim above still had to be
// a real fix, not just more voting), but it directly helps with a call that
// randomly flips a single digit sometimes and not other times.
function voteOnWeightReadings(results) {
    const valid = results.filter(r => r && r.weight != null);
    if (valid.length === 0) return results.find(r => r) || null;
    const counts = new Map();
    for (const r of valid) {
        const key = String(r.weight);
        if (!counts.has(key)) counts.set(key, []);
        counts.get(key).push(r);
    }
    let best = null;
    for (const group of counts.values()) {
        if (!best || group.length > best.length) best = group;
    }
    const winner = { ...best[0] };
    if (best.length < valid.length) {
        // No unanimous agreement — say so in the fields a human actually reads,
        // since this is exactly when the "check it matches the scale before
        // saving" UI warning matters most.
        const otherReadings = valid.filter(r => !best.includes(r)).map(r => r.weight);
        winner.raw_text = `${winner.raw_text || ''} [${best.length}/${valid.length} reads agreed on ${winner.weight}; other reads got: ${otherReadings.join(', ')} — double-check this one]`.trim();
    }
    return winner;
}

// Public entry point. Cloud Vision OCR is the PRIMARY, most trustworthy
// source of the actual digits (a purpose-built character-recognition model —
// deterministic, verified live to read the exact same image correctly on
// every call, unlike Gemini which flipped between right and wrong on repeat
// calls against an identical image) — this is business-critical (a wrong
// weight is a wrong invoice).
//
// PRIORITY, per Apsara explicitly: "i cant afford to have mistakes" outranks
// the earlier "under 5 seconds" ask when the two conflict. Live evidence from
// a real yard photo on 2026-08-10 showed why that ordering matters: the
// cropped/accurate path missed its (then 4000ms) budget, so this fell back to
// reading the WHOLE, uncropped photo — which in that shot also contained a
// second display (a bench scale reading "403 lb") plus other numbers on a
// clipboard in frame. The whole-image path correctly flagged that result
// `ambiguous: true` instead of trusting it silently, which is exactly the
// point of that guard — but a flagged, likely-wrong number is still worse
// than just taking the extra second or two to get the accurate, isolated
// crop read in the first place. ACCURATE_PATH_BUDGET_MS below has been
// widened accordingly, and per-stage timing (locate/crop/vision-on-crop) is
// now logged so a future timing decision is made from real numbers, not
// another guess.
//   1. locateDisplayBox uses the lighter LOCATE_MODEL (see above) instead of
//      the heavyweight digit-reading model — finding a box is a coarser task
//      than reading exact digits.
//   2. The whole locate->crop->Vision-on-crop "accurate path" runs under an
//      ACCURATE_PATH_BUDGET_MS timeout, racing the whole-image Vision OCR
//      call kicked off immediately at the top. The accurate path is strongly
//      preferred (see priority note above) and gets a generous budget; the
//      whole-image reading is the fallback of last resort for when the
//      accurate path genuinely can't produce anything, not a routine
//      speed shortcut.
// The old "Gemini self-consistency vote on the crop" fallback (3 more slow
// Gemini calls) has been dropped from the middle of the chain — it only
// fired when Vision itself had nothing to read on the crop, which is rare,
// and it could add another 12-16s+ on top of everything else. The
// whole-image Gemini single-pass read remains as the final, rare last resort
// if BOTH Vision attempts come back empty.
// Added 2026-08-11. Root-cause analysis this session found that the single
// biggest driver of a wrong weight reading was never the OCR/candidate logic
// downstream — it was bad input: a display partially outside the photo
// frame, or dim/off-angle digits that a color-threshold locate step can't
// see. Every backend retry, cross-check, and race-condition fix this session
// improved the odds AFTER a bad photo was already submitted; none of them
// can recover digits that were never in the shot. The brief was explicit:
// this needs to run with no human checking the number afterward, so the
// only honest way to raise reliability further is to stop bad photos from
// ever entering the pipeline — reject them at the point of capture and have
// the app ask for a retake automatically, the same way a barcode scanner
// or a check-deposit camera refuses a bad frame instead of guessing at it.
// This does NOT ask a human to read or confirm the weight — it's a binary
// "is a full, in-frame display visible" gate, checked automatically.
//
// Deliberately pixel-only (no Gemini call): this needs to return in well
// under a second so a driver retaking a bad photo doesn't feel like the app
// hung. The full accurate path's AI-locate fallback is skipped here on
// purpose — a slightly higher false-retake rate is the right trade against
// a client-side check that takes 5-10s per attempt.
async function checkPhotoQuality(imageBase64, mimeType = 'image/jpeg') {
    if (!sharp) return { ok: true, reason: 'sharp_unavailable' }; // fail open, never block capture over a missing dependency
    try {
        const normalized = await normalizeOrientation(imageBase64);
        let candidates = await locateRedDisplayByPixels(normalized);
        let colorLabel = 'red';
        if (!candidates || !candidates.length) {
            candidates = await locateCyanDisplayByPixels(normalized);
            colorLabel = 'cyan';
        }
        // Deliberately NOT a hard reject. Measured directly: a real photo
        // that the fast pixel-only check finds nothing on can still be read
        // correctly by the full backend pipeline via its Gemini AI-locate
        // fallback (confirmed on the exact 28460 case this check was built
        // against). "Not found" here just means the fast color-threshold
        // heuristic came up empty at low analysis resolution — that is
        // weaker, noisier evidence than edge_cutoff below, which is a
        // specific positive signal. Rejecting on it would force retakes on
        // photos that were already fine, for no measured accuracy gain.
        if (!candidates || !candidates.length) {
            return {
                ok: true,
                reason: 'not_found_but_allowed',
                message: 'No confident display detected by the fast check — the fuller server-side pass may still recover a reading.',
            };
        }
        // Check EVERY returned candidate, not just the largest. The locate
        // step already returns up to 3 (see findDisplayBoxByColor) precisely
        // because the single biggest lit-pixel cluster is sometimes a false
        // positive (a reflection, a glint) that outscores the real display —
        // documented and fixed once already for the main read path. The same
        // trap applies here: if candidate 1 is a bright edge-touching blob
        // but candidate 2 is the real, fully-in-frame display, this gate
        // must not reject a genuinely good photo over the wrong candidate.
        //
        // Added same day, after a real false positive: a candidate can also
        // be a MERGED blob rather than a genuinely edge-touching one — the
        // dilation pass (R=25, meant to bridge gaps between digit segments)
        // can bridge two SEPARATE red objects into one connected component
        // if they're close enough at the ~500px analysis resolution (e.g.
        // the display plus an unrelated red LED elsewhere in the photo,
        // such as a security camera's indicator). That merge drags the
        // component's bounds far past the real display's actual extent,
        // making a fully-in-frame photo look edge-touching. Verified
        // directly on the false positive: every legitimate single-display
        // candidate measured this session has boxH under ~0.32 of frame
        // height; the merged blob measured 0.594 — nearly double. A
        // suspiciously tall box is treated as corrupted evidence, not
        // trusted either way, same as "not found": it's excluded from the
        // edge-touch search entirely rather than allowed to fail the photo.
        const PLAUSIBLE_MAX_BOX_HEIGHT = 0.35;
        const trustworthy = candidates.filter(c => (c.y_max - c.y_min) <= PLAUSIBLE_MAX_BOX_HEIGHT);
        if (candidates.length && !trustworthy.length) {
            console.log(`[GEMINI] Photo quality check (${colorLabel}): only implausibly tall candidate(s) found (likely two red objects merged by dilation) — treating as inconclusive, not a failure`);
            return {
                ok: true,
                reason: 'not_found_but_allowed',
                message: 'No confident display detected by the fast check — the fuller server-side pass may still recover a reading.',
            };
        }
        const clean = trustworthy.find(c => !c.touchesEdge);
        if (!clean) {
            return {
                ok: false,
                reason: 'edge_cutoff',
                message: 'Part of the display looks cut off at the edge of the photo. Back up or reposition so the whole number is visible, then retake.',
            };
        }
        console.log(`[GEMINI] Photo quality check (${colorLabel}): OK, ${candidates.indexOf(clean) === 0 ? 'largest' : `candidate ${candidates.indexOf(clean) + 1}`} candidate does not touch frame edge`);
        return { ok: true, reason: 'confident_box' };
    } catch (err) {
        console.warn('[GEMINI] Photo quality check failed, letting it through:', err.message);
        return { ok: true, reason: 'check_failed' }; // fail open — never let a bug in this gate block a real capture
    }
}

async function extractWeightFromImage(imageBase64, mimeType = 'image/jpeg', retries = 2) {
    if (!imageBase64) throw new Error('imageBase64 required');
    // Normalize EXIF orientation ONCE, up front, before anything else touches
    // this image. Root cause found 2026-08-11: phone cameras commonly store a
    // photo in raw sensor orientation plus an EXIF tag saying how to rotate
    // it for correct viewing — Google's Vision/Gemini APIs handle that tag
    // correctly, but sharp (used by every locate/crop function below) does
    // NOT auto-apply it unless told to, which is why the whole-image Vision
    // fallback kept producing a reading while the sharp-based locate step
    // kept failing on the exact same photo: it was analyzing a sideways
    // image. Fixed once here instead of patching every function
    // individually — sharp's own .metadata() keeps reporting PRE-rotation
    // width/height even after .rotate() is chained (verified directly, not
    // assumed), so patching each function risked a width/height mismatch
    // between a box's coordinates and what actually gets extracted. One
    // normalize pass here means every downstream .metadata() call is simply
    // correct, no special-casing needed anywhere else.
    imageBase64 = await normalizeOrientation(imageBase64);
    mimeType = 'image/jpeg'; // normalizeOrientation always re-encodes as JPEG
    const t0 = Date.now();
    const elapsed = () => `${Date.now() - t0}ms`;

    // Added 2026-08-11 to end a genuinely expensive class of confusion: the
    // client (dashboard AND the separately-bundled mobile APK) decides what
    // resolution to send, and NOTHING in these logs ever showed what
    // actually arrived. That cost hours — a client-side resolution fix was
    // shipped, deployed, and re-tested three times while it was impossible
    // to tell from the logs whether the photo being read was the new
    // full-resolution one or the old 1600px-capped one, because every other
    // number in the log (locate is done on a shrunk copy; crop widths are
    // easy to misread) looks similar either way. One line, printed before
    // anything else runs, makes "is the client fix actually live on this
    // device" a fact instead of an argument. Failures here are swallowed —
    // this is diagnostics, it must never break a real read.
    try {
        if (sharp) {
            const inMeta = await sharp(Buffer.from(imageBase64, 'base64')).metadata();
            const kb = Math.round((imageBase64.length * 3) / 4 / 1024);
            console.log(`[GEMINI] Received image: ${inMeta.width}x${inMeta.height}px, ~${kb}KB base64 — if width is ~1600 the client is still applying the OLD downscale cap (expect full sensor resolution, typically 3000-4000px, from an up-to-date client)`);
        }
    } catch (err) {
        console.warn('[GEMINI] Could not read incoming image dimensions:', err.message);
    }

    // Started now, awaited later — a single Vision OCR call on the whole
    // photo, no Gemini locate step first. Kept as the last-resort fallback
    // for when the accurate path genuinely fails (box never found, crop
    // fails, or Vision finds nothing on the crop) — NOT a routine speed
    // shortcut; see the priority note above.
    const wholeImageVisionPromise = visionOcr.detectText(imageBase64).catch((err) => {
        console.warn('[GEMINI] Whole-image Vision OCR failed:', err.message);
        return null;
    });

    // The more ACCURATE path — isolate the display, upscale it, then read it
    // with Vision — wrapped as one promise so it can be raced against a hard
    // time budget below instead of being awaited step-by-step with no limit.
    // Per-stage timestamps are logged so a slow real-world run tells us
    // exactly which stage to fix instead of just "it was slow somewhere."
    const accuratePathPromise = (async () => {
        const tLocateStart = Date.now();
        // Try the fast, deterministic, no-network pixel locates first — red
        // (the overhead weighbridge repeater), then cyan (the "IQ plus 710"
        // indicator, added 2026-08-11). Only fall to the slow AI-based
        // locateDisplayBox (network call, measured 5.6-9.9s on real IQ710
        // photos — enough by itself to blow the whole accurate-path budget)
        // if NEITHER pixel approach can confidently place a box.
        let candidates = await locateRedDisplayByPixels(imageBase64);
        let locateSource = 'red pixel color analysis';
        if (!candidates || !candidates.length) {
            candidates = await locateCyanDisplayByPixels(imageBase64);
            locateSource = 'cyan pixel color analysis';
        }
        if (!candidates || !candidates.length) {
            const locateImg = await shrinkForLocate(imageBase64, mimeType);
            const aiBox = await locateDisplayBox(locateImg, mimeType);
            // aiBox can now be a { notAPhoto: true } sentinel (see
            // locateDisplayBox) instead of a real box or null — a real box
            // always has x_min etc, so check specifically rather than just
            // truthiness, which would otherwise treat the sentinel as a
            // (broken) candidate.
            if (aiBox && aiBox.notAPhoto) {
                console.log(`[GEMINI] Locate step (Gemini) took ${Date.now() - tLocateStart}ms (total ${elapsed()}) — not a scale photo at all, skipping the rest of the accurate path`);
                return { notAPhoto: true };
            }
            candidates = aiBox ? [aiBox] : null;
            locateSource = 'Gemini (pixel locate found nothing confident)';
        }
        console.log(`[GEMINI] Locate step (${locateSource}) took ${Date.now() - tLocateStart}ms (total ${elapsed()}), ${candidates ? candidates.length : 0} candidate box(es)`);
        if (!candidates || !candidates.length) return null;

        // Changed 2026-08-11 to try each candidate box in turn instead of
        // committing to only the first one — reproduced live on a real
        // photo where the top-scoring color cluster was actually a blurry
        // window reflection, not the display, and the genuine digit cluster
        // was the SECOND-largest component (298px vs the false positive's
        // 323px — a threshold-based rejection was tried and reverted, too
        // fragile a margin; see findDisplayBoxByColor). This is the safer
        // version of that fix: actually attempt to read each candidate and
        // use whichever one produces a real result, rather than guessing in
        // advance which one is "real."
        let lastAttempt = null;
        let weakAttempt = null; // a candidate that read SOMETHING but looked truncated — see below
        for (let i = 0; i < candidates.length; i++) {
            const box = candidates[i];
            const tag = candidates.length > 1 ? ` (candidate ${i + 1}/${candidates.length})` : '';
            if (process.env.DEBUG_WEIGHT_RAW) console.log(`[DEBUG box${tag}]`, JSON.stringify(box));

            const tCropStart = Date.now();
            const croppedBase64 = await cropToDisplay(imageBase64, mimeType, box);
            console.log(`[GEMINI] Crop step${tag} took ${Date.now() - tCropStart}ms (total ${elapsed()})`);
            if (process.env.DEBUG_WEIGHT_RAW) console.log('[DEBUG cropped len]', croppedBase64 && croppedBase64.length);
            if (process.env.DEBUG_DUMP_CROP && croppedBase64) {
                const dumpPath = candidates.length > 1 ? `${process.env.DEBUG_DUMP_CROP}.cand${i + 1}` : process.env.DEBUG_DUMP_CROP;
                require('fs').writeFileSync(dumpPath, Buffer.from(croppedBase64, 'base64'));
            }
            if (!croppedBase64) continue;

            // Kicked off together but not awaited together — the metadata
            // call (unit label / which-display reasoning) is non-essential
            // and has safe defaults below, so it shouldn't hold up the
            // weight itself.
            const tVisionStart = Date.now();
            const visionPromise = visionOcr.detectText(croppedBase64);
            const geminiMetaPromise = readWeightSinglePass(croppedBase64, 'image/jpeg', retries, { isCrop: true }).catch((err) => {
                console.warn('[GEMINI] Metadata read on crop failed:', err.message);
                return null;
            });

            const visionText = await visionPromise;
            console.log(`[GEMINI] Vision-on-crop step${tag} took ${Date.now() - tVisionStart}ms (total ${elapsed()})`);
            if (process.env.DEBUG_WEIGHT_RAW) console.log('[DEBUG vision]', JSON.stringify({ visionText }));
            // extractWeightNumberFromCrop returns { weight, viaLeadingStrip }
            // (changed 2026-08-11) or null — visionWeight stays a plain
            // number everywhere below for backward compat with the many
            // existing usages; viaLeadingStrip is carried separately and
            // only consulted where it matters (the ambiguous-flagging
            // decision on the fast path below).
            const visionResult = visionOcr.extractWeightNumberFromCrop(visionText);
            const visionWeight = visionResult ? visionResult.weight : null;
            const visionWeightViaLeadingStrip = !!(visionResult && visionResult.viaLeadingStrip);

            const attempt = { visionWeight, visionWeightViaLeadingStrip, visionText, box, geminiMetaPromise, croppedBase64 };
            lastAttempt = attempt;
            if (visionWeight != null) {
                // Added 2026-08-11 after a real production log: two candidate
                // boxes were found (1258px vs 679px lit pixels), the LARGER
                // one was tried first per the existing "biggest first" sort,
                // and it produced a plausible-looking but truncated "9373"
                // (correctly caught by the existing <10000 suspicious-short
                // flag below, but the SECOND candidate — quite possibly the
                // real display — was never even tried, since candidate 1
                // already "succeeded"). A bigger lit-pixel count does not
                // mean a candidate is more likely to be the real display —
                // that was already the whole reason multiple candidates get
                // tried at all (see the false-positive-reflection case
                // above) — so a candidate whose result already looks
                // truncated on ITS OWN terms shouldn't get to end the search
                // early either. Only applies to the weighbridge/default
                // classification (matching the real <10000 flag below) —
                // compact indicators legitimately read short (e.g. 2251) and
                // must not be held back waiting for a longer number that
                // will never come.
                const isCompactIndicator = looksLikeCompactIndicatorFromVisionText(visionText);
                const looksTruncated = !isCompactIndicator && visionWeight < 10000;
                if (!looksTruncated) {
                    if (i > 0) console.log(`[GEMINI] Candidate ${i + 1} produced a readable result after candidate(s) 1-${i} found nothing`);
                    return attempt;
                }
                if (!weakAttempt) weakAttempt = attempt;
                console.log(`[GEMINI] Candidate ${i + 1} read ${visionWeight} — shorter than a real weighbridge reading, holding it as a fallback and trying the next candidate first`);
                continue;
            }
            // Vision found nothing on this candidate — loop tries the next
            // one, if any. Extra cost is rare (usually only 1 candidate
            // exists at all) and only paid when the top candidate fails,
            // which is exactly the case worth spending more on.
        }
        // Changed 2026-08-11: this used to `return null` the instant
        // Vision-on-crop came back empty, which threw away a perfectly good,
        // tightly-isolated crop AND silently abandoned the geminiMetaPromise
        // already running in parallel on that same crop — forcing a fall-back
        // all the way to the much noisier whole-image OCR pass even when
        // Gemini's own read of the SAME crop might still succeed. Reproduced
        // live: a real weighbridge crop that's clearly legible to the human
        // eye (bright, high-contrast red digits) got a genuine "no text
        // detected" response from the Vision API itself (200 status, no
        // error, just an empty result) — not every Vision failure is a
        // hallucination; sometimes it just finds nothing. Now always returns
        // the last candidate's crop info so the caller can try Gemini's
        // parallel read on it before giving up entirely. Prefer a held-back
        // truncated-but-real reading (weakAttempt) over the literal last
        // candidate tried, which may have found nothing at all — a
        // suspicious-but-real number beats nothing.
        return weakAttempt || lastAttempt;
    })().catch((err) => {
        console.warn('[GEMINI] Crop-zoom accurate path failed:', err.message);
        return null;
    });

    // Widened from 4000ms after the 2026-08-10 test above showed the accurate
    // path missing that budget and falling back to an ambiguous whole-image
    // read on a photo with two displays in frame — per Apsara, a wrong/
    // ambiguous number is worse than the extra latency. Still capped (not
    // unbounded) so a genuinely hung network call can't stall the response
    // forever; env-overridable for tuning without a redeploy.
    const ACCURATE_PATH_BUDGET_MS = Number(process.env.ACCURATE_PATH_BUDGET_MS) || 9000;
    const accurate = await withTimeout(accuratePathPromise, ACCURATE_PATH_BUDGET_MS, 'Locate+crop accurate path');
    // Wording fixed after a real log showed this saying "not ready in time"
    // when the path had actually FINISHED (in ~7.6s, under the then-9s
    // budget) and legitimately failed (a degenerate box produced a too-small
    // crop) — "not ready in time" implied a timeout that never happened and
    // pointed the wrong direction. withTimeout() above already logs its own
    // distinct warning on a genuine timeout; this line just reports outcome.
    console.log(`[GEMINI] Accurate (cropped) path ${accurate ? (accurate.notAPhoto ? 'determined this is not a scale photo at all' : (accurate.visionWeight != null ? 'succeeded' : 'located a crop but Vision found no text on it')) : 'did not produce a usable reading'} at ${elapsed()}`);

    // Added 2026-08-11 after a real batch-test image (a screenshot of the
    // dashboard's own "Add New Load" form) got mined by the whole-image
    // Vision fallback for a plausible-looking number ("456," pulled straight
    // out of unrelated placeholder text "e.g. 456 Scrap Ave, Dallas, TX")
    // and returned as a confident, unflagged weight. Gemini's locate step
    // already correctly recognized this wasn't a yard photo at all — that
    // signal is honored here by skipping every fallback (including the
    // final single-pass Gemini read) and returning no reading, rather than
    // continuing to guess from a photo that was never going to contain a
    // real weight in the first place.
    if (accurate && accurate.notAPhoto) {
        console.warn(`[GEMINI] Not a scale photo (per locate step) — returning no reading rather than guessing from irrelevant text`);
        return {
            weight: null,
            weight_unit: null,
            displays_seen: 'This does not appear to be a photo of a scale display',
            raw_text: null,
            ambiguous: false,
            not_a_scale_photo: true,
        };
    }

    // Added 2026-08-11: Vision-on-crop came back genuinely empty (not
    // garbled, not hallucinated — literally no text detected) despite a
    // valid, tightly-cropped display image existing. Rather than discard
    // that crop and fall straight to the noisier whole-image OCR, try
    // Gemini's already-in-flight parallel read of the SAME crop first —
    // see the long comment at the crop-path return site above for why this
    // case exists at all.
    if (accurate && accurate.visionWeight == null) {
        // Added 2026-08-11, per Apsara ("find a way to fix this 1" — the
        // last unresolved hard photo in the 12-photo batch, 47.jpeg).
        // Root-caused by directly comparing crop bytes on the real photo
        // (not guessing): trimDeadDigitZones (built for a real, different
        // bug — a dim ghost cell hallucinated as a phantom leading digit)
        // was cutting THIS photo's crop from 2619px down to 1585px wide, and
        // that trimmed crop is what Vision found zero text on, repeatably,
        // at several resolutions/contrast levels. The UNTRIMMED crop at the
        // exact same box/padding read cleanly on Vision ("81960") on the
        // first try. So: retry Vision on the untrimmed crop before assuming
        // the display itself is unreadable. If that still finds nothing,
        // layer a contrast-stretch + sharpen on top of the untrimmed crop as
        // a second attempt (verified live to pull a different hard crop from
        // "no text" to legible). Both are local image-processing passes with
        // no extra API cost, tried BEFORE the slower Gemini-retry loop below
        // — if either recovers a real answer, Gemini retries never need to
        // run at all. NOTE: even the untrimmed crop reads this specific
        // photo's second digit inconsistently (Vision, Gemini, and my own
        // eye all had to work to disambiguate 8 vs 1 vs 7 on that one cell)
        // — this is a real display-legibility limit on a dim, angled photo,
        // not a pipeline bug, which is exactly why this whole rescue path
        // always returns ambiguous:true rather than silently trusting
        // whichever variant happens to answer.
        let rescueWeight = null, rescueText = null, rescueLabel = null;
        if (accurate.box) {
            const attempts = [
                { label: 'untrimmed crop', opts: { skipTrim: true } },
                { label: 'untrimmed + contrast-boosted crop', opts: { skipTrim: true, boost: true } },
            ];
            for (const attempt of attempts) {
                try {
                    const rescueCrop = await cropToDisplay(imageBase64, mimeType, accurate.box, attempt.opts);
                    if (!rescueCrop) continue;
                    const text = await visionOcr.detectText(rescueCrop);
                    // extractWeightNumberFromCrop returns { weight, viaLeadingStrip }
                    // or null (changed 2026-08-11) — viaLeadingStrip isn't
                    // consulted here since this whole rescue path already
                    // unconditionally flags ambiguous:true regardless.
                    const weightResult = visionOcr.extractWeightNumberFromCrop(text);
                    const weight = weightResult ? weightResult.weight : null;
                    console.log(`[GEMINI] Rescue attempt "${attempt.label}" (Vision-on-crop found nothing on plain crop): ${weight ?? 'still nothing'} (raw: "${text || ''}")`);
                    if (weight != null) { rescueWeight = weight; rescueText = text; rescueLabel = attempt.label; break; }
                } catch (err) {
                    console.warn(`[GEMINI] Rescue attempt "${attempt.label}" failed:`, err.message);
                }
            }
        }
        if (rescueWeight != null) {
            const note = ` [Vision found no text on the plain (trimmed) crop; retrying on a "${rescueLabel}" of the same box recovered a reading — flagged for review since a display that needed this rescue path has already shown it's harder than usual to read]`;
            console.log(`[GEMINI] Weight read via Cloud Vision OCR (${rescueLabel} rescue) in ${elapsed()}: ${rescueWeight}${note}`);
            return {
                weight: rescueWeight,
                alternate_weight: null,
                alternate_source: null,
                weight_unit: 'lb',
                displays_seen: `Cloud Vision OCR read of a ${rescueLabel} (locate reason: "${accurate.box.reason || ''}"), plain crop found no text`,
                raw_text: `${rescueText || ''} (Cloud Vision OCR, ${rescueLabel})${note}`,
                ambiguous: true,
            };
        }

        const GEMINI_META_TIMEOUT_MS = Number(process.env.GEMINI_META_TIMEOUT_MS) || 8000;
        let geminiMeta = await withTimeout(accurate.geminiMetaPromise, GEMINI_META_TIMEOUT_MS, 'Gemini crop metadata (Vision-on-crop found nothing)');

        // Added 2026-08-11, per Apsara ("I want 100% accuracy, find some way
        // to fix"): confirmed live that Vision genuinely, deterministically
        // finds nothing on some crops (tested 4x identical + both
        // TEXT_DETECTION and DOCUMENT_TEXT_DETECTION directly against the
        // raw API — not a retry-able flake), but Gemini's own read of the
        // SAME crop, while inconsistent call-to-call, is not random noise —
        // repeated testing showed it converging on the same answer more
        // often than not (2 of 4 attempts matched exactly, a 3rd landed one
        // digit off on the specific cell that's genuinely hard to read even
        // by eye). A single Gemini attempt is therefore leaving real signal
        // on the table when it happens to land on a null/uncertain read.
        // Retries up to 2 more times and prefers a value that AGREES across
        // attempts (real corroboration) over just taking whichever came
        // first. Still always flagged ambiguous — there's no independent
        // Vision cross-check in this branch regardless of how many Gemini
        // attempts agree.
        //
        // Timeout capped tighter for retries specifically, per Apsara's
        // call after seeing the real tradeoff live: an 8000ms budget per
        // attempt meant a run where every attempt failed cost 28s total
        // before falling back to the (wrong, but at least fast) whole-image
        // read — worse than the old single-attempt behavior on the failure
        // case, for an occasional win on the success case. 4000ms per retry
        // bounds the worst case to roughly half that while still giving
        // each attempt a real shot (successful reads in testing landed
        // between 1.5-5s).
        // Changed 2026-08-11, per Apsara asking why this was taking so long:
        // these 2 retries used to run ONE AT A TIME, each awaited fully
        // before the next started — worst case 8000 (first attempt, above)
        // + 4000 + 4000 = 16000ms, entirely sequential, even though the two
        // retries don't depend on each other at all. Same 2 API calls, same
        // "prefer two attempts that agree" logic, just fired concurrently
        // instead of queued — cuts the worst case to 8000 + 4000 = 12000ms.
        // Not made fully eager (started before the first attempt is even
        // known to have failed) on purpose: that would spend 2 extra Gemini
        // calls even on the common case where the first attempt succeeds
        // quickly, trading API cost for a latency win that isn't needed
        // there.
        const GEMINI_RETRY_TIMEOUT_MS = Number(process.env.GEMINI_RETRY_TIMEOUT_MS) || 4000;
        if (!geminiMeta || geminiMeta.weight == null) {
            const seen = new Map(); // weight -> count
            if (geminiMeta && geminiMeta.weight != null) seen.set(geminiMeta.weight, 1);
            const retryPromises = accurate.croppedBase64
                ? [0, 1].map((attempt) => withTimeout(
                      readWeightSinglePass(accurate.croppedBase64, 'image/jpeg', retries, { isCrop: true }).catch(() => null),
                      GEMINI_RETRY_TIMEOUT_MS,
                      `Gemini crop metadata retry ${attempt + 1} (Vision-on-crop found nothing)`
                  ))
                : [];
            const retryResults = await Promise.all(retryPromises);
            for (const retryMeta of retryResults) {
                if (retryMeta && retryMeta.weight != null) {
                    seen.set(retryMeta.weight, (seen.get(retryMeta.weight) || 0) + 1);
                    if (!geminiMeta) geminiMeta = retryMeta; // keep first successful as fallback shape
                    if (seen.get(retryMeta.weight) >= 2) { geminiMeta = retryMeta; break; } // two attempts agreed — use that
                }
            }
        }

        if (geminiMeta && geminiMeta.weight != null) {
            const note = ` [Vision found no text at all on this crop; Gemini's read of the same crop is used instead, with no Vision cross-check available — flagged for review]`;
            console.log(`[GEMINI] Weight read via Gemini (primary, cropped, Vision-found-nothing fallback) in ${elapsed()}: ${geminiMeta.weight}${note}`);
            return {
                weight: geminiMeta.weight,
                alternate_weight: null,
                alternate_source: null,
                weight_unit: geminiMeta.weight_unit || 'lb',
                displays_seen: geminiMeta.displays_seen || `Gemini read of located display (locate reason: "${accurate.box.reason || ''}"), Vision found no text`,
                raw_text: `${geminiMeta.raw_text || ''} (Gemini, Vision found nothing on this crop)${note}`,
                ambiguous: true,
            };
        }
        // Neither engine got anything off this crop after retries —
        // genuinely fall through to the whole-image pass below, same as
        // before.
    }

    if (accurate && accurate.visionWeight != null) {
        // Rework 2026-08-11, per Apsara ("remove the timing constraint, find
        // some other way to do it very fast"): the previous version always
        // synchronously waited on a second full Gemini call (readWeightSinglePass
        // again, ~3.5-8s+, sometimes 8s+ and timing out) before responding,
        // on EVERY read, just to get a `displays_seen` classification string.
        // Live testing showed that wait alone pushed total latency to
        // 11-12s on ordinary weighbridge reads that didn't need Gemini's
        // opinion at all (Vision has been extensively proven reliable on
        // that display type all session).
        //
        // Fix: classify display type from Vision's OWN crop OCR text
        // (`accurate.visionText`), which we already have for free — no
        // extra API call, no extra wait, zero added latency. This works
        // because compact 7-segment bench/platform indicators (Socome-style)
        // print their own control-panel labels right on the fascia, which
        // Vision's OCR already picks up on the SAME crop it's reading
        // digits from (confirmed live: the Socome crop's Vision text
        // included "Weighing Indicato[r]", "STABLE", "COUNT", "TARE",
        // "ON/OFF FUNC UNITS" every single time across 3 repeated runs).
        // Weighbridge crops never contain that vocabulary — usually just
        // bare digits plus a unit label (e.g. "ZOSI...81460").
        const looksCompactIndicator = looksLikeCompactIndicatorFromVisionText(accurate.visionText);

        if (!looksCompactIndicator) {
            // FAST PATH — the common case. Vision is the proven-reliable
            // engine here, so respond immediately without waiting on
            // Gemini's metadata call at all (it's still kicked off in
            // parallel above for potential future use/logging, but nothing
            // downstream blocks on it — its .catch() already prevents an
            // unhandled-rejection warning if it's simply never awaited).
            // Added 2026-08-11: cross-check the digit count before trusting
            // this unflagged. Reproduced live: the AI-locate box (used when
            // pixel-locate can't confidently place one) is non-deterministic
            // — a repeat run on the IDENTICAL photo returned a tighter box
            // than the first attempt and cropped off the leading "28" of
            // "28460", leaving "460" — still inside the 200-90000 plausible
            // range on its own, so it slipped through as a confident,
            // unflagged, WRONG answer. No range check catches a truncated-
            // but-still-plausible number. Every confirmed genuine reading on
            // THIS path (the red/weighbridge display) has been 5 digits
            // (20000-90000+ lb) all session — nothing shorter has ever been
            // real. So: still return Vision's number (better than nothing,
            // and often still right), but flag it for a human glance if it's
            // suspiciously short for this specific display type, rather than
            // present a possibly-truncated number with false confidence.
            // Padding for the AI-locate path was also widened (see
            // cropToDisplay) to make this less likely to happen at all.
            const suspiciouslyShort = accurate.visionWeight < 10000;
            // Added 2026-08-11 after a real photo showed Vision reading a
            // crop as "817520" — the leading-digit-strip fallback in
            // extractWeightNumberFromCrop stripped the "8" to get the
            // in-range "17520" and this fast path returned it completely
            // unflagged, while Gemini's own parallel (unused-on-this-path)
            // read said "87520" instead. That fallback assumes contamination
            // is always a prepended ghost digit on the far left — true in
            // every case seen before, but not guaranteed, and it has no way
            // to tell the difference. So: whenever the strip fallback fired,
            // treat this exactly like the suspicious-short case (flag it),
            // regardless of the resulting digit count, instead of trusting a
            // rescued number as fully as a clean single in-range match.
            const viaStrip = accurate.visionWeightViaLeadingStrip;
            const flagForReview = suspiciouslyShort || viaStrip;
            const reviewReason = suspiciouslyShort
                ? ' — shorter than every confirmed real reading on this display type, flagged for review in case of a truncated crop'
                : (viaStrip ? ' — Vision\'s raw read needed a leading-digit correction to become plausible, flagged for review since that correction isn\'t guaranteed correct' : '');

            // When the strip fallback fired, Gemini's already-in-flight
            // parallel read of the SAME crop is worth a bounded wait here —
            // matching the same "surface both candidates" pattern already
            // used on the slow/compact-indicator path below, rather than
            // silently discarding it. Real case this was built for: Vision
            // said 17520 (post-strip), Gemini said 87520 on the same crop —
            // showing both lets a human resolve it in one glance instead of
            // walking back to the scale with only one (possibly wrong)
            // number to check against.
            // Changed 2026-08-11: this cross-check used to only fire for
            // viaStrip. Real production case: Vision cleanly read "736" (no
            // strip needed — suspiciouslyShort alone tripped flagForReview)
            // and this branch never ran, so the driver was left with a bare
            // unverified "736" and no second opinion, even though Gemini's
            // parallel read of the SAME crop was already in flight the whole
            // time. Widening the condition from viaStrip to flagForReview
            // means BOTH flagged cases now get Gemini's second opinion
            // surfaced as alternate_weight before returning, not just the
            // strip sub-case. Only affects already-flagged (rare, already
            // slow-tolerant) reads — clean in-range results never touch this.
            let strippedAlt = null;
            if (flagForReview) {
                // Widened 3000 -> 8000ms after a real miss: a live photo
                // where Vision's strip-corrected read (73500) was actually
                // wrong (confirmed true value 73600, one digit off — a
                // genuine Vision misread of 5-vs-6, not just the spurious
                // leading digit), and Gemini's parallel read HAD the correct
                // 73600 the whole time but got cut off by this timeout
                // before it could be surfaced as alternate_weight. Gemini
                // benchmarked at ~12-16s/request on this exact digit-reading
                // task (see readWeightSinglePass's model-choice comment) —
                // geminiMetaPromise is kicked off well before this point
                // (in parallel with Vision-on-crop, which itself typically
                // takes several seconds), so it already has a head start,
                // but 3000ms of ADDITIONAL wait after that head start was
                // measured too tight to catch a real, useful disagreement
                // that was already in flight. This only fires on the
                // less-common viaLeadingStrip path, so the extra worst-case
                // latency here is not paid on ordinary clean reads.
                // Widened again 8000 -> 15000ms: live-tested and STILL missed
                // a real, correct 73600 answer that came back at ~12.7s
                // total (Vision-on-crop's own ~6s head start plus Gemini's
                // full ~12-16s benchmark time barely fits in an 8000ms
                // ADDITIONAL wait). This path already only runs when Vision's
                // own read needed a correction (rare, already flagged
                // low-confidence), so paying up to ~20s total here to
                // reliably catch the cross-check is the right trade given
                // Apsara's explicit priority ("i cant afford to have
                // mistakes" outranks speed when the two conflict).
                const GEMINI_CROSSCHECK_TIMEOUT_MS = Number(process.env.GEMINI_CROSSCHECK_TIMEOUT_MS) || 15000;
                const crossCheck = await withTimeout(accurate.geminiMetaPromise, GEMINI_CROSSCHECK_TIMEOUT_MS, `Gemini crop metadata (cross-check — ${viaStrip ? 'leading-digit strip' : 'suspiciously short read'})`);
                if (crossCheck && crossCheck.weight != null && crossCheck.weight !== accurate.visionWeight) strippedAlt = crossCheck.weight;
            }

            console.log(`[GEMINI] Weight read via Cloud Vision OCR (primary, cropped, fast path) in ${elapsed()}: ${accurate.visionWeight}${reviewReason}${strippedAlt != null ? ` (Gemini's own read of the same crop disagreed: ${strippedAlt})` : ''}`);
            return {
                weight: accurate.visionWeight,
                alternate_weight: strippedAlt,
                alternate_source: strippedAlt != null ? 'Gemini' : null,
                weight_unit: 'lb',
                displays_seen: `Cloud Vision OCR read of located display (locate reason: "${accurate.box.reason || ''}")`,
                raw_text: `${accurate.visionText} (Cloud Vision OCR, fast path — classified as weighbridge/default from Vision's own crop text, no Gemini wait)${reviewReason ? ` [${reviewReason.replace(/^ — /, '')}${strippedAlt != null ? `; Gemini's own read of the same crop said ${strippedAlt} instead` : ''} — please verify against the actual display]` : ''}`,
                ambiguous: flagForReview,
            };
        }

        // SLOW PATH — only compact indicators pay this cost, since Vision
        // is proven UNRELIABLE on this display type (hallucinated a blank
        // leading cell into "8" — "82258" instead of "2251" — reproduced
        // live 3x). We genuinely need Gemini's actual digit value here,
        // there's no way around waiting for it on this branch. It was
        // kicked off in parallel back when the crop was first ready, so
        // most of its latency is already absorbed by the time Vision's OCR
        // + this text classification finished (~1.3-4.6s head start
        // observed live) — the timeout below is a safety cap, not the
        // expected wait.
        const GEMINI_META_TIMEOUT_MS = Number(process.env.GEMINI_META_TIMEOUT_MS) || 8000;
        const geminiMeta = await withTimeout(accurate.geminiMetaPromise, GEMINI_META_TIMEOUT_MS, 'Gemini crop metadata');
        const preferGemini = !!(geminiMeta && geminiMeta.weight != null);

        const primaryWeight = preferGemini ? geminiMeta.weight : accurate.visionWeight;
        const altWeight = preferGemini ? accurate.visionWeight : null;
        const altSource = preferGemini ? 'Cloud Vision' : null;

        // If Gemini's call also failed/timed out here, we have NO trustworthy
        // reading at all for a display type Vision is proven wrong on — must
        // flag rather than silently hand back Vision's likely-wrong number.
        const ambiguous = !preferGemini;
        const note = preferGemini
            ? ` [display classified as a compact indicator from Vision's own OCR text — Gemini used as primary here instead of Vision, which hallucinates on this display type; Vision's read was ${accurate.visionWeight}]`
            : ` [display classified as a compact indicator, where Vision is known-unreliable, but Gemini's second-opinion read did not return in time — Vision's read (${accurate.visionWeight}) returned anyway as a best-effort fallback, flagged for review]`;
        console.log(`[GEMINI] Weight read via ${preferGemini ? 'Gemini' : 'Cloud Vision OCR (fallback)'} (primary, cropped, slow path) in ${elapsed()}: ${primaryWeight}${note}`);
        return {
            weight: primaryWeight,
            alternate_weight: altWeight,
            alternate_source: altSource,
            weight_unit: (geminiMeta && geminiMeta.weight_unit) || 'lb',
            displays_seen: (geminiMeta && geminiMeta.displays_seen) || `Cloud Vision OCR read of located display (locate reason: "${accurate.box.reason || ''}")`,
            raw_text: `${accurate.visionText} (Cloud Vision OCR)${note}`,
            ambiguous,
        };
    }

    // Accurate path didn't produce a usable Vision reading within budget
    // (locate too slow/failed, crop failed, or the crop's Vision read came
    // back empty) — use the whole-image Vision OCR kicked off at the very
    // top instead of waiting any further.
    const wholeVisionText = await wholeImageVisionPromise;
    // A whole, uncropped photo can legitimately contain more than one number
    // (a bench-scale item reading, a date, a truck ID) — extractWeightNumber's
    // "longest digit run" heuristic is only safe on an isolated crop, so the
    // whole-image path uses extractPlausibleWeightFromFullImage instead, which
    // constrains to a plausible truck-load range and flags ambiguity rather
    // than silently guessing. See helpers/visionOcr.js for the full reasoning.
    const wholeVisionResult = visionOcr.extractPlausibleWeightFromFullImage(wholeVisionText);

    // Added 2026-08-11 after a measured, reproducible miss on a
    // WhatsApp-compressed photo (true weight 28460): the accurate path's
    // crop read came back empty, this whole-image fallback mined "41516"
    // out of unrelated full-photo text and returned it — while Gemini's
    // read of the actual CROP, already in flight, resolved moments later
    // with the correct 28460 and was thrown away unused. Reading the whole
    // photo is the weakest source we have (it is explicitly a "largest
    // plausible number in the frame" guess, not a display read), so it must
    // not win a race against a real read of the isolated display that is
    // already running. Wait for it here, bounded, and prefer it. This only
    // costs latency on a path that has ALREADY failed to read the crop —
    // never on a normal successful read.
    //
    // Second half of the same finding: on that photo the accurate path had
    // not merely failed, it had TIMED OUT — the red pixel locate found
    // nothing usable, so it fell through to Gemini's AI locate, which alone
    // took 9848ms and blew the 9000ms ACCURATE_PATH_BUDGET_MS. The budget
    // returns null and moves on, but the path keeps running: it produced a
    // correct crop and Gemini's "28460" at ~11.8s, about 2.7s after this
    // fallback had already committed to the wrong 41516. So before settling
    // for whole-image mining, give the still-running accurate path a bounded
    // second chance to land. Same trade as above: extra latency only on a
    // path that was about to return the weakest answer we produce.
    let lateAccurate = accurate;
    if (!lateAccurate) {
        const ACCURATE_PATH_GRACE_MS = Number(process.env.ACCURATE_PATH_GRACE_MS) || 8000;
        lateAccurate = await withTimeout(accuratePathPromise, ACCURATE_PATH_GRACE_MS, 'Locate+crop accurate path (grace period before whole-image fallback)');
        if (lateAccurate && lateAccurate.visionWeight != null) {
            console.log(`[GEMINI] Accurate path landed during the grace period in ${elapsed()}: ${lateAccurate.visionWeight} — using it instead of whole-image OCR${wholeVisionResult.weight != null ? ` (${wholeVisionResult.weight})` : ''}`);
            return {
                weight: lateAccurate.visionWeight,
                alternate_weight: wholeVisionResult.weight != null && wholeVisionResult.weight !== lateAccurate.visionWeight ? wholeVisionResult.weight : null,
                alternate_source: wholeVisionResult.weight != null && wholeVisionResult.weight !== lateAccurate.visionWeight ? 'Cloud Vision OCR (whole image)' : null,
                weight_unit: 'lb',
                displays_seen: `Cloud Vision OCR read of located display, landed after the accurate-path budget (locate reason: "${(lateAccurate.box && lateAccurate.box.reason) || ''}")`,
                raw_text: `${lateAccurate.visionText} (Cloud Vision OCR on the display crop, after grace period)`,
                ambiguous: true,
            };
        }
    }

    if (lateAccurate && lateAccurate.geminiMetaPromise) {
        const GEMINI_WHOLEIMAGE_RESCUE_TIMEOUT_MS = Number(process.env.GEMINI_WHOLEIMAGE_RESCUE_TIMEOUT_MS) || 12000;
        const cropRead = await withTimeout(
            lateAccurate.geminiMetaPromise,
            GEMINI_WHOLEIMAGE_RESCUE_TIMEOUT_MS,
            'Gemini crop metadata (rescue before falling back to whole-image OCR)',
        );
        if (cropRead && cropRead.weight != null) {
            console.log(`[GEMINI] Weight read via Gemini's crop read in ${elapsed()}: ${cropRead.weight} — preferred over the whole-image OCR guess${wholeVisionResult.weight != null ? ` (${wholeVisionResult.weight})` : ''}, since a read of the isolated display beats mining the largest plausible number out of the full photo`);
            return {
                weight: cropRead.weight,
                alternate_weight: wholeVisionResult.weight != null && wholeVisionResult.weight !== cropRead.weight ? wholeVisionResult.weight : null,
                alternate_source: wholeVisionResult.weight != null && wholeVisionResult.weight !== cropRead.weight ? 'Cloud Vision OCR (whole image)' : null,
                weight_unit: cropRead.weight_unit || 'lb',
                displays_seen: cropRead.displays_seen || 'Gemini read of the located display crop (Vision found nothing on that crop)',
                raw_text: `${cropRead.raw_text || ''} (Gemini read of the display crop — used instead of whole-image OCR, which found ${wholeVisionResult.weight != null ? wholeVisionResult.weight : 'nothing usable'})`,
                ambiguous: true,
            };
        }
    }

    if (wholeVisionResult.weight != null) {
        const ambiguityNote = wholeVisionResult.ambiguous
            ? ` [more than one plausible weight-sized number was found in the full photo (${wholeVisionResult.candidates.join(', ')}) — no display could be isolated first, so this is the largest of them; PLEASE VERIFY against the actual weighbridge display before trusting it]`
            : '';
        console.log(`[GEMINI] Weight read via Cloud Vision OCR (whole image) in ${elapsed()}: ${wholeVisionResult.weight}${wholeVisionResult.ambiguous ? ' — AMBIGUOUS, multiple candidates, flagged for review' : ''}`);
        return {
            weight: wholeVisionResult.weight,
            weight_unit: 'lb',
            displays_seen: `Cloud Vision OCR read of the full photo (no display could be located/cropped in time)${ambiguityNote}`,
            raw_text: `${wholeVisionText} (Cloud Vision OCR, whole image)${ambiguityNote}`,
            // Explicit boolean, not just text buried in raw_text/displays_seen —
            // added after discovering the caller (mobile-app + dashboard
            // processWeightImage) only ever showed a generic "check it matches
            // the scale" message on-screen and logged raw_text/displays_seen to
            // the browser console only, which nobody at a yard station is going
            // to open. The frontend now checks this field directly to show a
            // loud, distinct on-screen warning instead of a message a busy
            // operator can tune out.
            ambiguous: !!wholeVisionResult.ambiguous,
        };
    }

    console.warn(`[GEMINI] Vision OCR found nothing on either path by ${elapsed()}, falling back to Gemini single-pass read (last resort, will be slow)`);
    return readWeightSinglePass(imageBase64, mimeType, retries);
}

module.exports = { callGeminiJSON, extractPdfFields, extractBookingFieldsFromText, resolveCutoffDate, classifyDocument, extractScaleTicketFields, extractWeightFromImage, checkPhotoQuality };