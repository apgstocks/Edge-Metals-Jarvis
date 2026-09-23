// ── helpers/data/yardMirror.js — Edge Yard's ledgers, as tables ────────────
//
// Scout's mirror, built the same way and for the same reason as
// helpers/data/dataMirror.js: read through the helpers the screens use
// (loads.payableOf, payments.paymentSummary, truckerBills.listBillsWithPayments,
// outboundLoads), so a figure Scout says and a figure the screen shows come
// from one implementation.
//
// ── A DIFFERENT COMPANY, A DIFFERENT FILE ───────────────────────────────────
// Her rule, said more often than any other: Edge Yard and Edge Metals are not
// the same business. So this is a second mirror, not more tables in the first
// one. Scout cannot reach the Metals book and Jarvis cannot reach this one,
// because neither knows the other's file exists — a separation that survives
// somebody forgetting a WHERE clause.
//
// ── WHY SCOUT NEEDS IT WHEN IT ALREADY HAS A BRIEF ──────────────────────────
// helpers/yardBrief.js pre-computes the common totals for a 30-DAY window and
// the model does the rest of the arithmetic in prose. That is fine for "how
// much did we buy this month" and wrong for "what did we pay Junk Car in
// March" — outside the window there is nothing to read, so the answer is
// invented or refused. This mirror holds everything, and the query is shown.
const fs = require('fs');
const cfg = require('../../config');

const iso = (d) => String(d || '').slice(0, 10) || null;
const n2 = (v) => (typeof v === 'number' && isFinite(v) ? v : (v === null || v === undefined || v === '' ? null : (isFinite(Number(v)) ? Number(v) : null)));

function signature() {
    const files = [cfg.LOADS_FILE, cfg.OUTBOUND_LOADS_FILE, cfg.TRUCKER_BILLS_FILE,
        cfg.EXPENSES_FILE, cfg.PETTY_CASH_FILE, cfg.PAYMENTS_FILE];
    return files.map((f) => {
        try { const s = fs.statSync(f); return `${s.mtimeMs}:${s.size}`; } catch (e) { return '0'; }
    }).join('|');
}

function loadRows() {
    const loads = require('../loads');
    const { paymentSummary } = require('../payments');
    return (loads.loadLoads() || []).map((l) => {
        const payable = loads.payableOf(l);
        let pay = { paid: null, pending: null, status: null };
        try { pay = paymentSummary(l.id, payable); } catch (e) { /* a load with no payments is normal */ }
        return {
            load_id: l.id, date: iso(l.date), seller: l.seller || null, buyer: l.buyer || null,
            gross_lb: n2(l.gross_weight), tare_lb: n2(l.tare_weight), net_lb: n2(l.net_weight),
            amount: n2(l.amount),
            trucking_company: l.trucking_company || null, trucking_amount: n2(l.trucking_amount),
            net_payable: n2(payable), paid: n2(pay.paid), pending: n2(pay.pending),
            pay_status: pay.status || (n2(payable) ? 'unpaid' : 'none'),
            status: l.status || null, description: l.description || null,
        };
    });
}

function itemRows(listFn, idKey, whoKey, whoField) {
    const out = [];
    for (const row of (listFn() || [])) {
        for (const it of (Array.isArray(row.items) ? row.items : [])) {
            if (!it) continue;
            out.push({
                [idKey]: row.id, date: iso(row.date), [whoKey]: row[whoField] || null,
                grade: it.description || it.item || null,
                net_lb: n2(it.net_weight !== undefined ? it.net_weight : it.weight),
                price: n2(it.price), amount: n2(it.amount),
            });
        }
    }
    return out;
}

function saleRows() {
    const ob = require('../outboundLoads');
    return (ob.loadOutboundLoads() || []).map((s) => ({
        sale_id: s.id, date: iso(s.date), buyer: s.buyer || null,
        net_lb: n2(s.net_weight), amount: n2(s.amount),
        received: n2(s.received !== undefined ? s.received : s.paid),
        balance: n2(s.balance !== undefined ? s.balance
            : (n2(s.amount) === null ? null : n2(s.amount) - (n2(s.received) || 0))),
        status: s.status || null, description: s.description || null,
    }));
}

function truckerBillRows() {
    const tb = require('../truckerBills');
    return (tb.listBillsWithPayments() || []).map((b) => ({
        bill_id: b.id, date: iso(b.date), trucker: b.company || b.trucker_name || null,
        load_ticket: b.load_ticket || b.ticket || null,
        amount: n2(b.amount), paid: n2(b.payment && b.payment.paid),
        pending: n2(b.payment && b.payment.pending),
        status: (b.payment && b.payment.status) || null,
    }));
}

function expenseRows() {
    const ex = require('../expenses');
    return (ex.loadExpenses() || []).map((e) => ({
        expense_id: e.id, date: iso(e.date), category: e.category || null,
        amount: n2(e.amount), method: e.method || null, note: e.note || null,
        paid_to: e.paid_to || e.payee || null,
    }));
}

function pettyRows() {
    const pc = require('../pettyCash');
    return (pc.listEntries() || []).map((p) => ({
        entry_id: p.id, date: iso(p.date || p.at), kind: p.kind || null,
        amount: n2(p.amount), bank: p.bank || null, note: p.note || null,
        ref: p.payment_id || p.expense_id || p.ref || null,
    }));
}

const TABLES = {
    yard_loads: loadRows,
    yard_load_items: () => itemRows(() => require('../loads').loadLoads(), 'load_id', 'seller', 'seller'),
    yard_sales: saleRows,
    yard_sale_items: () => itemRows(() => require('../outboundLoads').loadOutboundLoads(), 'sale_id', 'buyer', 'buyer'),
    yard_trucker_bills: truckerBillRows,
    yard_expenses: expenseRows,
    yard_petty_cash: pettyRows,
};

let cache = null;
function ensure({ force = false } = {}) {
    const sig = signature();
    if (!force && cache && cache.signature === sig) return cache;
    const catalog = require('./yardCatalog');
    const tables = {};
    const counts = {};
    const declared = {};
    for (const name of Object.keys(TABLES)) {
        let rows = [];
        try { rows = TABLES[name]() || []; }
        catch (e) { console.error(`[YARDMIRROR] ${name} failed: ${e.message}`); rows = []; }
        const described = catalog.find(name);
        const columns = described ? Object.keys(described.columns) : [];
        declared[name] = columns;
        tables[name] = columns.length
            ? rows.map((r) => { const o = {}; for (const c of columns) o[c] = r[c] === undefined ? null : r[c]; return o; })
            : rows;
        counts[name] = rows.length;
    }
    const engine = require('./sqlEngine');
    const file = engine.buildFile(tables, `yard:${sig}`, declared, { name: 'yard-mirror.sqlite' });
    cache = { file, signature: sig, counts, engine: engine.engineName(), built_at: new Date().toISOString() };
    return cache;
}
function invalidate() { cache = null; }

module.exports = { ensure, invalidate, signature, TABLES };
