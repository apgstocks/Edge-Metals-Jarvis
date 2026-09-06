// ── tests/yard-ask-tools.js ───────────────────────────────────────────────
// Apsara, 2026-09-06: "When i ask jarvis what bookings that we have from
// houston, its saying that it doesnt have any idea about this. so test it
// end to end."
//
// THE BUG, AND WHY EVERY EXISTING TEST MISSED IT
// ----------------------------------------------
// helpers/tools.js declares seven read tools and exports runRead() to invoke
// them. tests/tools.js calls runRead directly and passes 62 assertions. The
// tools work.
//
// Nothing called runRead. Not one caller outside those tests. yardAsk built
// a fixed digest of loads and stock, pasted the tool DESCRIPTIONS into the
// prompt, and asked Gemini once — so the model was handed a list of
// instruments it had no way to pick up. Anything outside the digest was
// unknowable, and "I don't have any idea about this" was the honest answer.
//
// Adding a find_bookings tool the day before did not fix it and could not
// have. I demonstrated the tool returning her real Houston booking by
// calling it directly, which proved the unit and proved nothing about the
// path. That is exactly the gap this file closes: it drives askYard() — the
// function the HTTP endpoint calls — and asserts that the tool actually RUNS
// and that its result reaches the answer.
//
// Gemini is faked. The model's judgement is not what is under test; the
// wiring is, and a test that needs a network call and an API key is a test
// that stops being run.

const path = require('path');
const Module = require('module');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
process.env.DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

// ── the fake model ───────────────────────────────────────────────────────
// Replaces helpers/gemini in the require cache. `SCRIPT` is the sequence of
// replies it gives, so a test can say "first ask for a tool, then answer".
let SCRIPT = [];
let PROMPTS = [];
const geminiPath = require.resolve(path.join(ROOT, 'helpers/gemini.js'));
require.cache[geminiPath] = {
    id: geminiPath, filename: geminiPath, loaded: true,
    exports: {
        callGeminiJSON: async (prompt) => {
            PROMPTS.push(prompt);
            const next = SCRIPT.shift();
            if (typeof next === 'function') return next(prompt);
            return next || { answer: 'no script left', have_data: false };
        },
    },
};

const { askYard } = require(path.join(ROOT, 'helpers/yardAsk.js'));

(async () => {
console.log('\n─ can the assistant actually look things up? ────────────────');

section('A — HER QUESTION, end to end');
{
    // The exact thing she asked, driven through the real askYard().
    SCRIPT = [
        // Round 1: the model does what the prompt now tells it to do.
        { answer: '', have_data: false, tool: { name: 'find_bookings', params: { port: 'houston' } } },
        // Round 2: it has the result and answers from it.
        (p) => ({
            answer: 'One booking from Houston: 274150389 with Maersk to Busan, cutoff 07/13/2026.',
            have_data: true,
            _sawResult: /274150389|HOUSTON/i.test(p),
        }),
    ];
    PROMPTS = [];
    const out = await askYard('what bookings do we have from houston');

    ck('it answers instead of saying it has no idea', out.ok === true);
    ck('  and the answer names the booking',
       /274150389/.test(out.answer),
       'got: ' + out.answer);
    ck('  have_data is true', out.have_data === true,
       'a false here is the model reporting a gap that no longer exists');

    // THE ASSERTION THE WHOLE FILE EXISTS FOR. Not "a tool was described" —
    // "a tool RAN and its output reached the model".
    ck('the tool was actually executed', PROMPTS.length === 2,
       PROMPTS.length + ' calls to the model; 1 means the lookup never happened');
    ck('  and its REAL result was fed back',
       /WHAT YOU LOOKED UP/.test(PROMPTS[1]) && /274150389/.test(PROMPTS[1]),
       'the second prompt must contain the booking that came out of the store, not a placeholder');
    ck('  from her actual data, not a fixture',
       /MAERSK/i.test(PROMPTS[1]),
       'this is read from data/bookings.json — if it changes, so does this');
}

section('B — the prompt tells it the summary is not everything');
{
    SCRIPT = [{ answer: 'ok', have_data: true }];
    PROMPTS = [];
    await askYard('anything');
    const p = PROMPTS[0];
    ck('the tool field is offered', /"tool"/.test(p));
    ck('  with a worked example', /find_bookings/.test(p) && /houston/i.test(p),
       'an abstract instruction is much weaker than one concrete call it can copy');
    // BOTH places, separately. A loose /summary/i matched the DATA header
    // and let a mutation that deleted the actual instruction survive — the
    // header alone tells the model the data is partial without telling it
    // what to do about that.
    ck('  the DATA header calls itself a summary', /DATA \(a summary/.test(p));
    ck('  and the rule spells out that it is not everything',
       /SUMMARY, not everything there is/.test(p),
       'calling it "the complete set of facts available to you" is what taught it to give up');
    ck('  and told not to claim absence before looking',
       /after you have looked|only say something is not in the records/i.test(p));
    ck('  the tools are still described', /find_bookings|find_loads/.test(p));
}

section('C — it cannot loop forever');
{
    // A model that keeps asking for tools must not be able to spend the
    // afternoon doing it. Each round is a Gemini call and a query.
    SCRIPT = new Array(20).fill(0).map(() => ({
        answer: '', have_data: false, tool: { name: 'find_bookings', params: {} },
    }));
    PROMPTS = [];
    const out = await askYard('go round in circles');
    ck('the loop is bounded', PROMPTS.length <= 4,
       PROMPTS.length + ' model calls — unbounded tool use is a runaway bill');
    ck('  and it says something useful when it gives up',
       out.ok === false && /narrow it/i.test(out.answer),
       'got: ' + out.answer);
}

section('D — a bad tool call is recoverable, not fatal');
{
    // The model asks for something that does not exist. That is an ordinary
    // mistake and it should be able to correct itself — throwing would turn
    // it into a 500 and a "something went wrong" for the person asking.
    SCRIPT = [
        { answer: '', have_data: false, tool: { name: 'find_containers', params: {} } },
        (p) => ({ answer: 'Two bookings, both to Busan.', have_data: true, _sawError: /no tool called/i.test(p) }),
    ];
    PROMPTS = [];
    const out = await askYard('what containers are there');
    ck('an unknown tool does not blow up the request', out.ok === true, JSON.stringify(out));
    ck('  and the model is told WHY, so it can pick another',
       /there is no tool called/i.test(PROMPTS[1]),
       'swallowing the error silently would have it guess again with no new information');
}

section('E — a tool that legitimately finds nothing');
{
    // The honest "not in the records" case. It must still be reachable, or
    // the fix would just replace one wrong answer with another.
    SCRIPT = [
        { answer: '', have_data: false, tool: { name: 'find_bookings', params: { port: 'reykjavik' } } },
        (p) => ({ answer: 'Nothing from Reykjavik in the bookings.', have_data: false,
                  _empty: /"rows":\s*\[\s*\]/.test(p) }),
    ];
    PROMPTS = [];
    const out = await askYard('any bookings from reykjavik');
    ck('an empty result still produces an answer', out.ok === true);
    ck('  have_data stays false', out.have_data === false,
       'this is the difference between "I looked and there is none" and "I cannot look"');
    ck('  and the model saw an empty list, not an error',
       /"rows":\s*\[\s*\]/.test(PROMPTS[1]),
       'an empty search is a RESULT; dressing it as a failure would make it apologise instead of answering');
}

section('F — no tool asked for means no extra round trip');
{
    // Most questions are answerable from the digest. They must not pay for
    // the loop.
    SCRIPT = [{ answer: 'Four loads this week.', have_data: true }];
    PROMPTS = [];
    const out = await askYard('how many loads this week');
    ck('a plain question costs exactly one model call', PROMPTS.length === 1);
    ck('  and answers normally', out.ok === true && /Four loads/.test(out.answer));
}

section('G — writes still go through the proposal path');
{
    // The loop must not have become a way to WRITE. Read tools run
    // immediately; anything that changes something is still proposed and
    // confirmed by a person.
    SCRIPT = [{
        answer: 'Record $500 against EDGE_99?', have_data: true,
        action: { kind: 'record_payment', params: { load_id: 'EDGE_99', amount: 500, method: 'Zelle' } },
    }];
    PROMPTS = [];
    const out = await askYard('pay five hundred on edge 99');
    ck('an action is still validated server-side', out.ok === true);
    // EDGE_99 does not exist, so proposeAction must reject it by name rather
    // than minting a proposal for a load that is not there.
    ck('  and a made-up load id is caught',
       /can't do that|no load/i.test(out.answer) || !out.proposal,
       'got: ' + out.answer + ' | proposal: ' + JSON.stringify(out.proposal));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
})();
