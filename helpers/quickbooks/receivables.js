// ── helpers/quickbooks/receivables.js — chasing what she is owed ───────────
// Apsara, 2026-10-02: "Beat Intuit's AI in all aspects." Their Payments agent
// predicts late payers and sends reminders. This is the same job done with
// things they cannot see: the container, the shipment, the customer's own
// paying habit — and, above all, the money she has ALREADY RECEIVED and not
// applied.
//
// ── THE RULE THAT MATTERS MOST ────────────────────────────────────────────
// Never chase a customer for money that is already in the bank. On her books
// right now $117,196.50 of customer receipts sit on no invoice, and one
// customer — TAEWON — has $27,099.79 received against a record showing $88.91
// open, while the OTHER record for the same company shows $460,670.92. A
// reminder sent into that is not a dunning letter, it is an apology waiting
// to happen. So every customer is netted against their receipts, and against
// their alias's receipts, before a word is drafted.
//
// Nothing here sends anything. It drafts; she sends.
const fs = require('fs');
const path = require('path');
const client = require('./client');
const auth = require('./auth');

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const KEY = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const days = (a, b = Date.now()) => Math.floor((b - new Date(a)) / 864e5);

// Two records, one company. Kept in git so the page, the scripts and this all
// agree; the records stay separate in QuickBooks until the accountant merges.
function aliases() {
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'qb-settings', 'qb-same-customers.json'), 'utf8'));
        const map = {};
        for (const [from, to] of Object.entries(raw)) { if (from.startsWith('_')) continue; map[KEY(from)] = to; }
        return map;
    } catch { return {}; }
}
const sameAs = (name, map) => map[KEY(name)] || name;

async function pull(table, where, opts, cap = 5000) {
    let all = [], start = 1;
    for (;;) {
        const r = await client.query(`select * from ${table}${where ? ' where ' + where : ''} startposition ${start} maxresults 1000`, opts);
        const rows = r[table] || [];
        all = all.concat(rows);
        if (rows.length < 1000 || all.length >= cap) break;
        start += 1000;
    }
    return all;
}
const containersIn = (x) => [...new Set(((x.Line || []).map((l) => l.Description || '').join(' ').match(/[A-Z]{4}\d{7}/g)) || [])];

// ── SURVEY ────────────────────────────────────────────────────────────────
async function survey({ env = auth.qbEnv(), since = '2024-01-01' } = {}) {
    const opts = { env };
    const map = aliases();
    const [open, receipts, paidHistory] = await Promise.all([
        pull('Invoice', "Balance > '0'", opts),
        pull('Payment', `TxnDate >= '${since}'`, opts),
        pull('Invoice', `TxnDate >= '${since}' and Balance = '0'`, opts),
    ]);

    const byCustomer = {};
    const of = (name) => {
        const who = sameAs(name, map);
        return byCustomer[who] = byCustomer[who] || { customer: who, alsoKnownAs: new Set(), open: 0, invoices: [],
            received: 0, receipts: [], oldest: null, aging: { current: 0, d30: 0, d60: 0, d90: 0 } };
    };

    for (const i of open) {
        const name = (i.CustomerRef || {}).name || '';
        const c = of(name);
        if (sameAs(name, map) !== name) c.alsoKnownAs.add(name);
        const due = i.DueDate || i.TxnDate;
        const late = days(due);
        const row = { id: String(i.Id), doc: String(i.DocNumber || '').trim(), date: i.TxnDate, due: i.DueDate || null,
            total: r2(i.TotalAmt), balance: r2(i.Balance), late, containers: containersIn(i) };
        c.open = r2(c.open + row.balance);
        c.invoices.push(row);
        if (!c.oldest || row.date < c.oldest) c.oldest = row.date;
        if (late <= 0) c.aging.current = r2(c.aging.current + row.balance);
        else if (late <= 30) c.aging.d30 = r2(c.aging.d30 + row.balance);
        else if (late <= 60) c.aging.d60 = r2(c.aging.d60 + row.balance);
        else c.aging.d90 = r2(c.aging.d90 + row.balance);
    }

    // money already in the bank, sitting on no invoice
    for (const p of receipts) {
        const attached = (p.Line || []).reduce((s, l) => s + ((l.LinkedTxn || []).length ? Number(l.Amount || 0) : 0), 0);
        const loose = r2(Number(p.TotalAmt || 0) - attached);
        if (loose <= 0.01) continue;
        const name = (p.CustomerRef || {}).name || '';
        const c = of(name);
        if (sameAs(name, map) !== name) c.alsoKnownAs.add(name);
        c.received = r2(c.received + loose);
        c.receipts.push({ id: String(p.Id), date: p.TxnDate, amount: loose });
    }

    // how this customer actually pays, from their own history
    const habit = {};
    for (const i of paidHistory) {
        const who = sameAs((i.CustomerRef || {}).name || '', map);
        const took = i.DueDate ? days(i.DueDate, new Date(i.MetaData && i.MetaData.LastUpdatedTime || i.TxnDate)) : null;
        if (took === null || took < -60 || took > 365) continue;
        (habit[who] = habit[who] || []).push(took);
    }

    const rows = Object.values(byCustomer).map((c) => {
        const h = habit[c.customer] || [];
        const typical = h.length ? Math.round(h.reduce((s, x) => s + x, 0) / h.length) : null;
        // ── the verdict ───────────────────────────────────────────────────
        // apply-first beats chase, always: the money is already hers.
        const net = r2(c.open - c.received);
        const verdict = c.received > 0 && c.received >= c.open ? 'do-not-chase'
            : c.received > 0 ? 'apply-first'
                : c.aging.d60 + c.aging.d90 > 0 ? 'chase'
                    : c.aging.d30 > 0 ? 'nudge' : 'not-due';
        return { ...c, alsoKnownAs: [...c.alsoKnownAs], net,
            invoices: c.invoices.sort((a, b) => b.late - a.late),
            typicalDaysToPay: typical, paidOnRecord: h.length,
            verdict,
            why: verdict === 'do-not-chase'
                ? `${r2(c.received)} already received from them and applied to nothing — that covers everything open. Apply it, do not write to them.`
                : verdict === 'apply-first'
                    ? `${r2(c.received)} is already in the bank from them and applied to nothing. Apply it first; only ${net} is genuinely outstanding.`
                    : verdict === 'chase'
                        ? `${r2(c.aging.d60 + c.aging.d90)} is more than 60 days past due${typical ? `, and they usually pay in ${typical} days` : ''}.`
                        : verdict === 'nudge' ? 'Just past due — a short note, not a chase.' : 'Nothing is due yet.',
        };
    }).sort((a, b) => b.net - a.net);

    return { env, at: new Date().toISOString(),
        totals: { open: r2(rows.reduce((s, c) => s + c.open, 0)), received: r2(rows.reduce((s, c) => s + c.received, 0)),
            net: r2(rows.reduce((s, c) => s + c.net, 0)), customers: rows.length },
        customers: rows };
}

// ── THE DRAFT ─────────────────────────────────────────────────────────────
// Short, specific, and never apologetic. It names the shipment, because a
// customer who ships containers answers about containers, not invoice ids.
function draft(customer, { from = 'Edge Metals Inc.' } = {}) {
    if (customer.verdict === 'do-not-chase') {
        return { skip: true, why: customer.why };
    }
    const chase = customer.invoices.filter((i) => i.late > 0);
    const list = (chase.length ? chase : customer.invoices).slice(0, 12)
        .map((i) => `  ${i.doc || '#' + i.id}  ${i.date}  ${i.containers.join(', ') || '—'}  $${i.balance.toLocaleString('en-US', { minimumFractionDigits: 2 })}${i.late > 0 ? `  (${i.late} days past due)` : ''}`)
        .join('\n');
    const total = r2((chase.length ? chase : customer.invoices).reduce((s, i) => s + i.balance, 0));
    const note = customer.received > 0
        ? `\n\nWe also hold $${customer.received.toLocaleString('en-US', { minimumFractionDigits: 2 })} from you that we have not yet matched to an invoice — if that was meant for any of the above, tell us which and we will apply it.`
        : '';
    return {
        skip: false,
        subject: `${from} — ${chase.length ? 'overdue' : 'open'} invoices, $${total.toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
        body: `Hello,\n\nThese invoices are still showing as unpaid on our side:\n\n${list}\n\nTotal $${total.toLocaleString('en-US', { minimumFractionDigits: 2 })}.`
            + note
            + `\n\nIf any of these have been paid, send us the date and the amount and we will trace it.\n\nThank you,\n${from}`,
        to: null,
        customer: customer.customer,
        total,
    };
}

module.exports = { survey, draft, aliases, sameAs };
