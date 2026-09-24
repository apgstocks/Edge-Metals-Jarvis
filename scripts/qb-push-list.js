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
// takes any of it back).
require('dotenv').config();
const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
if (arg('env')) process.env.QB_ENV = arg('env');
const REALLY = process.argv.includes('--really');

(async () => {
    const reason = arg('reason');
    if (!reason) { console.log('--reason="..." is required: it goes in the journal beside every invoice this writes'); process.exit(1); }
    const kind = (arg('kind') || 'invoice').toLowerCase();
    if (!['invoice', 'bill', 'advance'].includes(kind)) { console.log('--kind must be invoice, bill or advance'); process.exit(1); }
    const customer = arg('customer'), supplier = arg('supplier'), since = arg('since') || '2026-01-01', until = arg('until') || '2026-12-31';
    const auth = require('../helpers/quickbooks/auth');
    const env = auth.qbEnv();
    const sales = require('../helpers/sales');
    const push = require('../helpers/quickbooks/push');
    const pushInvoice = require('../helpers/quickbooks/pushInvoice');
    const sync = require('../helpers/quickbooks/sync');

    const norm = (v) => String(v || '').trim().toUpperCase();
    const inWindow = (d0) => { const d = push.isoDate(d0); return d && d >= since && d <= until; };
    // ── THE HOLD LIST ──────────────────────────────────────────────────────
    // Apsara, 2026-09-24, about six rows on Hugo's tab that are money to other
    // people or sales, not wires to him: "Ignore all these for now. But
    // remember. i will ask later." They stay in Jarvis — his account has to
    // tie to his own tab — and the push leaves them alone until the entry is
    // taken out of qb-settings/qb-hold.json.
    const HOLD = (() => {
        try { return JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'qb-settings', 'qb-hold.json'), 'utf8')).hold || []; }
        catch { return []; }
    })();
    const onHold = (kind, row) => HOLD.find((h) => h.kind === kind
        && String(h.supplier || '').trim().toUpperCase() === String(row.supplier || row.customer || '').trim().toUpperCase()
        && push.isoDate(h.date) === push.isoDate(row.date)
        && Math.abs(Number(h.amount) - Number(row.amount || 0)) < 0.02);
    const bills = require('../helpers/bills');
    const billPayments = require('../helpers/billPayments');
    const pushPayments = require('../helpers/quickbooks/pushPayments');

    const rows = kind === 'invoice'
        ? sales.list().filter((s) => inWindow(s.date) && (!customer || norm(s.customer) === norm(customer)))
        : kind === 'bill'
            ? bills.list().filter((b) => inWindow(b.date) && (!supplier || norm(b.supplier) === norm(supplier)))
            : billPayments.list().filter((p) => p.kind === 'advance' && inWindow(p.date) && (!supplier || norm(p.supplier) === norm(supplier)));
    if (!rows.length) { console.log(`no ${kind}s match that filter`); return; }

    // The cutover is lifted for this process only, after the rows are chosen.
    const was = [process.env.QB_CUTOVER_INVOICES, process.env.QB_CUTOVER_BILLS];
    process.env.QB_CUTOVER_INVOICES = since;
    process.env.QB_CUTOVER_BILLS = since;
    try {
        const snaps = await sync.snapshots(env);
        if (kind !== 'invoice') {
            console.log(`QuickBooks ${env.toUpperCase()} · ${REALLY ? 'ENTERING' : 'DRY RUN'} · ${rows.length} ${kind}s`);
            const tally2 = {};
            for (const row of rows.sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
                const held = onHold(kind, row);
                if (held) {
                    tally2['on hold'] = (tally2['on hold'] || 0) + 1;
                    console.log(`  ${String(row.date).padEnd(11)} ${String(row.supplier || '').slice(0, 16).padEnd(16)} $${row.amount}  ON HOLD — ${held.why}`);
                    continue;
                }
                const r = kind === 'bill'
                    ? await push.pushBill(bills.withTotals(row), snaps, { env, dryRun: !REALLY, reason }).catch((e) => ({ status: 'error: ' + e.message }))
                    : await pushPayments.pushBillPayment(row, snaps, { env, dryRun: !REALLY, reason }).catch((e) => ({ status: 'error: ' + e.message }));
                tally2[r.status] = (tally2[r.status] || 0) + 1;
                const who = kind === 'bill' ? row.supplier : row.supplier;
                const amt = kind === 'bill' ? bills.withTotals(row).amount : row.amount;
                console.log(`  ${String(row.date).padEnd(11)} ${String(who || '').slice(0, 16).padEnd(16)} $${amt}  ${r.status}${r.problems ? ' — ' + r.problems.join('; ') : ''}${r.qbId ? ' QB #' + r.qbId : ''}`);
            }
            console.log(tally2);
            console.log(REALLY ? 'Journalled — `node scripts/qb-journal.js undo <id> --reason="..."` takes any of it back.'
                : 'DRY RUN — nothing written. Add --really once the list above is right.');
            return;
        }
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
    } finally {
        if (was[0] === undefined) delete process.env.QB_CUTOVER_INVOICES; else process.env.QB_CUTOVER_INVOICES = was[0];
        if (was[1] === undefined) delete process.env.QB_CUTOVER_BILLS; else process.env.QB_CUTOVER_BILLS = was[1];
    }
})().catch((e) => { console.error('qb-push-list failed:', e.message); process.exit(1); });
