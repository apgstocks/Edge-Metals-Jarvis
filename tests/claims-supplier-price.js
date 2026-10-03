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
    ck('it explains what the rate is', /the rate we paid you/.test(html));
    ck('the table still balances — 11 columns, footer spans 10', /colspan="10" class="r">Total recoverable/.test(html));

    const xlsx = await report.toWorkbook(b);
    ck('the workbook is produced with the extra columns', xlsx.length > 2000);
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

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  Failed:'); failures.forEach((f) => console.log('   - ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('\nTEST CRASHED:', e && e.stack || e); process.exit(1); });
