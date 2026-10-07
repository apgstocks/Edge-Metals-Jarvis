#!/usr/bin/env node
// ── scripts/where-are-the-carriers.js ─────────────────────────────────────
// Apsara, 2026-10-07: "zimex ,eagle brit,pan metal ,tql,schneider,aj
// transport,sher,jio bills are not there..."
//
// ── WHY A SECOND SCRIPT AND NOT MORE GUESSING ────────────────────────────
// scripts/trucking-double-count.js answered what it was built for and ruled
// out two theories at once: the trucker bills store is EMPTY (0 rows) and so
// is carrier_invoices (0 rows). So nothing is double counted, and nothing of
// theirs is sitting in either of those stores being ignored.
//
// Meanwhile 118 Edge Metals bills carry $92,279.20 of haulage between them.
// So her carriers ARE in Jarvis — the question is under which name, in which
// store, and whether anything of theirs is recorded nowhere.
//
// This counts, per carrier, across every place a carrier's money could be,
// and prints where it found them. It does not decide anything and does not
// write. The point is to stop me theorising about her data from 2,000 miles
// away: after this run, "their bills are not there" has a specific meaning.
//
//   node scripts/where-are-the-carriers.js
//   node scripts/where-are-the-carriers.js --rows    name every row it found
//
// Reads only. Safe on the live VM.

const path = require('path');
const ROOT = path.join(__dirname, '..');
const ROWS = process.argv.includes('--rows');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
const money = (n) => `$${r2(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Her eight, with the spellings each one actually appears under. Matched on a
// squashed substring so "AJ Transport", "aj-transport" and "AJTRANSPORT" are
// one carrier — the lesson helpers/partyName.js was extracted for.
const CARRIERS = [
    ['Zimex', ['zimex']],
    ['EagleBrit', ['eaglebrit', 'eagletrans', 'eagle']],
    ['Pan Metal', ['panmetal']],
    ['TQL', ['tql', 'totalquality']],
    ['Schneider', ['schneider']],
    ['AJ Transport', ['ajtransport', 'aj']],
    ['Sher', ['sher', 'shertrucking']],
    ['Jio', ['jio']],
];
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

// ── A SHORT NAME MATCHES A WHOLE WORD, NOT THE WHOLE STRING ──────────────
// The first version read `n.length <= 3 ? v === n : v.includes(n)` on the
// SQUASHED value, to stop "aj" matching "AJAX". It also meant "Jio Transport"
// squashed to "jiotransport", which is not equal to "jio" — so 28 bills
// naming Jio reported "NOTHING ANYWHERE". TQL would have failed identically.
//
// That is the worst output this script can produce: a confident claim that a
// carrier is absent, on data where it is present and correctly booked. So a
// short needle now has to equal one WORD of the raw name — "jio" matches
// "Jio Transport" and still does not match "AJAX" — and only a longer needle
// is allowed the loose squashed-substring test.
const hit = (value, needles) => {
    const v = squash(value);
    if (!v) return false;
    const w = words(value);
    // THRESHOLD 6, and both failures that set it are worth keeping named:
    //   · at "<= 3 equals the whole squashed string", "Jio Transport" reported
    //     NOTHING ANYWHERE on 28 bills that name Jio.
    //   · at "<= 3 matches a word", "sher" (4 chars) fell through to the loose
    //     substring test and matched "FiSHER Metals" — a SUPPLIER counted as a
    //     carrier, which is the same error pointing the other way.
    // So a plain name must match a whole word, and only a CONCATENATION of a
    // multi-word name ("shertrucking", "ajtransport", "panmetal",
    // "totalquality") is long enough to be safe as a substring.
    return needles.some((n) => (n.length < 6 ? w.includes(n) : v.includes(n)));
};

const safe = (label, fn) => { try { return fn(); } catch (e) { return { __err: `${label}: ${e.message}` }; } };

function main() {
    const errs = [];
    const grab = (label, fn) => {
        const r = safe(label, fn);
        if (r && r.__err) { errs.push(r.__err); return []; }
        return Array.isArray(r) ? r : [];
    };

    const bills = grab('bills', () => require(path.join(ROOT, 'helpers/bills')).listWithTotals());
    const sales = grab('sales', () => require(path.join(ROOT, 'helpers/sales')).listWithTotals());
    const truckerBills = grab('trucker_bills', () => require(path.join(ROOT, 'helpers/truckerBills')).listBills());
    const carrierInv = grab('carrier_invoices', () => require(path.join(ROOT, 'helpers/carrierInvoices')).list());
    const expenses = grab('expenses', () => require(path.join(ROOT, 'helpers/expenses')).loadExpenses());
    const settlements = grab('sales_settlements', () => require(path.join(ROOT, 'helpers/salesSettlements')).list());
    const metalsTrk = grab('metals_trucking', () => require(path.join(ROOT, 'helpers/metalsTrucking')).list());

    // ── WHERE A CARRIER'S MONEY CAN LIVE ─────────────────────────────────
    // One row per place, each saying how to read a carrier name and an amount
    // out of it. Written as data so a place nobody thought of can be added
    // without touching the counting.
    const PLACES = [
        ['bills.trucking_company', bills,
         (b) => b.trucking_company,
         (b) => num(b.trucking_amount_used != null ? b.trucking_amount_used : b.trucking_amount),
         'IN THE BOOKS — inside material at gross, plus 2050 accrued trucking'],
        ['sales.charges (freight)', sales.flatMap((s) => (s.charges || []).map((c) => ({ s, c }))),
         (x) => x.c.what || x.c.label || x.c.why,
         (x) => num(x.c.amount),
         'IN THE BOOKS — a cost settled against the sale'],
        ['trucker_bills', truckerBills,
         (t) => t.trucker || t.carrier,
         (t) => num(t.amount),
         'IN THE BOOKS as EDGE YARD\'s cost — see trucking-double-count.js'],
        ['carrier_invoices', carrierInv,
         (c) => c.carrier,
         (c) => num(c.amount || c.total),
         'NOT IN THE BOOKS — booksBuild never reads this store'],
        ['metals_trucking (payments)', metalsTrk,
         (p) => p.trucking_company,
         (p) => num(p.amount),
         'money already PAID to them'],
        ['sales_settlements (payments)', settlements,
         (p) => p.payee,
         (p) => num(p.amount),
         'money already PAID to them'],
        ['expenses', expenses,
         (x) => x.payee || x.description,
         (x) => num(x.amount),
         'IN THE BOOKS — by expense category'],
    ];

    console.log('\n── WHERE EACH CARRIER ACTUALLY IS ─────────────────────────────────\n');
    const placeTotals = new Map();

    for (const [name, needles] of CARRIERS) {
        const found = [];
        for (const [place, rows, nameOf, amountOf] of PLACES) {
            const mine = rows.filter((r) => r && hit(nameOf(r), needles));
            if (!mine.length) continue;
            const sum = r2(mine.reduce((t, r) => t + amountOf(r), 0));
            found.push({ place, n: mine.length, sum, rows: mine });
            const cur = placeTotals.get(place) || { n: 0, sum: 0 };
            cur.n += mine.length; cur.sum = r2(cur.sum + sum);
            placeTotals.set(place, cur);
        }
        if (!found.length) {
            console.log(`  ${name.padEnd(14)} NOTHING ANYWHERE — no row in Jarvis names them`);
            continue;
        }
        const total = r2(found.reduce((t, f) => t + f.sum, 0));
        console.log(`  ${name.padEnd(14)} ${money(total).padStart(14)} across ${found.length} place(s)`);
        for (const f of found) {
            console.log(`      ${f.place.padEnd(28)} ${String(f.n).padStart(4)} row(s)  ${money(f.sum).padStart(14)}`);
            if (ROWS) {
                for (const r of f.rows.slice(0, 8)) {
                    console.log(`          ${(r.id || (r.s && r.s.id) || '?')}  ${r.date || (r.s && r.s.date) || ''}  `
                        + `${r.container_no || (r.s && r.s.container_no) || ''}`);
                }
                if (f.rows.length > 8) console.log(`          … ${f.rows.length - 8} more`);
            }
        }
    }

    console.log('\n── AND WHAT EACH PLACE MEANS FOR THE BOOKS ────────────────────────\n');
    for (const [place, , , , meaning] of PLACES) {
        const t = placeTotals.get(place);
        if (!t) continue;
        console.log(`  ${place}`);
        console.log(`      ${t.n} row(s), ${money(t.sum)} — ${meaning}\n`);
    }

    const missing = CARRIERS.filter(([, needles]) =>
        !PLACES.some(([, rows, nameOf]) => rows.some((r) => r && hit(nameOf(r), needles))));
    if (missing.length) {
        console.log('── CARRIERS JARVIS HAS NEVER HEARD OF ─────────────────────────────\n');
        for (const [name] of missing) console.log(`  ${name}`);
        console.log('\n  Their invoices are not in Jarvis at all — not mis-filed, not');
        console.log('  mis-booked, simply never entered. No statement can show them, and');
        console.log('  no script can find money that was never recorded.\n');
    }

    if (errs.length) {
        console.log('── STORES THAT WOULD NOT LOAD ─────────────────────────────────────\n');
        for (const e of errs) console.log(`  ${e}`);
        console.log('\n  Counts above are missing whatever is in these.\n');
    }
}

main();
