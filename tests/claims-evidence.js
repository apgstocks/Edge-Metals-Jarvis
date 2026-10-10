// ── tests/claims-evidence.js ─────────────────────────────────────────────────
// The documents behind a claim: kept, findable, and never sent to a supplier.
//
// Apsara, 2026-10-03: asked where the supporting photos were (nowhere — the
// scan discarded its image), and set the rule that governs them: "if there is
// any company name mentioned in claim email of customer, then it should be
// hided."
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const R = (p) => path.join(ROOT, p);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-ev-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
delete require.cache[require.resolve(R('config.js'))];
const cfg = require(R('config.js'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('ABORT — DATA_DIR outside the temp dir'); process.exit(1); }

let pass = 0, fail = 0; const failures = [];
const ck = (n, ok, extra) => { if (ok) { pass++; console.log('  ok   ' + n); } else { fail++; failures.push(n); console.log('  FAIL ' + n + (extra === undefined ? '' : ' — ' + JSON.stringify(extra).slice(0, 220))); } };
const section = (t) => console.log('\n' + t);

// Drive is stubbed on the MODULE OBJECT, not destructured — getDrive() throws
// under JARVIS_TEST by design (drive.js:19, after a fixture landed in the live
// yard folder), so the seam has to be above it.
const drive = require(R('helpers/drive.js'));
let UPLOADS = [], FAIL_NEXT = null;
drive.uploadClaimDocument = async (key, base64, mimeType, name) => {
    if (FAIL_NEXT) { const m = FAIL_NEXT; FAIL_NEXT = null; throw new Error(m); }
    UPLOADS.push({ key, bytes: Buffer.from(base64, 'base64').length, mimeType, name });
    return { id: 'file' + UPLOADS.length, name: (name || 'doc') + '.jpg', webViewLink: 'https://drive.google.com/file/d/file' + UPLOADS.length + '/view' };
};

const claims = require(R('helpers/claims.js'));
const claimEvidence = require(R('helpers/claimEvidence.js'));
const report = require(R('helpers/claims/report.js'));
const routes = require(R('helpers/claims/routes.js'));
const gemini = require(R('helpers/gemini.js'));

// Distinct bytes per document ON PURPOSE. Evidence is deduplicated on a sha256
// of the content (a mail thread re-attaches its report on every reply), so a
// fixture that sends the same bytes twice is testing the dedupe, not the file.
const B64 = Buffer.from('not really a jpeg but it is bytes').toString('base64');
let nth = 0;
const freshB64 = () => Buffer.from('document number ' + (++nth) + ' — distinct bytes').toString('base64');

(async () => {

section('A — a document is kept against the claim');
{
    const c = await claims.create({ customer: 'Joey/Daekwang', supplier: 'Gomez', invoice_no: '26JY05', container_no: 'CAIU9975642' }, 'test');
    const r = await claimEvidence.attach(c.id, { base64: B64, mimeType: 'image/jpeg', name: 'surveyor report.jpg', by: 'apsara' });
    ck('it uploads once', UPLOADS.length === 1, UPLOADS);
    ck('filed under the container, not in one flat pile', UPLOADS[0].key === 'CAIU9975642', UPLOADS[0].key);
    ck('the claim now carries it', claimEvidence.list(claims.get(c.id)).length === 1);
    ck('with a link, a name and who added it', r.entry.url && r.entry.name && r.entry.added_by === 'apsara', r.entry);
    ck('and a history line says so', claims.get(c.id).history.some((h) => /supporting document/.test(h.what)));

    await claimEvidence.attach(c.id, { base64: freshB64(), mimeType: 'application/pdf', name: 'weighbridge.pdf' });
    ck('a second document is added, not replacing the first', claimEvidence.list(claims.get(c.id)).length === 2);

    // The same bytes again is the reply-chain case: a thread re-attaches its
    // report on every reply, and the file id cannot catch that because each
    // upload is a new Drive file.
    const uploadsBefore = UPLOADS.length;
    const dup = await claimEvidence.attach(c.id, { base64: B64, mimeType: 'image/jpeg', name: 'surveyor report (1).jpg' });
    ck('the same document twice is recognised by its bytes', dup.already === true, dup.entry && dup.entry.name);
    ck('and is not uploaded again', UPLOADS.length === uploadsBefore, { before: uploadsBefore, now: UPLOADS.length });
    ck('the claim still has two, not three', claimEvidence.list(claims.get(c.id)).length === 2);
}

section('B — what it refuses');
{
    const c = claims.list()[0];
    const uploadsAtB = UPLOADS.length;
    let msg = '';
    try { await claimEvidence.attach(c.id, { base64: '', mimeType: 'image/jpeg' }); } catch (e) { msg = e.message; }
    ck('no file is refused in words', /no file/.test(msg), msg);

    msg = '';
    try { await claimEvidence.attach(c.id, { base64: freshB64(), mimeType: 'application/zip' }); } catch (e) { msg = e.message; }
    ck('a zip is not a document it will keep', /not a document I can keep/.test(msg), msg);

    msg = '';
    try { await claimEvidence.attach('nosuchclaim', { base64: freshB64(), mimeType: 'image/jpeg' }); } catch (e) { msg = e.message; }
    ck('an unknown claim is refused', /no such claim/.test(msg), msg);

    const big = 'A'.repeat(Math.ceil((claimEvidence.MAX_BYTES + 1024) * 4 / 3));
    msg = '';
    try { await claimEvidence.attach(c.id, { base64: big, mimeType: 'image/jpeg' }); } catch (e) { msg = e.message; }
    ck('an oversized file is refused BEFORE the upload', /too big/.test(msg) && UPLOADS.length === uploadsAtB, { msg, uploads: UPLOADS.length });
}

section('C — Drive failing must not lose the claim');
{
    const before = claims.list().length;
    const c = claims.list()[0];
    const evBefore = claimEvidence.list(claims.get(c.id)).length;
    FAIL_NEXT = 'Drive is unreachable';
    let msg = '';
    try { await claimEvidence.attach(c.id, { base64: freshB64(), mimeType: 'image/jpeg' }); } catch (e) { msg = e.message; }
    ck('the error surfaces', /unreachable/.test(msg), msg);
    ck('the claim is untouched', claims.list().length === before && claimEvidence.list(claims.get(c.id)).length === evBefore);
    ck('and nothing half-written was recorded', !claimEvidence.list(claims.get(c.id)).some((e) => !e.url));
}

section('D — the scanned photograph is held, not re-uploaded by the phone');
{
    const id = claimEvidence.hold({ base64: B64, mimeType: 'image/jpeg', name: 'scan.jpg' });
    ck('holding gives back an id', typeof id === 'string' && id.startsWith('scan_'), id);
    const taken = claimEvidence.take(id);
    ck('and the bytes come back once', taken && taken.base64 === B64);
    ck('only once — it is not a store', claimEvidence.take(id) === null);
    ck('an unknown id is null, not a throw', claimEvidence.take('scan_nope') === null);

    for (let i = 0; i < claimEvidence.HOLD_MAX + 3; i++) claimEvidence.hold({ base64: B64, mimeType: 'image/jpeg' });
    const last = claimEvidence.hold({ base64: B64, mimeType: 'image/jpeg' });
    ck('the hold is capped, so photographs do not pile up in memory', claimEvidence.take(last) !== null);
}

section('E — NOTHING about evidence reaches a supplier');
{
    const c = claims.list().find((x) => x.invoice_no === '26JY05');
    await claims.verify(c.id, { invoice_weight: 20, claimed_weight: 19, weight_unit: 'MT', sell_price: 2000, sell_price_unit: 'MT' }, 'test');
    await claims.raiseRecovery(c.id, { our_claim: 1500 }, 'test');

    const b = report.build({ supplier: 'Gomez' });
    const html = report.toHtml(b);
    ck('no drive link on the statement', !/drive\.google\.com/.test(html));
    ck('no file name on the statement', !/surveyor report/i.test(html) && !/weighbridge/i.test(html));
    ck('and still no customer name', !/Joey/.test(html));
    const xlsx = await report.toWorkbook(b);
    ck('nor in the excel version', !/drive\.google\.com/.test(xlsx.toString('latin1')));

    // The claim JSON the PAGE reads is a different matter — staff need it.
    ck('but the page can still see them', claimEvidence.list(claims.get(c.id)).length === 2);
}

section('F — through the routes');
{
    const app = express();
    app.use(express.json({ limit: '40mb' }));
    app.use((req, res, next) => { req.role = 'admin'; next(); });
    routes.mount(app, { ROOT });
    const server = app.listen(0);
    const port = server.address().port;
    const post = async (p, body) => {
        const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return { code: r.status, body: await r.json().catch(() => null) };
    };
    const c = claims.list().find((x) => x.invoice_no === '26JY05');

    const r = await post('/api/claims/' + c.id + '/evidence', { base64: freshB64(), mimeType: 'image/jpeg', name: 'third.jpg' });
    ck('POST /api/claims/:id/evidence files it', r.code === 200 && r.body.evidence.length === 3, r.body && (r.body.error || r.body.evidence.length));

    const miss = await post('/api/claims/nosuchid/evidence', { base64: freshB64(), mimeType: 'image/jpeg' });
    ck('an unknown claim is a 404, not a 500', miss.code === 404, miss.code);

    const stale = await post('/api/claims/' + c.id + '/evidence', { scanId: 'scan_gone' });
    ck('an expired scan says the claim is fine', stale.code >= 400 && /the claim is fine/.test(stale.body.error || ''), stale.body);

    // The scan route hands back an id for the photograph it just read.
    let SCAN = { is_claim_document: true, confidence: 0.9, why: 'surveyor report',
        fields: { doc_type: 'surveyor report', container_no: 'CAIU9975642', invoice_weight: 21, claimed_weight: 20, weight_unit: 'MT' }, quotes: {}, unreadable: [] };
    gemini.getClient = () => ({ getGenerativeModel: () => ({ generateContent: async () => ({ response: { text: () => JSON.stringify(SCAN) } }) }) });
    gemini.callGeminiJSON = async () => ({ label: 'weight shortage', description: 'short', quote: 'short', confidence: 0.9, why: 'x' });

    const scanned = await post('/api/claims/scan', { base64: freshB64(), mimeType: 'image/jpeg', name: 'outturn.jpg' });
    ck('the scan route parks the file and names the id', scanned.code === 200 && /^scan_/.test(scanned.body.scanId || ''), scanned.body && scanned.body.scanId);

    const made = await post('/api/claims', { container_no: 'ZZZU1111111', supplier: 'Gomez' });
    const attached = await post('/api/claims/' + made.body.id + '/evidence', { scanId: scanned.body.scanId, by: 'scan' });
    ck('and creating from it keeps the photograph', attached.code === 200 && attached.body.evidence.length === 1, attached.body && attached.body.error);
    ck('filed by the scan, not by hand', attached.body.added.added_by === 'scan', attached.body.added);

    const again = await post('/api/claims/' + made.body.id + '/evidence', { scanId: scanned.body.scanId });
    ck('the same id cannot be used twice', again.code >= 400, again.code);

    SCAN = { is_claim_document: false, why: 'a packing list' };
    const notClaim = await post('/api/claims/scan', { base64: freshB64(), mimeType: 'image/jpeg' });
    ck('a non-claim document is not parked — no claim is coming', notClaim.code === 422 && !notClaim.body.scanId, notClaim.body && notClaim.body.scanId);

    server.close();
}

section('G — the page offers it, and says what it is for');
{
    const HTML = fs.readFileSync(R('dashboard/claims.html'), 'utf8');
    ck('every claim can take a document', /class="f_doc"/.test(HTML) && /Add a document/.test(HTML));
    ck('from a phone camera', /accept="image\/\*,application\/pdf" capture="environment"/.test(HTML));
    ck('there is a place they are listed', /Supporting documents/.test(HTML));
    ck('and it says plainly why they are not sent to a supplier', /never linked on anything sent to a supplier/.test(HTML));
    ck('an empty claim says so rather than showing nothing', /Nothing filed against this claim yet/.test(HTML));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  Failed:'); failures.forEach((f) => console.log('   - ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('\nTEST CRASHED:', e && e.stack || e); process.exit(1); });
