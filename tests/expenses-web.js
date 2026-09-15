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
    // The server's real list, so a suggestion can never be the odd one out.
    categories: ['Fuel', 'Freight', 'Equipment', 'Repairs & maintenance', 'Labour',
                 'Rent', 'Utilities', 'Supplies', 'Permits & fees', 'Insurance', 'Other'],
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

section('F — "Is this for Santiago?"');
{
    // Apsara, 2026-09-15: "if they say salay santiago-it means that salary for
    // santiago..when they type in app-it should read the description and ask
    // user whether they mean salary for santiago????" — and, asked how: "ai
    // assistant should handle that".
    //
    // The form asks ON BLUR, not on save: a suggestion service having a slow
    // day must not feel like the Save button being slow. And it asks only
    // when the vendor box is empty, because second-guessing a name she typed
    // is worse than useless.
    const mk = (suggestion) => {
        const calls = [];
        const dom = new JSDOM(HTML, {
            runScripts: 'dangerously', url: 'http://localhost/',
            beforeParse(w) {
                w.fetch = (u, o) => {
                    const k = String(u).split('?')[0];
                    if (k === '/api/expenses/suggest-vendor') {
                        calls.push(JSON.parse(o.body));
                        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(suggestion) });
                    }
                    if (o && o.method && o.method !== 'GET') {
                        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, expense: {} }) });
                    }
                    const body = k === '/api/expenses' ? EXPENSES
                        : k === '/api/me' ? { ok: true, role: 'admin' } : { ok: true };
                    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
                };
                w.alert = () => {}; w.confirm = () => true;
            },
        });
        return { dom, calls };
    };
    const blur = (d, dom) => {
        const el = d.getElementById('exp_description');
        el.dispatchEvent(new dom.window.Event('blur'));
    };

    {
        const { dom, calls } = mk({ ok: true, suggest: true, vendor: 'Santiago', known: true,
                                    question: 'Is this for Santiago?' });
        await new Promise((r) => setTimeout(r, 600));
        const w = dom.window, d = w.document;
        await w.renderExpensesTab();
        w.openExpenseModal(null);
        d.getElementById('exp_description').value = 'Weekly salary Santiago';
        blur(d, dom);
        await new Promise((r) => setTimeout(r, 120));

        ck('it asks about the description she typed', calls.length === 1
           && calls[0].description === 'Weekly salary Santiago', JSON.stringify(calls));
        const box = d.getElementById('expVendorAsk');
        ck('  and puts the question on screen', /Is this for Santiago\?/.test(box.textContent), box.textContent);
        ck('  without having filled anything in yet',
           d.getElementById('exp_vendor').value === '',
           'nothing is written until she says yes');

        d.querySelector('.expAskYes').click();
        ck('saying Yes fills the vendor', d.getElementById('exp_vendor').value === 'Santiago');
        ck('  and the question goes away', box.style.display === 'none');
        dom.window.close();
    }
    {
        const { dom, calls } = mk({ ok: true, suggest: true, vendor: 'Santiago', known: true,
                                    question: 'Is this for Santiago?' });
        await new Promise((r) => setTimeout(r, 600));
        const w = dom.window, d = w.document;
        await w.renderExpensesTab();
        w.openExpenseModal(null);
        d.getElementById('exp_description').value = 'Weekly salary Santiago';
        blur(d, dom);
        await new Promise((r) => setTimeout(r, 120));
        d.querySelector('.expAskNo').click();
        ck('saying No leaves the vendor empty', d.getElementById('exp_vendor').value === '');
        // Re-asking the same line is how a helpful prompt becomes a nag.
        blur(d, dom);
        await new Promise((r) => setTimeout(r, 120));
        ck('  and the same line is not asked about twice', calls.length === 1,
           `asked ${calls.length} times`);
        dom.window.close();
    }
    {
        const { dom, calls } = mk({ ok: true, suggest: true, vendor: 'Santiago', known: true,
                                    question: 'Is this for Santiago?' });
        await new Promise((r) => setTimeout(r, 600));
        const w = dom.window, d = w.document;
        await w.renderExpensesTab();
        w.openExpenseModal(null);
        d.getElementById('exp_vendor').value = 'Chevron';
        d.getElementById('exp_description').value = 'Weekly salary Santiago';
        blur(d, dom);
        await new Promise((r) => setTimeout(r, 120));
        ck('a vendor she already typed is never second-guessed', calls.length === 0,
           JSON.stringify(calls));
        ck('  and it is left exactly as she typed it',
           d.getElementById('exp_vendor').value === 'Chevron');
        dom.window.close();
    }
    {
        // The service being down, slow or unconfigured must be invisible.
        const { dom } = mk({ ok: true, suggest: false, why: 'no_answer' });
        await new Promise((r) => setTimeout(r, 600));
        const w = dom.window, d = w.document;
        await w.renderExpensesTab();
        w.openExpenseModal(null);
        d.getElementById('exp_description').value = 'Weekly salary Santiago';
        blur(d, dom);
        await new Promise((r) => setTimeout(r, 120));
        ck('no suggestion means nothing on screen at all',
           d.getElementById('expVendorAsk').style.display === 'none');
        ck('  and the form is still perfectly usable',
           d.getElementById('expSave').disabled === false);
        dom.window.close();
    }
}

section('G — what it was FOR, and when that is genuinely unclear');
{
    // Apsara, 2026-09-15: "Also,Salary paid $200 for tools why cant ai figure
    // out what it is for?"
    //
    // It can — and her own example is the case where the honest answer is to
    // ASK rather than pick. "Salary" argues for Labour; "for tools" argues for
    // Equipment. Choosing one files money under a heading she never picked,
    // silently, which is the failure this whole evening has been about.
    const mk = (suggestion) => {
        const calls = [];
        const dom = new JSDOM(HTML, {
            runScripts: 'dangerously', url: 'http://localhost/',
            beforeParse(w) {
                w.fetch = (u, o) => {
                    const k = String(u).split('?')[0];
                    if (k === '/api/expenses/suggest-vendor') {
                        calls.push(JSON.parse(o.body));
                        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(suggestion) });
                    }
                    if (o && o.method && o.method !== 'GET') {
                        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, expense: {} }) });
                    }
                    const body = k === '/api/expenses' ? EXPENSES
                        : k === '/api/me' ? { ok: true, role: 'admin' } : { ok: true };
                    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
                };
                w.alert = () => {}; w.confirm = () => true;
            },
        });
        return { dom, calls };
    };
    const blur = (d, dom) => d.getElementById('exp_description')
        .dispatchEvent(new dom.window.Event('blur'));

    {
        // HER EXACT LINE.
        const { dom, calls } = mk({ ok: true, suggest: true, kind: 'category',
            ambiguous: ['Labour', 'Equipment'], question: 'Is this Labour or Equipment?' });
        await new Promise((r) => setTimeout(r, 600));
        const w = dom.window, d = w.document;
        await w.renderExpensesTab();
        w.openExpenseModal(null);
        d.getElementById('exp_description').value = 'Salary paid $200 for tools';
        blur(d, dom);
        await new Promise((r) => setTimeout(r, 120));

        ck('the selected category is sent, so the answer can disagree with it',
           calls.length === 1 && typeof calls[0].category === 'string', JSON.stringify(calls));
        const box = d.getElementById('expVendorAsk');
        ck('an ambiguous line ASKS instead of picking',
           /Is this Labour or Equipment\?/.test(box.textContent), box.textContent);
        ck('  offering both by name', d.querySelectorAll('.expAskOpt').length === 2,
           String(d.querySelectorAll('.expAskOpt').length));
        ck('  with neither chosen for her yet',
           d.getElementById('exp_category').value !== 'Equipment');

        d.querySelectorAll('.expAskOpt')[1].click();
        ck('picking one sets it', d.getElementById('exp_category').value === 'Equipment',
           d.getElementById('exp_category').value);
        ck('  and the question clears', box.style.display === 'none');
        dom.window.close();
    }
    {
        // ── A <select> SET TO A MISSING OPTION DOES NOTHING, SILENTLY ──────
        // She clicks, the box does not change, and nothing on screen says
        // why. It should be unreachable — a suggestion can only offer a
        // category from the same server list that builds this dropdown — and
        // that is exactly the kind of "should" worth guarding.
        const { dom } = mk({ ok: true, suggest: true, kind: 'category', category: 'Demurrage',
            question: 'Is this Demurrage?' });
        await new Promise((r) => setTimeout(r, 600));
        const w = dom.window, d = w.document;
        await w.renderExpensesTab();
        w.openExpenseModal(null);
        ck('fixture sanity: the dropdown does not offer Demurrage',
           ![...d.getElementById('exp_category').options].some((o) => o.value === 'Demurrage'));
        d.getElementById('exp_description').value = 'Container sat at the port';
        blur(d, dom);
        await new Promise((r) => setTimeout(r, 120));
        d.querySelector('.expAskYes').click();
        ck('a category the dropdown lacks is ADDED, not silently ignored',
           d.getElementById('exp_category').value === 'Demurrage',
           d.getElementById('exp_category').value);
        dom.window.close();
    }
    {
        // A clear line that disagrees with the box.
        const { dom } = mk({ ok: true, suggest: true, kind: 'category', category: 'Fuel',
            question: 'This reads like Fuel rather than Supplies. Change it?' });
        await new Promise((r) => setTimeout(r, 600));
        const w = dom.window, d = w.document;
        await w.renderExpensesTab();
        w.openExpenseModal(null);
        // Set to something else FIRST, or "Keep" proves nothing: Fuel is the
        // first option and a new expense already has it selected.
        d.getElementById('exp_category').value = 'Supplies';
        d.getElementById('exp_description').value = 'Diesel for the loader';
        blur(d, dom);
        await new Promise((r) => setTimeout(r, 120));
        ck('a clear mismatch offers the change',
           /reads like Fuel/.test(d.getElementById('expVendorAsk').textContent));
        d.querySelector('.expAskNo').click();
        ck('  and Keep leaves her category alone',
           d.getElementById('exp_category').value === 'Supplies',
           'her choice stands unless she changes it');
        dom.window.close();
    }
    {
        // Both questions from one line: vendor first, category after.
        const { dom } = mk({ ok: true, suggest: true, kind: 'vendor', vendor: 'Santiago', known: true,
            question: 'Is this for Santiago?',
            category_hint: { category: 'Labour', question: 'This reads like Labour rather than Fuel. Change it?' } });
        await new Promise((r) => setTimeout(r, 600));
        const w = dom.window, d = w.document;
        await w.renderExpensesTab();
        w.openExpenseModal(null);
        d.getElementById('exp_description').value = 'Weekly salary Santiago';
        blur(d, dom);
        await new Promise((r) => setTimeout(r, 120));

        const box = d.getElementById('expVendorAsk');
        ck('the vendor is asked FIRST', /Is this for Santiago\?/.test(box.textContent), box.textContent);
        ck('  and only one question is on screen at a time',
           !/reads like Labour/.test(box.textContent), box.textContent);
        d.querySelector('.expAskYes').click();
        await new Promise((r) => setTimeout(r, 20));
        ck('answering it brings up the category question',
           /reads like Labour/.test(box.textContent), box.textContent);
        ck('  with the vendor already set from the first answer',
           d.getElementById('exp_vendor').value === 'Santiago');
        d.querySelector('.expAskYes').click();
        ck('  and answering that sets the category too',
           d.getElementById('exp_category').value === 'Labour');
        dom.window.close();
    }
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('\n  THREW:', e.stack || e.message); process.exit(1); });
