// ── tests/bugzilla.js ───────────────────────────────────────────────────────
// Apsara, 2026-09-24: "create a bugzilla tab in website so that we can keep
// track of all the fixes so that we can revisit it." Then: file, list and
// close by voice and WhatsApp; and let unanswered questions and crashes file
// themselves.
//
// What this guards:
//   A. the STORE — open → fixed → verified, with the fix note and a history,
//      and "fixed" is never the same as "verified"
//   B. DEDUPLICATION — a repeat bumps a count instead of filling the list
//   C. the ROUTES — anyone can file and read, only admin changes status
//   D. BY VOICE — file, list numbered, and close ONLY after a yes
//   E. IT FILES ITSELF — a question asked twice and not answered, and a crash
//   F. the TAB — the page is wired into the dashboard and its screen name
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const R = (p) => path.join(__dirname, '..', p);

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');
const A = (r) => (r && r.json && r.json.answer) || '';

(async () => {

section('A. open → fixed → verified, and the note that lets her revisit');
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-bugs-'));
    process.env.DATA_DIR = dir;
    for (const k of Object.keys(require.cache)) if (k.startsWith(R(''))) delete require.cache[k];
    const bugs = require(R('helpers/bugs'));

    const b = await bugs.fileBug({ title: 'Invoice printed the wrong weight on the second grade', area: 'invoice', severity: 'high', reporter: 'Apsara' });
    ck('it files', !!b.id && b.status === 'open' && b.times === 1, JSON.stringify(b && { id: b.id, status: b.status }));
    ck('  with an id she can say out loud', /^BUG-\d{3}-[0-9a-f]{4}$/.test(b.id), b.id);
    ck('  and a history that starts with the filing', (b.history || []).length === 1 && b.history[0].what === 'filed', JSON.stringify(b.history));
    ck('a bug with no title is refused', await bugs.fileBug({ title: '   ' }).then(() => false, (e) => /needs a title/.test(e.message)));

    const fixed = await bugs.update(b.id, { status: 'fixed', fix_note: 'siblingRows now gathers every grade' }, 'Apsara');
    ck('marking it fixed records WHAT the fix was', fixed.status === 'fixed' && /siblingRows/.test(fixed.fix_note) && !!fixed.fixed_at, JSON.stringify({ s: fixed.status, note: fixed.fix_note }));
    ck('  and fixed is NOT verified — that is the whole point',
       fixed.verified_at === null && bugs.summary().awaiting_check === 1, JSON.stringify(bugs.summary()));
    const seen = await bugs.update(b.id, { status: 'verified' }, 'Apsara');
    ck('she verifies it herself', seen.status === 'verified' && !!seen.verified_at && bugs.summary().awaiting_check === 0);
    ck('  and the history kept every step', (seen.history || []).length === 3 && /open → fixed/.test(seen.history[1].what), JSON.stringify((seen.history || []).map((h) => h.what)));

    const back = await bugs.update(b.id, { status: 'open', note: 'it came back' }, 'Apsara');
    ck('a fix that did not hold can be reopened', back.status === 'open', back.status);
    ck('an unknown id is an error, not a silent no-op', await bugs.update('BUG-999-zzzz', { status: 'fixed' }).then(() => false, (e) => /no bug/.test(e.message)));
    ck('a made-up status is refused', await bugs.update(b.id, { status: 'banana' }).then(() => false, (e) => /status must be/.test(e.message)));
    fs.rmSync(dir, { recursive: true, force: true });
}

section('B. a repeat bumps the count instead of filling the list');
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-bugs-dup-'));
    process.env.DATA_DIR = dir;
    for (const k of Object.keys(require.cache)) if (k.startsWith(R(''))) delete require.cache[k];
    const bugs = require(R('helpers/bugs'));
    const one = await bugs.fileBug({ title: 'Voice cut me off', source: 'auto_crash', signature: 'c:abc123' });
    const two = await bugs.fileBug({ title: 'Voice cut me off', source: 'auto_crash', signature: 'c:abc123' });
    ck('the same thing twice is one row, seen twice', bugs.list().length === 1 && two.times === 2 && two.id === one.id, `${bugs.list().length} rows`);
    await bugs.update(one.id, { status: 'verified' }, 'Apsara');
    const three = await bugs.fileBug({ title: 'Voice cut me off', source: 'auto_crash', signature: 'c:abc123' });
    ck('  but once verified, a recurrence is a NEW bug, not a resurrected one',
       bugs.list().length === 2 && three.id !== one.id, `${bugs.list().length} rows`);
    fs.rmSync(dir, { recursive: true, force: true });
}

section('C. the routes — anyone files, only admin changes status');
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-bugs-api-'));
    process.env.DATA_DIR = dir;
    process.env.JARVIS_TEST = '1';
    process.env.APP_PASSWORD = 'user-pw-aaaaaaaaaaaa';
    process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb';
    for (const k of Object.keys(require.cache)) if (k.startsWith(R(''))) delete require.cache[k];
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

    const userSid = ((await call('POST', '/login', null, { password: 'user-pw-aaaaaaaaaaaa' })).json || {}).sid;
    const adminSid = ((await call('POST', '/login', null, { password: 'admin-pw-bbbbbbbbbbb' })).json || {}).sid;
    ck('two sessions, or the next checks prove nothing', !!userSid && !!adminSid);

    const filed = await call('POST', '/api/bugs', userSid, { title: 'Board is blank on the phone', area: 'mobile app' });
    ck('a plain user can file one', filed.status === 200 && filed.json.ok, filed.raw.slice(0, 160));
    const listed = await call('GET', '/api/bugs?status=open', userSid);
    ck('  and read the list', listed.status === 200 && (listed.json.bugs || []).length === 1, listed.raw.slice(0, 160));
    ck('  with the counts she reads first', listed.json.summary && listed.json.summary.open === 1, JSON.stringify(listed.json.summary));

    const id = filed.json.bug.id;
    const denied = await call('PATCH', `/api/bugs/${id}`, userSid, { status: 'fixed' });
    ck('a plain user cannot mark it fixed', denied.status === 401 || denied.status === 403, String(denied.status));
    const ok = await call('PATCH', `/api/bugs/${id}`, adminSid, { status: 'fixed', fix_note: 'render guard added' });
    ck('  admin can', ok.status === 200 && ok.json.bug.status === 'fixed', ok.raw.slice(0, 160));
    const gone = await call('PATCH', '/api/bugs/BUG-404-zzzz', adminSid, { status: 'fixed' });
    ck('an unknown id is a 404, not a 500', gone.status === 404, String(gone.status));
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
}

section('D. by voice — file, list, and close only after a yes');
{
    for (const k of Object.keys(require.cache)) if (k.startsWith(R(''))) delete require.cache[k];
    const { boot } = require('./helpers/e2e');
    const j = await boot({});
    const actions = require(R('workflow/actions'));
    const bugs = require(R('helpers/bugs'));
    const cfg = require(R('config'));
    const chat = `${cfg.getSettings().manager_number || cfg.MANAGER_NUMBER}@c.us`;

    await actions.logBug(chat, { title: 'The cutoff is not showing on the board', area: 'bookings' });
    await actions.logBug(chat, { title: 'Voice keeps saying yes boss twice' });
    ck('filing by voice works', bugs.list().length === 2 && bugs.list()[0].source === 'jarvis', JSON.stringify(bugs.list().map((b) => b.title)));

    await actions.showBugs(chat, 'open');
    const listed = bugs.filter({ status: 'open' });
    ck('the list is numbered so a number means something', listed.length === 2);

    // "bug 2 is fixed" — staged, NOT applied.
    await actions.closeBugForConfirm(chat, { ref: '2', note: 'echo guard added' });
    const pending = actions.getPending(chat);
    ck('closing stages a yes/no first', pending && pending.type === 'await_bug_close' && pending.bug_id === listed[1].id, JSON.stringify(pending && pending.type));
    ck('  and nothing has changed yet', bugs.get(listed[1].id).status === 'open');

    await actions.applyBugClose(chat, pending);
    const after = bugs.get(listed[1].id);
    ck('on yes it is marked fixed, with the note', after.status === 'fixed' && /echo guard/.test(after.fix_note), JSON.stringify({ s: after.status, n: after.fix_note }));
    ck('  but not verified — that is still hers to say', after.verified_at === null);

    const notFound = await actions.closeBugForConfirm(chat, { ref: '99' });
    ck('a number that is not on the list is refused, not guessed', notFound.action_taken === 'bug_not_found');
    await j.stop();
}

section('E. it files itself — an unanswered question and a crash');
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-bugs-auto-'));
    process.env.DATA_DIR = dir;
    for (const k of Object.keys(require.cache)) if (k.startsWith(R(''))) delete require.cache[k];
    const bugs = require(R('helpers/bugs'));
    const askLog = require(R('helpers/data/askLog'));

    await askLog.record({ kind: 'data', question: 'what is my average margin per tonne', outcome: 'could_not_answer' });
    const first = await bugs.autoFileQuestion('what is my average margin per tonne');
    ck('asked once and missed is NOT a bug yet', first === null && bugs.list().length === 0, JSON.stringify(bugs.list()));

    await askLog.record({ kind: 'data', question: 'what is my average margin per tonne', outcome: 'could_not_answer' });
    const second = await bugs.autoFileQuestion('what is my average margin per tonne');
    ck('asked twice and missed files itself', !!second && /Couldn't answer/.test(second.title), JSON.stringify(second && second.title));
    ck('  and it says how to fix it', /EXAMPLES in helpers\/data\/askData\.js/.test(second.detail), second.detail);
    ck('  marked as filed by itself, so her own reports stand out', second.source === 'auto_question');

    await askLog.record({ kind: 'data', question: 'what is my average margin per tonne', outcome: 'could_not_answer' });
    const third = await bugs.autoFileQuestion('what is my average margin per tonne');
    ck('  asking it again does not file a second row', bugs.list().length === 1 && third.times === 2, `${bugs.list().length} rows`);

    const crash = await bugs.autoFileCrash(new Error('sales.getSale is not a function'), 'Generating an invoice');
    ck('a crash files itself', /Generating an invoice broke/.test(crash.title) && crash.severity === 'high', crash.title);
    await bugs.autoFileCrash(new Error('sales.getSale is not a function'), 'Generating an invoice');
    ck('  and the same crash twice is still one row', bugs.list().filter((b) => b.source === 'auto_crash').length === 1);
    fs.rmSync(dir, { recursive: true, force: true });
}

section('F. the tab itself');
{
    const html = fs.readFileSync(R('dashboard/index.html'), 'utf8');
    ck('the nav has a Bugzilla tab', /\{ id: 'bugzilla',\s+label: 'Bugzilla'/.test(html));
    ck('  it renders', /if \(tab === 'bugzilla'\) return renderBugzilla\(\);/.test(html) && /async function renderBugzilla\(\)/.test(html));
    // Staff keep their Edge-Yard-only sidebar (tests/page-headings.js), so
    // Bugzilla is deliberately NOT in the staff filter.
    ck('  staff keep their yard-only sidebar', !/n\.id === 'bugzilla'/.test(html));
    ck('  the status buttons are admin-only, matching the server', /isAdmin \? `<div/.test(html));
    ck('  and "fixed" asks what the fix was', /What was the fix\?/.test(html));

    const screens = require(R('helpers/screens'));
    ck('"open bugzilla" opens it by voice', (screens.match('open bugzilla') || {}).key === 'bugzilla');
    ck('  and so does "open the bug list"', (screens.match('open the bug list') || {}).key === 'bugzilla');
    // A QUESTION is not navigation: "what bugs are open" is the action that
    // reads them out (show_bugs), not a request to change screens. The screen
    // matcher deliberately needs an opening verb, and this holds it to that.
    ck('  but a question is not a screen change', screens.match('what bugs are open') === null);

    // The whole page still parses — a syntax error here takes the dashboard
    // down, not just this tab.
    const script = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)];
    let broke = null;
    for (const m of script) { try { new Function(m[1]); } catch (e) { broke = e.message; } }
    ck('the dashboard script still parses', !broke, String(broke));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log('\nFAILED:\n  - ' + failures.join('\n  - '));
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
