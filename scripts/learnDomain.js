// scripts/learnDomain.js — CLI wrapper around the domain-tree learning logic.
// Built 2026-08-03. The actual proposal logic now lives in ONE place —
// helpers/emailContacts.js's proposeDomainRoles — shared with the WhatsApp
// flow (workflow/actions.js's learnDomainForConfirm/"learn X contacts").
// This script exists for direct VM debugging only; the normal way Apsara
// sets up a domain group is "learn <name> contacts" on WhatsApp, same as
// every other confirm-before-write action in this app. Kept as a CLI tool
// because it's still useful to eyeball the raw proposal without round-
// tripping through WhatsApp while debugging.
//
// Usage:
//   node scripts/learnDomain.js radmetals                     (dry run — proposes, writes nothing)
//   node scripts/learnDomain.js radmetals --apply              (writes the proposal below)
//   node scripts/learnDomain.js radmetals --role=x@y.com:secondary   (override a role)
//   node scripts/learnDomain.js radmetals --name=x@y.com:jane        (override/supply a name)

const { getGmailRead, tallyAddressesForTerm } = require('../helpers/gmail');
const emailContacts = require('../helpers/emailContacts');

function parseArgs(argv) {
    const term = argv[2];
    const roleOverrides = new Map();
    const nameOverrides = new Map();
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

async function main() {
    const { term, roleOverrides, nameOverrides, apply } = parseArgs(process.argv);
    if (!term) {
        console.error('Usage: node scripts/learnDomain.js <name-or-domain> [--apply] [--role=email:role] [--name=email:name]');
        process.exit(1);
    }
    const domain = emailContacts.normalizeDomain(term);
    const bareTerm = term.replace(/\.com$/i, '').toLowerCase();

    const gmail = getGmailRead();
    const { query, messages, tally } = await tallyAddressesForTerm(gmail, term, 50);
    console.log(`Query: ${query}`);
    console.log(`${messages.length} matching messages scanned\n`);

    const proposals = emailContacts.proposeDomainRoles(tally, term, domain);
    if (!proposals.length) {
        console.log(`No addresses under @${domain} found in the last ${messages.length} matching messages — nothing to propose.`);
        return;
    }

    for (const p of proposals) {
        if (roleOverrides.has(p.addr)) p.role = roleOverrides.get(p.addr);
        if (nameOverrides.has(p.addr)) p.name = nameOverrides.get(p.addr);
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
    if (skipped.length) console.log(`\nSKIPPING (no name, needs override): ${skipped.map((p) => p.addr).join(', ')}`);
    if (!proposals.some((p) => p.role === 'primary')) {
        console.log('\nNOTE: no address qualified as primary — a bare domain mention will stay ambiguous until you set one manually via --role=email:primary.');
    }

    if (!apply) {
        console.log('\nDry run only — nothing written. Re-run with --apply once this looks right.');
        return;
    }

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