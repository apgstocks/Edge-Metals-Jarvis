// ── tests/two-mailbox.js ────────────────────────────────────────────────────
// Apsara, 2026-09-17: "No no..it should also read bose".
//
// WHY THIS IS ITS OWN FILE, and why it drives run() rather than asserting on
// source text. My first pass at these assertions grepped replyWatch.js for
// the lines I had just written — which proves I can retype a regex, not that
// the scan behaves. That is the exact pseudo-test this project has been
// burned by repeatedly (six suites this month passed while the thing they
// claimed to cover was disabled).
//
// So this file stubs ONLY the networked edges — the two Gmail clients and
// Gemini — and then calls the REAL workflow/replyWatch.js run(). Everything
// between is production code: the mailbox loop, the Message-ID dedupe, the
// who-answered test, assess(), the gates.
//
// THE MEASUREMENT THAT PROMPTED IT: all three Gmail tokens on her Mac
// resolved to apsara@edgemetals.com, while ~30 comments in this codebase
// reason from "the read client is bose@". The mailbox the whole addressing
// layer is built around was not being read, and nothing said so.
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = (p) => path.join(__dirname, '..', p);

let pass = 0, fail = 0;
const failures = [];
function ck(name, cond, detail) {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-2mb-'));
process.env.DATA_DIR = scratch;
process.env.JARVIS_TEST = '1';
delete require.cache[require.resolve(R('config.js'))];
const cfg = require(R('config.js'));
fs.writeFileSync(cfg.SETTINGS_FILE, JSON.stringify({
    manager_number: '19998887777', manager_name: 'Apsara', internal_team: [],
    yard_staff: [], team_group_id: '', gmail_watch_enabled: true,
}, null, 2));

// ── the two mailboxes ──────────────────────────────────────────────────────
const BOSE = 'bose@edgemetals.com';
const APSARA = 'apsara@edgemetals.com';

// One real email, delivered to BOTH. Same RFC Message-ID — that is the whole
// point — but a DIFFERENT Gmail id in each mailbox, which is how Gmail
// actually works and why `seen` alone cannot deduplicate it.
const RFC_ID = '<CAJ7x=abc123@mail.gmail.com>';
const EMAIL = {
    from: 'Tiffany Furleigh <tfurleigh@eccomelt.com>',
    subject: 'RE: Purchase Order #4302902-Appointment needed',
    body: 'Could you please confirm the delivery appointment for Friday 9/11 at 8 AM?',
};

let geminiCalls = 0;
let threadLastFrom = EMAIL.from;    // who sent the newest message in the thread
// Set per-scenario. The stubs read these AT CALL TIME rather than closing over
// a value, because replyWatch.js destructures its gmail imports and therefore
// captures whatever function exists when it is required -- reassigning a stub
// later in this file does nothing to it. The dead-mailbox test passed without
// a single throw before this was understood.
let emailOverride = null;
let msgOverride = null;

const gmail = require(R('helpers/gmail.js'));
const mkClient = (address, ids) => ({
    __address: address, __ids: ids,
    users: {
        getProfile: async () => ({ data: { emailAddress: address } }),
        threads: {
            get: async () => ({ data: { messages: [
                { payload: { headers: [{ name: 'From', value: EMAIL.from }, { name: 'Date', value: 'Tue, 15 Sep 2026 10:00:00 +0000' }] }, snippet: 'earlier' },
                { payload: { headers: [{ name: 'From', value: threadLastFrom }, { name: 'Date', value: 'Tue, 15 Sep 2026 12:00:00 +0000' }] }, snippet: 'latest' },
            ] } }),
        },
    },
});
const BOSE_CLIENT = mkClient(BOSE, ['bose-1']);
const APSARA_CLIENT = mkClient(APSARA, ['apsara-1']);

let mailboxesToServe = [];
gmail.getGmailReadMailboxes = async () => mailboxesToServe;
gmail.getGmailRead = async () => BOSE_CLIENT;
gmail.getGmailSenderRead = () => APSARA_CLIENT;
gmail.getGmailWrite = () => APSARA_CLIENT;
gmail.getMyEmailAddress = async (c) => (c && c.__address) || null;
// THE STUB MUST DECIDE AT CALL TIME, not at wiring time. replyWatch.js
// DESTRUCTURES its gmail imports, so it captures whatever function is on the
// module when it is required — reassigning gmail.listMessages later in this
// file does nothing to it. My first version of the dead-mailbox test did
// exactly that and passed without a single throw ever happening. So the
// failure is driven by data this one closure reads.
const deadClients = new Set();
let listedFrom = [];
gmail.listMessages = async (client) => {
    if (deadClients.has(client)) throw new Error('invalid_grant');
    listedFrom.push(client.__address);
    return (client.__ids || []).map((id) => ({ id }));
};
gmail.getMessage = async (_c, id) => ({
    id, threadId: 'thread-4302902', internalDate: String(Date.parse('2026-09-15T12:00:00Z')),
    snippet: (emailOverride || EMAIL).body,
    payload: { headers: [
        { name: 'From', value: EMAIL.from },
        { name: 'To', value: `Edge Metals Bose <${BOSE}>, Apsara <${APSARA}>` },
        { name: 'Subject', value: (emailOverride || EMAIL).subject },
        { name: 'Date', value: 'Tue, 15 Sep 2026 12:00:00 +0000' },
        // THE FIELD UNDER TEST: identical in both mailboxes.
        { name: 'Message-ID', value: (msgOverride && msgOverride.rfc) || RFC_ID },
    ] },
});
gmail.getEmailContent = () => ({ body: (emailOverride || EMAIL).body, pdfParts: [] });
gmail.isAutoReply = () => false;
gmail.sendEmail = async () => ({ id: 'sent' });
gmail.reportGmailError = () => {};
gmail.preferredReplyAddress = () => EMAIL.from;

// THE ALERT WINDOW IS 06:00-23:00 LOS ANGELES and it is deliberate (Apsara
// overruled a change to it: "no it should work on los angeles time only"). So
// a send test run at 02:00 LA sends nothing and PASSES FOR THE WRONG REASON --
// which is what BG3 did before this stub existed, while BG1 failed and looked
// like a bug in the feature.
//
// The clock is stubbed here rather than the window being made configurable:
// making production behaviour adjustable so a test can pass is how a
// deployment ends up with a setting nobody meant to change.
const time = require(R('helpers/time.js'));
let laHourNow = 10;   // mid-morning, inside the window
time.getLADate = () => { const d = new Date(); d.setHours(laHourNow, 0, 0, 0); return d; };

const gemini = require(R('helpers/gemini.js'));
gemini.callGeminiJSON = async () => {
    geminiCalls++;
    if (emailOverride) return {
        waiting_on: 'nobody', asked_of: null, action_needed: null, key_figures: [],
        needs_reply: false, confidence: 0.9, urgency: 'normal',
        summary: emailOverride.subject, asked_for: null, asked_for_quote: null,
        deadline: null, is_order: false, order_buyer: null,
    };
    return {
        waiting_on: 'her', asked_of: null, action_needed: 'Confirm the appointment',
        key_figures: [], needs_reply: true, confidence: 0.9, urgency: 'normal',
        summary: 'Tiffany asks you to confirm the Friday 9/11 8 AM appointment for PO 4302902.',
        asked_for: 'confirmation of the delivery appointment',
        asked_for_quote: 'Could you please confirm the delivery appointment',
        deadline: null, is_order: false, order_buyer: null,
    };
};

delete require.cache[require.resolve(R('workflow/replyWatch.js'))];
const rw = require(R('workflow/replyWatch.js'));

const freshStore = () => fs.writeFileSync(cfg.REPLY_WATCH_FILE,
    JSON.stringify({ seen: {}, undelivered: [], lastDigest: [], tracked: [], senderStats: {}, pos: {} }, null, 2));

(async () => {

section('BA — the same email in two mailboxes is ONE item');
{
    // This is the failure the dedupe exists for, and it is invisible without
    // a test: she reads the same request twice in one digest, under two
    // different numbers, having paid for two Gemini calls.
    freshStore();
    geminiCalls = 0;
    mailboxesToServe = [
        { role: 'read', client: BOSE_CLIENT, address: BOSE },
        { role: 'read2', client: APSARA_CLIENT, address: APSARA },
    ];
    const res = await rw.run({ sendToManager: false, dryRun: true });
    ck('BA1 both mailboxes were listed', res.checked >= 1, JSON.stringify(res));
    ck('BA2 the email was assessed ONCE, not once per mailbox',
        geminiCalls === 1, `gemini called ${geminiCalls} time(s)`);
    ck('BA3 and produced one flagged item, not two',
        res.flagged === 1, JSON.stringify({ flagged: res.flagged, items: (res.items || []).map((i) => i.subject) }));
    const store = rw.loadStore();
    ck('BA4 the RFC Message-ID is what claimed it',
        Object.keys(store.seen).some((k) => k.startsWith('mid:')), JSON.stringify(Object.keys(store.seen)));
    ck('BA5 both mailboxes\' own ids are marked seen too',
        !!store.seen['bose-1'] && !!store.seen['apsara-1'], JSON.stringify(Object.keys(store.seen)));
}

section('BB — one mailbox alone behaves exactly as before');
{
    freshStore();
    geminiCalls = 0;
    mailboxesToServe = [{ role: 'read', client: BOSE_CLIENT, address: BOSE }];
    const res = await rw.run({ sendToManager: false, dryRun: true });
    ck('BB1 a single mailbox still flags the email',
        res.flagged === 1 && geminiCalls === 1, JSON.stringify({ flagged: res.flagged, geminiCalls }));
}

section('BC — who answered: her, or the team?');
{
    // In BOSE'S mailbox, `me` is BOSE. The old test was
    // lastFrom.includes(me), so Bose answering a customer read as SHE
    // REPLIED — and senderHistoryLine turns `replied` into "she reliably
    // answers this sender", a claim about Apsara. Her prior would have been
    // built out of Bose's behaviour, at volume, the moment bose@ was read.
    freshStore();
    geminiCalls = 0;
    threadLastFrom = `Edge Metals Bose <${BOSE}>`;   // the TEAM answered last
    mailboxesToServe = [{ role: 'read', client: BOSE_CLIENT, address: BOSE }];
    const res = await rw.run({ sendToManager: false, dryRun: true });
    ck('BC1 a thread the team answered is not nagged about',
        res.flagged === 0 && geminiCalls === 0, JSON.stringify({ flagged: res.flagged, geminiCalls }));
    const s = rw.loadStore().senderStats['tfurleigh@eccomelt.com'] || {};
    ck('BC2 it is recorded as the TEAM replying, not her',
        (s.teamReplied || 0) === 1 && (s.replied || 0) === 0, JSON.stringify(s));

    freshStore();
    geminiCalls = 0;
    threadLastFrom = `Apsara <${APSARA}>`;           // SHE answered last
    const res2 = await rw.run({ sendToManager: false, dryRun: true });
    ck('BC3 a thread SHE answered is also not nagged about',
        res2.flagged === 0, JSON.stringify(res2.flagged));
    const s2 = rw.loadStore().senderStats['tfurleigh@eccomelt.com'] || {};
    ck('BC4 and that one IS recorded as hers',
        (s2.replied || 0) === 1 && (s2.teamReplied || 0) === 0, JSON.stringify(s2));
    threadLastFrom = EMAIL.from;
}

section('BD — one dead mailbox does not silence the other');
{
    // A revoked token throws on every list call. Before this, the scan
    // returned early and the whole email side went quiet looking exactly
    // like an empty inbox.
    freshStore();
    geminiCalls = 0;
    listedFrom = [];
    const DEAD = { __address: 'dead@edgemetals.com', __ids: ['x'], users: BOSE_CLIENT.users };
    deadClients.add(DEAD);
    mailboxesToServe = [
        { role: 'read', client: DEAD, address: 'dead@edgemetals.com' },
        { role: 'read2', client: BOSE_CLIENT, address: BOSE },
    ];
    const res = await rw.run({ sendToManager: false, dryRun: true });
    ck('BD1 the live mailbox is still scanned',
        res.flagged === 1 && geminiCalls === 1, JSON.stringify({ flagged: res.flagged, geminiCalls }));
    // Proof the dead one actually threw, rather than the assertion passing
    // because nothing went wrong. Without this BD1 is satisfied by a stub
    // that never failed — which is how the first version of it passed.
    ck('BD2 ...and the dead one really did throw',
        !listedFrom.includes('dead@edgemetals.com') && listedFrom.includes(BOSE), JSON.stringify(listedFrom));
    deadClients.delete(DEAD);
}

section('BE — no readable mailbox is reported, not silently empty');
{
    freshStore();
    mailboxesToServe = [];
    const res = await rw.run({ sendToManager: false, dryRun: true });
    ck('BE1 the scan says why it did nothing',
        res.skipped === 'no-gmail', JSON.stringify(res));
}


section('BF — one thread is one open item');
{
    // Apsara, 2026-09-17: "How does in thread mails be tracked?" The honest
    // answer was that it wasn't. `tracked` was keyed on the MESSAGE id, so a
    // second message on a thread she had not answered created a SECOND open
    // item — and collectChaseUps iterates `tracked` directly, so each one
    // chased her separately with its own age counter.
    freshStore();
    geminiCalls = 0;
    mailboxesToServe = [{ role: 'read', client: BOSE_CLIENT, address: BOSE }];

    // Two DIFFERENT messages, same thread — a customer and their colleague
    // replying within minutes, which is the commonest shape of this.
    BOSE_CLIENT.__ids = ['t-msg-1'];
    await rw.run({ sendToManager: false, dryRun: true });
    const afterOne = rw.loadStore().tracked.length;

    // Second message on the same thread. A new Gmail id, a new Message-ID,
    // the same threadId — and the thread's newest sender is still the
    // customer, so the "already answered" skip does not fire.
    msgOverride = { id: 't-msg-2', rfc: '<second@mail.gmail.com>' };
    BOSE_CLIENT.__ids = ['t-msg-2'];
    await rw.run({ sendToManager: false, dryRun: true });
    const store = rw.loadStore();
    ck('BF1 the second message does not add a second open item',
        store.tracked.length === afterOne && afterOne === 1,
        JSON.stringify({ afterOne, now: store.tracked.length }));
    ck('BF2 the open item points at the NEWER message',
        store.tracked[0].id === 't-msg-2', JSON.stringify(store.tracked[0].id));
    // The age of a matter is how long SHE has had it, not how long this
    // particular message has sat there. Resetting it would also reset the
    // chase count, so MAX_CHASES could never be reached and the nag would
    // never stop.
    ck('BF3 the age of the matter is not reset by a new message',
        store.tracked[0].chases === 0 && !!store.tracked[0].firstFlaggedAt,
        JSON.stringify({ chases: store.tracked[0].chases, first: store.tracked[0].firstFlaggedAt }));
    msgOverride = null;
    BOSE_CLIENT.__ids = ['bose-1'];
}

section('BG — only a critical item breaks the hourly rhythm');
{
    // Her choice, 2026-09-17: "Notify me straight away" for consequential
    // mail that is not hers to answer. Restricted to `critical` — a date that
    // MOVED, something broken, or a cutoff inside two days.
    freshStore();
    geminiCalls = 0;
    mailboxesToServe = [{ role: 'read', client: BOSE_CLIENT, address: BOSE }];
    // A digest went out one minute ago, so the hourly gap has NOT elapsed.
    // Without a critical item nothing should go out at all.
    const store0 = rw.loadStore();
    store0.lastDigestAt = new Date(Date.now() - 60 * 1000).toISOString();
    await rw.saveStore(store0);

    emailOverride = {
        subject: 'Weight shortage claim on HMMU4892142',
        body: 'We are raising a weight shortage claim on container HMMU4892142. Please advise.',
    };
    // sendToManager is the FUNCTION that delivers to her, and it is the path
    // used when no team group is configured. Passing `true` here sent the
    // digest into helpers/managerOutbox, which correctly queued it as
    // "WhatsApp unavailable" -- so the assertion failed while the feature was
    // working, and the log said so: "sending now -- 1 critical item(s)".
    let sent = [];
    const res = await rw.run({ sendToManager: async (t) => { sent.push(t); return true; } });
    ck('BG1 a claim goes out even though the hourly gap has not elapsed',
        res.sent === true, JSON.stringify({ sent: res.sent, msgs: sent.length }));
    ck('BG2 and the message says WHY, in the sender\'s own words',
        /weight shortage claim/i.test(sent.join('\n')), sent.join('\n').slice(0, 400));

    // The control: the SAME timing with an ordinary email must stay quiet.
    freshStore();
    const store1 = rw.loadStore();
    store1.lastDigestAt = new Date(Date.now() - 60 * 1000).toISOString();
    await rw.saveStore(store1);
    emailOverride = { subject: 'Re: paperwork', body: 'Could you please confirm the delivery appointment?' };
    msgOverride = { id: 'quiet-1', rfc: '<quiet@mail.gmail.com>' };
    BOSE_CLIENT.__ids = ['quiet-1'];
    sent = [];
    const res2 = await rw.run({ sendToManager: async (t) => { sent.push(t); return true; } });
    ck('BG3 an ordinary email waits for the slot',
        res2.sent === false && sent.length === 0, JSON.stringify({ sent: res2.sent, msgs: sent.length }));
    emailOverride = null; msgOverride = null; BOSE_CLIENT.__ids = ['bose-1'];
}

console.log(`\n================================================================`);
console.log(`${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILED:'); failures.forEach((f) => console.log(`  - ${f}`)); }
fs.rmSync(scratch, { recursive: true, force: true });
process.exit(fail ? 1 : 0);

})().catch((e) => {
    console.error('HARNESS CRASHED:', e);
    fs.rmSync(scratch, { recursive: true, force: true });
    process.exit(1);
});
