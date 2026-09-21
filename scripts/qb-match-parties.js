#!/usr/bin/env node
// ── scripts/qb-match-parties.js — Jarvis names vs QuickBooks names ──────────
// READ-ONLY on QuickBooks. Lists every supplier and trucker on Edge Metals
// bills (helpers/bills.js — NOT truckerBills.js, which is Edge Yard) and every
// customer on sales (helpers/sales.js), matches each against her QuickBooks
// vendors / customers, and writes a review sheet for her to confirm.
//
// Run it where the LIVE data is (the VM). On the Mac data/bills.json is not
// the real ledger — see docs: jarvis-deployment-model-RESOLVED.
//
//   node scripts/qb-match-parties.js                  (QB_ENV from .env)
//   node scripts/qb-match-parties.js --env=production
//   node scripts/qb-match-parties.js --env=production --bills=Bills.xlsx --sales=Invoice.xlsx
//        (from the website's own Export button on the Bill / Invoice tabs,
//         when running away from the live data — columns are found by their
//         on-screen labels: Supplier, Trucker, Customer name, Date)
// Output: DATA_DIR/qb-party-review.csv, and a summary on screen.

require('dotenv').config();
const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : null; };
if (arg('env')) process.env.QB_ENV = arg('env');

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config');
const client = require('../helpers/quickbooks/client');
const mapping = require('../helpers/quickbooks/mapping');
const bills = require('../helpers/bills');
const sales = require('../helpers/sales');

function tally(rows, field) {
    const m = new Map();
    for (const r of rows) {
        const n = String(r[field] || '').trim();
        if (!n) continue;
        const e = m.get(n) || { name: n, count: 0, last: '' };
        e.count++; if ((r.date || '') > e.last) e.last = r.date || '';
        m.set(n, e);
    }
    return [...m.values()];
}
const csv = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;

// Reads an exported sheet into rows keyed like the ledger (supplier,
// trucking_company, customer, date), by header LABEL, so a reordered export
// still reads right.
async function fromXlsx(file, labels) {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const ws = wb.worksheets[0];
    let headerRow = null, col = {};
    ws.eachRow((row, i) => {
        if (headerRow) return;
        const found = {};
        row.eachCell((c, j) => { const t = String(c.text || '').trim().toLowerCase(); for (const [k, l] of Object.entries(labels)) if (t === l.toLowerCase()) found[k] = j; });
        if (Object.keys(found).length >= 2) { headerRow = i; col = found; }
    });
    if (!headerRow) throw new Error(`${file}: no header row with ${Object.values(labels).join(' / ')}`);
    const out = [];
    ws.eachRow((row, i) => {
        if (i <= headerRow) return;
        const r = {};
        for (const [k, j] of Object.entries(col)) {
            const v = row.getCell(j).value;
            r[k] = v instanceof Date ? v.toISOString().slice(0, 10) : String(row.getCell(j).text || '').trim();
        }
        if (Object.values(r).some(Boolean)) out.push(r);
    });
    return out;
}

async function main() {
    const env = require('../helpers/quickbooks/auth').qbEnv();
    const B = arg('bills') ? await fromXlsx(arg('bills'), { supplier: 'Supplier', trucking_company: 'Trucker', date: 'Date' }) : bills.list();
    const S = arg('sales') ? await fromXlsx(arg('sales'), { customer: 'Customer name', date: 'Date' }) : sales.list();
    console.log(`QuickBooks ${env.toUpperCase()} · Jarvis: ${B.length} bills, ${S.length} sales`);
    if (!B.length && !S.length) console.log('No Jarvis bills or sales here — run this on the VM, where the live data is.');

    const want = [
        ...tally(B, 'supplier').map((x) => ({ ...x, kind: 'vendor', role: 'supplier' })),
        ...tally(B, 'trucking_company').map((x) => ({ ...x, kind: 'vendor', role: 'trucker' })),
        ...tally(S, 'customer').map((x) => ({ ...x, kind: 'customer', role: 'customer' })),
    ];
    const qb = { vendor: await mapping.fetchParties('vendor', client), customer: await mapping.fetchParties('customer', client) };
    const map = mapping.loadMap();

    const rows = want.map((w) => ({ ...w, r: mapping.matchParty(w.name, qb[w.kind], w.kind, map) }));
    const order = { ambiguous: 0, suggest: 1, none: 2, new: 3, exact: 4, confirmed: 5 };
    rows.sort((a, b) => order[a.r.status] - order[b.r.status] || b.count - a.count);

    const out = [['status', 'kind', 'role', 'jarvis_name', 'jarvis_rows', 'last_date', 'qb_name', 'qb_id', 'other_candidates', 'why'].join(',')];
    for (const x of rows) {
        const c = x.r.qb || x.r.candidates[0] || {};
        out.push([x.r.status, x.kind, x.role, x.name, x.count, x.last, c.DisplayName || '', c.Id || '',
            (x.r.qb ? [] : x.r.candidates.slice(1)).map((k) => k.DisplayName).join(' / '), c.why || x.r.note || ''].map(csv).join(','));
    }
    const file = path.join(DATA_DIR, 'qb-party-review.csv');
    fs.writeFileSync(file, out.join('\n') + '\n');

    const count = {}; rows.forEach((x) => { count[x.r.status] = (count[x.r.status] || 0) + 1; });
    console.log(count);
    console.log(`Review sheet: ${file}`);
}
main().catch((e) => { console.error('qb-match-parties failed:', e.message); process.exit(1); });
