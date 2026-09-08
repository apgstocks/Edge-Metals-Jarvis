// ── tests/gemini-failure.js ───────────────────────────────────────────────
// Apsara, 2026-09-07: "When i say send mail, its not doin that."
//
// Traced to workflow/actions.js, which answered EVERY draft failure with
// "Couldn't draft that email — try rephrasing what it should say." The
// classifier had worked, the address had been found; the WRITER was the thing
// that did not come back. And callGeminiJSON returns null for all of it — no
// API key, quota gone, network down, unparseable answer — so all four came
// out as advice to rephrase. She would rephrase, and rephrase, and it would
// never once send.
//
// helpers/gemini.js now records WHY. This file tests THAT — against the real
// module, with only the Google SDK replaced.
//
// It exists because two mutations survived tests/e2e-voice.js: the e2e stubs
// lastGeminiFailure() outright, so nothing there executes the classification
// below. An end-to-end test proves the pieces fit; it cannot prove a piece is
// right when the piece itself is the stub.

const path = require('path');
const fs = require('fs');
const os = require('os');
let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-gem-'));
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key-not-used';

// Replace ONLY the Google SDK. Everything in helpers/gemini.js — the retry
// loop, the JSON extraction, the classification under test — is the real
// thing, which is the entire point.
let behave = () => { throw new Error('not configured'); };
const sdkPath = require.resolve('@google/generative-ai');
require.cache[sdkPath] = {
    id: sdkPath, filename: sdkPath, loaded: true,
    exports: {
        GoogleGenerativeAI: class {
            getGenerativeModel() { return { generateContent: async (p) => behave(p) }; }
        },
    },
};

const g = require(path.join(ROOT, 'helpers/gemini.js'));
const ok = (text) => ({ response: { text: () => text } });

(async () => {

console.log('\n─ why the model did not answer ──────────────────────────────');

section('A — each kind of failure is named');
{
    // The four ways callGeminiJSON comes back null. Before this they were
    // indistinguishable to every caller, which is why one message covered
    // all of them and lied about three.
    for (const [name, thrown, want] of [
        ['no API key',        '401 API key not valid',            'auth'],
        ['forbidden',         '403 permission denied',            'auth'],
        ['quota exhausted',   '429 Too Many Requests',            'quota'],
        ['rate limited',      'rate limit exceeded',              'quota'],
        ['network down',      'ECONNREFUSED',                     'unreachable'],
        ['timeout',           'ETIMEDOUT socket hang up',         'unreachable'],
    ]) {
        behave = () => { throw new Error(thrown); };
        const out = await g.callGeminiJSON('x', 0);
        ck(`${name} → ${want}`, out === null && g.lastGeminiFailure() === want,
           `returned ${JSON.stringify(out)}, reason ${JSON.stringify(g.lastGeminiFailure())}`);
    }

    // THE FOURTH, and the one that is genuinely about the request: the model
    // answered, with something that is not usable. This is the ONLY case
    // where asking her to say what she wants is sensible advice.
    behave = () => ok('this is not json at all');
    const junk = await g.callGeminiJSON('x', 0);
    ck('an unparseable answer → unusable',
       junk === null && g.lastGeminiFailure() === 'unusable',
       String(g.lastGeminiFailure()));

    // And it must not be left over from the call before. A stale reason is
    // worse than none: it would explain THIS failure with LAST time's cause.
    behave = () => ok('{"a":1}');
    const good = await g.callGeminiJSON('x', 0);
    ck('a successful call clears the reason',
       good && good.a === 1 && g.lastGeminiFailure() === null,
       JSON.stringify(good) + ' / ' + String(g.lastGeminiFailure()));

    behave = () => { throw new Error('ECONNREFUSED'); };
    await g.callGeminiJSON('x', 0);
    behave = () => ok('{"b":2}');
    await g.callGeminiJSON('x', 0);
    ck('  even after a failure immediately before it',
       g.lastGeminiFailure() === null, String(g.lastGeminiFailure()));
}

section('B — and the message the caller builds from it');
{
    // Read out of actions.js rather than executed: draftFailureMessage is a
    // module-private helper, and exporting a function purely so a test can
    // reach it would be shaping the code around the test. What matters is
    // that each branch exists, is distinct, and that only ONE of them talks
    // about her wording.
    // COMMENTS STRIPPED. The helper's own header quotes the old sentence in
    // order to explain why it was wrong, and the first version of the two
    // assertions below matched that quotation and failed against correct
    // code. tests/forward-flow.js learned the same lesson: a source check
    // that reads prose is checking the wrong thing, and the failures it
    // produces teach people to ignore it.
    const raw = fs.readFileSync(path.join(ROOT, 'workflow/actions.js'), 'utf8');
    const src = raw.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    const fn = src.slice(src.indexOf('function draftFailureMessage'),
                         src.indexOf('// ── Pending action helpers'));
    ck('the helper exists', fn.length > 200);
    ck('  auth says the key is the problem', /key is missing or rejected/.test(fn));
    ck('  quota says the quota is', /quota is used up/.test(fn));
    ck('  unreachable says it could not reach the model', /couldn.t reach the AI/i.test(fn));
    ck('  and each of those says it is NOT her wording',
       (fn.match(/not your wording|nothing you say will get round it|send it yourself/g) || []).length >= 2,
       'the whole failure was telling her to fix something she cannot');

    // THE ONE THAT MATTERS. "Rephrase" is only honest advice when the model
    // actually answered and the answer was unusable.
    ck('only the UNUSABLE branch asks her for the wording',
       /tell me what it should say/.test(fn)
       && !/rephrasing/.test(fn),
       'three of the four failures have nothing to do with what she said');

    // All three call sites go through it — the message was duplicated in
    // three places, which is how two of them would have been left behind.
    ck('all three draft paths use it',
       (src.match(/draftFailureMessage\(/g) || []).length >= 4,
       'one definition, three call sites, plus the definition itself');
    ck('  and the old blaming sentence is gone from every one',
       !/try rephrasing what it should say/.test(src),
       'a message that survives in one path is a message she will still hit');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})();
