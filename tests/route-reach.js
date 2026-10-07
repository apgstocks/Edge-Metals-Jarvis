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

// ── E — THE ROUTE SIDE OF THE PARSER ──────────────────────────────────────
// Section B covers the CALL parser. Until 2026-10-07 nothing covered the
// ROUTE parser, and it had two holes — each one proved by planting a guarded,
// uncalled route and watching the report stay healthy:
//
//   · routeFiles() collected api.js plus any file under helpers/ whose NAME
//     matched /routes?\.js$/, case-sensitive. helpers/bankMatchRoutes.js ends
//     in a capital-R "Routes.js" and was never opened — nine Plaid and
//     bank-alias routes live there. helpers/bankDocs.js has two mutating
//     routes and matches no convention at all. Coverage that depends on what
//     someone named a file is coverage that quietly shrinks.
//   · the gate had to be the argument IMMEDIATELY after the path. Writing
//     `largeJson, requireSuper` instead of `requireSuper, largeJson` dropped
//     the count from 55 to 54 and removed a real route from the check's remit.
//     The only symptom was a number nobody reads.
//
// Fed as source text for the same reason as section B: a check that reads
// today's repo back to itself would have passed throughout both holes.
{
    section('E — the route parser, on the shapes that were invisible');

    const R = (src) => reach.routesIn(src);

    let r = R(`app.delete('/api/x/:id', requireSuper, async (req, res) => { res.json({}); });`);
    ck('the plain shape', r.length === 1 && r[0].method === 'DELETE'
       && r[0].route === '/api/x/:id' && r[0].gate === 'requireSuper', JSON.stringify(r));

    // HOLE 2. Express does not care about middleware order, so neither can this.
    r = R(`app.put('/api/x/:id', largeJson, requireSuper, async (req, res) => {});`);
    ck('  a gate AFTER another middleware still counts',
       r.length === 1 && r[0].gate === 'requireSuper', JSON.stringify(r));

    r = R(`app.post('/api/x', upload.single('file'), requireAdmin, (req, res) => {});`);
    ck('  and a gate after a middleware that is itself a CALL',
       r.length === 1 && r[0].gate === 'requireAdmin', JSON.stringify(r));

    // The opposite error: counting a route as guarded because the word
    // appears somewhere in its handler. That would hide a genuinely open
    // route behind a mention of the thing that does not protect it.
    r = R(`app.post('/api/open', async (req, res) => {
             if (req.role === 'x') return requireSuper;   // not a gate
           });`);
    ck('  but the word inside a HANDLER is not a gate', r.length === 0, JSON.stringify(r));

    // An ungated route is not this check's business — it has no permission to
    // be unusable. Counting them would add ~140 entries of noise, and the
    // script's own header says five false alarms is worse than no guard.
    r = R(`app.post('/api/open', async (req, res) => { res.json({}); });`);
    ck('  an ungated route is not collected at all', r.length === 0, JSON.stringify(r));

    // A path built from a variable cannot be matched against a client call,
    // so it is skipped rather than recorded as the literal '${name}'.
    r = R('app.post(`/api/${name}`, requireAdmin, (req, res) => {});');
    ck('  a path built from a variable is skipped, not recorded as the template',
       r.length === 0, JSON.stringify(r));

    // ── A LONG HANDLER MUST NOT SWALLOW THE ROUTE ────────────────────────
    // A first attempt at fixing hole 2 read the WHOLE call with argsAt() and
    // lost six real routes — /api/expenses/:id, /api/bol/generate and four
    // more — because argsAt() tracks quotes across the entire handler body,
    // and one apostrophe or regex in hundreds of lines of HTML template
    // desynced it into returning null. The count fell 55 → 49 and the report
    // still looked healthy.
    r = R(`app.delete('/api/expenses/:id', requireAdmin, async (req, res) => {
             const s = \`it's a template with 'quotes' and a regex /['"]/ in it\`;
             const t = "and a \\" escaped quote";
             res.json({ s, t });
           });`);
    ck('  a handler full of quotes and regexes does not hide its own route',
       r.length === 1 && r[0].route === '/api/expenses/:id', JSON.stringify(r));

    // HOLE 1, on the live repo: the two files that were never opened.
    const files = reach.routeFiles().map((f) => path.relative(ROOT, f));
    for (const f of ['helpers/bankMatchRoutes.js', 'helpers/bankDocs.js',
                     'helpers/claims/routes.js', 'helpers/quickbooks/routes.js', 'api.js']) {
        ck(`  ${f} is one of the files the check reads`, files.includes(f), files.join(', '));
    }
    // Discovery is by CONTENT, so renaming a file cannot remove it from the
    // check. This is the property, stated without naming a convention.
    ck('  every file that registers a mutating route is read',
       files.length >= 5, `${files.length} files: ${files.join(', ')}`);

    // The count, pinned. Not a target — a tripwire. It may legitimately rise
    // when routes are added; it must never FALL without someone deleting a
    // route on purpose, because a silent fall is what both holes looked like.
    const live = reach.routes().length;
    ck('the guarded-route count has not silently fallen', live >= 55,
       `${live} guarded mutating routes — was 55 on 2026-10-07. If routes were `
       + 'deliberately removed, lower this number in the same commit.');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
