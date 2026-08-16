// ── helpers/contactQuoteRequests.js — quote requests to any saved contact ────
// Built 2026-08-16 per Apsara: "these are just truckers. i want to have
// another tab where there is quote request and have whatsapp/email support
// for quote" — helpers/quoteRequests.js's "Quote Requests" tab only ever
// asks TRUCKERS for a haul price between two address-book lanes (origin →
// destination). This is a separate, parallel feature: ask any saved PERSON
// or COMPANY (a buyer like Eccomelt, a supplier, anyone with a saved
// contact) for a quote on something — a commodity/description, not a lane —
// over WhatsApp and/or email.
//
// DELIBERATELY A SEPARATE FILE/STORE, not a generalized version of
// helpers/quoteRequests.js — same reasoning helpers/emailContacts.js's own
// header gives for why IT is a separate file from truckers.json/
// suppliers.json despite overlapping names: "an email recipient list is its
// own concern, even where names overlap with operational contacts." Two
// concrete reasons this matters here, not just style:
//   1. Recipient resolution is fundamentally different — trucker legs
//      resolve through workflow/truckers.js (Supabase); contact legs here
//      resolve through helpers/emailContacts.js AND helpers/addressBook.js
//      (flat JSON), matched against BOTH per Apsara's explicit answer.
//   2. Generalizing the trucker file in place would risk regressing the
//      lane-quote flow that was JUST fixed (see workflow/brain.js's
//      parseGetQuoteCommand, 2026-08-16 fix) — this file imports
//      classifyQuoteReply from helpers/quoteRequests.js (identical price-
//      detection logic, no reason to fork it) but changes NOTHING there.
//
// Storage: own flat array, config.CONTACT_QUOTE_REQUESTS_FILE — same
// request/leg shape as helpers/quoteRequests.js (see that file's header),
// except origin_query/destination_query are replaced with recipient_query/
// details (a free-text commodity/ask description, not a lane), and legs are
// keyed by CHANNEL for one resolved recipient (whatsapp + email can both be
// "legs" of the same ask to the same person) rather than one leg per
// different trucker.
//
// request shape:
//   { id, recipient_query, recipient_name, details, created_at, asked_by_chat,
//     status: 'active'|'closed', legs: [ legShape, ... ] }
// leg shape (same as helpers/quoteRequests.js's, minus trucker_name):
//   { channel: 'whatsapp'|'email', target, target_label,
//     status: 'awaiting_reply'|'price_received'|'no_response_escalated'|'send_failed',
//     sent_at, last_reply_at, last_reply_text, reminders_sent, price, failed_reason }

const crypto = require('crypto');
const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');
const { resolveContact } = require('./emailContacts');
const { resolveAddress } = require('./addressBook');
const { classifyQuoteReply } = require('./quoteRequests'); // reuse, don't fork — see header

const loadContactQuoteRequests = () => loadJson(cfg.CONTACT_QUOTE_REQUESTS_FILE, []);

// ── Recipient resolution — checks BOTH directories, merges channels ────────
// Per Apsara 2026-08-16: "Match for email,whatsapp in both email contact,
// address book" — a query like "Eccomelt" should find the saved email (from
// emailContacts' domain-group resolution, e.g. Audrey Meador as primary +
// cc) AND, separately, whatever's in the address book (raw address block +
// optional `mobile` field) for the same name, then offer whichever
// channel(s) actually have something usable rather than requiring both.
//
// mobile IS SURFACED AS A CANDIDATE, NOT TRUSTED OUTRIGHT — addressBook.js's
// own header is explicit that `mobile` is "just a reference number to have
// on hand alongside the address... not something the app dials or builds a
// WhatsApp chatId from." Address-book entries are typed in from a running
// Google Doc / freight paperwork and frequently ARE office/landline numbers,
// not personal WhatsApp numbers. Rather than silently trusting every
// digit-string as a real WhatsApp target (a real risk: firing a quote ask at
// a company's front-desk landline), this only offers it as `whatsapp_candidate`
// when it digit-strips to something phone-shaped (10-15 digits).
//
// `verified` reflects addressBook.js's entry.whatsapp_verified flag — set via
// the "Verify WhatsApp" button on the Address Book dashboard page (2026-08-16
// per Apsara: "just have whatsapp verify button in phon[e] number"), NOT a
// per-request WhatsApp chat confirmation like earlier. workflow/
// contactQuoteRequests.js.buildLegsFromResolution only includes the WhatsApp
// leg when this is true — an unverified candidate is skipped entirely, with
// Apsara pointed at the dashboard to verify it once. Still "ask, don't
// guess," just moved from a per-message chat prompt to a one-time dashboard
// action, same as every other resolver's ambiguous-tier posture elsewhere in
// this codebase (resolveContact's ambiguous tier, LaneResolutionError, etc).
//
// Returns:
//   { type: 'resolved', name, email: {address}|null,
//     whatsapp_candidate: {digits, raw, verified}|null,
//     source: 'email_contacts'|'address_book'|'both' }
//   { type: 'ambiguous', matches: [...] }   — caller must ask which one
//   { type: 'not_found' }                    — nothing in either directory
function resolveQuoteContact(query) {
    const raw = String(query || '').trim();
    if (!raw) return { type: 'not_found' };

    const emailResult = resolveContact(raw); // exact | domain_default | single_partial | ambiguous | null
    const addressResult = resolveAddress(raw); // exact | partial | ambiguous | null

    if (emailResult?.type === 'ambiguous' || addressResult?.type === 'ambiguous') {
        const matches = [
            ...(emailResult?.type === 'ambiguous' ? emailResult.matches.map((m) => ({ kind: 'email', ...m })) : []),
            ...(addressResult?.type === 'ambiguous' ? addressResult.matches.map((m) => ({ kind: 'address', ...m })) : []),
        ];
        return { type: 'ambiguous', matches };
    }

    const emailContact = emailResult && emailResult.type !== 'ambiguous' ? emailResult.contact : null;
    const addressEntry = addressResult && addressResult.type !== 'ambiguous' ? addressResult.entry : null;

    if (!emailContact && !addressEntry) return { type: 'not_found' };

    let whatsappCandidate = null;
    if (addressEntry?.mobile) {
        const digits = String(addressEntry.mobile).replace(/\D/g, '');
        if (digits.length >= 10 && digits.length <= 15) {
            whatsappCandidate = { digits, raw: addressEntry.mobile, verified: !!addressEntry.whatsapp_verified };
        }
    }

    const name = emailContact?.displayName || emailContact?.name || addressEntry?.aliases?.[0] || raw;
    const source = emailContact && addressEntry ? 'both' : emailContact ? 'email_contacts' : 'address_book';

    return {
        type: 'resolved',
        name,
        email: emailContact ? { address: emailContact.email, cc: emailContact.cc || [] } : null,
        whatsapp_candidate: whatsappCandidate,
        source,
    };
}

// ── Message building ─────────────────────────────────────────────────────────
// Mirrors helpers/quoteRequests.js's buildQuoteMessage in spirit (short ask
// line, details block) but phrased for a general commodity/price ask rather
// than a haul lane — "can you share your current quote for ___" instead of
// "can you quote a haul from X to Y".
function buildContactQuoteMessage(request) {
    const lines = [`Hi — could you share your current quote for ${request.details}?`];
    lines.push('', 'Let us know your price and any terms/requirements on your end.');
    return lines.join('\n');
}
function buildReminderMessage(request, stage) {
    const ordinal = { 1: 'Just following up', 2: 'Following up again', 3: 'One more follow-up' }[stage] || 'Following up';
    return `${ordinal} on the quote request for ${request.details} — any price yet?`;
}

// ── Creating a request (data only — no sending, no scheduling) ─────────────
async function createContactQuoteRequest({ recipientQuery, recipientName, details, legs, askedByChat }) {
    if (!Array.isArray(legs) || !legs.length) {
        throw new Error('at least one resolvable channel (whatsapp and/or email) is required');
    }
    const request = {
        id: crypto.randomUUID(),
        recipient_query: String(recipientQuery).trim(),
        recipient_name: recipientName,
        details: String(details || '').trim(),
        created_at: new Date().toISOString(),
        asked_by_chat: askedByChat || null,
        status: 'active',
        legs: legs.map((l) => ({
            channel: l.channel,
            target: l.target,
            target_label: l.target_label || l.target,
            status: 'awaiting_reply',
            sent_at: null,
            last_reply_at: null,
            last_reply_text: null,
            reminders_sent: [],
            price: null,
            failed_reason: null,
        })),
    };
    await mutateJson(cfg.CONTACT_QUOTE_REQUESTS_FILE, [], (list) => { list.push(request); return list; });
    return request;
}

// ── Leg state updates — same shape/behavior as helpers/quoteRequests.js's,
// keyed by channel instead of trucker_name (only one leg per channel per
// request here, so channel is a unique-enough key). ──────────────────────
async function markLegSent(requestId, channel, extra = {}) {
    let updated = null;
    await mutateJson(cfg.CONTACT_QUOTE_REQUESTS_FILE, [], (list) => {
        const request = list.find((r) => r.id === requestId);
        if (!request) return list;
        const leg = request.legs.find((l) => l.channel === channel);
        if (!leg) return list;
        Object.assign(leg, extra, { sent_at: new Date().toISOString() });
        updated = leg;
        return list;
    });
    return updated;
}

async function markLegFailed(requestId, channel, reason) {
    await mutateJson(cfg.CONTACT_QUOTE_REQUESTS_FILE, [], (list) => {
        const request = list.find((r) => r.id === requestId);
        if (!request) return list;
        const leg = request.legs.find((l) => l.channel === channel);
        if (!leg) return list;
        leg.status = 'send_failed';
        leg.failed_reason = reason || null;
        leg.failed_at = new Date().toISOString();
        return list;
    });
}

async function recordReminderSent(requestId, channel, stage) {
    await mutateJson(cfg.CONTACT_QUOTE_REQUESTS_FILE, [], (list) => {
        const request = list.find((r) => r.id === requestId);
        if (!request) return list;
        const leg = request.legs.find((l) => l.channel === channel);
        if (!leg) return list;
        leg.reminders_sent.push({ stage, at: new Date().toISOString() });
        return list;
    });
}

async function markLegEscalated(requestId, channel) {
    await mutateJson(cfg.CONTACT_QUOTE_REQUESTS_FILE, [], (list) => {
        const request = list.find((r) => r.id === requestId);
        if (!request) return list;
        const leg = request.legs.find((l) => l.channel === channel);
        if (!leg) return list;
        leg.status = 'no_response_escalated';
        return list;
    });
}

async function recordLegReply(requestId, channel, text) {
    const classification = classifyQuoteReply(text);
    let updatedLeg = null;
    await mutateJson(cfg.CONTACT_QUOTE_REQUESTS_FILE, [], (list) => {
        const request = list.find((r) => r.id === requestId);
        if (!request) return list;
        const leg = request.legs.find((l) => l.channel === channel);
        if (!leg) return list;
        leg.last_reply_at = new Date().toISOString();
        leg.last_reply_text = text;
        if (classification.isPrice) {
            leg.status = 'price_received';
            leg.price = { amount: classification.amount, raw_text: classification.matchedText, received_at: leg.last_reply_at };
        }
        updatedLeg = leg;
        return list;
    });
    return { leg: updatedLeg, classification };
}

function findActiveLegByTarget(target) {
    const requests = loadContactQuoteRequests();
    const matches = [];
    for (const request of requests) {
        if (request.status !== 'active') continue;
        for (const leg of request.legs) {
            if (leg.target === target && leg.status === 'awaiting_reply') matches.push({ request, leg });
        }
    }
    return matches;
}

function findActiveEmailLegs() {
    const requests = loadContactQuoteRequests();
    const out = [];
    for (const request of requests) {
        if (request.status !== 'active') continue;
        for (const leg of request.legs) {
            if (leg.channel === 'email' && leg.status === 'awaiting_reply' && leg.email_thread_id) {
                out.push({ request, leg });
            }
        }
    }
    return out;
}

function getRequestById(requestId) {
    return loadContactQuoteRequests().find((r) => r.id === requestId) || null;
}

async function maybeCloseRequest(requestId) {
    let closed = false;
    await mutateJson(cfg.CONTACT_QUOTE_REQUESTS_FILE, [], (list) => {
        const request = list.find((r) => r.id === requestId);
        if (!request || request.status !== 'active') return list;
        if (request.legs.every((l) => l.status !== 'awaiting_reply')) {
            request.status = 'closed';
            closed = true;
        }
        return list;
    });
    return closed;
}

module.exports = {
    loadContactQuoteRequests,
    resolveQuoteContact,
    buildContactQuoteMessage, buildReminderMessage,
    createContactQuoteRequest,
    markLegSent, markLegFailed, recordReminderSent, markLegEscalated, recordLegReply,
    findActiveLegByTarget, findActiveEmailLegs, getRequestById, maybeCloseRequest,
};
