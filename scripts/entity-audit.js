#!/usr/bin/env node
// ── scripts/entity-audit.js — can every money row be placed on a company? ─
//
//     node scripts/entity-audit.js
//     node scripts/entity-audit.js --show 20     # list the unplaced rows
//
// Apsara, 2026-10-06: AAA Investment is "a third company with its own
// return". Three returns means every money row has to land on exactly one
// company, and helpers/entities.js is the function that decides.
//
// ── WHY THIS SCRIPT EXISTS RATHER THAN A NUMBER IN A COMMIT MESSAGE ──────
// Her real money data is NOT in the repo. payments.json, bills.json,
// petty_cash.json and expenses.json live on the VM; the local data/ folder
// has seven sales rows and three loads. So the only honest thing I could
// write about coverage was that I had not measured it.
//
// That measurement is not a detail — it is the whole question. A resolver
// that cannot place 40% of her payments does not produce a tax return, it
// produces a list of homework. This prints the percentage, and prints the
// rows it could not place so the gap is a fixable list rather than a
// statistic.
//
// READ-ONLY. It opens her stores and writes nothing, to any of them.

const path = require('path');
const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
const { loadJson } = require(path.join(ROOT, 'helpers/json'));
const E = require(path.join(ROOT, 'helpers/entities'));

// store name → the config key holding its filename. The store name is what
// entities.js keys its rules on, so these must be its own names.
const STORES = [
    ['payments', cfg.PAYMENTS_FILE],
    ['bills', cfg.BILLS_FILE],
    ['sales', cfg.SALES_FILE],
    ['bill_payments', cfg.BILL_PAYMENTS_FILE],
    ['sales_receipts', cfg.SALES_RECEIPTS_FILE],
    ['sales_settlements', cfg.SALES_SETTLEMENTS_FILE],
    ['metals_trucking', cfg.METALS_TRUCKING_FILE],
    ['expenses', cfg.EXPENSES_FILE],
    ['petty_cash', cfg.PETTY_CASH_FILE],
    ['trucker_bills', cfg.TRUCKER_BILLS_FILE],
    ['loads', cfg.LOADS_FILE],
    ['outbound_loads', cfg.OUTBOUND_LOADS_FILE],
    ['bank_transactions', cfg.BANK_TX_FILE],
];

const SHOW = (() => {
    const i = process.argv.indexOf('--show');
    if (i === -1) return 0;
    const n = Number(process.argv[i + 1]);
    return Number.isFinite(n) && n > 0 ? n : 10;
})();

const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) + '%' : '—');

// ── AMOUNTS ARE NOT ALL STORED ───────────────────────────────────────────
// The first version of this read row.amount and printed $0.00 for seven
// real invoices. sales.json has NO amount field — it holds weight and
// invoice_price, and helpers/sales.js computes the figure in
// listWithTotals(), with the lb/MT unit handling that makes it correct.
//
// CLAUDE.md records this same mistake once already: "Read `amount` where
// sales.js means `receivable`". Reading a raw row and calling the result
// money is how it happens both times.
//
// So amounts are read through the STORE'S OWN arithmetic where the store
// has some, and reported as not computed where it does not. A dollar figure
// that is quietly wrong in an accounting audit is worse than an absent one —
// she would reconcile against it.
const COMPUTED = {
    // store → [helper module, function, field on the computed row]
    sales: ['../helpers/sales', 'listWithTotals', 'receivable'],
    bills: ['../helpers/bills', 'listWithTotals', 'net_payable'],
};

// Rows whose amount really is stored on the row.
const RAW_KEYS = ['amount', 'net_payable', 'spent', 'received', 'total'];

function rawAmount(row) {
    for (const k of RAW_KEYS) {
        const v = Number(row && row[k]);
        if (Number.isFinite(v) && v !== 0) return Math.abs(v);
    }
    return null;                       // null, NOT 0 — "unknown", not "nothing"
}

// Builds an id → amount map for a store that computes its own totals, so
// the audit never does the arithmetic itself.
function computedAmounts(store) {
    const spec = COMPUTED[store];
    if (!spec) return null;
    const [mod, fn, field] = spec;
    try {
        const m = require(path.join(__dirname, mod));
        if (typeof m[fn] !== 'function') return null;
        const rows = m[fn]() || [];
        const byId = new Map();
        for (const r of rows) {
            const v = Number(r && (r[field] != null ? r[field] : r.amount));
            if (r && r.id != null && Number.isFinite(v)) byId.set(String(r.id), Math.abs(v));
        }
        return byId;
    } catch (e) {
        // Never fatal. The coverage percentage is the point of this script
        // and it does not depend on any dollar figure.
        return null;
    }
}

(function main() {
    console.log(`\nENTITY AUDIT — ${new Date().toISOString()}`);
    console.log(`DATA_DIR: ${cfg.DATA_DIR}\n`);

    const perCompany = new Map(E.ENTITIES.map((e) => [e.id, { rows: 0, amount: 0, uncosted: 0 }]));
    let totalRows = 0, totalUnplaced = 0, unplacedAmount = 0, unplacedUncosted = 0;
    const amountSource = [];
    const interCompany = [];
    const unplaced = [];
    const missingStores = [];

    const W = 20;
    console.log('store'.padEnd(W) + 'rows'.padStart(8) + 'placed'.padStart(9)
        + 'unplaced'.padStart(10) + 'inter-co'.padStart(10));
    console.log('─'.repeat(W + 37));

    for (const [name, file] of STORES) {
        if (!file) { missingStores.push(`${name} (no config key)`); continue; }
        const rows = loadJson(file, []);
        if (!Array.isArray(rows)) { missingStores.push(`${name} (not an array)`); continue; }

        const r = E.place(name, rows);
        totalRows += rows.length;
        totalUnplaced += r.undecided.length;

        // Where this store's money figures come from, said out loud.
        const byId = computedAmounts(name);
        if (rows.length) {
            amountSource.push(`${name}: ${byId ? `computed by helpers/${name}.js` : 'read from the row'}`);
        }
        const amountOf = (row) => {
            if (byId && row && row.id != null && byId.has(String(row.id))) return byId.get(String(row.id));
            return rawAmount(row);
        };

        for (const item of r.placed) {
            const c = perCompany.get(item.ledger);
            if (!c) continue;
            c.rows += 1;
            const a = amountOf(item.row);
            if (a == null) c.uncosted += 1; else c.amount += a;
        }
        for (const item of r.undecided) {
            const a = amountOf(item.row);
            if (a == null) unplacedUncosted += 1; else unplacedAmount += a;
            unplaced.push({ store: name, amount: a, ...item });
        }
        // Amount captured HERE, while this store's own arithmetic is in
        // scope — the summary below runs after the loop and must not redo it.
        for (const item of r.interCompany) interCompany.push({ store: name, amount: amountOf(item.row), ...item });

        console.log(name.padEnd(W)
            + String(rows.length).padStart(8)
            + String(r.placed.length).padStart(9)
            + String(r.undecided.length).padStart(10)
            + String(r.interCompany.length).padStart(10));
    }

    console.log('─'.repeat(W + 37));
    console.log('TOTAL'.padEnd(W) + String(totalRows).padStart(8)
        + String(totalRows - totalUnplaced).padStart(9)
        + String(totalUnplaced).padStart(10)
        + String(interCompany.length).padStart(10));

    // ── the headline ─────────────────────────────────────────────────────
    console.log(`\nPLACED: ${pct(totalRows - totalUnplaced, totalRows)} of ${totalRows} rows`);
    if (totalUnplaced) {
        console.log(`UNPLACED: ${totalUnplaced} rows, about ${money(unplacedAmount)}`
            + (unplacedUncosted ? ` plus ${unplacedUncosted} whose amount is not stored on the row` : ''));
        console.log('  These belong on SOME company\'s tax return and Jarvis cannot say which.');
        console.log('  Nothing is guessed — they are simply absent from every statement until decided.');
    } else {
        console.log('Every row can be placed on exactly one company.');
    }

    // ── per company ──────────────────────────────────────────────────────
    console.log('\nBY COMPANY (rows whose BOOKS they are, not whose money moved)');
    for (const e of E.ENTITIES) {
        const c = perCompany.get(e.id);
        const f = E.filable(e.id);
        // `uncosted` is printed rather than folded into the total as zero.
        // The first cut of this script added nothing for a row with no
        // stored amount and printed $0.00 for seven real invoices, which is
        // a figure she would have reconciled against.
        console.log(`  ${e.uiName.padEnd(16)} ${String(c.rows).padStart(6)} rows  ${money(c.amount).padStart(16)}`
            + (c.uncosted ? `  +${c.uncosted} not costed` : '')
            + (f.ok ? '   filable' : `   NOT FILABLE — missing ${f.missing.join(', ')}`));
    }
    if (amountSource.length) {
        console.log('\n  where these figures come from: ' + amountSource.join('; '));
        console.log('  "not costed" means the row stores no amount and its store computes none —');
        console.log('  it is counted, never silently treated as zero.');
    }

    // ── inter-company ────────────────────────────────────────────────────
    // The figure that disappears if the two questions are collapsed into
    // one. With three filers this is a loan between taxpayers and belongs on
    // two balance sheets.
    if (interCompany.length) {
        const byPair = new Map();
        let total = 0;
        for (const i of interCompany) {
            const key = `${E.get(i.paidBy).uiName} paid ${E.get(i.ledger).uiName}`;
            const cur = byPair.get(key) || { rows: 0, amount: 0 };
            cur.rows += 1;
            if (i.amount != null) { cur.amount += i.amount; total += i.amount; }
            byPair.set(key, cur);
        }
        console.log(`\nINTER-COMPANY — ${interCompany.length} rows, ${money(total)}`);
        console.log('  One company\'s money paying another\'s transaction. Each of these is a');
        console.log('  loan between two companies that each file a return: a receivable on one');
        console.log('  balance sheet and a payable on the other. They are NOT expenses.');
        for (const [k, v] of [...byPair].sort((a, b) => b[1].amount - a[1].amount)) {
            console.log(`    ${k.padEnd(40)} ${String(v.rows).padStart(5)} rows  ${money(v.amount).padStart(16)}`);
        }
    } else {
        console.log('\nINTER-COMPANY: none found.');
        console.log('  Worth a second look rather than relief: paid_via is only ever filled in');
        console.log('  for a purchase paid by Wire and a sale paid by Bank transfer');
        console.log('  (payments.js:194). If most rows have no paid_via, money moving between');
        console.log('  the companies would be invisible here rather than absent in reality.');
    }

    // ── the unplaced rows themselves ─────────────────────────────────────
    if (SHOW && unplaced.length) {
        console.log(`\nUNPLACED ROWS (first ${Math.min(SHOW, unplaced.length)} of ${unplaced.length})`);
        for (const u of unplaced.slice(0, SHOW)) {
            const r = u.row || {};
            console.log(`  · ${u.store}  ${r.date || '(no date)'}  `
                + `${u.amount == null ? '(amount not stored)' : money(u.amount)}`
                + `  ${r.supplier || r.customer || r.seller || r.buyer || r.party || r.description || ''}`);
            console.log(`      ${u.basis}`);
        }
        if (unplaced.length > SHOW) console.log(`  … and ${unplaced.length - SHOW} more. Use --show ${unplaced.length}.`);
    } else if (unplaced.length) {
        console.log(`\nRun with --show 20 to see the unplaced rows themselves.`);
    }

    if (missingStores.length) {
        console.log(`\nSTORES NOT READ: ${missingStores.join(', ')}`);
        console.log('  Not an error on a machine without her data — but on the VM every one of');
        console.log('  these is a store whose rows are in no statement at all.');
    }

    // ── what she has to supply ───────────────────────────────────────────
    const notFilable = E.ENTITIES.filter((e) => !E.filable(e.id).ok);
    if (notFilable.length) {
        console.log('\nHERS TO SUPPLY, before a return can be produced:');
        for (const e of notFilable) {
            const want = e.needsFromHer || E.filable(e.id).missing;
            console.log(`  ${e.legalName}: ${want.join(', ')}`);
        }
    }

    // Exit code says whether the books can be built, so this can be wired
    // into a nightly check later without rewording anything.
    const ok = totalUnplaced === 0;
    console.log(ok ? '\nEvery row is placed.\n' : `\n${totalUnplaced} rows need a decision before any statement is complete.\n`);
    process.exit(ok ? 0 : 1);
})();
