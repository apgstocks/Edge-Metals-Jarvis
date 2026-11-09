#!/usr/bin/env node
// Prints each customer's real days-to-pay and which open invoices are slower than usual. Read-only; sends nothing.
const ph = require('../helpers/payHabits');
const h = ph.build();
const rows = Object.values(h.byCustomer).sort((a, b) => b.median - a.median);
console.log(rows.length ? 'Customer — usually pays in (median / 80th pct / slowest), from N settled invoices' : `No customer has ${ph.MIN_SAMPLES}+ settled invoices yet.`);
for (const r of rows) console.log(`${r.customer}: ${r.median} / ${r.p80} / ${r.slowest} days (${r.n})`);
const s = ph.slow({ habits: h });
if (s.length) { console.log('\nOpen and slower than usual:'); for (const x of s) console.log(`${x.customer} ${x.invoice_no || ''}: $${x.balance} open, day ${x.age} (usually ${x.usual})`); }
console.log(`\nLeft out: ${h.skipped.unsettled} not fully paid, ${h.skipped.negative} paid before invoicing, ${h.skipped.noDate} with no date.`);
