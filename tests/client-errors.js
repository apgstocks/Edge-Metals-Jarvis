// ── tests/client-errors.js ────────────────────────────────────────────────
// Apsara, 2026-10-02, after four hours spent guessing why the app would not
// sign in on some wifi networks: "I cant afford mistakes like this when i
// sell this to many customers."
//
// The outage was a visibility problem, not a Caddy problem. Nothing could say
// what was failing, so the diagnosis was five theories, four of them wrong,
// against a live business. With twenty customers that is unworkable: someone
// cannot sign in, assumes their phone is broken, says nothing, and she never
// learns of it.
//
// So devices report. The report is queued on the phone (it cannot send at the
// moment it matters — that is the whole problem) and flushed on the next
// connection that works.
//
// ── WHAT THIS FILE IS REALLY GUARDING ─────────────────────────────────────
// /api/client-errors is the ONLY route in Jarvis a stranger can write to,
// and it has to be: a device reporting "I cannot reach the server" has by
// definition not signed in. There is no token to present. So the limits are
// doing the job authentication usually does, and every one of them is tested
// here as a security property rather than a nicety:
//
//   · fields truncated      — a megabyte of junk becomes a few hundred bytes
//   · store capped          — it cannot grow until the VM runs out of room.
//                             A diagnostic that causes an outage is worse
//                             than no diagnostic at all.
//   · whitelisted           — a later client change cannot start posting
//                             secrets that this would faithfully record
//   · never carries a password or token

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

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-clienterr-'));
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const ce = require(path.join(ROOT, 'helpers/clientErrors'));

const probes = (firstFail) => ['internet', 'reach server', 'read /healthz', 'login preflight']
    .map((label, i) => ({ label, ok: i < firstFail, status: 200, type: 'basic', ms: 120,
                          err: i < firstFail ? null : 'no answer (timed out)' }));

(async () => {

// ── A — A REPORT IS KEPT, AND ONLY THE PARTS WE ASKED FOR ─────────────────
{
    section('A — what a device sends, and what is kept');

    const saved = await ce.record({
        at: '2026-10-02T19:00:00.000Z', base: 'https://jarvis.edgemetals.com',
        app_version: '9.2', platform: 'Android 13; SM-G991B',
        verdict: 'This wifi will not connect to jarvis.edgemetals.com',
        probes: probes(1),
    }, { ip: '203.0.113.9' });

    ck('it is stored', !!saved && ce.list().length === 1);
    ck('  with the verdict', /will not connect/.test(saved.verdict));
    ck('  and every probe', saved.probes.length === 4, String(saved.probes.length));
    ck('  the connection, for grouping', saved.ip === '203.0.113.9');
    ck('the SERVER clock is the timestamp, not the phone\'s',
       saved.at !== '2026-10-02T19:00:00.000Z' && saved.device_at === '2026-10-02T19:00:00.000Z',
       'a phone with a wrong clock would otherwise scramble the ordering');
}

// ── B — A SECRET CANNOT GET IN, EVEN IF THE CLIENT SENDS ONE ──────────────
// THE ONE THAT MATTERS MOST. The whitelist is here so a future change to the
// app cannot start posting something this would then faithfully write to disk
// and into her morning email.
{
    section('B — nothing secret is recorded, whatever arrives');

    const saved = await ce.record({
        base: 'https://jarvis.edgemetals.com', probes: probes(2),
        password: 'hunter2', sid: 'abc123', token: 'Bearer xyz',
        cookies: 'session=secret', note: 'something private',
        probes_extra: { password: 'again' },
    }, { ip: '203.0.113.9' });

    const blob = JSON.stringify(saved);
    for (const bad of ['hunter2', 'abc123', 'Bearer xyz', 'session=secret', 'something private']) {
        ck(`"${bad}" is not stored`, !blob.includes(bad), blob.slice(0, 200));
    }
    ck('  and the fields themselves are gone, not blanked',
       !('password' in saved) && !('sid' in saved) && !('token' in saved),
       Object.keys(saved).join(','));
}

// ── C — IT CANNOT BE USED TO FILL THE DISK ────────────────────────────────
// An open endpoint with no cap is a disk-filling tool, and a full disk takes
// Jarvis down. That turns a diagnostic into the outage it was built to catch.
{
    section('C — size and volume are bounded');

    const huge = 'x'.repeat(200000);
    const saved = await ce.record({
        base: huge, verdict: huge, app_version: huge, platform: huge,
        probes: [{ label: huge, err: huge, ms: 9e15, ok: false }],
    }, { ip: huge });

    ck('every field is truncated', JSON.stringify(saved).length < 2000,
       'stored ' + JSON.stringify(saved).length + ' bytes from a 200kb report');
    ck('  including the probe fields', saved.probes[0].err.length <= 200);
    ck('  and a silly duration is clamped', saved.probes[0].ms <= 600000, String(saved.probes[0].ms));

    // The store trims oldest-first rather than growing.
    const before = ce.list().length;
    for (let i = 0; i < ce.KEEP + 40; i += 1) {
        await ce.record({ base: 'b', verdict: 'v' + i, probes: probes(1) }, { ip: '198.51.100.1' });
    }
    const after = ce.list();
    ck(`the store stops at ${ce.KEEP}`, after.length === ce.KEEP, String(after.length));
    ck('  and it keeps the NEWEST', /v\d+$/.test(after[after.length - 1].verdict)
        && after[after.length - 1].verdict === 'v' + (ce.KEEP + 39),
       after[after.length - 1].verdict);
    ck('  (it grew from ' + before + ', so it really was trimming)', before < ce.KEEP);
}

// ── D — A REPORT WITH NOTHING IN IT IS NOT A REPORT ───────────────────────
{
    section('D — empty submissions are refused');

    const n = ce.list().length;
    ck('no probes -> not stored', (await ce.record({ base: 'b' })) === null && ce.list().length === n);
    ck('garbage -> not stored', (await ce.record('nonsense')) === null && ce.list().length === n);
    ck('null -> not stored', (await ce.record(null)) === null && ce.list().length === n);
}

// ── E — THE MORNING LINE SAYS THE ACTIONABLE THING ────────────────────────
// Grouped by the stage that broke, because that is what decides who fixes it:
// everyone failing at "reach server" is a network story; everyone failing at
// "login preflight" is a server story.
//
// ── RUN IN A CHILD PROCESS, ON ITS OWN DATA_DIR ──────────────────────────
// The first version swapped process.env.DATA_DIR and re-required the module.
// That does not work: config.js resolves the path once at load, so the
// "fresh" store was the same file section C had just put 500 rows into, and
// the counts were nonsense. Deleting the require cache does not undo a value
// already captured in a closure. A separate process is the only honest way to
// get a clean store, so that is what it uses.
{
    section('E — what she reads at 08:00');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ce2-'));
    const script = `
        const ce = require(${JSON.stringify(path.join(ROOT, 'helpers/clientErrors'))});
        const probes = (f) => ['internet','reach server','read /healthz','login preflight']
            .map((label,i)=>({label, ok:i<f, ms:10, err:i<f?null:'no answer (timed out)'}));
        (async () => {
            for (const ip of ['203.0.113.1','203.0.113.2','203.0.113.2'])
                await ce.record({ base:'b', verdict:'This wifi will not connect', probes:probes(1) }, { ip });
            await ce.record({ base:'b', verdict:'The server refused the sign-in', probes:probes(3) },
                            { ip:'203.0.113.7' });
            const s = ce.summary({ hours: 24 });
            // A window that provably contains nothing, rather than hours:0 —
            // which compares against "now" and so passes or fails depending
            // on whether the write and the read land in the same
            // millisecond. A flaky check is worse than no check.
            const future = Date.now() + 72 * 3600000;
            process.stdout.write(JSON.stringify({ s, txt: ce.digestText(s),
                quiet: ce.digestText(ce.summary({ hours: 24, now: future })) }));
        })();
    `;
    const out = require('child_process').execFileSync(process.execPath, ['-e', script], {
        env: { ...process.env, DATA_DIR: dir, JARVIS_TEST: '1' }, encoding: 'utf8',
    });
    const { s, txt, quiet } = JSON.parse(out);

    ck('it counts the reports', s.reports === 4, String(s.reports));
    ck('  and the CONNECTIONS, not the retries', s.connections === 3,
       String(s.connections) + ' — one phone retrying is one problem, not three');
    ck('the line names the worst stage first', /reach server/.test(txt.split('\n')[1]), txt);
    ck('  and says why it matters', /may not have told you/i.test(txt),
       'the whole point is the person who did not complain');
    ck('a quiet day says NOTHING', quiet === null,
       'a daily "no devices failed" is a line she stops reading');
}

// ── F — THE ROUTE AND THE CLIENT ARE ACTUALLY WIRED ───────────────────────
// A store nothing writes to and a queue nothing flushes would pass every
// check above. This is the gap that let a reverted Run Now wiring stay green
// earlier today, so it is checked explicitly.
{
    section('F — the plumbing exists end to end');

    const api = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
    ck('the route exists', /app\.post\('\/api\/client-errors'/.test(api));
    ck('  with its OWN small body limit, not the 40mb global',
       /\/api\/client-errors',\s*express\.json\(\{\s*limit:\s*'16kb'/.test(api),
       '40mb on an open endpoint is a disk-filling tool');
    ck('  rate limited per connection', /clientErrHits/.test(api));
    ck('  and it always answers 204, telling a stranger nothing',
       /res\.status\(204\)\.end\(\);/.test(api));

    const app = fs.readFileSync(path.join(ROOT, 'mobile-app/www/index.html'), 'utf8');
    ck('the app QUEUES a failure', /queueClientError\(/.test(app),
       'it cannot send at the moment it matters — that is the whole problem');
    ck('  and flushes on the next connection that works',
       /flushClientErrors\(\)/.test(app));
    ck('  the queue is bounded', /CLIENT_ERR_MAX/.test(app),
       'an unbounded localStorage queue eventually breaks the app it protects');

    const sched = fs.readFileSync(path.join(ROOT, 'scheduler.js'), 'utf8');
    ck('the morning digest carries it', /deviceTroubleLine\(\)/.test(sched));
    // The digest used to return early when there were no bookings, which
    // would have buried device reports on exactly the slow day someone has
    // time to notice they cannot sign in.
    const quiet = sched.slice(sched.indexOf('if (!active.length)'),
                              sched.indexOf('if (!active.length)') + 700);
    ck('  and still reports them on a day with no bookings',
       /deviceTroubleLine\(\)/.test(quiet), quiet.slice(0, 200));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})();
