// ── helpers/plaidWebhook.js — is this really from Plaid? ──────────────────
//
// Apsara, 2026-10-08: "i dont want human intervention between jarvis and
// plaid."
//
// The nightly 05:45 pull needs nobody, but it only tells her a connection
// has died up to a day late, and only by a figure looking stale. Webhooks
// are how Plaid says it the hour it happens. That means a PUBLIC,
// UNAUTHENTICATED POST route on the box that holds her entire ledger, and
// the only thing standing in front of it is this file.
//
// ── WHY THERE IS NO JWT LIBRARY HERE ─────────────────────────────────────
// Plaid's own sample uses jose + jwt-decode + js-sha256 + secure-compare.
// helpers/plaid.js's header records why this repo has no plaid dependency
// and the same reasoning applies harder here: `npm install` on the VM is
// already part of deploying a bank fix, the lockfile is out of step with
// package.json, and there are 27 open advisories. Four more packages in the
// path of an unauthenticated route is a worse trade than ~80 lines using
// Node's own crypto, which does ES256 natively.
//
// Verification is NOT invented here — it is Plaid's five documented steps,
// in order, each one named below. The place this is easy to get subtly and
// dangerously wrong is the signature encoding, and it is called out.
//
// ── WHAT A FAILURE MEANS ─────────────────────────────────────────────────
// Every path returns { ok:false, why } rather than throwing. The caller
// must be able to log WHY a webhook was rejected without the rejection
// itself becoming a 500 that Plaid retries for 24 hours.

const crypto = require('crypto');

// Plaid: "verify that the webhook is not more than 5 minutes old. Rejecting
// outdated webhooks can help prevent replay attacks."
const MAX_AGE_SECONDS = 300;

const b64urlToBuf = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function decodePart(part) {
    try { return JSON.parse(b64urlToBuf(part).toString('utf8')); }
    catch (e) { return null; }
}

// ── STEP 1: the JWT header, WITHOUT trusting it ──────────────────────────
// Decoded only to learn which key to ask for. Nothing in here is believed
// until the signature checks out — in particular `alg`, which is the
// classic JWT attack: a token claiming alg:"none" or alg:"HS256" tricks a
// naive verifier into skipping asymmetric verification or into using the
// PUBLIC key as an HMAC secret. Plaid signs with ES256, so anything else is
// refused outright rather than accommodated.
function readHeader(jwt) {
    const parts = String(jwt || '').split('.');
    if (parts.length !== 3) return { ok: false, why: 'the Plaid-Verification header is not a JWT' };
    const header = decodePart(parts[0]);
    if (!header) return { ok: false, why: 'the JWT header is not readable JSON' };
    if (header.alg !== 'ES256') {
        return { ok: false, why: `the JWT says alg "${header.alg}" — only ES256 is accepted` };
    }
    if (!header.kid) return { ok: false, why: 'the JWT header carries no key id' };
    return { ok: true, header, parts };
}

// ── STEP 3: the signature ────────────────────────────────────────────────
// THE TRAP, AND IT FAILS OPEN IF YOU GET IT WRONG BY GUESSING:
// a JWS ES256 signature is the raw concatenation r||s, 64 bytes. Node's
// crypto.verify expects DER-encoded ECDSA by default and simply returns
// FALSE on a raw signature — so the mistake does not throw, it rejects
// every genuine webhook, and the tempting "fix" is to stop verifying.
// `dsaEncoding: 'ieee-p1363'` is what tells Node the JWS encoding.
function verifySignature(parts, jwk) {
    let key;
    try { key = crypto.createPublicKey({ key: jwk, format: 'jwk' }); }
    catch (e) { return { ok: false, why: `the verification key is not usable: ${e.message}` }; }

    const signed = Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8');
    const sig = b64urlToBuf(parts[2]);
    let good = false;
    try {
        good = crypto.verify('sha256', signed, { key, dsaEncoding: 'ieee-p1363' }, sig);
    } catch (e) { return { ok: false, why: `signature check failed: ${e.message}` }; }
    return good ? { ok: true } : { ok: false, why: 'the signature does not match Plaid\'s key' };
}

// ── STEP 5: the body hash ────────────────────────────────────────────────
// Over the RAW bytes as they arrived. Plaid's note: "the request_body_sha256
// sent in the JWT payload is sensitive to the whitespace in the webhook
// body" — so a body that has been parsed and re-serialised will NOT match,
// however identical it looks. That is why the route captures the raw buffer
// before express.json touches it.
//
// Constant-time compare, per Plaid and for the ordinary reason: a
// byte-by-byte early return leaks how much of a forged hash was right.
function hashMatches(rawBody, claimed) {
    const want = String(claimed || '');
    if (!want) return { ok: false, why: 'the JWT carries no request_body_sha256' };
    const got = crypto.createHash('sha256').update(rawBody).digest('hex');
    const a = Buffer.from(got, 'utf8');
    const b = Buffer.from(want, 'utf8');
    if (a.length !== b.length) return { ok: false, why: 'the body hash is the wrong length' };
    return crypto.timingSafeEqual(a, b)
        ? { ok: true }
        : { ok: false, why: 'the body does not match the hash Plaid signed' };
}

// ── all five steps, in order ─────────────────────────────────────────────
// `getKey` is injected so a test never reaches the network — the same
// reason helpers/plaid.js takes fetchImpl, and the mistake its header
// records (a default captured at module load that a stubbed suite could
// not override).
async function verify(rawBody, headers = {}, { getKey, now = Date.now() } = {}) {
    // HTTP/2 headers are always lowercase and HTTP/1.x headers are
    // case-insensitive, so the lookup must be too. Plaid's docs say exactly
    // this, and reading only 'Plaid-Verification' would work in testing and
    // fail behind the load balancer.
    const lower = {};
    for (const [k, v] of Object.entries(headers || {})) lower[String(k).toLowerCase()] = v;
    const jwt = lower['plaid-verification'];
    if (!jwt) return { ok: false, why: 'no Plaid-Verification header — this did not come from Plaid' };

    const h = readHeader(jwt);
    if (!h.ok) return h;

    if (typeof getKey !== 'function') return { ok: false, why: 'no way to fetch the verification key' };
    let jwk = null;
    try { jwk = await getKey(h.header.kid); }
    catch (e) { return { ok: false, why: `could not fetch Plaid's verification key: ${e.message}` }; }
    if (!jwk) return { ok: false, why: 'Plaid returned no verification key' };

    const sig = verifySignature(h.parts, jwk);
    if (!sig.ok) return sig;

    // ── STEP 4: age. Only AFTER the signature, deliberately ──────────────
    // The payload is attacker-controlled until the signature is checked, so
    // reading iat first would be trusting a number anyone could have
    // written. Order matters here and nowhere else in this file.
    const payload = decodePart(h.parts[1]);
    if (!payload) return { ok: false, why: 'the JWT payload is not readable JSON' };
    const iat = Number(payload.iat);
    if (!isFinite(iat)) return { ok: false, why: 'the JWT carries no issued-at time' };
    const ageSeconds = Math.floor(now / 1000) - iat;
    if (ageSeconds > MAX_AGE_SECONDS) {
        return { ok: false, why: `this webhook is ${ageSeconds}s old — older than ${MAX_AGE_SECONDS}s is refused as a replay` };
    }
    // A webhook from the future is a clock problem or a forgery, and a
    // generous allowance is given for the former only.
    if (ageSeconds < -60) return { ok: false, why: 'this webhook is dated in the future' };

    const body = hashMatches(rawBody, payload.request_body_sha256);
    if (!body.ok) return body;

    return { ok: true, ageSeconds, keyId: h.header.kid };
}

// ── WHAT THE WEBHOOK IS TELLING US ───────────────────────────────────────
// Classified rather than acted on, so the decision is testable without a
// network, a store or a mailbox. Three outcomes and nothing else:
//
//   sync     new data is waiting — Jarvis pulls it, nobody is told
//   hers     the connection is broken in a way ONLY SHE can fix, by
//            re-authenticating at her bank's own site. No API can do this;
//            it is the one human step Plaid's design requires, and the
//            whole value of the webhook is that she hears about it in an
//            hour rather than from a stale figure two days later
//   ignore   everything else, recorded and not acted on
//
// Unknown codes are `ignore`, never `sync`: Plaid adds webhook types, and a
// default that triggers a pull would have new Plaid releases silently
// changing what this server does.
const NEEDS_HER = new Set([
    'ITEM_LOGIN_REQUIRED',      // she changed her bank password, or the bank revoked
    'PENDING_DISCONNECT',       // an institution migration she must re-consent to
    'PENDING_EXPIRATION',       // consent is running out (EU-style, but Plaid sends it)
    'USER_PERMISSION_REVOKED',
    'USER_ACCOUNT_REVOKED',
    'NEW_ACCOUNTS_AVAILABLE',   // she may want them; Jarvis must not assume
]);
const MEANS_SYNC = new Set([
    'SYNC_UPDATES_AVAILABLE',
    'DEFAULT_UPDATE',
    'INITIAL_UPDATE',
    'HISTORICAL_UPDATE',
    'TRANSACTIONS_REMOVED',
]);

function classify(body = {}) {
    const type = String(body.webhook_type || '').toUpperCase();
    const code = String(body.webhook_code || '').toUpperCase();
    const itemId = body.item_id || null;

    // An ERROR on the ITEM channel carries the real reason in error.error_code.
    if (type === 'ITEM' && code === 'ERROR') {
        const ec = String((body.error || {}).error_code || '').toUpperCase();
        if (NEEDS_HER.has(ec)) {
            return { action: 'hers', itemId, code: ec,
                why: 'the bank connection needs re-authenticating, which only she can do at her bank' };
        }
        return { action: 'ignore', itemId, code: ec || 'ERROR', why: 'an item error Jarvis cannot act on' };
    }
    if (NEEDS_HER.has(code)) {
        return { action: 'hers', itemId, code,
            why: 'the bank connection needs her at her bank\'s own site — no API can do this' };
    }
    if (type === 'TRANSACTIONS' && MEANS_SYNC.has(code)) {
        return { action: 'sync', itemId, code, why: 'new transactions are waiting' };
    }
    return { action: 'ignore', itemId, code: code || '(none)', why: `nothing in Jarvis acts on ${type}/${code}` };
}

// ── 403 OR 503, AND THE DIFFERENCE IS NOT COSMETIC ───────────────────────
// Plaid retries any non-200 for 24 hours with exponential backoff.
//
//   403  this did not come from Plaid. Stop. Retrying a forgery for a day
//        is free traffic for whoever sent it.
//   503  it may well have come from Plaid and WE could not check — the key
//        fetch failed, the network blinked. Come back, or one bad minute
//        permanently loses a disconnection notice.
//
// Out here rather than inside the route because the route cannot be driven
// through both branches in a test: verifying a signature needs a reachable
// Plaid, so under test every refusal looks like a key-fetch failure. The
// decision is the testable part, so the decision is what gets extracted —
// the third time today that logic buried in a route turned out to be logic
// nobody was checking.
function statusFor(why) {
    return /could not fetch|no way to fetch|returned no verification key/i.test(String(why || ''))
        ? 503 : 403;
}

module.exports = { verify, classify, readHeader, verifySignature, hashMatches, statusFor,
    MAX_AGE_SECONDS, NEEDS_HER, MEANS_SYNC };
