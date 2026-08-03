// scripts/debugFindAddress.js — one-off diagnostic, NOT wired into the app.
// Dumps EVERY message where a name/domain hits From, To, or Cc (or appears
// as a bare word anywhere), plus a per-address tally broken down by role.
// Built 2026-08-03 to actually see the raw radmetals data instead of
// guessing at findLatestFrom's scoring from pm2 log lines alone.
//
// Refactored 2026-08-03 to use helpers/gmail.js's tallyAddressesForTerm —
// the same counting logic scripts/learnDomain.js uses to propose domain-tree
// roles, so this dump and that tool's proposal can never silently disagree
// with each other.
//
// Run on the VM (it already has GMAIL_READ_TOKEN_FILE set up there):
//   node scripts/debugFindAddress.js radmetals
//
// Safe to run any time — read-only, makes no changes, sends no mail.

const { getGmailRead, tallyAddressesForTerm } = require('../helpers/gmail');

async function main() {
    const term = process.argv[2];
    if (!term) {
        console.error('Usage: node scripts/debugFindAddress.js <name-or-domain>');
        process.exit(1);
    }

    const gmail = getGmailRead();
    const { query, messages, tally } = await tallyAddressesForTerm(gmail, term, 50);

    console.log(`Query: ${query}`);
    console.log(`${messages.length} matching messages (up to 50 fetched)\n`);

    for (const m of messages) {
        console.log(`--- ${m.date}`);
        console.log(`Subject: ${m.subject}`);
        console.log(`From: ${m.from}`);
        if (m.to) console.log(`To: ${m.to}`);
        if (m.cc) console.log(`Cc: ${m.cc}`);
        console.log('');
    }

    console.log(`=== TALLY — every address containing "${term}", by role ===`);
    if (!tally.size) {
        console.log('(none found)');
        return;
    }
    for (const [addr, counts] of tally) {
        console.log(`${addr}:  From=${counts.from}  To=${counts.to}  Cc=${counts.cc}`);
    }
}

main().catch((err) => {
    console.error('FAILED:', err);
    process.exit(1);
});