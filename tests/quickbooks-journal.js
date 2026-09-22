// ── tests/quickbooks-journal.js ────────────────────────────────────────────
// Guards helpers/quickbooks/journal.js. Apsara: "we might need to find any
// discrepancy in payments later and might undo it." Worst failures first:
//   1. an undo deleting a record Jarvis did NOT create (hers / the accountant's)
//   2. an undo deleting something someone has since edited or paid against
//   3. a bill undone while the Jarvis payment against it still stands
//   4. a change in QuickBooks (deleted, re-pointed, re-totalled) not reported
//   5. the journal being rewritten instead of appended
const path = require('path'); const fs = require('fs'); const os = require('os');
let pass = 0, fail = 0; const failures = [];
const ck = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (x) console.log('        ' + x); } };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-journal-'));
process.env.DATA_DIR = TMP;
process.env.QB_JOURNAL_FILE = path.join(TMP, 'j.jsonl');
process.env.QB_LINKS_FILE = path.join(TMP, 'links.json');
process.env.QB_TOKEN_FILE = path.join(TMP, 'tok.json');
process.env.QB_SANDBOX_CLIENT_ID = 'x'; process.env.QB_SANDBOX_CLIENT_SECRET = 'y'; process.env.QB_SANDBOX_REDIRECT_URI = 'http://localhost/cb';
fs.writeFileSync(process.env.QB_TOKEN_FILE, JSON.stringify({ realmId: '1', access_token: 'a', refresh_token: 'r', access_expires_at: Date.now() + 3600e3, refresh_expires_at: Date.now() + 1e10 }));
const J = require('../helpers/quickbooks/journal');
const env = 'sandbox';

// a tiny QuickBooks: records by type/id, deletes counted
function fakeQB(db) {
    const calls = [];
    const f = async (url, o) => {
        calls.push({ url, method: o.method, body: o.body });
        const m = url.match(/\/v3\/company\/1\/(\w+?)(?:\/(\d+))?(\?|$)/);
        const type = { bill: 'Bill', invoice: 'Invoice', billpayment: 'BillPayment', payment: 'Payment' }[m[1]];
        if (o.method === 'GET') { const r = db[`${type}:${m[2]}`]; return r ? ok({ [type]: r }) : { ok: false, status: 400, text: async () => '{"Fault":{"Error":[{"Message":"Object Not Found"}]}}', headers: { get: () => null } }; }
        if (/operation=delete/.test(url)) { const b = JSON.parse(o.body); delete db[`${type}:${b.Id}`]; return ok({ [type]: { Id: b.Id, status: 'Deleted' } }); }
    };
    const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body), headers: { get: () => null } });
    f.calls = calls; return f;
}
const links = (o) => fs.writeFileSync(process.env.QB_LINKS_FILE, JSON.stringify(o));
const readLinks = () => JSON.parse(fs.readFileSync(process.env.QB_LINKS_FILE, 'utf8'));

(async () => {
    const db = {
        'Bill:145': { Id: '145', SyncToken: '0', TotalAmt: 45100, Balance: 45100, VendorRef: { value: '58', name: 'Mazariegos Recycling' } },
        'Bill:38940': { Id: '38940', SyncToken: '3', TotalAmt: 45100, Balance: 0, VendorRef: { value: '444', name: 'Mazariegos Recycling' } },
        'BillPayment:200': { Id: '200', SyncToken: '0', TotalAmt: 45100, VendorRef: { value: '58' }, Line: [{ Amount: 45100, LinkedTxn: [{ TxnId: '145', TxnType: 'Bill' }] }] },
    };
    const f = fakeQB(db);
    links({ 'sandbox:bill:b1': { qbId: '145' }, 'sandbox:bill:b2': { qbId: '38940' }, 'sandbox:billpayment:p1': { qbId: '200' } });
    const eBill = J.record({ env, kind: 'bill', action: 'created', linkKey: 'sandbox:bill:b1', jarvis: { id: 'b1', container: 'SEKU4687753' }, qb: { id: '145', syncToken: '0', total: 45100, partyId: '58' }, jarvisTotal: 45100 });
    const eHers = J.record({ env, kind: 'bill', action: 'linked-existing', linkKey: 'sandbox:bill:b2', jarvis: { id: 'b2' }, qb: { id: '38940', total: 45100, partyId: '444' }, jarvisTotal: 45100 });
    const ePay = J.record({ env, kind: 'billpayment', action: 'created', linkKey: 'sandbox:billpayment:p1', jarvis: { id: 'p1', allocations: [{ bill_id: 'b1', amount: 45100 }] }, qb: { id: '200', syncToken: '0', total: 45100, partyId: '58', linked: [{ type: 'Bill', id: '145', amount: 45100 }] }, jarvisTotal: 45100 });
    J.record({ env, kind: 'payment', action: 'asked', jarvis: { id: 'r1' }, qb: {}, candidates: [{ type: 'Deposit', Id: '9' }], reason: 'same amount already arrived' });

    console.log('\n── fingerprint ──');
    const docA = { DocNumber: 'X1', TxnDate: '2026-09-10', VendorRef: { value: '5' }, TotalAmt: 100, SyncToken: '0', Line: [{ Amount: 100, DetailType: 'ItemBasedExpenseLineDetail', ItemBasedExpenseLineDetail: { ItemRef: { value: '7' }, Qty: 100, UnitPrice: 1 } }] };
    ck('a payment linking the bill (SyncToken bump) is not an edit', J.fingerprint(docA) === J.fingerprint({ ...docA, SyncToken: '3', Balance: 0 }));
    ck('a changed line IS an edit', J.fingerprint(docA) !== J.fingerprint({ ...docA, Line: [{ ...docA.Line[0], Amount: 90 }] }));
    ck('a moved date IS an edit', J.fingerprint(docA) !== J.fingerprint({ ...docA, TxnDate: '2026-09-11' }));

    console.log('\n── recording ──');
    ck('every decision is a journal line', J.list({ env }).length === 4);
    ck('asked is recorded but is not a standing link', J.active(env).length === 3);
    let e = ''; try { J.record({ env, kind: 'cheque', action: 'created' }); } catch (x) { e = x.message; }
    ck('unknown kind refused', /journal kind/.test(e));

    console.log('\n── discrepancies (read-only) ──');
    let d = await J.discrepancies({ env, fetchImpl: f });
    ck('all agree -> nothing reported', d.length === 0, JSON.stringify(d));
    ck('discrepancy check made no writes', f.calls.every((c) => c.method === 'GET'));
    db['BillPayment:200'].Line = [{ Amount: 45100, LinkedTxn: [{ TxnId: '999', TxnType: 'Bill' }] }];
    db['Bill:38940'].TotalAmt = 44000;
    d = await J.discrepancies({ env, fetchImpl: f });
    ck('payment re-pointed to another bill is reported', d.some((x) => x.journalId === ePay.id && /now pays Bill:999/.test(x.issues.join())), JSON.stringify(d));
    ck('her bill re-totalled is reported', d.some((x) => x.journalId === eHers.id && /total was 45100, now 44000/.test(x.issues.join())));
    db['BillPayment:200'].Line = [{ Amount: 45100, LinkedTxn: [{ TxnId: '145', TxnType: 'Bill' }] }]; db['Bill:38940'].TotalAmt = 45100;

    console.log('\n── undo ──');
    let u = await J.undo(eBill.id, { env, fetchImpl: f, dryRun: false, reason: 'test' });
    ck('bill with a standing Jarvis payment is refused', u.status === 'refused' && /payment/.test(u.why));
    u = await J.undo(ePay.id, { env, fetchImpl: f, dryRun: false });
    ck('undo without a reason is refused', u.status === 'refused' && /reason/.test(u.why));
    u = await J.undo(ePay.id, { env, fetchImpl: f, dryRun: true, reason: 'wrong bank' });
    ck('dry run deletes nothing', u.status === 'would-delete' && db['BillPayment:200']);
    u = await J.undo(ePay.id, { env, fetchImpl: f, dryRun: false, reason: 'wrong bank' });
    ck('Jarvis payment undone -> deleted in QB', u.status === 'undone' && !db['BillPayment:200']);
    ck('its link is forgotten', !readLinks()['sandbox:billpayment:p1']);
    const undoneLine = J.list({ env }).find((x) => x.action === 'undone');
    ck('deleted record copied into the journal first', undoneLine && undoneLine.deletedRecord && undoneLine.deletedRecord.TotalAmt === 45100);
    ck('original line still there — journal only appends', J.list({ env }).some((x) => x.id === ePay.id));
    u = await J.undo(ePay.id, { env, fetchImpl: f, dryRun: false, reason: 'again' });
    ck('cannot undo twice', u.status === 'refused');

    db['Bill:145'].SyncToken = '1';
    u = await J.undo(eBill.id, { env, fetchImpl: f, dryRun: true, reason: 'test' });
    ck('bill only re-versioned (a payment came and went) -> still undoable', u.status === 'would-delete', JSON.stringify(u));
    db['Bill:145'].TotalAmt = 45000;
    u = await J.undo(eBill.id, { env, fetchImpl: f, dryRun: false, reason: 'test' });
    ck('bill re-totalled in QB since -> refused', u.status === 'refused' && /edited/.test(u.why));
    db['Bill:145'].TotalAmt = 45100; db['Bill:145'].SyncToken = '0'; db['Bill:145'].Balance = 100;
    u = await J.undo(eBill.id, { env, fetchImpl: f, dryRun: false, reason: 'test' });
    ck('bill with money paid against it -> refused', u.status === 'refused' && /paid against/.test(u.why));
    db['Bill:145'].Balance = 45100;
    u = await J.undo(eBill.id, { env, fetchImpl: f, dryRun: false, reason: 'wrong grade' });
    ck('clean Jarvis bill undone', u.status === 'undone' && !db['Bill:145']);

    const before = f.calls.filter((c) => /operation=delete/.test(c.url)).length;
    u = await J.undo(eHers.id, { env, fetchImpl: f, dryRun: false, reason: 'wrong container' });
    ck('undoing a link to HER bill only forgets the link', u.status === 'unlinked' && db['Bill:38940']);
    ck('...and sends no delete to QuickBooks', f.calls.filter((c) => /operation=delete/.test(c.url)).length === before);
    ck('nothing left standing', J.active(env).length === 0);
    const lines = fs.readFileSync(process.env.QB_JOURNAL_FILE, 'utf8').trim().split('\n');
    ck('journal is one JSON object per line', lines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }));
    fs.appendFileSync(process.env.QB_JOURNAL_FILE, '{"torn":');
    ck('a torn last line does not break reading', J.list({ env }).length === lines.length);

    console.log('\n── every write is tracked ──');
    const raw = J.list({ env, kind: 'raw' });
    const deletes = f.calls.filter((c) => /operation=delete/.test(c.url)).length;
    ck('each delete has an intent line and a done line', raw.filter((r) => r.phase === 'intent').length === deletes && raw.filter((r) => r.phase === 'done').length === deletes, JSON.stringify(raw.map((r) => r.phase)));
    ck('done line carries the QuickBooks answer', raw.filter((r) => r.phase === 'done').every((r) => r.result && r.result.Id));
    const client = require('../helpers/quickbooks/client');
    const failing = async () => ({ ok: false, status: 500, text: async () => 'boom', headers: { get: () => null } });
    await client.request('POST', '/bill', { x: 1 }, { env, fetchImpl: failing }).catch(() => {});
    const last = J.list({ env, kind: 'raw' }).slice(-2);
    ck('a failed write is recorded as failed, with the intent before it', last[0].phase === 'intent' && last[1].phase === 'failed' && last[1].id === last[0].id);
    ck('intent line keeps what was sent', last[0].body && last[0].body.x === 1);
    fs.writeFileSync(path.join(TMP, 'tok-prod.json'), fs.readFileSync(process.env.QB_TOKEN_FILE));
    await client.request('POST', '/bill', {}, { env: 'production', fetchImpl: f }).catch(() => {});
    ck('a refused live write is logged too', J.list({ env: 'production', kind: 'raw' }).some((r) => r.phase === 'refused'));
    const jf = process.env.QB_JOURNAL_FILE;
    process.env.QB_JOURNAL_FILE = path.join(TMP, 'no-such-dir', 'j.jsonl');
    const sent = f.calls.length; let blocked = '';
    await client.request('POST', '/bill', {}, { env, fetchImpl: f }).catch((e) => { blocked = e.message; });
    ck('journal cannot be written -> the write is NOT sent', f.calls.length === sent && blocked);
    process.env.QB_JOURNAL_FILE = jf;
    fs.appendFileSync(jf, JSON.stringify({ id: 'J_dead', at: 'x', env, kind: 'raw', action: 'write', phase: 'intent', method: 'POST', path: '/payment' }) + '\n');
    d = await J.discrepancies({ env, fetchImpl: f });
    ck('a write started but never confirmed is reported', d.some((x) => x.journalId === 'J_dead' && /never confirmed/.test(x.issues[0])));

    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(`\nquickbooks-journal: ${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
