// ── helpers/contactHarvest.js — everyone she actually emails ────────────────
//
// Apsara, 2026-09-19: "is there any option to learn email contacts..?", then
// "How to learn all the email contacts?", then "from email to email contacts
// tab", then "save it".
//
// There WAS an option, and it was not the one she wanted. "learn radmetals
// contacts" learns ONE company, named by her, through WhatsApp. She is asking
// for the whole mailbox at once, landing in the Email Contacts tab she was
// looking at.
//
// ── WHAT THIS REUSES, AND WHY THAT MATTERS ──────────────────────────────────
// The decision about WHO is primary, who is secondary and who is a shared
// mailbox is NOT made here. It is made in emailContacts.proposeDomainRoles —
// the same function "learn X contacts" uses and the same one
// scripts/learnDomain.js uses. Three ways in, one opinion about what a
// contact is. A second implementation would disagree eventually, and it would
// disagree about which address a customer's invoice goes to.
//
// This file does the part that did not exist: scanning WITHOUT a company name
// to search for, and deciding what is worth proposing at all.
//
// ── IT WRITES NOTHING ───────────────────────────────────────────────────────
// Scanning and saving are separate on purpose, the same posture every
// detect-then-confirm action in this app takes. A sweep of a whole mailbox
// will surface freight forwarders, a bank, somebody's personal address and a
// conference mailing list; she picks. Auto-saving a few hundred addresses
// because a scan found them would make the Email Contacts tab useless in one
// click, and resolveContact reads that tab to decide where invoices go.

const emailContacts = require('./emailContacts');

// ── ADDRESSES THAT ARE NOT PEOPLE ───────────────────────────────────────────
// A mailbox is full of senders that can never be a contact: nothing she sends
// to them will be read, and a reply to one bounces. Matched on the local part
// so a real person at any domain is never caught by it.
//
// Deliberately SHORT. Every entry here is an address that is definitionally
// automated; anything merely "probably not useful" is left in the list for
// her to untick, because a filter that guesses is one that hides the supplier
// whose address happens to read like a robot's.
const MACHINE = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|mailer[-_.]?daemon|postmaster|bounce[s]?|notifications?|alerts?|automated|noreply)([-_.+].*)?$/i;

// Cheap header split that respects quoted display names — "Kang, Marc"
// <marc@x.com> must not become two addresses.
const splitAddresses = (headerValue) =>
    String(headerValue || '').split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);

const addressOf = (part) => {
    const m = /<([^>]+)>/.exec(part);
    return String(m ? m[1] : part).trim().toLowerCase();
};
const displayNameOf = (part) => {
    const m = /^\s*"?([^"<]*?)"?\s*</.exec(part);
    const n = m ? m[1].trim() : '';
    return n && !/@/.test(n) ? n : null;
};

// ── THE SCAN ────────────────────────────────────────────────────────────────
// `gmail` is INJECTED rather than fetched here, for the reason every other
// helper in this codebase takes its dependencies: a test must never be able
// to reach her live mailbox, and a function that calls getGmailRead() itself
// cannot be tested at all without real OAuth credentials on disk.
async function scan(gmail, { limit = 200, mine = [], getMessage } = {}) {
    const read = getMessage || require('./gmail').getMessage;
    // -in:spam -in:trash, because a contact learned from spam is worse than
    // no contact: it lands in the tab she trusts to address invoices.
    const res = await gmail.users.messages.list({
        userId: 'me', q: '-in:spam -in:trash', maxResults: limit,
    });
    const ids = res.data.messages || [];

    const tally = new Map();   // address -> { from, to, cc, displayName }
    let scanned = 0;
    for (const m of ids) {
        let msg;
        try { msg = await read(gmail, m.id); }
        catch (err) {
            // One unreadable message must not end the sweep — she asked for
            // everyone, and 199 of 200 is a far better answer than a stack
            // trace.
            console.warn(`[HARVEST] skipped a message: ${err.message}`);
            continue;
        }
        scanned += 1;
        const headers = (msg.payload && msg.payload.headers) || [];
        const get = (n) => (headers.find((h) => h.name === n) || {}).value || '';
        for (const [role, value] of [['from', get('From')], ['to', get('To')], ['cc', get('Cc')]]) {
            for (const part of splitAddresses(value)) {
                if (!part.trim()) continue;
                const addr = addressOf(part);
                if (!emailContacts.isValidEmail(addr)) continue;
                if (!tally.has(addr)) tally.set(addr, { from: 0, to: 0, cc: 0, displayName: null });
                const e = tally.get(addr);
                e[role] += 1;
                // The real name is sitting in the From header of mail already
                // being read — capture it so a drafted email can say "Dear
                // Marc Kang" rather than "Dear export". Same reasoning, and
                // the same 2026-08-04 incident, as tallyAddressesForTerm.
                if (!e.displayName) e.displayName = displayNameOf(part);
            }
        }
    }
    return { scanned, tally, requested: ids.length };
}

// ── WHAT IS WORTH PROPOSING ─────────────────────────────────────────────────
// Grouped by domain, because that is the unit emailContacts reasons about and
// the unit a company actually is. `mine` is her own addresses — every mailbox
// Jarvis reads — so her own domain never proposes itself as a customer.
function propose(tally, { mine = [], known = [], minMessages = 1 } = {}) {
    const myDomains = new Set(mine.map((a) => String(a).toLowerCase().split('@')[1]).filter(Boolean));
    const mineSet = new Set(mine.map((a) => String(a).toLowerCase()));
    const knownAddrs = new Set(known.map((c) => String(c.email || '').toLowerCase()).filter(Boolean));

    const skipped = { machine: 0, mine: 0, thin: 0 };
    const byDomain = new Map();

    for (const [addr, counts] of tally) {
        const [local, domain] = addr.split('@');
        if (!domain) continue;
        if (mineSet.has(addr) || myDomains.has(domain)) { skipped.mine += 1; continue; }
        if (MACHINE.test(local)) { skipped.machine += 1; continue; }
        // Seen once, only ever in a Cc, and never written to: that is a name
        // on somebody else's thread, not a correspondent of hers.
        const total = counts.from + counts.to + counts.cc;
        if (total < minMessages || (counts.from === 0 && counts.to === 0 && counts.cc <= 1)) {
            skipped.thin += 1; continue;
        }
        if (!byDomain.has(domain)) byDomain.set(domain, new Map());
        byDomain.get(domain).set(addr, counts);
    }

    const domains = [];
    for (const [domain, addrs] of byDomain) {
        const bare = domain.replace(/\.[a-z.]+$/i, '');
        // ── THE SHARED OPINION ──────────────────────────────────────────
        // proposeDomainRoles decides primary / secondary / shared, including
        // its deliberate refusal to pick a primary on an exact tie. Called
        // with the same shape it gets from tallyAddressesForTerm.
        const proposals = emailContacts.proposeDomainRoles(addrs, bare, domain)
            .map((p) => ({
                ...p,
                // A name is required to save. proposeDomainRoles returns null
                // when the local part IS the company word, because guessing a
                // label there is what produced "Dear export". The display
                // name off the real header is the honest fallback; when there
                // is none either, the row says so and she types one.
                name: p.name || p.displayName || null,
                already_known: knownAddrs.has(p.addr),
                messages: p.counts.from + p.counts.to + p.counts.cc,
            }))
            .sort((a, b) => b.messages - a.messages);
        domains.push({
            domain,
            proposals,
            // Every address here is already saved — shown, but nothing to do.
            all_known: proposals.every((p) => p.already_known),
            messages: proposals.reduce((t, p) => t + p.messages, 0),
        });
    }

    // Busiest first: the people she actually deals with are the ones worth
    // reading at the top of a list that may run to fifty companies.
    domains.sort((a, b) => b.messages - a.messages);
    return { domains, skipped };
}

module.exports = { scan, propose, MACHINE, splitAddresses, addressOf, displayNameOf };
