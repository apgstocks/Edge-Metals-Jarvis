// ── tests/saved-document-delete.js ────────────────────────────────────────
// Apsara, 2026-09-17: "add delete option in saved proforma/invoice/bol/packing
// list", and, asked what it removes: "The PDF and the record".
//
// ── WHAT IS BEING DELETED ───────────────────────────────────────────────────
// An ARCHIVED PDF — a document that may already be in a broker's inbox. So:
//
//   IT IS AUDITED BEFORE THE ACT. Which document went and who removed it has
//   to outlive the document, or the only trace of a deleted commercial invoice
//   is that it is not there any more.
//
//   THE PATH IS RESOLVED, NEVER JOINED. A filename is user input arriving over
//   a query string; "../../data/banks.json" must not resolve. Section C.
//
//   AND THE RECORD GOES ONLY WHERE THE FILE IDENTIFIES ONE. A BOL's filename
//   carries its number, so that record goes. An INVOICE's stored history is
//   per CONTAINER and shared with every other invoice for it — deleting that
//   because she removed one PDF takes data she did not ask about, which is
//   rule 1 in CLAUDE.md. Section D.
//
// Tested END TO END per her rule of this morning: a real server, the real
// route the button calls, and the archive read back afterwards.

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-savedel-'));
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

// ══════════════════════════════════════════════════════════════════════════
section('A — a saved proforma, deleted through the route');
// ══════════════════════════════════════════════════════════════════════════
{
    docs.saveProformaCopy(Buffer.from('%PDF one'), 'PF_1.pdf');
    docs.saveProformaCopy(Buffer.from('%PDF two'), 'PF_2.pdf');
    ck('two proformas are on the shelf', docs.listSavedProformas().length === 2,
       JSON.stringify(docs.listSavedProformas()));

    const res = await req('DELETE', '/api/documents/saved?kind=proforma&file=PF_1.pdf', { sid: admin });
    ck('the route deletes one', res.status === 200, `${res.status} ${JSON.stringify(res.json)}`);
    ck('  and says which', res.json && res.json.deleted === 'PF_1.pdf', JSON.stringify(res.json));

    const left = docs.listSavedProformas();
    ck('  it is gone from the shelf', !left.includes('PF_1.pdf'), JSON.stringify(left));
    ck('  and the OTHER one is untouched', left.includes('PF_2.pdf'), JSON.stringify(left));

    // Pressed twice, which happens: the second press must say "not there"
    // rather than reporting a success that did nothing.
    const again = await req('DELETE', '/api/documents/saved?kind=proforma&file=PF_1.pdf', { sid: admin });
    ck('deleting it again is a 404, not a silent success', again.status === 404, String(again.status));
}

// ══════════════════════════════════════════════════════════════════════════
section('B — audited before the act');
// ══════════════════════════════════════════════════════════════════════════
{
    const entries = audit.listEntries().filter((e) => e.action === 'delete-saved-document');
    ck('the deletion is in the audit log', entries.length === 1, String(entries.length));
    const e = entries[0];
    ck('  naming the document', e && e.subject === 'PF_1.pdf', e && e.subject);
    ck('  and who removed it', !!(e && e.actor !== undefined && e.role), JSON.stringify(e && { actor: e.actor, role: e.role }));
    ck('  and what kind it was', e && e.detail && e.detail.kind === 'proforma', JSON.stringify(e && e.detail));
    ck('  written BEFORE the file went, and completed after',
       !!(e && e.outcome), 'an entry with no outcome means the delete threw between the two');
}

// ══════════════════════════════════════════════════════════════════════════
section('C — a filename is user input');
// ══════════════════════════════════════════════════════════════════════════
{
    // The path is RESOLVED through resolveSavedPath, never joined here. That
    // function refuses anything escaping the archive root, and a second
    // path-building code path beside it would be a second place to get it
    // wrong.
    const before = fs.existsSync(cfg.BANKS_FILE || path.join(cfg.DATA_DIR, 'banks.json'));
    fs.writeFileSync(path.join(cfg.DATA_DIR, 'banks.json'), '["Chase Bank"]');

    for (const evil of ['../../banks.json', '..%2F..%2Fbanks.json', '/etc/passwd', '....//banks.json']) {
        const r = await req('DELETE', '/api/documents/saved?kind=proforma&file=' + encodeURIComponent(evil), { sid: admin });
        ck(`refuses ${evil}`, r.status >= 400, `${r.status} ${JSON.stringify(r.json)}`);
    }
    ck('  and banks.json is still there', fs.existsSync(path.join(cfg.DATA_DIR, 'banks.json')),
       'a filename off a query string reached outside the archive');

    // An unknown kind resolves nothing rather than defaulting to a directory.
    const bad = await req('DELETE', '/api/documents/saved?kind=sideways&file=PF_2.pdf', { sid: admin });
    ck('an unknown kind is refused', bad.status >= 400, String(bad.status));
    ck('  and PF_2 survived it', docs.listSavedProformas().includes('PF_2.pdf'));

    // ── AND THE HELPER REFUSES ON ITS OWN ────────────────────────────────
    // The route resolves the path BEFORE calling the helper, so the route's
    // check is what stops the requests above — mutating the helper to join
    // paths by hand broke none of them. That is belt-and-braces working as
    // intended, but it also means the helper was untested. Called directly
    // here, so both layers are held.
    for (const evil of ['../../banks.json', '../bol/x.pdf']) {
        let threw = null; let out;
        try { out = docs.deleteSaved({ kind: 'proforma', filename: evil }); } catch (e) { threw = e; }
        ck(`  deleteSaved itself refuses ${evil}`, !threw && out === null,
           threw ? threw.message : String(out));
    }
    ck('  and banks.json survives that too', fs.existsSync(path.join(cfg.DATA_DIR, 'banks.json')));

    // ── STAFF ────────────────────────────────────────────────────────────
    // HONEST LIMIT: this harness cannot hold a staff session — /login returns
    // no sid for the staff password under JARVIS_TEST, so a request "as staff"
    // is really a request with no session, and it is the global auth that
    // refuses it rather than requireAdmin. Mutating requireAdmin off broke
    // nothing here, which is the check telling the truth about itself.
    //
    // What can be held is that the route CARRIES requireAdmin, and that the
    // unauthenticated request is refused. Both below, and the first one is
    // the one that would catch someone removing it.
    const apiSrc = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
    ck('the delete route is admin-only',
       /app\.delete\('\/api\/documents\/saved', requireAdmin,/.test(apiSrc),
       'documents are Edge Metals; staff are deliberately kept out of them');
    const anon = await req('DELETE', '/api/documents/saved?kind=proforma&file=PF_2.pdf');
    ck('  and a request with no session is refused', [401, 403].includes(anon.status), String(anon.status));
    ck('  PF_2 is still there', docs.listSavedProformas().includes('PF_2.pdf'));
}

// ══════════════════════════════════════════════════════════════════════════
section('D — the record goes only where the file identifies one');
// ══════════════════════════════════════════════════════════════════════════
{
    const bols = require(path.join(ROOT, 'helpers/bols'));
    const saved = await bols.saveBol({ bol_no: '26ECC001', consignee_name: 'Eccomelt',
        items: [{ description: 'Alu', pieces: 1, gross_weight: 100, tare_weight: 10, net_weight: 90 }] });
    docs.saveBolCopy(Buffer.from('%PDF bol'), '26ECC001_Eccomelt.pdf', '2026-09-17');

    const r = await req('DELETE',
        '/api/documents/saved?kind=bol&date=2026-09-17&file=' + encodeURIComponent('26ECC001_Eccomelt.pdf'),
        { sid: admin });
    ck('a BOL pdf deletes', r.status === 200, `${r.status} ${JSON.stringify(r.json)}`);
    ck('  and its record goes with it', !bols.getBol(saved.id),
       'the filename carries the BOL number, so the mapping is unambiguous');
    ck('  reported honestly', r.json && /26ECC001/.test(String(r.json.record_removed || '')),
       JSON.stringify(r.json));

    // ── AND AN INVOICE'S HISTORY DOES NOT ────────────────────────────────
    // Its stored record is the per-CONTAINER version history, shared with
    // every other invoice for that container — including the ones she is
    // keeping. Deleting it because she removed one PDF takes data she did not
    // ask about.
    const iv = require(path.join(ROOT, 'helpers/invoiceVersions'));
    await iv.saveInvoiceVersion('KOCU5139886', { inv_no: 'KEEP-ME', container_no: 'KOCU5139886', line_items: [] });
    docs.saveInvoiceCopy(Buffer.from('%PDF inv'), 'KOCU5139886.pdf', 'KOCU5139886', '2026-09-17');

    const ri = await req('DELETE',
        '/api/documents/saved?kind=invoice&date=2026-09-17&container=KOCU5139886&file=KOCU5139886.pdf',
        { sid: admin });
    ck('an invoice pdf deletes', ri.status === 200, `${ri.status} ${JSON.stringify(ri.json)}`);
    ck("  but the container's invoice history is untouched",
       !!iv.getLatestInvoicePayload('KOCU5139886'),
       'that history is shared with every other invoice for this container');
    ck('  and the response says no record went', !ri.json.record_removed,
       'quietly doing less than the button says is worse than saying so');
}

// ══════════════════════════════════════════════════════════════════════════
section('E — the button, and what it asks');
// ══════════════════════════════════════════════════════════════════════════
{
    ck('the saved proforma list has a Delete', /class="btn btn-secondary pf-del"/.test(DASH));
    // "Are you sure?" on a list of near-identical filenames is a question she
    // cannot actually answer.
    ck('  the confirm names the file', /confirm\(`Delete \$\{f\}\?/.test(DASH),
       'a generic confirm on a list of similar names is not a decision');
    ck('  and says it cannot be undone', /cannot be undone/.test(DASH));
    ck('  it calls the DELETE route', /\/api\/documents\/saved\?kind=proforma&file=/.test(DASH));
    ck('  and reloads the list rather than removing the row locally',
       /loadSavedProformas\(\);\n      \} catch/.test(DASH),
       'a row removed locally disagrees with the archive the moment anything else changes');
}

server.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }

})().catch((e) => { console.error(e); process.exit(1); });
