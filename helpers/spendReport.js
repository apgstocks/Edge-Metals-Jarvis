// ── helpers/spendReport.js — where the money went ─────────────────────────
//
// Apsara, 2026-09-02: "A report needs to be there.. where i can track the
// monthly spent of cash/zelle/wire. date wise filter can also be there like
// quickbook."
//
// TWO SOURCES, ONE VOCABULARY
// ---------------------------
// Money leaves this business two ways: paying a seller for a load
// (helpers/payments.js) and paying for something else (helpers/expenses.js).
// A report that showed one and not the other would be answering a narrower
// question than the one asked, and the load payments are the larger numbers.
//
// Both sides now name their method from the same list — Cash, Zelle, Wire,
// Cheque, plus Card and Other on expenses — so "spent by Zelle in August"
// means one thing across the whole report rather than two.
//
// COMPUTED, NEVER STORED
// ----------------------
// Every figure here is derived from the underlying rows on each request. There
// is no cached total to go stale, no rebuild step to forget, and deleting a
// payment is reflected on the very next call. Reports that store their own
// totals are reports that quietly disagree with the ledger they came from.
//
// UNCLASSIFIED IS ITS OWN BUCKET
// ------------------------------
// Expenses recorded before the method became a fixed list hold free text that
// matches nothing. They are counted in the TOTAL — the money was really spent
// — but shown under "Unclassified" rather than being guessed into a column.
// A report that quietly files "cash app" under Cash is worse than one that
// admits it does not know.

const CENT = 0.005;
const round2 = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : null);
const num0 = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };

// The columns the report reports in. Order is deliberate: the three she named
// first, then the rest.
const METHODS = ['Cash', 'Zelle', 'Wire', 'Cheque', 'Card', 'Other'];
const UNCLASSIFIED = 'Unclassified';

const monthOf = (d) => String(d || '').slice(0, 7);      // YYYY-MM
const inRange = (d, from, to) => {
    const s = String(d || '');
    if (!s) return false;
    if (from && s < from) return false;
    if (to && s > to) return false;
    return true;
};

// One row shape for both sources, so everything downstream is a single sum.
// `kind` keeps them distinguishable for the drill-down and for the split
// between "paid for loads" and "spent on expenses".
function collectRows({ payments, expenses, from, to }) {
    const rows = [];

    for (const p of (payments || [])) {
        if (!p || !inRange(p.paid_on || p.created_at, from, to)) continue;
        const amount = num0(p.amount);
        if (Math.abs(amount) <= CENT) continue;
        rows.push({
            kind: 'load',
            id: p.id,
            date: p.paid_on || String(p.created_at || '').slice(0, 10),
            method: METHODS.includes(p.mode) ? p.mode : UNCLASSIFIED,
            amount: round2(amount),
            label: `Load ${p.load_id || ''}`.trim(),
            ref: p.load_id || null,
        });
    }

    for (const e of (expenses || [])) {
        if (!e || !inRange(e.date, from, to)) continue;
        const amount = num0(e.amount);
        if (Math.abs(amount) <= CENT) continue;
        rows.push({
            kind: 'expense',
            id: e.id,
            date: e.date,
            // Anything not on the list is Unclassified, INCLUDING the legacy
            // free-text values. Deliberately not coerced — see the header.
            method: METHODS.includes(e.payment_method) ? e.payment_method : UNCLASSIFIED,
            amount: round2(amount),
            label: e.description || e.category || 'Expense',
            ref: e.category || null,
        });
    }

    rows.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.id).localeCompare(String(a.id)));
    return rows;
}

// month -> { method -> amount }, plus per-month and per-method totals.
// The shape a table renders from directly, so no client has to pivot it and
// get a different answer.
// `method` narrows the WHOLE report to one payment method — "just Zelle",
// "just Cash" — per Apsara 2026-09-02: "what if i want to see report wherever
// just zelle is used/wire/just cash. mimic quickbook report workflow."
//
// QuickBooks narrows a report by a column and every figure follows. So this
// filters the ROWS and computes everything from what is left: the totals, the
// month table, the load/expense split all mean "of this method". A version
// that hid rows but kept the old totals would put a number at the bottom that
// the rows above do not add up to — the one thing a report must never do.
//
// The COLUMNS still list every method, so the table keeps its shape and it is
// obvious the others are empty by filter rather than by accident.
function buildSpendReport({ payments, expenses, pettyEntries, from, to, method } = {}) {
    const columns = METHODS.concat([UNCLASSIFIED]);
    // Only a method the report actually reports in. Anything else is ignored
    // rather than returning nothing — a typo in a query string should not look
    // like "you spent nothing".
    const wanted = columns.includes(String(method || '').trim()) ? String(method).trim() : '';
    const rows = collectRows({ payments, expenses, from, to })
        .filter(r => !wanted || r.method === wanted);

    const months = new Map();
    const byMethod = Object.fromEntries(columns.map((m) => [m, 0]));
    let total = 0, loadTotal = 0, expenseTotal = 0;

    for (const r of rows) {
        const m = monthOf(r.date);
        if (!months.has(m)) months.set(m, Object.fromEntries(columns.map((c) => [c, 0])));
        const bucket = months.get(m);
        bucket[r.method] = round2(bucket[r.method] + r.amount);
        byMethod[r.method] = round2(byMethod[r.method] + r.amount);
        total = round2(total + r.amount);
        if (r.kind === 'load') loadTotal = round2(loadTotal + r.amount);
        else expenseTotal = round2(expenseTotal + r.amount);
    }

    // Newest month first, matching every other list in this app.
    const monthRows = Array.from(months.keys()).sort((a, b) => b.localeCompare(a)).map((month) => {
        const b = months.get(month);
        return { month, ...b, total: round2(columns.reduce((a, c) => a + b[c], 0)) };
    });

    // ── the cash box, reconciled ──────────────────────────────────────────
    // Her choice: "money out, plus cash in". Shown in the same window as the
    // spend so the box can be checked against the drawer without leaving the
    // screen: it opened with X, took in Y, paid out Z, so it should hold W.
    //
    // `opening` is everything BEFORE the window, so the four numbers actually
    // add up. A report that showed movement without an opening balance would
    // leave "should hold" unanswerable, which is the only question the cash
    // box is really asked.
    // ── the cash box, under a method filter ───────────────────────────────
    // Petty cash only ever holds cash, so it is meaningless beside a Zelle or
    // Wire report — showing it there invites reading a cash balance as though
    // it belonged to those figures. Under "Cash" or "All" it is as relevant as
    // before.
    const cashRelevant = !wanted || wanted === 'Cash';
    const entries = (cashRelevant && Array.isArray(pettyEntries)) ? pettyEntries : [];
    const before = entries.filter((e) => e && e.date && from && String(e.date) < from);
    const within = entries.filter((e) => e && inRange(e.date, from, to));
    const sum = (list, pick) => round2(list.reduce((a, e) => {
        const v = num0(e.amount);
        return a + (pick(v) ? v : 0);
    }, 0)) || 0;

    const cash = {
        opening: from ? (round2(before.reduce((a, e) => a + num0(e.amount), 0)) || 0) : 0,
        in: sum(within, (v) => v > 0),
        out: Math.abs(sum(within, (v) => v < 0)),
        // Closing is the running balance at the end of the window — computed
        // from the rows, not from opening+in-out, so an arithmetic slip in
        // either would show up as the two disagreeing rather than being hidden.
        closing: round2(entries.filter((e) => e && (!to || String(e.date) <= to))
            .reduce((a, e) => a + num0(e.amount), 0)) || 0,
    };

    return {
        from: from || null,
        to: to || null,
        // Echoed back so the client shows the active button from the SERVER's
        // answer rather than from what it thinks it asked for.
        method: wanted || null,
        columns,
        months: monthRows,
        byMethod,
        total,
        loadTotal,
        expenseTotal,
        count: rows.length,
        cash,
        rows,                      // the drill-down, already sorted newest first
    };
}

module.exports = { buildSpendReport, collectRows, METHODS, UNCLASSIFIED };
