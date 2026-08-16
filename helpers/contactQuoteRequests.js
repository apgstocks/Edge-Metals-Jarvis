// ── helpers/contactQuoteRequests.js — quote requests to any saved contact ────
// Built 2026-08-16 per Apsara: "these are just truckers. i want to have
// another tab where there is quote request and have whatsapp/email support
// for quote" — helpers/quoteRequests.js's "Quote Requests" tab only ever
// asks TRUCKERS for a haul price between two address-book lanes (origin →
// destination). This is a separate, parallel feature: ask any saved PERSON
// or COMPANY (a buyer like Eccomelt, a supplier, anyone with a saved
// contact) for a quote on something — a commodity/description, not a lane.
//
// RECIPIENT MODEL REBUILT 2026-08-16 (same day, later) per Apsara: "i should
// have quotes contact where i have separate group/whatsapp/email mimicking
// trucker implementation." The original version resolved a recipient by
// merging helpers/emailContacts.js + helpers/addressBook.js — that's gone.
// Recipients now come from helpers/contacts.js, a dedicated flat-JSON list
// shaped exactly like a trucker record (name, group_id, whatsapp, email,
// preferred_mode), which lets this reuse helpers/quoteRequests.js's
// resolveTruckerChannel UNCHANGED — same group_id → whatsapp → email
// fallback (or preferred_mode:'email' winning outright), same function, no
// fork. One resolved channel per contact, exactly like a trucker gets, not
// a dual email+WhatsApp candidate needing separate confirmation.
//
// DELIBERATELY A SEPARATE FILE/STORE, not a generalized version of
// helpers/quoteRequests.js — same reasoning helpers/emailContacts.js's own
// header gives for why IT is a separate file from truckers.json/
// suppliers.json despite overlapping names: "an email recipient list is its
// own concern, even where names overlap with operational contacts." This
// file imports classifyQuoteReply AND resolveTruckerChannel from
// helpers/quoteRequests.js (identical logic, no reason to fork either) but
// changes NOTHING there — the trucker lane-quote flow (already live, with
// real active requests and scheduled reminders) is untouched.
//
// Storage: own flat array, config.CONTACT_QUOTE_REQUESTS_FILE — same
// request/leg shape as helpers/quoteRequests.js (see that file's header),
// except origin_query/destination_query are replaced with recipient_query/
// details (a free-text commodity/ask description, not a lane).
//
// request shape:
//   { id, recipient_query, recipient_name, details, created_at, asked_by_chat,
//     status: 'active'|'closed', legs: [ legShape, ... ] }
// leg shape (same as helpers/quoteRequests.js's, minus trucker_name):
//   { channel: 'whatsapp_group'|'whatsapp_individual'|'email', target, target_label,
//     status: 'awaiting_reply'|'price_received'|'no_response_escalated'|'send_failed',
//     sent_at, last_reply_at, last_reply_text, reminders_sent, price, failed_reason }
// legs is still an array (one leg today, one contact per request) so the
// store/scheduling shape stays forward-compatible if multi-recipient asks
// are ever added, same as truckers' legs array.

const crypto = require('crypto');
const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');
const { getContactsByName } = require('./contacts');
const { classifyQuoteReply, resolveTruckerChannel } = require('./quoteRequests'); // reuse, don't fork — see header

const loadContactQuoteRequests = () => loadJson(cfg.CONTACT_QUOTE_REQUESTS_FILE, []);

// ── Recipient resolution — helpers/contacts.js, trucker-style channel pick ──
// Mirrors workflow/quoteRequests.js's resolveTruckerNames in spirit (exact
// name match wins; 2+ matches is ambiguous, ask; 0 matches is not-found) but
// synchronous and single-name, since contact-quote's command grammar
// ("quote to X for Y") only ever names one recipient per ask today.
//
// Returns:
//   { type: 'resolved', name, channel, target }          — ready to dispatch
//   { type: 'resolved_no_channel', name }                 — contact exists but has no group/whatsapp/email on file
//   { type: 'ambiguous', matches: [{name, ...}] }          — caller must ask which one
//   { type: 'not_found' }                                  — no saved contact matches
function resolveQuoteContact(query) {
    const raw = String(query || '').trim();
    if (!raw) return { type: 'not_found' };

    const matches = getContactsByName(raw);
    if (!matches.length) return { type: 'not_found' };
    if (matches.length > 1) return { type: 'ambiguous', matches };

    const contact = matches[0];
    const channel = resolveTruckerChannel(contact); // {channel, target} | null — same function truckers use
    if (!channel) return { type: 'resolved_no_channel', name: contact.name };

    return { type: 'resolved', name: contact.name, channel: channel.channel, target: channel.target };
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
