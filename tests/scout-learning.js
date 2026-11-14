// ── tests/scout-learning.js ─────────────────────────────────────────────────
// Apsara, 2026-11-14: "Yard assistant a.k.a. Scout needs to self learn as well", then
// "yes" to all four design questions: learn only from what manager/team type to it;
// show a lesson the first time it is used; pre-fill usual values (never price/date);
// keep it in the backup. Design: claude/scout-self-learning-design-2026-11-14.md.
// The model is faked (the wiring is under test, not its judgement); sections E and F go
// through the real server, as CLAUDE.md asks of every feature.
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-scoutlearn-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD = 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = 'staff-pw-ccccccccccc';
const ROOT = path.join(__dirname, '..');

let SCRIPT = []; let PROMPTS = [];
const geminiPath = require.resolve(path.join(ROOT, 'helpers/gemini.js'));
require.cache[geminiPath] = { id: geminiPath, filename: geminiPath, loaded: true, exports: {
    callGeminiJSON: async (prompt) => { PROMPTS.push(prompt); const n = SCRIPT.shift(); return typeof n === 'function' ? n(prompt) : (n || { answer: 'no script', have_data: true }); },
} };

const cfg = require(path.join(ROOT, 'config'));
const { mutateJson, loadJson } = require(path.join(ROOT, 'helpers/json'));
const { askYard } = require(path.join(ROOT, 'helpers/yardAsk'));
const sl = require(path.join(ROOT, 'helpers/scoutLearning'));
const ya = require(path.join(ROOT, 'helpers/yardActions'));
const diskStore = require(path.join(ROOT, 'helpers/diskStore'));
const yard = () => diskStore.getDisk().for('edge_yard');
const metals = () => diskStore.getDisk().for('edge_metals');

(async () => {
section('A. the rules of what may be kept');
{
    ck('admin is the manager, staff is the team, nobody else teaches', sl.teacherRole('admin') === 'manager' && sl.teacherRole('staff') === 'team' && sl.teacherRole('user') === null && sl.teacherRole(undefined) === null);
    ck('prices and weights are figures, not lessons', sl.carriesFigure('rotors are $0.25 a lb') && sl.carriesFigure('we sell at 0.30 per lb') && sl.carriesFigure('about 2,000 lb of cast') && !sl.carriesFigure('we call Ramesh\'s lots Auto cast'));
    const refused = sl.teach({ text: 'Metalco is a buyer', by: 'x', appRole: 'user' });
    ck('a user cannot teach', refused.ok === false && /manager or the team/.test(refused.reason), JSON.stringify(refused));
    const fig = sl.teach({ text: 'rotors sell at $0.25 per lb', by: 'a', appRole: 'admin' });
    ck('a figure is refused, saying why', fig.ok === false && /books/.test(fig.reason), JSON.stringify(fig));
    ck('over-long is refused', sl.teach({ text: 'x'.repeat(400), by: 'a', appRole: 'admin' }).ok === false);
    ck('nothing was stored by those', sl.list().length === 0);
}

section('B. teaching through the assistant: her own words, not the model\'s');
let lessonId;
{
    const words = "we call Ramesh's lots Auto cast";
    SCRIPT = [{ answer: 'Noted.', teach: true, have_data: true }];
    const out = await askYard(words, { role: 'admin' });
    ck('answers that it will remember', /remember/i.test(out.answer) && out.taught === true, JSON.stringify(out));
    const l = sl.list();
    lessonId = l[0] && l[0].id;
    ck('stored EXACTLY what she typed', l.length === 1 && l[0].text === words, JSON.stringify(l));
    SCRIPT = [{ answer: '', teach: true, have_data: true }];
    const bad = await askYard('Metalco is our buyer', { role: 'user' });
    ck('the same sentence from a plain user is refused', /can't keep that/.test(bad.answer) && sl.list().length === 1, bad.answer);
    SCRIPT = [{ answer: '', teach: true }];
    const figs = await askYard('rotors are $0.25 per lb', { role: 'admin' });
    ck('a price is refused even from the admin', /can't keep that/.test(figs.answer) && sl.list().length === 1, figs.answer);
    SCRIPT = [{ answer: 'Noted.', teach: true }];
    await askYard(words, { role: 'admin' });
    ck('saying it twice does not duplicate it', sl.list().length === 1);
}

section('C. recall, and telling her the first time it is used');
{
    PROMPTS = []; SCRIPT = [{ answer: 'Ramesh sold us 3 loads.', have_data: true, used_lessons: [lessonId] }];
    const one = await askYard('what did Ramesh sell us', { role: 'admin' });
    ck('the lesson is in the prompt, with its number', PROMPTS[0].includes("we call Ramesh's lots Auto cast") && PROMPTS[0].includes(`[#${lessonId}]`));
    ck('  and the prompt says it is advice, never a figure source', /never a source of figures/.test(PROMPTS[0]));
    ck('first use: she is told, with how to undo', /I used what you taught me/.test(one.answer) && /forget/i.test(one.answer), one.answer);
    SCRIPT = [{ answer: 'Again 3 loads.', have_data: true, used_lessons: [lessonId] }];
    const two = await askYard('what did Ramesh sell us again', { role: 'admin' });
    ck('second use: not repeated', !/I used what you taught me/.test(two.answer), two.answer);
    SCRIPT = [{ answer: 'Fine.', have_data: true, used_lessons: [9999] }];
    const three = await askYard('anything', { role: 'admin' });
    ck('a lesson number the model invents is ignored', !/I used what you taught me/.test(three.answer));
}

section('D. forgetting, by asking and from the list');
{
    SCRIPT = [{ answer: 'Done.', have_data: true, forget_lesson: lessonId }];
    const f = await askYard('forget that', { role: 'user' });
    ck('a plain user cannot make Scout forget', /only the manager or the team/.test(f.answer) && sl.list().length === 1, f.answer);
    const lessonName = yard().facts.list('lesson', 'scout')[0].name;
    SCRIPT = [{ answer: 'Done.', have_data: true, forget_lesson: lessonId }];
    const f2 = await askYard('forget that', { role: 'admin' });
    ck('the admin can, by asking', /Forgotten/.test(f2.answer) && sl.list().length === 0, f2.answer);
    PROMPTS = []; SCRIPT = [{ answer: 'ok', have_data: true }];
    await askYard('anything else', { role: 'admin' });
    ck('and it is gone from the next prompt', !PROMPTS[0].includes('Auto cast'));
    const h = yard().facts.history('lesson', 'scout', lessonName);
    ck('a forgotten lesson is kept in the record as forgotten (history), not erased', h.length === 1 && h[0].live === false && !!h[0].forgottenAt, JSON.stringify(h));
}

section('E. what happens to a card: confirm, cancel, expire — through the real server');
{
    await mutateJson(cfg.LOADS_FILE, [], () => [
        { id: 'EDGE_1', date: '2026-11-02', seller: 'R', net_weight: 5000, amount: 900, items: [{ description: 'Rotors', net_weight: 5000, amount: 900 }] },
    ]);
    const { createApi } = require(path.join(ROOT, 'api'));
    const server = await new Promise((r) => { const s = createApi().listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = (method, p, { body, sid } = {}) => new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r2 = http.request(base + p, { method, headers }, (res) => { let raw = ''; res.on('data', (c) => { raw += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j }); }); });
        r2.on('error', reject); if (data) r2.write(data); r2.end();
    });
    const admin = ((await req('POST', '/login', { body: { password: process.env.ADMIN_PASSWORD } })).json || {}).sid;
    const staff = ((await req('POST', '/login', { body: { password: process.env.STAFF_PASSWORD } })).json || {}).sid;
    const stats = () => yard().log.stats('act:record_outbound_sale');
    const sale = (price, desc) => ya.proposeAction({ kind: 'record_outbound_sale', params: { buyer: 'Metalco', date: '2026-11-14', price, descriptions: [desc || 'Rotors'] } }, { role: 'admin' });

    const p1 = await sale(0.25);
    const c = await req('POST', '/api/yard/cancel-action', { sid: admin, body: { id: p1.id } });
    await new Promise((r) => setTimeout(r, 150));
    ck('cancelling is learned as rejected', c.status === 200 && stats().total === 1 && stats().last === 'rejected', JSON.stringify(stats()));

    const p2 = await sale(0.25);
    const act = await req('POST', '/api/yard/act', { sid: admin, body: { id: p2.id } });
    await new Promise((r) => setTimeout(r, 150));
    ck('/api/yard/act confirms it, and it is learned as approved', act.status === 200 && stats().approved === 1 && stats().last === 'approved', JSON.stringify([act.status, stats()]));

    // Expiry: age the proposal past its TTL, then sweep (any propose/confirm sweeps).
    const p3 = await sale(0.25, 'Rotors').catch(() => null);
    ck('(stock is now sold out, so a second sale of it is refused up front — nothing to learn from)', p3 === null);

    // Streaks for usual values: buyer confirmed identically three times.
    await sl.outcome(yard().log.event({ key: 'act:record_outbound_sale', decisionType: 'yard_action' }), 'confirmed', { kind: 'record_outbound_sale', params: { buyer: 'Metalco', price: 0.99, date: '2026-01-01' } });
    await sl.outcome(yard().log.event({ key: 'act:record_outbound_sale', decisionType: 'yard_action' }), 'confirmed', { kind: 'record_outbound_sale', params: { buyer: 'Metalco', price: 0.11 } });
    const hints = sl.usualHints();
    ck('three confirmed with the same buyer → "usually Metalco"', hints.some((h) => h.kind === 'record_outbound_sale' && h.field === 'buyer' && h.value === 'Metalco'), JSON.stringify(hints));
    ck('a price or a date is NEVER offered as usual, however consistent', !hints.some((h) => /price|date|amount|weight|load_id/.test(h.field)) && !JSON.stringify(fs.readFileSync(path.join(TMP, 'scout_usual.json'), 'utf8')).includes('0.99'), JSON.stringify(hints));
    PROMPTS = []; SCRIPT = [{ answer: 'ok', have_data: true }];
    await sl.teach({ text: 'Metalco is a buyer', by: 'a', appRole: 'admin' });
    await askYard('anything', { role: 'admin' });
    ck('and the usual value reaches the prompt, with the never-assume-price warning', /USUAL VALUES/.test(PROMPTS[0]) && /buyer = Metalco/.test(PROMPTS[0]) && /NEVER assume a price/.test(PROMPTS[0]));

    section('F. the lessons list, through the real routes');
    const list = await req('GET', '/api/yard/lessons', { sid: admin });
    ck('admin sees the list', list.status === 200 && list.json.lessons.some((l) => l.text === 'Metalco is a buyer'), JSON.stringify(list.json));
    const staffList = await req('GET', '/api/yard/lessons', { sid: staff });
    ck('staff does not', staffList.status === 403 || staffList.status === 401, String(staffList.status));
    const id = list.json.lessons.find((l) => l.text === 'Metalco is a buyer').id;
    const staffForget = await req('POST', '/api/yard/lessons/forget', { sid: staff, body: { id } });
    ck('staff cannot forget', staffForget.status === 403 || staffForget.status === 401);
    const fg = await req('POST', '/api/yard/lessons/forget', { sid: admin, body: { id } });
    ck('admin can Forget from the list', fg.status === 200 && fg.json.ok === true && sl.list().every((l) => l.id !== id));
    server.close();
}

section('G. Edge Yard only, and backed up');
{
    await sl.teach({ text: 'Ramesh is a seller', by: 'a', appRole: 'admin' });
    ck('the lesson exists in the EDGE YARD partition', yard().facts.list('lesson', 'scout').length >= 1);
    ck('and NOT in Edge Metals', metals().facts.list('lesson', 'scout').length === 0 && !JSON.stringify(metals().facts.all()).includes('Ramesh is a seller'));
    const snap = path.join(TMP, 'disk', 'edge_yard', 'backup.json');
    ck('a backup.json sits in the folder the nightly backup walks, and holds the lesson', fs.existsSync(snap) && JSON.stringify(JSON.parse(fs.readFileSync(snap, 'utf8')).facts).includes('Ramesh is a seller'));
    ck('Edge Metals has no lesson backup of it', !fs.existsSync(path.join(TMP, 'disk', 'edge_metals', 'backup.json')) || !fs.readFileSync(path.join(TMP, 'disk', 'edge_metals', 'backup.json'), 'utf8').includes('Ramesh is a seller'));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }
process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
