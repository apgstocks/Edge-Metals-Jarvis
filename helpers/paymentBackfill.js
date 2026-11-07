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
// A wire loses a few dollars to the intermediary banks on the way (helpers/salesReceipts.js: 'bank_charge'). Apsara, 2026-11-07: "bank fee can be
// there". Up to this much short is read as a wire fee, never as an unpaid balance - and always SAID on the receipt.
const FEE_TOLERANCE = 50;

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
function plan({ qb, sales, receipts = [], fifoUnapplied = false }) {
    const invById = new Map((qb.invoices || []).map((i) => [String(i.Id), i]));
    // a payment already imported under ANY customer split is skipped whole (its sale balances already reflect it)
    const done = new Set((receipts || []).map((r) => (/^QB:(\d+)/.exec(String(r.ref || '')) || [])[1]).filter(Boolean));
    // what each sale still has outstanding, tracked as this plan allocates (starts from Jarvis's own balance)
    const room = new Map(); const byId = new Map();
    for (const s of sales) { if (s.balance === null || s.balance === undefined) continue; room.set(s.id, r2(s.balance)); byId.set(s.id, s); }
    const proposed = [], leftover = [], unmatched = [], skippedDone = [], unappliedCash = [];
    const covered = new Map();                                   // sale id -> amount this plan covers

    // "26rmt42,43" is one QuickBooks invoice written for two Jarvis sales (26RMT42 and 26RMT43)
    const docTokens = (d) => {
        const t = String(d || '').trim();
        const m = /^(.*?[A-Za-z_])(\d+)((?:\s*[,&/]\s*\d+)+)$/.exec(t);
        const raw = m ? [m[1] + m[2], ...m[3].split(/[,&/]/).map((x) => x.trim()).filter(Boolean).map((n) => m[1] + n)] : [t];
        return raw.map(KEY).filter((k) => k.length >= 5);
    };
    const salesFor = (qinv) => {
        const doc = KEY(qinv.DocNumber);
        const toks = docTokens(qinv.DocNumber);
        const conts = new Set(((qinv.Line || []).map((l) => l.Description || '').join(' ').match(/[A-Z]{4}\d{7}/g)) || []);
        return sales.filter((s) => s.balance !== null && s.balance !== undefined && (
            (doc && s.invoice_no && KEY(s.invoice_no) === doc) || (s.container_no && conts.has(KEY(s.container_no).toUpperCase()))
            || (s.invoice_no && toks.some((k) => KEY(s.invoice_no).includes(k)))))
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
                if (!cands.length) {
                    // LAST RESORT, exact money: one open Jarvis sale of this customer whose outstanding amount equals this payment line to the cent.
                    // Only when exactly ONE such sale exists; flagged on the receipt so she can see it was matched by amount.
                    const cname = KEY((p.CustomerRef || {}).name);
                    const byAmt = sales.filter((x) => x.balance !== null && x.balance !== undefined && (room.get(x.id) || 0) > CENT && (room.get(x.id) || 0) - amt > -0.01 && (room.get(x.id) || 0) - amt <= FEE_TOLERANCE
                        && cname && (KEY(x.customer) === cname || KEY(x.customer).includes(cname) || cname.includes(KEY(x.customer))));
                    if (byAmt.length === 1 && amt > 1) {
                        const x = byAmt[0]; const short = r2(Math.max(0, (room.get(x.id) || 0) - amt));
                        room.set(x.id, 0); covered.set(x.id, r2((covered.get(x.id) || 0) + amt + short));
                        const c = perCustomer.get(x.customer) || { allocations: [], total: 0, byAmount: false };
                        const al = { sale_id: x.id, amount: amt };
                        if (short > 0.01) { al.deduction_amount = short; al.deduction_reason = 'bank_charge'; al.deduction_note = 'probable wire fee: payment matched by amount, short by this much'; }
                        c.allocations.push(al); c.total = r2(c.total + amt); c.byAmount = true; perCustomer.set(x.customer, c);
                        continue;
                    }
                }
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
        // Money the customer sent that QuickBooks holds but applied to NO invoice (a lump payment). It is real cash; where it belongs is
        // a judgement, so it is listed, and only applied (oldest invoice first) when she asks for it.
        const appliedAmt = r2((p.Line || []).filter((l) => (l.LinkedTxn || []).length).reduce((t, l) => t + Number(l.Amount || 0), 0));
        const loose = r2(Number(p.TotalAmt || 0) - appliedAmt);
        if (loose > 0.01) unappliedCash.push({ ref, qb_payment: String(p.Id), customerQB: (p.CustomerRef || {}).name || '', amount: loose, date: String(p.TxnDate || '').slice(0, 10), pm: p.PaymentMethodRef, acct: p.DepositToAccountRef });
        for (const [customer, c] of perCustomer) {
            proposed.push({ ref: ref + ':' + KEY(customer), qb_payment: String(p.Id), customer, date: String(p.TxnDate || '').slice(0, 10), amount: c.total, mode, mode_guessed: guessed,
                bank: (mode === 'Wire' || mode === 'Zelle') ? bankOf(p.DepositToAccountRef) : null, allocations: c.allocations,
                matched_by_amount: !!c.byAmount,
                note: `Backfilled from QuickBooks payment ${p.Id}${p.PaymentRefNum ? ' (ref ' + p.PaymentRefNum + ')' : ''}${c.byAmount ? ' - matched to the invoice by exact amount' : ''}` });
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
    // A sale this plan paid down to a few dollars, on an invoice QuickBooks shows CLOSED: that residue is a wire fee, recorded as a bank-charge
    // deduction on the same receipt (so the sale closes and the cost is not lost). Larger residues are left as real balances.
    let feeDeductions = 0;
    for (const sale of sales) {
        const left = room.get(sale.id) || 0;
        if (!(left > 0.005 && left <= FEE_TOLERANCE && (covered.get(sale.id) || 0) > 0)) continue;
        const qi = (qb.invoices || []).find((i) => salesFor(i).some((x) => x.id === sale.id));
        if (!qi || Number(qi.Balance) > CENT) continue;
        for (let k = proposed.length - 1; k >= 0; k--) {
            const al = proposed[k].allocations.find((a) => a.sale_id === sale.id);
            if (!al || al.deduction_amount) continue;
            al.deduction_amount = r2(left); al.deduction_reason = 'bank_charge'; al.deduction_note = 'wire fee: QuickBooks closed this invoice for less than Jarvis shows';
            proposed[k].has_fee = true; room.set(sale.id, 0); covered.set(sale.id, r2((covered.get(sale.id) || 0) + left)); feeDeductions += 1; break;
        }
    }
    if (fifoUnapplied) {
        for (const u of unappliedCash.sort((a, b) => a.date.localeCompare(b.date))) {
            const q = KEY(u.customerQB); if (!q) continue;
            const { mode, guessed } = modeOf(u.pm);
            const per = new Map();
            let left = u.amount;
            const cands = sales.filter((s) => s.balance !== null && s.balance !== undefined && s.customer && (KEY(s.customer) === q || KEY(s.customer).includes(q) || q.includes(KEY(s.customer))))
                .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
            for (const s of cands) {
                if (left <= CENT) break;
                const free = room.get(s.id) || 0; const take = r2(Math.min(left, free)); if (take <= CENT) continue;
                room.set(s.id, r2(free - take)); left = r2(left - take); covered.set(s.id, r2((covered.get(s.id) || 0) + take));
                const c = per.get(s.customer) || { allocations: [], total: 0 }; c.allocations.push({ sale_id: s.id, amount: take }); c.total = r2(c.total + take); per.set(s.customer, c);
            }
            for (const [customer, c] of per) proposed.push({ ref: u.ref + ':U:' + KEY(customer), qb_payment: u.qb_payment, customer, date: u.date, amount: c.total, mode, mode_guessed: guessed,
                bank: (mode === 'Wire' || mode === 'Zelle') ? bankOf(u.acct) : null, allocations: c.allocations, unapplied: true,
                note: `Backfilled from QuickBooks payment ${u.qb_payment}, which QuickBooks held unapplied - applied to the oldest open invoices` });
            u.placed = r2(u.amount - left);
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
    const oldestOpen = sales.filter((x) => x.balance !== null && x.balance !== undefined && r2(x.balance - (covered.get(x.id) || 0)) > CENT)
        .map((x) => ({ invoice_no: x.invoice_no || null, container_no: x.container_no || null, date: x.date || null, open: r2(x.balance - (covered.get(x.id) || 0)) })).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    return { proposed, leftover, unmatched, unexplained, skippedDone, remaining, unappliedCash, oldestOpen,
        totals: { receipts: proposed.length, money: sum(proposed), leftover: sum(leftover), unmatched: sum(unmatched), unexplained: sum(unexplained, 'open'), alreadyImported: skippedDone.length,
            wireFees: r2(proposed.reduce((t, r) => t + r.allocations.reduce((a, x) => a + (x.deduction_amount || 0), 0), 0)), wireFeeCount: proposed.reduce((t, r) => t + r.allocations.filter((x) => x.deduction_amount).length, 0), unappliedCash: r2(unappliedCash.reduce((t, x) => t + x.amount, 0)), unappliedPlaced: r2(unappliedCash.reduce((t, x) => t + (x.placed || 0), 0)), customers: [...new Set(proposed.map((x) => x.customer))].length, modeGuessed: proposed.filter((x) => x.mode_guessed).length } };
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

// Check each proposed receipt against the BANK FEED (Plaid, helpers/bankLedger rows). Apsara, 2026-11-07: "use plaid to check against".
// A receipt is VERIFIED when a deposit of exactly that amount landed within DAYS of its date; each deposit is used once (closest
// date first), so one deposit cannot vouch for two receipts. Receipts older than the feed's history are "outside the feed", not
// "unverified". Pure; never writes.
const BANK_DAYS = 10;
function verifyWithBank(proposed, bankRows, { days = BANK_DAYS } = {}) {
    const deps = (bankRows || []).filter((r) => r && r.direction === 'in' && !r.excluded && r.date && Number(r.amount) > 0);
    const dates = (bankRows || []).map((r) => String(r.date || '')).filter(Boolean).sort();
    const from = dates[0] || null, to = dates[dates.length - 1] || null;
    const used = new Set();
    const cents = (n) => Math.round(Number(n) * 100);
    const day = (d) => Date.parse(String(d).slice(0, 10) + 'T12:00:00Z');
    const out = proposed.map((r) => ({ ...r }));
    // closest pairs first so a deposit goes to the receipt it is nearest to
    const pairs = [];
    // the deposit can be a wire fee short of the receipt (never more than it): exact matches are preferred, then the nearest date
    out.forEach((r, i) => deps.forEach((d, j) => { const diff = cents(r.amount) - cents(d.amount); if (diff >= 0 && diff <= FEE_TOLERANCE * 100) { const gap = Math.abs(day(d.date) - day(r.date)) / 864e5; if (gap <= days) pairs.push({ i, j, gap, diff }); } }));
    pairs.sort((a, b) => (a.diff - b.diff) || (a.gap - b.gap));
    const doneR = new Set();
    for (const { i, j, gap, diff } of pairs) {
        if (doneR.has(i) || used.has(j)) continue;
        doneR.add(i); used.add(j);
        out[i].bank_check = { status: 'verified', deposit_id: deps[j].id, deposit_date: String(deps[j].date).slice(0, 10), gap_days: gap, fee_short: diff ? r2(diff / 100) : 0 };
    }
    for (const r of out) if (!r.bank_check) r.bank_check = { status: (from && String(r.date) < from) ? 'outside-feed' : 'not-found' };
    const tot = (st) => out.filter((r) => r.bank_check.status === st);
    const sum = (a) => r2(a.reduce((t, x) => t + x.amount, 0));
    return { rows: out, coverage: { from, to, deposits: deps.length },
        totals: { verified: tot('verified').length, verifiedMoney: sum(tot('verified')), notFound: tot('not-found').length, notFoundMoney: sum(tot('not-found')),
            outsideFeed: tot('outside-feed').length, outsideFeedMoney: sum(tot('outside-feed')) } };
}

// "Where does the truth lie?" for ONE customer: what Jarvis invoiced, what QuickBooks recorded as paid, and what the BANK shows
// coming in from them. Three independent figures; the gap between them says which system is wrong. Pure.
function crossCheck({ sales, qbPayments, bankRows, customer, since }) {
    const bd = require('./bankDepositCheck');
    const toks = bd.specific(customer);
    const words = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
    const deps = (bankRows || []).filter((r) => r && r.direction === 'in' && !r.excluded && String(r.date || '') >= (since || '0000')
        && toks.length && toks.every((t) => words(`${r.desc} ${r.memo || ''} ${r.party || ''}`).some((w) => w === t || (t.length >= 5 && w.startsWith(t)))));
    const invoiced = r2(sales.reduce((t, x) => t + Number(x.receivable || 0), 0));
    const jarvisReceived = r2(sales.reduce((t, x) => t + Number(x.received || 0), 0));
    const qbPaid = r2((qbPayments || []).reduce((t, p) => t + Number(p.TotalAmt || 0), 0));
    const bank = r2(deps.reduce((t, r) => t + Number(r.amount || 0), 0));
    return { invoiced, jarvisReceived, qbPaid, bank, bankDeposits: deps.length, matchedBy: toks.join(' '), nameSignal: toks.length > 0 };
}

// For the sales STILL open after the plan: is there a bank deposit of exactly that amount after the invoice date that nothing above
// has used? Exact cents on a five-figure amount is strong evidence even when the bank text never names the customer. Pure.
function bankHints(openSales, bankRows, { usedDepositIds = new Set(), maxDays = 150 } = {}) {
    const cents = (n) => Math.round(Number(n) * 100);
    const day = (d) => Date.parse(String(d).slice(0, 10) + 'T12:00:00Z');
    const deps = (bankRows || []).filter((r) => r && r.direction === 'in' && !r.excluded && !r.matched && r.date && Number(r.amount) > 0 && !usedDepositIds.has(r.id));
    const taken = new Set(); const hints = [];
    for (const s of [...openSales].sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
        const d = deps.filter((x) => !taken.has(x.id) && cents(s.open) - cents(x.amount) >= 0 && cents(s.open) - cents(x.amount) <= FEE_TOLERANCE * 100 && day(x.date) >= day(s.date) - 86400000 && day(x.date) <= day(s.date) + maxDays * 864e5)
            .sort((a, b) => String(a.date).localeCompare(String(b.date)))[0];
        if (d) { taken.add(d.id); hints.push({ invoice_no: s.invoice_no, container_no: s.container_no, sale_date: s.date, open: s.open, deposit_id: d.id, deposit_date: String(d.date).slice(0, 10), desc: d.desc || '' }); }
    }
    return { hints, money: r2(hints.reduce((t, h) => t + h.open, 0)), of: openSales.length };
}

module.exports = { FEE_TOLERANCE, plan, apply, modeOf, bankOf, verifyWithBank, crossCheck, bankHints, BANK_DAYS };
