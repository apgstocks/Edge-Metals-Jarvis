#!/usr/bin/env node
// ── scripts/importance-report.js — what WOULD the notifier have done? ───────
//
// Apsara, 2026-09-17: "notify if there is any improtant mail."
//
// I promised her this before the importance axis was allowed to notify her
// about anything, and the reason is the whole history of this file's
// neighbours: every filter in replyWatch.js that started acting silently
// ended up hiding something real, and she only found out weeks later by
// noticing an absence.
//
// So this scores a window of her REAL mail with the REAL importance function
// and prints the decisions, grouped by what would have happened. Read-only:
// no store writes, no sends, no Gemini calls at all — importanceOf() needs
// none, which is the point of deriving it from the sender's own sentences
// instead of asking a model.
//
//   node scripts/importance-report.js                 # 7 days
//   node scripts/importance-report.js --days 14
//   node scripts/importance-report.js --level critical
//
// READ THE "WOULD HAVE GONE QUIET" SECTION FIRST. Anything real in there is
// the cost of switching this on, and it is the only section that can hide
// something.
const path = require('path');
require(path.join(__dirname, '..', 'node_modules', 'dotenv')).config();
const R = (p) => path.join(__dirname, '..', p);
const cfg = require(R('config.js'));
const { loadJson } = require(R('helpers/json.js'));
const gmailH = require(R('helpers/gmail.js'));
const rw = require(R('workflow/replyWatch.js'));
const importance = require(R('helpers/mailImportance.js'));

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const days = Number(flag('days', 7)) || 7;
const onlyLevel = flag('level', null);

const H = (m, n) => ((m.payload && m.payload.headers) || [])
    .find((h) => (h.name || '').toLowerCase() === n.toLowerCase())?.value || '';

(async () => {
    const mailboxes = await gmailH.getGmailReadMailboxes();
    if (!mailboxes.length) { console.error('No readable mailbox.'); process.exit(1); }
    console.log(`Reading: ${mailboxes.map((m) => m.address).join(', ')}`);

    const store = rw.loadStore();
    const contacts = loadJson(cfg.EMAIL_CONTACTS_FILE, []);
    const bookings = loadJson(cfg.BOOKINGS_FILE, null);
    // The same predicate the scan builds, from the same three records, so
    // this report cannot be kinder than production.
    const isKnownCounterparty = rw.knownCounterpartyTest(
        store, contacts, mailboxes.map((m) => m.address));
    // THE REPORT MUST REFUSE TO MISLEAD. The counterparty ledgers live in the
    // store, and the real store is on the VM -- on a laptop they are empty, so
    // every one of her customers reads as a stranger and the admin section
    // fills up with real business. It did exactly that on the first run.
    const ledgerSize = Object.keys(store.sentIndex || {}).length
        + Object.keys(store.senderStats || {}).length;
    const ledgerThin = ledgerSize < 20;
    console.log(`Counterparty record: ${Object.keys(store.sentIndex || {}).length} sent, `
        + `${Object.keys(store.senderStats || {}).length} known senders, ${(contacts || []).length} contacts`);
    if (ledgerThin) {
        console.log('');
        console.log('  !! THE COUNTERPARTY LEDGER IS EMPTY OR NEARLY SO.');
        console.log('     Every domain except her own therefore reads as a stranger, so the');
        console.log('     "would go quiet" numbers below are MEANINGLESS and will be far too');
        console.log('     high. The real sentIndex/senderStats live in the VM\'s DATA_DIR.');
        console.log('     Run this report THERE, or copy data/reply_watch.json down first.');
        console.log('');
    }
    console.log(`Bookings on file: ${bookings ? Object.keys(bookings).length : 0}`
        + `${bookings ? '' : '  (schedule-change detection OFF — nothing to compare against)'}`);

    const after = new Date(Date.now() - days * 86400000);
    const q = `after:${after.getFullYear()}/${after.getMonth() + 1}/${after.getDate()}`
        + ' in:inbox -from:me -category:promotions -category:social';

    const rows = [];
    const seenRfc = new Set();
    for (const mb of mailboxes) {
        let refs = [];
        try { refs = await gmailH.listMessages(mb.client, q, 200); }
        catch (e) { console.error(`  ${mb.address}: list failed — ${e.message}`); continue; }
        for (const ref of refs) {
            const msg = await gmailH.getMessage(mb.client, ref.id).catch(() => null);
            if (!msg) continue;
            const rfc = H(msg, 'Message-ID');
            if (rfc && seenRfc.has(rfc)) continue;      // same dedupe the scan uses
            if (rfc) seenRfc.add(rfc);
            const from = H(msg, 'From'), subject = H(msg, 'Subject') || '(no subject)';
            if (mb.address && from.toLowerCase().includes(mb.address)) continue;
            const prefiltered = rw.NEVER_REPLY_PATTERNS.some((re) => re.test(from))
                || gmailH.isAutoReply((msg.payload || {}).headers || [])
                || rw.bulkMailSignal((msg.payload || {}).headers || []) === 'definitive';
            const { body, pdfParts } = gmailH.getEmailContent(msg.payload || {});
            const visible = rw.extractLatestMessage(body || msg.snippet || '');
            const imp = importance.importanceOf({
                subject, body: visible, thread: '',
                bookings, from, isKnownCounterparty,
                // The SAME parser and anchor the scan injects, so this report
                // cannot be more or less urgent than production. Its first
                // run scanned the whole message for a date instead and
                // produced 37 false criticals off stale ERDs in subject
                // lines -- see cutoffImminence.
                parseDate: rw.parseDeadline,
                receivedAt: (() => {
                    const d = new Date(gmailH.parseEmailDate(H(msg, 'Date')));
                    return isNaN(d.getTime()) ? new Date() : d;
                })(),
            });
            rows.push({ mailbox: mb.address, from, subject, prefiltered, imp,
                        date: (H(msg, 'Date') || '').slice(0, 16) });
        }
    }

    const live = rows.filter((r) => !r.prefiltered);
    const at = (lvl) => live.filter((r) => r.imp.level === lvl);
    console.log(`\n${'='.repeat(74)}`);
    console.log(`${rows.length} emails over ${days} days  (${rows.length - live.length} pre-filtered as bulk/auto)`);
    console.log('='.repeat(74));
    console.log(`  WOULD INTERRUPT HER NOW   ${at('critical').length}`);
    console.log(`  WOULD GO IN THE DIGEST    ${at('high').length}`);
    console.log(`  no importance promotion   ${at('normal').length}   (shown only if the existing gates want it)`);
    console.log(`  WOULD GO QUIET            ${at('low').length}   of which admin: ${live.filter((r) => r.imp.admin).length}`);

    const show = (title, list, note) => {
        console.log(`\n${'─'.repeat(74)}\n${title}  (${list.length})`);
        if (note) console.log(note);
        for (const r of list) {
            console.log(`\n  ${r.date}  ${r.from.replace(/<.*/, '').trim().slice(0, 34)}`);
            console.log(`  ${r.subject.slice(0, 70)}`);
            if (r.imp.because) console.log(`     WHY: ${r.imp.because.slice(0, 150)}`);
            if (r.imp.refs.length) console.log(`     refs: ${r.imp.refs.map((x) => x.kind + '=' + x.quote).join(', ').slice(0, 100)}`);
            if (r.imp.admin) console.log(`     admin: no live reference, and we have never emailed this domain`);
        }
    };

    if (!onlyLevel || onlyLevel === 'critical') {
        show('WOULD INTERRUPT HER IMMEDIATELY', at('critical'),
            '  A date we HELD has changed, something has broken, or a cutoff is inside two days.\n'
            + '  If anything here is routine, the interruption budget is being spent wrongly.');
    }
    if (!onlyLevel || onlyLevel === 'low') {
        // DELIBERATELY LAST AND DELIBERATELY FULL. This is the only section
        // that can hide something, so it is the one printed without a cap.
        if (ledgerThin) {
            console.log(`\n${'─'.repeat(74)}\nWOULD HAVE GONE QUIET  (${at('low').length}) — NOT PRINTED`);
            console.log('  Suppressed on purpose: with an empty counterparty ledger this list is');
            console.log('  mostly her own customers, and printing it would invite a decision off a');
            console.log('  number that is wrong. Run the report where the real store is.');
        } else
        show('WOULD HAVE GONE QUIET — READ THIS ONE', at('low'),
            '  Watched and recorded, never notified. Anything real in this list is the\n'
            + '  cost of switching the admin rule on. Adding the sender\'s domain to\n'
            + '  data/email_contacts.json, or ever emailing them, moves it out.');
    }
    if (onlyLevel === 'high') show('WOULD GO IN THE NEXT DIGEST', at('high'));
    console.log('');
})().catch((e) => { console.error('CRASH', e.message); process.exit(1); });
