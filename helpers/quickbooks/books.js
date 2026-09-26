// ── helpers/quickbooks/books.js — her books, read from Jarvis ───────────────
// Apsara, 2026-09-26: "user should able to feel content with jarvis quickbook
// without needing to open qb ... jarvis should be supreme of qb."
//
// Until now the page showed the JARVIS side of everything and one balance
// number per party. Every other question — what is actually in there, what is
// still unpaid, what did the year make, where is invoice 25AQ02 — meant
// opening QuickBooks. This is that side, read live.
//
// ── READ-ONLY, BY CONSTRUCTION ─────────────────────────────────────────────
// Everything here goes through client.query or a GET to /reports. client.js
// only gates writes, and there are none in this file: nothing here can change
// her books even if it is called wrongly. It never flips QB_PROD_WRITES —
// that switch is global to the process, and a report must not be able to open
// or close the door for a push happening in the same second.
const client = require('./client');
const auth = require('./auth');

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const KEY = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// QuickBooks' query language takes single quotes; a name with an apostrophe
// ("Daekwang Co,Ltd" is fine, "O'Brien" is not) breaks the statement unless
// it is doubled. Learnt the expensive way elsewhere; done once, here.
const q1 = (v) => String(v == null ? '' : v).replace(/'/g, "''");

// Her books move in minutes, not seconds, and this page is clicked a lot.
const CACHE = new Map();
async function cached(key, ttlMs, fn) {
    const hit = CACHE.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.data;
    const data = await fn();
    CACHE.set(key, { at: Date.now(), data });
    return data;
}
function forget(prefix = '') {
    for (const k of [...CACHE.keys()]) if (!prefix || k.startsWith(prefix)) CACHE.delete(k);
}

async function pull(table, where, opts, cap = 1000) {
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

// ── the year, as QuickBooks itself reports it ──────────────────────────────
// Her accountant's numbers, not a sum Jarvis invented from its own ledgers —
// the whole point is that this agrees with what she would see if she opened
// the app.
function flattenReport(report) {
    const out = {};
    (function walk(rows) {
        for (const row of rows || []) {
            const c = (row.Summary && row.Summary.ColData) || (row.type === 'Data' && row.ColData);
            if (c && c[0] && c[0].value) out[c[0].value] = r2(String(c[c.length - 1].value || '').replace(/,/g, ''));
            if (row.Rows) walk(row.Rows.Row);
        }
    })((report.Rows || {}).Row);
    return out;
}

async function profitAndLoss(env, from, to) {
    const rep = await client.request('GET', `/reports/ProfitAndLoss?start_date=${from}&end_date=${to}&minorversion=75`, null, { env });
    const f = flattenReport(rep);
    const pick = (...names) => { for (const n of names) if (f[n] !== undefined) return f[n]; return null; };
    return {
        from, to,
        income: pick('Total Income'),
        cogs: pick('Total Cost of Goods Sold'),
        grossProfit: pick('Gross Profit'),
        expenses: pick('Total Expenses'),
        netIncome: pick('Net Income', 'Net Operating Income'),
    };
}

// ── what is still open, on both sides ──────────────────────────────────────
// ── WHAT SHE ACTUALLY OWES, AND WHAT IS ACTUALLY OWED TO HER ───────────────
// Apsara, 2026-09-26, on a $10.7M figure: "What thr hell?"
//
// She was right to shout. Summing every bill with a balance is NOT what she
// owes: QuickBooks nets each vendor's open bills against the money already
// sitting on that vendor unapplied — every prepayment wired before a load
// arrived. Her vendor balances come to $5.3M; the open bills come to $10.7M;
// the $5.4M between them is prepayments that have never been applied to a
// bill. The vendor and customer balances are the answer to "what do I owe";
// the open documents are the answer to "which ones"; and the gap between them
// is its own finding. All three are shown, none of them pretends to be the
// others.
async function partyBalances(env) {
    const opts = { env };
    const sum = async (table) => {
        const rows = await pull(table, 'Active in (true, false)', opts, 4000);
        const owed = rows.filter((x) => Number(x.Balance) > 0);
        const credit = rows.filter((x) => Number(x.Balance) < 0);
        return {
            net: r2(rows.reduce((s, x) => s + Number(x.Balance || 0), 0)),
            owed: r2(owed.reduce((s, x) => s + Number(x.Balance), 0)),
            credit: r2(credit.reduce((s, x) => s + Number(x.Balance), 0)),
            count: owed.length, creditCount: credit.length,
            top: owed.sort((a, b) => b.Balance - a.Balance).slice(0, 12)
                .map((x) => ({ id: String(x.Id), name: x.DisplayName, balance: r2(x.Balance) })),
        };
    };
    const [vendor, customer] = await Promise.all([sum('Vendor'), sum('Customer')]);
    return { vendor, customer };
}

async function openItems(env, { year = null } = {}) {
    const opts = { env };
    // Apsara, 2026-09-26: "Just focus only on 2026". Anything older is still
    // real money, so it is counted and named on one line rather than dropped.
    const since = year ? `${year}-01-01` : null;
    const [inv, bills] = await Promise.all([
        pull('Invoice', "Balance > '0'", opts, 3000),
        pull('Bill', "Balance > '0'", opts, 3000),
    ]);
    const today = new Date();
    const age = (d) => Math.floor((today - new Date(d)) / 864e5);
    const shape = (x, ref, kind) => ({
        kind, id: String(x.Id), doc: String(x.DocNumber || '').trim(), date: x.TxnDate, due: x.DueDate || null,
        party: (x[ref] || {}).name || '', partyId: String((x[ref] || {}).value || ''),
        total: r2(x.TotalAmt), balance: r2(x.Balance), days: age(x.TxnDate),
    });
    const split = (rows, ref, kind) => {
        const all = rows.map((x) => shape(x, ref, kind)).sort((a, b) => b.balance - a.balance);
        if (!since) return { rows: all, older: { count: 0, total: 0 } };
        const inYear = all.filter((x) => String(x.date) >= since);
        const older = all.filter((x) => String(x.date) < since);
        return { rows: inYear, older: { count: older.length, total: r2(older.reduce((s, x) => s + x.balance, 0)),
            oldest: older.length ? older.map((x) => x.date).sort()[0] : null } };
    };
    const arSplit = split(inv, 'CustomerRef', 'invoice');
    const apSplit = split(bills, 'VendorRef', 'bill');
    const ar = arSplit.rows;
    const ap = apSplit.rows;
    const bucket = (rows) => {
        const b = { current: 0, d30: 0, d60: 0, d90: 0 };
        for (const x of rows) {
            const days = x.due ? Math.floor((today - new Date(x.due)) / 864e5) : x.days;
            if (days <= 0) b.current = r2(b.current + x.balance);
            else if (days <= 30) b.d30 = r2(b.d30 + x.balance);
            else if (days <= 60) b.d60 = r2(b.d60 + x.balance);
            else b.d90 = r2(b.d90 + x.balance);
        }
        return b;
    };
    return {
        ar: { count: ar.length, total: r2(ar.reduce((s, x) => s + x.balance, 0)), aging: bucket(ar), rows: ar.slice(0, 100), older: arSplit.older },
        ap: { count: ap.length, total: r2(ap.reduce((s, x) => s + x.balance, 0)), aging: bucket(ap), rows: ap.slice(0, 100), older: apSplit.older },
    };
}

async function accounts(env) {
    const r = await client.query(
        "select Id, Name, AccountType, AccountSubType, CurrentBalance from Account where Active = true", { env });
    return (r.Account || []).map((a) => ({ id: String(a.Id), name: a.Name, type: a.AccountType, sub: a.AccountSubType, balance: r2(a.CurrentBalance) }));
}

// ── the one screen that answers "how are we doing" ─────────────────────────
async function overview(env = auth.qbEnv(), { year } = {}) {
    const y = year || new Date().getFullYear();
    return cached(`overview|${env}|${y}`, 5 * 60 * 1000, async () => {
        const [pl, open, accs, ci, bal] = await Promise.all([
            profitAndLoss(env, `${y}-01-01`, `${y}-12-31`).catch((e) => ({ error: e.message })),
            openItems(env, { year: y }).catch((e) => ({ error: e.message })),
            accounts(env).catch(() => []),
            client.companyInfo({ env }).catch(() => ({})),
            partyBalances(env).catch(() => null),
        ]);
        const of = (type) => accs.filter((a) => a.type === type);
        return {
            company: ci.CompanyName || null, env, year: y, at: new Date().toISOString(),
            pl, ar: open.ar || null, ap: open.ap || null, error: open.error || null,
            // What QuickBooks itself says each side comes to, after it nets
            // prepayments off. This is the figure that answers "what do I
            // owe" — the open documents below only answer "which ones".
            owe: bal ? { total: bal.vendor.net, vendors: bal.vendor.count, prepaid: bal.vendor.credit,
                prepaidVendors: bal.vendor.creditCount, top: bal.vendor.top,
                unapplied: open.ap ? r2(open.ap.total - bal.vendor.net) : null } : null,
            owedToYou: bal ? { total: bal.customer.net, customers: bal.customer.count, credits: bal.customer.credit,
                top: bal.customer.top, unapplied: open.ar ? r2(open.ar.total - bal.customer.net) : null } : null,
            banks: of('Bank').concat(of('Credit Card')),
            receivable: of('Accounts Receivable'), payable: of('Accounts Payable'),
        };
    });
}

// ── everything QuickBooks holds for one party ──────────────────────────────
// The tab that means she does not have to go and look.
const DOCS = {
    vendor: [['Bill', 'VendorRef', 'bill'], ['BillPayment', 'VendorRef', 'payment'], ['Purchase', 'EntityRef', 'expense'], ['VendorCredit', 'VendorRef', 'credit']],
    customer: [['Invoice', 'CustomerRef', 'invoice'], ['Payment', 'CustomerRef', 'payment'], ['CreditMemo', 'CustomerRef', 'credit'], ['SalesReceipt', 'CustomerRef', 'receipt']],
};
function containersIn(x) {
    const text = [(x.Line || []).map((l) => l.Description || '').join(' '), x.PrivateNote || '', (x.CustomerMemo || {}).value || ''].join(' ');
    return [...new Set(text.match(/[A-Z]{4}\d{7}/g) || [])];
}
function shapeDoc(x, ref, kind) {
    return {
        kind, id: String(x.Id), doc: String(x.DocNumber || '').trim(), date: x.TxnDate,
        party: (x[ref] || {}).name || '', partyId: String((x[ref] || {}).value || ''),
        total: r2(x.TotalAmt), balance: x.Balance === undefined ? null : r2(x.Balance),
        containers: containersIn(x),
        lines: (x.Line || []).filter((l) => l.DetailType !== 'SubTotalLineDetail').slice(0, 12).map((l) => ({
            what: l.Description || ((l.SalesItemLineDetail || l.ItemBasedExpenseLineDetail || {}).ItemRef || {}).name
                || ((l.AccountBasedExpenseLineDetail || {}).AccountRef || {}).name || '',
            amount: r2(l.Amount),
        })),
        memo: x.PrivateNote || (x.CustomerMemo || {}).value || '',
    };
}
async function partyDocs(kind, qbId, env = auth.qbEnv()) {
    if (!qbId) return { docs: [], total: 0 };
    const k = kind === 'customer' ? 'customer' : 'vendor';
    return cached(`docs|${env}|${k}|${qbId}`, 3 * 60 * 1000, async () => {
        const out = []; const failed = [];
        for (const [table, ref, label] of DOCS[k]) {
            try {
                const rows = await pull(table, `${ref} = '${q1(qbId)}'`, { env }, 2000);
                out.push(...rows.map((x) => shapeDoc(x, ref, label)));
            } catch (e) { failed.push(`${table}: ${e.message}`); }
        }
        // One entity type missing must not lose the rest — but it must not
        // pass silently either, or a short list reads as the whole truth.
        if (failed.length === DOCS[k].length) throw new Error(failed[0]);
        out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
        const money = (kinds) => r2(out.filter((d) => kinds.includes(d.kind)).reduce((s, d) => s + d.total, 0));
        return {
            docs: out,
            couldNotRead: failed.length ? failed : null,
            totals: {
                documents: out.length,
                billed: money(['bill', 'expense']), invoiced: money(['invoice', 'receipt']),
                paid: money(['payment']), credited: money(['credit']),
                open: r2(out.reduce((s, d) => s + (d.balance || 0), 0)),
            },
        };
    });
}

// ── find one document, the way she would search in QuickBooks ──────────────
// A ticket number, an invoice number, a container, or an amount. Whatever she
// has in her hand when the question comes up.
async function find(query, env = auth.qbEnv(), { since = null } = {}) {
    const q = String(query || '').trim();
    if (!q) return { hits: [], how: null };
    const opts = { env };
    const TABLES = [['Invoice', 'CustomerRef', 'invoice'], ['Bill', 'VendorRef', 'bill'], ['Purchase', 'EntityRef', 'expense'],
        ['Payment', 'CustomerRef', 'payment'], ['BillPayment', 'VendorRef', 'payment'], ['CreditMemo', 'CustomerRef', 'credit'],
        ['SalesReceipt', 'CustomerRef', 'receipt']];
    const hits = [];
    // A search that could not reach QuickBooks must never come back looking
    // like a search that found nothing. Every failure is kept and reported.
    const failed = [];
    const add = (rows, ref, label, how) => { for (const x of rows) hits.push({ ...shapeDoc(x, ref, label), how }); };
    const tryPull = async (t, where, ref, label, how, cap, filter) => {
        try {
            const rows = await pull(t, where, opts, cap);
            add(filter ? rows.filter(filter) : rows, ref, label, how);
        } catch (e) { failed.push(`${t}: ${e.message}`); }
    };

    // 1. a document number, whole or partial — what she has most often
    for (const [t, ref, label] of TABLES) {
        if (t === 'Payment' || t === 'BillPayment') continue;      // no DocNumber worth searching
        await tryPull(t, `DocNumber like '%${q1(q)}%'`, ref, label, 'document number', 200);
    }
    // 2. an exact amount
    const amount = Number(q.replace(/[$,]/g, ''));
    if (!hits.length && isFinite(amount) && amount > 0) {
        for (const [t, ref, label] of TABLES) await tryPull(t, `TotalAmt = '${amount}'`, ref, label, 'amount', 100);
    }
    // 3. a container. QuickBooks cannot search a line description, so this
    // reads the period and looks itself — bounded, and it says so when the
    // window is the reason something was not found.
    let scanned = null;
    if (!hits.length && /^[A-Z]{4}\d{7}$/i.test(q.replace(/\s/g, ''))) {
        const from = since || `${new Date().getFullYear() - 1}-01-01`;
        scanned = from;
        for (const [t, ref, label] of TABLES) {
            await tryPull(t, `TxnDate >= '${from}'`, ref, label, 'container', 4000,
                (x) => containersIn(x).some((c) => KEY(c) === KEY(q)));
        }
    }
    hits.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return { hits: hits.slice(0, 60), how: hits.length ? hits[0].how : null, scannedFrom: scanned, query: q,
        // Everything that could not be searched, so an empty answer is never
        // mistaken for an answer.
        couldNotLook: failed.length ? [...new Set(failed)] : null };
}

module.exports = { overview, partyDocs, find, openItems, partyBalances, profitAndLoss, accounts, forget, flattenReport, containersIn, shapeDoc };
