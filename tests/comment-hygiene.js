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

// ── THE FOURTH TIME, AND THE BLIND SPOT THAT LET IT THROUGH ─────────────
// Apsara, 2026-10-14, screenshotting the Record Payment modal with six lines
// of my comment printed inside it, trailing "-->". Her own instruction
// contains an arrow — "when bofa-->Edge metals ac" — so the comment quoting
// it closed at "bofa-->" and the rest became page text. Exactly the packing
// list failure above, in a different screen.
//
// THIS SUITE WAS WRITTEN FOR THAT AND STILL MISSED IT. maskScripts() blanks
// <script> bodies by design, and the reasoning was sound: a "-->" in a JS
// line comment prints nothing. But on 2026-10-12 dashboard/index.html's
// inline script was split into dashboard/app/*.js, which moved this markup
// from HTML the suite read into a script body it deliberately ignored. The
// guard did not break; the code walked out from under it.
//
// So: the template literals in those files are scanned as the HTML they
// become. JS line comments are still ignored — masked below — because that
// part of the original reasoning is still true.
const TEMPLATE_FILES = (() => {
    const out = [];
    try {
        for (const f of fs.readdirSync(path.join(ROOT, 'dashboard/app')).sort()) {
            if (f.endsWith('.js')) out.push('dashboard/app/' + f);
        }
    } catch (e) { /* the split may be reverted; FILES still covers index.html */ }
    return out;
})();

// Blank out JS comments and ordinary string literals, keeping length and
// newlines, so only what is inside a backtick template survives to be read
// as markup. A "-->" in `// like this` is text to the parser and prints
// nothing — flagging it would be the noise the header warns about.
// ── STRINGS FIRST. THIS ORDER IS THE WHOLE FUNCTION ─────────────────────
// Written the obvious way — comments, then strings — it immediately
// reproduced the FIRST failure in this file's own history, listed in the
// header above: `accept="image/*"` contains `/*`, which opens a block
// comment that then swallows everything up to the next `*/`, including the
// `-->` that closes a real comment. The suite reported an unterminated
// comment in a file that had none.
//
// Blanking quoted strings first removes `image/*` before anything looks for
// a block comment, and removes `//` inside a URL at the same time. Template
// literals are deliberately NOT masked — they are the markup being checked.
// A SECOND WRONG VERSION, kept in the note because it passed: masking
// `"..."` everywhere ate the very quote that caused the bug. Inside a
// template literal a double quote is an HTML attribute delimiter, not a
// string — so `"...bofa-->..."` was blanked and the leak became invisible.
// Proved by re-inserting her arrow and watching the suite stay green.
//
// So it is a walk, not a set of regexes: outside a template nothing can be
// markup and everything is blanked; inside one, every character is kept.
function maskNonTemplate(s) {
    const out = Array.from(s);
    const blank = (from, to) => {
        for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
    };
    let i = 0;
    while (i < s.length) {
        const c = s[i];
        if (c === '`') {                                  // a template: keep all of it
            i += 1;
            while (i < s.length && !(s[i] === '`' && s[i - 1] !== '\\')) i += 1;
            i += 1;
            continue;
        }
        if (c === '/' && s[i + 1] === '/') {              // line comment
            const end = s.indexOf('\n', i); const to = end < 0 ? s.length : end;
            blank(i, to); i = to; continue;
        }
        if (c === '/' && s[i + 1] === '*') {              // block comment
            const end = s.indexOf('*/', i + 2); const to = end < 0 ? s.length : end + 2;
            blank(i, to); i = to; continue;
        }
        if (c === "'" || c === '"') {                     // ordinary string
            let j = i + 1;
            while (j < s.length && s[j] !== c && s[j] !== '\n') { if (s[j] === '\\') j += 1; j += 1; }
            blank(i, j + 1); i = j + 1; continue;
        }
        out[i] = c === '\n' ? '\n' : ' ';                 // plain code
        i += 1;
    }
    return out.join('');
}

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
    const src = f === 'dashboard/index.html' ? require('../helpers/sourceParts').indexHtml() : fs.readFileSync(path.join(ROOT, f), 'utf8');
    const r = scan(src);
    ck(`${f}: every "-->" closes a comment`, r.strays.length === 0,
       r.strays.map((s) => `line ${s.line}: …${s.text} -->`).join('\n        ')
       + '  ← this text PRINTS');
    ck(`  ${f}: and every comment is closed`, r.unterminated === null,
       r.unterminated ? `opened at line ${r.unterminated} and never closed — everything after it vanishes` : '');
}

// ── THE SAME WALK, OVER MARKUP THAT LIVES IN .js NOW ────────────────────
// dashboard/app/*.js hold the template literals that used to be inline HTML
// in dashboard/index.html. They render into the page, so a comment in one
// leaks exactly as it would in a .html file — which is how Apsara came to
// read six lines of mine inside the Record Payment modal.
for (const f of TEMPLATE_FILES) {
    const src = maskNonTemplate(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    const r = scan(src);
    ck(`${f}: every "-->" in a template closes a comment`, r.strays.length === 0,
       r.strays.map((s) => `line ${s.line}: …${s.text} -->`).join('\n        ')
       + '  ← this text PRINTS INTO THE PAGE');
    ck(`  ${f}: and every comment in one is closed`, r.unterminated === null,
       r.unterminated ? `opened at line ${r.unterminated} and never closed` : '');
}
// A guard that scans nothing reports all-clear. If the split is ever
// reverted or the folder renamed, this says so rather than passing silently.
ck(`the template sweep found files to read (${TEMPLATE_FILES.length})`,
   TEMPLATE_FILES.length >= 10, 'dashboard/app/*.js is empty — this check is blind');

// ══════════════════════════════════════════════════════════════════════════
section('B — and none of them is one step away from leaking');
// ══════════════════════════════════════════════════════════════════════════
// The HTML spec forbids "--" inside a comment for exactly this reason. A
// comment carrying one is not broken today and breaks the moment anyone adds
// a ">" after it, or reflows the paragraph.
for (const f of FILES) {
    const src = f === 'dashboard/index.html' ? require('../helpers/sourceParts').indexHtml() : fs.readFileSync(path.join(ROOT, f), 'utf8');
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
    // packing_compact: this is the PACKING LIST TAB's document — one row per
    // bundle, one tare. The invoice tab's is a different shape (2026-09-17,
    // "my invoice tab's packing list need to have gross,tare,container,boxes
    // like last time") and this fixture is a weigh sheet, not an invoice.
    const { html } = buildInvoiceClassicHtml({
        packing_compact: true,
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
    // By NAME, not by position: the Container column is dropped when every row
    // is the same container (2026-09-16, "Why would i need to repeat container
    // number?"), which is exactly this fixture. A check that counts from the
    // left reads the wrong column the day the shape changes, and this file
    // exists because of a failure nothing noticed.
    const col = (name) => rows[0].findIndex((h) => h.replace(/\s+/g, ' ').startsWith(name));
    const mt = col('Net Weight (MT)'), lbs = col('Net Weight (lbs)');
    ck('no row claims zero tonnes', !rows.slice(1, -1).some((r2) => r2[mt] === '0.000'),
       rows.slice(1, -1).map((r2) => r2[mt]).join(', '));
    const total = rows[rows.length - 1];
    ck('  the MT total is the pounds converted', total[mt] === '4.127',
       `${total[mt]} — 9,098 lbs is 4.127 mt, and 0.000 is what it printed`);
    ck('  and the lbs total is unchanged', total[lbs] === '9,098', total.join(' | '));
    ck('  and the eight identical containers print once, above the table',
       /Container: HMMU7060866/.test(html) && !rows[0].some((h) => /Container/.test(h)),
       rows[0].join(' | '));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }
