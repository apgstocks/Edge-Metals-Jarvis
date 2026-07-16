// ── api.js — Express API + static dashboard ──────────────────────────────────
// The dashboard is deliberately dumb: /api/dashboard returns fully decorated
// rows (stage index, risk, deadline, owner, pending text) computed HERE, next
// to the same config the workflow uses. Rename a step in config.js and both
// WhatsApp replies and the dashboard stay in sync.

const express = require('express');
const path    = require('path');
const crypto  = require('crypto');
const { loadBookings, loadWorkflow, loadHistory, loadTruckers, loadSuppliers,
        mutateJson, loadSettings, saveSettings, updateWorkflow, archiveBooking,
        loadFacts, addFact } = require('./helpers/json');
const { daysUntil }   = require('./helpers/time');
const { listAlerts, snoozeAlert, muteBooking } = require('./alerts');
const pricelist = require('./helpers/pricelist');
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
    app.use(express.json({ limit: '2mb' }));

    // ── Public routes (no auth) ───────────────────────────────────────────────
    app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

    // Price-change webhook — hit by the Apps Script trigger bound to the price
    // Sheet on every edit. MUST stay public: Apps Script's UrlFetchApp can't
    // carry the dashboard's session cookie or the API_TOKEN bearer header, so
    // auth here is a shared secret in the query string instead. Same public
    // tier as /health and /login — nothing here mutates bookings/workflow,
    // only reads the Sheet and (maybe) sends WhatsApp messages.
    app.post('/api/pricelist/webhook', async (req, res) => {
        if (!cfg.PRICELIST_WEBHOOK_TOKEN || req.query.token !== cfg.PRICELIST_WEBHOOK_TOKEN) {
            return res.status(401).json({ error: 'invalid token' });
        }
        try {
            const result = await pricelist.checkForChangesAndNotify();
            res.json(result);
        } catch (err) {
            console.error('[API] pricelist webhook failed:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // Login page — inline HTML so it works before the dashboard static mount
    app.get('/login', (req, res) => {
        res.set('Content-Type', 'text/html').send(LOGIN_HTML);
    });

    app.post('/login', (req, res) => {
        const pw = String(req.body?.password || '');
        const userPw  = cfg.APP_PASSWORD;
        const adminPw = cfg.ADMIN_PASSWORD;
        if (!userPw) {
            return res.status(500).json({ error: 'APP_PASSWORD not configured on the server' });
        }
        // Constant-time compare against both; admin checked first since it's the
        // more privileged match. Same-length-mismatch short-circuits safely (no
        // length leak) — timingSafeEqual requires equal-length buffers.
        const eq = (a, b) => { const A = Buffer.from(a), B = Buffer.from(b); return A.length === B.length && crypto.timingSafeEqual(A, B); };
        let role = null;
        if (adminPw && eq(pw, adminPw))      role = 'admin';
        else if (eq(pw, userPw))             role = 'user';
        if (!role) return res.status(401).json({ error: 'wrong password' });

        const sid = issueSession(req.ip, role);
        res.setHeader('Set-Cookie',
            `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
        res.json({ ok: true, role });
    });

    app.post('/logout', (req, res) => {
        const sid = parseCookie(req.headers.cookie, 'sid');
        if (sid) sessions.delete(sid);
        res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        res.json({ ok: true });
    });

    // ── Session gate on everything else ───────────────────────────────────────
    // Two ways to authenticate:
    //  1) sid cookie (browser session from /login)
    //  2) API_TOKEN bearer header (machine-to-machine, unchanged from before)
    app.use((req, res, next) => {
        const sid = parseCookie(req.headers.cookie, 'sid');
        const session = getSession(sid);
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

    // Gate for admin-only routes (WhatsApp QR/reset, Facts panel). Must run
    // after the session middleware above so req.role is already set.
    function requireAdmin(req, res, next) {
        if (req.role === 'admin') return next();
        return res.status(403).json({ error: 'admin access required' });
    }

    app.get('/api/me', (req, res) => res.json({ role: req.role || 'user' }));

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
        res.json({ ok: true, booking_number: bkg });
    });
    app.put('/api/bookings/:bkgNo', async (req, res) => {
        const bkg = req.params.bkgNo.toUpperCase();
        await mutateJson(cfg.BOOKINGS_FILE, {}, (all) => {
            if (!all[bkg]) return all;
            Object.assign(all[bkg], req.body, { booking_number: bkg });
            return all;
        });
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

    // ── Documents: PDF scan + Drive upload ────────────────────────────────────
    // Base64-encoded PDFs inflate ~33% over binary. Booking PDFs run 200KB–2MB,
    // so 10mb is the safe ceiling. Scoped to these two routes only.
    const largeJson = express.json({ limit: '10mb' });

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
    app.put('/api/workflow/:bkgNo', async (req, res) => {
        const step = req.body.step;
        if (step && !cfg.WORKFLOW_STAGES.includes(step)) {
            return res.status(400).json({ error: `invalid step. valid: ${cfg.WORKFLOW_STAGES.join(', ')}` });
        }
        await updateWorkflow(req.params.bkgNo.toUpperCase(), req.body);
        res.json({ ok: true });
    });

    // ── Truckers / suppliers ──────────────────────────────────────────────────
    const contactRoutes = (name, file, loader) => {
        app.get(`/api/${name}`, (req, res) => res.json(loader()));
        app.post(`/api/${name}`, async (req, res) => {
            if (!req.body.name) return res.status(400).json({ error: 'name required' });
            await mutateJson(file, [], (list) => {
                const i = list.findIndex(x => (x.name || '').toLowerCase() === req.body.name.toLowerCase());
                if (i >= 0) list[i] = { ...list[i], ...req.body };
                else list.push(req.body);
                return list;
            });
            res.json({ ok: true });
        });
        app.delete(`/api/${name}/:contactName`, async (req, res) => {
            await mutateJson(file, [], (list) =>
                list.filter(x => (x.name || '').toLowerCase() !== req.params.contactName.toLowerCase()));
            res.json({ ok: true });
        });
    };
    contactRoutes('truckers',  cfg.TRUCKERS_FILE,  loadTruckers);
    contactRoutes('suppliers', cfg.SUPPLIERS_FILE, loadSuppliers);

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

    // ── Price list — recipients + ad hoc send ─────────────────────────────────
    // Recipients live in their own file (helpers/pricelist.js), deliberately
    // separate from truckers.json/suppliers.json — these are buyers/customers,
    // not operational contacts. "standing: true" marks the 3 people who get
    // auto-notified by the webhook/fallback cron on a real price change;
    // non-standing contacts can still be targeted by name via /send.
    app.get('/api/pricelist/contacts', requireAdmin, (req, res) => res.json(pricelist.loadContacts()));

    app.post('/api/pricelist/contacts', requireAdmin, async (req, res) => {
        try {
            await pricelist.addContact(req.body?.name, req.body?.whatsapp, !!req.body?.standing);
            res.json({ ok: true });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    app.delete('/api/pricelist/contacts/:name', requireAdmin, async (req, res) => {
        await pricelist.removeContact(req.params.name);
        res.json({ ok: true });
    });

    // Ad hoc send — "whoever I tell": a saved contact name OR a raw WhatsApp number.
    // Sends ALL cities combined. Kept for backward compat / scripting use.
    app.post('/api/pricelist/send', requireAdmin, async (req, res) => {
        try {
            const result = await pricelist.sendPriceListTo(req.body?.to);
            if (!result.ok && result.reason === 'not_found') {
                return res.status(404).json({ error: `no contact or valid number matching "${req.body?.to}"` });
            }
            res.json(result);
        } catch (err) {
            console.error('[API] pricelist/send failed:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // Single-city send — mirrors the WhatsApp "send price list" flow (which
    // always asks which city before sending). Dashboard passes the city the
    // user picked from a dropdown, so no free-text city parsing needed here.
    app.post('/api/pricelist/send-city', requireAdmin, async (req, res) => {
        const CITIES = ['Los Angeles', 'Houston', 'San Antonio'];
        const city = req.body?.city;
        if (!CITIES.includes(city)) {
            return res.status(400).json({ error: `city must be one of: ${CITIES.join(', ')}` });
        }
        try {
            const result = await pricelist.sendPriceListCityTo(req.body?.to, city, null);
            if (!result.ok && result.reason === 'not_found') {
                return res.status(404).json({ error: `no contact or valid number matching "${req.body?.to}"` });
            }
            res.json(result);
        } catch (err) {
            console.error('[API] pricelist/send-city failed:', err.message);
            res.status(500).json({ error: err.message });
        }
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
        await addFact(text);
        res.json({ ok: true });
    });

    app.delete('/api/facts/:index', requireAdmin, async (req, res) => {
        const idx = parseInt(req.params.index, 10);
        if (!Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: 'invalid index' });
        let removed = false;
        await mutateJson(cfg.FACTS_FILE, [], (facts) => {
            if (idx < facts.length) { facts.splice(idx, 1); removed = true; }
            return facts;
        });
        if (!removed) return res.status(404).json({ error: 'not found' });
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

    // ── Static dashboard ──────────────────────────────────────────────────────
    app.use('/', express.static(path.join(cfg.ROOT, 'dashboard')));

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