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
  "cutoff_date": null, "erd_date": null, "etd": null, "eta": null, "vessel_voyage": null,
  "container_size": null, "container_number": null, "shipper": null, "consignee": null, "buyer": null
}

etd = Estimated Time of Departure, eta = Estimated Time of Arrival — these are
two DIFFERENT dates, do not confuse them or copy one into the other; leave
either null if the email doesn't actually state it.

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
            if (fields) return fields;
            console.warn(`[GEMINI] Body extraction returned unparseable JSON (attempt ${attempt + 1})`);
        } catch (err) {
            console.error(`[GEMINI] Body extraction failed (attempt ${attempt + 1}):`, err.message);
            if (attempt < retries) await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
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
  "cutoff_date": null,      // MM/DD/YYYY format
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
                console.log(`[GEMINI] PDF extraction: bkg=${fields.booking_number || '?'} carrier=${fields.carrier || '?'}`);
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
module.exports = { callGeminiJSON, extractPdfFields ,extractBookingFieldsFromText   };