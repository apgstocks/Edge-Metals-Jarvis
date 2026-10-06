// ── tests/fill-money-blanks.js ────────────────────────────────────────────
// Apsara, 2026-10-06, from her nightly sweep: nine containers whose
// supplier_price and supplier_invoice_amount are BLANK in Jarvis while the
// sheet holds a real figure. About $367,000 of supplier cost missing, which
// means profit — and therefore tax — overstated by the same amount.
//
// The machinery to find them already existed (metalsSheetSync's
// fillableBills) and the machinery to write them already existed
// (ledgerAgent.apply). What stood between was classify()'s refusal to touch
// money, which is CORRECT: a sheet must not silently rewrite her costs.
//
// So this is about one new flag, `allowMoney`, and the thing that matters
// most is what it does NOT relax.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-fillmoney-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated — refusing to run against real data');
    process.exit(1);
}

const agent = require(path.join(ROOT, 'helpers/ledgerAgent'));

const moneyFix = (over = {}) => ({
    ledger: 'bills', row_id: 'B1', container_no: 'HMMU6872607', supplier: 'Inesh Cores Chapin',
    fix: { field: 'supplier_invoice_amount', to: 59544.8, from_source: 'the Edge Metals sheet', ...over },
});

(async () => {

// ── A — THE NIGHTLY RULE IS UNCHANGED ─────────────────────────────────────
// The flag defaults false. The 07:30 agent passes nothing and must still be
// unable to write a money field — that refusal is the rule, not an accident.
{
    section('A — the 07:30 agent still cannot touch money');

    ck('a money field is still never SETTLED',
       agent.classify(moneyFix().fix) === agent.PROPOSED,
       'classify is what the nightly agent trusts, and it has not moved');
    ck('  because the field really is money',
       agent.touchesMoney(moneyFix().fix) === true,
       JSON.stringify(agent.MONEY_FIELDS));

    const stores = { bills: { list: () => [{ id: 'B1', supplier_invoice_amount: '' }], edit: () => { throw new Error('WROTE'); } } };
    const res = await agent.apply([moneyFix()], { kinds: stores });
    ck('apply() with no flag writes nothing',
       res.applied.length === 0 && res.skipped.length === 1, JSON.stringify(res.skipped.map((s) => s.why)));
    ck('  and says it was not settled', res.skipped[0].why === 'not settled', res.skipped[0].why);
}

// ── B — WITH THE FLAG, AND ONLY THE MONEY TEST RELAXES ────────────────────
// This is the check that matters most. `allowMoney` must let through a fix
// that is proposed ONLY because it touches money — and nothing else. A fix
// with no value or no provenance is not "money needs consent", it is "we do
// not know the answer", and consent cannot cure that.
{
    section('B — allowMoney relaxes one test, not the rest');

    const wrote = [];
    const stores = () => ({ bills: {
        list: () => [{ id: 'B1', supplier_invoice_amount: '' }],
        edit: (id, patch) => { wrote.push({ id, patch }); },
    } });

    let res = await agent.apply([moneyFix()], { kinds: stores(), allowMoney: true });
    ck('a money fill IS applied with the flag', res.applied.length === 1, JSON.stringify(res));
    ck('  and it really wrote the figure',
       wrote.length === 1 && wrote[0].patch.supplier_invoice_amount === 59544.8, JSON.stringify(wrote));

    // Everything classify() refuses for a reason OTHER than money stays refused.
    for (const [label, over] of [
        ['no value', { to: '' }],
        ['null value', { to: null }],
        ['no provenance', { from_source: '' }],
        ['an explicit needs_her', { needs_her: true }],
        ['no field named', { field: '' }],
    ]) {
        const r = await agent.apply([moneyFix(over)], { kinds: stores(), allowMoney: true });
        ck(`  still refused: ${label}`, r.applied.length === 0 && r.skipped.length === 1,
           JSON.stringify(r.skipped.map((s) => s.why)));
    }

    // A NON-money fix is unaffected either way — the flag must not change
    // how anything else is judged.
    const plain = { ledger: 'bills', row_id: 'B1',
        fix: { field: 'seal_no', to: 'ABC123', from_source: 'the Edge Metals sheet' } };
    ck('a non-money fix is settled with or without the flag',
       agent.classify(plain.fix) === agent.SETTLED, agent.classify(plain.fix));
}

// ── C — THE GUARDS THAT MUST STILL BITE ───────────────────────────────────
// allowMoney is consent to write a cost figure. It is NOT consent to write
// behind QuickBooks, nor to overwrite something she has since typed.
{
    section('C — consent to fill is not consent to overwrite');

    // Already filled in: a second run must not overwrite her own entry.
    const stores = { bills: {
        list: () => [{ id: 'B1', supplier_invoice_amount: 41000 }],
        edit: () => { throw new Error('WROTE OVER HER NUMBER'); },
    } };
    const res = await agent.apply([moneyFix()], { kinds: stores, allowMoney: true });
    ck('a field she has since filled is NOT overwritten',
       res.applied.length === 0 && /already filled in/.test(res.skipped[0].why), JSON.stringify(res.skipped));
    ck('  and it shows her what is there', /41000/.test(res.skipped[0].why), res.skipped[0].why);

    const gone = await agent.apply([moneyFix()], {
        kinds: { bills: { list: () => [], edit: () => { throw new Error('WROTE'); } } }, allowMoney: true });
    ck('a row that has been deleted is skipped', /row is gone/.test(gone.skipped[0].why), gone.skipped[0].why);

    const noId = await agent.apply([{ ...moneyFix(), row_id: '' }], {
        kinds: { bills: { list: () => [], edit: () => {} } }, allowMoney: true });
    ck('  and so is a finding with no row to write to',
       /no row id/.test(noId.skipped[0].why), noId.skipped[0].why);

    // The QuickBooks gate lives in apply() and is NOT duplicated in the
    // script — that was the whole reason for putting the flag here rather
    // than writing a second apply loop.
    const src = fs.readFileSync(path.join(ROOT, 'helpers/ledgerAgent.js'), 'utf8');
    ck('the QuickBooks gate is still in the shared apply',
       /qb\.linkedRow/.test(src) && /fails CLOSED|fail CLOSED|fails closed/i.test(src),
       'a row already in QuickBooks must never be filled behind her books');
}

// ── D — THE SCRIPT WRITES NOTHING WITHOUT BEING TOLD ──────────────────────
{
    section('D — audit first, the way she asked');

    const p = path.join(ROOT, 'scripts/fill-money-blanks.js');
    ck('the script exists', fs.existsSync(p));
    const src = fs.readFileSync(p, 'utf8');

    ck('  --apply is required to write anything',
       /const APPLY = process\.argv\.includes\('--apply'\)/.test(src)
       && /if \(!APPLY\)[\s\S]{0,200}process\.exit\(0\)/.test(src),
       'the default run must show and stop');
    ck('  it prints the total that is missing',
       /TOTAL supplier cost currently missing/.test(src),
       'one number is what makes 18 blank fields mean something');
    ck('  and says what that total does to profit',
       /profit overstated/.test(src), 'cost missing means tax overstated, and she should see that said');

    ck('  it uses the agent\'s own MONEY_FIELDS, not its own list',
       /agent\.MONEY_FIELDS/.test(src), 'two lists would disagree about what counts as money');
    // Comments stripped for the negative: the header explains that the
    // AGENT writes through bills.editBill, and a check that cannot tell
    // prose from code fails on its own documentation. Third time today.
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    ck('  it writes through ledgerAgent.apply, not the stores directly',
       /agent\.apply\(findings, \{ allowMoney: true \}\)/.test(code)
       && !/editBill|mutateJson|writeFile/.test(code),
       'the QuickBooks gate and the already-filled guard live there');
    ck('  and it gives every fix a provenance',
       /from_source: 'the Edge Metals sheet'/.test(src),
       'classify still refuses a value that cannot say where it came from');

    // It must take the blanks from the sync rather than re-deriving them.
    ck('  the blanks come from metalsSheetSync, not a second comparison',
       /helpers\/metalsSheetSync/.test(src) && /fillableBills/.test(src),
       'a second comparison would drift from the nightly one she reads');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('threw:', e && e.stack); process.exit(1); });
