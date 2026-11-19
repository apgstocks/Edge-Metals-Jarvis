#!/usr/bin/env node
// ── provision.js — turn the neutral trial TEMPLATE into one customer's trial, on the trial VM ──
//   trial-provision <slug> "<Company Name>" [--email you@x.com] [--lang en|es]   --lang = the language this customer's screens start in (default en)
//   trial-provision <slug> "<Company Name>" --update [--email x]   rebuild an EXISTING trial from the current template: new code, same data,
//                                                                  same passwords, same brand (used by trial-fleet upgrade)
//   trial-provision --version                                      print a short fingerprint of the current template
// The template (/srv/trial-kit/template) was built on the Mac by `trial-ship.sh --template` with a placeholder brand.
// This swaps the placeholder for the customer's name, gives it fresh passwords, packs it and runs trial-up.
// It holds nothing of the original business: it only renames a copy that is already neutral.
// Env: TEMPLATE_DIR (default /srv/trial-template), TRIAL_UP (default /usr/local/bin/trial-up), plus what trial-up reads.
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { spawnSync } = require('child_process');

const TEMPLATE_DIR = process.env.TEMPLATE_DIR || '/srv/trial-kit/template';
const TRIALS_DIR = process.env.TRIALS_DIR || '/srv/trials';
const TRIAL_UP = process.env.TRIAL_UP || '/usr/local/bin/trial-up';
const PLACEHOLDER = { brand: 'Tenantzz Co', slug: 'tenantzz' };          // must equal what trial-ship --template builds with
const TEXT = /\.(js|html|json|css|md|txt|webmanifest|xml|gradle|properties|svg|sh|yml|yaml|java|kt|kts|pro)$/i;
const SLUG_OK = /^[a-z0-9][a-z0-9-]{1,30}$/;

const pw = () => { let s = ''; while (s.length < 12) s += crypto.randomBytes(12).toString('base64').replace(/[^a-zA-Z0-9]/g, ''); return s.slice(0, 12) + crypto.randomInt(10, 99); }; // always 12 letters/digits + 2 digits (stripping + and / used to leave some under 12)

// the same spellings make-trial.js produced from the placeholder, turned into this customer's
function rulesFor(brand, slug, email) {
    const C = brand.replace(/[^A-Za-z0-9]/g, '');
    const U = slug.replace(/-/g, '_');
    const first = brand.split(/\s+/)[0].replace(/[^A-Za-z0-9]/g, '') || slug;
    const keep = (m, built) => (m === m.toUpperCase() ? built.toUpperCase() : m === m.toLowerCase() ? built.toLowerCase() : built);
    const P = PLACEHOLDER.slug;                                          // "tenantzz"
    const kw = '(?=yard|trading|metals?)';
    return [
        { re: /owner@tenantzz\.example/gi, to: email },
        // make-trial puts the brand's first letter in the sign-in logo (MARK). The template's is the placeholder's "T",
        // so a provisioned trial showed "T" for every customer. Same letter make-trial would have chosen.
        { re: /<div class="brand-mark">T<\/div>/g, to: `<div class="brand-mark">${(first[0] || 'Y').toUpperCase()}</div>` },
        { re: new RegExp(`${P}[ ]co(?![a-z])`, 'gi'), fn: (m) => keep(m, brand) },
        { re: new RegExp(`${P}co${kw}`, 'gi'), fn: (m) => keep(m, C) },
        { re: new RegExp(`${P}(_)${kw}`, 'gi'), fn: (m) => keep(m, U + '_') },
        { re: new RegExp(`${P}(-)${kw}`, 'gi'), fn: (m) => keep(m, slug + '-') },
        { re: new RegExp(`${P}\\.example`, 'gi'), to: `${slug}.example` },
        { re: /TENANTZZ/g, to: first.toUpperCase() },
        { re: /Tenantzz/g, to: first },
        { re: /tenantzz/g, to: slug },
    ];
}
const apply = (s, rules) => rules.reduce((t, r) => t.replace(r.re, r.fn || r.to), s);

function copyTree(src, dst, rules) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
        if (name === 'node_modules' || name === 'data' || name === '.env') continue;
        const from = path.join(src, name), to = path.join(dst, apply(name, rules));
        const st = fs.lstatSync(from);
        if (st.isSymbolicLink()) { fs.symlinkSync(fs.readlinkSync(from), to); continue; }   // routes/helpers -> ../helpers
        if (st.isDirectory()) copyTree(from, to, rules);
        else if (TEXT.test(name)) fs.writeFileSync(to, apply(fs.readFileSync(from, 'utf8'), rules), { mode: st.mode });
        else fs.copyFileSync(from, to);
    }
}
function leftovers(dir, rel = '') {                                      // anything of the placeholder still there is a failure
    const hits = [];
    for (const name of fs.readdirSync(path.join(dir, rel))) {
        const r = rel ? `${rel}/${name}` : name;
        if (/tenantzz/i.test(name)) hits.push(r + ' (name)');
        const st = fs.lstatSync(path.join(dir, r));
        if (st.isSymbolicLink() || name === 'node_modules') continue;
        if (st.isDirectory()) hits.push(...leftovers(dir, r));
        else if (TEXT.test(name) && /tenantzz/i.test(fs.readFileSync(path.join(dir, r), 'utf8'))) hits.push(r);
    }
    return hits;
}

// a short fingerprint of the template: which release a tenant was built from (changes whenever any template file changes)
function templateVersion(dir) {
    const h = crypto.createHash('sha256');
    const walk = (rel) => {
        for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
            if (['node_modules', 'data', '.env', 'TRIAL-README.md'].includes(name)) continue;
            const r = rel ? rel + '/' + name : name, st = fs.lstatSync(path.join(dir, r));
            if (st.isSymbolicLink()) h.update('L' + r + fs.readlinkSync(path.join(dir, r)));
            else if (st.isDirectory()) walk(r);
            else { h.update('F' + r); h.update(fs.readFileSync(path.join(dir, r))); }
        }
    };
    walk('');
    return h.digest('hex').slice(0, 12);
}

function main() {
    if (process.argv.includes('--version')) {
        if (!fs.existsSync(path.join(TEMPLATE_DIR, 'trial-server.js'))) throw new Error(`no template at ${TEMPLATE_DIR}`);
        console.log(templateVersion(TEMPLATE_DIR)); return;
    }
    const UPDATE = process.argv.includes('--update');
    const li = process.argv.indexOf('--lang'); const lang = li > -1 ? process.argv[li + 1] : 'en';
    if (lang !== 'en' && lang !== 'es') throw new Error('--lang must be en or es');
    if (UPDATE && li > -1) throw new Error('--lang is set when a trial is created; to change it later edit dashboard/yard-lang-default.js in that trial');
    const args = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--email' && all[i - 1] !== '--lang');
    const slug = args[0], brand = (args[1] || '').trim();
    const ei = process.argv.indexOf('--email'); const email = ei > -1 ? process.argv[ei + 1] : `owner@${slug}.example`;
    if (!SLUG_OK.test(slug || '')) throw new Error('usage: trial-provision <slug a-z0-9-> "<Company Name>" [--email x]');
    if (brand.length < 2 || brand.length > 40 || /[<>"'`\\$\n\r]/.test(brand)) throw new Error('company name must be 2-40 characters without quotes or symbols');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('that email address does not look right');
    if (!fs.existsSync(path.join(TEMPLATE_DIR, 'trial-server.js'))) throw new Error(`no template at ${TEMPLATE_DIR}: run trial-ship.sh --template from the Mac first`);
    if (UPDATE) { if (!fs.existsSync(path.join(TRIALS_DIR, slug, '.env'))) throw new Error(`no trial called ${slug} to update`); }
    else if (fs.existsSync(path.join(TRIALS_DIR, slug))) throw new Error(`a trial called ${slug} already exists`);

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-'));
    try {
        const out = path.join(work, slug);
        copyTree(TEMPLATE_DIR, out, rulesFor(brand, slug, email));
        const left = leftovers(out);
        if (left.length) throw new Error('template placeholder still present in: ' + left.slice(0, 5).join(', '));
        const nm = path.join(TEMPLATE_DIR, 'node_modules');
        if (fs.existsSync(nm)) fs.symlinkSync(nm, path.join(out, 'node_modules'), 'dir');     // one shared install, not 300 MB per customer
        if (UPDATE) {
            // an update never creates passwords, an .env or data: trial-up keeps the ones on the VM. But it syncs with --delete, so the
            // README (which holds the logins) must travel in the tarball or it would be deleted
            const readme = path.join(TRIALS_DIR, slug, 'TRIAL-README.md');
            if (fs.existsSync(readme)) fs.copyFileSync(readme, path.join(out, 'TRIAL-README.md'));
            // the customer's chosen starting language is theirs, not the template's: carry it across the upgrade
            const dflt = path.join(TRIALS_DIR, slug, 'dashboard', 'yard-lang-default.js');
            if (fs.existsSync(dflt)) fs.copyFileSync(dflt, path.join(out, 'dashboard', 'yard-lang-default.js'));
        } else {
            const creds = { admin: pw(), staff: pw(), user: pw() };
            const port = 3100 + Math.floor(Math.random() * 800);
            fs.writeFileSync(path.join(out, '.env'), [`ADMIN_PASSWORD=${creds.admin}`, `STAFF_PASSWORD=${creds.staff}`, `APP_PASSWORD=${creds.user}`, `API_PORT=${port}`, `DATA_DIR=${path.join(out, 'data')}`, 'TRIAL=1', ''].join('\n'), { mode: 0o600 });
            fs.mkdirSync(path.join(out, 'data'), { recursive: true });
            fs.writeFileSync(path.join(out, 'dashboard', 'yard-lang-default.js'), `// This customer's starting screen language: 'en' or 'es'. People can still switch (the EN / ES buttons, top right).\nwindow.YARD_DEFAULT_LANG = '${lang}';\n`);
            fs.writeFileSync(path.join(out, 'TRIAL-README.md'), `# ${brand} — trial\n\nManager login: ${creds.admin}\nStaff login:   ${creds.staff}\nTeam login:    ${creds.user}\n`);
        }
        const tgz = path.join(work, slug + '.tgz');
        let r = spawnSync('tar', ['czf', tgz, '-C', work, slug], { encoding: 'utf8' });
        if (r.status !== 0) throw new Error('tar failed: ' + r.stderr);
        r = spawnSync('bash', [TRIAL_UP, slug, tgz], { encoding: 'utf8', env: { ...process.env, SKIP_NPM: process.env.SKIP_NPM || '0' }, timeout: 300000 });
        if (r.status !== 0) throw new Error('trial-up failed: ' + (r.stderr || r.stdout).slice(0, 400));
        const env = fs.readFileSync(path.join(TRIALS_DIR, slug, '.env'), 'utf8');
        const get = (k) => (env.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1];
        const domain = process.env.TRIAL_DOMAIN || (fs.existsSync(process.env.ENV_FILE || '/etc/trials.env') ? (fs.readFileSync(process.env.ENV_FILE || '/etc/trials.env', 'utf8').match(/^TRIAL_DOMAIN=(.*)$/m) || [])[1] : '') || 'localhost';
        const version = templateVersion(TEMPLATE_DIR);
        if (UPDATE) { console.log('RESULT ' + JSON.stringify({ slug, updated: true, version, port: Number(get('API_PORT')) })); return; }     // no logins printed on an update
        console.log('RESULT ' + JSON.stringify({ slug, brand, lang, version, url: `https://${slug}.${domain}`, port: Number(get('API_PORT')), admin: get('ADMIN_PASSWORD'), staff: get('STAFF_PASSWORD'), team: get('APP_PASSWORD') }));
    } finally { fs.rmSync(work, { recursive: true, force: true }); }
}
try { main(); } catch (e) { console.error('provision: ' + e.message); process.exit(1); }
