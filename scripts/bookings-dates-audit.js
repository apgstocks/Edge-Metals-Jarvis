#!/usr/bin/env node
// ── scripts/bookings-dates-audit.js — are the dates on every booking sane? ───
//   node scripts/bookings-dates-audit.js            # active bookings
//   node scripts/bookings-dates-audit.js --history  # include archived
// READ-ONLY. Apsara, 2026-11-21: "Check the bookings ERD, cutoff etc." One line
// per problem, worst first:
//   MISSING   no ERD / cutoff / ETD / ETA
//   FORMAT    a date that is neither MM/DD/YYYY nor YYYY-MM-DD (cannot be read)
//   MIXED     stored as YYYY-MM-DD (readable now, but mail/sheets use MM/DD/YYYY)
//   ORDER     ERD after cutoff, cutoff after ETD, or ETA before ETD
//   EXPIRED   cutoff already passed (should have been archived)
//   WINDOW    ERD more than 30 days before cutoff — usually a typo in the year/month
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { loadBookings, loadWorkflow, loadHistory } = require(path.join(ROOT, 'helpers/json'));
const { parseUSDate, daysUntil } = require(path.join(ROOT, 'helpers/time'));
const FIELDS = [['erd_date', 'ERD'], ['cutoff_date', 'cutoff'], ['etd', 'ETD'], ['eta', 'ETA']];
const blank = (v) => v == null || String(v).trim() === '';
const iso = (v) => /^\d{4}-\d{1,2}-\d{1,2}/.test(String(v).trim());

function audit(bookings, workflow = {}) {
    const out = [];
    for (const [key, b] of Object.entries(bookings || {})) {
        if (!b) continue;
        const id = b.booking_number || key;
        const add = (kind, text) => out.push({ kind, id, text, who: [b.supplier || (workflow[id] || {}).supplier, b.port_of_loading].filter(Boolean).join(', ') });
        const d = {};
        for (const [f, label] of FIELDS) {
            if (blank(b[f])) { if (f === 'erd_date' || f === 'cutoff_date') add('MISSING', `no ${label}`); continue; }
            const dt = parseUSDate(b[f]);
            if (!dt) { add('FORMAT', `${label} "${b[f]}" cannot be read`); continue; }
            if (iso(b[f])) add('MIXED', `${label} stored as ${b[f]}`);
            d[f] = dt;
        }
        const days = (a, c) => Math.round((c - a) / 86400000);
        if (d.erd_date && d.cutoff_date && d.erd_date > d.cutoff_date) add('ORDER', `ERD ${b.erd_date} is AFTER cutoff ${b.cutoff_date}`);
        if (d.cutoff_date && d.etd && d.cutoff_date > d.etd) add('ORDER', `cutoff ${b.cutoff_date} is after ETD ${b.etd}`);
        if (d.etd && d.eta && d.eta < d.etd) add('ORDER', `ETA ${b.eta} is before ETD ${b.etd}`);
        if (d.erd_date && d.cutoff_date && days(d.erd_date, d.cutoff_date) > 30) add('WINDOW', `ERD ${b.erd_date} is ${days(d.erd_date, d.cutoff_date)} days before cutoff ${b.cutoff_date}`);
        if (b.cutoff_date && !blank(b.cutoff_date) && daysUntil(b.cutoff_date) < -1 && daysUntil(b.cutoff_date) !== 999 && !(workflow[id] || {}).keep_active)
            add('EXPIRED', `cutoff ${b.cutoff_date} passed ${-daysUntil(b.cutoff_date)} days ago`);
    }
    const rank = { MISSING: 0, FORMAT: 1, ORDER: 2, EXPIRED: 3, WINDOW: 4, MIXED: 5 };
    return out.sort((a, c) => rank[a.kind] - rank[c.kind] || a.id.localeCompare(c.id));
}

if (require.main === module) {
    const active = loadBookings() || {};
    const all = process.argv.includes('--history') ? { ...(loadHistory() || {}), ...active } : active;
    const rows = audit(all, loadWorkflow());
    console.log(`${Object.keys(all).length} booking(s) checked, ${new Set(rows.map((r) => r.id)).size} with something to look at.\n`);
    let last = '';
    for (const r of rows) { if (r.kind !== last) { console.log(`\n${r.kind}`); last = r.kind; } console.log(`  ${r.id}  ${r.text}${r.who ? '  (' + r.who + ')' : ''}`); }
    if (!rows.length) console.log('All dates look sane.');
}
module.exports = { audit };
