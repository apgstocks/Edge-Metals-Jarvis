// scripts/learnDomain.js — general-purpose domain-tree contact learner.
// Built 2026-08-03 per Apsara: after manually seeding radmetals.com's
// contact tree by hand-reading a mail tally, she pushed back — "why are you
// manually adding it?" — correctly pointing out that a one-off script per
// domain doesn't scale and just relocates the hardcoding problem instead of
// solving it. This replaces that pattern: propose roles from REAL mail
// frequency data (via helpers/gmail.js's tallyAddressesForTerm — the exact
// same counting logic scripts/debugFindAddress.js uses, so the two can never
// silently disagree), and require an explicit look-before-you-write step —
// same "detect, then confirm, never silently persist" posture as
// detectCcPattern/await_cc_pattern_confirm elsewhere in this app. Nothing is
// ever written without --apply.
//
// Usage:
//   node scripts/learnDomain.js radmetals                     (dry run — proposes, writes nothing)
//   node scripts/learnDomain.js radmetals --apply              (writes the proposal below)
//   node scripts/learnDomain.js radmetals --role=x@y.com:secondary   (override a role)
//   node scripts/learnDomain.js radmetals --name=x@y.com:jane        (override/supply a name)
//   (--role/--name repeatable — pass as many as you need)
//
// Role heuristic (a PROPOSAL, not a verdict — review before --apply):
//   from = 0                        -> shared   (never originates mail — a notification/docs box, most likely)
//   from > 0 but cc >= from*3 (&cc>=10) -> shared (sends occasionally but is overwhelmingly cc'd — shared-box pattern)
//   otherwise                       -> primary (highest From count) / secondary (everyone else who actually sends)
// 'shared' addresses become every primary/secondary member's standing Cc —
// this is the literal mechanism for "auto-cc docs for the whole domain."
//
// Naming: inferred from the address's local-part (e.g. brian@x.com -> "brian").
// If an address's local-part is IDENTICAL to the domain term itself (e.g.
// radmetals@radmetals.com when learning "radmetals") it's deliberately left
// unnamed and EXCLUDED from --apply until you supply --name=<email>:<name>.
// Auto-picking a name like "docs" for that case would just be a different
// flavor of the exact guessing this tool exists to avoid.

const { getGmailRead, tallyAddressesForTerm } = require('../helpers/gmail');
const emailContacts = require('../helpers/emailContacts');

function parseArgs(argv) {
    const term = argv[2];
    const roleOverrides = new Map(); // email -> role
    const nameOverrides = new Map(); // email -> name
    let apply = false;
    for (const arg of argv.slice(3)) {
        if (arg === '--apply') { apply = true; continue; }
        let m = arg.match(/^--role=([^:]+):(.+)$/);
        if (m) { roleOverrides.set(m[1].toLowerCase(), m[2]); continue; }
        m = arg.match(/^--name=([^:]+):(.+)$/);
        if (m) { nameOverrides.set(m[1].toLowerCase(), m[2]); continue; }
        console.warn(`Ignoring unrecognized argument: ${arg}`);
    }
    return { term, roleOverrides, nameOverrides, apply };
}

function normalizeDomain(term) {
    return term.includes('.') ? term.toLowerCase() : `${term.toLowerCase()}.com`;
}

async function main() {
    const { term, roleOverrides, nameOverrides, apply } = parseArgs(process.argv);
    if (!term) {
        console.error('Usage: node scripts/learnDomain.js <name-or-domain> [--apply] [--role=email:role] [--name=email:name]');
        process.exit(1);
    }
    const domain = normalizeDomain(term);
    const bareTerm = term.replace(/\.com$/i, '').toLowerCase();

    const gmail = getGmailRead();
    const { query, messages, tally } = await tallyAddressesForTerm(gmail, term, 50);
    console.log(`Query: ${query}`);
    console.log(`${messages.length} matching messages scanned\n`);

    const domainAddrs = [...tally.entries()].filter(([addr]) => addr.endsWith(`@${domain}`));
    if (!domainAddrs.length) {
        console.log(`No addresses under @${domain} found in the last ${messages.length} matching messages — nothing to propose.`);
        return;
    }

    // ── Propose roles ──────────────────────────────────────────────────────
    const proposals = domainAddrs.map(([addr, counts]) => {
        const localPart = addr.split('@')[0];
        let role;
        if (counts.from === 0) role = 'shared';
        else if (counts.cc >= counts.from * 3 && counts.cc >= 10) role = 'shared';
        else role = 'candidate'; // resolved to primary/secondary below
        return { addr, counts, localPart, role };
    });
    // Among non-shared candidates, highest From count becomes primary.
    const candidates = proposals.filter((p) => p.role === 'candidate');
    if (candidates.length) {
        candidates.sort((a, b) => b.counts.from - a.counts.from);
        candidates[0].role = 'primary';
        for (const c of candidates.slice(1)) c.role = 'secondary';
    }
    // Apply explicit overrides last — the human always wins over the heuristic.
    for (const p of proposals) {
        if (roleOverrides.has(p.addr)) p.role = roleOverrides.get(p.addr);
        p.name = nameOverrides.get(p.addr) || (p.localPart.toLowerCase() === bareTerm ? null : p.localPart);
    }

    console.log(`=== PROPOSAL for domain "${domain}" ===`);
    for (const p of proposals) {
        const nameStr = p.name ? p.name : '(no name — needs --name= override, will be SKIPPED)';
        console.log(`${p.addr}  From=${p.counts.from} To=${p.counts.to} Cc=${p.counts.cc}  -> role=${p.role}  name=${nameStr}`);
    }

    const sharedEmails = proposals.filter((p) => p.role === 'shared').map((p) => p.addr);
    const applyable = proposals.filter((p) => p.name);
    const skipped = proposals.filter((p) => !p.name);

    console.log(`\nShared/auto-cc addresses for this domain: ${sharedEmails.length ? sharedEmails.join(', ') : '(none)'}`);
    if (skipped.length) {
        console.log(`\nSKIPPING (no name, needs override): ${skipped.map((p) => p.addr).join(', ')}`);
    }
    if (!candidates.length && !proposals.some((p) => p.role === 'primary')) {
        console.log('\nNOTE: no address qualified as primary — nobody in this sample sends non-trivially more than they\'re cc\'d. A bare domain mention will stay ambiguous until you set one manually via --role=email:primary.');
    }

    if (!apply) {
        console.log('\nDry run only — nothing written. Re-run with --apply once this looks right (add --role=/--name= overrides as needed).');
        return;
    }

    // ── Apply ─────────────────────────────────────────────────────────────
    // Clear any pre-existing flat, non-domain entry with this exact bare
    // name — same reasoning as the radmetals migration: a leftover flat
    // alias would otherwise permanently shadow the domain tier.
    const existing = emailContacts.loadContacts().find((c) => c.name.toLowerCase() === bareTerm && !c.domain);
    if (existing) {
        console.log(`Removing pre-existing flat contact "${existing.name}" <${existing.email}> — superseded by this domain group.`);
        await emailContacts.removeContact(bareTerm);
    }

    for (const p of applyable) {
        const cc = p.role === 'shared' ? undefined : sharedEmails.filter((e) => e !== p.addr);
        await emailContacts.addContact(p.name, p.addr, { domain, role: p.role, ...(cc && cc.length ? { cc } : {}) });
        console.log(`Saved: ${p.name} <${p.addr}> role=${p.role}${cc && cc.length ? ` cc=[${cc.join(', ')}]` : ''}`);
    }
    console.log('\nDone.');
}

main().catch((err) => {
    console.error('FAILED:', err);
    process.exit(1);
});