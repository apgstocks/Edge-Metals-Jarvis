// ── tests/entrances.js ────────────────────────────────────────────────────
// Apsara, 2026-10-05: "We never faced this when we have http. all these
// started when we had https. Find a permanent solution to fix this foreveer."
//
// She is right about the cause. Before 2026-09-01 there was ONE address and
// it worked. The HTTPS migration moved the front door to 443, port 8080 was
// closed, and nobody redirected the old address or told the people holding
// it. A customer typed what they had been given and got
// ERR_CONNECTION_TIMED_OUT on two devices and on both wifi and mobile data,
// while every inward-looking watcher in this system reported green.
//
// HTTPS was not the fault. Two addresses where one silently died was.
//
// The permanent part is not this file and not a document — HTTPS_SETUP.md
// said the right thing on line 63 and the wrong thing on line 5, and the
// wrong one won for five weeks. It is that something NOTICES. These checks
// are about the three ways a noticer is worthless: it never fires, it fires
// every night until ignored, or it cannot tell an outage from a stale
// bookmark.
//
// NOTHING HERE TOUCHES THE NETWORK. fetchImpl is injected everywhere.

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-entrances-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated');
    process.exit(1);
}
const E = require(path.join(ROOT, 'helpers/entrances'));
const J = require(path.join(ROOT, 'helpers/entrancesJob'));

// ── a fake internet ───────────────────────────────────────────────────────
const resp = (status, location) => ({ status,
    headers: { get: (k) => (String(k).toLowerCase() === 'location' ? (location || null) : null) } });
const TIMEOUT = () => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e; };

// Everything healthy: front door serves, the two old addresses redirect.
function healthy() {
    return async (url) => {
        const u = String(url);
        if (u === 'https://jarvis.edgemetals.com/health') return resp(200);
        if (u === 'http://jarvis.edgemetals.com/health') return resp(308, 'https://jarvis.edgemetals.com/health');
        if (u === 'http://35.233.131.198:8080/') return resp(301, 'https://jarvis.edgemetals.com/');
        throw new Error('unexpected ' + u);
    };
}
const calls = [];
const recording = (inner) => async (url, opts) => { calls.push(String(url)); return inner(url, opts); };

(async () => {

// ── A — THE DECLARATION IS THE POINT ──────────────────────────────────────
{
    section('A — every address a person could be holding is written down');

    const ids = E.ENTRANCES.map((e) => e.id);
    ck('the front door is declared', ids.includes('canonical'));

    // ── NO ENTRANCE MAY PROBE A PATH EXEMPT FROM ITS OWN RULE ────────────
    // Found live on 2026-10-06. api.js exempts /health from the plain-HTTP
    // redirect so Google's health checker is not bounced — so /health is the
    // one path on port 8080 that can never redirect. legacy-8080 probed
    // exactly that and expected a redirect, which meant the nightly job
    // would have emailed "it is SERVING here, and this address is plain
    // HTTP" every single night about a correctly behaving server. Verified
    // against the live box: / answers 301, /health answers 200.
    //
    // A check that cries wolf nightly gets switched off, taking the real
    // guard with it. So the rule is now enforced rather than remembered.
    for (const e of E.ENTRANCES.filter((x) => x.expect === 'redirect')) {
        const p = new URL(e.url).pathname;
        const exempt = /^\/health/.test(p);
        // Only the bare-IP port is affected: Caddy redirects port 80 for
        // every path, so the hostname entrance may still use /health.
        const onTheExemptPort = e.url.includes(':8080');
        ck(`${e.id} does not probe a path exempt from the redirect it checks`,
           !(exempt && onTheExemptPort), `${e.url} — /health never redirects on 8080, by design`);
    }
    ck('  the pre-HTTPS address is declared — the one that caused this',
       ids.includes('legacy-8080'), JSON.stringify(ids));
    ck('  the hostname without https is declared', ids.includes('plain-host'));
    ck('  and the bare IP over https is declared DEAD rather than omitted',
       (E.ENTRANCES.find((e) => e.id === 'bare-ip-https') || {}).expect === 'broken',
       'omitting it means someone rediscovers it; declaring it means they do not');

    // Every entry must carry a reason, or the list rots into URLs nobody
    // dares delete.
    ck('every entrance says why it matters',
       E.ENTRANCES.every((e) => typeof e.why === 'string' && e.why.length > 30),
       JSON.stringify(E.ENTRANCES.filter((e) => !e.why || e.why.length <= 30).map((e) => e.id)));
    ck('  and carries a severity, so an outage is not filed beside a stale link',
       E.ENTRANCES.every((e) => !!e.severity));

    // The APK's base URL has to be the canonical one. A drifted APK needs a
    // rebuild and redistribution, which is days, not minutes.
    ck('the app posts to the canonical address', E.APP_API_BASE === E.CANONICAL, E.APP_API_BASE);
    const appCfg = fs.readFileSync(path.join(ROOT, 'mobile-app/www/config.js'), 'utf8');
    ck('  and the shipped app config really contains it',
       appCfg.includes('jarvis.edgemetals.com'), 'mobile-app/www/config.js');
}

// ── B — WHEN EVERYTHING IS FINE IT SAYS NOTHING ───────────────────────────
{
    section('B — silent when every address behaves');

    calls.length = 0;
    const res = await E.checkAll({ fetchImpl: recording(healthy()) });
    ck('it reports ok', res.ok === true, JSON.stringify(res.broken));
    ck('  with no outage and no dead old links',
       res.outage === false && res.oldLinksDead === false, JSON.stringify(res));

    // The declared-dead address must NOT be attempted. A TLS error every
    // night is the noise that trains her to ignore the report.
    ck('the address declared dead is never requested',
       !calls.some((u) => u === 'https://35.233.131.198/health'), JSON.stringify(calls));
    ck('  but it is still reported, as skipped rather than failing',
       res.results.find((r) => r.id === 'bare-ip-https').skipped === true
       && res.results.find((r) => r.id === 'bare-ip-https').ok === true,
       JSON.stringify(res.results.find((r) => r.id === 'bare-ip-https')));

    const sent = [];
    const r = await J.run({ fetchImpl: healthy(), sendEmail: async (m) => sent.push(m), to: 'x@y.com' });
    ck('and nothing is emailed', sent.length === 0 && r.sent === false, JSON.stringify(sent.map((m) => m.subject)));
}

// ── C — THE FAILURE THAT ACTUALLY HAPPENED ────────────────────────────────
{
    section('C — 2026-10-05, reproduced');

    // Front door fine; port 8080 times out because the firewall drops it.
    const asItWas = async (url) => {
        const u = String(url);
        if (u === 'https://jarvis.edgemetals.com/health') return resp(200);
        if (u === 'http://jarvis.edgemetals.com/health') return resp(308, 'https://jarvis.edgemetals.com/health');
        if (u === 'http://35.233.131.198:8080/') return TIMEOUT();
        throw new Error('unexpected ' + u);
    };
    const res = await E.checkAll({ fetchImpl: asItWas });

    ck('it is caught', res.ok === false, JSON.stringify(res.broken.map((b) => b.id)));
    ck('  and it is NOT called an outage — the front door still works',
       res.outage === false && res.oldLinksDead === true, JSON.stringify({ o: res.outage, l: res.oldLinksDead }));

    const b = res.broken.find((x) => x.id === 'legacy-8080');
    // THE SENTENCE THAT COST THE AFTERNOON. A timeout means nothing
    // answered; it is not a page loading wrong, and saying so is the
    // difference between checking the firewall and clearing a cache.
    ck('  it says nothing answered, not that something answered wrongly',
       /nothing answered/.test(b.detail) && /port is closed or the packet is dropped/.test(b.detail), b.detail);
    ck('  and names the firewall rule a packet needs to arrive at all',
       /tcp:8080/.test(E.report(res)), E.report(res).slice(0, 400));

    const out = E.report(res);
    ck('the report hands over the address to give people',
       out.includes('https://jarvis.edgemetals.com/health'), out.slice(-300));
    ck('  and explains what that URL distinguishes',
       /cannot reach.*cannot sign in/i.test(out), out.slice(-300));

    const sent = [];
    const r = await J.run({ fetchImpl: asItWas, sendEmail: async (m) => sent.push(m), to: 'x@y.com' });
    ck('it emails', sent.length === 1 && r.sent === true, JSON.stringify(sent.map((m) => m.subject)));
    ck('  with a subject about old links, not a general alarm',
       /old address is dead/.test(sent[0].subject), sent[0].subject);
}

// ── C2 — HTTP/3 COMING BACK IS CAUGHT ─────────────────────────────────────
// "I dont want to face it again n again." This is the check that makes that
// true. A Caddy upgrade, a reinstall, or someone copying a default Caddyfile
// re-enables HTTP/3 silently; networks that drop UDP 443 then start failing
// while mobile data keeps working, and the advertisement is cached for 30
// days before anyone can even measure the fix.
{
    section('C2 — the server advertising HTTP/3 again');

    const withAltSvc = (value) => async (url) => {
        const u = String(url);
        const mk = (status, location) => ({ status, headers: { get: (k) => {
            const key = String(k).toLowerCase();
            if (key === 'location') return location || null;
            if (key === 'alt-svc') return value;
            return null;
        } } });
        if (u === 'https://jarvis.edgemetals.com/health') return mk(200);
        if (u === 'http://jarvis.edgemetals.com/health') return mk(308, 'https://jarvis.edgemetals.com/health');
        if (u === 'http://35.233.131.198:8080/') return mk(301, 'https://jarvis.edgemetals.com/');
        throw new Error('unexpected ' + u);
    };

    let res = await E.checkAll({ fetchImpl: withAltSvc('h3=":443"; ma=2592000') });
    ck('an h3 advertisement on the front door is caught', res.ok === false,
       JSON.stringify(res.results.find((r) => r.id === 'canonical')));
    const b = res.broken.find((x) => x.id === 'canonical');
    ck('  and it says HTTP/3 is back on', /HTTP\/3 is back on/.test(b.detail), b.detail);
    ck('  explains why only SOME networks will notice',
       /drop UDP 443/.test(b.detail) && /mobile data will keep working/.test(b.detail), b.detail);
    ck('  warns it is cached for 30 days', /30 days/.test(b.detail), b.detail);
    ck('  and names the exact fix', /protocols h1 h2/.test(b.detail), b.detail);
    // It is an OUTAGE severity, because a subset of people losing access is
    // not a stale bookmark.
    ck('  and it is treated as an outage, not a stale link', res.outage === true, JSON.stringify(res.outage));

    // Our own eraser must NOT trip it.
    res = await E.checkAll({ fetchImpl: withAltSvc('clear') });
    ck('"clear" — the eraser we send on purpose — is accepted', res.ok === true,
       JSON.stringify(res.broken));
    res = await E.checkAll({ fetchImpl: withAltSvc('CLEAR') });
    ck('  case and spacing do not matter', res.ok === true, JSON.stringify(res.broken));
    res = await E.checkAll({ fetchImpl: withAltSvc(null) });
    ck('  and no header at all is fine too', res.ok === true, JSON.stringify(res.broken));

    // ── THE HEADER ARRIVES TWICE THROUGH THE LOAD BALANCER ───────────────
    // Observed on the wire 2026-10-05, right after DNS moved to the Google
    // load balancer: `curl -sI https://jarvis.edgemetals.com/health` returned
    // `alt-svc: clear` on two separate lines. api.js uses res.set, which
    // replaces, so the app sent one; Google's frontend added the second.
    // fetch() joins repeated field lines with a comma, so the check sees
    // "clear, clear" — which the old `!== 'clear'` test failed, and the 05:40
    // job would have emailed an HTTP/3 alarm every night about a correct
    // server. Noise nightly is how a check gets switched off.
    res = await E.checkAll({ fetchImpl: withAltSvc('clear, clear') });
    ck('two "clear" headers joined by fetch do NOT raise a false alarm',
       res.ok === true, JSON.stringify(res.broken));
    res = await E.checkAll({ fetchImpl: withAltSvc('clear,clear,clear') });
    ck('  nor three, nor spacing variations', res.ok === true, JSON.stringify(res.broken));
    res = await E.checkAll({ fetchImpl: withAltSvc(' clear , CLEAR ') });
    ck('  nor mixed case with padding', res.ok === true, JSON.stringify(res.broken));

    // ── AND THE MIXED CASE MUST STILL BITE ───────────────────────────────
    // This is the value that was ACTUALLY on the wire while --quic-override
    // was still propagating: ours, then Google's advertisement. A client
    // reads the whole list, so the h3 entry lands and gets cached for 30
    // days. Tolerating repeated "clear" must not have widened into
    // tolerating a list that contains a real entry — that would have
    // silently undone the whole guard.
    res = await E.checkAll({ fetchImpl: withAltSvc('clear, h3=":443"; ma=2592000') });
    ck('"clear" followed by an h3 advertisement is still caught',
       res.ok === false, JSON.stringify(res.broken));
    ck('  and still treated as an outage', res.outage === true, String(res.outage));
    let bb = res.broken.find((x) => x.id === 'canonical');
    ck('  and names the load balancer, which is what advertises it now',
       /quicOverride/.test(bb.detail), bb.detail);
    ck('  and still names the Caddy fix, because Caddy is still running',
       /protocols h1 h2/.test(bb.detail), bb.detail);
    // Order must not matter — Google could prepend rather than append.
    res = await E.checkAll({ fetchImpl: withAltSvc('h3=":443"; ma=2592000, clear') });
    ck('  order does not matter: advertisement first is caught too',
       res.ok === false, JSON.stringify(res.broken));

    // The predicate on its own, so a mutation has somewhere precise to land.
    ck('advertisesHttp3 is exported and judges each case',
       E.advertisesHttp3('clear, clear') === false
       && E.advertisesHttp3('clear') === false
       && E.advertisesHttp3('') === false
       && E.advertisesHttp3(null) === false
       && E.advertisesHttp3('clear, h3=":443"') === true
       && E.advertisesHttp3('h3=":443"; ma=2592000') === true
       && E.advertisesHttp3('h2=":8443"') === true,
       'any entry that is not "clear" is an advertisement');
}

// ── D — AN OUTAGE IS LOUDER, AND DIFFERENT ────────────────────────────────
{
    section('D — when the front door itself is down');

    const down = async (url) => {
        if (String(url) === 'https://jarvis.edgemetals.com/health') return TIMEOUT();
        return resp(301, 'https://jarvis.edgemetals.com/health');
    };
    const res = await E.checkAll({ fetchImpl: down });
    ck('it is an outage', res.outage === true, JSON.stringify(res));

    const sent = [];
    await J.run({ fetchImpl: down, sendEmail: async (m) => sent.push(m), to: 'x@y.com' });
    ck('  and the subject says nobody can reach it',
       /NOBODY CAN REACH/.test(sent[0].subject), sent[0].subject);
    ck('  which is a different subject from a stale bookmark',
       !/old address/.test(sent[0].subject), sent[0].subject);
}

// ── E — SERVING WHERE ONLY A REDIRECT BELONGS ─────────────────────────────
// The dangerous success. If port 8080 ever answers 200, the dashboard is
// being served over plain HTTP with a 4-character password behind it.
{
    section('E — a 200 where a redirect was expected is WORSE than a failure');

    const serving = async (url) => {
        const u = String(url);
        if (u === 'https://jarvis.edgemetals.com/health') return resp(200);
        if (u === 'http://jarvis.edgemetals.com/health') return resp(308, 'https://jarvis.edgemetals.com/health');
        if (u === 'http://35.233.131.198:8080/') return resp(200);   // serving in cleartext
        throw new Error('unexpected ' + u);
    };
    const res = await E.checkAll({ fetchImpl: serving });
    ck('a 200 on the plain-HTTP address is reported as broken', res.ok === false);
    const b = res.broken.find((x) => x.id === 'legacy-8080');
    ck('  and it says it is SERVING, not merely misbehaving',
       /it is SERVING here/.test(b.detail), b.detail);
    ck('  and that the address is plain HTTP', /plain HTTP/.test(b.detail), b.detail);
}

// ── F — A REDIRECT TO THE WRONG PLACE IS NOT A PASS ───────────────────────
{
    section('F — the redirect has to land somewhere useful');

    const stripsPath = async (url) => {
        const u = String(url);
        if (u === 'https://jarvis.edgemetals.com/health') return resp(200);
        // ── DEMONSTRATED ON THE HOSTNAME, NOT ON 8080 ────────────────────
        // It used to be the 8080 entrance that dropped its path here. That
        // entrance now probes "/" (see ENTRANCES — /health is exempt from
        // the redirect, so it could never test one), and "/" has no path to
        // lose: landing on the root IS correct for it. The hostname
        // entrance still carries /health, so it is the one that can show
        // the fault — a shared deep link dumping the person on the
        // dashboard and making them navigate again.
        if (u === 'http://jarvis.edgemetals.com/health') return resp(308, 'https://jarvis.edgemetals.com/');
        if (u === 'http://35.233.131.198:8080/') return resp(301, 'https://jarvis.edgemetals.com/');
        throw new Error('unexpected ' + u);
    };
    let res = await E.checkAll({ fetchImpl: stripsPath });
    ck('a redirect that drops the path is caught', res.ok === false,
       JSON.stringify(res.broken.map((b) => b.detail)));

    const elsewhere = async (url) => {
        const u = String(url);
        if (u === 'https://jarvis.edgemetals.com/health') return resp(200);
        if (u === 'http://jarvis.edgemetals.com/health') return resp(308, 'http://example.com/health');
        if (u === 'http://35.233.131.198:8080/') return resp(301, 'https://jarvis.edgemetals.com/');
        throw new Error('unexpected ' + u);
    };
    res = await E.checkAll({ fetchImpl: elsewhere });
    ck('  and so is a redirect to another host entirely', res.ok === false,
       JSON.stringify(res.broken.map((b) => b.detail)));

    const noLocation = async (url) => {
        const u = String(url);
        if (u === 'https://jarvis.edgemetals.com/health') return resp(200);
        if (u === 'http://jarvis.edgemetals.com/health') return resp(301, null);
        if (u === 'http://35.233.131.198:8080/') return resp(301, 'https://jarvis.edgemetals.com/');
        throw new Error('unexpected ' + u);
    };
    res = await E.checkAll({ fetchImpl: noLocation });
    ck('  and a 3xx with no Location at all', res.ok === false,
       JSON.stringify(res.broken.map((b) => b.detail)));

    ck('redirectsToCanonical keeps the path',
       E.redirectsToCanonical('https://jarvis.edgemetals.com/health', '/health') === true
       && E.redirectsToCanonical('https://jarvis.edgemetals.com/', '/health') === false
       && E.redirectsToCanonical('https://evil.example/health', '/health') === false);
}

// ── G — THE CHECKER MUST NOT BE THE OUTAGE ────────────────────────────────
{
    section('G — one dead address cannot take the check down');

    const allDead = async () => TIMEOUT();
    let threw = null, res = null;
    try { res = await E.checkAll({ fetchImpl: allDead }); } catch (e) { threw = e.message; }
    ck('every address failing still returns a result', !threw && !!res, String(threw));
    ck('  with each one reported rather than the first one thrown',
       res.broken.length === 3, JSON.stringify(res.broken.map((b) => b.id)));

    const weird = async () => { throw new Error('ENOTFOUND jarvis.edgemetals.com'); };
    res = await E.checkAll({ fetchImpl: weird });
    ck('a DNS failure is reported as a connect failure, not a timeout',
       res.broken.every((b) => /could not connect/.test(b.detail)),
       JSON.stringify(res.broken.map((b) => b.detail)));

    // And the runnable script exists, because a nightly email she reads at
    // 6am is no use at 3pm with a customer waiting.
    ck('there is a script she can run on demand',
       fs.existsSync(path.join(ROOT, 'scripts/check-entrances.js')));
    const sh = fs.readFileSync(path.join(ROOT, 'scripts/check-entrances.js'), 'utf8');
    ck('  it exits non-zero when something is dead', /process\.exit\(1\)/.test(sh));
    ck('  and it uses the same declaration, not its own copy',
       /require\('\.\.\/helpers\/entrances'\)/.test(sh), 'two lists would drift');
}

// ── H — IT RUNS, AND BEFORE THE BANK PULL ─────────────────────────────────
{
    section('H — wired into the morning');

    const sched = fs.readFileSync(path.join(ROOT, 'scheduler.js'), 'utf8');
    ck('it is scheduled', /cron\.schedule\('40 5 \* \* \*'/.test(sched));
    ck('  and calls entrancesJob', /helpers\/entrancesJob'\)\.run\(\)/.test(sched));
    // BEFORE the bank pull: if the server is unreachable she should hear that
    // first, not read a bank report from a machine nobody can log into.
    ck('  ahead of the 05:45 bank pull',
       sched.indexOf("'40 5 * * *'") < sched.indexOf("'45 5 * * *'"),
       'an unreachable server is the more urgent of the two');
    ck('  and a failure cannot stop the scheduler',
       /entrancesJob'\)\.run\(\)[\s\S]{0,400}?\.catch\(/.test(sched));
}

// ── I — THE CERTIFICATE RUNS OUT BEFORE ANYONE NOTICES ────────────────────
// Debt created 2026-10-05 and closed here. Caddy renewed its own certificate
// and nothing had to care. The Google load balancer now in front of it serves
// a COPY of that certificate, uploaded by hand, which does NOT renew — it
// runs out 2026-12-04, and the managed certificate meant to replace it only
// provisions once DNS points at the load balancer.
//
// checkOne already catches an expired certificate: on the morning it breaks,
// as a total outage, on every device at once. That is a warning time of zero,
// which is the exact shape of failure she asked to stop having —
// "I dont want to face it again n again."
{
    section('I — the certificate expiry, warned about in advance');

    // A stub socket. No network, ever: the real tls.connect is injected by
    // entrancesJob and scripts/check-entrances.js, never defaulted.
    const certAt = (validTo, { fail, noCert } = {}) => (opts, onConnect) => {
        const sock = {
            getPeerCertificate: () => (noCert ? null : {
                valid_to: validTo,
                subject: { CN: 'jarvis.edgemetals.com' },
                issuer: { O: "Let's Encrypt" },
            }),
            end() {},
            on(ev, cb) { if (ev === 'error' && fail) setTimeout(() => cb(new Error('connect refused')), 0); },
        };
        if (!fail) setTimeout(() => onConnect(), 0);
        return sock;
    };
    const NOW = Date.parse('2026-10-06T00:00:00Z');
    const inDays = (n) => new Date(NOW + n * 86400000).toUTCString();

    let c = await E.checkCertificate({ tlsImpl: certAt(inDays(59)), now: NOW });
    ck('a certificate 59 days out is fine', c.ok === true && c.checked === true, JSON.stringify(c));
    ck('  and it reports the days left', c.days === 59, String(c.days));
    ck('  and who issued it', /Let's Encrypt/.test(String(c.issuer)), String(c.issuer));

    // 30 days is the line because Caddy renews at 30 — it is the point at
    // which a certificate that is NOT renewing itself becomes visibly
    // different from one that is.
    c = await E.checkCertificate({ tlsImpl: certAt(inDays(30)), now: NOW });
    ck('exactly 30 days out warns', c.ok === false, JSON.stringify(c));
    c = await E.checkCertificate({ tlsImpl: certAt(inDays(31)), now: NOW });
    ck('  31 days does not', c.ok === true, String(c.days));
    c = await E.checkCertificate({ tlsImpl: certAt(inDays(7)), now: NOW });
    ck('  seven days out warns', c.ok === false, String(c.days));
    ck('  and names the command that answers "is the real one ready?"',
       /jarvis-cert/.test(c.detail) && /ACTIVE/.test(c.detail), c.detail);
    ck('  and says the uploaded copy will not renew itself',
       /NOT renew/.test(c.detail), c.detail);

    c = await E.checkCertificate({ tlsImpl: certAt(inDays(-2)), now: NOW });
    ck('an EXPIRED certificate is reported as expired',
       c.ok === false && c.expired === true, JSON.stringify(c));
    ck('  and says every device is seeing it right now', /every device/.test(c.detail), c.detail);

    // ── NOT ATTEMPTED IS NOT FAILED ──────────────────────────────────────
    // A check that goes red because it could not look is noise, and noise is
    // how this whole report gets ignored.
    c = await E.checkCertificate({ tlsImpl: certAt(inDays(50), { fail: true }), now: NOW });
    ck('a refused connection is not-attempted, not failed',
       c.ok === true && c.checked === false, JSON.stringify(c));
    c = await E.checkCertificate({ tlsImpl: certAt(null, { noCert: true }), now: NOW });
    ck('  a handshake with no certificate is the same',
       c.ok === true && c.checked === false, JSON.stringify(c));

    // ── THE ONE THAT MATTERS MOST ────────────────────────────────────────
    // Written first as `tlsImpl || require('tls').connect`, which would have
    // made every checkAll in this suite open a REAL TLS connection to her
    // live host. The suite must never touch her live services, and this file
    // promises it reaches no network of its own.
    c = await E.checkCertificate({ now: NOW });
    ck('with NOTHING injected it opens no socket at all',
       c.ok === true && c.checked === false && /not attempted/.test(c.detail), JSON.stringify(c));
    // Comments stripped first: the header of helpers/entrances.js QUOTES the
    // bad pattern to explain why it is not there, and a source check that
    // cannot tell prose from code fails on its own documentation. This check
    // went red on exactly that and was wrong, not the file.
    const src = fs.readFileSync(path.join(ROOT, 'helpers/entrances.js'), 'utf8')
        .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    ck('  and the source has no fallback to node:tls',
       !/tlsImpl\s*\|\|\s*require\('tls'\)/.test(src) && !/return require\('tls'\)\.connect/.test(src),
       'a convenience default here is an outbound connection from every test run');

    // checkAll carries it, and not looking must not make a healthy run red.
    const healthyAll = await E.checkAll({ fetchImpl: healthy() });
    ck('checkAll reports a certificate section', !!healthyAll.certificate, JSON.stringify(healthyAll.certificate));
    ck('  and not looking does not make the run red',
       healthyAll.ok === true && healthyAll.certificateExpiring === false, String(healthyAll.ok));

    const expiringAll = await E.checkAll({ fetchImpl: healthy(), tlsImpl: certAt(inDays(9)), now: NOW });
    ck('a soon-to-expire certificate turns the whole run red',
       expiringAll.ok === false && expiringAll.certificateExpiring === true, String(expiringAll.ok));
    ck('  but it is NOT called an outage, because nothing is down yet',
       expiringAll.outage === false, 'a deadline and an outage need different words');
    ck('  and every address is still reported as fine',
       expiringAll.broken.length === 0, String(expiringAll.broken.length));

    const deadAll = await E.checkAll({ fetchImpl: healthy(), tlsImpl: certAt(inDays(-1)), now: NOW });
    ck('an already-expired certificate IS an outage', deadAll.outage === true, String(deadAll.outage));

    // The report leads with it — a deadline buried under a list of addresses
    // that all work reads as noise.
    const text = E.report(expiringAll);
    ck('the report leads with the certificate',
       text.indexOf('certificate') > -1
       && text.indexOf('certificate') < text.indexOf('The address to give anyone'),
       text.slice(0, 160));
    ck('  and explains there is no partial version of this failure',
       /every device gets a TLS error at the same/.test(text), text.slice(0, 320));

    // The subject carries the NUMBER OF DAYS: the whole value of this mail is
    // that it arrives before rather than after.
    ck('the subject says how many days are left',
       /expires in 9 days/.test(J.subjectFor(expiringAll)), J.subjectFor(expiringAll));
    ck('  an expired one shouts instead',
       /HAS EXPIRED/.test(J.subjectFor(deadAll)), J.subjectFor(deadAll));
    ck('  and it is not dressed up as an unreachable address',
       !/NOBODY CAN REACH/.test(J.subjectFor(expiringAll)), J.subjectFor(expiringAll));

    // ── THE JOB MUST FORWARD IT, NOT MERELY MENTION IT ───────────────────
    // This was first written as a grep for require('tls').connect in
    // entrancesJob.js — and it PASSED when the mutation removed the value
    // from the checkAll call, because the require line was still sitting
    // there unused. Exactly the failure CLAUDE.md names: a check shaped like
    // the code rather than like the property.
    //
    // So it is behavioural. Hand the job a stub and insist the certificate
    // actually came back checked: that can only happen if run() forwarded it
    // all the way through to checkCertificate.
    {
        const sent = [];
        const r = await J.run({
            fetchImpl: healthy(),
            tlsImpl: certAt(inDays(3)),
            sendEmail: async (m) => sent.push(m),
            to: 'x@y.com',
        });
        ck('the nightly job forwards TLS through to the certificate check',
           r.certificate && r.certificate.checked === true,
           JSON.stringify(r.certificate));
        // A RANGE, not the exact number. run() takes no fixed clock, so a
        // certificate stubbed 3 days out reads as 2 once the real day is a
        // few minutes old. The exact arithmetic is pinned above with a
        // controlled `now`; the property here is only that the subject
        // carries the deadline at all. A test that breaks at midnight is a
        // test that gets deleted.
        ck('  so an expiring certificate really does email her',
           sent.length === 1 && /expires in [0-3] days/.test(sent[0].subject),
           JSON.stringify(sent.map((m) => m.subject)));
        ck('  and the body carries the deadline, not just the subject',
           sent.length === 1 && /day\(s\)/.test(sent[0].body), (sent[0] || {}).body);
    }
    // And it stays silent when there is nothing to say.
    {
        const sent = [];
        await J.run({ fetchImpl: healthy(), tlsImpl: certAt(inDays(70)),
            sendEmail: async (m) => sent.push(m), to: 'x@y.com' });
        ck('  while a healthy certificate sends nothing at all',
           sent.length === 0, JSON.stringify(sent.map((m) => m.subject)));
    }

    const shSrc = fs.readFileSync(path.join(ROOT, 'scripts/check-entrances.js'), 'utf8');
    ck('the script she runs by hand injects TLS too',
       /checkAll\(\{\s*tlsImpl:\s*require\('tls'\)\.connect\s*\}\)/.test(shSrc),
       'checked at the call site, not merely that the module is required somewhere');
    ck('  which prints the days left even when nothing is wrong',
       /day\(s\) left/.test(shSrc), 'the Dec 4 hand-off should be visible on an ordinary day');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('threw:', e && e.stack); process.exit(1); });
