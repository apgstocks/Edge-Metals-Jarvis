// ── tests/item-row-net.js ─────────────────────────────────────────────────
// Apsara, 2026-09-16: "sometimes when i give gross lbs as 1.net is cnot cmng
// as 1.For that to make it come as 1,i have to start wit some number other
// than 1 then reeddit it.this is only for newly added item."
//
// WHAT WAS FOUND, AND WHAT WAS NOT. Typing 1 into a fresh row's gross works —
// driven in jsdom on both clients, it computes net 1 every time, so that is
// not the fault and this file pins it down so nobody "fixes" it later.
//
// What IS broken is next door, on the DUPLICATE-row button:
//
//     tare_weight : src.tare_weight ?? '0'
//
// `??` catches null and undefined, NOT ''. syncItemsFromDom stores these as
// raw input strings, so a tare the operator had cleared arrives as '' and
// stays ''. parseFloat('') is NaN, recomputeRowTotals requires isFinite on
// BOTH gross and tare, and the net box therefore stays blank for ANY gross
// typed into that row — including 1. The row looks completely normal and
// silently refuses to compute, which is exactly the shape of what she
// described.
//
// Whether that is the case she hit is not settled. It is a real bug in the
// same three inches of screen, found while looking for hers, and it is fixed
// on both clients.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

process.env.JARVIS_TEST = '1';

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const ROUTES = {
    '/api/me': { ok: true, role: 'admin' },
    '/api/loads': [], '/api/outbound-loads': [], '/api/load-drafts': [],
    '/api/item-types': { ok: true, items: ['Al combo'] },
    '/api/contacts': { ok: true, contacts: [], groups: [] },
};

function boot(file) {
    const HTML = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const errors = [];
    const dom = new JSDOM(HTML, {
        runScripts: 'dangerously', url: 'http://localhost/',
        beforeParse(w) {
            w.fetch = (u) => {
                const k = String(u).split('?')[0];
                return Promise.resolve({ ok: true, status: 200,
                    json: () => Promise.resolve(k in ROUTES ? ROUTES[k] : { ok: true }) });
            };
            w.alert = () => {}; w.confirm = () => true;
            w.addEventListener('error', (e) => errors.push(e.message));
        },
    });
    return { dom, errors };
}

const typeInto = (w, row, cls, val) => {
    const el = row.querySelector(cls);
    el.value = val;
    el.dispatchEvent(new w.Event('input', { bubbles: true }));
};
const read = (row) => ({
    gross: row.querySelector('.ld-item-gross').value,
    tare: row.querySelector('.ld-item-tare').value,
    net: row.querySelector('.ld-item-net').value,
});

(async () => {

for (const [label, file] of [['website', 'dashboard/index.html'], ['app', 'mobile-app/www/index.html']]) {
    section(`${label} — the item row computes net`);
    const { dom, errors } = boot(file);
    await new Promise((r) => setTimeout(r, 700));
    const w = dom.window, d = w.document;

    // The two clients reach the Loads screen differently — the website has
    // switchTab, the app drives loadTab directly. Both are called rather than
    // assuming one, because the Add-load button only exists once that screen
    // has rendered and a missing button here would look like a broken test
    // instead of an un-rendered tab.
    if (typeof w.switchTab === 'function') w.switchTab('loads');
    else if (typeof w.loadTab === 'function') await w.loadTab('loads');
    await new Promise((r) => setTimeout(r, 400));
    const open = d.getElementById('btnAddLoad');
    if (!open) { ck(`${label}: the Add load button exists`, false, 'cannot drive the form'); continue; }
    open.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));

    let rows = [...d.querySelectorAll('#ld_items .item-row')];
    ck(`${label}: the form opens with one item row`, rows.length === 1, `${rows.length} rows`);

    // ── 1 IS NOT A SPECIAL NUMBER ────────────────────────────────────────
    // Asserted explicitly because it is what she reported, and because the
    // obvious "fix" for a falsy-check bug would be to start coercing values
    // in a way that breaks 0.
    typeInto(w, rows[0], '.ld-item-gross', '1');
    ck(`${label}:   gross 1 on the first row gives net 1`, read(rows[0]).net === '1',
       JSON.stringify(read(rows[0])));

    // "this is only for newly added item" — so a row added with + Add item.
    d.getElementById('btnAddItemRow').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    rows = [...d.querySelectorAll('#ld_items .item-row')];
    ck(`${label}:   a newly added row starts with tare 0, not blank`,
       read(rows[1]).tare === '0', JSON.stringify(read(rows[1])));
    typeInto(w, rows[1], '.ld-item-gross', '1');
    ck(`${label}:   gross 1 on a NEWLY ADDED row gives net 1`, read(rows[1]).net === '1',
       JSON.stringify(read(rows[1])));
    // The first keystroke is the one she described failing, so the value is
    // read after a single input event and not after a second.
    typeInto(w, rows[1], '.ld-item-gross', '7');
    typeInto(w, rows[1], '.ld-item-gross', '1');
    ck(`${label}:   and still 1 after being re-edited down from 7`, read(rows[1]).net === '1');

    // ── THE DUPLICATE-ROW BUG ────────────────────────────────────────────
    typeInto(w, rows[0], '.ld-item-desc-input', 'Al combo');
    typeInto(w, rows[0], '.ld-item-gross', '500');
    typeInto(w, rows[0], '.ld-item-tare', '');
    ck(`${label}: a cleared tare leaves the source row's net blank`,
       read(rows[0]).net === '', JSON.stringify(read(rows[0])) +
       ' — correct on its own: a blank weight is not silently a zero, and ' +
       'validateLoadForSave already refuses to save a row missing its tare');

    const dupBtn = rows[0].querySelector('.btn-dup-item');
    ck(`${label}:   the row has a duplicate button`, !!dupBtn);
    if (dupBtn) {
        dupBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 150));
        rows = [...d.querySelectorAll('#ld_items .item-row')];
        const dup = read(rows[1]);
        // THE BUG: `'' ?? '0'` is '', so this used to be blank and the row
        // could never compute a net again.
        ck(`${label}:   duplicating it gives the copy a tare of 0, never blank`,
           dup.tare === '0', JSON.stringify(dup) + " — `??` does not catch ''");
        ck(`${label}:   so the copy computes a net immediately`, dup.net === '500',
           JSON.stringify(dup));
        typeInto(w, rows[1], '.ld-item-gross', '1');
        ck(`${label}:   and gross 1 on the duplicated row gives net 1`,
           read(rows[1]).net === '1', JSON.stringify(read(rows[1])));
    }

    // A tare the operator really typed as 0 is a claim she made and stays 0;
    // the fix must not start treating 0 as "missing" on its way past.
    typeInto(w, rows[0], '.ld-item-tare', '0');
    typeInto(w, rows[0], '.ld-item-gross', '0');
    ck(`${label}:   gross 0 with tare 0 is net 0, not blank`, read(rows[0]).net === '0',
       JSON.stringify(read(rows[0])) + ' — 0 is a number, not an absence');

    // ── A BLANK NET SAYS WHY IT IS BLANK ─────────────────────────────────
    // Her case does not reproduce here, so the cause is on the device. What
    // is fixable without knowing the cause is the diagnosis: net is derived
    // from two boxes, and a silent blank is indistinguishable from a broken
    // app. Now it names the missing half.
    typeInto(w, rows[0], '.ld-item-gross', '500');
    typeInto(w, rows[0], '.ld-item-tare', '');
    const netEl = rows[0].querySelector('.ld-item-net');
    ck(`${label}: a blank net names what it is waiting for`,
       /needs .*tare/.test(netEl.placeholder) && !/gross/.test(netEl.placeholder),
       `placeholder was ${JSON.stringify(netEl.placeholder)} — gross is filled, so only tare is missing`);
    typeInto(w, rows[0], '.ld-item-gross', '');
    ck(`${label}:   and names BOTH when both are empty`,
       /gross/.test(netEl.placeholder) && /tare/.test(netEl.placeholder),
       JSON.stringify(netEl.placeholder));
    typeInto(w, rows[0], '.ld-item-tare', '0');
    typeInto(w, rows[0], '.ld-item-gross', '1');
    ck(`${label}:   and the hint clears once it can compute`,
       netEl.placeholder === '' && netEl.value === '1',
       `placeholder ${JSON.stringify(netEl.placeholder)}, value ${JSON.stringify(netEl.value)}`);

    ck(`${label}: nothing threw`, errors.length === 0, errors.slice(0, 2).join(' | '));
    dom.window.close();
}

section('inventory — one material, one row, her spelling');
{
    // Apsara, 2026-09-16: "item description is case sensitive", and asked
    // where: "Inventory shows it twice".
    //
    // The GROUPING was already case-insensitive and is asserted here so a
    // future change cannot quietly make it sensitive again. What was wrong is
    // the LABEL on one kind of row: an item that was SOLD but never recorded
    // as bought is pushed into the list using the lower-cased grouping KEY as
    // its name, so it rendered "al combo" among rows reading "Al combo" —
    // one material looking like two conventions on one screen.
    const { groupItemsByDescription } = require('../helpers/pdf');
    const mixed = groupItemsByDescription([
        { description: 'Al combo',   net_weight: 100, gross_weight: 100, tare_weight: 0, amount: 10 },
        { description: 'al combo',   net_weight: 200, gross_weight: 200, tare_weight: 0, amount: 20 },
        { description: 'AL COMBO',   net_weight: 300, gross_weight: 300, tare_weight: 0, amount: 30 },
        { description: ' Al Combo ', net_weight: 400, gross_weight: 400, tare_weight: 0, amount: 40 },
    ]);
    ck('four spellings of one material group into ONE row', mixed.length === 1,
       mixed.map((g) => g.description).join(' | '));
    ck('  and their weights are added, not split', mixed[0] && mixed[0].net === 1000,
       JSON.stringify(mixed[0]));
    ck('  and the row is labelled with the spelling she typed first',
       mixed[0] && mixed[0].description === 'Al combo',
       `got ${JSON.stringify(mixed[0] && mixed[0].description)} — not the lower-cased key`);

    // The sold-only row. Read from source rather than by standing up the
    // whole store: the bug is one identifier, and which one it is IS the bug.
    const src = fs.readFileSync(path.join(ROOT, 'helpers/loads.js'), 'utf8');
    const block = src.slice(src.indexOf('Material shipped that was never recorded'),
                            src.indexOf('Material shipped that was never recorded') + 900);
    ck('a sold-only row is labelled with her spelling, not the grouping key',
       /description: hit\.label,/.test(block) && !/description: k,/.test(block),
       'pushing `description: k` prints an all-lowercase row beside properly-cased ones');
}

section('the source of the bug, stated once');
{
    // ── THE CASE THAT CANNOT BE STAGED HERE ──────────────────────────────
    // Writing 'O' (letter, not zero) into a type="number" box was the first
    // attempt, and it revealed the mechanism instead: the browser SANITISES
    // it, so .value comes back '' and the field reads as merely empty. That
    // is precisely the failure mode on a real device — a number input whose
    // contents cannot be parsed reports an EMPTY value while still SHOWING
    // what was typed. The operator sees 1; the code sees nothing. It is the
    // best explanation found for "sometimes ... net is cnot cmng as 1", on a
    // phone, with the tare box reading 0.
    //
    // validity.badInput is the browser's way of telling those two apart, and
    // jsdom does not implement it, so this is asserted at the source rather
    // than driven. Said plainly rather than dressed up as a behavioural test:
    // a test that claims to cover a path it cannot reach is worse than one
    // that admits it.
    for (const f of ['dashboard/index.html', 'mobile-app/www/index.html']) {
        const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
        const at = code.indexOf('function recomputeRowTotals');
        const fn = code.slice(at, at + 5200);
        ck(`${f.split('/')[0]}: unparseable input is detected via validity.badInput`,
           /validity\.badInput/.test(fn),
           'a number input reports value "" for text it cannot parse — badInput is the only way to tell that apart from empty');
        ck(`${f.split('/')[0]}:   and the offending box itself is marked, not just the net column`,
           /grossEl\.style\.borderColor\s*=\s*badGross/.test(fn) && /tareEl\.style\.borderColor\s*=\s*badTare/.test(fn),
           'otherwise the operator sees a weight that looks fine and an empty net, with nothing joining them');
    }

    for (const [label, file] of [['website', 'dashboard/index.html'], ['app', 'mobile-app/www/index.html']]) {
        const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
        ck(`${label}: the duplicate no longer relies on ?? to catch a blank tare`,
           !/tare_weight : src\.tare_weight \?\? '0'/.test(src),
           "`?? '0'` reads as a default and is not one for an empty string");
    }
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('\n  THREW:', e.stack || e.message); process.exit(1); });
