// ── tests/books-screen.js — the books page actually RUNS ─────────────────
//
// dashboard/books.html is the screen Apsara will stand in front of when she
// decides whether QuickBooks can go in January. It has 12 functions and 421
// lines of script, and before this file NOT ONE of those functions had ever
// been called by a test. Four tests named the file; two mounted it; none
// invoked anything in it.
//
// That is the same gap that let claims.html ship dead for six days
// (#243): mounting a page proves the script PARSES. It does not prove that
// anything renders, because a function declaration that reads a variable it
// cannot see is perfectly valid until it runs.
//
// ── THE FIXTURE IS BUILT BY THE REAL CODE, NOT BY ME ─────────────────────
// Every shape the page reads — profitAndLoss, balanceSheet, trialBalance,
// agent, build — is produced here by helpers/statements.pack() and
// helpers/booksAgent.review(), the same two functions routes/money.js:664
// and :695 call. Journal LINES are the only thing written by hand, and they
// are the documented input to pack().
//
// This matters because a fixture I typed from reading the route could drift
// from what the route really sends and the test would keep passing. That is
// how a screen test comes to verify a shape nothing produces.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'books-screen-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated — refusing to run against her books');
    process.exit(1);
}
const FILE = path.join(ROOT, 'dashboard/books.html');

const S = require(path.join(ROOT, 'helpers/statements'));
const E = require(path.join(ROOT, 'helpers/entities'));
const A = require(path.join(ROOT, 'helpers/booksAgent'));
const B = require(path.join(ROOT, 'helpers/booksBuild'));

const ENTITY = E.ENTITIES[0].id;
const FROM = '2026-01-01';
const TO = '2026-09-30';

// A journal line, which is what pack() consumes. Two per transaction so the
// trial balance balances, because an unbalanced one takes a different path
// through the page and that is a separate case.
const line = (account, debit, credit) => ({
    account, debit, credit, entity: ENTITY, date: '2026-03-04',
    what: 'test', source: 'test',
});
const LINES = [
    line('4000', 0, 10000),      // material sales
    line('1100', 10000, 0),      // the money
    line('5000', 6000, 0),       // cost
    line('2000', 0, 6000),       // owed for it
];

function payload({ lines = LINES, complete = true, agentOver = null } = {}) {
    const opts = { from: FROM, to: TO, entity: ENTITY };
    const packed = S.pack(lines, opts);
    const built = B.build({ from: FROM, to: TO });
    const agent = { ...A.review(built, opts) };
    agent.summary = A.summary(agent);
    const chosen = E.get(ENTITY);
    return {
        companies: E.ENTITIES.map((x) => ({ id: x.id, name: x.uiName })),
        entity: ENTITY, from: FROM, to: TO,
        entityName: chosen.uiName,
        legalName: chosen.legalName || chosen.uiName,
        taxId: chosen.taxId || null,
        accounts: [],
        build: { transactions: lines.length, lines: lines.length, complete,
            unplaced: complete ? [] : [{ store: 'bills', rows: 3 }],
            problems: [], notes: [] },
        agent: agentOver ? { ...agent, ...agentOver } : agent,
        ...packed,
    };
}

function mount(responder) {
    const html = fs.readFileSync(FILE, 'utf8');
    const SCRIPT = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)]
        .map((m) => m[1]).join('\n');
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/books' });
    const w = dom.window;
    w.setInterval = () => 0;
    const calls = [];
    w.fetch = async (url) => { calls.push(String(url)); return responder(String(url)); };
    let evalError = null;
    try { w.eval(SCRIPT); } catch (e) { evalError = e; }
    return { dom, w, calls, evalError };
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const bad = (status, body) => ({ ok: false, status, json: async () => body });

// ── THE FORM HAS TO BE SET AFTER BOOT, AND THE TEST HAS TO CHECK (2026-10-30)
// My first version set these immediately after eval and counted fetches to
// decide which one to fail. Both were wrong, and together they manufactured
// a failure the page did not have:
//
//   · the page makes THREE requests, not two. A bare /api/books on boot
//     fills the company <select>; only then do its <option>s exist. Assigning
//     .value to a select with no matching option is a silent no-op, so the
//     company stayed '' and the request went out as `entity=`.
//   · counting calls then fed the 500 meant for the prior YEAR to the main
//     request, and the page correctly showed "Could not build the books" —
//     which my check read as the comparison having emptied the page.
//
// So: wait for boot, then set the form, then ASSERT it took. A fixture that
// silently fails to apply is the most expensive kind of green there is — the
// same lesson tests/bank-auto-tick.js already records about its seed().
async function settle(w, times = 3) {
    for (let i = 0; i < times; i += 1) await new Promise((r) => setTimeout(r, 0));
}

function setForm(w, { compare = false } = {}) {
    const q = (id) => w.document.getElementById(id);
    const sel = q('company');
    if (sel) {
        // Give the select the option if boot has not, so the assignment holds.
        if (![...sel.options].some((o) => o.value === ENTITY)) {
            const o = w.document.createElement('option');
            o.value = ENTITY; o.textContent = ENTITY;
            sel.appendChild(o);
        }
        sel.value = ENTITY;
    }
    if (q('from')) q('from').value = FROM;
    if (q('to')) q('to').value = TO;
    if (q('compare')) q('compare').checked = compare;
    return sel ? sel.value : null;
}

// Keyed on the URL, never on call order: the only thing that distinguishes
// the prior-year request is its dates.
const isPriorYear = (url) => /from=2025-/.test(url);

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — the fixture is the shape the ROUTE really sends');
// Asserted before anything uses it. A screen test on an invented shape is
// the self-referential fixture trap: it passes forever and proves nothing.
{
    const d = payload();
    for (const k of ['profitAndLoss', 'balanceSheet', 'trialBalance', 'agent', 'build',
        'entityName', 'legalName', 'from', 'to']) {
        ck(`  the response carries ${k}`, d[k] !== undefined, Object.keys(d).join(','));
    }
    ck('  and pack() produced it, not this file',
       d.trialBalance.accounts.length === 4 && d.trialBalance.balanced === true,
       JSON.stringify({ n: d.trialBalance.accounts.length, balanced: d.trialBalance.balanced }));
    ck('  with the income line the chart knows',
       (d.profitAndLoss.income || []).some((r) => r.code === '4000' && r.known === true),
       JSON.stringify(d.profitAndLoss.income));
}

// ══════════════════════════════════════════════════════════════════════════
section('B — it loads, and every renderer runs');
{
    const { w, evalError } = mount(() => ok(payload()));
    ck('the script evaluates', evalError === null,
       evalError && (evalError.constructor.name + ': ' + evalError.message));
    ck('  load() is reachable', typeof w.load === 'function', typeof w.load);
    await settle(w);
    ck('  the company select really holds the entity', setForm(w) === ENTITY,
       'assigning .value to a select with no matching option is a silent no-op, '
       + 'and every request below would then go out with entity=');
    let threw = null;
    try { await w.load(); } catch (e) { threw = e; }
    ck('load() completes without throwing', threw === null,
       threw && `${threw.constructor.name}: ${threw.message}`);

    const txt = (id) => (w.document.getElementById(id) || {}).innerHTML || '';
    ck('  the verdict is painted', txt('verdict').length > 20, txt('verdict').slice(0, 80));
    ck('  the four figures are painted', txt('kpis').length > 20, txt('kpis').slice(0, 80));
    ck('  and the statements are painted', txt('body').length > 200 && !/skel/.test(txt('body')),
       'the skeleton is still showing, so paint never replaced it');
    ck('  the P&L figure reaches the page', /10,000|10000/.test(txt('body') + txt('kpis')),
       'material sales of 10,000 went in and no 10,000 came out');
}

// ══════════════════════════════════════════════════════════════════════════
section('C — an incomplete build is SHOWN, not tucked away');
// routes/money.js:678 states the rule: "`complete` false means the
// statements below are SMALLER than the truth and look exactly like correct
// ones, so the screen must show this, not tuck it away." A page that hides
// it is worse than one with no figures, because she would file these.
{
    const { w } = mount(() => ok(payload({ complete: false })));
    await settle(w); setForm(w);
    await w.load();
    const all = w.document.body.innerHTML;
    ck('the page says the build is incomplete',
       /incomplete|could not place|unplaced|smaller than/i.test(all),
       'nothing on the page distinguishes a partial journal from a complete one');
}

// ══════════════════════════════════════════════════════════════════════════
section('D — a blocker opens itself');
// The page's own rule, at renderVerdict: "a blocker opens itself, because if
// the figures are wrong she should not have to click to learn why."
{
    const { w } = mount(() => ok(payload({ agentOver: {
        counts: { blocker: 1, high: 0 },
        findings: [{ severity: 'blocker', what: 'two companies in one journal',
            why: 'the totals mix taxpayers', fix: 'split them', where: 'entity-audit' }],
        summary: 'these cannot be filed',
    } })));
    await settle(w); setForm(w);
    await w.load();
    const v = w.document.getElementById('verdict').innerHTML;
    ck('the verdict says the figures are wrong', /do not use them yet/i.test(v), v.slice(0, 120));
    ck('  and it is open, not a triangle she has to find', /<details[^>]*\sopen/i.test(v),
       v.slice(0, 160));
    ck('  naming the finding and what to do', /two companies in one journal/.test(v)
       && /split them/.test(v), v.slice(0, 200));
}

// ══════════════════════════════════════════════════════════════════════════
section('E — a failed request says so instead of going blank');
// The claims outage reached her as "Could not load claims". The equivalent
// here must be a message, not an empty page or a silent skeleton.
{
    const { w } = mount(() => bad(500, { error: 'the journal could not be built' }));
    await settle(w); setForm(w);
    let threw = null;
    try { await w.load(); } catch (e) { threw = e; }
    ck('load() handles the failure itself', threw === null,
       threw && `${threw.constructor.name}: ${threw.message} — an unhandled throw here is a blank page`);
    const all = w.document.body.innerHTML;
    ck('  and the reason is on the page', /could not be built|could not load|error/i.test(all),
       all.slice(0, 200));
}

// ══════════════════════════════════════════════════════════════════════════
section('F — the comparison year cannot break the page');
// load()'s own note: "a year with no data is a normal answer, not an error,
// so a failure here leaves the deltas off rather than emptying the page."
{
    let priorAsked = 0;
    const { w } = mount((url) => {
        if (isPriorYear(url)) { priorAsked += 1; return bad(500, { error: 'no such year' }); }
        return ok(payload());
    });
    await settle(w);
    ck('the company select holds the entity', setForm(w, { compare: true }) === ENTITY);
    let threw = null;
    try { await w.load(); } catch (e) { threw = e; }
    ck('a failed prior-year request does not break the load', threw === null,
       threw && `${threw.constructor.name}: ${threw.message}`);
    ck('  the period figures are still there',
       (w.document.getElementById('kpis').innerHTML || '').length > 20,
       'the comparison emptied the page it was meant to annotate');
    ck('  and it really did ask for the year before', priorAsked >= 1,
       `${priorAsked} prior-year request(s) — if zero, this section tested nothing`);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }

})().catch((e) => { console.error('\nCRASHED: ' + (e && e.stack || e)); process.exit(1); });
