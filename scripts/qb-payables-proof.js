#!/usr/bin/env node
// ── scripts/qb-payables-proof.js — can a PAID bill change its payable account?
// Apsara, 2026-09-30: "One payables account, not two Agent".
//
// Her books carry two: the default Accounts Payable, and Vendor Payable #98
// (-$5,154,868.75 across 495 open bills). QuickBooks refuses an ACCOUNT MERGE
// over the API (error 2010, verified 2026-09-29), so consolidating means moving
// the documents one at a time and retiring the empty account.
//
// Moving an UNPAID bill is a sparse update of APAccountRef and was verified in
// sandbox on 2026-09-29. The open question — and the one that decides whether
// this can run on 495 real bills — is what happens to a bill that has already
// been PAID. Its BillPayment carries its own APAccountRef. If the bill moves
// and the payment does not, the sub-ledger could split: the bill open on one
// account, the money sitting on the other.
//
// Nobody should answer that from memory. This runs it, in SANDBOX, end to end,
// and prints what QuickBooks actually did. Nothing here touches production:
// it refuses to run unless QB_ENV=sandbox.
//
//   QB_ENV=sandbox node scripts/qb-payables-proof.js
require('dotenv').config();
const client = require('../helpers/quickbooks/client');
const auth = require('../helpers/quickbooks/auth');

const env = auth.qbEnv();
if (env !== 'sandbox') { console.error(`Refused: this writes test documents. QB_ENV is "${env}", not sandbox.`); process.exit(2); }

const stamp = `PROOF-${Date.now().toString(36).toUpperCase()}`;
const q = (sql) => client.query(sql, { env });
const post = (entity, body, op) => client.request('POST', `/${entity}${op ? `?operation=${op}` : ''}`, body, { env });
const money = (n) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
const made = [];

async function apAccounts() {
    const r = await q(`select * from Account where AccountType = 'Accounts Payable' maxresults 50`);
    return (r.Account || []);
}
async function ensureSecondAP(existing) {
    if (existing.length > 1) return existing[1];
    console.log('  only one payable account here — making a second one to move between');
    const r = await post('account', { Name: `Vendor Payable ${stamp}`, AccountType: 'Accounts Payable', AccountSubType: 'AccountsPayable' });
    made.push(['account', r.Account.Id]);
    return r.Account;
}
async function bank() {
    const r = await q(`select * from Account where AccountType = 'Bank' maxresults 5`);
    const a = (r.Account || [])[0];
    if (!a) throw new Error('no bank account in this sandbox');
    return a;
}
async function vendor() {
    const r = await post('vendor', { DisplayName: `Proof Vendor ${stamp}` });
    made.push(['vendor', r.Vendor.Id]);
    return r.Vendor;
}
async function billOn(ap, v, amount) {
    const r = await post('bill', {
        VendorRef: { value: v.Id }, APAccountRef: { value: ap.Id }, TxnDate: new Date().toISOString().slice(0, 10),
        DocNumber: `${stamp}-${amount}`,
        Line: [{ DetailType: 'AccountBasedExpenseLineDetail', Amount: amount,
            AccountBasedExpenseLineDetail: { AccountRef: { value: (await cogs()).Id } } }],
    });
    made.push(['bill', r.Bill.Id]);
    return r.Bill;
}
let _cogs;
async function cogs() {
    if (_cogs) return _cogs;
    const r = await q(`select * from Account where AccountType = 'Cost of Goods Sold' maxresults 5`);
    _cogs = (r.Account || [])[0]
        || (await q(`select * from Account where AccountType = 'Expense' maxresults 5`)).Account[0];
    if (!_cogs) throw new Error('no expense account in this sandbox');
    return _cogs;
}
async function pay(bill, v, bankAcc, amount) {
    const r = await post('billpayment', {
        VendorRef: { value: v.Id }, PayType: 'Check', TxnDate: bill.TxnDate,
        CheckPayment: { BankAccountRef: { value: bankAcc.Id } }, TotalAmt: amount,
        APAccountRef: { value: bill.APAccountRef.value },
        Line: [{ Amount: amount, LinkedTxn: [{ TxnId: bill.Id, TxnType: 'Bill' }] }],
    });
    made.push(['billpayment', r.BillPayment.Id]);
    return r.BillPayment;
}
const KEY = { bill: 'Bill', billpayment: 'BillPayment', account: 'Account', vendor: 'Vendor' };
async function reread(entity, id) {
    const r = await client.request('GET', `/${entity}/${id}`, null, { env });
    return r[KEY[entity]];
}
async function move(bill, toAp) {
    const live = await reread('bill', bill.Id);
    // a sparse bill update still demands VendorRef — found 2026-10-05, first run
    return post('bill', { Id: live.Id, SyncToken: live.SyncToken, sparse: true,
        VendorRef: live.VendorRef, APAccountRef: { value: toAp.Id } });
}

(async () => {
    const existing = await apAccounts();
    console.log(`Payable accounts in this sandbox: ${existing.map((a) => `#${a.Id} ${a.Name}`).join(', ') || 'none'}`);
    const from = existing[0] || await ensureSecondAP([]);
    const to = await ensureSecondAP(existing);
    if (String(from.Id) === String(to.Id)) throw new Error('need two different payable accounts');
    console.log(`Moving FROM #${from.Id} ${from.Name}  TO #${to.Id} ${to.Name}\n`);

    const [v, bk] = await Promise.all([vendor(), bank()]);

    // ── case 1: an UNPAID bill ─────────────────────────────────────────────
    const open = await billOn(from, v, 100);
    let r1;
    try { await move(open, to); const after = await reread('bill', open.Id);
        r1 = `ACCEPTED — now on #${after.APAccountRef.value}, balance ${money(after.Balance)}`; }
    catch (e) { r1 = `REFUSED — ${e.message.slice(0, 160)}`; }
    console.log(`1. unpaid bill #${open.Id} ($100):  ${r1}`);

    // ── case 2: a FULLY PAID bill ──────────────────────────────────────────
    const paid = await billOn(from, v, 200);
    const bp = await pay(paid, v, bk, 200);
    const paidBefore = await reread('bill', paid.Id);
    console.log(`   (bill #${paid.Id} paid by billpayment #${bp.Id}; balance now ${money(paidBefore.Balance)})`);
    let r2, where = '';
    try {
        await move(paid, to);
        const afterBill = await reread('bill', paid.Id);
        const afterBp = await reread('billpayment', bp.Id);
        const stillLinked = (afterBp.Line || []).some((l) => (l.LinkedTxn || []).some((t) => String(t.TxnId) === String(paid.Id)));
        r2 = `ACCEPTED — bill now on #${afterBill.APAccountRef.value}, balance ${money(afterBill.Balance)}`;
        where = `   payment #${bp.Id} sits on AP #${afterBp.APAccountRef && afterBp.APAccountRef.value}, still linked to the bill: ${stillLinked ? 'YES' : 'NO'}`;
    } catch (e) { r2 = `REFUSED — ${e.message.slice(0, 200)}`; }
    console.log(`2. PAID bill #${paid.Id} ($200):  ${r2}`);
    if (where) console.log(where);

    // ── case 3: a PARTLY paid bill ─────────────────────────────────────────
    const part = await billOn(from, v, 300);
    const bp2 = await pay(part, v, bk, 120);
    let r3, where3 = '';
    try {
        await move(part, to);
        const after = await reread('bill', part.Id);
        const afterBp2 = await reread('billpayment', bp2.Id);
        const stillLinked = (afterBp2.Line || []).some((l) => (l.LinkedTxn || []).some((t) => String(t.TxnId) === String(part.Id)));
        r3 = `ACCEPTED — now on #${after.APAccountRef.value}, balance ${money(after.Balance)} (SHOULD be $180.00)`;
        where3 = `   payment #${bp2.Id} on AP #${afterBp2.APAccountRef && afterBp2.APAccountRef.value}, still linked to the bill: ${stillLinked ? 'YES' : 'NO'}`
            + (Number(after.Balance) !== 180 ? `\n   >>> THE PAYMENT CAME OFF. The bill reads fully open again and $120 is floating.` : '');
    } catch (e) { r3 = `REFUSED — ${e.message.slice(0, 200)}`; }
    console.log(`3. part-paid bill #${part.Id} ($300, $120 paid by #${bp2.Id}):  ${r3}`);
    if (where3) console.log(where3);

    // ── what the two accounts come to afterwards ───────────────────────────
    for (const a of [from, to]) {
        const acc = await reread('account', a.Id);
        console.log(`   #${acc.Id} ${acc.Name}: ${money(acc.CurrentBalance)}`);
    }
    console.log(`\nTest documents left behind (sandbox): ${made.map(([k, id]) => `${k} #${id}`).join(', ')}`);
})().catch((e) => { console.error('\nproof failed:', e.message); process.exit(1); });
