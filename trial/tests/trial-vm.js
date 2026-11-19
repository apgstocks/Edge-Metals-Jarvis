// ── tests/trial-vm.js — the trial VM's commands (trial-up, trial-down, trial-config, trial-ship guard) ──
// Apsara, 2026-11-19: a different VM for trials, set up once with the details she provides. The commands are
// bash; this runs them for real against a temp "VM" (TRIALS_DIR, ENV_FILE) with pm2, Caddy and npm switched off.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawnSync } = require('child_process');
let pass = 0, fail = 0; const ck = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n); if (x) console.log('        ' + String(x).slice(0, 400)); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const ROOT = path.join(__dirname, '..');
const V = (f) => path.join(ROOT, 'scripts/trial-vm', f);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-trialvm-'));
const TRIALS = path.join(tmp, 'srv'), ARCH = path.join(tmp, 'arch'), ENVF = path.join(tmp, 'trials.env');
fs.mkdirSync(TRIALS); fs.writeFileSync(ENVF, 'TRIAL_DOMAIN=trials.example.com\nTRIAL_GEMINI_KEY=trial-only-key-123\nTRIAL_MEM_MB=450\n');
const E = { ...process.env, TRIALS_DIR: TRIALS, ENV_FILE: ENVF, ARCHIVE_DIR: ARCH, SKIP_PM2: '1', SKIP_CADDY: '1', SKIP_NPM: '1' };
const sh = (script, args, env) => spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...E, ...(env || {}) }, timeout: 120000 });
const mk = (slug, name) => {
    const out = path.join(tmp, 'build', slug);
    const r = spawnSync('node', [path.join(ROOT, 'scripts/make-trial.js'), '--name', name, '--slug', slug, '--out', out, '--link-modules', '--port', '39620'], { encoding: 'utf8', timeout: 120000 });
    if (r.status !== 0) throw new Error(r.stdout + r.stderr);
    const tgz = path.join(tmp, slug + '.tgz');
    spawnSync('tar', ['czf', tgz, '-C', path.join(tmp, 'build'), slug]);
    return tgz;
};
const envOf = (slug) => fs.readFileSync(path.join(TRIALS, slug, '.env'), 'utf8');

(async () => {
    section('A — trial-up');
    const a = mk('acme', 'Acme Scrap');
    const up = sh(V('trial-up.sh'), ['acme', a]);
    ck('it installs and prints the address and logins', up.status === 0 && /STARTED acme/.test(up.stdout) && /https:\/\/acme\.trials\.example\.com/.test(up.stdout) && /ADMIN = /.test(up.stdout), up.stdout + up.stderr);
    ck('demo data was seeded', fs.existsSync(path.join(TRIALS, 'acme/data/loads.json')));
    ck('the VM\'s trial-only Gemini key was put in the trial\'s .env', /^GEMINI_API_KEY=trial-only-key-123$/m.test(envOf('acme')));
    ck('DATA_DIR points inside the trial folder', envOf('acme').includes(`DATA_DIR=${path.join(TRIALS, 'acme')}/data`));
    ck('.env is private (600)', (fs.statSync(path.join(TRIALS, 'acme/.env')).mode & 0o777) === 0o600);
    const b = mk('beta', 'Beta Metals');
    sh(V('trial-up.sh'), ['beta', b]);
    const pa = envOf('acme').match(/API_PORT=(\d+)/)[1], pb = envOf('beta').match(/API_PORT=(\d+)/)[1];
    ck('two trials built on the same port get DIFFERENT ports on the VM', pa !== pb, pa + ' ' + pb);
    ck('a bad slug is refused', sh(V('trial-up.sh'), ['Bad Slug!', a]).status === 1);
    ck('a missing tarball is refused', sh(V('trial-up.sh'), ['gamma', path.join(tmp, 'nope.tgz')]).status === 1);
    // a tarball carrying the full Edge Metals app must be refused outright
    const evil = path.join(tmp, 'build/evil'); fs.mkdirSync(evil, { recursive: true }); fs.writeFileSync(path.join(evil, 'trial-server.js'), '//'); fs.writeFileSync(path.join(evil, 'index.js'), '//');
    spawnSync('tar', ['czf', path.join(tmp, 'evil.tgz'), '-C', path.join(tmp, 'build'), 'evil']);
    const ev = sh(V('trial-up.sh'), ['evil', path.join(tmp, 'evil.tgz')]);
    ck('a tarball that carries the Edge Metals app (index.js) is refused, and nothing is installed', ev.status !== 0 && /refusing/.test(ev.stderr + ev.stdout) && !fs.existsSync(path.join(TRIALS, 'evil')));

    section('B — updating keeps the customer\'s data');
    const loadsFile = path.join(TRIALS, 'acme/data/loads.json');
    const L = JSON.parse(fs.readFileSync(loadsFile, 'utf8')); L.push({ id: 'ACME_99', date: '2026-11-19', seller: 'Customer typed this', items: [] }); fs.writeFileSync(loadsFile, JSON.stringify(L));
    const pwBefore = envOf('acme').match(/ADMIN_PASSWORD=(.+)/)[1];
    fs.appendFileSync(ENVF, ''); fs.writeFileSync(ENVF, 'TRIAL_DOMAIN=trials.example.com\nTRIAL_GEMINI_KEY=rotated-key-456\nTRIAL_MEM_MB=300\n');
    const up2 = sh(V('trial-up.sh'), ['acme', mk2()]);
    function mk2() { const r = path.join(tmp, 'build2'); fs.mkdirSync(r, { recursive: true }); const o = path.join(r, 'acme'); const rr = spawnSync('node', [path.join(ROOT, 'scripts/make-trial.js'), '--name', 'Acme Scrap', '--slug', 'acme', '--out', o, '--link-modules'], { encoding: 'utf8' }); const t = path.join(tmp, 'acme2.tgz'); spawnSync('tar', ['czf', t, '-C', r, 'acme']); return t; }
    ck('running trial-up again says UPDATED', /UPDATED acme/.test(up2.stdout), up2.stdout + up2.stderr);
    ck('the customer\'s own data is still there (not re-seeded, not wiped)', fs.readFileSync(loadsFile, 'utf8').includes('Customer typed this'));
    ck('their passwords did not change', envOf('acme').match(/ADMIN_PASSWORD=(.+)/)[1] === pwBefore);
    ck('a rotated Gemini key reaches the existing trial', /^GEMINI_API_KEY=rotated-key-456$/m.test(envOf('acme')));
    fs.writeFileSync(ENVF, 'TRIAL_DOMAIN=trials.example.com\nTRIAL_GEMINI_KEY=trial-only-key-123\nTRIAL_MEM_MB=450\n');

    section('C — the copy it installed really runs');
    {
        const { spawn } = require('child_process');
        const port = Number(envOf('acme').match(/API_PORT=(\d+)/)[1]);
        const srv = spawn('node', ['trial-server.js'], { cwd: path.join(TRIALS, 'acme'), stdio: 'ignore' });
        const get = () => new Promise((res) => { http.get({ host: '127.0.0.1', port, path: '/api/health' }, (x) => { x.resume(); res(x.statusCode); }).on('error', () => res(0)); });
        let code = 0; for (let i = 0; i < 60 && !code; i++) { code = await get(); if (!code) await new Promise((r) => setTimeout(r, 1000)); }
        srv.kill();
        ck('the installed trial answers on its own port', code > 0, code);
    }

    section('D — trial-down');
    const dn = sh(V('trial-down.sh'), ['beta']);
    ck('it switches a trial off and keeps folder and data', dn.status === 0 && /SWITCHED OFF beta/.test(dn.stdout) && fs.existsSync(path.join(TRIALS, 'beta/data')), dn.stdout + dn.stderr);
    ck('its data was archived first', fs.readdirSync(ARCH).some((f) => /^beta-.*\.tgz$/.test(f)));
    const er = sh(V('trial-down.sh'), ['beta', '--erase']);
    ck('--erase removes the folder, and the archive remains', er.status === 0 && !fs.existsSync(path.join(TRIALS, 'beta')) && fs.readdirSync(ARCH).some((f) => /^beta-.*\.tgz$/.test(f)));
    ck('another trial is untouched by it', fs.existsSync(path.join(TRIALS, 'acme/data/loads.json')));
    ck('an unknown trial is refused', sh(V('trial-down.sh'), ['nosuch']).status === 1);

    section('E — trial-config (the one-time answers, changeable later)');
    const show = sh(V('trial-config.sh'), []);
    ck('it shows the settings and hides the key', /TRIAL_DOMAIN=trials\.example\.com/.test(show.stdout) && /set, hidden/.test(show.stdout) && !/trial-only-key-123/.test(show.stdout), show.stdout);
    ck('it changes the memory cap', sh(V('trial-config.sh'), ['set', 'TRIAL_MEM_MB', '600']).status === 0 && /TRIAL_MEM_MB=600/.test(fs.readFileSync(ENVF, 'utf8')));
    ck('it refuses a non-number memory cap', sh(V('trial-config.sh'), ['set', 'TRIAL_MEM_MB', 'lots']).status === 1);
    ck('it refuses something that is not a domain', sh(V('trial-config.sh'), ['set', 'TRIAL_DOMAIN', 'not a domain']).status === 1);
    ck('it refuses a setting it does not know', sh(V('trial-config.sh'), ['set', 'ADMIN_PASSWORD', 'x']).status === 1);
    const nasty = 'smtps://user:p&w#1\\x@mail.example.com:465';
    ck('it stores a mail setting exactly, even with & # and \\ in the password (no sed mangling)', sh(V('trial-config.sh'), ['set', 'SMTP_URL', nasty]).status === 0 && fs.readFileSync(ENVF, 'utf8').split('\n').includes('SMTP_URL=' + nasty));
    ck('changing a setting keeps every other line of the settings file', /TRIAL_DOMAIN=trials\.example\.com/.test(fs.readFileSync(ENVF, 'utf8')) && /TRIAL_GEMINI_KEY=/.test(fs.readFileSync(ENVF, 'utf8')) && /TRIAL_MEM_MB=600/.test(fs.readFileSync(ENVF, 'utf8')));
    ck('setting it twice leaves ONE line, not two', (sh(V('trial-config.sh'), ['set', 'MAIL_FROM', 'Y.A.R.D. <a@b.com>']), sh(V('trial-config.sh'), ['set', 'MAIL_FROM', 'Y.A.R.D. <hello@b.com>']), fs.readFileSync(ENVF, 'utf8').split('\n').filter((l) => l.startsWith('MAIL_FROM=')).length === 1 && /MAIL_FROM=Y\.A\.R\.D\. <hello@b\.com>/.test(fs.readFileSync(ENVF, 'utf8'))));
    ck('showing the settings hides the mail password and the Gemini key', (() => { const o = sh(V('trial-config.sh'), []).stdout; return /SMTP_URL=\(set, hidden\)/.test(o) && !/p&w/.test(o) && /TRIAL_GEMINI_KEY=\(set, hidden\)/.test(o); })());
    ck('it accepts an https agreement link and refuses an http one', sh(V('trial-config.sh'), ['set', 'AGREEMENT_URL', 'https://example.com/a']).status === 0 && sh(V('trial-config.sh'), ['set', 'AGREEMENT_URL', 'http://example.com/a']).status === 1 && sh(V('trial-config.sh'), ['set', 'AGREEMENT_URL', 'javascript:alert(1)']).status === 1);
    ck('it refuses a bad mail setting, a sender with no address, and a value split over two lines', sh(V('trial-config.sh'), ['set', 'SMTP_URL', 'not a url']).status === 1 && sh(V('trial-config.sh'), ['set', 'MAIL_FROM', 'nobody']).status === 1 && sh(V('trial-config.sh'), ['set', 'MAIL_FROM', 'a@b.com\nSMTP_URL=evil']).status === 1 && !/SMTP_URL=evil/.test(fs.readFileSync(ENVF, 'utf8')));
    ck('changing a sign-up setting tells you to restart the sign-up page', /restart/i.test(sh(V('trial-config.sh'), ['set', 'AGREEMENT_VERSION', '2026-12-01']).stdout));

    section('F — setup and ship guards');
    const setup = fs.readFileSync(V('setup.sh'), 'utf8');
    ck('setup asks for domain, Gemini key, email and memory cap, and confirms before installing', ['TRIAL_DOMAIN', 'GEMINI_KEY', 'CERT_EMAIL', 'TRIAL_MEM_MB'].every((k) => new RegExp('ask ' + k).test(setup)) && /Continue\? \[Y\/n\]/.test(setup));
    ck('the key is read hidden (read -s), not echoed', /read -r -s/.test(setup));
    ck('setup also asks for outgoing mail, a sender and the agreement link, and each can be skipped', ['SMTP_URL', 'MAIL_FROM', 'AGREEMENT_URL'].every((k) => new RegExp('ask ' + k).test(setup)) && /stays CLOSED/.test(setup));
    ck('the mail password is read hidden too, and the answers are written to the settings file', /ask SMTP_URL [^\n]*secret/.test(setup) && /^SMTP_URL=\$\{SMTP_URL:-\}$/m.test(setup) && /^MAIL_FROM=\$\{MAIL_FROM:-\}$/m.test(setup) && /^AGREEMENT_URL=\$\{AGREEMENT_URL:-\}$/m.test(setup));
    ck('a malformed mail setting, sender or agreement link typed at setup is dropped, not saved', /does not look like smtps/.test(setup) && /needs an email address/.test(setup) && /must start with https/.test(setup));
    ck('the domain is validated before anything is installed', setup.indexOf('does not look like a domain') > 0 && setup.indexOf('does not look like a domain') < setup.indexOf('apt-get update'));
    ck('answers are kept in /etc/trials.env, readable only by root and the trials user (trial-up runs as that user)', /chown root:trials \/etc\/trials\.env/.test(setup) && /chmod 640 \/etc\/trials\.env/.test(setup));
    ck('trials listen behind Caddy only; the firewall opens SSH, 80 and 443', /ufw allow 80,443/.test(setup) && /127\.0\.0\.1/.test(fs.readFileSync(V('trial-up.sh'), 'utf8')));
    ck('the Edge Metals source is never put on the VM (only finished trial folders)', !/git clone|github/i.test(setup));
    const nr = spawnSync('bash', [V('setup.sh')], { encoding: 'utf8', input: '' });
    ck('setup refuses to run as a normal user', nr.status !== 0 && /run as root|sudo/.test(nr.stdout + nr.stderr) || process.getuid() === 0);
    const ship = fs.readFileSync(path.join(ROOT, 'scripts/trial-ship.sh'), 'utf8');
    ck('trial-ship builds with the leak scan first and stops if it fails (set -e, make-trial before scp)', /set -euo pipefail/.test(ship) && ship.indexOf('make-trial.js') < ship.indexOf('scp '));
    ck('trial-ship refuses to run on the VM', /this looks like the trial VM/.test(ship));
    section('the public home page');
    const site = fs.readFileSync(path.join(ROOT, 'scripts/trial-vm/site/index.html'), 'utf8'), sgn = fs.readFileSync(path.join(ROOT, 'scripts/trial-vm/signup-server.js'), 'utf8');
    ck('the home page is one document with a title, no outside scripts, images or fonts', /<!DOCTYPE html>/i.test(site) && /<title>Y\.A\.R\.D\./.test(site) && !/<script[^>]+src=|<link[^>]+href=|<img[^>]+src="(https?:)?\/\/|@import|url\(http/i.test(site));
    ck('it names the product with its expansion and carries no Edge identity', /Your Assistant for Receiving and Dispatch/.test(site) && !/edge ?(metals|yard|trading)|apsara|zimex/i.test(site));
    ck('it makes no claims it cannot back (no customers, awards, certifications, compliance promise)', !/trusted by|testimonial|customers love|award|certified|SOC ?2|guarantee|fully compliant|\bcompliant with\b/i.test(site) && /does not make you compliant/.test(site));
    ck('the trial length on the page matches the signup server default', (site.match(/var TRIAL_DAYS = (\d+)/) || [])[1] === (sgn.match(/TRIAL_DAYS \|\| (\d+)/) || [])[1], (site.match(/var TRIAL_DAYS = (\d+)/) || [])[1] + ' vs ' + (sgn.match(/TRIAL_DAYS \|\| (\d+)/) || [])[1]);
    ck('its sign-up links point at signup.<this domain>, the address setup gives the signup page', /'https:\/\/signup\.' \+ (host|bare)\b/.test(site) && /bare = host\.replace\(\/\^www\\\.\/,''\)/.test(site) && /signup\.%s/.test(setup));
    const imgs = site.match(/<img [^>]*>/g) || [];
    ck('the page shows real app screens: each image is a local file with a description and a size, and none is missing', imgs.length >= 4 && imgs.every((i) => /src="img\/[a-z-]+\.webp"/.test(i) && /alt="[^"]{30,}"/.test(i) && /width="\d+"/.test(i) && /height="\d+"/.test(i) && fs.existsSync(path.join(ROOT, 'scripts/trial-vm/site', (i.match(/src="([^"]+)"/) || [])[1]))), imgs.length);
    ck('motion plays once (hero rise, the flow line and the four sample-load panels), never loops, ends on the true figures, and is off for people who ask for less motion', (site.match(/animation:/g) || []).length === 2 && !/infinite/.test(site) && /prefers-reduced-motion:reduce/.test(site) && /\.hero-shot \.screen\{animation:none\}/.test(site) && /IntersectionObserver/.test(site) && /else if \(st\) \{ st\.classList\.add\('in'\)/.test(site));
    ck('the sample-load panels end on the same numbers a real ticket would (8,560 = 18,420 - 9,860), are hidden from screen readers, and are labelled as made-up', 18420 - 9860 === 8560 && /data-to="8560"/.test(site) && (site.match(/class="viz v\d" aria-hidden="true"/g) || []).length === 4 && /made-up numbers/.test(site) && /matchMedia\('\(prefers-reduced-motion: reduce\)'\)/.test(site) && /\.js \.stages:not\(\.in\)/.test(site));
    ck('every font the page names is shipped beside it, with its licences, so nothing loads from another company', (site.match(/url\("fonts\/[^"]+"\)/g) || []).length === 4 && (site.match(/url\("fonts\/[^"]+"\)/g) || []).every((u) => fs.existsSync(path.join(ROOT, 'scripts/trial-vm/site', u.slice(5, -2)))) && fs.existsSync(path.join(ROOT, 'scripts/trial-vm/site/fonts/LICENSES.txt')) && /cp -r "\$HERE\/site\/fonts"/.test(setup));
    ck('setup copies the page images as well as the fonts (the page is blank-boxed without them), and every image the page names exists in site/img', /cp -r "\$HERE\/site\/fonts" "\$HERE\/site\/img" \/srv\/trial-site\//.test(setup) && (() => { const html = fs.readFileSync(path.join(ROOT, 'scripts/trial-vm/site/index.html'), 'utf8'); const names = [...html.matchAll(/img\/([a-z0-9-]+\.webp)/g)].map((m) => m[1]); return names.length >= 4 && names.every((n) => fs.existsSync(path.join(ROOT, 'scripts/trial-vm/site/img', n))); })());
    ck('setup installs the page and serves it at the domain and www, without touching the signup or trial addresses', /install -m 644 "\$HERE\/site\/index\.html" \/srv\/trial-site/.test(setup) && /root \* \/srv\/trial-site/.test(setup) && /trials\.d\/site\.caddy/.test(setup));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* best effort */ }
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
