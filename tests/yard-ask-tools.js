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

section('A — a lookup Scout OWNS, end to end');
{
    // This section used to drive find_bookings, which was my wrong fix —
    // bookings are Jarvis's subject, not Scout's, and the tool has been
    // removed (see helpers/tools.js and tests/voice-router.js section D).
    //
    // The MECHANISM being tested is unchanged and is the point: a read tool
    // is genuinely executed and its result reaches the model. Driven now
    // through find_loads, which Scout does own.
    SCRIPT = [
        // Round 1: the model does what the prompt now tells it to do.
        { answer: '', have_data: false, tool: { name: 'find_loads', params: { unpaid_only: true } } },
        // Round 2: it has the result and answers from it.
        (p) => ({
            answer: 'Two loads are still unpaid.',
            have_data: true,
            _sawResult: /"rows"/.test(p),
        }),
    ];
    PROMPTS = [];
    const out = await askYard('which loads are still unpaid');

    ck('it answers instead of saying it has no idea', out.ok === true);
    ck('  and the answer came from the lookup', /unpaid/i.test(out.answer),
       'got: ' + out.answer);
    ck('  have_data is true', out.have_data === true,
       'a false here is the model reporting a gap that no longer exists');

    // THE ASSERTION THE WHOLE FILE EXISTS FOR. Not "a tool was described" —
    // "a tool RAN and its output reached the model".
    ck('the tool was actually executed', PROMPTS.length === 2,
       PROMPTS.length + ' calls to the model; 1 means the lookup never happened');
    ck('  and its REAL result was fed back',
       /WHAT YOU LOOKED UP/.test(PROMPTS[1]) && /find_loads/.test(PROMPTS[1]),
       'the second prompt must contain what the store returned, not a placeholder');
    ck('  shaped by the registry, not invented',
       /"rows"|"truncated"|"total"/.test(PROMPTS[1]),
       'every read tool returns this envelope — see cap() in helpers/tools.js');
}

section('B — the prompt tells it the summary is not everything');
{
    SCRIPT = [{ answer: 'ok', have_data: true }];
    PROMPTS = [];
    await askYard('anything');
    const p = PROMPTS[0];
    ck('the tool field is offered', /"tool"/.test(p));
    ck('  with a worked example', /"tool":\s*\{\s*"name"/.test(p) && /find_loads/.test(p),
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
    ck('  the tools are still described', /find_loads/.test(p));
}

section('C — it cannot loop forever');
{
    // A model that keeps asking for tools must not be able to spend the
    // afternoon doing it. Each round is a Gemini call and a query.
    SCRIPT = new Array(20).fill(0).map(() => ({
        answer: '', have_data: false, tool: { name: 'find_loads', params: {} },
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
        { answer: '', have_data: false, tool: { name: 'find_loads', params: { seller: 'nobodyxyz' } } },
        (p) => ({ answer: 'No loads from that seller.', have_data: false,
                  _empty: /"rows":\s*\[\s*\]/.test(p) }),
    ];
    PROMPTS = [];
    const out = await askYard('any loads from nobodyxyz');
    ck('an empty result still produces an answer', out.ok === true);
    ck('  have_data stays false', out.have_data === false,
       'this is the difference between "I looked and there is none" and "I cannot look"');
    ck('  and the model saw an empty list, not an error',
       /"rows":\s*\[\s*\]/.test(PROMPTS[1]),
       'an empty search is a RESULT; dressing it as a failure would make it apologise instead of answering');
}

section('E2 — it can see an EXPENSE, not just the month\'s total');
{
    // ── THE REAL CAUSE OF "I cannot find any record" ─────────────────────
    // Apsara, 2026-09-15, asked the assistant "How much did we pay
    // Santiago?" and then "check in expenses", and was told twice there was
    // no record. It was answering honestly: spend_report is the only expense
    // tool it had, and spend_report deliberately DROPS its rows — "the
    // totals answer the question and the rows would dominate the prompt".
    //
    // So it could say what August cost by method and month, and could not see
    // one vendor name. Every question about WHO was paid or WHAT FOR was
    // unanswerable, and "I cannot find any record" was indistinguishable from
    // "there are none" — which is the worst pair of meanings to merge.
    const tools = require(path.join(ROOT, 'helpers/tools'));

    // ── AND THE SUMMARY CARRIES CATEGORIES ───────────────────────────────
    // Apsara, pushing back: "But it shoudl able to show that na". She was
    // right, and about more than find_expenses. spend_report handed over
    // byMethod, byBank and months and NO category breakdown at all — so
    // "how much salary did we pay" was unanswerable even as a summary, while
    // expenses.getExpenseReport had been computing byCategory for the
    // Expenses tab the whole time. One line per category is an aggregate, so
    // the "rows would dominate the prompt" reasoning does not cover it.
    {
        const expMod0 = require.resolve(path.join(ROOT, 'helpers/expenses'));
        require(expMod0);
        const realLoad = require.cache[expMod0].exports.loadExpenses;
        require.cache[expMod0].exports.loadExpenses = () => ([
            { id: 'C1', date: '2026-09-12', category: 'Labour', description: 'Salary', amount: 200, payment_method: 'Cash' },
            { id: 'C2', date: '2026-09-10', category: 'Labour', description: 'Salary Santiago', amount: 900, payment_method: 'Cash' },
            { id: 'C3', date: '2026-09-05', category: 'Fuel', description: 'Diesel', amount: 300, payment_method: 'Card' },
        ]);
        const rep = await tools.runRead('spend_report', {});
        ck('the spend summary breaks expenses down BY CATEGORY',
           Array.isArray(rep.byCategory) && rep.byCategory.length > 0,
           JSON.stringify(Object.keys(rep)));
        const labour = (rep.byCategory || []).find((c) => c.category === 'Labour');
        ck('  so "how much salary did we pay" is answerable from the summary',
           labour && labour.amount === 1100, JSON.stringify(rep.byCategory));
        ck('  and it still carries no rows, which was the point of dropping them',
           rep.rows === undefined, JSON.stringify(Object.keys(rep)));
        require.cache[expMod0].exports.loadExpenses = realLoad;
    }

    ck('there IS a tool that reads expense rows',
       tools.readToolNames().includes('find_expenses'),
       tools.readToolNames().join(', '));
    // The whole bug, pinned: a tool that cannot name anyone cannot answer
    // "how much did we pay X".
    ck('  and spend_report still does not carry rows, so it cannot replace it',
       /const \{ rows, received, \.\.\.totals \} = r;/
         .test(require('fs').readFileSync(path.join(ROOT, 'helpers/tools.js'), 'utf8')),
       'if spend_report starts returning rows, this tool and its reasoning need revisiting');
    // The prompt is generated FROM the registry, so a tool the model is never
    // told about is a tool it never calls.
    ck('  and the assistant is told about it',
       /find_expenses/.test(tools.describeTools()),
       tools.describeTools().slice(0, 120));

    const EXPENSES = [
        { id: 'X1', date: '2026-09-02', vendor: 'Santiago', category: 'Repairs',
          description: 'Forklift hydraulic hose', notes: null, payment_method: 'Cash', amount: 240 },
        { id: 'X2', date: '2026-09-09', vendor: 'Santiago Welding', category: 'Repairs',
          description: 'Loader belt', notes: 'second visit', payment_method: 'Zelle', amount: 510.5 },
        { id: 'X3', date: '2026-08-20', vendor: 'Chevron', category: 'Fuel',
          description: 'Diesel', notes: null, payment_method: 'Card', amount: 300 },
        // AUGUST, and Santiago's. Deliberately outside the September window
        // used below: without a row the date filter actually excludes, a
        // mutation deleting that filter SURVIVED — both other Santiago rows
        // were already inside the range, so the range was never doing work.
        { id: 'X4', date: '2026-08-11', vendor: 'Santiago', category: 'Repairs',
          description: 'Gate weld', notes: null, payment_method: 'Cash', amount: 95 },
        // ── NAMED ONLY IN THE DESCRIPTION, NO VENDOR ──────────────────────
        // Straight from her data: a salary line carries the person's name in
        // the description and leaves vendor empty. With `vendor` and `text`
        // as separate parameters the model had to choose, so "how much did we
        // pay Santiago" answered from one field and silently left this out.
        // An undercount is the dangerous direction — nobody questions a
        // figure lower than they feared.
        { id: 'X5', date: '2026-09-10', vendor: null, category: 'Labour',
          description: 'Weekly salary Santiago', notes: null, payment_method: 'Cash', amount: 900 },
    ];
    const expMod = require.resolve(path.join(ROOT, 'helpers/expenses'));
    require(expMod);
    require.cache[expMod].exports.loadExpenses = () => EXPENSES.slice();

    const run = (params) => tools.runRead('find_expenses', params);

    {
        const r = await run({ match: 'Santiago' });
        ck('her actual question: what did we pay Santiago',
           r.matched_total === 1745.5, String(r.matched_total));
        ck('  matching loosely, so "Santiago Welding" counts too',
           r.rows.some((x) => x.id === 'X2'), JSON.stringify(r.rows.map((x) => x.id)));
        // THE UNDERCOUNT THIS REPLACED. X5 names him in the DESCRIPTION and
        // has no vendor at all; searching the vendor field alone answers
        // $845.50 and omits $900 without ever saying so.
        ck('  INCLUDING the one named only in the description',
           r.rows.some((x) => x.id === 'X5'),
           'searching one field answers a money question with part of the answer');
        ck('  so no row carrying his name is left out',
           r.rows.length === 4, JSON.stringify(r.rows.map((x) => x.id)));
        // Whichever name the model reaches for, it gets the whole answer:
        // there is no longer a wrong choice available to it.
        for (const alias of ['vendor', 'text']) {
            ck(`  the old "${alias}" parameter now means the same thing`,
               (await run({ [alias]: 'Santiago' })).matched_total === 1745.5, alias);
        }
        // The sum is computed in the tool, not left to the model. A total a
        // language model adds up in its head is a total nobody checked.
        ck('  and the TOTAL comes from the tool, not the model',
           typeof r.matched_total === 'number');
    }
    {
        const r = await run({ match: 'santiago', from: '2026-09-01', to: '2026-09-30' });
        ck('a date range narrows it — August\'s Santiago row drops out',
           r.total === 3, String(r.total));
        ck('  leaving only what was spent in the window',
           r.matched_total === 1650.5, String(r.matched_total));
        ck('  case does not matter', (await run({ match: 'SANTIAGO' })).total === 4);
    }
    {
        const r = await run({ match: 'hose' });
        ck('it searches descriptions', r.rows.length === 1 && r.rows[0].id === 'X1');
    }
    {
        const r = await run({ match: 'second visit' });
        ck('  and notes, because "what for" is often written there',
           r.rows.length === 1 && r.rows[0].id === 'X2', JSON.stringify(r.rows));
    }
    {
        const r = await run({ method: 'card' });
        ck('it narrows by how it was paid', r.rows.length === 1 && r.rows[0].id === 'X3');
    }
    {
        // A genuine zero must be a RESULT, not an absence of capability —
        // exactly the distinction that was lost.
        const r = await run({ match: 'Nobodyxyz' });
        ck('a vendor with nothing against them returns an empty list',
           r.total === 0 && Array.isArray(r.rows) && r.rows.length === 0);
        ck('  and a zero total, not undefined', r.matched_total === 0);
    }
    delete require.cache[expMod];
}

section('E3 — reading the payee out of the description');
{
    // Apsara, 2026-09-15: "if they say salay santiago-it means that salary for
    // santiago..when they type in app-it should read the description and ask
    // user whether they mean salary for santiago????" then "ai assistant
    // should handle that".
    //
    // The division of labour is the design: the MODEL decides whether a name
    // is present (a meaning question a regex gets wrong — "Salary paid $200
    // for tools" names nobody, and "tools" is the trap), DETERMINISTIC code
    // decides whether that name is anyone on file, and NOTHING is written
    // without her yes.
    const v = require(path.join(ROOT, 'helpers/vendorFromText'));
    const EXP = [{ vendor: 'Santiago' }, { vendor: 'Santiago' }, { vendor: 'Chevron' }];
    // The model is stubbed everywhere below. A test that reached the real one
    // would be slow, flaky and spending her quota.
    const say = (reply) => async () => reply;
    const ask = (text, reply, over = {}) =>
        v.suggestVendor(text, { expenses: EXP, ask: say(reply), ...over });

    {
        const r = await ask('Weekly salary Santiago', { vendor: 'Santiago', confidence: 'high' });
        ck('her example: "salary santiago" asks about Santiago',
           r.suggest === true && /Is this for Santiago\?/.test(r.question), JSON.stringify(r));
        ck('  recognising him as someone already on file', r.known === true);
    }
    {
        const r = await ask('salary santiago', { vendor: 'santiago', confidence: 'high' });
        ck('  typed in lower case, it offers HER spelling back',
           r.vendor === 'Santiago',
           'otherwise the vendor column grows "santiago" beside "Santiago"');
    }
    {
        const r = await ask('Paid Ramesh for gate weld', { vendor: 'Ramesh', confidence: 'high' });
        ck('a name not on file is still offered', r.suggest === true && r.known === false);
        ck('  and said to be new, so she knows she is creating one',
           /new vendor/.test(r.question), r.question);
    }
    {
        // ── A NEAR MISS IS A DIFFERENT PERSON ─────────────────────────────
        // helpers/nameMatch.js refuses fuzzy matching and says why: "in this
        // business a near-miss resolves to the wrong company and a real quote
        // request or email goes to them". Here it would file money against
        // the wrong person.
        //
        // "Santos" shares its first three letters with "Santiago", who IS on
        // file. Any prefix or substring rule offers Santiago back and she
        // clicks yes on a name she never typed. A mutation doing exactly that
        // SURVIVED until this case existed, because every earlier fixture
        // asked about a name that matched itself either way.
        const r = await ask('Paid Santos for scrap', { vendor: 'Santos', confidence: 'high' });
        ck('a name that merely RESEMBLES one on file is not mistaken for it',
           r.vendor === 'Santos' && r.known === false,
           JSON.stringify(r) + ' — Santiago is on file; Santos is somebody else');
        ck('  and is offered as a new vendor instead',
           /new vendor/.test(r.question), r.question);
    }

    // ── THE ONES THAT MUST NOT ASK ────────────────────────────────────────
    {
        const r = await ask('Salary paid $200 for tools', { vendor: null, confidence: 'high' });
        ck('a line naming nobody asks nothing', r.suggest === false, JSON.stringify(r));
        ck('  "tools" is never mistaken for a person', !/tools/i.test(JSON.stringify(r)));
    }
    {
        // THE GUARD THAT MATTERS MOST. A model asked for a name will sometimes
        // produce a plausible one that was never typed. Inventing a payee is
        // the one outcome worse than suggesting nothing, so the answer has to
        // appear in what she actually wrote.
        const r = await ask('Hose repair', { vendor: 'Acme Parts', confidence: 'high' });
        ck('a name the model INVENTED is refused',
           r.suggest === false && r.why === 'not_in_text', JSON.stringify(r));
    }
    {
        const r = await ask('Salary Santiago', { vendor: 'Santiago', confidence: 'low' });
        ck('an unsure answer is dropped rather than guessed at',
           r.suggest === false && r.why === 'unsure', JSON.stringify(r));
    }
    {
        const r = await ask('Weekly salary Santiago', { vendor: 'Santiago', confidence: 'high' },
                            { vendor: 'Chevron' });
        ck('a vendor she already typed is never second-guessed',
           r.suggest === false && r.why === 'vendor_already_set');
    }

    // ── AND IT MUST NEVER BLOCK RECORDING AN EXPENSE ──────────────────────
    // No key, a quota wall, a timeout, malformed JSON. An expense she cannot
    // record because a suggestion service was down is a far worse bug than
    // the one this fixes.
    for (const [label, stub] of [
        ['the model is unavailable', async () => null],
        ['the model throws', async () => { throw new Error('quota exceeded'); }],
        ['the model returns nonsense', async () => 'not json'],
    ]) {
        const r = await v.suggestVendor('Weekly salary Santiago', { expenses: EXP, ask: stub });
        ck(`${label} — no suggestion, no error`, r && r.suggest === false, JSON.stringify(r));
    }
    {
        // A hung request is the one failure that returns nothing at all.
        const slow = () => new Promise((r) => setTimeout(() => r({ vendor: 'Santiago', confidence: 'high' }), v.TIMEOUT_MS + 500));
        const started = Date.now();
        const r = await v.suggestVendor('Weekly salary Santiago', { expenses: EXP, ask: slow });
        ck('a hung model gives up rather than hanging the form',
           r.suggest === false && Date.now() - started < v.TIMEOUT_MS + 400,
           `${Date.now() - started}ms`);
    }

    // The known names are fed to the prompt: a name she has typed before is
    // far likelier than one she has not.
    ck('the prompt is told which vendors she already uses',
       /Santiago/.test(v.buildPrompt('Weekly salary Santiago', v.knownVendors(EXP))));
    ck('  most-used first', v.knownVendors(EXP)[0] === 'Santiago',
       JSON.stringify(v.knownVendors(EXP)));
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
