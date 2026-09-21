// ── tests/quickbooks-auth.js ───────────────────────────────────────────────
// Guards the QuickBooks connection (helpers/quickbooks/auth.js, client.js),
// in order of how badly each failure hurts:
//   1. an unset or misspelt QB_ENV reaching her LIVE books
//   2. a pasted URL from somewhere else connecting Jarvis to another company
//      (state check)
//   3. a rotated refresh token not written down, so the connection dies
//      silently some hours later
//   4. two callers refreshing at once and one of them winning with a dead token
//   5. sandbox and production tokens sharing a file
// No network: fetch is a fake that records what was asked.

const path = require('path');
const fs = require('fs');
const os = require('os');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-auth-'));
process.env.DATA_DIR = TMP;
delete process.env.QB_TOKEN_FILE;
process.env.QB_SANDBOX_CLIENT_ID = 'sbx-id';
process.env.QB_SANDBOX_CLIENT_SECRET = 'sbx-secret';
process.env.QB_PROD_CLIENT_ID = 'prod-id';
process.env.QB_PROD_CLIENT_SECRET = 'prod-secret';
process.env.QB_REDIRECT_URI = 'http://localhost:8765/qb/callback';

const auth = require('../helpers/quickbooks/auth');
const client = require('../helpers/quickbooks/client');

function fakeFetch(handler) {
    const calls = [];
    const f = async (url, opts) => {
        calls.push({ url, opts });
        const { status = 200, body = {} } = await handler(url, opts, calls.length);
        return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), headers: { get: () => null } };
    };
    f.calls = calls;
    return f;
}
const tokenResp = (n) => ({ access_token: 'acc' + n, refresh_token: 'ref' + n, expires_in: 3600, x_refresh_token_expires_in: 8726400 });

(async () => {
    console.log('\n── environment defaults ──');
    delete process.env.QB_ENV;
    ck('unset QB_ENV is sandbox', auth.qbEnv() === 'sandbox');
    process.env.QB_ENV = 'prod';
    ck('misspelt QB_ENV ("prod") is sandbox, not live', auth.qbEnv() === 'sandbox');
    process.env.QB_ENV = ' Production ';
    ck('"Production" with spaces is production', auth.qbEnv() === 'production');
    delete process.env.QB_ENV;
    ck('sandbox and production token files differ', auth.tokenFile('sandbox') !== auth.tokenFile('production'));
    ck('token files live under DATA_DIR', auth.tokenFile('sandbox').startsWith(TMP));
    const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
    ck('.env and data/ are gitignored', /^\.env$/m.test(gi) && /^data\/$/m.test(gi));

    console.log('\n── credentials ──');
    const saved = process.env.QB_SANDBOX_CLIENT_SECRET; delete process.env.QB_SANDBOX_CLIENT_SECRET;
    let msg = ''; try { auth.credentials('sandbox'); } catch (e) { msg = e.message; }
    ck('missing secret names the variable', msg.includes('QB_SANDBOX_CLIENT_SECRET'), msg);
    ck('error does not print the other secret', !msg.includes('prod-secret') && !msg.includes('sbx-id'));
    process.env.QB_SANDBOX_CLIENT_SECRET = saved;

    console.log('\n── redirect per key set ──');
    process.env.QB_PROD_REDIRECT_URI = 'https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl';
    ck('production uses its own redirect', auth.credentials('production').redirectUri === process.env.QB_PROD_REDIRECT_URI);
    ck('sandbox falls back to QB_REDIRECT_URI', auth.credentials('sandbox').redirectUri === 'http://localhost:8765/qb/callback');
    const prodUrl = new URL(auth.buildAuthUrl('production'));
    ck('production auth URL carries the Playground redirect + prod id', prodUrl.searchParams.get('redirect_uri') === process.env.QB_PROD_REDIRECT_URI && prodUrl.searchParams.get('client_id') === 'prod-id');
    ck('production state saved separately from sandbox', fs.existsSync(path.join(TMP, 'quickbooks-oauth-state.production.json')));

    console.log('\n── auth URL + state ──');
    const url = new URL(auth.buildAuthUrl('sandbox'));
    ck('auth URL asks for accounting scope only', url.searchParams.get('scope') === 'com.intuit.quickbooks.accounting');
    ck('auth URL uses sandbox client id', url.searchParams.get('client_id') === 'sbx-id');
    const state = url.searchParams.get('state');
    ck('state is random 32 hex', /^[0-9a-f]{32}$/.test(state));

    const f0 = fakeFetch(() => ({ body: tokenResp(1) }));
    let err = ''; try { await auth.exchangeRedirect(`http://localhost:8765/qb/callback?code=C&realmId=R1&state=WRONG`, { env: 'sandbox', fetchImpl: f0 }); } catch (e) { err = e.message; }
    ck('wrong state is refused', /state does not match/.test(err), err);
    ck('no token request made on wrong state', f0.calls.length === 0);

    err = ''; try { await auth.exchangeRedirect(`http://localhost:8765/qb/callback?error=access_denied&state=${state}`, { env: 'sandbox', fetchImpl: f0 }); } catch (e) { err = e.message; }
    ck('user clicking Cancel gives a plain message', /refused the connection: access_denied/.test(err), err);

    console.log('\n── code exchange ──');
    const f1 = fakeFetch(() => ({ body: tokenResp(1) }));
    const t1 = await auth.exchangeRedirect(`http://localhost:8765/qb/callback?code=CODE1&realmId=9130&state=${state}`, { env: 'sandbox', fetchImpl: f1 });
    ck('exchange posts to token endpoint once', f1.calls.length === 1 && /tokens\/bearer/.test(f1.calls[0].url));
    ck('exchange uses Basic auth of sandbox keys', f1.calls[0].opts.headers.Authorization === 'Basic ' + Buffer.from('sbx-id:sbx-secret').toString('base64'));
    ck('exchange sends the code and redirect', /code=CODE1/.test(f1.calls[0].opts.body) && /redirect_uri=http%3A%2F%2Flocalhost/.test(f1.calls[0].opts.body));
    ck('realmId stored', t1.realmId === '9130');
    const mode = fs.statSync(auth.tokenFile('sandbox')).mode & 0o777;
    ck('token file is owner-only (600)', mode === 0o600, mode.toString(8));
    err = ''; try { await auth.exchangeRedirect(`http://localhost:8765/qb/callback?code=CODE1&realmId=9130&state=${state}`, { env: 'sandbox', fetchImpl: f1 }); } catch (e) { err = e.message; }
    ck('the same state cannot be replayed', /state does not match/.test(err), err);
    ck('production is still not connected', auth.status('production').connected === false);

    console.log('\n── refresh ──');
    const f2 = fakeFetch(() => ({ body: tokenResp(2) }));
    const fresh = await auth.getAccessToken({ env: 'sandbox', fetchImpl: f2 });
    ck('fresh token used without a network call', fresh.accessToken === 'acc1' && f2.calls.length === 0);

    const later = () => Date.now() + 2 * 3600 * 1000;
    const r2 = await auth.getAccessToken({ env: 'sandbox', fetchImpl: f2, now: later });
    ck('expired token refreshes', r2.accessToken === 'acc2' && f2.calls.length === 1);
    ck('refresh sends the OLD refresh token', /refresh_token=ref1/.test(f2.calls[0].opts.body));
    const onDisk = JSON.parse(fs.readFileSync(auth.tokenFile('sandbox'), 'utf8'));
    ck('rotated refresh token written to disk', onDisk.refresh_token === 'ref2');
    ck('realmId kept across refresh', onDisk.realmId === '9130');

    console.log('\n── concurrent refresh ──');
    let n = 2;
    const f3 = fakeFetch(async () => { await new Promise((r) => setTimeout(r, 30)); n++; return { body: tokenResp(n) }; });
    const muchLater = () => Date.now() + 5 * 3600 * 1000;
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => auth.getAccessToken({ env: 'sandbox', fetchImpl: f3, now: muchLater })));
    ck('three callers, ONE refresh', f3.calls.length === 1, 'calls=' + f3.calls.length);
    ck('all three got the same new token', a.accessToken === 'acc3' && b.accessToken === 'acc3' && c.accessToken === 'acc3');

    console.log('\n── refresh failure ──');
    const f4 = fakeFetch(() => ({ status: 400, body: { error: 'invalid_grant' } }));
    err = ''; try { await auth.getAccessToken({ env: 'sandbox', fetchImpl: f4, force: true }); } catch (e) { err = e.message; }
    ck('invalid_grant surfaces, not swallowed', /invalid_grant/.test(err), err);
    ck('failed refresh leaves the saved token alone', JSON.parse(fs.readFileSync(auth.tokenFile('sandbox'), 'utf8')).refresh_token === 'ref3');

    console.log('\n── client ──');
    const f5 = fakeFetch((u, o, i) => {
        if (/tokens\/bearer/.test(u)) return { body: tokenResp(9) };
        if (i === 1) return { status: 401, body: {} };
        return { body: { CompanyInfo: { CompanyName: 'Sandbox Co' } } };
    });
    const ci = await client.companyInfo({ env: 'sandbox', fetchImpl: f5 });
    ck('401 -> one forced refresh -> retry succeeds', ci.CompanyName === 'Sandbox Co');
    const apiCalls = f5.calls.filter((c) => !/tokens\/bearer/.test(c.url));
    ck('sandbox base URL used', apiCalls.every((c) => c.url.startsWith('https://sandbox-quickbooks.api.intuit.com/v3/company/9130/')));
    ck('minorversion on every call', apiCalls.every((c) => /minorversion=75/.test(c.url)));

    const f6 = fakeFetch((u) => (/tokens\/bearer/.test(u) ? { body: tokenResp(10) } : { status: 401, body: {} }));
    err = ''; try { await client.query('select * from Vendor', { env: 'sandbox', fetchImpl: f6 }); } catch (e) { err = e.message; }
    ck('second 401 throws, does not loop', /401/.test(err) && f6.calls.filter((c) => !/tokens\/bearer/.test(c.url)).length === 2, err);

    const f7 = fakeFetch((u) => (/tokens\/bearer/.test(u) ? { body: tokenResp(11) } : { status: 400, body: { Fault: { Error: [{ Message: 'Duplicate Name Exists Error', Detail: 'The name supplied already exists.' }] } } }));
    err = ''; try { await client.request('POST', '/vendor', { DisplayName: 'x' }, { env: 'sandbox', fetchImpl: f7 }); } catch (e) { err = e.message; }
    ck('Intuit Fault message is readable', /Duplicate Name Exists Error/.test(err), err);

    console.log('\n── live books read-only ──');
    delete process.env.QB_PROD_WRITES;
    fs.writeFileSync(auth.tokenFile('production'), JSON.stringify(auth.toStored(tokenResp(20), '555', 'production')));
    const f8 = fakeFetch(() => ({ body: { Vendor: { Id: '1' }, QueryResponse: { Vendor: [] } } }));
    for (const m of ['POST', 'post', 'DELETE', 'PUT']) {
        err = ''; try { await client.request(m, '/bill', { x: 1 }, { env: 'production', fetchImpl: f8 }); } catch (e) { err = e.message; }
        ck(`production ${m} refused without QB_PROD_WRITES=on`, /Refused/.test(err), err);
    }
    ck('refused writes never reached the network', f8.calls.length === 0);
    process.env.QB_PROD_WRITES = 'yes';
    err = ''; try { await client.request('POST', '/bill', {}, { env: 'production', fetchImpl: f8 }); } catch (e) { err = e.message; }
    ck('only the exact word "on" unlocks (not "yes")', /Refused/.test(err));
    delete process.env.QB_PROD_WRITES;
    await client.query('select * from Vendor', { env: 'production', fetchImpl: f8 });
    ck('production reads allowed', f8.calls.length === 1 && f8.calls[0].url.startsWith('https://quickbooks.api.intuit.com/v3/company/555/'));
    await client.request('POST', '/bill', {}, { env: 'sandbox', fetchImpl: f8 });
    ck('sandbox writes allowed', f8.calls.length === 2 && f8.calls[1].url.startsWith('https://sandbox-quickbooks'));
    process.env.QB_PROD_WRITES = 'on';
    await client.request('POST', '/bill', {}, { env: 'production', fetchImpl: f8 });
    ck('QB_PROD_WRITES=on unlocks production', f8.calls.length === 3);
    delete process.env.QB_PROD_WRITES;

    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(`\nquickbooks-auth: ${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
