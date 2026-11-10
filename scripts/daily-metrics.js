#!/usr/bin/env node
// node scripts/daily-metrics.js            today's numbers (writes nothing)
// node scripts/daily-metrics.js --record   also save today's line to data/metrics.jsonl (once per day)
// node scripts/daily-metrics.js --trend    the saved lines, with the change in agreement
// Runs where data/ is (the VM for the live view).
const m = require('../helpers/dailyMetrics');
(async () => {
    if (process.argv.includes('--trend')) { for (const r of m.trend({ days: 60 })) console.log(r.day, 'agree', r.learner ? r.learner.agreement_pct : 'n/a', 'change', r.agreement_change, 'undo%', r.deposits.undo_pct, 'check%', r.prices.check_pct); return; }
    if (process.argv.includes('--record')) { const r = await m.record(); console.log(r.ok ? (r.skipped || 'recorded') : 'failed: ' + r.error); }
    console.log(m.text(await m.snapshot()));
})();
