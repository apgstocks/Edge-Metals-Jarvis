// ── helpers/supplierAccount.js — one supplier's running account ──────────
// Apsara, 2026-09-11: "i want to maintain per supplier basis... so every
// payment recorded for a supplier should be made an entry here for eg: if i
// do wire for a container AAA it should be recorded as Wire for [container]
// next amount (credit column), bill amount(debit column) then balance. it
// should be a running total. in case of advance, debit col should be blank
// while credit should contain amount".
//
// Asked whether one row carries both figures, she chose ONE ROW PER EVENT.
// So:
//
//   a bill raised       → DEBIT  is the bill, credit blank      (she owes it)
//   a payment or advance→ CREDIT is the money, debit blank      (she paid it)
//   balance             → running (debits − credits) = still owed
//
// Her convention, not the accountant's. In double-entry a purchase CREDITS
// the supplier and a payment DEBITS them; hers is the plain-language reading
// where debit is what went on the account and credit is what came off it.
// Written down here because the two are exact opposites and anyone arriving
// from a bookkeeping background will assume the other one.
//
// ── DERIVED, LIKE helpers/margin.js. NO NEW STORE ───────────────────────
// Every figure already exists: helpers/bills.js holds what a container cost
// and who supplied it, helpers/billPayments.js holds every payment and
// advance with the supplier on it. A statement table would be a second copy
// of both, free to drift, and this codebase has paid for that before. This
// file adds no arithmetic beyond the subtraction and the running sum.
//
// ── THE TRAP: AN APPLIED ADVANCE IS NOT A SECOND PAYMENT ────────────────
// helpers/billPayments.js says it plainly at applyAdvance: "It adds an
// allocation to a payment that already happened. No second ledger row,
// because the money already left the bank." So this file credits a payment
// ONCE, on its own date, from the payment record — never from its
// allocations. Walking allocations instead would credit an advance again
// every time a slice of it was applied to a container, and the supplier would
// appear paid twice over with every individual row looking ordinary.

const round2 = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : null);

const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(/[$,\s]/g, ''));
    return isFinite(n) ? n : null;
};

const sameSupplier = (a, b) =>
    String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

// ── WHAT A PAYMENT ROW SAYS ─────────────────────────────────────────────
// Her own wording: "Wire for [container]". One transfer can settle several
// containers, so several are named rather than the first one silently
// standing for all of them.
function describePayment(pay, billsById) {
    const mode = pay.mode || 'Payment';
    const containers = (pay.allocations || [])
        .map((a) => {
            const b = billsById.get(a.bill_id);
            return b ? (String(b.container_no || '').trim() || String(b.invoice_no || '').trim()) : '';
        })
        .filter(Boolean);
    const seen = [...new Set(containers)];

    if (!seen.length) {
        // An advance is money against the supplier and not yet against any
        // container. Named as one so a credit with nothing beside it reads as
        // deliberate rather than as a row missing its container.
        return pay.kind === 'advance' ? `${mode} advance` : `${mode} — not yet against a container`;
    }
    if (seen.length <= 3) return `${mode} for ${seen.join(', ')}`;
    return `${mode} for ${seen.slice(0, 2).join(', ')} +${seen.length - 2} more`;
}

function describeBill(bill) {
    const container = String(bill.container_no || '').trim();
    const inv = String(bill.invoice_no || '').trim();
    if (container && inv) return `Bill ${inv} — ${container}`;
    if (container) return `Bill — ${container}`;
    if (inv) return `Bill ${inv}`;
    return 'Bill';
}

// ── ORDER, AND WHY IT IS PINNED THIS HARD ───────────────────────────────
// A running balance is only meaningful if the rows are in a fixed order, and
// a bill and a payment dated the same day are common. Sorting by date alone
// leaves those two in whatever order the stores happened to yield, so the
// same account renders two different balance columns on two loads — with
// the same closing figure, which is what makes it hard to notice.
//
// So: date, then bills before payments on that date (the goods arrive and are
// then paid for), then created_at, then id. The last two are only
// tie-breakers; the point is that there is always one.
function sortKey(row) {
    return [row.iso || '', row.kind === 'bill' ? '0' : '1', row.created_at || '', row.id || ''];
}

// ── THE NET WEIGHT AND THE PRICE THAT EXPLAINS THE DEBIT ────────────────
// Apsara, 2026-09-11: "before credit/debit, there should be a field called
// net weight and price".
//
// Three things make this more than reading two fields:
//
// 1. THE WEIGHT IS OFTEN NOT IN net_lb. Since the container weighing group
//    came off the bill form this morning, a bill's weight comes from its
//    LINES, and compute() only fills net_lb when a line carries a weighbridge
//    ticket. A line with a plain typed weight leaves net_lb null and the
//    figure in items_weight. Reading net_lb alone would leave this column
//    blank on most new bills — found by this file's own test.
//
// 2. THE UNIT IS THE PRICE'S UNIT. Her $10 rule (bills.PER_LB_CEILING) makes
//    a price under $10 per POUND and $10-or-over per METRIC TON. Show 51,000
//    lb beside $700/MT and the row claims a figure 2204 times off the debit
//    next to it, with both numbers individually correct.
//
// 3. SEVERAL GRADES OFTEN MEANS SEVERAL PRICES, and then no single price is
//    true of the row. Blending them would be the exact shortcut bills.js
//    warns against — "one blended price... makes a container look profitable
//    while one grade inside it loses money". So the price is blank and
//    price_mixed says why. Reported, never invented.
function weightAndPrice(bill, computed) {
    const bills = require('./bills');
    const items = computed.items || [];

    // A bill-level price wins: she typed it, and it is the whole bill's rate.
    let price = num(bill.supplier_price);
    let unit = computed.price_unit || null;
    let mixed = false;

    if (price === null && items.length) {
        const priced = items.filter((it) => it.price !== null && it.price !== undefined);
        const distinct = [...new Set(priced.map((it) => it.price))];
        if (distinct.length === 1) {
            price = distinct[0];
            unit = priced[0].price_unit || unit;
        } else if (distinct.length > 1) {
            mixed = true;
            const units = [...new Set(priced.map((it) => it.price_unit).filter(Boolean))];
            unit = units.length === 1 ? units[0] : unit;
        }
    }
    if (unit !== 'mt') unit = 'lb';

    // net_lb/net_mt when a ticket produced them, the lines' own total
    // otherwise. See note 1 above.
    const lb = num(computed.net_lb) !== null ? num(computed.net_lb) : num(computed.items_weight);
    const weight = lb === null ? null
        : (unit === 'mt' ? Math.round((lb / bills.LB_PER_MT) * 1000) / 1000 : lb);

    return { weight, weight_unit: weight === null ? null : unit, price, price_mixed: mixed };
}

function rows(supplier, { bills: billsMod = null, billPayments: bpMod = null } = {}) {
    const bills = billsMod || require('./bills');
    const billPayments = bpMod || require('./billPayments');
    const who = String(supplier || '').trim();
    if (!who) return [];

    const all = bills.list();
    const billsById = new Map(all.map((b) => [b.id, b]));
    const out = [];

    for (const b of all) {
        if (!sameSupplier(b.supplier, who)) continue;
        const computed = bills.compute(b);
        // The bill AMOUNT, not net_payable. Trucking is deducted from what
        // the supplier is owed on the bill row, but this account is between
        // her and the SUPPLIER, and the haulier is paid separately through
        // helpers/metalsTrucking.js. Putting the net here would understate
        // what she owes the supplier by the haulage, every time.
        const debit = round2(num(computed.amount));
        // ── NET WEIGHT AND PRICE, BEFORE THE MONEY ───────────────────────
        // Apsara, 2026-09-11: "before credit/debit, there should be a field
        // called net weight and price".
        //
        // THE UNIT IS THE PRICE'S UNIT, and that is not fussiness. Her $10
        // rule (helpers/bills.js PER_LB_CEILING) means a price under $10 is
        // per POUND and $10 or over is per METRIC TON, so a bill priced at
        // $700/MT beside a weight of 51,000 lb would sit in a row where
        // weight x price is off by a factor of 2204. The two columns exist so
        // she can see the debit was arrived at honestly; in mismatched units
        // they would do the opposite.
        const { weight, weight_unit, price, price_mixed } = weightAndPrice(b, computed);
        out.push({
            id: b.id, kind: 'bill',
            date: b.date || null,
            iso: bills.sortableDate(b.date) || '',
            what: describeBill(b),
            container_no: b.container_no || null,
            booking_no: b.booking_no || null,
            weight,
            weight_unit,
            price,
            // Non-null means the lines were priced at different rates and no
            // single price is true of the row. See weightAndPrice.
            price_mixed: price_mixed || false,
            debit: debit === null ? null : debit,
            credit: null,
            created_at: b.created_at || null,
        });
    }

    for (const p of billPayments.list()) {
        if (!sameSupplier(p.supplier, who)) continue;
        out.push({
            id: p.id, kind: p.kind === 'advance' ? 'advance' : 'payment',
            date: p.date || null,
            iso: bills.sortableDate(p.date) || '',
            what: describePayment(p, billsById),
            container_no: null,
            booking_no: null,
            // A wire has no weight and no price — it is money, not metal.
            // Null rather than 0: a zero in a weight column reads as a
            // container that weighed nothing.
            weight: null,
            weight_unit: null,
            price: null,
            // Her rule, verbatim: "in case of advance, debit col should be
            // blank while credit should contain amount". Debit is null for
            // EVERY credit row, not only advances — one row per event.
            debit: null,
            credit: round2(num(p.amount)),
            mode: p.mode || null,
            bank: p.bank || null,
            ref: p.ref || null,
            created_at: p.created_at || null,
        });
    }

    out.sort((x, y) => {
        const a = sortKey(x), b = sortKey(y);
        for (let i = 0; i < a.length; i++) {
            if (a[i] < b[i]) return -1;
            if (a[i] > b[i]) return 1;
        }
        return 0;
    });

    let running = 0;
    for (const r of out) {
        running = round2(running + (r.debit || 0) - (r.credit || 0));
        r.balance = running;
    }
    return out;
}

// ── A FILTERED STATEMENT STILL HAS TO START FROM SOMEWHERE ──────────────
// Showing only September and restarting the balance at zero states that she
// owed nothing on 1 September. `opening` is what was outstanding before the
// window, and the running column continues from it — the difference between
// a statement and a list of rows that happen to be in a date range.
function statement(supplier, q = {}) {
    const bills = require('./bills');
    const all = rows(supplier);
    const from = String(q.from || '').trim();
    const to = String(q.to || '').trim();
    const fromIso = from ? (bills.sortableDate(from) || from) : '';
    const toIso = to ? (bills.sortableDate(to) || to) : '';

    if (!fromIso && !toIso) {
        return { supplier, opening: 0, rows: all, ...totals(all, 0) };
    }

    const before = all.filter((r) => fromIso && r.iso && r.iso < fromIso);
    const opening = round2(before.reduce((s, r) => s + (r.debit || 0) - (r.credit || 0), 0)) || 0;
    const win = all.filter((r) => {
        if (fromIso && (!r.iso || r.iso < fromIso)) return false;
        if (toIso && (!r.iso || r.iso > toIso)) return false;
        return true;
    });

    let running = opening;
    const shown = win.map((r) => {
        running = round2(running + (r.debit || 0) - (r.credit || 0));
        return { ...r, balance: running };
    });
    return { supplier, opening, rows: shown, ...totals(shown, opening) };
}

function totals(list, opening = 0) {
    const debit = round2((list || []).reduce((s, r) => s + (r.debit || 0), 0)) || 0;
    const credit = round2((list || []).reduce((s, r) => s + (r.credit || 0), 0)) || 0;
    return {
        debit_total: debit,
        credit_total: credit,
        // Read off the last row rather than recomputed, so the figure at the
        // bottom of the column and the figure in the summary can never be two
        // different numbers.
        closing: list && list.length ? list[list.length - 1].balance : round2(opening) || 0,
    };
}

// Every supplier that has either a bill or a payment, so the picker offers
// somebody she has actually traded with rather than a free-text box.
function suppliers() {
    const bills = require('./bills');
    const billPayments = require('./billPayments');
    const seen = new Map();                       // normalised -> her spelling
    const add = (name) => {
        const s = String(name || '').trim();
        if (!s) return;
        if (!seen.has(s.toLowerCase())) seen.set(s.toLowerCase(), s);
    };
    for (const b of bills.list()) add(b.supplier);
    for (const p of billPayments.list()) add(p.supplier);
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

// One line per supplier for the index: what they are owed right now.
function overview() {
    return suppliers().map((s) => {
        const r = rows(s);
        return {
            supplier: s,
            rows: r.length,
            ...totals(r, 0),
        };
    }).sort((a, b) => (b.closing || 0) - (a.closing || 0));
}

// Bills carrying no supplier belong to no account and would otherwise simply
// not appear anywhere on this page. Surfaced so an unassigned bill is
// something she can go and fix.
function unassigned() {
    const bills = require('./bills');
    return bills.list()
        .filter((b) => !String(b.supplier || '').trim())
        .map((b) => ({ id: b.id, date: b.date || null, container_no: b.container_no || null }));
}

module.exports = {
    rows, statement, totals, suppliers, overview, unassigned,
    describeBill, describePayment, sameSupplier,
};
