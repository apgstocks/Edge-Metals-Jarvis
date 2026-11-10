// tests/daily-metrics.js — the daily metric END TO END (CLAUDE.md rule 3): stores written the way the app writes them, the figures read back
// through the real route and the real script. Read-only over the stores is a property under test; so is "never throws".
const fs = require('fs'), os = require('os'), http = require('http'), path = require('path');
const { spawnSync } = require('child_process');
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-metrics-'));
process.env.DATA_DIR = TMP; process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD = 'user-pw-aaaaaaaaaaa'; process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = 'staff-pw-ccccccccccc'; process.env.JARVIS_PASSWORD = 'jarvis-pw-ddddddddddd';
const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('ABORT config is not isolated'); process.exit(1); }
const NOW = Date.UTC(2026, 10, 10, 15, 0, 0), DAY = 86400000;
const J = (f, o) => fs.writeFileSync(path.join(TMP, f), JSON.stringify(o));
(async () => {
    const m = require(path.join(ROOT, 'helpers/dailyMetrics')), usage = require(path.join(ROOT, 'helpers/aiUsage'));
    const yday = usage.pacificDay(NOW - DAY);
    // deposits: 4 questions (2 yes, 1 no, 1 waiting); 3 auto-placed (1 undone) + 1 placed by her (must NOT count as auto)
    J('auto_applied.json', { entries: [
        { depositId: 'a', placedBy: 'jarvis-auto', undone: null }, { depositId: 'b', placedBy: 'jarvis-auto', undone: { at: 'x' } }, { depositId: 'c', placedBy: 'jarvis-auto', undone: null },
        { depositId: 'd', placedBy: 'her', undone: null }], blocks: [],
        asks: [{ id: 1, answer: { kind: 'yes' } }, { id: 2, answer: { kind: 'yes' } }, { id: 3, answer: { kind: 'no' } }, { id: 4, answer: null }] });
    // prices: 5 questions (2 normal, 2 check, 1 waiting)
    J('price_watch.json', { seen: {}, asks: [{ id: 1, answer: { kind: 'normal' } }, { id: 2, answer: { kind: 'normal' } }, { id: 3, answer: { kind: 'check' } }, { id: 4, answer: { kind: 'check' } }, { id: 5, answer: null }] });
    // model calls yesterday: 4, one failed; a call TODAY must not leak into "yesterday"
    const L = (day, ok) => JSON.stringify({ t: day + 'T12:00:00Z', day, model: 'gemini-2.5-flash-lite', fn: 'callGeminiJSON', inTok: 1000, outTok: 100, thinkTok: 0, cachedTok: 0, ms: 900, ok });
    fs.writeFileSync(path.join(TMP, 'ai-usage.jsonl'), [L(yday, true), L(yday, true), L(yday, true), L(yday, false), L(usage.pacificDay(NOW), true)].join('\n') + '\n');
    const before = ['auto_applied.json', 'price_watch.json', 'ai-usage.jsonl'].map((f) => fs.readFileSync(path.join(TMP, f), 'utf8'));

    console.log('\n=== the numbers ===');
    const s = await m.snapshot({ now: NOW, learnerReport: { judged: 40, abstained: 10, compared: 20, agree: 17, agreement: 0.85 } });
    ck('deposits: asked 4, yes 2, no 1, waiting 1', s.deposits.asked === 4 && s.deposits.yes === 2 && s.deposits.no === 1 && s.deposits.waiting === 1, JSON.stringify(s.deposits));
    ck('deposits: only Jarvis\'s own placements count as auto (3), 1 undone = 33.3%', s.deposits.auto_placed === 3 && s.deposits.undone === 1 && s.deposits.undo_pct === 33.3, JSON.stringify(s.deposits));
    ck('prices: asked 5, normal 2, check 2, waiting 1, check share 50%', s.prices.asked === 5 && s.prices.normal === 2 && s.prices.check === 2 && s.prices.waiting === 1 && s.prices.check_pct === 50, JSON.stringify(s.prices));
    ck('learner: agreement 85%, abstains 25% of 40', s.learner.agreement_pct === 85 && s.learner.abstain_pct === 25 && s.learner.judged === 40, JSON.stringify(s.learner));
    ck('ai: yesterday only: 4 calls, 1 failed, 25%', s.ai.day === yday && s.ai.calls === 4 && s.ai.failed === 1 && s.ai.fail_pct === 25, JSON.stringify(s.ai));
    ck('a learner that is off is null, not zero', (await m.snapshot({ now: NOW, learnerReport: null })).learner === null);
    const empty = await m.snapshot({ now: NOW, learnerReport: { judged: 0, abstained: 0, compared: 0, agree: 0, agreement: null } });
    ck('nothing compared yet: agreement is null (not 0%), abstain is null (not a divide by zero)', empty.learner.agreement_pct === null && empty.learner.abstain_pct === null);
    ck('reading changed no store', ['auto_applied.json', 'price_watch.json', 'ai-usage.jsonl'].every((f, i) => fs.readFileSync(path.join(TMP, f), 'utf8') === before[i]));

    console.log('\n=== recording: one line a day, append-only ===');
    const r1 = await m.record({ now: NOW, learnerReport: { judged: 40, abstained: 10, compared: 20, agree: 16, agreement: 0.8 } });
    const r2 = await m.record({ now: NOW + 3600000, learnerReport: { judged: 99, abstained: 0, compared: 99, agree: 99, agreement: 1 } });
    ck('first call records, second the same day does nothing', r1.ok && !r1.skipped && r2.ok && /already recorded/.test(r2.skipped) && m.readAll().length === 1);
    ck('the day\'s line is the FIRST one (not overwritten by the later call)', m.readAll()[0].learner.agreement_pct === 80);
    await m.record({ now: NOW + DAY, learnerReport: { judged: 50, abstained: 10, compared: 30, agree: 27, agreement: 0.9 } });
    await m.record({ now: NOW + 2 * DAY, learnerReport: null });
    const t = m.trend({ days: 30 });
    ck('trend: oldest first, agreement change vs the line before', t.length === 3 && t[0].agreement_change === null && t[1].agreement_change === 10, JSON.stringify(t.map((x) => x.agreement_change)));
    ck('trend: a day the learner was off gives no change (null), not a fake drop', t[2].agreement_change === null && t[2].learner === null);
    ck('trend honours days', m.trend({ days: 2 }).length === 2 && m.trend({ days: 'abc' }).length === 3);
    const keepF = process.env.JARVIS_METRICS_FILE; process.env.JARVIS_METRICS_FILE = path.join(TMP, 'long.jsonl');
    fs.writeFileSync(process.env.JARVIS_METRICS_FILE, Array.from({ length: 400 }, (_, i) => JSON.stringify({ day: 'd' + i, learner: null, deposits: {}, prices: {} })).join('\n') + '\n');
    ck('trend never returns more than a year, and days:0 / negative still return something', m.trend({ days: 9999 }).length === 365 && m.trend({ days: -5 }).length >= 1 && m.trend({ days: 0 }).length === 30);
    if (keepF === undefined) delete process.env.JARVIS_METRICS_FILE; else process.env.JARVIS_METRICS_FILE = keepF;
    ck('text names the figures', /agrees with you 85%/.test(m.text(s)) && /33.3%/.test(m.text(s)) && /2 normal, 2 check/.test(m.text(s)));
    ck('text says so when the learner is off', /off or not reachable/.test(m.text({ ...s, learner: null })));

    console.log('\n=== it never throws ===');
    const keep = process.env.JARVIS_METRICS_FILE;
    process.env.JARVIS_METRICS_FILE = path.join(TMP, 'a-file', 'x', 'metrics.jsonl'); fs.writeFileSync(path.join(TMP, 'a-file'), 'i am a file, not a folder');
    const bad = await m.record({ now: NOW + 9 * DAY, learnerReport: null });
    ck('an unwritable metrics file is {ok:false}, not an exception', bad.ok === false && !!bad.error);
    if (keep === undefined) delete process.env.JARVIS_METRICS_FILE; else process.env.JARVIS_METRICS_FILE = keep;
    fs.rmSync(path.join(TMP, 'a-file'));
    fs.writeFileSync(path.join(TMP, 'auto_applied.json'), '{not json'); fs.writeFileSync(path.join(TMP, 'price_watch.json'), '{not json');
    const broken = await m.snapshot({ now: NOW, learnerReport: null });
    ck('corrupt stores give zeroes, not a crash', broken.deposits.asked === 0 && broken.prices.asked === 0);
    fs.writeFileSync(path.join(TMP, 'auto_applied.json'), JSON.stringify(JSON.parse(before[0]))); fs.writeFileSync(path.join(TMP, 'price_watch.json'), before[1]);

    console.log('\n=== END TO END: the route and the script ===');
    const { createApi } = require(path.join(ROOT, 'api'));
    const server = await new Promise((r) => { const s2 = createApi().listen(0, '127.0.0.1', () => r(s2)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = (method, p, { body, sid } = {}) => new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body); const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r2 = http.request(base + p, { method, headers }, (res) => { let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j, raw }); }); });
        r2.on('error', reject); if (data) r2.write(data); r2.end(); });
    const login = async (pw) => ((await req('POST', '/login', { body: { password: pw } })).json || {}).sid;
    const adminSid = await login(process.env.ADMIN_PASSWORD), userSid = await login(process.env.APP_PASSWORD);
    ck('a non-admin is refused', (await req('GET', '/api/metrics', { sid: userSid })).status === 403);
    ck('no login is refused', [401, 403].includes((await req('GET', '/api/metrics')).status));
    const got = await req('GET', '/api/metrics?days=2', { sid: adminSid });
    ck('admin gets today\'s live figures from the same stores', got.status === 200 && got.json.today.deposits.asked === 4 && got.json.today.prices.check === 2 && got.json.today.learner === null, got.raw.slice(0, 200));
    ck('admin gets the saved history, honouring ?days', got.json.history.length === 2 && got.json.history[1].day === m.readAll()[2].day);
    server.close();
    const run = (...a) => spawnSync('node', [path.join(ROOT, 'scripts/daily-metrics.js'), ...a], { env: { ...process.env }, encoding: 'utf8' });
    const before2 = m.readAll().length;
    const out = run();
    ck('the script prints the day and does not write', out.status === 0 && /Jarvis metrics, /.test(out.stdout) && m.readAll().length === before2, out.stderr);
    const rec = run('--record');
    ck('--record saves one line (today is a new day)', rec.status === 0 && /recorded|already recorded/.test(rec.stdout), rec.stdout + rec.stderr);
    ck('--trend lists saved days', /agree/.test(run('--trend').stdout));

    console.log('\n=== wiring ===');
    const sched = fs.readFileSync(path.join(ROOT, 'scheduler.js'), 'utf8');
    ck('the job is scheduled and OFF unless JARVIS_DAILY_METRICS=1', /JARVIS_DAILY_METRICS === '1'\) cron\.schedule\('50 6 \* \* \*'/.test(sched));
    ck('the route is mounted', /metricsRoutes'\)\.mount\(app\)/.test(fs.readFileSync(path.join(ROOT, 'routes/pages.js'), 'utf8')));
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
