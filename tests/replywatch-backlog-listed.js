// Apsara, 2026-10-28: "understand the description and check whether it is relevant to email" - judge from CONTENT
// whether a mail is Edge Metals business. Hidden only if: model says edge_relevant=false AND unknown sender AND no
// booking/container/PO/invoice reference. Known counterparties and referenced mail are NEVER hidden. Real run().
const fs = require('fs'), os = require('os'), path = require('path');
const R = (p) => path.join(__dirname, '..', p);
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-bl-'));
process.env.DATA_DIR = scratch; process.env.JARVIS_TEST = '1';
delete require.cache[require.resolve(R('config.js'))];
const cfg = require(R('config.js'));
fs.writeFileSync(cfg.SETTINGS_FILE, JSON.stringify({ manager_number: '19998887777', manager_name: 'Apsara', internal_team: [], yard_staff: [], team_group_id: '', gmail_watch_enabled: true }, null, 2));
const ME = 'apsara@edgemetals.com';
const MAILS = {};      // id -> {from, subject, body, relevant}
let cur = null;
const client = { __address: ME, __ids: [], users: { getProfile: async () => ({ data: { emailAddress: ME } }), threads: { get: async () => ({ data: { messages: [] } }) } } };
const gmail = require(R('helpers/gmail.js'));
gmail.getGmailReadMailboxes = async () => [{ role: 'read', client, address: ME }];
gmail.getGmailRead = async () => client; gmail.getGmailSenderRead = () => client; gmail.getGmailWrite = () => client;
gmail.getMyEmailAddress = async () => ME;
gmail.listMessages = async () => Object.keys(MAILS).map((id) => ({ id }));
gmail.getMessage = async (_c, id) => { cur = id; const m = MAILS[id]; return { id, threadId: 't-' + id, internalDate: String(Date.now()), snippet: m.body, payload: { headers: [
    { name: 'From', value: m.from }, { name: 'To', value: ME }, { name: 'Subject', value: m.subject }, { name: 'Date', value: new Date().toUTCString() }, { name: 'Message-ID', value: '<' + id + '@m>' }] } }; };
gmail.getEmailContent = () => ({ body: MAILS[cur].body, pdfParts: [] });
gmail.isAutoReply = () => false; gmail.sendEmail = async () => ({ id: 's' }); gmail.reportGmailError = () => {};
gmail.preferredReplyAddress = () => MAILS[cur].from;
const time = require(R('helpers/time.js'));
time.getLADate = () => { const d = new Date(); d.setHours(10, 0, 0, 0); return d; };
require(R('helpers/gemini.js')).callGeminiJSON = async () => ({
    waiting_on: 'her', asked_of: null, action_needed: 'Reply', key_figures: [], needs_reply: true, confidence: 0.9, urgency: 'normal',
    summary: MAILS[cur].summary, asked_for: 'a call', asked_for_quote: MAILS[cur].quote, deadline: null, is_order: false, order_buyer: null,
    edge_relevant: MAILS[cur].relevant });
delete require.cache[require.resolve(R('workflow/replyWatch.js'))];
const rw = require(R('workflow/replyWatch.js'));
const store0 = (extra) => fs.writeFileSync(cfg.REPLY_WATCH_FILE, JSON.stringify({ seen: {}, undelivered: [], lastDigest: [], tracked: [], senderStats: {}, pos: {}, ...extra }, null, 2));
const scan = async (mails, extra) => { for (const k of Object.keys(MAILS)) delete MAILS[k]; Object.assign(MAILS, mails); store0(extra); const sent = [];
    await rw.run({ sendToManager: async (t) => { sent.push(t); return true; } }); return sent.join('\n'); };
const ago = (d) => new Date(Date.now() - d * 86400000).toISOString();
const old = (id, name, days) => ({ id, from: id + '@' + name.toLowerCase() + '.example', fromName: name, subject: 's-' + id, threadId: 'th-' + id, summary: name + ' asks you to confirm item ' + id + '.', waiting_on: 'her', asked_for: 'confirmation of ' + id, urgency: 'normal', confidence: 0.9, firstFlaggedAt: ago(days), chases: 0, lastChasedAt: null });
const NEW = { n1: { from: 'Tiffany <tiff@eccomelt.example>', subject: 'RE: Purchase Order #4302902', body: 'Could you please confirm the delivery appointment for Friday 9/11?', summary: 'Tiffany asks you to confirm the Friday 9/11 delivery appointment for PO 4302902.', quote: 'Could you please confirm the delivery appointment', relevant: true } };
(async () => {
    const olds = [old('o1', 'Alpha', 4), old('o2', 'Bravo', 3.5), old('o3', 'Charlie', 3)];
    const t1 = await scan(NEW, { tracked: olds });
    ck('first digest of the day lists the NEW item', /Friday 9\/11/.test(t1), t1.slice(0, 300));
    ck('...and lists the older items too (Alpha, Bravo, Charlie)', /Alpha/.test(t1) && /Bravo/.test(t1) && /Charlie/.test(t1), t1);
    ck('the "(+N older items still open...)" count-only line is GONE', !/older items? still open from before/.test(t1), t1);
    const st = rw.loadStore();
    ck('lastDigest is ONE sequence covering new + older (so "reply to N" matches the line)', st.lastDigest.length === 4, String(st.lastDigest.length));
    const NEW3 = { n1: NEW.n1, n2: { ...NEW.n1, from: 'Raj <raj@mkmetal.example>', subject: 'RE: PO 4302911', summary: 'Raj asks you to confirm the Monday pickup for PO 4302911.' }, n3: { ...NEW.n1, from: 'Lee <lee@hynos.example>', subject: 'RE: PO 4302922', summary: 'Lee asks you to confirm the Tuesday ERD for PO 4302922.' } };
    const t2 = await scan(NEW3, { tracked: olds, lastDigestAt: new Date(Date.now() - 70 * 60000).toISOString() });
    ck('a second digest the SAME day does not repeat the older items', /Friday 9\/11/.test(t2) && !/Alpha|Bravo|Charlie/.test(t2), t2.slice(0, 300));
    const many = Array.from({ length: 22 }, (_, i) => old('m' + i, 'Sender' + String.fromCharCode(65 + i), 4.6 - i * 0.1));
    const t3 = await scan(NEW, { tracked: many });
    const listed = many.filter((m) => new RegExp(m.fromName).test(t3)).length;
    ck('22 older items: only 15 are listed (no wall of text)', listed === 15, String(listed));
    ck('the header counts what is listed (no VERIFY mismatch)', /^16 emails waiting on you/.test(t3) || /16 things/.test(t3), t3.slice(0, 80));
    ck('...and the rest is one honest line with the way out', /\+7 more older items still open/.test(t3) && /clear older/.test(t3), t3.slice(-250));
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (e) {}
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
