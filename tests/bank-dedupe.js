// ── tests/bank-dedupe.js ──────────────────────────────────────────────────
// Apsara, 2026-10-14: every Eccomelt deposit from 11 Aug to 6 Oct showed
// twice after the bank was re-linked. helpers/bankRelink.dedupe removes the
// extra copy. This file defends the ways a de-duplicator loses money:
//   · folding two GENUINE identical transactions into one (same account)
//   · removing the copy that carries her work, or that another record
//     (bank_entries, interCompany) points at
//   · removing both, or neither side of an unbalanced group
const fs = require('fs');
const os = require('os');
const path = require('path');
let pass = 0, fail = 0; const failures = [];
const ck = (l, ok, d) => { if (ok) { pass += 1; console.log('  PASS  ' + l); } else { fail += 1; failures.push(l); console.log('  FAIL  ' + l); if (d) console.log('        ' + d); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-dedupe-'));
process.env.DATA_DIR = TMP; process.env.JARVIS_TEST = '1';
const ROOT = path.join(__dirname, '..');
const R = require(path.join(ROOT, 'helpers/bankRelink'));

const LIVE = ['NEW_ACCT'];
const DESC = 'ECCOMELTTEXAS1 DES:PAYMENT ID:ROM3694 INDN:EDGE METALS INC';
const row = (id, acct, over = {}) => ({ id, account_id: acct, date: '2026-10-06', direction: 'in', amount: 48840, desc: DESC, history: [], ...over });
const ids = (p) => p.remove.map((x) => x.id).sort();

(async () => {
{
    section('A — her screen: every deposit twice, nothing touched');
    const rows = [row('OLD1', 'OLD_ACCT'), row('NEW1', 'NEW_ACCT'),
                  row('OLD2', 'OLD_ACCT', { date: '2026-10-02', amount: 11847 }), row('NEW2', 'NEW_ACCT', { date: '2026-10-02', amount: 11847 })];
    const p = R.dedupe(rows, { liveAccountIds: LIVE });
    ck('the old-item copy of each pair goes', JSON.stringify(ids(p)) === '["OLD1","OLD2"]', JSON.stringify(ids(p)));
    ck('  and says which row stays', p.remove.every((x) => x.keep.startsWith('NEW')));
    ck('  nothing reported as kept-both', p.kept_both.length === 0);
    ck('planning writes nothing and does not mutate its input', rows.length === 4 && rows.every((r) => r.history.length === 0));
}
{
    section('B — two GENUINE identical transactions are never folded');
    const same = [row('A1', 'NEW_ACCT'), row('A2', 'NEW_ACCT')];            // same account, same everything
    ck('two identical rows on ONE account: untouched', R.dedupe(same, { liveAccountIds: LIVE }).remove.length === 0);
    const bothOld = [row('A1', 'OLD_ACCT'), row('A2', 'OLD_ACCT')];
    ck('two identical rows on the old account only: untouched', R.dedupe(bothOld, { liveAccountIds: LIVE }).remove.length === 0);
    // Two real transactions on each side → two pairs → two removed, two stay.
    const two = [row('O1', 'OLD_ACCT'), row('O2', 'OLD_ACCT'), row('N1', 'NEW_ACCT'), row('N2', 'NEW_ACCT')];
    const p = R.dedupe(two, { liveAccountIds: LIVE });
    ck('N identical on each side: exactly N removed, N stay', p.remove.length === 2 && new Set(p.remove.map((x) => x.keep)).size === 2, JSON.stringify(ids(p)));
    // Unbalanced: 2 old, 1 fresh — one real extra transaction exists.
    const unb = [row('O1', 'OLD_ACCT'), row('O2', 'OLD_ACCT'), row('N1', 'NEW_ACCT')];
    ck('2 old + 1 new: only ONE removed (the other is a real transaction)', R.dedupe(unb, { liveAccountIds: LIVE }).remove.length === 1);
}
{
    section('C — the copy that carries her work always survives');
    const acted = [row('OLD1', 'OLD_ACCT', { category: '6200' }), row('NEW1', 'NEW_ACCT')];
    let p = R.dedupe(acted, { liveAccountIds: LIVE });
    ck('old copy categorised → the NEW copy goes', JSON.stringify(ids(p)) === '["NEW1"]' && p.remove[0].keep === 'OLD1', JSON.stringify(p.remove));
    p = R.dedupe([row('OLD1', 'OLD_ACCT', { matched: { keys: ['x'] } }), row('NEW1', 'NEW_ACCT')], { liveAccountIds: LIVE });
    ck('old copy matched → survives', JSON.stringify(ids(p)) === '["NEW1"]');
    p = R.dedupe([row('OLD1', 'OLD_ACCT', { excluded: true }), row('NEW1', 'NEW_ACCT')], { liveAccountIds: LIVE });
    ck('old copy excluded → survives', JSON.stringify(ids(p)) === '["NEW1"]');
    p = R.dedupe([row('OLD1', 'OLD_ACCT'), row('NEW1', 'NEW_ACCT', { category: '6900' })], { liveAccountIds: LIVE });
    ck('new copy categorised → the OLD copy goes', JSON.stringify(ids(p)) === '["OLD1"]');
    // Referenced by another store, with no mark on the row itself.
    p = R.dedupe([row('OLD1', 'OLD_ACCT'), row('NEW1', 'NEW_ACCT')], { liveAccountIds: LIVE, refs: new Set(['OLD1']) });
    ck('old copy referenced by bank_entries/interCompany → survives', JSON.stringify(ids(p)) === '["NEW1"]');
    p = R.dedupe([row('OLD1', 'OLD_ACCT'), row('NEW1', 'NEW_ACCT')], { liveAccountIds: LIVE, refs: new Set(['NEW1']) });
    ck('new copy referenced → survives', JSON.stringify(ids(p)) === '["OLD1"]');
    p = R.dedupe([row('OLD1', 'OLD_ACCT', { category: '6200' }), row('NEW1', 'NEW_ACCT', { category: '6900' })], { liveAccountIds: LIVE });
    ck('BOTH carry work → neither removed, and it is reported', p.remove.length === 0 && p.kept_both.length === 1, JSON.stringify(p));
}
{
    section('D — it refuses to guess');
    ck('no live account ids → refuses (cannot tell old from current)', R.dedupe([row('A', 'X'), row('B', 'Y')], { liveAccountIds: [] }).ok === false);
    const diffAmt = [row('O', 'OLD_ACCT'), row('N', 'NEW_ACCT', { amount: 48840.01 })];
    ck('a cent apart is not a duplicate', R.dedupe(diffAmt, { liveAccountIds: LIVE }).remove.length === 0);
    const diffDay = [row('O', 'OLD_ACCT'), row('N', 'NEW_ACCT', { date: '2026-10-07' })];
    ck('a day apart is not a duplicate', R.dedupe(diffDay, { liveAccountIds: LIVE }).remove.length === 0);
    const diffDir = [row('O', 'OLD_ACCT'), row('N', 'NEW_ACCT', { direction: 'out' })];
    ck('opposite direction is not a duplicate', R.dedupe(diffDir, { liveAccountIds: LIVE }).remove.length === 0);
}
{
    section('E — applying: atomic, archived, refuses a moved store');
    const file = path.join(TMP, 'tx.json'), arch = path.join(TMP, 'removed.jsonl');
    const rows = [row('OLD1', 'OLD_ACCT'), row('NEW1', 'NEW_ACCT'), row('KEEP', 'NEW_ACCT', { amount: 5, desc: 'OTHER' })];
    fs.writeFileSync(file, JSON.stringify(rows));
    const plan = R.dedupe(rows, { liveAccountIds: LIVE });
    let threw = null;
    try { await R.applyDedupe(file, plan, {}); } catch (e) { threw = e; }
    ck('no archive file given → refuses, store untouched', !!threw && JSON.parse(fs.readFileSync(file, 'utf8')).length === 3);
    const out = await R.applyDedupe(file, plan, { archiveFile: arch, by: 'test' });
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    ck('removes exactly the planned row', out.removed === 1 && after.map((r) => r.id).sort().join() === 'KEEP,NEW1', after.map((r) => r.id).join());
    const lines = fs.readFileSync(arch, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    ck('  and archives it whole, with who and what stayed', lines.length === 1 && lines[0].row.id === 'OLD1' && lines[0].kept_id === 'NEW1' && lines[0].by === 'test', JSON.stringify(lines[0]));
    // Stale: store moved since the plan.
    fs.writeFileSync(file, JSON.stringify(rows.filter((r) => r.id !== 'NEW1')));
    const before = fs.readFileSync(file, 'utf8');
    threw = null; try { await R.applyDedupe(file, plan, { archiveFile: arch }); } catch (e) { threw = e; }
    ck('survivor gone since the plan → REFUSED (never removes the last copy)', !!threw && /no longer in the store/.test(threw.message), threw && threw.message);
    ck('  store untouched', fs.readFileSync(file, 'utf8') === before);
    ck('  and nothing new archived', fs.readFileSync(arch, 'utf8').trim().split('\n').length === 1);
}
console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) failures.forEach((f) => console.log('    · ' + f));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('threw:', e && e.stack); process.exit(1); });
