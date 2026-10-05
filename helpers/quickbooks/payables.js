// ── helpers/quickbooks/payables.js — one payables account, not two ──────────
// Apsara, 2026-09-30: "One payables account, not two Agent".
//
// Her books run two: the default Accounts Payable, and Vendor Payable #98
// (-$5,154,868.75 across 495 open bills). Two payable accounts means "what do
// I owe" has two answers and neither screen shows both.
//
// QuickBooks refuses an ACCOUNT MERGE over the API (error 2010, verified
// 2026-09-29), so consolidating means moving the documents and retiring the
// emptied account.
//
// ── WHAT THE SANDBOX SAID, AND WHY THIS IS NARROW (2026-10-05) ─────────────
// scripts/qb-payables-proof.js moved three bills between two payable accounts
// in sandbox. QuickBooks ACCEPTED all three — and on the two that had been
// paid it silently threw the payment away:
//
//   unpaid     $100            moved, balance $100   correct
//   fully paid $200            moved, balance $200   WRONG (was $0)
//   part paid  $300 / $120     moved, balance $300   WRONG (was $180)
//
// In both wrong cases Bill.LinkedTxn came back empty: the BillPayment was
// unapplied, the bill read fully open again, and the money went back into the
// floating pool. Run that over the 495 bills on #98 and paid bills turn back
// into debts while millions join the $4.98M of unallocated payments — the
// exact problem the agent is meant to be shrinking.
//
// So the rule here is absolute: A BILL WITH ANY PAYMENT AGAINST IT IS NEVER
// MOVED. Only an untouched bill moves, and its payment state is re-read
// immediately before the write, because the plan may be minutes old and a
// payment may have landed in between.
//
// That leaves bills that are already paid sitting on the old account. They
// cannot be moved and they should not be: they are history. The old account
// empties as its unpaid bills move and its paid ones age out of the period she
// reports on — so this shrinks the problem, it does not close it in one run.

const client = require('./client');
const auth = require('./auth');
const journal = require('./journal');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (n) => `$${r2(n).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
const PAGE = 1000;

// Selected-column queries do NOT return LinkedTxn (verified 2026-10-05: a
// `select Id,TotalAmt,Balance` came back with no LinkedTxn on a part-paid
// bill). Anything that decides whether a bill is untouched must read `*`.
async function allBills(where, env, fetchImpl) {
    const out = [];
    for (let start = 1; ; start += PAGE) {
        const r = await client.query(`select * from Bill where ${where} maxresults ${PAGE} startposition ${start}`, { env, fetchImpl });
        const rows = r.Bill || [];
        out.push(...rows);
        if (rows.length < PAGE) break;
    }
    return out;
}

// The one test that decides. Both halves must hold: no linked payment of any
// kind, and nothing taken off the balance.
function paymentsOn(bill) {
    return (bill.LinkedTxn || []).filter((t) => /Payment|Credit/i.test(String(t.TxnType || '')));
}
function untouched(bill) {
    return paymentsOn(bill).length === 0 && r2(bill.Balance) === r2(bill.TotalAmt);
}
function whyHeld(bill) {
    const p = paymentsOn(bill);
    if (p.length) return `${p.length} payment/credit against it (${p.map((t) => `${t.TxnType} #${t.TxnId}`).join(', ')}) — moving it would unapply them`;
    if (r2(bill.Balance) !== r2(bill.TotalAmt)) return `${money(bill.TotalAmt)} billed but ${money(bill.Balance)} outstanding — something has been applied to it`;
    return null;
}

// ── TWO COMPANIES ARE NOT TWO ACCOUNTS (2026-10-05) ───────────────────────
// Her books carry THREE payable accounts, and one of them is "Accounts Payable
// - Zimex". Apsara, 2026-09-21, on exactly this: Edge Metals and Edge Yard
// "are different companies. A rule for one is not a rule for the other", and
// she chose to settle inter-company balances with real payments each way — no
// netting. A consolidation that cheerfully swept Zimex's bills onto Edge
// Metals' payable would be one company absorbing another's money, which is
// the one thing this app exists to prevent.
//
// So a qualifier after a dash, a colon or in brackets is read as a company,
// and a move between two different ones is refused outright. It is not
// something to warn about and proceed with.
// Not every qualifier is a company. QuickBooks' own default account is called
// "Accounts Payable (A/P)", and reading "A/P" as a company would have treated
// the main payable as another company's book and blocked every move — found on
// the first run of this, 2026-10-05.
const NOT_A_COMPANY = /^(a\/p|ap|a\/r|ar|accounts? payable|payable|trade|main|default|old|new|current|sub|\d+)$/i;
function companyOf(name) {
    const parts = String(name || '').split(/\s[-\u2013\u2014]\s|\s*:\s*|\s*\(/);
    if (parts.length < 2) return '';
    const q = parts[1].replace(/\)\s*$/, '').trim();
    if (!q || q.length <= 3 || NOT_A_COMPANY.test(q)) return '';
    return q.toLowerCase();
}
function sameBook(a, b) {
    const x = companyOf(a), y = companyOf(b);
    return x === y;
}

async function accounts(env = auth.qbEnv(), fetchImpl) {
    const r = await client.query(`select * from Account where AccountType = 'Accounts Payable' maxresults 100`, { env, fetchImpl });
    return (r.Account || []).map((a) => ({ id: String(a.Id), name: a.Name, active: a.Active !== false,
        balance: r2(a.CurrentBalance), company: companyOf(a.Name) }));
}

// ── what is actually on each payable account ───────────────────────────────
// Read-only, and the figures that decide whether this is worth doing: how much
// of the old account CAN move, and how much is stuck behind a payment.
async function survey({ env = auth.qbEnv(), fetchImpl } = {}) {
    const accs = await accounts(env, fetchImpl);
    const bills = await allBills(`TxnDate >= '2000-01-01'`, env, fetchImpl);
    const byAcc = {};
    for (const b of bills) {
        const id = String((b.APAccountRef || {}).value || 'none');
        const s = byAcc[id] = byAcc[id] || { movable: 0, movableMoney: 0, held: 0, heldMoney: 0, settled: 0, settledMoney: 0 };
        const open = r2(b.Balance) > 0;
        if (!open) { s.settled++; s.settledMoney = r2(s.settledMoney + r2(b.TotalAmt)); continue; }
        if (untouched(b)) { s.movable++; s.movableMoney = r2(s.movableMoney + r2(b.Balance)); }
        else { s.held++; s.heldMoney = r2(s.heldMoney + r2(b.Balance)); }
    }
    const rows = accs.map((a) => ({ ...a, ...(byAcc[a.id] || { movable: 0, movableMoney: 0, held: 0, heldMoney: 0, settled: 0, settledMoney: 0 }) }));
    // The one to keep is the one QuickBooks itself treats as the default: the
    // account carrying the most documents. Guessing by name ("Accounts
    // Payable") would pick the wrong one on books where the custom account is
    // the working one.
    // Only the main book is consolidated. Another company's payable is not a
    // duplicate to be tidied away — it is another company's.
    const main = rows.filter((a) => !a.company);
    const other = rows.filter((a) => a.company);
    const keep = main.slice().sort((x, y) => (y.movable + y.held + y.settled) - (x.movable + x.held + x.settled))[0] || null;
    return { accounts: rows, keep: keep ? keep.id : null, count: rows.length,
        separate: other.map((a) => ({ id: a.id, name: a.name, company: a.company, balance: a.balance,
            why: `"${a.name}" reads as ${a.company}'s payable, not this book's — bills are never moved between two companies` })),
        consolidated: main.filter((a) => a.movable + a.held + a.settled > 0).length <= 1 };
}

// ── the move list, and what will not move ──────────────────────────────────
async function plan({ from, to, env = auth.qbEnv(), limit = 500, fetchImpl } = {}) {
    if (!from || !to) throw new Error('plan needs a from and a to payable account id');
    if (String(from) === String(to)) throw new Error('from and to are the same account');
    const accs = await accounts(env, fetchImpl);
    const target = accs.find((a) => a.id === String(to));
    if (!target) throw new Error(`#${to} is not a payable account on these books`);
    if (!target.active) throw new Error(`#${to} ${target.name} is inactive — moving bills onto it would hide them`);
    const source = accs.find((a) => a.id === String(from));
    if (source && !sameBook(source.name, target.name)) {
        const nameOf = (a) => companyOf(a.name) || 'this book';
        throw new Error(`#${from} ${source.name} and #${to} ${target.name} read as two different companies`
            + ` (${nameOf(source)} and ${nameOf(target)}). Bills are never moved between companies — you settle those with real payments each way.`
            + ` If the names are misleading rather than the accounts, rename them in QuickBooks first.`);
    }

    const bills = (await allBills(`TxnDate >= '2000-01-01'`, env, fetchImpl))
        .filter((b) => String((b.APAccountRef || {}).value || '') === String(from));
    const shape = (b) => ({ id: String(b.Id), doc: b.DocNumber || '', date: b.TxnDate,
        vendor: (b.VendorRef || {}).name || '', vendorId: String((b.VendorRef || {}).value || ''),
        total: r2(b.TotalAmt), balance: r2(b.Balance) });

    const move = [], held = [], settled = [];
    for (const b of bills) {
        if (r2(b.Balance) <= 0) { settled.push({ ...shape(b), why: 'already settled — history, and moving it would unapply the payment that settled it' }); continue; }
        if (untouched(b)) move.push(shape(b));
        else held.push({ ...shape(b), why: whyHeld(b) });
    }
    move.sort((x, y) => String(x.date).localeCompare(String(y.date)));
    const capped = move.slice(0, limit);
    return {
        from: String(from), to: String(to), fromName: (accs.find((a) => a.id === String(from)) || {}).name || '', toName: target.name,
        move: capped, waiting: move.length - capped.length,
        held, settled,
        totals: { move: r2(capped.reduce((s, b) => s + b.balance, 0)), held: r2(held.reduce((s, b) => s + b.balance, 0)),
            settled: r2(settled.reduce((s, b) => s + b.total, 0)) },
        note: held.length || settled.length
            ? `${held.length + settled.length} bill(s) stay on ${(accs.find((a) => a.id === String(from)) || {}).name || `#${from}`}: a bill with a payment against it cannot move without QuickBooks unapplying the payment (proved in sandbox, 2026-10-05). The account empties as those are settled and age out.`
            : 'Every bill on this account can move.',
    };
}

// ── the move ───────────────────────────────────────────────────────────────
// One bill at a time, each one re-read first. A sparse Bill update also
// demands VendorRef (QuickBooks 400s without it — found on the first proof
// run), and the re-read is what makes the payment guard real rather than
// advisory: the plan may be minutes old.
async function apply({ from, to, ids = [], env = auth.qbEnv(), dryRun = true, who = '', fetchImpl } = {}) {
    if (!from || !to) throw new Error('apply needs a from and a to payable account id');
    if (String(from) === String(to)) throw new Error('from and to are the same account');
    if (!ids.length) throw new Error('apply needs the bill ids to move — it never moves a whole account on its own');
    const out = { from: String(from), to: String(to), dryRun, moved: [], refused: [], failed: [] };
    for (const id of ids) {
        let live;
        try { live = (await client.request('GET', `/bill/${id}`, null, { env, fetchImpl })).Bill; }
        catch (e) { out.failed.push({ id: String(id), error: e.message }); continue; }
        if (!live) { out.failed.push({ id: String(id), error: 'not found' }); continue; }
        if (String((live.APAccountRef || {}).value || '') !== String(from)) {
            out.refused.push({ id: String(id), why: `it is on payable account #${(live.APAccountRef || {}).value} now, not #${from}` });
            continue;
        }
        const why = whyHeld(live);
        if (why) { out.refused.push({ id: String(id), why }); continue; }
        const row = { id: String(live.Id), doc: live.DocNumber || '', vendor: (live.VendorRef || {}).name || '', balance: r2(live.Balance) };
        if (dryRun) { out.moved.push({ ...row, dryRun: true }); continue; }
        try {
            await client.request('POST', '/bill', { Id: live.Id, SyncToken: live.SyncToken, sparse: true,
                VendorRef: live.VendorRef, APAccountRef: { value: String(to) } }, { env, fetchImpl });
        } catch (e) { out.failed.push({ id: String(id), error: e.message }); continue; }
        // The write has already landed. A journal that throws here must not
        // report a move that HAPPENED as failed — that is how a real change
        // gets retried, or goes looking for an undo that was never written.
        // (Found on the first sandbox run, 2026-10-05: the bill moved and the
        // run reported it as a failure.)
        try {
            journal.record({ env, kind: 'bill', action: 'moved-payable', jarvis: { id: row.doc || row.id, supplier: row.vendor }, qb: { Id: live.Id },
                reason: `payable account #${from} -> #${to} by ${who || 'qb agent'}`, undo: { kind: 'payable', qbId: String(live.Id), back: String(from) } });
            out.moved.push(row);
        } catch (e) {
            out.moved.push({ ...row, unjournalled: `moved, but the journal refused the entry: ${e.message}` });
        }
    }
    out.totals = { moved: r2(out.moved.reduce((s, b) => s + (b.balance || 0), 0)) };
    return out;
}

// Putting one back is the same write in reverse, which is what makes this the
// one safe half of the consolidation: nothing here is irreversible.
async function undo({ qbId, back, env = auth.qbEnv(), who = '', fetchImpl } = {}) {
    const live = (await client.request('GET', `/bill/${qbId}`, null, { env, fetchImpl })).Bill;
    if (!live) throw new Error(`bill #${qbId} is gone`);
    await client.request('POST', '/bill', { Id: live.Id, SyncToken: live.SyncToken, sparse: true,
        VendorRef: live.VendorRef, APAccountRef: { value: String(back) } }, { env, fetchImpl });
    journal.record({ env, kind: 'bill', action: 'moved-payable', jarvis: { id: live.DocNumber || String(qbId) }, qb: { Id: live.Id },
        reason: `put back on payable account #${back} by ${who || 'qb agent'}` });
    return { ok: true, qbId: String(qbId), back: String(back) };
}

function reportText(s) {
    if (!s || !s.accounts) return 'Payable accounts: could not be read.';
    const L = [`Payable accounts in use: ${s.accounts.length}`];
    for (const a of s.accounts) {
        L.push(`  #${a.id} ${a.name}${a.active ? '' : ' (inactive)'} — ${money(a.balance)}`
            + `; ${a.movable} bill(s) ${money(a.movableMoney)} can move, ${a.held} ${money(a.heldMoney)} held by a payment, ${a.settled} settled`);
    }
    if (s.keep) L.push(`  Keep #${s.keep} — it carries the most documents.`);
    L.push('  A bill with a payment against it is never moved: QuickBooks accepts the write and unapplies the payment (sandbox, 2026-10-05).');
    return L.join('\n');
}

module.exports = { survey, plan, apply, undo, accounts, untouched, paymentsOn, whyHeld, reportText, companyOf, sameBook };
