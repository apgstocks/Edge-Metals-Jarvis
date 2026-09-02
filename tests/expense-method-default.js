// ── tests/expense-method-default.js ───────────────────────────────────────
// Apsara, 2026-09-03: "when i add entry in expense, paid by should be
// cash/card" and "by default it should be cash".
//
// The server side of that (the list, the default constant, retiring Zelle and
// Wire without losing the expenses already recorded with them) is asserted in
// tests/spend-report.js section A. What THAT file cannot see is the form, and
// the form is where the risk is:
//
//   A pre-selected "Cash" is not a cosmetic default. A Cash expense WITHDRAWS
//   FROM PETTY CASH. If the default leaked onto the EDIT path, opening a
//   legacy expense whose method nobody recorded would show "Cash", and saving
//   after fixing a typo in the description would both rewrite that field and
//   take money out of the box for a receipt that may never have been cash.
//   That is a ledger entry invented by looking at a form.
//
// So this file EXECUTES the shipped openExpenseModal in jsdom rather than
// matching its source. A regex over that function would pass on the comment
// above — a trap that has caught me four times in this repo — and would also
// pass on a correct-looking expression that evaluates the wrong way round.

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
const SRC = fs.readFileSync(path.join(ROOT, 'mobile-app/www/index.html'), 'utf8');

// Same extractor as tests/petty-cash-clients.js: start at the BODY, not the
// first '{' after the name, or a destructured parameter list is mistaken for
// the whole function.
function grab(src, name) {
    for (const kw of ['async function ', 'function ']) {
        const i = src.indexOf(kw + name + '(');
        if (i < 0) continue;
        const bodyStart = src.indexOf(') {', src.indexOf('(', i)) + 2;
        let d = 0;
        for (let k = bodyStart; k < src.length; k++) {
            if (src[k] === '{') d++;
            else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
        }
    }
    throw new Error(`could not find ${name}()`);
}

const FN = grab(SRC, 'openExpenseModal');
// Guard the extractor itself. If grab() ever silently returned a stub, every
// assertion below would still "pass" against an empty function.
ck('the shipped openExpenseModal was extracted', /sel\.value/.test(FN) && FN.length > 400,
   `got ${FN.length} chars — the extractor is matching the wrong thing`);

// ── a harness that provides only what the function touches ────────────────
// Deliberately minimal. Anything stubbed here is something this test is NOT
// checking, and keeping the list short keeps that honest.
function openWith({ methods, retired = null, defaultMethod, expense }) {
    const dom = new JSDOM(`<!doctype html><body>
      <div id="expenseModal" class="hidden"></div>
      <span id="expTitle"></span>
      <input id="exp_date"><input id="exp_description"><input id="exp_vendor">
      <input id="exp_amount"><span id="expErr"></span>
      <select id="exp_category"></select>
      <select id="exp_payment"></select>
    </body>`);
    const d = dom.window.document;
    const scope = {
        document: d,
        $: (id) => d.getElementById(id),
        esc: (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
        expenseCategories: ['Fuel', 'Other'],
        expenseMethods: methods,
        expenseRetiredMethods: retired,
        expenseDefaultMethod: defaultMethod,
        editingExpenseId: null,
        toUsDate: (s) => String(s || ''),
        wireUsDateField: () => {},
        todayLocalDateStrForExpense: () => '2026-09-03',
    };
    const keys = Object.keys(scope);
    // eslint-disable-next-line no-new-func
    new Function(...keys, `${FN}; openExpenseModal(${JSON.stringify(expense ?? null)});`)
        (...keys.map((k) => scope[k]));
    const sel = d.getElementById('exp_payment');
    return {
        value: sel.value,
        options: [...sel.options].map((o) => o.value),
        labels: [...sel.options].map((o) => o.textContent),
    };
}

// What the server now sends. Hardcoded here ON PURPOSE rather than required
// from helpers/expenses: this file asks what the FORM does with a payload, and
// tests/spend-report.js asks whether the server sends that payload. Sharing the
// constant would let both move together and neither notice.
const SERVER = {
    methods: ['Cash', 'Card'],
    retired: ['Zelle', 'Wire', 'Cheque', 'Other'],
    defaultMethod: 'Cash',
};

console.log('\n─ the expense "Paid by" box ─────────────────────────────────');

section('A — a new expense');
{
    const r = openWith({ ...SERVER, expense: null });
    ck('opens on Cash', r.value === 'Cash',
       'Apsara: "by default it should be cash"');
    ck('  and Cash and Card are the only methods offered',
       r.options.filter(Boolean).join('/') === 'Cash/Card');
    ck('  with Zelle and Wire gone', !r.options.includes('Zelle') && !r.options.includes('Wire'));
    // "— not recorded —" survives the narrowing. Removing it would make a
    // legacy expense with no method unrepresentable in the form, so opening
    // one would force it to Cash or Card on save — the same invented-ledger
    // problem this whole file exists to prevent.
    ck('  and "not recorded" is still available', r.options.includes(''));
}

section('B — the default does NOT reach the edit path');
{
    // THE ONE THAT MATTERS. A legacy expense with nothing recorded.
    const blank = openWith({ ...SERVER, expense: { id: 'EXP_01', amount: 20, payment_method: null } });
    ck('a legacy expense with no method opens BLANK, not Cash', blank.value === '',
       'showing Cash here would withdraw from petty cash on save, for money that may never have been cash');

    // Legacy free text, typed before the field was a dropdown. The server
    // rejects it, so offering it back would be an option that saves as null.
    const junk = openWith({ ...SERVER, expense: { id: 'EXP_02', amount: 20, payment_method: 'cash app' } });
    ck('  free text the server would reject also opens blank', junk.value === '',
       '"cash app" is not Cash — guessing would assert a fact nobody recorded');
    ck('    and is not offered as an option at all', !junk.options.includes('cash app'),
       'an option the server rejects saves as null — it looks like it took and it did not');

    const card = openWith({ ...SERVER, expense: { id: 'EXP_03', amount: 20, payment_method: 'Card' } });
    ck('an expense that says Card still opens on Card', card.value === 'Card',
       'the default must not overwrite a method that WAS recorded');

    const cash = openWith({ ...SERVER, expense: { id: 'EXP_04', amount: 20, payment_method: 'Cash' } });
    ck('  and one that says Cash opens on Cash', cash.value === 'Cash');
}

section('C — expenses recorded the old way still open correctly');
for (const old of ['Zelle', 'Wire', 'Cheque', 'Other']) {
    const r = openWith({ ...SERVER, expense: { id: 'EXP_09', amount: 20, payment_method: old } });
    ck(`a ${old} expense keeps its value`, r.value === old,
       `editing the description of an old ${old} expense must not erase how it was paid`);
    ck(`  ${old} is offered back to it`, r.options.includes(old));
    ck(`  marked as withdrawn`, r.labels.some((t) => t.includes(old) && /no longer offered/.test(t)),
       'unmarked, it reads as a live option and someone picks it on a new expense');

    // And only to THAT record — the retired value must not leak into the list
    // the next time the form opens for something else.
    const next = openWith({ ...SERVER, expense: null });
    ck(`  and ${old} is not offered on the next new expense`, !next.options.includes(old));
}

section('D — the form does not invent a default of its own');
{
    // If the server ever stops sending default_method, the box must fall back
    // to blank, not to a value hardcoded in the client. A client-side 'Cash'
    // would keep pre-selecting Cash long after the server stopped offering it,
    // and the disagreement would only surface as a rejected save.
    const noDefault = openWith({ methods: ['Cash', 'Card'], defaultMethod: '', expense: null });
    ck('no default from the server means no pre-selection', noDefault.value === '');

    // And the default is honoured as DATA, not assumed to be the string Cash.
    const other = openWith({ methods: ['Cash', 'Card'], defaultMethod: 'Card', expense: null });
    ck('the server decides WHICH one is default', other.value === 'Card',
       'a form that hardcodes Cash would pass the test above and still be wrong');
}

section('E — this APK against a server that has not been updated yet');
{
    // She installs the app before running the deploy on the VM, every time. In
    // that window the server sends no retired_methods, and the narrower rule
    // above cannot be applied safely: without the list, a stored "Zelle" and a
    // stored "cash app" are indistinguishable, and blanking both would erase a
    // real method on the next save. So the OLD behaviour is kept until the
    // list arrives — worse in one harmless way, never in a destructive one.
    const oldServer = { methods: ['Cash', 'Card'], retired: null, defaultMethod: 'Cash' };

    const zelle = openWith({ ...oldServer, expense: { id: 'EXP_05', amount: 20, payment_method: 'Zelle' } });
    ck('a real retired method is still offered back', zelle.value === 'Zelle',
       'blanking it here would erase how a real expense was paid, on save');

    const junk = openWith({ ...oldServer, expense: { id: 'EXP_06', amount: 20, payment_method: 'cash app' } });
    ck('  free text is offered back too, as it was before', junk.value === 'cash app',
       'harmless: it saves as null either way, which is where it was already headed');

    // The parts that do not depend on the list must work regardless.
    ck('  a new expense still opens on Cash',
       openWith({ ...oldServer, expense: null }).value === 'Cash');
    ck('  and a legacy expense with no method still opens blank',
       openWith({ ...oldServer, expense: { id: 'EXP_07', amount: 20, payment_method: null } }).value === '');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  Failed:'); failures.forEach((f) => console.log('   - ' + f)); }
process.exit(fail ? 1 : 0);
