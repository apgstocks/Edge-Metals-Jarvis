#!/usr/bin/env node
// ── trial-fleet — look after ALL the trial copies on this VM: who is running, is there room, bring them up to date ──
//   trial-fleet status [--json]                 every trial, days left, whether it is on the current template, and the capacity gauge
//   trial-fleet upgrade <slug>                  bring ONE trial up to the current template (its data, logins and brand are kept)
//   trial-fleet upgrade --all [--dry-run]       the same for every active trial, one at a time, stopping at the first failure
//   trial-fleet upgrade ... --force             rebuild even trials that are already on the current template
// Run after `trial-ship.sh --template` has uploaded a new release:  sudo -u trials trial-fleet upgrade --all
// Each upgrade first saves a copy of that trial (code + data + logins), rebuilds it from the template, checks it answers on its port,
// and puts the saved copy back if it does not. Trials that are not paying are upgraded before paying ones, so a bad release
// is met by a trial before it is met by a customer. The first failure stops the run: the rest are left on the old release.
// Env: REGISTRY, TRIALS_DIR, ARCHIVE_DIR, PROVISION, TRIAL_DAYS, MAX_TRIALS, TRIAL_MEM_MB, FLEET_RESERVE_MB, ENV_FILE,
//      FLEET_TOTAL_MB / FLEET_AVAILABLE_MB (tests), SKIP_PM2=1 (tests), FLEET_HEALTH_WAIT_MS.
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net');
const { spawnSync } = require('child_process');

const REGISTRY = process.env.REGISTRY || '/srv/trials-archive/signups.json';
const TRIALS_DIR = process.env.TRIALS_DIR || '/srv/trials';
const ARCHIVE_DIR = process.env.ARCHIVE_DIR || path.dirname(REGISTRY);
const PROVISION = process.env.PROVISION || '/usr/local/bin/trial-provision';
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 14);
const MAX_TRIALS = Number(process.env.MAX_TRIALS || 15);
const RESERVE_MB = Number(process.env.FLEET_RESERVE_MB || 1024);    // the OS, Caddy, the sign-up page, pm2 and PDF spikes
const HEALTH_WAIT_MS = Number(process.env.FLEET_HEALTH_WAIT_MS || 30000);
const KEEP_SNAPSHOT_DAYS = 14;

const readJson = (f, empty) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return empty; } };
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o, null, 1), { mode: 0o600 }); fs.renameSync(t, f); };
const memCap = () => {
    if (process.env.TRIAL_MEM_MB) return Number(process.env.TRIAL_MEM_MB);
    try { const m = fs.readFileSync(process.env.ENV_FILE || '/etc/trials.env', 'utf8').match(/^TRIAL_MEM_MB=(\d+)$/m); if (m) return Number(m[1]); } catch (e) { /* default */ }
    return 450;
};
const totalMb = () => Number(process.env.FLEET_TOTAL_MB || Math.round(os.totalmem() / 1048576));
const availableMb = () => {
    if (process.env.FLEET_AVAILABLE_MB) return Number(process.env.FLEET_AVAILABLE_MB);
    try { const m = fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB/m); if (m) return Math.round(Number(m[1]) / 1024); } catch (e) { /* fall through */ }
    return Math.round(os.freemem() / 1048576);
};
const templateVersion = () => { const r = spawnSync('node', [PROVISION, '--version'], { encoding: 'utf8', env: process.env }); return r.status === 0 ? r.stdout.trim() : null; };
const active = (reg) => reg.trials.filter((t) => !t.ended);
const daysOld = (t) => (Date.now() - new Date(t.created).getTime()) / 86400e3;

// ── the capacity gauge: worst case, every active trial using its whole memory cap ──
function capacity(reg) {
    const total = totalMb(), cap = memCap(), n = active(reg).length;
    const budget = Math.max(1, total - RESERVE_MB), committed = n * cap, pct = Math.round(100 * committed / budget);
    const fit = Math.max(0, Math.floor(budget / cap));
    const level = pct >= 85 ? 'FULL' : pct >= 60 ? 'PLAN' : 'OK';
    const needFor = (k) => k * cap + RESERVE_MB;
    return { total, reserve: RESERVE_MB, cap, active: n, budget, committed, pct, fit, level, maxTrials: MAX_TRIALS, maxTooHigh: MAX_TRIALS > fit,
        availableNow: availableMb(), ramFor: { now: needFor(n), plus5: needFor(n + 5), maxTrials: needFor(MAX_TRIALS) } };
}
const gaugeText = (c) => [
    `Capacity   ${c.total} MB RAM, ${c.reserve} MB kept back for the system, ${c.cap} MB per trial: room for ${c.fit} trials`,
    `           ${c.active} active = ${c.committed} MB if each used its whole cap (${c.pct}% of the ${c.budget} MB available to trials)   [${c.level}]`,
    c.level === 'FULL' ? `           FULL: resize this VM before accepting more sign-ups (about ${c.ramFor.plus5} MB RAM for 5 more)`
        : c.level === 'PLAN' ? `           PLAN: past 60%. Resize soon: ${c.ramFor.plus5} MB RAM would hold 5 more than today`
            : `           room to grow. ${c.ramFor.maxTrials} MB RAM would hold the MAX_TRIALS limit of ${c.maxTrials}`,
    c.maxTooHigh ? `           WARNING: MAX_TRIALS is ${c.maxTrials} but this VM only has room for ${c.fit}. Lower it or resize, or the VM runs out of memory first` : `           MAX_TRIALS is ${c.maxTrials}: fits`,
    `           free right now: ${c.availableNow} MB`,
].join('\n');

function status(json) {
    const reg = readJson(REGISTRY, { trials: [] }), cur = templateVersion(), c = capacity(reg);
    const rows = reg.trials.map((t) => {
        const state = t.ended ? 'ended' : t.keep ? 'paying' : 'trial';
        const left = t.ended || t.keep ? null : Math.max(0, Math.ceil(TRIAL_DAYS - daysOld(t)));
        const ver = t.ended ? null : !cur ? 'unknown' : (t.version === cur ? 'current' : t.version ? 'BEHIND' : 'BEHIND (never stamped)');
        return { slug: t.slug, company: t.company, email: t.email, state, daysLeft: left, version: ver, verified: !!t.verified_at, agreement: t.agreement || null };
    });
    if (json) return console.log(JSON.stringify({ capacity: c, templateVersion: cur, trials: rows }, null, 1));
    const w = (s, n) => String(s == null ? '-' : s).padEnd(n).slice(0, n);
    console.log(gaugeText(c)); console.log(`\nTemplate on this VM: ${cur || 'none uploaded yet'}\n`);
    console.log(w('TRIAL', 22) + w('STATE', 8) + w('DAYS LEFT', 10) + w('VERSION', 22) + w('VERIFIED', 9) + 'EMAIL');
    for (const r of rows) console.log(w(r.slug, 22) + w(r.state, 8) + w(r.daysLeft, 10) + w(r.version, 22) + w(r.verified ? 'yes' : 'no', 9) + r.email);
    const behind = rows.filter((r) => /BEHIND/.test(r.version || '')).length;
    console.log(`\n${rows.filter((r) => r.state !== 'ended').length} running, ${rows.filter((r) => r.state === 'ended').length} ended${behind ? `, ${behind} behind the template: run  trial-fleet upgrade --all` : ''}`);
}

// ── upgrade ──
const lockFile = () => path.join(ARCHIVE_DIR, 'fleet.lock');
function lock() {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    try { const st = fs.statSync(lockFile()); if (Date.now() - st.mtimeMs > 3600e3) fs.rmSync(lockFile()); } catch (e) { /* none */ }
    try { fs.writeFileSync(lockFile(), String(process.pid), { flag: 'wx' }); held = true; } catch (e) { throw new Error('another trial-fleet run is in progress (remove ' + lockFile() + ' if it is not)'); }
}
let held = false;
const unlock = () => { if (!held) return; held = false; try { fs.rmSync(lockFile()); } catch (e) { /* gone */ } };   // only ever remove OUR lock
const sh = (cmd, args, opts) => spawnSync(cmd, args, { encoding: 'utf8', ...(opts || {}) });
const portOf = (dir) => Number((fs.readFileSync(path.join(dir, '.env'), 'utf8').match(/^API_PORT=(\d+)/m) || [])[1]);
function answers(port) {
    return new Promise((resolve) => {
        const end = Date.now() + HEALTH_WAIT_MS;
        const tryOnce = () => { const s = net.connect(port, '127.0.0.1'); s.setTimeout(2000); s.on('connect', () => { s.destroy(); resolve(true); }); const again = () => { s.destroy(); if (Date.now() < end) setTimeout(tryOnce, 1000); else resolve(false); }; s.on('error', again); s.on('timeout', again); };
        tryOnce();
    });
}
function pruneSnapshots() {
    const d = path.join(ARCHIVE_DIR, 'pre-upgrade'); if (!fs.existsSync(d)) return;
    for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (Date.now() - fs.statSync(p).mtimeMs > KEEP_SNAPSHOT_DAYS * 86400e3) fs.rmSync(p, { force: true }); }
}
function snapshot(slug) {
    const dir = path.join(TRIALS_DIR, slug), out = path.join(ARCHIVE_DIR, 'pre-upgrade'); fs.mkdirSync(out, { recursive: true, mode: 0o700 });
    const file = path.join(out, `${slug}-${new Date().toISOString().replace(/[:.]/g, '-')}.tgz`);
    const r = sh('tar', ['czf', file, '--exclude=node_modules', '-C', dir, '.']);
    if (r.status !== 0) throw new Error('could not save a copy first: ' + r.stderr);
    fs.chmodSync(file, 0o600); return file;
}
function rollback(slug, file) {
    const dir = path.join(TRIALS_DIR, slug), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-restore-'));
    try {
        if (sh('tar', ['xzf', file, '-C', tmp]).status !== 0) return false;
        if (sh('rsync', ['-a', '--delete', '--exclude', 'node_modules', tmp + '/', dir + '/']).status !== 0) return false;
        if (process.env.SKIP_PM2 !== '1') sh('pm2', ['restart', 'trial-' + slug]);
        return true;
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
async function upgradeOne(t, cur) {
    const dir = path.join(TRIALS_DIR, t.slug);
    if (!fs.existsSync(path.join(dir, '.env'))) return { ok: false, why: 'its folder is missing on this VM' };
    let snap; try { snap = snapshot(t.slug); } catch (e) { return { ok: false, why: e.message }; }
    const r = sh('node', [PROVISION, t.slug, t.company, '--update', '--email', t.email || `owner@${t.slug}.example`], { env: process.env, timeout: 300000 });
    const m = (r.stdout || '').match(/^RESULT (.*)$/m);
    let healthy = false, why = '';
    if (r.status !== 0 || !m) why = 'the rebuild failed: ' + String(r.stderr || r.stdout).slice(0, 200);
    else if (!(healthy = await answers(portOf(dir)))) why = `it did not answer on its port within ${Math.round(HEALTH_WAIT_MS / 1000)}s`;
    if (healthy) return { ok: true, snap, version: JSON.parse(m[1]).version || cur };
    const back = rollback(t.slug, snap);
    return { ok: false, why, rolledBack: back, snap };
}
async function upgrade(argv) {
    const all = argv.includes('--all'), dry = argv.includes('--dry-run'), force = argv.includes('--force');
    const slug = argv.find((a) => !a.startsWith('--'));
    if (!all && !slug) { console.error('usage: trial-fleet upgrade <slug> | --all [--dry-run] [--force]'); process.exit(2); }
    const cur = templateVersion(); if (!cur) { console.error('no template on this VM: run trial-ship.sh --template from the Mac first'); process.exit(1); }
    const reg = readJson(REGISTRY, { trials: [] });
    let targets = active(reg);
    if (!all) { targets = targets.filter((t) => t.slug === slug); if (!targets.length) { console.error(`no active trial called ${slug} in the registry (trials made by hand with trial-ship are not upgraded here)`); process.exit(1); } }
    targets.sort((a, b) => (a.keep ? 1 : 0) - (b.keep ? 1 : 0) || new Date(a.created) - new Date(b.created));   // trials first, paying customers last
    const todo = targets.filter((t) => force || t.version !== cur), skipped = targets.filter((t) => !todo.includes(t));
    console.log(`template ${cur}: ${todo.length} to upgrade, ${skipped.length} already current${dry ? ' (dry run: nothing will change)' : ''}`);
    for (const t of skipped) console.log(`  skip     ${t.slug}  already current`);
    if (dry) { for (const t of todo) console.log(`  would upgrade ${t.slug}${t.keep ? '  (paying: last)' : ''}`); return; }
    if (!todo.length) return;
    lock(); pruneSnapshots(); let n = 0;
    try {
        for (const t of todo) {
            process.stdout.write(`  upgrading ${t.slug}${t.keep ? ' (paying)' : ''} ... `);
            const r = await upgradeOne(t, cur);
            if (!r.ok) {
                console.log(`FAILED: ${r.why}`);
                console.log(r.rolledBack ? `  rolled back: ${t.slug} is on its old code with its data as it was (copy kept at ${r.snap})` : `  COULD NOT ROLL BACK ${t.slug}. Restore by hand from ${r.snap}`);
                console.log(`  stopped. ${todo.length - n - 1} trial(s) after it were NOT touched.`);
                process.exitCode = 1; return;
            }
            const reg2 = readJson(REGISTRY, { trials: [] }), rec = reg2.trials.find((x) => x.slug === t.slug);
            if (rec) { rec.version = r.version; rec.upgraded = new Date().toISOString(); writeJson(REGISTRY, reg2); }
            n++; console.log('ok');
        }
        console.log(`${n} trial(s) upgraded to ${cur}`);
    } finally { unlock(); }
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'status') status(rest.includes('--json'));
else if (cmd === 'upgrade') upgrade(rest).catch((e) => { unlock(); console.error('trial-fleet: ' + e.message); process.exit(1); });
else { console.error('usage: trial-fleet status [--json] | upgrade <slug> | upgrade --all [--dry-run] [--force]'); process.exit(2); }
