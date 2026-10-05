// ── tests/qb-token-guard.js ───────────────────────────────────────────────
// Her QuickBooks token is the standing ability to read and write her books,
// and a refresh REPLACES the file — so a test that reaches it does not just
// read something private, it can invalidate her connection.
//
// On 2026-10-05 two test files written the same day did exactly that. They
// pinned QB_ENV but not DATA_DIR, loaded her real
// quickbooks-token.sandbox.json, and once that token aged past its refresh
// margin fired a live HTTPS refresh at Intuit with the real fetch —
// getAccessToken defaults fetchImpl to fetch, and their fakeFetch was only
// ever passed to the API calls. On success the refresh would have written
// over her token file.
//
// It also hid in the way CLAUDE.md section 2 describes: every check printed
// PASS and the process exited 1 from an async continuation, so it read as
// flakiness. It was green in the morning and red in the afternoon purely
// because the token had aged in between.
//
// helpers/quickbooks/auth.js now refuses at the single door, the same shape
// as helpers/drive.js. This file is what stops that guard being deleted.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-qb-token-guard-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
delete process.env.QB_TOKEN_FILE;

const auth = require(path.join(ROOT, 'helpers/quickbooks/auth'));
const REAL_DATA_DIR = '/var/lib/jarvis-not-a-temp-dir';

const tryIt = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

// ── A — IT REFUSES HER REAL TOKEN ─────────────────────────────────────────
{
    section('A — under the test runner, her own token is refused');

    // ── DATA_DIR IS CAPTURED AT MODULE LOAD ──────────────────────────────
    // My first version reassigned process.env.DATA_DIR here and the checks
    // went green-on-nothing: auth.js destructures DATA_DIR from config when
    // it is required, so a later reassignment changes nothing at all. That
    // is precisely WHY a test has to isolate before requiring the helper —
    // the thing section D checks — and it is worth the comment, because the
    // failure mode is a guard that appears to work and never fires.
    //
    // QB_TOKEN_FILE is read on every call, so that is the lever here.
    const HERS = '/var/lib/jarvis-not-a-temp-dir/quickbooks-token.sandbox.json';
    process.env.QB_TOKEN_FILE = HERS;
    const why = tryIt(() => auth.assertTokenIsNotHers('sandbox'));
    ck('a token path outside the temp directory throws', !!why, String(why));
    ck('  and the message names the file, so it is obvious which one',
       /jarvis-not-a-temp-dir/.test(why || ''), String(why));
    ck('  and says what a refresh would do',
       /replace the file|invalidate her connection/.test(why || ''), String(why));
    ck('  and how to fix the test',
       /temp directory/.test(why || ''), String(why));
    ck('  loadToken refuses too, rather than returning null quietly',
       !!tryIt(() => auth.getAccessToken && require(path.join(ROOT, 'helpers/quickbooks/auth')) && (() => {
           // loadToken is private; reach it the way production does.
           const a2 = require(path.join(ROOT, 'helpers/quickbooks/auth'));
           return a2.status ? a2.status({ env: 'sandbox' }) : null;
       })()),
       'a silent null would read as "not connected" instead of as a mistake in the test');

    // loadToken is the door. If the guard is only in assertTokenIsNotHers
    // and nothing calls it, the guard is decorative.
    const src = fs.readFileSync(path.join(ROOT, 'helpers/quickbooks/auth.js'), 'utf8');
    const loadFn = src.slice(src.indexOf('function loadToken'), src.indexOf('function loadToken') + 260);
    ck('loadToken calls it before reading anything',
       /assertTokenIsNotHers\(env\)/.test(loadFn)
       && loadFn.indexOf('assertTokenIsNotHers') < loadFn.indexOf('readFileSync'),
       loadFn.slice(0, 200));
    delete process.env.QB_TOKEN_FILE;
}

// ── B — A PROPERLY ISOLATED TEST IS NOT PUNISHED ──────────────────────────
// The first version of this guard refused whenever QB_TOKEN_FILE was unset,
// and tests/quickbooks-auth.js went red: it isolates DATA_DIR into a temp
// dir and DELETES QB_TOKEN_FILE on purpose, because what it tests is that
// token files land under DATA_DIR. A guard that fails a correctly-written
// test teaches people to delete the guard.
{
    section('B — an isolated test is left alone');

    process.env.DATA_DIR = TMP;
    delete process.env.QB_TOKEN_FILE;
    ck('a token under a temp DATA_DIR is allowed, with no QB_TOKEN_FILE',
       tryIt(() => auth.assertTokenIsNotHers('sandbox')) === null,
       String(tryIt(() => auth.assertTokenIsNotHers('sandbox'))));
    ck('  and the path really is the temp one',
       String(auth.tokenFile('sandbox')).startsWith(TMP), auth.tokenFile('sandbox'));

    process.env.QB_TOKEN_FILE = path.join(TMP, 'pinned.json');
    ck('an explicitly pinned temp file is allowed too',
       tryIt(() => auth.assertTokenIsNotHers('sandbox')) === null);

    // A pin pointing at her real token is NOT a licence.
    process.env.QB_TOKEN_FILE = path.join(REAL_DATA_DIR, 'quickbooks-token.sandbox.json');
    ck('  but pinning at her real file is still refused',
       !!tryIt(() => auth.assertTokenIsNotHers('sandbox')),
       'the pin is a convenience, not an override');
    delete process.env.QB_TOKEN_FILE;
    process.env.DATA_DIR = TMP;
}

// ── C — INERT IN PRODUCTION ───────────────────────────────────────────────
// The server must not be affected. Production never sets JARVIS_TEST, which
// is the same contract helpers/drive.js relies on.
{
    section('C — the server is untouched');

    // THE SAME TRAP, ONE SECTION LATER. My first version of this section
    // reassigned process.env.DATA_DIR to a non-temp path and unset
    // JARVIS_TEST — and because DATA_DIR is captured at module load,
    // tokenFile() kept returning the TEMP path, so the guard returned early
    // whatever JARVIS_TEST said. Both checks passed, and a mutation that
    // armed the guard in production survived them. QB_TOKEN_FILE is the
    // lever that is read on every call; it is the only one that works here.
    const keepT = process.env.JARVIS_TEST;
    const OUTSIDE = '/var/lib/jarvis-not-a-temp-dir/quickbooks-token.sandbox.json';
    process.env.QB_TOKEN_FILE = OUTSIDE;

    // Sanity first, so this section cannot pass by accident again: with the
    // runner armed, this exact path MUST be refused.
    process.env.JARVIS_TEST = '1';
    ck('the fixture really is a path the guard objects to',
       !!tryIt(() => auth.assertTokenIsNotHers('sandbox')),
       'if this passes, the rest of the section proves nothing');

    delete process.env.JARVIS_TEST;
    ck('with JARVIS_TEST unset, that same path is readable',
       tryIt(() => auth.assertTokenIsNotHers('sandbox')) === null,
       String(tryIt(() => auth.assertTokenIsNotHers('sandbox'))));
    process.env.JARVIS_TEST = '0';
    ck('  and only the exact value "1" arms it',
       tryIt(() => auth.assertTokenIsNotHers('sandbox')) === null,
       String(tryIt(() => auth.assertTokenIsNotHers('sandbox'))));
    process.env.JARVIS_TEST = keepT;
    delete process.env.QB_TOKEN_FILE;
}

// ── D — THE TWO FILES THAT CAUSED THIS NOW ISOLATE ────────────────────────
{
    section('D — the two offenders, and the house rule');

    for (const f of ['tests/quickbooks-payables.js', 'tests/quickbooks-apply-receipts.js']) {
        const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
        ck(`${path.basename(f)} sets DATA_DIR to a temp dir`,
           /process\.env\.DATA_DIR\s*=\s*TMP/.test(s) && /mkdtempSync/.test(s), f);
        ck(`  …and pins QB_TOKEN_FILE`, /process\.env\.QB_TOKEN_FILE\s*=/.test(s), f);
        ck(`  …and aborts if config is not isolated`, /ABORT/.test(s), f);
        // The isolation has to happen BEFORE the helper is required, or the
        // module has already resolved paths against her real directory.
        ck(`  …before requiring the helper it tests`,
           s.indexOf('process.env.DATA_DIR') < s.indexOf("require('../helpers/quickbooks"),
           `DATA_DIR at ${s.indexOf('process.env.DATA_DIR')}, require at ${s.indexOf("require('../helpers/quickbooks")}`);
    }

    // And the wider rule, stated as a number rather than a hope: the great
    // majority of suites isolate, and the ones that do not were measured
    // against an unreadable token and were unaffected.
    const all = fs.readdirSync(path.join(ROOT, 'tests')).filter((x) => x.endsWith('.js'));
    const isolated = all.filter((x) => /process\.env\.DATA_DIR\s*=/.test(
        fs.readFileSync(path.join(ROOT, 'tests', x), 'utf8')));
    ck(`most suites isolate DATA_DIR (${isolated.length} of ${all.length})`,
       isolated.length > all.length * 0.55, `${isolated.length}/${all.length}`);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
