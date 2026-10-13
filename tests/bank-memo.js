// ── tests/bank-memo.js ────────────────────────────────────────────────────
// Apsara, 2026-10-13: a wire's description "is not showing fully in bank …
// only half is shown even after clicking and expanding".
//
// Cause: the sync never asked Plaid for original_description, so only Plaid's
// shortened `name` ever arrived. The fix adds a SEPARATE `memo` rather than
// lengthening `desc`, because desc is part of bankRelink.keyOf — lengthening
// it would stop old short rows pairing with fresh long ones on a re-link.
// Most of this file defends that choice.
const fs = require('fs');
const os = require('os');
const path = require('path');
let pass = 0, fail = 0; const failures = [];
const ck = (l, ok, d) => { if (ok) { pass += 1; console.log('  PASS  ' + l); } else { fail += 1; failures.push(l); console.log('  FAIL  ' + l); if (d) console.log('        ' + d); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-memo-'));
process.env.DATA_DIR = TMP; process.env.JARVIS_TEST = '1';
const ROOT = path.join(__dirname, '..');
const L = require(path.join(ROOT, 'helpers/bankLedger'));
const RL = require(path.join(ROOT, 'helpers/bankRelink'));
const BR = require(path.join(ROOT, 'helpers/bankReview'));

const SHORT = 'FMC MetalWIRE TYPE:WIRE IN DATE: 261009 TIME:1459 ET TRN:XXXXXXXXXX523570 SEQ:XXXXXXXXXX136616/599117 ORIG:75S CORP ID:XXXXXXXXXX05436 SND BK:WELLS FARG O BANK NA ID:0407 PMT DET:3119';
const FULL = SHORT + '47 INV 260905-ME-SC';
const tx = (over) => ({ transaction_id: 'T1', account_id: 'A1', date: '2026-10-09', amount: -18000, name: SHORT, ...over });

{
    section('A — the full text is kept, desc is not touched');
    const withFull = L.fromPlaid(tx({ original_description: FULL }), []);
    ck('memo holds the bank\'s full text', withFull.memo === FULL, withFull.memo);
    ck('desc is STILL the short form (relink key depends on it)', withFull.desc === SHORT, withFull.desc);
    ck('no original_description → memo empty, nothing invented', L.fromPlaid(tx({}), []).memo === '');
    ck('original identical to name → memo empty (nothing to add)', L.fromPlaid(tx({ original_description: SHORT }), []).memo === '');
    ck('only original_description present → desc still falls back to it', L.fromPlaid(tx({ name: '', original_description: FULL }), []).desc === FULL);
}
{
    section('B — a re-link still pairs old short rows with fresh long ones');
    const old = L.fromPlaid(tx({}), []);
    const fresh = L.fromPlaid(tx({ transaction_id: 'NEW1', original_description: FULL }), []);
    ck('relink key is identical before and after memo exists', RL.keyOf(old) === RL.keyOf(fresh), RL.keyOf(old) + '  vs  ' + RL.keyOf(fresh));
}
{
    section('C — arriving later is not "the bank restated this row"');
    const first = L.fromPlaid(tx({}), []);
    first.category = '6200';                       // she has acted on it
    const again = L.fromPlaid(tx({ original_description: FULL }), []);
    const { rows, report } = L.upsert([first], [again]);
    ck('memo lands on the existing row', rows[0].memo === FULL, rows[0].memo);
    ck('  with NO drift recorded on a row she acted on', report.drifted.length === 0 && !rows[0].drift, JSON.stringify(report.drifted));
    ck('  and her category is untouched', rows[0].category === '6200');
    const later = L.fromPlaid(tx({}), []);          // a sync that carries no memo
    const r2 = L.upsert(rows, [later]).rows[0];
    ck('a later sync without memo does not erase it', r2.memo === FULL, r2.memo);
}
{
    section('D — it reaches the screen, both directions');
    const dep = BR.fromDeposit({ deposit: { id: 'T1', date: '2026-10-09', amount: 18000, descriptor: 'FMC Metal', desc: SHORT, memo: FULL }, proposals: [] });
    ck('money in: bank_text is the full memo', dep.bank_text === FULL, dep.bank_text);
    const dep2 = BR.fromDeposit({ deposit: { id: 'T2', date: '2026-10-09', amount: 5, descriptor: 'ACME', desc: SHORT }, proposals: [] });
    ck('  without a memo it falls back to the full desc (not the short party)', dep2.bank_text === SHORT, dep2.bank_text);
    const out = BR.fromWithdrawal({ row: { id: 'T3', date: '2026-10-09', amount: 7, descriptor: 'Hugo', desc: SHORT, memo: FULL }, outcome: 'none' });
    ck('money out: bank_text is the full memo', out.bank_text === FULL, out.bank_text);
    const bankOut = require(path.join(ROOT, 'helpers/bankOut'));
    const wl = (bankOut.withdrawals || bankOut.worklist || (() => null));
    ck('the page can render it (helper present in bank-match.html)',
       /function bankTextHtml/.test(fs.readFileSync(path.join(ROOT, 'dashboard/bank-match.html'), 'utf8')));
}
{
    section('E — the helper in the page');
    const html = fs.readFileSync(path.join(ROOT, 'dashboard/bank-match.html'), 'utf8');
    const m = html.match(/function bankTextHtml[\s\S]*?\n}\n/);
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fn = new Function('esc', m[0] + '; return bankTextHtml;')(esc);
    ck('shows the whole text, wrapped', fn(FULL, 'FMC Metal').includes('INV 260905-ME-SC') && /overflow-wrap:anywhere/.test(fn(FULL, 'x')));
    ck('shows nothing when it adds nothing', fn('same', 'same') === '' && fn('', 'x') === '');
    ck('escapes markup from the bank', !fn('<script>x</script>', 'a').includes('<script>'));
}
console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) failures.forEach((f) => console.log('    · ' + f));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
