#!/usr/bin/env node
// ── scripts/books-close.js — which months are actually closed? ───────────
//
//     node scripts/books-close.js
//     node scripts/books-close.js --from 2026-01-01 --to 2026-10-31
//     node scripts/books-close.js --month 2026-09        (one month, in full)
//     node scripts/books-close.js --open                 (only what is open)
//
// Apsara, 2026-10-29: "lets work on quickbook/books using banks and fix
// accounting first till october". Defaults to 01-01-2026 through the end of
// last month, because the month you are standing in is not closable yet.
//
// Prints, per month: how many bank rows are still unexplained and what they
// are worth, then whether Jarvis and QuickBooks agree on bills and invoices.
// A month is CLOSED only when both halves are clean. Anything refused is
// printed first, under BLOCKERS, and while there is a blocker no month count
// is given at all — a partial answer that looks like a full one is the
// failure this whole thing is built to avoid.
//
// READ-ONLY. Writes nothing, ticks nothing, posts nothing.

const path = require('path');
const ROOT = path.join(__dirname, '..');

const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
const has = (n) => process.argv.includes(n);

const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-US',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });

(function main() {
    const C = require(path.join(ROOT, 'helpers/booksClose'));
    const one = arg('--month');
    // The default period comes from the helper, not from a copy here: the
    // 07:05 agent asks the same question and the two must not be able to
    // disagree about whether September is closable.
    const def = C.lastClosableWindow();
    const win = one
        ? { from: `${one}-01`, to: `${one}-31` }
        : { from: arg('--from') || def.from, to: arg('--to') || def.to };

    const r = C.close(win);

    console.log(`\nBOOKS CLOSE — ${r.period.from} to ${r.period.to}`);
    if (r.qb.taken) console.log(`QuickBooks snapshot: ${r.qb.taken}  (${r.qb.env || 'env unknown'})`);
    console.log('');

    if (r.blockers.length) {
        console.log('BLOCKERS — the answer below is incomplete until these are fixed');
        for (const b of r.blockers) console.log('  ! ' + b);
        console.log('');
    }

    for (const m of r.perMonth) {
        if (has('--open') && m.closed) continue;
        const tag = m.closed ? 'CLOSED' : 'OPEN';
        console.log(`${m.month}  ${tag}`);
        if (m.bank.nodata) {
            console.log('    bank  : no data');
        } else {
            console.log(`    bank  : ${m.bank.explained}/${m.bank.settled} explained`
                + (m.bank.pending ? `, ${m.bank.pending} still pending` : '')
                + (m.bank.open ? `  —  ${m.bank.open} open, ${money(m.bank.money)}` : ''));
        }
        for (const [label, v] of Object.entries(m.qb || {})) {
            if (label === 'nodata') continue;
            if (v.nodata) { console.log(`    ${label.padEnd(6)}: no data`); continue; }
            console.log(`    ${label.padEnd(6)}: Jarvis ${money(v.jarvis)}   QB ${money(v.qb)}`
                + (v.agrees ? '   agree' : `   OFF BY ${money(v.diff)}`));
        }
        // The worklist. Capped unless she asked for one month, because ten
        // months of every row is a wall she will not read.
        const items = (m.bank.items || []);
        const show = one ? items : items.slice(0, 5);
        for (const it of show) {
            console.log(`             ${it.date}  ${money(it.in || it.out)}`
                + `  ${it.out ? 'out' : 'in '}  ${it.desc}`);
        }
        if (show.length < items.length) {
            console.log(`             … and ${items.length - show.length} more`
                + ` — node scripts/books-close.js --month ${m.month}`);
        }
    }

    console.log('');
    console.log(r.blockers.length ? `VERDICT: ${r.summary}` : `VERDICT: ${r.summary}`);
    if (!r.blockers.length && !r.closed) {
        const first = r.perMonth.find((m) => !m.closed);
        if (first) console.log(`Start with ${first.month}: ${first.why_open.join('; ')}`);
    }
    console.log('');
})();
