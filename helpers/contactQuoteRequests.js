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
// leg shape (mirrors helpers/quoteRequests.js's lane-leg shape, keyed by
// recipient_name instead of trucker_name):
//   { recipient_name, channel: 'whatsapp_group'|'whatsapp_individual'|'email', target, target_label,
//     status: 'awaiting_reply'|'price_received'|'no_response_escalated'|'send_failed',
//     sent_at, last_reply_at, last_reply_text, reminders_sent, price, failed_reason }
//
// MULTI-RECIPIENT (2026-08-18, per Apsara: "comparing buyer offers
// side-by-side is something you actually need") — legs can now hold MORE
// THAN ONE recipient per request ("quote to Eccomelt and MetalCo for..."),
// same forward-compatible array this always was. This is why every leg
// mutator below is keyed by `recipient_name`, not `channel` as it used to
// be: with 2+ recipients in one request, two of them can easily share a
// channel type (both reached by email, say), so `channel` alone stopped
// being a safe unique key the moment more than one leg became real instead
// of theoretical. `request.recipient_name` (singular field, kept for
// backward-compat/display) is now a joined summary of every leg's name —
// see createContactQuoteRequest below — while every per-leg alert/lookup
// uses `leg.recipient_name`, the actually-unique identity.

const crypto = require('crypto');
const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');
const { getContactsByName } = require('./contacts');
const { classifyQuoteReply, resolveTruckerChannel } = require('./quoteRequests'); // reuse, don't fork — see header

const loadContactQuoteRequests = () => loadJson(cfg.CONTACT_QUOTE_REQUESTS_FILE, []);

// ── Recipient resolution — helpers/contacts.js, trucker-style channel pick ──
// Mirrors workflow/quoteRequests.js's resolveTruckerNames in spirit (exact
// name match wins; 2+ matches is ambiguous, ask; 0 matches is not-found).
// Synchronous and single-name — workflow/actions.js's startContactQuoteRequestFlow
// calls this once PER recipient (splitting "X and Y" itself, same pattern as
// the trucker flow's splitQuoteNames) rather than this function taking a list,
// so each recipient gets its own independent resolved/ambiguous/not-found
// verdict.
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
// legs: [{ name, channel, target, target_label }, ...] — one entry per
// ALREADY-RESOLVED recipient (workflow/actions.js's startContactQuoteRequestFlow
// resolves each name via resolveQuoteContact before calling this; this
// function does no name resolution of its own, same division of
// responsibility as the lane/trucker flow). request.recipient_name is kept
// as a joined summary of every leg's name, purely for display (dashboard
// title, old single-recipient callers) — anything that needs to identify
// ONE specific leg must use leg.recipient_name, the actually-unique key.
async function createContactQuoteRequest({ recipientQuery, details, legs, askedByChat }) {
    if (!Array.isArray(legs) || !legs.length) {
        throw new Error('at least one resolvable recipient (whatsapp and/or email) is required');
    }
    const request = {
        id: crypto.randomUUID(),
        recipient_query: String(recipientQuery).trim(),
        recipient_name: legs.map((l) => l.name).join(', '),
        details: String(details || '').trim(),
        created_at: new Date().toISOString(),
        asked_by_chat: askedByChat || null,
        status: 'active',
        legs: legs.map((l) => ({
            recipient_name: l.name,
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
// keyed by recipient_name (2026-08-18: `channel` stopped being a safe
// unique key once a request could hold more than one leg — see this file's
// header). ──────────────────────────────────────────────────────────────
async function markLegSent(requestId, recipientName, extra = {}) {
    let updated = null;
    await mutateJson(cfg.CONTACT_QUOTE_REQUESTS_FILE, [], (list) => {
        const request = list.find((r) => r.id === requestId);
        if (!request) return list;
        const leg = request.legs.find((l) => l.recipient_name === recipientName);
        if (!leg) return list;
        Object.assign(leg, extra, { sent_at: new Date().toISOString() });
        updated = leg;
        return list;
    });
    return updated;
}

async function markLegFailed(requestId, recipientName, reason) {
    await mutateJson(cfg.CONTACT_QUOTE_REQUESTS_FILE, [], (list) => {
        const request = list.find((r) => r.id === requestId);
        if (!request) return list;
        const leg = request.legs.find((l) => l.recipient_name === recipientName);
        if (!leg) return list;
        leg.status = 'send_failed';
        leg.failed_reason = reason || null;
        leg.failed_at = new Date().toISOString();
        return list;
    });
}

async function recordReminderSent(requestId, recipientName, stage) {
    await mutateJson(cfg.CONTACT_QUOTE_REQUESTS_FILE, [], (list) => {
        const request = list.find((r) => r.id === requestId);
        if (!request) return list;
        const leg = request.legs.find((l) => l.recipient_name === recipientName);
        if (!leg) return list;
        leg.reminders_sent.push({ stage, at: new Date().toISOString() });
        return list;
    });
}

async function markLegEscalated(requestId, recipientName) {
    await mutateJson(cfg.CONTACT_QUOTE_REQUESTS_FILE, [], (list) => {
        const request = list.find((r) => r.id === requestId);
        if (!request) return list;
        const leg = request.legs.find((l) => l.recipient_name === recipientName);
        if (!leg) return list;
        leg.status = 'no_response_escalated';
        return list;
    });
}

async function recordLegReply(requestId, recipientName, text) {
    const classification = classifyQuoteReply(text);
    let updatedLeg = null;
    await mutateJson(cfg.CONTACT_QUOTE_REQUESTS_FILE, [], (list) => {
        const request = list.find((r) => r.id === requestId);
        if (!request) return list;
        const leg = request.legs.find((l) => l.recipient_name === recipientName);
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
