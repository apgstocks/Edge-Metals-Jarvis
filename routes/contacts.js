// routes/contacts.js — split from api.js (helpers/sourceParts.js reconstructs the original)
const cfg = require('../config');
const { loadTruckers, loadSuppliers, upsertTrucker, deleteTrucker, upsertSupplier, deleteSupplier, updateWorkflow } = require('../helpers/json');

module.exports = function (app, ctx) {
    const { requireAdmin } = ctx;
// @@chunk-start
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
    // Edit — the factory above only does add/list/delete, so correcting a
    // typo'd address meant deleting the contact and retyping it (losing any
    // domain group, role and standing Cc with it). Apsara, 2026-08-22:
    // "EMAIL CONTACTS doesnt have edit option."
    //
    // PUT rather than reusing POST: POST is an upsert-by-NAME and therefore
    // cannot rename anything — it would just create a second record. See
    // helpers/emailContacts.js's updateContact for the preserve/rename rules.
    // 400, not 500: every failure it raises is a bad request (unknown
    // contact, name clash, malformed address), not a server fault.
    app.put('/api/email-contacts/:contactName', async (req, res) => {
        try {
            await emailContacts.updateContact(req.params.contactName, req.body || {});
            res.json({ ok: true });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    // ══ MOVE A WHOLE GROUP ══════════════════════════════════════════════════
    //
    // Apsara, 2026-09-20, looking at six unrelated suppliers filed under a
    // group called GMAIL.COM — one of them marked PRIMARY, so a bare company
    // mention resolved to a scrap dealer and the other five were auto-cc'd on
    // whatever went to any of them: "give an option to move it to diff
    // domain."
    //
    // The Edit panel already moves ONE contact (2026-09-20, her "if i want to
    // change the domain-??"). Six contacts is six rounds of open, clear, save,
    // and the sixth is the one that gets forgotten — which leaves the group
    // half-dismantled and still auto-ccing.
    //
    // An EMPTY domain ungroups them: each becomes a person on their own. That
    // is the answer for the case that produced the question, because
    // gmail.com is not a company and nobody there is anybody's colleague.
    //
    // ── IT GOES THROUGH updateContact, ONE AT A TIME ────────────────────────
    // Not a bulk rewrite of the file. updateContact already validates the
    // domain, refuses an invented role, drops an orphaned role when the group
    // goes, and demotes an incumbent primary. A faster loop that wrote the
    // store directly would be a second copy of all four rules.
    app.post('/api/email-contacts/regroup', requireAdmin, async (req, res) => {
        try {
            const ec = require('./helpers/emailContacts');
            const body = req.body || {};
            const names = Array.isArray(body.names) ? body.names : [];
            if (!names.length) return res.status(400).json({ error: 'no contacts named' });

            // Empty string is a REAL value here — it means "no group" — so it
            // must be distinguishable from the field being absent.
            const domain = body.domain === undefined || body.domain === null
                ? null : String(body.domain).trim();
            if (domain === null) return res.status(400).json({ error: 'domain is required (empty string to ungroup)' });

            const moved = [], skipped = [];
            for (const name of names) {
                try {
                    // role is deliberately NOT carried across. A "primary" of
                    // gmail.com means nothing once it is a member of a real
                    // company, and guessing which of six should lead it is
                    // the sort of guess proposeDomainRoles refuses to make.
                    await ec.updateContact(String(name), { domain, role: '' });
                    moved.push(String(name));
                } catch (e) {
                    skipped.push({ name: String(name), why: e.message });
                }
            }
            res.json({ ok: true, moved, skipped, domain: domain || null });
        } catch (e) {
            console.error('[email-contacts] regroup failed:', e && e.stack);
            res.status(500).json({ error: e.message });
        }
    });

    // ══ HARVEST: EVERYONE SHE ACTUALLY EMAILS ═══════════════════════════════
    //
    // Apsara, 2026-09-19: "is there any option to learn email contacts..?" ->
    // "How to learn all the email contacts?" -> "from email to email contacts
    // tab" -> "save it".
    //
    // There was an option and it was not this one. "learn radmetals contacts"
    // learns ONE company, named by her, through WhatsApp. This is the whole
    // mailbox, into the tab she was looking at when she asked.
    //
    // TWO ROUTES, BECAUSE SCANNING AND SAVING ARE TWO DECISIONS. The scan
    // writes nothing; she picks; the save writes only what she ticked. That
    // is the posture every detect-then-confirm action in this app takes, and
    // it matters more here than anywhere: a sweep of a real mailbox surfaces
    // freight forwarders, a bank, somebody's personal address and a
    // conference list, and resolveContact reads this tab to decide where an
    // invoice goes.
    app.get('/api/email-contacts/harvest', requireAdmin, async (req, res) => {
        try {
            const harvest = require('./helpers/contactHarvest');
            const gmailLib = require('./helpers/gmail');
            let gmail;
            try { gmail = gmailLib.getGmailRead(); }
            catch (e) {
                return res.status(503).json({ error: `Can't scan mail — Gmail isn't configured (${e.message}).`,
                                              code: 'GMAIL_UNAVAILABLE' });
            }

            // Every mailbox Jarvis reads, by its RESOLVED address — never an
            // assumed one. getGmailReadMailboxes exists because that
            // assumption was wrong for weeks: three tokens all resolved to
            // apsara@ while the comments said otherwise. Her own domain must
            // not propose itself as a customer.
            let mine = [];
            try {
                mine = (await gmailLib.getGmailReadMailboxes() || [])
                    .map((m) => m.address).filter(Boolean);
            } catch (e) { console.warn('[HARVEST] could not resolve own mailboxes:', e.message); }

            const limit = Math.min(Math.max(Number(req.query.limit) || 200, 20), 500);
            const { scanned, tally, requested } = await harvest.scan(gmail, { limit, mine });
            const known = require('./helpers/emailContacts').loadContacts();
            const { domains, skipped } = harvest.propose(tally, { mine, known });

            res.json({ ok: true, scanned, requested, limit, mine, domains, skipped,
                       known_count: known.length });
        } catch (e) {
            console.error('[HARVEST] scan failed:', e && e.stack);
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/email-contacts/harvest', requireAdmin, async (req, res) => {
        try {
            const emailContactsLib = require('./helpers/emailContacts');
            const wanted = Array.isArray((req.body || {}).save) ? req.body.save : [];
            if (!wanted.length) return res.status(400).json({ error: 'nothing selected' });

            // ── NEVER OVERWRITE WHAT IS ALREADY THERE ────────────────────
            // addContact is an upsert by NAME, so a harvest row called
            // "export" would silently replace a contact she typed herself.
            // A bulk save is exactly where that goes unnoticed, so existing
            // names are reported as skipped rather than written over. Editing
            // a contact is the Edit button's job, deliberately.
            const before = emailContactsLib.loadContacts();
            const haveName = new Set(before.map((c) => String(c.name || '').toLowerCase()));
            const haveAddr = new Set(before.map((c) => String(c.email || '').toLowerCase()));

            const saved = [], skipped = [];
            for (const row of wanted) {
                const name = String((row && row.name) || '').trim();
                const email = String((row && row.email) || '').trim().toLowerCase();
                if (!name || !email) { skipped.push({ email, why: 'needs a name' }); continue; }
                if (haveAddr.has(email)) { skipped.push({ email, why: 'address already saved' }); continue; }
                if (haveName.has(name.toLowerCase())) { skipped.push({ email, why: `"${name}" is already a contact` }); continue; }
                try {
                    await emailContactsLib.addContact(name, email, {
                        domain: row.domain || undefined,
                        role: row.role || undefined,
                        displayName: row.displayName || undefined,
                    });
                    saved.push({ name, email });
                    haveName.add(name.toLowerCase()); haveAddr.add(email);
                } catch (e) {
                    // One bad row must not lose the other forty. addContact
                    // also REFUSES a bare name that would shadow a domain
                    // group — that refusal is a feature and is reported.
                    skipped.push({ email, why: e.message });
                }
            }
            res.json({ ok: true, saved, skipped, total: emailContactsLib.loadContacts().length });
        } catch (e) {
            console.error('[HARVEST] save failed:', e && e.stack);
            res.status(500).json({ error: e.message });
        }
    });

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
// @@chunk-end

    return { pricelist };
};
