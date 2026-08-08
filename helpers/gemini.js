// ── helpers/gemini.js — Gemini JSON-only wrapper ─────────────────────────────
// One job: send prompt, get back parsed JSON or null. Never free text upstream.
// Model name comes from settings.json (hot-swappable) with env fallback.

const { GoogleGenerativeAI } = require('@google/generative-ai');
const cfg = require('../config');

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
// 'gemini-2.5-pro' 404'd as "no longer available to new users" — Google
// restricts model access per-account, confirmed via a live Google AI
// Developers Forum thread on this exact error (the model landscape has moved
// to a 3.x generation since; ai.google.dev's own docs now list gemini-3.6-flash
// and gemini-3.5-flash-lite as GA). Using gemini-3.1-flash-lite per Apsara.
// FALLBACK_VISION_MODEL is the one CONFIRMED working on this account already
// (extractPdfFields/classifyDocument use it successfully) — used automatically
// if the primary 404s as unavailable, so a model getting deprecated out from
// under this account doesn't silently break weight-reading again without at
// least degrading gracefully instead of hard-failing.
function getVisionModelName() {
    return process.env.GEMINI_VISION_MODEL || 'gemini-3.1-flash-lite';
}
const FALLBACK_VISION_MODEL = 'gemini-2.5-flash';
function isModelUnavailableError(err) {
    return /404|not found|no longer available|not supported/i.test(err.message || '');
}

async function extractWeightFromImage(imageBase64, mimeType = 'image/jpeg', retries = 2) {
    if (!imageBase64) throw new Error('imageBase64 required');

    const prompt = `You are an expert at reading digital scale (weighbridge) displays from photos — 7-segment LED, LCD, or similar digital readouts. Read the weight value shown as carefully as you would proofread a number you're about to bet money on.

Work through this deliberately:
1. Locate the main numeric readout on the display (ignore smaller secondary numbers like a tare-memory indicator, date/time, or button labels unless nothing else is present).
2. Read every digit left to right, one at a time. Segmented displays commonly cause confusion between: 8 and 0, 5 and 6, 1 and 7, 3 and 9 — look at which segments are actually lit before deciding, don't guess from overall shape alone.
3. Note the decimal point position exactly as shown, and any thousands separator.
4. Note the unit label if printed near the number (lb, kg, kgs, ton, tonnes, etc.) — units are often small text near a corner of the display.
5. If glare, blur, a bad angle, or partial occlusion makes any digit genuinely ambiguous, do not guess — return null for the whole weight rather than a half-confident wrong number. A missing reading that gets manually entered is far cheaper than a wrong one that goes uncaught.

Return ONLY raw JSON — no markdown, no prose:
{
  "weight": null,      // number only, decimal point preserved, no thousands separators, e.g. 42350 or 42350.5 — null if not confidently legible
  "weight_unit": null, // e.g. "lb", "kg", "ton" — null if no unit is visible
  "raw_text": null     // exactly what you read off the display as plain text before parsing, e.g. "42350 lb" — helps a human verify against the photo later. Still fill this in even if weight ends up null, describing what you saw and why it wasn't confident.
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

module.exports = { callGeminiJSON, extractPdfFields, extractBookingFieldsFromText, resolveCutoffDate, classifyDocument, extractScaleTicketFields, extractWeightFromImage };