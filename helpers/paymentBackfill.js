// helpers/paymentBackfill.js - bring the payments QuickBooks already has into Jarvis receipts.
// Apsara, 2026-11-07 (ownership plan, slice 1): Jarvis's sales ledger holds invoices but not payments (Rad Metal: 96 sales, 0
// receipts, "$4.78M open", a customer who always pays), and QuickBooks goes away in January 2027, after which Jarvis must hold
// the payments itself. This turns each QuickBooks Payment line applied to an invoice into a Jarvis receipt against the matching
// sale(s). plan() is PURE: no network, no writes. apply() writes, only when asked, and is idempotent.
//
// Rules, each one a way this could quietly go wrong:
//  - a receipt never allocates more than a sale still has outstanding (no over-payment, no negative balance)
//  - one receipt per (QuickBooks payment, Jarvis customer): addReceipt refuses a receipt that spans customers
//  - a QuickBooks invoice can be one bundled invoice for many Jarvis sales: its payment is spread oldest sale first
//  - anything that cannot be placed is LISTED (leftover / no match), never guessed
//  - a payment already imported (ref "QB:<id>") is skipped, so running it twice adds nothing
const KEY = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const CENT = 0.005;

function modeOf(pm) {
    const t = String((pm && (pm.name || pm)) || '');
    if (/zelle/i.test(t)) return { mode: 'Zelle', guessed: false };
    if (/cash/i.test(t)) return { mode: 'Cash', guessed: false };
    if (/check|cheque/i.test(t)) return { mode: 'Cheque', guessed: false };
    if (/wire|ach|transfer|swift|\btt\b|t\/t|bank/i.test(t)) return { mode: 'Wire', guessed: false };
    return { mode: 'Wire', guessed: true };         // most customer money here arrives by wire; flagged so she can see it was a guess
}
function bankOf(acct) {
    const t = String((acct && (acct.name || acct)) || '');
    if (/bofa|bank of america/i.test(t)) return 'BofA';
    if (/chase/i.test(t)) return 'Chase Bank';
    return t.trim() || 'Others';
}

// qb: { payments: [QuickBooks Payment], invoices: [QuickBooks Invoice] } · sales: sales.listWithTotals() rows · receipts: existing Jarvis receipts
function plan({ qb, sales, receipts = [] }) {
    const invById = new Map((qb.invoices || []).map((i) => [String(i.Id), i]));
    // a payment already imported under ANY customer split is skipped whole (its sale balances already reflect it)
    const done = new Set((receipts || []).map((r) => (/^QB:(\d+)/.exec(String(r.ref || '')) || [])[1]).filter(Boolean));
    // what each sale still has outstanding, tracked as this plan allocates (starts from Jarvis's own balance)
    const room = new Map(); const byId = new Map();
    for (const s of sales) { if (s.balance === null || s.balance === undefined) continue; room.set(s.id, r2(s.balance)); byId.set(s.id, s); }
    const proposed = [], leftover = [], unmatched = [], skippedDone = [];
    const covered = new Map();                                   // sale id -> amount this plan covers

    const salesFor = (qinv) => {
        const doc = KEY(qinv.DocNumber);
        const conts = new Set(((qinv.Line || []).map((l) => l.Description || '').join(' ').match(/[A-Z]{4}\d{7}/g)) || []);
        return sales.filter((s) => s.balance !== null && s.balance !== undefined && (
            (doc && s.invoice_no && KEY(s.invoice_no) === doc) || (s.container_no && conts.has(KEY(s.container_no).toUpperCase()))))
            .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
    };

    for (const p of (qb.payments || [])) {
        const ref = 'QB:' + p.Id;
        if (done.has(String(p.Id))) { skippedDone.push({ ref, amount: r2(p.TotalAmt) }); continue; }
        const { mode, guessed } = modeOf(p.PaymentMethodRef);
        const perCustomer = new Map();                           // jarvis customer -> { allocations, total }
        let unplaced = 0;
        for (const line of (p.Line || [])) {
            const links = (line.LinkedTxn || []).filter((l) => l.TxnType === 'Invoice');
            if (!links.length) continue;
            for (const l of links) {
                let amt = r2(links.length === 1 ? line.Amount : line.Amount / links.length);
                const qinv = invById.get(String(l.TxnId));
                const cands = qinv ? salesFor(qinv) : [];
                if (!cands.length) { unmatched.push({ ref, doc: qinv ? qinv.DocNumber : String(l.TxnId), customer: (p.CustomerRef || {}).name || '', amount: amt, why: qinv ? 'no Jarvis sale for this invoice' : 'invoice not in the QuickBooks pull' }); continue; }
                for (const s of cands) {
                    if (amt <= CENT) break;
                    const free = room.get(s.id) || 0;
                    const take = r2(Math.min(amt, free));
                    if (take <= CENT) continue;
                    room.set(s.id, r2(free - take)); amt = r2(amt - take);
                    covered.set(s.id, r2((covered.get(s.id) || 0) + take));
                    const c = perCustomer.get(s.customer) || { allocations: [], total: 0 };
                    const ex = c.allocations.find((a) => a.sale_id === s.id);
                    if (ex) ex.amount = r2(ex.amount + take); else c.allocations.push({ sale_id: s.id, amount: take });
                    c.total = r2(c.total + take); perCustomer.set(s.customer, c);
                }
                if (amt > CENT) unplaced = r2(unplaced + amt);
            }
        }
        for (const [customer, c] of perCustomer) {
            proposed.push({ ref: ref + ':' + KEY(customer), qb_payment: String(p.Id), customer, date: String(p.TxnDate || '').slice(0, 10), amount: c.total, mode, mode_guessed: guessed,
                bank: (mode === 'Wire' || mode === 'Zelle') ? bankOf(p.DepositToAccountRef) : null, allocations: c.allocations,
                note: `Backfilled from QuickBooks payment ${p.Id}${p.PaymentRefNum ? ' (ref ' + p.PaymentRefNum + ')' : ''}` });
        }
        if (unplaced > CENT) leftover.push({ ref, customer: (p.CustomerRef || {}).name || '', amount: unplaced, why: 'more than the matching Jarvis sale(s) still show outstanding' });
    }

    // Jarvis sales still open whose QuickBooks invoice says fully paid, but nothing above explains it
    const unexplained = [];
    for (const i of (qb.invoices || [])) {
        if (Number(i.Balance) > CENT) continue;
        for (const s of salesFor(i)) {
            const open = r2(s.balance - (covered.get(s.id) || 0));
            if (open > CENT) unexplained.push({ sale_id: s.id, customer: s.customer, invoice_no: s.invoice_no || null, container_no: s.container_no || null, open });
        }
    }
    // What is STILL open in Jarvis after this plan, and why: QuickBooks agrees it is unpaid / QuickBooks says paid but nothing explains it
    // (listed above) / QuickBooks has no invoice for it at all (never invoiced there, or numbered differently).
    const qbFor = (sale) => (qb.invoices || []).find((i) => salesFor(i).some((x) => x.id === sale.id));
    const remaining = { qbOpen: { n: 0, amount: 0 }, qbPaidUnexplained: { n: 0, amount: 0 }, notInQuickbooks: { n: 0, amount: 0 }, notInQuickbooksList: [] };
    for (const s of sales) {
        if (s.balance === null || s.balance === undefined) continue;
        const open = r2(s.balance - (covered.get(s.id) || 0));
        if (open <= CENT) continue;
        const i = qbFor(s);
        const k = !i ? 'notInQuickbooks' : Number(i.Balance) > CENT ? 'qbOpen' : 'qbPaidUnexplained';
        remaining[k].n += 1; remaining[k].amount = r2(remaining[k].amount + open);
        if (k === 'notInQuickbooks' && remaining.notInQuickbooksList.length < 10) remaining.notInQuickbooksList.push({ invoice_no: s.invoice_no || null, container_no: s.container_no || null, date: s.date || null, open });
    }
    const sum = (a, k = 'amount') => r2(a.reduce((t, x) => t + x[k], 0));
    return { proposed, leftover, unmatched, unexplained, skippedDone, remaining,
        totals: { receipts: proposed.length, money: sum(proposed), leftover: sum(leftover), unmatched: sum(unmatched), unexplained: sum(unexplained, 'open'), alreadyImported: skippedDone.length,
            customers: [...new Set(proposed.map((x) => x.customer))].length, modeGuessed: proposed.filter((x) => x.mode_guessed).length } };
}

// Writes the proposed receipts. Idempotent (skips a ref already present) and per-row safe (one failure never stops the rest).
async function apply(proposed, { addReceipt, existingRefs = new Set(), createdBy = 'qb-backfill' } = {}) {
    const out = { written: 0, skipped: 0, failed: [] };
    for (const r of proposed) {
        if (existingRefs.has(r.ref)) { out.skipped += 1; continue; }
        try {
            await addReceipt({ date: r.date, amount: r.amount, mode: r.mode, bank: r.bank, ref: r.ref, customer: r.customer, note: r.note, allocations: r.allocations, created_by: createdBy });
            out.written += 1; existingRefs.add(r.ref);
        } catch (e) { out.failed.push({ ref: r.ref, customer: r.customer, why: e.message }); }
    }
    return out;
}

module.exports = { plan, apply, modeOf, bankOf };
