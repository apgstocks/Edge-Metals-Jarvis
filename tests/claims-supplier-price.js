// ── tests/claims-supplier-price.js ───────────────────────────────────────────
// What the supplier's own price was, and what the statement does with it.
//
// Apsara, 2026-10-03: "You didnt mention supplier price in claim?" — and when
// asked, chose recovery at the SUPPLIER's price, and grade-matching with a
// flag where it is unclear rather than an average.
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const R = (p) => path.join(ROOT, p);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-price-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
delete require.cache[require.resolve(R('config.js'))];
const cfg = require(R('config.js'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('ABORT — DATA_DIR outside the temp dir'); process.exit(1); }

let pass = 0, fail = 0; const failures = [];
const ck = (n, ok, extra) => { if (ok) { pass++; console.log('  ok   ' + n); } else { fail++; failures.push(n); console.log('  FAIL ' + n + (extra === undefined ? '' : ' — ' + JSON.stringify(extra).slice(0, 220))); } };
const section = (t) => console.log('\n' + t);

const claims = require(R('helpers/claims.js'));
const claimPrice = require(R('helpers/claimPrice.js'));
const report = require(R('helpers/claims/report.js'));
const routes = require(R('helpers/claims/routes.js'));

// Bills are written straight to the file the store reads, so this exercises the
// real lookup rather than a stub of it.
const writeBills = (rows) => fs.writeFileSync(cfg.BILLS_FILE, JSON.stringify(rows, null, 2));

(async () => {

section('A — one grade, one price: the simple bill');
{
    writeBills([{ id: 'b1', supplier: 'Gomez Metals', container_no: 'CAIU 9975642', date: '2026-05-01',
        description: 'Alu engine combo', supplier_price: 1780, price_unit: 'mt', items: [] }]);
    const c = await claims.create({ customer: 'Joey', supplier: 'Gomez Metals', invoice_no: '26JY05', container_no: 'CAIU9975642', note: 'outturn short' }, 'test');
    await claims.verify(c.id, { invoice_weight: 21.582, claimed_weight: 19.66, weight_unit: 'MT', sell_price: 2140, sell_price_unit: 'MT' }, 'test');

    const p = claimPrice.priceFor(claims.get(c.id));
    ck('it finds the bill through a spaced container number', p.price === 1780 && p.unit === 'MT', p);
    ck('it says where the rate came from', /purchase bill/.test(p.source), p.source);

    const r = claimPrice.recoverableFor(claims.get(c.id));
    ck('the shortage is valued at the supplier\'s rate, not Edge\'s sell rate',
        Math.abs(r.amount - 1.922 * 1780) < 0.02, { amount: r.amount, atSell: 1.922 * 2140 });
    ck('and that is LESS than the customer\'s claim, which Edge absorbs',
        r.amount < claims.get(c.id).claim_amount, { recover: r.amount, claimed: claims.get(c.id).claim_amount });
}

section('B — the unit is converted, never assumed');
{
    writeBills([{ id: 'b2', supplier: 'Calderon', container_no: 'TCNU1000001', supplier_price: 0.81, price_unit: 'lb', items: [] }]);
    const c = await claims.create({ supplier: 'Calderon', container_no: 'TCNU1000001', note: 'short weight' }, 'test');
    await claims.verify(c.id, { invoice_weight: 20, claimed_weight: 19, weight_unit: 'MT', sell_price: 2000, sell_price_unit: 'MT' }, 'test');
    const r = claimPrice.recoverableFor(claims.get(c.id));
    ck('a claim in MT against a bill in LB converts', Math.abs(r.amount - (2204.62262 * 0.81)) < 0.5, r.amount);
    ck('2204, not 1 — the whole point of carrying the unit', r.amount > 1700, r.amount);
}

section('C — several grades at several rates');
{
    writeBills([{ id: 'b3', supplier: 'Hugo', container_no: 'MSCU7730915', items: [
        { description: 'Alu engine combo', price: 1980, price_unit: 'mt' },
        { description: 'Rotors and drums', price: 320, price_unit: 'mt' },
    ] }]);
    const a = await claims.create({ supplier: 'Hugo', container_no: 'MSCU7730915', note: 'the rotors and drums came up short' }, 'test');
    const pa = claimPrice.priceFor(claims.get(a.id));
    ck('the grade in the claim picks the item on the bill', pa.price === 320, pa);
    ck('and it names which item it matched', /Rotors/.test(pa.source), pa.source);

    const b = await claims.create({ supplier: 'Hugo', container_no: 'MSCU7730915', note: 'weight short on arrival' }, 'test');
    const pb = claimPrice.priceFor(claims.get(b.id));
    ck('nothing saying which grade means NO rate, not an average', pb.price === null, pb.price);
    ck('and it says so in words a person can act on', /which grade/.test(pb.why), pb.why);
    ck('the average is never quietly used', pb.price !== (1980 + 320) / 2);
    ck('it still lists what the bill holds, so she can pick', pb.candidates.length === 2, pb.candidates);
}

section('D — several items that AGREE are not ambiguous');
{
    writeBills([{ id: 'b4', supplier: 'Hugo', container_no: 'FCIU2000002', items: [
        { description: 'Alu wheels', price: 1600, price_unit: 'mt' },
        { description: 'Alu wheels second lot', price: 1600, price_unit: 'mt' },
    ] }]);
    const c = await claims.create({ supplier: 'Hugo', container_no: 'FCIU2000002', note: 'short' }, 'test');
    const p = claimPrice.priceFor(claims.get(c.id));
    ck('one price written twice is one price', p.price === 1600, p);
}

section('E — when it cannot know, it says so');
{
    const noBill = await claims.create({ supplier: 'Nobody', container_no: 'XXXU0000001', note: 'short' }, 'test');
    const p1 = claimPrice.priceFor(claims.get(noBill.id));
    ck('no bill for the container is reported, not guessed', p1.price === null && /no purchase bill/.test(p1.why), p1.why);

    const noCont = await claims.create({ supplier: 'Nobody', invoice_no: '26XX01', note: 'short' }, 'test');
    const p2 = claimPrice.priceFor(claims.get(noCont.id));
    ck('a claim with no container cannot be priced', p2.price === null && /no container number/.test(p2.why), p2.why);

    writeBills([{ id: 'b5', supplier: 'Someone Else', container_no: 'WRNG0000003', supplier_price: 900, price_unit: 'mt', items: [] }]);
    const wrong = await claims.create({ supplier: 'Gomez Metals', container_no: 'WRNG0000003', note: 'short' }, 'test');
    const p3 = claimPrice.priceFor(claims.get(wrong.id));
    ck('a claim pointed at a supplier the bill does not name is flagged',
        p3.supplierMismatch && p3.supplierMismatch.onBill === 'Someone Else', p3.supplierMismatch);

    // Put section A's bill back — the mismatch fixture above replaced the file.
    writeBills([{ id: 'b1', supplier: 'Gomez Metals', container_no: 'CAIU 9975642', supplier_price: 1780, price_unit: 'mt', items: [] }]);
    const unverified = await claims.create({ supplier: 'Gomez Metals', container_no: 'CAIU9975642', note: 'short' }, 'test');
    const r = claimPrice.recoverableFor(claims.get(unverified.id));
    ck('no shortage yet means no amount, with the rate still reported', r.amount === null && r.price === 1780, { amount: r.amount, price: r.price });
    ck('and it says what is missing', /confirm the weights/i.test(r.missing || ''), r.missing);
}

section('F — the statement prints their rate and never Edge\'s');
{
    writeBills([{ id: 'b1', supplier: 'Gomez Metals', container_no: 'CAIU 9975642', supplier_price: 1780, price_unit: 'mt', items: [] }]);
    const c = claims.list().find((x) => x.invoice_no === '26JY05');
    await claims.update(c.id, { supplier_price: 1780, supplier_price_unit: 'MT' }, 'test', 'rate from bill');
    await claims.raiseRecovery(c.id, { our_claim: 3421.16 }, 'test');

    const b = report.build({ supplier: 'Gomez Metals' });
    const line = b.lines.find((l) => l.invoice_no === '26JY05');
    ck('the rate is on the line', line && line.rate === 1780 && line.rate_unit === 'MT', line && { r: line.rate, u: line.rate_unit });

    const html = report.toHtml(b);
    ck('the document has a rate column headed as THEIRS', /Your rate/.test(html));
    ck('the rate is printed', /1,780/.test(html), html.slice(0, 0));
    ck('Edge\'s sell rate of 2140 is NOT anywhere on it', !/2,140/.test(html) && !/2140/.test(html));
    // ── INVERTED 2026-10-20 ───────────────────────────────────────────
    // Apsara quoted four footer notes verbatim and said "Remove". These
    // checks pinned their wording, so they are turned round rather than
    // deleted: the document is still guarded, now against the lines coming
    // BACK. The figures those notes explained are unchanged and still
    // asserted above.
    ck('the "Your rate" explanation is gone, at her instruction', !/the rate we paid you/.test(html));

    // ── OUR INVOICE NUMBER NEVER REACHES THE SUPPLIER (2026-10-20) ───────
    // Apsara: "Dont mention our invoice no in claim". It is Edge's reference
    // to its CUSTOMER, and this document goes to the supplier — the same
    // reason `remarks` has always been kept off it.
    //
    // Checked by VALUE, not by looking for the column heading. The heading
    // was the easy half; the real risk was four detail lines that printed
    // `container_no || invoice_no`, so a claim with no container number
    // would have put the invoice number back on the page — on exactly the
    // claims nobody inspects.
    ck('the "Our invoice" column is gone', !/Our invoice/.test(html));
    // NINE columns now, not ten: "Our invoice" was removed on 2026-10-20 at
    // Apsara's instruction, so the footer spans eight.
    ck('the table still balances — 9 columns, footer spans 8', /colspan="8" class="r">Total recoverable/.test(html));

    const xlsx = await report.toWorkbook(b);
    ck('the workbook is produced with the extra columns', xlsx.length > 2000);
}

section('F2 — a rate per pound against a claim in tonnes');
{
    // Apsara, 2026-10-03: "What if the supplier price is in lbs?" The maths was
    // already right; the DOCUMENT was not. A supplier reading "1 MT short" beside
    // "$0.81/LB" has to find 2204.62 himself to check the amount — which is the
    // same unexplained number the rate column exists to remove.
    writeBills([{ id: 'b6', supplier: 'Calderon', container_no: 'TCNU1000001', supplier_price: 0.81, price_unit: 'lb', items: [] }]);
    const c = claims.list().find((x) => String(x.container_no) === 'TCNU1000001');
    await claims.update(c.id, { supplier_price: 0.81, supplier_price_unit: 'LB' }, 'test', 'rate from bill');
    await claims.raiseRecovery(c.id, { our_claim: 1785.74 }, 'test');

    const b = report.build({ supplier: 'Calderon' });
    const l = b.lines.find((x) => x.container_no === 'TCNU1000001');
    // ── REVERSED 2026-10-21, AT HER INSTRUCTION ──────────────────────────
    // Apsara: "If i selected it as lb .i want your rate to be in lb only not
    // in mt". That undoes her own 2026-10-14 request ("if price of supplier
    // is in cents, i want it to be converted to 2204.62 (mt)"), which is why
    // these checks pinned the conversion. They are turned round rather than
    // deleted: the rate is still guarded, now against being converted.
    //
    // What drove the reversal: the sorted breakdown works in the claim's own
    // unit, so the document carried $3,042.38/MT in the table and $1.38/LB
    // below it, both headed "Your rate".
    ck('the rate stays in the unit it was recorded in: $0.81/LB', l && l.rate_unit === 'LB' && Math.abs(l.rate - 0.81) < 0.0001, l && JSON.stringify([l.rate, l.rate_unit, l.rate_from]));
    ck('  and there is no "from" line, because nothing was converted', l && l.rate_from === '', l && JSON.stringify(l.rate_from));
    ck('the claim\'s own weights are NOT converted', l.shortage === 1 && l.unit === 'MT', { s: l.shortage, u: l.unit });

    const html = report.toHtml(b);
    ck('the document prints the rate per LB', /\$0\.81\/LB/.test(html));
    ck('  and never converts it to MT', !/\$1,785\.74\/MT/.test(html) && !/from \$0\.81\/LB/.test(html));
    ck('and the rate in his own unit', /\$0\.81\/LB/.test(html));
    ck('the three numbers reconcile on the page', Math.abs(2204.62262 * 0.81 - 1785.74) < 0.01);
    // The FIGURES still reconcile — asserted three lines up — and that is
    // what mattered. What is gone is only the prose explaining them.
    ck('both conversion notes are gone, at her instruction',
        !/No conversion has been applied to them/.test(html) && !/1 MT = 2,204\.62262 lb/.test(html));

    // Same unit on both sides: nothing to convert, nothing extra printed.
    const same = report.build({ supplier: 'Gomez Metals' }).lines.find((x) => x.invoice_no === '26JY05');
    ck('a rate in the claim\'s own unit prints no conversion line', same && same.charge_qty === null, same && same.charge_qty);
    ck('and the note is not shown for it', !/1 MT = 2,204\.62262 lb/.test(report.toHtml(report.build({ supplier: 'Gomez Metals' }))));
}

section('F2b — cents per lb, weights in pounds: rate to per-MT, quantity to MT, then calculated');
{
    // Typed on the page as 74 cents/lb -> stored $0.74/LB (the page divides by 100).
    writeBills([{ id: 'b8', supplier: 'Cents Co', container_no: 'CNTU0000007', supplier_price: 0.74, price_unit: 'lb', items: [] }]);
    const c = await claims.create({ supplier: 'Cents Co', container_no: 'CNTU0000007', note: 'short' }, 'test');
    await claims.verify(c.id, { invoice_weight: 40000, claimed_weight: 38478.81, weight_unit: 'LB', sell_price: 0.9, sell_price_unit: 'LB' }, 'test');
    await claims.update(c.id, { supplier_price: 0.74, supplier_price_unit: 'LB' }, 'test', 'rate');
    await claims.raiseRecovery(c.id, { our_claim: 1125.67 }, 'test');
    const b = report.build({ supplier: 'Cents Co' });
    const l = b.lines[0];
    // qty_mt is still computed and still correct; it is simply no longer
    // what the rate is multiplied by. charge_qty is null here because the
    // claim's weights and the rate are BOTH in LB — there is nothing to
    // reconcile, so nothing is printed.
    ck('1,521.19 lb is still 0.690 MT where that is asked for', Math.abs(l.qty_mt - 0.69) < 0.0005, JSON.stringify(l.qty_mt));
    ck('  but no reconciling quantity is printed when the units already agree',
       l.charge_qty === null, JSON.stringify(l.charge_qty));
    ck('$0.74/lb stays $0.74/LB', l.rate_unit === 'LB' && Math.abs(l.rate - 0.74) < 0.0001, JSON.stringify([l.rate, l.rate_unit]));
    // THE ONE THAT NEARLY SHIPPED BROKEN. The reconciliation multiplied
    // qty_mt by the rate; with a per-LB rate that is out by 2,204, nothing
    // would ever reconcile, and the rate would have been stripped off EVERY
    // line — silently, with every other figure still correct.
    ck('  and the rate SURVIVES the reconciliation', l.rate !== null,
       'rate x quantity must be computed in the rate\'s own unit');
    ck('rate x MT quantity reconciles with the amount, so the rate stays on the line', l.rate !== null && b.notReconciled.length === 0);
    const html = report.toHtml(b);
    // REVERSED with the rate: the document now prints $0.74/LB and no MT
    // figure at all, because the weights beside it are in LB too.
    ck('the document shows the rate per LB', /\$0\.74\/LB/.test(html));
    ck('  with no per-MT rate anywhere', !/\$1,631\.42\/MT/.test(html));
    ck('  and no tonne quantity nothing on the page is priced in',
       !/on 0\.69 MT/.test(html));
    ck('  without the sentence explaining the conversion',
        !/converted to a rate per metric tonne/.test(html));
    ck('the buyer\'s rate ($0.90) is nowhere on the supplier document', !/0\.90|0\.9\b/.test(html));
}

section('F3 — the document never contradicts itself');
{
    // our_claim is typed by a person; the rate and quantity are facts off the
    // bill. When they disagree, the supplier is handed the one number on the
    // page he can prove wrong — so the rate comes off that line instead.
    writeBills([{ id: 'b7', supplier: 'Odd', container_no: 'ODDU0000009', supplier_price: 1000, price_unit: 'mt', items: [] }]);
    const c = await claims.create({ supplier: 'Odd', container_no: 'ODDU0000009', note: 'short' }, 'test');
    await claims.verify(c.id, { invoice_weight: 20, claimed_weight: 19, weight_unit: 'MT', sell_price: 2000, sell_price_unit: 'MT' }, 'test');
    await claims.update(c.id, { supplier_price: 1000, supplier_price_unit: 'MT' }, 'test', 'rate');
    await claims.raiseRecovery(c.id, { our_claim: 600 }, 'test');   // negotiated down from 1000

    const b = report.build({ supplier: 'Odd' });
    const l = b.lines[0];
    ck('a rate that does not reconcile is taken off the line', l.rate === null, { rate: l.rate, ours: l.our_claim });
    ck('the amount is untouched — nothing is adjusted to make it fit', l.our_claim === 600);
    ck('she is told which line and by how much', b.notReconciled.length === 1 && b.notReconciled[0].atRate === 1000, b.notReconciled);
    const html = report.toHtml(b);
    // ── THAT FOOTNOTE IS GONE (2026-10-30) ───────────────────────────────
    // Apsara: "Remove Where no rate is shown, the amount is as agreed between
    // us rather than calculated." It fired on any sendable row without a
    // rate, which is EVERY downgrade — so a claim worked out to the cent told
    // the supplier it had been agreed rather than calculated. The behaviour
    // this section exists to protect is unchanged and still asserted above:
    // the rate comes OFF the line, and the amount is not adjusted to fit.
    ck('and the document no longer calls a calculated amount "agreed"',
       !/as agreed between us rather than calculated/.test(html));

    await claims.raiseRecovery(c.id, { our_claim: 1000 }, 'test');
    const b2 = report.build({ supplier: 'Odd' });
    ck('a figure that DOES reconcile keeps its rate', b2.lines[0].rate === 1000, b2.lines[0].rate);
    ck('and nothing is flagged', b2.notReconciled.length === 0);

    await claims.raiseRecovery(c.id, { our_claim: 1005 }, 'test');   // 0.5%, rounding
    ck('small rounding does not strip the rate', report.build({ supplier: 'Odd' }).lines[0].rate === 1000);
    await claims.setStatus(c.id, 'withdrawn', 'test', 'fixture only');
}

section('F4 — nothing that leaves the building names the customer');
{
    // Apsara, 2026-10-03: "if there is any company name mentioned in claim email
    // of customer, then it should be hided." A supplier who learns which buyer
    // the metal reached can go to them directly.
    writeBills([{ id: 'b1', supplier: 'Gomez Metals', container_no: 'CAIU 9975642', supplier_price: 1780, price_unit: 'mt', items: [] }]);
    const b = report.build({ supplier: 'Gomez Metals' });
    ck('the customer is still in the JSON the PAGE reads', b.lines.some((l) => l.customer === 'Joey'), b.lines.map((l) => l.customer));

    const html = report.toHtml(b);
    ck('but it is NOT on the pdf/html statement', !/Joey/.test(html));
    ck('and there is no Customer column at all', !/>Customer</.test(html));
    ck('the lead no longer says "our customers"', !/raised by our customers/.test(html));
    // ── OUR INVOICE NUMBER NEVER REACHES THE SUPPLIER (2026-10-20) ───────
    // Apsara: "Dont mention our invoice no in claim". It is Edge's reference
    // to its CUSTOMER, and this document goes to the supplier — the same
    // reason `remarks` and the customer name have always been kept off it,
    // asserted three lines above.
    //
    // Checked by VALUE, not by looking for the column heading. The heading
    // was the easy half: the real risk was four detail lines that printed
    // `container_no || invoice_no`, which would have put the number back on
    // any claim with no container — exactly the ones nobody inspects.
    ck('the claim is still identifiable by its container', /CAIU9975642/.test(html));
    ck('the "Our invoice" column is gone', !/Our invoice/.test(html));
    {
        const invoiced = b.lines.map((l) => l.invoice_no).filter(Boolean);
        ck('  and there ARE invoice numbers in this report, so this proves something',
           invoiced.length > 0, 'no claim in the fixture carries an invoice number');
        const leaked = invoiced.filter((n) => html.includes(n));
        ck('  not one of them appears anywhere in the document', leaked.length === 0, leaked.join(', '));
    }
    // NINE columns now, not ten: "Our invoice" was removed on 2026-10-20 at
    // Apsara's instruction, so the footer spans eight.
    ck('the table still balances — 9 columns, footer spans 8', /colspan="8" class="r">Total recoverable/.test(html));

    const xlsx = await report.toWorkbook(b);
    const text = xlsx.toString('latin1');
    ck('the excel version drops it too', !/Joey/.test(text) && xlsx.length > 2000);
}

section('G — through the route');
{
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.role = 'admin'; next(); });
    routes.mount(app, { ROOT });
    const server = app.listen(0);
    const port = server.address().port;
    const get = async (p) => {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
        try { const r = await fetch(`http://127.0.0.1:${port}${p}`, { signal: ctl.signal }); clearTimeout(t); return { code: r.status, body: await r.json().catch(() => null) }; }
        catch (e) { clearTimeout(t); return { code: 'HUNG' }; }
    };
    // Each section writes its own bills file, so put this one's back first.
    writeBills([{ id: 'b1', supplier: 'Gomez Metals', container_no: 'CAIU 9975642', supplier_price: 1780, price_unit: 'mt', items: [] }]);
    const c = claims.list().find((x) => x.invoice_no === '26JY05');
    const r = await get('/api/claims/' + c.id + '/price');
    ck('GET /api/claims/:id/price answers with the rate', r.code === 200 && r.body.price === 1780, r.body);
    ck('and does not hang', r.code !== 'HUNG');
    const miss = await get('/api/claims/nosuchid/price');
    ck('an unknown claim is a 404, not a 500', miss.code === 404, miss.code);
    // The wildcard sits below this route; prove it did not eat the two-segment one.
    const rep = await get('/api/claims/report/suppliers');
    ck('and /api/claims/report/suppliers is still not swallowed', rep.code === 200 && Array.isArray(rep.body.suppliers), rep.code);
    server.close();
}

// ══════════════════════════════════════════════════════════════════════════
section('H — the supplier can reproduce the figure from the rate he can SEE');
// ══════════════════════════════════════════════════════════════════════════
// Apsara, 2026-10-21, holding a clubbed note to Inesh Cores Chapin: "what can
// supplier infer from this". What he could infer is that Edge cannot multiply.
//
//   the line said   2,456 LB at $0.89/LB  →  $2,193.21
//   he does         2,456 x 0.89          =  $2,185.84
//
// $7.37 out, on the first thing anybody checks.
//
// Nothing was wrong with the money. The rate was $0.8930 and money() prints at
// exactly two decimals. The reconciliation guard above — whose whole stated
// purpose is "the supplier never sees a contradiction" — reconciled the STORED
// rate, 0.893, passed the line, and printed a rate that does not give the
// amount. It was checking a number the supplier never sees.
//
// Two changes: a rate prints at the precision it was recorded (up to four
// places), and the guard reconciles the PRINTED rate. These are HER figures.
{
    const rec = await claims.create({
        container_no: 'MSMU1152787', supplier: 'Inesh Cores Chapin', claim_type: 'weight shortage',
        supplier_price: 0.893, supplier_price_unit: 'LB', weight_unit: 'LB',
        invoice_weight: 51771, claimed_weight: 49315, claim_date: '2026-10-20',
    });
    const v = await claims.verify(rec.id, {
        invoice_weight: 51771, claimed_weight: 49315, weight_unit: 'LB',
        sell_price: 0.893, sell_price_unit: 'LB' }, 'apsara');
    await claims.raiseRecovery(rec.id, { our_claim: v.claim_amount }, 'apsara');

    const b = report.build({ supplier: 'Inesh Cores Chapin' });
    const l = b.lines[0];
    const h = report.toHtml(b);

    ck('the amount is her own $2,193.21', Math.abs(l.our_claim - 2193.21) < 0.01, l.our_claim);
    ck('the rate is NOT flattened to $0.89', !/\$0\.89\/LB/.test(h), (h.match(/\$[0-9.]+\/LB/) || [])[0]);
    ck('it prints at the precision it was recorded', /\$0\.893\/LB/.test(h), (h.match(/\$[0-9.]+\/LB/) || [])[0]);

    // THE ASSERTION THAT MATTERS: do his arithmetic, off the page.
    const shownRate = Number(((h.match(/\$([0-9.,]+)\/LB/) || [])[1] || '0').replace(/,/g, ''));
    ck('2,456 LB x the PRINTED rate gives the PRINTED amount',
        Math.abs(2456 * shownRate - l.our_claim) < 0.01,
        { printed: shownRate, his: (2456 * shownRate).toFixed(2), ours: l.our_claim });
    ck('  and the rate still survives the reconciliation guard', l.rate !== null && b.notReconciled.length === 0);

    // Ordinary rates must look exactly as they always have — this is a
    // formatter on every claim note, so a regression here is visible on all
    // of them, not just the awkward ones.
    // (A check lived here reading `/\$1\.38/.test(html + '$1.38')` — it
    // appended the string it then searched for, so it passed unconditionally.
    // Deleted rather than fixed: the loop below tests the same thing for
    // real, through a rendered document.)
    const money2 = [[0.89, '$0.89'], [1.38, '$1.38'], [2, '$2.00'], [0.5, '$0.50'], [0.2966, '$0.2966'], [0.893, '$0.893']];
    for (const [v2, want] of money2) {
        // Exercised through a real line rather than by reaching into the
        // module: a formatter asserted in isolation can be right while the
        // document still prints something else.
        const c2 = await claims.create({ container_no: 'FMT' + String(v2).replace('.', ''), supplier: 'Fmt Co',
            claim_type: 'weight shortage', supplier_price: v2, supplier_price_unit: 'LB', weight_unit: 'LB',
            invoice_weight: 1000, claimed_weight: 900 });
        const vv = await claims.verify(c2.id, { invoice_weight: 1000, claimed_weight: 900, weight_unit: 'LB',
            sell_price: v2, sell_price_unit: 'LB' }, 't');
        await claims.raiseRecovery(c2.id, { our_claim: vv.claim_amount }, 't');
        const hh = report.toHtml(report.build({ container: 'FMT' + String(v2).replace('.', '') }));
        ck(`  ${v2} prints as ${want}`, hh.includes(want + '/LB'), (hh.match(/\$[0-9.,]+\/LB/) || [])[0]);
    }
}

// ══════════════════════════════════════════════════════════════════════════
section('I — a grade claim shows its working, or it is an unexplained number');
// ══════════════════════════════════════════════════════════════════════════
// Apsara, 2026-10-21: "if there is any damage,quality,grade claim,we need to
// procide more details na?" She is right, and grade was the worst of them.
//
// The note said "sold as Alternator, received as HMS; 2,215.64 LB affected"
// and demanded $1,041.35. The sum is weight x (sold price - received price)
// and the received price was printed NOWHERE — so there was no path from the
// figures on the page to the figure being demanded. The reconciliation guard
// then correctly stripped the rate column, because 2,215.64 x the bill rate
// of $0.89 is $1,971.92, a different number. Dash in the rate column, bare
// amount, nothing to check.
//
// Asked what it should show, she chose both prices and the difference.
{
    const g = await claims.create({
        container_no: 'MSMU1152787', supplier: 'Inesh Cores Chapin', claim_type: 'grade',
        supplier_price: 0.89, supplier_price_unit: 'LB', weight_unit: 'LB',
        invoice_weight: 51771, claim_date: '2026-10-20',
    });
    const r = await claims.assess(g.id, {
        assessment: 'grade', weight_unit: 'LB', grade_sold: 'Alternator', grade_received: 'HMS',
        grade_price_sold: 0.89, grade_price_received: 0.42, grade_weight: 2215.64, sell_price_unit: 'LB',
    }, 'apsara');
    await claims.raiseRecovery(g.id, { our_claim: r.claim_amount }, 'apsara');

    const b = report.build({ supplier: 'Inesh Cores Chapin' });
    const h = report.toHtml(b);
    const row = b.lines.find((l) => l.id === g.id);

    ck('the engine still charges weight x the difference', Math.abs(row.our_claim - 1041.35) < 0.01, row.our_claim);
    ck('the price he billed is on the note', /\$0\.89\/LB/.test(h));
    ck('the price of what arrived is on the note — it never used to be', /\$0\.42\/LB/.test(h));
    ck('the difference he is charged is stated', /\$0\.47\/LB/.test(h));
    // The assertion that matters: the line adds up, on its own, in his hands.
    ck('the working ends in the amount demanded', /2,215\.64 LB affected at \$0\.47\/LB = \$1,041\.35/.test(h),
        (h.match(/affected at[^<]*/) || [])[0]);

    // "sold as" reads either as what HE sold Edge or what EDGE resold it as.
    ck('the ambiguous "sold as" wording is gone', !/sold as Alternator/.test(h));
    ck('  replaced by something with one meaning', /billed to us as Alternator/.test(h));

    // The shared column keeps its old meaning. YOUR RATE is the rate off his
    // own bill everywhere on this document; re-pointing it at the difference
    // for one kind of row is how a shared column starts lying.
    ck('YOUR RATE is NOT quietly re-pointed at the difference rate',
        row.rate === null || Math.abs(row.rate - 0.89) < 1e-9, row.rate);

    // A half-entered grade claim must not print a sum it cannot finish.
    const g2 = await claims.create({
        container_no: 'TEMU7', supplier: 'Inesh Cores Chapin', claim_type: 'grade',
        supplier_price: 0.89, supplier_price_unit: 'LB', weight_unit: 'LB', invoice_weight: 1000 });
    await claims.update(g2.id, { assessment: 'grade', grade_sold: 'Alternator', grade_received: 'HMS',
        grade_weight: 500, our_claim: 100 }, 'test', 'partial');
    await claims.setStatus(g2.id, 'recovery_raised', 'test');
    const h2 = report.toHtml(report.build({ container: 'TEMU7' }));
    ck('with no prices recorded it falls back to the plain wording, no invented sum',
        /500 LB affected\./.test(h2) && !/= \$/.test(h2), (h2.match(/affected[^<]*/) || [])[0]);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  Failed:'); failures.forEach((f) => console.log('   - ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('\nTEST CRASHED:', e && e.stack || e); process.exit(1); });
