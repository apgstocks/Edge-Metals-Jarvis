#!/usr/bin/env node
// node scripts/case-file.js                 one line per customer: status and what is owed
// node scripts/case-file.js "Rad Metal"     the full timeline for one customer
// READ-ONLY. Runs where data/ is (the VM for the live view).
const cf = require('../helpers/caseFile');
const arg = process.argv.slice(2).join(' ').trim();
if (arg) {
    const c = cf.buildOne(arg);
    console.log(`${c.customer}: ${c.status} — ${c.why}\nowes $${c.balance.toFixed(2)} on ${c.open_invoices} invoice(s)\n`);
    for (const e of c.events) console.log(`${e.at.slice(0, 16).replace('T', ' ')}  ${e.kind.padEnd(10)} ${e.text}  [${e.source}]`);
    if (!c.events.length) console.log('(nothing recorded for this customer)');
} else {
    const all = cf.buildAll();
    for (const c of all) console.log(`${c.customer.padEnd(28)} ${c.status.padEnd(24)} $${c.balance.toFixed(2).padStart(12)}  ${c.why}`);
    console.log(`\n${all.length} customer(s)`);
}
