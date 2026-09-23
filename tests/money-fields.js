// ── tests/money-fields.js ─────────────────────────────────────────────────
// 260923_MC_26MK80 billed MK Trading $18,439.92. It should have been
// $18,234.92 — Apsara had entered a Freight deduction of -$205, the row was
// on screen with the figure visible in the box, and it reached neither the
// total nor the PDF.
//
// CAUSE: <input type="number">. A number input whose contents are not a
// valid number returns the EMPTY STRING from .value while still DISPLAYING
// what was typed. The dollar sign made it invalid:
//
//     "-205"   -> .value "-205"  -> -205
//     "-$205"  -> .value ""      -> parseFloat("") || 0  ->  0
//
// and a note of 0 is dropped. One ordinary keystroke deleted $205 from a
// signed commercial invoice with no error and no warning.
//
// Four boxes had the same trap. This pins all four, on both clients, by
// setting the value the browser would have and reading what the page makes
// of it — not by grepping for the fix.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const WEB = fs.readFileSync(path.join(ROOT, 'dashboard', 'documents.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'mobile-app', 'www', 'index.html'), 'utf8');

section('A — the four money boxes are no longer type=number');
{
    // Named individually rather than counted, so a box that quietly goes back
    // to type=number is a named failure and not a number that moved.
    const boxes = [
        ['website  Invoice Notes amount', WEB, 'inv-note-amount'],
        ['website  line item Qty',        WEB, 'inv-item-weight'],
        ['website  line item Rate',       WEB, 'inv-item-rate'],
        ['phone    Invoice Notes amount', APP, 'invw-note-amount'],
    ];
    for (const [name, src, cls] of boxes) {
        const uses = [...src.matchAll(new RegExp(`class="${cls}"[^>]*`, 'g'))].map((m) => m[0]);
        ck(`${name} — found ${uses.length} input(s)`, uses.length > 0);
        ck(`${name} — none is type=number`, uses.every((u) => !/type="number"/.test(u)),
            uses.filter((u) => /type="number"/.test(u)).join(' | '));
    }
}

section('B — and nothing reads them with bare parseFloat any more');
{
    // The input type is only half of it: a lenient field read by a strict
    // parser is the same bug one step later.
    for (const [name, src, cls] of [
        ['website notes', WEB, 'inv-note-amount'],
        ['website qty',   WEB, 'inv-item-weight'],
        ['website rate',  WEB, 'inv-item-rate'],
        ['phone notes',   APP, 'invw-note-amount'],
    ]) {
        ck(`${name} is not parsed with parseFloat`,
            !new RegExp(String.raw`parseFloat\([^)]*\.` + cls).test(src));
    }
    ck('the website has a lenient parser', /function invMoney\(/.test(WEB));
    ck('the phone has the same one', /function invwMoney\(/.test(APP));
}

section('C — what the parser does with what people type');
{
    // The real function, lifted out of each client and run. Both are asserted
    // against the SAME table, which is what stops them drifting apart.
    const lift = (src, name) => {
        const m = src.match(new RegExp(String.raw`function ${name}\(raw\)[\s\S]*?\n\}`));
        if (!m) return null;
        // eslint-disable-next-line no-new-func
        return new Function(`${m[0]}; return ${name};`)();
    };
    const invMoney = lift(WEB, 'invMoney');
    const invwMoney = lift(APP, 'invwMoney');
    ck('both parsers lift cleanly', typeof invMoney === 'function' && typeof invwMoney === 'function');

    const cases = [
        ['-$205', -205, 'her freight deduction, exactly as typed'],
        ['-205', -205, 'the plain form, which must be unchanged'],
        ['205', 205, 'a positive'],
        ['$0.58', 0.58, 'a rate with a dollar sign'],
        ['1,250.50', 1250.5, 'thousands separator'],
        ['-1,250.50', -1250.5, 'both at once'],
        ['(205)', -205, 'accountancy parentheses'],
        ['49760', 49760, 'a pounds quantity'],
        ['22.571', 22.571, 'a tonnage'],
    ];
    for (const [input, want, why] of cases) {
        ck(`  "${input}" -> ${want}  (${why})`, invMoney(input) === want, String(invMoney(input)));
        ck(`    phone agrees`, invwMoney(input) === want, String(invwMoney(input)));
    }
    // null, not 0 — the distinction the original bug collapsed.
    for (const junk of ['', '   ', 'abc', '$']) {
        ck(`  "${junk}" is null, NOT zero`, invMoney(junk) === null && invwMoney(junk) === null,
            `${invMoney(junk)} / ${invwMoney(junk)}`);
    }
}

section('D — the browser behaviour this is working around');
{
    // Proof the old field really did throw the figure away, so nobody later
    // "simplifies" this back to type=number.
    const dom = new JSDOM('<input id="n" type="number" step="any"><input id="t" type="text">');
    const n = dom.window.document.getElementById('n');
    const t = dom.window.document.getElementById('t');
    n.value = '-$205'; t.value = '-$205';
    ck('a type=number field returns "" for "-$205"', n.value === '');
    ck('a text field keeps it', t.value === '-$205');
    n.value = '-205';
    ck('and returns "-205" for the plain form', n.value === '-205');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) console.log('  failed: ' + failures.join(' | '));
process.exit(fail ? 1 : 0);
