// ── tests/books-portal.js ─────────────────────────────────────────────────
// Apsara, 2026-10-06: "Make the qb thing as separate portal" / "Include all
// the options oin quickbook and beter than it". 2026-10-07: "built that qb
// portal professionally with an qb agent".
//
// ── WHY THIS FILE EXISTS AT ALL ──────────────────────────────────────────
// The books engine shipped on 2026-10-06 — entities, chartOfAccounts,
// postings, statements, booksBuild, 1,344 lines, some 370 assertions — and
// NOTHING COULD REACH IT. No route, no screen. She could not look at a single
// statement. Every one of those assertions passed throughout.
//
// scripts/check-route-reach.js could not see it either: it walks from GUARDED
// routes to clients, and there was no route to be unreachable. So section D
// walks the other way for this page specifically — the route serves it, the
// sidebar offers it, and the voice registry knows it.
//
// Section A tests the agent as SOURCE-FED arithmetic, not against today's
// stores, because every finding must be provable on demand: a finding I cannot
// make appear is a finding I have not tested.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-books-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
// Before config is required — it reads these once at load, and setting them
// later gives a 401 that reads like a broken guard.
process.env.APP_PASSWORD = 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb';
process.env.JARVIS_PASSWORD = 'jarvis-pw-ddddddddddd';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated — refusing to run against real data');
    process.exit(1);
}

// One container bought for 40,000 with 3,000 of trucking, sold for 50,000.
// Small enough that every figure below can be checked by hand.
fs.writeFileSync(cfg.BILLS_FILE, JSON.stringify([{
    id: 'B1', container_no: 'C1', date: '2026-03-01', supplier: 'DRM',
    supplier_invoice_amount: 40000, trucking_amount: 3000, trucking_company: 'AJ',
}], null, 2));
fs.writeFileSync(cfg.SALES_FILE, JSON.stringify([{
    id: 'S1', customer: 'ACME', date: '2026-03-05', container_no: 'C1',
    item: 'Cu', weight: 20000, weight_unit: 'lb', invoice_price: 2.5, price_unit: 'lb',
}], null, 2));

const B = require(path.join(ROOT, 'helpers/booksBuild'));
const A = require(path.join(ROOT, 'helpers/booksAgent'));

(async () => {

// ── A — EVERY FINDING CAN BE MADE TO APPEAR ───────────────────────────────
{
    section('A — the agent, on books that are wrong on purpose');

    const built = B.build({});
    const clean = A.review(built, { entity: 'edge-metals' });
    ck('clean books produce no findings', clean.findings.length === 0,
       JSON.stringify(clean.findings.map((f) => f.code)));
    ck('  and are called trustworthy', clean.trustworthy === true);
    ck('  with a sentence naming the company and the profit',
       /^Edge Metals: /.test(A.summary(clean)) && /10,000\.00/.test(A.summary(clean)),
       A.summary(clean));
    ck('  and NO sentence says "undefined"',
       !/undefined/.test(A.summary(clean) + JSON.stringify(clean.findings)),
       'entities carry uiName and legalName — there is no `name`, and reading it '
       + 'made every sentence begin "undefined:"');

    const copy = () => JSON.parse(JSON.stringify(built));

    // Debits and credits apart — the blocker that makes every other figure
    // meaningless, which is why it must sort first.
    let b = copy();
    b.lines.push({ date: '2026-03-01', entity: 'edge-metals', account: '1010', debit: 77, credit: 0 });
    let r = A.review(b, { entity: 'edge-metals' });
    ck('an unbalanced trial balance is a blocker', r.worst === 'blocker', r.worst);
    ck('  and it sorts first', r.findings[0].code === 'trial-balance-unbalanced',
       r.findings.map((f) => f.code).join(','));
    ck('  naming the gap', r.findings[0].money === 77, String(r.findings[0].money));
    ck('  and the verdict refuses to vouch for the figures',
       r.trustworthy === false && /Do not use these figures/.test(A.summary(r)), A.summary(r));

    // An account the chart has never heard of. The trial balance still
    // balances, so nothing else in the system shows this.
    b = copy();
    b.lines.push({ date: '2026-03-01', entity: 'edge-metals', account: '9999', debit: 1234.5, credit: 0 });
    b.lines.push({ date: '2026-03-01', entity: 'edge-metals', account: '9999', debit: 0, credit: 1234.5 });
    r = A.review(b, { entity: 'edge-metals' });
    const unk = r.findings.find((f) => f.code === 'account-not-in-chart');
    ck('an account missing from the chart is found', !!unk, r.findings.map((f) => f.code).join(','));
    ck('  even though the trial balance still balances',
       !r.findings.some((f) => f.code === 'trial-balance-unbalanced'),
       'this is the silent one — a balanced journal with money on no statement');
    ck('  and it names the account', unk && /9999/.test(unk.what), unk && unk.what);

    // The two companies disagreeing. Invisible on either company's own
    // statements — each balances perfectly alone.
    b = copy();
    b.lines.push({ date: '2026-03-02', entity: 'edge-metals', account: '1400', debit: 5000, credit: 0 });
    b.lines.push({ date: '2026-03-02', entity: 'edge-metals', account: '1010', debit: 0, credit: 5000 });
    r = A.review(b, { entity: 'edge-metals' });
    const ic = r.findings.find((f) => f.code === 'inter-company-mismatch');
    ck('one company owed with nobody owing is found', !!ic, r.findings.map((f) => f.code).join(','));
    ck('  as a blocker, because the money exists on one set of books only',
       ic && ic.severity === 'blocker', ic && ic.severity);
    ck('  naming the difference', ic && ic.money === 5000, ic && String(ic.money));
    ck('  and saying why no single statement shows it',
       ic && /still balance/.test(ic.why), ic && ic.why);

    // Both sides present and equal must NOT be reported. A guard that fires on
    // correct books is a guard she switches off.
    b = copy();
    b.lines.push({ date: '2026-03-02', entity: 'edge-metals', account: '1400', debit: 5000, credit: 0 });
    b.lines.push({ date: '2026-03-02', entity: 'edge-metals', account: '1010', debit: 0, credit: 5000 });
    b.lines.push({ date: '2026-03-02', entity: 'edge-trading', account: '2400', debit: 0, credit: 5000 });
    b.lines.push({ date: '2026-03-02', entity: 'edge-trading', account: '1010', debit: 5000, credit: 0 });
    r = A.review(b, { entity: 'edge-metals' });
    ck('but a matched pair is NOT reported',
       !r.findings.some((f) => f.code === 'inter-company-mismatch'),
       JSON.stringify(r.interCompany));
    ck('  and the pair is shown as agreeing', r.interCompany.agrees === true,
       JSON.stringify(r.interCompany));

    ck('an unknown company is refused',
       await (async () => { try { A.review(built, { entity: 'nope' }); return false; }
                            catch (e) { return /no company nope/.test(e.message); } })());
}

// ── B — AN EMPTY COMPANY MUST SAY SO ──────────────────────────────────────
// The bug this pins: the agent counted booksBuild's transactions, which is
// EVERY company's rows added together. So AAA Investment reported "1
// transactions, books balance, nothing unplaced" off a single Edge Metals
// bill, while every figure on its statements was zero — defeating the one
// finding written to prevent exactly that.
{
    section('B — zero because there is no data, not because it earned nothing');

    const built = B.build({});
    ck('the build really does hold another company\'s rows', built.transactions > 0,
       String(built.transactions));

    for (const empty of ['edge-trading', 'aaa-investment']) {
        const r = A.review(built, { entity: empty });
        ck(`${empty} says there is nothing in the range`,
           r.findings.some((f) => f.code === 'no-transactions'),
           r.findings.map((f) => f.code).join(',') || '(none)');
        ck(`  and does NOT claim transactions it has none of`,
           !/\d+ journal lines, books balance/.test(A.summary(r)), A.summary(r));
        ck('  counting only its own journal lines', r.headline.lines === 0,
           String(r.headline.lines));
    }

    const metals = A.review(built, { entity: 'edge-metals' });
    ck('while Edge Metals, which does have rows, reports them',
       metals.headline.lines > 0 && !metals.findings.some((f) => f.code === 'no-transactions'),
       String(metals.headline.lines));
    ck('  and pluralises', !/\b1 journal lines\b/.test(A.summary(metals)), A.summary(metals));

    // A date range with nothing in it, on a company that does have rows.
    const r = A.review(B.build({ from: '2030-01-01', to: '2030-12-31' }),
                       { entity: 'edge-metals' });
    ck('an empty DATE RANGE says the same thing',
       r.findings.some((f) => f.code === 'no-transactions'), A.summary(r));
}

// ── C — END TO END, THROUGH THE ROUTES THE PAGE REALLY CALLS ───────────────
{
    section('C — the portal over HTTP');

    const { createApi } = require(path.join(ROOT, 'api'));
    const app = createApi();
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;

    const req = (method, p, { body, sid } = {}) => new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r = http.request(base + p, { method, headers }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, raw, json: j }); });
        });
        r.on('error', reject); if (data) r.write(data); r.end();
    });
    const login = async (pw) => {
        const r = await req('POST', '/login', { body: { password: pw } });
        return (r.json && (r.json.sid || r.json.session_id)) || null;
    };
    const sid = await login(process.env.JARVIS_PASSWORD);
    ck('signed in', !!sid);

    // THE PAGE ITSELF. A route that serves nothing is the dead screen again.
    const page = await req('GET', '/books', { sid });
    ck('/books serves the portal', page.status === 200 && /<title>Books/.test(page.raw),
       `${page.status}, ${page.raw.length} bytes`);

    // Reading her own books is not a privileged act, but it is not public.
    const anon = await req('GET', '/api/books?entity=edge-metals');
    ck('  and the data needs a session', anon.status === 401, String(anon.status));

    const noEnt = await req('GET', '/api/books', { sid });
    ck('with no company it asks which, rather than combining them',
       noEnt.status === 200 && noEnt.json.needs_entity === true
       && (noEnt.json.companies || []).length === 3,
       JSON.stringify(noEnt.json && noEnt.json.needs_entity));

    const d = (await req('GET', '/api/books?entity=edge-metals&from=2026-01-01&to=2026-12-31', { sid })).json || {};
    ck('the four statements come from ONE build',
       !!(d.trialBalance && d.profitAndLoss && d.balanceSheet && d.build),
       Object.keys(d).join(','));
    ck('  income 50,000 on a 20,000 lb container at 2.50',
       d.profitAndLoss && d.profitAndLoss.incomeTotal === 50000,
       JSON.stringify(d.profitAndLoss && d.profitAndLoss.incomeTotal));
    ck('  material 40,000 — the bill GROSS, not net of trucking',
       d.profitAndLoss && d.profitAndLoss.cogsTotal === 40000,
       JSON.stringify(d.profitAndLoss && d.profitAndLoss.cogsTotal));
    ck('  net 10,000', d.profitAndLoss && d.profitAndLoss.netIncome === 10000,
       JSON.stringify(d.profitAndLoss && d.profitAndLoss.netIncome));
    ck('  the trial balance balances', d.trialBalance && d.trialBalance.balanced === true);
    ck('  and so does the balance sheet', d.balanceSheet && d.balanceSheet.balances === true,
       JSON.stringify(d.balanceSheet && d.balanceSheet.difference));

    // The heading a CPA reads. The short name would be wrong on a filing —
    // Edge Trading trades as "Edge Yard".
    ck('the filing name is on the response, not just the short one',
       d.legalName === 'Edge Metals INC' && d.entityName === 'Edge Metals',
       `${d.legalName} / ${d.entityName}`);
    ck('  with the tax id', !!d.taxId, String(d.taxId));

    // THE AGENT travels with the statements it describes.
    ck('the agent\'s verdict is in the same response', !!(d.agent && d.agent.summary),
       JSON.stringify(d.agent && Object.keys(d.agent)));
    ck('  and agrees with the figures beside it',
       d.agent && d.agent.headline.netIncome === d.profitAndLoss.netIncome,
       'computed from a second build it could disagree with the page');
    ck('  and says the books add up', d.agent && d.agent.trustworthy === true,
       JSON.stringify(d.agent && d.agent.findings));

    const bad = await req('GET', '/api/books?entity=nope', { sid });
    ck('an unknown company is a 400 that still offers the real ones',
       bad.status === 400 && (bad.json.companies || []).length === 3,
       `${bad.status} ${JSON.stringify(bad.json && bad.json.error)}`);

    const gl = await req('GET', '/api/books/account/5000?entity=edge-metals', { sid });
    ck('one account\'s history is its own request',
       gl.status === 200 && gl.json.ledger && gl.json.ledger.entries.length === 1,
       `${gl.status} ${JSON.stringify(gl.json && gl.json.ledger && gl.json.ledger.entries.length)}`);
    ck('  with a running balance', gl.json.ledger.closing === 40000,
       String(gl.json.ledger.closing));
    const glNoEnt = await req('GET', '/api/books/account/5000', { sid });
    ck('  and it refuses without a company too', glNoEnt.status === 400, String(glNoEnt.status));

    // Nothing here writes. A books page that changed her records while she
    // looked at them would be the worst thing in the repo.
    const before = fs.readFileSync(cfg.BILLS_FILE, 'utf8');
    await req('GET', '/api/books?entity=edge-metals', { sid });
    await req('GET', '/api/books/account/2010?entity=edge-metals', { sid });
    ck('looking at the books writes NOTHING',
       fs.readFileSync(cfg.BILLS_FILE, 'utf8') === before,
       'the journal is derived on every request and never stored');

    server.close();
}

// ── D — IT CANNOT BE A DEAD SCREEN ────────────────────────────────────────
// The whole reason this file exists. check-route-reach.js walks from guarded
// routes to clients and cannot see a GET page, so the reachability of this one
// is asserted here by name.
{
    section('D — reachable three ways, not none');

    const api = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
    const web = fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8');
    const scr = fs.readFileSync(path.join(ROOT, 'helpers/screens.js'), 'utf8');
    const page = fs.readFileSync(path.join(ROOT, 'dashboard/books.html'), 'utf8');

    ck('the server serves the page', /app\.get\('\/books'/.test(api));

    // ── WHERE SHE ACTUALLY LOOKS FOR IT ──────────────────────────────────
    // Apsara, 2026-10-07: "Built it professionally.under quickbook tab",
    // after opening Jarvis and not finding it. I had filed it under a 'Both
    // companies' heading — correct reasoning (the portal switches between all
    // three companies) and the wrong placement, because that is a different
    // heading further down the rail. Where she looks beats where it belongs.
    const navAt = web.indexOf("{ id: 'books'");
    const qbAt = web.indexOf("{ id: 'quickbooks'");
    ck('Books is in the Edge Metals group, not a heading of its own',
       /\{ id: 'books', label: 'Books', group: 'Edge Metals' \}/.test(web),
       (web.match(/\{ id: 'books'[^}]*\}/) || [''])[0]);
    ck('  and immediately after QuickBooks, so the two are adjacent',
       qbAt > 0 && navAt > qbAt
       && !/\{ id: '(?!books|quickbooks)[a-z-]+'/.test(web.slice(qbAt, navAt)),
       'another entry crept between them, so the group sort will separate them');

    // ── THE TWO PORTALS NAME EACH OTHER ──────────────────────────────────
    // They stay two pages: #170 is her own earlier decision that Books must
    // not be bolted onto the QB page, and the lifecycles differ — QuickBooks
    // holds a connection and a lock, Books holds neither. The switcher is what
    // makes them read as one portal with two tabs without merging them.
    const qbPage = fs.readFileSync(path.join(ROOT, 'dashboard/quickbooks.html'), 'utf8');
    for (const [name, src, self, other] of [
        ['the Books page', page, '/books', '/quickbooks'],
        ['the QuickBooks page', qbPage, '/quickbooks', '/books'],
    ]) {
        ck(`${name} offers both portals`,
           src.includes(`href="${self}"`) && src.includes(`href="${other}"`),
           'a tab strip that only names itself is not a tab strip');
        ck('  and marks which one it is on',
           new RegExp(`href="${self}" aria-current="page"`).test(src),
           'both tabs looking unselected is worse than no tabs');
    }
    ck('the sidebar offers it', /\{ id: 'books', label: 'Books'/.test(web));
    ck('  and clicking it goes to the page',
       /dataset\.tab === 'books'[\s\S]{0,60}\/books/.test(web),
       'a nav entry with no handler is a tab that does nothing');
    ck('"Jarvis, open the books" finds it', /key: 'books'/.test(scr) && /href: '\/books'/.test(scr));

    // The page must call the routes that exist, and only those.
    ck('the page reads /api/books', /api\('\/api\/books/.test(page));
    ck('  and the account history route', /\/api\/books\/account\//.test(page));
    ck('  and it shows the agent before the numbers',
       page.indexOf('renderVerdict') < page.indexOf('function renderPL'),
       'a figure she cannot trust is worse than no figure, so the verdict leads');
    // Browser storage is not used for figures: a cached statement is the second
    // truth the whole posting layer exists to avoid.
    ck('  and caches no figures in the browser',
       !/localStorage|sessionStorage/.test(page),
       'a stored trial balance is a second truth');
}

// ── E — THE LOCAL-DELIVERY CARRIERS, IN THE BOOKS ─────────────────────────
// Apsara, 2026-10-08, asked which account: "5100 for them".
//
// Until today this store reached NO statement — scripts/trucking-double-count.js
// found it sitting outside the books entirely, so freight was understated by
// whatever was in it and the CPA pack was missing it.
//
// I wired it and checked it by hand in a throwaway script. Four mutations then
// survived — 6110 instead of 5100, a missing bank credited to BofA anyway, the
// store dropped from the journal, the rows filed under Edge Yard — because a
// hand check is not a test. This section is what should have been written
// first.
{
    section('E — NTG / TQL / Schneider freight, posted');

    fs.writeFileSync(cfg.CARRIER_INVOICES_FILE, JSON.stringify([
        // paid by hand, with the bank named
        { id: 'A', company: 'Edge Metals', key: 'tql:P1', carrier: 'tql', ref: 'P1',
          amount: 1850, paid: 1850, status: 'paid', invoice_date: '2026-03-01',
          paid_dates: ['2026-03-10'], source: 'manual',
          payments: [{ amount: 1850, date: '2026-03-10', mode: 'Wire', bank: 'BofA' }] },
        // billed, unpaid
        { id: 'B', company: 'Edge Metals', key: 'schneider:O1', carrier: 'schneider', ref: 'O1',
          amount: 4450, paid: 0, status: 'open', invoice_date: '2026-03-02', paid_dates: [] },
        // the carrier's mail says paid; it never said from which account.
        // Apsara, 2026-10-08: "it is from BofA only" — so this one posts.
        { id: 'C', company: 'Edge Metals', key: 'schneider:O2', carrier: 'schneider', ref: 'O2',
          amount: 9700, paid: 9700, status: 'paid', invoice_date: '2026-03-03',
          paid_dates: ['2026-03-20'], evidence: 'Schneider PAID mail' },
        // ── THE GUARD ON HER SENTENCE ────────────────────────────────────
        // A row she typed, carrying a paid figure with no payment behind it.
        // addManual/payManual cannot currently produce this, which is the
        // point: her answer was about the IMPORTED rows, so if this one ever
        // arises it must still be a problem rather than a silent BofA credit.
        // This check is what fails if the default is ever moved into
        // bankAccount() where every caller reaches it.
        { id: 'D', company: 'Edge Metals', key: 'ntg:H9', carrier: 'ntg', ref: 'H9',
          amount: 600, paid: 600, status: 'paid', invoice_date: '2026-03-04',
          paid_dates: ['2026-03-21'], source: 'manual' },
    ], null, 2));
    for (const k of Object.keys(require.cache)) if (k.startsWith(ROOT)) delete require.cache[k];
    const B2 = require(path.join(ROOT, 'helpers/booksBuild'));
    const S2 = require(path.join(ROOT, 'helpers/statements'));
    const E2 = require(path.join(ROOT, 'helpers/entities'));
    const A2 = require(path.join(ROOT, 'helpers/booksAgent'));

    ck('a carrier invoice is Edge Metals\' cost',
       E2.STORE_LEDGER.carrier_invoices === 'edge-metals',
       'carrierInvoices.js stamps company:"Edge Metals" on every row it writes');

    // ── A DELTA, NOT AN ABSOLUTE ─────────────────────────────────────────
    // CLAUDE.md §3 says it plainly, and I ignored it: section A's bill and
    // sale are still in the store, so 5100 came to 56,000 and 2050 to 17,150
    // and three checks failed against figures that were correct. Measured
    // against the SAME build with the carrier store emptied, so an unrelated
    // fixture moving cannot break this.
    const withCarriers = B2.build({ from: '2026-01-01', to: '2026-12-31' });
    const carriersOnly = JSON.parse(fs.readFileSync(cfg.CARRIER_INVOICES_FILE, 'utf8'));
    fs.writeFileSync(cfg.CARRIER_INVOICES_FILE, '[]');
    for (const k of Object.keys(require.cache)) if (k.startsWith(ROOT)) delete require.cache[k];
    const B3 = require(path.join(ROOT, 'helpers/booksBuild'));
    const S3 = require(path.join(ROOT, 'helpers/statements'));
    const without = B3.build({ from: '2026-01-01', to: '2026-12-31' });
    fs.writeFileSync(cfg.CARRIER_INVOICES_FILE, JSON.stringify(carriersOnly, null, 2));

    const built = withCarriers;
    const tb = S2.trialBalance(built.lines, { entity: 'edge-metals' });
    const tb0 = S3.trialBalance(without.lines, { entity: 'edge-metals' });
    const at = (t, code) => { const a = t.accounts.find((x) => x.code === code); return a ? a.balance : 0; };
    const bal = (code) => Math.round((at(tb, code) - at(tb0, code)) * 100) / 100;

    ck('the store reaches the journal at all', built.transactions >= 4, String(built.transactions));
    ck('all four invoices land in 5100 Freight and shipping — HER choice',
       bal('5100') === 16600, `5100 is ${bal('5100')}, expected 1850 + 4450 + 9700 + 600`);
    ck('  and NOT in 6110 operating, which is below gross profit',
       bal('6110') === 0, `6110 is ${bal('6110')}`);
    const pl = S2.profitAndLoss(built.lines, { entity: 'edge-metals' });
    const pl0 = S3.profitAndLoss(without.lines, { entity: 'edge-metals' });
    ck('  so it is a cost of the material sold',
       Math.round((pl.cogsTotal - pl0.cogsTotal) * 100) / 100 === 16600
       && Math.round((pl.expenseTotal - pl0.expenseTotal) * 100) / 100 === 0,
       `cogs moved ${pl.cogsTotal - pl0.cogsTotal}, expense moved ${pl.expenseTotal - pl0.expenseTotal}`);

    // ── HER ANSWER, ON THE ROWS SHE WAS ASKED ABOUT ──────────────────────
    // Apsara, 2026-10-08: "it is from BofA only". So A's named BofA payment
    // and C's imported remittance both leave 1010 — 1,850 + 9,700 — and the
    // only thing still owed the carriers is B's unpaid 4,450.
    ck('a named bank and an imported remittance both credit BofA — HER answer',
       bal('1010') === -11550, `BofA is ${bal('1010')}, expected -(1850 + 9700)`);
    ck('  and relieves what is owed the carriers',
       bal('2050') === 5050,
       `2050 is ${bal('2050')} — 4,450 unpaid plus D's 600 that still cannot post`);
    const o2 = (built.problems || []).find((p) => /O2/.test(String(p)));
    ck('  so the Schneider PAID mail is no longer a could-not-post problem',
       !o2, String(o2));

    // ── AND THE SENTENCE DOES NOT SPREAD ─────────────────────────────────
    // D is a row SHE typed. Her answer was about the imported ones, so this
    // one is still a problem. If this check goes green with the others, the
    // BofA default has escaped into shared code and a payment she records
    // with the bank left blank is silently crediting an account she never
    // picked — the helpers/postings.js bankAccount() mistake, undone.
    const manual = (built.problems || []).find((p) => /H9/.test(String(p)));
    ck('a HAND-TYPED payment with no bank is still a PROBLEM, not a guess',
       !!manual, JSON.stringify(built.problems));
    ck('  naming the carrier, the invoice and the amount',
       !!manual && /ntg/i.test(manual) && /600/.test(manual),
       String(manual));
    ck('  and the build reports itself incomplete', built.complete === false);
    const verdict = A2.review(built, { entity: 'edge-metals' });
    ck('  so the agent refuses to vouch for the figures',
       verdict.trustworthy === false, A2.summary(verdict));

    fs.writeFileSync(cfg.CARRIER_INVOICES_FILE, '[]');
    for (const k of Object.keys(require.cache)) if (k.startsWith(ROOT)) delete require.cache[k];
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('threw:', e && e.stack); process.exit(1); });
