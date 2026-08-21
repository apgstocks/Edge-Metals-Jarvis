// ── api.js — Express API + static dashboard ──────────────────────────────────
// The dashboard is deliberately dumb: /api/dashboard returns fully decorated
// rows (stage index, risk, deadline, owner, pending text) computed HERE, next
// to the same config the workflow uses. Rename a step in config.js and both
// WhatsApp replies and the dashboard stay in sync.

const express = require('express');
const path    = require('path');
const crypto  = require('crypto');
const { loadBookings, loadWorkflow, loadHistory, loadTruckers, loadSuppliers,
        upsertTrucker, deleteTrucker, upsertSupplier, deleteSupplier,
        mutateJson, loadSettings, saveSettings, updateWorkflow, archiveBooking,
        loadFacts, addFact, setFactPinned } = require('./helpers/json');
const { daysUntil }   = require('./helpers/time');
const { listAlerts, snoozeAlert, muteBooking } = require('./alerts');
const cfg = require('./config');

// ── Session auth (in-memory, single process) ────────────────────────────────
// Keys are random 32-byte hex; issued on /login, checked on every non-public
// route via the sid cookie. Restart wipes sessions — acceptable, users just
// log in again. Real auth (users, roles, hashed passwords) is Pass 3+.
const sessions = new Map(); // sid → { issued: ms, ip, role: 'user' | 'admin' }
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

function issueSession(ip, role) {
    const sid = crypto.randomBytes(32).toString('hex');
    sessions.set(sid, { issued: Date.now(), ip, role });
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
    app.use(express.json({ limit: '40mb' }));

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
    app.use((req, res, next) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        if (req.method === 'OPTIONS') return res.sendStatus(204);
        next();
    });

    // ── Public routes (no auth) ───────────────────────────────────────────────
    app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

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

    // Login page — inline HTML so it works before the dashboard static mount
    app.get('/login', (req, res) => {
        res.set('Content-Type', 'text/html').send(LOGIN_HTML);
    });

    app.post('/login', (req, res) => {
        const pw = String(req.body?.password || '');
        const userPw  = cfg.APP_PASSWORD;
        const staffPw  = cfg.STAFF_PASSWORD; // lower-privileged tier — see requireStaffOrAbove below
        const adminPw = cfg.ADMIN_PASSWORD;
        if (!userPw) {
            return res.status(500).json({ error: 'APP_PASSWORD not configured on the server' });
        }
        // Constant-time compare against both; admin checked first since it's the
        // more privileged match. Same-length-mismatch short-circuits safely (no
        // length leak) — timingSafeEqual requires equal-length buffers.
        const eq = (a, b) => { const A = Buffer.from(a), B = Buffer.from(b); return A.length === B.length && crypto.timingSafeEqual(A, B); };
        // Checked most-privileged first (admin), then user, then staff last —
        // staff is scoped to the Loads tab only (see requireStaffOrAbove).
        let role = null;
        if (adminPw && eq(pw, adminPw))      role = 'admin';
        else if (eq(pw, userPw))             role = 'user';
        else if (staffPw && eq(pw, staffPw)) role = 'staff';
        if (!role) return res.status(401).json({ error: 'wrong password' });

        const sid = issueSession(req.ip, role);
        res.setHeader('Set-Cookie',
            `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
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
        res.json({ ok: true, role, sid });
    });

    app.post('/logout', (req, res) => {
        const sid = parseCookie(req.headers.cookie, 'sid');
        if (sid) sessions.delete(sid);
        res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        res.json({ ok: true });
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
        if (session) { req.role = session.role; return next(); }

        if (cfg.API_TOKEN) {
            const got = (req.headers.authorization || '').replace('Bearer ', '');
            if (got === cfg.API_TOKEN) { req.role = 'admin'; return next(); } // trusted machine credential = full access
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
    const STAFF_ALLOWED_PATH_PREFIXES = ['/api/loads', '/api/vision/read-weight', '/api/vision/check-photo-quality', '/api/me', '/api/address-book', '/api/item-types', '/api/verify-admin-password'];
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

    app.get('/api/me', (req, res) => res.json({ role: req.role || 'user' }));

    // ── Health check ────────────────────────────────────────────────────────
    // Per Apsara 2026-08-20. There was previously NO way to answer "is Drive
    // working, is WhatsApp connected, did the sheet sync" without reading pm2
    // logs — which is why several problems (a stale Supabase key, a missing
    // exceljs module, WhatsApp failing) were only discovered when someone
    // noticed missing data days later.
    // Deliberately cheap and read-only: it reports what the process already
    // knows plus a couple of trivial file checks. It does NOT make live API
    // calls to Drive/Gemini — a health endpoint that costs money and latency
    // every time it's polled is one nobody leaves running.
    app.get('/api/health', (req, res) => {
        const out = { ok: true, checks: {}, at: new Date().toISOString() };
        const mark = (name, ok, detail) => { out.checks[name] = { ok, detail: detail || null }; if (!ok) out.ok = false; };
        try {
            mark('drive_keyfile', !!cfg.GDRIVE_KEYFILE && fs.existsSync(cfg.GDRIVE_KEYFILE),
                 cfg.GDRIVE_KEYFILE ? undefined : 'GDRIVE_KEYFILE not set');
            mark('gemini_key', !!cfg.GEMINI_API_KEY, cfg.GEMINI_API_KEY ? undefined : 'GEMINI_API_KEY not set');

            // Sheet sync — its own last-run outcome.
            const sync = require('./helpers/sheetSync').syncStatus();
            mark('sheet_sync', !sync.lastSyncError,
                 sync.lastSyncError ? `${sync.lastSyncError.message} (at ${sync.lastSyncError.at})` : (sync.lastSyncOk ? `last ok ${sync.lastSyncOk}` : 'not run yet this boot'));

            // WhatsApp readiness, if index.js exposed it.
            const waReady = typeof global.__jarvisWaReady === 'function' ? global.__jarvisWaReady() : null;
            if (waReady !== null) mark('whatsapp', !!waReady, waReady ? undefined : 'not connected — scan the QR in Settings');

            // Loads carrying unresolved warnings — the number that actually
            // matters day to day, and the reason this endpoint exists.
            const { loadLoads } = require('./helpers/loads');
            const flagged = loadLoads().filter(l => Array.isArray(l.warnings) && l.warnings.length);
            out.loads_with_warnings = flagged.length;
            out.flagged_load_ids = flagged.slice(0, 20).map(l => l.id);
            mark('load_warnings', flagged.length === 0, flagged.length ? `${flagged.length} load(s) need attention` : undefined);
        } catch (e) {
            out.ok = false;
            out.error = e.message;
        }
        res.json(out);
    });

    // Check an admin password WITHOUT performing any action — added
    // 2026-08-17 after Apsara found that clicking OK on the edit-unlock
    // prompt with an empty box still opened the edit form. The save was
    // (and is) still correctly rejected server-side by PUT /api/loads/:id,
    // but letting someone fill in a whole form before telling them the
    // password was wrong is bad UX and reads like the lock doesn't work.
    // This lets the client verify up front and refuse to open the form at
    // all. Deliberately does NOT create a session or elevate this
    // request's role — it only answers yes/no, so it can't become a
    // privilege-escalation path; the real gate stays where it was.
    // Exposure is equivalent to the already-public /login endpoint, and
    // uses the same constant-time compare.
    app.post('/api/verify-admin-password', (req, res) => {
        const adminPw = cfg.ADMIN_PASSWORD;
        const supplied = String((req.body && req.body.password) || '');
        if (!adminPw) return res.status(403).json({ ok: false, error: 'No admin password is configured on the server.' });
        if (!supplied) return res.status(403).json({ ok: false, error: 'Password is required.' });
        const eq = (a, b) => { const A = Buffer.from(a), B = Buffer.from(b); return A.length === B.length && crypto.timingSafeEqual(A, B); };
        if (!eq(supplied, adminPw)) return res.status(403).json({ ok: false, error: 'Wrong admin password.' });
        res.json({ ok: true });
    });

    // ── Dashboard payload ─────────────────────────────────────────────────────
    app.get('/api/dashboard', (req, res) => {
        const bookings = loadBookings();
        const workflow = loadWorkflow();
        const riskOrder = { high: 0, medium: 1, low: 2, done: 3 };

        const rows = Object.values(bookings)
            .map(b => decorateBooking(b, workflow[b.booking_number] || {}))
            .sort((a, z) => riskOrder[a.risk] - riskOrder[z.risk] || (a.deadlineDays ?? 999) - (z.deadlineDays ?? 999));

        const counts = { high: 0, medium: 0, low: 0, done: 0 };
        rows.forEach(r => counts[r.risk]++);

        res.json({
            generated_at: new Date().toISOString(),
            stages : DASH_STAGES,
            counts,
            alerts : rows.filter(r => r.risk === 'high').map(r => ({
                bookingNo: r.bookingNo, issue: r.pending, deadlineLabel: r.deadlineLabel,
            })),
            bookings: rows,
        });
    });

    // ── Bookings CRUD ─────────────────────────────────────────────────────────
    app.get('/api/bookings', (req, res) => res.json(loadBookings()));
    app.get('/api/bookings/:bkgNo', (req, res) => {
        const b = loadBookings()[req.params.bkgNo.toUpperCase()];
        if (!b) return res.status(404).json({ error: 'not found' });
        res.json({ ...b, workflow: loadWorkflow()[req.params.bkgNo.toUpperCase()] || {} });
    });
    app.post('/api/bookings', async (req, res) => {
        const { booking_number, ...data } = req.body;
        if (!booking_number) return res.status(400).json({ error: 'booking_number required' });
        const bkg = String(booking_number).toUpperCase();
        await mutateJson(cfg.BOOKINGS_FILE, {}, (all) => {
            all[bkg] = { ...(all[bkg] || {}), ...data, booking_number: bkg, created_at: all[bkg]?.created_at || new Date().toISOString() };
            return all;
        });
        await updateWorkflow(bkg, {}); // ensure workflow row exists
        await require('./helpers/bookingTracker').syncBookingToSheet(bkg);
        res.json({ ok: true, booking_number: bkg });
    });
    app.put('/api/bookings/:bkgNo', async (req, res) => {
        const bkg = req.params.bkgNo.toUpperCase();
        await mutateJson(cfg.BOOKINGS_FILE, {}, (all) => {
            if (!all[bkg]) return all;
            Object.assign(all[bkg], req.body, { booking_number: bkg });
            return all;
        });
        await require('./helpers/bookingTracker').syncBookingToSheet(bkg);
        res.json({ ok: true });
    });
    app.post('/api/bookings/:bkgNo/archive', async (req, res) => {
        res.json({ ok: await archiveBooking(req.params.bkgNo.toUpperCase(), 'manual_dashboard') });
    });

    // ── Per-container CRUD (Phase 1 of multi-container refactor) ──────────
    // Update one container's fields. Only whitelisted fields writable.
    app.put('/api/bookings/:bkgNo/containers/:seq', async (req, res) => {
        const bkg = req.params.bkgNo.toUpperCase();
        const seq = parseInt(req.params.seq, 10);
        const allowed = ['size','container_number','supplier','trucker','stage'];
        const patch = {};
        for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
        const { migrate } = require('./helpers/containers');
        const all = loadBookings();
        if (!all[bkg]) return res.status(400).json({ error: 'booking not found' });
        const migrated = migrate(all[bkg]);
        if (!migrated.containers.find(c => c.seq === seq)) {
            return res.status(400).json({ error: `container seq=${seq} not found` });
        }
        await mutateJson(cfg.BOOKINGS_FILE, {}, all2 => {
            if (!all2[bkg]) return all2;
            all2[bkg] = migrate(all2[bkg]);
            const c = all2[bkg].containers.find(x => x.seq === seq);
            if (c) Object.assign(c, patch);
            return all2;
        });
        res.json({ ok: true });
    });

    // Add a container (increment seq)
    app.post('/api/bookings/:bkgNo/containers', async (req, res) => {
        const bkg = req.params.bkgNo.toUpperCase();
        const { migrate } = require('./helpers/containers');
        const all = loadBookings();
        if (!all[bkg]) return res.status(400).json({ error: 'booking not found' });
        await mutateJson(cfg.BOOKINGS_FILE, {}, all2 => {
            if (!all2[bkg]) return all2;
            all2[bkg] = migrate(all2[bkg]);
            const nextSeq = Math.max(0, ...all2[bkg].containers.map(c => c.seq)) + 1;
            all2[bkg].containers.push({
                seq              : nextSeq,
                size             : req.body?.size || all2[bkg].containers[0]?.size || null,
                container_number : req.body?.container_number || null,
                supplier         : req.body?.supplier || null,
                trucker          : req.body?.trucker || null,
                stage            : 'not_started',
                pdf_drive_id     : null,
                pdf_uploaded_at  : null,
            });
            return all2;
        });
        res.json({ ok: true });
    });

    // Delete a container from a booking (must leave at least 1)
    app.delete('/api/bookings/:bkgNo/containers/:seq', async (req, res) => {
        const bkg = req.params.bkgNo.toUpperCase();
        const seq = parseInt(req.params.seq, 10);
        const { migrate } = require('./helpers/containers');
        const all = loadBookings();
        if (!all[bkg]) return res.status(400).json({ error: 'booking not found' });
        const migrated = migrate(all[bkg]);
        if (migrated.containers.length <= 1) {
            return res.status(400).json({ error: 'cannot delete the last container — delete the booking instead' });
        }
        if (!migrated.containers.find(c => c.seq === seq)) {
            return res.status(400).json({ error: `container seq=${seq} not found` });
        }
        await mutateJson(cfg.BOOKINGS_FILE, {}, all2 => {
            if (!all2[bkg]) return all2;
            all2[bkg] = migrate(all2[bkg]);
            all2[bkg].containers = all2[bkg].containers.filter(c => c.seq !== seq);
            return all2;
        });
        res.json({ ok: true });
    });
    // REST alias — same effect as archive. Removes booking from active list and workflow.
    // Also deletes the associated PDF from Drive. If PDF delete fails, we log and continue —
    // the user's intent was "delete booking," and leaving the booking in the list because
    // Drive is temporarily down is worse UX than an orphaned PDF.
    app.delete('/api/bookings/:bkgNo', async (req, res) => {
        const bkgNo = req.params.bkgNo.toUpperCase();
        const archived = await archiveBooking(bkgNo, 'manual_dashboard');
        let pdf = null;
        try {
            const { deletePdfByBooking } = require('./helpers/drive');
            pdf = await deletePdfByBooking(bkgNo);
        } catch (err) {
            console.error(`[API] PDF delete failed for ${bkgNo} (booking still archived):`, err.message);
            pdf = { deleted: false, error: err.message };
        }
        res.json({ ok: archived, pdf });
    });
    app.get('/api/history', (req, res) => res.json(loadHistory()));

    // ── Tasks — persistent queue for delayed follow-ups ────────────────────
    // Web creates tasks like "nudge Dave for scale ticket 1 hour from now".
    // Scheduler fires them at fire_at (with condition check that auto-cancels
    // if the reason resolved before firing — e.g. trucker already sent it).
    app.get('/api/tasks', (req, res) => {
        const tasks = require('./helpers/tasks');
        res.json({ pending: tasks.loadTasks(), history: tasks.loadHistory() });
    });

    app.post('/api/tasks', async (req, res) => {
        try {
            const tasks = require('./helpers/tasks');
            const body = req.body || {};
            // Accept both absolute fire_at and relative delay_minutes (easier from UI)
            let fire_at = body.fire_at;
            if (!fire_at && body.delay_minutes) {
                fire_at = new Date(Date.now() + Number(body.delay_minutes) * 60 * 1000).toISOString();
            }
            const task = await tasks.enqueue({
                type          : body.type          || 'generic_message',
                target_kind   : body.target_kind,
                target_name   : body.target_name   || null,
                target_chat   : body.target_chat   || null,
                bkg_no        : body.bkg_no        || null,
                container_seq : body.container_seq || null,
                message       : body.message,
                fire_at,
                condition     : body.condition     || null,
                created_by    : body.created_by    || 'web',
            });
            res.json({ ok: true, task });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    app.delete('/api/tasks/:id', async (req, res) => {
        try {
            const tasks = require('./helpers/tasks');
            const removed = await tasks.cancel(req.params.id, 'user_cancelled');
            if (!removed) return res.status(404).json({ error: 'task not found' });
            res.json({ ok: true, task: removed });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    // ── Documents: PDF scan + Drive upload, plus Loads' photo uploads ─────────
    // Base64-encoded PDFs inflate ~33% over binary. Booking PDFs run 200KB–2MB,
    // so 10mb covered those two routes fine. Now also used by /api/loads and
    // /api/vision/read-weight — a real production PayloadTooLargeError on
    // 2026-08-11 showed 15mb wasn't actually enough: a load with several
    // items, each carrying its OWN gross + tare photo, sends ALL of those
    // photos in one PUT/POST, not just two. NOTE (updated 2026-08-11): the
    // client-side 1600px downscale this comment used to rely on is GONE —
    // it was measured to break weight OCR (0/3 correct at 1600px vs 3/3 at
    // original resolution) and both clients now send originals at quality
    // 0.95 (see downscaleToBase64 in dashboard/index.html AND the separate
    // bundled copy in mobile-app/www/index.html). So a single photo is now
    // roughly 1.7-2.5MB base64, not 300-800KB — this limit has correspondingly
    // less headroom per item than when it was set. If PayloadTooLargeError
    // reappears, raise THIS limit rather than re-adding a client resolution
    // cap; the cap is the lever proven to break accuracy. 40mb is headroom
    // for a load
    // with a realistic number of items, not a structural fix. If a load
    // ever legitimately needs more than that, the real fix is uploading each
    // item's photos through their own request instead of bundling every
    // photo on the load into one JSON body — flagged here, not implemented,
    // since that changes the save flow and needs sign-off first.
    const largeJson = express.json({ limit: '40mb' });

    // Extract booking fields from an uploaded PDF (multimodal Gemini call)
    app.post('/api/documents/scan', largeJson, async (req, res) => {
        const { pdf_base64 } = req.body || {};
        if (!pdf_base64) return res.status(400).json({ error: 'pdf_base64 required' });

        try {
            const { extractPdfFields } = require('./helpers/gemini');
            const fields = await extractPdfFields(pdf_base64);
            if (!fields) return res.status(422).json({ error: 'could not extract fields from this PDF' });
            res.json({ ok: true, fields });
        } catch (err) {
            console.error('[API] scan failed:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // Verification tab's Zimex sub-tab — Apsara: "build verification .in
    // that create sub tab as zimex". Body: { pdfs: [{name, base64}], year,
    // month }. Extracts HBL/amount records from each uploaded carrier
    // freight PDF (Gemini, same multimodal pattern as /api/documents/scan
    // above) then cross-checks every record against the Invoice sheet's own
    // Freight column — see helpers/invoiceVerify.js for the match/mismatch/
    // not_in_sheet logic and why year/month only scopes the reverse
    // "sheet_only" list. year/month are both optional; omit either to skip
    // that filter.
    app.post('/api/verify/zimex', largeJson, async (req, res) => {
        try {
            const { pdfs = [], year, month } = req.body || {};
            if (!Array.isArray(pdfs) || !pdfs.length) return res.status(400).json({ error: 'No PDFs provided.' });

            const { extractFreightInvoiceRecords } = require('./helpers/gemini');
            const { crossCheckZimexRecords } = require('./helpers/invoiceVerify');

            const extractedPerFile = await Promise.all(pdfs.map(async (pdf) => {
                try {
                    const extracted = await extractFreightInvoiceRecords(pdf.base64);
                    const records = (extracted && extracted.records) || [];
                    return records.map((r) => ({ ...r, source_file: pdf.name || 'unnamed.pdf' }));
                } catch (e) {
                    console.error(`[verify/zimex] extraction failed for ${pdf.name || 'unnamed.pdf'}:`, e.message);
                    // One bad/unreadable PDF in a batch shouldn't fail the whole
                    // run — surface it as its own row instead of losing it silently.
                    return [{ hbl_no: null, amount: null, description: `Extraction failed: ${e.message}`, source_file: pdf.name || 'unnamed.pdf', extraction_failed: true }];
                }
            }));
            const pdfRecords = extractedPerFile.flat();

            const result = await crossCheckZimexRecords(pdfRecords, { year, month });
            res.json(result);
        } catch (e) {
            console.error('[verify/zimex] failed:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/verify/panmetal', largeJson, async (req, res) => {
        try {
            const { pdfs = [] } = req.body || {};
            if (!Array.isArray(pdfs) || !pdfs.length) return res.status(400).json({ error: 'No PDFs provided.' });

            const { extractCommissionDebitNoteRecords } = require('./helpers/gemini');
            const { crossCheckPanMetalRecords } = require('./helpers/invoiceVerify');

            const extractedPerFile = await Promise.all(pdfs.map(async (pdf) => {
                try {
                    const extracted = await extractCommissionDebitNoteRecords(pdf.base64);
                    const records = (extracted && extracted.records) || [];
                    return records.map((r) => ({ ...r, source_file: pdf.name || 'unnamed.pdf' }));
                } catch (e) {
                    console.error(`[verify/panmetal] extraction failed for ${pdf.name || 'unnamed.pdf'}:`, e.message);
                    // One bad/unreadable PDF in a batch shouldn't fail the whole
                    // run — surface it as its own row instead of losing it silently.
                    return [{ order_no: null, commission: null, description: `Extraction failed: ${e.message}`, source_file: pdf.name || 'unnamed.pdf', extraction_failed: true }];
                }
            }));
            const pdfRecords = extractedPerFile.flat();

            const result = await crossCheckPanMetalRecords(pdfRecords);
            res.json(result);
        } catch (e) {
            console.error('[verify/panmetal] failed:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // Upload PDF to Drive and (optionally) attach to a booking record
    app.post('/api/bookings/upload-pdf', largeJson, async (req, res) => {
        const { booking_number, pdf_base64, original_filename } = req.body || {};
        if (!booking_number) return res.status(400).json({ error: 'booking_number required' });
        if (!pdf_base64)     return res.status(400).json({ error: 'pdf_base64 required' });

        const bkg = String(booking_number).toUpperCase();
        try {
            const { uploadPdfToDrive } = require('./helpers/drive');
            const file = await uploadPdfToDrive(bkg, pdf_base64, original_filename);
            // Stamp the booking so the WhatsApp forward path knows a PDF exists
            await mutateJson(cfg.BOOKINGS_FILE, {}, (all) => {
                if (all[bkg]) {
                    all[bkg].pdf_drive_id   = file.id;
                    all[bkg].pdf_uploaded_at = new Date().toISOString();
                }
                return all;
            });
            res.json({ ok: true, file });
        } catch (err) {
            console.error('[API] upload-pdf failed:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── Workflow ──────────────────────────────────────────────────────────────
    app.get('/api/workflow', (req, res) => res.json(loadWorkflow()));

    // ── Yard scale tickets (standalone — not tied to bookings/workflow) ───────
    app.get('/api/scale-tickets', (req, res) => {
        try {
            const { loadScaleTickets } = require('./helpers/scaleTickets');
            res.json(loadScaleTickets());
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.get('/api/scale-tickets/:id', (req, res) => {
        try {
            const { loadScaleTickets } = require('./helpers/scaleTickets');
            const ticket = loadScaleTickets().find(t => t.id === req.params.id);
            if (!ticket) return res.status(404).json({ error: 'not found' });
            res.json(ticket);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ── Vision: read a weight number off a scale-display photo ────────────────
    // Stateless — used by the dashboard's camera-capture buttons on the Add
    // New Load form BEFORE a load exists yet, so it can't be scoped to a
    // load id. largeJson (10mb) because base64 photos inflate ~33% over binary.
    app.post('/api/vision/read-weight', largeJson, async (req, res) => {
        const { image_base64, mime_type, pre_cropped } = req.body || {};
        if (!image_base64) return res.status(400).json({ error: 'image_base64 required' });
        try {
            // pre_cropped: sent by the mobile app's guided scanner (2026-08-17)
            // when the user has already framed the display inside the on-screen
            // box, so the uploaded image IS the display. Lets the pipeline skip
            // its locate stage — see extractWeightFromImage's own comment. An
            // older client that doesn't send this field is simply undefined
            // here and gets the unchanged full-locate behavior.
            const { extractWeightFromImage } = require('./helpers/gemini');
            const result = await extractWeightFromImage(image_base64, mime_type, undefined, { preCropped: !!pre_cropped });
            res.json({ ok: true, ...result });
        } catch (err) {
            console.error('[API] read-weight failed:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── Vision: fast capture-time quality gate (no OCR, no Gemini call) ───────
    // Called by the mobile app immediately after a photo is taken, BEFORE the
    // (slower, more expensive) read-weight call above. Pixel-only, typically
    // under 500ms — see checkPhotoQuality's own comment in helpers/gemini.js
    // for why this exists and how it was validated.
    app.post('/api/vision/check-photo-quality', largeJson, async (req, res) => {
        const { image_base64, mime_type } = req.body || {};
        if (!image_base64) return res.status(400).json({ error: 'image_base64 required' });
        try {
            const { checkPhotoQuality } = require('./helpers/gemini');
            const result = await checkPhotoQuality(image_base64, mime_type);
            res.json({ ok: true, ...result });
        } catch (err) {
            console.error('[API] check-photo-quality failed:', err.message);
            res.json({ ok: true, reason: 'check_failed' }); // fail open — never block a real capture over this endpoint erroring
        }
    });

    // ── Loads (standalone — the dashboard's Add New Load feature) ─────────────
    // Accessible to staff/user/admin (see the staff-allowlist middleware above).
    app.get('/api/loads', (req, res) => {
        try {
            const { loadLoads } = require('./helpers/loads');
            const { PDF_TEMPLATE_VERSION } = require('./helpers/pdf');
            // pdf_stale is computed SERVER-SIDE and sent as a plain boolean so
            // the clients never need to know the current template number — one
            // place owns the version, and a client can't drift out of step
            // with it (which would be its own version-skew bug).
            // A load whose PDF predates versioning has no field at all, so it
            // reads as 0 and is correctly reported stale — those really were
            // built by older code.
            res.json(loadLoads().map(l => ({
                ...l,
                pdf_stale: !!l.pdf_link && (Number(l.pdf_template_version) || 0) < PDF_TEMPLATE_VERSION,
            })));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    // Item-type inventory + per-day rollup — per Apsara 2026-08-15. Computed
    // live on every request from helpers/loads.js's getInventoryReport, not
    // a stored/cached value, so a deleted load is reflected on the very
    // next call with no extra cleanup step. Optional ?from=YYYY-MM-DD and/or
    // ?to=YYYY-MM-DD (inclusive) narrow the range; omitted = all-time.
    // Visible to every role (staff included) — same as the rest of
    // /api/loads/* under STAFF_ALLOWED_PATH_PREFIXES, no extra gate needed.
    app.get('/api/loads/inventory', (req, res) => {
        try {
            const { loadLoads, getInventoryReport } = require('./helpers/loads');
            res.json(getInventoryReport(loadLoads(), { from: req.query.from, to: req.query.to }));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // On-demand Inventory tab export — Apsara 2026-08-15 ("export as
    // excel/pdf" via a "⋮" menu). Same optional from/to as the JSON route
    // above, so the download always matches exactly whatever's on screen.
    // Registered before /api/loads/:id for the same route-ordering reason
    // as /api/loads/inventory itself, even though :id only ever matches a
    // single path segment so "inventory" here couldn't collide anyway.
    function inventoryRangeLabel(from, to) {
        if (from && to) return `${from} to ${to}`;
        if (from) return `From ${from}`;
        if (to) return `Through ${to}`;
        return 'All time';
    }
    app.get('/api/loads/inventory/export.xlsx', async (req, res) => {
        try {
            const { loadLoads, getInventoryReport } = require('./helpers/loads');
            const { filteredInventoryWorkbookBuffer } = require('./helpers/inventoryExcel');
            const report = getInventoryReport(loadLoads(), { from: req.query.from, to: req.query.to });
            const buf = await filteredInventoryWorkbookBuffer(report, inventoryRangeLabel(req.query.from, req.query.to));
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', 'attachment; filename="inventory.xlsx"');
            res.send(Buffer.from(buf));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.get('/api/loads/inventory/export.pdf', async (req, res) => {
        try {
            const { loadLoads, getInventoryReport } = require('./helpers/loads');
            const { generateInventoryExportPdf } = require('./helpers/pdf');
            const report = getInventoryReport(loadLoads(), { from: req.query.from, to: req.query.to });
            const buf = await generateInventoryExportPdf(inventoryRangeLabel(req.query.from, req.query.to), report);
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', 'attachment; filename="inventory.pdf"');
            res.send(buf);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Staff-safe next-load-number floor — Apsara 2026-08-16 wants this in a
    // staff-facing mobile Settings panel too, alongside item description
    // delete. /api/settings itself stays requireAdmin (manager number, team
    // roster, WA groups, email cc/bcc, yard report toggle all live there —
    // none of that is staff's business). Rather than loosen that gate, this
    // is a narrow, single-field endpoint under /api/loads (already on
    // STAFF_ALLOWED_PATH_PREFIXES) that reads/writes ONLY next_load_number —
    // explicitly whitelisted, never spreads req.body into settings, so
    // there's no way to smuggle other settings fields through it.
    app.get('/api/loads/next-number', (req, res) => {
        try { res.json({ next_load_number: loadSettings().next_load_number ?? null }); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.put('/api/loads/next-number', async (req, res) => {
        try {
            const raw = req.body.next_load_number;
            const val = (raw === null || raw === undefined || raw === '') ? null : parseInt(raw, 10);
            if (val !== null && !Number.isFinite(val)) return res.status(400).json({ error: 'next_load_number must be a number' });
            await saveSettings({ ...loadSettings(), next_load_number: val });
            res.json({ ok: true, next_load_number: val });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/loads/:id', (req, res) => {
        try {
            const { getLoad } = require('./helpers/loads');
            const load = getLoad(req.params.id);
            if (!load) return res.status(404).json({ error: 'not found' });
            res.json(load);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    // Creates the load record, then uploads each ITEM's gross/tare photos to
    // Drive if provided — photos are per item now (a load can be several
    // items, each weighed separately), so this uploads up to 2 photos per
    // item instead of 2 total for the whole load. Fails soft per-photo — a
    // Drive outage on one item's photo never blocks the load itself or any
    // other item's photo; that link just stays null and can be retried later.
    app.post('/api/loads', largeJson, async (req, res) => {
        const b = req.body || {};
        try {
            const { addLoad, updateLoad } = require('./helpers/loads');
            const record = await addLoad({
                date: b.date, seller: b.seller, description: b.description,
                seller_address: b.seller_address, seller_phone: b.seller_phone,
                buyer: b.buyer, buyer_address: b.buyer_address,
                items: b.items, weight_unit: b.weight_unit,
                created_by: b.created_by || req.role || 'unknown',
            });

            const { uploadScaleTicketImage } = require('./helpers/drive');
            const items = record.items || [];
            const inputItems = Array.isArray(b.items) ? b.items : [];
            let anyPhotoUploaded = false;
            // Photo failures are collected, not just logged. Still non-fatal —
            // the load saves either way — but the operator is told, instead of
            // discovering days later that a weight has no photo behind it.
            const photoFailures = [];
            await Promise.all(items.map(async (item, i) => {
                const input = inputItems[i] || {};
                const tag = `${record.id}-item${i}`;
                if (input.gross_photo_base64) {
                    try {
                        const f = await uploadScaleTicketImage(`${tag}-gross`, input.gross_photo_base64, input.gross_photo_mime, undefined, record.id);
                        item.gross_photo_drive_id = f.id; item.gross_photo_link = f.webViewLink;
                        anyPhotoUploaded = true;
                    } catch (e) {
                        console.error(`[API] gross photo upload failed for ${tag}:`, e.message);
                        // Recorded on the load, not just logged — see helpers/loadWarnings.js
                        photoFailures.push(`item ${i + 1} gross: ${e.message}`);
                    }
                }
                if (input.tare_photo_base64) {
                    try {
                        const f = await uploadScaleTicketImage(`${tag}-tare`, input.tare_photo_base64, input.tare_photo_mime, undefined, record.id);
                        item.tare_photo_drive_id = f.id; item.tare_photo_link = f.webViewLink;
                        anyPhotoUploaded = true;
                    } catch (e) {
                        console.error(`[API] tare photo upload failed for ${tag}:`, e.message);
                        // Recorded on the load, not just logged — see helpers/loadWarnings.js
                        photoFailures.push(`item ${i + 1} tare: ${e.message}`);
                    }
                }
            }));

            const finalLoads = anyPhotoUploaded ? await updateLoad(record.id, { items }) : null;
            let finalLoad = finalLoads ? finalLoads.find(l => l.id === record.id) : record;
            // Attach/clear the photo warning so the badge reflects THIS save:
            // a retry that succeeds must clear the previous complaint,
            // otherwise the badge becomes permanent and people learn to
            // ignore it.
            {
                const { buildWarning, setLoadWarnings, clearLoadWarnings } = require('./helpers/loadWarnings');
                const withWarn = photoFailures.length
                    ? await setLoadWarnings(record.id, [buildWarning('photo_upload_failed', photoFailures.join('; '))])
                    : await clearLoadWarnings(record.id, 'photo_upload_failed');
                if (withWarn) finalLoad = withWarn;
            }
            // Live sheet sync — per Apsara 2026-08-19. Fire-and-forget by
            // design: a Drive hiccup must never make saving a load fail, and
            // every sync rebuilds from loads.json anyway, so a missed one
            // self-heals on the next change. See helpers/sheetSync.js.
            require('./helpers/sheetSync').scheduleSync([require('./helpers/sheetSync').monthKeyFor(finalLoad && finalLoad.date)]);
            res.json({ ok: true, load: finalLoad });
        } catch (err) {
            // validateLoadForSave (helpers/loads.js) throws a plain Error
            // prefixed "Validation:" for a missing mandatory field — that's a
            // client mistake (400), not a server fault (500), so it's
            // surfaced distinctly here for correct status-code semantics/
            // monitoring, even though both paths return the same shape to
            // the UI, which already displays err.message either way.
            const isValidation = /^Validation:/.test(err.message || '');
            if (!isValidation) console.error('[API] create load failed:', err.message);
            res.status(isValidation ? 400 : 500).json({ error: err.message });
        }
    });
    // Full edit (dashboard's Edit button — date/seller/description/items,
    // including added/removed line items). Mirrors POST /api/loads' photo
    // handling: each item's gross/tare photo is only re-uploaded if the
    // client sent NEW base64 data for it (i.e. the user actually re-captured
    // that item's photo); otherwise editLoad() already carried the item's
    // existing photo link forward untouched, so nothing to do here for it.
    app.put('/api/loads/:id', largeJson, async (req, res) => {
        const b = req.body || {};
        try {
            const { editLoad, getLoad, updateLoad } = require('./helpers/loads');
            const existing = getLoad(req.params.id);
            if (!existing) return res.status(404).json({ error: 'not found' });

            // Edit lock, per Apsara 2026-08-17 ("once pdf generated, edit
            // option should be locked. on clicking edit, it should ask
            // admin password to unlock and edit"). Enforced HERE, not just
            // hidden/disabled client-side — same "real, non-bypassable
            // gate" pattern validateLoadForSave already uses in
            // helpers/loads.js, so a direct API call can't skip it either.
            // Keyed off existing.status (helpers/loadsPdf.js stamps
            // 'pdf_generated' the moment a PDF is produced) rather than a
            // new field — that status already exists and is already
            // surfaced as the "PDF ready" badge in both UIs. cfg.ADMIN_PASSWORD
            // may be unset on some deployments (see /login's same check) —
            // treated as "no admin tier configured," so a locked load can
            // never be unlocked there rather than silently allowing it.
            //
            // NOTE: this block, and the /send-to-seller route below, went
            // missing from api.js once already this session (2026-08-17)
            // between when they were first written and when a later
            // "address book changes" commit landed — that commit's api.js
            // has the renumber fix but not these two, meaning something
            // outside this conversation (a manual edit, another tool, a
            // git checkout) touched this exact file mid-session. If this
            // keeps happening, it's worth checking whether anything else
            // is writing to api.js while I'm mid-edit on it.
            if (existing.status === 'pdf_generated') {
                const adminPw = cfg.ADMIN_PASSWORD;
                const supplied = String(b.admin_password || '');
                const eq = (a, b2) => { const A = Buffer.from(a), B = Buffer.from(b2); return A.length === B.length && crypto.timingSafeEqual(A, B); };
                if (!adminPw || !supplied || !eq(supplied, adminPw)) {
                    return res.status(403).json({ error: 'This load\'s PDF has already been generated. Enter the admin password to unlock editing.', locked: true });
                }
            }

            const record = await editLoad(req.params.id, {
                date: b.date, seller: b.seller, description: b.description,
                seller_address: b.seller_address, seller_phone: b.seller_phone,
                buyer: b.buyer, buyer_address: b.buyer_address,
                items: b.items, weight_unit: b.weight_unit,
            });
            if (!record) return res.status(404).json({ error: 'not found' });

            const { uploadScaleTicketImage } = require('./helpers/drive');
            const items = record.items || [];
            const inputItems = Array.isArray(b.items) ? b.items : [];
            let anyPhotoUploaded = false;
            // Photo failures are collected, not just logged. Still non-fatal —
            // the load saves either way — but the operator is told, instead of
            // discovering days later that a weight has no photo behind it.
            const photoFailures = [];
            await Promise.all(items.map(async (item, i) => {
                const input = inputItems[i] || {};
                const tag = `${record.id}-item${i}`;
                if (input.gross_photo_base64) {
                    try {
                        const f = await uploadScaleTicketImage(`${tag}-gross`, input.gross_photo_base64, input.gross_photo_mime, undefined, record.id);
                        item.gross_photo_drive_id = f.id; item.gross_photo_link = f.webViewLink;
                        anyPhotoUploaded = true;
                    } catch (e) {
                        console.error(`[API] gross photo upload failed for ${tag}:`, e.message);
                        // Recorded on the load, not just logged — see helpers/loadWarnings.js
                        photoFailures.push(`item ${i + 1} gross: ${e.message}`);
                    }
                }
                if (input.tare_photo_base64) {
                    try {
                        const f = await uploadScaleTicketImage(`${tag}-tare`, input.tare_photo_base64, input.tare_photo_mime, undefined, record.id);
                        item.tare_photo_drive_id = f.id; item.tare_photo_link = f.webViewLink;
                        anyPhotoUploaded = true;
                    } catch (e) {
                        console.error(`[API] tare photo upload failed for ${tag}:`, e.message);
                        // Recorded on the load, not just logged — see helpers/loadWarnings.js
                        photoFailures.push(`item ${i + 1} tare: ${e.message}`);
                    }
                }
            }));

            const finalLoads = anyPhotoUploaded ? await updateLoad(record.id, { items }) : null;
            let finalLoad = finalLoads ? finalLoads.find(l => l.id === record.id) : record;
            // Attach/clear the photo warning so the badge reflects THIS save:
            // a retry that succeeds must clear the previous complaint,
            // otherwise the badge becomes permanent and people learn to
            // ignore it.
            {
                const { buildWarning, setLoadWarnings, clearLoadWarnings } = require('./helpers/loadWarnings');
                const withWarn = photoFailures.length
                    ? await setLoadWarnings(record.id, [buildWarning('photo_upload_failed', photoFailures.join('; '))])
                    : await clearLoadWarnings(record.id, 'photo_upload_failed');
                if (withWarn) finalLoad = withWarn;
            }
            // Live sheet sync. Passes BOTH the old and new month: an edit can
            // move a load across months (correcting a date from 08-01 to
            // 07-31), which would otherwise leave July's workbook stale.
            {
                const sheetSync = require('./helpers/sheetSync');
                sheetSync.scheduleSync([sheetSync.monthKeyFor(existing.date), sheetSync.monthKeyFor(finalLoad && finalLoad.date)]);
            }
            res.json({ ok: true, load: finalLoad });
        } catch (err) {
            const isValidation = /^Validation:/.test(err.message || '');
            if (!isValidation) console.error('[API] edit load failed:', err.message);
            res.status(isValidation ? 400 : 500).json({ error: err.message });
        }
    });
    // Deletes the loads.json record only — see helpers/loads.js's deleteLoad
    // for why Drive photos/PDFs are deliberately left alone.
    app.delete('/api/loads/:id', async (req, res) => {
        try {
            const { deleteLoad, getLoad } = require('./helpers/loads');
            // Read the date BEFORE deleting — afterwards the record is gone
            // and there's no way to know which month's workbook to rebuild.
            const doomed = getLoad(req.params.id);
            const doomedMonth = doomed && doomed.date;
            const found = await deleteLoad(req.params.id);
            if (!found) return res.status(404).json({ error: 'not found' });
            // Live sheet sync — this is the "if load deleted, modify
            // accordingly" half of the requirement. Works with no delete
            // handling of its own because every sync rebuilds from current
            // loads.json: the deleted load simply isn't there anymore.
            {
                const sheetSync = require('./helpers/sheetSync');
                sheetSync.scheduleSync([sheetSync.monthKeyFor(doomedMonth)]);
            }
            // Per Apsara 2026-08-15: deleting a load (from mobile or the
            // dashboard — both hit this same route) now also removes its
            // Drive artifacts, not just the JSON record. Gross/tare photos
            // and generated PDFs for a load all live in ONE Drive subfolder
            // (see helpers/drive.js's getOrCreateLoadSubfolder), so trashing
            // that one folder cleans up everything. Trashed, not permanently
            // deleted — recoverable from Drive's Trash for 30 days if this
            // was a mistake. Best-effort AFTER the JSON delete already
            // succeeded: a Drive hiccup must not make the load
            // un-deletable, and the load record itself is already gone by
            // this point regardless of what happens here.
            try {
                const { trashLoadFolder } = require('./helpers/drive');
                await trashLoadFolder(req.params.id);
            } catch (driveErr) {
                console.warn(`[API] Drive cleanup failed for deleted load ${req.params.id}:`, driveErr.message);
            }
            res.json({ ok: true });
        } catch (err) {
            console.error('[API] delete load failed:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── Outbound loads — mirror of /api/loads above, for material SOLD/
    // SHIPPED OUT to a real buyer (Eccomelt or anyone else — general-
    // purpose, see helpers/outboundLoads.js's header). Deliberately NOT on
    // STAFF_ALLOWED_PATH_PREFIXES: unlike the yard scale-weighing workflow
    // (a physical floor task staff already own), a sale record carries
    // buyer pricing — a business-data exposure call Apsara didn't ask for,
    // so this defaults to normal authenticated (manager/team) access only.
    // No photo/Drive/PDF integration (not asked for) — a plain CRUD store.
    app.get('/api/outbound-loads', (req, res) => {
        try {
            const { loadOutboundLoads, getLoadMargin } = require('./helpers/outboundLoads');
            const loads = loadOutboundLoads().map((l) => ({ ...l, ...getLoadMargin(l) }));
            res.json({ loads });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Registered before /api/outbound-loads/:id for the same route-ordering
    // reason as /api/loads/inventory above.
    app.get('/api/outbound-loads/report', (req, res) => {
        try {
            const { loadOutboundLoads, getOutboundReport } = require('./helpers/outboundLoads');
            res.json(getOutboundReport(loadOutboundLoads(), { from: req.query.from, to: req.query.to }));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/outbound-loads/:id', (req, res) => {
        try {
            const { getOutboundLoad, getLoadMargin } = require('./helpers/outboundLoads');
            const load = getOutboundLoad(req.params.id);
            if (!load) return res.status(404).json({ error: 'not found' });
            res.json({ ...load, ...getLoadMargin(load) });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/outbound-loads', async (req, res) => {
        const b = req.body || {};
        try {
            const { addOutboundLoad } = require('./helpers/outboundLoads');
            const record = await addOutboundLoad({
                date: b.date, buyer: b.buyer, buyer_address: b.buyer_address,
                trucker_name: b.trucker_name, quote_request_id: b.quote_request_id, quote_request_kind: b.quote_request_kind,
                linked_inbound_load_ids: b.linked_inbound_load_ids,
                description: b.description, items: b.items, weight_unit: b.weight_unit,
                created_by: b.created_by || req.role || 'unknown',
            });
            res.json({ ok: true, load: record });
        } catch (err) {
            const isValidation = /^Validation:/.test(err.message || '');
            if (!isValidation) console.error('[API] create outbound load failed:', err.message);
            res.status(isValidation ? 400 : 500).json({ error: err.message });
        }
    });

    app.put('/api/outbound-loads/:id', async (req, res) => {
        const b = req.body || {};
        try {
            const { editOutboundLoad } = require('./helpers/outboundLoads');
            const record = await editOutboundLoad(req.params.id, {
                date: b.date, buyer: b.buyer, buyer_address: b.buyer_address,
                trucker_name: b.trucker_name, quote_request_id: b.quote_request_id, quote_request_kind: b.quote_request_kind,
                linked_inbound_load_ids: b.linked_inbound_load_ids,
                description: b.description, items: b.items, weight_unit: b.weight_unit,
            });
            if (!record) return res.status(404).json({ error: 'not found' });
            res.json({ ok: true, load: record });
        } catch (err) {
            const isValidation = /^Validation:/.test(err.message || '');
            if (!isValidation) console.error('[API] edit outbound load failed:', err.message);
            res.status(isValidation ? 400 : 500).json({ error: err.message });
        }
    });

    // Lightweight lookup for the outbound-load form's "link inbound loads"
    // picker — id/date/seller/net/amount only, not the full record (items,
    // photo links, etc.), since all this needs is enough to let Apsara pick
    // which purchase(s) this sale's material came from.
    app.get('/api/loads/lookup', (req, res) => {
        try {
            const { loadLoads } = require('./helpers/loads');
            const q = String(req.query.q || '').trim().toLowerCase();
            const rows = loadLoads()
                .filter((l) => !q || (l.id || '').toLowerCase().includes(q) || (l.seller || '').toLowerCase().includes(q))
                .slice(0, 50)
                .map((l) => ({ id: l.id, date: l.date, seller: l.seller, net_weight: l.net_weight, amount: l.amount, weight_unit: l.weight_unit }));
            res.json({ loads: rows });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.delete('/api/outbound-loads/:id', async (req, res) => {
        try {
            const { deleteOutboundLoad } = require('./helpers/outboundLoads');
            const found = await deleteOutboundLoad(req.params.id);
            if (!found) return res.status(404).json({ error: 'not found' });
            res.json({ ok: true });
        } catch (err) {
            console.error('[API] delete outbound load failed:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── Neo4j graph trace — "show everything connected to X" ────────────────
    // See helpers/graph.js's header. Returns { nodes: [], edges: [] } (never
    // an error) if Neo4j isn't configured or the query fails — an empty
    // graph is a valid, non-error state for a caller to render as "nothing
    // here yet", not something to alert on.
    app.get('/api/graph/trace', requireAdmin, async (req, res) => {
        try {
            const { traceEntity } = require('./helpers/graph');
            const name = String(req.query.entity || '').trim();
            if (!name) return res.status(400).json({ error: 'entity query param required' });
            const result = await traceEntity(name, { depth: parseInt(req.query.depth, 10) || 2 });
            res.json(result);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/graph/status', requireAdmin, async (req, res) => {
        try {
            const { isConfigured, verifyConnectivity } = require('./helpers/graph');
            if (!isConfigured()) return res.json({ configured: false });
            const result = await verifyConnectivity();
            res.json({ configured: true, ...result });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    // Changes a load's id — per Apsara 2026-08-15 ("there should be a way to
    // adjust the load number"). Renames the JSON record first (the part that
    // actually matters — search, PDF regen, the dashboard list all key off
    // this), then best-effort renames the Drive subfolder to match so future
    // uploads/PDF regens keep landing next to the load's EXISTING files
    // instead of splitting into a second, new-named folder. A Drive rename
    // failure here is reported back (unlike delete's cleanup above) since
    // it's directly relevant to whether the rename is fully consistent —
    // the load record change itself still isn't rolled back either way.
    // Admin-only, per Apsara 2026-08-17 ("remove renumber option for
    // staff. this option should be there only for admin"). This route's
    // access has actually flipped THREE times now: staff blocked
    // (2026-08-15), reopened to staff same day, now restricted further
    // still — to admin only, not just "not staff." requireAdmin below
    // blocks staff AND the regular user tier alike; STAFF_ALLOWED_PATH_
    // PREFIXES still lists '/api/loads' broadly (Generate PDF, Edit,
    // Delete, etc. all still need it for staff), so this route needs its
    // OWN explicit gate rather than relying on that prefix list to narrow
    // it — the prefix list is deliberately coarse (whole-tab-level), not
    // built for carving out one sub-route.
    app.put('/api/loads/:id/renumber', requireAdmin, async (req, res) => {
        try {
            const { renumberLoad } = require('./helpers/loads');
            const oldId = req.params.id;
            const newId = String((req.body && req.body.newId) || '').trim();
            const updated = await renumberLoad(oldId, newId);
            let driveWarning = null;
            try {
                const { renameLoadSubfolder } = require('./helpers/drive');
                const result = await renameLoadSubfolder(oldId, newId);
                if (!result.renamed && result.reason === 'error') driveWarning = 'Load renamed, but its Drive folder could not be — new uploads for this load may land in a new folder.';
            } catch (driveErr) {
                driveWarning = 'Load renamed, but its Drive folder could not be — new uploads for this load may land in a new folder.';
                console.warn(`[API] Drive subfolder rename failed for ${oldId} -> ${newId}:`, driveErr.message);
            }
            res.json({ ok: true, load: updated, warning: driveWarning });
        } catch (err) {
            console.error('[API] renumber load failed:', err.message);
            res.status(400).json({ error: err.message });
        }
    });
    // Generates the PDF from the load record as saved (photos referenced as
    // Drive links, not re-embedded — see helpers/pdf.js's comment on why),
    // uploads it to Drive, and stamps the load with the resulting link.
    app.post('/api/loads/:id/generate-pdf', async (req, res) => {
        try {
            const { getLoad } = require('./helpers/loads');
            const load = getLoad(req.params.id);
            if (!load) return res.status(404).json({ error: 'not found' });

            // Shared with scheduler.js's end-of-day yard report — see
            // helpers/loadsPdf.js for why this isn't inlined here anymore.
            // includeSummary: dashboard now confirm()s with the user before
            // calling this route and sends the answer in the body — per
            // Apsara 2026-08-15. Only OFF if explicitly sent false; a missing
            // body (old cached frontend, or scheduler.js's own direct call
            // which never hits this route) keeps the prior always-on default.
            const { generateAndStoreLoadPdfs } = require('./helpers/loadsPdf');
            const includeSummary = !(req.body && req.body.includeSummary === false);
            const updated = await generateAndStoreLoadPdfs(load, { includeSummary });
            res.json({ ok: true, load: updated });
        } catch (err) {
            console.error('[API] generate-pdf failed:', err.message);
            // Record it on the load as well as returning the error — the
            // operator may dismiss the toast, close the app, and only look
            // again tomorrow; the badge is what's still there then.
            try {
                const { buildWarning, setLoadWarnings } = require('./helpers/loadWarnings');
                await setLoadWarnings(req.params.id, [buildWarning('pdf_generate_failed', err.message)]);
            } catch (e) { console.warn('[API] could not record pdf warning:', e.message); }
            res.status(500).json({ error: err.message });
        }
    });
    // NOTE 2026-08-17 (later same day): neither UI calls this route
    // anymore. It goes through whatsapp-web.js's automated session
    // (global.__jarvisSendMessage), which started failing in production
    // with "No LID for user" — an unresolved upstream whatsapp-web.js bug
    // tied to WhatsApp's ongoing LID rollout (multiple open GitHub
    // issues, still unfixed as of Jan 2026), not anything wrong here. Per
    // Apsara ("just use the phone's existing whatsapp to send this"), the
    // Send-to-seller button in both mobile-app/www/index.html and
    // dashboard/index.html now opens a wa.me deep link instead — the
    // user's own WhatsApp app sends it, bypassing this route (and the
    // broken library call) entirely. Left in place, not deleted: harmless
    // dead code for now, and it'd work again immediately if/when the
    // upstream bug gets fixed and someone wants the automated path back.
    //
    // Forward the already-generated PDF to the seller's own WhatsApp, per
    // Apsara 2026-08-17 ("introduce send option once pdf generated so that
    // it can be forwarded to that seller whatsapp automatically"). No
    // requireAdmin gate — same as the rest of /api/loads/*, staff should be
    // able to send a ticket to the seller they just weighed in without
    // needing an admin around. Two hard preconditions, both checked here
    // (not just hidden client-side, same reasoning as the edit-lock above):
    // a PDF must actually exist yet (nothing to send otherwise), and the
    // load needs a seller_phone on file (added this same request — see
    // helpers/loads.js). Re-downloads the PDF bytes from Drive by file id
    // rather than trying to reuse anything from generation time — this
    // route can be clicked any time after generation, not just right after,
    // so there's no in-memory buffer left over from that request to reuse.
    // ── Expenses — admin only ────────────────────────────────────────────────
    // Per Apsara 2026-08-19 ("for admin access in mobile app, i want expense
    // tracker"). requireAdmin on every route, so staff and the regular user
    // tier can't read or write expenses at all — this is company financial
    // data, a genuinely different sensitivity level from yard loads.
    // /api/expenses is deliberately NOT added to STAFF_ALLOWED_PATH_PREFIXES;
    // that allowlist plus requireAdmin here means two independent things
    // would both have to be wrong for a staff session to reach these.
    // Every mutation schedules a sheet sync, same as loads.
    app.get('/api/expenses', requireAdmin, (req, res) => {
        try {
            const { loadExpenses, getExpenseReport, EXPENSE_CATEGORIES } = require('./helpers/expenses');
            const all = loadExpenses();
            res.json({ expenses: all, report: getExpenseReport(all, {}), categories: EXPENSE_CATEGORIES });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.post('/api/expenses', requireAdmin, async (req, res) => {
        const b = req.body || {};
        try {
            const { addExpense } = require('./helpers/expenses');
            const rec = await addExpense({ ...b, created_by: b.created_by || req.role || 'admin' });
            const sheetSync = require('./helpers/sheetSync');
            sheetSync.scheduleSync([sheetSync.monthKeyFor(rec.date)]);
            res.json({ ok: true, expense: rec });
        } catch (err) {
            const isValidation = /^Validation:/.test(err.message || '');
            if (!isValidation) console.error('[API] create expense failed:', err.message);
            res.status(isValidation ? 400 : 500).json({ error: err.message });
        }
    });
    app.put('/api/expenses/:id', requireAdmin, async (req, res) => {
        try {
            const { editExpense, getExpense } = require('./helpers/expenses');
            const existing = getExpense(req.params.id);
            if (!existing) return res.status(404).json({ error: 'not found' });
            const updated = await editExpense(req.params.id, req.body || {});
            if (!updated) return res.status(404).json({ error: 'not found' });
            // Old AND new month — an edit can move an expense across months.
            const sheetSync = require('./helpers/sheetSync');
            sheetSync.scheduleSync([sheetSync.monthKeyFor(existing.date), sheetSync.monthKeyFor(updated.date)]);
            res.json({ ok: true, expense: updated });
        } catch (err) {
            const isValidation = /^Validation:/.test(err.message || '');
            if (!isValidation) console.error('[API] edit expense failed:', err.message);
            res.status(isValidation ? 400 : 500).json({ error: err.message });
        }
    });
    app.delete('/api/expenses/:id', requireAdmin, async (req, res) => {
        try {
            const { deleteExpense } = require('./helpers/expenses');
            // Returns the removed record so we know which month to rebuild —
            // after deletion there's no way to look its date up again.
            const removed = await deleteExpense(req.params.id);
            if (!removed) return res.status(404).json({ error: 'not found' });
            const sheetSync = require('./helpers/sheetSync');
            sheetSync.scheduleSync([sheetSync.monthKeyFor(removed.date)]);
            res.json({ ok: true });
        } catch (err) {
            console.error('[API] delete expense failed:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // Save a seller signature captured on the app's signature pad, then
    // REGENERATE the PDFs so the signature actually appears on them — per
    // Apsara 2026-08-17 ("there should be an option called sign... this
    // should get reflected in yard invoice above Seller signature").
    // Regenerating here rather than making the client do a second call is
    // deliberate: a signature that's saved but not yet on the document is a
    // confusing halfway state, and the whole point is the printed/sent
    // ticket carrying it.
    app.post('/api/loads/:id/signature', largeJson, async (req, res) => {
        try {
            const { getLoad, updateLoad } = require('./helpers/loads');
            const load = getLoad(req.params.id);
            if (!load) return res.status(404).json({ error: 'not found' });
            const sig = String((req.body && req.body.signature) || '');
            // Accept only a PNG data URL — this value gets handed straight to
            // pdfkit's doc.image(), so validating the shape here keeps a
            // malformed/oversized body from becoming a PDF-generation crash
            // further down. Size cap is generous for a signature-pad PNG
            // (they run ~10-40KB) while refusing anything pathological.
            if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(sig)) {
                return res.status(400).json({ error: 'signature must be a PNG data URL' });
            }
            if (sig.length > 2 * 1024 * 1024) {
                return res.status(400).json({ error: 'signature image is too large' });
            }
            await updateLoad(req.params.id, { seller_signature: sig, seller_signed_at: new Date().toISOString() });

            // Re-read so the regeneration sees the signature we just stored.
            const signed = getLoad(req.params.id);
            const { generateAndStoreLoadPdfs } = require('./helpers/loadsPdf');
            const updated = await generateAndStoreLoadPdfs(signed, { includeSummary: req.body.includeSummary !== false });
            res.json({ ok: true, load: updated });
        } catch (err) {
            console.error('[API] save signature failed:', err.message);
            res.status(500).json({ error: err.message });
        }
    });
    app.post('/api/loads/:id/send-to-seller', async (req, res) => {
        try {
            const { getLoad } = require('./helpers/loads');
            const load = getLoad(req.params.id);
            if (!load) return res.status(404).json({ error: 'not found' });
            if (!load.pdf_drive_id) return res.status(400).json({ error: 'Generate the PDF before sending it.' });
            if (!load.seller_phone) return res.status(400).json({ error: 'No phone number on file for this seller — add one via Edit.' });

            const sendMessage = global.__jarvisSendMessage;
            if (!sendMessage) throw new Error('sendMessage bridge not initialised — check index.js exposes it on global');

            const { downloadPdfById } = require('./helpers/drive');
            const base64 = await downloadPdfById(load.pdf_drive_id);
            const chatId = `${load.seller_phone}@c.us`;
            const caption = `${cfg.COMPANY_NAME || 'Edge Trading'} — Load ${load.id} ticket`;
            const sent = await sendMessage(chatId, caption, { mimetype: 'application/pdf', base64, filename: `${load.id}.pdf` });
            if (!sent) return res.status(502).json({ error: 'WhatsApp send failed — is Jarvis connected? Check Settings.' });
            res.json({ ok: true });
        } catch (err) {
            console.error('[API] send-to-seller failed:', err.message);
            res.status(500).json({ error: err.message });
        }
    });
    app.put('/api/workflow/:bkgNo', async (req, res) => {
        const step = req.body.step;
        if (step && !cfg.WORKFLOW_STAGES.includes(step)) {
            return res.status(400).json({ error: `invalid step. valid: ${cfg.WORKFLOW_STAGES.join(', ')}` });
        }
        await updateWorkflow(req.params.bkgNo.toUpperCase(), req.body);
        res.json({ ok: true });
    });

    // ── Truckers / suppliers ──────────────────────────────────────────────────
    const contactRoutes = (name, loader, upsert, del) => {
        app.get(`/api/${name}`, async (req, res) => {
            try { res.json(await loader()); }
            catch (e) { res.status(500).json({ error: e.message }); }
        });
        app.post(`/api/${name}`, async (req, res) => {
            if (!req.body.name) return res.status(400).json({ error: 'name required' });
            try { await upsert(req.body); res.json({ ok: true }); }
            catch (e) { res.status(500).json({ error: e.message }); }
        });
        app.delete(`/api/${name}/:contactName`, async (req, res) => {
            try { await del(req.params.contactName); res.json({ ok: true }); }
            catch (e) { res.status(500).json({ error: e.message }); }
        });
    };
    contactRoutes('truckers',  loadTruckers,  upsertTrucker,  deleteTrucker);
    contactRoutes('suppliers', loadSuppliers, upsertSupplier, deleteSupplier);

    // ── Quote-request contacts (2026-08-16, per Apsara: "separate group/
    // whatsapp/email mimicking trucker implementation") — same factory,
    // same upsert-by-name contract, just backed by helpers/contacts.js's
    // flat JSON store instead of Supabase. See that file's header for why
    // it's not folded into truckers/suppliers.
    const contactsStore = require('./helpers/contacts');
    contactRoutes(
        'contacts',
        async () => contactsStore.loadContacts(),
        (body) => contactsStore.upsertContact(body),
        (name) => contactsStore.deleteContact(name),
    );

    // ── Email contacts (draft_email/reply_email's saved name→address directory) ─
    // Built 2026-08-03 alongside helpers/emailContacts.js — see that file for
    // the resolve/ambiguity logic used by workflow/actions.js. Reuses the
    // exact same contactRoutes() factory as truckers/suppliers above; the
    // factory just needs loader()/upsert(body)/del(name), and doesn't care
    // whether the backing store is Supabase (truckers/suppliers) or a flat
    // JSON file (this one, same pattern as pricelist contacts below).
    const emailContacts = require('./helpers/emailContacts');
    contactRoutes(
        'email-contacts',
        async () => emailContacts.loadContacts(),
        (body) => emailContacts.addContact(body.name, body.email),
        (name) => emailContacts.removeContact(name),
    );

    // ── Price list contacts ──────────────────────────────────────────────────
    // helpers/pricelist.js's loadContacts/addContact/removeContact have
    // existed since that file was written, and dashboard/index.html's
    // "Price list contacts" tab has been calling /api/pricelist/contacts
    // this whole time — but no route for it ever existed here. Confirmed via
    // GitHub audit while building the email-contacts feature above (which
    // shares the same contacts-directory pattern): every button on that
    // dashboard tab (add/remove) has been 404ing in production. Fixed here
    // by wiring it through the same proven contactRoutes() factory —
    // addContact's positional (name, whatsapp, standing) signature just
    // needs a thin wrapper to accept the factory's single req.body arg.
    // NOTE (correction, 2026-08-16): the comment that used to be here claimed
    // /api/pricelist/send-city and /api/pricelist/webhook were both missing.
    // Re-checked while adding WhatsApp-group support below — both already
    // exist elsewhere in this file (webhook near the top of the public
    // routes section, send-city further down, right after quote-requests).
    // That old claim was stale/wrong; corrected here rather than silently
    // dropped so it doesn't get copy-pasted as fact again.
    const pricelist = require('./helpers/pricelist');
    contactRoutes(
        'pricelist/contacts',
        async () => pricelist.loadContacts(),
        (body) => pricelist.addContact(body.name, body.whatsapp, body.standing, body.groupId),
        (name) => pricelist.removeContact(name),
    );

    // ── Address book (supplier/trucker/customer pickup/delivery addresses) ──
    // Built 2026-08-05 alongside helpers/addressBook.js. Read-heavy, no
    // add/delete-by-name UI here on purpose — the Google Doc is the source of
    // truth (see addressBook.js's header comment); the dashboard only reads
    // the synced result and lets Apsara trigger a fresh sync. Full list is
    // returned in one shot (dataset is ~30-100 entries) so the dashboard can
    // do instant client-side typeahead filtering with no per-keystroke
    // network round-trip.
    app.get('/api/address-book', async (req, res) => {
        try { res.json(require('./helpers/addressBook').loadAddressBook()); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.post('/api/address-book/sync', async (req, res) => {
        try { res.json(await require('./helpers/addressBook').syncFromDoc()); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });
    // Manual add/edit/delete — the "Add Contact" button and per-entry Edit
    // button on the address-book page. Separate from the sync path above;
    // see helpers/addressBook.js's own comment on why these key by `id`
    // instead of alias matching.
    app.post('/api/address-book', async (req, res) => {
        try { res.json(await require('./helpers/addressBook').addManualEntry(req.body.aliases, req.body.raw, req.body.locked, req.body.mobile, req.body.tags)); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });
    app.put('/api/address-book/:id', async (req, res) => {
        try {
            const updated = await require('./helpers/addressBook').updateEntryById(req.params.id, req.body);
            if (!updated) return res.status(404).json({ error: 'no address-book entry with that id' });
            res.json(updated);
        } catch (e) { res.status(400).json({ error: e.message }); }
    });
    app.delete('/api/address-book/:id', async (req, res) => {
        try {
            const existed = await require('./helpers/addressBook').deleteEntryById(req.params.id);
            if (!existed) return res.status(404).json({ error: 'no address-book entry with that id' });
            res.json({ ok: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    // WhatsApp verify button on the Address Book page's mobile field
    // (2026-08-16, per Apsara — replaces the earlier per-request WhatsApp
    // chat confirmation). Body: { verified: true|false } — same endpoint
    // handles both verifying and un-verifying (the dashboard toggle can flip
    // it back off if a number turns out to be wrong).
    app.put('/api/address-book/:id/verify-whatsapp', async (req, res) => {
        try {
            const updated = await require('./helpers/addressBook').setMobileVerified(req.params.id, !!req.body.verified);
            if (!updated) return res.status(404).json({ error: 'no address-book entry with that id' });
            res.json(updated);
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ── Documents: Proforma (dc-2) + customer pricing memory ─────────────────
    // Added 2026-08-19 per Apsara: "i want invoice,proforma,verification in
    // separate tabs under documents". This block covers Proforma only —
    // Invoice and Verification are tracked separately, not yet built as of
    // this patch (see SETUP.md). Deliberately NOT added to
    // STAFF_ALLOWED_PATH_PREFIXES above: staff get a flat 403 on all of
    // these, same deny-by-default reasoning as /api/expenses and the rest
    // of what staff shouldn't touch. Both admin and user (Apsara's own
    // staff-facing role — not to be confused with the 'staff' role, which
    // is the more restricted Loads-only one) can generate/save proformas
    // and edit pricing memory; no requireAdmin split within this feature —
    // consistent with "whole site" role decision Apsara already made this
    // pass, and both roles already share every other Operations tab.
    const proformaPricing = require('./helpers/proformaPricing');
    const documentsSaved = require('./helpers/documentsSaved');
    const invoiceVersions = require('./helpers/invoiceVersions');

    // preview=1 (query string) returns the PDF inline without saving a copy
    // or touching pricing memory — used by the "Preview" button so a user
    // can check the layout before committing to a generation. Anything
    // else is a real generation: saves a copy to the flat proforma archive
    // and records/updates customer pricing memory from what was actually
    // typed, wrapped in try/catch per proformaPricing.js's own contract —
    // a pricing-memory failure must never break PDF generation.
    app.post('/api/proforma/generate', async (req, res) => {
        try {
            const body = req.body || {};
            const { generateProformaDc2Pdf } = require('./helpers/proformaPdf');
            const pdf = await generateProformaDc2Pdf(body);

            if (req.query.preview === '1') {
                res.set('Content-Type', 'application/pdf');
                res.set('Content-Disposition', 'inline; filename="proforma-preview.pdf"');
                return res.send(pdf);
            }

            const safeInv = documentsSaved.safeName(body.inv_no || 'PROFORMA').replace(/_+/g, '_');
            const filename = `${safeInv}_${(body.consignee || 'customer').toString().slice(0, 40).replace(/[^A-Za-z0-9_\- ]/g, '')}.pdf`.replace(/\s+/g, '_');
            const savedPath = documentsSaved.saveProformaCopy(pdf, filename);

            try {
                await proformaPricing.recordFromGeneration(
                    body.consignee || '',
                    body.trade_terms || '',
                    body.port_discharge || '',
                    (body.containers || []).flatMap((c) => c.items || []),
                );
            } catch (e) {
                console.error('[proforma] pricing-memory record failed (non-fatal):', e.message);
            }

            // Added per Apsara: "once proforma generated.i want a new sheet
            // called Edge Metals should be generated first time..." — logs
            // this generation into a Google Sheet (see
            // helpers/proformaSheetLog.js for the full column mapping and
            // reasoning). Non-fatal like the pricing-memory record above —
            // a Sheets/Drive hiccup should never block the PDF the person
            // is actually waiting on.
            let sheetLogResult = null;
            try {
                sheetLogResult = await require('./helpers/proformaSheetLog').logProformaToSheet(body);
            } catch (e) {
                console.error('[proforma] Edge Metals sheet log failed (non-fatal):', e.message);
            }

            res.json({ ok: true, saved_filename: path.basename(savedPath), sheet_log: sheetLogResult });
        } catch (e) {
            console.error('[proforma] generate failed:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // Added per Apsara: auto-suggest the next invoice number for a selected
    // consignee, derived from her REAL historical numbers in the Invoice
    // Google Sheet (see helpers/nextInvoiceNo.js for the full reasoning —
    // matching strategy, year-prefix behavior, etc. were confirmed with her
    // directly against live sheet data, not guessed). Returns {} (not a 404)
    // when there's no usable history for that consignee, so the client can
    // fall back to manual entry the same way it always has.
    app.get('/api/proforma/next-inv-no', async (req, res) => {
        try {
            const suggestion = await require('./helpers/nextInvoiceNo').suggestNextInvNo(req.query.consignee || '');
            res.json(suggestion || {});
        } catch (e) {
            console.error('[proforma] next-inv-no lookup failed:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // ── Commercial Invoice ────────────────────────────────────────────────
    // Added per Apsara: "build invoice now.similar to proforma ask me who is
    // the buyer.then follow python anywhere invoice flow" — see
    // helpers/invoiceSheet.js for the sourcing/mapping notes (including the
    // stale-column-index caveat found while building this) and
    // helpers/invoicePdf.js for the PDF itself. Same deny-by-default
    // staff gate as everything else in this Documents block — not added to
    // STAFF_ALLOWED_PATH_PREFIXES.
    const invoiceSheet = require('./helpers/invoiceSheet');

    // Step 1 of the buyer-first flow: every container on record for a buyer,
    // most recent first, so she can pick which shipment to invoice.
    app.get('/api/invoice/by-buyer', async (req, res) => {
        try {
            const containers = await invoiceSheet.findContainersForBuyer(req.query.buyer || '');
            res.json({ containers });
        } catch (e) {
            console.error('[invoice] by-buyer lookup failed:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // Search by container number directly — the ONLY lookup her original
    // PythonAnywhere tool had (invoice_gen.py's --container flag), added
    // back here as a second path alongside the buyer-first flow above, per
    // Apsara: "search by container number". Same summary shape as
    // by-buyer so the Step 2 pick-list renders identically either way.
    app.get('/api/invoice/by-container', async (req, res) => {
        try {
            const containers = await invoiceSheet.findContainersByNumber(req.query.q || '');
            res.json({ containers });
        } catch (e) {
            console.error('[invoice] by-container lookup failed:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // Preview for SEVERAL containers merged into one invoice — used when a
    // multi-select batch on Step 2 has containers sharing a booking #. Per
    // Apsara: "if both containers belong to the same booking, it should get
    // generated in same invoice". See helpers/invoiceSheet.js's
    // buildMultiContainerInvoiceData() for how Container #/Seal # end up
    // per-line-item instead of one shared top-level value.
    app.get('/api/invoice/preview-multi', async (req, res) => {
        try {
            const containers = String(req.query.containers || '').split(',').map((s) => s.trim()).filter(Boolean);
            if (!containers.length) return res.status(400).json({ error: 'No containers specified.' });
            const data = await invoiceSheet.buildMultiContainerInvoiceData(containers);
            if (!data) return res.status(404).json({ error: `None of the containers [${containers.join(', ')}] were found in the Invoice sheet.` });
            res.json(data);
        } catch (e) {
            console.error('[invoice] preview-multi failed:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // Step 2: full computed preview for one chosen container — every field
    // editable client-side before generating, same "never send a real
    // invoice without a human look" principle the old Flask tool's
    // generate.html already used.
    app.get('/api/invoice/preview', async (req, res) => {
        try {
            const data = await invoiceSheet.buildContainerInvoiceData(req.query.container || '');
            if (!data) return res.status(404).json({ error: `Container '${req.query.container}' not found in the Invoice sheet.` });
            res.json(data);
        } catch (e) {
            console.error('[invoice] preview failed:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // Step 3: generate + save the PDF from the (possibly hand-edited)
    // preview data the client sends back. preview=1 returns the PDF inline
    // without archiving a copy, same convention as /api/proforma/generate.
    app.post('/api/invoice/generate', async (req, res) => {
        try {
            const body = req.body || {};
            const { generateInvoiceClassicPdf } = require('./helpers/invoicePdf');
            const pdf = await generateInvoiceClassicPdf(body);

            if (req.query.preview === '1') {
                res.set('Content-Type', 'application/pdf');
                res.set('Content-Disposition', 'inline; filename="invoice-preview.pdf"');
                return res.send(pdf);
            }

            const safeInv = documentsSaved.safeName(body.inv_no || body.container_no || 'INVOICE').replace(/_+/g, '_');
            const filename = `${safeInv}.pdf`;
            const savedPath = documentsSaved.saveInvoiceCopy(pdf, filename, body.container_no || 'UNKNOWN');

            // Save the form-state snapshot that produced this real PDF, so a
            // later visit to the same container can offer "Load previous
            // edits" instead of starting from raw sheet data again. Deliberately
            // does not block the response on failure — losing this convenience
            // history is not worth failing a real invoice generation over.
            try {
                await invoiceVersions.saveInvoiceVersion(body.container_no, body);
            } catch (verErr) {
                console.error('[invoice] saving version history failed (non-fatal):', verErr.message);
            }

            res.json({ ok: true, saved_filename: path.basename(savedPath) });
        } catch (e) {
            console.error('[invoice] generate failed:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // Review & Generate screen's version-history banner — "You last generated
    // this container on [date] — N versions saved". See helpers/invoiceVersions.js
    // for why this is separate from the saved-PDF archive above.
    app.get('/api/invoice/versions', (req, res) => {
        try {
            res.json(invoiceVersions.getInvoiceVersionSummary(req.query.container || ''));
        } catch (e) {
            console.error('[invoice] versions lookup failed:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/customer-pricing/list', (req, res) => {
        try { res.json(proformaPricing.listCustomers()); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.get('/api/customer-pricing/lookup', (req, res) => {
        try { res.json(proformaPricing.lookup(req.query.customer || '')); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.get('/api/customer-pricing/item-rate', (req, res) => {
        try { res.json(proformaPricing.lookupItemRate(req.query.customer || '', req.query.item || '') || {}); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.post('/api/customer-pricing/parse-paste', (req, res) => {
        try { res.json(proformaPricing.parsePastedText((req.body || {}).text || '')); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });
    app.post('/api/customer-pricing/save', async (req, res) => {
        try {
            const body = req.body || {};
            const updated = await proformaPricing.upsert(body.customer || '', {
                tradeTerms: body.trade_terms || '',
                portDischarge: body.port_discharge || '',
                items: body.items || [],
            });
            res.json(updated);
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // Archive listing/download — currently proforma-only (see comment
    // above); the invoice branch is wired for when the Invoice tab lands so
    // this route doesn't need to change shape again later.
    app.get('/api/documents/saved', (req, res) => {
        try {
            res.json({
                invoices: documentsSaved.listSavedInvoices(),
                proformas: documentsSaved.listSavedProformas(),
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.get('/api/documents/download', (req, res) => {
        const target = documentsSaved.resolveSavedPath({
            kind: req.query.kind, filename: req.query.file,
            date: req.query.date, container: req.query.container,
        });
        if (!target) return res.status(404).json({ error: 'file not found' });
        res.sendFile(target);
    });

    // ── Custom item-type descriptions (self-growing "Others…" list) ─────────
    // Per Apsara 2026-08-15. GET returns the flat array of custom entries;
    // the client merges it with its own hardcoded ITEM_DESC_OPTIONS. No
    // staff gate — same "everyone doing loads should see the full list"
    // reasoning as /api/loads/* itself.
    app.get('/api/item-types', (req, res) => {
        try { res.json(require('./helpers/itemTypes').loadCustomItemTypes()); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.post('/api/item-types', async (req, res) => {
        try { res.json(await require('./helpers/itemTypes').addCustomItemType(req.body.description)); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });
    // Delete a wrongly-added "Others…" description (Apsara 2026-08-16). Body,
    // not a :param, since descriptions are free text and can contain slashes.
    // No requireAdmin gate — same reasoning as GET/POST above — but the only
    // UI that calls this lives in the admin-only Settings tab, so in
    // practice only admin ever exercises it.
    app.delete('/api/item-types', async (req, res) => {
        try { res.json(await require('./helpers/itemTypes').deleteCustomItemType(req.body.description)); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ── Quote requests (multi-trucker quote comparison table, 2026-08-05) ────
    // Read-only — every mutation (send/reminder/escalation/reply) happens
    // through the WhatsApp flow (workflow/quoteRequests.js) or the scheduler,
    // never from the dashboard directly. Full list in one shot, same
    // "small dataset, let the client filter" reasoning as address-book above.
    app.get('/api/quote-requests', (req, res) => {
        try { res.json(require('./helpers/quoteRequests').loadQuoteRequests()); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ── Contact quote requests (any saved contact, not just truckers, 2026-08-16) ──
    // Separate tab/table per Apsara ("these are just truckers. i want to have
    // another tab where there is quote request and have whatsapp/email
    // support for quote") — same read-only/dashboard-is-a-viewer reasoning as
    // /api/quote-requests just above; every mutation happens through the
    // WhatsApp flow (workflow/contactQuoteRequests.js) or the scheduler.
    app.get('/api/contact-quote-requests', (req, res) => {
        try { res.json(require('./helpers/contactQuoteRequests').loadContactQuoteRequests()); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Dashboard's "Send" button on the Price list contacts tab. `to` is
    // whatever name/number the row's data-name carries (resolved the same
    // way WhatsApp's own "send price list to X" does — see
    // pricelist.resolveTarget); `fallbackChatId` (3rd arg) is deliberately
    // null here — that branch only applies to a WhatsApp chat that asked
    // with no name given, which can't happen from a dashboard button click.
    app.post('/api/pricelist/send-city', async (req, res) => {
        try {
            const { to, city } = req.body;
            if (!city) return res.status(400).json({ error: 'city required' });
            const result = await pricelist.sendPriceListCityTo(to || null, city, null);
            res.json(result);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ── Alerts ────────────────────────────────────────────────────────────────
    app.get('/api/alerts', (req, res) => res.json(listAlerts()));
    app.post('/api/alerts/snooze', async (req, res) => {
        await snoozeAlert(req.body.type, req.body.bkgNo, req.body.hours || 4);
        res.json({ ok: true });
    });
    app.post('/api/alerts/mute', async (req, res) => {
        await muteBooking(req.body.bkgNo, req.body.on !== false);
        res.json({ ok: true });
    });

    // ── Settings ── admin-only: manager number, team roster, group IDs ─────────
    app.get('/api/settings', requireAdmin, (req, res) => res.json(loadSettings()));
    app.put('/api/settings', requireAdmin, async (req, res) => {
        await saveSettings({ ...loadSettings(), ...req.body });
        res.json({ ok: true });
    });

    // ── WhatsApp status + re-scan ──────────────────────────────────────────────
    // Status is read from a shared in-memory module (helpers/wa-state), which is
    // written by index.js on every WA client event. Poll-friendly.
    app.get('/api/whatsapp/status', requireAdmin, (req, res) => {
        const waState = require('./helpers/wa-state');
        res.json(waState.get());
    });

    // Trigger a re-scan: logs out, wipes session cache, forces new QR.
    // SECURITY NOTE: this is a hijack vector on a public dashboard. Anyone with
    // dashboard access can scan a QR with their OWN phone and take over Jarvis's
    // WhatsApp identity. Change APP_PASSWORD to something strong before exposing.
    app.post('/api/whatsapp/reset', requireAdmin, async (req, res) => {
        try {
            const waState = require('./helpers/wa-state');
            await waState.triggerLogout();
            res.json({ ok: true });
        } catch (err) {
            console.error('[API] whatsapp/reset failed:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // Find groups by name (used by the Settings tab to help pick a team_group_id).
    // Only returns groups Jarvis is a member of — you cannot validate a group
    // Jarvis hasn't been added to yet. Prerequisite: user adds Jarvis to the
    // group on their phone BEFORE clicking Validate here.
    app.post('/api/whatsapp/find-groups', requireAdmin, async (req, res) => {
        try {
            const waState = require('./helpers/wa-state');
            const groups = await waState.findGroups(req.body?.name || '');
            res.json({ ok: true, groups });
        } catch (err) {
            console.error('[API] whatsapp/find-groups failed:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // Verify a phone number has WhatsApp. Returns { registered, contactId, formatted }.
    // Rate-limit vector on public dashboards: someone could enumerate valid WhatsApp
    // numbers. Currently gated by APP_PASSWORD (set to a strong value before VM).
    app.post('/api/whatsapp/verify-number', requireAdmin, async (req, res) => {
        try {
            const waState = require('./helpers/wa-state');
            const result = await waState.verifyNumber(req.body?.number || '');
            res.json({ ok: true, ...result });
        } catch (err) {
            console.error('[API] whatsapp/verify-number failed:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // List groups this contact shares with Jarvis. WhatsApp privacy: we cannot see
    // groups the contact is in that Jarvis isn't. If empty, Jarvis + contact are
    // not in any common group yet — user must add Jarvis to the target group first.
    app.post('/api/whatsapp/common-groups', requireAdmin, async (req, res) => {
        try {
            const waState = require('./helpers/wa-state');
            const groups = await waState.findCommonGroups(req.body?.contactId || '');
            res.json({ ok: true, groups });
        } catch (err) {
            console.error('[API] whatsapp/common-groups failed:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // Identify a group by SENDING into it, not by reading its metadata —
    // reading (getChatById/getChats) is broken by a known whatsapp-web.js
    // library bug (see the debugging thread this came from), but sending has
    // worked reliably all along. This lets the person actually SEE which
    // real group an opaque ID corresponds to, on their own phone, instead of
    // being handed a useless raw ID with no way to match it to anything.
    app.post('/api/whatsapp/test-group-message', requireAdmin, async (req, res) => {
        const { groupId, label } = req.body || {};
        if (!groupId) return res.status(400).json({ error: 'groupId required' });
        try {
            const sendMessage = global.__jarvisSendMessage;
            if (!sendMessage) throw new Error('sendMessage bridge not initialised — check index.js exposes it on global');
            const text = `🔍 Jarvis test message — this confirms this is the group for "${label || 'the contact you are adding'}". No action needed.`;
            await sendMessage(groupId, text);
            res.json({ ok: true });
        } catch (err) {
            console.error('[API] whatsapp/test-group-message failed:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── Facts admin panel — admin-only. Facts are the durable "self-learning"
    // store: explicit "remember X" commands and AI-detected corrections land
    // here (see workflow/actions.js rememberFact), and every one is fed into
    // every future Gemini prompt. Never exposed to non-admin dashboard users —
    // this is operational/business memory, not something every viewer needs.
    app.get('/api/facts', requireAdmin, (req, res) => {
        res.json({ facts: loadFacts() });
    });

    app.post('/api/facts', requireAdmin, async (req, res) => {
        const text = String(req.body?.text || '').trim();
        if (!text) return res.status(400).json({ error: 'text required' });
        await addFact(text, !!req.body?.pinned);
        res.json({ ok: true });
    });

    // Pin/unpin an existing fact — see helpers/json.js's addFact header for
    // why this exists: unpinned facts fall out of every AI prompt once 15
    // newer facts exist, even though they're still stored. Pinning exempts
    // a fact from that window so a standing rule Apsara wants reinforced
    // (e.g. a routing/CC rule) is guaranteed to always be read, not just
    // usually read.
    app.patch('/api/facts/:index', requireAdmin, async (req, res) => {
        const idx = parseInt(req.params.index, 10);
        if (!Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: 'invalid index' });
        const ok = await setFactPinned(idx, !!req.body?.pinned);
        if (!ok) return res.status(404).json({ error: 'not found' });
        res.json({ ok: true });
    });

    app.delete('/api/facts/:index', requireAdmin, async (req, res) => {
        const idx = parseInt(req.params.index, 10);
        if (!Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: 'invalid index' });
        let removed = false;
        let removedText = null;
        await mutateJson(cfg.FACTS_FILE, [], (facts) => {
            if (idx < facts.length) { removedText = facts[idx].text; facts.splice(idx, 1); removed = true; }
            return facts;
        });
        if (!removed) return res.status(404).json({ error: 'not found' });
        // Keep the graph node (if Neo4j is configured) in sync with a
        // dashboard delete — see helpers/graph.js's header. Fire-and-forget,
        // non-fatal: the fact is already gone from facts.json regardless of
        // whether this succeeds.
        if (removedText) {
            require('./helpers/graph').deleteFactNode(removedText)
                .catch((e) => console.error('[API] fact graph delete failed (non-fatal):', e.message));
        }
        res.json({ ok: true });
    });

    // ── Bot command surface — mimic WhatsApp interactions from the web ─────
    // Injects manager identity into a fake inbound message, runs the same
    // brain.process() pipeline, and captures whatever the bot would have sent
    // TO THE MANAGER via a per-request AsyncLocalStorage. Sends to truckers/
    // suppliers/team groups still fire on WhatsApp for real — per user's
    // "Real fire" choice.
    app.post('/api/bot/command', async (req, res) => {
        const text = String(req.body?.text || '').trim();
        if (!text) return res.status(400).json({ error: 'text required' });
        try {
            const brain = require('./workflow/brain');
            const { sendCapture } = require('./helpers/wa-state');
            const settings = cfg.getSettings();
            const managerNum = settings.manager_number || cfg.MANAGER_NUMBER;
            if (!managerNum) return res.status(400).json({ error: 'MANAGER_NUMBER not configured' });
            const chatId = managerNum + '@c.us';
            const inbound = {
                chatId,
                senderNumber: chatId,
                senderName  : 'Web',
                text,
                hasMedia    : false,
                _source     : 'web',
            };
            // brain.process needs a sendMessage function. In the WhatsApp path,
            // index.js passes its own sendMessage. Here we need the same one so
            // sendCapture (in AsyncLocalStorage) intercepts correctly. Lazy-
            // require to avoid circular boot (api.js loaded from index.js).
            let realSendMessage;
            try {
                realSendMessage = global.__jarvisSendMessage;
                if (!realSendMessage) throw new Error('sendMessage bridge not initialised — check index.js exposes it on global');
            } catch (e) {
                return res.status(500).json({ error: e.message });
            }
            const capture = { replies: [] };
            await sendCapture.run(capture, async () => {
                await brain.process(inbound, realSendMessage);
            });
            res.json({ ok: true, replies: capture.replies });
        } catch (err) {
            console.error('[API] bot/command failed:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // Address book — standalone page, not part of index.html's SPA tab
    // system (explicit request 2026-08-05). Registered before the static
    // mount below so the route is unambiguous; inherits the same session/
    // API_TOKEN gate as everything else (that middleware runs earlier, at
    // the top of this file) even though express.static would technically
    // have served dashboard/address-book.html anyway once mounted.
    app.get('/address-book', (req, res) => {
        res.sendFile(path.join(cfg.ROOT, 'dashboard', 'address-book.html'));
    });

    // Quote requests comparison table — same standalone-page pattern as
    // address-book above, registered before the static mount for the same reason.
    app.get('/quote-requests', (req, res) => {
        res.sendFile(path.join(cfg.ROOT, 'dashboard', 'quote-requests.html'));
    });

    // Outbound loads (sales to buyers) — same standalone-page pattern as
    // address-book/quote-requests above. See helpers/outboundLoads.js.
    app.get('/outbound-loads', (req, res) => {
        res.sendFile(path.join(cfg.ROOT, 'dashboard', 'outbound-loads.html'));
    });

    // Documents (Invoice / Proforma / Verification) — same standalone-page
    // pattern as address-book/quote-requests/outbound-loads above. Proforma
    // subtab is fully wired (see dashboard/documents.html); Invoice and
    // Verification subtabs are still placeholders as of this patch.
    app.get('/documents', (req, res) => {
        res.sendFile(path.join(cfg.ROOT, 'dashboard', 'documents.html'));
    });

    // Old standalone Contact Quotes page — MERGED into /quote-requests
    // 2026-08-16 per Apsara ("Contact Quotes and Quote Requests... both are
    // same"). dashboard/contact-quote-requests.html still exists on disk
    // (unreferenced from nav) but this route now redirects any stale
    // bookmark/link straight to the merged page instead of serving it.
    app.get('/contact-quote-requests', (req, res) => {
        res.redirect(301, '/quote-requests');
    });

    // ── Static dashboard ──────────────────────────────────────────────────────
    // no-cache on .html specifically — added 2026-08-15 after a real support
    // case: two rounds of PDF fixes landed in dashboard/index.html, both
    // pushed and pulled onto the VM, and Apsara still saw old button
    // behavior in her browser. express.static's default sends NO
    // Cache-Control header at all, which leaves each browser free to use its
    // own heuristic freshness lifetime for static-looking files — exactly
    // the kind of silent staleness that looks identical to "the deploy
    // didn't happen" from the user's side but isn't fixable by anything on
    // the server. Forcing revalidation on every load costs nothing (this
    // dashboard is a handful of KB, not a CDN-scale asset) and removes an
    // entire class of "I pulled the fix, why don't I see it" confusion.
    // Icons/manifest are left on express.static's default — they're inert
    // once generated and don't carry this risk.
    app.use('/', express.static(path.join(cfg.ROOT, 'dashboard'), {
        setHeaders: (res, filePath) => {
            if (filePath.endsWith('.html')) {
                res.setHeader('Cache-Control', 'no-cache, must-revalidate');
            }
        },
    }));

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