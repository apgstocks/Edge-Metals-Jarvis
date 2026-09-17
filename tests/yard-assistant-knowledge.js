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
section('D — the rest of the yard');
// ══════════════════════════════════════════════════════════════════════════
{
    // Apsara, on being told it could not see sales: "it should see everything".
    // So the remaining stores were audited against config.js rather than
    // guessed at, and what was still invisible got a read.
    const reads = tools.readToolNames();
    for (const [what, name] of [
        ['WhatsApp scale tickets', 'scale_tickets'],
        ['unfinished loads', 'load_drafts'],
        ['the material catalogue', 'item_catalogue'],
    ]) {
        ck(`it can see ${what}`, reads.includes(name), reads.join(', '));
    }

    const st = require(path.join(ROOT, 'helpers/scaleTickets'));
    await st.addScaleTicket({ from: '+15551234', weight: 4210, unit: 'lb', description: 'HMS', drive_link: 'https://d/x' });
    const tick = await tools.runRead('scale_tickets', {});
    ck('a scale ticket comes back', tick.total === 1, JSON.stringify(tick.total));
    ck('  saying there is a photo', tick.tickets[0].has_photo === true);
    // A base64 image in a tool result is an enormous payload for a question
    // the link already answers.
    ck('  without shipping the photo itself', !JSON.stringify(tick).includes('base64'),
       'the link answers the question; the bytes just cost money');

    const dr = require(path.join(ROOT, 'helpers/loadDrafts'));
    await dr.saveDraft({ seller: 'Half Typed Co', date: '2026-09-16', items: [{ description: 'Zorba', gross_weight: 100 }] });
    const drafts = await tools.runRead('load_drafts', {});
    ck('an unfinished load is visible', drafts.total === 1 && drafts.drafts[0].seller === 'Half Typed Co',
       JSON.stringify(drafts.drafts));
    ck('  summarised rather than dumped', drafts.drafts[0].items === 1 && !drafts.drafts[0].gross_photo_link,
       'a draft carries the whole half-typed form; what answers the question is whose it is and how far it got');

    // ── THE CATALOGUE, AND WHOSE ANSWERS COUNT ───────────────────────────
    const it = require(path.join(ROOT, 'helpers/itemTypes'));
    const al = require(path.join(ROOT, 'helpers/itemAliases'));
    await it.addCustomItemType('Al combo');
    await it.addCustomItemType('Aluminium combo');
    await al.remember('Al combo', 'Aluminium combo', true, { source: 'user' });
    await al.remember('Al 6061', 'Al 6063', false, { source: 'user' });
    await al.remember('HMS', 'Zorba', true, { source: 'ai' });

    const cat = await tools.runRead('item_catalogue', {});
    ck('the material list comes back', cat.descriptions.length > 0, `${cat.descriptions.length}`);
    const pairs = JSON.stringify(cat.same_metal);
    ck('  her YES is in same_metal', /Al combo.*Aluminium combo/.test(pairs), pairs);
    ck('  her NO is NOT', !/6061/.test(pairs),
       pairs + ' — shipping a "these are different" in a list called same_metal inverts her answer');
    ck('  and an AI guess is NOT', !/Zorba/.test(pairs),
       pairs + ' — one wrong machine verdict would become a merged pile in every answer');
    ck('  with the rule stated for the model',
       /different alloys/i.test(cat._note || ''), cat._note);

    // ── WHAT CUSTOMERS OWE HER ───────────────────────────────────────────
    // Once sales are visible at all, this is the next question anyone asks.
    const payments = require(path.join(ROOT, 'helpers/payments'));
    const sales = (await tools.runRead('find_sales', {})).sales;
    const ecco = sales.find((s) => s.buyer === 'Eccomelt');
    // paid_via is REQUIRED for a Bank transfer on a sale since 2026-09-16 —
    // Apsara: "For receive payment also,add paid to Edge Yard,Edge Metals".
    // This fixture is not testing that rule, it is testing that sales carry
    // their payment state; it just has to satisfy it like the real screen does.
    await payments.addPayment({ load_id: ecco.id, load_kind: 'sale', mode: 'Bank transfer',
                                bank: 'Chase Bank', paid_via: 'Edge Yard',
                                amount: 1200, paid_on: '2026-09-16' });
    const all = await tools.runRead('find_sales', {});
    ck('every sale carries what is still owed on it', all.sales.every((s) => s.payment),
       'listing sales without payment state answers half the question');
    const owed = await tools.runRead('find_sales', { unpaid_only: true });
    ck('  and unpaid_only narrows to those still owing',
       owed.total === 1 && owed.sales[0].buyer === 'Daekwang',
       JSON.stringify(owed.sales.map((s) => s.buyer)));
}

// ══════════════════════════════════════════════════════════════════════════
section('E — but NOT Edge Metals');
// ══════════════════════════════════════════════════════════════════════════
{
    // "Everything" means everything YARD. Edge Metals is a different company,
    // and an assistant that can read both is one answer away from a figure
    // that describes neither — the mistake this whole app is arranged around.
    //
    // Asserted at the SOURCE, because the failure is a require() somebody adds
    // without thinking, not a wrong number that shows up in a fixture.
    const src = fs.readFileSync(path.join(ROOT, 'helpers/tools.js'), 'utf8')
        .replace(/^[ \t]*\/\/.*$/gm, '');   // comments stripped: they NAME these stores
    for (const metals of ['bills', 'salesReceipts', 'salesSettlements', 'metalsTrucking',
                          'edgeInventory', 'bols', 'packingList', 'margin']) {
        ck(`the assistant cannot read Edge Metals ${metals}`,
           !new RegExp(`require\\('\\./${metals}'\\)`).test(src),
           `helpers/${metals}.js is Edge Metals — adding it here mixes two companies' books`);
    }
    // helpers/sales.js is Edge Metals INVOICES, not yard sales. The names
    // collide and that is exactly how this mistake would get made.
    ck('  nor Edge Metals invoices (helpers/sales.js)',
       !/require\('\.\/sales'\)/.test(src),
       'yard sales are helpers/outboundLoads.js; helpers/sales.js is the Edge Metals invoice register');
}

// ══════════════════════════════════════════════════════════════════════════
section('F — nothing new can write');
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
