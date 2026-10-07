#!/usr/bin/env node
// ── scripts/carrier-remittance-report.js ───────────────────────────────────
// What NTG, TQL and Schneider's EMAIL says Edge Metals was billed and paid in
// 2026. Reads the emails scripts/freight-2026-email-sweep.js --save-emails put
// in data/sample-invoices/<party>/emails/ — OFFLINE: no Gmail, no Gemini, and it
// writes nothing. Parsing lives in helpers/carrierRemittance.js.
//
//   node scripts/carrier-remittance-report.js            summary + reconciliation
//   node scripts/carrier-remittance-report.js --detail   every payment / invoice row
//   node scripts/carrier-remittance-report.js --unparsed list emails no parser claimed

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { parseSavedEmail, groupNtgPayments } = require(path.join(ROOT, 'helpers/carrierRemittance'));

const argv = process.argv.slice(2);
const DETAIL = argv.includes('--detail');
const UNPARSED = argv.includes('--unparsed');
const DIR = process.env.CARRIER_EMAIL_DIR || path.join(ROOT, 'data/sample-invoices');
const $ = (n) => (n == null ? '—' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

const out = { tql: [], ntg: [], schneider: [] };
const unparsed = { tql: [], ntg: [], schneider: [] };
for (const party of Object.keys(out)) {
    const dir = path.join(DIR, party, 'emails');
    if (!fs.existsSync(dir)) { console.log(`(no saved emails for ${party} — run the sweep with --save-emails first)`); continue; }
    for (const f of fs.readdirSync(dir).sort()) {
        const rec = parseSavedEmail(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (rec && rec.party === party) out[party].push({ ...rec, file: f }); else unparsed[party].push(f);
    }
}

console.log('\nNTG / TQL / SCHNEIDER — from email text, 2026. Read-only.\n');

// ── TQL ────────────────────────────────────────────────────────────────────
{
    const pays = out.tql.filter((r) => r.kind === 'payment');
    const sum = pays.reduce((a, r) => a + (r.amount || 0), 0);
    console.log(`TQL — ${pays.length} payment confirmation(s), ${$(sum)} paid`);
    if (DETAIL) for (const p of pays) console.log(`   ${p.date}  ${$(p.amount).padStart(11)}  PO ${p.refs.join(', ') || '?'}  conf ${p.confirmation || '?'}`);
    // The reminder mails restate the same invoices many times; keep the latest sighting of each TQL PO.
    const latest = new Map();
    for (const r of out.tql.filter((x) => x.kind === 'open_invoices')) for (const row of r.rows) latest.set(row.ref, { ...row, seen: r.date });
    const paidPos = new Set(pays.flatMap((p) => p.refs));
    const rows = [...latest.values()].sort((a, b) => String(a.invoice_date).localeCompare(String(b.invoice_date)));
    console.log(`   Invoices TQL has chased for (latest reminder per PO): ${rows.length}`);
    for (const r of rows) {
        const paid = paidPos.has(r.ref);
        console.log(`   PO ${r.ref}  inv ${r.invoice_date}  ${r.lane.padEnd(8)} ${$(r.amount).padStart(10)}  ${paid ? 'PAID per a payment mail' : `no payment mail seen (last reminder ${r.seen}, ${$(r.outstanding)} outstanding)`}`);
    }
    const noInvoice = [...paidPos].filter((po) => !latest.has(po));
    if (noInvoice.length) console.log(`   Paid POs that never appeared in a reminder (so no invoice amount to compare): ${noInvoice.length}${DETAIL ? ' — ' + noInvoice.join(', ') : ''}`);
    console.log('');
}

// ── NTG ────────────────────────────────────────────────────────────────────
{
    // Invoice universe: every invoice that ever appeared on a statement (first
    // sighting amount), plus which statement last listed it as still open.
    const statements = out.ntg.filter((r) => r.kind === 'statement').sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const inv = new Map();
    for (const s of statements) for (const row of s.rows) {
        const cur = inv.get(row.invoice) || { ...row, lastOpenOn: null, lastOpen: null };
        cur.lastOpenOn = s.date; cur.lastOpen = row.open;
        inv.set(row.invoice, cur);
    }
    // Payments: one payment arrives as scheduled + processed + confirmation mails
    // (helpers/carrierRemittance.js groupNtgPayments joins them).
    const payments = groupNtgPayments(out.ntg);
    const paidByInv = new Map();
    for (const p of payments) for (const i of p.invoices) paidByInv.set(i.invoice, (paidByInv.get(i.invoice) || 0) + (i.amount || 0));
    const sum = payments.reduce((a, p) => a + (p.amount || 0), 0);
    console.log(`NTG — ${payments.length} distinct payment(s), ${$(sum)} (incl. any card convenience fees); ${inv.size} invoice(s) seen on ${statements.length} statement(s)`);
    if (DETAIL) for (const p of payments) console.log(`   ${p.date}  ${$(p.amount).padStart(11)}  ${(p.method || '').padEnd(10)} ${p.invoices.length ? 'inv ' + p.invoices.map((i) => `${i.invoice} ${$(i.amount)}`).join(', ') : '(confirmation only — no invoice list in that mail)'}${p.fee ? `  fee ${$(p.fee)}` : ''}`);
    // The reference is the latest OPEN-BALANCE statement (every open invoice);
    // a later PAST-DUE statement only lists overdue ones and is used just to say
    // an invoice has since gone overdue.
    const fullStmts = statements.filter((s) => s.statement_type === 'open');
    const lastFull = fullStmts[fullStmts.length - 1];
    const lastPast = [...statements].reverse().find((s) => s.statement_type === 'past_due');
    const onFull = new Set(lastFull ? lastFull.rows.filter((r) => r.open > 0).map((r) => r.invoice) : []);
    const onPast = new Set(lastPast ? lastPast.rows.filter((r) => r.open > 0).map((r) => r.invoice) : []);
    let unpaid = 0, unpaidSum = 0;
    console.log('   Invoices NOT yet shown as paid (fully paid ones are hidden; --detail shows all):');
    for (const i of [...inv.values()].sort((a, b) => String(a.invoice_date).localeCompare(String(b.invoice_date)))) {
        const paid = paidByInv.get(i.invoice) || 0;
        const isPaid = paid >= i.amount;
        const tag = isPaid ? 'paid per a payment mail'
            : paid > 0 ? `PART-PAID ${$(paid)} of ${$(i.amount)}`
            : onPast.has(i.invoice) ? `PAST DUE on the ${lastPast.date} statement, no payment mail`
            : onFull.has(i.invoice) ? `open on the ${lastFull.date} statement, no payment mail`
            : 'not on the latest open statement and no payment mail — check with NTG';
        if (!isPaid) { unpaid += 1; unpaidSum += i.amount - paid; }
        if (DETAIL || !isPaid) console.log(`   NTG-${i.invoice}  ${i.invoice_date}  ${$(i.amount).padStart(10)}  ${tag}`);
    }
    if (lastFull) console.log(`   Latest open-balance statement (${lastFull.date}) says ${$(lastFull.full_open_balance)} open. Since then payments in this mailbox cover some of it; ${unpaid} invoice(s) still unpaid here, ${$(unpaidSum)}.`);
    const notices = out.ntg.filter((r) => r.kind === 'invoice_notice');
    const noticed = [...new Set(notices.map((n) => n.invoice))];
    const orphan = noticed.filter((n) => !inv.has(n) && !paidByInv.has(n));
    console.log(`   Invoice notices received: ${noticed.length}.${orphan.length ? ` Emailed but on NO saved statement and no payment mail: ${orphan.map((n) => 'NTG-' + n).join(', ')}` : ' Every one appears on a statement or a payment.'}`);
    const paidNoStatement = [...paidByInv.keys()].filter((k) => !inv.has(k));
    if (paidNoStatement.length) console.log(`   Paid invoices that never appeared on a saved statement: ${paidNoStatement.length}${DETAIL ? ' — ' + paidNoStatement.join(', ') : ''}`);
    console.log('');
}

// ── Schneider ──────────────────────────────────────────────────────────────
{
    const byOrder = new Map();
    for (const r of out.schneider.filter((x) => x.kind === 'pay_by_link')) {
        const cur = byOrder.get(r.order) || { ...r, paid: false };
        cur.paid = cur.paid || r.paid;
        byOrder.set(r.order, cur);
    }
    const orders = [...byOrder.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    console.log(`SCHNEIDER — ${orders.length} Pay-by-Link order(s), ${$(orders.reduce((a, o) => a + o.amount, 0))}`);
    for (const o of orders) console.log(`   ${o.date}  order ${o.order}  ${$(o.amount).padStart(10)}  loads ${o.loads.join(', ') || '?'}  ${o.paid ? 'PAID (Bose mailed the confirmation)' : 'no "PAID" mail seen'}`);
    console.log(`   Everything else from Matthew Whittaker (${unparsed.schneider.length} emails) is delivery coordination or rate quotes — not billing.\n`);
}

console.log('Parsed / not claimed by any parser:');
for (const p of Object.keys(out)) console.log(`   ${p.padEnd(9)} ${String(out[p].length).padStart(4)} parsed, ${String(unparsed[p].length).padStart(4)} other`);
if (UNPARSED) for (const p of Object.keys(unparsed)) { console.log(`\n-- ${p} --`); unparsed[p].forEach((f) => console.log('   ' + f)); }
console.log('\nNothing was written anywhere. Recording any of this against a bill or a sale is a separate step.\n');
