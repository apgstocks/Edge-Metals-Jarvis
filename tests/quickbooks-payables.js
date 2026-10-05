// tests/quickbooks-payables.js — one payables account, not two.
// Apsara, 2026-09-30: "One payables account, not two Agent."
//
// The reason this file exists is a sandbox run on 2026-10-05
// (scripts/qb-payables-proof.js). QuickBooks ACCEPTS a move of a bill that has
// already been paid, and silently unapplies the payment: a $200 paid bill came
// back reading $200 open, a $300 bill with $120 against it came back reading
// $300. Over the 495 bills on Vendor Payable #98 that would turn settled bills
// into debts and push millions into the unallocated pool the agent exists to
// shrink. Every test here guards that one line.
const fs = require('fs'), path = require('path');
process.env.QB_ENV = 'sandbox';
let pass = 0, fail = 0; const failures = [];
const ck = (n, ok, extra) => { if (ok) { pass++; console.log('  PASS ', n); } else { fail++; failures.push(n); console.log('  FAIL ', n, extra === undefined ? '' : String(JSON.stringify(extra)).slice(0, 240)); } };

const P = require('../helpers/quickbooks/payables');

// ── the one test that decides whether a bill may move ──────────────────────
const clean = { Id: '1', TotalAmt: 100, Balance: 100, LinkedTxn: [] };
const paid = { Id: '2', TotalAmt: 200, Balance: 0, LinkedTxn: [{ TxnId: '9', TxnType: 'BillPaymentCheck' }] };
const part = { Id: '3', TotalAmt: 300, Balance: 180, LinkedTxn: [{ TxnId: '8', TxnType: 'BillPaymentCheck' }] };
const credited = { Id: '4', TotalAmt: 400, Balance: 400, LinkedTxn: [{ TxnId: '7', TxnType: 'VendorCredit' }] };
const quietlyShort = { Id: '5', TotalAmt: 500, Balance: 450, LinkedTxn: [] };

ck('an untouched bill can move', P.untouched(clean) === true);
ck('a fully paid bill cannot', P.untouched(paid) === false);
ck('a part-paid bill cannot', P.untouched(part) === false);
ck('a bill with a vendor credit against it cannot — a credit unapplies too', P.untouched(credited) === false);
ck('a bill whose balance is short with NO linked payment cannot either — something was applied that the links do not show',
   P.untouched(quietlyShort) === false);
ck('the reason names the payment, so she can look it up',
   /BillPaymentCheck #9/.test(P.whyHeld(paid) || ''), P.whyHeld(paid));
ck('...and the short-balance reason says what it is', /outstanding/.test(P.whyHeld(quietlyShort) || ''), P.whyHeld(quietlyShort));
ck('an untouched bill has no reason to hold it', P.whyHeld(clean) === null);
ck('only payments and credits count as a link — an attachment or an estimate does not',
   P.paymentsOn({ LinkedTxn: [{ TxnType: 'PurchaseOrder', TxnId: '1' }] }).length === 0);

// ── a fake company, so the guard is tested without the network ─────────────
// bill 10 is clean, bill 11 is part paid, bill 12 is on a different account.
const BILLS = {
    10: { Id: '10', DocNumber: 'A-10', TxnDate: '2026-03-01', TotalAmt: 100, Balance: 100, SyncToken: '0', LinkedTxn: [], VendorRef: { value: '5', name: 'Midland' }, APAccountRef: { value: '98' } },
    11: { Id: '11', DocNumber: 'A-11', TxnDate: '2026-03-02', TotalAmt: 300, Balance: 180, SyncToken: '0', LinkedTxn: [{ TxnId: '77', TxnType: 'BillPaymentCheck' }], VendorRef: { value: '5', name: 'Midland' }, APAccountRef: { value: '98' } },
    12: { Id: '12', DocNumber: 'A-12', TxnDate: '2026-03-03', TotalAmt: 50, Balance: 50, SyncToken: '0', LinkedTxn: [], VendorRef: { value: '5', name: 'Midland' }, APAccountRef: { value: '33' } },
};
const ACCOUNTS = [
    { Id: '33', Name: 'Accounts Payable (A/P)', Active: true, CurrentBalance: -50 },
    { Id: '98', Name: 'Vendor Payable', Active: true, CurrentBalance: -280 },
    { Id: '99', Name: 'Old Payable', Active: false, CurrentBalance: 0 },
];
const writes = [];
const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
function fakeFetch(url, init = {}) {
    const u = decodeURIComponent(String(url));
    if ((init.method || 'GET') === 'POST' && /\/bill\b/.test(u)) {
        const body = JSON.parse(init.body);
        writes.push(body);
        const b = BILLS[body.Id];
        if (body.APAccountRef) { b.APAccountRef = body.APAccountRef; b.SyncToken = String(Number(b.SyncToken) + 1); }
        return Promise.resolve(ok({ Bill: b }));
    }
    const one = u.match(/\/bill\/(\d+)/);
    if (one) return Promise.resolve(ok({ Bill: BILLS[one[1]] }));
    if (/from Account/.test(u)) return Promise.resolve(ok({ QueryResponse: { Account: ACCOUNTS } }));
    if (/from Bill/.test(u)) return Promise.resolve(ok({ QueryResponse: { Bill: Object.values(BILLS) } }));
    if (/companyinfo/.test(u)) return Promise.resolve(ok({ CompanyInfo: { CompanyName: 'Fake' } }));
    return Promise.resolve(ok({}));
}
// auth would go to Intuit for a token; the sandbox token on this machine is
// enough for the client to build a request, and fakeFetch answers it.
const F = { fetchImpl: fakeFetch, env: 'sandbox' };

(async () => {
    const p = await P.plan({ from: '98', to: '33', ...F });
    ck('the plan moves only the untouched bill', p.move.length === 1 && p.move[0].id === '10', p.move);
    ck('...and holds the part-paid one back with its reason',
       p.held.length === 1 && p.held[0].id === '11' && /unapply/.test(p.held[0].why), p.held);
    ck('...and ignores bills that are on another account already', !p.move.concat(p.held).some((b) => b.id === '12'));
    ck('the money that can move is stated, and it is the BALANCE not the total', p.totals.move === 100, p.totals);
    ck('the note says why the account will not empty in one run', /cannot move without QuickBooks unapplying/.test(p.note), p.note);

    let refused = null;
    try { await P.plan({ from: '98', to: '99', ...F }); } catch (e) { refused = e.message; }
    ck('moving bills ONTO an inactive account is refused — it would hide them', /inactive/.test(refused || ''), refused);
    refused = null;
    try { await P.plan({ from: '98', to: '98', ...F }); } catch (e) { refused = e.message; }
    ck('from and to being the same is refused', /same account/.test(refused || ''), refused);

    const dry = await P.apply({ from: '98', to: '33', ids: ['10'], dryRun: true, ...F });
    ck('a dry run moves nothing', dry.moved.length === 1 && dry.moved[0].dryRun === true && writes.length === 0);

    const guard = await P.apply({ from: '98', to: '33', ids: ['11'], dryRun: false, ...F });
    ck('THE GUARD: a part-paid bill is refused even when asked for by id directly',
       guard.moved.length === 0 && /unapply/.test((guard.refused[0] || {}).why || ''), guard);
    ck('...and nothing was written', writes.length === 0);

    const real = await P.apply({ from: '98', to: '33', ids: ['10'], dryRun: false, who: 'test', ...F });
    ck('an untouched bill really moves', real.moved.length === 1 && real.failed.length === 0, real);
    ck('...by a SPARSE update that carries VendorRef (QuickBooks 400s without it)',
       writes.length === 1 && writes[0].sparse === true && !!writes[0].VendorRef && writes[0].APAccountRef.value === '33', writes[0]);
    ck('...and it does not resend the lines, which would re-post the cost', !writes[0].Line);

    const again = await P.apply({ from: '98', to: '33', ids: ['10'], dryRun: false, ...F });
    ck('running it twice is safe — the second time it is no longer on the old account',
       again.moved.length === 0 && /not #98/.test((again.refused[0] || {}).why || ''), again);

    await P.undo({ qbId: '10', back: '98', ...F });
    ck('the undo is the same write in reverse', BILLS[10].APAccountRef.value === '98');
    ck('...and it re-reads the bill first, so a stale SyncToken cannot clobber a newer edit',
       writes[writes.length - 1].SyncToken === '1', writes[writes.length - 1]);

    const empty = await P.apply({ from: '98', to: '33', ids: [], dryRun: true, ...F }).catch((e) => e.message);
    ck('it never moves a whole account on its own — ids are required', /never moves a whole account/.test(String(empty)), empty);

    // ── the guard must be in the code, not only in the plan ────────────────
    const src = fs.readFileSync(path.join(__dirname, '..', 'helpers', 'quickbooks', 'payables.js'), 'utf8');
    ck('the bill is re-read immediately before the write, not trusted from the plan',
       /await client\.request\('GET', `\/bill\/\$\{id\}`/.test(src));
    ck('the sandbox finding is recorded where the next person will read it',
       /unapplies the payment|came back reading/.test(src) && /2026-10-05/.test(src));
    ck('a write that landed is never reported as failed because the journal refused it',
       /moved, but the journal refused the entry/.test(src));
    ck('selected-column queries are not used to decide — they omit LinkedTxn',
       /do NOT return LinkedTxn/.test(src) && /select \* from Bill/.test(src));

    console.log(`\nquickbooks-payables: ${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
})();
