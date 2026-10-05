// tests/quickbooks-apply-receipts.js — customer money, placed.
// $131,763.84 is sitting in her bank against no invoice while every one of
// those invoices reads open. Placing it moves no money — no bank entry, no
// profit and loss, no change to what anyone owes — which is what makes it the
// safe half and the agent's own job.
//
// Four things were verified against a sandbox company first, and three of
// them are guarded here:
//   · Payment carries UnappliedAmt directly
//   · a sparse update with TotalAmt + Line[LinkedTxn] applies cleanly
//   · A SPARSE UPDATE SENDING ONLY THE NEW LINE WIPES THE EXISTING
//     ALLOCATIONS — a $300 receipt with $100 already on invoice A was updated
//     with one line for invoice B, and invoice A sprang back to $100 open
//   · a cross-customer link is refused outright ("TxnID Cannot Be Linked")
const fs = require('fs'), path = require('path');
process.env.QB_ENV = 'sandbox';
let pass = 0, fail = 0; const failures = [];
const ck = (n, ok, extra) => { if (ok) { pass++; console.log('  PASS ', n); } else { fail++; failures.push(n); console.log('  FAIL ', n, extra === undefined ? '' : String(JSON.stringify(extra)).slice(0, 240)); } };

const R = require('../helpers/quickbooks/applyReceipts');

// ── how much of a receipt is loose ────────────────────────────────────────
ck('what is already placed is counted', R.appliedOn({ TotalAmt: 500, Line: [{ Amount: 200, LinkedTxn: [{ TxnId: '1', TxnType: 'Invoice' }] }] }) === 200);
ck('...and the rest is loose', R.looseOn({ TotalAmt: 500, UnappliedAmt: 300, Line: [{ Amount: 200, LinkedTxn: [{ TxnId: '1', TxnType: 'Invoice' }] }] }) === 300);
ck('a receipt with no lines at all is entirely loose', R.looseOn({ TotalAmt: 27099.79, UnappliedAmt: 27099.79, Line: [] }) === 27099.79);
ck('...and a line that links nothing is not an allocation', R.looseOn({ TotalAmt: 500, Line: [{ Amount: 500 }] }) === 500);
// a queried row can come back with no UnappliedAmt; reading that as fully
// loose would re-place money on top of its own allocations
ck('with UnappliedAmt missing, the lines decide — never the total',
   R.looseOn({ TotalAmt: 500, Line: [{ Amount: 400, LinkedTxn: [{ TxnId: '1', TxnType: 'Invoice' }] }] }) === 100);
ck('...and when QuickBooks says LESS is loose than the lines imply, the smaller figure wins',
   R.looseOn({ TotalAmt: 500, UnappliedAmt: 50, Line: [{ Amount: 400, LinkedTxn: [{ TxnId: '1', TxnType: 'Invoice' }] }] }) === 50);

// ── a fake company ────────────────────────────────────────────────────────
const INV = {
    301: { Id: '301', DocNumber: 'A-1', TxnDate: '2026-02-01', TotalAmt: 1000, Balance: 1000, CustomerRef: { value: '7', name: 'TAEWON PRECEISION' } },
    302: { Id: '302', DocNumber: 'A-2', TxnDate: '2026-03-01', TotalAmt: 400, Balance: 400, CustomerRef: { value: '7', name: 'TAEWON PRECEISION' } },
    303: { Id: '303', DocNumber: 'B-1', TxnDate: '2026-01-15', TotalAmt: 250, Balance: 250, CustomerRef: { value: '9', name: 'SOLINE' } },
};
const PAY = {
    401: { Id: '401', TxnDate: '2026-04-01', TotalAmt: 400, UnappliedAmt: 400, SyncToken: '0', Line: [], CustomerRef: { value: '7', name: 'TAEWON PRECEISION' } },
    402: { Id: '402', TxnDate: '2026-04-02', TotalAmt: 600, UnappliedAmt: 600, SyncToken: '0', Line: [], CustomerRef: { value: '7', name: 'TAEWON PRECEISION' } },
    403: { Id: '403', TxnDate: '2026-04-03', TotalAmt: 27099.79, UnappliedAmt: 27099.79, SyncToken: '0', Line: [], CustomerRef: { value: '8', name: 'TAEWON AUTOMOTIVE CO' } },
    404: { Id: '404', TxnDate: '2026-04-04', TotalAmt: 250, UnappliedAmt: 100, SyncToken: '3',
        Line: [{ Amount: 150, LinkedTxn: [{ TxnId: '999', TxnType: 'Invoice' }] }], CustomerRef: { value: '9', name: 'SOLINE' } },
};
const writes = [];
const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
function fakeFetch(url, init = {}) {
    const u = decodeURIComponent(String(url));
    if ((init.method || 'GET') === 'POST' && /\/payment\b/.test(u)) { writes.push(JSON.parse(init.body)); return Promise.resolve(ok({ Payment: PAY[JSON.parse(init.body).Id] })); }
    const one = u.match(/\/payment\/(\d+)/);
    if (one) return Promise.resolve(ok({ Payment: PAY[one[1]] }));
    if (/from Payment/.test(u)) return Promise.resolve(ok({ QueryResponse: { Payment: Object.values(PAY) } }));
    if (/from Invoice/.test(u)) return Promise.resolve(ok({ QueryResponse: { Invoice: Object.values(INV) } }));
    if (/companyinfo/.test(u)) return Promise.resolve(ok({ CompanyInfo: { CompanyName: 'Fake' } }));
    return Promise.resolve(ok({}));
}
const F = { env: 'sandbox', fetchImpl: fakeFetch };

(async () => {
    // plan() reads through client.query, which takes fetchImpl in opts
    const origQuery = require('../helpers/quickbooks/client').query;
    const client = require('../helpers/quickbooks/client');
    client.query = (sql, opts) => origQuery(sql, { ...(opts || {}), fetchImpl: fakeFetch });
    const origReq = client.request;
    client.request = (m, p, b, opts) => origReq(m, p, b, { ...(opts || {}), fetchImpl: fakeFetch });

    const p = await R.plan({ env: 'sandbox', since: '2026-01-01' });

    const r401 = p.receipts.find((r) => r.id === '401');
    ck('a receipt that matches an open invoice to the cent is certain',
       r401 && r401.certain === true && r401.picks[0].invoiceId === '302', r401);
    ck('...and the reason says why, not just what', /to the cent/.test((r401.picks[0] || {}).why || ''), r401.picks[0]);

    const r402 = p.receipts.find((r) => r.id === '402');
    ck('a receipt that matches nothing exactly goes oldest-first and is NOT certain',
       r402 && r402.certain === false && r402.picks[0].invoiceId === '301', r402);
    ck('...and it never hands out more than the invoice has open',
       r402.picks.every((x) => x.take <= INV[x.invoiceId].Balance + 0.005), r402.picks);
    ck('...nor more than the receipt', r402.picks.reduce((s, x) => s + x.take, 0) <= r402.loose + 0.005);
    ck('two receipts never take the same balance twice',
       r401.picks[0].invoiceId !== (r402.picks.find((x) => x.invoiceId === '302') || {}).invoiceId, [r401.picks, r402.picks]);

    const stuck = p.unplaceable.find((u) => u.id === '403');
    ck('THE TAEWON CASE: money on one record with the debt on another is unplaceable, not attempted',
       !!stuck && stuck.loose === 27099.79, p.unplaceable);
    ck('...and it says QuickBooks refuses a cross-customer link rather than failing at the write',
       /refuses to link a receipt to another customer/.test((stuck || {}).why || ''), stuck);
ck('...and names the record the debt is actually on, from her own same-customer list',
   (stuck || {}).twin === 'TAEWON PRECEISION' && (stuck || {}).crossCustomer === true, stuck);
// The alias key is matched exactly on her real QuickBooks names ("TAEWON
// AUTOMOTIVE CO", not "TAEWON AUTOMOTIVE"). A near-miss falls through to the
// generic message, which is the safe direction: a fuzzy company matcher is how
// two genuinely different companies get treated as one.
ck('a customer with no twin on the list gets the plain reason, not a guessed twin',
   (() => { const u = { customer: 'NOBODY LTD' }; return !require('../helpers/quickbooks/applyReceipts').aliases()[u.customer]; })());

    const r404 = p.receipts.find((r) => r.id === '404');
    ck('a part-placed receipt offers only what is still loose', r404 && r404.loose === 100, r404);

    const dry = await R.apply(p, { reason: 'test', really: false, ...F });
    ck('a dry run writes nothing', writes.length === 0 && dry.totals.receipts > 0);
    ck('a reason is required — it goes in the journal',
       await R.apply(p, { really: false, ...F }).then(() => false).catch((e) => /reason is required/.test(e.message)));

    const certain = await R.apply(p, { reason: 'test', really: false, certainOnly: true, ...F });
    ck('certainOnly places the to-the-cent ones and leaves the rest for a person',
       certain.totals.receipts === 1 && certain.skipped.some((s) => /not a to-the-cent match/.test(s.why)), certain);

    const real = await R.apply({ ...p, receipts: [r401] }, { reason: 'test', really: true, by: 'test', ...F });
    ck('a real run writes once', writes.length === 1 && real.done.length === 1, real);
    const body = writes[0];
    ck('...carrying the id and SyncToken it just read', body.Id === '401' && body.SyncToken === '0');
    ck('...and the customer and total, which QuickBooks demands', !!body.CustomerRef && body.TotalAmt === 400);

    // THE BIG ONE
    writes.length = 0;
    await R.apply({ ...p, receipts: [r404] }, { reason: 'test', really: true, by: 'test', ...F });
    const b404 = writes[0];
    ck('THE WIPE GUARD: the allocation already on the receipt is resent, not dropped',
       (b404.Line || []).some((l) => (l.LinkedTxn || []).some((t) => t.TxnId === '999')), b404.Line);
    ck('...alongside the new one', (b404.Line || []).some((l) => (l.LinkedTxn || []).some((t) => t.TxnId === '303')), b404.Line);
    ck('...so nothing that was settled springs back open', (b404.Line || []).length === 2, b404.Line);

    // a receipt that moved under us
    writes.length = 0;
    PAY[401].TotalAmt = 999;
    const stale = await R.apply({ ...p, receipts: [r401] }, { reason: 'test', really: true, ...F });
    ck('a receipt that changed in QuickBooks since the plan is left alone',
       writes.length === 0 && /changed in QuickBooks/.test((stale.skipped[0] || {}).why || ''), stale);
    PAY[401].TotalAmt = 400;

    const src = fs.readFileSync(path.join(__dirname, '..', 'helpers', 'quickbooks', 'applyReceipts.js'), 'utf8');
    ck('the sandbox findings are written where the next person will read them',
       /2026-10-05/.test(src) && /WIPES THE ALLOCATIONS/.test(src));
    ck('the receipt is re-read live before it is changed', /await client\.request\('GET', `\/payment\/\$\{row\.id\}`/.test(src));
    ck('certainty is ranked by the shared chooser, so both sides of the books agree',
       /require\('\.\/applyPayments'\)/.test(src));

    const agentSrc = fs.readFileSync(path.join(__dirname, '..', 'helpers', 'quickbooks', 'agent.js'), 'utf8');
    ck('the agent actually runs this now — a verdict of "do" with no code behind it was the real bug',
       /if \(item\.id === 'receiptsUnapplied'\)/.test(agentSrc));
    ck('...and it places only the certain ones itself', /certainOnly: true/.test(agentSrc));
    ck('...and says "ask" instead of "do" when there is nothing it may place', /canDo \? 'do' : 'ask'/.test(agentSrc));

    client.query = origQuery; client.request = origReq;
    console.log(`\nquickbooks-apply-receipts: ${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
})();
