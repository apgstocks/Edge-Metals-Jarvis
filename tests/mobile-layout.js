// ── tests/mobile-layout.js ────────────────────────────────────────────────
// Apsara, 2026-09-02: "layout of this app is bad. it is not adjusted to
// mobile."
//
// She was right, and it was a REPEAT. The item-row redesign a fortnight ago
// replaced a horizontally-scrolling grid because on a real phone "you could
// only ever see 2-3 columns at a time — clumsy". Then, the same day she was
// reading the app on a phone, I added three new screens — Petty cash, the
// Spend Report, the Inventory drill-down — as 560-600px wide tables inside
// overflow-x:auto. On a ~370px screen. The same mistake, in the same app.
//
// The fix is the .stack-table pattern: below 600px each row becomes a card and
// each cell carries its column name. This file exists so the NEXT wide table
// cannot be added without it — the failure is invisible on a laptop, which is
// exactly why it needs a test rather than a reviewer's attention.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

// Strips line comments before matching. This trap has caught me three times
// today: a comment that DESCRIBES the thing being asserted contains the exact
// string being searched for, so the assertion passes (or fails) on prose
// rather than on code. Every source-matching check below goes through this.
const nocomment = (t) => String(t).split('\n').filter((l) => !/^\s*(\/\/|\*|<!--)/.test(l)).join('\n');

const ROOT = path.join(__dirname, '..');
const CLIENTS = [
    ['app', fs.readFileSync(path.join(ROOT, 'mobile-app/www/index.html'), 'utf8')],
    ['website', fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8')],
];

console.log('\n─ the new screens, on a phone ───────────────────────────────');

// ── 1. no table may be wider than a phone without stacking ────────────────
section('A — every wide table stacks');
for (const [label, src] of CLIENTS) {
    // Any table declaring a min-width bigger than a phone is a table that
    // scrolls sideways unless it also stacks. Found by scanning rather than
    // by a hardcoded list, so a NEW one is caught too.
    const wide = [...src.matchAll(/<table([^>]*min-width:\s*(\d+)px[^>]*)>/g)]
        .map(m => ({ attrs: m[1], width: Number(m[2]) }))
        .filter(t => t.width > 420);          // a phone in CSS px, generously

    ck(`${label}: found the wide tables to check`, wide.length >= 2,
       'if this drops to zero the scan has stopped working, not the problem');
    for (const t of wide) {
        // Either it stacks, or it opts out ON PURPOSE. The invoice-verify grid
        // is the one deliberate exception: 13 columns being checked line by
        // line against a paper document read better as a grid you scroll than
        // as 13 stacked labels per row, and its comment says so. The attribute
        // is what lets this test tell a considered decision from a table
        // someone forgot about — silence would have meant either forcing a
        // bad layout on that screen or dropping the check entirely.
        const stacks = /class="[^"]*\bstack-table\b/.test(t.attrs);
        const optedOut = /data-wide="deliberate"/.test(t.attrs);
        ck(`${label}: a ${t.width}px table either stacks or opts out on purpose`,
           stacks || optedOut,
           `a ${t.width}px table on a ~370px screen scrolls sideways — she has rejected that layout once already`);
    }
}

// ── 2. stacking is useless without labels ─────────────────────────────────
section('B — every stacked cell says which column it is');
for (const [label, src] of CLIENTS) {
    // Once the header row is hidden, a bare number is unreadable: "3,300" with
    // nothing beside it could be gross, tare or net. Each cell must carry
    // data-label, or be the card's heading.
    // ── FOUND BY ID, NOT BY STYLE STRING ─────────────────────────────────
    // These used to be matched on their inline style, which is how the
    // Trucker Bills table broke this file on 2026-09-03: it was written with
    // byte-for-byte the same style as the inventory drill-down, was defined
    // EARLIER in the file, and so indexOf handed this section the wrong table
    // — which it then reported under the drill-down's name.
    //
    // It failed loudly only because the new table has an empty-state row. Had
    // it not, this section would have passed while silently checking a screen
    // it was not written for, and the drill-down would have gone unasserted.
    // Every stacked table now carries an id and is found by it.
    for (const [name, marker] of [
        ['inventory drill-down', '<table id="invLinesTable"'],
        ['spend report', '<table id="spendReportTable"'],
        ['trucker bills', '<table id="trkBillsTable"'],
    ]) {
        const at = src.indexOf(marker);
        ck(`${label}: ${name} table is present`, at > 0);
        if (at < 0) continue;
        const block = src.slice(at, src.indexOf('</table>', at));
        const cells = [...block.matchAll(/<td\b([^>]*)>/g)].map(m => m[1]);
        // Every cell must be one of three things: labelled, the card heading,
        // or explicitly marked as a spacer. Nothing is inferred.
        //
        // The first version tried to GUESS which cells were spacers, with
        // /^\s*style="padding:[^"]*"\s*$/ — and [^"]* swallows the whole style
        // attribute, so it exempted nearly every cell in the table. Stripping
        // all the data-labels left the suite green. Mutation testing caught it;
        // reading it would not have.
        // A colspan cell is an empty state — "No trucker bills yet." — which
        // spans every column and so has no single column name to carry.
        // Exempted by an explicit attribute, like the spacer above, rather
        // than by a pattern that guesses: the first spacer rule here used
        // /style="padding:[^"]*"/, and [^"]* swallowed the whole attribute,
        // exempting nearly every cell in the table.
        const unlabelled = cells.filter(a =>
            !/data-label=/.test(a)
            && !/class="[^"]*\bst-head\b/.test(a)
            && !/class="[^"]*\bst-spacer\b/.test(a)
            && !/\bcolspan=/.test(a));
        ck(`${label}:   every ${name} cell is labelled, a heading, or a marked spacer`,
           unlabelled.length === 0,
           `unlabelled: ${unlabelled.slice(0, 2).join(' | ')}`);
    }
}

// ── 3. the CSS actually does the work ─────────────────────────────────────
section('C — the rules are real, not decorative');
for (const [label, src] of CLIENTS) {
    const mq = src.slice(src.indexOf('Wide tables become stacked cards on a phone'));
    const block = mq.slice(0, mq.indexOf('\n      }\n') + 9);

    ck(`${label}: scoped to phones only`, /@media \(max-width: 600px\)/.test(block),
       'a desktop table is fine as a table — this must not touch it');
    ck(`${label}: rows become blocks`, /\.stack-table tr, \.stack-table td \{ display:block/.test(block));
    ck(`${label}: the header row is hidden`, /\.stack-table thead \{ display:none/.test(block));
    // THE LOAD-BEARING LINE. Without it the min-width on the table element
    // still applies and the page scrolls sideways anyway — the stacking would
    // look right in a snippet and be broken on the phone.
    ck(`${label}: the table's own min-width is overridden`,
       /\.stack-table \{ min-width:0 !important; \}/.test(block),
       'stacking without this leaves the 600px min-width in force and the page still scrolls');
    ck(`${label}: labels come from data-label`, /content:attr\(data-label\)/.test(block));
    ck(`${label}: empty spacer cells are dropped`, /\.stack-table td:empty \{ display:none/.test(block));
    ck(`${label}: the heading cell has no label prefix`, /\.stack-table td\.st-head::before \{ content:none/.test(block));
}

// ── 4. six tabs do not fit across a phone ─────────────────────────────────
section('D — the tab bar, now that it holds six');
{
    const app = CLIENTS.find(c => c[0] === 'app')[1];
    const tabs = [...app.matchAll(/tabBtn\('([\w-]+)'/g)].map(m => m[1]);
    ck('the app has more tabs than fit across a phone', tabs.length >= 5,
       `tabs: ${tabs.join(', ')} — Petty cash and Report were added 2026-09-02`);
    ck('  the bar scrolls sideways instead of squashing them',
       /#mobileTabBar \{ overflow-x:auto/.test(app),
       'a non-wrapping flex row either shrinks tabs to unreadable or pushes the last ones off-screen');
    ck('  and each tab keeps its width', /#mobileTabBar > button \{ flex:0 0 auto; \}/.test(app),
       'without this flex would shrink them to fit and undo the scroll');
    ck('  the scrollbar is hidden', /#mobileTabBar::-webkit-scrollbar \{ display:none; \}/.test(app));
}

// ── 5. the desktop is untouched ───────────────────────────────────────────
section('E — none of this leaks onto a laptop');
for (const [label, src] of CLIENTS) {
    // Every .stack-table rule must live INSIDE the 600px media query. A stray
    // one outside it would flatten the desktop tables into cards, which is a
    // regression dressed as a fix.
    // Brace-matched, not regex-stripped. The first version used a non-greedy
    // match up to the next '\n      }', which is not how CSS nests — it cut
    // the media query short and reported every rule as being outside it. The
    // test failed against correct code.
    const stripMediaBlocks = (css) => {
        let out = '', i = 0;
        for (;;) {
            const at = css.indexOf('@media (max-width: 600px)', i);
            if (at < 0) { out += css.slice(i); break; }
            out += css.slice(i, at);
            let d = 0, k = css.indexOf('{', at);
            for (; k < css.length; k++) {
                if (css[k] === '{') d++;
                else if (css[k] === '}') { d--; if (!d) break; }
            }
            i = k + 1;
        }
        return out;
    };
    const outside = (stripMediaBlocks(src).match(/\.stack-table[^{;]*\{/g) || []);
    ck(`${label}: no .stack-table rule outside the phone breakpoint`, outside.length === 0,
       `found: ${outside.slice(0, 2).join(' ')}`);
}

// ── 6. a date field without a picker ──────────────────────────────────────
// Apsara, 2026-09-02: "date picker should be there wherever date used."
//
// Her two rules pull against each other, and that tension is the whole story:
//   "wherever date applicable it should be mm/dd/yyyy only"  (09-01)
//   "date picker should be there wherever date used"         (09-02)
// A native <input type="date"> renders in the DEVICE locale, so on an en-IN
// phone it shows DD/MM/YYYY and breaks the first rule. Replacing those inputs
// with text boxes is what satisfied the first rule and took the calendar away.
//
// The answer is both: a text box that always reads MM/DD/YYYY, with a hidden
// native date input beside it purely to open the platform calendar.
section('F — every date field can be typed AND picked');
for (const [label, src] of CLIENTS) {
    ck(`${label}: the date helpers exist`,
       /function toUsDate\(/.test(src) && /function toIsoDate\(/.test(src) && /function wireUsDateField\(/.test(src),
       'the app had none of these until 2026-09-02 — dates were native inputs in device locale');

    const wire = (() => {
        const i = src.indexOf('function wireUsDateField(');
        let d = 0, k = src.indexOf('{', src.indexOf(')', i));
        for (; k < src.length; k++) {
            if (src[k] === '{') d++;
            else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
        }
        return '';
    })();

    ck(`${label}: wiring a field builds a picker`, /native\.type = 'date'/.test(wire),
       'the calendar comes from a real date input — nothing else opens the platform picker');
    ck(`${label}:   opened by a visible button`, /aria-label', 'Open the calendar'/.test(wire));
    ck(`${label}:   via showPicker, with a click fallback`,
       /native\.showPicker\(\)/.test(wire) && /native\.click\(\)/.test(wire));
    // display:none cannot be focused and showPicker throws on an unrendered
    // input — the hidden input has to be rendered but invisible.
    ck(`${label}:   the native input is invisible, NOT display:none`,
       /opacity:0/.test(wire) && !/display:none/.test(nocomment(wire)),
       'showPicker() throws on an input that is not rendered');
    ck(`${label}: picking writes MM/DD/YYYY back`, /el\.value = `\$\{m\}\/\$\{d\}\/\$\{y\}`/.test(wire));
    // A picked date that fires no event sits there looking applied and is not
    // — the inventory and report filters listen on the text box.
    ck(`${label}:   and fires input+change so filters notice`,
       /dispatchEvent\(new Event\('input'/.test(wire) && /dispatchEvent\(new Event\('change'/.test(wire),
       'a picked date that fires nothing looks applied and is not');
    ck(`${label}: wiring twice does not stack two pickers`, /dataset\.dpWired/.test(wire));

    // No native date input may remain in the MARKUP — that is the one that
    // renders in device locale.
    // Comments quote <input type="date"> while explaining why it is gone, so
    // the raw source always "contains" one.
    const markupDates = (nocomment(src).match(/<input[^>]*type="date"/g) || []);
    ck(`${label}: no bare <input type="date"> is left in the markup`, markupDates.length === 0,
       `${markupDates.length} left — those render DD/MM/YYYY on an en-IN phone`);

    // Every date-looking field must be wired, or it is a text box with no
    // calendar — which is the state she complained about.
    const wired = new Set((src.match(/wireUsDateField\('([a-zA-Z_]+)'\)/g) || [])
        .map(m => /'([a-zA-Z_]+)'/.exec(m)[1]));
    const fields = (src.match(/<input id="([a-zA-Z_]*(?:date|Date|from|to|From|To|erd|cutoff)[a-zA-Z_]*)"/g) || [])
        .map(m => /id="([^"]+)"/.exec(m)[1])
        .filter(id => !/^(inv_from|inv_to)$/.test(id) || true);
    const missing = fields.filter(id => !wired.has(id));
    ck(`${label}: every date field is wired`, missing.length === 0,
       `unwired: ${missing.join(', ')}`);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  Failed:'); failures.forEach((f) => console.log('   - ' + f)); }
process.exit(fail ? 1 : 0);
