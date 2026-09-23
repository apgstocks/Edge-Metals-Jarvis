#!/usr/bin/env node
// ── scripts/qb-vs-sheet.js — her live sheet against her live books ─────────
// Apsara, 2026-09-24: "run qb against my live sheet. if anything is missing,
// put a entry".
//
// Reads the Google Sheet itself (not a download): SHIPMENTS 2026 is what she
// BOUGHT, Order Details 2026 is what she SOLD. Rolls each container up and
// asks QuickBooks whether it is there — by container first (QuickBooks carries
// it in the line description), then invoice number, then amount and date.
//
//   node scripts/qb-vs-sheet.js [--since=2026-01-01] [--out=file.csv]
//
// READ-ONLY. Entering what is missing is a separate, deliberate step:
//   node scripts/qb-push-list.js --kind=bill|invoice ... --reason="..."
// because most of what is missing sits BEFORE the cutover, in the period her
// accountant owns, and $3M of entries is not a side effect of a report.
require('dotenv').config();
const fs = require('fs');
const cfg = require('../config');
const client = require('../helpers/quickbooks/client');
const push = require('../helpers/quickbooks/push');

const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const SINCE = arg('since') || '2026-01-01';
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const KEY = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const money = (v) => {
    const n = Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
    return isFinite(n) ? n : null;
};
const date = (v) => {
    const s = String(v || '').trim();
    let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s); if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s); if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    return null;
};

async function sheet(range) {
    const { google } = require('googleapis');
    const auth = new google.auth.GoogleAuth({ keyFile: cfg.GDRIVE_KEYFILE, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const api = google.sheets({ version: 'v4', auth });
    const r = await api.spreadsheets.values.get({ spreadsheetId: cfg.INVOICE_SHEET_ID, range });
    return r.data.values || [];
}

// SHIPMENTS 2026: 3 date · 4 supplier · 6 invoice no · 8 container · 20 supplier invoice amount
// Order Details 2026: 2 inv date · 5 container · 7 supplier · 9 customer · 1 inv no · 15 invoice amount
function rollup(rows, pick) {
    const by = {};
    for (const row of rows.slice(1)) {
        const r = pick(row);
        if (!r || !r.date || r.date < SINCE || !(r2(r.amount) > 0)) continue;
        const key = KEY(r.container) || KEY(r.no) || `${r.date}|${KEY(r.party)}`;
        const g = by[key] || (by[key] = { date: r.date, container: r.container, no: r.no, party: r.party, amount: 0, lines: 0 });
        g.amount = r2(g.amount + r2(r.amount)); g.lines++;
        if (r.date < g.date) g.date = r.date;
    }
    return Object.values(by);
}

async function qb2026() {
    const pull = async (t) => { let all = [], s = 1; for (;;) {
        const r = (await client.query(`select * from ${t} where TxnDate >= '${SINCE}' startposition ${s} maxresults 1000`, { env: 'production' }))[t] || [];
        all = all.concat(r); if (r.length < 1000) break; s += 1000; } return all; };
    const shape = (x, ref) => ({ id: x.Id, date: x.TxnDate, doc: String(x.DocNumber || '').trim(), party: ((x[ref] || {}).name) || '',
        total: r2(x.TotalAmt), gross: r2((x.Line || []).filter((l) => Number(l.Amount) > 0).reduce((s, l) => s + Number(l.Amount), 0)),
        containers: (((x.Line || []).map((l) => l.Description || '').join(' ') + ' ' + (x.PrivateNote || '') + ' ' + ((x.CustomerMemo || {}).value || ''))
            .match(/[A-Z]{4}\d{7}/g) || []) });
    return {
        bill: (await pull('Bill')).map((x) => shape(x, 'VendorRef')).concat((await pull('Purchase')).map((x) => shape(x, 'EntityRef'))),
        invoice: (await pull('Invoice')).map((x) => shape(x, 'CustomerRef')),
    };
}

function look(row, pool) {
    const fits = (x) => Math.abs(x.total - row.amount) < 0.02 || Math.abs((x.gross || x.total) - row.amount) < 0.02;
    const cont = KEY(row.container);
    const sameCont = cont ? pool.filter((x) => x.containers.some((y) => KEY(y) === cont)) : [];
    let hit = sameCont.find(fits) || sameCont[0] || null; let how = hit ? 'container' : '';
    if (!hit && row.no) { hit = pool.find((x) => x.doc && KEY(x.doc).includes(KEY(row.no))); how = hit ? 'invoice number' : ''; }
    if (!hit) { hit = pool.find((x) => fits(x) && Math.abs(new Date(x.date) - new Date(row.date)) / 864e5 <= 45); how = hit ? 'amount and date' : ''; }
    return { hit, how, fits: hit ? fits(hit) : false, multi: hit ? (hit.containers || []).length > 1 : false };
}

(async () => {
    process.env.QB_PROD_WRITES = 'off';
    const [buys, sells] = await Promise.all([sheet('SHIPMENTS 2026!A1:BJ3000'), sheet('Order Details 2026!A1:AZ2000')]);
    const bills = rollup(buys, (row) => ({ date: date(row[3]), party: row[4], no: row[6], container: row[8], amount: money(row[20]) }));
    const sales = rollup(sells, (row) => ({ date: date(row[2]), party: row[9], no: row[1], container: row[5], amount: money(row[15]) }));
    console.log(`live sheet since ${SINCE}: ${bills.length} purchases, ${sales.length} sales`);
    const qb = await qb2026();
    console.log(`QuickBooks since ${SINCE}: ${qb.bill.length} bills+expenses, ${qb.invoice.length} invoices`);

    const cut = { bill: push.cutoverFor('bill', 'production'), invoice: push.cutoverFor('invoice', 'production') };
    const out = [['what', 'date', 'party', 'container', 'sheet no', 'sheet amount', 'side', 'status', 'QuickBooks']];
    const tally = {}; const bump = (k, amt) => { tally[k] = (tally[k] || 0) + 1; tally['$ ' + k] = r2((tally['$ ' + k] || 0) + (amt || 0)); };
    for (const [kind, rows] of [['bill', bills], ['invoice', sales]]) {
        for (const row of rows) {
            const { hit, how, fits, multi } = look(row, qb[kind]);
            const side = cut[kind] && row.date >= cut[kind] ? 'after cutover (Jarvis)' : 'before cutover (accountant)';
            if (!hit) { bump(`${kind} MISSING · ${side}`, row.amount);
                out.push([kind === 'bill' ? 'PURCHASE not in QuickBooks' : 'SALE not in QuickBooks', row.date, row.party || '', row.container || '', row.no || '', row.amount, side, 'MISSING', '']); continue; }
            if (fits) { bump(`${kind} ok`, row.amount); continue; }
            if (multi) { bump(`${kind} on a consolidated record`, row.amount);
                out.push([`${kind} on a consolidated record`, row.date, row.party || '', row.container || '', row.no || '', row.amount, side, 'consolidated', `#${hit.id} covers ${hit.containers.length} containers, ${hit.total}`]); continue; }
            bump(`${kind} amount differs`, row.amount);
            out.push([`${kind.toUpperCase()} amount differs`, row.date, row.party || '', row.container || '', row.no || '', row.amount, side, 'differs', `#${hit.id} ${hit.party} says ${hit.total}${hit.gross !== hit.total ? ` (${hit.gross} before trucking)` : ''} — matched by ${how}`]);
        }
    }
    const file = arg('out') || 'Claude outputs/qb-vs-live-sheet.csv';
    try { fs.mkdirSync(require('path').dirname(file), { recursive: true }); } catch {}
    fs.writeFileSync(file, out.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n'));
    console.log(tally);
    console.log('written:', file, `(${out.length - 1} rows to look at)`);
    console.log('READ-ONLY — nothing was entered. Use qb-push-list.js for the ones you decide to enter.');
})().catch((e) => { console.error('qb-vs-sheet failed:', e.message); process.exit(1); });
