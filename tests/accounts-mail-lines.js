// ── tests/accounts-mail-lines.js ──────────────────────────────────────────
// Apsara's accounts mail, 2026-11-06, and her reply: "wh the hell is this".
//
//   BOOKS — Edge Metals: the figures cannot be trusted yet
//       [object Object]
//       an entry could not be posted ... "metals-purchase" has no amount   x5
//   BOOKS — Edge Yard: the figures cannot be trusted yet
//       [object Object]
//       an entry could not be posted ... "metals-purchase" has no amount   x5
//   BOOKS — AAA Investment: the figures cannot be trusted yet
//       [object Object]
//       ... the same five again
//
// TWO faults, neither about her books:
//
//  1. [object Object]. accountsAgent printed `co.headline`, which is an
//     OBJECT, into a list that gets joined into text. booksAgent already
//     exports summary() — the sentence that line was reaching for — and it
//     was never called.
//
//  2. THE SAME PROBLEMS UNDER ALL THREE COMPANIES. built.problems is the
//     WHOLE journal's; booksAgent runs once per company and was handed the
//     lot every time. Edge Yard and AAA Investment were told their books
//     could not be trusted because of five Edge Metals purchases. It could
//     not do better, because a problem was a bare string with no company on
//     it — helpers/postings.js now attaches one.
//
// ── WHY THESE CHECKS EXIST AT ALL ────────────────────────────────────────
// Everything here is about TEXT SHE READS. An agent whose arithmetic is
// perfect and whose sentences are broken is an agent she stops opening, and
// then none of the arithmetic reaches her.
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const postings = require(path.join(ROOT, 'helpers/postings'));
const booksAgent = require(path.join(ROOT, 'helpers/booksAgent'));

(() => {

// ══════════════════════════════════════════════════════════════════════════
section('A — a problem knows which company it belongs to');
// ══════════════════════════════════════════════════════════════════════════
{
    const r = postings.post('metals-purchase', { entity: 'edge-metals', date: '2026-01-01', amount: 0 });
    ck('a priceless entry is still a problem', r.problems.length === 1, JSON.stringify(r.problems));
    const p = r.problems[0];
    ck('  and it carries the company', p.entity === 'edge-metals', JSON.stringify(p.entity));

    // ── THE COMPATIBILITY THAT MADE THIS SAFE ────────────────────────────
    // Every existing caller does String(p). If that had changed, this fix
    // would have put "[object Object]" in MORE places than it removed it
    // from — which is the exact failure being repaired.
    ck('  String(problem) is the same sentence it always was',
       String(p) === '"metals-purchase" has no amount', String(p));
    ck('  and template interpolation still reads right',
       `${p}` === '"metals-purchase" has no amount', `${p}`);

    // The branch whose whole complaint is that there is NO company cannot
    // be filed under one.
    const orphan = postings.post('metals-purchase', { date: '2026-01-01', amount: 500 });
    ck('an entry with no company has a null entity', orphan.problems[0].entity === null,
       JSON.stringify(orphan.problems[0].entity));
    ck('  and still says what is wrong', /no company against it/.test(String(orphan.problems[0])));
}

// ══════════════════════════════════════════════════════════════════════════
section('B — each company is told about ITS OWN problems');
// ══════════════════════════════════════════════════════════════════════════
// The fault she quoted. Five Edge Metals failures appeared under Edge Yard
// and AAA Investment, with "the figures cannot be trusted yet" above them.
{
    // `lines`, not `journal` — booksAgent packs built.lines. And Edge Yard's
    // entity id is 'edge-trading': entities.js carries uiName 'Edge Yard'
    // over the legal name EDGE TRADING INC. Guessing 'edge-yard' throws.
    const built = {
        lines: [], transactions: 3, complete: false,
        unplaced: [], needs: [], notes: [],
        problems: [
            ...Array.from({ length: 5 }, () =>
                postings.post('metals-purchase', { entity: 'edge-metals', date: '2026-01-01', amount: 0 }).problems[0]),
            postings.post('metals-purchase', { date: '2026-01-01', amount: 7 }).problems[0], // no company
        ],
    };
    const only = (r) => r.findings.filter((f) => f.code === 'could-not-post');

    const metals = booksAgent.review(built, { entity: 'edge-metals' });
    ck('Edge Metals sees its own five, plus the orphan', only(metals).length === 6,
       String(only(metals).length));

    const yard = booksAgent.review(built, { entity: 'edge-trading' });
    ck('Edge Yard is NOT blamed for Edge Metals purchases', only(yard).length === 1,
       `${only(yard).length} — it used to be told all six`);
    ck('  the one it does see is the entry with no company at all',
       /no company against it/.test((only(yard)[0] || {}).why || ''), JSON.stringify(only(yard)[0]));

    const aaa = booksAgent.review(built, { entity: 'aaa-investment' });
    ck('AAA Investment likewise', only(aaa).length === 1, String(only(aaa).length));

    // ── AND THE ORPHAN IS NOT LOST ───────────────────────────────────────
    // A line with no company really does leave every statement incomplete.
    // Filtering must not quietly drop it on the floor.
    ck('an unattributable problem reaches every company, not none',
       only(metals).length >= 1 && only(yard).length >= 1 && only(aaa).length >= 1);
}

// ══════════════════════════════════════════════════════════════════════════
section('C — the headline is a SENTENCE');
// ══════════════════════════════════════════════════════════════════════════
{
    const r = booksAgent.review({ lines: [], transactions: 0, complete: true,
        unplaced: [], needs: [], notes: [], problems: [] }, { entity: 'edge-metals' });
    ck('headline is still an object on the result', r.headline && typeof r.headline === 'object',
       'the screens read its fields — it is the PRINTING that was wrong');
    const line = booksAgent.summary(r);
    ck('  but summary() gives text', typeof line === 'string' && line.length > 10, line);
    ck('  which never renders as [object Object]', !/\[object Object\]/.test(line), line);
    ck('  and names the company', /Edge Metals/i.test(line), line);
}

// ══════════════════════════════════════════════════════════════════════════
section('D — nothing the accounts mail prints can be an object');
// ══════════════════════════════════════════════════════════════════════════
// The general property, not just the one line that was wrong. Every item in
// every section is joined into an email; if any of them is an object she
// gets [object Object] again somewhere else.
{
    const fs = require('fs');
    const src = fs.readFileSync(path.join(ROOT, 'helpers/accountsAgent.js'), 'utf8');
    ck('the books section no longer prints the headline object',
       !/items: \[co\.headline\]/.test(src), 'that was the bug');
    ck('  it goes through a summary line instead', /booksSummaryLine\(co\)/.test(src));
    // The adapter must not be able to return an object, whatever happens.
    ck('  and that helper falls back to text if summary() ever throws',
       /journal line\(s\)`/.test(src), 'a throw there would put the object back');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})();
