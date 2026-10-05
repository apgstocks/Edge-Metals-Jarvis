// ── helpers/quickbooks/snapshot.js — what QuickBooks says, on disk ─────────
// Apsara chose the WhatsApp question channel (2026-10-05) over three other
// builds. "How much do we owe Inesh" on her phone has, until now, been
// answered from JARVIS's bills ledger — because the SQL mirror behind that
// channel holds her ledgers and nothing from QuickBooks. (It is item 4 of the
// "Next" list in jarvis-ask-the-ledgers.md, written 23 Sep and never done.)
//
// That is worse than having no answer. QuickBooks is the system of record now,
// and it disagrees with Jarvis's ledgers in ways we have spent two weeks
// cataloguing: $4,982,800.77 of payments recorded against no bill, 2026
// duplicates, bills her accountant entered by hand that Jarvis never saw. A
// confident figure from the wrong book is how she quotes a supplier the wrong
// number.
//
// ── WHY A FILE AND NOT A LIVE CALL ────────────────────────────────────────
// A WhatsApp question must answer in a second or two, from a phone, possibly
// while the QuickBooks token is mid-refresh. Reading 610 bills and 742
// invoices over the API inside a question would be slow on a good day and a
// failed answer on a bad one. So the books are snapshotted — by the nightly
// run, or on demand — and the mirror reads the file. Every answer carries the
// age of the snapshot, because "as of last night" is an honest answer and a
// silently stale figure is not.
const fs = require('fs');
const path = require('path');
const client = require('./client');
const auth = require('./auth');

const { DATA_DIR } = require('../../config');
const FILE = () => process.env.QB_SNAPSHOT_FILE || path.join(DATA_DIR, 'qb-books-snapshot.json');
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const CONTAINER = /[A-Z]{4}\d{7}/g;

// Containers are read from the LINES, never the memo — the one rule that cost
// us three wrong duplicate reports (2026-09-29).
function containersOf(doc) {
    const text = (doc.Line || []).map((l) => l.Description || '').join(' ');
    return [...new Set(text.match(CONTAINER) || [])];
}

async function page(table, where, env, cap = 6000) {
    const out = [];
    for (let start = 1; start <= cap; start += 1000) {
        const r = await client.query(`select * from ${table} where ${where} maxresults 1000 startposition ${start}`, { env });
        const rows = r[table] || [];
        out.push(...rows);
        if (rows.length < 1000) break;
    }
    return out;
}

// ── write ──────────────────────────────────────────────────────────────────
// Flattened to the handful of fields a question needs. The full documents stay
// in QuickBooks; this is not a second copy of her books, it is an index.
async function write({ env = auth.qbEnv(), since = '2026-01-01' } = {}) {
    const [bills, invoices, billPays, payments, vendors, customers] = await Promise.all([
        page('Bill', `TxnDate >= '${since}'`, env),
        page('Invoice', `TxnDate >= '${since}'`, env),
        page('BillPayment', `TxnDate >= '${since}'`, env),
        page('Payment', `TxnDate >= '${since}'`, env),
        page('Vendor', `Active in (true, false)`, env),
        page('Customer', `Active in (true, false)`, env),
    ]);

    const applied = (p) => r2((p.Line || []).reduce((s, l) => s + ((l.LinkedTxn || []).length ? (Number(l.Amount) || 0) : 0), 0));
    // A payment can come back with MORE applied than its own total — a credit
    // memo linked into it will do that. "Minus $150 of unapplied money" is not
    // a thing, and summed across parties it quietly corrupts the total (found
    // on the first sandbox run, 2026-10-05). So it is floored at zero and
    // COUNTED, because a document applied beyond its value is a real anomaly
    // and hiding it would be the same mistake in the other direction.
    const overApplied = [];
    const loose = (p, who) => {
        const byLines = r2(r2(p.TotalAmt) - applied(p));
        if (byLines < -0.005) overApplied.push({ id: String(p.Id), who, total: r2(p.TotalAmt), applied: applied(p) });
        const raw = typeof p.UnappliedAmt === 'number' ? r2(Math.min(r2(p.UnappliedAmt), byLines)) : byLines;
        return Math.max(0, raw);
    };
    const looseBy = (rows, refKey) => {
        const m = {};
        for (const p of rows) {
            const n = String((p[refKey] || {}).name || '').trim();
            if (!n) continue;
            m[n] = r2((m[n] || 0) + loose(p, n));
        }
        return m;
    };
    const vLoose = looseBy(billPays, 'VendorRef');
    const cLoose = looseBy(payments, 'CustomerRef');

    const snap = {
        at: new Date().toISOString(), env, since,
        bills: bills.map((b) => ({
            qb_id: String(b.Id), doc_no: String(b.DocNumber || '').trim(), date: String(b.TxnDate || '').slice(0, 10),
            supplier: String((b.VendorRef || {}).name || '').trim(),
            container_no: containersOf(b)[0] || null, containers: containersOf(b).length,
            total: r2(b.TotalAmt), balance: r2(b.Balance),
            payable_account: String((b.APAccountRef || {}).name || '').trim() || null,
            paid_by: (b.LinkedTxn || []).filter((t) => /Payment|Credit/i.test(String(t.TxnType || ''))).length,
        })),
        invoices: invoices.map((i) => ({
            qb_id: String(i.Id), doc_no: String(i.DocNumber || '').trim(), date: String(i.TxnDate || '').slice(0, 10),
            customer: String((i.CustomerRef || {}).name || '').trim(),
            container_no: containersOf(i)[0] || null, containers: containersOf(i).length,
            total: r2(i.TotalAmt), balance: r2(i.Balance), due: String(i.DueDate || '').slice(0, 10) || null,
        })),
        // Balance is what QuickBooks itself says the party owes, AFTER it nets
        // credits off. It is the ONLY right answer to "what do I owe" — adding
        // up open bills gave $10.7M against a real $5.3M, and she was right to
        // shout about it (2026-09-28).
        suppliers: vendors.filter((v) => r2(v.Balance) !== 0 || vLoose[String(v.DisplayName || '').trim()])
            .map((v) => ({ name: String(v.DisplayName || '').trim(), balance: r2(v.Balance),
                unapplied_paid: r2(vLoose[String(v.DisplayName || '').trim()] || 0), active: v.Active !== false })),
        customers: customers.filter((c) => r2(c.Balance) !== 0 || cLoose[String(c.DisplayName || '').trim()])
            .map((c) => ({ name: String(c.DisplayName || '').trim(), balance: r2(c.Balance),
                unapplied_received: r2(cLoose[String(c.DisplayName || '').trim()] || 0), active: c.Active !== false })),
    };
    snap.totals = {
        owe: r2(snap.suppliers.reduce((s, v) => s + v.balance, 0)),
        owed: r2(snap.customers.reduce((s, c) => s + c.balance, 0)),
        unapplied_paid: r2(Object.values(vLoose).reduce((s, n) => s + n, 0)),
        unapplied_received: r2(Object.values(cLoose).reduce((s, n) => s + n, 0)),
        bills: snap.bills.length, invoices: snap.invoices.length,
        over_applied: overApplied.length,
    };
    snap.over_applied = overApplied;
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify(snap));
    return snap;
}

function read() {
    try { const j = JSON.parse(fs.readFileSync(FILE(), 'utf8')); return (j && j.at) ? j : null; }
    catch { return null; }
}
function ageMinutes() {
    const s = read();
    if (!s) return null;
    return Math.round((Date.now() - Date.parse(s.at)) / 60000);
}
// The mtime is what tells the mirror to rebuild, the same way a ledger does.
function stamp() {
    try { return String(fs.statSync(FILE()).mtimeMs); } catch { return '0'; }
}

module.exports = { write, read, ageMinutes, stamp, FILE, containersOf };
