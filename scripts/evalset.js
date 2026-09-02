#!/usr/bin/env node
// ── scripts/evalset.js — build the 50-example eval set ──────────────────────
//
// From "Evals for Everyone" (thenuancedperspective), which Apsara sent:
//   · start with 50 REAL examples paired with expected outputs
//   · "run your system on those examples and watch it fail" — let the
//     failures choose the metrics, do not pick metrics first
//   · code evals before LLM judges; judges only for the subjective part
//   · 3-5 actionable metrics beat 20 ignored ones
//
// tests/summary-quality.js has THREE fixtures, and I have twice told her a
// score from them meant something. It does not. This builds the real thing.
//
// WHAT IT DOES NOT DO: invent the expected output. That is the one part a
// machine cannot supply — an eval set whose answers I wrote is an eval set
// that measures my opinion. It pulls real threads, runs the real pipeline,
// and writes a review file where the only missing column is her verdict.
//
//   node scripts/evalset.js --days 21 --limit 50      # build the review file
//   node scripts/evalset.js --score                   # score what she marked
//
// The review file is deliberately plain text, one block per email, because
// she reads these on a phone.

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const has = (n) => argv.includes('--' + n);

const OUT = flag('out', path.join(__dirname, '..', 'data', 'evalset.txt'));
const JSONL = OUT.replace(/\.txt$/, '.jsonl');

// ── scoring mode: read back what she marked ────────────────────────────────
if (has('score')) {
    if (!fs.existsSync(OUT)) { console.error(`No review file at ${OUT} — build it first.`); process.exit(1); }
    const blocks = fs.readFileSync(OUT, 'utf8').split(/\n(?=### )/).filter((b) => b.startsWith('### '));
    let ok = 0, bad = 0, unmarked = 0;
    const wrong = [];
    for (const b of blocks) {
        const verdict = (b.match(/^VERDICT:\s*(.*)$/m) || [])[1] || '';
        const v = verdict.trim().toLowerCase();
        if (!v || v === '?') { unmarked++; continue; }
        if (v.startsWith('ok') || v === 'y' || v === 'yes') ok++;
        else {
            bad++;
            wrong.push({
                subject: (b.match(/^### \d+\. (.*)$/m) || [])[1] || '?',
                said: (b.match(/^ *JARVIS\s*:\s*(.*)$/m) || [])[1] || '',   // the writer emits 'JARVIS : ' with a space; a mismatch here silently blanks the one column that says WHY it was wrong
                verdict: verdict.trim(),
            });
        }
    }
    const scored = ok + bad;
    console.log(`\nEVAL SET — ${blocks.length} examples, ${scored} adjudicated, ${unmarked} still blank`);
    console.log('='.repeat(70));
    if (!scored) {
        console.log('\nNothing marked yet. Open the file and put ok / wrong on each VERDICT line.');
        process.exit(0);
    }
    console.log(`\n  CORRECT   ${String(ok).padStart(3)}   ${Math.round((ok / scored) * 100)}%`);
    console.log(`  WRONG     ${String(bad).padStart(3)}   ${Math.round((bad / scored) * 100)}%`);
    if (scored < 30) {
        console.log('\n  Under 30 adjudicated. Read this as a smoke test, not a score —');
        console.log('  the article\'s bar is 50, and small sets swing wildly run to run.');
    }
    if (wrong.length) {
        console.log('\nWHAT IT GOT WRONG — this is the list that chooses the next fix.');
        console.log('The article\'s point exactly: let the failures pick the metrics.\n');
        for (const w of wrong.slice(0, 25)) {
            console.log(`  · ${w.subject.slice(0, 60)}`);
            console.log(`      said : ${w.said.slice(0, 88)}`);
            console.log(`      you  : ${w.verdict.slice(0, 88)}\n`);
        }
    }
    process.exit(0);
}

// ── build mode ─────────────────────────────────────────────────────────────
const days = Number(flag('days', 21)) || 21;
const limit = Number(flag('limit', 50)) || 50;

(async () => {
    const gmail = require('../helpers/gmail');
    const rw = require('../workflow/replyWatch');
    const client = await gmail.getGmailRead();
    if (!client) { console.error('Gmail not authorised in this DATA_DIR.'); process.exit(1); }

    const me = await gmail.getMyEmailAddress();
    const refs = await gmail.listMessages(client, `in:inbox newer_than:${days}d`, limit * 3);
    console.log(`${(refs || []).length} message(s) in the last ${days} days; assessing up to ${limit}.\n`);

    const rows = [];
    for (const ref of (refs || [])) {
        if (rows.length >= limit) break;
        let msg;
        try { msg = await gmail.getMessage(client, ref.id); } catch (e) { continue; }
        const hs = (msg.payload && msg.payload.headers) || [];
        const h = (n) => (hs.find((x) => (x.name || '').toLowerCase() === n) || {}).value || '';
        const from = h('from');
        if (me && from.toLowerCase().includes(me.toLowerCase())) continue;   // her own mail

        let thread = '';
        try {
            const t = await client.users.threads.get({ userId: 'me', id: msg.threadId, format: 'full' });
            thread = rw.buildThreadLedger((t && t.data && t.data.messages) || [], me);
        } catch (e) { /* a thread we cannot read is still a valid example */ }

        const { body, pdfParts } = gmail.getEmailContent(msg.payload || {});
        const visible = rw.extractLatestMessage(body || msg.snippet || '');
        if (!visible) continue;

        let a = null;
        try {
            a = await rw.assess({
                from, subject: h('subject'), date: gmail.parseEmailDate(h('date')), body: visible,
                thread, attachments: rw.collectAttachmentNames(msg.payload || {}, pdfParts),
                to: h('to'), cc: h('cc'), myAddress: me,
                managerAddress: (require('../config').getSettings() || {}).manager_email || null,
            });
        } catch (e) { /* a crash is itself a failing example, keep it */ }

        rows.push({
            id: ref.id, from: rw.senderLabel(from), subject: h('subject'), date: h('date'),
            summary: a && a.summary, waiting_on: a && a.waiting_on,
            needs_reply: a ? a.needs_reply : null, asked_of: a && a.asked_of,
            asked_for: a && a.asked_for, confidence: a && a.confidence,
            cappedBy: (a && a.confidence_capped_by) || [],
        });
        process.stdout.write(`\r  assessed ${rows.length}/${limit}`);
    }
    console.log('\n');

    const lines = [
        'JARVIS EVAL SET — mark each one, then run:  node scripts/evalset.js --score',
        '',
        'On every VERDICT line write:',
        '   ok           the summary and the direction are both right',
        '   wrong: ...   and say what it should have said, in a few words',
        '',
        'The "what should it have said" half is the point. A count of wrongs',
        'tells us how bad it is; your words tell us WHICH fix comes next.',
        '', '='.repeat(70), '',
    ];
    rows.forEach((r, i) => {
        lines.push(`### ${i + 1}. ${r.subject || '(no subject)'}`);
        lines.push(`  FROM   : ${r.from}`);
        lines.push(`  JARVIS : ${r.summary || '(no summary)'}`);
        lines.push(`  READS  : ${r.waiting_on === 'her' ? 'waiting on YOU'
            : r.waiting_on === 'them' ? 'they owe you'
            : r.waiting_on === 'colleague' ? `your team (${r.asked_of || '?'}) owes it`
            : r.waiting_on === 'someone_else' ? `${r.asked_of || 'someone else'} was asked`
            : 'nothing needed'}${r.needs_reply ? ' · flagged for reply' : ''}`
            + `  · confidence ${r.confidence ?? '?'}${r.cappedBy.length ? ` (capped: ${r.cappedBy.join(', ')})` : ''}`);
        lines.push('VERDICT: ');
        lines.push('');
    });
    fs.writeFileSync(OUT, lines.join('\n'));
    fs.writeFileSync(JSONL, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    console.log(`wrote ${rows.length} examples\n  review : ${OUT}\n  raw    : ${JSONL}\n`);
    console.log('Mark the VERDICT lines, then: node scripts/evalset.js --score');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
