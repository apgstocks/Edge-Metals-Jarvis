#!/usr/bin/env node
// node scripts/price-facts.js                 every (customer|supplier, item): how many prices, the last, the typical, how far off the last is
// node scripts/price-facts.js "Calderon"      the full price history for one party
// READ-ONLY facts, in $/lb. These are what the learner reads; nothing here decides whether a price is wrong.
const ph = require('../helpers/priceHistory');
const arg = process.argv.slice(2).join(' ').trim().toLowerCase();
const obs = ph.observations();
const rows = ph.series(obs).filter((s) => !arg || s.party.toLowerCase().includes(arg));
if (arg) for (const s of rows) { console.log(`\n${s.side === 'bill' ? 'SUPPLIER' : 'CUSTOMER'} ${s.party} — ${s.item}  (${s.n} price${s.n === 1 ? '' : 's'})`); for (const p of s.points) console.log(`  ${p.date}  $${p.usd_per_lb.toFixed(4)}/lb  ${p.ref}`); }
else {
    for (const s of rows) console.log(`${s.side === 'bill' ? 'bought' : 'sold  '} ${s.party.padEnd(22)} ${s.item.padEnd(24)} n=${String(s.n).padStart(3)}  last $${s.last.toFixed(4)}  ${s.typical ? 'typical $' + s.typical.toFixed(4) + '  off ' + (s.pct_off > 0 ? '+' : '') + s.pct_off + '%' : '(not enough history yet)'}`);
    console.log(`\n${rows.length} series from ${obs.length} prices`);
}
