// ── tests/trial-users.js — user IDs, passwords and custom roles in a trial/product copy ───────────────────
// Apsara, 2026-11-19: "user id and password creation provision in website so that anyone can add and remove user, with
// role specific access". Scope she chose: trial/product copies only, managers only, custom roles.
//   A  the account store on its own (rules, hashing, guards)
//   B  END TO END: a real copy, a real server, real sign-ins, the routes the Users page and the other pages actually call
//   C  the live repo is untouched, and the copy's menu / login / page carry the feature
// Section B is the one that matters: the store can be right while the route does not forward a field, the session gate
// does not re-read the user, or a page the role holds is still shut by a manager-only route.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');
let pass = 0, fail = 0; const ck = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n); if (x) console.log('        ' + String(x).slice(0, 300)); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const ROOT = path.join(__dirname, '..');
const sha = (f) => crypto.createHash('sha1').update(fs.readFileSync(path.join(ROOT, f))).digest('hex');
const LIVE = ['api.js', 'config.js', 'routes/core.js', 'dashboard/sidebar.js', 'dashboard/app/01-core.js', 'dashboard/app/14-facts-boot.js', 'dashboard/index.html'];
const before = Object.fromEntries(LIVE.map((f) => [f, sha(f)]));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-users-'));

(async () => {
    section('A — the account store');
    process.env.YARD_USERS_FILE = path.join(tmp, 'unit-users.json');
    const UA = require('../scripts/trial-users/userAccounts.js');
    const bad = async (p, re) => { try { await p; return false; } catch (e) { return re.test(e.message) && e.status >= 400; } };
    ck('built-in roles are Manager and Yard staff; Manager is the only one that manages', UA.allRoles().filter((r) => r.builtin).map((r) => r.id).join() === 'manager,yard-staff' && UA.allRoles().filter((r) => r.manager).length === 1);
    ck('Yard staff is exactly what the old shared staff login had (Loads, Petty Cash, Trucker Bills)', JSON.stringify(UA.BUILTIN_ROLES[1].pages) === JSON.stringify(['loads', 'petty', 'trucker-bills']));
    ck('a custom role cannot be given Settings, Documents or Users (managers only)', ['settings', 'documents', 'users'].every((p) => { try { UA.createRole({ name: 'X' + p, pages: [p] }); return false; } catch (e) { return /Not a page/.test(e.message); } }));
    ck('a role needs a name of 2+ characters and at least one page', (() => { let n = 0; for (const a of [{ name: 'A', pages: ['loads'] }, { name: 'Okay', pages: [] }, { name: 'Okay', pages: 'loads' }]) { try { UA.createRole(a); } catch (e) { n++; } } return n === 3; })());
    const rl = UA.createRole({ name: 'Scale operator', pages: ['inventory', 'loads', 'loads'] });
    ck('a role keeps its pages in menu order with no duplicates', JSON.stringify(rl.pages) === JSON.stringify(['loads', 'inventory']));
    ck('role names are unique, ignoring case and the built-in names', ['scale OPERATOR', 'manager', 'Yard Staff'].every((n) => { try { UA.createRole({ name: n, pages: ['loads'] }); return false; } catch (e) { return /already exists/.test(e.message); } }));
    const m1 = await UA.createUser({ id: 'Sam', name: 'Sam M', password: 'correct-horse-1', roleId: 'manager' });
    ck('an ID is folded to lower case and stored; the user is a manager', m1.id === 'sam' && m1.manager === true);
    ck('the password is salted and hashed on disk, never stored as typed', (() => { const raw = fs.readFileSync(process.env.YARD_USERS_FILE, 'utf8'); return !raw.includes('correct-horse-1') && /"salt"/.test(raw) && /"hash"/.test(raw); })());
    ck('the users file is owner-only (mode 600)', (fs.statSync(process.env.YARD_USERS_FILE).mode & 0o777) === 0o600);
    await UA.createUser({ id: 'maria', name: 'Maria', password: 'another-pass-2', roleId: rl.id });
    await UA.createUser({ id: 'maria2', name: 'Maria B', password: 'another-pass-2', roleId: rl.id });
    ck('the right password signs in, a wrong one, an unknown ID and an empty one do not', (await UA.authenticate('maria', 'another-pass-2')).id === 'maria' && !(await UA.authenticate('maria', 'nope')) && !(await UA.authenticate('ghost', 'another-pass-2')) && !(await UA.authenticate('', '')));
    ck('IDs are case-insensitive at sign-in', (await UA.authenticate(' MARIA ', 'another-pass-2')).id === 'maria');
    ck('an ID that is taken, reserved, malformed or too short is refused', await bad(UA.createUser({ id: 'maria', name: 'x', password: 'another-pass-2', roleId: rl.id }), /taken/) && await bad(UA.createUser({ id: 'admin', name: 'x', password: 'another-pass-2', roleId: rl.id }), /reserved/) && await bad(UA.createUser({ id: 'jarvis', name: 'x', password: 'another-pass-2', roleId: rl.id }), /reserved/) && await bad(UA.createUser({ id: 'a b', name: 'x', password: 'another-pass-2', roleId: rl.id }), /User ID/) && await bad(UA.createUser({ id: 'ab', name: 'x', password: 'another-pass-2', roleId: rl.id }), /User ID/));
    ck('a short password, one equal to the ID, or an unknown role is refused', await bad(UA.createUser({ id: 'newbie', name: 'x', password: 'short', roleId: rl.id }), /8 characters/) && await bad(UA.createUser({ id: 'newbie2', name: 'x', password: 'newbie2', roleId: rl.id }), /8 characters|same as/) && await bad(UA.createUser({ id: 'newbie3', name: 'x', password: 'long-enough-1', roleId: 'nope' }), /role/i));
    ck('two sign-ups for the same ID at the same moment cannot both succeed', (await Promise.allSettled([UA.createUser({ id: 'racer', name: 'R', password: 'race-pass-123', roleId: rl.id }), UA.createUser({ id: 'racer', name: 'R', password: 'race-pass-456', roleId: rl.id })])).filter((r) => r.status === 'fulfilled').length === 1 && UA.listUsers().filter((u) => u.id === 'racer').length === 1);
    ck('a role in use cannot be deleted; built-in roles cannot be edited or deleted', (() => { let n = 0; for (const f of [() => UA.deleteRole(rl.id), () => UA.deleteRole('manager'), () => UA.updateRole('yard-staff', { name: 'Z', pages: ['loads'] })]) { try { f(); } catch (e) { n++; } } return n === 3; })());
    ck('only the matching pages open the matching paths', UA.allowedPath(['loads'], '/api/loads/ABC') && UA.allowedPath(['loads'], '/api/me') && !UA.allowedPath(['loads'], '/api/petty-cash') && !UA.allowedPath(['loads'], '/api/loadsX') && !UA.allowedPath([], '/api/loads') && UA.allowedPath(['inventory'], '/api/loads/inventory') && !UA.allowedPath(['inventory'], '/api/loads'));
    ck('only Expenses is let through the manager-only gate, and only on its own paths', UA.adminGrant(['expenses'], '/api/expenses/suggest-vendor') && !UA.adminGrant(['expenses'], '/api/settings') && !UA.adminGrant(['loads'], '/api/expenses') && !UA.adminGrant(['petty'], '/api/petty-cash'));
    ck('a restart keeps everyone (the file is read back)', (() => { UA.reset(); return UA.listUsers().length === 4 && UA.allRoles().some((r) => r.name === 'Scale operator'); })());
    {   // an unreadable file is kept aside, never overwritten silently
        const f = path.join(tmp, 'broken-users.json'); fs.writeFileSync(f, '{not json'); process.env.YARD_USERS_FILE = f;
        const U2 = (() => { delete require.cache[require.resolve('../scripts/trial-users/userAccounts.js')]; return require('../scripts/trial-users/userAccounts.js'); })();
        const quiet = console.error; console.error = () => {}; const n = U2.listUsers().length; console.error = quiet;
        ck('an unreadable users file is copied aside and the store starts empty, not overwritten', n === 0 && fs.readdirSync(tmp).some((x) => x.startsWith('broken-users.json.unreadable-')));
    }

    section('B — a real copy, a real server, the real routes');
    delete process.env.YARD_USERS_FILE;      // the unit section pointed the store at a temp file; the server must use its OWN data folder
    const out = path.join(tmp, 'acme'), PORT = 39547;
    const mk = spawnSync('node', [path.join(ROOT, 'scripts/make-trial.js'), '--name', 'Acme Scrap', '--slug', 'acme', '--out', out, '--link-modules', '--port', String(PORT)], { encoding: 'utf8', timeout: 120000 });
    ck('the copy builds with the accounts in it and the leak check clean', mk.status === 0 && /leak check: clean/.test(mk.stdout), mk.stdout + mk.stderr);
    const env = fs.readFileSync(path.join(out, '.env'), 'utf8'); const pw = (k) => (env.match(new RegExp(k + '_PASSWORD=(.+)')) || [])[1];
    const run = (cmd) => spawnSync('node', [cmd], { cwd: out, encoding: 'utf8', timeout: 90000 });
    ck('the demo data seeds', run('trial-seed.js').status === 0);
    const req = (m, p, body, sid) => new Promise((res) => { const d = body ? JSON.stringify(body) : null; const h = {}; if (d) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(d); } if (sid) h.Authorization = 'Bearer ' + sid; const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method: m, headers: h }, (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) { /* not json */ } res({ status: x.statusCode, json: j, raw: b }); }); }); r.on('error', () => res({ status: 0, json: null, raw: '' })); if (d) r.write(d); r.end(); });
    let srv = null;
    const start = async () => { srv = spawn('node', ['trial-server.js'], { cwd: out, stdio: 'ignore' }); for (let i = 0; i < 60; i++) { if ((await req('GET', '/api/health')).status > 0) return true; await new Promise((r2) => setTimeout(r2, 1000)); } return false; };
    const stop = () => new Promise((r2) => { if (!srv) return r2(); srv.once('exit', r2); srv.kill(); });
    ck('the server starts', await start());
    try {
        const login = async (userId, password) => (await req('POST', '/login', userId === null ? { password } : { userId, password }));
        const sidOf = (r) => (r.json || {}).sid;
        // the owner passwords, exactly as before
        const owner = sidOf(await login(null, pw('ADMIN'))), oldStaff = sidOf(await login(null, pw('STAFF')));
        ck('the owner passwords still sign in with no user ID (admin and staff roles unchanged)', !!owner && !!oldStaff && (await req('GET', '/api/me', null, owner)).json.role === 'admin' && (await req('GET', '/api/me', null, oldStaff)).json.role === 'staff');
        ck('the old shared staff login keeps its old limits (petty cash yes, expenses no)', (await req('GET', '/api/petty-cash', null, oldStaff)).status === 200 && (await req('GET', '/api/expenses', null, oldStaff)).status === 403);
        ck('a wrong owner password still fails', (await login(null, 'nope')).status === 401);
        ck('before anyone exists the Users routes need a manager', (await req('GET', '/api/users')).status === 401 && (await req('GET', '/api/users', null, oldStaff)).status === 403);

        // the owner builds a role and three people through the routes the Users page calls
        const list0 = await req('GET', '/api/users', null, owner);
        ck('the Users list route returns roles and the pages a role can be given (no Settings, Documents or Users)', list0.status === 200 && list0.json.roles.length === 2 && JSON.stringify(list0.json.pages.map((p) => p.id)) === JSON.stringify(['loads', 'inventory', 'petty', 'trucker-bills', 'expenses', 'address-book']), list0.raw);
        const rScale = await req('POST', '/api/roles', { name: 'Scale operator', pages: ['loads', 'inventory'] }, owner);
        const rBook = await req('POST', '/api/roles', { name: 'Bookkeeper', pages: ['expenses'] }, owner);
        ck('the owner can create custom roles', rScale.status === 200 && rBook.status === 200 && rScale.json.role.pages.join() === 'loads,inventory', rScale.raw);
        ck('a role with settings in it is refused through the route too', (await req('POST', '/api/roles', { name: 'Sneaky', pages: ['loads', 'settings'] }, owner)).status === 400);
        const mk1 = (id, role, p) => req('POST', '/api/users', { id, name: id.toUpperCase(), roleId: role, password: p || 'pass-word-123' }, owner);
        ck('the owner can add a manager, a yard-staff user and two custom-role users', [(await mk1('boss', 'manager')).status, (await mk1('ravi', 'yard-staff')).status, (await mk1('maria', rScale.json.role.id)).status, (await mk1('bina', rBook.json.role.id)).status].every((s) => s === 200));
        ck('the password is not in any list response', !(await req('GET', '/api/users', null, owner)).raw.includes('pass-word-123'));
        ck('a duplicate ID through the route is a 409', (await mk1('maria', 'yard-staff')).status === 409);

        const S = {};
        for (const u of ['boss', 'ravi', 'maria', 'bina']) S[u] = sidOf(await login(u, 'pass-word-123'));
        ck('all four sign in with user ID and password', Object.values(S).every(Boolean));
        ck('a wrong password and an unknown ID give the same 401 and the same words (no hint which was wrong)', (() => true)() && await (async () => { const a = await login('maria', 'wrong-wrong-1'), b = await login('nobody', 'wrong-wrong-1'); return a.status === 401 && b.status === 401 && a.json.error === b.json.error; })());
        const me = (u) => req('GET', '/api/me', null, S[u]);
        ck('/api/me names the user and, for a custom role, its pages; managers get no page list (they see everything)', (await me('maria')).json.userId === 'maria' && (await me('maria')).json.pages.join() === 'loads,inventory' && (await me('maria')).json.roleName === 'Scale operator' && (await me('boss')).json.pages === null && (await me('boss')).json.role === 'admin' && (await me('maria')).json.role === 'staff');

        // enforcement: the property that matters
        const st = async (u, m, p, b) => (await req(m, p, b || null, S[u])).status;
        ck('maria (Loads + Inventory): loads, drafts, sales, stock and the address book work', (await Promise.all(['/api/loads', '/api/load-drafts', '/api/outbound-loads', '/api/loads/inventory', '/api/address-book', '/api/item-types'].map((p) => st('maria', 'GET', p)))).every((s) => s === 200));
        ck('maria cannot open petty cash, trucker bills, expenses, settings, users, payments or documents', (await Promise.all(['/api/petty-cash', '/api/trucker-bills', '/api/expenses', '/api/settings', '/api/users', '/api/roles', '/api/documents/saved', '/api/item-maintenance'].map((p) => st('maria', 'GET', p)))).every((s) => s === 403));
        ck('maria cannot pay anyone or record money (payments is manager-only)', (await st('maria', 'POST', '/api/payments', { amount: 1 })) === 403 && (await st('maria', 'POST', '/api/petty-cash', { amount: 5 })) === 403);
        ck('maria cannot create users or roles or reset a password', (await st('maria', 'POST', '/api/users', { id: 'x1x', name: 'x', roleId: 'manager', password: 'long-enough-1' })) === 403 && (await st('maria', 'POST', '/api/roles', { name: 'Evil', pages: ['loads'] })) === 403 && (await st('maria', 'PUT', '/api/users/ravi', { password: 'taken-over-123' })) === 403 && (await st('maria', 'GET', '/users')) === 403);
        const made = await req('POST', '/api/loads', { date: '2026-11-18', seller: 'S', buyer: 'Acme Scrap Trading', items: [{ description: 'Rotors', gross_weight: 100, tare_weight: 0, price: 0.1, unit: 'lb' }] }, S.maria);
        ck('maria can actually record a load (the page she holds works end to end)', made.status === 200 && made.json && made.json.ok, made.raw);
        ck('ravi (Yard staff) has exactly the old staff access: loads, petty cash view, trucker bills; not expenses, not settings, not petty-cash changes', (await st('ravi', 'GET', '/api/loads')) === 200 && (await st('ravi', 'GET', '/api/petty-cash')) === 200 && (await st('ravi', 'GET', '/api/trucker-bills')) === 200 && (await st('ravi', 'GET', '/api/expenses')) === 403 && (await st('ravi', 'GET', '/api/settings')) === 403 && (await st('ravi', 'POST', '/api/petty-cash', { amount: 5 })) === 403);
        ck('bina (Expenses only): the expenses routes work through the manager-only gate, and nothing else does', (await st('bina', 'GET', '/api/expenses')) === 200 && (await st('bina', 'GET', '/api/loads')) === 403 && (await st('bina', 'GET', '/api/settings')) === 403 && (await st('bina', 'GET', '/api/item-maintenance')) === 403 && (await st('bina', 'GET', '/api/petty-cash')) === 403 && (await st('bina', 'POST', '/api/payments', { amount: 1 })) === 403);
        ck('boss (Manager) can open everything the owner can: settings, users, expenses, the Users page', (await st('boss', 'GET', '/api/settings')) === 200 && (await st('boss', 'GET', '/api/users')) === 200 && (await st('boss', 'GET', '/api/expenses')) === 200 && (await st('boss', 'GET', '/users')) === 200);
        ck('the Users page itself is served to a manager and refused to everyone else', (await req('GET', '/users', null, S.boss)).raw.includes('Users and roles') && (await st('ravi', 'GET', '/users')) === 403);

        // changes apply on the next click
        ck('adding Petty Cash to a role takes effect on the person\'s very next request, no new sign-in', (await st('maria', 'GET', '/api/petty-cash')) === 403 && (await req('PUT', '/api/roles/' + rScale.json.role.id, { pages: ['loads', 'inventory', 'petty'] }, S.boss)).status === 200 && (await st('maria', 'GET', '/api/petty-cash')) === 200);
        ck('moving a person to another role changes their access at once', (await st('ravi', 'GET', '/api/trucker-bills')) === 200 && (await req('PUT', '/api/users/ravi', { roleId: rScale.json.role.id }, S.boss)).status === 200 && (await st('ravi', 'GET', '/api/trucker-bills')) === 403 && (await st('ravi', 'GET', '/api/loads/inventory')) === 200);
        ck('a manager demoted by another manager loses manager powers at once', (await req('PUT', '/api/users/boss', { roleId: 'yard-staff' }, owner)).status === 200 && (await st('boss', 'GET', '/api/users')) === 403 && (await req('PUT', '/api/users/boss', { roleId: 'manager' }, owner)).status === 200 && (await st('boss', 'GET', '/api/users')) === 200);
        ck('a password reset signs that person out at once and the old password stops working', (await req('PUT', '/api/users/bina', { password: 'brand-new-pass-9' }, S.boss)).status === 200 && (await st('bina', 'GET', '/api/expenses')) === 401 && (await login('bina', 'pass-word-123')).status === 401);
        await new Promise((r2) => setTimeout(r2, 15));
        S.bina = sidOf(await login('bina', 'brand-new-pass-9'));
        ck('and the new password works', !!S.bina && (await st('bina', 'GET', '/api/expenses')) === 200);
        ck('removing a person signs them out on their next click, and they cannot sign back in', (await req('DELETE', '/api/users/bina', null, S.boss)).status === 200 && (await st('bina', 'GET', '/api/expenses')) === 401 && (await login('bina', 'brand-new-pass-9')).status === 401);
        ck('a person cannot remove themselves or change their own role', (await req('DELETE', '/api/users/boss', null, S.boss)).status === 400 && (await req('PUT', '/api/users/boss', { roleId: 'yard-staff' }, S.boss)).status === 400 && (await st('boss', 'GET', '/api/users')) === 200);
        ck('a role that people hold cannot be deleted; an empty one can', (await req('DELETE', '/api/roles/' + rScale.json.role.id, null, owner)).status === 400 && (await req('DELETE', '/api/roles/' + rBook.json.role.id, null, owner)).status === 200);
        ck('built-in roles cannot be edited or deleted through the routes', (await req('PUT', '/api/roles/manager', { name: 'Boss' }, owner)).status === 400 && (await req('DELETE', '/api/roles/yard-staff', null, owner)).status === 400);

        // changing your own password
        const own = await req('POST', '/api/me/password', { current: 'wrong-current-1', next: 'my-new-password-1' }, S.maria);
        ck('changing your own password needs the current one', own.status === 403);
        ck('changing your own password works, signs you out, and the new one signs in', (await req('POST', '/api/me/password', { current: 'pass-word-123', next: 'my-new-password-1' }, S.maria)).status === 200 && (await st('maria', 'GET', '/api/loads')) === 401 && !!sidOf(await login('maria', 'my-new-password-1')) );
        ck('the owner password has no account to change, and says so', (await req('POST', '/api/me/password', { current: 'x', next: 'long-enough-1' }, owner)).status === 400);
        ck('a weak new password is refused', (await req('PUT', '/api/users/ravi', { password: 'short' }, owner)).status === 400);

        // persistence across a restart
        const usersFile = path.join(out, 'data', 'users.json');
        ck('the users file is in the copy\'s data folder, owner-only, with no plain passwords', fs.existsSync(usersFile) && (fs.statSync(usersFile).mode & 0o777) === 0o600 && !/pass-word-123|my-new-password-1|brand-new-pass-9/.test(fs.readFileSync(usersFile, 'utf8')), fs.existsSync(usersFile) ? ('mode ' + (fs.statSync(usersFile).mode & 0o777).toString(8) + ' plain=' + (fs.readFileSync(usersFile, 'utf8').match(/pass-word-123|my-new-password-1|brand-new-pass-9/) || ['none'])[0]) : 'no file at ' + usersFile);
        await stop(); ck('the server restarts', await start());
        ck('after a restart sessions are gone but every account still works', (await st('boss', 'GET', '/api/users')) === 401 && !!sidOf(await login('maria', 'my-new-password-1')) && !!sidOf(await login('boss', 'pass-word-123')));
        ck('the old owner passwords still sign in after the restart', !!sidOf(await login(null, pw('ADMIN'))));
    } finally { await stop(); }

    section('C — the live repo is untouched; the copy carries the feature');
    for (const f of LIVE) ck(`${f} unchanged`, sha(f) === before[f]);
    ck('the live app has no user-accounts code anywhere (api.js, routes, helpers)', !/userAccounts|userLogin|userPages/.test(fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8')) && !fs.existsSync(path.join(ROOT, 'routes/users.js')) && !fs.existsSync(path.join(ROOT, 'helpers/userAccounts.js')) && !fs.existsSync(path.join(ROOT, 'dashboard/users.html')));
    ck('the live login page has no User ID field', !/id="uid"/.test(fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8')));
    const cp = (f) => fs.readFileSync(path.join(out, f), 'utf8');
    ck('the copy\'s login page has the User ID field and tells owners to leave it empty', /id="uid"/.test(cp('api.js')) && /Leave the user ID empty/.test(cp('api.js')) && /userId: document\.getElementById\('uid'\)\.value/.test(cp('api.js')));
    ck('Users is in the copy\'s menu (both menu lists), manager-only, and links to its page', ['dashboard/app/01-core.js', 'dashboard/sidebar.js'].every((f) => /\{ id: 'users', label: 'Users', group: 'Acme Scrap Yard', adminOnly: true \}/.test(cp(f))) && /users: '\/users'/.test(cp('dashboard/sidebar.js')) && /dataset\.tab === 'users'\) \{ window\.location\.href = '\/users'/.test(cp('dashboard/app/01-core.js')));
    ck('the menu filter in the app and the standalone sidebar both use a custom role\'s page list', /PAGES \? PAGES\.includes\(n\.id\)/.test(cp('dashboard/app/01-core.js')) && /pg \? pg\.includes\(n\.id\)/.test(cp('dashboard/sidebar.js')) && /window\.__jvPages = Array\.isArray\(m\.pages\)/.test(cp('dashboard/sidebar.js')));
    ck('the standalone pages no longer show the company switcher or the "Metals ops" subtitle', !/Metals ops/.test(cp('dashboard/sidebar.js')) && /<div id="jvCompany" style="display:none;">/.test(cp('dashboard/sidebar.js')));
    ck('the Users page escapes everything it prints and has no alert/prompt/confirm dialogs', /const esc = /.test(cp('dashboard/users.html')) && !/\b(alert|confirm|prompt)\(/.test(cp('dashboard/users.html')));

    console.log(`\n${pass} passed, ${fail} failed`); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
