// Apsara, 2026-10-28: "understand the description and check whether it is relevant to email" - judge from CONTENT
// whether a mail is Edge Metals business. Hidden only if: model says edge_relevant=false AND unknown sender AND no
// booking/container/PO/invoice reference. Known counterparties and referenced mail are NEVER hidden. Real run().
const fs = require('fs'), os = require('os'), path = require('path');
const R = (p) => path.join(__dirname, '..', p);
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-rel-'));
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
const ad = (o) => ({ quote: 'could we schedule a call', ...o });
(async () => {
    const t1 = await scan({ a1: ad({ from: 'Sam Rep <sam@growthleadsco.example>', subject: 'Quick question about scaling your outreach', body: 'Hi, could we schedule a call this week about our lead-gen platform?', summary: 'Sam asks for a call about a lead-gen platform.', relevant: false }) });
    ck('unknown sender, unrelated content, no reference: HIDDEN', !/lead-gen/.test(t1), t1.slice(0, 200));
    const t2 = await scan({ a2: ad({ from: 'Sam Rep <sam@growthleadsco.example>', subject: 'Re: container HMMU4892142', body: 'Hi, could we schedule a call about container HMMU4892142?', summary: 'Sam asks for a call about container HMMU4892142.', relevant: false }) });
    ck('same but with a container reference: KEPT', /HMMU4892142/.test(t2), t2.slice(0, 200));
    const t3 = await scan({ a3: ad({ from: 'Jas <jas@jiotransport.example>', subject: 'hello', body: 'Hi, could we schedule a call about the usual?', summary: 'Jas asks for a call about the usual.', relevant: false }) },
        { senderStats: { 'jas@jiotransport.example': { flagged: 3, replied: 3, ignored: 0 } } });
    ck('KNOWN counterparty is never hidden, even if model says unrelated', /Jas asks/.test(t3), t3.slice(0, 200));
    const t4 = await scan({ a4: ad({ from: 'Sam Rep <sam@growthleadsco.example>', subject: 'Call?', body: 'could we schedule a call to discuss selling you copper?', summary: 'Sam asks for a call to discuss copper.', relevant: true }) });
    ck('model says relevant: KEPT (the gate never hides on its own)', /Sam asks/.test(t4), t4.slice(0, 200));
    const src = fs.readFileSync(R('workflow/replyWatch.js'), 'utf8');
    ck('missing/garbled answer fails OPEN (defaults to relevant)', /edge_relevant: !\(res\.edge_relevant === false \|\| res\.edge_relevant === 'false'\)/.test(src));
    ck('the stranger is not recorded as a known sender (would whitelist them)', !/recordSenderEvent\(store, from, 'not_business'\)/.test(src));
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (e) {}
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
