// ── tests/yard-documents.js ─────────────────────────────────────────────────
// The 2026-08-24 document work. Everything here can put a WRONG NUMBER IN
// FRONT OF A CUSTOMER, which is why each case is one that actually happened or
// was one step away:
//   • a per-lot price used as a per-tonne rate ($2,420 -> a $101,640 invoice)
//   • a quantity invented because the email didn't state one
//   • the sender's name used as the buying company (Joey instead of Daekwang)
//   • a sale ticket that says "Seller" or carries a signature line
//
// Puppeteer can't run here (no ARM64 Chrome), so the PDF assertions stub the
// browser and inspect the HTML the generator produces. That covers every
// templating decision; only "Chrome turns finished HTML into a PDF" is
// untested, and that is generic.
const fs = require('fs');
const assert = require('assert');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failures.push(n); console.log('  FAIL  ' + n); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const { toProformaDraft, applyStandardQuantities } = require('../helpers/proformaFromEmail');

section('A — a price is only used when we know what it is a price OF');
{
    const base = { is_order: true, confidence: 0.9, consignee: 'Daekwang', container_count: 2, missing: [] };
    const perMt = toProformaDraft({ ...base,
        items: [{ desc: 'auto casting tense', qty: 21, rate: 2420, rate_confidence: 0.95, rate_basis: 'per_mt' }] });
    ck('a confident per-MT rate is used', perMt.items[0].rate === 2420);
    ck('and nothing is missing', perMt.needs.length === 0);

    // The live case: same figure, but it reads as a total for the lot.
    const perLot = toProformaDraft({ ...base,
        items: [{ desc: 'auto casting tense', qty: 21, rate: 2420, rate_confidence: 0.9, rate_basis: 'per_lot' }] });
    ck('a LOT total is refused as a rate', perLot.items[0].rate === 0);
    ck('and it stops rather than generating', perLot.needs.includes('rate'));
    ck('and says why, in words', /total for the lot/.test(perLot.unconfirmed.join(' ')));

    const unknown = toProformaDraft({ ...base,
        items: [{ desc: 'auto casting tense', qty: 21, rate: 2420, rate_confidence: 0.95, rate_basis: 'unknown' }] });
    ck('an unstated basis is refused too', unknown.needs.includes('rate'));

    const shaky = toProformaDraft({ ...base,
        items: [{ desc: 'auto casting tense', qty: 21, rate: 2420, rate_confidence: 0.4, rate_basis: 'per_mt' }] });
    ck('a per-MT rate we are unsure of is still refused', shaky.needs.includes('rate'));
}

section('B — quantities are loaded by rule, never invented');
{
    ck('auto cast alone is a full 21 MT container',
        applyStandardQuantities([{ desc: 'auto cast' }])[0].qty === 21);
    ck('so is the same material written longhand',
        applyStandardQuantities([{ desc: 'auto casting tense' }])[0].qty === 21);
    const pair = applyStandardQuantities([{ desc: 'Al combo' }, { desc: 'Regular combo' }]);
    ck('the combo pair loads 13 MT of aluminium', pair[0].qty === 13);
    ck('and 9 MT of regular', pair[1].qty === 9);
    ck('steel combo counts as the regular half',
        applyStandardQuantities([{ desc: 'Aluminium combo' }, { desc: 'Steel combo' }])[1].qty === 9);
    ck('aluminium combo ALONE gets no assumed weight',
        applyStandardQuantities([{ desc: 'Al combo' }])[0].qty === null);
    ck('auto cast sharing a container is not the 21 MT pattern',
        applyStandardQuantities([{ desc: 'auto cast' }, { desc: 'Al combo' }])[0].qty === null);
    ck('an unknown material gets nothing',
        applyStandardQuantities([{ desc: 'Chrome' }])[0].qty === null);
    ck('a stated quantity is never overwritten',
        applyStandardQuantities([{ desc: 'auto cast', qty: 18 }])[0].qty === 18);
    ck('an assumed quantity is FLAGGED as assumed',
        applyStandardQuantities([{ desc: 'auto cast' }])[0].qty_assumed === true);
    ck('a stated one is not', applyStandardQuantities([{ desc: 'auto cast', qty: 18 }])[0].qty_assumed === false);

    const noQty = toProformaDraft({ is_order: true, confidence: 0.9, consignee: 'X', container_count: 1, missing: [],
        items: [{ desc: 'Chrome', qty: null, rate: 300, rate_confidence: 0.95, rate_basis: 'per_mt' }] });
    ck('an unknown quantity stops the draft', noQty.needs.includes('quantity'));
    ck('rather than defaulting to 21', noQty.items[0].qty === null);
}

section('C — the sender is not the buyer');
{
    const noConsignee = toProformaDraft(
        { is_order: true, confidence: 0.9, consignee: null, container_count: 1, missing: [],
          items: [{ desc: 'auto cast', qty: 21, rate: 2400, rate_confidence: 0.95, rate_basis: 'per_mt' }] },
        { fallbackConsignee: 'Joey' });
    ck('an unnamed buyer stops the draft', noConsignee.needs.includes('consignee'));
    ck('the sender is NOT silently used as the consignee', noConsignee.consignee === '');
    ck('but is offered as a hint for the question', noConsignee.sender_hint === 'Joey');

    const named = toProformaDraft(
        { is_order: true, confidence: 0.9, consignee: 'Daekwang', container_count: 1, missing: [],
          items: [{ desc: 'auto cast', qty: 21, rate: 2400, rate_confidence: 0.95, rate_basis: 'per_mt' }] },
        { fallbackConsignee: 'Joey' });
    ck('a named buyer is used, not the sender', named.consignee === 'Daekwang');
    ck('and the draft proceeds', named.needs.length === 0);

    // The model over-claiming must not block a draft we can see is complete.
    const overclaim = toProformaDraft(
        { is_order: true, confidence: 0.9, consignee: 'Daekwang', container_count: 1,
          missing: ['material', 'consignee'],
          items: [{ desc: 'auto cast', qty: 21, rate: 2400, rate_confidence: 0.95, rate_basis: 'per_mt' }] },
        { fallbackConsignee: 'Joey' });
    ck('a model claim never overrides evidence we hold', overclaim.needs.length === 0);
}

section('D — the documents themselves');
{
    // helpers/pdf.js uses PDFKIT, not puppeteer — these render for real and
    // are read back with pdftotext. (An earlier version of this test stubbed
    // puppeteer and captured nothing, which is exactly the sort of test that
    // passes while asserting nothing.)
    const { execFileSync } = require('child_process');
    const os = require('os');
    const pdf = require('../helpers/pdf');
    const readPdf = (buf) => {
        const f = path.join(os.tmpdir(), `yt_${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`);
        fs.writeFileSync(f, buf);
        try { return execFileSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8' }); }
        finally { fs.unlinkSync(f); }
    };

    const rec = { id: 'T1', date: '2026-08-24', created_at: '2026-08-24T10:00:00Z',
        seller: 'Daekwang Metal Co., Ltd', seller_address: 'TAEWON METAL\n55 Industrial Road\nBusan',
        description: 'Auto casting tense', weight_unit: 'lb',
        gross_weight: 8100, tare_weight: 100, net_weight: 8000, amount: 6800,
        items: [{ description: 'Auto casting tense', gross_weight: 8100, tare_weight: 100, net_weight: 8000, price: 0.85, amount: 6800 }] };

    return (async () => {
        const sale = readPdf(await pdf.generateLoadPdf(rec, { kind: 'sale' }));
        ck('a sale is titled a SALE TICKET', /SALE TICKET/i.test(sale));
        ck('and names the BUYER', /Buyer:/.test(sale));
        ck('not a seller', !/Seller:/.test(sale));
        ck('a sale carries NO signature line — "no sign needed"', !/signature/i.test(sale));
        ck('the figures are still right', /8000/.test(sale) && /6,800\.00/.test(sale));

        const purchase = readPdf(await pdf.generateLoadPdf({ ...rec, id: 'P1' }, {}));
        ck('a purchase is still a LOAD TICKET', /LOAD TICKET/i.test(purchase));
        ck('and still names the SELLER', /Seller:/.test(purchase));
        ck('and KEEPS its signature line', /Seller signature/i.test(purchase));

        // Letterhead, tightened 2026-08-22.
        ck('the company address is one line', /2453 E 25th Street, Los Angeles, CA 90058/.test(purchase));
        ck('phone and email share a line', /\(310\) 938-2525\s*·\s*bose@edgemetals\.com/.test(purchase));
        ck('seller and address sit on the same row', /Seller:.*Address:/.test(purchase));
        ck('description is on one line, not wrapped in a half column',
            /Description:\s*Auto casting tense/.test(purchase));

        const receipt = readPdf(await pdf.generateLoadReceiptPdf(rec, { kind: 'sale' }));
        ck('the POS receipt says Buyer on a sale', /Buyer:/.test(receipt));
        ck('and the purchase receipt still says Seller',
            /Seller:/.test(readPdf(await pdf.generateLoadReceiptPdf(rec, {}))));

        section('E — the nightly yard report');
        {
            const { buildYardReportText } = require('../scheduler');
            const quiet = buildYardReportText('2026-08-23', [], []);
            ck('a quiet day is short', quiet.split('\n').length <= 4);
            ck('and says nothing happened', /No loads recorded today/.test(quiet));
            ck('with NO spreadsheet links', !/https?:\/\//.test(quiet));
            ck('and no claim of an attachment that does not exist', !/attached/i.test(quiet));

            const busy = buildYardReportText('2026-08-24', [
                { id: 'EDGE_26', seller: 'Ramesh', net_weight: 4110, amount: 2466, weight_unit: 'lb',
                  gross_weight: 4210, tare_weight: 100, items: [] }], []);
            ck('a busy day lists the loads', /EDGE_26/.test(busy));
            ck('with money to two decimals', /\$2,466\.00/.test(busy));
            ck('and totals', /Totals/.test(busy));
        }

        console.log('\n================================================================');
        console.log(`${pass} passed, ${fail} failed`);
        if (fail) { console.log('\nFAILED:'); failures.forEach((f) => console.log('  - ' + f)); }
        process.exit(fail ? 1 : 0);
    })();
}
