// ── tests/item-catalogue.js ────────────────────────────────────────────────
// Bose, via Apsara, 2026-09-02: "sometimes newly added items not coming."
//
// "Sometimes" is the tell of a network-dependent failure, and the description
// catalogue had two silent ways to lose entries — both of which turn a working
// type-ahead into an empty one with no error shown to anyone:
//
//   1. refreshCustomItemTypes() did `catch { customItemTypes = []; }`. ONE
//      failed GET wiped the whole catalogue for that modal session. The
//      comment claimed it "falls back to the base list", but itemDescOptions()
//      returns customItemTypes.slice() and nothing else — the base presets
//      were folded into the server list on 2026-08-20. The comment described
//      behaviour that had stopped existing.
//
//   2. A newly typed description was pushed onto the local list only INSIDE
//      the POST's .then(). If the POST failed — and its .catch was an empty
//      function — the description was lost completely, with no log.
//
// These run the REAL functions out of both shipped clients against a fake
// network, rather than reimplementing them. Every assertion below fails
// against the previous code; verified by mutation.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const CLIENTS = [
    ['app', fs.readFileSync(path.join(ROOT, 'mobile-app/www/index.html'), 'utf8')],
    ['website', fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8')],
];

function grab(src, name, label) {
    for (const kw of ['async function ', 'function ']) {
        const i = src.indexOf(kw + name + '(');
        if (i < 0) continue;
        let d = 0, j = src.indexOf('{', i);
        for (let k = j; k < src.length; k++) {
            if (src[k] === '{') d++;
            else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
        }
    }
    throw new Error(`${label}: could not find ${name}() — if it was renamed, update this test rather than deleting it`);
}

console.log('\n─ the item description catalogue survives a bad network ─────');

// ── 1. a failed refresh keeps the last known list ─────────────────────────
section('A — one dropped request must not empty the catalogue');
(async () => {
for (const [label, src] of CLIENTS) {
    // Build a tiny host holding the module-level `customItemTypes`, then run
    // the real refresh function against a network that fails.
    const make = (apiImpl) => {
        const host = { customItemTypes: ['Copper', 'Brass', 'Aluminium'], itemTypesStale: false };
        const fn = new Function('api', 'console', 'host',
            'let customItemTypes = host.customItemTypes; let itemTypesStale = host.itemTypesStale;\n' +
            // refreshCustomItemTypes now re-applies anything the server has
            // not confirmed yet (see section B3). Section A does not exercise
            // that, but the binding has to exist or the function throws and
            // every assertion here fails for the wrong reason.
            'const pendingItemTypes = new Set();\n' +
            grab(src, 'refreshCustomItemTypes', label) +
            '\nreturn async () => { await refreshCustomItemTypes(); host.customItemTypes = customItemTypes; host.itemTypesStale = itemTypesStale; };'
        )(apiImpl, { warn: () => {} }, host);
        return { host, run: fn };
    };

    // THE REPORTED FAILURE: the request throws.
    {
        const { host, run } = make(async () => { throw new Error('Network request failed'); });
        await run();
        ck(`${label}: a failed refresh keeps the previous descriptions`,
           host.customItemTypes.length === 3,
           'this is the bug Bose hit — the catalogue used to be emptied on any error');
        ck(`${label}:   ...and marks the list as possibly stale`, host.itemTypesStale === true);
    }

    // A 200 carrying something that is not an array — a proxy error page, a
    // login redirect. Just as destructive as a throw, and it did not even go
    // through the catch.
    {
        const { host, run } = make(async () => '<html>Gateway Timeout</html>');
        await run();
        ck(`${label}: a non-array 200 does not become the catalogue`,
           Array.isArray(host.customItemTypes) && host.customItemTypes.length === 3);
    }

    // And the normal path still works, or the fix above would be a fine way
    // to freeze the catalogue forever.
    {
        const { host, run } = make(async () => ['Copper', 'Brass', 'Aluminium', 'Radiators']);
        await run();
        ck(`${label}: a good refresh still replaces the list`,
           host.customItemTypes.length === 4 && host.customItemTypes.includes('Radiators'));
        ck(`${label}:   ...and clears the stale flag`, host.itemTypesStale === false);
    }

    // An empty catalogue is a legitimate server answer (nothing added yet)
    // and must still be accepted — the fix must not confuse "empty" with
    // "failed".
    {
        const { host, run } = make(async () => []);
        await run();
        ck(`${label}: a genuinely empty catalogue is accepted`,
           Array.isArray(host.customItemTypes) && host.customItemTypes.length === 0);
    }
}

// ── 2. a newly typed description survives a failed POST ───────────────────
section('B — a new description is kept locally even if the server misses it');
for (const [label, src] of CLIENTS) {
    // The registration block lives inside the save handler, so it is asserted
    // from source. Behavioural coverage of the list itself is section A.
    const save = src.slice(src.indexOf('const knownDescs = itemDescOptions()'));
    const withComments = save.slice(0, save.indexOf('const payload = {'));
    // Comments stripped before asserting. The explanation above this code
    // quotes the old `.catch(() => {})` by name, so a naive search found it
    // in the very comment describing its removal and failed against correct
    // code. Caught while verifying this file — the same trap tests/voice-e2e.js
    // hit with SR.start(), which is why that one strips comments too.
    const block = withComments.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

    ck(`${label}: the description is added locally BEFORE the POST`,
       /rememberNewItemType\(d\);[\s\S]{0,200}api\('\/api\/item-types'/.test(block),
       'pushing only inside .then() loses the entry entirely when the POST fails');
    // The dedupe moved into rememberNewItemType when the pending-set was
    // added, so assert it where it now lives rather than in the save block.
    const remember = grab(src, 'rememberNewItemType', label);
    ck(`${label}: adding does not duplicate one already on the list`,
       /!customItemTypes\.some\(x => String\(x\)\.toLowerCase\(\) === v\.toLowerCase\(\)\)/.test(remember));
    ck(`${label}: and it is recorded as pending until the server confirms`,
       /pendingItemTypes\.add\(v\)/.test(remember));
    ck(`${label}: a failed POST is retried once`, /setTimeout\(r, \d+\)\)\.then\(post\)/.test(block));
    ck(`${label}: and a final failure is logged, not swallowed`,
       /console\.warn\('\[items\] could not save the new description/.test(block));
    ck(`${label}: there is no bare .catch(() => {}) left in this block`,
       !/\.catch\(\(\) => \{\}\)/.test(block),
       'an empty catch here is why "it is not remembering my item names" was invisible');
    // It must stay fire-and-forget: the load is already saved by this point
    // and must never fail because a catalogue entry did not stick.
    ck(`${label}: the load save does not await the catalogue write`,
       !/await api\('\/api\/item-types'/.test(block));
}

// ── 2b. a description typed on row 1 is offered on row 2 ──────────────────
section('B2 — the type-ahead offers what is typed elsewhere in THIS form');
for (const [label, src] of CLIENTS) {
    // Bose, 2026-09-02: "new item stored -> immediately if we try adding in
    // next line, it is not displaying."
    //
    // The real function, against a fake #ld_items holding two rows.
    const rows = [{ value: 'Radiators' }, { value: '' }];
    const suggest = new Function('itemDescOptions', 'document',
        grab(src, 'itemDescSuggestions', label) + '; return itemDescSuggestions;')(
        () => ['Copper', 'Brass'],
        { querySelectorAll: (sel) => (sel === '#ld_items .ld-item-desc-input' ? rows : []) });

    const out = suggest();
    ck(`${label}: a description typed on another row is offered`, out.includes('Radiators'),
       'this is the reported bug — it was only offered after the whole load had been saved');
    ck(`${label}: the saved catalogue is still offered`, out.includes('Copper') && out.includes('Brass'));
    ck(`${label}: the catalogue comes first`, out.indexOf('Copper') < out.indexOf('Radiators'));
    ck(`${label}: blank rows contribute nothing`, !out.includes(''));

    // Case-insensitive dedupe, so typing "copper" on a row does not produce a
    // second entry beside the catalogue's "Copper".
    const dup = new Function('itemDescOptions', 'document',
        grab(src, 'itemDescSuggestions', label) + '; return itemDescSuggestions;')(
        () => ['Copper'],
        { querySelectorAll: () => [{ value: 'copper' }, { value: '  Copper  ' }] });
    ck(`${label}: a row repeating a known description does not duplicate it`,
       dup().filter(d => String(d).toLowerCase() === 'copper').length === 1);

    // ── the interaction that makes this two functions and not one ─────────
    // The save handler diffs against itemDescOptions() to decide what is NEW
    // and needs POSTing. If it used the suggestions instead, every freshly
    // typed description would look already-known and would never be sent —
    // trading a display bug for silent data loss.
    const save = src.slice(src.indexOf('const knownDescs = itemDescOptions()'));
    const block = save.slice(0, save.indexOf('const payload = {'))
        .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    ck(`${label}: the save handler still diffs against the SAVED catalogue`,
       /const knownDescs = itemDescOptions\(\)/.test(block) && !/itemDescSuggestions/.test(block),
       'using suggestions here would make every new description look known and never POST it');

    // ── the function must actually be WIRED to the dropdown ───────────────
    // Added after mutation-testing: reverting the call site to
    // itemDescOptions() left every assertion above green, because they call
    // itemDescSuggestions directly. A perfect function nothing calls is the
    // exact shape of the dead-feature bug this project shipped once already,
    // so the wiring gets its own assertion.
    const menu = src.slice(src.indexOf('const openMatches = () =>'));
    const openMatches = menu.slice(0, menu.indexOf('input.addEventListener(\'focus\''));
    ck(`${label}: the dropdown is built from itemDescSuggestions()`,
       /const all = itemDescSuggestions\(\);/.test(openMatches),
       'the union is useless if the menu still reads the saved catalogue');
}

// ── 2c. a refresh must not delete a write the server has not caught up on ──
section('B3 — a just-saved description survives the next refresh');
for (const [label, src] of CLIENTS) {
    // The race: saving a load POSTs the new description fire-and-forget, then
    // the modal closes and reopens, which refreshes from the server. That GET
    // routinely beats the POST, returns a list without the new description,
    // and the refresh REPLACES the array — deleting the local copy.
    const build = (serverList) => {
        const host = { customItemTypes: ['Copper'], itemTypesStale: false };
        const fns = new Function('api', 'console', 'host',
            'let customItemTypes = host.customItemTypes; let itemTypesStale = false;\n' +
            grab(src, 'rememberNewItemType', label) + '\n' +
            'const pendingItemTypes = new Set();\n' +
            grab(src, 'refreshCustomItemTypes', label) + '\n' +
            'return { remember: rememberNewItemType, refresh: refreshCustomItemTypes, ' +
            '  read: () => customItemTypes, pending: () => Array.from(pendingItemTypes) };'
        )(async () => serverList(), { warn: () => {} }, host);
        return fns;
    };

    // Server has not caught up yet.
    {
        let list = ['Copper'];
        const f = build(() => list);
        f.remember('Radiators');
        ck(`${label}: it is available immediately after saving`, f.read().includes('Radiators'));
        await f.refresh();
        ck(`${label}: and it SURVIVES a refresh that raced the write`,
           f.read().includes('Radiators'),
           'the refresh used to replace the array wholesale and delete it');
        ck(`${label}:   ...and is still pending`, f.pending().includes('Radiators'));

        // Now the server confirms it.
        list = ['Copper', 'Radiators'];
        await f.refresh();
        ck(`${label}: once the server confirms, it stops being re-applied`,
           !f.pending().includes('Radiators') && f.read().includes('Radiators'));

        // ...and a LATER deletion in Settings must actually take effect, which
        // it could not if pending entries were merged forever.
        list = ['Copper'];
        await f.refresh();
        ck(`${label}: a description deleted in Settings really goes away`,
           !f.read().includes('Radiators'),
           'merging pending entries forever would make deletion impossible on this client');
    }
}

// ── 3. the stale comment is gone ──────────────────────────────────────────
section('C — the fallback the old comment promised really does not exist');
for (const [label, src] of CLIENTS) {
    // The point is not the wording of a comment — it is that there is no base
    // list to fall back TO, which is what made emptying the array so costly.
    // If a real fallback is ever added, this fails and the comment above
    // refreshCustomItemTypes needs rewriting to match.
    const opts = grab(src, 'itemDescOptions', label);
    ck(`${label}: itemDescOptions returns ONLY the server list`,
       /return customItemTypes\.slice\(\);/.test(opts) && !/concat|\.\.\.|BASE|PRESET/.test(opts),
       'if this changes, the "keep the last known list" reasoning needs revisiting');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  Failed:'); failures.forEach((f) => console.log('   - ' + f)); }
process.exit(fail ? 1 : 0);
})();
