// ── tests/one-draft-one-load.js ───────────────────────────────────────────
// Apsara, 2026-09-29, on a screenshot of the same load listed twice
// (EDGE_98 and EDGE_99), explaining how it happened: "He just saved it
// first.then edit ,continue or cancel.he clicked continue,then it generated
// twice". Shown a fix that narrowed the window between the save and the
// draft's deletion, she rejected it:
//
//     "NO..IT IS BUSINESS LOGIC LOSE.ALWAYS ONE LOAD SHOULD BE CREATED"
//
// She is right and the distinction matters, so it is worth writing down.
// tests/load-draft-race.js proves ONE ROUTE to the duplicate is closed. This
// file proves the RULE: a draft may become a load once, and every later
// attempt gets that same load back. The difference shows up in section D,
// where the second save is not a race at all — it is a person deliberately
// pressing Continue, minutes later, after an edit.
//
// ── WHY THE CLIENT_REQUEST_ID TICKET COULD NOT DO THIS ────────────────────
// The ticket in helpers/oncePerSave.js is minted per SAVE ATTEMPT, which is
// correct for the retry it was built for and useless here: Save, edit,
// Continue mints two different tickets and the server honours both. Every
// section below therefore sends DIFFERENT tickets, because sending the same
// one would let the old guard pass this file and prove nothing.

const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// Set BEFORE config is required — config reads the environment at require
// time, so a password assigned further down the file is assigned too late
// and the login in section E silently fails.
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD   = process.env.APP_PASSWORD   || 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'staff-pw-ccccccccccc';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-onedraft-'));
process.env.DATA_DIR = TMP;
process.env.LOADS_FILE = path.join(TMP, 'loads.json');
process.env.OUTBOUND_LOADS_FILE = path.join(TMP, 'outbound_loads.json');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const cfg = require('../config');
cfg.LOADS_FILE = path.join(TMP, 'loads.json');
cfg.OUTBOUND_LOADS_FILE = path.join(TMP, 'outbound_loads.json');
fs.writeFileSync(cfg.LOADS_FILE, '[]');
fs.writeFileSync(cfg.OUTBOUND_LOADS_FILE, '[]');

const once = require('../helpers/oncePerSave');
const loads = require('../helpers/loads');
const outbound = require('../helpers/outboundLoads');

const readIn  = () => JSON.parse(fs.readFileSync(cfg.LOADS_FILE, 'utf8'));
const readOut = () => JSON.parse(fs.readFileSync(cfg.OUTBOUND_LOADS_FILE, 'utf8'));

let ticketN = 0;
const freshTicket = () => `TICKET_${Date.now()}_${ticketN += 1}`;

const purchase = (draftId) => ({
    date: '2026-09-29', seller: 'Ramesh', weight_unit: 'lb',
    draft_id: draftId, client_request_id: freshTicket(),
    items: [{ description: 'Al combo', gross_weight: 1200, tare_weight: 200, price: 0.62 }],
});
const sale = (draftId) => ({
    date: '2026-09-29', buyer: 'Darwin', weight_unit: 'lb',
    draft_id: draftId, client_request_id: freshTicket(),
    items: [{ description: 'Al combo', gross_weight: 900, tare_weight: 0, price: 0.81 }],
});

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — the key itself');

ck('a draft id is accepted', once.normDraftId('DRAFT_1759180000000_ab12cd') === 'DRAFT_1759180000000_ab12cd');
ck('it is trimmed', once.normDraftId('  DRAFT_x  ') === 'DRAFT_x');
// Everything below is a value a client could plausibly send when there is no
// draft. Each must read as "no draft" rather than becoming a key — two saves
// that both send '' would otherwise collide and the SECOND real load of the
// day would vanish into the first.
for (const junk of ['', '   ', null, undefined, 'null', 'undefined', 'false', '0', 42, {}, [], 'EDGE_98']) {
    ck(`${JSON.stringify(junk)} is not a draft id`, once.normDraftId(junk) === null);
}
ck('an over-long value is refused', once.normDraftId('DRAFT_' + 'x'.repeat(200)) === null);

ck('findByDraft finds the load that carries it',
   once.findByDraft([{ id: 'A', draft_id: 'DRAFT_1' }, { id: 'B', draft_id: 'DRAFT_2' }], 'DRAFT_2').id === 'B');
ck('findByDraft on a draft nothing carries is null',
   once.findByDraft([{ id: 'A', draft_id: 'DRAFT_1' }], 'DRAFT_9') === null);
ck('findByDraft with no draft id is null — NOT the first row',
   once.findByDraft([{ id: 'A' }, { id: 'B' }], null) === null,
   'a null key matching a row with no draft_id would make every ticketless save return row A');
ck('rows with no draft_id are skipped, not matched',
   once.findByDraft([{ id: 'A' }, { id: 'B', draft_id: '' }, { id: 'C', draft_id: 'DRAFT_7' }], 'DRAFT_7').id === 'C');
ck('a null row does not throw', once.findByDraft([null, { id: 'C', draft_id: 'DRAFT_7' }], 'DRAFT_7').id === 'C');
ck('an empty list is null', once.findByDraft([], 'DRAFT_7') === null);
ck('an undefined list is null', once.findByDraft(undefined, 'DRAFT_7') === null);

// ── NO CLOCK IN IT ────────────────────────────────────────────────────────
// findSpent forgets a ticket after 24h. If findByDraft inherited that, a
// draft left open over a long weekend would create a second load on Monday
// and the rule would hold only for a day.
{
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const found = once.findByDraft([{ id: 'OLD', draft_id: 'DRAFT_OLD', created_at: old }], 'DRAFT_OLD');
    ck('a draft from a year ago is STILL spent',
       found && found.id === 'OLD',
       '"ALWAYS ONE LOAD" has no expiry in it — a TTL here would quietly reintroduce the duplicate');
}

// ══════════════════════════════════════════════════════════════════════════
section('B — a purchase draft creates one load, however many saves arrive');

{
    const d = 'DRAFT_1759180000001_aaa111';
    const first = await loads.addLoad(purchase(d));
    const second = await loads.addLoad(purchase(d));   // different ticket
    ck('the second save wrote nothing', readIn().length === 1, `file holds ${readIn().length}`);
    ck('and got the FIRST load back', second.id === first.id, `${second.id} vs ${first.id}`);
    ck('the load records which draft it came from', readIn()[0].draft_id === d);

    // The thing that actually reached her: EDGE_98 and EDGE_99, consecutive.
    ck('no second id was minted', !readIn().some((l) => l.id !== first.id));
}
{
    // Two at once — the race, which the key must also survive because the
    // lookup runs inside mutateJson rather than before it.
    const d = 'DRAFT_1759180000002_bbb222';
    const [a, b] = await Promise.all([loads.addLoad(purchase(d)), loads.addLoad(purchase(d))]);
    ck('simultaneous saves of one draft produce one load', readIn().length === 2, `file holds ${readIn().length}`);
    ck('and both callers hold the same id', a.id === b.id, `${a.id} vs ${b.id}`);
}
{
    // The guard must not become a ceiling on real work.
    const before = readIn().length;
    await loads.addLoad(purchase('DRAFT_1759180000003_ccc333'));
    await loads.addLoad(purchase('DRAFT_1759180000004_ddd444'));
    ck('two DIFFERENT drafts still make two loads', readIn().length === before + 2);
}
{
    const before = readIn().length;
    const p1 = purchase(null); const p2 = purchase(null);
    await loads.addLoad(p1); await loads.addLoad(p2);
    ck('two saves with NO draft id still make two loads', readIn().length === before + 2,
       'the voice path and a straight-through save carry no draft — they must be unaffected');
}

// ══════════════════════════════════════════════════════════════════════════
section('C — the same, on the sale side');

{
    const d = 'DRAFT_1759180000005_eee555';
    const first = await outbound.addOutboundLoad(sale(d));
    const second = await outbound.addOutboundLoad(sale(d));
    ck('one outbound load', readOut().length === 1, `file holds ${readOut().length}`);
    ck('and the first record came back', second.id === first.id);
    ck('it carries the draft id', readOut()[0].draft_id === d);
}
{
    const before = readOut().length;
    await outbound.addOutboundLoad(sale('DRAFT_1759180000006_fff666'));
    ck('a different sale draft still saves', readOut().length === before + 1);
}

// ══════════════════════════════════════════════════════════════════════════
section('D — HER SEQUENCE: save, EDIT, continue');
// ══════════════════════════════════════════════════════════════════════════
// "He just saved it first.then edit ,continue or cancel.he clicked continue,
// then it generated twice."
//
// The edit is the part that nearly broke this. buildRecord rebuilds an
// outbound load from a fixed field list and wipes anything it does not name
// — the trap helpers/outboundLoads.js already records having sprung once on
// pdf_link, and again on delivery_status. draft_id is exactly that shape: an
// edit that forgot it would hand the draft back its freedom to create a
// second load, and the test above would still be green.

{
    const d = 'DRAFT_1759180000007_ggg777';
    const first = await outbound.addOutboundLoad(sale(d));
    await outbound.editOutboundLoad(first.id, { ...sale(d), buyer: 'Darwin Metals' });
    const kept = readOut().find((l) => l.id === first.id);
    ck('the edit kept the draft id', kept && kept.draft_id === d,
       `after the edit the load carries ${JSON.stringify(kept && kept.draft_id)} — a wiped id frees the draft`);
    ck('the edit did apply', kept && kept.buyer === 'Darwin Metals');

    const before = readOut().length;
    const continued = await outbound.addOutboundLoad(sale(d));   // Continue
    ck('Continue after an edit creates NOTHING', readOut().length === before,
       `${readOut().length - before} extra load(s) — this is EDGE_98/EDGE_99 again`);
    ck('and returns the load she already has', continued.id === first.id);
}
{
    // Same sequence on a purchase. editLoad assigns a named patch onto the
    // existing record rather than rebuilding it, so draft_id survives for a
    // different reason — worth pinning, because a future refactor to
    // buildRecord-style would break it silently.
    const d = 'DRAFT_1759180000008_hhh888';
    const first = await loads.addLoad(purchase(d));
    await loads.editLoad(first.id, { ...purchase(d), seller: 'Ramesh Metals' });
    const kept = readIn().find((l) => l.id === first.id);
    ck('purchase edit kept the draft id', kept && kept.draft_id === d);
    ck('purchase edit did apply', kept && kept.seller === 'Ramesh Metals');
    const before = readIn().length;
    const continued = await loads.addLoad(purchase(d));
    ck('Continue after a purchase edit creates NOTHING', readIn().length === before);
    ck('and returns the existing load', continued.id === first.id);
}

// ══════════════════════════════════════════════════════════════════════════
section('E — END TO END, through the routes the screens actually post to');
// ══════════════════════════════════════════════════════════════════════════
// Apsara, 2026-09-17: "ALwyas test end to end when you add a new feature."
// Everything above can be green while the ROUTE drops draft_id on the floor,
// which is the single most likely way this ships broken.
{
    const http = require('http');
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

    const sid = ((await req('POST', '/login', { body: { password: process.env.ADMIN_PASSWORD } })).json || {}).sid;
    ck('signed in', !!sid);

    {
        const d = 'DRAFT_1759180000009_iii999';
        const before = readIn().length;
        const r1 = await req('POST', '/api/loads', { sid, body: purchase(d) });
        const r2 = await req('POST', '/api/loads', { sid, body: purchase(d) });
        ck('both posts answered ok', r1.status === 200 && r2.status === 200, `${r1.status} / ${r2.status}`);
        ck('the route created exactly one load', readIn().length === before + 1,
           `${readIn().length - before} created — the route is not forwarding draft_id`);
        const id1 = r1.json && (r1.json.load || {}).id;
        const id2 = r2.json && (r2.json.load || {}).id;
        ck('and both responses name the same load', !!id1 && id1 === id2, `${id1} vs ${id2}`);
    }
    {
        const d = 'DRAFT_1759180000010_jjj000';
        const before = readOut().length;
        const r1 = await req('POST', '/api/outbound-loads', { sid, body: sale(d) });
        const r2 = await req('POST', '/api/outbound-loads', { sid, body: sale(d) });
        ck('both sale posts answered ok', r1.status === 200 && r2.status === 200, `${r1.status} / ${r2.status}`);
        ck('the sale route created exactly one load', readOut().length === before + 1,
           `${readOut().length - before} created`);
        ck('and both responses name the same load',
           (r1.json.load || {}).id === (r2.json.load || {}).id);
    }
    {
        // The whole sequence, over HTTP: POST, PUT, POST.
        const d = 'DRAFT_1759180000011_kkk111';
        const before = readOut().length;
        const r1 = await req('POST', '/api/outbound-loads', { sid, body: sale(d) });
        const id = (r1.json.load || {}).id;
        const put = await req('PUT', `/api/outbound-loads/${encodeURIComponent(id)}`,
            { sid, body: { ...sale(d), buyer: 'Darwin Metals' } });
        const r3 = await req('POST', '/api/outbound-loads', { sid, body: sale(d) });
        ck('the edit went through', put.status === 200, `PUT ${put.status}`);
        ck('save → edit → continue leaves exactly ONE load', readOut().length === before + 1,
           `${readOut().length - before} loads — this is the bug she reported, end to end`);
        ck('and Continue returned the load she already had', (r3.json.load || {}).id === id);
    }
    {
        // Two different drafts through the route, so the guard is not just
        // "the second POST never creates anything".
        const before = readIn().length;
        await req('POST', '/api/loads', { sid, body: purchase('DRAFT_1759180000012_lll222') });
        await req('POST', '/api/loads', { sid, body: purchase('DRAFT_1759180000013_mmm333') });
        ck('two different drafts still create two loads, over HTTP', readIn().length === before + 2);
    }

    await new Promise((r) => server.close(r));
}

// ══════════════════════════════════════════════════════════════════════════
section('F — both clients send it, and the server reads it');
// A field the server honours and no client sends is a feature that does not
// exist. tests/once-per-save.js learned this for the ticket; same check here.
{
    const files = {
        website: path.join(ROOT, 'dashboard/index.html'),
        app    : path.join(ROOT, 'mobile-app/www/index.html'),
    };
    for (const [label, file] of Object.entries(files)) {
        const src = fs.readFileSync(file, 'utf8');
        ck(`${label}: the purchase payload carries the draft id`,
           /draft_id: currentDraftId,/.test(src),
           'saveTicket is per attempt; only currentDraftId identifies the piece of paper');
        ck(`${label}: and so does the sale payload`,
           /draft_id: payload\.draft_id,/.test(src));
        // ── AND THE ID IS STILL SET WHEN THE PAYLOAD IS BUILT ──────────
        // clearLoadDraft() nulls currentDraftId. If anything called it
        // before the payload was assembled, draft_id would be null on every
        // save — the guard silently off, and both checks above still green.
        //
        // The span searched is the save handler itself, from the click
        // listener to the payload. An earlier version of this check looked
        // FORWARD from the payload for the next clearLoadDraft() and passed
        // happily with one inserted BEFORE it, which is the "shaped like the
        // code rather than like the property" failure CLAUDE.md warns about.
        // It was caught by mutating the client, not by reading it.
        const handlerAt = src.indexOf("$('btnSaveLoad').addEventListener('click'");
        const payloadAt = src.indexOf('draft_id: currentDraftId,');
        ck(`${label}: the save handler and the payload were both found`,
           handlerAt > 0 && payloadAt > handlerAt,
           'the markers this check relies on have moved — fix the check, do not delete it');
        ck(`${label}: nothing clears the draft before the payload is built`,
           handlerAt > 0 && payloadAt > handlerAt
             && !src.slice(handlerAt, payloadAt).includes('clearLoadDraft('),
           'a clear before the payload sends null and silently disables the whole guard');
        ck(`${label}: and the draft IS cleared after the save`,
           src.slice(payloadAt).includes('clearLoadDraft();'),
           'never clearing it leaves her Continue prompt on a load that already exists');
    }
    const api = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
    ck('both create routes read draft_id off the body',
       (api.match(/draft_id: b\.draft_id,/g) || []).length === 2,
       '/api/loads and /api/outbound-loads must each forward it');
}

// ══════════════════════════════════════════════════════════════════════════
section('G — the edit path cannot quietly drop it');
// A source check, not a behaviour check, and deliberately so: section D
// already proves the behaviour. This one fails the moment someone adds a
// field to buildRecord's list and forgets the carry-across, which is the
// way this file's subject has broken twice before.
{
    const src = fs.readFileSync(path.join(ROOT, 'helpers/outboundLoads.js'), 'utf8');
    ck('editOutboundLoad carries draft_id across from the prior record',
       /patch\.draft_id = prior\.draft_id/.test(src));
    ck('buildRecord still does NOT name draft_id',
       !/^\s*draft_id/m.test(src.slice(src.indexOf('function buildRecord'), src.indexOf('async function addOutboundLoad'))),
       'if buildRecord starts carrying it, the carry-across above is dead code and should be removed deliberately');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('\n  THREW:', e.stack || e.message); process.exit(1); });
