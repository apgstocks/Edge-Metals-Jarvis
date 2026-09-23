// ── helpers/quickbooks/pushPayments.js — money that already moved ───────────
// Split from push.js (bills) and pushInvoice.js (invoices) by what it does.
//
// How her books hold payments, read 2026-09-22:
//   SUPPLIER  a BillPayment, PayType Check, from Checking (3301), linked to the
//             bill — all 101 since June. An advance is entered AFTER the bill,
//             linked to it (#39600 $40,000 on 8/6 against bill #38940 of 8/5).
//             Jan–May wires went straight to Cost of Goods Sold with no bill —
//             hence the cutover, and hence the same-money check below.
//   CUSTOMER  a Payment into Checking (3301), linked to the invoice.
//   BANK FEE  never recorded: 81 invoices this year sit open for a few dollars
//             each ($2,418.65). Apsara, 2026-09-22, choosing (a): Jarvis closes
//             them — a CreditMemo on item "Bank charges" for the fee, applied
//             in the same Payment — "but keep track of whatever's marked in
//             qb, everything should be tracked." So every one of these is
//             journalled (journal.js) and undoable.
//   DISCOUNT  a shortfall she classes as a discount is NOT posted yet: which
//             item/account a discount belongs on is the accountant's answer.
//             It is recorded in the memo and the journal, the invoice keeps
//             that balance open, and nothing is invented.
//
// ── RULES ───────────────────────────────────────────────────────────────────
//   · a payment is entered only after every bill/invoice it pays is linked in
//     QuickBooks. An advance not yet applied to a container waits.
//   · the bank is a confirmed mapping ("BofA" → a QuickBooks account), never
//     guessed; cash is not entered until the accountant names the account.
//   · before entering: the same amount in BillPayment/Purchase (money out) or
//     Payment/Deposit (money in), ±7 days → she decides.
//   · every decision — created, asked, blocked — goes in the journal, with the
//     exact bills/invoices and amounts the money was matched to.

const push = require('./push');
const client = require('./client');
const auth = require('./auth');
const journal = require('./journal');

const round2 = (n) => Math.round(n * 100) / 100;
const WINDOW_DAYS = 7;
const BANK_CHARGE_ITEM = 'Bank charges';

function bankName(mode, bank, snapshots) {
    if (String(mode).toLowerCase() === 'cash') return { problem: "cash is not entered yet — which QuickBooks account holds cash is the accountant's answer" };
    return push.confirmedName('bank', bank, snapshots.bank);
}

// ── pure builders ───────────────────────────────────────────────────────────
// p = billPayments row. refs = { vendorId, bankAccountId, billIds: {jarvisBillId: qbBillId} }
function buildBillPayment(p, refs) {
    const problems = [];
    const allocs = (p.allocations || []).filter((a) => a.amount > 0);
    if (!allocs.length) problems.push(p.kind === 'advance' ? 'advance not applied to any container yet — it waits until it is' : 'payment is not allocated to any bill');
    const Line = [];
    for (const a of allocs) {
        const qbId = refs.billIds[a.bill_id];
        if (!qbId) { problems.push(`bill ${a.bill_id} is not in QuickBooks yet — enter the bill first`); continue; }
        Line.push({ Amount: round2(a.amount), LinkedTxn: [{ TxnId: String(qbId), TxnType: 'Bill' }] });
    }
    const total = round2(Line.reduce((s, l) => s + l.Amount, 0));
    const allocated = round2(allocs.reduce((s, a) => s + a.amount, 0));
    if (!problems.length && p.kind !== 'advance' && Math.abs(allocated - p.amount) > 0.005) problems.push(`allocated ${allocated} of a ${p.amount} payment`);
    if (problems.length) return { problems };
    return { payment: {
        VendorRef: { value: String(refs.vendorId) }, PayType: 'Check', TotalAmt: total, TxnDate: push.isoDate(p.date),
        CheckPayment: { BankAccountRef: { value: String(refs.bankAccountId) } },
        PrivateNote: [p.mode, p.bank, p.ref && `Ref ${p.ref}`, p.kind === 'advance' && 'advance', `Jarvis payment ${p.id}`].filter(Boolean).join(' · '),
        Line,
    }, total, linked: Line.map((l) => ({ type: 'Bill', id: l.LinkedTxn[0].TxnId, amount: l.Amount })) };
}

// r = salesReceipts row. refs = { customerId, bankAccountId, invoiceIds: {saleId: qbInvoiceId}, bankChargeItemId }
// Returns the Payment and, per invoice with a bank charge, the CreditMemo that
// closes the fee. The Payment applies both: invoice line = money + fee,
// credit line = fee, TotalAmt = money that actually arrived.
function buildCustomerPayment(r, refs) {
    const problems = [];
    const perInvoice = new Map();   // qbInvoiceId -> { money, bankCharge, discount }
    for (const a of (r.allocations || [])) {
        const qbId = refs.invoiceIds[a.sale_id];
        if (!qbId) { problems.push(`sale ${a.sale_id} has no invoice in QuickBooks yet — enter the invoice first`); continue; }
        const x = perInvoice.get(qbId) || { money: 0, bankCharge: 0, discount: 0 };
        x.money = round2(x.money + (a.amount || 0));
        if (a.deduction_amount > 0 && a.deduction_reason === 'bank_charge') x.bankCharge = round2(x.bankCharge + a.deduction_amount);
        if (a.deduction_amount > 0 && a.deduction_reason === 'discount') x.discount = round2(x.discount + a.deduction_amount);
        perInvoice.set(qbId, x);
    }
    if (!perInvoice.size && !problems.length) problems.push('receipt is not allocated to any invoice');
    const anyFee = [...perInvoice.values()].some((x) => x.bankCharge > 0);
    if (anyFee && !refs.bankChargeItemId) problems.push(`no "${BANK_CHARGE_ITEM}" item in QuickBooks to post the fee to`);
    const money = round2([...perInvoice.values()].reduce((s, x) => s + x.money, 0));
    if (!problems.length && Math.abs(money - r.amount) > 0.005) problems.push(`allocated ${money} of a ${r.amount} receipt`);
    if (problems.length) return { problems };

    const creditMemos = [];
    for (const [invId, x] of perInvoice) if (x.bankCharge > 0) {
        creditMemos.push({ forInvoice: invId, amount: x.bankCharge, memo: {
            CustomerRef: { value: String(refs.customerId) }, TxnDate: push.isoDate(r.date),
            PrivateNote: `Bank charge taken from wire · invoice #${invId} · Jarvis receipt ${r.id}`,
            Line: [{ DetailType: 'SalesItemLineDetail', Amount: x.bankCharge, Description: 'Bank charge deducted by intermediary bank', SalesItemLineDetail: { ItemRef: { value: String(refs.bankChargeItemId) } } }],
        } });
    }
    const discounts = round2([...perInvoice.values()].reduce((s, x) => s + x.discount, 0));
    const payment = {
        CustomerRef: { value: String(refs.customerId) }, TotalAmt: money, TxnDate: push.isoDate(r.date),
        DepositToAccountRef: { value: String(refs.bankAccountId) },
        PaymentRefNum: r.ref ? String(r.ref).slice(0, 21) : undefined,
        PrivateNote: [r.mode, r.bank, discounts > 0 && `Discount ${discounts.toFixed(2)} recorded in Jarvis, not posted`, `Jarvis receipt ${r.id}`].filter(Boolean).join(' · '),
        // invoice lines; credit-memo lines are added once their Ids exist
        Line: [...perInvoice].map(([id, x]) => ({ Amount: round2(x.money + x.bankCharge), LinkedTxn: [{ TxnId: String(id), TxnType: 'Invoice' }] })),
    };
    return { payment, creditMemos, total: money, discounts };
}

// same amount already in her books around this date, by any route
async function findSameMoney({ date, amount, kind }, opts) {
    const d = new Date(String(date).slice(0, 10));
    const from = new Date(d.getTime() - WINDOW_DAYS * 864e5).toISOString().slice(0, 10);
    const to = new Date(d.getTime() + WINDOW_DAYS * 864e5).toISOString().slice(0, 10);
    const tables = kind === 'out' ? ['BillPayment', 'Purchase'] : ['Payment', 'Deposit'];
    const hits = [];
    for (const t of tables) {
        const r = await client.query(`select * from ${t} where TxnDate >= '${from}' and TxnDate <= '${to}' maxresults 1000`, opts);
        for (const x of (r[t] || [])) if (Math.abs(Number(x.TotalAmt) - amount) < 0.005) {
            hits.push({ type: t, Id: x.Id, TxnDate: x.TxnDate, TotalAmt: x.TotalAmt, party: ((x.VendorRef || x.CustomerRef || x.EntityRef) || {}).name || '(no payee)' });
        }
    }
    return hits;
}

const note = (env, kind, action, jarvis, extra = {}) => journal.record({ env, kind, action, jarvis, qb: extra.qb || {}, ...extra });

// ── a wire before the load arrives ─────────────────────────────────────────
// Apsara, 2026-09-23, on the Mario Elder tab: "upload mario elder sheet with
// wire as vendor prepayment". Money paid to a supplier before there is a bill
// is not a bill payment — there is nothing to pay. It is a cheque booked to a
// payable account, which leaves a credit standing against him until a load
// turns up; her accountant does exactly this on the bank screen, categorising
// such wires as "Vendor Payable".
//
// Jarvis does NOT choose that account. The role is mapped like any other name
// (mapping kind 'account', Jarvis name 'prepayment'), so the books decide.
const PREPAY_ROLE = 'prepayment';

function buildPrepayment(p, refs) {
    const problems = [];
    const amount = round2(p.amount);
    if (!(amount > 0)) problems.push('an advance needs an amount');
    if ((p.allocations || []).some((a) => a.amount > 0)) problems.push('this advance is already applied to a bill — it goes in as a bill payment, not a prepayment');
    if (problems.length) return { problems };
    return { payment: {
        PaymentType: 'Check',
        AccountRef: { value: String(refs.bankAccountId) },
        EntityRef: { value: String(refs.vendorId), type: 'Vendor' },
        TxnDate: push.isoDate(p.date),
        TotalAmt: amount,
        PrivateNote: [p.mode, p.bank, p.ref && `Ref ${p.ref}`, 'advance — credit against him until a load is applied', `Jarvis payment ${p.id}`].filter(Boolean).join(' · '),
        Line: [{ Amount: amount, DetailType: 'AccountBasedExpenseLineDetail',
            Description: p.note || `advance to ${p.supplier}`,
            AccountBasedExpenseLineDetail: { AccountRef: { value: String(refs.prepayAccountId) } } }],
    }, total: amount };
}

async function pushPrepayment(p, snapshots, { env = auth.qbEnv(), dryRun = true, fetchImpl } = {}) {
    const opts = { env, fetchImpl };
    const jarvis = { id: p.id, supplier: p.supplier, date: p.date, amount: p.amount, mode: p.mode, bank: p.bank, kind: p.kind };
    const cut = push.beforeCutover('bill', p.date, env);
    if (cut) return { status: push.UNREADABLE.test(cut) ? 'blocked' : 'before-cutover', problems: [cut] };
    const key = push.linkKey(env, 'prepayment', p.id);
    if (push.loadLinks()[key]) return { status: 'already-linked', qbId: push.loadLinks()[key].qbId };
    const problems = [];
    const v = push.confirmedName('vendor', p.supplier, snapshots.vendor); if (v.problem) problems.push(v.problem);
    const b = bankName(p.mode, p.bank, snapshots); if (b.problem) problems.push(b.problem);
    const acc = push.confirmedName('account', PREPAY_ROLE, snapshots.account || []);
    if (acc.problem) problems.push('no account is mapped for an advance — map the role "prepayment" to the account her books use (Vendor Payable)');
    const refs = problems.length ? null : {
        vendorId: await push.idByName('Vendor', 'DisplayName', v.name, opts),
        bankAccountId: await push.idByName('Account', 'Name', b.name, opts),
        prepayAccountId: await push.idByName('Account', 'Name', acc.name, opts),
    };
    if (refs) for (const [what, id] of [[v.name, refs.vendorId], [b.name, refs.bankAccountId], [acc.name, refs.prepayAccountId]])
        if (!id) problems.push(`"${what}" not found in QuickBooks ${env}`);
    const built = problems.length ? { problems } : buildPrepayment(p, refs);
    if (built.problems) { if (!dryRun) note(env, 'prepayment', 'blocked', jarvis, { reason: built.problems.join('; ') }); return { status: 'blocked', problems: built.problems }; }
    const same = await findSameMoney({ date: p.date, amount: built.total, kind: 'out' }, opts);
    if (same.length) {
        if (!dryRun) note(env, 'prepayment', 'asked', jarvis, { candidates: same, reason: 'same amount already left the bank around this date' });
        return { status: 'ask', candidates: same, payment: built.payment, note: 'the same amount already left the bank in QuickBooks around this date — she decides' };
    }
    if (dryRun) return { status: 'would-create', payment: built.payment, total: built.total, account: acc.name };
    const out = (await client.request('POST', '/purchase', built.payment, opts)).Purchase;
    push.saveLink(key, { qbId: out.Id, syncToken: out.SyncToken, how: 'created', total: out.TotalAmt, at: new Date().toISOString() });
    const j = note(env, 'prepayment', 'created', jarvis, { linkKey: key, jarvisTotal: p.amount,
        qb: { id: out.Id, syncToken: out.SyncToken, total: out.TotalAmt, partyId: refs.vendorId, party: v.name, bank: b.name, account: acc.name } });
    return { status: 'created', qbId: out.Id, total: out.TotalAmt, journalId: j.id };
}

async function pushBillPayment(p, snapshots, { env = auth.qbEnv(), dryRun = true, fetchImpl } = {}) {
    // An advance with nothing applied to it yet is a prepayment, not a
    // payment: it used to be blocked, which left her $1,000 Mazariegos wire
    // sitting outside the books.
    if (p && p.kind === 'advance' && !(p.allocations || []).some((a) => a.amount > 0)) {
        return pushPrepayment(p, snapshots, { env, dryRun, fetchImpl });
    }
    const opts = { env, fetchImpl };
    const jarvis = { id: p.id, supplier: p.supplier, date: p.date, amount: p.amount, mode: p.mode, bank: p.bank, kind: p.kind, allocations: p.allocations };
    const cut = push.beforeCutover('bill', p.date, env);
    if (cut) return { status: push.UNREADABLE.test(cut) ? 'blocked' : 'before-cutover', problems: [cut] };
    const key = push.linkKey(env, 'billpayment', p.id);
    if (push.loadLinks()[key]) return { status: 'already-linked', qbId: push.loadLinks()[key].qbId };
    const problems = [];
    const v = push.confirmedName('vendor', p.supplier, snapshots.vendor); if (v.problem) problems.push(v.problem);
    const b = bankName(p.mode, p.bank, snapshots); if (b.problem) problems.push(b.problem);
    const links = push.loadLinks(); const billIds = {};
    for (const a of (p.allocations || [])) { const l = links[push.linkKey(env, 'bill', a.bill_id)]; if (l) billIds[a.bill_id] = l.qbId; }
    const refs = problems.length ? null : { vendorId: await push.idByName('Vendor', 'DisplayName', v.name, opts), bankAccountId: await push.idByName('Account', 'Name', b.name, opts), billIds };
    if (refs && (!refs.vendorId || !refs.bankAccountId)) problems.push(`"${!refs.vendorId ? v.name : b.name}" not found in QuickBooks ${env}`);
    const built = problems.length ? { problems } : buildBillPayment(p, refs);
    if (built.problems) { if (!dryRun) note(env, 'billpayment', 'blocked', jarvis, { reason: built.problems.join('; ') }); return { status: 'blocked', problems: built.problems }; }
    const same = await findSameMoney({ date: p.date, amount: built.total, kind: 'out' }, opts);
    if (same.length) {
        if (!dryRun) note(env, 'billpayment', 'asked', jarvis, { candidates: same, wouldLink: built.linked, reason: 'same amount already left the bank around this date' });
        return { status: 'ask', candidates: same, payment: built.payment, note: 'the same amount already left the bank in QuickBooks around this date — she decides' };
    }
    if (dryRun) return { status: 'would-create', payment: built.payment, total: built.total, linked: built.linked };
    const out = (await client.request('POST', '/billpayment', built.payment, opts)).BillPayment;
    push.saveLink(key, { qbId: out.Id, syncToken: out.SyncToken, how: 'created', total: out.TotalAmt, at: new Date().toISOString() });
    const j = note(env, 'billpayment', 'created', jarvis, { linkKey: key, jarvisTotal: p.amount,
        qb: { id: out.Id, syncToken: out.SyncToken, total: out.TotalAmt, partyId: refs.vendorId, party: v.name, bank: b.name, linked: built.linked } });
    return { status: 'created', qbId: out.Id, total: out.TotalAmt, journalId: j.id };
}

// saleInvoiceNo(saleId) → that sale's invoice number (sales.getSale in the app)
async function pushCustomerPayment(r, snapshots, { env = auth.qbEnv(), dryRun = true, fetchImpl, saleInvoiceNo } = {}) {
    const opts = { env, fetchImpl };
    const jarvis = { id: r.id, customer: r.customer, date: r.date, amount: r.amount, mode: r.mode, bank: r.bank, allocations: r.allocations };
    const cut = push.beforeCutover('invoice', r.date, env);
    if (cut) return { status: push.UNREADABLE.test(cut) ? 'blocked' : 'before-cutover', problems: [cut] };
    const key = push.linkKey(env, 'payment', r.id);
    if (push.loadLinks()[key]) return { status: 'already-linked', qbId: push.loadLinks()[key].qbId };
    const problems = [];
    const c = push.confirmedName('customer', r.customer, snapshots.customer); if (c.problem) problems.push(c.problem);
    const b = bankName(r.mode, r.bank, snapshots); if (b.problem) problems.push(b.problem);
    const links = push.loadLinks(); const invoiceIds = {};
    for (const a of (r.allocations || [])) {
        const no = saleInvoiceNo ? saleInvoiceNo(a.sale_id) : null;
        const l = no && links[push.linkKey(env, 'invoice', String(no).trim())];
        if (l) invoiceIds[a.sale_id] = l.qbId;
    }
    const refs = problems.length ? null : { customerId: await push.idByName('Customer', 'DisplayName', c.name, opts),
        bankAccountId: await push.idByName('Account', 'Name', b.name, opts), invoiceIds,
        bankChargeItemId: await push.idByName('Item', 'Name', BANK_CHARGE_ITEM, opts) };
    if (refs && (!refs.customerId || !refs.bankAccountId)) problems.push(`"${!refs.customerId ? c.name : b.name}" not found in QuickBooks ${env}`);
    // The money has to be applied under the customer the invoice is under —
    // QuickBooks refuses otherwise, and a mapping changed after the invoice
    // was entered is exactly how they drift apart (sandbox #146, 2026-09-22).
    if (refs && refs.customerId) for (const qbId of new Set(Object.values(refs.invoiceIds))) {
        const inv = (await client.request('GET', `/invoice/${qbId}`, null, opts)).Invoice;
        if (String(inv.CustomerRef.value) !== String(refs.customerId)) problems.push(`invoice #${qbId} is under ${inv.CustomerRef.name}, but this receipt maps to ${c.name} — fix the mapping or the invoice first`);
    }
    const built = problems.length ? { problems } : buildCustomerPayment(r, refs);
    if (built.problems) { if (!dryRun) note(env, 'payment', 'blocked', jarvis, { reason: built.problems.join('; ') }); return { status: 'blocked', problems: built.problems }; }
    const same = await findSameMoney({ date: r.date, amount: built.total, kind: 'in' }, opts);
    if (same.length) {
        if (!dryRun) note(env, 'payment', 'asked', jarvis, { candidates: same, reason: 'same amount already arrived around this date' });
        return { status: 'ask', candidates: same, payment: built.payment, note: 'the same amount already arrived in QuickBooks around this date — she decides' };
    }
    if (dryRun) return { status: 'would-create', payment: built.payment, creditMemos: built.creditMemos, total: built.total, discounts: built.discounts };

    // fees first, each its own journalled record, then the payment that applies them
    const memos = [];
    for (const cm of built.creditMemos) {
        const out = (await client.request('POST', '/creditmemo', cm.memo, opts)).CreditMemo;
        const cmKey = push.linkKey(env, 'creditmemo', `${r.id}:${cm.forInvoice}`);
        push.saveLink(cmKey, { qbId: out.Id, syncToken: out.SyncToken, how: 'created', total: out.TotalAmt, at: new Date().toISOString() });
        note(env, 'creditmemo', 'created', { ...jarvis, forInvoice: cm.forInvoice, reason: 'bank_charge' }, { linkKey: cmKey, jarvisTotal: cm.amount,
            qb: { id: out.Id, syncToken: out.SyncToken, fp: journal.fingerprint(out), total: out.TotalAmt, partyId: refs.customerId, party: c.name } });
        memos.push({ id: out.Id, amount: cm.amount });
        built.payment.Line.push({ Amount: cm.amount, LinkedTxn: [{ TxnId: String(out.Id), TxnType: 'CreditMemo' }] });
    }
    const out = (await client.request('POST', '/payment', built.payment, opts)).Payment;
    push.saveLink(key, { qbId: out.Id, syncToken: out.SyncToken, how: 'created', total: out.TotalAmt, at: new Date().toISOString() });
    const linked = built.payment.Line.map((l) => ({ type: l.LinkedTxn[0].TxnType, id: l.LinkedTxn[0].TxnId, amount: l.Amount }));
    const j = note(env, 'payment', 'created', jarvis, { linkKey: key, jarvisTotal: r.amount,
        qb: { id: out.Id, syncToken: out.SyncToken, total: out.TotalAmt, partyId: refs.customerId, party: c.name, bank: b.name, linked }, discounts: built.discounts });
    return { status: 'created', qbId: out.Id, total: out.TotalAmt, creditMemos: memos, journalId: j.id };
}

module.exports = { buildPrepayment, pushPrepayment, buildBillPayment, buildCustomerPayment, findSameMoney, pushBillPayment, pushCustomerPayment, WINDOW_DAYS, BANK_CHARGE_ITEM };
