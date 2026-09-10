// ── helpers/metalsTrucking.js — Edge Metals haulage, and paying it ──────
// Apsara, 2026-09-10: "Similar to sales,crate a tab called Trucking,and put
// all the relevant details from bill to this..give an option to pay.Also give
// an option to filter by date,month,trucking company,status (paid/unpaid)".
//
// ── THIS IS NOT helpers/truckerBills.js ─────────────────────────────────
// That file is EDGE YARD: its own store, its own bills, load_kind 'trucker'.
// "Always remember Edge Yard is different and Edge Metals is different."
//
// What this file covers is haulage on an Edge Metals container, which until
// now existed only as two columns on a bill — trucking_company and
// trucking_amount — deducted from what the supplier is owed and never paid to
// anybody in the records. So the money was accounted for on the supplier side
// and invisible on the haulier side: she could not answer "what do I owe Sher
// Trucking" from this app at all.
//
// ── DERIVED, NOT STORED ─────────────────────────────────────────────────
// A trucking payable IS the bill's trucking_amount. It is not copied into a
// table of its own, for the reason the sales tabs are views rather than
// stores: a second copy of the company, the container and the amount is a
// second thing to keep in step, and it is the copy that goes stale. Change the
// figure on the bill and this list changes with it.
//
// ── AND IT IS ITS OWN LINE IN THE SPEND REPORT ──────────────────────────
// load_kind 'metals_trucking', not 'trucker'. Folding the two together would
// put yard haulage and Metals haulage in one figure with no way to separate
// them again — the same mistake as folding sale costs into the Supplier line,
// and the same reason not to make it: right grand total, wrong story.
//
// Cash payments do not touch the yard's petty cash box; 'metals_trucking' is
// in payments.js's EDGE_METALS_KINDS beside 'bill' and 'sale_cost'.

const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(/[$,\s]/g, ''));
    return isFinite(n) ? n : null;
};
const round2 = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : null);
const CENT = 0.005;

const TRUCKING_MODES = ['Wire', 'Zelle', 'Cash', 'Cheque'];
// 'missing' is a haul with a trucker and NO amount. Apsara, 2026-09-10:
// "What if my employee forget to enter..There should be some provsision to
// veiw those rows."
//
// She is right and the first version was wrong in a specific way: it left
// those rows out to keep the pay list tidy, and in doing so made a
// data-entry mistake invisible. A haul nobody priced is not "nothing to
// pay" — it is a bill somebody has not finished, and the only way anyone
// finds it is by looking at a list that shows it.
const STATUSES = ['missing', 'unpaid', 'part', 'paid'];

const list = () => {
    const raw = loadJson(cfg.METALS_TRUCKING_FILE, []);
    return Array.isArray(raw) ? raw : [];
};

const newId = () => `MTP_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

const sameCompany = (a, b) =>
    String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

function paidByBill() {
    const out = {};
    for (const p of list()) {
        for (const a of (p.allocations || [])) {
            out[a.bill_id] = round2((out[a.bill_id] || 0) + (num(a.amount) || 0));
        }
    }
    return out;
}

// ── EVERY HAULAGE LINE, INCLUDING THE UNFINISHED ONES ───────────────────
// One row per bill that names a haulier OR an amount. A bill with a trucker
// and no figure is here, flagged 'missing' — see STATUSES above for why the
// first version dropped it and why that was wrong.
//
// A bill with NEITHER is not here at all: nothing about it suggests haulage,
// and inventing a row for every bill would bury the ones that mean something.
function payables() {
    const bills = require('./bills');
    const paid = paidByBill();
    const out = [];

    for (const b of bills.listWithTotals()) {
        const amount = num(b.trucking_amount);
        const company = String(b.trucking_company || '').trim();
        const priced = amount !== null && amount > 0;
        if (!priced && !company) continue;
        const already = paid[b.id] || 0;
        // Nothing owed on a haul nobody has priced — a balance implies a
        // figure, and there is not one.
        const balance = priced ? round2(amount - already) : 0;
        out.push({
            bill_id: b.id,
            date: b.date || null,
            // helpers/bills.sortableDate turns her MM/DD/YYYY into YYYY-MM-DD.
            // Kept alongside so filtering by month is a string compare rather
            // than a date parse per row per request.
            sortable_date: bills.sortableDate(b.date) || null,
            booking_no: b.booking_no || null,
            container_no: b.container_no || null,
            supplier: b.supplier || null,
            route: b.route || null,
            trucking_company: company || null,
            amount: priced ? amount : null,
            paid: already,
            balance,
            priced,
            // What is actually stopping this row from being finished, in her
            // words rather than a code — the row is useless as a prompt if it
            // does not say what to go and do.
            missing: priced ? [] : ['trucking amount'].concat(company ? [] : ['trucker']),
            status: !priced ? 'missing'
                : (balance <= CENT ? 'paid' : (already > CENT ? 'part' : 'unpaid')),
        });
    }
    return out;
}

// ── HER FILTERS ─────────────────────────────────────────────────────────
// "filter by date,month,trucking company,status (paid/unpaid)", then, having
// seen it: "Remove month in trucking,we have date filter na". Right — a month
// picker beside a date range is two controls for one question, and two
// controls that can contradict each other is worse than one that cannot.
//
// Applied server-side, like the bills and sales tables, so the totals shown
// always describe the rows shown — a summary computed over everything while
// the table shows a subset is the bug that makes a filter untrustworthy.
function filterPayables(rows, q = {}) {
    const from = String(q.from || '').trim();
    const to = String(q.to || '').trim();
    const company = String(q.trucking_company || '').trim();
    const status = String(q.status || '').trim().toLowerCase();
    const bills = require('./bills');

    const fromIso = from ? (bills.sortableDate(from) || from) : '';
    const toIso = to ? (bills.sortableDate(to) || to) : '';

    return (rows || []).filter((r) => {
        if (fromIso && (!r.sortable_date || r.sortable_date < fromIso)) return false;
        if (toIso && (!r.sortable_date || r.sortable_date > toIso)) return false;
        if (company && !sameCompany(r.trucking_company, company)) return false;
        // 'unpaid' means anything still owing — part-paid included. She asked
        // for "paid/unpaid", and a part-paid haul she still owes money on
        // belongs in the list she works from.
        // 'unpaid' is what she still owes money on — part-paid included, and
        // 'missing' deliberately EXCLUDED: there is no figure to owe. Those
        // have their own filter, because "chase the trucker" and "finish the
        // bill" are different jobs on different days.
        if (status === 'unpaid' && (r.status === 'paid' || r.status === 'missing')) return false;
        if (status === 'paid' && r.status !== 'paid') return false;
        if (status === 'part' && r.status !== 'part') return false;
        if (status === 'missing' && r.status !== 'missing') return false;
        return true;
    });
}

function summary(rows) {
    const r = rows || [];
    const sum = (f) => round2(r.filter(f).reduce((s, x) => s + (x.amount || 0), 0)) || 0;
    return {
        count: r.length,
        amount: sum(() => true),
        paid: round2(r.reduce((s, x) => s + (x.paid || 0), 0)) || 0,
        outstanding: round2(r.reduce((s, x) => s + Math.max(0, x.balance || 0), 0)) || 0,
        unpaid_count: r.filter((x) => x.status === 'unpaid' || x.status === 'part').length,
        // Surfaced as its own figure so an unfinished bill is a number on
        // screen rather than something she would have to go looking for.
        missing_count: r.filter((x) => x.status === 'missing').length,
    };
}

function facets(rows) {
    const of = (f) => [...new Set((rows || []).map((r) => String(r[f] || '').trim()).filter(Boolean))].sort();
    return {
        trucking_company: of('trucking_company'),
        status: STATUSES,
    };
}

function cleanAllocations(input, amount, { company = null } = {}) {
    // Only priced hauls can be paid. A 'missing' row has no figure to settle
    // against, and allowing one would let a payment invent the amount.
    const open = new Map(payables().filter((p) => p.priced).map((p) => [p.bill_id, p]));
    const out = [];

    for (const a of (input || [])) {
        const billId = String((a && a.bill_id) || '').trim();
        const amt = round2(num(a && a.amount));
        if (!billId) continue;
        if (amt === null || amt <= 0) continue;

        const target = open.get(billId);
        if (!target) throw new Error(`no trucking to pay on ${billId} — the amount may have been cleared`);
        // One payment, one haulier. A wire marked Sher Trucking sitting
        // against a container Bayou hauled is a false statement about who was
        // paid, and it would show the wrong company as square.
        if (company && target.trucking_company && !sameCompany(target.trucking_company, company)) {
            throw new Error(`${target.container_no || billId} was hauled by ${target.trucking_company}, not ${company}`);
        }

        const existing = out.find((x) => x.bill_id === billId);
        if (existing) existing.amount = round2(existing.amount + amt);
        else out.push({ bill_id: billId, amount: amt });
    }

    for (const a of out) {
        const target = open.get(a.bill_id);
        if (a.amount - target.balance > CENT) {
            const left = target.balance <= CENT
                ? 'nothing outstanding on it'
                : `only $${target.balance.toFixed(2)} outstanding`;
            throw new Error(`$${a.amount.toFixed(2)} against ${target.container_no || a.bill_id}, but there is ${left}`);
        }
    }

    const total = round2(out.reduce((s, a) => s + a.amount, 0)) || 0;
    if (total - amount > CENT) {
        throw new Error(`allocations come to $${total.toFixed(2)} but the payment is $${amount.toFixed(2)}`);
    }
    if (amount - total > CENT) {
        throw new Error(`$${round2(amount - total).toFixed(2)} of this payment is not against any container`);
    }
    return out;
}

async function mirrorToLedger(rec) {
    const { addPayment } = require('./payments');
    return addPayment({
        load_id: rec.id,                     // the PAYMENT's id, not a bill id
        load_kind: 'metals_trucking',
        amount: rec.amount,
        mode: rec.mode,
        bank: rec.bank || null,
        paid_on: require('./bills').sortableDate(rec.date) || rec.date,
        require_bank: rec.mode === 'Wire' || rec.mode === 'Zelle',
        created_by: rec.created_by || null,
    });
}

async function addTruckingPayment(input = {}) {
    const amount = round2(num(input.amount));
    if (amount === null || amount <= 0) throw new Error('a payment amount is required');
    const mode = TRUCKING_MODES.find((m) => m.toLowerCase() === String(input.mode || '').trim().toLowerCase());
    if (!mode) throw new Error(`payment mode must be one of: ${TRUCKING_MODES.join(', ')}`);
    if (!String(input.date || '').trim()) throw new Error('a payment needs a date');
    if (!String(input.trucking_company || '').trim()) throw new Error('who is being paid?');
    if ((mode === 'Wire' || mode === 'Zelle') && !String(input.bank || '').trim()) {
        throw new Error('a bank is required for Zelle and Wire');
    }

    const company = String(input.trucking_company).trim();
    const allocations = cleanAllocations(input.allocations, amount, { company });
    if (!allocations.length) throw new Error('nothing was allocated — which container is this paying for?');

    const rec = {
        id: newId(),
        date: String(input.date).trim(),
        amount,
        mode,
        bank: (mode === 'Wire' || mode === 'Zelle') ? String(input.bank).trim() : null,
        ref: String(input.ref || '').trim() || null,
        trucking_company: company,
        note: String(input.note || '').trim() || null,
        allocations,
        created_at: new Date().toISOString(),
        created_by: input.created_by || null,
    };

    // Ledger first: better a payment she has to enter again than one that
    // exists here and is missing from her spend report.
    const mirrored = await mirrorToLedger(rec);
    rec.ledger_payment_id = mirrored && mirrored.id ? mirrored.id : null;

    await mutateJson(cfg.METALS_TRUCKING_FILE, [], (all) => {
        const rows = Array.isArray(all) ? all : [];
        rows.push(rec);
        return rows;
    });
    return rec;
}

async function deleteTruckingPayment(id) {
    const doomed = list().find((r) => r.id === id);
    if (!doomed) throw new Error(`no payment ${id}`);
    await mutateJson(cfg.METALS_TRUCKING_FILE, [], (all) => {
        const rows = Array.isArray(all) ? all : [];
        const i = rows.findIndex((r) => r.id === id);
        if (i !== -1) rows.splice(i, 1);
        return rows;
    });
    try {
        await require('./payments').deletePaymentsForLoad(doomed.id);
    } catch (e) {
        console.error('[METALS-TRUCKING] removed the payment but not its ledger row:', e.message);
    }
    return doomed;
}

module.exports = {
    TRUCKING_MODES, STATUSES,
    list, addTruckingPayment, deleteTruckingPayment,
    payables, filterPayables, summary, facets, paidByBill,
    cleanAllocations, sameCompany,
};
