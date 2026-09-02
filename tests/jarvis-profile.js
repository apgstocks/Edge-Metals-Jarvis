// ── tests/jarvis-profile.js ───────────────────────────────────────────────
// Apsara, 2026-09-03: "create another profile as jarvis with delete option
// enabled even after payments. this is in addition to admin privileges. this
// is like top level profile." Asked which locks it should lift, she said all
// four; asked whether it should leave a record, "yes — log every privileged
// action."
//
// THE THING THIS FILE IS REALLY FOR
// ---------------------------------
// Writing it turned up that the payment locks DID NOT EXIST on the server.
// "A load cannot be deleted once it has been paid against" and "a signature is
// frozen once money has moved" were both enforced by not rendering a button,
// in two client files, and nowhere else. DELETE /api/loads/:id deleted a fully
// paid load without a murmur, and it is not behind requireAdmin — it sits
// under /api/loads, which staff can reach. The rule was made of HTML.
//
// So most of what follows is not about the new profile at all. Sections C and
// D assert the guard that should have been there all along, and E asserts the
// profile is allowed past it. If the profile were removed tomorrow, C and D
// should stay.
//
// AND WHAT IT MUST NOT CHANGE
// ---------------------------
// A new top-level role is the kind of change that quietly grants or removes
// access somewhere nobody looked. Section B is the boring half: admin still
// admin, staff still fenced, wrong password still nothing, machine token NOT
// promoted. Section I pins down that staff KEEP the delete button on an unpaid
// load, which she asked for and which has always been true — the risk with
// this change was never adding it, it was taking it away by accident.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-profile-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
// Set BEFORE config is required — it reads process.env at module load.
process.env.APP_PASSWORD    = 'user-password-aaa';
process.env.ADMIN_PASSWORD  = 'admin-password-bbb';
process.env.STAFF_PASSWORD  = 'staff-password-ccc';
process.env.JARVIS_PASSWORD = 'jarvis-password-ddd';
process.env.API_TOKEN       = 'machine-token-eee';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.PAYMENTS_FILE).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated — refusing to run against real data');
    process.exit(1);
}

const audit = require(path.join(ROOT, 'helpers/audit'));
const payments = require(path.join(ROOT, 'helpers/payments'));
const petty = require(path.join(ROOT, 'helpers/pettyCash'));
const { createApi } = require(path.join(ROOT, 'api'));

// ── a real server on a real socket ────────────────────────────────────────
// Not a stubbed req/res. The whole finding above is that a rule can look
// present in one layer and be absent from the one that runs, so these
// assertions go through Express's actual routing and middleware stack.
let server, base;
function req(method, urlPath, { sid, token, body } = {}) {
    return new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        if (token) headers.Authorization = `Bearer ${token}`;
        const r = http.request(base + urlPath, { method, headers }, (res) => {
            let raw = '';
            res.on('data', (c) => { raw += c; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(raw); } catch (e) {}
                resolve({ status: res.statusCode, json, raw });
            });
        });
        r.on('error', reject);
        if (data) r.write(data);
        r.end();
    });
}
const login = async (password) => (await req('POST', '/login', { body: { password } }));

const reset = () => {
    for (const f of [cfg.PAYMENTS_FILE, cfg.PETTY_CASH_FILE, cfg.AUDIT_LOG_FILE, cfg.LOADS_FILE]) {
        try { fs.writeFileSync(f, '[]'); } catch (e) {}
    }
};

const { mutateJson } = require(path.join(ROOT, 'helpers/json'));
const putLoad = (rec) => mutateJson(cfg.LOADS_FILE, [], (list) => {
    const l = Array.isArray(list) ? list : [];
    l.unshift(rec);
    return l;
});

// A load with money against it.
async function paidLoad(id, amount, mode = 'Zelle') {
    await putLoad({ id, date: '2026-09-01', seller: 'Acme', amount: amount * 2, items: [], weight_unit: 'lb' });
    await payments.addPayment({ load_id: id, load_kind: 'purchase', amount, mode, paid_on: '2026-09-01' });
}

(async () => {

const app = createApi();
await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
base = `http://127.0.0.1:${server.address().port}`;

console.log('\n─ the Jarvis profile ────────────────────────────────────────');

// ── A. the profile exists and announces itself ────────────────────────────
section('A — signing in as Jarvis');
let jarvisSid = null, adminSid = null, userSid = null, staffSid = null;
{
    const j = await login('jarvis-password-ddd');
    ck('the Jarvis password is accepted', j.status === 200, `got ${j.status}`);
    jarvisSid = j.json && j.json.sid;

    // ROLE IS 'admin', NOT 'jarvis'. This is the central design decision and
    // it is asserted, not assumed: 'admin' is checked in fourteen places
    // across two clients and the server, and a fourth role string would have
    // had to be added to every one — where missing one means the TOP-level
    // profile silently sees LESS than admin.
    ck('  it is an ADMIN session', j.json && j.json.role === 'admin',
       'a separate role string would have to be added to fourteen existing admin checks');
    ck('  carrying the super flag', j.json && j.json.super === true);
    ck('  and naming itself', j.json && j.json.profile === 'jarvis');

    const me = await req('GET', '/api/me', { sid: jarvisSid });
    ck('/api/me reports it back', me.json && me.json.role === 'admin' && me.json.super === true);
    ck('  with the profile name for the label', me.json && me.json.profile === 'jarvis',
       'without this the screen says "Admin access" and nothing shows this session can erase a paid load');
}

// ── B. everything that must NOT have changed ──────────────────────────────
section('B — the other tiers are exactly as they were');
{
    const a = await login('admin-password-bbb');
    adminSid = a.json && a.json.sid;
    ck('admin still signs in', a.status === 200 && a.json.role === 'admin');
    ck('  and is NOT super', a.json.super === false,
       'the whole profile is pointless if the admin password already grants it');

    const u = await login('user-password-aaa');
    userSid = u.json && u.json.sid;
    ck('the standard user still signs in', u.status === 200 && u.json.role === 'user');
    ck('  and is not super', u.json.super === false);

    const s = await login('staff-password-ccc');
    staffSid = s.json && s.json.sid;
    ck('staff still signs in', s.status === 200 && s.json.role === 'staff');
    ck('  and is not super', s.json.super === false);

    const w = await login('not-any-of-them');
    ck('a wrong password still gets nothing', w.status === 401);

    // Staff's fence is untouched. A new privileged tier is exactly the change
    // that quietly widens someone else's access.
    const fenced = await req('GET', '/api/expenses', { sid: staffSid });
    ck('staff are still fenced out of everything but Loads', fenced.status === 403);

    // THE MACHINE TOKEN IS NOT PROMOTED. It is a long-lived shared secret
    // sitting in config on other hosts; giving it the power to erase paid
    // loads would put that power behind the weakest credential in the system.
    const m = await req('GET', '/api/me', { token: 'machine-token-eee' });
    ck('the API token is admin', m.json && m.json.role === 'admin');
    ck('  but NOT super', m.json && m.json.super === false,
       'a shared machine secret must not be able to delete paid loads');
}

// ── C. the guard that never existed ───────────────────────────────────────
section('C — a paid load cannot be deleted (this is NEW)');
{
    reset();
    await paidLoad('EDGE_01', 500);

    const r = await req('DELETE', '/api/loads/EDGE_01', { sid: adminSid });
    ck('admin is refused', r.status === 409, `got ${r.status} — before today this returned 200 and deleted it`);
    ck('  with a code the client can branch on', r.json && r.json.code === 'LOAD_HAS_PAYMENTS');
    ck('  and the amount, so the message can say what is in the way', r.json && r.json.paid === 500);

    const { loadLoads } = require(path.join(ROOT, 'helpers/loads'));
    ck('  the load is still there', loadLoads().some((l) => l.id === 'EDGE_01'));
    ck('  and so are its payments', payments.paymentsForLoad('EDGE_01').length === 1);

    // STAFF TOO. This is the case that was genuinely open: /api/loads is on
    // STAFF_ALLOWED_PATH_PREFIXES, so a staff session reached this route with
    // nothing but a hidden button between it and a paid load.
    const st = await req('DELETE', '/api/loads/EDGE_01', { sid: staffSid });
    ck('staff are refused too', st.status === 409,
       'staff can reach this route — the hidden button was the only thing stopping them');

    // The refusal is logged. A run of these is the shape of someone probing,
    // and a success-only log throws exactly that away.
    const rows = audit.listEntries();
    ck('the refusal is recorded', rows.some((x) => x.action === 'delete-paid-load' && x.outcome === 'refused'));
    ck('  naming who tried', rows.some((x) => x.actor === 'admin') && rows.some((x) => x.actor === 'staff'));

    // An UNPAID load still deletes, for BOTH tiers. The guard must not become
    // "nothing can be deleted", which would be a worse regression than the
    // hole it closes — and she asked for exactly this: "for admin, before
    // making payment, show delete button. for staff — show delete option
    // before payment."
    await putLoad({ id: 'EDGE_02', date: '2026-09-01', seller: 'B', items: [] });
    const okAdmin = await req('DELETE', '/api/loads/EDGE_02', { sid: adminSid });
    ck('an UNPAID load still deletes for admin', okAdmin.status === 200,
       'the guard must gate on payment, not on deletion');

    await putLoad({ id: 'EDGE_03', date: '2026-09-01', seller: 'C', items: [] });
    const okStaff = await req('DELETE', '/api/loads/EDGE_03', { sid: staffSid });
    ck('  and for staff', okStaff.status === 200,
       'staff record loads, so staff must be able to remove one they entered wrong');
}

// ── D. the signature freeze, also new on the server ───────────────────────
section('D — a signed, paid load cannot be re-signed (this is NEW)');
{
    reset();
    const PNG = 'data:image/png;base64,' + Buffer.from('x').toString('base64');
    await putLoad({ id: 'EDGE_10', date: '2026-09-01', seller: 'Acme', items: [],
                    seller_signature: PNG, seller_signed_at: '2026-09-01T00:00:00.000Z' });
    await payments.addPayment({ load_id: 'EDGE_10', load_kind: 'purchase', amount: 300, mode: 'Zelle', paid_on: '2026-09-01' });

    const r = await req('POST', '/api/loads/EDGE_10/signature', { sid: adminSid, body: { signature: PNG } });
    ck('admin cannot replace the signature', r.status === 409, `got ${r.status}`);
    ck('  with its own code', r.json && r.json.code === 'SIGNATURE_FROZEN');
    ck('  and it is logged as refused',
       audit.listEntries().some((x) => x.action === 'resign-paid-load' && x.outcome === 'refused'));

    // THE FIRST signature on a paid load is still allowed. Payment by transfer
    // routinely lands before the seller is back with a pen, and refusing here
    // would strand a real load with no way to sign it but deleting the money.
    await putLoad({ id: 'EDGE_11', date: '2026-09-01', seller: 'Vega', items: [] });
    await payments.addPayment({ load_id: 'EDGE_11', load_kind: 'purchase', amount: 100, mode: 'Zelle', paid_on: '2026-09-01' });
    const first = await req('POST', '/api/loads/EDGE_11/signature', { sid: adminSid, body: { signature: PNG } });
    ck('a FIRST signature on a paid load is still allowed', first.status !== 409,
       'adding a missing signature is not the same act as replacing one');
}

// ── E. what the profile is actually for ───────────────────────────────────
section('E — Jarvis goes past all four locks');
{
    reset();
    await paidLoad('EDGE_20', 700, 'Zelle');

    const r = await req('DELETE', '/api/loads/EDGE_20', { sid: jarvisSid });
    ck('Jarvis deletes a paid load', r.status === 200, `got ${r.status}: ${r.raw}`);

    const { loadLoads } = require(path.join(ROOT, 'helpers/loads'));
    ck('  the load is gone', !loadLoads().some((l) => l.id === 'EDGE_20'));
    ck('  and its payments went with it', payments.paymentsForLoad('EDGE_20').length === 0,
       'receipts left behind would sum against nothing and inflate every future spend figure');

    // Re-sign.
    const PNG = 'data:image/png;base64,' + Buffer.from('y').toString('base64');
    await putLoad({ id: 'EDGE_21', date: '2026-09-01', seller: 'Acme', items: [],
                    seller_signature: PNG, seller_signed_at: '2026-09-01T00:00:00.000Z' });
    await payments.addPayment({ load_id: 'EDGE_21', load_kind: 'purchase', amount: 50, mode: 'Zelle', paid_on: '2026-09-01' });
    const rs = await req('POST', '/api/loads/EDGE_21/signature', { sid: jarvisSid, body: { signature: PNG } });
    ck('Jarvis re-signs a paid load', rs.status !== 409, `got ${rs.status}`);

    // The edit-unlock prompt.
    const okJ = await req('POST', '/api/verify-admin-password', { sid: jarvisSid, body: { password: 'jarvis-password-ddd' } });
    ck('the Jarvis password satisfies the edit-unlock prompt', okJ.status === 200 && okJ.json.ok === true,
       '"in addition to admin privileges" cannot mean the top profile fails at the unlock box');
    ck('  and says which one it was', okJ.json.super === true);
    const okA = await req('POST', '/api/verify-admin-password', { sid: adminSid, body: { password: 'admin-password-bbb' } });
    ck('  the admin password still works there', okA.status === 200 && okA.json.ok === true);
    ck('    and is not marked super', okA.json.super === false);
    const bad = await req('POST', '/api/verify-admin-password', { sid: adminSid, body: { password: 'nope' } });
    ck('  a wrong password still fails', bad.status === 403);
}

// ── F. the money is unwound, not lost ─────────────────────────────────────
section('F — erasing a CASH-paid load returns the cash');
{
    reset();
    await petty.addTopUp({ amount: 1000 });
    await paidLoad('EDGE_30', 400, 'Cash');
    ck('the cash payment drew the box down', petty.balance() === 600,
       `balance is ${petty.balance()}`);

    const r = await req('DELETE', '/api/loads/EDGE_30', { sid: jarvisSid });
    ck('Jarvis deletes it', r.status === 200);
    ck('  and the cash is back in the box', petty.balance() === 1000,
       'otherwise the drawer reads 400 short forever, against a load that no longer exists to explain it');
}

// ── G. the log ────────────────────────────────────────────────────────────
section('G — what the log has to still be able to tell her');
{
    reset();
    await paidLoad('EDGE_40', 12000, 'Wire');
    await req('DELETE', '/api/loads/EDGE_40', { sid: jarvisSid });

    const rows = audit.listEntries();
    const row = rows.find((x) => x.subject === 'EDGE_40');
    ck('there is a row for it', !!row);
    if (row) {
        ck('  it says what was done', row.action === 'delete-paid-load');
        ck('  by whom', row.actor === 'jarvis');
        ck('  and that it finished', row.outcome === 'done');
        ck('  when', /^\d{4}-\d{2}-\d{2}T/.test(row.at || ''));

        // THE POINT OF THE WHOLE FILE. Everything below is gone from every
        // other store; if the log does not carry it, the answer to "did we
        // ever pay Acme 12,000" is nothing at all.
        ck('  the seller, who no longer exists on any record', row.detail && row.detail.seller === 'Acme');
        ck('  how much had been paid', row.detail && row.detail.paid === 12000);
        ck('  and every payment individually',
           row.detail && Array.isArray(row.detail.payments) && row.detail.payments.length === 1
           && row.detail.payments[0].mode === 'Wire' && row.detail.payments[0].amount === 12000,
           'a total alone cannot answer "was it one wire or six"');
    }

    // Append-only, and it means it. There is no exported way to remove a row,
    // which is the difference between evidence and a draft.
    ck('the log offers no way to delete from it',
       typeof audit.deleteEntry !== 'function' && typeof audit.clear !== 'function'
       && typeof audit.trim !== 'function',
       'a log the privileged profile can prune is not a log');

    // Oldest first. A timeline read backwards is a timeline nobody trusts.
    const many = audit.listEntries();
    ck('  and it reads as a timeline, oldest first',
       many.length < 2 || many[0].at <= many[many.length - 1].at);

    // It lands where the nightly Drive backup will find it. A log that only
    // exists on the disk it is meant to outlive is not a log.
    ck('the log lives under DATA_DIR, so the nightly backup takes it',
       String(cfg.AUDIT_LOG_FILE).startsWith(String(cfg.DATA_DIR)),
       'helpers/backup.js walks DATA_DIR — outside it, the log dies with the machine');
    ck('  and it is not mistaken for a credential and skipped',
       !/gdrive-sa|gmail-|credentials?\.json$|token.*\.json$/i.test(path.basename(cfg.AUDIT_LOG_FILE)),
       'backup.js excludes files matching those patterns by NAME');
}

// ── H. a misconfigured password does not silently promote anyone ──────────
section('H — JARVIS_PASSWORD identical to another tier');
{
    // The dangerous misconfiguration. If it equalled ADMIN_PASSWORD, the
    // check order would promote every admin login to super, and an admin
    // session that can suddenly erase paid loads looks exactly like a working
    // admin session. So the profile refuses to activate instead.
    const saved = process.env.JARVIS_PASSWORD;
    process.env.JARVIS_PASSWORD = 'admin-password-bbb';
    delete require.cache[require.resolve(path.join(ROOT, 'config'))];
    delete require.cache[require.resolve(path.join(ROOT, 'api'))];
    const cfg2 = require(path.join(ROOT, 'config'));
    ck('config reads the duplicate', cfg2.JARVIS_PASSWORD === cfg2.ADMIN_PASSWORD);

    const app2 = require(path.join(ROOT, 'api')).createApi();
    const srv2 = await new Promise((r) => { const s = app2.listen(0, '127.0.0.1', () => r(s)); });
    const base2 = `http://127.0.0.1:${srv2.address().port}`;
    const res = await new Promise((resolve, reject) => {
        const data = JSON.stringify({ password: 'admin-password-bbb' });
        const r2 = http.request(base2 + '/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        }, (res2) => { let raw = ''; res2.on('data', (c) => { raw += c; }); res2.on('end', () => resolve(JSON.parse(raw || '{}'))); });
        r2.on('error', reject); r2.write(data); r2.end();
    });
    ck('the shared password logs in as plain admin', res.role === 'admin');
    ck('  and is NOT promoted to super', res.super === false,
       'otherwise setting the two the same silently hands every admin the power to erase paid loads');
    srv2.close();

    process.env.JARVIS_PASSWORD = saved;
    delete require.cache[require.resolve(path.join(ROOT, 'config'))];
    delete require.cache[require.resolve(path.join(ROOT, 'api'))];
}

// ── I. both clients, same rules ───────────────────────────────────────────
section('I — the app and the website agree');
{
    // The last time a rule was added to one client and not the other, it
    // shipped broken to the one nobody tested. Both files, every time.
    const CLIENTS = [
        ['app', fs.readFileSync(path.join(ROOT, 'mobile-app/www/index.html'), 'utf8')],
        ['website', fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8')],
    ];
    // Comments are stripped before matching — a comment describing the thing
    // being asserted has passed this kind of check four times in this repo.
    const nocomment = (t) => String(t).split('\n').filter((l) => !/^\s*(\/\/|\*|<!--)/.test(l)).join('\n');

    function grab(src, name) {
        const i = src.indexOf('function ' + name + '(');
        if (i < 0) return '';
        const bodyStart = src.indexOf(') {', src.indexOf('(', i)) + 2;
        let d = 0;
        for (let k = bodyStart; k < src.length; k++) {
            if (src[k] === '{') d++;
            else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
        }
        return '';
    }

    for (const [label, raw] of CLIENTS) {
        const src = nocomment(raw);
        ck(`${label}: has the flag`, /let IS_SUPER = false;/.test(src));
        ck(`${label}:   set from the server, not invented`, /IS_SUPER = (me|data)\.super === true;/.test(src),
           'a client-side default would grant the profile to whoever edits the page');
        ck(`${label}:   and the label says so`, /IS_SUPER \? 'Jarvis access'/.test(src),
           'a profile whose powers are invisible is one you stay signed into by accident');

        const del = nocomment(grab(raw, 'loadIsDeletable'));
        ck(`${label}: Delete is offered to Jarvis on a paid load`, /if \(IS_SUPER\) return true;/.test(del));
        ck(`${label}:   and still withheld from everyone else`,
           /Number\(p\.paid\) > 0/.test(del),
           'dropping the payment check entirely would show Delete to admin too');

        // ── SHE ASKED FOR THIS, AND IT WAS ALREADY TRUE ───────────────────
        // "for admin, before making payment, show delete button. for staff —
        // show delete option before payment." Delete on an unpaid load has
        // never been role-gated in either client. The risk with today's change
        // was never failing to add it; it was quietly REMOVING it while adding
        // a privileged tier above. So the absence of a role check is what is
        // pinned here, not its presence.
        // Window centred on the button, not starting at it — the condition
        // that decides whether it renders sits BEFORE the class name, so a
        // forward-only slice missed it and the check failed for the wrong
        // reason. The window is asserted to actually contain the condition
        // below, so a future edit that moves it cannot make this vacuous.
        const at = raw.indexOf('btn-delete-load');
        const cardDelete = raw.slice(at - 200, at + 200);
        ck(`${label}: Delete on an unpaid load is not role-gated`,
           /loadIsDeletable\(l\)/.test(cardDelete) && !/ROLE/.test(cardDelete),
           'gating it would take the button away from the staff who record the loads');
        ck(`${label}:   and loadIsDeletable itself does not consult ROLE`,
           !/\bROLE\b/.test(del),
           'the only inputs are the payment and the Jarvis flag');
    }

    // Re-sign is app-only — the website has no signature pad at all — so this
    // is asserted where it exists rather than pretended into both.
    const appSrc = fs.readFileSync(path.join(ROOT, 'mobile-app/www/index.html'), 'utf8');
    const resign = nocomment(grab(appSrc, 'loadIsResignable'));
    ck('app: re-sign is offered to Jarvis', /if \(IS_SUPER\) return true;/.test(resign));
    const site = fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8');
    ck('  and the website genuinely has no signing to mirror', !/seller_signature/.test(site),
       'if this ever fails, the website grew a signature pad and needs the same rule');

    // The prompts. Reworded 2026-09-03: "ask Are you sure you want to delete
    // etc..something similar".
    for (const [label, raw] of CLIENTS) {
        ck(`${label}: the ordinary delete asks "Are you sure"`,
           /Are you sure you want to delete load \$\{btn\.dataset\.id\}\?/.test(raw)
           && /Are you sure you want to delete sale \$\{btn\.dataset\.id\}\?/.test(raw));
        ck(`${label}:   deleting a PAID load asks a SECOND time`,
           /recorded as paid/.test(raw) && /logged against the Jarvis profile/.test(raw),
           'the first prompt talks about photos; erasing a payment record deserves its own question');
        ck(`${label}:   and the second one names the amount`,
           /payMoney\(paid\)/.test(raw),
           '"delete this load" and "erase the record of $12,000 paid" are different decisions');
    }
}

server.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  Failed:'); failures.forEach((f) => console.log('   - ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
})();
