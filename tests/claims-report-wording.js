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
const kinds = require(path.join(ROOT, 'helpers/claimKinds'));

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

// ══════════════════════════════════════════════════════════════════════════
section('E — the quality ROW: no Short, no %, no Your rate');
// Apsara: "What we sent ,what is claimed should be there in table. dont want
// shirt ,%,Youra rate in table for quaity claim".
{
    // A container no other section uses: render() returns EVERY claim for
    // this supplier, and section B already created TEMU7654321 — the first
    // matching row won, so this read section B's quantity and failed.
    const q = await claims.create({ supplier: SUPPLIER, container_no: 'QUAL9999999',
        invoice_no: 'R4', weight_unit: 'LB', supplier_price: 0.42,
        supplier_price_unit: 'LB', status: 'verified' }, 't');
    await claims.assess(q.id, { assessment: 'quality', weight_unit: 'LB', quality_qty: 2215.64,
        sell_price: 0.89, sell_price_unit: 'LB',
        grade_sold: 'Alternator', grade_received: 'MS Scrap' }, 'a');
    await claims.raiseRecovery(q.id, { our_claim: 1971.92 }, 'a');

    // A weight claim beside it, because the columns are SHARED. The rule
    // CLAUDE.md records breaking twice: a change asked for on one kind of
    // row must leave the others exactly as they were.
    const w = await claims.create({ supplier: SUPPLIER, container_no: 'MSCU2222222',
        invoice_no: 'R5', weight_unit: 'MT', supplier_price: 1000,
        supplier_price_unit: 'MT', status: 'verified' }, 't');
    await claims.verify(w.id, { invoice_weight: 20, claimed_weight: 19, weight_unit: 'MT',
        sell_price: 1000, sell_price_unit: 'MT' }, 'a');
    await claims.raiseRecovery(w.id, { our_claim: 1000 }, 'a');

    const html = render();
    // Split on the row opener rather than matching across it — a regex that
    // has to skip </tr> is exactly the kind that silently truncates and then
    // "proves" a figure is absent when it is two cells further along.
    const rowOf = (c) => (html.split('<tr').find((chunk) => chunk.includes(c)) || '');
    const qRow = rowOf('QUAL9999999'), wRow = rowOf('MSCU2222222');
    ck('both rows are on the document', !!qRow && !!wRow, `${qRow.length} / ${wRow.length}`);

    ck('the quality row says what we sent and what came back',
       /Alternator/.test(qRow) && /MS Scrap/.test(qRow), qRow.replace(/<[^>]+>/g, ' ').trim().slice(0, 120));
    ck('  and how much is claimed', /2,215\.64 LB claimed/.test(qRow));
    ck('  with no shortage percentage on it', !/%/.test(qRow),
       'a quality claim has no invoiced-against-received pair to take a % of');
    ck('  and no rate of his beside it', !/0\.42/.test(qRow),
       qRow.replace(/<[^>]+>/g, ' ').trim().slice(0, 140));

    // ── AND THE WEIGHT ROW IS UNTOUCHED ──────────────────────────────────
    ck('the weight row still shows the shortage', /1 MT/.test(wRow), wRow.replace(/<[^>]+>/g, ' ').trim());
    ck('  still shows the percentage', /5\.00%/.test(wRow));
    ck('  and still shows HIS rate', /1,000\.00\/MT/.test(wRow));
}

// ══════════════════════════════════════════════════════════════════════════
section('F — a QUALITY-ONLY demand gets her columns');
// Apsara: "Have date,container,Claim type,what we sent,what is calimed,
// invoiced,claim,Recoverable" / "what is claimed as in item" / "This sis
// applicable only for quality claim".
{
    const SOLO = 'Quality Only Co';
    const q = await claims.create({ supplier: SOLO, container_no: 'QUAL1234567',
        invoice_no: 'F1', claim_date: '2026-10-02', weight_unit: 'LB', status: 'verified' }, 't');
    await claims.verify(q.id, { invoice_weight: 24000, claimed_weight: 24000, weight_unit: 'LB',
        sell_price: 0.89, sell_price_unit: 'LB' }, 'a');
    await claims.assess(q.id, { assessment: 'quality', weight_unit: 'LB', quality_qty: 2215.64,
        sell_price: 0.89, sell_price_unit: 'LB',
        grade_sold: 'Alternator', grade_received: 'MS Scrap' }, 'a');
    await claims.raiseRecovery(q.id, { our_claim: 1971.92 }, 'a');
    const html = report.toHtml(report.build({ supplier: SOLO, includeUnverified: true }));
    const head = (html.match(/<thead>[\s\S]*?<\/thead>/) || [''])[0].replace(/<[^>]+>/g, '|');

    for (const h of ['Date', 'Container', 'Claim type', 'What we sent', 'What is claimed',
        'Invoiced', 'Claim', 'Recoverable']) {
        ck(`  the header has ${h}`, head.includes(h), head);
    }
    ck('  and none of the three she did not want',
       !/Received/.test(head) && !/Short/.test(head) && !/Your rate/.test(head), head);

    const row = (html.split('<tr').find((c) => c.includes('QUAL1234567')) || '');
    ck('the items are NAMES, in their own cells',
       /<td>Alternator<\/td>/.test(row) && /<td>MS Scrap<\/td>/.test(row),
       row.replace(/<[^>]+>/g, ' | ').trim().slice(0, 150));
    ck('  the invoiced weight is there', /24,000 LB/.test(row));
    ck('  and the quantity claimed', /2,215\.64 LB/.test(row));
    ck('  and the money', /1,971\.92/.test(row));
}

// ══════════════════════════════════════════════════════════════════════════
section('G — a MIXED demand keeps the old table, untouched');
// The columns are shared. CLAUDE.md records this exact break twice: a
// change asked for on one kind of row landing on every other one.
{
    const MIX = 'Mixed Co';
    const w = await claims.create({ supplier: MIX, container_no: 'MIXD1111111',
        invoice_no: 'G1', weight_unit: 'MT', supplier_price: 1000,
        supplier_price_unit: 'MT', status: 'verified' }, 't');
    await claims.verify(w.id, { invoice_weight: 20, claimed_weight: 19, weight_unit: 'MT',
        sell_price: 1000, sell_price_unit: 'MT' }, 'a');
    await claims.raiseRecovery(w.id, { our_claim: 1000 }, 'a');
    const q2 = await claims.create({ supplier: MIX, container_no: 'MIXD2222222',
        invoice_no: 'G2', weight_unit: 'LB', status: 'verified' }, 't');
    await claims.assess(q2.id, { assessment: 'quality', weight_unit: 'LB', quality_qty: 500,
        sell_price: 1, sell_price_unit: 'LB', grade_sold: 'Rads', grade_received: 'Irony' }, 'a');
    await claims.raiseRecovery(q2.id, { our_claim: 500 }, 'a');

    const html = report.toHtml(report.build({ supplier: MIX, includeUnverified: true }));
    const head = (html.match(/<thead>[\s\S]*?<\/thead>/) || [''])[0].replace(/<[^>]+>/g, '|');
    ck('the nine-column header is back', /Short/.test(head) && /Your rate/.test(head)
       && /Received/.test(head), head);
    ck('  and her quality headers are NOT on a mixed page',
       !/What we sent/.test(head), head);

    const wRow = (html.split('<tr').find((c) => c.includes('MIXD1111111')) || '');
    ck('the weight row still shows shortage, % and his rate',
       /1 MT/.test(wRow) && /5\.00%/.test(wRow) && /1,000\.00\/MT/.test(wRow),
       wRow.replace(/<[^>]+>/g, ' | ').trim());
    const qRow = (html.split('<tr').find((c) => c.includes('MIXD2222222')) || '');
    ck('  and the quality row still merges its cells',
       /colspan="5"/.test(qRow) && /Rads/.test(qRow),
       qRow.replace(/<[^>]+>/g, ' | ').trim().slice(0, 140));
}

// ══════════════════════════════════════════════════════════════════════════
section('H — nothing short, nothing unclassified, on a demand');
{
    const SOLO = 'Header Co';
    const q = await claims.create({ supplier: SOLO, container_no: 'HEAD1234567',
        invoice_no: 'H1', weight_unit: 'LB', status: 'verified' }, 't');
    // verify() records a shortage of 0 when the weights agree — which is how
    // "TOTAL SHORTAGE 0 LB" came to sit at the top of a quality demand.
    await claims.verify(q.id, { invoice_weight: 24828, claimed_weight: 24828,
        weight_unit: 'LB', sell_price: 0.89, sell_price_unit: 'LB' }, 'a');
    await claims.assess(q.id, { assessment: 'quality', weight_unit: 'LB', quality_qty: 2215.64,
        sell_price: 0.89, sell_price_unit: 'LB',
        grade_sold: 'Alternator', grade_received: 'MS Scrap' }, 'a');
    await claims.raiseRecovery(q.id, { our_claim: 1971.92 }, 'a');
    const html = report.toHtml(report.build({ supplier: SOLO, includeUnverified: true }));

    ck('a demand with nothing short has no shortage line',
       !/Total shortage/i.test(html),
       'a zero is not a fact worth leading a demand with');
    ck('  and nothing on it says "not classified yet"',
       !/not classified yet/.test(html),
       'the right words on her screen, the wrong ones on a supplier document');
    ck('  the claim type falls back to the arithmetic', /Quality/.test(html),
       (html.match(/<td>[^<]*<\/td>\s*<td>Alternator/) || [''])[0]);

    // A real shortage still leads with it.
    const w = await claims.create({ supplier: 'Short Co', container_no: 'SHRT1111111',
        invoice_no: 'H2', weight_unit: 'MT', supplier_price: 1000,
        supplier_price_unit: 'MT', status: 'verified' }, 't');
    await claims.verify(w.id, { invoice_weight: 20, claimed_weight: 19, weight_unit: 'MT',
        sell_price: 1000, sell_price_unit: 'MT' }, 'a');
    await claims.raiseRecovery(w.id, { our_claim: 1000 }, 'a');
    const sh = report.toHtml(report.build({ supplier: 'Short Co', includeUnverified: true }));
    ck('a demand that IS short still says so', /Total shortage/i.test(sh) && /1 MT/.test(sh),
       'the line was removed for zero, not removed outright');
    ck('  and names the arithmetic as Shortage', /Shortage/.test(sh),
       (sh.match(/<td>[^<]*Shortage[^<]*<\/td>/) || [''])[0]);
}

// ══════════════════════════════════════════════════════════════════════════
section('I — the LABEL decides the layout, not the arithmetic');
{
    // Inesh's DFSU1207911: she classified it quality, the engine stored
    // assessment 'grade' because the figure came from a price gap, and the
    // demand printed on the nine-column shortage table with Short, % and his
    // rate all dashes. Apsara, 2026-10-30: "anything you label 'quality' gets
    // the 8-column quality layout regardless of the arithmetic underneath."
    await kinds.ensure('quality', 'item not as described', 't');
    const LBL = 'Label Co';
    const g = await claims.create({ supplier: LBL, container_no: 'LBLQ1111111',
        invoice_no: 'I1', weight_unit: 'LB', claim_type: 'quality', status: 'verified' }, 't');
    await claims.verify(g.id, { invoice_weight: 24828, claimed_weight: 24828,
        weight_unit: 'LB', sell_price: 0.89, sell_price_unit: 'LB' }, 'a');
    await claims.assess(g.id, { assessment: 'grade', weight_unit: 'LB', grade_weight: 664,
        grade_sold: 'Alternator', grade_received: 'MS Scrap',
        grade_price_sold: 0.30, grade_price_received: 0.018 }, 'a');
    await claims.raiseRecovery(g.id, { our_claim: 187.25 }, 'a');
    const h = report.toHtml(report.build({ supplier: LBL, includeUnverified: true }));

    ck('a DOWNGRADE she labelled quality gets the eight columns',
       /Claim type/.test(h) && /What we sent/.test(h), 'the label decides');
    ck('  Short, % and his rate are off it', !/>Short</.test(h) && !/Your rate/.test(h),
       'they were dashes on this row and she does not want them');
    // In the TABLE CELL, not in the detail sentence below it — which also
    // says "664 LB affected" and made the first version of this check pass
    // against a mutation that blanked the column. A check shaped like the
    // output rather than the property is not a check.
    const cells = (h.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [])
        .filter((r) => /LBLQ1111111/.test(r))
        .map((r) => (r.match(/<td[^>]*>([\s\S]*?)<\/td>/g) || []).map((c) => c.replace(/<[^>]+>/g, '').trim()));
    ck('  the Claim column is not blank on a downgrade',
       cells.length === 1 && cells[0].length === 8 && cells[0][6] === '664 LB',
       `row cells: ${JSON.stringify(cells[0])}`);
    ck('  the item names still print', /Alternator/.test(h) && /MS Scrap/.test(h), '');

    // Nothing that prints correctly today may change: a CONTAMINATION claim
    // keeps all nine columns, because Short and his rate mean something on it.
    const CON = 'Contam Co';
    const k = await claims.create({ supplier: CON, container_no: 'CONT2222222',
        invoice_no: 'I2', weight_unit: 'MT', supplier_price: 1000,
        supplier_price_unit: 'MT', status: 'verified' }, 't');
    await claims.verify(k.id, { invoice_weight: 20, claimed_weight: 20, weight_unit: 'MT',
        sell_price: 1000, sell_price_unit: 'MT' }, 'a');
    await claims.assess(k.id, { assessment: 'contamination', weight_unit: 'MT',
        invoice_weight: 20, contam_accepted_pct: 10, sell_price: 1000, sell_price_unit: 'MT' }, 'a');
    await claims.raiseRecovery(k.id, { our_claim: 2000 }, 'a');
    const ch = report.toHtml(report.build({ supplier: CON, includeUnverified: true }));
    ck('a contamination claim keeps all nine columns',
       /Your rate/.test(ch) && !/Claim type/.test(ch),
       'the widening is an OR, not a replacement');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }

})().catch((e) => { console.error('\nCRASHED: ' + (e && e.stack || e)); process.exit(1); });
