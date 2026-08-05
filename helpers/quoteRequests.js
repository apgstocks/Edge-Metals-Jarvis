// ── helpers/quoteRequests.js — multi-trucker quote-request data + logic ─────
// Built 2026-08-05 per Apsara: "get quote from LA to Richmond" should fan a
// quote ask out to one or more truckers — over whichever channel each one
// actually uses (WhatsApp group, WhatsApp DM, or email) — track each
// trucker's reply independently, and follow up on a fixed reminder schedule
// until a price comes back. This file holds the pure data/logic pieces
// (store, lane resolution, channel resolution, price detection, message
// building) — actually SENDING anything and scheduling reminder tasks is
// orchestration, deliberately kept in workflow/quoteRequests.js instead (same
// helpers/ vs workflow/ split as truckers.js/suppliers.js vs actions.js
// throughout this codebase).
//
// Storage: one row per quote request, each holding an array of per-trucker
// "legs" (one row per (request, trucker) pair — neither brain.json's
// pending_actions, which is one-slot-per-chat, nor tasks.json, which is
// fire-and-forget, models "N parallel outstanding asks belonging to one
// logical request", so this is its own flat-array store, same pattern as
// data/address_book.json).
//
// request shape:
//   { id, origin_query, destination_query, origin_entry_id, destination_entry_id,
//     created_at, asked_by_chat, status: 'active'|'closed',
//     legs: [ legShape, ... ] }
// leg shape:
//   { trucker_name, channel: 'whatsapp_group'|'whatsapp_individual'|'email',
//     target,                          // chatId or email address actually used
//     status: 'awaiting_reply'|'price_received'|'no_response_escalated',
//     sent_at, last_reply_at, last_reply_text,
//     reminders_sent: [ { stage, at } ],
//     price: { amount, raw_text, received_at } | null }

const crypto = require('crypto');
const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');
const { resolveAddress, loadAddressBook } = require('./addressBook');

// ── Storage ─────────────────────────────────────────────────────────────────
const loadQuoteRequests = () => loadJson(cfg.QUOTE_REQUESTS_FILE, []);

// ── Lane resolution — "LA" / "Richmond" → an address-book entry ────────────
// A small, hand-picked set of common freight-lane shorthand → the fuller
// name that's actually likely to appear inside a saved address's raw text.
// Deliberately tiny and easy to extend — NOT a general geocoder. Mirrors
// dashboard/index.html's normalizePol() in spirit (known abbreviation →
// canonical form) but for a different purpose (search expansion here, not
// group-key merging there).
const LANE_ABBREVIATIONS = {
    la: 'los angeles',
    lb: 'long beach',
    nyc: 'new york',
    ny: 'new york',
    sf: 'san francisco',
    sa: 'san antonio',
};

function expandLaneQuery(query) {
    const q = String(query || '').trim().toLowerCase();
    return LANE_ABBREVIATIONS[q] || q;
}

// Resolves a free-text lane query ("LA", "Rad Metal", "Richmond") against
// the address book. Alias matching (resolveAddress's exact/partial/ambiguous
// tiers) is tried FIRST since a real saved name should always win over a
// coincidental text match; only when NO alias matches at all does this fall
// back to searching every entry's raw address text for the (possibly
// abbreviation-expanded) query — this is what lets "Richmond" find "DRM Iron
// & Metal LLC" (whose raw address contains "Long Beach, CA 90815"... no —
// contains "Richmond" itself, e.g. Mazariegos/Advanced Atlantic Corp) even
// though nobody saved an alias literally called "Richmond".
// Returns the SAME shape as resolveAddress(): { type: 'exact'|'partial'|'ambiguous', entry|matches } | null
function resolveLaneEntry(query) {
    const raw = String(query || '').trim();
    if (!raw) return null;

    const aliasMatch = resolveAddress(raw);
    if (aliasMatch) return aliasMatch;

    const expanded = expandLaneQuery(raw);
    const book = loadAddressBook();
    const textMatches = book.filter((e) => String(e.raw || '').toLowerCase().includes(expanded));
    if (textMatches.length === 1) return { type: 'partial', entry: textMatches[0] };
    if (textMatches.length > 1) return { type: 'ambiguous', matches: textMatches };
    return null;
}

// ── Trucker channel resolution ──────────────────────────────────────────────
// group_id → whatsapp_group (whole group sees the ask); else whatsapp →
// whatsapp_individual (direct DM); else email → email (real send via
// helpers/gmail.js's getGmailWrite — same account draft_email/reply_email
// already send from). No channel at all → null, caller must skip this
// trucker rather than silently drop them without saying so.
function resolveTruckerChannel(trucker) {
    if (!trucker) return null;
    if (trucker.group_id) return { channel: 'whatsapp_group', target: trucker.group_id };
    if (trucker.whatsapp) {
        const digits = String(trucker.whatsapp).replace(/\D/g, '');
        if (digits) return { channel: 'whatsapp_individual', target: `${digits}@c.us` };
    }
    if (trucker.email) return { channel: 'email', target: trucker.email };
    return null;
}

// ── Price detection ──────────────────────────────────────────────────────────
// Freight quote replies are almost always just a dollar figure ("$450",
// "450", "500 flat", "1,200/load") — v1 is regex-only, no LLM call, since
// that covers the overwhelming majority of real replies at zero cost/latency
// and Apsara can correct/extend this from real examples as they come in
// (same "ship the simple version, fix from real data" discipline used
// throughout this session — see mergeEntries', resolveAddress's own history).
// Returns { isPrice, amount, matchedText } — amount is a number when
// parseable, null if a price-like phrase matched but the number itself
// couldn't be cleanly parsed (still isPrice: true — better to flag it for a
// human glance than silently drop a real quote).
const PRICE_PATTERNS = [
    /\$\s?([\d,]+(?:\.\d{1,2})?)/,                              // "$450", "$1,200.50"
    /\b([\d,]{2,}(?:\.\d{1,2})?)\s*(?:dollars|usd|flat|per\s?load|each|\/load)\b/i, // "500 dollars", "1200 flat", "900/load"
];
function classifyQuoteReply(text) {
    const clean = String(text || '').trim();
    if (!clean) return { isPrice: false, amount: null, matchedText: null };

    for (const pattern of PRICE_PATTERNS) {
        const m = clean.match(pattern);
        if (m) {
            const amount = parseFloat(m[1].replace(/,/g, ''));
            return { isPrice: true, amount: Number.isFinite(amount) ? amount : null, matchedText: m[0] };
        }
    }
    // Bare-number reply — a terse trucker just typing "450" with nothing
    // else. Only treat the WHOLE message as a price this way (not a number
    // buried in a longer sentence — that's much more likely to be a phone
    // number, a booking number, or something else entirely).
    const bareNumber = clean.match(/^\$?\s?([\d,]{2,}(?:\.\d{1,2})?)$/);
    if (bareNumber) {
        const amount = parseFloat(bareNumber[1].replace(/,/g, ''));
        return { isPrice: true, amount: Number.isFinite(amount) ? amount : null, matchedText: clean };
    }
    return { isPrice: false, amount: null, matchedText: null };
}

// ── Message building ─────────────────────────────────────────────────────────
// Mirrors Apsara's own real WhatsApp pattern (short ask line + full pickup/
// delivery address blocks pasted separately) rather than inventing a new
// format.
function buildQuoteMessage(request) {
    return [
        `Hi — can you quote a haul from ${request.origin_query} to ${request.destination_query}?`,
        '',
        'Pickup:',
        request.origin_raw,
        '',
        'Delivery:',
        request.destination_raw,
    ].join('\n');
}
function buildReminderMessage(request, stage) {
    const ordinal = { 1: 'Just following up', 2: 'Following up again', 3: 'One more follow-up' }[stage] || 'Following up';
    return `${ordinal} on the quote request for ${request.origin_query} → ${request.destination_query} — any price yet?`;
}

// ── Creating a request (data only — no sending, no scheduling) ─────────────
// Throws AmbiguousLaneError / AmbiguousLaneError-like plain errors with a
// `.matches`/`.query` payload so the caller (workflow/quoteRequests.js,
// eventually brain.js) can turn that into a disambiguation question instead
// of failing silently or guessing.
class LaneResolutionError extends Error {
    constructor(query, result) {
        super(result ? `"${query}" matches more than one saved address` : `"${query}" doesn't match anything in the address book`);
        this.query = query;
        this.matches = result && result.type === 'ambiguous' ? result.matches : [];
    }
}

function resolveOrThrow(query) {
    const result = resolveLaneEntry(query);
    if (!result) throw new LaneResolutionError(query, null);
    if (result.type === 'ambiguous') throw new LaneResolutionError(query, result);
    return result.entry;
}

// truckerLegs: [{ name, channel, target }] — already-resolved by the caller
// (workflow/quoteRequests.js resolves trucker names via workflow/truckers.js
// before calling this; keeping Supabase truckers lookups out of this
// helpers-layer file, consistent with truckers.js/suppliers.js owning that).
async function createQuoteRequest({ originQuery, destinationQuery, truckerLegs, askedByChat }) {
    const originEntry = resolveOrThrow(originQuery);
    const destinationEntry = resolveOrThrow(destinationQuery);
    if (!Array.isArray(truckerLegs) || !truckerLegs.length) {
        throw new Error('at least one trucker with a resolvable contact channel is required');
    }

    const request = {
        id: crypto.randomUUID(),
        origin_query: String(originQuery).trim(),
        destination_query: String(destinationQuery).trim(),
        origin_entry_id: originEntry.id,
        destination_entry_id: destinationEntry.id,
        origin_raw: originEntry.raw,
        destination_raw: destinationEntry.raw,
        created_at: new Date().toISOString(),
        asked_by_chat: askedByChat || null,
        status: 'active',
        legs: truckerLegs.map((t) => ({
            trucker_name: t.name,
            channel: t.channel,
            target: t.target,
            status: 'awaiting_reply',
            sent_at: null,
            last_reply_at: null,
            last_reply_text: null,
            reminders_sent: [],
            price: null,
        })),
    };
    await mutateJson(cfg.QUOTE_REQUESTS_FILE, [], (list) => { list.push(request); return list; });
    return request;
}

// ── Leg state updates ────────────────────────────────────────────────────────
// extra: optional fields merged onto the leg alongside sent_at — used for
// email legs to stash the Gmail threadId (returned by sendEmail) so
// pollEmailReplies can look up "did this specific thread get a reply" by id
// instead of re-searching the whole mailbox by name every poll.
async function markLegSent(requestId, truckerName, extra = {}) {
    let updated = null;
    await mutateJson(cfg.QUOTE_REQUESTS_FILE, [], (list) => {
        const request = list.find((r) => r.id === requestId);
        if (!request) return list;
        const leg = request.legs.find((l) => l.trucker_name === truckerName);
        if (!leg) return list;
        Object.assign(leg, extra, { sent_at: new Date().toISOString() });
        updated = leg;
        return list;
    });
    return updated;
}

async function recordReminderSent(requestId, truckerName, stage) {
    await mutateJson(cfg.QUOTE_REQUESTS_FILE, [], (list) => {
        const request = list.find((r) => r.id === requestId);
        if (!request) return list;
        const leg = request.legs.find((l) => l.trucker_name === truckerName);
        if (!leg) return list;
        leg.reminders_sent.push({ stage, at: new Date().toISOString() });
        return list;
    });
}

async function markLegEscalated(requestId, truckerName) {
    await mutateJson(cfg.QUOTE_REQUESTS_FILE, [], (list) => {
        const request = list.find((r) => r.id === requestId);
        if (!request) return list;
        const leg = request.legs.find((l) => l.trucker_name === truckerName);
        if (!leg) return list;
        leg.status = 'no_response_escalated';
        return list;
    });
}

// Records an incoming reply on a leg. If it's a price, marks the leg
// resolved (price_received) so the reminder chain stops nagging that
// trucker; if not, just records it for visibility — the reminder schedule
// keeps running on its original fixed timing (Apsara's spec is a fixed
// 30/60/90-minute schedule, not one that resets every time the trucker says
// something other than a number).
async function recordLegReply(requestId, truckerName, text) {
    const classification = classifyQuoteReply(text);
    let updatedLeg = null;
    await mutateJson(cfg.QUOTE_REQUESTS_FILE, [], (list) => {
        const request = list.find((r) => r.id === requestId);
        if (!request) return list;
        const leg = request.legs.find((l) => l.trucker_name === truckerName);
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

// Finds the request+leg an incoming message is a reply to — a chat is only
// ever "awaiting a price" for ONE active leg at a time in practice (a
// trucker doesn't usually have two live quote asks running simultaneously),
// so the first match wins; still returns ALL matches so the caller can warn
// instead of guessing if that assumption ever breaks.
function findActiveLegByTarget(target) {
    const requests = loadQuoteRequests();
    const matches = [];
    for (const request of requests) {
        if (request.status !== 'active') continue;
        for (const leg of request.legs) {
            if (leg.target === target && leg.status === 'awaiting_reply') matches.push({ request, leg });
        }
    }
    return matches;
}

// Every awaiting-reply email leg across every active request — what
// pollEmailReplies iterates each cron tick.
function findActiveEmailLegs() {
    const requests = loadQuoteRequests();
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
    return loadQuoteRequests().find((r) => r.id === requestId) || null;
}

// Marks a request 'closed' once every leg has left 'awaiting_reply' (either
// got a price or was escalated as unresponsive) — purely a display/filter
// convenience for the dashboard comparison table (active requests surface
// first); doesn't affect reminder/escalation logic, which is entirely
// leg-status-driven already.
async function maybeCloseRequest(requestId) {
    let closed = false;
    await mutateJson(cfg.QUOTE_REQUESTS_FILE, [], (list) => {
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
    loadQuoteRequests,
    resolveLaneEntry, expandLaneQuery,
    resolveTruckerChannel,
    classifyQuoteReply,
    buildQuoteMessage, buildReminderMessage,
    LaneResolutionError,
    createQuoteRequest,
    markLegSent, recordReminderSent, markLegEscalated, recordLegReply,
    findActiveLegByTarget, findActiveEmailLegs, getRequestById, maybeCloseRequest,
};
