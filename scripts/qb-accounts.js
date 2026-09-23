#!/usr/bin/env node
// ── scripts/qb-accounts.js — the chart of accounts, and what Jarvis uses ────
// Apsara, 2026-09-23: "Jarvis should have idea about all these accounts.
// ensure it." Until now Jarvis knew her banks and nothing else, so a wire
// paid before a load had no account to sit on.
//
//   node scripts/qb-accounts.js list [--like=payable] [--type=Bank]
//   node scripts/qb-accounts.js roles
//   node scripts/qb-accounts.js role prepayment "Vendor Payable"
//
// A ROLE is what Jarvis needs an account FOR; the mapping says which of her
// accounts answers it. Nothing is guessed: an unmapped role blocks the write
// and says so, the same as an unmatched supplier.
require('dotenv').config();
const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
if (arg('env')) process.env.QB_ENV = arg('env');
const mapping = require('../helpers/quickbooks/mapping');
const client = require('../helpers/quickbooks/client');

// The roles Jarvis can use today. Adding one here is how a new use of an
// account gets a name she can answer.
const ROLES = {
    prepayment: 'money wired to a supplier before his load arrives (her accountant books these to Vendor Payable)',
    'bank charges': 'the fee a customer wire arrives short by',
    trucking: 'the trucking deducted on a supplier bill',
};

(async () => {
    const [cmd, a, b] = process.argv.slice(2).filter((x) => !x.startsWith('--'));
    const env = require('../helpers/quickbooks/auth').qbEnv();
    if (cmd === 'role') {
        if (!a || !b) throw new Error('usage: qb-accounts.js role <role> "Account name"');
        if (!ROLES[a]) throw new Error(`role must be one of: ${Object.keys(ROLES).join(', ')}`);
        const all = await mapping.fetchParties('account', client, { env });
        const hit = all.filter((x) => String(x.DisplayName).trim().toLowerCase() === String(b).trim().toLowerCase());
        if (!hit.length) { console.log(`No account called "${b}" in QuickBooks ${env}. Run: node scripts/qb-accounts.js list --like=${String(b).split(' ')[0]}`); return; }
        if (hit.length > 1) { console.log(`${hit.length} accounts are called "${b}" — say which by Id, or rename one in QuickBooks.`); return; }
        const acc = hit[0];
        mapping.confirm('account', a, acc.Id, acc.DisplayName, 'apsara', `role "${a}" — ${ROLES[a]}`);
        console.log(`${a} → #${acc.Id} ${acc.DisplayName} (${acc.AccountType}). Saved in qb-settings; commit it.`);
        return;
    }
    if (cmd === 'roles') {
        const all = await mapping.fetchParties('account', client, { env }).catch(() => []);
        for (const [role, why] of Object.entries(ROLES)) {
            const m = mapping.matchParty(role, all, 'account');
            console.log(`${role.padEnd(14)} ${m.qbName ? `→ #${m.qbId} ${m.qbName}` : 'NOT SET — Jarvis will refuse to write'}\n   ${why}`);
        }
        return;
    }
    const like = (arg('like') || '').toLowerCase(), type = (arg('type') || '').toLowerCase();
    const all = await mapping.fetchParties('account', client, { env });
    const rows = all.filter((x) => (!like || String(x.DisplayName).toLowerCase().includes(like))
        && (!type || String(x.AccountType).toLowerCase().includes(type)));
    console.log(`QuickBooks ${env.toUpperCase()} · ${rows.length} of ${all.length} accounts`);
    for (const x of rows.sort((p, q) => String(p.AccountType).localeCompare(String(q.AccountType)) || String(p.DisplayName).localeCompare(String(q.DisplayName))))
        console.log(`  #${String(x.Id).padStart(6)}  ${String(x.AccountType).padEnd(22)} ${x.DisplayName}${x.Active === false ? ' (inactive)' : ''}${x.Balance != null ? `  $${x.Balance}` : ''}`);
})().catch((e) => { console.error('qb-accounts failed:', e.message); process.exit(1); });
