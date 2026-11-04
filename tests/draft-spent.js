// ── tests/draft-spent.js ──────────────────────────────────────────────────
// Apsara, 2026-11-05: "as soon as it is created,it is appearing in purchase".
//
// WHAT IT ACTUALLY WAS. The sale itself was filed correctly — it went into
// outbound_loads.json and showed under Sales, and /api/loads did not contain
// it. What stayed behind was its DRAFT. The strip above the Loads deck is
// headed "Unfinished — not saved as loads yet", it is drawn above BOTH tabs,
// and it carries `seller`, so the sale she had just saved sat there looking
// like an unfinished purchase.
//
// clearLoadDraft() on the client clears localStorage only. NEITHER create
// route ever removed the server's copy — the only thing that deleted a draft
// was pressing Delete on it. draft_id existed solely so oncePerSave could
// stop a SECOND load being created from the same draft, and that guard reads
// the draft_id stored on the LOAD, not the draft record, so spending the
// draft does not weaken it. Section C holds that line.
//
// Written end to end against a real server, per CLAUDE.md rule 3: the fault
// lived in the gap between the route and the store, which is exactly where
// a helper test and a screen test can both be green and the feature wrong.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-spent-'));
process.env.DATA_DIR = tmp;
process.env.API_TOKEN = 't';
const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'config.js'));

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');
const asArray = (a) => (Array.isArray(a) ? a : []);

const app = require(path.join(ROOT, 'api.js')).createApi();
const srv = http.createServer(app).listen(0);
const call = (m, p, b) => new Promise((r) => {
    const d = b ? JSON.stringify(b) : null;
    const q = http.request({ port: srv.address().port, path: p, method: m,
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json',
            ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
        (x) => { let s = ''; x.on('data', (c) => (s += c)); x.on('end', () => {
            try { r(JSON.parse(s)); } catch (e) { r(s); } }); });
    q.on('error', () => r(null));
    if (d) q.write(d);
    q.end();
});
const item = () => ({ description: 'Al wheels', gross_weight: 1000, tare_weight: 0, price: 0.5, unit: 'lb' });
const draftsNow = async () => asArray(await call('GET', '/api/load-drafts'));

(async () => {
await new Promise((r) => srv.once('listening', r));

// ══════════════════════════════════════════════════════════════════════════
section('A — a SALE spends its draft (the one she reported)');
// ══════════════════════════════════════════════════════════════════════════
{
    const d = await call('POST', '/api/load-drafts', { kind: 'sale', seller: 'SaleCo', items: [item()] });
    const did = d && d.id;
    ck('the draft exists before the save', (await draftsNow()).some((x) => x.id === did), String(did));

    const res = await call('POST', '/api/outbound-loads',
        { date: '2026-11-05', buyer: 'SaleCo', weight_unit: 'lb', items: [item()], draft_id: did });
    const id = res && res.load && res.load.id;
    ck('the sale is saved', !!id, JSON.stringify(res).slice(0, 140));

    const after = await draftsNow();
    ck('and the draft is GONE', !after.some((x) => x.id === did),
       JSON.stringify(after.map((x) => ({ id: x.id, kind: x.kind, seller: x.seller }))));
    // The whole point: the strip is drawn above both tabs, so a leftover
    // draft is what she was seeing while looking at Purchases.
    ck('  so nothing is left to show above the Purchases tab', after.length === 0, String(after.length));

    // And the sale is still only where it belongs.
    const purchases = asArray(await call('GET', '/api/loads'));
    const sales = asArray(await call('GET', '/api/outbound-loads'));
    ck('the sale is in Sales and NOT in Purchases',
       sales.some((l) => l.id === id) && !purchases.some((l) => l.id === id),
       `purchases=${purchases.length} sales=${sales.length}`);
}

// ══════════════════════════════════════════════════════════════════════════
section('B — a PURCHASE spends its draft too');
// ══════════════════════════════════════════════════════════════════════════
// She reported the sale. The leftover was never sale-specific — neither
// route removed it — so fixing one side only would have left the identical
// fault on the other and made the two routes disagree about draft_id.
{
    const d = await call('POST', '/api/load-drafts', { kind: 'purchase', seller: 'BuyCo', items: [item()] });
    const did = d && d.id;
    const res = await call('POST', '/api/loads',
        { date: '2026-11-05', seller: 'BuyCo', weight_unit: 'lb', items: [item()], draft_id: did });
    ck('the purchase is saved', !!(res && res.load && res.load.id), JSON.stringify(res).slice(0, 140));
    ck('and its draft is GONE as well', !(await draftsNow()).some((x) => x.id === did));
}

// ══════════════════════════════════════════════════════════════════════════
section('C — what spending the draft must NOT break');
// ══════════════════════════════════════════════════════════════════════════
{
    // ONE DRAFT, ONE LOAD — Apsara, 2026-09-29: "ALWAYS ONE LOAD SHOULD BE
    // CREATED". The guard reads the draft_id stored on the LOAD, so it must
    // still hold now that the draft record itself is gone. If this ever
    // fails, deleting the draft has re-opened the duplicate she reported in
    // September.
    const d = await call('POST', '/api/load-drafts', { kind: 'sale', seller: 'TwiceCo', items: [item()] });
    const did = d && d.id;
    const first = await call('POST', '/api/outbound-loads',
        { date: '2026-11-05', buyer: 'TwiceCo', weight_unit: 'lb', items: [item()], draft_id: did });
    const second = await call('POST', '/api/outbound-loads',
        { date: '2026-11-05', buyer: 'TwiceCo', weight_unit: 'lb', items: [item()], draft_id: did });
    const a = first && first.load && first.load.id;
    const b = second && second.load && second.load.id;
    ck('re-sending the same draft still returns the SAME load', a && b && a === b, `${a} vs ${b}`);
    const sales = asArray(await call('GET', '/api/outbound-loads'));
    ck('  and did not create a second one',
       sales.filter((l) => l.buyer === 'TwiceCo').length === 1,
       String(sales.filter((l) => l.buyer === 'TwiceCo').length));

    // A save with NO draft must not disturb anyone else's drafts.
    const keep = await call('POST', '/api/load-drafts', { kind: 'purchase', seller: 'KeepCo', items: [item()] });
    await call('POST', '/api/outbound-loads',
        { date: '2026-11-05', buyer: 'NoDraftCo', weight_unit: 'lb', items: [item()] });
    ck('a save carrying no draft_id leaves other drafts alone',
       (await draftsNow()).some((x) => x.id === (keep && keep.id)));

    // An EDIT has no draft to spend, and the record still carries draft_id.
    // Deleting one there would eat a draft that was never this save's.
    const live = await call('POST', '/api/load-drafts', { kind: 'sale', seller: 'EditCo', items: [item()] });
    const created = await call('POST', '/api/outbound-loads',
        { date: '2026-11-05', buyer: 'EditCo2', weight_unit: 'lb', items: [item()] });
    await call('PUT', `/api/outbound-loads/${created.load.id}`,
        { date: '2026-11-05', buyer: 'EditCo2', weight_unit: 'lb', items: [item()], draft_id: live && live.id });
    ck('an EDIT does not eat a draft', (await draftsNow()).some((x) => x.id === (live && live.id)),
       'the edit route is deliberately not touched');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
srv.close();
if (fail) { console.log('FAILED:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.log('CRASHED: ' + (e && e.stack || e)); srv.close(); process.exit(1); });
