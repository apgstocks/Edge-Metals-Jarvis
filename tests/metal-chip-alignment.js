// Apsara 2026-11-18: "once ferrous/non-ferrous added, alignment is changing" (the item row in the load form).
// The chip sat in flow under the description box, so that cell grew and every other box in the row was re-centred.
// Property: on the one-line row the chip takes NO height; the stacked phone layout keeps it in flow; the row
// is told when a chip is showing; both clients and the Android copies agree.
const fs = require('fs'), path = require('path');
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
let pass = 0, fail = 0; const ck = (n, c) => { c ? pass++ : fail++; console.log((c ? '  PASS  ' : '  FAIL  ') + n); };
for (const [label, css, logic, copies] of [
    ['website', 'dashboard/app/13-loads-render.js', 'dashboard/app/05-load-pricing.js', []],
    ['phone app', 'mobile-app/www/app/09-loads-deck.js', 'mobile-app/www/app/02-cache-catalogue.js', ['mobile-app/android/app/src/main/assets/public/app/09-loads-deck.js', 'mobile-app/android/app/src/main/assets/public/app/02-cache-catalogue.js']],
]) {
    const c = R(css), l = R(logic);
    const base = c.indexOf('.ld-item-desc-wrap .ld-metal-chip { position:absolute');
    const phone = c.indexOf('.ld-item-desc-wrap .ld-metal-chip { position:static');
    ck(label + ': on the one-line row the chip is out of flow (no height added to the description cell)', base > 0 && /\.ld-item-desc-wrap \{ position:relative; \}/.test(c));
    ck(label + ': the stacked phone layout keeps it in flow, and that rule comes AFTER the desktop one', phone > base && base > 0);
    ck(label + ': the room it needs is added UNDER the row, not inside it', /\.item-row\.has-metal \{ margin-bottom:19px; \}/.test(c));
    ck(label + ': the row is marked only while a chip shows (description typed)', /row\.classList\.toggle\('has-metal', !!input\.value\.trim\(\)\)/.test(l));
    ck(label + ': the row grid itself is untouched (still centre-aligned, same columns)', /\.item-row \{ display:grid; grid-template-columns:0\.9fr 120px 120px 92px (168|124)px 100px 62px; gap:6px; align-items:center;/.test(c.replace(/\.ld-item-header, /, '')));
}
for (const f of ['09-loads-deck.js', '02-cache-catalogue.js']) ck('Android copy matches: ' + f, R('mobile-app/www/app/' + f) === R('mobile-app/android/app/src/main/assets/public/app/' + f));
console.log(`\n  ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
