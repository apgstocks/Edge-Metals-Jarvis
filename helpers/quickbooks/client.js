// ── helpers/quickbooks/client.js — one door to the QuickBooks API ───────────
// Every call goes through request(), so the base URL, the minor version, the
// token, and the retry-once-on-401 live in one place.
//
// A 401 mid-session means the access token died early (revoked, clock skew).
// One forced refresh and one retry; a second 401 is a real disconnection and
// is thrown, not looped on.

const auth = require('./auth');

const BASE = {
    sandbox: 'https://sandbox-quickbooks.api.intuit.com',
    production: 'https://quickbooks.api.intuit.com',
};
const MINOR_VERSION = '75';

// ── LIVE BOOKS ARE READ-ONLY UNTIL SHE SAYS OTHERWISE ──────────────────────
// Apsara types container bills into QuickBooks by hand today (2026-09-21), so
// the live company is connected first only to READ: her vendor/customer names
// for matching, and how she already enters a container, so pushes copy her
// pattern instead of inventing one. Any write to production is refused here
// until QB_PROD_WRITES=on is set deliberately, after sandbox has passed end to
// end and a cutover date is agreed. The one door for every call is the one
// place this can be enforced.
function assertWriteAllowed(env, method) {
    if (env !== 'production' || method === 'GET') return;
    if (String(process.env.QB_PROD_WRITES || '').trim().toLowerCase() === 'on') return;
    throw new Error(`Refused: ${method} to LIVE QuickBooks while QB_PROD_WRITES is not "on". Production is read-only until cutover.`);
}

async function request(method, pathAndQuery, body, { env = auth.qbEnv(), fetchImpl = fetch } = {}) {
    method = String(method).toUpperCase();
    if (method === 'GET') return send(method, pathAndQuery, body, { env, fetchImpl });
    try { assertWriteAllowed(env, method); }
    catch (e) {   // refused attempts are part of "everything" too
        try { require('./journal').recordWrite({ env, phase: 'refused', method, path: pathAndQuery, error: e.message }); } catch { /* the refusal stands either way */ }
        throw e;
    }
    // Every write is journalled — intent first, and no intent line, no write.
    // Required lazily: journal.js itself uses this client for its reads.
    const journal = require('./journal');
    const intent = journal.recordWrite({ env, phase: 'intent', method, path: pathAndQuery, body });
    try {
        const data = await send(method, pathAndQuery, body, { env, fetchImpl });
        const obj = data && Object.values(data).find((v) => v && typeof v === 'object' && v.Id);
        journal.recordWrite({ env, phase: 'done', method, path: pathAndQuery, writeId: intent.id,
            result: obj ? { type: Object.keys(data).find((k) => data[k] === obj), Id: obj.Id, SyncToken: obj.SyncToken, TotalAmt: obj.TotalAmt, status: obj.status } : null });
        return data;
    } catch (e) {
        journal.recordWrite({ env, phase: 'failed', method, path: pathAndQuery, writeId: intent.id, error: e.message });
        throw e;
    }
}

async function send(method, pathAndQuery, body, { env, fetchImpl }) {
    for (let attempt = 0; attempt < 2; attempt++) {
        const { accessToken, realmId } = await auth.getAccessToken({ env, fetchImpl, force: attempt > 0 });
        const sep = pathAndQuery.includes('?') ? '&' : '?';
        const url = `${BASE[env]}/v3/company/${realmId}${pathAndQuery}${sep}minorversion=${MINOR_VERSION}`;
        const r = await fetchImpl(url, {
            method,
            headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
        if (r.status === 401 && attempt === 0) continue;
        const text = await r.text();
        let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
        if (!r.ok) {
            const f = data && data.Fault && data.Fault.Error && data.Fault.Error[0];
            const e = new Error(`QuickBooks ${method} ${pathAndQuery} failed (${r.status}): ${f ? `${f.Message} — ${f.Detail || ''}` : (data.raw || '').slice(0, 300)}`);
            e.status = r.status; e.fault = data.Fault; e.intuitTid = r.headers && r.headers.get ? r.headers.get('intuit_tid') : undefined;
            throw e;
        }
        return data;
    }
}

async function companyInfo(opts) {
    const { realmId } = await auth.getAccessToken(opts || {});
    const d = await request('GET', `/companyinfo/${realmId}`, null, opts);
    return d.CompanyInfo;
}

// Read-only query, e.g. query("select * from Vendor maxresults 1000")
async function query(sql, opts) {
    const d = await request('GET', `/query?query=${encodeURIComponent(sql)}`, null, opts);
    return d.QueryResponse || {};
}

module.exports = { request, companyInfo, query, assertWriteAllowed, BASE, MINOR_VERSION };
