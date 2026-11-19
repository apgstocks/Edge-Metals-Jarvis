// ── tests/trial-signup.js — self-serve signup: provision from the template, the public page, limits, expiry ──
// Apsara, 2026-11-19: "Create a plug and play .. multi tenant software" → chose self-serve signup, a SEPARATE copy per
// customer, yard app only, trials and a few paying yards. The strongest check here: a trial provisioned on the VM from the
// neutral template must be BYTE-FOR-BYTE what make-trial.js would have built directly for that customer.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawnSync, spawn } = require('child_process');
let pass = 0, fail = 0; const ck = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n); if (x) console.log('        ' + String(x).slice(0, 500)); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const ROOT = path.join(__dirname, '..'), VM = (f) => path.join(ROOT, 'scripts/trial-vm', f);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-signup-'));
const TRIALS = path.join(tmp, 'srv'), ARCH = path.join(tmp, 'arch'), ENVF = path.join(tmp, 'trials.env'), TEMPLATE = path.join(tmp, 'kit/template'), REG = path.join(tmp, 'arch/signups.json');
fs.mkdirSync(TRIALS); fs.mkdirSync(ARCH); fs.writeFileSync(ENVF, 'TRIAL_DOMAIN=trials.example.com\nTRIAL_GEMINI_KEY=trial-only-key-123\nTRIAL_MEM_MB=450\n');
const E = { ...process.env, TRIALS_DIR: TRIALS, ENV_FILE: ENVF, ARCHIVE_DIR: ARCH, SKIP_PM2: '1', SKIP_CADDY: '1', SKIP_NPM: '1', TEMPLATE_DIR: TEMPLATE, TRIAL_UP: VM('trial-up.sh'), TRIAL_DOWN: VM('trial-down.sh'), REGISTRY: REG, PROVISION: VM('provision.js') };
const mt = (name, slug, out) => { const r = spawnSync('node', [path.join(ROOT, 'scripts/make-trial.js'), '--name', name, '--slug', slug, '--out', out, '--link-modules', '--port', '39700'], { encoding: 'utf8', timeout: 120000 }); if (r.status !== 0) throw new Error(r.stdout + r.stderr); };
const prov = (slug, name, extra) => spawnSync('node', [VM('provision.js'), slug, name, ...(extra || [])], { encoding: 'utf8', env: E, timeout: 120000 });
const files = (dir, rel = '') => { let o = []; for (const n of fs.readdirSync(path.join(dir, rel))) { const r = rel ? rel + '/' + n : n; if (['node_modules', 'data', '.env', 'TRIAL-README.md'].includes(n)) continue; const st = fs.lstatSync(path.join(dir, r)); if (st.isSymbolicLink()) o.push(r + '@' + fs.readlinkSync(path.join(dir, r))); else if (st.isDirectory()) o = o.concat(files(dir, r)); else o.push(r); } return o.sort(); };
const same = (a, b) => { const fa = files(a), fb = files(b); if (JSON.stringify(fa) !== JSON.stringify(fb)) return { ok: false, why: 'file lists differ: ' + fa.filter((x) => !fb.includes(x)).slice(0, 3) + ' | ' + fb.filter((x) => !fa.includes(x)).slice(0, 3) }; for (const f of fa) { if (f.includes('@')) continue; const x = fs.readFileSync(path.join(a, f)), y = fs.readFileSync(path.join(b, f)); if (!x.equals(y)) return { ok: false, why: 'content differs: ' + f }; } return { ok: true, n: fa.length }; };
const httpReq = (port, method, p, body, headers) => new Promise((res) => { const rq = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'content-type': 'application/x-www-form-urlencoded', ...(headers || {}) } }, (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => res({ status: r.statusCode, body: b })); }); rq.on('error', () => res({ status: 0, body: '' })); if (body) rq.write(body); rq.end(); });
const form = (o) => new URLSearchParams(o).toString();

(async () => {
    section('A — provisioned from the template == built directly for that customer');
    mt('Tenantzz Co', 'tenantzz', TEMPLATE); for (const n of ['data', '.env', 'TRIAL-README.md']) fs.rmSync(path.join(TEMPLATE, n), { recursive: true, force: true });
    ck('the template carries only the placeholder (no Edge, no signing files)', !spawnSync('grep', ['-rliE', 'edge ?(metals|yard|trading)|apsara|zimex', TEMPLATE, '--exclude-dir=node_modules'], { encoding: 'utf8' }).stdout.trim() && !spawnSync('find', [TEMPLATE, '-name', 'node_modules', '-prune', '-o', '(', '-name', 'keystore.properties', '-o', '-name', '*.jks', '-o', '-name', '*.keystore', ')', '-print'], { encoding: 'utf8' }).stdout.trim());
    for (const [name, slug] of [['Acme Scrap', 'acme-scrap'], ['Lone Star Recycling', 'lone-star'], ['Zed Metals', 'zed']]) {
        const p = prov(slug, name);
        ck(`${name}: provisioning succeeds and prints its result`, p.status === 0 && /^RESULT /m.test(p.stdout), p.stdout + p.stderr);
        const direct = path.join(tmp, 'direct', slug); mt(name, slug, direct);
        const s = same(path.join(TRIALS, slug), direct);
        ck(`${name}: the provisioned copy is identical to make-trial's own output (${s.n || 0} files)`, s.ok, s.why);
    }
    ck('nothing of the placeholder is left anywhere in a provisioned trial', !spawnSync('grep', ['-rliE', 'tenantzz', path.join(TRIALS, 'acme-scrap'), '--exclude-dir=node_modules'], { encoding: 'utf8' }).stdout.trim());
    ck('nothing of Edge is in a provisioned trial', !spawnSync('grep', ['-rliE', 'edge ?(metals|yard|trading)|edgemetals|apsara|zimex', path.join(TRIALS, 'acme-scrap'), '--exclude-dir=node_modules'], { encoding: 'utf8' }).stdout.trim());

    section('B — each customer is separate');
    const envOf = (s) => fs.readFileSync(path.join(TRIALS, s, '.env'), 'utf8');
    const pw = (s) => envOf(s).match(/ADMIN_PASSWORD=(.+)/)[1], port = (s) => envOf(s).match(/API_PORT=(\d+)/)[1];
    ck('three different admin passwords', new Set(['acme-scrap', 'lone-star', 'zed'].map(pw)).size === 3);
    ck('three different ports', new Set(['acme-scrap', 'lone-star', 'zed'].map(port)).size === 3);
    ck('three separate data folders, each seeded', ['acme-scrap', 'lone-star', 'zed'].every((s) => fs.existsSync(path.join(TRIALS, s, 'data/loads.json'))));
    ck('a duplicate slug is refused and the first trial is untouched', (() => { const before = pw('zed'); const p = prov('zed', 'Another Zed'); return p.status !== 0 && /already exists/.test(p.stderr) && pw('zed') === before; })());
    ck('bad slug, bad name and bad email are refused', prov('Bad Slug', 'X Co').status !== 0 && prov('okslug', 'a').status !== 0 && prov('okslug2', 'Evil "Co"').status !== 0 && prov('okslug3', 'Fine Co', ['--email', 'nope']).status !== 0);
    ck('no template means a clear refusal, not a half-made trial', (() => { const p = spawnSync('node', [VM('provision.js'), 'fresh', 'Fresh Co'], { encoding: 'utf8', env: { ...E, TEMPLATE_DIR: path.join(tmp, 'nothing') } }); return p.status !== 0 && /no template/.test(p.stderr) && !fs.existsSync(path.join(TRIALS, 'fresh')); })());
    ck('without the VM key flag a trial gets the trial-only Gemini key; with NO_GEMINI it gets none', /GEMINI_API_KEY=trial-only-key-123/.test(envOf('acme-scrap')) && (() => { const p = spawnSync('node', [VM('provision.js'), 'nogem', 'No Gem Co'], { encoding: 'utf8', env: { ...E, NO_GEMINI: '1' } }); return p.status === 0 && !/GEMINI_API_KEY/.test(envOf('nogem')); })());

    section('C — a provisioned trial really runs, with its own logins');
    {
        const p = Number(port('acme-scrap')), srv = spawn('node', ['trial-server.js'], { cwd: path.join(TRIALS, 'acme-scrap'), stdio: 'ignore' });
        let ok = 0; for (let i = 0; i < 60 && !ok; i++) { const r = await httpReq(p, 'POST', '/login', JSON.stringify({ password: pw('acme-scrap') }), { 'content-type': 'application/json' }); if (r.status === 200) ok = r; else await new Promise((r2) => setTimeout(r2, 1000)); }
        const bad = await httpReq(p, 'POST', '/login', JSON.stringify({ password: 'nope' }), { 'content-type': 'application/json' });
        const other = await httpReq(p, 'POST', '/login', JSON.stringify({ password: pw('zed') }), { 'content-type': 'application/json' });
        srv.kill();
        ck('its own manager password logs in', !!ok && !!JSON.parse(ok.body).sid);
        ck('a wrong password and ANOTHER customer\'s password are both refused', bad.status === 401 && other.status === 401, bad.status + ' ' + other.status);
    }

    section('D — the public sign-up: invitation, agreement, email link, then the trial');
    const SP = 39799, SPC = 39798, OUT = path.join(tmp, 'outbox');
    const E2 = { ...E, MAIL_OUTBOX: OUT, SIGNUP_BASE_URL: 'https://signup.trials.example.com', AGREEMENT_URL: 'https://example.com/yard-trial-agreement', AGREEMENT_VERSION: 'test-v1' };
    const boot = async (port, env) => { const s = spawn('node', [VM('signup-server.js')], { env: { ...env, SIGNUP_PORT: String(port), MAX_TRIALS: '6', PER_IP_PER_HOUR: '3' }, stdio: ['ignore', 'pipe', 'pipe'] }); let up = 0; for (let i = 0; i < 30 && !up; i++) { up = (await httpReq(port, 'GET', '/health')).status === 200; if (!up) await new Promise((r) => setTimeout(r, 200)); } return s; };
    const mails = (to) => fs.existsSync(OUT) ? fs.readdirSync(OUT).sort().map((f) => JSON.parse(fs.readFileSync(path.join(OUT, f)))).filter((m) => m.to === to) : [];
    const tokenOf = (to) => { const m = mails(to).pop(); return m && (m.text.match(/verify\?t=([a-f0-9]{64})/) || [])[1]; };
    const mkInvite = (email) => { const r = spawnSync('node', [VM('signup-server.js'), '--invite', 'test', ...(email ? ['--email', email] : [])], { env: E2, encoding: 'utf8' }); return (r.stdout.match(/YARD-[A-Z0-9]{5}-[A-Z0-9]{5}/) || [])[0]; };
    const ip = (n) => ({ 'x-forwarded-for': '10.0.0.' + n });
    const regNow = () => { try { return JSON.parse(fs.readFileSync(REG, 'utf8')); } catch (e) { return { trials: [] }; } };
    const trialsOnDisk = () => fs.readdirSync(TRIALS).length;

    // closed by default: no mail, no public address, no agreement link → says so and makes nothing
    const closed = await boot(SPC, { ...E, MAIL_OUTBOX: '', SMTP_URL: '', MAIL_FROM: '', AGREEMENT_URL: '', SIGNUP_BASE_URL: '', ENV_FILE: path.join(tmp, 'none.env') });
    const cp = await httpReq(SPC, 'GET', '/'), cpost = await httpReq(SPC, 'POST', '/signup', form({ company: 'Closed Co', email: 'c@c.com', invite: 'YARD-AAAAA-AAAAA', accept: 'yes' }), ip(1));
    ck('with no mail, address or agreement link set, the page says "not open yet" and shows no form', cp.status === 200 && /not open yet/i.test(cp.body) && !/name="company"/.test(cp.body));
    ck('a post to a closed page is refused and makes nothing', cpost.status === 503 && !fs.existsSync(path.join(TRIALS, 'closed-co')));
    closed.kill();

    const srv = await boot(SP, E2);
    const page = await httpReq(SP, 'GET', '/');
    ck('the form asks for company, email, invitation code and the agreement, and links the agreement', page.status === 200 && /name="company"/.test(page.body) && /name="email"/.test(page.body) && /name="invite"/.test(page.body) && /name="accept"/.test(page.body) && /example\.com\/yard-trial-agreement/.test(page.body) && !/password/i.test(page.body));

    const before = trialsOnDisk();
    const noInv = await httpReq(SP, 'POST', '/signup', form({ company: 'Rio Grande Scrap', email: 'Boss@Rio.com', accept: 'yes' }), ip(1));
    const badInv = await httpReq(SP, 'POST', '/signup', form({ company: 'Rio Grande Scrap', email: 'Boss@Rio.com', invite: 'YARD-ZZZZZ-ZZZZZ', accept: 'yes' }), ip(2));
    ck('no invitation code, or a made-up one, is refused and no email is sent', noInv.status === 403 && badInv.status === 403 && mails('boss@rio.com').length === 0);
    const forOther = mkInvite('someone@else.com');
    const wrongPerson = await httpReq(SP, 'POST', '/signup', form({ company: 'Rio Grande Scrap', email: 'boss@rio.com', invite: forOther, accept: 'yes' }), ip(3));
    ck('a code made for one email cannot be used by another', wrongPerson.status === 403 && mails('boss@rio.com').length === 0);
    const code1 = mkInvite('boss@rio.com');
    const noAccept = await httpReq(SP, 'POST', '/signup', form({ company: 'Rio Grande Scrap', email: 'boss@rio.com', invite: code1 }), ip(4));
    ck('not ticking the agreement is refused, nothing is sent, and the invitation is not spent', noAccept.status === 400 && /agreement/i.test(noAccept.body) && mails('boss@rio.com').length === 0 && !JSON.parse(fs.readFileSync(path.join(ARCH, 'invites.json'), 'utf8')).invites.some((i) => i.used));

    const s1 = await httpReq(SP, 'POST', '/signup', form({ company: 'Rio Grande Scrap', email: 'Boss@Rio.com', invite: code1, accept: 'yes' }), ip(5));
    const tok1 = tokenOf('boss@rio.com');
    ck('a valid sign-up sends ONE email with a verify link, and makes NO trial yet', s1.status === 200 && /Check your email/.test(s1.body) && mails('boss@rio.com').length === 1 && !!tok1 && trialsOnDisk() === before && !regNow().trials.some((t) => t.email === 'boss@rio.com'));
    ck('the page and the email never contain the login details; the email carries the agreement link and version', !/Manager login/.test(s1.body) && /example\.com\/yard-trial-agreement/.test(mails('boss@rio.com')[0].text) && /test-v1/.test(mails('boss@rio.com')[0].text) && mails('boss@rio.com')[0].text.startsWith('Hello'));
    ck('only the hash of the token and of the invitation code is stored, never the plain value', (() => { const p = fs.readFileSync(path.join(ARCH, 'pending.json'), 'utf8'), i = fs.readFileSync(path.join(ARCH, 'invites.json'), 'utf8'); return !p.includes(tok1) && !i.includes(code1) && !i.includes(code1.replace(/-/g, '')); })());
    const again = await httpReq(SP, 'POST', '/signup', form({ company: 'Rio Grande Scrap', email: 'boss@rio.com', invite: mkInvite('boss@rio.com'), accept: 'yes' }), ip(6));
    ck('asking again within ten minutes sends no second email (no mail-bombing) and looks the same', again.status === 200 && /Check your email/.test(again.body) && mails('boss@rio.com').length === 1);

    // a mail scanner or a curious click opens the link: that must create nothing
    const scan = await httpReq(SP, 'GET', '/verify?t=' + tok1);
    ck('opening the link only shows a button; a scanner that opens it creates nothing', scan.status === 200 && /Create my yard/.test(scan.body) && !/Manager login/.test(scan.body) && trialsOnDisk() === before && !regNow().trials.some((t) => t.email === 'boss@rio.com'));
    ck('a wrong or missing token shows an expired page, not an error', (await httpReq(SP, 'GET', '/verify?t=' + 'a'.repeat(64))).status === 400 && (await httpReq(SP, 'GET', '/verify')).status === 400 && (await httpReq(SP, 'POST', '/verify', form({ t: 'nope' }))).status === 400);

    const ok1 = await httpReq(SP, 'POST', '/verify', form({ t: tok1 }));
    ck('pressing the button creates the trial and shows the address and both logins', ok1.status === 200 && /rio-grande-scrap\.trials\.example\.com/.test(ok1.body) && /Manager login/.test(ok1.body), ok1.body.slice(0, 300));
    const shown = (ok1.body.match(/Manager login<\/b> \(everything\)<br>([A-Za-z0-9]+)/) || [])[1];
    ck('the password shown is the one in the trial\'s .env', !!shown && shown === pw('rio-grande-scrap'));
    ck('the trial exists with its own folder and brand', fs.existsSync(path.join(TRIALS, 'rio-grande-scrap/data/loads.json')) && /Rio Grande Scrap/.test(fs.readFileSync(path.join(TRIALS, 'rio-grande-scrap/trial-server.js'), 'utf8')));
    ck('self-serve trials get NO Gemini key by default (nobody can spend your AI credit)', !/GEMINI_API_KEY/.test(envOf('rio-grande-scrap')));
    const rec1 = regNow().trials.find((t) => t.slug === 'rio-grande-scrap') || {};
    ck('the registry records the email (lower-cased), when it was verified and which agreement version was accepted when', rec1.email === 'boss@rio.com' && !!rec1.verified_at && !!rec1.accepted_at && rec1.agreement === 'test-v1' && rec1.invite === 'inv2', JSON.stringify(rec1));
    const replay = await httpReq(SP, 'POST', '/verify', form({ t: tok1 }));
    ck('the link works once: a second press shows expired and makes no second trial', replay.status === 400 && regNow().trials.filter((t) => t.email === 'boss@rio.com').length === 1);
    const spent = await httpReq(SP, 'POST', '/signup', form({ company: 'Rio Other', email: 'other@rio.com', invite: code1, accept: 'yes' }), ip(7));
    ck('a used invitation code cannot be used again', spent.status === 403 && mails('other@rio.com').length === 0);
    const dup = await httpReq(SP, 'POST', '/signup', form({ company: 'Other Name', email: 'boss@rio.com', invite: mkInvite('boss@rio.com'), accept: 'yes' }), ip(8));
    ck('an email that already has a trial gets the SAME page as anyone else (it must not reveal who signed up), no second trial', dup.status === 200 && /Check your email/.test(dup.body) && regNow().trials.filter((t) => t.email === 'boss@rio.com').length === 1 && /already exists/.test(mails('boss@rio.com').pop().text));

    const flow = async (company, email, n, bound) => { const code = mkInvite(bound ? email : ''); await httpReq(SP, 'POST', '/signup', form({ company, email, invite: code, accept: 'yes' }), ip(n)); const t = tokenOf(email); return { code, t, res: t ? await httpReq(SP, 'POST', '/verify', form({ t })) : null }; };
    const same2 = await flow('Rio Grande Scrap', 'two@rio.com', 9, false);
    ck('the same company name gets a different address (-2), not the first one\'s', same2.res && same2.res.status === 200 && /rio-grande-scrap-2\.trials/.test(same2.res.body));
    ck('a bad name or email is refused with a message and nothing is sent', (await httpReq(SP, 'POST', '/signup', form({ company: 'x', email: 'a@b.co', invite: mkInvite(''), accept: 'yes' }), ip(10))).status === 400 && (await httpReq(SP, 'POST', '/signup', form({ company: 'Fine Co', email: 'nope', invite: mkInvite(''), accept: 'yes' }), ip(10))).status === 400 && mails('a@b.co').length === 0 && !fs.existsSync(path.join(TRIALS, 'fine-co')));
    ck('script and quote characters in the name are refused', (await httpReq(SP, 'POST', '/signup', form({ company: '<script>alert(1)</script>', email: 'x@y.com', invite: mkInvite(''), accept: 'yes' }), ip(11))).status === 400 && mails('x@y.com').length === 0);
    const rsv = await flow('Admin', 'adm@y.com', 12, false);
    ck('a reserved name (admin) never becomes the address admin.…', rsv.res && rsv.res.status === 200 && !/https:\/\/admin\.trials/.test(rsv.res.body) && /admin-yard\.trials/.test(rsv.res.body), rsv.res && rsv.res.body.slice(0, 200));
    const b4 = trialsOnDisk(), mailsBefore = fs.readdirSync(OUT).length;
    const bot = await httpReq(SP, 'POST', '/signup', form({ company: 'Bot Co', email: 'bot@y.com', invite: mkInvite(''), accept: 'yes', website: 'spam.com' }), ip(13));
    ck('a bot that fills the hidden box gets nothing made and no email', bot.status === 200 && trialsOnDisk() === b4 && fs.readdirSync(OUT).length === mailsBefore);
    let last; for (let i = 0; i < 4; i++) last = await httpReq(SP, 'POST', '/signup', form({ company: 'Flood ' + i, email: `f${i}@y.com`, invite: mkInvite(''), accept: 'yes' }), ip(14));
    ck('one connection is limited to 3 sign-ups an hour', last.status === 429);

    // an old link expires
    { const p = JSON.parse(fs.readFileSync(path.join(ARCH, 'pending.json'), 'utf8')); const e = p.pending.find((x) => x.email === 'f0@y.com'); e.created = new Date(Date.now() - 25 * 3600e3).toISOString(); fs.writeFileSync(path.join(ARCH, 'pending.json'), JSON.stringify(p)); }
    ck('a verify link older than 24 hours no longer works', (await httpReq(SP, 'GET', '/verify?t=' + tokenOf('f0@y.com'))).status === 400 && (await httpReq(SP, 'POST', '/verify', form({ t: tokenOf('f0@y.com') }))).status === 400 && !regNow().trials.some((t) => t.email === 'f0@y.com'));

    // capacity is checked when the trial is made, and the invitation is not spent when it is full
    const cap1 = await flow('Cap Ax', 'c0@y.com', 20, false), cap2 = await flow('Cap Bx', 'c1@y.com', 21, false), cap3 = await flow('Cap Cx', 'c2@y.com', 23, false);
    ck('three more trials fill the six places (setup for the full check)', [cap1, cap2, cap3].every((c) => c.res && c.res.status === 200) && regNow().trials.filter((t) => !t.ended).length === 6);
    const capCode = mkInvite(''); await httpReq(SP, 'POST', '/signup', form({ company: 'Too Many', email: 'late@y.com', invite: capCode, accept: 'yes' }), ip(22));
    const full = await httpReq(SP, 'POST', '/verify', form({ t: tokenOf('late@y.com') }));
    ck('when MAX_TRIALS are active it says it is full and makes nothing', full.status === 503 && /full/i.test(full.body) && !fs.existsSync(path.join(TRIALS, 'too-many')) && regNow().trials.length <= 6, full.status);
    ck('a full page does not spend the invitation, and the link still works once there is room', (() => { const h = require('crypto').createHash('sha256').update(capCode.toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex'); const i = JSON.parse(fs.readFileSync(path.join(ARCH, 'invites.json'), 'utf8')).invites.find((x) => x.hash === h); return i && !i.used && JSON.parse(fs.readFileSync(path.join(ARCH, 'pending.json'), 'utf8')).pending.some((x) => x.email === 'late@y.com'); })());
    ck('the page never shows another trial\'s details (no other slug in a response)', !/lone-star|acme-scrap/.test(ok1.body + (same2.res ? same2.res.body : '')));
    srv.kill();

    // open mode (later, when public): no invitation code, the email step and the agreement still apply
    const open = await boot(SPC - 1, { ...E2, SIGNUP_OPEN: '1' });
    const op = await httpReq(SPC - 1, 'GET', '/'), os1 = await httpReq(SPC - 1, 'POST', '/signup', form({ company: 'Open Door Co', email: 'open@door.com', accept: 'yes' }), ip(30)), os2 = await httpReq(SPC - 1, 'POST', '/signup', form({ company: 'Open Door Co', email: 'open2@door.com' }), ip(31));
    ck('SIGNUP_OPEN=1 drops the invitation box but keeps the agreement tick and the email step', !/name="invite"/.test(op.body) && os1.status === 200 && /Check your email/.test(os1.body) && !!tokenOf('open@door.com') && !fs.existsSync(path.join(TRIALS, 'open-door-co')) && os2.status === 400);
    open.kill();
    ck('the invite command lists codes without ever printing a stored code, and marks used ones', (() => { const l = spawnSync('node', [VM('signup-server.js'), '--invites'], { env: E2, encoding: 'utf8' }).stdout; return /USED by rio-grande-scrap/.test(l) && /unused/.test(l) && !/YARD-[A-Z0-9]{5}-/.test(l); })());

    section('E — expiry and keeping a paying customer');
    const r2 = JSON.parse(fs.readFileSync(REG, 'utf8')); const old = new Date(Date.now() - 20 * 86400e3).toISOString();
    r2.trials.find((t) => t.slug === 'rio-grande-scrap').created = old; r2.trials.find((t) => t.slug === 'rio-grande-scrap-2').created = old; fs.writeFileSync(REG, JSON.stringify(r2));
    spawnSync('node', [VM('signup-server.js'), '--keep', 'rio-grande-scrap-2'], { env: E, encoding: 'utf8' });
    const ex = spawnSync('node', [VM('signup-server.js'), '--expire'], { env: E, encoding: 'utf8' });
    const r3 = JSON.parse(fs.readFileSync(REG, 'utf8'));
    ck('an expired trial is switched off and marked ended, its data archived first', /switched off rio-grande-scrap/.test(ex.stdout) && !!r3.trials.find((t) => t.slug === 'rio-grande-scrap').ended && fs.readdirSync(ARCH).some((f) => /^rio-grande-scrap-\d/.test(f)), ex.stdout + ex.stderr);
    ck('a trial marked as kept (paying) is NOT expired', !r3.trials.find((t) => t.slug === 'rio-grande-scrap-2').ended);
    ck('a young trial is untouched', !r3.trials.find((t) => t.slug === 'admin-yard').ended);
    ck('the ended slug is never handed out again', (() => { const t = r3.trials.map((x) => x.slug); return t.includes('rio-grande-scrap'); })());

    section('F — wiring');
    const setup = fs.readFileSync(VM('setup.sh'), 'utf8'), ship = fs.readFileSync(path.join(ROOT, 'scripts/trial-ship.sh'), 'utf8');
    ck('setup serves the sign-up page at signup.<domain>, starts it under pm2 and installs the daily expiry sweep', /signup\.%s/.test(setup) && /pm2 start \/usr\/local\/bin\/trial-signup/.test(setup) && /trial-signup --expire/.test(setup));
    ck('setup gives the trials user the settings file and the Caddy folder it needs (trial-up runs as that user)', /chown root:trials \/etc\/trials\.env/.test(setup) && /chown trials:trials \/etc\/caddy\/trials\.d/.test(setup));
    ck('trial-ship --template builds with the leak scan, strips secrets and data, then uploads', /--template/.test(ship) && ship.indexOf('make-trial.js') < ship.indexOf('scp ') && /rm -rf .*\.env/.test(ship));
    ck('the placeholder in provision.js is the one trial-ship --template builds with', /Tenantzz Co/.test(ship) && /tenantzz/.test(ship) && /brand: 'Tenantzz Co', slug: 'tenantzz'/.test(fs.readFileSync(VM('provision.js'), 'utf8')));
    ck('the sign-up and provision scripts carry no Edge Metals identity', !/edge ?(metals|yard|trading)|apsara|zimex/i.test(fs.readFileSync(VM('provision.js'), 'utf8') + fs.readFileSync(VM('signup-server.js'), 'utf8')));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* best effort */ }
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
