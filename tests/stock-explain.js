// ── tests/stock-explain.js — "why is the stock of this item negative?" (Scout tool explain_stock) ──────────
// Apsara, 2026-11-15: "no guesses, only proper reasoning". Every claim the tool makes must be a figure on the books.
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-stockexp-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
const tools = require(path.join(ROOT, 'helpers/tools'));
const loads = require(path.join(ROOT, 'helpers/loads'));
const outbound = require(path.join(ROOT, 'helpers/outboundLoads'));
const { explainStock } = require(path.join(ROOT, 'helpers/stockExplain'));
const codes = (r) => r.findings.map((f) => f.code);
const buy = (date, desc, w, seller = 'S') => loads.addLoad({ date, seller, weight_unit: 'lb', items: [{ description: desc, gross_weight: w, tare_weight: 0, price: 1 }] });
const sell = (date, desc, w, buyer = 'B') => outbound.addOutboundLoad({ date, buyer, weight_unit: 'lb', items: [{ description: desc, gross_weight: w, tare_weight: 0, price: 2 }] });
const ask = (item) => tools.runRead('explain_stock', { item });

(async () => {
section('A. the tool exists, is read-only, and steers the model');
{
    ck('it is a READ tool, and not a write tool', tools.readToolNames().includes('explain_stock') && !tools.writeToolNames().includes('explain_stock'));
    const d = tools.TOOLS.explain_stock.description;
    ck('its description tells the model to say only what the findings state', /ONLY/.test(d) && /never guess/i.test(d));
}

section('B. a negative made by selling more than was bought');
{
    await buy('2026-10-01', 'Steel', 1000); await sell('2026-10-02', 'Steel', 800);
    await buy('2026-10-03', 'Steel', 500); await sell('2026-10-04', 'Steel', 900);
    const before = fs.readFileSync(cfg.LOADS_FILE, 'utf8') + fs.readFileSync(cfg.OUTBOUND_LOADS_FILE, 'utf8');
    const r = await ask('steel');
    ck('totals: bought 1500, sold 1700, on hand -200', r.status === 'ok' && r.totals.purchased === 1500 && r.totals.sold === 1700 && r.totals.onHand === -200, JSON.stringify(r.totals));
    ck('it finds the day the balance first ended below zero (10-04), with before/after', r.first_below_zero && r.first_below_zero.date === '2026-10-04' && r.first_below_zero.before === 700 && r.first_below_zero.after === -200, JSON.stringify(r.first_below_zero));
    ck('finding: sold exceeds bought, by the exact shortfall', codes(r).includes('sold_exceeds_bought') && r.findings.find((f) => f.code === 'sold_exceeds_bought').data.shortfall === 200);
    ck('it reconciles with the Inventory screen', r.reconcile.checked && r.reconcile.matches === true, JSON.stringify(r.reconcile));
    ck('it admits what the books cannot show', /never entered/.test(r.cannot_tell.join(' ')));
    ck('no finding invents a cause (no guess words)', !r.findings.some((f) => /probably|likely|maybe|might have/i.test(f.text)), JSON.stringify(r.findings.map((f) => f.text)));
    ck('it changed nothing on disk', before === fs.readFileSync(cfg.LOADS_FILE, 'utf8') + fs.readFileSync(cfg.OUTBOUND_LOADS_FILE, 'utf8'));
    const ok = await ask('Steel');
    ck('case does not matter', ok.totals.onHand === -200);
}

section('C. a sale dated before any purchase');
{
    await sell('2026-10-01', 'Copper', 300); await buy('2026-10-02', 'Copper', 100);
    const r = await ask('Copper');
    ck('first below zero is the sale day, and sale-before-purchase is stated', r.first_below_zero.date === '2026-10-01' && codes(r).includes('sale_before_any_purchase'), JSON.stringify(codes(r)));
    await sell('2026-10-05', 'Tin', 50);
    const t = await ask('Tin');
    ck('only sales, no purchase line at all, is said plainly', /no purchase line/i.test(t.findings.find((f) => f.code === 'sale_before_any_purchase').text));
}

section('D. the same material under two spellings: the number that LOOKS wrong');
{
    await buy('2026-10-01', 'EV Rotors', 1000); await sell('2026-10-02', 'EV Rotor', 1200);
    const r = await ask('EV Rotor');
    ck('sale-only name: on hand -1200', r.totals.onHand === -1200, JSON.stringify(r.totals));
    const sim = r.findings.find((f) => f.code === 'similar_names');
    ck('it points at "EV Rotors" with ITS figures, and does not decide they are the same', sim && sim.data.similar.some((s) => s.name === 'EV Rotors' && s.purchased === 1000 && s.onHand === 1000) && /cannot say/.test(sim.text), JSON.stringify(sim));
    const r2 = await ask('EV Rotors');
    ck('asked about the bought name, it shows the other one too', codes(r2).includes('similar_names') && r2.totals.onHand === 1000);
}

section('E. one item split into two screen rows (spelling differs only in punctuation)');
{
    await buy('2026-10-01', 'Al-combo', 500); await buy('2026-10-01', 'Al combo', 500); await sell('2026-10-02', 'al combo', 800);
    const r = await ask('Al combo');
    const split = r.findings.find((f) => f.code === 'screen_splits_this_item');
    ck('the screen shows two rows for it, and the tool says so with the numbers', !!split && split.data.rows.length === 2, JSON.stringify(r.reconcile) + JSON.stringify(codes(r)));
    ck('combined on-hand is 200', split && split.data.combined === 200 && r.totals.onHand === 200);
}

section('F. not found: candidates, never a pick');
{
    const r = await ask('Stee');
    ck('no exact match: status not_found, and it LISTS candidates', r.status === 'not_found' && r.candidates.some((c) => c.name === 'Steel'), JSON.stringify(r));
    ck('  and tells the model not to pick one', /do not pick/i.test(r.say));
    const z = await ask('Unobtainium');
    ck('a name nothing resembles: not found, no candidates', z.status === 'not_found' && !z.candidates.length);
    let e = null; try { await ask('  '); } catch (x) { e = x; }
    ck('a blank item is refused', !!e);
}

section('G. the pure function: facts that need hand-made rows');
{
    const mk = (id, date, desc, w, extra) => ({ id, date, seller: 'S', buyer: 'B', weight_unit: 'lb', items: [{ description: desc, net_weight: w, draws: (extra && extra.draws) || [] }], ...(extra && extra.top) });
    let r = explainStock({ inbound: [mk('L1', '2026-01-01', 'X', 0), mk('L2', null, 'X', 100)], outbound: [mk('O1', '2026-01-02', 'X', 50, { draws: [{ load_id: 'L2', weight: 80 }] })], item: 'X', aliasRows: [] });
    ck('a purchase line with no weight is named', codes(r).includes('purchase_without_weight') && r.findings.find((f) => f.code === 'purchase_without_weight').data.loads[0] === 'L1');
    ck('an undated line is in the totals but off the timeline, and named', r.totals.purchased === 100 && codes(r).includes('undated_lines') && r.timeline.lines === 2 && r.timeline.days === 2);
    ck('draws larger than the sale line is named', codes(r).includes('draws_exceed_sale'));
    r = explainStock({ inbound: [mk('L1', '2026-01-01', 'Y', 100, { top: { weight_unit: 'kg' } })], outbound: [], item: 'Y', aliasRows: [] });
    ck('a non-lb record is flagged as mixed units', codes(r).includes('mixed_units'));
    r = explainStock({ inbound: [mk('L1', '2026-01-01', 'Z', 100)], outbound: [mk('O1', '2026-01-02', 'Z', 30)], item: 'Z', aliasRows: [], screenRows: [{ description: 'Z', net: 100, shipped: 30, onHand: 999 }] });
    ck('if the screen disagrees with the ledger, that is reported loudly and not explained away', codes(r).includes('does_not_reconcile') && r.reconcile.matches === false && /no explanation here should be trusted/.test(r.findings.find((f) => f.code === 'does_not_reconcile').text));
    r = explainStock({ inbound: [mk('L1', '2026-01-01', 'Z', 100)], outbound: [mk('O1', '2026-01-01', 'Z', 130)], item: 'Z', aliasRows: [] });
    ck('same-day buys and sales: judged on the END-of-day balance, not an assumed order', r.first_below_zero && r.first_below_zero.before === 0 && r.first_below_zero.after === -30);
    const many = []; for (let i = 0; i < 200; i++) many.push(mk('M' + i, '2026-02-' + String(1 + (i % 27)).padStart(2, '0'), 'Q', 1));
    r = explainStock({ inbound: many, outbound: [], item: 'Q', aliasRows: [] });
    ck('a long history is capped, and says how many lines there are', r.timeline.lines === 200 && r.timeline.shown === 80 && r.timeline.latest.length === 80);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }
process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
