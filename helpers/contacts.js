// ── helpers/contacts.js — quote-request contacts (buyers/companies) ─────────
// Built 2026-08-16 per Apsara: "i should have quotes contact where i have
// separate group/whatsapp/email mimicking trucker implementation."
//
// Contact Quotes (helpers/contactQuoteRequests.js) used to resolve a
// recipient by merging helpers/emailContacts.js + helpers/addressBook.js,
// which only ever offered ONE ad-hoc address-book `mobile` field (no group
// support) plus a separate one-time "Verify WhatsApp" dashboard confirmation
// before it could be trusted. Apsara wants the same clean model
// truckers/suppliers already have instead: one record per contact with
// group_id / whatsapp / email / preferred_mode set directly by her on the
// dashboard — no separate verification step, same as a trucker's own
// whatsapp/group_id fields aren't "verified" either, they're just trusted
// input she typed in herself.
//
// Deliberately its OWN flat-JSON store (data/contacts.json, config.CONTACTS_FILE),
// NOT folded into workflow/truckers.js/suppliers.js (Supabase-backed, and a
// genuinely different real-world entity — hauliers, not buyers/companies)
// and NOT into helpers/emailContacts.js or helpers/addressBook.js (those
// keep serving their own original purposes — draft_email's name→address
// lookup and full pickup/delivery address blocks — this is neither).
//
// Record shape mirrors a trucker record exactly:
//   { name, group_id, whatsapp, email, preferred_mode, added_at, updated_at }
// on purpose, so helpers/quoteRequests.js's resolveTruckerChannel can be
// reused UNCHANGED against a contact record (same group_id → whatsapp →
// email fallback, or preferred_mode:'email' winning outright) — no forked
// copy of that logic.
//
// CRUD wired through api.js's existing contactRoutes() factory (the same
// generic loader/upsert/del pattern already used for truckers, suppliers,
// email-contacts, and pricelist-contacts) — upsertContact below is
// UPSERT-BY-NAME to match that factory's contract exactly.

const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

const loadContacts = () => loadJson(cfg.CONTACTS_FILE, []);

async function upsertContact(body) {
    const name = String(body?.name || '').trim();
    if (!name) throw new Error('name required');
    const clean = {
        name,
        group_id: body.group_id ? String(body.group_id).trim() : null,
        whatsapp: body.whatsapp ? String(body.whatsapp).trim() : null,
        email: body.email ? String(body.email).trim() : null,
        preferred_mode: body.preferred_mode || null,
    };
    let saved = null;
    await mutateJson(cfg.CONTACTS_FILE, [], (list) => {
        const idx = list.findIndex((c) => c.name === name);
        if (idx >= 0) {
            list[idx] = { ...list[idx], ...clean, updated_at: new Date().toISOString() };
            saved = list[idx];
        } else {
            saved = { ...clean, added_at: new Date().toISOString() };
            list.push(saved);
        }
        return list;
    });
    return saved;
}

async function deleteContact(name) {
    let existed = false;
    await mutateJson(cfg.CONTACTS_FILE, [], (list) => {
        const before = list.length;
        const next = list.filter((c) => c.name !== name);
        existed = next.length < before;
        return next;
    });
    return existed;
}

// Mirrors workflow/truckers.js's getTruckersByName: exact (case-insensitive)
// name match wins if any exist; otherwise every contact whose name CONTAINS
// the query substring. Caller (helpers/contactQuoteRequests.js) treats
// 1 match as resolved, 0 as not-found, 2+ as ambiguous — same "ask, don't
// guess" posture as everywhere else in this codebase.
function getContactsByName(name) {
    const lower = String(name || '').trim().toLowerCase();
    if (!lower) return [];
    const all = loadContacts();
    const exact = all.filter((c) => (c.name || '').toLowerCase() === lower);
    if (exact.length) return exact;
    return all.filter((c) => (c.name || '').toLowerCase().includes(lower));
}

// ── Chat-identity match — mirrors workflow/truckers.js's matchTruckerByChat
// EXACTLY (same 3-tier precedence: registered group → direct @c.us chat →
// sender inside a non-registered group). Added 2026-08-17: brain.js's
// normalize()/isAuthorized gate only ever checked the Trucker and Supplier
// rosters, never this store — so a message from a Contacts-only vendor (e.g.
// Eccomelt, who is a Contact, not a Trucker or Supplier) was silently
// dropped as isAuthorized:false before it ever reached the quote-reply
// detection in policyDecide's A0g/A0g2 checks. That's a separate root cause
// from the reminder-restart bug fixed earlier the same day — this is what
// actually lets Jarvis SEE a vendor's reply at all; that fix is what stops
// Jarvis re-pinging after it's seen one.
const digits = (v) => String(v || '').replace(/\D/g, '');
function matchContactByChat(chatId, senderNumber) {
    const contacts = loadContacts();

    // 1. Group match — strongest signal
    const byGroup = contacts.find((c) => c.group_id && c.group_id === chatId);
    if (byGroup) return byGroup;

    // 2. Direct chat — @c.us only, never @lid
    if (String(chatId).endsWith('@c.us')) {
        const num = digits(chatId);
        const byChat = contacts.find((c) => digits(c.whatsapp) === num);
        if (byChat) return byChat;
    }

    // 3. Sender inside a non-registered group — @c.us format only
    if (senderNumber && !String(senderNumber).includes('@lid')) {
        const num = digits(senderNumber);
        if (num) return contacts.find((c) => digits(c.whatsapp) === num) || null;
    }
    return null;
}

module.exports = { loadContacts, upsertContact, deleteContact, getContactsByName, matchContactByChat };
