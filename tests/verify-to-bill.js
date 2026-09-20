// ── tests/verify-to-bill.js ───────────────────────────────────────────────
// Apsara, 2026-09-20: "When i run verification against say aj transport,that
// verified bill is not coming into trucking of bills?"
//
// It was not. The verification read a hauler's PDFs, cross-checked them
// against the Invoice sheet, logged the passing rows to a tab on that
// workbook, and stopped — so she verified an invoice and then typed the same
// four figures onto the bill by hand.
//
// Her three decisions, and the sections that hold each one:
//   "Propose — I confirm per bill"      -> B, F: nothing writes without her
//   "All of it on one row, I pick which" -> C: THE section of this file
//   "Show both, change nothing"          -> D
//   "For transports, second tab of Bills.. For zimex - in freight of invoice"
//                                        -> A (mapping) and E (Zimex)
//
// ── WHY SECTION C IS THE ONE THAT MATTERS ────────────────────────────────
// A hauler charges once to move a container. A bill is one row PER GRADE.
// Apsara, 2026-09-19: "sometimes diff items in same container." Writing one
// $850 haul onto three bills trebles her haulage — the same "one key means
// one row" belief that silently dropped $15,955 from a single container on
// the margin report.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-v2b-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
// ── SET BEFORE config IS REQUIRED, AND THAT ORDER IS THE POINT ───────────
// These lived down in section F, after `require(config)` had already read the
// environment once. cfg.STAFF_PASSWORD was therefore empty, the staff login
// returned no session, and the staff-is-refused check below SKIPPED ITSELF —
// printing nothing, failing nothing, and proving nothing about a boundary on
// money. A check that can quietly not run is worse than one that is missing,
// because the count at the bottom looks the same either way.
process.env.APP_PASSWORD   = process.env.APP_PASSWORD   || 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'staff-pw-ccccccccccc';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('  ABORT  config not isolated'); process.exit(1); }

const tp = require(path.join(ROOT, 'helpers/truckingProposal'));
const fp = require(path.join(ROOT, 'helpers/freightProposal'));
const bills = require(path.join(ROOT, 'helpers/bills'));
const sales = require(path.join(ROOT, 'helpers/sales'));

// One container, THREE grades — the shape her ledger actually takes.
const THREE_GRADES = [
    { id: 'B1', date: '2026-09-01', supplier: 'Acme', booking_no: 'EBKG100', container_no: 'MSKU1234567', description: 'HMS 1&2', amount: 20000 },
    { id: 'B2', date: '2026-09-01', supplier: 'Acme', booking_no: 'EBKG100', container_no: 'MSKU1234567', description: 'Shred', amount: 5000 },
    { id: 'B3', date: '2026-09-01', supplier: 'Acme', booking_no: 'EBKG100', container_no: 'MSKU1234567', description: 'Al combo', amount: 2000 },
];
const ONE_GRADE = [
    { id: 'B9', date: '2026-09-02', supplier: 'Beta', booking_no: 'EBKG200', container_no: 'TCLU7654321', description: 'HMS 1&2', amount: 9000 },
];

const AJ = (over = {}) => ({
    status: 'verified', invoice_no: '6405', invoice_date: '2026-09-02',
    container_no: 'MSKU1234567', booking_no: 'EBKG100',
    amount: 850, dry_run_charge: 125, extra_scale_charge: 0, other_charge: 40, ...over,
});

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — the invoice maps onto the split');

{
    const s = tp.splitFromAj(AJ());
    ck('AJ line haul is the container amount', s.line_haul === 850);
    ck('AJ dry run carries across', s.dry_run === 125);
    // A hauler that did not charge for a dry run should leave that box EMPTY,
    // not write 0.00 into it. A typed zero and an untouched field look
    // identical afterwards and mean different things.
    ck('a zero charge is left blank, not written as 0', s.extra_scale === null, `extra_scale=${s.extra_scale}`);
    ck('the unnamed other charge becomes an Other', s.others.length === 1 && s.others[0].amount === 40);
    // cleanTruckingOthers REFUSES an Other with no name and no note. If this
    // ever produced one, every accept would throw at the last moment.
    ck('that Other has a name', !!s.others[0].what);
    ck('and a note naming the invoice it came from', /6405/.test(s.others[0].note || ''));
    ck('the whole thing survives the real sanitizer',
        (() => { try { bills.cleanTruckingSplit({ ...s, invoice_no: '6405' }); return true; } catch (e) { return e.message; } })() === true);

    const j = tp.splitFromJio({ line_haul: 700, port_fees: 60, chassis_rent: 45,
        other_charges: [{ description: 'Detention', amount: 90 }], invoice_no: 'J-1' });
    ck('Jio fills the parts it already names', j.line_haul === 700 && j.port_fees === 60 && j.chassis_rent === 45);
    // Jio's charges come with their own descriptions, so unlike AJ's single
    // unnamed bucket they must keep the real name rather than get one made up.
    ck('Jio keeps the real name of an other charge', j.others[0].what === 'Detention');

    const sh = tp.splitFromSher({ amount: 500, chassis: 75, other_charges: 20, booking_no: 'EBKG100' });
    ck('Sher bills a haul and a chassis', sh.line_haul === 500 && sh.chassis_rent === 75);
    ck('Sher has no port fees to guess at', sh.port_fees === undefined || sh.port_fees === null);

    ck('totalOf adds the parts and the others', tp.totalOf(tp.splitFromAj(AJ())) === 1015,
        String(tp.totalOf(tp.splitFromAj(AJ()))));
}

// ══════════════════════════════════════════════════════════════════════════
section('B — only a row the cross-check passed is offered');

{
    const [p] = tp.proposals([AJ({ status: 'not_in_sheet' })], 'aj', { allBills: ONE_GRADE });
    // Offering to write a row the verification itself complained about would
    // turn its complaint into a suggestion.
    ck('a row that failed the cross-check is not offered', p.status === 'not_verified', p.status);

    const [q] = tp.proposals([AJ({ container_no: 'ZZZZ0000000' })], 'aj', { allBills: ONE_GRADE });
    ck('a container no bill carries says so', q.status === 'no_bill', q.status);
    ck('and it still says what it WOULD have put there', q.split && q.split.line_haul === 850);

    const [r] = tp.proposals([AJ({ container_no: null })], 'aj', { allBills: ONE_GRADE });
    ck('a record with no key at all is refused', r.status === 'no_key', r.status);
}

// ══════════════════════════════════════════════════════════════════════════
section('C — one haul, three grades, and NOTHING is picked');
// ══════════════════════════════════════════════════════════════════════════

{
    const [p] = tp.proposals([AJ()], 'aj', { allBills: THREE_GRADES.concat(ONE_GRADE) });
    ck('three bills carry this container', p.candidates.length === 3, `${p.candidates.length}`);
    ck('and that is its own status, not a list with the first taken',
        p.status === 'several_bills', p.status);
    // THE PROPERTY, stated so a mutation has somewhere to fail: no candidate
    // may be marked. A default here is a guess about money wearing the look
    // of an answer.
    ck('no candidate is pre-selected', !p.candidates.some((c) => c.selected || c.chosen || c.pick));
    ck('the unrelated container is not among them',
        !p.candidates.some((c) => c.bill_id === 'B9'));
    // Without this she is choosing between three identical-looking rows.
    ck('each candidate names its grade, so they can be told apart',
        p.candidates.map((c) => c.grade).join('|') === 'HMS 1&2|Shred|Al combo',
        p.candidates.map((c) => c.grade).join('|'));
    ck('the amount is offered ONCE, not once per candidate', p.proposed_total === 1015);
    ck('and it says why she has to choose', /one per grade/.test(p.why || ''));

    const [one] = tp.proposals([AJ({ container_no: 'TCLU7654321', booking_no: 'EBKG200' })], 'aj', { allBills: ONE_GRADE });
    ck('a container with ONE bill needs no choosing', one.status === 'one_bill', one.status);

    // Sher joins on booking, not container — her instruction, and the only
    // key a Sher invoice carries.
    const [sh] = tp.proposals([{ status: 'verified', booking_no: 'EBKG200', amount: 500, chassis: 75 }],
        'sher', { allBills: ONE_GRADE });
    ck('Sher finds its bill by booking', sh.status === 'one_bill' && sh.candidates[0].bill_id === 'B9', sh.status);
    ck('and says it joined on the booking', sh.join_by === 'booking');
    // A Sher record has no container at all; joining it on one would match
    // nothing, every time.
    ck('AJ still joins on the container', tp.proposals([AJ()], 'aj', { allBills: ONE_GRADE })[0].join_by === 'container');
}

// ══════════════════════════════════════════════════════════════════════════
section('D — where they disagree, both are shown and hers stands');

{
    const withSplit = [{ ...ONE_GRADE[0],
        trucking_split: { line_haul: 900, dry_run: null, port_fees: null, chassis_rent: null,
                          extra_scale: null, others: [], others_total: 0, total: 900,
                          invoice_no: 'OLD-1', verified_on: '2026-09-15', present: true } }];
    const [p] = tp.proposals([AJ({ container_no: 'TCLU7654321', booking_no: 'EBKG200' })], 'aj', { allBills: withSplit });
    const c = p.candidates[0];
    ck('the bill already having trucking is reported', c.current.total === 900);
    ck('the gap is named, field by field', c.disagreements.length === 1 && c.disagreements[0].field === 'line_haul');
    ck('with both figures on it', c.disagreements[0].invoice === 850 && c.disagreements[0].bill === 900);
    ck('and the delta spelled out', c.disagreements[0].delta === -50);
    // Nothing is resolved. Same rule bills.js already applies to a typed
    // total against a split: keep hers, report the gap.
    ck('the proposal does not quietly adopt her figure', p.split.line_haul === 850);

    // ── HER DATE SURVIVES AN ACCEPT ───────────────────────────────────────
    // Apsara, 2026-09-20: "verified on is good" — it says a person looked,
    // and a cross-check passing is a different claim. An accept must carry it
    // through rather than blank it.
    const toSave = tp.splitToSave(p.split, c.current);
    ck('accepting carries her Verified on through untouched', toSave.verified_on === '2026-09-15', toSave.verified_on);
    ck('and never proposes one of its own',
        tp.splitToSave(p.split, { verified_on: null }).verified_on === null);
    ck('the trucker invoice number does come across', toSave.invoice_no === '6405');
}

// ══════════════════════════════════════════════════════════════════════════
section('E — Zimex goes to the invoice, not to trucking');

{
    const ZX = (over = {}) => ({ status: 'match', hbl_no: 'HBL777', container_no: 'MSKU1234567',
        invoice_no: 'ZX-9', invoice_date: '2026-09-03', amount: 2400,
        sheet: { freight_amt: 2400 }, delta: 0, ...over });

    const saleRows = [
        { id: 'S1', date: '2026-09-03', customer: 'Eccomelt', hbl_no: 'HBL777', container_no: 'MSKU1234567', description: 'HMS 1&2', charges: [] },
        { id: 'S2', date: '2026-09-03', customer: 'Eccomelt', hbl_no: 'HBL777', container_no: 'MSKU1234567', description: 'Shred', charges: [] },
    ];

    const [p] = fp.proposals([ZX()], { allSales: saleRows });
    ck('Zimex proposes a charge, not a trucking split', !!p.charge && p.charge.direction === 'out');
    ck('it is named as freight', /freight/i.test(p.charge.what));
    // cleanCharges REFUSES a charge with no reason — "that is the whole point
    // of it being a charge and not a column".
    ck('the charge carries a reason', !!p.charge.why && /ZX-9/.test(p.charge.why));
    ck('and it survives the real sanitizer',
        (() => { try { sales.cleanCharges([p.charge]); return true; } catch (e) { return e.message; } })() === true);
    // Same fan-out as a container: one HBL, one row per grade.
    ck('two invoice rows on one HBL is several, unpicked', p.status === 'several_sales', p.status);
    ck('and it says it matched on the HBL', p.matched_on === 'hbl_no');

    // A mismatch IS offered — the carrier's document is what she will pay —
    // but the gap is stated.
    const [m] = fp.proposals([ZX({ status: 'mismatch', amount: 2600, delta: 200 })], { allSales: saleRows });
    ck('a mismatch is still offered', m.status === 'several_sales', m.status);
    ck('with the gap against the sheet on it', m.delta === 200 && m.sheet_freight === 2400);

    const [n] = fp.proposals([ZX({ hbl_no: 'NOPE', container_no: 'NOPE0000000' })], { allSales: saleRows });
    ck('an HBL on no invoice row says so', n.status === 'no_sale', n.status);

    // ── A SECOND RUN CORRECTS, IT DOES NOT DUPLICATE ──────────────────────
    const withCharge = [{ ...saleRows[0],
        charges: [{ id: 'CHG_KEEP', what: 'Ocean freight', amount: 2200, direction: 'out', why: 'Zimex invoice ZX-1.' }] }];
    const [again] = fp.proposals([ZX()], { allSales: withCharge });
    const cand = again.candidates[0];
    ck('an existing freight charge is surfaced', cand.existing_freight.length === 1);
    ck('and the disagreement with it is stated', cand.disagreement && cand.disagreement.delta === 200);

    // helpers/salesSettlements.js pays charges off BY ID. A rebuild that
    // loses an id moves a settled payment onto an unrelated line.
    const replaced = fp.chargesToSave(withCharge[0], again.charge, { replaceId: 'CHG_KEEP' });
    ck('replacing updates in place, it does not append', replaced.length === 1);
    ck('and it KEEPS the charge id', replaced[0].id === 'CHG_KEEP');
    ck('with the new figure on it', replaced[0].amount === 2400);

    const added = fp.chargesToSave(saleRows[0], again.charge, {});
    ck('with nothing there, it appends', added.length === 1 && added[0].amount === 2400);

    const other = [{ id: 'CHG_OTHER', what: 'Detention', amount: 300, direction: 'out', why: 'held at port' }];
    const kept = fp.chargesToSave({ ...saleRows[0], charges: other }, again.charge, {});
    ck('an unrelated charge is never dropped', kept.length === 2 && kept.some((c) => c.id === 'CHG_OTHER'));
}

// ══════════════════════════════════════════════════════════════════════════
section('F — END TO END, through the real routes');
// ══════════════════════════════════════════════════════════════════════════
// The helpers can be right and the feature still not work: the route may not
// attach the proposals, the accept may not reach the sanitizer, the figure
// may not come back out of the tab she reads. So: a real server, real bills,
// an accept posted the way the button posts it, and the split read back off
// the route the Trucking tab calls.

{
    const http = require('http');
    const { createApi } = require(path.join(ROOT, 'api'));
    const app = createApi();
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = (method, p, { body, sid } = {}) => new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r2 = http.request(base + p, { method, headers }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
        });
        r2.on('error', reject); if (data) r2.write(data); r2.end();
    });

    const sid = ((await req('POST', '/login', { body: { password: process.env.ADMIN_PASSWORD } })).json || {}).sid;
    ck('signed in', !!sid);

    // Three real bills on one container, written through the real helper.
    const made = [];
    for (const g of ['HMS 1&2', 'Shred', 'Al combo']) {
        made.push(await bills.addBill({ date: '2026-09-01', supplier: 'Acme',
            booking_no: 'EBKG100', container_no: 'MSKU1234567', description: g }));
    }
    ck('three bills exist on the container', made.length === 3 && made.every((b) => b.id));

    const target = made[1];   // she picks Shred
    const proposal = tp.proposals([AJ()], 'aj')[0];
    ck('the live ledger also reports several', proposal.status === 'several_bills', proposal.status);

    const accepted = await req('POST', `/api/bills/${encodeURIComponent(target.id)}/accept-trucking`,
        { sid, body: { split: proposal.split, hauler: 'AJ Transport' } });
    ck('the accept route took it', accepted.status === 200, `${accepted.status} ${JSON.stringify(accepted.json)}`);

    // Read it back off the route the TRUCKING TAB calls — not off the helper
    // that wrote it. This is the gap that end-to-end exists to catch.
    const tab = await req('GET', '/api/metals-trucking', { sid });
    const rows = (tab.json && tab.json.payables) || [];
    const mine = rows.find((r) => r.bill_id === target.id);
    ck('the Trucking tab shows the bill', !!mine);
    if (mine) {
        ck('with the invoice total on it', Math.abs((mine.amount || 0) - 1015) < 0.005, `amount=${mine.amount}`);
        ck('and the hauler named', mine.trucking_company === 'AJ Transport', mine.trucking_company);
        ck('and the trucker invoice number', mine.trucker_invoice_no === '6405', mine.trucker_invoice_no);
        ck('the split is stored, not just a total', mine.split && mine.split.line_haul === 850);
        // Her date was never set on this bill and must not have been invented.
        ck('Verified on is still blank — nothing stamped it', !mine.verified_on, String(mine.verified_on));
    }

    // ── THE ONE THAT WOULD COST HER MONEY ─────────────────────────────────
    const others = rows.filter((r) => r.bill_id !== target.id && ['MSKU1234567'].includes(r.container_no));
    ck('the other two grades got NOTHING', others.every((r) => !r.amount),
        others.map((r) => `${r.bill_id}=${r.amount}`).join(','));
    const totalOnContainer = rows.filter((r) => r.container_no === 'MSKU1234567')
        .reduce((s, r) => s + (Number(r.amount) || 0), 0);
    ck('the container carries the haul ONCE', Math.abs(totalOnContainer - 1015) < 0.005, `total=${totalOnContainer}`);

    // ── A BILL THAT ALREADY HAS HER WORK ON IT, THROUGH THE ROUTE ────────
    // Section D proves splitToSave keeps a typed Verified on. That is the
    // HELPER. Two mutations of the ROUTE survived the first version of this
    // file — one dropping splitToSave entirely, one letting the hauler name
    // overwrite hers — because nothing here ever accepted onto a bill that
    // already carried either. Helper green, route untested, which is the gap
    // this whole section exists for.
    const owned = await bills.addBill({
        date: '2026-09-04', supplier: 'Gamma', booking_no: 'EBKG300', container_no: 'GAMU1112223',
        description: 'HMS 1&2',
        trucking_company: 'Her Own Trucker',
        trucking_split: { line_haul: 400, others: [], invoice_no: 'HERS-1', verified_on: '2026-09-10' },
    });
    ck('a bill with her own trucker and date exists',
        owned.trucking_company === 'Her Own Trucker'
        && owned.trucking_split && owned.trucking_split.verified_on === '2026-09-10',
        JSON.stringify(owned.trucking_split));

    const ownedProp = tp.proposals([AJ({ container_no: 'GAMU1112223', booking_no: 'EBKG300' })], 'aj')[0];
    ck('it proposes against that bill', ownedProp.status === 'one_bill', ownedProp.status);
    const acc3 = await req('POST', `/api/bills/${encodeURIComponent(owned.id)}/accept-trucking`,
        { sid, body: { split: ownedProp.split, hauler: 'AJ Transport' } });
    ck('the accept took it', acc3.status === 200, `${acc3.status} ${JSON.stringify(acc3.json)}`);

    const tab2 = await req('GET', '/api/metals-trucking', { sid });
    const ownedRow = ((tab2.json && tab2.json.payables) || []).find((r) => r.bill_id === owned.id);
    ck('the row is still there', !!ownedRow);
    if (ownedRow) {
        // The two the mutations found.
        ck('her Verified on SURVIVED the accept', ownedRow.verified_on === '2026-09-10', String(ownedRow.verified_on));
        ck('and the trucker name she typed was not overwritten',
            ownedRow.trucking_company === 'Her Own Trucker', ownedRow.trucking_company);
        // The figures she asked to be updated DID update.
        ck('while the invoice figures did land', ownedRow.split && ownedRow.split.line_haul === 850,
            JSON.stringify(ownedRow.split && ownedRow.split.line_haul));
    }

    // Zimex, end to end, onto a sale row.
    const sale = await sales.addSale({ date: '2026-09-03', customer: 'Eccomelt',
        hbl_no: 'HBL777', container_no: 'MSKU1234567', description: 'HMS 1&2' });
    const zp = fp.proposals([{ status: 'match', hbl_no: 'HBL777', invoice_no: 'ZX-9',
        invoice_date: '2026-09-03', amount: 2400, sheet: { freight_amt: 2400 }, delta: 0 }])[0];
    ck('the live ledger finds the invoice row', zp.status === 'one_sale', zp.status);
    const acc2 = await req('POST', `/api/sales/${encodeURIComponent(sale.id)}/accept-freight`,
        { sid, body: { charge: zp.charge } });
    ck('the freight accept route took it', acc2.status === 200, `${acc2.status} ${JSON.stringify(acc2.json)}`);

    const settle = await req('GET', '/api/sales-settlements', { sid });
    const pay = ((settle.json && settle.json.payables) || []).find((r) => r.sale_id === sale.id);
    ck('it shows on Invoice → Freight', !!pay, JSON.stringify(settle.json && Object.keys(settle.json)));
    if (pay) ck('with the carrier figure', Math.abs((pay.amount || 0) - 2400) < 0.005, `amount=${pay.amount}`);

    // A second accept of the same invoice must correct, not duplicate.
    const again2 = fp.proposals([{ status: 'match', hbl_no: 'HBL777', invoice_no: 'ZX-9',
        invoice_date: '2026-09-03', amount: 2500, sheet: { freight_amt: 2400 }, delta: 100 }])[0];
    const existingId = again2.candidates[0].existing_freight[0].id;
    await req('POST', `/api/sales/${encodeURIComponent(sale.id)}/accept-freight`,
        { sid, body: { charge: again2.charge, replace_id: existingId } });
    const settle2 = await req('GET', '/api/sales-settlements', { sid });
    const mineNow = ((settle2.json && settle2.json.payables) || []).filter((r) => r.sale_id === sale.id);
    ck('a second run corrects rather than duplicating', mineNow.length === 1, `${mineNow.length} freight rows`);
    if (mineNow[0]) ck('to the new figure', Math.abs((mineNow[0].amount || 0) - 2500) < 0.005, `amount=${mineNow[0].amount}`);

    // Neither route is yard work, and staff must not reach them.
    const staffSid = ((await req('POST', '/login', { body: { password: process.env.STAFF_PASSWORD } })).json || {}).sid;
    // Asserted, never skipped — see the note at the top of this file.
    ck('a staff session can be opened, or the next check proves nothing', !!staffSid);
    const denied = await req('POST', `/api/bills/${encodeURIComponent(target.id)}/accept-trucking`,
        { sid: staffSid, body: { split: proposal.split } });
    ck('staff cannot accept trucking onto a Metals bill', denied.status === 403, `status=${denied.status}`);
    const denied2 = await req('POST', `/api/sales/${encodeURIComponent(sale.id)}/accept-freight`,
        { sid: staffSid, body: { charge: zp.charge } });
    ck('staff cannot accept freight onto a Metals invoice', denied2.status === 403, `status=${denied2.status}`);

    await new Promise((r) => server.close(r));
}

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\nFailures:'); failures.forEach((f) => console.log('  - ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('\n  CRASH  ', e && e.stack || e); process.exit(1); });
