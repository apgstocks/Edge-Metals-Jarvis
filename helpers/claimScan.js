// ── helpers/claimScan.js — a scanned claim document becomes a filled-in form ──
//
// Apsara, 2026-10-03: "Add a scan page in claim sheet. When i scan pass it
// across the model, and fill all the details by itself."
//
// What gets scanned is whatever the customer actually sent: a surveyor's outturn
// report, a debit note, a weighbridge slip, a printed email, a photo of a page
// held up to a phone. So this is its own extractor rather than a branch inside
// extractPdfFields or extractScaleTicketFields — different schema, and a
// different failure mode again: a photographed page is blurry, angled and
// cropped far more often than a clean PDF.
//
// ── THE HONEST LIMIT, STATED UP FRONT ───────────────────────────────────────
// The mail path can prove its own work: it has the email text, so a quote the
// model returns is checked against that text and a field whose quote is not
// really there is dropped. A scan has no such text — the model IS the reader.
// There is nothing here to check a quote against.
//
// So this does NOT pretend to be grounded. It returns, for every field, the
// words it says it read, and the page shows them beside the figure so a person
// can check each one against the document in front of them. The human is the
// verification step, and the UI says so. Claiming grounding that cannot be
// performed would be worse than having none.
//
// Everything else holds as it does everywhere else in claims: the unit is never
// inferred, and nothing here creates a confirmed claim or a money figure.
const cfg = require('../config');
const gemini = require('./gemini');
const claims = require('./claims');
const claimKind = require('./claimKind');

// The smart tier, not the workhorse. Someone added GEMINI_MODEL_CLAIMS on
// 2026-10-02 for exactly this: "anything where being wrong costs money". Reading
// a weight and a UNIT off a photographed page is the sharpest case of it in the
// whole app — misread the unit and a supplier gets billed 2204 times over.
const MODEL = () => cfg.GEMINI_MODEL_CLAIMS || cfg.GEMINI_MODEL_SMART || undefined;

const OK_IMAGE = /^image\/(jpeg|jpg|png|webp|heic|heif)$/i;
const OK_PDF = /^application\/pdf$/i;

const FIELDS = `{
  "doc_type": null,          // what this document IS: "surveyor report", "debit note", "claim email", "weighbridge ticket", "packing list", "other"
  "customer": null,          // the company claiming the money (usually whoever issued this document)
  "supplier": null,          // the supplier the material came from, ONLY if the document names one
  "invoice_no": null,        // the seller's invoice number the claim is against, e.g. 26JY05, 26MK25
  "container_no": null,      // ISO container number, four letters then seven digits
  "invoice_weight": null,    // the weight that was invoiced/shipped, as a bare number
  "claimed_weight": null,    // the weight actually received/outturned, as a bare number
  "weight_unit": null,       // "MT", "KG" or "LB" — ONLY if the document says it in words or a symbol
  "stated_claim_amount": null, // the money amount being claimed, as a bare number
  "currency": null,          // "USD", "INR" etc, only if stated
  "date": null,              // the document's own date, as printed
  "what_is_claimed": null    // one short sentence, in the document's own terms, saying what went wrong
}`;

function buildPrompt() {
    return [
        'You are reading one document that a scrap-metal buyer has sent to its seller to claim money back on a shipment. It may be a surveyor or outturn report, a debit note, a printed email, a weighbridge slip, or a photograph of any of those.',
        '',
        'Read it and return ONLY raw JSON — no markdown, no prose:',
        '{',
        '  "is_claim_document": true or false,',
        `  "fields": ${FIELDS},`,
        '  "quotes": { "<field name>": "<the words on the document you read that field from, copied as printed>" },',
        '  "unreadable": ["<field names you could not read because the image is blurry, cropped or glared>"],',
        '  "confidence": 0.0 to 1.0,',
        '  "why": "<one short sentence on what this document is>"',
        '}',
        '',
        'Rules:',
        '1. Report only what the document shows. Anything not on it is null. Never infer a value from another field, and never carry one over from your general knowledge of such documents.',
        '2. NEVER convert, add or subtract. If two weights are shown, report both as printed; do not work out the difference.',
        '3. weight_unit must be null unless the document states it (MT, metric ton, tonne, KG, kilos, LB, lbs, pounds). A number with no unit beside it has NO unit. This matters more than any other field — a guess between tonnes and pounds is wrong by a factor of 2204.',
        '4. For every non-null field put the words you read it from in "quotes", copied as printed, at most 100 characters. A person will check these against the document, so they must be what is actually written, not a paraphrase.',
        '5. If the page is too blurry or cropped to read a field, put that field in "unreadable" and leave it null. Say so rather than guessing — a wrong figure here becomes a claim against a supplier.',
        '6. Weights and money are bare numbers: 21.582 not "21.582 MT", 4113.08 not "$4,113.08".',
        '',
        'Set is_claim_document false for a bill of lading, a packing list with no complaint, an invoice being sent for payment, or anything that is not somebody claiming money back.',
    ].join('\n');
}

const asNum = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(/[$,\s]/g, ''));
    return Number.isFinite(n) ? n : null;
};
const asUnit = (v) => {
    const t = String(v == null ? '' : v).trim().toUpperCase();
    if (['MT', 'METRIC TON', 'METRIC TONS', 'TONNE', 'TONNES', 'TON', 'TONS'].includes(t)) return 'MT';
    if (['KG', 'KGS', 'KILO', 'KILOS', 'KILOGRAM', 'KILOGRAMS'].includes(t)) return 'KG';
    if (['LB', 'LBS', 'POUND', 'POUNDS'].includes(t)) return 'LB';
    return null;
};
const clean = (v, n = 120) => String(v == null ? '' : v).trim().slice(0, n);
const CONTAINER_RE = /\b([A-Z]{4})\s?-?\s?(\d{7})\b/;

const MIN_CONFIDENCE = Number(process.env.CLAIM_SCAN_MIN_CONFIDENCE || 0.35);

// Returns { ok, fields, quotes, unreadable, docType, confidence, why, kind, existing }
// or { ok:false, reason }. Never throws.
async function scan({ base64, mimeType = 'image/jpeg', retries = 2 } = {}) {
    if (!base64) return { ok: false, reason: 'no file was sent' };
    if (!OK_IMAGE.test(mimeType) && !OK_PDF.test(mimeType)) {
        return { ok: false, reason: `${mimeType} is not something this can read — send a photo or a PDF` };
    }

    let raw = null, lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            const model = gemini.getClient().getGenerativeModel({
                model: MODEL() || gemini.getModelName(),
                generationConfig: { temperature: 0, responseMimeType: 'application/json' },
            });
            const result = await model.generateContent([
                { text: buildPrompt() },
                { inlineData: { mimeType, data: base64 } },
            ]);
            raw = gemini.extractJson(result.response.text());
            if (raw) break;
        } catch (err) {
            lastErr = err;
            const transient = /503|429|overloaded|unavailable|high demand/i.test(err.message || '');
            if (attempt < retries && transient) { await new Promise((r) => setTimeout(r, 1200 * (attempt + 1))); continue; }
            break;
        }
    }
    if (!raw) return { ok: false, reason: lastErr ? `the model could not read it (${lastErr.message})` : 'the model did not answer' };
    if (raw.is_claim_document === false) {
        return { ok: false, reason: `that does not look like a claim document${raw.why ? ` — ${raw.why}` : ''}`, why: clean(raw.why, 200) };
    }

    const confidence = Number(raw.confidence);
    const f = raw.fields || {};
    const quotes = {};
    for (const [k, v] of Object.entries(raw.quotes || {})) { const q = clean(v, 100); if (q) quotes[k] = q; }

    const contRaw = String(f.container_no || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const contMatch = `${f.container_no || ''}`.toUpperCase().match(CONTAINER_RE);
    const container_no = /^[A-Z]{4}\d{7}$/.test(contRaw) ? contRaw : (contMatch ? contMatch[1] + contMatch[2] : '');

    const fields = {
        customer: clean(f.customer, 80),
        supplier: clean(f.supplier, 80),
        invoice_no: clean(f.invoice_no, 40),
        container_no,
        invoice_weight: asNum(f.invoice_weight),
        claimed_weight: asNum(f.claimed_weight),
        weight_unit: asUnit(f.weight_unit),
        stated_claim_amount: asNum(f.stated_claim_amount),
        currency: clean(f.currency, 8),
        date: clean(f.date, 30),
        what_is_claimed: clean(f.what_is_claimed, 200),
    };

    // What kind of claim, named by the model from the document's own words — the
    // same classifier the sheet import and the mail path use, so a scan does not
    // invent a vocabulary of its own.
    let kind = { slug: null, unresolved: 'not asked' };
    const kindText = [fields.what_is_claimed, clean(f.doc_type, 40), ...Object.values(quotes)].filter(Boolean).join(' | ');
    if (kindText) { try { kind = await claimKind.decide(kindText); } catch (e) { kind = { slug: null, unresolved: e.message }; } }

    // Does this container already have a claim? Scanning the surveyor's report
    // for a claim that arrived by mail last week must not make a second one.
    let existing = null;
    if (fields.invoice_no || fields.container_no) {
        const hit = claims.findByKey(fields.invoice_no, fields.container_no)
            || claims.list().find((c) => c && fields.container_no && String(c.container_no || '').toUpperCase() === fields.container_no);
        if (hit) existing = { id: hit.id, invoice_no: hit.invoice_no, container_no: hit.container_no, customer: hit.customer, status: hit.status, claim_amount: hit.claim_amount };
    }

    return {
        ok: true,
        docType: clean(f.doc_type, 40) || 'claim document',
        fields, quotes,
        unreadable: Array.isArray(raw.unreadable) ? raw.unreadable.map((x) => clean(x, 40)).filter(Boolean) : [],
        confidence: Number.isFinite(confidence) ? confidence : null,
        lowConfidence: Number.isFinite(confidence) && confidence < MIN_CONFIDENCE,
        why: clean(raw.why, 200),
        kind,
        existing,
        // Said out loud, because it is the difference between this and the mail
        // path and the page repeats it to her.
        verification: 'read from the scan — every figure below is the model\'s reading of the document, not a checked fact. Compare each one against the page before creating the claim.',
    };
}

module.exports = { scan, buildPrompt, asUnit, asNum, OK_IMAGE, OK_PDF, MIN_CONFIDENCE, MODEL };
