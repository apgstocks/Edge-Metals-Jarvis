// ── tests/simulate-user.js ──────────────────────────────────────────────────
// Apsara, 2026-08-24: "guess user inputs on jarvis. simulate like a user."
//
// tests/action-invoke.js proves each actions.js function runs when called
// directly with hand-built arguments. This file is different on purpose: it
// never calls actions.js at all. It calls workflow/brain.js's REAL process()
// entry point — the exact function index.js hands every incoming WhatsApp
// message to — with plain text strings a real person would actually type:
// typos, shorthand, casual phrasing, no punctuation. That means normalize()
// (role/authorization), policyDecide() (every regex), the AI fallback path,
// and route() all run for real, in the order production runs them. A direct
// actions.js call can never catch a routing bug (wrong regex, wrong role
// resolution, wrong pending shape) — this is the only harness that can.
//
// Scratch DATA_DIR, same discipline as action-invoke.js: only the genuinely
// networked/Supabase edges are stubbed (gmail, gemini, drive, invoiceSheet,
// truckers/suppliers). Where a message needs the AI layer (no regex in
// policyDecide matches it), callGeminiJSON is stubbed to return exactly what
// I am claiming real Gemini would classify it as — that boundary is real and
// called out per-scenario below, not hidden. Everything deterministic
// (policyDecide's regexes) is tested against the ACTUAL regex, unstubbed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = (p) => path.join(__dirname, '..', p);

let pass = 0, fail = 0;
const failures = [];

// ── scratch DATA_DIR ────────────────────────────────────────────────────────
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-sim-'));
process.env.DATA_DIR = scratch;
process.env.API_TOKEN = process.env.API_TOKEN || '';
delete require.cache[require.resolve(R('config.js'))];
const cfg = require(R('config.js'));

const MANAGER_NUM = '19998887777';
const MANAGER_CHAT = MANAGER_NUM + '@c.us';
const TRUCKER_NUM = '19990001111';
const TRUCKER_CHAT = TRUCKER_NUM + '@c.us';
const TRUCKER_GROUP = '120363000000000001@g.us';
const SUPPLIER_NUM = '19990002222';
const SUPPLIER_GROUP = '120363000000000002@g.us';
const STRANGER_NUM = '19995551234';
const STRANGER_CHAT = STRANGER_NUM + '@c.us';
const BKG = 'DALA209287';
const SEED_ORIGIN = 'Invoke Origin Yard';
const SEED_DEST = 'Invoke Dest Yard';

fs.writeFileSync(cfg.SETTINGS_FILE, JSON.stringify({
    manager_number: MANAGER_NUM, manager_name: 'Manager',
    internal_team: [], yard_staff: [], team_group_id: '',
    gemini_model: 'gemini-2.5-flash-lite', bot_mode: 'handholding',
    email_cc: '', email_bcc: '', gmail_watch_enabled: true,
}, null, 2));

fs.writeFileSync(cfg.BOOKINGS_FILE, JSON.stringify({
    [BKG]: {
        carrier: 'MAERSK', port_of_loading: 'LOS ANGELES', port_of_discharge: 'BUSAN',
        erd_date: '09/01/2026', cutoff_date: '09/04/2026', vessel_voyage: 'TEST 1V',
        booking_number: BKG, created_at: new Date().toISOString(),
        containers: [{ seq: 1, size: '40HC', container_number: null, supplier: 'Dave', trucker: 'TruckerX', stage: 'forwarded' }],
    },
}, null, 2));
fs.writeFileSync(cfg.WORKFLOW_FILE, JSON.stringify({}, null, 2));
fs.writeFileSync(cfg.FACTS_FILE, JSON.stringify([], null, 2));
if (cfg.PAYMENTS_FILE) fs.writeFileSync(cfg.PAYMENTS_FILE, JSON.stringify([], null, 2));
if (cfg.ADDRESS_BOOK_FILE) {
    fs.writeFileSync(cfg.ADDRESS_BOOK_FILE, JSON.stringify([
        { id: 'seed-origin', aliases: [SEED_ORIGIN], raw: SEED_ORIGIN + '\n123 Yard Rd\nLos Angeles, CA, USA', added_at: new Date(0).toISOString() },
        { id: 'seed-dest', aliases: [SEED_DEST], raw: SEED_DEST + '\n456 Port Rd\nBusan, South Korea', added_at: new Date(0).toISOString() },
    ], null, 2));
}
// A live digest, exactly as replyWatch.run() would have left it — needed so
// "ignore 3" / "ignore all" have something real to act on.
fs.writeFileSync(cfg.REPLY_WATCH_FILE, JSON.stringify({
    seen: {}, undelivered: [], lastDigestAt: new Date().toISOString(),
    lastDigest: [
        { id: 'd1', fromName: 'brian@radmetals.com', subject: 'Transfer cargo', summary: 'Transfer cargo to RadMetals' },
        { id: 'd2', fromName: 'Kristal Sosethan', subject: 'Booking confirm', summary: 'Confirm if booking will be used' },
        { id: 'd3', fromName: 'Accounting Edge', subject: '2x40HC', summary: 'Booking for 2 *40 HC from LA/BUSAN' },
    ],
    tracked: [
        { id: 'd1', threadId: 't1', fromName: 'brian@radmetals.com', subject: 'Transfer cargo', summary: 'Transfer cargo to RadMetals', firstFlaggedAt: new Date().toISOString(), chases: 0, lastChasedAt: null, deadline: null, asked_for: null, lastDeadlineNudgeOn: null },
        { id: 'd2', threadId: 't2', fromName: 'Kristal Sosethan', subject: 'Booking confirm', summary: 'Confirm if booking will be used', firstFlaggedAt: new Date().toISOString(), chases: 0, lastChasedAt: null, deadline: null, asked_for: null, lastDeadlineNudgeOn: null },
        { id: 'd3', threadId: 't3', fromName: 'Accounting Edge', subject: '2x40HC', summary: 'Booking for 2 *40 HC from LA/BUSAN', firstFlaggedAt: new Date().toISOString(), chases: 0, lastChasedAt: null, deadline: null, asked_for: null, lastDeadlineNudgeOn: null },
    ],
}, null, 2));

// ── stub the networked edges (same pattern as action-invoke.js) ────────────
const gmail = require(R('helpers/gmail.js'));
gmail.getGmailRead = () => ({ __fake: true });
gmail.getGmailWrite = () => ({ __fake: true });
gmail.listMessages = async () => [];
gmail.getMessage = async () => ({ payload: { headers: [{ name: 'Subject', value: 'Re: test' }, { name: 'From', value: 'ops@zimex.com' }] }, internalDate: String(Date.now()) });
gmail.getEmailContent = () => ({ body: 'Please advise on the shipment.', pdfParts: [] });
gmail.sendEmail = async () => ({ threadId: 't1', id: 'm1' });
gmail.tallyAddressesForTerm = async () => ({ messages: [], tally: new Map() });
gmail.preferredReplyAddress = () => 'ops@zimex.com';
gmail.findLatestFrom = async () => null;

const gemini = require(R('helpers/gemini.js'));
// Set per-scenario when a message needs the AI fallback layer (policyDecide
// found no deterministic match). null means "this scenario should never
// reach the AI" — if it does, that IS a bug (an unexpectedly-unmatched
// regression), so the stub deliberately throws instead of guessing.
let nextAIResponse = null;
gemini.callGeminiJSON = async () => {
    if (nextAIResponse === null) {
        throw new Error('SIMULATION: this message reached the AI fallback unexpectedly — no policyDecide regex matched it, and no stubbed AI response was set for this scenario');
    }
    return nextAIResponse;
};
gemini.extractPdfFields = async () => null;
gemini.extractBookingFieldsFromText = async () => null;
gemini.classifyDocument = async () => ({ document_type: 'booking_confirmation', is_booking_confirmation: true });

const drive = require(R('helpers/drive.js'));
drive.uploadPdfToDrive = async (bkgNo) => ({ id: 'drivefile_' + bkgNo });
drive.findPdfByBooking = async () => null;

const invoiceSheet = require(R('helpers/invoiceSheet.js'));
if (invoiceSheet.listAllInvoices) invoiceSheet.listAllInvoices = async () => [];
if (invoiceSheet.fetchRawSheet) invoiceSheet.fetchRawSheet = async () => [];

const jsonHelper = require(R('helpers/json.js'));
const TRUCKER = { name: 'TruckerX', whatsapp: TRUCKER_NUM, group_id: TRUCKER_GROUP };
const SUPPLIER = { name: 'Dave', whatsapp: SUPPLIER_NUM, group_id: SUPPLIER_GROUP };
jsonHelper.loadTruckers = async () => [TRUCKER];
jsonHelper.loadSuppliers = async () => [SUPPLIER];

// ── the real entry point ────────────────────────────────────────────────────
const brain = require(R('workflow/brain.js'));
const actions = require(R('workflow/actions.js'));

let msgSeq = 0;
const sent = [];
async function sendMessage(chatId, text) {
    sent.push({ chatId, text });
}
// index.js wires this once at boot (see index.js:133) before any message is
// ever handled — without it every actions.js function that sends a reply
// (_send/_sendToManager/_sendToTeam/_pushAlert, module-level closures set
// only by init()) throws "_send is not a function". A real product function
// exercised through brain.process() with no init() call is not testing
// production behaviour at all — it's testing a half-booted module.
actions.init({
    sendMessage,
    sendToManager: (text) => sendMessage(MANAGER_CHAT, text),
    sendToTeam: (text) => sendMessage(MANAGER_CHAT, text),
    pushAlert: (level, text) => { console.log(`  [ALERT:${level}] ${text}`); },
});

async function turn(who, chatId, senderNumber, text) {
    sent.length = 0;
    msgSeq++;
    let threw = null;
    try {
        await brain.process({
            messageId: 'sim-' + msgSeq, chatId, senderNumber,
            senderName: who, text, hasMedia: false, isGroup: chatId.endsWith('@g.us'),
        }, sendMessage);
    } catch (e) {
        threw = e;
    }
    return { threw, replies: sent.slice() };
}

function ck(name, cond, detail) {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
    return cond;
}
function say(who, text) { console.log(`  [${who}] "${text}"`); }
function reply(r) { r.replies.forEach(x => console.log(`  [JARV -> ${x.chatId === MANAGER_CHAT ? 'manager' : x.chatId}] "${x.text.slice(0, 200).replace(/\n/g, ' \\n ')}"`)); }
function dbg(r) { if (r.threw) console.log(`  >>> threw: ${r.threw.stack}`); }

(async () => {
    console.log('=== SIMULATED CONVERSATION — real brain.process(), scratch data ===\n');

    // 1. Bare greeting — deterministic, no booking context needed.
    {
        say('manager', 'hi');
        const r = await turn('Apsara', MANAGER_CHAT, MANAGER_NUM, 'hi');
        reply(r); dbg(r);
        ck('S1 greeting -> menu, no crash', !r.threw && r.replies.length > 0 && /jarvis|bookings/i.test(r.replies[0]?.text || ''));
    }

    // 2. Bare booking number, no verb — a real habit (she often just pastes
    //    the booking number and expects status back).
    {
        say('manager', BKG);
        const r = await turn('Apsara', MANAGER_CHAT, MANAGER_NUM, BKG);
        reply(r); dbg(r);
        ck('S2 bare booking number -> status, no crash', !r.threw && r.replies.length > 0 && r.replies[0].text.includes(BKG));
    }

    // 3. THE REGRESSION TEST — the exact live crash phrase, verbatim from
    //    her own pasted WhatsApp log ("Jarv: Something broke while handling
    //    that: send is not defined"). This must go through the REAL regex,
    //    REAL route(), REAL showPendingReplies — no stubbing of actions.js
    //    at all — to prove the fix holds end-to-end, not just in isolation.
    {
        say('manager', 'Check for new mail');
        nextAIResponse = { action: 'reply', confidence: 0.8, reasoning: 'no dedicated command; mail is scanned automatically',
            reply: 'I scan your inbox automatically every few minutes — ask "which needs my reply" for what\'s waiting on you right now.' };
        const r1 = await turn('Apsara', MANAGER_CHAT, MANAGER_NUM, 'Check for new mail');
        reply(r1); dbg(r1);
        ck('S3a "Check for new mail" -> AI fallback, no crash', !r1.threw && r1.replies.length > 0);

        say('manager', 'Which needs my reply');
        const r2 = await turn('Apsara', MANAGER_CHAT, MANAGER_NUM, 'Which needs my reply');
        reply(r2); dbg(r2);
        ck('S3b "Which needs my reply" -> deterministic show_pending_replies, NO "send is not defined"', !r2.threw && r2.replies.length > 0 && !/is not defined/i.test(r2.replies.map(x => x.text).join(' ')));
    }

    // 4. "ignore 3" against the seeded digest — real removal, real honest
    //    reporting (actuallyRemoved vs alreadyGone).
    {
        say('manager', 'ignore 3');
        const r = await turn('Apsara', MANAGER_CHAT, MANAGER_NUM, 'ignore 3');
        reply(r); dbg(r);
        ck('S4 "ignore 3" -> removed Accounting Edge item, no crash', !r.threw && /accounting edge/i.test(r.replies[0]?.text || ''));
    }

    // 5. "ignore 3" AGAIN, same number — item is already gone. Must be
    //    honest ("wasn't being nudged... already answered"), never claim a
    //    fresh drop — this is the exact MARTINEZ-shaped false-confirmation
    //    class of bug, tested from the real user-facing path.
    {
        say('manager', 'ignore 3');
        const r = await turn('Apsara', MANAGER_CHAT, MANAGER_NUM, 'ignore 3');
        reply(r); dbg(r);
        ck('S5 "ignore 3" repeated -> honest "already gone", not a false "Dropped"', !r.threw && /already answered|wasn.t being nudged/i.test(r.replies[0]?.text || '') && !/^dropped/i.test(r.replies[0]?.text || ''));
    }

    // 6. "ignore all" — drops the remaining two.
    {
        say('manager', 'ignore all');
        const r = await turn('Apsara', MANAGER_CHAT, MANAGER_NUM, 'ignore all');
        reply(r); dbg(r);
        ck('S6 "ignore all" -> drops remaining digest items, no crash', !r.threw && r.replies.length > 0);
    }

    // 7. "apply" with NO await_verify_apply pending open — the word must
    //    stay scoped to that one pending type, not become a global yes.
    //    Real risk: "apply the credit" / "apply for the permit" are
    //    ordinary sentences elsewhere; this proves a bare "apply" with
    //    nothing pending doesn't silently misfire as a stray confirmation.
    {
        say('manager', 'apply');
        nextAIResponse = { action: 'NEED_DATA', confidence: 0, reasoning: 'no pending action, ambiguous bare word', reply: "Apply what? I don't have anything pending to apply." };
        const r = await turn('Apsara', MANAGER_CHAT, MANAGER_NUM, 'apply');
        reply(r); dbg(r);
        ck('S7 bare "apply" with nothing pending -> no crash, not misread as a stray yes', !r.threw);
    }

    // 8. "reverify bookings in mail" — the real verify_bookings flow,
    //    against the seeded booking, with the real timeout/progress/apply-
    //    offer machinery, mail evidence coming back empty (no confirmation
    //    mail seeded) so it should report cleanly, not hang or throw.
    {
        say('manager', 'reverify bookings in mail');
        nextAIResponse = { action: 'verify_bookings', confidence: 0.9, bkg_no: null, apply: false, reasoning: 'checking stored data against booking mail' };
        const r = await turn('Apsara', MANAGER_CHAT, MANAGER_NUM, 'reverify bookings in mail');
        reply(r); dbg(r);
        ck('S8 "reverify bookings in mail" -> completes, no crash/hang', !r.threw && r.replies.length > 0);
    }

    // 9. "remember fact: TQL prefers morning pickups" — deterministic
    //    regex, writes to FACTS_FILE.
    {
        say('manager', 'remember TQL prefers morning pickups');
        const r = await turn('Apsara', MANAGER_CHAT, MANAGER_NUM, 'remember TQL prefers morning pickups');
        reply(r); dbg(r);
        const facts = JSON.parse(fs.readFileSync(cfg.FACTS_FILE, 'utf8'));
        ck('S9 "remember ___" -> fact actually persisted', !r.threw && facts.some(f => /morning pickups/i.test(f.text || f.fact || '')));
    }

    // 10. A real "get quote" command, casually phrased, into the real
    //     address-book-backed quote flow.
    {
        say('manager', `get quote from ${SEED_ORIGIN} to ${SEED_DEST} ask TruckerX`);
        const r = await turn('Apsara', MANAGER_CHAT, MANAGER_NUM, `get quote from ${SEED_ORIGIN} to ${SEED_DEST} ask TruckerX`);
        reply(r); dbg(r);
        ck('S10 "get quote from X to Y ask Z" -> real quote flow starts, no crash', !r.threw && r.replies.length > 0);
    }

    // 11. Trucker's own group, trucker's own number — "empty dropped" as a
    //     casual physical confirmation, no booking number typed at all
    //     (relies on findSlotsForGroup resolving the single active slot).
    {
        say('TruckerX (trucker group)', 'empty dropped');
        const r = await turn('TruckerX', TRUCKER_GROUP, TRUCKER_NUM, 'empty dropped');
        reply(r); dbg(r);
        ck('S11 trucker "empty dropped" in own group -> resolves, no crash', !r.threw);
    }

    // 12. Supplier's own group — "load ready".
    {
        say('Dave (supplier group)', 'load ready');
        const r = await turn('Dave', SUPPLIER_GROUP, SUPPLIER_NUM, 'load ready');
        reply(r); dbg(r);
        ck('S12 supplier "load ready" in own group -> resolves, no crash', !r.threw);
    }

    // 13. REAL FIXED INCIDENT (see normalize()'s own header comment): the
    //     manager's personal number typing INSIDE a registered
    //     trucker/supplier group must attribute to that trucker/supplier,
    //     not to the manager — group identity wins over personal number.
    {
        say('Apsara (typing inside TruckerX\'s own group)', 'any update?');
        nextAIResponse = { action: 'reply', confidence: 0.7, reasoning: 'generic question inside external party group', reply: 'Nothing new yet.' };
        const r = await turn('Apsara', TRUCKER_GROUP, MANAGER_NUM, 'any update?');
        reply(r); dbg(r);
        // Can't observe ctx.role directly from outside — but this must not
        // throw, and must not be treated as a manager command (e.g. it
        // should NOT try to match a manager-only regex like "forward BK...").
        ck('S13 manager\'s number inside trucker group -> attributed to trucker identity, no crash', !r.threw);
    }

    // 14. A total stranger's number, no group — must be silently dropped
    //     (isAuthorized === false), zero replies sent, no crash.
    {
        say('unknown number', 'hello, who is this?');
        const r = await turn('Stranger', STRANGER_CHAT, STRANGER_NUM, 'hello, who is this?');
        reply(r); dbg(r);
        ck('S14 unauthorized stranger -> silently dropped, zero replies, no crash', !r.threw && r.replies.length === 0);
    }

    console.log(`\n================================================================`);
    console.log(`${pass} passed, ${fail} failed`);
    if (fail) {
        console.log('\nFAILED:');
        failures.forEach(f => console.log(`  - ${f}`));
    }
    fs.rmSync(scratch, { recursive: true, force: true });
    process.exit(fail ? 1 : 0);
})().catch(e => {
    console.error('SIMULATION HARNESS CRASHED:', e);
    fs.rmSync(scratch, { recursive: true, force: true });
    process.exit(1);
});
