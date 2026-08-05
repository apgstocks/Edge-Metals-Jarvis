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
module.exports = { callGeminiJSON, extractPdfFields, extractBookingFieldsFromText, resolveCutoffDate, classifyDocument };