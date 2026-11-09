// tests/playbook-screen.js — the Playbook screen END TO END (CLAUDE.md rule 3): a real server, the real page in JSDOM
// whose fetch goes to that server, the real routes, and the rules read back out of the disk the CLI reads.
// Plus: it changes no decision, it is admin only, Edge Metals only, and a hostile rule is escaped.
const fs = require('fs'), os = require('os'), http = require('http'), path = require('path');
const { JSDOM } = require('jsdom');
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-pbscreen-'));
process.env.DATA_DIR = TMP; process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD = 'user-pw-aaaaaaaaaaa'; process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = 'staff-pw-ccccccccccc'; process.env.JARVIS_PASSWORD = 'jarvis-pw-ddddddddddd';
const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('ABORT config is not isolated'); process.exit(1); }
const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));
(async () => {
    const { createApi } = require(path.join(ROOT, 'api'));
    const server = await new Promise((r) => { const s = createApi().listen(0, '127.0.0.1', () => r(s)); });
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

    const playbook = require(path.join(ROOT, 'helpers/playbook'));
    const { getDisk } = require(path.join(ROOT, 'helpers/diskStore'));
    const metals = getDisk().for('edge_metals'), yard = getDisk().for('edge_yard');
    playbook.seed(metals);
    metals.facts.put({ scopeType: 'customer', scopeId: 'carlos', name: 'note', value: 'Carlos G & C <img src=x onerror=alert(1)>', by: 'apsara', role: 'manager' });
    metals.facts.put({ scopeType: 'global', name: 'structured', value: { a: 1 }, by: 'apsara', role: 'manager' });
    const yardBefore = JSON.stringify(yard.facts.all());

    console.log('\n=== routes ===');
    ck('a non-admin cannot list', (await req('GET', '/api/playbook', { sid: userSid })).status === 403);
    ck('a non-admin cannot edit', (await req('POST', '/api/playbook/edit', { sid: userSid, body: { id: 1, value: 'x' } })).status === 403);
    ck('a non-admin cannot forget', (await req('POST', '/api/playbook/forget', { sid: userSid, body: { id: 1 } })).status === 403);
    const ls = await req('GET', '/api/playbook', { sid: adminSid });
    ck('admin lists every rule: 8 seeded + 2 added', ls.status === 200 && ls.json.count === 10 && ls.json.company === 'edge_metals', JSON.stringify(ls.json).slice(0, 200));
    ck('a structured rule is listed but not editable', ls.json.rules.find((r) => r.name === 'structured').editable === false);
    ck('GET /playbook serves the page', (await req('GET', '/playbook', { sid: adminSid })).raw.includes('<title>Playbook'));

    console.log('\n=== the screen, against the real server ===');
    const html = fs.readFileSync(path.join(ROOT, 'dashboard/playbook.html'), 'utf8');
    let confirmAnswer = true; const calls = [];
    const dom = new JSDOM(html, { runScripts: 'dangerously', url: base + '/playbook', beforeParse: (w) => {
        w.confirm = () => confirmAnswer;
        w.fetch = async (u, o) => { calls.push(String(u)); const opts = { ...(o || {}), headers: { ...((o || {}).headers || {}), Authorization: `Bearer ${adminSid}` } };
            const r = await fetch(base + u, opts); return r; };
    } });
    await settle(300);
    const doc = dom.window.document, box = doc.getElementById('list');
    ck('every rule is on screen', doc.querySelectorAll('.rule').length === 10, String(doc.querySelectorAll('.rule').length));
    ck('her words are on screen', /LC terms get no payment follow-up/.test(box.textContent));
    ck('Rad Metal is listed under its own customer', /customer: rad-metal/.test(box.textContent));
    ck('a hostile rule is escaped, not executed', !box.querySelector('img') && /Carlos G & C <img/.test(box.textContent));
    ck('the structured rule has no Edit button', !doc.querySelector('.rule [data-edit="' + ls.json.rules.find((r) => r.name === 'structured').id + '"]'));

    const target = ls.json.rules.find((r) => r.name === 'report_style');
    doc.querySelector(`[data-edit="${target.id}"]`).click(); await settle(20);
    const ta = doc.querySelector('textarea');
    ck('Edit opens the words in a box', ta && ta.value === target.value);
    ta.value = 'Reports are one line each. Mondays may be longer.';
    doc.querySelector('[data-save]').click(); await settle(300);
    const after = playbook.list(metals).find((f) => f.name === 'report_style');
    ck('the edit reached the disk the CLI reads', after && after.value === 'Reports are one line each. Mondays may be longer.');
    ck('it replaced the rule, not added a second', playbook.list(metals).filter((f) => f.name === 'report_style').length === 1);
    ck('the old words stay in the log', metals.facts.history('global', '', 'report_style').length === 2);
    ck('the screen shows the new words', /Mondays may be longer/.test(box.textContent) && !/never a long list/.test(box.textContent));
    ck('the edit is signed with who made it and where', /edited on the Playbook screen/.test(box.textContent));
    ck('the backup file follows the edit straight away', JSON.stringify(JSON.parse(fs.readFileSync(path.join(TMP, 'disk', 'edge_metals', 'backup.json'), 'utf8'))).includes('Mondays may be longer'));
    const seedAgain = playbook.seed(metals);
    ck('running seed again keeps her edit as a conflict, not overwritten', seedAgain.conflicts.some((c) => c.name === 'report_style')
        && playbook.list(metals).find((f) => f.name === 'report_style').value.startsWith('Reports are one line'));

    const bad = await req('POST', '/api/playbook/edit', { sid: adminSid, body: { id: after.id, value: '   ' } });
    ck('an empty rule is refused (use Forget)', bad.status === 400);
    ck('an over-long rule is refused', (await req('POST', '/api/playbook/edit', { sid: adminSid, body: { id: after.id, value: 'x'.repeat(1001) } })).status === 400);
    ck('editing a structured rule is refused', (await req('POST', '/api/playbook/edit', { sid: adminSid, body: { id: ls.json.rules.find((r) => r.name === 'structured').id, value: 'x' } })).status === 400);
    ck('editing a rule that is gone is a 404', (await req('POST', '/api/playbook/edit', { sid: adminSid, body: { id: 99999, value: 'x' } })).status === 404);

    const victim = ls.json.rules.find((r) => r.name === 'if_unsure_ask');
    confirmAnswer = false; doc.querySelector(`[data-forget="${victim.id}"]`).click(); await settle(100);
    ck('declining the confirm forgets nothing', playbook.list(metals).some((f) => f.name === 'if_unsure_ask'));
    confirmAnswer = true; doc.querySelector(`[data-forget="${victim.id}"]`).click(); await settle(300);
    ck('Forget removes it from the disk', !playbook.list(metals).some((f) => f.name === 'if_unsure_ask'));
    ck('and from the screen', !/yes\/no question instead of guessing/.test(box.textContent));
    ck('seed does not bring a forgotten rule back', playbook.seed(metals).forgotten.some((x) => /if_unsure_ask/.test(x)));

    console.log('\n=== scope and side effects ===');
    ck('Edge Yard\'s partition was never touched (rule 5)', JSON.stringify(yard.facts.all()) === yardBefore);
    ck('the backup file records the forget', (JSON.parse(fs.readFileSync(path.join(TMP, 'disk', 'edge_metals', 'backup.json'), 'utf8')).facts || []).some((r) => r.t === 'forget' && r.id === victim.id));
    const src = fs.readdirSync(path.join(ROOT, 'helpers')).concat(fs.readdirSync(path.join(ROOT, 'workflow')).map((f) => '../workflow/' + f))
        .filter((f) => f.endsWith('.js') && f !== 'playbookRoutes.js' && f !== 'playbook.js')
        .filter((f) => /require\(['"]\.\/playbook['"]\)|helpers\/playbook['"]/.test(fs.readFileSync(path.join(ROOT, 'helpers', f), 'utf8')));
    ck('still nothing else reads the Playbook, so no decision changed', src.length === 0, src.join(', '));
    ck('the page never asks for another company', !/edge_yard|company=/.test(html));

    server.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
