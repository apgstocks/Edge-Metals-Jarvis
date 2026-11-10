// ── helpers/priceHistory.js — every price Edge Metals has paid or charged, as exact facts (READ-ONLY) ────────
// Apsara, 2026-11-10: "every pattern in price needs to be learned ... it's an AI."
//
// THE SPLIT, ON PURPOSE: this file does the ARITHMETIC (a language model gets numbers wrong); the learner (learner/, docs/LEARNER.md) does the
// UNDERSTANDING — is this price normal for this party, is it a discrepancy, why might it have moved — from these facts plus her own answers.
// There is no price rule in here: no threshold decides anything. `pct_off` is a fact handed to the AI, not a verdict.
//
// Sources: Sales invoices (what customers pay: invoice_price, per line when a container has several grades) and supplier Bills
// (supplier_price, and per-line prices). Every price is converted to $/lb so a $/MT invoice and a $/lb bill compare. WRITES NOTHING.
// Edge METALS only (rule 5): sales.json and bills.json are Edge Metals'. Edge Yard's buying is a different ledger and is not read.
const LB_PER_MT = 2204.62262;
const PER_LB_CEILING = 10;          // bills.js's own rule: under $10 is per lb, $10+ is per MT
const MIN_FOR_TREND = 4;            // fewer observations than this: facts are shown, but a "typical" price is not claimed

const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const round4 = (n) => Math.round(n * 1e4) / 1e4;
const norm = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ');
const keyOf = (s) => norm(s).toLowerCase();

function dayOf(v) {
    const s = String(v == null ? '' : v).trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    return null;
}
function perLb(price, unit) {
    const p = num(price); if (p === null || p <= 0) return null;
    const u = unit === 'lb' || unit === 'mt' ? unit : (p < PER_LB_CEILING ? 'lb' : 'mt');
    return round4(u === 'mt' ? p / LB_PER_MT : p);
}

function defaults() {
    return { sales: () => require('./sales').list(), bills: () => require('./bills').list() };
}

/** Every dated price, one row each, in $/lb. */
function observations({ src = defaults() } = {}) {
    const out = [];
    const push = (side, party, item, price, unit, date, ref, weight) => {
        const usd = perLb(price, unit), d = dayOf(date);
        if (usd === null || !d || !norm(party)) return;
        out.push({ side, party: norm(party), item: norm(item) || '(not stated)', usd_per_lb: usd, date: d, ref: String(ref), weight_lb: num(weight) });
    };
    for (const s of (src.sales() || [])) {
        const lines = Array.isArray(s.items) && s.items.length ? s.items.filter((i) => num(i.price) !== null) : [];
        if (lines.length) lines.forEach((i, n) => push('sale', s.customer, i.description || s.item, i.price, i.price_unit, s.date, `${s.id}#${n}`, i.weight));
        else push('sale', s.customer, s.item, s.invoice_price, s.price_unit, s.date, s.id, s.weight);
    }
    for (const b of (src.bills() || [])) {
        const lines = Array.isArray(b.items) && b.items.length ? b.items.filter((i) => num(i.price) !== null) : [];
        if (lines.length) lines.forEach((i, n) => push('bill', b.supplier, i.description, i.price, i.price_unit, b.date, `${b.id}#${n}`, i.weight));
        else push('bill', b.supplier, b.item || b.description, b.supplier_price, b.price_unit, b.date, b.id, b.net_weight);
    }
    return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.ref < b.ref ? -1 : 1));
}

// Her own companies (rule 5) buy from and sell to each other at transfer prices, not market prices: they are listed as facts but never
// counted as "the market" for anyone else's price.
const INTERCOMPANY = /^(edge\s*(yard|metals|trading)?|aaa\s*investment)\b|^edgeyard\b/i;
const isIntercompany = (name) => INTERCOMPANY.test(norm(name));

const median = (xs) => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };

/** Facts per (side, party, item). `typical` and `pct_off` are only claimed with MIN_FOR_TREND+ earlier prices. */
function series(obs) {
    const groups = new Map();
    for (const o of obs) { const k = `${o.side}|${keyOf(o.party)}|${keyOf(o.item)}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(o); }
    const out = [];
    for (const [k, pts] of groups) {
        const last = pts[pts.length - 1], prior = pts.slice(0, -1).map((p) => p.usd_per_lb);
        const enough = prior.length >= MIN_FOR_TREND;
        const typical = enough ? round4(median(prior)) : null;
        out.push({ key: k, side: last.side, party: last.party, item: last.item, n: pts.length,
            first_date: pts[0].date, last_date: last.date, last: last.usd_per_lb, min: Math.min(...pts.map((p) => p.usd_per_lb)), max: Math.max(...pts.map((p) => p.usd_per_lb)),
            typical, intercompany: isIntercompany(last.party), item_stated: keyOf(last.item) !== '(not stated)', pct_off: typical ? Math.round(((last.usd_per_lb - typical) / typical) * 1000) / 10 : null, enough_history: enough,
            points: pts.map((p) => ({ date: p.date, usd_per_lb: p.usd_per_lb, ref: p.ref })) });
    }
    return out.sort((a, b) => Math.abs(b.pct_off || 0) - Math.abs(a.pct_off || 0) || b.n - a.n);
}

/** The case handed to the learner for ONE price: the facts, in words and numbers, and nothing the model has to calculate. */
function caseFor(obs, all) {
    const same = all.filter((o) => o.side === obs.side && keyOf(o.party) === keyOf(obs.party) && keyOf(o.item) === keyOf(obs.item) && (o.date < obs.date || (o.date === obs.date && o.ref < obs.ref)));
    const prior = same.map((o) => o.usd_per_lb);
    const typical = prior.length >= MIN_FOR_TREND ? round4(median(prior)) : null;
    const other = all.filter((o) => !isIntercompany(o.party) && o.side === obs.side && keyOf(o.item) === keyOf(obs.item) && keyOf(o.party) !== keyOf(obs.party) && o.date <= obs.date).map((o) => o.usd_per_lb);
    return { side: obs.side, party: obs.party, item: obs.item, price_per_lb: obs.usd_per_lb, date: obs.date,
        times_seen_before: prior.length, typical_for_this_party: typical,
        pct_off_typical: typical ? Math.round(((obs.usd_per_lb - typical) / typical) * 1000) / 10 : null,
        last_three_for_this_party: same.slice(-3).map((o) => `${o.date} ${o.usd_per_lb}`).join('; ') || null,
        market_among_other_parties: other.length >= MIN_FOR_TREND ? round4(median(other)) : null };
}

module.exports = { isIntercompany, observations, series, caseFor, perLb, dayOf, MIN_FOR_TREND, LB_PER_MT };
