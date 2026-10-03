#!/usr/bin/env node
// ── scripts/file-bugs-2026-10-03.js ───────────────────────────────────────
// Apsara, 2026-10-03: "Whenever i write a bug add it to bugzilla".
//
// Jarvis already has one — helpers/bugs.js, with a tab on the website, built
// 2026-09-24 for exactly this. Everything she reported today goes in it rather
// than living in a chat log nobody re-reads.
//
// ── IT RUNS ON THE VM ─────────────────────────────────────────────────────
// BUGS_FILE lives under DATA_DIR, so this has to run where that data is.
// Filing from anywhere else writes to a scratch copy that helps nobody.
//
//   node scripts/file-bugs-2026-10-03.js          # show what it would file
//   node scripts/file-bugs-2026-10-03.js --write  # file it
//
// Safe to run twice: fileBug() matches on `signature` and bumps the existing
// row instead of stacking a duplicate.

const path = require('path');
const bugs = require(path.join(__dirname, '..', 'helpers', 'bugs'));

const WRITE = process.argv.includes('--write');

// Her words first in every title, because the next person to read the list
// should recognise the thing she complained about, not my summary of it.
const TODAY = [
    {
        signature: 'pay-swallowed-by-pending-2026-10-03',
        title: 'A new payment typed while Jarvis was asking a question was silently dropped',
        area: 'whatsapp', severity: 'blocker', source: 'jarvis', status: 'fixed',
        detail: 'Mid-way through recording $246 to NUR METAL, Jarvis asked "how did you '
            + 'send it?" and she typed "Paid 123 to Inesh". That was taken as the answer to '
            + 'the mode question, re-asked, and the $123 to Inesh was never recorded and '
            + 'never mentioned again. Money instruction lost with no trace.\n\n'
            + 'FIXED ad4c44d: a complete payment sentence now escapes any open question via '
            + 'detectFreshCommand.\n\n'
            + 'STILL TO CHECK BY HAND: whether that $123 to Inesh was ever paid.',
    },
    {
        signature: 'pay-parse-we-paid-2026-10-03',
        title: '"We paid 4000 to Hugo" was not understood — only sentences starting with "paid"',
        area: 'whatsapp', severity: 'high', source: 'her', status: 'fixed',
        detail: 'The pattern allowed a leading "I" but not "we", and not the misspelling '
            + '"payed". The message fell through to the general classifier, was read as an '
            + 'INVOICE payment, and returned "invoiceSheet.listAllInvoices is not a '
            + 'function" twice while the $4,000 went nowhere.\n\nFIXED ad4c44d.',
    },
    {
        signature: 'pay-parse-method-in-name-2026-10-03',
        title: '"Paid 4000 to Hugo via Zelle" looked for a supplier called "Hugo via Zelle"',
        area: 'whatsapp', severity: 'high', source: 'her', status: 'fixed',
        detail: 'The payment method was absorbed into the supplier name. Hit three times: '
            + '"Hugo via Zelle", "Hugo Zelle", "arturo via zelle".\n\nFIXED ad4c44d — the '
            + 'method is stripped with its connecting word. "Cash Metals Inc" still survives '
            + 'as a name.',
    },
    {
        signature: 'invoicesheet-listallinvoices-missing',
        title: 'invoiceSheet.listAllInvoices does not exist, and receivables.js still calls it',
        area: 'invoice', severity: 'high', source: 'jarvis', status: 'open',
        detail: 'helpers/receivables.js:204 calls invoiceSheet.listAllInvoices(). The '
            + 'function was deleted by commit 8dc3495 ("INV BY INV NO") and never restored — '
            + 'this is the deletion CLAUDE.md records as the reason '
            + 'scripts/check-action-wiring.js exists.\n\nShe hit it twice this morning as '
            + '"Couldn\'t record that: invoiceSheet.listAllInvoices is not a function". Any '
            + 'path reaching receivables will hit it. NOT FIXED — needs the function back or '
            + 'the caller changed, and that is a decision about what receivables should read.',
    },
    {
        signature: 'whatsapp-slow-classifier-2026-10-03',
        title: 'WhatsApp taking over a minute to ask the next question',
        area: 'whatsapp', severity: 'normal', source: 'her', status: 'fixed',
        detail: 'A message matching the payment pattern answers in 2-4 seconds and never '
            + 'calls a model. One that misses it went to the general classifier, whose '
            + 'prompt carries every active booking, the port summary, every trucker and '
            + 'every supplier — tens of thousands of tokens to answer "is this a payment?". '
            + 'Upgrading that call to the larger model made it slower still.\n\n'
            + 'FIXED ad4c44d: helpers/supplierPayAI.js asks a small dedicated question '
            + 'first — one sentence, four fields, no business context.',
    },
    {
        signature: 'healthz-503-on-backup-warning',
        title: '/healthz returns 503 because a backup is incomplete',
        area: 'other', severity: 'normal', source: 'jarvis', status: 'open',
        detail: '/healthz returns 503 on ANY problem, and the backup check pushes '
            + '"backup_incomplete" into that list (introduced 783f4d2). A missing backup '
            + 'file is serious but it is not "this server cannot serve requests".\n\n'
            + 'Harmless today because nothing health-checks that route. The day anything '
            + 'does — a load balancer, an uptime monitor — an incomplete backup would pull '
            + 'the whole site out of service. Should be 503 for "cannot serve", '
            + '200-with-warnings for everything else.',
    },
    {
        signature: 'backup-missing-yard-stores',
        title: 'yard_claims.json and trucker_bills.json are not in the nightly backup',
        area: 'other', severity: 'blocker', source: 'jarvis', status: 'open',
        detail: 'The nightly archive reports: MISSING sales_receipts.json, '
            + 'trucker_bills.json, yard_claims.json.\n\nThis is the Edge Yard data she asked '
            + 'to be protected "no matter what". If the VM were lost tonight those three '
            + 'stores do not come back. Found by reading /healthz, not by anyone being told.',
    },
    {
        signature: 'phone-cannot-reach-jarvis-2026-10-03',
        title: 'Phone cannot reach Jarvis while a laptop on the same wifi can',
        area: 'mobile app', severity: 'blocker', source: 'her', status: 'open',
        detail: 'Same wifi: the laptop reaches jarvis.edgemetals.com, the phone does not — '
            + 'app and website both.\n\nVERIFIED NOT THE CAUSE: the server is reachable from '
            + 'the public internet (TLS completes in ~780ms, /login returns 200); DNS '
            + 'resolves on five resolvers including filtering ones; the IP is on no '
            + 'blocklist; the certificate is valid to 2026-12-04; TLS 1.2 and 1.3 are both '
            + 'accepted; HTTP/3 is disabled.\n\nSix theories have been wrong: boot failure, '
            + 'expired certificate, network block, HTTP/3, IP reputation, TLS interception. '
            + 'HTTP/3 was declared the fix and was not.\n\nSTILL UNKNOWN. Next facts needed: '
            + 'does the phone BROWSER load https://jarvis.edgemetals.com/healthz, and is '
            + 'Android Private DNS set on that phone.',
    },
    {
        signature: 'two-sessions-one-repo-stash-collision',
        title: 'Two sessions editing the same repo — uncommitted work collided twice',
        area: 'other', severity: 'high', source: 'jarvis', status: 'open',
        detail: 'Commit b049489 absorbed uncommitted files from another session under its '
            + 'own message. Later, a git stash swept up the other session\'s in-progress '
            + 'work on dashboard/voice.js; both were recovered by hand.\n\nRelated to the '
            + 'auto-committer already on the task list. With one person this is untidy; with '
            + 'customers it means a release nobody can reproduce.',
    },
];

(async () => {
    console.log(`\n${TODAY.length} bug(s) from 2026-10-03\n`);
    for (const b of TODAY) {
        console.log(`  [${b.severity.toUpperCase().padEnd(7)}] ${b.status.padEnd(5)} ${b.area.padEnd(12)} ${b.title}`);
    }
    if (!WRITE) {
        console.log('\nDry run. Re-run with --write to file these, ON THE VM.\n');
        return;
    }
    let filed = 0; let bumped = 0;
    for (const b of TODAY) {
        try {
            const before = bugs.list().length;
            const rec = await bugs.fileBug({ ...b, reported_by: 'apsara' });
            if (bugs.list().length > before) filed += 1; else bumped += 1;
            console.log(`  ok  ${rec.id || ''} ${b.title.slice(0, 60)}`);
        } catch (e) {
            console.error(`  FAILED  ${b.title.slice(0, 60)} — ${e.message}`);
        }
    }
    console.log(`\n${filed} filed, ${bumped} already there (bumped). Open the Bugzilla tab.\n`);
})().catch((e) => { console.error('could not file:', e.message); process.exit(1); });
