// ── tests/qb-agent.js ─────────────────────────────────────────────────────
// Apsara, 2026-10-01: "Assign one agent for quickbook next" and "so
// (bills+invoice) agent should talk to this agent".
//
// ── WHY SECTION A IS THE IMPORTANT ONE ────────────────────────────────────
// qbAgent translates push.js's English problem strings into field names. That
// makes a CONTRACT BETWEEN TWO FILES, matched by regex, with nothing to make
// it break loudly when one side is reworded.
//
// That is exactly the bug shape that cost this morning: helpers/ledgerAgent's
// sheet source read `rep.differing`, a key metalsSheetSync has never
// produced. Nothing threw. The source returned nothing, for ever, and the
// email looked clean — and the unit tests passed because they handed it a
// fixture written against the same wrong key.
//
// So section A does not use fixtures. It reads the problem strings OUT OF
// push.js and asserts the agent still recognises every one. Reword a problem
// there and this goes red, which is the only thing that stops the agent
// silently reclassifying a fillable blank as "reason not recognised".

const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');

process.env.JARVIS_TEST = '1';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-qbagent-'));
process.env.DATA_DIR = TMP;

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

(async () => {

const qb = require('../helpers/qbAgent');
const agent = require('../helpers/ledgerAgent');

// ── A — THE CONTRACT WITH push.js, READ FROM push.js ──────────────────────
{
    section('A — every problem push.js can produce is classified');

    const src = fs.readFileSync(path.join(ROOT, 'helpers/quickbooks/push.js'), 'utf8');

    // Harvest every problems.push(...) argument. Both quote styles and
    // template literals; template placeholders become a plausible value so
    // the string looks like one a real run produces.
    const found = [];
    const re = /problems\.push\(\s*(`[^`]*`|'[^']*'|"[^"]*")\s*\)/g;
    let m;
    while ((m = re.exec(src))) {
        const raw = m[1];
        let lit = raw.slice(1, -1);
        if (raw[0] === '`') {
            lit = lit
                .replace(/\$\{DOC_MAX\}/g, '21')
                .replace(/\$\{env\}/g, 'sandbox')
                .replace(/\$\{g\.grade\}/g, 'Al Combo')
                .replace(/\$\{itemNames\[g\]\}/g, 'Aluminium')
                .replace(/\$\{vendor\.name\}/g, 'Calderon')
                .replace(/\$\{total\}/g, '1250.00')
                .replace(/\$\{b\.net_payable\}/g, '1240.00')
                // anything left: a generic value rather than a literal ${...}
                .replace(/\$\{[^}]*\}/g, 'X');
        }
        found.push(lit);
    }

    ck(`push.js's problem strings were found (${found.length})`,
       found.length >= 8,
       'if this is near zero the harvest regex broke and section A is measuring nothing — ' + JSON.stringify(found));

    const unknown = [];
    for (const p of found) {
        const c = qb.classifyProblem(p);
        if (!c || c.side === 'unknown') unknown.push(p);
    }
    ck('every one is recognised — none falls through to "unknown"',
       unknown.length === 0,
       'reworded in push.js, stale in qbAgent: ' + JSON.stringify(unknown));

    // And the split is the one the design depends on.
    const sideOf = (p) => (qb.classifyProblem(p) || {}).side;
    ck('a missing Jarvis value is the ledger agent\'s side',
       sideOf('no bill date') === 'jarvis' && sideOf('no supplier amount yet') === 'jarvis',
       `${sideOf('no bill date')} / ${sideOf('no supplier amount yet')}`);
    ck('a missing QuickBooks vendor is hers, not the agent\'s',
       sideOf('vendor "Calderon" not found in QuickBooks sandbox') === 'quickbooks');
    ck('an unmapped grade is hers too',
       sideOf('grade "Al Combo" has no QuickBooks item') === 'quickbooks');
    ck('  but a grade with no AMOUNT is a Jarvis blank',
       sideOf('grade "Al Combo" has no amount') === 'jarvis',
       'two problems one word apart, and they go to different people');
    ck('lines-vs-payable is a disagreement only she can settle',
       sideOf('lines add to 1250 but Jarvis says 1240 is payable') === 'her');

    // ── AND IT NEVER GUESSES ─────────────────────────────────────────────
    // A sentence this file does not know must be reported verbatim. A
    // catch-all that guessed a field would become a wrong auto-fill in her
    // ledger, which is the worst outcome available here.
    const odd = qb.classifyProblem('the flux capacitor is misaligned');
    ck('an unrecognised problem is "unknown", not guessed',
       odd.side === 'unknown' && !odd.field, JSON.stringify(odd));
    ck('  and it is carried verbatim',
       odd.problem === 'the flux capacitor is misaligned');
}

// ── B — THE HANDOFF ───────────────────────────────────────────────────────
{
    section('B — the two agents talking');

    const look = {
        rowsSeen: 9,
        blocked: [
            { kind: 'bill', id: 'BILL_1', container_no: 'TGCU0053611', party: 'Calderon',
              problems: ['no bill date', 'vendor "Calderon Metals" not found in QuickBooks sandbox'] },
            { kind: 'sale', id: 'SALE_9', container_no: 'MSDU1161015', invoice_no: '26MK80', party: 'MK',
              problems: ['no supplier amount yet'] },
            { kind: 'billpayment', id: 'PAY_3', party: 'Hugo',
              problems: ['no bill date'] },
        ].map((b) => ({ ...b, found: b.problems.map(qb.classifyProblem) })),
    };

    const map = qb.blockingFields(look);
    ck('a blocking Jarvis blank is handed over, keyed ledger:row:field',
       map.has('bills:BILL_1:date') && map.has('sales:SALE_9:amount'),
       [...map.keys()].join(' '));
    ck('  keyed by container too, because push links by either',
       map.has('bills:TGCU0053611:date'),
       'push.js links by `id || container_no`; a finding may carry only one');
    ck('a QuickBooks-side problem is NOT handed over',
       ![...map.values()].some((v) => /vendor/i.test(v.why || '')),
       'the ledger agent cannot create a vendor and must not be asked to');

    // ── THE SIDE CHECK IS LOAD-BEARING, NOT DECORATION ───────────────────
    // A mutation that dropped `f.side !== 'jarvis'` and kept only `!f.field`
    // SURVIVED, because no QB_SIDE entry happens to carry a field today. So
    // the guard looks redundant — and would stop being redundant, silently,
    // the moment someone adds a field to one of them (a QuickBooks account
    // name, say). That is the handoff sending the ledger agent to fill a
    // field only QuickBooks can supply, for ever, because filling it in
    // Jarvis changes nothing about her books.
    //
    // So this gives a QuickBooks-side finding a field and asserts it is
    // STILL not handed over. The guard is what it tests.
    const withField = qb.blockingFields({ blocked: [{
        kind: 'bill', id: 'BILL_Z', container_no: 'ZZZZ9999999',
        found: [{ side: 'quickbooks', field: 'supplier', problem: 'vendor "Q" not found',
                  what: 'vendor "Q" is not in QuickBooks' }],
    }] });
    ck('  even one that carries a field name',
       withField.size === 0,
       'only a JARVIS-side blank may be handed over — ' + JSON.stringify([...withField.keys()]));

    // And the mirror: a Jarvis-side finding with no field is not handed over
    // either, because there is nothing for the ledger agent to fill.
    const noField = qb.blockingFields({ blocked: [{
        kind: 'bill', id: 'BILL_Y', container_no: 'YYYY8888888',
        found: [{ side: 'jarvis', problem: 'something is missing' }],
    }] });
    ck('  and a Jarvis-side one with no field is not either',
       noField.size === 0, JSON.stringify([...noField.keys()]));
    ck('a PAYMENT is not handed over — it is not a ledger row the agent fills',
       !map.has('billpayment:PAY_3:date') && ![...map.keys()].some((k) => k.includes('PAY_3')),
       [...map.keys()].join(' '));

    // ── URGENCY DOES NOT MOVE THE MONEY LINE ─────────────────────────────
    // The whole point. "But this one is blocking the books" is precisely the
    // argument a money control exists to refuse.
    const marked = agent.markBlocking([
        { ledger: 'bills', row_id: 'BILL_1', what: 'TGCU0053611 — Calderon',
          fix: { field: 'date', from: '', to: '2026-09-20', from_source: 'the sheet' } },
        { ledger: 'bills', row_id: 'BILL_1', what: 'TGCU0053611 — Calderon',
          fix: { field: 'seal_no', from: '', to: 'SL-1', from_source: 'the sheet' } },
        { ledger: 'sales', row_id: 'SALE_9', what: 'MSDU1161015 — MK',
          fix: { field: 'amount', from: '', to: '41200', from_source: 'the sheet' } },
    ], map);

    ck('the blocking blank is marked', marked[0].blocks_quickbooks === true);
    ck('  and says so where she will read it',
       /QuickBooks cannot take this row until date/.test(marked[0].detail), marked[0].detail);
    ck('an ordinary blank is NOT marked', !marked[1].blocks_quickbooks);

    const sorted = agent.sort(marked);
    ck('a blocking MONEY field is still only proposed',
       sorted.proposed.some((f) => f.fix.field === 'amount')
       && !sorted.settled.some((f) => f.fix.field === 'amount'),
       'urgency must never promote money past her — ' + JSON.stringify(sorted.settled.map((f) => f.fix.field)));
    ck('  and the non-money blocking field is still settled',
       sorted.settled.some((f) => f.fix.field === 'date'));

    ck('blocking findings sort first',
       agent.blockingFirst(marked)[0].fix.field === 'date');

    // An empty map must not change anything — the no-QuickBooks case.
    const untouched = agent.markBlocking(marked, new Map());
    ck('with nothing blocking, findings are returned unchanged',
       untouched.length === marked.length && untouched[1] === marked[1],
       'a run with QuickBooks off must behave exactly as before');
}

// ── C — WHAT IT WRITES: NOTHING ───────────────────────────────────────────
{
    section('C — it writes nothing, anywhere');

    const src = fs.readFileSync(path.join(ROOT, 'helpers/qbAgent.js'), 'utf8');
    ck('no apply()', !/\bfunction apply\b|\bapply\s*[:=]\s*(async\s*)?\(/.test(src));
    ck('it never edits a ledger row',
       !/editBill|editSale|mutateJson|writeFileSync/.test(src),
       'this agent reports; the ledger agent is the only one that writes');
    ck('it never journals',
       !/journal\.record|recordWrite/.test(src),
       'a journal entry is a claim that something happened in her books');
    ck('it never pushes',
       !/pushBill|pushInvoice|pushCustomerPayment|pushBillPayment/.test(src),
       'pushing stays behind QB_PROD_WRITES and QB_SYNC — her switches');
    // ── WHAT IT CAN REACH, NOT WHAT IT MENTIONS ──────────────────────────
    // The first version of this check grepped for 'create-party' and went
    // red on the HINT STRING — the line telling her to run that script
    // herself. Naming a script is the opposite of calling it. So the check
    // is now about the modules this file can actually reach: a vendor
    // invented at 7am is a line in her chart of accounts she did not choose,
    // and it cannot be created by code that never loads the thing that
    // creates it.
    const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
    ck('the only QuickBooks module it can reach is the read-only sweep',
       requires.filter((r) => /quickbooks/.test(r)).every((r) => r === './quickbooks/sync'),
       'reachable: ' + JSON.stringify(requires));
    // Matched on the BASENAME. The first version used /books/ and matched
    // inside "./quickbooks/sync" — a check that failed on the one module it
    // was meant to allow.
    const base = (r) => String(r).split('/').pop();
    const FORBIDDEN = ['riskyOps', 'push', 'pushInvoice', 'pushPayments', 'pushList',
        'journal', 'client', 'auth', 'books', 'applyPayments', 'mapping', 'routes'];
    ck('  and it cannot reach party creation, push, or the journal',
       !requires.some((r) => FORBIDDEN.includes(base(r))),
       'reachable: ' + JSON.stringify(requires.map(base)));
    ck('it sweeps DRY',
       /dryRun:\s*true/.test(src) && !/dryRun:\s*false/.test(src));
}

// ── D — THE REPORT ────────────────────────────────────────────────────────
{
    section('D — the report');

    ck('nothing blocked means no email at all',
       qb.reportText({ blocked: [], rowsSeen: 12 }) === null,
       'a daily all-clear for a month is an email she stops opening');

    const look = {
        rowsSeen: 9,
        blocked: [
            { kind: 'bill', id: 'B1', container_no: 'TGCU0053611', party: 'Calderon',
              problems: ['no bill date', 'vendor "Calderon Metals" not found in QuickBooks sandbox'] },
            { kind: 'bill', id: 'B2', container_no: 'XXXU0000000', party: 'Z',
              problems: ['something nobody has seen before'] },
        ].map((b) => ({ ...b, found: b.problems.map(qb.classifyProblem) })),
    };
    const text = qb.reportText(look);

    ck('a QuickBooks-side problem is listed, with what to do',
       /vendor "Calderon Metals" is not in QuickBooks/.test(text)
       && /qb-create-party/.test(text), text);
    ck('an unrecognised reason gets its own section, verbatim',
       /REASON NOT RECOGNISED/.test(text) && /something nobody has seen before/.test(text));
    ck('a Jarvis blank is COUNTED, not listed again',
       /1 blank in Jarvis/.test(text) && !/no bill date/.test(text),
       'two emails listing the same row is how both stop being read — ' + text);
    ck('it says plainly that nothing was changed',
       /Nothing was changed/.test(text));
    ck('and how many rows are stuck out of how many seen',
       /2 of 9 rows are stuck/.test(text), text);

    // Her own wording rule, twice burned: the verb agrees too.
    const one = qb.reportText({ rowsSeen: 3, blocked: [
        { kind: 'bill', id: 'B9', container_no: 'C9', problems: ['no "Trucking" account found'],
          found: [qb.classifyProblem('no "Trucking" account found')] }] });
    ck('one thing reads "1 thing is", not "1 things are"',
       /1 thing is stopping/.test(one), one.split('\n')[0]);
}

// ── E — IT SURVIVES QUICKBOOKS BEING UNAVAILABLE ──────────────────────────
{
    section('E — QuickBooks down, or off');

    // A sweep that throws must not take the morning's report with it. The
    // job wraps it; look() is allowed to reject, and this pins which.
    let threw = false;
    try {
        await qb.look({ sweep: async () => { throw new Error('401 unauthorized'); } });
    } catch (e) { threw = /401/.test(e.message); }
    ck('look() surfaces an auth failure rather than reporting "all clear"',
       threw,
       'a swallowed 401 would read as an empty blocked list, which is the worst possible lie here');

    // A sweep that returns the OLD shape (no rows) must read as "nothing to
    // say", not crash — the additive field has to be optional.
    const old = await qb.look({ sweep: async () => ({ bill: { created: 3 }, sale: {} }) });
    ck('a sweep with no per-row detail is handled, not crashed on',
       old.blocked.length === 0 && old.rowsSeen === 0, JSON.stringify(old.counts));

    // before-cutover is her accountant's period and is never chased.
    const cut = await qb.look({ sweep: async () => ({ rows: [
        { kind: 'bill', id: 'B1', status: 'before-cutover', problems: ['before the cutover (2025-12-31)'] },
        { kind: 'bill', id: 'B2', status: 'created', problems: [] },
        { kind: 'bill', id: 'B3', status: 'blocked', problems: ['no bill date'] },
    ] }) });
    ck('a before-cutover row is not chased',
       cut.blocked.length === 1 && cut.blocked[0].id === 'B3',
       'her 2026-09-26 rule: that period belongs to her accountant — ' + JSON.stringify(cut.blocked.map((b) => b.id)));
    ck('a row that went in fine is not chased either',
       !cut.blocked.some((b) => b.id === 'B2'));

    // An error status with no problems array still has to appear.
    const err = await qb.look({ sweep: async () => ({ rows: [
        { kind: 'bill', id: 'B4', status: 'error: socket hang up', problems: [] }] }) });
    ck('a thrown push appears even with no problems list',
       err.blocked.length === 1 && /socket hang up/.test(err.blocked[0].found[0].problem),
       JSON.stringify(err.blocked));
}

// ── F — RULE 5 ────────────────────────────────────────────────────────────
{
    section('F — Edge Yard stays out of it');
    const src = fs.readFileSync(path.join(ROOT, 'helpers/qbAgent.js'), 'utf8');
    ck('the QuickBooks agent never reads a yard store',
       !/yardClaims|yardLoads|require\(['"]\.\/loads['"]\)|outboundLoads/.test(src),
       'Edge Yard and Edge Metals are different companies');
}


// ── G — THE TWO JOBS, IN SEQUENCE, END TO END ─────────────────────────────
// Rule 3: "ALwyas test end to end when you add a new feature." Sections A–F
// can all be green while the pair does not work, because the gaps live
// between the two jobs — a cached look nobody reads, a shape the other side
// cannot parse, a run that is skipped because its partner failed.
//
// So this runs the 07:25 job, lets it cache, runs the 07:30 job with NOTHING
// passed between them, and reads the figure back out of the store.
{
    section('G — 07:25 then 07:30, with nothing passed by hand');

    const qbJob = require('../helpers/qbAgentJob');
    const ledgerJob = require('../helpers/ledgerAgentJob');
    const bills = require('../helpers/bills');

    qbJob.forget();

    // A bill QuickBooks cannot take: no date. Her sheet has the date.
    const bill = await bills.addBill({
        container_no: 'TGCU0053611', booking_no: 'BK9001', supplier: 'Calderon',
    });

    // 07:25 — a dry sweep, faked at the sweep boundary only. Everything above
    // it is the real agent.
    let qbMail = null;
    const sweep = async ({ dryRun }) => {
        ck('    the sweep is asked for a DRY run', dryRun === true,
           'a live sweep at 07:25 would push rows into her books');
        return { rows: [
            { kind: 'bill', id: bill.id, container_no: 'TGCU0053611', supplier: 'Calderon',
              status: 'blocked', problems: ['no bill date', 'vendor "Calderon" not found in QuickBooks sandbox'] },
        ] };
    };
    const qbRun = await qbJob.run({ sweep, send: (o) => { qbMail = o; },
        alreadySent: async () => false, markSent: async () => {} });

    ck('07:25 found the blocked row', qbRun.blocked && qbRun.blocked.length === 1);
    ck('  and emailed her only the QuickBooks-side half',
       /vendor "Calderon" is not in QuickBooks/.test(qbMail.body)
       && !/no bill date/.test(qbMail.body),
       qbMail.body);
    ck('  and its result is cached for the next job',
       qbJob.look() === qbRun || (qbJob.look() && qbJob.look().blocked.length === 1),
       'the ledger agent reads this off the module — nothing is passed by hand');

    // 07:30 — note what is NOT passed: no qbLook. It must find it itself,
    // because that is how the scheduler calls it.
    let ledgerMail = null;
    const ledgerRun = await ledgerJob.run({
        sheetReport: { changedBills: [], changedSales: [], fillableSales: [], fillableBills: [{
            key: 'BK9001|TGCU0053611', row_id: bill.id, container_no: 'TGCU0053611', supplier: 'Calderon',
            blanks: [
                { field: 'date', sheet: '2026-09-20', jarvis: '' },
                { field: 'seal_no', sheet: 'SL-77421', jarvis: '' },
            ] }] },
        send: (o) => { ledgerMail = o; },
        alreadySent: async () => false, markSent: async () => {},
    });

    const after = bills.list().find((b) => b.id === bill.id);
    ck('07:30 filled the blank that was blocking QuickBooks',
       String(after.date || '') === '2026-09-20', JSON.stringify(after.date));
    ck('  and the ordinary blank too',
       String(after.seal_no || '') === 'SL-77421', JSON.stringify(after.seal_no));
    ck('  and nothing failed',
       ledgerRun.counts.failed === 0, JSON.stringify(ledgerRun.counts));

    // THE HANDOFF, OBSERVED IN THE OUTPUT. This is the check that fails if
    // the two jobs stop talking — the one thing no unit test can see.
    const blockingLine = (ledgerRun.settled || []).find((f) => f.fix && f.fix.field === 'date');
    ck('the ledger agent KNEW that one was blocking her books',
       blockingLine && blockingLine.blocks_quickbooks === true,
       'the 07:25 → 07:30 handoff is broken; each agent works, the pair does not');
    ck('  and an ordinary blank was not marked',
       !(ledgerRun.settled || []).find((f) => f.fix && f.fix.field === 'seal_no').blocks_quickbooks);
    ck('the blocking one is listed FIRST',
       (ledgerRun.settled || [])[0].fix.field === 'date',
       'urgent first, within the list — a sort, not a filter');

    // ── AND 07:30 SURVIVES 07:25 NEVER HAVING RUN ────────────────────────
    // Chaining them would turn one outage into two. This is the check that
    // keeps them independent.
    qbJob.forget();
    const bill2 = await bills.addBill({ container_no: 'DDDD4444444', booking_no: 'BK4', supplier: 'Q' });
    const alone = await ledgerJob.run({
        sheetReport: { changedBills: [], changedSales: [], fillableSales: [], fillableBills: [{
            key: 'BK4|DDDD4444444', row_id: bill2.id, container_no: 'DDDD4444444', supplier: 'Q',
            blanks: [{ field: 'seal_no', sheet: 'SL-2', jarvis: '' }] }] },
        send: () => {}, alreadySent: async () => false, markSent: async () => {},
    });
    ck('with no QuickBooks result at all, 07:30 still fills blanks',
       String((bills.list().find((b) => b.id === bill2.id) || {}).seal_no || '') === 'SL-2',
       'an agent that stops because another agent failed is two outages for one');
    ck('  and says nothing is blocking, rather than crashing',
       alone.counts.failed === 0 && !(alone.broken || []).some((b) => b.id === 'quickbooks-blocking'),
       JSON.stringify(alone.broken));

    // ── A FAILED SWEEP IS NEWS, NOT SILENCE ──────────────────────────────
    qbJob.forget();
    let failMail = null;
    const bad = await qbJob.run({
        sweep: async () => { throw new Error('401 unauthorized'); },
        send: (o) => { failMail = o; },
        alreadySent: async () => false,
        markSent: async () => { ck('    a failed sweep is NOT marked as done', false, 'a transient 401 should be retried, not written off for the day'); },
    });
    ck('a failed sweep emails her instead of reporting all clear',
       bad.ok === false && /could not check/i.test(failMail.subject), JSON.stringify(bad));
    ck('  and clears the cache so 07:30 is not told yesterday\'s news',
       qbJob.look() === null,
       'a stale blocking map would mark rows urgent that were fixed hours ago');
}


// ── H — THE GATE THAT STOPS THE LEDGER AGENT WRITING OVER HER BOOKS ───────
// Three mutations SURVIVED this file before this section existed: the gate
// could be deleted outright, made to fail open, or narrowed to the row id,
// and nothing went red. I had proved it worked by hand in a throwaway script
// — which is not a test, because the proof does not survive the session.
//
// This is the most consequential code in either agent. Without it the 07:30
// run edits a bill that is already a QuickBooks Bill, QuickBooks is not
// re-pushed for an edit, and her two sets of books quietly disagree with no
// record of who changed it.
{
    section('H — a row already in QuickBooks is never auto-filled');

    const qbLinked = require('../helpers/qbLinked');
    const journal = require('../helpers/quickbooks/journal');
    const push = require('../helpers/quickbooks/push');
    const auth = require('../helpers/quickbooks/auth');
    const bills = require('../helpers/bills');
    const env = auth.qbEnv();

    const pushed = await bills.addBill({ container_no: 'AAAA1111111', supplier: 'X' });
    const notPushed = await bills.addBill({ container_no: 'BBBB2222222', supplier: 'Y' });
    // Linked by CONTAINER, not by id — push.js links by `id || container_no`,
    // so a bill entered before it had an id is linked this way.
    const byContainer = await bills.addBill({ container_no: 'CCCC3333333', supplier: 'Z' });

    journal.record({ env, kind: 'bill', action: 'created', jarvis: { id: pushed.id },
        linkKey: push.linkKey(env, 'bill', pushed.id), qb: { id: 'QB1', total: 100 } });
    journal.record({ env, kind: 'bill', action: 'created', jarvis: { id: byContainer.id },
        linkKey: push.linkKey(env, 'bill', 'CCCC3333333'), qb: { id: 'QB3', total: 300 } });

    const fix = (id) => ({ ledger: 'bills', row_id: id, what: 't',
        fix: { field: 'seal_no', from: '', to: 'SL-1', from_source: 'the sheet' } });

    const r = await agent.apply([fix(pushed.id), fix(notPushed.id), fix(byContainer.id)]);
    const seal = (id) => String((bills.list().find((b) => b.id === id) || {}).seal_no || '');

    ck('a bill already in QuickBooks is NOT written to',
       seal(pushed.id) === '',
       `seal_no became ${JSON.stringify(seal(pushed.id))} — Jarvis and her books now disagree, silently`);
    ck('  and it is skipped with the reason said out loud',
       r.skipped.some((x) => x.row_id === pushed.id && /already in QuickBooks/.test(x.why || '')),
       JSON.stringify(r.skipped.map((x) => x.why)));
    ck('  and it is a SKIP, not a failure',
       !r.failed.some((x) => x.row_id === pushed.id),
       'nothing is wrong — it becomes a proposal in her email, where she can fix both books at once');

    // ── LINKED BY CONTAINER COUNTS ───────────────────────────────────────
    // Checking only the id would report this one as unlinked and write over
    // it. That mutation survived before this check.
    ck('a bill linked by CONTAINER is also protected',
       seal(byContainer.id) === '',
       'push.js links by `id || container_no`; checking only the id writes over the older rows');
    ck('  and says which key matched',
       r.skipped.some((x) => x.row_id === byContainer.id && /linked by container/.test(x.why || '')),
       'she has to be able to find the record in QuickBooks — ' + JSON.stringify(r.skipped.map((x) => x.why)));

    // ── AND A ROW THAT IS NOT IN QUICKBOOKS IS STILL FILLED ──────────────
    // The gate must not be a blanket refusal. A gate that blocks everything
    // passes the three checks above and makes the agent useless.
    ck('a bill NOT in QuickBooks is still filled',
       seal(notPushed.id) === 'SL-1',
       'a gate that refuses everything would pass every check above and do nothing all day');

    // ── IT FAILS CLOSED ──────────────────────────────────────────────────
    // "Cannot tell" must not read as "safe to overwrite". A false positive
    // costs her one question; a false negative costs two disagreeing books.
    const broken = qbLinked.linkedRow({ id: 'BILL_x' }, {
        kind: 'bills',
        keys: { get env() { throw new Error('journal unreadable'); }, set: new Set() },
    });
    ck('an unreadable journal reads as LINKED, not as unlinked',
       broken.linked === true && /could not check/.test(broken.why),
       JSON.stringify(broken));

    const stillWritten = await bills.addBill({ container_no: 'EEEE5555555', supplier: 'W' });
    const guarded = await agent.apply([fix(stillWritten.id)], { kinds: {
        bills: {
            list: () => bills.list(),
            edit: () => { throw new Error('should never be reached'); },
        },
    } });
    // That one has no journal entry, so it IS written — proving the harness
    // above is not simply refusing everything. The throw asserts it.
    ck('  and the edit path is only reached for an unlinked row',
       guarded.failed.length === 1 && /should never be reached/.test(guarded.failed[0].error),
       JSON.stringify(guarded));

    // ── A NON-QUICKBOOKS KIND IS NOT SILENTLY TREATED AS LINKED ──────────
    ck('a kind QuickBooks does not know is not "linked"',
       qbLinked.linkedRow({ id: 'X' }, { kind: 'petty_cash' }).linked === false,
       'failing closed on an unknown KIND would freeze stores QuickBooks has nothing to do with');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('\n  THREW:', e.stack || e.message); process.exit(1); });
