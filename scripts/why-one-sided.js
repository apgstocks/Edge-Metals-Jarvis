#!/usr/bin/env node
// ── scripts/why-one-sided.js — the sweep says one side; the sheet has two ──
//
// Apsara, 2026-09-29, pasting the nightly sweep's one-sided containers:
// "these are already there in shipment and order details in my live excel
// sheet". Then: "chck properly".
//
// ── WHY THAT CLAIM IS EXACTLY CHECKABLE ───────────────────────────────────
// The Shipment tab carries BOTH sides on ONE ROW:
//
//     SUPPLIER · supplier price · SUPPL INVOICE AMT      the bill
//     Customer · INVOICE PRICE  · Buyer selling Amount   the sale
//
// So a container on that sheet should produce a bill AND a sale in Jarvis.
// When the sweep reports "bought and not sold", the sale is missing from
// Jarvis while the sheet has it — and the question is why the nightly sync
// never offered to add it.
//
// This answers that per container, and it is READ ONLY.
//
// ── THE FOUR ANSWERS IT CAN GIVE ──────────────────────────────────────────
//   not on the sheet          — the sweep is right and the sheet agrees
//   the sheet has one side    — her sheet row is itself half-filled
//   REJECTED BY looksLikeShipment — the row exists, carries both sides, and
//                               the sync SKIPS it. This is the one worth
//                               finding: it is silent, and it is why a row
//                               can sit on the sheet for 274 days without
//                               ever being offered. Prints WHICH rule.
//   would be offered          — the sync should already be proposing it,
//                               so something downstream is dropping it
//
// Reads the workbook Jarvis is configured for (cfg.INVOICE_SHEET_ID) through
// the same fetch and the same parser the nightly job uses, so it cannot
// disagree with the job about what the sheet says.
//
//   node scripts/why-one-sided.js                     all one-sided containers
//   node scripts/why-one-sided.js GAOU6175429 CAIU7522652 ...
//
// MUST BE RUN WHERE THE LIVE DATA IS — the VM. Against a development
// checkout with an empty ledger every container reads as missing, which is
// the trap scripts/sheet-sync-run.js refuses for the same reason.

const path = require('path');
const ROOT = path.join(__dirname, '..');

const argValue = (name) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? null : process.argv[i + 1];
};

(async () => {
    const cfg = require(path.join(ROOT, 'config'));
    const sync = require(path.join(ROOT, 'helpers/metalsSheetSync'));
    const bills = require(path.join(ROOT, 'helpers/bills'));
    const sales = require(path.join(ROOT, 'helpers/sales'));

    const norm = (v) => String(v == null ? '' : v).trim().toUpperCase();

    const B = bills.listWithTotals();
    const S = sales.listWithTotals();

    // ── EITHER SIDE BEING EMPTY IS ENOUGH TO POISON THIS ──────────────────
    // First written as `B.length < 5 && S.length < 5`, which let a checkout
    // with ZERO bills and seven invoices straight through — and with no
    // bills at all, EVERY invoice is one-sided. The report would have been
    // a list of the whole sales ledger, presented as a finding.
    //
    // One empty side is the dangerous case, not both, so it is `||`.
    if (B.length < 5 || S.length < 5) {
        console.error(
`\n  REFUSING — this ledger is not the live books (${B.length} bills, ${S.length} invoices).

  One-sided means a container has a bill and no invoice, or the reverse.
  With one side of the ledger empty or nearly so, EVERYTHING reads as
  one-sided — a list of your whole ledger dressed up as a finding.

  Run it on the VM, where both sides are real.\n`);
        process.exit(2);
    }

    // ── WHICH CONTAINERS ──────────────────────────────────────────────────
    // Named on the command line, or worked out the same way the sweep does:
    // grouped by container, one side present and not the other.
    // ── 2025 IS NOT WANTED ────────────────────────────────────────────────
    // Apsara, 2026-09-29, on the five the sync should have been offering —
    // every one of them dated 2025: "if its 2025 i dont want it". Same rule
    // as the Bills ledger, where she asked for 2026 only.
    //
    // COUNTED, NOT SILENT. A filter that quietly drops rows is how a real
    // one goes missing; the summary says how many were set aside so the
    // number is visible even when the list is not.
    const YEAR_FROM = Number(argValue('--from') || 2026);
    const ALL_YEARS = process.argv.includes('--all-years');
    const yearOf = (row) => {
        const m = String(row && row.date || '').match(/(20\d\d)/);
        return m ? Number(m[1]) : null;
    };

    let wanted = process.argv.slice(2).filter((a) => !a.startsWith('--')).map(norm).filter(Boolean);
    if (!wanted.length) {
        const sides = new Map();
        const put = (side, c) => {
            if (!c) return;
            if (!sides.has(c)) sides.set(c, { bill: false, sale: false });
            sides.get(c)[side] = true;
        };
        for (const b of B) put('bill', norm(b.container_no));
        for (const s of S) put('sale', norm(s.container_no));
        wanted = [...sides.entries()].filter(([, v]) => v.bill !== v.sale).map(([c]) => c);
    }
    if (!wanted.length) { console.log('\n  Nothing one-sided. Every container has both halves.\n'); return; }

    console.log(`\n  ${wanted.length} one-sided container${wanted.length === 1 ? '' : 's'} — checking each against the sheet`);
    console.log(`  ${'─'.repeat(74)}`);

    const buffer = await sync.fetchWorkbook();
    const parsed = await require(path.join(ROOT, 'helpers/sheetImport')).readWorkbook(buffer);
    const sheetBills = parsed.bills || [];
    const sheetSales = parsed.sales || [];

    // Indexed by container alone. The sheet's own booking number is not used
    // as part of the key here on purpose — a booking that disagrees between
    // the two halves is one of the things being looked for, and keying on it
    // would hide exactly that.
    const idx = (rows) => {
        const m = new Map();
        for (const r of rows) {
            const c = norm(r.container_no);
            if (!c) continue;
            if (!m.has(c)) m.set(c, []);
            m.get(c).push(r);
        }
        return m;
    };
    const sB = idx(sheetBills), sS = idx(sheetSales);
    const jB = idx(B), jS = idx(S);

    // ── WHY looksLikeShipment SAID NO ─────────────────────────────────────
    // It returns a bare boolean, so a rejected row gives no reason. These
    // are its rules restated, in its order, so the report can name the one
    // that fired instead of saying "skipped".
    const whyRejected = (row) => {
        if (!row) return 'no row';
        const c = norm(row.container_no), b = norm(row.booking_no);
        const inv = String(row.invoice_no == null ? '' : row.invoice_no).trim();
        if (inv.length > 40) return `invoice_no is ${inv.length} characters — read as prose, not a number`;
        if (/,\s/.test(inv)) return 'invoice_no contains ", " — read as a legend or a note';
        if (c && !/^[A-Z]{4}\d{7}$/.test(c) && !b) return `container "${c}" is not 4 letters + 7 digits, and there is no booking number`;
        if (!c && !b) return 'no container and no booking — nothing to identify it by';
        if (!String(row.date || '').trim()) return 'no date';
        return null;
    };

    // ── WHAT KIND OF THING IS IN THE CONTAINER FIELD ──────────────────────
    // The live run turned up three different problems wearing one label:
    //   MSBU3351954   a real container, genuinely missing its other half
    //   EMHU260742    4 letters + SIX digits — a container is 4 + 7, so the
    //                 check digit was dropped when it was typed
    //   PO6, LOCAL    not a container at all; a PO number or a placeholder
    //                 sitting in the container field
    // "Type in the missing half" is the right advice for the first and the
    // wrong advice for the other two, so they are named apart.
    const PROPER = /^[A-Z]{4}\d{7}$/;
    const kindOf = (c) => PROPER.test(c) ? 'proper'
        : /^[A-Z]{4}\d+$/.test(c) ? 'malformed' : 'not-a-container';

    // A dropped check digit means Jarvis's number can never equal the
    // sheet's, so the other half looks absent when it is sitting right
    // there. Any sheet container starting with the same ten characters is
    // reported — not merged, reported. Correcting a container number on a
    // live ledger is hers to do.
    const allSheet = new Set([...sB.keys(), ...sS.keys()]);
    const nearMatches = (c) => [...allSheet].filter((x) => x !== c && x.startsWith(c) && x.length > c.length);

    const tally = { absent: 0, halfOnSheet: 0, rejected: 0, shouldOffer: 0,
                    skippedYear: 0, malformed: 0, notContainer: 0, nearFound: 0 };

    for (const c of wanted) {
        const haveBill = jB.has(c), haveSale = jS.has(c);
        const side = haveBill ? 'bill' : 'sale';
        const missing = haveBill ? 'sale' : 'bill';
        const rows = (missing === 'bill' ? sB.get(c) : sS.get(c)) || [];
        const other = (missing === 'bill' ? sS.get(c) : sB.get(c)) || [];

        // The year comes off whichever side Jarvis actually holds.
        const mine = (haveBill ? jB.get(c) : jS.get(c)) || [];
        const yr = mine.map(yearOf).find((y) => y) || null;
        if (!ALL_YEARS && yr !== null && yr < YEAR_FROM) { tally.skippedYear += 1; continue; }

        const kind = kindOf(c);
        if (kind === 'malformed') tally.malformed += 1;
        if (kind === 'not-a-container') tally.notContainer += 1;

        console.log(`\n  ${c}${yr ? `   (${yr})` : ''}`);
        console.log(`      Jarvis has the ${side}; the ${missing} is missing`);

        if (kind === 'malformed') {
            const near = nearMatches(c);
            console.log(`      -> NOT A VALID CONTAINER NUMBER: 4 letters + ${c.length - 4} digits, needs 7.`);
            console.log(`         The check digit was dropped when it was typed, so this can`);
            console.log(`         never equal the sheet's number even when both halves exist.`);
            if (near.length) {
                tally.nearFound += 1;
                console.log(`         THE SHEET HAS: ${near.join(', ')}`);
                console.log(`         Almost certainly the same container. Correcting it in Jarvis`);
                console.log(`         is yours to do — this will not touch a live container number.`);
            } else {
                console.log(`         Nothing on the sheet starts with these ${c.length} characters either.`);
            }
            continue;
        }
        if (kind === 'not-a-container') {
            console.log(`      -> NOT A CONTAINER NUMBER AT ALL. Something else is in that`);
            console.log(`         field — a PO number, or a placeholder. Until it is a real`);
            console.log(`         container this row can never join to anything.`);
            continue;
        }

        if (!rows.length && !other.length) {
            tally.absent += 1;
            console.log(`      -> NOT ON THE SHEET AT ALL. The sweep and the sheet agree;`);
            console.log(`         the missing half was never recorded anywhere.`);
            continue;
        }
        if (!rows.length) {
            tally.halfOnSheet += 1;
            console.log(`      -> the sheet row exists but carries only the ${side} side too.`);
            console.log(`         Nothing to import — the ${missing} has to be typed somewhere first.`);
            continue;
        }

        for (const r of rows) {
            const why = whyRejected(r);
            if (why) {
                tally.rejected += 1;
                console.log(`      -> THE SHEET HAS IT, AND THE SYNC SKIPS IT.`);
                console.log(`         looksLikeShipment says no: ${why}`);
                console.log(`         date="${r.date || ''}" booking="${r.booking_no || ''}" `
                    + `${missing === 'bill' ? `supplier="${r.supplier || ''}" price="${r.supplier_price || ''}"`
                                            : `customer="${r.customer || ''}" price="${r.invoice_price || ''}"`}`);
                console.log(`         This is why it has sat there without ever being offered.`);
            } else {
                tally.shouldOffer += 1;
                console.log(`      -> the sheet has it and the sync SHOULD be offering it.`);
                console.log(`         date="${r.date || ''}" booking="${r.booking_no || ''}"`);
                console.log(`         Something after looksLikeShipment is dropping it — run`);
                console.log(`         scripts/sheet-sync-run.js and look for this container.`);
            }
        }
    }

    console.log(`\n  ${'─'.repeat(74)}`);
    console.log(`  not on the sheet at all      ${tally.absent}`);
    console.log(`  sheet is half-filled too     ${tally.halfOnSheet}`);
    console.log(`  REJECTED by looksLikeShipment ${tally.rejected}   <- silent, and fixable`);
    console.log(`  should already be offered    ${tally.shouldOffer}`);
    console.log(`  ${'-'.repeat(74)}`);
    console.log(`  malformed container number   ${tally.malformed}`
        + (tally.nearFound ? `   (${tally.nearFound} match a longer one on the sheet)` : ''));
    console.log(`  not a container at all       ${tally.notContainer}`);
    if (!ALL_YEARS) {
        console.log(`  set aside as before ${YEAR_FROM}      ${tally.skippedYear}   `
            + `(her rule; --all-years to include)`);
    }
    console.log('');
    if (tally.rejected) {
        console.log(`  The rejected ones are the finding. looksLikeShipment returns a bare`);
        console.log(`  boolean, so the nightly job counts them as "not shipment rows" and`);
        console.log(`  says nothing more — which is how a real row stays invisible for`);
        console.log(`  months. Fixing the sheet cell it names is usually enough.\n`);
    }
})().catch((e) => { console.error('\n  ' + (e.stack || e.message) + '\n'); process.exit(1); });
