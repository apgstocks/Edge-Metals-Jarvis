// ── helpers/partyInvoices.js — what Zimex, Jio, Sher, Pan Metal, AJ Transport and Garduno's invoiced ──
// Apsara, 2026-10-07: "similar for zimex, jio, sher, pan metal, AJ, Gardunos" — an invoice
// LIST per party, read from email, in Jarvis ("Jarvis is the ultimate record"). Chosen over
// copying the sheet tabs into bills (that is scripts/trucker-tabs-to-bills.js).
//
// A REGISTER, NOT A LEDGER. Own store (party_invoices.json). Nothing reads it except the
// register tab: it is not a bill, a sale, a payment or a book entry, so it changes no
// balance and no statement. It records WHAT EACH PARTY BILLED and whether the line was
// found on the Invoice sheet. It says NOTHING about paid/unpaid — a PDF invoice carries
// no payment, and a guess would look reconciled.
//
// One row per invoice LINE (a container, a booking or an HBL), keyed
// party + invoice_no + line key, so a re-import updates in place. A row with `locked`
// (hand-edited) is never overwritten. Writes are strict: a lost write must throw.
const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

const PARTIES = { zimex: 'Zimex', jio: 'Jio', sher: 'Sher Trucking', ajtransport: 'AJ Transport', panmetal: 'Pan Metal', gardunos: "Garduno's" };
// Same ceiling the sweep uses for its trucker tab logging: a drayage line is hundreds of
// dollars; above this on a trucker is almost certainly Edge's own outbound invoice.
const TRUCKING_CAP = 3000;
const TRUCKERS = ['jio', 'sher', 'ajtransport', 'gardunos'];

const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = parseFloat(String(v).replace(/[$,\s]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };
const txt = (v) => String(v == null ? '' : v).trim();
const up = (v) => txt(v).toUpperCase().replace(/\s+/g, '');

// What this line is worth, by party — the same field order the sweep itself reads.
function amountOf(party, r) {
    if (party === 'panmetal') return num(r.commission != null ? r.commission : r.amount);
    return num(r.net_amount != null ? r.net_amount : (r.total_amount != null ? r.total_amount : r.amount));
}

// One export record -> a register row, or { skip: reason }.
function normalize(rec) {
    const party = txt(rec && rec.party).toLowerCase();
    if (!PARTIES[party]) return { skip: 'unknown party' };
    if (rec.extraction_failed) return { skip: 'extraction failed' };
    const amount = amountOf(party, rec);
    if (amount === null || amount === 0) return { skip: 'no amount (booking confirmation / certificate, not an invoice)' };
    // Per load, for sher: the invoice amount covers `quantity` loads.
    const perLoad = TRUCKERS.includes(party) ? amount / (Number(rec.quantity) > 0 ? Number(rec.quantity) : 1) : 0;
    if (TRUCKERS.includes(party) && perLoad > TRUCKING_CAP) return { skip: `over $${TRUCKING_CAP} per load — probably not a ${PARTIES[party]} invoice` };
    const line = up(rec.container_no) || up(rec.booking_no) || up(rec.hbl_no) || up(rec.order_no);
    const invoiceNo = txt(rec.invoice_no);
    if (!line && !invoiceNo) return { skip: 'no invoice number and no container/booking/HBL to key it on' };
    return {
        row: {
            party, key: `${party}:${invoiceNo || '(none)'}:${line || '(none)'}`,
            invoice_no: invoiceNo || null, invoice_date: txt(rec.invoice_date) || null,
            container_no: up(rec.container_no) || null, booking_no: up(rec.booking_no) || null, hbl_no: up(rec.hbl_no) || null,
            amount, quantity: num(rec.quantity),
            check_status: txt(rec.status) || null,            // verified / match / not_in_sheet / booking_mismatch / …
            source_file: txt(rec.source_file) || null, source_subject: txt(rec.source_subject) || null,
            source_date: txt(rec.source_date) || null, source_mailbox: txt(rec.source_mailbox) || null,
        },
    };
}

const list = () => { const r = loadJson(cfg.PARTY_INVOICES_FILE, []); return Array.isArray(r) ? r : []; };

// rows: normalize().row[]. Returns { added, updated, kept_locked }.
async function upsertMany(rows) {
    let added = 0, updated = 0, keptLocked = 0;
    await mutateJson(cfg.PARTY_INVOICES_FILE, [], (cur) => {
        const arr = Array.isArray(cur) ? cur : [];
        const at = new Map(arr.map((r, i) => [r.key, i]));
        for (const row of rows) {
            const now = new Date().toISOString();
            if (!at.has(row.key)) { arr.push({ id: `PI_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, ...row, createdAt: now, updatedAt: now }); at.set(row.key, arr.length - 1); added++; }
            else if (arr[at.get(row.key)].locked) keptLocked++;
            else { const i = at.get(row.key); arr[i] = { ...arr[i], ...row, updatedAt: now }; updated++; }
        }
        return arr;
    }, { strict: true });
    return { added, updated, kept_locked: keptLocked };
}

function summary(rows = list()) {
    const out = {};
    for (const p of Object.keys(PARTIES)) {
        const r = rows.filter((x) => x.party === p);
        out[p] = { label: PARTIES[p], count: r.length, total: Math.round(r.reduce((a, x) => a + x.amount, 0) * 100) / 100,
            not_on_sheet: r.filter((x) => x.check_status === 'not_in_sheet').length,
            verified: r.filter((x) => x.check_status === 'verified' || x.check_status === 'match').length };
    }
    return out;
}

module.exports = { PARTIES, TRUCKING_CAP, normalize, amountOf, list, upsertMany, summary };
