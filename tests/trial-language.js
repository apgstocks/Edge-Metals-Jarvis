// ── tests/trial-language.js — the English / Spanish switch in a trial/product copy ───────────────────────────
//
// Apsara, 2026-11-19: the Spanish switch ships in trial copies. "While doing initial one-time setup for a user I will do
// default language, but they can change it anytime, user by user basis."
//   A  the builder: --lang sets the customer's starting language; a bad value stops the build; the live file is untouched
//   B  the switch's own behaviour in the copy (browser DOM): default, browser choice, a person's saved choice, saving
//   C  the real thing: a real copy, a real server, the real routes — a person's choice is theirs alone and survives a restart
//   D  the provisioner: --lang at setup, kept across an upgrade, refused on an upgrade
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');
const { JSDOM } = require('jsdom');
let pass = 0, fail = 0; const ck = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n); if (x) console.log('        ' + String(x).slice(0, 400)); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const ROOT = path.join(__dirname, '..'), VM = (f) => path.join(ROOT, 'scripts/trial-vm', f);
const sha = (f) => crypto.createHash('sha1').update(fs.readFileSync(path.join(ROOT, f))).digest('hex');
const LIVE = ['dashboard/yard-lang.js', 'dashboard/index.html', 'api.js', 'routes/core.js'];
const before = Object.fromEntries(LIVE.map((f) => [f, sha(f)]));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-lang-'));
const tick = () => new Promise((r) => setTimeout(r, 80));
const mk = (name, slug, out, extra) => spawnSync('node', [path.join(ROOT, 'scripts/make-trial.js'), '--name', name, '--slug', slug, '--out', out, '--link-modules', ...(extra || [])], { encoding: 'utf8', timeout: 120000 });

(async () => {
    // ── A ──────────────────────────────────────────────────────────────────────────────────────────────────
    section('A — the builder');
    const es = path.join(tmp, 'es'), en = path.join(tmp, 'en');
    const mEs = mk('Acme Scrap', 'acme', es, ['--lang', 'es', '--port', '39561']), mEn = mk('Beta Yard', 'beta', en, ['--port', '39562']);
    ck('a copy built with --lang es builds and the leak check is clean', mEs.status === 0 && /leak check: clean/.test(mEs.stdout), mEs.stdout + mEs.stderr);
    ck('a copy built without --lang builds and the leak check is clean', mEn.status === 0 && /leak check: clean/.test(mEn.stdout), mEn.stdout + mEn.stderr);
    const rd = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');
    ck('--lang es starts that customer in Spanish', /YARD_DEFAULT_LANG = 'es'/.test(rd(es, 'dashboard/yard-lang-default.js')));
    ck('no --lang starts in English (the same as the live app)', /YARD_DEFAULT_LANG = 'en'/.test(rd(en, 'dashboard/yard-lang-default.js')));
    ck('the page loads the default BEFORE the switch, once each', (() => { const h = rd(es, 'dashboard/index.html'); const a = h.indexOf('yard-lang-default.js'), b = h.indexOf('"yard-lang.js"'); return a > 0 && b > a && h.split('yard-lang-default.js').length === 2; })());
    const bad = mk('Gamma Yard', 'gamma', path.join(tmp, 'bad'), ['--lang', 'fr']);
    ck('--lang with anything but en or es stops the build', bad.status !== 0 && /--lang must be en or es/.test(bad.stdout + bad.stderr) && !fs.existsSync(path.join(tmp, 'bad', 'trial-server.js')));
    ck('the README says where to change the default and that people can switch', /yard-lang-default\.js/.test(rd(es, 'TRIAL-README.md')) && /Spanish/.test(rd(es, 'TRIAL-README.md')) && /English/.test(rd(en, 'TRIAL-README.md')));
    for (const f of LIVE) ck(`live ${f} unchanged`, sha(f) === before[f]);
    ck('the live switch has no account or default code: English stays the live default', !/YARD_DEFAULT_LANG|syncAccount|api\/me\/language/.test(fs.readFileSync(path.join(ROOT, 'dashboard/yard-lang.js'), 'utf8')) && !fs.existsSync(path.join(ROOT, 'dashboard/yard-lang-default.js')));

    // ── B ──────────────────────────────────────────────────────────────────────────────────────────────────
    section('B — the switch in the copy (browser DOM)');
    const SRC = rd(es, 'dashboard/yard-lang.js');
    const BODY = '<div id="viewRoot"><h1>Loads</h1><button id="save">Save load</button></div>';
    // me = what /api/me answers (null = 401 / not signed in); def = the customer default; stored = what this browser remembers
    function mount({ def, stored, me, fetchFails } = {}) {
        const dom = new JSDOM(`<!doctype html><html lang="en"><head></head><body>${BODY}</body></html>`, { runScripts: 'dangerously', url: 'http://localhost/' });
        const w = dom.window; w.__calls = [];
        if (stored) w.localStorage.setItem('yard_ui_lang', stored);
        w.fetch = (url, opt) => {
            w.__calls.push({ url, method: (opt && opt.method) || 'GET', body: opt && opt.body });
            if (fetchFails) return Promise.reject(new Error('offline'));
            if (url === '/api/me') return Promise.resolve({ ok: !!me, json: () => Promise.resolve(me) });
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
        };
        const s0 = w.document.createElement('script'); s0.textContent = `let CURRENT_TAB = 'loads';${def ? ` window.YARD_DEFAULT_LANG = '${def}';` : ''}`; w.document.head.appendChild(s0);
        const s = w.document.createElement('script'); s.textContent = SRC; w.document.body.appendChild(s);
        return w;
    }
    const saveText = (w) => w.document.getElementById('save').textContent;
    const posts = (w) => w.__calls.filter((c) => c.method === 'POST');
    let w = mount({ def: 'es' }); await tick();
    ck('customer default Spanish, nothing chosen, not signed in: the page is in Spanish', saveText(w) === 'Guardar carga' && w.yardLang.get() === 'es');
    w = mount({ def: 'en' }); await tick();
    ck('customer default English: the page is in English', saveText(w) === 'Save load' && w.yardLang.get() === 'en');
    w = mount(); await tick();
    ck('no default file at all (an older copy): English', saveText(w) === 'Save load');
    w = mount({ def: 'es', stored: 'en' }); await tick();
    ck('a browser that chose English keeps English even when the customer default is Spanish (owner-password sign-ins)', saveText(w) === 'Save load');
    w = mount({ def: 'en', stored: 'es' }); await tick();
    ck('a browser that chose Spanish keeps Spanish when the customer default is English', saveText(w) === 'Guardar carga');
    w = mount({ def: 'es', me: { userId: null, language: null } }); await tick();
    ck('an owner-password sign-in (no account): no language is ever sent to the server', saveText(w) === 'Guardar carga' && (w.yardLang.set('en'), await tick(), posts(w).length === 0));
    w = mount({ def: 'es', stored: 'en', me: { userId: 'ravi', language: null } }); await tick();
    ck('a person with no saved choice starts in the CUSTOMER default, not in the previous person\'s browser choice', saveText(w) === 'Guardar carga' && w.localStorage.getItem('yard_ui_lang') === 'es');
    w = mount({ def: 'es', stored: 'es', me: { userId: 'maria', language: 'en' } }); await tick();
    ck('a person whose saved choice is English sees English on a browser that last showed Spanish', saveText(w) === 'Save load' && posts(w).length === 0);
    w = mount({ def: 'en', me: { userId: 'maria', language: 'es' } }); await tick();
    ck('a person whose saved choice is Spanish sees Spanish on a brand-new browser, whatever the customer default', saveText(w) === 'Guardar carga');
    w = mount({ def: 'en', me: { userId: 'maria', language: null } }); await tick();
    w.yardLang.set('es'); await tick();
    ck('a person who switches: the page changes and exactly one save goes to their account', saveText(w) === 'Guardar carga' && posts(w).length === 1 && posts(w)[0].url === '/api/me/language' && JSON.parse(posts(w)[0].body).language === 'es');
    const loaded = mount({ def: 'en', me: { userId: 'maria', language: 'es' } }); await tick();
    ck('…and applying their saved choice at page load does NOT send anything back', saveText(loaded) === 'Guardar carga' && posts(loaded).length === 0);
    w = mount({ def: 'es', me: { userId: 'maria', language: 'es' } }); await tick();
    ck('a saved choice equal to what is already showing sends nothing', posts(w).length === 0 && saveText(w) === 'Guardar carga');
    w = mount({ def: 'es', fetchFails: true }); await tick();
    ck('the account lookup failing (offline) leaves the default in place and breaks nothing', saveText(w) === 'Guardar carga');
    w = mount({ def: 'es', me: null }); await tick();
    ck('not signed in (the lookup says 401): the default in place', saveText(w) === 'Guardar carga' && posts(w).length === 0);
    w = mount({ def: 'es', me: { userId: 'maria', language: 'fr' } }); await tick();
    ck('a garbage saved value is ignored: the customer default', saveText(w) === 'Guardar carga');

    // ── C ──────────────────────────────────────────────────────────────────────────────────────────────────
    section('C — a real copy, a real server, the real routes');
    const PORT = 39561;
    const env = rd(es, '.env'); const pw = (k) => (env.match(new RegExp(k + '_PASSWORD=(.+)')) || [])[1];
    const run = (cmd) => spawnSync('node', [cmd], { cwd: es, encoding: 'utf8', timeout: 90000 });
    ck('the demo data seeds', run('trial-seed.js').status === 0);
    const req = (m, p, body, sid) => new Promise((res) => { const d = body ? JSON.stringify(body) : null; const h = {}; if (d) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(d); } if (sid) h.Authorization = `Bearer ${sid}`; const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method: m, headers: h }, (x) => { let raw = ''; x.setEncoding('utf8'); x.on('data', (c) => { raw += c; }); x.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch (e) { /* not json */ } res({ status: x.statusCode, raw, json }); }); }); r.on('error', () => res({ status: 0, raw: '', json: null })); if (d) r.write(d); r.end(); });
    let srv = null;
    const start = async () => { srv = spawn('node', ['trial-server.js'], { cwd: es, stdio: 'ignore' }); for (let i = 0; i < 60; i++) { if ((await req('GET', '/api/health')).status > 0) return true; await new Promise((r) => setTimeout(r, 1000)); } return false; };
    const stop = () => new Promise((r) => { if (!srv) return r(); srv.once('exit', r); srv.kill(); });
    ck('the server starts', await start());
    try {
        const login = async (userId, password) => (await req('POST', '/login', userId === null ? { password } : { userId, password })).json || {};
        const owner = (await login(null, pw('ADMIN'))).sid;
        const dflt = await req('GET', '/yard-lang-default.js'), sw = await req('GET', '/yard-lang.js', null, owner);
        ck('the default is served BEFORE sign-in (the sign-in page needs it) and says Spanish for this customer', dflt.status === 200 && /YARD_DEFAULT_LANG = 'es'/.test(dflt.raw), dflt.status);
        ck('the switch itself is still behind sign-in, as in the live app', (await req('GET', '/yard-lang.js')).status === 401 && sw.status === 200 && /syncAccount/.test(sw.raw));
        ck('nothing else leaked through the new public route (the data and users files are still closed)', (await req('GET', '/data/users.json')).status === 401 && (await req('GET', '/api/users')).status === 401);
        // the sign-in page, as served, run in a browser-like DOM
        const loginPage = (await req('GET', '/login')).raw;
        const signIn = async (def, stored) => {
            const dom = new JSDOM(loginPage.replace('<script src="/yard-lang-default.js"></script>', `<script>window.YARD_DEFAULT_LANG='${def}'</script>`), { runScripts: 'dangerously', url: 'http://localhost/', beforeParse(win) { if (stored) win.localStorage.setItem('yard_ui_lang', stored); } });
            await tick(); const d = dom.window.document;
            return { h1: d.querySelector('h1').textContent, btn: d.getElementById('b').textContent, labels: [].map.call(d.querySelectorAll('label'), (x) => x.textContent).join('|'), hint: [].map.call(d.querySelectorAll('p'), (x) => x.textContent).join('|'), lang: d.documentElement.lang };
        };
        const sp = await signIn('es'), enp = await signIn('en'), eb = await signIn('es', 'en'), sb = await signIn('en', 'es');
        ck('the sign-in page in a Spanish customer\'s copy is in Spanish', sp.h1 === 'Iniciar sesión' && sp.btn === 'Iniciar sesión' && sp.labels === 'ID de usuario|Contraseña' && /Solo acceso interno/.test(sp.hint) && /ID de usuario vacío/.test(sp.hint) && sp.lang === 'es', JSON.stringify(sp));
        ck('the sign-in page in an English customer\'s copy is exactly the English it was', enp.h1 === 'Sign in' && enp.btn === 'Sign in' && enp.labels === 'User ID|Password' && /Leave the user ID empty/.test(enp.hint) && enp.lang === 'en');
        ck('a browser that chose English sees English even in a Spanish customer\'s copy, and the reverse', eb.h1 === 'Sign in' && sb.h1 === 'Iniciar sesión');
        ck('the sign-in page still posts the user ID and password it always did', /userId: document\.getElementById\('uid'\)\.value/.test(loginPage) && /password: document\.getElementById\('pw'\)\.value/.test(loginPage));
        ck('the wrong-password message is in Spanish too (a failed sign-in, run for real)', await (async () => {
            const dom = new JSDOM(loginPage.replace('<script src="/yard-lang-default.js"></script>', "<script>window.YARD_DEFAULT_LANG='es'</script>"), { runScripts: 'dangerously', url: 'http://localhost/' });
            const w2 = dom.window; w2.fetch = () => Promise.resolve({ ok: false, status: 401 });
            w2.document.getElementById('pw').value = 'x'; w2.document.getElementById('f').dispatchEvent(new w2.Event('submit', { cancelable: true })); await tick();
            return w2.document.getElementById('e').textContent === 'ID de usuario o contraseña incorrectos.' && w2.document.getElementById('b').textContent === 'Iniciar sesión';
        })());
        const pageHtml = await req('GET', '/', null, owner);
        ck('the page the browser gets loads the default before the switch', pageHtml.status === 200 && pageHtml.raw.indexOf('yard-lang-default.js') > 0 && pageHtml.raw.indexOf('yard-lang-default.js') < pageHtml.raw.indexOf('"yard-lang.js"'));
        await req('POST', '/api/roles', { name: 'Scale operator', pages: ['loads'] }, owner);
        const roleId = ((await req('GET', '/api/users', null, owner)).json.roles.find((r) => r.name === 'Scale operator') || {}).id;
        for (const u of ['ravi', 'maria']) await req('POST', '/api/users', { id: u, name: u.toUpperCase(), roleId, password: 'pass-word-123' }, owner);
        const S = { ravi: (await login('ravi', 'pass-word-123')).sid, maria: (await login('maria', 'pass-word-123')).sid };
        const me = (s) => req('GET', '/api/me', null, s);
        ck('a new person has no language of their own yet (they start in the customer default)', (await me(S.ravi)).json.language === null && (await me(S.maria)).json.language === null);
        ck('the owner password has no account language either', (await me(owner)).json.language === null);
        const set = await req('POST', '/api/me/language', { language: 'en' }, S.ravi);
        ck('ravi chooses English through the route the switch posts to', set.status === 200 && set.json.ok === true, set.raw);
        ck('/api/me now reports ravi\'s English — and maria\'s is untouched', (await me(S.ravi)).json.language === 'en' && (await me(S.maria)).json.language === null);
        ck('ravi signs in again (a new session, a new device): his choice is still there', (await me((await login('ravi', 'pass-word-123')).sid)).json.language === 'en');
        ck('choosing a language does not sign anyone out (it is not a password change)', (await req('GET', '/api/loads', null, S.ravi)).status === 200);
        ck('maria chooses Spanish and ravi keeps English', (await req('POST', '/api/me/language', { language: 'es' }, S.maria)).status === 200 && (await me(S.maria)).json.language === 'es' && (await me(S.ravi)).json.language === 'en');
        ck('anything but en or es is refused and changes nothing', (await req('POST', '/api/me/language', { language: 'fr' }, S.ravi)).status === 400 && (await req('POST', '/api/me/language', {}, S.ravi)).status === 400 && (await req('POST', '/api/me/language', { language: 'ES' }, S.ravi)).status === 400 && (await me(S.ravi)).json.language === 'en');
        ck('the owner password has no account to save it on, and says so', (await req('POST', '/api/me/language', { language: 'es' }, owner)).status === 400);
        ck('not signed in: refused', [401, 403].includes((await req('POST', '/api/me/language', { language: 'es' })).status));
        ck('a manager changing a person\'s ROLE does not reset their language', (await req('PUT', '/api/users/maria', { roleId: 'yard-staff' }, owner)).status === 200 && (await me(S.maria)).json.language === 'es');
        const file = path.join(es, 'data', 'users.json');
        ck('it is saved in the account file, and that file still holds no plain passwords', fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).users.find((u) => u.id === 'maria').lang === 'es' && !/pass-word-123/.test(fs.readFileSync(file, 'utf8')));
        await stop(); ck('the server restarts', await start());
        ck('after a restart both choices are still there, per person', (await me((await login('ravi', 'pass-word-123')).sid)).json.language === 'en' && (await me((await login('maria', 'pass-word-123')).sid)).json.language === 'es');
        const owner2 = (await login(null, pw('ADMIN'))).sid;       // the restart ended every session, the owner's included
        const del = await req('DELETE', '/api/users/maria', null, owner2), re = await req('POST', '/api/users', { id: 'maria', name: 'Maria', roleId, password: 'pass-word-123' }, owner2), again = await login('maria', 'pass-word-123'), meAgain = await me(again.sid);
        ck('a removed person\'s choice goes with them: a new person with the same ID starts fresh', del.status === 200 && re.status === 200 && meAgain.json && meAgain.json.language === null, [del.status, re.raw, JSON.stringify(again), meAgain.raw].join(' | '));
    } finally { await stop(); }

    // ── D ──────────────────────────────────────────────────────────────────────────────────────────────────
    section('D — the provisioner (setup on the VM)');
    const TRIALS = path.join(tmp, 'srv'), ARCH = path.join(tmp, 'arch'), ENVF = path.join(tmp, 'trials.env'), TEMPLATE = path.join(tmp, 'kit/template');
    fs.mkdirSync(TRIALS); fs.mkdirSync(ARCH); fs.writeFileSync(ENVF, 'TRIAL_DOMAIN=trials.example.com\n');
    const tm = mk('Tenantzz Co', 'tenantzz', TEMPLATE, ['--port', '39700']);
    ck('the neutral template builds (English default inside it)', tm.status === 0 && /YARD_DEFAULT_LANG = 'en'/.test(rd(TEMPLATE, 'dashboard/yard-lang-default.js')), tm.stdout + tm.stderr);
    const E = { ...process.env, TRIALS_DIR: TRIALS, ENV_FILE: ENVF, ARCHIVE_DIR: ARCH, SKIP_PM2: '1', SKIP_CADDY: '1', SKIP_NPM: '1', TEMPLATE_DIR: TEMPLATE, TRIAL_UP: VM('trial-up.sh'), TRIAL_DOWN: VM('trial-down.sh') };
    const prov = (args) => spawnSync('node', [VM('provision.js'), ...args], { encoding: 'utf8', env: E, timeout: 120000 });
    const lang = (slug) => (rd(path.join(TRIALS, slug), 'dashboard/yard-lang-default.js').match(/YARD_DEFAULT_LANG = '(\w+)'/) || [])[1];
    const a = prov(['acme', 'Acme Scrap', '--lang', 'es', '--email', 'o@acme.example']);
    ck('a customer set up with --lang es starts in Spanish', a.status === 0 && lang('acme') === 'es', a.stderr + a.stdout);
    ck('…and the result line says which language it was set up with', /"lang":"es"/.test(a.stdout));
    ck('--lang placed before the company name does not turn "es" into the name', (() => { const r = prov(['--lang', 'es', 'zeta', 'Zeta Yard']); return r.status === 0 && lang('zeta') === 'es' && /Zeta Yard/.test(rd(path.join(TRIALS, 'zeta'), 'TRIAL-README.md')); })());
    const b = prov(['beta', 'Beta Yard']);
    ck('a customer set up without --lang starts in English', b.status === 0 && lang('beta') === 'en' && /"lang":"en"/.test(b.stdout), b.stderr);
    const c = prov(['gamma', 'Gamma Yard', '--lang', 'fr']);
    ck('a bad --lang stops setup and creates nothing', c.status !== 0 && /--lang must be en or es/.test(c.stderr) && !fs.existsSync(path.join(TRIALS, 'gamma')));
    const html = rd(path.join(TRIALS, 'acme'), 'dashboard/index.html');
    ck('the customer\'s copy carries its own brand and the language files, and nothing of the placeholder', /Acme Scrap/.test(html) && html.includes('yard-lang-default.js') && !/tenantzz/i.test(html));
    const loginsBefore = rd(path.join(TRIALS, 'acme'), 'TRIAL-README.md');
    fs.appendFileSync(path.join(TEMPLATE, 'trial-server.js'), '\n// a new release\n');
    const u = prov(['acme', 'Acme Scrap', '--update']);
    ck('an upgrade keeps the language this customer was set up with (the template says English, theirs says Spanish)', u.status === 0 && lang('acme') === 'es' && /a new release/.test(rd(path.join(TRIALS, 'acme'), 'trial-server.js')), u.stderr + u.stdout);
    ck('…and keeps their logins', rd(path.join(TRIALS, 'acme'), 'TRIAL-README.md') === loginsBefore);
    const u2 = prov(['acme', 'Acme Scrap', '--update', '--lang', 'en']);
    ck('--lang on an upgrade is refused (it would silently change a live customer), and nothing changed', u2.status !== 0 && /set when a trial is created/.test(u2.stderr) && lang('acme') === 'es');
    const u3 = prov(['beta', 'Beta Yard', '--update']);
    ck('an English customer stays English across an upgrade', u3.status === 0 && lang('beta') === 'en');

    console.log(`\n${pass} passed, ${fail} failed`); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
