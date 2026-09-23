// ── helpers/data/dataMirror.js — her ledgers, as tables ────────────────────
//
// Apsara, 2026-09-23: "give all data access ... to Jarvis". This is the data
// half of that: every Edge Metals ledger copied into one read-only SQLite file
// so a question can be answered with a query instead of a hand-written report.
//
// ── IT READS THROUGH THE HELPERS, NEVER THE JSON ────────────────────────────
// bills.listWithTotals(), sales.listWithTotals(), metalsTrucking.payables(),
// margin.rows() — the SAME functions the screens call. So net weight, the
// per-lb/per-MT inference, balances and margin come out of one implementation.
// Reading data/bills.json directly here would have been easier and would have
// created a second, quietly different set of numbers — which is the failure
// this whole app exists to remove.
//
// ── EDGE METALS ONLY ────────────────────────────────────────────────────────
// Her rule, repeated: "yard has no scope in jarvis only scout has". Loads,
// Inventory, Petty Cash, Outbound Loads, Expenses and Trucker Bills are Edge
// Yard's and are NOT in this mirror at all — not filtered out later, not
// present. Scout gets its own mirror when she asks for it, and the separation
// is a missing table rather than a WHERE clause somebody can forget.
const fs = require('fs');
const cfg = require('../../config');

const YARD_ONLY = ['loads.json', 'inventory.json', 'petty_cash.json', 'outbound_loads.json',
    'expenses.json', 'trucker_bills.json', 'scale_tickets.json'];

const iso = (d) => require('../bills').sortableDate(d) || null;
const n2 = (v) => (typeof v === 'number' && isFinite(v) ? v : (v === null || v === undefined || v === '' ? null : (isFinite(Number(v)) ? Number(v) : null)));

// Files whose mtime decides whether the mirror is stale. A question asked a
// second after a bill is saved must see that bill.
function signature() {
    const files = [cfg.BILLS_FILE, cfg.SALES_FILE, cfg.BILL_PAYMENTS_FILE, cfg.SALES_RECEIPTS_FILE,
        cfg.BOOKINGS_FILE, cfg.EDGE_INVENTORY_FILE, cfg.METALS_TRUCKING_FILE, cfg.SALES_SETTLEMENTS_FILE];
    return files.map((f) => {
        try { const s = fs.statSync(f); return `${s.mtimeMs}:${s.size}`; } catch (e) { return '0'; }
    }).join('|');
}

function billRows() {
    const bills = require('../bills');
    return bills.listWithTotals().map((b) => ({
        bill_id: b.id, date: iso(b.date), date_shown: b.date || null,
        supplier: b.supplier || null, carrier: b.carrier || null, route: b.route || null,
        booking_no: b.booking_no || null, container_no: b.container_no || null, seal_no: b.seal_no || null,
        supplier_invoice_no: b.invoice_no || null, item: b.description || null,
        gross_lb: n2(b.gross_used !== undefined ? b.gross_used : b.gross), tare_lb: n2(b.total),
        net_lb: n2(b.net_lb), net_mt: n2(b.net_mt),
        supplier_price: n2(b.supplier_price), price_unit: b.price_unit || null,
        amount: n2(b.amount), trucking_amount: n2(b.trucking_amount_used !== undefined ? b.trucking_amount_used : b.trucking_amount),
        trucking_company: (b.trucking_split && b.trucking_split.company) || null,
        advance: n2(b.advance), paid: n2(b.paid), balance: n2(b.balance),
        is_finished: (require('../bills').missingFor(b) || []).length ? 0 : 1,
        still_needs: (require('../bills').missingFor(b) || []).join(', ') || null,
    }));
}

function billItemRows() {
    const bills = require('../bills');
    const out = [];
    for (const b of bills.listWithTotals()) {
        for (const it of (Array.isArray(b.items) ? b.items : [])) {
            out.push({ bill_id: b.id, date: iso(b.date), supplier: b.supplier || null,
                container_no: b.container_no || null, grade: it.description || null,
                net_lb: n2(it.weight), net_mt: n2(it.weight_mt), price: n2(it.price),
                price_unit: it.price_unit || null, amount: n2(it.amount) });
        }
    }
    return out;
}

function saleRows() {
    const sales = require('../sales');
    return sales.listWithTotals().map((s) => ({
        sale_id: s.id, date: iso(s.date), date_shown: s.date || null,
        customer: s.customer || null, booking_no: s.booking_no || null, container_no: s.container_no || null,
        invoice_no: s.invoice_no || null, hbl_no: s.hbl_no || null, item: s.item || null,
        payment_terms: s.terms || null, shipment_terms: s.shipment_terms || null,
        net_lb: n2(s.weight_lb), net_mt: n2(s.weight_mt),
        price: n2(s.invoice_price), price_unit: s.price_unit || null,
        amount: n2(s.amount), commission: n2(s.commission_amount),
        charges_in: n2(s.charges_in_total), charges_out: n2(s.charges_out_total),
        receivable: n2(s.receivable), received: n2(s.received), deducted: n2(s.deducted),
        balance: n2(s.balance),
    }));
}

function billPaymentRows() {
    const bp = require('../billPayments');
    const out = [];
    for (const p of bp.list()) {
        const allocs = Array.isArray(p.allocations) && p.allocations.length ? p.allocations : [null];
        for (const a of allocs) {
            out.push({ payment_id: p.id, date: iso(p.date), date_shown: p.date || null,
                supplier: p.supplier || null, amount: n2(a ? a.amount : p.amount),
                total_payment: n2(p.amount), method: p.mode || p.method || null, bank: p.bank || null,
                reference: p.reference || p.note || null, bill_id: a ? a.bill_id : null,
                is_advance: p.kind === 'advance' || p.is_advance ? 1 : 0 });
        }
    }
    return out;
}

function receiptRows() {
    const sr = require('../salesReceipts');
    const out = [];
    for (const r of sr.list()) {
        const allocs = Array.isArray(r.allocations) && r.allocations.length ? r.allocations : [null];
        for (const a of allocs) {
            out.push({ receipt_id: r.id, date: iso(r.date), date_shown: r.date || null,
                customer: r.customer || null, amount: n2(a ? a.amount : r.amount),
                total_receipt: n2(r.amount), method: r.mode || r.method || null, bank: r.bank || null,
                reference: r.reference || r.note || null, sale_id: a ? a.sale_id : null,
                deducted: n2(a ? a.deducted : null), deduction_reason: (a && a.reason) || null });
        }
    }
    return out;
}

function truckingRows() {
    return require('../metalsTrucking').payables().map((t) => ({
        bill_id: t.bill_id, date: t.sortable_date || iso(t.date), date_shown: t.date || null,
        trucking_company: t.trucking_company || null, supplier: t.supplier || null,
        booking_no: t.booking_no || null, container_no: t.container_no || null, route: t.route || null,
        trucker_invoice_no: t.trucker_invoice_no || null, verified_on: t.verified_on || null,
        amount: n2(t.amount), paid: n2(t.paid), balance: n2(t.balance), status: t.status || null,
    }));
}

function marginRows() {
    return require('../margin').rows().map((r) => ({
        booking_no: r.booking_no || null, container_no: r.container_no || null,
        supplier: r.supplier || null, customer: r.customer || null,
        bill_date: iso(r.bill_date), sale_date: iso(r.sale_date),
        bought_weight_lb: n2(r.bought_weight_lb), sold_weight_lb: n2(r.sold_weight_lb),
        cost: n2(r.cost !== undefined ? r.cost : r.bill_amount), trucking: n2(r.trucking),
        revenue: n2(r.revenue !== undefined ? r.revenue : r.invoice_amount),
        commission: n2(r.commission), margin: n2(r.margin), margin_pct: n2(r.margin_pct),
        received: n2(r.received), receivable: n2(r.receivable), state: r.state || null,
    }));
}

function bookingRows() {
    const { loadBookings } = require('../json');
    const all = loadBookings() || {};
    const rows = [];
    for (const k of Object.keys(all)) {
        const b = all[k] || {};
        const containers = Array.isArray(b.containers) ? b.containers : [];
        rows.push({
            booking_no: b.booking_number || k, carrier: b.carrier || null,
            port_of_loading: b.port_of_loading || null, port_of_discharge: b.port_of_discharge || null,
            erd: iso(b.erd_date), cutoff: iso(b.cutoff_date), etd: iso(b.etd_date), eta: iso(b.eta_date),
            vessel_voyage: b.vessel_voyage || null, status: b.status || null,
            containers: containers.length,
            containers_assigned: containers.filter((c) => c && c.supplier).length,
            suppliers: [...new Set(containers.map((c) => c && c.supplier).filter(Boolean))].join(', ') || null,
            truckers: [...new Set(containers.map((c) => c && c.trucker).filter(Boolean))].join(', ') || null,
            archived: b.archived ? 1 : 0,
        });
    }
    return rows;
}

function inventoryRows() {
    try {
        return (require('../edgeInventory').list() || []).map((r) => ({
            receipt_id: r.id, date: iso(r.date), supplier: r.supplier || null, grade: r.grade || r.item || null,
            weight_lb: n2(r.weight_lb !== undefined ? r.weight_lb : r.weight), storage: r.storage || null,
            container_no: r.container_no || null, note: r.note || null,
        }));
    } catch (e) { return []; }
}

function documentRows() {
    try {
        const ds = require('../documentsSaved');
        const out = [];
        for (const [kind, fn] of [['invoice', 'listSavedInvoices'], ['proforma', 'listSavedProformas'], ['bol', 'listSavedBols']]) {
            for (const d of (typeof ds[fn] === 'function' ? ds[fn]() : []) || []) {
                out.push({ kind, filename: d.filename || d.name || null, container_no: d.container || d.container_no || null,
                    date: d.date || null, saved_at: d.saved_at || d.mtime || null });
            }
        }
        return out;
    } catch (e) { return []; }
}

const TABLES = {
    bills: billRows,
    bill_items: billItemRows,
    sales: saleRows,
    bill_payments: billPaymentRows,
    sales_receipts: receiptRows,
    trucking_bills: truckingRows,
    margin: marginRows,
    bookings: bookingRows,
    edge_inventory: inventoryRows,
    documents: documentRows,
};

let cache = null;
// The file, rebuilt only when a ledger changed. Returns { file, signature,
// counts, engine }.
function ensure({ force = false } = {}) {
    const sig = signature();
    if (!force && cache && cache.signature === sig) return cache;
    const catalog = require('./dataCatalog');
    const tables = {};
    const counts = {};
    const declared = {};
    for (const name of Object.keys(TABLES)) {
        let rows = [];
        try { rows = TABLES[name]() || []; }
        catch (e) { console.error(`[MIRROR] ${name} failed: ${e.message}`); rows = []; }
        // ── AN EMPTY LEDGER IS STILL A TABLE ────────────────────────────
        // Columns come from the CATALOG, not from the first row. Two reasons,
        // both found the hard way: a ledger with no rows yet would otherwise
        // not exist at all, and "no such table: bookings" is a crash where
        // "no bookings" is an answer; and a row that happens to be missing an
        // optional field would silently drop that column for every row.
        // It also means the schema Jarvis is told about IS the schema it
        // queries — tests/ask-data.js asserts the two cannot drift.
        const described = catalog.find(name);
        const columns = described ? Object.keys(described.columns) : [];
        declared[name] = columns;
        tables[name] = columns.length
            ? rows.map((r) => { const o = {}; for (const c of columns) o[c] = r[c] === undefined ? null : r[c]; return o; })
            : rows;
        counts[name] = rows.length;
    }
    const engine = require('./sqlEngine');
    const file = engine.buildFile(tables, sig, declared);
    cache = { file, signature: sig, counts, engine: engine.engineName(), built_at: new Date().toISOString() };
    return cache;
}
function invalidate() { cache = null; }

module.exports = { ensure, invalidate, signature, TABLES, YARD_ONLY };
