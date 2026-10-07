#!/usr/bin/env node
// ── scripts/trucking-double-count.js ──────────────────────────────────────
// Apsara, 2026-10-07: "what about the trucking bill?"
//
// ── THE FINDING, IN ONE PARAGRAPH ────────────────────────────────────────
// One real haulage can be recorded TWICE, on two different companies' books,
// and both sets balance perfectly.
//
//   · helpers/bills.js carries `trucking_amount` on an Edge Metals bill. The
//     books post the bill GROSS: material 5000 at the full figure, with the
//     haulage split out as 2050 "Accrued trucking and freight" — money owed
//     to the trucker.
//   · helpers/truckerBills.js is a separate store of hauler invoices.
//     helpers/entities.js maps `trucker_bills` to EDGE TRADING (Edge Yard),
//     flatly, by store. So the books ALSO post 5200 haulage expense and
//     another 2050 credit — on the other company.
//   · POST /api/bills/:id/accept-trucking writes the hauler's figure onto the
//     BILL and never touches the trucker_bills row, so after joining a
//     verified hauler invoice to a container, BOTH records exist.
//
// Measured on a fixture: one $3,000 haulage, Edge Metals owes AJ $3,000 and
// Edge Yard owes AJ $3,000. Group total $6,000 for $3,000 of work. Every
// trial balance balances, and helpers/booksAgent.js reports both companies
// "books balance, nothing unplaced" — it compares 1400/2400 and knows nothing
// about this.
//
// ── THIS SCRIPT ONLY LOOKS ───────────────────────────────────────────────
// Whether it is real in her data depends on how much her trucker_bills
// overlap her bills' trucking amounts, and nobody can know that from here.
// So this counts and prints, and changes nothing. The FIX is a decision, not
// a bug fix, and it is hers — see the two questions it ends on.
//
//   node scripts/trucking-double-count.js
//   node scripts/trucking-double-count.js --all     every pair, not a sample
//
// Reads only. Writes nothing. Safe on the live VM.

const path = require('path');

const ALL = process.argv.includes('--all');
const ROOT = path.join(__dirname, '..');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
const money = (n) => `$${r2(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const key = (s) => String(s || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

// ── THE CARRIERS THAT REACH NO STATEMENT AT ALL ──────────────────────────
// Apsara, 2026-10-07: "zimex ,eagle brit,pan metal ,tql,schneider,aj
// transport,sher,jio bills are not there..."
//
// She is right, and for TWO different reasons that need separating.
//
// SIX OF THEM ARE NOT MEANT TO BE BILLS OF THEIR OWN. A verified carrier
// invoice flows INTO a record that already exists:
//     Sher, Jio, AJ Transport, Gardunos → truckingProposal.js → the
//         container bill's trucking amount (so it lands in material at GROSS
//         plus 2050 accrued trucking)
//     Zimex                             → freightProposal.js → the SALE's
//         freight charge
//     EagleBrit                         → eagleInvoice.js
// So they show up as part of a container's cost, never as a line saying
// "Zimex". That is the design. What it does NOT survive is a verified
// invoice she never ACCEPTED onto a bill or a sale: that one is in no book.
//
// TQL, NTG AND SCHNEIDER ARE DIFFERENT, AND GENUINELY MISSING. They have
// their own store, carrier_invoices.json. helpers/booksBuild.js reads eight
// stores and that is not one of them, and helpers/entities.js has no mapping
// for it — so even if the books did read it, every row would come back
// unplaced. Their freight is absent from every statement and from the pack
// that goes to her CPA.
function carriersNotInTheBooks() {
    console.log('── CARRIERS THE BOOKS NEVER READ ──────────────────────────────────\n');
    let rows = [];
    try { rows = require(path.join(ROOT, 'helpers/carrierInvoices')).list(); }
    catch (e) { console.log(`  could not read carrier invoices: ${e.message}\n`); return; }

    const total = r2(rows.reduce((t, x) => t + num(x.amount || x.total), 0));
    const byCarrier = new Map();
    for (const x of rows) {
        const c = String((x && x.carrier) || '?');
        const cur = byCarrier.get(c) || { n: 0, money: 0 };
        cur.n += 1;
        cur.money = r2(cur.money + num(x.amount || x.total));
        byCarrier.set(c, cur);
    }
    console.log(`  carrier_invoices.json: ${rows.length} invoice(s), ${money(total)}`);
    for (const [c, v] of [...byCarrier.entries()].sort((a, b) => b[1].money - a[1].money)) {
        console.log(`      ${c.padEnd(12)} ${String(v.n).padStart(4)}  ${money(v.money).padStart(14)}`);
    }
    console.log('\n  NONE of this is on any statement. booksBuild reads bills, sales,');
    console.log('  bill_payments, sales_receipts, loads, outbound_loads, trucker_bills');
    console.log('  and expenses — not this store — and entities.js has no mapping for');
    console.log('  it, so adding it without a mapping would make every row unplaced.\n');
    if (total > 0) {
        console.log(`  So the books understate freight by at least ${money(total)}, and the`);
        console.log('  CPA pack is missing it. Edge Metals\' profit is overstated by');
        console.log('  whatever share of it is Edge Metals\'.\n');
    }
}

function main() {
    const bills = require(path.join(ROOT, 'helpers/bills')).listWithTotals();
    let truckerBills = [];
    try {
        truckerBills = require(path.join(ROOT, 'helpers/truckerBills')).listBills();
    } catch (e) {
        console.log(`\n  could not read the trucker bills store: ${e.message}\n`);
        return;
    }

    // Bills that carry a haulage figure of their own. `trucking_amount_used`
    // is what the books actually post (see helpers/booksBuild.js), so it is
    // read first — reading the raw field instead would report a figure the
    // statements do not use.
    const withTrucking = bills.filter((b) => b && num(b.trucking_amount_used != null
        ? b.trucking_amount_used : b.trucking_amount) > 0.005);
    const billTotal = r2(withTrucking.reduce((t, b) => t
        + num(b.trucking_amount_used != null ? b.trucking_amount_used : b.trucking_amount), 0));
    const truckerTotal = r2(truckerBills.reduce((t, x) => t + num(x.amount), 0));

    console.log('\n── TRUCKING, COUNTED TWICE? ───────────────────────────────────────\n');
    console.log(`  Edge Metals bills carrying a haulage figure : ${withTrucking.length} `
        + `(${money(billTotal)})`);
    console.log(`  Rows in the trucker bills store             : ${truckerBills.length} `
        + `(${money(truckerTotal)})`);
    console.log('\n  The first is on EDGE METALS\' books. The second is on EDGE YARD\'s,');
    console.log('  because helpers/entities.js maps the trucker_bills store flatly to');
    console.log('  Edge Trading. Where the SAME haulage is in both, the trucker looks');
    console.log('  owed twice across the group and each company still balances.\n');

    // ── THE OVERLAP ──────────────────────────────────────────────────────
    // Matched three ways, strongest first, because a pair found by container
    // is a fact and a pair found by name-and-amount is a suspicion. They are
    // reported separately rather than added together: presenting a guess and
    // a certainty as one number is how an audit figure stops being trusted.
    const byId = new Map();
    const byContainer = new Map();
    for (const b of withTrucking) {
        byId.set(String(b.id), b);
        const c = key(b.container_no);
        if (c) byContainer.set(c, b);
    }

    const certain = [];     // the trucker bill names the bill or its container
    const suspected = [];   // same hauler, same amount, within a week
    for (const t of truckerBills) {
        if (!t) continue;
        const amount = num(t.amount);
        const linked = t.bill_id && byId.get(String(t.bill_id));
        const sameContainer = !linked && key(t.container_no) && byContainer.get(key(t.container_no));
        const hit = linked || sameContainer;
        if (hit) {
            const theirs = num(hit.trucking_amount_used != null
                ? hit.trucking_amount_used : hit.trucking_amount);
            certain.push({ t, bill: hit, amount, theirs,
                how: linked ? `names bill ${t.bill_id}` : `same container ${t.container_no}` });
            continue;
        }
        const who = key(t.trucker || t.carrier);
        if (!who) continue;
        const near = withTrucking.find((b) => key(b.trucking_company) === who
            && Math.abs(num(b.trucking_amount_used != null ? b.trucking_amount_used : b.trucking_amount) - amount) < 0.005
            && Math.abs((new Date(b.date) - new Date(t.date)) / 86400000) <= 7);
        if (near) suspected.push({ t, bill: near, amount, how: 'same hauler, same amount, within a week' });
    }

    const show = (list, title, note) => {
        const sum = r2(list.reduce((s, x) => s + x.amount, 0));
        console.log(`  ${title}: ${list.length} (${money(sum)})`);
        console.log(`    ${note}`);
        if (!list.length) { console.log(''); return sum; }
        for (const x of (ALL ? list : list.slice(0, 12))) {
            console.log(`      ${String(x.t.id).padEnd(14)} ${money(x.amount).padStart(12)}  `
                + `${String(x.t.trucker || x.t.carrier || '?').padEnd(18)} ${x.how}`);
        }
        if (!ALL && list.length > 12) console.log(`      … and ${list.length - 12} more (--all)`);
        console.log('');
        return sum;
    };

    const a = show(certain, 'SAME HAULAGE, PROVEN',
        'the trucker bill names the bill or its container, and that bill carries its own haulage figure');
    const b = show(suspected, 'SAME HAULAGE, LIKELY',
        'no link recorded — matched on hauler, amount and date, so check these by hand');

    console.log('── WHAT IT COMES TO ───────────────────────────────────────────────\n');
    console.log(`  Overstated across the group, proven : ${money(a)}`);
    console.log(`  Possibly overstated on top of that  : ${money(b)}`);
    console.log(`  Worst case                          : ${money(a + b)}\n`);
    const duplicated = !!(a || b);
    if (!duplicated) {
        console.log('  Nothing overlaps, so the two stores are not describing the same');
        console.log('  haulage today. The structure still allows it — the books post both');
        console.log('  paths — so this is worth re-running after any bulk import.\n');
        if (!truckerBills.length) {
            console.log('  The trucker bills store is EMPTY, which is why: there is nothing');
            console.log('  on the second path to collide with the 118-odd bills carrying');
            console.log('  their own haulage. The misfiling risk below is dormant, not');
            console.log('  absent — the first row written to that store books to Edge Yard.\n');
        }
    }

    // ── ALWAYS, NOT ONLY WHEN THERE IS A DUPLICATE ────────────────────────
    // This used to sit after an early `return` in the no-overlap branch. On
    // her real data the overlap is zero — so the run she actually did skipped
    // the carriers section entirely, which is the one thing she had asked
    // about ("zimex ,eagle brit,pan metal ,tql,schneider,aj transport,sher,
    // jio bills are not there..."). An early return that skips the answer to
    // the question is worse than no script: it reads as "nothing to report".
    carriersNotInTheBooks();

    console.log('── HER DECISIONS, WHICH THIS SCRIPT WILL NOT MAKE ─────────────────\n');
    if (!duplicated) {
        console.log('  (1 and 2 are dormant today — nothing is duplicated. They stay');
        console.log('   written down because the structure still allows it.)\n');
    }
    console.log('  1. WHOSE COST IS A HAULIER INVOICE? Today the store decides, flatly:');
    console.log('     every trucker bill is Edge Yard\'s. But a hauler invoice for an Edge');
    console.log('     Metals container is Edge Metals\' cost, and booking it to Edge Yard');
    console.log('     is the cross-company misallocation rule 5 exists to prevent.');
    console.log('     The alternative is to follow the CONTAINER, not the store.\n');
    console.log('  2. WHICH RECORD IS THE TRUTH? The bill\'s trucking figure, or the');
    console.log('     hauler\'s own invoice? One of them must stop posting, or the same');
    console.log('     haulage keeps being counted twice. Note that');
    console.log('     POST /api/bills/:id/accept-trucking deliberately leaves BOTH in');
    console.log('     place — it copies the figure onto the bill and does not mark the');
    console.log('     trucker bill as consumed.\n');
    console.log('  3. WHERE DO TQL, NTG AND SCHNEIDER BELONG? Their store is read by');
    console.log('     nothing in the books. Which company owns each invoice, and which');
    console.log('     account — 5100 Freight and shipping (a cost of the material sold)');
    console.log('     or 6110 Freight (operating)? The chart deliberately carries both');
    console.log('     and the choice moves GROSS PROFIT, so it is not mine to pick.');
    console.log('');
    console.log('  Until one of those is answered, the Edge Yard P&L overstates haulage');
    console.log('  and the group overstates what it owes its hauliers. Edge Metals\'');
    console.log('  own profit is unaffected: its haulage is inside material at gross.\n');
}

main();
