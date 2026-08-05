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

// Merge freshly-parsed Doc entries into the stored list. Doc wins — an
// entry's raw text is fully replaced by whatever's currently in the Doc, not
// merged field-by-field (there ARE no fields to merge; it's one text blob).
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

    for (const entry of parsed) {
        const match = result.find((e) => sameAliasSet(e.aliases, entry.aliases));
        if (match) {
            if (match.raw !== entry.raw) { match.raw = entry.raw; updated.push(match.aliases[0]); }
        } else {
            result.push({ aliases: [...entry.aliases], raw: entry.raw, added_at: new Date().toISOString() });
            added.push(entry.aliases[0]);
        }
    }
    return { result, added, updated };
}

// Fetches the Doc, parses it, and overwrites data/address_book.json.
// Returns { added: [...names], updated: [...names], total }.
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
        summary = { added: merged.added, updated: merged.updated, total: merged.result.length };
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

    return null;
}

module.exports = { parseAddressBookDoc, mergeEntries, loadAddressBook, syncFromDoc, resolveAddress };
