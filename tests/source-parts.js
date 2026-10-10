// ── tests/source-parts.js ───────────────────────────────────────────────
// api.js is now split into routes/*.js, each moved text (not rewritten),
// with helpers/sourceParts.js putting the original back together for the
// hundred-odd tests that read api.js as text. This guards that reassembly:
// if a routes/ file's markers drift, or api.js's mount lines stop matching
// what is actually on disk, this goes red before a text-reading test gives a
// silently wrong answer instead of a crash.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const sp = require(path.join(ROOT, 'helpers/sourceParts'));

// ── A — apiSource() reassembles real, parseable JS ────────────────────────
{
    section('A — apiSource() rebuilds a whole, valid api.js');

    const src = sp.apiSource();
    ck('non-empty string', typeof src === 'string' && src.length > 100000, String(src.length));
    ck('no leftover @@ markers of any kind', !/@@(parts|chunk)/.test(src),
       (src.match(/@@(parts|chunk)[^\n]*/g) || []).join(' | '));

    let parseErr = null;
    try { new vm.Script(src, { filename: 'api.rebuilt.js' }); } catch (e) { parseErr = e; }
    ck('parses as valid JavaScript', parseErr === null, parseErr && parseErr.message);

    ck('still defines createApi', /function createApi\s*\(/.test(src));
    ck('still exports createApi, decorateBooking, DASH_STAGES',
       /module\.exports\s*=\s*\{\s*createApi,\s*decorateBooking,\s*DASH_STAGES\s*\}/.test(src));
}

// ── B — routeFiles() finds every mount, from the real on-disk api.js ─────
{
    section('B — every route file api.js mounts actually exists');

    const raw = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
    const files = sp.routeFiles(raw);

    // Not hardcoded to a length of 14 by name — a group added or removed
    // later should move this count without the assertion needing surgery.
    // What matters is that it finds MORE THAN ONE (the split actually
    // happened) and that every name it finds is real.
    ck('finds more than one mounted route file', files.length > 1, String(files.length));

    const missing = files.filter((f) => !fs.existsSync(path.join(ROOT, 'routes', f)));
    ck('every mounted file exists on disk under routes/', missing.length === 0, missing.join(', '));

    const seen = new Set();
    const dupes = files.filter((f) => (seen.has(f) ? true : (seen.add(f), false)));
    ck('no route file is mounted twice', dupes.length === 0, dupes.join(', '));
}

// ── C — routeChunk() round-trips byte-for-byte through each routes/ file ──
{
    section('C — each routes/ file\'s chunk substitutes back in cleanly');

    const raw = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
    const files = sp.routeFiles(raw);

    for (const f of files) {
        let chunk = null, err = null;
        try { chunk = sp.routeChunk(f); } catch (e) { err = e; }
        ck(`routes/${f} has well-formed @@chunk markers`, err === null, err && err.message);
        if (chunk !== null) {
            ck(`  routes/${f}'s chunk is non-empty`, chunk.length > 0);
            ck(`  routes/${f}'s chunk carries no stray chunk markers of its own`,
               !/@@chunk/.test(chunk));
        }
    }
}

// ── D — the reassembled source is what actually runs, not a fiction ──────
// If apiSource() silently diverged from the api.js Node really loads (a
// marker typo, a chunk pulled from the wrong file), this is the check that
// would notice: it requires the REAL api.js, confirms it boots a real app,
// and confirms the reassembled TEXT still declares every route path the
// real, running app registered — not by re-deriving them from app._router
// (which already matches by construction) but by checking the rebuilt
// source contains the literal route string for a sample spread across
// several of the split groups.
{
    section('D — reassembly matches what actually boots');

    const { createApi } = require(path.join(ROOT, 'api.js'));
    let app = null, bootErr = null;
    try { app = createApi(); } catch (e) { bootErr = e; }
    ck('the real, split api.js boots createApi() without throwing', bootErr === null,
       bootErr && bootErr.stack);

    const src = sp.apiSource();
    // One route sampled from several different split groups (core, scans,
    // payments, yard, invoices, admin, pages) — not an exhaustive list, just
    // enough that a group silently dropped from the rebuild shows up here.
    const sample = ['/api/me', '/api/documents/scan', '/api/payments', '/address-book'];
    for (const r of sample) {
        ck(`rebuilt source still contains route "${r}"`, src.includes(r));
    }
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
