// ── helpers/stockGuard.js — you cannot ship what you never bought ───────────
//
// Apsara, 2026-09-16. Asked how loud a negative on-hand should be, she chose
// the strongest option on the list: "Block the sale instead".
//
// A negative on-hand means more material left the yard than was ever recorded
// arriving. That is never true of the metal — it is always true of the
// paperwork, and the longer it sits the harder it is to reconstruct which load
// was never entered. Refusing at the moment of the sale is the only point
// where somebody still remembers.
//
// ── IT CAN BE OVERRIDDEN, AND THAT IS NOT A WEAKENING ───────────────────────
// I put the risk to her when she chose this: a hard block "stops you recording
// something that physically happened, which is usually the wrong trade". A
// truck that has already left with metal on it is a fact, and an app that
// refuses to write facts down gets worked around — on paper, in a phone note,
// nowhere.
//
// So this follows the pattern already in this codebase for petty cash: refuse
// by default with a structured reason, and accept a DELIBERATE override that
// the caller had to ask for. `allow_negative` is never sent by accident; the
// client only sets it after showing her the numbers and being told yes. The
// block is the default, the override is a decision, and both are recorded.
//
// ── IT COUNTS THE WAY THE INVENTORY TAB COUNTS ─────────────────────────────
// Through getInventoryReport, not a second calculation of its own. Two pieces
// of code that both decide what is on hand will disagree eventually, and the
// day they do, one of them refuses a sale the other says is fine — with no way
// to tell which is right. One source, one answer.
//
// That also means it inherits the alias folding: a sale recorded as "Aluminium
// combo" is checked against the "Al combo" pile once she has said they are the
// same metal, rather than against nothing.

const aliases = require('./itemAliases');

const toNum = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = parseFloat(String(v).replace(/,/g, ''));
    return isFinite(n) ? n : null;
};

// Net weight of an outbound item, computed the same way the record will be:
// gross minus tare, falling back to a stated net.
function netOf(it) {
    const g = toNum(it && it.gross_weight);
    const t = toNum(it && it.tare_weight);
    if (g !== null && t !== null) return g - t;
    const n = toNum(it && it.net_weight);
    return n === null ? null : n;
}

// What is on hand per canonical item key, right now.
//
// `excludeOutboundId` matters for EDITS: the load being changed already
// counts against stock, so checking a revised weight without removing the old
// one would refuse an edit that merely corrects 400 lb to 380.
function onHandByKey({ loadsList, outboundList, excludeOutboundId = null } = {}) {
    const { getInventoryReport } = require('./loads');
    const rows = aliases.list();
    const report = getInventoryReport(loadsList || require('./loads').loadLoads(), {});
    // ── "NOT IN THE REPORT" IS NOT "UNKNOWN" ─────────────────────────────
    // These are different and conflating them made the guard useless for the
    // case it was built for. An item the report simply does not list has NO
    // stock — on hand is zero, a fact. On hand is only UNKNOWN when the
    // report could not compute it at all (outbound unreadable), and that is
    // what onHandAvailable reports.
    //
    // Treating a missing row as unknown meant selling a material never bought
    // sailed straight through, which is exactly the "Aluminium combo" that
    // produced a row reading minus 300.
    const known = report.onHandAvailable === true;
    const map = new Map();
    map.set('__known__', known);
    for (const g of (report.byType || [])) {
        const key = aliases.canonicalKey(g.description, rows) || String(g.description || '').toLowerCase();
        map.set(key, {
            key,
            label: g.description,
            onHand: typeof g.onHand === 'number' ? g.onHand : null,
        });
    }
    if (excludeOutboundId) {
        const all = outboundList || require('./outboundLoads').loadOutboundLoads();
        const doomed = all.find((o) => o && String(o.id) === String(excludeOutboundId));
        for (const it of ((doomed && doomed.items) || [])) {
            const key = aliases.canonicalKey(it && it.description, rows);
            const hit = key && map.get(key);
            const n = netOf(it);
            if (hit && hit.onHand !== null && n !== null) hit.onHand = Math.round((hit.onHand + n) * 100) / 100;
        }
    }
    return map;
}

// Returns [] when the sale is fine, or one entry per item that would go short.
//
// Items are summed per material FIRST. Two lines of the same metal on one
// outbound load each fitting inside stock, but not together, is exactly the
// case a per-line check waves through.
function shortfalls(items, opts = {}) {
    const rows = aliases.list();
    const have = onHandByKey(opts);

    const want = new Map();
    for (const it of (items || [])) {
        const desc = String((it && it.description) || '').trim();
        const n = netOf(it);
        if (!desc || n === null || n <= 0) continue;
        const key = aliases.canonicalKey(desc, rows) || desc.toLowerCase();
        const cur = want.get(key) || { key, label: desc, weight: 0 };
        cur.weight = Math.round((cur.weight + n) * 100) / 100;
        want.set(key, cur);
    }

    const out = [];
    // Whether on-hand is computable AT ALL. When it is not — the outbound
    // store unreadable, say — nothing is refused: blocking every sale over a
    // transient read failure would be far worse than letting one through.
    const canTell = have.get('__known__') === true;
    if (!canTell) return out;

    for (const [key, req] of want) {
        const hit = have.get(key);
        // No row means no stock, which is a real zero and the whole point of
        // this guard. Only an explicitly non-numeric on-hand is unknown.
        const onHand = hit
            ? (typeof hit.onHand === 'number' ? hit.onHand : null)
            : 0;
        if (onHand === null) continue;
        if (req.weight <= onHand + 0.005) continue;
        out.push({
            item: hit ? hit.label : req.label,
            typed_as: req.label,
            on_hand: Math.round(onHand * 100) / 100,
            requested: req.weight,
            short_by: Math.round((req.weight - onHand) * 100) / 100,
        });
    }
    return out;
}

// The sentence a person reads. Written here rather than in the client so both
// clients and the bot say the same thing — and so it names the numbers, since
// "not enough stock" tells her nothing she can act on.
function explain(list, unit = 'lb') {
    return (list || []).map((s) => {
        const known = s.typed_as && aliases.norm(s.typed_as) !== aliases.norm(s.item)
            ? ` (recorded as "${s.typed_as}")` : '';
        return s.on_hand <= 0
            ? `${s.item}${known}: nothing on hand, but ${s.requested} ${unit} is going out.`
            : `${s.item}${known}: only ${s.on_hand} ${unit} on hand, but ${s.requested} ${unit} is going out — short by ${s.short_by} ${unit}.`;
    }).join(' ');
}

module.exports = { shortfalls, onHandByKey, netOf, explain };
