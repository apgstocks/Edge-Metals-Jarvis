// routes/yard.js — split from api.js (helpers/sourceParts.js reconstructs the original)
const cfg = require('../config');

module.exports = function (app, ctx) {
    const { actorOf, isSuper, largeJson, requireAdmin } = ctx;
// @@chunk-start
    app.get('/api/load-drafts', (req, res) => {
        try {
            const { listDrafts } = require('./helpers/loadDrafts');
            res.json(listDrafts());   // bare array, matching /api/loads
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/load-drafts', largeJson, async (req, res) => {
        try {
            const { saveDraft, isWorthSaving, deleteDraft } = require('./helpers/loadDrafts');
            const body = req.body || {};
            // A draft that has fallen BELOW the threshold — rows cleared back
            // out — should disappear rather than linger as a stale offer to
            // restore something the operator deliberately emptied.
            if (!isWorthSaving(body)) {
                if (body.id) await deleteDraft(String(body.id));
                return res.json({ ok: true, saved: false, id: null });
            }
            const draft = await saveDraft({ ...body, created_by: (req.role || null) });
            res.json({ ok: true, saved: true, id: draft.id, updated_at: draft.updated_at });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.delete('/api/load-drafts/:id', async (req, res) => {
        try {
            const { deleteDraft } = require('./helpers/loadDrafts');
            const removed = await deleteDraft(String(req.params.id));
            res.json({ ok: true, removed });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/outbound-loads', (req, res) => {
        try {
            const { loadOutboundLoads, getLoadMargin } = require('./helpers/outboundLoads');
            const { paymentSummary } = require('./helpers/payments');
            const de = require('./helpers/deliveryEnquiry');
            const loads = loadOutboundLoads().map((l) => ({
                ...l, ...getLoadMargin(l),
                // Rendered here, not in the browser: turning a wall clock in
                // America/Los_Angeles into readable text is the one bit of
                // zone maths in this feature, and a second copy of it in
                // client JS would read the phone's zone instead of the load's.
                delivery_eta_text: de.describeEta(l),
                delivery_enquiry_pending: de.pendingForLoad(l.id).length > 0,
                // Sales get payment tracking too: a buyer paying in
                // instalments is the same problem from the other side.
                payment: paymentSummary(l.id, l.amount),
            }));
            // Returns a BARE ARRAY, matching GET /api/loads.
            //
            // It used to return { loads: [...] } while its sibling returned an
            // array, and that inconsistency was a live crash: both the mobile
            // Loads tab and the dashboard Loads tab merge purchases and sales
            // with `[...(inbound||[]).map(...), ...(sales||[]).map(...)]`, so
            // an object sailed through the `|| []` guard and died on .map with
            // "sales.map is not a function" — the whole Loads list blank the
            // moment a sale existed. Two clients had it wrong and one had it
            // right, which is the giveaway that the endpoint was the odd one
            // out, not the callers.
            //
            // Changed here rather than in the callers on purpose: this way the
            // APK already installed on the phone starts working immediately,
            // with no rebuild and no reinstall. dashboard/outbound-loads.html
            // was the one correct caller and is updated alongside; it is
            // served by this same process, so the two can never be out of step.
            res.json(loads);
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

    // Refuses a save that would draw more from a lot than it holds. Checked
    // BEFORE the write, because an over-draw silently accepted turns every
    // later on-hand figure into a lie and there is nothing afterwards that
    // could detect it. ignoreOutboundId lets an EDIT re-save its own existing
    // draws without them counting against themselves.
    function checkDraws(items, ignoreOutboundId) {
        const proposed = (Array.isArray(items) ? items : []).flatMap((it) => (it && it.draws) || []);
        if (!proposed.length) return null;
        const { loadLoads } = require('./helpers/loads');
        const { loadOutboundLoads } = require('./helpers/outboundLoads');
        const { validateDraws } = require('./helpers/stock');
        const v = validateDraws(loadLoads(), loadOutboundLoads(), proposed, { ignoreOutboundId });
        return v.ok ? null : v.errors.join(' ');
    }

    // ── Delivery-status enquiry, shared by create and edit ───────────────
    // Apsara, 2026-09-10: "trucker will give estimated delivery date and
    // time. I want to send a enquiry at that date and time reg the load
    // delivery status". See helpers/deliveryEnquiry.js.
    //
    // NEVER THROWS. A load that saved must report as saved; whether the
    // enquiry could also be scheduled is a separate, lesser fact that travels
    // back beside it. Throwing would make an unknown trucker name look like a
    // failed save and have her enter the load twice.
    async function scheduleDeliveryEnquiry(record, req, how) {
        try {
            const de = require('./helpers/deliveryEnquiry');
            const out = how === 'created'
                ? await de.scheduleForLoad(record, { created_by: req.role || 'web' })
                : await de.syncForLoad(record, { created_by: req.role || 'web', reason: 'eta_changed' });
            // 'no_eta' is not a problem — most loads never get one. Anything
            // else that failed to schedule is something she should see.
            if (!out.scheduled && out.why && out.why !== 'no_eta' && out.message) {
                console.warn(`[DELIVERY] ${record.id}: ${out.why} — ${out.message}`);
            }
            return out;
        } catch (e) {
            console.error('[DELIVERY] could not schedule the enquiry:', e.message);
            return { scheduled: false, why: 'error', message: e.message };
        }
    }

    app.post('/api/outbound-loads', async (req, res) => {
        const b = req.body || {};
        try {
            const drawErr = checkDraws(b.items, null);
            if (drawErr) return res.status(400).json({ error: drawErr });

            // ── SHIPPING MORE THAN THE YARD HAS ON RECORD ────────────────
            // Apsara, 2026-09-16, REVERSING the choice she made earlier the
            // same day: "negative inventory should not block a sale in edge
            // yard.just provide warning that can be overriden".
            //
            // She had picked "Block the sale instead" when the options were
            // put to her, and then lived with it. Her call, and the right one
            // to defer to — she is the person entering loads at the gate, and
            // a refusal there does not stop the truck, it stops the record.
            //
            // WHAT THAT COSTS, stated plainly because it is real: the reason
            // for the block was that the moment of the sale is the last point
            // where somebody still remembers which purchase was never
            // entered. A warning after the fact is easier to ignore than a
            // refusal before it, and the minus-300 row she originally
            // complained about can come back.
            //
            // So the warning does not vanish. It rides back on the SAVE
            // response for the toast, and — because a toast is gone in three
            // seconds — the shortfall is recomputed on every read of the
            // inventory report, where a negative on-hand keeps showing until
            // the missing purchase is entered.
            const stockWarnings = (() => {
                const guard = require('./helpers/stockGuard');
                const short = guard.shortfalls(b.items);
                if (!short.length) return null;
                return { code: 'STOCK_SHORT', message: guard.explain(short, b.weight_unit || 'lb'), shortfalls: short };
            })();

            const { addOutboundLoad } = require('./helpers/outboundLoads');
            const record = await addOutboundLoad({
                date: b.date, buyer: b.buyer, buyer_address: b.buyer_address,
                trucker_name: b.trucker_name, quote_request_id: b.quote_request_id, quote_request_kind: b.quote_request_kind,
                linked_inbound_load_ids: b.linked_inbound_load_ids,
                description: b.description, items: b.items, weight_unit: b.weight_unit,
                delivery_eta_date: b.delivery_eta_date, delivery_eta_time: b.delivery_eta_time,
                delivery_eta_tz: b.delivery_eta_tz,
                created_by: b.created_by || req.role || 'unknown',
                // One-time ticket — see helpers/oncePerSave.js. A re-sent
                // save carrying a spent ticket gets the first record back
                // instead of creating a second.
                client_request_id: b.client_request_id,   // outbound
                // One draft, one load — Apsara, 2026-09-29: "ALWAYS ONE LOAD
                // SHOULD BE CREATED". Optional; absent is unchanged.
                draft_id: b.draft_id,
            });
            // The load is saved either way. Scheduling the enquiry is a
            // second, weaker promise — an unknown trucker or a past ETA must
            // not fail the save — so its outcome rides back on the response
            // as `enquiry` for the form to show, rather than being thrown.
            const enquiry = await scheduleDeliveryEnquiry(record, req, 'created');
            res.json({ ok: true, load: record, enquiry, stock_warning: stockWarnings });
        } catch (err) {
            const isValidation = /^Validation:/.test(err.message || '');
            if (!isValidation) console.error('[API] create outbound load failed:', err.message);
            res.status(isValidation ? 400 : 500).json({ error: err.message });
        }
    });

    app.put('/api/outbound-loads/:id', async (req, res) => {
        const b = req.body || {};
        try {
            const drawErr = checkDraws((req.body || {}).items, req.params.id);
            if (drawErr) return res.status(400).json({ error: drawErr });

            // Same warning on EDITS, with this load's own weights added back
            // first — otherwise correcting 400 lb to 380 would be flagged
            // because the original 400 is still counted against stock.
            const stockWarnings = (() => {
                const guard = require('./helpers/stockGuard');
                const short = guard.shortfalls(b.items, { excludeOutboundId: req.params.id });
                if (!short.length) return null;
                return { code: 'STOCK_SHORT', message: guard.explain(short, b.weight_unit || 'lb'), shortfalls: short };
            })();

            const { editOutboundLoad } = require('./helpers/outboundLoads');
            const record = await editOutboundLoad(req.params.id, {
                date: b.date, buyer: b.buyer, buyer_address: b.buyer_address,
                trucker_name: b.trucker_name, quote_request_id: b.quote_request_id, quote_request_kind: b.quote_request_kind,
                linked_inbound_load_ids: b.linked_inbound_load_ids,
                description: b.description, items: b.items, weight_unit: b.weight_unit,
                delivery_eta_date: b.delivery_eta_date, delivery_eta_time: b.delivery_eta_time,
                delivery_eta_tz: b.delivery_eta_tz,
            });
            if (!record) return res.status(404).json({ error: 'not found' });
            // syncForLoad, not scheduleForLoad: an edit can move the ETA or
            // change the trucker, and a task left pointing at the old one
            // would ask the wrong haulier at the wrong hour.
            const enquiry = await scheduleDeliveryEnquiry(record, req, 'edited');
            res.json({ ok: true, load: record, enquiry, stock_warning: stockWarnings });
        } catch (err) {
            const isValidation = /^Validation:/.test(err.message || '');
            if (!isValidation) console.error('[API] edit outbound load failed:', err.message);
            res.status(isValidation ? 400 : 500).json({ error: err.message });
        }
    });


    app.delete('/api/outbound-loads/:id', async (req, res) => {
        try {
            const { deleteOutboundLoad } = require('./helpers/outboundLoads');
            const found = await deleteOutboundLoad(req.params.id);
            if (!found) return res.status(404).json({ error: 'not found' });
            // Payments follow the load. A deleted load leaving its
            // receipts behind would sum against nothing and quietly inflate
            // any future "what have we paid" figure.
            await require('./helpers/payments').deletePaymentsForLoad(req.params.id);
            // And so does the enquiry. A pending "has it been delivered?"
            // against a load that no longer exists would still fire — the
            // condition gate skips a missing load, but only once its ETA comes
            // round, so it sits in her task list until then looking live.
            try {
                await require('./helpers/deliveryEnquiry').cancelForLoad(req.params.id, 'load_deleted');
            } catch (e) {
                console.error('[DELIVERY] load deleted but its enquiry was not cancelled:', e.message);
            }

            res.json({ ok: true });
        } catch (err) {
            console.error('[API] delete outbound load failed:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── EDGE INVENTORY — one supplier's material and their account ───────
    // Apsara, 2026-09-11: "WANT TO HAVE a separate tab called Edge inventory.
    // there i want to maintain per supplier basis. inventory items and
    // accounts for that supplier."
    //
    // Two halves, and only one of them is a store. The RECEIPTS are new
    // (helpers/edgeInventory.js — what a supplier delivered, itemised from a
    // packing list). The ACCOUNT is derived from bills and bill payments,
    // which already hold every figure in it (helpers/supplierAccount.js).
    //
    // Edge METALS. The yard's own inventory is helpers/loads.js and is not
    // reachable from here.
    app.get('/api/edge-inventory/suppliers', (req, res) => {
        try {
            const sa = require('./helpers/supplierAccount');
            const inv = require('./helpers/edgeInventory');
            res.json({
                ok: true,
                suppliers: sa.overview(),
                unassigned: sa.unassigned(),
                // Everything she is holding, wherever it is, across suppliers.
                by_storage: inv.byStorage(),
                storage_names: inv.storageNames(),
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Registered before /:supplier so a supplier literally named "suppliers"
    // could not shadow the route above — the same ordering hazard the
    // outbound-loads report route documents.
    app.get('/api/edge-inventory/:supplier', (req, res) => {
        try {
            const who = decodeURIComponent(req.params.supplier);
            const sa = require('./helpers/supplierAccount');
            const inv = require('./helpers/edgeInventory');
            res.json({
                ok: true,
                supplier: who,
                account: sa.statement(who, { from: req.query.from, to: req.query.to }),
                receipts: inv.forSupplier(who, {
                    from: req.query.from, to: req.query.to, storage: req.query.storage,
                }),
                by_grade: inv.byGrade(who),
                // Apsara, 2026-09-11: "for local deliveries,i might keep our
                // inventory in other yards. so a field called Storage needs to
                // be invented." Per supplier here; the whole picture is on
                // /api/edge-inventory/suppliers, because "which yard is
                // holding what" is not a per-supplier question when a yard
                // rings up asking her to clear space.
                by_storage: inv.byStorage(who),
                storage_names: inv.storageNames(),
                received: inv.summary(who),
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/edge-inventory', async (req, res) => {
        try {
            const inv = require('./helpers/edgeInventory');
            const rec = await inv.addReceipt({ ...(req.body || {}), created_by: req.role || null });
            res.json({ ok: true, receipt: rec });
        } catch (err) {
            const isValidation = /^Validation:/.test(err.message || '');
            if (!isValidation) console.error('[API] create inventory receipt failed:', err.message);
            res.status(isValidation ? 400 : 500).json({ error: err.message });
        }
    });

    app.put('/api/edge-inventory/receipt/:id', async (req, res) => {
        try {
            const inv = require('./helpers/edgeInventory');
            const rec = await inv.editReceipt(req.params.id, req.body || {});
            if (!rec) return res.status(404).json({ error: 'not found' });
            res.json({ ok: true, receipt: rec });
        } catch (err) {
            const isValidation = /^Validation:/.test(err.message || '');
            if (!isValidation) console.error('[API] edit inventory receipt failed:', err.message);
            res.status(isValidation ? 400 : 500).json({ error: err.message });
        }
    });

    app.delete('/api/edge-inventory/receipt/:id', async (req, res) => {
        try {
            const inv = require('./helpers/edgeInventory');
            const found = await inv.deleteReceipt(req.params.id);
            if (!found) return res.status(404).json({ error: 'not found' });
            // Nothing to cascade: a receipt is a physical record and writes no
            // money row anywhere. See the header of helpers/edgeInventory.js.
            res.json({ ok: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ── "It arrived" ─────────────────────────────────────────────────────
    // Registered AFTER /api/outbound-loads/:id (a GET) but that is a
    // different verb, so no route-ordering hazard here. POST rather than PUT
    // because it records an event, and deliberately its own route rather than
    // a field on the edit form: the edit form rebuilds the record and would
    // need delivery_status threaded through validation for something that is
    // not a correction to the load at all.
    app.post('/api/outbound-loads/:id/delivered', async (req, res) => {
        try {
            const { markDelivered } = require('./helpers/outboundLoads');
            const updated = await markDelivered(req.params.id, {
                on: (req.body || {}).delivered_at || null,
                by: req.role || null,
            });
            if (!updated) return res.status(404).json({ error: 'not found' });
            res.json({ ok: true, load: updated });
        } catch (err) {
            console.error('[API] mark outbound load delivered failed:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── Neo4j graph trace — "show everything connected to X" ────────────────
    // See helpers/graph.js's header. Returns { nodes: [], edges: [] } (never
    // an error) if Neo4j isn't configured or the query fails — an empty
    // graph is a valid, non-error state for a caller to render as "nothing
    // here yet", not something to alert on.
    //
    // NOTE (2026-08-25): helpers/graph.js does not exist and never did —
    // verified on disk and against apgstocks/Edge-Metals-Jarvis on GitHub.
    // Both endpoints below therefore returned a 500 "Cannot find module",
    // which directly contradicts the contract stated above ("never an
    // error... an empty graph is a valid, non-error state"). Treat the
    // module simply being absent as "not configured", which is what it
    // actually means — an optional integration that was never built.
    const loadGraphModule = () => {
        try { return require('./helpers/graph'); }
        catch (e) {
            if (e.code === 'MODULE_NOT_FOUND') return null;
            throw e;
        }
    };

    app.get('/api/graph/trace', requireAdmin, async (req, res) => {
        try {
            const name = String(req.query.entity || '').trim();
            if (!name) return res.status(400).json({ error: 'entity query param required' });
            const graph = loadGraphModule();
            if (!graph) return res.json({ nodes: [], edges: [], configured: false });
            const result = await graph.traceEntity(name, { depth: parseInt(req.query.depth, 10) || 2 });
            res.json(result);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/graph/status', requireAdmin, async (req, res) => {
        try {
            const graph = loadGraphModule();
            if (!graph || !graph.isConfigured || !graph.isConfigured()) return res.json({ configured: false });
            const result = await graph.verifyConnectivity();
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
    // ── WHO IS THIS EXPENSE FOR? ─────────────────────────────────────────
    // Apsara, 2026-09-15: "if they say salay santiago-it means that salary
    // for santiago..when they type in app-it should read the description and
    // ask user whether they mean salary for santiago????" — and, asked how:
    // "ai assistant should handle that".
    //
    // Returns a QUESTION, never a change. See helpers/vendorFromText.js for
    // why the model finds the name and deterministic code decides whether it
    // is anyone, and why every failure returns "no suggestion" rather than an
    // error: an expense she cannot record because a suggestion service was
    // down would be far worse than the gap this closes.
    app.post('/api/expenses/suggest-vendor', requireAdmin, async (req, res) => {
        try {
            const { suggestVendor } = require('./helpers/vendorFromText');
            const b2 = req.body || {};
            const out = await suggestVendor(b2.description, { vendor: b2.vendor, category: b2.category });
            res.json({ ok: true, ...out });
        } catch (e) {
            // 200, not 500. The client treats this as "nothing to ask" and
            // carries on; a failing suggestion must never look like a failing
            // save.
            console.error('[API] suggest-vendor failed:', e.message);
            res.json({ ok: true, suggest: false, why: 'error' });
        }
    });

    app.get('/api/expenses', requireAdmin, (req, res) => {
        try {
            const { loadExpenses, getExpenseReport, EXPENSE_CATEGORIES, EXPENSE_METHODS,
                    RETIRED_METHODS, DEFAULT_EXPENSE_METHOD } = require('./helpers/expenses');
            const all = loadExpenses();
            // methods travels with the payload for the same reason categories
            // does: the dropdown is built from the server's list, so it cannot
            // drift from what the server will accept. default_method rides
            // along so which option is pre-selected is decided in ONE place —
            // a client-side default would silently disagree with the server
            // the next time the list changes.
            //
            // retired_methods is the same idea applied to the OTHER end. The
            // form offers a record's own stored method back to it so an edit
            // cannot erase it; without this list the form cannot tell a real
            // retired value (Zelle — the server still accepts it) from legacy
            // free text (a typed "cash app" — the server rejects it), so it
            // offered both. Selecting the second saved as null anyway: an
            // option that quietly does not take.
            let pettyBalance = null;
            try { pettyBalance = require('./helpers/pettyCash').balance(); } catch (e) {}
            res.json({ expenses: all, report: getExpenseReport(all, {}), categories: EXPENSE_CATEGORIES,
                       methods: EXPENSE_METHODS, retired_methods: RETIRED_METHODS,
                       default_method: DEFAULT_EXPENSE_METHOD,
                       petty_cash_balance: pettyBalance });
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

            // ── the signature freeze, ON THE SERVER ───────────────────────
            // Apsara 2026-09-02: "once payment initiated, signed-resign should
            // not be there." Like the delete rule, that was enforced by hiding
            // a button and nowhere else — this route would happily overwrite a
            // signature on a load that had been paid in full, and regenerate
            // the PDF around it.
            //
            // It only bites on a RE-sign. Signing a load that has been paid
            // but never signed is not the thing she was protecting against; a
            // seller signing late is ordinary, and refusing it would strand a
            // real load with no way to get a signature onto its ticket.
            const audit = require('./helpers/audit');
            const alreadySigned = !!load.seller_signature;
            const paidTotal = require('./helpers/payments')
                .paymentsForLoad(req.params.id)
                .reduce((a, p) => a + (Number(p.amount) || 0), 0);
            if (alreadySigned && paidTotal > 0 && !isSuper(req)) {
                await audit.refused({
                    action: 'resign-paid-load', subject: req.params.id,
                    actor: actorOf(req), role: req.role, ip: req.ip,
                    detail: { paid: paidTotal, signed_at: load.seller_signed_at },
                    reason: 'signature is frozen once the load has been paid against',
                });
                return res.status(409).json({
                    error: 'This load was signed and has since been paid. Sign in with the Jarvis profile to replace the signature.',
                    code: 'SIGNATURE_FROZEN',
                });
            }
            // Replacing a signature on a paid load changes what the seller is
            // recorded as having agreed to, after the money moved. The old
            // timestamp is kept in the log because the load will not have it.
            if (alreadySigned && paidTotal > 0) {
                const entry = await audit.record({
                    action: 'resign-paid-load', subject: req.params.id,
                    actor: actorOf(req), role: req.role, ip: req.ip,
                    detail: { paid: paidTotal, previous_signed_at: load.seller_signed_at },
                });
                await audit.complete(entry, 'done');
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
    // Sale ticket — Apsara 2026-08-24: "what if i want to have ticket
    // actions" on a sale. Mirrors the inbound generate-pdf route above and
    // reuses the SAME generator and Drive path; only opts.kind differs, which
    // is what makes the document say "SALE TICKET / Buyer:" and skip the
    // signature line ("no sign needed").
    //
    // Writes pdf_link/pdf_drive_id back onto the outbound record under the
    // same field names an inbound load uses, so both clients render a sale
    // card with the existing code rather than a parallel set of branches.
    app.post('/api/outbound-loads/:id/generate-pdf', async (req, res) => {
        try {
            const ob = require('./helpers/outboundLoads');
            const sale = ob.getOutboundLoad(req.params.id);
            if (!sale) return res.status(404).json({ error: 'not found' });

            // generateLoadPdf reads the counterparty from load.seller — on a
            // sale that party is the buyer, so it's mapped here rather than
            // teaching the generator a second field name.
            const forPdf = { ...sale, seller: sale.buyer, seller_address: sale.buyer_address };
            const { generateLoadPdf, generateLoadReceiptPdf } = require('./helpers/pdf');
            const { uploadLoadPdf } = require('./helpers/drive');

            const buf = await generateLoadPdf(forPdf, { kind: 'sale', includeSummary: !(req.body && req.body.includeSummary === false) });
            const file = await uploadLoadPdf(sale.id, buf);
            let receiptPatch = {};
            try {
                const rbuf = await generateLoadReceiptPdf(forPdf, { kind: 'sale' });
                const rfile = await uploadLoadPdf(sale.id, rbuf, `receipt_${sale.id}.pdf`);
                receiptPatch = { receipt_pdf_drive_id: rfile.id, receipt_pdf_link: rfile.webViewLink };
            } catch (e) {
                // Non-fatal, same posture as the inbound path: the POS receipt
                // is a convenience and must not cost her the main ticket.
                console.error(`[API] sale receipt failed for ${sale.id}:`, e.message);
            }
            // patchOutboundLoad, NOT editOutboundLoad: the latter rebuilds the
            // record from a known field list and would drop these.
            const updated = await ob.patchOutboundLoad(sale.id, {
                pdf_drive_id: file.id, pdf_link: file.webViewLink, ...receiptPatch,
            });
            res.json({ ok: true, load: updated });
        } catch (err) {
            console.error('[API] outbound generate-pdf failed:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

// @@chunk-end

};
