// ── tests/supplier-account.js ─────────────────────────────────────────────
// Apsara, 2026-09-11: "i want to maintain per supplier basis. inventory items
// and accounts for that supplier. so every payment recorded for a supplier
// should be made an entry here for eg: if i do wire for a container AAA it
// should be recorded as Wire for [container] next amount (credit column),
// bill amount(debit column) then balance. it should be a running total. in
// case of advance, debit col should be blank while credit should contain
// amount."
//
// A RUNNING BALANCE IS THE WORST KIND OF THING TO GET WRONG, because every
// individual row keeps looking correct. The ways it can drift silently:
//
//   · an advance credited once when made and AGAIN when applied. The store it
//     is built from warns about exactly this — applyAdvance "adds an
//     allocation to a payment that already happened. No second ledger row."
//   · a bill's net_payable used instead of its amount, so every container
//     with haulage understates what the supplier is owed by the trucking.
//   · a bill and a payment on the same date in whatever order the two stores
//     happened to yield, so the balance column differs between two loads of
//     the same page while the closing figure agrees.
//   · a date-filtered statement restarting at zero, which states she owed
//     nothing on the first of the month.
//   · a payment to another supplier landing on this account.
//
// None of those raises anything.

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-supacct-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
for (const f of [cfg.BILLS_FILE, cfg.BILL_PAYMENTS_FILE, cfg.PAYMENTS_FILE, cfg.EDGE_INVENTORY_FILE]) {
    fs.writeFileSync(f, '[]');
}

const bills = require(path.join(ROOT, 'helpers/bills'));
const bp = require(path.join(ROOT, 'helpers/billPayments'));
const sa = require(path.join(ROOT, 'helpers/supplierAccount'));
const inv = require(path.join(ROOT, 'helpers/edgeInventory'));

const MZ = 'Mazariegos';
const OTHER = 'Oakland Metals';
// Carries the weight/price probe bills so they cannot move MZ's running total.
const PROBE = 'Probe Metals';

(async () => {

// One bill on 09/01 (21,930), an advance on 08/28 (5,000), a wire on 09/03
// (21,930) against the first container, a second bill on 09/05 (12,000).
const b1 = await bills.addBill({ date: '09/01/2026', supplier: MZ, container_no: 'AAA111',
    invoice_no: 'INV-1', items: [{ description: 'Al combo', weight: '51000', price: '0.43' }] });
const adv = await bp.addAdvance({ date: '08/28/2026', supplier: MZ, amount: 5000, mode: 'Wire', bank: 'Chase' });
await bp.addBillPayment({ date: '09/03/2026', supplier: MZ, amount: 21930, mode: 'Wire', bank: 'Chase',
    allocations: [{ bill_id: b1.id, amount: 21930 }] });
const b2 = await bills.addBill({ date: '09/05/2026', supplier: MZ, container_no: 'BBB222',
    items: [{ description: 'Auto cast', weight: '40000', price: '0.30' }] });

section('A — the columns she specified');
{
    const st = sa.statement(MZ);
    const advRow = st.rows.find((r) => r.kind === 'advance');
    const payRow = st.rows.find((r) => r.kind === 'payment');
    const billRow = st.rows.find((r) => r.id === b1.id);

    // Her rule, verbatim: "in case of advance, debit col should be blank while
    // credit should contain amount".
    ck('an advance has a BLANK debit', advRow && advRow.debit === null, JSON.stringify(advRow));
    ck('  and its amount in credit', advRow && advRow.credit === 5000, JSON.stringify(advRow));

    // "if i do wire for a container AAA it should be recorded as Wire for
    // [container]".
    ck('a wire is described as "Wire for <container>"',
       payRow && payRow.what === 'Wire for AAA111', payRow && payRow.what);
    ck('  with its amount in credit and debit blank',
       payRow && payRow.credit === 21930 && payRow.debit === null, JSON.stringify(payRow));

    ck('a bill puts its amount in DEBIT', billRow && billRow.debit === 21930, JSON.stringify(billRow));
    ck('  and leaves credit blank', billRow && billRow.credit === null);
    ck('  naming the invoice and the container', billRow && /INV-1/.test(billRow.what) && /AAA111/.test(billRow.what),
       billRow && billRow.what);

    // ONE ROW PER EVENT — her answer when asked. Four events, four rows.
    ck('one row per event, not one per payment carrying its bill too',
       st.rows.length === 4, `${st.rows.length} rows`);
}

section('A2 — net weight and price sit before the money');
{
    // Apsara, 2026-09-11: "before credit/debit, there should be a field
    // called net weight and price".
    const st = sa.statement(MZ);
    const billRow = st.rows.find((r) => r.id === b1.id);
    const payRow = st.rows.find((r) => r.kind === 'payment');

    ck('a bill row carries its net weight', billRow.weight === 51000, String(billRow.weight));
    ck('  and its price', billRow.price === 0.43, String(billRow.price));

    // THE POINT OF THE PAIR: they have to explain the debit beside them. At
    // $0.43 the price is per POUND (her $10 rule), so the weight shown must
    // be in pounds — 51,000 lb x 0.43 = 21,930. Show 23.133 MT beside the
    // same price and the row states an amount 2204 times smaller than the one
    // in the debit column, with every figure individually correct.
    ck('  in the unit the price is quoted in', billRow.weight_unit === 'lb', billRow.weight_unit);
    ck('  so weight x price is the debit',
       Math.abs(billRow.weight * billRow.price - billRow.debit) < 0.005,
       `${billRow.weight} x ${billRow.price} vs ${billRow.debit}`);

    ck('a payment carries neither — it is money, not metal',
       payRow.weight === null && payRow.price === null, JSON.stringify(payRow));
    ck('  and null, not zero, so it reads as blank not as weightless',
       payRow.weight !== 0);

    // FOUND BY THIS TEST: reading net_lb alone left the column blank on b1.
    // Since the container weighing group came off the form this morning, a
    // bill's weight comes from its LINES, and compute() only fills net_lb
    // when a line carries a weighbridge ticket. Most new bills will not.
    ck('  a line with a plain typed weight still shows a weight',
       billRow.weight === 51000 && !bills.compute(b1).net_lb,
       `net_lb=${bills.compute(b1).net_lb} but the row shows ${billRow.weight}`);

    // ── ON A THIRD SUPPLIER, DELIBERATELY ────────────────────────────────
    // These two probe bills were first added under MZ and broke four
    // assertions three sections below, because they moved that account's
    // running totals. A fixture that changes the numbers a later section is
    // checking is a fixture in the wrong place.
    // A per-MT price must bring a per-MT weight with it.
    const mt = await bills.addBill({ date: '09/12/2026', supplier: PROBE, container_no: 'MTX111',
        items: [{ description: 'Al combo', weight: '51000', price: '700' }] });
    const mtRow = sa.statement(PROBE).rows.find((r) => r.id === mt.id);
    ck('a per-MT price shows the weight in MT', mtRow.weight_unit === 'mt' && mtRow.weight === 23.133,
       JSON.stringify({ w: mtRow.weight, u: mtRow.weight_unit }));
    ck('  and weight x price is still the debit',
       Math.abs(mtRow.weight * mtRow.price - mtRow.debit) < 1,
       `${mtRow.weight} x ${mtRow.price} vs ${mtRow.debit}`);

    // Two grades at two rates: no single price is true of the row, and
    // blending them is the shortcut bills.js explicitly warns against.
    const two = await bills.addBill({ date: '09/13/2026', supplier: PROBE, container_no: 'MIX222',
        items: [{ description: 'Al combo', weight: '51000', price: '0.43' },
                { description: 'Auto cast', weight: '9000', price: '0.30' }] });
    const mixRow = sa.statement(PROBE).rows.find((r) => r.id === two.id);
    ck('two grades at two rates show no price at all',
       mixRow.price === null, String(mixRow.price));
    ck('  and say why, rather than blending them',
       mixRow.price_mixed === true, JSON.stringify(mixRow));
    ck('  but the weight and the debit are both still there',
       mixRow.weight === 60000 && mixRow.debit === 24630, JSON.stringify(mixRow));
}

section('B — the running total');
{
    const st = sa.statement(MZ);
    ck('it runs in date order',
       st.rows.map((r) => r.date).join(' ') === '08/28/2026 09/01/2026 09/03/2026 09/05/2026',
       st.rows.map((r) => r.date).join(' '));
    ck('  starting negative while she is in credit',
       st.rows[0].balance === -5000, String(st.rows[0].balance));
    ck('  and each row carries the total so far',
       st.rows.map((r) => r.balance).join(',') === '-5000,16930,-5000,7000',
       st.rows.map((r) => r.balance).join(','));
    ck('the closing figure is what she still owes',
       st.closing === 7000, String(st.closing));
    ck('  and it is debits less credits',
       st.closing === Math.round((st.debit_total - st.credit_total) * 100) / 100,
       `${st.debit_total} - ${st.credit_total}`);
    // Read off the last row rather than recomputed, so the number at the foot
    // of the column and the number in the summary cannot disagree.
    ck('  and it is the last row\'s balance, not a second sum',
       st.closing === st.rows[st.rows.length - 1].balance);
}

section('C — an applied advance is NOT a second payment');
{
    const before = sa.statement(MZ);
    await bp.applyAdvance(adv.id, [{ bill_id: b2.id, amount: 5000 }]);
    const after = sa.statement(MZ);

    // helpers/billPayments.js, at applyAdvance: "It adds an allocation to a
    // payment that already happened. No second ledger row, because the money
    // already left the bank." Credit it from the allocations instead of from
    // the payment and the supplier reads as paid twice over.
    ck('applying it adds no row', after.rows.length === before.rows.length,
       `${before.rows.length} -> ${after.rows.length}`);
    ck('  and no credit', after.credit_total === before.credit_total,
       `${before.credit_total} -> ${after.credit_total}`);
    ck('  so the balance is unchanged', after.closing === before.closing,
       `${before.closing} -> ${after.closing}`);
    // But the row now says what it went against, which is the point of
    // applying it.
    const advRow = after.rows.find((r) => r.kind === 'advance');
    ck('  though the row now names the container it was applied to',
       /BBB222/.test(advRow.what), advRow.what);
}

section('D — nobody else\'s money lands on this account');
{
    const ob = await bills.addBill({ date: '09/02/2026', supplier: OTHER, container_no: 'CCC333',
        items: [{ description: 'Al combo', weight: '10000', price: '0.50' }] });
    await bp.addBillPayment({ date: '09/04/2026', supplier: OTHER, amount: 5000, mode: 'Wire',
        bank: 'Chase', allocations: [{ bill_id: ob.id, amount: 5000 }] });

    const mz = sa.statement(MZ);
    ck('the other supplier\'s bill is not on this statement',
       !mz.rows.some((r) => /CCC333/.test(r.what)), mz.rows.map((r) => r.what).join(' | '));
    ck('  nor their payment', mz.credit_total === 26930, String(mz.credit_total));
    ck('  and this account is untouched by it', mz.closing === 7000, String(mz.closing));

    const other = sa.statement(OTHER);
    ck('the other supplier has their own', other.rows.length === 2 && other.closing === 0,
       JSON.stringify({ rows: other.rows.length, closing: other.closing }));

    ck('every supplier traded with is offered in the picker',
       sa.suppliers().join(',') === [MZ, OTHER, PROBE].sort((a, b) => a.localeCompare(b)).join(','),
       sa.suppliers().join(','));
    // Named MZ at first, which stopped being true the moment the probe
    // supplier above was given bigger bills. The RULE is descending balance,
    // so assert the rule rather than one supplier's position under it.
    ck('  and the overview is ordered by who is owed most',
       sa.overview().every((o, i, a2) => i === 0 || (a2[i - 1].closing || 0) >= (o.closing || 0)),
       JSON.stringify(sa.overview().map((o) => [o.supplier, o.closing])));
    ck('  every supplier appearing exactly once',
       new Set(sa.overview().map((o) => o.supplier)).size === sa.overview().length);
}

section('E — a same-day bill and payment always land the same way round');
{
    // Sorting by date alone leaves these in whatever order the two stores
    // yielded, so the balance COLUMN differs between two loads of the same
    // page while the closing figure agrees — which is what makes it hard to
    // notice. Bills before payments on a shared date: goods arrive, then are
    // paid for.
    const sd = await bills.addBill({ date: '09/09/2026', supplier: MZ, container_no: 'DDD444',
        items: [{ description: 'Al combo', weight: '10000', price: '0.10' }] });
    await bp.addBillPayment({ date: '09/09/2026', supplier: MZ, amount: 1000, mode: 'Wire',
        bank: 'Chase', allocations: [{ bill_id: sd.id, amount: 1000 }] });

    const shape = () => sa.statement(MZ).rows.filter((r) => r.date === '09/09/2026').map((r) => r.kind).join(',');
    ck('the bill comes before the payment', shape() === 'bill,payment', shape());
    const first = sa.statement(MZ).rows.map((r) => r.balance).join(',');
    ck('  and the whole balance column is identical on a second read',
       sa.statement(MZ).rows.map((r) => r.balance).join(',') === first, first);
}

section('F — a filtered statement carries the balance forward');
{
    const sep = sa.statement(MZ, { from: '09/01/2026' });
    ck('September opens with what August left', sep.opening === -5000, String(sep.opening));
    ck('  the advance itself is not shown', !sep.rows.some((r) => r.kind === 'advance'));
    ck('  but the running column continues from it',
       sep.rows[0].balance === -5000 + sep.rows[0].debit, JSON.stringify(sep.rows[0]));
    ck('  and closing matches the unfiltered statement',
       sep.closing === sa.statement(MZ).closing,
       `${sep.closing} vs ${sa.statement(MZ).closing}`);
}

section('G — the debit is what the SUPPLIER is owed, not the bill net');
{
    // net_payable is amount minus trucking, because trucking is deducted from
    // what the supplier gets on the bill row. But the haulier is paid through
    // metalsTrucking, and this account is between her and the supplier. Using
    // the net here understates what she owes by the haulage on every hauled
    // container, and always in the flattering direction.
    const t = await bills.addBill({ date: '09/10/2026', supplier: MZ, container_no: 'EEE555',
        trucking_company: 'Jio Trucking', trucking_amount: '900',
        items: [{ description: 'Al combo', weight: '10000', price: '0.20' }] });
    const computed = bills.compute(t);
    ck('the bill nets out to less than its amount',
       computed.net_payable === 1100 && computed.amount === 2000,
       JSON.stringify({ amount: computed.amount, net_payable: computed.net_payable }));
    const row = sa.statement(MZ).rows.find((r) => r.id === t.id);
    ck('  but the account debits the full amount',
       row.debit === 2000, `${row.debit} — the trucker is paid separately`);
}

section('H — a bill with no supplier is surfaced, not swallowed');
{
    const orphan = await bills.addBill({ date: '09/11/2026', container_no: 'FFF666',
        items: [{ description: 'Al combo', weight: '1000', price: '0.10' }] });
    ck('it belongs to no account', !sa.suppliers().some((s) => !s));
    ck('  and appears nowhere on one',
       !sa.statement(MZ).rows.some((r) => r.id === orphan.id));
    ck('  so it is reported instead of vanishing',
       sa.unassigned().some((u) => u.id === orphan.id), JSON.stringify(sa.unassigned()));
}

section('I — the packing list, per supplier');
{
    const r1 = await inv.addReceipt({ date: '09/06/2026', supplier: MZ, packing_list_no: 'PL-77',
        items: [{ description: 'Al combo', weight: '12000', price: '0.40' },
                { description: 'Auto cast', weight: '8000', price: '0.30' }] });
    ck('a receipt sums its own weight', r1.weight_lb === 20000, String(r1.weight_lb));
    ck('  in MT as well', r1.weight_mt === 9.072, String(r1.weight_mt));
    ck('  and its own amount', r1.amount === 7200, String(r1.amount));
    ck('  keeping the supplier\'s packing list number', r1.packing_list_no === 'PL-77');

    let threw = '';
    try { await inv.addReceipt({ date: '09/06/2026', items: [{ description: 'x', weight: '1' }] }); }
    catch (e) { threw = e.message; }
    ck('a receipt with no supplier is refused', /which supplier/i.test(threw), threw);

    threw = '';
    try { await inv.addReceipt({ date: '09/06/2026', supplier: MZ, items: [] }); }
    catch (e) { threw = e.message; }
    ck('  and so is one with no items', /at least one item/i.test(threw), threw);

    await inv.addReceipt({ date: '09/08/2026', supplier: MZ,
        items: [{ description: 'Al combo', weight: '5000', price: '0.40' }] });
    await inv.addReceipt({ date: '09/08/2026', supplier: OTHER,
        items: [{ description: 'Al combo', weight: '99000', price: '0.40' }] });

    ck('only this supplier\'s receipts show', inv.forSupplier(MZ).length === 2,
       String(inv.forSupplier(MZ).length));
    ck('  newest first', inv.forSupplier(MZ)[0].date === '09/08/2026',
       inv.forSupplier(MZ).map((r) => r.date).join(','));

    const grades = inv.byGrade(MZ);
    const alc = grades.find((g) => g.description === 'Al combo');
    ck('grades are totalled across receipts', alc && alc.weight_lb === 17000, JSON.stringify(alc));
    ck('  and the other supplier\'s 99,000 lb is not in it',
       alc && alc.weight_lb !== 116000, JSON.stringify(alc));
    ck('  heaviest grade first', grades[0].description === 'Al combo',
       grades.map((g) => g.description).join(','));
    ck('the summary agrees with the rows',
       inv.summary(MZ).weight_lb === 25000, JSON.stringify(inv.summary(MZ)));
}

section('J — receiving metal is not a debit');
{
    // The supplier is owed when the BILL is raised, not when the truck
    // arrives. A receipt that also debited the account would count the same
    // purchase twice — once on delivery and once on the bill.
    const before = sa.statement(MZ).closing;
    await inv.addReceipt({ date: '09/09/2026', supplier: MZ,
        items: [{ description: 'Al combo', weight: '30000', price: '0.40' }] });
    ck('a receipt moves the account not at all',
       sa.statement(MZ).closing === before, `${before} -> ${sa.statement(MZ).closing}`);
    ck('  and adds no row to it',
       !sa.statement(MZ).rows.some((r) => r.kind === 'receipt'));
}

section('K — Edge Metals and the yard keep separate books');
{
    // Standing rule, hers, repeated many times: "Edge Yard is different and
    // Edge Metals is different." The form here is modelled on Add load; the
    // STORE is not shared with it.
    const src = fs.readFileSync(path.join(ROOT, 'helpers/edgeInventory.js'), 'utf8');
    ck('inventory writes to its own store, never loads.json',
       /EDGE_INVENTORY_FILE/.test(src) && !/LOADS_FILE/.test(src));
    ck('  and the yard\'s loads are untouched by any of this',
       require(path.join(ROOT, 'helpers/json')).loadJson(cfg.LOADS_FILE, []).length === 0);
}

section('L — the page actually renders her columns, in her order');
{
    // The distinction this codebase keeps needing: "the helper returns a
    // price" is not "there is a Price column on screen between Net weight and
    // Debit". jsdom renders the real page against the real helper output.
    const { JSDOM } = require('jsdom');
    const html = fs.readFileSync(path.join(ROOT, 'dashboard/edge-inventory.html'), 'utf8');
    // ROUTE EVERY SUPPLIER, not just MZ. The page selects whoever is owed
    // MOST, which by this point in the file is the probe supplier — routing
    // only MZ left that fetch unmatched, the page rendered an error div, and
    // four assertions failed for a reason that had nothing to do with them.
    const routes = { '/api/edge-inventory/suppliers': { ok: true, suppliers: sa.overview(), unassigned: sa.unassigned() } };
    for (const s2 of sa.suppliers()) {
        routes[`/api/edge-inventory/${encodeURIComponent(s2)}`] = {
            ok: true, supplier: s2, account: sa.statement(s2),
            receipts: inv.forSupplier(s2), by_grade: inv.byGrade(s2), received: inv.summary(s2),
        };
    }
    // beforeParse, NOT after construction. jsdom runs the page's scripts while
    // it parses, so a fetch assigned to dom.window afterwards arrives too late
    // — loadSuppliers() has already run against the real (absent) fetch and
    // thrown, and the page renders empty. Cost four failing assertions to
    // notice, because an empty table fails every check about its contents.
    const dom = new JSDOM(html, {
        runScripts: 'dangerously', url: 'http://localhost/edge-inventory',
        beforeParse(w) {
            w.fetch = (u) => {
                const body = routes[String(u).split('?')[0]] || { ok: true };
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
            };
            w.confirm = () => true;
        },
    });

    await new Promise((r) => setTimeout(r, 300));
    const doc = dom.window.document;
    // Drive the picker to the supplier these assertions are about.
    doc.getElementById('supPick').value = MZ;
    doc.getElementById('supPick').dispatchEvent(new dom.window.Event('change'));
    await new Promise((r) => setTimeout(r, 200));

    const heads = [...doc.querySelectorAll('#acctBox thead th')].map((th) => th.textContent.trim());
    ck('the account table has her columns',
       heads.join('|') === 'Date|Description|Net weight|Price|Debit|Credit|Balance', heads.join('|'));
    ck('  with net weight and price BEFORE debit and credit',
       heads.indexOf('Net weight') < heads.indexOf('Debit')
       && heads.indexOf('Price') < heads.indexOf('Credit'), heads.join('|'));

    const cells = [...doc.querySelectorAll('#acctBox tbody tr')].map((tr) =>
        [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()));
    ck('  a bill row shows weight, price and a debit',
       cells.some((c) => /51,000 lb/.test(c[2]) && /0.43\/lb/.test(c[3]) && /21,930/.test(c[4])),
       JSON.stringify(cells));
    // Matched on the ROW SHAPE, not on the word "advance". The first version
    // looked for /advance/i in the description and found nothing, because
    // section C applied that advance and its row now names the container it
    // went against — the assertion was stale relative to its own fixture. The
    // rule she stated is about the CELLS: money in, nothing in debit.
    const credits = cells.filter((c) => c[5] !== '');
    ck('  the credit rows are there', credits.length >= 2, JSON.stringify(cells.map((c) => c[5])));
    ck('  and every one of them leaves the debit cell blank',
       credits.every((c) => c[4] === ''), JSON.stringify(credits));
    ck('  with no weight or price on them either — money is not metal',
       credits.every((c) => c[2] === '' && c[3] === ''), JSON.stringify(credits));
    ck('  while every debit row does carry a weight',
       cells.filter((c) => c[4] !== '').every((c) => c[2] !== ''),
       JSON.stringify(cells.filter((c) => c[4] !== '')));
    ck('  every row carries a running balance',
       cells.every((c) => c[6] && /\$/.test(c[6])), JSON.stringify(cells.map((c) => c[6])));

    ck('the delivery form asks for a supplier and no buyer',
       !!doc.getElementById('rm_supplier') && !doc.querySelector('[id*="buyer" i]'));
    ck('  and opens with one packing-list line ready',
       (() => { doc.getElementById('btnAddReceipt').click();
                return doc.querySelectorAll('#rm_items input[data-f="description"]').length === 1; })(),
       String(doc.querySelectorAll('#rm_items > div').length));

    dom.window.close();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('\n  THREW:', e.stack || e.message); process.exit(1); });
