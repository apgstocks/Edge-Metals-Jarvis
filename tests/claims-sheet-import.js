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
// Isolate the PARENT process too, before anything from the repo is required.
// Only the child runs used to get a DATA_DIR, so section H's in-process calls
// wrote the vocabulary straight into the real data directory.
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
const _cfg = require(path.join(ROOT, 'config.js'));
if (!String(_cfg.DATA_DIR).startsWith(TMP)) {
    console.error('ABORT — DATA_DIR did not land in the temp dir; refusing to touch real data');
    process.exit(1);
}

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
            && (r.history || []).some((h) => /imported from .+, row \d+/.test(h.what))),
        first.slice(0, 1).map((r) => r.history));

    const out2 = run(['--really'], dir);
    const second = JSON.parse(fs.readFileSync(path.join(dir, 'claims.json'), 'utf8'));
    ck('a second run imports nothing new', second.length === first.length, { first: first.length, second: second.length });
    ck('and says so', /already in the register/.test(out2));
}

console.log('\n=== E2 — the sheet says where the current year starts ===');
{
    // Apsara, 2026-09-26: "I need to have the rows which comes after 2026
    // claims .. there is a row with that." The tab keeps closed years above a
    // one-cell marker row, and those are not hers to import any more.
    const YEARS = path.join(__dirname, 'fixtures', 'weight-shortage-years.csv');
    const runY = (args, dir) => execFileSync(process.execPath,
        [path.join(ROOT, 'scripts', 'claims-import-sheet.js'), `--csv=${YEARS}`, '--no-ai', ...args],
        { cwd: ROOT, env: { ...process.env, DATA_DIR: dir, JARVIS_TEST: '1' }, encoding: 'utf8' });

    const dir = fs.mkdtempSync(path.join(TMP, 'years-'));
    const out = runY(['--really'], dir);
    const rows = JSON.parse(fs.readFileSync(path.join(dir, 'claims.json'), 'utf8'));
    ck('only the rows after the marker are imported', rows.length === 2, rows.map((r) => r.invoice_no));
    ck('the 2025 block above it is left alone',
        !rows.some((r) => ['25VT03', '25ST17', '25RMT25'].includes(r.invoice_no)), rows.map((r) => r.invoice_no));
    ck('and the 2026 rows are all there', rows.map((r) => r.invoice_no).sort().join(',') === '26JY03,26MT06');
    ck('it says where it started and how much it skipped',
        /Starting at row 7, just after "2026 Claims" — 4 row\(s\) above it ignored/.test(out), out.split('\n').slice(0, 6));
    ck('the money is only the current year\'s', /claimed \$961\.07/.test(out), out.split('\n').filter((l) => /TOTALS/.test(l)));

    // The old behaviour is still reachable, for a restored sheet.
    const dir2 = fs.mkdtempSync(path.join(TMP, 'years2-'));
    runY(['--from-row=1', '--really'], dir2);
    const all = JSON.parse(fs.readFileSync(path.join(dir2, 'claims.json'), 'utf8'));
    ck('--from-row=1 reads the whole sheet again', all.length === 5, all.length);

    // Next January someone adds "2027 Claims"; the boundary must move with it and
    // nothing in the code should need editing.
    const dir3 = fs.mkdtempSync(path.join(TMP, 'years3-'));
    const two = fs.readFileSync(YEARS, 'utf8') + '\n,,,,,,,,,,,,\n2027 Claims,,,,,,,,,,,,\n' +
        'Supplier,date,Inv Nbr,Container number,Inv Weight,Inv Price,Total Amt,Loading photos,Customer Name,Claimed Weight,Difference,Claim amount,Our Claim\n' +
        'Gomez,01/09/2027,27AA01,TEMU1234567,20.0,2000,40000,Photos,Someone,19.5,0.5,1000,900\n';
    const f3 = path.join(dir3, 'two-years.csv');
    fs.writeFileSync(f3, two);
    const out3 = execFileSync(process.execPath,
        [path.join(ROOT, 'scripts', 'claims-import-sheet.js'), `--csv=${f3}`, '--no-ai', '--really'],
        { cwd: ROOT, env: { ...process.env, DATA_DIR: dir3, JARVIS_TEST: '1' }, encoding: 'utf8' });
    const r3 = JSON.parse(fs.readFileSync(path.join(dir3, 'claims.json'), 'utf8'));
    ck('with two markers it starts after the LAST one', r3.length === 1 && r3[0].invoice_no === '27AA01', r3.map((r) => r.invoice_no));
    ck('and names that marker', /just after "2027 Claims"/.test(out3));

    // A sheet with no marker must behave exactly as before.
    const dir4 = fs.mkdtempSync(path.join(TMP, 'years4-'));
    const out4 = run(['--really'], dir4);
    ck('a sheet with no marker still reads from the top',
        JSON.parse(fs.readFileSync(path.join(dir4, 'claims.json'), 'utf8')).length >= 9
        && !/Starting at row/.test(out4));
}

console.log('\n=== G — with no model, nothing is guessed ===');
{
    // The importer is run with --no-ai throughout this suite, so no test here
    // reaches the network. That makes this section the important one: when the
    // model is not asked, every claim must come out UNCLASSIFIED and say so.
    // The old version had a table of regexes to fall back on; it guessed
    // confidently and got eleven containers wrong.
    const dir = fs.mkdtempSync(path.join(TMP, 'noai-'));
    const out = run(['--really'], dir);
    const rows = JSON.parse(fs.readFileSync(path.join(dir, 'claims.json'), 'utf8'));
    ck('every claim imported', rows.length >= 9, rows.length);
    ck('none of them was given a kind', rows.every((r) => r.claim_type === null), rows.filter((r) => r.claim_type).map((r) => r.invoice_no));
    ck('and every one is flagged so a person can see it', rows.every((r) => (r.flags || []).includes('kind_unknown')));
    ck('the report says how many and why', /NOT classified/.test(out) && /not asked/.test(out), out.split('\n').filter((l) => /classified/.test(l)));
    ck('it points at the way to fix it', /--reclassify/.test(out));
    ck('no vocabulary was invented either', !fs.existsSync(path.join(dir, 'claim_kinds.json'))
        || JSON.parse(fs.readFileSync(path.join(dir, 'claim_kinds.json'), 'utf8')).length === 0);
    ck('the money is unaffected by not knowing the kind', /TOTALS to import/.test(out));
}

console.log('\n=== G2 — reclassify never lets a non-answer overwrite a kind ===');
{
    const dir = fs.mkdtempSync(path.join(TMP, 'recl-'));
    run(['--really'], dir);
    const file = path.join(dir, 'claims.json');
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    rows[0].claim_type = 'weight_shortage';         // as if a model had named it earlier
    fs.writeFileSync(file, JSON.stringify(rows));
    const out = run(['--reclassify', '--really'], dir);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    ck('a recorded kind survives a run where the model cannot answer', after[0].claim_type === 'weight_shortage', after[0].claim_type);
    ck('and the run says it left them alone', /left alone because the model still could not say/.test(out));
    ck('reclassify imports nothing new', after.length === rows.length);
}

console.log('\n=== H — the model names the kinds, and says when it cannot ===');
{
    const claimKind = require(path.join(ROOT, 'helpers', 'claimKind'));
    const claimKinds = require(path.join(ROOT, 'helpers', 'claimKinds'));
    const gemini = require(path.join(ROOT, 'helpers', 'gemini'));
    const real = gemini.callGeminiJSON;
    const say = (o) => { gemini.callGeminiJSON = async () => o; };
    const ROW = 'Reg/Al Engine claim | Reg.Engine& Steel haed Combo | Alu.Engine Combo | 4.75 | 570';

    ck('the vocabulary starts empty — there is no list in the code', claimKinds.list().length === 0, claimKinds.list());

    say({ matches_existing: null, label: 'grade downgrade', description: 'part of the load was a cheaper grade', quote: 'Alu.Engine Combo', confidence: 0.9, why: 'engine combos repriced' });
    let d = await claimKind.decide(ROW);
    ck('the model names a kind and it is recorded', d.slug === 'grade_downgrade' && d.created === true, d);
    ck('the label is the model\'s words, not a slug', claimKinds.get('grade_downgrade').label === 'grade downgrade');

    // A different wording for the same argument must reuse the kind, because
    // "both are same meaning" is a judgement the model makes, not a synonym table.
    say({ matches_existing: 'grade_downgrade', label: 'grade downgrade', description: '', quote: 'Alu.Engine Combo', confidence: 0.9, why: 'same argument, different words' });
    d = await claimKind.decide(ROW);
    ck('a second claim meaning the same thing reuses the kind', d.slug === 'grade_downgrade' && d.created === false, d);
    ck('the vocabulary did not grow', claimKinds.list().length === 1, claimKinds.list().map((k) => k.slug));

    say({ matches_existing: null, label: 'recovery shortfall', description: 'yield below what was promised', quote: 'Alu.Engine Combo', confidence: 0.9, why: 'x' });
    d = await claimKind.decide(ROW);
    ck('a genuinely new kind is added', d.slug === 'recovery_shortfall' && d.created === true, d);
    ck('so the vocabulary grows as claims arrive', claimKinds.list().length === 2);

    say({ matches_existing: 'a_kind_that_never_existed', label: 'damage', description: '', quote: 'Alu.Engine Combo', confidence: 0.9, why: 'x' });
    d = await claimKind.decide(ROW);
    ck('a match against a slug that does not exist is treated as new, not trusted', d.slug === 'damage', d);

    say({ matches_existing: null, label: 'damage', description: '', quote: 'the container was crushed', confidence: 0.95, why: 'x' });
    d = await claimKind.decide(ROW);
    ck('a quote that is not in the row leaves the claim UNCLASSIFIED', d.slug === null && /not in the row/.test(d.unresolved), d);
    ck('and it records what the model would have said', d.wouldHaveSaid === 'damage', d);

    say({ matches_existing: null, label: 'damage', description: '', quote: 'Alu.Engine Combo', confidence: 0.2, why: 'x' });
    d = await claimKind.decide(ROW);
    ck('low confidence leaves it unclassified rather than guessing', d.slug === null && /not confident/.test(d.unresolved), d);

    say({ matches_existing: null, label: null, description: '', quote: '', confidence: 0.9, why: 'nothing here says' });
    d = await claimKind.decide('Some row | Kalawar | 1210');
    ck('a row that says nothing gets NO kind — never the commonest one', d.slug === null && /does not say/.test(d.unresolved), d);

    say(null);
    d = await claimKind.decide(ROW);
    ck('no answer at all is unclassified, not a fallback label', d.slug === null && /did not answer/.test(d.unresolved), d);

    gemini.callGeminiJSON = async () => { throw new Error('quota'); };
    d = await claimKind.decide(ROW);
    ck('a failed call is unclassified and never throws', d.slug === null && /the call failed/.test(d.unresolved), d);

    say({ matches_existing: null, label: 'this is a whole sentence about what the customer is complaining about at length', description: '', quote: 'Alu.Engine Combo', confidence: 0.9, why: 'x' });
    d = await claimKind.decide(ROW);
    ck('a sentence is refused as a label', d.slug === null && /a sentence, not a label/.test(d.unresolved), d);

    ck('nothing unclassified ever polluted the vocabulary', claimKinds.list().length === 3, claimKinds.list().map((k) => k.slug));

    // Drift is fixed by merging, which is hers to do — the code does not do it.
    const claims = require(path.join(ROOT, 'helpers', 'claims'));
    ck('two kinds can be folded into one', await (async () => {
        await claimKinds.ensure('short weight', 'less than invoiced');
        const before = claimKinds.list().length;
        await claimKinds.merge('short_weight', 'grade_downgrade');
        return claimKinds.list().length === before - 1;
    })());
    ck('and the folded name is kept as an alias so nothing becomes unreadable',
        (claimKinds.get('grade_downgrade').aliases || []).includes('short_weight'));
    ck('merging into a kind that does not exist is refused, in words', await (async () => {
        try { await claimKinds.merge('grade_downgrade', 'nope'); return false; }
        catch (e) { return /there is no kind/.test(e.message); }
    })());
    ck('a colour is derived from the slug, so a new kind needs no CSS',
        typeof claimKinds.hue('grade_downgrade') === 'number' && claimKinds.hue('a') !== claimKinds.hue('b'));

    gemini.callGeminiJSON = real;
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  Failed:'); failures.forEach((f) => console.log('   - ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('\nTEST CRASHED:', e && e.stack || e); process.exit(1); });
