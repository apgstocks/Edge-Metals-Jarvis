// ── helpers/emailContacts.js — saved name→email directory ────────────────────
// Built 2026-08-03 per Apsara: "if i say send mail to <person>, instead of
// asking for email, can't it store all the email addresses and just ask, are
// you mentioning this?" — mirrors helpers/pricelist.js's contacts pattern
// (loadContacts/addContact/removeContact/resolveTarget) almost exactly,
// deliberately its own file/JSON (not truckers.json/suppliers.json/pricelist
// contacts) — an email recipient list is its own concern, even where names
// overlap with operational contacts.
//
// Grows two ways: (1) manually, via the dashboard Contacts UI (POST/DELETE
// /api/email-contacts), and (2) automatically — workflow/actions.js saves a
// name→address pairing here the first time it's successfully resolved via
// mail search or forward-extraction, so the SECOND time someone says "email
// Zimex about X" it's an instant contacts hit instead of a fresh Gmail
// search. Never overwrites silently in a way that loses data: addContact
// upserts by case-insensitive name, so re-resolving the same name just
// refreshes/confirms the same entry.

const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

function isValidEmail(addr) {
    return typeof addr === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr.trim());
}

function loadContacts() {
    return loadJson(cfg.EMAIL_CONTACTS_FILE, []);
}

async function addContact(name, email) {
    if (!name || !email) throw new Error('name and email required');
    if (!isValidEmail(email)) throw new Error('email address looks invalid');
    await mutateJson(cfg.EMAIL_CONTACTS_FILE, [], (list) => {
        const i = list.findIndex((x) => x.name.toLowerCase() === name.toLowerCase());
        const entry = { name: String(name).trim(), email: String(email).trim().toLowerCase() };
        if (i >= 0) list[i] = { ...list[i], ...entry };
        else list.push(entry);
        return list;
    });
    return true;
}

async function removeContact(name) {
    await mutateJson(cfg.EMAIL_CONTACTS_FILE, [], (list) =>
        list.filter((x) => x.name.toLowerCase() !== String(name).toLowerCase()));
}

// ── Per-contact standing Cc ("when I mail T, same people every time") ──────
// Built 2026-08-03. Set only after helpers/gmail.js's detectCcPattern finds
// a real recurring pattern AND Apsara confirms it (see workflow/actions.js's
// 'await_cc_pattern_confirm' pending) — never written silently. Requires the
// contact to already exist (addContact must have run first); a no-op merge
// (`{ ...list[i], cc: ... }`) preserves every other field on the record.
async function setContactCc(name, ccList) {
    await mutateJson(cfg.EMAIL_CONTACTS_FILE, [], (list) => {
        const i = list.findIndex((x) => x.name.toLowerCase() === String(name).toLowerCase());
        if (i < 0) return list; // nothing to attach the cc to — caller should have saved the contact first
        list[i] = { ...list[i], cc: Array.isArray(ccList) ? ccList : [] };
        return list;
    });
}

// Recorded when Apsara says "no" to a detected pattern — stops Jarvis asking
// again on every future email to the same contact. Doesn't block her from
// setting a cc some OTHER way later (dashboard edit, re-detection after
// manually clearing this flag) — it just stops the automatic re-ask.
async function declineCcSuggestion(name) {
    await mutateJson(cfg.EMAIL_CONTACTS_FILE, [], (list) => {
        const i = list.findIndex((x) => x.name.toLowerCase() === String(name).toLowerCase());
        if (i < 0) return list;
        list[i] = { ...list[i], cc_declined: true };
        return list;
    });
}

// Resolve a loosely-typed name (or an already-typed raw address) to a saved
// contact. Four distinct outcomes, so the caller can decide what "just ask,
// are you mentioning this" should actually look like per case:
//   { type: 'exact',          contact }  — typed a raw address, OR name matched a saved contact exactly. Use directly.
//   { type: 'single_partial', contact }  — exactly one saved contact's name contains the typed text. Use directly
//                                           (still shown in the draft preview for a visible confirm before send).
//   { type: 'ambiguous',      matches }  — more than one saved contact matches. Caller must ask which one —
//                                           this IS the "are you mentioning this?" case.
//   null                                  — nothing saved matches. Caller falls back to mail search.
function resolveContact(nameOrEmail) {
    const raw = String(nameOrEmail || '').trim();
    if (!raw) return null;
    if (isValidEmail(raw)) return { type: 'exact', contact: { name: raw, email: raw } };

    const contacts = loadContacts();
    const exact = contacts.find((c) => c.name.toLowerCase() === raw.toLowerCase());
    if (exact) return { type: 'exact', contact: exact };

    const partials = contacts.filter((c) => c.name.toLowerCase().includes(raw.toLowerCase()));
    if (partials.length === 1) return { type: 'single_partial', contact: partials[0] };
    if (partials.length > 1) return { type: 'ambiguous', matches: partials };

    return null;
}

module.exports = {
    loadContacts, addContact, removeContact, resolveContact, isValidEmail,
    setContactCc, declineCcSuggestion,
};