// ── tests/claims-one-supplier.js ─────────────────────────────────────────
// Apsara, 2026-11-05. Asked how Jarvis should split a claim note for a
// container with two suppliers — one letter each, or stop and ask — she
// rejected the question itself:
//
//     "One container cannot have two suppliers."
//
// That is a fact about her trade, and it changes the answer from a layout
// problem into a DATA fault. Two suppliers on one container means a claim
// was filed against the wrong one, or a name was typed wrong. There is no
// correct document to produce from it.
//
// ── WHAT IT USED TO PRODUCE ──────────────────────────────────────────────
// build() declined to name an addressee and toHtml INVENTED one:
//
//     To: 2 suppliers
//     DFSU1207911  Repro Co  $1,304.76
//     DFSU1207911  Repro Co    $187.25
//     DFSU1207911  Show Co     $187.25
//     AMOUNT RECOVERABLE FROM YOU          $1,679.26
//
// Sent to Repro Co that is a bill for $1,679.26 against $1,492.01 owed,
// with a different supplier's name and claim printed underneath. A wrong
// demand and a confidentiality leak on one page — and this document is the
// one that leaves the building.
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.JARVIS_TEST = '1';
const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-supplier-'));
const cfg = require(path.join(ROOT, 'config'));
cfg.DATA_DIR = dir;
cfg.CLAIMS_FILE = path.join(dir, 'claims.json');
cfg.CLAIM_KINDS_FILE = path.join(dir, 'claim_kinds.json');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const claims = require(path.join(ROOT, 'helpers/claims'));
const report = require(path.join(ROOT, 'helpers/claims/report'));

(async () => {

const mk = (o) => claims.create(Object.assign({
    weight_unit: 'LB', claim_date: '2026-10-01', assessment: 'weight',
    invoiced_weight: 1000, received_weight: 900, supplier_price: 1, supplier_price_unit: 'LB',
}, o), 't');

// ONE container, TWO suppliers — the impossible shape.
await mk({ container_no: 'DFSU1207911', supplier: 'Repro Co', invoice_no: 'R1', status: 'verified', our_claim: 1304.76 });
await mk({ container_no: 'DFSU1207911', supplier: 'Show Co',  invoice_no: 'S1', status: 'verified', our_claim: 187.25 });
// A clean one, which must be completely unaffected.
await mk({ container_no: 'TEMU7944250', supplier: 'Taewon',   invoice_no: 'T1', status: 'verified', our_claim: 500 });

// ══════════════════════════════════════════════════════════════════════════
section('A — it refuses, and says which two names disagree');
// ══════════════════════════════════════════════════════════════════════════
{
    let err = null;
    try { report.build({ container: 'DFSU1207911' }); } catch (e) { err = e; }
    ck('a two-supplier container produces no document at all', !!err,
       'it used to produce one addressed to "2 suppliers"');
    ck('  with a code a caller can branch on',
       err && err.code === 'CONTAINER_TWO_SUPPLIERS', err && err.code);
    // The message is the whole value of the refusal: an error saying
    // "cannot build report" sends her looking in the wrong place.
    ck('  naming BOTH suppliers, so she knows what to go and fix',
       err && /Repro Co/.test(err.message) && /Show Co/.test(err.message), err && err.message);
    ck('  and naming the container', err && /DFSU1207911/.test(err.message));
    ck('  and saying what the document would have done wrong',
       err && /bill one supplier for the other/.test(err.message), err && err.message);
}

// ══════════════════════════════════════════════════════════════════════════
section('B — the ways a report is still RIGHT are untouched');
// ══════════════════════════════════════════════════════════════════════════
// The refusal is scoped to the container scope with no supplier named. If it
// were wider it would take her working reports away, which is the over-reach
// CLAUDE.md rule 1 exists to prevent.
{
    const one = report.build({ container: 'TEMU7944250' });
    ck('a normal container still builds', one.lines.length === 1 && !!one.addressedTo,
       JSON.stringify({ n: one.lines.length, to: one.addressedTo }));
    ck('  addressed to its supplier', one.addressedTo === 'Taewon', one.addressedTo);

    // Naming the supplier makes it answerable again: it is then one
    // supplier's claims on that container, which IS a document.
    const fixed = report.build({ container: 'DFSU1207911', supplier: 'Repro Co' });
    ck('naming the supplier builds the note that supplier should get',
       fixed.addressedTo === 'Repro Co', fixed.addressedTo);
    ck('  carrying only that supplier\'s claims',
       fixed.lines.length === 1 && fixed.lines.every((l) => l.supplier === 'Repro Co'),
       JSON.stringify(fixed.lines.map((l) => l.supplier)));
    ck('  and only that supplier\'s money — never the sum of both',
       Math.abs(fixed.totals.recoverable - 1304.76) < 0.01,
       String(fixed.totals.recoverable) + ' — 1679.26 would be both suppliers added together');

    const sup = report.build({ supplier: 'Repro Co' });
    ck('a supplier-scoped report is unaffected', sup.addressedTo === 'Repro Co', sup.addressedTo);

    // ── THE CHECK THAT CATCHES ME WIDENING THIS ──────────────────────────
    // Written because a mutation SURVIVED. Changing the guard from
    //   container && !supplier && suppliers.length > 1
    // to the bare
    //   suppliers.length > 1
    // broke nothing above, and that is the over-reach CLAUDE.md rule 1 is
    // about — a rule that is right for one screen landing in code other
    // callers reach.
    //
    // The supplier branch could never have caught it: filtering BY a
    // supplier leaves one supplier in the lines, so suppliers.length > 1 is
    // unreachable there whatever the condition says. The ALL scope is the
    // caller that actually differs — it spans every supplier by design and
    // is an internal listing, addressed to nobody.
    const all = report.build({});
    ck('the all-scope listing still spans every supplier',
       all.suppliers.length > 1, JSON.stringify(all.suppliers));
    ck('  and is addressed to nobody rather than refused',
       all.addressedTo === '', JSON.stringify(all.addressedTo));
}

// ══════════════════════════════════════════════════════════════════════════
section('C — the template never invents an addressee');
// ══════════════════════════════════════════════════════════════════════════
// build() is the first lock. This is the second, and it is the one that
// actually failed: the builder left addressedTo empty ON PURPOSE and toHtml
// filled the blank in anyway.
{
    const faked = { generatedAt: new Date().toISOString(), addressedTo: '',
        suppliers: ['Repro Co', 'Show Co'], lines: [], totals: { claims: 0, recoverable: 0, shortage: 0 },
        reference: 'X', scope: 'all', unverifiedCount: 0, includedUnverified: false,
        noFigure: [], notReconciled: [] };
    const html = report.toHtml(faked);
    ck('no document ever says "2 suppliers"', !/\d+ suppliers/.test(html),
       (html.match(/\d+ suppliers/) || [''])[0]);
    ck('  an unaddressed document shows a dash, not a count', /—/.test(html));
    // The real guarantee: a supplier's name only appears where it belongs.
    ck('  and the count is not substituted anywhere else either',
       !/To:?\s*<[^>]*>\s*\d+\s+suppliers/i.test(html));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.log('CRASHED: ' + (e && e.stack || e)); process.exit(1); });
