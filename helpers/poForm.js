// ── helpers/poForm.js — a Purchase Order from the phone app's PO tab ──────
// Apsara, 2026-11-17: the PO tab beside BOL in the Edge Yard app — "same as
// the website", "no, just generate the PDF". The app sends what was typed; the
// arithmetic, the checks and the sheet are all here, so the phone cannot print
// a different PO from the website (helpers/poSheet.js is the website's sheet).
// The rules below are the website's poCollect/poProblems, line for line.
const S = require('./poSheet');

const UNITS = ['MT', 'LB', 'KG', 'Gross ton', 'PCS', 'Container'];
const DELIVER_LABELS = { 'edge-trading-chase': 'Edge Yard', 'edge-metals-bofa': 'Edge Metals' };
const DEFAULT_SIGNER = 'Chandra Bose';

// "$1,234.50" -> 1234.5, blank/junk -> null. Same strip as the website.
function num(v) {
    const s = String(v == null ? '' : v).replace(/[$,\s]/g, '');
    if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}
const cents = (n) => Math.round(Number((n * 100).toPrecision(12)));

// ISO (from <input type=date>) or MM/DD/YYYY -> {iso, us}, or null.
function parseDate(v) {
    const s = String(v || '').trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    let y; let mo; let d;
    if (m) { [, y, mo, d] = m; } else {
        m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
        if (!m) return null;
        [, mo, d, y] = m; if (y.length === 2) y = String(2000 + Number(y));
    }
    const mi = Number(mo); const di = Number(d);
    if (mi < 1 || mi > 12 || di < 1 || di > 31) return null;
    const dt = new Date(Date.UTC(Number(y), mi - 1, di));
    if (dt.getUTCMonth() !== mi - 1) return null;
    const p2 = (n) => String(n).padStart(2, '0');
    return { iso: `${y}-${p2(mi)}-${p2(di)}`, us: `${p2(mi)}/${p2(di)}/${y}` };
}

function deliverOptions(accounts) {
    return (accounts || []).map((a) => ({ id: a.id, label: DELIVER_LABELS[a.id] || a.company, address: a.address || '' }));
}

function buildPoFromForm(input, accounts, signatureUrl) {
    const f = input || {};
    const acct = (accounts || []).find((a) => a.id === f.company_id) || null;
    const two = !!f.two;
    const labelA = String(f.label_a || '').trim();
    const labelB = String(f.label_b || '').trim();
    const lines = [];
    (Array.isArray(f.lines) ? f.lines : []).forEach((l, i) => {
        const desc = String((l && l.desc) || '').trim();
        const qtyText = String((l && l.qty) == null ? '' : l.qty).trim();
        const priceText = String((l && l.price) == null ? '' : l.price).trim();
        const price2Text = two ? String((l && l.price2) == null ? '' : l.price2).trim() : '';
        if (!desc && !qtyText && !priceText && !price2Text) return;
        const qty = num(qtyText); const price = num(priceText); const price2 = two ? num(price2Text) : null;
        const ok = !!desc && qty !== null && qty > 0 && price !== null && price >= 0 && (!two || (price2 !== null && price2 >= 0));
        lines.push({
            n: i + 1, desc, qty, unit: UNITS.includes(l.unit) ? l.unit : UNITS[0], ok,
            price: price === null ? 0 : price, price2: price2 === null ? 0 : price2,
            amountCents: ok ? cents(qty * price) : 0,
            amount2Cents: ok && two ? cents(qty * price2) : 0,
        });
    });
    const otherText = String(f.other == null ? '' : f.other).trim();
    const other = otherText ? num(otherText) : 0;
    const otherCents = other === null ? 0 : cents(other);
    const sub = lines.reduce((s, l) => s + l.amountCents, 0);
    const sub2 = lines.reduce((s, l) => s + l.amount2Cents, 0);
    const date = parseDate(f.date);
    const required = String(f.required || '').trim() ? parseDate(f.required) : null;
    const company = acct ? acct.company : '';
    const signer = String(f.signer == null ? DEFAULT_SIGNER : f.signer).trim();
    const d = {
        company, companyAddress: acct ? (acct.address || '') : '', companyId: acct ? acct.id : '',
        supplier: String(f.supplier || '').trim(), supplierAddress: String(f.supplier_address || '').trim(),
        number: String(f.number || '').trim(), date: date ? date.us : String(f.date || '').trim(),
        required: required ? required.us : String(f.required || '').trim(),
        terms: String(f.terms || '').trim(), shipTo: String(f.ship_to || '').trim(),
        lines, otherText, otherBad: other === null, otherCents,
        notes: String(f.notes || '').trim(), signer,
        // His signature goes under his name, for Edge Metals, nowhere else.
        signatureImg: (signatureUrl && S.poIsEdgeMetals(company) && /chandra\s+bose/i.test(signer)) ? signatureUrl : '',
        subtotalCents: sub, totalCents: sub + otherCents, two, labelA, labelB,
        subtotal2Cents: sub2, total2Cents: sub2 + otherCents,
    };
    const p = [];
    if (!d.company) p.push('Choose which company is issuing this order.');
    else if (!d.companyAddress) p.push(d.company + ' has no address on the Bank tab, so the sheet would print without one.');
    if (!d.supplier) p.push('Enter the supplier.');
    if (!d.number) p.push('Enter a PO number.');
    if (!String(f.date || '').trim()) p.push('Enter the PO date.');
    else if (!date) p.push('The PO date is not a real date.');
    if (String(f.required || '').trim() && !required) p.push('"Required by" is not a real date.');
    if (d.otherBad) p.push('Freight / other charges is not a number.');
    if (!d.shipTo) p.push('Choose where the material is delivered.');
    if (!lines.length) p.push('Add at least one item.');
    lines.filter((l) => !l.ok).forEach((l) => p.push('Item ' + l.n + ' needs a description, a quantity above zero and a unit price.'));
    if (two && (!labelA || !labelB)) p.push('Name both price options (for example Clean and Dirty).');
    if (two && labelA && labelA.toLowerCase() === labelB.toLowerCase()) p.push('The two price options need different names.');
    if (d.totalCents < 0 || (two && d.total2Cents < 0)) p.push('The total is below zero.');
    return { d, problems: p, dateIso: date ? date.iso : null };
}

module.exports = { UNITS, DEFAULT_SIGNER, deliverOptions, buildPoFromForm, parseDate };
