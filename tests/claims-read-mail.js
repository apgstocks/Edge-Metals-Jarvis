// "Jarvis missed the mail — force it to read it." Real express routes, real
// claimWatch/claimParse/claims store. Stubbed: Gemini and the Gmail client.
const fs = require('fs'), os = require('os'), path = require('path');
const R = (p) => path.join(__dirname, '..', p);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-readmail-'));
process.env.DATA_DIR = TMP; process.env.JARVIS_TEST = '1'; process.env.GEMINI_API_KEY = 'k';
let pass = 0, fail = 0;
const ck = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '\n        ' + x : '')); } };

const gemini = require(R('helpers/gemini.js'));
let REPLY = null;
gemini.callGeminiJSON = async () => REPLY;

const b64 = (s) => Buffer.from(s).toString('base64');
const BODY = 'Container MSMU1152787 invoice 26MK10. Quality claim for MS Scrap: 1.005 MT at USD 2,318/MT.';
const MSG = { id: 'm1', threadId: 't1', snippet: 'Quality claim', payload: { mimeType: 'text/plain', body: { data: b64(BODY) },
    headers: [{ name: 'From', value: 'Buyer <b@buyer.com>' }, { name: 'Subject', value: 'Quality claim MSMU1152787' }, { name: 'Date', value: 'Tue, 13 Oct 2026 10:00:00 +0000' }] } };
const gmail = require(R('helpers/gmail.js'));
const client = {};
gmail.getGmailReadMailboxes = async () => [{ role: 'read', client, address: 'bose@edgemetals.com' }];
gmail.listMessages = async (c, q) => (/MSMU/.test(q) ? [{ id: 'm1' }] : []);
gmail.getMessage = async () => MSG;

const claimWatch = require(R('workflow/claimWatch.js'));
const SENT = []; claimWatch.init({ sendToTeam: async (t) => { SENT.push(t); return true; } });
const claims = require(R('helpers/claims.js'));
const express = require('express');
const routes = require(R('helpers/claims/routes.js'));

(async () => {
    const app = express(); app.use(express.json());
    routes.mount(app, { ROOT: path.join(__dirname, '..') });
    const server = app.listen(0); const port = server.address().port;
    const post = async (p, body) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { code: r.status, body: await r.json().catch(() => null) }; };

    // The watcher already looked at this mail and wrote it off as "not a claim".
    await claimWatch.markProcessed('m1', 'not a claim');

    let r = await post('/api/claims/mail/search', { q: 'MSMU1152787' });
    ck('search finds the mail and says Jarvis already saw it', r.code === 200 && r.body.mails.length === 1 && r.body.mails[0].seen_by_jarvis === 'not a claim' && r.body.mails[0].subject === 'Quality claim MSMU1152787', JSON.stringify(r.body));
    r = await post('/api/claims/mail/search', { q: 'ab' });
    ck('a too-short search is refused', r.code === 400);

    REPLY = { is_claim: true, confidence: 0.9, reason: 'quality claim',
        fields: { invoice_no: '26MK10', container_no: 'MSMU1152787', stated_qty: 1.005, stated_qty_unit: 'MT', stated_rate: 2318, stated_rate_unit: 'MT' },
        quotes: { invoice_no: 'invoice 26MK10', stated_qty: '1.005 MT', stated_qty_unit: '1.005 MT', stated_rate: 'USD 2,318/MT', stated_rate_unit: 'USD 2,318/MT' } };
    r = await post('/api/claims/mail/read', { id: 'm1', mailbox: 'bose@edgemetals.com' });
    ck('forcing reads a mail the watcher had skipped, and creates the claim', r.code === 200 && r.body.created === true && !!r.body.claim_id, JSON.stringify(r.body));
    const c = claims.get(r.body.claim_id);
    ck('the claim carries the quantity and rate from the mail', c && c.stated_qty === 1.005 && c.stated_rate === 2318 && c.container_no === 'MSMU1152787');
    ck('no money figure was computed', c.claim_amount === null && c.status === 'unverified');

    // Second force on the same mail: same claim, nothing duplicated.
    r = await post('/api/claims/mail/read', { id: 'm1', mailbox: 'bose@edgemetals.com' });
    ck('forcing again does not create a second claim', r.body.created === false && claims.list().length === 1);

    // A figure she confirmed is never overwritten by a re-read.
    await claims.assess(c.id, { assessment: 'quality', weight_unit: 'MT', quality_qty: 1.0, sell_price: 2000, sell_price_unit: 'MT' }, 'test');
    REPLY = { ...REPLY, fields: { ...REPLY.fields, stated_qty: 9.9 } };
    await post('/api/claims/mail/read', { id: 'm1', mailbox: 'bose@edgemetals.com' });
    ck('a re-read leaves confirmed figures alone', claims.get(c.id).quality_qty === 1 && claims.get(c.id).claim_amount === 2000 && claims.get(c.id).stated_qty === 1.005);

    // The model still decides. A non-claim stays a non-claim, with the reason.
    REPLY = { is_claim: false, confidence: 0.9, reason: 'booking', fields: {}, quotes: {} };
    r = await post('/api/claims/mail/read', { id: 'm1', mailbox: 'bose@edgemetals.com' });
    ck('forcing does not turn a non-claim into a claim', r.code === 200 && r.body.skipped === 'not a claim after extraction' && claims.list().length === 1, JSON.stringify(r.body));

    server.close();
    console.log(`\n  ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
