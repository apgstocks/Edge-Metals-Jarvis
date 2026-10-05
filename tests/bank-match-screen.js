// ── tests/bank-match-screen.js ────────────────────────────────────────────
// The screen helpers/reconcile.js never got.
//
// This RENDERS the page in JSDOM against a fixture shaped like the real
// /api/bank/match response, then asserts the DOM — not the source text. A
// grep over HTML proves a string exists; it does not prove the row appears,
// the name is escaped, or the Confirm button posts the right allocations.
//
// The fixture is deliberately nasty: a supplier called "Carlos G & C",
// because tests/quickbooks-page.js section B caught exactly that name being
// written into innerHTML raw.

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
const HTML = fs.readFileSync(path.join(ROOT, 'dashboard/bank-match.html'), 'utf8');

// ── the fixture ───────────────────────────────────────────────────────────
const MATCH = {
    rows: [
        { deposit: { id: 'TX-1', date: '2026-09-05', amount: 47000,
            descriptor: 'WIRE IN CARLOS G & C <b>', bank_guess: 'BofA' },
          party: 'Carlos G & C', outcome: 'proposed', ambiguous: false, truncated: false,
          proposals: [{ kind: 'combined', score: 0.84,
            allocations: [
              { doc_id: 'S1', label: 'EM-1001 (Auto Cast)', amount: 18000, shortfall: 0, clears: true },
              { doc_id: 'S2', label: 'EM-1002 (Auto Cast)', amount: 29000, shortfall: 0, clears: true }],
            reasons: ['2 invoices add up to this deposit exactly', 'paid 35 days after the oldest invoice'] }] },
        { deposit: { id: 'TX-2', date: '2026-09-06', amount: 10000, descriptor: 'ZELLE FROM SOMEBODY' },
          outcome: 'no_party', ambiguous: false,
          note: 'nothing in the ledger is named "ZELLE FROM SOMEBODY" — name it once and every future deposit from them matches itself',
          proposals: [], suggestions: [] },
        { deposit: { id: 'TX-3', date: '2026-09-07', amount: 12000, descriptor: 'WIRE IN TWINS LLC', bank_guess: 'BofA' },
          party: 'Twins LLC', outcome: 'proposed', ambiguous: true, truncated: false,
          proposals: [
            { kind: 'partial', score: 0.5, allocations: [{ doc_id: 'T1', label: 'EM-2001', amount: 12000, shortfall: 0, clears: false, leaves: 6000 }],
              reasons: ['part payment — this does not clear the invoice', '2 of her open invoices could each take this payment — nothing in the data says which, so this one needs you'] },
            { kind: 'partial', score: 0.5, allocations: [{ doc_id: 'T2', label: 'EM-2002', amount: 12000, shortfall: 0, clears: false, leaves: 3000 }],
              reasons: ['part payment — this does not clear the invoice'] }] },
        { deposit: { id: 'TX-4', date: '2026-09-08', amount: 21970, descriptor: 'WIRE IN SHORTPAY', bank_guess: 'BofA' },
          party: 'Shortpay Co', outcome: 'proposed', ambiguous: false,
          proposals: [{ kind: 'exact', score: 0.95,
            allocations: [{ doc_id: 'S9', label: 'EM-3001', amount: 21970, shortfall: 30, clears: true }],
            reasons: ['one invoice, to the cent', '30.00 short of the invoice total'] }] },
        { deposit: { id: 'TX-5', date: '2026-09-09', amount: 99999, descriptor: 'WIRE IN BIG' },
          party: 'Big Co', outcome: 'more_than_owed', ambiguous: false,
          note: 'Big Co owes 1000.00 and this deposit is 99999.00 — 98999.00 of it belongs to something not in Jarvis',
          proposals: [] },
    ],
    totals: { deposits: 190969, confident: 68970, needs_you: 121999 },
    counts: { deposits: 5, confident: 2, ambiguous: 1, no_party: 1, more_than_owed: 1, nothing_open: 0, no_combination: 0, truncated: 0 },
    open_invoices: 7, customers_with_open: 4, learned_names: 3,
    balance_disagreements: [],
    other_company: [{ id: 'TX-9', date: '2026-09-10', amount: 33000, company: 'EDGE TRADING INC', desc: 'WIRE RULE FIVE' }],
    ledger: { rows: 9, worklist: 5, in: { count: 5, money: 190969 }, out: { count: 0, money: 0 },
        excluded: { count: 2, money: 4235 }, pending: { count: 1, money: 900 }, drifted: 1,
        companies: ['Edge Metals INC', 'EDGE TRADING INC'], no_company: 0 },
    feed: 'bank-transactions.json',
    modes: ['Wire', 'Zelle', 'Cash', 'Cheque'],
    banks: ['BofA', 'Chase Bank'],
};

const posted = [];

// ── fetch HAS TO EXIST BEFORE THE PAGE'S SCRIPT RUNS ─────────────────────
// The page calls load() at the bottom of its script, which JSDOM executes
// during construction. Assigning dom.window.fetch afterwards is too late —
// the first run had already failed with "fetch is not defined" and rendered
// its own error card, which is a perfectly good imitation of a broken page.
// beforeParse is the hook that lands before any of it.
function makeDom(matchBody) {
    const stub = (window) => {
        window.fetch = async (url, opts) => {
            const body = opts && opts.body ? JSON.parse(opts.body) : null;
            posted.push({ url, method: (opts && opts.method) || (body ? 'POST' : 'GET'), body });
            const u = String(url);
            if (u.startsWith('/api/bank/match')) return { ok: true, json: async () => matchBody };
            if (u.startsWith('/api/bank/aliases')) return { ok: true, json: async () => ({ ok: true, aliases: [] }) };
            if (u.startsWith('/api/bank/exclude')) return { ok: true, json: async () => ({ ok: true }) };
            if (u.startsWith('/api/sales-receipts')) return { ok: true, json: async () => ({ ok: true, id: 'R1' }) };
            return { ok: false, json: async () => ({ error: 'unexpected ' + u }) };
        };
    };
    return new JSDOM(HTML, {
        runScripts: 'dangerously',
        url: 'https://localhost/bank-match',
        beforeParse: stub,
    });
}
const settle = () => new Promise((r) => setTimeout(r, 30));

(async () => {

let dom, w, doc;

// ── A — THE PAGE RENDERS THE DEPOSITS ─────────────────────────────────────
{
    section('A — the deposits are on the screen');

    dom = makeDom(MATCH); w = dom.window; doc = w.document;
    await settle();

    const err = doc.querySelector('#list .lbl');
    ck('the page loaded without an error card', !err || !/could not load/i.test(err.textContent || ''),
       doc.getElementById('list').textContent.slice(0, 200));

    const cards = [...doc.querySelectorAll('#list .card')];
    ck('one card per deposit', cards.length === 5, String(cards.length));
    ck('  the first deposit shows its amount formatted',
       /\$47,000\.00/.test(cards[0].textContent), cards[0].querySelector('.amt').textContent);
    ck('  and its date', /2026-09-05/.test(cards[0].textContent));

    // The allocations, with her invoice numbers rather than internal ids.
    ck('the proposed allocation lists her invoice numbers',
       /EM-1001/.test(cards[0].textContent) && /EM-1002/.test(cards[0].textContent),
       cards[0].querySelector('.alloc') ? cards[0].querySelector('.alloc').textContent : '(no alloc table)');
    ck('  with each amount', /\$18,000\.00/.test(cards[0].textContent) && /\$29,000\.00/.test(cards[0].textContent));
    ck('  and the reasons in words',
       /add up to this deposit exactly/.test(cards[0].textContent), cards[0].textContent.slice(0, 300));
    ck('  and the confidence as a percentage', /84%/.test(cards[0].textContent));
}

// ── B — HER NAMES ARE ESCAPED ─────────────────────────────────────────────
// "Carlos G & C" with a "<b>" after it. This is the check that caught the
// same bug on the QuickBooks page.
{
    section('B — "Carlos G & C" and an angle bracket');

    const card = doc.querySelectorAll('#list .card')[0];
    ck('the supplier name appears intact', /Carlos G & C/.test(card.textContent), card.textContent.slice(0, 160));
    ck('  and the bank description too', /WIRE IN CARLOS G & C/.test(card.textContent));
    // The real test: no element was created out of her text.
    ck('  no <b> element was created from her description',
       card.querySelector('b') === null, card.innerHTML.slice(0, 300));
    ck('  and the whole page has no injected element',
       doc.querySelectorAll('#list b').length === 0);
}

// ── C — WHAT NEEDS HER IS MARKED AS SUCH ──────────────────────────────────
{
    section('C — ambiguous, unknown payer, and more than owed');

    const cards = [...doc.querySelectorAll('#list .card')];

    // Unknown payer: no suggestions in the fixture, so a free-text box.
    const unknown = cards[1];
    ck('an unknown payer gets a way to name them',
       !!unknown.querySelector('[data-learnfree]') && !!unknown.querySelector('[data-name]'),
       unknown.innerHTML.slice(0, 200));
    ck('  and it says the answer is needed only once',
       /matches itself/.test(unknown.textContent), unknown.textContent.slice(0, 200));
    ck('  with no Confirm button, because there is nothing to confirm',
       unknown.querySelector('[data-confirm]') === null);

    // Ambiguous: the rivals must be visible, not just the winner.
    const amb = cards[2];
    ck('an ambiguous row is marked as needing her',
       /needs you/i.test(amb.textContent), amb.textContent.slice(0, 160));
    ck('  and the OTHER possibility is shown, not hidden',
       !!amb.querySelector('.rivals') && /EM-2002/.test(amb.querySelector('.rivals').textContent),
       amb.querySelector('.rivals') ? amb.querySelector('.rivals').textContent : '(no rivals block)');
    ck('  a part payment says what would still be owed',
       /leaves \$6,000\.00/.test(amb.textContent), amb.textContent.slice(0, 300));
    ck('  and it is NOT shown as a confident percentage',
       !/8[0-9]%|9[0-9]%|100%/.test(amb.textContent), amb.textContent.slice(0, 200));

    // More than owed: the unexplained figure, in words.
    const big = cards[4];
    ck('a deposit bigger than everything owed says how much is unexplained',
       /98999\.00 of it belongs to something not in Jarvis/.test(big.textContent),
       big.textContent.slice(0, 240));
    ck('  and offers no allocation to confirm', big.querySelector('[data-confirm]') === null);
}

// ── D — THE NUMBERS AT THE TOP ────────────────────────────────────────────
// Excluded and pending are their own chips. A screen that folds them into
// one figure has to be trusted; one that shows what it set aside can be
// checked.
{
    section('D — the strip of numbers, including what was set aside');

    const chips = doc.getElementById('chips').textContent;
    ck('ready and its money', /2 ready · \$68,970\.00/.test(chips), chips);
    ck('  what needs her, and its money', /3 need you · \$121,999\.00/.test(chips), chips);
    ck('  the ambiguous count', /1 ambiguous/.test(chips), chips);
    ck('  the unknown payer count', /1 unknown payer/.test(chips), chips);
    ck('  EXCLUDED is shown with its total, not omitted',
       /2 excluded · \$4,235\.00/.test(chips), chips);
    ck('  pending is its own figure', /1 pending/.test(chips), chips);
    ck('  a row the bank restated is flagged', /1 restated by the bank/.test(chips), chips);
    ck('  and the names learned are countable and clickable',
       /3 names learned/.test(chips) && !!doc.querySelector('[data-show="aliases"]'), chips);
}

// ── E — RULE 5 AND DRIFT ARE SAID, NOT DROPPED ────────────────────────────
{
    section('E — the other company, and the bank changing its mind');

    const extras = doc.getElementById('extras').textContent;
    ck('a deposit in the other company\'s account is named',
       /EDGE TRADING INC/.test(extras) && /\$33,000\.00/.test(extras), extras.slice(0, 300));
    ck('  and it says why it is not matched here',
       /different company/.test(extras), extras.slice(0, 400));
    ck('a restated row gets its own notice',
       /changed its mind/.test(extras), extras.slice(0, 200));
}

// ── F — CONFIRM POSTS TO THE RECEIPTS ROUTE ───────────────────────────────
// The rule the whole feature rests on: there is one way to mark an invoice
// paid, and this screen uses it.
{
    section('F — pressing Confirm');

    posted.length = 0;
    const card = doc.querySelectorAll('#list .card')[0];
    const bankSel = card.querySelector('[data-bank]');
    ck('the account is pre-filled from the deposit\'s own bank',
       bankSel && bankSel.value === 'BofA', bankSel && bankSel.value);
    ck('  and the mode list comes from the server, not the page',
       [...card.querySelectorAll('[data-mode] option')].map((o) => o.textContent).join(',') === 'Wire,Zelle,Cash,Cheque',
       [...card.querySelectorAll('[data-mode] option')].map((o) => o.textContent).join(','));

    card.querySelector('[data-confirm]').click();
    await settle();

    const req = posted.find((p) => String(p.url).startsWith('/api/sales-receipts'));
    ck('it posts to /api/sales-receipts — the receipts screen\'s own route',
       !!req, JSON.stringify(posted.map((p) => p.url)));
    ck('  with the customer the matcher resolved',
       req.body.customer === 'Carlos G & C', JSON.stringify(req.body.customer));
    ck('  the deposit\'s date and amount',
       req.body.date === '2026-09-05' && req.body.amount === 47000, JSON.stringify(req.body));
    ck('  the mode and the account',
       req.body.mode === 'Wire' && req.body.bank === 'BofA', JSON.stringify({ m: req.body.mode, b: req.body.bank }));
    ck('  both allocations, by sale id',
       req.body.allocations.length === 2
       && req.body.allocations.map((a) => a.sale_id).join(',') === 'S1,S2',
       JSON.stringify(req.body.allocations));
    ck('  summing to the deposit',
       Math.abs(req.body.allocations.reduce((t, a) => t + a.amount, 0) - 47000) < 0.005,
       JSON.stringify(req.body.allocations.map((a) => a.amount)));
    ck('  and the bank transaction id as the reference, so it can be traced back',
       req.body.ref === 'TX-1', String(req.body.ref));
    ck('  no deduction on a full payment',
       req.body.allocations.every((a) => a.deduction_amount === undefined),
       JSON.stringify(req.body.allocations));
}

// ── G — A SHORT PAYMENT ASKS WHICH KIND OF SHORTFALL ──────────────────────
// salesReceipts.js keeps bank_charge and discount apart because one is a
// cost to Edge Metals and the other reduces what was earned, and conflating
// them flatters the margin on every short payment. So the screen must ask.
{
    section('G — 30 dollars short');

    posted.length = 0;
    const card = doc.querySelectorAll('#list .card')[3];
    ck('the shortfall is shown on the row', /short \$30\.00/.test(card.textContent), card.textContent.slice(0, 300));

    w.prompt = () => 'fee';
    card.querySelector('[data-confirm]').click();
    await settle();
    let req = posted.find((p) => String(p.url).startsWith('/api/sales-receipts'));
    ck('answering "fee" records a bank charge',
       req && req.body.allocations[0].deduction_amount === 30
       && req.body.allocations[0].deduction_reason === 'bank_charge',
       JSON.stringify(req && req.body.allocations));
    ck('  and the allocation is what actually arrived',
       req.body.allocations[0].amount === 21970, String(req.body.allocations[0].amount));

    // The other answer must give the other reason — if both mapped to
    // bank_charge the question would be theatre.
    posted.length = 0;
    const dom2 = makeDom(MATCH); await settle();
    dom2.window.prompt = () => 'discount';
    dom2.window.document.querySelectorAll('#list .card')[3].querySelector('[data-confirm]').click();
    await settle();
    req = posted.find((p) => String(p.url).startsWith('/api/sales-receipts'));
    ck('answering "discount" records a discount instead',
       req && req.body.allocations[0].deduction_reason === 'discount',
       JSON.stringify(req && req.body.allocations));

    // And refusing to answer must not post a half-classified receipt.
    posted.length = 0;
    const dom3 = makeDom(MATCH); await settle();
    dom3.window.prompt = () => null;
    dom3.window.document.querySelectorAll('#list .card')[3].querySelector('[data-confirm]').click();
    await settle();
    ck('cancelling the question records nothing at all',
       !posted.some((p) => String(p.url).startsWith('/api/sales-receipts')),
       JSON.stringify(posted.map((p) => p.url)));
}

// ── H — EXCLUDING ASKS WHY ────────────────────────────────────────────────
{
    section('H — set aside, with a reason');

    posted.length = 0;
    const dom4 = makeDom(MATCH); await settle();
    const d4 = dom4.window.document;
    dom4.window.prompt = () => 'bank analysis fee';
    const btn = d4.querySelector('[data-exclude]');
    ck('every row can be set aside', !!btn);
    btn.click();
    await settle();
    const req = posted.find((p) => String(p.url).startsWith('/api/bank/exclude'));
    ck('  it posts to the exclude route', !!req, JSON.stringify(posted.map((p) => p.url)));
    ck('  carrying the row and her reason',
       req.body.id === 'TX-1' && req.body.reason === 'bank analysis fee', JSON.stringify(req.body));

    posted.length = 0;
    const dom5 = makeDom(MATCH); await settle();
    dom5.window.prompt = () => null;
    dom5.window.document.querySelector('[data-exclude]').click();
    await settle();
    ck('  and cancelling excludes nothing',
       !posted.some((p) => String(p.url).startsWith('/api/bank/exclude')),
       JSON.stringify(posted.map((p) => p.url)));
}

// ── I — NO FEED IS NOT A CLEAN RECONCILIATION ─────────────────────────────
{
    section('I — before the bank is connected');

    const empty = { ...MATCH, rows: [], counts: { ...MATCH.counts, deposits: 0, confident: 0, ambiguous: 0, no_party: 0 },
        totals: { deposits: 0, confident: 0, needs_you: 0 },
        other_company: [], ledger: { ...MATCH.ledger, drifted: 0, excluded: { count: 0, money: 0 }, pending: { count: 0, money: 0 } },
        feed: 'none yet — connect the bank feed or no deposits have been pulled' };
    const dom6 = makeDom(empty); await settle();
    const d6 = dom6.window.document;
    ck('it says there is no feed', /no bank feed/i.test(d6.getElementById('feednote').textContent),
       d6.getElementById('feednote').textContent);
    ck('  and does not imply everything reconciles',
       !/all reconciled|nothing to do|up to date/i.test(d6.body.textContent),
       'an empty list and a clean reconciliation are not the same thing');
}

// ── J — THE PAGE IS ACTUALLY REACHABLE ────────────────────────────────────
// The failure this whole feature is a response to. Three things have to line
// up or it is reconcile.js again.
{
    section('J — you can get to it, and it can get to the server');

    const routes = fs.readFileSync(path.join(ROOT, 'helpers/bankMatchRoutes.js'), 'utf8');
    ck('the page is served by a route', /app\.get\('\/bank-match'/.test(routes));
    ck('  from a file that exists', fs.existsSync(path.join(ROOT, 'dashboard/bank-match.html')));
    ck('  and the mount is wired into api.js',
       /require\('\.\/helpers\/bankMatchRoutes'\)\.mount\(app, cfg\)/.test(
           fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8')));

    // Every /api/ URL the page calls must exist on the server, and every
    // bank route must be called by the page. Both directions, because the
    // first catches a typo and the second catches a dead permission.
    const calls = [...new Set([...HTML.matchAll(/'(\/api\/[a-z0-9/_-]+)'/g)].map((m) => m[1]))];
    const served = [...routes.matchAll(/app\.(get|post|delete)\('(\/api\/bank\/[a-z-]+)'/g)].map((m) => m[2]);
    const orphanCalls = calls.filter((u) => u.startsWith('/api/bank/') && !served.includes(u));
    ck('every /api/bank URL the page calls exists on the server',
       orphanCalls.length === 0, orphanCalls.join(', '));
    const unused = served.filter((u) => !calls.includes(u) && u !== '/api/bank/include');
    ck('  and every bank route except include has a caller on this page',
       unused.length === 0, unused.join(', ') + ' — a route with no button is the reconcile.js defect');
    ck('  the page also posts to the receipts route rather than a bank one',
       calls.includes('/api/sales-receipts'), JSON.stringify(calls));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('threw:', e && e.stack); process.exit(1); });
