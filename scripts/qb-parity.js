#!/usr/bin/env node
// ── scripts/qb-parity.js — does Jarvis agree with QuickBooks? ────────────
//
//     node scripts/qb-parity.js
//     node scripts/qb-parity.js --top 40
//
// Apsara's goal, in her words: QuickBooks goes in January 2027 and "accounts
// should be perfectly handled" to "convince owner to let go of qb". Task #176.
//
// The owner will ask one question — does your system agree with the books we
// already trust? — and the answer has to be a NUMBER, per party, that he can
// spot-check. This prints it. READ-ONLY: it reads her stores and the snapshot
// and writes nothing anywhere.
//
// ── BOTH SIDES THROUGH THE HELPER THE SCREEN ALREADY USES ───────────────
// helpers/metalsReports.js' rule: read through the SAME helper the screen's
// route calls, so Jarvis and the screen cannot disagree. So what she owes
// comes from bills.listWithTotals() filtered on balance > 0.005 — the exact
// expression in routes/money.js:9 behind the pay screen — and what she is owed
// from sales.listWithTotals(), the expression at routes/money.js:234. A parity
// report that re-derived its own totals could show green while her screen
// showed something else, which is worse than no report.
//
// ── THE JOIN IS HER OWN MAPPING, NEVER A FUZZY GUESS ────────────────────
// data/qb-party-map.json is a human-confirmed map she built on 2026-09-21:
// jarvis name -> {qbName, qbId}, each entry stamped with `by`. That is the
// join. Beyond it, only an EXACT normalised-name match via
// helpers/nameMatch.normalizeName, which ignores spacing and punctuation and
// nothing else. No fuzzy matching anywhere: her yard has a Rigo AND a Rego,
// and guessing between two suppliers is how money lands on the wrong one.
// Anything unmatched is LISTED, not silently dropped — an unmatched party is
// the most likely place for a real disagreement to hide.
require('dotenv').config();

const path = require('path');
const ROOT = path.join(__dirname, '..');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
const TOP = Number(flag('--top', 20)) || 20;
const CENT = 0.005;
const money = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(Number(n) || 0)
    .toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const nameMatch = require(path.join(ROOT, 'helpers/nameMatch'));
const norm = (s) => nameMatch.normalizeName(String(s || '')) || '';

// ── JARVIS ──────────────────────────────────────────────────────────────
// ── AN EMPTY STORE IS NOT "NOTHING OUTSTANDING" ─────────────────────────
// helpers/json.js' loadJson never throws — it returns the default. So a
// MISSING bills.json yields [], which totals to $0.00, which reads on this
// report as "she owes nobody anything" and would be shown to the owner as
// perfect agreement with a QuickBooks figure of zero. Found on 2026-10-28
// running this on a machine whose data/ is a thin dev copy: it printed
// "Jarvis $0.00 across 0 parties" with no hint that the store was absent.
//
// So the row count of the raw store is checked separately from the totals,
// and an empty one is reported as MISSING DATA rather than as a figure.
const storeEmpty = [];
function noteIfEmpty(label, n) { if (!n) storeEmpty.push(label); return n; }

function jarvisOwes() {
    const bills = require(path.join(ROOT, 'helpers/bills'));
    noteIfEmpty('bills (what she owes)', bills.list().length);
    const out = new Map();
    for (const x of bills.listWithTotals()) {
        if (x.balance === null || !(x.balance > CENT)) continue;
        const k = norm(x.supplier);
        if (!k) continue;
        const cur = out.get(k) || { name: x.supplier, open: 0, rows: 0 };
        cur.open = r2(cur.open + x.balance); cur.rows += 1;
        out.set(k, cur);
    }
    return out;
}
function jarvisOwed() {
    const sales = require(path.join(ROOT, 'helpers/sales'));
    noteIfEmpty('sales (what she is owed)', sales.list().length);
    const out = new Map();
    for (const x of sales.listWithTotals()) {
        if (x.balance === null || !(x.balance > CENT)) continue;
        const k = norm(x.customer);
        if (!k) continue;
        const cur = out.get(k) || { name: x.customer, open: 0, rows: 0 };
        cur.open = r2(cur.open + x.balance); cur.rows += 1;
        out.set(k, cur);
    }
    return out;
}

// ── QUICKBOOKS ──────────────────────────────────────────────────────────
// From the rolling snapshot, so this does not re-query QuickBooks and cannot
// disagree with scripts/qb-snapshot.js about what the books say.
function qbSide() {
    const snapshot = require(path.join(ROOT, 'helpers/quickbooks/snapshot'));
    const snap = snapshot.read();
    if (!snap) return null;
    const index = (rows, creditKey) => {
        const m = new Map();
        for (const p of rows || []) {
            const k = norm(p.name);
            if (!k) continue;
            m.set(k, { name: p.name, open: r2(p.balance), credit: r2(p[creditKey] || 0), active: p.active });
        }
        return m;
    };
    return {
        at: snap.at, env: snap.env, since: snap.since,
        owe: index(snap.suppliers, 'unapplied_paid'),
        owed: index(snap.customers, 'unapplied_received'),
        totals: snap.totals,
    };
}

// Her confirmed map, read in BOTH directions so a lookup works from whichever
// name the side in hand happens to use.
function partyMap(kind) {
    let raw = null;
    try { raw = require(path.join(ROOT, 'data/qb-party-map.json')); } catch { return new Map(); }
    const m = new Map();
    for (const [, v] of Object.entries((raw && raw[kind]) || {})) {
        if (!v || !v.jarvisName || !v.qbName) continue;
        m.set(norm(v.jarvisName), norm(v.qbName));
        m.set(norm(v.qbName), norm(v.jarvisName));
    }
    return m;
}

function compare(label, jar, qb, map, noData) {
    console.log(`\n═══ ${label} ═══`);
    const jTotal = r2([...jar.values()].reduce((s, x) => s + x.open, 0));
    const qTotal = r2([...qb.values()].reduce((s, x) => s + x.open, 0));
    console.log(`  Jarvis     ${money(jTotal).padStart(16)}   across ${jar.size} parties`);
    console.log(`  QuickBooks ${money(qTotal).padStart(16)}   across ${qb.size} parties`);
    console.log(`  difference ${money(r2(jTotal - qTotal)).padStart(16)}`
        + (noData ? '   — NOTHING TO COMPARE, the Jarvis store is empty' : ''));

    const seenQ = new Set();
    const differ = [], jarvisOnly = [];
    for (const [k, j] of jar) {
        const alt = map.get(k);
        const hit = qb.get(k) || (alt ? qb.get(alt) : null);
        if (!hit) { jarvisOnly.push(j); continue; }
        seenQ.add(qb.has(k) ? k : alt);
        const d = r2(j.open - hit.open);
        if (Math.abs(d) > CENT) differ.push({ j, q: hit, d });
    }
    const qbOnly = [...qb].filter(([k]) => !seenQ.has(k)
        && !jar.has(k) && !(map.get(k) && jar.has(map.get(k)))).map(([, v]) => v);

    const show = (title, rows, fmt) => {
        if (!rows.length) return;
        console.log(`\n  ${title} (${rows.length})`);
        for (const r of rows.slice(0, TOP)) console.log('    ' + fmt(r));
        if (rows.length > TOP) console.log(`    … ${rows.length - TOP} more (--top ${rows.length})`);
    };
    differ.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
    show('BOTH HAVE THEM, THE FIGURES DIFFER — biggest first', differ,
        (r) => `${String(r.j.name).slice(0, 34).padEnd(34)} Jarvis ${money(r.j.open).padStart(14)}`
            + `   QB ${money(r.q.open).padStart(14)}   out by ${money(r.d)}`
            + (r.q.credit > CENT ? `   (QB also holds ${money(r.q.credit)} unapplied)` : ''));
    // Open in Jarvis and absent from QuickBooks is the shape that matters most
    // before a cutover: the owner's books would never have seen this money.
    jarvisOnly.sort((a, b) => b.open - a.open);
    show('OPEN IN JARVIS, NOT IN QUICKBOOKS', jarvisOnly,
        (r) => `${String(r.name).slice(0, 34).padEnd(34)} ${money(r.open).padStart(14)}   ${r.rows} row(s)`);
    qbOnly.sort((a, b) => b.open - a.open);
    show('OPEN IN QUICKBOOKS, NOT IN JARVIS', qbOnly.filter((r) => Math.abs(r.open) > CENT),
        (r) => `${String(r.name).slice(0, 34).padEnd(34)} ${money(r.open).padStart(14)}`);

    const agreed = jar.size - differ.length - jarvisOnly.length;
    // "0 of 0 agree" is not a result, it is an empty store wearing a result's
    // clothes. Say nothing rather than something meaningless.
    if (jar.size) {
        console.log(`\n  ${agreed} of ${jar.size} Jarvis parties agree with QuickBooks to the cent.`);
    }

    // ── THE TOTALS MATCHING IS NOT THE BOOKS AGREEING ───────────────────
    // This printed "they agree to the cent" on the totals line, before any
    // party had been looked at. Its own test fixture then produced the worst
    // possible output: Jarvis $1,000.00, QuickBooks $1,000.00, "they agree to
    // the cent" — and underneath, Rigo open in Jarvis, Rego open in
    // QuickBooks, ZERO parties reconciling. Two different suppliers whose
    // balances happen to sum alike.
    //
    // That sentence is the one thing on this report an owner would take at
    // face value, so it now requires what it claims: the totals match AND
    // every party reconciles AND there was data to compare. Offsetting errors
    // are the normal way a reconciliation looks right and is wrong.
    const qbOnlyReal = qbOnly.filter((r) => Math.abs(r.open) > CENT).length;
    const trulyAgreed = !noData && Math.abs(jTotal - qTotal) < CENT
        && !differ.length && !jarvisOnly.length && !qbOnlyReal;
    if (trulyAgreed) {
        console.log('  AGREED — the totals match and every party reconciles.');
    } else if (!noData && Math.abs(jTotal - qTotal) < CENT) {
        console.log('  The totals match, but the parties do NOT reconcile — errors on both sides'
            + ' that happen to cancel out. Do not report this as agreement.');
    }
    return { jTotal, qTotal, differ: differ.length, jarvisOnly: jarvisOnly.length,
        qbOnly: qbOnlyReal, agreed: trulyAgreed };
}

(() => {
    const qb = qbSide();
    if (!qb) {
        console.error('No QuickBooks snapshot on disk. Run: node scripts/qb-snapshot.js');
        process.exit(1);
    }
    console.log(`Jarvis vs QuickBooks · snapshot ${String(qb.at).slice(0, 16)} · env ${qb.env} · since ${qb.since}`);
    if (qb.env !== 'production') console.log('  NOTE: sandbox snapshot — this is not her books.');
    const age = (Date.now() - Date.parse(qb.at)) / 86400000;
    // An old snapshot makes every disagreement below meaningless, and saying
    // so loudly is the whole lesson of 2026-10-28: two duplicates reported
    // from a five-week-old pull had already been deleted.
    if (!(age < 2)) {
        console.log(`  SNAPSHOT IS ${Math.round(age)} DAYS OLD — refresh before trusting any figure here:`);
        console.log('      node scripts/qb-snapshot.js');
    }
    // Stated rather than assumed. QuickBooks holds whichever companies her
    // file holds; Jarvis's bills and sales stores are Edge Metals. If her QB
    // file also carries Edge Trading or the yard, those parties land in
    // "OPEN IN QUICKBOOKS, NOT IN JARVIS" and are not errors.
    console.log('  Comparing Edge Metals bills and sales against the whole QuickBooks file.');

    const jOwes = jarvisOwes();
    const jOwed = jarvisOwed();
    if (storeEmpty.length) {
        console.log('');
        for (const label of storeEmpty) {
            console.log(`  !! NO DATA: the Jarvis ${label} store is empty or absent on this machine.`);
        }
        console.log('     $0.00 below is the absence of data, NOT a zero balance. Her real stores');
        console.log('     live on the VM — run this there.');
    }
    const emptyOwes = storeEmpty.some((x) => x.startsWith('bills'));
    const emptyOwed = storeEmpty.some((x) => x.startsWith('sales'));
    const a = compare('WHAT SHE OWES (payables)', jOwes, qb.owe, partyMap('vendor'), emptyOwes);
    const b = compare('WHAT SHE IS OWED (receivables)', jOwed, qb.owed, partyMap('customer'), emptyOwed);

    console.log('\n───────────────────────────────────────────────────────────');
    if (storeEmpty.length) {
        console.log('NOT A PARITY RESULT: ' + storeEmpty.join(' and ')
            + ' had no rows to compare. Nothing above is evidence of anything.');
        console.log('Nothing was changed on either side.');
        return;
    }
    const clean = a.agreed && b.agreed;
    console.log(clean
        ? 'Every Jarvis party matches QuickBooks to the cent. That is the line to show the owner.'
        : `${a.differ + b.differ} parties disagree, ${a.jarvisOnly + b.jarvisOnly} are open in Jarvis `
          + 'and absent from QuickBooks. Each one is a question, not necessarily an error.');
    console.log('Nothing was changed on either side.');
})();
