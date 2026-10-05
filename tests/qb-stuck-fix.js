// ── tests/qb-stuck-fix.js ─────────────────────────────────────────────────
// Apsara, 2026-10-05: "Improve jarvis specifically in qb area as of now".
//
// ── THE DEFECT, FROM HER 4 OCTOBER MAIL ──────────────────────────────────
// 24 rows stuck. Every one of them is clickable on the QuickBooks page, and
// every one did the same thing: openParty(kind, name) — the supplier's
// QuickBooks NAME MAPPING.
//
// For 21 of the 24 the reason was a price missing on a BILL. The vendor
// mapping is correct and irrelevant; she clicks, lands somewhere fine, and
// learns nothing. Opening the wrong screen costs more than opening none,
// because it spends a click and a little trust each time.
//
// And the list read as 19 separate failures when it was one job: yard grades
// bought without a price.
//
// ── THE FIXTURE IS HER 24 ROWS ───────────────────────────────────────────
// Taken from the mail verbatim, reasons included, so the routing is judged on
// what her books actually produce rather than on reasons I invented to match
// my own rules.

const path = require('path');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const { stuckFix, groupStuck } = require(path.join(__dirname, '..', 'helpers/quickbooks/stuckFix'));

const P = (party, container, ...problems) => ({ kind: 'bill', party, container_no: container, problems });
const I = (party, container, ...problems) => ({ kind: 'invoice', party, container_no: container, problems });

// Her 4 October list, in order.
const OCT4 = [
    P('Junk car', 'TCNU5101067', 'no supplier amount yet', 'grade "Auto Battery" has no amount'),
    P('Calderon', 'TCNU5059310', 'no supplier amount yet', 'grade "AUTO CAST" has no amount'),
    P('Junk car', 'HMMU4741911', 'no supplier amount yet', 'grade "Auto cast" has no amount'),
    P('Edge Yard', 'HMMU4929318', 'no supplier amount yet', 'grade "Auto Cast" has no amount'),
    P('Edge Yard', 'KOCU4417874', 'no supplier amount yet', 'grade "Auto Battery" has no amount'),
    P('Edge Yard', 'MSDU2726332', 'no supplier amount yet', 'grade "Sealed units" has no amount',
      'grade "Alternator" has no amount', 'grade "Starter" has no amount', 'grade "Electric motors" has no amount'),
    P('Mario', 'BILL_1790190822968_umb5g', 'item "Electric motor with Fans" is none — confirm it first'),
    P('Edge Yard', 'BEAU6288355', 'no supplier amount yet', 'grade "BATTERY" has no amount'),
    P('Edge Yard', 'KOCU4930737', 'no supplier amount yet', 'grade "Regular combo" has no amount', 'grade "Al Combo" has no amount'),
    P('Inesh Cores Chapin', 'HMMU6872607', 'no supplier amount yet', 'grade "AUTO CAST" has no amount'),
    P('Mazariegos', 'GOAU6226932', 'no supplier amount yet', 'grade "Al Combo" has no amount'),
    P('Carlos G & C', 'PO#4302973', 'no invoice number — the number that ties this bill to its sale',
      'no supplier amount yet', 'grade "Dirty Al Wheels" has no amount'),
    P('Mazariegos', 'PACU894328', 'no invoice number — the number that ties this bill to its sale'),
    P('Gomez', 'SELU4226126', 'no supplier amount yet', 'grade "Auto Cast" has no amount'),
    P('Edge Yard', 'HMMU4766653', 'no supplier amount yet', 'grade "Auto Cast" has no amount'),
    P('Edge Yard', 'SMCU1291663', 'no supplier amount yet', 'grade "BATTERY" has no amount'),
    P('Inesh Cores Chapin', 'KOCU4401728', 'no supplier amount yet', 'grade "Auto cast" has no amount'),
    P('Mazariegos', 'HMMU4933766', 'no supplier amount yet', 'grade "Al Combo" has no amount'),
    P('Mazariegos', 'EMHU278671', 'no invoice number — the number that ties this bill to its sale'),
    P('Junk Car', 'TCLU6619618', 'no supplier amount yet', 'grade "Auto Cast" has no amount'),
    P('Calderon', 'GLDU9573030', 'no supplier amount yet', 'grade "Starter" has no amount',
      'grade "Alternator" has no amount', 'grade "Ac compressor" has no amount'),
    P('Mazariegos', 'HMMU6889636', 'no supplier amount yet', 'grade "BATTERY" has no amount'),
    I('Custom Alloys', '', 'grade "AL WHEELS DIRTY" has no amount'),
    I('DHATU INTERNATIONAL', 'GLDU9573030',
      'item "Auto Alternators" is none — confirm it first',
      'item "Alu nose starters" is suggest (maybe Al Nose Starters) — confirm it first',
      'item "Auto AC Compressors" is suggest (maybe AC Compressors) — confirm it first'),
];

// ── A — WHERE EACH ROW IS ACTUALLY FIXED ──────────────────────────────────
{
    section('A — her 24 rows, routed');

    const fixes = OCT4.map(stuckFix);
    const counts = fixes.reduce((m, f) => { m[f.where] = (m[f.where] || 0) + 1; return m; }, {});

    ck('nothing is unroutable', !counts.unknown, JSON.stringify(counts));
    ck('  21 go to the BILL, not the vendor mapping', counts.bill === 21, JSON.stringify(counts));
    ck('  2 go to the QuickBooks items', counts.item === 2, JSON.stringify(counts));

    // THE DEFECT, as a check: today every one of these opens the party screen.
    ck('  and NOT ONE of them is a name-mapping problem', !counts.party,
       'every row currently opens openParty(), which answers none of these');
}

// ── B — THE JOB, NOT THE SYMPTOM ──────────────────────────────────────────
{
    section('B — what it tells her to do');

    const mario = stuckFix(OCT4[6]);
    ck('an unconfirmed item goes to the items screen', mario.where === 'item', mario.where);
    ck('  naming the item to confirm',
       /Electric motor with Fans/.test(mario.detail), mario.detail);

    const msdu = stuckFix(OCT4[5]);
    ck('four unpriced grades is ONE instruction', msdu.where === 'bill' && msdu.grades.length === 4,
       JSON.stringify(msdu.grades));
    ck('  that says price four, and names them',
       /price 4 grades/.test(msdu.detail) && /Sealed units/.test(msdu.detail), msdu.detail);
    ck('  and says which bill', /MSDU2726332/.test(msdu.title), msdu.title);

    const carlos = stuckFix(OCT4[11]);
    ck('a row with two different problems reports both',
       /price 1 grade/.test(carlos.detail) && /invoice number/.test(carlos.detail), carlos.detail);
    ck('  and still goes to the bill, where both are fixed',
       carlos.where === 'bill', carlos.where);

    const pacu = stuckFix(OCT4[12]);
    ck('a missing invoice number alone is still the bill',
       pacu.where === 'bill' && /invoice number/.test(pacu.detail), `${pacu.where} / ${pacu.detail}`);
    ck('  and does not claim a grade needs pricing',
       !/price/.test(pacu.detail), pacu.detail);

    // The invoice with no container: the title must not read "Bills → null".
    const custom = stuckFix(OCT4[22]);
    ck('a row with no container does not print a null destination',
       !/null|undefined/.test(custom.title + custom.detail), `${custom.title} — ${custom.detail}`);
}

// ── C — NINETEEN ROWS, ONE JOB ────────────────────────────────────────────
{
    section('C — grouped');

    const groups = groupStuck(OCT4);

    ck('24 rows become a handful of jobs', groups.length >= 2 && groups.length <= 5,
       groups.map((g) => `${g.count}×${g.shape}`).join(' | '));

    const biggest = groups[0];
    ck('  the biggest job is pricing grades on bills',
       biggest.where === 'bill' && /price/.test(biggest.shape), biggest.shape);
    // EIGHTEEN, not the nineteen I first wrote. Carlos G & C PO#4302973 needs
    // a price AND an invoice number, so it is its own job — a row belongs to
    // one group, because a worklist that counts the same bill twice makes the
    // pile look bigger than it is. My expected number was wrong and the
    // grouping was right; corrected here rather than in the code.
    ck('  and it is 18 of them', biggest.count === 18, String(biggest.count));
    ck('  listing the containers so she can work through them',
       biggest.containers.length === 18 && biggest.containers.includes('MSDU2726332'),
       `${biggest.containers.length} containers`);
    ck('  the one needing a price AND an invoice number is kept separate',
       !biggest.containers.includes('PO#4302973'),
       'two different fixes is a different job');
    ck('  and the distinct grades to price',
       biggest.grades.length > 5 && biggest.grades.includes('Auto Cast'),
       biggest.grades.join(', '));

    ck('  sorted biggest first', groups.every((g, i) => i === 0 || groups[i - 1].count >= g.count),
       groups.map((g) => g.count).join(','));

    // The three invoice-number-only rows are their own job, not folded in
    // with the pricing — a different fix on a different field.
    const invNo = groups.find((g) => /invoice_no/.test(g.shape) && !/price/.test(g.shape));
    ck('  a missing invoice number ALONE is its own job', !!invNo && invNo.count === 2,
       groups.map((g) => `${g.count}×${g.shape}`).join(' | '));

    // The sale with an unpriced grade must not be filed under Bills — same
    // symptom, other ledger. This is what caught my own modelling error.
    const sale = groups.find((g) => g.where === 'sale');
    ck('  and an unpriced grade on an INVOICE is a separate, Invoices job',
       !!sale && sale.count === 1 && sale.label === 'Invoices',
       groups.map((g) => `${g.count}×${g.where}`).join(' | '));

    const itemJob = groups.find((g) => g.where === 'item');
    ck('  and confirming items is another', !!itemJob && itemJob.count === 2,
       itemJob && String(itemJob.count));

    const total = groups.reduce((t, g) => t + g.count, 0);
    ck('  every row lands in exactly one group', total === OCT4.length, `${total} of ${OCT4.length}`);
}

// ── D2 — THE SHAPE THE PAGE ACTUALLY RECEIVES ─────────────────────────────
// sync.js writes { kind, id, container_no, party, problems[] }. The page and
// the email get something else: quickbooksNightly.js rebuilds the rows off
// the journal as { kind, who, what, why }, with the reasons joined by "; ".
//
// Written for the first shape, this helper returns 'unknown' for every row of
// the second — and the feature would have shipped doing nothing at all, on a
// page where nothing visibly broke. Checked with a row copied from the mail.
{
    section('D2 — rows as the page receives them');

    const live = { kind: 'bill', who: 'Edge Yard', what: 'MSDU2726332',
                   why: 'no supplier amount yet; grade "Sealed units" has no amount; '
                      + 'grade "Alternator" has no amount; grade "Starter" has no amount; '
                      + 'grade "Electric motors" has no amount' };
    const f = stuckFix(live);
    ck('a journal-shaped row routes to the bill', f.where === 'bill', f.where);
    ck('  with all four grades read out of the joined string',
       f.grades.length === 4 && f.grades.includes('Electric motors'), JSON.stringify(f.grades));
    ck('  the container comes off `what`', /MSDU2726332/.test(f.title), f.title);
    ck('  and the instruction is the same as the structured shape',
       /price 4 grades/.test(f.detail), f.detail);

    const liveItem = { kind: 'bill', who: 'Mario', what: 'BILL_1790190822968_umb5g',
                       why: 'item "Electric motor with Fans" is none — confirm it first' };
    ck('  and an item row still goes to the items screen',
       stuckFix(liveItem).where === 'item', stuckFix(liveItem).where);

    // Grouping must work on this shape too, since it is the one that reaches
    // the screen.
    const grouped = groupStuck([live, live, liveItem]);
    ck('  grouping works on journal rows', grouped[0].count === 2 && grouped[0].where === 'bill',
       grouped.map((g) => `${g.count}×${g.where}`).join(' | '));
}

// ── D — IT DOES NOT GUESS ─────────────────────────────────────────────────
{
    section('D — a reason nobody has seen before');

    const odd = stuckFix({ kind: 'bill', party: 'X', container_no: 'C1',
                           problems: ['the moon is in the wrong house'] });
    ck('it is not routed anywhere', odd.where === 'unknown', odd.where);
    ck('  and shows the reason as written rather than inventing a destination',
       /moon is in the wrong house/.test(odd.detail), odd.detail);

    for (const [label, input] of [['null', null], ['no problems', { kind: 'bill' }],
                                  ['problems not an array', { problems: 'x' }],
                                  ['a null problem', { problems: [null, undefined] }]]) {
        let err = null; let out = null;
        try { out = stuckFix(input); } catch (e) { err = e; }
        ck(`  ${label} does not throw`, !err && !!out && out.where === 'unknown', err && err.message);
    }
    let gerr = null;
    try { groupStuck(null); } catch (e) { gerr = e; }
    ck('  and grouping nothing is empty, not a crash', !gerr, gerr && gerr.message);
}

// ── E — THE PAGE USES IT, AND STOPS OPENING THE WRONG SCREEN ──────────────
// Static, and said so: dashboard/quickbooks.html is a separate page with its
// own boot, so this asserts the wiring rather than rendering it. The property
// that matters is negative — a bill row must NOT be clickable to openParty —
// and a negative is the kind a grep can actually establish.
{
    section('E — the page');

    const fs = require('fs');
    const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard/quickbooks.html'), 'utf8');

    ck('both stuck tables render through one function',
       (html.match(/\.map\(stuckRow\)/g) || []).length === 2,
       String((html.match(/\.map\(stuckRow\)/g) || []).length));
    // ── THE ASKED TABLE IS DELIBERATELY UNTOUCHED ────────────────────────
    // This check first failed because it was matching THAT table, not a stuck
    // one. Those rows are a different question — "the same money looks like it
    // is already there" — where the party screen may well be the right place
    // to look. The request was about stuck rows; widening it to a screen I
    // have not thought through is the CLAUDE.md rule-1 mistake. So the check
    // now says what it means.
    ck('  no STUCK table builds its own row inline',
       !/t\.stuck\.slice\(0, 40\)\.map\(x =>/.test(html)
       && !/out\.blocked\.slice\(0, 40\)\.map\(b =>/.test(html),
       'both go through stuckRow now');
    ck('  and the asked table is left exactly as it was',
       /t\.asked\.slice\(0, 40\)\.map\(x =>/.test(html),
       'untouched on purpose — a different question, possibly a different screen');

    ck('a row is only clickable when the PARTY or the ITEM is the problem',
       /const clickable = f\.where === 'party' \|\| f\.where === 'item';/.test(html),
       'a bill with an unpriced grade must not open the vendor mapping');
    ck('  the destination is shown on the row', /f\.title/.test(html) && /f\.detail/.test(html));
    ck('  and the jobs summary is above both tables',
       (html.match(/\$\{stuckJobs\(/g) || []).length === 2,
       String((html.match(/\$\{stuckJobs\(/g) || []).length));

    // The server must actually send `fix`, or every row falls back to the
    // raw reason and the whole thing is decoration.
    const routes = fs.readFileSync(path.join(__dirname, '..', 'helpers/quickbooks/routes.js'), 'utf8');
    ck('the route attaches fix to stuck and asked rows',
       /stuck: withFix\(/.test(routes) && /asked: withFix\(/.test(routes), 'withFix missing');
    const nightly = fs.readFileSync(path.join(__dirname, '..', 'helpers/quickbooksNightly.js'), 'utf8');
    ck('  and so does the nightly mail, from the same helper',
       /stuckFix\(row\)/.test(nightly) && /quickbooks\/stuckFix/.test(nightly),
       'the page and the mail must describe a row the same way');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
