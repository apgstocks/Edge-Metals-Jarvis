#!/usr/bin/env node
// ── scripts/books-parity.js ─────────────────────────────────────────────────
// Jarvis's books against QuickBooks', for a real period, on her real data.
//
// Apsara, 2026-10-23: "from next year-no qb", "so accounts should be
// perfectly handled", "so that we can convince owner to let go of qb and
// jarvis does better".
//
// THIS IS THE EVIDENCE FOR THAT CONVERSATION, and it has a deadline the
// features do not: it can only be run while QuickBooks is still live. From
// January there is nothing to compare against and "Jarvis is right" becomes
// an assertion. Run it monthly between now and the cutover, close the gaps
// it finds, and the last run before January is the thing to put in front of
// the owner.
//
//   node scripts/books-parity.js --from 2026-01-01 --to 2026-09-30
//   node scripts/books-parity.js --from 2026-09-01 --to 2026-09-30 --tolerance 1
//
// READ ONLY, on both sides. It fetches a QuickBooks report and builds
// Jarvis's statements; it writes nothing, to either system. A parity tool
// that adjusts a difference hides the one thing worth knowing.
//
// Run it where data/ and the QuickBooks token are (the VM).
const parity = require('../helpers/booksParity');

function arg(name, fallback = null) {
    const i = process.argv.indexOf('--' + name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const FROM = arg('from');
const TO = arg('to');
const TOL = Number(arg('tolerance', '')) || undefined;

if (!FROM || !TO) {
    console.error('\n  Need a period.  node scripts/books-parity.js --from 2026-01-01 --to 2026-09-30\n');
    process.exit(2);
}

const money = (v) => (v === null || v === undefined ? '—'
    : (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US',
        { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

(async () => {
    // ── QUICKBOOKS ──────────────────────────────────────────────────────
    let qb;
    try {
        const auth = require('../helpers/quickbooks/auth');
        const books = require('../helpers/quickbooks/books');
        qb = await books.profitAndLoss(auth.qbEnv(), FROM, TO);
    } catch (e) {
        // Said plainly rather than as a stack: the usual cause is a token
        // that needs re-authorising, and that is a thing she can fix.
        console.error('\n  Could not read QuickBooks: ' + e.message);
        console.error('  If the token has expired, re-authorise it and run this again.');
        console.error('  NOTHING was compared, and nothing was changed.\n');
        process.exit(1);
    }

    // ── JARVIS ──────────────────────────────────────────────────────────
    let js;
    try {
        const built = require('../helpers/booksBuild').build({ from: FROM, to: TO });
        js = require('../helpers/statements').profitAndLoss(built.lines, { from: FROM, to: TO });
        // Anything booksBuild could not place is reported BEFORE the
        // comparison, because an unplaced transaction is a difference that
        // has not happened yet — it is simply missing from one side.
        if ((built.unplaced || []).length) {
            console.log(`\n  ⚠ ${built.unplaced.length} transaction(s) could not be placed on an account.`);
            console.log('    They are missing from Jarvis’s figures below — fix these first,');
            console.log('    because they will show up as a difference and waste the hunt.');
        }
    } catch (e) {
        console.error('\n  Could not build Jarvis’s books: ' + e.message + '\n');
        process.exit(1);
    }

    const cmp = parity.compare(qb, js, TOL ? { tolerance: TOL } : {});

    console.log('\n── Jarvis vs QuickBooks ─────────────────────────────────────────');
    console.log(`   ${FROM} to ${TO}   ·   agreement within ${money(cmp.tolerance)}\n`);
    console.log('   ' + 'Figure'.padEnd(16) + 'Jarvis'.padStart(16) + 'QuickBooks'.padStart(16) + 'Difference'.padStart(16));
    console.log('   ' + '─'.repeat(64));
    for (const r of cmp.rows) {
        const mark = r.agrees ? ' ' : '*';
        console.log('  ' + mark + r.label.padEnd(16)
            + money(r.jarvis).padStart(16) + money(r.qb).padStart(16)
            + (r.delta === null ? 'missing' : money(r.delta)).padStart(16));
    }

    console.log('\n── Verdict ──────────────────────────────────────────────────────\n');
    console.log('   ' + parity.verdict(cmp));

    if (!cmp.agrees) {
        console.log('\n── Where to look ────────────────────────────────────────────────');
        console.log('   Biggest first. The lines below the biggest usually follow from it.\n');
        for (const r of cmp.differing) {
            console.log('   ' + r.label + ':');
            console.log('     ' + parity.whereToLook(r) + '\n');
        }
        process.exitCode = 1;   // so a scheduled run can notice
    } else {
        console.log('\n   This is the figure to show the owner. Re-run it monthly until the');
        console.log('   cutover — the last clean run before QuickBooks goes is the evidence.\n');
    }
})().catch((e) => { console.error('\n  Failed: ' + (e && e.message || e) + '\n'); process.exit(1); });
