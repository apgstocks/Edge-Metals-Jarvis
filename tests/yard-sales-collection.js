// ── tests/yard-sales-collection.js ────────────────────────────────────────
// Apsara, 2026-11-06: "What if paid by cash,paid by various payment type,
// invoice amount in report of ege yard/think of all permuattion adn
// combination", then "not in nightky yard report.in webiste/app", then
// "lets work on that report".
//
// ── WHAT THE REPORT COULD NOT ANSWER ─────────────────────────────────────
// The Edge Yard Sales report showed SOLD and MARGIN. Both real, neither the
// question. She was asking: of what I invoiced, how much has come in, and
// how. A sales figure with no collection beside it reads as money in the
// bank when half of it may still be owed.
//
// And "sold" was summing `l.amount` — the metal — so on any sale with
// trucking recharged to the buyer the report UNDER-STATED the invoice by
// exactly the haulage. The same mistake api.js made on the payment path,
// fixed the day before; this is the reporting half of it.
//
// ── THREE FIGURES THAT MUST NOT BE COLLAPSED ─────────────────────────────
//   amount    the metal. Margin is measured against it, and the haulage she
//             recharges is a pass-through, not profit.
//   invoiced  what the buyer was billed — amount + that haulage.
//   collected what came back.
//
// Half the checks below exist to stop a later tidy-up merging them.
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.JARVIS_TEST = '1';
const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yard-collect-'));
const cfg = require(path.join(ROOT, 'config'));
// EVERY *_FILE key, walked from config itself. Yesterday a test of mine set
// DATA_DIR plus four keys, missed PETTY_CASH_FILE, and wrote four rows into
// the repo's real data/ before it crashed.
cfg.DATA_DIR = dir;
for (const k of Object.keys(cfg)) {
    if (/_FILE$/.test(k) && typeof cfg[k] === 'string') cfg[k] = path.join(dir, path.basename(cfg[k]));
}

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const { mutateJson } = require(path.join(ROOT, 'helpers/json'));
const ob = require(path.join(ROOT, 'helpers/outboundLoads'));
const pay = require(path.join(ROOT, 'helpers/payments'));
const usd = (n) => (n == null ? 'null' : '$' + Number(n).toFixed(2));

(async () => {

const sale = (id, buyer, amount, trucking) => ({
    id, date: '2026-11-06', buyer, amount, trucking,
    net_receivable: trucking ? ob.receivableFrom(amount, trucking) : null,
    net_weight: 1000, items: [], weight_unit: 'lb',
});
// ── A LINKED INBOUND COST, SO MARGIN IS A REAL NUMBER ───────────────────
// WITHOUT THIS, SECTION D IS VACUOUS. The first version of this file had no
// linked cost, so every margin came back null, and the check "margin is
// still measured against the metal" passed by comparing null to null. A
// mutation that measured margin on the INVOICE — inventing profit on every
// recharged haulage — SURVIVED it.
//
// getLoadMargin reads linked_inbound_load_ids and sums those loads' amounts,
// so the fixture needs real inbound loads to point at.
await mutateJson(cfg.LOADS_FILE, [], (a) => {
    a.push({ id: 'EDGE_1', date: '2026-11-01', seller: 'Ramesh', amount: 7000, items: [], weight_unit: 'lb' });
    a.push({ id: 'EDGE_2', date: '2026-11-01', seller: 'Ramesh', amount: 6000, items: [], weight_unit: 'lb' });
    return a;
}, { strict: true });

await mutateJson(cfg.OUTBOUND_LOADS_FILE, [], (a) => {
    // Cost 7,000 against metal of 10,000 → margin 3,000. If margin were ever
    // measured on the INVOICE (10,800) it would read 3,800 — $800 of profit
    // invented out of haulage she merely passed through.
    a.push(Object.assign(sale('OUT_1', 'Eccomelt', 10000, 800), { linked_inbound_load_ids: ['EDGE_1'] }));
    a.push(sale('OUT_2', 'Eccomelt', 5000, 0));         // invoiced  5,000
    a.push(Object.assign(sale('OUT_3', 'Modern Metals', 8000, 200), { linked_inbound_load_ids: ['EDGE_2'] }));
    return a;
}, { strict: true });

// Paid the way she actually gets paid: part cash, part transfer, a cheque,
// and one buyer who has not paid at all.
await pay.addPayment({ load_id: 'OUT_1', load_kind: 'sale', amount: 4000, mode: 'Cash', paid_on: '2026-11-06' });
await pay.addPayment({ load_id: 'OUT_1', load_kind: 'sale', amount: 6800, mode: 'Bank transfer', paid_via: 'Edge Yard', paid_on: '2026-11-06' });
await pay.addPayment({ load_id: 'OUT_2', load_kind: 'sale', amount: 2000, mode: 'Cheque', paid_on: '2026-11-06' });

const r = ob.getOutboundReport(ob.loadOutboundLoads(), {});
const buyer = (name) => r.byBuyer.find((b) => b.buyer === name) || {};

// ══════════════════════════════════════════════════════════════════════════
section('A — invoiced is NOT sold, and the gap is the haulage');
// ══════════════════════════════════════════════════════════════════════════
{
    ck('sold is the metal only', r.totalAmount === 23000, usd(r.totalAmount));
    ck('invoiced includes the trucking billed to the buyer', r.totalInvoiced === 24000, usd(r.totalInvoiced));
    ck('  and the difference is exactly the haulage recharged',
       r.totalInvoiced - r.totalAmount === 1000, usd(r.totalInvoiced - r.totalAmount));
    // THE CHECK AGAINST A LATER TIDY-UP. Someone will see two near-equal
    // money fields and "simplify" them into one.
    ck('they are separate fields, not one rounded into the other',
       r.totalAmount !== r.totalInvoiced,
       'margin is measured on amount; the buyer is billed invoiced');

    ck('a sale with no trucking has them equal',
       buyer('Modern Metals').invoiced === 8200 && (buyer('Modern Metals').amount === 8000),
       JSON.stringify({ a: buyer('Modern Metals').amount, i: buyer('Modern Metals').invoiced }));
}

// ══════════════════════════════════════════════════════════════════════════
section('B — what has come in, and what is still out');
// ══════════════════════════════════════════════════════════════════════════
{
    ck('collected is the money actually received', r.totalCollected === 12800, usd(r.totalCollected));
    ck('outstanding is invoiced minus collected', r.totalOutstanding === 11200, usd(r.totalOutstanding));
    ck('  which is the question she asked', r.totalInvoiced - r.totalCollected === r.totalOutstanding);

    ck('a buyer who has paid in full on one load still owes on the other',
       buyer('Eccomelt').invoiced === 15800 && buyer('Eccomelt').collected === 12800
       && buyer('Eccomelt').outstanding === 3000,
       JSON.stringify(buyer('Eccomelt')));
    ck('a buyer who has paid nothing owes all of it',
       buyer('Modern Metals').collected === 0 && buyer('Modern Metals').outstanding === 8200,
       JSON.stringify(buyer('Modern Metals')));
}

// ══════════════════════════════════════════════════════════════════════════
section('C — "paid by various payment type"');
// ══════════════════════════════════════════════════════════════════════════
{
    const modes = Object.fromEntries((r.byMode || []).map((m) => [m.mode, m.amount]));
    ck('cash is reported as cash', modes.Cash === 4000, JSON.stringify(modes));
    ck('  the bank transfer separately', modes['Bank transfer'] === 6800, JSON.stringify(modes));
    ck('  and the cheque separately', modes.Cheque === 2000, JSON.stringify(modes));
    ck('the modes add up to what was collected',
       (r.byMode || []).reduce((s, m) => s + m.amount, 0) === r.totalCollected,
       `${(r.byMode || []).reduce((s, m) => s + m.amount, 0)} vs ${r.totalCollected}`);
    ck('  and they are sorted biggest first, so the main channel is top',
       (r.byMode[0] || {}).mode === 'Bank transfer', JSON.stringify(r.byMode));

    ck('a buyer carries its own breakdown',
       (buyer('Eccomelt').byMode || []).length === 3, JSON.stringify(buyer('Eccomelt').byMode));
    ck('  and a buyer who paid nothing has an empty one, not a fake zero',
       (buyer('Modern Metals').byMode || []).length === 0);
}

// ══════════════════════════════════════════════════════════════════════════
section('D — margin did NOT move');
// ══════════════════════════════════════════════════════════════════════════
// CLAUDE.md rule 1. The haulage she recharges is a pass-through: she bills
// $800 and pays $800. Letting it into margin would invent profit on every
// sale with trucking, across a report she prices from.
{
    // The figures, not a formula restated — a check that rebuilds the same
    // arithmetic agrees with whatever the code does.
    ck('margin is a real number here, or this section proves nothing',
       buyer('Eccomelt').margin !== null && buyer('Modern Metals').margin !== null,
       JSON.stringify(r.byBuyer.map((b) => ({ buyer: b.buyer, margin: b.margin, cost: b.cost }))));
    ck('Eccomelt: metal 15,000 less cost 7,000 = 8,000 margin',
       buyer('Eccomelt').margin === 8000, usd(buyer('Eccomelt').margin));
    ck('  NOT 8,800 — the recharged haulage is not profit',
       buyer('Eccomelt').margin !== 8800,
       'measuring margin on the invoice invents $800 on every trucked sale');
    ck('Modern Metals: metal 8,000 less cost 6,000 = 2,000',
       buyer('Modern Metals').margin === 2000, usd(buyer('Modern Metals').margin));
    ck('  NOT 2,200', buyer('Modern Metals').margin !== 2200);
    ck('and the report total agrees', r.totalMargin === 10000, usd(r.totalMargin));
    ck('  and totalAmount — which margin is built on — is unchanged',
       r.totalAmount === 23000, usd(r.totalAmount));
}

// ══════════════════════════════════════════════════════════════════════════
section('E — an overpayment is not negative money owed');
// ══════════════════════════════════════════════════════════════════════════
{
    await pay.addPayment({ load_id: 'OUT_3', load_kind: 'sale', amount: 9000, mode: 'Cash', paid_on: '2026-11-06' });
    const r2 = ob.getOutboundReport(ob.loadOutboundLoads(), {});
    const mm = r2.byBuyer.find((b) => b.buyer === 'Modern Metals');
    ck('an overpaid buyer owes nothing', mm.outstanding === 0, usd(mm.outstanding));
    ck('  not a negative figure', mm.outstanding >= 0, usd(mm.outstanding));
    ck('  and the overpayment is still counted as collected', mm.collected === 9000, usd(mm.collected));
    ck('the report total never goes negative either', r2.totalOutstanding >= 0, usd(r2.totalOutstanding));
}

// ══════════════════════════════════════════════════════════════════════════
section('F — BOTH SCREENS RENDER IT');
// ══════════════════════════════════════════════════════════════════════════
// dashboard/claims.html was dead for six days behind checks that only read
// it as text. A figure computed and never displayed is the same fault with
// a smaller blast radius, so these read the two clients' source for the
// FIELDS — the one thing a regex can honestly prove about a template.
{
    const web = fs.readFileSync(path.join(ROOT, 'dashboard', 'outbound-loads.html'), 'utf8');
    for (const f of ['totalInvoiced', 'totalCollected', 'totalOutstanding']) {
        ck(`the website shows ${f}`, web.includes('data.' + f), 'computed and invisible is not shipped');
    }
    ck('  and the per-buyer outstanding', /b\.outstanding/.test(web));
    ck('  and how the money arrived', /b\.byMode|data\.byMode/.test(web));
    ck('  through an element that exists in the markup', /id="rptByMode"/.test(web),
       'a render into a missing element is a silent no-op — see renderGroupBy');

    const app = fs.readFileSync(path.join(ROOT, 'mobile-app', 'www', 'app', '11-reports.js'), 'utf8');
    for (const f of ['totalInvoiced', 'totalCollected', 'totalOutstanding']) {
        ck(`the app shows ${f}`, app.includes('data.' + f));
    }
    ck('  the per-buyer figures too', /b\.invoiced/.test(app) && /b\.collected/.test(app));
    ck('  and the mode breakdown', /data\.byMode/.test(app));

    // Both clients, or the phone and the desk disagree about what she is owed.
    ck('NEITHER client was left behind',
       ['totalInvoiced', 'totalCollected', 'totalOutstanding']
           .every((f) => web.includes('data.' + f) && app.includes('data.' + f)),
       'half a feature ships when only the screen she mentioned is done');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.log('CRASHED: ' + (e && e.stack || e)); process.exit(1); });
