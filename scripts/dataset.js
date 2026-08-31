#!/usr/bin/env node
// ── scripts/dataset.js — turn the audit log into a labelled training set ────
//
// Apsara, 31 Aug: "start collecting data for our model".
//
// Collection was already the hard part and it is now done: ignoreDigestItem
// writes a dismissal, replyToDigestItem writes an answer. This is the other
// half — a scattering of JSONL lines is not a dataset. It becomes one when
// each LABEL is joined back to the FEATURES that were in front of the model
// at the moment it decided, which live on a different row written hours or
// days earlier, keyed by message id.
//
//   node scripts/dataset.js                 # what we have so far
//   node scripts/dataset.js --days 60
//   node scripts/dataset.js --out train.jsonl
//   node scripts/dataset.js --csv train.csv
//
// WHAT IS DELIBERATELY NOT COLLECTED: message bodies, subjects, summaries,
// counterparty addresses. Only shapes and counts. Same rule as the audit log
// itself — this must not quietly become a second copy of the mailbox, and a
// model trained on sizes and structure is one whose reasoning can be read.
// The label rows carry the text; the feature rows never do.

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };

const days = Number(flag('days', 90)) || 90;
const dataDir = flag('dir', process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const logsDir = path.join(dataDir, 'logs');
const outJsonl = flag('out', null);
const outCsv = flag('csv', null);

if (!fs.existsSync(logsDir)) {
    console.error(`No logs at ${logsDir} — nothing has been recorded yet.`);
    process.exit(1);
}

const rows = [];
for (const f of fs.readdirSync(logsDir).filter((x) => x.endsWith('.jsonl')).sort().slice(-days)) {
    for (const line of fs.readFileSync(path.join(logsDir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { rows.push(JSON.parse(line)); } catch (e) { /* truncated tail */ }
    }
}

// ── the join ───────────────────────────────────────────────────────────────
// Two kinds of row, written at different times:
//   resolvedBy 'ai'    — the assessment. Carries `inputs`: what reached the
//                        model. These are the FEATURES.
//   resolvedBy 'human' — her verdict, hours or days later. This is the LABEL.
// A label with no matching assessment is unusable: we would know what she
// decided and nothing about what she decided it FROM. Those are counted and
// reported rather than dropped in silence, because a high orphan rate means
// the join key is broken, not that she has been quiet.
const features = new Map();
for (const r of rows) {
    if (r.source === 'reply_watch' && r.resolvedBy === 'ai' && r.messageId && r.inputs) {
        features.set(r.messageId, r);          // last assessment wins
    }
}

const LABEL = { not_work_for_me: 0, worth_my_reply: 1 };
const examples = [];
let orphans = 0;
const seenLabel = new Set();
for (const r of rows) {
    if (r.resolvedBy !== 'human' || !(r.humanVerdict in LABEL)) continue;
    // One label per message. She can dismiss the same item twice across two
    // digests; counting it twice would silently weight it double.
    const key = r.messageId || `${r.from}|${r.text}`;
    if (seenLabel.has(key)) continue;
    seenLabel.add(key);

    const f = r.messageId ? features.get(r.messageId) : null;
    if (!f) { orphans++; continue; }

    const i = f.inputs || {}, d = f.decision || {};
    examples.push({
        label: LABEL[r.humanVerdict],
        labelName: r.humanVerdict,
        // ── features: what the harness knew, no content ──
        bodyChars: i.bodyChars ?? null,
        threadChars: i.threadChars ?? null,
        threadShown: i.threadShown ?? null,
        attachments: i.attachments ?? null,
        hadHistory: i.historyPrior ? 1 : 0,
        onToLine: i.to && i.managerAddress
            ? (String(i.to).toLowerCase().includes(String(i.managerAddress).toLowerCase()) ? 1 : 0) : null,
        ccCount: i.cc ? String(i.cc).split(',').filter(Boolean).length : 0,
        // ── the model's own call, which is itself a strong feature ──
        waitingOn: d.waiting_on ?? null,
        needsReply: d.needs_reply ? 1 : 0,
        hasAskedFor: d.asked_for ? 1 : 0,
        hasDeadline: d.deadline ? 1 : 0,
        urgency: d.urgency ?? null,
        confidence: f.confidence ?? null,
        confidenceRaw: f.confidenceRaw ?? null,
        cappedBy: (f.confidenceCappedBy || []).join('|') || null,
        // ── provenance, so any example can be traced back ──
        messageId: r.messageId, assessedAt: f.at, labelledAt: r.at,
    });
}

// ── report ─────────────────────────────────────────────────────────────────
const pos = examples.filter((e) => e.label === 1).length;
const neg = examples.length - pos;
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

console.log(`\nTRAINING SET — ${examples.length} usable example(s) from ${rows.length} audit row(s)`);
console.log('='.repeat(68));
console.log(`  worth_my_reply  (1)   ${String(pos).padStart(4)}   ${pct(pos, examples.length)}%`);
console.log(`  not_work_for_me (0)   ${String(neg).padStart(4)}   ${pct(neg, examples.length)}%`);
if (orphans) {
    console.log(`\n  ${orphans} label(s) had no matching assessment and were dropped.`);
    console.log('  A high number here means the join key is broken, not that she was quiet —');
    console.log('  the assessment row is written by the scan, the label by her reply.');
}

// The advice is the point. A number with no verdict attached is how a dataset
// gets used three months too early.
console.log('\nREADINESS');
if (!examples.length) {
    console.log('  Nothing yet. Collection starts the first time she says "ignore N" or');
    console.log('  "reply to N" AFTER this is deployed — earlier dismissals were never');
    console.log('  recorded and cannot be recovered.');
} else if (examples.length < 50) {
    console.log(`  ${examples.length} examples. Far too few to train anything; keep collecting.`);
    console.log('  Useful now only as a check that both labels are actually arriving.');
} else if (Math.min(pos, neg) < 20) {
    console.log(`  ${examples.length} examples but only ${Math.min(pos, neg)} of the minority class.`);
    console.log('  A model trained here would learn to predict the majority and score well');
    console.log('  doing it. Wait for the thin side, not the total.');
} else if (examples.length < 200) {
    console.log(`  ${examples.length} examples, both classes present. Enough to FIT something small`);
    console.log('  (logistic regression on these features) and see whether the signal is real.');
    console.log('  Not enough to trust it in front of her — hold out 30% and read precision');
    console.log('  on the HIDE decision, which is the one that can lose a container.');
} else {
    console.log(`  ${examples.length} examples, ${Math.min(pos, neg)} in the minority class. Enough for a`);
    console.log('  real attempt. Split by TIME, not at random — a random split leaks the');
    console.log('  future into training and every score comes back flattering.');
}

if (outJsonl) {
    fs.writeFileSync(outJsonl, examples.map((e) => JSON.stringify(e)).join('\n') + '\n');
    console.log(`\nwrote ${examples.length} example(s) -> ${outJsonl}`);
}
if (outCsv) {
    const cols = Object.keys(examples[0] || { label: 0 });
    const esc = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    fs.writeFileSync(outCsv, [cols.join(','), ...examples.map((e) => cols.map((c) => esc(e[c])).join(','))].join('\n') + '\n');
    console.log(`\nwrote ${examples.length} row(s) -> ${outCsv}`);
}
console.log('');
