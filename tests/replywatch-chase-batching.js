// ── tests/replywatch-chase-batching.js ────────────────────────────────────────
// Apsara, 2026-10-27, pasting a night of WhatsApp: "11 emails still open" listing Jio Transport's invoices one per
// line, minutes after a two-line message about two more of theirs, and eight chase messages in one evening:
// "Dont keep on sending like these ... just say that Jio Transport mails; when I click to open that it can provide
// detailed. Right now my whatsapp looks so clumsy."
//
// So: ONE LINE PER SENDER (with the detail one question away, and "ignore" dropping the lot), and ONE BATCH A DAY.
// This drives the REAL run() — only the networked edges (Gmail, Gemini, the clock) are stubbed, the way
// tests/two-mailbox.js does it — then reads the numbering back through the REAL ignore / summarise actions.
const fs = require('fs'), os = require('os'), path = require('path');
const R = (p) => path.join(__dirname, '..', p);
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-chasebatch-'));
process.env.DATA_DIR = scratch; process.env.JARVIS_TEST = '1';
delete require.cache[require.resolve(R('config.js'))];
const cfg = require(R('config.js'));
fs.writeFileSync(cfg.SETTINGS_FILE, JSON.stringify({ manager_number: '19998887777', manager_name: 'Apsara', internal_team: [], yard_staff: [], team_group_id: '', gmail_watch_enabled: true }, null, 2));

const ME = 'apsara@edgemetals.com';
const client = { __address: ME, users: { getProfile: async () => ({ data: { emailAddress: ME } }), threads: { get: async () => ({ data: { messages: [] } }) } } };
const gmail = require(R('helpers/gmail.js'));
gmail.getGmailReadMailboxes = async () => [{ role: 'read', client, address: ME }];
gmail.getGmailRead = async () => client;
gmail.getGmailSenderRead = () => client;
gmail.getGmailWrite = () => client;
gmail.getMyEmailAddress = async () => ME;
gmail.listMessages = async () => [];                 // NO new mail: this is purely the chase-up path
gmail.getMessage = async () => { throw new Error('no mail in this test'); };
gmail.getEmailContent = () => ({ body: '', pdfParts: [] });
gmail.isAutoReply = () => false; gmail.sendEmail = async () => ({ id: 'sent' }); gmail.reportGmailError = () => {};
const time = require(R('helpers/time.js'));
let laHourNow = 10;
time.getLADate = () => { const d = new Date(); d.setHours(laHourNow, 0, 0, 0); return d; };
const gemini = require(R('helpers/gemini.js'));
gemini.callGeminiJSON = async () => { throw new Error('Gemini must not be called by a chase-up'); };
delete require.cache[require.resolve(R('workflow/replyWatch.js'))];
const rw = require(R('workflow/replyWatch.js'));
const actions = require(R('workflow/actions.js'));
const toActions = []; actions.init({ sendMessage: async (id, t) => { toActions.push(t); }, sendToManager: async () => {}, sendToTeam: async () => {}, pushAlert: () => {} });

const DAY = 86400000;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
// What she saw: eleven Jio Transport emails (all from one address, "jas"), plus one different sender.
const JIO = [['8986', 'asks Edge Metals to confirm Invoice #8986.'], ['8987', 'asks Edge Metals to confirm invoice 8987 attached.'], ['8988', 'sends invoice 8988 and asks Edge Metals to confirm it.'],
    ['8989', 'asks Edge Metals to confirm invoice 8989, attached.'], ['8990', 'sent Invoice 8990 and requests confirmation.'], ['8836', 'asks Edge Metals to confirm invoice 8836, attached for review.'],
    ['8991', 'sent Invoice 8991 and asks for confirmation.'], ['8993', 'asks Edge Metals to confirm invoice 8993 attached.'], ['8994', 'asks Edge Metals to confirm Invoice 8994 attached.'],
    ['8910', 'asks Edge Metals to confirm invoice 8910 attached.'], ['rent', 'is charging an extra day of chassis rent based on your previous clarification.']];
const tracked = (id, from, fromName, summary, days) => ({ id, from, fromName, subject: 's-' + id, summary, waiting_on: 'her', asked_for: 'x', urgency: 'normal', confidence: 0.9, firstFlaggedAt: ago(days), chases: 0, lastChasedAt: null });
const jioItems = () => JIO.map(([k, s], i) => tracked('jio-' + k, 'jas <jas@jiotransport.example>', 'jas', `Jio Transport ${s}`, 11 - (i % 3) * 0.1));
const freshStore = (items) => fs.writeFileSync(cfg.REPLY_WATCH_FILE, JSON.stringify({ seen: {}, undelivered: [], lastDigest: [], tracked: items, senderStats: {}, pos: {} }, null, 2));
const sentTo = []; const sendToManager = async (t) => { sentTo.push(t); return { delivered: true }; };
const runOnce = async () => { sentTo.length = 0; return rw.run({ sendToManager, sendMessage: async (id, t) => { sentTo.push(t); return true; } }); };
const stampFile = () => cfg.REPLY_WATCH_CHASE_FILE;

(async () => {
    section('A. grouping, as pure functions');
    {
        const g = rw.groupChaseBySender([...jioItems().map((t) => ({ ...t, ageDays: 11 })), { ...tracked('oth-1', 'bob@other.example', 'Bob', 'Bob asks for a rate.', 6), ageDays: 6 }]);
        ck('eleven emails from one sender are ONE entry; a different sender stays alone', g.length === 2 && g[0].groupItems.length === 11 && !g[1].groupItems);
        ck('the entry carries every member\'s id (so "ignore" can drop them all) and a record of each', g[0].groupIds.length === 11 && g[0].groupItems.every((x) => x.id && x.summary));
        ck('the label is what the summaries open with: "Jio Transport", not the person\'s handle "jas"', rw.chaseGroupLabel(g[0]) === 'Jio Transport', rw.chaseGroupLabel(g[0]));
        const msg = rw.buildChaseMessage(g);
        ck('ONE line for Jio — naming the company, the count and the invoices — not eleven', /^1\. \*Jio Transport — 11 emails, invoices 8836, 8910, 8986, 8987, 8988, 8989 \+4 more\*/m.test(msg), msg);
        ck('the header counts EMAILS (12), not lines (2)', /^12 emails still open:/.test(msg));
        ck('it says oldest age and who, and how to see the detail', /jas, oldest 11 days ago, no reply yet/.test(msg) && /say "what is 1 about"/.test(msg));
        ck('the single sender is still a plain line', /^2\. \*Bob asks for a rate\.\* — Bob, 6 days ago, no reply yet/m.test(msg));
        ck('a message with NO group reads exactly as before (no new footer)', !/what is \d about/.test(rw.buildChaseMessage([{ fromName: 'Zimex', summary: 'Wants cutoff confirmation', ageDays: 6, subject: 's' }])));
        ck('a sender with two emails is grouped too (the 9:15pm message)', rw.groupChaseBySender([{ ...jioItems()[0], ageDays: 11 }, { ...jioItems()[1], ageDays: 11 }])[0].groupItems.length === 2);
        ck('the detail lists each email, oldest first, with its age', rw.chaseDetailLines(g[0]).length === 11 && /^1\. .*— 11 days? ago$/.test(rw.chaseDetailLines(g[0])[0]));
    }

    section('B. the daily gate');
    {
        ck('before 8am LA: closed', rw.chaseGateOpen(6) === false && rw.chaseGateOpen(7) === false);
        try { fs.unlinkSync(stampFile()); } catch (e) { /* none yet */ }
        ck('8am LA onwards with nothing sent today: open', rw.chaseGateOpen(8) === true && rw.chaseGateOpen(21) === true);
        ck('from 11pm (the alert window\'s end): closed', rw.chaseGateOpen(23) === false);
        await rw.markChaseSent();
        ck('right after a send: closed', rw.chaseGateOpen(10) === false);
        fs.writeFileSync(stampFile(), JSON.stringify({ lastSentAt: new Date(Date.now() - 19 * 3600e3).toISOString() }));
        ck('19 hours later: still closed (once a day)', rw.chaseGateOpen(10) === false);
        fs.writeFileSync(stampFile(), JSON.stringify({ lastSentAt: new Date(Date.now() - 21 * 3600e3).toISOString() }));
        ck('21 hours later: open again', rw.chaseGateOpen(10) === true);
        fs.writeFileSync(stampFile(), '{ not json');
        ck('an unreadable stamp never blocks the chase-ups', rw.chaseGateOpen(10) === true);
        try { fs.unlinkSync(stampFile()); } catch (e) { /* ok */ }
    }

    section('C. END TO END through run(): the night she pasted');
    freshStore([...jioItems(), tracked('oth-1', 'bob@other.example', 'Bob', 'Bob asks for a rate.', 6)]);
    laHourNow = 6;
    const r6 = await runOnce();
    ck('06:00 LA — before the morning slot: NOTHING is sent', sentTo.filter((t) => /still open/.test(t)).length === 0, JSON.stringify(sentTo.map((t) => t.slice(0, 40))));
    ck('...and the items are not "used up": no chase counted, still due', JSON.parse(fs.readFileSync(cfg.REPLY_WATCH_FILE, 'utf8')).tracked.every((t) => !t.chases));
    laHourNow = 10;
    const r10 = await runOnce();
    const chaseMsgs = sentTo.filter((t) => /still open/.test(t));
    ck('10:00 LA — exactly ONE chase message goes out, not twelve lines and not several messages', chaseMsgs.length === 1, String(chaseMsgs.length));
    const m = chaseMsgs[0] || '';
    ck('it has one Jio line and one Bob line, and counts 12 emails', /^12 emails still open:/.test(m) && (m.match(/^\d+\. /gm) || []).length === 2 && /Jio Transport — 11 emails/.test(m), m);
    ck('every email got its chase counted once', JSON.parse(fs.readFileSync(cfg.REPLY_WATCH_FILE, 'utf8')).tracked.every((t) => t.chases === 1));
    const st = rw.loadStore();
    ck('what "reply to N" resolves against is the SAME two entries she was shown, in the same order', st.lastDigest.length === 2 && st.lastDigest[0].groupIds.length === 11 && st.lastDigest[1].id === 'oth-1');
    ck('the send was stamped (own file), so the gate is closed', fs.existsSync(stampFile()) && rw.chaseGateOpen(10) === false);

    // A new item comes due later the same day: it must WAIT, not trickle out as a message of its own.
    const mid = JSON.parse(fs.readFileSync(cfg.REPLY_WATCH_FILE, 'utf8'));
    mid.tracked.push(tracked('late-1', 'carl@third.example', 'Carl', 'Carl asks for a booking sheet.', 5.5));
    fs.writeFileSync(cfg.REPLY_WATCH_FILE, JSON.stringify(mid));
    laHourNow = 15;
    await runOnce();
    ck('later the same day: a newly-due email does NOT trigger another message', sentTo.filter((t) => /still open/.test(t)).length === 0, JSON.stringify(sentTo.map((t) => t.slice(0, 50))));
    ck('...and it is held, not spent: its chase counter is untouched', JSON.parse(fs.readFileSync(cfg.REPLY_WATCH_FILE, 'utf8')).tracked.find((t) => t.id === 'late-1').chases === 0);
    fs.writeFileSync(stampFile(), JSON.stringify({ lastSentAt: new Date(Date.now() - 21 * 3600e3).toISOString() }));
    laHourNow = 9;
    await runOnce();
    const next = sentTo.filter((t) => /still open/.test(t));
    ck('next morning: it goes out in the next batch', next.length === 1 && /Carl/.test(next[0]), next[0]);

    section('D. her two follow-ups, through the real actions');
    {
        // lastDigest is now the next-morning list; rebuild the Jio list so numbering is the one she saw
        const s0 = rw.loadStore();
        s0.tracked = [...jioItems(), tracked('oth-1', 'bob@other.example', 'Bob', 'Bob asks for a rate.', 6)];
        s0.lastDigest = rw.groupChaseBySender(s0.tracked.map((t) => ({ ...t, ageDays: 11 })));
        s0.lastDigestAt = new Date().toISOString();
        await rw.saveStore(s0);
        toActions.length = 0;
        await actions.summarizeEmail('x@c.us', '1', null, null);
        const detail = toActions.join('\n');
        ck('"what is 1 about" lists all eleven, from what is stored — no Gmail read', (detail.match(/^\d+\. Jio Transport/gm) || []).length === 10 || (detail.match(/^\d+\. /gm) || []).length === 11, detail);
        ck('...and names the sender, the count, and the two next steps', /jas — 11 open emails/.test(detail) && /ignore 1/.test(detail) && /reply to 1/.test(detail));
        const aud = require(R('helpers/auditlog.js')); const realAppend = aud.appendAuditLog; const rows = []; aud.appendAuditLog = async (e) => { rows.push(e); };
        toActions.length = 0;
        await actions.ignoreDigestItem('x@c.us', ['1']);
        aud.appendAuditLog = realAppend;
        const left = rw.loadStore().tracked.map((t) => t.id);
        ck('"ignore 1" drops ALL eleven Jio emails (not just the newest, or tomorrow brings ten back)', !left.some((id) => id.startsWith('jio-')) && left.includes('oth-1'), left.join());
        ck('...and says so, with the count', /jas \(11 emails\)/.test(toActions.join(' ')), toActions.join(' '));
        ck('one audit row per email dismissed, so the training signal is not diluted', rows.filter((r) => r.humanVerdict === 'not_work_for_me').length === 11, String(rows.length));
    }

    section('E. nothing else changed');
    {
        const src = fs.readFileSync(R('workflow/replyWatch.js'), 'utf8');
        ck('the daily gate is asked BEFORE an item\'s chase is spent (canSend), not after', /inAlertWindow && !!sendToManager && chaseGateOpen\(laHour\)/.test(src));
        ck('the list she sees and the list "reply to N" resolves against are the same array', /buildChaseMessage\(chaseList\)/.test(src) && /store\.lastDigest = chaseList;/.test(src));
        ck('the stamp lives in its own file, not the reply_watch allowlist', /REPLY_WATCH_CHASE_FILE/.test(src) && !/lastChaseSentAt/.test(src));
        ck('the new-mail digest and the deadline nudges were not touched (still gated by the hourly slot / once a day)', /waiting for the hourly digest slot/.test(src) && /lastDeadlineNudgeOn/.test(src));
    }

    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (e) { /* ok */ }
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
