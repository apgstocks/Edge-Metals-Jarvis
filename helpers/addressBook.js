// ── helpers/addressBook.js — name/alias → full address block ─────────────────
// Built 2026-08-05. Real need: quote-request messages to truckers need full
// pickup/delivery address blocks (yard/company name + street + city/state/
// zip), which Apsara currently retypes by hand from a running Google Doc
// every time. That Doc is free-text, not a table — entries look like:
//
//   [Rad Metal]
//   Rad Metals
//   505 N. Tustin Ave., Suite 121
//   Santa Ana, CA 92705, USA
//   Tel: (714) 606-0566
//
// One [Label] (sometimes "Label1/Label2/Label3" — multiple lookup names for
// the same place, e.g. "[hardeep/modern]") followed by a multi-line address
// block, separated from the next entry by blank line(s). Deliberately NOT
// parsed into structured street/city/zip fields — the real use case (a
// quote-request message) pastes the address block verbatim, exactly as
// Apsara does today, so the raw text IS the useful unit, not its parts.
//
// Storage is its own flat array in data/address_book.json, same shape as
// helpers/emailContacts.js's contacts list (not the Supabase truckers/
// suppliers tables — those are a different concern: WhatsApp group
// messaging + workflow assignment, keyed by a single name, no notion of
// aliases or multi-line free text). An address-book entry and a
// trucker/supplier contact for the same real person are two separate
// records on purpose; nothing here touches Supabase.

const crypto = require('crypto');
const { findByNormalizedAlias } = require('./nameMatch');
const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

// ── Pure parser — no I/O, directly testable against real Doc content ────────
// Splits on lines that are ENTIRELY "[...]" (trimmed) — that's a label line,
// starting a new entry. Everything up to the next label line (or end of
// text) is that entry's raw address block, blank lines trimmed off both
// ends. A label containing "/" carries multiple aliases for one entry
// ("[hardeep/modern]" -> aliases ["hardeep", "modern"]).
function parseAddressBookDoc(text) {
    if (!text) return [];
    const lines = String(text).replace(/\r\n/g, '\n').split('\n');
    const entries = [];
    let current = null;

    const flush = () => {
        if (!current) return;
        const raw = current.bodyLines.join('\n').trim();
        if (raw) entries.push({ aliases: current.aliases, raw });
        current = null;
    };

    for (const line of lines) {
        const labelMatch = line.trim().match(/^\[([^\]]+)\]$/);
        if (labelMatch) {
            flush();
            const aliases = labelMatch[1].split('/').map((a) => a.trim()).filter(Boolean);
            current = { aliases, bodyLines: [] };
        } else if (current) {
            current.bodyLines.push(line);
        }
    }
    flush();
    return entries;
}

// ── Storage ───────────────────────────────────────────────────────────────
function loadAddressBook() {
    return loadJson(cfg.ADDRESS_BOOK_FILE, []);
}

// Two alias lists are "the same entry" only if they're the exact same SET
// (case-insensitive, order-independent) — not merely overlapping.
function sameAliasSet(a, b) {
    if (a.length !== b.length) return false;
    const setA = new Set(a.map((x) => x.toLowerCase()));
    for (const x of b) if (!setA.has(x.toLowerCase())) return false;
    return setA.size === b.length;
}

// Merge freshly-parsed Doc/Sheet entries into the stored list. Doc/Sheet
// wins for entries nobody has touched by hand — an entry's raw text is
// fully replaced, not merged field-by-field (there ARE no fields to merge;
// it's one text blob). EXCEPT: an entry with `manually_edited: true` is
// skipped entirely, not overwritten. Built 2026-08-05 per Apsara — the
// website's Add/Edit UI (see addManualEntry/updateEntryById below) is real
// data-entry work; without this, the very next "Sync from Doc" click would
// silently discard any correction she just made, since the old code always
// let the Doc win unconditionally. addManualEntry/updateEntryById set this
// flag by default; the dashboard exposes a checkbox to clear it again if
// she wants a specific entry to go back to tracking the Doc/Sheet.
//
// Matching an existing stored record requires the FULL alias set to match
// (case-insensitive, order-independent) — NOT merely sharing one alias.
// REAL BUG (found 2026-08-05, caught by an end-to-end test against the live
// Doc, not by any synthetic fixture): "[Joey/Taewon]" and "[Joey/Daekwang]"
// are two genuinely different companies with different addresses that
// happen to share a broker's first name as one of their two aliases. The
// original "match on ANY shared alias" rule silently collapsed them into a
// single record — Doc-wins semantics then overwrote Taewon's real address
// with Daekwang's, permanently losing it on the very first sync. Full-set
// equality still correctly collapses the ONE case this was actually built
// for — "[hardeep/modern]" and a later, separately-labeled "[Modern/Hardeep]"
// — because both list exactly {hardeep, modern}, just reordered/recased.
// Two entries that share only SOME aliases (like Joey) are now kept as two
// separate stored records; resolveAddress() below returns 'ambiguous' for a
// lookup on a shared-but-not-unique alias like "Joey" instead of guessing.
function mergeEntries(stored, parsed) {
    const result = stored.map((e) => ({ ...e, aliases: [...e.aliases] }));
    const added = [];
    const updated = [];
    const lockedSkipped = [];

    for (const entry of parsed) {
        const match = result.find((e) => sameAliasSet(e.aliases, entry.aliases));
        if (match) {
            if (match.manually_edited) {
                if (match.raw !== entry.raw) lockedSkipped.push(match.aliases[0]);
                continue;
            }
            if (match.raw !== entry.raw) { match.raw = entry.raw; updated.push(match.aliases[0]); }
        } else {
            result.push({ id: crypto.randomUUID(), aliases: [...entry.aliases], raw: entry.raw, added_at: new Date().toISOString() });
            added.push(entry.aliases[0]);
        }
    }
    return { result, added, updated, lockedSkipped };
}

// Fetches the Doc, parses it, and overwrites data/address_book.json.
// Returns { added: [...names], updated: [...names], lockedSkipped: [...names], total }.
async function syncFromDoc(docId = cfg.ADDRESS_BOOK_DOC_ID) {
    const { exportDocAsText } = require('./drive');
    const text = await exportDocAsText(docId);
    const parsed = parseAddressBookDoc(text);
    if (!parsed.length) {
        throw new Error('Doc parsed to zero entries — check the Doc still uses the [Label] / address-block format, or that the service account still has Viewer access');
    }
    let summary;
    await mutateJson(cfg.ADDRESS_BOOK_FILE, [], (stored) => {
        const merged = mergeEntries(stored, parsed);
        summary = { added: merged.added, updated: merged.updated, lockedSkipped: merged.lockedSkipped, total: merged.result.length };
        return merged.result;
    });
    return summary;
}

// Resolve a loosely-typed name to a saved address. Mirrors emailContacts.js's
// resolveContact() shape for consistency across the codebase:
//   { type: 'exact',   entry }    — exactly ONE saved entry has this alias.
//   { type: 'partial', entry }    — exactly one saved alias CONTAINS the typed text.
//   { type: 'ambiguous', matches }— 2+ entries match — caller must ask which one.
//   null                          — nothing matches.
//
// The exact tier checks for MULTIPLE matches, unlike a plain .find() —
// unlike emailContacts.js (where addContact upserts by name, so two records
// can never share a name), addressBook.js entries can legitimately share one
// alias while meaning different places (e.g. a broker named "Joey" handling
// two different companies' addresses — see mergeEntries' comment for the
// real incident this came from). Silently returning the first exact match
// would just be a quieter version of the same bug — ask instead of guessing.
function resolveAddress(nameOrAlias) {
    const raw = String(nameOrAlias || '').trim().toLowerCase();
    if (!raw) return null;
    const book = loadAddressBook();

    const exactMatches = book.filter((e) => e.aliases.some((a) => a.toLowerCase() === raw));
    if (exactMatches.length === 1) return { type: 'exact', entry: exactMatches[0] };
    if (exactMatches.length > 1) return { type: 'ambiguous', matches: exactMatches };

    const partials = book.filter((e) => e.aliases.some((a) => a.toLowerCase().includes(raw)));
    if (partials.length === 1) return { type: 'partial', entry: partials[0] };
    if (partials.length > 1) return { type: 'ambiguous', matches: partials };

    // Last resort — same alias, different spacing/punctuation ("mkmetaltrading"
    // vs "MK Metal Trading"). Only reached when exact AND partial both found
    // nothing, so no lookup that resolves today can be re-pointed by this.
    // Reported as 'exact' because normalization is exact matching with
    // formatting noise removed, not a fuzzy guess — the strings are
    // character-identical once spaces and punctuation are gone.
    const normalized = findByNormalizedAlias(book, nameOrAlias);
    if (normalized.length === 1) return { type: 'exact', entry: normalized[0] };
    if (normalized.length > 1) return { type: 'ambiguous', matches: normalized };

    return null;
}

// ── Manual CRUD — dashboard's "Add Contact" / Edit buttons ─────────────────
// Built 2026-08-05, separate from the Doc/Sheet sync path on purpose: sync
// matches records by full alias-SET equality (see mergeEntries above), which
// is the right key for "did this same [Label] block come back unchanged" but
// is the WRONG key for a manual edit UI — if Apsara edits an entry's alias
// itself, matching by the (now-changed) alias set would silently create a
// duplicate instead of updating. Every entry gets a stable `id` (assigned by
// mergeEntries for synced entries, here for manual ones) so edit/delete
// always target the exact right record regardless of what the aliases say.
// mobile is genuinely optional (per Apsara 2026-08-16, "add mobile as
// optional field") and deliberately NOT digit-stripped/normalized like the
// price-list contact phone field — this is just a reference number to have
// on hand alongside the address (paste-ready in whatever format it was
// given), not something the app dials or builds a WhatsApp chatId from.
// tags: 2026-08-17 per Apsara — "There should be a tag in address book like
// seller,buyer for every contact... sometimes seller, sometimes buyer,
// sometimes both." An address-book entry can be a source Edge Metals buys
// scrap FROM (seller) or a company Edge Metals sells/ships material TO
// (buyer, e.g. Eccomelt) — or both, since the same real company sometimes
// plays either role depending on the deal. Stored as a plain array so it can
// hold zero, one, or both values, same "just trusted input, no separate
// verification step" posture as mobile/aliases above — Apsara sets it
// directly, nothing derives or validates it against any other store.
// Deliberately its own field here (not folded into helpers/contacts.js's
// quote-request contacts) — this tags the free-text ADDRESS entry itself,
// independent of whether that same company also has a separate Contacts
// record for WhatsApp/email quote-request routing.
const VALID_TAGS = ['seller', 'buyer'];
function cleanTags(tags) {
    const arr = Array.isArray(tags) ? tags : (tags ? [tags] : []);
    return [...new Set(arr.map((t) => String(t || '').trim().toLowerCase()).filter((t) => VALID_TAGS.includes(t)))];
}

// raw (address) made OPTIONAL per Apsara 2026-08-17 ("when i type a new
// name if it is not there in address book, it should be created as new
// contact with name, address(optional), phone number(optional)") — used
// to be a hard-required field (this function used to throw "address text
// is required" on blank), which blocked the yard app's auto-create-on-save
// from ever creating a name-only contact. Name is still the one truly
// required field — mobile was already optional (see 2026-08-17's earlier
// mobile-field addition), raw now follows the same pattern.
function validateEntryInput(aliases, raw, mobile, tags) {
    const cleanAliases = (Array.isArray(aliases) ? aliases : String(aliases || '').split('/'))
        .map((a) => String(a || '').trim()).filter(Boolean);
    if (!cleanAliases.length) throw new Error('at least one name/alias is required');
    const cleanRaw = String(raw || '').trim();
    const cleanMobile = String(mobile || '').trim();
    return { aliases: cleanAliases, raw: cleanRaw || null, mobile: cleanMobile || null, tags: cleanTags(tags) };
}

// `locked` defaults to true — anything typed into the website is real work
// Apsara just did; it should survive the next Doc/Sheet sync by default
// rather than silently vanish the next time someone clicks "Sync from Doc".
// She can uncheck the "keep my edits" box in the modal to explicitly hand a
// specific entry back to the Doc/Sheet going forward.
async function addManualEntry(aliases, raw, locked = true, mobile = null, tags = []) {
    const clean = validateEntryInput(aliases, raw, mobile, tags);
    const entry = { id: crypto.randomUUID(), ...clean, added_at: new Date().toISOString(), source: 'manual', manually_edited: !!locked };
    await mutateJson(cfg.ADDRESS_BOOK_FILE, [], (book) => { book.push(entry); return book; });
    return entry;
}

async function updateEntryById(id, { aliases, raw, locked = true, mobile = null, tags = [] }) {
    if (!id) throw new Error('id required');
    const clean = validateEntryInput(aliases, raw, mobile, tags);
    // Deliberately doesn't throw for a missing id inside the mutator —
    // mutateJson's own catch block would swallow that throw (it fails soft
    // and just logs), turning a clean 404 into a confusing generic "[JSON]
    // Mutate failed" log line. Returning null and checking it here instead
    // gives the caller (api.js) an honest signal either way.
    let updated = null;
    await mutateJson(cfg.ADDRESS_BOOK_FILE, [], (book) => {
        const entry = book.find((e) => e.id === id);
        if (!entry) return book;
        // A changed mobile number invalidates any prior WhatsApp verification
        // (2026-08-16, see setMobileVerified below) — a verify click on the
        // OLD digits shouldn't silently carry over to a DIFFERENT number
        // someone just typed in.
        if (clean.mobile !== entry.mobile) entry.whatsapp_verified = false;
        entry.aliases = clean.aliases;
        entry.raw = clean.raw;
        entry.mobile = clean.mobile;
        entry.tags = clean.tags;
        entry.manually_edited = !!locked;
        entry.updated_at = new Date().toISOString();
        updated = entry;
        return book;
    });
    return updated;
}

// ── WhatsApp verification (2026-08-16) ──────────────────────────────────────
// Per Apsara: "just have whatsapp verify button in phon[e] number" — replaces
// the earlier design (Jarvis asking a yes/no over WhatsApp chat, per-request,
// every time a contact-quote went to an address-book mobile) with a one-time
// dashboard toggle on the entry itself. Once marked verified here,
// helpers/contactQuoteRequests.js's resolveQuoteContact treats the mobile as
// a trusted WhatsApp target with no further chat confirmation; until then,
// it's still surfaced as a candidate but excluded from sends. Same reasoning
// as before for why this isn't automatic on save: a `mobile` typed into
// freight paperwork is frequently an office/landline number, not a personal
// WhatsApp line — verifying is a deliberate, one-time human decision, now
// just made once on the dashboard instead of re-asked over chat every time.
async function setMobileVerified(id, verified) {
    if (!id) throw new Error('id required');
    // Validated OUTSIDE the mutateJson mutator on purpose — mutateJson's own
    // catch block swallows a thrown error and just logs it (see its comment
    // in helpers/json.js), which would turn a clean "no mobile on this
    // entry" 400 into a silent no-op returning null indistinguishable from
    // "id not found". Reading first lets this throw a real, catchable error
    // back to the caller (api.js), same as validateEntryInput's throws above.
    const existing = loadAddressBook().find((e) => e.id === id);
    if (!existing) return null;
    if (!existing.mobile) throw new Error('this entry has no mobile number to verify');

    let updated = null;
    await mutateJson(cfg.ADDRESS_BOOK_FILE, [], (book) => {
        const entry = book.find((e) => e.id === id);
        if (!entry) return book;
        entry.whatsapp_verified = !!verified;
        entry.whatsapp_verified_at = verified ? new Date().toISOString() : null;
        updated = entry;
        return book;
    });
    return updated;
}

async function deleteEntryById(id) {
    if (!id) throw new Error('id required');
    let existed = false;
    await mutateJson(cfg.ADDRESS_BOOK_FILE, [], (book) => {
        const before = book.length;
        const next = book.filter((e) => e.id !== id);
        existed = next.length < before;
        return next;
    });
    return existed;
}

module.exports = {
    parseAddressBookDoc, mergeEntries, loadAddressBook, syncFromDoc, resolveAddress,
    addManualEntry, updateEntryById, deleteEntryById, setMobileVerified,
};
