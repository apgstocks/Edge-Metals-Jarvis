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
let nextGmailMessages = [];  // [{id, from, subject, body}], set per-scenario
const GMAIL_MSG_BY_ID = {};
let lastFetchedBody = 'Please advise on the shipment.';
gmail.listMessages = async () => nextGmailMessages.map((m) => ({ id: m.id }));
gmail.getMessage = async (_g, id) => {
    const m = GMAIL_MSG_BY_ID[id] || { from: 'ops@zimex.com', subject: 'Re: test', body: 'Please advise on the shipment.' };
    lastFetchedBody = m.body || 'Please advise on the shipment.';
    return { threadId: 't-' + id, internalDate: String(Date.now()), payload: { headers: [{ name: 'Subject', value: m.subject }, { name: 'From', value: m.from }] } };
};
gmail.getEmailContent = () => ({ body: lastFetchedBody, pdfParts: [] });
gmail.sendEmail = async () => ({ threadId: 't1', id: 'm1' });
gmail.tallyAddressesForTerm = async () => ({ messages: [], tally: new Map() });
gmail.preferredReplyAddress = () => 'ops@zimex.com';
gmail.getMyEmailAddress = async () => 'ops@edgemetals.com';
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

async function turn(who, chatId, senderNumber, text, opts = {}) {
    sent.length = 0;
    msgSeq++;
    let threw = null;
    try {
        await brain.process({
            messageId: 'sim-' + msgSeq, chatId, senderNumber,
            senderName: who, text, isGroup: chatId.endsWith('@g.us'),
            // Defaults are exactly what every existing scenario passed, so
            // adding this argument changes none of them.
            hasMedia: !!opts.hasMedia, mediaType: opts.mediaType || null,
            mediaBase64: opts.mediaBase64 || null, mediaMimeType: opts.mediaMimeType || null,
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

    // 15. THE FIX BEING TESTED — Apsara, 2026-08-25, live: "Its not
    //     understanding context", pasting three consecutive hourly digests
    //     that never once mentioned an item from an earlier one. Root cause:
    //     both the automatic digest and "which needs my reply" only ever
    //     reported mail NEW since the last check, and the on-demand check
    //     never updated store.lastDigest, so "reply to N" after asking could
    //     silently resolve against a stale, unrelated list. This proves both
    //     fixes for real: ask twice, get two DIFFERENT senders (nothing
    //     repeated — that's correct, by design), the SECOND answer must
    //     honestly say something older is still open, and "reply to 1" must
    //     resolve to whoever was actually numbered 1 in that SECOND answer.
    {
        // S10's quote flow left an open await_quote_scale_tickets pending on
        // this same chat — not what S15 is testing, so clear it for a clean
        // slate rather than let an unrelated dangling pending swallow these
        // messages (a real behaviour: the pending arbiter tries to reclassify
        // via Gemini first, which is stubbed strictly here and correctly
        // falls back to the old pending on failure — that resilience is
        // real and good, just not what this scenario is isolating).
        await actions.clearPending(MANAGER_CHAT);
        GMAIL_MSG_BY_ID.tiffany1 = { from: 'Tiffany Furleigh <tiffany@example.com>', subject: 'Load type?', body: 'Is this load loose or skidded?' };
        nextGmailMessages = [{ id: 'tiffany1' }];
        nextAIResponse = { needs_reply: true, confidence: 0.9, summary: 'Sender asks if a load is loose or skidded.', asked_for: 'clarification on load type (loose or skidded)', deadline: null, urgency: 'normal', is_order: false };
        say('manager', 'which needs my reply');
        const r15a = await turn('Apsara', MANAGER_CHAT, MANAGER_NUM, 'which needs my reply');
        reply(r15a); dbg(r15a);
        ck('S15a first check -> flags Tiffany, no crash', !r15a.threw && /tiffany/i.test(r15a.replies[0]?.text || ''));

        GMAIL_MSG_BY_ID.whittaker1 = { from: 'Matthew Ellis Whittaker <matthew@example.com>', subject: 'Monday availability', body: 'Can you confirm the manager is available Monday?' };
        nextGmailMessages = [{ id: 'whittaker1' }];
        nextAIResponse = { needs_reply: true, confidence: 0.9, summary: "Sender needs to know manager's availability for Monday.", asked_for: "Manager's availability for Monday", deadline: null, urgency: 'normal', is_order: false };
        say('manager', 'which needs my reply');
        const r15b = await turn('Apsara', MANAGER_CHAT, MANAGER_NUM, 'which needs my reply');
        reply(r15b); dbg(r15b);
        const text15b = r15b.replies[0]?.text || '';
        ck('S15b second check -> flags Whittaker (not Tiffany again), no crash', !r15b.threw && /whittaker/i.test(text15b) && !/tiffany/i.test(text15b));
        ck('S15c second check HONESTLY notes Tiffany is still open, not silently dropped', /older item.*still open/i.test(text15b));

        // What "reply to 1"/"ignore 1" actually resolve against is
        // store.lastDigest, read via replyWatch's own resolveDigestIndex —
        // asserting at that level tests exactly the fix (lastDigest now
        // matches what she was just shown) without also depending on the
        // separate, unrelated forward-address-resolution chain deeper
        // inside draftReplyForConfirm, which needs its own dedicated stub
        // coverage this scenario isn't set up to give it.
        const { resolveDigestIndex } = require(R('workflow/replyWatch.js'));
        const resolved1 = resolveDigestIndex('1');
        ck('S15d "reply to 1" / "ignore 1" resolve to Whittaker (what she was just shown), NOT the stale Tiffany digest', !!resolved1 && /whittaker/i.test(resolved1.fromName || ''));
    }

    // 16. A FILE she sends that Jarvis cannot open. THE REAL INCIDENT
    //     (2026-08-29): she sent EdgeYard-v2.9-debug.apk; nothing in index.js
    //     downloads a document, so the bytes never existed in the process.
    //     Gemini improvised "I can help you manage your files. What would you
    //     like to do with the EdgeYard-v2.9-debug.apk file?" — she believed
    //     it, said "forward to 13109382525", and got "What should I send to
    //     13109382525?" Two turns spent on a capability that does not exist.
    //
    //     nextAIResponse stays null here ON PURPOSE: the stub throws if the
    //     message reaches the AI, which is precisely the defect. This scenario
    //     fails loudly the moment the guard stops matching.
    {
        say('manager', '[sends EdgeYard-v2.9-debug.apk, no caption]');
        nextAIResponse = null;
        const r = await turn('Apsara', MANAGER_CHAT, MANAGER_NUM, '',
            { hasMedia: true, mediaType: 'document', mediaMimeType: 'application/vnd.android.package-archive' });
        reply(r); dbg(r);
        ck('S16a a document never reaches the AI to be improvised about', !r.threw,
            r.threw ? r.threw.message : '');
        const said = (r.replies[0]?.text || '');
        ck('S16b it answers, rather than staying silent', r.replies.length > 0);
        ck('S16c it says plainly it cannot open or forward the file',
            /can.?t open|cannot open|can.?t .*forward/i.test(said), said);
        ck('S16d and it does NOT promise to manage her files',
            !/help you manage|what would you like to do with/i.test(said), said);
    }

    // 16b. THE REGRESSION THIS GUARD COULD EASILY HAVE CAUSED. index.js keeps
    //      hasMedia:true on a voice note AFTER transcribing it into `text`
    //      (see index.js's ptt/audio branch). A guard that fired on
    //      "hasMedia and no bytes" alone would answer every single voice note
    //      with "I can't open that file" — the feature she asked for by name
    //      ("jarvis should talk"), silently destroyed by a fix for something
    //      unrelated. This is the assertion that stops that.
    {
        say('manager', '[voice note, transcribed to "hi"]');
        nextAIResponse = null;
        const r = await turn('Apsara', MANAGER_CHAT, MANAGER_NUM, 'hi',
            { hasMedia: true, mediaType: 'ptt', mediaMimeType: 'audio/ogg' });
        reply(r); dbg(r);
        ck('S16e a transcribed voice note is still handled as its text',
            !r.threw && /jarvis|bookings/i.test(r.replies[0]?.text || ''), r.threw ? r.threw.message : (r.replies[0]?.text || ''));
        ck('S16f a voice note is NOT answered as an unopenable file',
            !/can.?t open|cannot open/i.test(r.replies[0]?.text || ''), r.replies[0]?.text || '');
    }

    // 17. THE AMBIGUOUS "1" — LIVE, 31 Aug 2026, 8:54 PM. Three bot messages
    //     went out inside an hour:
    //       8:00pm  digest, numbered, item 1 = Matt Whittaker
    //       8:45pm  "Trucker check for today — ... (yes/no)"   [sets a pending]
    //       8:50pm  digest, numbered, item 1 = Andy Park
    //     Bose replied "1" four minutes after the second digest.
    //
    //     The pending branch runs before everything else, so "1" is read as an
    //     answer to the 8:45 yes/no question. It is not "yes", so the trucker
    //     check is DECLINED and cleared. The digest item he was pointing at is
    //     never touched, and nothing tells him either thing happened.
    //
    //     Asserts what SHOULD happen: a bare list index must not silently
    //     answer an unrelated yes/no question.
    {
        // ISOLATE. The first version of this scenario "passed" because a
        // menuContext left over from S1's greeting caught the "1" and opened
        // the bookings submenu — nothing to do with the pending at all. A
        // test that passes on a path the incident never took proves nothing.
        // clearSession() is NOT enough: menuContext is persisted in
        // helpers/memory.js and re-hydrated by context.js on the next turn,
        // so it survives the clear. Null it explicitly.
        require(R('helpers/context.js')).clearSession(MANAGER_CHAT);
        require(R('helpers/context.js')).updateSession(MANAGER_CHAT, { menuContext: null, lastInstruction: null });
        say('Jarv', 'Trucker check for today — any bookings need to go out to a trucker? (yes/no)');
        await actions.setPending(MANAGER_CHAT, { type: 'wizard_start' });
        say('Jarv', '[digest sent, item 1 = Andy Park]');
        say('Bose', '1');
        nextAIResponse = null;
        const r = await turn('Bose', MANAGER_CHAT, MANAGER_NUM, '1');
        reply(r); dbg(r);
        const still = actions.getPending(MANAGER_CHAT);
        const said = r.replies.map((x) => x.text).join(' ');
        ck('S17a it did not reach the AI to be guessed at', !r.threw,
            r.threw ? r.threw.message.slice(0, 140) : 'ok');
        ck('S17b the trucker check is NOT silently declined',
            !!still, still ? 'ok' : 'PENDING CLEARED — a list index answered a yes/no question');
        ck('S17c it names BOTH things "1" could mean',
            /digest/i.test(said) && /trucker/i.test(said), said.slice(0, 240) || '(said nothing)');
        ck('S17d it names the sender, so she can tell which item that is',
            /Whittaker/i.test(said), said.slice(0, 240));
        ck('S17e and says how to answer each one', /reply to 1/i.test(said), said.slice(0, 240));

        // NO AMBIGUITY -> NO QUESTION. Asking when there is only one possible
        // referent is exactly the friction she objected to on the pasted-link
        // fix ("why should i say cancel?"). With the pending resolved, a bare
        // "1" must just act on the digest item.
        await actions.clearPending(MANAGER_CHAT);
        require(R('helpers/context.js')).updateSession(MANAGER_CHAT, { menuContext: null });
        const r2 = await turn('Bose', MANAGER_CHAT, MANAGER_NUM, '1');
        const said2 = r2.replies.map((x) => x.text).join(' ');
        ck('S17f with nothing else pending, "1" is just the digest item — no question asked',
            !/could mean two things/i.test(said2), said2.slice(0, 200));
        try { await actions.clearPending(MANAGER_CHAT); } catch (e) {}
    }

    // 18. MUTE. Apsara asked "what if i want ignore?" twice. The first answer
    //     was a number to say. This is the second half: "ignore 1" drops ONE
    //     item and deliberately leaves `seen` alone, so the next message on
    //     that thread comes straight back — which for the rolling Bill of
    //     Lading threads is every few hours.
    {
        require(R('helpers/context.js')).clearSession(MANAGER_CHAT);
        require(R('helpers/context.js')).updateSession(MANAGER_CHAT, { menuContext: null, lastInstruction: null });
        try { await actions.clearPending(MANAGER_CHAT); } catch (e) {}
        const rw = require(R('workflow/replyWatch.js'));
        const store = await rw.loadStore();
        store.lastDigest = [{ id: 'x1', threadId: 'thread-bl', from: 'raj@eagleinbrit.com',
            fromName: 'Rajkumar', subject: 'Draft Bill of Lading MEDUADA20500' }];
        store.lastDigestAt = new Date().toISOString();
        store.tracked = [{ id: 'x1', threadId: 'thread-bl', from: 'raj@eagleinbrit.com',
            fromName: 'Rajkumar', firstFlaggedAt: new Date().toISOString() }];
        await rw.saveStore(store);

        say('manager', 'mute 1');
        nextAIResponse = null;
        const r = await turn('Apsara', MANAGER_CHAT, MANAGER_NUM, 'mute 1');
        reply(r); dbg(r);
        const said = r.replies.map((x) => x.text).join(' ');
        ck('S18a "mute 1" is deterministic — it never reaches the AI', !r.threw,
            r.threw ? r.threw.message.slice(0, 120) : 'ok');
        ck('S18b it says what it muted and until when', /Muted that thread/i.test(said) && /\d{4}-\d{2}-\d{2}/.test(said), said.slice(0, 200));
        ck('S18c and how to undo it', /unmute/i.test(said), said.slice(0, 200));

        const after = await rw.loadStore();
        ck('S18d the mute is stored against the THREAD, not the person',
            !!(after.muted && after.muted.threads && after.muted.threads['thread-bl'])
            && Object.keys(after.muted.senders || {}).length === 0,
            JSON.stringify(after.muted));
        ck('S18e it survives a save/load round trip — the store allowlist has eaten three fields already',
            !!rw.mutedReason(after, 'raj@eagleinbrit.com', 'thread-bl'),
            JSON.stringify(after.muted));
        ck('S18f and it drops the item from the chase queue too', (after.tracked || []).length === 0,
            JSON.stringify(after.tracked));

        // A DIFFERENT thread from the same sender must still get through — the
        // whole reason a thread mute is the default.
        ck('S18g another thread from the same sender is NOT muted',
            rw.mutedReason(after, 'raj@eagleinbrit.com', 'other-thread') === null);
    }

    // 18b. A SENDER mute is the stronger claim and only happens by name.
    {
        say('manager', 'mute Rajkumar');
        nextAIResponse = null;
        const r = await turn('Apsara', MANAGER_CHAT, MANAGER_NUM, 'mute Rajkumar');
        reply(r); dbg(r);
        const said = r.replies.map((x) => x.text).join(' ');
        ck('S18h "mute <name>" mutes the sender', /Muted Rajkumar/i.test(said), said.slice(0, 160));
        ck('S18i and says plainly it covers everything they send', /everything they send/i.test(said), said.slice(0, 200));

        const r2 = await turn('Apsara', MANAGER_CHAT, MANAGER_NUM, 'what am i ignoring');
        const said2 = r2.replies.map((x) => x.text).join(' ');
        ck('S18j the mutes are listable — a filter she cannot see is one she cannot trust',
            /Currently ignoring/i.test(said2) && /Rajkumar/i.test(said2), said2.slice(0, 220));
        ck('S18k and every one shows its expiry', /until \d{4}-\d{2}-\d{2}/.test(said2), said2.slice(0, 220));

        const r3 = await turn('Apsara', MANAGER_CHAT, MANAGER_NUM, 'unmute Rajkumar');
        const said3 = r3.replies.map((x) => x.text).join(' ');
        ck('S18l unmuting works by the name she used, not the address',
            /Unmuted/i.test(said3), said3.slice(0, 160));
        const after = await require(R('workflow/replyWatch.js')).loadStore();
        ck('S18m and it is really gone from the store',
            Object.keys((after.muted || {}).senders || {}).length === 0, JSON.stringify(after.muted));
    }

    // 18c. THE OVERLAP THAT MATTERS. "ignore 1" is a one-off and must NOT
    //      become permanent just because a mute now exists next to it.
    {
        const rw = require(R('workflow/replyWatch.js'));
        const store = await rw.loadStore();
        store.lastDigest = [{ id: 'y1', threadId: 'thread-2', from: 'a@b.com', fromName: 'Someone', subject: 's' }];
        store.lastDigestAt = new Date().toISOString();
        store.tracked = [{ id: 'y1', threadId: 'thread-2', from: 'a@b.com', fromName: 'Someone', firstFlaggedAt: new Date().toISOString() }];
        await rw.saveStore(store);
        say('manager', 'ignore 1');
        const r = await turn('Apsara', MANAGER_CHAT, MANAGER_NUM, 'ignore 1');
        reply(r);
        const after = await rw.loadStore();
        ck('S18n a plain "ignore 1" still means ONCE, not forever',
            Object.keys((after.muted || {}).threads || {}).indexOf('thread-2') === -1,
            JSON.stringify(after.muted));
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
