// ── helpers/quickbooks/applyReceipts.js — customer money, placed ───────────
// The mirror of applyPayments.js, on the other side of the books.
//
// Apsara, 2026-09-28, on the receivables screen: $3,115,258.56 showing as
// owed to her, with $131,763.84 of it ALREADY IN THE BANK and not applied to
// any invoice. Every one of those invoices reads open. Chase one of those
// customers and she is apologising by return of post — which is why
// receivables.js refuses to draft a reminder for them ('apply-first').
//
// The agent's own invariant list has said `who: 'agent'` against this since it
// was written, and run() had no path for it: it executed the supplier side and
// nothing else. The claim was ahead of the code. This closes that.
//
// Placing a receipt moves NO money: no bank entry, no profit and loss, no
// change to what the customer owes in total. It only says which invoice the
// money was for. That is what makes it the safe half, and the agent is allowed
// to do only the certain ones — a balance that equals the receipt to the cent.
//
// ── WHAT THE SANDBOX SAID (2026-10-05) ────────────────────────────────────
// Three things, each verified against a sandbox company before a line of this
// was written, because all three decide whether it is safe:
//
//  1. Payment carries UnappliedAmt directly — the loose money is readable and
//     does not have to be inferred. It is still cross-checked against the
//     lines, because a queried row can come back without it.
//
//  2. A sparse update with TotalAmt + Line[LinkedTxn] applies cleanly:
//     UnappliedAmt went 500 -> 0 and the invoice balance 500 -> 0.
//
//  3. A SPARSE UPDATE THAT SENDS ONLY THE NEW LINE WIPES THE ALLOCATIONS
//     ALREADY ON THE PAYMENT. A $300 receipt with $100 already applied to
//     invoice A was updated with one new line for invoice B: QuickBooks
//     accepted it, and invoice A went from settled back to $100 open. So
//     every existing linked line is resent with the new ones, always. This is
//     the single most expensive mistake available here — it un-settles
//     invoices that were correctly settled, silently.
//
//  4. A cross-customer link is REFUSED ("TxnID Cannot Be Linked"). That is
//     the TAEWON case: $27,099.79 received onto TAEWON AUTOMOTIVE while the
//     debt sits on TAEWON PRECEISION. No allocation can fix it — the receipt
//     has to be moved to the right customer record, or the records merged,
//     and QuickBooks refuses a merge over the API too. So it is reported as
//     a thing for her, with both names, rather than attempted and failed.

const client = require('./client');
const auth = require('./auth');
const journal = require('./journal');
const { choosePicks } = require('./applyPayments');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const q1 = (s) => String(s).replace(/'/g, "\\'");
const KEY = (s) => String(s || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

async function pull(table, where, opts, cap = 5000) {
    const all = [];
    for (let start = 1; start <= cap; start += 1000) {
        const r = await client.query(`select * from ${table} where ${where} maxresults 1000 startposition ${start}`, opts);
        const rows = r[table] || [];
        all.push(...rows);
        if (rows.length < 1000) break;
    }
    return all;
}

// What is already placed, and what is loose. UnappliedAmt is what QuickBooks
// itself says; the line sum is the belt to its braces, because a row that came
// back from a query without UnappliedAmt would otherwise read as fully loose
// and be re-placed on top of its own allocations.
function appliedOn(p) {
    return r2((p.Line || []).reduce((s, l) => s + ((l.LinkedTxn || []).length ? (Number(l.Amount) || 0) : 0), 0));
}
function looseOn(p) {
    const byLines = r2(r2(p.TotalAmt) - appliedOn(p));
    if (typeof p.UnappliedAmt === 'number') return r2(Math.min(r2(p.UnappliedAmt), byLines));
    return byLines;
}

function aliases() {
    try {
        const raw = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'qb-settings', 'qb-same-customers.json'), 'utf8'));
        const map = {};
        for (const [from, to] of Object.entries(raw)) { if (from.startsWith('_')) continue; map[KEY(from)] = to; }
        return map;
    } catch { return {}; }
}

// ── THE PLAN ───────────────────────────────────────────────────────────────
// Read-only. Every pairing it would make, with the reason it made it.
async function plan({ customer = null, customerId = null, env = auth.qbEnv(), since = '2024-01-01', limit = 60 } = {}) {
    const opts = { env };
    const where = (t) => {
        const bits = [`TxnDate >= '${q1(since)}'`];
        if (customerId) bits.push(`CustomerRef = '${q1(customerId)}'`);
        return bits.join(' and ') + (t === 'Invoice' ? " and Balance > '0'" : '');
    };
    const [pays, invs] = await Promise.all([
        pull('Payment', where('Payment'), opts),
        pull('Invoice', where('Invoice'), opts),
    ]);

    // open invoices per customer, oldest first — the order a receipt on
    // account should eat through them
    const openBy = {};
    for (const i of invs) {
        const cid = String((i.CustomerRef || {}).value || '');
        if (!cid) continue;
        (openBy[cid] = openBy[cid] || []).push({ invoiceId: String(i.Id), doc: String(i.DocNumber || '').trim(),
            date: i.TxnDate, total: r2(i.TotalAmt), balance: r2(i.Balance), left: r2(i.Balance) });
    }
    for (const v of Object.values(openBy)) v.sort((a, b) => String(a.date).localeCompare(String(b.date)));

    const alias = aliases();
    const nameOf = (p) => String((p.CustomerRef || {}).name || '').trim();
    const out = { env, since, at: new Date().toISOString(), receipts: [], unplaceable: [],
        totals: { loose: 0, placed: 0, invoices: 0, receipts: 0, certain: 0 } };

    const loose = pays.filter((p) => looseOn(p) > 0.01)
        .filter((p) => !customer || KEY(nameOf(p)) === KEY(customer))
        .sort((a, b) => String(a.TxnDate).localeCompare(String(b.TxnDate)));

    for (const p of loose.slice(0, limit)) {
        const cid = String((p.CustomerRef || {}).value || '');
        const amount = looseOn(p);
        out.totals.loose = r2(out.totals.loose + amount);
        const row = { id: String(p.Id), customer: nameOf(p), customerId: cid, date: p.TxnDate,
            total: r2(p.TotalAmt), loose: amount, ref: String(p.PaymentRefNum || '').trim() };
        const open = openBy[cid] || [];
        if (!open.length) {
            // Is the debt on a DIFFERENT record for the same company? That is
            // the whole TAEWON case, and QuickBooks will not link across
            // customers — so say so instead of trying.
            const twin = alias[KEY(row.customer)];
            const twinOpen = twin ? Object.entries(openBy).find(([, rows]) => rows.length && KEY(twin) && rows.length) : null;
            out.unplaceable.push({ ...row,
                why: twin
                    ? `nothing open on "${row.customer}", but "${twin}" is the same company on your list — QuickBooks refuses to link a receipt to another customer's invoice, so this receipt has to be moved onto "${twin}" (or the two records merged, which the API also refuses)`
                    : 'nothing open on this customer — the money is here and the invoice is not, so either it is not entered yet or it is on another customer record',
                twin: twin || null, crossCustomer: !!twin });
            continue;
        }
        const { picks, leftOver } = choosePicks(amount, open);
        row.picks = picks.map((x) => ({ invoiceId: x.invoiceId, doc: x.doc, date: x.date, balance: x.balance, take: x.take, why: x.why }));
        row.leftOver = leftOver;
        row.certain = picks.length === 1 && picks[0].certain === true;
        if (!picks.length) { out.unplaceable.push({ ...row, why: 'open invoices exist but none could take any of it' }); continue; }
        out.receipts.push(row);
        out.totals.placed = r2(out.totals.placed + r2(amount - leftOver));
        out.totals.invoices += picks.length;
        out.totals.receipts++;
        if (row.certain) out.totals.certain++;
    }
    return out;
}

// ── THE WRITE ──────────────────────────────────────────────────────────────
// `really` is false unless the caller means it, and `certainOnly` is what the
// agent uses: it places only the receipts whose single invoice matches to the
// cent and leaves the oldest-first guesses for a person.
async function apply(planned, { reason, really = false, by = 'apsara', env = auth.qbEnv(), certainOnly = false } = {}) {
    if (!String(reason || '').trim()) throw new Error('a reason is required — it goes in the journal');
    const out = { env, dryRun: !really, reason: String(reason).trim(), done: [], skipped: [],
        totals: { placed: 0, receipts: 0, invoices: 0 } };
    for (const row of (planned.receipts || [])) {
        if (!row.picks || !row.picks.length) continue;
        if (certainOnly && !row.certain) {
            out.skipped.push({ id: row.id, customer: row.customer, why: 'not a to-the-cent match — left for you' });
            continue;
        }
        const placing = r2(row.loose - (row.leftOver || 0));
        if (!really) {
            out.done.push({ id: row.id, customer: row.customer, placed: placing, invoices: row.picks.length, certain: !!row.certain, dryRun: true });
            out.totals.placed = r2(out.totals.placed + placing);
            out.totals.receipts++; out.totals.invoices += row.picks.length;
            continue;
        }
        try {
            const live = (await client.request('GET', `/payment/${row.id}`, null, { env })).Payment;
            if (!live) { out.skipped.push({ id: row.id, why: 'no longer in QuickBooks' }); continue; }
            if (r2(live.TotalAmt) !== row.total || looseOn(live) + 0.005 < placing) {
                out.skipped.push({ id: row.id, customer: row.customer, why: 'this receipt changed in QuickBooks since the plan was made — left alone' });
                continue;
            }
            // EVERY existing linked line is resent. Sending only the new ones
            // wipes them, and the invoices they settled spring back open
            // (sandbox, 2026-10-05).
            const body = {
                Id: String(live.Id), SyncToken: String(live.SyncToken),
                CustomerRef: live.CustomerRef, TotalAmt: live.TotalAmt, TxnDate: live.TxnDate,
                ...(live.PaymentRefNum ? { PaymentRefNum: live.PaymentRefNum } : {}),
                ...(live.PrivateNote ? { PrivateNote: live.PrivateNote } : {}),
                ...(live.DepositToAccountRef ? { DepositToAccountRef: live.DepositToAccountRef } : {}),
                ...(live.ARAccountRef ? { ARAccountRef: live.ARAccountRef } : {}),
                ...(live.PaymentMethodRef ? { PaymentMethodRef: live.PaymentMethodRef } : {}),
                Line: [...(live.Line || []).filter((l) => (l.LinkedTxn || []).length),
                    ...row.picks.map((p) => ({ Amount: p.take, LinkedTxn: [{ TxnId: String(p.invoiceId), TxnType: 'Invoice' }] }))],
            };
            await client.request('POST', '/payment', body, { env });
            try {
                journal.record({ env, kind: 'payment', action: 'allocated',
                    qb: { id: String(live.Id), total: r2(live.TotalAmt) },
                    jarvis: { customer: row.customer, certain: !!row.certain,
                        why: (row.picks[0] || {}).why || null, invoices: row.picks.length },
                    by, reason: `${out.reason} — placed ${placing} across ${row.picks.map((p) => `#${p.invoiceId}${p.doc ? ` (${p.doc})` : ''} ${p.take}`).join(', ')}` });
            } catch { /* client.js already logged the raw write */ }
            out.done.push({ id: row.id, customer: row.customer, placed: placing, invoices: row.picks.length, certain: !!row.certain });
            out.totals.placed = r2(out.totals.placed + placing);
            out.totals.receipts++; out.totals.invoices += row.picks.length;
        } catch (e) {
            out.skipped.push({ id: row.id, customer: row.customer, why: e.message });
        }
    }
    return out;
}

function reportText(p) {
    if (!p) return 'Customer money waiting to be placed: could not be read.';
    const m = (n) => `$${r2(n).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    const L = [`Customer money in the bank but not on an invoice: ${m(p.totals.loose)} across ${(p.receipts || []).length + (p.unplaceable || []).length} receipt(s)`];
    if (p.totals.receipts) L.push(`  ${m(p.totals.placed)} can be placed across ${p.totals.invoices} invoice(s); ${p.totals.certain} match to the cent and the agent may place those itself.`);
    for (const u of (p.unplaceable || []).slice(0, 8)) L.push(`  ${u.customer} ${m(u.loose)} — ${u.why}`);
    if (p.totals.loose) L.push('  Placing a receipt moves no money: no bank entry, no profit and loss, no change to what they owe. It only says which invoice it was for.');
    return L.join('\n');
}

module.exports = { plan, apply, looseOn, appliedOn, aliases, reportText };
