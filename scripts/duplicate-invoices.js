#!/usr/bin/env node
// ── scripts/duplicate-invoices.js — one container, several invoices ──────
//
//     node scripts/duplicate-invoices.js
//     node scripts/duplicate-invoices.js --all     # include the normal ones
//
// From her nightly sweep, 2026-10-06:
//   SELU4226126 — 2 invoices
//   TLLU2110739 — 3 invoices
//
// Double-counted revenue overstates profit exactly the way missing cost
// does, and on a return that is tax paid on money she never earned.
//
// ── BUT SEVERAL ROWS PER CONTAINER IS NORMAL ─────────────────────────────
// sales.json holds ONE ROW PER ITEM. A container of three grades is three
// rows and always has been. So a count alone says nothing, and a tool that
// cried "duplicate" at every multi-grade container would be deleted within
// a week.
//
// ── WHAT ACTUALLY SEPARATES THEM ─────────────────────────────────────────
// sales.js:403 makes an id as `SALE_${Date.now()}_${random}`, so the
// timestamp is the creation moment to the millisecond. Rows saved in ONE
// operation share it exactly; rows typed on different days do not.
//
// Her two cases, decoded:
//   TLLU2110739  all three at 2026-09-21T11:31:47.253Z  — one save, 3 items
//   SELU4226126  2026-09-28T18:44:09  and  2026-09-30T06:15:30  — 36 hours
//                apart, two separate saves
//
// The first is a normal invoice. The second is the one to look at. That is
// the whole discrimination, and it comes from her own data rather than from
// a guess about what a duplicate looks like.
//
// READ-ONLY. It never deletes anything. Removing an invoice is hers, on the
// screen that already does it with the guards — a script that quietly
// deleted revenue would be the worst thing in this repo.

const path = require('path');
const ROOT = path.join(__dirname, '..');

const ALL = process.argv.includes('--all');
const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-US',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// The creation moment out of the id. Null when the id is not in that shape —
// an imported row, say — and a null must never be treated as "same moment as
// another null", which would group every imported row into one false batch.
function createdAt(id) {
    const m = /^SALE_(\d{10,})_/.exec(String(id || ''));
    if (!m) return null;
    const t = Number(m[1]);
    return Number.isFinite(t) ? t : null;
}

const hours = (ms) => Math.round((ms / 3600000) * 10) / 10;

(function main() {
    const sales = require(path.join(ROOT, 'helpers/sales')).listWithTotals();

    const byContainer = new Map();
    for (const s of sales) {
        const k = String(s.container_no || '').trim();
        if (!k) continue;                       // no container, nothing to group on
        if (!byContainer.has(k)) byContainer.set(k, []);
        byContainer.get(k).push(s);
    }

    const suspicious = [];
    const normal = [];

    for (const [container, rows] of byContainer) {
        if (rows.length < 2) continue;

        // Group by the exact creation millisecond. Rows with no usable id
        // each become their own batch rather than merging into one.
        const batches = new Map();
        let unknown = 0;
        for (const r of rows) {
            const t = createdAt(r.id);
            const key = t === null ? `unknown-${unknown++}` : String(t);
            if (!batches.has(key)) batches.set(key, []);
            batches.get(key).push(r);
        }

        const stamps = [...batches.keys()].filter((k) => !k.startsWith('unknown')).map(Number).sort();
        const spread = stamps.length > 1 ? stamps[stamps.length - 1] - stamps[0] : 0;
        // ── HOW MANY SAVES WE CAN ACTUALLY VOUCH FOR ─────────────────────
        // Only the timestamped ones. A row whose id carries no timestamp —
        // an imported one — tells us nothing about WHEN it was entered, and
        // an earlier version counted each as its own batch and then
        // announced "entered in 2 separate saves, 0 hours apart". That is a
        // false claim rather than a cautious one: the whole value of this
        // tool is that the timing is evidence, and evidence we do not have
        // must not be asserted.
        const knownSaves = stamps.length;
        const undatedRows = [...batches.entries()]
            .filter(([k]) => k.startsWith('unknown')).reduce((n, [, v]) => n + v.length, 0);
        const entry = { container, rows, batches, spread, knownSaves, undatedRows,
            customers: [...new Set(rows.map((r) => r.customer))] };

        // ── IDENTICAL ROWS ARE A DUPLICATE WHATEVER THE TIMING ───────────
        // Same item, same weight, same price, twice, is not a second grade.
        const seen = new Map();
        entry.identical = [];
        for (const r of rows) {
            const sig = [r.item, r.weight, r.invoice_price].map((v) => String(v == null ? '' : v).trim()).join('|');
            if (seen.has(sig)) entry.identical.push([seen.get(sig), r]);
            else seen.set(sig, r);
        }

        // knownSaves, not batches.size — undated rows are not evidence of a
        // second save, only of an import.
        if (entry.knownSaves > 1 || entry.identical.length) suspicious.push(entry);
        else normal.push(entry);
    }

    console.log(`\nCONTAINERS WITH MORE THAN ONE INVOICE ROW — ${new Date().toISOString()}`);
    console.log(`${byContainer.size} containers, ${suspicious.length} worth a look, ${normal.length} ordinary\n`);

    if (!suspicious.length) {
        console.log('Every container with several rows had them entered in one go — normal multi-item invoices.\n');
    }

    for (const e of suspicious) {
        console.log(`  ${e.container}  —  ${e.customers.join(', ')}`);
        // Only claimed when the timestamps actually say so.
        if (e.knownSaves > 1) {
            console.log(`      entered in ${e.knownSaves} separate saves, ${hours(e.spread)} hours apart`);
        }
        if (e.undatedRows) {
            console.log(`      ${e.undatedRows} row(s) have no timestamp in their id — probably imported, `
                + 'so when they were entered cannot be told from here');
        }
        if (e.identical.length) {
            console.log(`      ${e.identical.length} row(s) IDENTICAL in item, weight and price`);
        }
        let total = 0;
        // Oldest first. The original save is the one she is likeliest to be
        // keeping, so it should read down the page in the order it happened
        // rather than in whatever order the rows came out of the store.
        const ordered = [...e.batches.entries()].sort((a, b) => {
            const x = a[0].startsWith('unknown') ? Infinity : Number(a[0]);
            const y = b[0].startsWith('unknown') ? Infinity : Number(b[0]);
            return x - y;
        });
        for (const [key, batch] of ordered) {
            const when = key.startsWith('unknown') ? '(id has no timestamp)' : new Date(Number(key)).toISOString();
            console.log(`      ${when}`);
            for (const r of batch) {
                const v = Number(r.receivable != null ? r.receivable : r.amount) || 0;
                total += v;
                console.log(`         ${String(r.item || '(no item)').padEnd(22)}`
                    + `${String(r.weight || '').padStart(10)} ${r.weight_unit || ''}`
                    + ` @ ${String(r.invoice_price || '')}`.padEnd(12)
                    + ` = ${money(v).padStart(14)}   ${r.id}`);
            }
        }
        console.log(`      total invoiced on this container: ${money(total)}`);
        // The figure that would come off income if a batch is a duplicate.
        if (e.knownSaves > 1) {
            const perBatch = [...e.batches.entries()]
                .filter(([k]) => !k.startsWith('unknown'))
                .map(([, b]) => b.reduce((t, r) =>
                    t + (Number(r.receivable != null ? r.receivable : r.amount) || 0), 0));
            const smallest = Math.min(...perBatch);
            console.log(`      if the smaller save is a duplicate, income is overstated by ${money(smallest)}`);
        }
        console.log('');
    }

    if (ALL && normal.length) {
        console.log('ORDINARY — several items, entered in one save:');
        for (const e of normal) {
            console.log(`  ${e.container}  ${e.rows.length} items, one save  (${e.customers.join(', ')})`);
        }
        console.log('');
    } else if (normal.length) {
        console.log(`${normal.length} container(s) have several rows entered in ONE save — normal multi-item`);
        console.log('invoices. Run with --all to list them.\n');
    }

    console.log('Nothing was changed. Removing an invoice is yours, on the Documents screen,');
    console.log('which already asks twice and says what it will undo.\n');
    process.exit(suspicious.length ? 1 : 0);
})();
