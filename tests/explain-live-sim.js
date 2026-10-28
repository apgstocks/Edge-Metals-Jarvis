// Apsara, 2026-10-28 20:06 WhatsApp: "explain 2" got no explanation while a queued proforma confirmation was open. This drives
// the REAL brain.process() with a digest in lastDigest and then a confirm_proforma pending, and pins that "explain 2" still answers.
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
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-exl-'));
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
    // Her 20:05 digest, as lastDigest would hold it (items 1-4), then "explain 2".
    const rwStore = JSON.parse(fs.readFileSync(cfg.REPLY_WATCH_FILE, 'utf8'));
    rwStore.lastDigest = [
        { id: 'k1', threadId: 'tk1', fromName: 'Dhatu Logistics', subject: 'EBKG19065126', summary: 'Dhatu Logistics reports the shipping line cancelled booking EBKG19065126.', waiting_on: 'colleague' },
        { id: 'k2', threadId: 'tk2', fromName: 'Dylan Bennett', subject: 'Quote', summary: 'Dylan Bennett needs Edge Metals to fill out a shipment template for a quote.' },
    ];
    rwStore.lastDigestAt = new Date().toISOString();
    fs.writeFileSync(cfg.REPLY_WATCH_FILE, JSON.stringify(rwStore));
    const g = require(R('helpers/gmail.js'));
    g.getGmailRead2 = () => null; g.getGmailSenderRead = () => ({ __fake: true });
    g.getGmailReadMailboxes = async () => [];
    const gm = { users: { threads: { get: async () => ({ data: { messages: [{ id: 'k2', payload: { headers: [{ name: 'From', value: 'Dylan Bennett <dylan@x.example>' }, { name: 'Subject', value: 'Quote' }, { name: 'Date', value: new Date().toUTCString() }] }, snippet: 'Please fill out the shipment template.' }] } }) } } };
    g.getGmailRead = () => gm; g.getGmailSenderRead = () => gm;

    say('manager', 'explain 2');
    const a = await turn('Manager', MANAGER_CHAT, MANAGER_NUM, 'explain 2'); reply(a); dbg(a);
    ck('A. "explain 2" with no pending gets a reply that is about Dylan', a.replies.length >= 1 && /dylan|template|quote/i.test(a.replies.map((x) => x.text).join(' ')), JSON.stringify(a.replies.map((x) => x.text.slice(0, 80))));

    // Now with the proforma pending that "(Next up)" had promoted:
    await actions.setPending(MANAGER_CHAT, { type: 'confirm_proforma', draft: { consignee: 'Daekwang', invNo: 'EM-1', assumed: [], grounded: [], unconfirmed: [] }, invNo: 'EM-1', containerNos: [], addressLines: [], replyTo: 'j@x.example', subject: 'PO 1', who: 'Joey' });
    say('manager', 'explain 2  [proforma pending]');
    const b = await turn('Manager', MANAGER_CHAT, MANAGER_NUM, 'explain 2'); reply(b); dbg(b);
    ck('B. "explain 2" while a proforma is pending STILL explains item 2', b.replies.length >= 1 && /dylan|template|quote/i.test(b.replies.map((x) => x.text).join(' ')), JSON.stringify(b.replies.map((x) => x.text.slice(0, 120))));
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
