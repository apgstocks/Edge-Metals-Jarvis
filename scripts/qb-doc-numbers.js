#!/usr/bin/env node
// ── scripts/qb-doc-numbers.js — numbers QuickBooks made, blank in Jarvis ────
// Apsara, 2026-10-12. See helpers/qbDocNumbers.js for the rules.
//
//   node scripts/qb-doc-numbers.js                 # dry run: list only (snapshot)
//   node scripts/qb-doc-numbers.js --live          # read QuickBooks now instead
//   node scripts/qb-doc-numbers.js --since=2026-01-01
//   node scripts/qb-doc-numbers.js --live --by-amount   # also look for same party + same total when the container is not named (leads only, never auto-filled)
//   node scripts/qb-doc-numbers.js --apply         # write the SURE ones only
//   node scripts/qb-doc-numbers.js --apply --skip-labels   # ...but not words like "Local" that have no digit
//
// Run it where the real ledgers are (the VM). Default is a dry run; it writes
// a CSV beside the other reports and changes nothing. --apply puts the number
// into the normal Invoice no. field of the SURE rows only; the rest stay
// listed for her to decide. Nothing is ever written to QuickBooks.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const q = require('../helpers/qbDocNumbers');

const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const flag = (k) => process.argv.includes(`--${k}`);

(async () => {
    const since = arg('since') || '2026-01-01';
    const sales = require('../helpers/sales'), bills = require('../helpers/bills');

    let qbDocs, source;
    if (flag('live')) {
        const client = require('../helpers/quickbooks/client'), auth = require('../helpers/quickbooks/auth');
        const env = auth.qbEnv();
        const page = async (table) => {
            const out = [];
            for (let start = 1; start <= 6000; start += 1000) {
                const r = await client.query(`select * from ${table} where TxnDate >= '${since}' maxresults 1000 startposition ${start}`, { env });
                const rows = r[table] || []; out.push(...rows); if (rows.length < 1000) break;
            }
            return out;
        };
        qbDocs = q.fromQuickBooks({ invoices: await page('Invoice'), bills: await page('Bill') });
        source = `QuickBooks (${env}), read just now`;
    } else {
        const snap = require('../helpers/quickbooks/snapshot').read();
        if (!snap) { console.error('No QuickBooks snapshot on this machine. Run with --live, or on the server.'); process.exit(1); }
        qbDocs = q.fromSnapshot(snap);
        source = `snapshot of ${snap.at} (${require('../helpers/quickbooks/snapshot').ageMinutes()} min old)`;
    }

    let results = q.plan({
        sales: sales.list().filter((s) => String(s.date || '') >= since), bills: bills.list().filter((b) => String(b.date || '') >= since),
        qbDocs, salesWithTotals: sales.withTotals, billsWithTotals: bills.withTotals,
    });
    if (flag('by-amount')) results = q.byAmount(results, qbDocs);
    const by = (s) => results.filter((r) => r.status === s);
    console.log(`Jarvis rows with a blank Invoice no. since ${since}, against ${source}\n`);
    for (const [label, st] of [['SURE — would be filled', 'sure'], ['ASK — QuickBooks has something, but I am not certain', 'ask'], ['NO MATCH — nothing to put back', 'none']]) {
        const list = by(st);
        console.log(`${label}: ${list.length}`);
        for (const r of list.slice(0, 60)) {
            console.log(`  ${r.kind.padEnd(7)} ${r.container}  ${r.party}  ${r.total}  ->  ${r.qb && !Array.isArray(r.qb) ? (r.qb.doc || '(blank)') : '—'}   ${st === 'sure' ? '' : r.why}`);
        }
        if (list.length > 60) console.log(`  … ${list.length - 60} more (see the CSV)`);
        console.log('');
    }
    const rows = [['status', 'kind', 'container', 'party', 'date', 'jarvis total', 'QuickBooks number', 'QuickBooks id', 'note']];
    for (const r of results) rows.push([r.status, r.kind, r.container, r.party, r.date, r.total,
        r.qb && !Array.isArray(r.qb) ? r.qb.doc : '', r.qb && !Array.isArray(r.qb) ? r.qb.id : '', r.why]);
    const file = arg('out') || 'Claude outputs/qb-doc-numbers.csv';
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch {}
    fs.writeFileSync(file, rows.map((r) => r.map((c) => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`).join(',')).join('\n'));
    console.log('written:', file);

    if (!flag('apply')) { console.log('DRY RUN — nothing was changed. Add --apply to fill the SURE rows.'); return; }
    const out = await q.apply(results, { editSale: sales.editSale, editBill: bills.editBill, getSale: sales.getSale, getBill: (id) => bills.list().find((b) => b.id === id), skipLabels: flag('skip-labels') });
    console.log(`filled ${out.done.length} row(s); skipped ${out.skipped.length}.`);
    for (const k of out.skipped) console.log(`  skipped ${k.container}: ${k.why}`);
    for (const d of out.done) console.log(`  ${d.store} ${d.container} -> ${d.invoice_no}`);
})().catch((e) => { console.error('qb-doc-numbers failed:', e.message); process.exit(1); });
