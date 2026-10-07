#!/usr/bin/env node
// ── scripts/file-bugs-2026-10-07.js ───────────────────────────────────────
// Apsara, 2026-10-03: "Whenever i write a bug add it to bugzilla".
// Apsara, 2026-10-07: "add it in bugzilla" — about the judgement call below.
//
// Same shape as scripts/file-bugs-2026-10-03.js, for the same reason: a
// decision that lives only in a chat log is a decision nobody re-reads.
//
// ── IT RUNS ON THE VM ─────────────────────────────────────────────────────
// BUGS_FILE lives under DATA_DIR, so this has to run where that data is.
// Filing from anywhere else writes to a scratch copy that helps nobody.
//
//   node scripts/file-bugs-2026-10-07.js          # show what it would file
//   node scripts/file-bugs-2026-10-07.js --write  # file it
//
// Safe to run twice: fileBug() matches on `signature` and bumps the existing
// row instead of stacking a duplicate.
//
// ── THIS ITEM IS NOT A BUG, AND SAYS SO ───────────────────────────────────
// Bugzilla has four statuses — open, fixed, verified, wont_fix — and none of
// them means "waiting on Apsara to choose". So it files as `open`, and the
// detail is written so that the next person to read the list can tell, in the
// first line, that the behaviour is DELIBERATE and whose call it was.
//
// CLAUDE.md: "Never write a decision of yours into a comment as if it were
// hers." The same applies to a bug report, which is read later by exactly the
// person who would be misled. The refusal below was my call, not hers, and the
// detail names it as mine and gives her both options.

const path = require('path');
const bugs = require(path.join(__dirname, '..', 'helpers', 'bugs'));

const WRITE = process.argv.includes('--write');

const TODAY = [
    {
        signature: 'split-payment-edit-refuses-2026-10-07',
        title: 'Editing the amount on a payment split across several containers '
             + 'refuses — MY call, not hers, and she may want a picker instead',
        area: 'bills', severity: 'normal', source: 'jarvis', status: 'open',
        reporter: 'Claude',
        detail:
            'DELIBERATE, AND MINE TO JUSTIFY. Not a fault — a design decision taken '
            + 'while building the Edit button on 2026-10-07, which Apsara has not yet '
            + 'agreed to.\n\n'
            + 'WHAT HAPPENS NOW. The Edit button on all four payment screens (supplier '
            + 'payments, trucking, commission, freight) asks for a new amount. If the '
            + 'payment covers exactly ONE container or line, the allocation follows the '
            + 'amount automatically. If it covers several, the button refuses and sends '
            + 'her to the Pay sheet, where the container list already is.\n\n'
            + 'WHY I REFUSED RATHER THAN GUESSED. A $5,000 payment split $3,000 / '
            + '$2,000 over two containers, lowered to $4,000, has no single right '
            + 'answer for which container loses the $1,000. Taking it off the first, '
            + 'the largest, or pro-rata are all inventions. The server already refuses '
            + 'an amount that no longer matches its allocations ("allocations come to '
            + '$5000.00 but the payment is $3000.00"), so a screen that guessed would '
            + 'either be rejected or — worse, if I had made the guess match — would '
            + 'quietly move money between containers she never named.\n\n'
            + 'THE COST OF MY CHOICE. For a split payment she must delete and re-record, '
            + 'which loses the original row rather than keeping it in edit_history.\n\n'
            + 'HER DECISION, EITHER WAY IS BUILDABLE:\n'
            + '  (a) LEAVE IT. Split payments are edited by deleting and re-recording.\n'
            + '  (b) BUILD THE PICKER. Edit opens the allocation list with the current '
            + 'figures, she retypes the ones that change, and the total must agree '
            + 'before Save enables — the same arithmetic the Pay sheet already does, '
            + 'which is why it would be a second place to get it wrong and why I did '
            + 'not build it unasked.\n\n'
            + 'WHERE IT LIVES: editPaymentFlow() in dashboard/index.html, the '
            + '`allocs.length > 1` branch. Pinned by tests/payment-edit.js section G '
            + 'and tests/payment-edit-all.js section F. Commits dc68b6b, 39c1bd9.',
    },
];

(async () => {
    if (!WRITE) {
        console.log('\n  DRY RUN — nothing written. Add --write to file.\n');
        for (const b of TODAY) {
            console.log(`  [${b.severity}] ${b.title}`);
            console.log(`    area ${b.area} · status ${b.status} · signature ${b.signature}`);
            console.log(b.detail.split('\n').map((l) => '      ' + l).join('\n'));
            console.log('');
        }
        console.log(`  ${TODAY.length} item(s) would be filed.\n`);
        return;
    }

    for (const b of TODAY) {
        const saved = await bugs.fileBug(b);
        const again = (saved.times || 1) > 1;
        console.log(`  ${again ? 'ALREADY FILED' : 'FILED'}  ${saved.id}  ${saved.title}`);
        if (again) console.log(`              seen ${saved.times} times — not duplicated`);
    }
    console.log('');
})().catch((e) => { console.error('failed:', e && e.message); process.exit(1); });
