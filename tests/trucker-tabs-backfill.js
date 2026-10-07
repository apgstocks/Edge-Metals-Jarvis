// tests/trucker-tabs-backfill.js — sheet trucker tabs -> Jarvis bills (Apsara 2026-10-07).
// A: pure plan() on fixtures. B: END TO END — a real ledger in a temp DATA_DIR, the real
// apply path, read back through the real bills list. Pins the rules that protect money:
// never overwrite, never pick among several grades, never add twice.
const fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.join(__dirname, '..');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-tabs-')); process.env.JARVIS_TEST = '1';
let pass = 0, fail = 0;
const ck = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n); if (x) console.log('        ' + x); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const B = require(path.join(ROOT, 'helpers/truckerTabBackfill'));
const bills = require(path.join(ROOT, 'helpers/bills'));
const cfg = require(path.join(ROOT, 'config'));
const { mutateJson } = require(path.join(ROOT, 'helpers/json'));

const JIO = [['Date', 'Invoice No.', 'Container', 'Shipper', 'Line Haul', 'Port Fees', 'Chassis Rent', 'Others', 'Net Amount', 'Last Verified'],
    ['2026-03-01', 'J1', 'AAAA1111111', 'X', 850, 100, 75, '', 1025, 't'],      // -> one fresh bill: ADD
    ['2026-03-02', 'J2', 'BBBB2222222', 'X', 900, '', '', '', 900, 't'],        // bill already has 900: ALREADY
    ['2026-03-03', 'J3', 'CCCC3333333', 'X', 950, '', '', '', 950, 't'],        // bill has 800: DIFFERS
    ['2026-03-04', 'J4', 'DDDD4444444', 'X', 700, '', '', '', 700, 't'],        // two grades: SEVERAL
    ['2026-03-05', 'J5', 'EEEE5555555', 'X', 600, '', '', '', 600, 't'],        // no bill: NO_BILL
    ['2026-03-06', 'J1', 'AAAA1111111', 'X', 850, 100, 75, 20, 1045, 't']];     // re-run of J1, now with Others 20 (last wins)
const SHER = [['Date', 'Booking No.', 'Quantity', 'Chassis', 'Others', 'Amount'], ['2026-04-01', 'BK-SHER-1', 1, 60, '', 640]];
const AJ = [['Invoice Date', 'Invoice No.', 'Container No.', 'Booking No.', 'Shipper', 'Pickup Date', 'Rate', 'Line Haul', 'Others', 'Dry Run', 'Extra Scale', 'Total amount'],
    ['2026-05-01', '6405', 'FFFF6666666', 'BK-AJ-1', 'X', '', '', 800, '', 150, 40, 990]];

section('A. tab rows -> records');
{
    const j = B.dedupe('jio', B.recordsFromTab('jio', JIO));
    ck('Jio: a re-run of the same container is ONE record, last wins', j.length === 5 && j.find((r) => r.container_no === 'AAAA1111111').other_charges[0].amount === 20);
    const a = B.recordsFromTab('aj', AJ)[0];
    ck('AJ: line haul, dry run, extra scale mapped', a.amount === 800 && a.dry_run_charge === 150 && a.extra_scale_charge === 40 && a.container_no === 'FFFF6666666');
    const s = B.recordsFromTab('sher', SHER)[0];
    ck('Sher: booking, chassis, amount mapped', s.booking_no === 'BK-SHER-1' && s.chassis === 60 && s.amount === 640);
    ck('an unknown tab kind throws', (() => { try { B.recordsFromTab('zzz', []); return false; } catch (e) { return true; } })());
    ck('missing/empty tab is safe', B.recordsFromTab('jio', []).length === 0 && B.recordsFromTab('jio', undefined).length === 0);
    ck('header order does not matter (columns found by name)', B.recordsFromTab('sher', [['Amount', 'Booking No.'], [500, 'BKX']])[0].amount === 500);
}

section('B. against a real ledger, applied for real');
(async () => {
    const mk = (o) => ({ id: o.id, date: '2026-03-01', supplier: 'S', ...o });
    await mutateJson(cfg.BILLS_FILE, [], () => [
        mk({ id: 'B_A', container_no: 'AAAA1111111', description: 'Auto cast' }),
        mk({ id: 'B_B', container_no: 'BBBB2222222', trucking_split: { line_haul: 900 } }),
        mk({ id: 'B_C', container_no: 'CCCC3333333', trucking_split: { line_haul: 800 } }),
        mk({ id: 'B_D1', container_no: 'DDDD4444444', description: 'Copper' }), mk({ id: 'B_D2', container_no: 'DDDD4444444', description: 'Brass' }),
        mk({ id: 'B_S', booking_no: 'BK-SHER-1', container_no: 'GGGG7777777' }),
        mk({ id: 'B_F', container_no: 'FFFF6666666', booking_no: 'BK-AJ-1', trucking_company: 'My Own Trucker' }),
    ], { strict: true });
    const all = () => bills.listWithTotals();
    const before = JSON.stringify(all().filter((b) => ['B_B', 'B_C', 'B_D1', 'B_D2'].includes(b.id)).map((b) => [b.id, b.trucking_split]));
    const p = B.plan({ jio: JIO, sher: SHER, aj: AJ }, all());
    const ids = (arr) => arr.map((i) => i.candidates ? i.candidates.map((c) => c.bill_id).join('+') : i.container_no).sort().join();
    ck('to_add = the fresh Jio bill, the Sher bill and the AJ bill', ids(p.to_add) === 'B_A,B_F,B_S', ids(p.to_add));
    ck('already-there = same figures', ids(p.already_there) === 'B_B');
    ck('DISAGREEMENT is reported, never applied', ids(p.differs) === 'B_C' && p.differs[0].candidates[0].disagreements[0].delta === 150, JSON.stringify(p.differs[0] && p.differs[0].candidates[0].disagreements));
    ck('several grades -> SEVERAL, no candidate chosen', p.several.length === 1 && p.several[0].candidates.length === 2);
    ck('no bill -> reported', p.no_bill.length === 1 && p.no_bill[0].container_no === 'EEEE5555555');
    ck('Jio A uses the LAST row (Others 20): total 1045', p.to_add.find((i) => i.container_no === 'AAAA1111111').proposed_total === 1045);

    const { applyOne } = require(path.join(ROOT, 'scripts/trucker-tabs-to-bills'));
    for (const item of p.to_add) await applyOne(item, { quiet: true });
    const A = all().find((b) => b.id === 'B_A'), F = all().find((b) => b.id === 'B_F'), S = all().find((b) => b.id === 'B_S');
    ck('B_A trucking split written (850 / 100 / 75 / others 20)', A.trucking_split.line_haul === 850 && A.trucking_split.port_fees === 100 && A.trucking_split.chassis_rent === 75 && A.trucking_split.others_total === 20, JSON.stringify(A.trucking_split));
    ck('B_A got the hauler name (it had none)', /jio/i.test(A.trucking_company || ''), A.trucking_company);
    ck('B_F keeps the company she typed', F.trucking_company === 'My Own Trucker' && F.trucking_split.dry_run === 150 && F.trucking_split.extra_scale === 40);
    ck('B_S (Sher, joined on booking) written', S.trucking_split.line_haul === 640 && S.trucking_split.chassis_rent === 60);
    const after = JSON.stringify(all().filter((b) => ['B_B', 'B_C', 'B_D1', 'B_D2'].includes(b.id)).map((b) => [b.id, b.trucking_split]));
    ck('bills it must NOT touch are byte-identical (already / differs / several)', after === before);
    const p2 = B.plan({ jio: JIO, sher: SHER, aj: AJ }, all());
    ck('IDEMPOTENT: a second run has nothing left to add', p2.to_add.length === 0 && p2.already_there.length === 4, `${p2.to_add.length} / ${p2.already_there.length}`);
    ck('and the disagreement is still reported, still unresolved', p2.differs.length === 1);

    section('C. what --write would do to each SUPPLIER (report only)');
    {
        const mkBill = (id, supplier, balance, paid) => ({ id, supplier, balance, paid });
        const bs = [mkBill('b1', 'Mazariegos', 5000, 0), mkBill('b2', 'Mazariegos', 400, 600), mkBill('b3', 'Aguilar', 0, 2000), mkBill('b4', 'Aguilar', 3000, 0)];
        const item = (bill, total, ref) => ({ candidates: [{ bill_id: bill }], proposed_total: total, container_no: ref, invoice_no: 'I-' + ref });
        const imp = B.balanceImpact([item('b1', 1000, 'C1'), item('b2', 700, 'C2'), item('b3', 650, 'C3'), item('b4', 500, 'C4')], bs);
        const maz = imp.find((s) => s.supplier === 'Mazariegos'), agu = imp.find((s) => s.supplier === 'Aguilar');
        ck('totals per supplier: haulage and balance before -> after', maz.bills === 2 && maz.haulage === 1700 && maz.before === 5400 && maz.after === 3700, JSON.stringify(maz));
        ck('a bill the supplier was already paid on would go NEGATIVE — flagged with the figures', agu.negative.length === 1 && agu.negative[0].ref === 'C3' && agu.negative[0].after === -650, JSON.stringify(agu.negative));
        ck('...and so would a part-paid one whose balance is smaller than the haulage (400 - 700)', maz.negative.length === 1 && maz.negative[0].ref === 'C2' && maz.negative[0].after === -300);
        ck('a fully-paid bill is named', agu.fully_paid.join() === 'C3');
        ck('a bill that stays positive is not flagged', !maz.negative.some((n) => n.ref === 'C1') && !agu.negative.some((n) => n.ref === 'C4'));
        ck('sorted by the most haulage first', imp[0].supplier === 'Mazariegos');
        ck('an unknown bill id is skipped, not a crash', B.balanceImpact([item('nope', 5, 'X')], bs).length === 0);
        const src = fs.readFileSync(path.join(ROOT, 'scripts/trucker-tabs-to-bills.js'), 'utf8');
        ck('the report prints it BEFORE the --write gate, so it is seen without writing', src.indexOf('EFFECT ON WHAT EACH SUPPLIER IS OWED') > -1 && src.indexOf('EFFECT ON WHAT EACH SUPPLIER IS OWED') < src.indexOf("if (!WRITE) return console.log('Add --write"));
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
