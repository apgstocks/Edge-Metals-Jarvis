// ── tests/follow-ups.js ───────────────────────────────────────────────────
// Apsara, 2026-09-24, shown "How much did we owe Fede? — The total amount owed
// to Fede is $11,426.50": "I told you that follow up questions need to be
// thrown for business. Check research papers on chat bots".
//
// The literature on follow-up generation says two things that this file pins:
//   - KNOWLEDGE-DRIVEN beats templated: questions built from what is actually
//     known are more informative and coherent than ones generated from the
//     user's wording alone. So section B proves a question is only offered
//     when the data returned could answer it.
//   - They exist to RESOLVE and EXTEND, not to fill silence. Section D proves
//     nothing vague is ever offered.
//
// And the warning already recorded in this codebase — an offer that stages a
// pending "would make every answer a question she has to dismiss" — is pinned
// in section E: these are text and chips, and nothing behind them acts.

const path = require('path');
const ROOT = path.join(__dirname, '..');
const { followUps, MAX } = require(path.join(ROOT, 'helpers/data/followUps'));

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

// Her real question, and the answer that prompted this.
const FEDE = { tables: ['bills'], columns: ['supplier', 'owed', 'bills'],
               rows: [{ supplier: 'Fede', owed: 11426.5, bills: 3 }], shape: 'single' };

section('A — her own example gets business follow-ups');
{
    const f = followUps('how much did we owe Fede', FEDE);
    ck('it offers something', f.length > 0, JSON.stringify(f));
    ck(`no more than ${MAX}`, f.length <= MAX, String(f.length));
    ck('every one is a question', f.every((q) => q.trim().endsWith('?')), JSON.stringify(f));
    // The point of knowledge-driven: it can NAME the supplier, because the
    // supplier was in the rows. A templated follow-up could not.
    ck('they name Fede, because the answer did', f.every((q) => /Fede/.test(q)), JSON.stringify(f));
    ck('  one of them is the breakdown she would ask for next',
        f.some((q) => /which containers/i.test(q)), JSON.stringify(f));
    ck('  and one is about age, which a single total hides',
        f.some((q) => /oldest/i.test(q)), JSON.stringify(f));
}

section('B — only questions the data could answer');
{
    // No supplier column -> it must not invent a name to ask about.
    const noParty = followUps('how much do we owe', {
        tables: ['bills'], columns: ['owed'], rows: [{ owed: 500 }], shape: 'single' });
    ck('with no party named, nothing is attributed to one',
        noParty.every((q) => !/\bFede\b/.test(q)), JSON.stringify(noParty));
    ck('  but it still offers the breakdown', noParty.length > 0, JSON.stringify(noParty));

    // Already a list -> "which containers make it up" is answered on screen.
    const list = followUps('how much do we owe', {
        tables: ['bills'], columns: ['supplier', 'owed'],
        rows: [{ supplier: 'Fede', owed: 1 }, { supplier: 'Gomez', owed: 2 }], shape: 'list' });
    ck('a list is not asked to break itself down',
        !list.some((q) => /which containers make up/i.test(q)), JSON.stringify(list));

    // A container in the answer unlocks its own two questions.
    const cont = followUps('what did we bill on KOCU4930737', {
        tables: ['bills'], columns: ['container_no', 'amount'],
        rows: [{ container_no: 'KOCU4930737', amount: 100 }], shape: 'single' });
    ck('a named container is asked about by name',
        cont.some((q) => /KOCU4930737/.test(q)), JSON.stringify(cont));
    ck('  including its paperwork', cont.some((q) => /documents/i.test(q)));

    // Margin already in the answer -> do not offer to fetch margin again.
    const withMargin = followUps('what was the margin on KOCU4930737', {
        tables: ['margin'], columns: ['container_no', 'margin'],
        rows: [{ container_no: 'KOCU4930737', margin: 900 }], shape: 'single' });
    ck('margin is not offered when margin is what she just got',
        !withMargin.some((q) => /what was the margin on/i.test(q)), JSON.stringify(withMargin));
}

section('C — an empty answer asks about the question');
{
    // The clarifying case: nothing came back, so more of the same is useless.
    const none = followUps('how much do we owe Zzz', {
        tables: ['bills'], columns: ['supplier', 'owed'], rows: [], shape: 'single' });
    ck('it offers to widen the search', none.some((q) => /wider|at all/i.test(q)), JSON.stringify(none));
    ck('  and does NOT offer a breakdown of nothing',
        !none.some((q) => /which containers make up/i.test(q)), JSON.stringify(none));
}

section('D — nothing vague, ever');
{
    // "Would you like to know more?" costs her a decision and returns
    // nothing. Checked across every shape this thing produces.
    const cases = [FEDE,
        { tables: ['sales'], columns: ['customer', 'owed'], rows: [{ customer: 'MK Trading', owed: 5 }], shape: 'single' },
        { tables: ['margin'], columns: ['margin'], rows: [{ margin: 1 }], shape: 'single' },
        { tables: ['bills'], columns: ['owed'], rows: [], shape: 'single' }];
    const qs = ['how much do we owe Fede', 'how much does MK owe us', 'what was our margin', 'anything'];
    let vague = null;
    cases.forEach((c, i) => {
        for (const q of followUps(qs[i], c)) {
            if (/know more|anything else|more details|help you|would you like/i.test(q)) vague = q;
        }
    });
    ck('no "would you like to know more"', vague === null, vague || '');
}

section('E — they are offers, and nothing acts behind them');
{
    const fs = require('fs');
    const src = fs.readFileSync(path.join(ROOT, 'helpers/data/followUps.js'), 'utf8');
    for (const forbidden of ['setPending', 'addPayment', 'mutateJson', 'writeFileSync', 'sendEmail']) {
        ck(`  followUps never calls ${forbidden}`, !src.includes(forbidden));
    }
    // And the screen draws them as chips that ASK — they re-enter the normal
    // command path rather than doing anything themselves.
    const dash = fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8');
    ck('the command centre draws them as chips', /class="bot-chip"/.test(dash));
    ck('  and a chip asks the question rather than acting',
        /data-ask=/.test(dash) && /sendBotCommand\(\);/.test(dash));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) console.log('  failed: ' + failures.join(' | '));
process.exit(fail ? 1 : 0);
