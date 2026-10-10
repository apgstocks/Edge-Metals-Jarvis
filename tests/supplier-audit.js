// ── tests/supplier-audit.js ───────────────────────────────────────────────
// Apsara, 2026-10-10: "How much have we paid for supplier A so far including
// advance. and check how much is pending. If i paid more than what was
// already there. It should able to detect that. and help me in finding out
// where it gone wrong exactly."
//
// Real bills and payments stores in a temp DATA_DIR, written through the same
// addBill / addBillPayment / addAdvance / applyAdvance the screens use. One
// supplier per scenario, so each kind of mistake is proved on its own:
//   · a clean account must raise NO alarm (a false "you overpaid" is the
//     fastest way to make her stop trusting it)
//   · an unused advance is credit, not overpayment
//   · each real mistake is found, named, and its dollars explain the gap

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-supaudit-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
for (const f of [cfg.BILLS_FILE, cfg.BILL_PAYMENTS_FILE, cfg.PAYMENTS_FILE]) fs.writeFileSync(f, '[]');

const bills = require(path.join(ROOT, 'helpers/bills'));
const bp = require(path.join(ROOT, 'helpers/billPayments'));
const sa = require(path.join(ROOT, 'helpers/supplierAudit'));
const finding = (a, code) => a.findings.filter((f) => f.code === code);

(async () => {
    // 51,000 lb x $0.43 = $21,930; trucking $1,200 → owed $20,730
    const bill = (supplier, container, extra = {}) => bills.addBill({ date: '09/01/2026', supplier, container_no: container,
        items: [{ description: 'Al combo', weight: '51000', price: '0.43' }], ...extra });

    section('A — clean account: paid in full after trucking, plus an unused advance');
    {
        const S = 'Clean Metals';
        const b = await bill(S, 'CLN0001', { trucking_amount: '1200' });
        await bp.addBillPayment({ date: '09/05/2026', supplier: S, amount: 20730, mode: 'Wire', bank: 'Chase', allocations: [{ bill_id: b.id, amount: 20730 }] });
        await bp.addAdvance({ date: '09/20/2026', supplier: S, amount: 5000, mode: 'Wire', bank: 'Chase' });
        const a = sa.audit(S);
        ck('owed is after trucking: 21,930 − 1,200 = 20,730', a.owed === 20730, String(a.owed));
        ck('advances included in money out: 20,730 + 5,000', a.total_out === 25730, String(a.total_out));
        ck('NOT overpaid — the 5,000 is credit', a.overpaid === 0 && a.credit === 5000, JSON.stringify({ o: a.overpaid, c: a.credit }));
        ck('no high-severity finding', !a.findings.some((f) => f.severity === 'high'), JSON.stringify(a.findings.map((f) => f.code)));
        const r = sa.report(a);
        ck('spoken says paid incl. advances and the credit', /paid \$25,730\.00, including \$5,000\.00 in advances/.test(r.spoken) && /credit/.test(r.spoken), r.spoken);
        ck('screen flags the Supplier Account screen differs (trucking)', /does not deduct trucking/.test(r.screen), r.screen);
    }

    section('B — pending: one container unpaid');
    {
        const S = 'Pending Metals';
        await bill(S, 'PND0001');
        const b2 = await bill(S, 'PND0002');
        await bp.addBillPayment({ date: '09/05/2026', supplier: S, amount: 21930, mode: 'Wire', bank: 'Chase', allocations: [{ bill_id: b2.id, amount: 21930 }] });
        const a = sa.audit(S);
        ck('pending is the unpaid container', a.pending === 21930 && a.overpaid === 0, String(a.pending));
        ck('open list names it', a.open.length === 1 && a.open[0].container_no === 'PND0001', JSON.stringify(a.open));
        ck('spoken says pending on 1 container', /\$21,930\.00 is still pending on 1 container/.test(sa.report(a).spoken), sa.report(a).spoken);
    }

    section('C — duplicate payment: same wire recorded twice');
    {
        const S = 'Dup Metals';
        const b = await bill(S, 'DUP0001');
        const b2 = await bill(S, 'DUP0002');
        await bp.addBillPayment({ date: '09/05/2026', supplier: S, amount: 21930, mode: 'Wire', bank: 'Chase', ref: 'FW123', allocations: [{ bill_id: b.id, amount: 21930 }] });
        await bp.addBillPayment({ date: '09/07/2026', supplier: S, amount: 21930, mode: 'Wire', bank: 'Chase', ref: 'FW123', allocations: [{ bill_id: b2.id, amount: 21930 }] });
        await bp.addBillPayment({ date: '09/08/2026', supplier: S, amount: 21930, mode: 'Wire', bank: 'Chase', ref: 'FW999', allocations: [{ bill_id: b2.id, amount: 21930 }] });
        const a = sa.audit(S);
        ck('overpaid by one wire', a.overpaid === 21930, String(a.overpaid));
        ck('duplicate found (same ref)', finding(a, 'duplicate_payment').some((f) => /same reference FW123/.test(f.title)), JSON.stringify(finding(a, 'duplicate_payment').map((f) => f.title)));
        ck('container paid twice named', finding(a, 'container_overpaid').some((f) => f.container_no === 'DUP0002'));
        ck('tipping point is the 09/08 wire', a.tipped && a.tipped.date === '09/08/2026', JSON.stringify(a.tipped));
        ck('findings explain the whole overpayment', a.explained === a.overpaid, `${a.explained} of ${a.overpaid}`);
        const r = sa.report(a);
        ck('spoken says overpaid and gives a reason', /\$21,930\.00 more than owed\. The biggest reason:/.test(r.spoken), r.spoken);
        ck('screen has WHERE IT WENT WRONG', /WHERE IT WENT WRONG/.test(r.screen) && /Went into overpayment on 09\/08\/2026/.test(r.screen), r.screen);
    }

    section('D — paid on a bill that has no amount');
    {
        const S = 'Blank Metals';
        const b = await bills.addBill({ date: '09/01/2026', supplier: S, container_no: 'BLK0001' });
        await bp.addBillPayment({ date: '09/05/2026', supplier: S, amount: 15000, mode: 'Wire', bank: 'Chase', allocations: [{ bill_id: b.id, amount: 15000 }] });
        const a = sa.audit(S);
        ck('looks overpaid by the 15,000', a.overpaid === 15000, String(a.overpaid));
        ck('cause: bill without amount, explains 15,000', finding(a, 'bill_without_amount').some((f) => f.explains === 15000 && f.container_no === 'BLK0001'));
        ck('top finding is that one', a.findings[0].code === 'bill_without_amount', a.findings[0].code);
    }

    section('E — advance counted twice: applied record AND advance column');
    {
        const S = 'Twice Metals';
        const b = await bill(S, 'TWC0001', { advance: '5000' });
        const adv = await bp.addAdvance({ date: '08/25/2026', supplier: S, amount: 5000, mode: 'Wire', bank: 'Chase' });
        await bp.applyAdvance(adv.id, [{ bill_id: b.id, amount: 5000 }]);
        await bp.addBillPayment({ date: '09/05/2026', supplier: S, amount: 16930, mode: 'Wire', bank: 'Chase', allocations: [{ bill_id: b.id, amount: 16930 }] });
        const a = sa.audit(S);
        ck('overpaid by exactly the duplicated 5,000', a.overpaid === 5000, String(a.overpaid));
        ck('advance_twice found for TWC0001', finding(a, 'advance_twice').some((f) => f.container_no === 'TWC0001' && f.explains === 5000));
        ck('not double-explained by container_overpaid', a.explained === 5000, String(a.explained));
    }

    section('F — paid the full amount when trucking was meant to be deducted');
    {
        const S = 'Gross Metals';
        const b = await bill(S, 'GRS0001', { trucking_amount: '1200' });
        await bp.addBillPayment({ date: '09/05/2026', supplier: S, amount: 21930, mode: 'Wire', bank: 'Chase', allocations: [{ bill_id: b.id, amount: 21930 }] });
        const a = sa.audit(S);
        ck('overpaid by the trucking', a.overpaid === 1200, String(a.overpaid));
        ck('says it was paid the full amount though trucking is deducted', finding(a, 'container_overpaid').some((f) => /paid the full \$21,930\.00, but \$1,200\.00 of trucking is deducted/.test(f.detail)));
    }

    section('G — asking like a person: names');
    {
        await bill('Gomez Recycling', 'GMZ0001');
        await bill('Oakland Metals', 'OAK0001');
        await bill('Oakland Scrap', 'OAK0002');
        let r = sa.resolveSupplier('gomez');
        ck('"gomez" finds Gomez Recycling', r.status === 'ok' && r.name === 'Gomez Recycling', JSON.stringify(r));
        r = sa.resolveSupplier('GOMEZ RECYCLING.');
        ck('case and punctuation ignored', r.status === 'ok' && r.name === 'Gomez Recycling');
        r = sa.resolveSupplier('oakland');
        ck('"oakland" is ambiguous — asks, does not guess', r.status === 'ambiguous' && r.candidates.length === 2, JSON.stringify(r));
        r = sa.resolveSupplier('oak met');
        ck('"oak met" → Oakland Metals', r.status === 'ok' && r.name === 'Oakland Metals', JSON.stringify(r));
        const ans = sa.answer('oakland');
        ck('ambiguous answer asks which', /Which supplier — Oakland Metals, Oakland Scrap\?/.test(ans.spoken), ans.spoken);
        ck('unknown supplier said plainly', /I don't have a supplier called Nobody/.test(sa.answer('Nobody').spoken));
        await bills.addBill({ date: '09/02/2026', supplier: 'Gomez', container_no: 'GMZ0002' });
        const g = sa.audit('Gomez Recycling');
        ck('"Gomez" flagged as possibly the same supplier', finding(g, 'name_variant').some((f) => f.variant === 'Gomez'));
    }

    section('H — read only');
    {
        const before = fs.readFileSync(cfg.BILLS_FILE, 'utf8') + fs.readFileSync(cfg.BILL_PAYMENTS_FILE, 'utf8');
        for (const s of ['Clean Metals', 'Dup Metals', 'Blank Metals', 'Twice Metals', 'Gross Metals']) sa.answer(s);
        const after = fs.readFileSync(cfg.BILLS_FILE, 'utf8') + fs.readFileSync(cfg.BILL_PAYMENTS_FILE, 'utf8');
        ck('bills and payments files untouched', before === after);
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILED:\n  ' + failures.join('\n  ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
