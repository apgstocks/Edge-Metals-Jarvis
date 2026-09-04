// ── helpers/reconcile.js — the bank against the books ─────────────────────
//
// Apsara, 2026-09-03: "can i link my bank account here like quickbook."
//
// The bank feed is the plumbing. THIS is the thing she is actually asking
// for: stop typing payments in twice, and — much more usefully — find out
// where the two records disagree.
//
// WHY THIS FILE EXISTS SEPARATELY FROM THE FEED
// --------------------------------------------
// Matching is the same work whether the rows arrived from Plaid or from a CSV
// she downloaded herself. Keeping it apart means the useful half survives if
// the Plaid application is refused, stalls, or is dropped later. Nothing here
// imports the Plaid client or knows one exists.
//
// TWO DIRECTIONS, AND THE SECOND ONE MATTERS MORE
// -----------------------------------------------
// Most reconciliation tools show you bank rows they could not place. That
// finds money that left the account without a record — real, but it is the
// easy half, and it is the half you would eventually notice anyway when the
// balance looked wrong.
//
// The other direction is the one that hides: a payment recorded in Jarvis
// that NEVER APPEARS ON THE BANK STATEMENT. A Zelle that was typed in but
// never actually sent. A wire entered twice. A load marked paid against a
// transfer that bounced. Nothing in this app can currently detect any of
// those, because this app is the only thing that knows they were claimed. So
// `unrecorded` and `unsettled` are both returned, and the screen shows both.
//
// NOTHING HERE WRITES
// -------------------
// No row is auto-created, no payment is auto-marked. Matching is a judgement
// about money and a wrong automatic match is worse than no match: it makes
// two records agree that never did. This returns an opinion; a person acts on
// it. If that ever changes it should be a deliberate decision with her name
// on it, not a convenience someone added.

const CENT = 0.005;
const round2 = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : null);
const num0 = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
const day = (d) => String(d || '').slice(0, 10);

// How far apart two dates may be and still be the same movement of money.
// A Zelle posts same-day; a wire or an ACH commonly lands one to three
// business days after it was initiated, and the date recorded in Jarvis is
// the day SHE paid, not the day the bank cleared it. Four days covers a
// Thursday payment clearing on Monday. Wider than that and coincidental
// same-amount matches start outnumbering real ones.
const DEFAULT_DAY_WINDOW = 4;

const daysBetween = (a, b) => {
    const x = Date.parse(day(a) + 'T00:00:00Z');
    const y = Date.parse(day(b) + 'T00:00:00Z');
    if (!isFinite(x) || !isFinite(y)) return Infinity;
    return Math.abs(x - y) / 86400000;
};

// Everything Jarvis believes left the bank, in one shape.
//
// CASH IS DELIBERATELY EXCLUDED. Notes handed over at the yard never touch
// the bank account, so including them would put every cash payment in the
// "never hit the bank" column for ever — a permanent list of false alarms is
// how a reconciliation screen gets ignored, and a screen nobody reads is
// worse than no screen. Petty cash has its own ledger for exactly this.
//
// Sale payments are excluded too: they are money coming IN, matched against
// deposits rather than withdrawals, and mixing the directions would let an
// incoming 40,000 cancel an outgoing one.
function bookedOutflows({ payments = [], expenses = [], bills = [] } = {}) {
    const rows = [];
    const billById = new Map((bills || []).map((b) => [b.id, b]));

    for (const p of payments) {
        if (!p || !p.load_id || p.is_advance) continue;
        if (p.mode === 'Cash') continue;                 // never touches the bank
        if (p.load_kind === 'sale') continue;            // money in, not out
        const amount = round2(num0(p.amount));
        if (!amount || amount <= CENT) continue;
        const bill = p.load_kind === 'trucker' ? billById.get(p.load_id) : null;
        rows.push({
            kind: p.load_kind === 'trucker' ? 'trucker' : 'load',
            id: p.id,
            ref: p.load_id,
            date: day(p.paid_on || p.created_at),
            amount,
            method: p.mode || null,
            label: p.load_kind === 'trucker'
                ? `Trucker ${bill ? bill.company : p.load_id}`
                : `Load ${p.load_id}`,
        });
    }

    for (const e of expenses) {
        if (!e) continue;
        if (e.payment_method === 'Cash') continue;       // out of the box, not the bank
        // An expense with NO recorded method is included rather than skipped.
        // It might have been cash, in which case it shows up as unsettled and
        // she can say so — but silently dropping it would hide a card payment
        // that never cleared, which is the thing this screen is for.
        const amount = round2(num0(e.amount));
        if (!amount || amount <= CENT) continue;
        rows.push({
            kind: 'expense',
            id: e.id,
            ref: e.category || null,
            date: day(e.date),
            amount,
            method: e.payment_method || null,
            label: e.description || e.category || 'Expense',
        });
    }

    return rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

// Bank rows that are money LEAVING. Plaid's convention is that a positive
// `amount` is money out of the account, which is the opposite of what most
// people assume — getting this backwards would put every deposit in the
// outflow column and match nothing. Normalised once, here, so no caller has
// to remember it.
function bankOutflows(txs = []) {
    return (txs || [])
        .filter((t) => t && !t.pending && num0(t.amount) > CENT)
        .map((t) => ({
            id: t.transaction_id || t.id,
            date: day(t.date),
            amount: round2(num0(t.amount)),
            name: t.merchant_name || t.name || '(no description)',
            account_id: t.account_id || null,
        }))
        .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

// ── the match ─────────────────────────────────────────────────────────────
// Amount to the cent, then nearest date inside the window. Deliberately NOT
// fuzzy on amount: two records that differ by a dollar are not the same
// payment, they are a discrepancy, and blurring that away is the one thing a
// reconciliation must never do.
//
// GREEDY, ONE-TO-ONE, AND ORDER-INDEPENDENT. Each side is consumed at most
// once — otherwise a single 500 bank row would "explain" three separate 500
// payments and all three would look settled. Candidates are ranked by date
// distance and then by id, so the same inputs always produce the same
// pairing regardless of the order they arrived in; without the id tiebreak,
// two equally-close candidates would match differently between runs and the
// screen would change under her while she read it.
function reconcile({ payments, expenses, bills, transactions, from, to, dayWindow } = {}) {
    const win = Number.isFinite(dayWindow) ? dayWindow : DEFAULT_DAY_WINDOW;
    const inRange = (d) => (!from || d >= from) && (!to || d <= to);

    const booked = bookedOutflows({ payments, expenses, bills }).filter((r) => inRange(r.date));
    // The bank side is NOT clipped to the same window. A payment dated the
    // 30th can clear on the 2nd, and a bank row just outside the window is
    // exactly the row that explains it — clipping both sides would invent a
    // discrepancy at every month boundary. The output only ever reports bank
    // rows it actually used, plus unmatched ones inside the window.
    const bank = bankOutflows(transactions);

    const usedBank = new Set();
    const matches = [];
    const unsettled = [];

    for (const b of booked) {
        let best = null;
        for (const t of bank) {
            if (usedBank.has(t.id)) continue;
            if (Math.abs(t.amount - b.amount) > CENT) continue;
            const gap = daysBetween(b.date, t.date);
            if (gap > win) continue;
            if (!best || gap < best.gap || (gap === best.gap && String(t.id) < String(best.t.id))) {
                best = { t, gap };
            }
        }
        if (best) {
            usedBank.add(best.t.id);
            matches.push({ booked: b, bank: best.t, day_gap: best.gap });
        } else {
            unsettled.push(b);
        }
    }

    // Bank rows nobody claimed. Clipped to the window here, because an
    // unmatched row from six months ago is not news — it is just outside what
    // she asked about.
    const unrecorded = bank.filter((t) => !usedBank.has(t.id) && inRange(t.date));

    const sum = (list, pick) => round2(list.reduce((a, x) => a + num0(pick(x)), 0)) || 0;
    return {
        from: from || null,
        to: to || null,
        day_window: win,
        matched: matches,
        // Recorded in Jarvis, never seen on the statement. THE IMPORTANT LIST.
        unsettled,
        // On the statement, not recorded anywhere in Jarvis.
        unrecorded,
        totals: {
            matched: sum(matches, (m) => m.booked.amount),
            unsettled: sum(unsettled, (x) => x.amount),
            unrecorded: sum(unrecorded, (x) => x.amount),
            booked: sum(booked, (x) => x.amount),
        },
        counts: {
            matched: matches.length,
            unsettled: unsettled.length,
            unrecorded: unrecorded.length,
            booked: booked.length,
        },
    };
}

module.exports = { reconcile, bookedOutflows, bankOutflows, DEFAULT_DAY_WINDOW };
