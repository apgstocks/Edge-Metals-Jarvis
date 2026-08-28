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
        if (!m.has(key)) m.set(key, { seller: key, loads: 0, net_weight: 0, amount: 0, paid: 0, pending: 0, last_date: null });
        const row = m.get(key);
        row.loads += 1;
        row.net_weight += num(l.net_weight);
        row.amount += num(l.amount);
        const p = paymentSummary(l.id, l.amount);
        row.paid += num(p.paid);
        row.pending += num(p.pending);
        if (!row.last_date || ymd(l.date) > row.last_date) row.last_date = ymd(l.date);
    }
    return [...m.values()]
        // Sorted on the numeric value BEFORE the money fields become strings,
        // otherwise "9052.00" sorts lexically against "980.00" and the biggest
        // seller stops being first.
        .sort((a, b) => b.amount - a.amount)
        .map((r) => ({ ...r, net_weight: round2(r.net_weight), amount: money(r.amount), paid: money(r.paid), pending: money(r.pending) }));
}

function summarise(loads) {
    return {
        count: loads.length,
        net_weight: round2(loads.reduce((a, l) => a + num(l.net_weight), 0)),
        amount: money(loads.reduce((a, l) => a + num(l.amount), 0)),
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
        },
        payments_recorded: listPayments().length,
    };
}

module.exports = { buildYardBrief, bySeller, summarise };
