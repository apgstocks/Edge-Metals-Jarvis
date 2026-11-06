#!/usr/bin/env node
// Why does Jarvis think this customer owes money?  node scripts/why-open.js "rad metal"     (read-only)
// Separates the three possible causes: (A) sales imported with no receipts, (B) receipts recorded but not applied to the
// invoices, (C) the customer really has not paid.
const q = String(process.argv[2] || '').trim().toLowerCase();
if (!q) { console.log('usage: node scripts/why-open.js "customer name"'); process.exit(1); }
const sales = require('../helpers/sales').listWithTotals().filter((s) => String(s.customer || '').toLowerCase().includes(q));
const receipts = require('../helpers/salesReceipts').list().filter((r) => String(r.customer || '').toLowerCase().includes(q));
const money = (n) => '$' + (Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
const open = sales.filter((s) => s.balance > 0.005);
const cust = [...new Set(sales.map((s) => s.customer))];
const by = (arr, f) => arr.reduce((m, x) => { const k = f(x) || '(none)'; m[k] = (m[k] || 0) + 1; return m; }, {});
const dates = open.map((s) => s.date).filter(Boolean).sort();
const rcvTotal = receipts.reduce((t, r) => t + (Number(r.amount) || 0), 0);
const applied = receipts.reduce((t, r) => t + (r.allocations || []).reduce((a, x) => a + (Number(x.amount) || 0), 0), 0);
console.log(`Customers matching "${q}": ${cust.join(' | ') || 'none'}`);
console.log(`Sales: ${sales.length} (${open.length} open, ${money(open.reduce((t, s) => t + s.balance, 0))} open of ${money(sales.reduce((t, s) => t + (s.receivable || 0), 0))} invoiced)`);
console.log(`Open invoices run from ${dates[0] || '-'} to ${dates[dates.length - 1] || '-'}`);
console.log(`Open sales by who/what created them: ${JSON.stringify(by(open, (s) => s.created_by))}`);
console.log(`Open sales by month created: ${JSON.stringify(by(open, (s) => String(s.created_at || '').slice(0, 7)))}`);
console.log(`Receipts recorded: ${receipts.length}, total ${money(rcvTotal)}, of which applied to invoices ${money(applied)}, NOT applied ${money(rcvTotal - applied)}`);
console.log('');
console.log(!receipts.length && open.length ? 'READING: no receipt exists for this customer at all - the open invoices were loaded (imported/entered) but their payments never were.'
    : (rcvTotal - applied) > 1 ? 'READING: money was recorded but not applied to specific invoices - apply those receipts.'
    : open.length ? 'READING: receipts exist and are applied; what is left open has not been paid in Jarvis.' : 'READING: nothing open.');
