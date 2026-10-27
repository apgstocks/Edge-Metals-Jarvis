// ── tests/bank-review-route.js ────────────────────────────────────────────
// Apsara, 2026-10-08: "i want like pending,posted transactions like qb with
// match,post".
//
// helpers/bankOut.js and helpers/bankReview.js were both written this
// morning and reached by NOTHING. helpers/reconcile.js is the precedent and
// it is not hypothetical — it worked perfectly from 3 September and had no
// screen, so nobody used it. A helper with no route is the same defect one
// step earlier.
//
// So this file is mostly about reachability, and about the one thing the
// route deliberately does NOT do: reuse /api/bank/match's handler.

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-revroute-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.BANK_TX_FILE = path.join(TMP, 'bank-transactions.json');
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'staff-pw-ccccccccccc';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated'); process.exit(1);
}

(async () => {

// A bank row that left BofA, and a supplier payment in her books for the
// same money on the same day. The queue should call that a match.
const row = {
    id: 'bk1', date: '2026-04-10', desc: 'AJ TRANSPORT LLC ACH', party: 'AJ TRANSPORT LLC',
    category: '', spent: 2180, received: 0, amount: 2180, direction: 'out',
    bank: 'BofA', company: 'Edge Metals INC', pending: false, excluded: false,
};
const orphan = { ...row, id: 'bk2', date: '2026-04-12', spent: 955, amount: 955,
    desc: 'MONTHLY MAINTENANCE FEE', party: '' };
// A carrier carrierInvoices.js will actually take, added 2026-10-10 beside
// the hauler it will not. The pair is the point: one row earns a button and
// one does not, and before today both got one.
const carrier = { ...row, id: 'bk3', date: '2026-04-13', spent: 1420, amount: 1420,
    desc: 'NTG LOGISTICS ACH DEBIT', party: 'NTG LOGISTICS' };
fs.writeFileSync(process.env.BANK_TX_FILE, JSON.stringify([row, orphan, carrier], null, 2));

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
        res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j, raw }); });
    });
    rq.on('error', reject); if (data) rq.write(data); rq.end();
});

const sid = ((await req('POST', '/login', { body: { password: process.env.ADMIN_PASSWORD } })).json || {}).sid;

// ── A — IT IS REACHABLE AT ALL ───────────────────────────────────────────
{
    section('A — the route exists and answers');
    ck('signed in', !!sid);
    const got = await req('GET', '/api/bank/review', { sid });
    ck('the route answers 200', got.status === 200, `${got.status} ${String(got.raw).slice(0, 160)}`);
    const d = got.json || {};
    ck('  with a queue', !!d.queue && Array.isArray(d.queue.rows), JSON.stringify(Object.keys(d)));
    ck('  and a line per bank in the chart', Array.isArray(d.banks) && d.banks.length >= 2,
       JSON.stringify((d.banks || []).map((b) => b.code)));
    ck('  and it needs a session', (await req('GET', '/api/bank/review')).status === 401);
}

// ── B — MONEY OUT IS IN THE QUEUE, WHICH IS THE WHOLE POINT ─────────────
// /api/bank/match is money IN only and always has been. Both withdrawals
// above must appear, because a page with the receipts on it and the
// payments somewhere else is how half a bank goes unlooked-at.
{
    section('B — withdrawals reach her');
    const d = (await req('GET', '/api/bank/review', { sid })).json;
    const ids = d.queue.rows.map((r) => r.id);
    ck('both withdrawals are in the queue', ids.includes('bk1') && ids.includes('bk2'),
       JSON.stringify(ids));
    ck('  every row is money out, since nothing came in', d.queue.rows.every((r) => r.direction === 'out'));

    // ── CORRECTED 2026-10-10 ─────────────────────────────────────────────
    // This used to assert that AJ Transport came back as `add` with "Add as
    // a carrier bill", and it did. There was no store that would have
    // taken the record: carrierInvoices.js accepts tql, ntg and schneider,
    // and AJ Transport is in partyInvoices.js — a register fed from her
    // Google sheet by upsertMany(), with no single-row add and a lock.
    // Pressing the button would have reached addManual and come back
    // "carrier must be one of tql, ntg, schneider".
    //
    // So the row still SAYS what Jarvis knows it is, and no longer offers a
    // one-press that nothing could honour. See tests/bank-review.js
    // section B for the full list and the invariant that keeps the regex in
    // step with the store.
    const aj = d.queue.rows.find((r) => r.id === 'bk1');
    ck('a party-register hauler is recognised but NOT offered a carrier-bill button',
       aj.state === 'ask' && aj.kind === 'party-invoice', JSON.stringify(aj));
    ck('  and is told where to pay it instead', /Transport tab/.test(aj.why || ''), aj.why);

    // The carrier that IS in carrierInvoices still gets the button, which
    // is the half of this that has to keep working.
    const ntgRow = d.queue.rows.find((r) => /NTG/.test(r.descriptor || ''));
    ck('an NTG row IS offered a carrier bill — her wording',
       !!ntgRow && ntgRow.state === 'add' && ntgRow.label === 'Add as a carrier bill',
       JSON.stringify(ntgRow));
    ck('  and carries the account it would post to', ntgRow && ntgRow.account === '5200',
       ntgRow && ntgRow.account);
    const fee = d.queue.rows.find((r) => r.id === 'bk2');
    ck('the bank fee is offered as a bank charge', fee.label === 'Add as a bank charge', fee.label);
    ck('every row says why', d.queue.rows.every((r) => String(r.why || '').trim().length > 0));
}

// ── C — THE INCOMPLETE-JOURNAL RULE, CARRIED HERE TOO ───────────────────
// Same as /api/bank/reconcile: an incomplete journal makes every figure a
// floor, and a queue built on one is missing payments. Saying so is not
// optional — a short queue reads as a quiet morning.
{
    section('C — it says when the books under it are incomplete');
    fs.writeFileSync(cfg.CARRIER_INVOICES_FILE, JSON.stringify([{
        id: 'BROKEN', company: 'Edge Metals', key: 'ntg:NOBANK', carrier: 'ntg', ref: 'NOBANK',
        amount: 400, paid: 400, status: 'paid', invoice_date: '2026-04-02',
        paid_dates: ['2026-04-03'], source: 'manual',
    }], null, 2));
    const d = (await req('GET', '/api/bank/review', { sid })).json;
    ck('an unpostable entry makes the journal incomplete', d.journal.complete === false,
       JSON.stringify(d.journal));
    ck('  and the route says payments may be missing from the queue',
       /may be missing/.test(d.note || ''), String(d.note));
    fs.writeFileSync(cfg.CARRIER_INVOICES_FILE, '[]');
    const clean = (await req('GET', '/api/bank/review', { sid })).json;
    ck('  and says nothing when the journal is whole', clean.note === null, String(clean.note));
}

// ── D — THE TWO ROUTES MUST NOT DRIFT ───────────────────────────────────
// /api/bank/review deliberately does NOT reuse /api/bank/match's handler:
// that handler serves a live screen, the local store is empty, and an
// extraction cannot be proven behaviour-preserving against data nobody
// here has. helpers/partyName.js's rule is that an extraction changes
// nothing AND is proven by snapshot, and the snapshot is what is missing.
//
// The cost of not extracting is drift. This is what catches it: both
// routes read the same ledger, so a row excluded for one must be excluded
// for the other, and neither may invent a row the other cannot see.
{
    section('D — the two routes read the same ledger');
    const review = (await req('GET', '/api/bank/review', { sid })).json;
    const match = (await req('GET', '/api/bank/match', { sid })).json;
    ck('both routes answer', !!review && !!match);

    const ledger = require(path.join(ROOT, 'helpers/bankLedger'));
    const all = ledger.list();
    const outIds = ledger.worklist(all).filter((r) => r.direction === 'out').map((r) => r.id).sort();
    ck('review covers exactly the OUT rows of the worklist',
       JSON.stringify(review.queue.rows.map((r) => r.id).sort()) === JSON.stringify(outIds),
       JSON.stringify({ queue: review.queue.rows.map((r) => r.id), outIds }));
    ck('  and match covers the IN rows, so together they are the worklist',
       (match.rows || []).every((r) => (r.deposit || {}).id !== 'bk1'),
       JSON.stringify((match.rows || []).map((r) => (r.deposit || {}).id)));

    // An excluded row must vanish from BOTH. If Exclude works on one screen
    // and not the other, the button is decoration on one of them.
    const ex = await req('POST', '/api/bank/exclude', { sid, body: { id: 'bk2', reason: 'not a business cost' } });
    ck('a row can be excluded', ex.status === 200, JSON.stringify(ex.json));
    const after = (await req('GET', '/api/bank/review', { sid })).json;
    ck('  and it leaves the review queue too', !after.queue.rows.some((r) => r.id === 'bk2'),
       JSON.stringify(after.queue.rows.map((r) => r.id)));
}

// ── D2 — PRESSING MATCH ──────────────────────────────────────────────────
// Apsara, 2026-10-08: "wire them". Only ONE of the five states is wired,
// and the restraint is the design: a match CREATES NOTHING — it ties a
// bank row to a payment she already recorded — which is what makes it safe
// to press in bulk and safe for an overnight auto-tick. Anything that
// creates a record goes through the plan screen.
{
    section('D2 — the Match button');
    // A withdrawal with a supplier payment behind it, so the queue calls it
    // a match rather than offering to create something.
    const bills = require(path.join(ROOT, 'helpers/bills'));
    await bills.addBill({ supplier: 'Hugo', date: '2026-05-01', container_no: 'MATCHME1',
        supplier_price: 0.30 });

    const paired = { id: 'bk3', date: '2026-05-02', desc: 'WIRE TO HUGO', party: 'Hugo',
        category: '', spent: 7777, received: 0, amount: 7777, direction: 'out',
        bank: 'BofA', company: 'Edge Metals INC', pending: false, excluded: false };
    const all = JSON.parse(fs.readFileSync(process.env.BANK_TX_FILE, 'utf8'));
    fs.writeFileSync(process.env.BANK_TX_FILE, JSON.stringify(all.concat([paired]), null, 2));

    // Nothing in her books pays 7,777, so this is NOT a match — and the
    // route must refuse rather than tick off a row that matches nothing.
    const wrong = await req('POST', '/api/bank/review/match', { sid, body: { id: 'bk3' } });
    ck('a row that is not an exact match is REFUSED', wrong.status === 409,
       `${wrong.status} ${JSON.stringify(wrong.json)}`);
    ck('  and says which state it actually is', !!(wrong.json || {}).state,
       JSON.stringify(wrong.json));
    ck('  and for an "add" row, says it would CREATE a record',
       /CREATE a record/.test(JSON.stringify(wrong.json)) || (wrong.json || {}).state === 'choose',
       JSON.stringify(wrong.json));

    const missing = await req('POST', '/api/bank/review/match', { sid, body: { id: 'nope' } });
    ck('an unknown row is a 404', missing.status === 404, String(missing.status));
    ck('a row id is required', (await req('POST', '/api/bank/review/match', { sid, body: {} })).status === 400);

    // ── AND A ROW THAT IS TICKED LEAVES THE QUEUE ────────────────────────
    // Without this it comes straight back, the button looks broken, and she
    // presses it again — which is how a feature is abandoned on its first
    // morning.
    const ledger = require(path.join(ROOT, 'helpers/bankLedger'));
    await ledger.markMatched('bk3', { keys: ['x'], why: 'test' }, { by: 'test', how: 'her' });
    const after = (await req('GET', '/api/bank/review', { sid })).json;
    ck('a matched row leaves the review queue',
       !after.queue.rows.some((r) => r.id === 'bk3'),
       JSON.stringify(after.queue.rows.map((r) => r.id)));

    // Silenced is never hidden: the tick is on the row, reversible, and
    // the history says who and how.
    const saved = ledger.list().find((r) => r.id === 'bk3');
    ck('  but the row still exists, with the tick on it', !!saved && !!saved.matched,
       JSON.stringify(saved && saved.matched));
    ck('  recording who and whether it was auto or her',
       saved.matched.by === 'test' && saved.matched.how === 'her', JSON.stringify(saved.matched));
    ck('  and a history line that can be read back later',
       (saved.history || []).some((h) => /matched to a recorded payment/.test(h.what)),
       JSON.stringify(saved.history));
}

// ── E — AND A HUMAN CAN REACH IT ────────────────────────────────────────
// helpers/reconcile.js is the precedent: it worked perfectly from 3
// September and had no screen, so nobody used it. A route with no client
// is the same defect one step along, and these four helpers — bankOut,
// bankReview, ledgerPlan, ledgerApply — were all written today with
// nothing calling them.
{
    section('E — the screen actually calls it');
    const page = fs.readFileSync(path.join(ROOT, 'dashboard/bank-match.html'), 'utf8');
    ck('bank-match.html fetches the review route', page.includes("api('/api/bank/review')"));
    // Unconditional, and from load(). `if (false) renderReview()` matched a
    // looser regex happily when I made this mistake on renderReconcile.
    const loadBody = page.slice(page.indexOf('async function load()'),
                                page.indexOf('async function showAliases'));
    ck('  from load(), so it is on screen without pressing anything',
       /\n\s*renderReview\(\);/.test(loadBody), loadBody.slice(0, 400));
    // ── AND THE MATCHED LIST, THE SAME WAY, FOR THE SAME REASON ─────────
    // It was added to pickAcct() only, so it rendered when she switched bank
    // account and not when she opened the page. The slice above is the real
    // load() body (load() to showAliases), which is why this catches it.
    ck('  and so is the matched list, or the unmatch button has nothing to sit on',
       /\n\s*renderMatched\(\);/.test(loadBody), loadBody.slice(0, 600));
    ck('  and the money-out section has its own place on the page',
       /id="review"/.test(page));
    ck('  the matched list has a place on the page too',
       /id="matchedlist"/.test(page));

    // ── THE PICKER IS REACHABLE, 2026-10-27 ─────────────────────────────
    // #163 exists because helpers/reconcile.js went dead unnoticed: a route
    // with no client is worse than no route, because the suite is green and
    // nothing happens on screen. So the picker gets the same treatment as
    // the review route itself.
    ck('the screen calls the payment picker', page.includes("api('/api/bank/review/payments?id='"));
    ck('  from a control on the row, not a page the row cannot reach',
       /data-pickopen=/.test(page) && /\[data-pickopen\]/.test(page));
    ck('  and the tie posts back to the match route',
       /data-picktie=/.test(page) && /\[data-picktie\]/.test(page));
    ck('  every money-out row offers it, including the "Choose" dead end',
       /\$\{pickBtn\(r\)\}/.test(page) && /function pickBtn/.test(page),
       'pickBtn must be called unconditionally in the row markup');
    // The gap must be CONFIRMED on screen, not swallowed by the client
    // sending confirm_gap on the first attempt — which would make the
    // server guard decoration.
    ck('  the client does NOT pre-confirm the gap',
       !/confirm_gap: true \}/.test(page.replace(/\.\.\.\(confirmGap \? \{ confirm_gap: true \} : \{\}\)/g, '')),
       'confirm_gap may only be sent when she has pressed the second button');
    ck('  and the refusal becomes a second, labelled press',
       /needs_confirm/.test(page) && /data-pickconfirm/.test(page));
    // The bulk offer must say what it does NOT cover, or it reads like
    // QuickBooks' accept-all.
    ck('  the bulk offer says it is exact matches only',
       /Only exact matches/.test(page));
    // Buttons come from the server's state vocabulary; the page must not
    // invent an action the server will not perform.
    ck('  Match is a button and posts to the route',
       /data-reviewmatch=/.test(page) && page.includes("api('/api/bank/review/match'"));
    // A dead button is worse than a missing one: she presses it, nothing
    // happens, and she stops trusting the screen. So rows that would
    // CREATE a record render as a label, not a control.
    // No `||` fallback. My first version offered a second pattern that
    // matched whether or not the ternary was keyed on the state, so the
    // mutation "the screen gives a dead button to rows it cannot act on"
    // survived it. An alternative in an assertion is usually a way of
    // making it pass.
    ck('  a row that would create a record gets a label, not a button',
       // 2026-10-09 redesign: the Match button became `btn solid`. The class
       // is styling; the property is that it sits behind the state ternary.
       /\$\{r\.state === 'match'\s*\n\s*\? `<button class="btn (?:go|solid)" data-reviewmatch/.test(page),
       'the Match button must be behind a state check, not rendered for every row');
    // 2026-10-13: the plan screen and the categoriser now exist, so the page must
    // not say "not built yet". What it must still do is say plainly which rows have
    // an action and which do not, so a label is never mistaken for a button.
    ck('  and the page says which of those have an action now, and which still have none',
       /categorised/.test(page) && /apply a plan/.test(page) && /still have no action/.test(page)
       && !/not built yet, so they are listed without a button/.test(page));
}


// ── UNMATCH, 2026-10-27 ──────────────────────────────────────────────────
// Apsara: "for matched things, there should be a unmatch option". There was
// none. bankLedger.setMatched has always taken a null match and writes
// "match undone" for it; nothing reachable called it. `categorise` got an
// /undo and `match` never did, so a matched row was a one-way door.
//
// That became urgent the moment helpers/bankAutoTick.js (#187) began ticking
// rows at 06:50 unattended. Its own header calls it reversible. It was
// reversible only in a helper she could not reach.
//
// End to end through the real server, because the gap was never in the
// helper — it was that nothing called it.
{
    section('UNMATCH — the way back from a matched row');

    // A row ticked by the overnight job, written as that job writes it.
    const ticked = { ...row, id: 'bk-auto', date: '2026-04-20', spent: 3000,
        amount: 3000, desc: 'WIRE OUT AUTOTICKED',
        matched: { at: '2026-04-21T06:50:00Z', by: null, how: 'auto', keys: ['k-1'] } };
    const current = JSON.parse(fs.readFileSync(process.env.BANK_TX_FILE, 'utf8'));
    fs.writeFileSync(process.env.BANK_TX_FILE,
        JSON.stringify(current.concat([ticked]), null, 2));

    const listed = await req('GET', '/api/bank/review/matched', { sid });
    ck('a matched row is listed somewhere she can see it', listed.status === 200
       && (listed.json.rows || []).some((r) => r.id === 'bk-auto'), JSON.stringify(listed.json).slice(0, 200));
    const mine = (listed.json.rows || []).find((r) => r.id === 'bk-auto') || {};
    ck('  and it says JARVIS ticked it, not her',
       mine.how === 'auto' && listed.json.auto >= 1, JSON.stringify(mine));

    ck('unmatching needs a row id', (await req('POST', '/api/bank/review/unmatch', { sid, body: {} })).status === 400);
    ck('  and an unknown row is a 404',
       (await req('POST', '/api/bank/review/unmatch', { sid, body: { id: 'nope' } })).status === 404);

    const done = await req('POST', '/api/bank/review/unmatch', { sid, body: { id: 'bk-auto' } });
    ck('a matched row can be unmatched', done.status === 200 && done.json.ok === true,
       JSON.stringify(done.json));
    ck('  and it hands back what it undid, since the row no longer knows',
       (done.json.was || {}).how === 'auto', JSON.stringify(done.json.was));

    const after = JSON.parse(fs.readFileSync(process.env.BANK_TX_FILE, 'utf8'))
        .find((r) => r.id === 'bk-auto');
    ck('  the tick is gone from the store', after && after.matched == null, JSON.stringify(after && after.matched));
    ck('  the history says it was undone, so it can be traced',
       (after.history || []).some((h) => /undone/i.test(h.what || '')), JSON.stringify(after.history));
    ck('  and the row itself is still there — unmatching destroys nothing',
       !!after && after.amount === 3000, JSON.stringify(after && after.amount));

    // ── THE AUDIT ENTRY, WHICH IS THE WHOLE POINT OF AUDITING IT ────────
    // The route's own comment says it is "audited like the categorise undo,
    // because 'who untied this, and when' is the question asked when a figure
    // moves and nobody remembers why". Nothing checked that, and the claim was
    // false: helpers/audit.js keeps a CLOSED allowlist of actions so a typo
    // becomes a visible 'unknown-action' row, and 'unmatch-bank-row' was not
    // on it. So every unmatch logged as unknown-action — present in the file,
    // invisible to anyone grepping for what they untied.
    const audits = require(path.join(ROOT, 'helpers/audit')).listEntries()
        .filter((a) => a.subject === 'bk-auto');
    ck('  the undo is audited under its own name, not as unknown-action',
       audits.length === 1 && audits[0].action === 'unmatch-bank-row',
       JSON.stringify(audits.map((a) => a.action)));
    ck('  naming who did it and what was undone — the row no longer knows',
       audits[0] && audits[0].actor && (audits[0].detail || {}).how === 'auto',
       JSON.stringify(audits[0] && { actor: audits[0].actor, detail: audits[0].detail }));

    const twice = await req('POST', '/api/bank/review/unmatch', { sid, body: { id: 'bk-auto' } });
    ck('unmatching twice says so plainly rather than looking broken',
       twice.status === 409 && twice.json.already === true, JSON.stringify(twice.json));

    const gone = await req('GET', '/api/bank/review/matched', { sid });
    ck('  and it has left the matched list', !(gone.json.rows || []).some((r) => r.id === 'bk-auto'),
       JSON.stringify(gone.json.rows || []).slice(0, 160));

    // ── THE ADMIN GATE, TESTED ON THE ROLE THAT REACHES THE HANDLER ─────
    // The first version of this asserted only that an ANONYMOUS request is
    // refused. A mutation deleting `admin(req, res)` from the route survived
    // it: an anonymous request never gets that far, because the session
    // middleware in api.js 401s first. So the check's name said "admin only"
    // while it tested the login gate — a check shaped like the old code
    // rather than like the property.
    //
    // 'user' is the role that proves it. A logged-in non-admin passes the
    // session middleware, is not caught by STAFF_ALLOWED_PATH_PREFIXES
    // (that one only looks at 'staff'), and lands in the handler, where
    // admin() is the only thing standing between it and an undo.
    const usid = ((await req('POST', '/login',
        { body: { password: process.env.APP_PASSWORD } })).json || {}).sid;
    ck('a non-admin can log in at all — the control for the next check',
       !!usid, JSON.stringify(usid));
    const asUser = await req('POST', '/api/bank/review/unmatch', { sid: usid, body: { id: 'bk-auto' } });
    ck('  and unmatching is refused for them — 403, not a 409 about state',
       asUser.status === 403, `${asUser.status} ${JSON.stringify(asUser.json)}`);
    // ── READING IS AS OPEN AS ITS SIBLING, AND NO MORE ──────────────────
    // I wrote this as "the matched list is admin-only too" and it went red
    // at 200. The code was right and the check was wrong: NONE of the three
    // reads on this screen (GET /api/bank/review, GET /api/bank/match, and
    // this one) is admin-gated, so a logged-in 'user' can already see the
    // unmatched withdrawal queue with its amounts and payees. Gating the new
    // route alone would make it the odd one out; gating all three is a
    // widening of her login model, which is hers to decide, not mine to slip
    // into a diff about an unmatch button. Task #234.
    //
    // So what is asserted is the PROPERTY that holds today — the two reads
    // are equally open — which will go red the day either one is gated, and
    // name the other as the thing to look at.
    const uReview = await req('GET', '/api/bank/review', { sid: usid });
    const uMatched = await req('GET', '/api/bank/review/matched', { sid: usid });
    ck('  reading the matched list is exactly as open as reading the queue beside it',
       uMatched.status === uReview.status,
       `matched ${uMatched.status} vs review ${uReview.status} — if these differ, one was gated and the other forgotten (#234)`);

    const anon = await req('POST', '/api/bank/review/unmatch', { body: { id: 'bk-auto' } });
    ck('  and nothing at all happens without a session', anon.status === 401 || anon.status === 403,
       String(anon.status));
}

// ── PICK A DIFFERENT PAYMENT, 2026-10-27 ─────────────────────────────────
// Apsara: "also if i want to match some other bill aganst this payment,there
// is no option right now na", and on what "some other" meant: "Say there is a
// payment made. Jarvis is matching one. If I want to match it against a
// different payment and not the one Jarvis matched".
//
// ── WHY THE OBVIOUS BUILD WOULD HAVE BEEN USELESS ────────────────────────
// "Show her the other candidates" serves none of her cases on a withdrawal.
// bankOut sets `ambiguous = sets.length > 1`, so a row reading 'Match' has
// exactly ONE candidate by construction; the payment she wants is by
// definition one the engine did not propose. Hence a list over her whole
// ledger for that bank, with the amount gap shown, and a confirmation before
// an inexact tie leaves her queue looking explained.
{
    section('PICK — tying a row to a payment Jarvis did not propose');

    const pr = (p, o) => req('GET', p, o);

    // ── A FIXTURE SHAPED LIKE HER SENTENCE ──────────────────────────────
    // "Say there is a payment made. Jarvis is matching one. If I want to
    // match it against a different payment and not the one Jarvis matched."
    // So: one bank row, and TWO recorded payments — one Jarvis will match to
    // the cent, and one she might know is really the right record. Its own
    // ids, not another section's `paired`, which is block-scoped and whose
    // 'bk3' already collides with the carrier row above it.
    const mine = { id: 'bk-pick', date: '2026-06-10', desc: 'WIRE OUT VEGA',
        party: 'Vega', category: '', spent: 5000, received: 0, amount: 5000,
        direction: 'out', bank: 'BofA', company: 'Edge Metals INC',
        pending: false, excluded: false };
    const before = JSON.parse(fs.readFileSync(process.env.BANK_TX_FILE, 'utf8'));
    fs.writeFileSync(process.env.BANK_TX_FILE,
        JSON.stringify(before.concat([mine]), null, 2));
    // Written through the real store path, and read back before going on —
    // tests/bank-auto-tick.js passed sixteen checks against a store that
    // never loaded because the filename was wrong.
    fs.writeFileSync(cfg.BILL_PAYMENTS_FILE, JSON.stringify([
        { id: 'PICK-A', supplier: 'Vega', date: '2026-06-10', amount: 5000,
          mode: 'Wire', bank: 'BofA', allocations: [] },
        { id: 'PICK-B', supplier: 'Vega', date: '2026-06-09', amount: 4900,
          mode: 'Wire', bank: 'BofA', allocations: [] },
    ], null, 2));
    const loaded = require(path.join(ROOT, 'helpers/billPayments')).list()
        .filter((x) => /^PICK-/.test(x.id || ''));
    ck('the fixture loaded through the real store — two recorded payments',
       loaded.length === 2, `${loaded.length} loaded`);
    ck('the picker needs a row', (await pr('/api/bank/review/payments', { sid })).status === 400);
    ck('  and an unknown row is a 404',
       (await pr('/api/bank/review/payments?id=nope', { sid })).status === 404);

    const list = await pr(`/api/bank/review/payments?id=${encodeURIComponent(mine.id)}`, { sid });
    ck('it offers the recorded payments for this row', list.status === 200
       && Array.isArray(list.json.rows), JSON.stringify(list.json).slice(0, 200));
    ck('  and says which bank row it is answering about',
       (list.json.row || {}).id === mine.id, JSON.stringify(list.json.row));
    // THE CONTROL. Everything below asserts refusals, and a refusal of an
    // empty list proves nothing — the lesson from tests/bank-auto-tick.js,
    // where sixteen checks passed against a store that never loaded.
    ck('  the list is NOT empty, so the refusals below mean something',
       (list.json.rows || []).length > 0,
       `considered ${list.json.considered} payment(s) — if 0, the fixture is not loading`);

    const offered = list.json.rows || [];
    ck('  every payment carries the gap against the bank row',
       offered.every((p) => typeof p.gap === 'number' && typeof p.exact === 'boolean'),
       JSON.stringify(offered[0]));
    ck('  exact ones come first, because that is how she would sort them',
       offered.every((p, i) => i === 0 || !(p.exact && !offered[i - 1].exact)),
       JSON.stringify(offered.map((p) => p.exact)));
    ck('  and each one names what it is, not just a key',
       offered.every((p) => p.key && (p.label || p.kind)), JSON.stringify(offered[0]));

    // ── THE REFUSALS, EACH ON A REAL REASON ─────────────────────────────
    const bad = await req('POST', '/api/bank/review/match',
        { sid, body: { id: mine.id, keys: ['not|a|real|key|0.00'] } });
    ck('a key that is not in her ledger is refused, not tied to nothing',
       bad.status === 409 && (bad.json.missing || []).length === 1,
       JSON.stringify(bad.json));

    const inexact = offered.find((p) => !p.exact);
    if (inexact) {
        const warn = await req('POST', '/api/bank/review/match',
            { sid, body: { id: mine.id, keys: [inexact.key] } });
        ck('an inexact tie is NOT made silently — it says the gap first',
           warn.status === 409 && warn.json.needs_confirm === true
           && typeof warn.json.gap === 'number', JSON.stringify(warn.json));
        ck('  and the row is still in the queue, untouched',
           ((await req('GET', '/api/bank/review', { sid })).json.queue.rows || [])
               .some((r) => r.id === mine.id), 'the refusal must change nothing');
    } else {
        console.log('  NOTE  this fixture has no inexact candidate; the gap guard is mutated separately');
    }

    // ── HER PICK, MADE ──────────────────────────────────────────────────
    // THE INEXACT one on purpose. Picking the exact candidate would have
    // been Jarvis's own answer, so it would prove nothing about overriding
    // it — and it would never have exercised the gap reaching the store,
    // which is where my first version of this silently failed: bankLedger
    // built the match object field by field and dropped everything it did
    // not name.
    const want = offered.find((p) => !p.exact && !p.taken_by)
        || offered.find((p) => !p.taken_by) || offered[0];
    const picked = await req('POST', '/api/bank/review/match',
        { sid, body: { id: mine.id, keys: [want.key], confirm_gap: true } });
    ck('she can tie the row to the payment SHE picked', picked.status === 200
       && picked.json.ok === true && picked.json.by_hand === true, JSON.stringify(picked.json));
    ck('  and it is recorded as hers, not as Jarvis’s own match',
       (await req('GET', '/api/bank/review/matched', { sid })).json.rows
           .some((r) => r.id === mine.id && r.how === 'her'), 'how must be her');
    const store = JSON.parse(fs.readFileSync(process.env.BANK_TX_FILE, 'utf8'))
        .find((r) => r.id === mine.id);
    ck('  the tick carries the key she chose and says it was by hand',
       ((store.matched || {}).keys || [])[0] === want.key && store.matched.by_hand === true,
       JSON.stringify(store.matched));
    ck('  and the gap is ON THE ROW, not only in the audit log',
       want.exact ? store.matched.gap == null
                  : Math.abs(Number(store.matched.gap) - want.gap) < 0.005,
       JSON.stringify({ stored: (store.matched || {}).gap, expected: want.gap }));
    ck('  and the history says she picked it herself',
       (store.history || []).some((h) => /picked it|picked herself/i.test(h.what || '')),
       JSON.stringify((store.history || []).map((h) => h.what)));

    const aud = require(path.join(ROOT, 'helpers/audit')).listEntries()
        .filter((a) => a.subject === mine.id && a.action === 'match-bank-row-by-hand');
    ck('  and it is audited under its own name, with what Jarvis WOULD have done',
       aud.length === 1 && Array.isArray((aud[0].detail || {}).jarvis_would_have),
       JSON.stringify(aud.map((a) => ({ action: a.action, detail: a.detail }))));

    // ── ONE PAYMENT, ONE BANK ROW ───────────────────────────────────────
    // Two bank rows pointing at one recorded payment would say the money
    // left the account twice. The key she just used is now spoken for.
    const twin = { ...mine, id: 'bk-twin', matched: undefined };
    delete twin.matched;
    const cur = JSON.parse(fs.readFileSync(process.env.BANK_TX_FILE, 'utf8'));
    fs.writeFileSync(process.env.BANK_TX_FILE, JSON.stringify(cur.concat([twin]), null, 2));

    const double = await req('POST', '/api/bank/review/match',
        { sid, body: { id: 'bk-twin', keys: [want.key], confirm_gap: true } });
    ck('a payment already tied to one bank row cannot be tied to a second',
       double.status === 409 && (double.json.clash || []).length === 1,
       JSON.stringify(double.json));
    ck('  and it names which row has it, so she can unmatch that one',
       ((double.json.clash || [])[0] || {}).row === mine.id, JSON.stringify(double.json.clash));

    // And the picker says so too, rather than offering it as free.
    const after = await pr(`/api/bank/review/payments?id=bk-twin`, { sid });
    const same = (after.json.rows || []).find((p) => p.key === want.key);
    ck('  the picker shows it as taken rather than hiding it — silenced is never hidden',
       !!same && same.taken_by === mine.id, JSON.stringify(same));

    // ── AND THE OLD PATH IS UNTOUCHED ───────────────────────────────────
    // `keys` absent must behave exactly as it did before today: Jarvis's own
    // proposal, and an 'add' row still refused. The bulk-match path and every
    // existing caller send no keys, which is why this check is the one that
    // matters most in this section.
    const noKeys = await req('POST', '/api/bank/review/match', { sid, body: { id: 'bk-twin' } });
    ck('with no keys, the route still does what it always did',
       noKeys.status === 200 || (noKeys.status === 409 && !noKeys.json.needs_confirm),
       `${noKeys.status} ${JSON.stringify(noKeys.json)}`);
}

server.close();

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('threw:', e && e.stack); process.exit(1); });
