// ── tests/trucker-bills.js ────────────────────────────────────────────────
// Apsara, 2026-09-03: "now include a tab called trucker for everyone ... it
// contains date, company name, load ticket number (optional), amount. edit,
// delete, pay option should be there. when i click pay - option should be as
// zelle/wire. once paid, hide delete option for staff and admin. Need to
// incorporate this in report as well."
//
// THE BUG THIS FILE ALREADY CAUGHT
// --------------------------------
// Trucker payments reuse payments.json with load_kind: 'trucker'. But
// addPayment read that field as `input.load_kind === 'sale' ? 'sale' :
// 'purchase'` — everything not a sale was coerced to a purchase. So every
// trucker payment would have been STORED as a load payment, and the spend
// report, which splits on exactly that field, would have shown it as
// "Load TRK_001" inside what the yard paid for metal.
//
// The grand total would still have been correct. That is what makes this class
// of bug last: no figure looks wrong until someone asks what a month's haulage
// cost, and by then there are hundreds of rows filed under the wrong heading.
// Section D exists to keep that fixed.
//
// AND THE RULE WRITTEN AT THE RIGHT TIME
// --------------------------------------
// "Once paid, hide delete" is enforced on the ROUTE here, not only by hiding a
// button. The load equivalent of this rule spent two weeks as HTML only, and
// staff could reach the endpoint the whole time. Section E is that rule.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-trucker-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD    = 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD  = 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD  = 'staff-pw-ccccccccccc';
process.env.JARVIS_PASSWORD = 'jarvis-pw-ddddddddddd';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.TRUCKER_BILLS_FILE).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated'); process.exit(1);
}

const bills = require(path.join(ROOT, 'helpers/truckerBills'));
const payments = require(path.join(ROOT, 'helpers/payments'));
const petty = require(path.join(ROOT, 'helpers/pettyCash'));
const audit = require(path.join(ROOT, 'helpers/audit'));
const { buildSpendReport } = require(path.join(ROOT, 'helpers/spendReport'));
const { createApi } = require(path.join(ROOT, 'api'));

let server, base;
function req(method, urlPath, { sid, body } = {}) {
    return new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r = http.request(base + urlPath, { method, headers }, (res) => {
            let raw = '';
            res.on('data', (c) => { raw += c; });
            res.on('end', () => {
                let json = null; try { json = JSON.parse(raw); } catch (e) {}
                resolve({ status: res.statusCode, json, raw });
            });
        });
        r.on('error', reject);
        if (data) r.write(data);
        r.end();
    });
}
const login = (password) => req('POST', '/login', { body: { password } });
const reset = () => {
    for (const f of [cfg.TRUCKER_BILLS_FILE, cfg.PAYMENTS_FILE, cfg.PETTY_CASH_FILE, cfg.AUDIT_LOG_FILE]) {
        try { fs.writeFileSync(f, '[]'); } catch (e) {}
    }
};
const bill = (o) => Object.assign({ date: '2026-09-01', company: 'Ace Haulage', amount: 500 }, o);

(async () => {

const app = createApi();
await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
base = `http://127.0.0.1:${server.address().port}`;
const adminSid  = (await login('admin-pw-bbbbbbbbbbb')).json.sid;
const staffSid  = (await login('staff-pw-ccccccccccc')).json.sid;
const jarvisSid = (await login('jarvis-pw-ddddddddddd')).json.sid;

console.log('\n─ trucker bills ─────────────────────────────────────────────');

// ── A. the four fields she named ──────────────────────────────────────────
section('A — date, company, load ticket (optional), amount');
{
    reset();
    const b = await bills.addBill(bill({ load_ticket: 'EDGE_12' }));
    ck('a bill is stored', !!b && b.id === 'TRK_001');
    ck('  with the date', b.date === '2026-09-01');
    ck('  the company', b.company === 'Ace Haulage');
    ck('  the ticket', b.load_ticket === 'EDGE_12');
    ck('  and the amount', b.amount === 500);

    // OPTIONAL means optional. Stored as null rather than '' so "not given"
    // and "given as blank" are the same thing downstream.
    const noTicket = await bills.addBill(bill({ company: 'Vega Transport' }));
    ck('the load ticket may be omitted', noTicket.load_ticket === null);

    // NOT validated against loads.json, deliberately. A hauler's invoice may
    // name a ticket that was voided or renumbered; refusing the bill would
    // mean the yard cannot record a debt it actually owes because of a
    // bookkeeping mismatch.
    const unknown = await bills.addBill(bill({ load_ticket: 'EDGE_9999' }));
    ck('  and a ticket that matches no load is still accepted', unknown.load_ticket === 'EDGE_9999',
       'a real debt must be recordable even when the paperwork does not line up');

    ck('ids are sequential', unknown.id === 'TRK_003');

    // The three that make a bill mean anything.
    const rejects = async (o, why) => {
        try { await bills.addBill(o); return false; } catch (e) { return /Validation/.test(e.message); }
    };
    ck('a bill with no amount is refused', await rejects({ date: '2026-09-01', company: 'X' }));
    ck('  no company', await rejects({ date: '2026-09-01', amount: 10 }));
    ck('  no date', await rejects({ company: 'X', amount: 10 }));
    ck('  a bad date', await rejects({ date: '01/09/2026', company: 'X', amount: 10 }));
    ck('  a zero amount', await rejects({ date: '2026-09-01', company: 'X', amount: 0 }),
       'a bill for nothing is a row that cannot be settled and never leaves the list');
    ck('  a negative amount', await rejects({ date: '2026-09-01', company: 'X', amount: -5 }));
}

// ── B. edit and delete ────────────────────────────────────────────────────
section('B — edit and delete');
{
    reset();
    const b = await bills.addBill(bill({ amount: 500 }));
    const e = await bills.editBill(b.id, bill({ company: 'Ace Haulage Ltd', amount: 650, load_ticket: 'EDGE_13' }));
    ck('an edit takes', e.amount === 650 && e.company === 'Ace Haulage Ltd');
    ck('  and is stamped', !!e.updated_at);
    ck('  the id does not change', e.id === b.id);
    ck('editing something that is not there returns null', (await bills.editBill('TRK_999', bill())) === null);

    const removed = await bills.deleteBill(b.id);
    ck('a delete returns the record, so the caller can log what it was', removed && removed.id === b.id,
       'a boolean cannot tell an audit row the company or the amount');
    ck('  and it is gone', bills.listBills().length === 0);
    ck('deleting twice is not an error', (await bills.deleteBill(b.id)) === null);
}

// ── C. paying one ─────────────────────────────────────────────────────────
section('C — Zelle or Wire, and nothing else');
{
    reset();
    ck('the offered modes are exactly the two she named',
       bills.TRUCKER_PAYMENT_MODES.join('/') === 'Zelle/Wire');
    ck('  Cash is not among them', !bills.TRUCKER_PAYMENT_MODES.includes('Cash'));
    ck('  nor Cheque', !bills.TRUCKER_PAYMENT_MODES.includes('Cheque'));

    const b = await bills.addBill(bill({ amount: 1000 }));

    // ── FUND THE CASH BOX FIRST ───────────────────────────────────────────
    // This ordering matters and it was wrong to begin with. With an empty box,
    // a Cash payment fails on PETTY_CASH_SHORT and also returns 400 — so the
    // assertion below passed with the mode guard REMOVED, which mutation
    // testing caught. Funding the box means the only thing that can refuse
    // this payment is the rule being tested.
    await petty.addTopUp({ amount: 5000 });
    const before = petty.balance();

    // Refused on the WRITE PATH, not just missing from a dropdown.
    const cash = await req('POST', '/api/payments', { sid: adminSid,
        body: { load_id: b.id, load_kind: 'trucker', mode: 'Cash', amount: 100, paid_on: '2026-09-01' } });
    ck('paying a trucker bill in Cash is refused by the server', cash.status === 400,
       'the dropdown is not a rule — two money rules in this app turned out to be enforced nowhere else');
    ck('  with a code, not a petty-cash error', cash.json && cash.json.code === 'TRUCKER_MODE_NOT_ALLOWED',
       'PETTY_CASH_SHORT here would mean the box was empty and the guard was never reached');
    ck('  nothing was recorded', payments.paymentsForLoad(b.id).length === 0);
    ck('  and the box is untouched even by the attempt', petty.balance() === before,
       'refused before the reserve-then-write dance begins, so there is nothing to unwind');

    const ok = await req('POST', '/api/payments', { sid: adminSid,
        body: { load_id: b.id, load_kind: 'trucker', mode: 'Zelle', amount: 400, paid_on: '2026-09-02' } });
    ck('a Zelle payment is accepted', ok.status === 200, ok.raw);
    ck('  the cash box is untouched', petty.balance() === before,
       'no Cash mode means this ledger can never draw on the drawer');

    // Partial, then settled — the reason payments are a ledger and not a flag.
    const partial = bills.listBillsWithPayments().find((x) => x.id === b.id);
    ck('a part payment leaves it partial', partial.payment.status === 'partial');
    ck('  with the right balance', partial.payment.paid === 400 && partial.payment.pending === 600);

    await req('POST', '/api/payments', { sid: adminSid,
        body: { load_id: b.id, load_kind: 'trucker', mode: 'Wire', amount: 600, paid_on: '2026-09-03' } });
    const settled = bills.listBillsWithPayments().find((x) => x.id === b.id);
    ck('two payments settle it', settled.payment.status === 'paid' && settled.payment.paid === 1000,
       'a bill settled across two transfers is the whole reason this is a ledger');
}

// ── D. THE BUG. what kind of spend is this ────────────────────────────────
section('D — trucker spend is its own line, not load spend');
{
    reset();
    const b = await bills.addBill(bill({ company: 'Ace', amount: 800 }));
    await req('POST', '/api/payments', { sid: adminSid,
        body: { load_id: b.id, load_kind: 'trucker', mode: 'Wire', amount: 800, paid_on: '2026-09-05' } });

    // The stored field, first. This is where the coercion was.
    const row = payments.paymentsForLoad(b.id)[0];
    ck('the payment is STORED as a trucker payment', row.load_kind === 'trucker',
       'coerced to "purchase", it becomes load spend everywhere downstream and no total looks wrong');

    const r = buildSpendReport({
        payments: payments.listPayments(),
        expenses: [{ id: 'X1', description: 'fuel', payment_method: 'Cash', amount: 50, date: '2026-09-05' }],
        pettyEntries: [],
    });
    ck('it appears in the report', r.total === 850);
    ck('  under its own total', r.truckerTotal === 800);
    ck('  NOT under loads', r.loadTotal === 0,
       'this is the failure the coercion caused: right grand total, haulage hidden inside the metal');
    ck('  and not under expenses', r.expenseTotal === 50);
    ck('the three add up to the total', r.loadTotal + r.truckerTotal + r.expenseTotal === r.total,
       'a split that does not reconcile invites the reader to pick which number to believe');

    // Labelled for the drill-down.
    const line = r.rows.find((x) => x.id === row.id);
    ck('the row says what it is', line && line.kind === 'trucker' && /^Trucker /.test(line.label));
    ck('  and it is money OUT', line.direction === 'out');

    // A real load payment alongside, to prove the split is a split and not a
    // relabelling of everything.
    await payments.addPayment({ load_id: 'EDGE_50', load_kind: 'purchase', amount: 200, mode: 'Zelle', paid_on: '2026-09-05' });
    const r2 = buildSpendReport({ payments: payments.listPayments(), expenses: [], pettyEntries: [] });
    ck('a real load payment still counts as load spend', r2.loadTotal === 200);
    ck('  beside the haulage', r2.truckerTotal === 800);

    // The method filter has to narrow trucker rows like everything else.
    const wire = buildSpendReport({ payments: payments.listPayments(), expenses: [], pettyEntries: [], method: 'Wire' });
    ck('filtering by Wire keeps the trucker payment', wire.truckerTotal === 800);
    ck('  and drops the Zelle load payment', wire.loadTotal === 0);
    const zelle = buildSpendReport({ payments: payments.listPayments(), expenses: [], pettyEntries: [], method: 'Zelle' });
    ck('filtering by Zelle does the opposite', zelle.truckerTotal === 0 && zelle.loadTotal === 200);

    // And the date window.
    const window = buildSpendReport({ payments: payments.listPayments(), expenses: [], pettyEntries: [],
                                      from: '2026-09-06', to: '2026-09-30' });
    ck('a window that excludes it excludes it', window.truckerTotal === 0);

    // Legacy rows with no load_kind at all must still read as purchases.
    const legacy = buildSpendReport({
        payments: [{ id: 'L1', load_id: 'EDGE_05', mode: 'Cash', amount: 700, paid_on: '2026-09-05' }],
        expenses: [], pettyEntries: [] });
    ck('a payment written before load_kind existed is still a purchase',
       legacy.loadTotal === 700 && legacy.truckerTotal === 0,
       'defaulting the other way would move real load spend into haulage');
}

// ── E. once paid, delete is refused — on the ROUTE ────────────────────────
section('E — "once paid, hide delete option for staff and admin"');
{
    reset();
    const b = await bills.addBill(bill({ company: 'Ace', amount: 300 }));
    await req('POST', '/api/payments', { sid: adminSid,
        body: { load_id: b.id, load_kind: 'trucker', mode: 'Zelle', amount: 300, paid_on: '2026-09-05' } });

    const a = await req('DELETE', `/api/trucker-bills/${b.id}`, { sid: adminSid });
    ck('admin is refused', a.status === 409, `got ${a.status}`);
    ck('  with a code', a.json && a.json.code === 'BILL_HAS_PAYMENTS');
    ck('  and the amount already paid', a.json && a.json.paid === 300);

    const s = await req('DELETE', `/api/trucker-bills/${b.id}`, { sid: staffSid });
    ck('staff are refused', s.status === 409,
       'staff can reach this route — a hidden button would have been the only guard');
    ck('  the bill survived', bills.listBills().length === 1);
    ck('  and so did its payment', payments.paymentsForLoad(b.id).length === 1);
    ck('both refusals are logged',
       audit.listEntries().filter((x) => x.action === 'delete-paid-trucker-bill' && x.outcome === 'refused').length === 2);

    // An UNPAID bill still deletes, for both. Otherwise the guard is just "no
    // deleting", which is a worse bug than the one it prevents.
    const u = await bills.addBill(bill({ company: 'Vega', amount: 90 }));
    ck('an unpaid bill still deletes for staff',
       (await req('DELETE', `/api/trucker-bills/${u.id}`, { sid: staffSid })).status === 200);
    const u2 = await bills.addBill(bill({ company: 'Vega', amount: 90 }));
    ck('  and for admin',
       (await req('DELETE', `/api/trucker-bills/${u2.id}`, { sid: adminSid })).status === 200);

    // Jarvis goes past it, consistent with loads, and takes the payments with
    // it — receipts left behind would sum against a bill that no longer exists.
    const j = await req('DELETE', `/api/trucker-bills/${b.id}`, { sid: jarvisSid });
    ck('the Jarvis profile deletes a paid bill', j.status === 200, j.raw);
    ck('  its payments go with it', payments.paymentsForLoad(b.id).length === 0);
    ck('  and the log keeps what is now gone', (() => {
        const row = audit.listEntries().find((x) => x.subject === b.id && x.outcome === 'done');
        return row && row.detail.company === 'Ace' && row.detail.paid === 300
            && row.detail.payments.length === 1 && row.detail.payments[0].mode === 'Zelle';
    })(), 'the company and the payment exist nowhere else once the bill is deleted');
}

// ── F. "for everyone" ─────────────────────────────────────────────────────
section('F — every role can see the tab');
{
    reset();
    await bills.addBill(bill());
    for (const [who, sid] of [['admin', adminSid], ['staff', staffSid], ['jarvis', jarvisSid]]) {
        const r = await req('GET', '/api/trucker-bills', { sid });
        ck(`${who} can read the bills`, r.status === 200 && Array.isArray(r.json.bills));
    }
    // Staff can record what is OWED...
    const add = await req('POST', '/api/trucker-bills', { sid: staffSid,
        body: { date: '2026-09-02', company: 'Gate Haulage', amount: 120 } });
    ck('staff can add a bill', add.status === 200, 'a driver at the gate hands over an invoice');

    // ...and NOT that it was settled. Same division as loads: staff weigh and
    // price, admin pays. Deliberate, and stated here so that changing it is a
    // decision rather than a drift.
    const pay = await req('POST', '/api/payments', { sid: staffSid,
        body: { load_id: 'TRK_001', load_kind: 'trucker', mode: 'Zelle', amount: 10 } });
    ck('staff CANNOT record a payment', pay.status === 403,
       '/api/payments is deliberately absent from the staff allowlist — the same rule as loads');

    // The dropdown comes from the server, so it cannot offer what the server
    // would refuse.
    const g = await req('GET', '/api/trucker-bills', { sid: adminSid });
    ck('the payload carries the modes', g.json && g.json.modes.join('/') === 'Zelle/Wire');
    ck('  and the totals for the header',
       g.json && g.json.report && typeof g.json.report.outstanding === 'number');
}

// ── G. the totals on the tab ──────────────────────────────────────────────
section('G — billed, paid, outstanding');
{
    reset();
    const a = await bills.addBill(bill({ amount: 1000 }));
    const b = await bills.addBill(bill({ amount: 500 }));
    await payments.addPayment({ load_id: a.id, load_kind: 'trucker', amount: 400, mode: 'Zelle', paid_on: '2026-09-02' });

    const rep = bills.billsReport();
    ck('billed is every bill', rep.billed === 1500);
    ck('paid is what has moved', rep.paid === 400);
    ck('outstanding is the difference', rep.outstanding === 1100);
    ck('  and the count', rep.count === 2);

    // ── THE ONE THAT CAUGHT A REAL BUG ────────────────────────────────────
    // Bill A owes 600. Bill B gets overpaid by 400. The first implementation
    // computed max(0, billed - paid) across the whole list and reported 200
    // outstanding — netting one hauler's overpayment against another's debt.
    //
    // That 200 is money that does not exist. The 400 sitting with the second
    // hauler cannot settle the first one; someone has to ring them and ask
    // for it back. The header made the yard look less in debt than it was,
    // using an error as though it were a credit.
    await payments.addPayment({ load_id: b.id, load_kind: 'trucker', amount: 900, mode: 'Wire', paid_on: '2026-09-02' });
    const rep2 = bills.billsReport();
    ck('outstanding is what is still owed, bill by bill', rep2.outstanding === 600,
       `got ${rep2.outstanding} — 200 means an overpayment is being netted against a real debt`);
    ck('  the overpayment is reported on its own', rep2.overpaid === 400,
       'money paid out beyond what was billed is a thing to chase, not a thing to subtract');
    ck('  billed and paid are still the plain sums', rep2.billed === 1500 && rep2.paid === 1300);
    ck('  and the overpayment is visible on the bill itself',
       bills.listBillsWithPayments().find((x) => x.id === b.id).payment.status === 'overpaid',
       'hidden, it looks like a settled bill and the 400 difference is never chased');
}

// ── H. correcting a bill below what was paid ──────────────────────────────
section('H — an edit that makes a bill overpaid');
{
    reset();
    const b = await bills.addBill(bill({ amount: 1000 }));
    await payments.addPayment({ load_id: b.id, load_kind: 'trucker', amount: 1000, mode: 'Wire', paid_on: '2026-09-02' });

    // The hauler over-invoiced and it is corrected afterwards. Allowed, not
    // refused: the money genuinely moved, and refusing the correction leaves
    // the wrong figure standing on the ledger.
    await bills.editBill(b.id, bill({ amount: 700 }));
    const after = bills.listBillsWithPayments().find((x) => x.id === b.id);
    ck('the correction is accepted', after.amount === 700);
    ck('  and the bill reads overpaid', after.payment.status === 'overpaid');
    ck('  by the difference', after.payment.over === 300,
       'visible is better than prevented — someone has to go and get the 300 back');
    ck('  payments were not touched', payments.paymentsForLoad(b.id).length === 1);
}

server.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  Failed:'); failures.forEach((f) => console.log('   - ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
})();
