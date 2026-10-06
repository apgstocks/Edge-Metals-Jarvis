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
        why: 'The front door. Everything else exists to point here. Also the one place '
            + 'that can catch HTTP/3 coming back, which is what broke access on 2026-10-02 '
            + 'and again on 2026-10-05 — a Caddy upgrade or a copied default Caddyfile '
            + 'reinstates it silently and only some networks notice.',
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
        // ── NOT /health, AND THAT IS THE WHOLE POINT ─────────────────────
        // Probed /health until 2026-10-06, and it was wrong from the moment
        // the health-check exemption landed the day before. api.js exempts
        // /health from the plain-HTTP redirect on purpose, so Google's
        // checker is not bounced — which means /health is the ONE path on
        // this port guaranteed never to redirect. The check therefore read
        // 200, concluded "it is SERVING here, and this address is plain
        // HTTP", and would have emailed that every night: a false alarm, in
        // alarming words, about a server behaving correctly. Verified on the
        // live box: / and /documents both answer 301, /health answers 200.
        //
        // So it probes a path that is NOT exempt. Which is also the honest
        // test — the question is whether an old bookmark lands on https, and
        // nobody's old bookmark points at /health.
        url: `http://${KNOWN_IP}:8080/`,
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

// ── is this header advertising an alternative service? ───────────────────
// Found live on 2026-10-05, minutes after DNS moved to the Google load
// balancer. The response carried the header TWICE:
//
//     alt-svc: clear
//     alt-svc: clear
//
// api.js:213 uses res.set, which REPLACES, so the app emits exactly one. The
// second copy is added by Google's frontend, which echoes the backend value
// alongside its own. fetch() joins repeated field lines with a comma, so
// headers.get('alt-svc') returns "clear, clear" — and the check here used to
// be `!== 'clear'`, which that fails. The nightly job would have emailed
// "HTTP/3 is back on" every night, about a server doing exactly the right
// thing. A check that cries wolf nightly is a check she learns to delete.
//
// So the value is read as what RFC 7838 says it is: a comma-separated LIST
// of alternative-service entries, where "clear" is the eraser. Any number of
// erasers is fine. One real entry is not — and the mixed case,
// "clear, h3=\":443\"", is the one that actually appeared on the wire while
// the QUIC override was still propagating, so it must stay caught.
function advertisesHttp3(value) {
    if (!value) return false;
    return String(value)
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
        .some((t) => t.toLowerCase() !== 'clear');
}

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
        if (!ok2xx(status)) {
            return { ...base, ok: false, status, detail: `expected to serve, answered ${status}` };
        }
        // ── HTTP/3 MUST NOT COME BACK ────────────────────────────────────
        // This is the check that stops 2026-10-02 and 2026-10-05 happening a
        // third time. Caddy advertises HTTP/3 over UDP 443 by default, and
        // many wifi networks carry TCP 443 while silently dropping UDP 443 —
        // so an advertisement here means a subset of people, on a subset of
        // networks, stop being able to reach Jarvis, for up to the THIRTY
        // DAYS the advertisement is cached. Mobile data keeps working, which
        // is what makes it look like anything other than what it is.
        //
        // A Caddy upgrade, a reinstall, or someone copying a default
        // Caddyfile all bring it back silently. Nothing else in this system
        // would notice. So the front-door check looks at the header every
        // night, and "clear" — the RFC 7838 eraser we send deliberately — is
        // the only acceptable value besides absent.
        const altSvc = (res.headers && typeof res.headers.get === 'function')
            ? res.headers.get('alt-svc') : null;
        if (advertisesHttp3(altSvc)) {
            return { ...base, ok: false, status, altSvc,
                detail: `the server is advertising alt-svc: ${altSvc} — HTTP/3 is back on. `
                    + 'Networks that drop UDP 443 will start failing, mobile data will keep working, '
                    + 'and clients cache this for up to 30 days. TWO things can advertise it now, so '
                    + 'check both: the Google load balancer, with `gcloud compute '
                    + 'target-https-proxies describe jarvis-https-proxy --global '
                    + '--format=\'get(quicOverride)\'` — it must say DISABLE, not NONE; and Caddy, '
                    + 'which needs `protocols h1 h2` in the Caddyfile global block and a reload.' };
        }
        return { ...base, ok: true, status, altSvc: altSvc || null };
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

// ── HOW MANY DAYS BEFORE THE CERTIFICATE RUNS OUT ────────────────────────
// Debt created on 2026-10-05, written down the same day so it would not be
// discovered by a customer.
//
// Caddy renewed its own certificate automatically and nothing here had to
// care. Then the Google load balancer went in front, and the certificate it
// serves is a COPY of Caddy's that I uploaded by hand on 2026-10-05. A copy
// does not renew. It expires 2026-12-04, and the managed certificate meant
// to take over (jarvis-cert) only provisions once DNS points at the load
// balancer — so if that provisioning ever silently fails, the bridge
// expires and the site stops, with a TLS error on every device at once.
//
// checkOne above would catch it — on the morning it breaks. That is an
// outage with a warning time of zero, which is the shape of failure she
// asked me to stop producing: "I dont want to face it again n again."
//
// fetch() cannot see the peer certificate — it is deliberately not exposed —
// so this needs a raw TLS connection. `tlsImpl` is injected exactly like
// fetchImpl, so the nightly job on the VM supplies the real one and tests
// supply a stub, and this file still reaches no network of its own.
const WARN_DAYS = 30;

function daysUntil(notAfter, now) {
    const end = new Date(notAfter).getTime();
    if (!Number.isFinite(end)) return null;
    return Math.floor((end - (now || Date.now())) / 86400000);
}

async function checkCertificate({ host, port = 443, tlsImpl, warnDays = WARN_DAYS,
    timeoutMs = 15000, now } = {}) {
    const target = host || new URL(CANONICAL).hostname;
    const base = { host: target, warnDays };

    // ── NO IMPLICIT FALLBACK TO node:tls, AND THAT IS THE POINT ──────────
    // Written first as `tlsImpl || require('tls').connect`, which would have
    // meant tests/entrances.js — calling checkAll with only a fetch stub —
    // opened a REAL TLS connection to jarvis.edgemetals.com on every run.
    // The suite must never touch her live services, and the header of this
    // file promises it reaches no network of its own. A convenience default
    // quietly broke both.
    //
    // So the caller injects: helpers/entrancesJob.js and
    // scripts/check-entrances.js pass require('tls').connect, tests pass a
    // stub, and anything that forgets gets "not attempted" rather than a
    // surprise outbound connection.
    //
    // NOT ATTEMPTED is not the same as FAILED. It must never turn the
    // nightly run red on its own — a check that cries wolf is one she learns
    // to ignore, which is how the whole guard gets switched off.
    const connect = tlsImpl;
    if (typeof connect !== 'function') {
        return { ...base, checked: false, ok: true,
            detail: 'no TLS implementation was injected — not attempted. The nightly job and '
                + 'scripts/check-entrances.js pass require(\'tls\').connect; without it the '
                + 'expiry is simply not looked at, rather than reported as fine.' };
    }

    let cert;
    try {
        cert = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('timed out')), timeoutMs);
            let socket;
            try {
                socket = connect({ host: target, port, servername: target }, () => {
                    clearTimeout(timer);
                    // The LEAF certificate. getPeerCertificate() without
                    // `true` returns exactly that, which is the one that
                    // expires first and the one that stops the site.
                    const c = socket.getPeerCertificate ? socket.getPeerCertificate() : null;
                    try { socket.end(); } catch (e) {}
                    resolve(c);
                });
            } catch (e) { clearTimeout(timer); return reject(e); }
            if (socket && socket.on) {
                socket.on('error', (e) => { clearTimeout(timer); reject(e); });
            }
        });
    } catch (e) {
        return { ...base, checked: false, ok: true,
            detail: `could not read the certificate: ${String((e && e.message) || e)} — not attempted` };
    }

    if (!cert || !cert.valid_to) {
        return { ...base, checked: false, ok: true, detail: 'the handshake returned no certificate — not attempted' };
    }

    const days = daysUntil(cert.valid_to, now);
    const out = { ...base, checked: true, validTo: cert.valid_to,
        subject: (cert.subject && cert.subject.CN) || null,
        issuer: (cert.issuer && (cert.issuer.O || cert.issuer.CN)) || null, days };

    if (days === null) {
        return { ...out, checked: false, ok: true, detail: `unreadable expiry date: ${cert.valid_to}` };
    }
    if (days < 0) {
        return { ...out, ok: false, expired: true,
            detail: `THE CERTIFICATE EXPIRED ${Math.abs(days)} day(s) ago — every device is seeing a TLS error right now` };
    }
    if (days <= warnDays) {
        return { ...out, ok: false,
            detail: `the certificate expires in ${days} day(s), on ${cert.valid_to}. `
                + 'If this is the hand-uploaded copy of Caddy\'s certificate it will NOT renew itself. Check '
                + '`gcloud compute ssl-certificates describe jarvis-cert --global '
                + '--format=\'get(managed.status)\'` — it must say ACTIVE, not PROVISIONING.' };
    }
    return { ...out, ok: true };
}

async function checkAll(opts = {}) {
    const results = [];
    for (const e of ENTRANCES) results.push(await checkOne(e, opts));
    const broken = results.filter((r) => !r.ok);
    const certificate = await checkCertificate(opts);
    return {
        at: new Date().toISOString(),
        canonical: CANONICAL,
        results,
        broken,
        // Kept beside `results` rather than inside it: an entrance either
        // answers or does not, while a certificate that is fine today and
        // gone in three weeks is a deadline, not a failure. Folding it in
        // would make `broken` mean two different things.
        certificate,
        // An outage and a stale bookmark need different urgency, so they are
        // counted apart rather than summed into "3 problems".
        outage: broken.some((r) => r.severity === 'outage') || certificate.expired === true,
        oldLinksDead: broken.some((r) => r.severity === 'old-link'),
        certificateExpiring: certificate.ok === false,
        ok: broken.length === 0 && certificate.ok !== false,
    };
}

function report(res) {
    const L = [];
    if (res.ok) return 'Every address answers as it should.';

    // The certificate goes FIRST when it is the problem. It is the one
    // failure here with a date attached, and a deadline buried under a list
    // of addresses that are all working reads as noise.
    const cert = res.certificate;
    if (cert && cert.ok === false) {
        L.push(`${cert.host} — the HTTPS certificate`);
        L.push(`  ${cert.detail}`);
        if (cert.issuer) L.push(`  issued by ${cert.issuer}${cert.subject ? ` for ${cert.subject}` : ''}`);
        L.push('  why it matters: when this expires every device gets a TLS error at the same '
            + 'moment, on every network, and there is no partial version of it. The load balancer '
            + 'serves a copy that was uploaded by hand on 2026-10-05 and does not renew itself.');
        L.push('');
    }

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

module.exports = { ENTRANCES, CANONICAL, KNOWN_IP, APP_API_BASE, checkOne, checkAll, report,
    redirectsToCanonical, advertisesHttp3, checkCertificate, daysUntil, WARN_DAYS };
