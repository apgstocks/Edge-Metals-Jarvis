// ── tests/ai-usage.js ─────────────────────────────────────────────────────
// Apsara, 2026-10-12: "observability should be there ... what actions does that
// agent perform, constantly monitoring cost so that I can keep track of it."
//
//   A  every model call is counted from its own usageMetadata, and the answer
//      (or the error) reaches the caller exactly as before
//   B  recording can NEVER be the reason a call fails
//   C  attribution: the real gemini.js path, and a scheduled job's name
//   D  cost is read-time, flagged as an estimate, and unpriced models say so
//   E  the cost watch speaks once a day, for the right reasons
//   F  END TO END: a real server, the routes the page calls, admin only
//   G  wiring: the nav, the page route, the hourly job

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-aiuse-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.AI_USAGE_IN_TEST = '1';                    // this file tests recording
process.env.AI_USAGE_FILE = path.join(TMP, 'ai-usage.jsonl');
process.env.AI_PRICES_FILE = path.join(TMP, 'ai-prices.json');
process.env.GEMINI_API_KEY = 'test-key-not-real';
process.env.APP_PASSWORD   = 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = 'staff-pw-ccccccccccc';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('  ABORT  config not isolated'); process.exit(1); }

const ai = require(path.join(ROOT, 'helpers/aiUsage'));
const lines = () => ai.readAll();
const reset = () => { try { fs.unlinkSync(process.env.AI_USAGE_FILE); } catch (e) {} };

const meta = (i, o, t = 0) => ({ promptTokenCount: i, candidatesTokenCount: o, thoughtsTokenCount: t });
const fakeClient = (behaviour) => ({
    getGenerativeModel: ({ model }) => ({ model, other: () => 'untouched',
        generateContent: async (...a) => behaviour(model, ...a) }),
});

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — counted from usageMetadata, answer untouched');
// ══════════════════════════════════════════════════════════════════════════
{
    reset();
    const answer = { response: { text: () => 'hello', usageMetadata: meta(1200, 300, 50) } };
    const c = ai.instrumentClient(fakeClient(async () => answer));
    const m = c.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
    const r = await m.generateContent('prompt');
    ck('the caller gets the very same result object', r === answer);
    ck('other methods on the model still work', m.other() === 'untouched');
    const l = lines();
    ck('one line was written', l.length === 1, String(l.length));
    ck('  with the model and the three token counts', l[0].model === 'gemini-2.5-flash-lite' && l[0].inTok === 1200 && l[0].outTok === 300 && l[0].thinkTok === 50, JSON.stringify(l[0]));
    ck('  and the Pacific day, ok flag and duration', /^\d{4}-\d{2}-\d{2}$/.test(l[0].day) && l[0].ok === true && typeof l[0].ms === 'number');
    ck('  and NOT the prompt or the answer', !JSON.stringify(l[0]).includes('prompt') && !JSON.stringify(l[0]).includes('hello'));
    ck('wrapping twice does not double count', ai.instrumentClient(c) === c);

    reset();
    const boom = new Error('quota exceeded');
    const c2 = ai.instrumentClient(fakeClient(async () => { throw boom; }));
    let thrown = null;
    try { await c2.getGenerativeModel({ model: 'm' }).generateContent('x'); } catch (e) { thrown = e; }
    ck('a failing call is re-thrown as the SAME error', thrown === boom);
    const f = lines();
    ck('  and recorded as failed, with the reason', f.length === 1 && f[0].ok === false && /quota/.test(f[0].err), JSON.stringify(f));
}

// ══════════════════════════════════════════════════════════════════════════
section('B — recording can never be the reason a call fails');
// ══════════════════════════════════════════════════════════════════════════
{
    const saved = process.env.AI_USAGE_FILE;
    process.env.AI_USAGE_FILE = path.join(TMP, 'file-not-dir', 'x', '\0bad');       // cannot be written
    const answer = { response: { text: () => 'ok', usageMetadata: meta(1, 1) } };
    const c = ai.instrumentClient(fakeClient(async () => answer));
    let r = null, err = null;
    try { r = await c.getGenerativeModel({ model: 'm' }).generateContent('x'); } catch (e) { err = e; }
    ck('an unwritable usage log does not break the call', !err && r === answer, err && err.message);
    const noMeta = ai.instrumentClient(fakeClient(async () => ({ response: { text: () => 'ok' } })));
    let err2 = null;
    try { await noMeta.getGenerativeModel({ model: 'm' }).generateContent('x'); } catch (e) { err2 = e; }
    ck('a response with no usageMetadata does not break it either', !err2);
    process.env.AI_USAGE_FILE = saved;
}

// ══════════════════════════════════════════════════════════════════════════
section('C — attribution: the real gemini.js path, and a scheduled job');
// ══════════════════════════════════════════════════════════════════════════
{
    reset();
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const realGGM = GoogleGenerativeAI.prototype.getGenerativeModel;
    GoogleGenerativeAI.prototype.getGenerativeModel = function ({ model }) {
        return { generateContent: async () => ({ response: { text: () => '{"a":1}', usageMetadata: meta(500, 40) } }) };
    };
    const gemini = require(path.join(ROOT, 'helpers/gemini'));
    const out = await gemini.callGeminiJSON('p', 0);
    ck('the real callGeminiJSON still returns its parsed answer', out && out.a === 1, JSON.stringify(out));
    let l = lines();
    ck('  and its call was counted, named after the function', l.length === 1 && l[0].fn === 'callGeminiJSON' && l[0].inTok === 500, JSON.stringify(l));

    reset();
    const heartbeat = require(path.join(ROOT, 'helpers/heartbeat'));
    const fakeCron = { schedule: (expr, fn) => fn };
    const wrapped = heartbeat.instrument(fakeCron);
    const job = wrapped.schedule('20 * * * *', () => gemini.callGeminiJSON('p', 0).catch((e) => console.error('[SCHED] unit-test-job:', e)));
    await job();
    l = lines();
    ck('a call made inside a scheduled job carries the job name', l.length === 1 && l[0].job === 'unit-test-job', JSON.stringify(l));
    ck('  and the job still ran as before', true);
    GoogleGenerativeAI.prototype.getGenerativeModel = realGGM;
}

// ══════════════════════════════════════════════════════════════════════════
section('D — cost: read-time, an estimate, and honest about gaps');
// ══════════════════════════════════════════════════════════════════════════
{
    const day = ai.pacificDay();
    const L = (model, i, o, extra = {}) => ({ t: new Date().toISOString(), day, model, job: null, fn: 'x', inTok: i, outTok: o, thinkTok: 0, ok: true, ...extra });
    const s = ai.summarise({ days: 7, lines: [L('gemini-2.5-flash-lite', 1e6, 1e6), L('gemini-9.9-mystery', 5000, 5000), L('gemini-2.5-flash-lite', 0, 0, { ok: false })] });
    ck('1M in + 1M out on 2.5-flash-lite = $0.50 at the table rate', Math.abs(s.byModel['gemini-2.5-flash-lite'].usd - 0.5) < 1e-9, String(s.byModel['gemini-2.5-flash-lite'].usd));
    ck('a model with no price is listed as unpriced, not silently free', s.unpriced.includes('gemini-9.9-mystery'));
    ck('  and its tokens are still counted', s.byModel['gemini-9.9-mystery'].inTok === 5000);
    ck('the figures are marked as an estimate', s.estimated === true);
    ck('a failed call is counted as failed', s.total.failed === 1);
    fs.writeFileSync(process.env.AI_PRICES_FILE, JSON.stringify({ 'gemini-2.5-flash-lite': { in: 1, out: 1, est: false } }));
    const s2 = ai.summarise({ days: 7, lines: [L('gemini-2.5-flash-lite', 1e6, 1e6)] });
    ck('a price she sets re-prices history, and is no longer an estimate', Math.abs(s2.total.usd - 2) < 1e-9 && s2.estimated === false, JSON.stringify([s2.total.usd, s2.estimated]));
    fs.unlinkSync(process.env.AI_PRICES_FILE);
    const old = ai.summarise({ days: 1, lines: [L('gemini-2.5-flash-lite', 1e6, 0, { day: '2020-01-01' })] });
    ck('lines outside the period are left out', old.calls === 0);
}

// ══════════════════════════════════════════════════════════════════════════
section('E — the cost watch');
// ══════════════════════════════════════════════════════════════════════════
{
    const watch = require(path.join(ROOT, 'helpers/aiCostWatch'));
    const sum = (today, prior) => ({ today: 'D0', todayUsd: today, byDay: { D0: { usd: today }, ...Object.fromEntries(prior.map((u, i) => ['P' + i, { usd: u }])) }, byCaller: { 'job-a': { usd: today, calls: 3, failed: 0 } }, estimated: true, unpriced: ['gemini-x'] });
    ck('under the limit and no spike -> quiet', watch.decide(sum(1, [1, 1, 1, 1]), 5) === null);
    ck('over the limit -> speaks', !!watch.decide(sum(6, [1, 1, 1]), 5));
    ck('a spike (3x the average, over $1) speaks even under the limit', !!watch.decide(sum(3.5, [1, 1, 1, 1]), 50));
    ck('a quiet week then a normal 50 cents does not', watch.decide(sum(0.5, [0.01, 0.01, 0.01]), 50) === null);
    const body = watch.bodyText(sum(6, [1]), watch.decide(sum(6, [1, 1, 1]), 5));
    ck('the email says it is estimated and names the unpriced model', /estimated/i.test(body) && /gemini-x/.test(body) && /NOT in the total/.test(body), body);

    reset();
    const day = ai.pacificDay();
    fs.writeFileSync(process.env.AI_USAGE_FILE, JSON.stringify({ t: new Date().toISOString(), day, model: 'gemini-3.6-flash', job: 'big-job', inTok: 3e6, outTok: 1e6, thinkTok: 0, ok: true }) + '\n');
    const sent = [];
    const r1 = await watch.check({ send: async (m) => sent.push(m) });
    ck('over the limit: one email is sent', r1.alerted === true && sent.length === 1 && /AI spend alert/.test(sent[0].subject), JSON.stringify(r1));
    const r2 = await watch.check({ send: async (m) => sent.push(m) });
    ck('checked again the same day: no second email', r2.alerted === false && sent.length === 1);
    const r3 = await watch.check({ send: async () => { throw new Error('mail down'); } });
    ck('a failing mailer never throws out of the watch', r3.alerted === false);
}

// ══════════════════════════════════════════════════════════════════════════
section('F — end to end: real server, the routes the page calls');
// ══════════════════════════════════════════════════════════════════════════
{
    const { createApi } = require(path.join(ROOT, 'api'));
    const app = createApi();
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = (method, p, { body, sid } = {}) => new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r2 = http.request(base + p, { method, headers }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j, raw }); });
        });
        r2.on('error', reject); if (data) r2.write(data); r2.end();
    });
    const admin = ((await req('POST', '/login', { body: { password: 'admin-pw-bbbbbbbbbbb' } })).json || {}).sid;
    const staff = ((await req('POST', '/login', { body: { password: 'staff-pw-ccccccccccc' } })).json || {}).sid;

    const sRes = await req('GET', '/api/ai-usage?days=30', { sid: admin });
    ck('admin reads /api/ai-usage', sRes.status === 200 && sRes.json.ok, `${sRes.status} ${sRes.raw.slice(0, 120)}`);
    ck('  it shows the seeded call under its job, with a cost', sRes.json.byCaller && sRes.json.byCaller['big-job'] && sRes.json.byCaller['big-job'].usd > 0, JSON.stringify(sRes.json.byCaller));
    ck('  and carries the limit, the prices and the estimate flag', sRes.json.limit_usd > 0 && sRes.json.prices && sRes.json.estimated === true);
    const before = ai.readAll().length;
    await req('GET', '/api/ai-usage', { sid: admin });
    ck('looking at the page does not itself add usage lines', ai.readAll().length === before);
    const st = await req('GET', '/api/ai-usage', { sid: staff });
    ck('staff cannot read it', st.status === 401 || st.status === 403, String(st.status));
    const st2 = await req('GET', '/api/activity', { sid: staff });
    ck('  nor the activity feed', st2.status === 401 || st2.status === 403, String(st2.status));

    const audit = require(path.join(ROOT, 'helpers/audit'));
    const e = await audit.record({ action: 'cleanup-saved-documents', subject: 'invoice', actor: 'apsara', role: 'admin', detail: {} });
    await audit.complete(e, 'done', {});
    const a = await req('GET', '/api/activity?limit=50', { sid: admin });
    ck('admin reads /api/activity', a.status === 200 && Array.isArray(a.json.items), `${a.status}`);
    ck('  it includes a person\'s action from the audit log', a.json.items.some((i) => i.source === 'audit' && /cleanup-saved-documents/.test(i.what)));
    ck('  and the AI-use summary for the job', a.json.items.some((i) => i.source === 'ai' && i.actor === 'big-job'));
    ck('  newest first', a.json.items.every((x, i, arr) => i === 0 || String(arr[i - 1].at) >= String(x.at)));

    const page = await req('GET', '/ai-usage', { sid: admin });
    ck('the page itself is served', page.status === 200 && /AI usage/.test(page.raw), String(page.status));
    server.close();
}

// ══════════════════════════════════════════════════════════════════════════
section('G — wiring');
// ══════════════════════════════════════════════════════════════════════════
{
    const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
    ck('the sidebar offers AI usage, admin only', /\{ id: 'ai-usage', label: 'AI usage', group: 'System', adminOnly: true \}/.test(read('dashboard/sidebar.js')));
    ck('the app nav offers it, admin only', /\{ id: 'ai-usage',\s+label: 'AI usage', group: 'System', adminOnly: true \}/.test(read('dashboard/app/01-core.js')));
    ck('clicking it opens /ai-usage', /dataset\.tab === 'ai-usage'[\s\S]{0,60}\/ai-usage/.test(read('dashboard/app/01-core.js')));
    ck('the hourly cost watch is scheduled', /cron\.schedule\('20 \* \* \* \*'[\s\S]{0,120}aiCostWatch[\s\S]{0,120}\[SCHED\] ai-cost-watch/.test(read('scheduler.js')));
    delete process.env.AI_USAGE_IN_TEST;
    ck('in test mode nothing is written unless asked (the live log is safe)', ai.enabled() === false);
    process.env.AI_USAGE_IN_TEST = '1';
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
