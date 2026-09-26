// ── helpers/quickbooks/vsSheet.js — her live sheet against her live books ───
// Apsara, 2026-09-24: "run qb against my live sheet. if anything is missing,
// put a entry". 2026-09-26: "i basically want my website to handle whatever we
// can do from qb from here" — so the comparison moves out of the script and
// into a module the page and scripts/qb-vs-sheet.js both call. One
// implementation: two answers that disagree would be worse than none.
//
// SHIPMENTS 2026 is what she BOUGHT, Order Details 2026 is what she SOLD.
// Each container is rolled up and asked of QuickBooks — by container first
// (her books carry it in the line description), then invoice number, then
// amount and date.
//
// READ-ONLY. Entering what is missing is a separate, deliberate act, because
// most of what is missing sits BEFORE the cutover in the period her accountant
// owns, and $3M of entries is not a side effect of a report.
const cfg = require('../../config');
const client = require('./client');
const push = require('./push');

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const KEY = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const money = (v) => { const n = Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : null; };
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
function rollup(rows, pick, since) {
    const by = {};
    for (const row of rows.slice(1)) {
        const r = pick(row);
        if (!r || !r.date || r.date < since || !(r2(r.amount) > 0)) continue;
        const key = KEY(r.container) || KEY(r.no) || `${r.date}|${KEY(r.party)}`;
        const g = by[key] || (by[key] = { date: r.date, container: r.container, no: r.no, party: r.party, amount: 0, lines: 0 });
        g.amount = r2(g.amount + r2(r.amount)); g.lines++;
        if (r.date < g.date) g.date = r.date;
    }
    return Object.values(by);
}

async function fromQuickBooks(since, env) {
    const pull = async (t) => { let all = [], s = 1; for (;;) {
        const r = (await client.query(`select * from ${t} where TxnDate >= '${since}' startposition ${s} maxresults 1000`, { env }))[t] || [];
        all = all.concat(r); if (r.length < 1000) break; s += 1000; } return all; };
    const shape = (x, ref) => ({ id: String(x.Id), date: x.TxnDate, doc: String(x.DocNumber || '').trim(), party: ((x[ref] || {}).name) || '',
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

// One row per thing worth looking at. A row that agrees is not a finding and
// is only counted — a report she has to scroll past is a report she stops
// reading.
async function compare({ since = '2026-01-01', env = 'production' } = {}) {
    const [buys, sells] = await Promise.all([sheet('SHIPMENTS 2026!A1:BJ3000'), sheet('Order Details 2026!A1:AZ2000')]);
    const bills = rollup(buys, (row) => ({ date: date(row[3]), party: row[4], no: row[6], container: row[8], amount: money(row[20]) }), since);
    const sales = rollup(sells, (row) => ({ date: date(row[2]), party: row[9], no: row[1], container: row[5], amount: money(row[15]) }), since);
    const qb = await fromQuickBooks(since, env);
    const cut = { bill: push.cutoverFor('bill', env), invoice: push.cutoverFor('invoice', env) };

    const findings = [];
    const tally = {};
    const bump = (k, amt) => { tally[k] = tally[k] || { rows: 0, value: 0 }; tally[k].rows++; tally[k].value = r2(tally[k].value + (amt || 0)); };
    for (const [kind, rows] of [['bill', bills], ['invoice', sales]]) {
        for (const row of rows) {
            const { hit, how, fits, multi } = look(row, qb[kind]);
            const side = cut[kind] && row.date >= cut[kind] ? 'jarvis' : 'accountant';
            const base = { kind, date: row.date, party: row.party || '', container: row.container || '', no: row.no || '', amount: row.amount, side };
            if (!hit) { bump(`${kind} missing (${side})`, row.amount); findings.push({ ...base, status: 'missing', qb: null, note: '' }); continue; }
            if (fits) { bump(`${kind} agrees`, row.amount); continue; }
            if (multi) { bump(`${kind} consolidated`, row.amount);
                findings.push({ ...base, status: 'consolidated', qb: { id: hit.id, total: hit.total, party: hit.party },
                    note: `#${hit.id} covers ${hit.containers.length} containers, ${hit.total} in total` }); continue; }
            bump(`${kind} amount differs`, row.amount);
            findings.push({ ...base, status: 'differs', qb: { id: hit.id, total: hit.total, party: hit.party },
                note: `QuickBooks #${hit.id} ${hit.party} says ${hit.total}${hit.gross !== hit.total ? ` (${hit.gross} before trucking)` : ''} — matched by ${how}` });
        }
    }
    findings.sort((a, b) => (b.amount - a.amount));
    return { since, env, at: new Date().toISOString(), cutover: cut,
        sheet: { purchases: bills.length, sales: sales.length },
        quickbooks: { bills: qb.bill.length, invoices: qb.invoice.length },
        tally, findings,
        totals: {
            missingBefore: r2(findings.filter((f) => f.status === 'missing' && f.side === 'accountant').reduce((s, f) => s + f.amount, 0)),
            missingAfter: r2(findings.filter((f) => f.status === 'missing' && f.side === 'jarvis').reduce((s, f) => s + f.amount, 0)),
        } };
}

module.exports = { compare, rollup, look, date, money };
