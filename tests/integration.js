// END-TO-END INTEGRATION TEST — run: node tests/integration.js
//
// Read-only. Runs anywhere, needs no API key and no writable data/ directory.
// Exercises the REAL deployed modules, not copies.
//
// Built 2026-08-22 covering everything added that day: the pending arbiter,
// spacing-tolerant name matching, and the three new MIT dependencies
// (chrono-node, zod, fastest-levenshtein).
//
// The DEGRADED MODE section is the one people skip and shouldn't. All three
// new packages are loaded defensively, so that a restart before `npm install`
// falls back to the previous behaviour instead of crashing. That safety net
// is worth exactly nothing if nobody ever tests it — so it is tested here,
// by forcing the requires to fail and re-running the same assertions.

const assert = require('assert');
const Module = require('module');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function ck(label, got, want) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) { pass++; console.log(`  PASS  ${label}`); }
    else { fail++; failures.push(label); console.log(`  FAIL  ${label}\n          got:  ${JSON.stringify(got)}\n          want: ${JSON.stringify(want)}`); }
}
function ckTrue(label, cond, note) {
    if (cond) { pass++; console.log(`  PASS  ${label}`); }
    else { fail++; failures.push(label); console.log(`  FAIL  ${label}${note ? '  — ' + note : ''}`); }
}
const section = (t) => console.log(`\n=== ${t} ===`);

const R = (p) => path.join(__dirname, '..', p);

(async () => {

// ─────────────────────────────────────────────────────────────────────────
section('Name matching — "mkmetaltrading" vs "MK Metal Trading"');
// The bug: every roster compared lowercased but NOT space-stripped strings,
// so the two spellings of one real company never matched, in either
// direction. Apsara, 2026-08-22: "But it is mk metal trading only."
{
    const { normalizeName, findByNormalizedName, findByNormalizedAlias } = require(R('helpers/nameMatch'));
    ck('normalize spaced',      normalizeName('MK Metal Trading'), 'mkmetaltrading');
    ck('normalize compressed',  normalizeName('mkmetaltrading'),   'mkmetaltrading');
    ck('normalize punctuated',  normalizeName('M.K. Metal-Trading'), 'mkmetaltrading');
    ck('normalize empty',       normalizeName(''), '');
    ck('normalize null',        normalizeName(null), '');

    const roster = [{ name: 'MK Metal Trading' }, { name: 'NTG' }, { name: 'Eccomelt' }];
    ck('compressed query finds spaced record',
        findByNormalizedName(roster, 'mkmetaltrading').map(r => r.name), ['MK Metal Trading']);
    ck('spaced query finds compressed record',
        findByNormalizedName([{ name: 'MKMetalTrading' }], 'mk metal trading').map(r => r.name), ['MKMetalTrading']);

    // Safety: normalization is exact matching minus formatting noise. It must
    // never behave like fuzzy matching — a near-miss here would send a real
    // quote request to the wrong company.
    ck('does NOT match a longer name', findByNormalizedName([{ name: 'NTG Freight' }], 'NTG').map(r => r.name), []);
    ck('empty query matches nothing',  findByNormalizedName(roster, '').map(r => r.name), []);
    ck('punctuation-only matches nothing', findByNormalizedName(roster, '...').map(r => r.name), []);
    ck('null roster is safe',          findByNormalizedName(null, 'ntg'), []);
    ck('alias compressed',  findByNormalizedAlias([{ aliases: ['MK Metal Trading'] }], 'mkmetaltrading').length, 1);
    ck('alias spaced',      findByNormalizedAlias([{ aliases: ['Junk Car'] }], 'junkcar').length, 1);
}

// ─────────────────────────────────────────────────────────────────────────
section('Date parsing — existing patterns must be untouched');
{
    const { parseNaturalTime } = require(R('helpers/time'));
    const ok = (t) => parseNaturalTime(t) instanceof Date;
    for (const t of ['in 30 minutes', 'in 2 hours', 'tomorrow at 7am', 'today at 3pm',
                     'next monday at 9am', 'monday', '7am', '7am LA time', '7 pm PST'])
        ckTrue(`still parses: "${t}"`, ok(t));
}

section('Date parsing — chrono fallback adds new phrasings');
{
    const { parseNaturalTime } = require(R('helpers/time'));
    const ok = (t) => parseNaturalTime(t) instanceof Date;
    // "@7am" is the canonical live bug: every hand-rolled pattern recognized
    // the WORD "at" and none recognized the "@" she actually types.
    for (const t of ['@7am', 'in 3 weeks', '2 days from now', 'Sept 3 at 10am'])
        ckTrue(`now parses: "${t}"`, ok(t));
}

section('Date parsing — silently-wrong dates must be REJECTED');
{
    const { parseNaturalTime } = require(R('helpers/time'));
    // chrono ALWAYS returns a complete date; when it cannot resolve a
    // component it fills in the reference date's value and flags it
    // uncertain. Both of these drop a day-of-month she explicitly stated.
    // Scheduling a freight email for the wrong day is far worse than
    // admitting the phrase was unparseable — a null just means she gets
    // asked. Both of these DID slip through on the first implementation.
    ck('"on the 15th at 2pm" rejected (would silently mean today)',
        require(R('helpers/time')).parseNaturalTime('on the 15th at 2pm'), null);
    ck('"next month on the 3rd" rejected (would silently keep today\'s day)',
        parseNaturalTime('next month on the 3rd'), null);
    for (const t of ['', 'asdfghjkl', 'the cargo is aluminium', 'DALA23991600'])
        ck(`garbage stays null: ${JSON.stringify(t)}`, parseNaturalTime(t), null);
}

// ─────────────────────────────────────────────────────────────────────────
section('Levenshtein — library must be an exact drop-in');
{
    // Only a true drop-in because both compute standard unit-cost Levenshtein.
    // A library computing a different metric (Damerau, or a normalized 0..1
    // similarity) would silently change which typos get corrected.
    let fast = null;
    try { fast = require('fastest-levenshtein').distance; } catch (e) { /* degraded */ }
    if (!fast) { console.log('  SKIP  fastest-levenshtein not installed'); }
    else {
        const slow = (a, b) => {
            const m = a.length, n = b.length;
            const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
            for (let i = 0; i <= m; i++) dp[i][0] = i;
            for (let j = 0; j <= n; j++) dp[0][j] = j;
            for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
                dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
            return dp[m][n];
        };
        const KW = ['booking', 'bookings', 'available', 'unassigned', 'assigned', 'forward', 'assign',
                    'recall', 'archive', 'status', 'urgent', 'menu', 'truckers', 'suppliers', 'contacts'];
        let mismatches = 0, compared = 0;
        for (const a of KW) for (const b of KW) { compared++; if (fast(a, b) !== slow(a, b)) mismatches++; }
        const chars = 'abcdefgh';
        for (let i = 0; i < 5000; i++) {
            const r = () => Array.from({ length: 1 + Math.floor(Math.random() * 9) }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
            const a = r(), b = r(); compared++;
            if (fast(a, b) !== slow(a, b)) mismatches++;
        }
        ck(`identical to built-in across ${compared} pairs`, mismatches, 0);
    }
}

// ─────────────────────────────────────────────────────────────────────────
section('Pending arbiter — verdict handling and fail-safe posture');
{
    // Mock Gemini so every branch is reachable without an API key. Verdict
    // QUALITY against the real model is a separate concern — see
    // tests/arbiter-live.js.
    const orig = Module._load;
    let RESPONSE = null, THROW = false, CALLS = 0;
    Module._load = function (r) {
        if (r.endsWith('helpers/gemini') || r === './gemini') {
            return { callGeminiJSON: async () => { CALLS++; if (THROW) throw new Error('gemini down'); return RESPONSE; } };
        }
        return orig.apply(this, arguments);
    };
    delete require.cache[require.resolve(R('helpers/pendingArbiter'))];
    const { classifyAgainstPending, MIN_CONFIDENCE } = require(R('helpers/pendingArbiter'));
    const Q = '(Still waiting on cargo details — what is the cargo? Description, weight, and value.)';

    RESPONSE = { verdict: 'NEW_REQUEST', confidence: 0.95, reasoning: 'asks about bookings' };
    ck('high-confidence NEW_REQUEST honoured', await classifyAgainstPending('Do we have any booking available for Houston?', Q), 'NEW_REQUEST');

    // The asymmetry that makes this safe: NEW_REQUEST is the only verdict
    // that changes behaviour, so it alone must clear the confidence bar.
    RESPONSE = { verdict: 'NEW_REQUEST', confidence: 0.6 };
    ck(`NEW_REQUEST below ${MIN_CONFIDENCE} downgraded to UNCLEAR`, await classifyAgainstPending('Do we have any booking available for Houston?', Q), 'UNCLEAR');

    RESPONSE = { verdict: 'ANSWER', confidence: 0.9 };
    ck('ANSWER honoured', await classifyAgainstPending('Aluminium combo 40000 lbs value 5000', Q), 'ANSWER');

    // Every failure path must land on UNCLEAR, i.e. today's behaviour.
    RESPONSE = { verdict: 'nonsense' };
    ck('unknown verdict -> UNCLEAR', await classifyAgainstPending('a long enough message here', Q), 'UNCLEAR');
    RESPONSE = null;
    ck('null response -> UNCLEAR', await classifyAgainstPending('a long enough message here', Q), 'UNCLEAR');
    THROW = true;
    ck('thrown error -> UNCLEAR', await classifyAgainstPending('a long enough message here', Q), 'UNCLEAR');
    THROW = false;

    // Answer-shaped input must never cost a Gemini call — every pending's own
    // parser has already had first refusal at it.
    const before = CALLS;
    await classifyAgainstPending('1,3', Q);
    await classifyAgainstPending('yes', Q);
    await classifyAgainstPending('', Q);
    await classifyAgainstPending('a long enough message', null);
    ck('short/answer-shaped input costs 0 Gemini calls', CALLS - before, 0);

    Module._load = orig;
    delete require.cache[require.resolve(R('helpers/pendingArbiter'))];
}

// ─────────────────────────────────────────────────────────────────────────
section('Brain routing — traps, escapes, and core grammar');
{
    const orig = Module._load;
    Module._load = function (r) {
        if (r.endsWith('helpers/llm-intent')) return { extractManagerIntent: async () => ({ action: 'NEED_DATA' }), gate: () => 'ok', describeIntent: () => '' };
        if (r.endsWith('helpers/gemini')) return { callGeminiJSON: async () => null };
        return orig.apply(this, arguments);
    };
    delete require.cache[require.resolve(R('workflow/brain'))];
    const brain = require(R('workflow/brain'));
    const mk = (t, p) => ({ text: t, textLower: t.toLowerCase(), isManagerOrTeam: true, isTrucker: false,
                            isSupplier: false, pendingAction: p || null, session: {}, activeBooking: null });
    const D = (t, p) => { const d = brain.policyDecide(mk(t, p)); return d.needsAI ? '(needsAI)' : d.intent; };
    const FB = { type: 'await_fact_batch', candidates: ['a', 'b'] };
    const CARGO = { type: 'await_quote_cargo_details', originQuery: 'Junk car', destinationQuery: 'Eccomelt' };

    // The two live failures from 2026-08-22.
    ck('review open: booking question reaches real handling', D('Do we have any booking available for Houston?', FB), '(needsAI)');
    ck('review open: mail question reaches real handling',    D('check whether we received any mail from zimex recently', FB), '(needsAI)');
    // The review's own answers must still resolve it.
    ck('review: "1,3"',   D('1,3', FB), 'resolve_fact_batch');
    ck('review: "all"',   D('all', FB), 'resolve_fact_batch');
    ck('review: "no"',    D('no', FB), 'resolve_fact_batch');
    ck('review: "cancel"',D('cancel', FB), 'resolve_pending');

    // Verbatim-capture pendings hand off to the arbiter rather than assuming.
    ckTrue('cargo pending tags for arbitration', brain.policyDecide(mk('Do we have any booking available for Houston?', CARGO)).arbitrate === true);
    // ...except the relay, deliberately: a reply there is relayed verbatim to
    // whoever asked, so treating it as a new request would swallow a message
    // someone is waiting on.
    ckTrue('relay reply is NOT arbitrated', !brain.policyDecide(mk('Do we have any booking available for Houston?', { type: 'await_relay_reply' })).arbitrate);
    ckTrue('no pending means no arbitration', !brain.policyDecide(mk('some message', null)).arbitrate);

    // Escapes that predate the arbiter must still work.
    ck('cancel escapes any pending',      D('cancel', CARGO), 'resolve_pending');
    ck('fresh quote command jumps queue', D('Send quote request from Junk car to Eccomelt', CARGO), 'get_quote');

    // Core grammar regression — widening anything must not hijack these.
    for (const [t, w] of [['menu', 'show_menu'], ['available', 'show_bookings_available'],
        ['bookings from oakland', 'bookings_list_query'], ['get quote from LA to Houston', 'get_quote'],
        ['did zimex reply', 'search_mail'], ['check mail from zimex', 'search_mail'],
        ['email zimex about DALA123', 'draft_email'], ['reply to zimex about cutoff', 'reply_email'],
        ['price list', 'ask_pricelist_city'], ['urgent', 'show_bookings_urgent']])
        ck(`grammar: "${t}"`, D(t), w);

    Module._load = orig;
    delete require.cache[require.resolve(R('workflow/brain'))];
}

// ─────────────────────────────────────────────────────────────────────────
section('DEGRADED MODE — all three packages missing (forgotten npm install)');
{
    // Deploys here are a manual restart on a live ops system. If a restart
    // happens before `npm install`, a hard require would turn a forgotten
    // step into an outage. Every new dependency is therefore loaded
    // defensively — and this section proves that actually works, rather than
    // trusting a try/catch nobody has ever exercised.
    const orig = Module._load;
    const BLOCKED = ['chrono-node', 'zod', 'fastest-levenshtein'];
    Module._load = function (r) {
        if (BLOCKED.includes(r)) { const e = new Error(`Cannot find module '${r}'`); e.code = 'MODULE_NOT_FOUND'; throw e; }
        if (r.endsWith('helpers/llm-intent')) return { extractManagerIntent: async () => ({ action: 'NEED_DATA' }), gate: () => 'ok', describeIntent: () => '' };
        if (r.endsWith('helpers/gemini') || r === './gemini') return { callGeminiJSON: async () => null };
        return orig.apply(this, arguments);
    };
    for (const m of ['helpers/time', 'workflow/brain', 'helpers/pendingArbiter'])
        delete require.cache[require.resolve(R(m))];

    let loadedOK = true, err = null;
    try {
        const { parseNaturalTime } = require(R('helpers/time'));
        const brain = require(R('workflow/brain'));
        const { classifyAgainstPending } = require(R('helpers/pendingArbiter'));

        // Pre-existing date patterns must still work with no chrono.
        ckTrue('degraded: "tomorrow at 7am" still parses', parseNaturalTime('tomorrow at 7am') instanceof Date);
        ckTrue('degraded: "in 30 minutes" still parses',   parseNaturalTime('in 30 minutes') instanceof Date);
        // chrono-only phrasings simply go back to being unparseable — the
        // honest pre-existing behaviour, not a crash.
        ck('degraded: "@7am" back to unparseable', parseNaturalTime('@7am'), null);

        // Typo correction must still work on the built-in implementation.
        const mk = (t) => ({ text: t, textLower: t.toLowerCase(), isManagerOrTeam: true, isTrucker: false,
                             isSupplier: false, pendingAction: null, session: {}, activeBooking: null });
        ck('degraded: typo "avilable" still corrected', brain.policyDecide(mk('avilable')).intent, 'show_bookings_available');
        ck('degraded: "menu" still routes',             brain.policyDecide(mk('menu')).intent, 'show_menu');

        // Arbiter must still answer (falls back to hand-rolled shape checks).
        const v = await classifyAgainstPending('a long enough message here', '(some question)');
        ckTrue('degraded: arbiter still returns a valid verdict', ['ANSWER', 'NEW_REQUEST', 'UNCLEAR'].includes(v));
    } catch (e) { loadedOK = false; err = e; }
    ckTrue('degraded: nothing throws on load', loadedOK, err && err.message);

    Module._load = orig;
    for (const m of ['helpers/time', 'workflow/brain', 'helpers/pendingArbiter'])
        delete require.cache[require.resolve(R(m))];
}

// ─────────────────────────────────────────────────────────────────────────
console.log('\n========== SUMMARY ==========');
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  Failed:'); failures.forEach(f => console.log('   - ' + f)); }
process.exit(fail ? 1 : 0);

})().catch(e => { console.error('\nHARNESS CRASHED:', e); process.exit(1); });
