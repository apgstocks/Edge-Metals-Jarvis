// ── tests/unjoined-containers.js ──────────────────────────────────────────
// From her nightly sweep, 2026-10-06:
//   HMMU7199337 — bill DALA19473200, sale DALA44727400
//   CAIU9824029 — bill DALA33397100, sale DALA37197400
//
// Both halves exist, the container matches, the booking does not, and the
// margin is computed NOWHERE — the cost is invisible and so is the revenue.
//
// ── THE RULE THAT MUST NOT BE "FIXED" ────────────────────────────────────
// margin.js keys on booking + container, and the comment above keyOf
// records why in her own words: "booking never makes it unique. sometimes
// diff container under same booking." A container number repeats between
// years, so joining on the container alone would eventually marry one
// year's cost to another year's revenue — a worse error than the one being
// diagnosed. Section D exists to keep anyone from loosening that key.
//
// So this DIAGNOSES. The evidence it offers is how many DAYS apart the two
// halves are, which is what tells a mistyped booking from two genuine
// shipments reusing a container number.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-unjoined-'));
const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts/unjoined-containers.js');

const bill = (id, container, booking, date, supplier, amount) => ({
    id, container_no: container, booking_no: booking, date, supplier,
    supplier_invoice_amount: amount,
});
const sale = (id, container, booking, date, customer, weight, price) => ({
    id, container_no: container, booking_no: booking, date, customer,
    item: 'Cu', weight, weight_unit: 'lb', invoice_price: price, price_unit: 'lb',
});

function run(bills, sales) {
    fs.writeFileSync(path.join(TMP, 'bills.json'), JSON.stringify(bills, null, 2));
    fs.writeFileSync(path.join(TMP, 'sales.json'), JSON.stringify(sales, null, 2));
    try {
        return { out: execFileSync(process.execPath, [SCRIPT], {
            env: { ...process.env, DATA_DIR: TMP, JARVIS_TEST: '1' }, encoding: 'utf8' }), code: 0 };
    } catch (e) {
        return { out: String(e.stdout || ''), code: e.status === undefined ? -1 : e.status };
    }
}

// ── A — HER TWO REAL CONTAINERS ───────────────────────────────────────────
{
    section('A — the two from her sweep');

    const r = run(
        [bill('B1', 'HMMU7199337', 'DALA19473200', '2026-03-02', 'Gomez', 40000)],
        [sale('SALE_1790000000000_a', 'HMMU7199337', 'DALA44727400', '2026-03-20', 'Rad Metal', 40000, 1.3)],
    );
    ck('a mismatched booking is found', /HMMU7199337/.test(r.out), r.out.slice(0, 400));
    ck('  both booking numbers are shown',
       /DALA19473200/.test(r.out) && /DALA44727400/.test(r.out), r.out.slice(0, 500));
    ck('  with the supplier and the customer',
       /Gomez to Rad Metal/.test(r.out), r.out.slice(0, 300));
    ck('  and the cost and revenue from each store\'s own arithmetic',
       /\$40,000\.00/.test(r.out) && /\$52,000\.00/.test(r.out),
       'sales.json holds no amount — reading one printed $0.00 against seven real invoices');
    ck('  it says the margin is computed nowhere',
       /computed NOWHERE/.test(r.out), r.out.slice(0, 500));
    ck('  and what that margin would be', /\$12,000\.00/.test(r.out), r.out.slice(0, 500));
    ck('  exiting non-zero', r.code === 1, String(r.code));
}

// ── B — DAYS APART IS THE EVIDENCE ────────────────────────────────────────
// A container number repeats between years. Close together is one shipment
// with a typo; far apart is two shipments that are correctly separate.
{
    section('B — a mistyped booking versus a reused container number');

    const near = run(
        [bill('B1', 'C1', 'BK-A', '2026-03-02', 'S', 40000)],
        [sale('SALE_1_a', 'C1', 'BK-B', '2026-03-20', 'C', 40000, 1.3)],
    );
    ck('18 days apart reads as ONE shipment with a typo',
       /18 days apart/.test(near.out) && /ONE shipment with one booking mistyped/.test(near.out),
       near.out.slice(0, 400));

    const far = run(
        [bill('B1', 'C1', 'BK-A', '2025-01-10', 'S', 30000)],
        [sale('SALE_1_a', 'C1', 'BK-B', '2026-06-15', 'C', 30000, 1.2)],
    );
    ck('521 days apart reads as TWO shipments, correctly separate',
       /521 days apart/.test(far.out) && /TWO shipments reusing the container number/.test(far.out),
       far.out.slice(0, 400));

    // Only the likely-one-shipment margin is totalled. Summing the other
    // kind would invent a figure for containers that are not related.
    ck('  and only the near ones are counted in the total',
       /Margin missing from the likely-one-shipment ones: \$0\.00/.test(far.out),
       far.out.slice(-400));
    ck('  while a near one does count',
       /Margin missing from the likely-one-shipment ones: \$12,000\.00/.test(near.out),
       near.out.slice(-400));

    const noDates = run(
        [bill('B1', 'C1', 'BK-A', '', 'S', 1000)],
        [sale('SALE_1_a', 'C1', 'BK-B', '', 'C', 1000, 2)],
    );
    ck('  with no dates it says it cannot tell',
       /cannot be told from here/.test(noDates.out), noDates.out.slice(0, 400));
}

// ── C — WHAT IT MUST NOT FLAG ─────────────────────────────────────────────
{
    section('C — the ones that are perfectly fine');

    const shared = run(
        [bill('B1', 'OK1', 'BK-1', '2026-03-01', 'S', 10000)],
        [sale('SALE_1_a', 'OK1', 'BK-1', '2026-03-15', 'C', 10000, 1.5)],
    );
    ck('a container whose halves share a booking is not flagged',
       !/OK1/.test(shared.out) && shared.code === 0, shared.out.slice(0, 300));
    ck('  and it says so plainly', /None\./.test(shared.out), shared.out.slice(0, 300));

    // A bill with no sale is "bought and not sold" — a different finding
    // that the sweep already reports. Not this one's business.
    const billOnly = run([bill('B1', 'C9', 'BK-A', '2026-03-01', 'S', 5000)], []);
    ck('a bill with no sale at all is not this finding',
       !/C9/.test(billOnly.out) && billOnly.code === 0, billOnly.out.slice(0, 300));

    // A missing booking means the row is incomplete, not mismatched, and
    // the incomplete-rows check already reports it.
    const noBooking = run(
        [bill('B1', 'C8', '', '2026-03-01', 'S', 5000)],
        [sale('SALE_1_a', 'C8', 'BK-B', '2026-03-10', 'C', 5000, 1.2)],
    );
    ck('a MISSING booking is not reported as a mismatch',
       !/C8/.test(noBooking.out), noBooking.out.slice(0, 300));

    // No container number at all is margin.js's own unjoinable().
    const noContainer = run(
        [bill('B1', '', 'BK-A', '2026-03-01', 'S', 5000)],
        [sale('SALE_1_a', '', 'BK-B', '2026-03-10', 'C', 5000, 1.2)],
    );
    ck('  and rows with no container are left to margin.unjoinable()',
       noContainer.code === 0, noContainer.out.slice(0, 300));
}

// ── D — IT MUST NOT JOIN THEM ─────────────────────────────────────────────
// The point of the whole file. Loosening margin.js's key to the container
// alone would eventually marry one year's cost to another year's revenue.
{
    section('D — diagnose, never join');

    const src = fs.readFileSync(SCRIPT, 'utf8');
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    ck('the script writes nothing',
       !/editBill|editSale|mutateJson|writeFile|addBill/.test(code),
       'correcting a booking number is hers, on the screen that does it');
    ck('  and it says why joining on the container alone is wrong',
       /repeats between years|one year's cost to another/.test(src),
       'the next person to read this will be tempted to just join them');

    // margin.js's key must still be booking + container.
    const m = fs.readFileSync(path.join(ROOT, 'helpers/margin.js'), 'utf8');
    ck('margin.js still keys on booking AND container',
       /const keyOf = \(bookingNo, containerNo\)/.test(m)
       && /\$\{String\(bookingNo \|\| ''\)/.test(m),
       'her own rule: a container number is not unique over time');
    ck('  and her reason is still recorded there',
       /booking never makes it unique/.test(m),
       'the words that make this rule stick are hers, not mine');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
