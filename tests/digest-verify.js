// ── tests/digest-verify.js ──────────────────────────────────────────────────
// Apsara asked for "loop engineering". helpers/digestVerify.js is the loop:
// Jarvis reads its own message before sending it.
//
// EVERY CHECK BELOW IS A MESSAGE SHE ACTUALLY RECEIVED AND HAD TO CORRECT.
// The fixtures are her own words, pasted from the transcript, because the one
// thing this month has established is that my invented examples are worth
// less than her inbox.
//
// Each check is tested TWICE, and the second half is the one that matters: a
// verifier that also rejects the legitimate lookalike would quietly eat real
// mail, which is the failure this whole month has been about.
const path = require('path');
const R = (p) => path.join(__dirname, '..', p);
const { verifyDigest, itemLines } = require(R('helpers/digestVerify.js'));
const rw = require(R('workflow/replyWatch.js'));

let pass = 0, fail = 0;
const failures = [];
function ck(name, cond, detail) {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

const SILENT = { log: { warn() {} } };
const render = (items) => rw.buildDigest(items, items.length);
const item = (o) => ({ fromName: 'Kristal Sosethan', subject: 'Re: booking',
    needs_reply: true, waiting_on: 'her', confidence: 1, urgency: 'normal',
    summary: 'Kristal needs the HBL confirmed for booking DALA26511200.', ...o });
const run = (items) => verifyDigest(items, render, SILENT);
const checks = (r) => r.failures.map((f) => f.check);

section('DA — a clean digest is passed through untouched');
{
    const r = run([item(), item({ fromName: 'Tiffany', summary: 'Tiffany offers Friday 9/11 at 8 AM for the appointment.' })]);
    ck('DA1 nothing is dropped', r.dropped.length === 0, JSON.stringify(checks(r)));
    ck('DA2 no failures reported', r.failures.length === 0, JSON.stringify(r.failures));
    ck('DA3 ok', r.ok === true);
    ck('DA4 the text is the rendered digest', /Kristal needs the HBL/.test(r.text));
}

section('DB — a relative word in a STORED summary');
{
    // LIVE: "tomorrow tomorrow — confirmation of calculations".
    // A summary is written when the mail arrives and re-rendered for days.
    // "tomorrow" in it means a different day every time it is read.
    const r = run([item(), item({ summary: 'Confirm the appointment tomorrow morning.' })]);
    ck('DB1 the item is held back', r.dropped.length === 1, JSON.stringify(checks(r)));
    ck('DB2 by name', checks(r).includes('relative-date-in-summary'), JSON.stringify(checks(r)));
    ck('DB3 the other item still goes out', /Kristal needs the HBL/.test(r.text));
    // RE-RENDERED, not string-edited: "ignore 1" resolves against the item
    // array, so cutting a line out of the text would leave the numbers
    // pointing at different mail — the exact bug class this file guards.
    const nums = [...r.text.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    ck('DB4 numbering is re-rendered contiguous, not left with a gap',
        JSON.stringify(nums) === '[1]', JSON.stringify(nums));
    ck('DB5 and the caller is handed the surviving items', r.items.length === 1);

    // THE HALF THAT MATTERS. The digest legitimately ADDS "(today)" and
    // "(tomorrow)" as a computed suffix from daysToDeadline. That is correct
    // — it is recomputed on every render — and must not be mistaken for a
    // stale summary.
    const legit = run([item({ deadline: '9/18', daysToDeadline: 1,
        summary: 'Kristal needs the booking confirmed by 9/18.' })]);
    ck('DB6 the COMPUTED "(tomorrow)" suffix is not a defect',
        legit.dropped.length === 0 && /tomorrow/i.test(legit.text),
        JSON.stringify({ dropped: legit.dropped.length, text: legit.text.slice(0, 160) }));
}

section('DC — the same relative word twice in one item');
{
    // LIVE: "TOMORROW (after tomorrow morning) — release timing for shipment".
    // Apsara: "What is this?" The label is computed, the parenthetical is the
    // sender's words, and when both say tomorrow one of them is wrong.
    const r = run([item({ summary: 'Release timing for shipment tomorrow (after tomorrow morning).' })]);
    ck('DC1 a doubled relative word is caught',
        r.dropped.length === 1 && checks(r).some((c) => c === 'relative-date-in-summary' || c === 'deadline-word-doubled'),
        JSON.stringify(checks(r)));
    // One occurrence is normal and must pass.
    const once = run([item({ deadline: '9/18', daysToDeadline: 1,
        summary: 'Kristal needs the rate confirmed by 9/18.' })]);
    ck('DC2 a single occurrence is fine', once.dropped.length === 0, JSON.stringify(checks(once)));
}

section('DD — a deadline no real date can hold');
{
    // LIVE, found 2026-09-17: parseDeadline read "September 17" as the YEAR
    // 2001, so daysUntilDeadline returned -9131 and the digest would have
    // printed "OVERDUE by 9131d". The parser is fixed; this is the net under
    // it, because the next parser bug will not announce itself either.
    const r = run([item({ deadline: 'September 17', daysToDeadline: -9131 })]);
    ck('DD1 a 9131-day deadline is a parse failure, not a deadline',
        checks(r).includes('absurd-deadline'), JSON.stringify(checks(r)));
    ck('DD2 and the item is held back', r.dropped.length === 1);
    // Genuinely overdue mail is real and must reach her. A fortnight late is
    // ordinary in this business.
    const real = run([item({ deadline: '9/4', daysToDeadline: -14 })]);
    ck('DD3 a genuinely overdue item still goes out',
        real.dropped.length === 0, JSON.stringify(checks(real)));
}

section('DE — an item that contradicts itself');
{
    // LIVE: "Rajkumar sends a draft Bill of Lading for your review /
    //        → Review and approve / (you are only copied in)"
    // Apsara: "If its not pointing to any of edgemetals worker, why is it
    // showing?" Either it is hers or it is not; that line said both.
    const r = run([item({ waiting_on: 'someone_else', needs_reply: false,
        asked_of: 'Accounting Edge', asked_for: 'approval',
        action_needed: 'Review and approve the draft Bill of Lading',
        summary: 'Rajkumar sends a draft Bill of Lading for your review.' })]);
    ck('DE1 asking her to act while saying it is not hers is caught',
        checks(r).includes('contradicts-itself'), JSON.stringify(checks(r)));
    // A colleague item with no action arrow is NOT a contradiction — it is
    // the honest "your team is handling this".
    const team = run([item({ waiting_on: 'colleague', needs_reply: false,
        asked_of: 'Accounting Edge', asked_for: 'the booking confirmation',
        action_needed: null,
        summary: 'Kristal asked Accounting Edge for the updated booking confirmation.' })]);
    ck('DE2 "your team, not you" on its own is not a contradiction',
        team.dropped.length === 0, JSON.stringify(checks(team)));
}

section('DF — values that leaked into the text');
{
    // LIVE: 'Apsara: "Ignore 1" / Jarv: "I don\'t have a #undefined from a
    // recent digest."' Also the literal "undefined" that URGENCY_MARK once
    // printed for an unknown urgency.
    //
    // A MESSAGE-level check: dropping an item cannot fix a headline, so it is
    // REPORTED and the text still returned. Reporting a flawed digest beats
    // swallowing a real one.
    const leaked = verifyDigest([item()], () => 'undefined emails waiting on you:\n\n1. · *x*\n   Kristal\n', SILENT);
    ck('DF1 a literal "undefined" is reported',
        checks(leaked).includes('leaked-value'), JSON.stringify(checks(leaked)));
    ck('DF2 ok is false — nobody repaired it', leaked.ok === false);
    ck('DF3 but the text is still handed back, not swallowed',
        leaked.text.length > 0 && leaked.items.length === 1);
    // "null" inside a word or a sentence must not trip it.
    const fine = verifyDigest([item()], () => '1 email waiting on you:\n\n1. · *Annulled booking confirmed*\n   Kristal\n', SILENT);
    ck('DF4 "Annulled" is not a leaked null', checks(fine).length === 0, JSON.stringify(checks(fine)));
}

section('DG — the number she types must mean what it shows');
{
    // LIVE: "ignore 1" -> "#undefined". The number is the only handle she has
    // on an item, and a gap in the sequence points it at the wrong mail.
    const broken = verifyDigest([item(), item()],
        () => '2 emails waiting on you:\n\n1. · *first*\n   A\n\n3. · *third*\n   B\n', SILENT);
    ck('DG1 a gap in the numbering is reported',
        checks(broken).includes('numbering-broken'), JSON.stringify(checks(broken)));
    const ok = verifyDigest([item(), item()],
        () => '2 emails waiting on you:\n\n1. · *first*\n   A\n\n2. · *second*\n   B\n', SILENT);
    ck('DG2 a contiguous list passes', checks(ok).length === 0, JSON.stringify(checks(ok)));
}

section('DH — the headline must not claim fewer than it lists');
{
    const under = verifyDigest([item(), item()],
        () => '1 email waiting on you:\n\n1. · *a*\n   A\n\n2. · *b*\n   B\n', SILENT);
    ck('DH1 a headline smaller than the list is reported',
        checks(under).includes('count-disagrees-with-list'), JSON.stringify(checks(under)));
    // The headline counts EMAILS and the list shows MATTERS, so grouping
    // legitimately makes the first bigger — that is what "(+2 more on this)"
    // is for, and it must not be flagged.
    const grouped = verifyDigest([item()],
        () => '3 emails waiting on you:\n\n1. · *a*\n   A\n   (+2 more on this, same sender)\n', SILENT);
    ck('DH2 a bigger headline is legitimate grouping, not a defect',
        checks(grouped).length === 0, JSON.stringify(checks(grouped)));
}

section('DI — the loop terminates, whatever it is given');
{
    // A verifier that can loop is worse than no verifier: it would hang the
    // scan. Bounded by the list length, so the worst case is every item
    // dropped and an empty digest reported.
    const allBad = run([item({ summary: 'tomorrow' }), item({ summary: 'tomorrow' }), item({ summary: 'tomorrow' })]);
    ck('DI1 every item can be dropped without hanging',
        allBad.dropped.length === 3 && allBad.items.length === 0,
        JSON.stringify({ dropped: allBad.dropped.length, left: allBad.items.length }));
    ck('DI2 an empty list is handled', run([]).dropped.length === 0);
    ck('DI3 a render that throws is not this module\'s problem to hide',
        (() => { try { verifyDigest([item()], () => { throw new Error('boom'); }, SILENT); return false; }
                 catch (e) { return e.message === 'boom'; } })());
}

section('DJ — itemLines attributes lines to the right item');
{
    const text = '2 emails waiting on you:\n\n1. · *first*\n   Alpha\n\n2. · *second*\n   Beta\n\nSay "reply to 1".\n';
    const lines = itemLines(text, 2);
    ck('DJ1 each item gets its own lines',
        lines[0].join(' ').includes('Alpha') && lines[1].join(' ').includes('Beta'), JSON.stringify(lines));
    ck('DJ2 the footer belongs to nobody',
        !lines.some((l) => l.join(' ').includes('reply to 1')), JSON.stringify(lines));
    ck('DJ3 the headline belongs to nobody',
        !lines.some((l) => l.join(' ').includes('waiting on you')), JSON.stringify(lines));
}

console.log(`\n================================================================`);
console.log(`${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILED:'); failures.forEach((f) => console.log(`  - ${f}`)); }
process.exit(fail ? 1 : 0);
