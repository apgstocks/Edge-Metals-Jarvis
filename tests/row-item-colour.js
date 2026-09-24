// ── tests/row-item-colour.js ──────────────────────────────────────────────
// Apsara, 2026-09-24, with a mock of "Al combo, Regular Combo" rendered three
// ways — first word red, neither red, second word red: "just replicate the
// colour exactly in invoice and packing lsit".
//
// Asked where it belonged she chose the per-row Description column over the
// header label, having been told plainly that it means each row starts
// listing ALL the materials on the document rather than only its own. So this
// is a content change as well as a colour one, and it was made with that
// understood.
//
// ── WHAT THIS PINS ────────────────────────────────────────────────────────
//
//   1. THE COLOUR, EXACTLY. #EA3323, sampled from the solid glyph fill of her
//      mock. "Replicate the colour exactly" is the whole request, so a test
//      that accepted any red would be testing nothing she asked for.
//
//   2. THE RIGHT WORD IS RED. Reddening the wrong material on a customer's
//      invoice is worse than reddening none: it states that a container holds
//      goods it does not.
//
//   3. A SINGLE-MATERIAL DOCUMENT IS UNTOUCHED. My call, not hers, and
//      recorded as mine in helpers/invoicePdf.js: on a document with one
//      material every row would print the same lone name in red, which is
//      decoration rather than information, and it would change every
//      single-material invoice she has ever sent.
//
//   4. THE TWO DOCUMENTS AGREE. The invoice's Description column and the
//      packing list's Item column go through one helper, because two copies
//      of a rule is how they drift.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-rowcolour-'));
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const { buildInvoiceClassicHtml: buildRaw } = require(path.join(ROOT, 'helpers/invoicePdf'));
// It returns { html, subtotal, notes, finalAmount }, not a bare string.
// String(obj) is "[object Object]", against which every NEGATIVE check in
// this file passes vacuously — which is exactly what the first run did until
// the "cells.length >= 2" guard caught it.
const buildInvoiceClassicHtml = async (d) => {
    const r = await buildRaw(d);
    const html = (r && typeof r === 'object') ? r.html : r;
    if (typeof html !== 'string' || html.length < 200) {
        throw new Error('buildInvoiceClassicHtml returned no html — every check below would be meaningless');
    }
    return html;
};

// Sampled from her mock: the solid glyph fill, 1,284 px of it. Written as a
// literal rather than imported so that changing the constant in the source
// without meaning to turns this red.
const RED = '#EA3323';

const row = (desc, container, seal, lbs, rate) => ({
    item_desc: desc, container_no: container, seal_no: seal,
    net_weight_lbs: lbs, rate, amount: Math.round(lbs * rate * 100) / 100,
});
const doc = (items) => ({
    inv_no: '260901_AL_26JY96,260901_RC_26JY97', inv_date: '2026-09-24',
    consignee: 'MK Trading', booking_no: 'BK1', line_items: items,
});

// The Description / Item cells, in document order.
const comboCells = (html) => (html.match(/<td[^>]*>(?:(?!<\/td>)[\s\S])*?[Cc]ombo(?:(?!<\/td>)[\s\S])*?<\/td>/g) || [])
    .map((c) => c.replace(/<td[^>]*>/, '').replace(/<\/td>/, '').trim());

(async () => {

const MIXED = [
    row('Al combo', 'AAAU1111111', 'S1', 40000, 0.5),
    row('Regular Combo', 'BBBU2222222', 'S2', 41000, 0.4),
];
const SINGLE = [
    row('Al combo', 'AAAU1111111', 'S1', 40000, 0.5),
    row('Al combo', 'CCCU3333333', 'S3', 39000, 0.5),
];

const mixedHtml  = await buildInvoiceClassicHtml(doc(MIXED));
const singleHtml = await buildInvoiceClassicHtml(doc(SINGLE));

// ══════════════════════════════════════════════════════════════════════════
section('A — her mock, reproduced');
// ══════════════════════════════════════════════════════════════════════════
{
    const cells = comboCells(mixedHtml);
    ck('the document has cells naming the materials', cells.length >= 2, String(cells.length));

    // Line one: "Al combo" red, "Regular Combo" black. Line two: the reverse.
    ck('row 1 reddens Al combo and leaves Regular Combo black',
       cells[0] === `<span style="color:${RED};">Al combo</span>, Regular Combo`, cells[0]);
    ck('row 2 reddens Regular Combo and leaves Al combo black',
       cells[1] === `Al combo, <span style="color:${RED};">Regular Combo</span>`, cells[1]);

    // THE COLOUR, EXACTLY. Not a near red, not --status-danger.
    ck('the colour is exactly #EA3323', mixedHtml.includes(RED));
    ck('  and no other red is used on these cells',
       !cells.some((c) => /color:\s*(?!#EA3323)(#|red|rgb|var\()/i.test(c)),
       cells.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
section('B — EVERY row lists every material, with its own in red');
// ══════════════════════════════════════════════════════════════════════════
// The content half of the change, which she was told about before choosing.
{
    const cells = comboCells(mixedHtml);
    for (let i = 0; i < cells.length; i++) {
        ck(`cell ${i + 1} names both materials`,
           /Al combo/.test(cells[i]) && /Regular Combo/.test(cells[i]), cells[i]);
        ck(`  and reddens exactly one of them`,
           (cells[i].match(new RegExp(RED, 'g')) || []).length === 1, cells[i]);
    }
    // Both tables, not just the invoice: the packing list's Item column runs
    // through the same helper. Two rows each.
    ck('both the invoice AND the packing list carry it',
       (mixedHtml.match(new RegExp(RED, 'g')) || []).length === 4,
       String((mixedHtml.match(new RegExp(RED, 'g')) || []).length));
}

// ══════════════════════════════════════════════════════════════════════════
section('C — a single-material document is untouched');
// ══════════════════════════════════════════════════════════════════════════
// Every invoice she has ever sent for one material keeps printing exactly
// what it prints today. This is the check that makes the feature safe to
// deploy without reviewing her back catalogue.
{
    ck('no red at all', !singleHtml.includes(RED));
    const cells = comboCells(singleHtml);
    ck('  and the cell is just the name', cells[0] === 'Al combo', cells[0]);
    ck('  with no comma-joined list', !cells.some((c) => c.includes(',')), cells.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
section('D — the rule itself, on the edges');
// ══════════════════════════════════════════════════════════════════════════
{
    // Three materials: each row still reddens only its own.
    const THREE = [
        row('Alternator', 'AAAU1111111', 'S1', 10000, 1),
        row('Starter', 'BBBU2222222', 'S2', 11000, 1),
        row('Ac compressor', 'CCCU3333333', 'S3', 12000, 1),
    ];
    const h = await buildInvoiceClassicHtml(doc(THREE));
    const cells = (h.match(/<td[^>]*>(?:(?!<\/td>)[\s\S])*?Alternator(?:(?!<\/td>)[\s\S])*?<\/td>/g) || [])
        .map((c) => c.replace(/<td[^>]*>/, '').replace(/<\/td>/, '').trim());
    ck('with three materials every row lists all three',
       cells.length > 0 && /Alternator/.test(cells[0]) && /Starter/.test(cells[0]) && /Ac compressor/.test(cells[0]),
       cells[0]);
    ck('  and still reddens exactly one',
       (cells[0].match(new RegExp(RED, 'g')) || []).length === 1, cells[0]);
    ck('  the first row reddens the FIRST material',
       new RegExp(`color:${RED};">Alternator<`).test(cells[0]), cells[0]);

    // The same material spelled with different casing is ONE material, not
    // two — otherwise a row would list "Al combo, AL COMBO" and redden one of
    // them, which reads as a distinction that does not exist.
    const CASED = [
        row('Al combo', 'AAAU1111111', 'S1', 10000, 1),
        row('AL COMBO', 'BBBU2222222', 'S2', 11000, 1),
    ];
    const hc = await buildInvoiceClassicHtml(doc(CASED));
    ck('casing alone does not make a second material', !hc.includes(RED),
       (comboCells(hc)[0] || ''));

    // A blank description must not produce a stray comma or an empty red span.
    const BLANK = [
        row('Al combo', 'AAAU1111111', 'S1', 10000, 1),
        row('', 'BBBU2222222', 'S2', 11000, 1),
    ];
    const hb = await buildInvoiceClassicHtml(doc(BLANK));
    ck('a blank description is not listed as a material', !hb.includes(RED),
       (comboCells(hb)[0] || ''));

    // And the text is ESCAPED — the helper returns HTML, so a description
    // with an angle bracket in it must not become markup on a financial
    // document.
    const XSS = [
        row('<b>Al combo</b>', 'AAAU1111111', 'S1', 10000, 1),
        row('Regular Combo', 'BBBU2222222', 'S2', 11000, 1),
    ];
    const hx = await buildInvoiceClassicHtml(doc(XSS));
    // BOTH BRANCHES. The first version of this check only proved the text
    // was escaped SOMEWHERE — and the black branch escapes it independently,
    // so dropping escapeHtml from inside the red span left the test green.
    // A mutation that survives is a check that is not testing its own name.
    ck('a description is escaped INSIDE the red span',
       hx.includes(`<span style="color:${RED};">&lt;b&gt;Al combo&lt;/b&gt;</span>`),
       (hx.match(new RegExp(`<span style="color:${RED};">[\\s\\S]{0,40}`)) || [''])[0]);
    ck('  and escaped in the black branch too',
       /Al combo<\/b&gt;, |&lt;b&gt;Al combo&lt;\/b&gt;, /.test(hx) || hx.includes('&lt;b&gt;Al combo&lt;/b&gt;, '),
       'the non-highlighted copy must be escaped as well');
    ck('  and it is not double-escaped', !hx.includes('&amp;lt;b&amp;gt;'));
    ck('  so no raw tag reaches the document', !hx.includes('<b>Al combo</b>'));
}

// ══════════════════════════════════════════════════════════════════════════
section('E — ONE CONTAINER, NO RED — the regression that got caught');
// ══════════════════════════════════════════════════════════════════════════
// This guard was not reasoned out in advance. It was found by
// tests/packing-list.js going red, which is the whole reason CLAUDE.md says
// to run the suite rather than the files you remember.
//
// Apsara, 2026-09-16: "sometimes i will have 3 different items in a
// container..for eg:alternator,starter,ac compressor.each with separate
// weight" — which is why the packing list has an Item column at all. Every
// row there is the SAME container holding a different material. Listing all
// three on all three rows turns a column she asked for into noise, and
// reddening one states a distinction that does not exist: they are all in
// the one box.
//
// The red answers "which of these is in THIS container". One container, no
// question, no red.
{
    const ONE_BOX = [
        row('Alternator', 'HMMU7060866', 'S1', 6000, 1),
        row('Starter', 'HMMU7060866', 'S1', 5000, 1),
        row('Ac compressor', 'HMMU7060866', 'S1', 4000, 1),
    ];
    const h = await buildInvoiceClassicHtml(doc(ONE_BOX));
    ck('three materials in ONE container get no red', !h.includes(RED));
    const cells = (h.match(/<td[^>]*>(?:(?!<\/td>)[\s\S])*?Alternator(?:(?!<\/td>)[\s\S])*?<\/td>/g) || [])
        .map((c) => c.replace(/<td[^>]*>/, '').replace(/<\/td>/, '').trim());
    ck('  and each row still names only its own material', cells[0] === 'Alternator', cells[0]);
    ck('  so the Item column she asked for on 2026-09-16 is intact',
       !cells.some((c) => /Starter/.test(c)), cells.join(' | '));

    // A missing container_no must take the same safe branch — an invoice
    // that never filled the field is a single-container document, not a
    // licence to list everything.
    const NO_CONTAINER = [
        row('Al combo', '', '', 40000, 0.5),
        row('Regular Combo', '', '', 41000, 0.4),
    ];
    const h2 = await buildInvoiceClassicHtml(doc(NO_CONTAINER));
    ck('no container numbers at all means no red either', !h2.includes(RED));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }

})().catch((e) => { console.error(e); process.exit(1); });
