// ── tests/bank-reconcile.js ───────────────────────────────────────────────
// Apsara, 2026-10-08: "Build that plaid bank thing completely so that i dont
// need to look out for statements whether payment received or sent ever
// again."
//
// The claim this file has to protect is the dangerous one. "You never need to
// look at a statement again" is a statement about COMPLETENESS, and the way
// software gets that wrong is not by computing a figure badly — it is by
// computing a figure that always looks fine. So the checks here are mostly
// about the output being WRONG in the right way: a missing receipt must not
// cancel a missing payment, an excluded row must not vanish, and a partial
// history must not be reported as an agreeing balance.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-bankrec-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated — refusing to run against real data');
    process.exit(1);
}
const R = require(path.join(ROOT, 'helpers/bankReconcile'));

// ── fixtures ──────────────────────────────────────────────────────────────
// Journal lines in the shape postings.js::post actually emits: date, entity,
// kind, account, debit, credit, source, party.
const L = (o) => ({ date: '2026-04-10', entity: 'edge-metals', kind: 'x',
    account: '1010', debit: 0, credit: 0, source: null, party: null, memo: null, ...o });
// bankLedger rows in the shape fromPlaid actually emits.
const B = (o) => ({ id: 'b1', date: '2026-04-10', desc: '', party: '', category: '',
    spent: 0, received: 0, amount: 0, direction: 'in', bank: 'BofA', company: 'Edge Metals INC',
    pending: false, excluded: false, ...o });

// ── A — the account codes come off the chart ───────────────────────────────
{
    section('A — which account is which bank');
    const accts = R.bankAccounts();
    ck('BofA is 1010 and Chase is 1020, read off the chart',
       R.codeForBank('BofA') === '1010' && R.codeForBank('Chase Bank') === '1020',
       JSON.stringify(accts));
    ck('  and petty cash is not offered as a bank',
       !accts.some((a) => a.code === '1050'), JSON.stringify(accts.map((a) => a.code)));
    ck('a bank nobody has an account for is refused, not guessed',
       R.reconcile({ bank: 'Wells Fargo' }).ok === false);
}

// ── B — ONE BANK, SEVERAL SETS OF BOOKS ───────────────────────────────────
// The trap this check exists for: statements.js::linesFor throws without an
// entity, so the obvious implementation picks one company. 1010 is drawn on
// by Edge Metals AND by AAA Investment, so picking one understates the books
// by whatever the other moved — and it looks exactly like a feed problem.
{
    section('B — one real account, several companies');
    const lines = [
        L({ account: '1010', credit: 4000, entity: 'edge-metals', kind: 'supplier-payment' }),
        L({ account: '1010', credit: 1500, entity: 'aaa-investment', kind: 'expense' }),
        L({ account: '1020', credit: 9999, entity: 'edge-trading', kind: 'supplier-payment' }),
    ];
    const s = R.ledgerSide(lines, { code: '1010' });
    ck('the books side sums ACROSS companies', s.out === 5500, String(s.out));
    ck('  and leaves the other bank alone', s.lines.length === 2, String(s.lines.length));
    ck('  while still saying which company moved what',
       s.byEntity.length === 2
       && s.byEntity.find((e) => e.entity === 'aaa-investment').out === 1500,
       JSON.stringify(s.byEntity));
}

// ── C — the sign convention, flipped exactly once ─────────────────────────
{
    section('C — debit is money in, credit is money out');
    const lines = [
        L({ debit: 7000, kind: 'customer-receipt' }),
        L({ credit: 2500, kind: 'supplier-payment' }),
    ];
    const s = R.ledgerSide(lines, { code: '1010' });
    ck('a DEBIT to the bank is money arriving', s.in === 7000, String(s.in));
    ck('a CREDIT to the bank is money leaving', s.out === 2500, String(s.out));
    ck('  and net is the difference', s.net === 4500, String(s.net));

    const rows = [B({ id: 'i', received: 7000, amount: 7000, direction: 'in' }),
                  B({ id: 'o', spent: 2500, amount: 2500, direction: 'out' })];
    const f = R.bankSide(rows, { bank: 'BofA' });
    ck('Plaid\'s side agrees on which way is which',
       f.in === 7000 && f.out === 2500, JSON.stringify({ in: f.in, out: f.out }));
}

// ── D — THE CHECK THIS FILE EXISTS FOR ────────────────────────────────────
// A missing receipt and a missing payment of the same size must NOT cancel
// to "all clear". A single net figure would do exactly that, and it is the
// one output that would make her trust a broken reconciliation.
{
    section('D — a missing receipt must not cancel a missing payment');
    const lines = [L({ debit: 10000, kind: 'customer-receipt' })];
    const rows = [
        B({ id: 'r1', received: 10000, amount: 10000, direction: 'in' }),
        B({ id: 'r2', received: 5000, amount: 5000, direction: 'in', date: '2026-04-12' }),
        B({ id: 'p1', spent: 5000, amount: 5000, direction: 'out', date: '2026-04-13' }),
    ];
    const rec = R.reconcile({ lines, rows, bank: 'BofA' });
    ck('the net difference is zero — which is the trap', rec.netGap === 0, String(rec.netGap));
    ck('and it still does NOT say the two sides agree', rec.agrees === false);
    ck('  because the receipt gap is named on its own', rec.inGap === 5000, String(rec.inGap));
    ck('  and so is the payment gap', rec.outGap === 5000, String(rec.outGap));
}

// ── E — what it does not claim ────────────────────────────────────────────
{
    section('E — it compares movement, and says so');
    const rec = R.reconcile({ lines: [L({ debit: 100 })], rows: [B({ received: 100, amount: 100 })], bank: 'BofA' });
    ck('movement agreeing is reported as agreeing', rec.agrees === true);
    // Written as "movement … NOT the account balance", so the check is that
    // it denies being a balance check — not that the word is absent, which
    // was my first version and failed on the very sentence it wanted.
    ck('  but the output denies being a balance check',
       /movement/i.test(rec.compares) && /not the account balance/i.test(rec.compares), rec.compares);
    ck('  and it names the one thing that would let it check the balance',
       /anchor|statement balance/i.test(rec.anchorNeeded), rec.anchorNeeded);
}

// ── F — pending and excluded, the two reasons a figure moves by itself ────
{
    section('F — pending held back, excluded counted');
    const rows = [
        B({ id: 'live', received: 1000, amount: 1000, direction: 'in' }),
        B({ id: 'pend', received: 400, amount: 400, direction: 'in', pending: true }),
        B({ id: 'excl', spent: 250, amount: 250, direction: 'out', excluded: true }),
    ];
    const f = R.bankSide(rows, { bank: 'BofA' });
    ck('a PENDING row is not counted — it can still change or vanish',
       f.in === 1000, String(f.in));
    ck('  and the fact it was held back is reported, not hidden',
       f.pendingHeldBack === 1, String(f.pendingHeldBack));
    // The opposite of QuickBooks. The money still left the bank.
    ck('an EXCLUDED row IS in the bank total — the money still moved',
       f.out === 250, String(f.out));
    ck('  and is named separately so the gap it causes is explainable',
       f.excluded.count === 1 && f.excluded.out === 250, JSON.stringify(f.excluded));
}

// ── G — what needs her, in both directions ────────────────────────────────
{
    section('G — the list, not a number');
    const lines = [
        L({ debit: 10000, kind: 'customer-receipt', party: 'Fisher', date: '2026-04-10' }),
        L({ credit: 3000, kind: 'supplier-payment', party: 'Inesh', date: '2026-04-11' }),
    ];
    const rows = [
        B({ id: 'ok-in', received: 10000, amount: 10000, direction: 'in', date: '2026-04-11' }),
        B({ id: 'ghost-in', received: 2200, amount: 2200, direction: 'in', date: '2026-04-15',
            desc: 'WIRE IN SOMEBODY LLC' }),
        B({ id: 'ghost-out', spent: 95, amount: 95, direction: 'out', date: '2026-04-16',
            desc: 'MONTHLY SERVICE FEE' }),
    ];
    const u = R.unexplained({ lines, rows, bank: 'BofA' });
    ck('a receipt the books do show is not reported',
       !u.bankNotInBooks.in.some((r) => r.id === 'ok-in'), JSON.stringify(u.bankNotInBooks.in));
    ck('a deposit nobody recorded IS reported', u.bankNotInBooks.in.length === 1
       && u.bankNotInBooks.in[0].id === 'ghost-in', JSON.stringify(u.bankNotInBooks.in));
    ck('  and so is a fee that left without a record',
       u.bankNotInBooks.out.length === 1 && u.bankNotInBooks.out[0].amount === 95,
       JSON.stringify(u.bankNotInBooks.out));
    // Null-safe on purpose. Written as u.booksNotInBank.out[0].party it
    // THREW when the list came back empty, so the mutation that empties it
    // was reported as a crash rather than as this check going red — a kill
    // that tells you nothing about which property broke.
    const mineOut = u.booksNotInBank.out || [];
    ck('the OTHER direction too — Jarvis paid Inesh, the bank never did',
       mineOut.length === 1 && (mineOut[0] || {}).party === 'Inesh',
       JSON.stringify(mineOut));
    ck('  carrying where it came from, so she can open it',
       (mineOut[0] || {}).kind === 'supplier-payment', JSON.stringify(mineOut[0] || {}));
    ck('and it is not clean', u.clean === false);
}

// ── H — TWO IDENTICAL WITHDRAWALS, ONE RECORDED PAYMENT ───────────────────
// The bug the "consumed claims" design exists to stop: without it, both
// $1,200 rows point at the single recorded payment and the second looks
// explained. She would then have an unrecorded $1,200 that no screen
// mentions — the exact failure this whole file is meant to prevent.
{
    section('H — the same amount twice cannot be explained once');
    const lines = [L({ credit: 1200, kind: 'supplier-payment', date: '2026-05-01' })];
    const rows = [
        B({ id: 'w1', spent: 1200, amount: 1200, direction: 'out', date: '2026-05-01' }),
        B({ id: 'w2', spent: 1200, amount: 1200, direction: 'out', date: '2026-05-02' }),
    ];
    const u = R.unexplained({ lines, rows, bank: 'BofA' });
    ck('exactly one of the two is explained',
       u.bankNotInBooks.out.length === 1, JSON.stringify(u.bankNotInBooks.out));
    ck('  and the reconciliation agrees there is 1,200 missing',
       R.reconcile({ lines, rows, bank: 'BofA' }).outGap === 1200);
}

// ── I — a payment recorded a few days before it cleared ───────────────────
{
    section('I — a few days apart is still the same payment');
    const lines = [L({ credit: 800, kind: 'expense', date: '2026-06-01' })];
    const near = [B({ id: 'n', spent: 800, amount: 800, direction: 'out', date: '2026-06-04' })];
    const farOff = [B({ id: 'f', spent: 800, amount: 800, direction: 'out', date: '2026-06-20' })];
    ck('cleared three days later: explained',
       R.unexplained({ lines, rows: near, bank: 'BofA' }).bankNotInBooks.out.length === 0);
    ck('nineteen days later: NOT quietly explained',
       R.unexplained({ lines, rows: farOff, bank: 'BofA' }).bankNotInBooks.out.length === 1);
    ck('  and the window is a parameter, not a magic number',
       R.unexplained({ lines, rows: farOff, bank: 'BofA', days: 30 }).bankNotInBooks.out.length === 0);
}

// ── J — the window ────────────────────────────────────────────────────────
{
    section('J — only inside the window');
    const lines = [L({ credit: 500, date: '2026-01-05' }), L({ credit: 700, date: '2026-07-05' })];
    const s = R.ledgerSide(lines, { code: '1010', from: '2026-06-01', to: '2026-12-31' });
    ck('a line before the window is not counted', s.out === 700, String(s.out));
}

// ── K — END TO END, AND REACHABLE ─────────────────────────────────────────
// Apsara, 2026-09-17: "ALwyas test end to end when you add a new feature."
//
// Everything above drives helpers/bankReconcile.js directly, and all of it
// can pass while the feature does not exist for her: the route may not build
// the journal, the page may never call it. helpers/reconcile.js is the
// precedent and it is not a hypothetical — it had no screen from 3 September,
// working perfectly, reachable by nobody. So this starts a real server, logs
// in, reads the route the page reads, and then checks the page reads it.
(async () => {
    section('K — through the real route, and reached by the real page');

    const http = require('http');
    process.env.APP_PASSWORD   = process.env.APP_PASSWORD   || 'user-pw-aaaaaaaaaaaa';
    process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pw-bbbbbbbbbbb';
    process.env.STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'staff-pw-ccccccccccc';

    const { createApi } = require(path.join(ROOT, 'api'));
    const app = createApi();
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = (method, p, { body, sid } = {}) => new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const rq = http.request(base + p, { method, headers }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
        });
        rq.on('error', reject); if (data) rq.write(data); rq.end();
    });

    const sid = ((await req('POST', '/login', { body: { password: process.env.ADMIN_PASSWORD } })).json || {}).sid;
    ck('signed in', !!sid);

    const got = await req('GET', '/api/bank/reconcile', { sid });
    ck('the route answers', got.status === 200, `${got.status} ${JSON.stringify(got.json)}`);
    const d = got.json || {};
    ck('  with a line for every bank account in the chart',
       Array.isArray(d.banks) && d.banks.length === R.bankAccounts().length,
       JSON.stringify((d.banks || []).map((b) => b.code)));
    ck('  each carrying its own in-gap and out-gap, not one net figure',
       (d.banks || []).every((b) => b.reconcile && 'inGap' in b.reconcile && 'outGap' in b.reconcile));
    ck('  and the list of what needs her, both directions',
       (d.banks || []).every((b) => b.unexplained && b.unexplained.bankNotInBooks && b.unexplained.booksNotInBank));

    // ── THE ONE THAT WOULD LET A LIE THROUGH ─────────────────────────────
    // nothingNeedsYou is the sentence she will act on. It must be false while
    // the journal cannot post everything, because every figure beside it is
    // then a floor rather than a total — the books portal's own lesson, where
    // an incomplete journal produces a smaller profit that looks correct.
    //
    // My first version of this read "complete === true OR nothing === false",
    // which in an empty test store passes because the journal IS complete —
    // so it stayed green when the route was changed to ignore completeness
    // altogether. A check that can only pass is not a check. So the journal
    // is deliberately BROKEN here first.
    //
    // The break is a carrier invoice she typed with a paid figure and no
    // payment behind it: postings.js cannot say which account the money left,
    // so it returns a problem instead of guessing a bank. (An IMPORTED row
    // would now post to BofA — her answer of 2026-10-08 — which is exactly
    // why the fixture is marked manual.)
    fs.writeFileSync(cfg.CARRIER_INVOICES_FILE, JSON.stringify([{
        id: 'BROKEN', company: 'Edge Metals', key: 'ntg:NOBANK', carrier: 'ntg', ref: 'NOBANK',
        amount: 400, paid: 400, status: 'paid', invoice_date: '2026-04-02',
        paid_dates: ['2026-04-03'], source: 'manual',
    }], null, 2));
    const broken = (await req('GET', '/api/bank/reconcile', { sid })).json || {};
    ck('the journal reports itself incomplete when an entry cannot post',
       broken.journal && broken.journal.complete === false,
       JSON.stringify((broken.journal || {}).problems || []));
    ck('  and "nothing needs you" is therefore false, whatever the banks say',
       broken.nothingNeedsYou === false,
       JSON.stringify({ nothing: broken.nothingNeedsYou,
                        banksAgree: (broken.banks || []).map((b) => b.reconcile.agrees) }));
    fs.writeFileSync(cfg.CARRIER_INVOICES_FILE, '[]');

    // No live Balance call. Plaid bills a flat fee per successful
    // /accounts/balance/get, and this route is hit on every page load — a
    // billed call hanging off a page load is an invoice that grows with how
    // often she refreshes.
    const routeSrc = fs.readFileSync(path.join(ROOT, 'helpers/bankMatchRoutes.js'), 'utf8');
    const reconBlock = routeSrc.slice(routeSrc.indexOf("'/api/bank/reconcile'"),
                                      routeSrc.indexOf("'/api/plaid/status'"));
    ck('the route makes no billed Balance call', reconBlock.length > 200
       && !/balance\/get|signal\/evaluate/.test(reconBlock), String(reconBlock.length));

    // ── AND THE PAGE ACTUALLY CALLS IT ───────────────────────────────────
    const page = fs.readFileSync(path.join(ROOT, 'dashboard/bank-match.html'), 'utf8');
    ck('bank-match.html fetches the route', page.includes("api('/api/bank/reconcile')"));
    // The call must be UNCONDITIONAL. `/load\(\)[\s\S]{0,400}renderReconcile\(\)/`
    // was my first version and it matched `if (false) renderReconcile();`
    // perfectly happily — a check shaped like the old code rather than like
    // the property, which CLAUDE.md §2 names as the second failure shape this
    // suite keeps producing.
    const loadBody = page.slice(page.indexOf('async function load()'),
                                page.indexOf('async function showAliases'));
    ck('  from load(), so it is on screen without pressing anything',
       /\n\s*renderReconcile\(\);/.test(loadBody), loadBody.slice(0, 300));
    // Comments stripped first. My first version failed on this file's OWN
    // comment explaining why "all clear" must not be printed — a check that
    // reads prose as if it were output.
    const shown = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
    ck('  and it says "movement agrees", never "all clear"',
       /movement agrees/.test(shown) && !/all clear/i.test(shown),
       (shown.match(/.{0,40}all clear.{0,40}/i) || [''])[0]);
    // Her $5,000-cancels-$5,000 case, on the screen rather than only in the
    // helper: two separate rows, so they cannot net to a reassuring zero.
    ck('  showing in and out on their own lines',
       /in — bank/.test(page) && /out — bank/.test(page));

    server.close();

    console.log(`\n  ${pass} passed, ${fail} failed`);
    if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('threw:', e && e.stack); process.exit(1); });
