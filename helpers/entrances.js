// ── helpers/entrances.js — every address anyone might hold ────────────────
//
// Apsara, 2026-10-05, after a customer in the US lost an afternoon:
// "We never faced this when we have http. all these started when we had
// https. Find a permanent solution to fix this foreveer."
//
// ── SHE IS RIGHT ABOUT THE CAUSE ─────────────────────────────────────────
// Before 2026-09-01 there was ONE address, http://35.233.131.198:8080, and
// it worked. The HTTPS migration moved the front door to 443, port 8080 was
// closed, and nobody redirected the old address or told the people holding
// it. A customer typed the address they had been given and got
// ERR_CONNECTION_TIMED_OUT, on two devices and on both wifi and mobile data,
// while the server was perfectly healthy.
//
// HTTPS was not the fault. The fault was TWO ADDRESSES WHERE ONE SILENTLY
// DIED. Any migration that leaves an old entrance unredirected and unwatched
// does this, and it will do it again on the next one.
//
// ── SO WHAT MAKES IT PERMANENT ───────────────────────────────────────────
// Not discipline, and not a line in a document — HTTPS_SETUP.md said the
// right thing on line 63 and the wrong thing on line 5, and the wrong one
// won for five weeks. Three things, in order of how much they are worth:
//
//   1. Every entrance a person could hold is DECLARED here, with what it
//      must do. A list nobody maintains is useless, so it is also the thing
//      the nightly check reads — one list, used, not two kept in step.
//   2. Every dead entrance REDIRECTS rather than failing. api.js's
//      plain-HTTP middleware does 8080; Caddy does port 80.
//   3. Something NOTICES. That is the part that was missing: nothing in this
//      system has ever checked that its own public address answers. The
//      first thing to find out was a customer.
//
// ── WHAT THIS FILE WILL NOT DO ───────────────────────────────────────────
// It does not reach the network itself. `fetchImpl` is injected, so the
// nightly job on the VM supplies the real fetch and tests supply a stub.
// Nothing here has an opinion about how a request is made.

const KNOWN_IP = '35.233.131.198';
const CANONICAL = 'https://jarvis.edgemetals.com';

// ── the declaration ──────────────────────────────────────────────────────
// `expect` is one of:
//   serve     — must answer 2xx. This is the front door.
//   redirect  — must answer 3xx with a Location on the canonical host.
//   broken    — CANNOT work, with the reason. Declared so nobody spends an
//               afternoon rediscovering it, and so the check does not cry
//               about it every night.
const ENTRANCES = [
    {
        id: 'canonical',
        url: `${CANONICAL}/health`,
        expect: 'serve',
        why: 'The front door. Everything else exists to point here.',
        // If THIS fails, nobody can use Jarvis at all.
        severity: 'outage',
    },
    {
        id: 'plain-host',
        url: 'http://jarvis.edgemetals.com/health',
        expect: 'redirect',
        why: 'Someone typing the hostname without https. Caddy redirects port 80 itself.',
        severity: 'annoyance',
    },
    {
        id: 'legacy-8080',
        url: `http://${KNOWN_IP}:8080/health`,
        expect: 'redirect',
        why: 'THE ADDRESS THAT CAUSED 2026-10-05. The only address that existed before '
            + 'the HTTPS migration, still written in old bookmarks, old emails and old '
            + 'WhatsApp messages. api.js redirects it; GCP must have TCP 8080 open for a '
            + 'packet to arrive at all.',
        // Not an outage — the front door still works — but it is what a
        // person who has not been told the new address will hit.
        severity: 'old-link',
        needsFirewall: 'tcp:8080',
    },
    {
        id: 'bare-ip-https',
        url: `https://${KNOWN_IP}/health`,
        expect: 'broken',
        why: 'Cannot be made to work and is not worth trying. Let\'s Encrypt will not '
            + 'issue a certificate for a bare IP, so TLS fails before any redirect could '
            + 'be sent — a redirect needs a completed handshake. Anyone reaching for this '
            + 'should be given the hostname.',
        severity: 'declared-dead',
    },
];

// What the Android app posts to. Not a separate entrance — it is the
// canonical one — but worth asserting it has not drifted, because an APK
// pointing somewhere else needs a rebuild and redistribution to fix, which
// is days rather than minutes.
const APP_API_BASE = CANONICAL;

const ok2xx = (s) => s >= 200 && s < 300;
const ok3xx = (s) => s >= 300 && s < 400;

// A Location that lands on the canonical host over https. Checked as a
// PREFIX rather than an exact match so a path-preserving redirect passes —
// /health must arrive at /health, not at the dashboard root.
function redirectsToCanonical(location, requestedPath) {
    const loc = String(location || '');
    if (!loc.startsWith(CANONICAL)) return false;
    if (!requestedPath) return true;
    return loc.endsWith(requestedPath);
}

// ── check one ────────────────────────────────────────────────────────────
// Never throws. A checker that can throw turns one unreachable address into
// a failed nightly run, which is how the check itself becomes the outage.
async function checkOne(entrance, { fetchImpl, timeoutMs = 15000 } = {}) {
    const base = { id: entrance.id, url: entrance.url, expect: entrance.expect,
        severity: entrance.severity, why: entrance.why };

    if (entrance.expect === 'broken') {
        // Not attempted. There is nothing to learn and a TLS error every
        // night is noise that trains her to ignore this report.
        return { ...base, ok: true, skipped: true, detail: 'declared dead, not attempted' };
    }

    const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!f) return { ...base, ok: false, detail: 'no fetch available in this runtime' };

    const path = (() => { try { return new URL(entrance.url).pathname; } catch (e) { return null; } })();

    let res;
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
    try {
        res = await f(entrance.url, {
            method: 'GET',
            redirect: 'manual',          // the redirect IS the thing being checked
            ...(ac ? { signal: ac.signal } : {}),
        });
    } catch (e) {
        const msg = String((e && e.message) || e);
        return { ...base, ok: false,
            // The distinction that cost an afternoon. A timeout means nothing
            // answered — a closed port or a dropped packet — and is NOT the
            // same as a page that loaded wrong.
            detail: /abort|timeout|ETIMEDOUT/i.test(msg)
                ? `nothing answered within ${Math.round(timeoutMs / 1000)}s — the port is closed or the packet is dropped`
                : `could not connect: ${msg}` };
    } finally { if (timer) clearTimeout(timer); }

    const status = res.status;
    const location = (res.headers && typeof res.headers.get === 'function') ? res.headers.get('location') : null;

    if (entrance.expect === 'serve') {
        return ok2xx(status)
            ? { ...base, ok: true, status }
            : { ...base, ok: false, status, detail: `expected to serve, answered ${status}` };
    }

    // redirect
    if (!ok3xx(status)) {
        return { ...base, ok: false, status,
            detail: status && ok2xx(status)
                // Worse than a failure: it means the app is being served
                // where only a redirect should be.
                ? `answered ${status} — it is SERVING here, and this address is plain HTTP`
                : `expected a redirect, answered ${status}` };
    }
    if (!redirectsToCanonical(location, path)) {
        return { ...base, ok: false, status, location,
            detail: `redirects to ${location || '(no Location)'} — should be ${CANONICAL}${path || ''}` };
    }
    return { ...base, ok: true, status, location };
}

async function checkAll(opts = {}) {
    const results = [];
    for (const e of ENTRANCES) results.push(await checkOne(e, opts));
    const broken = results.filter((r) => !r.ok);
    return {
        at: new Date().toISOString(),
        canonical: CANONICAL,
        results,
        broken,
        // An outage and a stale bookmark need different urgency, so they are
        // counted apart rather than summed into "3 problems".
        outage: broken.some((r) => r.severity === 'outage'),
        oldLinksDead: broken.some((r) => r.severity === 'old-link'),
        ok: broken.length === 0,
    };
}

function report(res) {
    const L = [];
    if (res.ok) return 'Every address answers as it should.';
    for (const b of res.broken) {
        L.push(`${b.url}`);
        L.push(`  ${b.detail}`);
        L.push(`  why it matters: ${b.why}`);
        const e = ENTRANCES.find((x) => x.id === b.id);
        if (e && e.needsFirewall) {
            L.push(`  needs ${e.needsFirewall} open in the GCP firewall for a packet to arrive at all`);
        }
        L.push('');
    }
    L.push(`The address to give anyone who cannot get in: ${res.canonical}/health`);
    L.push('It answers {"status":"ok"} with no login, so it separates "cannot reach" from "cannot sign in".');
    return L.join('\n');
}

module.exports = { ENTRANCES, CANONICAL, KNOWN_IP, APP_API_BASE, checkOne, checkAll, report, redirectsToCanonical };
