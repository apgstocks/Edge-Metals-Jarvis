// ── api.js — Express API + static dashboard ──────────────────────────────────
// The dashboard is deliberately dumb: /api/dashboard returns fully decorated
// rows (stage index, risk, deadline, owner, pending text) computed HERE, next
// to the same config the workflow uses. Rename a step in config.js and both
// WhatsApp replies and the dashboard stay in sync.

const express = require('express');
const path    = require('path');
const crypto  = require('crypto');
// Apsara, 2026-08-24, live: the exact same bug class as "send is not
// defined" — found by running eslint's no-undef check across the whole repo
// after that incident, rather than waiting for a second one to surface on
// its own. /api/health's very first check (drive_keyfile) has been throwing
// "fs is not defined" since whenever this endpoint was written, caught by
// its own outer try/catch, which means EVERY check after it — gemini_key,
// sheet_sync, whatsapp readiness, load_warnings — has never once actually
// run. The endpoint always reported ok:false with a useless generic error,
// which is worse than not having a health check: it looks monitored and
// isn't.
const fs      = require('fs');
const { loadBookings, loadWorkflow, loadHistory, loadTruckers, loadSuppliers,
        upsertTrucker, deleteTrucker, upsertSupplier, deleteSupplier,
        mutateJson, loadSettings, saveSettings, updateWorkflow, archiveBooking,
        loadFacts, loadActiveFacts, addFact, setFactPinned, deleteFactById,
        supersedeFact, retractFact, unretractFact, factHistory } = require('./helpers/json');
const { daysUntil }   = require('./helpers/time');
const { listAlerts, snoozeAlert, muteBooking } = require('./alerts');
const cfg = require('./config');

// ── Session auth (in-memory, single process) ────────────────────────────────
// Keys are random 32-byte hex; issued on /login, checked on every non-public
// route via the sid cookie. Restart wipes sessions — acceptable, users just
// log in again. Real auth (users, roles, hashed passwords) is Pass 3+.
const sessions = new Map(); // sid → { issued: ms, ip, role: 'user' | 'admin' }
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

// `opts.super` marks a session logged in with JARVIS_PASSWORD. It is stored on
// the SESSION, never derived from anything the client sends: the flag is the
// only thing standing between a normal admin and the ability to erase a paid
// load, so it must not be reachable by any request body, header or cookie the
// caller controls.
// Failed sign-ins per IP. Counted for VISIBILITY only — nothing here refuses
// anyone, by her decision ("nothing as of now"). Capped so a long attack
// cannot grow this map without bound and turn a nuisance into a memory
// problem; at the cap the oldest entry goes, since the count that matters is
// the one still climbing.
const failedLogins = new Map();
const FAILED_LOGIN_MAX_IPS = 5000;
const originalFailedSet = failedLogins.set.bind(failedLogins);
failedLogins.set = (k, v) => {
    if (!failedLogins.has(k) && failedLogins.size >= FAILED_LOGIN_MAX_IPS) {
        failedLogins.delete(failedLogins.keys().next().value);
    }
    return originalFailedSet(k, v);
};

function issueSession(ip, role, opts = {}) {
    const sid = crypto.randomBytes(32).toString('hex');
    sessions.set(sid, { issued: Date.now(), ip, role, super: !!opts.super });
    return sid;
}
function getSession(sid) {
    if (!sid) return null;
    const s = sessions.get(sid);
    if (!s) return null;
    if (Date.now() - s.issued > SESSION_TTL_MS) { sessions.delete(sid); return null; }
    return s;
}
function validSession(sid) { return !!getSession(sid); }
function parseCookie(header, name) {
    if (!header) return null;
    const m = header.split(';').map(x => x.trim()).find(x => x.startsWith(name + '='));
    return m ? m.slice(name.length + 1) : null;
}

// ── Dashboard decoration ──────────────────────────────────────────────────────
const DASH_STAGES = ['Not Started', 'Assigned to Supplier', 'Forwarded to Trucker',
                     'Empty Dropped', 'Load Ready', 'Picked Up', 'Ingated'];

// Per-step: default pending text + who owns the next move
const STEP_PENDING = {
    not_started        : (b, wf) => ({ pending: b.supplier ? 'Awaiting forward to trucker' : 'Awaiting supplier assignment', owner: 'Manager' }),
    supplier_assigned  : (b, wf) => ({ pending: 'Awaiting supplier confirmation', owner: wf.supplier || b.supplier || 'Supplier' }),
    forwarded          : (b, wf) => ({ pending: "Trucker hasn't confirmed pickup", owner: wf.trucker_name ? `${wf.trucker_name} (Trucker)` : 'Trucker' }),
    empty_dropped      : (b, wf) => ({ pending: 'Loading in progress', owner: wf.supplier || b.supplier || 'Supplier' }),
    load_ready         : (b, wf) => ({ pending: 'Pickup pending', owner: wf.trucker_name ? `${wf.trucker_name} (Trucker)` : 'Trucker' }),
    picked_up          : (b, wf) => ({ pending: wf.scale_ticket ? 'Ingate pending' : 'Scale ticket + ingate pending', owner: wf.trucker_name ? `${wf.trucker_name} (Trucker)` : 'Trucker' }),
    ingate_received    : ()       => ({ pending: null, owner: 'Jarvis' }),
    done               : ()       => ({ pending: null, owner: 'Jarvis' }),
};

function decorateBooking(b, wf) {
    const step       = wf.step || 'not_started';
    const stageIndex = cfg.STAGE_INDEX[step] ?? 0;
    const isDone     = cfg.TERMINAL_STEPS.includes(step);

    // Nearest future deadline of ERD/cutoff
    const candidates = [
        b.erd_date    ? { label: 'ERD',    days: daysUntil(b.erd_date) }    : null,
        b.cutoff_date ? { label: 'Cutoff', days: daysUntil(b.cutoff_date) } : null,
    ].filter(x => x && x.days !== 999);
    candidates.sort((a, z) => a.days - z.days);
    const next = candidates.find(c => c.days >= 0) || candidates[0] || null;

    let risk;
    if (isDone)                 risk = 'done';
    else if (!next)             risk = 'low';
    else if (next.days <= 2)    risk = 'high';
    else if (next.days <= 4)    risk = 'medium';
    else                        risk = 'low';

    const pend = wf.pending_note
        ? { pending: wf.pending_note, owner: wf.pending_owner || '—' }
        : (STEP_PENDING[step] || STEP_PENDING.not_started)(b, wf);

    // "Empty Dropped · Scale ticket pending" style sub-branch
    let subBranch = null;
    if (step === 'picked_up')      subBranch = wf.scale_ticket ? 'Scale ticket done' : 'Scale ticket pending';

    return {
        bookingNo    : b.booking_number,
        route        : `${b.port_of_loading || '—'} → ${b.port_of_discharge || '—'}`,
        container    : wf.container || b.container_number || '—',
        stageIndex,
        stageName    : DASH_STAGES[stageIndex],
        subBranch,
        pending      : isDone ? null : pend.pending,
        owner        : pend.owner,
        risk,
        deadlineLabel: isDone ? 'Complete' : next ? `${next.label} · ${next.days}d` : '—',
        deadlineDays : next ? next.days : null,
        erd          : b.erd_date || null,
        cutoff       : b.cutoff_date || null,
        supplier     : wf.supplier || b.supplier || null,
        trucker      : wf.trucker_name || null,
        step,
        updated_at   : wf.updated_at || null,
    };
}

// ── App ───────────────────────────────────────────────────────────────────────
function createApi() {
    const app = express();

    // ── BEHIND A REVERSE PROXY, req.ip IS A LIE ───────────────────────────
    // Apsara 2026-09-03 is moving off the Cloudflare quick tunnel onto a
    // subdomain of her GoDaddy domain, which means Caddy or nginx terminating
    // TLS on the VM and proxying to this process on localhost.
    //
    // The moment that happens, Express reports req.ip as 127.0.0.1 for EVERY
    // request, because that is genuinely who connected. Three things quietly
    // become wrong:
    //   - the audit log records 127.0.0.1 as the address that deleted a paid
    //     load, for ever. That log exists precisely because the record it
    //     describes no longer does, and "who" is half of it.
    //   - the failed sign-in counter sees one IP and can never distinguish a
    //     typo from a wordlist.
    //   - sessions are stamped with the wrong origin.
    // None of those throw. They just stop meaning anything.
    //
    // OFF BY DEFAULT, AND THAT IS THE SAFE DIRECTION. X-Forwarded-For is a
    // request header, so anyone can set it. Trusting it with no proxy in
    // front lets a caller claim any address they like and write it into the
    // audit log — worse than 127.0.0.1, because it is a plausible lie rather
    // than an obvious placeholder. So it is opt-in, and only correct once
    // something trusted is actually terminating in front of this.
    //
    // TRUST_PROXY=1 means one hop (Caddy/nginx on this host). A number means
    // that many hops, for a proxy behind a proxy.
    const trustProxy = process.env.TRUST_PROXY;
    if (trustProxy) {
        const hops = Number(trustProxy) || 1;
        app.set('trust proxy', hops);
        console.log(`[NET] trust proxy = ${hops} — client IPs read from X-Forwarded-For. `
            + 'Only correct if a proxy you control is in front of this.');
    }

    // ── ERASE THE CACHED HTTP/3 ADVERTISEMENT — RFC 7838 ─────────────────
    // Apsara, 2026-10-05: "They tokld that it is now working in mobile data
    // but not wifi."
    //
    // That sentence is the signature, and docs/cloudflare-runbook.md wrote it
    // down on 2026-10-02: "Many wifi networks allow TCP 443 and silently drop
    // UDP 443, so the phone kept reaching for QUIC and failing, while mobile
    // data (which carries UDP fine) worked."
    //
    // Caddy advertised HTTP/3 over UDP 443 as
    //     alt-svc: h3=":443"; ma=2592000
    // and ma=2592000 is THIRTY DAYS. HTTP/3 was switched off server-side on
    // 2026-10-03 and the live server no longer advertises it — verified over
    // the wire. But turning the advertisement off does nothing about the
    // copies clients already stored. Those keep trying QUIC until they
    // expire, around 2026-11-02.
    //
    // THE PART EVERYONE MISSES, INCLUDING ME FOR MOST OF TODAY: there is a
    // server-side eraser. RFC 7838 section 3 defines the value "clear" —
    // "any existing alternative services for the origin are invalidated".
    // One header on one response and the stale entry is gone, on a device
    // nobody has to touch, without a restart, a cache clear, or asking a
    // customer in another country to do anything at all.
    //
    // Why it is safe to send always: the server does not offer HTTP/3, so
    // there is nothing legitimate to advertise and nothing to break. The day
    // HTTP/3 is deliberately turned back on, this line must go — and the
    // Caddyfile's `protocols h1 h2` is the thing that would change first, so
    // tests/alt-svc-clear.js asserts the two agree rather than letting them
    // drift apart silently.
    //
    // It is set HERE rather than in the Caddyfile because this path deploys
    // with the git pull + pm2 restart she already runs, and Caddy passes a
    // backend header through untouched — it no longer sets alt-svc itself.
    app.use((req, res, next) => {
        res.set('Alt-Svc', 'clear');
        next();
    });

    // ── /api/ IS LIVE DATA AND IS NEVER CACHED ───────────────────────────
    // Apsara, 2026-10-23: "when i create a load/sle,i have to log out n
    // relogin to view the latest change.same is hapeening in docs also."
    //
    // Nothing was wrong with the server or the screen. Checked both: POST
    // /api/loads then GET /api/loads returns the new row immediately and the
    // ETag changes, and the Loads tab refetches through loadTab('loads') on
    // every open. What was missing is this header. Every /api/ response went
    // out with NO Cache-Control and NO Vary at all, which leaves each
    // browser — and anything between her and the VM — free to decide for
    // itself how long yesterday's inventory stays fresh.
    //
    // THIS EXACT BUG HAS HAPPENED HERE BEFORE, on a different surface. See
    // routes/pages.js's no-cache on .html, added 2026-08-15 after she pulled
    // two rounds of PDF fixes onto the VM and still saw the old buttons:
    // "express.static's default sends NO Cache-Control header at all, which
    // leaves each browser free to use its own heuristic freshness lifetime".
    // Static HTML was fixed then; the JSON the dashboard runs on was not.
    // Same cause, same symptom, same fix — and from her side both look
    // exactly like the deploy never happened.
    //
    // ── VARY IS THE HALF THAT IS NOT ABOUT STALENESS ─────────────────────
    // The dashboard is reached through a Cloudflare tunnel (see
    // dashboard/sw.js). A response with no Cache-Control and no Vary that
    // any shared cache decides to keep is served to WHOEVER asks next — so
    // a staff session could be handed a manager's /api/loads. no-store
    // settles it on its own; Vary is belt and braces for the day somebody
    // turns on "Cache Everything" and nobody connects it to this.
    //
    // Scoped to /api/ deliberately. The dashboard's own JS and CSS still
    // cache normally — this is about the data, not the app shell — and the
    // generated-document routes under /api/ are downloads nobody wants
    // re-served stale either.
    app.use((req, res, next) => {
        if (req.path.startsWith('/api/')) {
            res.set('Cache-Control', 'no-store, must-revalidate');
            res.set('Vary', 'Cookie, Authorization');
        }
        next();
    });

    // ── PORT 8080 ANSWERS, AND SENDS THEM TO HTTPS ───────────────────────
    // Apsara, 2026-10-05: "make it reacgable at http://35.233.131.198:8080".
    //
    // The old bare-IP URL keeps circulating — HTTPS_SETUP.md still states it
    // in the present tense at line 5 — and a customer in the US lost an
    // afternoon to `ERR_CONNECTION_TIMED_OUT` on it. The address itself is
    // not the problem; nothing was listening to the outside world on 8080,
    // because Caddy terminates TLS on 443 and talks to 127.0.0.1:8080.
    //
    // So 8080 now answers and REDIRECTS. What it must never do is SERVE the
    // app over plain HTTP:
    //
    //   · APP_PASSWORD is 4 characters and ADMIN_PASSWORD is 5 (see the boot
    //     lines below), and there is no login lockout. In cleartext, on hotel
    //     or cafe wifi, those are readable by anyone on the path — along with
    //     supplier payments, bank details and the Plaid-fed ledger.
    //   · getUserMedia() refuses to run outside a secure context, so the
    //     camera buttons on Loads would break again. Avoiding that is the
    //     entire reason HTTPS was set up.
    //
    // A redirect gives her what she asked for and costs none of that: the
    // 301 happens BEFORE any password is typed, the path and query survive,
    // and an old bookmark heals itself the first time it is used.
    //
    // HOW IT TELLS THE TWO APART. Caddy sets X-Forwarded-Proto: https on
    // everything it proxies (confirmed in its own access log). A request
    // arriving straight at 8080 has no such header. trust proxy is already
    // set above, so req.secure reflects it rather than the raw socket.
    //
    // LOOPBACK IS EXEMPT, and that is not a detail: the VM's own health
    // checks, `curl localhost:8080/health`, and anything pm2 or a cron job
    // reaches for would otherwise be answered with a redirect to a hostname
    // and a TLS handshake. That would have turned a URL fix into an outage.
    app.use((req, res, next) => {
        if (req.secure) return next();                       // came through Caddy
        const ip = String(req.ip || req.socket.remoteAddress || '');
        if (/^(::1|::ffff:127\.|127\.)/.test(ip)) return next();   // on the box itself

        // ── A HEALTH CHECK MUST NEVER BE REDIRECTED ──────────────────────
        // Caught on 2026-10-05 the moment the Google load balancer was
        // built: its backend came up UNHEALTHY because the health checker
        // polls http://10.138.0.2:8080/health from Google's own ranges —
        // not loopback, and with no X-Forwarded-Proto — so this middleware
        // answered the probe with a 301. A checker expecting 200 marks the
        // backend dead, and the load balancer then serves 502 to everyone.
        //
        // That is this redirect's blast radius and I did not think of it.
        // The loopback exemption was written for `curl localhost`; a prober
        // that is neither local nor HTTPS was outside what I considered.
        //
        // TWO EXEMPTIONS, deliberately overlapping:
        //   · /health answers plainly whoever asks. A health endpoint that
        //     redirects is not a health endpoint, and this also covers any
        //     future checker — uptime monitors, a second load balancer —
        //     without anyone having to remember this comment exists.
        //   · Google's documented health-check ranges, so the probe is safe
        //     even if the path is ever renamed.
        // 130.211.0.0/22 and 35.191.0.0/16 are fixed and documented by
        // Google; they are the same two ranges the allow-lb-health firewall
        // rule admits, so the two agree by construction.
        if (req.path === '/health' || req.path === '/healthz') return next();
        if (/^(::ffff:)?(130\.211\.|35\.191\.)/.test(ip)) return next();
        const host = String(req.headers.host || '');
        // Already on the real hostname over plain HTTP (port 80) — Caddy
        // handles that redirect itself; do not fight it.
        if (/^jarvis\.edgemetals\.com/i.test(host)) return next();
        const target = 'https://jarvis.edgemetals.com' + (req.originalUrl || '/');
        res.set('Cache-Control', 'no-store');                // never cache a redirect of a login
        return res.redirect(301, target);
    });

    // ── say out loud whether the top-level profile is live ────────────────
    // A misconfigured JARVIS_PASSWORD fails SILENTLY at the login form: the
    // password is simply not recognised, which looks exactly like a typo. This
    // is the one place that can tell the difference, so it says so at boot
    // rather than leaving her to guess at a password prompt. Never prints the
    // password or any part of it.
    {
        const j = cfg.JARVIS_PASSWORD;
        if (!j) {
            console.log('[AUTH] Jarvis profile: not configured (set JARVIS_PASSWORD to enable it)');
        } else if (j === cfg.ADMIN_PASSWORD || j === cfg.APP_PASSWORD || j === cfg.STAFF_PASSWORD) {
            console.error('[AUTH] Jarvis profile DISABLED: JARVIS_PASSWORD is identical to another tier\'s password. '
                + 'Sharing it would silently promote that tier to top-level access. Set it to something distinct.');
        } else if (j.length < 12) {
            // Not refused — her server, her call — but this password's whole
            // job is to be the last thing between someone and a deleted
            // payment record, so a short one should not pass unremarked.
            console.warn('[AUTH] Jarvis profile enabled, but JARVIS_PASSWORD is under 12 characters. '
                + 'It gates deleting paid loads; consider something longer.');
        } else {
            console.log('[AUTH] Jarvis profile enabled (top-level, audited to data/audit_log.json)');
        }
    }

    // ── and which Gemini model each tier will really use (#159) ───────────
    // Same reason as the block above: a config value that is silently
    // overridden looks exactly like a config value that is being obeyed.
    // getModelName() prefers data/settings.json's gemini_model over
    // cfg.GEMINI_MODEL, and PUT /api/settings writes the whole default object
    // back — so the model was frozen into that file the first time any
    // setting was ever saved, and config.js has been a dead letter since.
    //
    // Printed, not enforced. See helpers/gemini.js's effectiveModels.
    try {
        for (const line of require('./helpers/gemini').modelReportLines()) {
            if (/WARNING/.test(line)) console.warn(line);
            else console.log(line);
        }
    } catch (e) {
        // A report that cannot be produced must not stop the server booting.
        console.warn('[GEMINI] could not report the effective models:', e.message);
    }
    // Changed 2026-08-11: this GLOBAL parser used to cap every request body
    // at 2mb, registered before any route runs. Several routes below
    // (largeJson, defined at line ~491) were built to override that with a
    // 40mb limit for photo uploads — but Express body-parsers consume the
    // request stream on first match and skip re-parsing once req.body is
    // set, so THIS global 2mb parser was always the one that actually ran
    // first and either succeeded or threw PayloadTooLargeError. The
    // route-specific 40mb middleware never got a chance to apply on any
    // request over 2mb; it silently did nothing on every request under 2mb
    // (already parsed). Verified directly with a minimal Express repro
    // reproducing this exact stacking pattern: a 5mb body against this
    // setup returned 413 even though the route's own middleware said 40mb.
    // So the "40mb fix" referenced throughout this codebase's history was
    // never actually in effect — this was dormant/invisible while client
    // photos stayed under 2mb (the old 1600px downscale kept them there),
    // and started throwing again the moment full-resolution photos shipped.
    // Fix: the global limit now matches what every route-specific override
    // already assumed was true. The per-route largeJson middleware further
    // down is now redundant (harmless — it just never fires) but left in
    // place rather than removed under time pressure; a future cleanup could
    // delete it without changing behavior.
    // ── rawBody, FOR THE PLAID WEBHOOK ONLY ───────────────────────────────
    // Plaid signs the SHA-256 of the exact bytes it sent, and its docs warn
    // the hash "is sensitive to the whitespace in the webhook body". Once
    // express.json has parsed and we re-serialise, the hash cannot match
    // however identical the object looks — so the raw buffer has to be kept
    // before parsing.
    //
    // ONLY for that path. Keeping a 40 MB buffer on every request to hold
    // one small webhook would double the memory cost of every photo upload
    // on a box with max_memory_restart at 1500M.
    app.use(express.json({
        limit: '40mb',
        verify: (req, res, buf) => {
            if (req.url && req.url.split('?')[0] === '/api/plaid/webhook') req.rawBody = buf;
        },
    }));

    // ── GZIP ──────────────────────────────────────────────────────────────
    // Apsara, 2026-09-19: "When i click Bill,it takes like 5 seconds to load
    // it.Latency is something which i dont want".
    //
    // Measured before touching anything, because the obvious suspect was the
    // arithmetic and the obvious suspect was innocent: for 600 bills,
    // listWithTotals + filterRows + duplicates + summary + facets together
    // come to ~20ms, and the whole route answers in 9–21ms. The server was
    // never the slow part.
    //
    // What it was SENDING is:
    //     /api/bills      552 KB  ->  30 KB gzipped   (18x)
    //     /index.html     723 KB  -> 197 KB gzipped   (3.7x)
    //
    // Over a megabyte of text on one tab open, and index.html is no-cache on
    // purpose (see the stale-page note), so that 723 KB is paid on EVERY
    // load, not once. JSON compresses like that because every one of the 600
    // rows repeats the same 38 keys.
    //
    // WHY HAND-ROLLED RATHER THAN `npm i compression`
    // ------------------------------------------------
    // Deploying here is `git pull && pm2 restart` — there is no npm install
    // step in that sequence. A new dependency would mean the pull succeeds,
    // the restart fails with MODULE_NOT_FOUND, and the whole site is down
    // until someone works out why. Node ships zlib; this costs nothing to
    // deploy and cannot fail that way.
    //
    // WHY gzip AND NOT brotli
    // -----------------------
    // Measured too. On this data brotli reaches 2 KB where gzip reaches 5 KB
    // — but brotli at its default quality 11 took 147ms to do it, which would
    // hand back most of what compressing saved. gzip level 6 does 550 KB in
    // about 3ms. The extra 3 KB is not worth 140ms of CPU per request.
    //
    // ── WHAT IS DELIBERATELY NOT TOUCHED ──────────────────────────────────
    // res.sendFile and res.download are not wrapped. Seven routes use them
    // and every one serves a generated PDF or xlsx — both are already
    // compressed containers, so gzipping them burns CPU to make the file
    // marginally BIGGER. They stream past this untouched, as they should.
    //
    // Nor does anything change for callers: gzip is negotiated, so a client
    // that did not ask for it gets exactly the bytes it got yesterday. The
    // test suite's raw http.request does not send Accept-Encoding and is
    // therefore entirely unaffected; browsers, the Capacitor WebView and the
    // Electron window all ask for it and all decode it transparently.
    const zlib = require('zlib');
    const COMPRESSIBLE = /^(?:application\/(?:json|javascript|xml)|text\/|image\/svg)/i;
    const GZIP_MIN = 1024;   // below this the header costs more than it saves
    app.use((req, res, next) => {
        const accepts = String(req.headers['accept-encoding'] || '');
        if (!/\bgzip\b/i.test(accepts)) return next();

        const sendRaw = res.send.bind(res);
        res.send = function (body) {
            try {
                // Already encoded by something else, or a HEAD/304 with no
                // body to encode — leave it exactly alone.
                if (res.getHeader('Content-Encoding')) return sendRaw(body);
                if (req.method === 'HEAD' || res.statusCode === 204 || res.statusCode === 304) return sendRaw(body);
                if (typeof body !== 'string' && !Buffer.isBuffer(body)) return sendRaw(body);

                const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
                if (buf.length < GZIP_MIN) return sendRaw(body);

                // res.json() sets the type before calling send(), so by here
                // the content type is known. An unknown type is not gzipped:
                // guessing wrong on a binary is worse than sending it plain.
                const type = String(res.getHeader('Content-Type') || '');
                if (!COMPRESSIBLE.test(type)) return sendRaw(body);

                const out = zlib.gzipSync(buf, { level: 6 });
                res.setHeader('Content-Encoding', 'gzip');
                // Vary matters even though this app has no CDN yet: without
                // it, any cache in front would serve gzipped bytes to a
                // client that never asked for them.
                res.setHeader('Vary', 'Accept-Encoding');
                res.removeHeader('Content-Length');
                return sendRaw(out);
            } catch (e) {
                // Compression is an optimisation. If it throws, the response
                // still has to arrive — a blank screen is infinitely worse
                // than a slow one.
                console.warn('[GZIP] falling back to plain:', e.message);
                try { res.removeHeader('Content-Encoding'); } catch (e2) {}
                return sendRaw(body);
            }
        };
        next();
    });

    // Minimal hand-rolled CORS (no new dependency for a few headers) — added
    // for the Loads mobile app (Capacitor WebView), whose requests to this
    // API are cross-origin from the browser's point of view (app origin is
    // capacitor://localhost / https://localhost, API origin is wherever
    // this is deployed). No Access-Control-Allow-Credentials here on
    // purpose: the mobile app authenticates via Authorization: Bearer
    // <sid> (see /login and the session-gate below), not cookies, so
    // credentialed CORS was never needed and the browser cookie's
    // SameSite=Strict is left completely untouched for the desktop
    // dashboard. Wildcard origin is fine for the same reason — the actual
    // access control is the password/session/token check below, not CORS
    // (CORS only ever gates browser JS reading the response, not whether a
    // request can be made at all).
    // ── NARROWED TO AN ALLOWLIST, 2026-09-03 ──────────────────────────────
    // The reasoning above is still true as far as it goes — CORS gates a
    // browser READING a response, not whether the request happens, and the
    // real access control is the session check. But "still safe" and "as
    // narrow as it should be" are different standards, and a wildcard means
    // any page on the internet can read this API's responses the moment it
    // gets hold of a token. With bank data arriving, that margin is worth
    // closing.
    //
    // WHAT IS ALLOWED, AND WHY EACH ONE:
    //   https://localhost   — the Android app. capacitor.config.json sets
    //                         androidScheme "https" with no hostname, so this
    //                         is the WebView's origin. Get this wrong and the
    //                         app stops working entirely.
    //   capacitor://, ionic://, http://localhost — other Capacitor schemes,
    //                         kept so a config change or an iOS build does not
    //                         silently break the app.
    // The DASHBOARD needs no entry: it is served by this same Express app, so
    // its requests are same-origin and never carry an Origin header at all.
    //
    // TWO ESCAPE HATCHES, because the failure mode here is being locked out of
    // her own app from a phone with no laptop nearby:
    //   CORS_ALLOWED_ORIGINS  — comma-separated, added to the list.
    //   CORS_ALLOW_ALL=1      — restores the old wildcard exactly.
    // And a refused origin is LOGGED with the value it saw, so the fix is
    // reading one log line rather than guessing.
    const CORS_DEFAULT_ORIGINS = [
        'https://localhost', 'http://localhost',
        'capacitor://localhost', 'ionic://localhost',
    ];
    const corsAllowed = new Set(CORS_DEFAULT_ORIGINS.concat(
        String(process.env.CORS_ALLOWED_ORIGINS || '')
            .split(',').map((s) => s.trim()).filter(Boolean)));
    const corsAllowAll = process.env.CORS_ALLOW_ALL === '1';
    if (corsAllowAll) {
        console.warn('[CORS] CORS_ALLOW_ALL=1 — every origin is allowed. Intended as a temporary escape hatch.');
    }
    const corsRefused = new Set();     // logged once each, not per request
    app.use((req, res, next) => {
        const origin = req.headers.origin;
        // NO Origin HEADER AT ALL is the common case and must keep working:
        // same-origin browser requests, curl, the monitor, anything
        // server-to-server. Nothing is added and nothing is blocked — CORS
        // simply does not apply to those.
        if (origin) {
            if (corsAllowAll) {
                res.setHeader('Access-Control-Allow-Origin', '*');
            } else if (corsAllowed.has(origin)) {
                res.setHeader('Access-Control-Allow-Origin', origin);
                // Responses now differ by origin, so anything caching them has
                // to know that. Without Vary a shared cache could hand one
                // origin's response to another.
                res.setHeader('Vary', 'Origin');
            } else if (!corsRefused.has(origin)) {
                corsRefused.add(origin);
                console.warn(`[CORS] refused origin ${origin} — if this is your app, add it: CORS_ALLOWED_ORIGINS=${origin}`);
            }
        }
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        if (req.method === 'OPTIONS') return res.sendStatus(204);
        next();
    });

    // ── Public routes (no auth) ───────────────────────────────────────────────
    app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

    // ── /healthz — the ONLY endpoint an external uptime monitor should watch ──
    //
    // Apsara, 2026-08-26: "can we use this [hetrixtools.com]". Yes — but not
    // against either endpoint that existed when she asked, and the reason is
    // the whole point of this route:
    //
    //   /health      is public and returns {status:'ok'} 200 for as long as the
    //                Node process can answer a socket. WhatsApp logged out,
    //                Gmail token dead, every scheduled scan throwing — still 200.
    //   /api/health  runs real checks, but it is behind auth (a monitor cannot
    //                reach it) AND it returns 200 even when ok:false. A monitor
    //                watching status codes would never fire.
    //
    // So Jarvis had two health endpoints and no way for anything outside the
    // box to learn it had stopped working. That is worse than no monitoring:
    // it looks monitored and isn't. (The same sentence is already written at
    // the top of tests/api-health.js about a different instance of this.)
    //
    // This route answers with a STATUS CODE — 503 when Jarvis is up but not
    // WORKING — because every monitoring product on earth can alert on that,
    // whereas keyword matching inside a JSON body is a paid feature on most,
    // HetrixTools included at some tiers.
    //
    // PUBLIC, deliberately. A monitor cannot carry the dashboard session
    // cookie. What it discloses is three booleans, a timestamp and an uptime —
    // strictly less than the login page already on this port tells you. It
    // exposes no data, no counts, and nothing actionable to an attacker.
    const HEALTHZ_STALE_SCAN_MIN = 20;   // reply-watch cron is */5; four missed ticks
    const HEALTHZ_BOOT_GRACE_S = 900;    // don't call a fresh boot "stalled"
    // ── THE PHONES REPORT WHAT THEY COULD NOT DO ─────────────────────────
    // Apsara, 2026-10-02: "I cant afford mistakes like this when i sell this
    // to many customers." Four hours went into guessing why some wifi
    // networks would not let the app sign in, because nothing could tell us.
    // This is how the next one takes minutes.
    //
    // ── UNAUTHENTICATED, AND THAT IS THE POINT ───────────────────────────
    // A device reporting "I cannot reach the server" has not signed in — by
    // definition. There is no token to present. So this is the only route in
    // Jarvis a stranger can write to, and the limits below are doing the job
    // authentication normally does:
    //
    //   16kb body      not the global 40mb. A report is a few hundred bytes;
    //                  40mb from an open endpoint is a disk-filling tool.
    //   30 per IP/hr   a phone retrying hard sends a handful. Thirty is
    //                  generous for honesty and useless for flooding.
    //   capped store   helpers/clientErrors trims to KEEP, oldest first, so
    //                  this can never grow until the VM runs out of room.
    //                  A diagnostic that causes an outage is worse than none.
    //   whitelisted    clean() keeps six fields and discards the rest, so a
    //                  later client change cannot start posting secrets that
    //                  this would then faithfully write down.
    //
    // It always answers 204. Never an error, never a hint about what was
    // rejected: an endpoint that tells an anonymous caller how its filter
    // works is an endpoint being tuned against.
    const clientErrHits = new Map();
    app.post('/api/client-errors', express.json({ limit: '16kb' }), async (req, res) => {
        res.status(204).end();
        try {
            const ip = String(req.headers['cf-connecting-ip']
                || (req.headers['x-forwarded-for'] || '').split(',')[0]
                || req.ip || '').trim().slice(0, 60);
            const now = Date.now();
            const hit = clientErrHits.get(ip);
            if (!hit || now - hit.at > 3600000) clientErrHits.set(ip, { at: now, n: 1 });
            else if (hit.n >= 30) return;
            else hit.n += 1;
            // Unbounded Maps are their own slow leak. Swept whenever it grows
            // past a size no real fleet reaches.
            if (clientErrHits.size > 500) {
                for (const [k, v] of clientErrHits) if (now - v.at > 3600000) clientErrHits.delete(k);
            }
            await require('./helpers/clientErrors').record(req.body, { ip });
        } catch (e) {
            console.error('[CLIENT-ERR] could not record a device report:', e.message);
        }
    });

    app.get('/healthz', (req, res) => {
        const problems = [];
        let lastScanAt = null, staleMin = null;
        const uptime = Math.round(process.uptime());

        // index.js sets this. null means api.js is running standalone (tests),
        // where "WhatsApp is down" is not a meaningful thing to report.
        const waReady = typeof global.__jarvisWaReady === 'function' ? global.__jarvisWaReady() : null;
        if (waReady === false) problems.push('whatsapp_disconnected');

        try {
            const store = require('./helpers/json').loadJson(cfg.REPLY_WATCH_FILE, {});
            lastScanAt = store && store.lastScanAt ? store.lastScanAt : null;
            const t = Date.parse(lastScanAt || '');
            if (!isNaN(t)) staleMin = Math.round((Date.now() - t) / 60000);
            // Only after the boot grace: a restart legitimately has no recent
            // scan, and flapping on every deploy is how an alert gets muted.
            if (uptime > HEALTHZ_BOOT_GRACE_S) {
                if (staleMin === null) problems.push('no_scan_recorded');
                else if (staleMin > HEALTHZ_STALE_SCAN_MIN) problems.push(`inbox_scan_stalled_${staleMin}m`);
            }
        } catch (e) {
            // A heartbeat we cannot read is not a healthy heartbeat.
            problems.push('heartbeat_unreadable');
        }

        // ── IS THE YARD DATA STILL BEING COPIED OFF THIS BOX? ─────────────
        // Apsara, 2026-10-02: "Protect the data of edge yard no matter what."
        //
        // The nightly backup emails when it RUNS AND GOES WRONG. It cannot
        // report the worse case: the process is down or the cron never fires,
        // so nothing runs and nothing complains. The outage hides itself, and
        // it hides itself for exactly as long as nobody needs the data.
        //
        // This is the only place outside the box can see it. An external
        // monitor already watches this route for a 503, so backups stopping
        // now rings the same bell as Jarvis stopping — which is right, because
        // a payment ledger that exists on one disk is the bigger of the two
        // risks.
        //
        // NAMES AND COUNTS STAY OFF. This route is public by design (a monitor
        // cannot carry a session cookie), so it says "backup_stale_4d" and
        // never which store is missing. health() returns the names; the email
        // uses them, this does not.
        //
        // NO history means NOT a problem: a fresh install, or the first night
        // after this shipped, is not evidence of a broken backup. An alarm
        // that cries wolf on day one is an alarm that gets muted.
        try {
            const bh = require('./helpers/backupWatch').health();
            // Only after the boot grace, like the scan check above — a
            // restart must not flap this on every deploy.
            if (bh.known && uptime > HEALTHZ_BOOT_GRACE_S) {
                for (const p of bh.problems) problems.push(p);
            }
        } catch (e) {
            problems.push('backup_health_unreadable');
        }

        // WHICH COMMIT IS ANSWERING — see helpers/version.js for why this is
        // on the PUBLIC route. It is the one field that settles "is the fix
        // deployed?" without either of us guessing, and it has to be reachable
        // without a session cookie or it will not be used. A short SHA of a
        // private repo discloses nothing an attacker can act on; the login
        // page on this port already says more.
        const ver = require('./helpers/version').running();

        res.status(problems.length ? 503 : 200).json({
            ok: !problems.length,
            problems,
            version: ver.short,
            version_dirty: ver.dirty,
            booted_at: ver.booted_at,
            whatsapp: waReady,
            last_scan_at: lastScanAt,
            last_scan_age_min: staleMin,
            uptime_s: uptime,
            at: new Date().toISOString(),
        });
    });

    // ── Price list change-detection webhook (Apps Script → here) ─────────────
    // Registered here, BEFORE the session-gate middleware below — public,
    // same tier as /health — because Apps Script's UrlFetchApp can't easily
    // carry the dashboard's session cookie, and asking whoever edits the
    // Apps Script trigger later to correctly set an Authorization header is
    // more failure-prone than a token pasted straight into the trigger's
    // URL or POST body. The actual guard is PRICELIST_WEBHOOK_TOKEN, checked
    // inside the handler — this route does nothing without a matching token.
    // Real bug found + fixed alongside this (2026-08-03): checkForChangesAndNotify()
    // has been silently crash-failing every day via scheduler.js's cron
    // fallback too — see config.js's PRICELIST_SNAPSHOT_FILE comment.
    app.post('/api/pricelist/webhook', async (req, res) => {
        if (!cfg.PRICELIST_WEBHOOK_TOKEN) {
            return res.status(503).json({ error: 'PRICELIST_WEBHOOK_TOKEN not configured on the server — set it in .env first' });
        }
        const got = req.query.token || req.body?.token;
        if (got !== cfg.PRICELIST_WEBHOOK_TOKEN) {
            return res.status(401).json({ error: 'invalid or missing token' });
        }
        try {
            const pricelist = require('./helpers/pricelist');
            const result = await pricelist.checkForChangesAndNotify();
            res.json(result);
        } catch (e) {
            console.error('[API] pricelist webhook failed:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // A public GET /s/:token lived here from 2026-10-21 until the same day:
    // Jarvis serving a claim's supporting documents to a supplier on an
    // expiring link. Apsara settled it differently — "For supoorting doc,i
    // will just directly provide gdrive link" — so she shares in Drive and
    // the claim note prints the link she pastes.
    //
    // REMOVED RATHER THAN LEFT: it was the only route in this application
    // that answered without a session, and an unauthenticated route that
    // nothing calls is the #152 pattern at its worst — a door with no
    // handle on the inside that nobody is watching. helpers/claimShare.js
    // and tests/claim-share.js went with it.

    // Login page — inline HTML so it works before the dashboard static mount
    app.get('/login', (req, res) => {
        res.set('Content-Type', 'text/html').send(LOGIN_HTML);
    });

    app.post('/login', (req, res) => {
        const pw = String(req.body?.password || '');
        const userPw  = cfg.APP_PASSWORD;
        const staffPw  = cfg.STAFF_PASSWORD; // lower-privileged tier — see requireStaffOrAbove below
        const adminPw = cfg.ADMIN_PASSWORD;
        const jarvisPw = cfg.JARVIS_PASSWORD; // top-level profile — see config.js
        if (!userPw) {
            return res.status(500).json({ error: 'APP_PASSWORD not configured on the server' });
        }
        // Constant-time compare against both; admin checked first since it's the
        // more privileged match. Same-length-mismatch short-circuits safely (no
        // length leak) — timingSafeEqual requires equal-length buffers.
        const eq = (a, b) => { const A = Buffer.from(a), B = Buffer.from(b); return A.length === B.length && crypto.timingSafeEqual(A, B); };
        // Checked most-privileged first (admin), then user, then staff last —
        // staff is scoped to the Loads tab only (see requireStaffOrAbove).
        //
        // Jarvis is checked FIRST, above admin, and mints an ADMIN session
        // carrying a super flag rather than a fourth role — see config.js's
        // JARVIS_PASSWORD for why role stays 'admin'.
        //
        // usable() refuses a Jarvis password that equals another tier's. If
        // JARVIS_PASSWORD were set to the same string as ADMIN_PASSWORD, the
        // check order would silently promote every admin login to super and
        // the separation this profile exists for would be gone — with nothing
        // on screen to show it, because an admin session that can suddenly
        // delete paid loads looks exactly like a working admin session. Set to
        // a duplicate, the profile simply does not activate and the server
        // says so in the log at boot.
        const jarvisUsable = !!jarvisPw
            && jarvisPw !== adminPw && jarvisPw !== userPw && jarvisPw !== staffPw;
        let role = null, isSuper = false;
        if (jarvisUsable && eq(pw, jarvisPw))     { role = 'admin'; isSuper = true; }
        else if (adminPw && eq(pw, adminPw))      role = 'admin';
        else if (eq(pw, userPw))                  role = 'user';
        else if (staffPw && eq(pw, staffPw))      role = 'staff';
        if (!role) {
            // ── A FAILED SIGN-IN IS RECORDED, AND NOTHING IS BLOCKED ──────
            // Apsara, asked what should happen after repeated wrong
            // passwords: "nothing as of now." So there is no delay, no
            // lockout, and no way for this to shut her out — which was the
            // risk she was weighing.
            //
            // What it DOES do is say so. Without a line in the log there is
            // no way to tell a fat-fingered password from someone working
            // through a wordlist against a URL that is reachable from
            // anywhere, and "we were being attacked for a fortnight" is not
            // something anyone wants to learn afterwards. Counting is free
            // and refuses nobody.
            //
            // The password is never logged, not even its length.
            const ip = String(req.ip || 'unknown');
            const n = (failedLogins.get(ip) || 0) + 1;
            failedLogins.set(ip, n);
            if (n === 5 || n === 20 || (n > 20 && n % 50 === 0)) {
                console.warn(`[AUTH] ${n} failed sign-ins from ${ip}. Nothing is being blocked — `
                    + 'ask for the throttle if this is not you.');
            }
            return res.status(401).json({ error: 'wrong password' });
        }
        // A success clears the counter, so an ordinary typo never accumulates
        // into a scary-looking number.
        failedLogins.delete(String(req.ip || 'unknown'));

        const sid = issueSession(req.ip, role, { super: isSuper });
        // `Secure` added 2026-09-03. The tunnel is HTTPS, so this changes
        // nothing today — it is what stops the cookie being sent in clear if
        // this is ever reached over plain HTTP, which is exactly the kind of
        // "it was fine until it wasn't" this flag exists for. The mobile app
        // is unaffected: it authenticates with a Bearer token and never uses
        // the cookie at all.
        res.setHeader('Set-Cookie',
            `sid=${sid}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
        // sid is ALSO returned in the JSON body now, not just the cookie —
        // added for the Loads mobile app. Its fetch() calls to this API are
        // cross-origin, and SameSite=Strict cookies are never attached to
        // cross-origin requests (that's the whole point of Strict) — so the
        // app can't rely on the cookie at all. It stores this value instead
        // and sends it back as `Authorization: Bearer <sid>` (see the
        // session-gate middleware below). This is NOT a second auth system —
        // same sessions Map, same TTL, same role — just a second way to
        // carry the same session id. Existing cookie-based browser clients
        // simply ignore this extra field.
        res.json({ ok: true, role, super: isSuper, profile: isSuper ? 'jarvis' : role, sid });
    });

    app.post('/logout', (req, res) => {
        const sid = parseCookie(req.headers.cookie, 'sid');
        if (sid) sessions.delete(sid);
        res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        res.json({ ok: true });
    });

    // ── POST /api/plaid/webhook — PUBLIC, AND THE ONLY THING GUARDING IT
    //    IS A SIGNATURE ──────────────────────────────────────────────────
    // Apsara, 2026-10-08: "i dont want human intervention between jarvis and
    // plaid." The nightly 05:45 pull needs nobody, but it finds out a
    // connection has died up to a day late and only by a figure going
    // stale. This is how Plaid says it within the hour.
    //
    // ── REGISTERED HERE, ABOVE THE SESSION GATE, DELIBERATELY ───────────
    // Plaid cannot log in. Rather than carve a hole in the gate below with
    // a path condition — the kind of exemption that grows a second entry,
    // then a third — the route is simply mounted before it. The exemption
    // is then structural and visible: everything after this line is gated,
    // this one line is not, and you can see which by reading downwards.
    //
    // NOTHING IS TRUSTED UNTIL THE SIGNATURE CHECKS OUT. The body is not
    // read, no sync is started and no mail is sent before
    // plaidWebhook.verify returns ok — see that file for the five steps.
    // Plaid's source IPs are published but deliberately NOT used as a
    // guard: they "are subject to change", and an IP allowlist that silently
    // goes stale is a feed that silently stops.
    app.post('/api/plaid/webhook', async (req, res) => {
        const W = require('./helpers/plaidWebhook');
        const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
        let v;
        try {
            v = await W.verify(raw, req.headers, {
                getKey: (kid) => require('./helpers/plaid').verificationKey(kid),
            });
        } catch (e) { v = { ok: false, why: e.message, transient: true }; }

        if (!v.ok) {
            // ── 403 vs 503, AND WHY THE DIFFERENCE MATTERS ──────────────
            // Plaid retries any non-200 for 24 hours. A FORGERY must not be
            // retried — 403 and it stops. But a genuine webhook we could not
            // verify because the key fetch failed must come back, or a real
            // disconnection notice is lost to a bad minute of network.
            console.warn(`[PLAID] webhook refused: ${v.why}`);
            return res.status(W.statusFor(v.why)).json({ error: 'webhook not verified' });
        }

        // ── ANSWER FIRST, WORK AFTER ────────────────────────────────────
        // Plaid treats no response within 10 seconds as a failed delivery
        // and retries. syncAll pages through a bank and can take longer than
        // that, so the 200 goes now and the work happens on the next tick.
        // Plaid's own guidance: keep the receiver as simple as possible.
        res.json({ ok: true });

        const what = W.classify(req.body || {});
        setImmediate(() => {
            Promise.resolve()
                .then(async () => {
                    if (what.action === 'sync') {
                        // Cursor-based, so a duplicate or out-of-order
                        // webhook re-syncs harmlessly — which is exactly the
                        // idempotence Plaid's best-practice note asks for.
                        const out = await require('./helpers/plaid').syncAll({});
                        console.log(`[PLAID] webhook ${what.code}: +${out.added} ~${out.modified}`);
                        return;
                    }
                    if (what.action === 'hers') {
                        // ── THE ONE HUMAN STEP PLAID'S DESIGN REQUIRES ──
                        // Re-authenticating at the bank happens on the
                        // BANK'S OWN SITE. No API can do it, so this is the
                        // single place her rule cannot be honoured — and the
                        // whole point of the webhook is that she hears about
                        // it in an hour instead of from a stale figure two
                        // days later.
                        console.error(`[PLAID] ${what.code} on item ${what.itemId} — needs re-authentication`);
                        // Stored on the item, so /bank-match shows a Reconnect
                        // button on THAT bank rather than the news living only
                        // in an email.
                        try { await require('./helpers/plaid').markNeedsLogin(what.itemId, what.code); }
                        catch (e) { console.error('[PLAID] could not store the re-auth flag:', e.message); }
                        try {
                            // POSITIONAL — alerts.js:98 is
                            // sendEmailAlert(subject, body). Passing an
                            // object would have mailed "[object Object]"
                            // with no body, and the one alert that exists
                            // to reach her would have arrived meaningless.
                            const alerts = require('./alerts');
                            await alerts.sendEmailAlert(
                                'Jarvis: the bank feed needs you to sign in again',
                                `Plaid says ${what.code}.\n\n${what.why}\n\n`
                                + 'Until it is reconnected the bank feed stops, and the reconciliation '
                                + 'on /bank-match will say so rather than claiming everything agrees.\n\n'
                                + 'Open /bank-match and press Sign in again on that bank. (Not "Connect a bank" — that would '
                                + 'link the same accounts a second time.)');
                        } catch (e) { console.error('[PLAID] could not send the re-auth alert:', e.message); }
                        return;
                    }
                    console.log(`[PLAID] webhook ${what.code} — ${what.why}`);
                })
                .catch((e) => console.error('[PLAID] webhook handling failed:', e.message));
        });
    });

    // ── Session gate on everything else ───────────────────────────────────────
    // Three ways to authenticate:
    //  1) sid cookie (browser session from /login)
    //  2) sid as a Bearer token (the Loads mobile app — see /login's sid in
    //     the JSON response above; same session record as #1, just carried
    //     in a header instead of a cookie since cross-origin requests never
    //     get the SameSite=Strict cookie attached)
    //  3) API_TOKEN bearer header (machine-to-machine, unchanged from before)
    app.use((req, res, next) => {
        const cookieSid = parseCookie(req.headers.cookie, 'sid');
        let session = getSession(cookieSid);

        if (!session && req.headers.authorization) {
            const bearer = req.headers.authorization.replace('Bearer ', '');
            session = getSession(bearer);
        }
        if (session) { req.role = session.role; req.isSuper = !!session.super; return next(); }

        if (cfg.API_TOKEN) {
            const got = (req.headers.authorization || '').replace('Bearer ', '');
            // Admin, NOT super. The machine token is a long-lived shared
            // secret that sits in config on other hosts; handing it the power
            // to erase paid loads would put that power behind the weakest
            // credential in the system. A human types the Jarvis password.
            if (got === cfg.API_TOKEN) { req.role = 'admin'; req.isSuper = false; return next(); }
        }

        // Browser: redirect to /login. API: return 401 JSON.
        const accepts = req.headers.accept || '';
        if (req.path.startsWith('/api/') || !accepts.includes('text/html')) {
            return res.status(401).json({ error: 'unauthorized' });
        }
        return res.redirect('/login');
    });

    // Staff is a deliberately narrow role — Loads tab only, nothing else on
    // the dashboard (bookings, pricing, contacts, WhatsApp admin, etc.).
    // Enforced as a single allowlist here rather than wrapping every
    // existing route individually: lower risk of missing one, and any NEW
    // /api/ route added later is deny-by-default for staff unless it's
    // explicitly added to STAFF_ALLOWED_PATH_PREFIXES. Non-API paths (the
    // dashboard shell HTML/JS/CSS) still load — the SPA's own nav filtering
    // (dashboard/index.html's NAV_ITEMS) hides every tab except Loads for
    // this role; this middleware is the actual server-side boundary, the
    // nav filtering is just UX so staff don't see buttons that would 403.
    // REAL BUG, found 2026-08-15 (Apsara: "still when i type seller name, it
    // is not showing matching contact from address book"): /api/address-book
    // and /api/item-types were both missing from this list. Any staff-role
    // session got a flat 403 on every GET/POST to either — refreshAddress-
    // BookCache/refreshCustomItemTypes swallow that as a "best-effort"
    // failure (empty list, no error shown), so the autocomplete and the
    // growing item-type dropdown looked like they just silently didn't
    // work, with zero indication why. Both are normal parts of the Loads
    // workflow now (seller autocomplete + item-description dropdown live
    // right on the load form), which staff fully own — same reasoning as
    // /api/loads itself already being on this list.
    // /api/verify-admin-password added 2026-08-17: staff are exactly the
    // people who hit the edit-unlock prompt (a locked load is locked for
    // them too), so they must be able to have a typed admin password
    // checked. It only answers yes/no and grants nothing — see the route.
    // '/api/outbound-loads' added 2026-08-24. Recording material LEAVING the
    // yard is yard work, the same as recording it arriving — Apsara, asked
    // directly whether sales should be denied to staff: "no". They already
    // create loads, weigh them and price them; a sale is the same job in the
    // other direction, on the same form.
    // '/api/load-drafts' added 2026-08-28. Staff record loads, so staff must
    // be able to save and resume an unfinished one — a draft they cannot
    // write is a draft that does not exist for the people actually standing
    // at the scale. Carries no financial exposure beyond what '/api/loads'
    // already allows them, since a draft becomes a load through that same
    // endpoint and its same checks.
    // '/api/petty-cash' added 2026-09-02. Staff SEE the balance, they do not
// change it — Apsara, asked directly. This list is path-based and cannot
// distinguish GET from POST, so letting the path through is only half the
// rule; POST and DELETE /api/petty-cash each carry requireAdmin of their own.
// Staff cannot record a cash payment either (/api/payments is absent from this
// list), so the reserve and the thing that draws it down stay behind one door.
// '/api/trucker-bills' added 2026-09-03. Apsara asked for the Trucker tab "for
// everyone", and a haulier's invoice arriving at the gate is yard paperwork of
// the same kind as a load. Note what is NOT here: '/api/payments' is still
// absent, so staff can record what is OWED to a trucker and cannot record that
// it was settled — the same division that already applies to loads, where
// staff weigh and price and admin pays. Letting the path through is only half
// a rule anyway, since this list cannot tell GET from DELETE; the paid-bill
// delete guard lives on the route itself.
const STAFF_ALLOWED_PATH_PREFIXES = ['/api/loads', '/api/load-drafts', '/api/outbound-loads', '/api/vision/read-weight', '/api/vision/check-photo-quality', '/api/me', '/api/address-book', '/api/item-types', '/api/petty-cash', '/api/trucker-bills', '/api/verify-admin-password'];
    app.use((req, res, next) => {
        if (req.role !== 'staff') return next();
        if (!req.path.startsWith('/api/')) return next();
        const allowed = STAFF_ALLOWED_PATH_PREFIXES.some(p => req.path === p || req.path.startsWith(p + '/'));
        if (allowed) return next();
        return res.status(403).json({ error: 'staff access is limited to Loads' });
    });

    // Gate for admin-only routes (WhatsApp QR/reset, Facts panel). Must run
    // after the session middleware above so req.role is already set.
    function requireAdmin(req, res, next) {
        if (req.role === 'admin') return next();
        return res.status(403).json({ error: 'admin access required' });
    }

    // ── THE JARVIS PROFILE, AS A GATE ───────────────────────────────────
    // Apsara, 2026-09-16, on deleting a payment entered by mistake: "give
    // delete partial payment to admin..all types to jarvis profile", and
    // when asked which types: the Edge Metals ledgers too.
    //
    // So the line is drawn by BOOK, not by amount. An admin may remove one
    // payment from a yard load — that is the everyday "I typed the wrong
    // figure" correction. Unwinding a supplier bill payment, a customer
    // receipt, a sale-cost settlement or a metals trucking payment takes the
    // Jarvis profile, because those are Edge Metals' books and a deletion
    // there moves a supplier's running account or a customer's balance.
    //
    // isSuper is the session's `super` flag, set only by the Jarvis password.
    // The machine API_TOKEN path deliberately sets req.isSuper = false, so a
    // script holding the token cannot delete Edge Metals money either — that
    // is intentional, not an oversight: nothing automated should.
    function requireSuper(req, res, next) {
        if (isSuper(req)) return next();
        return res.status(403).json({
            error: 'This is an Edge Metals ledger entry. Sign in with the Jarvis profile to remove it.',
            code: 'JARVIS_PROFILE_REQUIRED',
        });
    }

    // The top-level profile. NOT a middleware on any whole route — every route
    // a Jarvis session can reach, an admin can reach too. What this answers is
    // narrower: may this session walk past a lock that stops everyone else.
    const isSuper = (req) => req.isSuper === true;

    // Who to write into the audit log. The session is the only source — a
    // client-supplied name would let the caller sign someone else's name to a
    // deletion, which is worse than no name at all.
    const actorOf = (req) => (isSuper(req) ? 'jarvis' : (req.role || 'unknown'));

    // @@parts:ctx-start
    const ctx = {};
    ctx.isSuper = isSuper;
    ctx.actorOf = actorOf;
    ctx.requireAdmin = requireAdmin;
    ctx.requireSuper = requireSuper;
    // amountForLoad is a hoisted function declaration (defined later in this
    // file, in the KEEP block below) — safe to reference here before its
    // textual position, same as it was safe for the original single-file
    // createApi() body.
    ctx.amountForLoad = amountForLoad;
    // @@parts:ctx-end
    Object.assign(ctx, require('./routes/core')(app, ctx)); // @@part
    Object.assign(ctx, require('./routes/scans')(app, ctx)); // @@part
    Object.assign(ctx, require('./routes/loads')(app, ctx)); // @@part
    Object.assign(ctx, require('./routes/voice')(app, ctx)); // @@part
    Object.assign(ctx, require('./routes/payments')(app, ctx)); // @@part
    Object.assign(ctx, require('./routes/ledger')(app, ctx)); // @@part
    Object.assign(ctx, require('./routes/money')(app, ctx)); // @@part
    Object.assign(ctx, require('./routes/reports')(app, ctx)); // @@part
    function amountForLoad(loadId, kind) {
        try {
            // A trucker bill is a payable like a load, with its amount on the
            // bill itself. Without this branch it would fall through to
            // loadLoads(), find nothing, and return null — which
            // paymentSummary reads as "no total to settle against", so every
            // trucker bill would report paid_amount_unknown and never show as
            // settled no matter what was paid.
            if (kind === 'trucker') {
                const b = require('./helpers/truckerBills').getBill(loadId);
                return b ? b.amount : null;
            }
            if (kind === 'sale') {
                const { loadOutboundLoads } = require('./helpers/outboundLoads');
                const l = loadOutboundLoads().find((x) => x.id === loadId);
                return l ? l.amount : null;
            }
            // A PURCHASE is the one kind that can carry a trucking deduction,
            // so it is the one branch that asks payableOf rather than reading
            // .amount. The sale and trucker branches above deliberately do
            // not: a trucker bill IS the haulage, and netting haulage out of
            // a sale would be an invention.
            const { loadLoads, payableOf } = require('./helpers/loads');
            const l = loadLoads().find((x) => x.id === loadId);
            return l ? payableOf(l) : null;
        } catch (e) { return null; }
    }

    // ── Load drafts ───────────────────────────────────────────────────────
    // Unfinished loads, per Apsara 2026-08-28 ("draft needs to be saved and
    // can be edited later"). Server-side so a draft survives a closed tab, a
    // flat phone, and being picked up on a different device.
    //
    // largeJson because a draft carries its weight PHOTOS as base64 — a draft
    // that loses those has lost the expensive half of the work. Re-typing a
    // description is quick; re-weighing a truck is not.
    //
    // These deliberately do NOT touch loads.json. A draft is invisible to
    // every report, total, inventory calculation and statement in this file,
    // because it is not in the store any of them read.
    Object.assign(ctx, require('./routes/yard')(app, ctx)); // @@part
    Object.assign(ctx, require('./routes/contacts')(app, ctx)); // @@part
    Object.assign(ctx, require('./routes/documents')(app, ctx)); // @@part
    Object.assign(ctx, require('./routes/invoices')(app, ctx)); // @@part
    Object.assign(ctx, require('./routes/exportRules')(app, ctx)); // @@part
    Object.assign(ctx, require('./routes/admin')(app, ctx)); // @@part
    Object.assign(ctx, require('./routes/pages')(app, ctx)); // @@part

    return app;
}

module.exports = { createApi, decorateBooking, DASH_STAGES };

// ── Login page (inline; no static-file dependency) ──────────────────────────
const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Jarvis — Sign in</title>
<style>
  :root{--steel-950:#0E1116;--steel-900:#151A21;--steel-800:#20272F;--copper:#C7642A;--copper-bright:#E68B45;--border:#2A323C;--paper:#E8EBEE;--muted:#828C99}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--steel-950);color:var(--paper);font-family:-apple-system,'Segoe UI',Roboto,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
  .card{background:linear-gradient(170deg,var(--steel-900),var(--steel-800));border:1px solid var(--border);border-radius:14px;padding:40px 36px;width:100%;max-width:380px;box-shadow:0 20px 60px rgba(0,0,0,.5)}
  .brand{display:flex;align-items:center;gap:12px;margin-bottom:28px}
  .brand-mark{width:38px;height:38px;border-radius:7px;background:var(--steel-950);border:1px solid var(--copper);display:flex;align-items:center;justify-content:center;font-family:'SF Mono',ui-monospace,monospace;font-weight:900;color:var(--copper-bright)}
  .brand-name{font-family:'SF Mono',ui-monospace,monospace;letter-spacing:.14em;font-size:15px;text-transform:uppercase}
  h1{font-size:22px;font-weight:600;margin-bottom:6px}
  p{color:var(--muted);font-size:14px;margin-bottom:24px}
  label{display:block;font-family:'SF Mono',ui-monospace,monospace;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-bottom:8px}
  input{width:100%;padding:12px 14px;background:var(--steel-950);border:1px solid var(--border);border-radius:8px;color:#fff;font-size:15px;font-family:inherit;outline:none;transition:border-color .15s}
  input:focus{border-color:var(--copper)}
  button{width:100%;margin-top:20px;padding:13px;background:var(--copper);border:none;border-radius:8px;color:#fff;font-family:'SF Mono',ui-monospace,monospace;font-size:13px;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;transition:background .15s}
  button:hover{background:var(--copper-bright)}
  button:disabled{opacity:.5;cursor:not-allowed}
  .err{margin-top:14px;padding:10px 12px;background:rgba(179,54,42,.14);border:1px solid rgba(179,54,42,.4);border-radius:6px;color:#E0796C;font-size:13px;display:none}
  .err.on{display:block}
</style>
</head><body>
<div class="card">
  <div class="brand"><div class="brand-mark">J</div><div class="brand-name">Jarvis</div></div>
  <h1>Sign in</h1>
  <p>Internal access only.</p>
  <form id="f">
    <label for="pw">Password</label>
    <input id="pw" type="password" autocomplete="current-password" required autofocus>
    <button id="b" type="submit">Sign in</button>
    <div id="e" class="err">Wrong password.</div>
  </form>
</div>
<script>
document.getElementById('f').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const b = document.getElementById('b'), e = document.getElementById('e');
  e.classList.remove('on'); b.disabled = true; b.textContent = 'Signing in…';
  try {
    const r = await fetch('/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ password: document.getElementById('pw').value }) });
    if (r.ok) { location.href = '/'; return; }
    e.textContent = r.status === 500 ? 'Server not configured.' : 'Wrong password.';
    e.classList.add('on');
  } catch { e.textContent = 'Network error.'; e.classList.add('on'); }
  b.disabled = false; b.textContent = 'Sign in';
});
</script>
</body></html>`;