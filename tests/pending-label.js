// ── tests/pending-label.js ────────────────────────────────────────────────
// Apsara, 2026-09-07, with a screenshot:
//
//   Couldn't find a past email from "Jayashree" — no address to send to, and
//   you already have a pending "await_fact_batch" to answer first.
//
// She should not have to know that string. It is the end-of-day review of what
// Jarvis learned that day, and twenty places in actions.js and scheduler.js
// interpolated the raw identifier into a sentence she reads.
//
// WHAT THIS FILE GUARDS, in order of how badly it fails:
//   1. describePending() is TOTAL — every type, including ones invented
//      tomorrow, comes back as English. This is the one that stops the bug
//      recurring, because the bug was a missing default, not a missing entry.
//   2. no call site interpolates blockedBy raw again
//   3. the labels themselves read like something a person would say
//
// A note on what is NOT asserted: that every pending type in the codebase has
// a hand-written label. There are ~70 and most can never be the ACTIVE pending
// that blocks another. Requiring all of them would make this file noise, and a
// noisy test gets deleted. The generic fallback is what carries the guarantee;
// section A proves the fallback, and section D reports coverage without
// failing on it.

const path = require('path');
const fs = require('fs');
let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const pl = require(path.join(ROOT, 'helpers/pendingLabel.js'));

console.log('\n─ pendings described in her words ───────────────────────────');

section('A — it is TOTAL, which is the actual guarantee');
{
    // HER EXACT CASE.
    ck('await_fact_batch is the end-of-day review',
       pl.describePending('await_fact_batch') === 'the end-of-day review of what I learned today',
       pl.describePending('await_fact_batch'));

    // THE FALLBACK — the missing piece that caused this. A type nobody has
    // mapped yet must still come back as English, not as itself.
    for (const unknown of ['await_something_invented_tomorrow', 'brand_new_type', 'x']) {
        const got = pl.describePending(unknown);
        ck(`an unmapped type does not leak: ${unknown}`,
           got === pl.GENERIC && !got.includes(unknown),
           got + ' — the bug was a missing DEFAULT, not a missing entry');
    }

    // Deliberately NOT de-snake-cased into a guess. "a fact batch" is not
    // better than "an earlier question"; it is the same leak with the
    // underscores taken out.
    ck('  and is not a de-snake-cased guess',
       !/fact batch|something invented tomorrow/.test(pl.describePending('await_fact_batch') + pl.describePending('await_something_invented_tomorrow')));

    // Total means total: nothing throws, nothing comes back empty.
    for (const junk of [null, undefined, '', '   ', 0, {}, []]) {
        let got; let threw = false;
        try { got = pl.describePending(junk); } catch (e) { threw = true; }
        ck(`  survives ${JSON.stringify(junk)}`, !threw && typeof got === 'string' && got.length > 3,
           threw ? 'THREW' : String(got));
    }
}

section('B — no label reads like a variable name');
{
    const bad = Object.entries(pl.LABELS).filter(([, v]) => pl.looksLikeIdentifier(v));
    ck('every label is English', bad.length === 0,
       bad.map(([k, v]) => `${k} → ${v}`).join('; '));
    ck('  including the generic', !pl.looksLikeIdentifier(pl.GENERIC), pl.GENERIC);

    // The detector has to actually detect, or the assertion above is vacuous.
    // A mutation making looksLikeIdentifier() always false left section B
    // green with the raw identifiers still in place.
    ck('  and the detector is not vacuous',
       pl.looksLikeIdentifier('await_fact_batch') === true
       && pl.looksLikeIdentifier('confirmProforma') === true
       && pl.looksLikeIdentifier('an earlier question') === false);

    // Labels are fragments, dropped mid-sentence after "you already have".
    // One starting with a capital or ending in a full stop reads as a splice.
    const shouty = Object.entries(pl.LABELS).filter(([, v]) => /^[A-Z]/.test(v) || /[.!?]$/.test(v));
    ck('  and each fits mid-sentence', shouty.length === 0,
       shouty.map(([k, v]) => `${k} → ${v}`).join('; '));
}

section('C — and no call site leaks the identifier again');
{
    for (const f of ['workflow/actions.js', 'scheduler.js']) {
        const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
        // The exact shape that shipped: the identifier in quotes, in a string
        // she reads.
        ck(`${f} never interpolates blockedBy raw`,
           !/["'`]?\$\{staged\.blockedBy\}/.test(src),
           'this is the shape from her screenshot');
        // ANY pending's .type, not just that one variable name. The first
        // sweep replaced every `staged.blockedBy` and walked straight past
        // `promoted.type` in the queue-promotion notice — same leak, different
        // spelling. Matching the SHAPE catches the next one too.
        //
        // CONSOLE LINES ARE STRIPPED FIRST, and that is not a loophole: a log
        // SHOULD carry the identifier, because a log is read by whoever is
        // debugging and the symbol is the useful part. The rule is about text
        // she reads. My first version scanned everything, flagged two
        // console.warn calls, and would have taught the next person to widen
        // the regex until it matched nothing.
        const spoken = src.split('\n').filter((l) => !/console\.(log|warn|error|info|debug)\(/.test(l)).join('\n');
        ck(`  ${f} never interpolates any pending .type into a message`,
           !/\$\{[a-zA-Z_$][\w$]*\.type\}/.test(spoken),
           (/.*\$\{[a-zA-Z_$][\w$]*\.type\}.*/.exec(spoken) || [''])[0].trim().slice(0, 120)
           + ' — a search for one spelling is not a search for the bug');
        ck(`  ${f} routes it through describePending`,
           /describePending\(staged\.blockedBy\)/.test(src));
        ck(`  ${f} imports it`,
           /require\((?:'|")[./]*helpers\/pendingLabel(?:'|")\)/.test(src),
           'a call with no import is a ReferenceError on a path that only runs '
           + 'when she already has a pending — invisible to a syntax check');
    }
}

section('D — coverage, reported not enforced');
{
    // Which pending types the code can actually create, and how many have a
    // hand-written label. Printed rather than asserted: a hard threshold here
    // would fail every time someone adds a type that can never block.
    const src = ['workflow/actions.js', 'scheduler.js', 'api.js', 'workflow/brain.js', 'helpers/dailyLearning.js']
        .map((f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (e) { return ''; } })
        .join('\n');
    const types = [...new Set([...src.matchAll(/type:\s*'([a-z][a-z0-9_]+)'/g)].map((m) => m[1]))];
    const mapped = types.filter((t) => pl.LABELS[t]);
    const blocking = types.filter((t) => /^(await_|confirm_|select_|wizard_)/.test(t));
    const unmappedBlocking = blocking.filter((t) => !pl.LABELS[t]);

    ck('the scan found the pending types', types.length > 20, String(types.length));
    console.log(`        ${mapped.length}/${types.length} types have a written label`);
    if (unmappedBlocking.length) {
        console.log('        blocking types still on the generic fallback:');
        unmappedBlocking.forEach((t) => console.log('          · ' + t));
    }
    // The one thing worth failing on: a type she has SEEN. If a label is ever
    // removed for one of these, the screenshot comes back.
    for (const seen of ['await_fact_batch', 'confirm_proforma', 'confirm_forward', 'await_email_confirm']) {
        ck(`  ${seen} keeps its written label`, !!pl.LABELS[seen]);
    }
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
