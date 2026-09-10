// ── tests/send-it-is-yes.js ───────────────────────────────────────────────
// Apsara reported it plainly: at "send this email to Yurim? yes/no", she
// says "send it" and gets "I couldn't pin that down".
//
// The cause is in workflow/brain.js Section A. YES is an EXACT-MATCH list
// (['yes','y','confirm','proceed','go ahead','do it','ok','okay','sure']), so
// "send it" matches nothing, falls past every rule in that section, and is
// reclassified by the AI as a brand-new email request — which finds the same
// pending still open. The identical failure shape as the "Schedule this mail"
// bug documented in that file, and helpers/draftIntent.js had ALREADY written
// the rule down ("send it to X" is her yes, not a change) without anything
// implementing it at the confirm.
//
// WHAT THIS FILE IS REALLY GUARDING, though, is the other half: "send it to
// <someone who is not the addressee>". draftIntent.js reads that as a yes,
// and at a PROFORMA confirm it plainly is — there is no recipient in play, so
// the name is the consignee. At an EMAIL confirm the draft already HAS a
// recipient, and silently reading it as a yes would put her mail in front of
// the wrong company. That is the exact failure draftIntent.js exists to
// prevent, so this asks instead.

const path = require('path');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

process.env.JARVIS_TEST = '1';
const ROOT = path.join(__dirname, '..');
const brain = require(path.join(ROOT, 'workflow/brain'));

// The pending as api.js stages it: a drafted mail waiting on yes or no.
const emailConfirm = (over = {}) => ({
    type: 'await_email_confirm',
    target_name: 'Yurim',
    to: 'yurim@wimax.co.kr',
    subject: 'Booking request',
    body: 'Need bookings from HOUSTON to BUSAN.',
    ...over,
});

const decide = (text, pending) => brain.policyDecide({
    isManagerOrTeam: true,
    pendingAction: pending || emailConfirm(),
    text,
    textLower: String(text).toLowerCase(),
    chatId: 'TEST',
    session: {},
});

section('A — "send it" is her yes');
{
    for (const said of [
        'send it', 'Send it', 'send', 'send it now', 'send that', 'send this',
        'please send it', 'just send it', 'ok send it', 'okay, send it',
        'go ahead and send it', 'send the mail', 'send the email', 'send it.',
    ]) {
        const d = decide(said);
        ck(`"${said}" resolves the pending`,
           d.intent === 'resolve_pending' && d.data.answer === 'yes',
           JSON.stringify({ intent: d.intent, data: d.data }));
    }
    ck('  and it is decided by POLICY, not sent to the AI to guess',
       decide('send it').resolvedBy === 'policy',
       'the AI is what turned this into a brand-new email request');
}

section('B — "send it to <the addressee>" is also her yes');
{
    for (const said of ['send it to Yurim', 'send to Yurim', 'send it to yurim',
                        'please send it to Yurim']) {
        const d = decide(said);
        ck(`"${said}" is a yes, because that IS who it is to`,
           d.intent === 'resolve_pending' && d.data.answer === 'yes',
           JSON.stringify(d.data));
    }
    ck('the address works as well as the name',
       decide('send it to yurim@wimax.co.kr').data.answer === 'yes');
    ck('  and so does the part before the @',
       decide('send it to yurim').data.answer === 'yes');
}

section('C — but "send it to SOMEBODY ELSE" is a question, not a send');
{
    const d = decide('send it to Daekwang');
    ck('naming a different company does NOT send the mail',
       d.intent !== 'resolve_pending',
       'silently redirecting is how the wrong company gets her mail');
    ck('  it asks instead', d.intent === 'reply', JSON.stringify(d));
    ck('  naming who the draft is actually addressed to',
       /Yurim/.test(d.data.reply), d.data.reply);
    ck('  and naming who she said',
       /Daekwang/.test(d.data.reply), d.data.reply);
    ck('  offering both ways out',
       /yes/.test(d.data.reply) && /no/.test(d.data.reply), d.data.reply);
}

section('D — and none of this leaks to other pendings');
{
    // The reason it is scoped rather than added to YES: "send mail to Yurim"
    // is a brand-new request everywhere else in this app, and a global
    // send-means-yes would answer whatever question happened to be open.
    const other = decide('send it', { type: 'await_name_confirm', heard: 'jeyshree', matches: [] });
    ck('"send it" at a NAME confirm is not a yes',
       !(other.intent === 'resolve_pending' && other.data && other.data.answer === 'yes'),
       JSON.stringify(other));
    const cc = decide('send it', { type: 'await_cc_pattern_confirm', target_name: 'Yurim', detected_cc: [] });
    ck('  nor at a cc-pattern confirm',
       !(cc.intent === 'resolve_pending' && cc.data && cc.data.answer === 'yes'),
       JSON.stringify(cc));

    // And the words that already worked must keep working.
    ck('plain "yes" still resolves it', decide('yes').data.answer === 'yes');
    ck('plain "no" still cancels it', decide('no').data.answer === 'no');

    // A real correction must still reach the correction branch rather than
    // being swallowed as a send.
    const sched = decide('schedule this at 7am LA time');
    ck('"schedule ..." is still a reschedule, not a send',
       sched.intent === 'reschedule_pending_email', JSON.stringify(sched));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
