// ── helpers/quickbooks/applyPayments.js — money paid, money matched ────────
// Apsara, 2026-09-26, hunting a $5.3M payable: "find out where and why, how
// to resolve."
//
// Where: the accounts payable sub-ledger. $4,961,160.77 across 129 bill
// payments carries no allocation at all — the money left the bank and
// QuickBooks knows it, but nobody said WHICH bill it paid. So every bill sits
// open, the ageing says $10.1M is over ninety days when much of it is settled,
// and no supplier statement can be reconciled.
//
// ── WHY THIS IS THE SAFE STEP ─────────────────────────────────────────────
// Allocating a payment moves nothing. No bank entry, no profit and loss, no
// change to what the payable account totals — it only says which bill the
// money already spent belongs to. That is why it comes first, before any
// voiding: after this, what is still open is the real debt, and every later
// decision is made on numbers that mean something.
//
// Proved on the sandbox 2026-09-26: a bill payment's Line list can be
// rewritten to spread it across bills, and QuickBooks recomputes each bill's
// balance from it ($100 moved to $40 + $60; both bills updated).
//
// ── THE RULES IT MATCHES BY ───────────────────────────────────────────────
//   1. exact  — the unapplied amount equals an open bill's balance to the
//               cent. That is almost always the bill that was paid.
//   2. oldest — then oldest bill first, the way a payables clerk applies a
//               payment on account. Never more than the bill's balance,
//               never more than the payment has left, never another vendor.
// Anything it cannot place is left alone and named, not forced onto a bill.
const client = require('./client');
const auth = require('./auth');
const journal = require('./journal');
const books = require('./books');

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const q1 = (v) => String(v == null ? '' : v).replace(/'/g, "''");

async function pull(table, where, opts, cap = 4000) {
    let all = [], start = 1;
    for (;;) {
        const r = await client.query(`select * from ${table}${where ? ' where ' + where : ''} startposition ${start} maxresults 1000`, opts);
        const rows = r[table] || [];
        all = all.concat(rows);
        if (rows.length < 1000 || all.length >= cap) break;
        start += 1000;
    }
    return all;
}

const appliedOn = (p) => r2((p.Line || []).reduce((s, l) => s + ((l.LinkedTxn || []).length ? Number(l.Amount || 0) : 0), 0));
const looseOn = (p) => r2(Number(p.TotalAmt || 0) - appliedOn(p));

// ── THE PLAN ───────────────────────────────────────────────────────────────
// Read-only. Every pairing it would make, with the reason it made it.
async function plan({ vendor = null, vendorId = null, env = auth.qbEnv(), since = '2024-01-01', limit = 60 } = {}) {
    const opts = { env };
    const where = (t) => {
        const bits = [`TxnDate >= '${q1(since)}'`];
        if (vendorId) bits.push(`VendorRef = '${q1(vendorId)}'`);
        return bits.join(' and ') + (t === 'Bill' ? " and Balance > '0'" : '');
    };
    const [pays, bills] = await Promise.all([
        pull('BillPayment', where('BillPayment'), opts),
        pull('Bill', where('Bill'), opts),
    ]);

    // open bills per vendor, oldest first — the order a payment on account
    // should eat through them
    const openBy = {};
    for (const b of bills) {
        const vid = String((b.VendorRef || {}).value || '');
        if (!vid) continue;
        (openBy[vid] = openBy[vid] || []).push({ id: String(b.Id), doc: String(b.DocNumber || '').trim(),
            date: b.TxnDate, total: r2(b.TotalAmt), balance: r2(b.Balance), left: r2(b.Balance) });
    }
    for (const v of Object.values(openBy)) v.sort((a, b) => String(a.date).localeCompare(String(b.date)));

    const out = { env, since, at: new Date().toISOString(), payments: [], unplaceable: [],
        totals: { loose: 0, placed: 0, bills: 0, payments: 0 } };

    const loosePays = pays.filter((p) => looseOn(p) > 0.01)
        .filter((p) => !vendor || String((p.VendorRef || {}).name || '').trim().toUpperCase() === String(vendor).trim().toUpperCase())
        .sort((a, b) => String(a.TxnDate).localeCompare(String(b.TxnDate)));

    for (const p of loosePays.slice(0, limit)) {
        const vid = String((p.VendorRef || {}).value || '');
        const open = openBy[vid] || [];
        let left = looseOn(p);
        out.totals.loose = r2(out.totals.loose + left);
        const picks = [];

        // 1. the bill whose balance IS this money
        const exact = open.find((b) => b.left > 0 && Math.abs(b.left - left) < 0.005);
        if (exact) { picks.push({ ...exact, take: exact.left,
            why: exact.left === exact.balance ? 'the open balance matches this payment to the cent'
                : 'what is left open on this bill matches this payment to the cent' });
            exact.left = 0; left = 0; }

        // 2. then oldest first
        for (const b of open) {
            if (left <= 0.005) break;
            if (b.left <= 0.005) continue;
            const take = r2(Math.min(b.left, left));
            picks.push({ ...b, take, why: take === b.balance ? 'oldest bill still open — settles it' : 'oldest bill still open — part payment' });
            b.left = r2(b.left - take);
            left = r2(left - take);
        }

        const row = { id: String(p.Id), date: p.TxnDate, vendor: (p.VendorRef || {}).name || '', vendorId: vid,
            total: r2(p.TotalAmt), alreadyApplied: appliedOn(p), loose: looseOn(p),
            picks: picks.map((x) => ({ billId: x.id, doc: x.doc, date: x.date, total: x.total, balance: x.balance, take: x.take, why: x.why })),
            leftOver: r2(left) };
        if (!picks.length) out.unplaceable.push({ ...row, why: 'this supplier has no open bill to put it against — it may be a prepayment, or the bill is missing' });
        else {
            out.payments.push(row);
            out.totals.placed = r2(out.totals.placed + r2(row.loose - row.leftOver));
            out.totals.payments++;
            out.totals.bills += picks.length;
        }
    }
    return out;
}

// ── DOING IT ───────────────────────────────────────────────────────────────
// One payment at a time, each re-read live first: if it moved since the plan
// was made, it is skipped and said so, never forced.
async function apply(planned, { reason, env = auth.qbEnv(), by = 'apsara', really = false } = {}) {
    if (!reason || String(reason).trim().length < 4) throw new Error('a reason is required — it goes in the journal beside every allocation');
    const out = { env, dryRun: !really, reason: String(reason).trim(), done: [], skipped: [], totals: { placed: 0, payments: 0 } };
    for (const row of planned.payments || []) {
        if (!row.picks.length) continue;
        if (!really) {
            out.done.push({ id: row.id, vendor: row.vendor, placed: r2(row.loose - row.leftOver), bills: row.picks.length });
            out.totals.placed = r2(out.totals.placed + r2(row.loose - row.leftOver));
            out.totals.payments++;
            continue;
        }
        try {
            const live = (await client.request('GET', `/billpayment/${row.id}`, null, { env })).BillPayment;
            if (!live) { out.skipped.push({ id: row.id, why: 'no longer in QuickBooks' }); continue; }
            if (r2(live.TotalAmt) !== row.total || looseOn(live) + 0.005 < r2(row.loose - row.leftOver)) {
                out.skipped.push({ id: row.id, vendor: row.vendor, why: 'this payment changed in QuickBooks since the plan was made — left alone' });
                continue;
            }
            // keep what is already allocated, add what the plan places
            const body = {
                Id: String(live.Id), SyncToken: String(live.SyncToken),
                VendorRef: live.VendorRef, PayType: live.PayType, TotalAmt: live.TotalAmt,
                TxnDate: live.TxnDate, DocNumber: live.DocNumber, PrivateNote: live.PrivateNote,
                ...(live.CheckPayment ? { CheckPayment: live.CheckPayment } : {}),
                ...(live.CreditCardPayment ? { CreditCardPayment: live.CreditCardPayment } : {}),
                ...(live.APAccountRef ? { APAccountRef: live.APAccountRef } : {}),
                Line: [...(live.Line || []).filter((l) => (l.LinkedTxn || []).length),
                    ...row.picks.map((p) => ({ Amount: p.take, LinkedTxn: [{ TxnId: String(p.billId), TxnType: 'Bill' }] }))],
            };
            await client.request('POST', '/billpayment', body, { env });
            try {
                journal.record({ env, kind: 'billpayment', action: 'allocated',
                    qb: { id: String(live.Id), total: r2(live.TotalAmt) },
                    jarvis: { vendor: row.vendor },
                    by, reason: `${out.reason} — placed ${r2(row.loose - row.leftOver)} across ${row.picks.map((p) => `#${p.billId}${p.doc ? ` (${p.doc})` : ''} ${p.take}`).join(', ')}` });
            } catch { /* client.js already logged the raw write */ }
            out.done.push({ id: row.id, vendor: row.vendor, placed: r2(row.loose - row.leftOver), bills: row.picks.length });
            out.totals.placed = r2(out.totals.placed + r2(row.loose - row.leftOver));
            out.totals.payments++;
        } catch (e) {
            out.skipped.push({ id: row.id, vendor: row.vendor, why: e.message });
        }
    }
    if (really) books.forget();
    return out;
}

module.exports = { plan, apply, looseOn, appliedOn };
