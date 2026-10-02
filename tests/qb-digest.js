// ── tests/qb-digest.js ────────────────────────────────────────────────────
// Apsara, 2026-10-02, shown that three separate QuickBooks emails reach her
// every night, chose: one 07:25 digest.
//
//   00:00  the entry sweep        — what went in, what is stuck
//   00:30  the QB Agent           — unallocated, duplicates, miscoded, bank gap
//   07:25  the blocked-rows agent — why each stuck row will not go in
//
// They are not duplicates, which is why none was deleted: the sweep WRITES,
// the QB Agent audits what is already inside QuickBooks, and the blocked-rows
// agent explains what cannot get in. Only the delivery was pooled.
//
// ── THE TWO WAYS THIS GOES WRONG ──────────────────────────────────────────
// Both are silent, which is why they are tested rather than eyeballed:
//
//   1. A PART GOES MISSING AND THE DIGEST STILL LOOKS COMPLETE. If the
//      process restarts at 02:00, the 00:00 sweep's entry is gone. Printing
//      the two that survived produces a tidy email covering two thirds of her
//      books with nothing saying so. That is exactly how days of sheet-sync
//      rows went unnoticed — a silent skip reads like a quiet night.
//
//   2. A FAILURE GETS FOLDED IN AND ARRIVES SEVEN HOURS LATE. An expired
//      QuickBooks token at midnight must not wait for 07:25. Routine reports
//      pool; "this did not run" does not.
//
// And one that loses news outright: if the 07:25 send fails, the stash must
// NOT be cleared, or the night is gone.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-qbdigest-'));
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const digest = require(path.join(ROOT, 'helpers/qbDigest'));

const HOURS = (n) => new Date(Date.now() - n * 3600000).toISOString();
const NOW = new Date();

(async () => {

// ── A — THREE PARTS, ONE EMAIL ────────────────────────────────────────────
{
    section('A — the whole night in one envelope');

    await digest.clear();
    await digest.record('sweep', { text: 'bill: created 3, blocked 2\nSTUCK — HMMU4933766',
                                   summary: { made: 3, blocked: 2, left: 4 } });
    await digest.record('agent', { text: 'unallocated: $12,400 on no document',
                                   summary: { open: 2 } });
    await digest.record('blocked', { text: 'Mazariegos HMMU4933766 — no supplier amount yet',
                                     summary: { needsHer: 1 } });

    const d = digest.compose({ now: NOW });
    ck('it composes one message', !!d && !!d.body);
    ck('  carrying all three parts', d && d.parts.length === 3, JSON.stringify(d && d.parts));
    ck('  with nothing reported missing', d && d.missing.length === 0, JSON.stringify(d && d.missing));

    // Each agent's own wording survives — this file never reformats their text.
    ck('the sweep\'s text is in it', /HMMU4933766/.test(d.body));
    ck('the QB Agent\'s text is in it', /unallocated/i.test(d.body));
    ck('the blocked-rows text is in it', /no supplier amount yet/.test(d.body));

    // The scoreboard, so the night is readable without scrolling.
    ck('the subject carries the scoreboard', /entered 3/.test(d.subject), d.subject);
    ck('  including what the period lock held', /4 held by the period lock/.test(d.body), d.subject);

    // THE NAMES ARE DISTINCT. The whole point of the rename: two headings in
    // one email that cannot be told apart is worse than two emails.
    ck('the two agents are named differently in the body',
       /QB Agent/.test(d.body) && /Blocked rows/.test(d.body), d.body.slice(0, 400));
}

// ── B — A PART THAT NEVER ARRIVED IS SAID, NOT SKIPPED ────────────────────
{
    section('B — a missing part is named, never quietly dropped');

    await digest.clear();
    // Jarvis restarted at 02:00: the 00:00 sweep's entry is gone.
    await digest.record('agent', { text: 'duplicates: 1 container bought twice', summary: { open: 1 } });
    await digest.record('blocked', { text: 'nothing new', summary: { needsHer: 0 } });

    const d = digest.compose({ now: NOW });
    ck('it still sends', !!d);
    ck('  and says the sweep did not run', /did not run/i.test(d.body) && /Entered overnight/.test(d.body),
       d.body.slice(-400));
    ck('  listing it by name and time', /00:00/.test(d.body), d.body.slice(-400));
    ck('  and names it in the structured result', d.missing.includes('sweep'),
       JSON.stringify(d.missing));
    ck('the parts that DID run are still reported', /duplicates/.test(d.body));
}

// ── C — STALE IS NOT FRESH ────────────────────────────────────────────────
// A part from two days ago must not be printed as though it were last night's.
{
    section('C — yesterday\'s entry does not pass as tonight\'s');

    await digest.clear();
    await digest.record('sweep', { text: 'OLD — from two nights ago', summary: { made: 99 },
                                   at: HOURS(50) });
    await digest.record('blocked', { text: 'fresh', summary: { needsHer: 0 } });

    const d = digest.compose({ now: NOW });
    ck('the stale text is NOT printed', !/OLD — from two nights ago/.test(d.body),
       'a 50-hour-old sweep presented as last night is a false all-clear');
    ck('  and the sweep is reported missing instead', d.missing.includes('sweep'),
       JSON.stringify(d.missing));
    ck('the fresh part still appears', /fresh/.test(d.body));

    // The boundary itself, so STALE_HOURS cannot drift unnoticed.
    ck(`anything older than ${digest.STALE_HOURS}h is stale`, digest.STALE_HOURS <= 24,
       'past 24h a part from the previous night would pass as this one');
}

// ── D — NOTHING RAN AT ALL IS ITS OWN ALARM ───────────────────────────────
// Three silent jobs is not a quiet night; it is a scheduler that is not
// running, and silence is the worst possible way to report that.
{
    section('D — total silence is reported, not treated as calm');

    await digest.clear();
    const d = digest.compose({ now: NOW });
    ck('it produces a message', !!d, 'three silent jobs producing no email is the alarm failing');
    ck('  saying nothing ran', /nothing ran/i.test(d.subject), d.subject);
    ck('  and listing all three', /00:00/.test(d.body) && /00:30/.test(d.body) && /07:25/.test(d.body));
    ck('  and pointing at the likely cause', /scheduler/i.test(d.body), d.body);
}

// ── E — A QUIET NIGHT SAYS NOTHING ────────────────────────────────────────
// All three ran, none had anything to report. Silence here is correct: a
// daily "nothing to report" is a mail she learns to skip, and the day it
// matters she skips that too.
{
    section('E — all three ran and all three were quiet');

    await digest.clear();
    await digest.record('sweep', { text: null, summary: { made: 0 } });
    await digest.record('agent', { text: null, summary: { open: 0 } });
    await digest.record('blocked', { text: null, summary: { needsHer: 0 } });

    ck('nothing is composed', digest.compose({ now: NOW }) === null,
       'a daily "nothing to report" is a mail she stops opening');
}

// ── F — A FAILED SEND KEEPS THE NIGHT ─────────────────────────────────────
// THE ONE THAT LOSES DATA. Clearing on a failed send throws away the only
// copy of what happened overnight.
{
    section('F — a send that fails does not throw the night away');

    await digest.clear();
    await digest.record('sweep', { text: 'something worth keeping', summary: { made: 2 } });

    const r = await digest.send({ mail: async () => { throw new Error('SMTP down'); }, to: 'x@y.com', now: NOW });
    ck('it reports the failure', r && r.sent === false && /SMTP down/.test(r.error || ''), JSON.stringify(r));
    ck('  and the night is STILL in the stash', /something worth keeping/
        .test((digest.read().sweep || {}).text || ''),
       'cleared on failure, tonight is gone and tomorrow reports a quiet night');

    // And the successful path does clear, so tonight is not re-sent tomorrow.
    let got = null;
    const ok = await digest.send({ mail: async (o) => { got = o; }, to: 'x@y.com', now: NOW });
    ck('a successful send goes out', ok && ok.sent === true && !!got, JSON.stringify(ok && ok.sent));
    ck('  to the address given', got && got.to === 'x@y.com');
    ck('  and clears the stash', !digest.read().sweep,
       'left in place, she gets tonight again tomorrow');
}

// ── G — SENT ONCE A DAY ───────────────────────────────────────────────────
{
    section('G — one digest a day, not one per restart');

    await digest.clear();
    await digest.record('sweep', { text: 'x', summary: { made: 1 } });
    const seen = new Set();
    const alreadySent = async (k) => seen.has(k);
    const markSent = async (k) => { seen.add(k); };

    const one = await digest.send({ mail: async () => {}, to: 'x@y.com', now: NOW, alreadySent, markSent });
    ck('the first run sends', one && one.sent === true);
    await digest.record('sweep', { text: 'x', summary: { made: 1 } });
    const two = await digest.send({ mail: async () => { throw new Error('should not send'); },
                                    to: 'x@y.com', now: NOW, alreadySent, markSent });
    ck('  a second run the same day does not', two && two.skipped === true, JSON.stringify(two));
}

// ── H — THE SCHEDULER ACTUALLY ROUTES THROUGH IT ──────────────────────────
// Sections A–G test the digest in isolation, and that is not enough: a
// composer nothing calls is a composer nobody reads. The same gap that let a
// reverted Run Now wiring stay green this morning.
{
    section('H — the three jobs post here, and failures still go direct');

    const sched = fs.readFileSync(path.join(ROOT, 'scheduler.js'), 'utf8');

    ck('the 00:00 sweep records instead of mailing',
       /qbDigest'\)\s*\n?\s*\.record\('sweep'|\.record\('sweep'/.test(sched),
       'the sweep is still mailing on its own — that is email one of three back');
    ck('the 00:30 QB Agent records instead of mailing', /\.record\('agent'/.test(sched));
    ck('the 07:25 job records its own part', /\.record\('blocked'/.test(sched));
    ck('  and then posts the one envelope', /qbDigest'\)\.send\(|digest\.send\(/.test(sched));

    // ── THE FAILURE ESCAPE HATCH ─────────────────────────────────────────
    // Both nightly jobs must still mail directly when they could not run.
    const sweepBlock = sched.slice(sched.indexOf('async function nightlyQuickBooks'),
                                   sched.indexOf('async function qbAgent'));
    ck('a FAILED sweep still emails immediately',
       /if \(out\.error\) await job\.emailReport\(out\)/.test(sweepBlock),
       'folded into the digest, an expired token at midnight reaches her at 07:25');
    const agentBlock = sched.slice(sched.indexOf('async function qbAgent'),
                                   sched.indexOf('async function qbAgent') + 2000);
    ck('a FAILED QB Agent run still emails immediately',
       /if \(out\.error\) await agent\.emailReport\(out\)/.test(agentBlock), agentBlock.slice(0, 200));

    // The jobs' own emailReport functions stay — scripts and tests use them.
    for (const [what, mod] of [['quickbooksNightly', 'helpers/quickbooksNightly'],
                               ['quickbooks/agent', 'helpers/quickbooks/agent']]) {
        ck(`${what}.emailReport still exists`,
           typeof require(path.join(ROOT, mod)).emailReport === 'function',
           'removed, scripts/qb-run.js and the tests lose their reporter');
    }
}

// ── I — THE NAMES ARE SEPARATE NOW ────────────────────────────────────────
// Her second answer: theirs keeps "QB Agent", mine becomes "Blocked rows".
{
    section('I — one name, one agent');

    const mine = fs.readFileSync(path.join(ROOT, 'helpers/qbAgentJob.js'), 'utf8');
    ck('my job no longer logs as [qb-agent]', !/\[qb-agent\]/.test(mine),
       'two different jobs logging the same prefix makes a log line unattributable');
    ck('  it logs as [blocked-rows]', /\[blocked-rows\]/.test(mine));
    ck('  and its subjects say Blocked rows', /Blocked rows —/.test(mine));

    // Theirs is untouched: it owns the name and the page tab.
    const page = fs.readFileSync(path.join(ROOT, 'dashboard/quickbooks.html'), 'utf8');
    ck('the page\'s QB Agent tab still says QB Agent', />QB Agent</.test(page),
       'that tab opens /api/qb/agent — theirs — and she asked for it by that name');

    // QB_AGENT_EMAILS keeps its name: it is in her .env on the VM.
    ck('QB_AGENT_EMAILS is NOT renamed',
       /QB_AGENT_EMAILS/.test(fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8')),
       'renaming an env var to tidy a label is how a report loses its recipient');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})();
