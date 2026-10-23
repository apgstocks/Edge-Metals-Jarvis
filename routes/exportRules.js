// routes/exportRules.js — destination import rules for scrap, and who confirmed them
//
// Apsara, 2026-10-23/24: the export-import side of a US scrap exporter, then
// "Audit and build everything".
//
// ── THESE ROUTES ANSWER. THEY DO NOT REFUSE ──────────────────────────────
// Nothing here blocks a booking, a document or a send. That is deliberate and
// it is CLAUDE.md rule 1: a refusal added to /api/invoice/send or
// POST /api/bookings would land on paths with callers I have not changed —
// including the scanned-PDF booking importer, which has no form to show a
// warning on. The over-reach pattern in that file is exactly this: a rule
// that makes sense on one screen put into code other callers reach.
//
// So the check is available, and whether a screen warns or stops is a
// separate decision with her name on it.
//
// Not on STAFF_ALLOWED_PATH_PREFIXES in api.js, so a staff-role session gets
// a 403 on all of these — which is right: a trade-compliance rule is not a
// yard scale operator's business. The write is requireAdmin on top of that.
module.exports = function (app, ctx) {
    const { requireAdmin, actorOf } = ctx;
// @@chunk-start
    const X = require('./helpers/exportRules');

    // The whole register, each rule with whether it is safe to act on. Sent
    // with the status computed server-side rather than letting the client work
    // out staleness: two implementations of "is this rule still good" is how
    // one of them quietly starts saying yes.
    app.get('/api/export-rules', (req, res) => {
        const rows = X.rules().map((r) => ({ ...r, status: X.statusOf(r) }));
        res.json({
            rules: rows,
            attention: X.needsAttention({}),
            // Said out loud in the payload so a screen cannot present this
            // register as authoritative without ignoring a field.
            disclaimer: 'A rule is trustworthy because a named person confirmed it on a '
                + 'known date, never because it was researched. Anything unconfirmed, '
                + 'disputed or lapsed reads as unknown, and unknown is not clear.',
        });
    });

    // What a given destination would be told. GET because it changes nothing.
    app.get('/api/export-check', (req, res) => {
        const port = req.query.port || req.query.port_of_discharge || '';
        const out = X.check({
            port_of_discharge: port,
            origin_country: req.query.origin || 'US',
            material: req.query.material || null,
        });
        res.json(out);
    });

    // Every booking's compliance state in one call, for a banner on the
    // bookings screen. Read-only, and it reports the PORT it read so a wrong
    // country reading is visible rather than mysterious.
    app.get('/api/export-check/bookings', (req, res) => {
        const cfg = require('./config');
        const { loadJson } = require('./helpers/json');
        let all = {};
        try { all = loadJson(cfg.BOOKINGS_FILE, {}) || {}; } catch (e) { all = {}; }
        const rows = (Array.isArray(all) ? all : Object.values(all))
            .filter((b) => b && b.booking_number)
            .map((b) => {
                const r = X.check({ port_of_discharge: b.port_of_discharge, origin_country: 'US' });
                return {
                    booking_number: b.booking_number,
                    port_of_discharge: b.port_of_discharge || null,
                    outcome: r.outcome,
                    country: r.country ? r.country.name : null,
                    reasons: r.reasons,
                    actions: r.actions,
                };
            })
            // Blocked first, then unknown — clear ones are not what she opened
            // this screen for.
            .sort((a, b) => (({ blocked: 0, unknown: 1, clear: 2 })[a.outcome]
                - ({ blocked: 0, unknown: 1, clear: 2 })[b.outcome]));
        res.json({
            rows,
            blocked: rows.filter((r) => r.outcome === 'blocked').length,
            unknown: rows.filter((r) => r.outcome === 'unknown').length,
            clear: rows.filter((r) => r.outcome === 'clear').length,
        });
    });

    // ── NO VERIFY ROUTE YET, AND THAT IS DELIBERATE ──────────────────────
    // There WAS a POST /api/export-rules/:id/verify here, written in the same
    // pass as the reads. tests/route-reach.js caught it on the first full-suite
    // run: "a guarded route nothing calls is a permission that cannot be used.
    // Either the screen is missing, or the route is dead." It was the second.
    //
    // Verification happens today through scripts/export-rules.js verify, which
    // is where it belongs while the only person signing rules is her on the VM.
    // So the route was an admin-guarded write with no caller — attack surface
    // for no benefit, which is exactly the call made on claimShare's public
    // /s/:token route (#228): deleted rather than left sitting there unused.
    //
    // It comes back WITH the screen that calls it, not before. helpers/
    // exportRules.verify is unchanged and tested; only the HTTP door is gone.
    void requireAdmin; void actorOf;   // still destructured; used again with the screen
// @@chunk-end
    return {};
};
