// ── tests/heartbeat.js ─────────────────────────────────────────────────────
// Apsara, 2026-10-08: "First heartbeat. if something is broke - i should know."
//
// MEASURED FIRST: scheduler.js schedules 31 cron jobs and exactly ONE of them
// recorded that it had run (settings.gmail_watcher_last_run), which read
// `null`. A job that dies is invisible because its only symptom is an
// absence -- which is why "is emailWatcher alive on the VM?" could not be
// answered at all.
process.env.JARVIS_TEST = '1';

const fs = require('fs');
const os = require('os');
const path = require('path');
const R = (p) => path.join(__dirname, '..', p);

// Redirected BEFORE heartbeat loads, and the real file's mtime is recorded so
// the last section can prove this test never touched it. Two tests of mine
// reached production data last week; that does not happen a third time.
const cfg = require(R('config.js'));
const REAL = cfg.HEARTBEAT_FILE;
let realMtime = null;
try { realMtime = fs.statSync(REAL).mtimeMs; } catch (e) { realMtime = null; }
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-hb-'));
cfg.HEARTBEAT_FILE = path.join(TMP, 'heartbeat.json');

const hb = require(R('helpers/heartbeat.js'));
const { _MIN: MIN, _HOUR: HOUR, _DAY: DAY } = hb;

let pass = 0, fail = 0;
const failures = [];
const ck = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
};
const section = (t) => console.log(`\n=== ${t} ===`);
const reset = () => { try { fs.unlinkSync(cfg.HEARTBEAT_FILE); } catch (e) {} };

// A node-cron stand-in: records what was scheduled and hands back the wrapped
// function so the test can tick it by hand.
function fakeCron() {
    const reg = [];
    return { reg, schedule: (expr, fn, opts) => { reg.push({ expr, fn, opts }); return { stop() {} }; },
        validate: () => true, getTasks: () => [] };
}

(async () => {
    section('HB — how often is this job SUPPOSED to run');
    // The period must be an UPPER bound on the ordinary gap. Under-estimating
    // produces false alarms, and a monitor that cries wolf gets ignored,
    // which returns us to having no monitor.
    ck('HB1 every minute', hb.periodFor('* * * * *') === MIN);
    ck('HB2 every 5 / 15 / 30 minutes', hb.periodFor('*/5 * * * *') === 5 * MIN
        && hb.periodFor('*/15 * * * *') === 15 * MIN && hb.periodFor('*/30 * * * *') === 30 * MIN);
    ck('HB3 once a day', hb.periodFor('0 8 * * *') === DAY && hb.periodFor('45 22 * * *') === DAY);
    // THE ONE THAT MATTERS. "0 9-17 * * *" runs hourly through the working
    // day, but the real gap is the 16 hours overnight. Calling it 1h would
    // flag both of her hourly watchers as late every single morning.
    ck('HB4 an hour RANGE is measured across the gap it does NOT run',
        hb.periodFor('0 9-17 * * *') === 16 * HOUR, String(hb.periodFor('0 9-17 * * *') / HOUR) + 'h');
    ck('HB5 an hour step', hb.periodFor('0 */4 * * *') === 4 * HOUR);
    ck('HB6 hourly on a fixed minute', hb.periodFor('17 * * * *') === HOUR);
    ck('HB7 nonsense does not throw', hb.periodFor('') === null && hb.periodFor(null) === null);

    section('HB — the name comes from the label the job already logs');
    const nm = (src) => hb.nameFor(new Function(`/* ${src} */`), 'x', new Set());
    ck('HB8 a one-liner names itself', nm("emailWatcher.run().catch(e => console.error('[SCHED] email:', e))") === 'email');
    ck('HB9 spaces become hyphens', nm("console.error('[SCHED] cutoff backfill:', e)") === 'cutoff-backfill');
    // A log prefix sometimes carries the OUTCOME word. A job called "failed"
    // reads as broken every time it is healthy.
    ck('HB10 an outcome word is stripped',
        nm("console.error('[SCHED] nightly data backup FAILED:', e)") === 'nightly-data-backup',
        nm("console.error('[SCHED] nightly data backup FAILED:', e)"));
    ck('HB11 no label falls back to the helper it requires',
        nm("require('./helpers/bankPullJob').run()") === 'bankpull', nm("require('./helpers/bankPullJob').run()"));
    const used = new Set();
    const a = hb.nameFor(new Function("/* console.error('[SCHED] x:', e) */"), 'e', used);
    const b = hb.nameFor(new Function("/* console.error('[SCHED] x:', e) */"), 'e', used);
    ck('HB12 two jobs with the same label stay distinct', a === 'x' && b === 'x-2', `${a} / ${b}`);

    section('HB — a pulse is recorded, and the job still behaves');
    reset();
    let ran = 0;
    const c1 = fakeCron();
    const inst1 = hb.instrument(c1);
    inst1.schedule('*/15 * * * *', () => { ran++; return Promise.resolve('done'); }, { timezone: 'X' });
    ck('HB13 the schedule is passed through to node-cron untouched',
        c1.reg.length === 1 && c1.reg[0].expr === '*/15 * * * *' && c1.reg[0].opts.timezone === 'X');
    ck('HB14 the job is registered before it has ever run', !!hb.load().jobs.job
        || Object.keys(hb.load().jobs).length === 1, JSON.stringify(Object.keys(hb.load().jobs)));
    const out = await c1.reg[0].fn();
    ck('HB15 the wrapped job still runs and still returns its value', ran === 1 && out === 'done');
    const j = Object.values(hb.load().jobs)[0];
    ck('HB16 success is recorded with a timestamp and a duration',
        j.ok === true && !!j.last_ok && typeof j.ms === 'number' && j.runs === 1, JSON.stringify(j));

    section('HB — a failure is recorded AND still thrown');
    reset();
    const c2 = fakeCron();
    hb.instrument(c2).schedule('0 8 * * *', async () => { throw new Error('gmail down'); }, {});
    let threw = null;
    try { await c2.reg[0].fn(); } catch (e) { threw = e.message; }
    // The job's own .catch must still see it: the heartbeat observes, it does
    // not intervene. Swallowing the error here would silently change the
    // behaviour of all 31 jobs.
    ck('HB17 the error is re-thrown to the job\'s own .catch', threw === 'gmail down', String(threw));
    const f = Object.values(hb.load().jobs)[0];
    ck('HB18 and it is on record, with the message', f.ok === false
        && /gmail down/.test(f.error || '') && f.fails === 1, JSON.stringify(f));

    section('HB — what is broken right now');
    const now = Date.parse('2026-10-08T12:00:00Z');
    const state = { jobs: {
        email:      { expr: '*/15 * * * *', period_ms: 15 * MIN, ok: true, last_ok: '2026-10-08T11:58:00Z' },
        digest:     { expr: '0 8 * * *',    period_ms: DAY,      ok: true, last_ok: '2026-10-08T08:00:00Z' },
        quickbooks: { expr: '0 0 * * *',    period_ms: DAY,      ok: false, last_ok: '2026-10-05T00:00:00Z', error: 'token expired' },
        'reply-watch': { expr: '*/5 * * * *', period_ms: 5 * MIN, ok: true, last_ok: '2026-10-08T09:00:00Z' },
        learning:   { expr: '30 3 * * *',   period_ms: DAY,      registered: '2026-09-01T00:00:00Z' },
    } };
    const s = hb.status(now, state);
    ck('HB19 a job inside its window is healthy', s.ok.some((x) => x.name === 'email') && s.ok.some((x) => x.name === 'digest'));
    ck('HB20 a job whose last run THREW is failing', s.failing.length === 1 && s.failing[0].name === 'quickbooks');
    // 3 hours since a 5-minute job last succeeded.
    ck('HB21 a job far past its window is late', s.late.some((x) => x.name === 'reply-watch'), JSON.stringify(s.late.map((x) => x.name)));
    // THE CASE THAT STARTED THIS: registered, never run, nothing said.
    ck('HB22 a job that has NEVER run is silent, not healthy',
        s.silent.length === 1 && s.silent[0].name === 'learning', JSON.stringify(s.silent.map((x) => x.name)));
    ck('HB23 and the whole thing is not called healthy', s.healthy === false);
    ck('HB24 a tick inside the grace window is NOT late',
        !hb.status(Date.parse('2026-10-08T12:00:00Z'), { jobs: { email: { period_ms: 15 * MIN, ok: true, last_ok: '2026-10-08T11:40:00Z' } } }).late.length,
        'a job may miss a tick or two before it is called late');

    section('HB — the line she actually reads');
    const good = hb.report(now, { jobs: { email: { period_ms: 15 * MIN, ok: true, last_ok: '2026-10-08T11:58:00Z' } } });
    // One line when all is well. A monitor that writes a paragraph every
    // morning stops being read, and then it may as well not exist.
    ck('HB25 healthy is ONE line', good.split('\n').length === 1 && /All 1 scheduled jobs ran on time/.test(good), good);
    const bad = hb.report(now, state);
    ck('HB26 a failure is named, with its message', /quickbooks FAILED/.test(bad) && /token expired/.test(bad), bad);
    ck('HB27 a late job says how long and how often', /reply-watch last ran 3h ago/.test(bad) && /expected every 5m/.test(bad), bad);
    ck('HB28 a never-run job says so', /learning has never run/.test(bad), bad);
    ck('HB29 nothing reported in at all says that', /No scheduled jobs have reported in/.test(hb.report(now, { jobs: {} })));

    section('HB — it must never be the reason a job fails');
    reset();
    const c3 = fakeCron();
    // An unwritable path: recording is impossible, the job must still run.
    // A path whose PARENT is a regular file, so mkdir fails immediately with
    // ENOTDIR. (The first version pointed at /proc, where mkdirSync does not
    // fail fast -- it hung the whole suite, which is its own small lesson
    // about picking a failure you can predict.)
    const blocker = path.join(TMP, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    cfg.HEARTBEAT_FILE = path.join(blocker, 'heartbeat.json');
    let ran3 = 0;
    hb.instrument(c3).schedule('* * * * *', () => { ran3++; return 'ok'; }, {});
    let err3 = null;
    try { await c3.reg[0].fn(); } catch (e) { err3 = e.message; }
    ck('HB30 the job runs even when the pulse cannot be written', ran3 === 1 && err3 === null, String(err3));
    cfg.HEARTBEAT_FILE = path.join(TMP, 'heartbeat.json');
    // A corrupt file must read as "nothing known", not crash the reader.
    fs.writeFileSync(cfg.HEARTBEAT_FILE, '{ this is not json');
    ck('HB31 a corrupt pulse file degrades to empty', JSON.stringify(hb.load()) === '{"jobs":{}}', JSON.stringify(hb.load()));

    section('HB — THIS TEST MUST NOT TOUCH HER DATA');
    let nowMtime = null;
    try { nowMtime = fs.statSync(REAL).mtimeMs; } catch (e) { nowMtime = null; }
    ck('HB32 the real heartbeat.json is untouched', nowMtime === realMtime, `was ${realMtime}, now ${nowMtime}`);

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILED: ' + failures.join(', ')); process.exit(1); }
})();
