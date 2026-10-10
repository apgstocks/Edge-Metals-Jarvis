// routes/core.js — split from api.js (helpers/sourceParts.js reconstructs the original)
const cfg = require('../config');
const crypto = require('crypto');
const fs = require('fs');
const { loadBookings, loadHistory, loadWorkflow, mutateJson, updateWorkflow, archiveBooking } = require('../helpers/json');
const { decorateBooking, DASH_STAGES } = require('../api');

module.exports = function (app, ctx) {
    const { isSuper, requireAdmin } = ctx;
// @@chunk-start
    app.get('/api/me', (req, res) => res.json({
        role: req.role || 'user',
        // Both clients read `super` to decide whether to show the lifted
        // buttons. That is UX only — every one of those buttons hits a route
        // that checks the session flag again, so a client that lies about this
        // gets a 403, not a deletion.
        super: isSuper(req),
        profile: isSuper(req) ? 'jarvis' : (req.role || 'user'),
    }));

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
    // ── WHAT JARVIS COULD NOT ANSWER ────────────────────────────────────
    // The reviewable list from the AI-first review: every ledger/mail question
    // with what it did. Admin-only — it is her questions and the queries they
    // produced, which is business detail, not a health signal.
    app.get('/api/ask-log', requireAdmin, (req, res) => {
        try {
            const askLog = require('./helpers/data/askLog');
            const since = String(req.query.since || '').trim() || null;
            res.json({
                summary: askLog.summary({ since }),
                recent: askLog.recent(Number(req.query.limit) || 50),
            });
        } catch (e) {
            console.error('[API] ask-log failed:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // ── BUGZILLA ────────────────────────────────────────────────────────
    // Apsara, 2026-09-24: "keep track of all the fixes so that we can revisit
    // it". Any logged-in person can file one and read the list — a bug staff
    // cannot report is a bug nobody hears about. Changing an item's STATUS is
    // admin, because "verified" is her saying she saw it work.
    app.get('/api/bugs', (req, res) => {
        try {
            const bugs = require('./helpers/bugs');
            res.json({
                bugs: bugs.filter({ status: req.query.status || null, area: req.query.area || null,
                    source: req.query.source || null, q: req.query.q || null }),
                summary: bugs.summary(),
                areas: bugs.AREAS, statuses: bugs.STATUSES, severities: bugs.SEVERITIES,
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/bugs', async (req, res) => {
        try {
            const bugs = require('./helpers/bugs');
            const b = req.body || {};
            const row = await bugs.fileBug({
                title: b.title, detail: b.detail, area: b.area, severity: b.severity,
                source: b.source === 'jarvis' ? 'jarvis' : 'her',
                reporter: b.reporter || req.role || null,
            });
            res.json({ ok: true, bug: row });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.patch('/api/bugs/:id', requireAdmin, async (req, res) => {
        try {
            const bugs = require('./helpers/bugs');
            const row = await bugs.update(req.params.id, req.body || {}, req.role || 'admin');
            res.json({ ok: true, bug: row });
        } catch (e) { res.status(/no bug/.test(e.message) ? 404 : 400).json({ error: e.message }); }
    });

    app.get('/api/health', (req, res) => {
        const out = { ok: true, checks: {}, at: new Date().toISOString(),
                      version: require('./helpers/version').running() };
        const mark = (name, ok, detail) => { out.checks[name] = { ok, detail: detail || null }; if (!ok) out.ok = false; };
        try {
            mark('drive_keyfile', !!cfg.GDRIVE_KEYFILE && fs.existsSync(cfg.GDRIVE_KEYFILE),
                 cfg.GDRIVE_KEYFILE ? undefined : 'GDRIVE_KEYFILE not set');
            mark('gemini_key', !!cfg.GEMINI_API_KEY, cfg.GEMINI_API_KEY ? undefined : 'GEMINI_API_KEY not set');

            // ── CAN JARVIS ANSWER A LEDGER QUESTION ON THIS BOX ──────────
            // The ledger questions (2026-09-23) run SQL through node:sqlite
            // (Node 22+) or, failing that, the python3 bridge. "none" means
            // every "how much do we owe" would fail, and this is where to see
            // that after a deploy rather than hearing it from her.
            //
            // Deliberately NOT on /healthz: that endpoint is public and its
            // key list is argued for one addition at a time in
            // tests/api-health.js. Which SQL library a private box has is a
            // detail an uptime monitor does not need.
            const sqlEngine = require('./helpers/data/sqlEngine').engineName();
            mark('ledger_sql', sqlEngine !== 'none',
                 sqlEngine === 'none' ? 'no node:sqlite and no python3 — ledger questions cannot run' : sqlEngine);

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
        const jarvisPw = cfg.JARVIS_PASSWORD;
        const supplied = String((req.body && req.body.password) || '');
        if (!adminPw) return res.status(403).json({ ok: false, error: 'No admin password is configured on the server.' });
        if (!supplied) return res.status(403).json({ ok: false, error: 'Password is required.' });
        const eq = (a, b) => { const A = Buffer.from(a), B = Buffer.from(b); return A.length === B.length && crypto.timingSafeEqual(A, B); };
        // The Jarvis password satisfies this prompt too, added 2026-09-03 —
        // "in addition to admin privileges" means the top-level profile cannot
        // be the one credential that fails at the edit-unlock box.
        //
        // BOTH comparisons run before either result is used, so the response
        // time does not reveal which password was tried. Written the long way
        // for that reason; `||` would short-circuit and leak it.
        const okAdmin  = eq(supplied, adminPw);
        const okJarvis = !!jarvisPw && eq(supplied, jarvisPw);
        if (!okAdmin && !okJarvis) return res.status(403).json({ ok: false, error: 'Wrong admin password.' });
        // The route still grants nothing — it answers yes/no and the client
        // unlocks a form. `super` is reported so the client can label what it
        // unlocked with, NOT so it can decide what it is allowed to do; that
        // is decided by the session on every write, and a typed password does
        // not change the session.
        res.json({ ok: true, super: okJarvis });
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
// @@chunk-end

};
