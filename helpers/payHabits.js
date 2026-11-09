// helpers/payHabits.js — how many days each customer REALLY takes to pay (ownership plan step 5).
// ADVISORY AND READ-ONLY: it measures and reports. It does not change when anyone is chased; that needs her yes.
// Edge METALS only (sales + receipts). Days = date the LAST payment landed - invoice date, for fully settled invoices.
// Customers with fewer than MIN_SAMPLES settled invoices get no habit: "not enough history" beats a guess from one.
'use strict';

const MIN_SAMPLES = 3;
const round2 = (n) => Math.round(Number(n) * 100) / 100;

// Sales dates are MM/DD/YYYY, receipt dates ISO. Returns UTC ms or null.
function ms(d) {
    const s = String(d || '').trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return Date.UTC(+m[3], +m[1] - 1, +m[2]);
    return null;
}
const norm = (c) => String(c || '').trim().toLowerCase().replace(/\s+/g, ' ');
const pct = (arr, p) => { const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.ceil(p * a.length) - 1)]; };

function defaults() {
    return {
        sales: () => require('./sales').listWithTotals(),
        receipts: () => require('./salesReceipts').list(),
    };
}

// → { byCustomer: { <norm>: { customer, n, median, p80, slowest } }, skipped: { negative, unsettled, noDate } }
function build({ src = {} } = {}) {
    const d = Object.assign(defaults(), src);
    const sales = d.sales(), receipts = d.receipts();
    const last = {}, paid = {};                       // sale_id -> last payment ms / total allocated (+deductions)
    for (const r of receipts) {
        const t = ms(r.date);
        for (const a of (r.allocations || [])) {
            const amt = (Number(a.amount) || 0) + (Number(a.deduction_amount) || 0);
            if (!(amt > 0)) continue;
            paid[a.sale_id] = round2((paid[a.sale_id] || 0) + amt);
            if (t !== null && (last[a.sale_id] === undefined || t > last[a.sale_id])) last[a.sale_id] = t;
        }
    }
    const skipped = { negative: 0, unsettled: 0, noDate: 0 };
    const days = {};
    for (const s of sales) {
        const amount = Number(s.amount) || 0;
        if (!(amount > 0) || (paid[s.id] || 0) < amount - 0.5) { skipped.unsettled++; continue; }
        const inv = ms(s.date), got = last[s.id];
        if (inv === null || got === undefined) { skipped.noDate++; continue; }
        const n = Math.round((got - inv) / 864e5);
        if (n < 0) { skipped.negative++; continue; }   // paid before invoicing = a prepayment, says nothing about habit
        (days[norm(s.customer)] = days[norm(s.customer)] || { customer: s.customer, v: [] }).v.push(n);
    }
    const byCustomer = {};
    for (const k of Object.keys(days)) {
        const v = days[k].v;
        if (v.length < MIN_SAMPLES) continue;
        byCustomer[k] = { customer: days[k].customer, n: v.length, median: pct(v, 0.5), p80: pct(v, 0.8), slowest: Math.max(...v) };
    }
    return { byCustomer, skipped };
}

// Open invoices running past the customer's usual 80th-percentile: [{customer, invoice_no, age, usual, balance}]
function slow({ now = Date.now(), src = {}, habits } = {}) {
    const d = Object.assign(defaults(), src);
    const h = (habits || build({ src })).byCustomer;
    const out = [];
    for (const s of d.sales()) {
        const bal = Number(s.balance) || 0, hb = h[norm(s.customer)], inv = ms(s.date);
        if (!(bal > 0) || !hb || inv === null) continue;
        const age = Math.floor((now - inv) / 864e5);
        if (age > hb.p80) out.push({ customer: s.customer, invoice_no: s.invoice_no, age, usual: hb.median, balance: round2(bal) });
    }
    return out.sort((a, b) => b.balance - a.balance);
}

module.exports = { build, slow, MIN_SAMPLES, ms };
