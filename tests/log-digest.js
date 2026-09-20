// ── tests/log-digest.js ─────────────────────────────────────────────────────
// Apsara, 2026-09-20: "I want to have an agent which reads all the logs and
// suggest improvements next day".
//
// ── THE FIXTURE IS YESTERDAY, VERBATIM ──────────────────────────────────────
// Not invented log lines. On 2026-09-19 every email with an attachment threw,
// on all three send paths, while 134 test files were green — and
// `[sale-invoice] send failed: Cannot read properties of undefined (reading
// 'replace')` was sitting in data/logs/pm2-error.log the first time anyone
// pressed Send. Nobody reads that file, so the first reader was her.
//
// So the test is: given that day's logs, does this find that bug, put it near
// the top, and say it is new? If it cannot, the whole thing is decoration.
//
// ── AND WHAT IT MUST NOT DO ─────────────────────────────────────────────────
// A daily report earns its place by being READ. Three ways it stops being
// read, each guarded below:
//   - ten thousand rows of the same fault with different container numbers;
//   - yesterday's noise presented as today's news;
//   - a model's opinion presented as a finding.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-logd-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const logDigest = require(path.join(ROOT, 'helpers/logDigest'));

const LOGS = path.join(TMP, 'logs');
fs.mkdirSync(LOGS, { recursive: true });

// ── THE 19th ───────────────────────────────────────────────────────────────
const PM2 = [
    // The day before, so "new" has something to mean.
    '2026-09-18T22:10:01: [BILLS] could not read payments: ENOENT',
    '2026-09-18T23:00:00: [ACTIONS] forward FAILED for AAAU1111111/1 → Sher Trucking',
    // The real one.
    "2026-09-19T08:12:03: [sale-invoice] send failed: TypeError: Cannot read properties of undefined (reading 'replace')",
    '2026-09-19T08:12:03:     at buildMimeMessage (/home/apsara/Edge-Metals-Jarvis/helpers/gmail.js:487:29)',
    '2026-09-19T08:12:03:     at sendEmail (/home/apsara/Edge-Metals-Jarvis/helpers/gmail.js:640:11)',
    "2026-09-19T09:01:44: [sale-invoice] send failed: TypeError: Cannot read properties of undefined (reading 'replace')",
    "2026-09-19T09:40:12: [sale-invoice] send failed: TypeError: Cannot read properties of undefined (reading 'replace')",
    // A lost write — the one that outranks everything.
    '2026-09-19T10:00:00: [JSON] Save failed /home/apsara/data/sales.json: EBUSY',
    '2026-09-19T10:00:01: [JSON] wrote WITHOUT the lock after repeated failures — a concurrent update may have been lost',
    // Swallowed on purpose. Nobody saw these.
    '2026-09-19T11:02:00: [BILLS] could not read payments: ENOENT',
    '2026-09-19T11:30:00: [invoice] saving version history failed (non-fatal): EACCES',
    // The same fault, three containers. One problem, not three.
    '2026-09-19T13:00:00: [ACTIONS] forward FAILED for HMMU7060866/1 → Sher Trucking',
    '2026-09-19T13:01:00: [ACTIONS] forward FAILED for TCLU9988776/1 → Sher Trucking',
    '2026-09-19T13:02:00: [ACTIONS] forward FAILED for MSKU1629380/1 → Sher Trucking',
    // Timings nothing has ever read.
    '2026-09-19T12:00:00: [PDF-TIME] invoice both total 812ms — launch-chromium 300ms',
    '2026-09-19T12:05:00: [PDF-TIME] invoice both total 1440ms — launch-chromium 900ms',
    // ── A LINE WITH MARKUP IN IT ────────────────────────────────────────
    // Real log lines carry < > and & — an email header, a shell redirect, a
    // company called "A & B". Without one here the escaper is a no-op and a
    // mutation removing it stays green, which is exactly what happened.
    '2026-09-19T14:00:00: [ACTIONS] draft failed for "A & B <Ltd>" <ab@x.example>: EACCES',
    // ── AND ENOUGH DISTINCT FAULTS TO EXCEED THE 15-ROW CAP ─────────────
    // The terminal truncates at 15; the email must not. With six problems
    // both look identical, so a mutation truncating the email survived.
    ...Array.from({ length: 18 }, (_, i) =>
        `2026-09-19T15:${String(i).padStart(2, '0')}:00: [SCHED] job-${i} failed: distinct reason ${i}`),
    // The day after. Must not appear in the 19th's report.
    '2026-09-20T02:00:00: [HARVEST] skipped a message: 404',
].join('\n');
fs.writeFileSync(path.join(LOGS, 'pm2-error.log'), PM2 + '\n');
fs.writeFileSync(path.join(LOGS, '2026-09-19.jsonl'),
    '{"at":"2026-09-19T08:00:00Z","intent":"send_shipment_docs","resolvedBy":"policy"}\n'
  + '{"at":"2026-09-19T09:00:00Z","intent":"send_shipment_docs","resolvedBy":"model"}\n'
  + '{"at":"2026-09-19T10:00:00Z","intent":"bills_query","resolvedBy":"policy"}\n'
  + 'not json at all\n');

const lines = logDigest.readLines([path.join(LOGS, 'pm2-error.log')]);
const prev = logDigest.digest(lines, { onDay: '2026-09-18' });
const d = logDigest.digest(lines, { onDay: '2026-09-19', previousSignatures: prev.items.map((i) => i.sig) });

(async () => {

// ── A. IT FINDS THE BUG SHE FOUND ───────────────────────────────────────────
section('A. the one the tests missed');
{
    const send = d.items.find((i) => /sale-invoice\] send failed/.test(i.sample));
    ck('the attachment crash is in the report', !!send,
       d.items.map((i) => i.sample.slice(0, 40)).join(' | '));
    ck('  counted three times, not reported three times', send && send.count === 3,
       String(send && send.count));
    ck('  flagged as new since the day before', send && send.is_new === true);
    ck('  carrying the stack frame, which is the actual diagnosis',
       send && /buildMimeMessage/.test(send.frame || '') && /gmail\.js:487/.test(send.frame || ''),
       String(send && send.frame));
    ck('  and the second frame did not become its own problem',
       !d.items.some((i) => /at sendEmail/.test(i.sample)),
       'forty frames would be forty rows of a report nobody finishes');
}

// ── B. ONE FAULT IS ONE ROW ─────────────────────────────────────────────────
// The failure mode that kills a daily report: the same problem, once per
// container number, until she stops opening it.
section('B. three containers, one problem');
{
    const fwd = d.items.filter((i) => /forward FAILED/.test(i.sample));
    ck('three failed forwards collapse to one row', fwd.length === 1,
       JSON.stringify(fwd.map((i) => i.sample.slice(0, 50))));
    ck('  with a count of three', fwd[0] && fwd[0].count === 3, String(fwd[0] && fwd[0].count));
    ck('  and the container number replaced in the signature',
       fwd[0] && /<container>/.test(fwd[0].sig), String(fwd[0] && fwd[0].sig));
    ck('  spanning first to last, so a burst is distinguishable from a trickle',
       fwd[0] && fwd[0].first !== fwd[0].last,
       `${fwd[0] && fwd[0].first} .. ${fwd[0] && fwd[0].last}`);

    // It ran on the 18th too, so it is NOT news.
    ck('  and it is not called new, because it was failing yesterday as well',
       fwd[0] && fwd[0].is_new === false,
       'calling everything new is the same as calling nothing new');
}

// ── C. THE ORDER IS AN ARGUMENT, NOT AN ACCIDENT ────────────────────────────
// A lost write outranks a crash, which outranks an error. The reasoning is in
// KINDS and is meant to be arguable; what must not happen is the order being
// alphabetical or whatever the Map iterated.
section('C. read these first');
{
    ck('a lost write is the first thing in the report',
       d.items[0] && d.items[0].kind === 'lost-write',
       d.items.slice(0, 3).map((i) => i.kind).join(' > '));
    ck('  silent fallbacks come above ordinary errors',
       d.items.findIndex((i) => i.kind === 'silent-fallback')
       < d.items.findIndex((i) => i.kind === 'error'),
       d.items.map((i) => i.kind).join(' > '));
    ck('  and every kind carries the reason it is ranked there',
       d.items.every((i) => i.why && i.why.length > 20),
       'a rank with no stated reason is one nobody can argue with');

    // Within a weight, new before familiar: a fault that started yesterday is
    // one somebody's change caused yesterday.
    const errs = d.items.filter((i) => i.kind === 'error');
    ck('  within a kind, new comes before familiar',
       errs.length < 2 || (errs[0].is_new === true || errs.every((e) => !e.is_new)),
       errs.map((e) => `${e.is_new ? 'NEW' : 'old'}:${e.count}`).join(' '));
}

// ── D. YESTERDAY IS YESTERDAY ───────────────────────────────────────────────
// A report headed with a date that quietly includes the next morning is one
// she acts on wrongly exactly once.
section('D. the day boundary');
{
    ck('the next morning is not in the 19th\'s report',
       !d.items.some((i) => /HARVEST/.test(i.sample)),
       d.items.map((i) => i.sample.slice(0, 30)).join(' | '));
    ck('  and the day before is not either',
       !d.items.some((i) => (i.first || '').startsWith('2026-09-18')),
       d.items.map((i) => i.first).join(' '));
    ck('  while the 18th has its own report', prev.distinct_problems > 0,
       String(prev.distinct_problems));
    ck('  counted separately', d.lines_considered < lines.length,
       `${d.lines_considered} of ${lines.length}`);
}

// ── E. THE TIMINGS NOTHING HAS EVER READ ────────────────────────────────────
section('E. document generation');
{
    const t = logDigest.timings(lines, { onDay: '2026-09-19' });
    const both = t.find((x) => x.label === 'invoice both');
    ck('the PDF-TIME lines are parsed', !!both, JSON.stringify(t));
    ck('  both runs counted', both && both.count === 2, String(both && both.count));
    ck('  with the worst one visible', both && both.max === 1440, String(both && both.max));
    ck('  and the next day excluded from them too',
       logDigest.timings(lines, { onDay: '2026-09-20' }).length === 0);
}

// ── F. WHAT THE ASSISTANT DECIDED ───────────────────────────────────────────
section('F. decisions');
{
    const a = logDigest.decisions(fs.readFileSync(path.join(LOGS, '2026-09-19.jsonl'), 'utf8'));
    const docs = a.intents.find((i) => i.intent === 'send_shipment_docs');
    ck('intents are counted', docs && docs.count === 2, JSON.stringify(a.intents));
    ck('  split by how they were resolved',
       docs && docs.resolvedBy.policy === 1 && docs.resolvedBy.model === 1,
       JSON.stringify(docs && docs.resolvedBy));
    // "the model guessed 40 times yesterday" and "the model guessed twice"
    // are different businesses, so the split has to be per intent rather than
    // a single total.
    ck('  per intent, not one figure for the whole day',
       a.intents.length >= 2 && a.intents.every((i) => Object.keys(i.resolvedBy).length >= 1),
       JSON.stringify(a.intents.map((i) => i.intent)));
    ck('a corrupt line is counted, not fatal', a.unparsed === 1, String(a.unparsed));
}

// ── G. THE SCRIPT, AS SHE RUNS IT ───────────────────────────────────────────
section('G. end to end');
{
    const run = (...args) => spawnSync(process.execPath,
        [path.join(ROOT, 'scripts/log-digest.js'), ...args],
        { encoding: 'utf8', env: { ...process.env, DATA_DIR: TMP, JARVIS_TEST: '1' } });

    const r = run('--day', '2026-09-19');
    ck('it runs clean', r.status === 0, `${r.status} ${(r.stderr || '').slice(0, 200)}`);
    const out = r.stdout || '';
    ck('  headed with the day', /JARVIS — 2026-09-19/.test(out), out.slice(0, 80));
    ck('  the attachment crash is on the page', /send failed/.test(out));
    ck('  with its stack frame', /buildMimeMessage/.test(out));
    ck('  marked NEW', /← NEW/.test(out));
    ck('  the timings are shown', /DOCUMENT GENERATION/.test(out) && /invoice both/.test(out));
    ck('  and the decisions', /DECISIONS/.test(out) && /send_shipment_docs/.test(out));

    // ── THE MODEL IS AN OPTION, NOT THE PRODUCT ─────────────────────────
    // Without --ai there is no opinion anywhere in the report, and the
    // report is still the useful thing. The day a model invents a problem
    // is the day she stops reading it, so the facts must stand alone.
    ck('no model output unless asked for', !/SUGGESTED, BY THE MODEL/.test(out),
       'an unasked-for opinion in a facts report is how the facts stop being trusted');
    ck('  and it says how to ask', /Add --ai/.test(out));
    ck('  while saying plainly that it changed nothing',
       /Read-only — nothing was changed/.test(out));

    // A day with no logs at all must explain itself rather than print an
    // empty frame — a fresh VM, or pm2 started without ecosystem.config.js.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-logd-none-'));
    const r2 = spawnSync(process.execPath, [path.join(ROOT, 'scripts/log-digest.js')],
        { encoding: 'utf8', env: { ...process.env, DATA_DIR: empty, JARVIS_TEST: '1' } });
    ck('no logs at all exits 0', r2.status === 0, String(r2.status));
    ck('  and says what to do about it',
       /No pm2 logs found/.test(r2.stdout || '') && /ecosystem\.config\.js/.test(r2.stdout || ''),
       (r2.stdout || '').slice(0, 200));

    // A clean day says so rather than printing nothing, which reads as a
    // broken report.
    const quiet = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-logd-quiet-'));
    fs.mkdirSync(path.join(quiet, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(quiet, 'logs', 'pm2-out.log'),
        '2026-09-19T08:00:00: [BOOT] jarvis up\n2026-09-19T09:00:00: [SCAN] 12 messages, nothing to do\n');
    const r3 = spawnSync(process.execPath,
        [path.join(ROOT, 'scripts/log-digest.js'), '--day', '2026-09-19'],
        { encoding: 'utf8', env: { ...process.env, DATA_DIR: quiet, JARVIS_TEST: '1' } });
    ck('a clean day says it was clean', /A clean day/.test(r3.stdout || ''),
       (r3.stdout || '').slice(-300));
}

// ── H. THE MORNING EMAIL ────────────────────────────────────────────────────
// Asked where the scheduled report should land, she chose email. Three things
// then matter that did not matter for a terminal: the subject has to say
// whether it is worth opening, the columns have to survive an HTML renderer,
// and a failure to send must not take the scheduler down with it.
section('H. the 7am email');
{
    ck('one renderer, not two',
       typeof logDigest.render === 'function'
       && !/say\(`  JARVIS —/.test(fs.readFileSync(path.join(ROOT, 'scripts/log-digest.js'), 'utf8')),
       'the script and the scheduler must print the same string or neither can be trusted');

    const body = logDigest.render({ day: '2026-09-19', dayBefore: '2026-09-18', d, full: true });
    ck('  the rendered report carries the day', /JARVIS — 2026-09-19/.test(body));
    ck('  and the crash', /send failed/.test(body) && /buildMimeMessage/.test(body));
    ck('  in full, because an email has a scrollbar',
       !/run with --full/.test(body),
       'the 15-row cap is for a terminal; the row she needs may be the sixteenth');

    // ── THE SUBJECT IS THE WHOLE REPORT, ON A CLEAN DAY ─────────────────
    // A subject that reads the same every morning is one she stops seeing.
    ck('a lost write says so in the subject',
       /POSSIBLE LOST WRITE/.test(logDigest.subjectFor('2026-09-19', d)),
       logDigest.subjectFor('2026-09-19', d));
    const noLost = { ...d, items: d.items.filter((i) => i.kind !== 'lost-write') };
    ck('  otherwise the count of NEW problems',
       /2 new problems|1 new problem|\d+ new problem/.test(logDigest.subjectFor('2026-09-19', noLost)),
       logDigest.subjectFor('2026-09-19', noLost));
    ck('  and a clean day says clean, so it never needs opening',
       logDigest.subjectFor('2026-09-19',
           { items: [], new_today: 0, distinct_problems: 0 }) === 'Jarvis 2026-09-19 — clean',
       logDigest.subjectFor('2026-09-19', { items: [], new_today: 0, distinct_problems: 0 }));

    // ── AND IT SENDS ON A CLEAN DAY TOO ─────────────────────────────────
    // A report that only arrives when something is wrong makes its absence
    // ambiguous: "fine" and "the job is broken" look identical.
    const sched = fs.readFileSync(path.join(ROOT, 'scheduler.js'), 'utf8');
    ck('the job is scheduled', /cron\.schedule\('0 7 \* \* \*'.*nightlyLogDigest/.test(sched),
       'before the 8am digest, so it is waiting rather than interrupting');
    ck('  and does not skip quiet days',
       !/if \(!d\.distinct_problems\)\s*return/.test(sched),
       'absence must not mean two different things');

    // ── AND THE MESSAGE IT WOULD ACTUALLY SEND ──────────────────────────
    // Grepping this file for "monospace" and "full: true" left two mutations
    // green — one truncating the email to 15 rows, one dropping the html
    // half — because the words were still in the comments. So the job is RUN
    // against a stubbed mailer and the message it hands over is read.
    {
        const realGmail = require(path.join(ROOT, 'helpers/gmail'));
        const savedSend = realGmail.sendEmail;
        const savedWrite = realGmail.getGmailWrite;
        const savedAddr = realGmail.getMyEmailAddress;
        let sent = null;
        realGmail.sendEmail = async (m) => { sent = m; return { id: 'm' }; };
        realGmail.getGmailWrite = () => ({});
        realGmail.getMyEmailAddress = async () => 'apsara@edgemetals.com';
        // ── THE FIXTURE HAS TO LAND ON *ITS* YESTERDAY ──────────────────
        // The job computes yesterday in LA and reads that day. The static
        // 2026-09-19 fixture above is only "yesterday" on one date in
        // history, so the first version of this asserted 18 rows against a
        // day the job had never heard of and reported 2 — a test failing for
        // a reason that had nothing to do with the behaviour it names.
        //
        // So the lines are written for whatever day the job will ask for.
        const { getLADate } = require(path.join(ROOT, 'helpers/time'));
        const y = getLADate(); y.setDate(y.getDate() - 1);
        const yDay = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
        fs.appendFileSync(path.join(TMP, 'logs', 'pm2-error.log'),
            // A line carrying markup, so the escaper is not a no-op.
            `${yDay}T14:00:00: [ACTIONS] draft failed for "A & B <Ltd>" <ab@x.example>: EACCES\n`
            // ── GENUINELY DIFFERENT FAULTS, NOT NUMBERED ONES ───────────
            // `job-0 … reason 0` through `job-17 … reason 17` collapse to a
            // SINGLE row, because signature() replaces every number — which
            // is the whole point of it and the first version of this fixture
            // forgot. Eighteen different sentences are needed to exceed a
            // fifteen-row cap.
          + ['token expired', 'socket hang up', 'quota exceeded', 'bad gateway',
             'permission denied', 'host unreachable', 'invalid signature', 'body too large',
             'no such booking', 'duplicate key', 'timeout waiting for lock', 'disk full',
             'malformed header', 'unsupported media type', 'stream closed', 'rate limited',
             'certificate expired', 'connection reset']
                .map((why, i) => `${yDay}T15:${String(i).padStart(2, '0')}:00: [SCHED] a job failed: ${why}`)
                .join('\n')
          + '\n');
        try {
            const scheduler = require(path.join(ROOT, 'scheduler'));
            await scheduler.nightlyLogDigest();
        } catch (e) { /* reported below by `sent` being null */ }
        finally {
            realGmail.sendEmail = savedSend;
            realGmail.getGmailWrite = savedWrite;
            realGmail.getMyEmailAddress = savedAddr;
        }

        ck('the job builds a real message', !!sent, 'nothing was handed to sendEmail');
        if (sent) {
            ck('  addressed somewhere', !!sent.to, String(sent.to));
            ck('  with a subject that says what kind of day it was',
               /^Jarvis \d{4}-\d{2}-\d{2} — /.test(sent.subject || ''), String(sent.subject));
            ck('  a plain-text body', /JARVIS —/.test(sent.body || ''), String(sent.body || '').slice(0, 60));
            ck('  NOT truncated the way the terminal version is',
               !/run with --full/.test(sent.body || ''),
               'an email has a scrollbar; the row she needs may be the sixteenth');
            // And prove it by counting: the terminal caps at 15.
            const rows = (String(sent.body || '').match(/\[[a-z-]+\] x\d+/g) || []).length;
            ck(`  carrying all ${rows} rows, not the terminal's 15`, rows > 15, String(rows));
            ck('  and its own monospace html half',
               /monospace/.test(sent.bodyHtml || ''),
               'the Arial default would turn these columns into noise');
            // The fixture's log carries "→" and "—" and no angle brackets,
            // so this asserts the ESCAPER ran rather than hoping the sample
            // happened to contain something dangerous.
            const inner = String(sent.bodyHtml || '').replace(/^<div[^>]*>/, '').replace(/<\/div>$/, '');
            ck('  escaped, because a log line can contain < and &',
               !/<[a-zA-Z/]/.test(inner),
               'an unescaped log line becomes markup: ' + inner.slice(0, 120));
        }
    }

    // ── AND A FAILED REPORT IS NOT SILENT ───────────────────────────────
    // This job exists to find swallowed failures. Swallowing its own would
    // be the joke writing itself.
    ck('a send failure is logged, not thrown',
       /could not send/.test(sched) && /catch \(e\)/.test(sched));
    ck('  and no destination is reported rather than assumed',
       /no destination \(set ALERT_EMAIL_TO\)/.test(sched),
       'helpers/gmail.js carries a long note about assuming which mailbox is which');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('SUITE CRASHED:', e && e.stack); process.exit(1); });
