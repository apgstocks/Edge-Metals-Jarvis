// ── tests/expenses-web.js ─────────────────────────────────────────────────
// Apsara, 2026-09-15: "there is a expense tab in app but not website", and,
// asked how far to take it, chose the full tab — list, add, edit, delete.
//
// WHY THIS FILE EXISTS AND form-parity.js WAS NOT ENOUGH
// -----------------------------------------------------
// The parity assertions added there are source-text greps. They prove the
// screen MENTIONS a rule; they cannot prove it OBEYS one. Three mutations
// walked straight through them:
//
//   · deleting the dispatch line — renderExpensesTab was still defined, so
//     the grep matched while the tab was unreachable
//   · defaulting the method on an EDIT as well as a new expense — the
//     original line was untouched, so the grep matched
//   · disabling the petty-cash shortfall warning with `if (false)` — the
//     string cash_shortfall was still in the file
//
// Each is a rule about money or about reaching the screen at all. So this
// renders the real page in jsdom and drives it, the way load-card-actions
// runs the real functions rather than a copy of them.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8');

const EXPENSES = {
    ok: true,
    categories: ['Fuel', 'Repairs', 'Other'],
    methods: ['Cash', 'Card'],
    default_method: 'Cash',
    retired_methods: ['Zelle', 'Cheque'],
    petty_cash_balance: 1200,
    expenses: [
        { id: 'EXP_3', date: '2026-09-09', category: 'Repairs', description: 'Loader belt',
          vendor: 'Santiago Welding', payment_method: 'Zelle', amount: 510.5 },
        { id: 'EXP_2', date: '2026-09-02', category: 'Repairs', description: 'Forklift hose',
          vendor: 'Santiago', payment_method: 'Cash', amount: 240 },
        // Free text typed before the field was a dropdown. The server would
        // reject it, so offering it back is an option that silently does not
        // take — her rule for these was "leave old entries blank".
        { id: 'EXP_1', date: '2026-09-02', category: 'Fuel', description: 'Diesel',
          vendor: 'Chevron', payment_method: 'cash app', amount: 300 },
        // No method at all. The one an edit must NOT quietly set to Cash.
        { id: 'EXP_0', date: '2026-09-01', category: 'Other', description: 'Parking',
          vendor: null, payment_method: null, amount: 12 },
    ],
    report: { total: 1062.5, count: 4, byCategory: [], byDay: [{ date: '2026-09-09', amount: 510.5 }] },
};

function boot({ saveResponse = { ok: true, expense: {} } } = {}) {
    const posted = [];
    const alerts = [];
    const dom = new JSDOM(HTML, {
        runScripts: 'dangerously', url: 'http://localhost/',
        beforeParse(w) {
            w.fetch = (u, o) => {
                const k = String(u).split('?')[0];
                if (o && o.method && o.method !== 'GET') {
                    posted.push({ path: k, method: o.method, body: o.body ? JSON.parse(o.body) : null });
                    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(saveResponse) });
                }
                const body = k === '/api/expenses' ? EXPENSES
                    : k === '/api/me' ? { ok: true, role: 'admin' } : { ok: true };
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
            };
            w.alert = (m) => alerts.push(String(m));
            w.confirm = () => true;
        },
    });
    return { dom, posted, alerts };
}

(async () => {

section('A — the tab is reachable and lists what was spent');
{
    const { dom } = boot();
    await new Promise((r) => setTimeout(r, 600));
    const w = dom.window, d = w.document;

    // THE DISPATCH, not the function. A mutation deleting the routing line
    // left renderExpensesTab defined and unreachable, and every source-text
    // assertion still passed.
    // NAV_ITEMS is a top-level `const`, which creates a script-scope binding
    // and NOT a window property — only `var` and function declarations do
    // that. So it is read from source rather than off the window, where it
    // was undefined and two assertions failed for a reason that had nothing
    // to do with the tab.
    const src = fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8');
    ck('the nav offers Expenses',
       /\{ id: 'expenses', label: 'Expenses', group: 'Yard', adminOnly: true \}/.test(src),
       'the entry must exist, be labelled, and be admin-only');
    // The DISPATCH, not the function. A mutation deleting the routing line
    // left renderExpensesTab defined and unreachable, and every source-text
    // assertion still passed.
    ck('  and clicking it actually reaches the tab',
       /if \(tab === 'expenses'\) return renderExpensesTab\(\);/
         .test(fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8')),
       'defined but unrouted is the shape that passed every grep');

    await w.renderExpensesTab();
    const text = d.getElementById('viewRoot').textContent;
    ck('every expense is listed', d.querySelectorAll('.btn-edit-expense').length === 4,
       String(d.querySelectorAll('.btn-edit-expense').length));
    ck('  naming the vendor, which is what the totals never could',
       /Santiago Welding/.test(text) && /Chevron/.test(text));
    ck('  with the all-time total', /1,062\.50/.test(text), text.slice(0, 160));
    ck('  and every row can be edited and deleted',
       d.querySelectorAll('.btn-delete-expense').length === 4);
    dom.window.close();
}

section('B — the method rules, which are rules about money');
{
    const { dom } = boot();
    await new Promise((r) => setTimeout(r, 600));
    const w = dom.window, d = w.document;
    await w.renderExpensesTab();
    const open = (id) => d.querySelector(`.btn-edit-expense[data-id="${id}"]`).click();

    open('EXP_3');
    ck('a RETIRED method is kept on the expense that has it',
       d.getElementById('exp_payment').value === 'Zelle', d.getElementById('exp_payment').value);
    ck('  and marked as no longer offered',
       /no longer offered/.test(d.getElementById('exp_payment').innerHTML));

    open('EXP_1');
    ck('legacy free text shows blank, not as a selectable option',
       d.getElementById('exp_payment').value === '',
       'offering it back saves as null — an option that silently does not take');

    // ── THE ONE A MUTATION WALKED THROUGH ─────────────────────────────────
    // An old expense with no method must NOT come up reading "Cash". Saving
    // would rewrite it AND withdraw from petty cash for money that may never
    // have left the box.
    open('EXP_0');
    ck('an expense with no method stays blank on EDIT',
       d.getElementById('exp_payment').value === '',
       `got "${d.getElementById('exp_payment').value}" — the default belongs to a NEW expense only`);

    w.openExpenseModal(null);
    ck('  while a NEW expense does default to the server\'s choice',
       d.getElementById('exp_payment').value === 'Cash', d.getElementById('exp_payment').value);
    dom.window.close();
}

section('C — saving, and the warning that must not go quiet');
{
    const { dom, posted, alerts } = boot({
        // The box did not cover it: cash left the drawer that was never
        // entered, and the balance is now negative.
        saveResponse: { ok: true, expense: { id: 'EXP_9', cash_shortfall: 40.25 } },
    });
    await new Promise((r) => setTimeout(r, 600));
    const w = dom.window, d = w.document;
    await w.renderExpensesTab();

    w.openExpenseModal(null);
    d.getElementById('exp_description').value = 'Diesel';
    d.getElementById('exp_amount').value = '55.25';
    d.getElementById('exp_vendor').value = 'Chevron';
    d.getElementById('expSave').click();
    await new Promise((r) => setTimeout(r, 250));

    const sent = posted.find((p) => p.path === '/api/expenses' && p.method === 'POST');
    ck('it posts the expense', !!sent, JSON.stringify(posted));
    ck('  carrying every field the app sends',
       sent && sent.body.description === 'Diesel' && sent.body.vendor === 'Chevron'
       && sent.body.amount === '55.25' && sent.body.payment_method === 'Cash'
       && !!sent.body.date && !!sent.body.category,
       JSON.stringify(sent && sent.body));

    // A negative petty-cash balance nobody mentions is one nobody reconciles.
    // A mutation disabling this with `if (false)` left the string in the file
    // and passed every grep.
    ck('a short petty-cash box is said OUT LOUD',
       alerts.some((m) => /petty cash was/i.test(m)), JSON.stringify(alerts));
    ck('  naming the amount', alerts.some((m) => /40\.25/.test(m)), JSON.stringify(alerts));
    ck('  and the modal closes on success', !d.getElementById('expenseModal'));
    dom.window.close();
}

section('D — a rejected save keeps the form open and says why');
{
    const posted = [];
    const dom = new JSDOM(HTML, {
        runScripts: 'dangerously', url: 'http://localhost/',
        beforeParse(w) {
            w.fetch = (u, o) => {
                const k = String(u).split('?')[0];
                if (o && o.method && o.method !== 'GET') {
                    return Promise.resolve({ ok: false, status: 400,
                        json: () => Promise.resolve({ error: 'Validation: description is required.' }) });
                }
                const body = k === '/api/expenses' ? EXPENSES
                    : k === '/api/me' ? { ok: true, role: 'admin' } : { ok: true };
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
            };
            w.alert = () => {}; w.confirm = () => true;
        },
    });
    await new Promise((r) => setTimeout(r, 600));
    const w = dom.window, d = w.document;
    await w.renderExpensesTab();
    w.openExpenseModal(null);
    d.getElementById('exp_amount').value = '10';
    d.getElementById('expSave').click();
    await new Promise((r) => setTimeout(r, 250));

    ck('the form stays open so the typing is not lost', !!d.getElementById('expenseModal'));
    ck('  showing the server\'s reason', /description is required/.test(d.getElementById('expErr').textContent),
       d.getElementById('expErr').textContent);
    ck('  without our internal "Validation:" label',
       !/Validation:/.test(d.getElementById('expErr').textContent),
       d.getElementById('expErr').textContent);
    ck('  and the Save button is usable again',
       d.getElementById('expSave').disabled === false);
    dom.window.close();
}

section('E — modals do not stack up across visits');
{
    const { dom } = boot();
    await new Promise((r) => setTimeout(r, 600));
    const w = dom.window, d = w.document;
    await w.renderExpensesTab();
    w.openExpenseModal(null);
    w.openExpenseModal(null);
    w.openExpenseModal(null);
    ck('opening three times leaves exactly one modal',
       d.querySelectorAll('#expenseModal').length === 1,
       String(d.querySelectorAll('#expenseModal').length));
    w.closeExpenseModal();
    ck('  and closing removes it from the page entirely',
       d.querySelectorAll('#expenseModal').length === 0);
    dom.window.close();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('\n  THREW:', e.stack || e.message); process.exit(1); });
