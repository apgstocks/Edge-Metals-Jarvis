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

const sales = require(R('helpers/sales.js'));
sales.list = () => [
    { id: 's1', reference: 'PO10554', invoice_no: '26OC01', container_no: 'AAAU1111111', customer: 'Quantum Steels', item: 'Alternators' },
    { id: 's2', reference: 'PO10554', invoice_no: '26OC02', container_no: 'BBBU2222222', customer: 'Quantum Steels', item: 'Starters' },
];
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

    // ── a mail naming only a PO that covers two containers: ASK, do not drop ──
    const PO = { id: 'm2', threadId: 't2', snippet: 'PO10554', payload: { mimeType: 'text/plain', body: { data: b64('Regarding PO10554: quality claim, 1.5 MT of material was not as described.') },
        headers: [{ name: 'From', value: 'Q C <quality@qsteels.com>' }, { name: 'Subject', value: 'Quality and Weight Shortage Claim - PO10554' }, { name: 'Date', value: 'Tue, 13 Oct 2026 11:00:00 +0000' }] } };
    gmail.getMessage = async () => PO;
    REPLY = { is_claim: true, confidence: 0.9, reason: 'quality claim', fields: { customer: 'Quantum Steels' }, quotes: {} };
    const before = claims.list().length;
    r = await post('/api/claims/mail/read', { id: 'm2', mailbox: 'bose@edgemetals.com' });
    ck('an ambiguous PO is not dropped: it returns the candidate orders to ask her', r.body.skipped && r.body.why && r.body.why.reason === 'no_key' && r.body.why.candidates.length === 2, JSON.stringify(r.body));
    ck('  nothing was created, and the mail is not written off', claims.list().length === before && !claimWatch.processed()['m2']);
    r = await post('/api/claims/mail/read', { id: 'm2', mailbox: 'bose@edgemetals.com', attach: { container_no: 'BBBU2222222', invoice_no: '26OC02' } });
    const made = r.body.claim_id && claims.get(r.body.claim_id);
    ck('once she picks an order, the claim is created on THAT container', made && made.container_no === 'BBBU2222222' && made.invoice_no === '26OC02', JSON.stringify(r.body));
    REPLY = { is_claim: false, confidence: 0.9, reason: 'a booking confirmation', fields: {}, quotes: {} };
    r = await post('/api/claims/mail/read', { id: 'm2', mailbox: 'bose@edgemetals.com' });
    ck('a non-claim says what the model thought', r.body.why && r.body.why.reason === 'not_claim' && /booking/.test(r.body.why.model_reason), JSON.stringify(r.body));
    ck('the prompt now counts a quality claim as a claim', /QUALITY claim also counts/.test(require(R('helpers/claimParse.js')).buildPrompt({ from: 'a', subject: 'b', body: 'c' })));

    // ── one mail, two claims: two rows in ONE report for the container ──
    const TWO = 'Container CCCU3333333, invoice 26OC03, material from Gomez. 1) Quality claim - MS Scrap: 1.005 MT at USD 2,318/MT. 2) Weight shortage claim: 1.114 MT at USD 2,479/MT.';
    gmail.getMessage = async () => ({ id: 'm3', threadId: 't3', snippet: 'two claims', payload: { mimeType: 'text/plain', body: { data: b64(TWO) },
        headers: [{ name: 'From', value: 'Q <q@q.com>' }, { name: 'Subject', value: 'Quality and Weight Shortage Claim' }, { name: 'Date', value: 'Tue, 13 Oct 2026 12:00:00 +0000' }] } });
    REPLY = { is_claim: true, confidence: 0.9, reason: 'two claims', fields: { invoice_no: '26OC03', container_no: 'CCCU3333333', supplier: 'Gomez' },
        quotes: { invoice_no: 'invoice 26OC03', supplier: 'material from Gomez' },
        lines: [
            { label: 'Quality claim - MS Scrap', quote: 'Quality claim - MS Scrap: 1.005 MT at USD 2,318/MT', stated_qty: 1.005, stated_qty_unit: 'MT', stated_rate: 2318, stated_rate_unit: 'MT' },
            { label: 'Weight shortage claim', quote: 'Weight shortage claim: 1.114 MT at USD 2,479/MT', stated_qty: 1.114, stated_qty_unit: 'MT', stated_rate: 2479, stated_rate_unit: 'MT' },
            { label: 'Invented', quote: 'this sentence is not in the mail', stated_qty: 9 },
        ] };
    r = await post('/api/claims/mail/read', { id: 'm3', mailbox: 'bose@edgemetals.com' });
    const two = claims.list().filter((c) => c.container_no === 'CCCU3333333');
    ck('one mail with two claims makes two claims on the same container', two.length === 2 && r.body.claim_ids && r.body.claim_ids.length === 2, JSON.stringify(r.body));
    ck('  each carries its own quantity and rate', two.some((c) => c.stated_qty === 1.005 && c.stated_rate === 2318) && two.some((c) => c.stated_qty === 1.114 && c.stated_rate === 2479));
    ck('  a line whose quote is not in the mail is dropped', !two.some((c) => c.stated_qty === 9));
    await post('/api/claims/mail/read', { id: 'm3', mailbox: 'bose@edgemetals.com' });
    ck('  reading it again does not make a third', claims.list().filter((c) => c.container_no === 'CCCU3333333').length === 2);
    const report = require(R('helpers/claims/report.js'));
    await claims.assess(two[0].id, { assessment: 'quality', weight_unit: 'MT', quality_qty: 1.005, sell_price: 2318, sell_price_unit: 'MT' }, 't');
    await claims.verify(two[1].id, { weight_unit: 'MT', invoice_weight: 25, claimed_weight: 23.886, sell_price: 2479 }, 't');
    const rep = report.build({ container: 'CCCU3333333', supplier: 'Gomez' });
    const html = report.toHtml(rep);
    // ── INVERTED 2026-10-21 ───────────────────────────────────────────────
    // Both claims are ASSESSED here but no recovery has been raised on
    // either, so our_claim is null on both. Apsara, shown a clubbed note
    // whose first row was entirely dashes — "What if we have multiple claims
    // like this.Here in first row nothing was there" — chose to leave such
    // claims off the document altogether.
    //
    // So this used to assert two rows and now asserts none, and the check
    // that mattered is turned round rather than deleted: the report is
    // SILENT about a claim nobody has priced, and says so to HER instead.
    ck('a container whose claims are assessed but not raised sends NOTHING',
        rep.lines.length === 0 && !/<td>/.test(html), rep.lines.length);
    ck('  and build() hands the screen both of them to warn about',
        rep.noFigure.length === 2 && rep.noFigure.every((n) => n.container_no === 'CCCU3333333'), rep.noFigure);
    ck('  the quantity wording is NOT on a document nobody is being asked to pay',
        !/1\.005 MT claimed/.test(html));

    // And the round trip: raising the recovery is what puts it back on.
    await claims.raiseRecovery(two[0].id, { our_claim: 2329.59 }, 't');
    const repRaised = report.build({ container: 'CCCU3333333', supplier: 'Gomez' });
    ck('raising the recovery on one puts that one — and only that one — on the note',
        repRaised.lines.length === 1 && repRaised.noFigure.length === 1,
        { rows: repRaised.lines.length, off: repRaised.noFigure.length });
    ck('  and its quantity wording comes with it', /1\.005 MT claimed/.test(report.toHtml(repRaised)));

    // ── asked when the container or invoice is missing; the other half comes from her orders ──
    const ONE = { id: 'm4', threadId: 't4', snippet: 'x', payload: { mimeType: 'text/plain', body: { data: b64('Quality claim on invoice 26ZZ99, 1 MT at USD 2,000/MT.') },
        headers: [{ name: 'From', value: 'Q <q@q.com>' }, { name: 'Subject', value: 'Quality claim' }, { name: 'Date', value: 'Tue, 13 Oct 2026 13:00:00 +0000' }] } };
    gmail.getMessage = async () => ONE;
    REPLY = { is_claim: true, confidence: 0.9, reason: 'quality', fields: { invoice_no: '26ZZ99' }, quotes: { invoice_no: 'invoice 26ZZ99' } };
    const n0 = claims.list().length;
    r = await post('/api/claims/mail/read', { id: 'm4', mailbox: 'bose@edgemetals.com' });
    ck('invoice found but no container: Jarvis ASKS and says what it has', r.body.why && r.body.why.reason === 'missing_one' && r.body.why.have.invoice_no === '26ZZ99' && claims.list().length === n0, JSON.stringify(r.body.why));
    r = await post('/api/claims/mail/read', { id: 'm4', mailbox: 'bose@edgemetals.com', attach: { container_no: 'ZZZU9999999', invoice_no: '', confirmed: true } });
    const asked0 = r.body.claim_id && claims.get(r.body.claim_id);
    ck('she may leave the invoice blank knowingly', asked0 && asked0.invoice_no === '26ZZ99' && asked0.container_no === 'ZZZU9999999');
    // now an invoice that IS one of her orders, container typed: invoice kept, order lookup fills customer
    REPLY = { is_claim: true, confidence: 0.9, reason: 'quality', fields: { invoice_no: '26OC02' }, quotes: { invoice_no: 'invoice 26OC02' } };
    ONE.payload.body.data = b64('Quality claim on invoice 26OC02, 1 MT.');
    r = await post('/api/claims/mail/read', { id: 'm4', mailbox: 'bose@edgemetals.com' });
    const asked = r.body.claim_id && claims.get(r.body.claim_id);
    ck('an invoice that is one of her orders needs no question: the container is auto-filled', asked && asked.container_no === 'BBBU2222222' && asked.invoice_no === '26OC02', JSON.stringify(r.body));
    ONE.payload.body.data = b64('Please see the attached quality claim.');
    REPLY = { is_claim: true, confidence: 0.9, reason: 'quality', fields: {}, quotes: {} };
    r = await post('/api/claims/mail/read', { id: 'm4', mailbox: 'bose@edgemetals.com' });
    ck('neither found and no order named: asks her to type them (no dead end)', r.body.why && r.body.why.reason === 'no_key');
    r = await post('/api/claims/mail/read', { id: 'm4', mailbox: 'bose@edgemetals.com', attach: { container_no: 'ZZZU9999999', invoice_no: '26ZZ77', confirmed: true } });
    ck('typing both from scratch works when the mail named nothing', r.body.claim_id && claims.get(r.body.claim_id).container_no === 'ZZZU9999999' && claims.get(r.body.claim_id).invoice_no === '26ZZ77');
    ck('the page opens a quantity-only claim on the quantity x rate form, not invoiced/received',
        /stated_qty != null && c\.invoice_weight == null && c\.claimed_weight == null\) return 'quality'/.test(fs.readFileSync(R('dashboard/claims.html'), 'utf8')));

    // ── delete a claim: archived first, only ITS to-dos cancelled ──
    const tasksLib = require(R('helpers/tasks.js'));
    const d1 = two[0], d2 = two[1];
    const t1 = tasksLib.loadTasks().filter((t) => t.claim_id === d1.id && t.status === 'pending').length;
    const t2 = tasksLib.loadTasks().filter((t) => t.claim_id === d2.id && t.status === 'pending').length;
    r = await post('/api/claims/' + d1.id + '/delete', {});
    ck('delete removes the claim from the register', r.code === 200 && !claims.get(d1.id) && !!claims.get(d2.id), JSON.stringify(r.body));
    const arch = JSON.parse(fs.readFileSync(path.join(TMP, 'claims-deleted.json'), 'utf8'));
    ck('  the whole record is archived first', arch.length === 1 && arch[0].claim.id === d1.id && arch[0].claim.stated_qty === d1.stated_qty);
    ck('  its own to-dos are cancelled, the other claim\'s are kept', t1 > 0 && tasksLib.loadTasks().filter((t) => t.claim_id === d1.id && t.status === 'pending').length === 0
        && tasksLib.loadTasks().filter((t) => t.claim_id === d2.id && t.status === 'pending').length === t2);
    r = await post('/api/claims/nope/delete', {});
    ck('  an unknown claim is a 404', r.code === 404);
    // INVERTED 2026-10-21 with the no-figure change above. d1 is the claim
    // the recovery was raised on, so it was the container's ONLY row; d2 has
    // no figure and is deliberately left off. Deleting d1 therefore empties
    // the note rather than taking it from two rows to one.
    //
    // Asserted as a DELTA against the state just before the delete, so this
    // does not break again the next time a fixture above it moves.
    const repAfter = require(R('helpers/claims/report.js')).build({ container: 'CCCU3333333', supplier: 'Gomez' });
    ck('  deleting the only priced claim leaves the note with nothing to send',
        repAfter.lines.length === 0, repAfter.lines.length);
    ck('  and the unpriced one is still reported to HER, not silently gone',
        repAfter.noFigure.length === 1 && repAfter.noFigure[0].id === d2.id, repAfter.noFigure);

    server.close();
    console.log(`\n  ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
