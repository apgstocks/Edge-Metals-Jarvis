// ── helpers/edgeInventory.js — what a supplier actually delivered ────────
// Apsara, 2026-09-11: "sometimes,we get packing list when we deliver the load.
// that packing list contains items that needs to stored in inventory,so mimic
// add load form but we will have only seller in form."
//
// ── THE GAP THIS FILLS ──────────────────────────────────────────────────
// Edge Metals could say what a container COST (helpers/bills.js) and what it
// SOLD for (helpers/sales.js), and nothing at all about the metal in between.
// A supplier delivers against a packing list days before it is stuffed, and
// until now that delivery existed only as paper on a desk.
//
// ── IT IS NOT THE YARD, AND THAT IS NOT A DETAIL ────────────────────────
// helpers/loads.js is Edge YARD inventory: material bought over the scale,
// weighed, signed for, with a printed load ticket. The form here is modelled
// on that one — her words, "mimic add load form" — but the record is Edge
// METALS and lives in its own store. Same reasoning as
// helpers/metalsTrucking.js vs helpers/truckerBills.js, and as
// outboundLoads.js vs loads.js: a shared table with a company flag on it is
// how the two sets of books end up in one total.
//
// "we will have only seller in form" — the yard's add-load form flips its
// party between Seller and Buyer. Here there is only ever a supplier
// delivering, so there is no toggle and no buyer.
//
// ── ONE ITEM MODEL FOR EDGE METALS ──────────────────────────────────────
// The items are bills.cleanItems, imported rather than copied. A packing-list
// line is the same shape as a bill line — a grade, a weight, optionally a
// weighbridge ticket behind it — and a second implementation would be a
// second opinion about what a net weight is. helpers/sales.js already reuses
// it for the same reason.
//
// ── IT DOES NOT TOUCH THE ACCOUNT ───────────────────────────────────────
// Receiving metal is not a debit. helpers/supplierAccount.js is built from
// BILLS and PAYMENTS, per her rule — "bill amount(debit column)" — and a
// receipt is a physical fact, not a money one. The supplier is owed when the
// bill is raised, not when the truck arrives, and crediting or debiting here
// would count the same purchase twice.

const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

const round2 = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : null);
const round3 = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 1000) / 1000 : null);

const list = () => {
    const raw = loadJson(cfg.EDGE_INVENTORY_FILE, []);
    return Array.isArray(raw) ? raw : [];
};

const newId = () => `INV_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

function buildRecord(input = {}) {
    const bills = require('./bills');
    const supplier = String(input.supplier || '').trim();
    // Refused, not defaulted. A receipt with no supplier belongs to no
    // account and no inventory — it is a row nobody can ever use, and saving
    // it quietly is worse than making her name the supplier.
    if (!supplier) throw new Error('Validation: which supplier delivered this?');

    const items = bills.cleanItems(input.items);
    if (!items.length) throw new Error('Validation: a packing list needs at least one item.');

    const weight = round3(items.reduce((s, it) => s + (it.weight || 0), 0));
    const amount = round2(items.reduce((s, it) => s + (it.amount || 0), 0));

    return {
        date: String(input.date || '').trim() || null,
        supplier,
        // The supplier's own packing-list number, so a delivery can be found
        // again from the paper. Free text: it is their document, not hers.
        packing_list_no: String(input.packing_list_no || '').trim() || null,
        // Where it went. Optional, because a packing list often arrives
        // before anyone knows which container it will be stuffed into.
        container_no: String(input.container_no || '').trim().toUpperCase() || null,
        note: String(input.note || '').trim() || null,
        items,
        // Sums, never typed. Same rule as everywhere else in Edge Metals: a
        // figure that is both entered and derived will disagree with itself.
        weight_lb: weight,
        weight_mt: weight === null ? null : round3(weight / bills.LB_PER_MT),
        amount,
    };
}

async function addReceipt(input = {}) {
    const rec = {
        ...buildRecord(input),
        id: newId(),
        created_at: new Date().toISOString(),
        created_by: input.created_by || null,
    };
    await mutateJson(cfg.EDGE_INVENTORY_FILE, [], (all) => {
        const rows = Array.isArray(all) ? all : [];
        rows.unshift(rec);
        return rows;
    });
    return rec;
}

async function editReceipt(id, input = {}) {
    const patch = buildRecord(input);
    let updated = null;
    await mutateJson(cfg.EDGE_INVENTORY_FILE, [], (all) => {
        const rows = Array.isArray(all) ? all : [];
        const r = rows.find((x) => x.id === id);
        if (r) { Object.assign(r, patch, { updated_at: new Date().toISOString() }); updated = r; }
        return rows;
    });
    return updated;
}

async function deleteReceipt(id) {
    let existed = false;
    await mutateJson(cfg.EDGE_INVENTORY_FILE, [], (all) => {
        const rows = Array.isArray(all) ? all : [];
        const next = rows.filter((r) => r.id !== id);
        existed = next.length < rows.length;
        return next;
    });
    return existed;
}

const getReceipt = (id) => list().find((r) => r.id === id) || null;

function forSupplier(supplier, q = {}) {
    const bills = require('./bills');
    const { sameSupplier } = require('./supplierAccount');
    const from = String(q.from || '').trim();
    const to = String(q.to || '').trim();
    const fromIso = from ? (bills.sortableDate(from) || from) : '';
    const toIso = to ? (bills.sortableDate(to) || to) : '';

    return list()
        .filter((r) => sameSupplier(r.supplier, supplier))
        .filter((r) => {
            if (!fromIso && !toIso) return true;
            const d = bills.sortableDate(r.date) || '';
            if (fromIso && (!d || d < fromIso)) return false;
            if (toIso && (!d || d > toIso)) return false;
            return true;
        })
        .sort((a, b) => {
            const da = bills.sortableDate(a.date) || '';
            const db = bills.sortableDate(b.date) || '';
            // Newest first, and a receipt with no date sorts LAST rather than
            // first — an undated row at the top reads as the most recent
            // delivery, which is the one thing it is not known to be.
            if (da !== db) return (db || '').localeCompare(da || '');
            return String(b.created_at || '').localeCompare(String(a.created_at || ''));
        });
}

// What has been received from a supplier, by grade. The question the tab is
// really for: "how much Al combo have we had from Mazariegos?"
function byGrade(supplier) {
    const bills = require('./bills');
    const out = new Map();
    for (const r of forSupplier(supplier)) {
        for (const it of (r.items || [])) {
            const k = String(it.description || '').trim() || '(no description)';
            const cur = out.get(k) || { description: k, receipts: 0, weight_lb: 0, amount: 0 };
            cur.receipts += 1;
            cur.weight_lb = round3(cur.weight_lb + (it.weight || 0));
            cur.amount = round2(cur.amount + (it.amount || 0));
            out.set(k, cur);
        }
    }
    return [...out.values()]
        .map((g) => ({ ...g, weight_mt: round3((g.weight_lb || 0) / bills.LB_PER_MT) }))
        .sort((a, b) => (b.weight_lb || 0) - (a.weight_lb || 0));
}

function summary(supplier) {
    const rows = forSupplier(supplier);
    return {
        receipts: rows.length,
        weight_lb: round3(rows.reduce((s, r) => s + (r.weight_lb || 0), 0)) || 0,
        weight_mt: round3(rows.reduce((s, r) => s + (r.weight_mt || 0), 0)) || 0,
        amount: round2(rows.reduce((s, r) => s + (r.amount || 0), 0)) || 0,
    };
}

module.exports = {
    list, getReceipt, addReceipt, editReceipt, deleteReceipt,
    forSupplier, byGrade, summary, buildRecord,
};
