// ── tests/known-issues.js ───────────────────────────────────────────────────
// Apsara, 2026-10-12: "if that issue happens again it would be better if the
// agent remembers it so that it doesn't have to perform the same investigation
// from scratch." Decided: Bugzilla is the memory; it advises, never acts.
//
//   A  matching: resolved + fix note only, ids ignored, unrelated stays quiet
//   B  a new report attaches what worked last time; nothing is applied
//   C  the auto-filed crash path gets it too; a "fixed" that recurs is flagged
//   D  END TO END: real server — file, fix, file again, see the memory; /similar
//   E  wiring: the tab shows it, the CLI finds it, CLAUDE.md tells us to look
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http');
const { spawnSync } = require('child_process');
const R = (p) => path.join(__dirname, '..', p);
let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');
const fresh = (prefix) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    process.env.DATA_DIR = dir; process.env.JARVIS_TEST = '1';
    for (const k of Object.keys(require.cache)) if (k.startsWith(R(''))) delete require.cache[k];
    return dir;
};

(async () => {
    section('A. matching — only what can actually be reused');
    {
        fresh('jv-ki-a-');
        const bugs = require(R('helpers/bugs'));
        const old = await bugs.fileBug({ title: 'Packing list shows blank seal number for container TCLU2727131', detail: 'seal field empty on the printed packing list', area: 'documents' });
        ck('no fix note yet -> not offered as a memory', bugs.findSimilar('packing list blank seal number printed').length === 0);
        await bugs.update(old.id, { status: 'fixed', fix_note: 'Seal was read from the old key; read seal_no from the load row instead (helpers/packingList.js).', cause: 'renamed field' });
        const m = bugs.findSimilar('Packing list printed with a blank seal number on container HMMU4444739');
        ck('resolved with a note -> found, despite a different container id', m.length === 1 && m[0].id === old.id, JSON.stringify(m));
        ck('  and it carries the steps and the cause', /seal_no/.test(m[0].fix_note) && m[0].cause === 'renamed field');
        ck('unrelated text stays quiet', bugs.findSimilar('Truckers dashboard sorts the wrong way round').length === 0);
        ck('two shared words are not enough', bugs.findSimilar('packing list looks odd').length === 0);
        const open = await bugs.fileBug({ title: 'Packing list blank seal number second case', detail: 'seal blank again', area: 'documents', signature: 'x' });
        ck('an unresolved item is never offered as a memory', !bugs.findSimilar('Packing list blank seal number second case seal blank').some((x) => x.id === open.id));
        const ver = await bugs.fileBug({ title: 'Packing list blank seal number printed', detail: 'seal blank', area: 'documents' });
        await bugs.update(ver.id, { status: 'verified', fix_note: 'checked: seal_no read' });
        ck('a checked fix ranks above an unchecked one at the same score', bugs.findSimilar('Packing list blank seal number printed seal blank')[0].verified === true);
        ck('empty text finds nothing and does not throw', bugs.findSimilar('').length === 0 && bugs.findSimilar(null).length === 0);
    }

    section('B. a new report gets what worked last time — advice, not action');
    {
        const dir = fresh('jv-ki-b-');
        const bugs = require(R('helpers/bugs'));
        const a = await bugs.fileBug({ title: 'Sale invoice total is off by the freight line', detail: 'freight added twice to the total', area: 'invoice' });
        await bugs.update(a.id, { status: 'fixed', fix_note: 'Freight was counted in subtotal and again in total; removed the second add in saleInvoice.js.' });
        await bugs.update(a.id, { status: 'verified' });
        const b = await bugs.fileBug({ title: 'Invoice total wrong, freight line added twice again', area: 'invoice' });
        ck('the new item records what it looks like', b.recurrence_of === a.id && b.known_fix && b.known_fix[0].fix_note.includes('second add'), JSON.stringify(b.known_fix));
        ck('  in its history, so it is visible later', b.history.some((h) => /looks like/.test(h.what)));
        ck('it is still OPEN: nothing was auto-closed or applied', b.status === 'open' && !b.fixed_at);
        const unrelated = await bugs.fileBug({ title: 'Trucker phone number missing on dispatch sheet', area: 'bookings' });
        ck('an unrelated report gets no memory attached', !unrelated.known_fix && !unrelated.recurrence_of);
        const row = JSON.parse(fs.readFileSync(path.join(dir, 'bugs.json'), 'utf8')).find((x) => x.id === a.id);
        ck('the original item is untouched by the lookup', row.status === 'verified' && !row.known_fix);
    }

    section('C. a crash that repeats, and a fix that did not hold');
    {
        fresh('jv-ki-c-');
        const bugs = require(R('helpers/bugs'));
        const first = await bugs.autoFileCrash(new Error('cannot read properties of undefined reading containers'), 'Booking brief');
        await bugs.update(first.id, { status: 'fixed', fix_note: 'Guard added for bookings with no containers array.' });
        const again = await bugs.autoFileCrash(new Error('cannot read properties of undefined reading containers'), 'Booking brief');
        ck('same crash after "fixed" bumps the same item', again.id === first.id && again.times === 2);
        ck('  and says the fix did not hold', again.recurred_after_fix === true && again.history.some((h) => /after being marked fixed/.test(h.what)));
        await bugs.update(first.id, { status: 'verified' });
        const third = await bugs.autoFileCrash(new Error('cannot read properties of undefined reading containers'), 'Booking brief');
        ck('after verified, a recurrence is a new item that points back', third.id !== first.id && third.recurrence_of === first.id);
        ck('  carrying the earlier fix', third.known_fix[0].fix_note.includes('Guard added'));
    }

    section('D. END TO END — real server, the routes the screen uses');
    {
        const dir = fresh('jv-ki-d-');
        process.env.APP_PASSWORD = 'user-pw-aaaaaaaaaaaa'; process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb';
        const { createApi } = require(R('api'));
        const srv = http.createServer(createApi()).listen(0);
        await new Promise((r) => srv.once('listening', r));
        const port = srv.address().port;
        const call = (method, p2, sid, body) => new Promise((resolve, reject) => {
            const d = body === undefined ? null : JSON.stringify(body);
            const headers = {};
            if (sid) headers.Authorization = `Bearer ${sid}`;
            if (d) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(d); }
            const r = http.request({ host: '127.0.0.1', port, path: p2, method, headers }, (res) => {
                let raw = ''; res.on('data', (c) => { raw += c; });
                res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j, raw }); });
            });
            r.on('error', reject); if (d) r.write(d); r.end();
        });
        const user = ((await call('POST', '/login', null, { password: 'user-pw-aaaaaaaaaaaa' })).json || {}).sid;
        const admin = ((await call('POST', '/login', null, { password: 'admin-pw-bbbbbbbbbbb' })).json || {}).sid;
        ck('two sessions', !!user && !!admin);
        const f1 = await call('POST', '/api/bugs', user, { title: 'Dashboard board stays blank after login on the phone', detail: 'blank board mobile after login', area: 'mobile app' });
        const id = f1.json.bug.id;
        ck('a plain user files', f1.status === 200 && !f1.json.bug.known_fix);
        const fx = await call('PATCH', `/api/bugs/${id}`, admin, { status: 'fixed', fix_note: 'Stale service worker cached the old shell; bumped cache version and cleared it.', cause: 'service worker cache' });
        ck('admin records the fix, with the cause', fx.status === 200 && fx.json.bug.cause === 'service worker cache', fx.raw.slice(0, 160));
        const sim = await call('GET', '/api/bugs/similar?q=' + encodeURIComponent('Phone shows blank board after login again'), user);
        ck('anyone logged in can ask "seen this before?"', sim.status === 200 && sim.json.matches.length === 1 && /service worker/.test(sim.json.matches[0].fix_note), sim.raw.slice(0, 200));
        ck('an empty question returns no matches, not an error', (await call('GET', '/api/bugs/similar?q=', user)).json.matches.length === 0);
        ck('signed out is refused', [401, 403].includes((await call('GET', '/api/bugs/similar?q=blank')).status));
        const f2 = await call('POST', '/api/bugs', user, { title: 'Blank board on the phone after login', area: 'mobile app' });
        ck('filing it again through the route attaches the memory', f2.json.bug.recurrence_of === id && f2.json.bug.known_fix[0].fix_note.includes('service worker'), f2.raw.slice(0, 200));
        const list = await call('GET', '/api/bugs?status=open', user);
        ck('and the list the screen reads carries it', (list.json.bugs.find((b) => b.id === f2.json.bug.id) || {}).known_fix, list.raw.slice(0, 200));
        const nope = await call('PATCH', `/api/bugs/${f2.json.bug.id}`, user, { cause: 'x' });
        ck('a plain user still cannot edit an item', [401, 403].includes(nope.status));
        srv.close();

        const cli = spawnSync('node', [R('scripts/known-issues.js'), 'blank board phone login', '--file', path.join(dir, 'bugs.json')], { encoding: 'utf8' });
        ck('the CLI finds it from the same file', /service worker/.test(cli.stdout) && cli.status === 0, cli.stdout + cli.stderr);
        const none = spawnSync('node', [R('scripts/known-issues.js'), 'zebra giraffe elephant tortoise', '--file', path.join(dir, 'bugs.json')], { encoding: 'utf8' });
        ck('  and says new when nothing matches', /new/i.test(none.stdout));
        const nofile = spawnSync('node', [R('scripts/known-issues.js'), 'blank board phone login', '--file', path.join(dir, 'missing', 'bugs.json')], { encoding: 'utf8' });
        ck('  and does not call a missing list "nothing found"', /no history/.test(nofile.stdout));
    }

    section('F. a fix without a usable note is refused — everywhere');
    {
        fresh('jv-ki-f-');
        const bugs = require(R('helpers/bugs'));
        const b = await bugs.fileBug({ title: 'Board blank on phone', area: 'mobile app' });
        ck('no note -> refused, with the reason', await bugs.update(b.id, { status: 'fixed' }).then(() => false, (e) => /what the fix was/.test(e.message)));
        ck('"done" -> refused', await bugs.update(b.id, { status: 'fixed', fix_note: 'done' }).then(() => false, (e) => /at least/.test(e.message)));
        ck('  and the item is still open and unchanged', bugs.get(b.id).status === 'open' && !bugs.get(b.id).fixed_at);
        const ok = await bugs.update(b.id, { status: 'fixed', fix_note: 'Cleared stale cache; bumped version.' });
        ck('a real note -> fixed', ok.status === 'fixed');
        ck('verifying later needs no new note', (await bugs.update(b.id, { status: 'verified' })).status === 'verified');
        const w = await bugs.fileBug({ title: 'Something we will not do', area: 'other' });
        ck("won't fix needs no fix note", (await bugs.update(w.id, { status: 'wont_fix' })).status === 'wont_fix');
        const r = await bugs.fileBug({ title: 'Reopen case', area: 'other' });
        await bugs.update(r.id, { status: 'fixed', fix_note: 'Guard added in helper.' });
        ck('reopening a fixed item needs no note', (await bugs.update(r.id, { status: 'open', note: 'reopened' })).status === 'open');
        ck('  and fixing it again keeps its earlier note', (await bugs.update(r.id, { status: 'fixed' })).status === 'fixed');

        const sent = [];
        const actions = require(R('workflow/actions'));
        ck('actions exposes the voice close', typeof actions.closeBugForConfirm === 'function');
    }

    section('G. old fixes become rememberable, and ids said aloud resolve');
    {
        const dir = fresh('jv-ki-g-');
        const bugs = require(R('helpers/bugs'));
        const a = await bugs.fileBug({ title: 'Payment typed during a question was dropped', status: 'fixed', area: 'whatsapp',
            detail: 'Jarvis asked how did you send it and the payment was lost.\n\nFIXED ad4c44d: a complete payment sentence now escapes any open question via detectFreshCommand.\n\nSTILL TO CHECK BY HAND: the $123.' });
        const bare = await bugs.fileBug({ title: 'Something fixed with no words about how', status: 'fixed', detail: 'it was broken' });
        const { lift } = require(R('scripts/backfill-fix-notes'));
        const got = lift(a.detail);
        ck('the fix sentence is lifted, with its commit', got && got.commit === 'ad4c44d' && /detectFreshCommand/.test(got.note) && !/STILL TO CHECK/.test(got.note), JSON.stringify(got));
        ck('an item with no fix text is left for her, not invented', lift(bare.detail) === null);
        const dry = spawnSync('node', [R('scripts/backfill-fix-notes.js')], { encoding: 'utf8', env: { ...process.env, DATA_DIR: dir } });
        ck('dry run changes nothing', /Dry run/.test(dry.stdout) && !bugs.get(a.id).fix_note, dry.stdout + dry.stderr);
        ck('  and names the one she must write', new RegExp('YOU write ' + bare.id).test(dry.stdout));
        const wr = spawnSync('node', [R('scripts/backfill-fix-notes.js'), '--write'], { encoding: 'utf8', env: { ...process.env, DATA_DIR: dir } });
        const after = bugs.get(a.id);
        ck('--write fills it, with the commit and a history line', wr.status === 0 && /detectFreshCommand/.test(after.fix_note) && after.commit === 'ad4c44d' && after.history.some((h) => h.by === 'backfill'), wr.stdout + wr.stderr);
        ck('  the other item is untouched', !bugs.get(bare.id).fix_note);
        ck('  and it is now remembered', bugs.findSimilar('payment typed while jarvis was asking a question was dropped').some((m) => m.id === a.id));
        const again = spawnSync('node', [R('scripts/backfill-fix-notes.js'), '--write'], { encoding: 'utf8', env: { ...process.env, DATA_DIR: dir } });
        ck('running twice does not duplicate', bugs.get(a.id).history.filter((h) => h.by === 'backfill').length === 1 && again.status === 0);

        const actions = require(R('workflow/actions'));
        const id = bare.id;
        ck('a full id resolves whatever case it is said in', actions.resolveBugRef('x', id.toUpperCase()).id === id && actions.resolveBugRef('x', id).id === id);
        ck('the short "BUG-001" form resolves when unambiguous', actions.resolveBugRef('x', id.split('-').slice(0, 2).join('-').toLowerCase()).id === id);
        ck('an unknown id is null, not a guess', actions.resolveBugRef('x', 'BUG-777') === null);
    }

    section('E. wiring');
    {
        const ui = fs.readFileSync(R('dashboard/app/04-loads-wizard.js'), 'utf8');
        ck('the Bugzilla tab shows the earlier fix', /Seen before/.test(ui) && /known_fix/.test(ui));
        ck('  and a fix that did not hold', /recurred_after_fix/.test(ui));
        ck('  and the fix prompt asks for cause and steps', /caused it and the steps/.test(ui));
        ck('CLAUDE.md tells the builder to look first', /known-issues\.js/.test(fs.readFileSync(R('CLAUDE.md'), 'utf8')));
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
