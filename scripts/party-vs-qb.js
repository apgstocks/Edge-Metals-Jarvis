#!/usr/bin/env node
// ── scripts/party-vs-qb.js — is this customer's money already in QuickBooks? ─
//   node scripts/party-vs-qb.js --customer="Eccomelt" [--since=2026-01-01]
// READ-ONLY. Before pushing a backlog (qb-push-list --really) this answers
// "would that double-count?". Each Jarvis invoice is matched to a QuickBooks
// invoice for the same customer by amount (to the cent) and date (within 10
// days), whatever the invoice numbers say. Run `node scripts/qb-snapshot.js`
// first on the VM so the QuickBooks side is fresh; its age is printed.
// Born 2026-11-19: Eccomelt showed $892K in Jarvis, $514K in QuickBooks, and
// 29 rows "would-create" — pushing them blind could have added ~$475K twice.
require('dotenv').config();
const path = require('path');
const ROOT = path.join(__dirname, '..');
const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const cust = String(arg('customer') || '').toLowerCase().trim();
const since = arg('since') || '2026-01-01';
if (!cust) { console.error('usage: --customer="Name" [--since=YYYY-MM-DD]'); process.exit(2); }
const snap = require(path.join(ROOT, 'helpers/quickbooks/snapshot'));
const push = require(path.join(ROOT, 'helpers/quickbooks/push'));
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const day = (d) => Date.parse(String(d).slice(0, 10));
const money = (n) => '$' + r2(n).toLocaleString('en-US', { minimumFractionDigits: 2 });

const meta = snap.read(); const rows = snap.rows('invoices');
if (!meta || !rows) { console.error('No QuickBooks invoice snapshot here — run scripts/qb-snapshot.js first.'); process.exit(1); }
console.log(`QuickBooks snapshot: ${meta.at} (${meta.env}), ${Math.round((Date.now() - Date.parse(meta.at)) / 86400000)} day(s) old`);
const qb = rows.rows.filter((r) => String((r.CustomerRef || {}).name || '').toLowerCase().includes(cust) && String(r.TxnDate) >= since)
    .map((r) => ({ id: r.Id, doc: r.DocNumber, date: r.TxnDate, total: r2(r.TotalAmt), used: false }));

const groups = new Map();
for (const s of require(path.join(ROOT, 'helpers/sales')).listWithTotals()) {
    if (!String(s.customer || '').toLowerCase().includes(cust) || String(push.isoDate(s.date) || '') < since) continue;
    const k = push.docNumberFor(s) || s.id;
    const g = groups.get(k) || { doc: k, date: push.isoDate(s.date), total: 0, container: s.container_no || '' };
    g.total = r2(g.total + Number(s.receivable != null ? s.receivable : s.amount || 0));
    groups.set(k, g);
}
const out = { matched: [], missing: [] };
for (const g of [...groups.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
    const hit = qb.find((q) => !q.used && Math.abs(q.total - g.total) < 0.51 && Math.abs(day(q.date) - day(g.date)) <= 10);
    if (hit) { hit.used = true; out.matched.push({ g, hit }); } else out.missing.push(g);
}
const sum = (a, f) => r2(a.reduce((t, x) => t + f(x), 0));
console.log(`\nJarvis: ${groups.size} invoices, ${money(sum([...groups.values()], (g) => g.total))}`);
console.log(`QuickBooks: ${qb.length} invoices, ${money(sum(qb, (q) => q.total))}\n`);
console.log(`ALREADY IN QUICKBOOKS (${out.matched.length}, ${money(sum(out.matched, (m) => m.g.total))}) — do NOT push these:`);
out.matched.forEach(({ g, hit }) => console.log(`  ${g.date} ${money(g.total).padStart(12)}  Jarvis ${g.doc}  =  QB #${hit.id} ${hit.doc || ''}`));
console.log(`\nNOT FOUND IN QUICKBOOKS (${out.missing.length}, ${money(sum(out.missing, (g) => g.total))}) — safe to push if they are real sales:`);
out.missing.forEach((g) => console.log(`  ${g.date} ${money(g.total).padStart(12)}  ${g.doc} ${g.container}`));
const left = qb.filter((q) => !q.used);
console.log(`\nIN QUICKBOOKS BUT NOT IN JARVIS (${left.length}, ${money(sum(left, (q) => q.total))}) — entered by hand or under another amount:`);
left.forEach((q) => console.log(`  ${q.date} ${money(q.total).padStart(12)}  QB #${q.id} ${q.doc || ''}`));
