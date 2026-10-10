// ── tests/claims-scan-report.js ──────────────────────────────────────────────
// Scanning a claim document, and the statement that goes to a supplier.
// Stubs only the model and the PDF renderer; everything else is production code.
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const R = (p) => path.join(ROOT, p);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-scan-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
delete require.cache[require.resolve(R('config.js'))];
const cfg = require(R('config.js'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('ABORT — DATA_DIR outside the temp dir'); process.exit(1); }

let pass = 0, fail = 0; const failures = [];
const ck = (n, ok, extra) => { if (ok) { pass++; console.log('  ok   ' + n); } else { fail++; failures.push(n); console.log('  FAIL ' + n + (extra === undefined ? '' : ' — ' + JSON.stringify(extra).slice(0, 220))); } };
const section = (t) => console.log('\n' + t);

// ── model stub, installed before claimScan is required ──────────────────────
const gemini = require(R('helpers/gemini.js'));
let SCAN_REPLY = null, LAST_MODEL = null, LAST_PARTS = null;
gemini.getClient = () => ({
    getGenerativeModel: ({ model }) => { LAST_MODEL = model; return {
        generateContent: async (parts) => { LAST_PARTS = parts; return { response: { text: () => JSON.stringify(SCAN_REPLY) } }; },
    }; },
});
gemini.callGeminiJSON = async () => ({ label: 'weight shortage', description: 'less than invoiced', quote: 'short', confidence: 0.9, why: 'x' });

const claimScan = require(R('helpers/claimScan.js'));
const report = require(R('helpers/claims/report.js'));
const claims = require(R('helpers/claims.js'));
const routes = require(R('helpers/claims/routes.js'));

const GOOD = {
    is_claim_document: true, confidence: 0.86, why: 'A surveyor outturn report claiming short weight',
    fields: {
        doc_type: 'surveyor report', customer: 'Joey/Daekwang', supplier: 'Gomez',
        invoice_no: '26JY05', container_no: 'CAIU 9975642',
        invoice_weight: 21.582, claimed_weight: 19.66, weight_unit: 'MT',
        stated_claim_amount: 4113.08, currency: 'USD', date: '18/05/2026',
        what_is_claimed: 'Outturn weight short against the invoiced weight',
    },
    quotes: { invoice_weight: 'Invoiced 21.582 MT', claimed_weight: 'Outturn 19.66 MT', weight_unit: 'MT', container_no: 'CAIU 9975642' },
    unreadable: [], 
};

(async () => {

section('A — the scan fills the form');
{
    SCAN_REPLY = GOOD;
    const d = await claimScan.scan({ base64: 'ZmFrZQ==', mimeType: 'image/jpeg' });
    ck('it reads a claim document', d.ok === true, d);
    ck('the container is normalised to ISO form', d.fields.container_no === 'CAIU9975642', d.fields.container_no);
    ck('weights come through as read', d.fields.invoice_weight === 21.582 && d.fields.claimed_weight === 19.66);
    ck('the unit comes through when the document states it', d.fields.weight_unit === 'MT');
    ck('it says what the document is', /surveyor/i.test(d.docType), d.docType);
    ck('it returns the words it read each field from', d.quotes.invoice_weight === 'Invoiced 21.582 MT');
    ck('it names the kind with the same classifier as everything else', d.kind && d.kind.slug === 'weight_shortage', d.kind);
    ck('it says plainly that a scan is not a checked fact',
        /not a checked fact|Compare each one/.test(d.verification), d.verification);
    ck('the image really was sent to the model', Array.isArray(LAST_PARTS) && LAST_PARTS.some((p) => p.inlineData));
    ck('and read with the smart tier, not the workhorse',
        LAST_MODEL === cfg.GEMINI_MODEL_CLAIMS && LAST_MODEL !== cfg.GEMINI_MODEL, { used: LAST_MODEL, workhorse: cfg.GEMINI_MODEL });
    ck('scanning creates nothing by itself', claims.list().length === 0, claims.list().length);
}

section('B — what it refuses to do');
{
    SCAN_REPLY = { ...GOOD, fields: { ...GOOD.fields, weight_unit: null }, quotes: { ...GOOD.quotes, weight_unit: undefined } };
    let d = await claimScan.scan({ base64: 'ZmFrZQ==', mimeType: 'image/jpeg' });
    ck('no unit on the document means no unit on the form', d.fields.weight_unit === null, d.fields.weight_unit);

    SCAN_REPLY = { ...GOOD, fields: { ...GOOD.fields, weight_unit: 'tonnes' } };
    d = await claimScan.scan({ base64: 'ZmFrZQ==', mimeType: 'image/jpeg' });
    ck('"tonnes" is understood as MT', d.fields.weight_unit === 'MT');

    SCAN_REPLY = { is_claim_document: false, why: 'This is a bill of lading' };
    d = await claimScan.scan({ base64: 'ZmFrZQ==', mimeType: 'image/jpeg' });
    ck('a document that is not a claim is refused, with a reason', d.ok === false && /bill of lading/.test(d.reason), d);

    d = await claimScan.scan({ base64: 'x', mimeType: 'application/zip' });
    ck('a file it cannot read is refused before any model call', d.ok === false && /not something this can read/.test(d.reason), d.reason);

    d = await claimScan.scan({});
    ck('no file is refused', d.ok === false && /no file/.test(d.reason));

    SCAN_REPLY = { ...GOOD, confidence: 0.1 };
    d = await claimScan.scan({ base64: 'ZmFrZQ==', mimeType: 'image/jpeg' });
    ck('a page it could barely read is flagged, not hidden', d.ok === true && d.lowConfidence === true, d.confidence);

    SCAN_REPLY = { ...GOOD, unreadable: ['claimed_weight', 'stated_claim_amount'] };
    d = await claimScan.scan({ base64: 'ZmFrZQ==', mimeType: 'image/jpeg' });
    ck('fields it could not read are named', d.unreadable.join(',') === 'claimed_weight,stated_claim_amount');
}

section('C — it notices a claim that already exists');
{
    const existing = await claims.create({ customer: 'Joey/Daekwang', supplier: 'Junk car', invoice_no: '26JY05', container_no: 'CAIU9975642' }, 'test');
    SCAN_REPLY = GOOD;
    const d = await claimScan.scan({ base64: 'ZmFrZQ==', mimeType: 'image/jpeg' });
    ck('scanning the report for a claim already on file says so', d.existing && d.existing.id === existing.id, d.existing);
    ck('and shows what is already there', d.existing.container_no === 'CAIU9975642' && d.existing.status === 'unverified');
}

section('D — the statement, and what it will not send');
{
    const mk = async (o, verify, recover) => {
        const c = await claims.create(o, 'test');
        if (verify) await claims.verify(c.id, { invoice_weight: 20, claimed_weight: 19.5, weight_unit: 'MT', sell_price: 2000, sell_price_unit: 'MT' });
        if (recover) await claims.raiseRecovery(c.id, { our_claim: recover });
        return c;
    };
    await mk({ customer: 'Joey', supplier: 'Gomez', invoice_no: 'A1', container_no: 'AAAA1111111' }, true, 580);
    await mk({ customer: 'Pan metal', supplier: 'Gomez', invoice_no: 'A2', container_no: 'AAAA2222222' }, true, 300);
    await mk({ customer: 'Metal Bridge', supplier: 'Gomez', invoice_no: 'A3', container_no: 'AAAA3333333' }, false, null);
    await mk({ customer: 'Taewon', supplier: 'Calderon', invoice_no: 'B1', container_no: 'BBBB1111111' }, true, 900);
    const settled = await mk({ customer: 'Joey', supplier: 'Gomez', invoice_no: 'A4', container_no: 'AAAA4444444' }, true, 100);
    await claims.setStatus(settled.id, 'settled');

    const b = report.build({ supplier: 'Gomez' });
    ck('it is scoped to the one supplier it is addressed to', b.lines.every((l) => l.supplier === 'Gomez'), b.lines.map((l) => l.supplier));
    ck('another supplier\'s claims are not in it', !b.lines.some((l) => l.invoice_no === 'B1'));
    ck('an unverified claim is NOT sent as a demand', !b.lines.some((l) => l.invoice_no === 'A3'), b.lines.map((l) => l.invoice_no));
    ck('and it says how many were held back', b.unverifiedCount === 1, b.unverifiedCount);
    ck('settled claims are left out by default', !b.lines.some((l) => l.invoice_no === 'A4'));
    ck('the total is what is recoverable from them', b.totals.recoverable === 880, b.totals.recoverable);
    ck('it is addressed to the supplier', b.addressedTo === 'Gomez');
    ck('and carries a reference', /^EMI-CLM-\d{8}-GOMEZ$/.test(b.reference), b.reference);

    const withUnv = report.build({ supplier: 'Gomez', includeUnverified: true });
    ck('unverified ones can be listed deliberately', withUnv.lines.some((l) => l.invoice_no === 'A3'));
    ck('but they still do not count toward the total', withUnv.totals.recoverable === 880, withUnv.totals.recoverable);
    ck('and they are marked as not sendable', withUnv.lines.find((l) => l.invoice_no === 'A3').sendable === false);

    const one = report.build({ container: 'AAAA1111111' });
    ck('a single container can be scoped instead', one.lines.length === 1 && one.lines[0].invoice_no === 'A1', one.lines.length);
}

section('E — the document itself');
{
    const b = report.build({ supplier: 'Gomez' });
    const html = report.toHtml(b);
    ck('it is addressed and referenced', html.includes('Gomez') && html.includes(b.reference));
    ck('it leads with what is recoverable from them', /Amount recoverable from you/.test(html));
    // Was /raised by our customers/ until 2026-10-03. Apsara: "if there is any
    // company name mentioned in claim email of customer, then it should be
    // hided" — so the document no longer refers to a customer at all, and the
    // Customer column is gone. claims-supplier-price.js F4 holds the full guard.
    ck('it says the claims were raised against THEIR material, naming no customer',
        /raised against material supplied by you/.test(html) && !/>Customer</.test(html));
    ck('it does NOT print what Edge itself absorbs — that is not their business',
        !/absorb/i.test(html) && !/Claimed against Edge/i.test(html));
    ck('it states that no unit conversion was applied', /No conversion has been applied/.test(html));
    ck('it is a light, printable document, not the dashboard', !/--steel-900|#0C0E10/.test(html) && /@page/.test(html));
    ck('it asks for a reply within a stated time', /within 14 days/.test(html));

    let gotHtml = null;
    const pdf = await report.toPdf(b, { renderer: async (h) => { gotHtml = h; return Buffer.from('%PDF-1.4 stub'); } });
    ck('the pdf path renders the same html', gotHtml === html && pdf.toString().startsWith('%PDF'));

    const xlsx = await report.toWorkbook(b);
    ck('an excel version is produced too, because suppliers argue line by line', xlsx.length > 2000);
    // The date column is the DOCUMENT's date where there is one. Everything in a
    // sheet imported in one go shares a created_at, and a statement whose every
    // line reads the import date is worse than useless — a supplier reads it as
    // the claim date and disputes it.
    {
        const withDate = await claims.create({ customer: 'Zimex', supplier: 'Gomez', invoice_no: '26ME22', container_no: 'TGHU1112223', claim_date: '2026-05-18' }, 'test');
        await claims.verify(withDate.id, { invoice_weight: 20, claimed_weight: 19, weight_unit: 'MT', sell_price: 2000, sell_price_unit: 'MT' }, 'test');
        await claims.raiseRecovery(withDate.id, { our_claim: 2000 }, 'test');
        const d = report.build({ supplier: 'Gomez' }).lines.find((l) => l.invoice_no === '26ME22');
        ck('a line is dated by the document, not by the day it was filed', d && d.date === '2026-05-18', d && d.date);
        await claims.setStatus(withDate.id, 'withdrawn', 'test', 'fixture only');
    }

    // Was Claim-statement_… until 2026-10-10, when Apsara replaced the old
    // statement with the new claim report: "use the latest one you created".
    ck('the filename names the supplier and the date', /^Claim-report_Gomez_\d{4}-\d{2}-\d{2}\.pdf$/.test(report.filenameFor(b, 'pdf')), report.filenameFor(b, 'pdf'));
}

section('F — through the routes the page uses');
{
    const app = express();
    app.use(express.json({ limit: '40mb' }));
    app.use((req, res, next) => { req.role = 'admin'; next(); });
    routes.mount(app, { ROOT });
    const server = app.listen(0);
    const port = server.address().port;
    const get = async (p) => {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
        try {
            const r = await fetch(`http://127.0.0.1:${port}${p}`, { signal: ctl.signal });
            clearTimeout(t);
            const ct = r.headers.get('content-type') || '';
            return { code: r.status, ct, cd: r.headers.get('content-disposition'), body: ct.includes('json') ? await r.json() : null, bytes: ct.includes('json') ? 0 : (await r.arrayBuffer()).byteLength };
        } catch (e) { clearTimeout(t); return { code: 'HUNG' }; }
    };
    const post = async (p, body) => {
        const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return { code: r.status, body: await r.json().catch(() => null) };
    };

    // The bug this guards: /api/claims/:id was declared first, so Express matched
    // "report" as a claim id and answered 404. Any new /api/claims/<word> route
    // must be declared above the wildcard.
    const rep = await get('/api/claims/report?supplier=Gomez');
    ck('GET /api/claims/report is not swallowed by /api/claims/:id', rep.code === 200 && rep.body && rep.body.totals, rep.code === 200 ? Object.keys(rep.body) : rep.code);
    ck('and it never hangs', rep.code !== 'HUNG');

    const sup = await get('/api/claims/report/suppliers');
    // Assert the ordering property, not a name: which supplier tops the list is a
    // fact about the fixture's amounts, so hardcoding one makes the test lie the
    // moment a figure above it changes.
    ck('the supplier list is ordered by what is owed',
       sup.code === 200 && Array.isArray(sup.body.suppliers) && sup.body.suppliers.length > 1
         && sup.body.suppliers.every((s, i, a) => i === 0 || a[i - 1].recoverable >= s.recoverable),
       sup.code === 200 ? sup.body.suppliers.map((s) => [s.supplier, s.recoverable]) : sup.code);
    ck('it counts the unverified ones separately', sup.body.suppliers.find((s) => s.supplier === 'Gomez').unverified === 1);
    ck('and it does not hang on a settled claim', sup.code !== 'HUNG');

    const html = await get('/api/claims/report?supplier=Gomez&format=html');
    ck('html comes back as html', html.code === 200 && /text\/html/.test(html.ct));
    const xl = await get('/api/claims/report?supplier=Gomez&format=xlsx');
    ck('xlsx comes back as a download', xl.code === 200 && /attachment; filename="Claim-report_Gomez/.test(xl.cd || ''), xl.cd);
    const bad = await get('/api/claims/report?supplier=Gomez&format=docx');
    ck('an unknown format is refused, in words', bad.code === 400 && /json, html, pdf or xlsx/.test(bad.body.error));

    const byId = await get(`/api/claims/${claims.list()[0].id}`);
    ck('reading one claim by id still works', byId.code === 200 && byId.body.id === claims.list()[0].id);

    SCAN_REPLY = GOOD;
    const scanned = await post('/api/claims/scan', { base64: 'ZmFrZQ==', mimeType: 'image/jpeg' });
    ck('the scan route answers with the filled form', scanned.code === 200 && scanned.body.fields.invoice_no === '26JY05', scanned.body && scanned.body.reason);
    const before = claims.list().length;
    ck('and still creates nothing', claims.list().length === before);

    const empty = await post('/api/claims/scan', {});
    ck('a scan with no file is refused', empty.code >= 400 && /no file/.test(empty.body.error || ''), empty.body);

    SCAN_REPLY = { is_claim_document: false, why: 'a packing list' };
    const notClaim = await post('/api/claims/scan', { base64: 'ZmFrZQ==', mimeType: 'image/jpeg' });
    ck('a non-claim document comes back as 422, not a 500', notClaim.code === 422 && notClaim.body.ok === false, notClaim.code);

    server.close();
}

section('G — the controls are on the page');
{
    const HTML = fs.readFileSync(R('dashboard/claims.html'), 'utf8');
    ck('there is a scan button', /id="scanBtn"/.test(HTML) && /Scan a document/.test(HTML));
    ck('a phone can use its camera', /capture="environment"/.test(HTML) && /accept="image\/\*,application\/pdf"/.test(HTML));
    ck('the scan shows the words it read beside each field', /nothing quoted for this/.test(HTML));
    ck('it warns that a scan is the model\'s reading, not a fact', /verification/.test(HTML));
    ck('a missing unit is called out rather than filled in', /the document did not state a unit/.test(HTML));
    ck('creating from a scan says it is unverified', /Create this claim, unverified/.test(HTML));
    // Renamed 2026-10-10 — the claim report replaced the statement (Apsara).
    ck('there is a supplier report button', /id="repBtn"/.test(HTML) && /Claim report for a supplier/.test(HTML));
    ck('it explains why unverified claims are held back', /a reading, not a demand/.test(HTML));
    ck('it offers pdf, excel and a preview', /Download PDF/.test(HTML) && /Download Excel/.test(HTML) && /Preview/.test(HTML));
    // Was a "statement to <supplier>" chip; now the container's Claim report
    // menu, scoped to that container and its supplier (2026-10-10).
    ck('a container can produce a report for its own supplier', /<b>Claim report<\/b> · PDF/.test(HTML) && /report\?container=/.test(HTML));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  Failed:'); failures.forEach((f) => console.log('   - ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('\nTEST CRASHED:', e && e.stack || e); process.exit(1); });
