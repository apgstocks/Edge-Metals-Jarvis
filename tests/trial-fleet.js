// ── tests/trial-fleet.js — trial-fleet status / capacity gauge / upgrade, END TO END against a temp VM ──
// Apsara, 2026-11-19: "build everything". Growth tooling: bring every trial up to a new release without touching its
// data, logins or brand, stop on the first failure and put that trial back. Real provision.js, real trial-up.sh, real
// trial-fleet.js, real rsync/tar; only pm2 and Caddy are skipped, and each "app" is a plain TCP listener on its real port.
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net'), crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');
let pass = 0, fail = 0; const ck = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n); if (x) console.log('        ' + String(x).slice(0, 600)); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const ROOT = path.join(__dirname, '..'), VM = (f) => path.join(ROOT, 'scripts/trial-vm', f);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-fleet-'));
const TRIALS = path.join(tmp, 'srv'), ARCH = path.join(tmp, 'arch'), ENVF = path.join(tmp, 'trials.env'), TEMPLATE = path.join(tmp, 'kit/template'), REG = path.join(ARCH, 'signups.json');
fs.mkdirSync(TRIALS); fs.mkdirSync(ARCH); fs.writeFileSync(ENVF, 'TRIAL_DOMAIN=trials.example.com\nTRIAL_GEMINI_KEY=trial-only-key-123\nTRIAL_MEM_MB=450\n');
const E = { ...process.env, TRIALS_DIR: TRIALS, ENV_FILE: ENVF, ARCHIVE_DIR: ARCH, SKIP_PM2: '1', SKIP_CADDY: '1', SKIP_NPM: '1', TEMPLATE_DIR: TEMPLATE, TRIAL_UP: VM('trial-up.sh'), TRIAL_DOWN: VM('trial-down.sh'), REGISTRY: REG, PROVISION: VM('provision.js'),
    FLEET_HEALTH_WAIT_MS: '1500', FLEET_TOTAL_MB: '8192', FLEET_AVAILABLE_MB: '5000', TRIAL_MEM_MB: '450', MAX_TRIALS: '15', TRIAL_DAYS: '14' };
const run = (cmd, args, env) => new Promise((res) => { const p = spawn(cmd, args, { env: { ...E, ...(env || {}) } }); let o = '', e = ''; p.stdout.on('data', (d) => o += d); p.stderr.on('data', (d) => e += d); p.on('close', (code) => res({ status: code, out: o, err: e, all: o + e })); });
const fleet = (args, env) => run('node', [VM('trial-fleet.js'), ...args], env);
const prov = (slug, name, extra, env) => spawnSync('node', [VM('provision.js'), slug, name, ...(extra || [])], { encoding: 'utf8', env: { ...E, ...(env || {}) }, timeout: 120000 });
const mt = (name, slug, out) => { const r = spawnSync('node', [path.join(ROOT, 'scripts/make-trial.js'), '--name', name, '--slug', slug, '--out', out, '--link-modules', '--port', '39700'], { encoding: 'utf8', timeout: 120000 }); if (r.status !== 0) throw new Error(r.stdout + r.stderr); };
const files = (dir, rel = '') => { let o = []; for (const n of fs.readdirSync(path.join(dir, rel))) { const r = rel ? rel + '/' + n : n; if (['node_modules', 'data', '.env', 'TRIAL-README.md'].includes(n)) continue; const st = fs.lstatSync(path.join(dir, r)); if (st.isSymbolicLink()) o.push(r + '@' + fs.readlinkSync(path.join(dir, r))); else if (st.isDirectory()) o = o.concat(files(dir, r)); else o.push(r); } return o.sort(); };
const same = (a, b) => { const fa = files(a), fb = files(b); if (JSON.stringify(fa) !== JSON.stringify(fb)) return { ok: false, why: 'file lists differ: ' + fa.filter((x) => !fb.includes(x)).slice(0, 3) + ' | ' + fb.filter((x) => !fa.includes(x)).slice(0, 3) }; for (const f of fa) { if (f.includes('@')) continue; const x = fs.readFileSync(path.join(a, f)), y = fs.readFileSync(path.join(b, f)); if (!x.equals(y)) return { ok: false, why: 'content differs: ' + f }; } return { ok: true, n: fa.length }; };
const hashTree = (dir) => { const h = crypto.createHash('sha256'); const walk = (rel) => { for (const n of fs.readdirSync(path.join(dir, rel)).sort()) { if (n === 'node_modules') continue; const r = rel ? rel + '/' + n : n, st = fs.lstatSync(path.join(dir, r)); if (st.isSymbolicLink()) h.update('L' + r + fs.readlinkSync(path.join(dir, r))); else if (st.isDirectory()) walk(r); else { h.update('F' + r); h.update(fs.readFileSync(path.join(dir, r))); } } }; walk(''); return h.digest('hex'); };
const rd = (...p) => fs.readFileSync(path.join(TRIALS, ...p), 'utf8');
const regNow = () => JSON.parse(fs.readFileSync(REG, 'utf8'));
const pv = () => spawnSync('node', [VM('provision.js'), '--version'], { encoding: 'utf8', env: E }).stdout.trim();
const bump = (tag) => { const f = path.join(TEMPLATE, 'trial-server.js'); fs.appendFileSync(f, `\n// release ${tag}\n`); };
const listeners = {};
const listen = (slug) => new Promise((res) => { const port = Number(rd(slug, '.env').match(/^API_PORT=(\d+)/m)[1]); const s = net.createServer((c) => c.end()); s.listen(port, '127.0.0.1', () => { listeners[slug] = s; res(); }); });
const unlisten = (slug) => new Promise((res) => { listeners[slug].close(() => res()); });
const daysAgo = (n) => new Date(Date.now() - n * 86400e3).toISOString();

(async () => {
    section('A — the provisioner stamps a version and refuses to "update" what does not exist');
    mt('Tenantzz Co', 'tenantzz', TEMPLATE); for (const n of ['data', '.env', 'TRIAL-README.md']) fs.rmSync(path.join(TEMPLATE, n), { recursive: true, force: true });
    const v1 = pv();
    ck('--version prints a short fingerprint', /^[0-9a-f]{12}$/.test(v1), v1);
    ck('the fingerprint is stable when nothing changed', pv() === v1);
    const people = [['Acme Scrap', 'acme-scrap'], ['Lone Star Recycling', 'lone-star'], ['Zed Metals', 'zed']];
    const made = {};
    for (const [name, slug] of people) { const p = prov(slug, name, ['--email', `${slug}@example.com`]); const m = (p.stdout.match(/^RESULT (.*)$/m) || [])[1]; made[slug] = m && JSON.parse(m); }
    ck('a new trial reports the template version it was built from', people.every(([, s]) => made[s] && made[s].version === v1), JSON.stringify(made));
    const u0 = prov('ghost', 'Ghost Co', ['--update']);
    ck('updating a trial that does not exist is refused and creates nothing', u0.status !== 0 && /no trial called ghost/.test(u0.stderr) && !fs.existsSync(path.join(TRIALS, 'ghost')), u0.stderr);

    // the registry, as the signup page would have left it: one paying, one ended (its folder is gone), two plain trials
    fs.writeFileSync(REG, JSON.stringify({ trials: [
        { slug: 'acme-scrap', company: 'Acme Scrap', email: 'acme-scrap@example.com', created: daysAgo(5), keep: false, verified_at: daysAgo(5), version: v1 },
        { slug: 'lone-star', company: 'Lone Star Recycling', email: 'lone-star@example.com', created: daysAgo(30), keep: true, verified_at: daysAgo(30), version: v1 },
        { slug: 'zed', company: 'Zed Metals', email: 'zed@example.com', created: daysAgo(2), keep: false, verified_at: daysAgo(2), version: v1 },
        { slug: 'old-co', company: 'Old Co', email: 'old@example.com', created: daysAgo(60), keep: false, ended: daysAgo(46), version: v1 }] }));
    for (const [, s] of people) { fs.writeFileSync(path.join(TRIALS, s, 'data', 'ledger.json'), JSON.stringify({ owner: s, rows: [1, 2, 3] })); fs.mkdirSync(path.join(TRIALS, s, 'data', 'sub'), { recursive: true }); fs.writeFileSync(path.join(TRIALS, s, 'data', 'sub', 'x.txt'), 'keep me ' + s); await listen(s); }
    const before = {}; for (const [, s] of people) before[s] = { env: rd(s, '.env'), readme: rd(s, 'TRIAL-README.md'), data: hashTree(path.join(TRIALS, s, 'data')), all: hashTree(path.join(TRIALS, s)) };

    section('B — status: who is running, days left, who is behind, and the capacity gauge');
    let st = await fleet(['status']);
    ck('status runs and lists the trials', st.status === 0 && /acme-scrap/.test(st.out) && /lone-star/.test(st.out) && /zed/.test(st.out), st.all);
    ck('all three active trials are current while the template has not changed', (st.out.match(/current/g) || []).length === 3 && !/BEHIND/.test(st.out), st.out);
    ck('a paying trial shows as paying with no countdown, an ended one as ended', /lone-star\s+paying\s+-/.test(st.out) && /old-co\s+ended/.test(st.out), st.out);
    ck('days left counts down from the trial length (14 - 5 = 9, 14 - 2 = 12)', /acme-scrap\s+trial\s+9\b/.test(st.out) && /zed\s+trial\s+12\b/.test(st.out), st.out);
    const js = JSON.parse((await fleet(['status', '--json'])).out);
    ck('status --json carries the capacity numbers', js.capacity.active === 3 && js.capacity.committed === 1350 && js.capacity.budget === 7168 && js.capacity.level === 'OK' && js.templateVersion === v1, JSON.stringify(js.capacity));

    section('C — the capacity gauge');
    const g = async (env) => JSON.parse((await fleet(['status', '--json'], env)).out).capacity;
    let c = await g({ FLEET_TOTAL_MB: '3072' }); ck('66% of the budget is PLAN', c.level === 'PLAN' && c.pct === 66, JSON.stringify(c));
    c = await g({ FLEET_TOTAL_MB: '2048' }); ck('over the budget is FULL', c.level === 'FULL' && c.pct > 100, JSON.stringify(c));
    c = await g({ FLEET_TOTAL_MB: '4096' }); ck('MAX_TRIALS larger than the VM can hold is flagged (4096 MB holds 6 at 450 each, limit is 15)', c.maxTooHigh === true && c.fit === 6, JSON.stringify(c));
    c = await g({ FLEET_TOTAL_MB: '8192' }); ck('a big enough VM does not warn', c.maxTooHigh === false && c.fit === 15, JSON.stringify(c));
    c = await g({ TRIAL_MEM_MB: '', ENV_FILE: ENVF }); ck('the per-trial cap is read from trials.env when the variable is not set', c.cap === 450, JSON.stringify(c));
    ck('ended trials do not count against capacity', (await g()).active === 3);
    const txt = (await fleet(['status'], { FLEET_TOTAL_MB: '2048' })).out;
    ck('the text gauge says FULL in words and says how much RAM to ask for', /FULL/.test(txt) && /MB RAM for 5 more/.test(txt), txt);

    section('D — a new release: status sees it, a dry run touches nothing');
    bump('v2'); const v2 = pv();
    ck('a changed template changes the version', v2 !== v1 && /^[0-9a-f]{12}$/.test(v2));
    st = await fleet(['status']);
    ck('status now shows the three active trials BEHIND and not the ended one', (st.out.match(/BEHIND/g) || []).length >= 3 && /run  trial-fleet upgrade --all/.test(st.out) && !/old-co\s+ended\s+-\s+-\s+BEHIND/.test(st.out), st.out);
    const snap0 = people.map(([, s]) => hashTree(path.join(TRIALS, s))).join(), reg0 = fs.readFileSync(REG, 'utf8');
    const dry = await fleet(['upgrade', '--all', '--dry-run']);
    ck('a dry run lists what it would do, paying trial last', /would upgrade acme-scrap/.test(dry.out) && dry.out.indexOf('would upgrade zed') < dry.out.indexOf('would upgrade lone-star') && /\(paying: last\)/.test(dry.out), dry.out);
    ck('a dry run changes no trial, no registry and saves no copies', people.map(([, s]) => hashTree(path.join(TRIALS, s))).join() === snap0 && fs.readFileSync(REG, 'utf8') === reg0 && !fs.existsSync(path.join(ARCH, 'pre-upgrade')));

    section('E — upgrade --all: new code, same data, same logins, same brand');
    const up = await fleet(['upgrade', '--all']);
    ck('the upgrade succeeds for all three', up.status === 0 && /3 trial\(s\) upgraded to /.test(up.out), up.all);
    ck('older plain trials first, paying customer last', up.out.indexOf('upgrading acme-scrap') < up.out.indexOf('upgrading zed') && up.out.indexOf('upgrading zed') < up.out.indexOf('upgrading lone-star'), up.out);
    ck('the ended trial was not touched or recreated', !fs.existsSync(path.join(TRIALS, 'old-co')) && !/old-co/.test(up.out));
    for (const [name, s] of people) {
        const refT = path.join(tmp, 'ref-trials'); fs.mkdirSync(refT, { recursive: true });
        const rp = prov(s, name, ['--email', `${s}@example.com`], { TRIALS_DIR: refT, ARCHIVE_DIR: path.join(tmp, 'ref-arch') });
        const r = same(path.join(TRIALS, s), path.join(refT, s));
        ck(`${s}: the upgraded copy is identical to one freshly provisioned from the new template (${r.n || 0} files)`, rp.status === 0 && r.ok, r.why || rp.stderr);
        ck(`${s}: carries the new release`, /release v2/.test(rd(s, 'trial-server.js')));
        ck(`${s}: .env (passwords, port) is byte-identical`, rd(s, '.env') === before[s].env);
        ck(`${s}: the README with the logins is byte-identical and still there`, rd(s, 'TRIAL-README.md') === before[s].readme);
        ck(`${s}: every file under data/ is untouched`, hashTree(path.join(TRIALS, s, 'data')) === before[s].data);
        fs.rmSync(refT, { recursive: true, force: true });
    }
    ck('a brand with spaces survives the upgrade', fs.readdirSync(path.join(TRIALS, 'lone-star')).length > 0 && spawnSync('grep', ['-rlq', 'Lone Star Recycling', path.join(TRIALS, 'lone-star'), '--exclude-dir=node_modules', '--exclude-dir=data'], { encoding: 'utf8' }).status === 0);
    ck('the registry now records the new version and when', regNow().trials.filter((t) => !t.ended).every((t) => t.version === v2 && t.upgraded) && regNow().trials.find((t) => t.slug === 'old-co').version === v1);
    const snaps = fs.readdirSync(path.join(ARCH, 'pre-upgrade'));
    ck('a copy of each trial was saved first, readable only by its owner', snaps.length === 3 && snaps.every((f) => (fs.statSync(path.join(ARCH, 'pre-upgrade', f)).mode & 0o077) === 0), snaps.join());
    ck('the upgrade output never prints a password', !people.some(([, s]) => before[s].env.match(/ADMIN_PASSWORD=(.+)/) && up.all.includes(before[s].env.match(/ADMIN_PASSWORD=(.+)/)[1])));
    ck('the lock file is gone afterwards', !fs.existsSync(path.join(ARCH, 'fleet.lock')));

    section('F — already current: skipped; --force rebuilds');
    const again = await fleet(['upgrade', '--all']);
    ck('a second run does nothing', again.status === 0 && /0 to upgrade, 3 already current/.test(again.out) && !/upgrading/.test(again.out), again.out);
    const one = await fleet(['upgrade', 'zed', '--force']);
    ck('--force rebuilds a current trial', one.status === 0 && /upgrading zed/.test(one.out) && /1 trial\(s\) upgraded/.test(one.out), one.all);
    const nope = await fleet(['upgrade', 'old-co']);
    ck('an ended or unknown trial cannot be upgraded', nope.status !== 0 && /no active trial called old-co/.test(nope.err), nope.all);

    section('G — a trial that will not start is put back, and the run stops there');
    bump('v3'); const v3 = pv();
    const preAcme = hashTree(path.join(TRIALS, 'acme-scrap')), preZed = hashTree(path.join(TRIALS, 'zed')), preLone = hashTree(path.join(TRIALS, 'lone-star'));
    await unlisten('acme-scrap');                                    // acme will not answer on its port after the rebuild
    const bad = await fleet(['upgrade', '--all']);
    ck('the run reports the failure and exits non-zero', bad.status === 1 && /upgrading acme-scrap \.\.\. FAILED: it did not answer on its port/.test(bad.out), bad.all);
    ck('it says it rolled back', /rolled back: acme-scrap is on its old code/.test(bad.out));
    ck('acme-scrap is exactly as it was before the attempt (code, data, logins)', hashTree(path.join(TRIALS, 'acme-scrap')) === preAcme && !/release v3/.test(rd('acme-scrap', 'trial-server.js')));
    ck('the run stopped: the trials after it were not touched', hashTree(path.join(TRIALS, 'zed')) === preZed && hashTree(path.join(TRIALS, 'lone-star')) === preLone && /2 trial\(s\) after it were NOT touched/.test(bad.out), bad.out);
    ck('the registry still says v2 for every trial', regNow().trials.filter((t) => !t.ended).every((t) => t.version === v2));
    ck('the lock is released after a failure', !fs.existsSync(path.join(ARCH, 'fleet.lock')));
    await listen('acme-scrap');

    section('H — a rebuild that fails outright is also put back');
    const wrap = path.join(tmp, 'failing-provision.js');
    fs.writeFileSync(wrap, `const a=process.argv; if(a.includes('--update') && a[2]==='zed'){ console.error('boom'); process.exit(1);} require(${JSON.stringify(VM('provision.js'))});`);
    const bad2 = await fleet(['upgrade', '--all'], { PROVISION: wrap });
    ck('acme upgrades, zed fails, and the run stops before the paying trial', bad2.status === 1 && /upgrading acme-scrap \.\.\. ok/.test(bad2.out) && /upgrading zed \.\.\. FAILED: the rebuild failed/.test(bad2.out) && !/upgrading lone-star/.test(bad2.out), bad2.all);
    ck('zed and the paying trial are unchanged, acme is on v3', hashTree(path.join(TRIALS, 'zed')) === preZed && hashTree(path.join(TRIALS, 'lone-star')) === preLone && /release v3/.test(rd('acme-scrap', 'trial-server.js')));
    ck('only the trial that succeeded had its version recorded', regNow().trials.find((t) => t.slug === 'acme-scrap').version === v3 && regNow().trials.find((t) => t.slug === 'zed').version === v2);
    const fin = await fleet(['upgrade', '--all']);
    ck('after the fault is cleared the same command finishes the job', fin.status === 0 && /2 trial\(s\) upgraded to/.test(fin.out) && !/upgrading acme-scrap/.test(fin.out), fin.all);

    section('I — safety: one run at a time');
    fs.writeFileSync(path.join(ARCH, 'fleet.lock'), '999999'); bump('v4');
    const lk = await fleet(['upgrade', '--all']);
    ck('a run refuses to start while another holds the lock', lk.status !== 0 && /another trial-fleet run is in progress/.test(lk.all) && !/release v4/.test(rd('zed', 'trial-server.js')), lk.all);
    fs.rmSync(path.join(ARCH, 'fleet.lock'));
    const none = await run('node', [VM('trial-fleet.js'), 'upgrade', '--all'], { TEMPLATE_DIR: path.join(tmp, 'nothing') });
    ck('with no template uploaded it refuses with a clear instruction', none.status === 1 && /no template on this VM/.test(none.err), none.all);
    ck('an unknown command prints usage', (await fleet(['frobnicate'])).status === 2);

    for (const s of Object.values(listeners)) try { s.close(); } catch (e) { /* closed */ }
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
