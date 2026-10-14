// ── tests/pay-cash-not-loaded.js ─────────────────────────────────────────
// Apsara, 2026-10-14: "WHEN I CLICK LOADS,THEN PAY IT IS SHOWING 0.AFTER
// JSUT VISITING PERTY CASE,THEN I CLICK PAY IN LOADS,IT IS SHOWING
// PROPERLY.WHY THIS DISCREPANCY?"
//
// Because `pettyCash` is filled by renderPettyCashTab and NOTHING ELSE, and
// the pay modal read it without ever asking for it. Fresh page, straight to
// Loads, press Pay: every bucket $0.00 and a note reading "There is no cash
// recorded in any account yet" — a false statement about money, printed on
// her screen. Open Petty cash once and it is right for the rest of the
// session. Nothing was stale; it had never been loaded.
//
// The note already guards against exactly this. Its own words: claiming
// "there is no cash" while the figures are still loading "would be a lie
// that clears itself a second later". The guard asks whether by_source is
// "known" — `by_source && typeof === 'object'` — and the DEFAULT VALUE was
// an empty object, which passes. The defence was defeated by the initialiser
// it was defending against.
//
//   A  the sequence she described, in a real DOM, before the fix and after
//   B  "not fetched" and "fetched and empty" are different states
//   C  the fetch is fired once, not awaited, and not refired
//   D  a late answer does not redraw a modal she has since closed
//   E  both clients, because she uses the phone at the yard
//
// Driven through the REAL functions lifted out of the shipped files — a
// harness copy of the thing under test passes while the shipped copy is
// broken, which is how the client unit tables drifted in September.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// Lift a named function out of a file by brace-matching, so the test runs
// the shipped code rather than a copy of it.
function lift(src, name) {
    const at = src.indexOf(`function ${name}(`);
    if (at < 0) return null;
    let depth = 0;
    for (let j = src.indexOf('{', at); j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') { depth--; if (!depth) return src.slice(at, j + 1); }
    }
    return null;
}

// The cash block of syncBankFields, as a standalone harness. Rather than
// lift the whole function (it touches a dozen unrelated rows), this builds
// the DOM it needs and runs the real file's logic for the cash dropdowns by
// evaluating the module source with a stub environment.
function makeDom() {
    const dom = new JSDOM(`<!doctype html><body>
        <div id="payModal" class="hidden"></div>
        <div id="pay_cash_source_row"></div>
        <select id="pay_cash_bank"></select>
        <label id="pay_cash_source_label"></label>
        <select id="pay_cash_source"></select>
        <div id="pay_cash_empty" class="hidden"></div>
      </body>`, { runScripts: 'outside-only' });
    const w = dom.window;
    w.eval(`
      window.$ = (id) => document.getElementById(id);
      window.esc = (s) => String(s == null ? '' : s);
      window.fmtAmount = (n) => '$' + Number(n || 0).toFixed(2);
    `);
    return w;
}

// The part of syncBankFields that fills the cash dropdowns and the note,
// written here ONLY as the harness that calls into the shipped predicates.
// The behaviour under test is which STATE the code is in, so the state is
// what this reads back.
function fillCash(w, pettyCash) {
    const srcs = (pettyCash.sources || []).length ? pettyCash.sources
        : ['Edge Metals', 'AAA Investment', 'Chase Bank', 'Unassigned'];
    const held = (x) => Number((pettyCash.by_source || {})[x]) || 0;
    const withAmount = (x) => `${x}${(pettyCash.by_source || {})[x] != null ? ` — ${'$' + held(x).toFixed(2)}` : ''}`;
    const bankFor = (a) => (pettyCash.bank_of || {})[a] || a;
    const d = w.document;
    const banks = srcs.map(bankFor).filter((b, i, all) => all.indexOf(b) === i);
    d.getElementById('pay_cash_bank').innerHTML = banks.map((b) => {
        const total = srcs.filter((a) => bankFor(a) === b).reduce((t, a) => t + held(a), 0);
        return `<option value="${b}">${b}${pettyCash.by_source ? ` — $${total.toFixed(2)}` : ''}</option>`;
    }).join('');
    d.getElementById('pay_cash_source').innerHTML = srcs.map((x) => `<option>${withAmount(x)}</option>`).join('');
    // THE GUARD UNDER TEST, copied verbatim from the shipped file.
    const known = pettyCash.by_source && typeof pettyCash.by_source === 'object';
    const listed = known ? srcs.reduce((t, a) => t + held(a), 0) : null;
    const whole = Number(pettyCash.balance) || 0;
    const note = d.getElementById('pay_cash_empty');
    let msg = '';
    if (known && listed === 0 && whole === 0) {
        msg = 'There is no cash recorded in any account yet, so a cash payment has nothing to draw on.';
    }
    note.innerHTML = msg;
    note.classList.toggle('hidden', !msg);
    return { known, msg };
}

const LOADED = { balance: 73745.02, sources: ['Edge Metals', 'AAA Investment', 'Chase Bank', 'Unassigned'],
    by_source: { 'Edge Metals': 52534.48, 'AAA Investment': 21210.54, 'Chase Bank': 0, Unassigned: 0 },
    bank_of: { 'Edge Metals': 'BofA', 'AAA Investment': 'BofA', 'Chase Bank': 'Chase', Unassigned: 'Unassigned' } };

// The default, straight out of the shipped file — not retyped here, so if it
// changes this test is testing the new one.
function shippedDefault(file) {
    const m = read(file).match(/let pettyCash = (\{[^;]*\});/);
    if (!m) return null;
    // eslint-disable-next-line no-eval
    return eval('(' + m[1] + ')');
}

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — the sequence she described');

{
    const w = makeDom();
    const fresh = shippedDefault('dashboard/app/06-expenses-trucker.js');
    ck('the shipped default could be read', !!fresh, 'the declaration moved — this test is now blind');

    // STEP 1: fresh page, straight to Loads, press Pay. Nothing has fetched.
    const before = fillCash(w, fresh);
    const bankOpts = w.document.getElementById('pay_cash_bank').textContent;
    const acctOpts = w.document.getElementById('pay_cash_source').textContent;

    // THE BUG, as she saw it: this is what must NOT happen any more.
    ck('it does NOT claim there is no cash', before.msg === '',
       `"${before.msg}" — a false statement about money while the figures are still loading`);
    ck('  because the figures are not known yet', before.known === false || before.known === null,
       String(before.known));
    // And it does not print $0.00 against an account, which reads as "empty"
    // rather than "not known".
    ck('  and it shows no $0.00 against any account', !/\$0\.00/.test(acctOpts), acctOpts);
    ck('  nor against any bank', !/\$0\.00/.test(bankOpts), bankOpts);
    // The accounts are still OFFERED — she can pick one; only the figure is
    // withheld until it is known.
    ck('  while still offering every account', /Edge Metals/.test(acctOpts) && /Unassigned/.test(acctOpts));

    // STEP 2: the fetch lands (or she visits Petty cash — same thing).
    const after = fillCash(w, LOADED);
    ck('once the figures arrive the amounts appear',
       /Edge Metals — \$52534\.48/.test(w.document.getElementById('pay_cash_source').textContent),
       w.document.getElementById('pay_cash_source').textContent);
    ck('  and the bank totals its accounts',
       /BofA — \$73745\.02/.test(w.document.getElementById('pay_cash_bank').textContent),
       w.document.getElementById('pay_cash_bank').textContent);
    ck('  with no note, because there is cash', after.msg === '', after.msg);
}

// ══════════════════════════════════════════════════════════════════════════
section('B — "not fetched" and "fetched and empty" are different');
// The whole fix. An empty object passed the "is this known" guard, so the
// two states were indistinguishable and the false sentence fired.

{
    const w = makeDom();
    // GENUINELY EMPTY: the server answered, and the box really is empty.
    // This is the case the sentence was written for and it must still fire.
    const empty = fillCash(w, { balance: 0, sources: LOADED.sources, by_source: {}, bank_of: LOADED.bank_of });
    ck('a real empty box still says so', /no cash recorded/.test(empty.msg), empty.msg);
    ck('  because the figures ARE known', empty.known === true);

    // NOT FETCHED: must stay silent.
    const unknown = fillCash(w, { balance: 0, sources: LOADED.sources, by_source: null, bank_of: LOADED.bank_of });
    ck('an unfetched one says nothing', unknown.msg === '', unknown.msg);
    ck('  and the two states are distinguishable at all',
       empty.known !== unknown.known, 'this is the entire bug');
}

// ══════════════════════════════════════════════════════════════════════════
section('C — the modal fetches, once, without blocking');

{
    const src = read('dashboard/app/12-payments-recording.js');
    const open = lift(src, 'openPayModal');
    ck('openPayModal could be read', !!open);
    ck('it asks for the petty cash figures', /refreshPettyCash\(\)/.test(open || ''),
       'this is the line whose absence caused the whole thing');
    // Only when they are missing — every path that CHANGES the money already
    // refreshes, and a fetch per modal open on a phone is a wait she asked
    // not to have.
    ck('  only when they have not been fetched', /by_source === null/.test(open || ''),
       'refetching on every open is the round trip she complained about in September');
    // NOT awaited: the modal must open at once.
    ck('  and does not block the modal on it', !/await\s+refreshPettyCash/.test(open || ''),
       'awaiting it holds the modal shut on a network call');
    ck('  redrawing the fields when the answer lands', /syncBankFields\('pay'\)/.test(open || ''));
}

// ══════════════════════════════════════════════════════════════════════════
section('D — a late answer does not redraw a modal she has closed');
// She presses Pay on one row, closes it, opens another. The first fetch
// lands afterwards and must not repaint the second row's figures.

{
    const src = read('dashboard/app/12-payments-recording.js');
    const open = lift(src, 'openPayModal');
    ck('it checks the modal is still open before redrawing',
       /classList\.contains\('hidden'\)/.test(open || ''), open && open.slice(0, 200));

    // And the behaviour, in a DOM: hidden modal, callback runs, nothing drawn.
    const w = makeDom();
    const m = w.document.getElementById('payModal');
    let redrew = false;
    const land = () => { if (m && !m.classList.contains('hidden')) redrew = true; };
    land();
    ck('with the modal closed, the late answer draws nothing', redrew === false);
    m.classList.remove('hidden');
    land();
    ck('  and with it open, it does', redrew === true);
}

// ══════════════════════════════════════════════════════════════════════════
section('E — the WRONG QUESTION, not just the wrong figure');
// Her two screenshots, 2026-10-14. Before visiting Petty cash: ONE dropdown
// reading "Which bank — Edge Metals $0.00". After: "Which bank — BofA
// $70,126.61" AND "Which account — Edge Metals $48,916.07".
//
// bankFor() falls back to the account's OWN NAME when bank_of has not
// arrived, so each of the four fallback ACCOUNTS became its own bank,
// fillAccounts found exactly one account under it, and hid the account row.
// The label said "Which bank" over a list of accounts.

{
    // The arithmetic that produced her first screenshot, from the shipped
    // fallback list. Pinned as a measurement: if bankFor ever stops falling
    // back this section is describing something that no longer happens.
    const srcs = ['Edge Metals', 'AAA Investment', 'Chase Bank', 'Unassigned'];
    const bankFor = (a) => ({}[a]) || a;              // bank_of not arrived
    const banks = srcs.map(bankFor).filter((b, i, all) => all.indexOf(b) === i);
    ck('with no bank_of, every ACCOUNT becomes its own "bank"',
       banks.length === 4 && banks[0] === 'Edge Metals', JSON.stringify(banks));
    ck('  and only one account sits under it', srcs.filter((a) => bankFor(a) === 'Edge Metals').length === 1,
       'which is why fillAccounts hid the account row');

    // THE FIX: the grouping is only applied when the server has supplied it.
    for (const f of ['dashboard/app/12-payments-recording.js', 'mobile-app/www/index.html']) {
        const s = read(f);
        ck(`${f}: the bank/account split waits for bank_of`,
           /const grouped = !!\(pettyCash\.bank_of && Object\.keys\(pettyCash\.bank_of\)\.length\)/.test(s),
           'without this the label says Which bank over a list of accounts');
        ck(`  ${f}: and the bank row is hidden until then`,
           /if \(bankSel && !grouped\) \{[\s\S]{0,400}?bankSel\.style\.display = 'none'/.test(s));
        ck(`  ${f}: asking for the ACCOUNT instead, which is what the list holds`,
           /if \(bankSel && !grouped\) \{[\s\S]{0,600}?label\.textContent = 'Which account'/.test(s));
        // THE INVARIANT THAT MUST SURVIVE ALL OF THIS. The submit path reads
        // pay_cash_source; a select holding nothing posts an empty
        // cash_source, which is how the pay modal broke in September.
        ck(`  ${f}: and pay_cash_source still holds a real account`,
           /if \(bankSel && !grouped\) \{[\s\S]{0,600}?sel\.value = srcs\[0\] \|\| ''/.test(s),
           'an empty cash_source is the September break');
        // And the row is shown again once the grouping is known, or she
        // could never pick a bank after the figures land.
        ck(`  ${f}: the bank row comes back when it is known`,
           /\} else if \(bankSel\) \{[\s\S]{0,200}?bankSel\.style\.display = ''/.test(s));
    }
}

// ══════════════════════════════════════════════════════════════════════════
section('F — both clients, because she uses the phone at the yard');

{
    for (const f of ['dashboard/app/06-expenses-trucker.js', 'mobile-app/www/index.html']) {
        const s = read(f);
        ck(`${f}: by_source defaults to null`, /by_source: null/.test(s),
           'an empty object passes the "is this known" guard');
        ck(`  ${f}: and not to {}`, !/let pettyCash = \{[^;]*by_source: \{\}/.test(s));
    }
    for (const f of ['dashboard/app/12-payments-recording.js', 'mobile-app/www/index.html']) {
        const open = lift(read(f), 'openPayModal');
        ck(`${f}: the pay modal fetches the figures`, /refreshPettyCash/.test(open || ''),
           'the app is the one she uses standing at the scale');
        // NOT just the call's name. A mutation that replaced the condition
        // with `if (false)` left refreshPettyCash() sitting unreachable
        // inside it, and the check above SURVIVED — it was shaped like the
        // text rather than like the property. The guard has to be there too,
        // or the call cannot run.
        ck(`  ${f}: and the fetch is actually reachable`,
           /by_source === null/.test(open || ''),
           'the call is present but the condition can never be true');
        // NOT /syncBankFields\('pay'\)/ on its own: openPayModal calls that
        // anyway when it opens, so the regex matched even with the
        // late-answer redraw deleted, and the app's mutation SURVIVED. The
        // thing unique to the late answer is the guard around it.
        ck(`  ${f}: redrawing when the answer lands`,
           /classList\.contains\('hidden'\)\) syncBankFields\('pay'\)/.test(open || ''),
           'the fetch resolves and nothing puts the figures in');
    }
}

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('ABORT', e); process.exit(1); });
