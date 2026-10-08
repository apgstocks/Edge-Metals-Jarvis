// ── tests/plaid.js ────────────────────────────────────────────────────────
// Apsara, 2026-10-05: the bank feed, from her own Plaid dashboard.
//
// ── THE CHECK THIS FILE EXISTS FOR IS SECTION C ──────────────────────────
// config.js:342, about bank-item.json: the Plaid access token "is the
// standing ability to pull this account's history, it does not expire on its
// own, and it must never appear in an API response or a log line."
//
// A sentence in a comment does not enforce that. So section C takes the
// fixture token and searches every returned object, every thrown message and
// every status payload for it. It is the one check here that protects
// something that cannot be undone: a leaked access token cannot be recalled,
// and it does not expire.
//
// NOTHING HERE REACHES THE NETWORK. Every call takes an injected fetchImpl,
// and section A proves that an un-stubbed call cannot run at all because the
// keys are absent — which is also the production state until she sets them.

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-plaid-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.BANK_ITEM_FILE = path.join(TMP, 'bank-item.json');
process.env.BANK_TX_FILE = path.join(TMP, 'bank-transactions.json');
process.env.PLAID_CLIENT_ID = 'cid-TESTCLIENT123';
process.env.PLAID_SECRET = 'sek-TESTSECRET456';
process.env.PLAID_ENV = 'sandbox';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated — refusing to run against real data');
    process.exit(1);
}
const P = require(path.join(ROOT, 'helpers/plaid'));
if (!String(P.ITEM_FILE()).startsWith(TMP)) {
    console.error('  ABORT  plaid would write ' + P.ITEM_FILE());
    process.exit(1);
}

// ── the fake Plaid ────────────────────────────────────────────────────────
const TOKEN = 'access-sandbox-11111111-2222-3333-4444-555555555555';
const PUBLIC = 'public-sandbox-99999999-8888-7777-6666-555555555555';
const calls = [];
function fakeFetch(script) {
    return async (url, opts) => {
        const body = JSON.parse(opts.body);
        calls.push({ url, body });
        const endpoint = String(url).replace(/^https?:\/\/[^/]+/, '');
        const r = script[endpoint];
        if (!r) return { ok: false, status: 404, text: async () => JSON.stringify({ error_code: 'NO_STUB', error_message: endpoint }) };
        const out = typeof r === 'function' ? r(body) : r;
        if (out && out.__http) return { ok: false, status: out.__http, text: async () => JSON.stringify(out.payload) };
        return { ok: true, status: 200, text: async () => JSON.stringify(out) };
    };
}
const tx = (id, amount, name, acc = 'plaid-acc-1', extra = {}) =>
    ({ transaction_id: id, date: '2026-09-05', amount, name, account_id: acc, pending: false, ...extra });

const LINK_OK = {
    '/link/token/create': { link_token: 'link-sandbox-abc', expiration: '2026-10-05T12:00:00Z' },
    '/item/public_token/exchange': { access_token: TOKEN, item_id: 'item-1' },
    '/accounts/get': { accounts: [{ account_id: 'plaid-acc-1', name: 'Business Checking', mask: '4321', subtype: 'checking', type: 'depository' }] },
    '/sandbox/public_token/create': { public_token: PUBLIC },
};

(async () => {

// ── A — IT CANNOT RUN WITHOUT HER KEYS, AND SAYS SO ───────────────────────
{
    section('A — before the keys are set');

    const keepId = process.env.PLAID_CLIENT_ID;
    delete process.env.PLAID_CLIENT_ID;
    delete require.cache[require.resolve(path.join(ROOT, 'config'))];
    delete require.cache[require.resolve(path.join(ROOT, 'helpers/plaid'))];
    const P2 = require(path.join(ROOT, 'helpers/plaid'));
    ck('with no client id it reports itself unconfigured', P2.configured() === false);
    let why = null;
    try { await P2.linkToken({ fetchImpl: fakeFetch(LINK_OK) }); } catch (e) { why = e.message; }
    ck('  and a call refuses rather than reaching out',
       /not configured/.test(why || '') && /\.env/.test(why || ''), String(why));
    ck('  telling her where the keys live, not asking for them here',
       /Plaid dashboard/.test(why || '') && /do not belong in a chat/.test(why || ''), String(why));
    ck('  and the status says which half is missing',
       /not set on this server/.test((P2.status().note) || ''), JSON.stringify(P2.status().note));

    process.env.PLAID_CLIENT_ID = keepId;
    delete require.cache[require.resolve(path.join(ROOT, 'config'))];
    delete require.cache[require.resolve(path.join(ROOT, 'helpers/plaid'))];
}
const Plaid = require(path.join(ROOT, 'helpers/plaid'));

// ── B — A TYPO MUST NEVER POINT AT PRODUCTION ─────────────────────────────
{
    section('B — the environment, when the env var is wrong');

    for (const [val, want] of [['sandbox', 'sandbox'], ['production', 'production'],
        ['prodution', 'sandbox'], ['PROD', 'sandbox'], ['', 'sandbox'], ['Sandbox ', 'sandbox']]) {
        process.env.PLAID_ENV = val;
        delete require.cache[require.resolve(path.join(ROOT, 'config'))];
        delete require.cache[require.resolve(path.join(ROOT, 'helpers/plaid'))];
        const p = require(path.join(ROOT, 'helpers/plaid'));
        ck(`PLAID_ENV "${val}" resolves to ${want}`, p.env() === want, p.env());
    }
    process.env.PLAID_ENV = 'sandbox';
    delete require.cache[require.resolve(path.join(ROOT, 'config'))];
    delete require.cache[require.resolve(path.join(ROOT, 'helpers/plaid'))];
}
const Q = require(path.join(ROOT, 'helpers/plaid'));

// ── C — THE TOKEN NEVER LEAVES ────────────────────────────────────────────
// The reason this file exists.
{
    section('C — the access token, which cannot be recalled once leaked');

    calls.length = 0;
    const out = await Q.exchange(PUBLIC, { fetchImpl: fakeFetch(LINK_OK), institution: 'ins_109508' });

    ck('the exchange succeeded', out && out.item_id === 'item-1', JSON.stringify(out));

    const hunt = (o) => JSON.stringify(o || '').includes(TOKEN);
    ck('exchange() does NOT return the access token', !hunt(out), JSON.stringify(out));
    ck('itemsPublic() does not carry it', !hunt(Q.itemsPublic()), JSON.stringify(Q.itemsPublic()));
    ck('status() does not carry it', !hunt(Q.status()), JSON.stringify(Q.status()));

    // It IS on disk, in the file backup.js excludes. That is the design, not
    // an accident, so it is asserted rather than left implied.
    const onDisk = fs.readFileSync(P.ITEM_FILE(), 'utf8');
    ck('it IS stored on disk, which is the design', onDisk.includes(TOKEN));
    const backup = require(path.join(ROOT, 'helpers/backup'));
    ck('  and that file is excluded from the Drive backup',
       backup.isSecret(path.basename(P.ITEM_FILE())) === true,
       path.basename(P.ITEM_FILE()));

    // Plaid echoes request fields back inside some error bodies, which is
    // how a secret reaches a log without anyone writing it there.
    let msg = null;
    try {
        await Q.syncItem('item-1', { fetchImpl: fakeFetch({
            '/transactions/sync': { __http: 400, payload: {
                error_code: 'INVALID_INPUT',
                error_message: `bad access_token ${TOKEN} for secret ${process.env.PLAID_SECRET}`,
            } },
        }) });
    } catch (e) { msg = e.message; }
    ck('an error that echoes the token back is redacted',
       !!msg && !msg.includes(TOKEN), String(msg));
    ck('  and the client secret too', !msg.includes(process.env.PLAID_SECRET), String(msg));
    ck('  while still saying what went wrong',
       /INVALID_INPUT/.test(msg || ''), String(msg));

    // A token this process has never seen is still stripped — the shape is
    // matched, not the known value.
    const unseen = 'access-production-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    ck('an unfamiliar token is redacted by shape',
       !Q.redact(`leaked ${unseen}`).includes(unseen), Q.redact(`leaked ${unseen}`));
    ck('  as is a public token and a link token',
       !Q.redact(PUBLIC).includes(PUBLIC) && !Q.redact('link-sandbox-abcdef').includes('abcdef'),
       Q.redact(PUBLIC + ' link-sandbox-abcdef'));

    // And the token IS what was sent to Plaid — redaction must not have
    // broken the actual call.
    const sent = calls.find((c) => /public_token\/exchange/.test(c.url));
    ck('the exchange sent her real client id and secret to Plaid',
       sent && sent.body.client_id === process.env.PLAID_CLIENT_ID
       && sent.body.secret === process.env.PLAID_SECRET,
       'redaction is for what comes OUT, never for what goes to Plaid');
}

// ── D — THE CURSOR, AND WHAT A RE-SYNC DOES ───────────────────────────────
// /transactions/sync rather than /transactions/get, because the modified and
// removed lists are the whole point.
{
    section('D — added, modified, removed');

    const ledger = require(path.join(ROOT, 'helpers/bankLedger'));
    fs.writeFileSync(cfg.BANK_TX_FILE, '[]');

    let page = 0;
    const script = {
        '/transactions/sync': (body) => {
            page += 1;
            if (page === 1) {
                ck('    the first sync sends no cursor', body.cursor === undefined, JSON.stringify(body.cursor));
                return { added: [tx('T1', -47000, 'WIRE IN A'), tx('T2', 12000, 'CHECK 1041')],
                    modified: [], removed: [], next_cursor: 'cur-1', has_more: true };
            }
            if (page === 2) {
                ck('    the second page sends the cursor it was given', body.cursor === 'cur-1', String(body.cursor));
                return { added: [tx('T3', -5000, 'WIRE IN B')], modified: [], removed: [],
                    next_cursor: 'cur-2', has_more: false };
            }
            ck('    a later sync resumes from the stored cursor', body.cursor === 'cur-2', String(body.cursor));
            return { added: [], modified: [tx('T2', 12500, 'CHECK 1041')],
                removed: [{ transaction_id: 'T3' }], next_cursor: 'cur-3', has_more: false };
        },
    };

    const first = await Q.syncItem('item-1', { fetchImpl: fakeFetch(script) });
    ck('it pages until has_more is false', first.pages === 2, String(first.pages));
    ck('  collecting every added row', first.added.length === 3,
       JSON.stringify(first.added.map((x) => x.transaction_id)));
    ck('  and it advanced the cursor', first.cursor_advanced === true);
    ck('  the cursor is remembered, not re-derived',
       Q.itemsPublic()[0].cursor_set === true, JSON.stringify(Q.itemsPublic()[0]));

    await ledger.ingestPlaid(first.added);
    ck('the rows reach the ledger', ledger.list().length === 3, String(ledger.list().length));

    // The second sync brings a MODIFIED row and a REMOVED one.
    const second = await Q.syncAll({ fetchImpl: fakeFetch(script) });
    ck('a modified row is reported', second.modified === 1, JSON.stringify(second));
    ck('  and corrects its existing row rather than duplicating',
       ledger.list().length === 3 && ledger.list().find((r) => r.id === 'T2').amount === 12500,
       JSON.stringify(ledger.list().map((r) => [r.id, r.amount])));
    ck('a removed row is REPORTED, not silently deleted',
       second.removed.includes('T3') && !!ledger.list().find((r) => r.id === 'T3'),
       'a bank row vanishing after she allocated it is a question, not a tidy-up');
}

// ── E — ONE BANK FAILING MUST NOT HIDE THE OTHER ──────────────────────────
// She has two institutions. ITEM_LOGIN_REQUIRED on Chase must not take
// BofA's deposits off the screen.
{
    section('E — two banks, one of them broken');

    await Q.exchange(PUBLIC, { fetchImpl: fakeFetch({
        ...LINK_OK,
        '/item/public_token/exchange': { access_token: TOKEN + '-two', item_id: 'item-2' },
        '/accounts/get': { accounts: [{ account_id: 'plaid-acc-2', name: 'Chase Checking', mask: '9876', subtype: 'checking' }] },
    }), institution: 'ins_chase' });
    ck('a second institution is linked', Q.itemsPublic().length === 2,
       JSON.stringify(Q.itemsPublic().map((i) => i.item_id)));

    let which = 0;
    const out = await Q.syncAll({ fetchImpl: async (url, opts) => {
        const body = JSON.parse(opts.body);
        if (/transactions\/sync/.test(url)) {
            which += 1;
            if (body.access_token === TOKEN + '-two') {
                return { ok: false, status: 400, text: async () => JSON.stringify({
                    error_code: 'ITEM_LOGIN_REQUIRED',
                    error_message: 'the user must repair this item' }) };
            }
            return { ok: true, status: 200, text: async () => JSON.stringify({
                added: [tx('T9', -900, 'WIRE IN C')], modified: [], removed: [],
                next_cursor: 'cur-9', has_more: false }) };
        }
        return { ok: false, status: 404, text: async () => '{}' };
    } });

    ck('both items were attempted', which === 2, String(which));
    ck('  the working bank still delivered its deposit',
       out.added === 1 && out.items.some((i) => i.item_id === 'item-1'), JSON.stringify(out.items));
    ck('  the broken one is reported as an error, not a crash',
       out.errors.length === 1 && /ITEM_LOGIN_REQUIRED/.test(out.errors[0].error),
       JSON.stringify(out.errors));
    ck('  and that error carries no token either',
       !JSON.stringify(out).includes(TOKEN), 'a partial failure is the easiest place to leak one');
}

// ── F — THE SANDBOX PATH IS SANDBOX-ONLY ──────────────────────────────────
{
    section('F — the fake bank, and where it refuses');

    process.env.PLAID_ENV = 'production';
    delete require.cache[require.resolve(path.join(ROOT, 'config'))];
    delete require.cache[require.resolve(path.join(ROOT, 'helpers/plaid'))];
    const prod = require(path.join(ROOT, 'helpers/plaid'));
    let why = null;
    try { await prod.sandboxLink({ fetchImpl: fakeFetch(LINK_OK) }); } catch (e) { why = e.message; }
    ck('sandboxLink refuses in production', /sandbox-only/.test(why || ''), String(why));
    ck('  and names the environment it found', /production/.test(why || ''), String(why));

    process.env.PLAID_ENV = 'sandbox';
    delete require.cache[require.resolve(path.join(ROOT, 'config'))];
    delete require.cache[require.resolve(path.join(ROOT, 'helpers/plaid'))];
    const sb = require(path.join(ROOT, 'helpers/plaid'));
    const linked = await sb.sandboxLink({ fetchImpl: fakeFetch({
        ...LINK_OK,
        '/item/public_token/exchange': { access_token: TOKEN + '-sbx', item_id: 'item-sbx' },
    }) });
    ck('in sandbox it links a fake bank end to end', linked.item_id === 'item-sbx', JSON.stringify(linked));
    ck('  and still returns no token', !JSON.stringify(linked).includes(TOKEN));
}

// ── G — NO DEPENDENCY, AND NO MODULE-LEVEL fetch CAPTURE ──────────────────
// The QuickBooks token escape this morning happened because a default was
// not overridable at the call site.
{
    section('G — how it talks to Plaid');

    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    ck('no plaid package was added', !Object.keys(deps).some((d) => /^plaid$/i.test(d)),
       Object.keys(deps).filter((d) => /plaid/i.test(d)).join(', '));

    const src = fs.readFileSync(path.join(ROOT, 'helpers/plaid.js'), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    ck('fetch is resolved per call, never captured at module load',
       !/^const\s+\w*\s*=\s*fetch\b/m.test(code) && /fetchImpl \|\| \(typeof fetch/.test(code),
       'a captured default is what let a stubbed suite reach the network');
    ck('every outward call goes through one function',
       (code.match(/await f\(/g) || []).length === 1,
       'one door is the only way redaction and the key check cannot be skipped');
    ck('and every throw is redacted',
       !/throw new Error\((?!redact)/.test(code.replace(/const fail[^;]*;/, '')),
       (code.match(/throw new Error\([^)]*/g) || []).join(' | '));
}

// ── H — READ ONLY, AND PROVED BY NAMING THE WRITES ────────────────────────
// Apsara, 2026-10-08: "Also i want read only access for plaid account from
// jarvis.never write".
//
// The weak version of this test asserts that helpers/plaid.js does not call
// /transfer/create today. That passes on every repo that has never thought
// about it, and goes on passing until the day someone adds one. So this
// section drives the guard with Plaid's actual money-movement endpoints and
// requires a REFUSAL for each — the thing that keeps being true after a
// feature nobody has written yet.
{
    section('H — read only, enforced');

    // Plaid's endpoints that move money or alter her authorisations. If Plaid
    // adds one, this list is where it goes.
    const MOVES_MONEY = [
        '/transfer/create',
        '/transfer/authorization/create',
        '/transfer/cancel',
        '/payment_initiation/payment/create',
        '/payment_initiation/recipient/create',
        '/bank_transfer/create',
        '/signal/evaluate',
        '/auth/get',
        '/processor/token/create',
        '/item/access_token/invalidate',
        '/item/webhook/update',
    ];
    let refused = 0;
    const allowedByMistake = [];
    for (const e of MOVES_MONEY) {
        try { P.assertReadOnly(e); allowedByMistake.push(e); }
        catch (err) { refused += 1; }
    }
    ck('every money-movement endpoint is refused before any request',
       refused === MOVES_MONEY.length, 'allowed: ' + allowedByMistake.join(', '));
    ck('  and /auth/get in particular — it hands over the routing number',
       allowedByMistake.indexOf('/auth/get') === -1);
    ck('  and the refusal says it is her rule, not a bug',
       (() => { try { P.assertReadOnly('/transfer/create'); return false; }
                catch (e) { return /read-only/i.test(e.message); } })());

    // ── AND THE GUARD IS ACTUALLY WIRED INTO call() ──────────────────────
    // The three checks above drive assertReadOnly() directly. All three stayed
    // green when `assertReadOnly(endpoint)` was commented out of call(), which
    // is the only line that makes any of it matter — a unit test passing while
    // the wiring is gone, which is what CLAUDE.md §3 is about. So this drives
    // the real door and asserts the request never left: a guard that throws
    // AFTER fetch has run is not a guard.
    let reached = 0;
    const spy = async () => { reached += 1; return { ok: true, status: 200, text: async () => '{}' }; };
    let threw = null;
    try { await P.call('/transfer/create', { amount: '1.00' }, { fetchImpl: spy }); }
    catch (e) { threw = e; }
    ck('call() itself refuses a write endpoint', !!threw && /read-only/i.test(threw.message),
       threw ? threw.message : 'it did not throw');
    ck('  and no request was sent', reached === 0, `fetch ran ${reached} time(s)`);

    // The six Jarvis actually uses still work, or the guard has locked the
    // feature out instead of locking the writes out.
    let readsOk = 0;
    for (const e of ['/link/token/create', '/item/public_token/exchange', '/accounts/get',
                     '/transactions/sync', '/accounts/balance/get', '/institutions/get']) {
        try { P.assertReadOnly(e); readsOk += 1; } catch (err) {}
    }
    ck('the read endpoints are all still allowed', readsOk === 6, String(readsOk));

    // HER decision, 2026-10-08: "Keep Unlink calling Plaid". Asserted so the
    // exception stays an exception of ONE, with her name on it.
    ck('unlinking her own connection is the ONE permitted write — her call',
       P.PERMITTED_WRITES.has('/item/remove') && P.PERMITTED_WRITES.size === 1,
       [...P.PERMITTED_WRITES].join(', '));

    // A sandbox helper against production would create fake rows in her real
    // feed, which is a data-integrity problem dressed as a convenience.
    const realEnv = process.env.PLAID_ENV;
    ck('sandbox helpers work in sandbox',
       (() => { try { P.assertReadOnly('/sandbox/public_token/create'); return true; } catch (e) { return false; } })());
    process.env.PLAID_ENV = 'production';
    for (const k of Object.keys(require.cache)) if (k.startsWith(ROOT)) delete require.cache[k];
    const P2 = require(path.join(ROOT, 'helpers/plaid'));
    ck('  and are refused against production',
       (() => { try { P2.assertReadOnly('/sandbox/public_token/create'); return false; }
                catch (e) { return /sandbox endpoint/i.test(e.message); } })());
    process.env.PLAID_ENV = realEnv;
    for (const k of Object.keys(require.cache)) if (k.startsWith(ROOT)) delete require.cache[k];

    // ── WHAT HER BANK IS TOLD, WHICH IS NOT THE SAME THING ───────────────
    // The allowlist governs this server. `products` governs the consent
    // screen SHE reads at the bank. `auth` would widen that invisibly — no
    // endpoint call, no test failure, just a broader permission she granted.
    const P3 = require(path.join(ROOT, 'helpers/plaid'));
    ck('Link asks her bank for transactions and nothing else',
       P3.READ_PRODUCTS.length === 1 && P3.READ_PRODUCTS[0] === 'transactions',
       P3.READ_PRODUCTS.join(', '));
    ck('  and asking for auth or transfer is refused',
       (() => { try { P3.assertReadProducts(['transactions', 'auth']); return false; }
                catch (e) { return /read-only/i.test(e.message); } })());
    const src = fs.readFileSync(path.join(ROOT, 'helpers/plaid.js'), 'utf8');
    ck('  and no products array in the file names one of them',
       !/products:\s*\[[^\]]*['"](auth|transfer|payment_initiation|signal)['"]/.test(src));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('threw:', e && e.stack); process.exit(1); });
