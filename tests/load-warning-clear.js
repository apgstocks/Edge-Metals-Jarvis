// ── tests/load-warning-clear.js ──────────────────────────────────────────
// Apsara, 2026-10-10: "There is a load created with this error ⚠ The POS
// receipt could not be generated. The main ticket is unaffected. I dont even
// have any idea what caused this error. Now when i try to print pos
// receipt,it is generating,but still this error is showing in my load."
//
// generateAndStoreLoadPdfs CLEARED the warning on disk and then returned the
// store as it stood BEFORE that clear — updateLoad's array. So a regenerate
// that fixed the receipt answered the client with a load still wearing the
// complaint, and the badge survived until the next full reload.
//
// There was no behavioural test on this function at all before today: the
// only coverage was tests/load-card-actions.js matching the CALL in api.js's
// source. A regex that proves the function is called cannot notice that it
// returns the wrong object.
//
//   A  a clean run returns a load with no warnings, and writes none
//   B  a failing receipt warns — on disk AND in what the caller is handed
//   C  THE BUG: a run that fixes it must return the cleared load, not the
//      pre-clear snapshot
//   D  an old receipt link survives a later failure — so the Print button
//      is not evidence the receipt is current
//   E  the main ticket still throws loudly; only sub-documents are soft

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-loadwarn-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('  ABORT  config not isolated'); process.exit(1); }

// ── STUB DRIVE BEFORE loadsPdf DESTRUCTURES IT ──────────────────────────
// helpers/drive.js refuses to run at all under JARVIS_TEST (it throws rather
// than risk writing to her live yard folder), and helpers/loadsPdf.js pulls
// uploadLoadPdf out of it at require time — so the replacement has to be in
// place before loadsPdf is first required, not after.
const drive = require(path.join(ROOT, 'helpers/drive'));
let uploads = [];           // every filename this run tried to upload
let failUpload = null;      // substring: an upload whose name matches throws
drive.uploadLoadPdf = async (loadId, buf, nameOverride) => {
    const name = nameOverride || `${loadId}.pdf`;
    uploads.push(name);
    if (failUpload && name.includes(failUpload)) throw new Error(`stub: Drive refused ${name}`);
    return { id: `drive_${name}`, webViewLink: `https://drive.test/${name}` };
};

// The receipt generator is stubbed the same way and for the same reason: the
// failure she hit is a THROW out of this call or out of the upload, and the
// test has to be able to produce one on demand. The real pdfkit path is
// covered by tests/yard-documents.js and tests/load-item-units.js.
const pdfMod = require(path.join(ROOT, 'helpers/pdf'));
const realReceipt = pdfMod.generateLoadReceiptPdf;
let failReceipt = false;
pdfMod.generateLoadReceiptPdf = async (load, opts) => {
    if (failReceipt) throw new Error('stub: receipt render blew up');
    return realReceipt(load, opts);
};

const loads = require(path.join(ROOT, 'helpers/loads'));
const { generateAndStoreLoadPdfs } = require(path.join(ROOT, 'helpers/loadsPdf'));

const codesOf = (l) => (l && l.warnings || []).map(w => w.code).sort();
const onDisk = (id) => codesOf(loads.getLoad(id));

// A photo link on the item so the weights PDF is attempted too — without one
// it is skipped by design, and skipping it would hide a second failure mode.
const ITEMS = [{ description: 'Copper', gross_weight: 10000, tare_weight: 1000, price: 1, unit: 'lb',
                 gross_photo_link: 'https://drive.test/gross.jpg' }];

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — a clean run leaves nothing behind');

const clean = await loads.addLoad({ date: '2026-10-10', seller: 'Ramesh', items: ITEMS });
{
    uploads = [];
    const out = await generateAndStoreLoadPdfs(clean);
    ck('the caller is handed a load', !!out && out.id === clean.id);
    ck('  with no warnings', codesOf(out).length === 0, `got ${codesOf(out)}`);
    ck('  and none on disk either', onDisk(clean.id).length === 0, `disk ${onDisk(clean.id)}`);
    ck('  and it has a receipt link', !!out.receipt_pdf_link, JSON.stringify(out.receipt_pdf_link));
    ck('all three documents were uploaded', uploads.length === 3, uploads.join(', '));
}

// ══════════════════════════════════════════════════════════════════════════
section('B — a failing receipt is visible to the caller, not just the log');

const broken = await loads.addLoad({ date: '2026-10-10', seller: 'Suresh', items: ITEMS });
{
    failReceipt = true;
    const out = await generateAndStoreLoadPdfs(broken);
    failReceipt = false;
    ck('the warning is on disk', onDisk(broken.id).includes('receipt_pdf_failed'), `disk ${onDisk(broken.id)}`);
    ck('  and in what the caller got back', codesOf(out).includes('receipt_pdf_failed'), `got ${codesOf(out)}`);
    // The reason is kept even though no screen shows it — this is the only
    // record of WHY, and she had none: "I dont even have any idea what
    // caused this error."
    const w = (out.warnings || []).find(x => x.code === 'receipt_pdf_failed');
    ck('  carrying the underlying reason', !!(w && w.detail && /blew up/.test(w.detail)),
       `detail=${w && w.detail}`);
    ck('the main ticket still landed', !!out.pdf_link, 'a soft sub-document failure must not cost the ticket');
    ck('  and the load still counts as generated', out.status === 'pdf_generated', out.status);
}

// ══════════════════════════════════════════════════════════════════════════
section('C — the regenerate that fixes it must SAY so');
// This is the bug she reported. The clear happened; the answer predated it.

{
    const out = await generateAndStoreLoadPdfs(loads.getLoad(broken.id));
    ck('the warning is gone from disk', !onDisk(broken.id).includes('receipt_pdf_failed'),
       `disk ${onDisk(broken.id)}`);
    ck('THE BUG: and gone from what the caller is handed', !codesOf(out).includes('receipt_pdf_failed'),
       `got ${codesOf(out)} — the badge survived a successful regenerate because this object predated the clear`);
    ck('  with no warnings of any kind left', codesOf(out).length === 0, `got ${codesOf(out)}`);
    // The property, not the shape: whatever the function returns, it must
    // agree with the store. A mutation that reintroduces the stale array has
    // to turn this red.
    ck('  and it agrees with the store, field for field',
       JSON.stringify(codesOf(out)) === JSON.stringify(onDisk(broken.id)));
}

// ══════════════════════════════════════════════════════════════════════════
section('D — a receipt link is not proof the receipt is current');
// "when i try to print pos receipt,it is generating" — the Print button is a
// plain link to receipt_pdf_link, which a LATER failure does not clear. So
// printing can succeed from the previous run while the badge is telling the
// truth about the most recent one.

{
    const before = loads.getLoad(broken.id).receipt_pdf_link;
    ck('the load has a receipt link to start with', !!before);
    failReceipt = true;
    const out = await generateAndStoreLoadPdfs(loads.getLoad(broken.id));
    failReceipt = false;
    ck('a failed receipt warns again', codesOf(out).includes('receipt_pdf_failed'), `got ${codesOf(out)}`);
    ck('  but the OLD link is still there, so Print still works', out.receipt_pdf_link === before,
       `${out.receipt_pdf_link} vs ${before}`);
}

// ══════════════════════════════════════════════════════════════════════════
section('E — the main ticket is not best-effort');
// The soft handling is deliberate and scoped: lose the receipt, keep the
// ticket. Losing the TICKET has to throw, so the route records
// pdf_generate_failed and answers 500 instead of reporting success.

{
    const hard = await loads.addLoad({ date: '2026-10-10', seller: 'Mahesh', items: ITEMS });
    failUpload = `${hard.id}.pdf`;      // the main ticket's own filename
    let threw = null;
    try { await generateAndStoreLoadPdfs(hard); } catch (e) { threw = e; }
    failUpload = null;
    ck('a main-ticket upload failure throws', !!threw, 'it was swallowed — the route would answer ok:true');
    ck('  and does not mark the load generated', loads.getLoad(hard.id).status !== 'pdf_generated',
       loads.getLoad(hard.id).status);
}

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) { console.log('Failures:'); failures.forEach(f => console.log('  - ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('ABORT', e); process.exit(1); });
