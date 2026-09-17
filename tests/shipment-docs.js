// ── tests/shipment-docs.js ────────────────────────────────────────────────
// Apsara, 2026-09-17: "now once the invoice and packing list is created -when
// i give command to jarvis to send--->it should able to mail customer with
// documents.."
//
// ── WHAT IS ACTUALLY AT RISK HERE ───────────────────────────────────────────
// This helper decides which two files get attached to an email that leaves
// the building. The failure modes are not "the function returned undefined":
//
//   the wrong container's documents go to a buyer;
//   an invoice from the 17th is sent beside a packing list from the 15th,
//     so the weights a broker checks do not match the invoice they arrive
//     with;
//   a superseded invoice is sent because it happened to sort later by name;
//   a combined document is sent WITH a separate packing list, so the
//     customer receives the same weights twice and asks which is right.
//
// Every section below is one of those.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-shipdocs-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
const sd = require(path.join(ROOT, 'helpers/shipmentDocs'));

// Write a PDF into the archive exactly where the real routes put it, with a
// controllable mtime — "which of these two did she make last" is decided by
// mtime, so a test that cannot set it cannot test the thing.
function put(date, container, filename, body, mtimeMs) {
    const dir = path.join(cfg.DOCUMENTS_SAVED_DIR, 'invoice', date, container);
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, filename);
    fs.writeFileSync(p, body || `%PDF-1.4 ${filename}`);
    if (mtimeMs) fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
    return p;
}

// ── A. Which document is which ──────────────────────────────────────────────
section('A. classify');

ck('separate-mode invoice is an invoice',
    sd.classify('EM1047_INVOICE.pdf').kind === 'invoice');
ck('separate-mode packing list is a packing list',
    sd.classify('EM1047_PACKING_LIST.pdf').kind === 'packing');
ck('the packing TAB\'s file is a packing list',
    sd.classify('HMMU7060866_packing.pdf').kind === 'packing');
// The ordering trap the helper's header calls out: this name carries both
// words. It is a packing list.
ck('a name carrying BOTH words is a packing list',
    sd.classify('EM1047_INVOICE_PACKING_LIST.pdf').kind === 'packing',
    'INVOICE was matched before PACKING_LIST');
ck('the combined document is an invoice',
    sd.classify('EM1047.pdf').kind === 'invoice');
ck('the combined document is marked as carrying a packing list',
    sd.classify('EM1047.pdf').combined === true);
ck('separate-mode invoice is NOT marked combined',
    sd.classify('EM1047_INVOICE.pdf').combined === false);
ck('a non-PDF is nothing',
    sd.classify('notes.txt') === null);
ck('an empty name is nothing',
    sd.classify('') === null);
ck('lower case still classifies',
    sd.classify('em1047_invoice.pdf').kind === 'invoice');

// ── B. Finding one container's pair ─────────────────────────────────────────
section('B. findForContainer');

put('2026-09-17', 'HMMU7060866', 'EM1047_INVOICE.pdf');
put('2026-09-17', 'HMMU7060866', 'EM1047_PACKING_LIST.pdf');

let found = sd.findForContainer('HMMU7060866');
ck('the container is found', !!found);
ck('the invoice is found', found.invoice && found.invoice.filename === 'EM1047_INVOICE.pdf');
ck('the packing list is found', found.packing && found.packing.filename === 'EM1047_PACKING_LIST.pdf');
ck('nothing is reported missing', found.missing.length === 0, JSON.stringify(found.missing));
ck('the date is carried', found.date === '2026-09-17');
ck('both files exist on the paths handed back',
    fs.existsSync(found.invoice.path) && fs.existsSync(found.packing.path));

// She types it lower case, or the way it reads on the booking.
ck('a lower-case container still resolves',
    (sd.findForContainer('hmmu7060866') || {}).container === 'HMMU7060866');

ck('an unknown container returns null, not an empty shell',
    sd.findForContainer('NOSUCH1234567') === null,
    'a caller testing truthiness would have attached nothing to a real email');

// ── C. A container invoiced twice ───────────────────────────────────────────
// The important one. She corrected the invoice two days later; the buyer must
// receive the correction, and must NOT receive the new invoice beside the old
// weights.
section('C. regenerated on a later date');

put('2026-09-15', 'TCLU9988776', 'EM1050_INVOICE.pdf');
put('2026-09-15', 'TCLU9988776', 'EM1050_PACKING_LIST.pdf');
put('2026-09-17', 'TCLU9988776', 'EM1050_INVOICE.pdf');
put('2026-09-17', 'TCLU9988776', 'EM1050_PACKING_LIST.pdf');

found = sd.findForContainer('TCLU9988776');
ck('the newest date wins', found.date === '2026-09-17');
ck('the invoice comes from the newest folder', found.invoice.path.includes('2026-09-17'));
ck('THE PACKING LIST COMES FROM THE SAME FOLDER AS THE INVOICE',
    path.dirname(found.invoice.path) === path.dirname(found.packing.path),
    'a buyer would get weights that do not match the invoice beside them');

// The check above passed for the wrong reason until 2026-09-17: both folders
// held a packing list, so a helper that reached into an OLDER folder would
// never have had to. A mutation doing exactly that stayed green.
//
// This is the fixture that can catch it — today's folder has an invoice and
// NO packing list, and an older folder has one. Reaching back for it would
// attach the 15th's weights to the 17th's invoice, which is the single worst
// thing this file can do.
put('2026-09-15', 'OOLU3334445', 'EM1090_INVOICE.pdf');
put('2026-09-15', 'OOLU3334445', 'EM1090_PACKING_LIST.pdf');
put('2026-09-17', 'OOLU3334445', 'EM1091_INVOICE.pdf');

const split = sd.findForContainer('OOLU3334445');
ck('the newest invoice is chosen even though it stands alone',
    split.invoice.filename === 'EM1091_INVOICE.pdf' && split.date === '2026-09-17');
ck('NO packing list is taken from an older folder',
    split.packing === null,
    `reached back and grabbed ${split.packing && split.packing.filename} — those weights belong to a different invoice`);
ck('the missing packing list is reported instead',
    split.missing.includes('packing list'));

// ── D. Regenerated twice in ONE day ─────────────────────────────────────────
// Same folder, same name is overwritten — but "separate" and "invoice only"
// can leave two differently-named invoices side by side. The later one is
// the one she meant, and filename order does not know that.
section('D. two invoices in one folder');

put('2026-09-17', 'MSCU1112223', 'AAA_INVOICE.pdf', null, Date.now() - 60 * 60 * 1000);
put('2026-09-17', 'MSCU1112223', 'ZZZ_INVOICE.pdf', null, Date.now() - 6 * 60 * 60 * 1000);
put('2026-09-17', 'MSCU1112223', 'AAA_PACKING_LIST.pdf');

found = sd.findForContainer('MSCU1112223');
ck('the most recently written invoice wins, not the last one alphabetically',
    found.invoice.filename === 'AAA_INVOICE.pdf',
    `picked ${found.invoice && found.invoice.filename} — sorted by name instead of mtime`);

// ── E. Half a document set ──────────────────────────────────────────────────
// Her answer on attachments was "Invoice + packing list". So a missing one is
// reported, never quietly dropped — sending an invoice alone to a broker who
// is waiting on weights is a phone call she has to take.
section('E. missing documents are reported');

put('2026-09-17', 'ONEU0000001', 'EM1060_INVOICE.pdf');
found = sd.findForContainer('ONEU0000001');
ck('a missing packing list is reported', found.missing.includes('packing list'));
ck('the invoice is still handed back', !!found.invoice);

put('2026-09-17', 'ONEU0000002', 'ONEU0000002_packing.pdf');
found = sd.findForContainer('ONEU0000002');
ck('a missing invoice is reported', found.missing.includes('invoice'));
ck('the packing list is still handed back', !!found.packing);

// ── F. The combined document ────────────────────────────────────────────────
// It already has the packing list bound into it. Reporting one "missing"
// would make the caller apologise for a document that is not absent, and
// attaching one beside it would send the same weights twice.
section('F. combined invoice');

put('2026-09-17', 'CMAU5556667', 'EM1070.pdf');
found = sd.findForContainer('CMAU5556667');
ck('a combined document is flagged as carrying its packing list',
    found.hasPackingInside === true);
ck('nothing is reported missing for a combined document',
    found.missing.length === 0, JSON.stringify(found.missing));

// ── G. A folder with only a packing list must not shadow yesterday's invoice ─
// She used the packing list TAB today for a container invoiced last week.
// Taking today's folder would report the invoice missing when one exists.
section('G. a packing-list-only folder');

put('2026-09-10', 'SUDU7778889', 'EM1080_INVOICE.pdf');
put('2026-09-10', 'SUDU7778889', 'EM1080_PACKING_LIST.pdf');
put('2026-09-17', 'SUDU7778889', 'SUDU7778889_packing.pdf');

found = sd.findForContainer('SUDU7778889');
ck('the folder holding the invoice is chosen', found.date === '2026-09-10');
ck('and the invoice is not reported missing', !found.missing.includes('invoice'),
    'today\'s packing-list-only folder shadowed a real invoice');

// ── H. Who the customer is ──────────────────────────────────────────────────
// She names a CONTAINER. A container does not carry a customer, so the
// consignee is read from the version history the invoice route writes.
section('H. customerFor');

const { mutateJson } = require(path.join(ROOT, 'helpers/json'));
(async () => {
    await mutateJson(cfg.INVOICE_VERSIONS_FILE, {}, (raw) => {
        const o = (raw && typeof raw === 'object') ? raw : {};
        o['HMMU7060866'] = { inv_no: 'EM1047', container_no: 'HMMU7060866', consignee: 'Eccomelt', saved_at: '2026-09-17' };
        o['TCLU9988776'] = [
            { inv_no: 'EM1049', consignee: 'Old Buyer', saved_at: '2026-09-15' },
            { inv_no: 'EM1050', consignee: 'Taewon', saved_at: '2026-09-17' },
        ];
        return o;
    });

    ck('the consignee is read back', (sd.customerFor('HMMU7060866') || {}).consignee === 'Eccomelt');
    ck('the invoice number is read back', (sd.customerFor('HMMU7060866') || {}).inv_no === 'EM1047');
    ck('a lower-case container still resolves the customer',
        (sd.customerFor('hmmu7060866') || {}).consignee === 'Eccomelt');
    ck('the LATEST version wins when history is an array',
        (sd.customerFor('TCLU9988776') || {}).consignee === 'Taewon',
        'the first record won — an old consignee would be emailed the new invoice');
    ck('an unknown container has no customer', sd.customerFor('NOSUCH1234567') === null);
    ck('findForContainer carries the consignee through',
        (sd.findForContainer('HMMU7060866') || {}).consignee === 'Eccomelt');

    // ── I. What actually gets attached ──────────────────────────────────────
    section('I. attachmentsFor');

    const pair = sd.findForContainer('HMMU7060866');
    const atts = sd.attachmentsFor(pair);
    ck('two attachments for a two-document shipment', atts.length === 2, `got ${atts.length}`);
    ck('the first is the invoice', atts[0].filename === 'EM1047_INVOICE.pdf');
    ck('attachments carry real bytes, not a path',
        Buffer.isBuffer(atts[0].content) && atts[0].content.length > 0);
    ck('the mime type is PDF', atts.every((a) => a.mimeType === 'application/pdf'));
    ck('attachmentsFor(null) is empty, not a throw', sd.attachmentsFor(null).length === 0);

    // A document deleted between the read-back and her "yes". Better to fail
    // loudly here than to email a zero-byte attachment to a customer.
    const doomed = sd.findForContainer('ONEU0000001');
    fs.unlinkSync(doomed.invoice.path);
    let threw = false;
    try { sd.attachmentsFor(doomed); } catch (e) { threw = true; }
    ck('a document deleted after the read-back throws rather than sending empty', threw,
        'an empty attachment would have gone to a customer');

    console.log(`\n${pass} passed, ${fail} failed`);
    if (failures.length) console.log('Failures:\n  ' + failures.join('\n  '));
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
    process.exit(fail ? 1 : 0);
})();
