#!/usr/bin/env node
// ── scripts/qb-push-list.js — a named list of old rows into QuickBooks ─────
//
// The nightly sweep refuses anything before the cutover, because that period
// belongs to her accountant. This pushes ONE NAMED SET and lifts the cutover
// only inside this process, only for the rows it was given.
//
//   node scripts/qb-push-list.js --customer="FMC METALS" --since=2026-01-01
//                                --until=2026-08-27 --reason="FMC tab backlog"
//                                [--really]
//   node scripts/qb-push-list.js --kind=bill --supplier="Mario" --reason="..."
//   node scripts/qb-push-list.js --kind=advance --supplier="Mario" --reason="..."
//
// --kind: invoice (default), bill, or advance. An advance is a wire paid
// before the load arrived; it goes in as a cheque against the payable account
// mapped to the role "prepayment" (scripts/qb-accounts.js).
//
// Dry run unless --really. Every write goes through the same checks as any
// other: exact name matching, the duplicate search on invoice number and
// container, the same-money judgement, and the journal (so `qb-journal undo`
// takes any of it back). The work itself lives in helpers/quickbooks/
// pushList.js (2026-09-26) because the QuickBooks page does this too now.
require('dotenv').config();
const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
if (arg('env')) process.env.QB_ENV = arg('env');

(async () => {
    const out = await require('../helpers/quickbooks/pushList').run({
        kind: (arg('kind') || 'invoice').toLowerCase(),
        since: arg('since') || '2026-01-01',
        until: arg('until') || '2026-12-31',
        party: arg('customer') || arg('supplier') || null,
        reason: arg('reason'),
        really: process.argv.includes('--really'),
        env: require('../helpers/quickbooks/auth').qbEnv(),
    });
    console.log(`QuickBooks ${out.env.toUpperCase()} · ${out.dryRun ? 'DRY RUN' : 'ENTERING'} · ${out.rows.length} ${out.kind}s`
        + (out.noNumber ? ` (${out.noNumber} sales have no invoice number)` : ''));
    for (const r of out.rows) {
        console.log(`  ${String(r.date).padEnd(11)} ${String(r.who || '').slice(0, 16).padEnd(16)} $${r.amount}  ${r.status}`
            + `${r.why ? ' — ' + r.why : ''}${r.qbId ? ' QB #' + r.qbId : ''}`);
    }
    console.log(out.tally);
    console.log(out.dryRun
        ? 'DRY RUN — nothing written. Add --really once the list above is right.'
        : 'Journalled — `node scripts/qb-journal.js undo <id> --reason="..."` takes any of it back.');
})().catch((e) => { console.error('qb-push-list failed:', e.message); process.exit(1); });
