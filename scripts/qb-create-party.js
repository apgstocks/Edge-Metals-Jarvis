#!/usr/bin/env node
// ── scripts/qb-create-party.js — add ONE supplier or customer she approved ──
// Jarvis never creates a vendor/customer on its own (mapping.js: a NEW name
// is a question for her). This is the answer, one name at a time:
//
//   node scripts/qb-create-party.js vendor "Edge Yard"            (preview)
//   node scripts/qb-create-party.js vendor "Edge Yard" --really   (create it)
//
// What --really does, and nothing else:
//   · refuses if that name (or one spelt the same apart from spacing) is
//     already in her books — it links to it instead of making a twin
//   · creates it in the live books (this ONE write is allowed even while
//     QB_PROD_WRITES is off — the approval is the command itself); client.js
//     journals it like every other write
//   · records her confirmation so every Jarvis row under that name maps to it
// Apsara, 2026-09-22: 'Shall Jarvis create a supplier called "Edge Yard"' — yes.
require('dotenv').config();
const [kind, name] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const really = process.argv.includes('--really');
// Apsara, 2026-09-23: "Chnage Mario in qb to LA Recycling with contact name as
// Mario" — the yard's name goes on the books, the person's name goes in the
// contact, so a wire and a bill both read right.
const flag = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const contact = flag('contact');
const company = flag('company');
// --jarvis-name: what her ledgers call him, when that differs from the name
// going into QuickBooks ("Mario" in Jarvis, "LA Recycling" in the books).
const jarvisName = flag('jarvis-name') || name;
const mapping = require('../helpers/quickbooks/mapping');
const client = require('../helpers/quickbooks/client');
const { normalizeName } = require('../helpers/nameMatch');
(async () => {
    if (!['vendor', 'customer'].includes(kind) || !name) throw new Error('usage: qb-create-party.js vendor|customer "Name" [--contact="Mario"] [--company="..."] [--jarvis-name="Mario"] [--really]');
    const env = require('../helpers/quickbooks/auth').qbEnv();
    const opts = { env };
    const table = kind === 'vendor' ? 'Vendor' : 'Customer';
    const all = await mapping.fetchParties(kind, client, opts);
    const same = all.filter((x) => normalizeName(x.DisplayName) === normalizeName(name));
    console.log(`QuickBooks ${env.toUpperCase()} · ${kind} "${name}"${contact ? ` · contact ${contact}` : ''}${jarvisName !== name ? ` · Jarvis calls him "${jarvisName}"` : ''}`);
    if (same.length) {
        console.log(`Already there: ${same.map((x) => `#${x.Id} ${x.DisplayName}${x.Active === false ? ' (inactive)' : ''}`).join(', ')} — linking, not creating.`);
        if (really) {
            mapping.confirm(kind, jarvisName, same[0].Id, same[0].DisplayName, 'apsara', 'already in QuickBooks, linked by qb-create-party');
            if (jarvisName !== name) mapping.confirm(kind, name, same[0].Id, same[0].DisplayName, 'apsara', 'same party under the name QuickBooks uses');
        }
        return;
    }
    if (!really) { console.log('Not in QuickBooks. Preview only — add --really to create it.'); return; }
    const was = process.env.QB_PROD_WRITES;
    process.env.QB_PROD_WRITES = 'on';
    let made;
    const body = { DisplayName: name };
    if (company) body.CompanyName = company;
    if (contact) {
        const parts = contact.trim().split(/\s+/);
        body.GivenName = parts[0];
        if (parts.length > 1) body.FamilyName = parts.slice(1).join(' ');
    }
    try { made = (await client.request('POST', '/' + table.toLowerCase(), body, opts))[table]; }
    finally { process.env.QB_PROD_WRITES = was; }
    mapping.confirm(kind, jarvisName, made.Id, made.DisplayName, 'apsara', 'created in QuickBooks by qb-create-party on her approval');
    if (jarvisName !== name) mapping.confirm(kind, name, made.Id, made.DisplayName, 'apsara', 'same party under the name QuickBooks uses');
    console.log(`Created ${table} #${made.Id} "${made.DisplayName}"${contact ? ` (contact ${contact})` : ''} and linked ${jarvisName !== name ? `both "${jarvisName}" and "${name}"` : `"${name}"`} to it. Logged in the journal.`);
})().catch((e) => { console.error('qb-create-party failed:', e.message); process.exit(1); });
