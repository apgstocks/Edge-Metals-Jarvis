// ── helpers/quickbooks/pushInvoice.js — a Jarvis sale, as her invoice ───────
// Split from push.js by what it does: bills there, invoices here.
//
// Her invoices, read from Edge Metals Inc 2026-09-21/22 (e.g. #38877, TAEWON,
// TXGU8942580, 5 Aug 2026):
//   one invoice per CONTAINER; one line per GRADE (Jarvis keeps one sales row
//   per grade — see memory: ledger-data)
//   line = item (grade), Qty × UnitPrice in the unit she priced in — MT at
//          645/MT, or lbs at 1.88/lb — description = container number
//   terms "Due on receipt" on all 125 of her June–Sept invoices
//   total = Jarvis `receivable` (amount + charges the customer pays). Charges
//   Edge pays (freight out, commission) are costs, not invoice lines — which
//   is why 148 of her 150 recent invoices carry no freight line.

const push = require('./push');
const client = require('./client');
const auth = require('./auth');

const round2 = (n) => Math.round(n * 100) / 100;

// Pure. rows = the sales rows of ONE invoice, after sales.withTotals().
// refs = { customerId, itemIds: {grade|chargeName: id}, termId? }
function buildInvoice(rows, refs) {
    const problems = [];
    if (!rows || !rows.length) return { problems: ['no sales rows'] };
    const first = rows[0];
    const same = (k) => rows.every((r) => String(r[k] || '').trim().toUpperCase() === String(first[k] || '').trim().toUpperCase());
    if (!same('invoice_no')) problems.push('rows carry different invoice numbers');
    if (!same('customer')) problems.push('rows carry different customers');
    if (!same('container_no')) problems.push('rows carry different containers — one invoice is one container');
    const doc = String(first.invoice_no || '').trim();
    const container = String(first.container_no || '').trim().toUpperCase();
    const date = first.date;
    if (!doc) problems.push('no invoice number');
    if (doc.length > push.DOC_MAX) problems.push(`invoice number longer than QuickBooks allows (${push.DOC_MAX})`);
    if (!date) problems.push('no invoice date');

    const Line = [];
    for (const r of rows) {
        const grades = (r.items && r.items.length)
            ? r.items.map((i) => ({ grade: i.description, unit: i.price_unit, lb: i.weight, mt: i.weight_mt, price: i.price, amount: i.amount }))
            : [{ grade: r.item, unit: r.price_unit, lb: r.weight_lb, mt: r.weight_mt, price: r.invoice_price, amount: r.amount }];
        for (const g of grades) {
            const id = refs.itemIds[g.grade];
            if (!id) { problems.push(`grade "${g.grade}" has no QuickBooks item`); continue; }
            if (typeof g.amount !== 'number' || !(g.amount > 0)) { problems.push(`grade "${g.grade}" has no amount`); continue; }
            const detail = { ItemRef: { value: String(id) } };
            const qty = g.unit === 'mt' ? g.mt : g.lb;
            if (typeof qty === 'number' && typeof g.price === 'number' && Math.abs(round2(qty * g.price) - round2(g.amount)) < 0.011) {
                detail.Qty = qty; detail.UnitPrice = g.price;
            }
            Line.push({ DetailType: 'SalesItemLineDetail', Amount: round2(g.amount), Description: container || undefined, SalesItemLineDetail: detail });
        }
        for (const c of (r.charges || []).filter((c) => c.direction === 'in')) {
            const id = refs.itemIds[c.what];
            if (!id) { problems.push(`charge "${c.what}" has no QuickBooks item`); continue; }
            Line.push({ DetailType: 'SalesItemLineDetail', Amount: round2(c.amount), Description: [container, c.why].filter(Boolean).join(' — '), SalesItemLineDetail: { ItemRef: { value: String(id) } } });
        }
    }
    const total = round2(Line.reduce((s, l) => s + l.Amount, 0));
    const receivable = round2(rows.reduce((s, r) => s + (Number(r.receivable) || 0), 0));
    if (!problems.length && total !== receivable) problems.push(`lines add to ${total} but Jarvis says ${receivable} is receivable`);
    if (problems.length) return { problems };
    const inv = {
        CustomerRef: { value: String(refs.customerId) },
        TxnDate: String(date).slice(0, 10),
        DocNumber: doc,
        PrivateNote: [container && `Container ${container}`, first.booking_no && `Booking ${first.booking_no}`, first.hbl_no && `HBL ${first.hbl_no}`, `Jarvis sale ${rows.map((r) => r.id).filter(Boolean).join(',')}`].filter(Boolean).join(' · '),
        Line,
    };
    if (refs.termId) inv.SalesTermRef = { value: String(refs.termId) };
    return { invoice: inv, total };
}

async function resolveRefs(rows, snapshots, opts) {
    const env = opts.env || auth.qbEnv();
    const problems = [];
    const cust = push.confirmedName('customer', rows[0].customer, snapshots.customer);
    if (cust.problem) problems.push(cust.problem);
    const names = {};
    for (const r of rows) {
        for (const g of (r.items && r.items.length ? r.items.map((i) => i.description) : [r.item])) {
            const x = push.confirmedName('item', g, snapshots.item); if (x.problem) problems.push(x.problem); else names[g] = x.name;
        }
        for (const c of (r.charges || []).filter((c) => c.direction === 'in')) {
            const x = push.confirmedName('item', c.what, snapshots.item); if (x.problem) problems.push(x.problem); else names[c.what] = x.name;
        }
    }
    if (problems.length) return { problems };
    const get = async (kind, table, field, name) => (await push.idByName(table, field, name, opts))
        || (env === 'sandbox' ? push.ensureSandbox(kind, name, opts) : null);
    const refs = { customerId: await get('customer', 'Customer', 'DisplayName', cust.name), itemIds: {} };
    for (const [g, n] of Object.entries(names)) refs.itemIds[g] = await get('item', 'Item', 'Name', n);
    refs.termId = await get('term', 'Term', 'Name', 'Due on receipt');
    if (!refs.customerId) problems.push(`customer "${cust.name}" not found in QuickBooks ${env}`);
    for (const [g, id] of Object.entries(refs.itemIds)) if (!id) problems.push(`item "${names[g]}" not found in QuickBooks ${env}`);
    return problems.length ? { problems } : { refs, customerName: cust.name };
}

async function pushInvoice(rows, snapshots, { env = auth.qbEnv(), dryRun = true, fetchImpl } = {}) {
    const opts = { env, fetchImpl };
    const first = rows[0] || {};
    const cut = push.beforeCutover('invoice', first.date, env);
    if (cut) return { status: 'before-cutover', problems: [cut] };
    const key = push.linkKey(env, 'invoice', String(first.invoice_no || '').trim() || first.container_no);
    const linked = push.loadLinks()[key];
    if (linked) return { status: 'already-linked', qbId: linked.qbId };

    const res = await resolveRefs(rows, snapshots, opts);
    if (res.problems) return { status: 'blocked', problems: res.problems };
    const built = buildInvoice(rows, res.refs);
    if (built.problems) return { status: 'blocked', problems: built.problems };

    const hits = await push.findExistingDoc('Invoice', { date: first.date, container: first.container_no, doc: first.invoice_no }, opts);
    const j = push.judgeExisting(hits, res.refs.customerId, built.total);
    if (j.sure) {
        if (!dryRun) push.saveLink(key, { qbId: j.sure.Id, how: 'matched-existing', at: new Date().toISOString() });
        return { status: 'exists', qbId: j.sure.Id, note: 'already in QuickBooks — linked, nothing entered' };
    }
    if (j.ask) return { status: 'ask', candidates: j.ask, why: j.why, invoice: built.invoice, note: 'this container is already in QuickBooks but not exactly as Jarvis has it — she decides' };
    if (dryRun) return { status: 'would-create', invoice: built.invoice, total: built.total };
    const out = await client.request('POST', '/invoice', built.invoice, opts);
    push.saveLink(key, { qbId: out.Invoice.Id, syncToken: out.Invoice.SyncToken, how: 'created', total: out.Invoice.TotalAmt, at: new Date().toISOString() });
    return { status: 'created', qbId: out.Invoice.Id, total: out.Invoice.TotalAmt, invoice: out.Invoice };
}

module.exports = { buildInvoice, resolveRefs, pushInvoice };
