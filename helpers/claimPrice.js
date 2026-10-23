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
// ── THE WHOLE CONTAINER'S OWN RATE ───────────────────────────────────────────
// Apsara, 2026-10-21: an auto-parts container holds several materials, and a
// weight shortage on it is weighed once — "They will have weight slip for
// overall container." Nobody can say which grade is missing, so there is no
// grade to match and no per-item rate to pick.
//
// ── IT DIVIDES MONEY BY WEIGHT. IT DOES NOT AVERAGE RATES ───────────────────
// Asked whether to use a weighted or a simple average, her answer was that the
// slip is for the whole container — which settles it. The rate that means
// something is what the container actually cost per pound:
//
//     items_amount / items_weight
//
// That IS the weighted average, and it falls out of figures already on the
// bill. The mean of the rates is a different number that corresponds to no
// money anyone paid: it treats 200 lb of one grade as equal to 40,000 lb of
// another. On Al combo 12,000 lb @ $0.32 + Auto cast 17,000 lb @ $0.28 it says
// $0.30 where the container cost $0.2968.
//
// ── NOT bills.amount ────────────────────────────────────────────────────────
// bills.js computes `amount` as `stated ?? computed` — if she has typed the
// supplier's invoice total and that total carries freight, blending off it
// folds trucking into a material rate and overstates the claim against him.
// items_amount is the material lines and only the material lines.
//
// ── IT REFUSES A PARTIAL CONTAINER ──────────────────────────────────────────
// Every item must carry a weight and an amount. Blending the four lines that
// are complete and ignoring the fifth produces a confident rate for a
// container nobody has finished entering, and nothing downstream would show
// that it was short. A refusal is recoverable; a plausible wrong rate is not.
function blendFor(b, key) {
    const out = { price: null, unit: null, source: '', why: '', blend: null };
    const items = Array.isArray(b.items) ? b.items : [];
    if (items.length < 2) {
        out.why = `the bill for ${key} has only one material, so there is nothing to average — it is priced from that line`;
        return out;
    }
    const bad = items.filter((i) => num(i.weight) === null || num(i.amount) === null);
    if (bad.length) {
        const names = bad.map((i) => `“${i.description || 'an unnamed line'}”`).join(', ');
        out.why = `${bad.length} of the ${items.length} materials on ${key} have no weight or no amount (${names}) — finish the bill and the container's own rate follows from it`;
        return out;
    }
    const weight = items.reduce((s, i) => s + num(i.weight), 0);
    const amount = items.reduce((s, i) => s + num(i.amount), 0);
    if (!(weight > 0)) { out.why = `the materials on ${key} add up to no weight, so a rate cannot be worked out`; return out; }

    // Rounded to four places, not two. This is a RATE, multiplied by tens of
    // thousands of pounds — rounding $0.2968 to $0.30 moves a 1,000 lb claim
    // by $3.20 and a 40,000 lb one by $128.
    out.price = Math.round((amount / weight) * 1e4) / 1e4;
    out.unit = 'LB';                 // item weights are pounds (bills.js cleanItems)
    out.source = `what the whole of ${key} cost`;
    out.why = `averaged across all ${items.length} materials loaded, by weight`;
    out.blend = {
        materials: items.map((i) => ({
            description: i.description || '', weight: num(i.weight),
            rate: num(i.price), rate_unit: i.price_unit === 'mt' ? 'MT' : 'LB', amount: num(i.amount),
        })),
        total_weight: Math.round(weight * 1e3) / 1e3,
        total_amount: Math.round(amount * 100) / 100,
        rate: out.price,
        rate_unit: 'LB',
    };
    return out;
}

function priceFor(claim = {}) {
    const key = cont(claim.container_no);
    const out = { price: null, unit: null, source: '', why: '', bill: null, candidates: [], supplierMismatch: null, blend: null };

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

    // ── OPT IN, AND THE FLAG MARKS THE NEW SHAPE ───────────────────────────
    // Checked BEFORE the grade matching below, because a container weighed as
    // a whole has no grade to match — but only when the claim says so.
    //
    // Blending is NOT automatic for every multi-item bill, and that is
    // deliberate. A mixed container whose claim names a grade prices off that
    // grade today; making the blend automatic would silently re-rate every
    // one of those claims, which is changing behaviour nobody asked to change.
    // So the flag turns the NEW behaviour on, and a claim without it prices
    // exactly as it did yesterday. A flag that had to be set to keep the old
    // behaviour would eventually not be set.
    if (claim.price_basis === 'container_blend') {
        const bl = blendFor(b, key);
        out.price = bl.price; out.unit = bl.unit; out.blend = bl.blend;
        out.source = bl.source; out.why += bl.why;
        out.candidates = (Array.isArray(b.items) ? b.items : [])
            .filter((i) => i && num(i.price) !== null)
            .map((i) => ({ description: i.description || '', price: num(i.price), unit: i.price_unit === 'lb' ? 'LB' : 'MT' }));
        return out;
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
        // THREE ways out now, not two. The third is the auto-parts case:
        // Apsara, 2026-10-21, "there are like auto parts container where we
        // will put more than one material ... we will take avergae price of
        // all the material that was loaded into the container", and asked how
        // the shortage is weighed: "They will have weight slip for overall
        // container." A container-level slip means nobody knows WHICH grade
        // went missing, so no grade match is possible even in principle.
        out.why += `the bill for ${key} has ${items.length} items at different rates and nothing in this claim says which grade was short — set the rate yourself, say which grade on the claim, or mark it weighed on the whole container and the rate comes from what the container cost`;
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

module.exports = { priceFor, blendFor, recoverableFor, toUnit, gradeScore, sameName, LB_PER_MT };
