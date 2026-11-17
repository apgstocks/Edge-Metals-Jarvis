// ── tests/item-metal-clients.js ──────────────────────────────────────────
// Apsara, 2026-11-17: "when you type an item, as soon as they move to next
// box, ask them whether it is ferrous or non-ferrous." Website AND phone app.
// (tests/item-metal.js is the server half.)
//
// The question block is the same code in both apps, so it is run for real in a
// jsdom page — dialog, learned names, one question at a time, Save held until
// answered — against BOTH files. Wiring (blur, save, payload, copy paths) is
// checked on the source and called out as such where it is.

const fs = require('fs');
const path = require('path');
let JSDOM = null; try { ({ JSDOM } = require('jsdom')); } catch (e) { /* reported */ }

let pass = 0, fail = 0; const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');
const ROOT = path.join(__dirname, '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const WEB = { name: 'website', rows: 'dashboard/app/05-load-pricing.js', save: 'dashboard/app/13-loads-render.js' };
const APP = { name: 'phone app', rows: 'mobile-app/www/app/05-payment-roles.js', block: 'mobile-app/www/app/02-cache-catalogue.js', save: 'mobile-app/www/app/09-loads-deck.js' };
WEB.block = WEB.rows;
const START = '// ── Ferrous / non-ferrous (Apsara, 2026-11-17)';
const END = '// Apsara: "Spelling variants as they type';
const blockOf = (file) => { const s = read(file); const a = s.indexOf(START), b = s.indexOf(END); return (a >= 0 && b > a) ? s.slice(a, b) : null; };

// A question that never gets answered leaves the event loop empty and Node exits 0 with the output cut short.
// Say so, and fail (CLAUDE.md rule 2: a file that exits quietly is not a pass).
let finished = false;
process.on('exit', (code) => { if (!finished && code === 0) { console.log('  FAIL  the test stopped before it finished (a dialog was never answered, or a promise never settled)'); process.exitCode = 1; } });
(async () => {
ck('jsdom is available', !!JSDOM);
const webBlock = blockOf(WEB.block), appBlock = blockOf(APP.block);
section('A — one block, two apps');
ck('both apps carry the question block', !!webBlock && !!appBlock);
ck('and it is the SAME code in both (a fix to one is a fix to the other)', webBlock === appBlock);

const rowHtml = (desc, type) => `<div class="item-row"><input class="ld-item-desc-input" value="${desc}"><input type="hidden" class="ld-item-metal" value="${type || ''}" data-for="${type ? desc.toLowerCase().replace(/[^a-z0-9]/g, '') : ''}"><button type="button" class="ld-metal-chip"></button></div>`;

async function page(rows, { map, mapFails } = {}) {
    const dom = new JSDOM(`<body><div id="ld_items">${rows.map((r) => rowHtml(r[0], r[1])).join('')}</div></body>`, { runScripts: 'outside-only' });
    const w = dom.window;
    w.__syncs = 0; w.__apiCalls = [];
    w.eval(`
      function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
      function syncItemsFromDom(){ window.__syncs++; }
      async function api(p){ window.__apiCalls.push(p); if (${mapFails ? 'true' : 'false'}) throw new Error('offline'); return { types: ${JSON.stringify(map || {})} }; }
    `);
    w.eval(webBlock + '\nwindow.__m = { ensureRowMetal, ensureAllMetal, askMetalType, setRowMetal, paintMetalChip, get map(){ return itemMetalMap; } };');
    return w;
}
const dialogs = (w) => [...w.document.querySelectorAll('.modal-overlay')];
const rowsOf = (w) => [...w.document.querySelectorAll('.item-row')];
const hidOf = (row) => row.querySelector('.ld-item-metal');

section('B — a name the server has learned is settled without asking');
{
    const w = await page([['Copper', '']], { map: { copper: 'non-ferrous' } });
    await w.__m.ensureRowMetal(rowsOf(w)[0], false);
    ck('no dialog', dialogs(w).length === 0);
    ck('the row takes the learned type', hidOf(rowsOf(w)[0]).value === 'non-ferrous');
    ck('the chip shows it', /Non-ferrous/.test(rowsOf(w)[0].querySelector('.ld-metal-chip').textContent));
    ck('the list came from the loads route the staff can reach', w.__apiCalls.includes('/api/loads/item-metal'), JSON.stringify(w.__apiCalls));
}

section('C — a new name is asked, and the answer is kept');
{
    const w = await page([['Mystery metal', ''], ['mystery  METAL', '']], { map: {} });
    const rows = rowsOf(w);
    const p = w.__m.ensureRowMetal(rows[0], false);
    await wait(30);
    ck('a dialog appears', dialogs(w).length === 1);
    const d = dialogs(w)[0];
    ck('it names the item', /Mystery metal/.test(d.textContent) && /ferrous or non-ferrous/i.test(d.textContent));
    ck('it offers exactly two answers and no Cancel', [...d.querySelectorAll('button')].map((b) => b.textContent.trim()).sort().join('|') === 'Ferrous|Non-ferrous', d.innerHTML);
    d.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await wait(20);
    ck('clicking the dimmed backdrop does NOT dismiss it (they must pick)', dialogs(w).length === 1);
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(10);
    ck('nor does Escape', dialogs(w).length === 1);
    d.querySelector('[data-metal="ferrous"]').click();
    await p;
    ck('the dialog closes on an answer', dialogs(w).length === 0);
    ck('the row now holds ferrous', hidOf(rows[0]).value === 'ferrous');
    ck('the form was re-synced so the answer is in the payload', w.__syncs >= 1);
    await w.__m.ensureRowMetal(rows[1], false);
    ck('the same name typed another way (case/spacing) is NOT asked again', dialogs(w).length === 0 && hidOf(rows[1]).value === 'ferrous');
}

section('D — Save: every row answered before it goes, one question at a time');
{
    const w = await page([['Copper', ''], ['Brass', ''], ['Steel', 'ferrous']], { map: {} });
    let resolved = false;
    const all = w.__m.ensureAllMetal().then(() => { resolved = true; });
    await wait(30);
    ck('the first unanswered row is asked', dialogs(w).length === 1 && /Copper/.test(dialogs(w)[0].textContent));
    ck('and Save has not gone yet', !resolved);
    dialogs(w)[0].querySelector('[data-metal="non-ferrous"]').click();
    await wait(30);
    ck('then the second', dialogs(w).length === 1 && /Brass/.test(dialogs(w)[0].textContent) && !resolved);
    dialogs(w)[0].querySelector('[data-metal="non-ferrous"]').click();
    await all;
    ck('Save proceeds only after the last answer', resolved && dialogs(w).length === 0);
    const rows = rowsOf(w);
    ck('every row carries a type, and the one already answered was left alone', hidOf(rows[0]).value === 'non-ferrous' && hidOf(rows[1]).value === 'non-ferrous' && hidOf(rows[2]).value === 'ferrous');
}

section('E — a blur-triggered question and Save do not stack two dialogs');
{
    const w = await page([['Zinc', '']], { map: {} });
    const row = rowsOf(w)[0];
    const a = w.__m.ensureRowMetal(row, false);
    const b = w.__m.ensureAllMetal();
    await wait(30);
    ck('only one dialog is open', dialogs(w).length === 1);
    dialogs(w)[0].querySelector('[data-metal="non-ferrous"]').click();
    await Promise.all([a, b]);
    ck('and one answer settles both', hidOf(row).value === 'non-ferrous' && dialogs(w).length === 0);
}

section('F — editing: a saved answer stays; a changed name is asked again');
{
    const w = await page([['Aluminium', 'non-ferrous']], { map: { aluminium: 'ferrous' } });
    const row = rowsOf(w)[0];
    await w.__m.ensureRowMetal(row, false);
    ck('a saved load keeps its own answer, no dialog, even if the list now says otherwise', hidOf(row).value === 'non-ferrous' && dialogs(w).length === 0);
    row.querySelector('.ld-item-desc-input').value = 'Brass tubing';
    const p = w.__m.ensureRowMetal(row, false);
    await wait(30);
    ck('typing a different item asks again', dialogs(w).length === 1 && /Brass tubing/.test(dialogs(w)[0].textContent));
    dialogs(w)[0].querySelector('[data-metal="non-ferrous"]').click();
    await p;
    const q = w.__m.ensureRowMetal(row, true);
    await wait(20);
    ck('the chip lets them change an answer', dialogs(w).length === 1);
    dialogs(w)[0].querySelector('[data-metal="ferrous"]').click();
    await q;
    ck('and the change sticks', hidOf(row).value === 'ferrous');
    row.querySelector('.ld-item-desc-input').value = '';
    await w.__m.ensureRowMetal(row, false);
    ck('clearing the description clears the type and asks nothing', hidOf(row).value === '' && dialogs(w).length === 0);
}

section('G — a failed lookup only means it asks');
{
    const w = await page([['Lead', '']], { mapFails: true });
    const p = w.__m.ensureRowMetal(rowsOf(w)[0], false);
    await wait(30);
    ck('the dialog still appears, nothing throws', dialogs(w).length === 1);
    dialogs(w)[0].querySelector('[data-metal="ferrous"]').click();
    await p;
    ck('and the answer is kept', hidOf(rowsOf(w)[0]).value === 'ferrous');
}

section('H — the wiring, on the source (shape, not behaviour)');
for (const c of [WEB, APP]) {
    const rows = read(c.rows), save = read(c.save);
    ck(`${c.name}: each row carries a hidden type and a chip`, /class="ld-item-metal"/.test(rows) && /class="ld-metal-chip"/.test(rows));
    ck(`${c.name}: leaving the description box asks`, /addEventListener\('blur', \(\) => \{[\s\S]{0,400}ensureRowMetal\(row, false\)/.test(rows));
    ck(`${c.name}: the form posts the type with each item`, /metal_type: row\.querySelector\('\.ld-item-metal'\)\?\.value \|\| ''/.test(rows));
    ck(`${c.name}: Save waits for every row to be answered, AFTER the checks and BEFORE the payload is built`,
       (() => { const a = save.indexOf('await ensureAllMetal();'); const v = save.indexOf('validateItemsBeforeSave(currentLoadItems)'); const b = save.indexOf('metal_type: it.metal_type || null'); return a > v && v > 0 && b > a; })());
    ck(`${c.name}: the payload sends it`, /metal_type: it\.metal_type \|\| null/.test(save));
    ck(`${c.name}: ensureAllMetal is called in exactly one place (the save), not on every keystroke`, (save.match(/ensureAllMetal\(\)/g) || []).length === 1);
}
const edit = { web: read(WEB.rows), app: read(APP.rows) + read('mobile-app/www/app/08-load-modal.js') + read('mobile-app/www/app/07-scanner.js') };
ck('website: blank row, reopened load and duplicated row all carry the type', (edit.web.match(/metal_type\s*:\s*(src|it)\.metal_type \|\| ''/g) || []).length === 2 && /metal_type: '', gross_weight/.test(edit.web));
ck('phone app: blank row, reopened load and duplicated row all carry the type', /metal_type\s*:\s*src\.metal_type \|\| ''/.test(edit.app) && /metal_type: it\.metal_type \|\| ''/.test(edit.app) && /metal_type: '', gross_weight/.test(edit.app));
const android = 'mobile-app/android/app/src/main/assets/public/';
for (const f of ['app/02-cache-catalogue.js', 'app/05-payment-roles.js', 'app/07-scanner.js', 'app/08-load-modal.js', 'app/09-loads-deck.js']) {
    const a = path.join(ROOT, android, f);
    ck(`Android assets match www: ${f}`, fs.existsSync(a) && fs.readFileSync(a, 'utf8') === read('mobile-app/www/' + f));
}

finished = true;
console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('threw:', e && e.stack); process.exit(1); });
