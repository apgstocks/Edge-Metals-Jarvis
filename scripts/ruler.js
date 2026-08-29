#!/usr/bin/env node
// ── scripts/ruler.js — the quality ruler, run at volume ─────────────────────
// tests/summary-quality.js scores three summaries that were pasted into it by
// hand a week ago. It is a scorer SELF-CHECK: it proves the ruler works, and
// its "53% baseline" is the score of three historical strings, not a
// measurement of what the watcher is producing now. Its --live mode has never
// once executed, because no fixture ever had a `body` captured.
//
// This is the measurement. It reads the audit log that every real scan writes
// (helpers/auditlog.js, enriched in 3eeb406) and scores every decision in it.
//
//   node scripts/ruler.js                  # today's log
//   node scripts/ruler.js --days 7         # a week
//   node scripts/ruler.js --dir /tmp/x     # a sandbox DATA_DIR
//   node scripts/ruler.js --list           # every summary, worst first
//
// It answers the one question no average can: when a summary is bad, was the
// model given anything to work with? A bad summary on a thin input is a
// HARNESS defect. A bad summary on a full thread is a JUDGEMENT defect. They
// cost different amounts to fix, and until now were indistinguishable.

const fs = require('fs');
const path = require('path');
const { scoreShape, isThin, THIN_BODY_CHARS } = require('../helpers/summaryScore');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const has = (n) => argv.includes('--' + n);

const days = Number(flag('days', 1)) || 1;
const dataDir = flag('dir', process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const logsDir = path.join(dataDir, 'logs');

if (!fs.existsSync(logsDir)) {
    console.error('No logs at ' + logsDir + '. Nothing recorded yet — run a scan first.');
    process.exit(1);
}

const files = fs.readdirSync(logsDir).filter((f) => f.endsWith('.jsonl')).sort().slice(-days);
const rows = [];
for (const f of files) {
    for (const line of fs.readFileSync(path.join(logsDir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { rows.push(JSON.parse(line)); } catch (e) { /* a truncated tail is not a crash */ }
    }
}

const mail = rows.filter((r) => r.source === 'reply_watch' && r.decision);
if (!mail.length) {
    console.error(rows.length + ' audit line(s) over ' + files.length + ' day(s), none carrying a decision block.');
    console.error('Either no mail was assessed, or the running code predates the enriched audit entry (3eeb406).');
    process.exit(1);
}

const scored = mail.map((r) => {
    const s = scoreShape(r.decision.summary);
    return {
        from: r.senderName || r.from,
        subject: r.text,
        waiting_on: r.decision.waiting_on,
        confidence: r.confidence,
        summary: s.text,
        shape: s,
        inputs: r.inputs || null,
        thin: isThin(r.inputs),
    };
});

const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
const bar = (p, w = 24) => '#'.repeat(Math.round((p / 100) * w)).padEnd(w, '.');

console.log('\nQUALITY RULER — ' + scored.length + ' decisions over ' + files.length + ' day(s)');
console.log('Source: ' + logsDir);
console.log('='.repeat(72));

const sound = scored.filter((s) => s.shape.sound);
console.log('\nSOUND SUMMARIES   ' + bar(pct(sound.length, scored.length)) + '  '
    + pct(sound.length, scored.length) + '%   (' + sound.length + '/' + scored.length + ')');
console.log('Sound = non-empty, over five words, opens with content rather than a category,');
console.log('carries something concrete, states no relative date. It does NOT mean the');
console.log('summary is TRUE — only that it is the right shape. Truth needs adjudication.');

const modes = [
    ['no summary at all',                                    (s) => s.shape.empty],
    ['under six words ("confirmation of calculations")',     (s) => s.shape.stub],
    ['opens "Sender..." — the kind of email, not what it says', (s) => s.shape.categoryOpener],
    ['a relative date that expires overnight',               (s) => s.shape.relativeDate],
    ['no figure, date, reference or name in it',             (s) => !s.shape.concrete],
];
console.log('\nFAILURE MODES');
for (const [label, test] of modes) {
    const hit = scored.filter(test);
    console.log('  ' + String(pct(hit.length, scored.length) + '%').padStart(4)
        + '  ' + String(hit.length).padStart(3) + '  ' + label);
}

const lens = scored.map((s) => s.shape.words).filter((n) => n > 0).sort((a, b) => a - b);
if (lens.length) {
    console.log('\nLENGTH  median ' + lens[Math.floor(lens.length / 2)] + ' words, range '
        + lens[0] + '-' + lens[lens.length - 1]);
    console.log('        (her own Gmail summaries, the target, run 15-22 words)');
}

const thin = scored.filter((s) => s.thin);
const fat = scored.filter((s) => !s.thin);
const soundIn = (set) => pct(set.filter((s) => s.shape.sound).length, set.length);

console.log('\n' + '='.repeat(72));
console.log('HARNESS OR JUDGEMENT?');
console.log('='.repeat(72));
console.log('\n  THIN inputs   ' + bar(soundIn(thin)) + '  ' + String(soundIn(thin)).padStart(3) + '% sound   (' + thin.length + ' decisions)');
console.log('  FULL inputs   ' + bar(soundIn(fat)) + '  ' + String(soundIn(fat)).padStart(3) + '% sound   (' + fat.length + ' decisions)');
console.log('\n  thin = no thread ledger reached the prompt, or a body under ' + THIN_BODY_CHARS + ' chars.\n');

const gap = soundIn(fat) - soundIn(thin);
if (!thin.length) {
    console.log('  Every decision had real input. Any bad summary here is a JUDGEMENT problem');
    console.log('  — the model saw the thread and still got it wrong. Fix the prompt.');
} else if (!fat.length) {
    console.log('  EVERY decision was made on thin input. This is not a model problem at all —');
    console.log('  the thread is not reaching the prompt. Check the threads.get call first.');
} else if (gap >= 20) {
    console.log('  ' + gap + ' points better on full input. The dominant defect is a HARNESS defect:');
    console.log('  the model performs when given the thread and fails when it is not.');
    console.log('  Fixing context delivery beats prompt engineering. Start with the');
    console.log('  ' + thin.length + ' thin decision(s) — why did no thread reach the prompt?');
} else if (gap <= -10) {
    console.log('  Worse on FULL input than thin, which should not happen. Suspect the thread');
    console.log('  ledger is crowding out the message itself. Check the tapered budget.');
} else {
    console.log('  Only ' + Math.abs(gap) + ' points between them. Context is NOT the bottleneck —');
    console.log('  the model fails about as often with the thread as without it. That is a');
    console.log('  JUDGEMENT problem, and more context will not fix it. Prompt, model, or the');
    console.log('  honest possibility that the task is beyond this model at this price.');
}

if (has('list')) {
    console.log('\n' + '='.repeat(72));
    console.log('EVERY DECISION — unsound first');
    console.log('='.repeat(72));
    const order = [...scored].sort((a, b) => (a.shape.sound === b.shape.sound ? 0 : a.shape.sound ? 1 : -1));
    for (const s of order) {
        const marks = [
            s.shape.empty && 'EMPTY', s.shape.stub && 'STUB',
            s.shape.categoryOpener && 'CATEGORY', s.shape.relativeDate && 'RELDATE',
            !s.shape.concrete && 'ABSTRACT',
        ].filter(Boolean);
        const i = s.inputs || {};
        console.log('\n' + (s.shape.sound ? ' ok  ' : 'BAD  ') + (s.from || '?') + ' — ' + String(s.subject || '').slice(0, 58));
        console.log('     "' + (s.summary || '(none)') + '"');
        console.log('     ' + (s.thin ? 'THIN ' : 'full ') + 'body ' + (i.bodyChars ?? '?') + 'c, thread '
            + (i.threadChars ?? '?') + 'c (' + (i.threadShown ?? '?') + ' msgs), att ' + (i.attachments ?? '?')
            + '  ·  ' + s.waiting_on + '  ·  conf ' + (s.confidence ?? '?')
            + (marks.length ? '  ·  ' + marks.join(' ') : ''));
    }
}

console.log('\nRun with --list to see every summary and the inputs behind it.\n');
