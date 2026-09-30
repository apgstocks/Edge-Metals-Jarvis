// ── tests/saved-doc-kinds.js ───────────────────────────────────────────────
// Apsara, 2026-09-30: "proform ashould be in proforma,inv in invoice", and on
// the ones already filed: "find a way to keep old invoice in inv tab only".
//
// The rule is about what each TAB shows. Nothing on disk moves — moving was
// the obvious fix and it is wrong twice over: an invoice moved into invoice/
// needs a date and container folder a flat proforma filename does not carry,
// and helpers/proformaVersions.js keys a proforma's stored form on its
// filename, so renaming one silently breaks its Copy button.
//
// ── THE CHECK THAT MATTERS MOST IS SECTION C ───────────────────────────────
// This feature can fail in two directions and they are not equally bad.
// Showing an invoice under "Saved proformas" is untidy. Making a document
// disappear from EVERY tab because a cache is cold is data she cannot find,
// and she would have no way of knowing the app had stopped listing it. So the
// rule is that only a POSITIVE identification moves a row, and section C is
// the one that holds it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');

process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD   = process.env.APP_PASSWORD   || 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'staff-pw-ccccccccccc';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-dockinds-'));
process.env.DATA_DIR = TMP;

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const cfg = require('../config');
cfg.DOCUMENTS_SAVED_DIR = path.join(TMP, 'documents_saved');
cfg.SAVED_DOC_KINDS_FILE = path.join(TMP, 'saved_doc_kinds.json');

const PF_DIR = path.join(cfg.DOCUMENTS_SAVED_DIR, 'proforma');
fs.mkdirSync(PF_DIR, { recursive: true });

// Her real filename shape: the number is an INVOICE number on both kinds,
// because helpers/nextInvoiceNo.js numbers proformas from her live invoice
// sheet. A test using obviously-different names would hide the whole point.
const REAL_PROFORMA = '260823_AC_26JY90_Taewon_Metal.pdf';
const OLD_INVOICE   = '260824_AC_26JY91_Daekwang.pdf';
const UNREAD        = '260825_AC_26JY92_Joey.pdf';
for (const f of [REAL_PROFORMA, OLD_INVOICE, UNREAD]) {
    fs.writeFileSync(path.join(PF_DIR, f), 'x'.repeat(2000));
}

const kinds = require('../helpers/savedDocKinds');
const documentsSaved = require('../helpers/documentsSaved');

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — the store');

ck('an unknown file has no verdict', kinds.kindOf(OLD_INVOICE) === null);
await kinds.record([{ filename: OLD_INVOICE, kind: 'invoice', size: 2000, mtime: 'x' }]);
ck('a recorded verdict comes back', kinds.kindOf(OLD_INVOICE) === 'invoice');
ck('a path is keyed on its basename',
   kinds.kindOf('/some/where/' + OLD_INVOICE) === 'invoice',
   'the routes pass basenames around; a key that disagrees is a verdict nothing finds');

// A made-up kind must not become one. The tabs branch on this string, so an
// unvalidated value would put a row in a heading that does not exist.
await kinds.record([{ filename: 'junk.pdf', kind: 'nonsense' }]);
ck('a kind outside the four is refused', kinds.kindOf('junk.pdf') === null);
// ── AND REFUSED BY THE WRITER, NOT ONLY BY THE READER ─────────────────────
// The check above passes even with validation removed from record(), because
// kindOf validates too. Two layers is right — if kindOf is ever loosened the
// store is still clean — but a test that cannot tell them apart is testing
// one of them and claiming both. A mutation stripping the writer's guard
// survived until this line existed.
ck('and never written to the store in the first place',
   !Object.prototype.hasOwnProperty.call(
       JSON.parse(fs.readFileSync(cfg.SAVED_DOC_KINDS_FILE, 'utf8')), 'junk.pdf'),
   'a junk kind on disk is one loosened reader away from putting a row under a heading that does not exist');

// ── A FILE REPLACED UNDER THE SAME NAME ───────────────────────────────────
// She regenerates documents. If a proforma is saved over a name a previous
// INVOICE held, a cached verdict would hide the new proforma from her
// proforma tab — and it would look like the save had failed.
ck('a verdict is dropped when the file changed size',
   kinds.kindOf(OLD_INVOICE, { stat: { size: 9999 } }) === null,
   'a stale verdict on a replaced file hides the new document');
ck('and kept when it did not',
   kinds.kindOf(OLD_INVOICE, { stat: { size: 2000 } }) === 'invoice');

// ══════════════════════════════════════════════════════════════════════════
section('B — the split');

{
    const { proformas, misfiled } = documentsSaved.splitSavedProformas();
    ck('the old invoice is out of the proforma list', !proformas.includes(OLD_INVOICE),
       `proformas still holds ${OLD_INVOICE} — this is the thing she asked for`);
    ck('and is reported for the invoice tab',
       misfiled.some((m) => m.file === OLD_INVOICE && m.kind === 'invoice'));
    ck('a genuine proforma stays', proformas.includes(REAL_PROFORMA));
    ck('nothing is lost between the two lists',
       proformas.length + misfiled.length === documentsSaved.listSavedProformas().length,
       'every file must appear in exactly one of them — a row in neither is a document she cannot reach');
}
{
    // listSavedProformas is what /api/proforma/copyable and the delete route
    // reach through. Narrowing IT would have changed what those see, which
    // is why the split is a new function.
    ck('listSavedProformas itself is unchanged',
       documentsSaved.listSavedProformas().includes(OLD_INVOICE),
       'the unfiltered list is still the disk truth, and the delete route depends on it');
}
{
    // A proforma positively identified AS a proforma must not be moved out —
    // the filter is "identified as something else", not "identified".
    await kinds.record([{ filename: REAL_PROFORMA, kind: 'proforma', size: 2000 }]);
    const { proformas, misfiled } = documentsSaved.splitSavedProformas();
    ck('a confirmed proforma stays in the proforma list', proformas.includes(REAL_PROFORMA));
    ck('and is not reported as misfiled', !misfiled.some((m) => m.file === REAL_PROFORMA));
}

// ══════════════════════════════════════════════════════════════════════════
section('C — A COLD CACHE CHANGES NOTHING');
// ══════════════════════════════════════════════════════════════════════════
// The failure mode worth more than the feature. If "not classified" were
// read as anything but "leave it alone", warming the cache would become a
// prerequisite for seeing her own documents, and a fresh VM or a deleted
// cache file would empty the tab with no error anywhere.
{
    const { proformas, misfiled } = documentsSaved.splitSavedProformas();
    ck('an unclassified file is still listed', proformas.includes(UNREAD),
       'a document nobody has read must never vanish from every tab');
    ck('and is not claimed as misfiled', !misfiled.some((m) => m.file === UNREAD));
}
{
    // The whole store gone — a fresh deploy, or the file never written.
    fs.rmSync(cfg.SAVED_DOC_KINDS_FILE, { force: true });
    const { proformas, misfiled } = documentsSaved.splitSavedProformas();
    ck('with NO cache at all, every file is still listed',
       proformas.length === 3 && misfiled.length === 0,
       `got ${proformas.length} proformas / ${misfiled.length} misfiled — a missing cache must be a no-op`);
}
{
    // loadJson never throws — it logs and returns the default. So a corrupt
    // cache reads as "no verdicts", which is exactly the safe direction. This
    // pins that, because the alternative (a throw) would take the whole
    // Documents tab down over a cache.
    fs.writeFileSync(cfg.SAVED_DOC_KINDS_FILE, '{ this is not json');
    const { proformas } = documentsSaved.splitSavedProformas();
    ck('a CORRUPT cache is also a no-op, not a crash', proformas.length === 3,
       'a broken cache must never cost her the tab');
    fs.rmSync(cfg.SAVED_DOC_KINDS_FILE, { force: true });
    await kinds.record([{ filename: OLD_INVOICE, kind: 'invoice', size: 2000 }]);
}

// ══════════════════════════════════════════════════════════════════════════
section('D — END TO END, through the route the tabs call');
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

    const r = await req('GET', '/api/documents/saved', { sid });
    ck('the route answered', r.status === 200, `status ${r.status}`);
    const j = r.json || {};
    ck('the old invoice is NOT under proformas', !(j.proformas || []).includes(OLD_INVOICE),
       'this is the whole request, measured where the tab reads it');
    ck('it IS in misfiled_in_proforma',
       (j.misfiled_in_proforma || []).some((m) => m.file === OLD_INVOICE && m.kind === 'invoice'));
    ck('the genuine proforma is still under proformas', (j.proformas || []).includes(REAL_PROFORMA));
    ck('the unclassified one is still under proformas', (j.proformas || []).includes(UNREAD));

    // ── AND IT IS STILL REACHABLE ─────────────────────────────────────────
    // The row moves tab; the FILE does not move. So the invoice tab's Open
    // and Delete still have to work with kind=proforma, or she would be
    // looking at a row she cannot act on.
    const dl = await req('GET', `/api/documents/download?kind=proforma&file=${encodeURIComponent(OLD_INVOICE)}`, { sid });
    ck('a misfiled invoice can still be opened with kind=proforma', dl.status === 200,
       `download gave ${dl.status} — the row would be dead in the invoice tab`);

    // Copy must not offer a document that is not a proforma.
    const cp = await req('GET', '/api/proforma/copyable', { sid });
    ck('copyable does not offer the misfiled invoice',
       !((cp.json || {}).copyable || {})[OLD_INVOICE],
       'copying an invoice into a new proforma would carry invoice fields into the wrong document');

    await new Promise((r2) => server.close(r2));
}

// ══════════════════════════════════════════════════════════════════════════
section('E — the writer only records what it is sure of');
{
    const src = fs.readFileSync(path.join(ROOT, 'scripts/documents-folder-audit.js'), 'utf8');
    ck('--write-cache exists', /--write-cache/.test(src));
    ck('and only positive verdicts are recorded',
       /KNOWN\.has\(res\.what\)/.test(src),
       'writing "unreadable" as a verdict turns a parsing failure into a filing decision');
    ck('the report still runs without writing',
       /const WRITE_CACHE = argv\.includes\('--write-cache'\)/.test(src),
       'reading must stay safe by default');
}

// ══════════════════════════════════════════════════════════════════════════
section('F — the invoice tab actually shows them');
// The server can split them perfectly and she would still see nothing: the
// proforma tab drops the row, and if no tab picks it up the document has
// effectively been deleted from her view. That is the failure this section
// exists for.
{
    const src = fs.readFileSync(path.join(ROOT, 'dashboard/documents.html'), 'utf8');
    ck('the invoice tab has somewhere to put them', /id="invMisfiledList"/.test(src));
    ck('and it reads the new key', /misfiled_in_proforma/.test(src));
    ck('the card is hidden when there are none',
       /if \(!rows\.length\) \{ card\.classList\.add\('hidden'\)/.test(src),
       'an always-present empty card teaches her to ignore that part of the screen');
    ck('Open addresses the file where it actually lives',
       /download\?kind=proforma&file=\$\{encodeURIComponent\(m\.file\)\}/.test(src),
       'the row moved tab; the FILE did not — kind=invoice here would 404');
    ck('Delete does too',
       /saved\?kind=proforma&file=' \+ encodeURIComponent\(el\.dataset\.file\)/.test(src));
    // The secondary list must not be able to cost her the primary one.
    ck('it is fired without await, so it cannot take the main list down',
       /\n  loadMisfiledInvoices\(\);\n  try \{/.test(src),
       'awaiting it would let a failure here empty Generated invoices');
    ck('and it has its own catch', /could not list older invoices filed under proforma/.test(src));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('\n  THREW:', e.stack || e.message); process.exit(1); });
