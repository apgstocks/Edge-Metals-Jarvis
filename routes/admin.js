// routes/admin.js — split from api.js (helpers/sourceParts.js reconstructs the original)
const path = require('path');
const cfg = require('../config');
const { loadFacts, loadActiveFacts, addFact, setFactPinned, deleteFactById, supersedeFact, retractFact, unretractFact, factHistory, loadSettings, saveSettings } = require('../helpers/json');
const { listAlerts, snoozeAlert, muteBooking } = require('../alerts');

module.exports = function (app, ctx) {
    const { actorOf, documentsSaved, pricelist, requireAdmin } = ctx;
// @@chunk-start
    app.get('/api/documents/saved', (req, res) => {
        try {
            // ── PROFORMAS ONLY IN PROFORMA, INVOICES ONLY IN INVOICE ─────
            // Apsara 2026-09-30: "proform ashould be in proforma,inv in
            // invoice" and "find a way to keep old invoice in inv tab only".
            //
            // `proformas` NARROWS here: a file positively identified as a
            // commercial invoice no longer appears under it. That is the
            // requested change and it is the only one — the misfiled rows
            // come back on their own key so the invoice tab can show them,
            // with their real filing (kind: 'proforma') intact so Open and
            // Delete keep working. Nothing on disk moves; see
            // helpers/savedDocKinds.js for why not.
            //
            // A file nobody has classified stays under `proformas`, so a cold
            // cache leaves today's behaviour exactly as it is rather than
            // emptying the tab.
            const split = documentsSaved.splitSavedProformas();
            res.json({
                invoices: documentsSaved.listSavedInvoices(),
                proformas: split.proformas,
                // Identified as belonging in the invoice tab, still filed
                // under proforma/ on disk. Additive key — a client that does
                // not know about it is unaffected.
                misfiled_in_proforma: split.misfiled,
                // Added 2026-09-15 with the BOL tab. Purely additive — the
                // one consumer (dashboard/documents.html) destructures
                // `{ proformas }` and is unaffected by a new key.
                bols: documentsSaved.listSavedBols(),
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ── WHICH SAVED PROFORMAS CAN BE COPIED ─────────────────────────────
    // Apsara, 2026-09-17: "copy option so that itwill get coppied to proforma
    // for say..".
    //
    // Only proformas generated since helpers/proformaVersions.js shipped have
    // a stored form payload — everything older is a PDF and nothing else, and
    // there is no honest backfill (see that file's header). So the screen asks
    // which ones it can offer, in ONE call for the whole list rather than one
    // per row, and draws a button only for those. A Copy button that reports
    // "nothing to copy" on click is worse than no button.
    app.get('/api/proforma/copyable', requireAdmin, (req, res) => {
        try {
            const pv = require('./helpers/proformaVersions');
            res.json({ copyable: pv.copyableSet(documentsSaved.listSavedProformas()) });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // The payload behind one saved proforma, for pre-filling a NEW one.
    //
    // Deliberately does NOT hand back inv_no — see the client. A new proforma
    // needs its own number, and copying one produces two documents claiming
    // the same identity. helpers/bolNumbers.js's header is the long version of
    // why that is worse than it sounds.
    app.get('/api/proforma/saved-payload', requireAdmin, (req, res) => {
        try {
            const pv = require('./helpers/proformaVersions');
            const rec = pv.getProformaPayload(req.query.file);
            if (!rec) {
                return res.status(404).json({
                    error: 'That proforma was generated before Copy existed, so its form was never stored. Nothing to copy from.',
                    code: 'NO_PAYLOAD',
                });
            }
            const { inv_no, saved_at, ...rest } = rec;
            res.json({ ok: true, payload: rest, copied_from: pv.keyFor(req.query.file), generated_at: saved_at || null });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    // ── DELETE A SAVED DOCUMENT ─────────────────────────────────────────
    // Apsara, 2026-09-17: "add delete option in saved proforma/invoice/bol/
    // packing list", and, asked what goes: "The PDF and the record".
    //
    // ── AUDITED BEFORE THE ACT, STAMPED AFTER ───────────────────────────
    // Same shape as the BOL delete from 2026-09-16. Which document went, and
    // who removed it, has to outlive the document — otherwise the only trace
    // of a deleted commercial invoice is that it is not there any more.
    //
    // ── AND THE RECORD, WHERE ONE UNAMBIGUOUSLY BACKS THIS FILE ──────────
    // A BOL's filename carries its number and a packing list's carries its
    // container, so each maps to exactly one stored record and both go.
    //
    // An INVOICE is different, and deliberately left alone: its stored
    // "record" is the per-CONTAINER version history that every invoice for
    // that container shares — including the ones she is keeping. Deleting it
    // because she removed one PDF would take data she did not ask about,
    // which is the rule at the top of CLAUDE.md. A proforma has no record at
    // all. Both cases are reported honestly in the response rather than
    // quietly doing less than the button says.
    app.delete('/api/documents/saved', requireAdmin, async (req, res) => {
        try {
            const kind = String(req.query.kind || '').trim();
            const filename = String(req.query.file || '').trim();
            if (!kind || !filename) return res.status(400).json({ error: 'kind and file are required' });

            // ── RESOLVED FIRST, THEN LOGGED, THEN DELETED ────────────────
            // The log entry is written BEFORE the file goes, but only once
            // there is a file to go: a request naming something that is not
            // there deleted nothing, and an audit trail that records
            // no-ops is one nobody reads. Found by a test that pressed
            // Delete twice and counted the entries.
            const target = documentsSaved.resolveSavedPath({
                kind, filename, date: req.query.date, container: req.query.container,
            });
            if (!target) return res.status(404).json({ error: 'no such saved document' });

            const audit = require('./helpers/audit');
            const entry = await audit.record({
                action: 'delete-saved-document', subject: filename,
                actor: actorOf(req), role: req.role, ip: req.ip,
                detail: { kind, date: req.query.date || null, container: req.query.container || null },
            });

            const removed = documentsSaved.deleteSaved({
                kind, filename, date: req.query.date, container: req.query.container,
            });
            if (!removed) {
                // It existed a moment ago and does not now — something else
                // removed it between the two calls. Say so rather than
                // reporting a success.
                await audit.complete(entry, 'failed', { reason: 'vanished between resolve and delete' });
                return res.status(404).json({ error: 'no such saved document' });
            }

            // The record, where the filename identifies exactly one.
            let record_removed = null;
            try {
                if (kind === 'bol') {
                    const bols = require('./helpers/bols');
                    // `<BOL_NO>_<who>.pdf` — safeName replaced every run of
                    // non-alphanumerics, so the number is matched loosely
                    // against the stored one rather than reconstructed.
                    const stem = filename.replace(/\.pdf$/i, '');
                    const hit = bols.listBols().find((b) => b && b.bol_no
                        && stem.toLowerCase().startsWith(documentsSaved.safeName(b.bol_no).toLowerCase()));
                    if (hit) { await bols.deleteBol(hit.id); record_removed = `bol ${hit.bol_no}`; }
                } else if (/_packing\.pdf$/i.test(filename)) {
                    const pl = require('./helpers/packingList');
                    const container = String(req.query.container || '').trim();
                    const hit = pl.list().find((r) => r && pl.keyOf(r.container_no) === pl.keyOf(container));
                    if (hit) { await pl.remove(hit.id); record_removed = `packing list ${hit.container_no}`; }
                } else if (kind === 'proforma') {
                    // The stored form state goes with the PDF (2026-09-18).
                    // Left behind, it is a Copy button offered on a row that
                    // no longer exists — and, since the store is capped, an
                    // entry for a deleted document evicting a live one.
                    const removedPayload = await require('./helpers/proformaVersions')
                        .forgetProformaPayload(filename);
                    if (removedPayload) record_removed = 'saved form state';
                }
            } catch (e) {
                // The file is gone; failing to also remove the record must not
                // report the delete as failed, or she presses it again.
                console.error('[documents] could not remove the stored record (non-fatal):', e.message);
            }

            await audit.complete(entry, 'done', { record_removed });
            res.json({ ok: true, deleted: path.basename(removed), record_removed });
        } catch (e) {
            console.error('[documents] delete failed:', e);
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/documents/download', (req, res) => {
        const target = documentsSaved.resolveSavedPath({
            kind: req.query.kind, filename: req.query.file,
            date: req.query.date, container: req.query.container,
        });
        if (!target) return res.status(404).json({ error: 'file not found' });
        res.sendFile(target);
    });

    // ── Item-description catalog ────────────────────────────────────────────
    // GET returns the WHOLE list, already sorted A–Z — as of 2026-08-20 this
    // is the only list there is. The clients used to merge this response with
    // a hardcoded ITEM_DESC_OPTIONS_BASE array of their own; that array now
    // lives in helpers/itemTypes.js as one-time seed data and the clients
    // render this response verbatim. See that file's header for why.
    //
    // Deliberately NOT behind requireAdmin, and '/api/item-types' is in
    // STAFF_ALLOWED_PATH_PREFIXES: per Apsara 2026-08-20, "give this option
    // to modify/delete the list in staff and admin settings." Staff are the
    // people actually typing descriptions all day, so they're the ones who
    // notice a typo — making them ask an admin to fix it is how the list
    // ends up full of near-duplicates nobody cleans up.
    //
    // The blast radius of that decision is genuinely small: this catalog is
    // a typing convenience, not a record. Descriptions are stored as text on
    // each load, so nothing here can delete, reprice, or reword a saved
    // load, an issued PDF, or a monthly sheet.
    // ── THE SELLING CATALOGUE ────────────────────────────────────────────
    // Apsara, 2026-09-07: "maintain a separate catalogue for edge metals.
    // keep on appending to that new catalogue as i generate proforma and keep
    // the existing workflow catalogue for yard."
    //
    // Deliberately a DIFFERENT path from /api/item-types below, not a mode of
    // it. The yard's list feeds the load form at the scale; this one feeds
    // proforma descriptions. Sharing a route would mean one flag standing
    // between the yard's dropdown and a buyer's document.
    //
    // It fills itself from generated proformas (helpers/tradeCatalog.js), so
    // POST is not how entries normally arrive — it is here, with PUT and
    // DELETE, only so she can fix a typo that has already been sent once.
    app.get('/api/trade-catalog', (req, res) => {
        try { res.json(require('./helpers/tradeCatalog').list()); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.post('/api/trade-catalog', async (req, res) => {
        try { res.json(await require('./helpers/tradeCatalog').add(req.body.description)); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });
    app.put('/api/trade-catalog', async (req, res) => {
        try { res.json(await require('./helpers/tradeCatalog').rename(req.body.from, req.body.to)); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });
    app.delete('/api/trade-catalog', async (req, res) => {
        try { res.json(await require('./helpers/tradeCatalog').remove(req.body.description)); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.get('/api/item-types', (req, res) => {
        try { res.json(require('./helpers/itemTypes').loadCustomItemTypes()); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.post('/api/item-types', async (req, res) => {
        try { res.json(await require('./helpers/itemTypes').addCustomItemType(req.body.description)); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });
    // Rename an entry (2026-08-20). Body-based like DELETE below, for the
    // same reason. Renames the catalog entry ONLY — loads already saved with
    // the old text keep it, see helpers/itemTypes.js's renameItemType for
    // why that's intentional rather than a missing migration.
    app.put('/api/item-types', async (req, res) => {
        try { res.json(await require('./helpers/itemTypes').renameItemType(req.body.from, req.body.to)); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });
    // Delete a description (Apsara 2026-08-16, widened to the full list
    // 2026-08-20). Body, not a :param, since descriptions are free text and
    // can contain slashes. Removing one stops it being OFFERED on the next
    // load; it never touches a load that already used it.
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
    // Active facts by default — what Jarvis currently believes, which is what
    // the Facts tab is for. ?include=all adds superseded/retracted records so
    // the history panel can show how a belief changed over time.
    app.get('/api/facts', requireAdmin, (req, res) => {
        const all = String(req.query.include || '') === 'all';
        res.json({ facts: all ? loadFacts() : loadActiveFacts(), include: all ? 'all' : 'active' });
    });

    // The lineage of one fact, newest first — "why does Jarvis think this?"
    app.get('/api/facts/:id/history', requireAdmin, (req, res) => {
        const chain = factHistory(String(req.params.id || ''));
        if (!chain.length) return res.status(404).json({ error: 'not found' });
        res.json({ history: chain });
    });

    app.post('/api/facts', requireAdmin, async (req, res) => {
        const text = String(req.body?.text || '').trim();
        if (!text) return res.status(400).json({ error: 'text required' });
        // origin: manager — behind requireAdmin, i.e. an authenticated
        // dashboard session or the machine API token. Channel, not content.
        const saved = await addFact(text, !!req.body?.pinned, { origin: 'manager' });
        // A 200 for a fact that never reached disk is the same lie as
        // "Got it — I'll remember" on WhatsApp: she stops repeating it.
        if (!saved) return res.status(503).json({ error: 'could not save — the memory store is not writable right now', reason: 'write_failed' });
        res.json({ ok: true, id: saved.id });
    });

    // Pin/unpin an existing fact — see helpers/json.js's addFact header for
    // why this exists: unpinned facts fall out of every AI prompt once 15
    // newer facts exist, even though they're still stored. Pinning exempts
    // a fact from that window so a standing rule Apsara wants reinforced
    // (e.g. a routing/CC rule) is guaranteed to always be read, not just
    // usually read.
    // ── ID-ADDRESSED, not index-addressed (2026-08-25) ─────────────────────
    // These took an array INDEX until now, which is unsafe: addFact's 200-cap
    // eviction splices a fact out of the middle and shifts every index below
    // it, so a delete issued against a rendered list could remove a different
    // fact than the one clicked. See helpers/json.js's deriveFactId header.
    //
    // Legacy ids are derived deterministically from a fact's own text +
    // created_at, so a dashboard page rendered BEFORE this change still sends
    // an id that resolves correctly — no coordinated deploy required. A stale
    // cached page sending a bare integer is answered with an explicit 409
    // telling it to refresh, rather than silently acting on the wrong record.
    const rejectLegacyIndex = (raw, res) => {
        if (/^\d+$/.test(String(raw))) {
            res.status(409).json({ error: 'This page is out of date — refresh and try again. Facts are now addressed by id, not position.' });
            return true;
        }
        return false;
    };

    app.patch('/api/facts/:id', requireAdmin, async (req, res) => {
        const id = String(req.params.id || '');
        if (rejectLegacyIndex(id, res)) return;
        if (!id) return res.status(400).json({ error: 'invalid id' });
        const ok = await setFactPinned(id, !!req.body?.pinned);
        if (!ok) return res.status(404).json({ error: 'not found' });
        res.json({ ok: true });
    });

    app.delete('/api/facts/:id', requireAdmin, async (req, res) => {
        const id = String(req.params.id || '');
        if (rejectLegacyIndex(id, res)) return;
        if (!id) return res.status(400).json({ error: 'invalid id' });
        // RETRACT, not destroy (2026-08-25, phase 2). "Delete" in the Facts
        // tab now means "stop believing this": the fact leaves every prompt
        // immediately and its vector row is dropped, but the record stays on
        // disk so it is auditable and — unlike before — recoverable from a
        // mis-click. Nothing Apsara taught Jarvis is ever actually destroyed.
        // ?purge=true still hard-deletes, for genuine junk that should leave
        // no trace; that path is not reachable from the dashboard.
        const purge = String(req.query.purge || '') === 'true';
        const outcome = purge
            ? await deleteFactById(id)
            : await retractFact(id, String(req.body?.reason || '') || 'deleted from dashboard');
        // deleteFactById still returns a bare record/null; retractFact returns
        // a structured result. Normalise both here rather than making the
        // dashboard care which path it took.
        const removed = purge ? outcome : (outcome.ok ? outcome.fact : null);
        if (!removed) {
            const reason = purge ? 'not_found' : outcome.reason;
            if (reason === 'write_failed') {
                return res.status(503).json({ error: 'could not save — the memory store is not writable right now', reason: 'write_failed' });
            }
            // "Already gone" is not an error worth alarming her about — the
            // end state she asked for is the end state she has.
            if (reason === 'already_retracted') return res.json({ ok: true, id, alreadyRetracted: true });
            return res.status(404).json({ error: 'not found', reason });
        }
        // Keep the graph node (if Neo4j is configured) in sync with a
        // dashboard delete. helpers/graph.js DOES NOT EXIST in this repo and
        // never has — verified on disk and on GitHub, 2026-08-25. A bare
        // require() therefore threw synchronously, BEFORE .catch could
        // attach, so this handler rejected and returned a 500 on a delete
        // that had already succeeded. Wrapped so an optional integration
        // that was never built cannot fail a core operation.
        try {
            const graph = require('./helpers/graph');
            if (graph && typeof graph.deleteFactNode === 'function') {
                graph.deleteFactNode(removed.text)
                    .catch((e) => console.error('[API] fact graph delete failed (non-fatal):', e.message));
            }
        } catch (e) {
            if (e.code !== 'MODULE_NOT_FOUND') console.error('[API] graph module load failed (non-fatal):', e.message);
        }
        res.json({ ok: true, id: removed.id, purged: purge });
    });

    // Is there actually a usable off-VM backup, and how stale is it?
    // A backup nobody checks is a backup nobody has — this is the only way to
    // find out replication has been failing before the day it is needed.
    app.get('/api/facts/replica', requireAdmin, async (req, res) => {
        try {
            res.json(await require('./helpers/factReplica').status());
        } catch (e) {
            res.status(500).json({ configured: true, ok: false, error: e.message });
        }
    });

    // ── Correct a fact, keeping the history (2026-08-25, phase 2) ──────────
    // The dashboard's "Correct" action. Distinct from editing the text in
    // place, which would erase the fact that Jarvis ever believed the old
    // version — the whole point is that the change is recorded, not hidden.
    app.post('/api/facts/:id/supersede', requireAdmin, async (req, res) => {
        const id = String(req.params.id || '');
        const text = String(req.body?.text || '').trim();
        if (!id) return res.status(400).json({ error: 'invalid id' });
        if (!text) return res.status(400).json({ error: 'replacement text required' });
        // followChain is opt-in from the client. A dashboard correction is
        // made against a rendered list that may be seconds stale; when the
        // fact has moved, the honest default is to REFUSE and show her what it
        // collided with, so she can decide whether her edit still applies —
        // rather than silently stacking it on a change she has not seen.
        const res2 = await supersedeFact(id, text, {
            pinned: typeof req.body?.pinned === 'boolean' ? req.body.pinned : null,
            reason: String(req.body?.reason || '') || 'corrected from dashboard',
            origin: 'manager',
            followChain: req.body?.followChain === true,
        });
        if (!res2.ok) {
            // A failed WRITE is not a conflict — 409 would tell the dashboard
            // "someone changed this", which is wrong and unactionable. 503
            // says what is true: the store is not writable, try again.
            if (res2.reason === 'write_failed') {
                return res.status(503).json({ error: 'could not save — the memory store is not writable right now', reason: 'write_failed' });
            }
            // 409 carries the REASON and the current head, so the client can
            // say "this changed to X — apply yours on top?" instead of the
            // old undifferentiated "not found, or already superseded".
            return res.status(409).json({
                error: 'could not supersede', reason: res2.reason,
                currentHead: res2.currentHead ? { id: res2.currentHead.id, text: res2.currentHead.text } : null,
            });
        }
        res.json({ ok: true, id: res2.fact.id, supersedes: id });
    });

    // Undo a retraction — the recoverability that makes soft-delete worth it.
    app.post('/api/facts/:id/unretract', requireAdmin, async (req, res) => {
        const out = await unretractFact(String(req.params.id || ''));
        if (!out.ok) {
            if (out.reason === 'write_failed') {
                return res.status(503).json({ error: 'could not save — the memory store is not writable right now', reason: 'write_failed' });
            }
            return res.status(409).json({
                error: out.reason === 'superseded'
                    ? 'that fact was replaced by a newer one — restoring it would leave two conflicting facts active'
                    : 'not found, or not retracted',
                reason: out.reason,
            });
        }
        res.json({ ok: true, id: out.fact.id });
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

    // Voice input for the dashboard's "Jarvis terminal" — per Apsara ("is it
    // possible to integrate [voice] into this website?"), a follow-up to the
    // WhatsApp voice-note feature (helpers/gemini.js's transcribeVoiceNote,
    // wired into index.js's WhatsApp message handler). Deliberately reuses
    // that SAME transcription function rather than a second implementation.
    //
    // Deliberately does NOT auto-fire through brain.process() the way the
    // WhatsApp path does — this only returns the transcribed text for the
    // browser to drop into the terminal's input box, same as if she'd typed
    // it. The terminal's own UI already warns "Commands fire for real —
    // same effect as messaging Jarvis on WhatsApp"; a WhatsApp voice note is
    // usually a deliberate, quiet recording, while a dashboard mic click is
    // more likely to pick up office background noise, so a review-before-
    // send step here is the safer default for something that fires REAL
    // trucker/supplier messages. If this turns out to be annoying in
    // practice, auto-send is a one-line change (call /api/bot/command's
    // logic with the transcript instead of just returning it).
    app.post('/api/bot/voice-command', async (req, res) => {
        const audioBase64 = req.body?.audio_base64;
        const mimeType = req.body?.mime_type || 'audio/webm';
        if (!audioBase64) return res.status(400).json({ error: 'audio_base64 required' });
        try {
            const { transcribeVoiceNote } = require('./helpers/gemini');
            const result = await transcribeVoiceNote(audioBase64, mimeType);
            const text = result?.english_text || result?.transcript || '';
            if (!text) return res.status(422).json({ error: "couldn't make out that recording — try again or type it" });
            res.json({ ok: true, text, language: result?.language || null });
        } catch (err) {
            console.error('[API] bot/voice-command failed:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // Address book — standalone page, not part of index.html's SPA tab
    // system (explicit request 2026-08-05). Registered before the static
    // mount below so the route is unambiguous; inherits the same session/
    // API_TOKEN gate as everything else (that middleware runs earlier, at
    // the top of this file) even though express.static would technically
    // have served dashboard/address-book.html anyway once mounted.
    // ── GET /api/health-report — the front door for evidence we keep ─────
    //
    // Apsara, 2026-10-12: "Why there is no provision for USers,incidents,
    // crash report?" For crash reports, the capture was already complete and
    // good (helpers/crashlog.js, written after the ten-and-a-half-hour
    // outage on 2026-09-01) and nothing read it. There was a POST
    // /api/client-errors so a phone could report, and no GET to read it
    // back; nothing served LOGS_DIR at all. So the only way to see a crash
    // was to ssh to the VM and cat a file.
    //
    // ── requireAdmin, AND WHY NOT LOWER ─────────────────────────────────
    // A stack trace names files, line numbers and sometimes fragments of
    // whatever was being processed when it threw. That is the same tier of
    // thing as the WhatsApp QR, which requireAdmin already gates, so it gets
    // the same gate. The 'staff' role is additionally refused by the
    // default-deny prefix list in api.js — /api/health-report is not in
    // STAFF_ALLOWED_PATH_PREFIXES and must never be added to it.
    //
    // ── READ-ONLY, AND IT TAKES NO FILENAME ─────────────────────────────
    // No query parameter reaches the filesystem. The window and the crash
    // count are NUMBERS, clamped here, and helpers/healthReport.js finds
    // crash files by glob and checks each resolved path is inside LOGS_DIR.
    // Accepting ?file= would be one line and a path-traversal hole into the
    // directory next to her stores and her Google credentials.
    app.get('/api/health-report', requireAdmin, (req, res) => {
        try {
            const n = (v, dflt, min, max) => {
                const x = Number(v);
                return Number.isFinite(x) ? Math.min(max, Math.max(min, Math.round(x))) : dflt;
            };
            res.json(require('../helpers/healthReport').report({
                windowHours: n(req.query.hours, 48, 1, 24 * 30),
                crashLimit: n(req.query.crashes, 20, 1, 100),
            }));
        } catch (err) {
            // A health endpoint that 500s tells you nothing about health.
            // Answer with the failure as DATA so the page can show it.
            console.error('[API] health-report failed:', err.message);
            res.json({ ok: false, at: new Date().toISOString(), error: String(err.message || err) });
        }
    });
// @@chunk-end

};
