// ── api.js — Express API + static dashboard ──────────────────────────────────
// The dashboard is deliberately dumb: /api/dashboard returns fully decorated
// rows (stage index, risk, deadline, owner, pending text) computed HERE, next
// to the same config the workflow uses. Rename a step in config.js and both
// WhatsApp replies and the dashboard stay in sync.

const express = require('express');
const path    = require('path');
const crypto  = require('crypto');
const { loadBookings, loadWorkflow, loadHistory, loadTruckers, loadSuppliers,
        mutateJson, loadSettings, saveSettings, updateWorkflow, archiveBooking } = require('./helpers/json');
const { daysUntil }   = require('./helpers/time');
const { listAlerts, snoozeAlert, muteBooking } = require('./alerts');
const cfg = require('./config');

// ── Session auth (in-memory, single process) ────────────────────────────────
// Keys are random 32-byte hex; issued on /login, checked on every non-public
// route via the sid cookie. Restart wipes sessions — acceptable, users just
// log in again. Real auth (users, roles, hashed passwords) is Pass 3+.
const sessions = new Map(); // sid → { issued: ms, ip }
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

function issueSession(ip) {
    const sid = crypto.randomBytes(32).toString('hex');
    sessions.set(sid, { issued: Date.now(), ip });
    return sid;
}
function validSession(sid) {
    if (!sid) return false;
    const s = sessions.get(sid);
    if (!s) return false;
    if (Date.now() - s.issued > SESSION_TTL_MS) { sessions.delete(sid); return false; }
    return true;
}
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
    not_started        : (b, wf) => ({ pending: b.supplier ? 'Awaiting forward to trucker' : 'Awaiting supplier assignment', owner: 'Edge Metals' }),
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
        ? { pending: wf.pending_note, owner: wf.pending_owner || 'Edge Metals' }
        : (STEP_PENDING[step] || STEP_PENDING.not_started)(b, wf);

    // "Empty Dropped · Scale ticket pending" style sub-branch
    let subBranch = null;
    if (step === 'picked_up')      subBranch = wf.scale_ticket ? 'Scale ticket done' : 'Scale ticket pending';

    return {
        bookingNo    : b.booking_number,
        buyer        : b.buyer || b.consignee || wf.supplier || b.supplier || '—',
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

    // Login page — inline HTML so it works before the dashboard static mount
    app.get('/login', (req, res) => {
        res.set('Content-Type', 'text/html').send(LOGIN_HTML);
    });

    app.post('/login', (req, res) => {
        const pw = String(req.body?.password || '');
        const expected = cfg.APP_PASSWORD;
        if (!expected) {
            return res.status(500).json({ error: 'APP_PASSWORD not configured on the server' });
        }
        // Constant-time compare so a wrong-length guess doesn't leak length via timing
        const a = Buffer.from(pw);
        const b = Buffer.from(expected);
        const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
        if (!ok) return res.status(401).json({ error: 'wrong password' });

        const sid = issueSession(req.ip);
        res.setHeader('Set-Cookie',
            `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
        res.json({ ok: true });
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
        if (validSession(sid)) return next();

        if (cfg.API_TOKEN) {
            const got = (req.headers.authorization || '').replace('Bearer ', '');
            if (got === cfg.API_TOKEN) return next();
        }

        // Browser: redirect to /login. API: return 401 JSON.
        const accepts = req.headers.accept || '';
        if (req.path.startsWith('/api/') || !accepts.includes('text/html')) {
            return res.status(401).json({ error: 'unauthorized' });
        }
        return res.redirect('/login');
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
    app.get('/api/history', (req, res) => res.json(loadHistory()));

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

    // ── Settings ──────────────────────────────────────────────────────────────
    app.get('/api/settings', (req, res) => res.json(loadSettings()));
    app.put('/api/settings', async (req, res) => {
        await saveSettings({ ...loadSettings(), ...req.body });
        res.json({ ok: true });
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