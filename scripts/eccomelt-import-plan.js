#!/usr/bin/env node
// ── scripts/eccomelt-import-plan.js — what an Eccomelt import WOULD create ─
//
// Apsara, 2026-09-29: "i have few entries in eccomelt.ensure that they are
// there in my bills and invoices.create entry accordingly.If entered in red,
// it means it is a claim" — then, shown that the tab carries no supplier
// cost: "FOr now keep supplier price as empty".
//
// ── READ ONLY. IT WRITES NOTHING ──────────────────────────────────────────
// Thirty-six loads is not a number of rows to land in a money ledger on a
// description. This prints exactly what would be created, what it would skip
// and why, so the decision is made from the list rather than from a sentence.
// The writing half is helpers/sheetImportWrite.js, which is already guarded.
//
// ── THE RED CELLS ARE NOT NEEDED, AND THE WORD "claim" IS NOT ENOUGH ──────
// Colour does not survive `export?format=csv`, which is how every sheet
// reader here fetches. It turns out not to matter: the claim lines carry a
// NEGATIVE Amount. What does matter is that matching the word would have
// been wrong — of the six negative lines, five say "claim" and one says
//
//     Mazariegos  PO$4302749  Truck wheel   net=360  -$385.20
//
// so keying on the word would have missed it and understated that load's
// deduction by $385.20. The sign is the signal; the word is decoration.
//
// ── WHY THE EMPTY SUPPLIER PRICE IS SAFE, WHICH IS NOT OBVIOUS ────────────
// Her call, and it is the right one — but only because of how the ledger
// treats a missing price, which is worth writing down:
//
//   helpers/bills.js  supplier_price ''  ->  amount null, balance null,
//                                            missingFor() reports "price"
//   helpers/margin.js:236  margin only computed when cost !== null
//
// So an empty price makes the bill visibly UNFILLED and leaves the margin
// uncomputed. Had it been stored as 0 instead, every one of these containers
// would have reported a margin equal to the whole sale — a figure that looks
// right and is not. Empty is honest; zero would have been a lie.
//
// ── WHAT THIS TAB DOES AND DOES NOT HAVE ──────────────────────────────────
// It is the SALE side: Contract Price, Price, Amount, Received payment are
// all what Eccomelt pays. There is no supplier cost column at all. And 35 of
// the 36 loads have no container number, so they cannot join to anything —
// helpers/margin.js keys on booking AND container. Both are reported below
// rather than papered over.
//
//   node scripts/eccomelt-import-plan.js --csv /path/to/tab.csv
//   node scripts/eccomelt-import-plan.js --sheet <id> --gid <gid>
//   node scripts/eccomelt-import-plan.js ... --json      machine-readable

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
    const i = argv.indexOf(name);
    return i === -1 ? dflt : argv[i + 1];
};
const AS_JSON = argv.includes('--json');

// The same customer every row on this tab belongs to. Named once, here,
// rather than guessed per row — the tab IS the Eccomelt tab.
const CUSTOMER = arg('--customer', 'Eccomelt');

// ── CSV, the same dumb parser the rest of the repo uses ───────────────────
function parseCsv(text) {
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i += 1) {
        const c = text[i];
        if (q) {
            if (c === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
            else if (c === '"') q = false;
            else cell += c;
        } else if (c === '"') q = true;
        else if (c === ',') { row.push(cell); cell = ''; }
        else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
        else if (c !== '\r') cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
}

const num = (v) => {
    const s = String(v == null ? '' : v).replace(/[^0-9.\-]/g, '');
    if (!s || !/\d/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
};
const money = (n) => (n === null || n === undefined) ? '—'
    : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function readTable() {
    const file = arg('--csv');
    if (file) return parseCsv(fs.readFileSync(file, 'utf8'));
    const id = arg('--sheet'), gid = arg('--gid');
    if (!id || !gid) {
        throw new Error('give either --csv <file> or --sheet <id> --gid <gid>');
    }
    const url = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not read the sheet (${res.status})`);
    return parseCsv(await res.text());
}

// ── ONE LOAD IS A ROW WITH A SUPPLIER, PLUS THE ROWS UNDER IT ─────────────
// The tab is written for a person: a supplier row opens a load and the rows
// beneath it break that load into grades, with the claim lines among them.
// A parser that treated every line as its own load would turn one truckload
// into six, and the claim lines into positive-looking containers.
function build(table) {
    const hdr = (table[0] || []).map((h) => String(h || '').trim());
    const col = (name) => hdr.findIndex((h) => h.toLowerCase() === name.toLowerCase());
    const C = {
        supplier: col('Supplier'), ref: col('Reference'), container: col('Container number'),
        item: col('Item'), net: col('Net'), price: col('Price'), amount: col('Amount'),
        deduct: col('Deductible'), recd: col('Received payment'),
        appt: col('Appointment Date'), pickup: col('Pickup Date'),
        lgross: col('Loaded Gross'), dgross: col('Delivery Gross'),
        ltare: col('Loaded Tare'), dtare: col('Delivery Tare'),
    };
    for (const [k, v] of Object.entries(C)) {
        if (v === -1) throw new Error(`the tab has no "${k}" column — headers: ${hdr.filter(Boolean).join(', ')}`);
    }

    const loads = [];
    let cur = null;
    for (const raw of table.slice(1)) {
        const r = raw.concat(Array(hdr.length).fill('')).slice(0, hdr.length);
        const get = (k) => String(r[C[k]] || '').trim();
        if (!r.some((c) => String(c || '').trim())) continue;
        const supplier = get('supplier');
        if (supplier) {
            cur = {
                supplier,
                ref: get('ref').replace(/\s+/g, ' ').trim(),
                container: get('container'),
                date: get('appt') || get('pickup'),
                item: get('item'),
                gross: num(get('dgross')) ?? num(get('lgross')),
                tare: num(get('dtare')) ?? num(get('ltare')),
                net: num(get('net')),
                price: num(get('price')),
                amount: num(get('amount')),
                received: num(get('recd')),
                cancelled: /CANCEL/i.test(r.join(' ')),
                lines: [],
            };
            loads.push(cur);
        } else if (cur) {
            const item = get('item');
            const amount = num(get('amount'));
            if (!item && amount === null) continue;   // a subtotal row, not a line
            cur.lines.push({ item, net: num(get('net')), price: num(get('price')), amount });
        }
    }
    return loads;
}

(async () => {
    const loads = build(await readTable());

    // ── THE SIGN, NOT THE WORD ────────────────────────────────────────────
    const claims = [];
    for (const [i, l] of loads.entries()) {
        for (const ln of l.lines) {
            if (ln.amount !== null && ln.amount < 0) {
                claims.push({ load: i + 1, supplier: l.supplier, ref: l.ref, ...ln });
            }
        }
    }

    // ── THE HEADER AMOUNT IS NOT ALWAYS THE AMOUNT ────────────────────────
    // On some loads the supplier row carries the whole figure. On others it
    // carries $0.00 (or nothing) and the money is in the grade lines beneath
    // it — Calderon PO#4302763 reads $0.00 on its header while its three
    // lines add to $71,297.06, which is exactly what the Received column
    // says was collected for it.
    //
    // Taking the header at face value would have created a $0.00 invoice for
    // a seventy-one-thousand-dollar load. Both figures are computed and any
    // disagreement is REPORTED rather than silently resolved: this parser
    // does not get to decide which of her two numbers is the real one.
    const disagree = [];
    for (const l of loads) {
        const lineSum = l.lines.reduce((t, x) => t + (x.amount || 0), 0);
        l.lineSum = l.lines.length ? Math.round(lineSum * 100) / 100 : null;
        l.useAmount = l.amount;
        if (l.lineSum !== null && (l.amount === null || Math.abs(l.amount) < 0.005)) {
            l.useAmount = l.lineSum;              // header empty or zero: the lines are it
            l.amountFrom = 'lines';
        } else if (l.lineSum !== null && l.amount !== null
                   && Math.abs(l.lineSum - l.amount) > 0.5) {
            l.amountFrom = 'header';
            disagree.push(l);                      // both present and they differ
        } else {
            l.amountFrom = 'header';
        }
    }

    const creatable = [], skipped = [];
    for (const l of loads) {
        if (l.cancelled) { skipped.push({ ...l, why: 'marked CANCELLED on the sheet' }); continue; }
        if (l.amount === null && l.net === null) {
            skipped.push({ ...l, why: 'a PO with no load against it yet — nothing to invoice' });
            continue;
        }
        creatable.push(l);
    }

    // Name variants, because importing as typed feeds the Clean-names problem
    // she already has a button for.
    const variants = new Map();
    for (const l of loads) {
        const k = l.supplier.toLowerCase().replace(/\s+/g, ' ').trim();
        if (!variants.has(k)) variants.set(k, new Set());
        variants.get(k).add(l.supplier);
    }
    const spellings = new Map();
    for (const l of loads) {
        const k = l.supplier.toLowerCase().replace(/\s+/g, ' ').trim();
        spellings.set(k, (spellings.get(k) || new Set()).add(l.supplier));
    }
    const multi = [...spellings.entries()].filter(([, s]) => s.size > 1);

    if (AS_JSON) {
        console.log(JSON.stringify({ creatable, skipped, claims, loads: loads.length }, null, 2));
        return;
    }

    const W = 78;
    console.log(`\n  AN ECCOMELT IMPORT, AS A PLAN — NOTHING HAS BEEN WRITTEN`);
    console.log(`  ${'─'.repeat(W)}`);
    console.log(`\n  ${loads.length} loads on the tab · ${creatable.length} would be created · ${skipped.length} skipped\n`);

    console.log(`  BILLS (supplier side) — supplier price left EMPTY, her instruction`);
    console.log(`  ${'─'.repeat(W)}`);
    console.log(`  An empty price means bills.js reports the row as unfilled and margin.js`);
    console.log(`  computes no margin for it. Stored as 0 instead, each of these would claim`);
    console.log(`  a margin equal to the whole sale.\n`);
    for (const l of creatable) {
        console.log(`    ${(l.date || '—').padEnd(12)} ${l.supplier.slice(0, 16).padEnd(17)}`
            + `${(l.ref || '—').padEnd(14)} net ${String(l.net ?? '—').padEnd(9)}`
            + `price ${'(empty)'.padEnd(9)}${l.container ? l.container : 'NO CONTAINER'}`);
    }

    console.log(`\n  INVOICES (${CUSTOMER}) — price and amount are on the tab`);
    console.log(`  ${'─'.repeat(W)}`);
    for (const l of creatable) {
        console.log(`    ${(l.date || '—').padEnd(12)} ${CUSTOMER.padEnd(17)}`
            + `${(l.ref || '—').padEnd(14)} net ${String(l.net ?? '—').padEnd(9)}`
            + `${(l.price === null ? '—' : '$' + l.price).padEnd(9)}${money(l.useAmount).padStart(13)}`
            + `${l.amountFrom === 'lines' ? '   (summed from its grade lines)' : ''}`);
    }

    console.log(`\n  CLAIMS — ${claims.length}, found by NEGATIVE AMOUNT, not by the word`);
    console.log(`  ${'─'.repeat(W)}`);
    console.log(`  Colour does not survive the CSV export, and it does not need to. One of`);
    console.log(`  these does NOT say "claim", so the word would have missed it:\n`);
    for (const c of claims) {
        const flag = /claim/i.test(c.item) ? '  ' : '← says nothing about a claim';
        console.log(`    load ${String(c.load).padStart(2)}  ${c.supplier.slice(0, 14).padEnd(15)}`
            + `${(c.ref || '—').padEnd(14)}${(c.item || '—').padEnd(22)}`
            + `${String(c.net ?? '—').padStart(7)}  ${money(c.amount).padStart(12)}  ${flag}`);
    }
    const claimTotal = claims.reduce((t, c) => t + (c.amount || 0), 0);
    console.log(`\n    ${money(claimTotal)} of deductions across ${claims.length} lines.`);

    if (disagree.length) {
        console.log(`\n  THE TWO FIGURES DISAGREE — ${disagree.length}`);
        console.log(`  ${'─'.repeat(W)}`);
        console.log(`  The supplier row says one thing and its grade lines add to another.`);
        console.log(`  Not guessed — the header is used and the gap shown, because deciding`);
        console.log(`  which of your two numbers is right is not a parser's job.\n`);
        // ── THE RECEIVED COLUMN IS THE TIE-BREAKER, AND IT PICKS BOTH ─────
        // Edge yard PO#4302877: header 69,184.08 is the AL WHEELS line and
        // the rows beneath are ADDITIONAL grades (truck, chrome, clad), so
        // header + lines = 72,499.44 — exactly what Received says. Elsewhere
        // the lines are a BREAKDOWN of the header and adding them would
        // double the load.
        //
        // Two different shapes in one tab, and the only way to tell them
        // apart is which total matches what Eccomelt actually paid. That is
        // a reading of her paperwork, not a rule a parser should invent, so
        // all three are printed and the matching one is marked.
        for (const l of disagree) {
            const plus = Math.round(((l.amount || 0) + l.lineSum) * 100) / 100;
            const near = (a, b) => a !== null && b !== null && Math.abs(a - b) < 1;
            const mark = near(l.received, l.amount) ? 'header matches Received'
                : near(l.received, l.lineSum) ? 'LINES match Received'
                : near(l.received, plus) ? 'header + lines match Received'
                : l.received === null ? 'nothing received yet — cannot tell'
                : 'none of the three matches Received';
            console.log(`    ${(l.date || '—').padEnd(12)} ${l.supplier.slice(0, 15).padEnd(16)}${(l.ref || '—').padEnd(13)}`);
            console.log(`        header ${money(l.amount).padStart(13)}   lines ${money(l.lineSum).padStart(13)}`
                + `   both ${money(plus).padStart(13)}   received ${money(l.received).padStart(13)}`);
            console.log(`        -> ${mark}`);
        }
    }

    if (skipped.length) {
        console.log(`\n  SKIPPED — ${skipped.length}`);
        console.log(`  ${'─'.repeat(W)}`);
        for (const s of skipped) {
            console.log(`    ${(s.date || '—').padEnd(12)} ${s.supplier.slice(0, 16).padEnd(17)}`
                + `${(s.ref || '—').padEnd(14)} ${s.why}`);
        }
    }

    // ── WHAT WOULD STILL BE WRONG AFTERWARDS ──────────────────────────────
    const noContainer = creatable.filter((l) => !l.container);
    console.log(`\n  BEFORE YOU SAY YES`);
    console.log(`  ${'─'.repeat(W)}`);
    console.log(`\n  · ${noContainer.length} of ${creatable.length} have NO CONTAINER NUMBER.`);
    console.log(`    helpers/margin.js keys on booking AND container, so these bills and`);
    console.log(`    invoices cannot join to each other. Each pair becomes two half-rows in`);
    console.log(`    the margin report — the same defect scripts/why-unjoined.js already`);
    console.log(`    finds 23 live instances of. Importing them adds ${noContainer.length} more.`);
    if (multi.length) {
        console.log(`\n  · ONE SUPPLIER, SEVERAL SPELLINGS:`);
        for (const [, set] of multi) console.log(`      ${[...set].join('  /  ')}`);
        console.log(`    Imported as typed, each spelling becomes its own supplier — separate`);
        console.log(`    balances, separate pay screens. Clean names fixes it afterwards;`);
        console.log(`    fixing the sheet first is cheaper.`);
    }
    const yard = creatable.filter((l) => /edge\s*yard/i.test(l.supplier));
    if (yard.length) {
        console.log(`\n  · ${yard.length} loads have EDGE YARD as the supplier.`);
        console.log(`    That is Edge Yard selling to Edge Metals — two different companies,`);
        console.log(`    and an intercompany purchase, not an ordinary one. Worth deciding`);
        console.log(`    how you want those recorded before they go in.`);
    }
    console.log(`\n  · The claims above are listed, not created. They can become deduction`);
    console.log(`    lines on the invoice, or records in the claims register`);
    console.log(`    (helpers/claims.js) — those key on invoice_no|container_no, which`);
    console.log(`    none of these rows has yet. Your call.\n`);
})().catch((e) => { console.error('\n  ' + e.message + '\n'); process.exit(1); });
