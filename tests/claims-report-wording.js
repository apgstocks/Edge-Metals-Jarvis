// ── tests/claims-report-wording.js — what the supplier's copy says ───────
//
// Two changes she asked for on 2026-10-30, both about the document that
// leaves the building:
//
//   · "Remove Where no rate is shown, the amount is as agreed between us
//     rather than calculated."
//   · "What we sent, what they received item type can be optional in
//     quality claim"
//
// Asserted on the rendered HTML rather than on the source, because the
// wording of a supplier demand is the product here — a check that reads the
// template proves the string exists, not that it reaches the page.

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-word-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated — refusing to run against her claims');
    process.exit(1);
}
const claims = require(path.join(ROOT, 'helpers/claims'));
const report = require(path.join(ROOT, 'helpers/claims/report'));

const SUPPLIER = 'Inesh Cores Chapin';
const render = () => report.toHtml(report.build({ supplier: SUPPLIER, includeUnverified: true }));

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — the "as agreed between us" footnote is gone');
// It appeared whenever any sendable line had no rate — which is EVERY
// downgrade, because the rate column is stripped on those rows. So a
// perfectly calculated claim carried a note saying it was not calculated.
{
    const c = await claims.create({ supplier: SUPPLIER, container_no: 'DFSU1207911',
        invoice_no: 'R1', weight_unit: 'LB', our_claim: 187.25, status: 'verified' }, 't');
    await claims.assess(c.id, { assessment: 'grade', weight_unit: 'LB',
        grade_sold: 'Alternator', grade_received: 'MS Scrap',
        grade_weight: 0.664, grade_price_sold: 2600, grade_price_received: 2318 }, 'a');
    const html = render();
    ck('a downgrade still produces a document', /DFSU1207911/.test(html), html.slice(0, 120));
    ck('  and it carries no rate on that row', /—|&mdash;/.test(html));
    ck('  the footnote is not on it',
       !/as agreed between us/.test(html),
       'a calculated claim must not tell a supplier it was agreed rather than worked out');
    ck('  the other notes survive',
       /notes/.test(html), 'the whole notes block was removed instead of the one line');
}

// ══════════════════════════════════════════════════════════════════════════
section('B — quality: what we sent, what they received');
{
    const c = await claims.create({ supplier: SUPPLIER, container_no: 'TEMU7654321',
        invoice_no: 'R2', weight_unit: 'LB', our_claim: 500, supplier_price: 0.5,
        supplier_price_unit: 'LB', status: 'verified' }, 't');
    const r = await claims.assess(c.id, { assessment: 'quality', weight_unit: 'LB',
        quality_qty: 1000, sell_price: 0.5, sell_price_unit: 'LB',
        grade_sold: 'Alternator', grade_received: 'MS Scrap' }, 'a');
    ck('a quality claim keeps both item types', r.grade_sold === 'Alternator'
       && r.grade_received === 'MS Scrap',
       JSON.stringify({ s: r.grade_sold, r: r.grade_received }));
    ck('  and still works out the same figure', r.claim_amount === 500, String(r.claim_amount));
    const html = render();
    ck('  the document says what was sent and what arrived',
       /sent Alternator, received MS Scrap/.test(html),
       'the substitution IS the complaint on a quality claim');
}

// ══════════════════════════════════════════════════════════════════════════
section('C — OPTIONAL means optional');
// The rule CLAUDE.md records being broken twice: a new field that becomes
// required breaks the callers with no form to put it on — the mail path and
// the voice path. Both are how most of her quality claims arrive.
{
    const c = await claims.create({ supplier: SUPPLIER, container_no: 'MSCU1111111',
        invoice_no: 'R3', weight_unit: 'LB', our_claim: 300, supplier_price: 0.3,
        supplier_price_unit: 'LB', status: 'verified' }, 't');
    let threw = null, r = null;
    try {
        r = await claims.assess(c.id, { assessment: 'quality', weight_unit: 'LB',
            quality_qty: 1000, sell_price: 0.3, sell_price_unit: 'LB' }, 'a');
    } catch (e) { threw = e; }
    ck('a quality claim with neither item type still assesses', threw === null,
       threw && threw.message);
    ck('  and produces the same figure it always did', r && r.claim_amount === 300,
       r && String(r.claim_amount));
    const html = render();
    ck('  the document says nothing about sent/received for it',
       (html.match(/sent .*, received /g) || []).length === 1,
       'an empty pair printed as "sent —, received —" is noise on a demand');

    // An edit that does not mention them must not blank them.
    const kept = await claims.assess(r.id, { assessment: 'quality', weight_unit: 'LB',
        quality_qty: 1200, sell_price: 0.3, sell_price_unit: 'LB' }, 'a');
    ck('  and re-assessing without them leaves them alone',
       kept.grade_sold === '' && kept.grade_received === '',
       JSON.stringify({ s: kept.grade_sold, r: kept.grade_received }));

    const two = await claims.assess(r.id, { assessment: 'quality', weight_unit: 'LB',
        quality_qty: 1200, sell_price: 0.3, sell_price_unit: 'LB',
        grade_sold: 'Rads', grade_received: 'Irony Rads' }, 'a');
    const three = await claims.assess(two.id, { assessment: 'quality', weight_unit: 'LB',
        quality_qty: 1300, sell_price: 0.3, sell_price_unit: 'LB' }, 'a');
    ck('  a later edit that omits them KEEPS what she typed',
       three.grade_sold === 'Rads' && three.grade_received === 'Irony Rads',
       JSON.stringify({ s: three.grade_sold, r: three.grade_received })
       + ' — an edit about the quantity must not silently erase the item names');
}

// ══════════════════════════════════════════════════════════════════════════
section('D — the screen asks for them, and sends them');
{
    const page = fs.readFileSync(path.join(ROOT, 'dashboard/claims.html'), 'utf8');
    const at = page.indexOf("data-pane=\"quality\"");
    const end = page.indexOf('data-kind="quality"', at);
    const pane = at > 0 && end > at ? page.slice(at, end) : '';
    ck('the quality pane is found', !!pane && pane.length < 4000, `${pane.length} chars`);
    ck('  it asks what we sent and what they received',
       /What we sent/.test(pane) && /What they received/.test(pane), pane.slice(0, 160));
    ck('    marked optional, so she knows she can skip them',
       (pane.match(/optional/g) || []).length >= 2, 'nothing on the pane says they are optional');

    const sub = page.indexOf("btn.dataset.kind === 'quality'");
    const body = sub > 0 ? page.slice(sub, sub + 700) : '';
    ck('  and the assessment posts them', /grade_sold:/.test(body) && /grade_received:/.test(body),
       body.slice(0, 200));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }

})().catch((e) => { console.error('\nCRASHED: ' + (e && e.stack || e)); process.exit(1); });
