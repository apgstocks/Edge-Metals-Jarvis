// ── helpers/ledgerPlanRoutes.js — preview, then apply, never one press ────
//
// Apsara, 2026-10-08, on what the QuickBooks agent should do: "remove this
// container from the <billno>… and add this container by creating a new
// bill… and then match it with this payment(partial/full)", then "wire
// them".
//
// helpers/ledgerPlan.js verifies and previews; helpers/ledgerApply.js
// applies. Both were written today and reached by NOTHING — the same state
// helpers/reconcile.js was in from 3 September, working perfectly and used
// by nobody. This is what makes them reachable.
//
// ── TWO ROUTES, AND THE SPLIT IS THE SAFETY ─────────────────────────────
// Preview writes nothing. Apply takes the diff the preview returned and
// refuses if the books have moved since. One route that did both would
// make that check impossible: there would be no moment at which she had
// seen a figure and not yet committed to it.
//
// The plan-then-execute literature calls the thing in between a
// confirmation packet. Here it is the per-supplier diff, because "4
// operations" is not something anyone can approve and "Hugo: owed 41,285 →
// 29,285" is.
//
// ── SUPER ONLY ──────────────────────────────────────────────────────────
// A plan can delete a bill and move money between containers. api.js:909
// already reserves that class of thing for the Jarvis profile rather than
// any admin, on the argument that a profile which can erase a paid load can
// erase the evidence that money moved. An agent that can propose four such
// writes at once belongs behind the same door.

function mount(app, cfg) {
    const LP = require('./ledgerPlan');
    const LA = require('./ledgerApply');

    const sup = (req, res) => {
        if (!req.isSuper) {
            res.status(403).json({ error: 'a ledger plan moves money between records and can delete '
                + 'a bill — that is the Jarvis profile, not an ordinary admin' });
            return false;
        }
        return true;
    };

    // ── POST /api/ledger/plan/preview ────────────────────────────────────
    // Writes nothing. Returns the plan in words, the problems if it does
    // not verify, and the per-supplier diff if it does.
    app.post('/api/ledger/plan/preview', (req, res) => {
        if (!sup(req, res)) return;
        const body = req.body || {};
        const plan = Array.isArray(body.plan) ? body.plan : null;
        if (!plan) return res.status(400).json({ error: 'send a plan — an array of operations' });
        try {
            const world = LA.readWorld();
            const v = LP.verify(plan, world);
            res.json({
                ok: v.ok,
                steps: LP.describe(plan),
                problems: v.problems || [],
                // Only when it verifies. A diff beside a refusal reads as
                // something that is going to happen.
                diff: v.ok ? v.simulation.diff : null,
                // Handed back so the Apply call can send it unchanged and
                // the world-moved check has something to compare against.
                // Not a token or a signature: it is the figures themselves,
                // which is what makes the refusal explainable to her rather
                // than "your session expired".
                approvedDiff: v.ok ? v.simulation.diff : null,
                // ── THE CARRIER HALF, AND WHY IT IS SEPARATE ────────────
                // A plan can add or pay a carrier bill and touch no
                // supplier at all, in which case `diff` above is empty and
                // says nothing happened. Both travel, and the apply call
                // sends both back, so the world-moved check covers a
                // carrier change too.
                carrierDiff: v.ok ? (v.simulation.carrierDiff || []) : null,
                approvedCarrierDiff: v.ok ? (v.simulation.carrierDiff || []) : null,
                reverse: v.ok ? LP.reverseOf(plan) : null,
                // ── SAID BEFORE SHE PRESSES, NOT AFTER ──────────────────
                // The two carrier operations have no inverse:
                // carrierInvoices.js has no delete and no un-pay. By the
                // time she is looking for an Undo button, "this cannot be
                // undone" is not information, it is an apology — so it
                // goes on the confirmation screen.
                undo: LP.reversibility(plan),
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ── POST /api/ledger/plan/apply ──────────────────────────────────────
    // ledgerApply does the real work — re-verify against fresh data, the
    // approved-diff check, snapshot, apply, roll back on failure, and the
    // audit entry. This route is the door, not the logic.
    app.post('/api/ledger/plan/apply', async (req, res) => {
        if (!sup(req, res)) return;
        const body = req.body || {};
        const plan = Array.isArray(body.plan) ? body.plan : null;
        if (!plan) return res.status(400).json({ error: 'send a plan — an array of operations' });
        // ── A PLAN ID IS REQUIRED, NOT GENERATED HERE ───────────────────
        // It is what makes the apply idempotent, and it has to come from
        // the CLIENT so that a retry of the same press carries the same id.
        // Minting one here would give every retry a new id and defeat the
        // check entirely — the double-pressed button is the case it exists
        // for.
        const planId = String(body.planId || '').trim();
        if (!planId) return res.status(400).json({ error: 'send a planId so a retry cannot apply it twice' });
        try {
            const out = await LA.apply({
                plan, planId,
                asked: String(body.asked || ''),
                actor: req.profile || req.role || null,
                approvedDiff: body.approvedDiff || null,
                approvedCarrierDiff: body.approvedCarrierDiff || null,
            });
            // 409 for "the world moved" and "already applied": both mean
            // the request was reasonable and the state is not what it
            // assumed, which is what 409 is for. A 400 would read as a
            // malformed request and send her looking at the wrong thing.
            if (!out.ok) {
                const conflict = /already been applied|changed since you were shown/.test(out.why || '');
                // The carrier refusal's wording ends "...confirm again" via
                // a different sentence, so it is matched explicitly rather
                // than trusted to the regex above. A 400 here would read as
                // a malformed request and send her looking at the plan
                // instead of at the figures.
                if (/carrier list changed since/.test(out.why || '')) {
                    return res.status(409).json(out);
                }
                return res.status(conflict ? 409 : 400).json(out);
            }
            res.json(out);
        } catch (e) {
            // ledgerApply throws for one case only: the apply failed AND
            // the rollback failed, so the data is in a state nobody
            // designed. 500 and the message, verbatim — this is not a
            // moment to be tidy.
            res.status(500).json({ error: e.message, severity: 'the books may be inconsistent' });
        }
    });

    // ── GET /api/ledger/plan/log ─────────────────────────────────────────
    // Apsara: "make it log every change we are doing in qb/books so that we
    // can check it later." The log is append-only in audit.js; this is the
    // reading end, because a log nothing can read is a log nobody checks.
    app.get('/api/ledger/plan/log', (req, res) => {
        if (!sup(req, res)) return;
        try {
            const rows = (require('./audit').listEntries() || [])
                .filter((e) => e && e.action === 'ledger-plan')
                .slice(-100).reverse()
                .map((e) => ({
                    id: e.id, at: e.at, actor: e.actor,
                    asked: (e.detail || {}).asked || null,
                    applied: !!(e.detail || {}).applied,
                    steps: (e.detail || {}).steps || [],
                    diff: (e.detail || {}).diff || null,
                    carrierDiff: (e.detail || {}).carrierDiff || null,
                    reversible: (e.detail || {}).reversible,
                    irreversible: (e.detail || {}).irreversible || [],
                    problems: (e.detail || {}).problems || [],
                    // The undo travels with the entry so that undoing is a
                    // question of reading the log, not of recomputing a
                    // reverse plan against a world that has since moved.
                    reverse: (e.detail || {}).reverse || null,
                }));
            res.json({ rows });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
}

module.exports = { mount };
