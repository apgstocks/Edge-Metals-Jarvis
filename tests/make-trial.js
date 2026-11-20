// ── tests/make-trial.js — the plug-and-play trial export ─────────────────────
// Apsara, 2026-11-18: a trial copy of the yard app for other customers. Branding "in the copy only", yard app only,
// one hosted copy per customer. The property that matters: NOTHING of Edge's reaches a customer, and the live code is
// never changed by making one.
//   A  the export: outside the repo, clean scan, no secrets, fresh passwords, refuses to overwrite
//   B  the copy runs: boots API-only, seeds, serves real routes under the customer's name
//   C  the live repo is byte-for-byte what it was
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');
let pass = 0, fail = 0; const ck = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n); if (x) console.log('        ' + String(x).slice(0, 300)); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts/make-trial.js');
const walk = (d, rel = '') => fs.readdirSync(path.join(d, rel)).flatMap((n) => { const r = rel ? rel + '/' + n : n; const st = fs.lstatSync(path.join(d, r)); return st.isSymbolicLink() ? [] : st.isDirectory() ? walk(d, r) : [r]; });
const sha = (f) => crypto.createHash('sha1').update(fs.readFileSync(path.join(ROOT, f))).digest('hex');
const LIVE = ['api.js', 'config.js', 'helpers/loads.js', 'helpers/entities.js', 'routes/loads.js', 'dashboard/app/13-loads-render.js', 'helpers/poSheet.js', 'dashboard/index.html', 'dashboard/sidebar.js', 'dashboard/app/01-core.js'];
const before = Object.fromEntries(LIVE.map((f) => [f, sha(f)]));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-trial-'));
const out = path.join(tmp, 'acme');
const make = (args) => spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', timeout: 120000 });

(async () => {
    section('A — the export');
    const r = make(['--name', 'Acme Scrap', '--slug', 'acme', '--out', out, '--link-modules', '--port', '39517']);
    ck('it finishes and says the leak check is clean', r.status === 0 && /leak check: clean/.test(r.stdout), r.stdout + r.stderr);
    const files = walk(out).filter((f) => !f.startsWith('node_modules/'));
    ck('a real copy was made (500+ files)', files.length > 500, files.length);
    ck('data/ is empty: nothing of the live data comes along', !files.some((f) => f.startsWith('data/')) );
    ck('no credentials, tokens, keys, tests, builds or APKs, and nothing from qb-settings except the sample bank file', !files.some((f) => /credential|token|gdrive|service-?account|^tests?\//i.test(f) || (/^qb-settings/.test(f) && f !== 'qb-settings/bank-accounts.json') || /\.(apk|keystore|jks)$/.test(f) || /^builds?\//.test(f)), files.filter((f) => /credential|token|gdrive|qb-settings/i.test(f)).join());
    {
        // Documents > Bank: trials get SAMPLE accounts written by make-trial, never the real qb-settings file
        const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'qb-settings', 'bank-accounts.json'), 'utf8'));
        const b = JSON.parse(fs.readFileSync(path.join(out, 'qb-settings', 'bank-accounts.json'), 'utf8'));
        const realNums = new Set(real.accounts.flatMap((a) => [a.accountNumber, a.wireRouting, a.achRouting, a.taxId]).filter(Boolean));
        ck('the Bank tab gets sample accounts only: every one marked sample, none of the real numbers', b.accounts.length === 2 && b.accounts.every((a) => a.source === 'sample') && !b.accounts.some((a) => [a.accountNumber, a.wireRouting, a.achRouting, a.taxId].some((n) => realNums.has(n))));
    }
    ck('the Android signing file (keystore.properties, with her passwords) is NOT in the copy', !files.some((f) => /keystore|\.jks$|\.pem$|\.p12$/i.test(f)), files.filter((f) => /keystore/i.test(f)).join());
    {   // belt and braces: no secret VALUE from the live repo's signing file or .env appears anywhere in the copy
        const secrets = [];
        for (const f of ['mobile-app/android/keystore.properties', '.env']) {
            const p = path.join(ROOT, f); if (!fs.existsSync(p)) continue;
            for (const l of fs.readFileSync(p, 'utf8').split('\n')) { const m = l.match(/^[A-Za-z_.]*(PASSWORD|Password|SECRET|KEY|TOKEN)[A-Za-z_.]*=(.{6,})$/); if (m && !/\.(json|jks|pem|p12|keystore)$|\/|^(true|false|\d+)$/i.test(m[2].trim())) secrets.push(m[2].trim()); }  // file names and flags are not secrets
        }
        const all = files.filter((f) => /\.(js|html|json|md|properties|gradle|xml|txt|sh)$/.test(f)).map((f) => fs.readFileSync(path.join(out, f), 'utf8')).join('\n');
        ck(`none of the ${secrets.length} secret values found in the live signing file / .env appears in the copy`, secrets.every((v) => !all.includes(v)));
    }
    const env = fs.readFileSync(path.join(out, '.env'), 'utf8');
    const pws = ['ADMIN', 'STAFF', 'APP'].map((k) => (env.match(new RegExp(k + '_PASSWORD=(.+)')) || [])[1]);
    ck('three different fresh passwords of 12+ characters', new Set(pws).size === 3 && pws.every((p) => p && p.length >= 12), pws.join());
    for (const rel of ['scripts/make-trial.js', 'scripts/trial-vm/provision.js']) {   // a password is only as strong as its SHORTEST output, so test the generator itself, not three samples
        const line = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n').find((l) => /const pw = \(\) =>/.test(l));
        const gen = line && new Function('crypto', line.replace(/^\s*const pw = /, 'return ').replace(/;\s*\/\/.*$/, ';'))(crypto);
        let min = 99, bad = 0; for (let i = 0; gen && i < 30000; i++) { const p = gen(); min = Math.min(min, p.length); if (!/^[A-Za-z0-9]+$/.test(p)) bad++; }
        ck(`${rel}: 30,000 generated passwords are all 14+ letters/digits (shortest ${min})`, !!gen && min >= 14 && bad === 0);
    }
    ck('the live repo\'s own passwords are not in the copy', !fs.existsSync(path.join(ROOT, '.env')) || !fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').some((l) => /PASSWORD=/.test(l) && env.includes(l.trim())));
    const text = files.filter((f) => /\.(js|html|json|md|css)$/.test(f)).map((f) => fs.readFileSync(path.join(out, f), 'utf8')).join('\n');
    for (const [label, re] of [['Edge Metals / Trading / Yard (any spelling)', /edge[ _-]?(metals?|trading|yard)/i], ['the owner\'s name', /apsara/i], ['edgemetals.com', /edgemetals/i], ['her Gmail', /apg0596/i], ['the carrier name', /zimex/i], ['her phone', /938[ -]?2525|8056944193/], ['the street address', /devonshire/i], ['EDGE_ ticket prefix', /\bEDGE_/]]) ck(`no ${label} anywhere in the copy`, !re.test(text));
    // Apsara 2026-11-19, "Remove outbound lound" -> chose trial copies + manual only.
    ck('the trial menu has no Outbound Loads (main app and standalone sidebar)', ['dashboard/app/01-core.js', 'dashboard/sidebar.js'].every((rel) => !/id: 'outbound-loads'/.test(fs.readFileSync(path.join(out, rel), 'utf8'))));
    ck('the live repo still has Outbound Loads in both menus', ['dashboard/app/01-core.js', 'dashboard/sidebar.js'].every((rel) => /id: 'outbound-loads'/.test(fs.readFileSync(path.join(ROOT, rel), 'utf8'))));
    // Apsara 2026-11-19: the trial is the yard app under the customer's own name, with a yard-only menu.
    {
        // 'audit' added 2026-11-20 — Apsara: every operation logged, "Yard first", "Manager only"; customer copies have
        // per-person logins, which is where knowing who changed what matters most.
        const TRIAL_IDS = ['loads', 'inventory', 'petty', 'trucker-bills', 'expenses', 'audit', 'documents', 'address-book', 'settings', 'users'];
        const ids = (rel, root) => [...fs.readFileSync(path.join(root, rel), 'utf8').matchAll(/^[ \t]*\{ id: '([a-z-]+)',/gm)].map((m) => m[1]);
        for (const rel of ['dashboard/app/01-core.js', 'dashboard/sidebar.js'])
            ck(`${rel}: the trial menu is exactly the yard pages (${TRIAL_IDS.length})`, JSON.stringify(ids(rel, out)) === JSON.stringify(TRIAL_IDS), ids(rel, out).join());
        for (const rel of ['dashboard/app/01-core.js', 'dashboard/sidebar.js'])
            ck(`${rel}: every trial menu item sits in the yard group, none behind a collapsed fold`, [...fs.readFileSync(path.join(out, rel), 'utf8').matchAll(/^[ \t]*\{ id: '[a-z-]+',[^\n]*group: '([^']*)'/gm)].every((m) => m[1] === 'Acme Scrap Yard'));
        ck('the trial menu has no Metals, Accounting, WhatsApp, Bookings or Facts page', ![ 'board', 'bookings', 'accounting', 'whatsapp', 'bot', 'facts', 'sales', 'bills', 'partners', 'claims', 'bugzilla' ].some((id) => ids('dashboard/app/01-core.js', out).includes(id)));
        ck('the live repo still has every one of those pages (nothing removed from the real app)', ['board', 'bookings', 'accounting', 'whatsapp', 'bot', 'facts'].every((id) => ids('dashboard/app/01-core.js', ROOT).includes(id)));
        const core = fs.readFileSync(path.join(out, 'dashboard/app/01-core.js'), 'utf8'), idx = fs.readFileSync(path.join(out, 'dashboard/index.html'), 'utf8'), api = fs.readFileSync(path.join(out, 'api.js'), 'utf8');
        ck('the app opens on Loads, not on the Metals board', /let CURRENT_TAB = 'loads';/.test(core) && /let CURRENT_TAB = 'board';/.test(fs.readFileSync(path.join(ROOT, 'dashboard/app/01-core.js'), 'utf8')));
        ck('the company switcher is hidden for everyone in the trial', !/ROLE === 'staff'\) \? 'none' : 'flex'/.test(core) && /box\.style\.display = 'none';/.test(core));
        ck('the WhatsApp-down banner and status dot are hidden by CSS', /#linkDownBanner,#waStatusDot,#waStatusText\{display:none !important\}/.test(idx));
        ck('sidebar, tab title and login page carry the customer\'s name, not Jarvis', />Acme Scrap<\/div>/.test(idx) && /<title>Acme Scrap yard<\/title>/.test(idx) && /<title>Acme Scrap — Sign in<\/title>/.test(api) && /brand-name">Acme Scrap</.test(api) && !/Metals ops/.test(idx));
        ck('the live login page and sidebar still say Jarvis', /brand-name">Jarvis</.test(fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8')) && />Jarvis<\/div>/.test(fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8')));
        const left = [];
        for (const f of files.filter((x) => /^dashboard\/.*\.(js|html)$/.test(x) && !/^dashboard\/(voice[^/]*|wake-model|orb)\.js$/.test(x)))
            fs.readFileSync(path.join(out, f), 'utf8').split('\n').forEach((ln, i) => { if (/\bJarvis\b/.test(ln) && !/wake|Listening for|Hey Jarvis|say ['"]?Jarvis/i.test(ln)) left.push(f + ':' + (i + 1)); });
        ck('no dashboard text says Jarvis (only the wake-word lines, which the microphone still answers to)', left.length === 0, left.slice(0, 4).join());
        {   // Settings: yard-only (Apsara 2026-11-19, "rewrite the settings to yard specific thing")
            const st = fs.readFileSync(path.join(out, 'dashboard/app/03-settings-contacts.js'), 'utf8');
            const fn = st.slice(st.indexOf('function renderSettings(s) {'), st.indexOf('// ── Item description catalog manager'));
            ck('trial Settings keeps the four yard sections', ['Load numbering', 'Item maintenance', 'Supplier and buyer names', 'Item description list'].every((t) => fn.includes('>' + t + '<')) && /Yard settings/.test(fn));
            ck('trial Settings has no WhatsApp, manager, team, email, 8 PM report or Scout fields', !/WhatsApp|s_manager|s_yard|internal_team|team-row|8:00 PM|gmail|Scout|s_email|accounts_contact|settingsTabOps|btnFindGroup/i.test(fn), (fn.match(/WhatsApp|s_manager|s_yard|internal_team|8:00 PM|gmail|Scout|s_email/i) || [''])[0]);
            ck('the Settings save sends only next_load_number (the route merges, so nothing else stored is touched)', /JSON\.stringify\(\{ next_load_number: v \? parseInt\(v, 10\) : null \}\)/.test(fn));
            ck('the live Settings page still has every one of those Edge controls', (() => { const l = fs.readFileSync(path.join(ROOT, 'dashboard/app/03-settings-contacts.js'), 'utf8'); return ['s_manager', 's_yard_emails', 'btnAddTeam', 'Manager WhatsApp number', 'What Scout has learned'].every((x) => l.includes(x)); })());
            const ids = [...fn.matchAll(/\$\('([A-Za-z_]+)'\)/g)].map((m) => m[1]);
            const defined = new Set([...fn.matchAll(/id="([A-Za-z_]+)"/g)].map((m) => m[1]));
            ck('every element the Settings code looks up exists in the trial page', ids.every((i) => defined.has(i) || ['viewRoot'].includes(i)), ids.filter((i) => !defined.has(i) && i !== 'viewRoot').join());
        }
        {   // the floating assistants (yard chat bubble, voice bar, orb) need an AI key a trial does not have
            const SC = ['voice-machine.js', 'voice-local.js', 'voice-server.js', 'oww-core.js', 'wake-model.js', 'turn-model.js', 'voice.js', 'orb.js', 'yard-bot.js'];
            ck('the trial page loads none of the assistant scripts (chat bubble, voice, orb)', SC.every((s) => !idx.includes(`src="${s}"`)));
            ck('the live dashboard page still loads all nine', SC.every((s) => fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8').includes(`src="${s}"`)));
            ck('no other trial page loads them either (so nothing can bring the widgets back)', files.filter((x) => /^dashboard\/[^/]*\.html$/.test(x) && x !== 'dashboard/index.html').every((x) => !SC.some((s) => fs.readFileSync(path.join(out, x), 'utf8').includes(`src="${s}"`) || fs.readFileSync(path.join(out, x), 'utf8').includes(`src="/${s}"`))));
        }
        ck('the wake word itself is untouched, so the screen never names a word the app does not answer to', /Jarvis/.test(fs.readFileSync(path.join(out, 'dashboard/voice.js'), 'utf8')));
    }
    ck('the customer\'s name is in it', /Acme Scrap Yard/.test(text) && /ACME_/.test(text));
    ck('the three companies stay three different names (code tells them apart)', new Set(['Acme Scrap Yard', 'Acme Scrap Trading', 'Acme Scrap Metals']).size === 3 && ['Acme Scrap Yard', 'Acme Scrap Trading', 'Acme Scrap Metals'].every((n) => text.includes(n)));
    ck('routes/helpers and routes/workflow links were kept (the code needs them)', fs.lstatSync(path.join(out, 'routes/helpers')).isSymbolicLink() && fs.lstatSync(path.join(out, 'routes/workflow')).isSymbolicLink());
    ck('the Edge inventory page became Yard inventory, file and links together', fs.existsSync(path.join(out, 'dashboard/yard-inventory.html')) && !fs.existsSync(path.join(out, 'dashboard/edge-inventory.html')));
    const again = make(['--name', 'Acme Scrap', '--slug', 'acme', '--out', out]);
    ck('it refuses to write over an existing trial', again.status === 1 && /already exists/.test(again.stderr));
    const inside = make(['--name', 'X', '--slug', 'x', '--out', path.join(ROOT, 'trial-inside')]);
    ck('it refuses a folder inside the live repo', inside.status === 1 && /OUTSIDE the live repo/.test(inside.stderr) && !fs.existsSync(path.join(ROOT, 'trial-inside')));
    ck('a name is required', make(['--slug', 'x', '--out', path.join(tmp, 'y')]).status === 1);

    section('B — the copy runs');
    const run = (cmd, args) => spawnSync('node', [cmd, ...args], { cwd: out, encoding: 'utf8', timeout: 90000 });
    const seed = run('trial-seed.js', []);
    ck('the demo data seeds (7 bought, 3 sold)', seed.status === 0 && /7 loads bought, 3 sold/.test(seed.stdout), seed.stdout + seed.stderr);
    ck('seeding twice is refused, so demo loads never pile up', run('trial-seed.js', []).status === 1);
    const srv = spawn('node', ['trial-server.js'], { cwd: out, stdio: 'ignore' });
    const PORT = 39517;
    const req = (m, p, body, sid) => new Promise((res) => { const d = body ? JSON.stringify(body) : null; const h = {}; if (d) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(d); } if (sid) h.Authorization = 'Bearer ' + sid; const q = http.request({ host: '127.0.0.1', port: PORT, path: p, method: m, headers: h }, (x) => { let raw = ''; x.on('data', (c) => raw += c); x.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} res({ status: x.statusCode, json: j, raw }); }); }); q.on('error', () => res({ status: 0 })); if (d) q.write(d); q.end(); });
    let up = false; for (let i = 0; i < 60 && !up; i++) { up = (await req('GET', '/api/health')).status > 0; if (!up) await new Promise((r2) => setTimeout(r2, 1000)); }
    ck('the API-only server starts', up);
    try {
        const admin = ((await req('POST', '/login', { password: pws[0] })).json || {}).sid;
        const staff = ((await req('POST', '/login', { password: pws[1] })).json || {}).sid;
        ck('its own admin and staff passwords log in; a wrong one does not', !!admin && !!staff && (await req('POST', '/login', { password: 'nope' })).status === 401);
        const l = (await req('GET', '/api/loads', null, admin)).json;
        const list = Array.isArray(l) ? l : (l || {}).loads || [];
        ck('the demo loads are served through the real route', list.length === 7, list.length);
        const made = await req('POST', '/api/loads', { date: '2026-11-18', seller: 'Trial Seller', buyer: 'Acme Scrap Trading', items: [{ description: 'Rotors', gross_weight: 1000, tare_weight: 0, price: 0.12, unit: 'lb' }] }, admin);
        ck('a new load takes the customer\'s ticket prefix (ACME_08), not Edge\'s', made.json && made.json.ok && /^ACME_08$/.test(made.json.load.id), made.raw);
        const stock = (await req('GET', '/api/loads/stock', null, admin)).json;
        ck('stock reads back: rotors bought 12,600 in the demo + the new 1,000, sold 6,000, so 7,600 on hand', ((stock.byType || []).find((x) => x.description === 'Rotors') || {}).onHand === 7600, JSON.stringify(stock).slice(0, 200));
        ck('staff are still kept out of the admin screens', (await req('GET', '/api/item-maintenance', null, staff)).status === 403);
        const im = (await req('GET', '/api/item-maintenance', null, admin)).json;
        ck('Item maintenance works, with the demo items already ferrous / non-ferrous', im.items.length >= 6 && im.items.some((i) => i.metal_type === 'ferrous') && im.items.some((i) => i.metal_type === 'non-ferrous'));
        const ob = await req('GET', '/api/outbound-loads', null, admin);
        ck('sales still load in the trial (the Loads page reads them from /api/outbound-loads)', ob.status === 200 && Array.isArray(ob.json), ob.status);
        {   // Settings, end to end: the route the page saves to and the route a new load's number comes from
            const put = await req('PUT', '/api/settings', { next_load_number: 500 }, admin);
            const after = await req('POST', '/api/loads', { date: '2026-11-18', seller: 'Settings Check', buyer: 'Acme Scrap Trading', items: [{ description: 'Rotors', gross_weight: 10, tare_weight: 0, price: 0.1, unit: 'lb' }] }, admin);
            ck('saving Load numbering through the Settings route sets the next ticket (ACME_500)', put.status === 200 && after.json && after.json.ok && after.json.load.id === 'ACME_500', put.raw + ' | ' + after.raw);
            const keep = (await req('GET', '/api/settings', null, admin)).json || {};
            ck('the smaller Settings save did not erase other stored settings', keep.next_load_number === 500 && 'manager_number' in keep, JSON.stringify(Object.keys(keep)));
            ck('staff cannot open or change Settings', (await req('PUT', '/api/settings', { next_load_number: 1 }, staff)).status === 403);
        }
        const lg = await req('GET', '/login', null, null);
        ck('the login page the customer sees (served by the running copy) says Acme Scrap and never Jarvis', lg.status === 200 && /Acme Scrap/.test(lg.raw) && !/Jarvis/.test(lg.raw), lg.raw.slice(0, 120));
        const page = await req('GET', '/', null, null);
        ck('the front page carries nothing of Edge', !/edge[ _-]?(metals?|trading|yard)/i.test(page.raw));
    } finally { srv.kill(); }
    ck('no WhatsApp, Gmail or scheduler code path is started (the server file never requires them)', !/whatsapp|scheduler|gmail/i.test(fs.readFileSync(path.join(out, 'trial-server.js'), 'utf8')));

    section('C — the live repo is untouched');
    for (const f of LIVE) ck(`${f} unchanged`, sha(f) === before[f]);
    ck('no trial folder was left inside the repo', !fs.existsSync(path.join(ROOT, 'trial-inside')) && !fs.existsSync(path.join(ROOT, 'trials')));

    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
