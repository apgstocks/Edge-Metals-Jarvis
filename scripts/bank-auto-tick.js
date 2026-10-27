#!/usr/bin/env node
// ── scripts/bank-auto-tick.js ───────────────────────────────────────────────
// What the overnight auto-tick WOULD do, without doing it.
//
// Apsara, 2026-10-08: "when Jarvis is certain a bank row matches a payment
// already recorded, it should tick it off by itself (exact single matches
// only)". Task #187.
//
//   node scripts/bank-auto-tick.js           # show, tick nothing
//   node scripts/bank-auto-tick.js --tick    # actually tick them, now
//
// DRY RUN BY DEFAULT, and it says so on every run. A match creates nothing
// and is reversible, but the first time anything in this repo touched her
// books by itself she should be the one who read the list first.
//
// Run it where data/ is (the VM).
const AT = require('../helpers/bankAutoTick');
const TICK = process.argv.includes('--tick');
const money = (v) => '$' + Number(v || 0).toLocaleString('en-US',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });

(async () => {
    const res = await AT.run({ dryRun: !TICK });
    if (res.ok === false) { console.error('\n  ' + AT.summary(res) + '\n'); process.exit(1); }

    console.log('\n── Withdrawals that match a payment already recorded ──────────\n');
    if (!res.ticked.length) {
        console.log('  Nothing is certain enough to tick by itself.');
        console.log('  (That is the normal state. Only an exact, unambiguous, single');
        console.log('   match qualifies — helpers/bankOut.js autoTickable.)\n');
        return;
    }
    for (const t of res.ticked) {
        console.log(`  ${t.date}  ${money(t.amount).padStart(14)}  ${t.descriptor}`);
        console.log(`      ${t.why}`);
    }
    console.log(`\n  ${AT.summary(res)}`);
    if (res.failed.length) {
        console.log('\n  COULD NOT BE TICKED:');
        for (const f of res.failed) console.log(`    ${f.id} — ${f.why}`);
    }
    if (!TICK) {
        console.log('\n  Nothing was ticked. Re-run with --tick to do it, or leave it to');
        console.log('  the overnight job. Every tick is reversible and says it was auto.\n');
    } else {
        console.log('\n  Done. Each row carries how:"auto" and a history line, so the');
        console.log('  review screen can show what Jarvis did by itself.\n');
    }
})().catch((e) => { console.error('\nFailed: ' + (e && e.message || e) + '\n'); process.exit(1); });
