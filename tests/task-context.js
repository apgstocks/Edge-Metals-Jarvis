// ── tests/task-context.js ─────────────────────────────────────────────────
// Apsara, 2026-09-07: "if proforma is being generated.. Say if i want to send
// a mail asking for something, then it should be linked to this context na..
// so check whether any research paper on this"
//
// THERE IS, AND IT IS FORTY YEARS OLD
// -----------------------------------
// Grosz & Sidner, "Attention, Intentions, and the Structure of Discourse"
// (Computational Linguistics 12(3), 1986). A conversation has three
// structures, and the one she is describing is the ATTENTIONAL STATE: a STACK
// of focus spaces holding what is salient right now. Beginning a sub-task
// PUSHES a focus space; it does not replace the one underneath, and the
// entities in the outer space stay reachable throughout the sub-dialogue.
//
// So while a proforma for Daekwang is being built, "send Yurim a mail asking
// for a booking" is not a new conversation. It is a segment pushed on top of
// one that already holds a buyer, a material, a quantity and a set of terms —
// and an assistant that cannot see them makes her say all four again.
//
// RavenClaw (Bohus & Rudnicky, Eurospeech 2003) is the same idea built for
// production: a dialog stack beside a task tree, sub-tasks pushed and popped,
// the parent still there underneath. This is one level of that, not the whole
// architecture, and the file says so rather than claiming more.
//
// WHAT THIS GUARDS, and the danger is real in both directions:
//   · the context must REACH the draft, or she repeats herself
//   · it must NOT become the subject, or an email about a trucker turns into
//     a covering note for a document nobody asked about
//   · a container count inherited from the proforma commits her to a CARRIER,
//     so it is said out loud and still passes through the yes/no gate

const path = require('path');
const fs = require('fs');
let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
process.env.DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

const ppP = require.resolve(path.join(ROOT, 'helpers/proformaPricing.js'));
require.cache[ppP] = { id: ppP, filename: ppP, loaded: true, exports: { lookup: () => ({}) } };
const d = require(path.join(ROOT, 'helpers/proformaDraft.js'));

console.log('\n─ a sub-task inherits the open one ──────────────────────────');

section('A — nothing open, nothing carried');
{
    d.clear();
    ck('no proforma means no context', d.contextLine() === null);
    ck('  and no container count to inherit', d.openContainerCount() === null);

    // A draft with NOTHING in it yet is not context either — "a proforma is
    // being drafted for undefined" helps nobody.
    d.clear();
    d.start('create a proforma');
    // Guarded with a try: a regression here throws on `p.items[0]` rather
    // than failing, and a throw prints no totals — the run looks broken
    // instead of one check looking wrong.
    let empty; try { empty = d.contextLine(); } catch (e) { empty = 'THREW: ' + e.message; }
    ck('  nor does an empty draft', empty === null, String(empty));
}

section('B — what the open proforma contributes');
{
    d.clear();
    d.start('create a proforma for Daekwang, 2 containers, 21 MT of auto cast at 8450, CIF Busan');
    const line = d.contextLine();
    ck('there is a context line', !!line, String(line));
    ck('  naming the buyer', /Daekwang/.test(line), line);
    ck('  the container count', /2 containers/.test(line), line);
    ck('  the material and tonnage', /21 MT of Auto cast/.test(line), line);
    ck('  the rate', /8450/.test(line), line);
    ck('  and the terms', /CIF BUSAN/.test(line), line);
    ck('  in one line, because it is prompt context not a report',
       line.length < 200 && !/\n/.test(line), line.length + ' chars');

    ck('the container count is available on its own', d.openContainerCount() === 2);
}

section('C — it is BACKGROUND, not the subject');
{
    // The danger in the other direction. An email about a trucker must not
    // become a covering note for a proforma nobody asked about, and the model
    // is told so in as many words rather than left to infer it.
    const acts = fs.readFileSync(path.join(ROOT, 'workflow/actions.js'), 'utf8');
    const block = acts.slice(acts.indexOf('let openTask ='), acts.indexOf('let recentContext ='));
    ck('the drafter is given the open proforma', /contextLine\(\)/.test(block));
    ck('  labelled CONTEXT ONLY', /CONTEXT ONLY/.test(block), block.slice(0, 200));
    ck('  and told it is not the subject',
       /NOT the subject/.test(block), block.slice(0, 300));
    ck('  and told not to attach or describe it',
       /must not describe or attach/.test(block));
    ck('  reaching the prompt, not just built',
       /\$\{openTask\}/.test(acts),
       'a variable assembled and never interpolated is the shape of half my bugs today');
    ck('  and a missing proforma is the normal case, not an error',
       /catch \(e\) \{ \/\* no proforma open is the normal case \*\/ \}/.test(acts));
}

section('D — the container count inherits, and says so');
{
    // Her exact case: a proforma for two containers is open, she asks for a
    // booking without naming a number.
    const acts = fs.readFileSync(path.join(ROOT, 'workflow/actions.js'), 'utf8');
    const seg = acts.slice(acts.indexOf('let inherited = false;'),
                           acts.indexOf('return draftEmailWithAddress(chatId, targetName, details, bkgNo, to, toSource, scheduledFor);'));

    ck('an unstated count falls back to the open proforma',
       /openContainerCount\(\)/.test(seg), seg.slice(0, 200));
    ck('  only when she did not say one',
       /if \(count == null\) \{[\s\S]{0,400}openContainerCount/.test(seg),
       'her own number must always win over an inherited one');

    // SAID OUT LOUD. This commits her to a carrier for a figure she did not
    // speak in this sentence.
    ck('  and it is said out loud when inherited',
       /Using \$\{count\} container/.test(seg),
       'a silent inheritance is a number she never agreed to, at a shipping line');
    // The FLAG BEING SET, not merely the `if (inherited)` block existing.
    // A mutation that took the count and never set the flag left the block
    // in place, the announcement unreachable, and this assertion green — the
    // silent inheritance I wrote it to prevent.
    ck('  never silently',
       /count = fromProforma; inherited = true;/.test(seg),
       'the flag has to be SET where the count is taken, not just tested later');

    // The existing gate is still what stops it. The inheritance is a
    // convenience on top of a confirmation, not a replacement for one.
    const res = acts.slice(acts.indexOf("pending.type === 'await_booking_details'"),
                           acts.indexOf("pending.type === 'confirm_proforma'"));
    ck('the yes/no gate before sending is untouched',
       /draftEmailWithAddress\(/.test(res) && !/sendEmail/.test(res),
       'inheritance without a confirmation would be guessing with consequences');
}

section('E — and the outer task survives the inner one');
{
    // Grosz & Sidner's point: a push does not replace. After the sub-dialogue
    // the proforma must still be there, or she has lost the thing she was
    // doing in order to do a smaller thing.
    d.clear();
    d.start('create a proforma for Daekwang, 2 containers, 21 MT of auto cast at 8450');
    const before = JSON.stringify(d.current().fields);

    // Nothing about drafting an email touches the proforma draft — asserted
    // by the module boundary rather than by running the mail flow, which
    // needs Gmail, Gemini and a live address book.
    const acts = fs.readFileSync(path.join(ROOT, 'workflow/actions.js'), 'utf8');
    ck('the mail flow never clears the proforma draft',
       !/proformaDraft'\)\.clear\(\)/.test(acts),
       'the outer task must outlive the inner one');
    ck('  it only reads from it',
       /proformaDraft'\)\.(?:contextLine|openContainerCount)\(\)/.test(acts));

    ck('and the draft is still intact', JSON.stringify(d.current().fields) === before);
    ck('  still with its two containers', d.openContainerCount() === 2);
}

section('F — putting it down and picking it up');
{
    // Apsara, 2026-09-07: "what if while creating a proforma-i want to send a
    // mail, can i just say lets hold this and work on email?"
    //
    // She could not. That exact sentence was fed to answer(), absorbed
    // nothing, and came back "What rate per metric ton?" — the assistant
    // carrying on with its question while she asked it to stop.
    //
    // This is the POP that Grosz & Sidner's focus stack implies and that the
    // previous change only did halfway: pushing a sub-task worked, but there
    // was no way to SAY the transition and close the space explicitly.
    d.clear(); d._clearParked();
    d.start('create a proforma for Daekwang, 21 MT of auto cast');

    const held = d.handle('lets hold this and work on email');
    ck('HER SENTENCE parks the draft', !!held && held.stage === 'parked',
       held ? held.stage : 'null — it was swallowed as an answer again');
    // `!!held &&` on every one: without it a regression makes handle() return
    // null, these THROW, node exits, and the run prints no totals — which
    // reads as a broken suite rather than a caught bug. Three mutations died
    // that way before I guarded them.
    ck('  and says what it is holding',
       !!held && /Daekwang/.test(held.say) && /Auto cast/.test(held.say), held && held.say);
    ck('  and how to get it back',
       !!held && /back to the proforma/i.test(held.say), held && held.say);
    ck('  the live draft is closed', d.current() === null,
       'leaving it open means the next sentence gets absorbed into it');
    ck('  but it is HELD, not thrown away', !!d.parkedDraft());

    // A HALF-BUILT DRAFT HAS NO PRICE. summary() was written for the preview
    // where every field is filled; parked mid-build it produced "$NaN per MT
    // — $NaN total" in the very sentence confirming her work was safe.
    ck('  and no NaN in the sentence', !!held && !/NaN/.test(held.say), held && held.say);

    // Nothing else touches it in between.
    ck('an ordinary sentence does not resurrect it',
       d.handle('do we have any bookings from Houston') === null);
    ck('  nor does an answer to something else', d.handle('two') === null);
    ck('  and it is still parked', !!d.parkedDraft());

    const back = d.handle('back to the proforma');
    ck('"back to the proforma" brings it back', !!back && back.resumed === true,
       back ? JSON.stringify(back.stage) : 'null');
    // `back.fields &&` too: with resume disabled, handle() returns the
    // ASKING stage, which carries `have` and not `fields` — so this threw
    // instead of failing and the run printed no totals at all.
    const bf = back && back.fields;
    ck('  with every field intact',
       !!bf && bf.consignee === 'Daekwang' && bf.material === 'Auto cast' && bf.mt === 21,
       JSON.stringify(bf));
    ck('  and it asks the question it was on', !!back && /rate/i.test(back.say), back && back.say);
    ck('  the held slot is now empty', d.parkedDraft() === null,
       'a draft in two places is a draft that can diverge');

    // ...and it carries on exactly where it was.
    d.answer('8450');
    ck('  and the answer lands on the resumed draft',
       !!d.current() && d.current().fields.rate === 8450,
       d.current() ? JSON.stringify(d.current().fields) : 'no draft open — resume did not restore it');
}

section('G — the ways she might say it, and what must not trigger');
{
    for (const t of [
        'lets hold this and work on email',
        'hold this for now',
        'park this',
        'pause this',
        'set this aside',
        'leave this for now',
        'come back to this later',
    ]) ck(`"${t}" parks`, d.isPark(t) === true);

    for (const t of [
        'back to the proforma',
        'resume the proforma',
        'carry on with the proforma',
        'finish the proforma',
        'where were we',
    ]) ck(`  "${t}" resumes`, d.isResume(t) === true);

    // WHAT MUST NOT. "hold on" is a hesitation mid-sentence, and parking a
    // document because she paused to think would be worse than the bug.
    for (const t of [
        'hold on',
        'wait',
        'hold on, make it 25 MT',
        'create a proforma for Daekwang',
        'send it to Yurim',
        'any bookings from Houston',
    ]) ck(`  "${t}" does not park`, d.isPark(t) === false);

    for (const t of [
        'yes', 'send it', 'two containers', 'what is the cutoff',
    ]) ck(`  "${t}" does not resume`, d.isResume(t) === false);
}

section('H — a parked draft does not outlive its usefulness');
{
    const src = fs.readFileSync(path.join(ROOT, 'helpers/proformaDraft.js'), 'utf8');
    ck('parking expires', /PARK_TTL_MS/.test(src) && d.PARK_TTL_MS === 2 * 60 * 60 * 1000,
       String(d.PARK_TTL_MS) + ' — a draft abandoned yesterday reappearing mid-sentence today is worse than losing it');
    ck('  and the expiry is checked on read, not by a timer',
       /Date\.now\(\) - parked\.at > PARK_TTL_MS/.test(src),
       'a timer would have to be cancelled on every other path');

    // A SECOND park would silently bin the first. Not losing work is the
    // entire reason parking exists, so it is said.
    ck('a second park says it replaces the first',
       /that replaces the one you parked earlier/.test(src));

    // The endpoint has to let it through even while the brain holds a
    // question, or "hold this" gets read as an answer to "Send it?".
    const api = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
    // Apsara, 2026-09-07: "it has to work dynamically." The two regexes are
    // now the offline net inside helpers/draftIntent.js; the decision itself
    // is the model's, so this reads the classifier call rather than the
    // patterns it fell back to.
    ck('parking reaches the draft even mid-confirm',
       /const parking = transition === 'park' \|\| transition === 'resume';/.test(api)
       && /answeringBrain && !amended && !parking/.test(api),
       'otherwise the AI classifier guesses at "hold this" with a yes/no open');
    ck('  and parking does not trip the staged-draft cleanup',
       /pro\.isStaged\(\) && !parking\) pro\.clear\(\)/.test(api),
       'binning the work she just asked to keep');
}

section('I — PARKED means the email does NOT inherit it');
{
    // Apsara, 2026-09-07, correcting my summary of my own code: "you do the
    // email — and it still inherits the proforma's context --> it should not
    // do that."
    //
    // She is right, and the two cases are genuinely different. The signal
    // distinguishing them is HER OWN WORDS:
    //
    //   proforma IN PROGRESS, she asks for a mail
    //       → a sub-task. Grosz & Sidner: the focus space is still open and
    //         its entities are still salient, so it inherits.
    //
    //   proforma PARKED — "lets hold this and work on email"
    //       → she has explicitly set it down. The focus space is POPPED. Its
    //         entities are no longer in the attentional state, and an email
    //         that quietly carried Daekwang's rate into a message about
    //         something else would be the assistant ignoring what she said.
    //
    // THE CODE ALREADY DID THIS — park() nulls the live draft and both
    // accessors read it — but nothing tested it, and my summary to her
    // claimed the opposite. A load-bearing distinction with no test is one
    // refactor away from being wrong, and "it happens to work" is not the
    // same as "it is guaranteed".
    d.clear(); d._clearParked();
    d.start('create a proforma for Daekwang, 2 containers, 21 MT of auto cast at 8450');

    ck('in progress, the context is available', !!d.contextLine());
    ck('  and so is the container count', d.openContainerCount() === 2);

    d.handle('lets hold this and work on email');

    ck('PARKED, the context is gone', d.contextLine() === null,
       String(d.contextLine()) + ' — she put it down; an email must not carry it');
    ck('  and so is the container count', d.openContainerCount() === null,
       'inheriting 2 containers into an unrelated booking request commits her to a carrier');
    ck('  but the draft itself is still safe', !!d.parkedDraft(),
       'popped from the focus space is not the same as thrown away');

    // AND IT COMES BACK when she resumes — the entities return to the
    // attentional state with the task.
    d.handle('back to the proforma');
    ck('resuming restores the context', !!d.contextLine());
    ck('  and the count', d.openContainerCount() === 2);

    // THE ACCESSORS READ THE LIVE DRAFT, NOT THE PARKED SLOT. This is the
    // line that would break it: a later "convenience" making contextLine()
    // fall back to `parked` would silently undo her instruction.
    const src = fs.readFileSync(path.join(ROOT, 'helpers/proformaDraft.js'), 'utf8');
    const ctx = src.slice(src.indexOf('function contextLine()'), src.indexOf('function openContainerCount()'));
    ck('contextLine never reads the parked slot',
       !/parked/.test(ctx),
       'falling back to a parked draft would leak a task she explicitly set down');
    const cnt = src.slice(src.indexOf('function openContainerCount()'),
                          src.indexOf('function openContainerCount()') + 400);
    ck('  nor does openContainerCount', !/parked/.test(cnt));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
