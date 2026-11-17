// ── helpers/stockExplain.js — WHY is the on-hand of this item what it is ─────────────────────────────────────
// Apsara, 2026-11-15: "why did the number become -12290" / "no guesses, only proper reasoning".
//
// Read-only and deterministic. It lines up every purchase line and every sale line of ONE item, shows the balance
// day by day, and states the facts the books support. It never says WHY a purchase is missing, because the books
// cannot show that; it says what is on the books and what the books cannot tell.
//
// It reproduces the SAME arithmetic as the Inventory screen (helpers/loads.js getInventoryReport): purchases grouped by
// lower-cased description, sales netted by the alias/normalised key. Then it RECONCILES against the screen's own row.
// If the two disagree, that is reported as a finding; it is never papered over.
//
// Edge Yard only: the caller passes yard loads and yard sales. Nothing here reads Edge Metals data.

const { round2 } = require('./money');

const trim = (v) => String(v == null || String(v).trim() === '' ? 'Other' : v).trim();
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

function lev(a, b) {
    const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
        const cur = [i];
        for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = cur;
    }
    return prev[n];
}

// opts: { inbound, outbound, item, aliasRows, screenRows }
//   screenRows = getInventoryReport(inbound).byType (the rows the Inventory screen shows)
function explainStock(opts) {
    const inbound = opts.inbound || [], outbound = opts.outbound || [];
    const aliases = require('./itemAliases');
    const rows = opts.aliasRows || aliases.list();
    const keyOf = (raw) => aliases.canonicalKey(trim(raw), rows) || trim(raw).toLowerCase();
    const want = String(opts.item || '').trim();
    if (!want) throw new Error('Which item? Give the item name.');
    const k = keyOf(want);

    // Every line, tagged with its key.
    const lines = [];
    for (const l of inbound) for (const it of (l && l.items) || []) {
        lines.push({ type: 'purchase', key: keyOf(it && it.description), name: trim(it && it.description), date: l.date || null, ref: l.id, party: l.seller || null, weight: num(it && it.net_weight), unit: l.weight_unit || 'lb', created_at: l.created_at || '' });
    }
    for (const o of outbound) for (const it of (o && o.items) || []) {
        const draws = ((it && it.draws) || []).filter((d) => d && d.load_id && num(d.weight) > 0);
        lines.push({ type: 'sale', key: keyOf(it && it.description), name: trim(it && it.description), date: o.date || null, ref: o.id, party: o.buyer || null, weight: num(it && it.net_weight), unit: o.weight_unit || 'lb', drawn: round2(draws.reduce((s, d) => s + num(d.weight), 0)), created_at: o.created_at || '' });
    }

    const mine = lines.filter((x) => x.key === k);
    if (!mine.length) {
        const byKey = new Map();
        for (const x of lines) { const e = byKey.get(x.key) || { name: x.name, purchased: 0, sold: 0 }; if (x.type === 'purchase') e.purchased += x.weight; else e.sold += x.weight; byKey.set(x.key, e); }
        const cand = [...byKey.entries()].filter(([ck]) => (ck.includes(k) || k.includes(ck)) && Math.min(ck.length, k.length) >= 3 || (Math.min(ck.length, k.length) >= 5 && lev(ck, k) <= 2))
            .map(([, e]) => ({ name: e.name, purchased: round2(e.purchased), sold: round2(e.sold), onHand: round2(e.purchased - e.sold) })).slice(0, 8);
        return { status: 'not_found', item: want, candidates: cand, say: cand.length ? 'No item has exactly that name. Ask which of these is meant; do not pick one.' : 'No purchase or sale line carries that item name.' };
    }

    const purchases = mine.filter((x) => x.type === 'purchase'), sales = mine.filter((x) => x.type === 'sale');
    const purchased = round2(purchases.reduce((s, x) => s + x.weight, 0));
    const sold = round2(sales.reduce((s, x) => s + x.weight, 0));
    const onHand = round2(purchased - sold);

    // Day-by-day, END-of-day balance, so no assumption is made about the order inside one day.
    const dated = mine.filter((x) => x.date), undated = mine.filter((x) => !x.date);
    const days = [...new Set(dated.map((x) => x.date))].sort();
    let bal = 0; const daily = [];
    for (const d of days) {
        const ev = dated.filter((x) => x.date === d);
        const p = ev.filter((x) => x.type === 'purchase').reduce((s, x) => s + x.weight, 0);
        const s = ev.filter((x) => x.type === 'sale').reduce((t, x) => t + x.weight, 0);
        const before = bal; bal = bal + p - s;
        daily.push({ date: d, bought: round2(p), sold: round2(s), before: round2(before), after: round2(bal), lines: ev.map((x) => ({ type: x.type, ref: x.ref, party: x.party, weight: round2(x.weight), name: x.name })) });
    }
    const firstNeg = daily.find((d) => d.after < -0.001) || null;

    const findings = [];
    const f = (code, text, data) => findings.push({ code, text, ...(data ? { data } : {}) });

    if (onHand < -0.001) f('sold_exceeds_bought', `On the books ${sold} was sold and ${purchased} was bought, so ${round2(-onHand)} more has gone out than has been recorded as coming in.`, { purchased, sold, shortfall: round2(-onHand) });
    if (firstNeg) f('first_below_zero', `The balance first ends a day below zero on ${firstNeg.date}: ${firstNeg.before} before, ${firstNeg.bought} bought and ${firstNeg.sold} sold that day, ${firstNeg.after} after.`, { date: firstNeg.date, sales: firstNeg.lines.filter((l) => l.type === 'sale').map((l) => l.ref) });
    const firstBuy = purchases.filter((x) => x.date).map((x) => x.date).sort()[0] || null;
    const firstSale = sales.filter((x) => x.date).map((x) => x.date).sort()[0] || null;
    if (sales.length && (!purchases.length || (firstSale && firstBuy && firstSale < firstBuy))) f('sale_before_any_purchase', purchases.length ? `The first sale (${firstSale}) is dated before the first purchase (${firstBuy}).` : 'There is no purchase line for this item at all, only sales.', { firstSale, firstBuy });
    const zeroBuys = purchases.filter((x) => x.weight <= 0);
    if (zeroBuys.length) f('purchase_without_weight', `${zeroBuys.length} purchase line(s) for this item carry no net weight, so they add nothing: ${[...new Set(zeroBuys.map((x) => x.ref))].slice(0, 10).join(', ')}.`, { loads: [...new Set(zeroBuys.map((x) => x.ref))] });
    const zeroSales = sales.filter((x) => x.weight <= 0);
    if (zeroSales.length) f('sale_without_weight', `${zeroSales.length} sale line(s) carry no net weight: ${[...new Set(zeroSales.map((x) => x.ref))].slice(0, 10).join(', ')}.`, { sales: [...new Set(zeroSales.map((x) => x.ref))] });
    const nonLb = [...new Set(mine.filter((x) => String(x.unit).toLowerCase() !== 'lb').map((x) => x.ref))];
    if (nonLb.length) f('mixed_units', `${nonLb.length} record(s) are not in lb (${nonLb.slice(0, 10).join(', ')}); the screen adds weights without converting, so this figure mixes units.`, { records: nonLb });
    if (undated.length) f('undated_lines', `${undated.length} line(s) have no date, so they are in the totals but cannot be placed on the timeline: ${[...new Set(undated.map((x) => x.ref))].slice(0, 10).join(', ')}.`, { records: [...new Set(undated.map((x) => x.ref))] });
    const overdrawn = sales.filter((x) => x.drawn > x.weight + 0.001);
    if (overdrawn.length) f('draws_exceed_sale', `${overdrawn.length} sale line(s) record more drawn from lots than the line weighs: ${[...new Set(overdrawn.map((x) => x.ref))].slice(0, 10).join(', ')}.`, { sales: [...new Set(overdrawn.map((x) => x.ref))] });

    // Same material under another name? Observation only, with numbers. Only she can say they are the same.
    const others = new Map();
    for (const x of lines) {
        if (x.key === k) continue;
        const e = others.get(x.key) || { name: x.name, purchased: 0, sold: 0 };
        if (x.type === 'purchase') e.purchased += x.weight; else e.sold += x.weight;
        others.set(x.key, e);
    }
    const similar = [...others.entries()].filter(([ck]) => Math.min(ck.length, k.length) >= 3 && (ck.includes(k) || k.includes(ck) || (Math.min(ck.length, k.length) >= 5 && lev(ck, k) <= 2)))
        .map(([, e]) => ({ name: e.name, purchased: round2(e.purchased), sold: round2(e.sold), onHand: round2(e.purchased - e.sold) }));
    if (similar.length) f('similar_names', `Other item names that look similar: ${similar.map((s) => `"${s.name}" (bought ${s.purchased}, sold ${s.sold}, on hand ${s.onHand})`).join('; ')}. The books cannot say whether they are the same material. Only Apsara can confirm that.`, { similar });

    // Reconcile with the Inventory screen's own rows.
    const screen = (opts.screenRows || []).filter((r) => keyOf(r.description) === k).map((r) => ({ description: r.description, purchased: r.net, shipped: r.shipped, onHand: r.onHand }));
    let reconcile = { checked: false };
    if (opts.screenRows) {
        if (screen.length === 1) {
            const ok = Math.abs(screen[0].onHand - onHand) < 0.01;
            reconcile = { checked: true, matches: ok, screen, ledgerOnHand: onHand };
            if (!ok) f('does_not_reconcile', `This breakdown gives ${onHand} on hand but the Inventory screen shows ${screen[0].onHand}. They should be equal. This needs a developer, and no explanation here should be trusted until it is resolved.`, { screen: screen[0].onHand, ledger: onHand });
        } else if (screen.length > 1) {
            reconcile = { checked: true, matches: false, screen, ledgerOnHand: onHand };
            f('screen_splits_this_item', `The Inventory screen shows ${screen.length} separate rows for this one item (${screen.map((r) => `"${r.description}" ${r.onHand}`).join(', ')}) because the purchase spellings differ, and each row subtracts the full ${sold} sold. The combined figure is ${onHand}.`, { rows: screen, combined: onHand });
        } else {
            reconcile = { checked: true, matches: false, screen: [], ledgerOnHand: onHand };
            f('not_on_screen', 'The Inventory screen has no row for this item name.');
        }
    }

    const MAX = 80; const flat = [];
    for (const d of daily) for (const l of d.lines) flat.push({ date: d.date, ...l });
    return {
        status: 'ok', item: mine[0].name, totals: { purchased, sold, onHand }, findings,
        first_below_zero: firstNeg ? { date: firstNeg.date, before: firstNeg.before, after: firstNeg.after } : null,
        reconcile, timeline: { days: daily.length, lines: flat.length, shown: Math.min(MAX, flat.length), latest: flat.slice(-MAX) },
        cannot_tell: ['Whether a purchase was never entered, entered under another name, or a sale was entered wrongly. The books show only what is recorded.'],
    };
}

module.exports = { explainStock };
