// ── tests/bank-speed.js — the bank "For review" list took ages to reload after a Post ─────────────────────
// Apsara, 2026-11-16: "it takes lot of time to complete loading once transaction is posted".
// Cause (profiled): the withdrawal sweep compares every bank row with every recorded payment, and each comparison
// re-parsed two date strings. Two thirds of the time was Date.parse. daysBetween now remembers each date it has parsed.
// This pins (A) that the answers did not change, and (B) the WORK, not a stopwatch: a stopwatch test is a flaky test.
process.env.JARVIS_TEST = '1';
process.env.DATA_DIR = require('fs').mkdtempSync(require('os').tmpdir() + '/jarvis-bspeed-');
const path = require('path');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const BM = require(path.join(ROOT, 'helpers/bankMatch'));
const BO = require(path.join(ROOT, 'helpers/bankOut'));

// The formula exactly as it was before the change.
const day = (d) => String(d || '').slice(0, 10);
const ref = (a, b) => { const x = Date.parse(day(a) + 'T00:00:00Z'), y = Date.parse(day(b) + 'T00:00:00Z'); if (!isFinite(x) || !isFinite(y)) return Infinity; return Math.round((y - x) / 86400000); };

section('A. same answers as before, including the odd inputs');
{
    const vals = ['2026-01-01', '2026-02-28', '2026-03-01', '2026-12-31', '2027-01-01', '2026-10-07T13:45:00Z', '2026-10-07 09:00', null, undefined, '', 'garbage', '2026-02-30', '2026-13-01', 20261007, new Date('2026-05-05T00:00:00Z').toISOString()];
    let bad = 0;
    for (const a of vals) for (const b of vals) { const x = BM.daysBetween(a, b), y = ref(a, b); if (!(x === y || (Number.isNaN(x) && Number.isNaN(y)))) bad++; }
    ck(`daysBetween equals the old formula on ${vals.length * vals.length} pairs`, bad === 0, 'differences: ' + bad);
    ck('asked twice, the same answer (the memory does not drift)', BM.daysBetween('2026-01-01', '2026-03-01') === 59 && BM.daysBetween('2026-01-01', '2026-03-01') === 59);
    ck('an invalid date is still Infinity, not a stale number', BM.daysBetween('garbage', '2026-01-01') === Infinity && BM.daysBetween('2026-01-01', 'garbage') === Infinity);
}

section('B. the sweep does not re-parse dates for every pair');
{
    let seed = 11; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const dd = (i) => '2026-' + String(1 + Math.floor(i / 28) % 11).padStart(2, '0') + '-' + String(1 + i % 28).padStart(2, '0');
    const N = 800, M = 800;
    const lines = [], rows = [];
    for (let i = 0; i < M; i++) lines.push({ account: '1010', credit: Math.round(50 + rnd() * 3000), date: dd(Math.floor(rnd() * 300)), party: 'P' + (i % 80), kind: 'supplier-payment', entity: 'e', source: { store: 'x', id: i } });
    for (let i = 0; i < N; i++) rows.push({ id: 'r' + i, date: dd(Math.floor(rnd() * 300)), desc: 'w' + i, spent: Math.round(50 + rnd() * 6000), received: 0, amount: Math.round(50 + rnd() * 6000), direction: 'out', bank: 'BofA', company: 'Edge Metals INC', pending: false, excluded: false, matched: null, history: [] });
    const real = Date.parse; let parses = 0;
    Date.parse = function (s) { parses++; return real.call(Date, s); };
    let out;
    try { out = BO.sweep({ rows, lines, code: '1010' }); } finally { Date.parse = real; }
    ck('it produced a result for every withdrawal', out.results.length === N, String(out.results.length));
    ck(`Date.parse ran ${parses} times for ${N}x${M} pairs (was in the millions)`, parses < 5000, String(parses));
    const again = BO.sweep({ rows, lines, code: '1010' });
    ck('the same input gives the identical result twice', JSON.stringify(again.results) === JSON.stringify(out.results));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }
process.exit(0);
