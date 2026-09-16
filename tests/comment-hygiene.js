// ── tests/comment-hygiene.js ──────────────────────────────────────────────
// Apsara, 2026-09-16, attaching HMMU7060866_packing.pdf — a packing list that
// went out with this printed across the middle of it, between the header and
// the weights:
//
//     overall for the container". They were blank cells before, which on a
//     list of one row was merely redundant and on a list of three items was a
//     missing answer. -->
//
// That is MY COMMENT, on a customer's document.
//
// ── WHY IT HAPPENED ─────────────────────────────────────────────────────────
// The comment quoted her message, and her message contains an arrow written
// with three hyphens: "adding those gross,net,tare --->overall for the
// container". An HTML comment ends at the FIRST "-->" — so the comment closed
// three words into the quotation and everything after it became text.
//
// Nothing errored. The PDF rendered. Every one of the 162 checks in
// tests/packing-list.js passed, because they all read the table and the table
// was perfect. The failure was in the gap between two correct elements, which
// is the one place assertions about elements never look.
//
// ── THE THIRD TIME ──────────────────────────────────────────────────────────
// This project has now been bitten three times by a comment terminator inside
// the thing being commented:
//
//   the /* */ stripper in the test helpers ate most of documents.html, because
//   accept="image/*,application/pdf" opens a block comment;
//   the same stripper, again, in two more test files;
//   and now this — the only one of the three that reached a customer.
//
// So it is a suite, not a comment. It reads every file that is rendered or
// served and asserts that comments STAY comments.
//
// ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
// It does not look inside <script> or <style>. A "-->" in a JavaScript line
// comment is text in a string to the parser and prints nothing; flagging those
// would be noise, and a suite that cries wolf about six harmless lines is one
// that gets ignored on the seventh, which is the real one.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');

// Everything that is rendered into a document or served to a browser. The
// templates first: those are the ones a CUSTOMER sees.
const FILES = [
    'assets/invoice-classic/template.html',
    'assets/bol/template.html',
    'assets/invoice-dc2/template.html',
    'assets/proforma-dc2/template.html',
    'dashboard/index.html',
    'dashboard/documents.html',
    'dashboard/design-bol.html',
    'mobile-app/www/index.html',
].filter((f) => fs.existsSync(path.join(ROOT, f)));

// Blanks out <script> and <style> bodies, keeping the length identical so the
// line numbers a failure reports are the real ones.
function maskScripts(s) {
    return s.replace(/<(script|style)\b[^>]*>([\s\S]*?)<\/\1>/gi,
        (m, tag, body) => m.slice(0, m.length - body.length - tag.length - 3)
                          + body.replace(/[^\n]/g, ' ')
                          + `</${tag}>`);
}

// Walks the file the way a parser does: a comment runs from "<!--" to the
// FIRST "-->", whatever is in between.
function scan(src) {
    const s = maskScripts(src);
    const out = { strays: [], unterminated: null, comments: [] };
    let i = 0, inComment = false, start = 0;
    while (i < s.length) {
        if (!inComment) {
            const open = s.indexOf('<!--', i);
            const close = s.indexOf('-->', i);
            if (close >= 0 && (open < 0 || close < open)) {
                // A terminator with no comment open: whatever came before it
                // is being PRINTED.
                out.strays.push({ line: s.slice(0, close).split('\n').length,
                                  text: s.slice(Math.max(0, close - 110), close).replace(/\s+/g, ' ').trim() });
                i = close + 3;
                continue;
            }
            if (open < 0) break;
            inComment = true; start = open; i = open + 4;
        } else {
            const close = s.indexOf('-->', i);
            if (close < 0) { out.unterminated = s.slice(0, start).split('\n').length; break; }
            out.comments.push({ line: s.slice(0, start).split('\n').length, body: s.slice(start + 4, close) });
            inComment = false; i = close + 3;
        }
    }
    return out;
}

// ══════════════════════════════════════════════════════════════════════════
section('A — no comment leaks into the page');
// ══════════════════════════════════════════════════════════════════════════
for (const f of FILES) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const r = scan(src);
    ck(`${f}: every "-->" closes a comment`, r.strays.length === 0,
       r.strays.map((s) => `line ${s.line}: …${s.text} -->`).join('\n        ')
       + '  ← this text PRINTS');
    ck(`  ${f}: and every comment is closed`, r.unterminated === null,
       r.unterminated ? `opened at line ${r.unterminated} and never closed — everything after it vanishes` : '');
}

// ══════════════════════════════════════════════════════════════════════════
section('B — and none of them is one step away from leaking');
// ══════════════════════════════════════════════════════════════════════════
// The HTML spec forbids "--" inside a comment for exactly this reason. A
// comment carrying one is not broken today and breaks the moment anyone adds
// a ">" after it, or reflows the paragraph.
for (const f of FILES) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const r = scan(src);
    const risky = r.comments.filter((c) => /--/.test(c.body));
    ck(`${f}: no run of hyphens inside a comment`, risky.length === 0,
       risky.map((c) => `line ${c.line}: ${(c.body.match(/.{0,60}--.{0,40}/s) || [''])[0].replace(/\s+/g, ' ').trim()}`)
            .join('\n        '));
}

// ══════════════════════════════════════════════════════════════════════════
section('C — the document she was sent, rebuilt');
// ══════════════════════════════════════════════════════════════════════════
// Not the template: the ASSEMBLED html, which is what the leak was actually
// in. A template that is clean can still be handed a value containing "-->",
// and the substitution is a dumb string replace.
{
    const { buildInvoiceClassicHtml } = require(path.join(ROOT, 'helpers/invoicePdf'));
    const weights = [[1111, 65], [1228, 65], [927, 86], [1239, 118],
                     [1399, 65], [1385, 118], [1388, 118], [1174, 118]];
    const { html } = buildInvoiceClassicHtml({
        inv_no: '260901_AL_26JY95', container_no: 'HMMU7060866', consignee: 'Taewon Automotive',
        line_items: weights.map(([g, t]) => ({
            container_no: 'HMMU7060866',
            packing: { gross_weight_lbs: String(g), tare_lbs: String(t), net_weight_lbs: String(g - t) },
        })),
    });
    const r = scan(html);
    ck('the built packing list leaks nothing', r.strays.length === 0,
       r.strays.map((s) => `…${s.text} -->`).join(' | '));

    // Read as a browser reads it: strip the comments, then look for words that
    // only ever appear in one. This is the check that would have caught the
    // real thing, and it is deliberately about the PROSE rather than the
    // punctuation — a leak is only visible because English lands on the page.
    const visible = html.replace(/<!--[\s\S]*?-->/g, ' ')
                        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
                        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    for (const tell of ['blank cells', 'Apsara', 'redundant', 'the note above', 'TODO', 'FIXME']) {
        ck(`  no "${tell}" on the printed page`, !visible.includes(tell),
           (visible.match(new RegExp(`.{0,60}${tell}.{0,60}`)) || [''])[0]);
    }

    // ── AND THE OTHER THING THAT PDF SHOWED ──────────────────────────────
    // Every row of her Net Weight (MT) column printed 0.000, and so did the
    // TOTAL. On a customs document that is a stated net weight of zero tonnes.
    // A weigh sheet has pounds and nothing else; the tonnes are a conversion.
    const d = html.slice(html.indexOf('<div class="doc-packing">'));
    const tbl = d.slice(d.indexOf('<table'), d.indexOf('</table>'));
    const rows = [...tbl.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/g)].map((m) =>
        [...m[0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)]
            .map((c) => c[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()));
    ck('no row claims zero tonnes', !rows.slice(1).some((r2) => r2[4] === '0.000'),
       rows.slice(1).map((r2) => r2[4]).join(', '));
    const total = rows[rows.length - 1];
    ck('  the MT total is the pounds converted', total[4] === '4.127',
       `${total[4]} — 9,098 lbs is 4.127 mt, and 0.000 is what it printed`);
    ck('  and the lbs total is unchanged', total[3] === '9,098', total.join(' | '));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }
