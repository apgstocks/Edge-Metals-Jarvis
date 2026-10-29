// ── helpers/booksClose.js — is a MONTH closed, and if not, what is open? ──
//
// Apsara, 2026-10-29: "lets work on quickbook/books using banks and fix
// accounting first till october" / "This is the biggest headache for us".
//
// Twenty-three scripts already answer slices of this. None of them answers
// the question she actually asked, which has two halves and a date range:
//
//   1. BANK AS TRUTH.  Every transaction that really moved between
//      01-01-2026 and 31-10-2026 is either matched to something she
//      recorded, categorised to an account, or deliberately set aside with
//      a reason. The ones that are none of those are the accounting, in a
//      list, shortest first.
//   2. QUICKBOOKS AS WITNESS.  Per month, what Jarvis says it billed and
//      invoiced versus what QuickBooks says. Any month where those differ
//      is a month she cannot defend to the owner.
//
// Half 1 finds money that was never recorded at all. Half 2 cannot: if a
// bill is missing from both systems they agree, and they are both wrong.
// That asymmetry is why the bank half leads and why both are reported.
//
// ── READ-ONLY ────────────────────────────────────────────────────────────
// Reads stores, derives, returns. Writes nothing, posts nothing, ticks
// nothing. A report that fixes things while reporting cannot be run twice.
//
// ── THE THREE WAYS THIS COULD LIE, AND WHAT STOPS EACH ───────────────────
// Every one of these has already happened in this codebase, which is the
// only reason they are guarded:
//
//   · A MISSING STORE READS AS AGREEMENT. qb-parity once reported "they
//     agree to the cent" with zero parties reconciled, because an absent
//     bills.json summed to $0.00 and QuickBooks also had nothing for those
//     parties. A missing file is NO DATA. It is never a figure, never a
//     zero, and it never contributes to a verdict.
//   · A TRUNCATED SNAPSHOT READS AS A YEAR. QuickBooks' query API caps a
//     page at 1000 rows and says nothing about it. An unpaginated pull of a
//     busy year returns exactly 1000 and looks complete. Any snapshot whose
//     count is an exact multiple of 1000 is refused, not used.
//   · A SNAPSHOT OLDER THAN THE WINDOW READS AS COVERING IT. A snapshot
//     taken in June cannot say anything about September. If its `until` is
//     before the end of the period, it is refused.
//
// When anything is refused the period gets a BLOCKER. A blocker means the
// answer is not an answer, and `closed` is false no matter how good the
// figures that did arrive look. Silence on a blocker is how a wrong set of
// books gets signed off.

const fs = require('fs');
const path = require('path');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => {
    if (v === null || v === undefined || v === '') return 0;
    const n = Number(String(v).replace(/[$,]/g, ''));
    return Number.isFinite(n) ? n : 0;
};

// ── ONE MONTH KEY, FROM EITHER DATE SHAPE ────────────────────────────────
// Her documents carry MM/DD/YYYY (helpers/time.js:2 — "All freight dates are
// MM/DD/YYYY"). Plaid rows carry YYYY-MM-DD. QuickBooks carries YYYY-MM-DD
// in TxnDate. Guessing between them is how a January row lands in December,
// so both are parsed explicitly and anything else returns null rather than
// being coerced into a month it does not belong to.
function ym(value) {
    const s = String(value || '').trim();
    if (!s) return null;
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return `${m[1]}-${m[2]}`;
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
    if (m) return `${m[3]}-${String(m[1]).padStart(2, '0')}`;
    return null;
}

function ymd(value) {
    const s = String(value || '').trim();
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
    if (m) return `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
    return null;
}

// Inclusive both ends, on the string, because YYYY-MM-DD sorts correctly and
// a Date object here would reintroduce the timezone question that
// helpers/time.js exists to settle.
const inWindow = (d, from, to) => !!d && d >= from && d <= to;

function monthsBetween(from, to) {
    const out = [];
    let [y, m] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))];
    const [ey, em] = [Number(to.slice(0, 4)), Number(to.slice(5, 7))];
    while (y < ey || (y === ey && m <= em)) {
        out.push(`${y}-${String(m).padStart(2, '0')}`);
        m += 1;
        if (m > 12) { m = 1; y += 1; }
    }
    return out;
}

// ── EXPLAINED ────────────────────────────────────────────────────────────
// Deliberately NOT bankLedger.actedOn, which also counts `history`. History
// means the BANK restated the row — new information about an amount, not a
// decision by her. Counting it here would report rows as explained because
// Plaid changed its mind about them, which is the opposite of the truth and
// would quietly inflate the coverage figure this whole report rests on.
//
// Pending rows are excluded from the denominator entirely: money that has
// not settled is not yet part of a closed month.
const explainedBy = (row) => (row.matched ? 'matched'
    : row.excluded ? 'set aside'
    : row.category ? 'categorised'
    : null);

function storeState(file) {
    if (!file) return { ok: false, why: 'no path configured' };
    if (!fs.existsSync(file)) return { ok: false, why: `${path.basename(file)} is not on this machine` };
    return { ok: true };
}

// ── THE BANK HALF ────────────────────────────────────────────────────────
function bankHalf(from, to, months) {
    const cfg = require('../config');
    const st = storeState(cfg.BANK_TX_FILE);
    if (!st.ok) {
        return { nodata: `bank feed unreadable — ${st.why}`, byMonth: null };
    }
    const ledger = require('./bankLedger');
    const all = ledger.list().filter(Boolean);

    const byMonth = {};
    for (const k of months) {
        byMonth[k] = { rows: 0, settled: 0, explained: 0, pending: 0,
            unexplained: { count: 0, in: 0, out: 0, items: [] } };
    }

    let outside = 0;
    for (const row of all) {
        const d = ymd(row.date);
        if (!inWindow(d, from, to)) { outside += 1; continue; }
        const k = ym(d);
        const b = byMonth[k];
        if (!b) { outside += 1; continue; }     // a month the window does not cover
        b.rows += 1;
        if (row.pending) { b.pending += 1; continue; }
        b.settled += 1;
        if (explainedBy(row)) { b.explained += 1; continue; }
        b.unexplained.count += 1;
        const inAmt = r2(num(row.received));
        const outAmt = r2(num(row.spent));
        b.unexplained.in = r2(b.unexplained.in + inAmt);
        b.unexplained.out = r2(b.unexplained.out + outAmt);
        b.unexplained.items.push({
            id: row.id || null, date: d, desc: String(row.desc || '').slice(0, 70),
            party: row.party || null, bank: row.bank || null,
            in: inAmt || null, out: outAmt || null,
        });
    }
    // Biggest money first: the list is a worklist, and the $40,000 wire
    // matters more than the $12 card fee.
    for (const k of months) {
        byMonth[k].unexplained.items.sort(
            (a, c) => (Math.max(c.in || 0, c.out || 0)) - (Math.max(a.in || 0, a.out || 0)));
    }
    return { nodata: null, byMonth, rows_outside_window: outside, rows_total: all.length };
}

// ── THE QUICKBOOKS HALF ──────────────────────────────────────────────────
// `kind` is 'bills' or 'invoices'; each is compared against the Jarvis store
// that produces the same document, by MONTH, on the document's own date.
function snapshotUsable(snap, to, kind) {
    if (!snap) return `no ${kind} snapshot on this machine — run scripts/qb-snapshot.js`;
    if (snap.legacy) return `the ${kind} snapshot is a bare array with no provenance — `
        + 'it cannot say when it was taken or what it covers; re-run scripts/qb-snapshot.js';
    if (snap.count && snap.count % 1000 === 0) return `the ${kind} snapshot holds exactly `
        + `${snap.count} rows, an exact multiple of QuickBooks' 1000-row page cap — `
        + 'it is almost certainly one unpaginated page, not the whole period';
    if (snap.until && snap.until < to) return `the ${kind} snapshot only covers up to `
        + `${snap.until}, which is before ${to} — it cannot speak for the end of this period`;
    return null;
}

function qbHalf(from, to, months) {
    const snapshot = require('./quickbooks/snapshot');
    const cfg = require('../config');
    const out = { blockers: [], byMonth: null, env: null, taken: null };

    const sides = [
        { kind: 'bills', store: cfg.BILLS_FILE, label: 'bills',
          jarvis: () => require('./bills').listWithTotals() },
        { kind: 'invoices', store: cfg.SALES_FILE, label: 'invoices',
          jarvis: () => require('./sales').listWithTotals() },
    ];

    const byMonth = {};
    for (const k of months) byMonth[k] = {};
    let anyUsable = false;

    for (const side of sides) {
        const snap = snapshot.rows(side.kind);
        const refusal = snapshotUsable(snap, to, side.label);
        const st = storeState(side.store);
        if (refusal) out.blockers.push(refusal);
        if (!st.ok) out.blockers.push(`Jarvis ${side.label} unreadable — ${st.why}`);
        if (refusal || !st.ok) {
            for (const k of months) byMonth[k][side.label] = { nodata: true };
            continue;
        }
        anyUsable = true;
        out.env = out.env || snap.env || null;
        out.taken = out.taken || snap.at || null;

        const qbByMonth = {};
        for (const r of snap.rows) {
            const k = ym(r.TxnDate || r.txn_date || r.date);
            if (!k || !byMonth[k]) continue;
            qbByMonth[k] = r2((qbByMonth[k] || 0) + num(r.TotalAmt ?? r.total ?? r.amount));
        }
        const jByMonth = {};
        for (const r of side.jarvis()) {
            const d = ymd(r.date);
            if (!inWindow(d, from, to)) continue;
            const k = ym(d);
            if (!k || !byMonth[k]) continue;
            jByMonth[k] = r2((jByMonth[k] || 0) + num(r.amount));
        }
        for (const k of months) {
            const j = r2(jByMonth[k] || 0);
            const q = r2(qbByMonth[k] || 0);
            byMonth[k][side.label] = { jarvis: j, qb: q, diff: r2(j - q),
                agrees: Math.abs(r2(j - q)) < 0.005 };
        }
    }
    out.byMonth = anyUsable ? byMonth : null;
    if (!anyUsable) out.nodata = 'neither side of QuickBooks could be compared';
    return out;
}

// ── THE REPORT ───────────────────────────────────────────────────────────
function close({ from, to } = {}) {
    const f = ymd(from) || '2026-01-01';
    const t = ymd(to) || '2026-10-31';
    if (t < f) throw new Error('the period ends before it starts');
    const months = monthsBetween(f, t);

    const bank = bankHalf(f, t, months);
    const qb = qbHalf(f, t, months);

    const blockers = [];
    if (bank.nodata) blockers.push(bank.nodata);
    for (const b of qb.blockers) blockers.push(b);

    // A month is closed when the bank half is complete for it AND the
    // QuickBooks half agrees for it. Either half missing means NOT closed —
    // not "closed on the evidence available", which is the phrasing that
    // lets an unreconciled month through.
    const perMonth = months.map((k) => {
        const b = bank.byMonth ? bank.byMonth[k] : null;
        const q = qb.byMonth ? qb.byMonth[k] : null;
        const open = b ? b.unexplained.count : null;
        const money = b ? r2(b.unexplained.in + b.unexplained.out) : null;
        const qbParts = q ? Object.entries(q).filter(([, v]) => !v.nodata) : [];
        const qbAgrees = qbParts.length ? qbParts.every(([, v]) => v.agrees) : null;
        const qbOff = qbParts.filter(([, v]) => !v.agrees)
            .map(([label, v]) => ({ label, diff: v.diff, jarvis: v.jarvis, qb: v.qb }));
        return {
            month: k,
            bank: b ? { settled: b.settled, explained: b.explained, pending: b.pending,
                open, money, items: b.unexplained.items } : { nodata: true },
            qb: q || { nodata: true },
            closed: open === 0 && qbAgrees === true,
            why_open: [
                open === null ? 'the bank feed is not readable here' : null,
                open > 0 ? `${open} bank row${open === 1 ? '' : 's'} unexplained (${money})` : null,
                qbAgrees === null ? 'QuickBooks could not be compared' : null,
                ...qbOff.map((x) => `${x.label} differ by ${x.diff}`),
            ].filter(Boolean),
        };
    });

    const closedCount = perMonth.filter((m) => m.closed).length;
    return {
        period: { from: f, to: t },
        months,
        blockers,
        bank,
        qb: { env: qb.env, taken: qb.taken, nodata: qb.nodata || null },
        perMonth,
        // `closed` is a claim, so it is only ever made when nothing was
        // refused and every month stands up on its own.
        closed: blockers.length === 0 && closedCount === months.length,
        summary: blockers.length
            ? `cannot be assessed: ${blockers.length} blocker${blockers.length === 1 ? '' : 's'}`
            : `${closedCount} of ${months.length} months closed`,
    };
}

// ── THE PERIOD, DECIDED IN ONE PLACE ─────────────────────────────────────
// Both the script and the 07:05 agent ask for "the closable year so far",
// and they must mean the same thing or her morning mail and her terminal
// will disagree about whether September is done. Same reason metalsReports
// reads through the helper the screen's route calls.
//
// The month you are standing in is never closable: rows are still arriving.
// So the window ends at the last day of LAST month, in the yard's own zone —
// helpers/time.todayLocal(), not UTC, because for the seven hours after 5pm
// Pacific a UTC clock has already turned the month over.
const START_OF_BOOKS = '2026-01-01';

function lastClosableWindow(today = null) {
    const t = require('./time');
    const day = ymd(today) || t.todayLocal();
    const y = Number(day.slice(0, 4));
    const m = Number(day.slice(5, 7));
    const ly = m === 1 ? y - 1 : y;
    const lm = m === 1 ? 12 : m - 1;
    // Day 0 of the next month is the last day of this one, and Date.UTC
    // handles February and leap years so this does not have to.
    const last = new Date(Date.UTC(ly, lm, 0)).getUTCDate();
    return { from: START_OF_BOOKS,
        to: `${ly}-${String(lm).padStart(2, '0')}-${String(last).padStart(2, '0')}` };
}

module.exports = { close, ym, ymd, monthsBetween, explainedBy, snapshotUsable, inWindow,
    lastClosableWindow, START_OF_BOOKS };
