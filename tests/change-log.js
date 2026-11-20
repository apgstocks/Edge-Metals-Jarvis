// ── tests/change-log.js ───────────────────────────────────────────────────
// Apsara, 2026-11-20: "For each and every operation, we need to have audit log right?" — "Yard first", "Manager
// only". helpers/changeLog.js (the store), helpers/changeLogMiddleware.js (what counts), GET /api/change-log and
// /audit (the read side).
//
// A — the store: secrets never written, before → after is right, nothing can delete.
// B — END TO END (CLAUDE.md §3): a real server, real sign-ins, saves through the routes the screens use, and the
//     entries read back out of the route the Audit page reads. Measured as DELTAS where earlier steps wrote.
// C — the boundary: staff cannot read it; a failed save is logged as refused; a request that never signed in is not.
// D — the one rule: a log that cannot be written never fails a save.
// E — coverage: every write route in the yard route files is either on the list or named here as left out on
//     purpose, so a new yard route cannot slip past the log unnoticed.
// F — the page and the menu.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra !== undefined) console.log('        ' + (typeof extra === 'string' ? extra : JSON.stringify(extra))); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-changelog-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.CHANGE_LOG_DIR = path.join(TMP, 'change-log');
process.env.APP_PASSWORD   = process.env.APP_PASSWORD   || 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'staff-pw-ccccccccccc';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('  ABORT  config not isolated'); process.exit(1); }
const CL = require(path.join(ROOT, 'helpers/changeLog'));
const MW = require(path.join(ROOT, 'helpers/changeLogMiddleware'));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

(async () => {

section('A — the store');
{
    const s = CL.scrub({ password: 'hunter2', newPassword: 'x', pin: '1234', sid: 'abc', signature: 'data:image/png;base64,AAAA',
        photo: 'zzz', note: 'n'.repeat(500), keep: 'Rotors', nested: { token: 't', ok: 1 } });
    ck('passwords, PINs, session ids and tokens are never written', s.password === '[hidden]' && s.newPassword === '[hidden]'
        && s.pin === '[hidden]' && s.sid === '[hidden]' && s.nested.token === '[hidden]', s);
    ck('signatures and photos are never written', s.signature === '[hidden]' && s.photo === '[hidden]');
    ck('a data: URL under any key is written as [file]', CL.scrub({ x: 'data:application/pdf;base64,JVBER' }).x === '[file]');
    ck('a long text is cut, and says how long it was', /… \(500 chars\)$/.test(s.note) && s.note.length < 200);
    ck('ordinary words are kept as they are', s.keep === 'Rotors' && s.nested.ok === 1);

    const d = CL.diff(
        { seller: 'Hugo', items: [{ description: 'Rotors', price: 0.32 }], payments: [{ id: 'p1', amount: 50 }], updated_at: 'a' },
        { seller: 'Hugo', items: [{ description: 'Rotors', price: 0.23 }], payments: [{ id: 'p1', amount: 50 }, { id: 'p2', amount: 9 }], updated_at: 'b' });
    const f = (k) => d.find((x) => x.field === k);
    ck('a price change is recorded as before → after', f('items[1].price') && f('items[1].price').from === 0.32 && f('items[1].price').to === 0.23, d);
    ck('a new payment is matched by its id, not its position', !!f('payments[p2].amount') && !f('payments[p1].amount'), d);
    ck('unchanged fields and updated_at are left out', !f('seller') && !f('updated_at'), d);
    const big = CL.diff({}, Object.fromEntries(Array.from({ length: 260 }, (_, i) => [`k${i}`, i])));
    ck('a huge change is capped and says how many more', big.length === 201 && /60 more/.test(big[200].to), big.length);

    ck('the store offers no way to delete or trim', !Object.keys(CL).some((k) => /delete|remove|trim|clear|prune|purge/i.test(k)), Object.keys(CL));
    const before = CL.list().total;
    const e1 = CL.record({ actor: 'maria', action: 'Load edited', subject: 'EDGE_9', ok: true });
    ck('an entry is written with an id and a time', e1 && /^[0-9a-f]{10}$/.test(e1.id) && !!Date.parse(e1.at), e1);
    ck('  and is read back, newest first', CL.list().total === before + 1 && CL.list().rows[0].id === e1.id);
    ck('  filtered by person (any case)', CL.list({ actor: 'MARIA' }).rows.some((r) => r.id === e1.id) && !CL.list({ actor: 'joe' }).rows.length);
    ck('  and by record', CL.list({ subject: 'edge_9' }).total === 1);
    const month = fs.readdirSync(CL.dir()).find((x) => /\.jsonl$/.test(x));
    fs.appendFileSync(path.join(CL.dir(), month), '{ not json\n');
    ck('a damaged line is skipped and counted, never fatal', CL.list().skipped_lines === 1 && CL.list().total === before + 1);
}

section('B — end to end: save through the real routes, read it back from the route the Audit page reads');
const { createApi } = require(path.join(ROOT, 'api'));
const app = createApi();
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const req = (method, p, { body, sid } = {}) => new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (sid) headers.Authorization = `Bearer ${sid}`;
    const r2 = http.request(base + p, { method, headers }, (res) => {
        let raw = ''; res.on('data', (c) => { raw += c; });
        res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j, raw }); });
    });
    r2.on('error', reject); if (data) r2.write(data); r2.end();
});
const settle = () => new Promise((r) => setTimeout(r, 60));        // entries land on 'finish', just after the reply
let admin, staff;
const logOf = async (q = '') => ((await req('GET', '/api/change-log' + q, { sid: admin })).json || {});
{
    const bad = await req('POST', '/login', { body: { password: 'wrong-wrong' } });
    admin = ((await req('POST', '/login', { body: { password: process.env.ADMIN_PASSWORD } })).json || {}).sid;
    staff = ((await req('POST', '/login', { body: { password: process.env.STAFF_PASSWORD } })).json || {}).sid;
    ck('signed in as manager and as staff', !!admin && !!staff && bad.status === 401);
    await settle();
    const signins = (await logOf('?action=Sign%20in')).rows || [];
    ck('a successful sign-in is logged, with who it was', signins.some((r) => r.ok && r.actor === 'admin'), signins);
    ck('a failed sign-in is logged as refused', signins.some((r) => !r.ok && r.status === 401 && r.actor === '(owner password)'), signins);
    ck('no sign-in entry holds the password or the session id',
        !JSON.stringify(signins).includes(process.env.ADMIN_PASSWORD) && !JSON.stringify(signins).includes(admin)
        && !JSON.stringify(signins).includes('wrong-wrong'));

    const item = (description, extra = {}) => ({ description, gross_weight: 50000, tare_weight: 3440, price: 0.32, unit: 'lb', ...extra });
    const n0 = (await logOf()).total;
    const made = await req('POST', '/api/loads', { sid: staff, body: { date: '2026-11-20', seller: 'Hugo', items: [item('Rotors')], created_by: 'test' } });
    const id = ((made.json || {}).load || {}).id;
    ck('a load is created through the Loads route', made.status === 200 && !!id, `${made.status} ${made.raw.slice(0, 160)}`);
    await settle();
    let log = await logOf();
    const created = (log.rows || []).find((r) => r.action === 'Load created');
    ck('  it is logged: one new entry', log.total === n0 + 1, { before: n0, after: log.total });
    ck('  named to the person who saved it (staff), with the new load number', created && created.actor === 'staff' && created.subject === id, created);
    ck('  and what was created', created && created.after && created.after.seller === 'Hugo' && created.after.items[0].description === 'Rotors', created && created.after);

    const put = await req('PUT', '/api/loads/' + id, { sid: admin, body: { date: '2026-11-20', seller: 'Hugo', items: [item('Rotors', { price: 0.23 })] } });
    ck('the load is edited through the same route the Edit form uses', put.status === 200, `${put.status} ${put.raw.slice(0, 160)}`);
    await settle();
    const edited = ((await logOf('?action=Load%20edited')).rows || [])[0];
    const priceChange = edited && (edited.changes || []).find((c) => /items\[1\]\.price$/.test(c.field));
    ck('  the edit is logged with the price before → after (0.32 → 0.23)', priceChange && priceChange.from === 0.32 && priceChange.to === 0.23, edited);
    ck('  named to the manager', edited && edited.actor === 'admin');
    ck('  and searchable by the load number', ((await logOf('?subject=' + encodeURIComponent(id))).rows || []).length >= 2);

    const paid = await req('POST', '/api/payments', { sid: admin, body: { load_id: id, load_kind: 'purchase', mode: 'Zelle', bank: 'Chase Bank', amount: 100, paid_on: '2026-11-20' } });
    ck('a payment is recorded through the pay route', paid.status === 200, `${paid.status} ${paid.raw.slice(0, 200)}`);
    await settle();
    const payEntry = ((await logOf('?action=Payment%20recorded')).rows || [])[0];
    ck('  logged against the load, with the new payment and its amount',
        payEntry && payEntry.subject === id && (payEntry.changes || []).some((c) => /\.amount$/.test(c.field) && c.to === 100), payEntry);

    const pid = paid.json && paid.json.payment && paid.json.payment.id;
    if (pid) {
        const del = await req('DELETE', '/api/payments/' + pid, { sid: admin });
        await settle();
        const delEntry = ((await logOf('?action=Payment%20deleted')).rows || [])[0];
        ck('a deleted payment is logged, keeping what it was', delEntry && delEntry.subject === pid
            && (del.status >= 400 ? delEntry.ok === false : (delEntry.before && delEntry.before.amount === 100)), { status: del.status, delEntry });
    }

    const gone = await req('DELETE', '/api/loads/' + id, { sid: admin });
    await settle();
    const delLoad = ((await logOf('?action=Load%20deleted')).rows || [])[0];
    ck('a deleted load is logged with the whole load as it was', delLoad && delLoad.subject === id
        && (gone.status >= 400 ? delLoad.ok === false : (delLoad.before && delLoad.before.seller === 'Hugo')), { status: gone.status, delLoad });

    const draftsBefore = (await logOf()).total;
    await req('POST', '/api/load-drafts', { sid: staff, body: { seller: 'typing…', items: [item('Ro')] } });
    await req('GET', '/api/loads', { sid: staff });
    await settle();
    ck('autosaved drafts and reads add nothing', (await logOf()).total === draftsBefore);
}

section('C — the boundary');
{
    const r = await req('GET', '/api/change-log', { sid: staff });
    ck('staff cannot read the audit log', r.status === 403, r.status);
    const anon = await req('GET', '/api/change-log');
    ck('nobody signed out can read it', anon.status === 401 || anon.status === 302, anon.status);
    const n0 = (await logOf()).total;
    await req('DELETE', '/api/loads/NOPE_404');                       // never signed in
    await settle();
    ck('a request that never signed in is not logged', (await logOf()).total === n0);
    const refused = await req('DELETE', '/api/loads/NOPE_404', { sid: admin });
    await settle();
    const e = ((await logOf('?subject=NOPE_404')).rows || [])[0];
    ck('a save that fails is logged as refused, with the reason', refused.status >= 400 && e && e.ok === false && e.status === refused.status, e);
    const q = await logOf('?q=hugo');
    ck('search finds any word in an entry', (q.rows || []).length >= 1);
}

section('D — the one rule: a log that cannot be written never fails a save');
{
    const real = process.env.CHANGE_LOG_DIR;
    const blocker = path.join(TMP, 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    process.env.CHANGE_LOG_DIR = path.join(blocker, 'nested');          // mkdir under a file: every write fails
    const origErr = console.error; console.error = () => {};
    const r = await req('POST', '/api/petty-cash', { sid: admin, body: { amount: 25, date: '2026-11-20', note: 'float' } });
    await settle();
    console.error = origErr;
    process.env.CHANGE_LOG_DIR = real;
    ck('the save still goes through', r.status === 200, `${r.status} ${r.raw.slice(0, 160)}`);
    ck('  and the failure is counted for the Audit page to show', (await logOf()).write_failures >= 1);
}

section('E — coverage: no yard write route slips past the log');
{
    // Left out on purpose, each with its reason in helpers/changeLogMiddleware.js.
    const LEFT_OUT = new Set([
        'POST /api/load-drafts', 'DELETE /api/load-drafts/:id',            // autosave; the load's own save is logged
        'POST /api/expenses/suggest-vendor',                              // a lookup, changes nothing
        'POST /api/item-maintenance/preview', 'POST /api/party-maintenance/:kind/preview',
        'POST /api/yard/ask', 'POST /api/yard/attach', 'POST /api/yard/cancel-action',   // questions, not changes
    ]);
    // Edge Metals paths, written as they appear inside a rule's regex source (\/api\/…). trucker-bills is the YARD's.
    const FREIGHT_RE = /\\\/api\\\/(edge-inventory|bills|sales|bookings|documents|claims|bank|quickbooks|metals-trucking)/;
    const FREIGHT = /^\/api\/(edge-inventory|documents|whatsapp|facts|bot|alerts|metals-trucking)/;   // not yard: next step
    const routes = [];
    for (const f of ['routes/loads.js', 'routes/payments.js', 'routes/yard.js', 'routes/admin.js', 'routes/reports.js', 'routes/voice.js', 'routes/core.js']) {
        for (const m of read(f).matchAll(/app\.(post|put|patch|delete)\('([^']+)'/g)) routes.push(`${m[1].toUpperCase()} ${m[2]}`);
    }
    const yard = routes.filter((r) => {
        const p = r.split(' ')[1];
        return /^\/api\/(loads|payments|prepayments|trucker-bills|expenses|petty-cash|outbound-loads|item-types|trade-catalog|item-maintenance|party-maintenance|settings|pricelist|verify-admin-password|yard)/.test(p) && !FREIGHT.test(p);
    });
    const missing = yard.filter((r) => {
        if (LEFT_OUT.has(r)) return false;
        const [m, p] = r.split(' ');
        return !MW.ruleFor(m, p.replace(/:[a-z_]+/gi, 'X1'));
    });
    ck(`all ${yard.length} yard write routes are logged or deliberately left out`, missing.length === 0, missing);
    ck('no freight route is on the list (Apsara: "Yard first")', !MW.RULES.some((r) => FREIGHT_RE.test(r.re.source)),
        MW.RULES.map((r) => r.re.source).filter((s) => FREIGHT_RE.test(s)));
    ck('the hook is mounted once, before /login', (read('api.js').match(/changeLogMiddleware'\)\.middleware\(\)/g) || []).length === 1
        && read('api.js').indexOf("changeLogMiddleware').middleware()") < read('api.js').indexOf("app.post('/login'"));
}

section('F — the page and the menu');
{
    const page = await req('GET', '/audit', { sid: admin });
    ck('/audit serves the page', page.status === 200 && /Audit log/.test(page.raw));
    ck('the page reads /api/change-log', /\/api\/change-log\?/.test(read('dashboard/audit.html')));
    ck('the page has no edit or delete', !/method:\s*'(DELETE|PUT|POST)'/i.test(read('dashboard/audit.html')));
    ck('the app menu offers it on the yard side, manager only', /\{ id: 'audit', label: 'Audit Log', group: 'Edge Yard', adminOnly: true \}/.test(read('dashboard/app/01-core.js')));
    ck('  and so does the sidebar on standalone pages', /\{ id: 'audit', label: 'Audit Log', group: 'Edge Yard', adminOnly: true \}/.test(read('dashboard/sidebar.js')) && /audit: '\/audit'/.test(read('dashboard/sidebar.js')));
    ck('clicking it opens /audit', /dataset\.tab === 'audit'[\s\S]{0,60}\/audit/.test(read('dashboard/app/01-core.js')));
    ck('customer copies keep it in their menu', /TRIAL_MENU = \[[^\]]*'audit'/.test(read('scripts/make-trial.js')));
}

server.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('threw:', e && e.stack); process.exit(1); });
