// ── tests/petty-tab-highlight.js ──────────────────────────────────────────
// Apsara, 2026-11-20, with a screenshot of Petty cash on the Cash tab where "Borrowing" looked selected:
// "Selected one should be highlighted na". The open tab had --surface-raised (nearly the page colour); the closed
// one had no background, so the browser painted its own light-grey button over it. Rendered here from the real
// template with each tab open, and the classes of the two buttons read back.
const fs = require('fs'); const path = require('path');
let pass = 0, fail = 0;
const ck = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n); if (x !== undefined) console.log('        ' + JSON.stringify(x)); } };
const src = fs.readFileSync(path.join(__dirname, '..', 'dashboard/app/11-ledger-borrowing.js'), 'utf8');
const strip = (src.match(/<div style="display:flex; gap:6px; margin-bottom:16px;">\s*(<button class="btn petty-tab[\s\S]*?)<\/div>/) || [])[1] || '';
ck('the Cash / Borrowing strip is found in the template', /data-petty-tab="cash"/.test(strip) && /data-petty-tab="borrowing"/.test(strip), strip.slice(0, 120));
const render = (pettyTab) => {
    const pettyCash = { borrowings: [1, 2, 3, 4] };
    // eslint-disable-next-line no-new-func
    return new Function('pettyTab', 'pettyCash', 'return `' + strip + '`;')(pettyTab, pettyCash);
};
const cls = (html, tab) => ((html.match(new RegExp(`<button class="([^"]+)" data-petty-tab="${tab}" aria-pressed="(true|false)"`)) || []).slice(1));
for (const open of ['cash', 'borrowing']) {
    const other = open === 'cash' ? 'borrowing' : 'cash';
    const html = render(open);
    const [oc, op] = cls(html, open), [xc, xp] = cls(html, other);
    ck(`on ${open}: the open tab is the highlighted one (primary, aria-pressed)`, /\bbtn-primary\b/.test(oc || '') && op === 'true', { oc, op });
    ck(`on ${open}: the other tab is plainly not (secondary, never a bare .btn the browser paints grey)`, /\bbtn-secondary\b/.test(xc || '') && !/\bbtn-primary\b/.test(xc || '') && xp === 'false', { xc, xp });
}
ck('Borrowing still shows its count', /Borrowing \(4\)/.test(render('cash')));
const index = fs.readFileSync(path.join(__dirname, '..', 'dashboard/index.html'), 'utf8');
ck('both classes give a background of their own', /\.btn-primary \{[^}]*background:/.test(index) && /\.btn-secondary \{[^}]*background:/.test(index));
// Truckers & Suppliers had the same strip and the same fault — Apsara: "yes" to fixing it there too.
{
    const bsrc = fs.readFileSync(path.join(__dirname, '..', 'dashboard/app/02-dashboard-bookings.js'), 'utf8');
    const def = (bsrc.match(/const btn = \(id, label\) => (`<button class="btn partners-tab[^\n]*`);/) || [])[1];
    ck('the Truckers / Suppliers strip is found', !!def);
    for (const open of ['truckers', 'suppliers']) {
        // eslint-disable-next-line no-new-func
        const btn = new Function('partnersTab', 'return (id, label) => ' + def + ';')(open);
        const other = open === 'truckers' ? 'suppliers' : 'truckers';
        const o = btn(open, 'X'), x = btn(other, 'Y');
        ck(`on ${open}: the open tab is highlighted and the other is plainly not`,
            /\bbtn-primary\b/.test(o) && /aria-pressed="true"/.test(o) && /\bbtn-secondary\b/.test(x) && !/\bbtn-primary\b/.test(x) && /aria-pressed="false"/.test(x), { o, x });
    }
}
// The account card under the tabs — Apsara: "alignment is ugly". BofA had a heading and the others did not, so
// nothing lined up. Rendered from the real template with her four accounts.
{
    const card = (src.match(/<div class="card" style="padding:12px 14px; margin-bottom:18px; display:flex; flex-wrap:wrap; gap:16px 28px;">\s*\$\{\(\(\) => \{([\s\S]*?)\}\)\(\)\}\s*<\/div>/) || [])[1];
    ck('the account card is found in the template', !!card);
    const pettyCash = { sources: ['Edge Metals', 'AAA Investment', 'Chase Bank', 'Unassigned'],
        bank_of: { 'Edge Metals': 'BofA', 'AAA Investment': 'BofA', 'Chase Bank': 'Chase Bank', Unassigned: null },
        by_source: { 'Edge Metals': 57362.14, 'AAA Investment': 15424.09, 'Chase Bank': 41989.54, Unassigned: -25386.03 } };
    const esc = (v) => String(v); const fmtAmount = (n) => '$' + n.toFixed(2);
    // eslint-disable-next-line no-new-func
    const html = new Function('pettyCash', 'esc', 'fmtAmount', card)(pettyCash, esc, fmtAmount);
    const { JSDOM } = require('jsdom');
    const doc = new JSDOM(`<div id="c">${html}</div>`).window.document;
    const groups = [...doc.getElementById('c').children];
    ck('three groups: BofA, Chase Bank, Unassigned', groups.length === 3, groups.length);
    const heads = groups.map((g) => g.firstElementChild);
    ck('every group starts with a heading row of the same height, so all labels share one line',
        heads.every((h) => /height:18px/.test(h.getAttribute('style') || '')), heads.map((h) => h.getAttribute('style')));
    ck('  BofA\'s heading names it; the single accounts\' headings are empty (no name said twice)',
        heads[0].textContent.trim() === 'BofA' && heads[1].textContent.trim() === '' && heads[2].textContent.trim() === '');
    const cells = [...doc.querySelectorAll('#c div[style*="width:150px"]')];
    ck('all four accounts are cells of the same width', cells.length === 4, cells.length);
    ck('  in order, with their figures', cells.map((c) => c.textContent.replace(/\s+/g, ' ').trim()).join(' | ')
        === 'Edge Metals $57362.14 | AAA Investment $15424.09 | Chase Bank $41989.54 | Unassigned $-25386.03', cells.map((c) => c.textContent.trim()));
}
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
