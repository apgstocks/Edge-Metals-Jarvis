// ── helpers/onePerContainer.js — one invoice and one packing list per container ─
// The detection behind scripts/one-per-container.js and the Fix-it screen, so
// both say the same thing. READ-ONLY: it returns what it found, deletes nothing.
//
// Apsara, 2026-11-13: "For one container one invoice should be there ... so as
// one packing list ... if its more than one invoice, just keep the latest one".
// One invoice = one INVOICE NUMBER; item lines under it all stay. Grouped by
// container + booking, because a container number is reused months later on a
// different booking and that is a different shipment, not a repeat.
const U = (v) => String(v == null ? '' : v).trim().toUpperCase();
const ckey = (v) => U(v).replace(/[^A-Z0-9]/g, '');
const stampOf = (r) => String(r.updated_at || r.created_at || '')
    || new Date(Number(String(r.id).split('_')[1]) || 0).toISOString();

function invoices(rows) {
    const groups = new Map();
    for (const r of (rows || [])) {
        const c = ckey(r.container_no); if (!c) continue;
        const k = c + '|' + U(r.booking_no);
        (groups.get(k) || groups.set(k, []).get(k)).push(r);
    }
    const found = [], skipped = [];
    for (const rows2 of groups.values()) {
        const byInv = new Map();
        for (const r of rows2) (byInv.get(U(r.invoice_no)) || byInv.set(U(r.invoice_no), []).get(U(r.invoice_no))).push(r);
        if (byInv.size < 2) continue;
        const container = rows2[0].container_no, booking = rows2[0].booking_no || null;
        if (byInv.has('')) { skipped.push({ container, why: 'some rows have no invoice number, so there is no telling which belong together' }); continue; }
        const newest = (rs) => rs.map(stampOf).sort().pop();
        const ranked = [...byInv.entries()].sort((a, b) => newest(b[1]).localeCompare(newest(a[1])));
        found.push({ container, booking, keep: { invoice_no: ranked[0][0], rows: ranked[0][1] },
                     drop: ranked.slice(1).map(([invoice_no, rs]) => ({ invoice_no, rows: rs })) });
    }
    return { found, skipped };
}

function packingLists(lists) {
    const pg = new Map();
    for (const r of (lists || [])) { const c = ckey(r.container_no); if (!c) continue; (pg.get(c) || pg.set(c, []).get(c)).push(r); }
    const found = [];
    for (const rows of pg.values()) {
        if (rows.length < 2) continue;
        const sorted = rows.slice().sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
        found.push({ container: sorted[0].container_no, keep: sorted[0], drop: sorted.slice(1) });
    }
    return { found };
}

module.exports = { invoices, packingLists, ckey, stampOf };
