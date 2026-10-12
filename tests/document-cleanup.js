// ── tests/document-cleanup.js ─────────────────────────────────────────────
// Apsara, 2026-10-12: "i want clean up option in documents.i dont want to
// store old invoices" -> Invoice, Packing and Proforma tabs; rules: older than
// N days and keep-only-latest.
//
// END TO END (CLAUDE.md rule 3): a real server, the routes the buttons post
// to, and the stores read back afterwards. What it holds:
//   A  Preview changes nothing.
//   B  An invoice form is KEPT when its packing list stays (the packing list
//      reads its header from that form) — and goes with it when both go.
//   C  "Keep only the latest" trims versions and leaves the newest.
//   D  Apply refuses when the lists moved since the preview (409).
//   E  Proforma: old files go, recent ones stay.
//   F  Audited; unrelated stores untouched; bad input refused; admin only.
//   G  The three tabs mount the panel and post to these routes.

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-cleanup-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD   = 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = 'staff-pw-ccccccccccc';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('  ABORT  config not isolated'); process.exit(1); }

const docs = require(path.join(ROOT, 'helpers/documentsSaved'));
const audit = require(path.join(ROOT, 'helpers/audit'));
const DASH = fs.readFileSync(path.join(ROOT, 'dashboard/documents.html'), 'utf8');

const DAY = 86400000;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
const inv = (d, no) => ({ inv_no: no, buyer: 'Buyer ' + no, saved_at: ago(d) });

(async () => {

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
        res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
    });
    r2.on('error', reject); if (data) r2.write(data); r2.end();
});
const admin = ((await req('POST', '/login', { body: { password: 'admin-pw-bbbbbbbbbbb' } })).json || {}).sid;
const staff = ((await req('POST', '/login', { body: { password: 'staff-pw-ccccccccccc' } })).json || {}).sid;

// ── THE FIXTURE ─────────────────────────────────────────────────────────
//  OLD_KEEPPK  old form (200d), its packing list is RECENT  -> kept by the guard
//  OLD_BOTH    old form (200d), its packing list is old too  -> both go
//  OLD_ALONE   old form (200d), no packing list              -> goes
//  NEW_MANY    recent, 3 versions                            -> trimmed to 1 by keep-latest
//  NEW_ONE     recent, 1 version                             -> untouched
fs.writeFileSync(cfg.INVOICE_VERSIONS_FILE, JSON.stringify({
    OLD_KEEPPK: [inv(200, 'A1')], OLD_BOTH: [inv(210, 'B1'), inv(200, 'B2')], OLD_ALONE: [inv(205, 'C1')],
    NEW_MANY: [inv(20, 'D1'), inv(10, 'D2'), inv(2, 'D3')], NEW_ONE: [inv(3, 'E1')],
}));
const pk = (id, c, d) => ({ id, container_no: c, customer: 'Cust', invoice_no: 'X', rows: [], created_at: ago(d), updated_at: ago(d) });
fs.writeFileSync(cfg.PACKING_LISTS_FILE, JSON.stringify([
    pk('PK_KEEP', 'OLD_KEEPPK', 5), pk('PK_BOTH', 'OLD_BOTH', 220), pk('PK_FRESH', 'NEW_ONE', 1),
]));
docs.saveProformaCopy(Buffer.from('%PDF old'), 'PF_OLD.pdf');
docs.saveProformaCopy(Buffer.from('%PDF new'), 'PF_NEW.pdf');
const old = new Date(Date.now() - 300 * DAY);
fs.utimesSync(path.join(cfg.DOCUMENTS_SAVED_DIR, 'proforma', 'PF_OLD.pdf'), old, old);
// An archived invoice PDF and a BOL: neither tab's clean-up may touch them.
docs.saveInvoiceCopy(Buffer.from('%PDF inv'), 'OLD_ALONE_inv.pdf', 'OLD_ALONE', '2026-01-01');
fs.writeFileSync(cfg.BANKS_FILE || path.join(cfg.DATA_DIR, 'banks.json'), '["Chase Bank"]');

const forms = () => readJson(cfg.INVOICE_VERSIONS_FILE, {});
const packs = () => readJson(cfg.PACKING_LISTS_FILE, []).map((r) => r.id).sort();
const snapshot = () => JSON.stringify([forms(), packs(), docs.listSavedProformas()]);

// ══════════════════════════════════════════════════════════════════════════
section('A — preview changes nothing');
// ══════════════════════════════════════════════════════════════════════════
const before = snapshot();
const rule = { kinds: ['invoice', 'packing', 'proforma'], olderThanDays: 90, keepLatestOnly: true };
const pv = await req('POST', '/api/documents/cleanup/preview', { sid: admin, body: rule });
ck('preview answers 200', pv.status === 200, `${pv.status} ${JSON.stringify(pv.json)}`);
ck('  and changed nothing at all', snapshot() === before);
const plan = (pv.json || {}).plan || {};

// ══════════════════════════════════════════════════════════════════════════
section('B — an invoice form stays while its packing list stays');
// ══════════════════════════════════════════════════════════════════════════
const goingForms = (plan.invoice || []).map((r) => r.container).sort();
ck('OLD_KEEPPK is NOT in the plan', !goingForms.includes('OLD_KEEPPK'), JSON.stringify(goingForms));
ck('  and is reported as kept, with the reason',
   (plan.skipped || []).some((s) => s.label === 'OLD_KEEPPK' && /packing list/.test(s.reason)), JSON.stringify(plan.skipped));
ck('OLD_BOTH goes (its packing list goes too)', goingForms.includes('OLD_BOTH'));
ck('OLD_ALONE goes', goingForms.includes('OLD_ALONE'));
ck('the old packing list is in the plan, the recent ones are not',
   JSON.stringify((plan.packing || []).map((r) => r.id)) === JSON.stringify(['PK_BOTH']), JSON.stringify(plan.packing));

// The same guard when ONLY the invoice tab is cleaned: OLD_BOTH's packing
// list is not being removed, so its form must stay.
const only = await req('POST', '/api/documents/cleanup/preview', { sid: admin, body: { kinds: ['invoice'], olderThanDays: 90 } });
const onlyGoing = ((only.json.plan || {}).invoice || []).map((r) => r.container);
ck('cleaning the Invoice tab alone keeps OLD_BOTH (its packing list is not going)', !onlyGoing.includes('OLD_BOTH'), JSON.stringify(onlyGoing));
ck('  but still removes OLD_ALONE', onlyGoing.includes('OLD_ALONE'));

// ══════════════════════════════════════════════════════════════════════════
section('C — "keep only the latest" trims, never empties');
// ══════════════════════════════════════════════════════════════════════════
const many = (plan.invoice || []).find((r) => r.container === 'NEW_MANY');
ck('NEW_MANY is planned as "drop older versions"', many && many.mode === 'older-versions' && many.dropping === 2, JSON.stringify(many));
ck('NEW_ONE (single version) is not in the plan', !goingForms.includes('NEW_ONE'));

// ══════════════════════════════════════════════════════════════════════════
section('D — apply refuses when the preview is stale');
// ══════════════════════════════════════════════════════════════════════════
const stale = await req('POST', '/api/documents/cleanup', { sid: admin, body: { ...rule, expected_count: plan.count + 1 } });
ck('wrong expected_count -> 409', stale.status === 409 && stale.json.code === 'PREVIEW_STALE', `${stale.status} ${JSON.stringify(stale.json)}`);
ck('  and nothing was removed', snapshot() === before);
const none = await req('POST', '/api/documents/cleanup', { sid: admin, body: { ...rule } });
ck('missing expected_count -> 409 too', none.status === 409, String(none.status));

// ══════════════════════════════════════════════════════════════════════════
section('E — apply, with the count the preview showed');
// ══════════════════════════════════════════════════════════════════════════
const go = await req('POST', '/api/documents/cleanup', { sid: admin, body: { ...rule, expected_count: plan.count } });
ck('apply answers 200', go.status === 200 && go.json.ok, `${go.status} ${JSON.stringify(go.json)}`);
const f = forms();
ck('OLD_ALONE and OLD_BOTH forms are gone', !('OLD_ALONE' in f) && !('OLD_BOTH' in f), Object.keys(f).join(','));
ck('OLD_KEEPPK form survives (its packing list is staying)', 'OLD_KEEPPK' in f);
ck('NEW_MANY is trimmed to its newest version, D3', f.NEW_MANY && f.NEW_MANY.length === 1 && f.NEW_MANY[0].inv_no === 'D3', JSON.stringify(f.NEW_MANY));
ck('NEW_ONE untouched', f.NEW_ONE && f.NEW_ONE.length === 1);
ck('only the old packing list went', JSON.stringify(packs()) === JSON.stringify(['PK_FRESH', 'PK_KEEP']), JSON.stringify(packs()));
ck('the old proforma went, the new one stayed',
   !docs.listSavedProformas().includes('PF_OLD.pdf') && docs.listSavedProformas().includes('PF_NEW.pdf'), JSON.stringify(docs.listSavedProformas()));
ck('the archived invoice PDF is untouched',
   docs.listSavedInvoices().some((x) => x.container === 'OLD_ALONE' && x.files.includes('OLD_ALONE_inv.pdf')));
ck('banks.json untouched', fs.existsSync(path.join(cfg.DATA_DIR, 'banks.json')));

// ══════════════════════════════════════════════════════════════════════════
section('F — audited, validated, admin only');
// ══════════════════════════════════════════════════════════════════════════
const ent = audit.listEntries().filter((e) => e.action === 'cleanup-saved-documents');
ck('one audit entry for the run', ent.length === 1, String(ent.length));
ck('  recording the rule and what went', ent[0] && ent[0].detail && ent[0].detail.rule && ent[0].detail.rule.olderThanDays === 90
   && ent[0].detail.proforma.includes('PF_OLD.pdf'), JSON.stringify(ent[0] && ent[0].detail));
ck('  and stamped with an outcome', !!(ent[0] && ent[0].outcome && ent[0].outcome !== 'started'));
const bad = [
    ['7 is the floor, 3 days is refused', { kinds: ['invoice'], olderThanDays: 3 }],
    ['no kinds', { olderThanDays: 90 }],
    ['unknown kind', { kinds: ['bol'], olderThanDays: 90 }],
    ['no rule at all', { kinds: ['invoice'] }],
    ['packing with only keep-latest (no age)', { kinds: ['packing'], keepLatestOnly: true }],
];
for (const [name, body] of bad) {
    const r = await req('POST', '/api/documents/cleanup/preview', { sid: admin, body });
    ck(`refused: ${name}`, r.status === 400, `${r.status} ${JSON.stringify(r.json)}`);
}
const st = await req('POST', '/api/documents/cleanup/preview', { sid: staff, body: rule });
ck('staff cannot preview', st.status === 401 || st.status === 403, String(st.status));
const st2 = await req('POST', '/api/documents/cleanup', { sid: staff, body: { ...rule, expected_count: 0 } });
ck('staff cannot apply', st2.status === 401 || st2.status === 403, String(st2.status));
const after2 = snapshot();
await req('POST', '/api/documents/cleanup', { sid: admin, body: { ...rule, expected_count: 0 } });
ck('running it again finds nothing more to remove and breaks nothing', snapshot() === after2);

// ══════════════════════════════════════════════════════════════════════════
section('G — the three tabs mount the panel and post to these routes');
// ══════════════════════════════════════════════════════════════════════════
for (const k of ['invoice', 'packing', 'proforma']) {
    ck(`<div data-cleanup="${k}"> is on the page`, DASH.includes(`<div data-cleanup="${k}"></div>`));
}
ck('the panel posts to /api/documents/cleanup/preview', DASH.includes("'/api/documents/cleanup/preview'"));
ck('  and applies with expected_count', /\/api\/documents\/cleanup'[^\n]*expected_count/.test(DASH));
ck('  and refreshes the right list afterwards', /cleanupRefresh/.test(DASH) && /loadSavedPackingLists\(\)/.test(DASH));

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
