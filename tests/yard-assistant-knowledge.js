// ── tests/yard-assistant-knowledge.js ─────────────────────────────────────
// Apsara, 2026-09-16: "Yard assistant should have complete knowledge abou
// yard."
//
// ── WHAT WAS ACTUALLY MISSING ───────────────────────────────────────────────
// Not a rough edge. Every read tool in helpers/tools.js looked at PURCHASES:
// find_loads calls loadLoads() and says so in its own description, and nothing
// in that file had ever opened helpers/outboundLoads.js. So "who did we sell to
// this month", "what did Eccomelt take", "are we making anything" all reached
// an assistant with no way to look. Half the yard was invisible.
//
// ── AND THE SPECIFIC DANGER IN CLOSING THE GAP ──────────────────────────────
// yardProfit returns a margin AND a coverage figure, because the margin is
// computed only over sales linked back to the loads they came from. At 40%
// coverage the margin describes 40% of the business. helpers/yardProfit.js
// returns the caveat IN WORDS precisely so a client cannot render the number
// without it by forgetting to — and an assistant is the client most likely to
// forget, because it reads JSON, finds `margin`, and says a number.
//
// So section C is not about arithmetic. It is about whether the caveat is
// somewhere the model cannot miss it.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-yardai-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('  ABORT  config not isolated'); process.exit(1); }

const tools = require(path.join(ROOT, 'helpers/tools'));
const loads = require(path.join(ROOT, 'helpers/loads'));
const outbound = require(path.join(ROOT, 'helpers/outboundLoads'));

(async () => {

// A small real yard: bought 1000, sold 800 across two buyers.
const bought = await loads.addLoad({
    date: '2026-09-10', seller: 'Ramesh', weight_unit: 'lb',
    items: [{ description: 'Al combo', gross_weight: 1000, tare_weight: 0, price: 1 }],
});
await outbound.addOutboundLoad({
    date: '2026-09-15', buyer: 'Eccomelt', weight_unit: 'lb',
    items: [{ description: 'Al combo', gross_weight: 600, tare_weight: 0, price: 2 }],
    linked_inbound_load_ids: [bought.id],
});
await outbound.addOutboundLoad({
    date: '2026-09-16', buyer: 'Daekwang', weight_unit: 'lb',
    items: [{ description: 'Al combo', gross_weight: 200, tare_weight: 0, price: 2 }],
});

// ══════════════════════════════════════════════════════════════════════════
section('A — it can see sales at all');
// ══════════════════════════════════════════════════════════════════════════
{
    const reads = tools.readToolNames();
    ck('there is a way to search sales', reads.includes('find_sales'), reads.join(', '));
    ck('  a sales report', reads.includes('sales_report'), reads.join(', '));
    ck('  and a profit report', reads.includes('yard_profit'), reads.join(', '));

    // The tools that already existed must still be there. Adding knowledge
    // must not cost any.
    for (const had of ['find_loads', 'load_detail', 'inventory', 'item_lines', 'spend_report',
                       'find_expenses', 'trucker_bills', 'petty_cash']) {
        ck(`  ${had} is still there`, reads.includes(had), reads.join(', '));
    }

    // ── THE DESCRIPTION HAS TO STEER IT ──────────────────────────────────
    // A tool the model never picks is a tool that does not exist. find_loads
    // is the one it would reach for out of habit, so find_sales has to say
    // what find_loads does NOT cover.
    const d = tools.describeTools ? JSON.stringify(tools.describeTools()) : JSON.stringify(tools.TOOLS);
    ck('find_sales says it is for material going OUT', /shipped OUT|sold/i.test(d));
    ck('  and says find_loads does not cover it',
       /find_loads only covers purchases/i.test(d),
       'without this the model uses the tool it already knows and answers from half the data');
}

// ══════════════════════════════════════════════════════════════════════════
section('B — and the answers are right');
// ══════════════════════════════════════════════════════════════════════════
{
    const all = await tools.runRead('find_sales', {});
    ck('both sales come back', all.total === 2, JSON.stringify(all.total));

    const one = await tools.runRead('find_sales', { buyer: 'ecco' });
    ck('searching by part of a buyer name works', one.total === 1 && one.sales[0].buyer === 'Eccomelt',
       JSON.stringify(one.sales.map((s) => s.buyer)));
    ck('  case-insensitively', (await tools.runRead('find_sales', { buyer: 'ECCOMELT' })).total === 1);

    const ranged = await tools.runRead('find_sales', { from: '2026-09-16', to: '2026-09-16' });
    ck('  and by date range', ranged.total === 1 && ranged.sales[0].buyer === 'Daekwang',
       JSON.stringify(ranged.sales.map((s) => s.date)));

    const byItem = await tools.runRead('find_sales', { item: 'al combo' });
    ck('  and by item', byItem.total === 2, JSON.stringify(byItem.total));

    // A truncated list presented as the whole is how a confident wrong total
    // gets spoken aloud.
    const capped = await tools.runRead('find_sales', { limit: 1 });
    ck('a capped list still reports the true count',
       capped.total === 2 && capped.showing === 1,
       JSON.stringify({ total: capped.total, showing: capped.showing }));

    const rep = await tools.runRead('sales_report', {});
    ck('the sales report totals both buyers', rep.loadCount === 2 && rep.totalAmount === 1600,
       JSON.stringify({ loads: rep.loadCount, amount: rep.totalAmount }));
    ck('  and names them', (rep.byBuyer || []).map((b) => b.buyer).sort().join(',') === 'Daekwang,Eccomelt',
       JSON.stringify((rep.byBuyer || []).map((b) => b.buyer)));
}

// ══════════════════════════════════════════════════════════════════════════
section('C — the profit figure cannot be quoted without its caveat');
// ══════════════════════════════════════════════════════════════════════════
{
    const pf = await tools.runRead('yard_profit', {});

    // Only the Eccomelt sale is linked to the load it came from, so coverage
    // is partial by construction — which is the realistic case and the one
    // worth testing.
    ck('coverage is reported', pf.margin.coverage_pct !== undefined,
       JSON.stringify(pf.margin.coverage_pct));
    ck('  and it is partial in this fixture', pf.margin.coverage_pct < 100,
       `${pf.margin.coverage_pct}% — one of the two sales is unlinked`);
    ck('  with a caveat in words', typeof pf.margin.caveat === 'string' && pf.margin.caveat.length > 10,
       JSON.stringify(pf.margin.caveat));

    // ── HOISTED WHERE IT CANNOT BE MISSED ────────────────────────────────
    // The caveat existing two keys deep beside the figure is not enough. An
    // assistant reads the object, finds `margin`, and answers.
    ck('the tool hoists the caveat to the top of its reply', !!pf._how_to_answer,
       Object.keys(pf).join(', '));
    ck('  and tells it to say both in the same breath',
       /same breath/i.test(pf._how_to_answer), pf._how_to_answer);
    ck('  carrying the actual caveat text, not a generic warning',
       pf.margin.caveat ? pf._how_to_answer.includes(pf.margin.caveat) : true,
       pf._how_to_answer);

    // The cash block is the number most likely to be misread as profit, and
    // it is the one that would make her stop buying in a good month.
    ck('the cash block is flagged as NOT profit', /NOT profit/i.test(pf._never), pf._never);
    ck('  and it says not to add it to the margin', /do not add it/i.test(pf._never), pf._never);
    ck('  while the block itself still carries its own note',
       /NOT profit/i.test(pf.cash.note),
       'the helper says it too — belt and braces, because this is the figure that changes behaviour');

    // EDGE YARD ONLY. The rule the whole app is arranged around.
    const d = JSON.stringify(tools.describeTools ? tools.describeTools() : tools.TOOLS);
    ck('the profit tool declares itself Edge Yard only', /EDGE YARD ONLY/i.test(d),
       'an assistant that adds this to an Edge Metals figure produces a number describing no company');
}

// ══════════════════════════════════════════════════════════════════════════
section('D — nothing new can write');
// ══════════════════════════════════════════════════════════════════════════
{
    // All three are reads. "Complete knowledge" is about what it can SEE; an
    // assistant that gained the ability to record a sale as a side effect of
    // being told to know more would be a different and much larger decision.
    const writes = tools.writeToolNames();
    for (const t of ['find_sales', 'sales_report', 'yard_profit']) {
        ck(`${t} is read-only`, !writes.includes(t), writes.join(', '));
    }
    ck('  and the write list is unchanged',
       writes.sort().join(',') === ['record_payment', 'add_trucker_bill', 'add_expense'].sort().join(','),
       writes.join(', '));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }

})().catch((e) => { console.error(e); process.exit(1); });
