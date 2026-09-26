// ── tests/claims-sheet-import.js — importing the Weight Shortage tab ─────────
// Runs the real script as a child process against a fixture that reproduces the
// five things that actually go wrong on the live tab, then reads the store back.
//
// The one that matters most: in the legacy 2025 block the column headed
// "Amount" is what the customer claims from Edge and "Claim Amount" is what Edge
// claims back from the supplier — the reverse of every other block, where they
// are "Claim amount" and "Our Claim". Reading those the wrong way round turns a
// cost into a recovery and the absorbed figure comes out wrong in both
// directions at once.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'weight-shortage-tab.csv');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-import-'));

let pass = 0, fail = 0; const failures = [];
const ck = (n, ok, extra) => { if (ok) { pass++; console.log('  PASS ', n); } else { fail++; failures.push(n); console.log('  FAIL ', n, extra === undefined ? '' : JSON.stringify(extra).slice(0, 220)); } };

// --no-ai on every run. The importer classifies with Gemini by default, and a
// suite that reaches the network is slow, flaky and different on every machine.
// The rules path is what is asserted here; the AI path is asserted in section G
// against a stubbed model.
const run = (args, dir) => execFileSync(process.execPath,
    [path.join(ROOT, 'scripts', 'claims-import-sheet.js'), `--csv=${FIXTURE}`, '--no-ai', ...args],
    { cwd: ROOT, env: { ...process.env, DATA_DIR: dir, JARVIS_TEST: '1' }, encoding: 'utf8' });

(async () => {

console.log('\n=== A — a dry run writes nothing ===');
{
    const dir = fs.mkdtempSync(path.join(TMP, 'dry-'));
    const out = run([], dir);
    ck('it says plainly that nothing was written', /DRY RUN — nothing written/.test(out));
    ck('and that it will not nag anyone either way', /No to-do is raised and no WhatsApp is sent/.test(out));
    ck('no claims file was created', !fs.existsSync(path.join(dir, 'claims.json')));
    ck('no tasks file was created', !fs.existsSync(path.join(dir, 'tasks.json')));
}

console.log('\n=== B — the legacy block\'s reversed money columns ===');
{
    const dir = fs.mkdtempSync(path.join(TMP, 'legacy-'));
    const out = run([], dir);
    ck('it reports which header it read each figure from',
        /claim against Edge ← "Amount"\s+recovery from supplier ← "Claim Amount"/.test(out), out.split('\n').slice(0, 8));
    ck('and that the legacy supplier hides under "Buyer"', /supplier ← "Buyer"/.test(out));
    run(['--really'], dir);
    const rows = JSON.parse(fs.readFileSync(path.join(dir, 'claims.json'), 'utf8'));
    const varo = rows.find((r) => r.invoice_no === '25VT03');
    ck('the customer claim is the "Amount" column', varo && varo.claim_amount === 341.25, varo && varo.claim_amount);
    ck('the recovery is the "Claim Amount" column', varo && varo.our_claim === 310.775, varo && varo.our_claim);
    ck('"Buyer" was read as the supplier, not the customer', varo && varo.supplier === 'Gomez' && varo.customer === 'Varo Trading', varo && { s: varo.supplier, c: varo.customer });
    ck('a paid note becomes settled, not open', varo && varo.status === 'settled', varo && varo.status);
}

console.log('\n=== C — repeated rows merge; two real claims on one container do not ===');
{
    const dir = fs.mkdtempSync(path.join(TMP, 'merge-'));
    run(['--really'], dir);
    const rows = JSON.parse(fs.readFileSync(path.join(dir, 'claims.json'), 'utf8'));

    const st36 = rows.filter((r) => r.invoice_no === '25ST36');
    ck('the same claim entered twice becomes ONE claim', st36.length === 1, st36.length);
    ck('and keeps the more precise recovery of the two copies', st36[0] && st36[0].our_claim === 706.18, st36[0] && st36[0].our_claim);

    const dk09 = rows.filter((r) => r.invoice_no === '25DK09');
    ck('a blank copy and a filled copy become one claim', dk09.length === 1, dk09.length);
    ck('the amount comes from the copy that has one', dk09[0] && dk09[0].claim_amount === 124.02, dk09[0] && dk09[0].claim_amount);
    ck('and the tonnage-scale weights win over the pounds-scale copy',
        dk09[0] && dk09[0].invoice_weight === 23.718 && dk09[0].weight_unit === 'MT', dk09[0] && { w: dk09[0].invoice_weight, u: dk09[0].weight_unit });

    const me07 = rows.filter((r) => r.invoice_no === '26ME07');
    ck('one container with two DIFFERENT claim amounts stays two claims', me07.length === 2, me07.length);
    ck('and both amounts survive', me07.map((r) => r.claim_amount).sort((a, b) => a - b).join(',') === '450,3100', me07.map((r) => r.claim_amount));
}

console.log('\n=== D — the unit is never invented ===');
{
    const dir = fs.mkdtempSync(path.join(TMP, 'unit-'));
    const out = run(['--really'], dir);
    const rows = JSON.parse(fs.readFileSync(path.join(dir, 'claims.json'), 'utf8'));
    const ala = rows.find((r) => r.invoice_no === '26Ala04');
    ck('a weight far outside tonnage range gets NO unit', ala && ala.weight_unit === null, ala && ala.weight_unit);
    ck('it is flagged for a person', ala && ala.flags.includes('unit_not_stated'));
    ck('and the reason is written on the claim', ala && /out of tonnage range/.test(ala.note || ''), ala && ala.note);
    ck('the dry-run report lists every such row', /UNIT LEFT BLANK/.test(out) && /26Ala04/.test(out));
    const jy = rows.find((r) => r.invoice_no === '26JY03');
    ck('a normal container tonnage does get MT', jy && jy.weight_unit === 'MT', jy && jy.weight_unit);
    ck('the sheet figure is kept as recorded, not recomputed', jy && jy.claim_amount === 639.86 && jy.our_claim === 580, jy && { c: jy.claim_amount, o: jy.our_claim });
}

console.log('\n=== E — prose in the identifier columns is not imported as a claim ===');
{
    const dir = fs.mkdtempSync(path.join(TMP, 'prose-'));
    const out = run(['--really'], dir);
    const rows = JSON.parse(fs.readFileSync(path.join(dir, 'claims.json'), 'utf8'));
    ck('it is listed for entering by hand', /NOT IMPORTED/.test(out) && /conatiner damage/.test(out));
    ck('and no claim was created from it', !rows.some((r) => /conatiner damage/i.test(r.invoice_no) || /conatiner damage/i.test(r.customer)));
}

console.log('\n=== F — nobody is notified, and re-running changes nothing ===');
{
    const dir = fs.mkdtempSync(path.join(TMP, 'idem-'));
    run(['--really'], dir);
    const first = JSON.parse(fs.readFileSync(path.join(dir, 'claims.json'), 'utf8'));
    ck('no to-do was raised for any imported claim',
        !fs.existsSync(path.join(dir, 'tasks.json')) || JSON.parse(fs.readFileSync(path.join(dir, 'tasks.json'), 'utf8')).length === 0);
    ck('every imported claim records where it came from',
        first.every((r) => r.created_by === 'sheet-import'
            && (r.history || []).some((h) => /imported from the Weight Shortage tab, row \d+/.test(h.what))),
        first.slice(0, 1).map((r) => r.history));

    const out2 = run(['--really'], dir);
    const second = JSON.parse(fs.readFileSync(path.join(dir, 'claims.json'), 'utf8'));
    ck('a second run imports nothing new', second.length === first.length, { first: first.length, second: second.length });
    ck('and says so', /already in the register/.test(out2));
}

console.log('\n=== G — not every container has the same kind of claim ===');
{
    const dir = fs.mkdtempSync(path.join(TMP, 'kind-'));
    const out = run(['--really'], dir);
    const rows = JSON.parse(fs.readFileSync(path.join(dir, 'claims.json'), 'utf8'));
    const kindOf = (inv, amt) => {
        const m = rows.filter((r) => r.invoice_no === inv && (amt === undefined || r.claim_amount === amt));
        return m.length === 1 ? m[0].claim_type : `${m.length} matches`;
    };
    ck('a plain shortage row is a weight shortage', kindOf('25VT03') === 'weight_shortage', kindOf('25VT03'));
    ck('"Hand Tools found" is foreign material, not a shortage', kindOf('26ME07', 450) === 'foreign_material', kindOf('26ME07', 450));
    ck('"52% Recovery Promised" is a recovery shortfall', kindOf('26ME07', 3100) === 'recovery_shortfall', kindOf('26ME07', 3100));
    ck('the engine-combo block is a grade downgrade, read from its COLUMN HEADINGS',
        kindOf('26MK47') === 'grade_downgrade', kindOf('26MK47'));
    ck('one container, two claims, two different kinds',
        rows.filter((r) => r.container_no === 'TEMU7944250').map((r) => r.claim_type).sort().join(',') === 'foreign_material,recovery_shortfall',
        rows.filter((r) => r.container_no === 'TEMU7944250').map((r) => r.claim_type));
    ck('the report breaks the import down by kind', /KIND OF CLAIM/.test(out) && /grade downgrade/.test(out));
    ck('and lists what would otherwise have been mislabelled', /NOT a weight shortage/.test(out));
    ck('how each kind was decided is kept on the claim',
        rows.filter((r) => r.claim_type !== 'weight_shortage').every((r) => (r.quotes || {}).claim_type),
        rows.filter((r) => !(r.quotes || {}).claim_type).map((r) => r.invoice_no));
    ck('nothing is left as a bare default', !rows.some((r) => !r.claim_type));
}

console.log('\n=== H — the classifier falls back rather than mislabelling ===');
{
    const claimKind = require(path.join(ROOT, 'helpers', 'claimKind'));
    const gemini = require(path.join(ROOT, 'helpers', 'gemini'));
    const real = gemini.callGeminiJSON;
    const text = 'Reg/Al Engine claim | Reg.Engine& Steel haed Combo | Alu.Engine Combo | 4.75 | 570';

    gemini.callGeminiJSON = async () => ({ type: 'grade_downgrade', quote: 'Alu.Engine Combo', confidence: 0.9, why: 'engine combos repriced' });
    let r = await claimKind.classify(text);
    ck('a confident, quoted answer is taken from the model', r.by === 'ai' && r.type === 'grade_downgrade', r);

    gemini.callGeminiJSON = async () => ({ type: 'damage', quote: 'the container was crushed', confidence: 0.95, why: 'x' });
    r = await claimKind.classify(text);
    ck('an answer quoting words that are NOT in the row is refused', r.by === 'rules' && r.droppedQuote, r);
    ck('and the rules answer takes over', r.type === 'grade_downgrade', r.type);

    gemini.callGeminiJSON = async () => ({ type: 'damage', quote: 'Alu.Engine Combo', confidence: 0.2, why: 'x' });
    r = await claimKind.classify(text);
    ck('a low-confidence answer falls back to the rules', r.by === 'rules' && r.aiConfidence === 0.2, r);

    gemini.callGeminiJSON = async () => { throw new Error('quota'); };
    r = await claimKind.classify(text);
    ck('a failed call falls back instead of throwing', r.by === 'rules' && r.aiError === 'quota', r);

    gemini.callGeminiJSON = async () => ({ type: 'not_a_real_kind', confidence: 0.99 });
    r = await claimKind.classify(text);
    ck('a kind outside the closed set is never stored', claimKind.TYPES.includes(r.type) && r.by === 'rules', r);

    gemini.callGeminiJSON = async () => null;
    r = await claimKind.classify('Varo Trading | 21.192 | 21.01 | 0.182', { hasWeights: true, shortage: 0.182 });
    ck('with no model at all, weights and a difference still read as a shortage', r.type === 'weight_shortage', r);
    r = await claimKind.classify('Some row | Kalawar | 1210', {});
    ck('and a row that says nothing is "other", never a guess', r.type === 'other', r);

    gemini.callGeminiJSON = real;
    ck('a commodity heading does not become contamination',
        claimKind.byRules('ROTORS AND DRUMS | Cont No. Gross Received Shortage in MT | 23.718 | 23.4 | 0.318', { hasWeights: true, shortage: 0.318 }).type === 'weight_shortage');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  Failed:'); failures.forEach((f) => console.log('   - ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('\nTEST CRASHED:', e && e.stack || e); process.exit(1); });
