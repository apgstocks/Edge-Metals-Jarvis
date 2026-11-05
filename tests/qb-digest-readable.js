// Apsara, 2026-11-05, pasting the 4 Nov QuickBooks digest ("entered 4, 120 stuck, 1113 held by the period lock"): another
// mail she did not want to read - 25 near-identical stuck lines under a four-line essay on the period lock, plus the
// "Open the QuickBooks page" line twice. Now: one line per KIND of stuck reason with a count, five examples, the full list
// as an attached CSV, one pointer line, and a clean HTML half. Drives the real record() -> send() path.
const fs = require('fs'), os = require('os'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-qbr-')); process.env.JARVIS_TEST = '1';
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
const digest = require(path.join(ROOT, 'helpers/qbDigest'));
const job = require(path.join(ROOT, 'helpers/quickbooksNightly'));

const blocked = [];
const mk = (n, kind, who, what, why) => { for (let i = 0; i < n; i++) blocked.push({ kind, who, what: what + String(i).padStart(2, '0'), why }); };
mk(60, 'bill', 'Edge Yard', 'HMMU49', 'no supplier amount yet; grade "Auto Cast" has no amount');
mk(26, 'bill', 'Mazariegos', 'EMHU27', 'no invoice number — the number that ties this bill to its sale');
mk(4, 'bill', 'Edge Yard', 'HMMU47', 'invoice number longer than QuickBooks allows (21); no supplier amount yet; grade "HMS" has no amount');
mk(30, 'sale', 'Rad Metal', 'KOCU44', 'no freight charge yet');
const out = { ok: true, dryRun: false, env: 'production',
    result: { bill: { 'already-linked': 48, blocked: 90, created: 1 }, sale: { 'already-linked': 106, waiting: 4, blocked: 30, created: 3 }, leftAlone: { bill: 493, sale: 583, billpayment: 36, receipt: 1, from: '2025-11-25', to: '2026-09-05',
        why: { 'bill dated 2026-01-02 is before the locked period (2026-09-06) — she closed that period deliberately': 3 } } },
    blocked, asked: [{ kind: 'payment', who: 'Eccomelt', what: 'RCPT_1', why: 'same amount already arrived around this date' }] };

(async () => {
    const text = job.reportText(out, { csvName: digest.STUCK_CSV_NAME });
    const stuckLines = text.split('\n').filter((l) => /^\s+(bill|sale) /.test(l)).length;
    ck('the stuck section is by REASON: one line per kind with a count', /\s64\s+bill · no supplier amount yet/.test(text) && /\s26\s+bill · no invoice number/.test(text) && /\s30\s+sale · no freight charge yet/.test(text), text);
    ck('  the grade names are lifted out, so 64 different "grade X has no amount" are ONE line', (text.match(/a grade has no amount/g) || []).length === 1);
    ck('  only five example rows, not 25', stuckLines === 5, String(stuckLines));
    ck('  the cut points at the attachment', /full list is attached \(qb-stuck-rows\.csv\)/.test(text));
    ck('the long period-lock explanation is gone (one line remains)', !/With no lock, every 2026 row/.test(text) && /Period lock —/.test(text));
    ck('the headline counts are unchanged', /Entered in QuickBooks \(production\): 4/.test(text) && /bill: already-linked 48, blocked 90, created 1/.test(text));
    ck('the old failure path (no csvName) still reads sensibly', /on the QuickBooks page\./.test(job.reportText(out)));
    ck('decisions are untouched: out.blocked still has every row', out.blocked.length === 120);

    const csv = job.stuckCsv(out).split('\r\n');
    ck('the CSV has EVERY stuck and needs-you row (nothing lost)', csv.length === 1 + 120 + 1, String(csv.length));
    ck('  and a header a sheet can use', csv[0] === 'Status,Kind,Who,What,Why');
    ck('  quoting survives a reason with commas and quotes', /"no supplier amount yet; grade ""Auto Cast"" has no amount"/.test(csv[1]), csv[1]);

    await digest.clear();
    await digest.record('sweep', { text, csv: job.stuckCsv(out), summary: { made: 4, blocked: 120, left: 1113 } });
    await digest.record('agent', { text: 'Nothing to place today.\n\nWHERE THE BOOKS ARE NOT YET RIGHT\n  Documents doubled: $122,810.60 — 10 to look at\n\nOpen the QuickBooks page in Jarvis to act on any of this.\n\nOpen the QuickBooks page in Jarvis to fix a stuck row or undo anything here.', summary: { open: 4 } });
    let mailed = null;
    const r = await digest.send({ to: 'apsara@edgemetals.com', mail: (o) => { mailed = o; }, alreadySent: async () => false, markSent: async () => {} });
    ck('the digest sent', r.sent === true && !!mailed, JSON.stringify(r).slice(0, 160));
    ck('the pointer line appears ONCE, not once per part', (mailed.body.match(/Open the QuickBooks page in Jarvis to fix a stuck row or undo anything here\./g) || []).length === 1, String((mailed.body.match(/Open the QuickBooks page/g) || []).length));
    ck('the body is short (under 60 lines for 120 stuck rows)', mailed.body.split('\n').length < 60, String(mailed.body.split('\n').length));
    ck('an HTML half is sent with section headings, escaped', /<div/.test(mailed.bodyHtml) && /STUCK/.test(mailed.bodyHtml) && !/<script/i.test(mailed.bodyHtml));
    ck('exactly one attachment: the stuck-rows CSV', Array.isArray(mailed.attachments) && mailed.attachments.length === 1 && mailed.attachments[0].filename === 'qb-stuck-rows.csv' && mailed.attachments[0].mimeType === 'text/csv');
    ck('  carrying all 121 rows', Buffer.from(mailed.attachments[0].content).toString('utf8').replace(/^﻿/, '').split('\r\n').length === 122);
    ck('the subject is unchanged in shape', /^QuickBooks — entered 4, 120 stuck, 1113 held by the period lock/.test(mailed.subject), mailed.subject);

    await digest.clear();
    await digest.record('sweep', { text: 'Entered in QuickBooks (production): 2', summary: { made: 2 } });
    let small = null;
    await digest.send({ to: 'a@b.c', mail: (o) => { small = o; }, alreadySent: async () => false, markSent: async () => {} });
    ck('a night with nothing stuck: no attachment', small && !small.attachments);
    ck('HTML escapes what parts print', /&lt;b&gt;/.test(digest.digestHtml('T\n\n  <b>x</b>')));
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
