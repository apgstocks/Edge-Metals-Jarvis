#!/usr/bin/env node
// ── scripts/unrecorded-payments.js ──────────────────────────────────────────
// What the 07:00 chase WOULD say, without saying it to anybody.
//
// Apsara, 2026-10-23: "They are forgetting to record the payment in jarvis",
// then "You have pliad na.leverage that", then "plaid is linked".
//
// So from the next morning this job starts sending a real WhatsApp and a real
// email to whoever is in Settings > Accounts contact. That is the right
// behaviour and also the reason this script exists: the first time anything
// messages a colleague about MONEY, she should be the one who reads it first.
//
//   node scripts/unrecorded-payments.js            # show, send nothing
//   node scripts/unrecorded-payments.js --all      # include rows already chased
//   node scripts/unrecorded-payments.js --send     # actually send it, now
//
// Run it where data/ is (the VM). SENDS NOTHING unless --send is given, and
// says so on every run, because a script whose default is to message people
// is a script somebody eventually runs by accident.
const up = require('../helpers/unrecordedPayments');

const args = process.argv.slice(2);
const SEND = args.includes('--send');
const ALL = args.includes('--all');

const money = (v) => '$' + Number(v || 0).toLocaleString('en-US',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });

(async () => {
    const res = await up.chase({ dryRun: !SEND, includeAlreadyChased: ALL });
    const found = res.found || { rows: [], total: 0, suppressed: 0 };

    if (found.ok === false) {
        console.error('\nCould not read the books: ' + found.error);
        console.error('Nothing was sent.\n');
        process.exit(1);
    }

    console.log('\n── Payments that left the bank with nothing recorded in Jarvis ──\n');
    if (!found.rows.length) {
        console.log('  Nothing outstanding.'
            + (found.suppressed ? `  (${found.suppressed} already chased — re-run with --all to see them.)` : ''));
        console.log('\n  The 07:00 job would stay silent. That is deliberate: an all-clear');
        console.log('  every morning is how the one that matters gets ignored.\n');
        return;
    }

    for (const r of found.rows) {
        console.log(`  ${r.date}   ${money(r.amount).padStart(12)}   ${r.description}`);
    }
    console.log(`\n  ${found.rows.length} row(s), ${money(found.total)} in total.`);
    if (found.suppressed) console.log(`  (${found.suppressed} more already chased and not repeated.)`);

    console.log('\n── The message ────────────────────────────────────────────────\n');
    console.log('  SUBJECT: ' + (res.subject || '(none)'));
    console.log((res.body || '').split('\n').map((l) => '  ' + l).join('\n'));

    if (SEND) {
        const d = res.delivery || {};
        console.log('\n── Sent ───────────────────────────────────────────────────────');
        console.log(`  WhatsApp: ${d.whatsapp ? 'yes' : 'no'}   Email: ${d.email ? 'yes' : 'no'}`);
        if ((d.skipped || []).length) console.log('  Skipped: ' + d.skipped.join('; '));
        if ((d.errors || []).length) console.log('  Errors:  ' + d.errors.join('; '));
        if (!res.sent) {
            console.log('\n  NOTHING WAS SENT, so these rows are still outstanding and');
            console.log('  will be chased again — a failed send is never recorded as done.');
        }
    } else {
        console.log('\n  Nothing was sent. Re-run with --send to send it now, or leave it');
        console.log('  to the 07:00 job.\n');
    }
})().catch((e) => { console.error('\nFailed: ' + (e && e.message || e) + '\n'); process.exit(1); });
