// ── helpers/yardBrief.js — a factual snapshot of the yard, for the helper bot ─
//
// Per Apsara 2026-08-28: a helper bot that knows Edge Yard and can answer
// questions about the data.
//
// THE WHOLE DESIGN RESTS ON ONE DECISION: every number in here is computed in
// JavaScript, and the language model is only allowed to READ them. It is never
// asked to add up loads, work out a balance, or total a weight.
//
// That is not caution for its own sake. A model asked to sum forty amounts
// will produce a plausible, confidently-worded, slightly wrong figure — and on
// this data a slightly wrong figure is a wrong number about money, delivered
// in a tone that invites trust. The arithmetic already exists and is already
// tested (helpers/loads.js, helpers/stock.js, helpers/payments.js), so the bot
// reuses it rather than re-deriving it from prose. The model's job is to pick
// the right fact out of this brief and phrase it, nothing more.
//
// It is also why the brief is AGGREGATED rather than a dump of every record:
// a smaller, pre-computed brief is both cheaper and harder to get wrong than
// asking a model to hold four hundred loads in its head.

const { loadLoads } = require('./loads');
const { loadOutboundLoads } = require('./outboundLoads');
const { paymentSummary, listPayments } = require('./payments');
const { stockReport } = require('./stock');

const round2 = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : null);

// Money goes into the brief as a STRING fixed at two decimals.
//
// Not cosmetic. A JSON number of 9052 comes back out of the model as "$9052.0"
// — it echoes the literal it was given, and JSON has no way to carry "this is
// 9052.00". Apsara has asked twice for amounts at two decimals, and the fix
// belongs here rather than in a prompt instruction the model may or may not
// follow: hand it the exact characters to repeat and there is nothing left to
// get wrong. It also reinforces the main rule — a string is plainly not
// something to do arithmetic on.
const money = (n) => {
    const r = round2(n);
    return r == null ? null : r.toFixed(2);
};
const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };

function ymd(d) { return String(d || '').slice(0, 10); }

function daysAgo(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
}

// Per-counterparty rollup. This is what most real questions are actually
// about — "how much do we owe Acme", "what have we bought from them" — and
// answering those from a pre-computed row is the difference between a right
// answer and a confident guess.
function bySeller(loads) {
    const m = new Map();
    for (const l of loads) {
        const key = String(l.seller || 'Unknown').trim() || 'Unknown';
        if (!m.has(key)) m.set(key, { seller: key, loads: 0, net_weight: 0, amount: 0, paid: 0, pending: 0, last_date: null, last_paid_on: null, payments: 0 });
        const row = m.get(key);
        row.loads += 1;
        row.net_weight += num(l.net_weight);
        row.amount += num(l.amount);
        const p = paymentSummary(l.id, l.amount);
        row.paid += num(p.paid);
        row.pending += num(p.pending);
        if (!row.last_date || ymd(l.date) > row.last_date) row.last_date = ymd(l.date);
        // WHEN we last paid them, per Apsara 2026-08-29 — asked "when did we
        // pay a seller" and the bot correctly said it did not have that,
        // because the brief carried only a COUNT of payments and no dates at
        // all. It was answering honestly about a gap in what it was given.
        for (const pay of (p.payments || [])) {
            row.payments += 1;
            const on = ymd(pay.paid_on);
            if (on && (!row.last_paid_on || on > row.last_paid_on)) row.last_paid_on = on;
        }
    }
    return [...m.values()]
        // Sorted on the numeric value BEFORE the money fields become strings,
        // otherwise "9052.00" sorts lexically against "980.00" and the biggest
        // seller stops being first.
        .sort((a, b) => b.amount - a.amount)
        .map((r) => ({ ...r, net_weight: round2(r.net_weight), amount: money(r.amount), paid: money(r.paid), pending: money(r.pending) }));
}

function summarise(loads) {
    const amount = loads.reduce((a, l) => a + num(l.amount), 0);
    const netW = loads.reduce((a, l) => a + num(l.net_weight), 0);
    return {
        count: loads.length,
        net_weight: round2(netW),
        amount: money(amount),
        // AVERAGES ARE PRE-COMPUTED, added 2026-08-29.
        //
        // The model is now allowed to calculate (Apsara: "don't restrict AI"),
        // and the very first thing it computed unprompted was wrong: asked for
        // the average per load it reported a total of 11,281.00 against a true
        // 12,446.50, and an average of 5,657.50 which does not even divide from
        // its own total. Fluent, confident, wrong — about money.
        //
        // The restriction stays lifted, because a bot that refuses is worth
        // less than one that occasionally needs checking. But every figure
        // computed HERE is one it never has to derive, so the common questions
        // land on exact arithmetic this codebase did. That is the cheapest way
        // to make an unrestricted model mostly right.
        average_amount_per_load: loads.length ? money(amount / loads.length) : null,
        average_net_weight_per_load: loads.length ? round2(netW / loads.length) : null,
    };
}

// Builds the brief. `days` bounds the "recent" window; the totals below are
// all-time so a question about the whole business is still answerable.
function buildYardBrief(opts = {}) {
    const days = Number(opts.days) || 30;
    const since = daysAgo(days);
    const today = new Date().toISOString().slice(0, 10);

    const loads = loadLoads();
    const sales = loadOutboundLoads();
    const recent = loads.filter((l) => ymd(l.date) >= since);
    const recentSales = sales.filter((l) => ymd(l.date) >= since);

    // Outstanding money, which is the question most worth getting right.
    const outstanding = [];
    for (const l of loads) {
        const p = paymentSummary(l.id, l.amount);
        if (p.status === 'partial' || (p.status === 'unpaid' && num(l.amount) > 0)) {
            outstanding.push({
                load_id: l.id, date: ymd(l.date), seller: l.seller || null,
                total: money(l.amount), paid: money(p.paid), pending: money(p.pending), status: p.status,
            });
        }
    }
    // num() on the formatted string, so the biggest debt still leads. Sorting
    // "9052.00" against "980.00" as text would put the smaller one first.
    outstanding.sort((a, b) => num(b.pending) - num(a.pending));

    let stock = [];
    try {
        const s = stockReport(loads, sales);
        stock = Array.isArray(s) ? s : (s && s.rows) || [];
    } catch (e) { stock = []; }

    return {
        generated_at: new Date().toISOString(),
        today,
        window_days: days,
        // Read by the model, not by any screen. Points it at the figures that
        // were computed in code so it prefers them over deriving its own.
        accuracy_note: 'Every total, average and balance in this data was calculated in code and is exact. '
            + 'Use these figures directly wherever they answer the question. Only work something out yourself '
            + 'when nothing here covers it, and say which rows you used when you do.',
        business: {
            name: 'Edge Trading',
            note: 'Edge Trading BUYS scrap from sellers (purchases/loads) and SELLS to buyers (sales/outbound loads). Weights are in lb unless a load says otherwise.',
        },
        totals_all_time: {
            purchases: summarise(loads),
            sales: summarise(sales),
        },
        [`totals_last_${days}_days`]: {
            purchases: summarise(recent),
            sales: summarise(recentSales),
        },
        // Capped so the brief stays small. The aggregates above already answer
        // "how much / how many"; this list is for "which ones".
        recent_loads: recent
            .slice()
            .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
            .slice(0, 40)
            .map((l) => ({
                id: l.id, load_number: l.load_number ?? null, date: ymd(l.date), seller: l.seller || null,
                net_weight: round2(l.net_weight), amount: money(l.amount),
                items: (l.items || []).map((it) => it.description).filter(Boolean),
                payment_status: paymentSummary(l.id, l.amount).status,
            })),
        recent_sales: recentSales
            .slice()
            .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
            .slice(0, 25)
            .map((l) => ({
                id: l.id, date: ymd(l.date), buyer: l.buyer || null,
                net_weight: round2(l.net_weight), amount: money(l.amount),
                items: (l.items || []).map((it) => it.description).filter(Boolean),
            })),
        by_seller: bySeller(loads).slice(0, 40),
        stock_on_hand: stock,
        money_outstanding: {
            count: outstanding.length,
            total_pending: money(outstanding.reduce((a, r) => a + num(r.pending), 0)),
            loads: outstanding.slice(0, 30),
            // Pre-computed "owed from date X onwards", per Apsara 2026-08-29:
            // she asked "how much we owe sellers, start from aug 27" and the
            // bot refused — correctly, because answering needs a SUM and the
            // rules forbid it from doing arithmetic on money.
            //
            // Rather than relax that rule, the sums are done here. One entry
            // per distinct load date that actually has money outstanding, each
            // holding the total owed for that date and every later one. So a
            // question with any start date lands on an exact figure this code
            // computed, not one the model added up.
            //
            // Bounded by the number of distinct dates with outstanding money,
            // which is small — and it costs nothing the aggregate above did
            // not already cost.
            pending_from_date_onwards: (() => {
                const dates = [...new Set(outstanding.map((r) => r.date).filter(Boolean))].sort();
                return dates.map((d) => {
                    const rows = outstanding.filter((r) => r.date >= d);
                    return {
                        from_date: d,
                        loads: rows.length,
                        total_pending: money(rows.reduce((a, r) => a + num(r.pending), 0)),
                        sellers: [...new Set(rows.map((r) => r.seller).filter(Boolean))],
                    };
                });
            })(),
            // The same question asked per counterparty, which is how it is
            // usually meant — "who do we owe, and how much".
            by_seller: (() => {
                const m = new Map();
                for (const r of outstanding) {
                    const k = r.seller || 'Unknown';
                    m.set(k, (m.get(k) || 0) + num(r.pending));
                }
                return [...m.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .map(([seller, pending]) => ({ seller, pending: money(pending) }));
            })(),
        },
        payments_recorded: listPayments().length,
        // The payment LEDGER itself, newest first, so "when did we pay Acme"
        // and "what have we paid this week" are answerable from facts rather
        // than declined. Each row names its seller, resolved here from the
        // load, because the payment record stores a load_id and the question
        // is always asked by NAME.
        //
        // Capped at 60. The aggregates above answer "how much"; this list is
        // for "when" and "which", and an unbounded ledger would crowd out the
        // rest of the brief on a busy yard.
        recent_payments: (() => {
            const byId = new Map(loads.map((l) => [l.id, l]));
            const saleById = new Map(sales.map((l) => [l.id, l]));
            return listPayments()
                .slice()
                .sort((a, b) => String(b.paid_on || '').localeCompare(String(a.paid_on || '')))
                .slice(0, 60)
                .map((p) => {
                    const l = byId.get(p.load_id) || saleById.get(p.load_id);
                    // A payment whose load is no longer in the records leaves
                    // nothing to attribute it to. Deleting a load deletes its
                    // payments, so this should not arise — but if it ever does,
                    // the money is REPORTED and labelled rather than hidden or
                    // silently pinned to the wrong seller. A missing row is a
                    // worse answer than an unattributed one.
                    const orphan = !!p.load_id && !l && !p.seller;
                    return {
                        paid_on: ymd(p.paid_on),
                        // An ADVANCE names its seller directly and has no load.
                        seller: p.seller || (l ? (l.seller || l.buyer || null) : null)
                            || (orphan ? 'unknown — the load for this payment is no longer in the records' : null),
                        mode: p.mode,
                        amount: money(p.amount),
                        load_id: p.load_id || null,
                        // Advances were removed 2026-08-29. A legacy
                        // is_advance row may still exist in payments.json, so
                        // it is described honestly rather than mislabelled as
                        // a payment against a load it was never tied to.
                        kind: p.is_advance
                            ? 'money paid to this seller, never tied to a specific load (from the removed advances feature)'
                            : 'payment against this load',
                    };
                });
        })(),
    };
}

module.exports = { buildYardBrief, bySeller, summarise };
