#!/usr/bin/env node
// ── scripts/claims-import-sheet.js — the history, out of the tab and into the
//    register ──────────────────────────────────────────────────────────────────
//
// Apsara, 2026-09-26: "upload them properly from sheet."
//
//   node scripts/claims-import-sheet.js                 # dry run, writes nothing
//   node scripts/claims-import-sheet.js --really         # writes
//   node scripts/claims-import-sheet.js --csv=./ws.csv   # from a file, no network
//
// ── IT RAISES NO TO-DO AND SENDS NO WHATSAPP ────────────────────────────────
// This is the whole reason the import is a script and not a loop over
// claimWatch. A Jarvis task is a delayed SEND: scheduler's taskRunner fires
// every minute and messages the target. Eighty-odd historical claims through
// the normal creation path would raise eighty-odd manager to-dos and WhatsApp
// every one of them. So this file talks to helpers/claims directly and never
// touches helpers/tasks or any sender.
//
// ── COLUMNS ARE MATCHED BY HEADER NAME, NEVER BY POSITION ───────────────────
// The tab is seven tables stacked down one grid, each with its own header row.
// An importer keyed on row or column numbers breaks the first time anybody
// inserts a line. So this walks the sheet, and every time it meets a header row
// it rebuilds the column map from the header TEXT.
//
// ── THE TRAP IN THE 2025 BLOCK ──────────────────────────────────────────────
// In the legacy block the column headed "Buyer" holds the SUPPLIER (Gomez,
// Freddy, INES, Calderon — who Edge bought from), and there are two money
// columns: "Amount" is what the customer claims from Edge, "Claim Amount" is
// what Edge claims back from the supplier. Everywhere else those two are
// "Claim amount" and "Our Claim". Getting this backwards silently swaps a cost
// for a recovery, so the mapping is decided per block from the header row and
// printed in the dry run for checking.
require('dotenv').config();
const fs = require('fs');
const cfg = require('../config');
const claims = require('../helpers/claims');
const { parseCsv } = require('../helpers/nextInvoiceNo');
const claimKind = require('../helpers/claimKind');

const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=').trim() : null; };
const REALLY = process.argv.includes('--really');
const NO_AI = process.argv.includes('--no-ai');
const CSV_PATH = arg('csv');

const lc = (s) => String(s == null ? '' : s).trim().toLowerCase();
const txt = (s) => String(s == null ? '' : s).trim();
const num = (v) => {
    const t = txt(v).replace(/[$,]/g, '').replace(/\s/g, '');
    if (!t || t === '-' || t === '#VALUE!') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
};

// ── HEADER → FIELD ──────────────────────────────────────────────────────────
const SYN = {
    customer:   ['customer name'],
    supplier:   ['supplier', 'buyer'],
    invoice:    ['inv nbr', 'inv no', 'invoice no', 'inv no.'],
    container:  ['container number', 'cont no.', 'container no'],
    inv_weight: ['inv weight', 'gross'],
    recv_weight:['claimed weight', 'received weight', 'received'],
    shortage:   ['shortage in mt', 'diff in weight', 'difference', 'shortage'],
    sell_price: ['inv price', 'selling price'],
    status_note:['claim status'],
    note:       ['claim note'],
    date:       ['date'],
};

function isHeaderRow(cells) {
    const set = cells.map(lc);
    const hasKey = set.includes('container number') || set.includes('cont no.');
    return hasKey && cells.filter((c) => txt(c)).length >= 3;
}

function mapColumns(cells) {
    const set = cells.map(lc);
    const at = (names) => { for (const n of names) { const i = set.indexOf(n); if (i !== -1) return i; } return -1; };
    const m = {};
    for (const [field, names] of Object.entries(SYN)) m[field] = at(names);

    // The legacy 2025 shape: "Buyer" + "Buying Price", customer and invoice in
    // the first two unnamed columns, and the two money columns reversed.
    const legacy = set.includes('buyer') && set.includes('buying price');
    if (legacy) {
        m.customer = 0;
        m.invoice = 1;
        m.claim_amount = at(['amount']);
        m.our_claim = at(['claim amount']);
    } else {
        m.claim_amount = at(['claim amount']);
        m.our_claim = at(['our claim']);
    }
    m.__legacy = legacy;
    m.__headers = cells.map(txt);
    return m;
}

// Her own rule, from the ledger notes: a container's tonnage is normally within
// 100 MT and a real one is about 25. Anything bigger in a column headed MT is
// pounds or a typo, never a tonnage. So MT is set only where the figures obey
// that; otherwise the weights are kept and the unit is left for a person.
function unitFor(inv, recv) {
    const vals = [inv, recv].filter((v) => v !== null);
    if (!vals.length) return { unit: null, why: 'no weights on the row' };
    if (vals.every((v) => v > 0 && v <= 100)) return { unit: 'MT', why: '' };
    return { unit: null, why: `weights out of tonnage range (${vals.join(', ')}) — pounds or a typo in an MT column` };
}

function statusFor(noteText, claim_amount, our_claim) {
    const n = lc(noteText);
    if (/removed by customer/.test(n)) return 'withdrawn';
    if (/ignored/.test(n)) return 'rejected';
    if (/paid|zelle/.test(n)) return 'settled';
    if (claim_amount !== null) return 'verified';
    return 'unverified';
}

async function main() {
    // ── read ────────────────────────────────────────────────────────────────
    let text;
    if (CSV_PATH) {
        text = fs.readFileSync(CSV_PATH, 'utf8');
        console.log(`Reading ${CSV_PATH}`);
    } else {
        const url = `https://docs.google.com/spreadsheets/d/${cfg.INVOICE_SHEET_ID}/export?format=csv&gid=${cfg.CLAIMS_SHEET_GID}`;
        console.log(`Reading the Weight Shortage tab (gid ${cfg.CLAIMS_SHEET_GID})`);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Could not read the tab (${res.status}). The sheet must be link-viewable, or pass --csv=<file>.`);
        text = await res.text();
    }
    const table = parseCsv(text);
    console.log(`${table.length} sheet rows\n`);

    // ── walk ────────────────────────────────────────────────────────────────
    let map = null, blockNo = 0, blockLabel = '';
    // A single-cell row like "Reg/Al Engine claim", "Weight Shortage claim",
    // "ROTORS AND DRUMS" or "Steel Engine/Transmission claim" is not noise — it
    // is the heading that says what the rows under it are claiming. Carried down
    // as context for the classifier.
    let section = '';
    let sectionRow = -99;
    const found = [];
    const skipped = [];
    const manual = [];

    table.forEach((cells, i) => {
        const rowNo = i + 1;
        const filled = cells.filter((c) => txt(c)).length;
        if (!filled) return;

        if (isHeaderRow(cells)) {
            map = mapColumns(cells);
            blockNo += 1;
            blockLabel = `block ${blockNo}${map.__legacy ? ' (legacy 2025 shape)' : ''}`;
            console.log(`row ${String(rowNo).padStart(3)}  ── ${blockLabel} ──`);
            console.log(`            claim against Edge ← "${map.__headers[map.claim_amount] || '(none)'}"   recovery from supplier ← "${map.__headers[map.our_claim] || '(none)'}"   supplier ← "${map.__headers[map.supplier] || '(none)'}"`);
            return;
        }
        if (!map) { skipped.push({ rowNo, why: 'above the first header row' }); return; }

        const g = (f) => (map[f] >= 0 ? cells[map[f]] : '');
        const invoice = txt(g('invoice'));
        const container = txt(g('container')).toUpperCase().replace(/\s+/g, '');

        // A section label ("2026 Claims", "ROTORS AND DRUMS", "AUTO CAST") is a
        // row with one cell and nothing to key on.
        if (!invoice && !container) {
            const label = cells.map(txt).filter(Boolean).join(' ');
            if (filled <= 3 && /[a-z]/i.test(label) && label.length <= 60) { section = label; sectionRow = rowNo; }
            skipped.push({ rowNo, why: filled <= 2 ? `section label "${label}"` : 'no invoice and no container' });
            return;
        }

        // Some rows are prose in the identifier columns rather than
        // identifiers — row 70 of the live tab is the container number in the
        // customer column and "conatiner damage / Claim to Modern / Paid with
        // invoice 26MK39" spread across the rest. Importing that produces a
        // claim against a customer called "conatiner damage". So an identifier
        // has to look like one: a real ISO 6346 container, or an invoice token
        // with a digit in it and no spaces.
        const realContainer = /^[A-Z]{4}\d{7}$/.test(container);
        const realInvoice = /\d/.test(invoice) && !/\s/.test(invoice) && invoice.length <= 30;
        if (!realContainer && !realInvoice) {
            manual.push({ rowNo, block: blockLabel, invoice, container, cells: cells.filter((c) => txt(c)).slice(0, 6).join(' | ') });
            return;
        }

        const inv_weight = num(g('inv_weight'));
        const recv_weight = num(g('recv_weight'));
        const claim_amount = num(g('claim_amount'));
        const our_claim = num(g('our_claim'));
        const sheetShortage = num(g('shortage'));
        const noteText = [txt(g('status_note')), txt(g('note')), map.__legacy && map.claim_amount >= 0 ? txt(cells[map.claim_amount + 1]) : ''].filter(Boolean).join(' | ');

        const { unit, why: unitWhy } = unitFor(inv_weight, recv_weight);
        found.push({
            rowNo, block: blockLabel,
            // Everything the row says, plus the block and section headings above
            // it — this is what the classifier reads.
            // Context, strongest first: the block's own column headings — which
            // for the engine blocks are the only place the claim is named at all
            // ("Reg.Engine& Steel haed Combo", "Alu.Engine Combo") — then the
            // section heading, but ONLY if it is within three rows. A sticky
            // section heading is what turned eleven weight shortages into
            // "ROTORS AND DRUMS" contamination on the first run.
            text: claimKind.rowText(cells, [
                (map.__headers || []).filter(Boolean).join(' '),
                (rowNo - sectionRow) <= 3 ? section : '',
            ].filter(Boolean).join(' / ')),
            customer: txt(g('customer')), supplier: txt(g('supplier')),
            invoice_no: invoice, container_no: container,
            invoice_weight: inv_weight, claimed_weight: recv_weight, weight_unit: unit,
            shortage: sheetShortage,
            sell_price: num(g('sell_price')),
            claim_amount, our_claim,
            status: statusFor(noteText, claim_amount, our_claim),
            note: noteText, unitWhy, date: txt(g('date')),
        });
    });

    // ── GROUPING, and why it is not a plain dedupe ──────────────────────────
    // (invoice, container) is NOT unique on this tab, and the two reasons look
    // identical until you read the amounts:
    //
    //   26ME07 / TEMU7944250 appears twice for $450 and $3,100 — hand tools
    //   found in the load, and a recovery shortfall. Two real claims on one
    //   container, totalling the $3,550 the sheet itself shows.
    //
    //   25DK09 / MEDU5374011 also appears twice, once with no amount at all and
    //   once with $124.02 — one claim, entered twice, the first copy incomplete.
    //
    // So: group by invoice + container, merge blanks from the other copies, and
    // split back out only where the group holds two or more DIFFERENT non-null
    // claim amounts. First-copy-wins would have silently dropped $4,222.96 on
    // 25JY56, whose first copy is the empty one.
    const groups = new Map();
    for (const r of found) {
        const key = claims.keyOf(r.invoice_no, r.container_no);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
    }
    const FILL = ['customer', 'supplier', 'invoice_weight', 'claimed_weight', 'weight_unit', 'sell_price', 'shortage', 'our_claim', 'date'];
    const richness = (r) => FILL.filter((f) => r[f] !== null && r[f] !== '' && r[f] !== undefined).length + (r.claim_amount !== null ? 3 : 0);

    const toWrite = [], merged = [], already = [];
    for (const [, rows] of groups) {
        const amounts = [...new Set(rows.map((r) => r.claim_amount).filter((v) => v !== null))];
        const lines = amounts.length > 1
            ? amounts.map((a) => rows.filter((r) => r.claim_amount === a))   // separate claims
            : [rows];                                                        // one claim, maybe several copies
        for (const copies of lines) {
            const best = copies.slice().sort((a, b) => richness(b) - richness(a))[0];
            const out = { ...best, fromRows: copies.map((c) => c.rowNo), otherTexts: copies.filter((c) => c !== best).map((c) => c.text) };
            for (const f of FILL) {
                if (out[f] === null || out[f] === '' || out[f] === undefined) {
                    const donor = copies.find((c) => c[f] !== null && c[f] !== '' && c[f] !== undefined);
                    if (donor) out[f] = donor[f];
                }
            }
            if (copies.length > 1) merged.push(out);
            // Idempotency. findByKey alone is not enough: where one container
            // legitimately carries two claims, the key matches both, so a
            // re-run would import them again every time. Match the AMOUNT too.
            const key = claims.keyOf(out.invoice_no, out.container_no);
            const existing = claims.list().filter((c) => c && c.key === key);
            const dup = existing.some((c) => (out.claim_amount === null
                ? (c.claim_amount === null || c.claim_amount === undefined)
                : Math.abs((c.claim_amount || 0) - out.claim_amount) < 0.005));
            if (dup) { already.push(out); continue; }
            toWrite.push(out);
        }
    }

    // ── WHAT KIND OF CLAIM IS EACH ONE ──────────────────────────────────────
    // Per claim, from its own words. The model decides; helpers/claimKind's rules
    // decide when there is no key, the call fails, or the model is unsure — so an
    // expired key mislabels nothing, it just labels less cleverly.
    if (toWrite.length) {
        process.stdout.write(`Classifying ${toWrite.length} claim(s)${NO_AI ? ' (rules only, --no-ai)' : ''}`);
        for (const r of toWrite) {
            const text = [r.text, ...(r.otherTexts || [])].filter(Boolean).join(' || ');
            const verdict = await claimKind.classify(text, {
                useAi: !NO_AI,
                hasWeights: r.invoice_weight !== null && r.claimed_weight !== null,
                shortage: r.shortage,
            });
            r.claim_type = verdict.type;
            r.type_by = verdict.by;
            r.type_why = verdict.why;
            r.type_quote = verdict.quote || '';
            process.stdout.write('.');
        }
        process.stdout.write('\n\n');
    }

    // ── report ──────────────────────────────────────────────────────────────
    const money = (n) => (n === null ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }));
    console.log(`\n${found.length} claim rows read · ${toWrite.length} claims to import · ${merged.length} built from repeated rows · ${already.length} already in the register · ${skipped.length} rows skipped · ${manual.length} need entering by hand\n`);

    if (merged.length) {
        console.log('REPEATED ROWS, merged into one claim (blanks filled from the other copies):');
        for (const d of merged) console.log(`  rows ${d.fromRows.join('+').padEnd(9)} ${d.invoice_no} / ${d.container_no}  → ${money(d.claim_amount)} / recovery ${money(d.our_claim)}`);
        console.log('');
    }
    const split = toWrite.filter((r) => toWrite.filter((x) => claims.keyOf(x.invoice_no, x.container_no) === claims.keyOf(r.invoice_no, r.container_no)).length > 1);
    if (split.length) {
        console.log('ONE CONTAINER, MORE THAN ONE CLAIM — kept separate, because the amounts differ:');
        for (const d of split) console.log(`  row ${String(d.fromRows.join('+')).padStart(3)}  ${d.invoice_no} / ${d.container_no}  ${money(d.claim_amount)}  ${d.note.slice(0, 60)}`);
        console.log('');
    }
    if (manual.length) {
        console.log('NOT IMPORTED — the identifier columns hold prose, not identifiers. Enter these by hand on /claims:');
        for (const m of manual) console.log(`  row ${String(m.rowNo).padStart(3)}  ${m.cells.slice(0, 110)}`);
        console.log('');
    }
    const noUnit = toWrite.filter((r) => !r.weight_unit && r.unitWhy && !/no weights/.test(r.unitWhy));
    if (noUnit.length) {
        console.log('UNIT LEFT BLANK — imported, but flagged for a person:');
        for (const r of noUnit) console.log(`  row ${String(r.rowNo).padStart(3)}  ${r.invoice_no} / ${r.container_no}  ${r.unitWhy}`);
        console.log('');
    }
    const byKind = toWrite.reduce((o, r) => { o[r.claim_type] = (o[r.claim_type] || 0) + 1; return o; }, {});
    console.log('KIND OF CLAIM, decided per container from the row\'s own words:');
    for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
        const money2 = toWrite.filter((r) => r.claim_type === k).reduce((t, r) => t + (r.claim_amount || 0), 0);
        console.log(`  ${claimKind.LABEL[k].padEnd(20)} ${String(n).padStart(3)}  ${money(money2)}`);
    }
    const notWeight = toWrite.filter((r) => r.claim_type !== 'weight_shortage');
    if (notWeight.length) {
        console.log('\n  NOT a weight shortage — these would have been mislabelled:');
        for (const r of notWeight) {
            console.log(`    ${(r.container_no || r.invoice_no).padEnd(14)} ${claimKind.LABEL[r.claim_type].padEnd(19)} [${r.type_by}] ${r.type_why}`.slice(0, 150));
        }
    }
    console.log('');
    const byStatus = toWrite.reduce((o, r) => { o[r.status] = (o[r.status] || 0) + 1; return o; }, {});
    console.log('STATUS, read from the sheet\'s own notes:', JSON.stringify(byStatus));
    const tClaim = toWrite.reduce((t, r) => t + (r.claim_amount || 0), 0);
    const tOurs = toWrite.reduce((t, r) => t + (r.our_claim || 0), 0);
    console.log(`TOTALS to import: claimed ${money(tClaim)} · recovered ${money(tOurs)} · absorbed ${money(tClaim - tOurs)}`);

    if (!REALLY) {
        console.log('\nDRY RUN — nothing written. Re-run with --really to import.');
        console.log('No to-do is raised and no WhatsApp is sent either way.');
        return;
    }

    // ── write ───────────────────────────────────────────────────────────────
    // create() never sets money by design, so the figures the sheet already
    // holds go on in a second step, and the history line records where they
    // came from.
    let n = 0;
    for (const r of toWrite) {
        const rec = await claims.create({
            claim_type: r.claim_type || 'other',
            customer: r.customer, supplier: r.supplier,
            invoice_no: r.invoice_no, container_no: r.container_no,
            invoice_weight: r.invoice_weight, claimed_weight: r.claimed_weight,
            weight_unit: r.weight_unit,
            sell_price: r.sell_price, sell_price_unit: r.weight_unit,
            note: [r.note, r.unitWhy && !/no weights/.test(r.unitWhy) ? r.unitWhy : ''].filter(Boolean).join(' | '),
        }, 'sheet-import');

        const patch = { status: r.status };
        // Keep how the kind was decided, so a wrong label is arguable rather
        // than just wrong.
        patch.quotes = { claim_type: r.type_quote || r.type_why || '' };
        if (r.claim_amount !== null) patch.claim_amount = r.claim_amount;
        if (r.our_claim !== null) patch.our_claim = r.our_claim;
        if (r.shortage !== null) patch.shortage = r.shortage;
        if (r.invoice_weight && r.shortage !== null && r.invoice_weight > 0 && r.invoice_weight <= 100) {
            patch.shortage_pct = Math.round((r.shortage / r.invoice_weight) * 10000) / 100;
        }
        await claims.update(rec.id, patch, 'sheet-import',
            `imported from the Weight Shortage tab, row ${r.rowNo} (${r.block}) — figures as the sheet recorded them`);
        n += 1;
    }
    console.log(`\nImported ${n} claim(s). No to-do raised, no WhatsApp sent.`);
    const s = claims.stats();
    console.log(`Register now: ${s.total} claims · claimed ${money(s.claimed)} · recovered ${money(s.recovered)} · absorbed ${money(s.net)} · ${s.unverified} unverified · ${s.awaiting_recovery} awaiting recovery`);
}

main().catch((e) => { console.error('\nImport failed:', e.message); process.exit(1); });
