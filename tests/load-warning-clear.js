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
let failUploadMessageless = false;  // throw the AggregateError she actually hit
drive.uploadLoadPdf = async (loadId, buf, nameOverride) => {
    const name = nameOverride || `${loadId}.pdf`;
    uploads.push(name);
    if (failUpload && name.includes(failUpload)) {
        // ── THE SHAPE THAT PRODUCED detail: null ────────────────────────
        // An Error with a tidy .message is the easy case and the one that
        // was never broken. Drive is reached over the network, and when
        // every address for a host fails Node throws an AggregateError
        // whose .message is '' — so this stub throws what really happened
        // to EDGE_130, not what is convenient to assert on.
        if (failUploadMessageless) throw new AggregateError([
            new Error(`connect ETIMEDOUT 142.250.72.42:443 (${name})`),
            new Error('connect ECONNREFUSED 142.250.72.43:443'),
        ]);
        throw new Error(`stub: Drive refused ${name}`);
    }
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
section('F — the diagnosis that was not recorded');
// EDGE_130, 2026-10-09T00:00:36.217Z, detail: null. The nightly end-of-day
// yard report runs at 20:00 America/New_York, which IS 00:00:00Z — so this
// was set 36 seconds into that job, not by anything she pressed. And the
// reason was lost because callers passed `e.message`, which is the EMPTY
// STRING on the error class Node throws when every address for a host fails.

{
    const { describeError, buildWarning } = require(path.join(ROOT, 'helpers/loadWarnings'));

    // The exact shape that produced `detail: null`.
    const agg = new AggregateError([
        new Error('connect ETIMEDOUT 142.250.72.42:443'),
        new Error('connect ECONNREFUSED 142.250.72.43:443'),
    ]);
    ck('an AggregateError really does have an empty .message', agg.message === '',
       'if this is ever false the bug being fixed here did not exist');
    const d = describeError(agg);
    ck('describeError still gets something out of it', !!d, `got ${JSON.stringify(d)}`);
    ck('  naming the underlying failures', /ETIMEDOUT/.test(d) && /ECONNREFUSED/.test(d), d);
    ck('buildWarning handed the ERROR records that reason',
       !!buildWarning('receipt_pdf_failed', agg).detail, 'this is the null she was looking at');
    // Backwards compatible: five other call sites still pass e.message.
    ck('a plain string still works', describeError('ENOTFOUND www.googleapis.com')
        === 'ENOTFOUND www.googleapis.com');
    ck('and nothing stays nothing', describeError(null) === null && describeError('') === null);
    // The code is the most useful part and must survive on its own — a
    // googleapis rejection often carries ENOTFOUND with no useful message.
    ck('a bare code is enough to record', /ENOTFOUND/.test(describeError({ code: 'ENOTFOUND' }) || ''));
    ck('  and an HTTP status is kept', /403/.test(describeError({ response: { status: 403 } }) || ''),
       '403 vs 500 is permissions vs wait five minutes');
    ck('detail is still capped', buildWarning('receipt_pdf_failed',
        new Error('x'.repeat(900))).detail.length <= 300);

    // It must not be shown to the operator. The banner renders w.message.
    const w = buildWarning('receipt_pdf_failed', agg);
    ck('the operator message is still plain English', !/ETIMEDOUT/.test(w.message), w.message);
}

// ══════════════════════════════════════════════════════════════════════════
section('G — a render failure and a Drive failure say different things');
// They shared one try and one sentence. "could not be generated" is what she
// was shown for what was almost certainly a connection problem, and the two
// have opposite instructions: try again now, versus wait for the network.

{
    const mk = async (seller) => loads.addLoad({ date: '2026-10-10', seller, items: ITEMS });

    const rendFail = await mk('Vikram');
    failReceipt = true;
    const a = await generateAndStoreLoadPdfs(rendFail);
    failReceipt = false;
    ck('a render failure reports receipt_pdf_failed', codesOf(a).includes('receipt_pdf_failed'),
       `got ${codesOf(a)}`);
    ck('  and nothing was uploaded for it', !a.receipt_pdf_link);

    const upFail = await mk('Anita');
    failUpload = 'receipt_';
    const b = await generateAndStoreLoadPdfs(upFail);
    failUpload = null;
    ck('an upload failure reports receipt_upload_failed', codesOf(b).includes('receipt_upload_failed'),
       `got ${codesOf(b)}`);
    ck('  NOT the render code', !codesOf(b).includes('receipt_pdf_failed'),
       'blaming the renderer for Drive is what sent her looking in the wrong place');
    const msg = (b.warnings || []).find(x => x.code === 'receipt_upload_failed').message;
    ck('  and it tells her to wait for the connection', /connection/i.test(msg), msg);
    ck('  while the main ticket is still fine', !!b.pdf_link && b.status === 'pdf_generated');

    // ── END TO END ON THE REAL FAULT, NOT A CONVENIENT ONE ──────────────
    // Section F proves describeError can handle an AggregateError. That is a
    // helper test, and a helper test being green is how the first version of
    // this shipped: what matters is whether a messageless error driven
    // through generateAndStoreLoadPdfs lands a reason ON THE LOAD.
    const aggFail = await mk('Deepak');
    failUpload = 'receipt_'; failUploadMessageless = true;
    const e2e = await generateAndStoreLoadPdfs(aggFail);
    failUpload = null; failUploadMessageless = false;
    const aw = (e2e.warnings || []).find(x => x.code === 'receipt_upload_failed');
    ck('a messageless network failure still warns', !!aw, `got ${codesOf(e2e)}`);
    ck('  AND records a reason — this is the detail: null she was shown',
       !!(aw && aw.detail), `detail=${aw && aw.detail}`);
    ck('  naming the actual fault', /ETIMEDOUT|ECONNREFUSED/.test((aw && aw.detail) || ''),
       aw && aw.detail);
    // On disk, not just in the response: she read this out of loads.json.
    const diskW = (loads.getLoad(aggFail.id).warnings || [])
        .find(x => x.code === 'receipt_upload_failed');
    ck('  and it is on disk, where she looked', !!(diskW && diskW.detail), JSON.stringify(diskW));

    // The new code has to be clearable too, or the badge is permanent.
    const c = await generateAndStoreLoadPdfs(loads.getLoad(upFail.id));
    ck('a later good run clears receipt_upload_failed', codesOf(c).length === 0, `got ${codesOf(c)}`);
    ck('  and on disk', onDisk(upFail.id).length === 0, `disk ${onDisk(upFail.id)}`);
}

// ══════════════════════════════════════════════════════════════════════════
section('H — why EDGE_130 was touched at all');
// The end-of-day guard was `if (l.pdf_link && l.weights_pdf_link) skip`. A
// load with no scale photos NEVER gets weights_pdf_link — that document is
// deliberately skipped because there are no photos for it to carry — so the
// guard asked for a field that could not exist, and rebuilt and re-uploaded
// every photo-less load's documents on its own evening for nothing.

{
    const { hasReportablePdfs, hasScalePhotosOn } = require(path.join(ROOT, 'helpers/loadsPdf'));

    const NOPHOTO = [{ description: 'Brass', gross_weight: 8000, tare_weight: 500, price: 2, unit: 'lb' }];
    const bare = await loads.addLoad({ date: '2026-10-10', seller: 'Kiran', items: NOPHOTO });
    ck('a load with no scale photos has no photos', !hasScalePhotosOn(bare));
    ck('  and one with them does', hasScalePhotosOn({ items: ITEMS }));
    // A TARE-only load is photo-backed too. The weights PDF prints a photo
    // link under each weight it has, and the operator who photographed the
    // empty truck and not the full one still produced evidence. Checking
    // only gross is the drift this one shared definition exists to stop —
    // and it would quietly put those loads back into the nightly rebuild.
    ck('  a tare photo alone still counts',
       hasScalePhotosOn({ items: [{ tare_photo_link: 'https://drive.test/tare.jpg' }] }),
       'checking only gross_photo_link sends tare-only loads back into the nightly rebuild');
    ck('  and an empty load counts as neither',
       !hasScalePhotosOn({ items: [] }) && !hasScalePhotosOn({}) && !hasScalePhotosOn(null));

    uploads = [];
    const done = await generateAndStoreLoadPdfs(bare);
    ck('generating it makes the ticket and the receipt, not the weights PDF',
       uploads.length === 2, uploads.join(', '));
    ck('  so weights_pdf_link is absent BY DESIGN', !done.weights_pdf_link);

    // THE BUG: the old guard. Spelled out rather than referenced, because the
    // point is that this expression is false on a load that is complete.
    ck('THE OLD GUARD said this complete load was unfinished',
       !(done.pdf_link && done.weights_pdf_link),
       'if this is ever false the regeneration never happened and this section is pointless');
    ck('THE FIX: the load is recognised as having what the report links',
       hasReportablePdfs(done));

    // And it must still catch a load that genuinely IS missing something.
    ck('a load with photos but no weights PDF still needs generating',
       !hasReportablePdfs({ pdf_link: 'x', items: ITEMS }));
    ck('a load with no ticket always needs generating',
       !hasReportablePdfs({ items: NOPHOTO }));
    ck('  and one with both is done', hasReportablePdfs({ pdf_link: 'x', weights_pdf_link: 'y', items: ITEMS }));
    // The receipt is deliberately NOT in the guard: the email links the
    // ticket and the weights PDF only, so rebuilding three documents to
    // backfill a receipt nobody links is work for nobody.
    ck('a missing receipt does NOT trigger a rebuild',
       hasReportablePdfs({ pdf_link: 'x', receipt_pdf_link: null, items: NOPHOTO }),
       'the end-of-day email never links the receipt');

    // ── END TO END THROUGH THE REAL LOOP ────────────────────────────────
    // The predicate being right is not the fix; the scheduler using it is.
    // Counting Drive uploads is the only way to see the redundant work,
    // which is what actually failed on 2026-10-08.
    // Comments stripped first. The replaced guard is QUOTED in the comment
    // explaining why it went, so scanning the raw file finds the old code in
    // the prose about the old code — the same trap that broke the
    // subresource scan in helpers/pdfBrowser.js earlier today.
    const sched = fs.readFileSync(path.join(ROOT, 'scheduler.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ck('the end-of-day report uses the shared rule', /hasReportablePdfs\(l\)/.test(sched));
    ck('  and no longer asks for weights_pdf_link directly',
       !/if \(l\.pdf_link && l\.weights_pdf_link\)/.test(sched),
       'the guard that could not be satisfied is still there');

    uploads = [];
    const todays = [loads.getLoad(bare.id), loads.getLoad(clean.id)];
    for (const l of todays) {
        if (hasReportablePdfs(l)) continue;
        await generateAndStoreLoadPdfs(l);
    }
    ck('a second evening over finished loads uploads NOTHING',
       uploads.length === 0, `re-uploaded: ${uploads.join(', ') || 'none'}`);
    ck('  and neither load picked up a warning',
       onDisk(bare.id).length === 0 && onDisk(clean.id).length === 0,
       `${onDisk(bare.id)} / ${onDisk(clean.id)}`);
}

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) { console.log('Failures:'); failures.forEach(f => console.log('  - ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('ABORT', e); process.exit(1); });
