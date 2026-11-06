// ── helpers/pickupRoutes.js — the way a pickup gets into Jarvis ──────────
// Apsara, 2026-11-06, asked how a pickup should reach Jarvis, chose BOTH
// "Jarvis arranges it" and "I record it". These routes are the second half;
// the Follow-up Agent does not care which made the row.
//
// Mounted from routes/pages.js with one line, the same shape as
// helpers/claims/routes.js, so api.js keeps its shape.
//
// ── ACCESS ───────────────────────────────────────────────────────────────
// The session gate already covers everything here. Deliberately NOT added to
// the staff-allowed prefixes: a pickup carries a carrier's direct contact
// details and causes mail to go out in Edge's name, which is a narrower
// thing than the Loads screen staff are scoped to.
const pickups = require('./pickups');
const pickupAgent = require('./pickupAgent');

const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const str = (v) => String(v == null ? '' : v).trim();

function mount(app, cfg) {
    // ── LIST ─────────────────────────────────────────────────────────────
    // Every row carries what the agent WOULD do right now and why. That is
    // the whole answer to "is this being watched?", which is the question
    // she actually asked, and it means the screen can never disagree with
    // the agent — both read the same function.
    app.get('/api/pickups', (req, res) => {
        try {
            const q = req.query || {};
            let rows = pickups.list();
            if (str(q.status)) rows = rows.filter((p) => p.status === str(q.status));
            if (str(q.open) === '1') rows = rows.filter((p) => p.status === 'arranged' && !str(p.eta));

            const now = new Date();
            rows = rows.map((p) => {
                const next = pickupAgent.nextAction(p, now);
                const ch = pickupAgent.channelsFor(p);
                return Object.assign({}, p, {
                    next_step: next.step,
                    next_why: next.why,
                    // Said out loud rather than left for her to notice: a
                    // pickup nobody can be asked about is the silent gap
                    // this feature exists to close.
                    reachable: ch.reachable,
                    unreachable_why: ch.reachable ? null : ch.why,
                });
            });
            // Soonest first — a pickup today matters more than one next week.
            rows.sort((a, b) => str(a.pickup_date).localeCompare(str(b.pickup_date)));
            res.json({ pickups: rows, count: rows.length });
        } catch (e) { bad(res, e.message, 500); }
    });

    // ── RECORD ONE ───────────────────────────────────────────────────────
    // company and pickup_date are required by the store, which refuses with
    // a sentence rather than a validator code. Everything else is optional
    // and its absence is reported on the row above — refusing a pickup at
    // the door for a missing phone number would leave it unwatched
    // entirely, which is worse than one chased by email alone.
    app.post('/api/pickups', async (req, res) => {
        try {
            const b = req.body || {};
            const rec = await pickups.create(b, str(b.created_by) || 'apsara');
            res.json(rec);
        } catch (e) { bad(res, e.message, e.message && /needs/.test(e.message) ? 400 : 500); }
    });

    // ── THE ANSWER ARRIVING BY HAND ──────────────────────────────────────
    // The carrier phones instead of replying, which is most of the time.
    // Recording the ETA here stops every further chase — the agent asks
    // whether an answer EXISTS, not where it came from.
    app.post('/api/pickups/:id/eta', async (req, res) => {
        try {
            const eta = str((req.body || {}).eta);
            if (!eta) return bad(res, 'say what they told you — "2pm", "after lunch", whatever they said');
            const rec = await pickups.recordEta(req.params.id, eta,
                str((req.body || {}).source) || 'by hand');
            res.json(rec);
        } catch (e) { bad(res, e.message, /no pickup/.test(e.message) ? 404 : 500); }
    });

    // ── STATUS ───────────────────────────────────────────────────────────
    // Collected, done or cancelled. A truck arriving is a fact from the
    // yard; nothing in this feature infers it, and the agent will keep
    // chasing until a person says so.
    app.post('/api/pickups/:id/status', async (req, res) => {
        try {
            const status = str((req.body || {}).status).toLowerCase();
            if (!pickups.STATUSES.includes(status)) {
                return bad(res, `status must be one of: ${pickups.STATUSES.join(', ')}`);
            }
            res.json(await pickups.patch(req.params.id, { status }, 'apsara'));
        } catch (e) { bad(res, e.message, /no pickup/.test(e.message) ? 404 : 500); }
    });

    // ── EDIT ─────────────────────────────────────────────────────────────
    // The date moves, the contact changes. An allowlist rather than a
    // spread of req.body: `sent` and `confirmed_at` are the agent's own
    // bookkeeping, and letting a form overwrite them would either silence
    // the agent or make it send the same rung twice.
    const EDITABLE = ['company', 'pickup_date', 'pickup_window', 'container_no',
        'booking_no', 'location', 'contact_email', 'contact_whatsapp'];
    app.patch('/api/pickups/:id', async (req, res) => {
        try {
            const b = req.body || {};
            const fields = {};
            for (const k of EDITABLE) if (k in b) fields[k] = str(b[k]);
            if (!Object.keys(fields).length) return bad(res, 'nothing to change');
            if ('container_no' in fields) fields.container_no = fields.container_no.toUpperCase();
            res.json(await pickups.patch(req.params.id, fields, 'apsara'));
        } catch (e) { bad(res, e.message, /no pickup/.test(e.message) ? 404 : 500); }
    });

    return app;
}

module.exports = { mount };
