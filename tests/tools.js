// ── tests/tools.js ────────────────────────────────────────────────────────
// Apsara, 2026-09-05: "dynamically it should act ... mimicing a assistant
// behaviour not just restricted to standard template."
//
// The template she could feel was a real thing in the code: the vocabulary
// was written down twice — as English prose in yardAsk.js's rules, and as
// JavaScript in yardActions.js — and kept in step by hand. It had already
// drifted. Six features shipped after that prose was written (trucker bills,
// expenses, petty cash, the spend report, the inventory drill-down, sales)
// and the assistant knew about none of them, so it said "I can't do that" to
// things the app had been doing for weeks.
//
// helpers/tools.js is one registry and the prompt is GENERATED from it.
// Section A is the assertion that matters: what the model is told and what
// the code can do are the same list, by construction rather than by anyone
// remembering.
//
// Section E is the other half — the safety line did not move. Reads run;
// writes still propose and wait for a person.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-tools-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.LOADS_FILE).startsWith(TMP)) { console.error('  ABORT  config not isolated'); process.exit(1); }

const tools = require(path.join(ROOT, 'helpers/tools'));
const { mutateJson } = require(path.join(ROOT, 'helpers/json'));
const payments = require(path.join(ROOT, 'helpers/payments'));
const petty = require(path.join(ROOT, 'helpers/pettyCash'));

(async () => {

// A small yard to ask questions about.
await mutateJson(cfg.LOADS_FILE, [], () => ([
    { id: 'EDGE_01', date: '2026-08-10', seller: 'Acme Metals', amount: 1000, weight_unit: 'lb',
      items: [{ description: 'Sealed Units', gross_weight: 1000, tare_weight: 100, net_weight: 900, price: 1, amount: 900 }] },
    { id: 'EDGE_02', date: '2026-09-01', seller: 'Vega Scrap', amount: 500, weight_unit: 'lb',
      items: [{ description: 'Copper', gross_weight: 200, tare_weight: 0, net_weight: 200, price: 2.5, amount: 500 }] },
]));
await payments.addPayment({ load_id: 'EDGE_01', load_kind: 'purchase', amount: 400, mode: 'Zelle', paid_on: '2026-08-11' });

console.log('\n─ the tool registry ─────────────────────────────────────────');

section('A — the prompt and the code are ONE list');
{
    const text = tools.describeTools();
    // THE POINT OF THE WHOLE CHANGE. Every tool that exists is described, and
    // nothing is described that does not exist.
    for (const name of tools.TOOL_NAMES) {
        ck(`${name} appears in the generated prompt`, text.includes(name),
           'a capability the model is never told about might as well not exist');
    }
    const mentioned = (text.match(/• (\w+) —/g) || []).map((m) => m.slice(2).split(' ')[0]);
    ck('nothing is advertised that does not exist',
       mentioned.every((n) => tools.TOOL_NAMES.includes(n)),
       `advertised but absent: ${mentioned.filter((n) => !tools.TOOL_NAMES.includes(n)).join(', ')}`);
    ck('  and the counts match exactly', mentioned.length === tools.TOOL_NAMES.length,
       `prompt lists ${mentioned.length}, registry has ${tools.TOOL_NAMES.length}`);

    // Required parameters are documented, or the model guesses and the
    // proposal fails with a message the person cannot act on.
    ck('required params are marked', /load_id \(required\)/.test(text));
    ck('  and optional ones are explained', /defaults to today/.test(text));

    // The old prose is gone from yardAsk, replaced by the generated block.
    const ask = fs.readFileSync(path.join(ROOT, 'helpers/yardAsk.js'), 'utf8');
    ck('yardAsk no longer hand-lists the actions',
       !/record_payment — params: load_id, amount, mode/.test(ask),
       'that line and the code drifted apart once already');
    ck('  it generates them instead', /describeTools\(\)/.test(ask));
}

section('B — the drift that existed is actually closed');
{
    // The concrete symptom: the app grew trucker bills and expenses, and the
    // assistant could not touch either.
    for (const n of ['add_trucker_bill', 'add_expense', 'trucker_bills', 'spend_report', 'petty_cash']) {
        ck(`${n} is now available to the assistant`, tools.TOOL_NAMES.includes(n));
    }
    // And there is exactly one implementation of record_payment. The copy in
    // yardActions.js was deleted rather than left as a fallback — two
    // implementations of a money path is a trap for whoever edits the wrong.
    const ya = fs.readFileSync(path.join(ROOT, 'helpers/yardActions.js'), 'utf8');
    ck('record_payment exists once, in the registry',
       tools.TOOL_NAMES.includes('record_payment') && !/async record_payment\(/.test(ya),
       'a dead second copy of a write path is a trap, not a safety net');
}

section('C — read tools run, and return real figures');
{
    const all = await tools.runRead('find_loads', {});
    ck('find_loads returns both loads', all.total === 2);

    const acme = await tools.runRead('find_loads', { seller: 'acme' });
    ck('  and narrows by seller', acme.total === 1 && acme.rows[0].id === 'EDGE_01');
    ck('  matching loosely, not exactly', (await tools.runRead('find_loads', { seller: 'ACME met' })).total === 1);

    const unpaid = await tools.runRead('find_loads', { unpaid_only: true });
    ck('  and by what is still owed', unpaid.total === 2,
       'EDGE_01 has 600 left, EDGE_02 has had nothing paid');

    const byItem = await tools.runRead('find_loads', { item: 'sealed' });
    ck('  and by item description', byItem.total === 1 && byItem.rows[0].id === 'EDGE_01');

    const sept = await tools.runRead('find_loads', { from: '2026-09-01' });
    ck('  and by date', sept.total === 1 && sept.rows[0].id === 'EDGE_02');

    // The payment figures come from the same code the screens use, not from
    // anything re-derived here.
    ck('each row carries the real payment state', acme.rows[0].payment.paid === 400);

    const detail = await tools.runRead('load_detail', { load_id: 'EDGE_01' });
    ck('load_detail returns the items and the payments',
       detail.found && detail.load.items.length === 1 && detail.payments.length === 1);

    // NOT FOUND IS AN ANSWER, not a failure. Throwing would turn a reasonable
    // question into an apology about an error.
    const missing = await tools.runRead('load_detail', { load_id: 'EDGE_999' });
    ck('  a load that does not exist reports found:false', missing.found === false,
       'an honest "no such load" beats a thrown error the person cannot act on');
}

section('D — the other read tools answer the questions they are for');
{
    const inv = await tools.runRead('inventory', {});
    ck('inventory reports stock by type', Array.isArray(inv.byType) && inv.byType.length > 0);

    const lines = await tools.runRead('item_lines', { description: 'Sealed Units' });
    ck('item_lines finds the individual lines', lines.count === 1 && lines.totals.net === 900);

    await petty.addTopUp({ amount: 1000 });
    const box = await tools.runRead('petty_cash', {});
    ck('petty_cash reports the balance', box.balance === 1000);

    const spend = await tools.runRead('spend_report', {});
    ck('spend_report totals what went out', spend.total === 400);
    ck('  split by kind', spend.loadTotal === 400 && spend.expenseTotal === 0);
    ck('  and drops the row-level detail', spend.rows === undefined,
       'the rows would dominate the prompt and the totals answer the question');

    const bills = await tools.runRead('trucker_bills', {});
    ck('trucker_bills answers even with none recorded', bills.total === 0 && bills.report.count === 0);
}

section('E — the safety line did NOT move');
{
    // Reads run. Writes do not — no matter which door they are pushed at.
    // Asserted on the MESSAGE, not merely that something threw. Removing the
    // kind check still produced an error — write tools have no run(), so it
    // died on a TypeError instead — and the test passed while the guard was
    // gone. A guard whose absence is masked by an accident is not tested.
    let threw = null;
    try { await tools.runRead('record_payment', { load_id: 'EDGE_01', amount: 10, mode: 'Zelle' }); }
    catch (e) { threw = e; }
    ck('a write cannot be run through the read path',
       !!threw && /changes things, so it has to be proposed/.test(threw.message),
       `the read path has no confirmation — got: ${threw && threw.message}`);

    let threw2 = null;
    try { await tools.buildWrite('find_loads', {}); } catch (e) { threw2 = e; }
    ck('  and a read does not pretend to need confirming', !!threw2);

    // buildWrite RETURNS a proposal and writes nothing.
    const before = payments.paymentsForLoad('EDGE_02').length;
    const prop = await tools.buildWrite('record_payment', { load_id: 'EDGE_02', amount: 500, mode: 'Wire' });
    ck('proposing a payment writes nothing', payments.paymentsForLoad('EDGE_02').length === before,
       'this is the entire propose-then-confirm design');
    ck('  it returns a sentence a person can check', /Record a Wire payment of \$500\.00 against EDGE_02/.test(prop.summary));
    ck('  with the figures recomputed from the ledger',
       prop.details.some(([k, v]) => k === 'Left pending after' && v === '$0.00'));
    ck('  and only runs when run() is called', typeof prop.run === 'function');

    // The deletions and the sending stay out entirely — not behind a
    // confirmation, out.
    ck('there is no delete tool', !tools.TOOL_NAMES.some((n) => /delete|remove|void/i.test(n)));
    ck('there is no send tool', !tools.TOOL_NAMES.some((n) => /send|email|whatsapp|message/i.test(n)),
       'a sent message cannot be unsent, and voice mishears names');
    ck('  and the prompt says so', /cannot delete anything/.test(tools.describeTools())
       && /cannot send emails or messages/.test(tools.describeTools()));
}

section('F — a hallucinated call dies before it reaches a handler');
{
    const bad = async (fn, ...a) => { try { await fn(...a); return null; } catch (e) { return e.message; } };

    ck('an unknown tool is named, not silently ignored',
       /no tool called "make_me_a_sandwich"/.test(await bad(tools.runRead, 'make_me_a_sandwich', {})));
    ck('a missing required param is named',
       /load_detail needs load_id/.test(await bad(tools.runRead, 'load_detail', {})));
    ck('a non-numeric amount is refused',
       /must be a number/.test(await bad(tools.buildWrite, 'record_payment', { load_id: 'EDGE_01', amount: 'twelve thousand', mode: 'Zelle' })));
    ck('a malformed date is refused',
       /must be a date as YYYY-MM-DD/.test(await bad(tools.runRead, 'find_loads', { from: '10 August' })));
    ck('a hallucinated load id is refused BY NAME',
       /there is no load EDGE_404/.test(await bad(tools.buildWrite, 'record_payment', { load_id: 'EDGE_404', amount: 10, mode: 'Zelle' })),
       'naming it is how a hallucination becomes visible instead of becoming a write');
    ck('an invalid payment mode is refused',
       /payment mode must be one of/.test(await bad(tools.buildWrite, 'record_payment', { load_id: 'EDGE_01', amount: 10, mode: 'Bitcoin' })));
}

section('G — a read tool cannot flood the prompt');
{
    await mutateJson(cfg.LOADS_FILE, [], (list) => {
        const l = Array.isArray(list) ? list : [];
        for (let i = 100; i < 200; i++) l.push({ id: 'EDGE_' + i, date: '2026-07-01', seller: 'Bulk', amount: 1, items: [] });
        return l;
    });
    const many = await tools.runRead('find_loads', {});
    ck(`capped at ${tools.MAX_ROWS} rows`, many.rows.length === tools.MAX_ROWS);
    ck('  and it says it was capped', many.truncated === true,
       'silently truncating would have the model answer confidently from a third of the data');
    ck('  while still reporting the true count', many.total > tools.MAX_ROWS);
}

section('H — the old propose/confirm still works through the registry');
{
    const ya = require(path.join(ROOT, 'helpers/yardActions'));
    const p = await ya.proposeAction({ kind: 'record_payment', params: { load_id: 'EDGE_01', amount: 100, mode: 'Cash' } }, { role: 'admin' });
    ck('proposeAction routes to the registry', !!p.id && p.kind === 'record_payment');

    const before = payments.paymentsForLoad('EDGE_01').length;
    await ya.confirmAction(p.id, { role: 'admin' });
    ck('  and confirming writes exactly once', payments.paymentsForLoad('EDGE_01').length === before + 1);

    let reused = null;
    try { await ya.confirmAction(p.id, { role: 'admin' }); } catch (e) { reused = e.message; }
    ck('  a confirmation is single use', /expired or was already used/.test(reused || ''),
       'a double tap must not record the payment twice');

    let del = null;
    try { await ya.proposeAction({ kind: 'delete_load', params: { load_id: 'EDGE_01' } }); } catch (e) { del = e.message; }
    ck('deleting is still refused by name', /will not delete anything/.test(del || ''));

    // An unknown action now says what IS possible, from the live list.
    let unknown = null;
    try { await ya.proposeAction({ kind: 'fly_to_the_moon' }); } catch (e) { unknown = e.message; }
    ck('an unknown action lists the real vocabulary', /add_trucker_bill/.test(unknown || ''),
       'the old message named three actions from memory and was wrong');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  Failed:'); failures.forEach((f) => console.log('   - ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
})();
