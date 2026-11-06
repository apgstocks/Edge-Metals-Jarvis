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

// A payment whose account nobody wrote down — every Zelle and Wire from before
// 2026-09-09, and every Cash and Cheque forever. Its own name rather than
// "Unclassified", which already means something different on this report (a
// payment METHOD that is not on the list). Two different unknowns sharing one
// label is how a report comes to be quietly misread.
const NOT_RECORDED = 'Not recorded';

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
// ── WHO THE MONEY WENT TO, OR CAME FROM ──────────────────────────────────
// Apsara, 2026-11-07: "What if i want supplier wise filter in edge yard",
// and asked which counterparty she meant: "TWO FILTERS,WHOM WE BUY,WHOM WE
// SELL".
//
// Until today a spend row was labelled "Load 1234". The report knew how much,
// by what method, out of which account and whose company — and had no idea
// WHO received it. That is why there was no supplier filter to turn on.
//
// ── THE NAMES ARE INJECTED, NEVER FETCHED ───────────────────────────────
// A name lives in a different store for every kind: the seller on a yard
// load, the buyer on an outbound load, the vendor on a bill, a trucker, a
// settlement agent. Reaching into six stores from here would make this
// module depend on most of the app, and — the part that actually matters —
// it would make `names` a thing every caller has to supply.
//
// CLAUDE.md records two separate outages caused by exactly that: a new
// requirement added to shared code, and the caller that could not satisfy it
// was the voice path, which has no form to put a field on. helpers/tools.js
// line 419 calls buildSpendReport, and ~50 test call sites pass nothing but
// payments and expenses.
//
// So `parties` is OPTIONAL and the absence of it is a supported answer. With
// no map every row reads "Not recorded", the two filters offer one value
// each, and the screen renders no chip row — the same rule the bank filter
// has always followed. Nothing that worked yesterday needs to change.
//
// Keyed `kind:ref` so one flat object covers all six kinds without this
// function knowing what any of them mean.
const partyKey = (kind, ref) => `${kind}:${ref == null ? '' : ref}`;

function collectRows({ payments, expenses, from, to, parties = null }) {
    const rows = [];
    const nameFor = (kind, ref) => {
        if (!parties) return null;
        const v = parties[partyKey(kind, ref)];
        return (v && String(v).trim()) || null;
    };

    for (const p of (payments || [])) {
        if (!p || !inRange(p.paid_on || p.created_at, from, to)) continue;
        const amount = num0(p.amount);
        if (Math.abs(amount) <= CENT) continue;

        // ── UNAPPLIED ADVANCES ARE NOT SPEND ──────────────────────────────
        // The advance feature was removed on 2026-08-29, but rows written
        // before that survive in payments.json carrying is_advance: true and
        // load_id: null. helpers/payments.js's paymentsForLoad filters them
        // out by load_id so they cannot make a load look part-paid; this
        // report was not filtering them at all, so an old advance was being
        // counted as money spent, under a row labelled just "Load".
        //
        // ── AND NEITHER IS A SETTLEMENT (2026-10-17) ──────────────────────
        // Apsara: "his seller is also a buyer ... you hand over $2,000 and
        // the $3,000 is settled". helpers/payments.js's settleAgainst writes
        // a row on the load AND one on the sale, both carrying no cash at
        // all — only the $2,000 difference actually moved, and that is
        // recorded by the ordinary payment beside it.
        //
        // Left in, the load's row would be counted as $3,000 SPENT that
        // never left the building, and the sale's as $3,000 RECEIVED that
        // never arrived. The spend report answers "what did we pay out", and
        // for that day the answer is $2,000.
        //
        // Added to this guard rather than to METHODS: labelling the mode
        // would have made the row visible and still counted it, which is the
        // right number in the wrong column — the failure this file's own
        // comments keep warning about.
        if (!p.load_id || p.is_advance || p.is_settlement) continue;

        // ── DIRECTION ─────────────────────────────────────────────────────
        // A payment against a SALE is money a buyer paid US. It lives in the
        // same file as purchase payments, with load_kind telling them apart —
        // and this report was ignoring that field entirely, so every rupee
        // received from a buyer was being added to "where the money went".
        //
        // Found 2026-09-02 when Apsara said the report's behaviour did not
        // look right. She was correct: on any yard that records sales, every
        // total here was inflated by its income.
        // ── THREE KINDS NOW, NOT TWO ──────────────────────────────────────
        // Apsara 2026-09-03 added trucker bills ("Need to incorporate this in
        // report as well"). They are paid through this same ledger with
        // load_kind: 'trucker', so they arrive here for free — but they must
        // NOT be counted as load spend. "What did we pay for metal" and "what
        // did we pay to move it" are different questions and she reads both.
        //
        // Note what happens if this is left alone: trucker payments still land
        // in the total, correctly, but under `loadTotal`, and the Loads line
        // in the report silently overstates by the haulage. Right total, wrong
        // story — the kind of wrong that survives a long time.
        const isSale = p.load_kind === 'sale';
        const isTrucker = p.load_kind === 'trucker';
        // ── FOURTH KIND: EDGE METALS BILLS ───────────────────────────────
        // Apsara 2026-09-10 asked for a pay option on bills, with one payment
        // able to cover several containers and advances held against a
        // supplier. helpers/billPayments.js writes ONE row here per real
        // transfer (load_kind:'bill', load_id = the payment's own id), so the
        // money is counted once on the day it left the bank — including an
        // advance that is not yet attached to any container.
        //
        // Labelled separately for the same reason trucker payments are: "what
        // did we pay for metal at the yard" and "what did we pay a supplier
        // for a container" are different questions, and folding the second
        // into the Loads line would overstate it with the right grand total —
        // right number, wrong story, which survives a long time.
        const isBill = p.load_kind === 'bill';
        // ── FIFTH KIND: WHAT A SALE COSTS ────────────────────────────────
        // Apsara 2026-09-10, designing the sales tabs, answered that freight
        // and commission "get settled separately". helpers/salesSettlements.js
        // writes one row here per transfer, load_kind:'sale_cost'.
        //
        // Its own line, not folded into Supplier. A supplier payment buys
        // metal; ocean freight and an agent's commission are what it costs to
        // SELL it, and a margin worked out from a Supplier line that quietly
        // contains both is wrong in the direction that looks fine.
        const isSaleCost = p.load_kind === 'sale_cost';
        // ── SIXTH KIND: EDGE METALS HAULAGE ──────────────────────────────
        // Apsara 2026-09-10 asked for a Trucking tab built from the bills,
        // with a pay option. helpers/metalsTrucking.js writes one row here per
        // transfer, load_kind 'metals_trucking'.
        //
        // NOT folded into 'trucker'. That is the Edge YARD haulier line, and
        // one figure covering both companies could never be split again.
        const isMetalsTrucking = p.load_kind === 'metals_trucking';
        rows.push({
            kind: isTrucker ? 'trucker' : isBill ? 'supplier' : isSaleCost ? 'sale_cost'
                : isMetalsTrucking ? 'metals_trucking' : 'load',
            direction: isSale ? 'in' : 'out',
            id: p.id,
            date: p.paid_on || String(p.created_at || '').slice(0, 10),
            method: METHODS.includes(p.mode) ? p.mode : UNCLASSIFIED,
            // ── WHICH ACCOUNT IT LEFT ─────────────────────────────────────
            // Apsara, 2026-09-09, asked for the report to break down by bank
            // as well as by method.
            //
            // NOT_RECORDED rather than null, and rather than being dropped: a
            // Zelle written before 2026-09-09 has no bank on it, and pretending
            // those rows do not exist would make the per-bank column total
            // disagree with the method total for no visible reason. They are a
            // named bucket, so the gap is something she can see and close.
            //
            // Cash and Cheque carry it too — they are always NOT_RECORDED,
            // which is correct: there is no account behind them.
            bank: (p.bank && String(p.bank).trim()) || NOT_RECORDED,
            // ── WHOSE MONEY PAID IT ───────────────────────────────────────
            // Apsara, 2026-09-17: "on selecting wire-it should ask me Payment
            // via Edge Yard/Edge Metals. We need to keep track of this also in
            // report".
            //
            // NOT_RECORDED for everything written before today, and for every
            // payment the form does not ask about — cash, a cheque, a sale.
            // Same rule as the bank above and for the same reason: a named
            // bucket is a gap she can see, and a row quietly assigned to Edge
            // Yard would be this file inventing a fact about money.
            paid_via: (p.paid_via && String(p.paid_via).trim()) || NOT_RECORDED,
            amount: round2(amount),
            label: `${isSale ? 'Sale' : isTrucker ? 'Trucker' : isBill ? 'Supplier'
                : isSaleCost ? 'Sale cost' : isMetalsTrucking ? 'Metals haulage' : 'Load'} ${p.load_id}`.trim(),
            ref: p.load_id,
            // WHOM WE BUY / WHOM WE SELL. A sale's counterparty is a buyer;
            // everything else here is somebody we paid. NOT_RECORDED rather
            // than null and rather than dropping the row — identical rule to
            // `bank` and `paid_via` above, and for the identical reason: a
            // named bucket is a gap she can see and close, a missing row is
            // a total that disagrees with itself for no visible reason.
            party: nameFor(isSale ? 'sale' : isTrucker ? 'trucker' : isBill ? 'supplier'
                : isSaleCost ? 'sale_cost' : isMetalsTrucking ? 'metals_trucking' : 'load',
                p.load_id) || NOT_RECORDED,
            side: isSale ? 'sold_to' : 'bought_from',
        });
    }

    for (const e of (expenses || [])) {
        if (!e || !inRange(e.date, from, to)) continue;
        const amount = num0(e.amount);
        if (Math.abs(amount) <= CENT) continue;
        rows.push({
            kind: 'expense',
            // An expense is always money out. There is no incoming expense.
            direction: 'out',
            id: e.id,
            date: e.date,
            // Anything not on the list is Unclassified, INCLUDING the legacy
            // free-text values. Deliberately not coerced — see the header.
            method: METHODS.includes(e.payment_method) ? e.payment_method : UNCLASSIFIED,
            // Expenses never had a bank field and Zelle/Wire are retired from
            // that form anyway (see helpers/expenses.js). Present and constant
            // so every row has the key — a row missing it would land in
            // `undefined` and quietly grow a column with no name.
            bank: NOT_RECORDED,
            // An expense is spent, not transferred between the two companies.
            paid_via: NOT_RECORDED,
            amount: round2(amount),
            label: e.description || e.category || 'Expense',
            ref: e.category || null,
            // An expense already carries its own counterparty —
            // helpers/expenses.js has stored `vendor` since 2026-09. No
            // lookup needed, and no inventing one out of the description:
            // a vendor guessed from free text is a name she would then
            // filter on and trust.
            party: (e.vendor && String(e.vendor).trim()) || NOT_RECORDED,
            side: 'bought_from',
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
function buildSpendReport({ payments, expenses, pettyEntries, from, to, method, bank, paidVia,
                           boughtFrom, soldTo, parties = null } = {}) {
    const columns = METHODS.concat([UNCLASSIFIED]);
    // Only a method the report actually reports in. Anything else is ignored
    // rather than returning nothing — a typo in a query string should not look
    // like "you spent nothing".
    const wanted = columns.includes(String(method || '').trim()) ? String(method).trim() : '';
    // The bank filter is NOT validated against a fixed list, unlike the method
    // — the list of banks grows whenever she types one under Others, so a
    // whitelist here would go stale the day after she adds one. An unknown
    // bank simply matches nothing, which is the honest answer to "how much
    // went out of a bank we have never used".
    const wantedBank = String(bank || '').trim();
    // ── AND BY WHOSE MONEY ───────────────────────────────────────────────
    // Apsara, 2026-09-17, asked for the breakdown AND the ability to narrow
    // the whole report to one company. Not validated against a list for the
    // same reason the bank is not: "Not recorded" is a legitimate thing to
    // filter for — it is how she finds the wires written before today and
    // decides what to do about them.
    const wantedPaidVia = String(paidVia || '').trim();
    // ── WHOM WE BUY, AND WHOM WE SELL — TWO FILTERS, NOT ONE ────────────
    // Apsara, 2026-11-07, asked which counterparty she meant and answered:
    // "TWO FILTERS,WHOM WE BUY,WHOM WE SELL".
    //
    // They are NOT one "counterparty" filter with two lists, and the reason
    // is that each belongs to a different DIRECTION of money. So each one
    // narrows its own side and leaves the other alone:
    //
    //   boughtFrom  narrows money OUT. Money received is untouched.
    //   soldTo      narrows money IN.  Money paid out is untouched.
    //
    // The alternative — one filter applied to everything — answers neither
    // question. Filtering the whole report to "Eccomelt" would empty the
    // received block whenever Eccomelt is a seller, and empty the spend
    // block whenever they are a buyer, and the same name can be both: this
    // app already has a settleAgainst path precisely because "his seller is
    // also a buyer" (2026-10-17). A screen that shows $0.00 received because
    // of a filter about purchases is a screen that lies quietly.
    //
    // Neither is validated against a list, for the reason the bank is not:
    // the names are whatever she has typed, and "Not recorded" is a
    // legitimate thing to filter FOR — it is how the gap gets closed.
    const wantedBought = String(boughtFrom || '').trim();
    const wantedSold = String(soldTo || '').trim();
    const sameName = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

    const all = collectRows({ payments, expenses, from, to, parties })
        .filter(r => !wanted || r.method === wanted)
        .filter(r => !wantedBank || String(r.bank || '').toLowerCase() === wantedBank.toLowerCase())
        .filter(r => !wantedPaidVia || String(r.paid_via || '').toLowerCase() === wantedPaidVia.toLowerCase())
        .filter(r => (r.direction === 'in' ? !wantedSold || sameName(r.party, wantedSold)
                                           : !wantedBought || sameName(r.party, wantedBought)));

    // The report answers "where did the money GO". Money received from buyers
    // is a different question and must not be added to that answer — but it is
    // not dropped either, because silently discarding rows is its own way of
    // being wrong. It is reported separately, below.
    const rows = all.filter(r => r.direction !== 'in');
    const inRows = all.filter(r => r.direction === 'in');

    const months = new Map();
    const byMethod = Object.fromEntries(columns.map((m) => [m, 0]));
    // Built from the rows rather than from a fixed list, for the same reason
    // the filter is not validated: the banks are whatever she has actually
    // used. A bank with no spend in this window does not appear, which is
    // right — an empty column invites the question "why is that zero".
    const byBank = {};
    // Whose money went out, in this window. Built from the rows like byBank,
    // so a company with no spend in the period does not appear as a zero.
    const byPaidVia = {};
    // Whom the money went to, in this window. Same construction as byBank:
    // built from the rows, so a counterparty with nothing in the period does
    // not appear as a zero.
    const byBoughtFrom = {};
    let total = 0, loadTotal = 0, expenseTotal = 0, truckerTotal = 0, supplierTotal = 0;
    let saleCostTotal = 0, metalsTruckingTotal = 0;

    for (const r of rows) {
        const m = monthOf(r.date);
        if (!months.has(m)) months.set(m, Object.fromEntries(columns.map((c) => [c, 0])));
        const bucket = months.get(m);
        bucket[r.method] = round2(bucket[r.method] + r.amount);
        byMethod[r.method] = round2(byMethod[r.method] + r.amount);
        const b = r.bank || NOT_RECORDED;
        byBank[b] = round2((byBank[b] || 0) + r.amount);
        const v = r.paid_via || NOT_RECORDED;
        byPaidVia[v] = round2((byPaidVia[v] || 0) + r.amount);
        const who = r.party || NOT_RECORDED;
        byBoughtFrom[who] = round2((byBoughtFrom[who] || 0) + r.amount);
        total = round2(total + r.amount);
        // An explicit three-way split, not an if/else pair. The previous shape
        // was `if load ... else expense`, which would have swept the new
        // trucker rows into expenses — a default bucket that silently absorbs
        // anything unrecognised is how a category goes missing without anyone
        // seeing a wrong number.
        if (r.kind === 'load') loadTotal = round2(loadTotal + r.amount);
        else if (r.kind === 'trucker') truckerTotal = round2(truckerTotal + r.amount);
        // ── NAMED, NOT LEFT TO THE else ──────────────────────────────────
        // The else below is expenses. A new kind that is not listed here does
        // not fail loudly — it is quietly added to "what we spent on
        // expenses", which is a wrong story with a right grand total. That is
        // precisely how supplier payments would have landed if this branch
        // had been left out.
        else if (r.kind === 'supplier') supplierTotal = round2(supplierTotal + r.amount);
        else if (r.kind === 'sale_cost') saleCostTotal = round2(saleCostTotal + r.amount);
        else if (r.kind === 'metals_trucking') metalsTruckingTotal = round2(metalsTruckingTotal + r.amount);
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

    // Whom we sold to, over the received rows — the money-IN mirror of
    // byBoughtFrom, and kept separate for the same reason the received total
    // is: "paid out X" and "took in Y" are two facts, not one.
    const bySoldTo = {};
    for (const r of inRows) {
        const who = r.party || NOT_RECORDED;
        bySoldTo[who] = round2((bySoldTo[who] || 0) + r.amount);
    }

    // The chip lists. Built over the WHOLE store with no window and no
    // filter, exactly as bankColumns is, so choosing a name never removes
    // that name from the list she chose it from — the bug where a filter
    // cannot be undone because the control that set it has vanished.
    // ── ONE UNFILTERED PASS, NOT FOUR ───────────────────────────────────
    // Every chip list is built over the WHOLE store with no window and no
    // filter, so that choosing a value never removes it from the list she
    // chose it from. That was already true of bankColumns and
    // paidViaColumns — but each of them called collectRows AGAIN, so a
    // report did three full passes over payments and expenses, and the two
    // older calls passed no `parties`, which meant those rows were built
    // with every counterparty blank for no reason.
    //
    // Harmless in production, since nothing read `party` off those rows.
    // Found because a mutation that made a missing name throw died in
    // bankColumns rather than anywhere the names are used — the mutation
    // pointing at the real shape of the code, which is what it is for.
    const everything = collectRows({ payments, expenses, from: null, to: null, parties });
    const sortGapLast = (a, b) => (a === NOT_RECORDED) - (b === NOT_RECORDED) || a.localeCompare(b);
    const namesOf = (dir) => [...new Set(everything
        .filter((r) => (dir === 'in' ? r.direction === 'in' : r.direction !== 'in'))
        .map((r) => r.party || NOT_RECORDED))]
        .sort(sortGapLast);

    return {
        from: from || null,
        to: to || null,
        // Echoed back so the client shows the active button from the SERVER's
        // answer rather than from what it thinks it asked for.
        method: wanted || null,
        // Echoed for the same reason, and NOT normalised to a canonical
        // spelling: if she filtered on something that matched nothing, showing
        // her what she actually asked for is what makes the empty report make
        // sense.
        bank: wantedBank || null,
        columns,
        // Every bank that appears in the payments at all, so the filter can
        // be built even when the current window has no spend from one of them.
        // Sorted, with "Not recorded" pushed last — it is a gap, not a bank,
        // and it should not sit at the top of her list.
        bankColumns: [...new Set(everything.map((r) => r.bank || NOT_RECORDED))].sort(sortGapLast),
        // The companies to build the filter from — every value that appears in
        // the payments at all, so "Not recorded" is selectable even in a
        // window where every row has one. Same sort as the banks: the gap
        // goes last, because it is a gap and not a company.
        paidViaColumns: [...new Set(everything.map((r) => r.paid_via || NOT_RECORDED))].sort(sortGapLast),
        months: monthRows,
        byMethod,
        // What left each account in this window. Only banks with spend appear.
        byBank,
        // And whose money it was. Apsara, 2026-09-17.
        byPaidVia,
        // ── WHOM WE BUY, WHOM WE SELL. Apsara, 2026-11-07. ──────────────
        // byBoughtFrom adds up to `total` exactly, the same promise byBank
        // and byPaidVia make, and for the same reason: a breakdown that
        // omits what it cannot name disagrees with its own total.
        byBoughtFrom,
        bySoldTo,
        // Echoed back like `bank` and `paid_via`, NOT normalised — if she
        // filtered on a name that matches nothing, showing her what she
        // actually asked for is what makes the empty report make sense.
        boughtFrom: wantedBought || null,
        soldTo: wantedSold || null,
        // Every counterparty that appears ANYWHERE, so the chips can be
        // built even when this window has nothing from one of them. Same
        // sort as the banks: the gap goes last, because it is a gap and not
        // a name.
        boughtFromColumns: namesOf('out'),
        soldToColumns: namesOf('in'),
        total,
        loadTotal,
        expenseTotal,
        // Haulage, its own line. Apsara 2026-09-03. The three add up to
        // `total` exactly — asserted in tests/spend-report.js, because a split
        // that does not reconcile with its own total is a report that invites
        // the reader to pick which number to believe.
        truckerTotal,
        supplierTotal,
        saleCostTotal,
        metalsTruckingTotal,
        count: rows.length,
        cash,
        rows,                      // the drill-down, already sorted newest first
        // ── money IN, kept apart ──────────────────────────────────────────
        // Payments against SALES. Shown beside the spend rather than mixed
        // into it, so "we paid out 12,000 and took in 40,000" is two facts
        // instead of one wrong one.
        received: {
            total: round2(inRows.reduce((a, r) => a + r.amount, 0)) || 0,
            count: inRows.length,
            byMethod: Object.fromEntries(columns.map((m) => [m,
                round2(inRows.filter(r => r.method === m).reduce((a, r) => a + r.amount, 0)) || 0])),
            rows: inRows,
        },
    };
}

module.exports = { buildSpendReport, collectRows, METHODS, UNCLASSIFIED, NOT_RECORDED };
