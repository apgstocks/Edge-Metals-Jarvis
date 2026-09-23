#!/usr/bin/env node
// ── scripts/qb-push-list.js — a named list of old sales into QuickBooks ─────
//
// The nightly sweep refuses anything before the cutover (invoices 2026-08-28),
// because that period belongs to the accountant. The FMC and eccomelt tabs
// broke that assumption: 2026 sales that were never entered anywhere, which
// Apsara wants in the books ("upload all fmc,eccomelt invoice", 2026-09-23).
//
// Rather than move the cutover — which would turn the sweep loose on her
// whole closed period — this pushes ONE NAMED SET and lifts the cutover only
// inside this process, only for the rows it was given.
//
//   node scripts/qb-push-list.js --customer="FMC METALS" --since=2026-01-01
//                                --until=2026-08-27 --reason="FMC tab backlog"
//                                [--really]
//
// Dry run unless --really. Every write goes through the same checks as any
// other: exact name matching, the duplicate search on invoice number and
// container, the same-money judgement, and the journal (so `qb-journal undo`
// takes any of it back).
require('dotenv').config();
const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
if (arg('env')) process.env.QB_ENV = arg('env');
const REALLY = process.argv.includes('--really');

(async () => {
    const reason = arg('reason');
    if (!reason) { console.log('--reason="..." is required: it goes in the journal beside every invoice this writes'); process.exit(1); }
    const customer = arg('customer'), since = arg('since') || '2026-01-01', until = arg('until') || '2026-12-31';
    const auth = require('../helpers/quickbooks/auth');
    const env = auth.qbEnv();
    const sales = require('../helpers/sales');
    const push = require('../helpers/quickbooks/push');
    const pushInvoice = require('../helpers/quickbooks/pushInvoice');
    const sync = require('../helpers/quickbooks/sync');

    const norm = (v) => String(v || '').trim().toUpperCase();
    const rows = sales.list().filter((s) => {
        const d = push.isoDate(s.date);
        if (!d || d < since || d > until) return false;
        return !customer || norm(s.customer) === norm(customer);
    });
    if (!rows.length) { console.log('no sales match that filter'); return; }

    // The cutover is lifted for this process only, after the rows are chosen.
    const was = process.env.QB_CUTOVER_INVOICES;
    process.env.QB_CUTOVER_INVOICES = since;
    try {
        const snaps = await sync.snapshots(env);
        const byDoc = {};
        for (const s of rows) { const no = push.docNumberFor(s); if (!no) continue; (byDoc[no] = byDoc[no] || []).push(sales.withTotals(s)); }
        const skipped = rows.length - Object.values(byDoc).reduce((n, g) => n + g.length, 0);
        console.log(`QuickBooks ${env.toUpperCase()} · ${REALLY ? 'ENTERING' : 'DRY RUN'} · ${Object.keys(byDoc).length} invoices from ${rows.length} sales${skipped ? ` (${skipped} have no invoice number)` : ''}`);
        const tally = {};
        for (const [no, group] of Object.entries(byDoc)) {
            const r = await pushInvoice.pushInvoice(group, snaps, { env, dryRun: !REALLY, reason })
                .catch((e) => ({ status: 'error: ' + e.message }));
            tally[r.status] = (tally[r.status] || 0) + 1;
            const total = group.reduce((s, g) => s + (Number(g.receivable) || 0), 0);
            console.log(`  ${String(no).padEnd(10)} ${group[0].date} ${String(group[0].customer).slice(0, 16).padEnd(16)} $${Math.round(total * 100) / 100}  ${r.status}${r.problems ? ' — ' + r.problems.join('; ') : ''}${r.qbId ? ' QB #' + r.qbId : ''}`);
        }
        console.log(tally);
        console.log(REALLY ? 'Journalled — `node scripts/qb-journal.js undo <id> --reason="..."` takes any of it back.'
            : 'DRY RUN — nothing written. Add --really once the list above is right.');
    } finally { if (was === undefined) delete process.env.QB_CUTOVER_INVOICES; else process.env.QB_CUTOVER_INVOICES = was; }
})().catch((e) => { console.error('qb-push-list failed:', e.message); process.exit(1); });
