// ── tests/quickbooks-mapping.js ────────────────────────────────────────────
// Guards helpers/quickbooks/mapping.js. What goes wrong, worst first:
//   1. a CLOSE name linked automatically: a bill lands on the wrong vendor
//      and one supplier's balance sits on another's account
//   2. her confirmed choice ignored the next time the same name comes round
//   3. a deleted QuickBooks record hijacking or blocking the live one
//   4. a duplicate in her QuickBooks (Rad Metals / RADMETALS, real, found
//      2026-09-21) resolved by picking one silently
// The names below are shaped on her real lists, so the cases are real ones.

const path = require('path');
const fs = require('fs');
const os = require('os');
let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-map-'));
process.env.DATA_DIR = TMP;
process.env.QB_PARTY_MAP_FILE = path.join(TMP, 'qb-party-map.json');
const m = require('../helpers/quickbooks/mapping');

const V = [
    { Id: '1', DisplayName: 'Mazariegos Recycling', Active: true },
    { Id: '2', DisplayName: 'MAZARIEGOS RECYCLING LLC (deleted)', Active: false },
    { Id: '3', DisplayName: 'Pan Metal', Active: true },
    { Id: '4', DisplayName: 'DRM IRON METAL LLC', Active: true },
    { Id: '5', DisplayName: 'Calderon Cores', Active: true },
    { Id: '6', DisplayName: 'Calderon Trucking AJ', Active: true },
    { Id: '7', DisplayName: 'Jio Trucking', Active: true },
    { Id: '8', DisplayName: 'Old Yard Co', Active: false },
    { Id: '9', DisplayName: 'AJ Transport', Active: true },
];
const C = [
    { Id: '298', DisplayName: 'Rad Metals', Active: true },
    { Id: '515', DisplayName: 'RADMETALS', Active: true },
    { Id: '20', DisplayName: 'TAEWON PRECEISION', Active: true },
    { Id: '21', DisplayName: 'Haekwang Metal', Active: true },
    { Id: '22', DisplayName: 'Daekwang Co,Ltd', Active: true },
    { Id: '23', DisplayName: 'MK Trading', Active: true },
];
const st = (n, L, k) => m.matchParty(n, L, k);

console.log('\n── only exact is automatic ──');
ck('exact spelling -> exact', st('Pan Metal', V, 'vendor').status === 'exact');
ck('spacing/punctuation only -> exact (nameMatch rule)', st('AJ-Transport', V, 'vendor').qb.Id === '9');
ck('LLC dropped -> suggest, NOT exact', st('DRM Iron Metal', V, 'vendor').status === 'suggest');
ck('typo in QB (PRECEISION) -> suggest, NOT exact', st('Taewon Precision', C, 'customer').status === 'suggest');
ck('contained name -> suggest', st('Jio', V, 'vendor').status === 'suggest' && st('Jio', V, 'vendor').candidates[0].DisplayName === 'Jio Trucking');
ck('MK Metal Trading vs MK Trading -> suggest only', st('MK Metal Trading', C, 'customer').status === 'suggest');
ck('suggest never carries a linked qb', !st('DRM Iron Metal', V, 'vendor').qb);

console.log('\n── ambiguity is shown, not settled ──');
const cal = st('Calderon', V, 'vendor');
ck('Calderon -> ambiguous (Cores vs Trucking AJ)', cal.status === 'ambiguous' && cal.candidates.length >= 2, JSON.stringify(cal));
const hk = st('Haekwang', C, 'customer');
ck('Haekwang vs Daekwang -> ambiguous, not a pick', hk.status === 'ambiguous', JSON.stringify(hk));
const rad = st('Rad Metals', C, 'customer');
ck('QB duplicate (Rad Metals / RADMETALS) -> ambiguous', rad.status === 'ambiguous' && rad.candidates.length === 2);
ck('duplicate is labelled as such', rad.candidates.every((c) => /twice/.test(c.why)));

console.log('\n── deleted records ──');
ck('deleted twin does not make Mazariegos ambiguous', st('Mazariegos', V, 'vendor').status === 'suggest' && st('Mazariegos', V, 'vendor').candidates.length === 1);
ck('deleted record exact-matched only when nothing active', st('Old Yard Co', V, 'vendor').status === 'exact' && st('Old Yard Co', V, 'vendor').qb.Active === false);

console.log('\n── nothing / nonsense ──');
ck('unknown -> none', st('Completely New Supplier', V, 'vendor').status === 'none');
ck('empty name -> none, never a wildcard', st('  ', V, 'vendor').status === 'none' && st('', V, 'vendor').candidates.length === 0);
ck('two-letter name does not sweep by containment', st('AJ', V, 'vendor').status !== 'suggest' || st('AJ', V, 'vendor').candidates.length <= 1);
let e = ''; try { st('x', V, 'supplier'); } catch (er) { e = er.message; }
ck('wrong kind refused', /vendor\|customer/.test(e));

console.log('\n── her decision wins ──');
m.confirm('customer', 'Rad Metals', '298', 'Rad Metals');
ck('confirmed duplicate resolves to her pick', st('Rad Metals', C, 'customer').status === 'confirmed' && st('Rad Metals', C, 'customer').qb.Id === '298');
ck('confirmation matches other spellings of the same Jarvis name', st('RAD METALS', C, 'customer').qb.Id === '298');
m.confirm('vendor', 'Pan Metal', '5', 'Calderon Cores');
ck('confirmation beats even an exact match', st('Pan Metal', V, 'vendor').qb.Id === '5');
m.confirm('vendor', 'Completely New Supplier', null, null);
ck('"not in QuickBooks" is remembered as new', st('Completely New Supplier', V, 'vendor').status === 'new');
ck('vendor and customer maps are separate', st('Rad Metals', [], 'vendor').status === 'none');
ck('map persisted to disk', JSON.parse(fs.readFileSync(process.env.QB_PARTY_MAP_FILE, 'utf8')).customer.radmetals.qbId === '298');

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nquickbooks-mapping: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
