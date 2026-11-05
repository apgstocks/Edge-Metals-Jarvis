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
    // Apsara, 2026-11-05: "if some containers has no suppliers put one heading ... list all container below ... make it
    // crisp". One heading per reason, every container under it.
    ck('one HEADING per reason, with its count', /^Bills \u00b7 No supplier amount yet \(60\)$/m.test(text) && /^Bills \u00b7 No invoice number \(it ties the bill to its sale\) \(26\)$/m.test(text) && /^Sales \u00b7 No freight charge yet \(30\)$/m.test(text) && /^Bills \u00b7 Invoice number too long for QuickBooks \(4\)$/m.test(text), text);
    ck('headings add up to the total: nothing listed twice (60+26+4+30 = 120)', 60 + 26 + 4 + 30 === 120 && !/\(64\)/.test(text));
    const listed = (text.match(/\b(HMMU49|EMHU27|HMMU47|KOCU44)\d\d\b/g) || []);
    ck('EVERY container is listed under its heading (all 120)', listed.length === 120 && new Set(listed).size === 120, String(listed.length));
    ck('  containers only, four to a line - no per-row sentences', !/ \u2014 no supplier amount yet; grade/.test(text) && /HMMU4900,  HMMU4901,  HMMU4902,  HMMU4903/.test(text));
    ck('  grade names are not repeated 64 times', !/grade "Auto Cast"/.test(text));
    ck('  the reasons for every row are in the attached CSV, and the mail says so', /Every reason for every row: qb-stuck-rows\.csv \(attached\)\./.test(text));
    ck('the long period-lock explanation is gone (one line remains)', !/With no lock, every 2026 row/.test(text) && /Period lock \u2014/.test(text));
    ck('the headline counts are unchanged', /Entered in QuickBooks \(production\): 4/.test(text) && /bill: already-linked 48, blocked 90, created 1/.test(text));
    ck('without a csvName (the old failure path) there is no dangling attachment line', !/attached/.test(job.reportText(out)));
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
    ck('the body is short (under 90 lines with all 120 containers listed)', mailed.body.split('\n').length < 90, String(mailed.body.split('\n').length));
    ck('an HTML half is sent with section headings, escaped', /<div/.test(mailed.bodyHtml) && /STUCK/.test(mailed.bodyHtml) && !/<script/i.test(mailed.bodyHtml));
    ck('exactly one attachment: the stuck-rows CSV', Array.isArray(mailed.attachments) && mailed.attachments.length === 1 && mailed.attachments[0].filename === 'qb-stuck-rows.csv' && mailed.attachments[0].mimeType === 'text/csv');
    ck('  carrying all 121 rows', Buffer.from(mailed.attachments[0].content).toString('utf8').replace(/^﻿/, '').split('\r\n').length === 122);
    ck('the subject is unchanged in shape', /^QuickBooks — entered 4, 120 stuck, 1113 held by the period lock/.test(mailed.subject), mailed.subject);

    await digest.clear();
    await digest.record('sweep', { text: 'Entered in QuickBooks (production): 2', summary: { made: 2 } });
    let small = null;
    await digest.send({ to: 'a@b.c', mail: (o) => { small = o; }, alreadySent: async () => false, markSent: async () => {} });
    ck('a night with nothing stuck: no attachment', small && !small.attachments);
    const agent = require(path.join(ROOT, 'helpers/quickbooks/agent'));
    const longNote = 'QuickBooks refuses an account merge over the API, so the documents move instead. A bill that has already been paid is never moved: QuickBooks accepts the write and silently unapplies the payment (sandbox, 2026-10-05), which would turn settled bills back into debts.';
    const agentText = agent.reportText({ survey: { owe: { total: 1 }, owedToYou: { total: 1 }, invariants: {}, errors: {} }, did: [], dryRun: false,
        asked: [{ verdict: 'ask', title: '3 payable accounts are in use', detail: '307 bill(s) can move onto #109', note: longNote }] });
    ck('QB Agent "WAITING ON YOU" carries a count and ONE sentence per note, not the paragraph', /WAITING ON YOU \(1\)/.test(agentText) && /refuses an account merge over the API, so the documents move instead\./.test(agentText) && !/silently unapplies/.test(agentText), agentText);
    ck('HTML escapes what parts print', /&lt;b&gt;/.test(digest.digestHtml('T\n\n  <b>x</b>')));
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
