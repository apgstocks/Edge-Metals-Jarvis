// ── helpers/quickbooks/auth.js — the connection to QuickBooks Online ────────
// Apsara, 2026-09-21: "lets work on quickbook automation of api".
// Direction, her decision the same day: Jarvis -> QuickBooks, one way. Jarvis
// stays the record; QuickBooks is read only to find missed entries.
//
// ── TWO KEY SETS, ONE SWITCH ──────────────────────────────────────────────
// Every Intuit app has Development keys (reach only the free sandbox company)
// and Production keys (reach her REAL books). Both live in .env side by side,
// and QB_ENV picks one. Nothing is swapped by hand, so "which keys are these"
// is always answerable from one variable. Default is sandbox: an unset or
// misspelt QB_ENV must never mean her live company.
//
//   QB_ENV=sandbox | production
//   QB_SANDBOX_CLIENT_ID / QB_SANDBOX_CLIENT_SECRET
//   QB_PROD_CLIENT_ID    / QB_PROD_CLIENT_SECRET
//   QB_SANDBOX_REDIRECT_URI / QB_PROD_REDIRECT_URI (fallback QB_REDIRECT_URI);
//   each must be listed on the Intuit app for that key set
//
// ── TOKENS ────────────────────────────────────────────────────────────────
// Access token: 1 hour. Refresh token: rolling ~100 days, and Intuit may hand
// back a NEW one on any refresh, after which the old one is dead. So:
//   · every refresh result is written to disk before it is used
//   · refreshes are single-flight: two callers at once share ONE refresh,
//     because two parallel refreshes can leave the file holding the loser's
//     token and the connection silently dead on the next call.
// One token file per environment, under DATA_DIR (gitignored), so a sandbox
// connection can never be read as the production one.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('../../config');

const AUTH_URL  = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const SCOPE = 'com.intuit.quickbooks.accounting';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

function qbEnv() {
    return String(process.env.QB_ENV || '').trim().toLowerCase() === 'production' ? 'production' : 'sandbox';
}

function credentials(env = qbEnv()) {
    const p = env === 'production' ? 'QB_PROD_' : 'QB_SANDBOX_';
    const clientId = (process.env[p + 'CLIENT_ID'] || '').trim();
    const clientSecret = (process.env[p + 'CLIENT_SECRET'] || '').trim();
    // Per key set, because each Intuit key set has its own list of allowed
    // redirects: Production refuses localhost, and hers already lists Intuit's
    // OAuth Playground address. QB_REDIRECT_URI stays as the shared fallback.
    const redirectUri = (process.env[p + 'REDIRECT_URI'] || process.env.QB_REDIRECT_URI || '').trim();
    const missing = [];
    if (!clientId) missing.push(p + 'CLIENT_ID');
    if (!clientSecret) missing.push(p + 'CLIENT_SECRET');
    if (!redirectUri) missing.push(p + 'REDIRECT_URI');
    if (missing.length) throw new Error(`QuickBooks ${env}: missing in .env: ${missing.join(', ')}`);
    return { clientId, clientSecret, redirectUri, env };
}

function tokenFile(env = qbEnv()) {
    return process.env.QB_TOKEN_FILE || path.join(DATA_DIR, `quickbooks-token.${env}.json`);
}
function stateFile(env = qbEnv()) {
    return path.join(DATA_DIR, `quickbooks-oauth-state.${env}.json`);
}

function writeFileAtomic(file, obj) {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
}

function loadToken(env = qbEnv()) {
    try { return JSON.parse(fs.readFileSync(tokenFile(env), 'utf8')); } catch { return null; }
}

// Shapes Intuit's token response into what we keep. `now` is injectable so
// tests can pin time.
function toStored(resp, realmId, env, now = Date.now()) {
    if (!resp || !resp.access_token || !resp.refresh_token) {
        throw new Error('QuickBooks token response had no access_token/refresh_token');
    }
    return {
        env,
        realmId: String(realmId),
        access_token: resp.access_token,
        refresh_token: resp.refresh_token,
        access_expires_at: now + (Number(resp.expires_in) || 3600) * 1000,
        refresh_expires_at: now + (Number(resp.x_refresh_token_expires_in) || 0) * 1000,
        updated_at: new Date(now).toISOString(),
    };
}

// ── step 1: the URL she opens ─────────────────────────────────────────────
// `state` is random and saved, and the callback must return it. Without that
// check any code pasted in could connect Jarvis to someone else's company.
function buildAuthUrl(env = qbEnv()) {
    const { clientId, redirectUri } = credentials(env);
    const state = crypto.randomBytes(16).toString('hex');
    writeFileAtomic(stateFile(env), { state, created_at: new Date().toISOString() });
    const q = new URLSearchParams({ client_id: clientId, response_type: 'code', scope: SCOPE, redirect_uri: redirectUri, state });
    return `${AUTH_URL}?${q.toString()}`;
}

async function tokenRequest(form, env, fetchImpl) {
    const { clientId, clientSecret } = credentials(env);
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const r = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { Authorization: `Basic ${basic}`, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
    });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
    if (!r.ok) {
        const e = new Error(`QuickBooks token ${form.grant_type} failed (${r.status}): ${body.error || ''} ${body.error_description || body.raw || ''}`.trim());
        e.status = r.status; e.code = body.error;
        throw e;
    }
    return body;
}

// ── step 2: the URL her browser was sent back to ──────────────────────────
// Takes the whole redirected URL (easiest thing for her to copy) and pulls
// code, realmId and state out of it.
async function exchangeRedirect(redirectedUrl, { env = qbEnv(), fetchImpl = fetch } = {}) {
    const u = new URL(String(redirectedUrl).trim());
    const p = u.searchParams;
    if (p.get('error')) throw new Error(`QuickBooks refused the connection: ${p.get('error')}`);
    const code = p.get('code'), realmId = p.get('realmId'), state = p.get('state');
    if (!code || !realmId) throw new Error('That URL has no code/realmId in it — copy the full address bar after approving.');
    let saved = null; try { saved = JSON.parse(fs.readFileSync(stateFile(env), 'utf8')); } catch {}
    if (!saved || saved.state !== state) throw new Error('state does not match the URL this script generated — run --print-url again and use that link.');
    const { redirectUri } = credentials(env);
    const resp = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }, env, fetchImpl);
    const stored = toStored(resp, realmId, env);
    writeFileAtomic(tokenFile(env), stored);
    try { fs.unlinkSync(stateFile(env)); } catch {}
    return stored;
}

// ── step 3, forever after: a valid access token ───────────────────────────
const inflight = new Map(); // env -> Promise
async function getAccessToken({ env = qbEnv(), fetchImpl = fetch, force = false, now = Date.now } = {}) {
    const tok = loadToken(env);
    if (!tok) throw new Error(`QuickBooks ${env} is not connected — run: node scripts/qb-connect.js`);
    if (!force && tok.access_expires_at - REFRESH_MARGIN_MS > now()) return { accessToken: tok.access_token, realmId: tok.realmId };
    if (!inflight.has(env)) {
        const p = (async () => {
            const cur = loadToken(env); // re-read: another process may have refreshed
            const resp = await tokenRequest({ grant_type: 'refresh_token', refresh_token: cur.refresh_token }, env, fetchImpl);
            const stored = toStored(resp, cur.realmId, env, now());
            writeFileAtomic(tokenFile(env), stored);
            return stored;
        })().finally(() => inflight.delete(env));
        inflight.set(env, p);
    }
    const s = await inflight.get(env);
    return { accessToken: s.access_token, realmId: s.realmId };
}

async function disconnect({ env = qbEnv(), fetchImpl = fetch } = {}) {
    const tok = loadToken(env);
    if (!tok) return false;
    const { clientId, clientSecret } = credentials(env);
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    await fetchImpl(REVOKE_URL, {
        method: 'POST',
        headers: { Authorization: `Basic ${basic}`, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tok.refresh_token }),
    });
    fs.unlinkSync(tokenFile(env));
    return true;
}

function status(env = qbEnv(), now = Date.now()) {
    const t = loadToken(env);
    if (!t) return { env, connected: false };
    return {
        env, connected: true, realmId: t.realmId,
        refresh_days_left: Math.floor((t.refresh_expires_at - now) / 86400000),
        updated_at: t.updated_at,
    };
}

module.exports = { qbEnv, credentials, tokenFile, buildAuthUrl, exchangeRedirect, getAccessToken, disconnect, status, toStored, SCOPE };
