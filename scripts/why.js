#!/usr/bin/env node
// ── scripts/why.js — "why did Jarvis say that?" ─────────────────────────────
//
// From the Tau teardown (Apsara, 2026-08-29). helpers/auditlog.js has always
// been the append-only per-day JSONL log that article describes. Six modules
// write to it; until now only dailyLearning read it, and it recorded too
// little to answer anything.
//
// The workflow this replaces: she pastes a bad digest line into chat, and I
// reverse-engineer the cause from source. That happened roughly ten times in
// one week. Every one of those was answerable from a log that already existed.
//
//   node scripts/why.js                      # today's decisions
//   node scripts/why.js --days 3             # last 3 days
//   node scripts/why.js Kristal              # anything matching a sender/subject
//   node scripts/why.js --id 199a1b2c3d      # one message id
//   node scripts/why.js --flagged            # only what reached her
//   node scripts/why.js --thin               # decisions made on almost no input
//   node scripts/why.js --json               # raw entries, for piping
//
// --thin is the one to reach for first. It lists decisions taken with an empty
// thread ledger or a two-line body — the input condition behind almost every
// "the summary is wrong" report, and invisible without this.
const fs = require('fs');
const path = require('path');
const cfg = require(path.join(__dirname, '..', 'config.js'));

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : d; };
const terms = argv.filter((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--days' && argv[argv.indexOf(a) - 1] !== '--id');

const days = parseInt(opt('--days', '1'), 10) || 1;
const wantId = opt('--id', null);

// Same LA-day filenames appendAuditLog writes.
const dayKey = (d) => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(d);

const entries = [];
for (let i = 0; i < days; i++) {
    const f = path.join(cfg.DATA_DIR, 'logs', `${dayKey(new Date(Date.now() - i * 86400000))}.jsonl`);
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { entries.push(JSON.parse(line)); } catch (e) { /* a truncated final line is normal */ }
    }
}

let rows = entries.filter((e) => e.source === 'reply_watch');
if (wantId) rows = rows.filter((e) => String(e.messageId || '').includes(wantId));
if (flag('--flagged')) rows = rows.filter((e) => e.actionTaken === 'flagged');
if (terms.length) {
    const hay = (e) => JSON.stringify(e).toLowerCase();
    rows = rows.filter((e) => terms.every((t) => hay(e).includes(t.toLowerCase())));
}
// Thin input: no thread at all, or a body short enough that there was little
// to summarise. Both are harness failures, not model failures.
if (flag('--thin')) rows = rows.filter((e) => (e.inputs || {}).threadShown === 0 || ((e.inputs || {}).bodyChars || 0) < 200);

if (flag('--json')) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }

if (!rows.length) {
    console.log(`No reply_watch decisions in the last ${days} day(s)${terms.length ? ` matching ${terms.join(' ')}` : ''}.`);
    console.log(`Looked in ${path.join(cfg.DATA_DIR, 'logs')}. An empty logs/ dir means this is not the machine the bot runs on.`);
    process.exit(0);
}

const pad = (s, n) => String(s == null ? '' : s).slice(0, n).padEnd(n);
let thin = 0, noThread = 0;

for (const e of rows) {
    const d = e.decision || {};
    const i = e.inputs || {};
    if (i.threadShown === 0) noThread++;
    if ((i.bodyChars || 0) < 200) thin++;
    console.log('─'.repeat(76));
    console.log(`${e.at}   ${e.senderName || '?'}`);
    console.log(`  subject   ${e.text || ''}`);
    console.log(`  verdict   ${e.intent}  (${e.actionTaken}, confidence ${e.confidence})`);
    if (d.summary) console.log(`  said      "${d.summary}"`);
    if (d.action_needed) console.log(`  action    → ${d.action_needed}`);
    const who = [d.waiting_on && `waiting_on=${d.waiting_on}`, d.asked_of && `asked_of=${d.asked_of}`,
        d.asked_for && `asked_for=${d.asked_for}`, d.deadline && `deadline=${d.deadline}`].filter(Boolean);
    if (who.length) console.log(`  fields    ${who.join('  ')}`);
    if ((d.key_figures || []).length) {
        console.log(`  figures   ${d.key_figures.map((f) => (f && f.label ? `${f.label}: ${f.value}` : (f && f.value) || f)).join('  ·  ')}`);
    }
    // The half that explains a bad answer.
    console.log(`  INPUTS    body ${i.bodyChars ?? '?'} chars   thread ${i.threadShown ?? '?'} msgs (${i.threadChars ?? '?'} chars)   attachments ${i.attachments ?? '?'}   prior ${i.historyPrior ? 'yes' : 'no'}`);
    if (i.to) console.log(`            to  ${pad(i.to, 62)}`);
    if (i.cc) console.log(`            cc  ${pad(i.cc, 62)}`);
}

console.log('─'.repeat(76));
console.log(`${rows.length} decision(s) over ${days} day(s).`);
console.log(`${noThread} judged with NO thread context, ${thin} on a body under 200 chars.`);
if (noThread) console.log(`\nA wrong summary on any of those ${noThread} is a HARNESS problem, not a model one —\nthe thread never reached the prompt. Check the threads.get call before the prompt.`);
