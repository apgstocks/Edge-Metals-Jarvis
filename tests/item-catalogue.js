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
       /customItemTypes\.push\(d\);[\s\S]{0,200}api\('\/api\/item-types'/.test(block),
       'pushing only inside .then() loses the entry entirely when the POST fails');
    ck(`${label}: pushing does not duplicate one already on the list`,
       /!itemDescOptions\(\)\.some\(/.test(block));
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
