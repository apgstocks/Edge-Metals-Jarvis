// Apsara, 2026-10-28: "understand the description and check whether it is relevant to email" - judge from CONTENT
// whether a mail is Edge Metals business. Hidden only if: model says edge_relevant=false AND unknown sender AND no
// booking/container/PO/invoice reference. Known counterparties and referenced mail are NEVER hidden. Real run().
const fs = require('fs'), os = require('os'), path = require('path');
const R = (p) => path.join(__dirname, '..', p);
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-zsw-'));
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
    edge_relevant: true });
delete require.cache[require.resolve(R('workflow/replyWatch.js'))];
const rw = require(R('workflow/replyWatch.js'));
const store0 = (extra) => fs.writeFileSync(cfg.REPLY_WATCH_FILE, JSON.stringify({ seen: {}, undelivered: [], lastDigest: [], tracked: [], senderStats: {}, pos: {}, ...extra }, null, 2));
const scan = async (mails, extra) => { for (const k of Object.keys(MAILS)) delete MAILS[k]; Object.assign(MAILS, mails); store0(extra); const sent = [];
    await rw.run({ sendToManager: async (t) => { sent.push(t); return true; } }); return sent.join('\n'); };
const setHide = (v) => fs.writeFileSync(cfg.SETTINGS_FILE, JSON.stringify({ manager_number: '19998887777', manager_name: 'Apsara', internal_team: [], yard_staff: [], team_group_id: '', gmail_watch_enabled: true, zimex_booking_hide_critical: v }, null, 2));
const mk = (id, subject, body, summary) => ({ [id]: { from: 'Kristal <export@zimexglt.com>', subject, body, summary, quote: 'please confirm', relevant: true } });
const SHORT = mk('z1', 'Booking DALA20928700 - shortage claim', 'Booking DALA20928700: we found a weight shortage on container HMMU4892142 and are filing a claim for 1,250 lbs short. Please confirm.', 'Zimex reports a weight shortage claim on HMMU4892142.');
const PLAIN = mk('z2', 'Booking request 26JY79', 'Please confirm the booking request for 26JY79.', 'Zimex asks you to confirm a booking request.');
(async () => {
    setHide(false);
    const p1 = await scan(PLAIN); ck('plain Zimex booking mail: hidden (switch off)', !/booking request/i.test(p1), p1.slice(0, 160));
    const c1 = await scan(SHORT); ck('Zimex booking mail with a claim: VISIBLE when switch off (default)', /shortage/i.test(c1), c1.slice(0, 200));
    setHide(true);
    const c2 = await scan(SHORT); ck('same mail: HIDDEN when switch on', !/shortage/i.test(c2), c2.slice(0, 200));
    const p2 = await scan(PLAIN); ck('plain mail stays hidden with switch on', !/booking request/i.test(p2));
    const js = require(R('helpers/json.js'));
    fs.writeFileSync(cfg.SETTINGS_FILE, JSON.stringify({ manager_number: '1' }));
    ck('default setting (nothing saved) is OFF = claims stay visible', !js.loadSettings().zimex_booking_hide_critical, String(js.loadSettings().zimex_booking_hide_critical));
    const ui = fs.readFileSync(R('dashboard/app/03-settings-contacts.js'), 'utf8');
    ck('Settings screen has the checkbox and saves it', /id="s_zimex_booking_hide_critical"/.test(ui) && /zimex_booking_hide_critical: \$\('s_zimex_booking_hide_critical'\)\.checked/.test(ui));
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (e) {}
    console.log(`
${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
