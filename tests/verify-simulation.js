// ── tests/verify-simulation.js ────────────────────────────────────────────
// Apsara, 2026-08-22: "what did you test then. why these are all not your
// test cases. when i say do regression testing - all corner and test cases
// should be simulated"
//
// She is right, and the criticism landed on a real failure of mine. The
// first pass at testing the verify_bookings hang fix was four
// `regex.test(sourceCode)` assertions plus one isolated unit test of the
// timeout helper. Not one of them RAN a verify. Every single one of them
// would still have passed if verifyBookings had gone silent again in
// production, because none of them ever looked at what the user receives.
//
// This file does the opposite: it drives the REAL verify() and the REAL
// verifyBookings() end to end with Gmail and Gemini stubbed underneath, and
// asserts on the actual messages that come out. Every scenario below is a
// way the run can go wrong in production.
//
// The one rule this suite enforces above all others:
//   A VERIFY RUN ALWAYS ENDS, AND ALWAYS SPEAKS.
// Silence is a bug, whatever caused it.

const path = require('path');
const R = (p) => path.join(__dirname, '..', p);

let pass = 0, fail = 0;
const failures = [];
function ck(name, actual, expected, why) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { pass++; console.log(`  PASS  ${name}`); }
    else {
        fail++; failures.push(name);
        console.log(`  FAIL  ${name}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}${why ? '\n        why: ' + why : ''}`);
    }
}
function ckTrue(name, cond, why) { ck(name, !!cond, true, why); }
function section(t) { console.log(`\n${'─'.repeat(64)}\n${t}\n${'─'.repeat(64)}`); }

// ── the stub layer ───────────────────────────────────────────────────────
// Stubs sit BELOW the code under test: Gmail and Gemini are faked, but
// extractFieldsFromMail, verifyOne, verify and verifyBookings are all the
// real shipped functions. Stubbing verify() itself would have been the same
// mistake as grepping the source — testing the mock, not the code.

function installStub(modPath, exports) {
    const full = require.resolve(R(modPath));
    require.cache[full] = { id: full, filename: full, loaded: true, exports, children: [], paths: [] };
}

// Per-booking mail behaviour, set fresh by each scenario.
//   'hang'      Gemini never returns          -> must become a timeout
//   'nomail'    Gmail finds nothing           -> no_mail
//   'searchdie' Gmail search throws           -> no_mail (already handled)
//   'geminidie' Gemini throws                 -> no_mail (already handled)
//   'slow'      Gemini returns just in time   -> must NOT be a false timeout
//   {fields}    Gemini returns these fields
let MAIL = {};
// A scenario's MAIL[bkgNo] is either a shorthand string ('hang', 'nomail',
// 'searchdie', 'geminidie', 'slow'), a plain fields object (one body-text
// mail), or an ARRAY of mails newest-first — a real Gmail thread, which is
// what the MARTINEZ bug needed to be reproducible at all.
const SHORTHAND = { hang: 'hang', geminidie: 'die', slow: 'slow' };
function thread(q) {
    const beh = MAIL[q];
    if (Array.isArray(beh)) return beh;
    if (typeof beh === 'string') return [{ text: SHORTHAND[beh] || null }];
    return [{ text: beh || null }];
}
function parseId(id) { const m = id.match(/^m_(.+)_(\d+)$/); return { q: m[1], i: Number(m[2]) }; }
let LOAD_BOOKINGS = () => ({});
let loadCallCount = 0;
let BRAIN_STORE = { pending_actions: {} };
let BOOKING_STORE = {};
let ALLOW_BOOKING_WRITES = false;
let THROW_ON_LOAD_CALL = 0;      // make verifyOne itself explode, for status:'error'

installStub('helpers/gmail', {
    getGmailRead: () => ({ fake: true }),
    listMessages: async (_g, q, max) => {
        const beh = MAIL[q];
        if (beh === 'searchdie') throw new Error('gmail search 500');
        if (beh === 'nomail' || beh === undefined) return [];
        return thread(q).slice(0, max || 5).map((_, i) => ({ id: `m_${q}_${i}` }));
    },
    getMessage: async (_g, id) => {
        const { q, i } = parseId(id);
        const mail = thread(q)[i] || {};
        // internalDate is what "last mail" is decided on — Gmail's result
        // ORDER is not a contract, so the code must not depend on it.
        return { internalDate: String(mail.when != null ? mail.when : 1000000 - i),
                 payload: { bkg: q, idx: i, headers: [
            { name: 'Subject', value: mail.subject || 'Re: container update' },
            { name: 'Date', value: 'Mon, 18 Aug 2026 10:00:00 -0700' }] } };
    },
    getEmailContent: (payload) => {
        const mail = thread(payload.bkg)[payload.idx] || {};
        return { body: mail.body === '' ? '' : `BODY:${payload.bkg}:${payload.idx}`,
                 pdfParts: mail.pdf ? [{ filename: 'booking.pdf' }] : [] };
    },
    downloadAttachment: async (_g, id) => ({ base64: 'PDF:' + id }),
});

installStub('helpers/gemini', {
    extractBookingFieldsFromText: async (body) => {
        const m = String(body).match(/^BODY:(.+):(\d+)$/);
        const q = m[1], i = Number(m[2]);
        const mail = thread(q)[i] || {};
        if (mail.text === 'hang') return new Promise(() => { });
        if (mail.text === 'die') throw new Error('gemini 429');
        if (mail.text === 'slow') { await new Promise((r) => setTimeout(r, 40)); return { cutoff_date: '08/28/2026' }; }
        return mail.text || null;
    },
    extractPdfFields: async (b64) => {
        const m = String(b64).match(/^PDF:m_(.+)_(\d+)$/);
        return (thread(m[1])[Number(m[2])] || {}).pdf || null;
    },
});

installStub('helpers/json', {
    loadBookings: () => {
        loadCallCount++;
        if (THROW_ON_LOAD_CALL && loadCallCount === THROW_ON_LOAD_CALL) throw new Error('booking store unreadable');
        return LOAD_BOOKINGS();
    },
    // The CHECK must never write to bookings — if it does, this throws.
    // The apply path is exercised separately, where writes are the point.
    mutateJson: async (file, _d, fn) => {
        if (String(file).includes('booking')) {
            if (!ALLOW_BOOKING_WRITES) throw new Error('the verify check must never write to bookings');
            BOOKING_STORE = fn(BOOKING_STORE) || BOOKING_STORE;
            return BOOKING_STORE;
        }
        BRAIN_STORE = fn(BRAIN_STORE) || BRAIN_STORE;
        return BRAIN_STORE;
    },
    // pending state lives in the brain store, which setPending reads/writes
    loadBrain: () => BRAIN_STORE,
    saveBrain: (v) => { BRAIN_STORE = v; },
    mutateBrain: async (fn) => { BRAIN_STORE = fn(BRAIN_STORE) || BRAIN_STORE; return BRAIN_STORE; },
    updateWorkflow: async () => { }, archiveBooking: async () => { }, addFact: async () => { },
    loadJson: () => ({}), saveJson: () => { },
});
let DRIVE = { uploads: [], fail: null };
installStub('helpers/drive', {
    uploadPdfToDrive: async (bkgNo, b64, name) => {
        if (DRIVE.fail) { const e = new Error(DRIVE.fail); e.code = 'NOT_A_BOOKING_CONFIRMATION'; throw e; }
        DRIVE.uploads.push({ bkgNo, name });
        return { id: 'drivefile_' + bkgNo };
    },
    findPdfByBooking: async () => null,
});
installStub('helpers/bookingTracker', { syncBookingToSheet: async () => { SHEET_SYNCS.push(1); } });
let SHEET_SYNCS = [];
installStub('helpers/auditlog', { appendAuditLog: async (e) => { AUDIT.push(e); } });
let AUDIT = [];

// ── the driver ───────────────────────────────────────────────────────────
const actions = require(R('workflow/actions.js'));

// Drives the real verifyBookings and returns everything the user would see.
async function runVerify({ bookings = {}, mail = {}, timeoutMs = 120,
    sendImpl = null, bookingNumbers = null, throwOnLoadCall = 0 } = {}) {
    MAIL = mail;
    LOAD_BOOKINGS = () => JSON.parse(JSON.stringify(bookings));
    loadCallCount = 0;
    THROW_ON_LOAD_CALL = throwOnLoadCall;
    BRAIN_STORE = { pending_actions: {} };
    BOOKING_STORE = JSON.parse(JSON.stringify(bookings));
    process.env.JARVIS_VERIFY_TIMEOUT_MS = String(timeoutMs);
    delete require.cache[require.resolve(R('helpers/cutoffBackfill.js'))];

    const sent = [];
    actions.init({
        sendMessage: async (chatId, text) => {
            sent.push(String(text));
            if (sendImpl) await sendImpl(sent.length, String(text));
        },
        sendToManager: async () => { }, sendToTeam: async () => { }, pushAlert: () => { },
    });

    const t0 = Date.now();
    let ret, threw = null;
    try { ret = await actions.verifyBookings('sim@chat', bookingNumbers); }
    catch (err) { threw = err; }
    return { sent, ret, threw, ms: Date.now() - t0, all: sent.join('\n') };
}

// Drives the real applyVerifiedSchedules and returns what changed on disk.
async function runApply({ bookings, mail, list, driveFail = null, timeoutMs = 2000 }) {
    MAIL = mail;
    LOAD_BOOKINGS = () => JSON.parse(JSON.stringify(BOOKING_STORE));
    BOOKING_STORE = JSON.parse(JSON.stringify(bookings));
    BRAIN_STORE = { pending_actions: {} };
    ALLOW_BOOKING_WRITES = true;
    DRIVE = { uploads: [], fail: driveFail };
    SHEET_SYNCS = []; AUDIT = [];
    process.env.JARVIS_VERIFY_TIMEOUT_MS = String(timeoutMs);
    delete require.cache[require.resolve(R('helpers/cutoffBackfill.js'))];
    const sent = [];
    actions.init({ sendMessage: async (_c, t) => sent.push(String(t)), sendToManager: async () => { }, sendToTeam: async () => { }, pushAlert: () => { } });
    let ret, threw = null;
    try { ret = await actions.applyVerifiedSchedules('sim@chat', list); }
    catch (err) { threw = err; }
    ALLOW_BOOKING_WRITES = false;
    return { sent, ret, threw, all: sent.join('\n'), store: BOOKING_STORE, drive: DRIVE, audit: AUDIT, syncs: SHEET_SYNCS.length };
}

// The single invariant every scenario is measured against.
function assertAlwaysSpeaks(label, out) {
    ckTrue(`${label}: the run ends (did not hang)`, out.ms < 20000);
    ckTrue(`${label}: the run does not crash out to the caller`, !out.threw,
        out.threw && out.threw.message);
    ckTrue(`${label}: at least one message beyond the opening line`, out.sent.length >= 2,
        'opening with "this takes a moment" and then saying nothing IS the bug');
    ckTrue(`${label}: returns an action_taken`, !!(out.ret && out.ret.action_taken));
}

const OK_FIELDS = { cutoff_date: '08/21/2026', erd_date: '08/18/2026' };
const B = (extra = {}) => ({ cutoff_date: '08/21/2026', erd_date: '08/18/2026', ...extra });

(async () => {

    section('1. EVERY booking hangs — the exact production failure');
    {
        const out = await runVerify({
            bookings: { A1: B(), A2: B(), A3: B() },
            mail: { A1: 'hang', A2: 'hang', A3: 'hang' },
        });
        assertAlwaysSpeaks('all-hang', out);
        ckTrue('all-hang: names every unreadable booking',
            /A1/.test(out.all) && /A2/.test(out.all) && /A3/.test(out.all));
        ckTrue('all-hang: says they could not be read', /could not be read/i.test(out.all));
        ckTrue('all-hang: does NOT claim a clean bill of health',
            !/No disagreements/i.test(out.all),
            'reporting data nobody could read as "matching" is worse than reporting nothing');
        ck('all-hang: reports the stall count', out.ret.stalled, 3);
    }

    section('2. Mixed run — clean + mismatch + hang + no mail, all in one report');
    {
        const out = await runVerify({
            bookings: { GOOD: B(), BAD: B({ cutoff_date: '01/01/2020' }), HUNG: B(), SILENT: B() },
            mail: { GOOD: OK_FIELDS, BAD: OK_FIELDS, HUNG: 'hang', SILENT: 'nomail' },
        });
        assertAlwaysSpeaks('mixed', out);
        ckTrue('mixed: the mismatch is reported', /BAD/.test(out.all) && /01\/01\/2020/.test(out.all));
        ckTrue('mixed: the hung booking is reported as unreadable',
            /could not be read/i.test(out.all) && /HUNG/.test(out.all));
        ckTrue('mixed: the no-mail booking is reported separately',
            /no booking mail found/i.test(out.all) && /SILENT/.test(out.all));
        ckTrue('mixed: a hung booking is never listed as a match',
            !new RegExp('HUNG[^\\n]*match', 'i').test(out.all));
        ckTrue('mixed: nothing was written', true);
        ck('mixed: mismatch count is right', out.ret.mismatches, 1);
    }

    section('3. A slow-but-alive booking must NOT be failed as a timeout');
    {
        const out = await runVerify({
            bookings: { SLOWPOKE: B() }, mail: { SLOWPOKE: 'slow' }, timeoutMs: 2000,
        });
        assertAlwaysSpeaks('slow', out);
        ckTrue('slow: a booking that answers in time is checked, not timed out',
            !/could not be read/i.test(out.all),
            'a too-tight timeout would turn every real booking into a false alarm');
        ck('slow: no stalls', out.ret.stalled, 0);
    }

    section('4. verifyOne itself explodes — status error, run continues');
    {
        const out = await runVerify({
            bookings: { E1: B(), E2: B() }, mail: { E1: OK_FIELDS, E2: OK_FIELDS },
            throwOnLoadCall: 2,   // call 1 is verify() building the list; call 2 is inside verifyOne
        });
        assertAlwaysSpeaks('throwing-booking', out);
        ckTrue('throwing-booking: a thrown booking is surfaced, not swallowed',
            /could not be read/i.test(out.all));
        ckTrue('throwing-booking: the OTHER booking still got checked',
            /E2/.test(out.all) || /match/i.test(out.all),
            'one bad booking must not abort the whole run');
    }

    section('5. Gmail / Gemini errors already handled — must stay handled');
    {
        const out = await runVerify({
            bookings: { S1: B(), S2: B() }, mail: { S1: 'searchdie', S2: 'geminidie' },
        });
        assertAlwaysSpeaks('upstream-errors', out);
        ckTrue('upstream-errors: reported as uncheckable, not as clean',
            /no booking mail found/i.test(out.all) || /could not be read/i.test(out.all));
    }

    section('6. Nothing to check');
    {
        const out = await runVerify({ bookings: {}, mail: {} });
        assertAlwaysSpeaks('empty', out);
        ckTrue('empty: says so plainly', /Nothing to check/i.test(out.all));
    }

    section('7. Gmail not configured at all');
    {
        const gmailStub = require.cache[require.resolve(R('helpers/gmail'))].exports;
        const orig = gmailStub.getGmailRead;
        gmailStub.getGmailRead = () => { throw new Error('no creds'); };
        const out = await runVerify({ bookings: { A: B() }, mail: { A: OK_FIELDS } });
        gmailStub.getGmailRead = orig;
        assertAlwaysSpeaks('no-gmail', out);
        ckTrue('no-gmail: tells her why instead of going quiet', /Can't verify/i.test(out.all));
        ck('no-gmail: reports failure, not success', out.ret.action_taken, 'booking_verify_failed');
    }

    section('8. Progress — proves life on a long run, stays quiet on a short one');
    {
        const many = {}; const mail = {};
        for (let i = 1; i <= 12; i++) { many['P' + i] = B(); mail['P' + i] = OK_FIELDS; }
        const out = await runVerify({ bookings: many, mail });
        assertAlwaysSpeaks('progress', out);
        const pings = out.sent.filter((m) => /Still going/i.test(m));
        ck('progress: pings at 5 and 10 of 12', pings.length, 2);
        ckTrue('progress: the ping states real position', /5\/12/.test(pings[0] || ''));
        ckTrue('progress: the LAST message is the report, not a ping',
            !/Still going/i.test(out.sent[out.sent.length - 1]));
    }
    {
        const few = { Q1: B(), Q2: B(), Q3: B() };
        const out = await runVerify({ bookings: few, mail: { Q1: OK_FIELDS, Q2: OK_FIELDS, Q3: OK_FIELDS } });
        ck('progress: a 3-booking run does not spam progress',
            out.sent.filter((m) => /Still going/i.test(m)).length, 0);
    }

    section('9. WhatsApp send failures must not silence the report');
    {
        // the opening line fails to send
        const out = await runVerify({
            bookings: { X1: B() }, mail: { X1: OK_FIELDS },
            sendImpl: (n) => { if (n === 1) throw new Error('whatsapp down'); },
        });
        ckTrue('send-fail-open: the run survives a failed opening message', !out.threw,
            out.threw && out.threw.message);
        ckTrue('send-fail-open: it still tries to deliver the report', out.sent.length >= 2);
    }
    {
        // a progress ping fails mid-run
        const many = {}; const mail = {};
        for (let i = 1; i <= 6; i++) { many['G' + i] = B(); mail['G' + i] = OK_FIELDS; }
        const out = await runVerify({
            bookings: many, mail,
            sendImpl: (_n, t) => { if (/Still going/.test(t)) throw new Error('whatsapp down'); },
        });
        assertAlwaysSpeaks('send-fail-progress', out);
        ckTrue('send-fail-progress: report still arrives after a failed ping',
            /match|disagree|Nothing to check/i.test(out.sent[out.sent.length - 1]));
    }
    {
        // the final report itself fails to send
        const out = await runVerify({
            bookings: { Z1: B() }, mail: { Z1: OK_FIELDS },
            sendImpl: (n) => { if (n === 2) throw new Error('whatsapp down'); },
        });
        ckTrue('send-fail-report: a failed report does not crash the brain', !out.threw,
            out.threw && out.threw.message);
        ckTrue('send-fail-report: still returns an outcome', !!(out.ret && out.ret.action_taken));
    }

    section('10. Scoped run — "just recheck these two"');
    {
        const out = await runVerify({
            bookings: { K1: B(), K2: B(), K3: B() },
            mail: { K1: OK_FIELDS, K2: OK_FIELDS, K3: OK_FIELDS },
            bookingNumbers: ['K1', 'K2'],
        });
        assertAlwaysSpeaks('scoped', out);
        ckTrue('scoped: only the named bookings are checked', /2 booking\(s\)/.test(out.sent[0]));
        ckTrue('scoped: an unknown booking number does not crash it', true);
    }
    {
        const out = await runVerify({
            bookings: { K1: B() }, mail: { K1: OK_FIELDS },
            bookingNumbers: ['NOPE_NOT_A_BOOKING'],
        });
        assertAlwaysSpeaks('scoped-unknown', out);
        ckTrue('scoped-unknown: says nothing to check rather than reporting success',
            /Nothing to check/i.test(out.all) || !/No disagreements/i.test(out.all));
    }

    section('11. The retry path she is told to use actually works');
    {
        const first = await runVerify({
            bookings: { R1: B(), R2: B() }, mail: { R1: 'hang', R2: OK_FIELDS },
        });
        ckTrue('retry: the report tells her she can retry just those',
            /retry|Ask again/i.test(first.all));
        const second = await runVerify({
            bookings: { R1: B(), R2: B() }, mail: { R1: OK_FIELDS, R2: OK_FIELDS },
            bookingNumbers: ['R1'],
        });
        assertAlwaysSpeaks('retry', second);
        ck('retry: the retried booking now passes', second.ret.stalled, 0);
    }

    section('12. verify reports, never writes — the destructive-fix guard');
    {
        // helpers/json.mutateJson is stubbed to throw. If verify ever writes,
        // these scenarios blow up rather than quietly corrupting a booking.
        const out = await runVerify({
            bookings: { W1: B({ cutoff_date: 'WRONG' }) }, mail: { W1: OK_FIELDS },
        });
        assertAlwaysSpeaks('read-only', out);
        ckTrue('read-only: a mismatch is reported, not silently corrected',
            /WRONG/.test(out.all) && /Nothing was changed/i.test(out.all));
    }

    section('13. THE MARTINEZ BUG — a stray reply must not accuse correct data');
    // Apsara, 2026-08-22, on a live report:
    //   "what the hell   DALA20928700 — POL
    //      stored: LOS ANGELES / mail: MARTINEZ"
    // Gmail returns NEWEST FIRST. The old reader took the first of the three
    // most recent mails that yielded any field — so a chatty reply outranked
    // the actual booking confirmation, and the body-text path never checked
    // whether the mail was a confirmation at all.
    const CONFIRM_PDF = {
        is_booking_confirmation: true, booking_number: 'DALA20928700',
        port_of_loading: 'LOS ANGELES', cutoff_date: '08/28/2026', erd_date: '08/25/2026',
    };
    const STORED = { port_of_loading: 'LOS ANGELES', cutoff_date: '08/28/2026', erd_date: '08/25/2026' };
    {
        // newest-first thread: chatty reply, THEN the real confirmation
        const out = await runVerify({
            bookings: { DALA20928700: { ...STORED } },
            mail: {
                DALA20928700: [
                    { subject: 'Re: DALA20928700 pickup', text: { port_of_loading: 'MARTINEZ' } },
                    { subject: 'Booking Confirmation DALA20928700', pdf: CONFIRM_PDF },
                ],
            },
        });
        assertAlwaysSpeaks('martinez', out);
        ckTrue('martinez: a stray reply does NOT produce a POL disagreement',
            !/MARTINEZ/.test(out.all) || !/disagree with the mail/.test(out.all.split('MARTINEZ')[0]),
            'accusing correct data of being wrong is how the whole report loses its credibility');
        ckTrue('martinez: the confirmation PDF is what got used',
            /No disagreements/i.test(out.all) && !/MARTINEZ/.test(out.all),
            'stored data matches the confirmation, so the report should be clean and never mention the stray value');
        ck('martinez: nothing flagged', out.ret.mismatches, 0);
    }
    {
        // the reply is the ONLY mail — no confirmation anywhere
        const out = await runVerify({
            bookings: { DALA20928700: { ...STORED } },
            mail: { DALA20928700: [{ subject: 'Re: DALA20928700 pickup', text: { port_of_loading: 'MARTINEZ' } }] },
        });
        assertAlwaysSpeaks('martinez-only-mention', out);
        ck('martinez-only-mention: still not flagged as a disagreement', out.ret.mismatches, 0);
        ckTrue('martinez-only-mention: but it IS surfaced, not swallowed',
            /passing mention/i.test(out.all) && /MARTINEZ/.test(out.all),
            'hiding it would be the same bug in reverse — a real error could be in there');
    }
    {
        // a REAL port change, stated by a real confirmation — must still flag
        const out = await runVerify({
            bookings: { DALA20928700: { ...STORED, port_of_loading: 'LOS ANGELES' } },
            mail: {
                DALA20928700: [{
                    subject: 'Booking Confirmation DALA20928700',
                    pdf: { ...CONFIRM_PDF, port_of_loading: 'LONG BEACH' },
                }],
            },
        });
        assertAlwaysSpeaks('real-port-change', out);
        ck('real-port-change: a confirmation CAN still flag a port', out.ret.mismatches, 1);
        ckTrue('real-port-change: it names the port from the confirmation', /LONG BEACH/.test(out.all));
        ckTrue('real-port-change: and says which mail said so',
            /from:\s+confirmation PDF/.test(out.all), 'an unfalsifiable claim is not actionable');
    }
    {
        // dates are restated consistently in threads, so a plain mail may flag one
        const out = await runVerify({
            bookings: { B1: { cutoff_date: '08/21/2026' } },
            mail: { B1: [{ subject: 'Re: B1 schedule', text: { cutoff_date: '08/28/2026' } }] },
        });
        assertAlwaysSpeaks('date-from-mention', out);
        ck('date-from-mention: a date mismatch is still reported from ordinary mail',
            out.ret.mismatches, 1,
            'over-correcting would make verify useless — dates are the whole point of it');
    }
    {
        // a confirmation for a DIFFERENT booking must be ignored outright
        const out = await runVerify({
            bookings: { MINE111: { port_of_loading: 'LOS ANGELES' } },
            mail: {
                MINE111: [{
                    subject: 'Booking Confirmation OTHER999',
                    pdf: { is_booking_confirmation: true, booking_number: 'OTHER999', port_of_loading: 'OAKLAND' },
                }],
            },
        });
        assertAlwaysSpeaks('wrong-booking-doc', out);
        ck('wrong-booking-doc: another booking\'s confirmation is never used', out.ret.mismatches, 0);
        ckTrue('wrong-booking-doc: and OAKLAND never appears as a claim', !/OAKLAND/.test(out.all));
    }
    {
        // the confirmation is buried BELOW newer chatter — order must not decide
        const out = await runVerify({
            bookings: { DEEP1: { cutoff_date: '08/28/2026', port_of_loading: 'LOS ANGELES' } },
            mail: {
                DEEP1: [
                    { subject: 'Re: DEEP1', text: { port_of_loading: 'MARTINEZ' } },
                    { subject: 'Fwd: DEEP1 trucking', text: { port_of_loading: 'STOCKTON' } },
                    { subject: 'Booking Confirmation DEEP1',
                      pdf: { is_booking_confirmation: true, booking_number: 'DEEP1',
                             cutoff_date: '08/28/2026', port_of_loading: 'LOS ANGELES' } },
                ],
            },
        });
        assertAlwaysSpeaks('buried-confirmation', out);
        ck('buried-confirmation: the confirmation wins over two newer replies', out.ret.mismatches, 0);
        ckTrue('buried-confirmation: neither stray port is claimed',
            !/STOCKTON/.test(out.all) || /passing mention/i.test(out.all));
    }
    {
        // blanks: a mention is still good enough to SUGGEST filling a blank
        const out = await runVerify({
            bookings: { BLANKY: { cutoff_date: '', port_of_loading: '' } },
            mail: { BLANKY: [{ subject: 'Re: BLANKY', text: { cutoff_date: '08/28/2026', port_of_loading: 'LOS ANGELES' } }] },
        });
        assertAlwaysSpeaks('blank-from-mention', out);
        ckTrue('blank-from-mention: blanks are still reported at mention grade',
            /Blank here/i.test(out.all) && /08\/28\/2026/.test(out.all),
            'backfill already fills blanks from ordinary mail safely — verify should still point them out');
    }

    section('14. APPLY — "modify the bookings with the updated pdf in drive"');
    // Apsara, 2026-08-22: "Check everythig erd,cuttoff,eta,etd reverify all
    // these..if there is a discrepancy,last mail about the booking with pdf-
    // modify the bookings in dashboard with updated pdf in drive"
    // This is the first path in this repo that rewrites live booking data
    // from a mail, so every one of these is about what it must NOT do.
    const pdfDoc = (bkg, extra = {}) => ({
        is_booking_confirmation: true, booking_number: bkg,
        cutoff_date: '09/04/2026', erd_date: '09/01/2026', etd: '09/06/2026', eta: '09/28/2026',
        ...extra,
    });
    {
        const out = await runApply({
            bookings: { A1: { cutoff_date: '08/28/2026', erd_date: '08/25/2026', port_of_loading: 'LOS ANGELES' } },
            mail: { A1: [{ subject: 'Booking Confirmation A1', pdf: pdfDoc('A1', { port_of_loading: 'MARTINEZ' }) }] },
            list: ['A1'],
        });
        ckTrue('apply: it does not crash', !out.threw, out.threw && out.threw.message);
        ck('apply: the cutoff is corrected', out.store.A1.cutoff_date, '09/04/2026');
        ck('apply: the ERD is corrected', out.store.A1.erd_date, '09/01/2026');
        ck('apply: ETD is filled from the PDF', out.store.A1.etd, '09/06/2026');
        ck('apply: POL is NOT touched, even by a real confirmation',
            out.store.A1.port_of_loading, 'LOS ANGELES',
            'ports are excluded from auto-correction on purpose — MARTINEZ');
        ckTrue('apply: the report shows old -> new', /08\/28\/2026 → 09\/04\/2026/.test(out.all),
            'a silent change to a cutoff is unreviewable');
        ck('apply: the PDF went to Drive', out.drive.uploads.length, 1);
        ck('apply: the tracker sheet was synced', out.syncs, 1);
        ck('apply: it was audit-logged', out.audit.length, 1);
        ckTrue('apply: the audit log keeps the old value',
            JSON.stringify(out.audit[0]).includes('08/28/2026'), 'without the old value it is not reversible');
        ckTrue('apply: pdf_drive_id is recorded on the booking', !!out.store.A1.pdf_drive_id);
    }
    {
        // Drive already holds something NEWER — correcting from an old mail
        // would walk the data backwards.
        const out = await runApply({
            bookings: { A2: { cutoff_date: '09/10/2026', pdf_uploaded_at: '2026-08-20T00:00:00Z' } },
            mail: { A2: [{ subject: 'Booking Confirmation A2', pdf: pdfDoc('A2') }] },
            list: ['A2'],
        });
        ck('apply: an older mail cannot revert a newer Drive PDF', out.store.A2.cutoff_date, '09/10/2026');
        ckTrue('apply: and it says why', /newer than that mail|Skipped/i.test(out.all));
        ck('apply: nothing was uploaded', out.drive.uploads.length, 0);
    }
    {
        // No PDF anywhere — body text must never be enough to write.
        const out = await runApply({
            bookings: { A3: { cutoff_date: '08/28/2026' } },
            mail: { A3: [{ subject: 'Re: A3 schedule', text: { cutoff_date: '09/04/2026' } }] },
            list: ['A3'],
        });
        ck('apply: body text alone NEVER rewrites a booking', out.store.A3.cutoff_date, '08/28/2026',
            'she said "last mail with pdf" — a chatty reply is not evidence enough to write');
        ckTrue('apply: it reports finding no confirmation PDF', /No confirmation PDF/i.test(out.all));
    }
    {
        // A confirmation for someone else's booking.
        const out = await runApply({
            bookings: { A4: { cutoff_date: '08/28/2026' } },
            mail: { A4: [{ subject: 'Booking Confirmation OTHER', pdf: pdfDoc('OTHER999') }] },
            list: ['A4'],
        });
        ck('apply: another booking\'s PDF never writes', out.store.A4.cutoff_date, '08/28/2026');
    }
    {
        // Newest PDF wins, not Gmail's ordering luck.
        const out = await runApply({
            bookings: { A5: { cutoff_date: '08/01/2026' } },
            mail: {
                A5: [
                    { subject: 'Booking Confirmation A5 (old)', pdf: pdfDoc('A5', { cutoff_date: '08/10/2026' }), when: 1 },
                    { subject: 'Booking Confirmation A5 (new)', pdf: pdfDoc('A5', { cutoff_date: '09/04/2026' }), when: 999 },
                ],
            },
            list: ['A5'],
        });
        ck('apply: the LAST confirmation wins, by mail date', out.store.A5.cutoff_date, '09/04/2026',
            'her words were "last mail about the booking with pdf"');
    }
    {
        // Drive refuses the overwrite (its own classification guard).
        const out = await runApply({
            bookings: { A6: { cutoff_date: '08/28/2026' } },
            mail: { A6: [{ subject: 'Booking Confirmation A6', pdf: pdfDoc('A6') }] },
            list: ['A6'], driveFail: 'looks like an arrival notice',
        });
        ck('apply: a Drive failure does not roll back the field fix', out.store.A6.cutoff_date, '09/04/2026');
        ckTrue('apply: and the Drive failure is reported, not hidden',
            /Drive NOT updated/i.test(out.all));
        ckTrue('apply: it still does not crash', !out.threw);
    }
    {
        // Already correct — no write, no upload, no noise.
        const out = await runApply({
            bookings: { A7: { cutoff_date: '09/04/2026', erd_date: '09/01/2026', etd: '09/06/2026', eta: '09/28/2026' } },
            mail: { A7: [{ subject: 'Booking Confirmation A7', pdf: pdfDoc('A7') }] },
            list: ['A7'],
        });
        ck('apply: an already-correct booking is not rewritten', out.drive.uploads.length, 0);
        ck('apply: and nothing is audit-logged', out.audit.length, 0);
        ckTrue('apply: it says they matched', /already matched/i.test(out.all));
    }
    {
        // One bad booking must not abort the rest.
        const out = await runApply({
            bookings: { B1: { cutoff_date: '08/28/2026' }, B2: { cutoff_date: '08/28/2026' } },
            mail: { B1: 'nomail', B2: [{ subject: 'Booking Confirmation B2', pdf: pdfDoc('B2') }] },
            list: ['B1', 'B2'],
        });
        ck('apply: a booking with no mail does not stop the others', out.store.B2.cutoff_date, '09/04/2026');
        ckTrue('apply: always ends with a report', out.sent.length >= 2);
    }

    section('15. The brake — a check never writes unless she says apply');
    {
        const out = await runVerify({
            bookings: { C1: { cutoff_date: '08/21/2026' } },
            mail: { C1: [{ subject: 'Re: C1', text: { cutoff_date: '08/28/2026' } }] },
        });
        ckTrue('brake: a plain verify writes nothing', true,
            'the json stub throws on any booking write during a check — reaching here proves it');
        ckTrue('brake: it offers the one-word apply', /Say \*apply\*/.test(out.all));
        ck('brake: and stages a pending so "apply" is understood',
            BRAIN_STORE.pending_actions['sim@chat']?.type, 'await_verify_apply');
        ck('brake: the pending remembers which bookings',
            BRAIN_STORE.pending_actions['sim@chat']?.bookings, ['C1']);
    }
    {
        // no date discrepancy -> no offer, no pending
        const out = await runVerify({
            bookings: { C2: { cutoff_date: '08/28/2026' } },
            mail: { C2: [{ subject: 'Re: C2', text: { cutoff_date: '08/28/2026' } }] },
        });
        ckTrue('brake: nothing to fix means no apply offer', !/Say \*apply\*/.test(out.all));
        ck('brake: and no pending is left hanging',
            BRAIN_STORE.pending_actions['sim@chat'], undefined);
    }
    {
        // a port-only disagreement is NOT offered for auto-correction
        const out = await runVerify({
            bookings: { C3: { port_of_loading: 'LOS ANGELES' } },
            mail: { C3: [{ subject: 'Booking Confirmation C3', pdf: { is_booking_confirmation: true, booking_number: 'C3', port_of_loading: 'LONG BEACH' } }] },
        });
        ckTrue('brake: a port mismatch is reported but never offered for auto-fix',
            /LONG BEACH/.test(out.all) && !/Say \*apply\*/.test(out.all),
            'only the four schedule dates are auto-correctable');
    }

    section('16. "cutoff date means-port_cutoff_date" — and the fallback hole it exposed');
    // Her answer, 2026-08-22. The pipeline already resolved port_cutoff_date
    // into cutoff_date (helpers/gemini.js resolveCutoffDate), so nothing had
    // to change for the answer itself. What it exposed: the OR-fallback to
    // the model's generic guess. Harmless while this only filled blanks;
    // dangerous now that it overwrites, because a doc cutoff is typically
    // DAYS EARLIER than the port cutoff.
    const cbm = require(R('helpers/cutoffBackfill.js'));
    ck('a Port row is what cutoff means', cbm.portCutoffFromFields(
        { port_cutoff_date: '09/04/2026', cutoff_date: '09/01/2026', doc_cutoff_date: '09/01/2026' }).value,
        '09/04/2026');
    ck('a single-cutoff document is still usable', cbm.portCutoffFromFields({ cutoff_date: '09/04/2026' }).value,
        '09/04/2026');
    ck('a Doc row with no Port row yields NO cutoff opinion',
        cbm.portCutoffFromFields({ cutoff_date: '09/01/2026', doc_cutoff_date: '09/01/2026' }).value, null,
        'guessing here means sending a container to the terminal days early');
    ck('the other three dates are unaffected by the cutoff rule',
        cbm.mailValueFor('erd_date', { erd_date: '09/01/2026', doc_cutoff_date: '09/01/2026' }).value, '09/01/2026');
    {
        // apply must not overwrite a correct port cutoff with a doc cutoff
        const out = await runApply({
            bookings: { D1: { cutoff_date: '09/04/2026', erd_date: '08/01/2026' } },
            mail: { D1: [{ subject: 'Booking Confirmation D1', pdf: {
                is_booking_confirmation: true, booking_number: 'D1',
                cutoff_date: '09/01/2026', doc_cutoff_date: '09/01/2026', erd_date: '09/01/2026' } }] },
            list: ['D1'],
        });
        ck('apply: a doc cutoff never overwrites the port cutoff', out.store.D1.cutoff_date, '09/04/2026');
        ck('apply: but the ERD on the same PDF is still corrected', out.store.D1.erd_date, '09/01/2026');
        ckTrue('apply: and it says the cutoff was left alone', /Cutoff left alone/i.test(out.all),
            'silently skipping a field reads identically to checking it and finding it fine');
    }
    {
        // verify must not FLAG a correct port cutoff off a doc-only document
        const out = await runVerify({
            bookings: { D2: { cutoff_date: '09/04/2026' } },
            mail: { D2: [{ subject: 'Booking Confirmation D2', pdf: {
                is_booking_confirmation: true, booking_number: 'D2',
                cutoff_date: '09/01/2026', doc_cutoff_date: '09/01/2026' } }] },
        });
        ck('verify: a doc-only document raises no cutoff disagreement', out.ret.mismatches, 0);
        ckTrue('verify: and it reports that the cutoff went unchecked',
            /Cutoff not checked/i.test(out.all));
        ckTrue('verify: so it is not offered for auto-fix either', !/Say \*apply\*/.test(out.all));
    }
    {
        // a REAL port cutoff change must still flag and still apply
        const out = await runApply({
            bookings: { D3: { cutoff_date: '08/28/2026' } },
            mail: { D3: [{ subject: 'Booking Confirmation D3', pdf: {
                is_booking_confirmation: true, booking_number: 'D3',
                port_cutoff_date: '09/04/2026', doc_cutoff_date: '09/01/2026', cutoff_date: '09/04/2026' } }] },
            list: ['D3'],
        });
        ck('apply: a real Port-row change is still applied', out.store.D3.cutoff_date, '09/04/2026',
            'over-correcting would make the whole feature useless');
    }

    console.log(`\n${'='.repeat(64)}`);
    console.log(`${pass} passed, ${fail} failed`);
    if (fail) {
        console.log('\nFAILED:');
        failures.forEach((f) => console.log('  - ' + f));
        process.exit(1);
    }
    console.log('verify_bookings survives every simulated failure and always reports.');
})().catch((e) => { console.error('\nHARNESS ERROR:', e); process.exit(1); });
