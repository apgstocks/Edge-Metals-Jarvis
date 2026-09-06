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

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
