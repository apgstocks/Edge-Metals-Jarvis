// ── tests/documents-tabs.js ───────────────────────────────────────────────
// Apsara, 2026-10-02, with a screenshot of the PROFORMA tab showing a panel
// headed "GENERATED INVOICES": "why saved generated invoices coming in
// proforma.it should not come there".
//
// ── IT WAS NESTING, NOT LOGIC ─────────────────────────────────────────────
// panelInvoice opened at line 524 and CLOSED at 877. The "Generated invoices"
// card was at 906 and "Older invoices filed under proforma" at 921 — both
// AFTER the panel had closed, so they belonged to no panel at all.
//
// showTab() hides and shows panels. A card outside every panel is never
// hidden, so it rendered on PROFORMA, on BOL, on PACKING LIST, on
// VERIFICATION and on BANK. The tab switcher was working perfectly; there was
// simply nothing for it to switch.
//
// The irony worth recording: one of the two stranded cards was "Older
// invoices filed under proforma" — the fix for her PREVIOUS complaint about
// invoices appearing under proforma. It was itself appearing under proforma.
//
// ── SO THE CHECK IS STRUCTURAL ────────────────────────────────────────────
// Not "is this card on the right tab" — that is one card, and the next one
// added will be stranded the same way. The property is: every panel is
// balanced, no panel overlaps another, and nothing that looks like a content
// card floats outside all of them.

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const SRC = fs.readFileSync(path.join(ROOT, 'dashboard/documents.html'), 'utf8');
const LINES = SRC.split('\n');

// Where each panel starts and ends, by walking div depth from its opening
// tag. Comments are stripped first: a <div in a comment would throw the
// count off, and this file is heavily commented.
const stripped = LINES.map((l) => l.replace(/<!--[\s\S]*?-->/g, ''));
let inComment = false;
const code = stripped.map((l) => {
    let out = l;
    if (inComment) { const e = out.indexOf('-->'); if (e === -1) return ''; out = out.slice(e + 3); inComment = false; }
    const s = out.indexOf('<!--');
    if (s !== -1) { inComment = true; out = out.slice(0, s); }
    return out;
});

function spanOf(id) {
    const start = code.findIndex((l) => l.includes(`id="${id}"`));
    if (start === -1) return null;
    let depth = 0;
    for (let i = start; i < code.length; i += 1) {
        depth += (code[i].match(/<div\b/g) || []).length;
        depth -= (code[i].match(/<\/div>/g) || []).length;
        if (depth === 0 && i > start) return { start, end: i };
        if (depth === 0 && i === start) return { start, end: i };   // single-line
    }
    return { start, end: null };
}

const PANELS = ['panelInvoice', 'panelProforma', 'panelBol', 'panelPacking',
                'panelVerification', 'panelBank'];

// ── A — EVERY PANEL IS A CLOSED BOX ───────────────────────────────────────
{
    section('A — the panels are balanced and separate');

    const spans = {};
    for (const p of PANELS) {
        const s = spanOf(p);
        ck(`${p} exists`, !!s, 'a tab with no panel is a tab that shows nothing');
        if (!s) continue;
        ck(`  ${p} closes`, s.end !== null,
           'an unbalanced panel swallows everything after it, including other panels');
        spans[p] = s;
    }

    // NO PANEL MAY CONTAIN ANOTHER. If one did, switching tabs would show two
    // at once — and the inner one could never be hidden on its own.
    const names = Object.keys(spans).filter((n) => spans[n].end !== null);
    for (let i = 0; i < names.length; i += 1) {
        for (let j = 0; j < names.length; j += 1) {
            if (i === j) continue;
            const a = spans[names[i]], b = spans[names[j]];
            const nested = a.start < b.start && b.end < a.end;
            ck(`  ${names[j]} is not inside ${names[i]}`, !nested,
               `${names[j]} ${b.start + 1}-${b.end + 1} sits inside ${names[i]} ${a.start + 1}-${a.end + 1}`);
        }
    }
}

// ── B — NOTHING FLOATS OUTSIDE EVERY PANEL ────────────────────────────────
{
    section('B — no card belongs to every tab at once');

    const spans = PANELS.map(spanOf).filter((s) => s && s.end !== null);
    const insideSome = (line) => spans.some((s) => line > s.start && line < s.end);

    // The two that were actually stranded, named, because those are the ones
    // she saw. If either leaves its panel again this goes red with the reason.
    for (const [what, id] of [['Generated invoices', 'invGenList'],
                              ['Older invoices filed under proforma', 'invMisfiledCard']]) {
        const ln = code.findIndex((l) => l.includes(`id="${id}"`));
        ck(`"${what}" is inside a panel`, ln !== -1 && insideSome(ln),
           `line ${ln + 1} — outside every panel means it renders on PROFORMA, BOL, `
           + 'PACKING LIST and every other tab, which is exactly what she reported');
        const inv = spanOf('panelInvoice');
        ck(`  and specifically inside panelInvoice`,
           ln > inv.start && ln < inv.end,
           `panelInvoice is ${inv.start + 1}-${inv.end + 1}, the card is at ${ln + 1}`);
    }

    // ── AND THE GENERAL CASE ─────────────────────────────────────────────
    // Any element carrying an id that the page's own script addresses, and
    // that lives between the first panel and the last, must be inside one of
    // them. Bounded to that range so the page header, the tab strip and the
    // trailing <script> are not counted.
    const first = Math.min(...spans.map((s) => s.start));
    const last = Math.max(...spans.map((s) => s.end));
    const strays = [];
    for (let i = first; i < last; i += 1) {
        const m = code[i].match(/\bid="([A-Za-z][\w-]*)"/);
        if (!m) continue;
        if (PANELS.includes(m[1])) continue;
        if (insideSome(i)) continue;
        // Only count it if the script actually uses it — a decorative
        // wrapper with an unused id is not a card she can see on every tab.
        if (!new RegExp(`['"\`]${m[1]}['"\`]`).test(SRC)) continue;
        strays.push(`${m[1]} (line ${i + 1})`);
    }
    ck('no addressed element sits between the panels but outside them all',
       strays.length === 0,
       strays.join(', ') + ' — each of these renders on every tab');
}

// ── C — THE SWITCHER STILL SWITCHES ALL OF THEM ───────────────────────────
{
    section('C — every panel is actually toggled');

    for (const p of PANELS) {
        ck(`${p} is hidden/shown by the tab switcher`,
           new RegExp(`\\$\\('${p}'\\)\\.classList\\.toggle\\('hidden'`).test(SRC),
           'a panel nothing toggles is either always on or always off');
    }
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
