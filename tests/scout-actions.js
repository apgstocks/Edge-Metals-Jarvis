// ── tests/scout-actions.js ────────────────────────────────────────────────
// Scout's hands: what she may do to the screen, and what she may not.
//
// Apsara, 2026-11-08: "There should be a scout AI to assist us with yard on
// the right side ... If i say show spend report for last three days.it
// should do that from any screen in edge yard." Then, on seeing the first
// design: "i dont want to restrict only to pedefined actions.let ai resolve
// that."
//
// So the model resolves what she meant. This file tests the part that is
// NOT the model: the seatbelt that checks the model's answer before it can
// move her, and the word-based fallback that still works when the model is
// unreachable. Neither of those may be left to a live model call — a test
// that needs the network is a test that goes red on a bad morning and gets
// ignored.

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-scout-'));
process.env.JARVIS_TEST = '1';

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label);
           if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const S = require(path.join(ROOT, 'helpers/scoutActions'));

// A FIXED today, so none of this is a time bomb. A suite that passes until
// the first of a month is a suite that fails on a morning nobody changed
// anything and gets believed about the wrong thing.
const TODAY = new Date('2026-11-08T12:00:00');

section('A — the seatbelt: what the model says is checked, not obeyed');
{
    ck('a screen that does not exist is refused outright',
       S.sanitise({ open: 'payroll', filters: { from: '2026-01-01' } }) === null,
       'a model naming a screen that is not there must do nothing, not something');

    const sneaky = S.sanitise({ open: 'spend', filters: {
        from: '2026-11-06', to: '2026-11-08', method: 'Cash', drop_tables: 'yes', role: 'admin' } });
    ck('a filter field that is not real is dropped',
       sneaky && !('drop_tables' in sneaky.filters) && !('role' in sneaky.filters),
       JSON.stringify(sneaky && sneaky.filters));
    ck('  while the real ones survive untouched',
       sneaky && sneaky.filters.from === '2026-11-06' && sneaky.filters.method === 'Cash',
       JSON.stringify(sneaky && sneaky.filters));

    ck('a company that is not one of hers is dropped',
       !('company' in (S.sanitise({ open: 'spend', filters: { company: 'acme-corp' } }) || {}).filters),
       'rule 5: there are two companies and inventing a third is not an answer');

    ck('nothing at all is refused safely',
       S.sanitise(null) === null && S.sanitise('spend') === null && S.sanitise({}) === null);
}

section('B — the fallback, for when the model cannot be reached');
{
    // The half of this feature that must not depend on a model being up.
    const a = S.actionFromWords('show spend report for last three days',
                                { today: TODAY, company: 'edge-trading' });
    ck('"show spend report for last three days" lands on the spend screen',
       a && a.open === 'spend', JSON.stringify(a));
    // THREE DAYS IS TODAY AND THE TWO BEFORE IT, which is what she means
    // standing in the yard on a Friday. Counting three back from today is
    // four days of rows and a figure that disagrees with her head.
    ck('  over today and the two days before it, not four days',
       a && a.filters.from === '2026-11-06' && a.filters.to === '2026-11-08',
       JSON.stringify(a && a.filters));
    ck('  and the company she is already looking at carries over',
       a && a.filters.company === 'edge-trading', JSON.stringify(a && a.filters));

    const q = S.actionFromWords('how much did we spend last week',
                                { today: TODAY, company: 'edge-trading' });
    ck('A QUESTION DOES NOT MOVE HER OFF THE SCREEN SHE IS ON',
       q === null,
       'yanking the screen away from someone who asked for a number is the '
       + 'behaviour that makes an assistant something you switch off');

    const cash = S.actionFromWords('tell me how much cash i paid in last three days',
                                   { today: TODAY, company: 'edge-trading' });
    ck('  her own example is a question too, and is answered, not navigated',
       cash === null, JSON.stringify(cash));

    const metals = S.actionFromWords('show spend for edge metals this year', { today: TODAY, company: 'edge-trading' });
    ck('naming a company beats the one she is looking at',
       metals && metals.filters.company === 'edge-metals', JSON.stringify(metals && metals.filters));

    ck('nonsense asks for nothing',
       S.actionFromWords('show me the moon', { today: TODAY }) === null);
}

section('C — the date phrases, pinned to a fixed today');
{
    const w = (t) => JSON.stringify(S.resolveWindow(t, TODAY));
    ck('yesterday', w('yesterday') === '{"from":"2026-11-07","to":"2026-11-07"}', w('yesterday'));
    ck('this month', w('this month') === '{"from":"2026-11-01","to":"2026-11-08"}', w('this month'));
    ck('last month ends on the last day of it, not on today',
       w('last month') === '{"from":"2026-10-01","to":"2026-10-31"}', w('last month'));
    ck('this year', w('this year') === '{"from":"2026-01-01","to":"2026-11-08"}', w('this year'));
    ck('all time means no window, not a huge one',
       w('all time') === '{"from":"","to":""}', w('all time'));
    ck('a phrase it does not know returns nothing rather than guessing',
       S.resolveWindow('around the time of the storm', TODAY) === null,
       'opening the right screen on invented dates looks like an answer');
    ck('digits work as well as words',
       w('last 3 days') === w('last three days'), w('last 3 days'));
}

section('D — THE DRIFT GUARD: every screen Scout names must really exist');
{
    // The failure this file exists to prevent, and the one that cost a day
    // this morning: two places holding the same fact and only one of them
    // being updated. Scout may name a screen; loadTab() is what opens one.
    // If someone renames a tab, this goes red instead of Scout silently
    // doing nothing when she asks for it.
    const core = fs.readFileSync(path.join(ROOT, 'dashboard/app/01-core.js'), 'utf8');
    for (const [key, s] of Object.entries(S.SCREENS)) {
        ck(`loadTab really handles "${s.tab}" (${key})`,
           new RegExp(`tab === '${s.tab.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}'`).test(core),
           `Scout can ask for ${s.tab} and the client would not know what that is`);
    }
}

section('E — the prompt the model is given is built from the same lists');
{
    const p = S.promptFor();
    for (const s of Object.values(S.SCREENS)) {
        ck(`  the model is told about "${s.tab}"`, p.includes(`"${s.tab}"`), p.slice(0, 120));
    }
    for (const k of S.FILTER_KEYS) {
        ck(`  and about the ${k} filter`, p.includes(k));
    }
    ck('  and is told plainly that a question is not a request to be shown',
       /QUESTION IS NOT A REQUEST TO BE SHOWN/i.test(p),
       'her own example — how much cash did I pay — must be answered where she stands');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\nFailures:'); failures.forEach((f) => console.log('  - ' + f)); }
try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
