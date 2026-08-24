// ── helpers/proformaFromEmail.js — read an order out of an email ─────────────
//
// Apsara, 2026-08-23: "Check mail from Joey and send proforma to her — it
// should check mail and prepare proforma according to that."
//
// WHAT THIS IS NOT DOING, because most of it was already built.
//
// workflow/replyWatch.js (her rework, 2026-08-22) already reads arbitrary
// inbound mail, strips quoted history and signatures via email-reply-parser,
// and puts a schema'd Gemini judgement over the clean text. This file does not
// repeat any of that. It reuses extractLatestMessage() for the body and
// follows assess()'s exact shape — callGeminiJSON with a zod schema, then
// normalise every field by hand so the result does not depend on whether an
// optional package happens to be installed.
//
// All that is genuinely new here is the SCHEMA: a purchase order has fields a
// reply-assessment does not care about (material, quantity, rate, currency,
// incoterms), and pulling those out is a different question from "is someone
// waiting on me".
//
// CONFIDENCE IS LOAD-BEARING, NOT DECORATION.
//
// replyWatch holds low-confidence items back rather than pinging about them.
// The same discipline matters more here, because the output is a priced
// document going to a customer. A model that has half-guessed a rate from an
// ambiguous email must say so, and the caller must be able to tell the
// difference between "the email says $340/MT" and "there is a 340 in here
// somewhere". So every field carries its own confidence, and anything the
// email does not actually state comes back null rather than inferred.
//
// Nothing in this file sends anything. It returns a draft for a human to look
// at — see workflow/actions.js's proforma flow for the confirmation step.

const { callGeminiJSON } = require('./gemini');

// zod, loaded defensively — same posture as replyWatch.js. A missing package
// degrades to unvalidated JSON that the normaliser below still cleans up; it
// never crashes the command.
let OrderSchema = null;
try {
    const { z } = require('zod');
    OrderSchema = z.object({
        is_order: z.coerce.boolean(),
        confidence: z.coerce.number().min(0).max(1).optional().default(0),
        consignee: z.string().nullable().optional().default(null),
        currency: z.string().nullable().optional().default(null),
        trade_terms: z.string().nullable().optional().default(null),
        port_discharge: z.string().nullable().optional().default(null),
        payment_term: z.string().nullable().optional().default(null),
        container_count: z.coerce.number().nullable().optional().default(null),
        items: z.array(z.object({
            desc: z.string(),
            qty: z.coerce.number().nullable().optional().default(null),
            rate: z.coerce.number().nullable().optional().default(null),
            rate_confidence: z.coerce.number().min(0).max(1).optional().default(0),
            rate_basis: z.enum(['per_mt', 'per_lot', 'unknown']).optional().default('unknown'),
        })).optional().default([]),
        missing: z.array(z.string()).optional().default([]),
        note: z.string().nullable().optional().default(null),
    });
} catch (e) {
    console.warn('[PROFORMA-MAIL] zod not installed — Gemini output will be normalised without schema validation.');
}

function buildOrderPrompt({ from, subject, body, date }) {
    return `You are reading ONE email sent to a scrap-metal exporter, deciding whether it is asking for a PROFORMA INVOICE (a priced quote for a shipment) and, if so, pulling out exactly what it states.

FROM: ${from || '(unknown)'}
DATE: ${date || '(unknown)'}
SUBJECT: ${subject || '(none)'}

BODY:
"""
${String(body || '').slice(0, 6000)}
"""

Return JSON only.

is_order: true ONLY if the sender is asking to buy material, asking for a proforma/PI, confirming an order, or giving quantities and/or prices for a shipment they want. false for a general enquiry with no material or quantity, a reply about an EXISTING shipment, an invoice or payment message, or marketing.

THE RULE THAT MATTERS MOST: report only what the email ACTUALLY STATES. Never infer, complete, or tidy up a number. If the email does not give a rate, rate is null — do not carry one over from a price list, a previous order, or your own sense of what scrap costs. A null is useful; a plausible invention is dangerous, because this becomes a priced document sent to this customer.

consignee: the buying company as written, or null.
currency: "USD", "EUR" etc, only if stated. null otherwise.
trade_terms: e.g. "CIF Busan", "FOB Los Angeles", only if stated.
port_discharge: destination port/country, only if stated.
payment_term: e.g. "T/T 100% against shipping documents", only if stated.
container_count: number of containers, only if stated as a number.

items: one entry per distinct material.
  desc: the material as the sender wrote it ("auto cast", "aluminium combo").
  qty: metric tonnes for that material if stated, else null.
  rate: the price figure as written, whatever basis it is on. null if none.
  rate_basis: "per_mt" if that figure is plainly a price PER METRIC TONNE. "per_lot" if it is a total for the shipment, the container, or the whole order. "unknown" if the email does not make the basis clear. Be honest here rather than helpful — "unknown" is a perfectly good answer and is much safer than a wrong guess, because a per-lot figure used as a per-tonne rate multiplies the invoice by the tonnage.
  rate_confidence: 0.0-1.0, how sure you are of the FIGURE itself (not its basis). Use 0.9+ only when the email plainly ties that number to that material.

WHEN AN EMAIL CONTAINS SEVERAL PRICES: a message may quote a price to the end buyer, subtract agent commissions, and then state what WE receive ("your price is X"). The figure that belongs on our proforma is the one presented as ours. Put that in rate, and say in note what the other figures were and why you chose this one, so a human can check the choice.

missing: field names a proforma needs that this email does not give, from: consignee, material, quantity, rate, trade_terms, port_discharge, container_count.
note: one short sentence on anything a human should check — an ambiguous number, a total-vs-unit price, two materials sharing one price. null if nothing.
confidence: 0.0-1.0 overall, how sure you are this is an order and you read it correctly.

{ "is_order": false, "confidence": 0.0, "consignee": null, "currency": null, "trade_terms": null, "port_discharge": null, "payment_term": null, "container_count": null, "items": [], "missing": [], "note": null }`;
}

const num = (v) => {
    const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : null;
};

// Normalises by hand for the same reason assess() does: the shape must not
// depend on whether zod loaded.
async function extractOrderFromEmail(email) {
    const res = await callGeminiJSON(buildOrderPrompt(email), 2, OrderSchema);
    if (!res || typeof res.is_order === 'undefined') return null;
    const items = (Array.isArray(res.items) ? res.items : [])
        .map((it) => ({
            desc: String(it && it.desc || '').trim(),
            qty: num(it && it.qty),
            rate: num(it && it.rate),
            rate_confidence: typeof (it && it.rate_confidence) === 'number' ? it.rate_confidence : 0,
            rate_basis: ['per_mt', 'per_lot', 'unknown'].includes(it && it.rate_basis) ? it.rate_basis : 'unknown',
        }))
        .filter((it) => it.desc);
    return {
        is_order: res.is_order === true || res.is_order === 'true',
        confidence: typeof res.confidence === 'number' ? res.confidence : 0,
        consignee: res.consignee ? String(res.consignee).trim() : null,
        currency: res.currency ? String(res.currency).trim() : null,
        trade_terms: res.trade_terms ? String(res.trade_terms).trim() : null,
        port_discharge: res.port_discharge ? String(res.port_discharge).trim() : null,
        payment_term: res.payment_term ? String(res.payment_term).trim() : null,
        container_count: num(res.container_count),
        items,
        missing: Array.isArray(res.missing) ? res.missing.map(String) : [],
        note: res.note ? String(res.note).trim() : null,
    };
}

// Anything at or below this is treated as "I think I read this, but check it"
// rather than a usable figure. Deliberately generous — a rate is the one field
// where being wrong is expensive, and the cost of asking is one message.
const RATE_TRUST = 0.75;

// Turns an extraction into the payload helpers/proformaPdf.js already accepts,
// filling only what the email actually said and reporting what it did not.
// Rates below RATE_TRUST are stripped out and listed as unconfirmed, so a
// half-read number can never quietly become a price on the document.
function toProformaDraft(order, { fallbackConsignee } = {}) {
    const unconfirmed = [];
    const needs = [];
    const items = (order.items || []).map((it) => {
        // A rate is usable ONLY if we're confident of the figure AND it is
        // plainly per metric tonne. rate_basis was added 2026-08-24 after a
        // real email — "2 containers of auto casting tense at 2,450 ... Your
        // price is $2,420 CIF Busan" — where the model correctly picked 2,420,
        // scored it 0.9 confident, and said in its own note that it looked
        // like a LOT TOTAL rather than a per-tonne rate. Confidence alone
        // therefore passed it straight through. A per-lot figure used as a
        // per-tonne rate multiplies the invoice by the tonnage: 2,420 becomes
        // 2,420 x 21 x 2 containers = $101,640 for a $2,420 order.
        const basis = it.rate_basis || 'unknown';
        const figureOk = it.rate != null && it.rate_confidence >= RATE_TRUST;
        const trusted = figureOk && basis === 'per_mt';
        if (it.rate != null && !trusted) {
            unconfirmed.push(basis === 'per_lot'
                ? `${it.desc}: "${it.rate}" reads as a total for the lot, not a per-MT rate`
                : basis === 'unknown'
                    ? `${it.desc}: "${it.rate}" — the email doesn't make clear whether that's per MT or a total`
                    : `${it.desc}: read "${it.rate}" but not confidently`);
        }
        // NEVER invent a quantity. The first version defaulted a missing qty
        // to 21 MT, which silently turned "the email doesn't say how much"
        // into a priced line on a document going to a customer.
        if (it.qty == null) needs.push('quantity');
        return { desc: it.desc, qty: it.qty, rate: trusted ? it.rate : 0 };
    });
    if (!items.length) needs.push('material');
    if (items.some((i) => !i.rate)) needs.push('rate');
    if (!(order.consignee || fallbackConsignee)) needs.push('consignee');
    // The model's own "missing" list is authoritative too — it said qty was
    // missing on that same real email while the code cleared needs to empty
    // and offered to send. Trusting only our own derived checks threw away a
    // signal the model had already given us.
    // ...but never let it contradict direct evidence. On the real Daekwang
    // email the model listed "material" as missing while the email plainly
    // said "auto casting tense" and we had it in items — it seems to have
    // meant the GRADE was underspecified. Reporting "missing: material" to
    // someone looking at an email that names the material reads as a bug and
    // teaches her to distrust the whole list. So a model claim is only
    // accepted where our own check hasn't already settled the question.
    const MAP = { qty: 'quantity', quantity: 'quantity', rate: 'rate', price: 'rate', material: 'material', consignee: 'consignee' };
    const haveMaterial = items.length > 0;
    const haveAllQty = items.length > 0 && items.every((i) => i.qty != null);
    const haveAllRates = items.length > 0 && items.every((i) => i.rate);
    for (const m of (order.missing || [])) {
        const k = MAP[String(m).toLowerCase()];
        if (!k) continue;
        if (k === 'material' && haveMaterial) continue;
        if (k === 'quantity' && haveAllQty) continue;
        if (k === 'rate' && haveAllRates) continue;
        needs.push(k);
    }
    return {
        consignee: order.consignee || fallbackConsignee || '',
        containerCount: order.container_count && order.container_count > 0 ? Math.round(order.container_count) : 1,
        items,
        trade_terms: order.trade_terms || '',
        port_discharge: order.port_discharge || '',
        payment_term: order.payment_term || '',
        needs: [...new Set(needs)],
        unconfirmed,
        note: order.note || null,
        confidence: order.confidence,
    };
}

module.exports = { extractOrderFromEmail, toProformaDraft, buildOrderPrompt, RATE_TRUST };
