// ── tests/email-watcher.js ─────────────────────────────────────────────────
// workflow/emailWatcher.js HAD NO TEST FILE AT ALL. Verified:
//     grep -rln "emailWatcher" tests/*.js   ->   nothing
// It runs every 15 minutes in production (scheduler.js:1451) and it is what
// turns a carrier's booking-confirmation PDF into a booking record.
//
// HOW IT WAS FOUND, and the method is the point. Two bugs today were hidden by
// a stub that always returns a trivial value: gmail.findLatestFrom stubbed to
// null hid a feature that had never worked, and scrubCommissionNote tested
// directly hid its own missing wiring. So I swept tests/ for functions that
// are ONLY ever stubbed trivially and never handed real data:
//
//     extractPdfFields              action-invoke.js, simulate-user.js
//     extractBookingFieldsFromText  action-invoke.js, simulate-user.js
//     findPdfByBooking              action-invoke.js, simulate-user.js
//
// All three are emailWatcher's. Nothing anywhere made them return a booking.
//
// EVERY WRITE TARGET IS REDIRECTED TO A TEMP DIR, and the last section asserts
// the real files were not touched. tests/proforma-approval.js put two fake
// rows in her live Google Sheet this morning; that does not happen twice.
// ── THIS FILE OVERWROTE A REAL BOOKING PDF IN HER GOOGLE DRIVE ─────────────
// On its first run, 2026-10-03. The repo ALREADY had the guard --
// helpers/drive.js getDrive() throws when JARVIS_TEST=1, added 2026-08-29
// after tests/yard-chat-log.js uploaded a fixture transcript into her live
// Yard folder. I ran this file directly without setting it, and my stub
// targeted `drive.uploadBookingPdf`, which does not exist; the real name is
// `uploadPdfToDrive`. So the real call went through and replaced
// DALA90721600.pdf (34,771 bytes, a live Oct 1 booking) with an 8-byte fake.
//
// Recovered from Drive's own revision history: revision 1 downloaded and put
// back as the current content, verified 34,771 bytes with a %PDF-1.4 header.
//
// THREE LAYERS NOW, because the guard I wrote first (EW15, comparing local
// file mtimes) watched the edges I had remembered and missed the one that
// mattered:
//   1. JARVIS_TEST=1, set FIRST so the repo's own guard is armed even when
//      this file is run on its own.
//   2. every outbound function stubbed BY ITS REAL NAME, before the module
//      under test loads.
//   3. assertions that each stub was actually reached (EW16), so a renamed
//      or mis-spelled stub fails the test instead of reaching production.
process.env.JARVIS_TEST = '1';

const fs = require('fs');
const os = require('os');
const path = require('path');
const R = (p) => path.join(__dirname, '..', p);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ew-'));
const cfg = require(R('config.js'));
const REAL = { bookings: cfg.BOOKINGS_FILE, settings: cfg.SETTINGS_FILE, processed: cfg.EMAIL_PROCESSED_FILE };
const realMtimes = {};
for (const [k, f] of Object.entries(REAL)) {
    try { realMtimes[k] = fs.statSync(f).mtimeMs; } catch (e) { realMtimes[k] = null; }
}
const REAL2 = { workflow: cfg.WORKFLOW_FILE, alerts: cfg.ALERTS_FILE };
for (const [k, f] of Object.entries(REAL2)) {
    if (!f) continue;
    try { realMtimes[k] = fs.statSync(f).mtimeMs; } catch (e) { realMtimes[k] = null; }
    REAL[k] = f;
}
if (cfg.WORKFLOW_FILE) { cfg.WORKFLOW_FILE = path.join(TMP, 'workflow.json'); fs.writeFileSync(cfg.WORKFLOW_FILE, '{}'); }
if (cfg.ALERTS_FILE) { cfg.ALERTS_FILE = path.join(TMP, 'alerts.json'); fs.writeFileSync(cfg.ALERTS_FILE, '[]'); }
cfg.BOOKINGS_FILE = path.join(TMP, 'bookings.json');
cfg.SETTINGS_FILE = path.join(TMP, 'settings.json');
cfg.EMAIL_PROCESSED_FILE = path.join(TMP, 'processed.json');
fs.writeFileSync(cfg.BOOKINGS_FILE, '{}');
fs.writeFileSync(cfg.SETTINGS_FILE, '{}');
fs.writeFileSync(cfg.EMAIL_PROCESSED_FILE, '[]');
const realGetSettings = cfg.getSettings;
cfg.getSettings = () => ({ gmail_watch_enabled: true });

// ── stubs, all before emailWatcher loads ──────────────────────────────────
const gmail = require(R('helpers/gmail.js'));
let MAIL = [];
let DOWNLOADS = [];
gmail.getGmailRead = () => ({ stub: true });
gmail.listMessages = async () => MAIL.map((m) => ({ id: m.id }));
gmail.getMessage = async (_g, id) => MAIL.find((m) => m.id === id);
gmail.downloadAttachment = async (_g, id, part) => {
    DOWNLOADS.push(part.filename);
    return { filename: part.filename, base64: 'JVBERi0xLjQ=' };
};

const gem = require(R('helpers/gemini.js'));
let EXTRACT = null, CLASSIFY = null;
let EXTRACT_CALLS = 0, CLASSIFY_CALLS = 0;
gem.extractPdfFields = async () => { EXTRACT_CALLS++; return EXTRACT; };
gem.classifyDocument = async () => { CLASSIFY_CALLS++; return CLASSIFY; };
gem.extractBookingFieldsFromText = async () => null;

// BY ITS REAL NAME. `uploadBookingPdf` does not exist in this module, so the
// original stub silently did nothing and the real upload ran.
const drive = require(R('helpers/drive.js'));
let UPLOADS = [];
drive.uploadPdfToDrive = async (name) => { UPLOADS.push(name); return { id: 'stub-drive-id', name }; };
drive.findPdfByBooking = async () => null;
drive.deletePdfByBooking = async () => { throw new Error('a test must never delete from the live Drive'); };
const tracker = require(R('helpers/bookingTracker.js'));
let SHEET_SYNCS = [];
tracker.syncBookingToSheet = async (bkg) => { SHEET_SYNCS.push(bkg); return true; };
const audit = require(R('helpers/auditlog.js'));
let AUDIT = [];
audit.appendAuditLog = async (row) => { AUDIT.push(row); return true; };

const ew = require(R('workflow/emailWatcher.js'));
let ALERTS = [];
ew.init({ sendToManager: async (t) => { ALERTS.push(t); return true; } });

let pass = 0, fail = 0;
const failures = [];
const ck = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
};
const section = (t) => console.log(`\n=== ${t} ===`);

// A real booking confirmation, shaped like the four records already in
// data/bookings.json (HMM, Maersk — her actual carriers).
const CONFIRMED = {
    is_booking_confirmation: true, booking_number: 'DALA90721600',
    carrier: 'HYUNDAI MERCHANT MARINE (AMERICA) INC',
    port_of_loading: 'LOS ANGELES', port_of_discharge: 'BUSAN',
    cutoff_date: '10/06/2026', port_cutoff_date: '10/06/2026', doc_cutoff_date: '10/03/2026',
    erd_date: '10/02/2026', etd: '10/08/2026', eta: '10/25/2026',
    vessel_voyage: 'YM MILESTONE 0102W', container_size: '40HC X 2',
    shipper: 'EDGE METALS INC', consignee: 'DAEKWANG', buyer: 'DAEKWANG',
};
const mail = (id, subject) => ({
    id,
    payload: {
        headers: [{ name: 'Subject', value: subject }, { name: 'From', value: 'Sarah Sung <sarah@sealead.com>' }],
        mimeType: 'multipart/mixed',
        parts: [
            { mimeType: 'text/plain', body: { data: Buffer.from('Please find the booking confirmation attached.').toString('base64') } },
            { mimeType: 'application/pdf', filename: 'BKG DALA90721600.pdf', body: { attachmentId: 'att1', size: 90000 } },
        ],
    },
});
const readBookings = () => JSON.parse(fs.readFileSync(cfg.BOOKINGS_FILE, 'utf8'));
const reset = () => {
    fs.writeFileSync(cfg.BOOKINGS_FILE, '{}');
    fs.writeFileSync(cfg.EMAIL_PROCESSED_FILE, '[]');
    AUDIT = []; ALERTS = []; SHEET_SYNCS = []; DOWNLOADS = []; UPLOADS = [];
    EXTRACT_CALLS = 0; CLASSIFY_CALLS = 0;
};

(async () => {
    section('EW — a real booking confirmation becomes a booking');
    reset();
    MAIL = [mail('m1', 'New Booking DALA90721600')];
    EXTRACT = CONFIRMED;
    CLASSIFY = { is_booking_confirmation: true, is_invoice_or_other: false, document_type: 'booking confirmation' };
    await ew.run();
    const made = readBookings();
    ck('EW1 the booking is created', !!made['DALA90721600'], JSON.stringify(Object.keys(made)));
    ck('EW2 with the carrier and the ports',
        made['DALA90721600'] && /HYUNDAI/.test(made['DALA90721600'].carrier)
        && made['DALA90721600'].port_of_discharge === 'BUSAN', JSON.stringify(made['DALA90721600'] || {}).slice(0, 180));
    ck('EW3 and the dates that matter — ERD and cutoff',
        made['DALA90721600'] && made['DALA90721600'].erd_date === '10/02/2026'
        && made['DALA90721600'].cutoff_date === '10/06/2026',
        JSON.stringify(made['DALA90721600'] || {}).slice(0, 200));
    // ── AN ASYMMETRY WORTH KNOWING, found by this test expecting otherwise.
    // I asserted that "40HC X 2" becomes two container slots. It does not:
    // emailWatcher writes `{ ...fields, booking_number, created_at, source }`
    // and never builds a containers[] array. The four records already in
    // data/bookings.json DO have containers[], because they came from the
    // dashboard's POST /api/bookings, not from this watcher.
    //
    // So a booking auto-created from an email starts with the SIZE STRING and
    // no slots, while the same booking raised by hand starts with slots. That
    // is pinned here as the current behaviour rather than quietly fixed --
    // whether the downstream workflow materialises the slots is a separate
    // question, and changing a write path on a guess is how two paths to one
    // record start disagreeing.
    ck('EW4 the size string is kept verbatim',
        made['DALA90721600'] && made['DALA90721600'].container_size === '40HC X 2',
        JSON.stringify((made['DALA90721600'] || {}).container_size));
    ck('EW4b a watcher-created booking has NO container slots (dashboard ones do)',
        made['DALA90721600'] && made['DALA90721600'].containers === undefined,
        JSON.stringify((made['DALA90721600'] || {}).containers));
    ck('EW4c and it is stamped with where it came from',
        made['DALA90721600'] && made['DALA90721600'].source === 'email_watcher',
        JSON.stringify((made['DALA90721600'] || {}).source));
    ck('EW5 it is synced to the tracking sheet', SHEET_SYNCS.includes('DALA90721600'), JSON.stringify(SHEET_SYNCS));
    ck('EW6 and she is told', ALERTS.length > 0 && /DALA90721600/.test(ALERTS.join('\n')), ALERTS.join(' | ').slice(0, 160));
    ck('EW7 the creation is audited', AUDIT.some((a) => a.intent === 'booking_created'),
        JSON.stringify(AUDIT.map((a) => a.intent)));

    section('EW — the second opinion is load-bearing');
    // An invoice that merely MENTIONS a booking number used to create phantom
    // bookings off extraction alone. classifyDocument is the trust gate.
    reset();
    MAIL = [mail('m2', 'Invoice 9703547 — booking DALA90721600')];
    EXTRACT = { ...CONFIRMED };
    CLASSIFY = { is_booking_confirmation: false, is_invoice_or_other: true, document_type: 'invoice' };
    await ew.run();
    ck('EW8 extraction alone cannot create a booking',
        Object.keys(readBookings()).length === 0, JSON.stringify(readBookings()));
    reset();
    MAIL = [mail('m3', 'Booking confirmation')];
    EXTRACT = { ...CONFIRMED };
    CLASSIFY = null;   // a failed classification call
    await ew.run();
    ck('EW9 a FAILED classification fails safe — no booking',
        Object.keys(readBookings()).length === 0, JSON.stringify(readBookings()));

    section('EW — nothing usable, nothing created');
    reset();
    MAIL = [mail('m4', 'Rate sheet')];
    EXTRACT = { is_booking_confirmation: true, booking_number: null };
    CLASSIFY = { is_booking_confirmation: true, is_invoice_or_other: false };
    await ew.run();
    ck('EW10 a confirmation with no booking number creates nothing',
        Object.keys(readBookings()).length === 0, JSON.stringify(readBookings()));
    ck('EW11 and says why in the audit log',
        AUDIT.some((a) => a.intent === 'no_booking_number'), JSON.stringify(AUDIT.map((a) => a.intent)));

    section('EW — the kill switch and the re-entry lock');
    reset();
    cfg.getSettings = () => ({ gmail_watch_enabled: false });
    MAIL = [mail('m5', 'New Booking DALA90721600')];
    EXTRACT = CONFIRMED;
    CLASSIFY = { is_booking_confirmation: true, is_invoice_or_other: false };
    await ew.run();
    ck('EW12 disabled in settings means it does not even look',
        EXTRACT_CALLS === 0 && Object.keys(readBookings()).length === 0, `extract calls = ${EXTRACT_CALLS}`);
    cfg.getSettings = () => ({ gmail_watch_enabled: true });

    section('EW — a second run does not duplicate the booking');
    reset();
    MAIL = [mail('m6', 'New Booking DALA90721600')];
    await ew.run();
    const afterFirst = JSON.stringify(readBookings());
    await ew.run();
    ck('EW13 the message is remembered and not reprocessed',
        JSON.stringify(readBookings()) === afterFirst, 'the booking changed on a second poll');
    ck('EW14 and only one booking exists', Object.keys(readBookings()).length === 1,
        JSON.stringify(Object.keys(readBookings())));

    section('EW — THIS TEST MUST NOT TOUCH HER DATA');
    for (const [k, f] of Object.entries(REAL)) {
        let now = null;
        try { now = fs.statSync(f).mtimeMs; } catch (e) { now = null; }
        ck(`EW15.${k} ${path.basename(f)} is untouched`, now === realMtimes[k],
            `was ${realMtimes[k]}, now ${now}`);
    }
    section('EW — and the stubs were REACHED, not just declared');
    // The layer the first version of this file lacked. A stub under a name the
    // module does not use is not a stub; it is a no-op that lets the real call
    // through, which is exactly how a live booking PDF got overwritten.
    reset();
    MAIL = [mail('m7', 'New Booking DALA90721600')];
    EXTRACT = CONFIRMED;
    CLASSIFY = { is_booking_confirmation: true, is_invoice_or_other: false };
    await ew.run();
    ck('EW16 the Drive upload went through the STUB', UPLOADS.length === 1,
        `uploads seen by the stub = ${UPLOADS.length} — zero means the real uploadPdfToDrive ran`);
    ck('EW17 and the attachment through the download stub', DOWNLOADS.length >= 1,
        JSON.stringify(DOWNLOADS));
    ck('EW18 the extractor and the classifier were both called',
        EXTRACT_CALLS === 1 && CLASSIFY_CALLS === 1, `extract=${EXTRACT_CALLS} classify=${CLASSIFY_CALLS}`);
    // The repo's own guard, armed. If JARVIS_TEST is ever dropped from the top
    // of this file, this fails instead of a real upload happening.
    let guarded = false;
    try { require(R('helpers/drive.js')).__nothing; const g = require('googleapis'); void g;
        const src = fs.readFileSync(R('helpers/drive.js'), 'utf8');
        guarded = /JARVIS_TEST === '1'/.test(src) && process.env.JARVIS_TEST === '1';
    } catch (e) { guarded = false; }
    ck('EW19 JARVIS_TEST is set, so helpers/drive.js refuses the live Drive', guarded,
        `JARVIS_TEST = ${JSON.stringify(process.env.JARVIS_TEST)}`);

    cfg.getSettings = realGetSettings;

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILED: ' + failures.join(', ')); process.exit(1); }
})();
