// ── helpers/gemini.js — Gemini JSON-only wrapper ─────────────────────────────
// One job: send prompt, get back parsed JSON or null. Never free text upstream.
// Model name comes from settings.json (hot-swappable) with env fallback.

const { GoogleGenerativeAI } = require('@google/generative-ai');
const cfg = require('../config');
const fs = require('fs');
const visionOcr = require('./visionOcr');
let sharp = null;
try { sharp = require('sharp'); } catch { /* crop-zoom step degrades to a no-op if sharp isn't installed */ }

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

// Stage 1 of 2 — find WHERE the vehicle weighbridge display is in the frame,
// before trying to read digits off it. Root cause of a real misread on a real
// yard photo (confirmed ground-truth 71920, model read first 37920 then
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
    const prompt = `Find the primary VEHICLE WEIGHBRIDGE display in this yard photo — the display used to read an entire truck/vehicle's weight, not a small bench/platform scale for individual items.
- The vehicle weighbridge display is often a large remote/overhead signage-style box (commonly red LED digits, mounted high), sometimes with unit lights (LB/KG/GR/NT) down one side, usually no physical buttons since it's just a repeater screen.
- Ignore a compact bench/platform indicator with physical buttons (ZERO, TARE, GROSS/NET, PRINT) and a brand name (Fairbanks, Rice Lake, Avery Weigh-Tronix, Mettler Toledo, Cardinal) — that's almost always a separate, smaller scale for individual items, not the vehicle.
- If both are visible, locate the large vehicle display, not the compact one.

Return ONLY raw JSON, no markdown:
{
  "found": false,     // true only if you can confidently locate a vehicle weighbridge display
  "x_min": null,       // left edge of a bounding box around the ENTIRE display housing (not just the digits), as a fraction 0-1 of image width
  "y_min": null,       // top edge, fraction 0-1 of image height
  "x_max": null,       // right edge, fraction 0-1 of image width
  "y_max": null,       // bottom edge, fraction 0-1 of image height
  "reason": null        // one short phrase on what you found/why
}
Give the box some margin around the housing rather than cropping tight to the digits themselves. If no vehicle weighbridge display is visible at all, return found:false and null for the box fields.`;

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
        if (!fields.found) { console.warn(`[GEMINI] Locate step: model reported no display found (reason: "${fields.reason || 'none given'}"), falling back to whole image`); return null; }
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

        // Don't just take the FIRST column that crosses the threshold — on a
        // real photo the unit-label text (LB/KG/GR/NT down the side) is often
        // reddish/bright enough itself to cross a naive threshold, and it sits
        // to the left of the actual digits. Taking the first crossing latched
        // onto the label instead of skipping past it to the ghost cell beyond,
        // which is exactly why an earlier version of this only trimmed part of
        // the way and the ghost cell still made it into the model's crop.
        // Fix: find every contiguous above-threshold run, merge runs that are
        // close together (small gaps are just the dark space between adjacent
        // digit cells — still one "number"), and use the LONGEST merged run.
        // The label is narrow and isolated; the real digit run is wide and,
        // once inter-digit gaps are merged, contiguous — it wins on width even
        // though the label can locally be just as bright.
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
        merged.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
        const [runStart2, runEnd2] = merged[0];

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
async function cropToDisplay(imageBase64, mimeType, box) {
    if (!sharp || !box) return null;
    try {
        const buf = Buffer.from(imageBase64, 'base64');
        const img = sharp(buf);
        const meta = await img.metadata();
        const w = meta.width, h = meta.height;
        if (!w || !h) return null;

        // 12% padding around the model's box on each side, clamped to image bounds —
        // the box is around the housing already; a bit more margin protects against
        // a slightly-too-tight box cutting off a digit.
        const padX = (box.x_max - box.x_min) * 0.12;
        const padY = (box.y_max - box.y_min) * 0.12;
        let left = Math.max(0, Math.round((box.x_min - padX) * w));
        let top = Math.max(0, Math.round((box.y_min - padY) * h));
        let right = Math.min(w, Math.round((box.x_max + padX) * w));
        let bottom = Math.min(h, Math.round((box.y_max + padY) * h));
        let cropW = right - left, cropH = bottom - top;
        if (cropW < 20 || cropH < 20) return null;

        const boxCrop = img.clone().extract({ left, top, width: cropW, height: cropH });
        const trim = await trimDeadDigitZones(boxCrop, cropW, cropH);
        let finalExtract = { left, top, width: cropW, height: cropH };
        if (trim) {
            finalExtract = { left: left + trim.left, top, width: trim.width, height: cropH };
            console.log(`[GEMINI] Trimmed dead/ghost LED zone off crop edge (${cropW}px -> ${trim.width}px wide)`);
        }

        // Upscale so the crop has real detail to work with — target a ~1400px-wide
        // result (roughly matching what the whole-image path already sends), capped
        // at 4x to avoid manufacturing fake detail out of a tiny crop.
        const scale = Math.min(4, Math.max(1, 1400 / finalExtract.width));
        const outBuf = await img
            .extract(finalExtract)
            .resize({ width: Math.round(finalExtract.width * scale), kernel: 'lanczos3' })
            .jpeg({ quality: 92 })
            .toBuffer();
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
// SPEED: per Apsara, this needs to finish in under 5 seconds. The single
// biggest cost in the old pipeline was locateDisplayBox running fully
// synchronously on gemini-3.6-flash (~12-16s/request BY ITSELF, benchmarked
// above) before Vision ever got a crop to read — that alone made 5s, or even
// 10s, structurally impossible no matter what ran after it. Two changes fix
// this:
//   1. locateDisplayBox now uses the lighter LOCATE_MODEL (see above) instead
//      of the heavyweight digit-reading model — finding a box is a coarser
//      task than reading exact digits.
//   2. The whole locate->crop->Vision-on-crop "accurate path" now runs under
//      a hard ACCURATE_PATH_BUDGET_MS timeout, racing against the whole-image
//      Vision OCR call that's kicked off immediately at the top (a single
//      Vision API call, no Gemini locate step first — much faster on its
//      own). Whichever is ready first and usable wins; the accurate path is
//      preferred when it makes the deadline since a tight, upscaled crop is a
//      cleaner read for a small/distant display, but this function no longer
//      waits past the budget for it.
// The old "Gemini self-consistency vote on the crop" fallback (3 more slow
// Gemini calls) has been dropped from the middle of the chain for the same
// reason — it only fired when Vision itself had nothing to read, which is
// rare, and it could add another 12-16s+ on top of everything else. The
// whole-image Gemini single-pass read remains as the final, rare last resort
// if BOTH Vision attempts come back empty.
async function extractWeightFromImage(imageBase64, mimeType = 'image/jpeg', retries = 2) {
    if (!imageBase64) throw new Error('imageBase64 required');
    const t0 = Date.now();
    const elapsed = () => `${Date.now() - t0}ms`;

    // Started now, awaited later — a single Vision OCR call on the whole
    // photo, no Gemini locate step first, so this is typically the FASTEST
    // usable reading available and acts as both the speed fallback and the
    // correctness fallback if locate fails outright.
    const wholeImageVisionPromise = visionOcr.detectText(imageBase64).catch((err) => {
        console.warn('[GEMINI] Whole-image Vision OCR failed:', err.message);
        return null;
    });

    // The more ACCURATE path — isolate the display, upscale it, then read it
    // with Vision — wrapped as one promise so it can be raced against a hard
    // time budget below instead of being awaited step-by-step with no limit.
    const accuratePathPromise = (async () => {
        const locateImg = await shrinkForLocate(imageBase64, mimeType);
        const box = await locateDisplayBox(locateImg, mimeType);
        if (process.env.DEBUG_WEIGHT_RAW) console.log('[DEBUG box]', JSON.stringify(box));
        if (!box) return null;

        const croppedBase64 = await cropToDisplay(imageBase64, mimeType, box);
        if (process.env.DEBUG_WEIGHT_RAW) console.log('[DEBUG cropped len]', croppedBase64 && croppedBase64.length);
        if (!croppedBase64) return null;

        // Kicked off together but not awaited together — the metadata call
        // (unit label / which-display reasoning) is non-essential and has
        // safe defaults below, so it shouldn't hold up the weight itself.
        const visionPromise = visionOcr.detectText(croppedBase64);
        const geminiMetaPromise = readWeightSinglePass(croppedBase64, 'image/jpeg', retries, { isCrop: true }).catch((err) => {
            console.warn('[GEMINI] Metadata read on crop failed:', err.message);
            return null;
        });

        const visionText = await visionPromise;
        if (process.env.DEBUG_WEIGHT_RAW) console.log('[DEBUG vision]', JSON.stringify({ visionText }));
        const visionWeight = visionOcr.extractWeightNumber(visionText);
        if (visionWeight == null) return null;
        return { visionWeight, visionText, box, geminiMetaPromise };
    })().catch((err) => {
        console.warn('[GEMINI] Crop-zoom accurate path failed:', err.message);
        return null;
    });

    const ACCURATE_PATH_BUDGET_MS = Number(process.env.ACCURATE_PATH_BUDGET_MS) || 4000;
    const accurate = await withTimeout(accuratePathPromise, ACCURATE_PATH_BUDGET_MS, 'Locate+crop accurate path');
    console.log(`[GEMINI] Accurate (cropped) path ${accurate ? 'ready' : 'not ready in time'} at ${elapsed()}`);

    if (accurate && accurate.visionWeight != null) {
        // Grab Gemini's metadata only if it's already finished, capped short
        // — a late result is discarded here but still resolves harmlessly in
        // the background thanks to the .catch() above.
        const geminiMeta = await withTimeout(accurate.geminiMetaPromise, 800, 'Gemini crop metadata (non-essential)');
        const disagreement = geminiMeta && geminiMeta.weight != null && geminiMeta.weight !== accurate.visionWeight
            ? ` [Gemini read this same crop as ${geminiMeta.weight} — Cloud Vision OCR is used as the primary source since it's read this display correctly and consistently in testing, Gemini has not]`
            : '';
        console.log(`[GEMINI] Weight read via Cloud Vision OCR (primary, cropped) in ${elapsed()}: ${accurate.visionWeight}${disagreement ? ' — disagreed with Gemini' : ''}`);
        return {
            weight: accurate.visionWeight,
            weight_unit: (geminiMeta && geminiMeta.weight_unit) || 'lb',
            displays_seen: (geminiMeta && geminiMeta.displays_seen) || `Cloud Vision OCR read of located display (locate reason: "${accurate.box.reason || ''}")`,
            raw_text: `${accurate.visionText} (Cloud Vision OCR)${disagreement}`,
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
        };
    }

    console.warn(`[GEMINI] Vision OCR found nothing on either path by ${elapsed()}, falling back to Gemini single-pass read (last resort, will be slow)`);
    return readWeightSinglePass(imageBase64, mimeType, retries);
}

module.exports = { callGeminiJSON, extractPdfFields, extractBookingFieldsFromText, resolveCutoffDate, classifyDocument, extractScaleTicketFields, extractWeightFromImage };