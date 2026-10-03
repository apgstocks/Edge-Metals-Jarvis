// ── tests/route-reach.js ──────────────────────────────────────────────────
// Keeps scripts/check-route-reach.js honest, and keeps its finding in front
// of someone.
//
// The script answers one question: is there any client that calls each
// guarded mutating route, with the right METHOD. It exists because the answer
// has been "no" three times, each time for a route that was written, guarded,
// audited and correct — see the script's own header for the three.
//
// ── WHAT THIS FILE IS FOR, WHICH IS NOT THE SAME THING ───────────────────
// A check like that has one failure mode worth worrying about: going green
// for the wrong reason and staying green forever. The script's first two
// versions both did exactly that —
//
//   v1 matched the PATH only, so a DELETE with no caller hid behind the GET
//      and POST on the same path. It reported 0 unreachable with the button
//      deliberately removed.
//   v2 matched the method but read the call with a regex that stopped at the
//      first ')', so api('/api/x/' + encodeURIComponent(id), {method:'DELETE'})
//      closed a paren inside its own arguments and five correct routes were
//      reported broken. Five false alarms is worse than no check: it gets
//      ignored, and the noise covers the one real finding.
//
// So section B feeds the parser the shapes both clients actually use and the
// shapes that broke it, rather than asserting against today's repo — a check
// that only ever reads the current code back to itself proves nothing.
//
// Section C is the live count, written as a CEILING against a named list
// rather than "must be zero". Zero is not true today and pretending otherwise
// would mean either a red suite nobody can fix in passing, or an allowlist
// entry that makes a real gap invisible. Naming it keeps it visible and still
// bites the moment a NEW one appears.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const reach = require(path.join(ROOT, 'scripts/check-route-reach.js'));

// ── THE ROUTES KNOWN TO BE UNREACHABLE, AND WHY ──────────────────────────
// Not an allowlist that excuses them — a list that has to shrink. Each entry
// is an open finding with somewhere to go.
const KNOWN_OPEN = {
    'DELETE /api/item-aliases': 'itemAliases.forget() has no screen. She can tell '
        + 'Jarvis that two item descriptions mean the same metal (POST, from the '
        + 'load form) and there is no way to take it back — GET /api/item-aliases, '
        + 'the list, has no caller either, so there is no alias screen at all. '
        + 'Needs her decision on where such a screen belongs; a wrong alias merges '
        + 'two metals on inventory and on an invoice.',
};

// ── A — THE SCRIPT RUNS AND SAYS SOMETHING ────────────────────────────────
{
    section('A — the check itself');

    const { routes, calls, unreachable } = reach.unreachableRoutes();

    ck('it finds the guarded mutating routes', routes.length > 30, String(routes.length));
    ck('  and the client api() calls', calls.length > 200, String(calls.length));

    // The whole point is reading the method. A run where every call looked
    // like a GET would make every POST and DELETE report unreachable, which
    // is v1's failure wearing the opposite face.
    const methods = new Set(calls.map((c) => c.method));
    ck('  reading more than one method off the calls',
       methods.has('GET') && methods.has('POST') && methods.has('DELETE'),
       [...methods].join(','));

    ck('  and it does not just report everything',
       unreachable.length < routes.length / 4,
       `${unreachable.length} of ${routes.length} — a check that fails everything fails nothing`);
}

// ── B — THE PARSER, ON THE SHAPES THAT BROKE IT ───────────────────────────
// Fed as source text, so these keep describing the parser even if every one
// of them disappears from the repo.
{
    section('B — the call shapes, including the two that fooled earlier versions');

    const one = (src) => reach.callsIn(src);

    // The plain case.
    let c = one(`await api('/api/x', { method: 'POST', body: '{}' });`);
    ck('a plain literal with a method', c.length === 1 && c[0].url === '/api/x' && c[0].method === 'POST',
       JSON.stringify(c));

    // No method named at all is a GET — api()'s own default.
    c = one(`const d = await api('/api/metals-trucking');`);
    ck('  no method named reads as GET', c.length === 1 && c[0].method === 'GET', JSON.stringify(c));

    // ── THE ONE THAT BROKE v2 ────────────────────────────────────────────
    // A paren closes INSIDE the arguments. A regex that stops at the first
    // ')' never reaches `method`, calls it a GET, and reports the DELETE
    // unreachable. Five live routes were wrongly accused by this.
    c = one(`await api('/api/import/' + encodeURIComponent(batch), { method: 'DELETE' });`);
    ck('  a nested call in the url does not hide the method',
       c.length === 1 && c[0].url === '/api/import/' && c[0].method === 'DELETE',
       JSON.stringify(c));

    // Template literal with an interpolation — the other common shape.
    c = one('await api(`/api/sales-settlements/${encodeURIComponent(id)}`, { method: \'DELETE\' });');
    ck('  a template literal gives its literal prefix',
       c.length === 1 && c[0].method === 'DELETE' && c[0].url.startsWith('/api/sales-settlements/'),
       JSON.stringify(c));

    // ── THE ONE THAT BROKE v1 ────────────────────────────────────────────
    // Three calls on one path, three methods. v1 matched the path and so
    // treated the DELETE as covered by the GET sitting beside it.
    c = one(`
        const d = await api('/api/metals-trucking');
        await api('/api/metals-trucking', { method: 'POST', body: b });
    `);
    ck('  a GET and a POST on one path stay two different calls',
       c.length === 2 && c.map((x) => x.method).sort().join(',') === 'GET,POST',
       JSON.stringify(c.map((x) => x.method)));

    // A method held in a variable cannot be read. It must widen to "any",
    // never narrow to GET — guessing GET would invent an unreachable DELETE,
    // and a guard that cries wolf is a guard that gets switched off.
    c = one(`await api('/api/thing/' + id, { method: m, body: b });`);
    ck('  a method in a variable matches any method, rather than guessing GET',
       c.length === 1 && c[0].anyMethod === true, JSON.stringify(c));

    // Not a call at all.
    c = one(`const apiary = 'bees'; // api( in a comment`);
    ck('  and a word that merely contains "api" is not a call',
       c.length === 0, JSON.stringify(c));
}

// ── C — THE LIVE COUNT ────────────────────────────────────────────────────
{
    section('C — what is unreachable today');

    const { unreachable } = reach.unreachableRoutes();
    const keys = unreachable.map((u) => `${u.method} ${u.route}`).sort();
    const known = Object.keys(KNOWN_OPEN).sort();

    const unexpected = keys.filter((k) => !KNOWN_OPEN[k]);
    ck('no NEW guarded route has become unreachable',
       unexpected.length === 0,
       unexpected.length
           ? unexpected.join(', ') + '\n        A guarded route nothing calls is a permission that '
             + 'cannot be used. Either the screen is missing, or the route is dead.'
           : '');

    // The other direction, and the one that actually rots: an entry that has
    // been FIXED and left in the list. Left alone, KNOWN_OPEN slowly becomes
    // a list of things that are fine, and then the real one hides among them.
    const fixed = known.filter((k) => !keys.includes(k));
    ck('  and nothing in KNOWN_OPEN has quietly been fixed',
       fixed.length === 0,
       fixed.length ? fixed.join(', ') + ' — reachable now; delete the entry' : '');

    // The four Edge Metals payment deletions by name, because this is the
    // request that produced the check and the one most likely to be undone
    // by a later tidy-up of the screens.
    for (const r of ['/api/bill-payments/:id', '/api/sales-receipts/:id',
                     '/api/metals-trucking/:id', '/api/sales-settlements/:id']) {
        ck(`  DELETE ${r} is reachable`, !keys.includes(`DELETE ${r}`));
    }

    if (unreachable.length) {
        console.log('\n  open:');
        for (const k of keys) console.log(`    · ${k}\n      ${KNOWN_OPEN[k] || 'NOT IN KNOWN_OPEN'}`);
    }
}

// ── D — IT CANNOT BE SILENCED BY ACCIDENT ─────────────────────────────────
{
    section('D — the allowlist in the script');

    ck('BY_DESIGN is empty, so nothing is excused without a reason',
       Object.keys(reach.BY_DESIGN).length === 0,
       Object.keys(reach.BY_DESIGN).join(', ')
       + ' — every entry needs a stated reason, or the check becomes a rubber stamp');

    const src = fs.readFileSync(path.join(ROOT, 'scripts/check-route-reach.js'), 'utf8');
    ck('  and the build-copy folders are excluded',
       /android|ios/.test(src) && /build/.test(src),
       'mobile-app/android assets are a COPY of www — counting them would let a '
       + 'stale APK asset make a route look reachable');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
