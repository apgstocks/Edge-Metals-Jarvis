// ── helpers/claimPrice.js — what the supplier's own price was ────────────────
//
// Apsara, 2026-10-03: "You didnt mention supplier price in claim?"
//
// She is right, and it was the hole in the statement. A claim carried one rate,
// `sell_price` — the rate Edge SOLD at, used to value what the customer is
// claiming. Printing that to a supplier hands them Edge's margin; printing the
// recoverable amount with no rate at all hands them nothing to check, and the
// first thing a supplier does with an unexplained number is query it.
//
// WHAT THIS DOES. Given a claim, it finds the purchase bill for that container
// — helpers/bills.js, "what a container of metal cost" — and reports the price
// Edge actually paid THAT supplier, per their own unit. Short weight times
// their own price is an arithmetic a supplier can reproduce and argue with on
// its merits, and it is the figure Apsara chose on 2026-10-03 when asked
// whether recovery is valued at the supplier's price or the customer's.
//
// WHAT IT REFUSES TO DO. A container's bill can hold several items at several
// prices, because a container is often several grades weighed separately
// (bills.js:74, her words: "what if i have multiple items in same container").
// Asked which item prices a claim, she chose: match by grade, flag if unclear.
// So when the grade does not match cleanly and the items disagree on price,
// this returns NO price and says why. It does not average them. bills.js
// already refuses to blend item prices — "not one blended price, which is the
// shortcut that makes a container" (bills.js:80) — and a blended rate on a
// document sent to a supplier is a number nobody can defend in a dispute.
//
// IT WRITES NOTHING. It is a lookup. The figure it suggests is filled into the
// recovery box for a person to accept, because what is recovered is settled by
// negotiation and not by this file.
const bills = require('./bills');
const claimKinds = require('./claimKinds');

const LB_PER_MT = 2204.62262;
const cont = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();
const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(String(v).replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : null; };

// Bills speak 'mt' and 'lb'; claims speak 'MT', 'LB' and 'KG'. One place to be
// wrong, so it is here and it is tested.
const PER_MT = { MT: 1, KG: 1000, LB: LB_PER_MT };
function toUnit(qty, from, to) {
    const f = PER_MT[String(from || '').toUpperCase()];
    const t = PER_MT[String(to || '').toUpperCase()];
    if (qty === null || !f || !t) return null;
    return (qty / f) * t;
}

// Loose both directions, the same rule saleInvoiceFlow uses for suppliers:
// "Inesh" and "Inesh Cores Chapin" are one supplier.
function sameName(a, b) {
    const x = String(a || '').trim().toLowerCase(), y = String(b || '').trim().toLowerCase();
    if (!x || !y) return false;
    return x === y || x.includes(y) || y.includes(x);
}

// Does this bill item describe what was claimed? Token overlap, not a regex —
// a fixed pattern over grade names is the mistake that matched the commodity
// heading "ROTORS AND DRUMS" on eleven containers during the sheet import.
const STOP = new Set(['and', 'the', 'of', 'with', 'for', 'no', 'in', 'on', 'a', 'mt', 'lb', 'kg', 'lbs', 'weight', 'shortage', 'short', 'claim', 'material']);
const tokens = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOP.has(t));

function gradeScore(itemDesc, claimText) {
    const a = new Set(tokens(itemDesc)), b = tokens(claimText);
    if (!a.size || !b.length) return 0;
    let hit = 0;
    for (const t of b) if (a.has(t)) hit += 1;
    return hit;
}

// The words that say what the claim is about: whatever the human or the model
// wrote, plus the kind's own label.
function claimText(c) {
    return [c.note, c.grade, claimKinds.label(c.claim_type), (c.quotes || {}).claim_type, (c.quotes || {}).what_is_claimed]
        .filter(Boolean).join(' | ');
}

// ── THE LOOKUP ──────────────────────────────────────────────────────────────
// Always returns an object. `price` is null whenever it is not certain, and
// `why` always says what happened — a blank rate with a reason beside it is
// worth more than a confident wrong one on a document that asks for money.
function priceFor(claim = {}) {
    const key = cont(claim.container_no);
    const out = { price: null, unit: null, source: '', why: '', bill: null, candidates: [], supplierMismatch: null };

    if (!key) { out.why = 'this claim has no container number, so there is no bill to price it from'; return out; }

    let all = [];
    try { all = bills.listWithTotals(); } catch (e) { out.why = 'the purchase bills could not be read — ' + e.message; return out; }
    const matches = all.filter((b) => cont(b.container_no) === key);
    if (!matches.length) { out.why = `no purchase bill for ${key} — enter the bill and the rate comes from it`; return out; }

    // First match wins, exactly as saleInvoiceFlow's billByContainer does, so a
    // container with two bills prices a claim the same way it prices an invoice.
    const b = matches[0];
    out.bill = { id: b.id, supplier: b.supplier || '', container_no: b.container_no || '', date: b.date || '' };
    if (matches.length > 1) out.why = `${matches.length} bills exist for ${key}; the first is used, the same one the sale invoice uses. `;

    // A claim against a supplier the bill does not name is a claim pointed at
    // the wrong company. Say so — do not quietly price it anyway.
    if (String(claim.supplier || '').trim() && !sameName(claim.supplier, b.supplier)) {
        out.supplierMismatch = { onClaim: claim.supplier, onBill: b.supplier || '(none)' };
    }

    const items = Array.isArray(b.items) ? b.items.filter((i) => i && num(i.price) !== null) : [];

    // The simple and most common bill: one grade, one price.
    if (!items.length) {
        const p = num(b.supplier_price);
        if (p === null) { out.why += `the bill for ${key} has no supplier price on it`; return out; }
        out.price = p;
        out.unit = b.price_unit === 'lb' ? 'LB' : 'MT';
        out.source = `the purchase bill for ${key}`;
        out.why += `priced from the bill's own supplier price`;
        return out;
    }

    out.candidates = items.map((i) => ({ description: i.description || '', price: num(i.price), unit: i.price_unit === 'lb' ? 'LB' : 'MT' }));

    // Several items that agree on price are not ambiguous — that is one price
    // written on several lines, and using it blends nothing.
    const distinct = new Set(out.candidates.map((i) => i.price + '/' + i.unit));
    if (distinct.size === 1) {
        out.price = out.candidates[0].price;
        out.unit = out.candidates[0].unit;
        out.source = `the purchase bill for ${key}`;
        out.why += items.length > 1 ? `every item on the bill is at the same rate` : `priced from the bill's only item`;
        return out;
    }

    // They disagree, so the grade has to decide it.
    const text = claimText(claim);
    const scored = out.candidates
        .map((i, n) => ({ ...i, n, score: gradeScore(i.description, text) }))
        .sort((x, y) => y.score - x.score);
    const best = scored[0];
    const tie = scored.filter((s) => s.score === best.score).length > 1;

    if (!best.score || tie) {
        out.why += `the bill for ${key} has ${items.length} items at different rates and nothing in this claim says which grade was short — set the rate yourself, or say which grade on the claim`;
        return out;
    }

    out.price = best.price;
    out.unit = best.unit;
    out.source = `the purchase bill for ${key}, item “${best.description}”`;
    out.why += `matched “${best.description}” on the bill`;
    return out;
}

// What the shortage comes to at the supplier's own rate. Null unless BOTH the
// shortage and the rate are known in a stated unit — the same rule claims.js
// applies to the customer side, and for the same reason: MT against pounds is
// a factor of 2204.
function recoverableFor(claim = {}, found = null) {
    const f = found || priceFor(claim);
    const shortage = num(claim.shortage);
    const unit = claim.weight_unit;
    if (shortage === null || !unit) return { amount: null, ...f, missing: 'the shortage is not worked out yet — confirm the weights first' };
    if (f.price === null) return { amount: null, ...f, missing: 'no supplier rate' };
    const qty = toUnit(shortage, unit, f.unit);
    if (qty === null) return { amount: null, ...f, missing: `cannot convert ${unit} to ${f.unit}` };
    return { amount: Math.round(qty * f.price * 100) / 100, ...f, missing: null, quantity: Math.round(qty * 1e6) / 1e6 };
}

module.exports = { priceFor, recoverableFor, toUnit, gradeScore, sameName, LB_PER_MT };
