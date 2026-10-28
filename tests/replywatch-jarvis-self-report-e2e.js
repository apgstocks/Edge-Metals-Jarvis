// Apsara, 2026-10-28: "I dont want email like this: Raghu Raman shares the 2025 K1 from EEL with an operating profit
// of $16,122.67 and asks for confirmation. (your team, not you)". Tax/entity-accounting paperwork handled by a
// TEAMMATE is not listed. Same words addressed to HER, and ordinary teammate trade mail, still list.
const fs = require('fs'), os = require('os'), path = require('path');
const R = (p) => path.join(__dirname, '..', p);
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-sre-'));
process.env.DATA_DIR = scratch; process.env.JARVIS_TEST = '1';
delete require.cache[require.resolve(R('config.js'))];
const cfg = require(R('config.js'));
fs.writeFileSync(cfg.SETTINGS_FILE, JSON.stringify({ manager_number: '19998887777', manager_name: 'Apsara', internal_team: [], yard_staff: [], team_group_id: '', gmail_watch_enabled: true }, null, 2));
const ME = 'apsara@edgemetals.com', MAILS = {}; let cur = null;
const BOSE = 'bose@edgemetals.com';
const client = { __address: BOSE, users: { getProfile: async () => ({ data: { emailAddress: BOSE } }), threads: { get: async () => ({ data: { messages: [] } }) } } };
const gmail = require(R('helpers/gmail.js'));
const sender = { __address: ME, users: client.users };
gmail.getGmailReadMailboxes = async () => [{ role: 'read', client, address: BOSE }];
gmail.getGmailRead = async () => client; gmail.getGmailSenderRead = () => sender; gmail.getGmailWrite = () => client; gmail.getMyEmailAddress = async (c) => (c && c.__address) || ME;
gmail.listMessages = async (_c, q) => (/in:sent/.test(String(q)) ? [] : Object.keys(MAILS).map((id) => ({ id })));
gmail.getMessage = async (_c, id) => { cur = id; const m = MAILS[id]; return { id, threadId: 't-' + id, internalDate: String(Date.now()), snippet: m.body, payload: { headers: [
    { name: 'From', value: m.from }, { name: 'To', value: m.to }, { name: 'Subject', value: m.subject }, { name: 'Date', value: new Date().toUTCString() }, { name: 'Message-ID', value: '<' + id + '@m>' }] } }; };
gmail.getEmailContent = () => ({ body: MAILS[cur].body, pdfParts: [] });
gmail.isAutoReply = () => false; gmail.sendEmail = async () => ({ id: 's' }); gmail.reportGmailError = () => {}; gmail.preferredReplyAddress = () => MAILS[cur].from;
require(R('helpers/time.js')).getLADate = () => { const d = new Date(); d.setHours(10, 0, 0, 0); return d; };
require(R('helpers/gemini.js')).callGeminiJSON = async () => { const m = MAILS[cur]; return { waiting_on: m.waiting_on, asked_of: m.asked_of || null, action_needed: null, key_figures: [], needs_reply: m.waiting_on === 'her', confidence: 0.9, urgency: 'normal',
    summary: m.summary, asked_for: 'confirmation', asked_for_quote: 'please confirm', deadline: null, is_order: false, order_buyer: null, edge_relevant: true }; };
delete require.cache[require.resolve(R('workflow/replyWatch.js'))];
const rw = require(R('workflow/replyWatch.js'));
const scan = async (mails) => { for (const k of Object.keys(MAILS)) delete MAILS[k]; Object.assign(MAILS, mails);
    fs.writeFileSync(cfg.REPLY_WATCH_FILE, JSON.stringify({ seen: {}, undelivered: [], lastDigest: [], tracked: [], senderStats: {}, pos: {} })); const sent = [];
    await rw.run({ sendToManager: async (t) => { sent.push(t); return true; } }); return sent.join('\n'); };
(async () => {
    const rep = { from: 'Apsara Gopalakrishnan <apsara@edgemetals.com>', to: ME, subject: 'Daily', body: 'Apsara, QuickBooks has 91 stuck records and 1113 held by period lock. Please confirm.', waiting_on: 'her', summary: 'Apsara, QuickBooks has 91 stuck records and 1113 held by period lock.' };
    // Read from bose@'s mailbox (a copy reached it), so the mailbox-owner skip does not catch it.
    const t1 = await scan({ r1: rep });
    ck('END TO END: QuickBooks report to herself (no word Jarvis) is not listed', !/91 stuck/.test(t1), t1.slice(0, 200));
    const t2 = await scan({ r2: { ...rep, subject: 'Metalco', body: 'Apsara needs to price 52,220 lb of Metalco material and address 58 outstanding items. Please confirm.', summary: 'Apsara needs to price 52,220 lb of Metalco material and address 58 outstanding items.' } });
    ck('END TO END: the Metalco morning summary is not listed', !/52,220/.test(t2), t2.slice(0, 200));
    const t3 = await scan({ r3: { ...rep, from: 'Kristal <kristal@edgemetals.com>', subject: 'cutoff', body: 'Please confirm the cutoff for 26JY79.', summary: 'Kristal asks you to confirm the cutoff for 26JY79.' } });
    ck('END TO END: a teammate writing to her is still listed', /Kristal asks/.test(t3), t3.slice(0, 200));
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (e) {}
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
