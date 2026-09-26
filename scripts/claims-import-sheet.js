#!/usr/bin/env node
// ── scripts/claims-import-sheet.js — the terminal face of the sheet import ────
//
//   node scripts/claims-import-sheet.js                 # dry run, writes nothing
//   node scripts/claims-import-sheet.js --really         # writes
//   node scripts/claims-import-sheet.js --reclassify      # re-ask about claims already in
//   node scripts/claims-import-sheet.js --no-ai           # ask nothing; all import unclassified
//   node scripts/claims-import-sheet.js --from-row=51      # ignore the marker, start here
//   node scripts/claims-import-sheet.js --csv=./ws.csv     # from a file, no network
//   node scripts/claims-import-sheet.js --xlsx=./book.xlsx # from a workbook
//
// All of the actual work lives in helpers/claims/importSheet.js, because the page
// does the same job — Apsara, 2026-09-26: "if i upload the weight shortage sheet
// and ai to classify them properly and put it into website, it should do that."
// This file only turns the result into text. Two implementations of an import
// that moves money would drift, and one of them would be the one nobody ran.
require('dotenv').config();
const fs = require('fs');
const imp = require('../helpers/claims/importSheet');
const claims = require('../helpers/claims');
const claimKinds = require('../helpers/claimKinds');

const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=').trim() : null; };
const REALLY = process.argv.includes('--really');
const NO_AI = process.argv.includes('--no-ai');
const RECLASSIFY = process.argv.includes('--reclassify');
const FROM_ROW = Number(arg('from-row')) || undefined;
const CSV_PATH = arg('csv');
const XLSX_PATH = arg('xlsx');

const money = (n) => (n === null || n === undefined ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }));
const pad = (s, n) => String(s == null ? '' : s).padEnd(n);

async function main() {
    const input = { useAi: !NO_AI, fromRow: FROM_ROW };
    if (CSV_PATH) { input.csv = fs.readFileSync(CSV_PATH, 'utf8'); input.name = CSV_PATH; }
    else if (XLSX_PATH) { input.xlsxBase64 = fs.readFileSync(XLSX_PATH).toString('base64'); input.name = XLSX_PATH; }

    process.stdout.write(`Reading ${CSV_PATH || XLSX_PATH || 'the live Weight Shortage tab'}\n`);
    input.onProgress = (r) => process.stdout.write(r.claim_type === null && r.type_unresolved === 'not asked' ? '-' : (r.named ? '.' : '?'));

    const p = await imp.plan(input);
    process.stdout.write('\n\n');

    console.log(`Read ${p.source} — ${p.sheetRows} sheet rows`);
    if (p.start.marker) console.log(`  Starting at row ${p.start.startRow + 1}, just after "${p.start.marker}" — ${p.start.ignoredAbove} row(s) above it ignored`);
    else if (p.start.startRow) console.log(`  Starting at row ${p.start.startRow + 1} as asked — ${p.start.ignoredAbove} row(s) above it ignored`);
    if (p.tabs) console.log(`  sheets in the file: ${p.tabs.join(', ')}`);
    for (const b of p.blocks) {
        console.log(`  row ${String(b.row).padStart(3)}  ${b.label}`);
        console.log(`            claim against Edge ← "${b.claimFrom || '(none)'}"   recovery from supplier ← "${b.recoveryFrom || '(none)'}"   supplier ← "${b.supplierFrom || '(none)'}"`);
    }
    console.log('');

    if (RECLASSIFY) {
        console.log(`Re-asking the model about ${p.already.length} claim(s) already in the register\n`);
        const r = await imp.reclassify(p, { write: REALLY, useAi: !NO_AI });
        for (const c of r.changed) console.log(`  ${pad(c.container_no || c.invoice_no, 14)} ${claimKinds.label(c.from)} → ${claimKinds.label(c.to)}   ${c.why}`.slice(0, 170));
        console.log(`\n${r.changed.length} kind(s) ${REALLY ? 'changed' : 'would change'} · ${r.kept} confirmed as they are · ${r.couldNotSay} left alone because the model still could not say`);
        if (!REALLY) console.log('DRY RUN — add --really to apply.');
        return;
    }

    console.log(`${p.claims.length} claims to import · ${p.merged.length} built from repeated rows · ${p.already.length} already in the register · ${p.skipped.length} rows skipped · ${p.manual.length} need entering by hand\n`);

    if (p.merged.length) {
        console.log('REPEATED ROWS, merged into one claim (blanks filled from the other copies):');
        for (const d of p.merged) console.log(`  rows ${pad(d.rows.join('+'), 9)} ${d.invoice_no} / ${d.container_no}  → ${money(d.claim_amount)} / recovery ${money(d.our_claim)}`);
        console.log('');
    }
    if (p.split.length) {
        console.log('ONE CONTAINER, MORE THAN ONE CLAIM — kept separate, because the amounts differ:');
        for (const d of p.split) console.log(`  row ${pad(d.rows.join('+'), 5)} ${d.invoice_no} / ${d.container_no}  ${money(d.claim_amount)}  ${claimKinds.label(d.kind)}`);
        console.log('');
    }
    if (p.manual.length) {
        console.log('NOT IMPORTED — the identifier columns hold prose, not identifiers. Enter these by hand on /claims:');
        for (const m of p.manual) console.log(`  row ${String(m.rowNo).padStart(3)}  ${m.cells.slice(0, 110)}`);
        console.log('');
    }
    if (p.noUnit.length) {
        console.log('UNIT LEFT BLANK — imported, but flagged for a person:');
        for (const r of p.noUnit) console.log(`  row ${pad(r.rows.join('+'), 5)} ${r.invoice_no} / ${r.container_no}  ${r.why}`);
        console.log('');
    }

    const v = p.vocabulary;
    if (v.named.length) {
        console.log(`Named row by row, ${v.named.length} different name(s):`);
        for (const n of v.named) console.log(`  ${String(n.count).padStart(3)}  ${n.label}`);
        if (v.settled) {
            console.log(`\nSettled into ${v.kinds.length}: ${v.kinds.map((k) => k.label).join(', ')}`);
            if (v.why) console.log(`  ${v.why}`);
            if ((v.unmapped || []).length) console.log(`  kept as given because the model did not place them: ${v.unmapped.join(', ')}`);
            if (v.folds.length) console.log(`  folded: ${v.folds.join(' · ')}`);
        } else if (v.named.length > 1) {
            console.log('\nThe model could not settle a vocabulary — keeping the names it gave row by row.');
        }
        console.log('');
    }

    console.log('KINDS OF CLAIM the model named, per container, from each row\'s own words:');
    for (const [, k] of Object.entries(p.byKind).sort((a, b) => b[1].claims - a[1].claims)) {
        console.log(`  ${pad(k.label, 24)} ${String(k.claims).padStart(3)}  ${money(k.claimed)}`);
    }
    if (p.unresolved.length) {
        const why = p.unresolved.reduce((o, r) => { o[r.why] = (o[r.why] || 0) + 1; return o; }, {});
        console.log(`  ${p.unresolved.length} of ${p.claims.length} NOT classified — nothing was guessed for these:`);
        for (const [reason, n] of Object.entries(why)) console.log(`    ${String(n).padStart(3)}  ${reason}`);
        console.log('    Run --reclassify later and the model is asked again, or set the kind on /claims.');
    } else if (!NO_AI) {
        console.log(`  all ${p.claims.length} classified by the model`);
    }
    const kinds = claimKinds.list();
    if (kinds.length >= claimKinds.DRIFT_WARN_AT) {
        console.log(`\n  ${kinds.length} different kinds are now in use — some are the same argument under different names. Merge them on /claims.`);
    }
    console.log('');

    console.log('STATUS, read from the sheet\'s own notes:', JSON.stringify(p.byStatus));
    console.log(`TOTALS to import: claimed ${money(p.totals.claimed)} · recovered ${money(p.totals.recovered)} · absorbed ${money(p.totals.net)}`);

    if (!REALLY) {
        console.log('\nDRY RUN — nothing written. Re-run with --really to import.');
        console.log('No to-do is raised and no WhatsApp is sent either way.');
        return;
    }

    const w = await imp.commit(p);
    console.log(`\nImported ${w.created} claim(s). No to-do raised, no WhatsApp sent.`);
    const s = claims.stats();
    console.log(`Register now: ${s.total} claims · claimed ${money(s.claimed)} · recovered ${money(s.recovered)} · absorbed ${money(s.net)} · ${s.unverified} unverified · ${s.unclassified} unclassified · ${s.awaiting_recovery} awaiting recovery`);
}

main().catch((e) => { console.error('\nImport failed:', e.message); process.exit(1); });
