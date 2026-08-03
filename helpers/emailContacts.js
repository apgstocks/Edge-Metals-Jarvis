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
//
// DOMAIN GROUPS (added 2026-08-03) — per Apsara: "we are hardcoding, we
// should not... instead of one contact, I need a tree-like structure, all
// nodes like helen, brian, docs attached to domain radmetals." Real incident
// that forced this: "radmetals" as a single flat name→address pairing kept
// getting overwritten with whichever address a bug happened to resolve most
// recently (the shared docs mailbox, a hallucination, etc.) — there was no
// way to represent "this company has three real addresses that mean
// different things" at all. Storage is STILL a flat array (dashboard/
// api.js's existing list-based UI and the by-address Cc lookups in
// actions.js both keep working completely unchanged) — each record just
// optionally carries `domain` and `role` now. `role: 'primary'` is who a
// bare company-name mention ("mail radmetals") resolves to by default;
// other roles (e.g. 'secondary', 'shared') must be addressed by their own
// name ("mail helen"). A domain's shared/cc-only address (e.g. a docs
// mailbox) is wired in by literally setting that address on every other
// member's own `cc` field — draftEmailWithAddress/ccForAddress already look
// up cc by the resolved email address, so this needed zero changes there.

const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

function isValidEmail(addr) {
    return typeof addr === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr.trim());
}

function loadContacts() {
    return loadJson(cfg.EMAIL_CONTACTS_FILE, []);
}

// extra: optional { domain, role, cc } — domain groups pass these; ordinary
// single-name contacts (e.g. "jeyshree") never need to. Passing role:
// 'primary' for a domain demotes any OTHER existing primary on that same
// domain to 'secondary' first, so a domain can never silently end up with
// two primaries (resolveContact would then have to guess between them).
async function addContact(name, email, extra = {}) {
    if (!name || !email) throw new Error('name and email required');
    if (!isValidEmail(email)) throw new Error('email address looks invalid');
    const { domain, role, cc } = extra;
    await mutateJson(cfg.EMAIL_CONTACTS_FILE, [], (list) => {
        // GUARD (2026-08-03): actions.js has three separate call sites that
        // auto-save name→address pairings it just resolved (reply_email's
        // direct-sender and forward-extraction paths, draftEmailForConfirm's
        // mail-search fallback). None of them know about domain groups. If
        // any of them ever auto-saved a bare, non-domain-tagged entry whose
        // name happens to equal an EXISTING domain (e.g. "radmetals", once
        // radmetals.com is a known domain), that flat entry would win
        // resolveContact's exact-name tier forever and permanently shadow
        // the domain_default resolution — silently reintroducing the exact
        // "stale flat contact never updates" bug the domain-tree redesign
        // exists to kill. Refuse that specific save instead; every other
        // addContact call (explicit domain/role entries, ordinary
        // single-person names) is unaffected.
        if (!domain) {
            const shadowsDomain = list.some((x) => x.domain && (
                x.domain.toLowerCase() === name.toLowerCase() ||
                x.domain.toLowerCase() === `${name.toLowerCase()}.com`
            ));
            if (shadowsDomain) {
                console.warn(`[EMAIL_CONTACTS] Refusing to save bare contact "${name}" — it matches a known domain group and would shadow domain resolution. Use a specific person's name instead.`);
                return list;
            }
        }
        if (domain && role === 'primary') {
            list = list.map((x) => (x.domain && x.domain.toLowerCase() === domain.toLowerCase() && x.role === 'primary')
                ? { ...x, role: 'secondary' }
                : x);
        }
        const i = list.findIndex((x) => x.name.toLowerCase() === name.toLowerCase());
        const entry = { name: String(name).trim(), email: String(email).trim().toLowerCase() };
        if (domain) entry.domain = String(domain).trim().toLowerCase();
        if (role) entry.role = role;
        if (cc) entry.cc = Array.isArray(cc) ? cc : [cc];
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
// contact. Five distinct outcomes, so the caller can decide what "just ask,
// are you mentioning this" should actually look like per case:
//   { type: 'exact',          contact }  — typed a raw address, OR name matched a saved contact exactly. Use directly.
//   { type: 'domain_default', contact }  — bare company/domain mention (e.g. "radmetals"), resolved to that
//                                           domain's marked primary. Use directly — this is a real, deliberate
//                                           default per Apsara, not a guess.
//   { type: 'single_partial', contact }  — exactly one saved contact's name contains the typed text. Use directly
//                                           (still shown in the draft preview for a visible confirm before send).
//   { type: 'ambiguous',      matches }  — more than one saved contact matches, OR a domain has multiple
//                                           members and none is marked primary. Caller must ask which one —
//                                           this IS the "are you mentioning this?" case.
//   null                                  — nothing saved matches. Caller falls back to mail search.
function resolveContact(nameOrEmail) {
    const raw = String(nameOrEmail || '').trim();
    if (!raw) return null;
    if (isValidEmail(raw)) return { type: 'exact', contact: { name: raw, email: raw } };

    const contacts = loadContacts();
    const rawLower = raw.toLowerCase();

    // 1. Exact name match — a specific person, e.g. "helen", always wins
    // over any domain-level default. Unchanged from before domain groups.
    const exact = contacts.find((c) => c.name.toLowerCase() === rawLower);
    if (exact) return { type: 'exact', contact: exact };

    // 2. Domain match — only reached when no specific person was named.
    // "radmetals" matches a record with domain "radmetals.com" (with or
    // without the typed term including the TLD). Resolves to whichever
    // member is marked role:'primary'; with 2+ members and no primary
    // marked, that's genuinely ambiguous — don't guess which one Apsara
    // means, ask (same posture as the name-based ambiguous case below).
    const domainMembers = contacts.filter((c) => {
        if (!c.domain) return false;
        const d = c.domain.toLowerCase();
        return d === rawLower || d === `${rawLower}.com` || d.startsWith(`${rawLower}.`);
    });
    if (domainMembers.length) {
        const primary = domainMembers.find((c) => c.role === 'primary');
        if (primary) return { type: 'domain_default', contact: primary };
        if (domainMembers.length === 1) return { type: 'domain_default', contact: domainMembers[0] };
        return { type: 'ambiguous', matches: domainMembers };
    }

    // 3. Partial name match — unchanged fallback.
    const partials = contacts.filter((c) => c.name.toLowerCase().includes(rawLower));
    if (partials.length === 1) return { type: 'single_partial', contact: partials[0] };
    if (partials.length > 1) return { type: 'ambiguous', matches: partials };

    return null;
}

// "radmetals" -> "radmetals.com"; "radmetals.com" -> unchanged. Shared by
// the WhatsApp domain-learn flow (workflow/actions.js) and the CLI diagnostic
// (scripts/learnDomain.js) so both mean the same thing by "the domain".
function normalizeDomain(term) {
    const t = String(term || '').trim().toLowerCase();
    return t.includes('.') ? t : `${t}.com`;
}

// Given a tally Map (address -> { from, to, cc }) — as returned by
// helpers/gmail.js's tallyAddressesForTerm — propose primary/secondary/
// shared roles for a domain-tree contact group. Pure function, no I/O, so
// both the WhatsApp flow (workflow/actions.js's learnDomainForConfirm) and
// the CLI tool (scripts/learnDomain.js) call this ONE implementation rather
// than keeping their own copies that could quietly drift apart.
//
// Built 2026-08-03 after Apsara pointed out that hand-writing per-domain
// seed scripts just relocates the "hardcoding" problem instead of fixing
// it — this proposes from real From/Cc/To frequency instead of a guess:
//   from === 0                                  -> shared (never originates mail)
//   from > 0 but cc >= from*3 (and cc >= 10)     -> shared (sends occasionally, overwhelmingly cc'd — shared-box pattern)
//   otherwise                                    -> primary (highest From count) / secondary (everyone else)
// A name is inferred from the address's local-part UNLESS it's identical to
// the domain term itself (e.g. radmetals@radmetals.com when learning
// "radmetals") — that collision is left unnamed (name: null) rather than
// guessing a label like "docs"; the caller must supply one explicitly. This
// is deliberate: auto-picking that name would just be a different flavor of
// the exact guessing this whole feature exists to avoid.
function proposeDomainRoles(tally, term, domain) {
    const bareTerm = String(term).replace(/\.com$/i, '').toLowerCase();
    const domainAddrs = [...tally.entries()].filter(([addr]) => addr.endsWith(`@${domain}`));

    const proposals = domainAddrs.map(([addr, counts]) => {
        const localPart = addr.split('@')[0];
        let role;
        if (counts.from === 0) role = 'shared';
        else if (counts.cc >= counts.from * 3 && counts.cc >= 10) role = 'shared';
        else role = 'candidate'; // resolved to primary/secondary below
        const name = localPart.toLowerCase() === bareTerm ? null : localPart;
        return { addr, counts, role, name };
    });

    // REAL CASE (found 2026-08-04, live): mkmetaltrading.com has THREE real
    // addresses, and the top two (marckang, export) are tied at From=11
    // each. Picking one as primary here would just be a different flavor of
    // guessing — Array.sort's tie-break (stable, so effectively "whichever
    // was seen in a more recent message") isn't a real signal of who's
    // actually primary, it's an accident of scan order. On an exact tie for
    // the top spot, deliberately leave NOBODY marked primary — resolveContact
    // already asks which person is meant whenever a domain has 2+ members
    // and none is primary, so this just lets that existing "don't guess, ask"
    // path do its job instead of a false-confidence auto-pick.
    const candidates = proposals.filter((p) => p.role === 'candidate');
    if (candidates.length) {
        candidates.sort((a, b) => b.counts.from - a.counts.from);
        const topCount = candidates[0].counts.from;
        const tiedForTop = candidates.filter((c) => c.counts.from === topCount);
        if (tiedForTop.length > 1) {
            for (const c of candidates) c.role = 'secondary';
        } else {
            candidates[0].role = 'primary';
            for (const c of candidates.slice(1)) c.role = 'secondary';
        }
    }
    return proposals;
}

module.exports = {
    loadContacts, addContact, removeContact, resolveContact, isValidEmail,
    setContactCc, declineCcSuggestion, normalizeDomain, proposeDomainRoles,
};