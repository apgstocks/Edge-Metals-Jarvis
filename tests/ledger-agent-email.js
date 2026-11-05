// Apsara, 2026-11-05, on the 4 Nov Ledger agent mail (191 things, ~900 lines): "this looks ugly, i dont feel like reading
// this mail at all". The mail is now a summary: counts per kind, same-container rows merged, a few lines per kind, the full
// list as an attached CSV, plus a clean HTML half. This drives the REAL job.run() with the 4 Nov shape of findings and
// reads what would be mailed. Nothing is hidden - it is moved to the attachment.
const fs = require('fs'), os = require('os'), path = require('path');
process.env.JARVIS_TEST = '1';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-lae-'));
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
const cfg = require('../config');
const agent = require('../helpers/ledgerAgent');
const job = require('../helpers/ledgerAgentJob');
cfg.LEDGER_AGENT_EMAILS = 'apsara@edgemetals.com';

// The 4 Nov mail's shape: unpriced loads, unsold/unbilled containers, ~40 containers each with several sheet fields.
const F = [];
F.push({ check: 'unpriced', title: 'Weighed, not priced', what: 'OUT_11 2026-10-05 Metalco', detail: '52,220 lb weighed, no price' });
F.push({ check: 'unpriced', title: 'Weighed, not priced', what: 'OUT_10 2026-10-05 Metalco', detail: '43,320 lb weighed, no price' });
for (let i = 0; i < 25; i++) F.push({ check: 'unsold', title: 'Bought and not sold', what: `HMMU${4000000 + i} - Edge Yard`, detail: `bought ${20 + i} days ago and not sold` });
for (let i = 0; i < 40; i++) for (const fld of ['supplier_price', 'trucking_amount', 'advance']) {
    F.push({ check: 'sheet-diff', ledger: 'bills', row_id: 'r' + i, title: 'Missing in Jarvis', what: `KOCU${5000000 + i} — Rad Metal`,
        detail: `${fld}: sheet says ${i + 1}.07, Jarvis has nothing`, fix: { field: fld, from: '', to: `${i + 1}.07`, from_source: 'the sheet', needs_her: false } });
}
const realCollect = agent.collect;
agent.collect = () => ({ findings: F, broken: [] });

(async () => {
    let mailed = null;
    const run = await job.run({ send: (o) => { mailed = o; }, alreadySent: async () => false, markSent: async () => {} });
    agent.collect = realCollect;
    ck('the mail was sent', !!mailed, JSON.stringify(run).slice(0, 200));
    const lines = String(mailed.body).split('\n').length;
    ck(`the body is SHORT: ${F.length} findings fit in under 60 lines (was ~3 lines each)`, lines < 60, String(lines));
    ck('the subject still says how many need her', /Ledger agent — \d+ things need you/.test(mailed.subject), mailed.subject);
    ck('it opens with the count', /^\d+ things need you\./.test(mailed.body));
    ck('a count per kind is at the top', /Weighed, not priced/.test(mailed.body.split('Weighed, not priced (')[0]) && /Bought and not sold/.test(mailed.body));
    ck('one container is ONE entry carrying all three of its fields', /KOCU5000000 — Rad Metal\n\s+supplier_price: \(blank\) → 1\.07/.test(mailed.body)
        && (mailed.body.match(/KOCU5000000/g) || []).length === 1, mailed.body.slice(0, 1200));
    ck('both figures and their source are still shown on a proposal', /\(blank\) → 1\.07\s+\(the sheet\)/.test(mailed.body));
    ck('the cut is said out loud ("...and N more") and points at the attachment', /\.\.\.and \d+ more/.test(mailed.body) && /full list is attached/i.test(mailed.body));
    ck('an HTML half is sent, with inline styles and no raw script', /<table/.test(mailed.bodyHtml) && !/<script/i.test(mailed.bodyHtml));
    ck('exactly one attachment, a CSV named for the date', Array.isArray(mailed.attachments) && mailed.attachments.length === 1 && /^ledger-agent-\d{4}-\d{2}-\d{2}\.csv$/.test(mailed.attachments[0].filename) && mailed.attachments[0].mimeType === 'text/csv');
    const csv = Buffer.from(mailed.attachments[0].content).toString('utf8').replace(/^﻿/, '');
    const rows = csv.split('\r\n');
    ck('NOTHING is lost: the CSV has every finding (header + all of them)', rows.length === F.length + 1, `${rows.length} rows for ${F.length} findings`);
    ck('  including a container deep in the list the body cut', /KOCU5000039/.test(csv));
    ck('  with headers a sheet can use', /^Status,Kind,What,Detail,Field,Jarvis has,Should be,Source/.test(rows[0]));

    // "list all container below": a kind whose findings all say the same thing lists EVERY container under one heading.
    ck('a kind of identical findings lists ALL its containers, uncapped (25 of 25)', (mailed.body.match(/HMMU40000\d\d/g) || []).length === 25, String((mailed.body.match(/HMMU40000\d\d/g) || []).length));
    ck('  under one heading, with the count', /^Bought and not sold \(25\)$/m.test(mailed.body));
    ck('  three to a line, not one sentence per row', /HMMU4000000 - Edge Yard   \u00b7   HMMU4000001 - Edge Yard   \u00b7   HMMU4000002 - Edge Yard/.test(mailed.body));
    ck('  and no "bought N days ago" sentence repeated 25 times', (mailed.body.match(/bought \d+ days ago/g) || []).length === 0);
    ck('  OUT_11 keeps "lb weighed" in the body', /OUT_11[\s\S]{0,80}\d+ lb weighed/.test(mailed.body), mailed.body.slice(0, 600));
    ck('a kind that carries VALUES still shows both figures (capped, rest in the CSV)', /\(blank\) \u2192 1\.07\s+\(the sheet\)/.test(mailed.body) && /\.\.\.and 35 more/.test(mailed.body));

    // A quiet, small day stays a plain short mail with no attachment.
    agent.collect = () => ({ findings: [{ check: 'x', title: 'Weighed, not priced', what: 'OUT_1', detail: '10 lb weighed, no price' }], broken: [] });
    let small = null;
    await job.run({ send: (o) => { small = o; }, alreadySent: async () => false, markSent: async () => {} });
    agent.collect = realCollect;
    ck('a small day: no attachment, no "...and more"', small && !small.attachments && !/\.\.\.and \d+ more/.test(small.body), JSON.stringify(small && small.attachments));
    ck('nothing at all: still no mail', agent.reportText({ settled: [], proposed: [], broken: [] }) === null && agent.reportHtml({ settled: [], proposed: [], broken: [] }) === null);
    ck('HTML escapes what it prints', /&lt;b&gt;/.test(agent.reportHtml({ settled: [], broken: [], proposed: [{ what: '<b>x</b>', title: 'T' }] })));
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
