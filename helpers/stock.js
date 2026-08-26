// ── helpers/stock.js — what is actually still in the yard ───────────────────
//
// Apsara, 2026-08-24: "how to design to checkout few items from inventory?"
//
// THE PROBLEM THIS SOLVES
//
// /api/loads/inventory has always been a PURCHASE LOG, not a stock level. It
// sums every inbound load ever recorded and never subtracts anything, so
// shipping 40,000 lb of auto cast to Korea leaves the Inventory tab still
// reporting it as held. helpers/outboundLoads.js has recorded outbound sales
// since 2026-08-16, but nothing ever netted the two together.
//
// WHY WHOLE-LOAD LINKING WASN'T ENOUGH
//
// Outbound loads already carry linked_inbound_load_ids for margin, and that
// file's own comment flagged the limitation precisely:
//
//   "this links whole inbound loads, not a weight-prorated split ... overstates
//    cost if the same inbound load is linked from more than one outbound sale
//    (its full cost would get counted against each). Flagged rather than
//    silently assumed correct — ask if partial/weight-based allocation is
//    needed later."
//
// Asked, and answered: a container is usually built from PARTS of several
// piles. So a link needs a weight, not just an id.
//
// THE MODEL
//
// Each outbound item may carry draws: [{ load_id, weight }] — this much
// material, from that specific inbound load. From those:
//   • on-hand per item type   = purchased − drawn
//   • remaining per lot       = that load's net − everything drawn from it
//   • cost of a sale          = sum(weight × that load's unit cost)
//
// A draw is deliberately (load, weight) and NOT (load, item, weight). An
// inbound load can contain several item types, but in practice a draw is
// against the load's material, and asking someone to also name which line of
// a three-line load they took from is bookkeeping nobody will do accurately.
// Where a load has multiple types, cost is prorated by weight across it.
//
// UNLINKED OUTBOUND STILL COUNTS AS SHIPPED. A sale with no draws recorded
// reduces on-hand for its item type — it left the yard, whatever the
// paperwork says — it just contributes no cost. Ignoring it would report
// material as held that visibly is not, which is the failure mode this file
// exists to end.

const { round2 } = require('./money');

const norm = (d) => String(d || 'Other').trim().toLowerCase();

// Unit cost ($/unit weight) for an inbound load, prorated across whatever it
// contains. Returns null when the load has no amount or no weight — a lot
// with an unknown cost must not silently become a free one.
function unitCostOf(load) {
    const net = Number(load && load.net_weight);
    const amt = Number(load && load.amount);
    if (!Number.isFinite(net) || net <= 0) return null;
    if (!Number.isFinite(amt) || amt <= 0) return null;
    return amt / net;
}

// Every draw across every outbound load, flattened. Shape:
// { load_id, weight, outbound_id, outbound_date, buyer, desc }
function collectDraws(outboundLoads) {
    const out = [];
    for (const o of outboundLoads || []) {
        for (const it of (o.items || [])) {
            for (const d of (it.draws || [])) {
                const w = Number(d && d.weight);
                if (!d || !d.load_id || !Number.isFinite(w) || w <= 0) continue;
                out.push({
                    load_id: String(d.load_id),
                    weight: w,
                    outbound_id: o.id,
                    outbound_date: o.date || null,
                    buyer: o.buyer || null,
                    desc: it.description || null,
                });
            }
        }
    }
    return out;
}

// Per inbound load: what came in, what has been drawn, what is left.
function lotReport(inboundLoads, outboundLoads) {
    const draws = collectDraws(outboundLoads);
    const drawnBy = new Map();
    for (const d of draws) {
        if (!drawnBy.has(d.load_id)) drawnBy.set(d.load_id, []);
        drawnBy.get(d.load_id).push(d);
    }
    return (inboundLoads || []).map((l) => {
        const mine = drawnBy.get(l.id) || [];
        const drawn = mine.reduce((s, d) => s + d.weight, 0);
        const net = Number(l.net_weight) || 0;
        return {
            id: l.id,
            date: l.date || null,
            seller: l.seller || null,
            description: (l.items || []).map((i) => i.description).filter(Boolean).join(', ') || l.description || '',
            net: round2(net),
            drawn: round2(drawn),
            // Never negative in the report even if the data is over-drawn —
            // the overdrawn flag is how that gets surfaced, rather than a
            // remaining figure that reads as a real (impossible) quantity.
            remaining: round2(Math.max(0, net - drawn)),
            overdrawn: drawn > net + 0.001,
            unitCost: unitCostOf(l),
            drawnBy: mine.map((d) => ({ outbound_id: d.outbound_id, weight: round2(d.weight), buyer: d.buyer, date: d.outbound_date })),
        };
    });
}

// Per item type: purchased, shipped, on hand.
function stockReport(inboundLoads, outboundLoads) {
    const types = new Map();
    const touch = (desc) => {
        const k = norm(desc);
        if (!types.has(k)) types.set(k, { description: String(desc || 'Other').trim(), purchased: 0, shipped: 0, purchasedAmount: 0 });
        return types.get(k);
    };
    for (const l of inboundLoads || []) {
        for (const it of (l.items || [])) {
            const t = touch(it.description);
            t.purchased += Number(it.net_weight) || 0;
            t.purchasedAmount += Number(it.amount) || 0;
        }
    }
    for (const o of outboundLoads || []) {
        for (const it of (o.items || [])) {
            touch(it.description).shipped += Number(it.net_weight) || 0;
        }
    }
    return Array.from(types.values())
        .map((t) => ({
            description: t.description,
            purchased: round2(t.purchased),
            shipped: round2(t.shipped),
            onHand: round2(t.purchased - t.shipped),
            purchasedAmount: round2(t.purchasedAmount),
            // Negative on-hand means more was shipped than recorded as bought
            // — a data problem worth naming rather than clamping away, since
            // it usually means an inbound load was never entered.
            negative: t.purchased - t.shipped < -0.001,
        }))
        .sort((a, b) => b.onHand - a.onHand);
}

// FIFO proposal: draw `weight` of `desc`, oldest lot first. Returns
// { draws, shortfall } — shortfall > 0 means the yard doesn't hold enough on
// the books, which is surfaced rather than silently part-filled.
function suggestDraws(inboundLoads, outboundLoads, desc, weight) {
    const want = Number(weight);
    if (!Number.isFinite(want) || want <= 0) return { draws: [], shortfall: 0 };
    const key = norm(desc);
    const lots = lotReport(inboundLoads, outboundLoads)
        .filter((l) => l.remaining > 0.001)
        .filter((l) => {
            const inbound = (inboundLoads || []).find((x) => x.id === l.id);
            return (inbound && inbound.items || []).some((i) => norm(i.description) === key);
        })
        .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));

    const draws = [];
    let left = want;
    for (const lot of lots) {
        if (left <= 0.001) break;
        const take = Math.min(left, lot.remaining);
        draws.push({ load_id: lot.id, weight: round2(take), date: lot.date, seller: lot.seller, remainingAfter: round2(lot.remaining - take) });
        left -= take;
    }
    return { draws, shortfall: round2(Math.max(0, left)) };
}

// Rejects a set of draws that would take more than a lot holds. Returns
// { ok, errors } — checked BEFORE a save, because an over-draw silently
// accepted turns every later on-hand figure into a lie.
function validateDraws(inboundLoads, outboundLoads, proposed, { ignoreOutboundId = null } = {}) {
    const others = (outboundLoads || []).filter((o) => !ignoreOutboundId || o.id !== ignoreOutboundId);
    const lots = new Map(lotReport(inboundLoads, others).map((l) => [l.id, l]));
    const wanted = new Map();
    for (const d of proposed || []) {
        const w = Number(d && d.weight);
        if (!d || !d.load_id || !Number.isFinite(w) || w <= 0) continue;
        wanted.set(String(d.load_id), (wanted.get(String(d.load_id)) || 0) + w);
    }
    const errors = [];
    for (const [id, w] of wanted) {
        const lot = lots.get(id);
        if (!lot) { errors.push(`${id} is not a known load.`); continue; }
        if (w > lot.remaining + 0.001) {
            errors.push(`${id} only has ${round2(lot.remaining)} left, but ${round2(w)} was drawn from it.`);
        }
    }
    return { ok: errors.length === 0, errors };
}

module.exports = { stockReport, lotReport, suggestDraws, validateDraws, collectDraws, unitCostOf };
