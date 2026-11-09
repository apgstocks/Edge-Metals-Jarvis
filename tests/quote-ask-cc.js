// "ask dylan for the quote from junk car to mario" + Cc on quote emails.
// Apsara, 2026-11-09. Run: node tests/quote-ask-cc.js   (or npm test)
//
// Two changes, both narrow, and this file pins the narrowness as much as the feature:
//  1. parseGetQuoteCommand accepts "ask <names> for [the|a] quote from A to B".
//     Everything that parsed before must parse IDENTICALLY, and the phrasings
//     that are pending ANSWERS ("ask TQL only") must still not be commands.
//  2. The trucker-lane quote EMAIL carries Settings > "Quote requests Cc"
//     (quote_email_cc). Empty = no Cc header at all. The global email_cc, the
//     WhatsApp legs and every other email path are untouched.
//
// MUST BE FIRST: redirect data writes away from the live box (see integration.js).
const os = require('os'), fsBoot = require('fs'), pathBoot = require('path');
process.env.DATA_DIR = fsBoot.mkdtempSync(pathBoot.join(os.tmpdir(), 'jarvis-test-data-'));
process.env.JARVIS_TEST = '1';

const Module = require('module');
const http = require('http');
const fs = fsBoot, path = pathBoot;
const ROOT = path.join(__dirname, '..');
const R = (p) => path.join(ROOT, p);

let pass = 0, fail = 0;
function ck(label, got, want) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) { pass++; console.log(`  PASS  ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}\n          got:  ${JSON.stringify(got)}\n          want: ${JSON.stringify(want)}`); }
}
const ckTrue = (label, cond, note) => ck(label + (cond ? '' : (note ? '  — ' + note : '')), !!cond, true);
const section = (t) => console.log(`\n=== ${t} ===`);

(async () => {
    const orig = Module._load;
    Module._load = function (r) {
        if (r.endsWith('helpers/llm-intent')) return { extractManagerIntent: async () => ({ action: 'NEED_DATA' }), gate: () => 'ok', describeIntent: () => '' };
        if (r.endsWith('helpers/gemini')) return { callGeminiJSON: async () => null };
        return orig.apply(this, arguments);
    };
    const brain = require(R('workflow/brain'));
    const P = brain.parseGetQuoteCommand;
    const mk = (t, p) => ({ text: t, textLower: t.toLowerCase(), isManagerOrTeam: true, isTrucker: false,
                            isSupplier: false, pendingAction: p || null, session: {}, activeBooking: null });
    const D = (t, p) => { const d = brain.policyDecide(mk(t, p)); return d.needsAI ? '(needsAI)' : d.intent; };

    section('A — her sentence parses, in the shapes she is likely to type');
    ck('the sentence', P('ask dylan for the quote from junk car to mario'),
       { origin: 'junk car', destination: 'mario', namesText: 'dylan', emails: null });
    ck('capitalised, "a quote request"', P('Ask Dylan for a quote request from Junk car to Mario'),
       { origin: 'Junk car', destination: 'Mario', namesText: 'Dylan', emails: null });
    ck('"please" prefix', P('please ask dylan for the quote from junk car to mario').namesText, 'dylan');
    ck('two names', P('ask NTG and TQL for the quote from LA to Houston').namesText, 'NTG and TQL');
    ck('trailing email clause still extracted', P('ask dylan for the quote from junk car to mario email x@y.com'),
       { origin: 'junk car', destination: 'mario', namesText: 'dylan', emails: ['x@y.com'] });

    section('B — widen only: nothing that parsed before changed, nothing new is hijacked');
    ck('get quote (old shape)', P('get quote from Junk car to Mario ask dylan'),
       { origin: 'Junk car', destination: 'Mario', namesText: 'dylan', emails: null });
    ck('names before the lane (old shape)', P('request quote NTG,TQL,Matthew from Junk car to Eccomelt'),
       { origin: 'Junk car', destination: 'Eccomelt', namesText: 'NTG,TQL,Matthew', emails: null });
    ck('glued debris (old shape)', P('XFSend quote request from Junk car to Eccomelt'),
       { origin: 'Junk car', destination: 'Eccomelt', namesText: null, emails: null });
    for (const t of ['ask TQL only', 'ask dylan for the quote', 'ask dylan for the price list from LA to Houston',
                     'ask jose how much we owe', 'what about the quote from LA', 'ask dylan', 'quote', ''])
        ck(`not a command: "${t}"`, P(t), null);

    section('C — routing: it reaches the quote flow, also over an open pending');
    ck('fresh sentence routes to get_quote', D('ask dylan for the quote from junk car to mario'), 'get_quote');
    const CARGO = { type: 'await_quote_cargo_details', originQuery: 'Junk car', destinationQuery: 'Eccomelt' };
    ck('jumps an open cargo question like the other quote commands', D('ask dylan for the quote from junk car to mario', CARGO), 'get_quote');
    const TRUCKER = { type: 'await_quote_truckers', originQuery: 'LA', destinationQuery: 'Houston', options: ['NTG', 'TQL', 'Matthew'] };
    ckTrue('"ask TQL only" is still an ANSWER to who-should-I-ask', D('ask TQL only', TRUCKER) !== 'get_quote');
    ck('old command still routes', D('get quote from LA to Houston'), 'get_quote');

    section('D — the email leg: Cc only when configured, only on the quote email');
    const cfg = require(R('config'));
    const gmail = require(R('helpers/gmail'));
    const qrHelper = require(R('helpers/quoteRequests'));
    qrHelper.markLegSent = async () => {};
    const sentRaw = [];
    gmail.getGmailWrite = () => ({ users: { messages: { send: async ({ requestBody }) => {
        sentRaw.push(Buffer.from(requestBody.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
        return { data: { id: 'm1', threadId: 't1' } };
    } } } });
    const { dispatchLeg } = require(R('workflow/quoteRequests'));
    const request = { id: 'QR_T', origin_query: 'Junk car', destination_query: 'Mario', origin_raw: '100 Yard Rd', destination_raw: '200 Scrap Ln', cargo_details: 'junk cars 40000 lb' };
    const emailLeg = { channel: 'email', target: 'ops@dylanlogistics.example', trucker_name: 'Dylan' };
    const setSettings = (o) => fs.writeFileSync(cfg.SETTINGS_FILE, JSON.stringify(o));
    const header = (raw, h) => ((raw.split(/\r?\n/).find((l) => l.toLowerCase().startsWith(h.toLowerCase() + ':'))) || '').slice(h.length + 1).trim();

    setSettings({});
    ck('unset: sent', await dispatchLeg(request, emailLeg, async () => true), true);
    ck('unset: no Cc header at all (behaviour unchanged)', header(sentRaw[0], 'Cc'), '');
    ck('unset: addressed to the logistics company', header(sentRaw[0], 'To'), 'ops@dylanlogistics.example');

    setSettings({ email_cc: 'global@x.example' });
    await dispatchLeg(request, emailLeg, async () => true);
    ck('the GLOBAL email_cc is not applied to quote emails', header(sentRaw[1], 'Cc'), '');

    setSettings({ quote_email_cc: ' bose@x.example , accounts@x.example ', email_cc: 'global@x.example' });
    await dispatchLeg(request, emailLeg, async () => true);
    ck('configured: team on Cc', header(sentRaw[2], 'Cc'), 'bose@x.example , accounts@x.example');
    ck('configured: body still carries both addresses', /100 Yard Rd/.test(sentRaw[2]) && /200 Scrap Ln/.test(sentRaw[2]), true);

    const waSent = [];
    const before = sentRaw.length;
    await dispatchLeg(request, { channel: 'whatsapp_individual', target: '1555@c.us', trucker_name: 'Jey' }, async (to, msg) => { waSent.push(to); return true; });
    ck('WhatsApp leg unaffected: sent over WhatsApp, no email', [waSent.length, sentRaw.length - before], [1, 0]);

    section('E — END TO END: set it where she sets it, read it where the email reads it');
    process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'user-pw-aaaaaaaaaaaa';
    process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pw-bbbbbbbbbbb';
    process.env.STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'staff-pw-ccccccccccc';
    const { createApi } = require(R('api'));
    const server = await new Promise((r) => { const s = createApi().listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = (method, p, { body, sid } = {}) => new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r2 = http.request(base + p, { method, headers }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
        });
        r2.on('error', reject); if (data) r2.write(data); r2.end();
    });
    setSettings({ manager_name: 'Seed Manager', email_cc: 'keep@x.example' });
    const sid = ((await req('POST', '/login', { body: { password: process.env.ADMIN_PASSWORD } })).json || {}).sid;
    ckTrue('signed in', !!sid);
    // The key the Settings screen POSTs must be the key the email reads.
    const ui = fs.readFileSync(R('dashboard/app/03-settings-contacts.js'), 'utf8');
    const uiKey = (ui.match(/quote_email_cc:\s*\$\('s_quote_email_cc'\)/) || [])[0];
    ckTrue('the Settings screen sends quote_email_cc from its own input', !!uiKey && /id="s_quote_email_cc"/.test(ui));
    const put = await req('PUT', '/api/settings', { sid, body: { quote_email_cc: 'bose@x.example, accounts@x.example' } });
    ck('PUT /api/settings accepts it', put.status, 200);
    ck('GET /api/settings reads it back', (await req('GET', '/api/settings', { sid })).json.quote_email_cc, 'bose@x.example, accounts@x.example');
    const after = (await req('GET', '/api/settings', { sid })).json;
    ck('saving it did not wipe other settings (merge, not replace)', [after.manager_name, after.email_cc], ['Seed Manager', 'keep@x.example']);
    await dispatchLeg(request, emailLeg, async () => true);
    ck('the next quote email carries what the route saved', header(sentRaw[sentRaw.length - 1], 'Cc'), 'bose@x.example, accounts@x.example');
    server.close();

    Module._load = orig;
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
