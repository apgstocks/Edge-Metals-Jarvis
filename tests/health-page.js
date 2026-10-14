// ── tests/health-page.js ─────────────────────────────────────────────────
// Apsara, 2026-10-12: "Why there is no provision for USers,incidents,crash
// report?"
//
// For crash reports the answer was not that they were missing. They were
// COMPLETE and unread: helpers/crashlog.js has written every boot, every
// uncaughtException and a crash-<ts>.log per death since 2026-09-06, and
// helpers/clientErrors.js has collected probe failures from the phones since
// 2026-10-02. No route served either. There is a POST /api/client-errors so a
// phone can report and no GET to read it back; nothing served LOGS_DIR at
// all. So every log line she has pasted this week came out of a terminal.
//
//   A  the reader: what it finds, and the bounds that stop it being a hazard
//   B  it is NOT a file server — the property, tested against an attempt
//   C  every section survives its own source being unreadable
//   D  END TO END through the real route, signed in, and the gate
//   E  the page and the nav agree with each other
//
// The route is '/health-report' and NOT '/health' because /health is already
// an unauthenticated liveness probe (api.js:536, exempted from auth at
// api.js:277). Section E pins that, because shadowing it was a real mistake
// made while writing this and tests/sidebar-pages.js is what caught it.

const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-health-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
// BEFORE config.js is required, not in section D where they are used.
// config.js reads process.env ONCE at require time and caches it, so setting
// them later left the server with no passwords at all and every sign-in
// answered 401 — which looked exactly like the gate working.
process.env.APP_PASSWORD   = 'user-pw-' + Math.random().toString(36).slice(2);
process.env.ADMIN_PASSWORD = 'admin-pw-' + Math.random().toString(36).slice(2);

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('  ABORT  config not isolated'); process.exit(1); }

const LOGS = cfg.LOGS_DIR;
fs.mkdirSync(LOGS, { recursive: true });

// A deploy, then a crash loop: shutdown→boot is explained, boot→boot is not.
//
// RELATIVE TO NOW, deliberately. boots() counts over a rolling 48-hour
// window, so an absolutely-dated fixture is a test with a fuse in it: this
// file was written on 2026-10-14 against 2026-10-11 timestamps and five
// checks went red on 2026-10-15 when the fixture aged out of the window it
// was being measured against. A test that breaks because the calendar moved
// is a test that gets deleted.
const AT = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const CRASH_AT = AT(5 * 3600 * 1000);          // 5 hours ago, inside any window here
const SHUTDOWN_AT = AT(6 * 3600 * 1000);
fs.writeFileSync(path.join(LOGS, 'jarvis.log'), [
    `${SHUTDOWN_AT} SIGTERM — closing`,
    `${AT(6 * 3600 * 1000 - 2000)} BOOT pid 101 node v22`,
    `${CRASH_AT} uncaughtException: TypeError: payableOf is not a function`,
    `${AT(5 * 3600 * 1000 - 4000)} BOOT pid 102 node v22`,
    `${AT(5 * 3600 * 1000 - 41000)} BOOT pid 103 node v22`,
    '',
].join('\n'));

fs.writeFileSync(path.join(LOGS, `crash-${CRASH_AT}.log`),
    'TypeError: payableOf is not a function\n'
    + '    at generateAndStoreLoadPdfs (/app/helpers/loadsPdf.js:47:31)\n'
    + '    at /app/routes/yard.js:479:29\n');

// Two things in LOGS_DIR that are NOT ours. If either ever appears in a
// response, this module has become a file server.
fs.writeFileSync(path.join(LOGS, 'notes.txt'), 'SMTP_PASSWORD=hunter2\n');
fs.writeFileSync(path.join(LOGS, 'crash-report.bak'), 'GOOGLE_PRIVATE_KEY=leakme\n');

const hr = require(path.join(ROOT, 'helpers/healthReport'));

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — the reader');

{
    const b = hr.boots(48);
    ck('it reads jarvis.log', b.ok === true, JSON.stringify(b.error));
    ck('  counting boots', b.boots === 3, `boots=${b.boots}`);
    ck('  and crashes', b.crashes === 1, `crashes=${b.crashes}`);
    ck('  and clean shutdowns', b.shutdowns === 1, `shutdowns=${b.shutdowns}`);
    // THE number: three boots, one asked for. A deploy is shutdown-then-boot;
    // a crash loop is boots with nothing in front of them.
    ck('  and says how many restarts nobody asked for', b.unexplained_restarts === 1,
       `unexplained=${b.unexplained_restarts} — this is the crash-loop signal`);

    const c = hr.crashes();
    ck('it finds the crash file', c.ok === true && c.items.length === 1, JSON.stringify(c.items.map(i => i.file)));
    const one = c.items[0];
    // The STACK is the whole value. A list of timestamps answers "did it
    // crash", which she already knew on 2026-09-01; the stack answers "what
    // threw", which took ten and a half hours.
    ck('  with the full stack', /loadsPdf\.js:47/.test(one.stack || ''), one.stack);
    ck('  and a headline readable without opening it',
       /payableOf is not a function/.test(one.headline || ''), one.headline);
    // From the NAME, not stat(): the name is what crashlog.js chose at the
    // moment of death, and a file copied or restored carries a new mtime.
    ck('  dated from the filename', one.at === CRASH_AT, one.at);

    const p = hr.thisProcess();
    ck('it reports this process', p.pid === process.pid && p.rss_mb > 0, JSON.stringify(p));
    // After a restart the stacks on disk belong to a process that is gone.
    // Uptime is what says whether this is history or still happening.
    ck('  including uptime, so history and now are distinguishable',
       typeof p.uptime_s === 'number');
}

// ══════════════════════════════════════════════════════════════════════════
section('B — it is not a file server');

{
    const whole = JSON.stringify(hr.report());
    ck('a .txt sitting in the log directory is not served', !whole.includes('hunter2'),
       'LOGS_DIR sits next to her stores, bank data and Google credentials');
    ck('  nor a file that merely LOOKS like a crash report', !whole.includes('leakme'),
       'crash-report.bak matched a loose /^crash-/ and must not match the strict one');
    // The guard, as a property rather than by inspection of the glob.
    ck('the name pattern accepts what crashlog.js writes',
       hr.CRASH_NAME.test(`crash-${CRASH_AT}.log`));
    ck('  and rejects a neighbour', !hr.CRASH_NAME.test('crash-report.bak')
        && !hr.CRASH_NAME.test('notes.txt') && !hr.CRASH_NAME.test('crash-../../id_rsa.log'));

    // safeInLogs is called on every path even though every path is built from
    // a readdir of LOGS_DIR. The guard is what stops the day someone threads
    // a caller-supplied name through to one of these readers.
    ck('safeInLogs admits a file inside the log directory',
       hr.safeInLogs(path.join(LOGS, 'jarvis.log')));
    ck('  and refuses an escape', !hr.safeInLogs(path.join(LOGS, '..', 'loads.json'))
        && !hr.safeInLogs('/etc/passwd'));
    // Prefix-matching is the classic near-miss: /data/logs-old must not pass
    // because it starts with /data/logs.
    ck('  and refuses a sibling whose name starts the same',
       !hr.safeInLogs(LOGS + '-old/secrets.log'), `${LOGS}-old`);

    // Bounded reads. jarvis.log rotates at 5MB and slurping it into a JSON
    // response is its own outage.
    const big = path.join(LOGS, 'big.log');
    fs.writeFileSync(big, 'x'.repeat(200000) + '\nLAST LINE\n');
    const t = hr.tailOf(big, 1024);
    ck('a big file is read from the END only', t.text.length <= 1100, `${t.text.length} bytes`);
    ck('  keeping the newest content', /LAST LINE/.test(t.text));
    ck('  and saying it was truncated', t.truncated === true);
    // A byte-offset read lands mid-line; showing half a timestamp is worse
    // than dropping the fragment.
    ck('  with no half line at the top', !/^x+$/.test(t.text.split('\n')[0] || ''));
    fs.unlinkSync(big);
}

// ══════════════════════════════════════════════════════════════════════════
section('C — one unreadable source must not blank the page');
// This is the module you reach for when things are ALREADY broken. A health
// page that goes empty because one of five sources failed is useless at
// exactly the moment it is needed.

{
    const r = hr.report();
    for (const k of ['process', 'boots', 'crashes', 'devices', 'jobs', 'documents']) {
        ck(`${k} is present`, !!r[k], JSON.stringify(Object.keys(r)));
    }

    // Make the log directory unreadable and check the rest survives.
    const moved = LOGS + '.hidden';
    fs.renameSync(LOGS, moved);
    const broken = hr.report();
    ck('with the log directory gone, the report still answers', broken.ok === true);
    ck('  crashes reports its own failure', broken.crashes && broken.crashes.ok === false,
       JSON.stringify(broken.crashes));
    ck('  and names what went wrong', /ENOENT|could not read/.test(
        (broken.crashes && broken.crashes.error) || ''), (broken.crashes || {}).error);
    ck('  while process still answers', broken.process && broken.process.pid === process.pid);
    ck('  and devices still answers', broken.devices && broken.devices.ok === true);
    fs.renameSync(moved, LOGS);

    // ── A SOURCE THAT THROWS, NOT ONE THAT REPORTS ──────────────────────
    // The checks above only prove crashes()/boots() catch their OWN errors.
    // report()'s per-section wrapper is a different guard and was untested:
    // a mutation that replaced it with `catch (e) { throw e; }` survived,
    // because nothing here had ever made a section throw. So make one.
    const ce = require.resolve(path.join(ROOT, 'helpers/clientErrors'));
    const real = require.cache[ce];
    require.cache[ce] = { id: ce, filename: ce, loaded: true,
        exports: { list() { throw new Error('torn clientErrors store'); }, summary() { return null; } } };
    try {
        const r2 = hr.report();
        ck('a section that THROWS does not take the page with it', r2.ok === true);
        ck('  that section reports its own failure', r2.devices && r2.devices.ok === false,
           JSON.stringify(r2.devices));
        ck('  naming the reason', /torn clientErrors store/.test((r2.devices || {}).error || ''),
           (r2.devices || {}).error);
        ck('  while every other section is intact',
           r2.crashes && r2.crashes.ok === true && r2.boots && r2.boots.ok === true
           && r2.process && r2.process.pid === process.pid);
    } finally {
        if (real) require.cache[ce] = real; else delete require.cache[ce];
    }
}

// ══════════════════════════════════════════════════════════════════════════
section('D — END TO END, through the real route');
// Helper tests and screen tests can both be green while the feature does not
// work (CLAUDE.md rule 3). The gaps live between them, and one of them bit
// while writing this: the markup was right and the ROUTE was shadowed.

{
    // createApi, not the module itself — api.js exports a named factory.
    const { createApi } = require(path.join(ROOT, 'api'));
    const server = await new Promise((res) => { const s = createApi().listen(0, '127.0.0.1', () => res(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;

    const req = (method, p, { body, sid } = {}) => new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r = http.request(base + p, { method, headers }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, raw, json: j }); });
        });
        r.on('error', reject); if (data) r.write(data); r.end();
    });

    try {
        const signIn = async (pw) => ((await req('POST', '/login', { body: { password: pw } })).json || {}).sid;

        // ── THE GATE ────────────────────────────────────────────────────
        const anon = await req('GET', '/api/diagnostics');
        ck('no session gets no crash stacks', anon.status === 401 || anon.status === 403, `${anon.status}`);
        ck('  and no stack leaks in the refusal', !/payableOf/.test(anon.raw), anon.raw.slice(0, 120));

        const userSid = await signIn(process.env.APP_PASSWORD);
        ck('the app password signs in', !!userSid);
        const asUser = await req('GET', '/api/diagnostics', { sid: userSid });
        ck('  but does NOT get the report', asUser.status === 401 || asUser.status === 403, `${asUser.status}`);

        const sid = await signIn(process.env.ADMIN_PASSWORD);
        ck('the admin password signs in', !!sid);
        const r = await req('GET', '/api/diagnostics', { sid });
        ck('and gets the report', r.status === 200 && r.json && r.json.ok === true, `${r.status} ${r.raw.slice(0, 160)}`);

        // The figures the helper produced have to survive the round trip.
        ck('  carrying the crash stack', /loadsPdf\.js:47/.test(r.raw), 'the stack did not reach the client');
        ck('  and the restart count', r.json.boots && r.json.boots.unexplained_restarts === 1,
           JSON.stringify(r.json.boots && r.json.boots.unexplained_restarts));
        ck('  and nothing from the files that are not ours',
           !/hunter2|leakme/.test(r.raw));

        // Query parameters are numbers and are clamped. No parameter reaches
        // the filesystem — accepting ?file= would be one line and a hole.
        const clamped = await req('GET', '/api/diagnostics?hours=999999&crashes=-5', { sid });
        ck('an absurd window is clamped, not obeyed',
           clamped.status === 200 && clamped.json.boots.window_hours <= 24 * 30,
           JSON.stringify(clamped.json.boots && clamped.json.boots.window_hours));
        const junk = await req('GET', '/api/diagnostics?hours=../../etc/passwd', { sid });
        ck('  and a non-number falls back to the default',
           junk.status === 200 && junk.json.boots.window_hours === 48,
           JSON.stringify(junk.json.boots && junk.json.boots.window_hours));

        // ── THE PAGE, AND THE ROUTE IT IS ACTUALLY ON ───────────────────
        const page = await req('GET', '/health-report', { sid });
        ck('/health-report serves the page', page.status === 200 && /<h1>Health<\/h1>/.test(page.raw),
           `${page.status}`);
        ck('  with the shared rail', page.raw.includes('<script src="/sidebar.js" data-page="health" defer></script>'));
        // The page asks /api/diagnostics, not /api/health-report: /api/health
        // is a bare prefix of the latter and tests/ports.js section H refuses
        // a NEW route shaped that way. Asserted both ways so a rename back
        // cannot pass quietly.
        ck('  and it asks the route that exists', /\/api\/diagnostics/.test(page.raw));
        ck('  and not the prefix-clashing name it used to', !/\/api\/health-report/.test(page.raw));

        // THE MISTAKE THIS PINS: /health was already a liveness probe.
        const probe = await req('GET', '/health');
        ck('/health is STILL the unauthenticated probe', probe.status === 200 && probe.json
            && probe.json.status === 'ok', `${probe.status} ${probe.raw.slice(0, 80)}`);
        ck('  answering without a session, as a monitor needs',
           probe.status === 200 && !/<html/i.test(probe.raw),
           'putting the page here would have turned monitoring into an HTML fetch');
    } finally {
        await new Promise((res) => server.close(res));
    }
}

// ══════════════════════════════════════════════════════════════════════════
section('E — the page RENDERS, in one fixed clock');
// Found by rendering it and reading the output rather than trusting it: the
// first version formatted with getHours(), so the SAME crash read 19:00 on
// the VM, 12:00 on her Mac and 00:30 on a phone set to IST. A page whose job
// is to line a crash up against a cron schedule cannot have a moving clock,
// and every other dated decision in this app is evaluated in LA time.

{
    const { JSDOM } = require('jsdom');
    const html = fs.readFileSync(path.join(ROOT, 'dashboard/health.html'), 'utf8');

    // Lift the page's own stamp() out rather than reimplementing it — a
    // harness copy passes while the shipped copy is wrong.
    const at = html.indexOf('function stamp(');
    let depth = 0, end = -1;
    for (let j = html.indexOf('{', at); j < html.length; j++) {
        if (html[j] === '{') depth++;
        else if (html[j] === '}') { depth--; if (!depth) { end = j + 1; break; } }
    }
    const fnSrc = html.slice(at, end);
    ck('stamp() could be lifted out of the page', end > at);

    // runScripts: 'outside-only' — without it window.eval runs in THIS Node
    // context, where `window` does not exist, and the lifted function never
    // actually gets a page to live in.
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
    dom.window.eval(`window.LA='America/Los_Angeles'; window.stamp = ${fnSrc.replace(/^function stamp/, 'function')};`);
    const show = (iso, tz) => {
        // TZ is read by Intl per call, so flipping it between calls is what
        // simulates two machines looking at the same page.
        const was = process.env.TZ; process.env.TZ = tz;
        try { return dom.window.stamp(iso); } finally { process.env.TZ = was; }
    };

    // 2026-10-11T19:00:00Z is 12:00 Pacific (PDT, UTC-7).
    const utc = '2026-10-11T19:00:00.000Z';
    ck('a crash is shown in LA time', show(utc, 'UTC') === '10/11/2026 12:00:00', show(utc, 'UTC'));
    ck('  the same, from a machine set to IST', show(utc, 'Asia/Kolkata') === '10/11/2026 12:00:00',
       show(utc, 'Asia/Kolkata'));
    ck('  and from one set to Pacific', show(utc, 'America/Los_Angeles') === '10/11/2026 12:00:00',
       show(utc, 'America/Los_Angeles'));
    ck('MM/DD/YYYY, her format', /^\d{2}\/\d{2}\/\d{4} /.test(show(utc, 'UTC')));
    ck('  with seconds, because 36 of them identified the EOD job',
       /\d{2}:\d{2}:\d{2}$/.test(show(utc, 'UTC')), show(utc, 'UTC'));
    ck('a missing timestamp is a dash, not "Invalid Date"', dom.window.stamp(null) === '—');
    ck('  and an unparseable one is shown as given', dom.window.stamp('whenever') === 'whenever',
       'blanking a value we cannot parse hides information');
    // And the page has to SAY which clock, or she is guessing.
    ck('the page says the times are Los Angeles', /Los Angeles/.test(html));
}

// ══════════════════════════════════════════════════════════════════════════
section('F — the page and the nav agree');

{
    const read = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (e) { return ''; } };
    const bar = read('dashboard/sidebar.js');
    const core = read('dashboard/app/01-core.js');
    // Both nav copies, because tests/sidebar-pages.js compares them row for
    // row and a page in only one appears on some screens and not others.
    for (const [name, src] of [['sidebar.js', bar], ['app/01-core.js', core]]) {
        if (!src) continue;
        ck(`${name} has the Health row`, /id: 'health'/.test(src));
        ck(`  admin only`, /id: 'health',[^}]*adminOnly: true/.test(src),
           'a stack trace is the same tier as the WhatsApp QR');
    }
    ck('the rail points at /health-report', /health: '\/health-report'/.test(bar));
    // Comments stripped: the note explaining why it is NOT /health quotes
    // '/health', so a raw scan finds the thing in the prose about the thing.
    const pages = read('routes/pages.js')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ck('routes/pages.js serves it there', /app\.get\('\/health-report'/.test(pages));
    ck('  and does NOT claim /health', !/app\.get\('\/health'/.test(pages),
       '/health belongs to the liveness probe in api.js');
}

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) { console.log('Failures:'); failures.forEach(f => console.log('  - ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('ABORT', e); process.exit(1); });
