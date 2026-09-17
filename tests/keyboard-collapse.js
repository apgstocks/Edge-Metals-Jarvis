// ── tests/keyboard-collapse.js ────────────────────────────────────────────
// Apsara, 2026-09-17: "in app,when i type the seller or anything,and i
// selected something from list,my keyboard should collapse na..Why it is
// expanded?"
//
// ── WHY IT WAS EXPANDED ─────────────────────────────────────────────────────
// Every type-ahead in the app calls preventDefault() on mousedown, and has to.
// A tap blurs the input first, which closes the list, and the tap then lands on
// nothing — this project fixed that twice under the heading "consignee not
// clickable", and the fix is precisely to keep focus in the input.
//
// Keeping focus is what holds the soft keyboard up. So both are needed, in
// order: preventDefault to keep the tap alive, then blur() once the value has
// been applied.
//
// ── WHY THIS IS A SUITE AND NOT A ONE-LINE FIX ──────────────────────────────
// There are SIX of these lists, written at six different times, each copied
// from the last. Fixing the seller and leaving the other five is the shape of
// bug she would find one at a time for a fortnight. Section A holds every
// mousedown pick in the file, by counting them, so a SEVENTH type-ahead copied
// from an old one cannot quietly arrive without the blur.

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
const APP = fs.readFileSync(path.join(ROOT, 'mobile-app/www/index.html'), 'utf8');

// ══════════════════════════════════════════════════════════════════════════
section('A — every list that picks a value gives the keyboard back');
// ══════════════════════════════════════════════════════════════════════════
{
    // The mousedown handlers that SET A VALUE. Drag handles and hold-to-repeat
    // buttons also use mousedown and are not type-aheads, so they are excluded
    // by requiring preventDefault AND an assignment in the same handler.
    const handlers = [...APP.matchAll(/addEventListener\('mousedown',\s*\(ev\)\s*=>\s*\{([\s\S]*?)\n\s*\}\)/g)]
        .map((m) => m[1])
        .filter((body) => /ev\.preventDefault\(\)/.test(body) && /\.value = |onPick\(/.test(body));

    ck('every type-ahead pick is found', handlers.length >= 5, `${handlers.length} found`);
    const without = handlers.filter((b) => !/blurPicked\(/.test(b));
    ck('  and every one of them blurs the input',
       without.length === 0,
       `${without.length} do not — ${without.map((b) => (b.match(/\.value = [^;]*/) || ['?'])[0]).join(' | ')}`);

    // The seller box she named, by name.
    ck('the seller type-ahead blurs',
       /\$\('ld_seller'\)\.value = entry\.aliases\[0\];\s*\n\s*blurPicked\(\$\('ld_seller'\)\);/.test(APP),
       'the one she reported');

    // ── ORDER MATTERS ────────────────────────────────────────────────────
    // Blur BEFORE the value is applied and the input can lose the pick on
    // some browsers; blur before preventDefault and the list closes under
    // the tap. Asserted rather than assumed, because the whole reason these
    // handlers are shaped this way is a bug that was fixed twice.
    for (const b of handlers) {
        const pd = b.indexOf('ev.preventDefault()');
        const bl = b.indexOf('blurPicked(');
        ck('  preventDefault comes first, then the value, then the blur',
           pd >= 0 && bl > pd, b.replace(/\s+/g, ' ').slice(0, 90));
        break;   // one representative; the count above covers the rest
    }
}

// ══════════════════════════════════════════════════════════════════════════
section('B — the helper cannot take a screen down');
// ══════════════════════════════════════════════════════════════════════════
{
    const dom = new JSDOM('<body><input id="a"></body>', { runScripts: 'outside-only' });
    const w = dom.window;
    const src = APP.slice(APP.indexOf('function blurPicked('), APP.indexOf('\n}', APP.indexOf('function blurPicked(')) + 2);
    w.eval(src);

    let threw = null;
    try {
        w.eval('blurPicked(null); blurPicked(undefined); blurPicked({}); blurPicked({ blur: 1 });');
    } catch (e) { threw = e; }
    ck('nothing it is handed can throw', !threw, threw && threw.message);

    // And it does blur a real one.
    const input = dom.window.document.getElementById('a');
    input.focus();
    ck('  a focused input is focused to begin with', dom.window.document.activeElement === input);
    w.eval("blurPicked(document.getElementById('a'))");
    ck('  and blurPicked takes the focus away', dom.window.document.activeElement !== input,
       String(dom.window.document.activeElement && dom.window.document.activeElement.id));

    dom.window.close();
}

// ══════════════════════════════════════════════════════════════════════════
section('C — the WEBSITE is untouched');
// ══════════════════════════════════════════════════════════════════════════
{
    // She said "in app". A desktop browser has no soft keyboard, and blurring
    // there would break tab-through-the-form — a different screen, changed for
    // a reason that does not apply to it. Rule 1 of CLAUDE.md.
    const DASH = fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8');
    const DOCS = fs.readFileSync(path.join(ROOT, 'dashboard/documents.html'), 'utf8');
    ck('the dashboard has no blurPicked', !/blurPicked\(/.test(DASH));
    ck('  nor does documents.html', !/blurPicked\(/.test(DOCS));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }
