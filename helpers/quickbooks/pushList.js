// ── helpers/quickbooks/pushList.js — ONE named list, into the books ────────
// The nightly sweep refuses anything before the cutover, because that period
// belongs to her accountant. Some of it still has to go in: the FMC and
// eccomelt tabs were 2026 sales never entered anywhere ("upload all fmc,
// eccomelt invoice", 2026-09-23).
//
// Rather than move the boundary — which would turn the sweep loose on her
// whole closed period — this pushes ONE NAMED SET and lifts the cutover only
// inside this process, only for the rows it was handed.
//
// Apsara, 2026-09-26: "i basically want my website to handle whatever we can
// do from qb from here" — so scripts/qb-push-list.js and the QuickBooks page
// both call this. Dry run unless really is true, and a reason is required:
// it goes in the journal beside every row this writes, which is what makes
// an entry explainable months later.
const fs = require('fs');
const path = require('path');
const push = require('./push');
const pushInvoice = require('./pushInvoice');
const pushPayments = require('./pushPayments');
const sync = require('./sync');

const norm = (v) => String(v || '').trim().toUpperCase();
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

// ── THE HOLD LIST ──────────────────────────────────────────────────────────
// Apsara, 2026-09-24, about six rows on Hugo's tab that are money to other
// people or sales, not wires to him: "Ignore all these for now. But remember.
// i will ask later." They stay in Jarvis — his account has to tie to his own
// tab — and nothing here touches them until the entry is taken out of
// qb-settings/qb-hold.json.
function holdList() {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'qb-settings', 'qb-hold.json'), 'utf8')).hold || []; }
    catch { return []; }
}
function heldBy(hold, kind, row) {
    return hold.find((h) => h.kind === kind
        && norm(h.supplier) === norm(row.supplier || row.customer)
        && push.isoDate(h.date) === push.isoDate(row.date)
        && Math.abs(Number(h.amount) - Number(row.amount || 0)) < 0.02);
}

function pick({ kind, since, until, party }) {
    const inWindow = (d0) => { const d = push.isoDate(d0); return d && d >= since && d <= until; };
    const is = (a) => !party || norm(a) === norm(party);
    if (kind === 'invoice') return require('../sales').list().filter((s) => inWindow(s.date) && is(s.customer));
    if (kind === 'bill') return require('../bills').list().filter((b) => inWindow(b.date) && is(b.supplier));
    return require('../billPayments').list().filter((p) => p.kind === 'advance' && inWindow(p.date) && is(p.supplier));
}

async function run({ kind = 'invoice', since = '2026-01-01', until = '2026-12-31', party = null,
    reason, really = false, env = require('./auth').qbEnv(), limit = 400 } = {}) {
    if (!['invoice', 'bill', 'advance'].includes(kind)) throw new Error('kind must be invoice, bill or advance');
    if (!reason || String(reason).trim().length < 4) throw new Error('a reason is required — it goes in the journal beside every row this writes');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new Error('since and until must be dates like 2026-01-01');

    const rows = pick({ kind, since, until, party });
    if (rows.length > limit) throw new Error(`${rows.length} rows match — narrow the dates or the party (the limit is ${limit}, deliberately)`);
    const hold = holdList();
    const out = { kind, since, until, party: party || null, env, dryRun: !really, reason: String(reason).trim(),
        rows: [], tally: {}, total: 0 };
    const bump = (s) => { out.tally[s] = (out.tally[s] || 0) + 1; };
    if (!rows.length) return out;

    // The cutover steps aside for THIS process only, and only after the rows
    // have already been chosen — so it can never widen the set.
    push.setCutover({ bills: since, invoices: since });
    try {
        const snaps = await sync.snapshots(env);
        const opts = { env, dryRun: !really, reason: out.reason };
        if (kind === 'invoice') {
            const sales = require('../sales');
            const byDoc = {};
            for (const s of rows) { const no = push.docNumberFor(s); if (no) (byDoc[no] = byDoc[no] || []).push(sales.withTotals(s)); }
            out.noNumber = rows.length - Object.values(byDoc).reduce((n, g) => n + g.length, 0);
            for (const [no, group] of Object.entries(byDoc)) {
                const held = heldBy(hold, 'invoice', group[0]);
                const total = r2(group.reduce((s, g) => s + (Number(g.receivable) || 0), 0));
                if (held) { bump('on hold'); out.rows.push({ no, date: group[0].date, who: group[0].customer, amount: total, status: 'on hold', why: held.why || '' }); continue; }
                const r = await pushInvoice.pushInvoice(group, snaps, opts).catch((e) => ({ status: 'error: ' + e.message }));
                bump(r.status);
                out.total = r2(out.total + (r.status === 'created' || r.status === 'would-create' ? total : 0));
                out.rows.push({ no, date: group[0].date, who: group[0].customer, amount: total, status: r.status, qbId: r.qbId || null, why: (r.problems || []).join('; ') });
            }
            return out;
        }
        const bills = require('../bills');
        for (const row of rows.sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
            const held = heldBy(hold, kind, row);
            const amount = kind === 'bill' ? r2(bills.withTotals(row).amount) : r2(row.amount);
            if (held) { bump('on hold'); out.rows.push({ no: row.invoice_no || row.id, date: row.date, who: row.supplier, amount, status: 'on hold', why: held.why || '' }); continue; }
            const r = kind === 'bill'
                ? await push.pushBill(bills.withTotals(row), snaps, opts).catch((e) => ({ status: 'error: ' + e.message }))
                : await pushPayments.pushBillPayment(row, snaps, opts).catch((e) => ({ status: 'error: ' + e.message }));
            bump(r.status);
            out.total = r2(out.total + (r.status === 'created' || r.status === 'would-create' ? amount : 0));
            out.rows.push({ no: row.invoice_no || row.container_no || row.id, date: row.date, who: row.supplier, amount,
                status: r.status, qbId: r.qbId || null, why: (r.problems || []).join('; ') });
        }
        return out;
    } finally {
        push.clearCutover();
    }
}

module.exports = { run, holdList, heldBy, pick };
