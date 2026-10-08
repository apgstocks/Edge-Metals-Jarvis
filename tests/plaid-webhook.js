// ── tests/plaid-webhook.js ────────────────────────────────────────────────
// Apsara, 2026-10-08: "i dont want human intervention between jarvis and
// plaid."
//
// The answer is a webhook, and the cost of the answer is a PUBLIC,
// UNAUTHENTICATED POST route on the machine that holds her entire ledger.
// Every other route on that server is behind a session; this one cannot be,
// because Plaid cannot log in. The only thing in front of it is a signature
// check, so this file is mostly about that check refusing things.
//
// ── WHAT IT IS REALLY TESTING ────────────────────────────────────────────
// Not "does a valid webhook work" — that is the easy half and it passes on
// day one. The checks that matter are the ones that stay true later:
// alg:"none" refused, a replayed webhook refused, a tampered body refused,
// the wrong key refused, and a forgery answered 403 rather than 503 so
// Plaid stops rather than retrying it for 24 hours.
//
// NOTHING HERE REACHES THE NETWORK. The verification key is a locally
// generated P-256 key, injected.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-pwh-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.BANK_ITEM_FILE = path.join(TMP, 'bank-item.json');
process.env.BANK_TX_FILE = path.join(TMP, 'bank-transactions.json');

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated'); process.exit(1);
}
const W = require(path.join(ROOT, 'helpers/plaidWebhook'));

// ── a Plaid that is really us ─────────────────────────────────────────────
const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const JWK = publicKey.export({ format: 'jwk' });
const OTHER = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function sign(body, { iat = Math.floor(Date.now() / 1000), alg = 'ES256', kid = 'k1', hash, key = privateKey } = {}) {
    const h = b64({ alg, kid, typ: 'JWT' });
    const p = b64({ iat, request_body_sha256: hash !== undefined ? hash
        : crypto.createHash('sha256').update(body).digest('hex') });
    const sig = crypto.sign('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' });
    return `${h}.${p}.${sig.toString('base64url')}`;
}
const getKey = async () => JWK;
const BODY = JSON.stringify({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'i1' }, null, 2);

(async () => {

// ── A — the five steps, each refusing on its own ─────────────────────────
{
    section('A — what the signature check refuses');
    ck('a genuine webhook verifies', (await W.verify(BODY, { 'plaid-verification': sign(BODY) }, { getKey })).ok);

    // HTTP/2 headers are lowercase, HTTP/1.x are case-insensitive. Reading
    // only the canonical spelling works in testing and fails behind a load
    // balancer, which is the worst place to find out.
    ck('  however the header is capitalised',
       (await W.verify(BODY, { 'Plaid-Verification': sign(BODY) }, { getKey })).ok);

    const none = await W.verify(BODY, { 'plaid-verification': sign(BODY, { alg: 'none' }) }, { getKey });
    ck('alg "none" is refused — the classic JWT forgery', none.ok === false && /ES256/.test(none.why), none.why);
    const hs = await W.verify(BODY, { 'plaid-verification': sign(BODY, { alg: 'HS256' }) }, { getKey });
    ck('  and so is HS256, which would use the PUBLIC key as a shared secret',
       hs.ok === false, hs.why);

    const wrong = await W.verify(BODY, { 'plaid-verification': sign(BODY) }, { getKey: async () => OTHER });
    ck('a signature from the wrong key is refused', wrong.ok === false && /signature/.test(wrong.why), wrong.why);

    // Plaid: the hash "is sensitive to the whitespace in the webhook body".
    const tampered = await W.verify(`${BODY} `, { 'plaid-verification': sign(BODY) }, { getKey });
    ck('a body changed by one byte is refused', tampered.ok === false && /body/.test(tampered.why), tampered.why);

    const old = await W.verify(BODY, { 'plaid-verification': sign(BODY, { iat: Math.floor(Date.now() / 1000) - 600 }) }, { getKey });
    ck('a ten-minute-old webhook is refused as a replay', old.ok === false && /replay/.test(old.why), old.why);
    const fresh = await W.verify(BODY, { 'plaid-verification': sign(BODY, { iat: Math.floor(Date.now() / 1000) - 120 }) }, { getKey });
    ck('  but two minutes is fine — retries are normal', fresh.ok === true, fresh.why);
    ck('  and the window is Plaid\'s five minutes, named', W.MAX_AGE_SECONDS === 300);

    ck('no header at all is refused', (await W.verify(BODY, {}, { getKey })).ok === false);
    ck('a body with no signature to match is refused',
       (await W.verify(BODY, { 'plaid-verification': sign(BODY, { hash: '' }) }, { getKey })).ok === false);
}

// ── B — THE ORDER OF THE STEPS ───────────────────────────────────────────
// `iat` is attacker-controlled until the signature is checked. A verifier
// that reads the age first is trusting a number anyone could have written —
// and it would also leak, by timing, which forgeries got further.
{
    section('B — nothing in the payload is believed before the signature');
    const forgedOld = sign(BODY, { iat: Math.floor(Date.now() / 1000) - 99999, key: crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey });
    const r = await W.verify(BODY, { 'plaid-verification': forgedOld }, { getKey });
    ck('a forged, ancient webhook fails on the SIGNATURE, not the age',
       r.ok === false && /signature/.test(r.why), r.why);
}

// ── C — what each webhook means ──────────────────────────────────────────
{
    section('C — sync, hers, or ignore');
    const act = (b) => W.classify(b).action;
    ck('new transactions mean pull, with nobody told',
       act({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE' }) === 'sync');
    ck('a login that has expired is HERS — only she can sign in at the bank',
       act({ webhook_type: 'ITEM', webhook_code: 'ERROR', error: { error_code: 'ITEM_LOGIN_REQUIRED' } }) === 'hers');
    ck('  and so is a pending disconnect',
       act({ webhook_type: 'ITEM', webhook_code: 'PENDING_DISCONNECT' }) === 'hers');
    ck('  and revoked permission',
       act({ webhook_type: 'ITEM', webhook_code: 'USER_PERMISSION_REVOKED' }) === 'hers');
    ck('a product Jarvis does not use is ignored',
       act({ webhook_type: 'ASSETS', webhook_code: 'PRODUCT_READY' }) === 'ignore');

    // ── THE DEFAULT MATTERS ──────────────────────────────────────────────
    // Plaid adds webhook codes. If an unknown one defaulted to `sync`, a
    // Plaid release would silently change what this server does.
    ck('a webhook code nobody has heard of is IGNORED, never synced',
       act({ webhook_type: 'TRANSACTIONS', webhook_code: 'SOMETHING_PLAID_ADDS_IN_2027' }) === 'ignore');
    ck('  and an empty body does not look like new transactions', act({}) === 'ignore');

    ck('"hers" says plainly that no API can do it',
       /no API can do this|only she can/i.test(W.classify({ webhook_type: 'ITEM', webhook_code: 'PENDING_DISCONNECT' }).why));
}

// ── D — THROUGH THE REAL ROUTE, PUBLIC AND UNAUTHENTICATED ───────────────
{
    section('D — the real route, with no session');
    process.env.APP_PASSWORD   = process.env.APP_PASSWORD   || 'user-pw-aaaaaaaaaaaa';
    process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pw-bbbbbbbbbbb';
    process.env.STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'staff-pw-ccccccccccc';
    process.env.PLAID_CLIENT_ID = 'cid-TESTCLIENT123';
    process.env.PLAID_SECRET = 'sek-TESTSECRET456';

    const { createApi } = require(path.join(ROOT, 'api'));
    const app = createApi();
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;

    const post = (body, headers) => new Promise((resolve, reject) => {
        const h = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers };
        const rq = http.request(`${base}/api/plaid/webhook`, { method: 'POST', headers: h }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: raw }));
        });
        rq.on('error', reject); rq.write(body); rq.end();
    });

    // No Authorization header, no cookie — a session gate in front of this
    // would make the whole feature impossible, so this is the check that
    // the route really is mounted above it.
    const noSig = await post(BODY, {});
    ck('the route is reachable with NO session at all', noSig.status !== 401 && noSig.status !== 302,
       `${noSig.status} ${noSig.body.slice(0, 120)}`);
    ck('  and an unsigned body is refused 403, so Plaid stops retrying it',
       noSig.status === 403, String(noSig.status));

    const forged = await post(BODY, { 'Plaid-Verification': sign(BODY, { key: crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey }) });
    ck('  and the refusal body leaks nothing about why',
       !/signature|key|hash|jwt/i.test(forged.body), forged.body.slice(0, 160));

    // ── WHY THE FORGED CASE IS 503 HERE AND NOT 403 ──────────────────────
    // Checking a signature needs Plaid's public key, and there is no
    // reachable Plaid in a test — so the forged webhook never gets as far
    // as failing on its signature; it fails on the key fetch, which is
    // correctly "come back later". That is honest behaviour and it means
    // the route cannot be driven through both branches from here.
    //
    // My first version asserted 403 and failed, which was the test being
    // wrong rather than the code. The DECISION is now plaidWebhook.statusFor
    // and is checked directly, below.
    const genuine = await post(BODY, { 'Plaid-Verification': sign(BODY) });
    ck('with no reachable Plaid every refusal is 503, so nothing is lost',
       genuine.status === 503 && forged.status === 503,
       `genuine ${genuine.status}, forged ${forged.status}`);

    ck('a forgery that CAN be checked is 403 — Plaid must stop retrying it',
       W.statusFor('the signature does not match Plaid\'s key') === 403);
    ck('  as is a replay, a bad body hash and a bad alg',
       W.statusFor('this webhook is 600s old — refused as a replay') === 403
       && W.statusFor('the body does not match the hash Plaid signed') === 403
       && W.statusFor('the JWT says alg "none" — only ES256 is accepted') === 403);
    ck('  but a key we could not fetch is 503, or one bad minute loses a disconnection notice',
       W.statusFor('could not fetch Plaid\'s verification key: socket hang up') === 503
       && W.statusFor('Plaid returned no verification key') === 503);

    server.close();
}

// ── E — the wiring that makes it arrive at all ───────────────────────────
{
    section('E — Plaid has to be told where to push');
    const src = fs.readFileSync(path.join(ROOT, 'helpers/plaid.js'), 'utf8');
    ck('the link token carries a webhook when one is configured',
       /if \(cfg\.PLAID_WEBHOOK_URL\) body\.webhook = cfg\.PLAID_WEBHOOK_URL;/.test(src));
    ck('  and OMITS it when not, rather than guessing a URL',
       !/body\.webhook = cfg\.PLAID_WEBHOOK_URL \|\|/.test(src));
    ck('the verification-key endpoint is allowlisted as a read',
       require(path.join(ROOT, 'helpers/plaid')).READ_ONLY.has('/webhook_verification_key/get'));
    // It must still be a READ. Allowlisting it is only safe because it
    // takes a key id and returns a public key.
    ck('  and it is in READ_ONLY, not in the permitted-writes set',
       !require(path.join(ROOT, 'helpers/plaid')).PERMITTED_WRITES.has('/webhook_verification_key/get'));

    const api = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
    ck('the raw body is captured for the webhook path only',
       /req\.url\.split\('\?'\)\[0\] === '\/api\/plaid\/webhook'/.test(api));
    ck('the route is registered ABOVE the session gate',
       api.indexOf("app.post('/api/plaid/webhook'") < api.indexOf('Session gate on everything else'),
       'mounted below the gate, so Plaid would be redirected to /login');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('threw:', e && e.stack); process.exit(1); });
