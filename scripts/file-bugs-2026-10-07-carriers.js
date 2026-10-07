#!/usr/bin/env node
// ── scripts/file-bugs-2026-10-07-carriers.js ──────────────────────────────
// Apsara, 2026-10-07: NTG / TQL / Schneider bill EDGE METALS, store them in a
// new carrier-invoices list, and "add it in bugzilla". Same shape as
// scripts/file-bugs-2026-10-07.js. Runs on the VM (BUGS_FILE is under DATA_DIR).
//
//   node scripts/file-bugs-2026-10-07-carriers.js          # dry run
//   node scripts/file-bugs-2026-10-07-carriers.js --write  # file it
//
// Safe to run twice: fileBug() matches on `signature`.
const path = require('path');
const bugs = require(path.join(__dirname, '..', 'helpers', 'bugs'));
const WRITE = process.argv.includes('--write');

const TODAY = [{
    signature: 'carrier-invoices-ntg-tql-schneider-2026-10-07',
    title: 'NTG, TQL and Schneider invoices/payments are not recorded anywhere (Edge Metals)',
    area: 'bills', severity: 'normal', source: 'her', status: 'open', reporter: 'Apsara',
    detail:
        'Edge Metals local-delivery carriers. They send TEXT remittances by email, no PDF, so the '
        + 'placeholder Verify tabs in dashboard/documents.html stay inert and nothing is recorded.\n\n'
        + 'FOUND (2026 mail, scripts/carrier-remittance-report.js): TQL 2 invoices unpaid, $5,500, plus a '
        + 'possible $100 overpayment on PO 37612468; NTG 6 invoices unpaid, $11,500; Schneider 4 of 5 '
        + 'Pay-by-Link orders ($17,950) with no PAID mail.\n\n'
        + 'DECIDED BY APSARA: company = Edge Metals (not Edge Yard); store = a NEW carrier-invoices list, '
        + 'separate from bills/sales/trucking (those are container-keyed, these loads have no container).\n\n'
        + 'NOT YET BUILT: the store, the three tabs, and any write. Keys: TQL PO, NTG invoice no., Schneider '
        + 'order id. Needs an end-to-end test per CLAUDE.md. Parsers: helpers/carrierRemittance.js (3bde450).',
}];

(async () => {
    if (!WRITE) {
        console.log('\n  DRY RUN — nothing written. Add --write to file.\n');
        for (const b of TODAY) console.log(`  [${b.severity}] ${b.title}\n    area ${b.area} · signature ${b.signature}\n`);
        return;
    }
    for (const b of TODAY) {
        const s = await bugs.fileBug(b);
        console.log(`  ${(s.times || 1) > 1 ? 'ALREADY FILED' : 'FILED'}  ${s.id}  ${s.title}`);
    }
})().catch((e) => { console.error('failed:', e && e.message); process.exit(1); });
