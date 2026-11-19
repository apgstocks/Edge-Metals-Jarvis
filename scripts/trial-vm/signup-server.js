#!/usr/bin/env node
// ── signup-server.js — the public "start your free trial" page, on the trial VM ──
// A visitor gives a company name, an email, an invitation code and ticks the trial agreement. We email them a link; they
// press a button on that page and get their own isolated copy of the yard app in about a minute.
//   node signup-server.js                       serve (pm2 name: trial-signup, behind Caddy at signup.<domain>)
//   node signup-server.js --expire              sweep: switch off trials older than TRIAL_DAYS (daily cron); data is archived first
//   node signup-server.js --keep <slug>         mark a trial as a paying customer: it is never expired
//   node signup-server.js --invite ["note"] [--email x@y.com]   make a one-time invitation code (shown once; only its hash is stored)
//   node signup-server.js --invites             list invitation codes: id, note, who it is for, used or not
// Why the email step: without it anyone can start a trial as anyone. Why a button, not just a link: mail scanners open
// every link in a message, and a link that created the trial would hand the login details to the scanner.
// Fails CLOSED: with no mail settings, no public address or no agreement link it shows "not open yet" and makes nothing.
// Env: SIGNUP_PORT, MAX_TRIALS, TRIAL_DAYS, REGISTRY, PROVISION, TRIAL_DOWN, SIGNUP_GEMINI,
//      SMTP_URL + MAIL_FROM (how mail is sent), SIGNUP_BASE_URL (else https://signup.<TRIAL_DOMAIN>), AGREEMENT_URL,
//      AGREEMENT_VERSION, SIGNUP_OPEN=1 (no invitation code needed), MAIL_OUTBOX (tests: write mail to files), TEMPLATE_DIR.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

// pm2 starts this without the settings file in its environment, so read the few keys it needs from /etc/trials.env.
// Anything already set in the environment wins. (Change them with: sudo trial-config set SMTP_URL ...)
(function loadSettings() {
    try {
        for (const line of fs.readFileSync(process.env.ENV_FILE || '/etc/trials.env', 'utf8').split('\n')) {
            const m = line.match(/^(SMTP_URL|MAIL_FROM|AGREEMENT_URL|AGREEMENT_VERSION|SIGNUP_BASE_URL|SIGNUP_OPEN|TRIAL_DOMAIN)=(.*)$/);
            if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
        }
    } catch (e) { /* no settings file: the page stays closed */ }
})();

const PORT =Number(process.env.SIGNUP_PORT || 3099);
const MAX_TRIALS = Number(process.env.MAX_TRIALS || 15);          // active trials at once: the VM's memory is the limit
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 14);
const REGISTRY = process.env.REGISTRY || '/srv/trials-archive/signups.json';
const PENDING = process.env.PENDING || path.join(path.dirname(REGISTRY), 'pending.json');
const INVITES = process.env.INVITES || path.join(path.dirname(REGISTRY), 'invites.json');
const PROVISION = process.env.PROVISION || '/usr/local/bin/trial-provision';
const TRIAL_DOWN = process.env.TRIAL_DOWN || '/usr/local/bin/trial-down';
const TEMPLATE_DIR = process.env.TEMPLATE_DIR || '/srv/trial-kit/template';
const PER_IP_PER_HOUR = Number(process.env.PER_IP_PER_HOUR || 3);
const PENDING_TTL = 24 * 3600e3;                                    // a verification link works for a day
const RESEND_COOLDOWN = 10 * 60e3;                                  // one email per address per ten minutes: no mail-bombing a stranger
const PENDING_MAX = 200;
const AGREEMENT_VERSION = process.env.AGREEMENT_VERSION || '2026-11-19';
const RESERVED = new Set(['www', 'signup', 'admin', 'api', 'app', 'mail', 'smtp', 'ftp', 'ns1', 'ns2', 'root', 'demo', 'test', 'trial', 'trials', 'support', 'help', 'billing', 'status', 'static', 'assets', 'login', 'dashboard']);

const readJson = (f, empty) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return empty; } };
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o, null, 1), { mode: 0o600 }); fs.renameSync(t, f); };
const load = () => readJson(REGISTRY, { trials: [] });
const save = (r) => writeJson(REGISTRY, r);
const active = (r) => r.trials.filter((t) => !t.ended);
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// ── settings that must be present before the page opens ──
function trialDomain() {
    if (process.env.TRIAL_DOMAIN) return process.env.TRIAL_DOMAIN;
    try { return (fs.readFileSync(process.env.ENV_FILE || '/etc/trials.env', 'utf8').match(/^TRIAL_DOMAIN=(.*)$/m) || [])[1] || ''; } catch (e) { return ''; }
}
const baseUrl = () => (process.env.SIGNUP_BASE_URL || (trialDomain() ? `https://signup.${trialDomain()}` : '')).replace(/\/+$/, '');
const mailConfigured = () => !!process.env.MAIL_OUTBOX || (!!process.env.SMTP_URL && !!process.env.MAIL_FROM);
const notOpenReason = () => (!mailConfigured() ? 'mail is not set up (SMTP_URL, MAIL_FROM)' : !baseUrl() ? 'no public address (TRIAL_DOMAIN or SIGNUP_BASE_URL)' : !process.env.AGREEMENT_URL ? 'no agreement link (AGREEMENT_URL)' : '');
const inviteRequired = () => process.env.SIGNUP_OPEN !== '1';

async function sendMail(to, subject, text) {
    if (process.env.MAIL_OUTBOX) {                                   // tests: a file per message, nothing leaves the machine
        fs.mkdirSync(process.env.MAIL_OUTBOX, { recursive: true });
        fs.writeFileSync(path.join(process.env.MAIL_OUTBOX, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.json`), JSON.stringify({ to, subject, text }));
        return;
    }
    if (!process.env.SMTP_URL || !process.env.MAIL_FROM) throw new Error('mail is not configured');
    const nm = require(require.resolve('nodemailer', { paths: [TEMPLATE_DIR, __dirname, process.cwd()] }));   // installed once, in the template
    await nm.createTransport(process.env.SMTP_URL).sendMail({ from: process.env.MAIL_FROM, to, subject, text });
}

// ── invitation codes: single use, optionally for one email address; only the hash is kept ──
const loadInv = () => readJson(INVITES, { invites: [] });
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function findInvite(inv, code, email) {
    const h = sha(normCode(code)); if (normCode(code).length < 8) return null;
    return inv.invites.find((i) => i.hash === h && !i.used && (!i.email || i.email === email)) || null;
}
function makeInvite(note, email) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';           // no 0/O/1/I: read aloud over the phone
    const raw = Array.from(crypto.randomBytes(10), (b) => alphabet[b % alphabet.length]).join('');
    const code = `YARD-${raw.slice(0, 5)}-${raw.slice(5)}`;
    const inv = loadInv();
    const id = 'inv' + (inv.invites.length + 1);
    inv.invites.push({ id, hash: sha(normCode(code)), note: note || '', email: email ? email.toLowerCase() : null, created: new Date().toISOString(), used: null, usedBy: null });
    writeJson(INVITES, inv);
    return { id, code };
}

function slugFor(company, taken) {
    let base = company.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/g, '');
    if (base.length < 3) base = (base + '-yard').replace(/^-/, '');
    if (RESERVED.has(base)) base += '-yard';
    let s = base, n = 2;
    while (taken.has(s) || RESERVED.has(s)) s = `${base}-${n++}`.slice(0, 30);
    return s;
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PAGE = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Try Y.A.R.D. free</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:480px;margin:8vh auto;padding:0 18px;color:#1d2530}h1{font-size:24px;margin:0 0 6px}p.s{color:#566;margin:0 0 22px}
label{display:block;font-weight:600;margin:14px 0 4px}input{width:100%;padding:11px;font-size:16px;border:1px solid #bcc5d0;border-radius:8px;box-sizing:border-box}input[type=checkbox]{width:auto;margin-right:8px}label.ck{font-weight:400}
button{margin-top:20px;width:100%;padding:13px;font-size:16px;font-weight:600;border:0;border-radius:8px;background:#1f6feb;color:#fff;cursor:pointer}button:disabled{opacity:.6}
.err{background:#fde8e8;color:#8a1c1c;padding:10px 12px;border-radius:8px;margin-top:14px}.box{background:#f2f6fb;border-radius:10px;padding:14px 16px;margin:16px 0;word-break:break-all}.hp{position:absolute;left:-9999px}small{color:#667}</style></head><body>${body}</body></html>`;
const FORM = (err, v = {}) => PAGE(`<h1>Try Y.A.R.D. free</h1><p class="s">Your Assistant for Receiving and Dispatch. Your own copy with sample data, ready in about a minute. ${TRIAL_DAYS} days, no card needed.</p>
<form method="post" action="/signup" onsubmit="this.querySelector('button').disabled=true">
<label>Company name</label><input name="company" required minlength="2" maxlength="40" value="${esc(v.company || '')}" autocomplete="organization">
<label>Your email</label><input name="email" type="email" required value="${esc(v.email || '')}" autocomplete="email">
${inviteRequired() ? '<label>Invitation code</label><input name="invite" required maxlength="30" autocomplete="off" placeholder="YARD-XXXXX-XXXXX">' : ''}
<input class="hp" name="website" tabindex="-1" autocomplete="off">
<p><label class="ck"><input type="checkbox" name="accept" value="yes" required>I accept the <a href="${esc(process.env.AGREEMENT_URL || '#')}" target="_blank" rel="noopener">Y.A.R.D. free trial agreement</a>.</label></p>
${err ? `<div class="err">${esc(err)}</div>` : ''}<button>Email me my link</button><p><small>Sample data only. Don't enter real customer or ID details during the trial.</small></p></form>`);
const NOT_OPEN = () => PAGE('<h1>Sign-ups are not open yet</h1><p class="s">Please check back soon, or ask us for an invitation.</p>');
const CHECK = (email) => PAGE(`<h1>Check your email</h1><p class="s">If the details are right, we have sent a link to <b>${esc(email)}</b>. It works for 24 hours. Open it and press the button to create your yard.</p><p><small>Nothing arrived? Look in spam, then ask us.</small></p>`);
const CONFIRM = (token, note) => PAGE(`<h1>One last step</h1><p class="s">Press the button to create your yard. It takes about a minute. Your login details are shown once, so keep this page open.</p>
${note ? `<div class="err">${esc(note)}</div>` : ''}<form method="post" action="/verify" onsubmit="this.querySelector('button').disabled=true;this.querySelector('button').textContent='Setting up your yard… (about a minute)'"><input type="hidden" name="t" value="${esc(token)}"><button>Create my yard</button></form>`);
const DONE = (t) => PAGE(`<h1>Your yard is ready</h1><p class="s">Save these now. We only show them once.</p>
<div class="box"><b>Address</b><br><a href="${esc(t.url)}">${esc(t.url)}</a></div>
<div class="box"><b>Manager login</b> (everything)<br>${esc(t.admin)}<br><br><b>Staff login</b> (loads only)<br>${esc(t.staff)}</div>
<p>Phone app: open it and type the address above as the server.</p><p><small>Your trial runs for ${TRIAL_DAYS} days.</small></p>`);

const hits = new Map();                                              // ip -> [timestamps]
const tooMany = (ip) => { const now = Date.now(), l = (hits.get(ip) || []).filter((x) => now - x < 3600e3); hits.set(ip, l); if (l.length >= PER_IP_PER_HOUR) return true; l.push(now); return false; };
let busy = false;                                                    // one provision at a time: ports, pm2 and Caddy are shared

function readBody(req) {
    return new Promise((res, rej) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 4096) { rej(new Error('too large')); req.destroy(); } }); req.on('end', () => res(b)); req.on('error', rej); });
}
function provision(slug, company, email) {
    return new Promise((resolve, reject) => {
        const env = { ...process.env, NO_GEMINI: process.env.SIGNUP_GEMINI === '1' ? '0' : '1' };       // self-serve trials get no AI key unless the owner chose to
        const p = spawn('node', [PROVISION, slug, company, '--email', email], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', err = ''; p.stdout.on('data', (d) => out += d); p.stderr.on('data', (d) => err += d);
        const kill = setTimeout(() => p.kill('SIGKILL'), 300000);
        p.on('close', (code) => { clearTimeout(kill); const m = out.match(/^RESULT (.*)$/m); if (code === 0 && m) resolve(JSON.parse(m[1])); else reject(new Error((err || out).slice(0, 300))); });
    });
}

const freshPending = () => { const p = readJson(PENDING, { pending: [] }); p.pending = p.pending.filter((x) => Date.now() - new Date(x.created).getTime() < PENDING_TTL); return p; };

async function handle(req, res) {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const send = (code, html) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }); res.end(html); };
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/health') return send(200, 'ok');
    if (req.method === 'GET' && url.pathname === '/') return send(200, notOpenReason() ? NOT_OPEN() : FORM());
    if (req.method === 'GET' && url.pathname === '/verify') {        // opening the link only SHOWS a button: scanners that open links make nothing
        const t = url.searchParams.get('t') || '';
        if (!freshPending().pending.some((x) => x.th === sha(t))) return send(400, PAGE('<h1>This link has expired</h1><p class="s">Please start again from the sign-up page.</p>'));
        return send(200, CONFIRM(t));
    }
    if (req.method === 'POST' && url.pathname === '/signup') return signup(req, res, send, ip);
    if (req.method === 'POST' && url.pathname === '/verify') return verify(req, res, send);
    return send(404, PAGE('<h1>Not found</h1>'));
}

async function signup(req, res, send, ip) {
    let f; try { f = Object.fromEntries(new URLSearchParams(await readBody(req))); } catch (e) { return send(413, FORM('That request was too large.')); }
    const company = String(f.company || '').trim().replace(/\s+/g, ' '), email = String(f.email || '').trim().toLowerCase();
    if (f.website) return send(200, FORM());                           // a bot filled the hidden box: look like success, do nothing
    if (notOpenReason()) return send(503, NOT_OPEN());
    if (company.length < 2 || company.length > 40 || /[<>"'`\\$]/.test(company)) return send(400, FORM('Please enter your company name (2 to 40 letters or numbers, no quotes or symbols).', f));
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 80) return send(400, FORM('That email address does not look right.', f));
    if (f.accept !== 'yes') return send(400, FORM('Please tick the box to accept the trial agreement.', f));
    if (tooMany(ip)) return send(429, FORM('Too many sign-ups from this connection. Please try again in an hour.', f));
    const inv = loadInv(); let invite = null;
    if (inviteRequired()) { invite = findInvite(inv, f.invite, email); if (!invite) return send(403, FORM('That invitation code is not valid for this email. Ask us for one.', f)); }
    const reg = load(), pend = freshPending();
    // the reply is the same whether or not this email already has a trial or a recent link: it must not reveal who has signed up
    if (reg.trials.some((t) => t.email === email)) { try { await sendMail(email, 'Your Y.A.R.D. trial', 'A trial for this address already exists, so we did not create another. If you have lost your login details, reply to this email and we will help.'); } catch (e) { /* the reply stays generic */ } return send(200, CHECK(email)); }
    if (pend.pending.some((x) => x.email === email && Date.now() - new Date(x.created).getTime() < RESEND_COOLDOWN)) return send(200, CHECK(email));
    if (pend.pending.length >= PENDING_MAX) return send(503, FORM('We are busy right now. Please try again later.', f));
    const token = crypto.randomBytes(32).toString('hex');
    const rec = { th: sha(token), company, email, invite: invite ? invite.id : null, accepted_at: new Date().toISOString(), agreement: AGREEMENT_VERSION, created: new Date().toISOString() };
    pend.pending = pend.pending.filter((x) => x.email !== email); pend.pending.push(rec); writeJson(PENDING, pend);
    try {
        await sendMail(email, 'Confirm your free Y.A.R.D. trial', `Hello,\n\nSomeone asked for a free Y.A.R.D. trial for ${company} using this address. If it was you, open this link and press the button to create your yard (it works for 24 hours):\n\n${baseUrl()}/verify?t=${token}\n\nBy continuing you accept the Y.A.R.D. free trial agreement (version ${AGREEMENT_VERSION}): ${process.env.AGREEMENT_URL}\n\nIf it was not you, ignore this email and nothing will be created.\n`);
    } catch (e) {
        console.error('[signup] mail failed:', e.message);
        const p2 = freshPending(); p2.pending = p2.pending.filter((x) => x.th !== rec.th); writeJson(PENDING, p2);
        return send(500, FORM('We could not send the email. Please try again later.', f));
    }
    return send(200, CHECK(email));
}

async function verify(req, res, send) {
    let f; try { f = Object.fromEntries(new URLSearchParams(await readBody(req))); } catch (e) { return send(413, PAGE('<h1>That request was too large.</h1>')); }
    if (notOpenReason()) return send(503, NOT_OPEN());
    const th = sha(f.t || '');
    const gone = () => send(400, PAGE('<h1>This link has expired</h1><p class="s">Please start again from the sign-up page.</p>'));
    if (!freshPending().pending.some((x) => x.th === th)) return gone();
    if (busy) return send(503, CONFIRM(f.t, 'Another yard is being set up right now. Please press the button again in a minute.'));
    busy = true;
    try {
        const pend = freshPending(), rec = pend.pending.find((x) => x.th === th); if (!rec) return gone();
        const reg = load(), inv = loadInv();
        let invite = null;
        if (inviteRequired()) { invite = inv.invites.find((i) => i.id === rec.invite && !i.used); if (!invite) return send(403, PAGE('<h1>That invitation has already been used</h1><p class="s">Ask us for a new one.</p>')); }
        if (reg.trials.some((t) => t.email === rec.email)) return send(409, PAGE('<h1>That email already has a trial</h1>'));
        if (active(reg).length >= MAX_TRIALS) return send(503, PAGE('<h1>We are full for the moment</h1><p class="s">Please try again soon. Your link stays valid for 24 hours.</p>'));
        const slug = slugFor(rec.company, new Set(reg.trials.map((t) => t.slug)));
        const t = await provision(slug, rec.company, rec.email);
        const now = new Date().toISOString();
        reg.trials.push({ slug, company: rec.company, email: rec.email, created: now, keep: false, verified_at: now, accepted_at: rec.accepted_at, agreement: rec.agreement, invite: rec.invite, version: t.version });
        save(reg);
        if (invite) { invite.used = now; invite.usedBy = slug; writeJson(INVITES, inv); }
        pend.pending = pend.pending.filter((x) => x.th !== th); writeJson(PENDING, pend);
        return send(200, DONE(t));
    } catch (e) {
        console.error('[signup] provision failed:', e.message);
        return send(500, PAGE('<h1>Something went wrong setting up your yard</h1><p class="s">Please try the link again in a minute.</p>'));
    } finally { busy = false; }
}

function expire() {
    const reg = load(), cutoff = Date.now() - TRIAL_DAYS * 86400e3; let n = 0;
    for (const t of reg.trials) {
        if (t.ended || t.keep || new Date(t.created).getTime() > cutoff) continue;
        const r = spawnSync('bash', [TRIAL_DOWN, t.slug], { encoding: 'utf8' });
        if (r.status === 0) { t.ended = new Date().toISOString(); n++; console.log('[expire] switched off ' + t.slug); }
        else console.error('[expire] could not switch off ' + t.slug + ': ' + (r.stderr || r.stdout).slice(0, 200));
    }
    save(reg); console.log(`[expire] ${n} trial(s) switched off`);
}
function keep(slug) {
    const reg = load(), t = reg.trials.find((x) => x.slug === slug);
    if (!t) { console.error('no trial called ' + slug); process.exit(1); }
    t.keep = true; save(reg); console.log(slug + ' will not expire');
}
function invite() {
    const a = process.argv.slice(process.argv.indexOf('--invite') + 1), ei = a.indexOf('--email');
    const email = ei > -1 ? a[ei + 1] : '', note = a.filter((x, i) => !x.startsWith('--') && a[i - 1] !== '--email')[0] || '';
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { console.error('that email address does not look right'); process.exit(1); }
    const { id, code } = makeInvite(note, email);
    console.log(`${id}  ${code}${email ? '  (only for ' + email.toLowerCase() + ')' : ''}${note ? '  ' + note : ''}\nShown once. Give it to the yard by phone or message; it works one time.`);
}
function listInvites() {
    const inv = loadInv(); if (!inv.invites.length) return console.log('no invitation codes yet');
    for (const i of inv.invites) console.log(`${i.id}  ${i.used ? 'USED by ' + i.usedBy : 'unused'}  ${i.email ? 'for ' + i.email : 'any email'}  ${i.note}`);
}

if (process.argv.includes('--expire')) expire();
else if (process.argv.includes('--keep')) keep(process.argv[process.argv.indexOf('--keep') + 1]);
else if (process.argv.includes('--invites')) listInvites();
else if (process.argv.includes('--invite')) invite();
else if (require.main === module) {
    const why = notOpenReason(); if (why) console.warn('[signup] page is CLOSED: ' + why);
    http.createServer((q, s) => handle(q, s).catch((e) => { console.error(e); s.writeHead(500); s.end('error'); })).listen(PORT, '127.0.0.1', () => console.log('[signup] on 127.0.0.1:' + PORT));
}
