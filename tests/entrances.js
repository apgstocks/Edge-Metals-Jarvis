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
        if (u === 'http://35.233.131.198:8080/health') return resp(301, 'https://jarvis.edgemetals.com/health');
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
        if (u === 'http://35.233.131.198:8080/health') return TIMEOUT();
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
        if (u === 'http://35.233.131.198:8080/health') return resp(200);   // serving in cleartext
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
        if (u === 'http://jarvis.edgemetals.com/health') return resp(308, 'https://jarvis.edgemetals.com/health');
        // Lands on the root instead of /health — a shared deep link would
        // dump the person on the dashboard and make them navigate again.
        if (u === 'http://35.233.131.198:8080/health') return resp(301, 'https://jarvis.edgemetals.com/');
        throw new Error('unexpected ' + u);
    };
    let res = await E.checkAll({ fetchImpl: stripsPath });
    ck('a redirect that drops the path is caught', res.ok === false,
       JSON.stringify(res.broken.map((b) => b.detail)));

    const elsewhere = async (url) => {
        const u = String(url);
        if (u === 'https://jarvis.edgemetals.com/health') return resp(200);
        if (u === 'http://jarvis.edgemetals.com/health') return resp(308, 'http://example.com/health');
        if (u === 'http://35.233.131.198:8080/health') return resp(301, 'https://jarvis.edgemetals.com/health');
        throw new Error('unexpected ' + u);
    };
    res = await E.checkAll({ fetchImpl: elsewhere });
    ck('  and so is a redirect to another host entirely', res.ok === false,
       JSON.stringify(res.broken.map((b) => b.detail)));

    const noLocation = async (url) => {
        const u = String(url);
        if (u === 'https://jarvis.edgemetals.com/health') return resp(200);
        if (u === 'http://jarvis.edgemetals.com/health') return resp(301, null);
        if (u === 'http://35.233.131.198:8080/health') return resp(301, 'https://jarvis.edgemetals.com/health');
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

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('threw:', e && e.stack); process.exit(1); });
