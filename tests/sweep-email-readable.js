// Apsara, 2026-11-07 on the 06:30 "Jarvis: 138 things to look at" email: "This is also ugly". One heading per reason, items compact, the whole
// list attached as a CSV, dependencies one line each. Built from the real 138-item shape she pasted; drives the real job.run().
const fs = require('fs'), os = require('os'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-swe-')); process.env.JARVIS_TEST = '1';
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
const R = require(path.join(ROOT, 'helpers/sweepReport'));
const sweep = require(path.join(ROOT, 'helpers/integritySweep'));
const gmail = require(path.join(ROOT, 'helpers/gmail'));
const cfg = require(path.join(ROOT, 'config'));
const job = require(path.join(ROOT, 'helpers/integritySweepJob'));

const mk = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const res = { at: 'x', clean: false, checks: 9, broken: [], findings: [
    { id: 'unpriced', title: 'Outbound loads with no price, so they are not in Yard sales', why: 'the load is on the Loads tab but contributes nothing to revenue', count: 2, items: [
        { what: 'OUT_11 2026-10-05 Metalco', detail: '52,220 lb weighed, no price — price it and it appears in revenue' }, { what: 'OUT_10 2026-10-05 Metalco', detail: '43,320 lb weighed, no price — price it and it appears in revenue' }] },
    { id: 'dupes', title: 'Two invoices for the same container', why: 'the container is billed to the customer twice', count: 6,
        items: mk(6, (i) => ({ what: `CONT${i} on BKG${i} — Starter`, detail: `2 invoices: SALE_17${i}9_aaaa, SALE_17${i}8_bbbb` })) },
    { id: 'oneside', title: 'A container with only one side of the trade', why: 'sold with no bill flatters the margin', count: 34,
        items: [...mk(20, (i) => ({ what: `HMMU${i} — Edge Yard`, detail: `bought ${20 + i} days ago and not sold` })), ...mk(8, (i) => ({ what: `MSMU${i} — Tiyansh Metal`, detail: `sold ${300 + i} days ago with no bill behind it` })),
            ...mk(6, (i) => ({ what: `JC${i} — Junk car to Eccomelt`, detail: `both halves exist but the booking numbers differ (bill 43029${i}, sale PO#43029${i})` }))] },
    { id: 'bills', title: 'Bills that are still missing something', why: 'an unfinished bill has a figure nobody can rely on', count: 95,
        items: [...mk(88, (i) => ({ what: `TLLU${1000000 + i} — Mazariegos`, detail: 'needs weights, price' })), ...mk(7, (i) => ({ what: `KOCU${5100000 + i} — Modern Enterprises`, detail: 'needs weights' }))] },
    { id: 'unnamed', title: 'Entries that posted but are waiting on an answer', why: 'these ARE in the figures', count: 1, items: [{ what: '25 × a payment whose source was never named', detail: '"this payment"' }] },
] };
res.total = res.findings.reduce((a, f) => a + f.count, 0);
const dep = { findings: [
    { severity: 'high', what: 'pdf-parse is unmaintained or unofficial', why: 'a long explanation that used to take three lines', action: 'replace with a maintained parser, or stop feeding it unreviewed attachments' },
    { severity: 'critical', what: '1 critical vulnerability in installed packages', why: 'the agreed SLA for critical is 7 days', action: 'npm audit for the list; patch or record why not' } ], node: { version: 'v24.18.0', eol: '2028-04-30' }, packages: 433 };

console.log('\n=== A. the email body ===');
const old = sweep.reportText({ ...res, findings: res.findings.map((f) => ({ ...f, items: f.items.slice(0, 25), truncated: Math.max(0, f.count - 25) })) });
const text = R.compactText(res, dep, { csvName: 'jarvis-sweep-2026-11-07.csv' });
console.log(text.split('\n').map((l) => '    | ' + l).join('\n'));
ck('far shorter than the old email', text.split('\n').length < old.split('\n').length * 0.55 && text.split('\n').length < 60, `${text.split('\n').length} vs ${old.split('\n').length}`);
ck('opens with the total and points at the attached list', /^138 things to look at, in 5 areas\. Every line is in the attached jarvis-sweep-2026-11-07\.csv\./.test(text));
ck('one heading per check, with its count', ['OUTBOUND LOADS WITH NO PRICE, SO THEY ARE NOT IN YARD SALES — 2', 'BILLS THAT ARE STILL MISSING SOMETHING — 95', 'A CONTAINER WITH ONLY ONE SIDE OF THE TRADE — 34'].every((h) => text.includes(h)));
ck('bills: ONE line per reason, not 95 lines ("needs weights, price (88)")', /needs weights, price \(88\)/.test(text) && /needs weights \(7\)/.test(text) && !/KOCU5100006/.test(text));
ck('  a big group says WHO (tallied by supplier), not 95 container numbers', /needs weights, price \(88\)\n    Mazariegos 88/.test(text) && !/TLLU1000000/.test(text), text.split('BILLS THAT')[1]);
ck('  a group has the figures taken out: no first-item numbers shown as if general', /bought … days ago and not sold \(20\)/.test(text) && /sold … days ago with no bill behind it \(8\)/.test(text) && /\(bill … sale PO#…\)/.test(text), text);
ck('  a lone item is one line: what — detail', /· 25 × a payment whose source was never named: "this payment"/.test(text));
ck('one-side-of-trade: grouped by reason', /with no bill behind it \(8\)/.test(text));
ck('duplicate invoices (all-different details) fall back to a short flat list, not a wall', /Two invoices for the same container|TWO INVOICES FOR THE SAME CONTAINER — 6/.test(text) && /…and 0 more|CONT0/.test(text));
ck('the two unpriced loads are shown whole, WITH their weights (small groups keep their figures)', /OUT_11 2026-10-05 Metalco: 52,220 lb weighed, no price/.test(text) && /OUT_10 2026-10-05 Metalco: 43,320 lb/.test(text));
ck('dependencies: ONE line each, with the action', /\[high\] pdf-parse is unmaintained or unofficial — replace with a maintained parser/.test(text) && /\[critical\] 1 critical vulnerability in installed packages — npm audit/.test(text) && !/long explanation/.test(text));

console.log('\n=== B. the HTML ===');
const html = R.compactHtml(res, dep, { csvName: 'x.csv' });
ck('a summary table, headings and chips; no raw-text dump', /138 things to look at/.test(html) && /<table/.test(html) && /display:inline-block/.test(html) && !/white-space:pre/.test(html));
ck('escaped (a & or < in a name cannot break the markup)', R.compactHtml({ ...res, findings: [{ ...res.findings[0], items: [{ what: 'A & B <x>', detail: 'd' }] }] }, null, {}).includes('A &amp; B &lt;x&gt;'));

console.log('\n=== C. the attachment ===');
const csv = R.fullCsv(res);
ck('every one of the 138 is in the CSV (header + 137 item rows; the unnamed-payment check counts 25 in one row)', csv.split('\n').length === 1 + res.findings.reduce((a, f) => a + f.items.length, 0));
ck('quoted properly', /"Bills that are still missing something","TLLU1000000 — Mazariegos","needs weights, price"/.test(csv));

(async () => {
    console.log('\n=== D. the real job sends it ===');
    const sent = [];
    gmail.sendEmail = async (m) => { sent.push(m); return {}; };
    cfg.ALERT_EMAIL_TO = 'apsara@example.com';
    sweep.run = () => res;
    require(path.join(ROOT, 'helpers/depAudit')).run = async () => dep;
    const out = await job.run({ auditImpl: () => ({}) });
    const m = sent[0];
    ck('sent once, to her', out.sent === true && sent.length === 1 && m.to === 'apsara@example.com');
    ck('the body is the compact one and the HTML is the styled one', m && /^138 things to look at, in 5 areas\./.test(m.body) && /display:inline-block/.test(m.bodyHtml) && !/white-space:pre/.test(m.bodyHtml), m && m.body.slice(0, 80));
    ck('the full list is attached as a CSV', m.attachments && m.attachments.length === 1 && /^jarvis-sweep-\d{4}-\d{2}-\d{2}\.csv$/.test(m.attachments[0].filename) && m.attachments[0].mimeType === 'text/csv' && /needs weights, price/.test(m.attachments[0].content.toString('utf8')));
    ck('the returned text (other callers) is unchanged: the old per-check list, capped at 25', /Bills that are still missing something — 95/.test(out.text) && /and 70 more/.test(out.text));
    ck('subject unchanged', /^Jarvis: 138 things to look at/.test(m.subject), m.subject);
    // a small report needs no attachment
    sent.length = 0;
    sweep.run = () => ({ ...res, findings: [res.findings[0]], total: 2 });
    require(path.join(ROOT, 'helpers/depAudit')).run = async () => ({ findings: [], node: { version: 'v24' }, packages: 1 });
    await job.run({ auditImpl: () => ({}) });
    ck('five items or fewer: no attachment to open', sent[0] && sent[0].attachments === undefined && !/attached/.test(sent[0].body), JSON.stringify(sent[0] && sent[0].attachments));
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
