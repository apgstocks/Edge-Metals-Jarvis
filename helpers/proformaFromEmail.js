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
  rate: price per MT if stated, else null. A total price for a lot is NOT a rate — leave rate null and say so in note.
  rate_confidence: 0.0-1.0. Use 0.9+ only when the email plainly ties that number to that material as a per-unit price. Use below 0.5 when a number is present but the link to the material or the unit is ambiguous.

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
    const items = (order.items || []).map((it) => {
        const trusted = it.rate != null && it.rate_confidence >= RATE_TRUST;
        if (it.rate != null && !trusted) unconfirmed.push(`${it.desc}: read "${it.rate}" but not clearly a per-MT price`);
        return { desc: it.desc, qty: it.qty ?? 21, rate: trusted ? it.rate : 0 };
    });
    const needs = [];
    if (!items.length) needs.push('material');
    if (items.some((i) => !i.rate)) needs.push('rate');
    if (!(order.consignee || fallbackConsignee)) needs.push('consignee');
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
