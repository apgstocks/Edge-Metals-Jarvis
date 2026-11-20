#!/usr/bin/env node
// ── scripts/make-trial.js — a plug-and-play TRIAL copy of the yard app ──────
//
// Apsara, 2026-11-18: "what if i want to demo it to other customers as a trial ... can you create a plug and play
// version". Answers she gave: yard app only (no Gmail / WhatsApp / QuickBooks / Drive); one hosted copy per
// customer; branding applied "in the copy only" so the live Edge Metals code is never touched.
//
// WHAT THIS DOES — it only ever READS this repo and WRITES a new folder:
//   1. copies an ALLOWLIST of files (never data/, qb-settings/, tests/, builds/, node_modules/, anything with a token)
//   2. rewrites Edge's names, emails, phone numbers and address to the customer's, in text AND in file names
//   3. writes a fresh .env with new random passwords, trial-server.js (API only: no WhatsApp, no scheduler)
//   4. SCANS the result for anything of Edge's and exits non-zero if it finds some, so a leak cannot ship quietly
//
// USAGE  node scripts/make-trial.js --name "Acme Scrap" --slug acme [--out ../trials/acme] [--port 3101]
//             [--email owner@acme.example] [--phone "(555) 010-0100"] [--link-modules]
//             [--lang en|es]    the language this customer's screens start in (people can still switch; default en)
// then   cd ../trials/acme && npm install && node trial-seed.js && node trial-server.js
//
// KNOWN LIMITS (said plainly): comments are rewritten, not removed, so the wording of Edge's own notes stays in the
// copy with the names swapped out; the phone app's JavaScript is readable by anyone holding the APK.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const flag = (k) => process.argv.includes('--' + k);

// ── what is copied (an allowlist: a new file is NOT included until someone adds it here) ──
const INCLUDE = ['api.js', 'config.js', 'package.json', 'package-lock.json', 'helpers', 'routes', 'dashboard', 'workflow', 'seeds', 'assets', 'alerts.js', 'scheduler.js', 'mobile-app'];
// Even inside an included folder these never come along.
const SKIP = [/(^|\/)node_modules(\/|$)/, /(^|\/)\.git(\/|$)/, /(^|\/)data(\/|$)/, /(^|\/)qb-settings(\/|$)/, /(^|\/)tests?(\/|$)/, /(^|\/)builds?(\/|$)/,
    /(^|\/)outputs?(\/|$)/, /(^|\/)_to_delete(\/|$)/, /mobile-app\/ios(\/|$)/, /android\/(\.gradle(\/|$)|build(\/|$)|app\/build(\/|$)|local\.properties$)/, /\.apk$/, /\.keystore$|\.jks$/,
    /(^|\/)\.env/, /credentials|token|service-?account|gdrive-sa|keystore|\.jks|\.pem|\.p12|google-services|secret/i, /\.(log|lock)$/, /mutate-restore/, /(^|\/)\.DS_Store$/];
const TEXT = /\.(js|html|json|css|md|txt|webmanifest|xml|gradle|properties|svg|sh|yml|yaml|java|kt|kts|pro)$/i;

function brandOf(name) {
    const B = name == null ? '' : String(name).trim();
    if (!B) throw new Error('--name is required, e.g. --name "Acme Scrap"');
    return B;
}

// ── the rewrite, ordered: longest and most specific first ──
function buildRules({ B, slug, email, phone }) {
    const dom = `${slug}.example`;
    const C = B.replace(/[^A-Za-z0-9]/g, '');                 // "Acme Scrap" -> "AcmeScrap"
    const U = slug.replace(/-/g, '_');
    // keep the original's capital style: ALL CAPS stays caps, all lower stays lower, anything else takes the built form
    const keep = (m, built) => (m === m.toUpperCase() ? built.toUpperCase() : m === m.toLowerCase() ? built.toLowerCase() : built);
    const word = { yard: 'Yard', trading: 'Trading', metal: 'Metals', metals: 'Metals' };
    return [
        // private contact details
        { re: /apg0596@gmail\.com/gi, to: `owner@${dom}` },
        { re: /export@zimexglt\.com/gi, to: 'export@carrier.example' },
        { re: /\bapsara@edgemetals\.com/gi, to: email },
        { re: /\bbose@[a-z0-9.-]+/gi, to: `ops@${dom}` },
        { re: /@edgemetals\.com/gi, to: `@${dom}` },
        { re: /edgemetals\.com/gi, to: dom },
        { re: /radmetals\.[a-z]+/gi, to: dom },
        { re: /\+?1?[ -]?\(?310\)?[ -]?938[ -]?2525/g, to: phone },
        { re: /\b938[ -]?2525\b/g, to: '010-0100' },
        { re: /\b1?[ -]?8056944193\b|\b1 80569 44193\b|\b918056944193\b/g, to: '15550100100' },
        { re: /\b2098848345\b|\b3010354116\b|\b3010355035\b/g, to: '5550100101' },
        { re: /14750 Devonshire Ln/gi, to: '100 Main Street' },
        { re: /Frisco, TX 75035/gi, to: 'Anytown, TX 75000' },
        { re: /\bFrisco\b/gi, to: 'Anytown' },
        // the three companies, each kept DISTINCT (the code tells them apart), in every spelling: "Edge Yard", EdgeYard, edge_yard, EDGE-METALS
        { re: /edge([ _-]?)(yard|trading|metals?)/gi, fn: (m, sep, w) => {
            const W = word[w.toLowerCase()];
            const built = sep === ' ' ? `${B} ${W}` : sep === '_' ? `${U}_${W.toLowerCase()}` : sep === '-' ? `${slug}-${W.toLowerCase()}` : `${C}${W}`;
            return keep(m, built);
        } },
        // load-ticket prefix (EDGE_01) and its constants, and the "Edge inventory" feature
        { re: /\bEDGE_/g, to: `${B.split(/\s+/)[0].replace(/[^A-Za-z0-9]/g, '').toUpperCase()}_` },
        { re: /\bedge(?=[ _-]?inventory)/gi, fn: (m) => (m === 'Edge' ? 'Yard' : m === 'EDGE' ? 'YARD' : 'yard') },
        // bare "Edge" meaning the company, in notes ("what Edge paid", "Edge's books"); "edge case" and "left edge" are left alone
        { re: /(?<!Chrome\/|Safari, |Microsoft )\bEdge\b(?! cases?\b)/g, to: B.split(/\s+/)[0] },
        { re: /\bEDGE\b/g, to: B.split(/\s+/)[0].toUpperCase() },
        { re: /AAA[ _-]?Investments?/gi, fn: (m) => keep(m, `${B} Holdings`) },
        // Still visible on the yard screens after the menu was cut down (found 2026-11-19 by building a copy and
        // grepping what a customer can open): the short "AAA" on Petty cash's split button, her two banks in the
        // pay / petty cash / expense boxes, a supplier's first name in the assistant's examples, and her carrier on
        // Documents > Verification. Rewritten everywhere at once so code that compares a bank name to a stored one
        // still agrees with itself; the sample bank file uses the same two sample names.
        { re: /\bAAA\b/g, to: 'Holdings' },
        { re: /Chase Bank/g, to: 'Example Community Bank' },
        { re: /\bChase\b/g, to: 'Example Community Bank' },
        { re: /\bBofA\b/g, to: 'Sample National Bank' },
        { re: /\bInesh\b/g, to: 'Riverside' },
        { re: /EAGLE TRANS(PORT)?/g, to: 'SAMPLE CARRIER' },
        { re: /Eagle Trans(port)?/g, to: 'Sample Carrier' },
        { re: /eagle ?brit/gi, fn: (m) => keep(m, 'SampleCarrier') },
        // Her customers' and broker's names in the Documents page's example text and the Verification tab's buttons
        // (found 2026-11-20 while photographing the manual). Whole words, display spellings only, so identifiers such as
        // extractJoeyCommissionInvoice keep working.
        { re: /\btaewon\b/gi, fn: (m) => keep(m, 'Harborco') },   // one word: it is also a key in code (TAEWON, taewon)
        { re: /\bRad Metal\b/g, to: 'Sample Metal' },
        { re: /\bPan Metal\b/g, to: 'Sample Broker' },
        { re: /\bJoey\b/g, to: 'Broker' },
        { re: /\bEccomelt\b/gi, to: 'Buyerco' },
        // people and customers named in comments, defaults and fixtures
        { re: /\bapsara\b/gi, fn: (m) => (m === 'Apsara' ? 'the owner' : keep(m, 'owner')) },
        { re: /\bbose\b/gi, fn: (m) => keep(m, 'ops') },
        { re: /zimex(glt)?/gi, fn: (m) => keep(m, 'carrier') },
        { re: /metalco/gi, fn: (m) => keep(m, 'Metalworks') },
        { re: /daekwang/gi, fn: (m) => keep(m, 'Buyerco') },
        { re: /\bramesh\b/gi, fn: (m) => keep(m, 'Sam') },
        { re: /radmetals/gi, fn: (m) => keep(m, slug) },
    ];
}
const apply = (s, rules) => rules.reduce((t, r) => t.replace(r.re, r.fn || r.to), s);

const LINKS = [];   // relative symlinks inside the repo (routes/helpers -> ../helpers). Recreated, not followed.
function walk(dir, rel = '') {
    const out = [];
    for (const name of fs.readdirSync(path.join(dir, rel))) {
        const r = rel ? `${rel}/${name}` : name;
        if (SKIP.some((re) => re.test(r))) continue;
        const st = fs.lstatSync(path.join(dir, r));
        if (st.isSymbolicLink()) {
            const target = fs.readlinkSync(path.join(dir, r));
            const inside = !path.isAbsolute(target) && path.resolve(path.dirname(path.join(dir, r)), target).startsWith(ROOT + path.sep);
            if (inside && dir === ROOT) LINKS.push({ rel: r, target });
            continue;                                   // never follow one: a link out of the repo could pull in anything
        }
        if (st.isDirectory()) out.push(...walk(dir, r)); else out.push(r);
    }
    return out;
}

// What must NOT be in the output. A hit is a leak, so the script fails.
const FORBIDDEN = [
    /edge ?(metals?|trading|yard)/i, /edgemetals/i, /apsara/i, /\bbose@/i, /apg0596/i, /zimex/i, /metalco/i, /daekwang/i,
    /(?<!Chrome\/|Safari, |Microsoft )\bEdge\b(?! cases?\b)/, /\bEDGE\b/, /938[ -]?2525/, /8056944193/, /devonshire/i, /\bfrisco\b/i, /radmetals/i,
    /\bAAA\b/, /\bBofA\b/, /\bChase\b/, /\bInesh\b/, /eagle ?trans|eagle ?brit/i,
    /\btaewon\b/i, /\bRad Metal\b/, /\bPan Metal\b/, /\bJoey\b/, /\beccomelt\b/i,
];

function main() {
    const B = brandOf(arg('name'));
    const slug = String(arg('slug', B.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))).replace(/[^a-z0-9-]/g, '');
    if (!slug) throw new Error('--slug could not be worked out');
    const out = path.resolve(arg('out', path.join(ROOT, '..', 'trials', slug)));
    if (out === ROOT || out.startsWith(ROOT + path.sep)) throw new Error('the trial folder must be OUTSIDE the live repo (' + ROOT + ')');
    if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`${out} already exists and is not empty; pick a new --out or remove it first`);
    const email = arg('email', `owner@${slug}.example`);
    const phone = arg('phone', '(555) 010-0100');
    const port = Number(arg('port', 3100 + Math.floor(Math.random() * 800)));
    const rules = buildRules({ B, slug, email, phone });

    fs.mkdirSync(out, { recursive: true });
    const copied = [];
    for (const top of INCLUDE) {
        const p = path.join(ROOT, top);
        if (!fs.existsSync(p)) continue;
        const files = fs.lstatSync(p).isDirectory() ? walk(ROOT, top) : [top];
        for (const rel of files) {
            if (SKIP.some((re) => re.test(rel))) continue;
            const to = path.join(out, apply(rel, rules));       // file names too: a renamed token must still resolve
            fs.mkdirSync(path.dirname(to), { recursive: true });
            if (TEXT.test(rel)) fs.writeFileSync(to, apply(fs.readFileSync(path.join(ROOT, rel), 'utf8'), rules));
            else fs.copyFileSync(path.join(ROOT, rel), to);
            copied.push(rel);
        }
    }

    for (const l of LINKS) {                                  // routes/helpers -> ../helpers, as in the live repo
        const to = path.join(out, apply(l.rel, rules));
        if (!fs.existsSync(to)) fs.symlinkSync(l.target, to);
    }

    // ── WHAT A TRIAL CUSTOMER SEES: the yard app, under the customer's name ─────────────────────────────────
    // Apsara, 2026-11-19: "Remove outbound lound" (trial copies + manual only), then, on seeing the trial's own menu:
    // yard pages + Documents + Address Book + Settings. Everything here edits the COPY after it is written, never the
    // live repo. Each edit throws if its target moved, so a later change to the menu or login page cannot quietly put
    // a Metals page, the Jarvis name or the WhatsApp banner back in front of a customer.
    //
    // NOT included, said plainly: WhatsApp (needs a phone linked per customer; the trial server has no WhatsApp client)
    // and Accounting (the QuickBooks / bank portal is built for the three Edge companies and has nothing to show
    // without them). The menu entries are removed; the routes and data stay, because the Loads page reads Sales from
    // /api/outbound-loads and other pages call shared routes.
    const TRIAL_MENU = ['loads', 'inventory', 'petty', 'trucker-bills', 'expenses', 'documents', 'address-book', 'settings', 'audit'];   // audit: 2026-11-20, every change logged, manager only
    const YARD_GROUP = apply('Edge Yard', rules);                    // the group name as it reads in the copy
    for (const rel of ['dashboard/app/01-core.js', 'dashboard/sidebar.js']) {
        const f = path.join(out, apply(rel, rules));
        let src = fs.readFileSync(f, 'utf8');
        const ids = [...src.matchAll(/^[ \t]*\{ id: '([a-z-]+)',[^\n]*\n/gm)].map((m) => m[1]);
        for (const id of TRIAL_MENU) if (!ids.includes(id)) throw new Error(`make-trial: menu entry '${id}' not found in ${rel}; update the trial menu list`);
        for (const id of ids) {
            if (TRIAL_MENU.includes(id)) continue;
            const re = new RegExp(`^[ \\t]*\\{ id: '${id}',[^\\n]*\\n`, 'm');
            src = src.replace(re, '');
        }
        // the pages that lived under other headings now sit with the yard pages. Settings too: its old heading, System,
        // is a collapsed fold, and a customer with eight menu items should not have to know to open one to find it.
        for (const id of ['documents', 'address-book', 'settings']) {
            const re = new RegExp(`(\\{ id: '${id}',[^\\n]*?group: )'[^']*'`);
            if (!re.test(src)) throw new Error(`make-trial: group of '${id}' not found in ${rel}`);
            src = src.replace(re, `$1'${YARD_GROUP}'`);
        }
        {   // Users: managers only (adminOnly), a standalone page like Address Book. Added after Settings.
            const m = src.match(/^([ \t]*)\{ id: 'settings',[^\n]*\n/m);
            if (!m) throw new Error(`make-trial: Settings entry not found in ${rel} to place Users after`);
            src = src.replace(m[0], () => m[0] + `${m[1]}{ id: 'users', label: 'Users', group: '${YARD_GROUP}', adminOnly: true },\n`);
        }
        const left = [...src.matchAll(/^[ \t]*\{ id: '([a-z-]+)',/gm)].map((m) => m[1]);
        if (left.length !== TRIAL_MENU.length + 1) throw new Error(`make-trial: ${rel} still lists ${left.join(',')}`);
        fs.writeFileSync(f, src);
    }
    const patch = (rel, pairs) => {                                  // exact, single-occurrence edits, or throw
        const f = path.join(out, apply(rel, rules)); let t = fs.readFileSync(f, 'utf8');
        for (const [from, to, what] of pairs) {
            if (t.split(from).length !== 2) throw new Error(`make-trial: ${what} not found exactly once in ${rel}; update the trial patch`);
            t = t.replace(from, () => to);
        }
        fs.writeFileSync(f, t);
    };
    const MARK = B.split(/\s+/)[0].slice(0, 1).toUpperCase();
    // Documents > Bank told the reader to edit a server file and deploy: true for the owner, meaningless to a customer.
    patch('dashboard/documents.html', [
        [`+ '<br>To change any of this, edit <span style="font-family:var(--font-mono);">qb-settings/bank-accounts.json</span> and deploy. It is deliberately not editable from this screen.';`,
         `+ '<br>These are sample details. To put your own bank details here, contact us.';`, 'bank tab footnote'],
    ]);
    patch('dashboard/app/01-core.js', [
        ["let CURRENT_TAB = 'board';", "let CURRENT_TAB = 'loads';", 'default tab'],
        ["box.style.display = (ROLE === 'staff') ? 'none' : 'flex';", "box.style.display = 'none';", 'company switcher'],
    ]);
    patch('dashboard/index.html', [
        ['>Jarvis</div>', `>${B}</div>`, 'sidebar brand'],
        [`>${B} Metals ops<`, '>Yard management<', 'sidebar subtitle'],
        ['</head>', '<style>#linkDownBanner,#waStatusDot,#waStatusText{display:none !important}</style>\n</head>', 'head end'],
    ]);
    {   // browser tab title
        const f = path.join(out, 'dashboard/index.html'); const t = fs.readFileSync(f, 'utf8');
        const m = t.match(/<title>[^<]*<\/title>/); if (!m) throw new Error('make-trial: dashboard title not found');
        fs.writeFileSync(f, t.replace(m[0], `<title>${B} yard</title>`));
    }
    // ── SETTINGS, AS A YARD PRODUCT (Apsara 2026-11-19: "rewrite the settings to yard specific thing") ────────────
    // The live Settings page is mostly Edge's WhatsApp / Gmail / team-routing setup plus a 8:00 PM report that needs the
    // scheduler, which a trial does not run. Left in, a customer would be shown switches that do nothing. The trial
    // copy keeps only what a yard can really use here: load numbering, item maintenance, supplier and buyer names,
    // and the item description list. Cut from the copy only; /api/settings is unchanged and still merges, so saving
    // the smaller page cannot erase any other stored setting.
    {
        const f = path.join(out, 'dashboard/app/03-settings-contacts.js'); let t = fs.readFileSync(f, 'utf8');
        const need = (i, what) => { if (i < 0) throw new Error(`make-trial: Settings ${what} not found; update the trial Settings rewrite`); return i; };
        const fnStart = need(t.indexOf('function renderSettings(s) {'), 'function start');
        const fnEnd = need(t.indexOf('// ── Item description catalog manager'), 'function end');
        const body = t.slice(fnStart, fnEnd);
        const cardAt = (title) => need(body.lastIndexOf('<div class="card"', need(body.indexOf('>' + title + '<'), `card "${title}"`)), `card "${title}"`);
        const numStart = cardAt('Load numbering'), scoutStart = cardAt('What Scout has learned');
        const itemsStart = cardAt('Item maintenance');
        const itemsEnd = need(body.indexOf('\n      </div>\n    </section>`;', itemsStart), 'closing of the cards');
        const tailStart = need(body.indexOf('  loadItemTypeRows();'), 'item list loader');
        if (!(numStart < scoutStart && scoutStart < itemsStart && itemsStart < itemsEnd && itemsEnd < tailStart)) throw new Error('make-trial: Settings sections are in a different order; update the trial Settings rewrite');
        const loadNum = body.slice(numStart, scoutStart), items = body.slice(itemsStart, itemsEnd);
        if (body.slice(tailStart).split('  renderScoutLessons();\n').length !== 2) throw new Error('make-trial: renderScoutLessons() call not found exactly once in Settings');
        const tail = body.slice(tailStart).replace('  renderScoutLessons();\n', '');   // Scout is the WhatsApp-side assistant; no panel for it in a trial
        if (/s_yard|s_manager|btnAddTeam|groupSearch/.test(loadNum + items + tail)) throw new Error('make-trial: kept Settings sections still reference WhatsApp/team fields');
        const rewritten = `function renderSettings(s) {
  $('viewRoot').innerHTML = \`
    <section style="max-width:820px; margin:0 auto; padding:38px 40px 80px;">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:22px;">
        <div><div class="eyebrow">// Settings</div><h2 style="font-size:24px; text-transform:uppercase;">Yard settings</h2></div>
        <button id="btnSaveSettings" class="btn btn-primary">Save changes</button>
      </div>
      <div id="settingsError" style="color:var(--status-danger); font-size:12.5px; margin-bottom:14px; display:none;"></div>
      <div id="settingsSaved" style="color:var(--leaf-600); font-size:12.5px; margin-bottom:14px; display:none;">Saved.</div>
      <div style="display:flex; flex-direction:column; gap:16px;">
        \${loadNum.trim()}
        \${items.trim()}
      </div>
    </section>\`;

  $('btnSaveSettings').addEventListener('click', async () => {
    $('settingsError').style.display = 'none'; $('settingsSaved').style.display = 'none';
    try {
      const v = $('s_next_load_number').value.trim();
      await api('/api/settings', { method: 'PUT', body: JSON.stringify({ next_load_number: v ? parseInt(v, 10) : null }) });
      $('settingsSaved').style.display = 'block';
    } catch (e) { $('settingsError').textContent = e.message; $('settingsError').style.display = 'block'; }
  });

\${tail}`;
        const literal = rewritten.replace(/\$\{loadNum\.trim\(\)\}/, () => loadNum.trim()).replace(/\$\{items\.trim\(\)\}/, () => items.trim()).replace(/\\\$\{tail\}/, () => tail).replace(/\$\{tail\}$/, () => tail);
        fs.writeFileSync(f, t.slice(0, fnStart) + literal + t.slice(fnEnd));
    }

    // ── THE FLOATING ASSISTANTS ARE LEFT OUT OF A TRIAL ──────────────────────────────────────────────────────
    // The yard chat helper, the voice bar and the orb all call the AI service, and a trial copy has no key for it (and
    // should not carry hers). Left in, a customer taps the bubble and gets an error, or sees the "Jarvis" voice assistant
    // of someone else's product. Taken out by removing their <script> tags from the copy's dashboard page; nothing else
    // loads them (checked: only index.html). Each tag must be there exactly once, or the build stops.
    for (const src of ['voice-machine.js', 'voice-local.js', 'voice-server.js', 'oww-core.js', 'wake-model.js', 'turn-model.js', 'voice.js', 'orb.js', 'yard-bot.js']) {
        const tag = `  <script src="${src}"></script>\n`;
        patch('dashboard/index.html', [[tag, '', `assistant script ${src}`]]);
    }
    // ── USER ACCOUNTS AND ROLES (Apsara 2026-11-19: "user id and password creation provision in website so that anyone can
    // add and remove user, with role specific access"; scope chosen: trial/product copies only; managers only; custom roles) ──
    // Everything lives in scripts/trial-users/ and is written INTO THE COPY. The live app's api.js, login and three
    // shared passwords are not touched, so no Edge path can be changed by this. Each patch below is exact and throws if
    // the line it targets has moved. Owner passwords (ADMIN/STAFF/APP) keep signing in exactly as before; a user ID
    // adds a second way in. A Manager user gets the same session role as the owner password ('admin'); every other role
    // is a 'staff' session with a page list that the server checks on every request (helpers/userAccounts.js).
    {
        const UDIR = path.join(__dirname, 'trial-users');
        for (const [from, to] of [['userAccounts.js', 'helpers/userAccounts.js'], ['users-routes.js', 'routes/users.js'], ['users.html', 'dashboard/users.html']]) {
            fs.mkdirSync(path.dirname(path.join(out, to)), { recursive: true });
            fs.copyFileSync(path.join(UDIR, from), path.join(out, to));
        }
        patch('api.js', [
            ["    sessions.set(sid, { issued: Date.now(), ip, role, super: !!opts.super });",
             "    sessions.set(sid, { issued: Date.now(), ip, role, super: !!opts.super, userId: opts.userId || null });", 'issueSession'],
            ["function createApi() {",
             `// Y.A.R.D. copy: sign in with a user ID (helpers/userAccounts.js). The owner passwords never come through here.
async function userLogin(req, res, uid, pw) {
    const ip = String(req.ip || 'unknown');
    let u = null;
    try { u = await require('./helpers/userAccounts').authenticate(uid, pw); } catch (e) { return res.status(500).json({ error: 'sign-in unavailable' }); }
    if (!u) {
        const n = (failedLogins.get(ip) || 0) + 1; failedLogins.set(ip, n);
        if (n === 5 || n === 20 || (n > 20 && n % 50 === 0)) console.warn('[AUTH] ' + n + ' failed sign-ins from ' + ip + '. Nothing is being blocked.');
        return res.status(401).json({ error: 'wrong user ID or password' });
    }
    failedLogins.delete(ip);
    const role = u.manager ? 'admin' : 'staff';
    const sid = issueSession(req.ip, role, { userId: u.id });
    res.setHeader('Set-Cookie', 'sid=' + sid + '; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=' + (SESSION_TTL_MS / 1000));
    res.json({ ok: true, role, super: false, profile: role, sid, userId: u.id, pages: u.manager ? null : u.pages });
}

function createApi() {`, 'userLogin'],
            ["    app.post('/login', (req, res) => {\n        const pw = String(req.body?.password || '');",
             "    app.post('/login', async (req, res) => {\n        const pw = String(req.body?.password || '');\n        const uid = String(req.body?.userId || '').trim().toLowerCase();\n        if (uid) return userLogin(req, res, uid, pw);", 'login handler'],
            ["        if (session) { req.role = session.role; req.isSuper = !!session.super; return next(); }",
             `        if (session && session.userId) {
            // a user's session is re-read from the account on EVERY request: remove them or change their role and it
            // applies on their next click (no stale session to revoke)
            const cur = require('./helpers/userAccounts').current(session.userId);
            if (!cur || session.issued < cur.pwAt) { session = null; }   // gone, or the password changed after this sign-in
            else { req.userId = cur.id; req.userPages = cur.manager ? null : cur.pages; req.role = cur.manager ? 'admin' : 'staff'; req.isSuper = false; return next(); }
        }
        if (session) { req.role = session.role; req.isSuper = !!session.super; return next(); }`, 'session gate'],
            ["        const allowed = STAFF_ALLOWED_PATH_PREFIXES.some(p => req.path === p || req.path.startsWith(p + '/'));",
             "        const allowed = req.userId ? require('./helpers/userAccounts').allowedPath(req.userPages || [], req.path)\n            : STAFF_ALLOWED_PATH_PREFIXES.some(p => req.path === p || req.path.startsWith(p + '/'));", 'staff allowlist'],
            ["        return res.status(403).json({ error: 'staff access is limited to Loads' });",
             "        return res.status(403).json({ error: req.userId ? 'Your role does not include this.' : 'staff access is limited to Loads' });", 'staff 403'],
            ["        if (req.role === 'admin') return next();\n        return res.status(403).json({ error: 'admin access required' });",
             "        if (req.role === 'admin') return next();\n        if (req.userId && require('./helpers/userAccounts').adminGrant(req.userPages || [], req.path)) return next();   // a page the role was given whose routes are manager-only (Expenses)\n        return res.status(403).json({ error: 'admin access required' });", 'requireAdmin'],
            ["    const actorOf = (req) => (isSuper(req) ? 'jarvis' : (req.role || 'unknown'));",
             "    const actorOf = (req) => (isSuper(req) ? 'jarvis' : (req.userId || req.role || 'unknown'));   // a signed-in user is named in the audit log", 'actorOf'],
            ["    Object.assign(ctx, require('./routes/pages')(app, ctx)); // @@part",
             "    Object.assign(ctx, require('./routes/users')(app, ctx));   // Y.A.R.D. copy: user and role management\n    Object.assign(ctx, require('./routes/pages')(app, ctx)); // @@part", 'route mount'],
            ['    <label for="pw">Password</label>',
             '    <label for="uid">User ID</label>\n    <input id="uid" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" autofocus>\n    <p style="margin:8px 0 18px;font-size:12px">Using the owner password? Leave the user ID empty.</p>\n    <label for="pw">Password</label>', 'login user id field'],
            ['<input id="pw" type="password" autocomplete="current-password" required autofocus>', '<input id="pw" type="password" autocomplete="current-password" required>', 'login autofocus'],
            ["body: JSON.stringify({ password: document.getElementById('pw').value })", "body: JSON.stringify({ userId: document.getElementById('uid').value, password: document.getElementById('pw').value })", 'login body'],
            ["e.textContent = r.status === 500 ? 'Server not configured.' : 'Wrong password.';", "e.textContent = r.status === 500 ? 'Server not configured.' : 'Wrong user ID or password.';", 'login error'],
        ]);
        patch('routes/core.js', [
            ["        profile: isSuper(req) ? 'jarvis' : (req.role || 'user'),\n    }));",
             "        profile: isSuper(req) ? 'jarvis' : (req.role || 'user'),\n        userId: req.userId || null,\n        pages: req.userId && req.userPages ? req.userPages : null,\n        roleName: req.userId ? ((require('../helpers/userAccounts').current(req.userId) || {}).roleName || null) : null,\n        language: req.userId ? ((require('../helpers/userAccounts').current(req.userId) || {}).lang || null) : null,\n    }));", '/api/me'],
        ]);
        patch('dashboard/app/01-core.js', [
            ["let CURRENT_TAB = 'loads';", "let CURRENT_TAB = 'loads';\nlet PAGES = null, USER_ID = null, ROLE_NAME = null;   // a custom role's page list (null for everyone else)", 'pages globals'],
            ["  const visible = NAV_ITEMS.filter(n => (!n.adminOnly || ROLE === 'admin')\n    && (ROLE !== 'staff' || n.id === 'loads' || n.id === 'petty' || n.id === 'trucker-bills'));",
             "  const visible = NAV_ITEMS.filter(n => PAGES ? PAGES.includes(n.id) : ((!n.adminOnly || ROLE === 'admin')\n    && (ROLE !== 'staff' || n.id === 'loads' || n.id === 'petty' || n.id === 'trucker-bills')));", 'nav filter'],
            ["    if (b.dataset.tab === 'address-book') { window.location.href = '/address-book'; return; }",
             "    if (b.dataset.tab === 'address-book') { window.location.href = '/address-book'; return; }\n    if (b.dataset.tab === 'users') { window.location.href = '/users'; return; }", 'users link'],
        ]);
        patch('dashboard/app/14-facts-boot.js', [
            ["IS_SUPER = me.super === true; } catch {}", "IS_SUPER = me.super === true; PAGES = Array.isArray(me.pages) ? me.pages : null; USER_ID = me.userId || null; ROLE_NAME = me.roleName || null; } catch {}", 'boot me'],
            ["  if (ROLE === 'staff') CURRENT_TAB = 'loads';",
             "  if (USER_ID) $('roleLabel').textContent = USER_ID + ' \\u00b7 ' + (ROLE_NAME || (ROLE === 'admin' ? 'Manager' : 'Signed in'));\n  if (ROLE === 'staff') CURRENT_TAB = (PAGES ? ((NAV_ITEMS.find((n) => PAGES.includes(n.id)) || {}).id || 'loads') : 'loads');\n  if (CURRENT_TAB === 'address-book') { window.location.href = '/address-book'; return; }   // a role that holds only this page", 'boot first tab'],
            ["    const allowed = want && NAV_ITEMS.some((n) => n.id === want && (!n.adminOnly || ROLE === 'admin')\n      && (ROLE !== 'staff' || n.id === 'loads' || n.id === 'petty' || n.id === 'trucker-bills'));",
             "    const allowed = want && NAV_ITEMS.some((n) => n.id === want && (PAGES ? PAGES.includes(n.id) : ((!n.adminOnly || ROLE === 'admin')\n      && (ROLE !== 'staff' || n.id === 'loads' || n.id === 'petty' || n.id === 'trucker-bills'))));", 'boot hash filter'],
        ]);
        patch('dashboard/sidebar.js', [
            ["    const v = NAV_ITEMS.filter((n) => (!n.adminOnly || role === 'admin') && (role !== 'staff' || STAFF_TABS.includes(n.id)));",
             "    const pg = (typeof window !== 'undefined' && Array.isArray(window.__jvPages)) ? window.__jvPages : null;\n    const v = NAV_ITEMS.filter((n) => pg ? pg.includes(n.id) : ((!n.adminOnly || role === 'admin') && (role !== 'staff' || STAFF_TABS.includes(n.id))));", 'sidebar filter'],
            ["      .then((m) => { if (m) render(m.role || 'user', !!m.super); })",
             "      .then((m) => { if (m) { window.__jvPages = Array.isArray(m.pages) ? m.pages : null; render(m.role || 'user', !!m.super); } })", 'sidebar me'],
            ["    documents: '/documents', 'yard-inventory': '/yard-inventory',", "    documents: '/documents', 'yard-inventory': '/yard-inventory', users: '/users',", 'sidebar href'],
            [`<div class="jv-sub">${B} Metals ops</div>`, '<div class="jv-sub">Yard management</div>', 'sidebar subtitle'],
            ["<div id=\"jvCompany\"${role === 'staff' ? ' style=\"display:none;\"' : ''}>", "<div id=\"jvCompany\" style=\"display:none;\">", 'sidebar company switcher'],
        ]);
    }

    // ── SCREEN LANGUAGE (Apsara 2026-11-19: Spanish switch ships in trial copies; "while doing initial one-time setup I will
    // do the default language, but they can change it anytime, user by user") ──
    // The switch itself is dashboard/yard-lang.js, her own work, copied as it is. Three small additions, all to the COPY:
    //   * a customer default, set here (--lang) or by trial-provision --lang, kept in ONE small file,
    //     dashboard/yard-lang-default.js. Edit that file to change a customer's default later; no rebuild.
    //   * a person with a user ID gets their own choice saved on their account (users.json) and sees it on every device;
    //     someone who has not chosen yet starts in the customer default, NOT in whatever the last person on that browser chose.
    //   * the three owner passwords have no account, so for them it stays a per-browser choice (as the live app has it).
    // The live yard-lang.js is not modified: English remains the live default and nothing in Edge's app changes.
    const LANG = arg('lang', 'en');
    if (LANG !== 'en' && LANG !== 'es') throw new Error('--lang must be en or es');
    fs.writeFileSync(path.join(out, 'dashboard', 'yard-lang-default.js'),
        `// This customer's starting screen language: 'en' or 'es'. People can still switch (the EN / ES buttons, top right).\nwindow.YARD_DEFAULT_LANG = '${LANG}';\n`);
    patch('dashboard/index.html', [['  <script src="yard-lang.js"></script>', '  <script src="yard-lang-default.js"></script>\n  <script src="yard-lang.js"></script>', 'default language script']]);
    patch('dashboard/yard-lang.js', [
        ["  try { lang = localStorage.getItem(KEY) === 'es' ? 'es' : 'en'; } catch (e) { /* storage blocked: English */ }",
         "  var DEFAULT = window.YARD_DEFAULT_LANG === 'es' ? 'es' : 'en';     // this customer's starting language (yard-lang-default.js)\n  var ACCOUNT = false;                                               // true once /api/me says this is a person with their own account\n  lang = DEFAULT;\n  try { var saved = localStorage.getItem(KEY); if (saved === 'es' || saved === 'en') lang = saved; } catch (e) { /* storage blocked: the customer default */ }",
         'language default'],
        ["  function setLang(code) {\n    lang = code === 'es' ? 'es' : 'en';\n    try { localStorage.setItem(KEY, lang); } catch (e) { /* not remembered, still switches */ }",
         "  function setLang(code, fromAccount) {\n    lang = code === 'es' ? 'es' : 'en';\n    try { localStorage.setItem(KEY, lang); } catch (e) { /* not remembered, still switches */ }\n    if (ACCOUNT && !fromAccount) { try { fetch('/api/me/language', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language: lang }) }).catch(function () {}); } catch (e) { /* the choice still holds in this browser */ } }",
         'language save'],
        ["  function start() {\n    paintToggle();\n",
         "  // A person with their own account: their saved language wins; with none saved they start in the customer default.\n  function syncAccount() {\n    try {\n      fetch('/api/me', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (me) {\n        if (!me || !me.userId) return;                 // owner password, or not signed in: this browser's own choice stands\n        ACCOUNT = true;\n        var want = me.language === 'es' || me.language === 'en' ? me.language : DEFAULT;\n        if (want !== lang) setLang(want, true);\n      }).catch(function () {});\n    } catch (e) { /* no fetch: the browser's own choice stands */ }\n  }\n\n  function start() {\n    paintToggle();\n    syncAccount();\n",
         'language account sync'],
    ]);

    // The sign-in page is its own page (api.js), signed-out, and never loaded the switch: a Spanish customer's staff would
    // meet English first. In the COPY only: the one-line default file is served before sign-in, and the sign-in page
    // shows its few words in the browser's choice, else the customer default. (Signed in, the person's own choice applies.)
    patch('api.js', [
        ["    // ── Session gate on everything else",
         "    // Public, deliberately: one line naming this customer's starting language, so the sign-in page can use it.\n    app.get('/yard-lang-default.js', (req, res) => res.type('application/javascript').sendFile(require('path').join(__dirname, 'dashboard', 'yard-lang-default.js')));\n\n    // ── Session gate on everything else", 'public default language'],
        ["<script>\ndocument.getElementById('f').addEventListener('submit', async (ev) => {",
         "<script src=\"/yard-lang-default.js\"></script>\n<script>\nvar T = (function () {\n  var l = 'en';\n  try { l = localStorage.getItem('yard_ui_lang') || window.YARD_DEFAULT_LANG || 'en'; } catch (e) { l = window.YARD_DEFAULT_LANG || 'en'; }\n  var ES = { 'Sign in': 'Iniciar sesión', 'Internal access only.': 'Solo acceso interno.', 'User ID': 'ID de usuario', 'Password': 'Contraseña',\n    'Using the owner password? Leave the user ID empty.': 'Si usa la contraseña del propietario, deje el ID de usuario vacío.', 'Signing in…': 'Entrando…',\n    'Wrong user ID or password.': 'ID de usuario o contraseña incorrectos.', 'Server not configured.': 'Servidor no configurado.', 'Network error.': 'Error de red.' };\n  var f = function (s) { return l === 'es' && ES[s] ? ES[s] : s; };\n  if (l === 'es') { document.documentElement.setAttribute('lang', 'es'); [].forEach.call(document.querySelectorAll('h1,p,label,button'), function (n) { var t = n.textContent.trim(); if (ES[t]) n.textContent = ES[t]; }); }\n  return f;\n})();\n</script>\n<script>\ndocument.getElementById('f').addEventListener('submit', async (ev) => {", 'login language script'],
        ["b.textContent = 'Signing in…';", "b.textContent = T('Signing in…');", 'login signing in'],
        ["e.textContent = r.status === 500 ? 'Server not configured.' : 'Wrong user ID or password.';", "e.textContent = r.status === 500 ? T('Server not configured.') : T('Wrong user ID or password.');", 'login error text'],
        ["catch { e.textContent = 'Network error.'; e.classList.add('on'); }", "catch { e.textContent = T('Network error.'); e.classList.add('on'); }", 'login network error'],
        ["b.disabled = false; b.textContent = 'Sign in';", "b.disabled = false; b.textContent = T('Sign in');", 'login button reset'],
    ]);

    // Visible product name in the dashboard's own text (toasts, hints, labels). The voice engine and the wake word are
    // left alone: the microphone still listens for "Jarvis", so any line that talks about the wake word keeps its text,
    // otherwise the screen would tell a customer to say a word the app does not answer to. Whole word only, so
    // identifiers such as JarvisLocalRecognition are untouched.
    const KEEP_FILE = /^dashboard\/(voice[^/]*|wake-model|orb)\.js$/, KEEP_LINE = /wake|Listening for|Hey Jarvis|say ['"]?Jarvis/i;
    const renamed = [];
    (function walkDash(rel) {
        for (const n of fs.readdirSync(path.join(out, rel))) {
            const r = rel + '/' + n, p = path.join(out, r), st = fs.lstatSync(p);
            if (st.isDirectory()) { if (n !== 'node_modules') walkDash(r); continue; }
            if (!/\.(js|html)$/.test(n) || KEEP_FILE.test(r)) continue;
            const t = fs.readFileSync(p, 'utf8'); if (!/\bJarvis\b/.test(t)) continue;
            const u = t.split('\n').map((l) => (KEEP_LINE.test(l) ? l : l.replace(/\bJarvis\b/g, B))).join('\n');
            if (u !== t) { fs.writeFileSync(p, u); renamed.push(r); }
        }
    })('dashboard');
    patch('api.js', [
        ['<title>Jarvis — Sign in</title>', `<title>${B} — Sign in</title>`, 'login title'],
        ['<div class="brand-mark">J</div><div class="brand-name">Jarvis</div>', `<div class="brand-mark">${MARK}</div><div class="brand-name">${B}</div>`, 'login brand'],
    ]);

    try { fs.chmodSync(path.join(out, 'mobile-app/android/gradlew'), 0o755); } catch (e) { /* no android project */ }

    // fresh credentials, never reused from anywhere
    const pw = () => { let s = ''; while (s.length < 12) s += crypto.randomBytes(12).toString('base64').replace(/[^a-zA-Z0-9]/g, ''); return s.slice(0, 12) + crypto.randomInt(10, 99); }; // always 12 letters/digits + 2 digits (stripping + and / used to leave some under 12)
    const creds = { admin: pw(), staff: pw(), user: pw() };
    fs.writeFileSync(path.join(out, '.env'), [
        `ADMIN_PASSWORD=${creds.admin}`, `STAFF_PASSWORD=${creds.staff}`, `APP_PASSWORD=${creds.user}`,
        `API_PORT=${port}`, `DATA_DIR=${path.join(out, 'data')}`, 'TRIAL=1', '',
    ].join('\n'));
    fs.mkdirSync(path.join(out, 'data'), { recursive: true });
    // FAKE bank details for the Documents > Bank tab. The real qb-settings/ is never copied (SKIP), so without
    // this the tab showed a file-not-found error. Numbers are obviously sample values, not real accounts.
    fs.mkdirSync(path.join(out, 'qb-settings'), { recursive: true });
    fs.writeFileSync(path.join(out, 'qb-settings', 'bank-accounts.json'), JSON.stringify({
        note: 'SAMPLE bank details for a trial copy. Replace with your own before giving them to a customer.',
        accounts: [
            { id: 'trading-sample', company: `${B} Trading`, address: '100 Main Street, Anytown, TX 75000', bank: 'Sample National Bank', bankAddress: '1 Bank Plaza, Anytown, TX 75000', accountNumber: '000123456789', wireRouting: '000000001', achRouting: '000000002', swift: 'SMPLUS33', taxId: '00-0000000', source: 'sample' },
            { id: 'metals-sample', company: `${B} Metals`, address: '100 Main Street, Anytown, TX 75000', bank: 'Example Community Bank', bankAddress: '200 Market Street, Anytown, TX 75000', accountNumber: '000987654321', wireRouting: '000000003', achRouting: '000000004', swift: 'EXMPUS44', taxId: '00-0000001', source: 'sample' },
        ],
    }, null, 2));

    // API only: no WhatsApp client, no scheduler, no Gmail, no QuickBooks, no Drive
    fs.writeFileSync(path.join(out, 'trial-server.js'), `// ${B} trial: the yard app's API and dashboard only.
const fs = require('fs'), path = require('path');
for (const l of (fs.existsSync(path.join(__dirname, '.env')) ? fs.readFileSync(path.join(__dirname, '.env'), 'utf8') : '').split('\\n')) {
    const m = l.match(/^([A-Z_]+)=(.*)$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}
const cfg = require('./config');
require('./trial-contacts')(cfg);   // truckers/suppliers in data/, not Supabase (must run before api.js loads the routes)
const { createApi } = require('./api');
createApi().listen(cfg.API_PORT, () => console.log('[TRIAL] ${B} yard app on :' + cfg.API_PORT));
`);
    fs.copyFileSync(path.join(__dirname, 'trial-seed.js'), path.join(out, 'trial-seed.js'));
    fs.copyFileSync(path.join(__dirname, 'trial-contacts.js'), path.join(out, 'trial-contacts.js'));

    if (flag('link-modules') && fs.existsSync(path.join(ROOT, 'node_modules'))) fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(out, 'node_modules'), 'dir');

    fs.writeFileSync(path.join(out, 'TRIAL-README.md'), `# ${B} — trial

Start:   npm install && node trial-seed.js && node trial-server.js   (then open http://<server>:${port})
Logins:  manager (everything)  ${creds.admin}
         staff (loads only)    ${creds.staff}
         team                  ${creds.user}
People:   sign in with the manager password, open Users, and give each person their own user ID, password and role.
         They sign in with the user ID; the three passwords above are used with the User ID left empty.
Switch off: stop the process. Reset the demo: delete the data/ folder (this also removes the people you added), run node trial-seed.js again.
Language: screens start in ${LANG === 'es' ? 'Spanish' : 'English'}. Change the starting language by editing dashboard/yard-lang-default.js ('en' or 'es').
         Each person with a user ID can switch with the EN / ES buttons top right; it is saved on their account and follows them to any device.
Not included: WhatsApp, Gmail, QuickBooks, Google Drive.
`);

    // ── the scan ──
    const hits = [];
    for (const rel of walk(out)) {
        if (!TEXT.test(rel) && !/\.(png|jpg)$/.test(rel)) { /* binary: names only */ }
        for (const f of FORBIDDEN) if (f.test(rel)) hits.push(`${rel} (file name) ~ ${f}`);
        if (!TEXT.test(rel)) continue;
        const text = fs.readFileSync(path.join(out, rel), 'utf8');
        for (const f of FORBIDDEN) { const m = text.match(f); if (m) hits.push(`${rel} ~ ${f} "${m[0]}"`); }
    }
    const LEFT = [];
    (function scan(rel) {
        for (const n of fs.readdirSync(path.join(out, rel))) {
            const r = rel + '/' + n, p = path.join(out, r), st = fs.lstatSync(p);
            if (st.isDirectory()) { if (n !== 'node_modules') scan(r); continue; }
            if (!/\.(js|html)$/.test(n) || KEEP_FILE.test(r)) continue;
            fs.readFileSync(p, 'utf8').split('\n').forEach((l, i) => { if (/\bJarvis\b/.test(l) && !KEEP_LINE.test(l)) LEFT.push(`${r}:${i + 1}`); });
        }
    })('dashboard');
    if (LEFT.length) hits.push(`the dashboard still says Jarvis on ${LEFT.length} line(s), e.g. ${LEFT.slice(0, 3).join(', ')}`);
    const CHROME = [['dashboard/index.html', /<script src="(voice|orb|yard-bot|oww-core|wake-model|turn-model)[a-z-]*\\.js"/], ['dashboard/index.html', /<div[^>]*>Jarvis<\/div>|<title>[^<]*Jarvis/i], ['api.js', /brand-name">Jarvis</], ['dashboard/sidebar.js', /id: '(board|bookings|accounting|whatsapp|bot)'/], ['dashboard/app/01-core.js', /id: '(board|bookings|accounting|whatsapp|bot)'/]];
    for (const [rel, re] of CHROME) { const f = path.join(out, rel); if (fs.existsSync(f) && re.test(fs.readFileSync(f, 'utf8'))) hits.push(`${rel} still shows the original product chrome ~ ${re}`); }
    console.log(`[trial] ${copied.length} files -> ${out}`);
    console.log(`[trial] logins: admin ${creds.admin} / staff ${creds.staff} / team ${creds.user}   port ${port}`);
    if (hits.length) {
        console.error(`[trial] LEAK CHECK FAILED: ${hits.length} place(s) still carry something of the original business:`);
        hits.slice(0, 40).forEach((h) => console.error('   ' + h));
        process.exit(2);
    }
    console.log('[trial] leak check: clean');
}
try { main(); } catch (e) { console.error('[trial] ' + e.message); process.exit(1); }
