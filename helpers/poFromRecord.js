// ── helpers/poFromRecord.js — a Purchase Order sheet's data, from a load or sale ──
// "Print PO" on a load or sale (Apsara, 2026-11-17: "for now print it in
// load/sale", phone app and website). Nothing is saved: this only reads the
// record and shapes what helpers/poSheet.js prints.
//
// PURCHASE load: the order is Edge Trading's (Edge Yard) to the seller —
//   issuer = the load's buyer (Edge Trading today), vendor = seller.
// SALE: a PO is the CUSTOMER's order, so it reads the other way round —
//   issuer = the sale's buyer, vendor = the sale's seller_company (Edge Trading by default). That mapping is MY call,
//   not hers; she can type another company/vendor on the website PO tab.
//
// Quantities are what the price multiplies (priceUnits.qtyFor), so a row
// priced per MT prints MT, per net ton prints Net ton. Line AMOUNTS are the
// record's own stored amounts, never recomputed from the rounded quantity.
const PU = require('./priceUnits');
const S = require('./poSheet');

const UNIT_TEXT = { lb: 'LB', nt: 'Net ton', gt: 'Gross ton', mt: 'MT', piece: 'PCS' };
const ENTITY = {
    'edge trading': { company: 'EDGE TRADING INC', id: 'edge-trading-chase' },
    'edge yard': { company: 'EDGE TRADING INC', id: 'edge-trading-chase' },
    'edge metals': { company: 'Edge Metals INC', id: 'edge-metals-bofa' },
};
const entityOf = (name) => ENTITY[require('./poNumbers').keyOf(name)] || null;
const usDate = (iso) => {
    const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[2]}/${m[3]}/${m[1]}` : '';
};
const cents = (n) => Math.round(Number((Number(n) * 100).toPrecision(12)));

// accounts: the Bank tab list ({id, company, address}). record: the load/sale.
function buildPoData(kind, record, accounts, opts = {}) {
    const acct = (id) => (accounts || []).find((a) => a.id === id) || null;
    const sale = kind === 'sale';
    const yard = acct('edge-trading-chase');
    let company; let companyAddress; let supplier; let supplierAddress; let shipTo;
    if (sale) {
        company = record.buyer || ''; companyAddress = record.buyer_address || '';
        // The company that SELLS: the sale's seller_company picker, Edge Trading
        // when it was never set (every sale before 2026-11-17). AAA Investment
        // has no Bank-tab account, so it prints by name with no address.
        const sc = require('./loadCompany').canon(record.seller_company) || 'Edge Trading';
        const se = entityOf(sc); const sa = se ? acct(se.id) : null;
        supplier = sa ? sa.company : (sc === 'Edge Trading' && yard ? yard.company : sc);
        supplierAddress = sa ? (sa.address || '') : '';
        shipTo = company ? company + (companyAddress ? '\n' + companyAddress : '') : '';
    } else {
        const e = entityOf(record.buyer || 'Edge Trading');
        const a = e ? acct(e.id) : null;
        company = a ? a.company : (record.buyer || 'EDGE TRADING INC');
        companyAddress = a ? (a.address || '') : (record.buyer_address || '');
        supplier = record.seller || ''; supplierAddress = record.seller_address || '';
        shipTo = (yard ? 'Edge Yard\n' + (yard.address || '') : '').trim();
    }
    const lines = [];
    (record.items || []).forEach((it, i) => {
        const unit = PU.normalise(it.unit) || 'lb';
        const qty = PU.qtyFor({ unit, net: it.net_weight, pieces: it.pieces });
        // A row with no price yet (null / blank) is not on the order; Number(null) would be 0.
        const price = (it.price == null || it.price === '') ? NaN : Number(it.price);
        if (!(qty > 0) || !Number.isFinite(price)) return;
        const amt = Number.isFinite(Number(it.amount)) ? cents(it.amount) : cents(qty * price);
        lines.push({ n: i + 1, desc: String(it.description || '').trim() || 'Material', qty, unit: UNIT_TEXT[unit],
            price, price2: 0, ok: true, amountCents: amt, amount2Cents: 0 });
    });
    const subtotalCents = lines.reduce((s, l) => s + l.amountCents, 0);
    const signer = opts.signer || 'Chandra Bose';
    const isEM = S.poIsEdgeMetals(company);
    return {
        company, companyAddress, supplier, supplierAddress, shipTo,
        number: opts.number || '', date: usDate(opts.dateIso || record.date) || usDate(new Date().toISOString()),
        required: '', terms: '', lines, otherCents: 0, otherText: '', notes: '', signer,
        signatureImg: (isEM && opts.signatureImg) ? opts.signatureImg : '',
        subtotalCents, totalCents: subtotalCents, two: false, labelA: '', labelB: '', subtotal2Cents: 0, total2Cents: 0,
    };
}

module.exports = { buildPoData, entityOf, UNIT_TEXT };
