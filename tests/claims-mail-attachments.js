// ── tests/claims-mail-attachments.js ─────────────────────────────────────────
// The surveyor's report arrives attached to the mail that raises the claim.
// Until 2026-10-10 that attachment was read for its NAME and dropped.
//
// END TO END, through workflow/claimWatch.js's real consider(), with the same
// shape of Gmail payload replyWatch hands it. Stubs only the two networked
// edges: Gemini and Drive.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const R = (p) => path.join(ROOT, p);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-mailatt-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
delete require.cache[require.resolve(R('config.js'))];
const cfg = require(R('config.js'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('ABORT — DATA_DIR outside the temp dir'); process.exit(1); }

let pass = 0, fail = 0; const failures = [];
const ck = (n, ok, extra) => { if (ok) { pass++; console.log('  ok   ' + n); } else { fail++; failures.push(n); console.log('  FAIL ' + n + (extra === undefined ? '' : ' — ' + JSON.stringify(extra).slice(0, 220))); } };
const section = (t) => console.log('\n' + t);

// claimParse destructures callGeminiJSON at load, so this must be first.
const gemini = require(R('helpers/gemini.js'));
let GEMINI_REPLY = null;
gemini.callGeminiJSON = async () => (typeof GEMINI_REPLY === 'function' ? GEMINI_REPLY() : GEMINI_REPLY);

// Drive on the module object: getDrive() throws under JARVIS_TEST by design.
const drive = require(R('helpers/drive.js'));
let UPLOADS = [], DRIVE_FAILS = 0;
drive.uploadClaimDocument = async (key, base64, mimeType, name) => {
    if (DRIVE_FAILS > 0) { DRIVE_FAILS -= 1; throw new Error('Drive is unreachable'); }
    UPLOADS.push({ key, mimeType, name, bytes: Buffer.from(base64, 'base64').length });
    return { id: 'f' + UPLOADS.length, name: name || 'doc', webViewLink: 'https://drive.google.com/file/d/f' + UPLOADS.length + '/view' };
};

const claims = require(R('helpers/claims.js'));
const claimEvidence = require(R('helpers/claimEvidence.js'));
const claimWatch = require(R('workflow/claimWatch.js'));
const SENT = [];
claimWatch.init({ sendToTeam: async (t) => { SENT.push(t); return true; } });

// ── fixtures ────────────────────────────────────────────────────────────────
const bytes = (n) => Buffer.alloc(n, 7).toString('base64');
const REPORT = bytes(180 * 1024);
const TICKET = bytes(90 * 1024);

// The shape replyWatch passes: msg.payload, nested exactly as Gmail nests it.
const payloadWith = (parts) => ({ mimeType: 'multipart/mixed', parts: [
    { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { size: 400 } }] },
    ...parts,
] });
const att = (filename, mimeType, size, id) => ({ filename, mimeType, body: { attachmentId: id || ('a_' + filename), size } });

const BODY = [
    'Dear Apsara,',
    'Container CAIU9975642 against your invoice 26JY05 was invoiced at 21.582 MT.',
    'On weighing at our works we received only 19.66 MT.',
    'The shortage is 1.922 MT and we are claiming USD 4,113.08.',
    'Survey report attached.',
].join('\n');

const GOOD = {
    is_claim: true, confidence: 0.92, reason: 'Customer claiming short weight on a container',
    fields: { customer: 'Daekwang', supplier: '', invoice_no: '26JY05', container_no: 'CAIU9975642',
        invoice_weight: 21.582, claimed_weight: 19.66, weight_unit: 'MT', stated_claim_amount: 4113.08, claim_type: 'weight_shortage' },
    quotes: { customer: 'Regards, Daekwang', invoice_no: 'your invoice 26JY05', container_no: 'Container CAIU9975642',
        invoice_weight: 'invoiced at 21.582 MT', claimed_weight: 'we received only 19.66 MT', weight_unit: '21.582 MT',
        stated_claim_amount: 'claiming USD 4,113.08' },
};

let FETCHED = [];
const fetchPart = async (part) => {
    FETCHED.push(part.filename);
    return { filename: part.filename, base64: part.filename.includes('ticket') ? TICKET : REPORT };
};

(async () => {

section('A — which parts are worth fetching at all');
{
    const p = payloadWith([
        att('surveyor-report.pdf', 'application/pdf', 180 * 1024),
        att('logo.png', 'image/png', 4 * 1024),                 // a signature block
        att('spacer.gif', 'image/gif', 43),                      // a tracking pixel
        att('quote.xlsx', 'application/vnd.ms-excel', 60 * 1024),
        att('container-ticket.jpg', 'image/jpeg', 90 * 1024),
    ]);
    const picked = claimEvidence.evidenceParts(p).map((x) => x.filename);
    ck('the report and the photograph are picked', picked.includes('surveyor-report.pdf') && picked.includes('container-ticket.jpg'), picked);
    ck('a signature logo is not evidence', !picked.includes('logo.png'), picked);
    ck('nor is a tracking pixel', !picked.includes('spacer.gif'), picked);
    ck('nor is a spreadsheet', !picked.includes('quote.xlsx'), picked);
    ck('biggest first, so a cap keeps the report and drops the noise', picked[0] === 'surveyor-report.pdf', picked);

    // A PDF has no size floor: a one-page weighbridge slip is small and real.
    const small = claimEvidence.evidenceParts(payloadWith([att('slip.pdf', 'application/pdf', 3 * 1024)]));
    ck('a small PDF is still a document', small.length === 1, small);

    const inline = claimEvidence.evidenceParts(payloadWith([{ mimeType: 'image/png', body: { attachmentId: 'x', size: 900000 } }]));
    ck('an inline part with no filename is not an attachment', inline.length === 0, inline);

    const many = claimEvidence.evidenceParts(payloadWith(
        Array.from({ length: 10 }, (_, i) => att(`page${i}.jpg`, 'image/jpeg', (200 - i) * 1024, 'id' + i))));
    ck('no more than the cap come through', many.length === claimEvidence.MAX_PER_MAIL, many.length);

    const huge = claimEvidence.evidenceParts(payloadWith([att('scan.pdf', 'application/pdf', claimEvidence.MAX_BYTES + 1)]));
    ck('one oversized file is left alone rather than attempted', huge.length === 0, huge);
}

section('B — a claim mail files what it brought');
{
    GEMINI_REPLY = GOOD;
    FETCHED = [];
    const r = await claimWatch.consider({
        messageId: 'm1', threadId: 't1', from: 'claims@daekwang.co.kr',
        subject: 'Weight shortage claim — invoice 26JY05 / CAIU9975642', body: BODY,
        payload: payloadWith([att('surveyor-report.pdf', 'application/pdf', 180 * 1024), att('container-ticket.jpg', 'image/jpeg', 90 * 1024)]),
        fetchPart,
    });
    ck('the claim is created', !!r.claim_id && r.created === true, r);
    ck('both documents were fetched', FETCHED.length === 2, FETCHED);
    ck('and filed against the claim', r.attached && r.attached.filed === 2, r.attached);
    const c = claims.get(r.claim_id);
    ck('the claim carries them', claimEvidence.list(c).length === 2);
    ck('filed under the container, with the rest of its papers', UPLOADS.every((u) => u.key === 'CAIU9975642'), UPLOADS.map((u) => u.key));
    ck('and recorded as coming from the email, not by hand', claimEvidence.list(c).every((e) => e.added_by === 'email'));
}

section('C — the same report on every reply is filed once');
{
    GEMINI_REPLY = GOOD;
    const before = UPLOADS.length;
    const r = await claimWatch.consider({
        messageId: 'm2', threadId: 't1', from: 'claims@daekwang.co.kr',
        subject: 'Re: Weight shortage claim — invoice 26JY05 / CAIU9975642', body: BODY + '\nAny update?',
        payload: payloadWith([att('surveyor-report.pdf', 'application/pdf', 180 * 1024)]),
        fetchPart,
    });
    ck('the reply matches the existing claim rather than making a second', r.created === false, r);
    ck('the identical file is recognised', r.attached && r.attached.duplicate === 1 && r.attached.filed === 0, r.attached);
    ck('nothing was uploaded for it', UPLOADS.length === before, { before, now: UPLOADS.length });
    ck('and the claim still has two documents, not three', claimEvidence.list(claims.get(r.claim_id)).length === 2);
}

section('D — a mail that is not a claim costs nothing');
{
    FETCHED = [];
    GEMINI_REPLY = { is_claim: false, confidence: 0.9, reason: 'a rate enquiry' };
    const before = claims.list().length;
    const r = await claimWatch.consider({
        messageId: 'm3', from: 'someone@else.com', subject: 'Shortage of containers this week — rates',
        body: 'There is a shortage of 40ft containers, rates are up. Please advise.',
        payload: payloadWith([att('brochure.pdf', 'application/pdf', 900 * 1024)]),
        fetchPart,
    });
    ck('no claim is made', claims.list().length === before, r);
    ck('AND NOTHING WAS DOWNLOADED — this is the whole mailbox, not a few mails', FETCHED.length === 0, FETCHED);
}

section('E — asking "what needs my reply" must not file anything');
{
    FETCHED = [];
    GEMINI_REPLY = GOOD;
    const before = UPLOADS.length;
    const r = await claimWatch.consider({
        messageId: 'm4', from: 'claims@daekwang.co.kr', subject: 'Weight shortage claim — invoice 26ZZ99 / TEMU1234567',
        body: BODY, payload: payloadWith([att('surveyor-report.pdf', 'application/pdf', 180 * 1024)]),
        fetchPart, dryRun: true,
    });
    ck('a dry run says what it would do', r.dryRun === true, r);
    ck('and downloads nothing', FETCHED.length === 0 && UPLOADS.length === before);
}

section('F — a mail loop must never break on a photograph');
{
    GEMINI_REPLY = { ...GOOD, fields: { ...GOOD.fields, invoice_no: '26JY09', container_no: 'TCNU4471880' } };
    DRIVE_FAILS = 1;
    const r = await claimWatch.consider({
        messageId: 'm5', from: 'claims@daekwang.co.kr', subject: 'Weight shortage claim — invoice 26JY09 / TCNU4471880',
        body: BODY.replace('26JY05', '26JY09').replace('CAIU9975642', 'TCNU4471880'),
        payload: payloadWith([att('surveyor-report-2.pdf', 'application/pdf', 180 * 1024)]),
        fetchPart,
    });
    ck('Drive failing does not fail the mail', !r.error && !!r.claim_id, r);
    ck('the claim is created anyway — the money record is what matters', r.created === true);
    ck('the failure is counted, not swallowed silently', r.attached && r.attached.failed === 1, r.attached);
    ck('and no half-written evidence is recorded', claimEvidence.list(claims.get(r.claim_id)).length === 0);

    // A fetcher that throws is the other half of the same promise.
    GEMINI_REPLY = { ...GOOD, fields: { ...GOOD.fields, invoice_no: '26JY11', container_no: 'MSCU7730915' } };
    const r2 = await claimWatch.consider({
        messageId: 'm6', from: 'claims@daekwang.co.kr', subject: 'Weight shortage claim — invoice 26JY11 / MSCU7730915',
        body: BODY.replace('26JY05', '26JY11').replace('CAIU9975642', 'MSCU7730915'),
        payload: payloadWith([att('gone.pdf', 'application/pdf', 180 * 1024)]),
        fetchPart: async () => { throw new Error('Gmail said 404'); },
    });
    ck('a fetch that throws is the same — claim yes, document no', !r2.error && r2.created === true && r2.attached.failed === 1, r2.attached);
}

section('G — called the old way, nothing changes');
{
    // replyWatch is the only caller that has a payload. Every other path —
    // actions.js, the tests above this feature — passes neither, and must
    // behave exactly as it did.
    GEMINI_REPLY = { ...GOOD, fields: { ...GOOD.fields, invoice_no: '26JY13', container_no: 'FCIU8812340' } };
    const r = await claimWatch.consider({
        messageId: 'm7', from: 'claims@daekwang.co.kr', subject: 'Weight shortage claim — invoice 26JY13 / FCIU8812340',
        body: BODY.replace('26JY05', '26JY13').replace('CAIU9975642', 'FCIU8812340'),
    });
    ck('a claim is still created with no payload at all', r.created === true && !!r.claim_id, r);
    ck('and the attachment pass simply did not run', r.attached === null, r.attached);
}

section('H — none of it reaches a supplier');
{
    const report = require(R('helpers/claims/report.js'));
    const c = claims.list().find((x) => x.invoice_no === '26JY05');
    await claims.update(c.id, { supplier: 'Gomez' }, 'test', 'fixture');
    await claims.verify(c.id, { invoice_weight: 21.582, claimed_weight: 19.66, weight_unit: 'MT', sell_price: 2140, sell_price_unit: 'MT' }, 'test');
    await claims.raiseRecovery(c.id, { our_claim: 3421.16 }, 'test');
    const html = report.toHtml(report.build({ supplier: 'Gomez' }));
    ck('no drive link on the statement', !/drive\.google\.com/.test(html));
    ck('no attachment filename either', !/surveyor-report/.test(html));
    ck('and still no customer name', !/Daekwang/.test(html));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  Failed:'); failures.forEach((f) => console.log('   - ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('\nTEST CRASHED:', e && e.stack || e); process.exit(1); });
